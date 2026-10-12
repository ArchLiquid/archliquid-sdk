import assert from "node:assert/strict";
import test from "node:test";
import { type ReadonlyUint8Array, type Slot } from "@solana/kit";

import { ZERO_ADDRESS } from "../src/addresses.js";
import { OwnedSdkError } from "../src/errors.js";
import { assertOwnedInstructionMatchesIntent } from "../src/owned-program-instructions.js";
import { OwnedQuoteMathError } from "../src/owned-quote-math.js";
import { deriveAssociatedTokenAddress, deriveBaseMintAddress, deriveCurveAddress, deriveMetadataAddress } from "../src/owned-program-pdas.js";
import { loadCurveSnapshot, loadLaunchSnapshot, loadPoolSnapshot, type OwnedCurveSnapshot } from "../src/owned-snapshots.js";
import {
  assertOwnedTransactionPlanSignable, createOwnedCurvePlan, createOwnedMarketTradePlan,
  createOwnedPoolLiquidityPlan,
  type OwnedMarketTradeRequest, type OwnedTransactionPlanOptions,
} from "../src/owned-transaction-plans.js";
import { CREATOR } from "./helpers/fixtures.js";
import { createSnapshotReader } from "./helpers/snapshot-reader.js";

const MAX_U64 = (1n << 64n) - 1n;
const requests: readonly OwnedMarketTradeRequest[] = [
  { side: "buy", inputMode: "exact-base", baseAmountOut: 1_000n, maxQuoteAmountIn: 2_000n },
  { side: "buy", inputMode: "exact-quote", quoteAmountIn: 1_000n, minBaseAmountOut: 1n },
  { side: "sell", inputMode: "exact-base", baseAmountIn: 1_000n, minQuoteAmountOut: 1n },
];

function isError(code: OwnedSdkError["code"]) {
  return (error: unknown) => error instanceof OwnedSdkError && error.code === code;
}

test("trade plans retain requested limits and canonical accounts for both venues and quote mints", async () => {
  for (const quoteKind of ["sol", "usdc"] as const) {
    const setup = await createSnapshotReader(quoteKind);
    const snapshots = await Promise.all([
      loadCurveSnapshot(setup.reader, setup.baseMint),
      loadPoolSnapshot(setup.reader, setup.baseMint, setup.quoteMint),
    ]);
    for (const snapshot of snapshots) {
      for (const request of requests) {
        const readCount = setup.calls.length;
        const plan = await createOwnedMarketTradePlan(snapshot, CREATOR, request, { validitySlots: 10n, validityMs: 1_000 });
        assert.equal(setup.calls.length, readCount, "plan construction never sends or reads transactions");
        assert.equal(plan.kind, "trade");
        assert.equal(plan.quote.venue, snapshot.venue);
        assert.equal(plan.context.sourceSlot, snapshot.slot);
        assert.equal(plan.context.observedAtUnixMs, snapshot.observedAtUnixMs);
        assert.equal(plan.context.expiresAtSlot, snapshot.slot + 10n);
        assert.equal(plan.context.expiresAtUnixMs, snapshot.observedAtUnixMs + 1_000);
        assert.equal(plan.context.commitment, snapshot.commitment);
        assert.equal(plan.context.deployment, snapshot.deployment);
        const decoded = assertOwnedTransactionPlanSignable(plan, snapshot.slot, snapshot.observedAtUnixMs);
        assert.equal(decoded.program, snapshot.venue === "curve" ? "archCurve" : "archSwap");
        if (request.side === "buy" && request.inputMode === "exact-base") {
          assert.equal(decoded.instruction, "buy_exact_base_out");
          assert.deepEqual(decoded.args, { base_amount_out: request.baseAmountOut, max_quote_amount_in: request.maxQuoteAmountIn });
          assert.ok("grossQuoteAmountIn" in plan.quote.result && plan.quote.result.grossQuoteAmountIn < request.maxQuoteAmountIn);
        } else if (request.side === "buy") {
          assert.equal(decoded.instruction, "buy_exact_quote_in");
          assert.deepEqual(decoded.args, { quote_amount_in: request.quoteAmountIn, min_base_amount_out: request.minBaseAmountOut });
        } else {
          assert.equal(decoded.instruction, "sell_exact_base_in");
          assert.deepEqual(decoded.args, { base_amount_in: request.baseAmountIn, min_quote_amount_out: request.minQuoteAmountOut });
        }
        const [base, quote] = await Promise.all([
          deriveAssociatedTokenAddress(CREATOR, setup.baseMint), deriveAssociatedTokenAddress(CREATOR, setup.quoteMint),
        ]);
        assert.deepEqual(plan.requiredTokenAccounts, [
          { kind: "base", address: base.address, owner: CREATOR, mint: setup.baseMint },
          { kind: "quote", address: quote.address, owner: CREATOR, mint: setup.quoteMint },
        ]);
        assert.equal(decoded.accounts.trader_base_account, base.address);
        assert.equal(decoded.accounts.trader_quote_account, quote.address);
        assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.context) && Object.isFrozen(plan.quote.result));
      }
    }
  }
});

test("LP plans preserve original deposit maxima and withdrawal minima", async () => {
  const setup = await createSnapshotReader();
  const snapshot = await loadPoolSnapshot(setup.reader, setup.baseMint, setup.quoteMint);
  const deposit = await createOwnedPoolLiquidityPlan(snapshot, CREATOR, {
    action: "deposit", lpSharesOut: 100n, maxBaseAmountIn: 500n, maxQuoteAmountIn: 500n,
  });
  assert.deepEqual(assertOwnedTransactionPlanSignable(deposit, snapshot.slot, snapshot.observedAtUnixMs).args, {
    lp_shares_out: 100n, max_base_amount_in: 500n, max_quote_amount_in: 500n,
  });
  assert.ok("baseAmountIn" in deposit.quote.result && deposit.quote.result.baseAmountIn < 500n);
  const withdraw = await createOwnedPoolLiquidityPlan(snapshot, CREATOR, {
    action: "withdraw", lpSharesIn: 100n, minBaseAmountOut: 100n, minQuoteAmountOut: 10n,
  });
  assert.deepEqual(assertOwnedTransactionPlanSignable(withdraw, snapshot.slot, snapshot.observedAtUnixMs).args, {
    lp_shares_in: 100n, min_base_amount_out: 100n, min_quote_amount_out: 10n,
  });
  assert.equal(withdraw.requiredTokenAccounts[2]?.address, (await deriveAssociatedTokenAddress(CREATOR, setup.lpMint)).address);
  await assert.rejects(() => createOwnedPoolLiquidityPlan(snapshot, CREATOR, {
    action: "withdraw", lpSharesIn: 90_001n, minBaseAmountOut: 0n, minQuoteAmountOut: 0n,
  }), (error) => error instanceof OwnedQuoteMathError && error.code === "locked_share_violation");
});

test("signing validation rejects mutated spend caps and forged or copied plans", async () => {
  const setup = await createSnapshotReader();
  const snapshot = await loadPoolSnapshot(setup.reader, setup.baseMint, setup.quoteMint);
  const plan = await createOwnedPoolLiquidityPlan(snapshot, CREATOR, {
    action: "deposit", lpSharesOut: 100n, maxBaseAmountIn: 500n, maxQuoteAmountIn: 500n,
  });
  assert.throws(() => assertOwnedTransactionPlanSignable({ ...plan }, snapshot.slot, snapshot.observedAtUnixMs), isError("invalid_input"));
  assert.equal(Reflect.set(plan.intent.args!, "max_base_amount_in", MAX_U64), false);
  assert.equal(Reflect.set(plan.instruction.accounts![0]!, "address", CREATOR), false);
  const data = plan.instruction.data as Uint8Array;
  new DataView(data.buffer, data.byteOffset, data.byteLength).setBigUint64(16, MAX_U64, true);
  assert.throws(() => assertOwnedTransactionPlanSignable(plan, snapshot.slot, snapshot.observedAtUnixMs), isError("quote_mismatch"));
  await assert.rejects(() => createOwnedMarketTradePlan({ ...snapshot }, CREATOR, requests[0]!), isError("invalid_snapshot"));
});

test("mutating caller requests during async derivation does not change approved limits", async () => {
  const setup = await createSnapshotReader();
  const snapshot = await loadPoolSnapshot(setup.reader, setup.baseMint, setup.quoteMint);
  const tradeRequest = { side: "buy" as const, inputMode: "exact-base" as const,
    baseAmountOut: 1_000n, maxQuoteAmountIn: 2_000n };
  const tradePending = createOwnedMarketTradePlan(snapshot, CREATOR, tradeRequest);
  tradeRequest.baseAmountOut = 9_000n;
  tradeRequest.maxQuoteAmountIn = MAX_U64;
  const trade = await tradePending;
  assert.deepEqual(assertOwnedTransactionPlanSignable(trade, snapshot.slot, snapshot.observedAtUnixMs).args,
    { base_amount_out: 1_000n, max_quote_amount_in: 2_000n });
  const lpRequest = { action: "deposit" as const, lpSharesOut: 100n,
    maxBaseAmountIn: 500n, maxQuoteAmountIn: 500n };
  const lpPending = createOwnedPoolLiquidityPlan(snapshot, CREATOR, lpRequest);
  lpRequest.lpSharesOut = 9_000n;
  lpRequest.maxBaseAmountIn = MAX_U64;
  const lp = await lpPending;
  assert.deepEqual(assertOwnedTransactionPlanSignable(lp, snapshot.slot, snapshot.observedAtUnixMs).args,
    { lp_shares_out: 100n, max_base_amount_in: 500n, max_quote_amount_in: 500n });
});

test("plans expire against their original snapshot and cannot renew stale observations", async (t) => {
  let now = 10_000;
  t.mock.method(Date, "now", () => now);
  const setup = await createSnapshotReader();
  const snapshot = await loadPoolSnapshot(setup.reader, setup.baseMint, setup.quoteMint);
  now = 500_000;
  const plan = await createOwnedMarketTradePlan(snapshot, CREATOR, requests[0]!, {
    observedAtUnixMs: now,
  } as unknown as OwnedTransactionPlanOptions);
  assert.equal(plan.context.observedAtUnixMs, 10_000);
  assert.equal(plan.context.expiresAtUnixMs, 70_000);
  assert.throws(() => assertOwnedTransactionPlanSignable(plan, snapshot.slot), isError("stale_context"));
  assert.throws(() => assertOwnedTransactionPlanSignable(plan, plan.context.expiresAtSlot, 10_000), isError("stale_context"));
  assert.throws(() => assertOwnedTransactionPlanSignable(plan, snapshot.slot, plan.context.expiresAtUnixMs), isError("stale_context"));
  assert.throws(() => assertOwnedTransactionPlanSignable(plan, (snapshot.slot - 1n) as Slot, 10_000), isError("stale_context"));
  assert.throws(() => assertOwnedTransactionPlanSignable(plan, snapshot.slot, 9_999), isError("stale_context"));
  assert.throws(() => assertOwnedTransactionPlanSignable(plan, snapshot.slot, NaN), isError("invalid_input"));
  assert.throws(() => assertOwnedTransactionPlanSignable(plan, -1n as Slot, 10_000), isError("invalid_input"));
});

test("Curve creation plans bind original metadata and derive all canonical creation addresses", async () => {
  const setup = await createSnapshotReader("usdc");
  const snapshot = await loadLaunchSnapshot(setup.reader, setup.quoteMint);
  const metadata = { name: "ArchLiquid", symbol: "ARCH", uri: "https://example.com/token.json" };
  const commitment = new Uint8Array(32).fill(1);
  const request = { launchNonce: 92n, metadata, metadataCommitment: commitment };
  const pending = createOwnedCurvePlan(snapshot, CREATOR, request);
  metadata.name = "Changed";
  commitment.fill(9);
  request.launchNonce = 93n;
  const plan = await pending;
  const decoded = assertOwnedTransactionPlanSignable(plan, snapshot.slot, snapshot.observedAtUnixMs);
  assert.deepEqual(decoded.args.metadata, { name: "ArchLiquid", symbol: "ARCH", uri: "https://example.com/token.json" });
  assert.deepEqual(decoded.args.metadata_commitment, new Uint8Array(32).fill(1));
  assert.equal(decoded.args.launch_nonce, 92n);
  const baseMint = (await deriveBaseMintAddress(CREATOR, 92n)).address;
  const curve = (await deriveCurveAddress(baseMint)).address;
  assert.deepEqual(plan.createdAddresses, {
    baseMint, curve, baseVault: (await deriveAssociatedTokenAddress(curve, baseMint)).address,
    quoteVault: (await deriveAssociatedTokenAddress(curve, setup.quoteMint)).address,
    metadata: (await deriveMetadataAddress(baseMint)).address,
  });
  assert.equal(plan.quote, null);
  assert.deepEqual(plan.requiredTokenAccounts, []);
  assert.equal(decoded.accounts.launch_config, snapshot.launchConfig.address);
  assert.equal(decoded.accounts.protocol_config, snapshot.protocol.address);
  assert.throws(() => assertOwnedTransactionPlanSignable(plan, plan.context.expiresAtSlot, snapshot.observedAtUnixMs), isError("stale_context"));
});

test("changing exposed commitment bytes cannot redefine a private approved intent", async () => {
  const setup = await createSnapshotReader();
  const snapshot = await loadLaunchSnapshot(setup.reader, setup.quoteMint);
  const plan = await createOwnedCurvePlan(snapshot, CREATOR, {
    launchNonce: 92n, metadata: { name: "Arch", symbol: "ARCH", uri: "https://example.com/token.json" },
    metadataCommitment: new Uint8Array(32).fill(1),
  });
  const expectedIntent = {
    ...plan.intent,
    args: { ...plan.intent.args!, metadata_commitment: new Uint8Array(32).fill(1) },
  };
  const visibleCommitment = plan.intent.args!.metadata_commitment;
  assert.ok(visibleCommitment instanceof Uint8Array);
  visibleCommitment.fill(2);
  assert.doesNotThrow(() => assertOwnedInstructionMatchesIntent(plan.instruction, expectedIntent));
  assert.throws(() => assertOwnedTransactionPlanSignable(plan, snapshot.slot, snapshot.observedAtUnixMs), isError("quote_mismatch"));
  const instructionData = plan.instruction.data as Uint8Array;
  instructionData.set(visibleCommitment, instructionData.length - 32);
  assert.throws(() => assertOwnedTransactionPlanSignable(plan, snapshot.slot, snapshot.observedAtUnixMs), isError("quote_mismatch"));
});

test("plan factories reject invalid requests, identities, provenance and timing", async () => {
  const setup = await createSnapshotReader();
  const launch = await loadLaunchSnapshot(setup.reader, setup.quoteMint);
  const pool = await loadPoolSnapshot(setup.reader, setup.baseMint, setup.quoteMint);
  await assert.rejects(() => createOwnedMarketTradePlan(launch as unknown as OwnedCurveSnapshot, CREATOR, requests[0]!), isError("invalid_snapshot"));
  await assert.rejects(() => createOwnedMarketTradePlan(pool, CREATOR, { side: "sell", inputMode: "exact-quote" } as unknown as OwnedMarketTradeRequest), isError("invalid_input"));
  await assert.rejects(() => createOwnedMarketTradePlan(pool, ZERO_ADDRESS, requests[0]!), /default address/);
  await assert.rejects(() => createOwnedMarketTradePlan(pool, CREATOR, requests[0]!, { validitySlots: 0n }), /slot validity/);
  const valid = { launchNonce: 92n, metadata: { name: "Arch", symbol: "ARCH", uri: "https://example.com/token.json" }, metadataCommitment: new Uint8Array(32).fill(1) };
  await assert.rejects(() => createOwnedCurvePlan({ ...launch }, CREATOR, valid), isError("invalid_snapshot"));
  await assert.rejects(() => createOwnedCurvePlan(launch, ZERO_ADDRESS, valid), isError("invalid_input"));
  await assert.rejects(() => createOwnedCurvePlan(launch, CREATOR, { ...valid, launchNonce: -1n }), isError("invalid_input"));
  await assert.rejects(() => createOwnedCurvePlan(launch, CREATOR, { ...valid, metadataCommitment: new Uint8Array(32) }), isError("invalid_input"));
  await assert.rejects(() => createOwnedCurvePlan(launch, CREATOR, { ...valid, metadataCommitment: "hash" as unknown as ReadonlyUint8Array }), isError("invalid_input"));
  await assert.rejects(() => createOwnedCurvePlan(launch, CREATOR, valid, { validityMs: NaN }), isError("invalid_input"));
});

// Compile-time checks run through npm run typecheck and are never executed.
function planTypeAssertions(snapshot: Parameters<typeof createOwnedMarketTradePlan>[0]) {
  // @ts-expect-error exact-base buys require an explicit quote spend maximum.
  void createOwnedMarketTradePlan(snapshot, CREATOR, { side: "buy", inputMode: "exact-base", baseAmountOut: 1n });
  // @ts-expect-error exact-quote sells are not supported.
  void createOwnedMarketTradePlan(snapshot, CREATOR, { side: "sell", inputMode: "exact-quote", quoteAmountIn: 1n, minBaseAmountOut: 0n });
  // @ts-expect-error callers cannot replace the snapshot observation timestamp.
  void createOwnedMarketTradePlan(snapshot, CREATOR, requests[0]!, { observedAtUnixMs: Date.now() });
}
void planTypeAssertions;

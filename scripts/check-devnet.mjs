/** Opt-in live devnet verification. Every transaction is unsigned and simulation-only.
 * No key access, signing, sending, airdrops, or persistent account/balance changes.
 * Run: node --import tsx scripts/check-devnet.mjs [--report unique-file.json]
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
// This is Kit 7's locked JSON-RPC codec, also used by its default transport.
// The harness is repository tooling, rather than a published runtime export.
import { parseJsonWithBigInts, stringifyJsonWithBigInts } from "@solana/rpc-spec-types";
import {
  AccountRole, appendTransactionMessageInstructions, compileTransaction,
  createSolanaRpcFromTransport, createTransactionMessage, getAddressDecoder,
  getBase58Decoder, getBase64EncodedWireTransaction, pipe,
  setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import {
  ARCHLIQUID_DEVNET_DEPLOYMENT, ARCH_CURVE_PROGRAM_ADDRESS, ARCH_SWAP_PROGRAM_ADDRESS,
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS, SOL_QUOTE_MINT_ADDRESS, USDC_QUOTE_MINT_ADDRESS,
  SPL_TOKEN_PROGRAM_ADDRESS, SYSTEM_PROGRAM_ADDRESS, OWNED_ACCOUNT_LAYOUTS,
  assertOwnedDeploymentGenesisHash, assertOwnedInstructionMatchesIntent,
  assertOwnedTransactionPlanSignable, buildTypedOwnedInstruction,
  calculateInitialLiquidityShares, createCurveSellExactBaseInQuote,
  createPoolWithdrawLiquidityQuote,
  createOwnedAccountReader, createOwnedMarketTradePlan, createOwnedPoolLiquidityPlan,
  decodeCurveAccount, decodeLegacyMint, decodeLegacyTokenAccount, decodeOwnedTransactionEvents,
  decodePoolAccount, decodeProtocolConfigAccount, decodeSwapConfigAccount, deriveAssociatedTokenAddress,
  deriveProtocolConfigAddress, deriveSwapConfigAddress,
  loadCurveSnapshot, loadLaunchSnapshot, loadPoolSnapshot,
} from "../src/index.ts";

const allowedMethods = new Set([
  "getGenesisHash", "getMultipleAccounts", "getProgramAccounts", "getLatestBlockhash",
  "getSlot", "simulateTransaction", "getSignaturesForAddress", "getTransaction",
]);
const options = process.argv.slice(2);
assert.ok(options.length === 0 || (options.length === 2 && options[0] === "--report"), "Use --report unique-file.json, or no arguments");
const endpoint = new URL(process.env.ARCHLIQUID_DEVNET_RPC_URL ?? "https://api.devnet.solana.com");
assert.ok(endpoint.protocol === "https:" || (endpoint.protocol === "http:" && ["localhost", "127.0.0.1"].includes(endpoint.hostname)), "RPC must use HTTPS, or local HTTP");
const report = {
  version: 1, startedAt: new Date().toISOString(), rpcOrigin: `${endpoint.protocol}//${endpoint.host}`,
  caveat: "Unsigned simulation uses public account identities with sigVerify:false. It proves neither wallet approval nor governed Rust/bytecode identity; simulated changes and events are not committed.",
  checks: [],
};
let requestCount = 0;
let nextRequestAt = 0;
const deadline = Date.now() + 180_000;
const hash = (data) => createHash("sha256").update(data).digest("hex");
const serialize = (_key, value) => typeof value === "bigint" ? value.toString() : value;
function check(name, status, evidence = {}) {
  report.checks.push({ name, status, ...evidence });
  console.log(`${status.toUpperCase()} ${name}${evidence.reason ? `: ${evidence.reason}` : ""}`);
}
// A small transport keeps the real SDK Kit adapter in the live verification path.
// No redirects are followed, and errors never echo a credential-bearing URL.
const transport = async ({ payload, signal }) => {
  assert.ok(allowedMethods.has(payload.method), "RPC method is outside the read/simulation allowlist");
  assert.ok(Date.now() < deadline, "Live verification time budget exhausted");
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  signal?.addEventListener("abort", forwardAbort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(() => controller.abort(), Math.min(15_000, deadline - Date.now()));
  try {
    const pause = async (milliseconds) => {
      if (milliseconds > 0) await new Promise((resolve, reject) => {
        const onAbort = () => { clearTimeout(wait); reject(new Error("Aborted")); };
        const wait = setTimeout(() => { controller.signal.removeEventListener("abort", onAbort); resolve(); }, milliseconds);
        controller.signal.addEventListener("abort", onAbort, { once: true });
        if (controller.signal.aborted) onAbort();
      });
    };
    let response;
    for (let attempt = 0; attempt < 3; attempt++) {
      await pause(nextRequestAt - Date.now());
      assert.ok(++requestCount <= 128 && Date.now() < deadline, "Live verification request/time budget exhausted");
      nextRequestAt = Date.now() + 350;
      response = await fetch(endpoint, {
        method: "POST", headers: { "content-type": "application/json" }, redirect: "error",
        body: stringifyJsonWithBigInts(payload), signal: controller.signal,
      });
      if (response.status !== 429 || attempt === 2) break;
      await response.body?.cancel();
      await pause(2_000 * (attempt + 1));
    }
    assert.ok(response.ok, `RPC HTTP status ${response.status}`);
    const cap = payload.method === "getProgramAccounts" ? 262_144 : 4_194_304;
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      assert.ok(length <= cap, "RPC response exceeds the verification byte cap");
      chunks.push(chunk);
    }
    const parsed = parseJsonWithBigInts(Buffer.concat(chunks).toString("utf8"));
    if (parsed.error) {
      parsed.error = { code: parsed.error.code, message: `RPC ${payload.method} returned a JSON-RPC error` };
    }
    return parsed;
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error;
    throw new Error(`RPC ${payload.method} request failed or timed out`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", forwardAbort);
  }
};
const rpc = createSolanaRpcFromTransport(transport);
const reader = createOwnedAccountReader(rpc);
const addressDecoder = getAddressDecoder();
const shaAccount = (account) => account === null ? null : hash(Buffer.concat([
  Buffer.from(account.owner), Buffer.from(String(account.lamports)), Buffer.from(account.data),
]));
const observed = (account, address) => ({
  address, owner: account.owner, lamports: account.lamports, executable: account.executable,
  data: new Uint8Array(Buffer.from(account.data[0], "base64")),
});
const readAccounts = (addresses, minContextSlot) => reader.getAccounts(addresses, {
  commitment: "confirmed", ...(minContextSlot === undefined ? {} : { minContextSlot }),
  abortSignal: AbortSignal.timeout(15_000),
});

function littleEndian(opcode, amount) {
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, opcode, true);
  view.setBigUint64(4, amount, true);
  return data;
}
const meta = (address, role = AccountRole.READONLY) => ({ address, role });
async function preparation(snapshot, owner, funding) {
  const quoteAccount = (await deriveAssociatedTokenAddress(owner, snapshot.quoteMint.address)).address;
  const baseAccount = (await deriveAssociatedTokenAddress(owner, snapshot.baseMint.address)).address;
  const instructions = [baseAccount, quoteAccount].map((tokenAccount, index) => ({
    programAddress: ASSOCIATED_TOKEN_PROGRAM_ADDRESS, data: new Uint8Array([1]),
    accounts: [meta(owner, AccountRole.WRITABLE_SIGNER), meta(tokenAccount, AccountRole.WRITABLE),
      meta(owner), meta(index === 0 ? snapshot.baseMint.address : snapshot.quoteMint.address),
      meta(SYSTEM_PROGRAM_ADDRESS), meta(SPL_TOKEN_PROGRAM_ADDRESS)],
  }));
  assert.equal(snapshot.quoteMint.address, SOL_QUOTE_MINT_ADDRESS, "This harness cannot fund USDC without existing public token funds");
  instructions.push({ programAddress: SYSTEM_PROGRAM_ADDRESS, data: littleEndian(2, funding),
    accounts: [meta(owner, AccountRole.WRITABLE_SIGNER), meta(quoteAccount, AccountRole.WRITABLE)] });
  instructions.push({ programAddress: SPL_TOKEN_PROGRAM_ADDRESS, data: new Uint8Array([17]),
    accounts: [meta(quoteAccount, AccountRole.WRITABLE)] });
  return { instructions, baseAccount, quoteAccount };
}

async function verifySimulation(snapshot, label, plans, expected, setupFunding = 5_000_000n) {
  const state = snapshot.venue === "pool" ? snapshot.pool : snapshot.curve;
  const owner = state.creator;
  const setup = await preparation(snapshot, owner, setupFunding);
  const addresses = [state.address, state.baseVault, state.quoteVault, setup.baseAccount, setup.quoteAccount, owner];
  if (snapshot.venue === "pool") addresses.push(snapshot.lpMint.address, (await deriveAssociatedTokenAddress(owner, snapshot.lpMint.address)).address);
  const before = await readAccounts(addresses, snapshot.slot);
  const currentMarket = snapshot.venue === "pool"
    ? await decodePoolAccount(before.accounts[0], snapshot.swapConfig)
    : await decodeCurveAccount(before.accounts[0], snapshot.launchConfig);
  assert.deepEqual(currentMarket, state, "Market changed before simulation; rerun with a fresh snapshot");
  const instructions = plans.map((plan) => {
    if (plan.context) assertOwnedTransactionPlanSignable(plan, before.slot);
    assertOwnedInstructionMatchesIntent(plan.instruction, plan.intent);
    return plan.instruction;
  });
  const { value: lifetime } = await rpc.getLatestBlockhash({ commitment: "confirmed", minContextSlot: before.slot }).send();
  const message = pipe(createTransactionMessage({ version: 0 }),
    (value) => setTransactionMessageFeePayer(owner, value),
    (value) => setTransactionMessageLifetimeUsingBlockhash(lifetime, value),
    (value) => appendTransactionMessageInstructions([...setup.instructions, ...instructions], value));
  const transaction = compileTransaction(message);
  assert.ok(Object.values(transaction.signatures).every((signature) => signature === null), "Verification transaction must remain unsigned");
  const simulation = await rpc.simulateTransaction(getBase64EncodedWireTransaction(transaction), {
    encoding: "base64", sigVerify: false, commitment: "confirmed", minContextSlot: before.slot,
    accounts: { encoding: "base64", addresses },
  }).send();
  assert.equal(simulation.value.err, null, `Simulation failed: ${JSON.stringify(simulation.value.err, serialize)}`);
  assert.equal(simulation.value.accounts?.length, addresses.length, "Simulation omitted requested account state");
  const after = simulation.value.accounts.map((account, index) => account === null ? null : observed(account, addresses[index]));
  const resultState = snapshot.venue === "pool"
    ? await decodePoolAccount(after[0], snapshot.swapConfig)
    : await decodeCurveAccount(after[0], snapshot.launchConfig);
  for (const [field, value] of Object.entries(expected.state)) assert.equal(resultState[field], value, `${label}: ${field}`);
  const previousBase = before.accounts[3] === null ? 0n : decodeLegacyTokenAccount(before.accounts[3]).amount;
  const previousQuote = before.accounts[4] === null ? 0n : decodeLegacyTokenAccount(before.accounts[4]).amount;
  assert.equal(decodeLegacyTokenAccount(after[3]).amount, previousBase + expected.baseDelta, `${label}: user base delta`);
  assert.equal(decodeLegacyTokenAccount(after[4]).amount, previousQuote + setupFunding + expected.quoteDelta, `${label}: user quote delta`);
  assert.equal(decodeLegacyTokenAccount(after[1]).amount, snapshot.baseVault.amount - expected.baseDelta, `${label}: base vault delta`);
  assert.equal(decodeLegacyTokenAccount(after[2]).amount, snapshot.quoteVault.amount - expected.quoteDelta, `${label}: quote vault delta`);
  if (expected.lpDelta !== undefined) {
    const previousLp = before.accounts[7] === null ? 0n : decodeLegacyTokenAccount(before.accounts[7]).amount;
    assert.equal(decodeLegacyTokenAccount(after[7]).amount, previousLp + expected.lpDelta, `${label}: user LP delta`);
    assert.equal(decodeLegacyMint(after[6]).supply, snapshot.lpMint.supply + expected.lpDelta, `${label}: LP mint supply`);
  }
  const events = decodeOwnedTransactionEvents({ err: null, logMessages: simulation.value.logs });
  assert.equal(events.length, expected.events.length, `${label}: event count`);
  for (let index = 0; index < events.length; index++) {
    for (const [field, value] of Object.entries(expected.events[index])) assert.deepEqual(events[index][field], value, `${label}: event ${field}`);
  }
  const unchanged = await readAccounts(addresses, simulation.context.slot);
  assert.deepEqual(unchanged.accounts.map(shaAccount), before.accounts.map(shaAccount), "Live account state changed during simulation; external activity invalidates the no-change observation");
  check(label, "passed", { sourceSlot: snapshot.slot, simulationSlot: simulation.context.slot,
    unitsConsumed: simulation.value.unitsConsumed, stateSha256: hash(after[0].data),
    comparisons: "market reserves/share state, accumulated fees, user and vault token deltas, decoded events, and unchanged live account bytes/lamports" });
}

function tradeExpectation(snapshot, quote, previous = snapshot.venue === "pool" ? snapshot.pool : snapshot.curve) {
  const result = quote.result;
  const buying = quote.side === "buy";
  const baseDelta = buying ? result.baseAmountOut : -result.baseAmountIn;
  const quoteDelta = buying ? -result.grossQuoteAmountIn : result.userQuoteAmountOut;
  const state = snapshot.venue === "pool"
    ? { baseReserves: result.nextReserves.base, quoteReserves: result.nextReserves.quote }
    : { virtualBaseReserves: result.nextReserves.virtualBase, virtualQuoteReserves: result.nextReserves.virtualQuote,
      realSaleBaseReserves: result.nextReserves.realSaleBase, realQuoteReserves: result.nextReserves.realQuote };
  state.creatorQuoteFees = previous.creatorQuoteFees + result.fees.creator;
  state.protocolQuoteFees = previous.protocolQuoteFees + result.fees.protocol;
  return { state, baseDelta, quoteDelta, events: [{
    kind: snapshot.venue === "pool" ? "PoolTrade" : "CurveTrade", side: quote.side,
    baseAmount: buying ? result.baseAmountOut : result.baseAmountIn,
    grossQuoteAmount: buying ? result.grossQuoteAmountIn : result.grossQuoteAmountOut,
    userQuoteAmount: buying ? result.grossQuoteAmountIn : result.userQuoteAmountOut,
    creatorFee: result.fees.creator, protocolFee: result.fees.protocol,
    ...(snapshot.venue === "pool" ? { reinvestFee: result.fees.reinvest } : {}),
  }] };
}

async function marketScenarios(snapshot) {
  const state = snapshot.venue === "pool" ? snapshot.pool : snapshot.curve;
  if (snapshot.quoteMint.address !== SOL_QUOTE_MINT_ADDRESS) {
    check(`${snapshot.venue}:USDC simulations`, "skipped", { reason: "Requires existing public USDC funds; harness never mints or airdrops tokens" });
    return;
  }
  const label = `${snapshot.venue}:SOL`;
  for (const request of [
    { side: "buy", inputMode: "exact-quote", quoteAmountIn: 1_000_000n, minBaseAmountOut: 0n },
    { side: "buy", inputMode: "exact-base", baseAmountOut: 1_000_000n, maxQuoteAmountIn: 1_000_000n },
  ]) {
    const plan = await createOwnedMarketTradePlan(snapshot, state.creator, request);
    await verifySimulation(snapshot, `${label}:${plan.intent.instruction}`, [plan], tradeExpectation(snapshot, plan.quote));
  }
  if (snapshot.venue === "curve") {
    // Existing curve real quote reserves are only two lamports and its public
    // creator's base ATA is empty. Simulate buy then sell inside ONE transaction;
    // the sell quote uses the buy's independently computed transient next state.
    const buy = await createOwnedMarketTradePlan(snapshot, state.creator,
      { side: "buy", inputMode: "exact-quote", quoteAmountIn: 1_000_000n, minBaseAmountOut: 0n });
    const first = tradeExpectation(snapshot, buy.quote);
    const transient = { ...snapshot, curve: { ...state, ...first.state } };
    const sellQuote = createCurveSellExactBaseInQuote(transient, buy.quote.result.baseAmountOut / 2n, 0n);
    const intent = { program: "archCurve", instruction: "sell_exact_base_in", accounts: buy.intent.accounts,
      args: { base_amount_in: sellQuote.result.baseAmountIn, min_quote_amount_out: 0n } };
    const sell = { intent, instruction: buildTypedOwnedInstruction(intent) };
    const second = tradeExpectation(snapshot, sellQuote, transient.curve);
    await verifySimulation(snapshot, `${label}:sell_exact_base_in_after_buy`, [buy, sell], {
      state: second.state, baseDelta: first.baseDelta + second.baseDelta,
      quoteDelta: first.quoteDelta + second.quoteDelta, events: [...first.events, ...second.events],
    });
  } else {
    const sell = await createOwnedMarketTradePlan(snapshot, state.creator,
      { side: "sell", inputMode: "exact-base", baseAmountIn: 1_000_000_000n, minQuoteAmountOut: 0n });
    await verifySimulation(snapshot, `${label}:sell_exact_base_in`, [sell], tradeExpectation(snapshot, sell.quote));
    for (const request of [
      { action: "deposit", lpSharesOut: 1_000_000n, maxBaseAmountIn: 1_000_000_000n, maxQuoteAmountIn: 1_000_000n },
    ]) {
      const plan = await createOwnedPoolLiquidityPlan(snapshot, state.creator, request);
      const result = plan.quote.result;
      const depositing = request.action === "deposit";
      const lpDelta = depositing ? result.lpSharesOut : -result.lpSharesIn;
      await verifySimulation(snapshot, `${label}:${plan.intent.instruction}`, [plan], {
        state: { baseReserves: result.nextReserves.base, quoteReserves: result.nextReserves.quote,
          totalEconomicShares: result.nextTotalEconomicShares, permanentlyLockedShares: state.permanentlyLockedShares,
          creatorQuoteFees: state.creatorQuoteFees, protocolQuoteFees: state.protocolQuoteFees },
        baseDelta: depositing ? -result.baseAmountIn : result.baseAmountOut,
        quoteDelta: depositing ? -result.quoteAmountIn : result.quoteAmountOut, lpDelta,
        events: [{ kind: depositing ? "LiquidityDeposited" : "LiquidityWithdrawn", pool: state.address,
          provider: state.creator, lpMint: state.lpMint, totalEconomicShares: result.nextTotalEconomicShares,
          ...(depositing ? { lpSharesOut: result.lpSharesOut, baseAmountIn: result.baseAmountIn, quoteAmountIn: result.quoteAmountIn }
            : { lpSharesIn: result.lpSharesIn, baseAmountOut: result.baseAmountOut, quoteAmountOut: result.quoteAmountOut }) }],
      });
    }
    // The public creator currently holds no transferable LP shares. As with the
    // Curve sell, establish funds transiently in the same unsigned simulation.
    const deposit = await createOwnedPoolLiquidityPlan(snapshot, state.creator,
      { action: "deposit", lpSharesOut: 1_000_000n, maxBaseAmountIn: 1_000_000_000n, maxQuoteAmountIn: 1_000_000n });
    const initial = deposit.quote.result;
    const transient = { ...snapshot, pool: { ...state, baseReserves: initial.nextReserves.base,
      quoteReserves: initial.nextReserves.quote, totalEconomicShares: initial.nextTotalEconomicShares } };
    const withdrawal = createPoolWithdrawLiquidityQuote(transient, initial.lpSharesOut, 0n, 0n).result;
    const intent = { program: "archSwap", instruction: "withdraw_liquidity", accounts: deposit.intent.accounts,
      args: { lp_shares_in: initial.lpSharesOut, min_base_amount_out: 0n, min_quote_amount_out: 0n } };
    await verifySimulation(snapshot, `${label}:withdraw_liquidity_after_deposit`, [deposit,
      { intent, instruction: buildTypedOwnedInstruction(intent) }], {
      state: { baseReserves: withdrawal.nextReserves.base, quoteReserves: withdrawal.nextReserves.quote,
        totalEconomicShares: withdrawal.nextTotalEconomicShares, permanentlyLockedShares: state.permanentlyLockedShares,
        creatorQuoteFees: state.creatorQuoteFees, protocolQuoteFees: state.protocolQuoteFees },
      baseDelta: withdrawal.baseAmountOut - initial.baseAmountIn,
      quoteDelta: withdrawal.quoteAmountOut - initial.quoteAmountIn, lpDelta: 0n,
      events: [
        { kind: "LiquidityDeposited", pool: state.address, provider: state.creator, lpMint: state.lpMint,
          lpSharesOut: initial.lpSharesOut, baseAmountIn: initial.baseAmountIn, quoteAmountIn: initial.quoteAmountIn,
          totalEconomicShares: initial.nextTotalEconomicShares },
        { kind: "LiquidityWithdrawn", pool: state.address, provider: state.creator, lpMint: state.lpMint,
          lpSharesIn: initial.lpSharesOut, baseAmountOut: withdrawal.baseAmountOut, quoteAmountOut: withdrawal.quoteAmountOut,
          totalEconomicShares: withdrawal.nextTotalEconomicShares },
      ],
    });
  }
}

async function main() {
  const genesis = await rpc.getGenesisHash().send();
  assertOwnedDeploymentGenesisHash(genesis);
  check("devnet genesis", "passed", { genesisHash: genesis });
  const programAddresses = Object.values(ARCHLIQUID_DEVNET_DEPLOYMENT.programs);
  const programs = await rpc.getMultipleAccounts(programAddresses, { encoding: "base64", commitment: "confirmed" }).send();
  const loader = "BPFLoaderUpgradeab1e11111111111111111111111";
  const programDataAddresses = programs.value.map((account) => {
    assert.ok(account?.executable && account.owner === loader, "Deployment program must exist, be executable, and use the upgradeable loader");
    const data = Buffer.from(account.data[0], "base64");
    assert.equal(data.length, 36); assert.equal(data.readUInt32LE(0), 2);
    return addressDecoder.decode(data.subarray(4));
  });
  const programData = await rpc.getMultipleAccounts(programDataAddresses, { encoding: "base64", commitment: "confirmed", minContextSlot: programs.context.slot }).send();
  for (let index = 0; index < programAddresses.length; index++) {
    const account = programData.value[index];
    assert.ok(account && account.owner === loader && !account.executable);
    const data = Buffer.from(account.data[0], "base64");
    assert.ok(data.length >= 45 && data.length <= 1_048_576); assert.equal(data.readUInt32LE(0), 3);
    assert.ok(data[12] === 0 || data[12] === 1);
    check(`program ${Object.keys(ARCHLIQUID_DEVNET_DEPLOYMENT.programs)[index]}`, "passed", {
      programAddress: programAddresses[index], programDataAddress: programDataAddresses[index], observedSlot: programData.context.slot,
      lastDeploySlot: data.readBigUInt64LE(4), upgradeAuthority: data[12] === 1 ? addressDecoder.decode(data.subarray(13, 45)) : null,
      programDataSha256: hash(data), programDataPayloadSha256: hash(data.subarray(45)),
      hashBoundary: "All observed ProgramData bytes after the 45-byte metadata, including any allocated padding",
      identityLimit: "Observed deployment fingerprint; not matched to a governed Rust build",
    });
  }
  const [protocol, swapAddress] = await Promise.all([deriveProtocolConfigAddress(), deriveSwapConfigAddress()]);
  const configs = await readAccounts([protocol.address, swapAddress.address]);
  await decodeProtocolConfigAccount(configs.accounts[0]);
  const swap = await decodeSwapConfigAccount(configs.accounts[1]);
  check("protocol and swap config", "passed", { slot: configs.slot, protocol: protocol.address, swap: swapAddress.address });
  for (const mint of [SOL_QUOTE_MINT_ADDRESS, USDC_QUOTE_MINT_ADDRESS]) {
    const snapshot = await loadLaunchSnapshot(reader, mint);
    check(`launch ${snapshot.launchConfig.quoteKind}`, "passed", { slot: snapshot.slot, launchConfig: snapshot.launchConfig.address });
  }
  const marketSnapshots = { curve: [], pool: [] };
  for (const [venue, program, layout] of [["curve", ARCH_CURVE_PROGRAM_ADDRESS, OWNED_ACCOUNT_LAYOUTS.curve], ["pool", ARCH_SWAP_PROGRAM_ADDRESS, OWNED_ACCOUNT_LAYOUTS.pool]]) {
    const discovered = await rpc.getProgramAccounts(program, {
      encoding: "base64", commitment: "confirmed", withContext: true, dataSlice: { offset: 0, length: 0 },
      filters: [{ dataSize: BigInt(layout.size) }, { memcmp: { offset: 0n, bytes: getBase58Decoder().decode(new Uint8Array(layout.discriminator)) } }],
    }).send();
    assert.ok(discovered.value.length <= 256, "Discovery exceeds the account-count cap");
    const selected = discovered.value.slice(0, 5).map((account) => account.pubkey);
    check(`${venue} discovery`, "passed", { slot: discovered.context.slot, total: discovered.value.length, inspected: selected.length });
    if (selected.length === 0) continue;
    const accounts = await readAccounts(selected, discovered.context.slot);
    for (const account of accounts.accounts) {
      let snapshot;
      if (venue === "curve") {
        // Discovery is untrusted; these offsets only locate a candidate mint.
        // The loader independently validates all identities and relationships.
        const baseMint = addressDecoder.decode(account.data.subarray(83, 115));
        snapshot = await loadCurveSnapshot(reader, baseMint, { minContextSlot: accounts.slot });
      } else {
        const pool = await decodePoolAccount(account, swap);
        snapshot = await loadPoolSnapshot(reader, pool.baseMint, pool.quoteMint, { minContextSlot: accounts.slot });
      }
      const state = snapshot.venue === "pool" ? snapshot.pool : snapshot.curve;
      assert.equal(state.address, account.address);
      marketSnapshots[venue].push(snapshot);
      check(`${venue} snapshot ${state.address}`, "passed", { slot: snapshot.slot, baseMint: state.baseMint, quoteMint: state.quoteMint,
        ...(venue === "curve" ? { complete: state.complete, migrated: state.migrated } : {}) });
    }
    for (const mint of [SOL_QUOTE_MINT_ADDRESS, USDC_QUOTE_MINT_ADDRESS]) {
      if (!marketSnapshots[venue].some((snapshot) => snapshot.quoteMint.address === mint)) {
        check(`${venue}:${mint === SOL_QUOTE_MINT_ADDRESS ? "SOL" : "USDC"} scenarios`, "skipped", { reason: "No market for this quote mint in the bounded live discovery" });
      }
    }
  }
  const activeCurve = marketSnapshots.curve.find((snapshot) => !snapshot.curve.complete && !snapshot.curve.migrated && snapshot.quoteMint.address === SOL_QUOTE_MINT_ADDRESS);
  for (const snapshot of [activeCurve, marketSnapshots.pool.find((item) => item.quoteMint.address === SOL_QUOTE_MINT_ADDRESS)]) {
    if (!snapshot) { check("representative live simulation", "skipped", { reason: "No active SOL market available" }); continue; }
    try { await marketScenarios(snapshot); }
    catch (error) {
      check(`${snapshot.venue} simulations`, "failed", { reason: error.message });
      const scenarios = snapshot.venue === "curve"
        ? ["buy_exact_quote_in", "buy_exact_base_out", "sell_exact_base_in_after_buy"]
        : ["buy_exact_quote_in", "buy_exact_base_out", "sell_exact_base_in", "deposit_liquidity", "withdraw_liquidity_after_deposit"];
      for (const scenario of scenarios) {
        const name = `${snapshot.venue}:SOL:${scenario}`;
        if (!report.checks.some((item) => item.name === name)) check(name, "skipped", { reason: "An earlier scenario in this market failed; see the failure record" });
      }
    }
  }
  const pool = marketSnapshots.pool[0]?.pool;
  if (pool) {
    assert.equal(calculateInitialLiquidityShares({ base: pool.initialLockedBase, quote: pool.initialLockedQuote }), pool.permanentlyLockedShares);
    check("pool initial locked-share arithmetic", "passed", {
      baseAmount: pool.initialLockedBase, quoteAmount: pool.initialLockedQuote, permanentlyLockedShares: pool.permanentlyLockedShares,
      limit: "Compared to immutable initial fields in the current decoded pool; not reconstructed historical transaction prestate",
    });
    const signatures = await rpc.getSignaturesForAddress(pool.address, { commitment: "confirmed", limit: 50 }).send();
    assert.ok(signatures.length <= 50, "Historical signature discovery exceeds its bound");
    const creation = signatures.find((item) => item.slot === pool.createdSlot && item.err === null);
    if (!creation) {
      check("historical pool initialization event", "skipped", { reason: "Pool creation is not present in the newest 50 signatures returned by this RPC" });
    } else {
      const transaction = await rpc.getTransaction(creation.signature, {
        commitment: "confirmed", encoding: "json", maxSupportedTransactionVersion: 0,
      }).send();
      if (transaction?.meta?.err !== null || !transaction.meta.logMessages) {
        check("historical pool initialization event", "skipped", { reason: "RPC did not provide the successful creation transaction and logs" });
      } else {
        const event = decodeOwnedTransactionEvents({ err: null, logMessages: transaction.meta.logMessages })
          .find((item) => item.kind === "CanonicalPoolInitialized" && item.pool === pool.address);
        assert.ok(event, "Creation transaction has no verified canonical pool initialization event");
        assert.equal(event.baseAmount, pool.initialLockedBase);
        assert.equal(event.quoteAmount, pool.initialLockedQuote);
        assert.equal(event.permanentlyLockedShares, pool.permanentlyLockedShares);
        assert.equal(calculateInitialLiquidityShares({ base: event.baseAmount, quote: event.quoteAmount }), event.permanentlyLockedShares);
        check("historical pool initialization event", "passed", { signature: creation.signature, slot: transaction.slot,
          baseAmount: event.baseAmount, quoteAmount: event.quoteAmount, permanentlyLockedShares: event.permanentlyLockedShares,
          limit: "Initial-share arithmetic compared to a successful committed program event; historical account prestate is not reconstructed" });
      }
    }
  }
  check("human wallet signature/approval", "skipped", { reason: "Requires owner-controlled interactive wallet; this harness never signs or accesses keys" });
  check("governed Rust reference build parity", "skipped", { reason: "Requires independently governed reference vectors and deployment/source association" });
}

try { await main(); }
catch (error) { check("live verification", "failed", { reason: error.message }); }
finally {
  report.finishedAt = new Date().toISOString(); report.requestCount = requestCount;
  report.summary = Object.fromEntries(["passed", "failed", "skipped"].map((status) => [status, report.checks.filter((item) => item.status === status).length]));
  if (options.length) await writeFile(options[1], `${JSON.stringify(report, serialize, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({ summary: report.summary, requestCount }));
  if (report.summary.failed > 0) process.exitCode = 1;
}

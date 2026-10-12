import { address, type Address, type Commitment, type Instruction, type ReadonlyUint8Array, type Slot } from "@solana/kit";

import { ZERO_ADDRESS } from "./addresses.js";
import { type ARCHLIQUID_DEVNET_DEPLOYMENT } from "./deployment.js";
import { OwnedSdkError } from "./errors.js";
import {
  createCurveBuyExactBaseOutQuote, createCurveBuyExactQuoteInQuote, createCurveSellExactBaseInQuote,
  createPoolBuyExactBaseOutQuote, createPoolBuyExactQuoteInQuote, createPoolSellExactBaseInQuote,
  createPoolDepositLiquidityQuote, createPoolWithdrawLiquidityQuote,
  type OwnedMarketQuote, type OwnedPoolLiquidityQuote, type QuoteTimingOptions,
} from "./owned-market-quotes.js";
import {
  assertLaunchConfigActive, deriveCurveTradeAccountMap, derivePoolTradeAccountMap,
  derivePoolLiquidityAccountMap,
} from "./owned-program-accounts.js";
import {
  assertOwnedInstructionMatchesIntent, buildTypedOwnedInstruction,
  type DecodedOwnedInstruction, type OwnedInstructionArgumentValue, type OwnedInstructionInputFor,
  type TokenMetadataInstructionInput, type TypedOwnedInstructionInput,
} from "./owned-program-instructions.js";
import {
  deriveAssociatedTokenAddress, deriveBaseMintAddress, deriveCurveAddress, deriveMetadataAddress,
} from "./owned-program-pdas.js";
import {
  assertOwnedSnapshot, type OwnedCurveSnapshot, type OwnedLaunchSnapshot, type OwnedPoolSnapshot,
} from "./owned-snapshots.js";
import type {
  AmmBuyQuote, AmmDepositQuote, AmmSellQuote, AmmWithdrawQuote, CurveBuyQuote, CurveSellQuote,
} from "./owned-quote-math.js";

export type OwnedMarketTradeRequest =
  | Readonly<{ side: "buy"; inputMode: "exact-base"; baseAmountOut: bigint; maxQuoteAmountIn: bigint }>
  | Readonly<{ side: "buy"; inputMode: "exact-quote"; quoteAmountIn: bigint; minBaseAmountOut: bigint }>
  | Readonly<{ side: "sell"; inputMode: "exact-base"; baseAmountIn: bigint; minQuoteAmountOut: bigint }>;

export type OwnedPoolLiquidityRequest =
  | Readonly<{ action: "deposit"; lpSharesOut: bigint; maxBaseAmountIn: bigint; maxQuoteAmountIn: bigint }>
  | Readonly<{ action: "withdraw"; lpSharesIn: bigint; minBaseAmountOut: bigint; minQuoteAmountOut: bigint }>;

/** Observation time always comes from the validated snapshot, never the caller. */
export type OwnedTransactionPlanOptions = Omit<QuoteTimingOptions, "observedAtUnixMs">;

export type OwnedRequiredTokenAccount = Readonly<{
  kind: "base" | "quote" | "lp"; address: Address; owner: Address; mint: Address;
}>;

export type OwnedTransactionPlanContext = Readonly<{
  sourceSlot: Slot; observedAtUnixMs: number; expiresAtSlot: Slot; expiresAtUnixMs: number;
  commitment: Commitment; deployment: typeof ARCHLIQUID_DEVNET_DEPLOYMENT;
}>;

type TradeQuote = OwnedMarketQuote<CurveBuyQuote | CurveSellQuote | AmmBuyQuote | AmmSellQuote>;
type LiquidityQuote = OwnedPoolLiquidityQuote<AmmDepositQuote | AmmWithdrawQuote>;

export type OwnedTransactionPlan<Q = TradeQuote | LiquidityQuote | null> = Readonly<{
  kind: "trade" | "liquidity" | "create-curve";
  quote: Q;
  instruction: Instruction;
  intent: TypedOwnedInstructionInput;
  context: OwnedTransactionPlanContext;
  requiredTokenAccounts: readonly OwnedRequiredTokenAccount[];
}>;
export type OwnedMarketTradePlan = OwnedTransactionPlan<TradeQuote> & Readonly<{ kind: "trade" }>;
export type OwnedPoolLiquidityPlan = OwnedTransactionPlan<LiquidityQuote> & Readonly<{ kind: "liquidity" }>;
export type OwnedCurvePlan = OwnedTransactionPlan<null> & Readonly<{
  kind: "create-curve";
  intent: OwnedInstructionInputFor<"archCurve", "create_curve">;
  createdAddresses: Readonly<{ baseMint: Address; curve: Address; baseVault: Address; quoteVault: Address; metadata: Address }>;
}>;
export type OwnedCurvePlanRequest = Readonly<{
  launchNonce: bigint;
  metadata: TokenMetadataInstructionInput;
  metadataCommitment: ReadonlyUint8Array;
}>;

type Timing = Pick<OwnedTransactionPlanContext, "sourceSlot" | "observedAtUnixMs" | "expiresAtSlot" | "expiresAtUnixMs">;
type PrivatePlan = Readonly<{ intent: TypedOwnedInstructionInput; context: OwnedTransactionPlanContext }>;
const approvedPlans = new WeakMap<object, PrivatePlan>();
const MAX_U64 = (1n << 64n) - 1n;

function copyArgument(value: OwnedInstructionArgumentValue): OwnedInstructionArgumentValue {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (typeof value === "object") return Object.freeze({ ...value });
  return value;
}

function copyIntent<T extends TypedOwnedInstructionInput>(intent: T): T {
  return Object.freeze({
    ...intent,
    accounts: Object.freeze({ ...intent.accounts }),
    args: Object.freeze(Object.fromEntries(
      Object.entries(intent.args ?? {}).map(([name, value]) => [name, copyArgument(value)]),
    )),
  }) as T;
}

function contextFrom(
  snapshot: OwnedCurveSnapshot | OwnedPoolSnapshot | OwnedLaunchSnapshot,
  timing: Timing,
): OwnedTransactionPlanContext {
  return Object.freeze({
    sourceSlot: timing.sourceSlot, observedAtUnixMs: timing.observedAtUnixMs,
    expiresAtSlot: timing.expiresAtSlot, expiresAtUnixMs: timing.expiresAtUnixMs,
    commitment: snapshot.commitment, deployment: snapshot.deployment,
  });
}

function materialize<Q>(
  kind: OwnedTransactionPlan["kind"], quote: Q, intent: TypedOwnedInstructionInput,
  context: OwnedTransactionPlanContext, requiredTokenAccounts: readonly OwnedRequiredTokenAccount[],
  createdAddresses?: OwnedCurvePlan["createdAddresses"],
): OwnedTransactionPlan<Q> {
  // The public and private byte arrays must not share storage. Typed arrays
  // remain mutable for Kit compatibility, so authorization uses the private copy.
  const privateIntent = copyIntent(intent);
  const publicIntent = copyIntent(privateIntent);
  const instruction = buildTypedOwnedInstruction(privateIntent);
  const frozenInstruction = Object.freeze({
    ...instruction,
    accounts: Object.freeze(instruction.accounts!.map((account) => Object.freeze({ ...account }))),
  });
  const plan = Object.freeze({
    kind, quote, intent: publicIntent, instruction: frozenInstruction, context,
    requiredTokenAccounts: Object.freeze(requiredTokenAccounts.map((account) => Object.freeze({ ...account }))),
    ...(createdAddresses ? { createdAddresses: Object.freeze({ ...createdAddresses }) } : {}),
  });
  approvedPlans.set(plan, Object.freeze({ intent: privateIntent, context }));
  return plan;
}

function tradeDetails(request: OwnedMarketTradeRequest) {
  if (request?.side === "buy" && request.inputMode === "exact-base") {
    return { instruction: "buy_exact_base_out" as const,
      args: { base_amount_out: request.baseAmountOut, max_quote_amount_in: request.maxQuoteAmountIn } };
  }
  if (request?.side === "buy" && request.inputMode === "exact-quote") {
    return { instruction: "buy_exact_quote_in" as const,
      args: { quote_amount_in: request.quoteAmountIn, min_base_amount_out: request.minBaseAmountOut } };
  }
  if (request?.side === "sell" && request.inputMode === "exact-base") {
    return { instruction: "sell_exact_base_in" as const,
      args: { base_amount_in: request.baseAmountIn, min_quote_amount_out: request.minQuoteAmountOut } };
  }
  throw new OwnedSdkError("invalid_input", "Trade plan request has an unsupported side or input mode");
}

/**
 * Quote validated account state and build a canonical ATA-based trade instruction.
 * The original requested limits are retained even when the quote is better.
 * This does not create user accounts, wrap SOL, simulate, sign or send.
 */
export async function createOwnedMarketTradePlan(
  snapshot: OwnedCurveSnapshot | OwnedPoolSnapshot, trader: string,
  request: OwnedMarketTradeRequest, options: OwnedTransactionPlanOptions = {},
): Promise<OwnedMarketTradePlan> {
  assertOwnedSnapshot(snapshot);
  if (!("venue" in snapshot) || (snapshot.venue !== "curve" && snapshot.venue !== "pool")) {
    throw new OwnedSdkError("invalid_snapshot", "Trade plans require a Curve or Pool snapshot");
  }
  const details = tradeDetails(request); // Capture limits before any async PDA derivation.
  const timing = { ...options, observedAtUnixMs: snapshot.observedAtUnixMs };
  let quote: TradeQuote;
  if (details.instruction === "buy_exact_base_out") {
    quote = snapshot.venue === "curve"
      ? createCurveBuyExactBaseOutQuote(snapshot, details.args.base_amount_out, details.args.max_quote_amount_in, timing)
      : createPoolBuyExactBaseOutQuote(snapshot, details.args.base_amount_out, details.args.max_quote_amount_in, timing);
  } else if (details.instruction === "buy_exact_quote_in") {
    quote = snapshot.venue === "curve"
      ? createCurveBuyExactQuoteInQuote(snapshot, details.args.quote_amount_in, details.args.min_base_amount_out, timing)
      : createPoolBuyExactQuoteInQuote(snapshot, details.args.quote_amount_in, details.args.min_base_amount_out, timing);
  } else {
    quote = snapshot.venue === "curve"
      ? createCurveSellExactBaseInQuote(snapshot, details.args.base_amount_in, details.args.min_quote_amount_out, timing)
      : createPoolSellExactBaseInQuote(snapshot, details.args.base_amount_in, details.args.min_quote_amount_out, timing);
  }
  const identity = snapshot.venue === "curve"
    ? { program: "archCurve" as const, accounts: await deriveCurveTradeAccountMap(snapshot.curve, trader) }
    : { program: "archSwap" as const, accounts: await derivePoolTradeAccountMap(snapshot.pool, trader) };
  const intent: TypedOwnedInstructionInput = { ...identity, ...details };
  return materialize("trade", quote, intent, contextFrom(snapshot, quote), [
    { kind: "base", address: identity.accounts.trader_base_account, owner: identity.accounts.trader, mint: quote.baseMint },
    { kind: "quote", address: identity.accounts.trader_quote_account, owner: identity.accounts.trader, mint: quote.quoteMint },
  ]) as OwnedMarketTradePlan;
}

/** Quote and build a canonical ATA-based LP instruction with original limits. */
export async function createOwnedPoolLiquidityPlan(
  snapshot: OwnedPoolSnapshot, provider: string, request: OwnedPoolLiquidityRequest,
  options: OwnedTransactionPlanOptions = {},
): Promise<OwnedPoolLiquidityPlan> {
  assertOwnedSnapshot(snapshot);
  if (!("venue" in snapshot) || snapshot.venue !== "pool") {
    throw new OwnedSdkError("invalid_snapshot", "Liquidity plans require a Pool snapshot");
  }
  const timing = { ...options, observedAtUnixMs: snapshot.observedAtUnixMs };
  let quote: LiquidityQuote;
  let details;
  if (request?.action === "deposit") {
    details = { instruction: "deposit_liquidity" as const, args: {
      lp_shares_out: request.lpSharesOut, max_base_amount_in: request.maxBaseAmountIn,
      max_quote_amount_in: request.maxQuoteAmountIn,
    } };
    quote = createPoolDepositLiquidityQuote(snapshot, details.args.lp_shares_out,
      details.args.max_base_amount_in, details.args.max_quote_amount_in, timing);
  } else if (request?.action === "withdraw") {
    details = { instruction: "withdraw_liquidity" as const, args: {
      lp_shares_in: request.lpSharesIn, min_base_amount_out: request.minBaseAmountOut,
      min_quote_amount_out: request.minQuoteAmountOut,
    } };
    quote = createPoolWithdrawLiquidityQuote(snapshot, details.args.lp_shares_in,
      details.args.min_base_amount_out, details.args.min_quote_amount_out, timing);
  } else {
    throw new OwnedSdkError("invalid_input", "Liquidity plan request has an unsupported action");
  }
  const accounts = await derivePoolLiquidityAccountMap(snapshot.pool, provider);
  const intent: TypedOwnedInstructionInput = { program: "archSwap", accounts, ...details };
  return materialize("liquidity", quote, intent, contextFrom(snapshot, quote), [
    { kind: "base", address: accounts.provider_base_account, owner: accounts.provider, mint: snapshot.pool.baseMint },
    { kind: "quote", address: accounts.provider_quote_account, owner: accounts.provider, mint: snapshot.pool.quoteMint },
    { kind: "lp", address: accounts.provider_lp_account, owner: accounts.provider, mint: snapshot.pool.lpMint },
  ]) as OwnedPoolLiquidityPlan;
}

function launchTiming(snapshot: OwnedLaunchSnapshot, options: OwnedTransactionPlanOptions): Timing {
  const validitySlots = options.validitySlots ?? 150n;
  const validityMs = options.validityMs ?? 60_000;
  if (typeof validitySlots !== "bigint" || validitySlots <= 0n || snapshot.slot + validitySlots > MAX_U64 ||
      !Number.isSafeInteger(validityMs) || validityMs <= 0 ||
      !Number.isSafeInteger(snapshot.observedAtUnixMs + validityMs)) {
    throw new OwnedSdkError("invalid_input", "Curve plan validity is invalid");
  }
  return { sourceSlot: snapshot.slot, observedAtUnixMs: snapshot.observedAtUnixMs,
    expiresAtSlot: (snapshot.slot + validitySlots) as Slot, expiresAtUnixMs: snapshot.observedAtUnixMs + validityMs };
}

/**
 * Build create_curve using an enabled active launch configuration and canonical
 * mint/curve/vault/metadata PDAs. The program validates the supplied commitment's
 * binding to metadata. This does not check whether the new accounts already exist.
 */
export async function createOwnedCurvePlan(
  snapshot: OwnedLaunchSnapshot, ownerValue: string, request: OwnedCurvePlanRequest,
  options: OwnedTransactionPlanOptions = {},
): Promise<OwnedCurvePlan> {
  assertOwnedSnapshot(snapshot);
  if (!("purpose" in snapshot) || snapshot.purpose !== "launch" || !snapshot.protocol.launchesEnabled) {
    throw new OwnedSdkError("invalid_snapshot", "Curve creation requires an enabled launch snapshot");
  }
  assertLaunchConfigActive(snapshot.protocol, snapshot.launchConfig);
  const owner = address(ownerValue);
  if (owner === ZERO_ADDRESS) throw new OwnedSdkError("invalid_input", "Curve creator must not be the default address");
  if (!request || typeof request.launchNonce !== "bigint" || request.launchNonce < 0n || request.launchNonce > MAX_U64 ||
      !(request.metadataCommitment instanceof Uint8Array) || request.metadataCommitment.length !== 32 ||
      request.metadataCommitment.every((byte) => byte === 0)) {
    throw new OwnedSdkError("invalid_input", "Curve creation requires a u64 nonce and a nonzero 32-byte metadata commitment");
  }
  const args = {
    launch_nonce: request.launchNonce,
    metadata: Object.freeze({ ...request.metadata }),
    metadata_commitment: new Uint8Array(request.metadataCommitment),
  };
  const timing = launchTiming(snapshot, options);
  const baseMint = (await deriveBaseMintAddress(owner, args.launch_nonce)).address;
  const curve = (await deriveCurveAddress(baseMint)).address;
  const [baseVault, quoteVault, metadata] = await Promise.all([
    deriveAssociatedTokenAddress(curve, baseMint), deriveAssociatedTokenAddress(curve, snapshot.launchConfig.quoteMint),
    deriveMetadataAddress(baseMint),
  ]);
  const intent: TypedOwnedInstructionInput = { program: "archCurve", instruction: "create_curve", args,
    accounts: { protocol_config: snapshot.protocol.address, launch_config: snapshot.launchConfig.address,
      creator: owner, base_mint: baseMint, curve, base_vault: baseVault.address, quote_vault: quoteVault.address,
      quote_mint: snapshot.launchConfig.quoteMint, metadata: metadata.address } };
  return materialize("create-curve", null, intent, contextFrom(snapshot, timing), [], {
    baseMint, curve, baseVault: baseVault.address, quoteVault: quoteVault.address, metadata: metadata.address,
  }) as OwnedCurvePlan;
}

/**
 * Recheck an SDK-created plan immediately before signing using a fresh RPC slot
 * and clock. Rejects expired state, copied/deserialized plans, modified intent,
 * and changed instruction bytes. This does not validate user balances or simulate.
 */
export function assertOwnedTransactionPlanSignable(
  plan: OwnedTransactionPlan, currentSlot: Slot, currentUnixMs = Date.now(),
): DecodedOwnedInstruction {
  const approved = plan && approvedPlans.get(plan);
  if (!approved) throw new OwnedSdkError("invalid_input", "Transaction plan was not created by this SDK instance");
  const context = approved.context;
  if (typeof currentSlot !== "bigint" || currentSlot < 0n || currentSlot > MAX_U64 ||
      !Number.isSafeInteger(currentUnixMs) || currentUnixMs < 0) {
    throw new OwnedSdkError("invalid_input", "Transaction plan freshness context is invalid");
  }
  if (currentSlot < context.sourceSlot || currentUnixMs < context.observedAtUnixMs ||
      currentSlot >= context.expiresAtSlot || currentUnixMs >= context.expiresAtUnixMs) {
    throw new OwnedSdkError("stale_context", "Transaction plan has expired or freshness context moved backwards");
  }
  try {
    assertOwnedInstructionMatchesIntent(buildTypedOwnedInstruction(plan.intent), approved.intent);
    return assertOwnedInstructionMatchesIntent(plan.instruction, approved.intent);
  } catch (cause) {
    throw new OwnedSdkError("quote_mismatch", "Transaction plan no longer matches the independently approved intent", { cause });
  }
}

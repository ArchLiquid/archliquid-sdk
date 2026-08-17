import type { Address, Slot } from "@solana/kit";

import type {
  DecodedCurve,
  DecodedPool,
  LaunchParameters,
} from "./owned-program-accounts.js";
import {
  calculateAmmBuyExactBaseOut,
  calculateAmmBuyExactQuoteIn,
  calculateAmmDepositExactShares,
  calculateAmmSellExactBaseIn,
  calculateAmmWithdrawExactShares,
  calculateCurveBuyExactBaseOut,
  calculateCurveBuyExactQuoteIn,
  calculateCurveSellExactBaseIn,
  type AmmBuyQuote,
  type AmmDepositQuote,
  type AmmSellQuote,
  type AmmWithdrawQuote,
  type CurveBuyQuote,
  type CurveSellQuote,
} from "./owned-quote-math.js";

const DEFAULT_VALIDITY_SLOTS = 150n;
const DEFAULT_VALIDITY_MS = 60_000;
const MAX_U64 = (1n << 64n) - 1n;

type CurveQuoteSource = Readonly<{
  slot: Slot;
  curve: Pick<
    DecodedCurve,
    | "baseMint"
    | "quoteMint"
    | "virtualBaseReserves"
    | "virtualQuoteReserves"
    | "realSaleBaseReserves"
    | "realQuoteReserves"
    | "complete"
    | "migrated"
  >;
  launchConfig: Readonly<{
    parameters: Pick<LaunchParameters, "curveTotalFeeBps" | "curveCreatorFeeBps">;
  }>;
}>;

type PoolQuoteSource = Readonly<{
  slot: Slot;
  pool: Pick<DecodedPool, "baseMint" | "quoteMint" | "baseReserves" | "quoteReserves" | "fees">;
}>;

type PoolLiquidityQuoteSource = Readonly<{
  slot: Slot;
  pool: Pick<
    DecodedPool,
    | "baseMint"
    | "quoteMint"
    | "baseReserves"
    | "quoteReserves"
    | "totalEconomicShares"
    | "permanentlyLockedShares"
  >;
}>;

type QuoteTimingOptions = Readonly<{
  observedAtUnixMs?: number;
  validitySlots?: bigint;
  validityMs?: number;
}>;

export type OwnedMarketQuote<T> = Readonly<{
  venue: "curve" | "pool";
  side: "buy" | "sell";
  inputMode: "exact-base" | "exact-quote";
  baseMint: Address;
  quoteMint: Address;
  sourceSlot: Slot;
  expiresAtSlot: Slot;
  observedAtUnixMs: number;
  expiresAtUnixMs: number;
  result: T;
}>;

export type OwnedPoolLiquidityQuote<T> = Readonly<{
  venue: "pool";
  action: "deposit" | "withdraw";
  baseMint: Address;
  quoteMint: Address;
  sourceSlot: Slot;
  expiresAtSlot: Slot;
  observedAtUnixMs: number;
  expiresAtUnixMs: number;
  result: T;
}>;

function quoteTiming(slot: Slot, options: QuoteTimingOptions = {}) {
  const observedAtUnixMs = options.observedAtUnixMs ?? Date.now();
  const validitySlots = options.validitySlots ?? DEFAULT_VALIDITY_SLOTS;
  const validityMs = options.validityMs ?? DEFAULT_VALIDITY_MS;
  if (!Number.isSafeInteger(observedAtUnixMs) || observedAtUnixMs < 0) {
    throw new Error("Quote observation timestamp is invalid");
  }
  if (slot < 0n || slot > MAX_U64 || validitySlots <= 0n || slot + validitySlots > MAX_U64) {
    throw new Error("Quote slot validity is invalid");
  }
  if (!Number.isSafeInteger(validityMs) || validityMs <= 0) {
    throw new Error("Quote timestamp validity is invalid");
  }
  const expiresAtUnixMs = observedAtUnixMs + validityMs;
  if (!Number.isSafeInteger(expiresAtUnixMs)) throw new Error("Quote timestamp expiry overflowed");
  return {
    sourceSlot: slot,
    expiresAtSlot: (slot + validitySlots) as Slot,
    observedAtUnixMs,
    expiresAtUnixMs,
  };
}

function bindQuote<T>(
  identity: Pick<OwnedMarketQuote<T>, "venue" | "side" | "inputMode" | "baseMint" | "quoteMint">,
  sourceSlot: Slot,
  result: T,
  options?: QuoteTimingOptions,
): OwnedMarketQuote<T> {
  return Object.freeze({ ...identity, ...quoteTiming(sourceSlot, options), result });
}

function bindLiquidityQuote<T>(
  source: PoolLiquidityQuoteSource,
  action: "deposit" | "withdraw",
  result: T,
  options?: QuoteTimingOptions,
): OwnedPoolLiquidityQuote<T> {
  return Object.freeze({
    venue: "pool",
    action,
    baseMint: source.pool.baseMint,
    quoteMint: source.pool.quoteMint,
    ...quoteTiming(source.slot, options),
    result,
  });
}

function assertCurveTradable(source: CurveQuoteSource) {
  if (source.curve.complete) throw new Error("Curve is complete and no longer tradable");
  if (source.curve.migrated) throw new Error("Curve has migrated and is no longer tradable");
}

function curveReserves(source: CurveQuoteSource) {
  return {
    virtualBase: source.curve.virtualBaseReserves,
    virtualQuote: source.curve.virtualQuoteReserves,
    realSaleBase: source.curve.realSaleBaseReserves,
    realQuote: source.curve.realQuoteReserves,
  };
}

function curveIdentity(
  source: CurveQuoteSource,
  side: "buy" | "sell",
  inputMode: "exact-base" | "exact-quote",
) {
  return {
    venue: "curve" as const,
    side,
    inputMode,
    baseMint: source.curve.baseMint,
    quoteMint: source.curve.quoteMint,
  };
}

function poolIdentity(
  source: PoolQuoteSource,
  side: "buy" | "sell",
  inputMode: "exact-base" | "exact-quote",
) {
  return {
    venue: "pool" as const,
    side,
    inputMode,
    baseMint: source.pool.baseMint,
    quoteMint: source.pool.quoteMint,
  };
}

export function createCurveBuyExactBaseOutQuote(
  source: CurveQuoteSource,
  baseAmountOut: bigint,
  maxQuoteAmountIn: bigint,
  options?: QuoteTimingOptions,
): OwnedMarketQuote<CurveBuyQuote> {
  assertCurveTradable(source);
  const parameters = source.launchConfig.parameters;
  const result = calculateCurveBuyExactBaseOut(
    curveReserves(source),
    baseAmountOut,
    maxQuoteAmountIn,
    parameters.curveTotalFeeBps,
    parameters.curveCreatorFeeBps,
  );
  return bindQuote(curveIdentity(source, "buy", "exact-base"), source.slot, result, options);
}

export function createCurveBuyExactQuoteInQuote(
  source: CurveQuoteSource,
  quoteAmountIn: bigint,
  minBaseAmountOut: bigint,
  options?: QuoteTimingOptions,
): OwnedMarketQuote<CurveBuyQuote> {
  assertCurveTradable(source);
  const parameters = source.launchConfig.parameters;
  const result = calculateCurveBuyExactQuoteIn(
    curveReserves(source),
    quoteAmountIn,
    minBaseAmountOut,
    parameters.curveTotalFeeBps,
    parameters.curveCreatorFeeBps,
  );
  return bindQuote(curveIdentity(source, "buy", "exact-quote"), source.slot, result, options);
}

export function createCurveSellExactBaseInQuote(
  source: CurveQuoteSource,
  baseAmountIn: bigint,
  minQuoteAmountOut: bigint,
  options?: QuoteTimingOptions,
): OwnedMarketQuote<CurveSellQuote> {
  assertCurveTradable(source);
  const parameters = source.launchConfig.parameters;
  const result = calculateCurveSellExactBaseIn(
    curveReserves(source),
    baseAmountIn,
    minQuoteAmountOut,
    parameters.curveTotalFeeBps,
    parameters.curveCreatorFeeBps,
  );
  return bindQuote(curveIdentity(source, "sell", "exact-base"), source.slot, result, options);
}

export function createPoolBuyExactBaseOutQuote(
  source: PoolQuoteSource,
  baseAmountOut: bigint,
  maxQuoteAmountIn: bigint,
  options?: QuoteTimingOptions,
): OwnedMarketQuote<AmmBuyQuote> {
  const fees = source.pool.fees;
  const result = calculateAmmBuyExactBaseOut(
    { base: source.pool.baseReserves, quote: source.pool.quoteReserves },
    baseAmountOut,
    maxQuoteAmountIn,
    fees.reinvestFeeBps,
    fees.protocolFeeBps,
    fees.creatorFeeBps,
  );
  return bindQuote(poolIdentity(source, "buy", "exact-base"), source.slot, result, options);
}

export function createPoolBuyExactQuoteInQuote(
  source: PoolQuoteSource,
  quoteAmountIn: bigint,
  minBaseAmountOut: bigint,
  options?: QuoteTimingOptions,
): OwnedMarketQuote<AmmBuyQuote> {
  const fees = source.pool.fees;
  const result = calculateAmmBuyExactQuoteIn(
    { base: source.pool.baseReserves, quote: source.pool.quoteReserves },
    quoteAmountIn,
    minBaseAmountOut,
    fees.reinvestFeeBps,
    fees.protocolFeeBps,
    fees.creatorFeeBps,
  );
  return bindQuote(poolIdentity(source, "buy", "exact-quote"), source.slot, result, options);
}

export function createPoolSellExactBaseInQuote(
  source: PoolQuoteSource,
  baseAmountIn: bigint,
  minQuoteAmountOut: bigint,
  options?: QuoteTimingOptions,
): OwnedMarketQuote<AmmSellQuote> {
  const fees = source.pool.fees;
  const result = calculateAmmSellExactBaseIn(
    { base: source.pool.baseReserves, quote: source.pool.quoteReserves },
    baseAmountIn,
    minQuoteAmountOut,
    fees.reinvestFeeBps,
    fees.protocolFeeBps,
    fees.creatorFeeBps,
  );
  return bindQuote(poolIdentity(source, "sell", "exact-base"), source.slot, result, options);
}

export function createPoolDepositLiquidityQuote(
  source: PoolLiquidityQuoteSource,
  lpSharesOut: bigint,
  maxBaseAmountIn: bigint,
  maxQuoteAmountIn: bigint,
  options?: QuoteTimingOptions,
): OwnedPoolLiquidityQuote<AmmDepositQuote> {
  const result = calculateAmmDepositExactShares(
    { base: source.pool.baseReserves, quote: source.pool.quoteReserves },
    source.pool.totalEconomicShares,
    lpSharesOut,
    maxBaseAmountIn,
    maxQuoteAmountIn,
  );
  return bindLiquidityQuote(source, "deposit", result, options);
}

export function createPoolWithdrawLiquidityQuote(
  source: PoolLiquidityQuoteSource,
  lpSharesIn: bigint,
  minBaseAmountOut: bigint,
  minQuoteAmountOut: bigint,
  options?: QuoteTimingOptions,
): OwnedPoolLiquidityQuote<AmmWithdrawQuote> {
  const result = calculateAmmWithdrawExactShares(
    { base: source.pool.baseReserves, quote: source.pool.quoteReserves },
    source.pool.totalEconomicShares,
    source.pool.permanentlyLockedShares,
    lpSharesIn,
    minBaseAmountOut,
    minQuoteAmountOut,
  );
  return bindLiquidityQuote(source, "withdraw", result, options);
}

export function assertOwnedMarketQuoteFresh(
  quote: OwnedMarketQuote<unknown> | OwnedPoolLiquidityQuote<unknown>,
  currentSlot: Slot,
  currentUnixMs = Date.now(),
) {
  if (!Number.isSafeInteger(currentUnixMs) || currentUnixMs < 0) {
    throw new Error("Current quote timestamp is invalid");
  }
  if (currentSlot < 0n || currentSlot > MAX_U64) {
    throw new Error("Current quote slot is invalid");
  }
  if (currentSlot >= quote.expiresAtSlot || currentUnixMs >= quote.expiresAtUnixMs) {
    throw new Error("Owned market quote has expired");
  }
  if (currentSlot < quote.sourceSlot || currentUnixMs < quote.observedAtUnixMs) {
    throw new Error("Owned market quote freshness context moved backwards");
  }
}

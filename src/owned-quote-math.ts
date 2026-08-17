const BASIS_POINTS_DENOMINATOR = 10_000n;
const MAX_U64 = (1n << 64n) - 1n;

export type OwnedQuoteMathErrorCode =
  | "zero_amount"
  | "invalid_reserves"
  | "invalid_fee"
  | "insufficient_base_liquidity"
  | "insufficient_quote_liquidity"
  | "slippage_exceeded"
  | "zero_output"
  | "invalid_share_state"
  | "share_limit_exceeded"
  | "locked_share_violation"
  | "overflow";

export class OwnedQuoteMathError extends Error {
  constructor(readonly code: OwnedQuoteMathErrorCode) {
    super(code);
    this.name = "OwnedQuoteMathError";
  }
}

export type CurveReserves = Readonly<{
  virtualBase: bigint;
  virtualQuote: bigint;
  realSaleBase: bigint;
  realQuote: bigint;
}>;

export type AmmReserves = Readonly<{ base: bigint; quote: bigint }>;

export type CurveFeeBreakdown = Readonly<{
  total: bigint;
  creator: bigint;
  protocol: bigint;
}>;

export type AmmFeeBreakdown = CurveFeeBreakdown & Readonly<{ reinvest: bigint }>;

export type CurveBuyQuote = Readonly<{
  baseAmountOut: bigint;
  grossQuoteAmountIn: bigint;
  netQuoteAmountIn: bigint;
  fees: CurveFeeBreakdown;
  nextReserves: CurveReserves;
}>;

export type CurveSellQuote = Readonly<{
  baseAmountIn: bigint;
  grossQuoteAmountOut: bigint;
  userQuoteAmountOut: bigint;
  fees: CurveFeeBreakdown;
  nextReserves: CurveReserves;
}>;

export type AmmBuyQuote = Readonly<{
  baseAmountOut: bigint;
  grossQuoteAmountIn: bigint;
  pricingQuoteAmountIn: bigint;
  fees: AmmFeeBreakdown;
  nextReserves: AmmReserves;
}>;

export type AmmSellQuote = Readonly<{
  baseAmountIn: bigint;
  grossQuoteAmountOut: bigint;
  userQuoteAmountOut: bigint;
  fees: AmmFeeBreakdown;
  nextReserves: AmmReserves;
}>;

export type AmmDepositQuote = Readonly<{
  lpSharesOut: bigint;
  baseAmountIn: bigint;
  quoteAmountIn: bigint;
  nextReserves: AmmReserves;
  nextTotalEconomicShares: bigint;
}>;

export type AmmWithdrawQuote = Readonly<{
  lpSharesIn: bigint;
  baseAmountOut: bigint;
  quoteAmountOut: bigint;
  nextReserves: AmmReserves;
  nextTotalEconomicShares: bigint;
}>;

function fail(code: OwnedQuoteMathErrorCode): never {
  throw new OwnedQuoteMathError(code);
}

function u64(value: bigint) {
  if (value < 0n || value > MAX_U64) fail("overflow");
  return value;
}

function addU64(left: bigint, right: bigint) {
  return u64(left + right);
}

function subU64(left: bigint, right: bigint) {
  if (right > left) fail("overflow");
  return left - right;
}

function feeBps(value: number) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) fail("invalid_fee");
  return BigInt(value);
}

function ceilDiv(numerator: bigint, denominator: bigint) {
  if (denominator === 0n) fail("invalid_reserves");
  return numerator / denominator + (numerator % denominator === 0n ? 0n : 1n);
}

function integerSqrt(value: bigint) {
  if (value < 0n) fail("overflow");
  if (value < 2n) return value;
  let lower = 1n;
  let upper = 1n << BigInt(Math.ceil(value.toString(2).length / 2));
  while (lower + 1n < upper) {
    const middle = lower + (upper - lower) / 2n;
    if (middle <= value / middle) lower = middle;
    else upper = middle;
  }
  return lower;
}

function checkedCurveReserves(reserves: CurveReserves) {
  u64(reserves.virtualBase);
  u64(reserves.virtualQuote);
  u64(reserves.realSaleBase);
  u64(reserves.realQuote);
  if (reserves.virtualBase === 0n || reserves.virtualQuote === 0n) fail("invalid_reserves");
}

function checkedAmmReserves(reserves: AmmReserves) {
  u64(reserves.base);
  u64(reserves.quote);
  if (reserves.base === 0n || reserves.quote === 0n) fail("invalid_reserves");
}

export function calculateInitialLiquidityShares(reserves: AmmReserves) {
  checkedAmmReserves(reserves);
  const shares = u64(integerSqrt(reserves.base * reserves.quote));
  if (shares === 0n) fail("zero_output");
  return shares;
}

export function calculateAmmDepositExactShares(
  reserves: AmmReserves,
  totalEconomicSharesValue: bigint,
  lpSharesOutValue: bigint,
  maxBaseAmountInValue: bigint,
  maxQuoteAmountInValue: bigint,
): AmmDepositQuote {
  checkedAmmReserves(reserves);
  const totalEconomicShares = u64(totalEconomicSharesValue);
  const lpSharesOut = u64(lpSharesOutValue);
  const maxBaseAmountIn = u64(maxBaseAmountInValue);
  const maxQuoteAmountIn = u64(maxQuoteAmountInValue);
  if (totalEconomicShares === 0n) fail("invalid_share_state");
  if (lpSharesOut === 0n) fail("zero_amount");
  const baseAmountIn = u64(ceilDiv(lpSharesOut * reserves.base, totalEconomicShares));
  const quoteAmountIn = u64(ceilDiv(lpSharesOut * reserves.quote, totalEconomicShares));
  if (baseAmountIn === 0n || quoteAmountIn === 0n) fail("zero_output");
  if (baseAmountIn > maxBaseAmountIn || quoteAmountIn > maxQuoteAmountIn) {
    fail("share_limit_exceeded");
  }
  return {
    lpSharesOut,
    baseAmountIn,
    quoteAmountIn,
    nextReserves: {
      base: addU64(reserves.base, baseAmountIn),
      quote: addU64(reserves.quote, quoteAmountIn),
    },
    nextTotalEconomicShares: addU64(totalEconomicShares, lpSharesOut),
  };
}

export function calculateAmmWithdrawExactShares(
  reserves: AmmReserves,
  totalEconomicSharesValue: bigint,
  permanentlyLockedSharesValue: bigint,
  lpSharesInValue: bigint,
  minBaseAmountOutValue: bigint,
  minQuoteAmountOutValue: bigint,
): AmmWithdrawQuote {
  checkedAmmReserves(reserves);
  const totalEconomicShares = u64(totalEconomicSharesValue);
  const permanentlyLockedShares = u64(permanentlyLockedSharesValue);
  const lpSharesIn = u64(lpSharesInValue);
  const minBaseAmountOut = u64(minBaseAmountOutValue);
  const minQuoteAmountOut = u64(minQuoteAmountOutValue);
  if (
    totalEconomicShares === 0n ||
    permanentlyLockedShares === 0n ||
    permanentlyLockedShares > totalEconomicShares
  ) fail("invalid_share_state");
  if (lpSharesIn === 0n) fail("zero_amount");
  if (lpSharesIn > totalEconomicShares) fail("locked_share_violation");
  const nextTotalEconomicShares = totalEconomicShares - lpSharesIn;
  if (nextTotalEconomicShares < permanentlyLockedShares) fail("locked_share_violation");
  const baseAmountOut = u64((lpSharesIn * reserves.base) / totalEconomicShares);
  const quoteAmountOut = u64((lpSharesIn * reserves.quote) / totalEconomicShares);
  if (baseAmountOut === 0n || quoteAmountOut === 0n) fail("zero_output");
  if (baseAmountOut < minBaseAmountOut || quoteAmountOut < minQuoteAmountOut) {
    fail("slippage_exceeded");
  }
  return {
    lpSharesIn,
    baseAmountOut,
    quoteAmountOut,
    nextReserves: {
      base: subU64(reserves.base, baseAmountOut),
      quote: subU64(reserves.quote, quoteAmountOut),
    },
    nextTotalEconomicShares,
  };
}

function curveFees(totalFeeBpsValue: number, creatorFeeBpsValue: number) {
  const total = feeBps(totalFeeBpsValue);
  const creator = feeBps(creatorFeeBpsValue);
  if (total >= BASIS_POINTS_DENOMINATOR || creator > total) fail("invalid_fee");
  return { total, creator };
}

function splitCurveFee(gross: bigint, total: bigint, creatorBps: bigint): CurveFeeBreakdown {
  const creator = (gross * creatorBps) / BASIS_POINTS_DENOMINATOR;
  const boundedCreator = creator < total ? creator : total;
  return { total, creator: boundedCreator, protocol: subU64(total, boundedCreator) };
}

function ammFees(reinvestValue: number, protocolValue: number, creatorValue: number) {
  const reinvest = feeBps(reinvestValue);
  const protocol = feeBps(protocolValue);
  const creator = feeBps(creatorValue);
  const total = reinvest + protocol + creator;
  if (total > 0xffffn) fail("overflow");
  if (total >= BASIS_POINTS_DENOMINATOR) fail("invalid_fee");
  return { total, protocol, creator };
}

function splitAmmFee(
  gross: bigint,
  total: bigint,
  protocolBps: bigint,
  creatorBps: bigint,
): AmmFeeBreakdown {
  const creator = ((gross * creatorBps) / BASIS_POINTS_DENOMINATOR) < total
    ? (gross * creatorBps) / BASIS_POINTS_DENOMINATOR
    : total;
  const afterCreator = subU64(total, creator);
  const protocolCandidate = (gross * protocolBps) / BASIS_POINTS_DENOMINATOR;
  const protocol = protocolCandidate < afterCreator ? protocolCandidate : afterCreator;
  return {
    total,
    reinvest: subU64(afterCreator, protocol),
    creator,
    protocol,
  };
}

export function calculateCurveBuyExactBaseOut(
  reserves: CurveReserves,
  baseAmountOutValue: bigint,
  maxQuoteAmountInValue: bigint,
  totalFeeBpsValue: number,
  creatorFeeBpsValue: number,
): CurveBuyQuote {
  const feesConfig = curveFees(totalFeeBpsValue, creatorFeeBpsValue);
  checkedCurveReserves(reserves);
  const baseAmountOut = u64(baseAmountOutValue);
  const maxQuoteAmountIn = u64(maxQuoteAmountInValue);
  if (baseAmountOut === 0n) fail("zero_amount");
  if (baseAmountOut > reserves.realSaleBase || baseAmountOut >= reserves.virtualBase) {
    fail("insufficient_base_liquidity");
  }
  const nextVirtualBase = subU64(reserves.virtualBase, baseAmountOut);
  const netQuoteAmountIn = u64(
    ceilDiv(reserves.virtualQuote * baseAmountOut, nextVirtualBase),
  );
  const grossQuoteAmountIn = u64(
    ceilDiv(
      netQuoteAmountIn * BASIS_POINTS_DENOMINATOR,
      BASIS_POINTS_DENOMINATOR - feesConfig.total,
    ),
  );
  if (grossQuoteAmountIn > maxQuoteAmountIn) fail("slippage_exceeded");
  const totalFee = subU64(grossQuoteAmountIn, netQuoteAmountIn);
  return {
    baseAmountOut,
    grossQuoteAmountIn,
    netQuoteAmountIn,
    fees: splitCurveFee(grossQuoteAmountIn, totalFee, feesConfig.creator),
    nextReserves: {
      virtualBase: nextVirtualBase,
      virtualQuote: addU64(reserves.virtualQuote, netQuoteAmountIn),
      realSaleBase: subU64(reserves.realSaleBase, baseAmountOut),
      realQuote: addU64(reserves.realQuote, netQuoteAmountIn),
    },
  };
}

export function calculateCurveBuyExactQuoteIn(
  reserves: CurveReserves,
  grossQuoteAmountInValue: bigint,
  minBaseAmountOutValue: bigint,
  totalFeeBpsValue: number,
  creatorFeeBpsValue: number,
): CurveBuyQuote {
  const feesConfig = curveFees(totalFeeBpsValue, creatorFeeBpsValue);
  checkedCurveReserves(reserves);
  const grossQuoteAmountIn = u64(grossQuoteAmountInValue);
  const minBaseAmountOut = u64(minBaseAmountOutValue);
  if (grossQuoteAmountIn === 0n) fail("zero_amount");
  const totalFee = u64(
    ceilDiv(grossQuoteAmountIn * feesConfig.total, BASIS_POINTS_DENOMINATOR),
  );
  const netQuoteAmountIn = subU64(grossQuoteAmountIn, totalFee);
  if (netQuoteAmountIn === 0n) fail("zero_output");
  const nextVirtualQuote = addU64(reserves.virtualQuote, netQuoteAmountIn);
  const baseAmountOut = u64(
    (reserves.virtualBase * netQuoteAmountIn) / nextVirtualQuote,
  );
  if (baseAmountOut === 0n) fail("zero_output");
  if (baseAmountOut > reserves.realSaleBase || baseAmountOut >= reserves.virtualBase) {
    fail("insufficient_base_liquidity");
  }
  if (baseAmountOut < minBaseAmountOut) fail("slippage_exceeded");
  return {
    baseAmountOut,
    grossQuoteAmountIn,
    netQuoteAmountIn,
    fees: splitCurveFee(grossQuoteAmountIn, totalFee, feesConfig.creator),
    nextReserves: {
      virtualBase: subU64(reserves.virtualBase, baseAmountOut),
      virtualQuote: nextVirtualQuote,
      realSaleBase: subU64(reserves.realSaleBase, baseAmountOut),
      realQuote: addU64(reserves.realQuote, netQuoteAmountIn),
    },
  };
}

export function calculateCurveSellExactBaseIn(
  reserves: CurveReserves,
  baseAmountInValue: bigint,
  minQuoteAmountOutValue: bigint,
  totalFeeBpsValue: number,
  creatorFeeBpsValue: number,
): CurveSellQuote {
  const feesConfig = curveFees(totalFeeBpsValue, creatorFeeBpsValue);
  checkedCurveReserves(reserves);
  const baseAmountIn = u64(baseAmountInValue);
  const minQuoteAmountOut = u64(minQuoteAmountOutValue);
  if (baseAmountIn === 0n) fail("zero_amount");
  const nextVirtualBase = addU64(reserves.virtualBase, baseAmountIn);
  const grossQuoteAmountOut = u64(
    (reserves.virtualQuote * baseAmountIn) / nextVirtualBase,
  );
  if (grossQuoteAmountOut === 0n) fail("zero_output");
  if (grossQuoteAmountOut > reserves.realQuote) fail("insufficient_quote_liquidity");
  const totalFee = u64(
    ceilDiv(grossQuoteAmountOut * feesConfig.total, BASIS_POINTS_DENOMINATOR),
  );
  const userQuoteAmountOut = subU64(grossQuoteAmountOut, totalFee);
  if (userQuoteAmountOut === 0n) fail("zero_output");
  if (userQuoteAmountOut < minQuoteAmountOut) fail("slippage_exceeded");
  return {
    baseAmountIn,
    grossQuoteAmountOut,
    userQuoteAmountOut,
    fees: splitCurveFee(grossQuoteAmountOut, totalFee, feesConfig.creator),
    nextReserves: {
      virtualBase: nextVirtualBase,
      virtualQuote: subU64(reserves.virtualQuote, grossQuoteAmountOut),
      realSaleBase: addU64(reserves.realSaleBase, baseAmountIn),
      realQuote: subU64(reserves.realQuote, grossQuoteAmountOut),
    },
  };
}

export function calculateAmmBuyExactBaseOut(
  reserves: AmmReserves,
  baseAmountOutValue: bigint,
  maxQuoteAmountInValue: bigint,
  reinvestFeeBpsValue: number,
  protocolFeeBpsValue: number,
  creatorFeeBpsValue: number,
): AmmBuyQuote {
  const feesConfig = ammFees(reinvestFeeBpsValue, protocolFeeBpsValue, creatorFeeBpsValue);
  checkedAmmReserves(reserves);
  const baseAmountOut = u64(baseAmountOutValue);
  const maxQuoteAmountIn = u64(maxQuoteAmountInValue);
  if (baseAmountOut === 0n) fail("zero_amount");
  if (baseAmountOut >= reserves.base) fail("insufficient_base_liquidity");
  const nextBase = subU64(reserves.base, baseAmountOut);
  const pricingQuoteAmountIn = u64(ceilDiv(reserves.quote * baseAmountOut, nextBase));
  const grossQuoteAmountIn = u64(
    ceilDiv(
      pricingQuoteAmountIn * BASIS_POINTS_DENOMINATOR,
      BASIS_POINTS_DENOMINATOR - feesConfig.total,
    ),
  );
  if (grossQuoteAmountIn > maxQuoteAmountIn) fail("slippage_exceeded");
  const fees = splitAmmFee(
    grossQuoteAmountIn,
    subU64(grossQuoteAmountIn, pricingQuoteAmountIn),
    feesConfig.protocol,
    feesConfig.creator,
  );
  return {
    baseAmountOut,
    grossQuoteAmountIn,
    pricingQuoteAmountIn,
    fees,
    nextReserves: {
      base: nextBase,
      quote: addU64(addU64(reserves.quote, pricingQuoteAmountIn), fees.reinvest),
    },
  };
}

export function calculateAmmBuyExactQuoteIn(
  reserves: AmmReserves,
  grossQuoteAmountInValue: bigint,
  minBaseAmountOutValue: bigint,
  reinvestFeeBpsValue: number,
  protocolFeeBpsValue: number,
  creatorFeeBpsValue: number,
): AmmBuyQuote {
  const feesConfig = ammFees(reinvestFeeBpsValue, protocolFeeBpsValue, creatorFeeBpsValue);
  checkedAmmReserves(reserves);
  const grossQuoteAmountIn = u64(grossQuoteAmountInValue);
  const minBaseAmountOut = u64(minBaseAmountOutValue);
  if (grossQuoteAmountIn === 0n) fail("zero_amount");
  const totalFee = u64(
    ceilDiv(grossQuoteAmountIn * feesConfig.total, BASIS_POINTS_DENOMINATOR),
  );
  const pricingQuoteAmountIn = subU64(grossQuoteAmountIn, totalFee);
  if (pricingQuoteAmountIn === 0n) fail("zero_output");
  const pricingNextQuote = addU64(reserves.quote, pricingQuoteAmountIn);
  const baseAmountOut = u64(
    (reserves.base * pricingQuoteAmountIn) / pricingNextQuote,
  );
  if (baseAmountOut === 0n) fail("zero_output");
  if (baseAmountOut >= reserves.base) fail("insufficient_base_liquidity");
  if (baseAmountOut < minBaseAmountOut) fail("slippage_exceeded");
  const fees = splitAmmFee(
    grossQuoteAmountIn,
    totalFee,
    feesConfig.protocol,
    feesConfig.creator,
  );
  return {
    baseAmountOut,
    grossQuoteAmountIn,
    pricingQuoteAmountIn,
    fees,
    nextReserves: {
      base: subU64(reserves.base, baseAmountOut),
      quote: addU64(pricingNextQuote, fees.reinvest),
    },
  };
}

export function calculateAmmSellExactBaseIn(
  reserves: AmmReserves,
  baseAmountInValue: bigint,
  minQuoteAmountOutValue: bigint,
  reinvestFeeBpsValue: number,
  protocolFeeBpsValue: number,
  creatorFeeBpsValue: number,
): AmmSellQuote {
  const feesConfig = ammFees(reinvestFeeBpsValue, protocolFeeBpsValue, creatorFeeBpsValue);
  checkedAmmReserves(reserves);
  const baseAmountIn = u64(baseAmountInValue);
  const minQuoteAmountOut = u64(minQuoteAmountOutValue);
  if (baseAmountIn === 0n) fail("zero_amount");
  const nextBase = addU64(reserves.base, baseAmountIn);
  const grossQuoteAmountOut = u64((reserves.quote * baseAmountIn) / nextBase);
  if (grossQuoteAmountOut === 0n) fail("zero_output");
  if (grossQuoteAmountOut >= reserves.quote) fail("insufficient_quote_liquidity");
  const totalFee = u64(
    ceilDiv(grossQuoteAmountOut * feesConfig.total, BASIS_POINTS_DENOMINATOR),
  );
  const userQuoteAmountOut = subU64(grossQuoteAmountOut, totalFee);
  if (userQuoteAmountOut === 0n) fail("zero_output");
  if (userQuoteAmountOut < minQuoteAmountOut) fail("slippage_exceeded");
  const fees = splitAmmFee(
    grossQuoteAmountOut,
    totalFee,
    feesConfig.protocol,
    feesConfig.creator,
  );
  return {
    baseAmountIn,
    grossQuoteAmountOut,
    userQuoteAmountOut,
    fees,
    nextReserves: {
      base: nextBase,
      quote: addU64(subU64(reserves.quote, grossQuoteAmountOut), fees.reinvest),
    },
  };
}

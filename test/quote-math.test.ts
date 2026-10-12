import assert from "node:assert/strict";
import test from "node:test";

import {
  OwnedQuoteMathError,
  calculateAmmBuyExactBaseOut,
  calculateAmmBuyExactQuoteIn,
  calculateAmmDepositExactShares,
  calculateAmmSellExactBaseIn,
  calculateAmmWithdrawExactShares,
  calculateCurveBuyExactBaseOut,
  calculateCurveBuyExactQuoteIn,
  calculateCurveSellExactBaseIn,
  calculateInitialLiquidityShares,
  type OwnedQuoteMathErrorCode,
} from "../src/owned-quote-math.js";

const MAX_U64 = (1n << 64n) - 1n;
const pool = { base: 1_000n, quote: 100n };
const curve = { virtualBase: 1_000n, virtualQuote: 100n, realSaleBase: 800n, realQuote: 100n };
const code = (expected: OwnedQuoteMathErrorCode) => (error: unknown) => error instanceof OwnedQuoteMathError && error.code === expected;

test("integer liquidity shares are the floor of the geometric mean including u64 boundaries", () => {
  for (const [base, quote] of [[1n, 1n], [2n, 2n], [2n, 3n], [MAX_U64, MAX_U64], [MAX_U64, 1n]] as const) {
    const shares = calculateInitialLiquidityShares({ base, quote });
    const product = base * quote;
    assert.ok(shares * shares <= product);
    assert.ok((shares + 1n) * (shares + 1n) > product);
  }
});

test("all swap directions conserve fees and nondecreasing constant product over independent sampled reserves", () => {
  for (let index = 1; index <= 300; index += 1) {
    const base = 100_000n + BigInt(index * 19);
    const quote = 90_000n + BigInt(index * 31);
    const amount = BigInt(100 + index * 7);
    const before = { base, quote };
    const curveBefore = { virtualBase: base, virtualQuote: quote, realSaleBase: base / 2n, realQuote: quote };
    for (const result of [
      calculateAmmBuyExactBaseOut(before, amount, MAX_U64, 20, 5, 5),
      calculateAmmBuyExactQuoteIn(before, amount, 0n, 20, 5, 5),
    ]) {
      assert.equal(result.grossQuoteAmountIn, result.pricingQuoteAmountIn + result.fees.total);
      assert.equal(result.fees.total, result.fees.reinvest + result.fees.creator + result.fees.protocol);
      assert.equal(result.nextReserves.base, base - result.baseAmountOut);
      assert.equal(result.nextReserves.quote, quote + result.grossQuoteAmountIn - result.fees.creator - result.fees.protocol);
      assert.ok(result.nextReserves.base * result.nextReserves.quote >= base * quote);
    }
    const sell = calculateAmmSellExactBaseIn(before, amount, 0n, 20, 5, 5);
    assert.equal(sell.grossQuoteAmountOut, sell.userQuoteAmountOut + sell.fees.total);
    assert.equal(sell.fees.total, sell.fees.reinvest + sell.fees.creator + sell.fees.protocol);
    assert.equal(sell.nextReserves.quote, quote - sell.userQuoteAmountOut - sell.fees.creator - sell.fees.protocol);
    assert.ok(sell.nextReserves.base * sell.nextReserves.quote >= base * quote);
    for (const result of [
      calculateCurveBuyExactBaseOut(curveBefore, amount, MAX_U64, 125, 30),
      calculateCurveBuyExactQuoteIn(curveBefore, amount, 0n, 125, 30),
    ]) {
      assert.equal(result.grossQuoteAmountIn, result.netQuoteAmountIn + result.fees.total);
      assert.equal(result.fees.total, result.fees.creator + result.fees.protocol);
      assert.equal(result.nextReserves.realSaleBase, curveBefore.realSaleBase - result.baseAmountOut);
      assert.equal(result.nextReserves.realQuote, curveBefore.realQuote + result.netQuoteAmountIn);
      assert.ok(result.nextReserves.virtualBase * result.nextReserves.virtualQuote >= base * quote);
    }
    const curveSell = calculateCurveSellExactBaseIn(curveBefore, amount, 0n, 125, 30);
    assert.equal(curveSell.grossQuoteAmountOut, curveSell.userQuoteAmountOut + curveSell.fees.total);
    assert.equal(curveSell.fees.total, curveSell.fees.creator + curveSell.fees.protocol);
    assert.equal(curveSell.nextReserves.realSaleBase, curveBefore.realSaleBase + amount);
    assert.ok(curveSell.nextReserves.virtualBase * curveSell.nextReserves.virtualQuote >= base * quote);
  }
});

test("deposit ceilings and withdrawal floors preserve existing providers and locked shares", () => {
  for (let index = 1; index <= 200; index += 1) {
    const reserves = { base: BigInt(index * 97 + 1_000), quote: BigInt(index * 43 + 2_000) };
    const total = BigInt(index + 500);
    const amount = BigInt(index);
    const deposit = calculateAmmDepositExactShares(reserves, total, amount, MAX_U64, MAX_U64);
    assert.ok(deposit.baseAmountIn * total >= amount * reserves.base);
    assert.ok((deposit.baseAmountIn - 1n) * total < amount * reserves.base);
    assert.ok(deposit.quoteAmountIn * total >= amount * reserves.quote);
    assert.ok((deposit.quoteAmountIn - 1n) * total < amount * reserves.quote);
    const withdraw = calculateAmmWithdrawExactShares(reserves, total, 100n, amount, 0n, 0n);
    assert.ok(withdraw.baseAmountOut * total <= amount * reserves.base);
    assert.ok((withdraw.baseAmountOut + 1n) * total > amount * reserves.base);
    assert.ok(withdraw.quoteAmountOut * total <= amount * reserves.quote);
    assert.ok((withdraw.quoteAmountOut + 1n) * total > amount * reserves.quote);
    assert.ok(withdraw.nextTotalEconomicShares >= 100n);
  }
});

test("rejects dust, invalid fee bounds, depleted liquidity and checked overflow", () => {
  assert.throws(() => calculateAmmBuyExactQuoteIn(pool, 1n, 0n, 20, 5, 5), code("zero_output"));
  assert.throws(() => calculateCurveBuyExactQuoteIn(curve, 1n, 0n, 125, 30), code("zero_output"));
  assert.throws(() => calculateAmmSellExactBaseIn(pool, 1n, 0n, 0, 0, 0), code("zero_output"));
  assert.throws(() => calculateCurveSellExactBaseIn(curve, 1n, 0n, 0, 0), code("zero_output"));
  for (const fee of [-1, 1.5, NaN, Infinity, 10_000, 65_536]) {
    assert.throws(() => calculateCurveBuyExactBaseOut(curve, 10n, MAX_U64, fee, 0), code("invalid_fee"));
    assert.throws(() => calculateAmmBuyExactBaseOut(pool, 10n, MAX_U64, fee, 0, 0), code("invalid_fee"));
  }
  assert.throws(() => calculateCurveBuyExactBaseOut(curve, 10n, MAX_U64, 10, 11), code("invalid_fee"));
  assert.throws(() => calculateAmmBuyExactBaseOut(pool, 1_000n, MAX_U64, 0, 0, 0), code("insufficient_base_liquidity"));
  assert.throws(() => calculateCurveBuyExactBaseOut(curve, 801n, MAX_U64, 0, 0), code("insufficient_base_liquidity"));
  assert.throws(() => calculateCurveSellExactBaseIn({ ...curve, realQuote: 1n }, 100n, 0n, 0, 0), code("insufficient_quote_liquidity"));
  assert.throws(() => calculateAmmSellExactBaseIn({ base: MAX_U64, quote: 1_000n }, 1n, 0n, 0, 0, 0), code("overflow"));
  assert.throws(() => calculateAmmBuyExactQuoteIn({ base: 1_000n, quote: MAX_U64 }, 10n, 0n, 0, 0, 0), code("overflow"));
  assert.throws(() => calculateInitialLiquidityShares({ base: MAX_U64 + 1n, quote: 1n }), code("overflow"));
  assert.throws(() => calculateAmmDepositExactShares(pool, 0n, 1n, MAX_U64, MAX_U64), code("invalid_share_state"));
  assert.throws(() => calculateAmmWithdrawExactShares(pool, 100n, 0n, 1n, 0n, 0n), code("invalid_share_state"));
  assert.throws(() => calculateAmmWithdrawExactShares(pool, 100n, 10n, 91n, 0n, 0n), code("locked_share_violation"));
});

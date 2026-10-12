import assert from "node:assert/strict";
import test from "node:test";

import { address, type Slot } from "@solana/kit";

import { SOL_QUOTE_MINT_ADDRESS } from "../src/addresses.js";
import {
  assertOwnedMarketQuoteFresh,
  assertOwnedMarketQuoteValidEnvelope,
  createCurveBuyExactBaseOutQuote,
  createCurveBuyExactQuoteInQuote,
  createCurveSellExactBaseInQuote,
  createPoolBuyExactBaseOutQuote,
  createPoolBuyExactQuoteInQuote,
  createPoolDepositLiquidityQuote,
  createPoolSellExactBaseInQuote,
  createPoolWithdrawLiquidityQuote,
  type CurveQuoteSource,
  type PoolLiquidityQuoteSource,
  type PoolQuoteSource,
  type QuoteTimingOptions,
} from "../src/owned-market-quotes.js";
import { OwnedQuoteMathError } from "../src/owned-quote-math.js";

const MAX_U64 = (1n << 64n) - 1n;
const BASE = address("ErogPFvGsinQukiVfqvihsdo1CVAjTV11X6aW1QTgQLb");
const curve: CurveQuoteSource = {
  slot: 50n as Slot,
  curve: {
    baseMint: BASE, quoteMint: SOL_QUOTE_MINT_ADDRESS,
    virtualBaseReserves: 1_000n, virtualQuoteReserves: 100n,
    realSaleBaseReserves: 800n, realQuoteReserves: 100n,
    complete: false, migrated: false,
  },
  launchConfig: { parameters: { curveTotalFeeBps: 0, curveCreatorFeeBps: 0 } },
};
const pool: PoolQuoteSource & PoolLiquidityQuoteSource = {
  slot: 50n as Slot,
  pool: {
    baseMint: BASE, quoteMint: SOL_QUOTE_MINT_ADDRESS,
    baseReserves: 1_000n, quoteReserves: 100n,
    fees: { reinvestFeeBps: 0, protocolFeeBps: 0, creatorFeeBps: 0 },
    totalEconomicShares: 100n, permanentlyLockedShares: 10n,
  },
};
const timing = { observedAtUnixMs: 1_000 };
const quote = () => createPoolBuyExactBaseOutQuote(pool, 10n, MAX_U64, timing);

test("all eight constructors bind identity, default timing and independent zero-fee vectors", () => {
  const marketCases = [
    [createCurveBuyExactBaseOutQuote(curve, 10n, MAX_U64, timing), "curve", "buy", "exact-base", "baseAmountOut", 10n],
    [createCurveBuyExactQuoteInQuote(curve, 10n, 0n, timing), "curve", "buy", "exact-quote", "baseAmountOut", 90n],
    [createCurveSellExactBaseInQuote(curve, 100n, 0n, timing), "curve", "sell", "exact-base", "userQuoteAmountOut", 9n],
    [createPoolBuyExactBaseOutQuote(pool, 10n, MAX_U64, timing), "pool", "buy", "exact-base", "baseAmountOut", 10n],
    [createPoolBuyExactQuoteInQuote(pool, 10n, 0n, timing), "pool", "buy", "exact-quote", "baseAmountOut", 90n],
    [createPoolSellExactBaseInQuote(pool, 100n, 0n, timing), "pool", "sell", "exact-base", "userQuoteAmountOut", 9n],
  ] as const;
  for (const [value, venue, side, mode, field, expected] of marketCases) {
    assert.equal(value.venue, venue);
    assert.equal(value.side, side);
    assert.equal(value.inputMode, mode);
    assert.equal((value.result as unknown as Record<string, unknown>)[field], expected);
    assert.equal(value.baseMint, BASE);
    assert.equal(value.quoteMint, SOL_QUOTE_MINT_ADDRESS);
    assert.equal(value.sourceSlot, 50n);
    assert.equal(value.expiresAtSlot, 200n);
    assert.equal(value.observedAtUnixMs, 1_000);
    assert.equal(value.expiresAtUnixMs, 61_000);
    assert.doesNotThrow(() => assertOwnedMarketQuoteFresh(value, 199n as Slot, 60_999));
  }
  const deposit = createPoolDepositLiquidityQuote(pool, 10n, 100n, 10n, timing);
  const withdraw = createPoolWithdrawLiquidityQuote(pool, 10n, 100n, 10n, timing);
  assert.equal(deposit.action, "deposit");
  assert.equal(withdraw.action, "withdraw");
  assert.deepEqual(deposit.result, { lpSharesOut: 10n, baseAmountIn: 100n, quoteAmountIn: 10n, nextReserves: { base: 1_100n, quote: 110n }, nextTotalEconomicShares: 110n });
  assert.deepEqual(withdraw.result, { lpSharesIn: 10n, baseAmountOut: 100n, quoteAmountOut: 10n, nextReserves: { base: 900n, quote: 90n }, nextTotalEconomicShares: 90n });
  for (const value of [deposit, withdraw]) {
    assert.equal(value.venue, "pool");
    assert.doesNotThrow(() => assertOwnedMarketQuoteFresh(value, 50n as Slot, 1_000));
  }
});

test("constructor results are deeply frozen without freezing caller snapshots", () => {
  const value = quote();
  assert.ok(Object.isFrozen(value));
  assert.ok(Object.isFrozen(value.result));
  assert.ok(Object.isFrozen(value.result.fees));
  assert.ok(Object.isFrozen(value.result.nextReserves));
  assert.throws(() => { (value.result.fees as { total: bigint }).total = 99n; }, TypeError);
  assert.ok(!Object.isFrozen(pool.pool));
  assert.ok(!Object.isFrozen(pool.pool.fees));
});

test("freshness includes expiry boundaries and rejects context moving backwards", () => {
  const value = quote();
  assert.throws(() => assertOwnedMarketQuoteFresh(value, 200n as Slot, 1_000), /expired/);
  assert.throws(() => assertOwnedMarketQuoteFresh(value, 50n as Slot, 61_000), /expired/);
  assert.throws(() => assertOwnedMarketQuoteFresh(value, 49n as Slot, 1_000), /backwards/);
  assert.throws(() => assertOwnedMarketQuoteFresh(value, 50n as Slot, 999), /backwards/);
  for (const slot of [-1n, MAX_U64 + 1n, 50, NaN, "50", null]) {
    assert.throws(() => assertOwnedMarketQuoteFresh(value, slot as Slot, 1_000), /Current quote slot/);
  }
  for (const time of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => assertOwnedMarketQuoteFresh(value, 50n as Slot, time), /Current quote timestamp/);
  }
});

test("freshness validates untrusted quote envelopes before comparing timestamps", () => {
  const value = quote();
  const invalid = (patch: Record<string, unknown>) => ({ ...value, ...patch }) as typeof value;
  for (const timestamp of [NaN, Infinity, -1, 1.5, "61000", null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => assertOwnedMarketQuoteFresh(invalid({ expiresAtUnixMs: timestamp }), 50n as Slot, 100_000), /timestamp envelope/);
    assert.throws(() => assertOwnedMarketQuoteValidEnvelope(invalid({ observedAtUnixMs: timestamp })), /timestamp envelope/);
  }
  for (const slot of [-1n, MAX_U64 + 1n, 50, NaN, "50", null]) {
    assert.throws(() => assertOwnedMarketQuoteValidEnvelope(invalid({ sourceSlot: slot })), /slot envelope/);
    assert.throws(() => assertOwnedMarketQuoteValidEnvelope(invalid({ expiresAtSlot: slot })), /slot envelope/);
  }
  assert.throws(() => assertOwnedMarketQuoteValidEnvelope(invalid({ expiresAtSlot: 50n })), /slot envelope/);
  assert.throws(() => assertOwnedMarketQuoteValidEnvelope(invalid({ expiresAtUnixMs: 1_000 })), /timestamp envelope/);
  for (const patch of [{ venue: "unknown" }, { side: "deposit" }, { inputMode: "all" }, { side: "sell", inputMode: "exact-quote" }, { baseMint: "invalid" }, { quoteMint: 0 }]) {
    assert.throws(() => assertOwnedMarketQuoteValidEnvelope(invalid(patch)), /invalid/);
  }
  assert.throws(() => assertOwnedMarketQuoteValidEnvelope(invalid({ action: "deposit" })), /ambiguous/);
  const liquidity = createPoolDepositLiquidityQuote(pool, 10n, 100n, 10n, timing);
  for (const patch of [{ action: "unknown" }, { venue: "curve" }]) {
    assert.throws(() => assertOwnedMarketQuoteValidEnvelope({ ...liquidity, ...patch } as typeof liquidity), /action is invalid/);
  }
  assert.throws(() => assertOwnedMarketQuoteValidEnvelope(null as unknown as typeof value), /envelope is invalid/);
});

test("timing construction rejects invalid values and overflows but retains explicit defaults", () => {
  const custom = createPoolBuyExactBaseOutQuote(pool, 10n, MAX_U64, { observedAtUnixMs: 0, validitySlots: 1n, validityMs: 1 });
  assert.equal(custom.expiresAtSlot, 51n);
  assert.equal(custom.expiresAtUnixMs, 1);
  for (const patch of [
    { observedAtUnixMs: NaN }, { observedAtUnixMs: -1 }, { observedAtUnixMs: Number.MAX_SAFE_INTEGER },
    { validitySlots: 0n }, { validitySlots: -1n }, { validitySlots: 1 },
    { validityMs: 0 }, { validityMs: -1 }, { validityMs: Infinity },
  ]) {
    assert.throws(() => createPoolBuyExactBaseOutQuote(pool, 10n, MAX_U64, { ...timing, ...patch } as QuoteTimingOptions), /invalid|overflowed/);
  }
  for (const slot of [-1n, MAX_U64, MAX_U64 + 1n, 50]) {
    assert.throws(() => createPoolBuyExactBaseOutQuote({ ...pool, slot: slot as Slot }, 10n, MAX_U64, timing), /slot validity/);
  }
});

test("all curve constructors reject complete and migrated markets", () => {
  for (const state of [{ complete: true }, { migrated: true }]) {
    const source = { ...curve, curve: { ...curve.curve, ...state } };
    for (const run of [
      () => createCurveBuyExactBaseOutQuote(source, 10n, MAX_U64, timing),
      () => createCurveBuyExactQuoteInQuote(source, 10n, 0n, timing),
      () => createCurveSellExactBaseInQuote(source, 100n, 0n, timing),
    ]) assert.throws(run, /no longer tradable/);
  }
});

test("fee configuration and caller slippage bounds flow into quote arithmetic", () => {
  const curveWithFees = { ...curve, launchConfig: { parameters: { curveTotalFeeBps: 125, curveCreatorFeeBps: 30 } } };
  const poolWithFees = { ...pool, pool: { ...pool.pool, fees: { reinvestFeeBps: 20, protocolFeeBps: 5, creatorFeeBps: 5 } } };
  const curveBuy = createCurveBuyExactBaseOutQuote(curveWithFees, 100n, MAX_U64, timing);
  const poolBuy = createPoolBuyExactBaseOutQuote(poolWithFees, 100n, MAX_U64, timing);
  assert.equal(curveBuy.result.fees.total, 1n);
  assert.equal(poolBuy.result.fees.total, 1n);
  const error = (value: unknown) => value instanceof OwnedQuoteMathError && value.code === "slippage_exceeded";
  assert.doesNotThrow(() => createCurveBuyExactBaseOutQuote(curveWithFees, 100n, curveBuy.result.grossQuoteAmountIn, timing));
  assert.throws(() => createCurveBuyExactBaseOutQuote(curveWithFees, 100n, curveBuy.result.grossQuoteAmountIn - 1n, timing), error);
  assert.throws(() => createPoolBuyExactBaseOutQuote(poolWithFees, 100n, poolBuy.result.grossQuoteAmountIn - 1n, timing), error);
  assert.throws(() => createCurveBuyExactQuoteInQuote(curveWithFees, 10n, 1_000n, timing), error);
  assert.throws(() => createPoolBuyExactQuoteInQuote(poolWithFees, 10n, 1_000n, timing), error);
  assert.throws(() => createCurveSellExactBaseInQuote(curveWithFees, 100n, 100n, timing), error);
  assert.throws(() => createPoolSellExactBaseInQuote(poolWithFees, 100n, 100n, timing), error);
});

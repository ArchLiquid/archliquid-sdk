import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateMaximumAmountIn,
  calculateMinimumAmountOut,
  formatOwnedAmount,
  parseOwnedAmount,
} from "../src/amounts.js";
import { OwnedSdkError } from "../src/errors.js";

const MAX_U64 = (1n << 64n) - 1n;
const invalidInput = (error: unknown) => error instanceof OwnedSdkError && error.code === "invalid_input";

test("amount conversion uses exact strings, omits fractional zeroes and roundtrips every supported decimal count", () => {
  assert.equal(parseOwnedAmount("1.234567891", 9), 1_234_567_891n);
  assert.equal(parseOwnedAmount("18446744073709551615", 0), MAX_U64);
  assert.equal(parseOwnedAmount("18.446744073709551615", 18), MAX_U64);
  assert.equal(formatOwnedAmount(1_230_000n, 6), "1.23");
  assert.equal(formatOwnedAmount(1n, 9), "0.000000001");
  for (let decimals = 0; decimals <= 255; decimals += 1) {
    for (const amount of [0n, 1n, 10n, 1_234_567_891n, MAX_U64]) {
      assert.equal(parseOwnedAmount(formatOwnedAmount(amount, decimals), decimals), amount);
    }
  }
});

test("amount parser rejects rounding, exponents, ambiguous notation and u64 overflow", () => {
  for (const value of ["", " ", "1 ", " 1", "+1", "-1", "01", ".1", "1.", "1e3", "1,000", "NaN", "Infinity", "0x10", "1_000", "1.0000001", "1.2.3"]) {
    assert.throws(() => parseOwnedAmount(value, 6), invalidInput);
  }
  assert.throws(() => parseOwnedAmount("1.0", 0), invalidInput);
  assert.throws(() => parseOwnedAmount("18446744073709551616", 0), invalidInput);
  assert.throws(() => parseOwnedAmount("1".repeat(278), 0), invalidInput);
  for (const value of [1, 1n, null, undefined]) assert.throws(() => parseOwnedAmount(value as unknown as string, 9), invalidInput);
  for (const decimals of [-1, 256, 0.5, NaN, Infinity, "9", null]) {
    assert.throws(() => parseOwnedAmount("0", decimals as number), invalidInput);
    assert.throws(() => formatOwnedAmount(0n, decimals as number), invalidInput);
  }
});

test("slippage floors and ceilings obey exact independent inequalities", () => {
  assert.equal(calculateMinimumAmountOut(101n, 1), 100n);
  assert.equal(calculateMaximumAmountIn(101n, 1), 102n);
  assert.equal(calculateMinimumAmountOut(100n, 10_000), 0n);
  assert.equal(calculateMaximumAmountIn(100n, 10_000), 200n);
  assert.equal(calculateMaximumAmountIn(MAX_U64, 0), MAX_U64);
  for (const bps of [0, 1, 50, 100, 999, 10_000]) {
    for (let index = 0; index < 200; index += 1) {
      const amount = BigInt(index * 97);
      const minimum = calculateMinimumAmountOut(amount, bps);
      const maximum = calculateMaximumAmountIn(amount, bps);
      const floorTarget = amount * BigInt(10_000 - bps);
      const ceilTarget = amount * BigInt(10_000 + bps);
      assert.ok(minimum * 10_000n <= floorTarget);
      assert.ok((minimum + 1n) * 10_000n > floorTarget);
      assert.ok(maximum * 10_000n >= ceilTarget);
      assert.ok(maximum === 0n || (maximum - 1n) * 10_000n < ceilTarget);
    }
  }
});

test("amount and slippage helpers reject non-bigint values, invalid budgets and rounded ceiling overflow", () => {
  for (const amount of [-1n, MAX_U64 + 1n, 1, NaN, "1", null]) {
    assert.throws(() => formatOwnedAmount(amount as bigint, 9), invalidInput);
    assert.throws(() => calculateMinimumAmountOut(amount as bigint, 0), invalidInput);
    assert.throws(() => calculateMaximumAmountIn(amount as bigint, 0), invalidInput);
  }
  for (const bps of [-1, 10_001, 0.5, NaN, Infinity, "1", null]) {
    assert.throws(() => calculateMinimumAmountOut(1n, bps as number), invalidInput);
    assert.throws(() => calculateMaximumAmountIn(1n, bps as number), invalidInput);
  }
  assert.throws(() => calculateMaximumAmountIn(MAX_U64, 1), invalidInput);
});

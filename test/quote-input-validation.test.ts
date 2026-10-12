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
const curve = { virtualBase: 1_000n, virtualQuote: 1_000n, realSaleBase: 800n, realQuote: 1_000n };
const pool = { base: 1_000n, quote: 1_000n };

// Only the tests erase the static signatures: JavaScript consumers, JSON input
// and unchecked casts can reach these public functions with malformed values.
type RuntimeOperation = (...args: unknown[]) => unknown;
type Operation = {
  name: string;
  run: RuntimeOperation;
  arguments: readonly unknown[];
  amountIndexes: readonly number[];
  reserveFields: readonly string[];
};
const operation = (name: string, run: unknown, args: readonly unknown[], amountIndexes: readonly number[], reserveFields: readonly string[]): Operation => ({
  name, run: run as RuntimeOperation, arguments: args, amountIndexes, reserveFields,
});
const curveFields = Object.keys(curve);
const poolFields = Object.keys(pool);
const operations = [
  operation("curve buy exact base", calculateCurveBuyExactBaseOut, [curve, 10n, MAX_U64, 30, 10], [1, 2], curveFields),
  operation("curve buy exact quote", calculateCurveBuyExactQuoteIn, [curve, 10n, 0n, 30, 10], [1, 2], curveFields),
  operation("curve sell exact base", calculateCurveSellExactBaseIn, [curve, 10n, 0n, 30, 10], [1, 2], curveFields),
  operation("AMM buy exact base", calculateAmmBuyExactBaseOut, [pool, 10n, MAX_U64, 20, 5, 5], [1, 2], poolFields),
  operation("AMM buy exact quote", calculateAmmBuyExactQuoteIn, [pool, 10n, 0n, 20, 5, 5], [1, 2], poolFields),
  operation("AMM sell exact base", calculateAmmSellExactBaseIn, [pool, 10n, 0n, 20, 5, 5], [1, 2], poolFields),
  operation("deposit shares", calculateAmmDepositExactShares, [pool, 100n, 10n, MAX_U64, MAX_U64], [1, 2, 3, 4], poolFields),
  operation("withdraw shares", calculateAmmWithdrawExactShares, [pool, 100n, 1n, 10n, 0n, 0n], [1, 2, 3, 4, 5], poolFields),
  operation("initial shares", calculateInitialLiquidityShares, [pool], [], poolFields),
] as const;

const rejectsCode = (code: OwnedQuoteMathErrorCode) => (error: unknown) => error instanceof OwnedQuoteMathError && error.code === code;
const argumentsFor = (entry: Operation): unknown[] => [...entry.arguments];
const malformed = [
  0, 1, 0.5, NaN, Infinity, -Infinity,
  "0", "1", "18446744073709551615", "not-a-number",
  null, undefined, true, false, Symbol("amount"),
  new Number(1), Object(1n), {}, [], [1], () => 1n,
];

test("every quote-math amount and limit requires bigint without JavaScript coercion", () => {
  for (const entry of operations) {
    for (const index of entry.amountIndexes) {
      for (const value of malformed) {
        const args = argumentsFor(entry);
        args[index] = value;
        assert.throws(() => entry.run(...args), rejectsCode("overflow"), `${entry.name} argument ${index} must reject ${typeof value} with a checked overflow error`);
      }
    }
  }
});

test("every reserve field in all nine math exports requires bigint", () => {
  for (const entry of operations) {
    for (const field of entry.reserveFields) {
      for (const value of malformed) {
        const args = argumentsFor(entry);
        args[0] = { ...(entry.arguments[0] as Record<string, unknown>), [field]: value };
        assert.throws(() => entry.run(...args), rejectsCode("overflow"), `${entry.name} reserve ${field} must reject ${typeof value} with a checked overflow error`);
      }
    }
  }
  assert.throws(() => calculateInitialLiquidityShares({ base: 0.5, quote: 1 } as unknown as typeof pool), rejectsCode("overflow"));
  assert.throws(() => calculateInitialLiquidityShares({ base: "1", quote: "1" } as unknown as typeof pool), rejectsCode("overflow"));
});

test("NaN and absent slippage limits fail closed for all eight quote APIs", () => {
  for (const entry of operations.filter((item) => item.amountIndexes.length > 0)) {
    const indexes = entry.name === "deposit shares" ? [3, 4] : entry.name === "withdraw shares" ? [4, 5] : [2];
    for (const index of indexes) {
      for (const value of [NaN, undefined, "not-a-number", {}]) {
        const args = argumentsFor(entry);
        args[index] = value;
        assert.throws(() => entry.run(...args), rejectsCode("overflow"), `${entry.name} ignored malformed slippage limit ${index}`);
      }
    }
  }
});

test("malformed scalar and reserve objects never invoke primitive conversion hooks", () => {
  let calls = 0;
  const invoked = () => { calls += 1; throw new Error("Primitive conversion must not run"); };
  const value = { valueOf: invoked, toString: invoked, [Symbol.toPrimitive]: invoked };
  for (const entry of operations) {
    for (const index of entry.amountIndexes) {
      const args = argumentsFor(entry);
      args[index] = value;
      assert.throws(() => entry.run(...args), rejectsCode("overflow"));
    }
    for (const field of entry.reserveFields) {
      const args = argumentsFor(entry);
      args[0] = { ...(entry.arguments[0] as Record<string, unknown>), [field]: value };
      assert.throws(() => entry.run(...args), rejectsCode("overflow"));
    }
  }
  assert.equal(calls, 0);
});

test("u64 range failures retain the checked overflow error across every input position", () => {
  for (const entry of operations) {
    for (const value of [-1n, MAX_U64 + 1n]) {
      for (const index of entry.amountIndexes) {
        const args = argumentsFor(entry);
        args[index] = value;
        assert.throws(() => entry.run(...args), rejectsCode("overflow"));
      }
      for (const field of entry.reserveFields) {
        const args = argumentsFor(entry);
        args[0] = { ...(entry.arguments[0] as Record<string, unknown>), [field]: value };
        assert.throws(() => entry.run(...args), rejectsCode("overflow"));
      }
    }
  }
});

test("valid bigint calls preserve output types, u64 boundaries and existing semantic error codes", () => {
  const assertBigintResult = (result: unknown): void => {
    if (result !== null && typeof result === "object") {
      for (const value of Object.values(result)) assertBigintResult(value);
    } else {
      assert.equal(typeof result, "bigint");
    }
  };
  for (const entry of operations) assertBigintResult(entry.run(...entry.arguments));
  assert.equal(calculateInitialLiquidityShares({ base: 1n, quote: 1n }), 1n);
  assert.equal(calculateInitialLiquidityShares({ base: MAX_U64, quote: MAX_U64 }), MAX_U64);
  assert.throws(() => calculateInitialLiquidityShares({ base: 0n, quote: 1n }), rejectsCode("invalid_reserves"));
  assert.throws(() => calculateAmmBuyExactBaseOut(pool, 0n, MAX_U64, 0, 0, 0), rejectsCode("zero_amount"));
  assert.throws(() => calculateAmmBuyExactBaseOut(pool, 10n, 0n, 0, 0, 0), rejectsCode("slippage_exceeded"));
  assert.throws(() => calculateAmmBuyExactBaseOut(pool, 10n, MAX_U64, NaN, 0, 0), rejectsCode("invalid_fee"));
  assert.throws(() => calculateAmmWithdrawExactShares(pool, 100n, 10n, 91n, 0n, 0n), rejectsCode("locked_share_violation"));
});

import assert from "node:assert/strict";
import test from "node:test";

import { address, type Slot } from "@solana/kit";

import { SOL_QUOTE_MINT_ADDRESS } from "../src/addresses.js";
import { OwnedSdkError } from "../src/errors.js";
import {
  assertOwnedMarketQuoteFresh,
  createPoolBuyExactBaseOutQuote,
  createPoolDepositLiquidityQuote,
  type OwnedMarketQuote,
} from "../src/owned-market-quotes.js";
import { deserializeOwnedQuote, serializeOwnedQuote } from "../src/quote-serialization.js";

const MAX_U64 = (1n << 64n) - 1n;
const source = {
  slot: 50n as Slot,
  pool: {
    baseMint: address("ErogPFvGsinQukiVfqvihsdo1CVAjTV11X6aW1QTgQLb"), quoteMint: SOL_QUOTE_MINT_ADDRESS,
    baseReserves: 1_000n, quoteReserves: 100n,
    fees: { reinvestFeeBps: 0, protocolFeeBps: 0, creatorFeeBps: 0 },
    totalEconomicShares: 100n, permanentlyLockedShares: 10n,
  },
};
const quote = () => createPoolBuyExactBaseOutQuote(source, 10n, MAX_U64, { observedAtUnixMs: 1_000 });
const generic = (result: unknown): OwnedMarketQuote<unknown> => ({ ...quote(), result });
const invalidSerialization = (error: unknown) => error instanceof OwnedSdkError && error.code === "invalid_serialization";
const document = (result: unknown) => JSON.stringify({ version: 1, quote: { ...JSON.parse(serializeOwnedQuote(quote())).quote, result } });

test("version one roundtrips trade and liquidity quotes with exact unsigned bigint tags", () => {
  for (const value of [quote(), createPoolDepositLiquidityQuote(source, 10n, 100n, 10n, { observedAtUnixMs: 1_000 })]) {
    const serialized = serializeOwnedQuote(value);
    const encoded = JSON.parse(serialized) as { version: number; quote: { sourceSlot: unknown } };
    assert.equal(encoded.version, 1);
    assert.deepEqual(encoded.quote.sourceSlot, { $bigint: "50" });
    const revived = deserializeOwnedQuote(serialized);
    assert.deepEqual(revived, value);
    assert.doesNotThrow(() => assertOwnedMarketQuoteFresh(revived, 50n as Slot, 1_000));
    assert.ok(Object.isFrozen(revived));
    assert.ok(Object.isFrozen(revived.result));
  }
  const result = { zero: 0n, maximum: MAX_U64, nested: [null, true, 1.5, "text", { amount: 1n }] };
  assert.deepEqual(deserializeOwnedQuote(serializeOwnedQuote(generic(result))).result, result);
});

test("serialization rejects silent JSON loss and object hooks without calling accessors or toJSON", () => {
  for (const result of [undefined, () => 1, Symbol("value"), NaN, Infinity, -Infinity, -0, -1n, MAX_U64 + 1n, new Date(), new Map(), new Set(), new Uint8Array(1), { invalid: undefined }, { invalid: () => 1 }, { invalid: Symbol("value") }, { $bigint: "1" }, [undefined], new Array(1)]) {
    assert.throws(() => serializeOwnedQuote(generic(result)), invalidSerialization);
  }
  let hookCalls = 0;
  const accessor = Object.defineProperty({}, "value", { enumerable: true, get() { hookCalls += 1; return 1; } });
  const arrayAccessor = Object.defineProperty([1], "0", { enumerable: true, get() { hookCalls += 1; return 1; } });
  const hooks = { toJSON() { hookCalls += 1; return {}; } };
  const hidden = Object.defineProperty({}, "hidden", { value: 1 });
  const decorated = Object.assign([1], { extra: 2 });
  for (const result of [accessor, arrayAccessor, hooks, hidden, decorated, { [Symbol("key")]: 1 }]) {
    assert.throws(() => serializeOwnedQuote(generic(result)), invalidSerialization);
  }
  assert.equal(hookCalls, 0);
});

test("deserialization rejects hostile bigint tags, versions, envelopes and non-finite JSON numbers", () => {
  for (const tagged of [
    { $bigint: "-1" }, { $bigint: "+1" }, { $bigint: "01" }, { $bigint: "1.0" }, { $bigint: "1e3" },
    { $bigint: "18446744073709551616" }, { $bigint: "1".repeat(21) }, { $bigint: 1 },
    { $bigint: "1", extra: true }, { $bigint: null },
  ]) assert.throws(() => deserializeOwnedQuote(document(tagged)), invalidSerialization);
  for (const serialized of ["", "{", "null", "[]", "true", "1", '{"version":2,"quote":{}}', '{"version":1,"quote":{},"extra":1}']) {
    assert.throws(() => deserializeOwnedQuote(serialized), invalidSerialization);
  }
  assert.throws(() => deserializeOwnedQuote(document(null).replace('"result":null', '"result":1e309')), invalidSerialization);
  assert.throws(() => deserializeOwnedQuote(document(null).replace('"result":null', '"result":-0')), invalidSerialization);
  const parsed = JSON.parse(serializeOwnedQuote(quote()));
  for (const patch of [{ sourceSlot: 50 }, { expiresAtUnixMs: null }, { inputMode: "invalid" }, { baseMint: "fake" }]) {
    assert.throws(() => deserializeOwnedQuote(JSON.stringify({ ...parsed, quote: { ...parsed.quote, ...patch } })), invalidSerialization);
  }
  assert.throws(() => serializeOwnedQuote({ ...quote(), expiresAtUnixMs: NaN }), invalidSerialization);
});

test("size, depth and value count caps bound serialization and revival", () => {
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  let deep: unknown = null;
  for (let index = 0; index < 70; index += 1) deep = { nested: deep };
  for (const result of [cyclic, deep, "x".repeat(65_537), "\u0000".repeat(12_000), Array.from({ length: 4_096 }, () => 0)]) {
    assert.throws(() => serializeOwnedQuote(generic(result)), invalidSerialization);
  }
  for (const result of [deep, Array.from({ length: 4_096 }, () => 0)]) {
    assert.throws(() => deserializeOwnedQuote(document(result)), invalidSerialization);
  }
  assert.throws(() => deserializeOwnedQuote(" ".repeat(65_537)), invalidSerialization);
  assert.throws(() => deserializeOwnedQuote(document("💧".repeat(20_000))), invalidSerialization);
  assert.throws(() => deserializeOwnedQuote(1 as unknown as string), invalidSerialization);
});

test("JSON prototype-shaped keys remain ordinary frozen data without prototype pollution", () => {
  const result = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}');
  const revived = deserializeOwnedQuote(serializeOwnedQuote(generic(result))).result as Record<string, unknown>;
  assert.ok(Object.hasOwn(revived, "__proto__"));
  assert.equal(Object.getPrototypeOf(revived), Object.prototype);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.deepEqual(revived, result);
  assert.ok(Object.isFrozen(revived));
});

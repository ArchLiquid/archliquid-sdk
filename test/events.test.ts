import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { address, getAddressEncoder, type Address } from "@solana/kit";

import {
  ARCH_CURVE_PROGRAM_ADDRESS as CURVE,
  ARCH_SWAP_PROGRAM_ADDRESS as SWAP,
  SOL_QUOTE_MINT_ADDRESS as QUOTE,
  SYSTEM_PROGRAM_ADDRESS as OTHER,
} from "../src/addresses.js";
import {
  OWNED_EVENT_DISCRIMINATORS,
  assertCanonicalMigrationEventPair,
  decodeOwnedProgramEvents,
  decodeOwnedTransactionEvents,
} from "../src/owned-program-events.js";

const BASE = address("ErogPFvGsinQukiVfqvihsdo1CVAjTV11X6aW1QTgQLb");
const encoder = getAddressEncoder();
const key = (value: Address) => Buffer.from(encoder.encode(value));
const u8 = (value: number) => Buffer.from([value]);
function u16(value: number) { const bytes = Buffer.alloc(2); bytes.writeUInt16LE(value); return bytes; }
function u64(value: bigint) { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(value); return bytes; }
function event(kind: keyof typeof OWNED_EVENT_DISCRIMINATORS, ...fields: Buffer[]) {
  return Buffer.concat([Buffer.from(OWNED_EVENT_DISCRIMINATORS[kind]), ...fields]);
}
const trade = (side = 0) => event("CurveTrade", key(BASE), key(OTHER), u8(side), u64(10n), u64(100n), u64(side === 0 ? 100n : 97n), u64(1n), u64(2n), u8(0));
const poolTrade = () => event("PoolTrade", key(SWAP), key(OTHER), u8(1), u64(10n), u64(100n), u64(94n), u64(1n), u64(2n), u64(3n));
const initialized = () => event("CanonicalPoolInitialized", key(SWAP), key(CURVE), key(OTHER), key(BASE), key(QUOTE), key(BASE), u64(100n), u64(200n), u64(5n), u16(20), u16(5), u16(5));
const migrated = () => event("CurveMigrated", key(CURVE), key(SWAP), key(BASE), key(QUOTE), u64(100n), u64(200n));
const invoke = (program: Address, depth = 1) => `Program ${program} invoke [${depth}]`;
const success = (program: Address) => `Program ${program} success`;
const failed = (program: Address) => `Program ${program} failed: custom program error: 0x1`;
const data = (bytes: Uint8Array) => `Program data: ${Buffer.from(bytes).toString("base64")}`;
const logs = (program: Address, bytes: Uint8Array) => [invoke(program), data(bytes), success(program)];
const committed = (logMessages: readonly string[]) => decodeOwnedTransactionEvents({ logMessages, err: null });

test("event discriminators match the committed IDLs", async () => {
  const expected: Record<string, readonly number[]> = {};
  for (const program of ["arch_curve", "arch_swap"]) {
    const idl = JSON.parse(await readFile(new URL(`../idl/${program}.json`, import.meta.url), "utf8")) as {
      events: { name: string; discriminator: number[] }[];
    };
    for (const value of idl.events) expected[value.name] = value.discriminator;
  }
  assert.deepEqual(OWNED_EVENT_DISCRIMINATORS, expected);
});

test("decodes independently encoded fixtures for all nine public event layouts", () => {
  const cases = [
    [CURVE, "CurveCreated", event("CurveCreated", key(CURVE), key(CURVE), key(OTHER), key(BASE), key(QUOTE), key(BASE), key(QUOTE), u64(1_000n), Buffer.alloc(32, 1), u64(5n))],
    [CURVE, "CurveTrade", trade()],
    [CURVE, "CurveFeesClaimed", event("CurveFeesClaimed", key(CURVE), key(OTHER), u8(0), key(QUOTE), u64(2n))],
    [CURVE, "CurveMigrated", migrated()],
    [SWAP, "CanonicalPoolInitialized", initialized()],
    [SWAP, "LiquidityDeposited", event("LiquidityDeposited", key(SWAP), key(OTHER), key(BASE), u64(1n), u64(2n), u64(3n), u64(4n))],
    [SWAP, "LiquidityWithdrawn", event("LiquidityWithdrawn", key(SWAP), key(OTHER), key(BASE), u64(1n), u64(2n), u64(3n), u64(4n))],
    [SWAP, "PoolTrade", poolTrade()],
    [SWAP, "PoolFeesClaimed", event("PoolFeesClaimed", key(SWAP), key(OTHER), u8(1), key(QUOTE), u64(2n))],
  ] as const;
  for (const [program, kind, bytes] of cases) {
    const result = committed(logs(program, bytes));
    assert.equal(result.length, 1);
    assert.equal(result[0]?.kind, kind);
    assert.equal(result[0]?.program, program === CURVE ? "archCurve" : "archSwap");
    assert.equal(result[0]?.eventIndex, 0);
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result[0]));
  }
  const buy = committed(logs(CURVE, trade()))[0];
  assert.ok(buy?.kind === "CurveTrade");
  assert.equal(buy.side, "buy");
  assert.equal(buy.baseAmount, 10n);
  assert.equal(buy.protocolFee, 2n);
  assert.equal(committed(logs(CURVE, trade(1)))[0]?.kind, "CurveTrade");
});

test("raw emissions retain diagnostic events but committed decoding requires explicit transaction success", () => {
  const value = [invoke(CURVE), data(trade()), failed(CURVE)];
  assert.equal(decodeOwnedProgramEvents(value).length, 1);
  assert.deepEqual(committed(value), []);
  assert.throws(() => decodeOwnedTransactionEvents({ logMessages: value, err: { InstructionError: [0, "Custom"] } }), /explicitly successful/);
  assert.throws(() => decodeOwnedTransactionEvents({ logMessages: value, err: undefined }), /explicitly successful/);
  assert.throws(() => decodeOwnedTransactionEvents({ logMessages: null, err: null }), /unavailable/);
});

test("successful parents retain emissions around caught failed CPI and discard the failed subtree", () => {
  const value = [
    invoke(CURVE), data(trade()),
    invoke(OTHER, 2), invoke(SWAP, 3), data(poolTrade()), success(SWAP), failed(OTHER),
    data(trade(1)), success(CURVE),
  ];
  assert.equal(decodeOwnedProgramEvents(value).length, 3);
  assert.deepEqual(committed(value).map(value => [value.kind, value.eventIndex]), [["CurveTrade", 0], ["CurveTrade", 1]]);
  assert.equal(committed([invoke(OTHER), invoke(CURVE, 2), data(trade()), success(CURVE), failed(OTHER)]).length, 0);
  assert.equal(committed([invoke(CURVE), invoke(OTHER, 2), failed(OTHER), data(trade()), success(CURVE)]).length, 1);
});

test("attributes only direct owned emissions and ignores spoofed or unknown event data", () => {
  const value = [
    data(trade()), `Program log: ${invoke(CURVE)}`, `Program log: ${data(trade())}`,
    invoke(CURVE), invoke(OTHER, 2), data(trade()), success(OTHER),
    data(Buffer.alloc(8, 254)), data(poolTrade()), data(trade()), success(CURVE),
  ];
  assert.equal(committed(value).length, 1);
  assert.equal(committed(logs(OTHER, trade())).length, 0);
});

test("rejects inconsistent, incomplete, truncated and unbounded logs", () => {
  for (const value of [[invoke(CURVE, 2)], [invoke(CURVE), success(SWAP)], [invoke(CURVE)], [success(CURVE)], [invoke(CURVE, 65)]]) {
    assert.throws(() => committed(value), /stack|depth/);
  }
  assert.throws(() => committed(["Log truncated"]), /truncated/);
  assert.throws(() => committed(Array.from({ length: 1_001 }, () => "")), /log count/);
  assert.throws(() => committed(["x".repeat(16_385)]), /size cap/);
  assert.throws(() => committed(Array.from({ length: 65 }, () => "x".repeat(16_384))), /log size/);
  assert.throws(() => committed([invoke(CURVE), ...Array.from({ length: 101 }, () => data(trade())), success(CURVE)]), /event cap/);
  const caught = Array.from({ length: 101 }, () => [invoke(CURVE), data(trade()), failed(CURVE)]).flat();
  assert.throws(() => committed(caught), /event cap/);
});

test("rejects malformed base64 and event bytes, with size checks before decoding", () => {
  for (const payload of ["%%%", "AAAAAAAAAAA", "AAAAAAAAAAB=", "AAAAAAAAAA== "]) {
    assert.throws(() => committed([invoke(CURVE), `Program data: ${payload}`, success(CURVE)]), /canonical base64/);
  }
  assert.throws(() => committed([invoke(CURVE), `Program data: ${"A".repeat(688)}`, success(CURVE)]), /size is invalid/);
  assert.throws(() => committed(logs(CURVE, Buffer.alloc(513))), /size is invalid/);
  assert.throws(() => committed(logs(CURVE, Buffer.alloc(7))), /size is invalid/);
  assert.throws(() => committed(logs(CURVE, trade().subarray(0, 100))), /truncated/);
  assert.throws(() => committed(logs(CURVE, Buffer.concat([trade(), u8(0)]))), /trailing bytes/);
  const mutate = (offset: number, value: number) => { const bytes = trade(); bytes[offset] = value; return bytes; };
  assert.throws(() => committed(logs(CURVE, mutate(72, 2))), /side is invalid/);
  assert.throws(() => committed(logs(CURVE, mutate(113, 2))), /bool is not canonical/);
  assert.throws(() => committed(logs(CURVE, mutate(89, 99))), /economics are invalid/);
  assert.throws(() => committed(logs(CURVE, mutate(73, 0))), /must be nonzero/);
  const fees = initialized(); fees.writeUInt16LE(1_001, fees.length - 6);
  assert.throws(() => committed(logs(SWAP, fees)), /fees are invalid/);
  const wrongQuote = migrated(); key(BASE).copy(wrongQuote, 104);
  assert.throws(() => committed(logs(CURVE, wrongQuote)), /quote mint is not canonical/);
});

test("canonical migration pairs require a matching preceding initialization", () => {
  const valid = committed([invoke(CURVE), invoke(SWAP, 2), data(initialized()), success(SWAP), data(migrated()), success(CURVE)]);
  assert.doesNotThrow(() => assertCanonicalMigrationEventPair(valid));
  assert.throws(() => assertCanonicalMigrationEventPair(committed(logs(CURVE, migrated()))), /preceding canonical/);
  const reversed = committed([...logs(CURVE, migrated()), ...logs(SWAP, initialized())]);
  assert.throws(() => assertCanonicalMigrationEventPair(reversed), /preceding canonical/);
  const inconsistent = migrated(); inconsistent.writeBigUInt64LE(99n, inconsistent.length - 16);
  assert.throws(() => assertCanonicalMigrationEventPair(committed([...logs(SWAP, initialized()), ...logs(CURVE, inconsistent)])), /inconsistent/);
});

test("event-specific economic and identity validations fail closed", () => {
  const invalid = [
    [CURVE, event("CurveFeesClaimed", key(CURVE), key(OTHER), u8(2), key(QUOTE), u64(1n)), /fee kind/],
    [CURVE, event("CurveFeesClaimed", key(CURVE), key(OTHER), u8(0), key(QUOTE), u64(0n)), /must be nonzero/],
    [CURVE, event("CurveCreated", key(CURVE), key(CURVE), key(OTHER), key(BASE), key(QUOTE), key(BASE), key(QUOTE), u64(1n), Buffer.alloc(32), u64(5n)), /commitment is empty/],
    [CURVE, event("CurveCreated", key(CURVE), key(CURVE), key(OTHER), key(BASE), key(QUOTE), key(BASE), key(QUOTE), u64(0n), Buffer.alloc(32, 1), u64(5n)), /must be nonzero/],
    [CURVE, event("CurveMigrated", key(CURVE), key(SWAP), key(BASE), key(QUOTE), u64(0n), u64(2n)), /must be nonzero/],
    [SWAP, event("LiquidityDeposited", key(SWAP), key(OTHER), key(BASE), u64(0n), u64(2n), u64(3n), u64(4n)), /must be nonzero/],
    [SWAP, event("LiquidityWithdrawn", key(SWAP), key(OTHER), key(BASE), u64(1n), u64(0n), u64(3n), u64(4n)), /must be nonzero/],
    [SWAP, event("PoolFeesClaimed", key(SWAP), key(OTHER), u8(0), key(BASE), u64(1n)), /quote mint is not canonical/],
  ] as const;
  for (const [program, bytes, error] of invalid) assert.throws(() => committed(logs(program, bytes)), error);
  const buyWithFeesLargerThanGross = trade(); buyWithFeesLargerThanGross.writeBigUInt64LE(100n, 97);
  assert.throws(() => committed(logs(CURVE, buyWithFeesLargerThanGross)), /economics are invalid/);
  const badSell = poolTrade(); badSell.writeBigUInt64LE(95n, 89);
  assert.throws(() => committed(logs(SWAP, badSell)), /economics are invalid/);
});

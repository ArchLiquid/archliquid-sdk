import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { address, getAddressEncoder, type Slot } from "@solana/kit";
import { ARCH_LOCKER_PROGRAM_ADDRESS, SPL_TOKEN_PROGRAM_ADDRESS, USDC_QUOTE_MINT_ADDRESS } from "../src/addresses.js";
import {
  LOCK_ACCOUNT_SIZE, MIN_LOCK_SECONDS, buildCreateSelfLiquidityLock,
  buildExtendLiquidityLock, buildReleaseLiquidityLock, decodeLiquidityLock, deriveLiquidityLockAddress,
} from "../src/locker.js";
import { deriveAssociatedTokenAddress } from "../src/owned-program-pdas.js";

const OWNER = address("DNpZ267hQULthYFmPkXpjJsc2jv2jbYhW5zRNdPEEh7W");
const MINT = address("85SWK59vHsVv8buEnSzhbLxnSe6o9g2Cca3JbMkSB427");
const encoder = getAddressEncoder();
const request = () => ({ owner: OWNER, mint: MINT, amount: 10n, nonce: 91n, permanent: false, unlockAt: 1_800_000_000n });

function readOnce<T extends object>(fields: T): { value: T; reads: Record<string, number> } {
  const reads: Record<string, number> = {};
  const value = Object.fromEntries(Object.keys(fields).map((key) => [key, undefined]));
  for (const key of Object.keys(fields) as (keyof T & string)[]) {
    Object.defineProperty(value, key, {
      enumerable: true,
      get() {
        reads[key] = (reads[key] ?? 0) + 1;
        assert.equal(reads[key], 1, `${key} getter was read more than once`);
        return fields[key];
      },
    });
  }
  return { value: value as T, reads };
}

async function lockFixture() {
  const nonce = 91n;
  const lock = await deriveLiquidityLockAddress(OWNER, nonce);
  const vault = await deriveAssociatedTokenAddress(lock.address, MINT);
  const createdAt = 1_700_000_000n;
  const data = new Uint8Array(LOCK_ACCOUNT_SIZE);
  const view = new DataView(data.buffer);
  // Independent, IDL-ordered offsets; no SDK encoder is used for these bytes.
  data.set([8, 255, 36, 202, 210, 22, 57, 137]);
  data[8] = 1; data[9] = lock.bump; data[10] = 0;
  data.set(encoder.encode(OWNER), 11);
  data.set(encoder.encode(OWNER), 43);
  data.set(encoder.encode(MINT), 75);
  data.set(encoder.encode(vault.address), 107);
  data.set(encoder.encode(SPL_TOKEN_PROGRAM_ADDRESS), 139);
  view.setBigUint64(171, nonce, true);
  view.setBigUint64(179, 10n, true);
  view.setBigInt64(187, createdAt, true);
  view.setBigInt64(195, createdAt + MIN_LOCK_SECONDS, true);
  return { address: lock.address, owner: ARCH_LOCKER_PROGRAM_ADDRESS, data, slot: 55n as Slot };
}

test("create lock retains the initially requested amount, nonce, mode and account identities across awaits", async () => {
  const expected = await buildCreateSelfLiquidityLock(request());
  const input = request();
  const pending = buildCreateSelfLiquidityLock(input);
  Object.assign(input, { owner: MINT, mint: USDC_QUOTE_MINT_ADDRESS, amount: 1_000_000n,
    nonce: 999n, permanent: true, unlockAt: 0n });
  assert.deepEqual(await pending, expected);
});

test("create lock reads each input getter once and uses the same values for validation and encoding", async () => {
  const observed = readOnce(request());
  assert.deepEqual(await buildCreateSelfLiquidityLock(observed.value), await buildCreateSelfLiquidityLock(request()));
  assert.deepEqual(observed.reads, { owner: 1, mint: 1, amount: 1, nonce: 1, permanent: 1, unlockAt: 1 });
});

test("release lock derives the beneficiary ATA from the same captured identities returned in its account list", async () => {
  const original = await decodeLiquidityLock(await lockFixture());
  const expected = await buildReleaseLiquidityLock(OWNER, original);
  const input = { ...original };
  const pending = buildReleaseLiquidityLock(OWNER, input);
  Object.assign(input, { beneficiary: MINT, depositor: MINT, mint: USDC_QUOTE_MINT_ADDRESS,
    address: MINT, vault: OWNER });
  assert.deepEqual(await pending, expected);
});

test("release lock reads each required identity getter once", async () => {
  const original = await decodeLiquidityLock(await lockFixture());
  const observed = readOnce(original);
  assert.deepEqual(await buildReleaseLiquidityLock(OWNER, observed.value), await buildReleaseLiquidityLock(OWNER, original));
  assert.deepEqual(observed.reads, { address: 1, beneficiary: 1, depositor: 1, mint: 1, vault: 1 });
});

for (const kind of ["Uint8Array", "Buffer"] as const) {
  test(`decode lock owns its ${kind} bytes and captures account metadata before asynchronous validation`, async () => {
    const fixture = await lockFixture();
    const expected = await decodeLiquidityLock(fixture);
    const data = kind === "Buffer" ? Buffer.from(fixture.data) : fixture.data;
    const input = { ...fixture, data };
    const pending = decodeLiquidityLock(input);
    data.fill(255);
    Object.assign(input, { address: MINT, owner: SPL_TOKEN_PROGRAM_ADDRESS,
      data: new Uint8Array(LOCK_ACCOUNT_SIZE), slot: 999n as Slot });
    assert.deepEqual(await pending, expected);
  });
}

test("decode lock reads address, owner, binary data and observation slot getters only once", async () => {
  const fixture = await lockFixture();
  const observed = readOnce(fixture);
  assert.deepEqual(await decodeLiquidityLock(observed.value), await decodeLiquidityLock(fixture));
  assert.deepEqual(observed.reads, { address: 1, owner: 1, data: 1, slot: 1 });
});

test("invalid original reserved bytes cannot be repaired by mutating a pending decoder input", async () => {
  const fixture = await lockFixture();
  fixture.data[203] = 1;
  const pending = decodeLiquidityLock(fixture);
  fixture.data[203] = 0;
  await assert.rejects(pending, /reserved bytes are unsupported/);
});

test("locker builder scalar encoders reject coerced bigint values and nonboolean lock modes", async () => {
  for (const amount of ["10", 10, NaN, { valueOf: () => 10n }]) {
    await assert.rejects(buildCreateSelfLiquidityLock({ ...request(), amount: amount as unknown as bigint }), /amount is invalid/);
  }
  for (const nonce of ["91", 91, { valueOf: () => 91n }]) {
    await assert.rejects(buildCreateSelfLiquidityLock({ ...request(), nonce: nonce as unknown as bigint }), /u64 range/);
  }
  for (const unlockAt of ["1800000000", 1_800_000_000, { valueOf: () => 1_800_000_000n }]) {
    await assert.rejects(buildCreateSelfLiquidityLock({ ...request(), unlockAt: unlockAt as unknown as bigint }), /i64 range/);
    assert.throws(() => buildExtendLiquidityLock(OWNER, MINT, unlockAt as unknown as bigint), /i64 range/);
  }
  for (const permanent of ["false", 0, null]) {
    await assert.rejects(buildCreateSelfLiquidityLock({ ...request(), permanent: permanent as unknown as boolean }), /mode is invalid/);
  }
});

test("lock decoder rejects nonbinary and oversized data before copying it", async () => {
  const fixture = await lockFixture();
  for (const data of [Array.from(fixture.data), new Uint8Array(LOCK_ACCOUNT_SIZE + 1)]) {
    await assert.rejects(decodeLiquidityLock({ ...fixture, data: data as unknown as typeof fixture.data }), /account size is invalid/);
  }
});

test("lock decoder preserves support for genuine Uint8Arrays from another realm", async () => {
  const fixture = await lockFixture();
  const expected = await decodeLiquidityLock(fixture);
  const data = runInNewContext("new Uint8Array(bytes)", { bytes: Array.from(fixture.data) }) as Uint8Array;
  assert.equal(data instanceof Uint8Array, false);
  assert.equal(ArrayBuffer.isView(data), true);
  const pending = decodeLiquidityLock({ ...fixture, data });
  data.fill(255);
  assert.deepEqual(await pending, expected);
});

test("lock decoder ignores spoofed Uint8Array tags and lengths on other binary views", async () => {
  const fixture = await lockFixture();
  const int8 = new Int8Array(fixture.data);
  const view = new DataView(fixture.data.buffer);
  const arrayLike = { length: LOCK_ACCOUNT_SIZE, [Symbol.toStringTag]: "Uint8Array" };
  for (const data of [int8, view]) {
    Object.defineProperty(data, Symbol.toStringTag, { value: "Uint8Array" });
    assert.equal(Object.prototype.toString.call(data), "[object Uint8Array]");
  }
  for (const data of [int8, view, arrayLike]) {
    await assert.rejects(decodeLiquidityLock({ ...fixture, data: data as unknown as Uint8Array }), /account size is invalid/);
  }
  const oversized = new Uint8Array(LOCK_ACCOUNT_SIZE + 1);
  Object.defineProperty(oversized, "length", { value: LOCK_ACCOUNT_SIZE });
  await assert.rejects(decodeLiquidityLock({ ...fixture, data: oversized }), /account size is invalid/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { SOL_QUOTE_MINT_ADDRESS, USDC_QUOTE_MINT_ADDRESS } from "../src/addresses.js";
import {
  createOwnedAddressDeriver,
  deriveAssociatedTokenAddress,
  deriveBaseMintAddress,
  deriveCurveAddress,
  deriveLaunchConfigAddress,
  deriveMetadataAddress,
  derivePoolAddress,
  derivePoolLpMintAddress,
  deriveProtocolConfigAddress,
  deriveSwapConfigAddress,
} from "../src/owned-program-pdas.js";
import { CREATOR, TREASURY } from "./helpers/fixtures.js";

test("opt-in cache preserves all canonical derivation results and standalone helpers remain uncached", async () => {
  const cached = createOwnedAddressDeriver();
  const pairs = [
    [cached.deriveProtocolConfigAddress(), deriveProtocolConfigAddress()],
    [cached.deriveLaunchConfigAddress(SOL_QUOTE_MINT_ADDRESS, 7), deriveLaunchConfigAddress(SOL_QUOTE_MINT_ADDRESS, 7)],
    [cached.deriveBaseMintAddress(CREATOR, 91n), deriveBaseMintAddress(CREATOR, 91n)],
    [cached.deriveCurveAddress(TREASURY), deriveCurveAddress(TREASURY)],
    [cached.deriveSwapConfigAddress(), deriveSwapConfigAddress()],
    [cached.derivePoolAddress(TREASURY, SOL_QUOTE_MINT_ADDRESS), derivePoolAddress(TREASURY, SOL_QUOTE_MINT_ADDRESS)],
    [cached.derivePoolLpMintAddress(TREASURY), derivePoolLpMintAddress(TREASURY)],
    [cached.deriveAssociatedTokenAddress(CREATOR, USDC_QUOTE_MINT_ADDRESS), deriveAssociatedTokenAddress(CREATOR, USDC_QUOTE_MINT_ADDRESS)],
    [cached.deriveMetadataAddress(TREASURY), deriveMetadataAddress(TREASURY)],
  ] as const;
  for (const [cachedPromise, uncachedPromise] of pairs) {
    const [a, b] = await Promise.all([cachedPromise, uncachedPromise]);
    assert.deepEqual(a, b);
    assert.equal(Object.isFrozen(a), true, "Consumers cannot mutate shared cached addresses");
  }
  assert.equal(cached.maxEntries, 128);
  assert.equal(cached.cacheSize, 9);
  assert.equal(Object.isFrozen(cached), true);
  assert.notStrictEqual(await deriveProtocolConfigAddress(), await deriveProtocolConfigAddress());
});

test("cache deduplicates pending and completed derivations without repeating SHA-256", async (context) => {
  const digest = context.mock.method(globalThis.crypto.subtle, "digest");
  const cached = createOwnedAddressDeriver();
  const first = cached.deriveBaseMintAddress(CREATOR, 91n);
  const second = cached.deriveBaseMintAddress(CREATOR, 91n);
  assert.strictEqual(first, second);
  const result = await first;
  const initialCalls = digest.mock.callCount();
  assert.ok(initialCalls > 0);
  assert.strictEqual(await cached.deriveBaseMintAddress(CREATOR, 91n), result);
  assert.equal(digest.mock.callCount(), initialCalls);
  assert.equal(cached.cacheSize, 1);
});

test("LRU eviction is bounded and cache hits refresh recency", async () => {
  const cached = createOwnedAddressDeriver({ maxEntries: 2 });
  const first = await cached.deriveBaseMintAddress(CREATOR, 1n);
  const second = await cached.deriveBaseMintAddress(CREATOR, 2n);
  assert.strictEqual(await cached.deriveBaseMintAddress(CREATOR, 1n), first);
  await cached.deriveBaseMintAddress(CREATOR, 3n);
  assert.equal(cached.cacheSize, 2);
  assert.strictEqual(await cached.deriveBaseMintAddress(CREATOR, 1n), first);
  const repeatedSecond = await cached.deriveBaseMintAddress(CREATOR, 2n);
  assert.notStrictEqual(repeatedSecond, second);
  assert.deepEqual(repeatedSecond, second);
  assert.equal(cached.cacheSize, 2);
  cached.clearCache();
  assert.equal(cached.cacheSize, 0);
  assert.notStrictEqual(await cached.deriveBaseMintAddress(CREATOR, 1n), first);
});

test("different programs, seed order, quote mint, nonce and config version do not share entries", async () => {
  const cached = createOwnedAddressDeriver();
  const results = await Promise.all([
    cached.deriveCurveAddress(TREASURY), cached.deriveMetadataAddress(TREASURY),
    cached.derivePoolLpMintAddress(TREASURY),
    cached.derivePoolAddress(TREASURY, SOL_QUOTE_MINT_ADDRESS),
    cached.derivePoolAddress(SOL_QUOTE_MINT_ADDRESS, TREASURY),
    cached.derivePoolAddress(TREASURY, USDC_QUOTE_MINT_ADDRESS),
    cached.deriveBaseMintAddress(CREATOR, 1n), cached.deriveBaseMintAddress(CREATOR, 2n),
    cached.deriveLaunchConfigAddress(SOL_QUOTE_MINT_ADDRESS, 1),
    cached.deriveLaunchConfigAddress(SOL_QUOTE_MINT_ADDRESS, 2),
    cached.deriveLaunchConfigAddress(USDC_QUOTE_MINT_ADDRESS, 1),
  ]);
  assert.equal(new Set(results.map((result) => result.address)).size, results.length);
  assert.equal(cached.cacheSize, results.length);
});

test("failed derivations are removed and a later call retries successfully", async (context) => {
  const digest = context.mock.method(globalThis.crypto.subtle, "digest", async () => {
    throw new Error("Injected digest failure");
  });
  const cached = createOwnedAddressDeriver();
  const pending = cached.deriveProtocolConfigAddress();
  assert.strictEqual(cached.deriveProtocolConfigAddress(), pending);
  assert.equal(cached.cacheSize, 1);
  await assert.rejects(pending, /Injected digest failure/);
  assert.equal(cached.cacheSize, 0);
  digest.mock.restore();
  assert.deepEqual(await cached.deriveProtocolConfigAddress(), await deriveProtocolConfigAddress());
  assert.equal(cached.cacheSize, 1);
});

test("a failed evicted request cannot remove a newer cached request for the same seeds", async (context) => {
  const originalDigest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
  let rejectFirst!: (reason: Error) => void;
  const delayedFailure = new Promise<ArrayBuffer>((_resolve, reject) => { rejectFirst = reject; });
  let calls = 0;
  context.mock.method(globalThis.crypto.subtle, "digest", (...args: Parameters<typeof originalDigest>) => {
    calls += 1;
    return calls === 1 ? delayedFailure : originalDigest(...args);
  });
  const cached = createOwnedAddressDeriver({ maxEntries: 1 });
  const original = cached.deriveProtocolConfigAddress();
  // Attach the rejection handler before releasing the injected failure.
  const rejected = assert.rejects(original, /Delayed digest failure/);
  await cached.deriveSwapConfigAddress();
  const replacement = cached.deriveProtocolConfigAddress();
  const result = await replacement;
  rejectFirst(new Error("Delayed digest failure"));
  await rejected;
  assert.equal(cached.cacheSize, 1);
  assert.strictEqual(cached.deriveProtocolConfigAddress(), replacement);
  assert.strictEqual(await cached.deriveProtocolConfigAddress(), result);
});

test("cache bounds and PDA integer seeds reject invalid input before insertion", () => {
  for (const maxEntries of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createOwnedAddressDeriver({ maxEntries }), /positive safe integer/);
  }
  const cached = createOwnedAddressDeriver({ maxEntries: 1 });
  for (const version of [-1, 0x1_0000, 1.5, NaN]) {
    assert.throws(() => cached.deriveLaunchConfigAddress(SOL_QUOTE_MINT_ADDRESS, version), /u16 seed/);
  }
  for (const nonce of [-1n, 1n << 64n]) {
    assert.throws(() => cached.deriveBaseMintAddress(CREATOR, nonce), /u64 seed/);
  }
  assert.equal(cached.cacheSize, 0);
});

import assert from "node:assert/strict";
import test from "node:test";
import type { Address, Slot } from "@solana/kit";
import { SOL_QUOTE_MINT_ADDRESS, USDC_QUOTE_MINT_ADDRESS, ZERO_ADDRESS } from "../src/addresses.js";
import {
  assertCurveVaultAccounting,
  assertFixedSupplyLaunchMint,
  assertLegacyNativeTokenAccountSynchronized,
  assertPermanentlyFixedLegacyMint,
  assertPoolLpMintAccounting,
  assertPoolVaultAccounting,
  decodeLegacyMint,
  decodeLegacyTokenAccount,
  getLegacyNativeTokenAccountSurplus,
  type DecodedLegacyTokenAccount,
} from "../src/legacy-token-accounts.js";
import { assertLiquidityLockVault, type DecodedLiquidityLock } from "../src/locker.js";
import { decodeCurveAccount, decodeLaunchConfigAccount, decodePoolAccount, decodeSwapConfigAccount } from "../src/owned-program-accounts.js";
import { CREATOR, TREASURY, makeMintFixture, makeProgramFixtures, makeTokenFixture, mutate, offsetView } from "./helpers/fixtures.js";

const MAX_U64 = (1n << 64n) - 1n;

async function accountingFixtures(quoteKind: "sol" | "usdc" = "sol") {
  const fixtures = await makeProgramFixtures(quoteKind);
  const [launch, swap] = await Promise.all([
    decodeLaunchConfigAccount(fixtures.launch), decodeSwapConfigAccount(fixtures.swap),
  ]);
  const [curve, pool] = await Promise.all([
    decodeCurveAccount(fixtures.curve, launch), decodePoolAccount(fixtures.pool, swap),
  ]);
  const vault = (address: Address, mint: Address, authority: Address, amount: bigint) => {
    const native = mint === SOL_QUOTE_MINT_ADDRESS;
    const fixture = makeTokenFixture({ address, mint, authority, amount, nativeRentReserve: native ? 2_039_280n : null });
    return decodeLegacyTokenAccount({ ...fixture, ...(native ? { lamports: amount + 2_039_280n } : {}) });
  };
  return {
    curve, pool,
    curveBase: vault(curve.baseVault, curve.baseMint, curve.address, 950_000n),
    curveQuote: vault(curve.quoteVault, curve.quoteMint, curve.address, 2_800n),
    poolBase: vault(pool.baseVault, pool.baseMint, pool.address, 200_000n),
    poolQuote: vault(pool.quoteVault, pool.quoteMint, pool.address, 50_100n),
  };
}

test("legacy mint decoding preserves exact u64s, optional authorities and nonzero-offset views", () => {
  const fixture = makeMintFixture({ supply: MAX_U64, decimals: 255, mintAuthority: CREATOR, freezeAuthority: TREASURY });
  const mint = decodeLegacyMint({ ...fixture, data: offsetView(fixture.data) });
  assert.deepEqual(mint, {
    address: TREASURY, mintAuthority: CREATOR, supply: MAX_U64, decimals: 255,
    initialized: true, freezeAuthority: TREASURY,
  });
  const noAuthorities = decodeLegacyMint(makeMintFixture({ supply: 0n }));
  assert.equal(noAuthorities.mintAuthority, null);
  assert.equal(noAuthorities.freezeAuthority, null);
  assert.equal(noAuthorities.supply, 0n);
  // SPL COption::None does not require the unused payload bytes to be zeroed.
  const absent = mutate(makeMintFixture(), "mintAuthority", CREATOR);
  assert.equal(decodeLegacyMint(absent).mintAuthority, null);
});

test("legacy mint decoder rejects wrong ownership, length, initialization and COption tags", () => {
  const fixture = makeMintFixture();
  assert.throws(() => decodeLegacyMint({ ...fixture, owner: ZERO_ADDRESS }), /legacy SPL Token/);
  for (const data of [fixture.data.slice(1), new Uint8Array(83)]) {
    assert.throws(() => decodeLegacyMint({ ...fixture, data }), /account size/);
  }
  for (const initialized of [0, 2, 255]) {
    assert.throws(() => decodeLegacyMint(mutate(fixture, "initialized", initialized)), /not initialized/);
  }
  for (const field of ["mintAuthorityTag", "freezeAuthorityTag"]) {
    assert.throws(() => decodeLegacyMint(mutate(fixture, field, 2, "u32")), /invalid COption tag/);
  }
  assert.throws(() => decodeLegacyMint({ ...fixture, lamports: -1n }), /lamports cannot be negative/);
});

test("legacy token decoding accepts initialized/frozen state and explicit optional values", () => {
  const fixture = makeTokenFixture({ amount: MAX_U64, delegate: TREASURY, delegatedAmount: 12n, state: 2, closeAuthority: CREATOR });
  const account = decodeLegacyTokenAccount({ ...fixture, data: offsetView(fixture.data), lamports: 999n });
  assert.deepEqual(account, {
    address: TREASURY, mint: USDC_QUOTE_MINT_ADDRESS, authority: CREATOR,
    amount: MAX_U64, delegate: TREASURY, state: "frozen", nativeRentReserve: null,
    delegatedAmount: 12n, closeAuthority: CREATOR, lamports: 999n,
  });
  const noOptionals = decodeLegacyTokenAccount(makeTokenFixture());
  assert.equal(noOptionals.delegate, null);
  assert.equal(noOptionals.closeAuthority, null);
  assert.equal(noOptionals.nativeRentReserve, null);
  assert.equal("lamports" in noOptionals, false);
  assert.equal(decodeLegacyTokenAccount(mutate(makeTokenFixture(), "delegate", CREATOR)).delegate, null);
});

test("legacy token decoder rejects malformed envelope, state, optional tags and inconsistent delegation", () => {
  const fixture = makeTokenFixture();
  assert.throws(() => decodeLegacyTokenAccount({ ...fixture, owner: ZERO_ADDRESS }), /legacy SPL Token/);
  assert.throws(() => decodeLegacyTokenAccount({ ...fixture, data: fixture.data.slice(1) }), /account size/);
  assert.throws(() => decodeLegacyTokenAccount({ ...fixture, data: new Uint8Array(166) }), /account size/);
  for (const state of [0, 3, 255]) {
    assert.throws(() => decodeLegacyTokenAccount(mutate(fixture, "state", state)), /not initialized|state is invalid/);
  }
  for (const field of ["delegateTag", "nativeRentReserveTag", "closeAuthorityTag"]) {
    assert.throws(() => decodeLegacyTokenAccount(mutate(fixture, field, 2, "u32")), /invalid COption tag/);
  }
  assert.throws(() => decodeLegacyTokenAccount(mutate(fixture, "delegatedAmount", 1n)), /without a delegate/);
  assert.throws(() => decodeLegacyTokenAccount({ ...fixture, lamports: -1n }), /lamports cannot be negative/);
});

test("WSOL decoding distinguishes valid unsynchronized SOL from under-backed token amounts", () => {
  const fixture = makeTokenFixture({ mint: SOL_QUOTE_MINT_ADDRESS, amount: 50n, nativeRentReserve: 2_039_280n });
  const synchronized = decodeLegacyTokenAccount({ ...fixture, lamports: 2_039_330n });
  assert.equal(getLegacyNativeTokenAccountSurplus(synchronized), 0n);
  assert.doesNotThrow(() => assertLegacyNativeTokenAccountSynchronized(synchronized));
  const unsynchronized = decodeLegacyTokenAccount({ ...fixture, lamports: 2_039_331n });
  assert.equal(unsynchronized.amount, 50n, "Unobserved SyncNative must not increase transferable tokens");
  assert.equal(getLegacyNativeTokenAccountSurplus(unsynchronized), 1n);
  assert.throws(() => assertLegacyNativeTokenAccountSynchronized(unsynchronized), /SyncNative/);
  assert.throws(() => decodeLegacyTokenAccount({ ...fixture, lamports: 2_039_329n }), /not backed/);
  const unobserved = decodeLegacyTokenAccount(fixture);
  assert.throws(() => getLegacyNativeTokenAccountSurplus(unobserved), /observed lamports/);
  assert.throws(() => assertLegacyNativeTokenAccountSynchronized(unobserved), /observed lamports/);
  assert.throws(() => getLegacyNativeTokenAccountSurplus(decodeLegacyTokenAccount(makeTokenFixture())), /not a native/);
  assert.throws(() => getLegacyNativeTokenAccountSurplus({ ...synchronized, mint: USDC_QUOTE_MINT_ADDRESS }), /not a native/);
  assert.throws(() => getLegacyNativeTokenAccountSurplus({ ...synchronized, lamports: 0n }), /not backed/);
});

test("fixed launch mint assertions require identity, decimals, authority revocation and original supply", async () => {
  const { curve } = await accountingFixtures();
  const mint = decodeLegacyMint(makeMintFixture({ address: curve.baseMint }));
  assert.doesNotThrow(() => assertPermanentlyFixedLegacyMint(mint, curve.baseMint));
  assert.doesNotThrow(() => assertFixedSupplyLaunchMint(mint, curve));
  assert.throws(() => assertFixedSupplyLaunchMint({ ...mint, supply: mint.supply - 1n }, curve), /supply does not match/);
  assert.throws(() => assertPermanentlyFixedLegacyMint({ ...mint, address: TREASURY }, curve.baseMint), /address is not canonical/);
  assert.throws(() => assertPermanentlyFixedLegacyMint({ ...mint, decimals: 9 }, curve.baseMint), /decimals/);
  assert.throws(() => assertPermanentlyFixedLegacyMint({ ...mint, mintAuthority: CREATOR }, curve.baseMint), /revoked/);
  assert.throws(() => assertPermanentlyFixedLegacyMint({ ...mint, freezeAuthority: CREATOR }, curve.baseMint), /revoked/);
});

for (const quoteKind of ["sol", "usdc"] as const) {
  test(`Curve and Pool vault custody reconcile ${quoteKind.toUpperCase()} accounting and tolerate donations`, async () => {
    const { curve, pool, curveBase, curveQuote, poolBase, poolQuote } = await accountingFixtures(quoteKind);
    assert.doesNotThrow(() => assertCurveVaultAccounting(curve, curveBase, curveQuote));
    assert.doesNotThrow(() => assertPoolVaultAccounting(pool, poolBase, poolQuote));
    assert.doesNotThrow(() => assertCurveVaultAccounting(curve, { ...curveBase, amount: curveBase.amount + 1n }, curveQuote));
    assert.doesNotThrow(() => assertPoolVaultAccounting(pool, { ...poolBase, amount: poolBase.amount + 1n }, poolQuote));
    if (quoteKind === "sol") {
      assert.doesNotThrow(() => assertCurveVaultAccounting(curve, curveBase, { ...curveQuote, lamports: curveQuote.lamports! + 1n }));
      assert.doesNotThrow(() => assertPoolVaultAccounting(pool, poolBase, { ...poolQuote, lamports: poolQuote.lamports! + 1n }));
      assert.throws(() => assertPoolVaultAccounting(pool, poolBase, { ...poolQuote, lamports: 0n }), /not backed/);
      const { lamports: _lamports, ...unobserved } = curveQuote;
      assert.throws(() => assertCurveVaultAccounting(curve, curveBase, unobserved), /requires lamports/);
    } else {
      assert.doesNotThrow(() => assertCurveVaultAccounting(curve, curveBase, { ...curveQuote, amount: curveQuote.amount + 1n }));
    }
    assert.throws(() => assertCurveVaultAccounting(curve, { ...curveBase, amount: curveBase.amount - 1n }, curveQuote), /below decoded accounting/);
    assert.throws(() => assertCurveVaultAccounting(curve, curveBase, { ...curveQuote, amount: curveQuote.amount - 1n }), /below decoded accounting/);
    assert.throws(() => assertPoolVaultAccounting(pool, { ...poolBase, amount: poolBase.amount - 1n }, poolQuote), /below decoded accounting/);
    assert.throws(() => assertPoolVaultAccounting(pool, poolBase, { ...poolQuote, amount: poolQuote.amount - 1n }), /below decoded accounting/);
  });
}

test("canonical Curve and Pool vault policy rejects substitution, delegation, freeze/close authorities and native mismatches", async () => {
  const { curve, pool, curveBase, curveQuote, poolBase, poolQuote } = await accountingFixtures();
  const unsafe: Partial<DecodedLegacyTokenAccount>[] = [
    { address: TREASURY }, { mint: USDC_QUOTE_MINT_ADDRESS }, { authority: CREATOR },
    { state: "frozen" }, { delegate: CREATOR }, { delegatedAmount: 1n },
    { closeAuthority: CREATOR }, { nativeRentReserve: 1n },
  ];
  for (const change of unsafe) {
    assert.throws(() => assertCurveVaultAccounting(curve, { ...curveBase, ...change }, curveQuote), /identity|frozen|delegate|close authority|native-token state/);
    assert.throws(() => assertPoolVaultAccounting(pool, { ...poolBase, ...change }, poolQuote), /identity|frozen|delegate|close authority|native-token state/);
  }
  assert.throws(() => assertCurveVaultAccounting(curve, curveBase, { ...curveQuote, nativeRentReserve: null }), /native-token state/);
  assert.throws(() => assertPoolVaultAccounting(pool, poolBase, { ...poolQuote, nativeRentReserve: null }), /native-token state/);
  assert.throws(() => assertCurveVaultAccounting({ ...curve, realSaleBaseReserves: MAX_U64 }, curveBase, curveQuote), /accounting exceeds u64/);
  assert.throws(() => assertCurveVaultAccounting({ ...curve, realQuoteReserves: MAX_U64 }, curveBase, curveQuote), /accounting exceeds u64/);
  assert.throws(() => assertPoolVaultAccounting({ ...pool, quoteReserves: MAX_U64 }, poolBase, poolQuote), /accounting exceeds u64/);
  assert.doesNotThrow(() => assertCurveVaultAccounting(
    { ...curve, migrated: true, complete: true, realSaleBaseReserves: 0n, realQuoteReserves: 0n },
    { ...curveBase, amount: 0n }, { ...curveQuote, amount: 100n },
  ));
});

test("Pool LP mint accounting permits burned shares while preventing excess supply and authority substitution", async () => {
  const { pool } = await accountingFixtures();
  const mint = decodeLegacyMint(makeMintFixture({ address: pool.lpMint, mintAuthority: pool.address, decimals: 9, supply: 90_000n }));
  assert.doesNotThrow(() => assertPoolLpMintAccounting(pool, mint));
  assert.doesNotThrow(() => assertPoolLpMintAccounting(pool, { ...mint, supply: 0n }));
  assert.throws(() => assertPoolLpMintAccounting(pool, { ...mint, address: TREASURY }), /address is not canonical/);
  assert.throws(() => assertPoolLpMintAccounting(pool, { ...mint, decimals: 6 }), /decimals/);
  assert.throws(() => assertPoolLpMintAccounting(pool, { ...mint, mintAuthority: null }), /authority/);
  assert.throws(() => assertPoolLpMintAccounting(pool, { ...mint, mintAuthority: CREATOR }), /authority/);
  assert.throws(() => assertPoolLpMintAccounting(pool, { ...mint, freezeAuthority: CREATOR }), /freeze authority/);
  assert.throws(() => assertPoolLpMintAccounting(pool, { ...mint, supply: 90_001n }), /exceeds public economic shares/);
  assert.throws(() => assertPoolLpMintAccounting({ ...pool, totalEconomicShares: 9_999n }, mint), /exceeds public economic shares/);
});

test("liquidity lock vaults enforce the same delegate, authority, balance and native custody policy", () => {
  const lock: DecodedLiquidityLock = {
    address: CREATOR, schemaVersion: 1, bump: 255, mode: "permanent", depositor: TREASURY,
    beneficiary: TREASURY, mint: USDC_QUOTE_MINT_ADDRESS, vault: TREASURY, nonce: 1n,
    principalAmount: 42n, createdAt: 1_700_000_000n, unlockAt: 0n, slot: 1n as Slot,
  };
  const vault = decodeLegacyTokenAccount(makeTokenFixture());
  assert.doesNotThrow(() => assertLiquidityLockVault(lock, vault));
  for (const change of [
    { address: CREATOR }, { authority: TREASURY }, { mint: SOL_QUOTE_MINT_ADDRESS }, { state: "frozen" as const },
    { amount: 41n }, { delegate: TREASURY }, { delegatedAmount: 1n },
    { closeAuthority: TREASURY }, { nativeRentReserve: 1n },
  ]) assert.throws(() => assertLiquidityLockVault(lock, { ...vault, ...change }), /custody does not reconcile/);
  const nativeLock = { ...lock, mint: SOL_QUOTE_MINT_ADDRESS };
  const nativeFixture = makeTokenFixture({ mint: SOL_QUOTE_MINT_ADDRESS, nativeRentReserve: 2_039_280n });
  const nativeVault = decodeLegacyTokenAccount({ ...nativeFixture, lamports: 2_039_323n });
  assert.doesNotThrow(() => assertLiquidityLockVault(nativeLock, nativeVault));
  assert.throws(() => assertLiquidityLockVault(nativeLock, { ...nativeVault, nativeRentReserve: null }), /custody/);
  const { lamports: _lamports, ...unobserved } = nativeVault;
  assert.throws(() => assertLiquidityLockVault(nativeLock, unobserved), /observed lamports/);
  assert.throws(() => assertLiquidityLockVault(nativeLock, { ...nativeVault, lamports: 0n }), /not backed/);
});

import assert from "node:assert/strict";
import test from "node:test";

import { AccountRole, address, getAddressEncoder, type Address, type Slot } from "@solana/kit";

import {
  ARCH_LOCKER_PROGRAM_ADDRESS,
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  SPL_TOKEN_PROGRAM_ADDRESS,
  SYSTEM_PROGRAM_ADDRESS,
  USDC_QUOTE_MINT_ADDRESS,
} from "../src/addresses.js";
import {
  LOCK_ACCOUNT_SIZE,
  MIN_LOCK_SECONDS,
  assertLiquidityLockVault,
  buildCreateSelfLiquidityLock,
  buildExtendLiquidityLock,
  buildMakeLiquidityLockPermanent,
  buildReleaseLiquidityLock,
  decodeLiquidityLock,
  deriveLiquidityLockAddress,
} from "../src/locker.js";
import { deriveAssociatedTokenAddress } from "../src/owned-program-pdas.js";

const DEPOSITOR = address("DNpZ267hQULthYFmPkXpjJsc2jv2jbYhW5zRNdPEEh7W");
const LP_MINT = address("85SWK59vHsVv8buEnSzhbLxnSe6o9g2Cca3JbMkSB427");
const LOCK_DISCRIMINATOR = [8, 255, 36, 202, 210, 22, 57, 137] as const;
const addressEncoder = getAddressEncoder();

class LockWriter {
  readonly bytes = new Uint8Array(LOCK_ACCOUNT_SIZE);
  private readonly view = new DataView(this.bytes.buffer);
  private offset = 0;

  raw(value: ArrayLike<number>) {
    this.bytes.set(value, this.offset);
    this.offset += value.length;
    return this;
  }

  u8(value: number) {
    this.view.setUint8(this.offset, value);
    this.offset += 1;
    return this;
  }

  u64(value: bigint) {
    this.view.setBigUint64(this.offset, value, true);
    this.offset += 8;
    return this;
  }

  i64(value: bigint) {
    this.view.setBigInt64(this.offset, value, true);
    this.offset += 8;
    return this;
  }

  address(value: Address) {
    return this.raw(addressEncoder.encode(value));
  }

  finish() {
    assert.equal(this.offset, LOCK_ACCOUNT_SIZE);
    return this.bytes;
  }
}

async function fixture() {
  const nonce = 91n;
  const lock = await deriveLiquidityLockAddress(DEPOSITOR, nonce);
  const vault = await deriveAssociatedTokenAddress(lock.address, LP_MINT);
  const createdAt = 1_700_000_000n;
  const unlockAt = createdAt + MIN_LOCK_SECONDS;
  const data = new LockWriter()
    .raw(LOCK_DISCRIMINATOR)
    .u8(1)
    .u8(lock.bump)
    .u8(0)
    .address(DEPOSITOR)
    .address(DEPOSITOR)
    .address(LP_MINT)
    .address(vault.address)
    .address(SPL_TOKEN_PROGRAM_ADDRESS)
    .u64(nonce)
    .u64(25_000_000_000n)
    .i64(createdAt)
    .i64(unlockAt)
    .raw(new Uint8Array(64))
    .finish();
  return { data, lock, nonce, unlockAt, vault };
}

test("builds the exact self-custody lock instruction", async () => {
  const result = await buildCreateSelfLiquidityLock({
    owner: DEPOSITOR,
    mint: LP_MINT,
    amount: 7_500_000_000n,
    nonce: 91n,
    permanent: false,
    unlockAt: 1_800_000_000n,
  });
  const source = await deriveAssociatedTokenAddress(DEPOSITOR, LP_MINT);
  const expectedLock = await deriveLiquidityLockAddress(DEPOSITOR, 91n);
  const expectedVault = await deriveAssociatedTokenAddress(expectedLock.address, LP_MINT);
  assert.equal(result.instruction.programAddress, ARCH_LOCKER_PROGRAM_ADDRESS);
  assert.equal(result.lock, expectedLock.address);
  assert.equal(result.vault, expectedVault.address);
  assert.deepEqual(result.instruction.accounts?.map((account) => [account.address, account.role]), [
    [DEPOSITOR, AccountRole.WRITABLE_SIGNER],
    [DEPOSITOR, AccountRole.READONLY_SIGNER],
    [LP_MINT, AccountRole.READONLY],
    [source.address, AccountRole.WRITABLE],
    [source.address, AccountRole.WRITABLE],
    [expectedLock.address, AccountRole.WRITABLE],
    [expectedVault.address, AccountRole.WRITABLE],
    [SPL_TOKEN_PROGRAM_ADDRESS, AccountRole.READONLY],
    [ASSOCIATED_TOKEN_PROGRAM_ADDRESS, AccountRole.READONLY],
    [SYSTEM_PROGRAM_ADDRESS, AccountRole.READONLY],
  ]);
  const data = result.instruction.data ?? new Uint8Array();
  assert.deepEqual(Array.from(data.slice(0, 8)), [171, 216, 92, 167, 165, 8, 153, 90]);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  assert.equal(view.getBigUint64(8, true), 91n);
  assert.equal(view.getBigUint64(16, true), 7_500_000_000n);
  assert.equal(view.getBigInt64(25, true), 1_800_000_000n);
});

test("strictly decodes lock identity and reconciles vault custody", async () => {
  const value = await fixture();
  const lock = await decodeLiquidityLock({
    address: value.lock.address,
    owner: ARCH_LOCKER_PROGRAM_ADDRESS,
    data: value.data,
    slot: 55n as Slot,
  });
  assert.equal(lock.mode, "timed");
  assert.equal(lock.mint, LP_MINT);
  assert.equal(lock.vault, value.vault.address);
  assert.equal(lock.principalAmount, 25_000_000_000n);
  const vaultAccount = {
    address: lock.vault,
    mint: lock.mint,
    authority: lock.address,
    amount: lock.principalAmount,
    delegate: null,
    state: "initialized" as const,
    nativeRentReserve: null,
    delegatedAmount: 0n,
    closeAuthority: null,
  };
  assert.doesNotThrow(() => assertLiquidityLockVault(lock, vaultAccount));
  assert.throws(
    () => assertLiquidityLockVault(lock, { ...vaultAccount, authority: DEPOSITOR }),
    /custody does not reconcile/,
  );

  const extend = buildExtendLiquidityLock(DEPOSITOR, lock.address, lock.unlockAt + 1n);
  const extendData = extend.data ?? new Uint8Array();
  assert.deepEqual(Array.from(extendData.slice(0, 8)), [68, 151, 140, 144, 139, 122, 118, 170]);
  assert.equal(
    new DataView(extendData.buffer, extendData.byteOffset, extendData.byteLength).getBigInt64(8, true),
    lock.unlockAt + 1n,
  );
  assert.deepEqual(
    Array.from(buildMakeLiquidityLockPermanent(DEPOSITOR, lock.address).data ?? []),
    [16, 195, 95, 226, 254, 222, 114, 240],
  );
  assert.deepEqual(
    Array.from((await buildReleaseLiquidityLock(DEPOSITOR, lock)).data ?? []),
    [241, 251, 248, 8, 198, 190, 195, 6],
  );
});

test("rejects substituted and malformed lock accounts", async () => {
  const value = await fixture();
  const decode = (data: Uint8Array, owner: string = ARCH_LOCKER_PROGRAM_ADDRESS) =>
    decodeLiquidityLock({ address: value.lock.address, owner, data, slot: 1n as Slot });
  const mutated = (offset: number) => {
    const data = value.data.slice();
    data[offset] = data[offset]! ^ 1;
    return data;
  };
  await assert.rejects(decode(value.data, USDC_QUOTE_MINT_ADDRESS), /owner is invalid/);
  await assert.rejects(decode(mutated(0)), /discriminator is invalid/);
  await assert.rejects(decode(mutated(9)), /PDA is invalid/);
  await assert.rejects(decode(mutated(139)), /token program is invalid/);
  await assert.rejects(decode(mutated(203)), /reserved bytes are unsupported/);
  const zeroPrincipal = value.data.slice();
  zeroPrincipal.fill(0, 179, 187);
  await assert.rejects(decode(zeroPrincipal), /principal is invalid/);
  await assert.rejects(
    buildCreateSelfLiquidityLock({ owner: DEPOSITOR, mint: LP_MINT, amount: 0n, nonce: 1n, permanent: false, unlockAt: 1n }),
    /amount is invalid/,
  );
});

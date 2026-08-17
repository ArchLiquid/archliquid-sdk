import {
  AccountRole,
  address,
  getAddressDecoder,
  getAddressEncoder,
  getProgramDerivedAddress,
  type Address,
  type Instruction,
  type ReadonlyUint8Array,
  type Slot,
} from "@solana/kit";

import {
  ARCH_LOCKER_PROGRAM_ADDRESS,
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  SPL_TOKEN_PROGRAM_ADDRESS,
  SYSTEM_PROGRAM_ADDRESS,
} from "./addresses.js";
import { deriveAssociatedTokenAddress } from "./owned-program-pdas.js";
import type { DecodedLegacyTokenAccount } from "./legacy-token-accounts.js";

export const LOCK_ACCOUNT_SIZE = 267;
export const MIN_LOCK_SECONDS = 30n * 24n * 60n * 60n;
const LOCK_DISCRIMINATOR = [8, 255, 36, 202, 210, 22, 57, 137] as const;
const CREATE_LOCK_DISCRIMINATOR = [171, 216, 92, 167, 165, 8, 153, 90] as const;
const EXTEND_LOCK_DISCRIMINATOR = [68, 151, 140, 144, 139, 122, 118, 170] as const;
const MAKE_PERMANENT_DISCRIMINATOR = [16, 195, 95, 226, 254, 222, 114, 240] as const;
const RELEASE_LOCK_DISCRIMINATOR = [241, 251, 248, 8, 198, 190, 195, 6] as const;
const MAX_U64 = (1n << 64n) - 1n;
const MIN_I64 = -(1n << 63n);
const MAX_I64 = (1n << 63n) - 1n;
const addressEncoder = getAddressEncoder();
const addressDecoder = getAddressDecoder();

export type DecodedLiquidityLock = Readonly<{
  address: Address;
  schemaVersion: number;
  bump: number;
  mode: "timed" | "permanent";
  depositor: Address;
  beneficiary: Address;
  mint: Address;
  vault: Address;
  nonce: bigint;
  principalAmount: bigint;
  createdAt: bigint;
  unlockAt: bigint;
  slot: Slot;
}>;

export function assertLiquidityLockVault(
  lock: DecodedLiquidityLock,
  vault: DecodedLegacyTokenAccount,
) {
  if (
    vault.address !== lock.vault ||
    vault.mint !== lock.mint ||
    vault.authority !== lock.address ||
    vault.state !== "initialized" ||
    vault.amount < lock.principalAmount
  ) {
    throw new Error("Liquidity lock vault custody does not reconcile");
  }
}

function u64(value: bigint) {
  if (value < 0n || value > MAX_U64) throw new Error("Value is outside u64 range");
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return bytes;
}

function i64(value: bigint) {
  if (value < MIN_I64 || value > MAX_I64) throw new Error("Timestamp is outside i64 range");
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigInt64(0, value, true);
  return bytes;
}

function concat(chunks: readonly ReadonlyUint8Array[]) {
  const result = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

export async function deriveLiquidityLockAddress(depositor: Address, nonce: bigint) {
  const [lockAddress, bump] = await getProgramDerivedAddress({
    programAddress: ARCH_LOCKER_PROGRAM_ADDRESS,
    seeds: ["lock", addressEncoder.encode(depositor), u64(nonce)],
  });
  return Object.freeze({ address: lockAddress, bump });
}

export async function buildCreateSelfLiquidityLock(input: Readonly<{
  owner: string;
  mint: string;
  amount: bigint;
  nonce: bigint;
  permanent: boolean;
  unlockAt: bigint;
}>) {
  const owner = address(input.owner);
  const mint = address(input.mint);
  if (input.amount <= 0n || input.amount > MAX_U64) throw new Error("Lock amount is invalid");
  if (input.permanent && input.unlockAt !== 0n) throw new Error("Permanent lock timestamp must be zero");
  if (!input.permanent && input.unlockAt <= 0n) throw new Error("Timed lock timestamp is invalid");
  const [lock, source, beneficiaryAccount] = await Promise.all([
    deriveLiquidityLockAddress(owner, input.nonce),
    deriveAssociatedTokenAddress(owner, mint),
    deriveAssociatedTokenAddress(owner, mint),
  ]);
  const vault = await deriveAssociatedTokenAddress(lock.address, mint);
  const instruction: Instruction = {
    programAddress: ARCH_LOCKER_PROGRAM_ADDRESS,
    accounts: [
      { address: owner, role: AccountRole.WRITABLE_SIGNER },
      { address: owner, role: AccountRole.READONLY_SIGNER },
      { address: mint, role: AccountRole.READONLY },
      { address: source.address, role: AccountRole.WRITABLE },
      { address: beneficiaryAccount.address, role: AccountRole.WRITABLE },
      { address: lock.address, role: AccountRole.WRITABLE },
      { address: vault.address, role: AccountRole.WRITABLE },
      { address: SPL_TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      { address: ASSOCIATED_TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data: concat([
      new Uint8Array(CREATE_LOCK_DISCRIMINATOR),
      u64(input.nonce),
      u64(input.amount),
      new Uint8Array([input.permanent ? 1 : 0]),
      i64(input.unlockAt),
    ]),
  };
  return Object.freeze({ instruction, lock: lock.address, vault: vault.address });
}

export function buildExtendLiquidityLock(beneficiary: string, lock: string, newUnlockAt: bigint): Instruction {
  return {
    programAddress: ARCH_LOCKER_PROGRAM_ADDRESS,
    accounts: [
      { address: address(beneficiary), role: AccountRole.READONLY_SIGNER },
      { address: address(lock), role: AccountRole.WRITABLE },
    ],
    data: concat([new Uint8Array(EXTEND_LOCK_DISCRIMINATOR), i64(newUnlockAt)]),
  };
}

export function buildMakeLiquidityLockPermanent(beneficiary: string, lock: string): Instruction {
  return {
    programAddress: ARCH_LOCKER_PROGRAM_ADDRESS,
    accounts: [
      { address: address(beneficiary), role: AccountRole.READONLY_SIGNER },
      { address: address(lock), role: AccountRole.WRITABLE },
    ],
    data: new Uint8Array(MAKE_PERMANENT_DISCRIMINATOR),
  };
}

export async function buildReleaseLiquidityLock(releaser: string, lock: DecodedLiquidityLock): Promise<Instruction> {
  const beneficiaryAccount = await deriveAssociatedTokenAddress(lock.beneficiary, lock.mint);
  return {
    programAddress: ARCH_LOCKER_PROGRAM_ADDRESS,
    accounts: [
      { address: address(releaser), role: AccountRole.WRITABLE_SIGNER },
      { address: lock.beneficiary, role: AccountRole.READONLY },
      { address: lock.depositor, role: AccountRole.WRITABLE },
      { address: lock.mint, role: AccountRole.READONLY },
      { address: lock.address, role: AccountRole.WRITABLE },
      { address: lock.vault, role: AccountRole.WRITABLE },
      { address: beneficiaryAccount.address, role: AccountRole.WRITABLE },
      { address: SPL_TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      { address: ASSOCIATED_TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data: new Uint8Array(RELEASE_LOCK_DISCRIMINATOR),
  };
}

function readAddress(data: ReadonlyUint8Array, offset: number) {
  return addressDecoder.decode(data.slice(offset, offset + 32));
}

export async function decodeLiquidityLock(input: Readonly<{
  address: string;
  owner: string;
  data: ReadonlyUint8Array;
  slot: Slot;
}>): Promise<DecodedLiquidityLock> {
  if (address(input.owner) !== ARCH_LOCKER_PROGRAM_ADDRESS) throw new Error("Lock owner is invalid");
  if (input.data.length !== LOCK_ACCOUNT_SIZE) throw new Error("Lock account size is invalid");
  if (!LOCK_DISCRIMINATOR.every((value, index) => input.data[index] === value)) {
    throw new Error("Lock account discriminator is invalid");
  }
  const view = new DataView(input.data.buffer, input.data.byteOffset, input.data.byteLength);
  const lockAddress = address(input.address);
  const modeValue = input.data[10];
  if (input.data[8] !== 1 || (modeValue !== 0 && modeValue !== 1)) {
    throw new Error("Lock schema is unsupported");
  }
  const depositor = readAddress(input.data, 11);
  const beneficiary = readAddress(input.data, 43);
  const mint = readAddress(input.data, 75);
  const vault = readAddress(input.data, 107);
  if (readAddress(input.data, 139) !== SPL_TOKEN_PROGRAM_ADDRESS) throw new Error("Lock token program is invalid");
  const nonce = view.getBigUint64(171, true);
  const expectedLock = await deriveLiquidityLockAddress(depositor, nonce);
  const expectedVault = await deriveAssociatedTokenAddress(lockAddress, mint);
  if (lockAddress !== expectedLock.address || input.data[9] !== expectedLock.bump) throw new Error("Lock PDA is invalid");
  if (vault !== expectedVault.address) throw new Error("Lock vault is invalid");
  const unlockAt = view.getBigInt64(195, true);
  if ((modeValue === 1) !== (unlockAt === 0n)) throw new Error("Lock mode and timestamp disagree");
  const principalAmount = view.getBigUint64(179, true);
  const createdAt = view.getBigInt64(187, true);
  if (principalAmount === 0n) throw new Error("Lock principal is invalid");
  if (createdAt <= 0n) throw new Error("Lock creation timestamp is invalid");
  if (modeValue === 0 && unlockAt < createdAt + MIN_LOCK_SECONDS) {
    throw new Error("Timed lock duration is invalid");
  }
  if (input.data.slice(203).some((value) => value !== 0)) {
    throw new Error("Lock reserved bytes are unsupported");
  }
  return Object.freeze({
    address: lockAddress,
    schemaVersion: 1,
    bump: input.data[9]!,
    mode: modeValue === 0 ? "timed" : "permanent",
    depositor,
    beneficiary,
    mint,
    vault,
    nonce,
    principalAmount,
    createdAt,
    unlockAt,
    slot: input.slot,
  });
}



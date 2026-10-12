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
  SOL_QUOTE_MINT_ADDRESS,
  SPL_TOKEN_PROGRAM_ADDRESS,
  SYSTEM_PROGRAM_ADDRESS,
} from "./addresses.js";
import { deriveAssociatedTokenAddress } from "./owned-program-pdas.js";
import {
  getLegacyNativeTokenAccountSurplus,
  type DecodedLegacyTokenAccount,
} from "./legacy-token-accounts.js";

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
const typedArrayTag = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag,
)!.get!;
const typedArrayLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype), "length",
)!.get!;

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
    vault.amount < lock.principalAmount ||
    vault.delegate !== null ||
    vault.delegatedAmount !== 0n ||
    vault.closeAuthority !== null ||
    (vault.nativeRentReserve !== null) !== (lock.mint === SOL_QUOTE_MINT_ADDRESS)
  ) {
    throw new Error("Liquidity lock vault custody does not reconcile");
  }
  if (lock.mint === SOL_QUOTE_MINT_ADDRESS) getLegacyNativeTokenAccountSurplus(vault);
}

function u64(value: bigint) {
  if (typeof value !== "bigint" || value < 0n || value > MAX_U64) throw new Error("Value is outside u64 range");
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return bytes;
}

function i64(value: bigint) {
  if (typeof value !== "bigint" || value < MIN_I64 || value > MAX_I64) throw new Error("Timestamp is outside i64 range");
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
  // Capture request values once. The caller may reuse its object while PDA
  // derivations are pending; validation and instruction data must agree.
  const { owner: ownerValue, mint: mintValue, amount, nonce, permanent, unlockAt } = input;
  const owner = address(ownerValue);
  const mint = address(mintValue);
  if (typeof amount !== "bigint" || amount <= 0n || amount > MAX_U64) throw new Error("Lock amount is invalid");
  if (typeof permanent !== "boolean") throw new Error("Lock mode is invalid");
  const nonceBytes = u64(nonce);
  const unlockAtBytes = i64(unlockAt);
  if (permanent && unlockAt !== 0n) throw new Error("Permanent lock timestamp must be zero");
  if (!permanent && unlockAt <= 0n) throw new Error("Timed lock timestamp is invalid");
  const data = concat([
    new Uint8Array(CREATE_LOCK_DISCRIMINATOR), nonceBytes, u64(amount),
    new Uint8Array([permanent ? 1 : 0]), unlockAtBytes,
  ]);
  const [lock, source] = await Promise.all([
    deriveLiquidityLockAddress(owner, nonce),
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
      { address: source.address, role: AccountRole.WRITABLE },
      { address: lock.address, role: AccountRole.WRITABLE },
      { address: vault.address, role: AccountRole.WRITABLE },
      { address: SPL_TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      { address: ASSOCIATED_TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data,
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
  const { beneficiary: beneficiaryValue, depositor: depositorValue, mint: mintValue,
    address: lockValue, vault: vaultValue } = lock;
  const releaserAddress = address(releaser);
  const beneficiary = address(beneficiaryValue);
  const depositor = address(depositorValue);
  const mint = address(mintValue);
  const lockAddress = address(lockValue);
  const vault = address(vaultValue);
  const beneficiaryAccount = await deriveAssociatedTokenAddress(beneficiary, mint);
  return {
    programAddress: ARCH_LOCKER_PROGRAM_ADDRESS,
    accounts: [
      { address: releaserAddress, role: AccountRole.WRITABLE_SIGNER },
      { address: beneficiary, role: AccountRole.READONLY },
      { address: depositor, role: AccountRole.WRITABLE },
      { address: mint, role: AccountRole.READONLY },
      { address: lockAddress, role: AccountRole.WRITABLE },
      { address: vault, role: AccountRole.WRITABLE },
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
  const { address: accountAddressValue, owner, data: sourceData, slot } = input;
  if (address(owner) !== ARCH_LOCKER_PROGRAM_ADDRESS) throw new Error("Lock owner is invalid");
  // Intrinsic brands accept real Uint8Arrays from other realms while ignoring
  // spoofed toStringTag/length properties on other views or array-like objects.
  if (!ArrayBuffer.isView(sourceData) || typedArrayTag.call(sourceData) !== "Uint8Array" ||
      typedArrayLength.call(sourceData) !== LOCK_ACCOUNT_SIZE) {
    throw new Error("Lock account size is invalid");
  }
  // Uint8Array construction copies Buffer inputs too; Buffer.slice() would
  // retain a view into mutable caller storage across the asynchronous checks.
  const data = new Uint8Array(sourceData);
  if (!LOCK_DISCRIMINATOR.every((value, index) => data[index] === value)) {
    throw new Error("Lock account discriminator is invalid");
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const lockAddress = address(accountAddressValue);
  const modeValue = data[10];
  if (data[8] !== 1 || (modeValue !== 0 && modeValue !== 1)) {
    throw new Error("Lock schema is unsupported");
  }
  const depositor = readAddress(data, 11);
  const beneficiary = readAddress(data, 43);
  const mint = readAddress(data, 75);
  const vault = readAddress(data, 107);
  if (readAddress(data, 139) !== SPL_TOKEN_PROGRAM_ADDRESS) throw new Error("Lock token program is invalid");
  const nonce = view.getBigUint64(171, true);
  const expectedLock = await deriveLiquidityLockAddress(depositor, nonce);
  const expectedVault = await deriveAssociatedTokenAddress(lockAddress, mint);
  if (lockAddress !== expectedLock.address || data[9] !== expectedLock.bump) throw new Error("Lock PDA is invalid");
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
  if (data.slice(203).some((value) => value !== 0)) {
    throw new Error("Lock reserved bytes are unsupported");
  }
  return Object.freeze({
    address: lockAddress,
    schemaVersion: 1,
    bump: data[9]!,
    mode: modeValue === 0 ? "timed" : "permanent",
    depositor,
    beneficiary,
    mint,
    vault,
    nonce,
    principalAmount,
    createdAt,
    unlockAt,
    slot,
  });
}



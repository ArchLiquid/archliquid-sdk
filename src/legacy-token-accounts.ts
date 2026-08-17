import {
  address,
  getAddressDecoder,
  type Address,
  type ReadonlyUint8Array,
} from "@solana/kit";

import {
  SOL_QUOTE_MINT_ADDRESS,
  SPL_TOKEN_PROGRAM_ADDRESS,
} from "./addresses.js";
import type { DecodedCurve, DecodedPool } from "./owned-program-accounts.js";

export const LEGACY_MINT_SIZE = 82;
export const LEGACY_TOKEN_ACCOUNT_SIZE = 165;
const MAX_U64 = (1n << 64n) - 1n;

export type LegacyTokenAccountInput = Readonly<{
  address: string;
  owner: string;
  data: ReadonlyUint8Array;
  lamports?: bigint;
}>;

export type DecodedLegacyMint = Readonly<{
  address: Address;
  mintAuthority: Address | null;
  supply: bigint;
  decimals: number;
  initialized: boolean;
  freezeAuthority: Address | null;
}>;

export type DecodedLegacyTokenAccount = Readonly<{
  address: Address;
  mint: Address;
  authority: Address;
  amount: bigint;
  delegate: Address | null;
  state: "initialized" | "frozen";
  nativeRentReserve: bigint | null;
  delegatedAmount: bigint;
  closeAuthority: Address | null;
  lamports?: bigint;
}>;

const addressDecoder = getAddressDecoder();

class TokenCursor {
  private offset = 0;
  private readonly view: DataView;

  constructor(private readonly data: ReadonlyUint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  private take(length: number) {
    const start = this.offset;
    this.offset += length;
    return this.data.slice(start, this.offset);
  }

  u8() {
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }

  u32() {
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  u64() {
    const value = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    return value;
  }

  address() {
    return addressDecoder.decode(this.take(32));
  }

  optionalAddress(fieldName: string) {
    const tag = this.u32();
    const value = this.address();
    if (tag === 0) return null;
    if (tag === 1) return value;
    throw new Error(`${fieldName} has an invalid COption tag`);
  }

  optionalU64(fieldName: string) {
    const tag = this.u32();
    const value = this.u64();
    if (tag === 0) return null;
    if (tag === 1) return value;
    throw new Error(`${fieldName} has an invalid COption tag`);
  }

  finish() {
    if (this.offset !== this.data.length) throw new Error("Legacy SPL decoder left trailing bytes");
  }
}

function checkedInput(input: LegacyTokenAccountInput, expectedSize: number) {
  const accountAddress = address(input.address);
  const owner = address(input.owner);
  if (owner !== SPL_TOKEN_PROGRAM_ADDRESS) throw new Error("Account is not owned by legacy SPL Token");
  if (input.data.length !== expectedSize) {
    throw new Error(`Invalid legacy SPL account size: expected ${expectedSize}, got ${input.data.length}`);
  }
  if (input.lamports !== undefined && input.lamports < 0n) {
    throw new Error("Account lamports cannot be negative");
  }
  return { accountAddress, cursor: new TokenCursor(input.data) };
}

export function decodeLegacyMint(input: LegacyTokenAccountInput): DecodedLegacyMint {
  const { accountAddress, cursor } = checkedInput(input, LEGACY_MINT_SIZE);
  const decoded = {
    address: accountAddress,
    mintAuthority: cursor.optionalAddress("mint_authority"),
    supply: cursor.u64(),
    decimals: cursor.u8(),
    initialized: cursor.u8() === 1,
    freezeAuthority: cursor.optionalAddress("freeze_authority"),
  };
  cursor.finish();
  if (!decoded.initialized) throw new Error("Legacy SPL mint is not initialized");
  return decoded;
}

export function decodeLegacyTokenAccount(
  input: LegacyTokenAccountInput,
): DecodedLegacyTokenAccount {
  const { accountAddress, cursor } = checkedInput(input, LEGACY_TOKEN_ACCOUNT_SIZE);
  const mint = cursor.address();
  const authority = cursor.address();
  const amount = cursor.u64();
  const delegate = cursor.optionalAddress("delegate");
  const stateValue = cursor.u8();
  const nativeRentReserve = cursor.optionalU64("is_native");
  const delegatedAmount = cursor.u64();
  const closeAuthority = cursor.optionalAddress("close_authority");
  cursor.finish();

  if (stateValue === 0) throw new Error("Legacy SPL token account is not initialized");
  if (stateValue !== 1 && stateValue !== 2) throw new Error("Legacy SPL token account state is invalid");
  if (!delegate && delegatedAmount !== 0n) {
    throw new Error("Legacy SPL token account has delegated amount without a delegate");
  }
  if (
    nativeRentReserve !== null &&
    input.lamports !== undefined &&
    input.lamports !== amount + nativeRentReserve
  ) {
    throw new Error("Native token amount does not reconcile with account lamports");
  }
  return {
    address: accountAddress,
    mint,
    authority,
    amount,
    delegate,
    state: stateValue === 1 ? "initialized" : "frozen",
    nativeRentReserve,
    delegatedAmount,
    closeAuthority,
    ...(input.lamports === undefined ? {} : { lamports: input.lamports }),
  };
}

export function assertFixedSupplyLaunchMint(
  mint: DecodedLegacyMint,
  curve: DecodedCurve,
) {
  assertPermanentlyFixedLegacyMint(mint, curve.baseMint);
  if (mint.supply !== curve.tokenTotalSupply) throw new Error("Launch mint supply does not match Curve");
}

export function assertPermanentlyFixedLegacyMint(
  mint: DecodedLegacyMint,
  expectedAddress: Address,
) {
  if (mint.address !== expectedAddress) throw new Error("Launch mint address is not canonical");
  if (mint.decimals !== 6) throw new Error("Launch mint decimals are unsupported");
  if (mint.mintAuthority || mint.freezeAuthority) {
    throw new Error("Launch mint authorities must be permanently revoked");
  }
}

function checkedAccountingTotal(fieldName: string, ...amounts: bigint[]) {
  const total = amounts.reduce((sum, amount) => sum + amount, 0n);
  if (total > MAX_U64) throw new Error(`${fieldName} accounting exceeds u64`);
  return total;
}

function assertVault(
  fieldName: string,
  tokenAccount: DecodedLegacyTokenAccount,
  expectedAddress: Address,
  expectedMint: Address,
  expectedAuthority: Address,
  minimumAmount: bigint,
  expectNative: boolean,
) {
  if (
    tokenAccount.address !== expectedAddress ||
    tokenAccount.mint !== expectedMint ||
    tokenAccount.authority !== expectedAuthority
  ) {
    throw new Error(`${fieldName} identity does not match decoded program state`);
  }
  if (tokenAccount.state !== "initialized") throw new Error(`${fieldName} is frozen`);
  if (tokenAccount.delegate || tokenAccount.delegatedAmount !== 0n) {
    throw new Error(`${fieldName} cannot have a delegate`);
  }
  if (tokenAccount.closeAuthority) throw new Error(`${fieldName} cannot have a close authority`);
  if ((tokenAccount.nativeRentReserve !== null) !== expectNative) {
    throw new Error(`${fieldName} native-token state does not match its mint`);
  }
  if (expectNative && tokenAccount.lamports === undefined) {
    throw new Error(`${fieldName} requires lamports to verify native-token custody`);
  }
  if (tokenAccount.amount < minimumAmount) {
    throw new Error(`${fieldName} balance is below decoded accounting`);
  }
}

export function assertCurveVaultAccounting(
  curve: DecodedCurve,
  baseVault: DecodedLegacyTokenAccount,
  quoteVault: DecodedLegacyTokenAccount,
) {
  const expectedBase = checkedAccountingTotal(
    "Curve base vault",
    curve.realSaleBaseReserves,
    curve.migrated ? 0n : curve.migrationBaseReserves,
  );
  const expectedQuote = checkedAccountingTotal(
    "Curve quote vault",
    curve.realQuoteReserves,
    curve.creatorQuoteFees,
    curve.protocolQuoteFees,
  );
  assertVault(
    "Curve base vault",
    baseVault,
    curve.baseVault,
    curve.baseMint,
    curve.address,
    expectedBase,
    false,
  );
  assertVault(
    "Curve quote vault",
    quoteVault,
    curve.quoteVault,
    curve.quoteMint,
    curve.address,
    expectedQuote,
    curve.quoteMint === SOL_QUOTE_MINT_ADDRESS,
  );
}

export function assertPoolVaultAccounting(
  pool: DecodedPool,
  baseVault: DecodedLegacyTokenAccount,
  quoteVault: DecodedLegacyTokenAccount,
) {
  const expectedQuote = checkedAccountingTotal(
    "Pool quote vault",
    pool.quoteReserves,
    pool.creatorQuoteFees,
    pool.protocolQuoteFees,
  );
  assertVault(
    "Pool base vault",
    baseVault,
    pool.baseVault,
    pool.baseMint,
    pool.address,
    pool.baseReserves,
    false,
  );
  assertVault(
    "Pool quote vault",
    quoteVault,
    pool.quoteVault,
    pool.quoteMint,
    pool.address,
    expectedQuote,
    pool.quoteMint === SOL_QUOTE_MINT_ADDRESS,
  );
}

export function assertPoolLpMintAccounting(
  pool: DecodedPool,
  lpMint: DecodedLegacyMint,
) {
  if (lpMint.address !== pool.lpMint) throw new Error("Pool LP mint address is not canonical");
  if (lpMint.decimals !== 9) throw new Error("Pool LP mint decimals are unsupported");
  if (lpMint.mintAuthority !== pool.address) {
    throw new Error("Pool LP mint authority is not the canonical pool");
  }
  if (lpMint.freezeAuthority) throw new Error("Pool LP mint cannot have a freeze authority");
  const publicEconomicShares = pool.totalEconomicShares - pool.permanentlyLockedShares;
  if (publicEconomicShares < 0n || lpMint.supply > publicEconomicShares) {
    throw new Error("Pool LP mint supply exceeds public economic shares");
  }
}

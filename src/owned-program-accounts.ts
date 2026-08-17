import {
  address,
  getAddressDecoder,
  type Address,
  type ReadonlyUint8Array,
} from "@solana/kit";

import {
  ARCH_CURVE_PROGRAM_ADDRESS,
  ARCH_SWAP_PROGRAM_ADDRESS,
  SOL_QUOTE_MINT_ADDRESS,
  USDC_QUOTE_MINT_ADDRESS,
  ZERO_ADDRESS,
} from "./addresses.js";
import {
  deriveAssociatedTokenAddress,
  deriveBaseMintAddress,
  deriveCurveAddress,
  deriveLaunchConfigAddress,
  derivePoolAddress,
  derivePoolLpMintAddress,
  deriveProtocolConfigAddress,
  deriveSwapConfigAddress,
} from "./owned-program-pdas.js";

const CURRENT_SCHEMA_VERSION = 1;
const TOKEN_DECIMALS_V1 = 6;
const MAX_FEE_BPS = 1_000;

export const OWNED_ACCOUNT_LAYOUTS = {
  protocolConfig: {
    discriminator: [207, 91, 250, 28, 152, 179, 215, 209],
    size: 331,
  },
  launchConfig: {
    discriminator: [18, 161, 9, 224, 102, 145, 29, 94],
    size: 160,
  },
  curve: {
    discriminator: [191, 180, 249, 66, 180, 71, 51, 182],
    size: 421,
  },
  swapConfig: {
    discriminator: [212, 45, 70, 222, 245, 122, 125, 166],
    size: 202,
  },
  pool: {
    discriminator: [241, 154, 109, 4, 17, 177, 109, 188],
    size: 409,
  },
} as const;

export type QuoteKind = "sol" | "usdc";

export type OwnedAccountInput = Readonly<{
  address: string;
  owner: string;
  data: ReadonlyUint8Array;
}>;

export type LaunchParameters = Readonly<{
  initialVirtualBaseReserves: bigint;
  initialVirtualQuoteReserves: bigint;
  initialSaleBaseReserves: bigint;
  migrationBaseReserves: bigint;
  tokenTotalSupply: bigint;
  tokenDecimals: number;
  curveTotalFeeBps: number;
  curveCreatorFeeBps: number;
  ammReinvestFeeBps: number;
  ammProtocolFeeBps: number;
  ammCreatorFeeBps: number;
}>;

export type DecodedProtocolConfig = Readonly<{
  address: Address;
  version: number;
  bump: number;
  admin: Address;
  pendingAdmin: Address;
  treasury: Address;
  solQuoteMint: Address;
  usdcQuoteMint: Address;
  archSwapProgram: Address;
  activeSolLaunchConfig: Address;
  activeUsdcLaunchConfig: Address;
  launchesEnabled: boolean;
}>;

export type DecodedLaunchConfig = Readonly<{
  address: Address;
  schemaVersion: number;
  bump: number;
  configVersion: number;
  quoteKind: QuoteKind;
  quoteMint: Address;
  parameters: LaunchParameters;
  createdBy: Address;
}>;

export type DecodedCurve = Readonly<{
  address: Address;
  schemaVersion: number;
  bump: number;
  quoteKind: QuoteKind;
  launchNonce: bigint;
  launchConfig: Address;
  creator: Address;
  baseMint: Address;
  quoteMint: Address;
  baseVault: Address;
  quoteVault: Address;
  virtualBaseReserves: bigint;
  virtualQuoteReserves: bigint;
  realSaleBaseReserves: bigint;
  realQuoteReserves: bigint;
  migrationBaseReserves: bigint;
  tokenTotalSupply: bigint;
  creatorQuoteFees: bigint;
  protocolQuoteFees: bigint;
  complete: boolean;
  migrated: boolean;
  archSwapPool: Address;
  metadataCommitment: ReadonlyUint8Array;
  createdSlot: bigint;
  createdUnixTimestamp: bigint;
}>;

export type DecodedSwapConfig = Readonly<{
  address: Address;
  schemaVersion: number;
  bump: number;
  admin: Address;
  pendingAdmin: Address;
  archCurveProgram: Address;
  treasury: Address;
}>;

export type PoolFees = Readonly<{
  reinvestFeeBps: number;
  protocolFeeBps: number;
  creatorFeeBps: number;
}>;

export type DecodedPool = Readonly<{
  address: Address;
  schemaVersion: number;
  bump: number;
  swapConfig: Address;
  creator: Address;
  curveAuthority: Address;
  baseMint: Address;
  quoteMint: Address;
  baseVault: Address;
  quoteVault: Address;
  lpMint: Address;
  lpMintBump: number;
  baseReserves: bigint;
  quoteReserves: bigint;
  creatorQuoteFees: bigint;
  protocolQuoteFees: bigint;
  initialLockedBase: bigint;
  initialLockedQuote: bigint;
  totalEconomicShares: bigint;
  permanentlyLockedShares: bigint;
  fees: PoolFees;
  createdSlot: bigint;
}>;

const addressDecoder = getAddressDecoder();

class AccountCursor {
  private offset = 0;
  private readonly view: DataView;

  constructor(private readonly data: ReadonlyUint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  private take(length: number) {
    if (this.offset + length > this.data.length) throw new Error("Account data is truncated");
    const start = this.offset;
    this.offset += length;
    return this.data.slice(start, this.offset);
  }

  bytes(length: number) {
    return this.take(length);
  }

  u8() {
    return this.view.getUint8(this.offset++);
  }

  u16() {
    const value = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return value;
  }

  u64() {
    const value = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    return value;
  }

  i64() {
    const value = this.view.getBigInt64(this.offset, true);
    this.offset += 8;
    return value;
  }

  bool(fieldName: string) {
    const value = this.u8();
    if (value !== 0 && value !== 1) throw new Error(`${fieldName} is not a canonical bool`);
    return value === 1;
  }

  quoteKind() {
    const value = this.u8();
    if (value === 0) return "sol" as const;
    if (value === 1) return "usdc" as const;
    throw new Error(`Unknown quote kind: ${value}`);
  }

  address() {
    return addressDecoder.decode(this.take(32));
  }

  finish() {
    if (this.offset !== this.data.length) {
      throw new Error(`Account decoder left ${this.data.length - this.offset} trailing bytes`);
    }
  }
}

function bytesEqual(left: readonly number[], right: ReadonlyUint8Array) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertZeroBytes(fieldName: string, bytes: ReadonlyUint8Array) {
  if (bytes.some((value) => value !== 0)) throw new Error(`${fieldName} must remain zeroed`);
}

function assertNotZero(fieldName: string, value: Address) {
  if (value === ZERO_ADDRESS) throw new Error(`${fieldName} cannot be the default address`);
}

function assertSchemaVersion(fieldName: string, version: number) {
  if (version !== CURRENT_SCHEMA_VERSION) {
    throw new Error(`${fieldName} schema version ${version} is unsupported`);
  }
}

function assertCanonicalQuote(quoteKind: QuoteKind, quoteMint: Address) {
  const expected = quoteKind === "sol" ? SOL_QUOTE_MINT_ADDRESS : USDC_QUOTE_MINT_ADDRESS;
  if (quoteMint !== expected) throw new Error(`${quoteKind.toUpperCase()} quote mint is not canonical`);
}

function checkedEnvelope(
  input: OwnedAccountInput,
  expectedOwner: Address,
  discriminator: readonly number[],
  size: number,
) {
  const accountAddress = address(input.address);
  const owner = address(input.owner);
  if (owner !== expectedOwner) throw new Error(`Unexpected account owner: ${owner}`);
  if (input.data.length !== size) {
    throw new Error(`Invalid account data length: expected ${size}, got ${input.data.length}`);
  }
  if (!bytesEqual(discriminator, input.data.slice(0, 8))) {
    throw new Error("Unexpected Anchor account discriminator");
  }
  return { accountAddress, cursor: new AccountCursor(input.data.slice(8)) };
}

function decodeLaunchParameters(cursor: AccountCursor): LaunchParameters {
  return {
    initialVirtualBaseReserves: cursor.u64(),
    initialVirtualQuoteReserves: cursor.u64(),
    initialSaleBaseReserves: cursor.u64(),
    migrationBaseReserves: cursor.u64(),
    tokenTotalSupply: cursor.u64(),
    tokenDecimals: cursor.u8(),
    curveTotalFeeBps: cursor.u16(),
    curveCreatorFeeBps: cursor.u16(),
    ammReinvestFeeBps: cursor.u16(),
    ammProtocolFeeBps: cursor.u16(),
    ammCreatorFeeBps: cursor.u16(),
  };
}

function assertLaunchParameters(parameters: LaunchParameters) {
  if (
    parameters.initialVirtualBaseReserves <= parameters.initialSaleBaseReserves ||
    parameters.initialVirtualQuoteReserves === 0n
  ) {
    throw new Error("Launch virtual reserves are invalid");
  }
  if (
    parameters.initialSaleBaseReserves === 0n ||
    parameters.migrationBaseReserves === 0n ||
    parameters.initialSaleBaseReserves + parameters.migrationBaseReserves !==
      parameters.tokenTotalSupply
  ) {
    throw new Error("Launch token allocation is invalid");
  }
  if (parameters.tokenDecimals !== TOKEN_DECIMALS_V1) {
    throw new Error("Launch token decimals are unsupported");
  }
  if (
    parameters.curveTotalFeeBps > MAX_FEE_BPS ||
    parameters.curveCreatorFeeBps > parameters.curveTotalFeeBps ||
    parameters.ammReinvestFeeBps +
      parameters.ammProtocolFeeBps +
      parameters.ammCreatorFeeBps >
      MAX_FEE_BPS
  ) {
    throw new Error("Launch fee basis points are invalid");
  }
}

export async function decodeProtocolConfigAccount(
  input: OwnedAccountInput,
): Promise<DecodedProtocolConfig> {
  const layout = OWNED_ACCOUNT_LAYOUTS.protocolConfig;
  const { accountAddress, cursor } = checkedEnvelope(
    input,
    ARCH_CURVE_PROGRAM_ADDRESS,
    layout.discriminator,
    layout.size,
  );
  const decoded = {
    address: accountAddress,
    version: cursor.u8(),
    bump: cursor.u8(),
    admin: cursor.address(),
    pendingAdmin: cursor.address(),
    treasury: cursor.address(),
    solQuoteMint: cursor.address(),
    usdcQuoteMint: cursor.address(),
    archSwapProgram: cursor.address(),
    activeSolLaunchConfig: cursor.address(),
    activeUsdcLaunchConfig: cursor.address(),
    launchesEnabled: cursor.bool("launches_enabled"),
  };
  assertZeroBytes("ProtocolConfig.reserved", cursor.bytes(64));
  cursor.finish();

  const expected = await deriveProtocolConfigAddress();
  if (decoded.address !== expected.address || decoded.bump !== expected.bump) {
    throw new Error("ProtocolConfig PDA or bump is not canonical");
  }
  assertSchemaVersion("ProtocolConfig", decoded.version);
  assertNotZero("ProtocolConfig.admin", decoded.admin);
  assertNotZero("ProtocolConfig.treasury", decoded.treasury);
  if (decoded.solQuoteMint !== SOL_QUOTE_MINT_ADDRESS) {
    throw new Error("ProtocolConfig SOL mint is not canonical");
  }
  if (decoded.usdcQuoteMint !== USDC_QUOTE_MINT_ADDRESS) {
    throw new Error("ProtocolConfig USDC mint is not canonical");
  }
  if (decoded.archSwapProgram !== ARCH_SWAP_PROGRAM_ADDRESS) {
    throw new Error("ProtocolConfig ArchSwap program is not canonical");
  }
  if (
    decoded.launchesEnabled &&
    (decoded.activeSolLaunchConfig === ZERO_ADDRESS ||
      decoded.activeUsdcLaunchConfig === ZERO_ADDRESS)
  ) {
    throw new Error("Enabled launches require both active launch configs");
  }
  return decoded;
}

export async function decodeLaunchConfigAccount(
  input: OwnedAccountInput,
): Promise<DecodedLaunchConfig> {
  const layout = OWNED_ACCOUNT_LAYOUTS.launchConfig;
  const { accountAddress, cursor } = checkedEnvelope(
    input,
    ARCH_CURVE_PROGRAM_ADDRESS,
    layout.discriminator,
    layout.size,
  );
  const decoded = {
    address: accountAddress,
    schemaVersion: cursor.u8(),
    bump: cursor.u8(),
    configVersion: cursor.u16(),
    quoteKind: cursor.quoteKind(),
    quoteMint: cursor.address(),
    parameters: decodeLaunchParameters(cursor),
    createdBy: cursor.address(),
  };
  assertZeroBytes("LaunchConfig.reserved", cursor.bytes(32));
  cursor.finish();

  const expected = await deriveLaunchConfigAddress(decoded.quoteMint, decoded.configVersion);
  if (decoded.address !== expected.address || decoded.bump !== expected.bump) {
    throw new Error("LaunchConfig PDA or bump is not canonical");
  }
  assertSchemaVersion("LaunchConfig", decoded.schemaVersion);
  if (decoded.configVersion === 0) throw new Error("LaunchConfig version must be nonzero");
  assertCanonicalQuote(decoded.quoteKind, decoded.quoteMint);
  assertLaunchParameters(decoded.parameters);
  assertNotZero("LaunchConfig.created_by", decoded.createdBy);
  return decoded;
}

export async function decodeCurveAccount(
  input: OwnedAccountInput,
  launchConfig: DecodedLaunchConfig,
): Promise<DecodedCurve> {
  const layout = OWNED_ACCOUNT_LAYOUTS.curve;
  const { accountAddress, cursor } = checkedEnvelope(
    input,
    ARCH_CURVE_PROGRAM_ADDRESS,
    layout.discriminator,
    layout.size,
  );
  const decoded = {
    address: accountAddress,
    schemaVersion: cursor.u8(),
    bump: cursor.u8(),
    quoteKind: cursor.quoteKind(),
    launchNonce: cursor.u64(),
    launchConfig: cursor.address(),
    creator: cursor.address(),
    baseMint: cursor.address(),
    quoteMint: cursor.address(),
    baseVault: cursor.address(),
    quoteVault: cursor.address(),
    virtualBaseReserves: cursor.u64(),
    virtualQuoteReserves: cursor.u64(),
    realSaleBaseReserves: cursor.u64(),
    realQuoteReserves: cursor.u64(),
    migrationBaseReserves: cursor.u64(),
    tokenTotalSupply: cursor.u64(),
    creatorQuoteFees: cursor.u64(),
    protocolQuoteFees: cursor.u64(),
    complete: cursor.bool("complete"),
    migrated: cursor.bool("migrated"),
    archSwapPool: cursor.address(),
    metadataCommitment: cursor.bytes(32),
    createdSlot: cursor.u64(),
    createdUnixTimestamp: cursor.i64(),
  };
  assertZeroBytes("Curve.reserved", cursor.bytes(64));
  cursor.finish();

  const [expectedCurve, expectedMint, expectedBaseVault, expectedQuoteVault] =
    await Promise.all([
      deriveCurveAddress(decoded.baseMint),
      deriveBaseMintAddress(decoded.creator, decoded.launchNonce),
      deriveAssociatedTokenAddress(decoded.address, decoded.baseMint),
      deriveAssociatedTokenAddress(decoded.address, decoded.quoteMint),
    ]);
  if (decoded.address !== expectedCurve.address || decoded.bump !== expectedCurve.bump) {
    throw new Error("Curve PDA or bump is not canonical");
  }
  if (decoded.baseMint !== expectedMint.address) throw new Error("Curve base mint PDA is not canonical");
  if (decoded.baseVault !== expectedBaseVault.address) throw new Error("Curve base vault ATA is not canonical");
  if (decoded.quoteVault !== expectedQuoteVault.address) throw new Error("Curve quote vault ATA is not canonical");
  assertSchemaVersion("Curve", decoded.schemaVersion);
  assertNotZero("Curve.creator", decoded.creator);
  assertCanonicalQuote(decoded.quoteKind, decoded.quoteMint);
  if (
    decoded.launchConfig !== launchConfig.address ||
    decoded.quoteKind !== launchConfig.quoteKind ||
    decoded.quoteMint !== launchConfig.quoteMint
  ) {
    throw new Error("Curve does not match its decoded LaunchConfig");
  }
  if (
    decoded.migrationBaseReserves !== launchConfig.parameters.migrationBaseReserves ||
    decoded.tokenTotalSupply !== launchConfig.parameters.tokenTotalSupply ||
    decoded.realSaleBaseReserves > launchConfig.parameters.initialSaleBaseReserves
  ) {
    throw new Error("Curve allocation does not match its LaunchConfig");
  }
  if (decoded.virtualBaseReserves === 0n || decoded.virtualQuoteReserves === 0n) {
    throw new Error("Curve virtual reserves are invalid");
  }
  if (decoded.complete !== (decoded.realSaleBaseReserves === 0n)) {
    throw new Error("Curve completion flag does not match sale reserves");
  }
  if (decoded.migrated) {
    const expectedPool = await derivePoolAddress(decoded.baseMint, decoded.quoteMint);
    if (!decoded.complete || decoded.realQuoteReserves !== 0n) {
      throw new Error("Migrated Curve must be complete with zero real quote reserves");
    }
    if (decoded.archSwapPool !== expectedPool.address) {
      throw new Error("Curve ArchSwap pool is not canonical");
    }
  } else if (decoded.archSwapPool !== ZERO_ADDRESS) {
    throw new Error("Unmigrated Curve cannot record an ArchSwap pool");
  }
  if (decoded.metadataCommitment.every((value) => value === 0)) {
    throw new Error("Curve metadata commitment cannot be empty");
  }
  return decoded;
}

export async function decodeSwapConfigAccount(
  input: OwnedAccountInput,
): Promise<DecodedSwapConfig> {
  const layout = OWNED_ACCOUNT_LAYOUTS.swapConfig;
  const { accountAddress, cursor } = checkedEnvelope(
    input,
    ARCH_SWAP_PROGRAM_ADDRESS,
    layout.discriminator,
    layout.size,
  );
  const decoded = {
    address: accountAddress,
    schemaVersion: cursor.u8(),
    bump: cursor.u8(),
    admin: cursor.address(),
    pendingAdmin: cursor.address(),
    archCurveProgram: cursor.address(),
    treasury: cursor.address(),
  };
  assertZeroBytes("SwapConfig.reserved", cursor.bytes(64));
  cursor.finish();

  const expected = await deriveSwapConfigAddress();
  if (decoded.address !== expected.address || decoded.bump !== expected.bump) {
    throw new Error("SwapConfig PDA or bump is not canonical");
  }
  assertSchemaVersion("SwapConfig", decoded.schemaVersion);
  assertNotZero("SwapConfig.admin", decoded.admin);
  assertNotZero("SwapConfig.treasury", decoded.treasury);
  if (decoded.archCurveProgram !== ARCH_CURVE_PROGRAM_ADDRESS) {
    throw new Error("SwapConfig ArchCurve program is not canonical");
  }
  return decoded;
}

export async function decodePoolAccount(
  input: OwnedAccountInput,
  swapConfig: DecodedSwapConfig,
): Promise<DecodedPool> {
  const layout = OWNED_ACCOUNT_LAYOUTS.pool;
  const { accountAddress, cursor } = checkedEnvelope(
    input,
    ARCH_SWAP_PROGRAM_ADDRESS,
    layout.discriminator,
    layout.size,
  );
  const decoded = {
    address: accountAddress,
    schemaVersion: cursor.u8(),
    bump: cursor.u8(),
    swapConfig: cursor.address(),
    creator: cursor.address(),
    curveAuthority: cursor.address(),
    baseMint: cursor.address(),
    quoteMint: cursor.address(),
    baseVault: cursor.address(),
    quoteVault: cursor.address(),
    lpMint: cursor.address(),
    lpMintBump: cursor.u8(),
    baseReserves: cursor.u64(),
    quoteReserves: cursor.u64(),
    creatorQuoteFees: cursor.u64(),
    protocolQuoteFees: cursor.u64(),
    initialLockedBase: cursor.u64(),
    initialLockedQuote: cursor.u64(),
    totalEconomicShares: cursor.u64(),
    permanentlyLockedShares: cursor.u64(),
    fees: {
      reinvestFeeBps: cursor.u16(),
      protocolFeeBps: cursor.u16(),
      creatorFeeBps: cursor.u16(),
    },
    createdSlot: cursor.u64(),
  };
  assertZeroBytes("Pool.reserved", cursor.bytes(64));
  cursor.finish();

  const [expectedPool, expectedCurve, expectedBaseVault, expectedQuoteVault, expectedLpMint] =
    await Promise.all([
      derivePoolAddress(decoded.baseMint, decoded.quoteMint),
      deriveCurveAddress(decoded.baseMint),
      deriveAssociatedTokenAddress(decoded.address, decoded.baseMint),
      deriveAssociatedTokenAddress(decoded.address, decoded.quoteMint),
      derivePoolLpMintAddress(decoded.address),
    ]);
  if (decoded.address !== expectedPool.address || decoded.bump !== expectedPool.bump) {
    throw new Error("Pool PDA or bump is not canonical");
  }
  if (decoded.swapConfig !== swapConfig.address) throw new Error("Pool SwapConfig is not canonical");
  if (decoded.curveAuthority !== expectedCurve.address) throw new Error("Pool Curve authority is not canonical");
  if (decoded.baseVault !== expectedBaseVault.address) throw new Error("Pool base vault ATA is not canonical");
  if (decoded.quoteVault !== expectedQuoteVault.address) throw new Error("Pool quote vault ATA is not canonical");
  if (decoded.lpMint !== expectedLpMint.address || decoded.lpMintBump !== expectedLpMint.bump) {
    throw new Error("Pool LP mint PDA or bump is not canonical");
  }
  assertSchemaVersion("Pool", decoded.schemaVersion);
  assertNotZero("Pool.creator", decoded.creator);
  if (decoded.baseMint === decoded.quoteMint) throw new Error("Pool mints must be distinct");
  if (
    decoded.quoteMint !== SOL_QUOTE_MINT_ADDRESS &&
    decoded.quoteMint !== USDC_QUOTE_MINT_ADDRESS
  ) {
    throw new Error("Pool quote mint is not canonical");
  }
  if (
    decoded.baseReserves === 0n ||
    decoded.quoteReserves === 0n ||
    decoded.initialLockedBase === 0n ||
    decoded.initialLockedQuote === 0n ||
    decoded.permanentlyLockedShares === 0n ||
    decoded.totalEconomicShares < decoded.permanentlyLockedShares
  ) {
    throw new Error("Pool liquidity must remain nonzero");
  }
  if (
    decoded.fees.reinvestFeeBps +
      decoded.fees.protocolFeeBps +
      decoded.fees.creatorFeeBps >
    MAX_FEE_BPS
  ) {
    throw new Error("Pool fee basis points are invalid");
  }
  return decoded;
}

export function assertProtocolSwapRelationship(
  protocol: DecodedProtocolConfig,
  swapConfig: DecodedSwapConfig,
) {
  if (
    protocol.archSwapProgram !== ARCH_SWAP_PROGRAM_ADDRESS ||
    swapConfig.archCurveProgram !== ARCH_CURVE_PROGRAM_ADDRESS ||
    protocol.treasury !== swapConfig.treasury
  ) {
    throw new Error("ArchCurve and ArchSwap configuration relationship is invalid");
  }
}

export function assertLaunchConfigActive(
  protocol: DecodedProtocolConfig,
  launchConfig: DecodedLaunchConfig,
) {
  const active =
    launchConfig.quoteKind === "sol"
      ? protocol.activeSolLaunchConfig
      : protocol.activeUsdcLaunchConfig;
  if (active !== launchConfig.address) throw new Error("LaunchConfig is not active");
}

export async function deriveCurveTradeAccountMap(curve: DecodedCurve, traderValue: string) {
  const trader = address(traderValue);
  assertNotZero("trader", trader);
  const [traderBase, traderQuote] = await Promise.all([
    deriveAssociatedTokenAddress(trader, curve.baseMint),
    deriveAssociatedTokenAddress(trader, curve.quoteMint),
  ]);
  return {
    curve: curve.address,
    launch_config: curve.launchConfig,
    base_mint: curve.baseMint,
    quote_mint: curve.quoteMint,
    base_vault: curve.baseVault,
    quote_vault: curve.quoteVault,
    trader_base_account: traderBase.address,
    trader_quote_account: traderQuote.address,
    trader,
  } as const;
}

export async function deriveCurveCreatorClaimAccountMap(curve: DecodedCurve) {
  const creatorQuote = await deriveAssociatedTokenAddress(curve.creator, curve.quoteMint);
  return {
    curve: curve.address,
    quote_mint: curve.quoteMint,
    quote_vault: curve.quoteVault,
    creator_quote_account: creatorQuote.address,
  } as const;
}

export async function deriveCurveProtocolClaimAccountMap(
  curve: DecodedCurve,
  protocol: DecodedProtocolConfig,
) {
  const treasuryQuote = await deriveAssociatedTokenAddress(protocol.treasury, curve.quoteMint);
  return {
    protocol_config: protocol.address,
    curve: curve.address,
    quote_mint: curve.quoteMint,
    quote_vault: curve.quoteVault,
    treasury_quote_account: treasuryQuote.address,
  } as const;
}

export async function deriveCurveMigrationAccountMap(
  curve: DecodedCurve,
  protocol: DecodedProtocolConfig,
  swapConfig: DecodedSwapConfig,
  payerValue: string,
) {
  assertProtocolSwapRelationship(protocol, swapConfig);
  const payer = address(payerValue);
  assertNotZero("payer", payer);
  const pool = await derivePoolAddress(curve.baseMint, curve.quoteMint);
  const lpMint = await derivePoolLpMintAddress(pool.address);
  const [poolBaseVault, poolQuoteVault, initialLpTokenAccount] = await Promise.all([
    deriveAssociatedTokenAddress(pool.address, curve.baseMint),
    deriveAssociatedTokenAddress(pool.address, curve.quoteMint),
    deriveAssociatedTokenAddress(pool.address, lpMint.address),
  ]);
  return {
    protocol_config: protocol.address,
    launch_config: curve.launchConfig,
    curve: curve.address,
    base_mint: curve.baseMint,
    quote_mint: curve.quoteMint,
    base_vault: curve.baseVault,
    quote_vault: curve.quoteVault,
    swap_config: swapConfig.address,
    arch_swap_pool: pool.address,
    arch_swap_base_vault: poolBaseVault.address,
    arch_swap_quote_vault: poolQuoteVault.address,
    arch_swap_lp_mint: lpMint.address,
    arch_swap_initial_lp_token_account: initialLpTokenAccount.address,
    payer,
  } as const;
}

export async function derivePoolLiquidityAccountMap(pool: DecodedPool, providerValue: string) {
  const provider = address(providerValue);
  assertNotZero("provider", provider);
  const [providerBase, providerQuote, providerLp] = await Promise.all([
    deriveAssociatedTokenAddress(provider, pool.baseMint),
    deriveAssociatedTokenAddress(provider, pool.quoteMint),
    deriveAssociatedTokenAddress(provider, pool.lpMint),
  ]);
  return {
    pool: pool.address,
    base_mint: pool.baseMint,
    quote_mint: pool.quoteMint,
    lp_mint: pool.lpMint,
    base_vault: pool.baseVault,
    quote_vault: pool.quoteVault,
    provider_base_account: providerBase.address,
    provider_quote_account: providerQuote.address,
    provider_lp_account: providerLp.address,
    provider,
  } as const;
}

export async function derivePoolTradeAccountMap(pool: DecodedPool, traderValue: string) {
  const trader = address(traderValue);
  assertNotZero("trader", trader);
  const [traderBase, traderQuote] = await Promise.all([
    deriveAssociatedTokenAddress(trader, pool.baseMint),
    deriveAssociatedTokenAddress(trader, pool.quoteMint),
  ]);
  return {
    pool: pool.address,
    base_mint: pool.baseMint,
    quote_mint: pool.quoteMint,
    base_vault: pool.baseVault,
    quote_vault: pool.quoteVault,
    trader_base_account: traderBase.address,
    trader_quote_account: traderQuote.address,
    trader,
  } as const;
}

export async function derivePoolCreatorClaimAccountMap(pool: DecodedPool) {
  const creatorQuote = await deriveAssociatedTokenAddress(pool.creator, pool.quoteMint);
  return {
    pool: pool.address,
    base_mint: pool.baseMint,
    quote_mint: pool.quoteMint,
    quote_vault: pool.quoteVault,
    creator_quote_account: creatorQuote.address,
  } as const;
}

export async function derivePoolProtocolClaimAccountMap(
  pool: DecodedPool,
  swapConfig: DecodedSwapConfig,
) {
  const treasuryQuote = await deriveAssociatedTokenAddress(swapConfig.treasury, pool.quoteMint);
  return {
    swap_config: swapConfig.address,
    pool: pool.address,
    base_mint: pool.baseMint,
    quote_mint: pool.quoteMint,
    quote_vault: pool.quoteVault,
    treasury_quote_account: treasuryQuote.address,
  } as const;
}

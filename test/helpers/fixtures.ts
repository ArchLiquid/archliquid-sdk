import assert from "node:assert/strict";
import {
  address,
  getAddressEncoder,
  getProgramDerivedAddress,
  type Address,
  type ReadonlyUint8Array,
} from "@solana/kit";
import {
  ARCH_CURVE_PROGRAM_ADDRESS,
  ARCH_SWAP_PROGRAM_ADDRESS,
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  SOL_QUOTE_MINT_ADDRESS,
  SPL_TOKEN_PROGRAM_ADDRESS,
  USDC_QUOTE_MINT_ADDRESS,
  ZERO_ADDRESS,
} from "../../src/addresses.js";

export const CREATOR = address("DNpZ267hQULthYFmPkXpjJsc2jv2jbYhW5zRNdPEEh7W");
export const TREASURY = address("85SWK59vHsVv8buEnSzhbLxnSe6o9g2Cca3JbMkSB427");
const encoder = getAddressEncoder();

/** Test-only wire writer. Field order and sizes come from committed IDLs, not SDK decoders. */
export class WireWriter {
  readonly data: Uint8Array;
  readonly offsets: Record<string, number> = {};
  private readonly view: DataView;
  private offset = 0;

  constructor(size: number) {
    this.data = new Uint8Array(size);
    this.view = new DataView(this.data.buffer);
  }

  raw(name: string, value: ArrayLike<number>) {
    this.offsets[name] = this.offset;
    this.data.set(value, this.offset);
    this.offset += value.length;
    return this;
  }

  u8(name: string, value: number) { return this.raw(name, [value]); }
  u16(name: string, value: number) {
    this.offsets[name] = this.offset;
    this.view.setUint16(this.offset, value, true);
    this.offset += 2;
    return this;
  }
  u32(name: string, value: number) {
    this.offsets[name] = this.offset;
    this.view.setUint32(this.offset, value, true);
    this.offset += 4;
    return this;
  }
  u64(name: string, value: bigint) {
    this.offsets[name] = this.offset;
    this.view.setBigUint64(this.offset, value, true);
    this.offset += 8;
    return this;
  }
  i64(name: string, value: bigint) {
    this.offsets[name] = this.offset;
    this.view.setBigInt64(this.offset, value, true);
    this.offset += 8;
    return this;
  }
  address(name: string, value: Address) { return this.raw(name, encoder.encode(value)); }
  optionalAddress(name: string, value: Address | null) {
    return this.u32(`${name}Tag`, value === null ? 0 : 1).address(name, value ?? ZERO_ADDRESS);
  }
  finish() {
    assert.equal(this.offset, this.data.length, "Fixture must fill its exact wire layout");
    return { data: this.data, offsets: this.offsets };
  }
}

export type AccountFixture = Readonly<{
  address: Address;
  owner: Address;
  data: Uint8Array;
  offsets: Readonly<Record<string, number>>;
}>;

export function mutate(
  fixture: AccountFixture,
  field: string,
  value: number | bigint | Address | ReadonlyUint8Array,
  width: "u8" | "u16" | "u32" | "u64" = "u8",
): AccountFixture {
  const data = fixture.data.slice();
  const offset = fixture.offsets[field];
  assert.notEqual(offset, undefined, `Unknown fixture field ${field}`);
  const view = new DataView(data.buffer);
  if (typeof value === "string") data.set(encoder.encode(value), offset!);
  else if (typeof value === "bigint") view.setBigUint64(offset!, value, true);
  else if (typeof value !== "number") data.set(value, offset!);
  else if (width === "u16") view.setUint16(offset!, value, true);
  else if (width === "u32") view.setUint32(offset!, value, true);
  else view.setUint8(offset!, value);
  return { ...fixture, data };
}

export function offsetView(data: Uint8Array) {
  const buffer = new Uint8Array(data.length + 13).fill(0xff);
  buffer.set(data, 7);
  return buffer.subarray(7, 7 + data.length);
}

function integerSeed(value: number | bigint, size: number) {
  const data = new Uint8Array(size);
  const view = new DataView(data.buffer);
  if (typeof value === "number") view.setUint16(0, value, true);
  else view.setBigUint64(0, value, true);
  return data;
}

// Independent seed construction lets these fixtures detect regressions in the SDK PDA helpers.
async function pda(programAddress: Address, seeds: (string | ReadonlyUint8Array)[]) {
  const [address, bump] = await getProgramDerivedAddress({ programAddress, seeds });
  return { address, bump };
}
async function ata(owner: Address, mint: Address) {
  return pda(ASSOCIATED_TOKEN_PROGRAM_ADDRESS, [
    encoder.encode(owner), encoder.encode(SPL_TOKEN_PROGRAM_ADDRESS), encoder.encode(mint),
  ]);
}

/** Synthetic valid v1 accounts encoded independently from IDL field order. No network state. */
export async function makeProgramFixtures(quoteKind: "sol" | "usdc" = "sol") {
  const quoteMint = quoteKind === "sol" ? SOL_QUOTE_MINT_ADDRESS : USDC_QUOTE_MINT_ADDRESS;
  const nonce = 91n;
  const configVersion = 7;
  const [protocol, swap, solLaunch, usdcLaunch, baseMint] = await Promise.all([
    pda(ARCH_CURVE_PROGRAM_ADDRESS, ["protocol-config"]),
    pda(ARCH_SWAP_PROGRAM_ADDRESS, ["swap-config"]),
    pda(ARCH_CURVE_PROGRAM_ADDRESS, ["launch-config", encoder.encode(SOL_QUOTE_MINT_ADDRESS), integerSeed(configVersion, 2)]),
    pda(ARCH_CURVE_PROGRAM_ADDRESS, ["launch-config", encoder.encode(USDC_QUOTE_MINT_ADDRESS), integerSeed(configVersion, 2)]),
    pda(ARCH_CURVE_PROGRAM_ADDRESS, ["base-mint", encoder.encode(CREATOR), integerSeed(nonce, 8)]),
  ]);
  const launch = quoteKind === "sol" ? solLaunch : usdcLaunch;
  const [curve, pool] = await Promise.all([
    pda(ARCH_CURVE_PROGRAM_ADDRESS, ["curve", encoder.encode(baseMint.address)]),
    pda(ARCH_SWAP_PROGRAM_ADDRESS, ["pool", encoder.encode(baseMint.address), encoder.encode(quoteMint)]),
  ]);
  const [curveBase, curveQuote, poolBase, poolQuote, lpMint] = await Promise.all([
    ata(curve.address, baseMint.address), ata(curve.address, quoteMint),
    ata(pool.address, baseMint.address), ata(pool.address, quoteMint),
    pda(ARCH_SWAP_PROGRAM_ADDRESS, ["pool-lp-mint", encoder.encode(pool.address)]),
  ]);
  const envelope = (derived: { address: Address }, owner: Address, writer: WireWriter) =>
    ({ address: derived.address, owner, ...writer.finish() });
  const protocolInput = envelope(protocol, ARCH_CURVE_PROGRAM_ADDRESS, new WireWriter(331)
    .raw("discriminator", [207, 91, 250, 28, 152, 179, 215, 209])
    .u8("version", 1).u8("bump", protocol.bump)
    .address("admin", CREATOR).address("pendingAdmin", ZERO_ADDRESS).address("treasury", TREASURY)
    .address("solQuoteMint", SOL_QUOTE_MINT_ADDRESS).address("usdcQuoteMint", USDC_QUOTE_MINT_ADDRESS)
    .address("archSwapProgram", ARCH_SWAP_PROGRAM_ADDRESS)
    .address("activeSolLaunchConfig", solLaunch.address).address("activeUsdcLaunchConfig", usdcLaunch.address)
    .u8("launchesEnabled", 1).raw("reserved", new Uint8Array(64)));
  const launchInput = envelope(launch, ARCH_CURVE_PROGRAM_ADDRESS, new WireWriter(160)
    .raw("discriminator", [18, 161, 9, 224, 102, 145, 29, 94])
    .u8("schemaVersion", 1).u8("bump", launch.bump).u16("configVersion", configVersion)
    .u8("quoteKind", quoteKind === "sol" ? 0 : 1).address("quoteMint", quoteMint)
    .u64("initialVirtualBaseReserves", 1_000_000n).u64("initialVirtualQuoteReserves", 50_000n)
    .u64("initialSaleBaseReserves", 800_000n).u64("migrationBaseReserves", 200_000n)
    .u64("tokenTotalSupply", 1_000_000n).u8("tokenDecimals", 6)
    .u16("curveTotalFeeBps", 100).u16("curveCreatorFeeBps", 25)
    .u16("ammReinvestFeeBps", 20).u16("ammProtocolFeeBps", 30).u16("ammCreatorFeeBps", 10)
    .address("createdBy", CREATOR).raw("reserved", new Uint8Array(32)));
  const curveInput = envelope(curve, ARCH_CURVE_PROGRAM_ADDRESS, new WireWriter(421)
    .raw("discriminator", [191, 180, 249, 66, 180, 71, 51, 182])
    .u8("schemaVersion", 1).u8("bump", curve.bump).u8("quoteKind", quoteKind === "sol" ? 0 : 1)
    .u64("launchNonce", nonce).address("launchConfig", launch.address).address("creator", CREATOR)
    .address("baseMint", baseMint.address).address("quoteMint", quoteMint)
    .address("baseVault", curveBase.address).address("quoteVault", curveQuote.address)
    .u64("virtualBaseReserves", 950_000n).u64("virtualQuoteReserves", 52_700n)
    .u64("realSaleBaseReserves", 750_000n).u64("realQuoteReserves", 2_700n)
    .u64("migrationBaseReserves", 200_000n).u64("tokenTotalSupply", 1_000_000n)
    .u64("creatorQuoteFees", 30n).u64("protocolQuoteFees", 70n)
    .u8("complete", 0).u8("migrated", 0).address("archSwapPool", ZERO_ADDRESS)
    .raw("metadataCommitment", new Uint8Array(32).fill(1))
    .u64("createdSlot", 10n).i64("createdUnixTimestamp", 1_700_000_000n)
    .raw("reserved", new Uint8Array(64)));
  const swapInput = envelope(swap, ARCH_SWAP_PROGRAM_ADDRESS, new WireWriter(202)
    .raw("discriminator", [212, 45, 70, 222, 245, 122, 125, 166])
    .u8("schemaVersion", 1).u8("bump", swap.bump)
    .address("admin", CREATOR).address("pendingAdmin", ZERO_ADDRESS)
    .address("archCurveProgram", ARCH_CURVE_PROGRAM_ADDRESS).address("treasury", TREASURY)
    .raw("reserved", new Uint8Array(64)));
  const poolInput = envelope(pool, ARCH_SWAP_PROGRAM_ADDRESS, new WireWriter(409)
    .raw("discriminator", [241, 154, 109, 4, 17, 177, 109, 188])
    .u8("schemaVersion", 1).u8("bump", pool.bump).address("swapConfig", swap.address)
    .address("creator", CREATOR).address("curveAuthority", curve.address)
    .address("baseMint", baseMint.address).address("quoteMint", quoteMint)
    .address("baseVault", poolBase.address).address("quoteVault", poolQuote.address)
    .address("lpMint", lpMint.address).u8("lpMintBump", lpMint.bump)
    .u64("baseReserves", 200_000n).u64("quoteReserves", 50_000n)
    .u64("creatorQuoteFees", 30n).u64("protocolQuoteFees", 70n)
    .u64("initialLockedBase", 200_000n).u64("initialLockedQuote", 40_000n)
    .u64("totalEconomicShares", 100_000n).u64("permanentlyLockedShares", 10_000n)
    .u16("reinvestFeeBps", 20).u16("protocolFeeBps", 30).u16("creatorFeeBps", 10)
    .u64("createdSlot", 25n).raw("reserved", new Uint8Array(64)));
  return { protocol: protocolInput, launch: launchInput, curve: curveInput, swap: swapInput, pool: poolInput };
}

export function makeMintFixture(input: {
  address?: Address;
  mintAuthority?: Address | null;
  supply?: bigint;
  decimals?: number;
  initialized?: number;
  freezeAuthority?: Address | null;
} = {}): AccountFixture {
  return {
    address: input.address ?? TREASURY, owner: SPL_TOKEN_PROGRAM_ADDRESS,
    ...new WireWriter(82).optionalAddress("mintAuthority", input.mintAuthority ?? null)
      .u64("supply", input.supply ?? 1_000_000n).u8("decimals", input.decimals ?? 6)
      .u8("initialized", input.initialized ?? 1).optionalAddress("freezeAuthority", input.freezeAuthority ?? null)
      .finish(),
  };
}

export function makeTokenFixture(input: {
  address?: Address;
  mint?: Address;
  authority?: Address;
  amount?: bigint;
  delegate?: Address | null;
  state?: number;
  nativeRentReserve?: bigint | null;
  delegatedAmount?: bigint;
  closeAuthority?: Address | null;
} = {}): AccountFixture {
  const nativeRentReserve = input.nativeRentReserve ?? null;
  return {
    address: input.address ?? TREASURY, owner: SPL_TOKEN_PROGRAM_ADDRESS,
    ...new WireWriter(165).address("mint", input.mint ?? USDC_QUOTE_MINT_ADDRESS)
      .address("authority", input.authority ?? CREATOR).u64("amount", input.amount ?? 42n)
      .optionalAddress("delegate", input.delegate ?? null).u8("state", input.state ?? 1)
      .u32("nativeRentReserveTag", nativeRentReserve === null ? 0 : 1)
      .u64("nativeRentReserve", nativeRentReserve ?? 0n).u64("delegatedAmount", input.delegatedAmount ?? 0n)
      .optionalAddress("closeAuthority", input.closeAuthority ?? null).finish(),
  };
}

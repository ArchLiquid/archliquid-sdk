import {
  getAddressEncoder,
  getProgramDerivedAddress,
  type Address,
  type ProgramDerivedAddressBump,
  type ReadonlyUint8Array,
} from "@solana/kit";

import {
  ARCH_CURVE_PROGRAM_ADDRESS,
  ARCH_SWAP_PROGRAM_ADDRESS,
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  METAPLEX_TOKEN_METADATA_PROGRAM_ADDRESS,
  SPL_TOKEN_PROGRAM_ADDRESS,
} from "./addresses.js";

export type DerivedOwnedAddress = Readonly<{
  address: Address;
  bump: ProgramDerivedAddressBump;
}>;

const addressEncoder = getAddressEncoder();

function u16LittleEndian(value: number) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new Error("PDA u16 seed is outside range");
  }
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, true);
  return bytes;
}

function u64LittleEndian(value: bigint) {
  if (value < 0n || value > (1n << 64n) - 1n) {
    throw new Error("PDA u64 seed is outside range");
  }
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return bytes;
}

async function derive(
  programAddress: Address,
  seeds: (string | ReadonlyUint8Array)[],
): Promise<DerivedOwnedAddress> {
  const [derivedAddress, bump] = await getProgramDerivedAddress({
    programAddress,
    seeds,
  });
  return { address: derivedAddress, bump };
}

export function deriveProtocolConfigAddress() {
  return derive(ARCH_CURVE_PROGRAM_ADDRESS, ["protocol-config"]);
}

export function deriveLaunchConfigAddress(quoteMint: Address, configVersion: number) {
  return derive(ARCH_CURVE_PROGRAM_ADDRESS, [
    "launch-config",
    addressEncoder.encode(quoteMint),
    u16LittleEndian(configVersion),
  ]);
}

export function deriveBaseMintAddress(creator: Address, launchNonce: bigint) {
  return derive(ARCH_CURVE_PROGRAM_ADDRESS, [
    "base-mint",
    addressEncoder.encode(creator),
    u64LittleEndian(launchNonce),
  ]);
}

export function deriveCurveAddress(baseMint: Address) {
  return derive(ARCH_CURVE_PROGRAM_ADDRESS, ["curve", addressEncoder.encode(baseMint)]);
}

export function deriveSwapConfigAddress() {
  return derive(ARCH_SWAP_PROGRAM_ADDRESS, ["swap-config"]);
}

export function derivePoolAddress(baseMint: Address, quoteMint: Address) {
  return derive(ARCH_SWAP_PROGRAM_ADDRESS, [
    "pool",
    addressEncoder.encode(baseMint),
    addressEncoder.encode(quoteMint),
  ]);
}

export function derivePoolLpMintAddress(pool: Address) {
  return derive(ARCH_SWAP_PROGRAM_ADDRESS, [
    "pool-lp-mint",
    addressEncoder.encode(pool),
  ]);
}

export function deriveAssociatedTokenAddress(owner: Address, mint: Address) {
  return derive(ASSOCIATED_TOKEN_PROGRAM_ADDRESS, [
    addressEncoder.encode(owner),
    addressEncoder.encode(SPL_TOKEN_PROGRAM_ADDRESS),
    addressEncoder.encode(mint),
  ]);
}

export function deriveMetadataAddress(mint: Address) {
  return derive(METAPLEX_TOKEN_METADATA_PROGRAM_ADDRESS, [
    "metadata",
    addressEncoder.encode(METAPLEX_TOKEN_METADATA_PROGRAM_ADDRESS),
    addressEncoder.encode(mint),
  ]);
}

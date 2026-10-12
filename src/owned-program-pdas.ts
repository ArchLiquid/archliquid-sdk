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

type AddressDerivation = typeof derive;

// Both interfaces use these seeds so enabling the cache cannot change address derivation.
function ownedAddressMethods(deriveAddress: AddressDerivation) {
  return {
    deriveProtocolConfigAddress: () =>
      deriveAddress(ARCH_CURVE_PROGRAM_ADDRESS, ["protocol-config"]),
    deriveLaunchConfigAddress: (quoteMint: Address, configVersion: number) =>
      deriveAddress(ARCH_CURVE_PROGRAM_ADDRESS, [
        "launch-config", addressEncoder.encode(quoteMint), u16LittleEndian(configVersion),
      ]),
    deriveBaseMintAddress: (creator: Address, launchNonce: bigint) =>
      deriveAddress(ARCH_CURVE_PROGRAM_ADDRESS, [
        "base-mint", addressEncoder.encode(creator), u64LittleEndian(launchNonce),
      ]),
    deriveCurveAddress: (baseMint: Address) =>
      deriveAddress(ARCH_CURVE_PROGRAM_ADDRESS, ["curve", addressEncoder.encode(baseMint)]),
    deriveSwapConfigAddress: () => deriveAddress(ARCH_SWAP_PROGRAM_ADDRESS, ["swap-config"]),
    derivePoolAddress: (baseMint: Address, quoteMint: Address) =>
      deriveAddress(ARCH_SWAP_PROGRAM_ADDRESS, [
        "pool", addressEncoder.encode(baseMint), addressEncoder.encode(quoteMint),
      ]),
    derivePoolLpMintAddress: (pool: Address) =>
      deriveAddress(ARCH_SWAP_PROGRAM_ADDRESS, ["pool-lp-mint", addressEncoder.encode(pool)]),
    deriveAssociatedTokenAddress: (owner: Address, mint: Address) =>
      deriveAddress(ASSOCIATED_TOKEN_PROGRAM_ADDRESS, [
        addressEncoder.encode(owner), addressEncoder.encode(SPL_TOKEN_PROGRAM_ADDRESS), addressEncoder.encode(mint),
      ]),
    deriveMetadataAddress: (mint: Address) =>
      deriveAddress(METAPLEX_TOKEN_METADATA_PROGRAM_ADDRESS, [
        "metadata", addressEncoder.encode(METAPLEX_TOKEN_METADATA_PROGRAM_ADDRESS), addressEncoder.encode(mint),
      ]),
  };
}

const uncached = ownedAddressMethods(derive);

export function deriveProtocolConfigAddress() {
  return uncached.deriveProtocolConfigAddress();
}
export function deriveLaunchConfigAddress(quoteMint: Address, configVersion: number) {
  return uncached.deriveLaunchConfigAddress(quoteMint, configVersion);
}
export function deriveBaseMintAddress(creator: Address, launchNonce: bigint) {
  return uncached.deriveBaseMintAddress(creator, launchNonce);
}
export function deriveCurveAddress(baseMint: Address) {
  return uncached.deriveCurveAddress(baseMint);
}
export function deriveSwapConfigAddress() {
  return uncached.deriveSwapConfigAddress();
}
export function derivePoolAddress(baseMint: Address, quoteMint: Address) {
  return uncached.derivePoolAddress(baseMint, quoteMint);
}
export function derivePoolLpMintAddress(pool: Address) {
  return uncached.derivePoolLpMintAddress(pool);
}
export function deriveAssociatedTokenAddress(owner: Address, mint: Address) {
  return uncached.deriveAssociatedTokenAddress(owner, mint);
}
export function deriveMetadataAddress(mint: Address) {
  return uncached.deriveMetadataAddress(mint);
}

export type OwnedAddressDeriver = Readonly<ReturnType<typeof ownedAddressMethods> & {
  maxEntries: number;
  cacheSize: number;
  clearCache: () => void;
}>;

/**
 * Opt-in LRU cache for deterministic addresses only. Pending derivations count
 * towards the bound and share a promise; failures are removed so callers can retry.
 * Standalone derivation functions remain uncached.
 */
export function createOwnedAddressDeriver(
  options: Readonly<{ maxEntries?: number }> = {},
): OwnedAddressDeriver {
  const maxEntries = options.maxEntries ?? 128;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new Error("PDA cache maxEntries must be a positive safe integer");
  }
  const cache = new Map<string, Promise<DerivedOwnedAddress>>();
  const utf8Encoder = new TextEncoder();
  const cachedDerive: AddressDerivation = (programAddress, seeds) => {
    const encodedSeeds = seeds.map((seed) => {
      const bytes = typeof seed === "string" ? utf8Encoder.encode(seed) : seed;
      return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
    });
    const key = `${programAddress}:${encodedSeeds.join("/")}`;
    const existing = cache.get(key);
    if (existing) {
      cache.delete(key);
      cache.set(key, existing);
      return existing;
    }
    const pending = derive(programAddress, seeds).then(
      (result) => Object.freeze(result),
      (error: unknown) => {
        // A failed evicted request must not remove a newer request for this key.
        if (cache.get(key) === pending) cache.delete(key);
        throw error;
      },
    );
    cache.set(key, pending);
    if (cache.size > maxEntries) cache.delete(cache.keys().next().value!);
    return pending;
  };
  return Object.freeze({
    ...ownedAddressMethods(cachedDerive),
    maxEntries,
    get cacheSize() { return cache.size; },
    clearCache: () => cache.clear(),
  });
}

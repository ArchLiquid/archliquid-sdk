import {
  ARCH_CURVE_PROGRAM_ADDRESS,
  ARCH_SWAP_PROGRAM_ADDRESS,
  ARCH_LOCKER_PROGRAM_ADDRESS,
  SOLANA_DEVNET_GENESIS_HASH,
  SOL_QUOTE_MINT_ADDRESS,
  USDC_QUOTE_MINT_ADDRESS,
} from "./addresses.js";
import { OwnedSdkError } from "./errors.js";
import { OWNED_IDL_METADATA } from "./owned-idl-metadata.js";

/** SHA-256 of the exact LF IDL bytes distributed by this SDK release. */
export const OWNED_IDL_SHA256 = Object.freeze({
  archCurve: OWNED_IDL_METADATA.archCurve.idlSha256,
  archSwap: OWNED_IDL_METADATA.archSwap.idlSha256,
  archLocker: OWNED_IDL_METADATA.archLocker.idlSha256,
});

/** The currently supported deployment. A cluster match does not verify program bytecode. */
export const ARCHLIQUID_DEVNET_DEPLOYMENT = Object.freeze({
  cluster: "devnet" as const,
  genesisHash: SOLANA_DEVNET_GENESIS_HASH,
  programs: Object.freeze({
    archCurve: ARCH_CURVE_PROGRAM_ADDRESS,
    archSwap: ARCH_SWAP_PROGRAM_ADDRESS,
    archLocker: ARCH_LOCKER_PROGRAM_ADDRESS,
  }),
  quoteMints: Object.freeze({ sol: SOL_QUOTE_MINT_ADDRESS, usdc: USDC_QUOTE_MINT_ADDRESS }),
  idlSha256: OWNED_IDL_SHA256,
});

export function assertOwnedDeploymentGenesisHash(genesisHash: string): void {
  if (genesisHash !== ARCHLIQUID_DEVNET_DEPLOYMENT.genesisHash) {
    throw new OwnedSdkError("wrong_cluster", "RPC genesis hash does not match the supported ArchLiquid devnet deployment", {
      context: { expected: ARCHLIQUID_DEVNET_DEPLOYMENT.genesisHash, actual: genesisHash },
    });
  }
}

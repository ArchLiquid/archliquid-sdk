import { getAddressDecoder, type Address, type Slot } from "@solana/kit";
import { SOLANA_DEVNET_GENESIS_HASH, SOL_QUOTE_MINT_ADDRESS, USDC_QUOTE_MINT_ADDRESS } from "../../src/addresses.js";
import type { OwnedAccountReadOptions, OwnedAccountReader, OwnedObservedAccount } from "../../src/owned-snapshots.js";
import { makeMintFixture, makeProgramFixtures, makeTokenFixture, type AccountFixture } from "./fixtures.js";

export type SnapshotReadResult = Awaited<ReturnType<OwnedAccountReader["getAccounts"]>>;
export type SnapshotReaderCall = Readonly<{
  kind: "genesis" | "accounts";
  addresses: readonly Address[];
  options: Readonly<{ abortSignal: AbortSignal }> | OwnedAccountReadOptions;
}>;

/** A controllable synthetic reader; tests never contact a network or claim live-chain provenance. */
export async function createSnapshotReader(quoteKind: "sol" | "usdc" = "sol") {
  const fixtures = await makeProgramFixtures(quoteKind);
  const decoder = getAddressDecoder();
  const fieldAddress = (fixture: AccountFixture, field: string) => {
    const offset = fixture.offsets[field]!;
    return decoder.decode(fixture.data.slice(offset, offset + 32));
  };
  const baseMint = fieldAddress(fixtures.curve, "baseMint");
  const quoteMint = quoteKind === "sol" ? SOL_QUOTE_MINT_ADDRESS : USDC_QUOTE_MINT_ADDRESS;
  const lpMint = fieldAddress(fixtures.pool, "lpMint");
  const accounts = new Map<Address, OwnedObservedAccount | null>();
  const put = (fixture: AccountFixture, lamports = 2_039_280n) => {
    accounts.set(fixture.address, {
      address: fixture.address, owner: fixture.owner, data: fixture.data.slice(), lamports, executable: false,
    });
  };
  Object.values(fixtures).forEach((fixture) => put(fixture));
  put(makeMintFixture({ address: baseMint, supply: 1_000_000n }));
  put(makeMintFixture({ address: quoteMint, decimals: quoteKind === "sol" ? 9 : 6 }));
  put(makeMintFixture({ address: lpMint, mintAuthority: fixtures.pool.address, decimals: 9, supply: 90_000n }));
  const vault = (venue: "curve" | "pool", mint: Address, field: string, amount: bigint) => {
    const native = mint === SOL_QUOTE_MINT_ADDRESS;
    put(makeTokenFixture({ address: fieldAddress(fixtures[venue], field), mint,
      authority: fixtures[venue].address, amount, nativeRentReserve: native ? 2_039_280n : null,
    }), native ? amount + 2_039_280n : 2_039_280n);
  };
  vault("curve", baseMint, "baseVault", 950_000n);
  vault("curve", quoteMint, "quoteVault", 2_800n);
  vault("pool", baseMint, "baseVault", 200_000n);
  vault("pool", quoteMint, "quoteVault", 50_100n);
  const calls: SnapshotReaderCall[] = [];
  const controls = {
    genesisHash: SOLANA_DEVNET_GENESIS_HASH as string,
    slot: 100n as Slot,
    onGenesis: undefined as ((call: SnapshotReaderCall) => string | Promise<string>) | undefined,
    onAccounts: undefined as ((call: SnapshotReaderCall, response: SnapshotReadResult) => SnapshotReadResult | Promise<SnapshotReadResult>) | undefined,
  };
  const reader: OwnedAccountReader = {
    async getGenesisHash(options) {
      const call: SnapshotReaderCall = { kind: "genesis", addresses: [], options };
      calls.push(call);
      return controls.onGenesis ? controls.onGenesis(call) : controls.genesisHash;
    },
    async getAccounts(addresses, options) {
      const call: SnapshotReaderCall = { kind: "accounts", addresses: [...addresses], options };
      calls.push(call);
      const response: SnapshotReadResult = {
        slot: controls.slot,
        accounts: addresses.map((accountAddress) => accounts.get(accountAddress) ?? null),
      };
      return controls.onAccounts ? controls.onAccounts(call, response) : response;
    },
  };
  return {
    reader, fixtures, baseMint, quoteMint, lpMint, accounts, calls, controls,
    curveBaseVault: fieldAddress(fixtures.curve, "baseVault"),
    curveQuoteVault: fieldAddress(fixtures.curve, "quoteVault"),
    poolBaseVault: fieldAddress(fixtures.pool, "baseVault"),
    poolQuoteVault: fieldAddress(fixtures.pool, "quoteVault"),
  };
}

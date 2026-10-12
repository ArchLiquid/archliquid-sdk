import assert from "node:assert/strict";
import test from "node:test";
import type { Address, GetGenesisHashApi, GetMultipleAccountsApi, Rpc, Slot } from "@solana/kit";
import { SOLANA_DEVNET_GENESIS_HASH, SOL_QUOTE_MINT_ADDRESS, ZERO_ADDRESS } from "../src/addresses.js";
import { OwnedSdkError } from "../src/errors.js";
import {
  assertOwnedSnapshot, createOwnedAccountReader, loadCurveSnapshot, loadLaunchSnapshot, loadPoolSnapshot,
  type OwnedAccountReadOptions, type OwnedObservedAccount, type OwnedSnapshotOptions,
} from "../src/owned-snapshots.js";
import { CREATOR, TREASURY, mutate } from "./helpers/fixtures.js";
import { createSnapshotReader } from "./helpers/snapshot-reader.js";

const code = (expected: string) => (error: unknown) => {
  assert.ok(error instanceof OwnedSdkError);
  assert.equal(error.code, expected);
  return true;
};

for (const quoteKind of ["sol", "usdc"] as const) {
  test(`loads branded, frozen ${quoteKind.toUpperCase()} Curve, Pool and launch snapshots`, async () => {
    const setup = await createSnapshotReader(quoteKind);
    const curve = await loadCurveSnapshot(setup.reader, setup.baseMint);
    const pool = await loadPoolSnapshot(setup.reader, setup.baseMint, setup.quoteMint);
    const launch = await loadLaunchSnapshot(setup.reader, setup.quoteMint);
    for (const snapshot of [curve, pool, launch]) {
      assert.equal(snapshot.slot, 100n);
      assert.equal(snapshot.commitment, "confirmed");
      assert.ok(Number.isSafeInteger(snapshot.observedAtUnixMs));
      assert.equal(snapshot.deployment.genesisHash, SOLANA_DEVNET_GENESIS_HASH);
      assert.equal(Object.isFrozen(snapshot), true);
      assert.equal(Object.isFrozen(snapshot.quoteMint), true);
      assert.equal(snapshot.quoteMint.decimals, quoteKind === "sol" ? 9 : 6);
      assert.doesNotThrow(() => assertOwnedSnapshot(snapshot));
      assert.throws(() => assertOwnedSnapshot({ ...snapshot }), code("invalid_snapshot"));
    }
    assert.equal(Object.isFrozen(curve.launchConfig.parameters), true);
    assert.equal(Object.isFrozen(pool.pool.fees), true);
    assert.equal(curve.baseVault.amount, 950_000n);
    assert.equal(pool.lpMint.supply, 90_000n);
    assert.equal(pool.quoteVault.amount, 50_100n);
    assert.equal(launch.launchConfig.quoteMint, setup.quoteMint);
    const readLengths = setup.calls.filter((call) => call.kind === "accounts").map((call) => call.addresses.length);
    assert.deepEqual(readLengths, [1, 7, 7, 1, 3]);
    assert.throws(() => { (pool.pool.fees as { creatorFeeBps: number }).creatorFeeBps = 999; }, TypeError);
    const commitment = curve.curve.metadataCommitment as Uint8Array;
    commitment[0] = 99;
    assert.equal(curve.curve.metadataCommitment[0], 1, "Typed-array mutation cannot alter stored validated bytes");
    const readerData = setup.accounts.get(setup.fixtures.curve.address)!.data as Uint8Array;
    readerData[setup.fixtures.curve.offsets.metadataCommitment!] = 42;
    assert.equal(curve.curve.metadataCommitment[0], 1, "Reader-owned buffers cannot mutate snapshots after validation");
  });
}

test("discovery-based loaders request the final batch at or after discovery context", async () => {
  for (const venue of ["curve", "launch"] as const) {
    const setup = await createSnapshotReader();
    setup.controls.onAccounts = (call, response) => ({ ...response, slot: (call.addresses.length === 1 ? 120n : 121n) as Slot });
    const options = { minContextSlot: 110n as Slot, commitment: "finalized" as const };
    const snapshot = venue === "curve"
      ? await loadCurveSnapshot(setup.reader, setup.baseMint, options)
      : await loadLaunchSnapshot(setup.reader, setup.quoteMint, options);
    assert.equal(snapshot.slot, 121n);
    const [discovery, final] = setup.calls.filter((call) => call.kind === "accounts");
    assert.equal((discovery!.options as OwnedAccountReadOptions).minContextSlot, 110n);
    assert.equal((final!.options as OwnedAccountReadOptions).minContextSlot, 120n);
    assert.equal((final!.options as OwnedAccountReadOptions).commitment, "finalized");
  }
  const pool = await createSnapshotReader();
  await loadPoolSnapshot(pool.reader, pool.baseMint, pool.quoteMint, { minContextSlot: 90n as Slot, commitment: "processed" });
  const batch = pool.calls.find((call) => call.kind === "accounts")!;
  assert.equal((batch.options as OwnedAccountReadOptions).minContextSlot, 90n);
  assert.equal((batch.options as OwnedAccountReadOptions).commitment, "processed");
});

test("loaders reject contexts older than user minimum or discovery instead of mixing observations", async () => {
  const setup = await createSnapshotReader();
  await assert.rejects(loadPoolSnapshot(setup.reader, setup.baseMint, setup.quoteMint, { minContextSlot: 101n as Slot }), code("stale_context"));
  for (const venue of ["curve", "launch"] as const) {
    const reader = await createSnapshotReader();
    reader.controls.onAccounts = (call, response) => ({ ...response, slot: (call.addresses.length === 1 ? 200n : 199n) as Slot });
    await assert.rejects(venue === "curve"
      ? loadCurveSnapshot(reader.reader, reader.baseMint)
      : loadLaunchSnapshot(reader.reader, reader.quoteMint), code("stale_context"));
  }
});

test("final Curve validation rejects a changed discovery relationship and uses current mutable reserves", async () => {
  const setup = await createSnapshotReader();
  let discovery = true;
  setup.controls.onAccounts = (_call, response) => {
    if (discovery) { discovery = false; return response; }
    const changed = mutate(setup.fixtures.curve, "launchConfig", TREASURY);
    return { ...response, accounts: response.accounts.map((account) =>
      account?.address === changed.address ? { ...account, data: changed.data } : account) };
  };
  await assert.rejects(loadCurveSnapshot(setup.reader, setup.baseMint), code("invalid_snapshot"));
  const coherent = await createSnapshotReader();
  coherent.controls.onAccounts = (call, response) => {
    if (call.addresses.length === 1) return response;
    const changed = mutate(coherent.fixtures.curve, "realSaleBaseReserves", 749_999n);
    return { ...response, accounts: response.accounts.map((account) =>
      account?.address === changed.address ? { ...account, data: changed.data } : account) };
  };
  assert.equal((await loadCurveSnapshot(coherent.reader, coherent.baseMint)).curve.realSaleBaseReserves, 749_999n);
});

test("Curve discovery enforces its owner, discriminator, layout and supported quote before final reads", async () => {
  for (const change of [
    (account: OwnedObservedAccount) => ({ ...account, owner: ZERO_ADDRESS }),
    (account: OwnedObservedAccount) => ({ ...account, data: account.data.slice(1) }),
    (account: OwnedObservedAccount) => ({ ...account, data: new Uint8Array(account.data.length) }),
  ]) {
    const setup = await createSnapshotReader();
    const account = setup.accounts.get(setup.fixtures.curve.address)!;
    setup.accounts.set(setup.fixtures.curve.address, change(account));
    await assert.rejects(loadCurveSnapshot(setup.reader, setup.baseMint), code("invalid_snapshot"));
    assert.equal(setup.calls.filter((call) => call.kind === "accounts").length, 1);
  }
  const setup = await createSnapshotReader();
  const invalidQuote = mutate(setup.fixtures.curve, "quoteMint", TREASURY);
  setup.accounts.set(invalidQuote.address, { ...setup.accounts.get(invalidQuote.address)!, data: invalidQuote.data });
  await assert.rejects(loadCurveSnapshot(setup.reader, setup.baseMint), code("invalid_snapshot"));
});

test("launch snapshots reject disabled and replaced active configuration", async () => {
  const setup = await createSnapshotReader();
  const disabled = mutate(setup.fixtures.protocol, "launchesEnabled", 0);
  setup.accounts.set(disabled.address, { ...setup.accounts.get(disabled.address)!, data: disabled.data });
  await assert.rejects(loadLaunchSnapshot(setup.reader, setup.quoteMint), code("invalid_snapshot"));
  const replaced = await createSnapshotReader();
  replaced.controls.onAccounts = (call, response) => {
    if (call.addresses.length === 1) return response;
    const changed = mutate(replaced.fixtures.protocol, "activeSolLaunchConfig", TREASURY);
    return { ...response, accounts: response.accounts.map((account) =>
      account?.address === changed.address ? { ...account, data: changed.data } : account) };
  };
  await assert.rejects(loadLaunchSnapshot(replaced.reader, replaced.quoteMint), code("invalid_snapshot"));
});

test("response validation rejects missing accounts, identity substitutions, invalid lamports/owner/executable/data", async () => {
  const mutations: ((account: OwnedObservedAccount) => OwnedObservedAccount | null)[] = [
    () => null,
    (account) => ({ ...account, address: CREATOR }),
    (account) => ({ ...account, owner: "invalid" }),
    (account) => ({ ...account, lamports: -1n }),
    (account) => ({ ...account, lamports: 1n << 64n }),
    (account) => ({ ...account, executable: true }),
    (account) => ({ ...account, executable: "false" } as unknown as OwnedObservedAccount),
    (account) => ({ ...account, data: new Uint8Array(4_097) }),
    (account) => ({ ...account, data: [] } as unknown as OwnedObservedAccount),
  ];
  for (const [index, mutation] of mutations.entries()) {
    const setup = await createSnapshotReader();
    setup.controls.onAccounts = (_call, response) => ({ ...response,
      accounts: response.accounts.map((account, i) => i === 0 ? mutation(account!) : account) });
    await assert.rejects(loadPoolSnapshot(setup.reader, setup.baseMint, setup.quoteMint), code(index === 0 ? "missing_account" : "invalid_snapshot"));
  }
});

test("malformed response envelopes, account counts and slots produce stable validation errors", async () => {
  for (const slot of [-1n, 1n << 64n, 100, NaN]) {
    const setup = await createSnapshotReader();
    setup.controls.onAccounts = (_call, response) => ({ ...response, slot: slot as Slot });
    await assert.rejects(loadPoolSnapshot(setup.reader, setup.baseMint, setup.quoteMint), code("invalid_snapshot"));
  }
  for (const responseKind of ["null", "short", "extra", "not-array"] as const) {
    const setup = await createSnapshotReader();
    setup.controls.onAccounts = (_call, response) => {
      if (responseKind === "null") return null as unknown as typeof response;
      if (responseKind === "short") return { ...response, accounts: response.accounts.slice(1) };
      if (responseKind === "extra") return { ...response, accounts: [...response.accounts, null] };
      return { ...response, accounts: {} as unknown as typeof response.accounts };
    };
    await assert.rejects(loadPoolSnapshot(setup.reader, setup.baseMint, setup.quoteMint), code("invalid_snapshot"));
  }
});

test("snapshot validation rejects mint, LP and vault accounting substitutions", async () => {
  for (const target of ["base-authority", "quote-decimals", "lp-supply", "vault-under-backed"] as const) {
    const setup = await createSnapshotReader();
    const accountAddress = target === "base-authority" ? setup.baseMint
      : target === "quote-decimals" ? setup.quoteMint : target === "lp-supply" ? setup.lpMint
      : setup.poolQuoteVault;
    const account = setup.accounts.get(accountAddress)!;
    const data = new Uint8Array(account.data);
    if (target === "base-authority") new DataView(data.buffer).setUint32(0, 1, true);
    if (target === "quote-decimals") data[44] = 6;
    if (target === "lp-supply") new DataView(data.buffer).setBigUint64(36, 90_001n, true);
    setup.accounts.set(accountAddress, { ...account, data, ...(target === "vault-under-backed" ? { lamports: 0n } : {}) });
    await assert.rejects(loadPoolSnapshot(setup.reader, setup.baseMint, setup.quoteMint), code("invalid_snapshot"));
  }
  const donation = await createSnapshotReader();
  const vaultAddress = donation.poolQuoteVault;
  const account = donation.accounts.get(vaultAddress)!;
  donation.accounts.set(vaultAddress, { ...account, lamports: account.lamports + 1n });
  assert.equal((await loadPoolSnapshot(donation.reader, donation.baseMint, donation.quoteMint)).quoteVault.amount, 50_100n);
});

test("wrong genesis hash prevents all account reads and unsupported quotes are rejected locally", async () => {
  const setup = await createSnapshotReader();
  setup.controls.genesisHash = "mainnet-genesis";
  await assert.rejects(loadCurveSnapshot(setup.reader, setup.baseMint), code("wrong_cluster"));
  assert.equal(setup.calls.length, 1);
  await assert.rejects(loadPoolSnapshot(setup.reader, setup.baseMint, TREASURY), code("invalid_input"));
  await assert.rejects(loadLaunchSnapshot(setup.reader, TREASURY), code("invalid_input"));
  assert.equal(setup.calls.length, 1);
});

test("snapshot options reject unsafe timeout/retry/context/commitment inputs before RPC", async () => {
  const setup = await createSnapshotReader();
  for (const options of [
    { timeoutMs: 0 }, { timeoutMs: 60_001 }, { timeoutMs: NaN }, { timeoutMs: 1.5 },
    { retries: -1 }, { retries: 4 }, { retries: 1.5 },
    { retryDelayMs: -1 }, { retryDelayMs: 5_001 }, { retryDelayMs: Infinity },
    { minContextSlot: -1n }, { minContextSlot: 1n << 64n }, { minContextSlot: 1 },
    { commitment: "recent" },
  ]) await assert.rejects(loadCurveSnapshot(setup.reader, setup.baseMint, options as OwnedSnapshotOptions), code("invalid_input"));
  assert.equal(setup.calls.length, 0);
});

test("abort and timeout bound a reader that ignores its AbortSignal", async () => {
  const setup = await createSnapshotReader();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(loadCurveSnapshot(setup.reader, setup.baseMint, { abortSignal: controller.signal }), code("aborted"));
  assert.equal(setup.calls.length, 0);
  const activeController = new AbortController();
  setup.controls.onAccounts = () => {
    activeController.abort();
    return new Promise(() => {});
  };
  await assert.rejects(loadPoolSnapshot(setup.reader, setup.baseMint, setup.quoteMint, { abortSignal: activeController.signal }), code("aborted"));
  const blocked = await createSnapshotReader();
  blocked.controls.onGenesis = () => new Promise(() => {});
  await assert.rejects(loadCurveSnapshot(blocked.reader, blocked.baseMint, { timeoutMs: 15 }), code("timeout"));
  assert.equal(blocked.calls[0]!.options.abortSignal.aborted, true);
});

test("bounded retries recover transport failures while validation failures are never retried", async () => {
  const setup = await createSnapshotReader();
  let genesisAttempts = 0;
  setup.controls.onGenesis = () => {
    if (++genesisAttempts === 1) throw new Error("Temporary network failure");
    return SOLANA_DEVNET_GENESIS_HASH;
  };
  let accountAttempts = 0;
  setup.controls.onAccounts = (_call, response) => {
    if (++accountAttempts === 1) throw new Error("Temporary account-read failure");
    return response;
  };
  await loadCurveSnapshot(setup.reader, setup.baseMint, { retries: 1, retryDelayMs: 0 });
  assert.equal(genesisAttempts, 2);
  assert.equal(accountAttempts, 3);
  const invalid = await createSnapshotReader();
  invalid.controls.onAccounts = () => { throw new OwnedSdkError("invalid_snapshot", "Invalid RPC payload"); };
  await assert.rejects(loadPoolSnapshot(invalid.reader, invalid.baseMint, invalid.quoteMint, { retries: 3 }), code("invalid_snapshot"));
  assert.equal(invalid.calls.filter((call) => call.kind === "accounts").length, 1);
  const malformed = await createSnapshotReader();
  malformed.accounts.set(malformed.baseMint, null);
  await assert.rejects(loadPoolSnapshot(malformed.reader, malformed.baseMint, malformed.quoteMint, { retries: 3 }), code("missing_account"));
  assert.equal(malformed.calls.filter((call) => call.kind === "accounts").length, 1);
  const failed = await createSnapshotReader();
  failed.controls.onGenesis = () => { throw new Error("Transport unavailable"); };
  await assert.rejects(loadCurveSnapshot(failed.reader, failed.baseMint, { retries: 1, retryDelayMs: 0 }), code("rpc_error"));
  assert.equal(failed.calls.length, 2);
});

test("timeout interrupts retry backoff without making another transport call", async () => {
  const setup = await createSnapshotReader();
  setup.controls.onGenesis = () => { throw new Error("Transport unavailable"); };
  await assert.rejects(loadCurveSnapshot(setup.reader, setup.baseMint, { timeoutMs: 15, retries: 3, retryDelayMs: 1_000 }), code("timeout"));
  assert.equal(setup.calls.length, 1);
});

test("Kit reader adapter passes context options/signals and rejects malformed or oversized base64", async () => {
  const calls: unknown[][] = [];
  let data: unknown = [Buffer.from([1, 2, 3]).toString("base64"), "base64"];
  let malformedEnvelope = false;
  const rpc = {
    getGenesisHash: () => ({ send: async (options: unknown) => { calls.push(["genesis", options]); return SOLANA_DEVNET_GENESIS_HASH; } }),
    getMultipleAccounts: (addresses: readonly Address[], options: unknown) => ({
      send: async (sendOptions: unknown) => {
        calls.push([addresses, options, sendOptions]);
        return malformedEnvelope ? { context: { slot: 1n }, value: [] } : {
          context: { slot: 55n }, value: [{ owner: ZERO_ADDRESS, lamports: 5n, executable: false, data }],
        };
      },
    }),
  } as unknown as Rpc<GetGenesisHashApi & GetMultipleAccountsApi>;
  const reader = createOwnedAccountReader(rpc);
  const abortSignal = new AbortController().signal;
  assert.equal(await reader.getGenesisHash({ abortSignal }), SOLANA_DEVNET_GENESIS_HASH);
  const options: OwnedAccountReadOptions = { commitment: "finalized", minContextSlot: 50n as Slot, abortSignal };
  const response = await reader.getAccounts([SOL_QUOTE_MINT_ADDRESS], options);
  assert.equal(response.slot, 55n);
  assert.deepEqual(Array.from(response.accounts[0]!.data), [1, 2, 3]);
  assert.deepEqual(calls[1], [[SOL_QUOTE_MINT_ADDRESS], { encoding: "base64", commitment: "finalized", minContextSlot: 50n }, { abortSignal }]);
  for (const encoding of [
    ["AAAA", "base58"], ["!AAA", "base64"], ["AA", "base64"], ["AB==", "base64"], [null, "base64"],
    ["AAAA", "base64", "extra"], null,
    [Buffer.alloc(4_097).toString("base64"), "base64"],
    [Buffer.alloc(8_000).toString("base64"), "base64"],
  ]) {
    data = encoding;
    await assert.rejects(reader.getAccounts([SOL_QUOTE_MINT_ADDRESS], options), code("invalid_snapshot"));
  }
  malformedEnvelope = true;
  await assert.rejects(reader.getAccounts([SOL_QUOTE_MINT_ADDRESS], options), code("invalid_snapshot"));
});

test("snapshot capture preserves validated user context when options change during genesis", async () => {
  for (const venue of ["curve", "pool", "launch"] as const) {
    const setup = await createSnapshotReader();
    const options = { commitment: "confirmed", minContextSlot: 101n };
    setup.controls.onGenesis = () => {
      options.commitment = "recent";
      options.minContextSlot = 0n;
      return SOLANA_DEVNET_GENESIS_HASH;
    };
    const operation = venue === "curve" ? loadCurveSnapshot(setup.reader, setup.baseMint, options as OwnedSnapshotOptions)
      : venue === "pool" ? loadPoolSnapshot(setup.reader, setup.baseMint, setup.quoteMint, options as OwnedSnapshotOptions)
      : loadLaunchSnapshot(setup.reader, setup.quoteMint, options as OwnedSnapshotOptions);
    await assert.rejects(operation, code("stale_context"));
    const requested = setup.calls.find((call) => call.kind === "accounts")!;
    assert.equal((requested.options as OwnedAccountReadOptions).commitment, "confirmed");
    assert.equal((requested.options as OwnedAccountReadOptions).minContextSlot, 101n);
  }
});

test("snapshot capture retains the original abort signal for cancellation and listener cleanup", async (context) => {
  const setup = await createSnapshotReader();
  const original = new AbortController();
  const replacement = new AbortController();
  const added = context.mock.method(original.signal, "addEventListener");
  const removed = context.mock.method(original.signal, "removeEventListener");
  const options = { abortSignal: original.signal, commitment: "confirmed" };
  setup.controls.onGenesis = () => {
    options.abortSignal = replacement.signal;
    options.commitment = "recent";
    return SOLANA_DEVNET_GENESIS_HASH;
  };
  const snapshot = await loadPoolSnapshot(setup.reader, setup.baseMint, setup.quoteMint, options as OwnedSnapshotOptions);
  assert.equal(snapshot.commitment, "confirmed");
  assert.equal(added.mock.callCount(), 1);
  assert.equal(removed.mock.callCount(), 1);
  const pending = await createSnapshotReader();
  const controller = new AbortController();
  const pendingOptions = { abortSignal: controller.signal };
  pending.controls.onGenesis = () => {
    pendingOptions.abortSignal = replacement.signal;
    return SOLANA_DEVNET_GENESIS_HASH;
  };
  pending.controls.onAccounts = () => {
    controller.abort();
    return new Promise(() => {});
  };
  await assert.rejects(loadPoolSnapshot(pending.reader, pending.baseMint, pending.quoteMint, pendingOptions), code("aborted"));
});

test("snapshot capture reads final and discovery slots only once before asynchronous decoding", async () => {
  const setup = await createSnapshotReader();
  let reads = 0;
  setup.controls.onAccounts = (_call, response) => Object.defineProperty({ ...response }, "slot", {
    enumerable: true, get: () => ++reads === 1 ? 100n : 777n,
  });
  assert.equal((await loadPoolSnapshot(setup.reader, setup.baseMint, setup.quoteMint)).slot, 100n);
  assert.equal(reads, 1);
  for (const venue of ["curve", "launch"] as const) {
    const reader = await createSnapshotReader();
    const counts: number[] = [];
    reader.controls.onAccounts = (call, response) => {
      const index = counts.length;
      counts.push(0);
      return Object.defineProperty({ ...response }, "slot", { enumerable: true, get: () => {
        counts[index]! += 1;
        return counts[index] === 1 ? (call.addresses.length === 1 ? 120n : 121n) : 0n;
      } });
    };
    const snapshot = venue === "curve" ? await loadCurveSnapshot(reader.reader, reader.baseMint)
      : await loadLaunchSnapshot(reader.reader, reader.quoteMint);
    assert.equal(snapshot.slot, 121n);
    assert.deepEqual(counts, [1, 1]);
    const final = reader.calls.filter((call) => call.kind === "accounts")[1]!;
    assert.equal((final.options as OwnedAccountReadOptions).minContextSlot, 120n);
  }
});

test("snapshot capture validates and copies the exact account fields read once", async () => {
  const setup = await createSnapshotReader();
  const source = setup.accounts.get(setup.baseMint)!;
  const counts = { owner: 0, data: 0, lamports: 0 };
  const dynamic = Object.defineProperties({ ...source }, {
    owner: { enumerable: true, get: () => ++counts.owner === 1 ? source.owner : ZERO_ADDRESS },
    data: { enumerable: true, get: () => ++counts.data === 1 ? source.data : new Uint8Array(82) },
    lamports: { enumerable: true, get: () => ++counts.lamports === 1 ? source.lamports : -1n },
  });
  setup.accounts.set(setup.baseMint, dynamic);
  const snapshot = await loadPoolSnapshot(setup.reader, setup.baseMint, setup.quoteMint);
  assert.equal(snapshot.baseMint.supply, 1_000_000n);
  assert.deepEqual(counts, { owner: 1, data: 1, lamports: 1 });
});

test("snapshot malformed options fail locally with stable invalid_input errors", async () => {
  const setup = await createSnapshotReader();
  for (const options of [null, [], { abortSignal: {} }, { get commitment() { throw new Error("Getter failed"); } }]) {
    await assert.rejects(loadPoolSnapshot(setup.reader, setup.baseMint, setup.quoteMint, options as OwnedSnapshotOptions), code("invalid_input"));
  }
  assert.equal(setup.calls.length, 0);
});

test("snapshot sparse response arrays reject missing requested indices", async () => {
  for (const venue of ["curve", "pool", "launch"] as const) {
    const setup = await createSnapshotReader();
    setup.controls.onAccounts = (call, response) => ({ ...response, accounts: new Array(call.addresses.length) });
    await assert.rejects(venue === "curve" ? loadCurveSnapshot(setup.reader, setup.baseMint)
      : venue === "pool" ? loadPoolSnapshot(setup.reader, setup.baseMint, setup.quoteMint)
      : loadLaunchSnapshot(setup.reader, setup.quoteMint), code("missing_account"));
  }
});

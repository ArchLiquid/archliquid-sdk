import assert from "node:assert/strict";
import test from "node:test";
import {
  blockhash, getCompiledTransactionMessageDecoder,
  type Address, type Commitment, type Transaction,
} from "@solana/kit";

import { preparePoolBuyForHumanSignature } from "../examples/pool-trade.js";
import { ARCH_SWAP_PROGRAM_ADDRESS } from "../src/addresses.js";
import type { OwnedMarketTradePlan } from "../src/owned-transaction-plans.js";
import { CREATOR, TREASURY } from "./helpers/fixtures.js";
import { createSnapshotReader } from "./helpers/snapshot-reader.js";

const MAX_U64 = (1n << 64n) - 1n;
type ExampleInput = Parameters<typeof preparePoolBuyForHumanSignature>[0];

async function createExampleRpc() {
  const setup = await createSnapshotReader();
  const controls = { onSimulation: undefined as (() => void) | undefined,
    onSlot: undefined as (() => void) | undefined };
  const rpc = {
    getGenesisHash: () => ({ send: async () => setup.controls.genesisHash }),
    getMultipleAccounts: (addresses: readonly Address[], options: { commitment: Commitment }) => ({
      send: async ({ abortSignal }: { abortSignal: AbortSignal }) => {
        const response = await setup.reader.getAccounts(addresses, { ...options, abortSignal });
        return {
          context: { slot: response.slot },
          value: response.accounts.map((account) => account ? {
            data: [Buffer.from(account.data).toString("base64"), "base64"],
            owner: account.owner, lamports: account.lamports, executable: false,
          } : null),
        };
      },
    }),
    getLatestBlockhash: () => ({ send: async () => ({
      context: { slot: setup.controls.slot },
      value: { blockhash: blockhash("11111111111111111111111111111111"), lastValidBlockHeight: 1_000n },
    }) }),
    simulateTransaction: () => ({ send: async () => {
      controls.onSimulation?.();
      return { context: { slot: setup.controls.slot }, value: { err: null } };
    } }),
    getSlot: () => ({ send: async () => { controls.onSlot?.(); return setup.controls.slot; } }),
  };
  // The mock implements precisely the RPC methods exercised by this example;
  // it does not claim to be a complete transport or contact any network.
  return { setup, controls, rpc: rpc as unknown as ExampleInput["rpc"] };
}

function tradeData(transaction: Transaction) {
  const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  assert.ok(message.version === 0);
  const trade = message.instructions.find((instruction) =>
    message.staticAccounts[instruction.programAddressIndex] === ARCH_SWAP_PROGRAM_ADDRESS);
  assert.ok(trade?.data);
  return new DataView(trade.data.buffer, trade.data.byteOffset, trade.data.byteLength);
}

function inputFor(rpc: ExampleInput["rpc"], baseMint: string, quoteMint: string) {
  return { rpc, trader: CREATOR, baseMint, quoteMint,
    quoteAmount: "0.000001", minimumBaseAmount: "0.000001" };
}

test("preparation mutation and later restoration cannot change compiled user-approved trade limits", async () => {
  const { rpc, setup, controls } = await createExampleRpc();
  let walletCalled = false;
  let exposedPlan: OwnedMarketTradePlan | undefined;
  const signed = await preparePoolBuyForHumanSignature({
    ...inputFor(rpc, setup.baseMint, setup.quoteMint),
    async prepareTokenAccounts(plan) {
      exposedPlan = plan;
      const data = plan.instruction.data as Uint8Array;
      const original = new Uint8Array(data);
      new DataView(data.buffer, data.byteOffset, data.byteLength).setBigUint64(8, MAX_U64, true);
      // The old example compiled the modified bytes, then checked only this
      // restored source plan. That check cannot authenticate compiled bytes.
      controls.onSimulation = () => data.set(original);
      return [];
    },
    async requestHumanSignature(transaction) {
      walletCalled = true;
      assert.equal(tradeData(transaction).getBigUint64(8, true), 1_000n);
      assert.equal(tradeData(transaction).getBigUint64(16, true), 1n);
      return transaction;
    },
  });
  assert.ok(walletCalled && exposedPlan);
  assert.equal(tradeData(signed).getBigUint64(8, true), 1_000n);
});

test("the example rejects wallet-returned message mutations", async () => {
  const { rpc, setup } = await createExampleRpc();
  await assert.rejects(() => preparePoolBuyForHumanSignature({
    ...inputFor(rpc, setup.baseMint, setup.quoteMint),
    async prepareTokenAccounts() { return []; },
    async requestHumanSignature(transaction) {
      const messageBytes = new Uint8Array(transaction.messageBytes.buffer,
        transaction.messageBytes.byteOffset, transaction.messageBytes.byteLength);
      messageBytes[messageBytes.length - 1] = messageBytes[messageBytes.length - 1]! ^ 1;
      return transaction;
    },
  }), /different reviewed message/);
});

test("post-approval RPC awaits cannot expose wallet-held mutable transaction bytes", async () => {
  const { rpc, setup, controls } = await createExampleRpc();
  let walletHeld: Transaction | undefined;
  let reviewed: Uint8Array | undefined;
  const approved = await preparePoolBuyForHumanSignature({
    ...inputFor(rpc, setup.baseMint, setup.quoteMint),
    async prepareTokenAccounts() { return []; },
    async requestHumanSignature(transaction) {
      walletHeld = transaction;
      reviewed = new Uint8Array(transaction.messageBytes);
      controls.onSlot = () => {
        const bytes = new Uint8Array(transaction.messageBytes.buffer,
          transaction.messageBytes.byteOffset, transaction.messageBytes.byteLength);
        bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
      };
      return transaction;
    },
  });
  assert.ok(walletHeld && reviewed);
  assert.notDeepEqual(walletHeld.messageBytes, reviewed);
  assert.deepEqual(approved.messageBytes, reviewed);
  assert.equal(tradeData(approved).getBigUint64(16, true), 1n);
});

test("mutable caller input cannot replace the captured fee payer or approval callback mid-flow", async () => {
  const { rpc, setup } = await createExampleRpc();
  let approved = 0;
  let substituted = 0;
  const input = {
    ...inputFor(rpc, setup.baseMint, setup.quoteMint),
    trader: CREATOR as string,
    async prepareTokenAccounts() {
      input.trader = TREASURY;
      input.requestHumanSignature = async (transaction: Transaction) => { substituted++; return transaction; };
      return [];
    },
    async requestHumanSignature(transaction: Transaction) {
      approved++;
      assert.equal(getCompiledTransactionMessageDecoder().decode(transaction.messageBytes).staticAccounts[0], CREATOR);
      return transaction;
    },
  };
  await preparePoolBuyForHumanSignature(input);
  assert.equal(approved, 1);
  assert.equal(substituted, 0);
});

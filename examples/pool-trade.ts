import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type GetGenesisHashApi,
  type GetLatestBlockhashApi,
  type GetMultipleAccountsApi,
  type GetSlotApi,
  type Instruction,
  type ReadonlyUint8Array,
  type Rpc,
  type SimulateTransactionApi,
  type Transaction,
} from "@solana/kit";

// Repository import. When copying this example into an application, use
// "@archliquid/sdk" instead of "../src/index.js".
import {
  assertOwnedTransactionPlanSignable,
  assertOwnedInstructionMatchesIntent,
  createOwnedAccountReader,
  createOwnedMarketTradePlan,
  loadPoolSnapshot,
  parseOwnedAmount,
  type OwnedMarketTradePlan,
} from "../src/index.js";

type IntegrationRpc = Rpc<GetGenesisHashApi & GetMultipleAccountsApi & GetSlotApi & GetLatestBlockhashApi & SimulateTransactionApi>;

function detachedTransaction(transaction: Transaction, messageBytes: ReadonlyUint8Array): Transaction {
  return Object.freeze({
    ...transaction,
    messageBytes: new Uint8Array(messageBytes) as unknown as Transaction["messageBytes"],
    signatures: Object.freeze(Object.fromEntries(Object.entries(transaction.signatures).map(([signer, signature]) => [
      signer, signature === null ? null : new Uint8Array(signature),
    ]))) as unknown as Transaction["signatures"],
  });
}

/** Prepare/simulate a user-bounded buy and request an explicit human signature.
 * No requests happen on import and this function never submits a transaction.
 * The application provides a trusted devnet RPC, validates balances, and
 * prepares missing ATAs/WSOL within the user's reviewed permissions.
 */
export async function preparePoolBuyForHumanSignature(input: Readonly<{
  rpc: IntegrationRpc;
  trader: string;
  baseMint: string;
  quoteMint: string;
  quoteAmount: string;
  minimumBaseAmount: string;
  prepareTokenAccounts: (plan: OwnedMarketTradePlan) => Promise<readonly Instruction[]>;
  requestHumanSignature: (transaction: Transaction) => Promise<Transaction>;
  abortSignal?: AbortSignal;
}>): Promise<Transaction> {
  // Capture connection, callback and user input identities before any await.
  input = Object.freeze({ ...input });
  const sendOptions = input.abortSignal === undefined ? {} : { abortSignal: input.abortSignal };
  const snapshot = await loadPoolSnapshot(createOwnedAccountReader(input.rpc), input.baseMint, input.quoteMint, {
    commitment: "confirmed", ...sendOptions,
  });
  const plan = await createOwnedMarketTradePlan(snapshot, input.trader, {
    side: "buy", inputMode: "exact-quote",
    quoteAmountIn: parseOwnedAmount(input.quoteAmount, snapshot.quoteMint.decimals),
    minBaseAmountOut: parseOwnedAmount(input.minimumBaseAmount, snapshot.baseMint.decimals),
  });
  // Detach the approved instruction before any application callback can touch
  // the plan's Kit-compatible mutable data. Compile only this reviewed copy.
  const approvedInstruction: Instruction = Object.freeze({
    ...plan.instruction,
    data: new Uint8Array(plan.instruction.data ?? []),
    accounts: Object.freeze((plan.instruction.accounts ?? []).map((account) => Object.freeze({ ...account }))),
  });
  assertOwnedInstructionMatchesIntent(approvedInstruction, plan.intent);
  const preparation = await input.prepareTokenAccounts(plan);
  const { value: lifetime } = await input.rpc.getLatestBlockhash({ commitment: "confirmed", minContextSlot: snapshot.slot }).send(sendOptions);
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (value) => setTransactionMessageFeePayer(address(input.trader), value),
    (value) => setTransactionMessageLifetimeUsingBlockhash(lifetime, value),
    (value) => appendTransactionMessageInstructions([...preparation, approvedInstruction], value),
  );
  const transaction = compileTransaction(message);
  const reviewedMessage = new Uint8Array(transaction.messageBytes);
  const simulation = await input.rpc.simulateTransaction(getBase64EncodedWireTransaction(transaction), {
    encoding: "base64", sigVerify: false, commitment: "confirmed", minContextSlot: snapshot.slot,
  }).send(sendOptions);
  if (simulation.value.err !== null) throw new Error("Transaction simulation failed", { cause: simulation.value.err });
  const currentSlot = await input.rpc.getSlot({ commitment: "confirmed", minContextSlot: simulation.context.slot }).send(sendOptions);
  assertOwnedTransactionPlanSignable(plan, currentSlot);
  assertOwnedInstructionMatchesIntent(approvedInstruction, plan.intent);
  if (transaction.messageBytes.length !== reviewedMessage.length ||
      !transaction.messageBytes.every((byte, index) => byte === reviewedMessage[index])) {
    throw new Error("Transaction message changed after simulation and review");
  }
  // The wallet receives its own bytes. Mutating them cannot rewrite the message
  // retained as the approval record, and its returned bytes must still match.
  const walletTransaction = detachedTransaction(transaction, reviewedMessage);
  const signed = await input.requestHumanSignature(walletTransaction);
  if (signed.messageBytes.length !== reviewedMessage.length ||
      !signed.messageBytes.every((byte, index) => byte === reviewedMessage[index])) {
    throw new Error("Wallet returned a transaction with a different reviewed message");
  }
  // Retain independent approved bytes before awaiting another RPC request;
  // the wallet may still hold mutable references to its returned transaction.
  const approvedSigned = detachedTransaction(signed, reviewedMessage);
  const afterApprovalSlot = await input.rpc.getSlot({ commitment: "confirmed", minContextSlot: currentSlot }).send(sendOptions);
  assertOwnedTransactionPlanSignable(plan, afterApprovalSlot);
  // Before any explicit send the application still checks required signatures,
  // block-height expiry, final wallet permissions and confirmation policy.
  return approvedSigned;
}

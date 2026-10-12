import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOwnedInstruction,
  buildTypedOwnedInstruction,
  type OwnedInstructionInputFor,
  type TypedOwnedInstructionInput,
} from "../src/owned-program-instructions.js";

const ACCOUNT = "So11111111111111111111111111111111111111112";
const accounts = {
  pool: ACCOUNT,
  base_mint: ACCOUNT,
  quote_mint: ACCOUNT,
  lp_mint: ACCOUNT,
  base_vault: ACCOUNT,
  quote_vault: ACCOUNT,
  provider_base_account: ACCOUNT,
  provider_quote_account: ACCOUNT,
  provider_lp_account: ACCOUNT,
  provider: ACCOUNT,
};
const input = {
  program: "archSwap",
  instruction: "deposit_liquidity",
  accounts,
  args: { lp_shares_out: 1n, max_base_amount_in: 2n, max_quote_amount_in: 3n },
} as const satisfies OwnedInstructionInputFor<"archSwap", "deposit_liquidity">;

const curveInput = {
  program: "archCurve",
  instruction: "create_curve",
  accounts: {
    protocol_config: ACCOUNT,
    launch_config: ACCOUNT,
    base_mint: ACCOUNT,
    curve: ACCOUNT,
    base_vault: ACCOUNT,
    quote_vault: ACCOUNT,
    quote_mint: ACCOUNT,
    metadata: ACCOUNT,
    creator: ACCOUNT,
  },
  args: {
    launch_nonce: 1n,
    metadata: { name: "Arch", symbol: "ARCH", uri: "https://example.com/token.json" },
    metadata_commitment: new Uint8Array(32).fill(1),
  },
} as const satisfies OwnedInstructionInputFor<"archCurve", "create_curve">;

// This function is intentionally never called: tsc checks the rejected inputs
// as part of npm run typecheck, without sending malformed input to the runtime.
function compileTimeAssertions() {
  // @ts-expect-error create_curve is not a public archSwap instruction.
  buildTypedOwnedInstruction({ ...curveInput, program: "archSwap" });
  // @ts-expect-error a liquidity instruction cannot be requalified as archCurve.
  buildTypedOwnedInstruction({ ...input, program: "archCurve" });
  // @ts-expect-error administrative instructions remain unavailable.
  buildTypedOwnedInstruction({ program: "archCurve", instruction: "initialize_protocol_config", accounts: {} });
  // @ts-expect-error all non-fixed liquidity accounts are required.
  buildTypedOwnedInstruction({ ...input, accounts: {} });
  // @ts-expect-error liquidity instructions require args.
  buildTypedOwnedInstruction({ program: "archSwap", instruction: "deposit_liquidity", accounts });
  // @ts-expect-error max_quote_amount_in is required.
  buildTypedOwnedInstruction({ ...input, args: { lp_shares_out: 1n, max_base_amount_in: 2n } });
  // @ts-expect-error instruction amounts must be bigint, not a lossy number.
  buildTypedOwnedInstruction({ ...input, args: { ...input.args, lp_shares_out: 1 } });
  // @ts-expect-error misspelled/extra args are rejected in literal inputs.
  buildTypedOwnedInstruction({ ...input, args: { ...input.args, typo: 1n } });
  // @ts-expect-error withdraw arguments cannot be supplied for deposit_liquidity.
  buildTypedOwnedInstruction({ ...input, args: { lp_shares_in: 1n, min_base_amount_out: 0n, min_quote_amount_out: 0n } });
  // @ts-expect-error required Curve args include metadata and commitment.
  const invalid: TypedOwnedInstructionInput = { ...curveInput, args: { launch_nonce: 1n } };
  // @ts-expect-error metadata cannot be replaced by an arbitrary bigint.
  buildTypedOwnedInstruction({ ...curveInput, args: { ...curveInput.args, metadata: 1n } });
  // @ts-expect-error commitment must be bytes rather than a string.
  buildTypedOwnedInstruction({ ...curveInput, args: { ...curveInput.args, metadata_commitment: "hash" } });
  // @ts-expect-error the reusable input type also rejects impossible program/instruction pairs.
  type InvalidPair = OwnedInstructionInputFor<"archSwap", "create_curve">;
  const claimAccounts = { curve: ACCOUNT, quote_mint: ACCOUNT, quote_vault: ACCOUNT, creator_quote_account: ACCOUNT };
  // @ts-expect-error claims have no user-supplied instruction arguments.
  buildTypedOwnedInstruction({ program: "archCurve", instruction: "claim_creator_fees", accounts: claimAccounts, args: { amount: 1n } });
  void invalid;
}
void compileTimeAssertions;

test("the typed builder preserves legacy bytes and auto-filled fixed accounts", () => {
  assert.deepEqual(buildTypedOwnedInstruction(input), buildOwnedInstruction(input));
  assert.deepEqual(buildTypedOwnedInstruction(curveInput), buildOwnedInstruction(curveInput));
  const claim: TypedOwnedInstructionInput = {
    program: "archCurve",
    instruction: "claim_creator_fees",
    accounts: { curve: ACCOUNT, quote_mint: ACCOUNT, quote_vault: ACCOUNT, creator_quote_account: ACCOUNT },
  };
  assert.deepEqual(buildTypedOwnedInstruction(claim), buildOwnedInstruction(claim));
});

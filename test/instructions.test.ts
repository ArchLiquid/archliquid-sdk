import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { AccountRole, address, type Instruction } from "@solana/kit";

import {
  OWNED_SOLANA_PROGRAMS,
  assertOwnedInstructionMatchesIntent,
  assertOwnedInstructionSignable,
  buildOwnedInstruction,
  buildTypedOwnedInstruction,
  type OwnedInstructionInput,
  type OwnedInstructionArgumentValue,
  type OwnedInstructionInputFor,
  type OwnedProgramName,
} from "../src/owned-program-instructions.js";
import {
  OWNED_PROGRAM_ERROR_DEFINITIONS,
  OwnedProgramError,
  decodeOwnedProgramError,
  type OwnedErrorProgramName,
} from "../src/owned-program-errors.js";
import {
  ARCH_CURVE_PROGRAM_ADDRESS,
  ARCH_LOCKER_PROGRAM_ADDRESS,
  ARCH_SWAP_PROGRAM_ADDRESS,
} from "../src/addresses.js";

const PRIMARY = "So11111111111111111111111111111111111111112";
const SUBSTITUTE = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const MAX_U64 = (1n << 64n) - 1n;

const deposit: OwnedInstructionInputFor<"archSwap", "deposit_liquidity"> = {
  program: "archSwap",
  instruction: "deposit_liquidity",
  accounts: {
    pool: PRIMARY,
    base_mint: PRIMARY,
    quote_mint: PRIMARY,
    lp_mint: PRIMARY,
    base_vault: PRIMARY,
    quote_vault: PRIMARY,
    provider_base_account: PRIMARY,
    provider_quote_account: PRIMARY,
    provider_lp_account: PRIMARY,
    provider: PRIMARY,
  },
  args: { lp_shares_out: 7n, max_base_amount_in: 11n, max_quote_amount_in: 13n },
};

const createCurve: OwnedInstructionInputFor<"archCurve", "create_curve"> = {
  program: "archCurve",
  instruction: "create_curve",
  accounts: {
    protocol_config: PRIMARY,
    launch_config: PRIMARY,
    base_mint: PRIMARY,
    curve: PRIMARY,
    base_vault: PRIMARY,
    quote_vault: PRIMARY,
    quote_mint: PRIMARY,
    metadata: PRIMARY,
    creator: PRIMARY,
  },
  args: {
    launch_nonce: 3n,
    metadata: { name: "ArchLiquid", symbol: "ARCH", uri: "https://example.com/token.json" },
    metadata_commitment: new Uint8Array(32).fill(1),
  },
};

test("strict instruction validation rejects a raised spend cap accepted by the legacy schema assertion", () => {
  const approved = buildTypedOwnedInstruction(deposit);
  assert.deepEqual(assertOwnedInstructionMatchesIntent(approved, deposit).args, deposit.args);
  const substituted = buildTypedOwnedInstruction({
    ...deposit,
    args: { ...deposit.args, max_base_amount_in: MAX_U64 },
  });
  assert.equal(assertOwnedInstructionSignable(substituted, deposit).args.max_base_amount_in, MAX_U64);
  assert.throws(() => assertOwnedInstructionMatchesIntent(substituted, deposit), /instruction arguments/);
});

test("strict instruction validation rejects substituted metadata and commitment bytes", () => {
  assert.deepEqual(
    assertOwnedInstructionMatchesIntent(buildTypedOwnedInstruction(createCurve), createCurve).args,
    createCurve.args,
  );
  for (const field of ["name", "symbol", "uri"] as const) {
    const substituted = buildTypedOwnedInstruction({
      ...createCurve,
      args: { ...createCurve.args, metadata: { ...createCurve.args.metadata, [field]: "changed" } },
    });
    assert.doesNotThrow(() => assertOwnedInstructionSignable(substituted, createCurve));
    assert.throws(() => assertOwnedInstructionMatchesIntent(substituted, createCurve), /instruction arguments/);
  }
  const substituted = buildTypedOwnedInstruction({
    ...createCurve,
    args: { ...createCurve.args, metadata_commitment: new Uint8Array(32).fill(2) },
  });
  assert.doesNotThrow(() => assertOwnedInstructionSignable(substituted, createCurve));
  assert.throws(() => assertOwnedInstructionMatchesIntent(substituted, createCurve), /instruction arguments/);
});

test("metadata rejects oversized strings before encoding while preserving UTF-8 byte limits", (t) => {
  const encoded: string[] = [];
  const originalEncode = TextEncoder.prototype.encode;
  t.mock.method(TextEncoder.prototype, "encode", function (this: TextEncoder, value?: string) {
    if (value !== undefined) encoded.push(value);
    return originalEncode.call(this, value);
  });
  for (const [field, cap] of [["name", 32], ["symbol", 10], ["uri", 200]] as const) {
    const oversized = "a".repeat(1_000_000);
    assert.throws(() => buildTypedOwnedInstruction({ ...createCurve,
      args: { ...createCurve.args, metadata: { ...createCurve.args.metadata, [field]: oversized } },
    }), new RegExp(`Invalid metadata ${field === "uri" ? "URI" : field} bytes`));
    assert.ok(!encoded.includes(oversized));
    assert.doesNotThrow(() => buildTypedOwnedInstruction({ ...createCurve,
      args: { ...createCurve.args, metadata: { ...createCurve.args.metadata, [field]: "a".repeat(cap) } },
    }));
    assert.throws(() => buildTypedOwnedInstruction({ ...createCurve,
      args: { ...createCurve.args, metadata: { ...createCurve.args.metadata, [field]: "é".repeat(Math.floor(cap / 2) + 1) } },
    }), new RegExp(`Invalid metadata ${field === "uri" ? "URI" : field} bytes`));
  }
});

test("strict intent validation checks account identities, roles, programs and complete data", () => {
  const approved = buildTypedOwnedInstruction(deposit);
  assert.ok(approved.accounts && approved.data);
  const approvedData = approved.data;
  const changedAccount: Instruction = {
    ...approved,
    accounts: approved.accounts.map((account, index) => index === 0
      ? { ...account, address: address(SUBSTITUTE) } : account),
  };
  assert.throws(() => assertOwnedInstructionMatchesIntent(changedAccount, deposit), /Unexpected address for pool/);
  const changedRole: Instruction = {
    ...approved,
    accounts: approved.accounts.map((account, index) => index === 0
      ? { ...account, role: AccountRole.READONLY } : account),
  };
  assert.throws(() => assertOwnedInstructionMatchesIntent(changedRole, deposit), /Unexpected role for pool/);
  assert.throws(() => assertOwnedInstructionMatchesIntent({
    ...approved, programAddress: address(SUBSTITUTE),
  }, deposit), /Unexpected program address/);
  assert.throws(() => assertOwnedInstructionMatchesIntent({
    ...approved, data: new Uint8Array([...approvedData, 0]),
  }, deposit), /data length/);
  assert.throws(() => assertOwnedInstructionMatchesIntent(approved, {
    ...deposit, args: undefined,
  } as unknown as OwnedInstructionInput), /Missing lp_shares_out/);
  assert.throws(() => assertOwnedInstructionMatchesIntent(approved, {
    ...deposit, accounts: { ...deposit.accounts, token_program: SUBSTITUTE },
  }), /token_program must be/);
});

type IdlInstruction = {
  name: string;
  discriminator: number[];
  accounts: { name: string; writable?: boolean; signer?: boolean; address?: string }[];
  args: { name: string; type: unknown }[];
};

type PublicInstructionSchema = Readonly<{
  discriminator: readonly number[];
  accounts: readonly Readonly<{ name: string; role: AccountRole; address?: string }>[];
  args: readonly Readonly<{
    name: string;
    type: "u64" | Readonly<{ defined: Readonly<{ name: "TokenMetadataInput" }> }>
      | Readonly<{ array: readonly ["u8", 32] }>;
  }>[];
}>;

test("every public instruction schema matches its IDL and preserves every approved argument", async () => {
  let checked = 0;
  for (const programName of Object.keys(OWNED_SOLANA_PROGRAMS) as OwnedProgramName[]) {
    const program = OWNED_SOLANA_PROGRAMS[programName];
    const file = programName === "archCurve" ? "arch_curve" : "arch_swap";
    const source = await readFile(new URL(`../idl/${file}.json`, import.meta.url), "utf8");
    // IDL identity is its governed LF content, including in old CRLF workspaces.
    const hash = createHash("sha256").update(source.replace(/\r\n/g, "\n")).digest("hex");
    assert.equal(hash, program.idlSha256);
    const idl = JSON.parse(source) as { address: string; instructions: IdlInstruction[] };
    assert.equal(idl.address, program.programAddress);
    for (const [instructionName, schema] of Object.entries(program.instructions) as [string, PublicInstructionSchema][]) {
      const governed = idl.instructions.find((instruction) => instruction.name === instructionName);
      assert.ok(governed, `${programName}.${instructionName} is in the IDL`);
      assert.deepEqual(schema.discriminator, governed.discriminator);
      assert.deepEqual(schema.args, governed.args);
      assert.deepEqual(schema.accounts.map(({ name, role }) => ({ name, role })),
        governed.accounts.map(({ name, writable, signer }) => ({
          name,
          role: signer
            ? writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER
            : writable ? AccountRole.WRITABLE : AccountRole.READONLY,
        })));
      const args: Record<string, OwnedInstructionArgumentValue> = {};
      for (const argument of schema.args) {
        args[argument.name] = argument.type === "u64" ? 19n
          : "defined" in argument.type ? createCurve.args.metadata : new Uint8Array(32).fill(1);
      }
      const input: OwnedInstructionInput = {
        program: programName,
        instruction: instructionName as OwnedInstructionInput["instruction"],
        accounts: Object.fromEntries(schema.accounts.map((account) => [account.name, "address" in account ? account.address : PRIMARY])),
        args,
      };
      const instruction = buildOwnedInstruction(input);
      assert.deepEqual(assertOwnedInstructionMatchesIntent(instruction, input).args, args);
      for (const argument of schema.args) {
        if (argument.type !== "u64") continue;
        const changed = buildOwnedInstruction({ ...input, args: { ...args, [argument.name]: MAX_U64 } });
        assert.equal(assertOwnedInstructionSignable(changed, input).args[argument.name], MAX_U64);
        assert.throws(() => assertOwnedInstructionMatchesIntent(changed, input), /instruction arguments/);
      }
      checked += 1;
    }
    assert.throws(() => buildOwnedInstruction({
      program: programName, instruction: "initialize" as OwnedInstructionInput["instruction"], accounts: {},
    }), /not a public/);
  }
  assert.equal(checked, 14);
});

test("the published schema registry is recursively immutable", () => {
  function assertFrozen(value: unknown): void {
    if (!value || typeof value !== "object") return;
    assert.ok(Object.isFrozen(value));
    for (const child of Object.values(value)) assertFrozen(child);
  }
  assertFrozen(OWNED_SOLANA_PROGRAMS);
  assert.equal(Reflect.set(OWNED_SOLANA_PROGRAMS.archSwap, "programAddress", SUBSTITUTE), false);
  assert.equal(Reflect.set(OWNED_SOLANA_PROGRAMS.archSwap.instructions.deposit_liquidity.discriminator, "0", 0), false);
});

test("all 99 program-qualified error definitions match the committed IDLs", async () => {
  const programs = [
    ["archCurve", "arch_curve", ARCH_CURVE_PROGRAM_ADDRESS],
    ["archSwap", "arch_swap", ARCH_SWAP_PROGRAM_ADDRESS],
    ["archLocker", "arch_locker", ARCH_LOCKER_PROGRAM_ADDRESS],
  ] as const;
  let checked = 0;
  for (const [program, file, programAddress] of programs) {
    const idl = JSON.parse(await readFile(new URL(`../idl/${file}.json`, import.meta.url), "utf8")) as {
      errors: { code: number; name: string; msg: string }[];
    };
    assert.deepEqual(OWNED_PROGRAM_ERROR_DEFINITIONS[program], idl.errors);
    assert.ok(Object.isFrozen(OWNED_PROGRAM_ERROR_DEFINITIONS[program]));
    for (const definition of idl.errors) {
      const decoded = decodeOwnedProgramError(program, definition.code);
      assert.ok(decoded instanceof OwnedProgramError);
      assert.equal(decoded.programAddress, programAddress);
      assert.equal(decoded.program, program);
      assert.equal(decoded.code, definition.code);
      assert.equal(decoded.errorName, definition.name);
      assert.equal(decoded.programMessage, definition.msg);
      assert.equal(decodeOwnedProgramError(programAddress, definition.code)?.errorName, definition.name);
      checked += 1;
    }
  }
  assert.equal(checked, 99);
});

test("error decoding preserves program qualification, error causes and instruction context", () => {
  assert.equal(decodeOwnedProgramError("archCurve", 6000)?.errorName, "DefaultAddress");
  assert.equal(decodeOwnedProgramError("archLocker", 6000)?.errorName, "ZeroAmount");
  const cause = new Error("RPC transaction error");
  const decoded = decodeOwnedProgramError("archSwap", 6026, { cause, instructionIndex: 4 });
  assert.equal(decoded?.instructionIndex, 4);
  assert.equal(decoded?.cause, cause);
  assert.equal(decoded?.message, "archSwap.SlippageExceeded: trade slippage limit was exceeded");
  for (const code of [-1, NaN, Infinity, 6000.5, 0xffff_ffff + 1, 9999]) {
    assert.equal(decodeOwnedProgramError("archCurve", code), null);
  }
  assert.equal(decodeOwnedProgramError("unknown", 6000), null);
  assert.equal(decodeOwnedProgramError(PRIMARY, 6000), null);
  assert.equal(decodeOwnedProgramError("archCurve", 6000, { instructionIndex: NaN }), null);
  assert.equal(decodeOwnedProgramError("archCurve", 6000, { instructionIndex: -1 }), null);
  // Numeric error codes must never be guessed from a different program.
  const names: OwnedErrorProgramName[] = ["archCurve", "archSwap", "archLocker"];
  for (const name of names) assert.ok(decodeOwnedProgramError(name, 6000));
});

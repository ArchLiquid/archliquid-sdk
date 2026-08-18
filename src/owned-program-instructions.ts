import {
  AccountRole,
  address,
  type Address,
  type Instruction,
  type ReadonlyUint8Array,
} from "@solana/kit";

import {
  ARCH_CURVE_PROGRAM_ADDRESS,
  ARCH_SWAP_PROGRAM_ADDRESS,
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  METAPLEX_TOKEN_METADATA_PROGRAM_ADDRESS,
  RENT_SYSVAR_ADDRESS,
  SPL_TOKEN_PROGRAM_ADDRESS,
  SYSTEM_PROGRAM_ADDRESS,
} from "./addresses.js";

const MAX_U64 = (1n << 64n) - 1n;

type AccountSchema = Readonly<{
  name: string;
  role: AccountRole;
  address?: string;
}>;

type ArgumentSchema =
  | Readonly<{ name: string; type: "u64" }>
  | Readonly<{
      name: string;
      type: Readonly<{ defined: Readonly<{ name: "TokenMetadataInput" }> }>;
    }>
  | Readonly<{ name: string; type: Readonly<{ array: readonly ["u8", 32] }> }>;

type InstructionSchema = Readonly<{
  discriminator: readonly number[];
  accounts: readonly AccountSchema[];
  args: readonly ArgumentSchema[];
}>;

const CURVE_TRADE_ACCOUNTS = [
  { name: "curve", role: AccountRole.WRITABLE },
  { name: "launch_config", role: AccountRole.READONLY },
  { name: "base_mint", role: AccountRole.READONLY },
  { name: "quote_mint", role: AccountRole.READONLY },
  { name: "base_vault", role: AccountRole.WRITABLE },
  { name: "quote_vault", role: AccountRole.WRITABLE },
  { name: "trader_base_account", role: AccountRole.WRITABLE },
  { name: "trader_quote_account", role: AccountRole.WRITABLE },
  { name: "trader", role: AccountRole.READONLY_SIGNER },
  { name: "token_program", role: AccountRole.READONLY, address: SPL_TOKEN_PROGRAM_ADDRESS },
] as const satisfies readonly AccountSchema[];

const SWAP_TRADE_ACCOUNTS = [
  { name: "pool", role: AccountRole.WRITABLE },
  { name: "base_mint", role: AccountRole.READONLY },
  { name: "quote_mint", role: AccountRole.READONLY },
  { name: "base_vault", role: AccountRole.WRITABLE },
  { name: "quote_vault", role: AccountRole.WRITABLE },
  { name: "trader_base_account", role: AccountRole.WRITABLE },
  { name: "trader_quote_account", role: AccountRole.WRITABLE },
  { name: "trader", role: AccountRole.READONLY_SIGNER },
  { name: "token_program", role: AccountRole.READONLY, address: SPL_TOKEN_PROGRAM_ADDRESS },
] as const satisfies readonly AccountSchema[];

const SWAP_LIQUIDITY_ACCOUNTS = [
  { name: "pool", role: AccountRole.WRITABLE },
  { name: "base_mint", role: AccountRole.READONLY },
  { name: "quote_mint", role: AccountRole.READONLY },
  { name: "lp_mint", role: AccountRole.WRITABLE },
  { name: "base_vault", role: AccountRole.WRITABLE },
  { name: "quote_vault", role: AccountRole.WRITABLE },
  { name: "provider_base_account", role: AccountRole.WRITABLE },
  { name: "provider_quote_account", role: AccountRole.WRITABLE },
  { name: "provider_lp_account", role: AccountRole.WRITABLE },
  { name: "provider", role: AccountRole.READONLY_SIGNER },
  { name: "token_program", role: AccountRole.READONLY, address: SPL_TOKEN_PROGRAM_ADDRESS },
] as const satisfies readonly AccountSchema[];

const BUY_EXACT_BASE_OUT_ARGS = [
  { name: "base_amount_out", type: "u64" },
  { name: "max_quote_amount_in", type: "u64" },
] as const satisfies readonly ArgumentSchema[];

const BUY_EXACT_QUOTE_IN_ARGS = [
  { name: "quote_amount_in", type: "u64" },
  { name: "min_base_amount_out", type: "u64" },
] as const satisfies readonly ArgumentSchema[];

const SELL_EXACT_BASE_IN_ARGS = [
  { name: "base_amount_in", type: "u64" },
  { name: "min_quote_amount_out", type: "u64" },
] as const satisfies readonly ArgumentSchema[];

/**
 * Committed client schema for user-facing instructions only. The hashes bind
 * this schema to the IDLs published with this package.
 * Administrative initialization and configuration instructions are
 * deliberately unavailable to the public application builder.
 */
export const OWNED_SOLANA_PROGRAMS = {
  archCurve: {
    programAddress: ARCH_CURVE_PROGRAM_ADDRESS,
    idlSha256: "fde22f26875647a07a030e94c12492097c28ed4a8cc243f1e5b380b827ef4a7a",
    instructions: {
      create_curve: {
        discriminator: [169, 235, 221, 223, 65, 109, 120, 183],
        accounts: [
          { name: "protocol_config", role: AccountRole.READONLY },
          { name: "launch_config", role: AccountRole.READONLY },
          { name: "base_mint", role: AccountRole.WRITABLE },
          { name: "curve", role: AccountRole.WRITABLE },
          { name: "base_vault", role: AccountRole.WRITABLE },
          { name: "quote_vault", role: AccountRole.WRITABLE },
          { name: "quote_mint", role: AccountRole.READONLY },
          { name: "metadata", role: AccountRole.WRITABLE },
          { name: "creator", role: AccountRole.WRITABLE_SIGNER },
          { name: "token_program", role: AccountRole.READONLY, address: SPL_TOKEN_PROGRAM_ADDRESS },
          {
            name: "associated_token_program",
            role: AccountRole.READONLY,
            address: ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
          },
          {
            name: "metadata_program",
            role: AccountRole.READONLY,
            address: METAPLEX_TOKEN_METADATA_PROGRAM_ADDRESS,
          },
          { name: "system_program", role: AccountRole.READONLY, address: SYSTEM_PROGRAM_ADDRESS },
          { name: "rent", role: AccountRole.READONLY, address: RENT_SYSVAR_ADDRESS },
        ],
        args: [
          { name: "launch_nonce", type: "u64" },
          {
            name: "metadata",
            type: { defined: { name: "TokenMetadataInput" } },
          },
          { name: "metadata_commitment", type: { array: ["u8", 32] } },
        ],
      },
      buy_exact_base_out: {
        discriminator: [122, 161, 65, 178, 68, 116, 77, 81],
        accounts: CURVE_TRADE_ACCOUNTS,
        args: BUY_EXACT_BASE_OUT_ARGS,
      },
      buy_exact_quote_in: {
        discriminator: [198, 46, 21, 82, 180, 217, 232, 112],
        accounts: CURVE_TRADE_ACCOUNTS,
        args: BUY_EXACT_QUOTE_IN_ARGS,
      },
      sell_exact_base_in: {
        discriminator: [116, 232, 182, 230, 194, 174, 30, 95],
        accounts: CURVE_TRADE_ACCOUNTS,
        args: SELL_EXACT_BASE_IN_ARGS,
      },
      claim_creator_fees: {
        discriminator: [0, 23, 125, 234, 156, 118, 134, 89],
        accounts: [
          { name: "curve", role: AccountRole.WRITABLE },
          { name: "quote_mint", role: AccountRole.READONLY },
          { name: "quote_vault", role: AccountRole.WRITABLE },
          { name: "creator_quote_account", role: AccountRole.WRITABLE },
          { name: "token_program", role: AccountRole.READONLY, address: SPL_TOKEN_PROGRAM_ADDRESS },
        ],
        args: [],
      },
      claim_protocol_fees: {
        discriminator: [34, 142, 219, 112, 109, 54, 133, 23],
        accounts: [
          { name: "protocol_config", role: AccountRole.READONLY },
          { name: "curve", role: AccountRole.WRITABLE },
          { name: "quote_mint", role: AccountRole.READONLY },
          { name: "quote_vault", role: AccountRole.WRITABLE },
          { name: "treasury_quote_account", role: AccountRole.WRITABLE },
          { name: "token_program", role: AccountRole.READONLY, address: SPL_TOKEN_PROGRAM_ADDRESS },
        ],
        args: [],
      },
      migrate_curve: {
        discriminator: [151, 254, 50, 13, 112, 235, 152, 72],
        accounts: [
          { name: "protocol_config", role: AccountRole.READONLY },
          { name: "launch_config", role: AccountRole.READONLY },
          { name: "curve", role: AccountRole.WRITABLE },
          { name: "base_mint", role: AccountRole.READONLY },
          { name: "quote_mint", role: AccountRole.READONLY },
          { name: "base_vault", role: AccountRole.WRITABLE },
          { name: "quote_vault", role: AccountRole.WRITABLE },
          { name: "swap_config", role: AccountRole.READONLY },
          { name: "arch_swap_pool", role: AccountRole.WRITABLE },
          { name: "arch_swap_base_vault", role: AccountRole.WRITABLE },
          { name: "arch_swap_quote_vault", role: AccountRole.WRITABLE },
          { name: "arch_swap_lp_mint", role: AccountRole.WRITABLE },
          { name: "arch_swap_initial_lp_token_account", role: AccountRole.WRITABLE },
          { name: "payer", role: AccountRole.WRITABLE_SIGNER },
          {
            name: "arch_swap_program",
            role: AccountRole.READONLY,
            address: ARCH_SWAP_PROGRAM_ADDRESS,
          },
          { name: "token_program", role: AccountRole.READONLY, address: SPL_TOKEN_PROGRAM_ADDRESS },
          {
            name: "associated_token_program",
            role: AccountRole.READONLY,
            address: ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
          },
          { name: "system_program", role: AccountRole.READONLY, address: SYSTEM_PROGRAM_ADDRESS },
          { name: "rent", role: AccountRole.READONLY, address: RENT_SYSVAR_ADDRESS },
        ],
        args: [],
      },
    },
  },
  archSwap: {
    programAddress: ARCH_SWAP_PROGRAM_ADDRESS,
    idlSha256: "90c5b2a6aedfb3d4393724f4ecb80b7e805051a74d7d3d7a7fc7236860757cda",
    instructions: {
      buy_exact_base_out: {
        discriminator: [122, 161, 65, 178, 68, 116, 77, 81],
        accounts: SWAP_TRADE_ACCOUNTS,
        args: BUY_EXACT_BASE_OUT_ARGS,
      },
      buy_exact_quote_in: {
        discriminator: [198, 46, 21, 82, 180, 217, 232, 112],
        accounts: SWAP_TRADE_ACCOUNTS,
        args: BUY_EXACT_QUOTE_IN_ARGS,
      },
      sell_exact_base_in: {
        discriminator: [116, 232, 182, 230, 194, 174, 30, 95],
        accounts: SWAP_TRADE_ACCOUNTS,
        args: SELL_EXACT_BASE_IN_ARGS,
      },
      deposit_liquidity: {
        discriminator: [245, 99, 59, 25, 151, 71, 233, 249],
        accounts: SWAP_LIQUIDITY_ACCOUNTS,
        args: [
          { name: "lp_shares_out", type: "u64" },
          { name: "max_base_amount_in", type: "u64" },
          { name: "max_quote_amount_in", type: "u64" },
        ],
      },
      withdraw_liquidity: {
        discriminator: [149, 158, 33, 185, 47, 243, 253, 31],
        accounts: SWAP_LIQUIDITY_ACCOUNTS,
        args: [
          { name: "lp_shares_in", type: "u64" },
          { name: "min_base_amount_out", type: "u64" },
          { name: "min_quote_amount_out", type: "u64" },
        ],
      },
      claim_creator_fees: {
        discriminator: [0, 23, 125, 234, 156, 118, 134, 89],
        accounts: [
          { name: "pool", role: AccountRole.WRITABLE },
          { name: "base_mint", role: AccountRole.READONLY },
          { name: "quote_mint", role: AccountRole.READONLY },
          { name: "quote_vault", role: AccountRole.WRITABLE },
          { name: "creator_quote_account", role: AccountRole.WRITABLE },
          { name: "token_program", role: AccountRole.READONLY, address: SPL_TOKEN_PROGRAM_ADDRESS },
        ],
        args: [],
      },
      claim_protocol_fees: {
        discriminator: [34, 142, 219, 112, 109, 54, 133, 23],
        accounts: [
          { name: "swap_config", role: AccountRole.READONLY },
          { name: "pool", role: AccountRole.WRITABLE },
          { name: "base_mint", role: AccountRole.READONLY },
          { name: "quote_mint", role: AccountRole.READONLY },
          { name: "quote_vault", role: AccountRole.WRITABLE },
          { name: "treasury_quote_account", role: AccountRole.WRITABLE },
          { name: "token_program", role: AccountRole.READONLY, address: SPL_TOKEN_PROGRAM_ADDRESS },
        ],
        args: [],
      },
    },
  },
} as const;

export type OwnedProgramName = keyof typeof OWNED_SOLANA_PROGRAMS;
export type OwnedInstructionName =
  | keyof (typeof OWNED_SOLANA_PROGRAMS)["archCurve"]["instructions"]
  | keyof (typeof OWNED_SOLANA_PROGRAMS)["archSwap"]["instructions"];

export type OwnedInstructionInput = Readonly<{
  program: OwnedProgramName;
  instruction: OwnedInstructionName;
  accounts: Readonly<Record<string, string>>;
  args?: Readonly<Record<string, OwnedInstructionArgumentValue>>;
}>;

export type TokenMetadataInstructionInput = Readonly<{
  name: string;
  symbol: string;
  uri: string;
}>;

export type OwnedInstructionArgumentValue =
  | bigint
  | TokenMetadataInstructionInput
  | ReadonlyUint8Array;

export type DecodedOwnedInstruction = Readonly<{
  program: OwnedProgramName;
  instruction: OwnedInstructionName;
  programAddress: Address;
  accounts: Readonly<Record<string, Address>>;
  args: Readonly<Record<string, OwnedInstructionArgumentValue>>;
}>;

function instructionSchema(
  program: OwnedProgramName,
  instruction: OwnedInstructionName,
): InstructionSchema {
  const schema = OWNED_SOLANA_PROGRAMS[program].instructions as Readonly<
    Record<string, InstructionSchema>
  >;
  const selected = schema[instruction];
  if (!selected) {
    throw new Error(`${instruction} is not a public ${program} instruction`);
  }
  return selected;
}

function checkedU64(name: string, value: OwnedInstructionArgumentValue | undefined): bigint {
  if (value === undefined) throw new Error(`Missing ${name} argument`);
  if (typeof value !== "bigint") throw new Error(`Invalid ${name} argument`);
  if (value < 0n || value > MAX_U64) throw new Error(`${name} is outside u64 range`);
  return value;
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function checkedMetadata(
  name: string,
  value: OwnedInstructionArgumentValue | undefined,
): TokenMetadataInstructionInput {
  if (!value || typeof value !== "object" || value instanceof Uint8Array) {
    throw new Error(`Missing or invalid ${name} argument`);
  }
  const candidate = value as Partial<Record<keyof TokenMetadataInstructionInput, unknown>>;
  if (
    typeof candidate.name !== "string" ||
    typeof candidate.symbol !== "string" ||
    typeof candidate.uri !== "string" ||
    Object.keys(value).sort().join("|") !== "name|symbol|uri"
  ) {
    throw new Error(`Missing or invalid ${name} argument`);
  }
  const nameBytes = utf8Encoder.encode(candidate.name);
  const symbolBytes = utf8Encoder.encode(candidate.symbol);
  const uriBytes = utf8Encoder.encode(candidate.uri);
  if (nameBytes.length < 1 || nameBytes.length > 32) throw new Error("Invalid metadata name bytes");
  if (symbolBytes.length < 1 || symbolBytes.length > 10) throw new Error("Invalid metadata symbol bytes");
  if (uriBytes.length < 1 || uriBytes.length > 200) throw new Error("Invalid metadata URI bytes");
  return { name: candidate.name, symbol: candidate.symbol, uri: candidate.uri };
}

function checkedBytes32(name: string, value: OwnedInstructionArgumentValue | undefined) {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw new Error(`${name} must be exactly 32 bytes`);
  }
  if (value.every((byte) => byte === 0)) throw new Error(`${name} cannot be all zeroes`);
  return value;
}

function u32Bytes(value: number) {
  const data = new Uint8Array(4);
  new DataView(data.buffer).setUint32(0, value, true);
  return data;
}

function u64Bytes(value: bigint) {
  const data = new Uint8Array(8);
  new DataView(data.buffer).setBigUint64(0, value, true);
  return data;
}

function borshString(value: string) {
  const bytes = utf8Encoder.encode(value);
  return [u32Bytes(bytes.length), bytes] as const;
}

function concatBytes(chunks: readonly ReadonlyUint8Array[]) {
  const data = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }
  return data;
}

function encodeInstructionData(
  schema: InstructionSchema,
  args: Readonly<Record<string, OwnedInstructionArgumentValue>>,
) {
  const expectedNames = new Set(schema.args.map((argument) => argument.name));
  for (const suppliedName of Object.keys(args)) {
    if (!expectedNames.has(suppliedName)) throw new Error(`Unexpected ${suppliedName} argument`);
  }
  const chunks: ReadonlyUint8Array[] = [new Uint8Array(schema.discriminator)];
  for (const argument of schema.args) {
    const value = args[argument.name];
    if (argument.type === "u64") {
      chunks.push(u64Bytes(checkedU64(argument.name, value)));
    } else if ("defined" in argument.type) {
      const metadata = checkedMetadata(argument.name, value);
      chunks.push(...borshString(metadata.name));
      chunks.push(...borshString(metadata.symbol));
      chunks.push(...borshString(metadata.uri));
    } else {
      chunks.push(checkedBytes32(argument.name, value));
    }
  }
  return concatBytes(chunks);
}

export function buildOwnedInstruction(input: OwnedInstructionInput): Instruction {
  const program = OWNED_SOLANA_PROGRAMS[input.program];
  const schema = instructionSchema(input.program, input.instruction);
  const accounts = schema.accounts.map((accountSchema) => {
    const supplied = input.accounts[accountSchema.name];
    if (accountSchema.address && supplied && supplied !== accountSchema.address) {
      throw new Error(`${accountSchema.name} must be ${accountSchema.address}`);
    }
    const accountAddress = accountSchema.address ?? supplied;
    if (!accountAddress) throw new Error(`Missing ${accountSchema.name} account`);
    return { address: address(accountAddress), role: accountSchema.role };
  });

  return {
    programAddress: address(program.programAddress),
    accounts,
    data: encodeInstructionData(schema, input.args ?? {}),
  };
}

function bytesEqual(left: readonly number[], right: ReadonlyUint8Array) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

class InstructionDataCursor {
  private offset = 8;
  private readonly view: DataView;

  constructor(private readonly data: ReadonlyUint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  private take(length: number) {
    if (length < 0 || this.offset + length > this.data.length) {
      throw new Error("Instruction data is truncated");
    }
    const start = this.offset;
    this.offset += length;
    return this.data.slice(start, this.offset);
  }

  u32() {
    if (this.offset + 4 > this.data.length) throw new Error("Instruction data is truncated");
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  u64() {
    if (this.offset + 8 > this.data.length) throw new Error("Instruction data is truncated");
    const value = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    return value;
  }

  string() {
    const length = this.u32();
    try {
      return utf8Decoder.decode(this.take(length));
    } catch {
      throw new Error("Instruction string is not valid UTF-8");
    }
  }

  bytes(length: number) {
    return this.take(length);
  }

  finish(instructionName: string) {
    if (this.offset !== this.data.length) throw new Error(`Invalid ${instructionName} data length`);
  }
}

function fixedInstructionSize(schema: InstructionSchema) {
  return schema.args.every((argument) => argument.type === "u64")
    ? 8 + schema.args.length * 8
    : null;
}

export function decodeOwnedInstruction(
  instruction: Instruction,
  expectation: Pick<OwnedInstructionInput, "program" | "instruction" | "accounts">,
): DecodedOwnedInstruction {
  const program = OWNED_SOLANA_PROGRAMS[expectation.program];
  if (instruction.programAddress !== program.programAddress) {
    throw new Error(`Unexpected program address: ${instruction.programAddress}`);
  }
  const schema = instructionSchema(expectation.program, expectation.instruction);
  const fixedSize = fixedInstructionSize(schema);
  if (
    !instruction.data ||
    instruction.data.length < 8 ||
    (fixedSize !== null && instruction.data.length !== fixedSize)
  ) {
    throw new Error(`Invalid ${expectation.instruction} data length`);
  }
  if (!bytesEqual(schema.discriminator, instruction.data.slice(0, 8))) {
    throw new Error(`Unexpected ${expectation.instruction} discriminator`);
  }
  if (!instruction.accounts || instruction.accounts.length !== schema.accounts.length) {
    throw new Error(`Invalid ${expectation.instruction} account count`);
  }

  const decodedAccounts: Record<string, Address> = {};
  schema.accounts.forEach((accountSchema, index) => {
    const account = instruction.accounts?.[index];
    if (!account || account.role !== accountSchema.role) {
      throw new Error(`Unexpected role for ${accountSchema.name}`);
    }
    const expectedAddress = accountSchema.address ?? expectation.accounts[accountSchema.name];
    if (!expectedAddress) throw new Error(`Missing expected ${accountSchema.name} account`);
    if (account.address !== expectedAddress) {
      throw new Error(`Unexpected address for ${accountSchema.name}`);
    }
    decodedAccounts[accountSchema.name] = account.address;
  });

  const decodedArgs: Record<string, OwnedInstructionArgumentValue> = {};
  const cursor = new InstructionDataCursor(instruction.data);
  for (const argument of schema.args) {
    if (argument.type === "u64") {
      decodedArgs[argument.name] = cursor.u64();
    } else if ("defined" in argument.type) {
      decodedArgs[argument.name] = checkedMetadata(argument.name, {
        name: cursor.string(),
        symbol: cursor.string(),
        uri: cursor.string(),
      });
    } else {
      decodedArgs[argument.name] = checkedBytes32(argument.name, cursor.bytes(32));
    }
  }
  cursor.finish(expectation.instruction);

  return {
    program: expectation.program,
    instruction: expectation.instruction,
    programAddress: instruction.programAddress,
    accounts: decodedAccounts,
    args: decodedArgs,
  };
}

export function assertOwnedInstructionSignable(
  instruction: Instruction,
  expectation: Pick<OwnedInstructionInput, "program" | "instruction" | "accounts">,
) {
  const decoded = decodeOwnedInstruction(instruction, expectation);
  return decoded;
}

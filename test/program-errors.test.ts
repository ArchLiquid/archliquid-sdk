import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createSolanaRpcFromTransport, type Base64EncodedWireTransaction, type RpcResponse } from "@solana/kit";
import { parseJsonWithBigInts } from "@solana/rpc-spec-types";
import {
  ARCH_CURVE_PROGRAM_ADDRESS, ARCH_LOCKER_PROGRAM_ADDRESS, ARCH_SWAP_PROGRAM_ADDRESS,
  SYSTEM_PROGRAM_ADDRESS,
} from "../src/addresses.js";
import {
  OWNED_PROGRAM_ERROR_DEFINITIONS, OwnedProgramError, decodeOwnedProgramError,
  type OwnedProgramErrorContext, type OwnedProgramErrorDecodeContext,
} from "../src/owned-program-errors.js";

type MockTransport = Parameters<typeof createSolanaRpcFromTransport>[0];
type MockTransportConfig = Parameters<MockTransport>[0];

test("decodes the actual bigint custom code and instruction index returned by Kit's lossless RPC pipeline", async () => {
  let requests = 0;
  const transport: MockTransport = async <TResponse>({ payload }: MockTransportConfig) => {
    requests++;
    const request = payload as { method: string; id: string };
    assert.equal(request.method, "simulateTransaction");
    // Numeric wire JSON, not a hand-written bigint result. This is the same
    // locked lossless codec used by Kit 7's default Solana HTTP transport.
    return parseJsonWithBigInts(JSON.stringify({
      jsonrpc: "2.0", id: request.id,
      result: { context: { slot: 123 }, value: {
        err: { InstructionError: [3, { Custom: 6000 }] }, logs: [], accounts: null,
        unitsConsumed: 0, returnData: null, replacementBlockhash: null,
      } },
    })) as RpcResponse<TResponse>;
  };
  const rpc = createSolanaRpcFromTransport(transport);
  // The fixture transport parses only its response; no transaction is submitted.
  const response = await rpc.simulateTransaction("AA==" as Base64EncodedWireTransaction, { encoding: "base64", sigVerify: false }).send();
  assert.equal(requests, 1);
  // Kit's declared TransactionError types say number; these assertions check
  // its actual runtime values before handing them to the SDK.
  const failure = response.value.err as unknown as { InstructionError: [bigint, { Custom: bigint }] };
  const [instructionIndex, instructionError] = failure.InstructionError;
  assert.equal(typeof instructionIndex, "bigint");
  assert.equal(typeof instructionError.Custom, "bigint");
  assert.equal(instructionIndex, 3n);
  assert.equal(instructionError.Custom, 6000n);
  const decoded = decodeOwnedProgramError(ARCH_CURVE_PROGRAM_ADDRESS, instructionError.Custom, {
    instructionIndex, cause: response.value.err,
  });
  assert.ok(decoded instanceof OwnedProgramError);
  assert.equal(decoded.errorName, "DefaultAddress");
  assert.equal(decoded.code, 6000);
  assert.equal(decoded.instructionIndex, 3);
  assert.equal(decoded.cause, response.value.err);
});

test("all 99 committed IDL errors decode identically for numeric and bigint inputs with qualified identities", async () => {
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
    for (const definition of idl.errors) {
      const cause = { program, code: definition.code };
      const numeric = decodeOwnedProgramError(program, definition.code, { cause, instructionIndex: 7 });
      const bigint = decodeOwnedProgramError(programAddress, BigInt(definition.code), { cause, instructionIndex: 7n });
      assert.ok(numeric instanceof OwnedProgramError);
      assert.ok(bigint instanceof OwnedProgramError);
      for (const decoded of [numeric, bigint]) {
        assert.equal(decoded.program, program);
        assert.equal(decoded.programAddress, programAddress);
        assert.equal(decoded.code, definition.code);
        assert.equal(decoded.errorName, definition.name);
        assert.equal(decoded.programMessage, definition.msg);
        assert.equal(decoded.instructionIndex, 7);
        assert.equal(decoded.cause, cause);
        assert.equal(typeof decoded.code, "number");
        assert.equal(typeof decoded.instructionIndex, "number");
      }
      assert.equal(bigint.message, numeric.message);
      checked++;
    }
  }
  assert.equal(checked, 99);
});

test("normalizes mixed numeric/bigint inputs and safe instruction-index boundaries without changing numeric outputs", () => {
  for (const code of [6000, 6000n]) {
    for (const instructionIndex of [0, 0n, 3, 3n, Number.MAX_SAFE_INTEGER, BigInt(Number.MAX_SAFE_INTEGER)]) {
      const decoded = decodeOwnedProgramError("archCurve", code, { instructionIndex });
      assert.ok(decoded instanceof OwnedProgramError);
      assert.equal(decoded.code, 6000);
      assert.equal(decoded.instructionIndex, Number(instructionIndex));
      assert.equal(typeof decoded.instructionIndex, "number");
    }
    const withoutIndex = decodeOwnedProgramError("archCurve", code);
    assert.ok(withoutIndex);
    assert.equal(withoutIndex.instructionIndex, undefined);
  }
});

test("rejects invalid custom-code and instruction-index values without invoking coercion hooks", () => {
  let coercions = 0;
  const coercible = {
    [Symbol.toPrimitive]() { coercions++; return 6000; },
    valueOf() { coercions++; return 6000; },
    toString() { coercions++; return "6000"; },
  };
  const invalidCodes: unknown[] = [
    -1, -1n, NaN, Infinity, -Infinity, 6000.5,
    0x1_0000_0000, 0x1_0000_0000n, 1n << 128n,
    "6000", true, null, undefined, new Number(6000), coercible,
  ];
  for (const code of invalidCodes) {
    assert.equal(decodeOwnedProgramError("archCurve", code as number | bigint), null);
  }
  // The u32 endpoints are valid numeric representations but have no IDL error.
  for (const code of [0, 0n, 0xffff_ffff, 0xffff_ffffn, 9999, 9999n]) {
    assert.equal(decodeOwnedProgramError("archCurve", code), null);
  }
  const invalidIndices: unknown[] = [
    -1, -1n, NaN, Infinity, 0.5,
    Number.MAX_SAFE_INTEGER + 1, BigInt(Number.MAX_SAFE_INTEGER) + 1n,
    "3", false, null, new Number(3), coercible,
  ];
  for (const instructionIndex of invalidIndices) {
    assert.equal(decodeOwnedProgramError("archCurve", 6000n, {
      instructionIndex: instructionIndex as number | bigint,
    }), null);
  }
  assert.equal(coercions, 0);
});

test("bigint normalization preserves program attribution instead of guessing from colliding codes", () => {
  const curve = decodeOwnedProgramError("archCurve", 6000n);
  const locker = decodeOwnedProgramError("archLocker", 6000n);
  assert.equal(curve?.errorName, "DefaultAddress");
  assert.equal(locker?.errorName, "ZeroAmount");
  assert.equal(curve?.programAddress, ARCH_CURVE_PROGRAM_ADDRESS);
  assert.equal(locker?.programAddress, ARCH_LOCKER_PROGRAM_ADDRESS);
  assert.equal(decodeOwnedProgramError("unknown", 6000n), null);
  assert.equal(decodeOwnedProgramError(SYSTEM_PROGRAM_ADDRESS, 6000n), null);
});

test("decoder input context is additive while constructors and decoded properties remain numeric", () => {
  const cause = new Error("Program-qualified failure");
  const constructorContext: OwnedProgramErrorContext = { instructionIndex: 4, cause };
  const decodeContext: OwnedProgramErrorDecodeContext = { instructionIndex: 4n, cause };
  const constructed = new OwnedProgramError("archCurve", OWNED_PROGRAM_ERROR_DEFINITIONS.archCurve[0]!, constructorContext);
  const decoded = decodeOwnedProgramError("archCurve", 6000n, decodeContext);
  assert.ok(decoded instanceof OwnedProgramError);
  const numericCode: number = decoded.code;
  const numericIndex: number | undefined = decoded.instructionIndex;
  assert.equal(numericCode, constructed.code);
  assert.equal(numericIndex, constructed.instructionIndex);
  assert.equal(decoded.cause, cause);
  if (false) {
    // @ts-expect-error Existing constructor context deliberately remains numeric.
    const invalidConstructorContext: OwnedProgramErrorContext = { instructionIndex: 4n };
    void invalidConstructorContext;
  }
});

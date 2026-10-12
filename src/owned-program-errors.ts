import { OWNED_IDL_METADATA } from "./owned-idl-metadata.js";
import { type Address } from "@solana/kit";

import {
  ARCH_CURVE_PROGRAM_ADDRESS,
  ARCH_LOCKER_PROGRAM_ADDRESS,
  ARCH_SWAP_PROGRAM_ADDRESS,
} from "./addresses.js";

/** Immutable program error records generated from the committed IDLs. */
export const OWNED_PROGRAM_ERROR_DEFINITIONS = Object.freeze({
  archCurve: OWNED_IDL_METADATA.archCurve.errors,
  archSwap: OWNED_IDL_METADATA.archSwap.errors,
  archLocker: OWNED_IDL_METADATA.archLocker.errors,
});

export type OwnedErrorProgramName = keyof typeof OWNED_PROGRAM_ERROR_DEFINITIONS;

const PROGRAM_ADDRESSES: Readonly<Record<OwnedErrorProgramName, Address>> = Object.freeze({
  archCurve: ARCH_CURVE_PROGRAM_ADDRESS,
  archSwap: ARCH_SWAP_PROGRAM_ADDRESS,
  archLocker: ARCH_LOCKER_PROGRAM_ADDRESS,
});

export type OwnedProgramErrorContext = Readonly<{
  cause?: unknown;
  instructionIndex?: number;
}>;

type ErrorDefinition = Readonly<{ code: number; name: string; msg: string }>;

/**
 * A program-qualified custom error. Numeric custom error codes are not unique
 * across programs; match both program and code when handling these errors.
 */
export class OwnedProgramError extends Error {
  readonly program: OwnedErrorProgramName;
  readonly programAddress: Address;
  readonly code: number;
  readonly errorName: string;
  readonly programMessage: string;
  readonly instructionIndex: number | undefined;

  constructor(
    program: OwnedErrorProgramName,
    definition: ErrorDefinition,
    context: OwnedProgramErrorContext = {},
  ) {
    super(`${program}.${definition.name}: ${definition.msg}`, { cause: context.cause });
    this.name = "OwnedProgramError";
    this.program = program;
    this.programAddress = PROGRAM_ADDRESSES[program];
    this.code = definition.code;
    this.errorName = definition.name;
    this.programMessage = definition.msg;
    this.instructionIndex = context.instructionIndex;
  }
}

/**
 * Decode a custom error using the confirmed failing program name or address.
 * Returns null for unknown identities, invalid codes or unrecognized errors.
 * A top-level instruction's program may differ from a failed CPI's program;
 * confirm the failing identity before interpreting its numeric error code.
 */
export function decodeOwnedProgramError(
  program: OwnedErrorProgramName | string,
  code: number,
  context: OwnedProgramErrorContext = {},
): OwnedProgramError | null {
  if (!Number.isSafeInteger(code) || code < 0 || code > 0xffff_ffff) return null;
  if (context.instructionIndex !== undefined &&
      (!Number.isSafeInteger(context.instructionIndex) || context.instructionIndex < 0)) return null;
  const name = (Object.keys(PROGRAM_ADDRESSES) as OwnedErrorProgramName[]).find(
    (candidate) => candidate === program || PROGRAM_ADDRESSES[candidate] === program,
  );
  if (!name) return null;
  const definition = OWNED_PROGRAM_ERROR_DEFINITIONS[name].find((candidate) => candidate.code === code);
  return definition ? new OwnedProgramError(name, definition, context) : null;
}

import {
  getAddressDecoder,
  getBase64Encoder,
  type Address,
  type ReadonlyUint8Array,
} from "@solana/kit";

import {
  ARCH_CURVE_PROGRAM_ADDRESS,
  ARCH_SWAP_PROGRAM_ADDRESS,
  SOL_QUOTE_MINT_ADDRESS,
  USDC_QUOTE_MINT_ADDRESS,
} from "./addresses.js";
import type { OwnedProgramName } from "./owned-program-instructions.js";

const MAX_LOG_MESSAGES = 1_000;
const MAX_EVENT_BYTES = 512;
const MAX_EVENTS_PER_TRANSACTION = 100;
const MAX_TOTAL_FEE_BPS = 1_000;

export const OWNED_EVENT_DISCRIMINATORS = {
  CurveCreated: [207, 148, 202, 45, 236, 100, 171, 230],
  CurveFeesClaimed: [134, 227, 212, 155, 241, 169, 9, 62],
  CurveMigrated: [73, 99, 54, 46, 71, 35, 47, 242],
  CurveTrade: [84, 229, 77, 39, 245, 87, 49, 105],
  CanonicalPoolInitialized: [90, 203, 56, 77, 28, 155, 147, 19],
  LiquidityDeposited: [218, 155, 74, 193, 59, 66, 94, 122],
  LiquidityWithdrawn: [240, 120, 73, 139, 154, 31, 218, 68],
  PoolFeesClaimed: [172, 6, 248, 216, 198, 124, 73, 110],
  PoolTrade: [190, 27, 154, 233, 45, 9, 73, 222],
} as const;

export type OwnedTradeSide = "buy" | "sell";
export type OwnedFeeKind = "creator" | "protocol";

type EventEnvelope<TProgram extends OwnedProgramName, TKind extends string> = Readonly<{
  program: TProgram;
  kind: TKind;
  eventIndex: number;
}>;

export type CurveCreatedEvent = EventEnvelope<"archCurve", "CurveCreated"> & Readonly<{
  curve: Address;
  launchConfig: Address;
  creator: Address;
  baseMint: Address;
  quoteMint: Address;
  baseVault: Address;
  quoteVault: Address;
  tokenTotalSupply: bigint;
  metadataCommitment: ReadonlyUint8Array;
  createdSlot: bigint;
}>;

export type CurveTradeEvent = EventEnvelope<"archCurve", "CurveTrade"> & Readonly<{
  curve: Address;
  trader: Address;
  side: OwnedTradeSide;
  baseAmount: bigint;
  grossQuoteAmount: bigint;
  userQuoteAmount: bigint;
  creatorFee: bigint;
  protocolFee: bigint;
  complete: boolean;
}>;

export type CurveFeesClaimedEvent = EventEnvelope<"archCurve", "CurveFeesClaimed"> & Readonly<{
  curve: Address;
  recipient: Address;
  feeKind: OwnedFeeKind;
  quoteMint: Address;
  amount: bigint;
}>;

export type CurveMigratedEvent = EventEnvelope<"archCurve", "CurveMigrated"> & Readonly<{
  curve: Address;
  pool: Address;
  baseMint: Address;
  quoteMint: Address;
  baseAmount: bigint;
  quoteAmount: bigint;
}>;

export type CanonicalPoolInitializedEvent = EventEnvelope<"archSwap", "CanonicalPoolInitialized"> & Readonly<{
  pool: Address;
  curveAuthority: Address;
  creator: Address;
  baseMint: Address;
  quoteMint: Address;
  lpMint: Address;
  baseAmount: bigint;
  quoteAmount: bigint;
  permanentlyLockedShares: bigint;
  fees: Readonly<{ reinvestFeeBps: number; protocolFeeBps: number; creatorFeeBps: number }>;
}>;

export type LiquidityDepositedEvent = EventEnvelope<"archSwap", "LiquidityDeposited"> & Readonly<{
  pool: Address;
  provider: Address;
  lpMint: Address;
  lpSharesOut: bigint;
  baseAmountIn: bigint;
  quoteAmountIn: bigint;
  totalEconomicShares: bigint;
}>;

export type LiquidityWithdrawnEvent = EventEnvelope<"archSwap", "LiquidityWithdrawn"> & Readonly<{
  pool: Address;
  provider: Address;
  lpMint: Address;
  lpSharesIn: bigint;
  baseAmountOut: bigint;
  quoteAmountOut: bigint;
  totalEconomicShares: bigint;
}>;

export type PoolTradeEvent = EventEnvelope<"archSwap", "PoolTrade"> & Readonly<{
  pool: Address;
  trader: Address;
  side: OwnedTradeSide;
  baseAmount: bigint;
  grossQuoteAmount: bigint;
  userQuoteAmount: bigint;
  reinvestFee: bigint;
  creatorFee: bigint;
  protocolFee: bigint;
}>;

export type PoolFeesClaimedEvent = EventEnvelope<"archSwap", "PoolFeesClaimed"> & Readonly<{
  pool: Address;
  recipient: Address;
  feeKind: OwnedFeeKind;
  quoteMint: Address;
  amount: bigint;
}>;

export type OwnedProgramEvent =
  | CurveCreatedEvent
  | CurveTradeEvent
  | CurveFeesClaimedEvent
  | CurveMigratedEvent
  | CanonicalPoolInitializedEvent
  | LiquidityDepositedEvent
  | LiquidityWithdrawnEvent
  | PoolTradeEvent
  | PoolFeesClaimedEvent;

const addressDecoder = getAddressDecoder();
const base64Encoder = getBase64Encoder();

class EventCursor {
  private offset = 8;
  private readonly view: DataView;

  constructor(private readonly data: ReadonlyUint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  private take(length: number) {
    if (this.offset + length > this.data.length) throw new Error("Owned event data is truncated");
    const value = this.data.slice(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  address() {
    return addressDecoder.decode(this.take(32));
  }

  u8() {
    return this.take(1)[0];
  }

  u16() {
    if (this.offset + 2 > this.data.length) throw new Error("Owned event data is truncated");
    const value = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return value;
  }

  u64() {
    if (this.offset + 8 > this.data.length) throw new Error("Owned event data is truncated");
    const value = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    return value;
  }

  bytes(length: number) {
    return this.take(length);
  }

  finish() {
    if (this.offset !== this.data.length) {
      throw new Error(`Owned event has ${this.data.length - this.offset} trailing bytes`);
    }
  }
}

function discriminatorIs(data: ReadonlyUint8Array, expected: readonly number[]) {
  return expected.every((value, index) => data[index] === value);
}

function side(cursor: EventCursor): OwnedTradeSide {
  const value = cursor.u8();
  if (value === 0) return "buy";
  if (value === 1) return "sell";
  throw new Error("Owned event trade side is invalid");
}

function feeKind(cursor: EventCursor): OwnedFeeKind {
  const value = cursor.u8();
  if (value === 0) return "creator";
  if (value === 1) return "protocol";
  throw new Error("Owned event fee kind is invalid");
}

function bool(cursor: EventCursor) {
  const value = cursor.u8();
  if (value !== 0 && value !== 1) throw new Error("Owned event bool is not canonical");
  return value === 1;
}

function assertCanonicalQuote(quoteMint: Address) {
  if (quoteMint !== SOL_QUOTE_MINT_ADDRESS && quoteMint !== USDC_QUOTE_MINT_ADDRESS) {
    throw new Error("Owned event quote mint is not canonical");
  }
}

function assertPositive(fieldName: string, value: bigint) {
  if (value === 0n) throw new Error(`${fieldName} must be nonzero`);
}

function assertTradeEconomics(
  sideValue: OwnedTradeSide,
  gross: bigint,
  user: bigint,
  fees: readonly bigint[],
) {
  const totalFees = fees.reduce((sum, value) => sum + value, 0n);
  if (sideValue === "buy") {
    if (gross !== user || totalFees >= gross) throw new Error("Owned buy event economics are invalid");
  } else if (gross !== user + totalFees) {
    throw new Error("Owned sell event economics are invalid");
  }
}

function decodeCurveEvent(data: ReadonlyUint8Array, eventIndex: number): OwnedProgramEvent | null {
  const cursor = new EventCursor(data);
  if (discriminatorIs(data, OWNED_EVENT_DISCRIMINATORS.CurveCreated)) {
    const event = {
      program: "archCurve",
      kind: "CurveCreated",
      eventIndex,
      curve: cursor.address(),
      launchConfig: cursor.address(),
      creator: cursor.address(),
      baseMint: cursor.address(),
      quoteMint: cursor.address(),
      baseVault: cursor.address(),
      quoteVault: cursor.address(),
      tokenTotalSupply: cursor.u64(),
      metadataCommitment: cursor.bytes(32),
      createdSlot: cursor.u64(),
    } as const;
    cursor.finish();
    assertCanonicalQuote(event.quoteMint);
    assertPositive("CurveCreated.tokenTotalSupply", event.tokenTotalSupply);
    if (event.metadataCommitment.every((value) => value === 0)) {
      throw new Error("CurveCreated metadata commitment is empty");
    }
    return Object.freeze(event);
  }
  if (discriminatorIs(data, OWNED_EVENT_DISCRIMINATORS.CurveTrade)) {
    const curve = cursor.address();
    const trader = cursor.address();
    const tradeSide = side(cursor);
    const baseAmount = cursor.u64();
    const grossQuoteAmount = cursor.u64();
    const userQuoteAmount = cursor.u64();
    const creatorFee = cursor.u64();
    const protocolFee = cursor.u64();
    const complete = bool(cursor);
    cursor.finish();
    assertPositive("CurveTrade.baseAmount", baseAmount);
    assertPositive("CurveTrade.grossQuoteAmount", grossQuoteAmount);
    assertTradeEconomics(tradeSide, grossQuoteAmount, userQuoteAmount, [creatorFee, protocolFee]);
    return Object.freeze({ program: "archCurve", kind: "CurveTrade", eventIndex, curve, trader, side: tradeSide, baseAmount, grossQuoteAmount, userQuoteAmount, creatorFee, protocolFee, complete });
  }
  if (discriminatorIs(data, OWNED_EVENT_DISCRIMINATORS.CurveFeesClaimed)) {
    const event = { program: "archCurve", kind: "CurveFeesClaimed", eventIndex, curve: cursor.address(), recipient: cursor.address(), feeKind: feeKind(cursor), quoteMint: cursor.address(), amount: cursor.u64() } as const;
    cursor.finish();
    assertCanonicalQuote(event.quoteMint);
    assertPositive("CurveFeesClaimed.amount", event.amount);
    return Object.freeze(event);
  }
  if (discriminatorIs(data, OWNED_EVENT_DISCRIMINATORS.CurveMigrated)) {
    const event = { program: "archCurve", kind: "CurveMigrated", eventIndex, curve: cursor.address(), pool: cursor.address(), baseMint: cursor.address(), quoteMint: cursor.address(), baseAmount: cursor.u64(), quoteAmount: cursor.u64() } as const;
    cursor.finish();
    assertCanonicalQuote(event.quoteMint);
    assertPositive("CurveMigrated.baseAmount", event.baseAmount);
    assertPositive("CurveMigrated.quoteAmount", event.quoteAmount);
    return Object.freeze(event);
  }
  return null;
}

function decodeSwapEvent(data: ReadonlyUint8Array, eventIndex: number): OwnedProgramEvent | null {
  const cursor = new EventCursor(data);
  if (discriminatorIs(data, OWNED_EVENT_DISCRIMINATORS.CanonicalPoolInitialized)) {
    const event = { program: "archSwap", kind: "CanonicalPoolInitialized", eventIndex, pool: cursor.address(), curveAuthority: cursor.address(), creator: cursor.address(), baseMint: cursor.address(), quoteMint: cursor.address(), lpMint: cursor.address(), baseAmount: cursor.u64(), quoteAmount: cursor.u64(), permanentlyLockedShares: cursor.u64(), fees: { reinvestFeeBps: cursor.u16(), protocolFeeBps: cursor.u16(), creatorFeeBps: cursor.u16() } } as const;
    cursor.finish();
    assertCanonicalQuote(event.quoteMint);
    assertPositive("CanonicalPoolInitialized.baseAmount", event.baseAmount);
    assertPositive("CanonicalPoolInitialized.quoteAmount", event.quoteAmount);
    assertPositive("CanonicalPoolInitialized.permanentlyLockedShares", event.permanentlyLockedShares);
    if (event.fees.reinvestFeeBps + event.fees.protocolFeeBps + event.fees.creatorFeeBps > MAX_TOTAL_FEE_BPS) {
      throw new Error("CanonicalPoolInitialized fees are invalid");
    }
    return Object.freeze(event);
  }
  if (discriminatorIs(data, OWNED_EVENT_DISCRIMINATORS.LiquidityDeposited)) {
    const event = { program: "archSwap", kind: "LiquidityDeposited", eventIndex, pool: cursor.address(), provider: cursor.address(), lpMint: cursor.address(), lpSharesOut: cursor.u64(), baseAmountIn: cursor.u64(), quoteAmountIn: cursor.u64(), totalEconomicShares: cursor.u64() } as const;
    cursor.finish();
    assertPositive("LiquidityDeposited.lpSharesOut", event.lpSharesOut);
    assertPositive("LiquidityDeposited.baseAmountIn", event.baseAmountIn);
    assertPositive("LiquidityDeposited.quoteAmountIn", event.quoteAmountIn);
    assertPositive("LiquidityDeposited.totalEconomicShares", event.totalEconomicShares);
    return Object.freeze(event);
  }
  if (discriminatorIs(data, OWNED_EVENT_DISCRIMINATORS.LiquidityWithdrawn)) {
    const event = { program: "archSwap", kind: "LiquidityWithdrawn", eventIndex, pool: cursor.address(), provider: cursor.address(), lpMint: cursor.address(), lpSharesIn: cursor.u64(), baseAmountOut: cursor.u64(), quoteAmountOut: cursor.u64(), totalEconomicShares: cursor.u64() } as const;
    cursor.finish();
    assertPositive("LiquidityWithdrawn.lpSharesIn", event.lpSharesIn);
    assertPositive("LiquidityWithdrawn.baseAmountOut", event.baseAmountOut);
    assertPositive("LiquidityWithdrawn.quoteAmountOut", event.quoteAmountOut);
    assertPositive("LiquidityWithdrawn.totalEconomicShares", event.totalEconomicShares);
    return Object.freeze(event);
  }
  if (discriminatorIs(data, OWNED_EVENT_DISCRIMINATORS.PoolTrade)) {
    const pool = cursor.address();
    const trader = cursor.address();
    const tradeSide = side(cursor);
    const baseAmount = cursor.u64();
    const grossQuoteAmount = cursor.u64();
    const userQuoteAmount = cursor.u64();
    const reinvestFee = cursor.u64();
    const creatorFee = cursor.u64();
    const protocolFee = cursor.u64();
    cursor.finish();
    assertPositive("PoolTrade.baseAmount", baseAmount);
    assertPositive("PoolTrade.grossQuoteAmount", grossQuoteAmount);
    assertTradeEconomics(tradeSide, grossQuoteAmount, userQuoteAmount, [reinvestFee, creatorFee, protocolFee]);
    return Object.freeze({ program: "archSwap", kind: "PoolTrade", eventIndex, pool, trader, side: tradeSide, baseAmount, grossQuoteAmount, userQuoteAmount, reinvestFee, creatorFee, protocolFee });
  }
  if (discriminatorIs(data, OWNED_EVENT_DISCRIMINATORS.PoolFeesClaimed)) {
    const event = { program: "archSwap", kind: "PoolFeesClaimed", eventIndex, pool: cursor.address(), recipient: cursor.address(), feeKind: feeKind(cursor), quoteMint: cursor.address(), amount: cursor.u64() } as const;
    cursor.finish();
    assertCanonicalQuote(event.quoteMint);
    assertPositive("PoolFeesClaimed.amount", event.amount);
    return Object.freeze(event);
  }
  return null;
}

function programName(value: string): OwnedProgramName | null {
  if (value === ARCH_CURVE_PROGRAM_ADDRESS) return "archCurve";
  if (value === ARCH_SWAP_PROGRAM_ADDRESS) return "archSwap";
  return null;
}

export function decodeOwnedProgramEvents(logMessages: readonly string[]): readonly OwnedProgramEvent[] {
  if (logMessages.length > MAX_LOG_MESSAGES) throw new Error("Transaction log count exceeds the owned-event cap");
  const invocationStack: string[] = [];
  const events: OwnedProgramEvent[] = [];
  for (const message of logMessages) {
    const invoke = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke \[(\d+)]$/.exec(message);
    if (invoke) {
      const depth = Number(invoke[2]);
      if (!Number.isSafeInteger(depth) || depth < 1 || depth > 64) throw new Error("Program log invocation depth is invalid");
      if (depth !== invocationStack.length + 1) {
        throw new Error("Program log invocation stack is inconsistent");
      }
      const invokedProgram = invoke[1];
      if (!invokedProgram) throw new Error("Program log invocation is invalid");
      invocationStack.push(invokedProgram);
      continue;
    }
    const exit = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) (success|failed: .+)$/.exec(message);
    if (exit) {
      if (invocationStack.at(-1) !== exit[1]) {
        throw new Error("Program log exit stack is inconsistent");
      }
      invocationStack.pop();
      continue;
    }
    if (!message.startsWith("Program data: ")) continue;
    const activeProgram = programName(invocationStack.at(-1) ?? "");
    if (!activeProgram) continue;
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(base64Encoder.encode(message.slice("Program data: ".length)));
    } catch {
      throw new Error("Owned program event data is not canonical base64");
    }
    if (bytes.length < 8 || bytes.length > MAX_EVENT_BYTES) throw new Error("Owned program event size is invalid");
    const decoded = activeProgram === "archCurve"
      ? decodeCurveEvent(bytes, events.length)
      : decodeSwapEvent(bytes, events.length);
    if (!decoded) continue;
    events.push(decoded);
    if (events.length > MAX_EVENTS_PER_TRANSACTION) throw new Error("Transaction exceeds the owned-event cap");
  }
  if (invocationStack.length !== 0) throw new Error("Program log invocation stack is incomplete");
  return Object.freeze(events);
}

export function assertCanonicalMigrationEventPair(events: readonly OwnedProgramEvent[]) {
  for (const migrated of events.filter((event): event is CurveMigratedEvent => event.kind === "CurveMigrated")) {
    const initialized = events.find((event): event is CanonicalPoolInitializedEvent =>
      event.kind === "CanonicalPoolInitialized" &&
      event.pool === migrated.pool &&
      event.curveAuthority === migrated.curve,
    );
    if (!initialized || initialized.eventIndex > migrated.eventIndex) {
      throw new Error("CurveMigrated lacks its preceding canonical pool event");
    }
    if (
      initialized.baseMint !== migrated.baseMint ||
      initialized.quoteMint !== migrated.quoteMint ||
      initialized.baseAmount !== migrated.baseAmount ||
      initialized.quoteAmount !== migrated.quoteAmount
    ) {
      throw new Error("Migration event pair is inconsistent");
    }
  }
}

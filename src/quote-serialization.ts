import {
  assertOwnedMarketQuoteValidEnvelope,
  type OwnedMarketQuote,
  type OwnedPoolLiquidityQuote,
} from "./owned-market-quotes.js";
import { OwnedSdkError } from "./errors.js";

type SerializableOwnedQuote = OwnedMarketQuote<unknown> | OwnedPoolLiquidityQuote<unknown>;
const MAX_SERIALIZED_QUOTE_BYTES = 65_536;
const MAX_U64 = (1n << 64n) - 1n;
const MAX_DEPTH = 64;
const MAX_VALUES = 4_096;
const utf8 = new TextEncoder();

type Budget = { values: number; stringBytes: number };

function boundedString(value: string, budget: Budget): void {
  // Bound before allocating UTF-8 bytes. Escaping overhead is checked on the
  // final JSON document; total raw string content is bounded during traversal.
  if (value.length > MAX_SERIALIZED_QUOTE_BYTES) throw new Error("Quote string exceeds serialization limit");
  budget.stringBytes += utf8.encode(value).length;
  if (budget.stringBytes > MAX_SERIALIZED_QUOTE_BYTES) throw new Error("Quote strings exceed serialization limit");
}

function plainData(value: unknown, revive: boolean, budget: Budget, depth = 0): unknown {
  budget.values += 1;
  if (depth > MAX_DEPTH || budget.values > MAX_VALUES) throw new Error("Quote structure exceeds serialization limit");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") { boundedString(value, budget); return value; }
  if (typeof value === "bigint") {
    if (value < 0n || value > MAX_U64) throw new Error("Quote bigint exceeds u64");
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new Error("Quote contains a non-roundtrippable number");
    return value;
  }
  if (typeof value !== "object") throw new Error("Quote contains an unsupported JSON value");
  const prototype = Object.getPrototypeOf(value);
  const array = Array.isArray(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
    throw new Error("Quote contains a non-plain object");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) throw new Error("Quote contains symbol-keyed data");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Object.keys(descriptors);
  if (Object.hasOwn(descriptors, "$bigint")) {
    if (!revive) throw new Error("Quote result uses the reserved $bigint key");
    const tagged = descriptors.$bigint;
    if (array || names.length !== 1 || !tagged || !("value" in tagged) ||
        typeof tagged.value !== "string" || !/^(0|[1-9]\d{0,19})$/.test(tagged.value)) {
      throw new Error("Invalid bigint encoding");
    }
    const integer = BigInt(tagged.value);
    if (integer > MAX_U64) throw new Error("Quote bigint exceeds u64");
    return integer;
  }
  if (array) {
    if (names.length !== value.length + 1) throw new Error("Quote contains a sparse or decorated array");
    const result: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new Error("Quote contains an accessor or non-enumerable array entry");
      }
      result.push(plainData(descriptor.value, revive, budget, depth + 1));
    }
    return result;
  }
  const result: Record<string, unknown> = {};
  for (const name of names) {
    boundedString(name, budget);
    const descriptor = descriptors[name]!;
    if (!("value" in descriptor) || !descriptor.enumerable) {
      throw new Error("Quote contains accessor or non-enumerable data");
    }
    // Define rather than assign so a JSON __proto__ key remains ordinary data.
    Object.defineProperty(result, name, {
      value: plainData(descriptor.value, revive, budget, depth + 1),
      enumerable: true, writable: true, configurable: true,
    });
  }
  return result;
}

function freezePlainData(value: unknown): void {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) freezePlainData(nested);
    Object.freeze(value);
  }
}

/** Versioned bigint encoding. Serialization does not authenticate RPC state or quote economics. */
export function serializeOwnedQuote(quote: SerializableOwnedQuote): string {
  try {
    const safeQuote = plainData(quote, false, { values: 0, stringBytes: 0 }) as SerializableOwnedQuote;
    assertOwnedMarketQuoteValidEnvelope(safeQuote);
    const serialized = JSON.stringify({ version: 1, quote: safeQuote }, (_key, value: unknown) =>
      typeof value === "bigint" ? { $bigint: value.toString() } : value);
    if (utf8.encode(serialized).length > MAX_SERIALIZED_QUOTE_BYTES) throw new Error("Quote exceeds serialization limit");
    return serialized;
  } catch (cause) {
    throw new OwnedSdkError("invalid_serialization", "Quote could not be serialized", { cause });
  }
}

/** Revive bigint fields and validate the envelope; recompute economics before authorizing an instruction. */
export function deserializeOwnedQuote(serialized: string): SerializableOwnedQuote {
  if (typeof serialized !== "string" || serialized.length > MAX_SERIALIZED_QUOTE_BYTES ||
      utf8.encode(serialized).length > MAX_SERIALIZED_QUOTE_BYTES) {
    throw new OwnedSdkError("invalid_serialization", "Serialized quote exceeds the input limit");
  }
  try {
    // Parse without a recursive reviver; the bounded traversal handles tags.
    const parsed = plainData(JSON.parse(serialized) as unknown, true, { values: 0, stringBytes: 0 });
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid quote document");
    const document = parsed as Record<string, unknown>;
    if (document.version !== 1 || Object.keys(document).sort().join("|") !== "quote|version") {
      throw new Error("Unsupported quote serialization version or document fields");
    }
    const quote = document.quote as SerializableOwnedQuote;
    assertOwnedMarketQuoteValidEnvelope(quote);
    freezePlainData(quote);
    return quote;
  } catch (cause) {
    throw new OwnedSdkError("invalid_serialization", "Serialized quote is invalid", { cause });
  }
}

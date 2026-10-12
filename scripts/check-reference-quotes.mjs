import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ARCHLIQUID_DEVNET_DEPLOYMENT, OWNED_IDL_SHA256 } from "../src/deployment.ts";
import * as math from "../src/owned-quote-math.ts";

const MAX_U64 = (1n << 64n) - 1n;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_CASES = 4096;
const MAX_DEPTH = 12;
const MAX_VALUES = 150_000;
const HASH = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const ERROR_CODES = new Set([
  "zero_amount", "invalid_reserves", "invalid_fee", "insufficient_base_liquidity",
  "insufficient_quote_liquidity", "slippage_exceeded", "zero_output",
  "invalid_share_state", "share_limit_exceeded", "locked_share_violation", "overflow",
]);
const curve = { virtualBase: "u64", virtualQuote: "u64", realSaleBase: "u64", realQuote: "u64" };
const pool = { base: "u64", quote: "u64" };
const operations = Object.freeze({
  calculateCurveBuyExactBaseOut: ["archCurve", [curve, "u64", "u64", "u16", "u16"]],
  calculateCurveBuyExactQuoteIn: ["archCurve", [curve, "u64", "u64", "u16", "u16"]],
  calculateCurveSellExactBaseIn: ["archCurve", [curve, "u64", "u64", "u16", "u16"]],
  calculateAmmBuyExactBaseOut: ["archSwap", [pool, "u64", "u64", "u16", "u16", "u16"]],
  calculateAmmBuyExactQuoteIn: ["archSwap", [pool, "u64", "u64", "u16", "u16", "u16"]],
  calculateAmmSellExactBaseIn: ["archSwap", [pool, "u64", "u64", "u16", "u16", "u16"]],
  calculateAmmDepositExactShares: ["archSwap", [pool, "u64", "u64", "u64", "u64"]],
  calculateAmmWithdrawExactShares: ["archSwap", [pool, "u64", "u64", "u64", "u64", "u64"]],
  calculateInitialLiquidityShares: ["archSwap", [pool]],
});

function object(value, label) {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value;
}

function exactKeys(value, keys, label) {
  object(value, label);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} fields`);
}

function text(value, label, max = 256) {
  assert.ok(typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value, `${label} must be a bounded nonempty string`);
  assert.ok(!/[\x00-\x1f\x7f]/.test(value), `${label} contains control characters`);
  return value;
}

function digest(value, label) {
  assert.ok(typeof value === "string" && HASH.test(value) && value !== "0".repeat(64), `${label} must be a nonzero lowercase SHA-256`);
  return value;
}

function relativePath(value, label) {
  text(value, label, 512);
  assert.ok(!value.includes("\\") && !value.startsWith("/") && !value.includes(":") && value.split("/").every((part) => part !== "" && part !== "." && part !== ".."), `${label} must be a repository-relative POSIX path`);
  return value;
}

function u64(value, label) {
  exactKeys(value, ["$u64"], label);
  assert.ok(typeof value.$u64 === "string" && /^(?:0|[1-9][0-9]{0,19})$/.test(value.$u64), `${label} must contain a canonical unsigned decimal $u64 string`);
  const result = BigInt(value.$u64);
  assert.ok(result <= MAX_U64, `${label} exceeds u64`);
  return result;
}

function argument(value, schema, label) {
  if (schema === "u64") return u64(value, label);
  if (schema === "u16") {
    assert.ok(Number.isInteger(value) && value >= 0 && value <= 0xffff && !Object.is(value, -0), `${label} must be a u16 fee in basis points`);
    return value;
  }
  exactKeys(value, Object.keys(schema), label);
  return Object.fromEntries(Object.entries(schema).map(([name, type]) => [name, argument(value[name], type, `${label}.${name}`)]));
}

function checkedResult(value, label) {
  object(value, label);
  if (Object.hasOwn(value, "$u64")) {
    u64(value, label);
    return;
  }
  assert.ok(Object.keys(value).length > 0, `${label} cannot be empty`);
  for (const [key, entry] of Object.entries(value)) {
    text(key, `${label} field`, 80);
    checkedResult(entry, `${label}.${key}`);
  }
}

function encodeResult(value) {
  if (typeof value === "bigint") return { $u64: value.toString() };
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, encodeResult(entry)]));
}

function checkBounds(value) {
  const queue = [[value, 0]];
  let values = 0;
  while (queue.length > 0) {
    const [entry, depth] = queue.pop();
    assert.ok(++values <= MAX_VALUES, "Reference fixture contains too many values");
    assert.ok(depth <= MAX_DEPTH, "Reference fixture nesting is too deep");
    if (entry !== null && typeof entry === "object") {
      for (const [key, child] of Object.entries(entry)) {
        assert.ok(key !== "__proto__" && key !== "constructor" && key !== "prototype", "Reserved reference fixture field");
        assert.ok(key.length <= 512, "Reference fixture field is too long");
        queue.push([child, depth + 1]);
      }
    } else if (typeof entry === "number") {
      assert.ok(Number.isFinite(entry) && !Object.is(entry, -0), "Reference fixture contains an invalid number");
    } else if (typeof entry === "string") {
      assert.ok(entry.length <= 4096, "Reference fixture string is too long");
    }
  }
}

function checkProvenance(reference) {
  exactKeys(reference, ["kind", "repository", "commit", "sourceFiles", "generator", "execution", "cluster", "genesisHash", "programs"], "reference");
  assert.equal(reference.kind, "independent-rust-program", "Reference kind must identify independently executed Rust program code");
  const repository = new URL(text(reference.repository, "reference.repository", 512));
  assert.ok(repository.protocol === "https:" && repository.hostname !== "localhost" && !repository.username && !repository.password && !repository.search && !repository.hash, "Reference repository must be a clean HTTPS URL");
  assert.ok(typeof reference.commit === "string" && COMMIT.test(reference.commit) && reference.commit !== "0".repeat(40), "Reference commit must be a pinned nonzero Git SHA-1");
  assert.ok(Array.isArray(reference.sourceFiles) && reference.sourceFiles.length > 0 && reference.sourceFiles.length <= 64, "Reference must identify 1..64 hashed source/build input files");
  const paths = new Map();
  for (const entry of reference.sourceFiles) {
    exactKeys(entry, ["path", "sha256"], "source file");
    relativePath(entry.path, "source file path");
    digest(entry.sha256, "source file SHA-256");
    assert.ok(!paths.has(entry.path), "Duplicate source file path");
    paths.set(entry.path, entry.sha256);
  }
  exactKeys(reference.generator, ["path", "sha256", "command"], "reference.generator");
  relativePath(reference.generator.path, "generator path");
  digest(reference.generator.sha256, "generator SHA-256");
  assert.equal(paths.get(reference.generator.path), reference.generator.sha256, "Generator must be one of the hashed source/build inputs");
  text(reference.generator.command, "generator command", 1024);
  assert.ok(["rust-unit", "local-program", "deployed-program"].includes(reference.execution), "Unknown reference execution mode");
  assert.equal(reference.cluster, ARCHLIQUID_DEVNET_DEPLOYMENT.cluster, "Reference cluster does not match SDK deployment");
  assert.equal(reference.genesisHash, ARCHLIQUID_DEVNET_DEPLOYMENT.genesisHash, "Reference genesis hash does not match SDK deployment");
  exactKeys(reference.programs, ["archCurve", "archSwap"], "reference.programs");
  for (const program of ["archCurve", "archSwap"]) {
    const deployment = reference.programs[program];
    exactKeys(deployment, ["programId", "idlSha256", "executableSha256"], `${program} reference deployment`);
    assert.equal(deployment.programId, ARCHLIQUID_DEVNET_DEPLOYMENT.programs[program], `${program} reference program ID`);
    assert.equal(deployment.idlSha256, OWNED_IDL_SHA256[program], `${program} reference IDL hash`);
    digest(deployment.executableSha256, `${program} reference executable SHA-256`);
  }
}

/** Validate supplied provenance claims and compare exact outputs. Independent
 * execution and source-to-deployment binding require prior reviewer verification. */
export function checkReferenceQuotes(fixture) {
  checkBounds(fixture);
  exactKeys(fixture, ["schemaVersion", "reference", "cases"], "fixture");
  assert.equal(fixture.schemaVersion, 1, "Unsupported reference fixture schema version");
  checkProvenance(fixture.reference);
  assert.ok(Array.isArray(fixture.cases) && fixture.cases.length > 0 && fixture.cases.length <= MAX_CASES, `Reference must contain 1..${MAX_CASES} cases`);
  const ids = new Set();
  const coverage = new Map(Object.keys(operations).map((operation) => [operation, { success: 0, failure: 0 }]));
  const cases = fixture.cases.map((entry, index) => {
    const label = `case ${index}`;
    exactKeys(entry, ["id", "operation", "arguments", "expected"], label);
    text(entry.id, `${label} ID`, 128);
    assert.ok(!ids.has(entry.id), `Duplicate case ID ${entry.id}`);
    ids.add(entry.id);
    assert.ok(Object.hasOwn(operations, entry.operation), `${entry.id}: unknown operation`);
    const [, schemas] = operations[entry.operation];
    assert.ok(Array.isArray(entry.arguments) && entry.arguments.length === schemas.length, `${entry.id}: argument count`);
    const args = schemas.map((schema, argumentIndex) => argument(entry.arguments[argumentIndex], schema, `${entry.id}.arguments[${argumentIndex}]`));
    object(entry.expected, `${entry.id}.expected`);
    if (Object.hasOwn(entry.expected, "result")) {
      exactKeys(entry.expected, ["result"], `${entry.id}.expected`);
      checkedResult(entry.expected.result, `${entry.id}.expected.result`);
      coverage.get(entry.operation).success += 1;
    } else {
      exactKeys(entry.expected, ["error"], `${entry.id}.expected`);
      exactKeys(entry.expected.error, ["sdkCode", "referenceCode"], `${entry.id}.expected.error`);
      assert.ok(ERROR_CODES.has(entry.expected.error.sdkCode), `${entry.id}: unknown SDK math error code`);
      text(entry.expected.error.referenceCode, `${entry.id}: original Rust/program error code`, 128);
      coverage.get(entry.operation).failure += 1;
    }
    return { entry, args };
  });
  for (const [operation, counts] of coverage) {
    assert.ok(counts.success > 0 && counts.failure > 0, `${operation} requires successful and rejected reference cases`);
  }
  for (const { entry, args } of cases) {
    let result;
    let error;
    try { result = math[entry.operation](...args); } catch (caught) { error = caught; }
    if (Object.hasOwn(entry.expected, "error")) {
      assert.ok(error instanceof math.OwnedQuoteMathError, `${entry.id}: expected a checked SDK math error`);
      assert.equal(error.code, entry.expected.error.sdkCode, `${entry.id}: SDK error differs from reviewed mapping for ${entry.expected.error.referenceCode}`);
    } else {
      assert.ok(error === undefined, `${entry.id}: SDK unexpectedly failed with ${error?.code ?? error?.name}`);
      assert.deepEqual(encodeResult(result), entry.expected.result, `${entry.id}: SDK output differs from pinned reference`);
    }
  }
  return { caseCount: cases.length, operationCount: coverage.size, sourceCommit: fixture.reference.commit };
}

async function main(args) {
  assert.equal(args.length, 4, "Usage: npm run check:reference -- --fixture <JSON file> --sha256 <independently reviewed exact-file SHA-256>. Missing independent fixtures is a pending release gate.");
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    assert.ok(["--fixture", "--sha256"].includes(args[index]) && !options.has(args[index]), "Unknown or duplicate reference-check option");
    options.set(args[index], args[index + 1]);
  }
  const expectedHash = digest(options.get("--sha256"), "Externally reviewed fixture SHA-256");
  const file = await open(resolve(text(options.get("--fixture"), "Fixture path", 4096)), "r");
  let bytes;
  try {
    const size = (await file.stat()).size;
    assert.ok(size > 0 && size <= MAX_BYTES, `Reference fixture must be 1..${MAX_BYTES} bytes`);
    const buffer = Buffer.alloc(size + 1);
    let count = 0;
    while (count < buffer.length) {
      const read = await file.read(buffer, count, buffer.length - count, null);
      if (read.bytesRead === 0) break;
      count += read.bytesRead;
    }
    assert.ok(count <= size && count > 0, "Reference fixture changed size while reading");
    bytes = buffer.subarray(0, count);
  } finally { await file.close(); }
  assert.equal(createHash("sha256").update(bytes).digest("hex"), expectedHash, "Reference fixture does not match its externally reviewed SHA-256");
  const fixture = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  const result = checkReferenceQuotes(fixture);
  console.log(`SDK matched ${result.caseCount} pinned reference cases across ${result.operationCount} math operations.`);
  console.log(`Fixture SHA-256: ${expectedHash}; claimed source commit: ${result.sourceCommit}.`);
  console.log("Independent execution, error mappings and source-to-deployment binding remain review requirements; fixture metadata alone does not prove them.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`Reference quote check failed: ${error.message}`);
    process.exitCode = 1;
  });
}

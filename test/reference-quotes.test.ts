import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ARCHLIQUID_DEVNET_DEPLOYMENT, OWNED_IDL_SHA256 } from "../src/deployment.js";

// These deliberately synthetic fixtures test the checker itself. The reserved
// example.invalid URL, fake hashes and hand-calculated tiny outputs are not Rust
// reference evidence and must never be published as independent parity fixtures.
const checkerUrl: string = new URL("../scripts/check-reference-quotes.mjs", import.meta.url).href;
const { checkReferenceQuotes } = await import(checkerUrl) as {
  checkReferenceQuotes: (fixture: unknown) => { caseCount: number; operationCount: number; sourceCommit: string };
};
const u64 = (value: number | string) => ({ $u64: String(value) });
const reserve = { base: u64(100), quote: u64(100) };
const curveReserve = { virtualBase: u64(100), virtualQuote: u64(100), realSaleBase: u64(100), realQuote: u64(100) };
const curveFees = { total: u64(0), creator: u64(0), protocol: u64(0) };
const ammFees = { ...curveFees, reinvest: u64(0) };
const nextCurve = (base: number, quote: number) => ({ virtualBase: u64(base), virtualQuote: u64(quote), realSaleBase: u64(base), realQuote: u64(quote) });
const nextPool = (base: number, quote: number) => ({ base: u64(base), quote: u64(quote) });

type HarnessFixture = {
  schemaVersion: number;
  reference: {
    kind: string; repository: string; commit: string;
    sourceFiles: Array<{ path: string; sha256: string }>;
    generator: { path: string; sha256: string; command: string };
    execution: string; cluster: string; genesisHash: string;
    programs: Record<"archCurve" | "archSwap", { programId: string; idlSha256: string; executableSha256: string }>;
  };
  cases: Array<{
    id: string; operation: string; arguments: unknown[];
    expected: { result?: unknown; error?: { sdkCode: string; referenceCode: string } };
  }>;
};

function syntheticFixture(): HarnessFixture {
  const deployment = (program: "archCurve" | "archSwap") => ({
    programId: ARCHLIQUID_DEVNET_DEPLOYMENT.programs[program],
    idlSha256: OWNED_IDL_SHA256[program], executableSha256: "3".repeat(64),
  });
  const cases = [
    {
      id: "synthetic-curve-buy-base", operation: "calculateCurveBuyExactBaseOut",
      arguments: [curveReserve, u64(10), u64(100), 0, 0],
      expected: { result: { baseAmountOut: u64(10), grossQuoteAmountIn: u64(12), netQuoteAmountIn: u64(12), fees: curveFees, nextReserves: nextCurve(90, 112) } },
    },
    {
      id: "synthetic-curve-buy-quote", operation: "calculateCurveBuyExactQuoteIn",
      arguments: [curveReserve, u64(10), u64(0), 0, 0],
      expected: { result: { baseAmountOut: u64(9), grossQuoteAmountIn: u64(10), netQuoteAmountIn: u64(10), fees: curveFees, nextReserves: nextCurve(91, 110) } },
    },
    {
      id: "synthetic-curve-sell", operation: "calculateCurveSellExactBaseIn",
      arguments: [curveReserve, u64(10), u64(0), 0, 0],
      expected: { result: { baseAmountIn: u64(10), grossQuoteAmountOut: u64(9), userQuoteAmountOut: u64(9), fees: curveFees, nextReserves: nextCurve(110, 91) } },
    },
    {
      id: "synthetic-amm-buy-base", operation: "calculateAmmBuyExactBaseOut",
      arguments: [reserve, u64(10), u64(100), 0, 0, 0],
      expected: { result: { baseAmountOut: u64(10), grossQuoteAmountIn: u64(12), pricingQuoteAmountIn: u64(12), fees: ammFees, nextReserves: nextPool(90, 112) } },
    },
    {
      id: "synthetic-amm-buy-quote", operation: "calculateAmmBuyExactQuoteIn",
      arguments: [reserve, u64(10), u64(0), 0, 0, 0],
      expected: { result: { baseAmountOut: u64(9), grossQuoteAmountIn: u64(10), pricingQuoteAmountIn: u64(10), fees: ammFees, nextReserves: nextPool(91, 110) } },
    },
    {
      id: "synthetic-amm-sell", operation: "calculateAmmSellExactBaseIn",
      arguments: [reserve, u64(10), u64(0), 0, 0, 0],
      expected: { result: { baseAmountIn: u64(10), grossQuoteAmountOut: u64(9), userQuoteAmountOut: u64(9), fees: ammFees, nextReserves: nextPool(110, 91) } },
    },
    {
      id: "synthetic-deposit", operation: "calculateAmmDepositExactShares",
      arguments: [reserve, u64(100), u64(10), u64(100), u64(100)],
      expected: { result: { lpSharesOut: u64(10), baseAmountIn: u64(10), quoteAmountIn: u64(10), nextReserves: nextPool(110, 110), nextTotalEconomicShares: u64(110) } },
    },
    {
      id: "synthetic-withdraw", operation: "calculateAmmWithdrawExactShares",
      arguments: [reserve, u64(100), u64(1), u64(10), u64(0), u64(0)],
      expected: { result: { lpSharesIn: u64(10), baseAmountOut: u64(10), quoteAmountOut: u64(10), nextReserves: nextPool(90, 90), nextTotalEconomicShares: u64(90) } },
    },
    {
      id: "synthetic-initial-shares", operation: "calculateInitialLiquidityShares",
      arguments: [reserve], expected: { result: u64(100) },
    },
  ];
  const rejected = cases.map((entry) => {
    const argumentsCopy = structuredClone(entry.arguments);
    const initial = entry.operation === "calculateInitialLiquidityShares";
    if (initial) (argumentsCopy[0] as typeof reserve).base = u64(0);
    else argumentsCopy[entry.operation === "calculateAmmDepositExactShares" ? 2 : entry.operation === "calculateAmmWithdrawExactShares" ? 3 : 1] = u64(0);
    return {
      id: `${entry.id}-rejected`, operation: entry.operation, arguments: argumentsCopy,
      expected: { error: { sdkCode: initial ? "invalid_reserves" : "zero_amount", referenceCode: "SYNTHETIC-CHECKER-ONLY" } },
    };
  });
  return structuredClone({
    schemaVersion: 1,
    reference: {
      kind: "independent-rust-program", repository: "https://example.invalid/synthetic-harness-only",
      commit: "1".repeat(40), sourceFiles: [{ path: "test/synthetic.rs", sha256: "2".repeat(64) }],
      generator: { path: "test/synthetic.rs", sha256: "2".repeat(64), command: "SYNTHETIC HARNESS TEST ONLY - NO RUST EXECUTION" },
      execution: "rust-unit", cluster: "devnet", genesisHash: ARCHLIQUID_DEVNET_DEPLOYMENT.genesisHash,
      programs: { archCurve: deployment("archCurve"), archSwap: deployment("archSwap") },
    },
    cases: [...cases, ...rejected],
  });
}

test("reference checker compares all 9 operations and rejected outcomes using explicitly synthetic harness cases", () => {
  assert.deepEqual(checkReferenceQuotes(syntheticFixture()), { caseCount: 18, operationCount: 9, sourceCommit: "1".repeat(40) });
});

test("reference checker fails for output differences, extra output fields and wrong error mapping", () => {
  const output = syntheticFixture();
  (output.cases[0]!.expected.result as { grossQuoteAmountIn: { $u64: string } }).grossQuoteAmountIn = u64(13);
  assert.throws(() => checkReferenceQuotes(output), /SDK output differs/);
  const extra = syntheticFixture();
  Object.assign(extra.cases[0]!.expected.result!, { unsupported: u64(0) });
  assert.throws(() => checkReferenceQuotes(extra), /SDK output differs/);
  const failure = syntheticFixture();
  failure.cases[9]!.expected.error!.sdkCode = "invalid_fee";
  assert.throws(() => checkReferenceQuotes(failure), /SDK error differs/);
});

test("reference checker requires source/generator and current deployment identities", () => {
  const mutations: Array<(fixture: ReturnType<typeof syntheticFixture>) => void> = [
    (fixture) => { fixture.reference.kind = "sdk-generated"; },
    (fixture) => { fixture.reference.commit = "main"; },
    (fixture) => { fixture.reference.sourceFiles = []; },
    (fixture) => { fixture.reference.sourceFiles[0]!.path = "../outside.rs"; },
    (fixture) => { fixture.reference.generator.sha256 = "4".repeat(64); },
    (fixture) => { fixture.reference.repository = "https://user:password@example.invalid/repository"; },
    (fixture) => { fixture.reference.genesisHash = "wrong-cluster"; },
    (fixture) => { fixture.reference.programs.archCurve.programId = "wrong-program"; },
    (fixture) => { fixture.reference.programs.archSwap.idlSha256 = "4".repeat(64); },
    (fixture) => { fixture.reference.programs.archCurve.executableSha256 = "0".repeat(64); },
  ];
  for (const mutate of mutations) {
    const fixture = syntheticFixture();
    mutate(fixture);
    assert.throws(() => checkReferenceQuotes(fixture));
  }
});

test("reference checker rejects incomplete operation coverage, unknown operations and duplicate IDs", () => {
  const incomplete = syntheticFixture();
  incomplete.cases.pop();
  assert.throws(() => checkReferenceQuotes(incomplete), /requires successful and rejected/);
  const unknown = syntheticFixture();
  unknown.cases[0]!.operation = "toString";
  assert.throws(() => checkReferenceQuotes(unknown), /unknown operation/);
  const duplicate = syntheticFixture();
  duplicate.cases[1]!.id = duplicate.cases[0]!.id;
  assert.throws(() => checkReferenceQuotes(duplicate), /Duplicate case ID/);
});

test("reference checker enforces exact u64 tags, argument fields, fee widths and schema caps", () => {
  for (const malformed of ["01", "-1", "1.0", "18446744073709551616"]) {
    const fixture = syntheticFixture();
    fixture.cases[0]!.arguments[1] = u64(malformed);
    assert.throws(() => checkReferenceQuotes(fixture));
  }
  const argumentField = syntheticFixture();
  Object.assign(argumentField.cases[0]!.arguments[0]!, { extra: u64(1) });
  assert.throws(() => checkReferenceQuotes(argumentField), /fields/);
  const fee = syntheticFixture();
  fee.cases[0]!.arguments[3] = 65_536;
  assert.throws(() => checkReferenceQuotes(fee), /u16 fee/);
  const large = syntheticFixture();
  large.cases = Array.from({ length: 4097 }, () => ({} as HarnessFixture["cases"][number]));
  assert.throws(() => checkReferenceQuotes(large), /1\.\.4096/);
  assert.throws(() => checkReferenceQuotes({ values: Array.from({ length: 150_001 }, () => 0) }), /too many values/);
  const reserved = JSON.parse('{"__proto__": {"polluted": true}}') as unknown;
  assert.throws(() => checkReferenceQuotes(reserved), /Reserved reference fixture/);
});

test("reference command requires independent fixture arguments and verifies exact file bytes before comparison", async () => {
  const directory = await mkdtemp(join(tmpdir(), "archliquid-reference-harness-test-"));
  const path = join(directory, "synthetic-harness-only.json");
  const content = JSON.stringify(syntheticFixture());
  await writeFile(path, content);
  const sha256 = createHash("sha256").update(content).digest("hex");
  const script = fileURLToPath(new URL("../scripts/check-reference-quotes.mjs", import.meta.url));
  const run = (args: string[]) => spawnSync(process.execPath, ["--import", "tsx", script, ...args], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8", windowsHide: true,
  });
  const missing = run([]);
  assert.equal(missing.status, 1, missing.error?.message ?? "Missing fixture must fail");
  assert.match(missing.stderr, /Missing independent fixtures is a pending release gate/);
  const mismatch = run(["--fixture", path, "--sha256", "5".repeat(64)]);
  assert.equal(mismatch.status, 1, mismatch.error?.message ?? "Mismatched fixture must fail");
  assert.match(mismatch.stderr, /externally reviewed SHA-256/);
  const matched = run(["--fixture", path, "--sha256", sha256]);
  assert.equal(matched.status, 0, matched.stderr || matched.error?.message || "Synthetic checker fixture should match");
  assert.match(matched.stdout, /18 pinned reference cases across 9 math operations/);
  assert.match(matched.stdout, /fixture metadata alone does not prove them/);
});

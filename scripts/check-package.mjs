import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const options = new Set(process.argv.slice(2));
assert.ok([...options].every((option) => ["--skip-check", "--verify-artifacts"].includes(option)), "Unknown check:package option");

async function verifyArtifacts(directory) {
  const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  for (const [name, entry] of Object.entries(manifest.exports)) {
    for (const target of typeof entry === "string" ? [entry] : Object.values(entry)) {
      assert.ok(target.startsWith("./"), `${name} must export a local file`);
      assert.ok((await stat(join(directory, target))).isFile(), `${name} export ${target} is missing`);
    }
  }
  const outputs = (await readdir(join(directory, "dist"))).filter((file) => file.endsWith(".js"));
  assert.ok(outputs.length > 0, "The package has no built runtime files");
  for (const file of outputs) {
    const runtime = await readFile(join(directory, "dist", file), "utf8");
    assert.ok(runtime.includes(`//# sourceMappingURL=${file}.map`), `${file} has no source map reference`);
    const map = JSON.parse(await readFile(join(directory, "dist", `${file}.map`), "utf8"));
    assert.equal(map.version, 3);
    assert.ok(map.sources.length > 0);
    assert.equal(map.sourcesContent?.length, map.sources.length, `${file} does not embed its original TypeScript`);
    assert.ok(map.sourcesContent.every((source) => typeof source === "string" && source.length > 0));
    await stat(join(directory, "dist", file.replace(/\.js$/, ".d.ts")));
  }
  for (const file of ["README.md", "SECURITY.md", "CHANGELOG.md", "docs/integration.md"]) await stat(join(directory, file));
  return outputs.length;
}

if (options.has("--verify-artifacts")) {
  console.log(`Verified package exports, documentation and ${await verifyArtifacts(root)} embedded source maps.`);
} else {
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli, "Run this script through npm run check:package so the npm executable is explicit");
  // Preserve runtime CA/heap settings when launching npm's JS entrypoint.
  // NODE_OPTIONS is also inherited normally. Do not inherit loaders/debuggers,
  // which could resolve relative to the isolated consumer or change npm behavior.
  const nodeArgs = process.execArgv.filter((argument) => /^--(?:use-(?:system|openssl|bundled)-ca|max-old-space-size=\d+)$/.test(argument));
  const npm = async (args, cwd) => {
    try {
      return await execute(process.execPath, [...nodeArgs, npmCli, ...args], { cwd, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
    } catch (error) {
      process.stderr.write(error.stdout ?? "");
      process.stderr.write(error.stderr ?? "");
      throw error;
    }
  };
  if (!options.has("--skip-check")) {
    console.log("Checking source before creating the package fixture.");
    await npm(["run", "check"], root);
  }
  const temporary = await mkdtemp(join(tmpdir(), "archliquid-sdk-package-"));
  console.log(`Package fixture and consumer artifacts: ${temporary}`);
  const fixture = join(temporary, "source-fixture");
  const consumer = join(temporary, "consumer");
  await mkdir(fixture);
  await mkdir(consumer);
  for (const file of ["package.json", "tsconfig.json", "tsconfig.build.json", "src", "idl", "scripts", "docs", "examples", "README.md", "SECURITY.md", "CHANGELOG.md", "LICENSE"]) {
    await cp(join(root, file), join(fixture, file), { recursive: true, errorOnExist: true });
  }
  // The fixture has no Git metadata or dist; dependencies are reused only to
  // exercise prepack. Builds write into the fixture, never into node_modules.
  await symlink(join(root, "node_modules"), join(fixture, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const { stdout: packed } = await npm(["pack", "--json", "--pack-destination", temporary], fixture);
  const jsonStart = packed.lastIndexOf("\n[");
  const packResults = JSON.parse(jsonStart === -1 ? packed : packed.slice(jsonStart + 1));
  assert.equal(packResults.length, 1);
  const tarball = join(temporary, packResults[0].filename);
  const packedFiles = new Set(packResults[0].files.map((file) => file.path));
  assert.ok(packedFiles.has("dist/index.js"), "prepack did not build the fresh fixture");
  assert.ok(packedFiles.has("docs/integration.md"), "integration documentation is absent from the tarball");
  assert.ok(![...packedFiles].some((file) => file.startsWith("src/") || file.startsWith("node_modules/") || file === "AGENTS.md"), "The tarball contains workspace-only files");
  await writeFile(join(consumer, "package.json"), JSON.stringify({ name: "archliquid-sdk-package-consumer", private: true, type: "module" }, null, 2));
  console.log("Installing the actual local tarball in an isolated consumer.");
  await npm(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-online", tarball], consumer);
  const installed = join(consumer, "node_modules", "@archliquid", "sdk");
  const sourceMaps = await verifyArtifacts(installed);
  await writeFile(join(consumer, "runtime.mjs"), `
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import * as sdk from "@archliquid/sdk";
import * as math from "@archliquid/sdk/math";
import * as accounts from "@archliquid/sdk/accounts";
import * as instructions from "@archliquid/sdk/instructions";
for (const name of ["createOwnedAccountReader", "loadCurveSnapshot", "loadPoolSnapshot", "loadLaunchSnapshot", "createOwnedMarketTradePlan", "createOwnedPoolLiquidityPlan", "createOwnedCurvePlan", "assertOwnedTransactionPlanSignable", "assertOwnedInstructionMatchesIntent", "serializeOwnedQuote", "deserializeOwnedQuote", "decodeOwnedTransactionEvents"]) assert.equal(typeof sdk[name], "function", name);
assert.equal(math.calculateInitialLiquidityShares({ base: 100n, quote: 100n }), 100n);
assert.equal(typeof accounts.decodePoolAccount, "function");
assert.equal(typeof instructions.buildTypedOwnedInstruction, "function");
assert.equal(sdk.parseOwnedAmount("1.25", 6), 1250000n);
for (const [name, program] of [["arch-curve", "archCurve"], ["arch-swap", "archSwap"], ["arch-locker", "archLocker"]]) {
  const { default: idl } = await import("@archliquid/sdk/idl/" + name, { with: { type: "json" } });
  assert.equal(idl.address, sdk.ARCHLIQUID_DEVNET_DEPLOYMENT.programs[program]);
  const bytes = await readFile(new URL(import.meta.resolve("@archliquid/sdk/idl/" + name)));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), sdk.OWNED_IDL_SHA256[program]);
}
console.log("Runtime, subpath and JSON IDL imports passed.");
`);
  const runtimePath = join(consumer, "runtime.mjs");
  const runtime = await execute(process.execPath, [runtimePath], { cwd: consumer, windowsHide: true });
  process.stdout.write(runtime.stdout);
  await writeFile(join(consumer, "consumer.ts"), `
import { createOwnedAccountReader, loadPoolSnapshot, createOwnedMarketTradePlan, serializeOwnedQuote, type OwnedMarketQuote } from "@archliquid/sdk";
import { calculateInitialLiquidityShares } from "@archliquid/sdk/math";
import { decodePoolAccount, type DecodedPool } from "@archliquid/sdk/accounts";
import { buildTypedOwnedInstruction, type OwnedInstructionInputFor } from "@archliquid/sdk/instructions";
import curveIdl from "@archliquid/sdk/idl/arch-curve" with { type: "json" };
import swapIdl from "@archliquid/sdk/idl/arch-swap" with { type: "json" };
import lockerIdl from "@archliquid/sdk/idl/arch-locker" with { type: "json" };
void [createOwnedAccountReader, loadPoolSnapshot, createOwnedMarketTradePlan, serializeOwnedQuote, calculateInitialLiquidityShares, decodePoolAccount, buildTypedOwnedInstruction, curveIdl.address, swapIdl.address, lockerIdl.address];
export type PublicTypes = OwnedMarketQuote<unknown> | DecodedPool | OwnedInstructionInputFor<"archSwap", "deposit_liquidity">;
`);
  const compiler = join(root, "node_modules", "typescript", "bin", "tsc");
  for (const [module, moduleResolution] of [["NodeNext", "NodeNext"], ["ESNext", "Bundler"]]) {
    const configuration = join(consumer, `tsconfig.${moduleResolution}.json`);
    await writeFile(configuration, JSON.stringify({ compilerOptions: { target: "ES2022", module, moduleResolution, strict: true, skipLibCheck: true, noEmit: true, resolveJsonModule: true, types: [] }, include: ["consumer.ts"] }, null, 2));
    await execute(process.execPath, [compiler, "-p", configuration], { cwd: consumer, windowsHide: true });
  }
  const { build } = await import(pathToFileURL(join(root, "node_modules", "esbuild", "lib", "main.js")).href);
  const bundle = async (contents, name) => {
    const result = await build({ stdin: { contents, resolveDir: consumer, sourcefile: `${name}.ts`, loader: "ts" }, bundle: true, platform: "browser", format: "esm", target: "es2022", minify: true, write: false, metafile: true });
    assert.equal(result.outputFiles.length, 1);
    await writeFile(join(consumer, `${name}.browser.js`), result.outputFiles[0].contents);
    return result.outputFiles[0].contents.length;
  };
  await bundle('export { createOwnedAccountReader, loadPoolSnapshot, createOwnedMarketTradePlan, serializeOwnedQuote } from "@archliquid/sdk";', "integration");
  const rootBytes = await bundle('export { calculateInitialLiquidityShares } from "@archliquid/sdk";', "root-math");
  const mathBytes = await bundle('export { calculateInitialLiquidityShares } from "@archliquid/sdk/math";', "subpath-math");
  console.log(`Installed ${sourceMaps} runtime modules with embedded source maps; NodeNext/Bundler and browser bundles passed without polyfills. Math import sizes: root ${rootBytes} bytes; subpath ${mathBytes} bytes (observational).`);
  console.log(`Retained package/consumer artifacts: ${temporary}`);
}

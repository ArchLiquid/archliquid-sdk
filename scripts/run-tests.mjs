import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = join(root, "test");
const files = (await readdir(directory, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
  .map((entry) => entry.name)
  .sort()
  .map((name) => join(directory, name));
assert.ok(files.length > 0, "No SDK test files were found");

// Windows shells and Node 20 do not expand test globs. Give Node explicit paths,
// while retaining caller reporter/name-filter options and bounded concurrency.
const nodeArgs = process.execArgv.filter((argument) => /^--(?:use-(?:system|openssl|bundled)-ca|max-old-space-size=\d+)$/.test(argument));
const child = spawn(process.execPath, [
  ...nodeArgs, "--import", "tsx", "--test", "--test-concurrency=1",
  ...process.argv.slice(2), ...files,
], { cwd: root, stdio: "inherit", windowsHide: true });
child.once("error", (error) => {
  console.error("Could not start the SDK test runner:", error);
  process.exitCode = 1;
});
child.once("exit", (code) => { process.exitCode = code ?? 1; });

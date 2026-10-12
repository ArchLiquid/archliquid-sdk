import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { AccountRole } from "@solana/kit";
import { ARCHLIQUID_DEVNET_DEPLOYMENT, OWNED_IDL_SHA256 } from "../src/deployment.ts";
import { OWNED_ACCOUNT_LAYOUTS } from "../src/owned-program-accounts.ts";
import { OWNED_EVENT_DISCRIMINATORS } from "../src/owned-program-events.ts";
import { OWNED_SOLANA_PROGRAMS } from "../src/owned-program-instructions.ts";
import { OWNED_PROGRAM_ERROR_DEFINITIONS } from "../src/owned-program-errors.ts";
import { LOCK_ACCOUNT_SIZE } from "../src/locker.ts";

execFileSync(process.execPath, [fileURLToPath(new URL("./generate-idl-metadata.mjs", import.meta.url)), "--check"], { stdio: "inherit", windowsHide: true });
assert.ok(process.argv.slice(2).every((arg) => arg === "--require-lf"), "Unknown verify:idl option");
const identities = { archCurve: "arch_curve", archSwap: "arch_swap", archLocker: "arch_locker" };
const permitted = {
  archCurve: ["create_curve", "buy_exact_base_out", "buy_exact_quote_in", "sell_exact_base_in", "claim_creator_fees", "claim_protocol_fees", "migrate_curve"],
  archSwap: ["buy_exact_base_out", "buy_exact_quote_in", "sell_exact_base_in", "deposit_liquidity", "withdraw_liquidity", "claim_creator_fees", "claim_protocol_fees"],
};
const accountNames = { Curve: "curve", LaunchConfig: "launchConfig", ProtocolConfig: "protocolConfig", Pool: "pool", SwapConfig: "swapConfig" };
const events = {};
let instructionCount = 0;
let accountCount = 0;
let errorCount = 0;
const lockerSource = await readFile(new URL("../src/locker.ts", import.meta.url), "utf8");

function fixedSize(type, definitions) {
  const primitive = { u8: 1, i8: 1, bool: 1, u16: 2, i16: 2, u32: 4, i32: 4, u64: 8, i64: 8, u128: 16, i128: 16, pubkey: 32 };
  if (typeof type === "string") {
    assert.ok(Object.hasOwn(primitive, type), `Unsupported fixed-layout type ${type}`);
    return primitive[type];
  }
  if (type.array) return fixedSize(type.array[0], definitions) * type.array[1];
  if (type.defined) {
    const name = typeof type.defined === "string" ? type.defined : type.defined.name;
    const definition = definitions.find((candidate) => candidate.name === name)?.type;
    assert.ok(definition, `Missing type ${name}`);
    if (definition.kind === "struct") return definition.fields.reduce((size, field) => size + fixedSize(field.type, definitions), 0);
    if (definition.kind === "enum") {
      const sizes = definition.variants.map((variant) => (variant.fields ?? []).reduce((size, field) => size + fixedSize(field.type ?? field, definitions), 0));
      assert.ok(sizes.every((size) => size === sizes[0]), `Variable-size enum ${name}`);
      return 1 + (sizes[0] ?? 0);
    }
  }
  throw new Error(`Unsupported fixed-layout definition ${JSON.stringify(type)}`);
}

function lockerConstant(name) {
  const literal = new RegExp(`const ${name} = (\\[[^\\]]+\\]) as const;`).exec(lockerSource)?.[1];
  assert.ok(literal, `Missing locker discriminator ${name}`);
  return JSON.parse(literal);
}

for (const [program, file] of Object.entries(identities)) {
  const source = await readFile(new URL(`../idl/${file}.json`, import.meta.url), "utf8");
  const governed = source.replace(/\r\n/g, "\n");
  assert.equal(source, governed, `${file}.json must use LF; convert only line endings and preserve its content`);
  assert.equal(createHash("sha256").update(source).digest("hex"), OWNED_IDL_SHA256[program], `${program} exact IDL hash`);
  const idl = JSON.parse(governed);
  assert.equal(idl.address, ARCHLIQUID_DEVNET_DEPLOYMENT.programs[program]);
  assert.deepEqual(OWNED_PROGRAM_ERROR_DEFINITIONS[program], idl.errors, `${program} error table`);
  errorCount += idl.errors.length;
  if (program !== "archLocker") for (const entry of idl.events ?? []) events[entry.name] = entry.discriminator;
  const descriptor = OWNED_SOLANA_PROGRAMS[program];
  if (descriptor) {
    assert.equal(descriptor.programAddress, idl.address);
    assert.equal(descriptor.idlSha256, OWNED_IDL_SHA256[program]);
    assert.deepEqual(Object.keys(descriptor.instructions).sort(), [...permitted[program]].sort(), "Public instruction boundary changed");
    for (const [name, schema] of Object.entries(descriptor.instructions)) {
      const instruction = idl.instructions.find((candidate) => candidate.name === name);
      assert.ok(instruction, `${program}.${name} is missing from the IDL`);
      assert.deepEqual(schema.discriminator, instruction.discriminator, `${program}.${name} discriminator`);
      assert.deepEqual(schema.args, instruction.args, `${program}.${name} arguments`);
      assert.deepEqual(schema.accounts.map(({ name: accountName, role }) => ({ name: accountName, role })), instruction.accounts.map(({ name: accountName, writable, signer }) => ({
        name: accountName, role: signer ? writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER : writable ? AccountRole.WRITABLE : AccountRole.READONLY,
      })), `${program}.${name} accounts`);
      instruction.accounts.forEach((account, index) => {
        if (account.address) assert.equal(schema.accounts[index].address, account.address, `${program}.${name}.${account.name} fixed address`);
      });
      instructionCount += 1;
    }
  }
  for (const account of idl.accounts) {
    const size = 8 + fixedSize({ defined: { name: account.name } }, idl.types);
    if (program === "archLocker") {
      assert.equal(size, LOCK_ACCOUNT_SIZE);
      assert.deepEqual(account.discriminator, lockerConstant("LOCK_DISCRIMINATOR"));
    } else {
      const layout = OWNED_ACCOUNT_LAYOUTS[accountNames[account.name]];
      assert.ok(layout, `Missing layout ${program}.${account.name}`);
      assert.equal(layout.size, size, `${program}.${account.name} size`);
      assert.deepEqual(layout.discriminator, account.discriminator);
    }
    accountCount += 1;
  }
  if (program === "archLocker") {
    for (const [name, constant] of Object.entries({ create_lock: "CREATE_LOCK_DISCRIMINATOR", extend_lock: "EXTEND_LOCK_DISCRIMINATOR", make_permanent: "MAKE_PERMANENT_DISCRIMINATOR", release_lock: "RELEASE_LOCK_DISCRIMINATOR" })) {
      const instruction = idl.instructions.find((candidate) => candidate.name === name);
      assert.ok(instruction, `Missing locker instruction ${name}`);
      assert.deepEqual(lockerConstant(constant), instruction.discriminator);
    }
  }
}
assert.deepEqual(OWNED_EVENT_DISCRIMINATORS, events, "Public event discriminators");
console.log(`Verified 3 IDL hashes/identities, ${instructionCount} public schemas, ${accountCount} account layouts, ${Object.keys(events).length} events and ${errorCount} program errors.`);

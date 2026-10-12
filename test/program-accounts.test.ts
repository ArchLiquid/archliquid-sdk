import assert from "node:assert/strict";
import test from "node:test";
import {
  ARCH_CURVE_PROGRAM_ADDRESS,
  ARCH_SWAP_PROGRAM_ADDRESS,
  SOL_QUOTE_MINT_ADDRESS,
  USDC_QUOTE_MINT_ADDRESS,
  ZERO_ADDRESS,
} from "../src/addresses.js";
import {
  assertLaunchConfigActive,
  assertProtocolSwapRelationship,
  decodeCurveAccount,
  decodeLaunchConfigAccount,
  decodePoolAccount,
  decodeProtocolConfigAccount,
  decodeSwapConfigAccount,
  deriveCurveCreatorClaimAccountMap,
  deriveCurveMigrationAccountMap,
  deriveCurveProtocolClaimAccountMap,
  deriveCurveTradeAccountMap,
  derivePoolCreatorClaimAccountMap,
  derivePoolLiquidityAccountMap,
  derivePoolProtocolClaimAccountMap,
  derivePoolTradeAccountMap,
} from "../src/owned-program-accounts.js";
import { deriveAssociatedTokenAddress } from "../src/owned-program-pdas.js";
import { CREATOR, TREASURY, makeProgramFixtures, mutate, offsetView, type AccountFixture } from "./helpers/fixtures.js";

async function decoded(quoteKind: "sol" | "usdc" = "sol") {
  const fixtures = await makeProgramFixtures(quoteKind);
  const [protocol, launch, swap] = await Promise.all([
    decodeProtocolConfigAccount(fixtures.protocol),
    decodeLaunchConfigAccount(fixtures.launch),
    decodeSwapConfigAccount(fixtures.swap),
  ]);
  const [curve, pool] = await Promise.all([
    decodeCurveAccount(fixtures.curve, launch), decodePoolAccount(fixtures.pool, swap),
  ]);
  return { fixtures, protocol, launch, swap, curve, pool };
}

for (const quoteKind of ["sol", "usdc"] as const) {
  test(`decodes all five v1 program accounts with ${quoteKind.toUpperCase()} quote fixtures`, async () => {
    const value = await decoded(quoteKind);
    assert.equal(value.protocol.admin, CREATOR);
    assert.equal(value.protocol.treasury, TREASURY);
    assert.equal(value.protocol.pendingAdmin, ZERO_ADDRESS);
    assert.equal(value.protocol.launchesEnabled, true);
    assert.equal(value.launch.configVersion, 7);
    assert.equal(value.launch.quoteKind, quoteKind);
    assert.equal(value.launch.parameters.tokenTotalSupply, 1_000_000n);
    assert.equal(value.launch.parameters.curveTotalFeeBps, 100);
    assert.equal(value.curve.launchNonce, 91n);
    assert.equal(value.curve.realSaleBaseReserves, 750_000n);
    assert.equal(value.curve.creatorQuoteFees, 30n);
    assert.equal(value.curve.createdUnixTimestamp, 1_700_000_000n);
    assert.equal(value.pool.totalEconomicShares, 100_000n);
    assert.equal(value.pool.permanentlyLockedShares, 10_000n);
    assert.deepEqual(value.pool.fees, { reinvestFeeBps: 20, protocolFeeBps: 30, creatorFeeBps: 10 });
    assert.doesNotThrow(() => assertProtocolSwapRelationship(value.protocol, value.swap));
    assert.doesNotThrow(() => assertLaunchConfigActive(value.protocol, value.launch));
  });
}

test("all program decoders reject incorrect owner, exact size, discriminator, PDA/bump, schema and reserved bytes", async () => {
  const { fixtures, launch, swap } = await decoded();
  const cases = [
    { fixture: fixtures.protocol, schema: "version", decode: decodeProtocolConfigAccount },
    { fixture: fixtures.launch, schema: "schemaVersion", decode: decodeLaunchConfigAccount },
    { fixture: fixtures.curve, schema: "schemaVersion", decode: (input: AccountFixture) => decodeCurveAccount(input, launch) },
    { fixture: fixtures.swap, schema: "schemaVersion", decode: decodeSwapConfigAccount },
    { fixture: fixtures.pool, schema: "schemaVersion", decode: (input: AccountFixture) => decodePoolAccount(input, swap) },
  ];
  for (const { fixture, schema, decode } of cases) {
    await assert.rejects(decode({ ...fixture, owner: ZERO_ADDRESS }), /account owner/);
    await assert.rejects(decode({ ...fixture, data: fixture.data.slice(1) }), /data length/);
    await assert.rejects(decode({ ...fixture, data: new Uint8Array(fixture.data.length + 1) }), /data length/);
    await assert.rejects(decode(mutate(fixture, "discriminator", 0)), /discriminator/);
    await assert.rejects(decode({ ...fixture, address: TREASURY }), /PDA/);
    await assert.rejects(decode(mutate(fixture, "bump", fixture.data[9]! ^ 1)), /bump/);
    await assert.rejects(decode(mutate(fixture, schema, 2)), /schema version/);
    await assert.rejects(decode(mutate(fixture, "reserved", 1)), /zeroed/);
    const sliced = await decode({ ...fixture, data: offsetView(fixture.data) });
    assert.equal(sliced.address, fixture.address, "DataView must honor byteOffset and byteLength");
  }
});

test("protocol configuration enforces authorities, deployment identities and canonical flags", async () => {
  const { protocol } = await makeProgramFixtures();
  for (const [field, value, message] of [
    ["admin", ZERO_ADDRESS, /cannot be the default/],
    ["treasury", ZERO_ADDRESS, /cannot be the default/],
    ["solQuoteMint", USDC_QUOTE_MINT_ADDRESS, /SOL mint/],
    ["usdcQuoteMint", SOL_QUOTE_MINT_ADDRESS, /USDC mint/],
    ["archSwapProgram", ARCH_CURVE_PROGRAM_ADDRESS, /ArchSwap program/],
    ["activeSolLaunchConfig", ZERO_ADDRESS, /both active/],
    ["activeUsdcLaunchConfig", ZERO_ADDRESS, /both active/],
  ] as const) await assert.rejects(decodeProtocolConfigAccount(mutate(protocol, field, value)), message);
  await assert.rejects(decodeProtocolConfigAccount(mutate(protocol, "launchesEnabled", 2)), /canonical bool/);
  let disabled = mutate(protocol, "launchesEnabled", 0);
  disabled = mutate(disabled, "activeSolLaunchConfig", ZERO_ADDRESS);
  disabled = mutate(disabled, "activeUsdcLaunchConfig", ZERO_ADDRESS);
  assert.equal((await decodeProtocolConfigAccount(disabled)).launchesEnabled, false);
});

test("launch parameters reject invalid allocation, virtual reserves, decimals, fees and quote kind", async () => {
  const { launch } = await makeProgramFixtures();
  for (const [field, amount, message] of [
    ["initialVirtualBaseReserves", 800_000n, /virtual reserves/],
    ["initialVirtualQuoteReserves", 0n, /virtual reserves/],
    ["initialSaleBaseReserves", 0n, /allocation/],
    ["migrationBaseReserves", 0n, /allocation/],
    ["tokenTotalSupply", 999_999n, /allocation/],
  ] as const) await assert.rejects(decodeLaunchConfigAccount(mutate(launch, field, amount)), message);
  await assert.rejects(decodeLaunchConfigAccount(mutate(launch, "tokenDecimals", 9)), /decimals/);
  await assert.rejects(decodeLaunchConfigAccount(mutate(launch, "curveTotalFeeBps", 1_001, "u16")), /fee basis points/);
  await assert.rejects(decodeLaunchConfigAccount(mutate(launch, "curveCreatorFeeBps", 101, "u16")), /fee basis points/);
  await assert.rejects(decodeLaunchConfigAccount(mutate(launch, "ammCreatorFeeBps", 951, "u16")), /fee basis points/);
  await assert.rejects(decodeLaunchConfigAccount(mutate(launch, "quoteKind", 2)), /Unknown quote kind/);
  await assert.rejects(decodeLaunchConfigAccount(mutate(launch, "quoteKind", 1)), /USDC quote mint/);
  await assert.rejects(decodeLaunchConfigAccount(mutate(launch, "createdBy", ZERO_ADDRESS)), /default address/);
});

test("curve decoder validates launch allocation, vault identity, reserves and lifecycle", async () => {
  const { fixtures, launch, pool } = await decoded();
  const decode = (input: AccountFixture) => decodeCurveAccount(input, launch);
  for (const [field, value, message] of [
    ["launchConfig", TREASURY, /LaunchConfig/],
    ["baseMint", TREASURY, /PDA/],
    ["creator", TREASURY, /base mint PDA/],
    ["baseVault", TREASURY, /base vault ATA/],
    ["quoteVault", TREASURY, /quote vault ATA/],
    ["archSwapPool", pool.address, /Unmigrated/],
  ] as const) await assert.rejects(decode(mutate(fixtures.curve, field, value)), message);
  for (const [field, value, message] of [
    ["launchNonce", 92n, /base mint PDA/],
    ["migrationBaseReserves", 200_001n, /allocation/],
    ["tokenTotalSupply", 999_999n, /allocation/],
    ["realSaleBaseReserves", 800_001n, /allocation/],
    ["virtualBaseReserves", 0n, /virtual reserves/],
    ["virtualQuoteReserves", 0n, /virtual reserves/],
    ["realSaleBaseReserves", 0n, /completion flag/],
  ] as const) await assert.rejects(decode(mutate(fixtures.curve, field, value)), message);
  await assert.rejects(decode(mutate(fixtures.curve, "complete", 2)), /canonical bool/);
  await assert.rejects(decode(mutate(fixtures.curve, "migrated", 2)), /canonical bool/);
  await assert.rejects(decode(mutate(fixtures.curve, "complete", 1)), /completion flag/);
  await assert.rejects(decode(mutate(fixtures.curve, "migrated", 1)), /Migrated Curve/);
  await assert.rejects(decode(mutate(fixtures.curve, "metadataCommitment", new Uint8Array(32))), /cannot be empty/);
  let complete = mutate(fixtures.curve, "realSaleBaseReserves", 0n);
  complete = mutate(complete, "complete", 1);
  assert.equal((await decode(complete)).complete, true);
  let migrated = mutate(complete, "migrated", 1);
  migrated = mutate(migrated, "realQuoteReserves", 0n);
  await assert.rejects(decode(migrated), /ArchSwap pool/);
  migrated = mutate(migrated, "archSwapPool", pool.address);
  assert.equal((await decode(migrated)).migrated, true);
  await assert.rejects(decode(mutate(migrated, "realQuoteReserves", 1n)), /zero real quote/);
  await assert.rejects(decodeCurveAccount(fixtures.curve, { ...launch, quoteMint: USDC_QUOTE_MINT_ADDRESS }), /LaunchConfig/);
});

test("swap and pool validation rejects substituted relationships and invalid liquidity economics", async () => {
  const { fixtures, swap } = await decoded();
  for (const field of ["admin", "treasury"] as const) {
    await assert.rejects(decodeSwapConfigAccount(mutate(fixtures.swap, field, ZERO_ADDRESS)), /default address/);
  }
  await assert.rejects(decodeSwapConfigAccount(mutate(fixtures.swap, "archCurveProgram", ARCH_SWAP_PROGRAM_ADDRESS)), /ArchCurve program/);
  const decode = (input: AccountFixture) => decodePoolAccount(input, swap);
  for (const [field, message] of [
    ["swapConfig", /SwapConfig/], ["curveAuthority", /Curve authority/],
    ["baseVault", /base vault ATA/], ["quoteVault", /quote vault ATA/], ["lpMint", /LP mint PDA/],
  ] as const) await assert.rejects(decode(mutate(fixtures.pool, field, TREASURY)), message);
  await assert.rejects(decode(mutate(fixtures.pool, "lpMintBump", fixtures.pool.data[fixtures.pool.offsets.lpMintBump!]! ^ 1)), /LP mint PDA/);
  await assert.rejects(decode(mutate(fixtures.pool, "creator", ZERO_ADDRESS)), /default address/);
  for (const field of ["baseReserves", "quoteReserves", "initialLockedBase", "initialLockedQuote", "permanentlyLockedShares"] as const) {
    await assert.rejects(decode(mutate(fixtures.pool, field, 0n)), /liquidity must remain/);
  }
  await assert.rejects(decode(mutate(fixtures.pool, "totalEconomicShares", 9_999n)), /liquidity must remain/);
  await assert.rejects(decode(mutate(fixtures.pool, "creatorFeeBps", 951, "u16")), /fee basis points/);
  assert.equal((await decode(mutate(fixtures.pool, "totalEconomicShares", 10_000n))).totalEconomicShares, 10_000n);
});

test("configuration relationship assertions reject mismatched treasury, programs and inactive launch", async () => {
  const { protocol, launch, swap } = await decoded();
  assert.throws(() => assertProtocolSwapRelationship(protocol, { ...swap, treasury: CREATOR }), /relationship/);
  assert.throws(() => assertProtocolSwapRelationship({ ...protocol, archSwapProgram: ARCH_CURVE_PROGRAM_ADDRESS }, swap), /relationship/);
  assert.throws(() => assertProtocolSwapRelationship(protocol, { ...swap, archCurveProgram: ARCH_SWAP_PROGRAM_ADDRESS }), /relationship/);
  assert.throws(() => assertLaunchConfigActive({ ...protocol, activeSolLaunchConfig: ZERO_ADDRESS }, launch), /not active/);
  const usdc = await decoded("usdc");
  assert.throws(() => assertLaunchConfigActive({ ...usdc.protocol, activeUsdcLaunchConfig: ZERO_ADDRESS }, usdc.launch), /not active/);
});

test("account maps preserve decoded identities and derive trader, provider, claim and migration ATAs", async () => {
  const { protocol, curve, swap, pool } = await decoded();
  const [base, quote, lp, creatorQuote, treasuryQuote] = await Promise.all([
    deriveAssociatedTokenAddress(TREASURY, curve.baseMint), deriveAssociatedTokenAddress(TREASURY, curve.quoteMint),
    deriveAssociatedTokenAddress(TREASURY, pool.lpMint), deriveAssociatedTokenAddress(CREATOR, curve.quoteMint),
    deriveAssociatedTokenAddress(protocol.treasury, curve.quoteMint),
  ]);
  assert.deepEqual(await deriveCurveTradeAccountMap(curve, TREASURY), {
    curve: curve.address, launch_config: curve.launchConfig, base_mint: curve.baseMint, quote_mint: curve.quoteMint,
    base_vault: curve.baseVault, quote_vault: curve.quoteVault,
    trader_base_account: base.address, trader_quote_account: quote.address, trader: TREASURY,
  });
  assert.deepEqual(await derivePoolTradeAccountMap(pool, TREASURY), {
    pool: pool.address, base_mint: pool.baseMint, quote_mint: pool.quoteMint,
    base_vault: pool.baseVault, quote_vault: pool.quoteVault,
    trader_base_account: base.address, trader_quote_account: quote.address, trader: TREASURY,
  });
  assert.deepEqual(await derivePoolLiquidityAccountMap(pool, TREASURY), {
    pool: pool.address, base_mint: pool.baseMint, quote_mint: pool.quoteMint, lp_mint: pool.lpMint,
    base_vault: pool.baseVault, quote_vault: pool.quoteVault, provider_base_account: base.address,
    provider_quote_account: quote.address, provider_lp_account: lp.address, provider: TREASURY,
  });
  assert.deepEqual(await deriveCurveCreatorClaimAccountMap(curve), {
    curve: curve.address, quote_mint: curve.quoteMint, quote_vault: curve.quoteVault, creator_quote_account: creatorQuote.address,
  });
  assert.deepEqual(await derivePoolCreatorClaimAccountMap(pool), {
    pool: pool.address, base_mint: pool.baseMint, quote_mint: pool.quoteMint,
    quote_vault: pool.quoteVault, creator_quote_account: creatorQuote.address,
  });
  assert.deepEqual(await deriveCurveProtocolClaimAccountMap(curve, protocol), {
    protocol_config: protocol.address, curve: curve.address, quote_mint: curve.quoteMint,
    quote_vault: curve.quoteVault, treasury_quote_account: treasuryQuote.address,
  });
  assert.deepEqual(await derivePoolProtocolClaimAccountMap(pool, swap), {
    swap_config: swap.address, pool: pool.address, base_mint: pool.baseMint, quote_mint: pool.quoteMint,
    quote_vault: pool.quoteVault, treasury_quote_account: treasuryQuote.address,
  });
  const initialLp = await deriveAssociatedTokenAddress(pool.address, pool.lpMint);
  assert.deepEqual(await deriveCurveMigrationAccountMap(curve, protocol, swap, TREASURY), {
    protocol_config: protocol.address, launch_config: curve.launchConfig, curve: curve.address,
    base_mint: curve.baseMint, quote_mint: curve.quoteMint, base_vault: curve.baseVault, quote_vault: curve.quoteVault,
    swap_config: swap.address, arch_swap_pool: pool.address, arch_swap_base_vault: pool.baseVault,
    arch_swap_quote_vault: pool.quoteVault, arch_swap_lp_mint: pool.lpMint,
    arch_swap_initial_lp_token_account: initialLp.address, payer: TREASURY,
  });
  for (const derive of [
    () => deriveCurveTradeAccountMap(curve, ZERO_ADDRESS), () => derivePoolTradeAccountMap(pool, ZERO_ADDRESS),
    () => derivePoolLiquidityAccountMap(pool, ZERO_ADDRESS),
    () => deriveCurveMigrationAccountMap(curve, protocol, swap, ZERO_ADDRESS),
    () => deriveCurveMigrationAccountMap(curve, protocol, { ...swap, treasury: CREATOR }, TREASURY),
  ]) await assert.rejects(derive(), /default address|relationship/);
});

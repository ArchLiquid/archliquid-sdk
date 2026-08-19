import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { AccountRole, address, type Instruction } from "@solana/kit";

import {
  ARCH_CURVE_PROGRAM_ADDRESS,
  ARCH_LOCKER_PROGRAM_ADDRESS,
  ARCH_SWAP_PROGRAM_ADDRESS,
} from "../src/addresses.js";
import {
  assertOwnedInstructionSignable,
  buildOwnedInstruction,
  decodeOwnedInstruction,
} from "../src/owned-program-instructions.js";
import {
  OwnedQuoteMathError,
  calculateAmmBuyExactBaseOut,
  calculateAmmDepositExactShares,
  calculateAmmSellExactBaseIn,
  calculateAmmWithdrawExactShares,
  calculateCurveBuyExactBaseOut,
  calculateCurveBuyExactQuoteIn,
  calculateCurveSellExactBaseIn,
  calculateInitialLiquidityShares,
} from "../src/owned-quote-math.js";
import { derivePoolAddress, derivePoolLpMintAddress } from "../src/owned-program-pdas.js";

const MAX_U64 = (1n << 64n) - 1n;
const PRIMARY = "So11111111111111111111111111111111111111112";
const SUBSTITUTE = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const poolAccounts = {
  pool: PRIMARY,
  base_mint: PRIMARY,
  quote_mint: PRIMARY,
  lp_mint: PRIMARY,
  base_vault: PRIMARY,
  quote_vault: PRIMARY,
  provider_base_account: PRIMARY,
  provider_quote_account: PRIMARY,
  provider_lp_account: PRIMARY,
  provider: PRIMARY,
} as const;

function replaceAccount(instruction: Instruction, index: number, value: string): Instruction {
  assert.ok(instruction.accounts);
  return {
    ...instruction,
    accounts: instruction.accounts.map((account, accountIndex) =>
      accountIndex === index ? { ...account, address: address(value) } : account),
  };
}

test("IDL identities and committed hashes match the governed programs", async () => {
  const fixtures = [
    ["arch_curve", ARCH_CURVE_PROGRAM_ADDRESS, "a34bc24187016e2215dc098ad2f7016bf69e4f2b5297aa30328b9d25b80e6e33"],
    ["arch_swap", ARCH_SWAP_PROGRAM_ADDRESS, "d36c34fd3ba3beb11e12fcbc15edee76a164b149987c69c50330cb8c036f5e4d"],
    ["arch_locker", ARCH_LOCKER_PROGRAM_ADDRESS, "4281c7c62244928c5ecf2fcc266f3f036547ac1dc1a437bddf6bbfedc1b1061c"],
  ] as const;
  for (const [name, expectedAddress, expectedHash] of fixtures) {
    const bytes = await readFile(new URL(`../idl/${name}.json`, import.meta.url));
    const idl = JSON.parse(bytes.toString("utf8")) as { address: string };
    assert.equal(idl.address, expectedAddress);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), expectedHash);
  }
});

test("derives fresh-release pool and LP mint addresses exactly", async () => {
  const base = address("ErogPFvGsinQukiVfqvihsdo1CVAjTV11X6aW1QTgQLb");
  const quote = address("So11111111111111111111111111111111111111112");
  const pool = await derivePoolAddress(base, quote);
  const lpMint = await derivePoolLpMintAddress(pool.address);
  assert.equal(pool.address, "EHJVPjbSYc37i3FXsL8LaCJR1NEmCgm5XFM7cDw2Xh9E");
  assert.equal(lpMint.address, "2c7ADRZDnCdfVwgixpjUsGUfPueoVAxLx3Cry7qHvrGv");
});

test("builds, decodes, and substitution-checks public LP instructions", () => {
  const expectation = {
    program: "archSwap",
    instruction: "deposit_liquidity",
    accounts: poolAccounts,
    args: { lp_shares_out: 7n, max_base_amount_in: 11n, max_quote_amount_in: 13n },
  } as const;
  const instruction = buildOwnedInstruction(expectation);
  const decoded = assertOwnedInstructionSignable(instruction, expectation);
  assert.deepEqual(decoded.args, expectation.args);
  assert.equal(instruction.accounts?.[9]?.role, AccountRole.READONLY_SIGNER);
  assert.deepEqual(Array.from(instruction.data?.slice(0, 8) ?? []), [245, 99, 59, 25, 151, 71, 233, 249]);
  assert.throws(
    () => decodeOwnedInstruction(replaceAccount(instruction, 3, SUBSTITUTE), expectation),
    /Unexpected address for lp_mint/,
  );
  assert.throws(
    () => buildOwnedInstruction({ ...expectation, args: { ...expectation.args, max_quote_amount_in: -1n } }),
    /outside u64 range/,
  );
});

test("matches Curve and AMM Rust rounding vectors", () => {
  const curve = { virtualBase: 1_000_000n, virtualQuote: 100_000n, realSaleBase: 800_000n, realQuote: 50_000n };
  assert.deepEqual(calculateCurveBuyExactBaseOut(curve, 100_000n, MAX_U64, 125, 30), {
    baseAmountOut: 100_000n,
    grossQuoteAmountIn: 11_253n,
    netQuoteAmountIn: 11_112n,
    fees: { total: 141n, creator: 33n, protocol: 108n },
    nextReserves: { virtualBase: 900_000n, virtualQuote: 111_112n, realSaleBase: 700_000n, realQuote: 61_112n },
  });
  assert.equal(calculateCurveBuyExactQuoteIn(curve, 11_253n, 1n, 125, 30).baseAmountOut, 100_007n);
  assert.deepEqual(calculateCurveSellExactBaseIn(curve, 50_000n, 1n, 125, 30).fees, { total: 60n, creator: 14n, protocol: 46n });

  const reserves = { base: 200_000_000n, quote: 100_000_000n };
  const buy = calculateAmmBuyExactBaseOut(reserves, 10_000_000n, MAX_U64, 20, 5, 5);
  assert.equal(buy.grossQuoteAmountIn, 5_278_995n);
  assert.equal(buy.nextReserves.quote, 105_273_717n);
  const sell = calculateAmmSellExactBaseIn(reserves, 10_000_000n, 1n, 20, 5, 5);
  assert.equal(sell.userQuoteAmountOut, 4_747_618n);
  assert.deepEqual(sell.fees, { total: 14_286n, reinvest: 9_526n, creator: 2_380n, protocol: 2_380n });
});

test("protects permanently locked shares and deposit limits", () => {
  assert.equal(calculateInitialLiquidityShares({ base: 206_900_000_000_000n, quote: 84_978_333_272n }), 4_193_091_598_567n);
  assert.deepEqual(calculateAmmDepositExactShares({ base: 101n, quote: 203n }, 100n, 7n, 8n, 15n), {
    lpSharesOut: 7n,
    baseAmountIn: 8n,
    quoteAmountIn: 15n,
    nextReserves: { base: 109n, quote: 218n },
    nextTotalEconomicShares: 107n,
  });
  assert.throws(
    () => calculateAmmDepositExactShares({ base: 101n, quote: 203n }, 100n, 7n, 7n, 15n),
    (error) => error instanceof OwnedQuoteMathError && error.code === "share_limit_exceeded",
  );
  assert.deepEqual(calculateAmmWithdrawExactShares({ base: 1_010n, quote: 2_030n }, 1_000n, 900n, 99n, 99n, 200n), {
    lpSharesIn: 99n,
    baseAmountOut: 99n,
    quoteAmountOut: 200n,
    nextReserves: { base: 911n, quote: 1_830n },
    nextTotalEconomicShares: 901n,
  });
  assert.throws(
    () => calculateAmmWithdrawExactShares({ base: 1_010n, quote: 2_030n }, 1_000n, 900n, 101n, 0n, 0n),
    (error) => error instanceof OwnedQuoteMathError && error.code === "locked_share_violation",
  );
});

test("preserves fee conservation and constant product across sampled states", () => {
  for (let index = 1; index <= 2_000; index += 1) {
    const baseAmount = BigInt(index * 97);
    const before = { base: 5_000_000n + BigInt(index * 11), quote: 4_000_000n + BigInt(index * 13) };
    const result = calculateAmmSellExactBaseIn(before, baseAmount, 0n, 20, 5, 5);
    assert.equal(result.grossQuoteAmountOut, result.userQuoteAmountOut + result.fees.total);
    assert.ok(result.nextReserves.base * result.nextReserves.quote >= before.base * before.quote);
  }
});

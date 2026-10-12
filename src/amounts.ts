import { OwnedSdkError } from "./errors.js";

const MAX_U64 = (1n << 64n) - 1n;
const BPS = 10_000n;

function checkedAmount(amount: bigint): bigint {
  if (typeof amount !== "bigint" || amount < 0n || amount > MAX_U64) {
    throw new OwnedSdkError("invalid_input", "Amount must be an unsigned u64 bigint");
  }
  return amount;
}

function checkedDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new OwnedSdkError("invalid_input", "Token decimals must be an integer between 0 and 255");
  }
}

/** Convert a decimal string to exact token base units; never rounds or uses floating point. */
export function parseOwnedAmount(value: string, decimals: number): bigint {
  checkedDecimals(decimals);
  if (typeof value !== "string" || value.length > 277) {
    throw new OwnedSdkError("invalid_input", "Amount must be a bounded decimal string");
  }
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(value);
  const whole = match?.[1];
  const fraction = match?.[2] ?? "";
  if (whole === undefined || fraction.length > decimals) {
    throw new OwnedSdkError("invalid_input", "Amount is invalid or has more precision than the mint supports");
  }
  return checkedAmount(BigInt(whole + fraction.padEnd(decimals, "0")));
}

/** Format base units without precision loss; trailing fractional zeroes are omitted. */
export function formatOwnedAmount(amount: bigint, decimals: number): string {
  checkedAmount(amount);
  checkedDecimals(decimals);
  if (decimals === 0) return amount.toString();
  const digits = amount.toString().padStart(decimals + 1, "0");
  const fraction = digits.slice(-decimals).replace(/0+$/, "");
  const whole = digits.slice(0, -decimals);
  return fraction ? `${whole}.${fraction}` : whole;
}

function checkedSlippage(basisPoints: number): bigint {
  if (!Number.isInteger(basisPoints) || basisPoints < 0 || basisPoints > 10_000) {
    throw new OwnedSdkError("invalid_input", "Slippage must be an integer between 0 and 10000 basis points");
  }
  return BigInt(basisPoints);
}

/** Round an exact-input output floor down. Applications must choose their own slippage budget. */
export function calculateMinimumAmountOut(amount: bigint, slippageBps: number): bigint {
  return checkedAmount(amount) * (BPS - checkedSlippage(slippageBps)) / BPS;
}

/** Round an exact-output input ceiling up and reject u64 overflow. */
export function calculateMaximumAmountIn(amount: bigint, slippageBps: number): bigint {
  const numerator = checkedAmount(amount) * (BPS + checkedSlippage(slippageBps));
  return checkedAmount((numerator + BPS - 1n) / BPS);
}

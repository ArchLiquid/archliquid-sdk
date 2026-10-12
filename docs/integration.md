# Integrating ArchLiquid

This guide describes the SDK's implemented contracts. It does not establish live
wallet/RPC execution, deployed-bytecode identity, mainnet support or differential
parity with Rust programs. The supported deployment registry is devnet-only.

## Install, imports and environments

Build from a reviewed checkout with `npm ci` and `npm run check`, then create the
tarball with `npm pack`. Install the approved artifact in your application.
The package is ESM. Use NodeNext or Bundler TypeScript module resolution; the
consumer smoke uses the repository's TypeScript 5.9 compiler.

```ts
import { createOwnedAccountReader, loadPoolSnapshot } from "@archliquid/sdk";
import { calculateAmmBuyExactQuoteIn } from "@archliquid/sdk/math";
import { decodePoolAccount } from "@archliquid/sdk/accounts";
import { buildTypedOwnedInstruction } from "@archliquid/sdk/instructions";
import curveIdl from "@archliquid/sdk/idl/arch-curve" with { type: "json" };
```

The root exports remain available. Subpaths narrow the imported API; measured
bundle sizes are printed by the package smoke, rather than promised as fixed
sizes. A browser bundle check runs with no Node polyfills. Validate your actual
browser, wallet adapter, secure-context/Web Crypto and RPC transport separately.

For repeated deterministic PDA derivations, `createOwnedAddressDeriver({ maxEntries: 128 })`
offers an opt-in bounded LRU cache. Pending derivations share their promise,
failures are removed and `clearCache()` releases entries. It caches addresses only,
not accounts, quotes or RPC state. Standalone derivation functions remain uncached.

Node 20.18.0 is the retained compatibility minimum, not a production recommendation.
Use a maintained Node 22 or 24 release. See the
[official Node release schedule](https://github.com/nodejs/Release).
The SDK and Kit declare Node >=20.18.0, but Kit's locked transitive dependency
`commander@15.0.0` declares >=22.12.0. Expect installer warnings on Node 20 and
failure with `engine-strict`; the minimum-runtime CI checks do not override this
upstream engine declaration. Use a maintained Node 22.12+ or 24 installation.

## Amounts, fees and slippage

Amounts, reserves, shares and slots use `bigint`; token values are base units.
Never convert these values through JavaScript floating point. Token decimals
come from validated mint data, not a symbol or an assumption.

```ts
import {
  parseOwnedAmount, formatOwnedAmount,
  calculateMinimumAmountOut, calculateMaximumAmountIn,
} from "@archliquid/sdk";

const baseUnits = parseOwnedAmount("1.234567", 6); // 1_234_567n
const display = formatOwnedAmount(baseUnits, 6);  // "1.234567"
const minimumOut = calculateMinimumAmountOut(1_000n, 50); // 995n; floor
const maximumIn = calculateMaximumAmountIn(1_001n, 50);   // 1_007n; ceiling
```

Parsing rejects signs, exponents, whitespace, ambiguous leading zeros and excess
fractional precision; it does not round. Amounts must fit unsigned u64 and mint
decimals must be integers from 0 through 255. Slippage helpers accept integer
basis points from 0 through 10,000; applications choose the budget. A computed
input ceiling that exceeds u64 is rejected.

Buy-exact-base requests specify output and maximum quote input. Buy-exact-quote
requests specify quote input and minimum base output. Sell-exact-base requests
specify input and minimum quote output. There is no sell-exact-quote constructor.
Quotes expose fees and projected reserves; LP deposit requirements round up and
LP withdrawal outputs round down. Quote limits are token-transfer values in base
units; rent, transaction fees and account preparation costs are separate.

## Validated account snapshots

Inject a trusted Kit RPC or implement the `OwnedAccountReader` interface for
testing. Creating a reader does not make requests until a loader is called.

```ts
const reader = createOwnedAccountReader(rpc);
const snapshot = await loadPoolSnapshot(reader, baseMint, quoteMint, {
  commitment: "confirmed",
  minContextSlot: previouslyObservedSlot,
  abortSignal,
  timeoutMs: 15_000,
  retries: 0,
});
```

`loadPoolSnapshot(reader, baseMint, quoteMint, options?)` validates pool/config,
mints, LP supply and vault accounting from one batched response. The Curve loader,
`loadCurveSnapshot(reader, baseMint, options?)`, first discovers related identities,
then reloads and validates the complete set with a minimum context at least as new
as discovery. `loadLaunchSnapshot(reader, quoteMint, options?)` resolves and
revalidates the currently active launch configuration and supporting identities.
Every loader checks the RPC genesis hash against the devnet registry.

Snapshots retain the final response slot, observation timestamp, commitment and
deployment. Read options default to confirmed commitment, a 15-second timeout,
zero retries and a 100-ms retry delay. Timeout is bounded to 60 seconds, retries
to three, and retry-delay inputs to 5 seconds. Retry only transient reader errors;
validation failures are not repaired by blind retry. Pass cancellation explicitly
and handle missing accounts as a real state, not zero balances.

Snapshot identity and plain objects are frozen. Byte-array reads return defensive
copies, so modifying a returned array cannot change stored validated state.
SDK provenance is instance-local; copies/deserialized snapshots cannot be passed
as validated snapshots to plan constructors. Low-level source types remain useful
for pure quotes, but they do not establish snapshot provenance.

## Trade and LP plans

```ts
import {
  createOwnedMarketTradePlan, createOwnedPoolLiquidityPlan,
  assertOwnedTransactionPlanSignable,
} from "@archliquid/sdk";

const trade = await createOwnedMarketTradePlan(snapshot, trader, {
  side: "buy", inputMode: "exact-quote",
  quoteAmountIn: 1_000_000n, minBaseAmountOut: 500_000n,
}, { validitySlots: 100n, validityMs: 30_000 });

const deposit = await createOwnedPoolLiquidityPlan(snapshot, provider, {
  action: "deposit", lpSharesOut: 100n,
  maxBaseAmountIn: 1_000n, maxQuoteAmountIn: 1_000n,
});
const withdraw = await createOwnedPoolLiquidityPlan(snapshot, provider, {
  action: "withdraw", lpSharesIn: 100n,
  minBaseAmountOut: 1n, minQuoteAmountOut: 1n,
});
assertOwnedTransactionPlanSignable(trade, currentRpcSlot, Date.now());
```

Trade plans accept Curve or Pool snapshots; LP plans require Pool snapshots.
They derive canonical user ATAs, calculate the quote and build the matching public
instruction. The caller's original limits remain in the instruction even if the
quote is better. `requiredTokenAccounts` lists expected base, quote and LP accounts
as appropriate. Plans do not check user balances, create ATAs, wrap SOL, simulate,
sign or submit transactions.

The plan contains `instruction`, public `intent`, `quote`, `context` and the token
account requirements. Its private independent intent copy binds its same-instance
provenance. `assertOwnedTransactionPlanSignable` rejects altered plan instruction
bytes/intent, expired or backwards context, and copied/deserialized plans. This
checks the plan's instruction, not unrelated preparation or fee instructions.

Default validity is 150 slots and 60,000 ms, both measured from snapshot observation.
Expiry is exclusive: equality with either expiry bound is expired. Reload/recompute
when expired while preserving the user's approved limits. A slot/time budget does
not guarantee reserves remain unchanged; on-chain slippage checks remain necessary.
Keep an independent user-approved intent record rather than treating a freshly
constructed arbitrary plan as evidence of user consent.

For raw quotes, `assertOwnedMarketQuoteFresh(quote, currentSlot, currentUnixMs)`
validates the complete envelope before freshness comparisons.
`assertOwnedMarketQuoteValidEnvelope` validates enums, mint addresses and ordered
unsigned-u64 slots/safe-integer timestamps, not result economics or RPC authenticity.
Constructor results are deeply frozen without freezing caller source snapshots.

## Prepare, simulate, review and sign

The [typechecked repository example](../examples/pool-trade.ts) injects Kit RPC,
token-preparation and human-wallet callbacks. It calls the real snapshot and plan
APIs, compiles a transaction using a fresh blockhash, simulates it, checks plan
freshness, requests a human signature and rejects changed returned message bytes.
It imports repository source for typechecking; change the SDK import to
`@archliquid/sdk` when copying it into an application. Importing it sends nothing.

Before simulation, validate the user's accounts and balances, including ATA mint,
authority, initialized/frozen state and delegation policy. Create missing accounts
explicitly and review their payer/rent costs. For WSOL, prepare funding and
`SyncNative` in the intended order. Decide whether temporary accounts should be
closed after the trade, and show that instruction and beneficiary for approval.
Supported layouts are legacy SPL Token; Token-2022 extensions are unsupported.

Simulate the full transaction with `minContextSlot` at least the snapshot's slot,
the intended commitment, final account-preparation instructions and a recent
blockhash. Simulation success is not a signature, commitment or future-success
guarantee. Signature verification may be disabled for pre-signing simulation;
check required signatures before sending. Handle compute budgets, priority fees,
transaction-size limits and address lookup tables in the application.

Immediately before signing, validate the SDK instruction against the independent
intent and recheck freshness. Review every final transaction instruction. After
wallet approval, ensure the message still matches the reviewed transaction and
recheck plan and block-height expiry. Any material transaction change needs review
and simulation again. Applications explicitly submit/confirm with their chosen
commitment and handle ambiguous submission outcomes without blind write retries.

## Launches, migration, fee claims and locks

For a launch, call `loadLaunchSnapshot` with a supported quote mint, then
`createOwnedCurvePlan(snapshot, creator, { launchNonce, metadata, metadataCommitment })`.
The plan uses the enabled active config and derives base-mint, curve, vault and
metadata PDAs. Metadata is `{ name, symbol, uri }` and its commitment is a nonzero
32-byte value bound according to the program's metadata rules. The SDK does not
produce this commitment or guarantee the target accounts do not already exist;
verify nonce uniqueness and the exact program-defined commitment before approval.

Migration and creator/protocol fee claims use the low-level typed instruction
builder. Use the appropriate `deriveCurveMigrationAccountMap`,
`deriveCurveCreatorClaimAccountMap`, `deriveCurveProtocolClaimAccountMap`,
`derivePoolCreatorClaimAccountMap` or `derivePoolProtocolClaimAccountMap` after
validating the related accounts. Confirm maturity/completion, authorities and fee
recipient identities as appropriate, then compare the final instruction with the
independent full intent and follow the same simulation/signing workflow.

For self-custody locks, `buildCreateSelfLiquidityLock` accepts owner, mint, amount,
nonce, permanent mode and unlock timestamp. It derives the lock/vault and uses the
owner's source ATA; validate the account balance and rent before signing.
`decodeLiquidityLock` checks the lock's identity and layout, and
`assertLiquidityLockVault` verifies custody and rejects external delegation or
close authority. Timed locks must meet `MIN_LOCK_SECONDS`; extension cannot shorten
them. Permanent locks cannot be released. Use `buildExtendLiquidityLock`,
`buildMakeLiquidityLockPermanent` and `buildReleaseLiquidityLock` only after current
state/authority/maturity review; the on-chain program enforces transition rules.

## Wrapped-SOL decoding and synchronization

`decodeLegacyTokenAccount` accepts lamports greater than token amount plus native
rent reserve, while rejecting insufficient backing. This is a valid intermediate
state after SOL is transferred to a WSOL account. Its spendable token amount has
not increased yet. See [Solana's SyncNative documentation](https://solana.com/docs/tokens/basics/sync-native).

Provide observed lamports and call `getLegacyNativeTokenAccountSurplus(account)`
to inspect that difference. `assertLegacyNativeTokenAccountSynchronized(account)`
requires a zero surplus. These helpers require an actual native mint/account and
the observed lamports. Account validity and synchronization policy are separate.
Do not automatically synchronize unsolicited SOL in protocol vaults; retain
protocol state/accounting semantics and use reviewed program-specific behavior.

## Errors and committed events

`OwnedQuoteMathError` keeps stable arithmetic error codes such as
`slippage_exceeded`, `zero_output`, `overflow` and `locked_share_violation`.
New integration helpers use `OwnedSdkError` with a stable `code`, `context` and
optional cause. Examples include `wrong_cluster`, `missing_account`,
`invalid_snapshot`, `stale_context`, `rpc_error`, `timeout`, `aborted`,
`invalid_serialization` and `quote_mismatch`. Address validation and quote
calculations can also propagate Solana Kit and existing quote errors through
these helpers. Existing low-level decoders may still throw ordinary `Error`;
do not assume every failure uses the new class.

`decodeOwnedProgramError(programNameOrAddress, numericCode, { instructionIndex, cause })`
returns `OwnedProgramError` or null. Custom error numbers are not globally unique:
identify the actual failing program, including CPI failures, before decoding.
Do not infer a CPI's program from its top-level instruction alone.

Custom codes and optional instruction indices accept `number` or `bigint`,
including values returned by Kit's lossless RPC parser. Codes must fit an unsigned
32-bit integer; indices must fit a nonnegative safe JavaScript integer. Invalid
values return null. Decoded `code` and `instructionIndex` fields remain numbers,
and the original cause is preserved. Direct `OwnedProgramError` construction and
the existing `OwnedProgramErrorContext` type continue to use numeric indices.

```ts
import { decodeOwnedTransactionEvents, assertCanonicalMigrationEventPair } from "@archliquid/sdk";
const events = decodeOwnedTransactionEvents({ logMessages: metadata.logMessages, err: metadata.err });
assertCanonicalMigrationEventPair(events);
```

Only explicit `err: null` is accepted by committed decoding. The decoder
conservatively excludes emissions in failed invocation subtrees, including their
successful children; parent emissions outside those subtrees remain. This is an
indexing policy validated with synthetic logs, not a runtime rollback-parity claim.
Returned indices are contiguous in log
order. Counts, line sizes, total logs and event payloads are bounded; malformed
base64, invalid known-event data, inconsistent stacks and truncated logs fail.
Unknown event discriminators are ignored for forward compatibility.

`decodeOwnedProgramEvents(logMessages)` retains raw emissions, including failed
invocations, for diagnostics. Use trusted confirmed/finalized transaction metadata
for indexing, with explicit reorganization/finality handling. Decoder acceptance
does not prove supplied strings came from the chain. The public event decoder
covers Curve/Swap events; locker event decoding is not included.

## Serialize data without creating authorization

`serializeOwnedQuote` emits version 1 JSON with bigint values represented as
`{ "$bigint": "unsigned-decimal-string" }`. `deserializeOwnedQuote` revives u64
tags, validates the envelope and returns deeply frozen plain data. The result is
typed `unknown` because generic economics are not validated.

The limits are 65,536 UTF-8 bytes, 64 nesting levels and 4,096 traversed values,
plus bounded aggregate string content. Plain objects, dense ordinary arrays,
strings, finite numbers, booleans, null and unsigned-u64 bigint values are accepted.
Undefined/function/symbol values, accessors, custom objects or `toJSON` hooks,
sparse/decorated arrays, reserved-key objects, nonfinite numbers and negative zero
are rejected to prevent silent JSON loss. No getter/toJSON hooks are executed.

Persisting a quote does not authenticate its result or source. Load a fresh
snapshot and recompute the plan with independently approved limits before signing.
Do not serialize plans or snapshots and treat them as SDK-validated instances.

## Verify and maintain the release contract

`npm run generate:idl` regenerates internal hash/layout/discriminator/error metadata
from the committed IDLs. Review generated changes with their source IDLs.
`npm run verify:idl` checks generator freshness, exact LF hashes and addresses,
public instruction/account roles and arguments, layout sizes/discriminators,
event discriminators and program errors. Administrative APIs remain excluded.

`npm run check` runs parity, source/example typechecking, regression/property tests
and builds. `npm run check:package -- --skip-check` then tests the real prepack
lifecycle from a source-only temporary fixture, actual tarball installation,
runtime/IDL imports, embedded source maps, TypeScript resolution and browser bundles.
Temporary artifacts are retained and printed for inspection; no workspace cleanup
or global package installation is performed. Advisory scanning and cross-platform
runtime checks are part of CI. These checks do not replace application integration
tests or independently sourced on-chain/Rust differential fixtures.

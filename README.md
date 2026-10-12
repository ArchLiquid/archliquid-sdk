# ArchLiquid SDK

ESM TypeScript tools for ArchLiquid's Solana devnet programs: ArchCurve,
ArchSwap and ArchLocker. The SDK builds reviewable instructions locally and
keeps wallet signing and submission under application control.

## Features

- Checked `bigint` Curve/AMM quotes and LP calculations with explicit limits.
- Typed public instruction builders and complete argument/identity validation.
- Batched, validated account snapshots and optional trade, LP and launch plans.
- Strict legacy SPL account/custody checks and explicit wrapped-SOL synchronization.
- Raw diagnostic events and transaction-aware committed-event decoding.
- Program-qualified errors, exact amount helpers and bounded quote serialization.
- Committed IDLs and a devnet deployment registry with governed SHA-256 hashes.

Administrative configuration instructions remain outside the public builder.
The registry contains devnet identities; there is no verified mainnet registry.
A genesis-hash match does not verify deployed program bytecode or an external audit.

## Build and consume

In this repository, use the locked dependencies:

```sh
npm ci
npm run check
npm pack
```

`npm pack` verifies the exact LF IDLs, builds `dist`, and checks package exports,
documentation and embedded TypeScript source maps. To consume the resulting
artifact in an application:

```sh
npm install /path/to/archliquid-sdk-0.1.0.tgz
```

This does not imply a public npm release. Use the approved artifact/distribution
channel for this proprietary package.

```ts
import { formatOwnedAmount, parseOwnedAmount } from "@archliquid/sdk";
import { calculateInitialLiquidityShares } from "@archliquid/sdk/math";

const amount = parseOwnedAmount("1.25", 6); // 1_250_000n base units
console.log(formatOwnedAmount(amount, 6)); // "1.25"
const shares = calculateInitialLiquidityShares({ base: 1_000n, quote: 100n });
```

The root export is preserved. Additive `@archliquid/sdk/math`, `/accounts` and
`/instructions` exports allow narrower imports. The package also exports
`/idl/arch-curve`, `/idl/arch-swap` and `/idl/arch-locker` JSON documents.

## Integration workflow

1. Inject a trusted Kit RPC with `createOwnedAccountReader`; load a fresh
   `loadCurveSnapshot`, `loadPoolSnapshot` or `loadLaunchSnapshot`.
2. Choose base-unit amounts and explicit slippage limits. Build a
   `createOwnedMarketTradePlan`, `createOwnedPoolLiquidityPlan` or
   `createOwnedCurvePlan` using the validated snapshot.
3. Validate user balances, prepare required ATAs/WSOL, obtain a fresh blockhash,
   and simulate the complete transaction with a context at least as new as the snapshot.
4. Revalidate the plan and the final transaction instructions, show the complete
   transaction for human wallet approval, and recheck expiry before an explicit send.

See [the integration guide](docs/integration.md) and the
[typechecked pool-trade example](examples/pool-trade.ts) for the API contracts,
liquidity/launch/lock workflows and the simulation/signing boundary.
The example injects RPC and wallet callbacks and never submits transactions.

`assertOwnedInstructionMatchesIntent` compares all approved arguments and account
roles/identities. The retained `assertOwnedInstructionSignable` checks schema and
accounts only; it does not establish that amounts or slippage match approved intent.

## Runtime and verification

The retained compatibility floor is Node **20.18.0**. Prefer a maintained Node
**22 or 24** release for production; Node 20 is end-of-life.
See the [official Node release schedule](https://github.com/nodejs/Release).
The locked transitive `commander@15.0.0` dependency declares Node **>=22.12.0**:
Node 20 installs may warn and `engine-strict` installs will fail. The minimum
runtime checks do not override that upstream installer constraint.
The package is ESM and its consumer smoke checks TypeScript 5.9 NodeNext and
Bundler resolution, JSON IDL exports and browser bundling without polyfills.
Applications still need their own browser/wallet and live-RPC verification.

CI targets Linux and Windows with Node 20.18.0, 22 and 24. It runs IDL parity,
typechecking, regression/property tests, builds, advisory scanning and an actual
tarball install in a clean consumer. Main/feature branch pushes and PRs trigger
the matrix; manual workflow dispatch is configured too. GitHub requires the
manual trigger to be available on the default branch before the manual-run UI
can be used. Feature pushes provide validation before that merge.
See [GitHub's manual workflow guidance](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow).
Overlapping runs for the same source branch are cancelled in favor of the newest run:

```sh
npm run check:package                # includes source checks
npm run check:package -- --skip-check # after npm run check has passed
```

The package smoke retains its unique temporary fixture, tarball and consumer
for inspection. Tests use local fixtures and mocks; they do not establish live
on-chain execution or differential parity with Rust programs.
See [the release validation record](docs/release-validation.md) for recorded
evidence, pending platform/live checks and the opt-in release gates.
The opt-in `npm run check:devnet -- --report /path/to/new-report.json` performs
bounded devnet reads and unsigned simulations without signing or submitting.
Independent reference fixtures use `npm run check:reference -- --fixture <path>
--sha256 <reviewed-hash>`; see [the reference fixture guide](docs/reference-quotes.md).
These opt-in gates are separate from ordinary CI; reports and unresolved cases
are recorded in the validation guides.

Learn more at [archliquid.com](https://archliquid.com/).

## Security

See [SECURITY.md](SECURITY.md) for reporting and integration responsibilities,
and [CHANGELOG.md](CHANGELOG.md) for compatibility notes.

## License

The ArchLiquid SDK is proprietary. See [LICENSE](LICENSE).

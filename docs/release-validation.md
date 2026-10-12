# Release validation record

Branch: `feature/sdk-production-readiness`. This record separates local code
validation from remote CI and live protocol validation. A passing local suite or
package smoke does not by itself justify a production-ready or on-chain parity claim.

## Evidence identity

Record the final reviewed commit SHA before publishing an artifact. Checks on an
uncommitted working tree must instead name the reviewed change set and record
that it was uncommitted; do not present its base SHA as the tested final commit.
Retain the exact package tarball, its SHA-256 and the package-smoke consumer
directory. Include command, Node/npm version, OS, exit status and test count with
each result. Results become stale when relevant implementation, dependencies,
fixtures, generated IDL metadata or packaging configuration changes.

## Current evidence

| Gate | Status | Evidence and limits |
| --- | --- | --- |
| Local source/example typecheck, regression tests and build | Final Node 24.21.0 check passed 114/114; Node 20.18.0 and 22.23.3 passed the earlier full 108-test check plus the six new reference-harness tests separately | Working-tree evidence on 12 October 2026. The Node 20/22 results are full 108-test runs plus a six-test addendum, not single full 114-test commands. SDK source/math/addresses/lock behavior remained unchanged during the addendum. |
| Exact IDL/source/generated metadata agreement | Passed within the local checks | Exact governed LF hashes, identities, public schemas/roles/arguments, layouts, events and error records. This checks committed metadata, not deployed bytecode. |
| Real tarball install and ESM/IDL/subpath imports | Passed on Node 20/22/24 working-tree artifacts | Source-only fixture exercises prepack; isolated consumers validate imports and 18 embedded source maps/export targets. These are not yet final release-commit artifacts. |
| TypeScript NodeNext/Bundler and browser bundle smoke | Passed on Node 20/22/24; Node 20 consumer checks resumed after host memory interruption | Browser compilation without polyfills. Node 20's original combined command did not exit successfully; its remaining components passed when resumed directly in the retained consumer. No actual browser wallet interaction. |
| Windows Node 20.18.0 / npm 10.8.2 | Full source check passed 108/108 plus six new reference-harness tests passed separately; every package component passed | Explicit test filenames avoid the Windows/Node 20 glob mismatch. Package command encountered host STATUS_COMMITMENT_LIMIT before TypeScript consumer checks; resumed NodeNext/Bundler and browser components passed. |
| Windows Node 22.23.3 / npm 10.9.9 | Full source check passed 108/108 plus six new reference-harness tests separately; full package check exited 0 | Official portable runtime archive SHA-256 verified. |
| Windows Node 24.21.0 / npm 11.19.0 | Final source check passed 114/114; preceding full package check exited 0 | Final check includes source/example typecheck, IDL parity, six reference-harness tests and build. |
| Linux Node 20.18.0 / 22 / 24 | Pending remote CI | These jobs cannot be claimed passed from a Windows-only local run. |
| Dependency advisory scan | Passed: zero reported vulnerabilities on 12 October 2026 | Fresh locked-tree `npm audit --audit-level=high`, including production/development dependencies, under Node 22.23.3 / npm 10.9.9; no --fix and no lockfile changes. This time-specific result does not establish vulnerability absence. |
| Live devnet account reads | Passed for observed deployment/config/market samples | Genesis/executable-program/config checks, both SOL/USDC launch snapshots, four Curves (three active/one migrated) and one Pool passed. Final report retained below; source/bytecode binding is not established. |
| Live devnet unsigned simulations | Passed all eight available SOL cases: final harness 24 pass / 0 fail / 4 skip | Exact market/token/fee/LP/event comparisons and rereads of unchanged actual accounts. No key/sign/send/airdrop. USDC markets were absent; real wallet and governed Rust build gates were skipped. |
| Human wallet signing/confirmation | Pending explicit authorization | Requires a selected wallet and approved transaction limits. Default tests never submit transactions. |
| Differential program/Rust quote fixtures | Pending independently sourced fixtures | Existing arithmetic/property fixtures are not a Rust execution or deployed-program parity proof. |
| Mainnet deployment support | Outside this release scope | Registry remains devnet-only; no verified mainnet identities or bytecode. |

The local runtime table records completed commands. All these runs tested an
uncommitted working tree, not a final source commit. Reviewed commit/artifact
identities must be recorded separately; later opt-in live report evidence follows.

| OS | Node/npm | Check and test count | Package smoke | Recorded source/artifact identity |
| --- | --- | --- | --- | --- |
| Windows | Node 20.18.0 / npm 10.8.2 | Full 108/108 + separate new six-test addendum; earlier IDL/typecheck/build passed | All components passed; original combined command interrupted by host memory, then resumed | `%TEMP%/archliquid-runtime-matrix-WUDZYu/node-20.18.0-source.log`; consumer `%TEMP%/archliquid-sdk-package-SN7yxx`; uncommitted tree |
| Windows | Node 22.23.3 / npm 10.9.9 | Full 108/108 + separate new six-test addendum; earlier IDL/typecheck/build passed | Full command passed, exit 0 | Consumer `%TEMP%/archliquid-sdk-package-vDihpI`; uncommitted tree |
| Windows | Node 24.21.0 / npm 11.19.0 | Final full 114/114; IDL/typecheck/example/build passed | Preceding full command passed, exit 0 | Local validation evidence on final source/tooling tests; uncommitted tree |
| Linux | Node 20.18.0 / to record | Pending CI | Pending CI | CI commit/run URL |
| Linux | Maintained Node 22 / to record | Pending CI | Pending CI | CI commit/run URL |
| Linux | Node 24 / to record | Pending CI | Pending CI | CI commit/run URL |

The current host has no installed WSL, Docker or Cargo toolchain, so local Linux
or Rust execution has not been established. Remote Linux CI and independently
sourced Rust fixtures remain separate required evidence rather than inferred passes.

The Node 20 resumed consumer checks used the same installed tarball and passed
NodeNext/Bundler resolution plus all three browser bundles. Observed minified
sizes were 88,737 bytes for integration, 57,917 bytes for a root math import and
569 bytes for the math subpath; Node 22 reported the same root/subpath math sizes.
These are measurements for those working-tree artifacts, not fixed size promises.
Runtime archive checksums were verified against official manifests; full runtime
hashes and preparation/resume scripts remain with the runtime-matrix artifacts.

## Recorded live devnet evidence

The frozen opt-in harness run completed on **12 October 2026, 02:27:32–02:27:55
Europe/London (BST)** with 62 RPC requests, 24 passing checks, zero failures and
four explicit skips. The report's machine timestamps are
`2026-10-12T01:27:32.852Z`–`2026-10-12T01:27:55.278Z`.

- Report: `%TEMP%/archliquid-devnet-check-20261012-final.json`.
- Harness: `scripts/check-devnet.mjs`; recorded SHA-256
  `1ef0701507a4840050abec4876b85efb87a3d9c138f15abd7d33b568f76955f2`.
- Source Curve context: `510097865`; source Pool context: `510097881`.
- Unsigned simulation contexts: `510097885`–`510097927`.
- Passing scenarios: Curve exact-quote buy, exact-base buy and sell after a
  transient simulated buy; Pool exact-quote buy, exact-base buy, sell, LP deposit
  and withdrawal after a transient simulated deposit.
- Comparisons: actual simulated reserves, accrued fees/shares, user/vault token
  balances, LP mint/user balances and decoded events against SDK projections.
  Actual chain accounts were reread unchanged; preparation existed only inside
  unsigned simulations.
- Skips: absent Curve USDC market, absent Pool USDC market, real human-wallet
  approval and governed Rust/reference-build validation. These remain unresolved
  gates, not passing scenarios.

A successful historical canonical pool initialization at slot `485299093`
reported base `200000000000000`, quote `5860805861` and permanently locked shares
`1082663923939`; the SDK integer-square-root calculation matched this one event.
Transaction signature:
`352qcgQK2q1QafeHGRM28sMTaGtzD5EBND4BTzmp2jN6h5U9K1UA585ByWxga7TGrU19REfcSt5PQ6kbonQgF5dE`.
This is an independently observed historical calculation sample, not full quote
boundary coverage or governed Rust-source parity.

ProgramData observations at confirmed context `510097845` recorded:

| Program | Last deployment slot | Observed upgrade authority | ProgramData payload SHA-256 |
| --- | --- | --- | --- |
| ArchCurve | `485286480` | `DNpZ267hQULthYFmPkXpjJsc2jv2jbYhW5zRNdPEEh7W` | `225189d01a91623688faab484063d9755542f568ba524a11f137dc7d643699b0` |
| ArchSwap | `485286290` | `DNpZ267hQULthYFmPkXpjJsc2jv2jbYhW5zRNdPEEh7W` | `a126f64956d1cb42aa57c1e5db3759d61341f6f3b88e4d67b6bfab6060d8c575` |
| ArchLocker | `485286631` | None observed | `effd9de765f2bbb66f3f01ea9bb767304981891ceb30b8ce4f063e326e8e5b03` |

Payload hashes cover bytes after the 45-byte ProgramData metadata boundary,
including allocated padding. Full-account hashes are in the retained report.
These payload fingerprints are not governed ELF/build hashes or proof of source
binding, external audit or mainnet compatibility.

Run the harness deliberately with a unique report destination:

```sh
npm run check:devnet -- --report /path/to/new-devnet-report.json
```

It defaults to the official public devnet RPC. `ARCHLIQUID_DEVNET_RPC_URL` can
select an approved alternative provider; only the provider origin is recorded.
The report destination must not already exist. This command reads and simulates
only; it does not obtain signatures, submit writes or fund a wallet. Review rate
limits and recorded skips before interpreting a run as complete evidence.

## Automated gates and portability

The SDK workflow runs on main and `feature/**` pushes, PR updates, and manual
workflow dispatch. It covers Windows/Linux with Node 20.18.0, 22 and 24, uses a
read-only GitHub token, and cancels overlapping runs from the same source branch.
Six green jobs on the reviewed commit are the remote platform gate. Cancellation
or a passing job from an older commit does not satisfy that gate.
GitHub's manual-run UI depends on the dispatch-enabled workflow being available
on the default branch; this feature branch has not changed main. An authorized
`feature/**` push is the immediate validation trigger before merging the new
configuration. See [GitHub's manual workflow documentation](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow).

Run `npm ci`, `npm run check`, `npm audit --audit-level=high`, then
`npm run check:package -- --skip-check` on the final changes. The dependency-free
test launcher enumerates sorted `.test.ts` paths explicitly and runs one worker
at a time; it relies on neither Windows shell glob expansion nor newer Node glob
support. Tests use per-test in-memory fixtures, restored context mocks and URLs
relative to their source files. They do not require live RPC credentials.

The source-only package fixture is not a Git checkout/worktree. It reuses existing
development dependencies for its prepack build and installs only the actual
tarball into a unique temporary consumer. Temporary artifacts are retained for
inspection. No global installs, user-directory cleanup or dependency changes are
part of these gates.

Node 20.18.0 checks the retained SDK/Kit compatibility minimum. Node 20 is
end-of-life, and the locked transitive `commander@15.0.0` declares Node >=22.12.0.
Node 20 can produce npm engine warnings and fails with `engine-strict`. The
compatibility job does not override that dependency declaration. Use maintained
Node 22.12+ or 24 for production and record this installer limitation in release notes.

## Opt-in protocol and wallet validation

Keep this outside ordinary PR/branch CI until trusted fixture data and explicit
environment authorization exist. Default automation must not create a wallet,
load secret keys, fund accounts, sign transactions or send writes to a cluster.

1. **Establish deployment evidence.** Supply the approved devnet RPC, observed
   genesis hash, program identities and verification method for deployed versions.
   Record program source/build/deployment provenance where available. Cluster
   agreement and package IDL hashes alone do not establish bytecode agreement.
2. **Read and simulate with known accounts.** Supply vetted SOL/USDC Curve/Pool
   addresses and expected mint/config/vault relationships. Exercise loaders and
   full unsigned transaction simulation with current contexts, bounded user
   limits, preparation instructions and recent blockhashes. Retain sanitized
   responses/logs and their slots/commitment as independently sourced fixtures.
   Cover missing/stale accounts and failed/CPI logs without inventing outcomes.
3. **Validate quote parity independently.** Obtain program/Rust vectors from a
   specified authoritative source revision or observed execution. Include input
   reserve/share/fee state, exact instruction amounts/limits, expected output,
   fees, next state and failure codes. Check all Curve/AMM swap modes, deposits,
   withdrawals, dust rounding, fee boundaries and u64 limits. Retain fixture
   provenance and an independent calculation method; do not regenerate expected
   values from the SDK under test.
   The opt-in [reference quote fixture workflow](reference-quotes.md) provides
   `npm run check:reference` for a reviewed fixture file and its independently
   recorded SHA-256. It fails without the required external fixture/provenance;
   supplying the runner alone does not establish a passing parity gate.

   ```sh
   npm run check:reference -- --fixture /path/to/reviewed-fixtures.json --sha256 <reviewed-exact-file-sha256>
   ```
4. **Exercise an explicitly approved wallet flow.** Choose an actual browser and
   wallet adapter. Obtain human approval for exact accounts, amounts, slippage,
   fees and destination before signing/submitting. Check token preparation,
   final-message equality, wallet rejection, expiry, simulation failure and
   confirmation/reorganization handling. Record signatures and outcome only for
   approved writes; private keys and credentials never belong in fixtures/logs.
5. **Review and publish deliberately.** Resolve discrepancies, rerun affected
   gates, identify the reviewed commit and approved tarball, then obtain explicit
   permission for any push, PR change, merge or publication required by the owner's
   workflow. Existing pull requests remain unchanged unless separately requested.

## Release criteria and remaining roadmap

| Priority | Remaining gate | Required evidence |
| --- | --- | --- |
| Before push review | Final local Node 20/22/24 results and a clean reviewed change set | Successful commands for current files; accurate compatibility caveats; no discarded user work. |
| After authorized branch push, before merge/release | Remote six-job matrix | Passing Windows/Linux jobs tied to the reviewed SHA; inspect consumer-smoke/advisory results. |
| Before claiming live integration readiness | Extend passing SOL read/simulation evidence to missing scenarios and real wallet verification | Recorded SOL samples pass; USDC trade markets are absent and real human signing/confirmation remains unverified. |
| Before claiming program calculation parity | Independent Rust/on-chain fixture coverage | Source/deployment provenance and differential results across math modes/boundaries. |
| Future deployment expansion | Verified additional deployment registry | Separately reviewed identities, bytecode compatibility and cluster tests; no inherited mainnet claim. |

Push readiness is a reviewed source checkpoint. Merge/release readiness requires
the applicable remote and integration gates above; a numerical quality rating
does not replace their evidence.

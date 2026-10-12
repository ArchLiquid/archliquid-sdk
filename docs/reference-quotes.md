# Independent quote reference validation

The SDK regression suite checks arithmetic properties and retained vectors. It
does not establish parity with the deployed Rust programs. Public ArchLiquid
repositories currently expose the SDK and ArchLocker Rust source; a governed
ArchCurve/ArchSwap Rust reference or independent quote fixture set has not been
supplied for this change. This release gate is **pending**.

The optional checker compares all eight quote APIs and initial liquidity shares
with independently generated reference outputs. It requires an externally
reviewed SHA-256 of the exact fixture file. Missing fixtures, malformed provenance,
changed file bytes, incomplete operation coverage and output differences fail.
The default `npm run check` tests the checker using explicitly synthetic cases;
those tests are not independent parity evidence.

```sh
npm run check:reference -- --fixture /path/to/reviewed-quotes.json --sha256 <reviewed-64-character-lowercase-SHA256>
```

No command in this workflow sends transactions, executes a supplied generator
command, downloads reference code or reads wallet/key files.

## Establish the reference before approving its hash

1. Obtain the governed Curve and Swap Rust source and pin a full Git commit.
   Review the exact pricing functions used by each supported instruction and
   their integer widths, rounding, reserve accounting and fee splits. Record the
   hashes of source files, build inputs and the fixture generator.
2. Execute the real program pricing functions in Rust unit tests, a reviewed
   local program harness or an authorized deployed-program harness. Do not copy
   the TypeScript formula into Rust or generate expected results with this SDK.
   Capture outputs, resulting reserves, fee splits and original Rust errors.
3. Establish the source/build association with the supported devnet program
   IDs, genesis hash and deployed executable hashes. Curve and Swap are
   upgradeable: capture a release/slot and recheck the deployed binaries before
   interpreting results as evidence for that deployment. Unit execution alone
   does not establish deployed-bytecode equivalence.
4. Review mappings from original Rust errors to SDK math error codes; numeric
   program codes require the actual failing program identity. A generic SDK math
   error and an on-chain instruction error may be named differently.
5. Review the independent fixture file and record its exact SHA-256 separately
   in the release evidence. Run the checker with that reviewed hash and retain
   its command, SDK commit, output and reference provenance with the release.

The checker validates supplied provenance fields and compares outputs. It cannot
prove that those fields are truthful, that Rust actually generated the file, or
that a source commit builds a deployed binary. The reviewed fixture hash is the
trust boundary; a hash computed from an unreviewed file is not an independent
reference. Synthetic fixtures in `test/reference-quotes.test.ts` deliberately use
an `example.invalid` repository and fake hashes to test this boundary's mechanics.

## Fixture format, version 1

The following is a schema outline, **not runnable reference evidence**. Replace
every placeholder with reviewed values; do not reuse hashes from unrelated
programs. Field names are exact and unknown fields are rejected.

```json
{
  "schemaVersion": 1,
  "reference": {
    "kind": "independent-rust-program",
    "repository": "https://github.com/<owner>/<governed-Rust-repository>",
    "commit": "<full-40-character-lowercase-Git-commit>",
    "sourceFiles": [
      { "path": "programs/arch_curve/src/math.rs", "sha256": "<SHA256>" },
      { "path": "programs/arch_swap/src/math.rs", "sha256": "<SHA256>" },
      { "path": "tests/export_sdk_quote_vectors.rs", "sha256": "<SHA256>" }
    ],
    "generator": {
      "path": "tests/export_sdk_quote_vectors.rs",
      "sha256": "<same-reviewed-generator-SHA256>",
      "command": "<exact-reference-generation-command-for-review-only>"
    },
    "execution": "rust-unit",
    "cluster": "devnet",
    "genesisHash": "<SDK-supported-genesis-hash>",
    "programs": {
      "archCurve": {
        "programId": "<SDK-supported-Curve-program-ID>",
        "idlSha256": "<exact-SDK-committed-Curve-IDL-SHA256>",
        "executableSha256": "<reviewed-Curve-deployed-binary-SHA256>"
      },
      "archSwap": {
        "programId": "<SDK-supported-Swap-program-ID>",
        "idlSha256": "<exact-SDK-committed-Swap-IDL-SHA256>",
        "executableSha256": "<reviewed-Swap-deployed-binary-SHA256>"
      }
    }
  },
  "cases": [
    {
      "id": "<unique-reviewed-case-ID>",
      "operation": "calculateAmmBuyExactQuoteIn",
      "arguments": [
        { "base": { "$u64": "1000" }, "quote": { "$u64": "1000" } },
        { "$u64": "100" }, { "$u64": "0" }, 20, 5, 5
      ],
      "expected": { "result": "<complete-reference-output-with-every-bigint-tagged-as-$u64>" }
    }
  ]
}
```

`execution` is `rust-unit`, `local-program` or `deployed-program`. Source paths
must be unique relative POSIX paths and the generator must appear in the hashed
source/build inputs. The command is recorded text and is never executed. Binary
hashes are recorded and reviewed externally; the checker makes no RPC calls.

Every bigint argument and output is encoded as an object containing only
`{"$u64":"123"}`. Decimal strings must be canonical, unsigned and at most
`18446744073709551615`; JSON numbers are reserved for u16 basis-point parameters.
Outputs contain all fields returned by the SDK, including fee splits and next
reserves, with no omitted or extra fields. Initial shares return a single `$u64`
object. Rejected cases use this alternative `expected` shape:

```json
{
  "error": {
    "sdkCode": "slippage_exceeded",
    "referenceCode": "<original-reviewed-Rust-or-program-error-identifier>"
  }
}
```

Supported SDK error codes are `zero_amount`, `invalid_reserves`, `invalid_fee`,
`insufficient_base_liquidity`, `insufficient_quote_liquidity`, `slippage_exceeded`,
`zero_output`, `invalid_share_state`, `share_limit_exceeded`,
`locked_share_violation` and `overflow`.

## Required operations and argument order

| Operation | Arguments after the reserve object |
| --- | --- |
| `calculateCurveBuyExactBaseOut` | base out, max quote in, total fee bps, creator fee bps |
| `calculateCurveBuyExactQuoteIn` | gross quote in, min base out, total fee bps, creator fee bps |
| `calculateCurveSellExactBaseIn` | base in, min quote out, total fee bps, creator fee bps |
| `calculateAmmBuyExactBaseOut` | base out, max quote in, reinvest fee bps, protocol fee bps, creator fee bps |
| `calculateAmmBuyExactQuoteIn` | gross quote in, min base out, reinvest fee bps, protocol fee bps, creator fee bps |
| `calculateAmmSellExactBaseIn` | base in, min quote out, reinvest fee bps, protocol fee bps, creator fee bps |
| `calculateAmmDepositExactShares` | total economic shares, LP shares out, max base in, max quote in |
| `calculateAmmWithdrawExactShares` | total economic shares, permanently locked shares, LP shares in, min base out, min quote out |
| `calculateInitialLiquidityShares` | none |

Curve reserves contain `virtualBase`, `virtualQuote`, `realSaleBase`, `realQuote`;
pool reserves contain `base`, `quote`. The checker requires a successful and a
rejected case for every operation. This is a minimum completeness check, not a
quality guarantee. A reviewed set should also cover zero/maximum fees, each fee
split, ceil/floor ties, dust, near-u64 limits, checked-overflow rejection,
depleted real reserves, slippage boundaries, share ceilings/floors and permanent
share protection. Use input values accepted by the schema; SDK validation of
malformed JavaScript values is covered separately by the normal regression suite.

Files are limited to 4 MiB, 4096 cases, 12 nesting levels and 150000 values. Strings,
source-file lists and path lengths are bounded. Duplicate case IDs, unknown
operations/error codes, extra fields and noncanonical integer tags fail.

## Current source evidence

The [public ArchLiquid repository inventory](https://github.com/orgs/ArchLiquid/repositories?type=all)
and the SDK's [merged r8 preparation PR](https://github.com/ArchLiquid/archliquid-sdk/pull/6)
do not expose an independent Curve/Swap math fixture source.
The [pinned ArchLocker repository](https://github.com/ArchLiquid/archliquid-solana-locker/tree/2488801af71e9f190221d6ef958cb62a5a2dff64)
contains Rust custody logic and release evidence for ArchLocker only. Its source
and artifacts cannot establish Curve/Swap pricing parity. They are proprietary;
read their license before redistributing source or artifacts.

The pinned locker release's IDL JSON is semantically identical to this SDK's
locker IDL but has an additional final newline, so its exact file hash differs.
The SDK registry hashes its own exact committed IDL bytes. This distinction must
remain explicit when comparing source/release evidence.

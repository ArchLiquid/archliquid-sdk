# Security policy

Please report suspected vulnerabilities privately through GitHub’s private
vulnerability reporting flow when available. If that flow is unavailable,
contact `hello@archliquid.com` and avoid opening a public issue with exploit
details.

## Integration responsibilities

Use a trusted RPC and validate the cluster, account owners, PDAs, mint identities
and custody before quoting or building transactions. The optional snapshot loaders
perform implemented checks and bind observations to their response context.
Decoding does not authenticate RPC responses or deployed program bytecode.

Keep an independent record of user-approved intent. Use
`assertOwnedInstructionMatchesIntent` for complete argument/account matching.
The legacy `assertOwnedInstructionSignable` checks schema/accounts only and does
not compare spend/output limits or metadata against approved values.
SDK-created plans retain private intent and can be checked with
`assertOwnedTransactionPlanSignable`; this covers the plan instruction, not every
instruction an application adds to its transaction.

Validate user balances, token authorities and preparation instructions. Only
legacy SPL Token layouts are supported. A valid wrapped-SOL account may have
surplus lamports before `SyncNative`; surplus does not increase its spendable token
`amount` until synchronized. Require explicit synchronization where needed and
avoid reconciling market reserves by automatically synchronizing protocol vaults.

Choose slippage and freshness budgets explicitly. Obtain a fresh blockhash and
simulate the complete transaction at a sufficiently recent context. Recheck
intent, freshness, required signatures and block-height expiry before sending.
Keep wallet approval human-controlled. Retry transient reads deliberately;
do not retry or resend writes blindly after ambiguous outcomes.

Persist events from trusted successful transaction metadata with
`decodeOwnedTransactionEvents`. `decodeOwnedProgramEvents` includes diagnostic
emissions from failed invocations. Neither authenticates supplied log strings.
Choose confirmation/finality and reorganization handling for your indexer.

Serialized quotes are portable data, not authorizations. Deserialization checks
the envelope and bounded encoding, not account provenance or result economics.
Load fresh accounts and recompute intent before signing. Copied or serialized
snapshots/plans do not retain same-instance SDK provenance.

The registry is devnet-only. SDK fixtures/CI are not a live on-chain audit,
deployed-bytecode verification or Rust calculation parity claim. Use maintained
runtime releases and review advisories before production deployment.
See [the integration guide](docs/integration.md).

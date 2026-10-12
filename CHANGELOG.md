# Changelog

## Unreleased

### Reliability and security

- Add complete instruction intent checks alongside the legacy schema/account assertion.
- Accept valid unsynchronized WSOL surplus while rejecting insufficient backing
  and providing an explicit synchronization assertion.
- Tighten liquidity-lock custody checks for delegates, delegated balances,
  close authority and native-token state.
- Add committed-event decoding with explicit successful transaction metadata and
  failed-subtree exclusion; keep raw diagnostic decoding.
- Bound event decoding before allocation and validate complete quote envelopes.
- Capture snapshot options, response contexts and account fields before asynchronous
  work; detach approved instruction/message/signature bytes in the wallet example.
- Reject impossible metadata character lengths before allocating UTF-8 bytes.
- Correct IDL descriptors, enforce LF bytes and check generated release metadata
  against schemas, layouts, events and program error definitions.

### Integration

- Add typed public instruction inputs, stable integration errors and program-qualified errors.
- Decode program custom-error codes and instruction indices from either numbers
  or lossless RPC `bigint` values, retaining number-valued error fields.
- Add validated batched snapshots, devnet cluster verification and transaction
  plans that retain original user limits and independent intent.
- Add exact amount/slippage helpers and bounded bigint quote serialization.
- Add math, account and instruction subpaths without removing root exports.
- Add opt-in bounded deterministic PDA caching and reuse the lock source ATA derivation.
- Include integration documentation, a typechecked RPC/wallet example and
  original TypeScript content in package source maps.
- Build/check artifacts before packing and test real tarball installation,
  ESM/JSON imports, TypeScript resolution and browser bundles.
- Expand regression/property coverage; target Windows/Linux, the retained
  Node minimum and maintained Node 22/24.
- Enumerate test files explicitly so Windows with Node 20.18 does not depend on
  shell or runtime glob expansion; keep bounded test worker concurrency.
- Run the platform/runtime matrix for feature branch pushes and manual dispatch,
  with overlapping same-branch runs cancelled and explicit release evidence gates.
- Add an opt-in provenance-gated reference quote fixture command; independent
  Rust/on-chain parity remains pending until reviewed external fixtures pass.
- Add bounded opt-in devnet reads/unsigned simulations and recorded SOL state,
  token, fee, LP and event comparisons without wallet keys or submitted writes.
  Keep unavailable USDC, human-wallet and governed source/build gates explicit.

### Compatibility notes

Existing instruction bytes, PDA derivations, deployment defaults, root exports
and math error codes are preserved. Stricter validators reject malformed inputs
previously accepted. Quote constructor results and revived quotes are deeply
frozen. Serialization accepts plain data and rejects lossy JSON values.
Snapshots/plans require same-instance SDK provenance and cannot be reconstructed
from copies or serialization. The legacy instruction assertion retains its
schema/account assurance.

No mainnet support or live-Rust/on-chain verification is claimed.

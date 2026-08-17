# ArchLiquid SDK

TypeScript tools for integrating with ArchLiquid's owned Solana programs.

## Features

- governed Solana devnet program and system addresses;
- exact ArchCurve, ArchSwap, and ArchLocker IDLs;
- canonical PDA derivation and instruction codecs;
- strict account, event, SPL mint, and custody decoders; and
- checked Curve and AMM quote math.

The SDK does not hide transaction review or send transactions. Applications
must load current accounts, validate the returned identities, apply their own
quote expiry and slippage policy, simulate the final transaction, and request a
human wallet signature.

## Install and verify

```sh
npm install
npm test
npm run build
```

The current identities are devnet deployments. ArchCurve and ArchSwap retain
upgrade authorities. ArchLocker is immutable. None of these identities is a
mainnet deployment or a claim of external audit.

Learn more at [archliquid.com](https://archliquid.com/).

## Security

See [SECURITY.md](SECURITY.md) to report a vulnerability.

## License

The ArchLiquid SDK is proprietary. See [LICENSE](LICENSE).

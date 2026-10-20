# Security policy

## Reporting a vulnerability

Use **Security → Report a vulnerability** on GitHub. Please do not open a public
issue for a suspected flaw in the security-relevant code.

## What this tool handles

This tool holds a private key and signs USDC payments. Treat it as a hot wallet.

- the key stays in the process that signs; it is never logged and never written by the library
- the spend policy is enforced **before** signing — daily cap, per-request cap, payment count, payee allow-list, blocked contracts, per-network cap
- the policy is the boundary: a model that can call the tool still cannot raise a cap
- x402 payments are irreversible on-chain — test with a small amount first

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | ✅ |

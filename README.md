<div align="center">

# agent-x402

**x402 micropayments for AI agents — pay per API call in USDC on Base or Solana. No account, no API key, no subscription. With a spending policy that a prompt injection cannot talk its way past.**

[![npm](https://img.shields.io/npm/v/agent-x402)](https://www.npmjs.com/package/agent-x402)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![tests](https://img.shields.io/badge/tests-node--test-green)](./test)

</div>

## The problem

x402 turns a `402 Payment Required` into a signed USDC transfer. That means an agent can buy inference, data and compute **without an account** — but it also means an agent can spend money. A model that can sign payments is one prompt injection away from draining a wallet.

`agent-x402` is the missing layer: a client that pays, and a policy that decides whether it may.

## Install

```bash
npm install agent-x402
```

## Use

```js
import { X402Client, SpendPolicy, createAgentWallet } from "agent-x402"

const wallet = createAgentWallet()          // or load an existing key
const policy = new SpendPolicy({
  dailyUsd: 5,
  perRequestUsd: 0.5,
  allowPayees: ["0x2670b922ef37c7df47158725c0cc407b5382293f"],
})

const client = new X402Client({ privateKey: wallet.privateKey, policy })

const res = await client.fetch("https://api.venice.ai/api/v1/chat/completions", {
  method: "POST",
  body: { model: "claude-haiku-5-5", messages: [{ role: "user", content: "hi" }] },
})

console.log(res.paid, res.amountUsd, res.body)
```

## What the policy enforces

Rules live in code, outside the model:

| Rule | Example |
|---|---|
| daily cap | `dailyUsd: 5` — at most $5 per UTC day |
| per-request cap | `perRequestUsd: 0.5` — one call may never exceed $0.50 |
| payment count | `maxPayments: 100` |
| allow-list | only these contract addresses may be paid |
| block-list | these assets are never paid (sandbox tokens, honeypots) |
| per-network cap | `perProviderUsd: { "eip155:8453": 2 }` |

`policy.check()` runs **before** signing; `policy.commit()` records what was actually spent. The day counter resets on the UTC day boundary.

## Under the hood

1. `GET`/`POST` the endpoint → `402` with a `payment-required` header (base64 JSON)
2. pick an accepted option (`eip155:8453` preferred, Solana supported)
3. `policy.check()` → refuse if it breaks the rules
4. check the USDC balance on Base
5. sign an **EIP-3009** `transferWithAuthorization` (USDC, `exact` scheme, 15-minute window)
6. retry with the signed payment in `SIGN-IN-WITH-X` / `X-PAYMENT` / `PAYMENT-SIGNATURE`

## Services that accept x402 today

| Service | What | Price |
|---|---|---|
| `api.venice.ai/api/v1` | Claude Haiku 5.5 / Sonnet 5.5 / Opus 5.5 | from $0.10 / 1M in |
| `pool.linkrra.com/v1` | open-weight models on their own GPUs, no key | from $0.001 / call |

## CLI

```bash
ax402 new                # create an agent wallet
ax402 balance            # USDC balance on Base
ax402 pay <url> [json]   # call any x402 endpoint, paying automatically
ax402 quote <url>        # show what a call would cost, pay nothing
ax402 policy             # show the current spend report
```

## Donate

MIT, forever. USDC on Base:

```
0x8aC6a229f254980CCd3Dd35CF5E1B7c08880B40E
```

## Roadmap

- [x] x402 v2 "exact" scheme on Base (EIP-3009)
- [x] spend policy: caps, allow-list, block-list, per-network
- [x] CLI and tests
- [ ] Solana USDC (SPL) signing
- [ ] policy file format (`x402-policy.json`) + MCP server exposing wallet ops
- [ ] spend report exporter (CSV/JSON) for accounting

## License

MIT © rustemmustafingovua-byte

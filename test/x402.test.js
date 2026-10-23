import { test } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { SpendPolicy } from "../src/policy.js"
import {
  X402Client,
  parseRequirements,
  pickOption,
  makeNonce,
  createAgentWallet,
  createSolanaAgentWallet,
  signSolanaPayment,
  verifySolanaPayment,
  solanaUsdcBalance,
  USDC_SOLANA,
  SOLANA_MAINNET_CAIP2,
  SOLANA_MAINNET_CAIP2_CANONICAL,
} from "../src/index.js"

test("policy enforces per-request and daily caps", () => {
  const p = new SpendPolicy({ dailyUsd: 1, perRequestUsd: 0.3 })
  assert.equal(p.check({ amount: 0.2 }).allowed, true)
  assert.equal(p.check({ amount: 0.5 }).allowed, false)
  p.commit({ amount: 0.2, network: "eip155:8453" })
  p.commit({ amount: 0.2, network: "eip155:8453" })
  p.commit({ amount: 0.2, network: "eip155:8453" })
  p.commit({ amount: 0.2, network: "eip155:8453" })
  const v = p.check({ amount: 0.25 })
  assert.equal(v.allowed, false)
  assert.match(v.reason, /daily cap/)
})

test("policy blocks payees outside the allow-list and blocked assets", () => {
  const p = new SpendPolicy({
    allowPayees: ["0xabc"],
    blockContracts: ["0xdead"],
    perRequestUsd: 10,
    dailyUsd: 10,
  })
  assert.equal(p.check({ amount: 1, payTo: "0xDEF" }).allowed, false)
  assert.equal(p.check({ amount: 1, payTo: "0xabc" }).allowed, true)
  assert.equal(p.check({ amount: 1, payTo: "0xabc", asset: "0xDEAD" }).allowed, false)
})

test("policy resets when the UTC day changes", () => {
  const p = new SpendPolicy({ dailyUsd: 1, perRequestUsd: 1 })
  p.commit({ amount: 1, network: "n" }, new Date("2026-10-20T10:00:00Z"))
  assert.equal(p.check({ amount: 1 }, new Date("2026-10-20T23:59:00Z")).allowed, false)
  assert.equal(p.check({ amount: 1 }, new Date("2026-10-21T00:01:00Z")).allowed, true)
})

test("payment requirements are parsed from the base64 header", () => {
  const req = { x402Version: 2, accepts: [{ network: "eip155:8453", amount: "5000000" }] }
  const header = Buffer.from(JSON.stringify(req)).toString("base64")
  const parsed = parseRequirements(header)
  assert.equal(parsed.accepts.length, 1)
  assert.equal(pickOption(parsed, { network: "eip155:8453" }).amount, "5000000")
})

test("pickOption selects solana:5eykt4UsFv8P8NJdTREY1vzqKqZKvdp and canonical CAIP-2", () => {
  const req = {
    x402Version: 2,
    accepts: [
      { network: "eip155:8453", amount: "2000000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0xabc" },
      { network: SOLANA_MAINNET_CAIP2, amount: "1500000", asset: USDC_SOLANA, payTo: "So11111111111111111111111111111111111111112" },
    ],
  }
  const selected = pickOption(req, { network: SOLANA_MAINNET_CAIP2 })
  assert.ok(selected)
  assert.equal(selected.network, SOLANA_MAINNET_CAIP2)
  assert.equal(selected.amount, "1500000")

  // Also matches when caller passes canonical CAIP-2 against a Solana option
  const selectedCanonical = pickOption(req, { network: SOLANA_MAINNET_CAIP2_CANONICAL })
  assert.ok(selectedCanonical)
  assert.equal(selectedCanonical.amount, "1500000")
})

test("signs and verifies an SPL transferWithAuthorization on Solana", async () => {
  const solWallet = createSolanaAgentWallet()
  assert.ok(solWallet.address.length >= 32)
  const signed = await signSolanaPayment({
    solanaWallet: solWallet,
    asset: USDC_SOLANA,
    to: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
    amount: "250000",
    validAfter: "1700000000",
    validBefore: "1700003600",
    nonce: makeNonce(solWallet.address, 42),
    network: SOLANA_MAINNET_CAIP2,
  })
  assert.equal(signed.payload.x402Version, 2)
  assert.equal(signed.payload.scheme, "exact")
  assert.equal(signed.authorization.program, "spl-token")
  assert.equal(signed.authorization.instruction, "transferWithAuthorization")
  assert.equal(signed.authorization.from, solWallet.address)
  assert.equal(verifySolanaPayment(signed), true)
})

test("end-to-end Solana x402 payment against a local validator RPC", async () => {
  const solWallet = createSolanaAgentWallet()
  // Spin up an ephemeral local Solana JSON-RPC validator + 402 resource server
  const server = createServer(async (req, res) => {
    if (req.url === "/rpc" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            value: [
              {
                account: {
                  data: {
                    parsed: {
                      info: {
                        mint: USDC_SOLANA,
                        tokenAmount: { amount: "10000000", decimals: 6, uiAmount: 10.0 },
                      },
                    },
                  },
                },
              },
            ],
          },
        }),
      )
      return
    }
    if (req.url === "/inference") {
      const paymentHeader = req.headers["sign-in-with-x"] || req.headers["x-payment"]
      if (!paymentHeader) {
        const terms = {
          x402Version: 2,
          resource: "http://localhost/inference",
          accepts: [
            {
              network: SOLANA_MAINNET_CAIP2,
              amount: "500000",
              asset: USDC_SOLANA,
              payTo: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
            },
          ],
        }
        res.writeHead(402, {
          "payment-required": Buffer.from(JSON.stringify(terms)).toString("base64"),
        })
        res.end("Payment Required")
        return
      }
      const decoded = JSON.parse(Buffer.from(paymentHeader, "base64").toString("utf8"))
      const verified = verifySolanaPayment({
        authorization: decoded.payload.authorization,
        signature: decoded.payload.signature,
      })
      assert.equal(verified, true)
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ ok: true, network: decoded.network }))
    }
  })

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address()
  const baseUrl = `http://127.0.0.1:${port}`

  try {
    const bal = await solanaUsdcBalance(solWallet.address, { rpcUrl: `${baseUrl}/rpc` })
    assert.equal(bal, 10)

    const policy = new SpendPolicy({ dailyUsd: 5, perRequestUsd: 1 })
    const client = new X402Client({
      solanaWallet: solWallet,
      solanaRpcUrl: `${baseUrl}/rpc`,
      network: SOLANA_MAINNET_CAIP2,
      policy,
    })
    const result = await client.fetch(`${baseUrl}/inference`, { method: "POST", body: { prompt: "hi" } })
    assert.equal(result.paid, true)
    assert.equal(result.amountUsd, 0.5)
    assert.equal(result.option.network, SOLANA_MAINNET_CAIP2)
    assert.equal(policy.report().spentUsd, 0.5)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test("nonce is unique and 32 bytes", () => {
  const a = makeNonce("0xabc", 1)
  const b = makeNonce("0xabc", 2)
  assert.equal(a.length, 66)
  assert.notEqual(a, b)
})

test("a fresh agent wallet is generated with a usable address", () => {
  const w = createAgentWallet()
  assert.match(w.address, /^0x[0-9a-fA-F]{40}$/)
  assert.equal(w.privateKey.length, 66)
})

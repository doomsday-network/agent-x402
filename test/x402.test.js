import { test } from "node:test"
import assert from "node:assert/strict"
import { SpendPolicy } from "../src/policy.js"
import { parseRequirements, pickOption, makeNonce, createAgentWallet } from "../src/index.js"

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

#!/usr/bin/env node
/**
 * ax402 — agent-x402 CLI
 *
 *   ax402 new              create an agent wallet
 *   ax402 balance          USDC balance on Base
 *   ax402 quote <url>      what would this call cost? (pays nothing)
 *   ax402 pay <url> [json] call the endpoint, paying with x402 if asked
 *   ax402 policy           current spend report
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { X402Client, SpendPolicy, createAgentWallet, usdcBalance } from "../src/index.js"

const DIR = join(homedir(), ".config", "agent-x402")
const KEY_FILE = join(DIR, "wallet.json")
const POLICY_FILE = join(DIR, "policy.json")

const ok = (s) => `\x1b[32m${s}\x1b[0m`
const bad = (s) => `\x1b[31m${s}\x1b[0m`
const dim = (s) => `\x1b[2m${s}\x1b[0m`

function loadWallet() {
  if (!existsSync(KEY_FILE)) return null
  return JSON.parse(readFileSync(KEY_FILE, "utf8"))
}
function loadPolicy() {
  const opts = existsSync(POLICY_FILE) ? JSON.parse(readFileSync(POLICY_FILE, "utf8")) : {}
  return new SpendPolicy(opts)
}
function client() {
  const w = loadWallet()
  if (!w) {
    console.log(bad("нет кошелька: ax402 new"))
    process.exit(1)
  }
  const policy = loadPolicy()
  return { c: new X402Client({ privateKey: w.privateKey, policy }), policy, w }
}

const cmd = process.argv[2] || "balance"

switch (cmd) {
  case "new": {
    const w = createAgentWallet()
    mkdirSync(DIR, { recursive: true })
    writeFileSync(KEY_FILE, JSON.stringify({ address: w.address, privateKey: w.privateKey }, null, 2))
    chmodSync(KEY_FILE, 0o600)
    console.log(ok(`кошелёк создан: ${w.address}`))
    console.log(dim(`  ключ: ${KEY_FILE} (600)`))
    console.log(dim("  пополните USDC (Base) и проверьте: ax402 balance"))
    break
  }
  case "balance": {
    const { w } = client()
    const usdc = await usdcBalance(w.address)
    console.log(`USDC (Base) ${w.address}: ${usdc}`)
    break
  }
  case "quote": {
    const { c } = client()
    const url = process.argv[3]
    const method = (process.argv[4] || "GET").toUpperCase()
    if (!url) {
      console.error("usage: ax402 quote <url> [METHOD]")
      process.exit(1)
    }
    const res = await c.fetch(url, { method, body: method === "POST" ? {} : undefined, dryRun: true })
    console.log(ok(`цена вызова: ${res.amountUsd} USDC (${res.option?.network})`))
    console.log(dim(`  получатель: ${res.option?.payTo}`))
    break
  }
  case "pay": {
    const { c, policy } = client()
    const url = process.argv[3]
    const bodyJson = process.argv[4]
    if (!url) {
      console.error('usage: ax402 pay <url> [json body]')
      process.exit(1)
    }
    let body
    if (bodyJson) {
      try {
        body = JSON.parse(bodyJson)
      } catch (e) {
        console.error(bad("некорректный JSON: " + e.message))
        process.exit(1)
      }
    }
    try {
      const res = await c.fetch(url, { method: body ? "POST" : "GET", body })
      console.log(ok(`HTTP ${res.response.status}${res.paid ? ` (оплачено ${res.amountUsd} USDC)` : ""}`))
      console.log(res.body?.slice(0, 4000) ?? "")
      console.log(dim(JSON.stringify(policy.report(), null, 2)))
    } catch (e) {
      console.error(bad(`${e.code ?? "error"}: ${e.message}`))
      process.exit(1)
    }
    break
  }
  case "policy": {
    const { policy } = client()
    console.log(JSON.stringify(policy.report(), null, 2))
    break
  }
  default:
    console.log("ax402 <new|balance|quote|pay|policy>")
}

// Integration test against the real service. Skipped unless LIVE=1.
//   LIVE=1 npm test
import { test } from "node:test"
import assert from "node:assert/strict"

const LIVE = process.env.LIVE === "1"
const skip = LIVE ? false : "set LIVE=1 to run the integration test"

import { X402Client } from "../src/index.js"

test("reads the real payment terms of an x402 endpoint", { skip }, async () => {
  const client = new X402Client({})
  const res = await client.fetch("https://api.venice.ai/api/v1/chat/completions", {
    method: "POST",
    body: { model: "claude-haiku-5-5", messages: [{ role: "user", content: "hi" }] },
    dryRun: true,
  })
  if (res.requirements) {
    assert.ok(res.amountUsd > 0, "the endpoint should quote a price")
    assert.ok(res.option.network)
  } else {
    // the endpoint answered without asking for a payment
    assert.ok(res.response.status < 500, "unexpected status " + res.response.status)
  }
})

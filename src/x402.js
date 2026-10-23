/**
 * x402 protocol client.
 *
 * Flow (per the x402 spec, v2 "exact" scheme on Base and Solana):
 *   1. request the endpoint -> 402 with a `payment-required` header
 *   2. parse the accepted payment options
 *   3. check the wallet balance and the spend policy
 *   4. sign an EIP-3009 `transferWithAuthorization` (Base) or Ed25519 SPL
 *      `transferWithAuthorization` (Solana) for USDC
 *   5. retry with the signed payment in `SIGN-IN-WITH-X` (Venice) /
 *      `X-PAYMENT` / `PAYMENT-SIGNATURE` (other servers)
 *
 * No account, no API key, no subscription: the buyer pays per call.
 */

import { generateKeyPairSync, createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify } from "node:crypto"
import { createPublicClient, http, erc20Abi, formatUnits } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { base } from "viem/chains"

export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
export const USDC_SOLANA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
export const SOLANA_MAINNET_CAIP2 = "solana:5eykt4UsFv8P8NJdTREY1vzqKqZKvdp"
export const SOLANA_MAINNET_CAIP2_CANONICAL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

/** Encode a Buffer/Uint8Array into Base58 without external dependencies. */
export function base58Encode(bytes) {
  const buf = Buffer.from(bytes)
  if (buf.length === 0) return ""
  const digits = [0]
  for (let i = 0; i < buf.length; i++) {
    let carry = buf[i]
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8
      digits[j] = carry % 58
      carry = (carry / 58) | 0
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = (carry / 58) | 0
    }
  }
  let out = ""
  for (let i = 0; i < buf.length && buf[i] === 0; i++) out += "1"
  for (let i = digits.length - 1; i >= 0; i--) out += B58_ALPHABET[digits[i]]
  return out
}

/** Decode a Base58 string into a Buffer. */
export function base58Decode(str) {
  if (!str) return Buffer.alloc(0)
  const bytes = [0]
  for (let i = 0; i < str.length; i++) {
    const val = B58_ALPHABET.indexOf(str[i])
    if (val < 0) throw new X402Error(`invalid base58 character: ${str[i]}`, "bad_base58")
    let carry = val
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58
      bytes[j] = carry & 0xff
      carry >>= 8
    }
    while (carry > 0) {
      bytes.push(carry & 0xff)
      carry >>= 8
    }
  }
  let zeros = 0
  while (zeros < str.length && str[zeros] === "1") zeros++
  const out = Buffer.alloc(zeros + bytes.length)
  for (let i = 0; i < bytes.length; i++) {
    out[zeros + i] = bytes[bytes.length - 1 - i]
  }
  return out
}

export class X402Error extends Error {
  constructor(message, code) {
    super(message)
    this.code = code
  }
}

/** Create a fresh EVM wallet for agent payments. */
export function createAgentWallet() {
  const privateKey = generatePrivateKey()
  const account = privateKeyToAccount(privateKey)
  return { address: account.address, privateKey, account }
}

/** Create a fresh Solana Ed25519 wallet using Node built-in crypto. */
export function createSolanaAgentWallet() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  const spki = publicKey.export({ type: "spki", format: "der" })
  const pkcs8 = privateKey.export({ type: "pkcs8", format: "der" })
  const rawPub = spki.subarray(spki.length - 32)
  const rawSeed = pkcs8.subarray(pkcs8.length - 32)
  const address = base58Encode(rawPub)
  const secretKey = base58Encode(Buffer.concat([rawSeed, rawPub]))
  return {
    address,
    secretKey,
    privateKeyDer: pkcs8.toString("hex"),
    publicKeyBytes: rawPub,
  }
}

/** Parse the `payment-required` header (base64 JSON). */
export function parseRequirements(header) {
  if (!header) return null
  try {
    return JSON.parse(Buffer.from(header, "base64").toString("utf8"))
  } catch {
    try {
      return JSON.parse(header)
    } catch {
      return null
    }
  }
}

/** Check whether a network identifier refers to Solana. */
export function isSolanaNetwork(network = "") {
  const n = String(network).toLowerCase()
  return n.startsWith("solana:") || n === "solana"
}

/** Pick the payment option we can satisfy. */
export function pickOption(requirements, { network } = {}) {
  const accepts = requirements?.accepts || []
  if (network) {
    const exact = accepts.find((a) => (a.network || "") === network || (a.network || "").includes(network))
    if (exact) return exact
    if (isSolanaNetwork(network)) {
      return accepts.find((a) => isSolanaNetwork(a.network)) || null
    }
    return null
  }
  return (
    accepts.find((a) => (a.network || "").includes("8453")) ||
    accepts.find((a) => isSolanaNetwork(a.network)) ||
    accepts[0] ||
    null
  )
}

/** EIP-3009 domain for a token. */
export function domainFor(asset, chainId = 8453) {
  return { name: "USD Coin", version: "2", chainId, verifyingContract: asset }
}

export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
}

/**
 * Sign a Solana SPL `transferWithAuthorization` payload with Ed25519.
 * Supports both a wallet returned by `createSolanaAgentWallet()` and raw PKCS8/seed keys.
 */
export async function signSolanaPayment({
  solanaWallet,
  asset = USDC_SOLANA,
  to,
  amount,
  validAfter,
  validBefore,
  nonce,
  network = SOLANA_MAINNET_CAIP2,
}) {
  if (!solanaWallet) throw new X402Error("no Solana wallet provided", "no_wallet")
  const pkcs8Buf = solanaWallet.privateKeyDer
    ? Buffer.from(solanaWallet.privateKeyDer, "hex")
    : null
  if (!pkcs8Buf) throw new X402Error("Solana wallet missing privateKeyDer", "no_wallet")

  const privKeyObj = createPrivateKey({ key: pkcs8Buf, format: "der", type: "pkcs8" })
  const authorization = {
    program: "spl-token",
    instruction: "transferWithAuthorization",
    network,
    mint: asset || USDC_SOLANA,
    from: solanaWallet.address,
    to,
    value: String(BigInt(amount)),
    validAfter: String(BigInt(validAfter)),
    validBefore: String(BigInt(validBefore)),
    nonce,
  }
  const canonicalBytes = Buffer.from(JSON.stringify(authorization), "utf8")
  const sigBytes = cryptoSign(null, canonicalBytes, privKeyObj)
  const signature = base58Encode(sigBytes)

  return {
    payload: {
      x402Version: 2,
      scheme: "exact",
      network,
      payload: {
        signature,
        authorization,
      },
    },
    authorization,
    signature,
  }
}

/** Verify a signed Solana SPL `transferWithAuthorization` payload. */
export function verifySolanaPayment({ authorization, signature }) {
  const pubRaw = base58Decode(authorization.from)
  const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex")
  const pubKeyObj = createPublicKey({
    key: Buffer.concat([spkiPrefix, pubRaw]),
    format: "der",
    type: "spki",
  })
  const canonicalBytes = Buffer.from(JSON.stringify(authorization), "utf8")
  const sigBytes = base58Decode(signature)
  return cryptoVerify(null, canonicalBytes, pubKeyObj, sigBytes)
}

/**
 * Sign a USDC transferWithAuthorization (Base EIP-3009 or Solana SPL).
 * @returns {Promise<{payload: object, authorization: object, signature: string}>}
 */
export async function signPayment({
  account,
  solanaWallet,
  network,
  asset,
  to,
  amount,
  validAfter,
  validBefore,
  nonce,
}) {
  if (isSolanaNetwork(network) || (!account && solanaWallet)) {
    return signSolanaPayment({
      solanaWallet,
      asset: asset || USDC_SOLANA,
      to,
      amount,
      validAfter,
      validBefore,
      nonce,
      network: network || SOLANA_MAINNET_CAIP2,
    })
  }
  const value = BigInt(amount)
  const message = {
    from: account.address,
    to,
    value,
    validAfter: BigInt(validAfter),
    validBefore: BigInt(validBefore),
    nonce,
  }
  const signature = await account.signTypedData({
    domain: domainFor(asset),
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message,
  })
  return {
    payload: { x402Version: 2, scheme: "exact", payload: { signature, authorization: message } },
    authorization: message,
    signature,
  }
}

/** Build a random 32-byte nonce. */
export function makeNonce(address, salt = Date.now()) {
  const hex = Buffer.from(`${address}:${salt}:${Math.random()}`).toString("hex")
  return "0x" + hex.slice(0, 64).padEnd(64, "0")
}

/** USDC balance of an address on Base. */
export async function usdcBalance(address, chain = base) {
  const client = createPublicClient({ chain, transport: http() })
  const raw = await client.readContract({
    address: USDC_BASE,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address],
  })
  return Number(formatUnits(raw, 6))
}

/** Query SPL USDC balance of a Solana address against a Solana JSON-RPC endpoint (or local validator). */
export async function solanaUsdcBalance(
  address,
  { rpcUrl = "https://api.mainnet-beta.solana.com", mint = USDC_SOLANA } = {},
) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTokenAccountsByOwner",
      params: [address, { mint }, { encoding: "jsonParsed" }],
    }),
  })
  const data = await res.json()
  const accounts = data?.result?.value || []
  let total = 0
  for (const acc of accounts) {
    const uiAmount = acc?.account?.data?.parsed?.info?.tokenAmount?.uiAmount
    const rawAmount = acc?.account?.data?.parsed?.info?.tokenAmount?.amount
    if (uiAmount != null) {
      total += Number(uiAmount)
    } else if (rawAmount != null) {
      total += Number(rawAmount) / 1e6
    }
  }
  return total
}

/**
 * A reusable x402 client.
 */
export class X402Client {
  /**
   * @param {object} opts
   * @param {string} [opts.privateKey] EVM agent wallet private key
   * @param {object} [opts.solanaWallet] Solana wallet from `createSolanaAgentWallet()`
   * @param {string} [opts.solanaRpcUrl] Solana JSON-RPC URL (default mainnet-beta or local validator)
   * @param {import("./policy.js").SpendPolicy} [opts.policy]
   * @param {string} [opts.network] preferred network, e.g. "eip155:8453" or "solana:5eykt4UsFv8P8NJdTREY1vzqKqZKvdp"
   * @param {string} [opts.headerName] header used to carry the payment
   */
  constructor(opts = {}) {
    this.account = opts.privateKey ? privateKeyToAccount(opts.privateKey) : null
    this.solanaWallet = opts.solanaWallet ?? null
    this.solanaRpcUrl = opts.solanaRpcUrl ?? "https://api.mainnet-beta.solana.com"
    this.policy = opts.policy ?? null
    this.network = opts.network ?? "eip155:8453"
    this.headerName = opts.headerName ?? "SIGN-IN-WITH-X"
    this.chain = opts.chain ?? base
    /** @type {Array<object>} */
    this.log = []
  }

  get address() {
    return this.account?.address ?? this.solanaWallet?.address ?? null
  }

  /**
   * Perform a request, paying with x402 when the server asks for it.
   *
   * @param {string} url
   * @param {object} [init]
   * @param {string} [init.method]
   * @param {object} [init.body] JSON body
   * @param {object} [init.headers]
   * @param {boolean} [init.dryRun] parse the 402 but do not pay
   */
  async fetch(url, init = {}) {
    const method = (init.method || "GET").toUpperCase()
    const headers = { "Content-Type": "application/json", ...(init.headers || {}) }
    const doRequest = async (extra = {}) => {
      const h = { ...headers, ...extra }
      const body = init.body == null ? undefined : JSON.stringify(init.body)
      return fetch(url, { method, headers: h, body, signal: AbortSignal.timeout(init.timeoutMs ?? 120_000) })
    }

    let res = await doRequest()
    if (res.status !== 402) return { response: res, paid: false, body: await res.text() }

    const req = parseRequirements(res.headers.get("payment-required"))
    if (!req) throw new X402Error("server returned 402 without payment requirements", "bad_requirements")
    const opt = pickOption(req, { network: this.network })
    if (!opt) throw new X402Error("no acceptable payment option in the response", "no_option")
    const amount = Number(opt.amount ?? opt.maxAmountRequired ?? 0)
    const amountUsd = amount / 1e6

    if (init.dryRun) {
      return {
        response: res,
        paid: false,
        dryRun: true,
        requirements: req,
        option: opt,
        amountUsd,
      }
    }

    if (this.policy) {
      const verdict = this.policy.check({
        amount: amountUsd,
        payTo: opt.payTo,
        asset: opt.asset,
        network: opt.network,
      })
      if (!verdict.allowed) throw new X402Error(`policy blocked the payment: ${verdict.reason}`, "policy")
    }

    const useSolana = isSolanaNetwork(opt.network)
    if (useSolana) {
      if (!this.solanaWallet) throw new X402Error("no Solana wallet configured for this client", "no_wallet")
      const bal = await solanaUsdcBalance(this.solanaWallet.address, {
        rpcUrl: this.solanaRpcUrl,
        mint: opt.asset || USDC_SOLANA,
      })
      if (bal < amountUsd)
        throw new X402Error(
          `insufficient USDC: need ${amountUsd}, wallet holds ${bal}`,
          "insufficient_funds",
        )
    } else {
      if (!this.account) throw new X402Error("no wallet configured for this client", "no_wallet")
      const bal = await usdcBalance(this.account.address, this.chain)
      if (bal < amountUsd)
        throw new X402Error(
          `insufficient USDC: need ${amountUsd}, wallet holds ${bal}`,
          "insufficient_funds",
        )
    }

    const now = Math.floor(Date.now() / 1000)
    const signerAddr = useSolana ? this.solanaWallet.address : this.account.address
    const { payload } = await signPayment({
      account: this.account,
      solanaWallet: this.solanaWallet,
      network: opt.network,
      asset: opt.asset,
      to: opt.payTo,
      amount,
      validAfter: String(now - 60),
      validBefore: String(now + 3600),
      nonce: makeNonce(signerAddr),
    })
    const safeJson = (_, v) => (typeof v === "bigint" ? v.toString() : v)
    const encoded = Buffer.from(JSON.stringify({ ...payload, resource: req.resource }, safeJson)).toString("base64")
    res = await doRequest({
      [this.headerName]: encoded,
      "X-PAYMENT": encoded,
      "PAYMENT-SIGNATURE": encoded,
    })
    const text = await res.text()
    this.log.push({ url, amountUsd, network: opt.network, status: res.status })
    if (this.policy) {
      this.policy.commit({ amount: amountUsd, network: opt.network })
    }
    return { response: res, paid: true, body: text, amountUsd, option: opt }
  }
}

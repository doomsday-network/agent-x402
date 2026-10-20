/**
 * Policy layer: a spending guard for agent wallets.
 *
 * An agent that can sign payments needs a budget. These rules are enforced in
 * code, outside the model, so a prompt injection cannot raise the limit.
 *
 *   - daily / per-request caps (in USD)
 *   - allow-list of payees (contract addresses)
 *   - block-list of contracts
 *   - per-provider caps
 */

export class SpendPolicy {
  /**
   * @param {object} [opts]
   * @param {number} [opts.dailyUsd] maximum spend per UTC day
   * @param {number} [opts.perRequestUsd] maximum spend for one payment
   * @param {string[]} [opts.allowPayees] contract addresses that may be paid
   * @param {string[]} [opts.blockContracts] contract addresses that may never be paid
   * @param {Record<string, number>} [opts.perProviderUsd] cap per network id
   * @param {number} [opts.maxPayments] maximum number of payments per day
   */
  constructor(opts = {}) {
    this.dailyUsd = opts.dailyUsd ?? 5
    this.perRequestUsd = opts.perRequestUsd ?? 1
    this.allowPayees = (opts.allowPayees ?? []).map((a) => a.toLowerCase())
    this.blockContracts = (opts.blockContracts ?? []).map((a) => a.toLowerCase())
    this.perProviderUsd = opts.perProviderUsd ?? {}
    this.maxPayments = opts.maxPayments ?? 100
    /** @type {{day: string, spentUsd: number, payments: number, byProvider: Record<string, number>}} */
    this.state = { day: "", spentUsd: 0, payments: 0, byProvider: {} }
  }

  static day(now = new Date()) {
    return now.toISOString().slice(0, 10)
  }

  _roll(now = new Date()) {
    const day = SpendPolicy.day(now)
    if (this.state.day !== day) {
      this.state = { day, spentUsd: 0, payments: 0, byProvider: {} }
    }
  }

  /**
   * Check a planned payment against the policy.
   * @param {{amount: number, payTo?: string, asset?: string, network?: string}} req
   * @returns {{allowed: boolean, reason?: string}}
   */
  check(req, now = new Date()) {
    this._roll(now)
    const amount = Number(req.amount || 0)
    if (!Number.isFinite(amount) || amount <= 0) return { allowed: false, reason: "invalid amount" }
    if (amount > this.perRequestUsd)
      return { allowed: false, reason: `per-request cap ${this.perRequestUsd} USDC exceeded` }
    if (this.state.spentUsd + amount > this.dailyUsd)
      return { allowed: false, reason: `daily cap ${this.dailyUsd} USDC exceeded` }
    if (this.state.payments + 1 > this.maxPayments)
      return { allowed: false, reason: `max ${this.maxPayments} payments per day reached` }
    if (req.payTo && this.allowPayees.length && !this.allowPayees.includes(req.payTo.toLowerCase()))
      return { allowed: false, reason: `payee ${req.payTo} is not on the allow-list` }
    if (req.asset && this.blockContracts.includes(req.asset.toLowerCase()))
      return { allowed: false, reason: `asset ${req.asset} is blocked` }
    const net = req.network || "unknown"
    const spent = this.state.byProvider[net] || 0
    const cap = this.perProviderUsd[net]
    if (cap != null && spent + amount > cap)
      return { allowed: false, reason: `provider cap ${cap} USDC exceeded for ${net}` }
    return { allowed: true }
  }

  /** Record a completed payment. */
  commit(req, now = new Date()) {
    this._roll(now)
    const amount = Number(req.amount || 0)
    this.state.spentUsd += amount
    this.state.payments += 1
    const net = req.network || "unknown"
    this.state.byProvider[net] = (this.state.byProvider[net] || 0) + amount
  }

  /** Current spend report. */
  report(now = new Date()) {
    this._roll(now)
    return {
      day: this.state.day,
      spentUsd: round(this.state.spentUsd),
      dailyUsd: this.dailyUsd,
      leftUsd: round(Math.max(0, this.dailyUsd - this.state.spentUsd)),
      payments: this.state.payments,
      maxPayments: this.maxPayments,
      byProvider: this.state.byProvider,
    }
  }

  /** Serialise / restore. */
  toJSON() {
    return { ...this.state }
  }

  load(data) {
    if (data && typeof data === "object") this.state = { ...this.state, ...data }
    return this
  }
}

function round(n) {
  return Math.round(n * 1e6) / 1e6
}

// Read models: everything the UI shows, derived from the database.
import { all, first, getSetting } from './db.js'
import { computeNetWorth } from './compute/networth.js'
import { allocate, DEFAULT_TARGET } from './compute/allocation.js'
import { quarterStart } from './compute/ppf.js'
import { returns, fixedDepositReturns, ppfReturns } from './compute/returns.js'
import { findDisposals } from './compute/realised.js'
import { money } from './compute/num.js'
import { diff, bySleeve } from './compute/qtydiff.js'
import { xirr, sleeveFlows } from './compute/xirr.js'
import { BENCHMARKS, levelAt, compareToBenchmarks } from './compute/benchmark.js'
import { fifo, summariseGains, reconcile, ledgerXirr, termOf } from './compute/gains.js'
import { cashflow } from './compute/cashflow.js'
import { investmentIncome } from './compute/income.js'

const parse = (r) => ({ ...r, sources: JSON.parse(r.sources || '{}'), benchmarks: JSON.parse(r.benchmarks || '{}') })

export const checkpoints = () => all('SELECT * FROM checkpoints ORDER BY as_of_date').map(parse)
export const latestCheckpoint = () => { const r = first('SELECT * FROM checkpoints ORDER BY as_of_date DESC LIMIT 1'); return r ? parse(r) : null }
export const hasData = () => !!first('SELECT 1 AS x FROM checkpoints LIMIT 1')

export const holdingsOf = (id) => all('SELECT * FROM holdings WHERE checkpoint_id = ?', [id])
export const balancesOf = (id) => all('SELECT * FROM balances WHERE checkpoint_id = ?', [id])
export const fixedDeposits = () => all('SELECT * FROM fixed_deposits ORDER BY start_date')
export const ppfDeposits = () => all('SELECT * FROM ppf_deposits ORDER BY deposit_date, id')
export const ppfRates = () => all('SELECT * FROM ppf_rates ORDER BY quarter_start')
const ppfState = () => ({ deposits: ppfDeposits(), rates: ppfRates() })
export const splitwise = () => all('SELECT * FROM splitwise_balances ORDER BY ABS(amount_inr) DESC')
export const targets = () => getSetting('target_allocation', DEFAULT_TARGET)
export const trades = () => all('SELECT * FROM trades ORDER BY exit_date DESC')
/** The quarter whose PPF rate the user still has to enter, or null: only once they
 * have a PPF, only while today's quarter has no rate, and not after they dismissed it. */
export function ppfRateDue(today = new Date().toISOString().slice(0, 10)) {
  if (!first('SELECT 1 AS x FROM ppf_deposits LIMIT 1')) return null
  const qs = quarterStart(today)
  if (first('SELECT 1 AS x FROM ppf_rates WHERE quarter_start = ?', [qs])) return null
  if (getSetting('ppf_rate_dismissed', null) === qs) return null
  const last = first('SELECT rate_pct FROM ppf_rates WHERE quarter_start < ? ORDER BY quarter_start DESC LIMIT 1', [qs])
  return { quarter_start: qs, last_rate: last ? last.rate_pct : null }
}
/** The Bitcoin position: the hand-entered one, else the latest checkpoint's (an agent may have written it). */
export const manualBtc = () => first("SELECT * FROM manual_holdings WHERE symbol = 'BTC' ORDER BY as_of_date DESC LIMIT 1")
  || first("SELECT h.qty, h.price, h.avg_cost, h.invested_inr FROM holdings h JOIN checkpoints c ON c.id = h.checkpoint_id WHERE h.symbol = 'BTC' ORDER BY c.as_of_date DESC LIMIT 1")

/** Benchmark history as {key: [{date, level}]}, sorted by date. */
export function benchmarkHistory() {
  const out = {}
  for (const r of all('SELECT key, as_of_date, level FROM benchmark_levels ORDER BY as_of_date')) (out[r.key] || (out[r.key] = [])).push({ date: r.as_of_date, level: r.level })
  return out
}
export const ledgerRows = () => all('SELECT * FROM ledger ORDER BY trade_date')
export const manualAssets = () => all('SELECT * FROM manual_assets ORDER BY liability, kind, name, as_of_date')

/** What each hand-entered asset or loan was worth on a date: its latest entry on or before it. */
function assetsAt(rows, asOf) {
  const latest = new Map()
  for (const r of rows) if (r.as_of_date <= asOf) { const k = `${r.kind}\0${r.name}`; if (!latest.has(k) || latest.get(k).as_of_date < r.as_of_date) latest.set(k, r) }
  return [...latest.values()]
}

/** One networth point per checkpoint, oldest first. */
export function networthSeries() {
  const cps = checkpoints()
  const fds = fixedDeposits(), ppf = ppfState()
  const hs = new Map(), bs = new Map()
  for (const h of all('SELECT * FROM holdings')) (hs.get(h.checkpoint_id) || hs.set(h.checkpoint_id, []).get(h.checkpoint_id)).push(h)
  for (const b of all('SELECT * FROM balances')) (bs.get(b.checkpoint_id) || bs.set(b.checkpoint_id, []).get(b.checkpoint_id)).push(b)
  const assets = manualAssets()
  return cps.map((c) => ({ ...computeNetWorth({ asOf: c.as_of_date, holdings: hs.get(c.id) || [], balances: bs.get(c.id) || [], fixedDeposits: fds, ppf, assets: assetsAt(assets, c.as_of_date) }), sources: c.sources }))
}

export function allocationNow() {
  const s = networthSeries()
  if (!s.length) return null
  return allocate(s[s.length - 1], targets())
}

const MIN_XIRR_DAYS = 90
const RANGES = { '1w': 7, '1m': 30, '3m': 91, '1y': 365, all: null }
export const RANGE_IDS = Object.keys(RANGES)

// Which source owns which sleeve: a stale source is excluded from that period's
// attribution rather than booked as a move to zero.
const SOURCE_OF = { in_equity: ['kite', 'groww'], in_mf: ['kite'], gold: ['kite', 'groww'], debt: ['kite', 'groww'], us_equity: ['indmoney'], btc: ['manual'] }

/** Sleeve returns and attribution between the latest checkpoint and the one a
 * range ago, plus a series for the indexed chart. */
export function investmentsView(range = '3m') {
  const cps = checkpoints()
  if (!cps.length) return null
  const latest = cps[cps.length - 1]
  const days = RANGES[range]
  let compared = null
  if (cps.length > 1) {
    if (days === null) compared = cps[0]
    else {
      const startMs = Date.parse(latest.as_of_date) - days * 86400000
      const before = cps.filter((c) => Date.parse(c.as_of_date) <= startMs && c.id !== latest.id)
      compared = before.length ? before[before.length - 1] : cps[0]
    }
    if (compared.id === latest.id) compared = null
  }
  const fds = fixedDeposits()
  const now = holdingsOf(latest.id)
  const prev = compared ? holdingsOf(compared.id) : null
  const r = returns(now, prev)

  // Drop attribution for sleeves whose source went stale on either side.
  const stale = (s) => (SOURCE_OF[s] || []).some((src) => latest.sources[src] === 'stale' || (compared && compared.sources[src] === 'stale'))
  for (const s of r.sleeves) if (stale(s.sleeve)) Object.assign(s, { market: null, flow: null, fx: null, delta: null, stale: true })

  const fdSleeve = fds.length ? fixedDepositReturns(fds, latest.as_of_date, compared && compared.as_of_date) : null
  const ppf = ppfState()
  const ppfSleeve = ppf.deposits.length ? ppfReturns(ppf.deposits, ppf.rates, latest.as_of_date, compared && compared.as_of_date) : null
  const sleeves = [...r.sleeves, ...[fdSleeve, ppfSleeve].filter((s) => s && s.holdings.length)].sort((a, b) => b.value - a.value)

  const inRange = cps.filter((c) => !compared || c.as_of_date >= compared.as_of_date)
  const series = inRange.map((c) => {
    const values = {}
    for (const h of all('SELECT sleeve, SUM(value_inr) AS v FROM holdings WHERE checkpoint_id = ? GROUP BY sleeve', [c.id])) values[h.sleeve] = h.v
    const fd = fds.reduce((s, f) => s + (new Date(f.start_date) <= new Date(c.as_of_date) && !(f.closed_at && f.closed_at <= c.as_of_date) ? f.principal : 0), 0)
    if (fd) values.fd = money(fdSleeve ? fixedDepositReturns(fds, c.as_of_date, null).value : fd)
    if (ppfSleeve) { const v = ppfReturns(ppf.deposits, ppf.rates, c.as_of_date, null).value; if (v) values.ppf = v }
    return { as_of: c.as_of_date, values }
  })

  // Time-weighted index: chain each period's (market + fx) / opening value, leaving
  // flow out, so a SIP or a sale never reads as a gain or a crash. Starts at 100.
  const index = {}
  const chain = inRange.map((c) => ({ c, h: holdingsOf(c.id) }))
  const totalIndex = chain.length ? [{ as_of: chain[0].c.as_of_date, v: 100 }] : []
  for (let i = 0; i < chain.length; i++) {
    const asOf = chain[i].c.as_of_date
    if (i === 0) { for (const s of new Set(chain[0].h.map((x) => x.sleeve))) index[s] = [{ as_of: asOf, v: 100 }]; if (fds.length) index.fd = [{ as_of: asOf, v: 100 }]; if (ppfSleeve) index.ppf = [{ as_of: asOf, v: 100 }]; continue }
    const parts = bySleeve(diff(chain[i - 1].h, chain[i].h))
    for (const s of parts) {
      if (!index[s.sleeve]) { index[s.sleeve] = [{ as_of: asOf, v: 100 }]; continue }
      const last = index[s.sleeve].at(-1).v
      index[s.sleeve].push({ as_of: asOf, v: s.value_prev ? last * (1 + (s.market + s.fx) / s.value_prev) : last })
    }
    const opening = parts.reduce((a, s) => a + s.value_prev, 0), gain = parts.reduce((a, s) => a + s.market + s.fx, 0)
    totalIndex.push({ as_of: asOf, v: opening ? totalIndex.at(-1).v * (1 + gain / opening) : totalIndex.at(-1).v })
    if (index.fd && fds.length) {
      const f = fixedDepositReturns(fds, asOf, chain[i - 1].c.as_of_date)
      const prev = fixedDepositReturns(fds, chain[i - 1].c.as_of_date, null).value
      index.fd.push({ as_of: asOf, v: prev ? index.fd.at(-1).v * (1 + f.market / prev) : index.fd.at(-1).v })
    }
    if (index.ppf) { // interest only: a deposit is flow and stays out of the index
      const f = ppfReturns(ppf.deposits, ppf.rates, asOf, chain[i - 1].c.as_of_date)
      const prev = ppfReturns(ppf.deposits, ppf.rates, chain[i - 1].c.as_of_date, null).value
      index.ppf.push({ as_of: asOf, v: prev ? index.ppf.at(-1).v * (1 + f.market / prev) : index.ppf.at(-1).v })
    }
  }

  // Money-weighted return. Annualising a few weeks is noise, so short ranges show nothing.
  // Where a trade ledger covers a sleeve completely, its XIRR comes from the real trade dates
  // and runs since the first trade; otherwise it comes from the checkpoints in range.
  const flows = sleeveFlows(chain.map(({ c, h }) => ({ date: c.as_of_date, holdings: h })))
  const staleInRange = (s) => (SOURCE_OF[s] || []).some((src) => inRange.some((c) => c.sources[src] === 'stale'))
  const byCheckpoints = {}, allFlows = []
  for (const [s, f] of flows) { byCheckpoints[s] = staleInRange(s) ? null : xirr(f, { minDays: MIN_XIRR_DAYS }); if (!staleInRange(s)) allFlows.push(...f) }
  const led = ledgerRows()
  const byLedger = led.length ? ledgerXirr(led.map(ledgerRow), now, latest.as_of_date) : {}
  for (const s of sleeves) {
    const l = byLedger[s.sleeve], c = byCheckpoints[s.sleeve]
    s.xirr = l !== null && l !== undefined ? { pct: l, basis: 'ledger' } : c !== null && c !== undefined ? { pct: c, basis: 'checkpoints' } : null
  }
  const xirrTotal = xirr(allFlows, { minDays: MIN_XIRR_DAYS })

  const levels = {}
  const history = benchmarkHistory()
  for (const k of Object.keys(BENCHMARKS)) levels[k] = inRange.map((c) => ({ as_of: c.as_of_date, level: levelAt(c, k, history) })).filter((p) => p.level)
  const compare = compareToBenchmarks(totalIndex, levels)

  const total = sleeves.reduce((a, s) => ({ value: a.value + s.value, invested: a.invested + s.invested, unrealised: a.unrealised + s.unrealised }), { value: 0, invested: 0, unrealised: 0 })
  total.return_pct = total.invested ? money((total.unrealised / total.invested) * 100) : null
  total.partial = sleeves.some((s) => s.partial)
  return { as_of: latest.as_of_date, compared_to: compared && compared.as_of_date, checkpoints_in_range: inRange.length, sleeves, total, series, index, xirr: xirrTotal, compare }
}

const ledgerRow = (r) => ({ ...r })

/** Capital gains from the trade ledger: FIFO lots, their terms, a yearly estimate of tax, and
 * every place the ledger disagrees with what the latest checkpoint says you hold. */
export function ledgerView() {
  const rows = ledgerRows()
  if (!rows.length) return null
  const { disposals, unmatched, open } = fifo(rows)
  const latest = latestCheckpoint()
  const mismatches = latest ? reconcile(open, holdingsOf(latest.id)) : []
  return {
    trades: rows.length, from: rows[0].trade_date, to: rows.at(-1).trade_date,
    years: summariseGains(disposals).reverse(),
    disposals: disposals.map((d) => ({ ...d, term: termOf(d) })).sort((a, b) => b.sell_date.localeCompare(a.sell_date)),
    unmatched, mismatches,
  }
}

/** Income, spend, savings rate and runway from Wallet, against today's net worth. */
export function cashflowView() {
  if (!transactionCount()) return null
  const series = networthSeries()
  const latest = series.at(-1)
  return cashflow(transactionsAll(), labelsMap(), { asOf: latest ? latest.as_of_date : null, liquid: latest ? latest.liquid : null, total: latest ? latest.total : null, runway: getSetting('runway', null) })
}

/** Dividends and interest received over the trailing 12 months, from Wallet. */
export function incomeView() {
  if (!transactionCount()) return null
  const latest = networthSeries().at(-1)
  return investmentIncome(transactionsAll(), { asOf: latest ? latest.as_of_date : null })
}

/** Sales detected between the last two checkpoints. */
export function disposals() {
  const cps = checkpoints()
  if (cps.length < 2) return { between: null, disposals: [] }
  const [a, b] = cps.slice(-2)
  const found = findDisposals(holdingsOf(a.id), holdingsOf(b.id), a.as_of_date, b.as_of_date)
  const recorded = new Set(trades().map((t) => `${t.sleeve}\0${t.symbol}\0${t.exit_date}`))
  return { between: [a.as_of_date, b.as_of_date], disposals: found.filter((d) => !recorded.has(`${d.sleeve}\0${d.symbol}\0${b.as_of_date}`)) }
}

// --- expenses ----------------------------------------------------------------------
export function transactionsAll() { return all('SELECT * FROM transactions ORDER BY txn_date') }
export function labelsMap() {
  const m = new Map()
  for (const r of all('SELECT transaction_id, label FROM transaction_labels')) (m.get(r.transaction_id) || m.set(r.transaction_id, []).get(r.transaction_id)).push(r.label)
  return m
}
export const transactionCount = () => first('SELECT COUNT(*) AS n FROM transactions').n

/** What has been delivered so far, per source (used by the Data page). */
export function connectorStatus() {
  const latest = latestCheckpoint()
  const src = latest ? latest.sources : {}
  const hold = latest ? holdingsOf(latest.id) : []
  const bal = latest ? balancesOf(latest.id) : []
  const has = (s) => hold.some((h) => h.sleeve === s)
  return {
    wallet: { ok: transactionCount() > 0 || bal.some((b) => b.kind === 'cash' || b.kind === 'credit_card'), transactions: transactionCount(), balances: bal.filter((b) => b.kind === 'cash' || b.kind === 'credit_card').length },
    kite: { ok: has('in_equity') || has('in_mf'), equity: hold.filter((h) => h.sleeve === 'in_equity').length, funds: hold.filter((h) => h.sleeve === 'in_mf').length },
    indmoney: { ok: has('us_equity'), us: hold.filter((h) => h.sleeve === 'us_equity').length, epf: bal.filter((b) => b.kind === 'epf').length },
    epf: { ok: bal.some((b) => b.kind === 'epf') },
    btc: { ok: has('btc') || !!manualBtc() },
    fd: { ok: fixedDeposits().length > 0 },
    ppf: { ok: ppfDeposits().length > 0 },
    splitwise: { ok: splitwise().length > 0 },
    checkpoint: latest ? latest.as_of_date : null,
  }
}

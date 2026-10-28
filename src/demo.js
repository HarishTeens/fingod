// Demo data: every name and number here is invented. It exists so you can
// explore the app before connecting anything, and so the README screenshots can
// be regenerated without exposing a real portfolio.
import { ingestCheckpoint, ingestTransactions, saveFixedDeposit, saveSplitwise, recordTrade } from './ingest.js'
import { setSetting, write, first } from './db.js'
import { DEFAULT_TARGET } from './compute/allocation.js'

let seed = 11
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
const wobble = (vol) => 1 + (rnd() - 0.5) * vol
const day = (start, n) => new Date(Date.parse(start) + n * 86400000).toISOString().slice(0, 10)
const WEEKS = 26, START = '2026-05-01'

const EQUITY = [['ACME', 'Acme Industries', 'INE000A01001', 198, 410], ['BRIGHTON', 'Brighton Foods', 'INE000B01002', 132, 520], ['CASCADE', 'Cascade Power', 'INE000C01003', 330, 190], ['DELTAWORKS', 'Deltaworks Ltd', 'INE000D01004', 88, 640], ['EVERGREEN', 'Evergreen Bank', 'INE000E01005', 165, 330]]
const FUNDS = [['INF000F01001', 'Meridian Small Cap Fund', 3712, 21.4, 0.0055], ['INF000F01002', 'Northwind Flexi Cap Fund', 1218, 72.0, 0.0035], ['INF000F01003', 'Harbor Midcap Fund', 2262, 49.5, 0.0045]]

function checkpointFor(i, state) {
  const as = day(START, i * 7)
  for (const e of state.eq) e.price *= wobble(0.03)
  for (const f of state.mf) { f.price *= f.drift * wobble(0.012); f.qty += f.sip } // a SIP instalment every week: flow, not gain
  for (const u of state.us) u.price *= 1.002 * wobble(0.03)
  state.gold *= 1.004 * wobble(0.014); state.btc *= wobble(0.07); state.fx = 88.2 + i * 0.07
  const sold = i === WEEKS - 1 // the last checkpoint no longer holds DELTAWORKS: a sale to detect
  const holdings = [
    ...state.eq.filter((e) => !(sold && e.sym === 'DELTAWORKS')).map((e) => ({ sleeve: 'in_equity', symbol: e.sym, name: e.name, isin: e.isin, qty: e.qty, price: +e.price.toFixed(2), avg_cost: e.cost, invested_inr: +(e.qty * e.cost).toFixed(2) })),
    ...state.mf.map((f) => ({ sleeve: 'in_mf', symbol: f.isin, name: f.name, isin: f.isin, qty: +f.qty.toFixed(3), price: +f.price.toFixed(4), avg_cost: f.cost, invested_inr: +(f.qty * f.cost).toFixed(2) })),
    ...state.us.map((u) => ({ sleeve: 'us_equity', symbol: u.sym, name: u.name, qty: u.qty, price: +u.price.toFixed(2), currency: 'USD', fx_rate: +state.fx.toFixed(4), invested_inr: +(u.qty * u.price * 0.9 * 88.2).toFixed(2) })),
    { sleeve: 'gold', symbol: 'GOLDETF', name: 'Gold ETF', isin: 'INF000G01001', qty: 480, price: +state.gold.toFixed(2), avg_cost: 100, invested_inr: 48000 },
    { sleeve: 'debt', symbol: 'LIQUIDETF', name: 'Liquid ETF', isin: 'INF000L01001', qty: 20, price: 1000.1, avg_cost: 980, invested_inr: 19600 },
    { sleeve: 'btc', symbol: 'BTC', name: 'Bitcoin', qty: 0.0058, price: +(state.btc / 0.0058).toFixed(2), avg_cost: 6400000, invested_inr: 37120 },
  ]
  return {
    as_of_date: as, usd_inr: +state.fx.toFixed(4), sources: { wallet: 'ok', kite: 'ok', indmoney: 'ok', manual: 'ok' }, holdings,
    balances: [
      { kind: 'cash', ref: 'Bank A', amount_inr: 9000 + (i % 5) * 900 }, { kind: 'cash', ref: 'Bank B', amount_inr: 3200 }, { kind: 'cash', ref: 'Cash', amount_inr: 400 },
      { kind: 'credit_card', ref: 'Card A', amount_inr: 7000 + ((i * 7) % 6) * 1100 }, { kind: 'credit_card', ref: 'Card B', amount_inr: 2400 },
      { kind: 'epf', ref: 'Employer One', amount_inr: 52000 + i * 450 }, { kind: 'epf', ref: 'Employer Two', amount_inr: 13400 },
    ],
  }
}

function transactions() {
  const out = []
  let n = 0
  const add = (date, amount, category, top, labels = [], note = '', extra = {}) => out.push({ id: `demo-${++n}`, txn_date: date, amount_inr: amount, account: 'Bank A', note, category, category_top: top, category_id: `c-${category}`, labels, is_transfer: false, ...extra })
  for (let m = 0; m < 12; m++) {
    const d = (x) => `${new Date(Date.UTC(2025, 10 + m, 1)).toISOString().slice(0, 8)}${String(x).padStart(2, '0')}`
    add(d(1), 85000, 'Wage, invoices', 'Income', [], 'Salary') // untagged income: never an offset
    add(d(2), -18000, 'Rent', 'Housing', ['Home'], 'Rent')
    add(d(5), -2400, 'Utilities', 'Housing', ['Home'], 'Electricity and internet')
    for (let k = 0; k < 9; k++) add(d(3 + k * 3), -Math.round(150 + rnd() * 1400), k % 3 ? 'Restaurant, fast-food' : 'Groceries', 'Food & Drinks', rnd() > 0.55 ? ['Food'] : [], k % 3 ? 'Dinner' : 'Groceries')
    add(d(8), -1200, 'Streaming', 'Life & Entertainment', ['Subscriptions'], 'Streaming')
    add(d(9), -3000, 'Gym', 'Life & Entertainment', ['Fitness'], 'Gym')
    add(d(12), -Math.round(1500 + rnd() * 4000), 'Clothes & shoes', 'Shopping', ['Shopping'], 'Shopping')
    add(d(15), -10000, 'Investments', 'Investments', ['Investment'], 'Mutual fund SIP')
    add(d(16), -5000, 'Transfer', 'Transfer', [], 'To savings', { is_transfer: true })
    if (m % 4 === 1) add(d(20), -Math.round(5500 + rnd() * 3000), 'Holiday, trips', 'Life & Entertainment', ['Travel'], 'Weekend away')
  }
  // A trip split with friends: the outing is tagged Split + Beach Trip, and the friends' shares come back under the same label.
  add('2026-03-14', -42000, 'Holiday, trips', 'Life & Entertainment', ['Split', 'Beach Trip'], 'Beach trip, stays and food')
  add('2026-03-19', 14000, 'Refunds', 'Income', ['Beach Trip'], 'Friend paid back')
  add('2026-03-21', 14000, 'Refunds', 'Income', ['Beach Trip'], 'Friend paid back')
  return out
}

/** Load the whole demo dataset. Replaces nothing: call on an empty app. */
export function loadDemo() {
  seed = 11
  const state = {
    fx: 88.2, gold: 100, btc: 55000,
    eq: EQUITY.map(([sym, name, isin, qty, price]) => ({ sym, name, isin, qty, price, cost: Math.round(price * 0.86) })),
    mf: FUNDS.map(([isin, name, qty, price, drift]) => ({ isin, name, qty, price, drift: 1 + drift, sip: Math.round(qty * 0.004), cost: +(price * 0.8).toFixed(2) })),
    us: [{ sym: 'ALPH', name: 'Alpha Systems', qty: 2.8, price: 215 }, { sym: 'BETA', name: 'Beta Networks', qty: 1, price: 410 }],
  }
  for (let i = 0; i < WEEKS; i++) ingestCheckpoint(checkpointFor(i, state))
  ingestTransactions({ transactions: transactions() })
  saveFixedDeposit({ bank: 'Example Bank', principal: 100000, rate_pct: 6.5, start_date: '2026-02-01', maturity_date: '2027-02-01' })
  saveFixedDeposit({ bank: 'Example Bank', principal: 50000, rate_pct: 6.75, start_date: '2026-06-10', maturity_date: '2027-06-10' })
  for (const [p, a] of [['Friend A', 3000], ['Friend B', 1500], ['Friend C', -500]]) saveSplitwise(p, a, 'demo')
  for (const t of [['in_equity', 'AAA', '2025-11-17', 10000, 3000, 90], ['in_equity', 'BBB', '2025-12-04', 30000, -7000, 120], ['in_equity', 'CCC', '2026-02-19', 40000, 6200, 200], ['us_equity', 'DDD', '2026-04-08', 25000, 4100, 150], ['in_equity', 'EEE', '2026-06-03', 18000, -2200, 60]])
    recordTrade({ sleeve: t[0], symbol: t[1], exit_date: t[2], invested_inr: t[3], realised_inr: t[4], holding_days: t[5], source: 'demo' })
  setSetting('target_allocation', DEFAULT_TARGET)
  setSetting('demo', true)
  setSetting('onboarding', { done: true })
}

export const isDemo = () => { const r = first("SELECT value FROM settings WHERE key = 'demo'"); return !!r && JSON.parse(r.value) === true }

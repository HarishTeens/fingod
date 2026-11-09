import test from 'node:test'
import assert from 'node:assert/strict'
import { xirr, sleeveFlows, midpoint } from '../src/compute/xirr.js'
import { fifo, termOf, fyOf, summariseGains, reconcile, ledgerXirr } from '../src/compute/gains.js'
import { cashflow } from '../src/compute/cashflow.js'
import { investmentIncome, kindOf, payerOf, INCOME_CATEGORY_ID } from '../src/compute/income.js'
import { compareToBenchmarks, levelAt } from '../src/compute/benchmark.js'
import { computeNetWorth } from '../src/compute/networth.js'
import { classify, ingestLedger, ingestBenchmarks, validateCheckpoint, IngestError } from '../src/ingest.js'

// --- XIRR -------------------------------------------------------------------
test('xirr: a year to grow 100 into 110 is 10%', () => {
  assert.equal(xirr([{ date: '2025-01-01', amount: -100 }, { date: '2026-01-01', amount: 110 }]), 10)
})

test('xirr: a loss is negative, and money added late weighs less than money added early', () => {
  assert.equal(xirr([{ date: '2025-01-01', amount: -100 }, { date: '2026-01-01', amount: 90 }]), -10)
  const early = xirr([{ date: '2025-01-01', amount: -100 }, { date: '2025-01-02', amount: -100 }, { date: '2026-01-01', amount: 230 }])
  const late = xirr([{ date: '2025-01-01', amount: -100 }, { date: '2025-12-01', amount: -100 }, { date: '2026-01-01', amount: 230 }])
  assert.ok(late > early, 'the same ending value from later money is a better rate')
})

test('xirr: nothing to say without both an outflow and an inflow, or on too short a span', () => {
  assert.equal(xirr([{ date: '2025-01-01', amount: 100 }, { date: '2026-01-01', amount: 100 }]), null)
  assert.equal(xirr([{ date: '2025-01-01', amount: -100 }]), null)
  assert.equal(xirr([{ date: '2025-01-01', amount: -100 }, { date: '2025-01-20', amount: 101 }], { minDays: 90 }), null)
})

test('sleeveFlows: a SIP is flow and a price move is not', () => {
  const h = (qty, price) => [{ sleeve: 'in_mf', symbol: 'F', isin: 'INF1', qty, price, fx_rate: 1 }]
  const flows = sleeveFlows([{ date: '2026-01-01', holdings: h(100, 10) }, { date: '2026-01-15', holdings: h(110, 12) }]).get('in_mf')
  assert.deepEqual(flows.map((f) => f.amount), [-1000, -120, 1320]) // opening, the 10 units bought at 12, and what is held at the end
  assert.equal(flows[1].date, midpoint('2026-01-01', '2026-01-15'))
})

// --- ledger, FIFO, terms ------------------------------------------------------
const row = (o) => ({ id: Math.random().toString(36), sleeve: 'in_equity', symbol: 'ACME', isin: 'INE000A01001', fx_rate: 1, fees_inr: 0, ...o })

test('fifo: a sale consumes the oldest lots first, and each piece keeps its own cost and date', () => {
  const { disposals, open } = fifo([
    row({ trade_date: '2025-01-01', side: 'buy', qty: 10, price: 100 }),
    row({ trade_date: '2025-02-01', side: 'buy', qty: 10, price: 120 }),
    row({ trade_date: '2025-06-01', side: 'sell', qty: 15, price: 150 }),
  ])
  assert.equal(disposals.length, 2)
  assert.deepEqual([disposals[0].qty, disposals[0].cost, disposals[0].proceeds, disposals[0].gain], [10, 1000, 1500, 500])
  assert.deepEqual([disposals[1].qty, disposals[1].cost, disposals[1].proceeds, disposals[1].gain], [5, 600, 750, 150])
  assert.equal(disposals[0].buy_date, '2025-01-01')
  const o = [...open.values()][0]
  assert.deepEqual([o.qty, o.cost], [5, 600])
})

test('fifo: fees raise the cost and lower the proceeds', () => {
  const { disposals } = fifo([
    row({ trade_date: '2025-01-01', side: 'buy', qty: 10, price: 100, fees_inr: 20 }),
    row({ trade_date: '2025-02-01', side: 'sell', qty: 10, price: 110, fees_inr: 30 }),
  ])
  assert.deepEqual([disposals[0].cost, disposals[0].proceeds, disposals[0].gain], [1020, 1070, 50])
})

test('fifo: a sale with no purchase behind it is reported, never booked as pure profit', () => {
  const { disposals, unmatched } = fifo([row({ trade_date: '2025-02-01', side: 'sell', qty: 4, price: 110 })])
  assert.equal(disposals.length, 0)
  assert.equal(unmatched[0].qty, 4)
})

test('fifo: a buy and a sell on the same day match, whichever order the file lists them', () => {
  const { disposals } = fifo([row({ trade_date: '2025-02-01', side: 'sell', qty: 5, price: 110 }), row({ trade_date: '2025-02-01', side: 'buy', qty: 5, price: 100 })])
  assert.equal(disposals.length, 1)
})

test('a foreign trade is costed in rupees at its own rate', () => {
  const { disposals } = fifo([
    row({ sleeve: 'us_equity', isin: null, symbol: 'ALPH', trade_date: '2025-01-01', side: 'buy', qty: 2, price: 100, fx_rate: 80 }),
    row({ sleeve: 'us_equity', isin: null, symbol: 'ALPH', trade_date: '2025-06-01', side: 'sell', qty: 2, price: 100, fx_rate: 90 }),
  ])
  assert.deepEqual([disposals[0].cost, disposals[0].proceeds, disposals[0].gain], [16000, 18000, 2000])
})

test('terms: equity is long-term after 12 months, foreign shares after 24, debt never', () => {
  assert.equal(termOf({ sleeve: 'in_equity', holding_days: 365 }), 'ST')
  assert.equal(termOf({ sleeve: 'in_equity', holding_days: 366 }), 'LT')
  assert.equal(termOf({ sleeve: 'us_equity', holding_days: 730 }), 'ST')
  assert.equal(termOf({ sleeve: 'us_equity', holding_days: 731 }), 'LT')
  assert.equal(termOf({ sleeve: 'debt', holding_days: 2000 }), null)
})

test('financial years run April to March', () => {
  assert.equal(fyOf('2026-03-31'), 'FY 2025-26')
  assert.equal(fyOf('2026-04-01'), 'FY 2026-27')
})

// --- tax estimate -------------------------------------------------------------
const sale = (o) => ({ sleeve: 'in_equity', symbol: 'ACME', name: 'Acme', qty: 1, cost: 0, proceeds: 0, ...o })

test('tax: long-term equity gains above the exemption are taxed at 12.5%, short-term at 20%', () => {
  const [y] = summariseGains([
    sale({ sell_date: '2026-08-01', holding_days: 500, gain: 300000 }),
    sale({ sell_date: '2026-09-01', holding_days: 100, gain: 100000 }),
  ])
  assert.equal(y.fy, 'FY 2026-27')
  assert.equal(y.lt, 300000)
  assert.equal(y.st, 100000)
  assert.equal(y.est_tax, 20000 + (300000 - 125000) * 0.125)
})

test('tax: a short-term loss absorbs long-term gains before the exemption', () => {
  const [y] = summariseGains([
    sale({ sell_date: '2026-08-01', holding_days: 500, gain: 200000 }),
    sale({ sell_date: '2026-09-01', holding_days: 100, gain: -50000 }),
  ])
  assert.equal(y.est_tax, (200000 - 50000 - 125000) * 0.125)
})

test('tax: a long-term loss cannot offset a short-term gain, and the leftover is reported', () => {
  const [y] = summariseGains([
    sale({ sell_date: '2026-08-01', holding_days: 500, gain: -30000 }),
    sale({ sell_date: '2026-09-01', holding_days: 100, gain: 10000 }),
  ])
  assert.equal(y.est_tax, 2000)
  assert.equal(y.carry_forward, 30000)
})

test('tax: before the July 2024 change the old rates and a ₹1 lakh exemption apply', () => {
  const [y] = summariseGains([sale({ sell_date: '2024-01-10', holding_days: 500, gain: 200000 })])
  assert.equal(y.fy, 'FY 2023-24')
  assert.equal(y.est_tax, 100000 * 0.1)
})

test('tax: gains taxed at the slab rate are shown but not estimated', () => {
  const [y] = summariseGains([sale({ sleeve: 'debt', sell_date: '2026-08-01', holding_days: 900, gain: 5000 })])
  assert.equal(y.slab_gain, 5000)
  assert.equal(y.est_tax, 0)
  assert.ok(y.notes.some((n) => /slab/.test(n)))
})

test('tax: crypto is 30% flat and a loss is not set off against a win', () => {
  const [y] = summariseGains([sale({ sleeve: 'btc', sell_date: '2026-08-01', holding_days: 10, gain: 10000 }), sale({ sleeve: 'btc', sell_date: '2026-08-02', holding_days: 10, gain: -4000 })])
  assert.equal(y.est_tax, 3000)
})

// --- ledger against the checkpoint ---------------------------------------------
test('reconcile flags a position whose ledger quantity disagrees with what is held', () => {
  const { open } = fifo([row({ trade_date: '2025-01-01', side: 'buy', qty: 10, price: 100 })])
  assert.deepEqual(reconcile(open, [{ sleeve: 'in_equity', symbol: 'ACME', isin: 'INE000A01001', qty: 10 }]), [])
  assert.equal(reconcile(open, [{ sleeve: 'in_equity', symbol: 'ACME', isin: 'INE000A01001', qty: 12 }]).length, 1)
})

test('ledger XIRR uses real trade dates, and goes blank when the ledger is incomplete', () => {
  const rows = [row({ trade_date: '2025-01-01', side: 'buy', qty: 10, price: 100 })]
  const held = [{ sleeve: 'in_equity', symbol: 'ACME', isin: 'INE000A01001', qty: 10, price: 121, fx_rate: 1 }]
  assert.equal(ledgerXirr(rows, held, '2026-01-01').in_equity, 21)
  assert.equal(ledgerXirr(rows, [{ ...held[0], qty: 12 }], '2026-01-01').in_equity, null)
  assert.equal(ledgerXirr(rows, [...held, { sleeve: 'in_equity', symbol: 'OTHER', isin: 'INE000Z01001', qty: 1, price: 5 }], '2026-01-01').in_equity, null)
})

// --- cash flow ------------------------------------------------------------------
test('cashflow: savings rate and runway come from complete months, and agree with the spend chart', () => {
  const t = (id, txn_date, amount_inr, extra = {}) => ({ id, txn_date, amount_inr, category: 'Food & Drinks', category_top: 'Food & Drinks', is_transfer: 0, ...extra })
  const txns = []
  for (const m of ['2026-07', '2026-08', '2026-09']) {
    txns.push(t(`${m}-sal`, `${m}-01`, 100000, { category: 'Wage', category_top: 'Income' }))
    txns.push(t(`${m}-f`, `${m}-10`, -40000))
    txns.push(t(`${m}-sip`, `${m}-12`, -20000, { category: 'Investments', category_top: 'Investments' }))
    txns.push(t(`${m}-x`, `${m}-15`, -5000, { category: 'Transfer', is_transfer: 1 }))
  }
  txns.push(t('oct-sal', '2026-10-01', 100000, { category: 'Wage', category_top: 'Income' }), t('oct-f', '2026-10-05', -90000))
  const c = cashflow(txns, new Map(), { asOf: '2026-10-20', liquid: 600000, total: 1200000 })
  assert.equal(c.window.months_used, 3, 'October is still being lived, so it is left out of the averages')
  assert.equal(c.avg_spend, 40000)
  assert.equal(c.avg_income, 100000)
  assert.equal(c.savings_rate_pct, 60) // the SIP counts as saved, not spent; the transfer is neither
  assert.equal(c.runway_months, 15)
  assert.equal(c.runway_months_total, 30)
  assert.equal(c.months.find((m) => m.month === '2026-08-01').invested, 20000)
})

test('cashflow: runway can count only the labels you name, netted exactly as the chart nets them', () => {
  const t = (id, txn_date, amount_inr, extra = {}) => ({ id, txn_date, amount_inr, category: 'Food & Drinks', category_top: 'Food & Drinks', is_transfer: 0, ...extra })
  const txns = [], labels = new Map()
  const add = (tx, l) => { txns.push(tx); if (l) labels.set(tx.id, l) }
  for (const m of ['2026-07', '2026-08', '2026-09']) {
    add(t(`${m}-sal`, `${m}-01`, 100000, { category: 'Wage', category_top: 'Income' }))
    add(t(`${m}-p`, `${m}-05`, -10000), ['Personal'])
    add(t(`${m}-h`, `${m}-06`, -20000), ['House'])
    add(t(`${m}-trip`, `${m}-07`, -60000), ['Trip'])
    add(t(`${m}-ot`, `${m}-08`, -10000), ['House', 'One-Time']) // shared evenly between its labels, as the chart does: 5,000 is House
  }
  add(t('sep-extra', '2026-09-09', -7000), ['Personal'])
  const base = { asOf: '2026-10-20', liquid: 700000, total: 1400000 }
  const all = cashflow(txns, labels, base)
  assert.equal(all.runway_basis, null)
  assert.equal(all.runway_months, 6.84, 'with no runway option it divides by all spending, as before') // 700000 / ((100000 + 100000 + 107000) / 3)
  const c = cashflow(txns, labels, { ...base, runway: { labels: ['Personal', 'House'] } })
  assert.equal(c.avg_spend, all.avg_spend, 'the headline spend does not change')
  assert.equal(c.runway_basis.avg_spend, 37333.33) // (35000 + 35000 + 42000) / 3
  assert.deepEqual(c.runway_basis.labels, ['Personal', 'House'])
  assert.equal(c.runway_months, 18.75)
  assert.equal(c.runway_months_total, 37.5)
  assert.equal(cashflow(txns, labels, { ...base, runway: { labels: ['Personal', 'House'], months: 1 } }).runway_months, 16.67) // September alone: 700000 / 42000
  assert.equal(cashflow(txns, labels, { ...base, runway: { labels: ['Nothing'] } }).runway_basis.avg_spend, 0)
  assert.equal(cashflow(txns, labels, { ...base, runway: { labels: ['Nothing'] } }).runway_months, null, 'no spend at all gives no runway, not an infinite one')
})

test('cashflow: a refund carrying a label reduces spend and is not income', () => {
  const labels = new Map([['r', ['Trip']], ['s', ['Trip']]])
  const txns = [
    { id: 's', txn_date: '2026-08-02', amount_inr: -10000, category: 'Holiday', category_top: 'Life', is_transfer: 0 },
    { id: 'r', txn_date: '2026-08-05', amount_inr: 4000, category: 'Refunds', category_top: 'Income', is_transfer: 0 },
  ]
  const [m] = cashflow(txns, labels, {}).months
  assert.equal(m.spend, 6000)
  assert.equal(m.income, 0)
})

// --- benchmarks -----------------------------------------------------------------
test('benchmarks: a dollar index is converted at the checkpoint rate, and a missing one is null', () => {
  assert.equal(levelAt({ benchmarks: { sp500: 500 }, usd_inr: 90 }, 'sp500'), 45000)
  assert.equal(levelAt({ benchmarks: { nifty50: 24000 } }, 'nifty50'), 24000)
  assert.equal(levelAt({ benchmarks: {} }, 'nifty50'), null)
  assert.equal(levelAt({ benchmarks: { sp500: 500 } }, 'sp500'), null)
})

test('benchmarks: every line starts at 100 on the first date of the range', () => {
  const total = [{ as_of: '2026-01-01', v: 100 }, { as_of: '2026-02-01', v: 105 }, { as_of: '2026-03-01', v: 126 }]
  const c = compareToBenchmarks(total, { nifty50: [{ as_of: '2026-01-01', level: 20000 }, { as_of: '2026-02-01', level: 20500 }, { as_of: '2026-03-01', level: 21000 }] })
  assert.equal(c.since, '2026-01-01')
  const mine = c.series.find((s) => s.key === 'portfolio'), nifty = c.series.find((s) => s.key === 'nifty50')
  assert.equal(mine.points[0].v, 100)
  assert.equal(nifty.points[0].v, 100)
  assert.equal(mine.change_pct, 26)
  assert.equal(nifty.change_pct, 5)
  assert.deepEqual(c.missing, [])
  assert.equal(compareToBenchmarks(total, {}), null)
})

test('benchmarks: one with no close on the first date is listed, not drawn from the middle of the chart', () => {
  const total = [{ as_of: '2026-01-01', v: 100 }, { as_of: '2026-02-01', v: 105 }, { as_of: '2026-03-01', v: 126 }]
  const c = compareToBenchmarks(total, { nifty50: [{ as_of: '2026-02-01', level: 20500 }, { as_of: '2026-03-01', level: 21000 }] })
  assert.deepEqual(c.series.map((s) => s.key), ['portfolio'])
  assert.deepEqual(c.missing.map((m) => m.key), ['nifty50'])
})

// --- other assets and loans -------------------------------------------------------
test('net worth: other assets add to the total, loans subtract, and liquid is untouched', () => {
  const base = { asOf: '2026-10-01', holdings: [], balances: [{ kind: 'cash', ref: 'A', amount_inr: 1000 }], fixedDeposits: [] }
  const plain = computeNetWorth(base)
  const n = computeNetWorth({ ...base, assets: [{ value_inr: 5000 }, { value_inr: 2000, liability: 1 }] })
  assert.equal(n.liquid, plain.liquid)
  assert.equal(n.total, plain.total + 5000 - 2000)
  assert.equal(n.other_assets, 5000)
  assert.equal(n.loans, 2000)
})

// --- files ------------------------------------------------------------------------
test('a ledger file is recognised, and its problems are all named', () => {
  assert.equal(classify({ ledger: [] }), 'ledger')
  assert.equal(classify({ assets: [] }), 'standing')
  const bad = { ledger: [{ sleeve: 'crypto', symbol: 'X' }, { sleeve: 'in_equity', symbol: 'ACME', trade_date: '01/02/2026', side: 'hold', qty: 0, price: 1 }] }
  assert.throws(() => ingestLedger(bad), (e) => e instanceof IngestError && /sleeve/.test(e.message) && /trade_date/.test(e.message) && /side/.test(e.message) && /qty/.test(e.message))
})

test('a checkpoint rejects an unknown or non-positive benchmark', () => {
  const p = { as_of_date: '2026-10-29', holdings: [], benchmarks: { nifty50: 24000 } }
  assert.doesNotThrow(() => validateCheckpoint(p))
  assert.throws(() => validateCheckpoint({ ...p, benchmarks: { dow: 40000 } }), /benchmarks.dow/)
  assert.throws(() => validateCheckpoint({ ...p, benchmarks: { nifty50: -1 } }), /nifty50/)
})

// --- benchmark history -------------------------------------------------------------
test('benchmark history fills a checkpoint with the nearest earlier close, within a week', () => {
  const history = { nifty50: [{ date: '2026-10-09', level: 23900 }, { date: '2026-10-16', level: 24000 }] }
  assert.equal(levelAt({ as_of_date: '2026-10-18', benchmarks: {} }, 'nifty50', history), 24000) // a Sunday reads Friday's close
  assert.equal(levelAt({ as_of_date: '2026-10-16', benchmarks: {} }, 'nifty50', history), 24000) // the same day counts
  assert.equal(levelAt({ as_of_date: '2026-10-30', benchmarks: {} }, 'nifty50', history), null, 'two weeks old would be a guess')
  assert.equal(levelAt({ as_of_date: '2026-10-05', benchmarks: {} }, 'nifty50', history), null, 'nothing earlier to read')
})

test('a level written in the checkpoint wins over the history, and a dollar history is converted', () => {
  const history = { nifty50: [{ date: '2026-10-16', level: 24000 }], sp500: [{ date: '2026-10-16', level: 500 }] }
  assert.equal(levelAt({ as_of_date: '2026-10-17', benchmarks: { nifty50: 25000 } }, 'nifty50', history), 25000)
  assert.equal(levelAt({ as_of_date: '2026-10-17', benchmarks: {}, usd_inr: 90 }, 'sp500', history), 45000)
})

test('a benchmark history file is told apart from a checkpoint that carries one level', () => {
  assert.equal(classify({ benchmarks: { nifty50: [{ date: '2026-10-16', level: 24000 }] } }), 'benchmarks')
  assert.equal(classify({ as_of_date: '2026-10-16', holdings: [], benchmarks: { nifty50: 24000 } }), 'checkpoint')
})

test('a benchmark history file names every bad row', () => {
  const bad = { benchmarks: { dow: [], nifty50: [{ date: '16/10/2026', level: 24000 }, { date: '2026-10-17', level: -1 }] } }
  assert.throws(() => ingestBenchmarks(bad), (e) => e instanceof IngestError && /dow/.test(e.message) && /date must be/.test(e.message) && /level must be/.test(e.message))
})

// --- income from investments ----------------------------------------------------
test('income: dividends and interest are split by note, windowed to 12 months, and transfers are ignored', () => {
  const t = (id, txn_date, amount_inr, note, extra = {}) => ({ id, txn_date, amount_inr, note, category: 'Interest, dividends', category_id: INCOME_CATEGORY_ID, is_transfer: 0, ...extra })
  const txns = [
    t('a', '2026-10-05', 1000, 'ACME dividend'),
    t('b', '2026-10-20', 500, 'Final DIV ACME'),
    t('c', '2026-09-30', 300, 'FD interest'),
    t('d', '2026-08-01', 120, ''),
    t('old', '2025-09-30', 9999, 'ACME dividend'), // 13 months back: outside the window
    t('x', '2026-10-06', 777, 'moved', { is_transfer: 1 }),
    t('neg', '2026-10-07', -50, 'reversal'),
    { id: 'other', txn_date: '2026-10-08', amount_inr: 4000, note: 'Salary', category: 'Wage', category_id: 'c-wage', is_transfer: 0 },
  ]
  const r = investmentIncome(txns, { asOf: '2026-10-31' })
  assert.equal(r.from, '2025-11-01')
  assert.equal(r.months.length, 12)
  assert.equal(r.total, 1920)
  assert.equal(r.dividends, 1500)
  assert.equal(r.interest, 300)
  assert.equal(r.unspecified, 120)
  assert.equal(r.months_paid, 3)
  assert.equal(r.monthly_avg, 160)
  assert.deepEqual(r.payers, [{ name: 'Acme', amount: 1500 }], 'two spellings of one payer are one payer')
  assert.equal(investmentIncome([], {}), null)
})

test('income: the note decides the kind, and a payer name drops the dividend wording', () => {
  assert.equal(kindOf('Credit interest'), 'interest')
  assert.equal(kindOf('ITC'), 'dividends')
  assert.equal(kindOf('  '), 'unspecified')
  assert.equal(payerOf('PNB, Final DIV'), 'Pnb')
  assert.equal(payerOf('dividend'), null)
})

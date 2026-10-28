import test from 'node:test'
import assert from 'node:assert/strict'
import { diff, bySleeve } from '../src/compute/qtydiff.js'
import { computeNetWorth } from '../src/compute/networth.js'
import { accrued, value as fdValue } from '../src/compute/fd.js'
import { allocate } from '../src/compute/allocation.js'
import { returns, shares, fixedDepositReturns } from '../src/compute/returns.js'
import { summarise, byPeriod, findDisposals } from '../src/compute/realised.js'
import { expenseByLabel, labelNets } from '../src/compute/expenses.js'

const P = (o) => ({ fx_rate: 1, currency: 'INR', ...o })

// --- qty-diff ---------------------------------------------------------------
test('a contribution is never reported as gain', () => {
  const prev = P({ sleeve: 'in_mf', symbol: 'F', isin: 'INF1', qty: 1000, price: 50 })
  const [a] = diff([prev], [{ ...prev, qty: 1100.5 }])
  assert.equal(a.market, 0)
  assert.equal(a.fx, 0)
  assert.equal(a.flow, a.delta)
})

test('a gain is never reported as contribution', () => {
  const prev = P({ sleeve: 'gold', symbol: 'G', isin: 'INF2', qty: 200, price: 100 })
  const [a] = diff([prev], [{ ...prev, price: 120 }])
  assert.equal(a.flow, 0)
  assert.equal(a.market, a.delta)
  assert.equal(a.market, 4000)
})

test('fx is isolated from market', () => {
  const prev = P({ sleeve: 'us_equity', symbol: 'ACME', qty: 2, price: 500, fx_rate: 85 })
  const [a] = diff([prev], [{ ...prev, fx_rate: 90 }])
  assert.equal(a.market, 0)
  assert.equal(a.flow, 0)
  assert.equal(a.fx, 5000) // 2 × 500 × (90 − 85)
  assert.equal(a.fx, a.delta)
})

test('a new position is all flow; an exit is an outflow, not a total loss', () => {
  const now = P({ sleeve: 'us_equity', symbol: 'NEWCO', qty: 10, price: 20, fx_rate: 90 })
  const [n] = diff([], [now])
  assert.ok(n.new)
  assert.equal(n.market, 0); assert.equal(n.fx, 0); assert.equal(n.flow, 18000)

  const prev = P({ sleeve: 'in_equity', symbol: 'ALPHA', isin: 'INE1', qty: 100, price: 200 })
  const [x] = diff([prev], [])
  assert.ok(x.exited)
  assert.equal(x.market, 0)
  assert.equal(x.flow, -20000)
})

test('a rename is not an exit plus an entry (matched on ISIN)', () => {
  const prev = P({ sleeve: 'in_equity', symbol: 'OLDNAME', isin: 'INE2', qty: 50, price: 400 })
  const now = P({ sleeve: 'in_equity', symbol: 'NEWNAME', isin: 'INE2', qty: 50, price: 300 })
  const attrs = diff([prev], [now])
  assert.equal(attrs.length, 1)
  assert.equal(attrs[0].symbol, 'NEWNAME')
  assert.ok(!attrs[0].new && !attrs[0].exited)
  assert.equal(attrs[0].flow, 0)
  assert.equal(attrs[0].market, attrs[0].delta)
})

test('market + flow + fx equals delta exactly, over random inputs', () => {
  let s = 20260905
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647
  for (let i = 0; i < 5000; i++) {
    const prev = P({ sleeve: 'us_equity', symbol: 'T', isin: 'INE0', qty: +(rnd() * 5e4).toFixed(8), price: +(rnd() * 1e4).toFixed(6), fx_rate: +(80 + rnd() * 15).toFixed(6) })
    const now = { ...prev, qty: +(rnd() * 5e4).toFixed(8), price: +(rnd() * 1e4).toFixed(6), fx_rate: +(80 + rnd() * 15).toFixed(6) }
    const [a] = diff([prev], [now])
    assert.equal(Math.round((a.market + a.flow + a.fx) * 100), Math.round(a.delta * 100))
  }
})

test('a bonus issue is flagged', () => {
  const prev = [P({ sleeve: 'in_equity', symbol: 'ALPHA', isin: 'A', qty: 100, price: 100 }), P({ sleeve: 'in_equity', symbol: 'BONUSCO', isin: 'B', qty: 500, price: 200 })]
  const now = [P({ sleeve: 'in_equity', symbol: 'ALPHA', isin: 'A', qty: 100, price: 110 }), P({ sleeve: 'in_equity', symbol: 'BONUSCO', isin: 'B', qty: 1000, price: 220 })]
  const flagged = bySleeve(diff(prev, now)).flatMap((s) => s.holdings.filter((h) => h.flagged).map((h) => h.symbol))
  assert.deepEqual(flagged, ['BONUSCO'])
})

// --- net worth --------------------------------------------------------------
const fd = { id: 1, bank: 'Example Bank', principal: 100000, rate_pct: 7.1, start_date: '2025-09-05', maturity_date: '2027-09-05', compounding: 'quarterly' }
const fixture = () => ({
  asOf: '2026-09-05',
  holdings: [
    { sleeve: 'in_equity', symbol: 'ALPHA', qty: 100, price: 200, fx_rate: 1 },
    { sleeve: 'in_equity', symbol: 'BETA', qty: 50, price: 100, fx_rate: 1 },
    { sleeve: 'gold', symbol: 'GOLDETF', qty: 200, price: 100, fx_rate: 1 },
    { sleeve: 'in_equity', symbol: 'LIQUIDETF', qty: 100, price: 100, fx_rate: 1 },
    { sleeve: 'in_mf', symbol: 'FUND', qty: 1000.5, price: 50, fx_rate: 1 },
    { sleeve: 'us_equity', symbol: 'ACME', qty: 2, price: 500, fx_rate: 90 },
    { sleeve: 'btc', symbol: 'BTC', qty: 0.1, price: 1000000, fx_rate: 1 },
  ],
  balances: [
    { kind: 'cash', amount_inr: 10000 }, { kind: 'cash', amount_inr: 5000 }, { kind: 'cash', amount_inr: 100 },
    { kind: 'credit_card', amount_inr: 5000 }, { kind: 'credit_card', amount_inr: 1000.5 },
    { kind: 'epf', amount_inr: 100000 }, { kind: 'epf', amount_inr: 50000 },
    { kind: 'splitwise', amount_inr: 3000 }, { kind: 'splitwise', amount_inr: -500 },
  ],
  fixedDeposits: [fd],
})

test('total − liquid is exactly EPF + accrued FD interest + receivables', () => {
  const nw = computeNetWorth(fixture())
  assert.equal(Math.round((nw.total - nw.liquid) * 100), Math.round((nw.epf + nw.fd_accrued + nw.splitwise) * 100))
})

test('liquid reconciles by hand; sleeves sum to investments', () => {
  const nw = computeNetWorth(fixture())
  assert.equal(nw.liquid, Math.round((nw.investments + nw.cash + nw.fd_principal - nw.credit_card) * 100) / 100)
  assert.equal(Math.round(Object.values(nw.sleeves).reduce((a, b) => a + b, 0) * 100), Math.round(nw.investments * 100))
})

test('credit cards are subtracted; US holdings are converted; splitwise can be negative', () => {
  const nw = computeNetWorth(fixture())
  assert.equal(nw.sleeves.us_equity, 90000) // 2 × 500 × 90, not 1000
  assert.equal(nw.splitwise, 2500)
  const more = fixture(); more.balances.push({ kind: 'credit_card', amount_inr: 10000 })
  assert.equal(Math.round((nw.liquid - computeNetWorth(more).liquid) * 100) / 100, 10000)
})

test('an FD that has not started yet is not counted', () => {
  const nw = computeNetWorth({ ...fixture(), asOf: '2025-01-01' })
  assert.equal(nw.fd_principal, 0); assert.equal(nw.fd_accrued, 0)
})

// --- fixed deposits -----------------------------------------------------------
test('FD interest matches a bank calculator', () => {
  assert.equal(accrued(fd, '2026-09-05'), 7291.28) // one year, 7.2913% effective
  assert.equal(accrued(fd, '2027-09-05'), 15114.2)
  assert.equal(accrued(fd, '2026-03-05'), 3551.55) // 181 days
  assert.equal(accrued({ ...fd, compounding: 'simple' }, '2026-09-05'), 7100)
})

test('FD interest stops at maturity and at closure', () => {
  assert.equal(accrued(fd, '2027-09-05'), accrued(fd, '2035-01-01'))
  const closed = { ...fd, closed_at: '2026-03-05' }
  assert.equal(accrued(closed, '2026-03-05'), accrued(closed, '2027-01-01'))
  assert.equal(fdValue(closed, '2026-06-01'), 0)
  assert.equal(fdValue(fd, '2025-01-01'), 0)
  assert.equal(fdValue(fd, '2026-09-05'), 107291.28)
})

// --- allocation ---------------------------------------------------------------
test('allocation drift, and the target defines the base', () => {
  const nw = computeNetWorth(fixture())
  const a = allocate(nw, { in_equity: 50, us_equity: 50 })
  const base = nw.sleeves.in_equity + nw.sleeves.us_equity
  assert.equal(a.base, Math.round(base * 100) / 100)
  assert.ok(a.untargeted.gold) // not named by the target, so outside the base
  const total = a.rows.reduce((s, r) => s + r.share_pct, 0)
  assert.ok(Math.abs(total - 100) < 0.02)
})

// --- returns ------------------------------------------------------------------
test('returns match the sleeve by hand; a missing cost basis is flagged, not hidden', () => {
  const now = [
    P({ sleeve: 'us_equity', symbol: 'ACME', qty: 2, price: 500, fx_rate: 90, currency: 'USD', invested_inr: 80000 }),
    P({ sleeve: 'us_equity', symbol: 'BETA', qty: 1, price: 400, fx_rate: 90, currency: 'USD', invested_inr: 30000 }),
  ]
  const { sleeves, total } = returns(now, null)
  assert.equal(sleeves[0].unrealised, 16000)
  assert.equal(total.return_pct, 14.55) // 16000 / 110000
  assert.equal(total.partial, false)

  const partial = returns([P({ sleeve: 'btc', symbol: 'BTC', qty: 1, price: 100, invested_inr: 80 }), P({ sleeve: 'btc', symbol: 'ETH', qty: 1, price: 100 })], null)
  assert.ok(partial.sleeves[0].partial && partial.total.partial)
  assert.equal(partial.sleeves[0].invested, 80) // the missing one must not be invented
})

test('attribution only appears with a comparison; price-only move is all market', () => {
  const now = [P({ sleeve: 'in_equity', symbol: 'ACME', isin: 'X', qty: 400, price: 120, invested_inr: 40000 })]
  assert.equal(returns(now, null).sleeves[0].market, null)
  const prev = [P({ sleeve: 'in_equity', symbol: 'ACME', isin: 'X', qty: 400, price: 100, invested_inr: 40000 })]
  const s = returns(now, prev).sleeves[0]
  assert.equal(s.market, 8000); assert.equal(s.flow, 0); assert.equal(s.fx, 0)
  assert.equal(s.return_pct, 20)
})

test('shares sum to exactly 100', () => {
  const vals = Array.from({ length: 31 }, (_, i) => 1000 + (i + 1) * 137)
  assert.equal(Math.round(shares(vals).reduce((a, b) => a + b, 0) * 100) / 100, 100)
})

test('FD sleeve: interest is market, opening a deposit is flow', () => {
  const fds = [
    { id: 1, bank: 'X', principal: 200000, rate_pct: 6.5, start_date: '2026-02-01', maturity_date: '2027-02-01', compounding: 'quarterly' },
    { id: 2, bank: 'X', principal: 300000, rate_pct: 6.5, start_date: '2026-06-10', maturity_date: '2027-06-10', compounding: 'quarterly' },
  ]
  const s = fixedDepositReturns(fds, '2026-09-05', null)
  assert.equal(s.invested, 500000)
  assert.equal(s.unrealised, 12424.97)
  const week = fixedDepositReturns(fds, '2026-09-05', '2026-08-29')
  assert.equal(week.flow, 0); assert.ok(week.market > 0)
  const opened = fixedDepositReturns(fds, '2026-07-10', '2026-06-01')
  assert.ok(opened.flow >= 300000)
  assert.equal(Math.round((opened.market + opened.flow + opened.fx) * 100), Math.round(opened.delta * 100))
})

// --- realised -----------------------------------------------------------------
const T = (symbol, exit, inv, re, days) => ({ sleeve: 'in_equity', symbol, exit_date: exit, invested_inr: inv, realised_inr: re, holding_days: days })

test('realised summary adds up the book; gross wins and losses do not net off', () => {
  const s = summarise([T('AAA', '2025-05-20', 10000, 3000, 90), T('BBB', '2025-10-01', 30000, -7000, 120), T('CCC', '2026-06-01', 40000, -11000, 200)])
  assert.equal(s.realised, -15000)
  assert.equal(s.winners, 1); assert.equal(s.losers, 2)
  assert.equal(s.gross_wins, 3000); assert.equal(s.gross_losses, -18000)
  assert.equal(s.best.symbol, 'AAA'); assert.equal(s.worst.symbol, 'CCC')
  assert.equal(s.avg_holding_days, 136)
})

test('break-even counts as a loser; trades bucket on exit date', () => {
  const s = summarise([T('X', '2026-01-01', 1000, 0, 30)])
  assert.equal(s.winners, 0); assert.equal(s.losers, 1)
  const y = byPeriod([T('X', '2026-07-15', 1000, 500, 866)], 'year')
  assert.equal(y.length, 1); assert.equal(y[0].period, '2026-01-01'); assert.equal(y[0].realised, 500)
})

test('disposals: full exit, partial sale at average cost, buying more is not one, USD at checkpoint rate', () => {
  const pos = (sym, isin, qty, price, inv) => P({ sleeve: 'in_equity', symbol: sym, isin, qty, price, invested_inr: inv })
  const [full] = findDisposals([pos('ACME', 'I1', 400, 120, 40000)], [], 'a', 'b')
  assert.ok(full.full_exit); assert.equal(full.estimated_proceeds, 48000); assert.equal(full.estimated_realised, 8000)
  const [part] = findDisposals([pos('ACME', 'I1', 400, 120, 40000)], [pos('ACME', 'I1', 100, 120, 10000)], 'a', 'b')
  assert.ok(!part.full_exit); assert.equal(part.invested_sold, 30000); assert.equal(part.estimated_realised, 6000)
  assert.equal(findDisposals([pos('ACME', 'I1', 100, 120, 10000)], [pos('ACME', 'I1', 400, 120, 40000)], 'a', 'b').length, 0)
  assert.equal(findDisposals([pos('OLD', 'I2', 50, 400, 20000)], [pos('NEW', 'I2', 50, 300, 20000)], 'a', 'b').length, 0) // rename
  const usd = P({ sleeve: 'us_equity', symbol: 'ACME', qty: 2, price: 500, fx_rate: 90, currency: 'USD', invested_inr: 80000 })
  assert.equal(findDisposals([usd], [], 'a', 'b')[0].estimated_proceeds, 90000)
})

// --- expenses -----------------------------------------------------------------
const X = (id, date, amt, extra = {}) => ({ id, txn_date: date, amount_inr: amt, category: 'Food', category_top: 'Life', is_transfer: false, ...extra })

test('expenses: transfers and investments are excluded; labelled income nets against its label', () => {
  const txns = [
    X('1', '2026-05-03', -1000, { category: 'Food' }),
    X('2', '2026-05-04', -4000), // beach trip outing
    X('3', '2026-05-09', 1500), // a friend paying their share, tagged with the same label
    X('4', '2026-05-10', 90000), // salary, untagged: never an offset
    X('5', '2026-05-11', -2500, { is_transfer: true }),
    X('6', '2026-05-12', -5000, { category_top: 'Investments' }),
  ]
  const labels = new Map([['2', ['Beach Trip']], ['3', ['Beach Trip']]])
  const { series, labels: names } = expenseByLabel(txns, labels, 'month')
  assert.equal(series.length, 1)
  assert.equal(series[0].segments['Beach Trip'], 2500) // 4000 out, 1500 back
  assert.equal(series[0].segments.Untagged, 1000)
  assert.equal(series[0].total, 3500)
  assert.deepEqual(names.sort(), ['Beach Trip', 'Untagged'])
})

test('expenses: a modifier label steps aside, and a net-positive label is clamped, not drawn negative', () => {
  const txns = [X('a', '2026-05-01', -4000), X('b', '2026-05-02', -100), X('c', '2026-05-03', 6000)]
  const labels = new Map([['a', ['Split', 'Beach Trip']], ['b', ['Freelance']], ['c', ['Freelance']]])
  const cells = labelNets(txns, labels, 'month')
  assert.equal(cells.find((c) => c.label === 'Beach Trip').net, 4000) // whole amount, not halved
  assert.ok(!cells.some((c) => c.label === 'Split'))
  const { series } = expenseByLabel(txns, labels, 'month')
  assert.equal(series[0].segments.Freelance, undefined)
  assert.equal(series[0].net_inflow, 5900)
})

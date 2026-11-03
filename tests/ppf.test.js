import test from 'node:test'
import assert from 'node:assert/strict'
import { balance, quarterStart, quarterLabel, quartersBetween, rateFor } from '../src/compute/ppf.js'
import { ppfReturns } from '../src/compute/returns.js'
import { computeNetWorth } from '../src/compute/networth.js'
import { allocate } from '../src/compute/allocation.js'
import { classify } from '../src/ingest.js'
import { money as money2 } from '../src/compute/num.js'

const rates = [{ quarter_start: '2024-04-01', rate_pct: 7.1 }]
const dep = (deposit_date, amount_inr) => ({ deposit_date, amount_inr })

test('a deposit by the 5th earns for its month; interest is credited on 31 March', () => {
  const b = balance([dep('2024-04-03', 150000)], rates, '2025-03-31')
  assert.equal(b.credited, 10650) // 12 months × 150000 × 7.1% / 12
  assert.equal(b.value, 160650)
  assert.equal(balance([dep('2024-04-03', 150000)], rates, '2025-03-30').credited, 0) // not yet credited
})

test('a deposit after the 5th misses its own month; only completed months earn', () => {
  const late = balance([dep('2024-04-06', 150000)], rates, '2025-03-31')
  assert.equal(late.credited, 9762.5) // eleven months
  assert.equal(balance([dep('2024-04-03', 150000)], rates, '2024-04-29').interest, 0) // April is not complete
})

test('interest compounds from the year after it is credited', () => {
  const b = balance([dep('2024-04-03', 150000)], rates, '2026-03-31')
  assert.equal(b.credited, money2(10650 + 160650 * 0.071))
  assert.equal(b.value, money2(150000 + b.credited))
})

test('a quarter without a rate carries the last one forward and says so', () => {
  assert.deepEqual(rateFor(rates, '2024-07-01'), { rate_pct: 7.1, assumed: true })
  assert.deepEqual(rateFor(rates, '2024-04-01'), { rate_pct: 7.1, assumed: false })
  assert.deepEqual(balance([dep('2024-04-03', 1000)], rates, '2024-09-30').missing, ['2024-07-01'])
})

test('quarters follow the Indian financial year', () => {
  assert.equal(quarterStart('2026-11-03'), '2026-10-01')
  assert.equal(quarterStart('2027-02-14'), '2027-01-01')
  assert.equal(quarterLabel('2026-10-01'), 'Q3 FY 2026-27 (Oct–Dec 2026)')
  assert.deepEqual(quartersBetween('2026-02-10', '2026-08-01'), ['2026-01-01', '2026-04-01', '2026-07-01'])
})

test('PPF counts in total net worth, never liquid; allocation sees it', () => {
  const ppf = { deposits: [dep('2024-04-03', 150000)], rates }
  const base = { asOf: '2025-03-31', holdings: [], balances: [{ kind: 'cash', amount_inr: 1000 }] }
  const without = computeNetWorth(base), withPpf = computeNetWorth({ ...base, ppf })
  assert.equal(withPpf.liquid, without.liquid)
  assert.equal(withPpf.total - without.total, 160650)
  assert.equal(withPpf.ppf, 160650)
  assert.equal(allocate(withPpf, { ppf: 100 }).rows[0].value, 160650)
})

test('PPF sleeve: interest is market, a deposit is flow', () => {
  const deposits = [dep('2024-04-03', 150000), dep('2025-04-04', 150000)]
  const s = ppfReturns(deposits, rates, '2025-06-30', '2025-03-31')
  assert.equal(s.flow, 150000)
  assert.equal(s.invested, 300000)
  assert.equal(money2(s.market + s.flow), s.delta)
  assert.equal(s.unrealised, money2(s.value - s.invested))
})

test('a standing file carrying only PPF is recognised', () => {
  assert.equal(classify({ ppf: { deposits: [{ date: '2026-04-02', amount_inr: 150000 }], rates: [{ quarter_start: '2026-10-01', rate_pct: 7.1 }] } }), 'standing')
})

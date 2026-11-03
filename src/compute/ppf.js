// Public Provident Fund, valued by formula at any date - so deposits entered today
// still price correctly at checkpoints taken before they existed.
//
// The rules, as the scheme applies them:
//   - interest is worked out every month on the lowest balance between the 5th and
//     the month's end, so a deposit counts for its month only if it lands by the 5th;
//   - the monthly figure is that balance × the annual rate / 12;
//   - the year's interest is credited once, on 31 March, and compounds from then on;
//   - the rate is set by the government each quarter of the financial year
//     (Q1 Apr–Jun, Q2 Jul–Sept, Q3 Oct–Dec, Q4 Jan–Mar).
// Only completed months earn interest, as on a passbook.
import { num, money, dayMs } from './num.js'

const pad = (n) => String(n).padStart(2, '0')
const ym = (d) => [Number(d.slice(0, 4)), Number(d.slice(5, 7))]
const monthEnd = (y, m) => new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)

/** The first day of the financial-year quarter that holds `date`: Jan, Apr, Jul or Oct. */
export function quarterStart(date) {
  const [y, m] = ym(date)
  return `${y}-${pad(m - ((m - 1) % 3))}-01`
}

/** 'Q3 FY 2026-27 (Oct–Dec 2026)' for '2026-10-01'. */
export function quarterLabel(qs) {
  const [y, m] = ym(qs)
  const q = { 4: 1, 7: 2, 10: 3, 1: 4 }[m]
  const fy = m >= 4 ? y : y - 1
  const span = { 1: 'Apr–Jun', 2: 'Jul–Sept', 3: 'Oct–Dec', 4: 'Jan–Mar' }[q]
  return `Q${q} FY ${fy}-${String(fy + 1).slice(2)} (${span} ${y})`
}

/** Every quarter start from the one holding `from` to the one holding `to`, oldest first. */
export function quartersBetween(from, to) {
  const out = []
  let [y, m] = ym(quarterStart(from))
  const end = quarterStart(to)
  for (let qs = `${y}-${pad(m)}-01`; qs <= end; qs = `${y}-${pad(m)}-01`) {
    out.push(qs)
    m += 3; if (m > 12) { m -= 12; y++ }
  }
  return out
}

/** The rate for a quarter: its own, else the latest one set before it (the rate is
 * usually unchanged), else none. `assumed` says the quarter has no rate of its own. */
export function rateFor(rates, qs) {
  const own = rates.find((r) => r.quarter_start === qs)
  if (own) return { rate_pct: num(own.rate_pct), assumed: false }
  const before = rates.filter((r) => r.quarter_start < qs).sort((a, b) => b.quarter_start.localeCompare(a.quarter_start))[0]
  return { rate_pct: before ? num(before.rate_pct) : 0, assumed: true }
}

/** The account at `at`: what was paid in, interest credited on past 31 Marches,
 * interest earned since the last one, and the quarters that had no rate of their own. */
export function balance(deposits, rates, at) {
  const paid = deposits.filter((d) => dayMs(d.deposit_date) <= dayMs(at))
  const deposited = paid.reduce((s, d) => s + num(d.amount_inr), 0)
  const out = { deposited: money(deposited), credited: 0, accrued: 0, interest: 0, value: money(deposited), missing: [] }
  if (!paid.length) return out

  const first = paid.map((d) => d.deposit_date).sort()[0]
  let [y, m] = ym(first)
  let credited = 0, pending = 0
  const missing = new Set()
  for (;;) {
    const end = monthEnd(y, m)
    if (dayMs(end) > dayMs(at)) break // only completed months earn
    const fifth = `${y}-${pad(m)}-05`
    const eligible = paid.filter((d) => d.deposit_date <= fifth).reduce((s, d) => s + num(d.amount_inr), 0) + credited
    const qs = quarterStart(fifth)
    const r = rateFor(rates, qs)
    if (r.assumed) missing.add(qs)
    pending += (eligible * r.rate_pct) / 100 / 12
    if (m === 3) { credited += money(pending); pending = 0 } // credited on 31 March
    m++; if (m > 12) { m = 1; y++ }
  }
  if (!Number.isFinite(credited + pending)) throw new Error('ppf: interest is not a finite number')
  out.credited = money(credited)
  out.accrued = money(pending)
  out.interest = money(credited + pending)
  out.value = money(deposited + credited + pending)
  out.missing = [...missing].sort()
  return out
}

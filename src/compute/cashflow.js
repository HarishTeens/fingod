// Income, spend, savings rate and runway, from Wallet transactions. Pure.
//
//   spend    what things cost you, net of money that came back under the same label:
//            the very figure the spend chart draws, so a bar and this number agree
//   income   money in that is not an offset: positive, not a transfer, not an investment
//            sale, and carrying no label (a labelled inflow already reduced a spend)
//   saved    income − spend. Money you invested counts as saved, because it is not gone.
//   runway   how many months of spending today's net worth would cover. By default that is the
//            same average as `spend`; a `runway: {labels, months}` option narrows it to the labels
//            you treat as your ongoing cost of living (trips and one-offs assumed cut)
//
// A month with no transactions at all is skipped (Wallet may simply not have been used),
// so a gap never reads as a month of saving everything.
import { num, money, sum, pct } from './num.js'
import { expenseByLabel, labelNets, isCountable, INVESTMENT_CATEGORY, INVESTMENT_LABEL, periodOf } from './expenses.js'

const WINDOW = 3 // complete months averaged for the headline figures

export function cashflow(txns, labelsById, { asOf, liquid = null, total = null, runway = null } = {}) {
  const months = new Map()
  const row = (period) => months.get(period) || months.set(period, { month: period, income: 0, spend: 0, invested: 0 }).get(period)
  for (const t of txns) {
    const r = row(periodOf(t.txn_date, 'month'))
    const labels = labelsById.get(t.id) || []
    const amt = num(t.amount_inr)
    const isInvestment = (t.category_top || '') === INVESTMENT_CATEGORY || (t.category !== 'Insurances' && labels.includes(INVESTMENT_LABEL))
    if (isInvestment && !t.is_transfer) r.invested += -amt
    if (amt > 0 && isCountable(t, labels) && !labels.filter((l) => l !== INVESTMENT_LABEL).length) r.income += amt
  }
  for (const p of expenseByLabel(txns, labelsById, 'month').series) row(p.period).spend = p.total
  const rows = [...months.values()].filter((r) => r.income || r.spend || r.invested).sort((a, b) => a.month.localeCompare(b.month)).map((r) => {
    const income = money(r.income), spend = money(r.spend), saved = money(income - spend)
    return { month: r.month, income, spend, saved, invested: money(r.invested), savings_rate_pct: income > 0 ? pct(saved, income) : null }
  })

  // The month being lived is incomplete, so the headline averages look at the months before it.
  const current = asOf ? periodOf(asOf, 'month') : null
  const recent = rows.filter((r) => !current || r.month < current).slice(-WINDOW)
  const income = sum(recent.map((r) => r.income)), spend = sum(recent.map((r) => r.spend))
  const avgSpend = recent.length ? money(spend / recent.length) : null

  // Runway may look at a narrower slice than the headline spend. Someone who expects to cut trips and
  // one-offs names the labels that are their ongoing cost of living, and only those are averaged. It
  // reads the same label netting the chart does, so a bar and this number still agree.
  let basis = null
  if (runway && Array.isArray(runway.labels) && runway.labels.length) {
    const want = new Set(runway.labels)
    const byMonth = new Map()
    for (const c of labelNets(txns, labelsById, 'month')) if (want.has(c.label) && c.net > 0) byMonth.set(c.period, (byMonth.get(c.period) || 0) + c.net)
    const span = rows.filter((r) => !current || r.month < current).slice(-(runway.months || WINDOW))
    if (span.length) basis = { labels: runway.labels, months_used: span.length, avg_spend: money(sum(span.map((r) => byMonth.get(r.month) || 0)) / span.length) }
  }
  const runwaySpend = basis ? basis.avg_spend : avgSpend
  return {
    months: rows,
    window: { months_used: recent.length, from: recent[0] ? recent[0].month : null, to: recent.at(-1) ? recent.at(-1).month : null },
    avg_income: recent.length ? money(income / recent.length) : null,
    avg_spend: avgSpend,
    savings_rate_pct: income > 0 ? pct(income - spend, income) : null,
    runway_basis: basis,
    runway_months: runwaySpend && liquid !== null ? money(liquid / runwaySpend) : null,
    runway_months_total: runwaySpend && total !== null ? money(total / runwaySpend) : null,
  }
}

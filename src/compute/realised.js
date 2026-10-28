// Realised profit, and the disposals that produce it.
import { num, money, sum, pct } from './num.js'
import { holdingValue } from './networth.js'

const DUST = 1e-6

/** What the trades add up to. Break-even counts as a loser: it consumed the
 * position and returned nothing, and calling it a win would flatter the hit
 * rate. Gross wins and losses are kept apart so they never net off. */
export function summarise(trades) {
  const out = { trades: trades.length, invested: 0, realised: 0, winners: 0, losers: 0, gross_wins: 0, gross_losses: 0,
    return_pct: null, win_rate_pct: null, avg_holding_days: null, best: null, worst: null }
  let days = 0, withDays = 0, best = null, worst = null
  for (const t of trades) {
    const re = num(t.realised_inr)
    out.invested += num(t.invested_inr)
    out.realised += re
    if (re > 0) { out.winners++; out.gross_wins += re } else { out.losers++; out.gross_losses += re }
    if (t.holding_days !== null && t.holding_days !== undefined) { days += t.holding_days; withDays++ }
    if (!best || re > num(best.realised_inr)) best = t
    if (!worst || re < num(worst.realised_inr)) worst = t
  }
  for (const k of ['invested', 'realised', 'gross_wins', 'gross_losses']) out[k] = money(out[k])
  if (out.invested) out.return_pct = pct(out.realised, out.invested)
  if (trades.length) out.win_rate_pct = Math.round((out.winners / trades.length) * 1000) / 10
  if (withDays) out.avg_holding_days = Math.trunc(days / withDays)
  const ref = (t) => t && { symbol: t.symbol, realised: money(num(t.realised_inr)), return_pct: pct(num(t.realised_inr), num(t.invested_inr)), exit_date: t.exit_date }
  out.best = ref(best); out.worst = ref(worst)
  return out
}

/** Bucketed on the EXIT date: held across a year-end, sold in 2026, all of it is 2026. */
export function byPeriod(trades, granularity = 'month') {
  const buckets = new Map()
  for (const t of trades) {
    const k = granularity === 'year' ? `${t.exit_date.slice(0, 4)}-01-01` : `${t.exit_date.slice(0, 7)}-01`
    if (!buckets.has(k)) buckets.set(k, { period: k, realised: 0, invested: 0, trades: 0, winners: 0 })
    const b = buckets.get(k)
    b.realised += num(t.realised_inr); b.invested += num(t.invested_inr); b.trades++
    if (num(t.realised_inr) > 0) b.winners++
  }
  return [...buckets.values()].sort((a, b) => a.period.localeCompare(b.period))
    .map((b) => ({ ...b, realised: money(b.realised), invested: money(b.invested) }))
}

const key = (h) => (h.isin ? `isin\0${h.isin}` : `sym\0${h.sleeve}\0${h.symbol}`)

/** A quantity that fell between two checkpoints is a sale. The snapshot only
 * ever sees what is still held, so the sale PRICE is the one thing it cannot
 * know: proceeds are estimated at the previous checkpoint's price and must be
 * confirmed by the user before they are recorded as a trade. */
export function findDisposals(prev, now, prevDate, nowDate) {
  const after = new Map(now.map((h) => [key(h), h]))
  const out = []
  for (const before of prev) {
    const cur = after.get(key(before))
    const qtyBefore = num(before.qty), qtyAfter = cur ? num(cur.qty) : 0
    if (qtyAfter >= qtyBefore) continue
    const sold = qtyBefore - qtyAfter
    if (sold < DUST) continue
    const fx = before.fx_rate === undefined || before.fx_rate === null ? 1 : num(before.fx_rate)
    const proceeds = sold * num(before.price) * fx
    const d = {
      sleeve: before.sleeve, symbol: before.symbol, name: before.name || '', isin: before.isin || '',
      qty_before: qtyBefore, qty_after: qtyAfter, qty_sold: sold, full_exit: qtyAfter === 0,
      last_price: num(before.price), currency: before.currency || 'INR', fx_rate: fx,
      estimated_proceeds: money(proceeds), invested_sold: null, estimated_realised: null,
      between: [prevDate, nowDate],
    }
    if (before.invested_inr !== null && before.invested_inr !== undefined && before.invested_inr !== '' && qtyBefore) {
      const portion = (num(before.invested_inr) * sold) / qtyBefore // average cost, as a broker does it
      d.invested_sold = money(portion)
      d.estimated_realised = money(proceeds - portion)
    }
    out.push(d)
  }
  return out.sort((a, b) => b.estimated_proceeds - a.estimated_proceeds)
}

export { holdingValue, sum }

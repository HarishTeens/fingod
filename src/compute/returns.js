// Returns against cost basis, with optional market/flow/fx attribution.
//
// A group where any holding lacks a cost basis is marked `partial` rather than
// reporting a flattering return: full value over partial invested.
import { num, money, sum, pct } from './num.js'
import { holdingValue } from './networth.js'
import { diff, bySleeve } from './qtydiff.js'
import { accrued, isLive, value as fdValue } from './fd.js'

/** Largest-remainder rounding, so a column of shares totals exactly 100. */
export function shares(values) {
  const total = sum(values)
  if (!total) return values.map(() => 0)
  const raw = values.map((v) => (v / total) * 10000)
  const floor = raw.map(Math.floor)
  let left = 10000 - sum(floor)
  const order = raw.map((r, i) => [r - floor[i], i]).sort((a, b) => b[0] - a[0])
  for (const [, i] of order) { if (left-- <= 0) break; floor[i]++ }
  return floor.map((n) => n / 100)
}

const hasCost = (h) => h.invested_inr !== null && h.invested_inr !== undefined && h.invested_inr !== ''

export function returns(now, prev, threshold = 0.25) {
  const attrByKey = new Map()
  if (prev) for (const a of diff(prev, now)) attrByKey.set(`${a.sleeve}\0${a.symbol}`, a)
  const sleeveAttr = new Map()
  if (prev) for (const s of bySleeve(diff(prev, now), threshold)) sleeveAttr.set(s.sleeve, s)

  const groups = new Map()
  for (const h of now) {
    if (!groups.has(h.sleeve)) groups.set(h.sleeve, [])
    groups.get(h.sleeve).push(h)
  }

  const sleeves = [...groups.entries()].map(([sleeve, hs]) => {
    const sh = shares(hs.map(holdingValue))
    const rows = hs.map((h, i) => {
      const value = money(holdingValue(h))
      const invested = hasCost(h) ? money(num(h.invested_inr)) : null
      const a = attrByKey.get(`${sleeve}\0${h.symbol}`)
      return {
        sleeve, symbol: h.symbol, name: h.name || h.symbol, isin: h.isin || '',
        qty: num(h.qty), price: num(h.price), currency: h.currency || 'INR', avg_cost: h.avg_cost ?? null,
        value, invested, unrealised: invested === null ? null : money(value - invested),
        return_pct: invested ? pct(value - invested, invested) : null,
        share_pct: sh[i], market: a ? a.market : null, flagged: a ? a.flagged : false,
      }
    })
    rows.sort((a, b) => b.value - a.value)
    const value = money(sum(rows.map((r) => r.value)))
    const known = rows.filter((r) => r.invested !== null)
    const invested = money(sum(known.map((r) => r.invested)))
    const sa = sleeveAttr.get(sleeve)
    return {
      sleeve, value, invested, partial: known.length !== rows.length,
      unrealised: money(sum(known.map((r) => r.value)) - invested),
      return_pct: invested ? pct(sum(known.map((r) => r.value)) - invested, invested) : null,
      market: sa ? sa.market : null, flow: sa ? sa.flow : null, fx: sa ? sa.fx : null, delta: sa ? sa.delta : null,
      holdings: rows,
    }
  })
  sleeves.sort((a, b) => b.value - a.value)
  const known = sleeves.filter((s) => !s.partial || s.invested)
  const value = money(sum(sleeves.map((s) => s.value)))
  const invested = money(sum(known.map((s) => s.invested)))
  const unrealised = money(sum(sleeves.map((s) => s.unrealised)))
  return {
    sleeves,
    total: { value, invested, unrealised, return_pct: invested ? pct(unrealised, invested) : null, partial: sleeves.some((s) => s.partial) },
  }
}

/** The FD sleeve: no quantity, so growth is interest (market), not flow — except
 * on the day a deposit opens or closes, which is money moving. */
export function fixedDepositReturns(fds, at, prevAt) {
  const live = fds.filter((f) => isLive(f, at))
  const rows = live.map((f) => ({
    sleeve: 'fd', symbol: `${f.bank}-${f.id}`, name: `${f.rate_pct}% ${f.bank}${f.note ? ` · ${f.note}` : ''}`,
    value: fdValue(f, at), invested: money(num(f.principal)), unrealised: accrued(f, at),
    return_pct: pct(accrued(f, at), num(f.principal)),
  }))
  const value = money(sum(rows.map((r) => r.value)))
  const invested = money(sum(rows.map((r) => r.invested)))
  const out = { sleeve: 'fd', value, invested, unrealised: money(value - invested), return_pct: pct(value - invested, invested), partial: false, holdings: rows, market: null, flow: null, fx: null, delta: null }
  if (prevAt) {
    const prevValue = sum(fds.map((f) => fdValue(f, prevAt)))
    const prevPrincipal = sum(fds.filter((f) => isLive(f, prevAt)).map((f) => num(f.principal)))
    const flow = money(sum(live.map((f) => num(f.principal))) - prevPrincipal)
    const delta = money(value - prevValue)
    Object.assign(out, { delta, flow, fx: 0, market: money(delta - flow) })
  }
  return out
}

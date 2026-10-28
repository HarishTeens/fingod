// The qty-diff engine. Growth is never read from a price feed; it is derived by
// diffing two checkpoints and watching quantity.
//
//   market =  qty_p × (price_n − price_p) × fx_n     the price moved
//   flow   = (qty_n − qty_p) × price_n   × fx_n      money went in or came out
//   fx     =  qty_p ×  price_p × (fx_n − fx_p)       the rupee moved
//
// These sum exactly to value_n − value_p — an algebraic identity:
//
//   qₙpₙfₙ − qₚpₚfₚ  ≡  qₚ(pₙ−pₚ)fₙ + (qₙ−qₚ)pₙfₙ + qₚpₚ(fₙ−fₚ)
//
// so a ₹50k SIP can never masquerade as ₹50k of market gain.
import { num, money } from './num.js'

/** Holdings are matched on ISIN (it survives renames), else sleeve + symbol. */
const matchKey = (p) => (p.isin ? `isin\0${p.isin}` : `sym\0${p.sleeve}\0${p.symbol}`)

const fxOf = (p) => (p.fx_rate === undefined || p.fx_rate === null ? 1 : num(p.fx_rate))

function decompose(prev, now, isNew, exited) {
  const qp = num(prev.qty), qn = num(now.qty)
  const pp = num(prev.price)
  let pn = num(now.price)
  let fp = fxOf(prev)
  let fn = fxOf(now)
  if (isNew) fp = fn // no earlier rate to compare against
  if (exited) { pn = pp; fn = fp } // carry the last price and rate: a sale is flow, not a crash to zero
  const market = qp * (pn - pp) * fn
  const flow = (qn - qp) * pn * fn
  const fx = qp * pp * (fn - fp)
  const valuePrev = qp * pp * fp
  const valueNow = qn * pn * fn
  return { market, flow, fx, delta: valueNow - valuePrev, valuePrev, valueNow }
}

/** Round the three parts, then push any rounding residual onto the largest one. */
function reconcile(market, flow, fx, delta) {
  const parts = { market, flow, fx }
  const total = parts.market + parts.flow + parts.fx
  const residual = money(delta - total)
  if (residual !== 0) {
    const largest = Object.keys(parts).sort((a, b) => Math.abs(parts[b]) - Math.abs(parts[a]))[0]
    parts[largest] = money(parts[largest] + residual)
  }
  return parts
}

function attribute(prev, now, isNew, exited) {
  const src = exited ? prev : now
  const e = decompose(prev, now, isNew, exited)
  const delta = money(e.delta)
  const { market, flow, fx } = reconcile(money(e.market), money(e.flow), money(e.fx), delta)
  return {
    sleeve: src.sleeve, symbol: src.symbol, name: src.name || '', isin: src.isin || '',
    market, flow, fx, delta,
    value_prev: money(e.valuePrev), value_now: money(e.valueNow),
    qty_prev: num(prev.qty), qty_now: num(now.qty),
    new: isNew, exited, flagged: false,
  }
}

export function diff(prev, now) {
  const byKey = new Map(prev.map((p) => [matchKey(p), p]))
  const seen = new Set()
  const out = []
  for (const n of now) {
    const key = matchKey(n)
    seen.add(key)
    const p = byKey.get(key)
    out.push(attribute(p || {}, n, !p, false))
  }
  for (const p of prev) if (!seen.has(matchKey(p))) out.push(attribute(p, {}, false, true))
  return out.sort((a, b) => (a.sleeve === b.sleeve ? a.symbol.localeCompare(b.symbol) : a.sleeve.localeCompare(b.sleeve)))
}

/** Roll holdings up to sleeves. A single-holding flow above `threshold` of its
 * sleeve is flagged — a bonus or split raises quantity with no money in. */
export function bySleeve(attrs, threshold = 0.25) {
  const groups = new Map()
  for (const a of attrs) {
    if (!groups.has(a.sleeve)) groups.set(a.sleeve, { sleeve: a.sleeve, market: 0, flow: 0, fx: 0, delta: 0, value_prev: 0, value_now: 0, holdings: [] })
    const g = groups.get(a.sleeve)
    g.holdings.push(a)
    for (const k of ['market', 'flow', 'fx', 'delta', 'value_prev', 'value_now']) g[k] += a[k]
  }
  return [...groups.values()].sort((a, b) => a.sleeve.localeCompare(b.sleeve)).map((g) => {
    for (const k of ['market', 'flow', 'fx', 'delta', 'value_prev', 'value_now']) g[k] = money(g[k])
    const limit = threshold * Math.abs(g.value_now)
    if (limit) for (const h of g.holdings) h.flagged = Math.abs(h.flow) > limit
    return g
  })
}

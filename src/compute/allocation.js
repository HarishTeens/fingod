// Actual allocation against targets. The target's own keys define the base:
// remove a line from the target and it leaves the denominator too, with no code
// change — which is the escape hatch for EPF, a sleeve you cannot rebalance.
import { money, num } from './num.js'

export const DEFAULT_TARGET = { in_equity: 27, in_mf: 35, us_equity: 10, gold: 5, btc: 5, fd: 15, debt: 2, liquid: 1 }

export function allocate(nw, target) {
  const values = { ...nw.sleeves }
  if (nw.fd_principal) values.fd = nw.fd_principal
  if (nw.epf) values.epf = nw.epf
  if (nw.cash) values.liquid = nw.cash

  let base = 0
  for (const key of Object.keys(target)) if (values[key] !== undefined) base += values[key]

  const rows = Object.keys(target).sort().map((sleeve) => {
    const value = values[sleeve] || 0
    const t = num(target[sleeve])
    const share = base ? (value / base) * 100 : 0
    return {
      sleeve, value: money(value), target_pct: t,
      share_pct: money(share), drift_pp: money(base ? share - t : -t),
      to_move: money(base ? (t * base) / 100 - value : 0), // positive = buy, negative = sell
    }
  })
  const untargeted = {}
  for (const [k, v] of Object.entries(values)) if (!(k in target) && v) untargeted[k] = money(v)
  return { as_of_date: nw.as_of_date, base: money(base), rows, untargeted }
}

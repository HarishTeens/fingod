// Display formatting. Indian digit grouping, and compact lakh/crore forms.
import { num } from '../compute/num.js'

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 })
const inrPaise = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
export const money = (v) => `₹${inr.format(Math.round(num(v)))}`
export const moneyExact = (v) => `₹${inrPaise.format(num(v))}`
export const plain = (v, dp = 2) => num(v).toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp })

/** ₹1.2 Cr · ₹4.50 L · ₹12.3k */
export function compact(v) {
  const n = num(v), abs = Math.abs(n), sign = n < 0 ? '−' : ''
  if (abs >= 1e7) return `${sign}₹${(abs / 1e7).toFixed(2)} Cr`
  if (abs >= 1e5) return `${sign}₹${(abs / 1e5).toFixed(2)} L`
  if (abs >= 1e3) return `${sign}₹${(abs / 1e3).toFixed(1)}k`
  return `${sign}₹${Math.round(abs)}`
}
export const pct = (v, dp = 2) => (v === null || v === undefined ? '—' : `${num(v).toFixed(dp)}%`)

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec']
export const shortDate = (d) => { const [y, m, day] = d.split('-'); return `${Number(day)} ${MONTHS[Number(m) - 1]} '${y.slice(2)}` }
export const monthLabel = (d) => { const [y, m] = d.split('-'); return `${MONTHS[Number(m) - 1]} '${y.slice(2)}` }

export const SLEEVE_LABEL = {
  in_equity: 'IN Equity', in_mf: 'IN Mutual Funds', us_equity: 'US Equity', gold: 'Gold', debt: 'Debt',
  btc: 'Bitcoin', fd: 'Fixed Deposits', epf: 'EPF', liquid: 'Bank balances', cash: 'Bank balances', insurance: 'Insurance',
}
export const sleeveLabel = (s) => SLEEVE_LABEL[s] || s
export const sleeveColor = (s) => `var(--sleeve-${s === 'liquid' ? 'liquid' : s})`

/** A label keeps its colour whatever else is on screen: slot by a hash of its name. */
const slots = new Map()
export function labelColor(label) {
  if (label === 'Untagged') return 'var(--cat-untagged)'
  if (label === 'Other') return 'var(--cat-other)'
  if (!slots.has(label)) slots.set(label, slots.size % 8) // first come, first slot: no two visible labels share a hue
  return `var(--cat-${slots.get(label) + 1})`
}

/** ▲ +₹4.2k  /  ▼ −₹974 — status is icon + signed value + colour, never colour alone. */
export function delta(v, fmt = compact) {
  const n = num(v)
  if (n === 0) return `<span class="tnum">${fmt(0)}</span>`
  return `<span class="tnum" style="color:var(--${n > 0 ? 'good' : 'critical'})">${n > 0 ? '▲' : '▼'} ${n > 0 ? '+' : '−'}${fmt(Math.abs(n)).replace('−', '')}</span>`
}

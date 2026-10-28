// Expense views over Wallet transactions. Pure functions: pass transactions in,
// get chart-ready series out. A few rules keep the charts honest:
//
//   * Investments are not spend. SIP money is filed as an expense in Wallet;
//     folding it in would make the chart a picture of SIP dates.
//   * Transfers between your own accounts are excluded, including ones whose
//     mirror record was lost (they sit in Wallet's Transfer category).
//   * Money that came back is subtracted from the label it came back under, so a
//     bar is what something COST you, not what passed through your account.
//     Income counts only if it carries a label: your salary is untagged.
//   * A label that nets negative is clamped to zero and the clamped amount is
//     reported as net_inflow rather than silently dropped.
//   * Labels are many-to-many. Modifier labels (how it was paid, not what it
//     was for) step aside when the record has any other label, then what is left
//     shares the amount evenly — so the parts still sum to the whole.
import { money } from './num.js'

export const UNTAGGED = 'Untagged'
export const OTHER = 'Other'
export const MODIFIER_LABELS = ['Split']
export const INVESTMENT_CATEGORY = 'Investments'
export const INVESTMENT_LABEL = 'Investment'
export const TRANSFER_CATEGORY_ID = '5c5c4e21-00c8-8000-8000-000000000000' // Wallet's fixed registry id
const PALETTE = 8 // distinguishable categorical hues; the ninth label folds into Other

export function periodOf(date, granularity) {
  if (granularity === 'week') {
    const d = new Date(`${date}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)) // Monday
    return d.toISOString().slice(0, 10)
  }
  return `${date.slice(0, 7)}-01`
}

const inRange = (t, from, to) => (!from || t.txn_date >= from) && (!to || t.txn_date <= to)

function isCountable(t, labels) {
  if (t.is_transfer || !Number(t.amount_inr)) return false
  if ((t.category_top || '') === INVESTMENT_CATEGORY) return false
  if ((t.category_id || '') === TRANSFER_CATEGORY_ID) return false
  if ((t.category || '') !== 'Insurances' && labels.includes(INVESTMENT_LABEL)) return false
  return true
}

/** The labels a record answers to: modifiers step aside, or it is Untagged. */
function effectiveLabels(labels) {
  const tagged = labels.filter((l) => l !== INVESTMENT_LABEL)
  const real = tagged.filter((l) => !MODIFIER_LABELS.includes(l))
  const eff = real.length ? real : tagged
  return eff.length ? eff : [UNTAGGED]
}

/** The one computation the chart and the headline both read, so a bar and the
 * number above it can never disagree. Returns [{period, label, net}]. */
export function labelNets(txns, labelsById, granularity = 'month', from, to) {
  const cells = new Map()
  for (const t of txns) {
    const labels = labelsById.get(t.id) || []
    if (!inRange(t, from, to) || !isCountable(t, labels)) continue
    const amt = -Number(t.amount_inr) // expense positive, income negative
    const tagged = labels.filter((l) => l !== INVESTMENT_LABEL)
    if (!(amt > 0) && !tagged.length) continue // untagged income is not an offset
    const nonModifier = tagged.filter((l) => !MODIFIER_LABELS.includes(l))
    const effective = nonModifier.length ? nonModifier : tagged
    const parts = effective.length ? effective : [UNTAGGED]
    const period = periodOf(t.txn_date, granularity)
    for (const label of parts) {
      const k = `${period}\0${label}`
      cells.set(k, (cells.get(k) || 0) + amt / parts.length)
    }
  }
  return [...cells.entries()].map(([k, net]) => {
    const [period, label] = k.split('\0')
    return { period, label, net }
  })
}

export function expenseByLabel(txns, labelsById, granularity = 'month', from, to, top = PALETTE) {
  const cells = labelNets(txns, labelsById, granularity, from, to)
  const totals = new Map()
  for (const c of cells) if (c.net > 0 && c.label !== UNTAGGED) totals.set(c.label, (totals.get(c.label) || 0) + c.net)
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([l]) => l)
  const keep = new Set(ranked.slice(0, top))
  const hasOther = ranked.length > top
  const hasUntagged = cells.some((c) => c.label === UNTAGGED && c.net > 0)

  const periods = new Map()
  for (const c of cells) {
    if (!periods.has(c.period)) periods.set(c.period, { period: c.period, total: 0, segments: {}, net_inflow: 0 })
    const p = periods.get(c.period)
    if (c.net <= 0) { p.net_inflow += -c.net; continue }
    const name = c.label === UNTAGGED || keep.has(c.label) ? c.label : OTHER
    p.segments[name] = (p.segments[name] || 0) + c.net
    p.total += c.net
  }
  const series = [...periods.values()].sort((a, b) => a.period.localeCompare(b.period)).map((p) => ({
    period: p.period, total: money(p.total), net_inflow: money(p.net_inflow),
    segments: Object.fromEntries(Object.entries(p.segments).map(([k, v]) => [k, money(v)])),
  }))
  const labels = [...ranked.slice(0, top)]
  if (hasOther) labels.push(OTHER)
  if (hasUntagged) labels.push(UNTAGGED)
  return { labels, series }
}

/** Gross spend (no netting) by category → subcategory, for drilling into a period. */
export function breakdown(txns, labelsById, { period, granularity = 'month', by = 'category', category, subcategory, label } = {}) {
  const rows = new Map()
  let total = 0
  for (const t of txns) {
    const labels = labelsById.get(t.id) || []
    if (!isCountable(t, labels) || !(Number(t.amount_inr) < 0)) continue
    if (period && periodOf(t.txn_date, granularity) !== period) continue
    if (category && (t.category_top || 'Uncategorised') !== category) continue
    if (subcategory && (t.category || 'Uncategorised') !== subcategory) continue
    if (label && !(label === UNTAGGED ? labels.length === 0 : labels.includes(label))) continue
    const amt = -Number(t.amount_inr)
    const names = by === 'label' ? effectiveLabels(labels) : [category ? t.category || 'Uncategorised' : t.category_top || 'Uncategorised']
    for (const n of names) {
      const r = rows.get(n) || { key: n, amount: 0, count: 0 }
      r.amount += amt / names.length; r.count++
      rows.set(n, r)
    }
    total += amt
  }
  return { total: money(total), rows: [...rows.values()].map((r) => ({ ...r, amount: money(r.amount) })).sort((a, b) => b.amount - a.amount) }
}

export function listTransactions(txns, labelsById, { period, granularity = 'month', category, subcategory, label, limit = 200 } = {}) {
  return txns.filter((t) => {
    const labels = labelsById.get(t.id) || []
    if (!isCountable(t, labels) || !(Number(t.amount_inr) < 0)) return false
    if (period && periodOf(t.txn_date, granularity) !== period) return false
    if (category && (t.category_top || 'Uncategorised') !== category) return false
    if (subcategory && (t.category || 'Uncategorised') !== subcategory) return false
    if (label && !(label === UNTAGGED ? labels.length === 0 : labels.includes(label))) return false
    return true
  }).sort((a, b) => b.txn_date.localeCompare(a.txn_date)).slice(0, limit).map((t) => ({ ...t, labels: labelsById.get(t.id) || [] }))
}

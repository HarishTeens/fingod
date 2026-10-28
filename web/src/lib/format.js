// Money is text all the way from Postgres NUMERIC, so it is parsed to a number
// only here, at the moment of display. Nothing computes with these.

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 })
const inrPaise = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export const num = (v) => (v === null || v === undefined ? 0 : Number(v))

export const money = (v) => `₹${inr.format(Math.round(num(v)))}`
export const moneyExact = (v) => `₹${inrPaise.format(num(v))}`

/** Indian short scale: what a person actually says out loud. */
export function compact(v) {
  const n = num(v)
  const abs = Math.abs(n)
  const sign = n < 0 ? '−' : ''
  if (abs >= 1e7) return `${sign}₹${(abs / 1e7).toFixed(2)} Cr`
  if (abs >= 1e5) return `${sign}₹${(abs / 1e5).toFixed(2)} L`
  if (abs >= 1e3) return `${sign}₹${(abs / 1e3).toFixed(1)}k`
  return `${sign}₹${Math.round(abs)}`
}

export const pct = (v) => `${num(v).toFixed(1)}%`

/** Signed, for a delta. Always paired with an icon and a colour, never colour alone. */
export const signed = (v) => (num(v) >= 0 ? `+${compact(v)}` : compact(v))

/* Dates carry the year, and carry it the way people write it: 15 Aug '24.
 *
 * Without it a table spanning five years of trades reads as though everything
 * happened this year — and the apostrophe form is short enough for an axis tick
 * where "15 August 2024" is not. Intl has no such format, hence the assembly. */
const parts = (iso) => {
  const d = new Date(`${iso}T00:00:00Z`)
  return {
    day: d.getUTCDate(),
    month: d.toLocaleDateString('en-IN', { month: 'short', timeZone: 'UTC' }),
    yy: String(d.getUTCFullYear()).slice(2),
  }
}

export const shortDate = (iso) => {
  const { day, month, yy } = parts(iso)
  return `${day} ${month} '${yy}`
}

export const monthLabel = (iso) => {
  const { month, yy } = parts(iso)
  return `${month} '${yy}`
}

/** Day and month only — for an axis dense enough that the year would collide. */
export const dayMonth = (iso) => {
  const { day, month } = parts(iso)
  return `${day} ${month}`
}

export const SLEEVE_LABELS = {
  in_equity: 'IN Equity',
  in_mf: 'IN Mutual Funds',
  us_equity: 'US Equity',
  gold: 'Gold',
  debt: 'Debt',
  btc: 'Bitcoin',
  liquid: 'Bank balances',
  insurance: 'Insurance-linked',
  fd: 'Fixed Deposits',
  epf: 'EPF',
  cash: 'Cash',
}

export const sleeveLabel = (k) => SLEEVE_LABELS[k] || k
export const sleeveColor = (k) => `var(--sleeve-${k}, var(--muted))`

/** Fixed order — colours follow the entity, never its rank in the current data. */
/* Fixed, and the same order the palette was validated in — adjacent pairs are
   what clear the CVD checks, so reordering means re-running the validator. */
export const SLEEVE_ORDER = ['in_equity', 'in_mf', 'us_equity', 'gold', 'debt', 'fd', 'btc', 'epf', 'liquid', 'insurance', 'cash']

export const bySleeveOrder = (a, b) => {
  const ia = SLEEVE_ORDER.indexOf(a)
  const ib = SLEEVE_ORDER.indexOf(b)
  return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
}

/* --- label colours ---------------------------------------------------------
 *
 * Labels are user-defined, so unlike sleeves they cannot carry fixed semantic
 * colours. A slot is picked from a hash of the label's own name, which makes
 * the colour a property of the entity rather than of its rank: "House" looks
 * the same in every period, and adding or removing a label never repaints the
 * others. That is the colour rule a stacked chart must not break, because the
 * series count changes with the date range.
 */
// Eight, matching the validated palette. Not seven and not nine: nine
// categorical hues is past what is reliably distinguishable, and anything
// beyond these folds into Other rather than getting a generated colour.
const CAT_SLOTS = 8

export const UNTAGGED = 'Untagged'
export const OTHER = 'Other'

function hashSlot(name) {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0
  return Math.abs(h) % CAT_SLOTS
}

/** Probes forward on collision, so two labels shown together never share a hue. */
export function labelColors(labels) {
  const taken = new Set()
  const out = {}
  for (const l of labels) {
    if (l === UNTAGGED) { out[l] = 'var(--cat-untagged)'; continue }
    if (l === OTHER) { out[l] = 'var(--cat-other)'; continue }
    let slot = hashSlot(l)
    for (let i = 0; i < CAT_SLOTS && taken.has(slot); i++) slot = (slot + 1) % CAT_SLOTS
    taken.add(slot)
    out[l] = `var(--cat-${slot + 1})`
  }
  return out
}

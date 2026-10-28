// Money helpers. The engine works in JS numbers and rounds to paise at the
// edges; every aggregate that has to add up exactly is reconciled explicitly
// (see qtydiff.reconcile) rather than trusting float addition.

export const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v))

/** Round to 2 decimals, half away from zero, and never return -0. */
export const money = (x) => {
  const r = Math.sign(x) * Math.round(Math.abs(x) * 100 + 1e-7) / 100
  return r === 0 ? 0 : r
}

export const sum = (xs) => xs.reduce((a, b) => a + b, 0)

/** (a / b) * 100, rounded to 2 decimals; null when b is zero. */
export const pct = (a, b) => (b === 0 ? null : money((a / b) * 100))

/** YYYY-MM-DD → UTC midnight ms, so date arithmetic never trips on DST. */
export const dayMs = (d) => Date.parse(`${d}T00:00:00Z`)
export const daysBetween = (a, b) => Math.round((dayMs(b) - dayMs(a)) / 86400000)

// Fixed-deposit interest, valued by formula at any date — so a deposit entered
// today still prices correctly at checkpoints taken before it existed.
import { num, money, dayMs, daysBetween } from './num.js'

export const DAYS_PER_YEAR = 365

function accrualEnd(fd, at) {
  let end = at
  if (fd.maturity_date && dayMs(fd.maturity_date) < dayMs(end)) end = fd.maturity_date
  if (fd.closed_at && dayMs(fd.closed_at) < dayMs(end)) end = fd.closed_at
  return end
}

/** Interest accrued by `at`: quarterly compounding by default, or simple. */
export function accrued(fd, at) {
  const days = daysBetween(fd.start_date, accrualEnd(fd, at))
  if (days <= 0) return 0
  const years = days / DAYS_PER_YEAR
  const p = num(fd.principal)
  const r = num(fd.rate_pct) / 100
  const interest = fd.compounding === 'simple' ? p * r * years : p * (Math.pow(1 + r / 4, 4 * years) - 1)
  if (!Number.isFinite(interest)) throw new Error(`fd ${fd.bank}: interest is not a finite number`)
  return money(interest)
}

/** Whether the deposit is running at `at` (started, and not yet closed). */
export function isLive(fd, at) {
  if (dayMs(at) < dayMs(fd.start_date)) return false
  if (fd.closed_at && dayMs(at) >= dayMs(fd.closed_at)) return false
  return true
}

export function value(fd, at) {
  return isLive(fd, at) ? money(num(fd.principal) + accrued(fd, at)) : 0
}

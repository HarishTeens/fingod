import { signed, num } from '../lib/format.js'

/**
 * Gain and loss are a status channel, rendered as icon + signed value + colour.
 * Never colour alone — partly for colourblind readers, and partly because the
 * series green already sits close to the status green.
 */
export function DeltaChip({ label, value, hint }) {
  if (value === null || value === undefined) {
    return (
      <span className="chip" title={hint}>
        {label} <span className="val">—</span>
      </span>
    )
  }
  const up = num(value) >= 0
  return (
    <span className={`chip ${up ? 'good' : 'bad'}`} title={hint}>
      {label}{' '}
      <span className="val">
        {up ? '▲' : '▼'} {signed(value)}
      </span>
    </span>
  )
}

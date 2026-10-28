import { useState } from 'react'
import { compact, num } from '../lib/format.js'

// The validated categorical ramp, in its validated order. Eight is the ceiling
// for hues anyone can reliably tell apart, so a ninth series folds into Other
// rather than being handed a generated colour.
const SLOTS = 8
const MIN_VISIBLE = 0.8 // percent — below this a segment is a hairline nobody can hit

/**
 * One bar, the width of the card, split by share.
 *
 * A bar rather than a pie because comparing lengths along a common baseline is
 * something people do accurately and comparing angles is not, and because
 * fifteen thin slices of a pie are unreadable where fifteen segments of a bar
 * still are.
 *
 * Ordered by size regardless of how the table above is sorted. Sorting the bar
 * by "since bought" would produce a ranking of returns drawn at widths that
 * mean something else entirely.
 */
export function ProportionBar({ items, total, unit = 'of this sleeve' }) {
  const [hovered, setHovered] = useState(null)

  const ranked = [...items].filter((i) => num(i.value) > 0).sort((a, b) => num(b.value) - num(a.value))
  if (!ranked.length) return null

  const head = ranked.slice(0, SLOTS)
  const tail = ranked.slice(SLOTS)
  const segments = head.map((it, i) => ({
    key: it.key,
    label: it.label,
    value: num(it.value),
    pct: num(it.pct),
    color: `var(--cat-${i + 1})`,
  }))
  if (tail.length) {
    segments.push({
      key: '__other',
      label: `${tail.length} smaller`,
      value: tail.reduce((s, i) => s + num(i.value), 0),
      pct: tail.reduce((s, i) => s + num(i.pct), 0),
      color: 'var(--cat-other)',
    })
  }

  return (
    <div className="proportion">
      <div className="proportion-bar" role="img"
           aria-label={segments.map((s) => `${s.label} ${s.pct.toFixed(1)}%`).join(', ')}>
        {segments.map((s) => (
          <span
            key={s.key}
            className="seg"
            style={{
              // Tiny holdings still get a sliver you can point at. It costs the
              // large segments a fraction of a percent of width, which is
              // invisible, and buys a hit target where there was none.
              flexGrow: Math.max(s.pct, MIN_VISIBLE),
              background: s.color,
              opacity: hovered && hovered !== s.key ? 0.4 : 1,
            }}
            title={`${s.label} · ${compact(s.value)} · ${s.pct.toFixed(2)}%`}
            onMouseEnter={() => setHovered(s.key)}
            onMouseLeave={() => setHovered(null)}
          />
        ))}
      </div>

      <div className="proportion-legend">
        {segments.map((s) => (
          <span
            key={s.key}
            style={{ opacity: hovered && hovered !== s.key ? 0.45 : 1 }}
            onMouseEnter={() => setHovered(s.key)}
            onMouseLeave={() => setHovered(null)}
          >
            <i className="swatch" style={{ background: s.color }} aria-hidden="true" />
            {s.label}
            <b>{s.pct.toFixed(1)}%</b>
          </span>
        ))}
      </div>

      {total ? (
        <p className="note">
          Share {unit}, largest first — the order does not follow the table's sort, because widths
          drawn in return order would mean nothing. {compact(total)} across {ranked.length}{' '}
          {ranked.length === 1 ? 'holding' : 'holdings'}.
        </p>
      ) : null}
    </div>
  )
}

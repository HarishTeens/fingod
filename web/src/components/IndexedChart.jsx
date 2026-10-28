import { useMemo, useState } from 'react'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts'
import { Legend } from './Card.jsx'
import { compact, dayMonth, monthLabel, num, shortDate, sleeveColor, sleeveLabel } from '../lib/format.js'

/**
 * Sleeves normalised to 100 at the start of the range.
 *
 * Indexing rather than plotting rupees is what lets ₹10L of mutual funds and
 * ₹50k of debt share one honest chart. The alternative — two y-axes — is the
 * single most common charting mistake, and makes any two series look however
 * you scaled them.
 */
function IndexTooltip({ active, payload, label, monthly }) {
  if (!active || !payload?.length) return null
  return (
    <div className="tooltip">
      <div className="head">{monthly ? monthLabel(label) : shortDate(label)}</div>
      {[...payload]
        .filter((p) => p.value != null)
        .sort((a, b) => b.value - a.value)
        .map((p) => (
          <div className="row" key={p.dataKey}>
            <span>{sleeveLabel(p.dataKey)}</span>
            <span className="v" style={{ marginLeft: 16 }}>
              {p.value.toFixed(1)}
              <span style={{ color: 'var(--muted)' }}>
                {' '}({p.value >= 100 ? '+' : ''}{(p.value - 100).toFixed(1)}%)
              </span>
            </span>
          </div>
        ))}
    </div>
  )
}

/** Keeps the last checkpoint of each month — the month's closing position. */
function toMonthly(series) {
  const byMonth = new Map()
  for (const pt of series) byMonth.set(pt.as_of.slice(0, 7), pt)
  return [...byMonth.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([m, pt]) => ({ ...pt, as_of: `${m}-01` }))
}

export function IndexedChart({ series, sleeves, defaultMonthly = true, rangeHint }) {
  const [monthly, setMonthly] = useState(defaultMonthly)
  const monthlyPoints = useMemo(() => toMonthly(series), [series])

  // Monthly keeps one point per month, so three checkpoints inside a single
  // month collapse to one — and a line needs two. Falling back to every
  // checkpoint is better than rendering an axis with nothing on it, which is
  // what this did before and read as "no data" when there was plenty.
  const canMonthly = monthlyPoints.length >= 2
  const showMonthly = monthly && canMonthly
  const points = showMonthly ? monthlyPoints : series

  if (series.length < 2) {
    return (
      <div className="empty">
        <strong>A performance line needs at least two checkpoints.</strong>
        <div style={{ marginTop: 8 }}>
          {series.length === 1 && rangeHint
            ? <>Only one falls inside {rangeHint}. Widen the range above — the earlier ones are
               still there, just outside this window.</>
            : <>There {series.length === 1 ? 'is one' : 'are none'} so far. Every <code>/refresh</code> adds
               one, so this fills in from your second — a line per sleeve, indexed to 100.</>}
        </div>
      </div>
    )
  }

  const data = points.map((pt, i) => {
    const row = { date: pt.as_of }
    for (const s of sleeves) {
      const start = num(points[0].values[s])
      // A sleeve that did not exist at the start has no base to index against,
      // so it stays absent rather than being drawn from an invented 100.
      row[s] = start ? (num(pt.values[s]) / start) * 100 : null
    }
    return row
  })

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 6 }}>
        {canMonthly ? (
          <button className="btn" aria-pressed={monthly} onClick={() => setMonthly(!monthly)}>
            {showMonthly ? `Monthly (${data.length})` : `Every checkpoint (${data.length})`}
          </button>
        ) : (
          /* Not hidden: a control that silently disappears looks like a bug.
             Saying why is the point. */
          <span style={{ color: 'var(--muted)', fontSize: 12 }}>
            {data.length} checkpoints, all within one month — monthly needs two to draw a line
          </span>
        )}
      </div>
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={data} margin={{ top: 12, right: 52, bottom: 4, left: 4 }}>
          <CartesianGrid stroke="var(--gridline)" vertical={false} />
          {/* Per-checkpoint can be 52 points across a year, where the year on
              every tick would collide. The tooltip carries it. */}
          <XAxis
            dataKey="date" tickFormatter={showMonthly ? monthLabel : dayMonth}
            tick={{ fill: 'var(--muted)', fontSize: 11 }}
            axisLine={{ stroke: 'var(--baseline)' }} tickLine={false} className="tnum"
          />
          <YAxis
            width={44} tick={{ fill: 'var(--muted)', fontSize: 11 }}
            axisLine={false} tickLine={false} className="tnum" domain={['auto', 'auto']}
          />
          {/* 100 is "no change" — the line everything is read against. */}
          <ReferenceLine y={100} stroke="var(--baseline)" strokeDasharray="3 3" />
          <Tooltip content={<IndexTooltip monthly={showMonthly} />} cursor={{ stroke: 'var(--baseline)', strokeWidth: 1 }} />
          {sleeves.map((s) => (
            <Line
              key={s} type="monotone" dataKey={s} stroke={sleeveColor(s)}
              strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false}
              activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--card)' }}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
      <Legend items={sleeves.map((s) => ({ key: s, label: sleeveLabel(s), color: sleeveColor(s) }))} />
      <p className="note">
        Every sleeve starts at 100 on {showMonthly ? monthLabel(data[0].date) : shortDate(data[0].date)},
        so the lines compare <em>rates</em> of change rather than sizes — the only honest way to put
        ₹10L of mutual funds and ₹50k of debt on one axis. A line above 100 has grown since then.
        {showMonthly && ' Monthly points are each month’s last checkpoint.'}
      </p>
    </>
  )
}

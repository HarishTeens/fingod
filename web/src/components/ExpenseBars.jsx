import { useState } from 'react'
import { BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { Card, TableToggle, Swatch } from './Card.jsx'
import { usePaged } from '../lib/usePaged.jsx'
import { compact, moneyExact, monthLabel, shortDate, num, labelColors } from '../lib/format.js'

/**
 * One segment, one number.
 *
 * A stacked bar's default tooltip lists every series at that x, which for seven
 * labels is a wall of figures you have to scan to find the one under the
 * cursor. Tracking the hovered segment and showing only that is the whole point
 * of pointing at it.
 */
function SegmentTooltip({ active, payload, hovered, colors }) {
  if (!active || !hovered) return null
  const row = payload?.find((p) => p.dataKey === hovered)
  if (!row) return null
  return (
    <div className="tooltip">
      <div className="row">
        <span>
          <Swatch color={colors[hovered]} />
          {hovered}
        </span>
        <span className="v" style={{ marginLeft: 16 }}>{moneyExact(row.value)}</span>
      </div>
      {row.payload?.netInflow > 0 && (
        <div className="row" style={{ color: 'var(--muted)', marginTop: 4 }}>
          <span>came back beyond spending</span>
          <span className="v" style={{ marginLeft: 16 }}>{moneyExact(row.payload.netInflow)}</span>
        </div>
      )}
    </div>
  )
}

export function ExpenseBars({
  series,
  labels,
  granularity = 'month',
  title = 'Monthly spend by label',
  extraActions = null,
  selectedPeriod = null,
  onSelectPeriod = null,
}) {
  const [table, setTable] = useState(false)
  const [hovered, setHovered] = useState(null)
  const [selected, setSelected] = useState(() => new Set())

  // Colours are assigned from the full label set, never the visible one, so
  // filtering cannot repaint the labels that survive.
  const colors = labelColors(labels)
  const fmtPeriod = granularity === 'week' ? shortDate : monthLabel

  // Empty selection means everything. Selecting is the more useful default for
  // a stack of eight: "show me only House" is one click, where hiding the other
  // seven would be seven.
  const shown = selected.size === 0 ? labels : labels.filter((l) => selected.has(l))

  // A plain click adds or removes. That single rule covers every case without a
  // modifier key: the first click leaves one label selected, so it reads as
  // "show only this"; more clicks build a comparison; unselecting the last one
  // empties the set and everything comes back.
  //
  // The previous version isolated on click and hid multi-select behind
  // shift/cmd. Nobody finds a modifier they were not told about, so the feature
  // may as well not have existed.
  const pick = (label) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(label)) next.delete(label)
      else next.add(label)
      return next
    })

  // Totals follow the filter: with a label hidden, the bar shows what is left,
  // not a gap where the segment used to be.
  const data = series.map((b) => {
    const seg = Object.fromEntries(shown.map((l) => [l, num(b.segments?.[l] ?? 0)]))
    return {
      period: b.period,
      total: Object.values(seg).reduce((a, v) => a + v, 0),
      netInflow: num(b.net_inflow),
      ...seg,
    }
  })
  const totalInflow = data.reduce((a, d) => a + d.netInflow, 0)
  const { visible: tablePage, pager: tablePager } = usePaged([...data].reverse())

  return (
    <Card
      title={title}
      actions={
        <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {extraActions}
          <TableToggle showing={table} onToggle={() => setTable(!table)} />
        </span>
      }
    >
      {data.length === 0 ? (
        <div className="empty">No transactions ingested yet.</div>
      ) : table ? (
        <>
        <table className="data">
          <thead>
            <tr>
              <th>Month</th>
              {shown.map((l) => <th key={l} className="num">{l}</th>)}
              <th className="num">Total</th>
            </tr>
          </thead>
          <tbody>
            {tablePage.map((d) => (
              <tr key={d.period}>
                <td className="name">{fmtPeriod(d.period)}</td>
                {shown.map((l) => (
                  <td key={l} className="num">{d[l] ? moneyExact(d[l]) : '—'}</td>
                ))}
                <td className="num" style={{ color: 'var(--ink)' }}>{moneyExact(d.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {tablePager}
        </>
      ) : (
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={data} margin={{ top: 10, right: 8, bottom: 4, left: 4 }}>
            <CartesianGrid stroke="var(--gridline)" vertical={false} />
            <XAxis
              dataKey="period" tickFormatter={fmtPeriod}
              tick={{ fill: 'var(--muted)', fontSize: 11 }}
              axisLine={{ stroke: 'var(--baseline)' }} tickLine={false} className="tnum"
            />
            <YAxis
              tickFormatter={compact} width={64}
              tick={{ fill: 'var(--muted)', fontSize: 11 }}
              axisLine={false} tickLine={false} className="tnum"
            />
            <Tooltip
              content={<SegmentTooltip hovered={hovered} colors={colors} />}
              cursor={false}
              isAnimationActive={false}
            />
            {shown.map((l, i) => (
              <Bar
                key={l} dataKey={l} stackId="spend" fill={colors[l]}
                maxBarSize={38} isAnimationActive={false}
                cursor={onSelectPeriod ? 'pointer' : undefined}
                /* Guarded: if Recharts ever hands back a shape without the
                   payload, a bare call would set the period to undefined and
                   collapse the whole drill-down instead of doing nothing. */
                onClick={
                  onSelectPeriod
                    ? (d) => { const p = d?.payload?.period; if (p) onSelectPeriod(p) }
                    : undefined
                }
                /* The unselected periods fade rather than the selected one
                   highlighting: dimming context keeps the chosen bar at full
                   colour, so its segments stay readable while it is the one
                   being drilled into. */
                /* 4px rounded ends on the top segment only, so the stack reads
                   as one bar anchored to the baseline rather than a pile. */
                radius={i === shown.length - 1 ? [4, 4, 0, 0] : 0}
                /* 2px surface gap between adjacent fills. */
                stroke="var(--card)" strokeWidth={1}
                onMouseEnter={() => setHovered(l)}
                onMouseLeave={() => setHovered(null)}
              >
                {/* Context fades rather than the selection brightening, so the
                    chosen bar keeps full colour and its segments stay readable
                    while it is the one being drilled into. */}
                {data.map((d) => (
                  <Cell
                    key={d.period}
                    opacity={selectedPeriod && d.period !== selectedPeriod ? 0.34 : 1}
                  />
                ))}
              </Bar>
            ))}
          </BarChart>
        </ResponsiveContainer>
      )}

      {/* Legend is always present for two or more series, doubles as the relief
          for a stack whose adjacency the palette cannot guarantee, and is the
          filter. Real buttons, so it is reachable by keyboard and announces its
          state — a click target that only works with a mouse is half a control. */}
      <div className="legend">
        {labels.map((l) => {
          const on = selected.size === 0 || selected.has(l)
          return (
            <button
              key={l}
              type="button"
              className="legend-toggle"
              aria-pressed={selected.has(l)}
              title={selected.has(l) ? `Remove ${l} from the selection` : `Add ${l}`}
              onClick={() => pick(l)}
              onMouseEnter={() => on && setHovered(l)}
              onMouseLeave={() => setHovered(null)}
              style={{
                opacity: on ? (hovered && hovered !== l ? 0.55 : 1) : 0.35,
                fontWeight: selected.has(l) ? 600 : 400,
              }}
            >
              <Swatch color={colors[l]} />
              <span>{l}</span>
            </button>
          )
        })}
        {selected.size > 0 && (
          <button type="button" className="btn" onClick={() => setSelected(new Set())}>
            Clear
          </button>
        )}
      </div>

      <p className="note">
        {selected.size > 0 && (
          <>
            <strong>Showing {shown.length} of {labels.length} labels</strong> — bar heights are a
            subset of each month's spend, not the whole of it. Click labels to add or remove them;
            with none selected you see everything.{' '}
          </>
        )}
        <strong>Net of money that came back.</strong> Income you tagged with the same label is
        subtracted from it, so a bar is what something <em>cost</em> you rather than what passed
        through your account. Salary is untagged and never subtracted.
        {totalInflow > 0 && (
          <>
            {' '}Across these periods {compact(totalInflow)} came back under labels that ended net
            positive — money in, not spending, so it is held out of the bars rather than drawn as a
            negative one.
          </>
        )}
        {' '}Repayments landing in a later month than the spending cannot net against it: a December
        trip repaid in January shows full cost in December and the repayment as an inflow in January.
        <br />
        Excludes transfers between your own accounts and anything in Wallet's <em>Investments</em>
        {' '}category. Labels are many-to-many, so a record with several gives its whole amount to the
        label that says <em>what</em> it was — <em>Split</em> describes how it was paid and steps
        aside unless it is the only label. Anything still sharing divides evenly, the segments add up
        to the period exactly, and <em>Untagged</em> is always shown.
      </p>
    </Card>
  )
}

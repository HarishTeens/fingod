import { useState } from 'react'
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts'
import { Card, TableToggle, Swatch } from './Card.jsx'
import { usePaged } from '../lib/usePaged.jsx'
import { compact, moneyExact, num, pct, sleeveColor, sleeveLabel } from '../lib/format.js'

function DonutTooltip({ active, payload }) {
  if (!active || !payload?.length) return null
  const d = payload[0].payload
  return (
    <div className="tooltip">
      <div className="head">{sleeveLabel(d.sleeve)}</div>
      <div className="row">
        <span>Value</span><span className="v">{moneyExact(d.value)}</span>
      </div>
      <div className="row">
        <span>Share</span><span className="v">{pct(d.share)}</span>
      </div>
    </div>
  )
}

export function AllocationDonut({ allocation }) {
  const [table, setTable] = useState(false)

  // Sorted by size, largest first — the question this panel answers is "what am
  // I mostly in", and that should be readable top-down without hunting.
  //
  // The cost: colours are still fixed per sleeve (they follow the entity, never
  // its rank), but *adjacency* now depends on the data, so the palette's
  // adjacent-pair CVD guarantee no longer holds — US Equity's green and EPF's
  // green can land side by side, and re-stepping either just moves the problem
  // to another pair. Nine hues is past what is reliably distinguishable. That is
  // why the labelled table below the ring is always visible and sorted the same
  // way: it, not the colour, is what identifies a segment.
  const rows = [...(allocation?.rows ?? [])]
    .filter((r) => num(r.value) > 0)
    .sort((a, b) => num(b.value) - num(a.value))
    .map((r) => ({
      sleeve: r.sleeve,
      value: num(r.value),
      share: num(r.share_pct),
      color: sleeveColor(r.sleeve),
    }))

  const { visible: page, pager } = usePaged(rows)

  return (
    <Card title="Allocation" actions={<TableToggle showing={table} onToggle={() => setTable(!table)} />}>
      {rows.length === 0 ? (
        <div className="empty">No checkpoint yet.</div>
      ) : table ? (
        <table className="data">
          <thead>
            <tr><th>Sleeve</th><th className="num">Value</th><th className="num">Share</th></tr>
          </thead>
          <tbody>
            {page.map((r) => (
              <tr key={r.sleeve}>
                <td className="name"><Swatch color={r.color} />{sleeveLabel(r.sleeve)}</td>
                <td className="num">{moneyExact(r.value)}</td>
                <td className="num">{pct(r.share)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <ResponsiveContainer width="100%" height={230}>
          <PieChart>
            <Pie
              data={rows} dataKey="value" nameKey="sleeve"
              innerRadius="58%" outerRadius="86%"
              /* A 2px surface gap between adjacent fills, so segments read as
                 separate marks rather than one continuous ring. */
              paddingAngle={1.4} stroke="var(--card)" strokeWidth={2}
              isAnimationActive={false}
            >
              {rows.map((r) => <Cell key={r.sleeve} fill={r.color} />)}
            </Pie>
            <Tooltip content={<DonutTooltip />} />
          </PieChart>
        </ResponsiveContainer>
      )}

      {pager}
      {/* Load-bearing relief, not decoration: with the ring sorted by value the
          palette's adjacency guarantee is gone, so this table is what tells one
          segment from another. Same order as the ring. */}
      <table className="data" style={{ marginTop: 10 }}>
        <tbody>
          {rows.map((r) => (
            <tr key={r.sleeve}>
              <td className="name" style={{ padding: '5px 10px' }}>
                <Swatch color={r.color} />{sleeveLabel(r.sleeve)}
              </td>
              <td className="num" style={{ padding: '5px 10px' }}>{pct(r.share)}</td>
              <td className="num" style={{ padding: '5px 10px' }}>{compact(r.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  )
}

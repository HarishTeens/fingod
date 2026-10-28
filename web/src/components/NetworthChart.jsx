import { useState } from 'react'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LabelList,
} from 'recharts'
import { Card, TableToggle, Legend } from './Card.jsx'
import { usePaged } from '../lib/usePaged.jsx'
import { compact, moneyExact, shortDate, num } from '../lib/format.js'

// Both series are rupees, so they share one axis. There is no dual-axis chart
// anywhere in fingod — see docs/PLAN.md.
const SERIES = [
  { key: 'total', label: 'Total', color: 'var(--ink)' },
  { key: 'liquid', label: 'Liquid', color: 'var(--sleeve-in_equity)' },
]

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  return (
    <div className="tooltip">
      <div className="head">{shortDate(label)}</div>
      {payload.map((p) => (
        <div className="row" key={p.dataKey}>
          <span>{SERIES.find((s) => s.key === p.dataKey)?.label ?? p.dataKey}</span>
          <span className="v">{moneyExact(p.value)}</span>
        </div>
      ))}
    </div>
  )
}

export function NetworthChart({ series }) {
  const [table, setTable] = useState(false)
  const data = series.map((n) => ({
    date: n.as_of_date,
    liquid: num(n.liquid),
    total: num(n.total),
  }))
  const { visible: tablePage, pager: tablePager } = usePaged([...data].reverse())

  return (
    <Card title="Net worth" actions={<TableToggle showing={table} onToggle={() => setTable(!table)} />}>
      {data.length < 2 && !table ? (
        <div className="empty">
          A trend needs two checkpoints. There {data.length === 1 ? 'is one' : 'are none'} so far —
          run <code>/refresh</code> again next week and this fills in.
        </div>
      ) : table ? (
        <>
        <table className="data">
          <thead>
            <tr>
              <th>Date</th>
              <th className="num">Liquid</th>
              <th className="num">Total</th>
            </tr>
          </thead>
          <tbody>
            {tablePage.map((d) => (
              <tr key={d.date}>
                <td className="name">{shortDate(d.date)}</td>
                <td className="num">{moneyExact(d.liquid)}</td>
                <td className="num">{moneyExact(d.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {tablePager}
        </>
      ) : (
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={data} margin={{ top: 12, right: 56, bottom: 4, left: 4 }}>
            <CartesianGrid stroke="var(--gridline)" vertical={false} />
            <XAxis
              dataKey="date" tickFormatter={shortDate}
              tick={{ fill: 'var(--muted)', fontSize: 11 }}
              axisLine={{ stroke: 'var(--baseline)' }} tickLine={false}
              className="tnum"
            />
            <YAxis
              tickFormatter={compact} width={70}
              tick={{ fill: 'var(--muted)', fontSize: 11 }}
              axisLine={false} tickLine={false} className="tnum"
            />
            <Tooltip content={<ChartTooltip />} cursor={{ stroke: 'var(--baseline)', strokeWidth: 1 }} />
            {SERIES.map((s) => (
              <Line
                key={s.key} type="monotone" dataKey={s.key}
                stroke={s.color} strokeWidth={2} dot={false}
                activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--card)' }}
                isAnimationActive={false}
              >
                {/* Two series, so both are direct-labelled at the line end as
                    well as carrying a legend — identity is never colour alone. */}
                <LabelList
                  dataKey={s.key} position="right" formatter={compact}
                  style={{ fill: s.color, fontSize: 11 }}
                  content={({ x, y, value, index }) =>
                    index === data.length - 1 ? (
                      <text x={x + 8} y={y + 4} fill={s.color} fontSize={11}>
                        {compact(value)}
                      </text>
                    ) : null
                  }
                />
              </Line>
            ))}
          </LineChart>
        </ResponsiveContainer>
      )}
      <Legend items={SERIES.map((s) => ({ key: s.key, label: s.label, color: s.color }))} />
      <p className="note">
        Total includes EPF, accrued FD interest and Splitwise receivables. Liquid is what could
        actually be turned into money.
      </p>
    </Card>
  )
}

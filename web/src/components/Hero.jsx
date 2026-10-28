import { LineChart, Line, ResponsiveContainer, YAxis } from 'recharts'
import { Card } from './Card.jsx'
import { DeltaChip } from './DeltaChip.jsx'
import { compact, moneyExact, num, shortDate } from '../lib/format.js'

/**
 * Fold-style hero: one large figure with a sparkline directly beneath it, the
 * second figure alongside, and delta chips under both.
 *
 * The sparkline has no axes, no grid and no tooltip on purpose — its job is the
 * shape of the last few weeks, and the chart below answers everything else.
 */
export function Hero({ series }) {
  const latest = series[series.length - 1]
  const previous = series.length > 1 ? series[series.length - 2] : null
  if (!latest) return null

  const spark = series.map((n) => ({ v: num(n.liquid) }))
  const delta = previous ? num(latest.liquid) - num(previous.liquid) : null

  return (
    <Card>
      <div className="grid cols-2" style={{ gap: 28 }}>
        <div>
          <div className="hero-label">Liquid net worth</div>
          <div className="hero-figure">{moneyExact(latest.liquid)}</div>
          <div style={{ height: 44, marginTop: 6 }}>
            {spark.length > 1 ? (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={spark} margin={{ top: 4, right: 2, bottom: 2, left: 2 }}>
                  <YAxis hide domain={['dataMin', 'dataMax']} />
                  <Line
                    type="monotone" dataKey="v" stroke="var(--sleeve-in_equity)"
                    strokeWidth={2} dot={false} isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="hero-label" style={{ paddingTop: 12 }}>
                one checkpoint so far
              </div>
            )}
          </div>
          <div className="chips">
            <DeltaChip
              label="vs last checkpoint"
              value={delta}
              hint={previous ? `since ${shortDate(previous.as_of_date)}` : 'needs a second checkpoint'}
            />
          </div>
        </div>

        <div>
          <div className="hero-label">Total net worth</div>
          <div className="hero-figure" style={{ fontSize: 32 }}>{moneyExact(latest.total)}</div>
          <div className="hero-secondary">
            {compact(latest.epf)} EPF · {compact(latest.fd_accrued)} accrued FD interest ·{' '}
            {compact(latest.splitwise)} owed to you
          </div>
          <div className="hero-secondary" style={{ color: 'var(--muted)', fontSize: 13 }}>
            Cash {compact(latest.cash)} · cards {compact(latest.credit_card)} outstanding ·{' '}
            as of {shortDate(latest.as_of_date)}
          </div>
        </div>
      </div>
    </Card>
  )
}

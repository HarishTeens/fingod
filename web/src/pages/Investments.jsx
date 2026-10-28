import { useEffect, useState } from 'react'
import { api } from '../api/client.js'
import { Card, Swatch } from '../components/Card.jsx'
import { HoldingsTable, Signed } from '../components/HoldingsTable.jsx'
import { IndexedChart } from '../components/IndexedChart.jsx'
import { ProportionBar } from '../components/ProportionBar.jsx'
import { compact, moneyExact, num, sleeveColor, sleeveLabel } from '../lib/format.js'

// One parameter picks the period: the API compares the first checkpoint in
// range with the last, so "1 year" is just a from date. No separate mode.
const RANGES = [
  { id: '1w', label: '1 week', days: 7 },
  { id: '1m', label: '1 month', days: 30 },
  { id: '3m', label: '3 months', days: 91 },
  { id: '1y', label: '1 year', days: 365 },
  { id: 'all', label: 'All', days: null },
]

function fromDate(days) {
  if (!days) return undefined
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - days)
  return d.toISOString().slice(0, 10)
}

export function Investments() {
  const [range, setRange] = useState('1m')
  const [state, setState] = useState({ status: 'loading' })
  const [open, setOpen] = useState(null)

  useEffect(() => {
    let live = true
    setState({ status: 'loading' })
    const days = RANGES.find((r) => r.id === range).days
    api
      .sleeves({ from: fromDate(days) })
      .then((d) => live && setState({ status: 'ready', data: d }))
      .catch((e) => live && setState({ status: 'error', error: e.message }))
    return () => { live = false }
  }, [range])

  if (state.status === 'loading') return <div className="empty">Loading…</div>
  if (state.status === 'error') return <div className="empty">{state.error}</div>

  const d = state.data
  const hasAttribution = d.compared_to != null
  // The one sleeve that is not rupee-denominated, for the note below the table.
  const usSleeve = d?.sleeves?.find((x) => x.foreign?.buy_rate)
  const sleeveNames = d.sleeves.map((s) => s.sleeve)

  const rangeButtons = (
    <span style={{ display: 'flex', gap: 6 }}>
      {RANGES.map((r) => (
        <button key={r.id} className="btn" aria-pressed={range === r.id} onClick={() => setRange(r.id)}>
          {r.label}
        </button>
      ))}
    </span>
  )

  const days = RANGES.find((r) => r.id === range).days
  const rangeStart = fromDate(days)

  return (
    <div className="grid">
      <Card
        title={`Investments — ${d.checkpoints_in_range} checkpoint${d.checkpoints_in_range === 1 ? '' : 's'} in range`}
        actions={rangeButtons}
      >
        <div className="grid cols-2" style={{ gap: 28 }}>
          <div>
            <div className="hero-label">Current value</div>
            <div className="hero-figure">{moneyExact(d.total.value)}</div>
            <div className="hero-secondary">
              {moneyExact(d.total.invested)} invested
              {d.total.partial && <span style={{ color: 'var(--muted)' }}> (partial cost basis)</span>}
            </div>
          </div>
          <div>
            <div className="hero-label">Since bought</div>
            <div className="hero-figure" style={{ fontSize: 32 }}>
              <Signed value={d.total.return_pct} suffix="%" />
            </div>
            <div className="hero-secondary">{compact(d.total.unrealised)} unrealised</div>
          </div>
        </div>
        <p className="note">
          {/* Say what the range resolved to. A control that returns the same
              answer for every setting looks broken unless it shows its work. */}
          Range: <strong>{rangeStart ? `${rangeStart} onwards` : 'everything'}</strong> ·{' '}
          {d.checkpoints_in_range} checkpoint{d.checkpoints_in_range === 1 ? '' : 's'} in it
          {d.compared_to
            ? ` · comparing ${d.compared_to} with ${String(d.as_of)}`
            : ' · nothing to compare against yet, so every range gives the same answer'}
          .
        </p>
        {d.note && <p className="note">{d.note}</p>}
      </Card>

      <Card title="Performance — every sleeve indexed to 100">
        <IndexedChart series={d.series} sleeves={sleeveNames}
          rangeHint={rangeStart ? `the last ${RANGES.find((r) => r.id === range).label}` : 'this range'} />
      </Card>

      <Card title="By sleeve">
        <table className="data">
          <thead>
            <tr>
              <th>Sleeve</th>
              <th className="num">Value</th>
              <th className="num">Invested</th>
              <th className="num">Since bought</th>
              {hasAttribution && (
                <>
                  <th className="num">Market</th>
                  <th className="num">Flow</th>
                  <th className="num">FX</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {d.sleeves.map((s) => (
              <tr key={s.sleeve} className={open === s.sleeve ? 'picked' : undefined}>
                <td className="name">
                  <button
                    className="row-btn"
                    onClick={() => setOpen(open === s.sleeve ? null : s.sleeve)}
                    title={open === s.sleeve ? 'Collapse' : 'Show the holdings'}
                  >
                    <Swatch color={sleeveColor(s.sleeve)} />
                    <span className="name">{sleeveLabel(s.sleeve)}</span>
                    <span style={{ color: 'var(--muted)', marginLeft: 8 }}>
                      {open === s.sleeve ? '▾' : '▸'} {s.holdings.length}
                    </span>
                  </button>
                </td>
                <td className="num">{compact(s.value)}</td>
                <td className="num" style={{ color: 'var(--muted)' }}>{compact(s.invested)}</td>
                <td className="num">
                  <Signed value={s.return_pct} suffix="%" />
                  {/* A foreign sleeve carries its own-currency return too — the
                      rupee figure alone cannot distinguish a company doing well
                      from the rupee doing badly. Inline rather than stacked:
                      only one sleeve has it, and a third line would make that
                      row taller than every other. */}
                  {s.foreign?.return_pct !== undefined && (
                    <span style={{ color: 'var(--muted)', fontSize: 11.5, marginLeft: 6 }}>
                      / {Math.abs(num(s.foreign.return_pct)).toFixed(2)}% {s.foreign.currency}
                    </span>
                  )}
                  <div style={{ color: 'var(--muted)', fontSize: 11.5 }}>{compact(s.unrealised)}</div>
                </td>
                {hasAttribution && (
                  <>
                    <td className="num"><Signed value={s.market} /></td>
                    <td className="num"><Signed value={s.flow} /></td>
                    <td className="num"><Signed value={s.fx} /></td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {usSleeve?.foreign?.buy_rate && (
          <p className="note">
            <strong>US equity is quoted twice</strong> because the two numbers answer different
            questions. {usSleeve.foreign.return_pct}% is what the shares did in dollars;{' '}
            {usSleeve.return_pct}% is what your rupees did, and the gap is the currency — bought at a
            blended ₹{num(usSleeve.foreign.buy_rate).toFixed(2)}/$ against ₹
            {num(usSleeve.foreign.live_rate).toFixed(2)} today. Cost basis is FIFO'd from the broker
            order book at each buy date's own rate, not INDmoney's flat ₹92, which misstated it and
            inflated this sleeve's gain.
          </p>
        )}
        <p className="note">
          <strong>Since bought</strong> is cost basis against today's value — it spans every purchase
          you ever made, including the ones before fingod existed. For a fixed deposit that is the
          interest accrued <em>so far</em>, not its annual rate: a 6.25% deposit four months old shows
          about 2%.{' '}
          {hasAttribution ? (
            <>
              <strong>Market / flow / fx</strong> is what happened between{' '}
              {d.compared_to} and {String(d.as_of)}: the price moving, money you added or took out,
              and the rupee moving. They sum to the change exactly, which is what stops a SIP looking
              like a gain.
            </>
          ) : (
            <>The <strong>market / flow / fx</strong> split needs a second checkpoint in range. It is
            the only thing that can tell a gain from money you added, so it is worth the wait.</>
          )}
        </p>
      </Card>

      {open && (() => {
        const sleeve = d.sleeves.find((s) => s.sleeve === open)
        const holdings = sleeve?.holdings || []
        return (
          <Card title={`${sleeveLabel(open)} — holdings`}>
            <HoldingsTable holdings={holdings} showAttribution={hasAttribution} />
            <ProportionBar
              total={sleeve?.value}
              items={holdings.map((h) => ({
                key: h.isin || h.symbol,
                label: h.symbol,
                value: h.value,
                pct: h.share_pct,
              }))}
            />
          </Card>
        )
      })()}
    </div>
  )
}

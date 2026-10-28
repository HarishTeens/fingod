import { useEffect, useMemo, useState } from 'react'
import { BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts'
import { api } from '../api/client.js'
import { Card, TableToggle, Swatch } from '../components/Card.jsx'
import { Signed } from '../components/HoldingsTable.jsx'
import { compact, moneyExact, monthLabel, num, shortDate, sleeveColor, sleeveLabel } from '../lib/format.js'
import { useSortedRows } from '../lib/useSort.jsx'
import { usePaged } from '../lib/usePaged.jsx'

function PeriodTooltip({ active, payload, label, granularity }) {
  if (!active || !payload?.length) return null
  const d = payload[0].payload
  return (
    <div className="tooltip">
      <div className="head">{granularity === 'year' ? label.slice(0, 4) : monthLabel(label)}</div>
      <div className="row">
        <span>Realised</span><span className="v">{moneyExact(d.realised)}</span>
      </div>
      <div className="row">
        <span>{d.trades} closed · {d.winners} winners</span><span className="v" />
      </div>
    </div>
  )
}

export function Realised() {
  const [granularity, setGranularity] = useState('month')
  const [state, setState] = useState({ status: 'loading' })
  const [table, setTable] = useState(false)
  // Which sleeve's trades are open, exactly as the Investments tab expands a
  // sleeve into its holdings. null is closed; 'all' is the totals row.
  const [open, setOpen] = useState(null)

  useEffect(() => {
    let live = true
    Promise.all([api.realised(granularity), api.sleeves(), api.projection()])
      .then(([r, s, p]) => live && setState({ status: 'ready', r, s, p }))
      .catch((e) => live && setState({ status: 'error', error: e.message }))
    return () => { live = false }
  }, [granularity])

  const trades = state.status === 'ready' ? state.r.trades : []
  const bySleeveSafe = state.status === 'ready' ? state.r.by_sleeve : {}
  const visible = useMemo(
    () => (!open || open === 'all' ? trades : trades.filter((t) => t.sleeve === open)),
    [trades, open]
  )

  const TRADE_COLUMNS = [
    { key: 'symbol', label: 'Holding', numeric: false },
    { key: 'sleeve', label: 'Sleeve', numeric: false },
    { key: 'buy_date', label: 'Bought', numeric: false, className: 'num' },
    { key: 'exit_date', label: 'Exited', numeric: false, className: 'num' },
    { key: 'holding_days', label: 'Held', numeric: true },
    { key: 'qty', label: 'Qty', numeric: true },
    { key: 'buy_price', label: 'Cost', numeric: true },
    { key: 'sell_price', label: 'Sold at', numeric: true },
    { key: 'invested_inr', label: 'Deployed', numeric: true },
    { key: 'realised_inr', label: 'Realised', numeric: true },
    { key: 'return_pct', label: 'Return', numeric: true },
  ]
  const { sorted, headers } = useSortedRows(visible, TRADE_COLUMNS, { key: 'exit_date', dir: 'desc' })
  const { visible: tradePage, pager: tradePager } = usePaged(sorted)

  const SLEEVE_COLUMNS = [
    { key: 'label', label: 'Sleeve', numeric: false },
    { key: 'trades', label: 'Trades', numeric: true },
    { key: 'invested', label: 'Deployed', numeric: true },
    // Gains and losses are shown gross, not netted. 2.98L won against 54k lost
    // is a different account from 2.44L netted, and only the first says
    // anything about how the trading actually went.
    { key: 'gross_wins', label: 'Gains', numeric: true },
    { key: 'gross_losses', label: 'Losses', numeric: true },
    { key: 'realised', label: 'Net', numeric: true },
    { key: 'return_pct', label: 'Return', numeric: true },
    { key: 'win_rate_pct', label: 'Hit rate', numeric: true },
  ]
  const sleeveRows = useMemo(
    () => Object.entries(bySleeveSafe).map(([key, v]) => ({ key, label: sleeveLabel(key), ...v })),
    [bySleeveSafe]
  )
  const { sorted: sortedSleeves, headers: sleeveHeaders } =
    useSortedRows(sleeveRows, SLEEVE_COLUMNS, { key: 'realised', dir: 'desc' })

  const PROJ_COLUMNS = [
    { key: 'symbol', label: 'Holding', numeric: false },
    { key: 'invested', label: 'Invested', numeric: true },
    { key: 'value', label: 'Now', numeric: true },
    { key: 'target_price', label: 'Target', numeric: true },
    { key: 'value_at_target', label: 'At target', numeric: true },
    { key: 'gain', label: 'Gain', numeric: true },
    { key: 'gain_pct', label: 'On cost', numeric: true },
    { key: 'away_pct', label: 'Away', numeric: true },
    { key: 'horizon', label: 'Horizon', numeric: false },
  ]
  const projRows = state.status === 'ready' ? state.p.projection.rows : []
  const { sorted: sortedProj, headers: projHeaders } =
    useSortedRows(projRows, PROJ_COLUMNS, { key: 'gain', dir: 'desc' })
  const { visible: projPage, pager: projPager } = usePaged(sortedProj)

  const dividendRows = state.status === 'ready' ? state.r.dividends.payments : []
  const { visible: divPage, pager: divPager } = usePaged(dividendRows)

  if (state.status === 'loading') return <div className="empty">Loading…</div>
  if (state.status === 'error') return <div className="empty">{state.error}</div>

  const { summary, by_sleeve: bySleeve, series, dividends, total_realised: totalRealised } = state.r

  // Trade profit and dividends share a chart but not a stack: a trade's profit
  // can be negative and a dividend never is, so stacking them would draw a bar
  // whose height meant neither figure. Side by side, both read against zero.
  const merged = (() => {
    const byPeriod = new Map()
    for (const b of series) byPeriod.set(b.period, { period: b.period, trades: num(b.realised), dividends: 0, count: b.trades })
    for (const b of dividends.series) {
      const row = byPeriod.get(b.period) || { period: b.period, trades: 0, dividends: 0, count: 0 }
      row.dividends = num(b.realised)
      byPeriod.set(b.period, row)
    }
    return [...byPeriod.values()].sort((a, b) => a.period.localeCompare(b.period))
  })()
  if (!summary.trades) {
    return <div className="empty">No closed trades yet. Import a journal with <code>POST /api/v1/trades</code>.</div>
  }

  // The number the whole page exists to produce: money already banked plus
  // money still on the table.
  const unrealised = state.s.total
  const totalProfit = num(totalRealised) + num(unrealised.unrealised)

  return (
    <div className="grid">
      <Card title="Total profit — banked and on the table">
        <div className="grid cols-2" style={{ gap: 28 }}>
          <div>
            <div className="hero-label">Realised · banked, will not change</div>
            <div className="hero-figure">{moneyExact(totalRealised)}</div>
            <div className="hero-secondary">
              {compact(summary.realised)} from {summary.trades} exits ·{' '}
              {compact(dividends.total)} from {dividends.count} payouts
            </div>
            <div className="chips">
              <span className="chip good"><span className="val">+{compact(summary.gross_wins)}</span> won</span>
              <span className="chip bad"><span className="val">{compact(summary.gross_losses)}</span> lost</span>
              <span className="chip">{summary.winners}/{summary.trades} hit <span className="val">{summary.win_rate_pct}%</span></span>
              <span className="chip">avg hold <span className="val">{summary.avg_holding_days}d</span></span>
            </div>
          </div>
          <div>
            <div className="hero-label">Unrealised · still held</div>
            <div className="hero-figure" style={{ fontSize: 32 }}>{moneyExact(unrealised.unrealised)}</div>
            <div className="hero-secondary">on {compact(unrealised.invested)} invested · {unrealised.return_pct}%</div>
            <div className="hero-secondary" style={{ marginTop: 14, color: 'var(--ink)', fontSize: 17, fontWeight: 600 }}>
              {moneyExact(totalProfit)} total profit
            </div>
          </div>
        </div>
        <p className="note">
          Two different kinds of number, deliberately kept apart. Realised is banked and will not
          change. Unrealised is a market quote and will be different tomorrow. Adding them answers
          "what have I actually made", which is a fair question — just never confuse the halves.
        </p>
      </Card>

      <Card
        title={`Realised by ${granularity}`}
        actions={
          <span style={{ display: 'flex', gap: 6 }}>
            {['month', 'year'].map((g) => (
              <button key={g} className="btn" aria-pressed={granularity === g} onClick={() => setGranularity(g)}>
                {g === 'month' ? 'Monthly' : 'Yearly'}
              </button>
            ))}
          </span>
        }
      >
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={merged} margin={{ top: 10, right: 8, bottom: 4, left: 4 }}>
            <CartesianGrid stroke="var(--gridline)" vertical={false} />
            <XAxis
              dataKey="period"
              tickFormatter={(p) => (granularity === 'year' ? p.slice(0, 4) : monthLabel(p))}
              tick={{ fill: 'var(--muted)', fontSize: 11 }}
              axisLine={{ stroke: 'var(--baseline)' }} tickLine={false} className="tnum"
            />
            <YAxis tickFormatter={compact} width={70} tick={{ fill: 'var(--muted)', fontSize: 11 }}
                   axisLine={false} tickLine={false} className="tnum" />
            {/* Zero is the line that matters on a profit chart, so it is drawn. */}
            <ReferenceLine y={0} stroke="var(--baseline)" />
            <Tooltip content={<PeriodTooltip granularity={granularity} />} cursor={{ fill: 'var(--gridline)', opacity: 0.35 }} />
            <Bar dataKey="trades" maxBarSize={26} isAnimationActive={false}>
              {merged.map((b) => (
                <Cell
                  key={b.period}
                  fill={b.trades >= 0 ? 'var(--good)' : 'var(--critical)'}
                  radius={b.trades >= 0 ? [4, 4, 0, 0] : [0, 0, 4, 4]}
                />
              ))}
            </Bar>
            <Bar dataKey="dividends" maxBarSize={26} fill="var(--cat-5)" radius={[4, 4, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
        <div className="legend">
          <span><i className="swatch" style={{ background: 'var(--good)' }} />Trade profit</span>
          <span><i className="swatch" style={{ background: 'var(--critical)' }} />Trade loss</span>
          <span><i className="swatch" style={{ background: 'var(--cat-5)' }} />Dividends &amp; payouts</span>
        </div>
        <p className="note">
          Trades are bucketed on the <strong>exit</strong> date — profit became real the day you
          sold, and a position held across three years did not earn a third of it in each. Colour is
          doubled by position: gains sit above the zero line, losses below. Bars sit side by side
          rather than stacked, because a trade's profit can be negative and a dividend never is.
        </p>
      </Card>

      <Card title="By sleeve">
        <table className="data">
          <thead><tr>{sleeveHeaders}</tr></thead>
          <tbody>
            {sortedSleeves.map(({ key: k, ...v }) => (
              <tr key={k} className={open === k ? 'picked' : undefined}>
                <td className="name">
                  <button
                    className="row-btn"
                    onClick={() => setOpen(open === k ? null : k)}
                    title={open === k ? 'Collapse' : `Show the ${sleeveLabel(k)} closings`}
                  >
                    <Swatch color={sleeveColor(k)} />
                    <span className="name">{sleeveLabel(k)}</span>
                    <span style={{ color: 'var(--muted)', marginLeft: 8 }}>
                      {open === k ? '▾' : '▸'}
                    </span>
                  </button>
                </td>
                <td className="num">{v.trades}</td>
                <td className="num" style={{ color: 'var(--muted)' }}>{compact(v.invested)}</td>
                <td className="num" style={{ color: 'var(--good)' }}>
                  {num(v.gross_wins) ? `+${compact(v.gross_wins)}` : '—'}
                </td>
                <td className="num" style={{ color: num(v.gross_losses) ? 'var(--critical)' : 'var(--muted)' }}>
                  {num(v.gross_losses) ? compact(v.gross_losses) : '—'}
                </td>
                <td className="num"><Signed value={v.realised} /></td>
                <td className="num"><Signed value={v.return_pct} suffix="%" /></td>
                <td className="num">{v.winners}/{v.trades} · {v.win_rate_pct}%</td>
              </tr>
            ))}
          </tbody>
          {/* Totals from the page summary rather than a sum of the rows above:
              the same figures the hero shows, so the two can never disagree. */}
          <tfoot>
            <tr
              style={{ borderTop: '1px solid var(--baseline)' }}
              className={open === 'all' ? 'picked' : undefined}
            >
              <td className="name" style={{ color: 'var(--ink)', fontWeight: 600 }}>
                <button
                  className="row-btn"
                  onClick={() => setOpen(open === 'all' ? null : 'all')}
                  title={open === 'all' ? 'Collapse' : 'Show every closing'}
                >
                  <span className="name" style={{ fontWeight: 600 }}>All sleeves</span>
                  <span style={{ color: 'var(--muted)', marginLeft: 8 }}>
                    {open === 'all' ? '▾' : '▸'}
                  </span>
                </button>
              </td>
              <td className="num">{summary.trades}</td>
              <td className="num" style={{ color: 'var(--muted)' }}>{compact(summary.invested)}</td>
              <td className="num" style={{ color: 'var(--good)' }}>+{compact(summary.gross_wins)}</td>
              <td className="num" style={{ color: 'var(--critical)' }}>{compact(summary.gross_losses)}</td>
              <td className="num"><Signed value={summary.realised} /></td>
              <td className="num"><Signed value={summary.return_pct} suffix="%" /></td>
              <td className="num">{summary.winners}/{summary.trades} · {summary.win_rate_pct}%</td>
            </tr>
          </tfoot>
        </table>
        <p className="note">
          Click a sleeve to see the closings behind it, or <em>All sleeves</em> for every one.
          Gains and losses are <strong>gross</strong>, not netted.{' '}
          {compact(summary.gross_wins)} won against {compact(Math.abs(num(summary.gross_losses)))}{' '}
          lost is a different account from {compact(summary.realised)} netted, and only the first
          says anything about how the trading went. A sleeve showing no losses had none — every
          closing in it made money.
        </p>
      </Card>

      {open && (
      <Card
        title={
          open === 'all'
            ? `Closed positions — all ${trades.length}`
            : `${sleeveLabel(open)} — ${visible.length} closing${visible.length === 1 ? '' : 's'}`
        }
        actions={<TableToggle showing={table} onToggle={() => setTable(!table)} />}
      >
        <table className="data">
          <thead><tr>{headers}</tr></thead>
          <tbody>
            {tradePage.map((t) => (
              <tr key={t.id}>
                <td className="name">
                  {t.symbol}
                  {t.name && t.name !== t.symbol && (
                    <div style={{ color: 'var(--muted)', fontSize: 11.5 }}>{t.name.slice(0, 40)}</div>
                  )}
                </td>
                <td><Swatch color={sleeveColor(t.sleeve)} />{sleeveLabel(t.sleeve)}</td>
                <td className="num" style={{ whiteSpace: 'nowrap', color: 'var(--muted)' }}>
                  {t.buy_date ? shortDate(t.buy_date) : '—'}
                </td>
                <td className="num" style={{ whiteSpace: 'nowrap' }}>{shortDate(t.exit_date)}</td>
                <td className="num" style={{ color: 'var(--muted)' }}>{t.holding_days ? `${t.holding_days}d` : '—'}</td>
                <td className="num" style={{ color: 'var(--muted)' }}>
                  {t.qty ? num(t.qty).toLocaleString('en-IN', { maximumFractionDigits: 3 }) : '—'}
                </td>
                <td className="num" style={{ color: 'var(--muted)' }}>
                  {t.buy_price ? num(t.buy_price).toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '—'}
                </td>
                <td className="num" style={{ color: 'var(--muted)' }}>
                  {t.sell_price ? num(t.sell_price).toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '—'}
                </td>
                <td className="num">{compact(t.invested_inr)}</td>
                <td className="num"><Signed value={t.realised_inr} /></td>
                <td className="num"><Signed value={t.return_pct} suffix="%" /></td>
              </tr>
            ))}
          </tbody>
        </table>
        {tradePager}
        <p className="note">
          Best: {summary.best.symbol} {compact(summary.best.realised)} ({summary.best.return_pct}%) ·
          Worst: {summary.worst.symbol} {compact(summary.worst.realised)} ({summary.worst.return_pct}%)
          {open !== 'all' && ' · best and worst are across every sleeve, not this one'}
        </p>
      </Card>
      )}

      <Card title="If every target were reached">
        {(() => {
          const p = state.p.projection
          const rows = p.rows
          return (
            <>
              <div className="grid cols-2" style={{ gap: 28 }}>
                <div>
                  <div className="hero-label">Gain if all {rows.length} targets hit</div>
                  <div className="hero-figure">{moneyExact(p.gain)}</div>
                  <div className="hero-secondary">
                    {p.gain_pct}% on {compact(p.invested)} invested · worth{' '}
                    {compact(p.value_at_target)} against {compact(p.value)} today
                  </div>
                </div>
                <div>
                  <div className="hero-label">Still ahead of you</div>
                  <div className="hero-figure" style={{ fontSize: 32 }}>{moneyExact(p.to_come)}</div>
                  <div className="hero-secondary">
                    {p.to_come_pct}% from today's prices — the sleeve is up{' '}
                    {compact(num(p.value) - num(p.invested))} so far, so almost all of the scenario
                    is expectation rather than progress.
                  </div>
                </div>
              </div>

              <div className="proportion" style={{ marginTop: 20 }}>
                <table className="data">
                  <thead><tr>{projHeaders}</tr></thead>
                  <tbody>
                    {projPage.map((r) => (
                      <tr key={r.symbol}>
                        <td className="name">
                          <Swatch color={sleeveColor(r.sleeve)} />{r.symbol}
                        </td>
                        <td className="num" style={{ color: 'var(--muted)' }}>{compact(r.invested)}</td>
                        <td className="num" style={{ color: 'var(--muted)' }}>{compact(r.value)}</td>
                        <td className="num">
                          {num(r.target_price).toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                        </td>
                        <td className="num">{compact(r.value_at_target)}</td>
                        <td className="num"><Signed value={r.gain} /></td>
                        <td className="num"><Signed value={r.gain_pct} suffix="%" /></td>
                        <td className="num" style={{ color: 'var(--muted)' }}>
                          {r.away_pct ? `+${num(r.away_pct).toFixed(1)}%` : '—'}
                        </td>
                        <td style={{ color: 'var(--muted)' }}>{r.horizon || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {projPager}
              </div>

              <p className="note">
                <strong>Not a forecast.</strong> This is arithmetic on prices you chose, and its only
                claim is internal consistency: what these positions would be worth at those prices.
                Two things it does not know. It has <strong>no time horizon</strong> — a target six
                months out and one three years out count the same here, though your journal records
                the difference. And it assumes <strong>every remaining position hits</strong>, while
                the {state.p.track_record.trades} you have already closed managed{' '}
                {state.p.track_record.win_rate_pct}%, with {state.p.track_record.losers} losers.
              </p>
              <p className="note">
                Holdings with no target are excluded rather than valued at today's price, which would
                dilute the percentage with positions the scenario says nothing about
                {p.untargeted?.length ? ` (${p.untargeted.length} of them, including ${p.untargeted.slice(0, 3).join(', ')})` : ''}.
              </p>
            </>
          )
        })()}
      </Card>

      <Card title={`Dividends & payouts — ${dividends.count} since ${dividends.first}`}>
        <table className="data">
          <thead>
            <tr><th>Date</th><th>From</th><th>Account</th><th className="num">Amount</th></tr>
          </thead>
          <tbody>
            {divPage.map((p, i) => (
              <tr key={`${p.date}-${i}`}>
                <td style={{ whiteSpace: 'nowrap' }}>{shortDate(p.date)}</td>
                <td className="name">{p.note || <span style={{ color: 'var(--muted)' }}>—</span>}</td>
                <td style={{ color: 'var(--muted)' }}>{p.account}</td>
                <td className="num" style={{ color: 'var(--good)' }}>{moneyExact(p.amount_inr)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {divPager}
        <p className="note">
          Wallet records in the <em>Interest, dividends</em> category carrying the{' '}
          <em>Investment</em> label. The label is doing real work: the same category also holds FD
          interest, which is already counted as accrued in total net worth and would otherwise be
          counted twice — along with bank and credit-card interest, which is not investment return
          at all.
        </p>
      </Card>

    </div>
  )
}

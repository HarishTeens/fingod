import { useEffect, useState } from 'react'
import { api } from '../api/client.js'
import { ExpenseBars } from '../components/ExpenseBars.jsx'
import { BreakdownList } from '../components/BreakdownList.jsx'
import { TransactionList } from '../components/TransactionList.jsx'
import { monthLabel, shortDate } from '../lib/format.js'

const PERIODS = { month: 18, week: 16 }

function startOf(granularity, back) {
  const d = new Date()
  if (granularity === 'week') {
    d.setUTCDate(d.getUTCDate() - 7 * (back - 1))
    // Postgres date_trunc('week') is Monday-based; match it.
    const dow = (d.getUTCDay() + 6) % 7
    d.setUTCDate(d.getUTCDate() - dow)
  } else {
    d.setUTCDate(1)
    d.setUTCMonth(d.getUTCMonth() - (back - 1))
  }
  return d.toISOString().slice(0, 10)
}

const periodLabel = (p, g) => (g === 'week' ? `week of ${shortDate(p)}` : monthLabel(p))

export function Expenses() {
  const [granularity, setGranularity] = useState('month')
  // The drill-down is one object so every level shares a single source of
  // truth: clearing a category cannot leave a stale subcategory behind.
  const [drill, setDrill] = useState({ period: null, category: null, subcategory: null, label: null })
  const [chart, setChart] = useState({ status: 'loading' })
  const [detail, setDetail] = useState(null)

  useEffect(() => {
    let live = true
    setChart({ status: 'loading' })
    api
      .expensesByLabel(granularity, startOf(granularity, PERIODS[granularity]))
      .then((r) => live && setChart({ status: 'ready', series: r.series, labels: r.labels }))
      .catch((e) => live && setChart({ status: 'error', error: e.message }))
    return () => { live = false }
  }, [granularity])

  // Selecting the newest period by default: an Expenses screen that opens on
  // "click something" wastes the first interaction.
  useEffect(() => {
    if (chart.status === 'ready' && !drill.period && chart.series.length) {
      setDrill((d) => ({ ...d, period: chart.series[chart.series.length - 1].period }))
    }
  }, [chart, drill.period])

  useEffect(() => {
    if (!drill.period) return
    let live = true
    const q = { ...drill, granularity }
    Promise.all([
      api.breakdown({ ...q, by: drill.category ? 'subcategory' : 'category' }),
      api.breakdown({ ...q, by: 'label' }),
      api.expenseTransactions({ ...q, limit: 200 }),
    ])
      .then(([groups, labels, txns]) => live && setDetail({ groups, labels, txns }))
      .catch((e) => live && setDetail({ error: e.message }))
    return () => { live = false }
  }, [drill, granularity])

  const set = (patch) => setDrill((d) => ({ ...d, ...patch }))

  if (chart.status === 'error') {
    return <div className="empty">Could not load expenses: {chart.error}</div>
  }
  if (chart.status === 'loading') return <div className="empty">Loading…</div>

  const crumbs = [
    { label: drill.period ? periodLabel(drill.period, granularity) : '—', onClick: () => set({ category: null, subcategory: null }) },
    drill.category && { label: drill.category, onClick: () => set({ subcategory: null }) },
    drill.subcategory && { label: drill.subcategory, onClick: null },
  ].filter(Boolean)

  return (
    <div className="grid">
      <ExpenseBars
        series={chart.series}
        labels={chart.labels}
        granularity={granularity}
        title={granularity === 'week' ? 'Weekly spend by label' : 'Monthly spend by label'}
        selectedPeriod={drill.period}
        onSelectPeriod={(p) => set({ period: p, category: null, subcategory: null })}
        extraActions={['month', 'week'].map((g) => (
          <button
            key={g}
            className="btn"
            aria-pressed={granularity === g}
            onClick={() => {
              setGranularity(g)
              setDrill({ period: null, category: null, subcategory: null, label: null })
              setDetail(null)
            }}
          >
            {g === 'month' ? 'Monthly' : 'Weekly'}
          </button>
        ))}
      />

      {drill.period && (
        <>
          <nav className="crumbs">
            {crumbs.map((c, i) => (
              <span key={c.label}>
                {i > 0 && <span className="sep">›</span>}
                {c.onClick ? (
                  <button className="crumb" onClick={c.onClick}>{c.label}</button>
                ) : (
                  <span className="crumb current">{c.label}</span>
                )}
              </span>
            ))}
            {drill.label && (
              <button className="btn" style={{ marginLeft: 10 }} onClick={() => set({ label: null })}>
                label: {drill.label} ✕
              </button>
            )}
          </nav>

          {detail?.error ? (
            <div className="empty">{detail.error}</div>
          ) : detail ? (
            <>
              <div className="grid cols-2">
                <BreakdownList
                  title={drill.category ? `${drill.category} — subcategories` : 'Categories'}
                  rows={detail.groups.rows}
                  total={detail.groups.total}
                  picked={drill.subcategory}
                  onPick={
                    drill.category
                      ? (k) => set({ subcategory: k })
                      : (k) => set({ category: k, subcategory: null })
                  }
                  emptyText="No spending in this period."
                />
                <BreakdownList
                  title="Labels"
                  rows={detail.labels.rows}
                  total={detail.labels.total}
                  picked={drill.label}
                  onPick={(k) => set({ label: k })}
                  emptyText="Nothing tagged here."
                />
              </div>
              <TransactionList
                transactions={detail.txns.transactions}
                total={detail.txns.total}
                count={detail.txns.count}
                note={detail.txns.count >= 200 ? 'showing the 200 largest' : 'largest first'}
              />
            </>
          ) : (
            <div className="empty">Loading…</div>
          )}
        </>
      )}
    </div>
  )
}

import { useEffect, useState } from 'react'
import { api } from '../api/client.js'
import { Hero } from '../components/Hero.jsx'
import { NetworthChart } from '../components/NetworthChart.jsx'
import { AllocationDonut } from '../components/AllocationDonut.jsx'
import { ExpenseBars } from '../components/ExpenseBars.jsx'
import { DriftTable } from '../components/DriftTable.jsx'

// The expense card draws 18 months, so it asks for 18 months. Requesting all of
// history and slicing here ranked labels across 79 months while showing 18 — a
// label that dominated a recent month lost to one that was big years ago and
// got folded into "Other".
const MONTHS_SHOWN = 18
function monthsAgo(n) {
  const d = new Date()
  d.setUTCDate(1)
  d.setUTCMonth(d.getUTCMonth() - (n - 1))
  return d.toISOString().slice(0, 10)
}

export function Dashboard() {
  const [state, setState] = useState({ status: 'loading' })

  useEffect(() => {
    let live = true
    Promise.all([api.networth(), api.allocation(), api.expensesByLabel('month', monthsAgo(MONTHS_SHOWN))])
      .then(([nw, alloc, exp]) => {
        if (live) setState({ status: 'ready', series: nw.series, allocation: alloc, expenses: exp.series, labels: exp.labels })
      })
      .catch((err) => live && setState({ status: 'error', error: err.message }))
    return () => { live = false }
  }, [])

  if (state.status === 'loading') return <div className="empty">Loading…</div>
  if (state.status === 'error') {
    return (
      <div className="empty">
        <strong style={{ color: 'var(--critical)' }}>Could not reach the API.</strong>
        <div style={{ marginTop: 8 }}>{state.error}</div>
        <div style={{ marginTop: 8 }}>
          Is it running? <code>make up &amp;&amp; make api</code>
        </div>
      </div>
    )
  }

  const { series, allocation, expenses, labels } = state
  if (!series.length) {
    return (
      <div className="empty">
        No checkpoints yet. Run <code>/refresh</code> in Claude Code to take the first one.
      </div>
    )
  }

  return (
    <div className="grid">
      <Hero series={series} />
      <div className="grid cols-3">
        <NetworthChart series={series} />
        <AllocationDonut allocation={allocation} />
      </div>
      <ExpenseBars series={expenses} labels={labels} />
      <DriftTable allocation={allocation} />
    </div>
  )
}

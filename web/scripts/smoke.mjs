// Render every dashboard component against the live API and assert the real
// numbers appear in the output.
//
// This is not a substitute for looking at the page — it cannot see a label
// collision or an overflowing axis. What it does catch is the failure mode that
// costs the most time: a component that throws on real data because a field is
// named differently than the mapping assumed, which in a browser shows up as a
// blank card and nothing in the terminal.

import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { renderToString } from 'react-dom/server'
import React from 'react'

const API = process.env.FINGOD_API_ORIGIN || 'http://127.0.0.1:8080'
const TOKEN = process.env.FINGOD_API_TOKEN

async function get(path) {
  const res = await fetch(`${API}/api/v1${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  })
  if (!res.ok) throw new Error(`${path} -> ${res.status}`)
  return res.json()
}

// Root is pinned to web/ rather than inherited from cwd, so this runs the
// same whether it is invoked from the repo root or from web/.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const server = await createServer({ root, server: { middlewareMode: true }, appType: 'custom' })
let failures = 0

const check = (name, html, mustContain) => {
  const missing = mustContain.filter((s) => !html.includes(s))
  if (missing.length) {
    console.log(`  FAIL ${name}: missing ${missing.map((m) => JSON.stringify(m)).join(', ')}`)
    failures++
  } else {
    console.log(`  ok   ${name} (${html.length} chars)`)
  }
}

try {
  const [nw, alloc, exp] = await Promise.all([get('/networth'), get('/allocation'), get('/expenses?granularity=month&by=label')])

  const { Hero } = await server.ssrLoadModule('/src/components/Hero.jsx')
  const { NetworthChart } = await server.ssrLoadModule('/src/components/NetworthChart.jsx')
  const { AllocationDonut } = await server.ssrLoadModule('/src/components/AllocationDonut.jsx')
  const { ExpenseBars } = await server.ssrLoadModule('/src/components/ExpenseBars.jsx')
  const { DriftTable } = await server.ssrLoadModule('/src/components/DriftTable.jsx')

  const latest = nw.series[nw.series.length - 1]
  console.log(`\ndata: ${nw.count} checkpoint(s), ${alloc.rows.length} sleeves, ${exp.series.length} months, ${exp.labels.length} labels\n`)

  check('Hero', renderToString(React.createElement(Hero, { series: nw.series })), [
    'Liquid net worth', 'Total net worth',
    // The real figure, formatted the way the app formats it.
    new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(latest.liquid)),
  ])

  check('NetworthChart', renderToString(React.createElement(NetworthChart, { series: nw.series })), [
    'Net worth', 'Liquid', 'Total',
  ])

  check('AllocationDonut', renderToString(React.createElement(AllocationDonut, { allocation: alloc })), [
    'Allocation', 'IN Mutual Funds', 'Gold', 'Bitcoin',
  ])

  check('ExpenseBars', renderToString(React.createElement(ExpenseBars, { series: exp.series.slice(-18), labels: exp.labels })), [
    'Monthly spend by label', 'Untagged', exp.labels[0],
  ])

  check('DriftTable', renderToString(React.createElement(DriftTable, { allocation: alloc })), [
    'Rebalance', 'To move', 'Target',
  ])

  // The drill-down, at the level a click actually reaches.
  const period = exp.series[exp.series.length - 1].period
  const [groups, byLabel, txns] = await Promise.all([
    get(`/expenses/breakdown?period=${period}&by=category`),
    get(`/expenses/breakdown?period=${period}&by=label`),
    get(`/expenses/transactions?period=${period}&limit=20`),
  ])
  const { BreakdownList } = await server.ssrLoadModule('/src/components/BreakdownList.jsx')
  const { TransactionList } = await server.ssrLoadModule('/src/components/TransactionList.jsx')

  check('BreakdownList/categories',
    renderToString(React.createElement(BreakdownList, {
      title: 'Categories', rows: groups.rows, total: groups.total, onPick: () => {},
    })),
    ['Categories', groups.rows[0].key])

  check('BreakdownList/labels',
    renderToString(React.createElement(BreakdownList, {
      title: 'Labels', rows: byLabel.rows, total: byLabel.total, onPick: () => {},
    })),
    ['Labels', byLabel.rows[0].key])

  check('TransactionList',
    renderToString(React.createElement(TransactionList, {
      transactions: txns.transactions, total: txns.total, count: txns.count,
    })),
    ['Transactions', 'Labels', txns.transactions[0].category])

  console.log(`\n  drill-down: ${groups.rows.length} categories, ${byLabel.rows.length} labels, ` +
    `${txns.count} records in ${period}`)

  // Investments.
  const sl = await get('/sleeves')
  const { HoldingsTable } = await server.ssrLoadModule('/src/components/HoldingsTable.jsx')
  const { IndexedChart } = await server.ssrLoadModule('/src/components/IndexedChart.jsx')
  const biggest = sl.sleeves[0]

  check('HoldingsTable',
    renderToString(React.createElement(HoldingsTable, {
      holdings: biggest.holdings, showAttribution: sl.compared_to != null,
    })),
    ['Avg cost', 'Since bought', biggest.holdings[0].symbol])

  // The dual-currency columns only exist on a foreign sleeve, so the biggest
  // sleeve above never exercises them.
  const us = sl.sleeves.find((x) => x.sleeve === 'us_equity')
  if (us) {
    check('HoldingsTable/us_equity',
      renderToString(React.createElement(HoldingsTable, {
        holdings: us.holdings, showAttribution: sl.compared_to != null,
      })),
      ['INR return', 'USD return', 'FX effect', 'bought @', 'table-wrap'])
    console.log(`  us_equity: ${us.return_pct}% INR vs ${us.foreign.return_pct}% ` +
      `${us.foreign.currency}, bought @ ${Number(us.foreign.buy_rate).toFixed(2)} ` +
      `vs ${Number(us.foreign.live_rate).toFixed(2)} live`)
  } else {
    console.log('  !! no us_equity sleeve — dual-currency columns unverified')
  }

  check('IndexedChart',
    renderToString(React.createElement(IndexedChart, {
      series: sl.series, sleeves: sl.sleeves.map((s) => s.sleeve),
    })),
    // With one checkpoint this is the empty state, and it should say why.
    sl.series.length < 2 ? ['at least two checkpoints'] : ['100'])

  console.log(`  investments: ${sl.sleeves.length} sleeves, total return ${sl.total.return_pct}%, ` +
    `${sl.checkpoints_in_range} checkpoint(s) in range`)

  // Realised.
  const re = await get('/realised?granularity=month')
  const { Realised } = await server.ssrLoadModule('/src/pages/Realised.jsx')
  check('Realised page', renderToString(React.createElement(Realised)), ['Loading'])
  const withTarget = sl.sleeves.flatMap((s) => s.holdings).filter((h) => h.target_price)
  console.log(`  realised: ${re.summary.trades} trades, ${re.summary.realised} banked ` +
    `(${re.summary.return_pct}%), ${re.summary.win_rate_pct}% hit rate`)
  console.log(`  targets: ${withTarget.length} holdings carry one, ` +
    `${withTarget.filter((h) => h.target_hit).length} reached`)

  const pr = await get('/projection')
  const p = pr.projection
  // The scenario must never quietly include untargeted holdings: that would
  // dilute the percentage with positions it says nothing about.
  const targetedRows = p.rows.length
  if (targetedRows !== withTarget.length) {
    console.log(`  FAIL projection: ${targetedRows} rows vs ${withTarget.length} targeted holdings`)
    failures++
  }
  const sumGain = p.rows.reduce((a, r) => a + Number(r.gain), 0)
  if (Math.abs(sumGain - Number(p.gain)) > 1) {
    console.log(`  FAIL projection: rows sum to ${sumGain} but total says ${p.gain}`)
    failures++
  }
  console.log(`  projection: ${targetedRows} targeted, gain ${p.gain} (${p.gain_pct}%), ` +
    `${p.untargeted?.length ?? 0} excluded`)

  // The holdings table's comparator, asserted directly. Sorting is the kind of
  // logic that looks fine on screen while quietly filing every blank among the
  // worst performers.
  const { compare } = await server.ssrLoadModule('/src/components/HoldingsTable.jsx')
  const sortCases = [
    ['numeric desc', compare({ v: '5' }, { v: '10' }, 'v', true, 'desc') > 0],
    ['numeric asc', compare({ v: '5' }, { v: '10' }, 'v', true, 'asc') < 0],
    ['text asc', compare({ v: 'AAPL' }, { v: 'ZOMATO' }, 'v', false, 'asc') < 0],
    ['blank sinks descending', compare({ v: '' }, { v: '-999' }, 'v', true, 'desc') > 0],
    // The one that matters: ascending must not float blanks to the top just
    // because the direction flipped.
    ['blank sinks ascending too', compare({ v: '' }, { v: '-999' }, 'v', true, 'asc') > 0],
    // Nested accessor, which is how the foreign-currency return column sorts.
    ['nested get desc',
      compare({ f: { r: '4' } }, { f: { r: '9' } }, 'x', true, 'desc', (r) => r.f?.r) > 0],
    ['nested get sinks a missing branch',
      compare({}, { f: { r: '-99' } }, 'x', true, 'desc', (r) => r.f?.r) > 0],
    ['two blanks tie', compare({ v: null }, { v: undefined }, 'v', true, 'asc') === 0],
    ['negative beats blank', compare({ v: '-999' }, { v: null }, 'v', true, 'asc') < 0],
  ]
  for (const [name, ok] of sortCases) {
    if (!ok) { console.log(`  FAIL sort: ${name}`); failures++ }
  }
  console.log(`  sort comparator: ${sortCases.length} cases, ${sortCases.filter(([, ok]) => !ok).length} failing`)
} catch (err) {
  console.error('\nsmoke failed:', err.message)
  failures++
} finally {
  await server.close()
}

console.log(failures ? `\n${failures} failure(s)\n` : '\nall components render on live data\n')
process.exit(failures ? 1 : 0)

import { networthSeries, allocationNow, transactionsAll, labelsMap, transactionCount, disposals } from '../repo.js'
import { expenseByLabel } from '../compute/expenses.js'
import { lineChart, stackedBars, donut, sparkline } from './charts.js'
import { compact, moneyExact, money, plain, shortDate, monthLabel, sleeveLabel, sleeveColor, labelColor, delta, esc } from './format.js'

const MONTHS_SHOWN = 12

function hero(series) {
  const latest = series[series.length - 1], prev = series[series.length - 2]
  const d = prev ? latest.liquid - prev.liquid : null
  return `
  <section class="card"><div class="grid cols-2" style="gap:28px">
    <div>
      <div class="hero-label">Liquid net worth</div>
      <div class="hero-figure">${moneyExact(latest.liquid)}</div>
      <div style="margin-top:6px">${sparkline(series.map((n) => n.liquid))}</div>
      <div class="chips">${prev ? `<span class="chip">vs last checkpoint <span class="val">${delta(d)}</span></span>` : '<span class="chip">one checkpoint so far</span>'}</div>
    </div>
    <div>
      <div class="hero-label">Total net worth</div>
      <div class="hero-figure" style="font-size:32px">${moneyExact(latest.total)}</div>
      <div class="hero-secondary">${compact(latest.epf)} EPF · ${compact(latest.fd_accrued)} accrued FD interest · ${compact(latest.splitwise)} owed to you</div>
      <div class="hero-secondary" style="color:var(--muted);font-size:13px">Cash ${compact(latest.cash)} · cards ${compact(latest.credit_card)} outstanding · as of ${shortDate(latest.as_of_date)}</div>
    </div>
  </div></section>`
}

function networthCard(series) {
  const pts = (k) => series.map((n) => [Date.parse(n.as_of_date), n[k]])
  const chart = lineChart({
    series: [{ label: 'Total', color: 'var(--ink)', points: pts('total'), endLabel: compact(series.at(-1).total) }, { label: 'Liquid', color: 'var(--sleeve-in_equity)', points: pts('liquid'), endLabel: compact(series.at(-1).liquid) }],
    yFormat: compact, xFormat: (ms) => shortDate(new Date(ms).toISOString().slice(0, 10)), zeroBased: true, height: 560, title: 'Net worth over time',
  })
  return `<section class="card"><header><h2>Net worth</h2></header>${chart}
    <div class="legend"><span><i class="swatch" style="background:var(--ink)"></i>Total</span><span><i class="swatch" style="background:var(--sleeve-in_equity)"></i>Liquid</span></div>
    <p class="note">Total includes EPF, accrued FD interest and Splitwise receivables. Liquid is what could actually be turned into money.</p></section>`
}

function allocationCard(a) {
  if (!a) return ''
  const rows = a.rows.filter((r) => r.value > 0)
  return `<section class="card"><header><h2>Allocation</h2></header>
    ${donut({ rows: rows.slice().sort((a, b) => b.value - a.value).map((r) => ({ key: r.sleeve, label: sleeveLabel(r.sleeve), value: r.value, color: sleeveColor(r.sleeve) })) })}
    <table class="data" style="margin-top:16px"><tbody>${rows.slice().sort((a, b) => b.value - a.value).map((r) => `<tr><td class="name"><i class="swatch" style="background:${sleeveColor(r.sleeve)}"></i>${esc(sleeveLabel(r.sleeve))}</td><td class="num">${plain(r.share_pct, 1)}%</td><td class="num">${compact(r.value)}</td></tr>`).join('')}</tbody></table></section>`
}

function spendCard() {
  if (!transactionCount()) return `<section class="card"><header><h2>Monthly spend by label</h2></header><div class="empty">No expenses yet. Connect Wallet to see where your money goes.<br><a href="#/welcome" class="btn" style="display:inline-block;margin-top:12px">Connect Wallet</a></div></section>`
  const { labels, series } = expenseByLabel(transactionsAll(), labelsMap(), 'month')
  const recent = series.slice(-MONTHS_SHOWN)
  const chart = stackedBars({ periods: recent.map((p) => ({ ...p, label: monthLabel(p.period) })), keys: labels.slice().reverse(), color: labelColor, yFormat: compact, title: 'Monthly spend by label' })
  return `<section class="card"><header><h2>Monthly spend by label</h2><span class="spacer"></span><a class="btn" href="#/expenses">Explore</a></header>${chart}
    <div class="legend">${labels.map((l) => `<span><i class="swatch" style="background:${labelColor(l)}"></i>${esc(l)}</span>`).join('')}</div>
    <p class="note">Net of money that came back: income tagged with the same label is subtracted, so a bar is what something <i>cost</i> you. Transfers between your own accounts and Investments are excluded.</p></section>`
}

function rebalanceCard(a) {
  if (!a) return ''
  return `<section class="card"><header><h2>Rebalance</h2><span class="spacer"></span><a class="btn" href="#/data">Edit targets</a></header>
    <div class="table-wrap"><table class="data"><thead><tr><th>Sleeve</th><th>Actual vs target</th><th class="num">Share</th><th class="num">Target</th><th class="num">Drift</th><th class="num">To move</th></tr></thead><tbody>
    ${a.rows.map((r) => `<tr><td class="name"><i class="swatch" style="background:${sleeveColor(r.sleeve)}"></i>${esc(sleeveLabel(r.sleeve))}</td>
      <td style="min-width:130px"><span class="minibar" style="position:relative"><span style="width:${Math.min(r.share_pct, 100)}%;background:${sleeveColor(r.sleeve)}"></span><i style="position:absolute;top:-3px;bottom:-3px;width:2px;background:var(--ink);left:${Math.min(r.target_pct, 100)}%"></i></span></td>
      <td class="num">${plain(r.share_pct, 1)}%</td><td class="num">${plain(r.target_pct, 1)}%</td><td class="num">${delta(r.drift_pp, (v) => `${plain(v, 1)}pp`)}</td>
      <td class="num">${r.to_move === 0 ? '—' : `${r.to_move > 0 ? 'buy' : 'sell'} ${compact(Math.abs(r.to_move))}`}</td></tr>`).join('')}
    </tbody></table></div>
    <p class="note">Marker = target. The target's own keys define the base: remove a sleeve you can't rebalance (EPF, say) and it leaves the denominator too.${Object.keys(a.untargeted).length ? ` Outside the target: ${Object.entries(a.untargeted).map(([k, v]) => `${sleeveLabel(k)} ${compact(v)}`).join(', ')}.` : ''}</p></section>`
}

function salesBanner() {
  const d = disposals()
  if (!d.disposals.length) return ''
  return `<section class="card" style="border-color:var(--ring-strong)"><header><h2>Sales detected</h2></header>
    <div class="hero-secondary" style="margin:0">${d.disposals.length} position${d.disposals.length > 1 ? 's' : ''} fell in quantity between ${shortDate(d.between[0])} and ${shortDate(d.between[1])}. Confirm what they sold for to record the realised profit. <a href="#/realised" style="color:var(--ink)">Review →</a></div></section>`
}

export function render(el) {
  const series = networthSeries()
  const a = allocationNow()
  el.innerHTML = `<div class="grid" style="gap:16px">${hero(series)}${salesBanner()}
    <div class="grid cols-3">${networthCard(series)}${allocationCard(a)}</div>${spendCard()}${rebalanceCard(a)}</div>`
  el.querySelector('svg [data-label]')?.closest('section') // (bars carry data-period/data-label for the Expenses drill-down)
  el.addEventListener('click', (e) => {
    const bar = e.target.closest('rect[data-period]')
    if (bar) location.hash = `#/expenses?period=${bar.dataset.period}&label=${encodeURIComponent(bar.dataset.label)}`
  })
}

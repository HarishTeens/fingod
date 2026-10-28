import { investmentsView, RANGE_IDS } from '../repo.js'
import { lineChart } from './charts.js'
import { compact, moneyExact, plain, pct, shortDate, sleeveLabel, sleeveColor, delta, esc, money } from './format.js'

const RANGE_LABEL = { '1w': '1 week', '1m': '1 month', '3m': '3 months', '1y': '1 year', all: 'All' }
let range = '3m', open = null

function indexed(v) {
  const series = Object.entries(v.index).map(([k, pts]) => ({ label: sleeveLabel(k), color: sleeveColor(k), points: pts.map((p) => [Date.parse(p.as_of), p.v]) })).filter((s) => s.points.length > 1)
  if (v.series.length < 2) return `<div class="empty">Indexed performance needs two checkpoints. Take another and the lines appear.</div>`
  const chart = lineChart({ series, yFormat: (n) => String(Math.round(n * 10) / 10), xFormat: (ms) => shortDate(new Date(ms).toISOString().slice(0, 10)), baseline: 100, title: 'Every sleeve indexed to 100' })
  return `${chart}<div class="legend">${series.map((s) => `<span><i class="swatch" style="background:${s.color}"></i>${esc(s.label)}</span>`).join('')}</div>
    <p class="note">Every sleeve starts at 100 on ${shortDate(v.compared_to || v.series[0].as_of)}, so the lines compare <i>rates</i> of change rather than sizes. They are time-weighted: money you added or took out is left out, so a SIP never reads as a gain and a sale never reads as a crash. A line above 100 has grown since then.</p>`
}

function holdingsTable(s) {
  return `<section class="card"><header><h2>${esc(sleeveLabel(s.sleeve))} — holdings</h2></header><div class="table-wrap"><table class="data"><thead><tr>
    <th>Holding</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Value</th><th class="num">Invested</th><th class="num">Since bought</th><th class="num">Share</th>${s.holdings.some((h) => h.market !== null) ? '<th class="num">Market</th>' : ''}</tr></thead><tbody>
    ${s.holdings.map((h) => `<tr><td class="name">${esc(h.name)}${h.flagged ? ' <span class="tag" title="Flow above 25% of the sleeve: a split or bonus?">flow flag</span>' : ''}</td>
      <td class="num">${plain(h.qty, h.qty % 1 ? 4 : 0)}</td><td class="num">${plain(h.price)}${h.currency !== 'INR' ? ` ${esc(h.currency)}` : ''}</td><td class="num">${money(h.value)}</td>
      <td class="num">${h.invested === null ? '—' : money(h.invested)}</td><td class="num">${h.return_pct === null ? '—' : delta(h.return_pct, (v) => `${plain(v)}%`)}</td><td class="num">${plain(h.share_pct, 1)}%</td>
      ${s.holdings.some((x) => x.market !== null) ? `<td class="num">${h.market === null ? '—' : delta(h.market)}</td>` : ''}</tr>`).join('')}
    </tbody></table></div></section>`
}

export function render(el) {
  const v = investmentsView(range)
  const draw = () => {
    const x = investmentsView(range)
    el.innerHTML = `<div class="grid" style="gap:16px">
    <section class="card"><header><h2>Investments — ${x.checkpoints_in_range} checkpoint${x.checkpoints_in_range === 1 ? '' : 's'} in range</h2><span class="spacer"></span>
      <div class="tabs">${RANGE_IDS.map((r) => `<button class="btn" data-range="${r}" aria-pressed="${r === range}">${RANGE_LABEL[r]}</button>`).join(' ')}</div></header>
      <div class="grid cols-2" style="gap:28px"><div><div class="hero-label">Current value</div><div class="hero-figure">${moneyExact(x.total.value)}</div><div class="hero-secondary">${moneyExact(x.total.invested)} invested${x.total.partial ? ' (some holdings have no cost basis)' : ''}</div></div>
      <div><div class="hero-label">Since bought</div><div class="hero-figure" style="font-size:36px">${x.total.return_pct === null ? '—' : delta(x.total.return_pct, (n) => `${plain(n)}%`)}</div><div class="hero-secondary">${compact(x.total.unrealised)} unrealised</div></div></div>
      <p class="note">${x.compared_to ? `Comparing ${shortDate(x.compared_to)} with ${shortDate(x.as_of)}.` : `As of ${shortDate(x.as_of)}. Market / flow / FX appear once there are two checkpoints.`}</p></section>
    <section class="card"><header><h2>Performance — every sleeve indexed to 100</h2></header>${indexed(x)}</section>
    <section class="card"><header><h2>By sleeve</h2></header><div class="table-wrap"><table class="data"><thead><tr><th>Sleeve</th><th class="num">Value</th><th class="num">Invested</th><th class="num">Since bought</th><th class="num">Market</th><th class="num">Flow</th><th class="num">FX</th></tr></thead><tbody>
      ${x.sleeves.map((s) => `<tr><td class="name"><button class="row-btn" data-open="${s.sleeve}" title="Show the holdings"><i class="dot" style="background:${sleeveColor(s.sleeve)}"></i><span class="name">${esc(sleeveLabel(s.sleeve))}</span> <span style="color:var(--muted);margin-left:6px">▸ ${s.holdings.length}</span></button></td>
        <td class="num">${compact(s.value)}</td><td class="num">${compact(s.invested)}${s.partial ? '*' : ''}</td>
        <td class="num">${s.return_pct === null ? '—' : `${delta(s.return_pct, (n) => `${plain(n)}%`)}<div style="color:var(--muted);font-size:12px">${compact(s.unrealised)}</div>`}</td>
        <td class="num">${s.market === null ? '—' : delta(s.market)}</td><td class="num">${s.flow === null ? '—' : delta(s.flow)}</td><td class="num">${s.fx === null ? '—' : delta(s.fx)}</td></tr>`).join('')}
      </tbody></table></div>
      <p class="note"><b>Since bought</b> is cost basis against today's value. <b>Market / flow / fx</b> is what happened between the two checkpoints: the price moving, money you added or took out, and the rupee moving. They sum to the change exactly, which is what stops a SIP looking like a gain.${x.sleeves.some((s) => s.stale) ? ' A sleeve whose source was stale is left out of the split rather than booked as a crash.' : ''}</p></section>
    ${open && x.sleeves.find((s) => s.sleeve === open) ? holdingsTable(x.sleeves.find((s) => s.sleeve === open)) : ''}</div>`
  }
  draw()
  el.addEventListener('click', (e) => {
    const r = e.target.closest('[data-range]'); if (r) { range = r.dataset.range; draw() }
    const o = e.target.closest('[data-open]'); if (o) { open = open === o.dataset.open ? null : o.dataset.open; draw() }
  })
}

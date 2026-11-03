import { trades, disposals, ledgerView } from '../repo.js'
import { summarise, byPeriod } from '../compute/realised.js'
import { recordTrade, deleteTrade, IngestError } from '../ingest.js'
import { stackedBars } from './charts.js'
import { paginate, scrollBox, bindPager } from './pager.js'
import { compact, moneyExact, money, plain, pct, shortDate, monthLabel, sleeveLabel, delta, esc } from './format.js'
import { daysBetween } from '../compute/num.js'

let gran = 'month'

function stat(label, value, sub = '') {
  return `<div><div class="hero-label">${label}</div><div class="hero-figure">${value}</div>${sub ? `<div class="hero-secondary" style="margin-top:2px;font-size:13px">${sub}</div>` : ''}</div>`
}

function detected(d) {
  if (!d.disposals.length) return ''
  return `<section class="card" style="border-color:var(--ring-strong)"><header><h2>Sales detected between ${shortDate(d.between[0])} and ${shortDate(d.between[1])}</h2></header>
    <p class="note" style="margin-top:0">A quantity that fell is a sale. A snapshot only sees what is still held, so the <b>price it sold at</b> is the one number it cannot know. The estimate uses the previous checkpoint's price — enter the real proceeds to record it.</p>
    <div class="table-wrap"><table class="data"><thead><tr><th>Position</th><th class="num">Sold</th><th class="num">Cost of shares sold</th><th class="num">Estimated proceeds</th><th class="num">Actual proceeds (₹)</th><th></th></tr></thead><tbody>
    ${d.disposals.map((x, i) => `<tr><td class="name">${esc(x.name || x.symbol)} <span class="tag">${esc(sleeveLabel(x.sleeve))}</span>${x.full_exit ? ' <span class="tag">full exit</span>' : ''}</td>
      <td class="num">${plain(x.qty_sold, x.qty_sold % 1 ? 4 : 0)}</td><td class="num">${x.invested_sold === null ? '—' : money(x.invested_sold)}</td><td class="num">${money(x.estimated_proceeds)}</td>
      <td class="num"><input id="proc-${i}" type="number" step="0.01" value="${x.estimated_proceeds}" style="width:120px"></td>
      <td><button class="btn" data-record="${i}" ${x.invested_sold === null ? 'disabled title="No cost basis to compute profit from"' : ''}>Record</button></td></tr>`).join('')}
    </tbody></table></div>
    <p class="note">Two blind spots are structural: a stock bought <i>and</i> sold between two checkpoints never appears in a snapshot, and a week with both a sale and a purchase of the same stock nets to one disposal. Weekly checkpoints mean weekly resolution.</p></section>`
}

function sales(all) {
  const pg = paginate('realised-sales', all, { size: 25 })
  return scrollBox(`<table class="data"><thead><tr><th>Holding</th><th class="num">Bought</th><th class="num">Sold</th><th class="num">Qty</th><th class="num">Cost</th><th class="num">Proceeds</th><th class="num">Gain</th><th>Term</th></tr></thead><tbody>
      ${pg.rows.map((d) => `<tr><td class="name">${esc(d.name)}</td><td class="num">${shortDate(d.buy_date)}</td><td class="num">${shortDate(d.sell_date)}</td><td class="num">${plain(d.qty, d.qty % 1 ? 3 : 0)}</td><td class="num">${money(d.cost)}</td><td class="num">${money(d.proceeds)}</td><td class="num">${delta(d.gain)}</td><td>${d.term || 'slab'}</td></tr>`).join('')}
    </tbody></table>`) + pg.controls
}

function capitalGains(v) {
  if (!v) return ''
  const yr = (y) => `<tr><td class="name">${esc(y.fy)}</td><td class="num">${y.disposals}</td><td class="num">${delta(y.st)}</td><td class="num">${delta(y.lt)}</td><td class="num">${y.slab_gain ? delta(y.slab_gain) : '—'}</td><td class="num">${y.est_tax ? money(y.est_tax) : '—'}${y.notes.length ? `<div style="color:var(--muted);font-size:12px;max-width:260px;margin-left:auto">${esc(y.notes.join('; '))}</div>` : ''}</td></tr>`
  const warn = [
    v.mismatches.length ? `<p class="note" style="color:var(--critical)">The ledger disagrees with what you hold for ${v.mismatches.length} position${v.mismatches.length === 1 ? '' : 's'}: ${esc(v.mismatches.slice(0, 5).map((m) => `${m.symbol} (ledger ${plain(m.ledger_qty, 3)}, held ${plain(m.held_qty, 3)})`).join(', '))}${v.mismatches.length > 5 ? ', …' : ''}. A trade is missing, or a bonus or split is not in the ledger. Gains on those positions may be wrong, and XIRR is left blank for their sleeves.</p>` : '',
    v.unmatched.length ? `<p class="note" style="color:var(--critical)">${v.unmatched.length} sale${v.unmatched.length === 1 ? '' : 's'} had no purchase behind ${v.unmatched.length === 1 ? 'it' : 'them'} (${esc(v.unmatched.slice(0, 4).map((u) => u.symbol).join(', '))}${v.unmatched.length > 4 ? ', …' : ''}): the ledger starts after the position was opened. They are left out rather than counted as pure profit.</p>` : '',
  ].join('')
  return `<section class="card"><header><h2>Capital gains, from your trade ledger</h2></header>
    <p class="note" style="margin-top:0">${v.trades.toLocaleString('en-IN')} trades from ${shortDate(v.from)} to ${shortDate(v.to)}, matched first-in first-out. Unlike the sales above, which are inferred from two snapshots, these have exact dates and prices.</p>${warn}
    ${v.years.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Financial year</th><th class="num">Sales</th><th class="num">Short-term</th><th class="num">Long-term</th><th class="num">At slab rate</th><th class="num">Estimated tax</th></tr></thead><tbody>${v.years.map(yr).join('')}</tbody></table></div>` : '<div class="empty">No sales in the ledger yet.</div>'}
    <p class="note"><b>An estimate, not tax advice.</b> Listed equity and equity funds: long-term after 12 months, 12.5% above a ₹1.25 lakh yearly exemption, short-term 20% (15% and 10% with ₹1 lakh before 23 Jul 2024). Foreign shares are long-term after 24 months, gold ETFs after 12. It is before surcharge and cess, and it does not model indexation or carrying losses forward. Debt funds and short-term gains on foreign shares and gold are taxed at your slab rate, so they show as gains but not as tax. Mutual funds are assumed to be equity-oriented.</p>
    ${v.disposals.length ? `<details><summary>Every sale (${v.disposals.length})</summary>${sales(v.disposals)}</details>` : ''}</section>`
}

export function render(el) {
  const draw = () => {
    const ts = trades()
    const s = summarise(ts)
    const d = disposals()
    const tp = paginate('realised-trades', ts, { size: 25 })
    const periods = byPeriod([...ts].reverse(), gran)
    el.innerHTML = `<div class="grid" style="gap:16px">${detected(d)}${capitalGains(ledgerView())}
    <section class="card"><header><h2>Realised profit</h2></header>${ts.length ? `
      <div class="grid stats">
        ${stat('Realised', delta(s.realised, money), `${s.return_pct === null ? '' : `${plain(s.return_pct)}% on ${compact(s.invested)} invested`}`)}
        ${stat('Win rate', s.win_rate_pct === null ? '—' : `${s.win_rate_pct}% <span style="font-size:16px;font-weight:600;color:var(--muted)">${s.winners}/${s.trades}</span>`, `<span class="minibar" style="display:flex;gap:2px;margin:8px 0 0;background:none" title="${s.winners} won, ${s.losers} lost"><span style="flex:${s.winners};background:var(--good)"></span><span style="flex:${s.losers};background:var(--critical)"></span></span>`)}
        ${stat('Gross wins / losses', `${compact(s.gross_wins)} / ${compact(s.gross_losses)}`, 'never netted off')}
        ${stat('Avg holding', s.avg_holding_days === null ? '—' : `${s.avg_holding_days} days`)}
      </div>
      <p class="note">Break-even counts as a loser: it consumed the position and returned nothing, and calling it a win would flatter the hit rate. Gross wins and gross losses are shown apart so a big win can't hide behind many small losses.</p>` : `<div class="empty">No realised trades yet. When a position's quantity falls between two checkpoints, it appears above for you to confirm.</div>`}</section>
    ${ts.length ? `<section class="card"><header><h2>By ${gran === 'all' ? 'all time' : gran}</h2><span class="spacer"></span><div class="tabs">${['month', 'year', 'all'].map((g) => `<button class="btn" data-gran="${g}" aria-pressed="${g === gran}">${g === 'month' ? 'Monthly' : g === 'year' ? 'Yearly' : 'All time'}</button>`).join(' ')}</div></header>
      ${stackedBarsSigned(periods)}</section>
    <section class="card"><header><h2>All trades</h2><span class="spacer"></span><span class="hero-label">${ts.length}</span></header>${scrollBox(`<table class="data"><thead><tr><th>Holding</th><th>Sleeve</th><th>Exited</th><th class="num">Held</th><th class="num">Invested</th><th class="num">Realised</th><th class="num">Return</th><th></th></tr></thead><tbody>
      ${tp.rows.map((t) => `<tr><td class="name">${esc(t.symbol)}</td><td>${esc(sleeveLabel(t.sleeve))}</td><td class="num">${shortDate(t.exit_date)}</td><td class="num">${t.holding_days === null ? '—' : `${t.holding_days}d`}</td><td class="num">${money(t.invested_inr)}</td><td class="num">${delta(t.realised_inr)}</td><td class="num">${t.invested_inr ? `${plain((t.realised_inr / t.invested_inr) * 100)}%` : '—'}</td><td><button class="btn" data-del="${t.id}" title="Remove this trade">✕</button></td></tr>`).join('')}
      </tbody></table>`)}${tp.controls}</section>` : ''}</div>`
  }
  draw()
  bindPager(el, draw)
  el.addEventListener('click', (e) => {
    const g = e.target.closest('[data-gran]'); if (g) { gran = g.dataset.gran; draw() }
    const del = e.target.closest('[data-del]'); if (del && confirm('Remove this trade?')) { deleteTrade(Number(del.dataset.del)); draw() }
    const rec = e.target.closest('[data-record]')
    if (rec) {
      const d = disposals(), x = d.disposals[Number(rec.dataset.record)]
      const proceeds = Number(el.querySelector(`#proc-${rec.dataset.record}`).value)
      if (!Number.isFinite(proceeds)) return alert('Enter the proceeds in rupees.')
      try {
        recordTrade({ sleeve: x.sleeve, symbol: x.symbol, exit_date: d.between[1], invested_inr: x.invested_sold, realised_inr: proceeds - x.invested_sold, holding_days: null, source: 'refresh' })
        draw()
      } catch (err) { alert(err instanceof IngestError ? err.message : String(err)) }
    }
  })
}

const periodLabel = (p) => (gran === 'all' ? 'All time' : gran === 'year' ? p.slice(0, 4) : monthLabel(p))

/** Bars that can go below zero: wins above the axis, losses below. */
function stackedBarsSigned(periods) {
  if (!periods.length) return ''
  const W = 900, H = 260, pad = { l: 62, r: 12, t: 12, b: 28 }
  const max = Math.max(...periods.map((p) => Math.abs(p.realised)), 1)
  const mid = pad.t + (H - pad.t - pad.b) / 2, half = (H - pad.t - pad.b) / 2
  const bw = (W - pad.l - pad.r) / periods.length
  const step = Math.ceil(periods.length / 12)
  const bars = periods.map((p, i) => {
    const h = (Math.abs(p.realised) / max) * (half - 4), w = Math.min(bw * 0.68, 64), x = pad.l + i * bw + (bw - w) / 2
    const up = p.realised >= 0
    return `<rect x="${x.toFixed(1)}" y="${(up ? mid - h : mid).toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(h, 1).toFixed(1)}" rx="2" fill="var(--${up ? 'good' : 'critical'})"><title>${periodLabel(p.period)} · ${compact(p.realised)} · ${p.trades} trade${p.trades === 1 ? '' : 's'}</title></rect>` +
      (i % step === 0 ? `<text x="${(x + w / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle" fill="var(--muted)" font-size="11.5">${periodLabel(p.period)}</text>` : '')
  }).join('')
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block"><line x1="${pad.l}" x2="${W - pad.r}" y1="${mid}" y2="${mid}" stroke="var(--baseline)"/><text x="${pad.l - 8}" y="${mid + 4}" text-anchor="end" fill="var(--muted)" font-size="11.5">₹0</text><text x="${pad.l - 8}" y="${pad.t + 10}" text-anchor="end" fill="var(--muted)" font-size="11.5">${compact(max)}</text><text x="${pad.l - 8}" y="${H - pad.b}" text-anchor="end" fill="var(--muted)" font-size="11.5">−${compact(max).replace('₹', '₹')}</text>${bars}</svg>`
}

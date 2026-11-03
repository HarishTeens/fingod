import { transactionsAll, labelsMap, transactionCount } from '../repo.js'
import { expenseByLabel, expenseByCategory, breakdown, listTransactions, UNTAGGED } from '../compute/expenses.js'
import { stackedBars } from './charts.js'
import { paginate, scrollBox, bindPager } from './pager.js'
import { compact, moneyExact, money, plain, shortDate, monthLabel, labelColor, categoryColor, esc } from './format.js'

let gran = 'month'
let by = null // 'label' | 'category'; null until chosen, then label if the records carry any
const drill = { period: null, category: null, subcategory: null, label: null }

const periodLabel = (p) => (gran === 'week' ? `Week of ${shortDate(p)}` : monthLabel(p))

function readHash() {
  const q = new URLSearchParams(location.hash.split('?')[1] || '')
  if (q.get('period')) { drill.period = q.get('period'); drill.label = q.get('label'); drill.category = drill.subcategory = null }
}

function list(id, title, allRows, total, picked, attr, colorFor) {
  const pg = paginate(id, allRows, { size: 10 }), rows = pg.rows
  return `<section class="card"><header><h2>${title}</h2></header>${scrollBox(`<table class="data"><tbody>
    ${rows.map((r) => `<tr class="${picked === r.key ? 'picked' : ''}"><td class="name"><button class="row-btn" data-${attr}="${esc(r.key)}">${colorFor ? `<i class="dot" style="background:${colorFor(r.key)}"></i>` : ''}<span class="name">${esc(r.key)}</span></button></td>
      <td style="width:110px"><span class="minibar"><span style="width:${total ? (r.amount / total) * 100 : 0}%"></span></span></td><td class="num">${money(r.amount)}</td><td class="num" style="color:var(--muted)">${r.count}</td></tr>`).join('') || '<tr><td class="empty" colspan="4">Nothing here.</td></tr>'}
    </tbody></table>`)}${pg.controls}</section>`
}

export function render(el) {
  readHash()
  if (!transactionCount()) { el.innerHTML = `<div class="empty">No transactions yet.<br>Connect Wallet from <a href="#/welcome" style="color:var(--ink)">the setup guide</a> and your expenses appear here.</div>`; return }
  const txns = transactionsAll(), labels = labelsMap()
  const draw = () => {
    const byLabels = expenseByLabel(txns, labels, gran)
    const chosen = by || (byLabels.labels.every((l) => l === UNTAGGED) ? 'category' : 'label') // no labels in Wallet: spend by category
    const { labels: names, series } = chosen === 'category' ? expenseByCategory(txns, labels, gran) : byLabels
    const colorOf = chosen === 'category' ? categoryColor : labelColor
    const shown = series.slice(gran === 'week' ? -26 : -24)
    const base = { period: drill.period, granularity: gran, label: drill.label }
    const byCat = breakdown(txns, labels, { ...base, by: 'category', category: drill.category })
    const byLabel = breakdown(txns, labels, { period: drill.period, granularity: gran, by: 'label', category: drill.category, subcategory: drill.subcategory })
    const rows = listTransactions(txns, labels, { ...base, category: drill.category, subcategory: drill.subcategory, limit: Infinity })
    const pg = paginate('expenses-txns', rows, { size: 25 })
    const crumbs = [
      { text: drill.period ? periodLabel(drill.period) : 'All periods', on: () => { drill.category = drill.subcategory = null } },
      drill.category && { text: drill.category, on: () => { drill.subcategory = null } },
      drill.subcategory && { text: drill.subcategory },
    ].filter(Boolean)
    el.innerHTML = `<div class="grid" style="gap:16px">
    <section class="card"><header><h2>${gran === 'week' ? 'Weekly' : 'Monthly'} spend by ${chosen}</h2><span class="spacer"></span><div class="tabs">${['label', 'category'].map((b) => `<button class="btn" data-by="${b}" aria-pressed="${b === chosen}">By ${b}</button>`).join(' ')}</div><div class="tabs" style="margin-left:8px">${['week', 'month'].map((g) => `<button class="btn" data-gran="${g}" aria-pressed="${g === gran}">${g === 'week' ? 'Weekly' : 'Monthly'}</button>`).join(' ')}</div></header>
      ${stackedBars({ periods: shown.map((p) => ({ ...p, label: gran === 'week' ? shortDate(p.period) : monthLabel(p.period) })), keys: names.slice().reverse(), color: colorOf, yFormat: compact, title: `Spend by ${chosen}` })}
      <div class="legend">${names.map((l) => `<span><i class="swatch" style="background:${colorOf(l)}"></i>${esc(l)}</span>`).join('')}</div>
      <p class="note">Click a bar to drill into that period. Bars are net of money that came back under the same ${chosen}; transfers between your own accounts and Investments are excluded.</p></section>
    ${drill.period || drill.category || drill.label ? `<section class="card" style="padding:14px 22px"><div class="crumbs">${crumbs.map((c, i) => `${i ? '<span class="sep">›</span>' : ''}${i < crumbs.length - 1 ? `<button class="crumb" data-crumb="${i}">${esc(c.text)}</button>` : `<span class="crumb current">${esc(c.text)}</span>`}`).join('')}
      ${drill.label ? `<button class="btn" style="margin-left:10px" data-clear-label>label: ${esc(drill.label)} ✕</button>` : ''}${drill.period ? '<button class="btn" style="margin-left:auto" data-reset>Clear</button>' : ''}</div></section>` : ''}
    <div class="grid cols-2">${list('expenses-cats', drill.category ? `${esc(drill.category)} — subcategories` : 'Categories', byCat.rows, byCat.total, drill.subcategory || drill.category, 'cat', null)}${list('expenses-labels', 'Labels', byLabel.rows, byLabel.total, drill.label, 'label', labelColor)}</div>
    <section class="card"><header><h2>Transactions</h2><span class="spacer"></span><span class="hero-label">${rows.length.toLocaleString('en-IN')}</span></header>${scrollBox(`<table class="data"><tbody>
      ${pg.rows.map((t) => `<tr><td class="num" style="text-align:left;white-space:nowrap">${shortDate(t.txn_date)}</td><td class="name">${esc(t.note || t.category || '—')}<div style="color:var(--muted);font-size:12px">${esc(t.category_top || '')}${t.category ? ` · ${esc(t.category)}` : ''} · ${esc(t.account || '')}</div></td><td>${t.labels.map((l) => `<span class="tag">${esc(l)}</span>`).join('')}</td><td class="num">${moneyExact(-t.amount_inr)}</td></tr>`).join('') || '<tr><td class="empty">No transactions.</td></tr>'}
      </tbody></table>`)}${pg.controls}</section></div>`
    el._crumbs = crumbs
  }
  draw()
  bindPager(el, draw)
  el.addEventListener('click', (e) => {
    const g = e.target.closest('[data-gran]'); if (g) { gran = g.dataset.gran; Object.assign(drill, { period: null, category: null, subcategory: null }); return draw() }
    const b = e.target.closest('[data-by]'); if (b) { by = b.dataset.by; Object.assign(drill, { period: null, category: null, subcategory: null, label: null }); return draw() }
    const bar = e.target.closest('rect[data-period]'); if (bar) {
      const seg = bar.dataset.label
      if (el.querySelector('[data-by][aria-pressed="true"]').dataset.by === 'category') Object.assign(drill, { period: bar.dataset.period, category: seg === 'Other' ? null : seg, subcategory: null, label: null })
      else Object.assign(drill, { period: bar.dataset.period, label: seg === UNTAGGED ? UNTAGGED : seg, category: null, subcategory: null })
      return draw()
    }
    const cat = e.target.closest('[data-cat]'); if (cat) { if (!drill.category) drill.category = cat.dataset.cat; else drill.subcategory = cat.dataset.cat; return draw() }
    const lab = e.target.closest('[data-label]'); if (lab) { drill.label = drill.label === lab.dataset.label ? null : lab.dataset.label; return draw() }
    const crumb = e.target.closest('[data-crumb]'); if (crumb) { el._crumbs[Number(crumb.dataset.crumb)].on?.(); return draw() }
    if (e.target.closest('[data-clear-label]')) { drill.label = null; return draw() }
    if (e.target.closest('[data-reset]')) { Object.assign(drill, { period: null, category: null, subcategory: null, label: null }); return draw() }
  })
}

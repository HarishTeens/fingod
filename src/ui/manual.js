// Hand-entered figures: Bitcoin, fixed deposits, Splitwise and allocation targets.
// Your agent can also write these as a file (docs/DATA-FORMAT.md, "Standing rows");
// these forms are for quick edits any time.
import { fixedDeposits, splitwise, targets, manualBtc } from '../repo.js'
import { getSetting, setSetting } from '../db.js'
import { setManualHolding, saveFixedDeposit, deleteFixedDeposit, saveSplitwise, deleteSplitwise, IngestError } from '../ingest.js'
import { esc, money, sleeveLabel } from './format.js'

const TARGET_KEYS = ['in_equity', 'in_mf', 'us_equity', 'gold', 'debt', 'btc', 'fd', 'liquid', 'epf']

export function section() {
  const m = manualBtc(), fds = fixedDeposits(), sw = splitwise(), t = targets()
  const isDefault = getSetting('target_allocation', null) === null
  return `<section class="card"><header><h2>Bitcoin</h2></header>
    <p class="hero-secondary" style="margin-top:0">Exchanges like CoinDCX have no MCP, so you type two numbers. The quantity is carried into later checkpoints; next time only the value changes.</p>
    <form class="form inline" data-form="btc"><label>Quantity<input name="qty" type="number" step="any" min="0" placeholder="0.0125" value="${m ? m.qty : ''}" required></label>
      <label>Current value ₹<input name="value" type="number" step="any" min="0" placeholder="106000" value="${m ? Math.round(m.qty * m.price) : ''}" required></label>
      <label>Total you paid ₹ <span class="muted">(optional)</span><input name="invested" type="number" step="any" min="0" value="${m && m.invested_inr ? m.invested_inr : ''}"></label>
      <button class="btn primary" type="submit">Save Bitcoin</button></form></section>

  <section class="card"><header><h2>Fixed deposits</h2></header>
    ${fds.length ? `<ul class="rows">${fds.map((f) => `<li>${esc(f.bank)} · ${money(f.principal)} at ${f.rate_pct}% from ${esc(f.start_date)}${f.maturity_date ? ` to ${esc(f.maturity_date)}` : ''}<button class="btn" data-del-fd="${f.id}">Remove</button></li>`).join('')}</ul>` : '<p class="muted" style="margin-top:0">None yet.</p>'}
    <form class="form inline" data-form="fd"><label>Bank<input name="bank" placeholder="Example Bank" required></label><label>Principal ₹<input name="principal" type="number" step="any" required></label>
      <label>Rate %<input name="rate_pct" type="number" step="0.01" required></label><label>Start<input name="start_date" type="date" required></label><label>Maturity<input name="maturity_date" type="date"></label>
      <button class="btn primary" type="submit">Add deposit</button></form>
    <p class="note">Interest is computed from the rate and dates, so a deposit is valued correctly at every checkpoint, even ones taken before you entered it.</p></section>

  <section class="card"><header><h2>Splitwise</h2></header>
    <p class="hero-secondary" style="margin-top:0">Just the bottom line per person. Positive means they owe you; negative means you owe them.</p>
    ${sw.length ? `<ul class="rows">${sw.map((p) => `<li>${esc(p.person)} · ${money(p.amount_inr)}<button class="btn" data-del-sw="${esc(p.person)}">Remove</button></li>`).join('')}</ul>` : ''}
    <form class="form inline" data-form="sw"><label>Person<input name="person" required></label><label>Amount ₹<input name="amount" type="number" step="any" required></label><label>Note<input name="note"></label><button class="btn primary" type="submit">Add</button></form></section>

  <section class="card"><header><h2>Allocation targets</h2></header>
    <p class="hero-secondary" style="margin-top:0">Where do you want your money to be? The dashboard shows the drift. Percentages should total 100. Set an asset to 0 to keep it out of the rebalance (EPF, say).${isDefault ? ' <b>These are the defaults; you have not set your own.</b>' : ''}</p>
    <form class="form targets" data-form="targets">${TARGET_KEYS.map((k) => `<label>${esc(sleeveLabel(k))}<input name="${k}" type="number" step="1" min="0" max="100" value="${t[k] ?? 0}"></label>`).join('')}
      <div class="total">Total <b data-total>100</b>% <span class="saved" data-saved></span></div></form></section>`
}

/** Wire the forms inside `el` once; `redraw` re-renders the page after a change. */
export function bind(el, redraw) {
  const total = () => { const f = el.querySelector('[data-form="targets"]'); if (f) f.querySelector('[data-total]').textContent = [...f.querySelectorAll('input')].reduce((a, i) => a + Number(i.value || 0), 0) }
  const saveTargets = (f) => { const t = {}; for (const [k, v] of new FormData(f)) if (Number(v) > 0) t[k] = Number(v); setSetting('target_allocation', t) }
  let timer
  el.addEventListener('input', (e) => {
    const f = e.target.closest('[data-form="targets"]'); if (!f) return
    total(); clearTimeout(timer)
    timer = setTimeout(() => { saveTargets(f); const n = f.querySelector('[data-saved]'); if (n) { n.textContent = 'Saved ✓'; setTimeout(() => (n.textContent = ''), 2000) } }, 400) // autosave as you type
  })
  el.addEventListener('submit', (e) => {
    const f = e.target.closest('[data-form]'); if (!f) return
    e.preventDefault()
    const d = Object.fromEntries(new FormData(f))
    try {
      if (f.dataset.form === 'btc') setManualHolding({ qty: d.qty, value: d.value, invested_inr: d.invested || null })
      else if (f.dataset.form === 'fd') saveFixedDeposit(d)
      else if (f.dataset.form === 'sw') saveSplitwise(d.person, d.amount, d.note)
      else if (f.dataset.form === 'targets') saveTargets(f)
      redraw()
    } catch (err) { alert(err instanceof IngestError ? err.message : String(err)) }
  })
  el.addEventListener('click', (e) => {
    const fd = e.target.closest('[data-del-fd]'); if (fd) { deleteFixedDeposit(Number(fd.dataset.delFd)); redraw() }
    const sw = e.target.closest('[data-del-sw]'); if (sw) { deleteSplitwise(sw.dataset.delSw); redraw() }
  })
  total()
}

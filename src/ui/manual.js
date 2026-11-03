// Hand-entered figures: Bitcoin, fixed deposits, Splitwise and allocation targets.
// Your agent can also write these as a file (docs/DATA-FORMAT.md, "Standing rows");
// these forms are for quick edits any time.
import { fixedDeposits, ppfDeposits, ppfRates, splitwise, targets, manualBtc, manualAssets } from '../repo.js'
import { getSetting, setSetting } from '../db.js'
import { setManualHolding, saveFixedDeposit, deleteFixedDeposit, savePpfDeposit, deletePpfDeposit, setPpfRate, deletePpfRate, saveSplitwise, deleteSplitwise, saveAsset, deleteAsset, ASSET_KINDS, LIABILITY_KINDS, IngestError } from '../ingest.js'
import { esc, money, sleeveLabel } from './format.js'
import { quartersBetween, quarterStart, quarterLabel, balance as ppfBalance } from '../compute/ppf.js'

const KIND_LABEL = (k) => k.replace(/_/g, ' ')
const TARGET_KEYS = ['in_equity', 'in_mf', 'us_equity', 'gold', 'debt', 'btc', 'fd', 'liquid', 'epf', 'ppf']

function ppfCard(deposits, rates) {
  const today = new Date().toISOString().slice(0, 10)
  const b = deposits.length ? ppfBalance(deposits, rates, today) : null
  const quarters = deposits.length ? quartersBetween(deposits[0].deposit_date, today) : [quarterStart(today)]
  const rateOf = new Map(rates.map((r) => [r.quarter_start, r.rate_pct]))
  return `<p class="hero-secondary" style="margin-top:0">Public Provident Fund. Type each deposit and the rate the government set for each quarter; the balance is worked out the way the passbook does it (lowest balance between the 5th and month end, credited every 31 March). It counts in your total net worth, not the liquid figure.</p>
    ${b ? `<p>Balance today <b>${money(b.value)}</b> · ${money(b.deposited)} deposited · ${money(b.interest)} interest${b.missing.length ? ` <span class="muted">· ${b.missing.length} quarter${b.missing.length > 1 ? 's' : ''} below had no rate of their own, so the last known one was used</span>` : ''}</p>` : ''}
    ${deposits.length ? `<ul class="rows">${deposits.map((d) => `<li>${esc(d.deposit_date)} · ${money(d.amount_inr)}${d.note ? ` <span class="muted">· ${esc(d.note)}</span>` : ''}<button class="btn" data-del-ppf="${d.id}">Remove</button></li>`).join('')}</ul>` : '<p class="muted" style="margin-top:0">No deposits yet.</p>'}
    <form class="form inline" data-form="ppf"><label>Date<input name="deposit_date" type="date" required></label><label>Amount ₹<input name="amount_inr" type="number" step="any" min="0" required></label><label>Note<input name="note"></label>
      <button class="btn primary" type="submit">Add deposit</button></form>
    <details style="margin-top:12px"><summary>Quarterly interest rates (${rates.length} set)</summary>
      ${rates.length ? `<ul class="rows">${rates.map((r) => `<li>${esc(quarterLabel(r.quarter_start))} · ${r.rate_pct}%<button class="btn" data-del-ppf-rate="${esc(r.quarter_start)}">Remove</button></li>`).join('')}</ul>` : ''}
      <form class="form inline" data-form="ppfrate"><label>Quarter<select name="quarter_start">${[...new Set([...quarters, ...rateOf.keys()])].sort().reverse().map((q) => `<option value="${q}">${esc(quarterLabel(q))}${rateOf.has(q) ? ` · ${rateOf.get(q)}%` : ''}</option>`).join('')}</select></label>
        <label>Rate %<input name="rate_pct" type="number" step="0.01" min="0" max="20" required></label><button class="btn primary" type="submit">Save rate</button></form></details>`
}

export function section() {
  const m = manualBtc(), fds = fixedDeposits(), ppf = ppfDeposits(), rates = ppfRates(), sw = splitwise(), t = targets(), assets = manualAssets()
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

  <section class="card"><header><h2>PPF</h2></header>
    ${ppfCard(ppf, rates)}</section>

  <section class="card"><header><h2>Splitwise</h2></header>
    <p class="hero-secondary" style="margin-top:0">Just the bottom line per person. Positive means they owe you; negative means you owe them.</p>
    ${sw.length ? `<ul class="rows">${sw.map((p) => `<li>${esc(p.person)} · ${money(p.amount_inr)}<button class="btn" data-del-sw="${esc(p.person)}">Remove</button></li>`).join('')}</ul>` : ''}
    <form class="form inline" data-form="sw"><label>Person<input name="person" required></label><label>Amount ₹<input name="amount" type="number" step="any" required></label><label>Note<input name="note"></label><button class="btn primary" type="submit">Add</button></form></section>

  <section class="card"><header><h2>Other assets and loans</h2></header>
    <p class="hero-secondary" style="margin-top:0">NPS, property, physical gold, and what you owe on a loan. They move your total net worth but not the liquid figure. Enter a newer value any time: earlier checkpoints keep the value that was true then.</p>
    ${(() => { const latest = new Map(); for (const a of assets) latest.set(`${a.kind}\0${a.name}`, a); const rows = [...latest.values()]; return rows.length ? `<ul class="rows">${rows.map((a) => `<li>${esc(a.name)} <span class="muted">· ${esc(KIND_LABEL(a.kind))}${a.liability ? ' (loan)' : ''}</span> · ${money(a.value_inr)} <span class="muted">as of ${esc(a.as_of_date)}</span><button class="btn" data-del-asset="${esc(a.kind)}|${esc(a.name)}">Remove</button></li>`).join('')}</ul>` : '<p class="muted" style="margin-top:0">None yet.</p>' })()}
    <form class="form inline" data-form="asset"><label>Type<select name="kind">${[...ASSET_KINDS.map((k) => `<option value="${k}">${esc(KIND_LABEL(k))}</option>`), ...LIABILITY_KINDS.map((k) => `<option value="loan:${k}">${esc(KIND_LABEL(k))} (you owe)</option>`)].join('')}</select></label>
      <label>Name<input name="name" placeholder="NPS Tier 1" required></label><label>Value ₹<input name="value" type="number" step="any" min="0" required></label><label>As of<input name="as_of" type="date" value="${new Date().toISOString().slice(0, 10)}"></label>
      <button class="btn primary" type="submit">Save</button></form></section>

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
      else if (f.dataset.form === 'ppf') savePpfDeposit(d)
      else if (f.dataset.form === 'ppfrate') setPpfRate(d.quarter_start, d.rate_pct)
      else if (f.dataset.form === 'sw') saveSplitwise(d.person, d.amount, d.note)
      else if (f.dataset.form === 'asset') { const loan = d.kind.startsWith('loan:'); saveAsset({ kind: loan ? d.kind.slice(5) : d.kind, name: d.name, value_inr: d.value, as_of_date: d.as_of, liability: loan }) }
      else if (f.dataset.form === 'targets') saveTargets(f)
      redraw()
    } catch (err) { alert(err instanceof IngestError ? err.message : String(err)) }
  })
  el.addEventListener('click', (e) => {
    const fd = e.target.closest('[data-del-fd]'); if (fd) { deleteFixedDeposit(Number(fd.dataset.delFd)); redraw() }
    const pd = e.target.closest('[data-del-ppf]'); if (pd) { deletePpfDeposit(Number(pd.dataset.delPpf)); redraw() }
    const pr = e.target.closest('[data-del-ppf-rate]'); if (pr) { deletePpfRate(pr.dataset.delPpfRate); redraw() }
    const sw = e.target.closest('[data-del-sw]'); if (sw) { deleteSplitwise(sw.dataset.delSw); redraw() }
    const as = e.target.closest('[data-del-asset]'); if (as) { const [kind, ...name] = as.dataset.delAsset.split('|'); deleteAsset(kind, name.join('|')); redraw() }
  })
  total()
}

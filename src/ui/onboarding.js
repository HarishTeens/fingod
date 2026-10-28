// The setup journey. The browser cannot speak MCP, so each connector step hands
// the user a prompt for their coding agent and shows live status as the agent's
// files arrive in data/. Manual figures (Bitcoin, FDs, Splitwise) are entered here.
import { connectorStatus, hasData, fixedDeposits, splitwise, targets, manualBtc } from '../repo.js'
import { getSetting, setSetting } from '../db.js'
import { syncInbox, setManualHolding, saveFixedDeposit, deleteFixedDeposit, saveSplitwise, deleteSplitwise, createManualCheckpoint, ingestAny, IngestError } from '../ingest.js'
import { CONNECTORS, MASTER } from '../prompts.js'
import { loadDemo } from '../demo.js'
import { esc, money, sleeveLabel } from './format.js'
import { DEFAULT_TARGET } from '../compute/allocation.js'

const CHOICES = [
  { id: 'wallet', icon: '◧', ...pick('wallet') },
  { id: 'kite', icon: '◩', ...pick('kite') },
  { id: 'indmoney', icon: '◪', ...pick('indmoney') },
  { id: 'epf', icon: '◫', ...pick('epf') },
  { id: 'btc', icon: '◈', name: 'Bitcoin', by: 'manual entry', brings: 'Quantity and current value, typed in', why: '' },
  { id: 'extras', icon: '◇', name: 'FDs & Splitwise', by: 'manual entry', brings: 'Fixed deposits and who owes whom', why: '' },
]
function pick(id) { const c = CONNECTORS[id]; return { name: c.name, by: c.by, brings: c.brings, why: c.why } }

const DEFAULTS = { selected: { wallet: true, kite: true, indmoney: true, epf: true, btc: true, extras: false }, step: 0 }
const state = () => ({ ...DEFAULTS, ...(getSetting('onboarding', {}) || {}), selected: { ...DEFAULTS.selected, ...((getSetting('onboarding', {}) || {}).selected || {}) } })
const save = (s) => setSetting('onboarding', s)

/** The ordered steps for the user's choices. */
function stepsFor(sel) {
  const s = [{ id: 'welcome', title: 'Welcome' }]
  for (const id of ['wallet', 'kite', 'indmoney', 'epf']) if (sel[id]) s.push({ id, title: CONNECTORS[id].name })
  if (sel.btc) s.push({ id: 'btc', title: 'Bitcoin' })
  if (sel.extras) s.push({ id: 'extras', title: 'FDs & Splitwise' })
  s.push({ id: 'targets', title: 'Targets' }, { id: 'finish', title: 'Finish' })
  return s
}

async function copy(text, btn) {
  try { await navigator.clipboard.writeText(text) } catch {
    const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove()
  }
  const old = btn.textContent; btn.textContent = 'Copied ✓'; setTimeout(() => (btn.textContent = old), 1800)
}

const promptBox = (text, id) => `<div class="prompt"><pre id="${id}">${esc(text)}</pre><button class="btn primary" data-copy="${id}">Copy prompt</button></div>`
const statusBox = (id) => `<div class="status" data-status="${id}"><span class="spin"></span><span>Waiting for your agent…</span></div>`

function serverNote() {
  return `<p class="note" data-serverless hidden>The app can't see the <code>data/</code> folder because it isn't running under <code>serve.py</code>. Start it with <code>python3 serve.py</code>, or drop the JSON files onto the box on the last step.</p>`
}

// --- step bodies ------------------------------------------------------------------
function welcome(s) {
  return `<h1>Your money, assembled.</h1>
  <p class="lede">fingod runs entirely in this browser. Your data is stored here, in SQLite, and goes nowhere else. Pick what you use and we'll connect it, one step at a time.</p>
  <div class="choices">${CHOICES.map((c) => `<label class="choice ${s.selected[c.id] ? 'on' : ''}"><input type="checkbox" data-choice="${c.id}" ${s.selected[c.id] ? 'checked' : ''}>
    <span class="ico">${c.icon}</span><span><b>${esc(c.name)}</b> <em>${esc(c.by)}</em><br><span class="muted">${esc(c.brings)}</span></span></label>`).join('')}</div>
  <p class="note">Wallet, Kite and INDmoney connect through your coding agent (Claude Code or any agent with MCP support), because browsers can't speak MCP. Nothing is ever traded: every connector is read-only.</p>
  <div class="actions"><button class="btn primary big" data-next>Continue</button><button class="btn big" data-demo>Explore with demo data</button></div>`
}

function connector(id) {
  const c = CONNECTORS[id]
  return `<div class="eyebrow">${esc(c.by)}</div><h1>${esc(c.name)}</h1><p class="lede">${esc(c.brings)}. ${esc(c.why)}</p>
  <ol class="how">${c.steps.map((t) => `<li>${esc(t)}</li>`).join('')}</ol>
  ${promptBox(c.prompt, `p-${id}`)}${statusBox(id)}${serverNote()}
  <div class="actions"><button class="btn big" data-back>Back</button><button class="btn primary big" data-next>Continue</button><button class="btn big" data-next>Skip for now</button></div>`
}

function btc() {
  const m = manualBtc()
  return `<div class="eyebrow">Manual</div><h1>Bitcoin</h1><p class="lede">Exchanges like CoinDCX have no MCP, and INDmoney reports crypto as a value with no quantity, which the engine can't use. So you type two numbers.</p>
  <form class="form" data-form="btc"><label>Quantity<input name="qty" type="number" step="any" min="0" placeholder="0.0125" value="${m ? m.qty : ''}" required></label>
  <label>Current total value (₹)<input name="value" type="number" step="any" min="0" placeholder="106000" value="${m ? Math.round(m.qty * m.price) : ''}" required></label>
  <label>Total you paid, ₹ <em class="muted">(optional, gives a return)</em><input name="invested" type="number" step="any" min="0" value="${m && m.invested_inr ? m.invested_inr : ''}"></label>
  <div class="actions"><button class="btn primary" type="submit">Save Bitcoin</button><span class="saved" data-saved></span></div></form>
  <p class="note">The quantity is carried forward into every later checkpoint, so next time you only update the value.</p>
  <div class="actions"><button class="btn big" data-back>Back</button><button class="btn primary big" data-next>Continue</button></div>`
}

function extras() {
  const fds = fixedDeposits(), sw = splitwise()
  return `<div class="eyebrow">Manual</div><h1>Fixed deposits & Splitwise</h1><p class="lede">Entered once, valued at every checkpoint. A deposit's interest is computed from its rate and dates, so you never re-type it.</p>
  <h3>Fixed deposits</h3>${fds.length ? `<ul class="rows">${fds.map((f) => `<li>${esc(f.bank)} · ${money(f.principal)} at ${f.rate_pct}% from ${f.start_date}<button class="btn" data-del-fd="${f.id}">Remove</button></li>`).join('')}</ul>` : ''}
  <form class="form inline" data-form="fd"><label>Bank<input name="bank" placeholder="Example Bank" required></label><label>Principal ₹<input name="principal" type="number" step="any" required></label>
  <label>Rate %<input name="rate_pct" type="number" step="0.01" required></label><label>Start<input name="start_date" type="date" required></label><label>Maturity<input name="maturity_date" type="date"></label>
  <button class="btn primary" type="submit">Add deposit</button></form>
  <h3>Splitwise</h3><p class="muted">Just the bottom line per person. Positive means they owe you; negative means you owe them.</p>
  ${sw.length ? `<ul class="rows">${sw.map((p) => `<li>${esc(p.person)} · ${money(p.amount_inr)}<button class="btn" data-del-sw="${esc(p.person)}">Remove</button></li>`).join('')}</ul>` : ''}
  <form class="form inline" data-form="sw"><label>Person<input name="person" required></label><label>Amount ₹<input name="amount" type="number" step="any" required></label><label>Note<input name="note"></label><button class="btn primary" type="submit">Add</button></form>
  <div class="actions"><button class="btn big" data-back>Back</button><button class="btn primary big" data-next>Continue</button></div>`
}

function targetsStep() {
  const t = targets()
  const keys = ['in_equity', 'in_mf', 'us_equity', 'gold', 'debt', 'btc', 'fd', 'liquid', 'epf']
  return `<div class="eyebrow">Optional</div><h1>Allocation targets</h1><p class="lede">Where do you want your money to be? fingod shows the drift after every checkpoint. Percentages should total 100. Leave a sleeve at 0 to keep it out of the rebalance (EPF, say).</p>
  <form class="form targets" data-form="targets">${keys.map((k) => `<label>${esc(sleeveLabel(k))}<input name="${k}" type="number" step="1" min="0" max="100" value="${t[k] ?? 0}"></label>`).join('')}
  <div class="total">Total <b data-total>100</b>%</div><div class="actions"><button class="btn primary" type="submit">Save targets</button><span class="saved" data-saved></span></div></form>
  <div class="actions"><button class="btn big" data-back>Back</button><button class="btn primary big" data-next>Continue</button></div>`
}

function finish(s) {
  const st = connectorStatus()
  const rows = [['wallet', 'Wallet'], ['kite', 'Zerodha Kite'], ['indmoney', 'INDmoney'], ['btc', 'Bitcoin'], ['fd', 'Fixed deposits'], ['splitwise', 'Splitwise']].filter(([id]) => s.selected[id] || (id === 'fd' || id === 'splitwise' ? s.selected.extras : false))
  return `<div class="eyebrow">Last step</div><h1>Take your first checkpoint</h1>
  <p class="lede">A checkpoint is a snapshot of everything you own on one date. Your agent takes one by reading each connected source. Run it weekly, or whenever you want an answer.</p>
  <ul class="rows checklist" data-checklist>${rows.map(([id, n]) => `<li data-check="${id}"><span class="tick">○</span><b>${n}</b><span class="muted" data-check-detail>not yet</span></li>`).join('')}</ul>
  ${promptBox(MASTER, 'p-master')}${statusBox('finish')}${serverNote()}
  <div class="drop" data-drop><b>Or drop files here</b><span class="muted">checkpoint or transactions JSON from your agent</span><input type="file" accept=".json,application/json" multiple data-file hidden><button class="btn" data-pick>Choose files</button></div>
  <div class="actions"><button class="btn big" data-back>Back</button><button class="btn primary big" data-open ${hasData() ? '' : 'disabled'}>Open my dashboard</button><button class="btn big" data-manual>Use only what I typed in</button></div>`
}

const BODY = { welcome, btc, extras, targets: targetsStep, finish }

// --- status ---------------------------------------------------------------------------
async function refreshStatus(el, steps, idx) {
  const result = await syncInbox()
  const noServer = !result.available
  el.querySelectorAll('[data-serverless]').forEach((n) => (n.hidden = !noServer))
  const st = connectorStatus()
  const step = steps[idx]
  const box = el.querySelector(`[data-status="${step.id}"]`)
  if (box) {
    let msg = null
    if (CONNECTORS[step.id]) msg = CONNECTORS[step.id].done(st)
    if (step.id === 'finish') msg = st.checkpoint ? `Checkpoint received · as of ${st.checkpoint}` : null
    box.classList.toggle('ok', !!msg)
    box.innerHTML = msg ? `<span class="tickmark">✓</span><span>Received: ${esc(msg)}</span>` : `<span class="spin"></span><span>${noServer ? 'Not running under serve.py yet' : 'Waiting for your agent…'}</span>`
  }
  el.querySelectorAll('[data-check]').forEach((li) => {
    const id = li.dataset.check
    const ok = id === 'fd' ? st.fd.ok : id === 'splitwise' ? st.splitwise.ok : st[id] && st[id].ok
    li.querySelector('.tick').textContent = ok ? '✓' : '○'; li.classList.toggle('ok', !!ok)
    const d = li.querySelector('[data-check-detail]')
    d.textContent = ok ? (id === 'wallet' ? `${st.wallet.transactions} transactions, ${st.wallet.balances} balances` : id === 'kite' ? `${st.kite.equity} stocks, ${st.kite.funds} funds` : id === 'indmoney' ? `${st.indmoney.us} US holdings` : 'done') : 'not yet'
  })
  const open = el.querySelector('[data-open]'); if (open) open.disabled = !hasData()
  return result
}

// --- the view ---------------------------------------------------------------------------
export function render(el, { onDone }) {
  let s = state()
  let steps = stepsFor(s.selected)
  let idx = Math.min(Math.max(s.step || 0, 0), steps.length - 1)
  let timer
  if (s.goto) { // arrived from "edit" on the Data page: jump straight to that step
    if (s.goto in s.selected) s.selected[s.goto] = true
    steps = stepsFor(s.selected)
    idx = Math.max(0, steps.findIndex((x) => x.id === s.goto)); delete s.goto; save(s)
  }

  const go = (n) => { idx = Math.max(0, Math.min(steps.length - 1, n)); s.step = idx; save(s); draw() }

  function draw() {
    clearInterval(timer)
    steps = stepsFor(s.selected)
    const step = steps[idx]
    const body = BODY[step.id] ? BODY[step.id](s) : connector(step.id)
    el.innerHTML = `<div class="onboard"><div class="stepper">${steps.map((x, i) => `<button class="pip ${i === idx ? 'now' : i < idx ? 'past' : ''}" data-goto="${i}"><span>${i < idx ? '✓' : i + 1}</span>${esc(x.title)}</button>`).join('')}</div>
      <div class="panel">${body}</div><div class="onboard-foot"><a href="#/dashboard" data-skip>${hasData() ? 'Close setup' : 'Skip setup'}</a> · your data never leaves this browser</div></div>`
    bind()
    refreshStatus(el, steps, idx)
    if (['finish', ...Object.keys(CONNECTORS)].includes(step.id)) timer = setInterval(() => refreshStatus(el, steps, idx), 2500)
  }

  function bind() {
    el.querySelectorAll('[data-next]').forEach((b) => (b.onclick = () => go(idx + 1)))
    el.querySelectorAll('[data-back]').forEach((b) => (b.onclick = () => go(idx - 1)))
    el.querySelectorAll('[data-goto]').forEach((b) => (b.onclick = () => go(Number(b.dataset.goto))))
    el.querySelectorAll('[data-copy]').forEach((b) => (b.onclick = () => copy(el.querySelector(`#${b.dataset.copy}`).textContent, b)))
    el.querySelectorAll('[data-choice]').forEach((c) => (c.onchange = () => { s.selected[c.dataset.choice] = c.checked; c.closest('.choice').classList.toggle('on', c.checked); save(s) }))
    const demo = el.querySelector('[data-demo]'); if (demo) demo.onclick = () => { loadDemo(); finishUp() }
    const open = el.querySelector('[data-open]'); if (open) open.onclick = finishUp
    const manual = el.querySelector('[data-manual]'); if (manual) manual.onclick = () => { try { createManualCheckpoint(); finishUp() } catch (e) { alert(e.message) } }
    el.querySelector('[data-skip]')?.addEventListener('click', () => { s.done = true; save(s) })

    const flash = (form, text) => { const n = form.querySelector('[data-saved]'); if (n) { n.textContent = text; setTimeout(() => (n.textContent = ''), 2500) } }
    const submit = (name, fn) => { const f = el.querySelector(`[data-form="${name}"]`); if (f) f.onsubmit = (e) => { e.preventDefault(); try { fn(Object.fromEntries(new FormData(f)), f) } catch (err) { alert(err instanceof IngestError ? err.message : String(err)) } } }
    submit('btc', (d, f) => { setManualHolding({ qty: d.qty, value: d.value, invested_inr: d.invested || null }); flash(f, 'Saved ✓') })
    submit('fd', (d, f) => { saveFixedDeposit(d); draw() })
    submit('sw', (d) => { saveSplitwise(d.person, d.amount, d.note); draw() })
    submit('targets', (d, f) => { const t = {}; for (const [k, v] of Object.entries(d)) if (Number(v) > 0) t[k] = Number(v); setSetting('target_allocation', t); flash(f, 'Saved ✓') })
    el.querySelectorAll('[data-del-fd]').forEach((b) => (b.onclick = () => { deleteFixedDeposit(Number(b.dataset.delFd)); draw() }))
    el.querySelectorAll('[data-del-sw]').forEach((b) => (b.onclick = () => { deleteSplitwise(b.dataset.delSw); draw() }))
    const tf = el.querySelector('[data-form="targets"]')
    if (tf) { const upd = () => { tf.querySelector('[data-total]').textContent = [...tf.querySelectorAll('input')].reduce((a, i) => a + Number(i.value || 0), 0) }; tf.oninput = upd; upd() }

    const drop = el.querySelector('[data-drop]'), file = el.querySelector('[data-file]')
    if (drop) {
      const take = async (files) => {
        const out = []
        for (const f of files) { try { out.push(`${f.name}: ${JSON.stringify(summary(ingestAny(JSON.parse(await f.text()))))}`) } catch (e) { out.push(`${f.name}: ${e.message}`) } }
        alert(out.join('\n')); refreshStatus(el, steps, idx)
      }
      drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over') }
      drop.ondragleave = () => drop.classList.remove('over')
      drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); take(e.dataTransfer.files) }
      el.querySelector('[data-pick]').onclick = () => file.click()
      file.onchange = () => take(file.files)
    }
  }
  const summary = ({ kind, as_of_date, transactions, holdings, warnings }) => ({ kind, as_of_date, transactions, holdings, warnings })
  function finishUp() { clearInterval(timer); s.done = true; save(s); onDone() }

  draw()
  return () => clearInterval(timer)
}

export const needsOnboarding = () => !hasData() && !(getSetting('onboarding', {}) || {}).done

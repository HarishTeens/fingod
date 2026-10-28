import { connectorStatus, checkpoints, fixedDeposits, splitwise, targets, transactionCount } from '../repo.js'
import { exportBytes, importBytes, reset, getSetting } from '../db.js'
import { syncInbox, ingestAny, IngestError } from '../ingest.js'
import { checkpointPrompt } from '../prompts.js'
import { isDemo } from '../demo.js'
import { esc, shortDate, money, sleeveLabel } from './format.js'

async function copy(text, btn) {
  try { await navigator.clipboard.writeText(text) } catch { const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove() }
  const old = btn.textContent; btn.textContent = 'Copied ✓'; setTimeout(() => (btn.textContent = old), 1800)
}

export function render(el) {
  const draw = (log = '') => {
    const cps = checkpoints(), st = connectorStatus()
    el.innerHTML = `<div class="grid" style="gap:16px;max-width:860px">
    <section class="card"><header><h2>Take a checkpoint</h2></header>
      <p class="hero-secondary" style="margin-top:0">Paste this into your coding agent whenever you want fresh numbers. It reads each source you connected and drops files into <code>data/</code>; they import here automatically.</p>
      <div class="prompt"><pre id="p-cp">${esc(checkpointPrompt)}</pre><button class="btn primary" data-copy="p-cp">Copy prompt</button></div></section>

    <section class="card"><header><h2>What's here</h2><span class="spacer"></span><a class="btn" href="#/welcome">Re-run setup</a></header>
      <table class="data"><tbody>
        <tr><td class="name">Checkpoints</td><td class="num">${cps.length}${cps.length ? ` · latest ${shortDate(cps.at(-1).as_of_date)}` : ''}</td></tr>
        <tr><td class="name">Wallet transactions</td><td class="num">${transactionCount().toLocaleString('en-IN')}</td></tr>
        <tr><td class="name">Fixed deposits</td><td class="num">${fixedDeposits().length} <a class="btn" href="#/welcome?step=extras">edit</a></td></tr>
        <tr><td class="name">Splitwise people</td><td class="num">${splitwise().length} <a class="btn" href="#/welcome?step=extras">edit</a></td></tr>
        <tr><td class="name">Bitcoin (manual)</td><td class="num">${st.btc.ok ? 'set' : '—'} <a class="btn" href="#/welcome?step=btc">edit</a></td></tr>
        <tr><td class="name">Allocation targets</td><td class="num">${Object.entries(targets()).map(([k, v]) => `${esc(sleeveLabel(k))} ${v}%`).join(' · ')} <a class="btn" href="#/welcome?step=targets">edit</a></td></tr>
      </tbody></table></section>

    <section class="card"><header><h2>Import files</h2></header>
      <p class="hero-secondary" style="margin-top:0">Files in <code>data/</code> import by themselves while <code>serve.py</code> is running. You can also import by hand: a checkpoint or transactions JSON from your agent, or a backup you exported.</p>
      <div class="actions"><button class="btn" data-sync>Sync now</button><button class="btn" data-pick>Choose files…</button><input type="file" multiple accept=".json,.sqlite,.db" hidden data-file></div>
      <pre class="log" data-log>${esc(log)}</pre></section>

    <section class="card"><header><h2>Backup & reset</h2></header>
      <p class="hero-secondary" style="margin-top:0">Your database lives in this browser's storage. Clearing site data would erase it, so keep a backup.</p>
      <div class="actions"><button class="btn" data-export>Download backup (.sqlite)</button><button class="btn" data-restore>Restore backup…</button><input type="file" accept=".sqlite,.db" hidden data-restore-file>
      <button class="btn" data-reset style="margin-left:auto;color:var(--critical)">${isDemo() ? 'Clear demo data' : 'Erase everything'}</button></div></section></div>`
  }
  draw()
  const logTo = (t) => { const n = el.querySelector('[data-log]'); if (n) n.textContent = t }
  el.addEventListener('click', async (e) => {
    const c = e.target.closest('[data-copy]'); if (c) copy(el.querySelector(`#${c.dataset.copy}`).textContent, c)
    if (e.target.closest('[data-sync]')) {
      const r = await syncInbox()
      logTo(!r.available ? 'The app is not running under serve.py, so it cannot see data/. Start it with: python3 serve.py' : `${r.imported.length} file(s) imported, ${r.errors.length} error(s), ${r.total} in data/.\n${r.imported.map((i) => `✓ ${i.path}`).join('\n')}${r.errors.map((x) => `\n✗ ${x.path}: ${x.error}`).join('')}`)
    }
    if (e.target.closest('[data-pick]')) el.querySelector('[data-file]').click()
    if (e.target.closest('[data-export]')) {
      const url = URL.createObjectURL(new Blob([exportBytes()], { type: 'application/x-sqlite3' }))
      Object.assign(document.createElement('a'), { href: url, download: `fingod-backup-${new Date().toISOString().slice(0, 10)}.sqlite` }).click()
      URL.revokeObjectURL(url)
    }
    if (e.target.closest('[data-restore]')) el.querySelector('[data-restore-file]').click()
    if (e.target.closest('[data-reset]') && confirm(isDemo() ? 'Clear the demo data?' : 'Erase ALL fingod data in this browser? Export a backup first if unsure.')) { await reset(); location.hash = '#/welcome'; location.reload() }
  })
  el.addEventListener('change', async (e) => {
    if (e.target.matches('[data-file]')) {
      const out = []
      for (const f of e.target.files) { try { const r = ingestAny(JSON.parse(await f.text())); out.push(`✓ ${f.name}: ${r.kind}${r.as_of_date ? ` ${r.as_of_date}` : ''}${r.warnings && r.warnings.length ? `\n   warnings: ${r.warnings.join('; ')}` : ''}`) } catch (err) { out.push(`✗ ${f.name}: ${err instanceof IngestError ? err.message : err}`) } }
      logTo(out.join('\n'))
    }
    if (e.target.matches('[data-restore-file]') && e.target.files[0]) {
      if (!confirm('Replace everything in this browser with the backup?')) return
      try { await importBytes(new Uint8Array(await e.target.files[0].arrayBuffer())); location.hash = '#/dashboard'; location.reload() } catch (err) { alert(`Not a valid fingod backup: ${err.message}`) }
    }
  })
}

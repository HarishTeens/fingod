// fingod — boot, routing, shell. No framework, no build step: this file is the
// whole app's entry point, loaded as a native ES module.
import * as db from './db.js'
import { hasData, ppfRateDue } from './repo.js'
import { quarterLabel } from './compute/ppf.js'
import { syncInbox as importInbox, inboxFailures, setPpfRate, IngestError } from './ingest.js'
import { isDemo, loadDemo } from './demo.js'
import { esc } from './ui/format.js'

// Each page's code is fetched only when you visit it. A browser asks for every
// statically imported module at once, and a plain single-process dev server can
// drop some of a burst that size; loading lazily keeps the first load small.
const PAGES = [
  { id: 'dashboard', title: 'Dashboard', load: () => import('./ui/dashboard.js') },
  { id: 'investments', title: 'Investments', load: () => import('./ui/investments.js') },
  { id: 'realised', title: 'Realised', load: () => import('./ui/realised.js') },
  { id: 'expenses', title: 'Expenses', load: () => import('./ui/expenses.js') },
  { id: 'data', title: 'Data', load: () => import('./ui/data.js') },
]

const root = document.getElementById('root')
let cleanup = null, rerenderTimer = null, showSeq = 0

const needsWelcome = () => !hasData()

const theme = () => localStorage.getItem('fingod-theme') || 'light'
const applyTheme = () => document.documentElement.setAttribute('data-theme', theme())

function route() {
  return (location.hash.replace(/^#\/?/, '').split('?')[0]) || ''
}

async function show() {
  const seq = ++showSeq
  cleanup?.(); cleanup = null
  const r = route()
  if (r === 'welcome') return showWelcome(seq)
  if (!r && needsWelcome()) { location.hash = '#/welcome'; return }
  const entry = PAGES.find((p) => p.id === r) || PAGES[0]
  if (!hasData() && entry.id !== 'data') { location.hash = '#/welcome'; return }
  const page = await entry.load()
  if (seq !== showSeq) return // a newer navigation took over while this page's code was loading
  const y = window.scrollY
  root.innerHTML = `<div class="app">
    <header class="topbar"><h1>fingod</h1>
      <nav class="tabs">${PAGES.map((p) => `<a class="tab" href="#/${p.id}" ${p.id === entry.id ? 'aria-current="page"' : ''}>${p.title}</a>`).join('')}</nav>
      <span class="spacer"></span><span class="sub" id="syncstate"></span>
      <button class="btn" id="theme" title="Switch theme">${theme() === 'dark' ? 'Light' : 'Dark'}</button></header>
    ${isDemo() ? '<div class="banner">You are looking at <b>demo data</b> — every name and number is invented. <a href="#/data">Clear it</a> and connect your own from <a href="#/welcome">setup</a>.</div>' : ''}
    ${ppfBanner()}
    <main id="page"></main></div>`
  document.getElementById('theme').onclick = () => { localStorage.setItem('fingod-theme', theme() === 'dark' ? 'light' : 'dark'); applyTheme(); show() }
  try { page.render(document.getElementById('page')) } catch (e) { fatal(e) }
  bindPpfBanner()
  window.scrollTo(0, y)
}

// The PPF rate changes by government notification each quarter and nothing can read it
// for you, so when a quarter starts without one, ask once: dismissing hides it until the
// next quarter, and the Data page can set it any time.
function ppfBanner() {
  if (isDemo()) return ''
  const due = ppfRateDue()
  if (!due) return ''
  return `<div class="banner" data-ppf-banner><form class="ppf-rate">
    <span>New quarter: <b>${esc(quarterLabel(due.quarter_start))}</b>. What PPF interest rate did the government set for it?</span>
    <label><input name="rate" type="number" step="0.01" min="0" max="20" required value="${due.last_rate ?? ''}" aria-label="PPF rate for the quarter"> %</label>
    <button class="btn primary" type="submit">Save</button><button class="btn" type="button" data-ppf-dismiss title="Hide until next quarter">Dismiss</button>
    ${due.last_rate !== null ? `<span class="muted">Filled in with last quarter's ${esc(due.last_rate)}%; change it if it moved.</span>` : ''}</form></div>`
}
function bindPpfBanner() {
  const el = document.querySelector('[data-ppf-banner]')
  if (!el) return
  const qs = ppfRateDue().quarter_start
  el.querySelector('form').onsubmit = (e) => {
    e.preventDefault()
    try { setPpfRate(qs, e.target.rate.value) } catch (err) { alert(err instanceof IngestError ? err.message : String(err)) }
  }
  el.querySelector('[data-ppf-dismiss]').onclick = () => db.setSetting('ppf_rate_dismissed', qs)
}

async function showWelcome(seq) {
  const welcome = await import('./ui/welcome.js')
  if (seq !== showSeq) return
  root.innerHTML = '<div class="app wide"><header class="topbar"><h1>fingod</h1><span class="spacer"></span><button class="btn" id="theme">' + (theme() === 'dark' ? 'Light' : 'Dark') + '</button></header><div id="welcome"></div></div>'
  document.getElementById('theme').onclick = () => { localStorage.setItem('fingod-theme', theme() === 'dark' ? 'light' : 'dark'); applyTheme(); show() }
  cleanup = welcome.render(document.getElementById('welcome'), { onData: () => { location.hash = '#/dashboard' } })
}

function fatal(e) {
  console.error(e)
  document.getElementById('page').innerHTML = `<div class="empty"><b>Something broke while drawing this page.</b><br><code>${esc(e.message)}</code><br><br>Your data is safe in this browser. Try another tab, or export a backup from Data.</div>`
  window.__fingodErrors = (window.__fingodErrors || []).concat(String(e.stack || e))
}

// Demo data is invented and must never be mixed with real files, so while it is loaded
// nothing is imported from data/. Clearing the demo (Data page) resets and imports them.
const syncInbox = () => (isDemo() ? Promise.resolve({ available: true, imported: [], errors: [] }) : importInbox())

// Pick up whatever the agent dropped into data/ — quietly, every few seconds.
async function poll() {
  try {
    const r = await syncInbox()
    const el = document.getElementById('syncstate')
    const bad = inboxFailures()
    if (el) {
      const state = isDemo() ? null : bad.length ? ['bad', 'Sync issue', bad.map((b) => `${b.path}: ${b.error}`).join('\n')]
        : r.available ? ['ok', 'Synced', `Last checked ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`]
        : ['off', 'Not synced', 'Not reading data/. Start the app with python3 serve.py to import files.']
      // Redrawing every poll would reset a tooltip the pointer is resting on, so only a change of state rebuilds it.
      const key = state ? `${state[0]}${state[1]}` : ''
      if (el.dataset.key !== key) { el.dataset.key = key; el.innerHTML = state ? `<a class="chip sync ${state[0]}" href="#/data"><i class="dot"></i>${esc(state[1])}</a>` : '' }
      if (state) el.firstElementChild.title = state[2]
    }
    if (r.imported.length && route() !== 'welcome') show()
  } catch (e) { console.error(e) }
}

async function boot() {
  applyTheme()
  sessionStorage.removeItem('fingodRetry') // we got this far: a simple server that reset a module request is no longer in play
  window.addEventListener('error', (e) => { window.__fingodErrors = (window.__fingodErrors || []).concat(e.message) })
  window.addEventListener('unhandledrejection', (e) => { window.__fingodErrors = (window.__fingodErrors || []).concat(String(e.reason)) })
  try {
    await db.open()
  } catch (e) {
    root.innerHTML = `<div class="app"><div class="empty"><b>Couldn't start the in-browser database.</b><br><code>${esc(e.message)}</code><br><br>Open fingod over http (<code>python3 serve.py</code>) rather than as a file, so the WebAssembly can load.</div></div>`
    return
  }
  if (new URLSearchParams(location.search).has('demo') && !hasData()) { loadDemo(); history.replaceState(null, '', location.pathname + (location.hash && location.hash !== '#/welcome' ? location.hash : '#/dashboard')) }
  db.onChange(() => { // writes arrive in bursts; redraw once they settle
    clearTimeout(rerenderTimer)
    rerenderTimer = setTimeout(() => { if (route() !== 'welcome') show() }, 80)
  })
  window.addEventListener('hashchange', show)
  try { await syncInbox() } catch (e) { console.error(e) } // import what is already in data/ BEFORE routing, so existing files land on the dashboard
  show()
  poll()
  setInterval(poll, 4000)
}
boot()

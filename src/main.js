// fingod — boot, routing, shell. No framework, no build step: this file is the
// whole app's entry point, loaded as a native ES module.
import * as db from './db.js'
import { hasData } from './repo.js'
import { syncInbox } from './ingest.js'
import { isDemo, loadDemo } from './demo.js'
import * as dashboard from './ui/dashboard.js'
import * as investments from './ui/investments.js'
import * as realised from './ui/realised.js'
import * as expenses from './ui/expenses.js'
import * as data from './ui/data.js'
import * as onboarding from './ui/onboarding.js'
import { esc } from './ui/format.js'

const PAGES = [
  { id: 'dashboard', title: 'Dashboard', page: dashboard },
  { id: 'investments', title: 'Investments', page: investments },
  { id: 'realised', title: 'Realised', page: realised },
  { id: 'expenses', title: 'Expenses', page: expenses },
  { id: 'data', title: 'Data', page: data },
]

const root = document.getElementById('root')
let cleanup = null, rerenderTimer = null

const theme = () => localStorage.getItem('fingod-theme') || 'dark'
const applyTheme = () => document.documentElement.setAttribute('data-theme', theme())

function route() {
  return (location.hash.replace(/^#\/?/, '').split('?')[0]) || ''
}

function show() {
  cleanup?.(); cleanup = null
  const r = route()
  if (r === 'welcome') return showOnboarding()
  if (!r && onboarding.needsOnboarding()) { location.hash = '#/welcome'; return }
  const entry = PAGES.find((p) => p.id === r) || PAGES[0]
  if (!hasData() && entry.id !== 'data') { location.hash = '#/welcome'; return }
  const y = window.scrollY
  root.innerHTML = `<div class="app">
    <header class="topbar"><h1>fingod</h1>
      <nav class="tabs">${PAGES.map((p) => `<a class="tab" href="#/${p.id}" ${p.id === entry.id ? 'aria-current="page"' : ''}>${p.title}</a>`).join('')}</nav>
      <span class="spacer"></span><span class="sub" id="syncstate"></span>
      <button class="btn" id="theme" title="Switch theme">${theme() === 'dark' ? 'Light' : 'Dark'}</button></header>
    ${isDemo() ? '<div class="banner">You are looking at <b>demo data</b> — every name and number is invented. <a href="#/data">Clear it</a> and connect your own from <a href="#/welcome">setup</a>.</div>' : ''}
    <main id="page"></main></div>`
  document.getElementById('theme').onclick = () => { localStorage.setItem('fingod-theme', theme() === 'dark' ? 'light' : 'dark'); applyTheme(); show() }
  try { entry.page.render(document.getElementById('page')) } catch (e) { fatal(e) }
  window.scrollTo(0, y)
}

function showOnboarding() {
  const step = new URLSearchParams(location.hash.split('?')[1] || '').get('step')
  if (step) { const o = db.getSetting('onboarding', {}) || {}; db.setSetting('onboarding', { ...o, step: -1, goto: step }) }
  root.innerHTML = '<div class="app wide"><header class="topbar"><h1>fingod</h1><span class="spacer"></span><button class="btn" id="theme">' + (theme() === 'dark' ? 'Light' : 'Dark') + '</button></header><div id="onboard"></div></div>'
  document.getElementById('theme').onclick = () => { localStorage.setItem('fingod-theme', theme() === 'dark' ? 'light' : 'dark'); applyTheme(); showOnboarding() }
  cleanup = onboarding.render(document.getElementById('onboard'), { onDone: () => { location.hash = '#/dashboard' } })
}

function fatal(e) {
  console.error(e)
  document.getElementById('page').innerHTML = `<div class="empty"><b>Something broke while drawing this page.</b><br><code>${esc(e.message)}</code><br><br>Your data is safe in this browser. Try another tab, or export a backup from Data.</div>`
  window.__fingodErrors = (window.__fingodErrors || []).concat(String(e.stack || e))
}

// Pick up whatever the agent dropped into data/ — quietly, every few seconds.
async function poll() {
  try {
    const r = await syncInbox()
    const el = document.getElementById('syncstate')
    if (el) el.textContent = r.available ? 'watching data/' : 'open via serve.py to auto-import'
    if (r.imported.length && route() !== 'welcome') show()
  } catch (e) { console.error(e) }
}

async function boot() {
  applyTheme()
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
  show()
  await poll()
  setInterval(poll, 4000)
}
boot()

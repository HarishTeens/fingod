#!/usr/bin/env node
// Drive headless Chrome over the DevTools protocol: load a page, run optional
// steps, wait for it to settle, and save a screenshot. No dependencies — it needs
// Node 22+ (for the built-in WebSocket) and Google Chrome.
//
//   node scripts/screenshot.mjs <url> <out.png> [--width 1200] [--height 900] [--scale 2]
//        [--wait "js expression that becomes truthy"] [--eval "js to run first"] [--full]
//        [--theme light|dark]
//
// Console errors and uncaught exceptions are printed, so it doubles as a smoke test.
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const [url, out] = args
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i > -1 ? args[i + 1] : d }
if (!url || !out) { console.error('usage: screenshot.mjs <url> <out.png> [--width N --height N --scale N --wait EXPR --eval JS --full --theme dark|light]'); process.exit(2) }
const width = +opt('width', 1200), height = +opt('height', 900), scale = +opt('scale', 1)
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const port = 9300 + Math.floor(Math.random() * 500)

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'fingod-chrome-'))}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const die = (code) => { chrome.kill(); process.exit(code) }

async function target() {
  for (let i = 0; i < 60; i++) {
    try { const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); const t = list.find((x) => x.type === 'page'); if (t) return t } catch {}
    await sleep(150)
  }
  throw new Error('Chrome did not start')
}

const t = await target()
const ws = new WebSocket(t.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let id = 0; const pending = new Map(); const problems = []
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return }
  if (msg.method === 'Runtime.exceptionThrown') problems.push(`exception: ${msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text}`)
  if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'assert'].includes(msg.params.type)) problems.push(`console.${msg.params.type}: ${msg.params.args.map((a) => a.value ?? a.description).join(' ')}`)
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') problems.push(`log: ${msg.params.entry.text} ${msg.params.entry.url || ''}`)
}
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value

await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable')
await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false })
if (opt('theme')) await send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('fingod-theme', '${opt('theme')}')` })
await send('Page.navigate', { url })
await sleep(600)
const evalJs = opt('eval'); if (evalJs) { await sleep(800); await evaluate(evalJs) }
const wait = opt('wait')
if (wait) {
  let ok = false
  for (let i = 0; i < 100 && !ok; i++) { ok = await evaluate(`!!(${wait})`); if (!ok) await sleep(150) }
  if (!ok) problems.push(`timed out waiting for: ${wait}`)
}
await sleep(700)
let clip
if (args.includes('--full')) {
  const m = (await send('Page.getLayoutMetrics')).result
  const h = Math.ceil(m.cssContentSize.height)
  await send('Emulation.setDeviceMetricsOverride', { width, height: h, deviceScaleFactor: scale, mobile: false }); await sleep(300)
}
const shot = (await send('Page.captureScreenshot', { format: 'png' })).result.data
writeFileSync(out, Buffer.from(shot, 'base64'))
const errs = await evaluate('JSON.stringify(window.__fingodErrors || [])')
for (const p of [...problems, ...JSON.parse(errs || '[]')]) console.error('!', p)
console.log(`saved ${out}${problems.length ? ` (${problems.length} problem${problems.length > 1 ? 's' : ''})` : ''}`)
die(problems.length ? 1 : 0)

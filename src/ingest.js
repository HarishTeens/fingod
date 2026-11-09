// Getting data in. Two kinds of file arrive from your coding agent (see
// docs/DATA-FORMAT.md): checkpoints and Wallet transactions. Both are
// idempotent — re-importing a file never duplicates anything.
import { all, first, scalar, write, setSetting } from './db.js'
import { money } from './compute/num.js'
import { BENCHMARKS } from './compute/benchmark.js'

export const SLEEVES = ['in_equity', 'in_mf', 'us_equity', 'gold', 'debt', 'btc']
export const BALANCE_KINDS = ['cash', 'credit_card', 'epf']
export const ASSET_KINDS = ['nps', 'ppf', 'property', 'gold_physical', 'vehicle', 'other']
export const LIABILITY_KINDS = ['home_loan', 'car_loan', 'personal_loan', 'education_loan', 'other']
const DATE = /^\d{4}-\d{2}-\d{2}$/
const isNum = (v) => v !== null && v !== '' && Number.isFinite(Number(v))
const nullable = (v) => (v === undefined || v === null || v === '' ? null : Number(v))

export class IngestError extends Error {}
const fail = (msg) => { throw new IngestError(msg) }

/** Check a checkpoint payload and say exactly what is wrong. */
export function validateCheckpoint(p) {
  if (!p || typeof p !== 'object') fail('not a checkpoint: expected a JSON object')
  if (!DATE.test(p.as_of_date || '')) fail(`as_of_date must be YYYY-MM-DD, got ${JSON.stringify(p.as_of_date)}`)
  if (!Array.isArray(p.holdings)) fail('holdings must be an array')
  // Collect every problem in the file, so fixing one doesn't just reveal the next on a second round trip.
  const problems = []
  const bad = (m) => problems.push(m)
  const seen = new Set()
  p.holdings.forEach((h, i) => {
    const at = `holdings[${i}]${h && h.symbol ? ` (${h.symbol})` : ''}`
    if (!h || !SLEEVES.includes(h.sleeve)) return bad(`${at}: sleeve must be one of ${SLEEVES.join(', ')}`)
    if (!h.symbol) return bad(`${at}: symbol is required`)
    if (!isNum(h.qty)) bad(`${at}: qty is required and must be a number`)
    if (!isNum(h.price)) bad(`${at}: price is required and must be a number`)
    if (h.currency && h.currency !== 'INR' && !isNum(h.fx_rate) && !isNum(p.usd_inr)) bad(`${at}: a ${h.currency} holding needs fx_rate or a checkpoint usd_inr`)
    const key = `${h.sleeve}\0${h.symbol}`
    if (seen.has(key)) bad(`${at}: duplicate ${h.sleeve}/${h.symbol} in one checkpoint`)
    seen.add(key)
  })
  const refs = new Set()
  ;(p.balances || []).forEach((b, i) => {
    if (b && b.kind === 'splitwise') { // normally snapshotted from the standing rows; stored as given if a file carries them (history exports)
      if (!b.ref || !isNum(b.amount_inr)) bad(`balances[${i}]: a splitwise entry needs ref and amount_inr`)
      return
    }
    if (!b || !BALANCE_KINDS.includes(b.kind)) return bad(`balances[${i}]: kind must be one of ${BALANCE_KINDS.join(', ')}`)
    if (!b.ref) return bad(`balances[${i}]: ref is required`)
    if (!isNum(b.amount_inr)) bad(`balances[${i}] (${b.ref}): amount_inr must be a number`)
    if (b.kind === 'credit_card' && Number(b.amount_inr) < 0) bad(`balances[${i}] (${b.ref}): credit_card is stored positive = outstanding; Wallet reports it negative, so flip the sign`)
    const key = `${b.kind}\0${b.ref}`
    if (refs.has(key)) bad(`balances[${i}]: duplicate ${b.kind}/${b.ref}`)
    refs.add(key)
  })
  for (const [k, v] of Object.entries(p.benchmarks || {})) {
    if (!BENCHMARKS[k]) bad(`benchmarks.${k}: unknown benchmark, expected ${Object.keys(BENCHMARKS).join(' or ')}`)
    else if (!isNum(v) || Number(v) <= 0) bad(`benchmarks.${k}: must be a positive number`)
  }
  if (problems.length) fail(problems.length > 6 ? `${problems.slice(0, 6).join('; ')}; and ${problems.length - 6} more` : problems.join('; '))
}

/** Store one checkpoint, replacing any other on the same date. Returns warnings. */
export function ingestCheckpoint(p) {
  validateCheckpoint(p)
  const warnings = []
  const usd = nullable(p.usd_inr)
  const existed = !!first('SELECT id FROM checkpoints WHERE as_of_date = ?', [p.as_of_date])

  write((run) => {
    run('DELETE FROM checkpoints WHERE as_of_date = ?', [p.as_of_date])
    run('INSERT INTO checkpoints (as_of_date, usd_inr, sources, benchmarks, created_at) VALUES (?, ?, ?, ?, ?)',
      [p.as_of_date, usd, JSON.stringify(p.sources || {}), JSON.stringify(p.benchmarks || {}), new Date().toISOString()])
    const id = scalar('SELECT id FROM checkpoints WHERE as_of_date = ?', [p.as_of_date])

    const hasBtc = p.holdings.some((h) => h.sleeve === 'btc')
    const holdings = [...p.holdings]
    if (!hasBtc) { // carry the latest hand-entered position forward
      const m = first('SELECT * FROM manual_holdings WHERE as_of_date <= ? ORDER BY as_of_date DESC LIMIT 1', [p.as_of_date])
      if (m) holdings.push({ sleeve: m.sleeve, symbol: m.symbol, name: m.name, qty: m.qty, price: m.price, avg_cost: m.avg_cost, invested_inr: m.invested_inr, currency: 'INR', fx_rate: 1 })
    }
    for (const h of holdings) {
      const currency = h.currency || 'INR'
      const fx = currency === 'INR' ? 1 : isNum(h.fx_rate) ? Number(h.fx_rate) : usd
      const value = money(Number(h.qty) * Number(h.price) * fx)
      if (isNum(h.value_inr) && Math.abs(Number(h.value_inr) - value) > 1) warnings.push(`${h.symbol}: source says ₹${h.value_inr}, qty × price × fx is ₹${value} — check the mapping`)
      run(`INSERT INTO holdings (checkpoint_id, sleeve, symbol, name, isin, qty, price, fx_rate, currency, value_inr, avg_cost, invested_inr)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, h.sleeve, h.symbol, h.name || h.symbol, h.isin || null, Number(h.qty), Number(h.price), fx, currency, value, nullable(h.avg_cost), nullable(h.invested_inr)])
    }
    const carried = (p.balances || []).filter((b) => b.kind === 'splitwise')
    for (const b of p.balances || []) {
      run('INSERT INTO balances (checkpoint_id, kind, ref, amount_inr, meta) VALUES (?,?,?,?,?)', [id, b.kind, b.ref, Number(b.amount_inr), b.meta ? JSON.stringify(b.meta) : null])
    }
    // Splitwise is a standing row, snapshotted so history keeps what was true then.
    // A file that carries its own splitwise entries (a history export) wins.
    if (!carried.length) for (const s of all('SELECT person, amount_inr, note FROM splitwise_balances')) {
      run('INSERT INTO balances (checkpoint_id, kind, ref, amount_inr, meta) VALUES (?,?,?,?,?)', [id, 'splitwise', s.person, s.amount_inr, JSON.stringify({ note: s.note || '' })])
    }
    for (const a of p.wallet_accounts || []) {
      if (!a.id) continue
      run(`INSERT INTO wallet_accounts (id, name, account_type, currency, last_seen_at) VALUES (?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, account_type = excluded.account_type, currency = excluded.currency, last_seen_at = excluded.last_seen_at`,
        [a.id, a.name || a.id, a.account_type || null, a.currency || 'INR', new Date().toISOString()])
    }
  })
  return { as_of_date: p.as_of_date, replaced: existed, holdings: p.holdings.length, warnings }
}

/** Upsert Wallet transactions (idempotent on Wallet's own record id). */
export function ingestTransactions(payload) {
  const list = Array.isArray(payload) ? payload : payload && payload.transactions
  if (!Array.isArray(list)) fail('expected {"transactions": [...]}')
  list.forEach((t, i) => {
    if (!t || !t.id) fail(`transactions[${i}]: id is required`)
    if (!DATE.test(t.txn_date || '')) fail(`transactions[${i}]: txn_date must be YYYY-MM-DD`)
    if (!isNum(t.amount_inr)) fail(`transactions[${i}]: amount_inr must be a number`)
  })
  write((run) => {
    for (const t of list) {
      run(`INSERT INTO transactions (id, txn_date, amount_inr, currency, account, note, category_id, category, category_top, is_transfer)
           VALUES (?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET txn_date=excluded.txn_date, amount_inr=excluded.amount_inr, currency=excluded.currency, account=excluded.account,
             note=excluded.note, category_id=excluded.category_id, category=excluded.category, category_top=excluded.category_top, is_transfer=excluded.is_transfer`,
        [t.id, t.txn_date, Number(t.amount_inr), t.currency || 'INR', t.account || null, t.note || null, t.category_id || null, t.category || null, t.category_top || null, t.is_transfer ? 1 : 0])
      run('DELETE FROM transaction_labels WHERE transaction_id = ?', [t.id])
      for (const l of new Set(t.labels || [])) run('INSERT INTO transaction_labels (transaction_id, label) VALUES (?, ?)', [t.id, l])
    }
  })
  return { transactions: list.length }
}

/** Upsert trade-ledger rows (idempotent on the broker's trade id, else on the row's own content). */
export function ingestLedger(payload) {
  const list = payload && payload.ledger
  if (!Array.isArray(list)) fail('expected {"ledger": [...]}')
  const problems = []
  list.forEach((t, i) => {
    const at = `ledger[${i}]${t && t.symbol ? ` (${t.symbol})` : ''}`
    if (!t || !SLEEVES.includes(t.sleeve)) return problems.push(`${at}: sleeve must be one of ${SLEEVES.join(', ')}`)
    if (!t.symbol) problems.push(`${at}: symbol is required`)
    if (!DATE.test(t.trade_date || '')) problems.push(`${at}: trade_date must be YYYY-MM-DD`)
    if (!['buy', 'sell'].includes(t.side)) problems.push(`${at}: side must be buy or sell`)
    if (!isNum(t.qty) || Number(t.qty) <= 0) problems.push(`${at}: qty must be a positive number`)
    if (!isNum(t.price) || Number(t.price) < 0) problems.push(`${at}: price must be a number`)
    if (t.currency && t.currency !== 'INR' && !isNum(t.fx_rate)) problems.push(`${at}: a ${t.currency} trade needs fx_rate`)
  })
  if (problems.length) fail(problems.length > 6 ? `${problems.slice(0, 6).join('; ')}; and ${problems.length - 6} more` : problems.join('; '))
  write((run) => {
    for (const t of list) {
      const id = t.id || [t.sleeve, t.isin || t.symbol, t.trade_date, t.side, Number(t.qty), Number(t.price)].join('|')
      run(`INSERT INTO ledger (id, sleeve, symbol, isin, name, trade_date, side, qty, price, fx_rate, currency, fees_inr, source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET sleeve=excluded.sleeve, symbol=excluded.symbol, isin=excluded.isin, name=excluded.name, trade_date=excluded.trade_date, side=excluded.side,
             qty=excluded.qty, price=excluded.price, fx_rate=excluded.fx_rate, currency=excluded.currency, fees_inr=excluded.fees_inr, source=excluded.source`,
        [String(id), t.sleeve, t.symbol, t.isin || null, t.name || t.symbol, t.trade_date, t.side, Number(t.qty), Number(t.price), t.currency && t.currency !== 'INR' ? Number(t.fx_rate) : 1, t.currency || 'INR', nullable(t.fees_inr) ?? 0, t.source || null])
    }
  })
  return { ledger: list.length }
}

/** Benchmark history in one file: {"benchmarks": {"nifty50": [{"date", "level"}, ...], "sp500": [...]}}.
 * Idempotent on (benchmark, date), so a longer file later simply adds the new days. */
export function ingestBenchmarks(payload) {
  const b = payload && payload.benchmarks
  if (!b || typeof b !== 'object' || Array.isArray(b)) fail('expected {"benchmarks": {"nifty50": [{"date", "level"}, ...]}}')
  const problems = []
  let n = 0
  for (const [k, list] of Object.entries(b)) {
    if (!BENCHMARKS[k]) { problems.push(`benchmarks.${k}: unknown benchmark, expected ${Object.keys(BENCHMARKS).join(' or ')}`); continue }
    if (!Array.isArray(list)) { problems.push(`benchmarks.${k}: expected a list of {date, level}`); continue }
    list.forEach((p, i) => {
      if (!p || !DATE.test(p.date || '')) problems.push(`benchmarks.${k}[${i}]: date must be YYYY-MM-DD`)
      else if (!isNum(p.level) || Number(p.level) <= 0) problems.push(`benchmarks.${k}[${i}] (${p.date}): level must be a positive number`)
    })
  }
  if (problems.length) fail(problems.length > 6 ? `${problems.slice(0, 6).join('; ')}; and ${problems.length - 6} more` : problems.join('; '))
  write((run) => {
    for (const [k, list] of Object.entries(b)) for (const p of list) {
      run('INSERT INTO benchmark_levels (key, as_of_date, level) VALUES (?,?,?) ON CONFLICT(key, as_of_date) DO UPDATE SET level = excluded.level', [k, p.date, Number(p.level)])
      n++
    }
  })
  return { benchmark_days: n }
}

/** The runway setting in data/config.json: the labels you treat as your ongoing cost of living. */
export function validateRunway(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) fail('runway must be an object like {"labels": ["Personal", "House"]}')
  if (!Array.isArray(r.labels) || !r.labels.length || r.labels.length > 20 || r.labels.some((l) => typeof l !== 'string' || !l.trim())) fail('runway.labels must be a list of 1 to 20 label names')
  if (r.months !== undefined && !(Number.isInteger(r.months) && r.months >= 1 && r.months <= 12)) fail('runway.months must be a whole number from 1 to 12')
  return { labels: [...new Set(r.labels.map((l) => l.trim()))], ...(r.months ? { months: r.months } : {}) }
}

/** data/config.json is mostly for the agent (account roles, excluded holdings). The app reads only
 * `runway` from it, and a file without one clears the setting, so removing the key puts runway
 * back on all spending. */
function ingestConfig(p) {
  if (p.runway === undefined) { write((run) => run("DELETE FROM settings WHERE key = 'runway'")); return { runway: false } }
  const r = validateRunway(p.runway)
  setSetting('runway', r)
  return { runway: true, runway_labels: r.labels.length }
}

/** A file's kind, from its contents. */
export function classify(payload) {
  if (payload && Array.isArray(payload.holdings) && payload.as_of_date) return 'checkpoint'
  if (payload && !Array.isArray(payload) && Array.isArray(payload.ledger)) return 'ledger'
  if (payload && !Array.isArray(payload) && !payload.as_of_date && payload.benchmarks && typeof payload.benchmarks === 'object' && Object.values(payload.benchmarks).every(Array.isArray)) return 'benchmarks'
  if (payload && !Array.isArray(payload) && ['fixed_deposits', 'ppf', 'splitwise', 'trades', 'target_allocation', 'assets', 'liabilities'].some((k) => k in payload)) return 'standing'
  if (payload && !Array.isArray(payload) && !payload.as_of_date && ['runway', 'wallet_account_roles', 'exclude_holdings'].some((k) => k in payload)) return 'config'
  if (payload && (Array.isArray(payload.transactions) || Array.isArray(payload))) return 'transactions'
  return null
}

export function ingestAny(payload) {
  const kind = classify(payload)
  if (kind === 'config') return { kind, ...ingestConfig(payload) }
  if (kind === 'checkpoint') return { kind, ...ingestCheckpoint(payload) }
  if (kind === 'transactions') return { kind, ...ingestTransactions(payload) }
  if (kind === 'ledger') return { kind, ...ingestLedger(payload) }
  if (kind === 'benchmarks') return { kind, ...ingestBenchmarks(payload) }
  if (kind === 'standing') return { kind, ...ingestStanding(payload) }
  fail('not a fingod file: expected a checkpoint ({as_of_date, holdings}), {transactions}, {ledger}, {benchmarks}, standing rows or a config')
}

/** Pull in everything the agent has dropped into data/. Needs serve.py (or any
 * server exposing /data/manifest.json). Returns what changed. */
const INBOX_DIRS = ['checkpoints', 'standing', 'transactions', 'ledger', 'benchmarks']

/** serve.py lists data/ at /data/manifest.json. Any plain static server (python3 -m
 * http.server, which runs nothing from this repo) lists directories as HTML
 * instead, so fall back to reading those, with HEAD for each file's size and mtime. */
const failures = new Map() // path -> message, for files that arrived but could not be imported
/** Files that failed to import on the latest sync, so the UI can say so. */
export const inboxFailures = () => [...failures].map(([path, error]) => ({ path, error }))

let hasManifest = true // once /data/manifest.json 404s, stop asking: it only exists under serve.py
async function listInbox() {
  if (hasManifest) {
    try {
      const res = await fetch('data/manifest.json', { cache: 'no-store' })
      if (res.ok) { const m = await res.json(); if (Array.isArray(m.files)) return { available: true, files: m.files } }
      hasManifest = false
    } catch { /* fall through to directory listings */ }
  }
  let reachable = false
  const files = []
  for (const dir of INBOX_DIRS) {
    let res
    try { res = await fetch(`data/${dir}/`, { cache: 'no-store' }) } catch { continue }
    if (!res.ok) continue
    reachable = true
    const names = [...(await res.text()).matchAll(/href="([^"?#]+\.json)"/g)].map((m) => decodeURIComponent(m[1]).split('/').pop())
    for (const n of new Set(names)) {
      const head = await fetch(`data/${dir}/${n}`, { method: 'HEAD', cache: 'no-store' }).catch(() => null)
      if (head && head.ok) files.push({ path: `${dir}/${n}`, size: head.headers.get('content-length') || '0', mtime: head.headers.get('last-modified') || '0' })
    }
  }
  const cfg = await fetch('data/config.json', { method: 'HEAD', cache: 'no-store' }).catch(() => null)
  if (cfg && cfg.ok) { reachable = true; files.push({ path: 'config.json', size: cfg.headers.get('content-length') || '0', mtime: cfg.headers.get('last-modified') || '0' }) }
  if (!reachable) { // no subfolders yet: is there a server at all?
    try { reachable = (await fetch('data/README.md', { cache: 'no-store' })).ok } catch { reachable = false }
  }
  return { available: reachable, files }
}

export async function syncInbox() {
  const { available, files: listed } = await listInbox()
  if (!available) return { available: false, imported: [], errors: [] }

  const imported = [], errors = []
  const files = listed.filter((f) => f.path.endsWith('.json') && (f.path === 'config.json' || /^(checkpoints|standing|transactions|ledger|benchmarks)\//.test(f.path))).sort((a, b) => a.path.localeCompare(b.path))
  for (const f of files) {
    const fingerprint = `${f.size}:${f.mtime}`
    const seen = first('SELECT fingerprint FROM imported_files WHERE path = ?', [f.path])
    if (seen && seen.fingerprint === fingerprint) continue
    try {
      const res = await fetch(`data/${f.path}`, { cache: 'no-store' })
      const result = ingestAny(await res.json())
      write((run) => run('INSERT INTO imported_files (path, fingerprint, imported_at) VALUES (?,?,?) ON CONFLICT(path) DO UPDATE SET fingerprint = excluded.fingerprint, imported_at = excluded.imported_at', [f.path, fingerprint, new Date().toISOString()]))
      failures.delete(f.path)
      imported.push({ path: f.path, ...result })
    } catch (e) { failures.set(f.path, e.message); errors.push({ path: f.path, error: e.message }) }
  }
  for (const p of [...failures.keys()]) if (!files.some((f) => f.path === p)) failures.delete(p) // the file was removed
  return { available: true, imported, errors, total: files.length }
}

// --- hand-entered figures -------------------------------------------------------
/** Record a hand-entered position (Bitcoin). It is carried into later
 * checkpoints, and replaces that position in the latest one if there is one. */
export function setManualHolding({ sleeve = 'btc', symbol = 'BTC', name = 'Bitcoin', qty, value, avg_cost, invested_inr, date }) {
  if (!isNum(qty) || Number(qty) <= 0) fail('quantity must be a positive number')
  if (!isNum(value) || Number(value) <= 0) fail('current value must be a positive number')
  const d = date || new Date().toISOString().slice(0, 10)
  const price = Number(value) / Number(qty)
  write((run) => {
    run(`INSERT INTO manual_holdings (as_of_date, sleeve, symbol, name, qty, price, avg_cost, invested_inr) VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(as_of_date, symbol) DO UPDATE SET qty=excluded.qty, price=excluded.price, avg_cost=excluded.avg_cost, invested_inr=excluded.invested_inr, name=excluded.name`,
      [d, sleeve, symbol, name, Number(qty), price, nullable(avg_cost), nullable(invested_inr)])
    const latest = first('SELECT id FROM checkpoints ORDER BY as_of_date DESC LIMIT 1')
    if (latest) {
      run('DELETE FROM holdings WHERE checkpoint_id = ? AND symbol = ?', [latest.id, symbol])
      run(`INSERT INTO holdings (checkpoint_id, sleeve, symbol, name, qty, price, fx_rate, currency, value_inr, avg_cost, invested_inr) VALUES (?,?,?,?,?,?,1,'INR',?,?,?)`,
        [latest.id, sleeve, symbol, name, Number(qty), price, money(Number(value)), nullable(avg_cost), nullable(invested_inr)])
    }
  })
}

/** If nothing has been imported yet, snapshot the hand-entered figures as a first checkpoint. */
export function createManualCheckpoint(date = new Date().toISOString().slice(0, 10)) {
  const m = all('SELECT * FROM manual_holdings WHERE as_of_date <= ? ORDER BY as_of_date DESC', [date])
  const latest = m.length ? m.filter((r) => r.symbol === m[0].symbol)[0] : null
  const holdings = latest ? [{ sleeve: latest.sleeve, symbol: latest.symbol, name: latest.name, qty: latest.qty, price: latest.price, avg_cost: latest.avg_cost, invested_inr: latest.invested_inr, currency: 'INR', fx_rate: 1 }] : []
  return ingestCheckpoint({ as_of_date: date, sources: { manual: 'ok' }, holdings, balances: [] })
}

// --- standing rows ----------------------------------------------------------------
export function saveFixedDeposit(fd) {
  for (const k of ['bank', 'principal', 'rate_pct', 'start_date']) if (!fd[k]) fail(`${k} is required`)
  if (!(Number(fd.principal) > 0)) fail('principal must be positive')
  if (!DATE.test(fd.start_date)) fail('start_date must be YYYY-MM-DD')
  write((run) => {
    if (fd.id) run('UPDATE fixed_deposits SET bank=?, principal=?, rate_pct=?, start_date=?, maturity_date=?, closed_at=?, compounding=?, note=? WHERE id=?',
      [fd.bank, Number(fd.principal), Number(fd.rate_pct), fd.start_date, fd.maturity_date || null, fd.closed_at || null, fd.compounding || 'quarterly', fd.note || null, fd.id])
    else run('INSERT INTO fixed_deposits (bank, principal, rate_pct, start_date, maturity_date, closed_at, compounding, note) VALUES (?,?,?,?,?,?,?,?)',
      [fd.bank, Number(fd.principal), Number(fd.rate_pct), fd.start_date, fd.maturity_date || null, fd.closed_at || null, fd.compounding || 'quarterly', fd.note || null])
  })
}
/** Standing rows from a file: fixed deposits, Splitwise, confirmed trades and the target
 * allocation. Idempotent — a deposit is matched on bank + principal + start date. */
export function ingestStanding(p) {
  const out = { fixed_deposits: 0, ppf_deposits: 0, ppf_rates: 0, splitwise: 0, trades: 0, assets: 0, liabilities: 0, target_allocation: false }
  for (const fd of p.fixed_deposits || []) {
    const hit = first('SELECT id FROM fixed_deposits WHERE bank = ? AND principal = ? AND start_date = ?', [fd.bank, Number(fd.principal), fd.start_date])
    saveFixedDeposit({ ...fd, id: hit ? hit.id : undefined }); out.fixed_deposits++
  }
  if (p.ppf && typeof p.ppf === 'object') {
    for (const d of p.ppf.deposits || []) {
      const hit = first('SELECT id FROM ppf_deposits WHERE deposit_date = ? AND amount_inr = ?', [d.date, Number(d.amount_inr)])
      savePpfDeposit({ id: hit ? hit.id : undefined, deposit_date: d.date, amount_inr: d.amount_inr, note: d.note }); out.ppf_deposits++
    }
    for (const r of p.ppf.rates || []) { setPpfRate(r.quarter_start, r.rate_pct); out.ppf_rates++ }
  }
  for (const s of p.splitwise || []) { saveSplitwise(s.person, s.amount_inr, s.note || ''); out.splitwise++ }
  for (const t of p.trades || []) { recordTrade(t); out.trades++ }
  for (const a of p.assets || []) { saveAsset({ ...a, liability: false }); out.assets++ }
  for (const a of p.liabilities || []) { saveAsset({ ...a, liability: true }); out.liabilities++ }
  if (p.target_allocation && typeof p.target_allocation === 'object') { setSetting('target_allocation', p.target_allocation); out.target_allocation = true }
  return out
}

export const deleteFixedDeposit = (id) => write((run) => run('DELETE FROM fixed_deposits WHERE id = ?', [id]))

/** Add a PPF deposit, or change one (any amount, any date) when it carries an id. */
export function savePpfDeposit({ id, deposit_date, amount_inr, note }) {
  if (!DATE.test(deposit_date || '')) fail('PPF deposit date must be YYYY-MM-DD')
  if (!isNum(amount_inr) || Number(amount_inr) <= 0) fail('PPF deposit amount must be a positive number')
  write((run) => {
    if (id) run('UPDATE ppf_deposits SET deposit_date = ?, amount_inr = ?, note = ? WHERE id = ?', [deposit_date, Number(amount_inr), note || null, id])
    else run('INSERT INTO ppf_deposits (deposit_date, amount_inr, note) VALUES (?,?,?)', [deposit_date, Number(amount_inr), note || null])
  })
}
export const deletePpfDeposit = (id) => write((run) => run('DELETE FROM ppf_deposits WHERE id = ?', [id]))

/** The rate the government set for one quarter of the financial year. */
export function setPpfRate(quarter_start, rate_pct) {
  if (!/^\d{4}-(01|04|07|10)-01$/.test(quarter_start || '')) fail(`PPF quarter_start must be the first day of Jan, Apr, Jul or Oct (YYYY-MM-01), got ${JSON.stringify(quarter_start)}`)
  if (!isNum(rate_pct) || Number(rate_pct) <= 0 || Number(rate_pct) > 20) fail('PPF rate must be a percentage, like 7.1')
  write((run) => run('INSERT INTO ppf_rates (quarter_start, rate_pct) VALUES (?, ?) ON CONFLICT(quarter_start) DO UPDATE SET rate_pct = excluded.rate_pct', [quarter_start, Number(rate_pct)]))
}
export const deletePpfRate = (qs) => write((run) => run('DELETE FROM ppf_rates WHERE quarter_start = ?', [qs]))

export function saveSplitwise(person, amount, note = '') {
  if (!person) fail('person is required')
  if (!isNum(amount)) fail('amount must be a number (positive = they owe you)')
  write((run) => {
    run(`INSERT INTO splitwise_balances (person, amount_inr, note, updated_at) VALUES (?,?,?,?)
         ON CONFLICT(person) DO UPDATE SET amount_inr = excluded.amount_inr, note = excluded.note, updated_at = excluded.updated_at`, [person, Number(amount), note, new Date().toISOString()])
    // Keep the latest checkpoint's snapshot in step, so the dashboard moves now.
    const latest = first('SELECT id FROM checkpoints ORDER BY as_of_date DESC LIMIT 1')
    if (latest) run(`INSERT INTO balances (checkpoint_id, kind, ref, amount_inr, meta) VALUES (?,?,?,?,?)
         ON CONFLICT(checkpoint_id, kind, ref) DO UPDATE SET amount_inr = excluded.amount_inr, meta = excluded.meta`, [latest.id, 'splitwise', person, Number(amount), JSON.stringify({ note })])
  })
}
export function deleteSplitwise(person) {
  write((run) => {
    run('DELETE FROM splitwise_balances WHERE person = ?', [person])
    const latest = first('SELECT id FROM checkpoints ORDER BY as_of_date DESC LIMIT 1')
    if (latest) run("DELETE FROM balances WHERE checkpoint_id = ? AND kind = 'splitwise' AND ref = ?", [latest.id, person])
  })
}

export function recordTrade(t) {
  write((run) => run(`INSERT INTO trades (sleeve, symbol, exit_date, invested_inr, realised_inr, holding_days, source) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(sleeve, symbol, exit_date, invested_inr) DO UPDATE SET realised_inr = excluded.realised_inr`,
    [t.sleeve, t.symbol, t.exit_date, Number(t.invested_inr), Number(t.realised_inr), t.holding_days ?? null, t.source || 'refresh']))
}
export const deleteTrade = (id) => write((run) => run('DELETE FROM trades WHERE id = ?', [id]))

// --- other assets and loans ----------------------------------------------------------
/** Record what an asset (NPS, PPF, property...) or a loan is worth on a date. Entering it
 * again later adds a newer entry, so earlier checkpoints keep the value that was true then. */
export function saveAsset({ kind, name, value_inr, as_of_date, note, liability = false }) {
  const kinds = liability ? LIABILITY_KINDS : ASSET_KINDS
  if (!kinds.includes(kind)) fail(`${liability ? 'loan' : 'asset'} kind must be one of ${kinds.join(', ')}`)
  if (!name) fail('name is required')
  if (!isNum(value_inr) || Number(value_inr) < 0) fail('value_inr must be a number, positive; a loan is the amount you owe')
  const d = as_of_date || new Date().toISOString().slice(0, 10)
  if (!DATE.test(d)) fail('as_of_date must be YYYY-MM-DD')
  write((run) => run(`INSERT INTO manual_assets (kind, name, as_of_date, value_inr, liability, note) VALUES (?,?,?,?,?,?)
    ON CONFLICT(kind, name, as_of_date) DO UPDATE SET value_inr = excluded.value_inr, liability = excluded.liability, note = excluded.note`,
  [kind, name, d, Number(value_inr), liability ? 1 : 0, note || null]))
}
export const deleteAsset = (kind, name) => write((run) => run('DELETE FROM manual_assets WHERE kind = ? AND name = ?', [kind, name]))

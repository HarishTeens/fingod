// Getting data in. Two kinds of file arrive from your coding agent (see
// docs/DATA-FORMAT.md): checkpoints and Wallet transactions. Both are
// idempotent — re-importing a file never duplicates anything.
import { all, first, scalar, write } from './db.js'
import { money } from './compute/num.js'

export const SLEEVES = ['in_equity', 'in_mf', 'us_equity', 'gold', 'debt', 'btc']
export const BALANCE_KINDS = ['cash', 'credit_card', 'epf']
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
  const seen = new Set()
  p.holdings.forEach((h, i) => {
    const at = `holdings[${i}]${h && h.symbol ? ` (${h.symbol})` : ''}`
    if (!h || !SLEEVES.includes(h.sleeve)) fail(`${at}: sleeve must be one of ${SLEEVES.join(', ')}`)
    if (!h.symbol) fail(`${at}: symbol is required`)
    if (!isNum(h.qty)) fail(`${at}: qty is required and must be a number`)
    if (!isNum(h.price)) fail(`${at}: price is required and must be a number`)
    if (h.currency && h.currency !== 'INR' && !isNum(h.fx_rate) && !isNum(p.usd_inr)) fail(`${at}: a ${h.currency} holding needs fx_rate or a checkpoint usd_inr`)
    const key = `${h.sleeve}\0${h.symbol}`
    if (seen.has(key)) fail(`${at}: duplicate ${h.sleeve}/${h.symbol} in one checkpoint`)
    seen.add(key)
  })
  const refs = new Set()
  ;(p.balances || []).forEach((b, i) => {
    if (b && b.kind === 'splitwise') return // taken from the standing Splitwise rows, never from a payload
    if (!b || !BALANCE_KINDS.includes(b.kind)) fail(`balances[${i}]: kind must be one of ${BALANCE_KINDS.join(', ')}`)
    if (!b.ref) fail(`balances[${i}]: ref is required`)
    if (!isNum(b.amount_inr)) fail(`balances[${i}] (${b.ref}): amount_inr must be a number`)
    if (b.kind === 'credit_card' && Number(b.amount_inr) < 0) fail(`balances[${i}] (${b.ref}): credit_card is stored positive = outstanding; Wallet reports it negative, so flip the sign`)
    const key = `${b.kind}\0${b.ref}`
    if (refs.has(key)) fail(`balances[${i}]: duplicate ${b.kind}/${b.ref}`)
    refs.add(key)
  })
}

/** Store one checkpoint, replacing any other on the same date. Returns warnings. */
export function ingestCheckpoint(p) {
  validateCheckpoint(p)
  const warnings = []
  const usd = nullable(p.usd_inr)
  const existed = !!first('SELECT id FROM checkpoints WHERE as_of_date = ?', [p.as_of_date])

  write((run) => {
    run('DELETE FROM checkpoints WHERE as_of_date = ?', [p.as_of_date])
    run('INSERT INTO checkpoints (as_of_date, usd_inr, sources, created_at) VALUES (?, ?, ?, ?)',
      [p.as_of_date, usd, JSON.stringify(p.sources || {}), new Date().toISOString()])
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
    for (const b of p.balances || []) {
      if (b.kind === 'splitwise') continue
      run('INSERT INTO balances (checkpoint_id, kind, ref, amount_inr, meta) VALUES (?,?,?,?,?)', [id, b.kind, b.ref, Number(b.amount_inr), b.meta ? JSON.stringify(b.meta) : null])
    }
    // Splitwise is a standing row, snapshotted so history keeps what was true then.
    for (const s of all('SELECT person, amount_inr, note FROM splitwise_balances')) {
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

/** A file's kind, from its contents. */
export function classify(payload) {
  if (payload && Array.isArray(payload.holdings) && payload.as_of_date) return 'checkpoint'
  if (payload && (Array.isArray(payload.transactions) || Array.isArray(payload))) return 'transactions'
  return null
}

export function ingestAny(payload) {
  const kind = classify(payload)
  if (kind === 'checkpoint') return { kind, ...ingestCheckpoint(payload) }
  if (kind === 'transactions') return { kind, ...ingestTransactions(payload) }
  fail('not a fingod file: expected a checkpoint ({as_of_date, holdings}) or {transactions}')
}

/** Pull in everything the agent has dropped into data/. Needs serve.py (or any
 * server exposing /data/manifest.json). Returns what changed. */
export async function syncInbox() {
  let manifest
  try {
    const res = await fetch('data/manifest.json', { cache: 'no-store' })
    if (!res.ok) return { available: false, imported: [], errors: [] }
    manifest = await res.json()
  } catch { return { available: false, imported: [], errors: [] } }

  const imported = [], errors = []
  const files = (manifest.files || []).filter((f) => f.path.endsWith('.json') && /^(checkpoints|transactions)\//.test(f.path)).sort((a, b) => a.path.localeCompare(b.path))
  for (const f of files) {
    const fingerprint = `${f.size}:${f.mtime}`
    const seen = first('SELECT fingerprint FROM imported_files WHERE path = ?', [f.path])
    if (seen && seen.fingerprint === fingerprint) continue
    try {
      const res = await fetch(`data/${f.path}`, { cache: 'no-store' })
      const result = ingestAny(await res.json())
      write((run) => run('INSERT INTO imported_files (path, fingerprint, imported_at) VALUES (?,?,?) ON CONFLICT(path) DO UPDATE SET fingerprint = excluded.fingerprint, imported_at = excluded.imported_at', [f.path, fingerprint, new Date().toISOString()]))
      imported.push({ path: f.path, ...result })
    } catch (e) { errors.push({ path: f.path, error: e.message }) }
  }
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
export const deleteFixedDeposit = (id) => write((run) => run('DELETE FROM fixed_deposits WHERE id = ?', [id]))

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

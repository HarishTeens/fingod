// SQLite in the browser, via sql.js (SQLite compiled to WebAssembly, vendored in
// /vendor). The database lives in memory and is saved to IndexedDB after every
// write, so it survives reloads and never leaves the machine.
import { MIGRATIONS, SCHEMA_VERSION } from './schema.js'

const IDB_NAME = 'fingod', IDB_STORE = 'db', IDB_KEY = 'sqlite'
let SQL, db, saveTimer, listeners = []

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}
async function idbGet() {
  const conn = await idb()
  return new Promise((resolve, reject) => {
    const r = conn.transaction(IDB_STORE).objectStore(IDB_STORE).get(IDB_KEY)
    r.onsuccess = () => resolve(r.result || null)
    r.onerror = () => reject(r.error)
  })
}
async function idbPut(bytes) {
  const conn = await idb()
  return new Promise((resolve, reject) => {
    const tx = conn.transaction(IDB_STORE, 'readwrite')
    tx.objectStore(IDB_STORE).put(bytes, IDB_KEY)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}
async function idbClear() {
  const conn = await idb()
  return new Promise((resolve, reject) => {
    const tx = conn.transaction(IDB_STORE, 'readwrite')
    tx.objectStore(IDB_STORE).delete(IDB_KEY)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

function migrate() {
  db.run('PRAGMA foreign_keys = ON')
  const has = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").length > 0
  const current = has ? Number(first('SELECT value FROM meta WHERE key = ?', ['schema_version'])?.value || 0) : 0
  for (let v = current; v < SCHEMA_VERSION; v++) {
    db.run(MIGRATIONS[v])
    db.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', ['schema_version', String(v + 1)])
  }
}

/** Open the database: restore it from IndexedDB, or start empty. */
export async function open() {
  SQL = await window.initSqlJs({ locateFile: (f) => `vendor/${f.replace('sql-wasm-browser', 'sql-wasm')}` })
  const saved = await idbGet().catch(() => null)
  db = saved ? new SQL.Database(saved) : new SQL.Database()
  migrate()
  return db
}

/** Rows as plain objects. */
export function all(sql, params = []) {
  const stmt = db.prepare(sql)
  const rows = []
  try {
    stmt.bind(params)
    while (stmt.step()) rows.push(stmt.getAsObject())
  } finally { stmt.free() }
  return rows
}
export const first = (sql, params = []) => all(sql, params)[0] || null
export const scalar = (sql, params = []) => { const r = first(sql, params); return r ? Object.values(r)[0] : null }

/** Run writes in one transaction; save to IndexedDB afterwards. */
export function write(fn) {
  db.run('BEGIN')
  try {
    const out = fn((sql, params = []) => db.run(sql, params))
    db.run('COMMIT')
    scheduleSave()
    notify()
    return out
  } catch (e) {
    db.run('ROLLBACK')
    throw e
  }
}

function scheduleSave() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => idbPut(db.export()).catch((e) => console.error('save failed', e)), 150)
}
export async function flush() { clearTimeout(saveTimer); await idbPut(db.export()) }

export function onChange(fn) { listeners.push(fn); return () => { listeners = listeners.filter((l) => l !== fn) } }
const notify = () => listeners.forEach((l) => { try { l() } catch (e) { console.error(e) } })

/** Download the whole database as a file — a backup you can keep. */
export function exportBytes() { return db.export() }

/** Replace the database with a backup file's bytes. */
export async function importBytes(bytes) {
  db = new SQL.Database(bytes)
  migrate()
  await flush(); notify()
}

/** Wipe everything and start fresh. */
export async function reset() {
  await idbClear()
  db = new SQL.Database()
  migrate()
  notify()
}

// --- settings (JSON values) ---------------------------------------------------
export function getSetting(key, fallback = null) {
  const r = first('SELECT value FROM settings WHERE key = ?', [key])
  return r ? JSON.parse(r.value) : fallback
}
export function setSetting(key, value) {
  write((run) => run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, JSON.stringify(value)]))
}

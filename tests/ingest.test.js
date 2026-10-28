import test from 'node:test'
import assert from 'node:assert/strict'
import { validateCheckpoint, classify, IngestError } from '../src/ingest.js'

const ok = () => ({
  as_of_date: '2026-10-29', usd_inr: 90,
  holdings: [{ sleeve: 'in_equity', symbol: 'ACME', qty: 10, price: 100 }, { sleeve: 'us_equity', symbol: 'ALPH', qty: 2, price: 500, currency: 'USD' }],
  balances: [{ kind: 'cash', ref: 'Bank A', amount_inr: 1000 }, { kind: 'credit_card', ref: 'Card A', amount_inr: 500 }],
})
const bad = (mutate, pattern) => { const p = ok(); mutate(p); assert.throws(() => validateCheckpoint(p), (e) => e instanceof IngestError && pattern.test(e.message)) }

test('a well-formed checkpoint validates', () => assert.doesNotThrow(() => validateCheckpoint(ok())))

test('a bad date, sleeve, or missing quantity is named precisely', () => {
  bad((p) => (p.as_of_date = '29/10/2026'), /as_of_date/)
  bad((p) => (p.holdings[0].sleeve = 'crypto'), /holdings\[0\].*sleeve/)
  bad((p) => delete p.holdings[0].qty, /ACME.*qty/)
  bad((p) => (p.holdings[1].price = 'abc'), /ALPH.*price/)
})

test('a foreign holding needs a rate from somewhere', () => {
  bad((p) => { delete p.usd_inr }, /needs fx_rate or a checkpoint usd_inr/)
  const p = ok(); delete p.usd_inr; p.holdings[1].fx_rate = 90
  assert.doesNotThrow(() => validateCheckpoint(p))
})

test('duplicates are rejected before they reach the UNIQUE constraint', () => {
  bad((p) => p.holdings.push({ ...p.holdings[0] }), /duplicate in_equity\/ACME/)
  bad((p) => p.balances.push({ ...p.balances[0] }), /duplicate cash\/Bank A/)
})

test('credit cards are stored positive; a negative one means the caller forgot to flip it', () => {
  bad((p) => (p.balances[1].amount_inr = -500), /flip the sign/)
})

test('splitwise in a payload is ignored: the standing rows are the one source', () => {
  const p = ok(); p.balances.push({ kind: 'splitwise', ref: 'Friend', amount_inr: 100 })
  assert.doesNotThrow(() => validateCheckpoint(p))
})

test('files are classified by what they contain', () => {
  assert.equal(classify(ok()), 'checkpoint')
  assert.equal(classify({ transactions: [] }), 'transactions')
  assert.equal(classify([{ id: 'x' }]), 'transactions')
  assert.equal(classify({ hello: 'world' }), null)
})

test('standing-row files are recognised, and a checkpoint may carry its own splitwise history', () => {
  assert.equal(classify({ fixed_deposits: [] }), 'standing')
  assert.equal(classify({ trades: [], target_allocation: { in_equity: 100 } }), 'standing')
  const p = ok(); p.balances.push({ kind: 'splitwise', ref: 'Friend', amount_inr: 100 })
  assert.doesNotThrow(() => validateCheckpoint(p))
  const bad = ok(); bad.balances.push({ kind: 'splitwise', ref: 'Friend' })
  assert.throws(() => validateCheckpoint(bad), /splitwise entry needs ref and amount_inr/)
})

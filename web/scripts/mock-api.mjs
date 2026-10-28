// A demo API serving invented numbers in the same shapes as the real one, so the
// dashboard can be run and screenshotted without any accounts or personal data.
//
//   make demo                      # starts this and the Vite dev server together
//   node web/scripts/mock-api.mjs  # or on its own; PORT defaults to 8099
//
// Covers the Dashboard and Investments pages. Realised and Expenses need more
// endpoints than this stubs, so those two tabs show an error against the demo.
import http from 'node:http'
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
const N = 26, start = new Date('2026-05-01')
const dates = Array.from({ length: N }, (_, i) => new Date(start.getTime() + i * 7 * 864e5).toISOString().slice(0, 10))
const K = 0.21
const base = Object.fromEntries(Object.entries({ in_mf: 1500000, in_equity: 1100000, us_equity: 380000, gold: 150000, debt: 60000, btc: 90000 }).map(([k, v]) => [k, v * K]))
const drift = { in_mf: 1.0045, in_equity: 1.0025, us_equity: 1.0055, gold: 1.0065, debt: 1.0008, btc: 1.003 }
const vol = { in_mf: .012, in_equity: .016, us_equity: .02, gold: .014, debt: .0008, btc: .05 }
const cur = { ...base }; const sl = []
for (const d of dates) { for (const k in cur) cur[k] *= drift[k] * (1 + (rnd() - .5) * vol[k]) + 0; sl.push({ d, ...Object.fromEntries(Object.entries(cur).map(([k, v]) => [k, Math.round(v)])) }) }
const fdP = 700000 * K, cashAt = (i) => Math.round((60000 + (i % 5) * 4000) * K), cc = (i) => Math.round((45000 + ((i * 7) % 6) * 5000) * K)
const series = sl.map((r, i) => {
  const inv = r.in_mf + r.in_equity + r.us_equity + r.gold + r.debt + r.btc
  const fdAcc = Math.round(fdP * 0.0625 * (i + 40) / 52 * 0.3)
  const liquid = inv + cashAt(i) + fdP - cc(i), epf = Math.round((240000 + i * 2100) * K), sw = Math.round(90000 * K)
  return { as_of_date: r.d, liquid, total: liquid + epf + fdAcc + sw,
    sleeves: { btc: r.btc, debt: r.debt, gold: r.gold, in_equity: r.in_equity, in_mf: r.in_mf, us_equity: r.us_equity },
    cash: cashAt(i), credit_card: cc(i), epf, splitwise: sw, fd_principal: fdP, fd_accrued: fdAcc, investments: inv }
})
const L = series.at(-1)
const sleeveVal = { in_mf: L.sleeves.in_mf, in_equity: L.sleeves.in_equity, fd: fdP, us_equity: L.sleeves.us_equity, gold: L.sleeves.gold, btc: L.sleeves.btc, debt: L.sleeves.debt, epf: L.epf, liquid: L.cash, cash: 0 }
const targets = { btc: 5, debt: 2, epf: 0, fd: 15, gold: 5, in_equity: 27, in_mf: 35, liquid: 1, us_equity: 10 }
const baseTot = Object.entries(sleeveVal).filter(([k]) => k !== 'epf').reduce((a, [, v]) => a + v, 0)
const allocation = { as_of_date: dates.at(-1), base: baseTot, rows: Object.entries(targets).map(([sleeve, t]) => {
  const value = sleeveVal[sleeve], share = value / baseTot * 100; return { sleeve, value, share_pct: share, target_pct: t, drift_pp: share - t, to_move: (t - share) / 100 * baseTot } }) }
const holdNames = { in_mf: ['Meridian Small Cap Fund','Northwind Flexi Cap Fund','Harbor Midcap Fund','Summit Index Fund'], in_equity: ['ACME','BRIGHTON','CASCADE','DELTAWORKS','EVERGREEN','FALCON'], us_equity: ['ALPH','BETA','GAMM','DLTA'], gold: ['GOLDETF'], debt: ['LIQUIDETF'], btc: ['BTC'] }
const sleeves = Object.keys(holdNames).map((sleeve) => {
  const value = L.sleeves[sleeve], first = sl[0][sleeve], invested = Math.round(first * 0.92), n = holdNames[sleeve].length
  const w = holdNames[sleeve].map((_, i) => 1 + ((i * 3) % 4)), ws = w.reduce((a, b) => a + b, 0)
  const flow = Math.round(value * .03), market = value - first - flow
  return { sleeve, value, invested, unrealised: value - invested, return_pct: (value - invested) / invested * 100, market, flow, fx: sleeve === 'us_equity' ? 900 : 0, delta: value - first,
    holdings: holdNames[sleeve].map((s, i) => { const v = value * w[i] / ws, inv = v * (0.85 + .05 * i); return { sleeve, symbol: s, name: s, isin: 'XX' + i, qty: 10 + i * 7, price: v / (10 + i * 7), avg_cost: inv / (10 + i * 7), currency: sleeve === 'us_equity' ? 'USD' : 'INR', share_pct: w[i] / ws * 100, value: v, invested: inv, unrealised: v - inv, return_pct: (v - inv) / inv * 100, market: v * .02 } }) }
})
const idx = (k) => sl.map((r) => r[k])
const sleevesResp = { as_of: dates.at(-1), compared_to: dates[0], checkpoints_in_range: N, sleeves,
  total: { value: sleeves.reduce((a, s) => a + s.value, 0), invested: sleeves.reduce((a, s) => a + s.invested, 0), unrealised: sleeves.reduce((a, s) => a + s.unrealised, 0), return_pct: 0, partial: false },
  series: sl.map((r, i) => ({ as_of: r.d, values: { btc: r.btc, debt: r.debt, fd: fdP, gold: r.gold, in_equity: r.in_equity, in_mf: r.in_mf, us_equity: r.us_equity } })) }
sleevesResp.total.return_pct = sleevesResp.total.unrealised / sleevesResp.total.invested * 100
const labels = ['Home', 'Food', 'Travel', 'Fitness', 'Subscriptions', 'Shopping']
const months = Array.from({ length: 12 }, (_, i) => { const d = new Date(Date.UTC(2025, 10 + i, 1)); return d.toISOString().slice(0, 10) })
const exp = { by: 'label', count: 12, granularity: 'month', labels, note: '', series: months.map((p, i) => { const seg = {}; let t = 0; labels.forEach((l, j) => { const v = Math.round((4000 + ((i * 13 + j * 29) % 17) * 900 + (j === 0 ? 14000 : 0)) * 0.3); seg[l] = v; t += v }); return { period: p, total: t, segments: seg, net_inflow: 27000 } }) }
const routes = {
  '/api/v1/networth': { count: N, series }, '/api/v1/allocation': allocation, '/api/v1/sleeves': sleevesResp,
  '/api/v1/expenses': exp, '/api/v1/checkpoints': { checkpoints: [] }, '/api/v1/price-targets': { count: 0, targets: [] },
}
http.createServer((q, r) => { const u = new URL(q.url, 'http://x'); let d = routes[u.pathname]
  const m = u.pathname.match(/sleeves\/(\w+)\/holdings/); if (m) d = { as_of: dates.at(-1), compared_to: dates[0], sleeve: sleeves.find((s) => s.sleeve === m[1]) }
  r.setHeader('content-type', 'application/json'); if (!d) { r.statusCode = 404; return r.end('{"error":"mock"}') } r.end(JSON.stringify(d)) }).listen(Number(process.env.PORT) || 8099, '127.0.0.1', () => console.log('demo API on', process.env.PORT || 8099))

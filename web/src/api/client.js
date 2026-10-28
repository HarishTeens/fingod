// The dev proxy attaches the bearer token, so nothing here handles credentials.
// See web/vite.config.js for why.

async function get(path) {
  const res = await fetch(`/api/v1${path}`, { headers: { Accept: 'application/json' } })
  if (!res.ok) {
    let detail = ''
    try {
      detail = (await res.json()).error || ''
    } catch {
      /* a non-JSON body means the proxy or the server itself is down */
    }
    throw new Error(detail || `${res.status} ${res.statusText}`)
  }
  return res.json()
}

export const api = {
  networth: (params = '') => get(`/networth${params}`),
  allocation: () => get('/allocation'),
  expenses: (granularity = 'month') => get(`/expenses?granularity=${granularity}`),
  expensesByLabel: (granularity = 'month', from) =>
    get(`/expenses?granularity=${granularity}&by=label${from ? `&from=${from}` : ''}`),
  checkpoints: () => get('/checkpoints'),

  projection: () => get('/projection'),
  realised: (granularity = 'month') => get(`/realised?granularity=${granularity}`),
  priceTargets: () => get('/price-targets'),

  sleeves: ({ from, to } = {}) => get(`/sleeves?${qs({ from, to })}`),
  sleeveHoldings: (sleeve, { from, to } = {}) =>
    get(`/sleeves/${encodeURIComponent(sleeve)}/holdings?${qs({ from, to })}`),

  breakdown: ({ period, granularity = 'month', by = 'category', category, subcategory, label }) =>
    get(`/expenses/breakdown?${qs({ period, granularity, by, category, subcategory, label })}`),

  expenseTransactions: ({ period, granularity = 'month', category, subcategory, label, limit }) =>
    get(`/expenses/transactions?${qs({ period, granularity, category, subcategory, label, limit })}`),
}

/** Drops empty values, so an absent filter is an absent parameter. */
function qs(params) {
  const out = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') out.set(k, v)
  }
  return out.toString()
}

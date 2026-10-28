import { compact, num } from '../lib/format.js'
import { useSortedRows, compare } from '../lib/useSort.jsx'
import { usePaged } from '../lib/usePaged.jsx'

/**
 * How many percentage points of the rupee return came from the currency rather
 * than the asset. Null when either leg is missing — a made-up zero would read
 * as "the currency did nothing", which is a claim, not an absence.
 */
function fxEffect(h) {
  if (!h.foreign || h.return_pct === '' || h.return_pct === undefined) return null
  if (h.foreign.return_pct === '' || h.foreign.return_pct === undefined) return null
  return num(h.return_pct) - num(h.foreign.return_pct)
}

const fxSymbol = (code) => ({ USD: '$', EUR: '\u20ac', GBP: '\u00a3' }[code] || `${code} `)

/** Sign outside the currency symbol: "\u2212$83", never "$-83". */
function foreignMoney(value, code) {
  const n = num(value)
  const body = `${fxSymbol(code)}${Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}`
  return n < 0 ? `\u2212${body}` : body
}

/** Signed, coloured, and always with an arrow — never colour alone. */
function Signed({ value, suffix = '' }) {
  if (value === null || value === undefined || value === '') {
    return <span style={{ color: 'var(--muted)' }}>—</span>
  }
  const n = num(value)
  return (
    <span style={{ color: n >= 0 ? 'var(--good)' : 'var(--critical)' }}>
      {n >= 0 ? '▲' : '▼'} {suffix === '%' ? `${Math.abs(n).toFixed(2)}%` : compact(Math.abs(n))}
    </span>
  )
}

export function HoldingsTable({ holdings, showAttribution }) {
  // Deposits have a rate where everything else has a unit cost.
  const fdMode = holdings?.[0]?.sleeve === 'fd'

  // A sleeve priced in something other than rupees gets two return columns and
  // the gap between them, because one number cannot answer both "did the
  // company do well" and "did my rupees do well". They differ by the currency,
  // and for US equity the difference has run to several points.
  const fx = holdings?.find((h) => h.foreign)?.foreign?.currency

  const columns = [
    { key: 'symbol', label: 'Holding', numeric: false, className: undefined },
    { key: 'qty', label: 'Qty', numeric: true },
    { key: 'avg_cost', label: fdMode ? 'Rate' : 'Avg cost', numeric: true },
    { key: 'price', label: 'Price', numeric: true },
    { key: 'value', label: 'Value', numeric: true },
    { key: 'share_pct', label: 'Share', numeric: true },
    { key: 'return_pct', label: fx ? 'INR return' : 'Since bought', numeric: true },
    ...(fx
      ? [
          {
            key: 'foreign_return_pct',
            label: `${fx} return`,
            numeric: true,
            get: (h) => h.foreign?.return_pct,
          },
          {
            key: 'fx_effect',
            label: 'FX effect',
            numeric: true,
            get: (h) => fxEffect(h),
          },
        ]
      : []),
    { key: 'target_price', label: 'Target', numeric: true },
    { key: 'target_away_pct', label: 'Away', numeric: true },
    ...(showAttribution
      ? [
          { key: 'market', label: 'Market', numeric: true },
          { key: 'flow', label: 'Flow', numeric: true },
          { key: 'fx', label: 'FX', numeric: true },
        ]
      : []),
  ]
  // Value descending is what the server returns and what "what am I mostly in"
  // wants first.
  const { sorted, headers } = useSortedRows(holdings || [], columns, { key: 'value', dir: 'desc' })
  const { visible: rows, pager } = usePaged(sorted)

  if (!holdings?.length) return <div className="empty">Nothing held here.</div>

  return (
    <>
    <div className="table-wrap">
    <table className="data">
      <thead><tr>{headers}</tr></thead>
      <tbody>
        {rows.map((h) => (
          <tr key={h.isin || h.symbol}>
            <td className="name">
              {h.symbol}
              {h.name && h.name !== h.symbol && (
                <div style={{ color: 'var(--muted)', fontSize: 11.5 }}>{h.name}</div>
              )}
              {h.flagged && (
                <span className="tag" title="Flow above the review threshold — often an unrecorded split or bonus">
                  ⚑ check
                </span>
              )}
            </td>
            {/* Fixed deposits have neither a quantity nor a price, and inventing
                a 1 to fill the column would be worse than an em-dash. */}
            <td className="num">
              {h.qty ? num(h.qty).toLocaleString('en-IN', { maximumFractionDigits: 4 })
                     : <span style={{ color: 'var(--muted)' }}>—</span>}
            </td>
            <td className="num" style={{ color: 'var(--muted)' }}>
              {h.avg_cost
                ? `${num(h.avg_cost).toLocaleString('en-IN', { maximumFractionDigits: 2 })}${fdMode ? '%' : ''}`
                : '—'}
            </td>
            <td className="num">
              {h.price ? num(h.price).toLocaleString('en-IN', { maximumFractionDigits: 2 })
                       : <span style={{ color: 'var(--muted)' }}>—</span>}
            </td>
            <td className="num">{compact(h.value)}</td>
            <td className="num" style={{ color: 'var(--muted)' }}>
              {h.share_pct ? `${num(h.share_pct).toFixed(1)}%` : '—'}
            </td>
            <td className="num">
              <Signed value={h.return_pct} suffix="%" />
              <div style={{ color: 'var(--muted)', fontSize: 11.5 }}>{compact(h.unrealised)}</div>
            </td>
            {fx && (
              <>
                <td className="num">
                  <Signed value={h.foreign?.return_pct} suffix="%" />
                  <div style={{ color: 'var(--muted)', fontSize: 11.5 }}>
                    {h.foreign ? foreignMoney(h.foreign.unrealised, fx) : '—'}
                  </div>
                </td>
                {/* The currency's own contribution, in percentage points. Positive
                    means the rupee weakened since these shares were bought and is
                    adding to the rupee return; negative means it firmed and is
                    eating into it. */}
                <td className="num">
                  {fxEffect(h) === null ? (
                    <span style={{ color: 'var(--muted)' }}>—</span>
                  ) : (
                    <>
                      <span style={{ color: 'var(--muted)' }}>
                        {fxEffect(h) >= 0 ? '+' : '−'}{Math.abs(fxEffect(h)).toFixed(2)}pp
                      </span>
                      <div style={{ color: 'var(--muted)', fontSize: 11.5 }}>
                        {h.foreign?.buy_rate ? `bought @ ${num(h.foreign.buy_rate).toFixed(2)}` : ''}
                      </div>
                    </>
                  )}
                </td>
              </>
            )}
            <td className="num" style={{ color: 'var(--muted)' }}>
              {h.target_price
                ? num(h.target_price).toLocaleString('en-IN', { maximumFractionDigits: 2 })
                : '—'}
              {h.target_horizon && (
                <div style={{ fontSize: 11 }}>{h.target_horizon}</div>
              )}
            </td>
            <td className="num">
              {h.target_away_pct === undefined || h.target_away_pct === '' ? (
                <span style={{ color: 'var(--muted)' }}>—</span>
              ) : h.target_hit ? (
                /* Reached: the one row on this page that is a call to act. */
                <span className="tag" style={{ borderColor: 'var(--good)', color: 'var(--good)' }}>
                  ✓ target hit
                </span>
              ) : (
                <span>{`+${num(h.target_away_pct).toFixed(1)}%`}</span>
              )}
            </td>
            {showAttribution && (
              <>
                <td className="num"><Signed value={h.market} /></td>
                <td className="num"><Signed value={h.flow} /></td>
                <td className="num"><Signed value={h.fx} /></td>
              </>
            )}
          </tr>
        ))}
      </tbody>
    </table>
    </div>
      {pager}
    </>
  )
}

export { Signed, compare }

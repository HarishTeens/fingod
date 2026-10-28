import { Card } from './Card.jsx'
import { usePaged } from '../lib/usePaged.jsx'
import { compact, moneyExact, num, pct } from '../lib/format.js'

/**
 * One level of the drill-down, as a bar-in-a-row list rather than a chart.
 *
 * The job here is "which of these is big, and let me open it" — a sorted list
 * with an inline proportion bar answers both, stays legible at fifteen rows,
 * and needs no legend. A pie of fifteen categories would need one and would
 * still be harder to read.
 */
export function BreakdownList({ title, rows, total, onPick, picked, actions, emptyText }) {
  // The bar is scaled to the largest row overall, not the largest on this page,
  // so a row does not change width when you turn the page.
  const max = rows.reduce((m, r) => Math.max(m, num(r.amount)), 0)
  const { visible, pager } = usePaged(rows)

  return (
    <Card title={title} actions={actions}>
      {rows.length === 0 ? (
        <div className="empty">{emptyText || 'Nothing here.'}</div>
      ) : (
        <table className="data">
          <tbody>
            {visible.map((r) => {
              const amount = num(r.amount)
              const isPicked = picked === r.key
              const Row = onPick ? 'button' : 'div'
              return (
                <tr key={r.key} className={isPicked ? 'picked' : undefined}>
                  <td style={{ width: '52%' }}>
                    <Row
                      type={onPick ? 'button' : undefined}
                      className={onPick ? 'row-btn' : undefined}
                      onClick={onPick ? () => onPick(isPicked ? null : r.key) : undefined}
                      title={onPick ? (isPicked ? 'Back out of this level' : `Open ${r.key}`) : undefined}
                    >
                      {/* Wallet's own category colour, so a row looks the way it
                          does in the app the data came from. Decoration only —
                          the name is always beside it. */}
                      <i
                        className="dot"
                        style={{ background: r.color || 'var(--muted)' }}
                        aria-hidden="true"
                      />
                      <span className="name">{r.key}</span>
                    </Row>
                  </td>
                  <td style={{ width: '26%' }}>
                    <span className="minibar" aria-hidden="true">
                      <span style={{ width: max ? `${(amount / max) * 100}%` : 0 }} />
                    </span>
                  </td>
                  <td className="num" style={{ width: '14%' }}>{compact(amount)}</td>
                  <td className="num" style={{ width: '8%', color: 'var(--muted)' }}>
                    {total ? pct((amount / num(total)) * 100) : ''}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      {pager}
      {total ? (
        <p className="note">
          {moneyExact(total)} across {rows.length} {rows.length === 1 ? 'row' : 'rows'}.
        </p>
      ) : null}
    </Card>
  )
}

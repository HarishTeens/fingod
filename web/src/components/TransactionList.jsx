import { Card } from './Card.jsx'
import { usePaged } from '../lib/usePaged.jsx'
import { moneyExact, num, shortDate } from '../lib/format.js'

export function TransactionList({ transactions, total, count, note }) {
  const { visible, pager } = usePaged(transactions)
  return (
    <Card title="Transactions">
      {transactions.length === 0 ? (
        <div className="empty">Nothing matches this filter.</div>
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>Date</th>
              <th>Category</th>
              <th>Note</th>
              <th>Account</th>
              <th>Labels</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((t) => (
              <tr key={t.id}>
                <td style={{ whiteSpace: 'nowrap' }}>{shortDate(t.date)}</td>
                <td className="name">
                  <i className="dot" style={{ background: t.color || 'var(--muted)' }} aria-hidden="true" />
                  {t.category || '—'}
                </td>
                <td style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {t.note || <span style={{ color: 'var(--muted)' }}>—</span>}
                </td>
                <td>{t.account}</td>
                <td>
                  {t.labels?.length ? (
                    t.labels.map((l) => <span key={l} className="tag">{l}</span>)
                  ) : (
                    <span style={{ color: 'var(--muted)' }}>—</span>
                  )}
                </td>
                <td className="num" style={{ color: 'var(--ink)' }}>{moneyExact(t.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {pager}
      <p className="note">
        {count} {count === 1 ? 'record' : 'records'} · {moneyExact(num(total))}
        {note ? ` · ${note}` : ''}
      </p>
    </Card>
  )
}

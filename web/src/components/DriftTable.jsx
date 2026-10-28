import { Card, Swatch } from './Card.jsx'
import { usePaged } from '../lib/usePaged.jsx'
import { compact, moneyExact, num, pct, sleeveColor, sleeveLabel } from '../lib/format.js'

/**
 * The rebalance table. No chart: the job is "which number do I act on", and a
 * seven-row table with a signed rupee column answers it better than any bar.
 */
export function DriftTable({ allocation }) {
  // Same order as the allocation panel — two tables of the same nine rows in
  // different orders is a bug the reader has to diagnose.
  const rows = [...(allocation?.rows ?? [])].sort((a, b) => num(b.value) - num(a.value))
  // Anything held but unnamed by the target. Surfaced rather than dropped: a
  // sleeve missing from this table must never mean a sleeve missing from your
  // net worth.
  const untargeted = Object.entries(allocation?.untargeted ?? {})
  const { visible, pager } = usePaged(rows)
  if (!rows.length) return null

  return (
    <Card title="Rebalance">
      <table className="data">
        <thead>
          <tr>
            <th>Sleeve</th>
            <th className="num">Value</th>
            <th className="num">Now</th>
            <th className="num">Target</th>
            <th className="num">Drift</th>
            <th className="num">To move</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((r) => {
            const move = num(r.to_move)
            const drift = num(r.drift_pp)
            return (
              <tr key={r.sleeve}>
                <td className="name"><Swatch color={sleeveColor(r.sleeve)} />{sleeveLabel(r.sleeve)}</td>
                <td className="num">{compact(r.value)}</td>
                <td className="num">{pct(r.share_pct)}</td>
                <td className="num" style={{ color: 'var(--muted)' }}>{pct(r.target_pct)}</td>
                <td className="num">
                  {drift >= 0 ? '▲' : '▼'} {Math.abs(drift).toFixed(1)}pp
                </td>
                <td className="num" style={{ color: 'var(--ink)' }}>
                  {move >= 0 ? 'Buy ' : 'Sell '}
                  {compact(Math.abs(move))}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {pager}

      {untargeted.length > 0 && (
        <p className="note" style={{ color: 'var(--ink-2)' }}>
          <strong>Held but not targeted:</strong>{' '}
          {untargeted.map(([k, v], i) => (
            <span key={k}>
              {i > 0 && ' · '}
              {sleeveLabel(k)} {compact(v)}
            </span>
          ))}
          . Counted in net worth, but outside this table and its denominator — add a line to{' '}
          <code>target_allocation</code> to bring it in.
        </p>
      )}

      <p className="note">
        Percentages are of {moneyExact(allocation.base)} — only the positions your target names, so
        card balances are always excluded and cash appears only if you give it a line. Fixed deposits
        are counted at <strong>principal</strong>: accrued interest is real and sits in total net
        worth, but it is not payable until maturity, so it is not something this table can tell you
        to move.
      </p>
      <p className="note">
        Removing a line from <code>target_allocation</code> in settings takes it out of this table
        <em>and</em> out of the denominator — the honest fix for EPF, which at a 0% target will always
        read as the largest drift here and is not money you can move.
      </p>
    </Card>
  )
}

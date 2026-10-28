import { useEffect, useMemo, useState } from 'react'

export const PAGE_SIZES = [10, 20, 50]

/**
 * Slices rows into pages, and hands back a control to move between them.
 *
 * Ten by default because a table you have to scroll past is a table you stop
 * reading. The control renders nothing when everything already fits — a pager
 * under a five-row table is furniture, not function.
 */
export function usePaged(rows, initialSize = PAGE_SIZES[0]) {
  const [size, setSize] = useState(initialSize)
  const [page, setPage] = useState(0)

  const pages = Math.max(1, Math.ceil(rows.length / size))

  // Filtering or re-sorting can leave you on a page that no longer exists, and
  // an empty table is a worse answer than the first page.
  useEffect(() => {
    if (page > pages - 1) setPage(0)
  }, [page, pages])
  useEffect(() => {
    setPage(0)
  }, [rows.length])

  const start = page * size
  const visible = useMemo(() => rows.slice(start, start + size), [rows, start, size])

  const pager =
    rows.length <= PAGE_SIZES[0] ? null : (
      <div className="pager">
        <span className="pager-count">
          {rows.length === 0 ? 'nothing to show' : `${start + 1}–${Math.min(start + size, rows.length)} of ${rows.length}`}
        </span>
        <span className="spacer" />
        <label className="pager-size">
          rows
          <select
            value={size}
            onChange={(e) => {
              setSize(Number(e.target.value))
              setPage(0)
            }}
          >
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </label>
        <button
          className="btn" onClick={() => setPage((p) => Math.max(0, p - 1))}
          disabled={page === 0} title="Previous page"
        >
          ‹
        </button>
        <span className="pager-page">{page + 1} / {pages}</span>
        <button
          className="btn" onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}
          disabled={page >= pages - 1} title="Next page"
        >
          ›
        </button>
      </div>
    )

  return { visible, pager, size, page }
}

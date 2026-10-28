import { useMemo, useState } from 'react'
import { num } from './format.js'

const isBlank = (v) => v === null || v === undefined || v === ''

/**
 * Compares two rows on one column, with blanks always last.
 *
 * A missing value is not a small one: a fixed deposit has no price, a holding
 * has no market/flow/fx until there is a second checkpoint, and a trade may
 * have no buy date. Sorting those as zero files them among the worst
 * performers. The direction applies to the values that exist.
 */
export function compare(a, b, key, numeric, dir, get) {
  // `get` lets a column read a nested field (a holding's foreign-currency
  // return lives under .foreign) without flattening the API response first.
  const pick = get || ((row) => row[key])
  const av = pick(a)
  const bv = pick(b)
  if (isBlank(av) && isBlank(bv)) return 0
  if (isBlank(av)) return 1
  if (isBlank(bv)) return -1
  const cmp = numeric ? num(av) - num(bv) : String(av).localeCompare(String(bv))
  return dir === 'asc' ? cmp : -cmp
}

/**
 * Sorting state for a table, plus the header cells that drive it.
 *
 * `columns` is [{ key, label, numeric, className }]. Text opens A-Z and numbers
 * open biggest-first, because that is what you wanted in each case.
 */
export function useSort(columns, initial) {
  const [sort, setSort] = useState(initial)

  const onSort = (key) =>
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === 'desc' ? 'asc' : 'desc' }
        : { key, dir: columns.find((c) => c.key === key)?.numeric ? 'desc' : 'asc' }
    )

  const sortRows = (rows) => {
    const col = columns.find((c) => c.key === sort.key) || columns[0]
    return [...rows].sort((a, b) => compare(a, b, col.key, col.numeric, sort.dir, col.get))
  }

  const headers = columns.map((c) => (
    <th
      key={c.key}
      className={c.className ?? (c.numeric ? 'num' : undefined)}
      aria-sort={sort.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button className="sort-btn" onClick={() => onSort(c.key)} title={`Sort by ${c.label}`}>
        {c.label}
        <span className="caret" aria-hidden="true">
          {sort.key === c.key ? (sort.dir === 'asc' ? '▲' : '▼') : '·'}
        </span>
      </button>
    </th>
  ))

  return { sort, onSort, sortRows, headers }
}

/** Memoised variant, for tables long enough that re-sorting on every render shows. */
export function useSortedRows(rows, columns, initial) {
  const { sort, sortRows, headers } = useSort(columns, initial)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const sorted = useMemo(() => sortRows(rows), [rows, sort])
  return { sorted, headers, sort }
}

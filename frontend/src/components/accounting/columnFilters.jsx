import { useCallback, useMemo, useState } from 'react';
import { OpFilter } from './reportControls';
import { numberFilterHit } from './reportModel';

// The filter box under every column heading (Charmi, 10/23; Neil, 10/22: "a
// search box at the top of every column, critical"), one piece for every
// Accounting table. It was MRE's and AMA's own code until 10/27; both now use
// this, with no change in what they do.
//
//   - A text column holds the words typed: each word must appear, any case,
//     in any order ("contains").
//   - An amount column (`num: true`) compares with =, >, <, >=, <= or Between
//     (OpFilter). "=" without a sign matches either sign, as in Ledger Search.
//   - The filters stack with each other and with whatever the screen filtered
//     before (search, entity, status...).
//   - A filter typed on a column that is not in the list given is ignored.
//
// How to use it on a table:
//
//   const COLUMNS = [
//     { key: 'vendor', label: 'Vendor', text: (r) => r.vendorName },
//     { key: 'amount', label: 'Amount', num: true, value: (r) => r.amount },
//     { key: 'date', label: 'Date', text: (r) => formatDate(r.date), placeholder: 'MM/DD/YYYY' },
//   ];
//   const filters = useColumnFilters(screenRows, COLUMNS);
//   const view = useTableView('my-table', viewColumns, filters.rows);  // Export follows the filters
//   ...
//   <table className="acct-report acct-sticky-head">   // the headings and the boxes pin as ONE block
//     <thead>
//       <tr>{view.columns.map(head)}</tr>
//       <ColumnFilterRow columns={view.columns} filterColumns={COLUMNS}
//         typed={filters.typed} onChange={filters.setFilter} />
//     </thead>
//
// `filters.filtering` says whether any box holds something (for a "Clear
// Column Filters" link, which calls `filters.clear()`); put `filters.typed` in
// a pager's reset key. Pin the whole <thead> (acct-sticky-head, or a table
// rule like .mre-grid thead), never each cell: per-cell sticky breaks with the
// column-resize handles (10/23 lesson). An amount column reads `value(r)` when
// it has one, else `text(r)`.

const opSet = (f) => !!f && typeof f === 'object' && !!(String(f.a ?? '').trim() || String(f.b ?? '').trim());
const textSet = (v) => typeof v === 'string' && !!v.trim();

/** Whether this column's box holds a filter. */
export const columnFilterSet = (col, value) => (col?.num ? opSet(value) : textSet(value));

/** Whether any of these columns' boxes holds a filter. */
export const columnFiltersActive = (columns, typed) => (columns || []).some((c) => columnFilterSet(c, typed?.[c.key]));

/** The rows every typed box lets through (text: every word appears, any case;
 *  amounts: the comparison). They stack. */
export function filterRowsByColumns(rows, typed = {}, columns = []) {
  const active = (columns || []).filter((c) => columnFilterSet(c, typed?.[c.key]));
  if (!active.length) return rows || [];
  return (rows || []).filter((r) => active.every((c) => {
    if (c.num) return numberFilterHit((c.value || c.text)(r), typed[c.key]);
    const hay = String(c.text(r) || '').toLowerCase();
    return typed[c.key].trim().toLowerCase().split(/\s+/).every((w) => hay.includes(w));
  }));
}

/** The boxes' state and the rows they let through. View only - nothing saved. */
export function useColumnFilters(rows, columns) {
  const [typed, setTyped] = useState({});
  const setFilter = useCallback((key, value) => setTyped((t) => ({ ...t, [key]: value })), []);
  const clear = useCallback(() => setTyped({}), []);
  const filtered = useMemo(() => filterRowsByColumns(rows, typed, columns), [rows, typed, columns]);
  return { typed, setFilter, clear, filtering: columnFiltersActive(columns, typed), rows: filtered };
}

/** The row of boxes under the headings, one cell per column shown (in the
 *  view's order). A column with no filter definition gets an empty cell.
 *  `cellProps(col)` adds a cell's className / style (a pinned first column). */
export function ColumnFilterRow({ columns, filterColumns = columns, typed = {}, onChange, cellProps = null }) {
  const byKey = new Map((filterColumns || []).map((c) => [c.key, c]));
  return (
    <tr className="acct-filter-row">
      {(columns || []).map((col) => {
        const c = byKey.get(col.key);
        return (
          <td key={col.key} {...(cellProps ? cellProps(col) : null)}>
            {!c ? null : c.num
              ? <OpFilter label={c.label} value={typed[c.key]} onChange={(v) => onChange(c.key, v)} />
              : <input type="text" value={typed[c.key] || ''} onChange={(e) => onChange(c.key, e.target.value)} aria-label={`Filter ${c.label}`} placeholder={c.placeholder || 'contains'} />}
          </td>
        );
      })}
    </tr>
  );
}

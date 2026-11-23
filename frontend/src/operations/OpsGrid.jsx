// Operations: the one table every list in the module draws with (Oct 28 2026
// call with Neil). The same controls everywhere (B5): Columns (show, hide,
// reorder), a header click to sort, a funnel to filter, Export as Excel, CSV
// or PDF (B8); the header row stays put while the lines scroll (B6). The
// person's arrangement is kept per table (opsPrefs.js) and follows them.
//
// columns: [{ key, label, cell(row) -> what to draw, value(row) -> the raw
//   value to sort, filter and export (optional: else the text the cell
//   draws), type: text | num | money | int | pct | date | area, num: right
//   aligned, fixed: 'start' | 'end' (always shown, never moved - a checkbox,
//   a row's link), sortable / filterable: false to switch off, width }]
// `money` values are cents (as the reports carry them); a column whose value
// is the drawn text ("$1,234.50") is read as a plain number in dollars.
import { Children, isValidElement, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { arrange, nextSort, shapeRows } from './columnControls';
import { ColumnsButton, ExportMenu, FilterLine, HeaderFilter } from './ColumnsMenu';
import { exportTable } from './ReportTable';
import { useOpsColumns } from './opsPrefs';

const NUM_TYPES = new Set(['num', 'money', 'int', 'pct', 'area']);

/** The words a rendered cell shows - strings, numbers, elements and simple
 *  function components (Tenant, a badge) walked down to their text. */
export function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement(node)) {
    if (typeof node.type === 'function') {
      try { return textOf(node.type(node.props)); } catch { return ''; }
    }
    return Children.toArray(node.props?.children).map(textOf).join('');
  }
  return '';
}

/** "$1,234.50" / "87.5%" / "12 days" -> 1234.5 / 87.5 / 12; null when none. */
export function numberOf(text) {
  const m = String(text ?? '').replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return String(text).trim().startsWith('-') || /^\(.*\)$/.test(String(text).trim()) ? -Math.abs(n) : n;
}

// Columns with a key, a label, a type and a value the controls can read.
function prepare(columns) {
  return columns.filter((c) => c.when !== false).map((c, i) => {
    const key = c.key || c.head || `col${i}`;
    const label = c.label ?? c.head ?? '';
    const type = c.type || (c.num ? 'num' : 'text');
    const read = c.value || (NUM_TYPES.has(type) && type !== 'money'
      ? (r) => numberOf(textOf(c.cell(r)))
      : (r) => textOf(c.cell(r)));
    return { ...c, key, label, type, value: read, fixed: c.fixed || (label ? null : 'end') };
  });
}

export default function OpsGrid({
  tableKey, title = 'List', columns, rows, rowKey, empty = 'Nothing to show.', limit = 0, label = 'rows',
  search = true, exportable = true, tools = null, where = '', asOf = '', className = '', stack = true,
  onRowClick, rowClass, footer = null, maxHeight, searchText = null,
}) {
  const [shape, setShape] = useOpsColumns(tableKey || `grid:${title}`);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [more, setMore] = useState(100);
  const all = useMemo(() => prepare(columns), [columns]);
  const movable = useMemo(() => all.filter((c) => !c.fixed), [all]);
  const visible = useMemo(() => [...all.filter((c) => c.fixed === 'start'), ...arrange(movable, shape), ...all.filter((c) => c.fixed === 'end')],
    [all, movable, shape]);
  const q = query.trim().toLowerCase();
  const found = useMemo(() => {
    const hit = q ? rows.filter((r) => (searchText && searchText(r).includes(q))
      || all.some((c) => String(c.value(r) ?? '').toLowerCase().includes(q))) : rows;
    return shapeRows(hit, movable, shape);
  }, [rows, all, movable, q, shape, searchText]);

  if (!rows.length) return <div className="ops-empty">{empty}</div>;
  const paged = limit > 0 && rows.length > limit;
  const pages = paged ? Math.max(1, Math.ceil(found.length / limit)) : 1;
  const at = Math.min(page, pages - 1);
  const shown = paged ? found.slice(at * limit, at * limit + limit) : found.slice(0, more);
  const sort = shape.sort;
  const setFilter = (key, f) => setShape((s) => {
    const next = { ...s.filters };
    if (f) next[key] = f; else delete next[key];
    return { ...s, filters: next };
  });
  const exportRows = (format) => exportTable(format, {
    title, where, asOf,
    columns: visible.filter((c) => c.label).map((c) => ({ key: c.key, label: c.label, type: c.type === 'money' ? 'money' : NUM_TYPES.has(c.type) ? 'num' : c.type === 'date' ? 'date' : 'text' })),
    rows: found.map((r) => Object.fromEntries(visible.filter((c) => c.label).map((c) => [c.key, c.value(r)]))),
  }).catch((err) => console.error('Operations list export failed', err));

  return (
    <div className={`ops-grid ${className}`}>
      <div className="ops-table-tools">
        {search && rows.length > (limit || 8) ? (
          <label className="ops-search" style={{ marginBottom: 0, flex: '1 1 200px' }}>
            <Search size={14} aria-hidden="true" />
            <input type="search" value={query} placeholder={`Search ${rows.length.toLocaleString('en-US')} ${label}`} aria-label={`Search ${label}`}
              onChange={(e) => { setQuery(e.target.value); setPage(0); }} />
          </label>
        ) : <span />}
        <div className="ops-table-tools-r">
          {tools}
          <ColumnsButton columns={movable} shape={shape} onShape={setShape} />
          {exportable && <ExportMenu onPick={exportRows} disabled={!found.length} ariaLabel={`Export ${title}`} />}
        </div>
      </div>
      <FilterLine columns={movable} shape={shape} onShape={setShape} shown={found.length} total={rows.length} />
      {shown.length ? (
        <div className="req-table-wrapper ops-scroll" style={maxHeight ? { maxHeight } : undefined}>
          <table className={`req-table ops-sticky${stack ? ' stack-table' : ''}`}>
            <thead>
              <tr>
                {visible.map((c) => {
                  const active = sort?.key === c.key;
                  const canSort = c.label && c.sortable !== false && !c.fixed;
                  return (
                    <th key={c.key} className={c.num || NUM_TYPES.has(c.type) ? 'num' : undefined} style={c.width ? { width: c.width } : undefined}
                      aria-sort={active ? (sort.desc ? 'descending' : 'ascending') : undefined}>
                      {canSort ? (
                        <span className="ops-th">
                          <button type="button" className="ops-sort" onClick={() => setShape((s) => ({ ...s, sort: nextSort(s.sort, c.key) }))}>
                            {c.label}
                            {active && (sort.desc ? <ArrowDown size={12} aria-hidden="true" /> : <ArrowUp size={12} aria-hidden="true" />)}
                          </button>
                          {c.filterable !== false && <HeaderFilter col={c} rows={rows} filter={shape.filters[c.key]} onChange={(f) => setFilter(c.key, f)} />}
                        </span>
                      ) : (c.headCell || c.label || <span className="sr-only">Actions</span>)}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {shown.map((r, i) => (
                <tr key={rowKey ? rowKey(r) : `${at}-${i}`} className={rowClass ? rowClass(r) : undefined}
                  onClick={onRowClick ? () => onRowClick(r) : undefined} style={onRowClick ? { cursor: 'pointer' } : undefined}>
                  {visible.map((c) => (
                    <td key={c.key} data-th={c.label} className={c.num || NUM_TYPES.has(c.type) ? 'num' : undefined}>{c.cell(r)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
            {footer && <tfoot>{footer(visible)}</tfoot>}
          </table>
        </div>
      ) : <div className="ops-empty">Nothing matches{q ? ` "${query.trim()}"` : ' the filters'}.</div>}
      {paged && (
        <div className="ops-pager">
          <span aria-live="polite">
            {found.length ? `${(at * limit + 1).toLocaleString('en-US')}-${(at * limit + shown.length).toLocaleString('en-US')} of ${found.length.toLocaleString('en-US')}` : '0 results'}
            {found.length !== rows.length ? ` (${rows.length.toLocaleString('en-US')} in all)` : ''}
          </span>
          <span className="ops-pager-btns">
            <button type="button" className="secondary-btn" onClick={() => setPage(at - 1)} disabled={at === 0} aria-label={`Previous ${label}`}><ChevronLeft size={15} aria-hidden="true" /></button>
            <button type="button" className="secondary-btn" onClick={() => setPage(at + 1)} disabled={at >= pages - 1} aria-label={`Next ${label}`}><ChevronRight size={15} aria-hidden="true" /></button>
          </span>
        </div>
      )}
      {!paged && found.length > more && (
        <div className="ops-pager">
          <span>Showing {more.toLocaleString('en-US')} of {found.length.toLocaleString('en-US')}</span>
          <button type="button" className="secondary-btn" onClick={() => setMore((n) => n + 500)}>Show More</button>
        </div>
      )}
    </div>
  );
}

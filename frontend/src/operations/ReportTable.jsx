// Operations > Reports: one report as a table - sort by any column, search
// every cell, page through long lists, open a tenant or a unit, expand a line
// into the lines behind it, and export exactly what is shown.
// Oct 28 2026 call with Neil: the same column controls as every table in the
// module (B5 - show / hide, reorder, sort, filter; columnControls.js), the
// header row stays put while the lines scroll (B6), and Export asks the
// format (B8). The arrangement is the person's own (opsPrefs.js), or the
// caller's when it passes `shape` / `onShape` (a report, a memorized report).
import { Fragment, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Search } from 'lucide-react';
import { csvName, downloadCsv } from './csv';
import { NUMERIC_TYPES, cellText, matches, toCsvRows } from './reportFormat';
import { arrange, nextSort, shapeRows } from './columnControls';
import { ColumnsButton, ExportMenu, FilterLine, HeaderFilter } from './ColumnsMenu';
import { useOpsColumns } from './opsPrefs';

const PAGE = 100;

function Cell({ col, row, onDrill }) {
  const text = cellText(row[col.key], col.type);
  if (onDrill && text && col.type === 'tenant' && row._c) {
    return <button type="button" className="ops-cell" onClick={() => onDrill('tenant', row._f, row._c)}>{text}</button>;
  }
  if (onDrill && text && col.type === 'unit' && row._u) {
    return <button type="button" className="ops-cell" onClick={() => onDrill('unit', row._f, row._u)}>{text}</button>;
  }
  return text;
}

/** The lines on screen as a file, in the browser (a report's own Export goes
 *  through the server, which writes the same columns). */
export async function exportTable(format, { title, where, asOf, columns, rows }) {
  const name = csvName(title, where, asOf);
  if (format === 'csv') return downloadCsv(name, columns.map((c) => c.label), toCsvRows(columns, rows));
  const { exportExcel, exportPdf } = await import('../tasks/exporting');
  const cols = columns.map((c) => ({
    header: c.label,
    get: (r) => {
      const v = r[c.key];
      if (v === null || v === undefined || v === '') return '';
      if (c.type === 'money') return Number(v) / 100;
      if (NUMERIC_TYPES.has(c.type)) return Number(v);
      return cellText(v, c.type);
    },
    display: (r) => cellText(r[c.key], c.type),
    z: c.type === 'money' ? '$#,##0.00' : undefined,
    width: Math.max(12, c.label.length + 2),
  }));
  const file = name.replace(/\.csv$/i, `.${format}`);
  if (format === 'xlsx') return exportExcel({ filename: file, title, columns: cols, rows });
  return exportPdf({ filename: file, title, subtitle: [where, asOf ? cellText(asOf, 'date') : ''].filter(Boolean).join(' - '), columns: cols, rows });
}

// `exportable` false where the page has its own Export (a report from the
// library exports through the server). `tableKey` keeps the person's columns
// for a table the caller does not control.
export default function ReportTable({
  title, where, asOf, columns, rows, totals, groups, onDrill, exportable = true, csv, tableKey,
  shape: shapeProp, onShape: onShapeProp, presets = null, tools = null,
  empty = 'Nothing in this report for the facility and period picked.',
}) {
  const [own, setOwn] = useOpsColumns(tableKey || `report-table:${title}`);
  const shape = shapeProp || own;
  const onShape = onShapeProp || setOwn;
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [open, setOpen] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const canExport = csv === undefined ? exportable : csv;

  const visible = useMemo(() => arrange(columns, shape), [columns, shape]);
  const shown = useMemo(() => shapeRows(rows.filter((r) => matches(r, columns, q)), columns, shape), [rows, columns, q, shape]);
  const filtered = q || Object.keys(shape.filters).length > 0;
  // Filtered lines get a total of their own; the whole report keeps the server's.
  const shownTotals = useMemo(() => {
    if (!filtered || !totals) return totals;
    const out = {};
    columns.forEach((c) => { if (c.total) out[c.key] = shown.reduce((a, r) => a + (Number(r[c.key]) || 0), 0); });
    return out;
  }, [filtered, totals, columns, shown]);

  const toggleSort = (key) => onShape((s) => ({ ...s, sort: nextSort(s.sort, key) }));
  const setFilter = (key, f) => onShape((s) => {
    const next = { ...s.filters };
    if (f) next[key] = f; else delete next[key];
    return { ...s, filters: next };
  });
  const toggleOpen = (key) => setOpen((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const hasSubs = rows.some((r) => r._sub);
  const hasTotals = shownTotals && visible.some((c) => shownTotals[c.key] !== undefined && shownTotals[c.key] !== null && NUMERIC_TYPES.has(c.type));
  const sort = shape.sort;

  const doExport = async (format) => {
    setBusy(true);
    try { await exportTable(format, { title, where, asOf, columns: visible, rows: shown }); } catch (err) {
      console.error('Operations table export failed', err);
    } finally { setBusy(false); }
  };

  return (
    <div>
      <div className="ops-table-tools">
        <label className="ops-search" style={{ marginBottom: 0, flex: '1 1 220px' }}>
          <Search size={14} aria-hidden="true" />
          <input type="search" value={q} placeholder="Search this report" aria-label={`Search ${title}`}
            onChange={(e) => { setQ(e.target.value); setLimit(PAGE); }} />
        </label>
        <div className="ops-table-tools-r">
          <span className="ops-note" style={{ margin: 0 }}>{shown.length.toLocaleString('en-US')} {shown.length === 1 ? 'line' : 'lines'}</span>
          {tools}
          <ColumnsButton columns={columns} shape={shape} onShape={onShape} presets={presets}
            canAdd={{ unit: rows.some((r) => r._u), tenant: rows.some((r) => r._c) }} />
          {canExport && <ExportMenu onPick={doExport} busy={busy} disabled={!shown.length} />}
        </div>
      </div>
      <FilterLine columns={columns} shape={shape} onShape={onShape} shown={shown.length} total={rows.length} />
      {!rows.length ? <div className="ops-empty">{empty}</div> : (
        <div className="req-table-wrapper ops-scroll">
          <table className="req-table ops-rtable ops-sticky">
            <thead>
              <tr>
                {hasSubs && <th aria-label="Details" style={{ width: 28 }} />}
                {visible.map((c) => {
                  const active = sort?.key === c.key;
                  return (
                    <th key={c.key} className={NUMERIC_TYPES.has(c.type) ? 'num' : ''}
                      aria-sort={active ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
                      <span className="ops-th">
                        <button type="button" className="ops-sort" onClick={() => toggleSort(c.key)}>
                          {c.label}
                          {active && (sort.desc ? <ArrowDown size={12} aria-hidden="true" /> : <ArrowUp size={12} aria-hidden="true" />)}
                        </button>
                        <HeaderFilter col={c} rows={rows} filter={shape.filters[c.key]} onChange={(f) => setFilter(c.key, f)} />
                      </span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {shown.slice(0, limit).map((r, i) => {
                const subKey = r._sub;
                const isOpen = subKey && open.has(subKey);
                const sub = subKey ? groups?.[subKey] : null;
                return (
                  <Fragment key={subKey || i}>
                    <tr>
                      {hasSubs && (
                        <td>
                          {sub && (
                            <button type="button" className="ops-x" aria-expanded={!!isOpen} aria-label={isOpen ? 'Hide the lines behind this' : 'Show the lines behind this'}
                              onClick={() => toggleOpen(subKey)}>
                              {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                            </button>
                          )}
                        </td>
                      )}
                      {visible.map((c) => (
                        <td key={c.key} className={NUMERIC_TYPES.has(c.type) ? 'num' : ''}><Cell col={c} row={r} onDrill={onDrill} /></td>
                      ))}
                    </tr>
                    {isOpen && sub && (
                      <tr className="ops-subrow">
                        <td colSpan={visible.length + 1}>
                          <table className="req-table">
                            <thead><tr>{sub.columns.map((c) => <th key={c.key} className={NUMERIC_TYPES.has(c.type) ? 'num' : ''}>{c.label}</th>)}</tr></thead>
                            <tbody>
                              {sub.rows.map((s, j) => (
                                <tr key={j}>{sub.columns.map((c) => <td key={c.key} className={NUMERIC_TYPES.has(c.type) ? 'num' : ''}><Cell col={c} row={s} onDrill={onDrill} /></td>)}</tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
            {hasTotals && (
              <tfoot>
                <tr className="ops-total">
                  {hasSubs && <td />}
                  {visible.map((c, i) => (
                    <td key={c.key} className={NUMERIC_TYPES.has(c.type) ? 'num' : ''}>
                      {NUMERIC_TYPES.has(c.type) && c.total !== false ? cellText(shownTotals[c.key], c.type)
                        : (i === 0 ? (typeof shownTotals[c.key] === 'string' ? shownTotals[c.key] : filtered ? 'Total Shown' : 'Total') : '')}
                    </td>
                  ))}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
      {shown.length > limit && (
        <div className="ops-pager">
          <span>Showing {limit.toLocaleString('en-US')} of {shown.length.toLocaleString('en-US')}</span>
          <button type="button" className="secondary-btn" onClick={() => setLimit((n) => n + PAGE * 5)}>Show More</button>
        </div>
      )}
    </div>
  );
}

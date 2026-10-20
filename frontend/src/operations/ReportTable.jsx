// Operations > Reports: one report as a table - sort by any column, search
// every cell, page through long lists, open a tenant or a unit, expand a line
// into the lines behind it, and save exactly what is shown as a CSV.
import { Fragment, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Download, Search } from 'lucide-react';
import { csvName, downloadCsv } from './csv';
import { NUMERIC_TYPES, cellText, matches, sortRows, toCsvRows } from './reportFormat';

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

// `csv` false where the page has its own Download menu (the report library view).
export default function ReportTable({ title, where, asOf, columns, rows, totals, groups, onDrill, csv = true, empty = 'Nothing in this report for the facility and period picked.' }) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState(null);
  const [limit, setLimit] = useState(PAGE);
  const [open, setOpen] = useState(() => new Set());

  const shown = useMemo(() => {
    const hit = rows.filter((r) => matches(r, columns, q));
    if (!sort) return hit;
    const col = columns.find((c) => c.key === sort.key);
    return sortRows(hit, sort.key, sort.desc, col?.type);
  }, [rows, columns, q, sort]);

  const toggleSort = (key) => setSort((s) => (s?.key === key ? (s.desc ? null : { key, desc: true }) : { key, desc: false }));
  const toggleOpen = (key) => setOpen((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const hasSubs = rows.some((r) => r._sub);
  const hasTotals = totals && columns.some((c) => totals[c.key] !== undefined && totals[c.key] !== null && NUMERIC_TYPES.has(c.type));

  const exportCsv = () => downloadCsv(csvName(title, where, asOf), columns.map((c) => c.label), toCsvRows(columns, shown));

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
        <label className="ops-search" style={{ marginBottom: 0, flex: '1 1 220px' }}>
          <Search size={14} aria-hidden="true" />
          <input type="search" value={q} placeholder="Search this report" aria-label={`Search ${title}`}
            onChange={(e) => { setQ(e.target.value); setLimit(PAGE); }} />
        </label>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
          <span className="ops-note" style={{ margin: 0 }}>{shown.length.toLocaleString('en-US')} {shown.length === 1 ? 'line' : 'lines'}</span>
          {csv && (
            <button type="button" className="secondary-btn" onClick={exportCsv} disabled={!shown.length}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} aria-label={`Download ${title} as a spreadsheet`}>
              <Download size={14} aria-hidden="true" /> Download CSV
            </button>
          )}
        </div>
      </div>
      {!rows.length ? <div className="ops-empty">{empty}</div> : (
        <div className="req-table-wrapper" style={{ overflowX: 'auto' }}>
          <table className="req-table ops-rtable">
            <thead>
              <tr>
                {hasSubs && <th aria-label="Details" style={{ width: 28 }} />}
                {columns.map((c) => {
                  const active = sort?.key === c.key;
                  return (
                    <th key={c.key} className={NUMERIC_TYPES.has(c.type) ? 'num' : ''}
                      aria-sort={active ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
                      <button type="button" className="ops-sort" onClick={() => toggleSort(c.key)}>
                        {c.label}
                        {active && (sort.desc ? <ArrowDown size={12} aria-hidden="true" /> : <ArrowUp size={12} aria-hidden="true" />)}
                      </button>
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
                      {columns.map((c) => (
                        <td key={c.key} className={NUMERIC_TYPES.has(c.type) ? 'num' : ''}><Cell col={c} row={r} onDrill={onDrill} /></td>
                      ))}
                    </tr>
                    {isOpen && sub && (
                      <tr className="ops-subrow">
                        <td colSpan={columns.length + 1}>
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
            {hasTotals && !q && (
              <tfoot>
                <tr className="ops-total">
                  {hasSubs && <td />}
                  {columns.map((c, i) => (
                    <td key={c.key} className={NUMERIC_TYPES.has(c.type) ? 'num' : ''}>
                      {NUMERIC_TYPES.has(c.type) ? cellText(totals[c.key], c.type) : (i === 0 ? (typeof totals[c.key] === 'string' ? totals[c.key] : 'Total') : '')}
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

import { useState, useEffect } from 'react';
import { ChevronDown, Plus } from 'lucide-react';
import { RECORD_TYPES } from '../../lib/recordTypes.jsx';
import { Card } from './Card.jsx';
import { EmptyState } from './EmptyState.jsx';

// Monospace font stack for numeric/date table cells and summary-strip values.
const MONO_FONT = "ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace";

// Small uppercase label style - shared by column headers and summary-strip labels.
const LABEL_STYLE = { fontSize: '0.64rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-secondary)' };

// Quick-add config per collection: which field the single text input fills, extra defaults
// merged into the new record, and the input's placeholder/button copy. Only collections with
// an entry here render the quick-add bar (currently maintenance + vservice - see
// RECORD_TYPES[coll].quickAdd in lib/recordTypes.js, which this is built from).
const QUICK_ADD_CONFIG = Object.fromEntries(
  Object.entries(RECORD_TYPES)
    .filter(([, rt]) => rt.quickAdd)
    .map(([coll, rt]) => [coll, rt.quickAdd])
);

/** Returns a plain-text representation of a cell for sorting/searching: prefer the "main"
 *  renderer, then "mono", then "plain" - chip-only columns (status badges) have nothing to sort by. */
function cellText(col, row) {
  const v = col.main ? col.main(row) : col.mono ? col.mono(row) : col.plain ? col.plain(row) : '';
  return v == null ? '' : String(v);
}

/** "docFileName" -> "Doc File Name" - used to humanize raw object keys into CSV/PDF export headers. */
function humanizeKey(key) {
  return key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
}

function csvEscape(v) {
  v = v == null ? '' : String(v);
  return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

function htmlEscape(v) {
  return String(v == null ? '' : v).replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}

/** Downloads `rows` as a CSV file named "{assetName} - {collection plural}.csv". Column set is
 *  the union of keys present across all rows (minus id/propertyId, which are internal). */
function exportCsv(rows, recordType, assetName) {
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((k) => !['id', 'propertyId'].includes(k));
  const head = keys.map(humanizeKey).join(',');
  const body = rows.map((r) => keys.map((k) => csvEscape(r[k])).join(',')).join('\n');
  const blob = new Blob([head + '\n' + body], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = (assetName || 'export') + ' - ' + recordType.plural + '.csv';
  a.click();
  URL.revokeObjectURL(url);
}

/** Opens a print-ready HTML table of `rows` in a new tab and triggers the print dialog.
 *  docFile is excluded (raw base64 would bloat/break the printed table). */
function exportPdf(rows, recordType, assetName) {
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((k) => !['id', 'propertyId', 'docFile'].includes(k));
  const headers = keys.map(humanizeKey);
  const title = (assetName || 'Export') + ' - ' + recordType.plural;
  const bodyRows = rows.map((r) => '<tr>' + keys.map((k) => '<td>' + htmlEscape(r[k]) + '</td>').join('') + '</tr>').join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${htmlEscape(title)}</title><style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;padding:28px;color:#111}h1{font-size:17px;margin:0 0 14px}table{border-collapse:collapse;width:100%;font-size:11.5px}th,td{border:1px solid #d1d5db;padding:6px 9px;text-align:left;vertical-align:top}th{background:#f3f4f6;font-weight:700}</style></head><body><h1>${htmlEscape(
    title
  )}</h1><table><thead><tr>${headers.map((h) => '<th>' + htmlEscape(h) + '</th>').join('')}</tr></thead><tbody>${bodyRows}</tbody></table></body></html>`;
  const win = window.open('', '_blank');
  if (win) {
    win.document.write(html);
    win.document.close();
    // Give the new tab a beat to lay out the document before invoking print(), otherwise some
    // browsers print a blank page.
    setTimeout(() => {
      try {
        win.focus();
        win.print();
      } catch {
        // popup could have been closed already - nothing to do
      }
    }, 350);
  }
}

/** Row identity string used to match `highlightItem` against a rendered row (built from the
 *  first column's own renderer, so it stays meaningful even without touching row.id directly). */
function rowIdentity(coll, row) {
  const col = RECORD_TYPES[coll].cols[0];
  return (col.main ? col.main(row) : col.mono ? col.mono(row) : '') || RECORD_TYPES[coll].title;
}

/**
 * Generic list/table for any RECORD_TYPES collection. Renders (top to bottom): an optional
 * collapse header, an optional quick-add bar, a summary stat strip, and either a sortable table
 * or an empty state. The table collapses into stacked labeled cards below 640px via the
 * `.coll-table` CSS class (see styles.css) reading each `<td data-label="...">`.
 *
 * Props: coll (record-type key), rows, active (the asset these records belong to - used for
 * export filenames), filters (map of coll -> free-text search string), onAdd, onEdit,
 * highlightItem (a row-identity string to scroll to + highlight), collapsible, onQuickAdd.
 */
export function CollectionTable({ coll, rows, active, filters, onAdd, onEdit, highlightItem, collapsible, onQuickAdd }) {
  const recordType = RECORD_TYPES[coll];
  const [exportOpen, setExportOpen] = useState(false);
  const [quickText, setQuickText] = useState('');
  const [quickDate, setQuickDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [open, setOpen] = useState(false);
  const [sortCol, setSortCol] = useState(null);
  const [sortDir, setSortDir] = useState(1);

  // If something elsewhere in the app deep-links to a specific row (highlightItem) inside a
  // collapsible section, auto-expand so the highlighted row is actually visible.
  useEffect(() => {
    if (collapsible && highlightItem) setOpen(true);
  }, [collapsible, highlightItem]);

  const contentVisible = !collapsible || open;
  const searchText = (filters[coll] || '').toLowerCase();

  let displayRows = rows.slice().sort(
    sortCol == null
      ? recordType.sort
      : (a, b) => {
          const at = cellText(recordType.cols[sortCol], a);
          const bt = cellText(recordType.cols[sortCol], b);
          const an = parseFloat(at.replace(/[^0-9.-]/g, ''));
          const bn = parseFloat(bt.replace(/[^0-9.-]/g, ''));
          const cmp = !isNaN(an) && !isNaN(bn) && /\d/.test(at) && /\d/.test(bt) ? an - bn : at.localeCompare(bt);
          return cmp * sortDir;
        }
  );
  if (searchText) {
    displayRows = displayRows.filter((r) => JSON.stringify(r).toLowerCase().includes(searchText));
  }

  // Summary strip always reflects the FULL collection (rows), not the filtered/sorted displayRows.
  const summary = recordType.summary ? recordType.summary(rows) : null;
  const quickAdd = QUICK_ADD_CONFIG[coll];

  const submitQuickAdd = () => {
    if (!quickText.trim()) return;
    onQuickAdd({ date: quickDate, [quickAdd.k]: quickText.trim(), ...quickAdd.extra });
    setQuickText('');
  };

  return (
    <Card>
      <div
        onClick={collapsible ? () => setOpen((o) => !o) : undefined}
        title={collapsible ? (open ? 'Collapse' : 'Expand') : undefined}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          marginBottom: contentVisible ? 14 : 0,
          flexWrap: 'wrap',
          cursor: collapsible ? 'pointer' : 'default',
          userSelect: collapsible ? 'none' : 'auto',
        }}
      >
        {collapsible && (
          <ChevronDown size={18} style={{ color: 'var(--text-secondary)', transition: 'transform 0.2s', transform: open ? 'rotate(0deg)' : 'rotate(-90deg)' }} />
        )}
        <strong style={{ fontSize: '1rem', fontFamily: "'Plus Jakarta Sans', sans-serif" }}>{recordType.plural}</strong>

        <div style={{ marginLeft: 'auto', position: 'relative' }}>
          <button
            className="secondary-btn"
            disabled={!displayRows.length}
            onClick={(e) => {
              e.stopPropagation();
              setExportOpen((v) => !v);
            }}
            title="Export this list"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 13px', fontSize: '0.8rem', opacity: displayRows.length ? 1 : 0.5 }}
          >
            {'⤓ Export ▾'}
          </button>
          {exportOpen && (
            <div
              onMouseLeave={() => setExportOpen(false)}
              style={{
                position: 'absolute',
                right: 0,
                top: 'calc(100% + 4px)',
                zIndex: 60,
                backgroundColor: 'var(--bg-card)',
                border: '1px solid var(--border-color)',
                borderRadius: 9,
                boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
                overflow: 'hidden',
                minWidth: 150,
              }}
            >
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setExportOpen(false);
                  exportCsv(displayRows, recordType, active.name);
                }}
                style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 13px', border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '0.82rem', color: 'var(--text-primary)' }}
              >
                Export as CSV
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setExportOpen(false);
                  exportPdf(displayRows, recordType, active.name);
                }}
                style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 13px', border: 'none', borderTop: '1px solid var(--border-color)', background: 'transparent', cursor: 'pointer', fontSize: '0.82rem', color: 'var(--text-primary)' }}
              >
                Export as PDF
              </button>
            </div>
          )}
        </div>

        <button
          className="primary-btn"
          onClick={(e) => {
            e.stopPropagation();
            onAdd();
          }}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px', fontSize: '0.8rem' }}
        >
          <Plus size={14} /> Add
        </button>
      </div>

      {contentVisible && (
        <>
          {quickAdd && onQuickAdd && (
            <div
              style={{
                display: 'flex',
                gap: 8,
                marginBottom: 14,
                flexWrap: 'wrap',
                alignItems: 'center',
                padding: '10px 12px',
                borderRadius: 11,
                border: '1px solid var(--border-color)',
                backgroundColor: 'var(--bg-secondary)',
              }}
            >
              <span style={{ fontSize: '1.05rem', flexShrink: 0 }}>{'\u{1F6E0}️'}</span>
              <input
                className="form-input"
                value={quickText}
                onChange={(e) => setQuickText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitQuickAdd();
                }}
                placeholder={quickAdd.placeholder}
                style={{ flex: '1 1 240px', fontSize: '0.85rem' }}
              />
              <input
                type="date"
                className="form-input"
                value={quickDate}
                onChange={(e) => setQuickDate(e.target.value)}
                title="Date"
                style={{ fontSize: '0.82rem', width: 146, flexShrink: 0 }}
              />
              <button
                className="primary-btn"
                disabled={!quickText.trim()}
                onClick={submitQuickAdd}
                style={{ fontSize: '0.82rem', padding: '8px 16px', flexShrink: 0, opacity: quickText.trim() ? 1 : 0.5 }}
              >
                {quickAdd.button}
              </button>
            </div>
          )}

          {summary && (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
              {summary.map(([label, value]) => (
                <div
                  key={label}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', borderRadius: 10, border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-secondary)' }}
                >
                  <span style={{ fontFamily: MONO_FONT, fontWeight: 700, fontSize: '1.05rem', color: 'var(--text-primary)' }}>{value}</span>
                  <span style={LABEL_STYLE}>{label}</span>
                </div>
              ))}
            </div>
          )}

          {displayRows.length ? (
            <div style={{ border: '1px solid var(--border-color)', borderRadius: 10, overflow: 'hidden', overflowX: 'auto' }}>
              <table className="coll-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
                <thead>
                  <tr>
                    {recordType.cols.map((col, ci) => (
                      <th
                        key={col.label}
                        onClick={() => {
                          if (sortCol === ci) setSortDir((d) => -d);
                          else {
                            setSortCol(ci);
                            setSortDir(1);
                          }
                        }}
                        style={{ ...LABEL_STYLE, textAlign: 'left', padding: '10px 12px', background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border-color)', whiteSpace: 'nowrap', cursor: 'pointer', userSelect: 'none' }}
                      >
                        {col.label}
                        {sortCol === ci ? (
                          <span style={{ marginLeft: 4, fontSize: '0.7em', color: 'hsl(var(--color-blue))' }}>{sortDir > 0 ? '▲' : '▼'}</span>
                        ) : null}
                      </th>
                    ))}
                    <th style={{ background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border-color)' }} />
                  </tr>
                </thead>
                <tbody>
                  {displayRows.map((row) => {
                    const isHighlighted = highlightItem && rowIdentity(coll, row) === highlightItem;
                    return (
                      <tr
                        key={row.id}
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') onEdit(row.id);
                        }}
                        onClick={() => onEdit(row.id)}
                        ref={isHighlighted ? (el) => el && el.scrollIntoView({ behavior: 'smooth', block: 'center' }) : null}
                        style={{
                          cursor: 'pointer',
                          transition: 'background-color 0.3s',
                          background: isHighlighted ? 'hsla(var(--color-gold), 0.2)' : '',
                          boxShadow: isHighlighted ? 'inset 3px 0 0 hsl(var(--color-gold))' : 'none',
                        }}
                        onMouseEnter={(e) => {
                          if (!isHighlighted) e.currentTarget.style.background = 'var(--bg-secondary)';
                        }}
                        onMouseLeave={(e) => {
                          if (!isHighlighted) e.currentTarget.style.background = '';
                        }}
                      >
                        {recordType.cols.map((col) => (
                          <td key={col.label} data-label={col.label} style={{ padding: '10px 12px', borderBottom: '1px solid var(--border-color)', verticalAlign: 'top' }}>
                            {col.main ? (
                              <>
                                <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{col.main(row) || '-'}</div>
                                {col.sub && col.sub(row) ? <div style={{ fontSize: '0.74rem', color: 'var(--text-secondary)', marginTop: 1 }}>{col.sub(row)}</div> : null}
                              </>
                            ) : col.mono ? (
                              <span style={{ fontFamily: MONO_FONT, fontSize: '0.78rem' }}>{col.mono(row)}</span>
                            ) : col.chip ? (
                              col.chip(row)
                            ) : (
                              <span>{col.plain(row)}</span>
                            )}
                          </td>
                        ))}
                        <td style={{ padding: '10px 12px', borderBottom: '1px solid var(--border-color)', textAlign: 'right' }}>
                          <button
                            className="secondary-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              onEdit(row.id);
                            }}
                            style={{ padding: '4px 10px', fontSize: '0.74rem' }}
                          >
                            Edit
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState>{recordType.empty}</EmptyState>
          )}
        </>
      )}
    </Card>
  );
}

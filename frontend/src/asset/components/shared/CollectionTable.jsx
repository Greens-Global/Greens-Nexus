import { useState, useRef } from 'react';
import { ChevronDown, ChevronUp, Plus, Download, CornerDownRight, FileSpreadsheet, FileText, ListPlus } from 'lucide-react';
import AnchoredMenu from '../../../components/AnchoredMenu';
import { RECORD_TYPES, pairsSentence } from '../../lib/recordTypes.jsx';
import { EmptyState } from './EmptyState.jsx';
import { MenuRow } from './MenuRow.jsx';
import { SummarySentence, ToolbarSearch, QuickAddLine, SR_ONLY } from './Toolbar.jsx';

// Quick-add config per collection: which field the single text input fills, extra defaults
// merged into the new record, and the input's placeholder/button copy. Only collections with
// an entry here render the quick-add line (currently maintenance + vservice - see
// RECORD_TYPES[coll].quickAdd in lib/recordTypes.js, which this is built from).
const QUICK_ADD_CONFIG = Object.fromEntries(
  Object.entries(RECORD_TYPES)
    .filter(([, rt]) => rt.quickAdd)
    .map(([coll, rt]) => [coll, rt.quickAdd])
);

/** Returns a plain-text representation of a cell for sorting/searching: prefer the "main"
 *  renderer, then "mono", then "plain" - chip-only columns (status badges) have nothing to sort by. */
function cellText(col, row, active) {
  const v = col.main ? col.main(row, active) : col.mono ? col.mono(row, active) : col.plain ? col.plain(row, active) : '';
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
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${htmlEscape(title)}</title><style>/* type-ok: printed page */body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;padding:28px;color:#111}h1{font-size:17px;margin:0 0 14px}table{border-collapse:collapse;width:100%;font-size:11.5px}th,td{border:1px solid #d1d5db;padding:6px 9px;text-align:left;vertical-align:top}th{background:#f3f4f6;font-weight:700}</style></head><body><h1>${htmlEscape(
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


const TH = { textAlign: 'left', padding: 0, fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-color)', whiteSpace: 'nowrap' };
const TD = { padding: '10px 12px', borderBottom: '1px solid var(--border-color)', verticalAlign: 'top' };
const FAINT = { color: 'var(--text-muted)' };

/**
 * Generic list/table for any RECORD_TYPES collection (Neil, 11/17/2026 redesign). Top to
 * bottom: the toolbar row (the summary sentence on the left; search, Export and New on the
 * right), an optional one-line quick add, and a hairline table - or a designed empty state.
 * The table folds into labeled cards below 640px via `.coll-table` (asset-styles) reading
 * each `<td data-label>`.
 *
 * Props: coll (record-type key), rows, active (the asset - export filenames), filters (map of
 * coll -> search text) + setFilters, onAdd, onEdit, highlightItem (a row-identity string to
 * scroll to and mark), onQuickAdd.
 */
// Optional (Property Tickets, Oct 2026): a row with `_parentRowId` is shown nested, right under
// that row (sorting and search move families together); `_readOnly` rows say View, not Edit.
// `summaryOverride` ([label, value] pairs) replaces the record type's sentence (e.g. totals kept
// per currency). `leadColumn` ({ label, render(row) }) adds a first column; nested rows indent.
// `toolbarStart` is a node at the toolbar's left, before the sentence (a section's own tabs).
export function CollectionTable({ coll, rows, active, filters = {}, setFilters, onAdd, onEdit, highlightItem, onQuickAdd, summaryOverride = null, leadColumn = null, emptyNode = null, toolbarStart = null }) {
  const recordType = RECORD_TYPES[coll];
  const [exportOpen, setExportOpen] = useState(false);
  const exportRef = useRef(null);   // the Export button its menu is pinned to
  const [sortCol, setSortCol] = useState(null);
  const [sortDir, setSortDir] = useState(1);
  const [localQuery, setLocalQuery] = useState('');
  const query = setFilters ? (filters[coll] || '') : localQuery;
  const setQuery = (text) => (setFilters ? setFilters((f) => ({ ...f, [coll]: text })) : setLocalQuery(text));
  const searchText = query.toLowerCase();

  let displayRows = rows.slice().sort(
    sortCol == null
      ? recordType.sort
      : (a, b) => {
          const at = cellText(recordType.cols[sortCol], a, active);
          const bt = cellText(recordType.cols[sortCol], b, active);
          const an = parseFloat(at.replace(/[^0-9.-]/g, ''));
          const bn = parseFloat(bt.replace(/[^0-9.-]/g, ''));
          const cmp = !isNaN(an) && !isNaN(bn) && /\d/.test(at) && /\d/.test(bt) ? an - bn : at.localeCompare(bt);
          return cmp * sortDir;
        }
  );
  if (searchText) {
    displayRows = displayRows.filter((r) => JSON.stringify(r).toLowerCase().includes(searchText));
  }
  if (displayRows.some((r) => r._parentRowId)) {
    const shown = new Set(displayRows.map((r) => r.id));
    const kids = displayRows.filter((r) => r._parentRowId && shown.has(r._parentRowId));
    const kidIds = new Set(kids.map((r) => r.id));
    displayRows = displayRows.filter((r) => !kidIds.has(r.id)).flatMap((r) => [
      r, ...kids.filter((k) => k._parentRowId === r.id).sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')))
        .map((k) => ({ ...k, _nested: true })),
    ]);
  }

  // The sentence always reflects the FULL collection (rows), not the search.
  const sentence = summaryOverride ? pairsSentence(summaryOverride) : recordType.sentence ? recordType.sentence(rows, active) : [];
  const quickAdd = QUICK_ADD_CONFIG[coll];
  const noun = recordType.plural.toLowerCase();

  return (
    <div style={{ minWidth: 0 }}>
      {(rows.length > 0 || onAdd || toolbarStart) && (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '12px 0', minHeight: 32 }}>
        {toolbarStart}
        <div style={{ flex: '1 1 260px', minWidth: 0 }}>
          {sentence.length > 0 && <SummarySentence parts={sentence} />}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginLeft: 'auto' }}>
          {rows.length > 0 && <ToolbarSearch value={query} onChange={setQuery} placeholder={`Search ${noun}`} />}
          {/* The export menu is an AnchoredMenu: closes on Escape and on a tap
              outside, its rows are buttons the keyboard reaches. */}
          {rows.length > 0 && (
            <>
              <button ref={exportRef} type="button" className="secondary-btn" disabled={!displayRows.length}
                aria-haspopup="menu" aria-expanded={exportOpen} onClick={() => setExportOpen((v) => !v)} title="Export this list"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 32, padding: '0 12px', fontSize: 13 }}>
                <Download size={14} aria-hidden="true" /> Export
              </button>
              <AnchoredMenu anchorRef={exportRef} open={exportOpen} onClose={() => setExportOpen(false)} align="end" minWidth={180}
                style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, boxShadow: 'var(--shadow-lg)', padding: 6 }}>
                <MenuRow icon={FileSpreadsheet} onClick={() => { setExportOpen(false); exportCsv(displayRows, recordType, active.name); }}>Export as CSV</MenuRow>
                <MenuRow icon={FileText} onClick={() => { setExportOpen(false); exportPdf(displayRows, recordType, active.name); }}>Export as PDF</MenuRow>
              </AnchoredMenu>
            </>
          )}
          {onAdd && (
            <button type="button" className="primary-btn" onClick={() => onAdd()} aria-label={`New ${recordType.title}`}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 32, padding: '0 14px', fontSize: 13 }}>
              <Plus size={14} aria-hidden="true" /> New
            </button>
          )}
        </div>
      </div>
      )}

      {quickAdd && onQuickAdd && (
        <QuickAddLine placeholder={quickAdd.placeholder} button={quickAdd.button}
          onAdd={({ date, text }) => onQuickAdd({ date, [quickAdd.k]: text, ...quickAdd.extra })} />
      )}

      {displayRows.length ? (
        <div style={{ overflowX: 'auto' }}>
          <table className="coll-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                {leadColumn && <th style={{ ...TH, padding: '8px 12px' }}>{leadColumn.label}</th>}
                {recordType.cols.map((col, ci) => (
                  <th key={col.label} aria-sort={sortCol === ci ? (sortDir > 0 ? 'ascending' : 'descending') : 'none'} style={TH}>
                    {/* The sort control is a button filling the header cell (keyboard reachable). */}
                    <button type="button" title={`Sort by ${col.label}`}
                      onClick={() => { if (sortCol === ci) setSortDir((d) => -d); else { setSortCol(ci); setSortDir(1); } }}
                      style={{ display: 'flex', alignItems: 'center', gap: 4, width: '100%', padding: '8px 12px', border: 'none', background: 'none', cursor: 'pointer', textAlign: 'left', font: 'inherit', color: sortCol === ci ? 'var(--text-primary)' : 'inherit', userSelect: 'none' }}>
                      {col.label}
                      {sortCol === ci ? (sortDir > 0 ? <ChevronUp size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />) : null}
                    </button>
                  </th>
                ))}
                <th style={TH}><span style={SR_ONLY}>Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {displayRows.map((row) => {
                const isHighlighted = highlightItem && rowIdentity(coll, row) === highlightItem;
                return (
                  <tr key={row.id} tabIndex={0}
                    onMouseEnter={(e) => { if (!isHighlighted) e.currentTarget.style.background = 'var(--bg-secondary)'; }}
                    onMouseLeave={(e) => { if (!isHighlighted) e.currentTarget.style.background = ''; }}
                    onKeyDown={(e) => { if (e.key === 'Enter') onEdit(row.id); }}
                    onClick={() => onEdit(row.id)}
                    ref={isHighlighted ? (el) => el && el.scrollIntoView?.({ behavior: 'smooth', block: 'center' }) : null}
                    style={{ cursor: 'pointer', transition: 'background-color 0.3s', background: isHighlighted ? 'hsla(var(--color-gold), 0.16)' : '' }}>
                    {leadColumn && (
                      <td data-label={leadColumn.label} style={{ ...TD, whiteSpace: 'nowrap', ...(row._nested ? { paddingLeft: 30 } : null) }}>
                        {row._nested && <CornerDownRight size={13} aria-hidden="true" style={{ color: 'var(--text-secondary)', marginRight: 5, verticalAlign: '-2px' }} />}
                        {leadColumn.render(row)}
                      </td>
                    )}
                    {recordType.cols.map((col, ci) => {
                      const chip = col.chip ? col.chip(row) : null;
                      const sub = col.sub ? col.sub(row) : null;
                      const text = cellText(col, row, active).trim();
                      // A cell with nothing to say shows a faint "-" (or its own words, "Not set")
                      // on a desktop; the phone card drops it (asset-styles td[data-empty]).
                      const empty = col.chip ? !chip : (text === '' || text === '-') && !sub;
                      const blank = text === '' || text === '-';
                      return (
                        <td key={col.label} data-label={col.label} data-empty={empty ? '1' : undefined}
                          style={{ ...TD, ...(col.clip ? { maxWidth: 280 } : null), ...(!leadColumn && ci === 0 && row._nested ? { paddingLeft: 28 } : null) }}>
                          {!leadColumn && ci === 0 && row._nested && <CornerDownRight size={13} aria-hidden="true" style={{ color: 'var(--text-secondary)', marginRight: 4, verticalAlign: '-2px' }} />}
                          {col.chip ? (chip || <span style={FAINT}>-</span>)
                            : blank && !col.main ? <span style={FAINT}>{col.empty || '-'}</span>
                            : col.main ? <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{text || '-'}</span>
                            : col.mono ? <span style={{ fontVariantNumeric: 'tabular-nums' }}>{col.mono(row, active)}</span>
                            : <span style={col.clip ? { display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-secondary)' } : null} title={col.clip ? text : undefined}>{col.plain(row, active)}</span>}
                          {sub ? <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>{sub}</div> : null}
                        </td>
                      );
                    })}
                    <td style={{ ...TD, textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button type="button" className="nx-row-action" aria-label={`${row._readOnly ? 'View' : 'Edit'} ${rowIdentity(coll, row)}`}
                        onClick={(e) => { e.stopPropagation(); onEdit(row.id); }}
                        style={{ border: 'none', background: 'none', padding: '2px 4px', fontFamily: 'inherit', fontSize: 13, fontWeight: 500, color: 'var(--text-secondary)', cursor: 'pointer' }}>
                        {row._readOnly ? 'View' : 'Edit'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : rows.length ? (
        <EmptyState compact title={`No ${noun} match "${query}"`} secondary={<button type="button" className="secondary-btn" onClick={() => setQuery('')}>Clear Search</button>}>
          Try another word, or clear the search to see all {rows.length}.
        </EmptyState>
      ) : (emptyNode || (
        <EmptyState icon={recordType.icon || ListPlus} title={`No ${noun} yet`} action={onAdd ? `New ${recordType.title}` : undefined} onAction={onAdd}>{recordType.empty}</EmptyState>
      ))}
    </div>
  );
}

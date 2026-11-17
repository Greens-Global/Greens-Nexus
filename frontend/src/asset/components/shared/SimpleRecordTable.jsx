// Leaner sibling of the generic CollectionTable: no RECORD_TYPES config, no sorting, no
// quick-add, no per-list export menu. Used for the two asset-record collections that live
// directly on the asset object (not the shared store) with a loose, tuple-based column
// definition instead of a full record-type schema: the Permits and Development Timeline
// tabs, alongside SimpleRowModal for add/edit and, for Timeline only,
// ../asset/TimelineStatusModal.jsx for the Status column.
//
// The look (Neil, 11/17/2026): a toolbar row (one sentence, search, New), a hairline table
// with Title Case headers, the status as colored words, a row opens its editor on click (an
// Edit button stays on every row for the keyboard, quiet until the row is hovered or
// focused). A finished Development Timeline folds to one line with Show All.

import { useState } from 'react';
import { Plus, Check } from 'lucide-react';
import { EmptyState } from './EmptyState.jsx';
import { StatusBadge } from './StatusBadge.jsx';
import { SummarySentence, ToolbarSearch } from './Toolbar.jsx';

/** Loose status-text -> tone classifier, specific to this table's free-text Status column
 *  (Permits/Timeline status values aren't a fixed enum handled elsewhere like RECORD_TYPES chips are). */
export function statusTone(status) {
  const s = (status || '').toLowerCase();
  if (/(complete|approved|issued|final|granted|closed)/.test(s)) return 'green';
  if (/progress|review|submitted/.test(s)) return 'live';
  if (s.includes('pending')) return 'gold';
  return 'mut';
}

const DONE_RE = /(complete|done|approved|issued|final|paid|recorded|granted)/;
const NA_RE = /^\s*(n\/?a|not applicable)\s*$/i;

/** First non-empty cell across the row's columns - used to build a stable-ish identity string
 *  for highlightItem matching (these rows don't reliably have a meaningful `id` to key off of). */
function rowIdentity(row, cols) {
  for (const [key] of cols) {
    const v = String(row[key] ?? '').trim();
    if (v) return v;
  }
  return '';
}

/** A timeline is finished when every row is done or not applicable (and at least one is done). */
export function timelineFold(rows) {
  const list = (rows || []).filter((r) => Object.values(r || {}).some((v) => String(v ?? '').trim()));
  if (!list.length) return null;
  const na = list.filter((r) => NA_RE.test(String(r.status || ''))).length;
  const done = list.filter((r) => DONE_RE.test(String(r.status || '').toLowerCase())).length;
  if (!done || done + na !== list.length) return null;
  const years = list.map((r) => String(r.statusDate || '').match(/\b(19|20)\d{2}\b/)?.[0]).filter(Boolean).sort();
  return { done, na, year: years[years.length - 1] || '' };
}

const TH = { textAlign: 'left', padding: '8px 12px', fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-color)', whiteSpace: 'nowrap' };
const TD = { padding: '10px 12px', borderBottom: '1px solid var(--border-color)', verticalAlign: 'top', color: 'var(--text-primary)', fontSize: 13 };
const quietBtn = { border: 'none', background: 'none', padding: '2px 4px', fontFamily: 'inherit', fontSize: 13, fontWeight: 500, cursor: 'pointer', color: 'var(--text-secondary)' };

/**
 * @param title           e.g. "Permits" or "Development Timeline" (names the rows in copy)
 * @param subtitle        e.g. the asset name (kept for callers; the page already names it)
 * @param rows            the raw row objects (asset.permits or asset.timeline)
 * @param cols            [key, label][] - if omitted, derived from the union of keys in `rows`
 * @param query           free-text filter string
 * @param onQueryChange   (text) => void - the toolbar's search box writes it; without one
 *                        the box keeps its own text, seeded from `query`
 * @param highlightItem   a row-identity string to scroll to + highlight
 * @param onAdd           () => void
 * @param emptyText       the empty state's line (default "No <title> yet.")
 * @param emptyAction     the empty state's button label (default "New <Row>")
 * @param onEdit          (index) => void
 * @param onDelete        (index) => void, or omit to hide the Delete button
 * @param onStatusClick   (index, currentStatus) => void - if provided, the "status" column
 *                        is a button that opens the status dialog; such a table is a timeline
 *                        and folds when finished (`foldWhenDone`, default on for it)
 */
export function SimpleRecordTable({ title, rows, cols, query, onQueryChange, highlightItem, onAdd, onEdit, onDelete, onStatusClick, emptyText, emptyAction, foldWhenDone }) {
  const [confirmIdx, setConfirmIdx] = useState(null);   // the row whose Delete is awaiting a Yes
  const [hot, setHot] = useState(null);                 // the hovered / focused row: its actions show
  const [ownQuery, setOwnQuery] = useState(query || '');
  const [showAll, setShowAll] = useState(false);
  const q = onQueryChange ? (query || '') : ownQuery;
  const setQ = onQueryChange || setOwnQuery;
  const allRows = rows || [];
  const columns = cols || (() => {
    const keys = [];
    allRows.forEach((row) => Object.keys(row).forEach((k) => {
      if (k !== 'id' && k !== 'propertyId' && !keys.includes(k)) keys.push(k);
    }));
    return keys.map((k) => [k, k]);
  })();
  const isTimeline = !!onStatusClick;
  const noun = isTimeline ? 'approval' : String(title || 'row').toLowerCase().replace(/s$/, '');
  const nouns = isTimeline ? 'approvals' : String(title || 'rows').toLowerCase();

  // Only rows with at least one non-empty tracked column are shown at all (a row of all-blank
  // fields is treated as not-yet-meaningful and hidden rather than rendered empty).
  const meaningful = allRows
    .map((row, idx) => ({ row, idx }))
    .filter(({ row }) => columns.some(([key]) => String(row[key] ?? '').trim()));
  const lq = q.toLowerCase();
  const visible = lq ? meaningful.filter(({ row }) => columns.some(([key]) => String(row[key] ?? '').toLowerCase().includes(lq))) : meaningful;

  const statusKey = columns.find(([k]) => k.toLowerCase() === 'status')?.[0];
  const statuses = statusKey ? meaningful.map(({ row }) => String(row[statusKey] || '').trim()) : [];
  const doneN = statuses.filter((s) => DONE_RE.test(s.toLowerCase())).length;
  const naN = statuses.filter((s) => NA_RE.test(s)).length;
  const openN = statuses.length - doneN - naN;
  const sentence = meaningful.length ? [
    `${meaningful.length} ${meaningful.length === 1 ? noun : nouns}`,
    statusKey && doneN && `${doneN} ${isTimeline ? 'complete' : 'done'}`,
    statusKey && openN && { text: `${openN} still open`, tone: 'live' },
    statusKey && naN && `${naN} not applicable`,
  ].filter(Boolean) : [];

  const fold = (foldWhenDone ?? isTimeline) ? timelineFold(allRows) : null;
  const folded = fold && !showAll && !lq && !highlightItem;

  const toolbar = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12, minHeight: 32 }}>
      <div style={{ flex: '1 1 260px', minWidth: 0 }}>
        {folded ? (
          <p style={{ margin: 0, fontSize: 13, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Check size={15} aria-hidden="true" style={{ color: 'hsl(var(--color-green))' }} />
            <span>
              <b style={{ fontWeight: 600 }}>Development complete{fold.year ? ` ${fold.year}` : ''}</b>
              {` - ${fold.done} ${fold.done === 1 ? noun : nouns}`}{fold.na ? `, ${fold.na} not applicable` : ''}
            </span>
            <button type="button" onClick={() => setShowAll(true)} aria-expanded="false"
              style={{ ...quietBtn, color: 'hsl(var(--color-green))', fontWeight: 600 }}>Show All</button>
          </p>
        ) : <SummarySentence parts={sentence} />}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto', flexWrap: 'wrap' }}>
        {fold && showAll && <button type="button" onClick={() => setShowAll(false)} aria-expanded="true" style={quietBtn}>Fold Up</button>}
        {meaningful.length > 0 && !folded && <ToolbarSearch value={q} onChange={setQ} placeholder={`Search ${nouns}`} />}
        {onAdd && (
          <button type="button" className="primary-btn" onClick={onAdd} aria-label={`New ${isTimeline ? 'Approval' : noun.replace(/\b\w/g, (c) => c.toUpperCase())}`}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 32, padding: '0 14px', fontSize: 13 }}>
            <Plus size={14} aria-hidden="true" /> New
          </button>
        )}
      </div>
    </div>
  );

  if (folded) return <div style={{ minWidth: 0 }}>{toolbar}</div>;

  return (
    <div style={{ minWidth: 0 }}>
      {toolbar}
      {visible.length ? (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                {columns.map(([key, label]) => <th key={key} style={TH}>{label}</th>)}
                <th style={TH}><span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {visible.map(({ row, idx }) => {
                const isHighlighted = highlightItem && rowIdentity(row, columns) === highlightItem;
                const shown = hot === idx || confirmIdx === idx;
                const name = rowIdentity(row, columns) || `row ${idx + 1}`;
                return (
                  <tr
                    key={idx}
                    ref={isHighlighted ? (el) => el && el.scrollIntoView?.({ behavior: 'smooth', block: 'center' }) : null}
                    onClick={() => onEdit(idx)}
                    onMouseEnter={() => setHot(idx)}
                    onMouseLeave={() => setHot((h) => (h === idx ? null : h))}
                    onFocus={() => setHot(idx)}
                    onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setHot((h) => (h === idx ? null : h)); }}
                    style={{ cursor: 'pointer', transition: 'background-color 0.3s', background: isHighlighted ? 'hsla(var(--color-gold), 0.16)' : hot === idx ? 'var(--bg-secondary)' : '' }}
                  >
                    {columns.map(([key], ci) => {
                      const value = String(row[key] ?? '').trim();
                      let content;
                      if (key === 'status' && onStatusClick) {
                        content = (
                          <button type="button" onClick={(e) => { e.stopPropagation(); onStatusClick(idx, value); }}
                            title="Change the status (a reason is required)" aria-label={`Status of ${name}: ${value || 'not set'}. Change it`}
                            style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', font: 'inherit', textAlign: 'left' }}>
                            {value ? <StatusBadge tone={statusTone(value)}>{value}</StatusBadge>
                              : <span style={{ color: 'hsl(var(--color-green))', fontWeight: 500 }}>Set Status</span>}
                          </button>
                        );
                      } else if (key.toLowerCase() === 'status' && value) {
                        content = <StatusBadge tone={statusTone(value)}>{value}</StatusBadge>;
                      } else {
                        content = value || <span style={{ color: 'var(--text-muted)' }}>-</span>;
                      }
                      return <td key={key} style={{ ...TD, ...(ci === 0 ? { fontWeight: 600 } : null) }}>{content}</td>;
                    })}
                    <td style={{ ...TD, whiteSpace: 'nowrap', textAlign: 'right' }} onClick={(e) => e.stopPropagation()}>
                      {onDelete && confirmIdx === idx ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ fontSize: 13, fontWeight: 600 }}>Delete this row?</span>
                          <button type="button" className="secondary-btn" onClick={() => setConfirmIdx(null)} style={{ padding: '4px 10px', fontSize: 12 }}>Keep</button>
                          <button type="button" className="primary-btn" onClick={() => { setConfirmIdx(null); onDelete(idx); }} style={{ padding: '4px 10px', fontSize: 12, backgroundColor: 'hsl(var(--color-red))' }}>Delete</button>
                        </span>
                      ) : (
                        <span style={{ display: 'inline-flex', gap: 4, opacity: shown ? 1 : 0, transition: 'opacity .12s' }}>
                          <button type="button" onClick={() => onEdit(idx)} aria-label={`Edit ${name}`} style={quietBtn}>Edit</button>
                          {onDelete && <button type="button" onClick={() => setConfirmIdx(idx)} aria-label={`Delete ${name}`} style={{ ...quietBtn, color: 'hsl(var(--color-red))' }}>Delete</button>}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : meaningful.length ? (
        <EmptyState compact title={`No ${nouns} match "${q}"`} secondary={<button type="button" className="secondary-btn" onClick={() => setQ('')}>Clear Search</button>}>
          Try another word, or clear the search to see all {meaningful.length}.
        </EmptyState>
      ) : (
        <EmptyState title={`No ${nouns} yet`} action={onAdd ? (emptyAction || `New ${isTimeline ? 'Approval' : noun.replace(/\b\w/g, (c) => c.toUpperCase())}`) : undefined} onAction={onAdd}>
          {emptyText || (isTimeline ? 'Add each approval the project needs - the agency, what it takes and how long the review runs - and track its status here.' : `Nothing recorded under ${title} yet.`)}
        </EmptyState>
      )}
    </div>
  );
}

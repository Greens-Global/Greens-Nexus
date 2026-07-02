// Leaner sibling of the generic CollectionTable: no RECORD_TYPES config, no sorting, no
// quick-add, no per-list export menu. Used only for the two asset-record collections that live
// directly on the asset object (not the shared store) with a loose, tuple-based column
// definition instead of a full record-type schema: the "Permit Matrix" and "Development
// Timeline" tabs, alongside SimpleRowModal for add/edit and, for Timeline only,
// ../asset/TimelineStatusModal.jsx for the Status column's chip button.

import { Plus } from 'lucide-react';
import { Card } from './Card.jsx';
import { EmptyState } from './EmptyState.jsx';
import { StatusBadge } from './StatusBadge.jsx';

const LABEL_STYLE = { fontSize: '0.64rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-secondary)' };

/** Loose status-text -> badge tone classifier, specific to this table's free-text Status column
 *  (Permits/Timeline status values aren't a fixed enum handled elsewhere like RECORD_TYPES chips are). */
function statusTone(status) {
  const s = (status || '').toLowerCase();
  if (s.includes('complete')) return 'green';
  if (s.includes('progress')) return 'blue';
  if (s.includes('pending')) return 'gold';
  return 'mut';
}

/** First non-empty cell across the row's columns — used to build a stable-ish identity string
 *  for highlightItem matching (these rows don't reliably have a meaningful `id` to key off of). */
function rowIdentity(row, cols) {
  for (const [key] of cols) {
    const v = String(row[key] ?? '').trim();
    if (v) return v;
  }
  return '';
}

/**
 * @param title           e.g. "Permit Matrix" or "Development Timeline"
 * @param subtitle        e.g. the asset name
 * @param rows            the raw row objects (asset.permits or asset.timeline)
 * @param cols            [key, label][] — if omitted, derived from the union of keys in `rows`
 * @param query           free-text filter string
 * @param highlightItem   a row-identity string to scroll to + highlight
 * @param onAdd           () => void
 * @param onEdit          (index) => void
 * @param onDelete        (index) => void, or omit to hide the Delete button
 * @param onStatusClick   (index, currentStatus) => void — if provided, the "status" column
 *                        renders as a clickable chip button instead of a plain badge
 */
export function SimpleRecordTable({ title, subtitle, rows, cols, query, highlightItem, onAdd, onEdit, onDelete, onStatusClick }) {
  const allRows = rows || [];
  const columns = cols || (() => {
    const keys = [];
    allRows.forEach((row) => Object.keys(row).forEach((k) => {
      if (k !== 'id' && k !== 'propertyId' && !keys.includes(k)) keys.push(k);
    }));
    return keys.map((k) => [k, k]);
  })();

  // Only rows with at least one non-empty tracked column are shown at all (a row of all-blank
  // fields is treated as not-yet-meaningful and hidden rather than rendered empty).
  let visible = allRows
    .map((row, idx) => ({ row, idx }))
    .filter(({ row }) => columns.some(([key]) => String(row[key] ?? '').trim()));

  const q = (query || '').toLowerCase();
  if (q) {
    visible = visible.filter(({ row }) => columns.some(([key]) => String(row[key] ?? '').toLowerCase().includes(q)));
  }

  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: '1rem', fontFamily: "'Plus Jakarta Sans', sans-serif" }}>{title}</strong>
        {subtitle && <span style={LABEL_STYLE}>{subtitle}</span>}
        <span style={{ ...LABEL_STYLE, marginLeft: 'auto' }}>
          {visible.length} row{visible.length === 1 ? '' : 's'}
        </span>
        <button
          className="primary-btn"
          onClick={onAdd}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px', fontSize: '0.8rem' }}
        >
          <Plus size={14} /> Add
        </button>
      </div>

      {visible.length ? (
        <div style={{ border: '1px solid var(--border-color)', borderRadius: 10, overflow: 'hidden', overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
            <thead>
              <tr>
                {columns.map(([key, label]) => (
                  <th
                    key={key}
                    style={{ ...LABEL_STYLE, textAlign: 'left', padding: '10px 12px', background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border-color)', whiteSpace: 'nowrap' }}
                  >
                    {label}
                  </th>
                ))}
                <th style={{ ...LABEL_STYLE, textAlign: 'right', padding: '10px 12px', background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border-color)', whiteSpace: 'nowrap' }}>
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map(({ row, idx }) => {
                const isHighlighted = highlightItem && rowIdentity(row, columns) === highlightItem;
                return (
                  <tr
                    key={idx}
                    ref={isHighlighted ? (el) => el && el.scrollIntoView({ behavior: 'smooth', block: 'center' }) : null}
                    style={{
                      transition: 'background-color 0.3s',
                      background: isHighlighted ? 'hsla(var(--color-gold), 0.2)' : '',
                      boxShadow: isHighlighted ? 'inset 3px 0 0 hsl(var(--color-gold))' : 'none',
                    }}
                  >
                    {columns.map(([key]) => {
                      const value = String(row[key] ?? '').trim();
                      let content;
                      if (key === 'status' && onStatusClick) {
                        content = (
                          <button
                            onClick={() => onStatusClick(idx, value)}
                            title="Change status (reason required)"
                            style={{ border: '1px solid var(--border-color)', background: 'var(--bg-card)', borderRadius: 999, padding: '3px 6px', cursor: 'pointer' }}
                          >
                            {value ? (
                              <StatusBadge tone={statusTone(value)}>{value}</StatusBadge>
                            ) : (
                              <span style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Set status</span>
                            )}
                          </button>
                        );
                      } else if (key === 'status' && value) {
                        content = <StatusBadge tone={statusTone(value)}>{value}</StatusBadge>;
                      } else {
                        content = value || '—';
                      }
                      return (
                        <td key={key} style={{ padding: '9px 12px', borderBottom: '1px solid var(--border-color)', verticalAlign: 'top', color: 'var(--text-primary)', fontSize: '0.78rem' }}>
                          {content}
                        </td>
                      );
                    })}
                    <td style={{ padding: '9px 12px', borderBottom: '1px solid var(--border-color)', verticalAlign: 'top', whiteSpace: 'nowrap', textAlign: 'right' }}>
                      <button
                        className="secondary-btn"
                        onClick={() => onEdit(idx)}
                        style={{ padding: '5px 11px', fontSize: '0.74rem', marginRight: onDelete ? 6 : 0 }}
                      >
                        Edit
                      </button>
                      {onDelete && (
                        <button
                          className="secondary-btn"
                          onClick={() => { if (window.confirm('Delete this row?')) onDelete(idx); }}
                          style={{ padding: '5px 11px', fontSize: '0.74rem', color: 'hsl(var(--color-red))' }}
                        >
                          Delete
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState>No {title.toLowerCase()} data yet — use "Add row" to add one.</EmptyState>
      )}
    </Card>
  );
}

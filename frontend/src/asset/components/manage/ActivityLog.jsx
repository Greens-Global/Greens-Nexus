import { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { Card } from '../shared/Card.jsx';
import { EmptyState } from '../shared/EmptyState.jsx';
import { inferAssetKind } from '../../lib/vehicleFields.js';

const MONO_FONT = "ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace";

// Small muted uppercase label style, reused for the "entries" count, date-range labels, and
// each change line's field name.
const LABEL_STYLE = { fontSize: '0.64rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-secondary)' };

const DATE_INPUT_STYLE = { padding: '6px 9px', width: 'auto', fontSize: '0.8rem' };

/** yyyy-mm-dd slice of an ISO timestamp, used both for day-bucketing and the date-range filter. */
function dateKey(ts) {
  return (ts || '').slice(0, 10);
}

/** "Today" / "Yesterday" / full weekday date, for the day-group headers. */
function dayLabel(ts) {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const key = dateKey(ts);
  if (key === dateKey(today.toISOString())) return 'Today';
  if (key === dateKey(yesterday.toISOString())) return 'Yesterday';
  try {
    return new Date(ts).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return key;
  }
}

function timeLabel(ts) {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
}

/** Up-to-2-letter initials for a user's avatar circle, from the first two "words" (splitting on
 *  whitespace/@/.) - e.g. "neil@greensglobal.com" -> "NG" isn't quite right, but matches source
 *  behavior: it splits on [\s@.] so "neil@greensglobal.com" -> "NEIL","GREENSGLOBAL","COM" -> "NG". */
function initials(user) {
  return (user || '?').split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((s) => s[0]).join('').toUpperCase() || '?';
}

/** Action -> tone color for the timeline dot and action pill. */
function actionTone(action) {
  if (action === 'added') return 'green';
  if (action === 'removed') return 'red';
  if (action === 'linked') return 'purple';
  return 'blue';
}

function actionLabel(action) {
  if (action === 'added') return 'Added';
  if (action === 'removed') return 'Removed';
  if (action === 'linked') return 'Linked';
  return 'Edited';
}

/** True if a string value "looks like" a formatted number/measurement (money, percent, sf/ac,
 *  units, etc) - used to render changed values in monospace instead of the default body font. */
function looksNumeric(value) {
  const s = String(value ?? '').trim();
  return s !== '' && /\d/.test(s) && /^[\d.,$%\s/:'"x×-]+(?:sf|SF|ac|AC|units?)?$/i.test(s);
}

/**
 * Activity Log tab content - every add/edit/delete/link recorded across the portfolio (or
 * scoped to one asset), grouped by day, with date-range filtering, free-text search, per-entry
 * "Go to" / "Undo" actions, and an inline undo confirmation.
 *
 * props:
 *   logs            - full activity log array (flat, newest-first is NOT assumed; grouped by ts)
 *   query           - initial free-text filter (search over the JSON of each entry)
 *   onOpenProperty(id) - navigate to an asset's page (used when clicking an entry's asset name)
 *   activeId        - if set, this log is scoped to one asset and can toggle "This property" vs "All properties"
 *   activeName      - display name for activeId, used as the "This property" toggle label
 *   onGoTo(entry)   - "Go to" button handler for a specific change
 *   onUndo(entry)   - revert handler, called after the inline confirm
 *   canUndo(entry)  - whether the Undo button should be shown for this entry
 *   assetsForKind   - all live assets, used only to look up each entry's asset kind (property/
 *                     vehicle/equipment) so the section pill can say "Vehicle"/"Equipment"
 *                     instead of the generic "Property" section name for non-property assets
 */
export function ActivityLog({ logs, query, onOpenProperty, activeId, activeName, onGoTo, onUndo, canUndo, assetsForKind }) {
  // Map of assetId -> kind, so the section pill on a "Property" section entry can be relabeled
  // "Vehicle" / "Equipment" for non-property assets (the log itself always calls it "Property").
  const kindById = {};
  (assetsForKind || []).forEach((p) => { kindById[p.id] = inferAssetKind(p); });

  const initialQuery = query || '';
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [confirmUndoId, setConfirmUndoId] = useState(null);
  // Scope toggle only appears when activeId is set: "this" (just this asset) vs "all" (portfolio-wide).
  const [scope, setScope] = useState(activeId ? 'this' : 'all');
  const scopedToOne = scope === 'this' && activeId;

  const filtered = (logs || []).filter((entry) => {
    if (scopedToOne && entry.propertyId !== activeId) return false;
    const day = dateKey(entry.ts);
    if ((from && day < from) || (to && day > to)) return false;
    if (!initialQuery) return true;
    return JSON.stringify(entry).toLowerCase().includes(initialQuery.toLowerCase());
  });

  // Render cap: an audit log grows without bound. Rendering every entry freezes
  // the tab at scale. Cap the rows drawn (the header count stays full); the
  // date filter lets users reach older entries.
  const MAX_LOG_ROWS = 300;
  const isLogCapped = filtered.length > MAX_LOG_ROWS;
  const shownEntries = isLogCapped ? filtered.slice(0, MAX_LOG_ROWS) : filtered;

  // Bucket the entries by day, preserving first-seen order of days as they appear.
  const dayGroups = [];
  shownEntries.forEach((entry) => {
    const key = dateKey(entry.ts);
    let group = dayGroups.find((g) => g.k === key);
    if (!group) {
      group = { k: key, ts: entry.ts, list: [] };
      dayGroups.push(group);
    }
    group.list.push(entry);
  });

  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
        <strong style={{ fontSize: '1rem', fontFamily: "'Plus Jakarta Sans', sans-serif" }}>Activity Log</strong>
        <span style={LABEL_STYLE}>{filtered.length} entr{filtered.length === 1 ? 'y' : 'ies'}</span>

        {activeId && (
          <div style={{ display: 'inline-flex', padding: 3, borderRadius: 999, border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-secondary)' }}>
            {[['this', activeName || 'This Property'], ['all', 'All Properties']].map(([key, label]) => (
              <button
                key={key}
                onClick={() => setScope(key)}
                style={{
                  padding: '5px 12px', borderRadius: 999, border: 'none', cursor: 'pointer',
                  fontSize: '0.76rem', fontWeight: 600, whiteSpace: 'nowrap',
                  background: scope === key ? 'var(--pine)' : 'transparent',
                  color: scope === key ? '#fff' : 'var(--text-secondary)',
                }}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto', flexWrap: 'wrap' }}>
          <label style={{ ...LABEL_STYLE, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            From <input type="date" className="form-input" value={from} onChange={(e) => setFrom(e.target.value)} style={DATE_INPUT_STYLE} />
          </label>
          <label style={{ ...LABEL_STYLE, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            To <input type="date" className="form-input" value={to} onChange={(e) => setTo(e.target.value)} style={DATE_INPUT_STYLE} />
          </label>
          {(from || to) && (
            <button className="secondary-btn" onClick={() => { setFrom(''); setTo(''); }} style={{ padding: '5px 11px', fontSize: '0.76rem' }}>
              Clear
            </button>
          )}
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState>No activity yet - every add, edit, delete and link is recorded here with who, what and when.</EmptyState>
      ) : (
        dayGroups.map((group) => (
          <div key={group.k} style={{ marginBottom: 14 }}>
            <div style={{ ...LABEL_STYLE, padding: '4px 0 8px' }}>{dayLabel(group.ts)}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {group.list.map((entry) => {
                const tone = actionTone(entry.action);
                const kind = kindById[entry.propertyId];
                const sectionLabel = entry.section === 'Property' && kind && kind !== 'property'
                  ? (kind === 'vehicle' ? 'Vehicle' : 'Equipment')
                  : entry.section;

                return (
                  <div
                    key={entry.id}
                    style={{
                      display: 'flex', gap: 11, padding: '12px 13px', borderRadius: 10,
                      border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-secondary)',
                    }}
                  >
                    <span style={{
                      flexShrink: 0, width: 9, height: 9, marginTop: 5, borderRadius: '50%',
                      backgroundColor: `hsl(var(--color-${tone}))`, boxShadow: `0 0 0 3px hsla(var(--color-${tone}), 0.15)`,
                    }} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: entry.changes && entry.changes.length ? 7 : 0 }}>
                        <span style={{
                          fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.02em',
                          padding: '2px 7px', borderRadius: 4, color: `hsl(var(--color-${tone}))`, backgroundColor: `hsla(var(--color-${tone}), 0.12)`,
                        }}>
                          {actionLabel(entry.action)}
                        </span>
                        {entry.property && (
                          <span
                            onClick={() => entry.propertyId && onOpenProperty(entry.propertyId)}
                            title="Open property"
                            style={{
                              fontSize: '0.82rem', fontWeight: 700, color: 'var(--text-primary)',
                              cursor: entry.propertyId ? 'pointer' : 'default', overflow: 'hidden',
                              textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            }}
                          >
                            {entry.property}
                          </span>
                        )}
                        <span style={{ fontSize: '0.7rem', fontWeight: 600, padding: '2px 7px', borderRadius: 4, color: 'hsl(var(--color-blue))', backgroundColor: 'hsla(var(--color-blue), 0.1)' }}>
                          {sectionLabel}
                        </span>
                        {entry.item && entry.item !== entry.property && (
                          <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            · {entry.item}
                          </span>
                        )}
                        <span style={{ marginLeft: 'auto', fontSize: '0.72rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                          {timeLabel(entry.ts)}
                        </span>
                      </div>

                      {entry.changes && entry.changes.length > 0 && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, padding: '7px 10px', borderRadius: 7, backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)' }}>
                          {entry.changes.map((change, i) => (
                            <div key={i} style={{ fontSize: '0.78rem', color: 'var(--text-primary)', wordBreak: 'break-word', lineHeight: 1.5 }}>
                              <span style={LABEL_STYLE}>{change.field}</span>
                              {'  '}
                              <span style={{ color: 'var(--text-secondary)', textDecoration: 'line-through' }}>
                                {(change.from ?? '') === '' ? '∅' : String(change.from)}
                              </span>
                              {' → '}
                              <span style={{ fontWeight: 600, fontFamily: looksNumeric(change.to) ? MONO_FONT : undefined }}>
                                {(change.to ?? '') === '' ? '∅' : String(change.to)}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}

                      {entry.reason && (
                        <div style={{
                          marginTop: 7, padding: '6px 10px', borderRadius: 7, fontSize: '0.76rem',
                          color: 'hsl(var(--color-gold))', backgroundColor: 'hsla(var(--color-gold), 0.1)',
                          border: '1px solid hsla(var(--color-gold), 0.3)', wordBreak: 'break-word',
                        }}>
                          <strong>Reason:</strong> <span style={{ color: 'var(--text-primary)', fontStyle: 'italic' }}>{entry.reason}</span>
                        </div>
                      )}

                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                        <span title={entry.user} style={{
                          flexShrink: 0, width: 20, height: 20, borderRadius: '50%', display: 'inline-flex',
                          alignItems: 'center', justifyContent: 'center', fontSize: '0.6rem', fontWeight: 700,
                          color: 'hsl(var(--color-purple))', backgroundColor: 'hsla(var(--color-purple), 0.14)',
                        }}>
                          {initials(entry.user)}
                        </span>
                        <span style={{ fontSize: '0.74rem', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {entry.user}
                        </span>

                        <div style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          {entry.undone && (
                            <span style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-secondary)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                              <RotateCcw size={12} /> Undone
                            </span>
                          )}
                          {entry.propertyId && onGoTo && (
                            <button
                              onClick={() => onGoTo(entry)}
                              style={{
                                display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px', borderRadius: 7,
                                border: '1px solid var(--border-color)', background: 'var(--bg-card)', cursor: 'pointer',
                                fontSize: '0.72rem', fontWeight: 600, color: 'hsl(var(--color-blue))', whiteSpace: 'nowrap',
                              }}
                            >
                              Go to {entry.action === 'removed' ? entry.section : entry.changes && entry.changes.length ? 'field' : entry.section} →
                            </button>
                          )}
                          {onUndo && canUndo && canUndo(entry) && (
                            <button
                              onClick={() => setConfirmUndoId(entry.id)}
                              title="Undo this change"
                              style={{
                                display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px', borderRadius: 7,
                                border: '1px solid hsl(var(--color-gold) / 0.5)', background: 'hsla(var(--color-gold), 0.1)',
                                cursor: 'pointer', fontSize: '0.72rem', fontWeight: 700, color: 'hsl(var(--color-gold))', whiteSpace: 'nowrap',
                              }}
                            >
                              <RotateCcw size={12} /> Undo
                            </button>
                          )}
                        </div>
                      </div>

                      {confirmUndoId === entry.id && (
                        <div style={{ marginTop: 8, padding: '11px 13px', borderRadius: 9, border: '1px solid hsl(var(--color-gold) / 0.5)', backgroundColor: 'hsla(var(--color-gold), 0.08)' }}>
                          <div style={{ fontSize: '0.78rem', color: 'var(--text-primary)', marginBottom: 9 }}>
                            Undo this change?{' '}
                            {entry.action === 'added'
                              ? 'The property will be moved to Recover.'
                              : entry.action === 'removed'
                              ? 'The property will be restored.'
                              : 'The previous value(s) will be put back.'}
                          </div>
                          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                            <button className="secondary-btn" onClick={() => setConfirmUndoId(null)} style={{ fontSize: '0.78rem', padding: '5px 12px' }}>
                              Cancel
                            </button>
                            <button
                              className="primary-btn"
                              onClick={() => { onUndo(entry); setConfirmUndoId(null); }}
                              style={{ fontSize: '0.78rem', padding: '5px 12px', display: 'inline-flex', alignItems: 'center', gap: 5 }}
                            >
                              <RotateCcw size={13} /> Undo
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))
      )}
      {isLogCapped && (
        <div style={{ ...LABEL_STYLE, padding: '10px 2px 2px', textAlign: 'center' }}>
          Showing {MAX_LOG_ROWS} of {filtered.length} entries - narrow the date range to see others.
        </div>
      )}
    </Card>
  );
}

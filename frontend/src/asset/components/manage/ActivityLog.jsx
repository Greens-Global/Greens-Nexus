import { useState, useMemo } from 'react';
import { RotateCcw, ArrowRight, X } from 'lucide-react';
import { EmptyState } from '../shared/EmptyState.jsx';
import { inferAssetKind } from '../../lib/vehicleFields.js';
import { formatDate, formatTime } from '../../../lib/datetime';
import { DateField } from '../../../tasks/components.jsx';

// The Activity Log (restyled 11/17/2026 to the house rules - Neil: no per-entry cards, no
// uppercase, no pills): one hairline row per change, the action as a colored word, filters by
// person, asset and date range (DateField, never a native date box). Go To and Undo unchanged.

const MUTED = 'var(--text-secondary)';
const FAINT = 'var(--text-muted)';
const LINE = 'var(--border-color)';
const META = { fontSize: 12, color: MUTED };

/** yyyy-mm-dd of a stamp in LOCAL time (an entry logged at 6 PM Pacific used to
 *  land under the next day's header), for day-bucketing and the date-range filter. */
function dateKey(ts) {
  if (!ts) return '';
  const d = ts instanceof Date ? ts : new Date(ts);
  if (isNaN(d)) return String(ts).slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** "Today" / "Yesterday" / the date, for the day-group headers. */
function dayLabel(ts) {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const key = dateKey(ts);
  if (key === dateKey(today)) return 'Today';
  if (key === dateKey(yesterday)) return 'Yesterday';
  return formatDate(ts, key);
}

/** Action -> the color of its word. */
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

const personKey = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
const shown = (v) => ((v ?? '') === '' ? '(empty)' : String(v));

const linkBtn = (color = 'hsl(var(--color-green))') => ({
  display: 'inline-flex', alignItems: 'center', gap: 4, padding: 0, border: 'none', background: 'none', cursor: 'pointer',
  fontFamily: 'inherit', fontSize: 12, fontWeight: 600, color, whiteSpace: 'nowrap',
});

/**
 * Activity Log - every add/edit/delete/link recorded across the portfolio (or scoped to one
 * asset), grouped by day, with filters (words, person, asset, date range), per-entry "Go To" /
 * "Undo" actions, and an inline undo confirmation.
 *
 * props:
 *   logs            - full activity log array
 *   query           - initial free-text filter (search over the JSON of each entry)
 *   onOpenProperty(id) - navigate to an asset's page (the entry's asset name)
 *   activeId        - if set, this log is scoped to one asset and can toggle "This property" vs "All properties"
 *   activeName      - display name for activeId, used as the "This property" toggle label
 *   scopeName       - the logs are already one asset's (the asset page's Activity): the asset
 *                     filter is hidden
 *   onGoTo(entry)   - "Go To" handler for a specific change
 *   onUndo(entry)   - revert handler, called after the inline confirm
 *   canUndo(entry)  - whether Undo shows for this entry
 *   assetsForKind   - all live assets, to say "Vehicle" / "Equipment" for a non-property's section
 *   bare            - no title row (a tab draws its own page header)
 *   onClose         - a close button (the old panel use)
 */
export function ActivityLog({ logs, query, onOpenProperty, activeId, activeName, scopeName, onGoTo, onUndo, canUndo, assetsForKind, onClose, bare = false }) {
  const kindById = {};
  (assetsForKind || []).forEach((p) => { kindById[p.id] = inferAssetKind(p); });

  const [text, setText] = useState(query || '');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [person, setPerson] = useState('');
  const [assetId, setAssetId] = useState('');
  const [confirmUndoId, setConfirmUndoId] = useState(null);
  const [scope, setScope] = useState(activeId ? 'this' : 'all');
  const scopedToOne = scope === 'this' && activeId;

  const base = useMemo(() => (logs || []).filter((e) => !(scopedToOne && e.propertyId !== activeId)), [logs, scopedToOne, activeId]);
  const people = useMemo(() => {
    const m = new Map();
    base.forEach((e) => { const k = personKey(e.user); if (k && !m.has(k)) m.set(k, String(e.user).trim()); });
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [base]);
  const assetsInLog = useMemo(() => {
    const m = new Map();
    base.forEach((e) => { if (e.propertyId && !m.has(e.propertyId)) m.set(e.propertyId, e.property || e.item || e.propertyId); });
    return [...m.entries()].sort((a, b) => String(a[1]).localeCompare(String(b[1])));
  }, [base]);
  const showAssetFilter = !scopeName && !scopedToOne && assetsInLog.length > 1;

  const q = text.trim().toLowerCase();
  const filtered = base.filter((entry) => {
    const day = dateKey(entry.ts);
    if ((from && day < from) || (to && day > to)) return false;
    if (person && personKey(entry.user) !== person) return false;
    if (assetId && entry.propertyId !== assetId) return false;
    if (!q) return true;
    return JSON.stringify(entry).toLowerCase().includes(q);
  });
  const anyFilter = !!(from || to || person || assetId || q);

  // Render cap: an audit log grows without bound. Cap the rows drawn (the count stays full);
  // the filters reach older entries.
  const MAX_LOG_ROWS = 300;
  const isLogCapped = filtered.length > MAX_LOG_ROWS;
  const shownEntries = isLogCapped ? filtered.slice(0, MAX_LOG_ROWS) : filtered;

  const dayGroups = [];
  shownEntries.forEach((entry) => {
    const key = dateKey(entry.ts);
    let group = dayGroups.find((g) => g.k === key);
    if (!group) { group = { k: key, ts: entry.ts, list: [] }; dayGroups.push(group); }
    group.list.push(entry);
  });

  const selectStyle = { fontSize: 13, padding: '6px 9px', width: 'auto', maxWidth: 220 };

  return (
    <div data-activity-log>
      {!bare && (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10 }}>
          <strong style={{ fontSize: 15 }}>Activity Log</strong>
          <span style={META}>{filtered.length.toLocaleString('en-US')} {filtered.length === 1 ? 'entry' : 'entries'}</span>
          {onClose && (
            <button type="button" className="secondary-btn" onClick={onClose} aria-label="Close Activity Log" style={{ padding: 6, marginLeft: 'auto' }}><X size={15} /></button>
          )}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
        <input type="search" className="form-input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Search changes"
          aria-label="Search changes" style={{ fontSize: 13, padding: '6px 10px', width: 220 }} />
        {activeId && !scopeName && (
          <div role="radiogroup" aria-label="Which assets" style={{ display: 'inline-flex', gap: 14 }}>
            {[['this', activeName || 'This Property'], ['all', 'All Properties']].map(([key, label]) => (
              <button key={key} type="button" role="radio" aria-checked={scope === key} onClick={() => setScope(key)}
                style={{ ...linkBtn(scope === key ? 'var(--text-primary)' : MUTED), fontSize: 13, textDecoration: scope === key ? 'underline' : 'none', textUnderlineOffset: 4 }}>
                {label}
              </button>
            ))}
          </div>
        )}
        {people.length > 1 && (
          <select className="form-input" aria-label="Person" value={person} onChange={(e) => setPerson(e.target.value)} style={selectStyle}>
            <option value="">Everyone</option>
            {people.map(([k, name]) => <option key={k} value={k}>{name}</option>)}
          </select>
        )}
        {showAssetFilter && (
          <select className="form-input" aria-label="Asset" value={assetId} onChange={(e) => setAssetId(e.target.value)} style={selectStyle}>
            <option value="">Every Asset</option>
            {assetsInLog.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        )}
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: MUTED }}>
          From <DateField value={from} onChange={setFrom} placeholder="Any Day" max={to || ''} title="From" style={{ minWidth: 118 }} />
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: MUTED }}>
          To <DateField value={to} onChange={setTo} placeholder="Any Day" min={from || ''} title="To" style={{ minWidth: 118 }} />
        </span>
        {anyFilter && (
          <button type="button" onClick={() => { setFrom(''); setTo(''); setPerson(''); setAssetId(''); setText(''); }} style={{ ...linkBtn(), fontSize: 13 }}>Clear</button>
        )}
        {bare && <span style={{ ...META, marginLeft: 'auto' }}>{filtered.length.toLocaleString('en-US')} {filtered.length === 1 ? 'entry' : 'entries'}</span>}
      </div>

      {filtered.length === 0 ? (
        <EmptyState>{anyFilter ? 'No changes match these filters.' : 'No activity yet - every add, edit, delete and link is recorded here with who, what and when.'}</EmptyState>
      ) : (
        dayGroups.map((group) => (
          <section key={group.k} aria-label={dayLabel(group.ts)} style={{ marginTop: 14 }}>
            <h3 style={{ fontSize: 13, fontWeight: 600, margin: 0, padding: '6px 0', borderBottom: `1px solid ${LINE}` }}>{dayLabel(group.ts)}</h3>
            {group.list.map((entry) => {
              const tone = actionTone(entry.action);
              const kind = kindById[entry.propertyId];
              const sectionLabel = entry.section === 'Property' && kind && kind !== 'property'
                ? (kind === 'vehicle' ? 'Vehicle' : 'Equipment')
                : entry.section;
              return (
                <div key={entry.id} data-log-entry style={{ padding: '11px 0', borderBottom: `1px solid ${LINE}` }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', fontSize: 13 }}>
                    <span style={{ fontWeight: 600, color: `hsl(var(--color-${tone}))` }}>{actionLabel(entry.action)}</span>
                    {entry.property && (entry.propertyId && onOpenProperty ? (
                      <button type="button" onClick={() => onOpenProperty(entry.propertyId)} title="Open this asset"
                        style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', fontFamily: 'inherit', padding: 0, border: 'none', background: 'none', cursor: 'pointer', textAlign: 'left' }}>
                        {entry.property}
                      </button>
                    ) : <span style={{ fontWeight: 600 }}>{entry.property}</span>)}
                    {sectionLabel && <span style={{ color: MUTED }}>{sectionLabel}</span>}
                    {entry.item && entry.item !== entry.property && <span style={{ color: MUTED }}>· {entry.item}</span>}
                    <span style={{ ...META, marginLeft: 'auto', whiteSpace: 'nowrap' }}>{formatTime(entry.ts, '')}</span>
                  </div>

                  {entry.changes && entry.changes.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 4 }}>
                      {entry.changes.map((change, i) => (
                        <div key={i} style={{ fontSize: 13, wordBreak: 'break-word', lineHeight: 1.5 }}>
                          <span style={{ color: MUTED }}>{change.field}</span>{'  '}
                          <span style={{ color: FAINT, textDecoration: 'line-through' }}>{shown(change.from)}</span>
                          <ArrowRight size={12} style={{ margin: '0 5px', verticalAlign: '-2px', color: FAINT }} />
                          <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{shown(change.to)}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {entry.reason && (
                    <div style={{ marginTop: 4, fontSize: 13, color: MUTED, wordBreak: 'break-word' }}>
                      Reason: <span style={{ color: 'var(--text-primary)', fontStyle: 'italic' }}>{entry.reason}</span>
                    </div>
                  )}

                  <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 5, flexWrap: 'wrap' }}>
                    <span style={META}>{entry.user}</span>
                    <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 14 }}>
                      {entry.undone && (
                        <span style={{ ...META, display: 'inline-flex', alignItems: 'center', gap: 4 }}><RotateCcw size={12} /> Undone</span>
                      )}
                      {entry.propertyId && onGoTo && (
                        <button type="button" onClick={() => onGoTo(entry)} style={linkBtn()}>
                          Go To {entry.action === 'removed' ? entry.section : entry.changes && entry.changes.length ? 'Field' : entry.section} <ArrowRight size={12} />
                        </button>
                      )}
                      {onUndo && canUndo && canUndo(entry) && (
                        <button type="button" onClick={() => setConfirmUndoId(entry.id)} title="Undo this change" style={linkBtn(MUTED)}>
                          <RotateCcw size={12} /> Undo
                        </button>
                      )}
                    </span>
                  </div>

                  {confirmUndoId === entry.id && (
                    <div role="group" aria-label="Undo this change" style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 13 }}>
                        Undo this change?{' '}
                        {entry.action === 'added'
                          ? 'The property will be moved to Recover.'
                          : entry.action === 'removed'
                          ? 'The property will be restored.'
                          : 'The previous value(s) will be put back.'}
                      </span>
                      <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 8 }}>
                        <button className="secondary-btn" onClick={() => setConfirmUndoId(null)} style={{ fontSize: 13, padding: '5px 12px' }}>Cancel</button>
                        <button className="primary-btn" onClick={() => { onUndo(entry); setConfirmUndoId(null); }}
                          style={{ fontSize: 13, padding: '5px 12px', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                          <RotateCcw size={13} /> Undo
                        </button>
                      </span>
                    </div>
                  )}
                </div>
              );
            })}
          </section>
        ))
      )}
      {isLogCapped && (
        <div style={{ ...META, padding: '12px 2px 2px', textAlign: 'center' }}>
          Showing {MAX_LOG_ROWS} of {filtered.length.toLocaleString('en-US')} entries - narrow the filters to see others.
        </div>
      )}
    </div>
  );
}

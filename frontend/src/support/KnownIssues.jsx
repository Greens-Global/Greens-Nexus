// Known Issues (Help Center, Oct 2026): what is broken right now, so nobody
// files a ticket about it. An administrator posts, edits and clears them
// (title, a short note, Info / Warning / Outage, an optional last day); one
// whose Until day has passed hides by itself.
//
//   KnownIssuesBanner  top of the Help Center page; administrators manage here
//   KnownIssuesNotice  one line each, for the Help panel and the ticket form
import { useState } from 'react';
import { Info, AlertTriangle, OctagonAlert, Plus, Trash2, Megaphone } from 'lucide-react';
import { Modal, DateField } from '../tasks/components';
import { formatDate, formatDateTime } from '../lib/datetime';
import { useKnownIssues, saveKnownIssues } from './knownIssuesStore';

const SEVERITY_META = {
  info:    { label: 'Info',    color: '#2b45e1', tint: 'rgba(43,69,225,0.07)', Icon: Info },
  warning: { label: 'Warning', color: '#b45309', tint: 'rgba(217,119,6,0.09)', Icon: AlertTriangle },
  outage:  { label: 'Outage',  color: '#dc2626', tint: 'rgba(220,38,38,0.08)', Icon: OctagonAlert },
};
const meta = (s) => SEVERITY_META[s] || SEVERITY_META.info;
const live = (issues) => issues.filter((i) => !i.expired);

/** One line per live issue - the Help panel and the ticket form. */
export function KnownIssuesNotice({ style }) {
  const { issues } = useKnownIssues();
  const shown = live(issues);
  if (!shown.length) return null;
  return (
    <div role="status" aria-label="Known Issues" style={{ display: 'flex', flexDirection: 'column', gap: 6, margin: '0 0 12px', ...style }}>
      {shown.map((i) => {
        const m = meta(i.severity);
        return (
          <div key={i.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '8px 10px', borderRadius: 8,
            background: m.tint, borderLeft: `3px solid ${m.color}`, fontSize: 12.5, lineHeight: 1.45, color: 'var(--ink)' }}>
            <m.Icon size={14} style={{ color: m.color, flexShrink: 0, marginTop: 2 }} />
            <span>
              <b>Known Issue: {i.title}</b>{i.note ? ` - ${i.note}` : ''}
              <span style={{ color: 'var(--muted)' }}> No need to file a ticket for this.</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

function IssueEditor({ issues, onClose }) {
  const [rows, setRows] = useState(() => issues.map((i) => ({ ...i })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dirty = JSON.stringify(rows.map(({ id, title, note, severity, until }) => [id, title, note, severity, until]))
    !== JSON.stringify(issues.map(({ id, title, note, severity, until }) => [id, title, note, severity, until]));
  const setRow = (idx, patch) => setRows((r) => r.map((x, i) => (i === idx ? { ...x, ...patch } : x)));
  const save = async () => {
    if (rows.some((r) => !String(r.title || '').trim())) { setError('Every known issue needs a title.'); return false; }
    setBusy(true); setError('');
    try {
      await saveKnownIssues(rows.map(({ id = '', title, note = '', severity = 'info', until = '' }) => ({ id, title: title.trim(), note, severity, until })));
      onClose();
      return true;
    } catch (e) {
      setError(e?.message || 'Could not save the known issues.');
      return false;
    } finally { setBusy(false); }
  };
  const input = { width: '100%', boxSizing: 'border-box', borderRadius: 8, border: '1px solid var(--line)', background: 'var(--card)',
    color: 'var(--ink)', padding: '7px 10px', fontFamily: 'inherit', fontSize: 13 };
  return (
    <Modal title="Known Issues" onClose={onClose} isDirty={dirty} onSave={save}
      footer={(
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
          {error && <span role="alert" style={{ fontSize: 12.5, color: '#dc2626', flex: 1 }}>{error}</span>}
          <span style={{ flex: error ? 0 : 1 }} />
          <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="primary-btn" onClick={save} disabled={busy || !dirty}>{busy ? 'Saving...' : 'Save'}</button>
        </div>
      )}>
      <div className="nx-fill" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>
          Shown at the top of the Help Center, in the Help panel and on the ticket form, so people know it is being handled.
          An issue with an Until day disappears after that day.
        </p>
        {rows.length === 0 && <div style={{ fontSize: 13, color: 'var(--muted)', padding: '12px 0' }}>No known issues right now.</div>}
        {rows.map((r, idx) => (
          <div key={r.id || `new-${idx}`} style={{ border: '1px solid var(--line)', borderRadius: 10, padding: 12, display: 'grid', gap: 8,
            gridTemplateColumns: 'minmax(0,1fr) auto', alignItems: 'start' }}>
            <div style={{ display: 'grid', gap: 8, minWidth: 0 }}>
              <input aria-label="Title" placeholder="Title, e.g. Time Clock Is Slow" value={r.title || ''} maxLength={120}
                onChange={(e) => setRow(idx, { title: e.target.value })} style={{ ...input, fontWeight: 600 }} />
              <textarea aria-label="Note" placeholder="What people should know (optional)" value={r.note || ''} maxLength={500} rows={2}
                onChange={(e) => setRow(idx, { note: e.target.value })} style={{ ...input, resize: 'vertical' }} />
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: 12.5, color: 'var(--muted)' }}>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>Severity
                  <select value={r.severity || 'info'} onChange={(e) => setRow(idx, { severity: e.target.value })}
                    style={{ ...input, width: 'auto', padding: '5px 8px' }}>
                    {Object.entries(SEVERITY_META).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
                  </select>
                </label>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>Until
                  <DateField value={r.until || ''} onChange={(v) => setRow(idx, { until: v || '' })} placeholder="Until cleared" noPast />
                  {r.until && <button type="button" className="secondary-btn" style={{ padding: '3px 8px', fontSize: 12 }} onClick={() => setRow(idx, { until: '' })}>Clear Date</button>}
                </span>
                {r.expired && <span style={{ color: '#b45309', fontWeight: 600 }}>Expired - hidden from everyone</span>}
              </div>
            </div>
            <button type="button" aria-label="Remove this issue" title="Remove" onClick={() => setRows((x) => x.filter((_, i) => i !== idx))}
              style={{ border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--muted)', borderRadius: 8, width: 32, height: 32,
                display: 'grid', placeItems: 'center', cursor: 'pointer' }}>
              <Trash2 size={15} />
            </button>
          </div>
        ))}
        {rows.length < 10 && (
          <button type="button" className="secondary-btn" style={{ alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 6 }}
            onClick={() => setRows((x) => [...x, { id: '', title: '', note: '', severity: 'warning', until: '' }])}>
            <Plus size={14} /> Add Issue
          </button>
        )}
      </div>
    </Modal>
  );
}

/** The Help Center page's banner; administrators manage the list from here. */
export default function KnownIssuesBanner() {
  const { issues, canEdit } = useKnownIssues();
  const [editing, setEditing] = useState(false);
  const shown = live(issues);
  if (!shown.length && !canEdit) return null;
  return (
    <section aria-label="Known Issues" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {shown.map((i) => {
        const m = meta(i.severity);
        return (
          <div key={i.id} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '12px 14px', borderRadius: 12,
            background: m.tint, border: '1px solid var(--line)', borderLeft: `4px solid ${m.color}` }}>
            <m.Icon size={18} style={{ color: m.color, flexShrink: 0, marginTop: 1 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--ink)' }}>{i.title}</span>
                <span style={{ fontSize: 11, fontWeight: 700, color: m.color, border: `1px solid ${m.color}`, borderRadius: 999, padding: '0 7px' }}>{m.label}</span>
              </div>
              {i.note && <div style={{ fontSize: 13, color: 'var(--ink)', lineHeight: 1.5, marginTop: 2 }}>{i.note}</div>}
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
                Known issue - no need to file a ticket for this.
                {i.posted_at ? ` Posted ${formatDateTime(i.posted_at)}.` : ''}
                {i.until ? ` Until ${formatDate(i.until)}.` : ''}
              </div>
            </div>
          </div>
        );
      })}
      {canEdit && (
        <button type="button" onClick={() => setEditing(true)}
          style={{ alignSelf: 'flex-end', display: 'inline-flex', alignItems: 'center', gap: 6, border: 'none', background: 'none',
            color: 'var(--muted)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', padding: '2px 4px' }}>
          <Megaphone size={14} /> {issues.length ? 'Manage Known Issues' : 'Post a Known Issue'}
        </button>
      )}
      {editing && <IssueEditor issues={issues} onClose={() => setEditing(false)} />}
    </section>
  );
}

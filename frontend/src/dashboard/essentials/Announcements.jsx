// Announcements (Essentials, Oct 7) - "What does the company want me to know?"
// Registered as 'announcements' in widgets.jsx, its own lazy chunk so it loads
// only when the tile is on the board.
//
// Everyone: the announcements they can see (company-wide + their department)
// from GET /announcements, pinned on top, newest first. Tapping a row expands
// it in place and marks it read; an announcement that asks for it carries an
// Acknowledge button. Seven rows, then View All opens the rest in place (there
// is no announcements screen yet). Refreshes on mount, when the tab comes
// back, and every 60s while visible.
//
// Administrators (useRole: can('administrator')): Post opens an inline
// composer in the card; each row gets Edit / Delete and a "Read by N" link
// that opens the read receipts inline. Body text is plain text with line
// breaks (the server accepts nothing else) - rendered pre-wrapped.
import { useState, useEffect, useCallback, useRef } from 'react';
import { Megaphone, Pin, Plus, ChevronDown, ChevronUp } from 'lucide-react';

import { api } from '../../api';
import { LoadingState } from '../../components/AsyncState';
import { useRole } from '../../contexts/RoleContext';
import { formatDate, formatDateTime } from '../../lib/datetime';
import { pollWhileVisible } from '../../lib/pollWhileVisible';
import { useIsMobile } from '../../lib/useIsMobile';
import { dialog } from '../../ui/dialog.jsx';
import { DashCard } from '../widgets.jsx';
import { noteStyle } from '../workdayWidgets.jsx';

const SHOW_FIRST = 7;
const REFRESH_MS = 60000;
const EMPTY_FORM = { title: '', body: '', audience: 'company', department: '', pinned_until: '', requires_ack: false };

const linkBtn = { background: 'none', border: 'none', padding: 0, color: 'var(--wk-brand, var(--brand, #2563eb))', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' };
const fieldStyle = { width: '100%', boxSizing: 'border-box', fontFamily: 'inherit', fontSize: 13, padding: '8px 10px', border: '1px solid var(--line, #e5e7eb)', borderRadius: 8, background: 'var(--card, #fff)', color: 'var(--ink)' };
const labelStyle = { display: 'block', fontSize: 11.5, fontWeight: 600, color: 'var(--muted)', marginBottom: 4 };

export function unreadCount(items) {
  return (items || []).filter(a => !a.read_at).length;
}

export function formOf(a) {
  if (!a) return { ...EMPTY_FORM };
  return {
    title: a.title || '', body: a.body || '', audience: a.audience === 'department' ? 'department' : 'company',
    department: a.department || '', pinned_until: a.pinned_until || '', requires_ack: !!a.requires_ack,
  };
}

export default function Announcements() {
  const { can, myEmail } = useRole();
  const isAdmin = typeof can === 'function' && can('administrator');
  const isMobile = useIsMobile();
  const [items, setItems] = useState(null);       // null = first load pending
  const [error, setError] = useState('');
  const [open, setOpen] = useState(() => new Set());
  const [showAll, setShowAll] = useState(false);
  const [composer, setComposer] = useState(null); // null | { id?, form }
  const [readsFor, setReadsFor] = useState(null); // { id, rows: null | [] , error }
  const alive = useRef(true);

  const load = useCallback(() => {
    return api.getAnnouncements()
      .then(rows => { if (!alive.current) return; setItems(Array.isArray(rows) ? rows : []); setError(''); })
      .catch(err => { if (!alive.current) return; setItems(cur => cur || []); setError(err?.message || 'Could not load announcements.'); });
  }, []);

  useEffect(() => {
    alive.current = true;
    load();
    const stop = pollWhileVisible(load, REFRESH_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { alive.current = false; stop(); document.removeEventListener('visibilitychange', onVisible); };
  }, [load]);

  const patchItem = (id, patch) => setItems(cur => (cur || []).map(a => (a.id === id ? { ...a, ...patch } : a)));

  const toggle = (a) => {
    setOpen(cur => { const next = new Set(cur); if (next.has(a.id)) next.delete(a.id); else next.add(a.id); return next; });
    if (!a.read_at) {
      const now = new Date().toISOString();
      patchItem(a.id, { read_at: now });
      api.markAnnouncementRead(a.id).catch(() => {});
    }
  };

  const ack = (a) => {
    const now = new Date().toISOString();
    patchItem(a.id, { acknowledged_at: now, read_at: a.read_at || now });
    api.ackAnnouncement(a.id).catch(() => { patchItem(a.id, { acknowledged_at: '' }); });
  };

  const remove = async (a) => {
    const ok = await dialog.confirm(`Delete "${a.title}"? People who already read it keep their marks.`, { title: 'Delete Announcement', confirmText: 'Delete', danger: true });
    if (!ok) return;
    try {
      await api.deleteAnnouncement(a.id);
      setItems(cur => (cur || []).filter(x => x.id !== a.id));
      if (readsFor?.id === a.id) setReadsFor(null);
    } catch (err) {
      await dialog.alert(err?.message || 'Could not delete the announcement.');
    }
  };

  const showReads = (a) => {
    if (readsFor?.id === a.id) { setReadsFor(null); return; }
    setReadsFor({ id: a.id, rows: null, error: '' });
    api.getAnnouncementReads(a.id)
      .then(rows => setReadsFor(cur => (cur?.id === a.id ? { id: a.id, rows: Array.isArray(rows) ? rows : [], error: '' } : cur)))
      .catch(err => setReadsFor(cur => (cur?.id === a.id ? { id: a.id, rows: [], error: err?.message || 'Could not load the list.' } : cur)));
  };

  const list = items || [];
  const unread = unreadCount(list);
  const visible = showAll ? list : list.slice(0, SHOW_FIRST);
  const tap = isMobile ? { minHeight: 44 } : {};

  const headerAction = isAdmin ? (
    <button type="button" className="secondary-btn" onClick={() => setComposer(c => (c && !c.id ? null : { form: { ...EMPTY_FORM } }))}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, ...tap }}>
      <Plus size={13} /> Post
    </button>
  ) : <Megaphone size={15} style={{ color: 'var(--muted)' }} />;

  return (
    <DashCard title="Announcements" sub={items ? `${unread} unread` : undefined} action={headerAction}>
      {composer && (
        <Composer initial={composer.form} editingId={composer.id} isMobile={isMobile}
          onCancel={() => setComposer(null)}
          onSaved={() => { setComposer(null); load(); }} />
      )}
      {!items ? (
        <LoadingState compact />
      ) : list.length === 0 ? (
        <div style={noteStyle}>
          {error ? (
            <>
              <div>Could not load announcements.</div>
              <button type="button" className="secondary-btn" onClick={load} style={{ marginTop: 8, ...tap }}>Retry</button>
            </>
          ) : (
            <>
              <div>No announcements.</div>
              {isAdmin && !composer && (
                <button type="button" className="secondary-btn" onClick={() => setComposer({ form: { ...EMPTY_FORM } })} style={{ marginTop: 8, ...tap }}>Post One</button>
              )}
            </>
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {visible.map(a => (
            <AnnouncementRow key={a.id} a={a} expanded={open.has(a.id)} isAdmin={isAdmin} isMobile={isMobile} myEmail={myEmail}
              onToggle={() => toggle(a)} onAck={() => ack(a)}
              onEdit={() => setComposer({ id: a.id, form: formOf(a) })} onDelete={() => remove(a)}
              onReads={() => showReads(a)} reads={readsFor?.id === a.id ? readsFor : null} />
          ))}
          {list.length > SHOW_FIRST && (
            <button type="button" onClick={() => setShowAll(s => !s)}
              style={{ ...linkBtn, alignSelf: 'flex-start', padding: '8px 8px', display: 'inline-flex', alignItems: 'center', gap: 4, ...tap }}>
              {showAll ? <>Show Less <ChevronUp size={13} /></> : <>View All ({list.length}) <ChevronDown size={13} /></>}
            </button>
          )}
        </div>
      )}
    </DashCard>
  );
}

function AnnouncementRow({ a, expanded, isAdmin, isMobile, onToggle, onAck, onEdit, onDelete, onReads, reads }) {
  const unread = !a.read_at;
  const needsAck = !!a.requires_ack && !a.acknowledged_at;
  const tap = isMobile ? { minHeight: 44 } : {};
  const meta = [a.author_name || a.author_email, formatDate(a.created_at)].filter(Boolean).join(' - ');
  const stop = (fn) => (e) => { e.stopPropagation(); fn(); };
  return (
    <div style={{ borderBottom: '1px solid var(--line, #eef0f3)' }}>
      <div role="button" tabIndex={0} aria-expanded={expanded} onClick={onToggle}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
        className="dash-link-row"
        style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '9px 8px', borderRadius: 8, cursor: 'pointer', ...tap }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--mist)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}>
        <span style={{ width: 8, flexShrink: 0, paddingTop: 6 }}>
          {unread && <span aria-label="Unread" style={{ display: 'block', width: 7, height: 7, borderRadius: 99, background: 'hsl(var(--color-blue))' }} />}
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {a.pinned && <Pin size={12} aria-label="Pinned" style={{ color: 'hsl(var(--color-orange))', flexShrink: 0 }} />}
            <span data-testid="ann-title" style={{ fontSize: 13, fontWeight: unread ? 700 : 500, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.title}</span>
            {a.audience === 'department' && a.department && (
              <span style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--muted)', border: '1px solid var(--line, #e5e7eb)', borderRadius: 99, padding: '0 6px', flexShrink: 0 }}>{a.department}</span>
            )}
          </span>
          <span style={expanded
            ? { display: 'block', fontSize: 12.5, color: 'var(--ink)', whiteSpace: 'pre-wrap', marginTop: 4, lineHeight: 1.5 }
            : { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', fontSize: 12.5, color: 'var(--muted)', marginTop: 2, lineHeight: 1.45 }}>
            {a.body}
          </span>
          <span style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 12px', fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}>
            <span>{meta}</span>
            {a.pinned && a.pinned_until && <span>Pinned until {formatDate(a.pinned_until)}</span>}
            {a.acknowledged_at && <span style={{ color: 'hsl(var(--color-green))', fontWeight: 600 }}>Acknowledged</span>}
            {isAdmin && (
              <>
                <button type="button" onClick={stop(onReads)} style={linkBtn}>Read by {a.read_count ?? 0}{a.requires_ack ? `, acknowledged by ${a.ack_count ?? 0}` : ''}</button>
                <button type="button" onClick={stop(onEdit)} style={linkBtn}>Edit</button>
                <button type="button" onClick={stop(onDelete)} style={{ ...linkBtn, color: 'hsl(var(--color-red))' }}>Delete</button>
              </>
            )}
          </span>
        </span>
        {needsAck && (
          <button type="button" className="primary-btn" onClick={stop(onAck)} style={{ flexShrink: 0, fontSize: 12, padding: '6px 10px', ...tap }}>Acknowledge</button>
        )}
      </div>
      {reads && <ReadsList reads={reads} />}
    </div>
  );
}

function ReadsList({ reads }) {
  return (
    <div style={{ margin: '0 8px 10px 26px', padding: '8px 10px', borderRadius: 8, background: 'var(--mist)', fontSize: 12 }}>
      {reads.rows === null ? (
        <LoadingState compact />
      ) : reads.error ? (
        <div style={{ color: 'var(--muted)' }}>{reads.error}</div>
      ) : reads.rows.length === 0 ? (
        <div style={{ color: 'var(--muted)' }}>Nobody has read this yet.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {reads.rows.map(r => (
            <div key={r.email} style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
              <span style={{ fontWeight: 600, color: 'var(--ink)' }}>{r.name || r.email}</span>
              <span style={{ color: 'var(--muted)', textAlign: 'right' }}>
                {r.acknowledged_at ? `Acknowledged ${formatDateTime(r.acknowledged_at)}` : `Read ${formatDateTime(r.read_at)}`}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Composer({ initial, editingId, isMobile, onCancel, onSaved }) {
  const [form, setForm] = useState(() => ({ ...EMPTY_FORM, ...initial }));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const tap = isMobile ? { minHeight: 44 } : {};

  const submit = async (e) => {
    e.preventDefault();
    const title = form.title.trim();
    const body = form.body.trim();
    if (!title) { setErr('Give the announcement a title.'); return; }
    if (!body) { setErr('Write the announcement.'); return; }
    if (form.audience === 'department' && !form.department.trim()) { setErr('Name the department.'); return; }
    const payload = {
      title, body, audience: form.audience,
      department: form.audience === 'department' ? form.department.trim() : '',
      pinned_until: form.pinned_until || '', requires_ack: !!form.requires_ack,
    };
    setBusy(true); setErr('');
    try {
      if (editingId) await api.updateAnnouncement(editingId, payload);
      else await api.createAnnouncement(payload);
      onSaved();
    } catch (ex) {
      setErr(ex?.message || 'Could not save the announcement.');
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} aria-label={editingId ? 'Edit Announcement' : 'Post Announcement'}
      style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: isMobile ? '10px 0 14px' : '10px 8px 14px', marginBottom: 8, borderBottom: '1px solid var(--line, #eef0f3)' }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)' }}>{editingId ? 'Edit Announcement' : 'New Announcement'}</div>
      <label>
        <span style={labelStyle}>Title</span>
        <input value={form.title} onChange={set('title')} maxLength={200} placeholder="What should people know?" style={{ ...fieldStyle, ...tap }} />
      </label>
      <label>
        <span style={labelStyle}>Body</span>
        <textarea value={form.body} onChange={set('body')} maxLength={20000} rows={isMobile ? 5 : 4} placeholder="Plain text, line breaks are kept." style={{ ...fieldStyle, resize: 'vertical' }} />
      </label>
      <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', gap: 10 }}>
        <label style={{ flex: 1 }}>
          <span style={labelStyle}>Audience</span>
          <select value={form.audience} onChange={set('audience')} style={{ ...fieldStyle, ...tap }}>
            <option value="company">Company</option>
            <option value="department">Department</option>
          </select>
        </label>
        {form.audience === 'department' && (
          <label style={{ flex: 1 }}>
            <span style={labelStyle}>Department</span>
            <input value={form.department} onChange={set('department')} maxLength={120} placeholder="e.g. Operations" style={{ ...fieldStyle, ...tap }} />
          </label>
        )}
        <label style={{ flex: 1 }}>
          <span style={labelStyle}>Pinned Until</span>
          <input type="date" value={form.pinned_until} onChange={set('pinned_until')} style={{ ...fieldStyle, ...tap }} />
        </label>
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--ink)', ...tap }}>
        <input type="checkbox" checked={!!form.requires_ack} onChange={set('requires_ack')} /> Requires acknowledgement
      </label>
      {err && <div role="alert" style={{ fontSize: 12, color: 'hsl(var(--color-red))' }}>{err}</div>}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        <button type="button" className="secondary-btn" onClick={onCancel} disabled={busy} style={tap}>Cancel</button>
        <button type="submit" className="primary-btn" disabled={busy} style={tap}>{busy ? 'Saving...' : editingId ? 'Save Changes' : 'Post Announcement'}</button>
      </div>
    </form>
  );
}

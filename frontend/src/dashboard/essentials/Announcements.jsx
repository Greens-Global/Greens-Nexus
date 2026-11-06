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
//
// Reach (Neil, 11/02/2026): a post may carry ONE picture or ONE file (browser
// -> the private task-files bucket under announcements/, opened through the
// signed viewer; Ctrl+V pastes a picture), be published later (Publish Later:
// a DateField + 12-hour TimeField, sent as an ISO instant; administrators
// see "Scheduled for ..." and staff see nothing until then) and say how the
// audience hears about it (Notify: Bell / Bell and Teams / Bell and Email - the bell
// always rings). Administrators read who acknowledged in the meta line.
//
// Work site (Neil, 11/02/2026, Homebase lifts): a third audience, "Work
// Site", picked from the work-site library (api.getWorkSites) - the post
// reaches the people whose allowed work sites include it (the server's rule;
// an empty list is nobody's site) and the row carries the site's name as its
// chip. Read by opens who read / acknowledged and, for a post that requires
// acknowledgment, "Not Yet Acknowledged" - the names still owed.
import { useState, useEffect, useCallback, useRef } from 'react';
import { Megaphone, Pin, Plus, ChevronDown, ChevronUp, Image, ImagePlus, Paperclip, X, CalendarClock } from 'lucide-react';

import { api } from '../../api';
import { WidgetSkeleton } from '../listParts.jsx';
import { useRole } from '../../contexts/RoleContext';
import { formatDate, formatDateTime } from '../../lib/datetime';
import { pollWhileVisible } from '../../lib/pollWhileVisible';
import { toViewUrl } from '../../lib/storageView';
import { useIsMobile } from '../../lib/useIsMobile';
import { DateField, TimeField } from '../../tasks/components';
import { filesFromPaste, storeTaskFile } from '../../tasks/lib';
import { dialog } from '../../ui/dialog.jsx';
import { DashCard } from '../widgets.jsx';
import { noteStyle } from '../workdayWidgets.jsx';

const SHOW_FIRST = 7;
const REFRESH_MS = 60000;
const EMPTY_FORM = {
  title: '', body: '', audience: 'company', department: '', work_site_id: '', pinned_until: '', requires_ack: false,
  image_url: '', file_url: '', file_name: '', publish_at: '', notify: 'quiet',
};
const AUDIENCES = ['company', 'department', 'site'];
const UPLOAD_FOLDER = 'announcements';
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const NARROW_PX = 520;
const FILE_MAX_BYTES = 25 * 1024 * 1024;
export const NOTIFY_OPTIONS = [
  { value: 'quiet', label: 'Bell' },
  { value: 'push_teams', label: 'Bell and Teams' },
  { value: 'email', label: 'Bell and Email' },
];

const linkBtn = { background: 'none', border: 'none', padding: 0, color: 'var(--wk-brand, var(--brand, #2563eb))', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' };
const fieldStyle = { width: '100%', boxSizing: 'border-box', fontFamily: 'inherit', fontSize: 13, padding: '8px 10px', border: '1px solid var(--line, #e5e7eb)', borderRadius: 8, background: 'var(--card, #fff)', color: 'var(--ink)' };
const labelStyle = { display: 'block', fontSize: 11.5, fontWeight: 600, color: 'var(--muted)', marginBottom: 4 };

export function unreadCount(items) {
  return (items || []).filter(a => !a.read_at).length;
}

export function formOf(a) {
  if (!a) return { ...EMPTY_FORM };
  return {
    title: a.title || '', body: a.body || '', audience: AUDIENCES.includes(a.audience) ? a.audience : 'company',
    department: a.department || '', work_site_id: a.workSiteId || a.work_site_id || '',
    pinned_until: a.pinned_until || '', requires_ack: !!a.requires_ack,
    image_url: a.image_url || '', file_url: a.file_url || '', file_name: a.file_name || '',
    publish_at: a.publish_at || '', notify: NOTIFY_OPTIONS.some(o => o.value === a.notify) ? a.notify : 'quiet',
  };
}

/** "Acknowledged by Ana Diaz, Bob Lee and 3 more" from the first names the
 *  server sends and the full count; '' when nobody has. */
export function ackSummary(a) {
  const count = a?.ack_count ?? 0;
  const names = (a?.ack_names || []).filter(Boolean);
  if (!count) return '';
  if (!names.length) return `Acknowledged by ${count}`;
  const rest = count - names.length;
  // Two names and nobody else: "Ana Diaz and Bob Lee"; otherwise a comma list
  // with the remainder counted.
  const list = rest > 0 ? names.join(', ') : names.length === 2 ? names.join(' and ') : names.join(', ');
  return `Acknowledged by ${list}${rest > 0 ? ` and ${rest} more` : ''}`;
}

/** The reads answer -> { rows, notAcknowledged }: an object with `reads` (and,
 *  for a post that requires acknowledgment, `notAcknowledged`), or the older
 *  bare list. */
export function readsOf(res) {
  if (Array.isArray(res)) return { rows: res, notAcknowledged: null };
  const rows = Array.isArray(res?.reads) ? res.reads : [];
  const pending = Array.isArray(res?.notAcknowledged) ? res.notAcknowledged : null;
  return { rows, notAcknowledged: pending };
}

const pad2 = (n) => String(n).padStart(2, '0');
/** An ISO instant -> { date: 'YYYY-MM-DD', time: 'HH:MM' } on this computer's clock. */
export function splitLocal(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return { date: '', time: '' };
  return { date: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`, time: `${pad2(d.getHours())}:${pad2(d.getMinutes())}` };
}
/** A local date + 'HH:MM' -> ISO instant; '' until both are set. */
export function joinLocal(date, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !/^\d{2}:\d{2}$/.test(time || '')) return '';
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const dt = new Date(y, m - 1, d, hh, mm, 0, 0);
  return Number.isNaN(dt.getTime()) ? '' : dt.toISOString();
}

export default function Announcements({ phone }) {
  const { can, myEmail } = useRole();
  const isAdmin = typeof can === 'function' && can('administrator');
  const isMobileViewport = useIsMobile();
  // The grid says when the board is a phone stack; outside it, the viewport.
  const isMobile = phone ?? isMobileViewport;
  const [items, setItems] = useState(null);       // null = first load pending
  const [error, setError] = useState('');
  const [open, setOpen] = useState(() => new Set());
  const [showAll, setShowAll] = useState(false);
  const [composer, setComposer] = useState(null); // null | { id?, form }
  const [readsFor, setReadsFor] = useState(null); // { id, rows: null | [], notAcknowledged?: [], error }
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
      // Refetch after the mark lands so an administrator's read counts move too.
      api.markAnnouncementRead(a.id).then(() => load()).catch(() => {});
    }
  };

  const ack = (a) => {
    const now = new Date().toISOString();
    patchItem(a.id, { acknowledged_at: now, read_at: a.read_at || now });
    api.ackAnnouncement(a.id).then(() => load()).catch(() => { patchItem(a.id, { acknowledged_at: '' }); });
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
      // { reads, notAcknowledged? } today; a plain list from an older API still renders.
      .then(res => setReadsFor(cur => (cur?.id === a.id ? { id: a.id, ...readsOf(res), error: '' } : cur)))
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
        <Composer key={composer.id || 'new'} initial={composer.form} editingId={composer.id} isMobile={isMobile}
          onCancel={() => setComposer(null)}
          onSaved={() => { setComposer(null); load(); }} />
      )}
      {!items ? (
        <WidgetSkeleton />
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
              onEdit={() => setComposer({ id: a.id, form: { ...formOf(a), notified_at: a.notified_at || '' } })} onDelete={() => remove(a)}
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
  // The admin links sit in the meta line: 36px tall on a phone (a 16px text
  // link is not a tap target), inline text on a desktop.
  const metaLink = isMobile ? { ...linkBtn, minHeight: 36, padding: '0 6px', display: 'inline-flex', alignItems: 'center' } : linkBtn;
  // A scheduled post is dated by the day it published, not the day it was written.
  const meta = [a.author_name || a.author_email, formatDate(a.shown_at || a.created_at)].filter(Boolean).join(' - ');
  const stop = (fn) => (e) => { e.stopPropagation(); fn(); };
  const acks = isAdmin ? ackSummary(a) : '';
  return (
    <div className={needsAck ? 'nx-needs-you--row' : undefined} style={{ borderBottom: '1px solid var(--line, #eef0f3)' }}>
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
            {a.audience === 'site' && a.workSiteName && (
              <span data-testid="ann-site" style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--muted)', border: '1px solid var(--line, #e5e7eb)', borderRadius: 99, padding: '0 6px', flexShrink: 0 }}>{a.workSiteName}</span>
            )}
          </span>
          <span style={expanded
            // overflowWrap: a long URL breaks inside the card instead of
            // scrolling the whole tile sideways.
            ? { display: 'block', fontSize: 12.5, color: 'var(--ink)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', marginTop: 4, lineHeight: 1.5 }
            : { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', overflowWrap: 'anywhere', fontSize: 12.5, color: 'var(--muted)', marginTop: 2, lineHeight: 1.45 }}>
            {a.body}
          </span>
          {expanded && a.image_url && (
            <img src={toViewUrl(a.image_url)} alt={`Picture for ${a.title}`} data-testid="ann-image"
              style={{ display: 'block', marginTop: 8, maxWidth: '100%', maxHeight: 280, borderRadius: 8, border: '1px solid var(--line, #e5e7eb)' }} />
          )}
          {a.file_url && (
            <a href={toViewUrl(a.file_url)} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}
              style={{ ...linkBtn, display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 6, textDecoration: 'none', ...(isMobile ? { minHeight: 36 } : {}) }}>
              <Paperclip size={12} /> {a.file_name || 'Attachment'}
            </a>
          )}
          <span style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 12px', fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}>
            <span>{meta}</span>
            {a.pinned && a.pinned_until && <span>Pinned until {formatDate(a.pinned_until)}</span>}
            {!expanded && a.image_url && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><Image size={11} /> Picture</span>}
            {isAdmin && a.scheduled && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'hsl(var(--color-orange))', fontWeight: 600 }}>
                <CalendarClock size={12} /> Scheduled for {formatDateTime(a.publish_at)}
              </span>
            )}
            {a.acknowledged_at && <span style={{ color: 'hsl(var(--color-green))', fontWeight: 600 }}>Acknowledged</span>}
            {isAdmin && (
              <>
                <button type="button" onClick={stop(onReads)} style={metaLink}>Read by {a.read_count ?? 0}{a.requires_ack && !acks ? `, acknowledged by ${a.ack_count ?? 0}` : ''}</button>
                {acks && <span data-testid="ann-acks">{acks}</span>}
                <button type="button" onClick={stop(onEdit)} style={metaLink}>Edit</button>
                <button type="button" onClick={stop(onDelete)} style={{ ...metaLink, color: 'hsl(var(--color-red))' }}>Delete</button>
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
  const pending = reads.notAcknowledged;
  return (
    <div style={{ margin: '0 8px 10px 26px', padding: '8px 10px', borderRadius: 8, background: 'var(--mist)', fontSize: 12 }}>
      {reads.rows === null ? (
        <WidgetSkeleton />
      ) : reads.error ? (
        <div style={{ color: 'var(--muted)' }}>{reads.error}</div>
      ) : (
        <>
          {reads.rows.length === 0 ? (
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
          {Array.isArray(pending) && (
            // Who still owes an acknowledgment: the post's audience minus the
            // acknowledgers (the server's one audience rule), by name.
            <div data-testid="ann-not-acked" style={{ marginTop: reads.rows.length ? 8 : 6, paddingTop: reads.rows.length ? 8 : 0, borderTop: reads.rows.length ? '1px solid var(--line, #e5e7eb)' : 'none' }}>
              <div style={{ fontWeight: 600, color: pending.length ? 'hsl(var(--color-orange))' : 'hsl(var(--color-green))' }}>
                {pending.length ? `Not Yet Acknowledged (${pending.length})` : 'Everyone Has Acknowledged'}
              </div>
              {pending.length > 0 && (
                <div style={{ color: 'var(--ink)', marginTop: 2, overflowWrap: 'anywhere' }}>{pending.map(p => p.name || p.email).join(', ')}</div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Composer({ initial, editingId, isMobile, onCancel, onSaved }) {
  const [form, setForm] = useState(() => ({ ...EMPTY_FORM, ...initial }));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  // Publish Later: on when the post being edited is still scheduled; the
  // date and time are this computer's clock, sent as one ISO instant.
  const published = !!initial?.notified_at;
  const [later, setLater] = useState(() => !!initial?.publish_at && !published);
  const [when, setWhen] = useState(() => splitLocal(initial?.publish_at));
  const [upload, setUpload] = useState(null);   // null | { kind: 'image'|'file', pct }
  // The work-site library, fetched the first time the audience is Work Site.
  const [sites, setSites] = useState(null);     // null = not loaded yet
  const [sitesErr, setSitesErr] = useState('');
  useEffect(() => {
    if (form.audience !== 'site' || sites !== null) return undefined;
    let on = true;
    api.getWorkSites()
      .then(rows => { if (on) { setSites(Array.isArray(rows) ? rows : []); setSitesErr(''); } })
      .catch(err => { if (on) { setSites([]); setSitesErr(err?.message || 'Could not load the work sites.'); } });
    return () => { on = false; };
  }, [form.audience, sites]);
  const imageRef = useRef(null);
  const fileRef = useRef(null);
  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const tap = isMobile ? { minHeight: 44 } : {};

  const attach = async (file, kind) => {
    if (!file) return;
    if (kind === 'image' && !file.type?.startsWith('image/')) { setErr('That file is not a picture.'); return; }
    // Size first, in a sentence - the uploader's own refusal is terse.
    if (kind === 'image' && file.size > IMAGE_MAX_BYTES) { setErr('That picture is larger than 10 MB.'); return; }
    if (kind === 'file' && file.size > FILE_MAX_BYTES) { setErr('That file is larger than 25 MB.'); return; }
    setErr(''); setUpload({ kind, pct: 0 });
    try {
      const folder = `${UPLOAD_FOLDER}/${editingId || 'new'}`;
      const url = await storeTaskFile(file, (p) => setUpload({ kind, pct: p }), folder, kind === 'image' ? IMAGE_MAX_BYTES : FILE_MAX_BYTES);
      if (!url) throw new Error('Could not upload that file. Try again.');
      setForm(f => (kind === 'image' ? { ...f, image_url: url } : { ...f, file_url: url, file_name: file.name || 'Attachment' }));
    } catch (ex) {
      setErr(ex?.message || 'Could not upload that file.');
    } finally {
      setUpload(null);
    }
  };
  const onPaste = (e) => {
    const [img] = filesFromPaste(e);
    if (img) { e.preventDefault(); attach(img, 'image'); }
  };
  // 16px on a phone: iOS zooms the page into any smaller focused field.
  const field = isMobile ? { ...fieldStyle, fontSize: 16 } : fieldStyle;
  // The composer opens at the top of the card's scroll area; Edit is pressed
  // on a row that may be far below it - bring the form into view.
  const formRef = useRef(null);
  useEffect(() => { formRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }); }, [editingId]);
  // The tile can sit in a one-third desktop column: under 520px the paired
  // rows (Audience | Pinned Until, Notify | Publish Later) stack like a phone.
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = formRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver((entries) => { const w = entries[0]?.contentRect?.width || 0; setNarrow(w > 0 && w <= NARROW_PX); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const stack = isMobile || narrow;

  const submit = async (e) => {
    e.preventDefault();
    const title = form.title.trim();
    const body = form.body.trim();
    if (!title) { setErr('Give the announcement a title.'); return; }
    if (!body) { setErr('Write the announcement.'); return; }
    if (form.audience === 'department' && !form.department.trim()) { setErr('Name the department.'); return; }
    if (form.audience === 'site' && !form.work_site_id) { setErr('Pick the work site.'); return; }
    if (upload) { setErr('Wait for the upload to finish.'); return; }
    let publish_at = '';
    if (later && !published) {
      publish_at = joinLocal(when.date, when.time);
      if (!publish_at) { setErr('Pick the date and time to publish.'); return; }
      if (new Date(publish_at).getTime() < Date.now()) { setErr('The publish time has already passed.'); return; }
    }
    const payload = {
      title, body, audience: form.audience,
      department: form.audience === 'department' ? form.department.trim() : '',
      work_site_id: form.audience === 'site' ? form.work_site_id : '',
      pinned_until: form.pinned_until || '', requires_ack: !!form.requires_ack,
      image_url: form.image_url || '', file_url: form.file_url || '', file_name: form.file_url ? (form.file_name || '') : '',
      notify: form.notify || 'quiet',
    };
    // A published post keeps its publish time (the server refuses a change).
    if (!published) payload.publish_at = publish_at;
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
    <form ref={formRef} onSubmit={submit} aria-label={editingId ? 'Edit Announcement' : 'Post Announcement'}
      style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: isMobile ? '10px 0 14px' : '10px 8px 14px', marginBottom: 8, borderBottom: '1px solid var(--line, #eef0f3)' }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)' }}>{editingId ? 'Edit Announcement' : 'New Announcement'}</div>
      <label>
        <span style={labelStyle}>Title</span>
        <input value={form.title} onChange={set('title')} maxLength={200} placeholder="What should people know?" style={{ ...field, ...tap }} />
      </label>
      <label>
        <span style={labelStyle}>Body</span>
        <textarea value={form.body} onChange={set('body')} onPaste={onPaste} maxLength={20000} rows={isMobile ? 5 : 4} placeholder="Plain text, line breaks are kept." style={{ ...field, resize: 'vertical' }} />
      </label>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <input ref={imageRef} type="file" accept="image/*" aria-label="Picture file" style={{ display: 'none' }}
          onChange={(e) => { attach(e.target.files?.[0], 'image'); e.target.value = ''; }} />
        <input ref={fileRef} type="file" aria-label="Attachment file" style={{ display: 'none' }}
          onChange={(e) => { attach(e.target.files?.[0], 'file'); e.target.value = ''; }} />
        {form.image_url ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <img src={toViewUrl(form.image_url)} alt="Picture to post" data-testid="ann-image-preview" style={{ width: 56, height: 40, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--line, #e5e7eb)' }} />
            <button type="button" onClick={() => setForm(f => ({ ...f, image_url: '' }))} aria-label="Remove picture" style={{ ...linkBtn, display: 'inline-flex', alignItems: 'center', gap: 3, ...tap }}><X size={12} /> Remove Picture</button>
          </span>
        ) : (
          <button type="button" className="secondary-btn" disabled={!!upload} onClick={() => imageRef.current?.click()} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, ...tap }}>
            <ImagePlus size={13} /> {upload?.kind === 'image' ? `Uploading ${Math.round((upload.pct || 0) * 100)}%` : 'Add Picture'}
          </button>
        )}
        {form.file_url ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--ink)' }}>
            <Paperclip size={12} /> {form.file_name || 'Attachment'}
            <button type="button" onClick={() => setForm(f => ({ ...f, file_url: '', file_name: '' }))} aria-label="Remove file" style={{ ...linkBtn, display: 'inline-flex', alignItems: 'center', gap: 3, ...tap }}><X size={12} /> Remove</button>
          </span>
        ) : (
          <button type="button" className="secondary-btn" disabled={!!upload} onClick={() => fileRef.current?.click()} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, ...tap }}>
            <Paperclip size={13} /> {upload?.kind === 'file' ? `Uploading ${Math.round((upload.pct || 0) * 100)}%` : 'Add File'}
          </button>
        )}
        {!form.image_url && !isMobile && <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>or press Ctrl+V in the body to paste a picture</span>}
      </div>
      <div style={{ display: 'flex', flexDirection: stack ? 'column' : 'row', gap: 10 }}>
        <label style={{ flex: 1 }}>
          <span style={labelStyle}>Audience</span>
          <select value={form.audience} onChange={set('audience')} aria-label="Audience" style={{ ...field, ...tap }}>
            <option value="company">Company</option>
            <option value="department">Department</option>
            <option value="site">Work Site</option>
          </select>
        </label>
        {form.audience === 'department' && (
          <label style={{ flex: 1 }}>
            <span style={labelStyle}>Department</span>
            <input value={form.department} onChange={set('department')} maxLength={120} placeholder="e.g. Operations" style={{ ...field, ...tap }} />
          </label>
        )}
        {form.audience === 'site' && (
          <label style={{ flex: 1 }}>
            <span style={labelStyle}>Work Site</span>
            <select value={form.work_site_id} onChange={set('work_site_id')} aria-label="Work Site" style={{ ...field, ...tap }}>
              <option value="">{sites === null ? 'Loading sites...' : 'Pick a site'}</option>
              {(sites || []).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <span style={{ display: 'block', fontSize: 11.5, color: sitesErr ? 'hsl(var(--color-red))' : 'var(--muted)', marginTop: 4 }}>
              {sitesErr || 'Reaches the people whose allowed work sites include this one.'}
            </span>
          </label>
        )}
        <label style={{ flex: 1 }}>
          <span style={labelStyle}>Pinned Until</span>
          <DateField value={form.pinned_until} onChange={(v) => setForm(f => ({ ...f, pinned_until: v || '' }))} placeholder="Not pinned" title="Pinned until" style={{ ...field, ...tap }} />
        </label>
      </div>
      <div style={{ display: 'flex', flexDirection: stack ? 'column' : 'row', gap: 10 }}>
        <label style={{ flex: 1 }}>
          <span style={labelStyle}>Notify</span>
          <select value={form.notify} onChange={set('notify')} aria-label="Notify" style={{ ...field, ...tap }}>
            {NOTIFY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <span style={{ display: 'block', fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}>
            Everyone in the audience gets a bell, and a phone notification if they installed Nexus. Teams sends each person a message as you; Email sends a mail.
          </span>
        </label>
        <div style={{ flex: 1 }}>
          {published ? (
            <>
              <span style={labelStyle}>Published</span>
              <div style={{ fontSize: 12.5, color: 'var(--ink)', padding: '8px 0' }}>{formatDateTime(initial.notified_at)}</div>
            </>
          ) : (
            <>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--ink)', ...tap }}>
                <input type="checkbox" checked={later} onChange={(e) => setLater(e.target.checked)} /> Publish Later
              </label>
              {later && (
                <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                  <DateField value={when.date} onChange={(v) => setWhen(w => ({ ...w, date: v || '' }))} placeholder="Date" title="Publish date" noPast style={{ ...field, flex: 1, ...tap }} />
                  <TimeField value={when.time} onChange={(v) => setWhen(w => ({ ...w, time: v }))} ariaLabel="Publish time" style={{ ...field, flex: 1, ...tap }} />
                </div>
              )}
            </>
          )}
        </div>
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--ink)', ...tap }}>
        <input type="checkbox" checked={!!form.requires_ack} onChange={set('requires_ack')} /> Requires Acknowledgment
      </label>
      {err && <div role="alert" style={{ fontSize: 12, color: 'hsl(var(--color-red))' }}>{err}</div>}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        <button type="button" className="secondary-btn" onClick={onCancel} disabled={busy} style={tap}>Cancel</button>
        <button type="submit" className="primary-btn" disabled={busy} style={tap}>{busy ? 'Saving...' : editingId ? 'Save Changes' : later && !published ? 'Schedule Announcement' : 'Post Announcement'}</button>
      </div>
    </form>
  );
}

// What's New after release (Oct 18 2026): feature requests with a status,
// known issues and rollbacks, deprecations with a countdown, guided tours,
// screenshots and attachments in storage, and Live in Production.
// ChangelogView.jsx and changelogExtras.jsx compose these; the server side
// is backend/routers/changelog_lifecycle.py.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, CheckCircle2, Lightbulb, Paperclip, Download, Upload, X, Trash2, CalendarX, Compass,
  ChevronLeft, ChevronRight, ChevronUp, ChevronDown, Plus, ArrowRight, ImageIcon,
  MessageSquare, Send, Ticket as TicketIcon, ArrowLeft, ListChecks,
} from 'lucide-react';
import { api } from '../api';
import { NX, FONT, btn, card, chip, input as inputStyle } from './theme';
import { Avatar, Modal, useIsMobile } from './components';
import { setPendingOpen } from '../lib/pendingOpen';
import { LoadingState } from '../components/AsyncState';
import { filesFromPaste, storeTaskFile } from './lib';
import { toDownloadUrl } from '../lib/storageView';
import { formatDateTime, formatFullDate } from './changelogDates';

const label11 = { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: NX.faint };

// ── Feature requests ───────────────────────────────────────────────────────
// The same words, in the same order, as changelog_lifecycle.REQUEST_STATUSES.
export const REQUEST_STATUSES = ['New', 'Under Review', 'Planned', 'In Progress', 'Shipped', 'Declined'];
const REQUEST_META = {
  New: [NX.dim, 'rgba(128,140,160,0.16)'],
  'Under Review': ['#d97706', 'rgba(217,119,6,0.16)'],
  Planned: ['#2563eb', 'rgba(37,99,235,0.15)'],
  'In Progress': ['#7c3aed', 'rgba(124,58,237,0.15)'],
  Shipped: ['#16a34a', 'rgba(22,163,74,0.15)'],
  Declined: ['#5b6472', 'rgba(128,140,160,0.16)'],
};
export function RequestStatusChip({ status }) {
  const [c, t] = REQUEST_META[status] || REQUEST_META.New;
  return <span style={chip(c, t)}>{status || 'New'}</span>;
}

// Manage: set a request's status, a note for the requester, and - when it
// shipped - the update that delivered it. The requester's bell follows.
export function RequestStatusEditor({ row, entries, onSaved, flash }) {
  const [status, setStatus] = useState(row.status || 'New');
  const [note, setNote] = useState(row.statusNote || '');
  const [shipped, setShipped] = useState(row.shippedEntryId || '');
  const [saving, setSaving] = useState(false);
  const dirty = status !== (row.status || 'New') || note !== (row.statusNote || '') || (status === 'Shipped' && shipped !== (row.shippedEntryId || ''));
  const save = async () => {
    setSaving(true);
    try {
      const r = await api.setChangelogRequestStatus(row.id, { status, note, shippedEntryId: status === 'Shipped' ? shipped : '' });
      onSaved?.(r);
      flash?.(status === 'Shipped' && shipped && !r?.shippedReleased
        ? 'Saved - its ticket was updated, and the requester hears once that update is released.'
        : (row.ticketId ? 'Saved - its ticket was updated and the requester was told.' : 'Saved - the requester was told.'));
    } catch (e) { flash?.(e?.message || 'Could not save the status.', true); } finally { setSaving(false); }
  };
  const options = (entries || []).filter((e) => e.id !== row.entryId);
  return (
    <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
      <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Request status" style={{ ...inputStyle, width: 'auto', padding: '5px 8px' }}>
        {REQUEST_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
      {status === 'Shipped' && (
        <select value={shipped} onChange={(e) => setShipped(e.target.value)} aria-label="Shipped in" style={{ ...inputStyle, width: 'auto', maxWidth: 280, padding: '5px 8px' }}>
          <option value="">Shipped In… (optional)</option>
          {options.slice(0, 300).map((e) => <option key={e.id} value={e.id}>{e.title}</option>)}
        </select>
      )}
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note for the requester (optional)" aria-label="Note for the requester"
        style={{ ...inputStyle, flex: '1 1 200px', padding: '5px 8px' }} />
      <button type="button" onClick={save} disabled={!dirty || saving} style={{ ...btn('primary'), padding: '5px 12px', opacity: dirty && !saving ? 1 : 0.5 }}>Save</button>
    </div>
  );
}

// A request IS a Feature Request ticket (Oct 23 2026, backend
// feature_requests.py): its conversation is the ticket's thread, read and
// written here, so a reply in What's New and one in the ticket drawer are
// the same reply. Internal desk notes never show here.
export function openRequestTicket(ticketId) {
  window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'support' } }));
  setPendingOpen('ticket', ticketId);
  window.setTimeout(() => window.dispatchEvent(new CustomEvent('nexus:open-ticket', { detail: { ticketId } })), 0);
}

export function RequestThread({ row, nameOf = (e) => e, onBeforeOpen }) {
  const [open, setOpen] = useState(false);
  const [comments, setComments] = useState(null);
  const [count, setCount] = useState(row.commentCount || 0);
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState('');
  const load = () => api.getChangelogRequestComments(row.id)
    .then((r) => { setComments(r || []); setCount((r || []).length); })
    .catch(() => setComments((c) => c || []));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (open && row.ticketId) load(); }, [open, row.id]);
  if (!row.ticketId) return null;
  const post = async () => {
    const text = draft.trim();
    if (!text || posting) return;
    setPosting(true); setError('');
    try { await api.addChangelogRequestComment(row.id, text); setDraft(''); await load(); }
    catch (e) { setError(e?.message || 'Could not post the comment.'); } finally { setPosting(false); }
  };
  const ready = draft.trim() && !posting;
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 14 }}>
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
          style={{ ...btn('ghost'), padding: 0, fontSize: 12.5, color: NX.dim }}>
          <MessageSquare size={13} />{count} {count === 1 ? 'Comment' : 'Comments'}{open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
        {row.ticketCode && (
          <button type="button" onClick={() => { onBeforeOpen?.(); openRequestTicket(row.ticketId); }} title="Open the ticket this request is"
            style={{ ...btn('ghost'), padding: 0, fontSize: 12.5, color: NX.blue }}>
            <TicketIcon size={13} />{row.ticketCode}<ArrowRight size={12} />
          </button>
        )}
      </div>
      {open && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {comments === null ? <LoadingState /> : comments.length === 0 ? (
            <div style={{ fontSize: 12.5, color: NX.dim }}>No comments yet. Replies from the Nexus team show here and on the ticket.</div>
          ) : comments.map((c) => (
            <div key={c.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <Avatar email={c.authorId} name={nameOf(c.authorId)} size={22} />
              <div style={{ minWidth: 0, flex: 1, borderRadius: 8, background: NX.surface2, padding: '6px 10px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: NX.ink }}>{nameOf(c.authorId)}</span>
                  {c.createdAt && <span style={{ fontSize: 11, color: NX.faint }}>{formatDateTime(c.createdAt)}</span>}
                </div>
                <div style={{ marginTop: 2, fontSize: 13, color: NX.ink, whiteSpace: 'pre-wrap' }}>{c.text}</div>
              </div>
            </div>
          ))}
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={1} aria-label="Comment on this request"
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); post(); } }}
              placeholder="Write a comment..." style={{ ...inputStyle, display: 'block', flex: 1, minHeight: 38, resize: 'vertical', fontFamily: FONT }} />
            <button type="button" onClick={post} disabled={!ready} aria-label="Post comment"
              style={{ ...btn('primary'), width: 38, height: 38, padding: 0, justifyContent: 'center', flexShrink: 0, opacity: ready ? 1 : 0.4 }}><Send size={15} /></button>
          </div>
          {error && <div role="alert" style={{ fontSize: 12, color: NX.red }}>{error}</div>}
        </div>
      )}
    </div>
  );
}

// Anyone: a box to ask for something, and - behind the My Requests button -
// what happened to everything asked for so far (Sagar, Oct 27 2026: the list
// used to sit under the form; now the form fills the popup's 60% and the list
// is one click away, landing there after a request is sent).
export function MyRequestsDialog({ onClose, onOpenEntry, nameOf }) {
  const [view, setView] = useState('new');   // 'new' | 'mine'
  const [rows, setRows] = useState(null);
  const [note, setNote] = useState('');
  const [module, setModule] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const load = () => api.getMyChangelogRequests().then((r) => setRows(r || [])).catch(() => setRows([]));
  useEffect(() => { load(); }, []);
  const send = async () => {
    if (!note.trim()) return;
    setSending(true); setError('');
    try {
      await api.raiseChangelogRequest({ note: note.trim(), module: module.trim() });
      setNote(''); setModule('');
      await load();
      setView('mine');   // show it with the rest, and its status
    } catch (e) { setError(e?.message || 'Could not send the request.'); } finally { setSending(false); }
  };
  const count = rows ? rows.length : 0;
  return (
    <Modal title="Feature Request" onClose={onClose} isDirty={!!note.trim()}>
      {view === 'new' ? (
        <div className="nx-fill" style={{ ...card, padding: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 700, color: NX.ink, flex: 1, minWidth: 0 }}><Lightbulb size={14} />Request a Feature</div>
            <button type="button" onClick={() => setView('mine')} style={{ ...btn('outline'), fontSize: 12.5, padding: '5px 10px' }}>
              <ListChecks size={14} />My Requests{count ? ` (${count})` : ''}
            </button>
          </div>
          <p style={{ margin: '4px 0 10px', fontSize: 12, color: NX.dim }}>Tell the Nexus team what would make your work easier. It becomes a Feature Request ticket and is shared with the Nexus team on Teams. You will see its status and replies under My Requests, and your bell rings when it changes.</p>
          <div className="nx-fill">
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} aria-label="What would you like?"
              placeholder="What would you like Nexus to do?" style={{ ...inputStyle, resize: 'vertical', fontFamily: FONT }} />
          </div>
          <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <input value={module} onChange={(e) => setModule(e.target.value)} placeholder="Module (optional), e.g. Time Clock" aria-label="Module"
              style={{ ...inputStyle, flex: '1 1 200px' }} />
            <button type="button" onClick={send} disabled={!note.trim() || sending} style={{ ...btn('primary'), opacity: note.trim() && !sending ? 1 : 0.5 }}>Send Request</button>
          </div>
          {error && <div role="alert" style={{ marginTop: 6, fontSize: 12, color: NX.red }}>{error}</div>}
        </div>
      ) : (
        <div className="nx-fill">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <h3 style={{ ...label11, margin: 0, flex: 1 }}>My Requests{count ? ` (${count})` : ''}</h3>
            <button type="button" onClick={() => setView('new')} style={{ ...btn('outline'), fontSize: 12.5, padding: '5px 10px' }}>
              <ArrowLeft size={14} />New Request
            </button>
          </div>
          {rows === null ? <LoadingState /> : rows.length === 0 ? (
            <div style={{ borderRadius: 12, border: `1px dashed ${NX.border}`, padding: '28px 0', textAlign: 'center', fontSize: 13, color: NX.dim }}>You have not asked for anything yet.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {rows.map((r) => (
                <div key={r.id} style={{ ...card, padding: '10px 14px' }}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                    <RequestStatusChip status={r.status} />
                    <span style={{ fontSize: 12, color: NX.faint }}>
                      {r.entryTitle ? `On "${r.entryTitle}"` : (r.module || 'General')} · {formatDateTime(r.at)}
                    </span>
                  </div>
                  <div style={{ marginTop: 6, fontSize: 13, color: NX.ink, whiteSpace: 'pre-wrap' }}>{r.note}</div>
                  {r.statusNote && <div style={{ marginTop: 6, fontSize: 12.5, color: NX.dim }}><strong>Nexus team:</strong> {r.statusNote}</div>}
                  {r.status === 'Shipped' && r.shippedEntryId && (
                    r.shippedReleased ? (
                      <button type="button" onClick={() => { onClose(); onOpenEntry?.(r.shippedEntryId); }} style={{ ...btn('ghost'), padding: 0, marginTop: 6, color: NX.blue, fontSize: 12.5 }}>
                        Shipped In: {r.shippedTitle} <ArrowRight size={13} />
                      </button>
                    ) : <div style={{ marginTop: 6, fontSize: 12.5, color: NX.dim }}>Goes out with &quot;{r.shippedTitle}&quot; soon.</div>
                  )}
                  <RequestThread row={r} nameOf={nameOf} onBeforeOpen={onClose} />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

// ── Known issues and rollbacks ─────────────────────────────────────────────
export function issueOf(entry) {
  const i = entry?.issue;
  if (!i || !i.kind) return null;
  return { ...i, active: !i.resolvedAt };
}
const ISSUE_LOOK = {
  known: { label: 'Known Issue', color: '#b45309', tint: 'rgba(217,119,6,0.14)' },
  rolledBack: { label: 'Rolled Back', color: '#b91c1c', tint: 'rgba(220,38,38,0.12)' },
  fixed: { label: 'Fixed', color: '#15803d', tint: 'rgba(22,163,74,0.13)' },
};
export function IssueChip({ entry }) {
  const i = issueOf(entry);
  if (!i) return null;
  const look = i.active ? ISSUE_LOOK[i.kind] || ISSUE_LOOK.known : ISSUE_LOOK.fixed;
  return <span style={chip(look.color, look.tint)}>{i.active ? <AlertTriangle size={12} /> : <CheckCircle2 size={12} />}{look.label}</span>;
}

export function IssueBanner({ entry, all, onOpen }) {
  const i = issueOf(entry);
  if (!i) return null;
  const fix = i.fixId ? (all || []).find((x) => x.id === i.fixId) : null;
  if (!i.active) {
    return (
      <div role="note" style={{ marginTop: 12, display: 'flex', gap: 8, borderRadius: 8, background: ISSUE_LOOK.fixed.tint, color: ISSUE_LOOK.fixed.color, padding: '9px 12px', fontSize: 13 }}>
        <CheckCircle2 size={15} style={{ flexShrink: 0, marginTop: 1 }} />
        <span>
          <strong>Fixed {formatFullDate(i.resolvedAt)}</strong>{i.resolvedNote ? `: ${i.resolvedNote}` : ''}
          {fix && <> <button type="button" onClick={() => onOpen?.(fix.id)} style={{ ...btn('ghost'), padding: 0, fontSize: 13, color: 'inherit', textDecoration: 'underline' }}>See the fix</button></>}
        </span>
      </div>
    );
  }
  const look = ISSUE_LOOK[i.kind] || ISSUE_LOOK.known;
  return (
    <div role="alert" style={{ marginTop: 12, display: 'flex', gap: 8, borderRadius: 8, background: look.tint, color: look.color, padding: '9px 12px', fontSize: 13 }}>
      <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
      <span>
        <strong>{look.label}</strong> since {formatFullDate(i.at)}: {i.note}
        {i.workaround && <><br /><strong>Workaround:</strong> {i.workaround}</>}
      </span>
    </div>
  );
}

// Admins: report, edit, resolve or take back an issue on a released update.
export function IssueDialog({ entry, all, onClose, onSaved, flash }) {
  const i = issueOf(entry);
  const open = !!i?.active;
  const [kind, setKind] = useState(open ? i.kind : 'known');
  const [note, setNote] = useState(open ? i.note || '' : '');
  const [workaround, setWorkaround] = useState(open ? i.workaround || '' : '');
  const [resolveNote, setResolveNote] = useState('');
  const [fixId, setFixId] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (fn, done) => {
    setBusy(true);
    try { onSaved?.(await fn()); flash?.(done); onClose(); } catch (e) { flash?.(e?.message || 'Could not save.', true); setBusy(false); }
  };
  const fixes = (all || []).filter((x) => x.id !== entry.id);
  const footer = (<>
    {open && (
      <button type="button" disabled={busy} onClick={() => window.confirm('Take this issue off the update? Its bell notices go too.')
        && run(() => api.clearChangelogIssue(entry.id), 'Issue removed.')} style={{ ...btn('ghost'), color: NX.red, marginRight: 'auto' }}>
        <Trash2 size={13} />Remove
      </button>
    )}
    <button type="button" onClick={onClose} style={btn('outline')}>Cancel</button>
    <button type="button" disabled={!note.trim() || busy} onClick={() => run(() => api.raiseChangelogIssue(entry.id, { kind, note: note.trim(), workaround: workaround.trim() }),
      open ? 'Issue updated.' : 'Issue reported - readers and followers were told.')}
    style={{ ...btn('primary'), opacity: note.trim() && !busy ? 1 : 0.5 }}>{open ? 'Save Issue' : 'Report Issue'}</button>
  </>);
  return (
    <Modal title={open ? 'Known Issue' : 'Report an Issue'} onClose={onClose} footer={footer} isDirty={!!note.trim() && !open}>
      <p style={{ margin: '0 0 14px', fontSize: 13, color: NX.dim }}>
        Everyone who read &quot;{entry.title}&quot; and the people following its module get a bell, and the screen it changed shows the issue until you mark it resolved.
      </p>
      <div role="radiogroup" aria-label="Kind" style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        {[['known', 'Known Issue', 'Still live, with a problem'], ['rolledBack', 'Rolled Back', 'Taken out again']].map(([k, label, hint]) => (
          <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)} style={{
            ...btn('outline'), flex: 1, flexDirection: 'column', alignItems: 'flex-start', gap: 2, padding: '8px 12px',
            ...(kind === k ? { borderColor: ISSUE_LOOK[k].color, color: ISSUE_LOOK[k].color, background: ISSUE_LOOK[k].tint } : null),
          }}><span>{label}</span><span style={{ fontSize: 11, fontWeight: 500, color: NX.dim }}>{hint}</span></button>
        ))}
      </div>
      <div style={{ fontSize: 12, fontWeight: 600, color: NX.dim, marginBottom: 5 }}>What is wrong</div>
      <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} aria-label="What is wrong"
        placeholder="e.g. Totals on the export double-count split shifts." style={{ ...inputStyle, resize: 'vertical', fontFamily: FONT, marginBottom: 12 }} />
      <div style={{ fontSize: 12, fontWeight: 600, color: NX.dim, marginBottom: 5 }}>Workaround (optional)</div>
      <input value={workaround} onChange={(e) => setWorkaround(e.target.value)} aria-label="Workaround"
        placeholder="e.g. Use the old Payroll Export until it is fixed." style={inputStyle} />
      {open && (
        <div style={{ ...card, padding: 14, marginTop: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 700, color: NX.ink }}><CheckCircle2 size={14} />Mark Resolved</div>
          <p style={{ margin: '4px 0 10px', fontSize: 12, color: NX.dim }}>The same people hear it is fixed; the update keeps a green Fixed note.</p>
          <input value={resolveNote} onChange={(e) => setResolveNote(e.target.value)} aria-label="Resolution note"
            placeholder="What changed (optional)" style={{ ...inputStyle, marginBottom: 8 }} />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <select value={fixId} onChange={(e) => setFixId(e.target.value)} aria-label="Fixed by" style={{ ...inputStyle, flex: '1 1 220px' }}>
              <option value="">Fixed By… (optional)</option>
              {fixes.slice(0, 300).map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}
            </select>
            <button type="button" disabled={busy} onClick={() => run(() => api.resolveChangelogIssue(entry.id, { note: resolveNote.trim(), fixEntryId: fixId }),
              'Marked resolved - readers and followers were told.')} style={{ ...btn('primary'), background: '#16a34a', borderColor: '#16a34a' }}>
              <CheckCircle2 size={13} />Mark Resolved
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ── Deprecations ───────────────────────────────────────────────────────────
// Whole days from today (local) to a YYYY-MM-DD day; null when there is none.
export function daysUntil(day, now = new Date()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(day || ''));
  if (!m) return null;
  const target = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - today.getTime()) / 86_400_000);
}
const inDays = (n) => (n === 0 ? 'today' : n === 1 ? 'tomorrow' : `in ${n} days`);

export function DeprecationChip({ entry }) {
  const d = daysUntil(entry?.deprecation?.removeOn);
  if (d === null) return null;
  const day = formatFullDate(entry.deprecation.removeOn);
  return d < 0
    ? <span style={chip(NX.dim, 'rgba(128,140,160,0.16)')}><CalendarX size={12} />Removed {day}</span>
    : <span style={chip('#9a3412', 'rgba(234,88,12,0.13)')}><CalendarX size={12} />Going Away {day}</span>;
}

export function DeprecationNotice({ entry }) {
  const dep = entry?.deprecation;
  const d = daysUntil(dep?.removeOn);
  if (d === null) return null;
  const what = dep.what || entry.title || 'This';
  const day = formatFullDate(dep.removeOn);
  return (
    <div role="note" style={{ marginTop: 12, display: 'flex', gap: 8, borderRadius: 8, background: 'rgba(234,88,12,0.10)', color: '#9a3412', padding: '9px 12px', fontSize: 13 }}>
      <CalendarX size={15} style={{ flexShrink: 0, marginTop: 1 }} />
      <span>
        {d < 0 ? <><strong>{what}</strong> was removed on {day}.</> : <><strong>{what}</strong> goes away on {day} ({inDays(d)}).</>}
        {dep.replacement && <> Use <strong>{dep.replacement}</strong> instead.</>}
      </span>
    </div>
  );
}

// ── Live on dev or in production ───────────────────────────────────────────
// On the dev site a merged update is Dev Only until its commit is on main
// (the server stamps prodAt); prod's updates are written as Production.
const STAGE = {
  Production: { label: 'In Production', color: '#16a34a' },
  Staging: { label: 'Staging', color: '#d97706' },
  Beta: { label: 'Beta', color: '#2563eb' },
};
export function stageOf(entry) {
  if (!entry) return null;
  if (entry.prodAt) return { key: 'Production', ...STAGE.Production, title: `Reached production ${formatDateTime(entry.prodAt)}` };
  if (entry.origin === 'pr' && entry.environment === 'Staging') {
    return { key: 'Staging', label: 'Dev Only', color: '#d97706', title: 'Merged to the dev site - not in production yet' };
  }
  const s = STAGE[entry.environment];
  return s ? { key: entry.environment, ...s, title: s.label } : null;
}
export function StageChip({ entry }) {
  const s = stageOf(entry);
  if (!s) return null;
  return (
    <span title={s.title} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: s.color }} />{s.label}
    </span>
  );
}

// ── What needs attention: open issues and coming removals ──────────────────
export function AttentionStrip({ entries, onOpen }) {
  const issues = useMemo(() => (entries || []).filter((e) => issueOf(e)?.active), [entries]);
  const going = useMemo(() => (entries || [])
    .map((e) => ({ e, d: daysUntil(e.deprecation?.removeOn) }))
    .filter((x) => x.d !== null && x.d >= 0)
    .sort((a, b) => a.d - b.d), [entries]);
  if (!issues.length && !going.length) return null;
  const row = (key, chipEl, title, sub, id) => (
    <button key={key} type="button" onClick={() => onOpen?.(id)} style={{
      display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', cursor: 'pointer', border: 'none',
      borderTop: `1px solid ${NX.border2}`, background: 'transparent', padding: '9px 14px', fontFamily: FONT, color: NX.ink,
    }}>
      {chipEl}
      <span style={{ minWidth: 0, flex: 1 }}>
        <span style={{ display: 'block', fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
        {sub && <span style={{ display: 'block', fontSize: 12, color: NX.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sub}</span>}
      </span>
      <ArrowRight size={13} style={{ color: NX.faint, flexShrink: 0 }} />
    </button>
  );
  return (
    <div data-whats-new-attention style={{ ...card, overflow: 'hidden', marginBottom: 16 }}>
      <div style={{ ...label11, padding: '10px 14px 8px', display: 'flex', alignItems: 'center', gap: 6 }}><AlertTriangle size={12} />Needs Your Attention</div>
      {issues.map((e) => row(`i-${e.id}`, <IssueChip entry={e} />, e.title, e.issue.workaround ? `${e.issue.note} Workaround: ${e.issue.workaround}` : e.issue.note, e.id))}
      {going.map(({ e, d }) => row(`d-${e.id}`, <DeprecationChip entry={e} />, e.deprecation.what || e.title,
        `Goes away ${inDays(d)}${e.deprecation.replacement ? ` - use ${e.deprecation.replacement} instead` : ''}`, e.id))}
    </div>
  );
}

// ── Screenshots and attachments, in storage ────────────────────────────────
export const readAsDataUrl = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = reject;
  reader.readAsDataURL(file);
});
// The private task-files bucket, under whats-new/ (opened through
// /files/view like every task file). With no storage configured (a laptop)
// an image comes back as a data: URL instead.
export const uploadWhatsNewFile = (file) => storeTaskFile(file, undefined, 'whats-new');
const MAX_IMAGES = 12;
const MAX_FILES = 10;
const sizeWords = (n) => (!n ? '' : n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export function MediaEditor({ images, onImages, attachments, onAttachments }) {
  const [busy, setBusy] = useState(0);
  const [error, setError] = useState('');
  const addImages = async (files) => {
    const list = [...files].filter((f) => f.type.startsWith('image/')).slice(0, MAX_IMAGES - images.length);
    if (!list.length) return;
    setBusy((n) => n + list.length); setError('');
    for (const f of list) {
      try {
        const url = await uploadWhatsNewFile(f);
        if (url) onImages((cur) => [...cur, url]); else setError(`${f.name} is too large to keep without file storage.`);
      } catch (e) { setError(`${f.name}: ${e?.message || 'upload failed'}`); } finally { setBusy((n) => n - 1); }
    }
  };
  const addFiles = async (files) => {
    const list = [...files].slice(0, MAX_FILES - attachments.length);
    if (!list.length) return;
    setBusy((n) => n + list.length); setError('');
    for (const f of list) {
      try {
        const url = await uploadWhatsNewFile(f);
        if (!url || url.startsWith('data:')) setError('File storage is not set up here, so files cannot be attached.');
        else onAttachments((cur) => [...cur, { name: f.name, url, size: f.size, type: f.type }]);
      } catch (e) { setError(`${f.name}: ${e?.message || 'upload failed'}`); } finally { setBusy((n) => n - 1); }
    }
  };
  const onPaste = (e) => { const files = filesFromPaste(e); if (files.length) { e.preventDefault(); addImages(files); } };
  return (
    <div onPaste={onPaste} tabIndex={0} data-media-editor>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 8 }}>
        {images.map((src, i) => (
          <div key={src.slice(-40) + i} style={{ position: 'relative' }}>
            <img src={src} alt={`Screenshot ${i + 1}`} style={{ width: '100%', aspectRatio: '16 / 9', objectFit: 'cover', borderRadius: 8, border: `1px solid ${NX.border}` }} />
            <button type="button" aria-label={`Remove screenshot ${i + 1}`} onClick={() => onImages((cur) => cur.filter((_, j) => j !== i))}
              style={{ position: 'absolute', right: 4, top: 4, border: 'none', borderRadius: 6, cursor: 'pointer', background: 'rgba(0,0,0,0.6)', color: '#fff', padding: 3, display: 'inline-flex' }}><X size={12} /></button>
          </div>
        ))}
        {images.length < MAX_IMAGES && (
          <label style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4, aspectRatio: '16 / 9', cursor: 'pointer', borderRadius: 8, border: `1px dashed ${NX.border}`, textAlign: 'center', fontSize: 12, color: NX.dim, padding: 6 }}>
            <Upload size={15} />Add Screenshots
            <span style={{ fontSize: 10.5, color: NX.faint }}>or press Ctrl+V to paste</span>
            <input type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={(e) => { addImages(e.target.files || []); e.target.value = ''; }} />
          </label>
        )}
      </div>
      <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {attachments.map((a, i) => (
          <div key={a.url} style={{ display: 'flex', alignItems: 'center', gap: 8, border: `1px solid ${NX.border}`, borderRadius: 8, padding: '6px 10px', fontSize: 13 }}>
            <Paperclip size={13} style={{ color: NX.faint, flexShrink: 0 }} />
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
            <span style={{ fontSize: 11.5, color: NX.faint }}>{sizeWords(a.size)}</span>
            <button type="button" aria-label={`Remove ${a.name}`} onClick={() => onAttachments((cur) => cur.filter((_, j) => j !== i))} style={{ ...btn('ghost'), padding: 2, color: NX.faint }}><X size={13} /></button>
          </div>
        ))}
        {attachments.length < MAX_FILES && (
          <label style={{ ...btn('outline'), alignSelf: 'flex-start', cursor: 'pointer' }}>
            <Paperclip size={13} />Attach Files
            <input type="file" multiple style={{ display: 'none' }} onChange={(e) => { addFiles(e.target.files || []); e.target.value = ''; }} />
          </label>
        )}
      </div>
      {busy > 0 && <div role="status" style={{ marginTop: 6, fontSize: 12, color: NX.dim }}>Uploading {busy} file{busy === 1 ? '' : 's'}…</div>}
      {error && <div role="alert" style={{ marginTop: 6, fontSize: 12, color: NX.red }}>{error}</div>}
    </div>
  );
}

export function AttachmentList({ attachments }) {
  if (!attachments?.length) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {attachments.map((a) => (
        <a key={a.url} href={toDownloadUrl(a.url)} target="_blank" rel="noreferrer" style={{
          display: 'flex', alignItems: 'center', gap: 8, borderRadius: 8, border: `1px solid ${NX.border}`, padding: '8px 12px',
          fontSize: 13, fontWeight: 600, color: NX.ink, textDecoration: 'none' }}>
          <Paperclip size={14} style={{ color: NX.faint, flexShrink: 0 }} />
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
          <span style={{ fontSize: 12, fontWeight: 500, color: NX.faint }}>{sizeWords(a.size)}</span>
          <Download size={14} style={{ color: NX.blue, flexShrink: 0 }} />
        </a>
      ))}
    </div>
  );
}

// ── Guided tours ───────────────────────────────────────────────────────────
// Steps: a title, some text, an optional picture, and optionally the CSS
// selector of the thing to point at on the update's screen.
export function TourEditor({ value, onChange }) {
  const steps = value || [];
  const set = (i, patch) => onChange(steps.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const move = (i, d) => { const n = [...steps]; [n[i], n[i + d]] = [n[i + d], n[i]]; onChange(n); };
  const pasteImage = async (i, e) => {
    const [f] = filesFromPaste(e);
    if (!f) return;
    e.preventDefault();
    try { const url = await uploadWhatsNewFile(f); if (url) set(i, { image: url }); } catch { /* the step keeps no picture */ }
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {steps.map((s, i) => (
        <div key={i} onPaste={(e) => pasteImage(i, e)} style={{ ...card, padding: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
            <strong style={{ fontSize: 12, color: NX.dim }}>Step {i + 1}</strong>
            <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 2 }}>
              <button type="button" aria-label={`Move step ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)} style={{ ...btn('ghost'), padding: 3, opacity: i === 0 ? 0.3 : 1 }}><ChevronUp size={14} /></button>
              <button type="button" aria-label={`Move step ${i + 1} down`} disabled={i === steps.length - 1} onClick={() => move(i, 1)} style={{ ...btn('ghost'), padding: 3, opacity: i === steps.length - 1 ? 0.3 : 1 }}><ChevronDown size={14} /></button>
              <button type="button" aria-label={`Remove step ${i + 1}`} onClick={() => onChange(steps.filter((_, j) => j !== i))} style={{ ...btn('ghost'), padding: 3, color: NX.red }}><Trash2 size={14} /></button>
            </span>
          </div>
          <input value={s.title || ''} onChange={(e) => set(i, { title: e.target.value })} placeholder="Step title, e.g. Open the new filter" aria-label={`Step ${i + 1} title`} style={{ ...inputStyle, marginBottom: 6 }} />
          <textarea value={s.body || ''} onChange={(e) => set(i, { body: e.target.value })} rows={2} placeholder="What to do or notice here." aria-label={`Step ${i + 1} text`} style={{ ...inputStyle, resize: 'vertical', fontFamily: FONT, marginBottom: 6 }} />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            <input value={s.selector || ''} onChange={(e) => set(i, { selector: e.target.value })} placeholder="Point at (optional CSS selector), e.g. [data-tour=export]"
              aria-label={`Step ${i + 1} element to point at`} style={{ ...inputStyle, flex: '1 1 240px', fontFamily: 'monospace', fontSize: 12 }} />
            {s.image ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <img src={s.image} alt="" style={{ height: 34, borderRadius: 4, border: `1px solid ${NX.border}` }} />
                <button type="button" onClick={() => set(i, { image: '' })} style={{ ...btn('ghost'), padding: 0, fontSize: 12, color: NX.dim }}>Remove Picture</button>
              </span>
            ) : (
              <label style={{ ...btn('outline'), cursor: 'pointer', padding: '5px 10px', fontSize: 12 }}>
                <ImageIcon size={13} />Add Picture
                <input type="file" accept="image/*" style={{ display: 'none' }} onChange={async (e) => {
                  const f = e.target.files?.[0]; e.target.value = '';
                  if (f) { try { const url = await uploadWhatsNewFile(f); if (url) set(i, { image: url }); } catch { /* none */ } }
                }} />
              </label>
            )}
          </div>
          {!s.image && <div style={{ marginTop: 4, fontSize: 11, color: NX.faint }}>or press Ctrl+V on this step to paste a picture</div>}
        </div>
      ))}
      {steps.length < 8 && (
        <button type="button" onClick={() => onChange([...steps, { title: '', body: '', image: '', selector: '' }])} style={{ ...btn('outline'), alignSelf: 'flex-start' }}>
          <Plus size={13} />Add Step
        </button>
      )}
    </div>
  );
}

const PENDING_TOUR = 'nx-whats-new-tour';
export const TOUR_EVENT = 'nexus:whats-new-tour';
const readPending = () => { try { return JSON.parse(sessionStorage.getItem(PENDING_TOUR) || 'null'); } catch { return null; } };
const clearPending = () => { try { sessionStorage.removeItem(PENDING_TOUR); } catch { /* fine */ } };

// Take the Tour: on the update's own screen when it names one (open it
// first, the tour starts once it has loaded), else right where you are.
export function startTour(entryId, screen, currentView) {
  if (screen && screen !== currentView) {
    try { sessionStorage.setItem(PENDING_TOUR, JSON.stringify({ id: entryId, screen })); } catch { /* fine */ }
    window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: screen } }));
    return;
  }
  window.dispatchEvent(new CustomEvent(TOUR_EVENT, { detail: { id: entryId } }));
}

function findTarget(selector) {
  if (!selector) return null;
  try { return document.querySelector(selector); } catch { return null; }
}

// Mounted once for the app (inside WhatsNewHint, which App.jsx renders on
// every screen). Starts a pending tour when its screen opens, or one asked
// for with TOUR_EVENT.
export function TourHost({ view }) {
  const [tour, setTour] = useState(null);
  const [i, setI] = useState(0);
  const begin = (id) => api.getChangelogTour(id).then((t) => { if (t?.steps?.length) { setTour(t); setI(0); } }).catch(() => {});
  useEffect(() => {
    const pending = readPending();
    if (!pending || (pending.screen && pending.screen !== view)) return undefined;
    clearPending();
    const t = window.setTimeout(() => begin(pending.id), 800);   // let the screen draw first
    return () => window.clearTimeout(t);
  }, [view]);
  useEffect(() => {
    const on = (e) => { if (e?.detail?.id) begin(e.detail.id); };
    window.addEventListener(TOUR_EVENT, on);
    return () => window.removeEventListener(TOUR_EVENT, on);
  }, []);
  if (!tour) return null;
  const close = () => setTour(null);
  const finish = () => { api.finishChangelogTour(tour.id).catch(() => {}); setTour(null); };
  return <TourStep key={i} tour={tour} index={i} onBack={() => setI((n) => Math.max(0, n - 1))}
    onNext={() => (i + 1 >= tour.steps.length ? finish() : setI((n) => n + 1))} onClose={close} />;
}

function TourStep({ tour, index, onBack, onNext, onClose }) {
  const step = tour.steps[index];
  const last = index + 1 >= tour.steps.length;
  const isMobile = useIsMobile();
  const [rect, setRect] = useState(null);
  const [looked, setLooked] = useState(!step.selector);
  const target = useRef(null);
  // The thing to point at may still be loading: look for up to 2 seconds.
  useEffect(() => {
    if (!step.selector) return undefined;
    let tries = 0;
    const id = window.setInterval(() => {
      const el = findTarget(step.selector);
      tries += 1;
      if (el || tries > 20) {
        window.clearInterval(id);
        target.current = el;
        if (el) { el.scrollIntoView?.({ block: 'center', behavior: 'smooth' }); window.setTimeout(() => setRect(el.getBoundingClientRect()), 350); }
        setLooked(true);
      }
    }, 100);
    return () => window.clearInterval(id);
  }, [step.selector]);
  useEffect(() => {
    if (!rect) return undefined;
    const update = () => target.current && setRect(target.current.getBoundingClientRect());
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => { window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); };
  }, [rect]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); if (e.key === 'ArrowRight') onNext(); if (e.key === 'ArrowLeft' && index > 0) onBack(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, onBack, onNext, onClose]);
  if (!looked) return null;

  const counter = <span style={{ fontSize: 12, color: NX.faint }}>Step {index + 1} of {tour.steps.length}</span>;
  const buttons = (<>
    {index > 0 && <button type="button" onClick={onBack} style={btn('outline')}><ChevronLeft size={14} />Back</button>}
    <button type="button" onClick={onNext} style={btn('primary')}>{last ? <><CheckCircle2 size={14} />Done</> : <>Next<ChevronRight size={14} /></>}</button>
  </>);
  const content = (<>
    {step.image && <img src={step.image} alt="" style={{ width: '100%', borderRadius: 8, border: `1px solid ${NX.border}`, marginBottom: 10 }} />}
    {step.body && <div style={{ fontSize: 13.5, lineHeight: 1.55, color: NX.ink, whiteSpace: 'pre-wrap' }}>{step.body}</div>}
  </>);

  // Nothing to point at (or a phone): the step is a normal popup.
  if (!rect || isMobile) {
    return (
      <Modal title={step.title || tour.title} onClose={onClose}
        footer={<><span style={{ marginRight: 'auto' }}>{counter}</span>{buttons}</>}>
        <div style={{ ...label11, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}><Compass size={12} />{tour.title}</div>
        {content}
      </Modal>
    );
  }
  // Pointing at something: dim the page around it, and a small card beside
  // it - a 60%-wide popup would cover what the step is showing.
  const pad = 6;
  const width = Math.min(380, window.innerWidth - 32);
  const below = rect.bottom + 12 + 220 < window.innerHeight;
  const left = Math.max(16, Math.min(rect.left, window.innerWidth - width - 16));
  return (
    <div role="dialog" aria-modal="true" aria-label={`${tour.title}: step ${index + 1}`} style={{ position: 'fixed', inset: 0, zIndex: 4200, fontFamily: FONT }}>
      <div onMouseDown={onClose} style={{ position: 'fixed', inset: 0 }} />
      <div aria-hidden style={{
        position: 'fixed', top: rect.top - pad, left: rect.left - pad, width: rect.width + pad * 2, height: rect.height + pad * 2,
        borderRadius: 10, boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)', outline: `2px solid ${NX.blue}`, pointerEvents: 'none', transition: 'all 0.2s ease',
      }} />
      <div className="nx-rise" style={{
        position: 'fixed', left, width, ...(below ? { top: rect.bottom + pad + 10 } : { bottom: window.innerHeight - rect.top + pad + 10 }),
        ...card, padding: 16, boxShadow: '0 16px 48px rgba(0,0,0,0.3)', maxHeight: '70vh', overflowY: 'auto',
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 6 }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ ...label11, display: 'flex', alignItems: 'center', gap: 6 }}><Compass size={12} />{tour.title}</div>
            <div style={{ marginTop: 2, fontSize: 15, fontWeight: 700, color: NX.ink }}>{step.title}</div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close tour" style={{ ...btn('ghost'), padding: 4, color: NX.faint }}><X size={15} /></button>
        </div>
        {content}
        <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 8 }}><span style={{ marginRight: 'auto' }}>{counter}</span>{buttons}</div>
      </div>
    </div>
  );
}

export function TakeTourButton({ entry, currentView = 'whats-new', style }) {
  if (!entry?.tour?.length) return null;
  return (
    <button type="button" onClick={() => startTour(entry.id, entry.screen, currentView)} style={{ ...btn('outline'), color: NX.blue, ...style }}>
      <Compass size={14} />Take the Tour
    </button>
  );
}


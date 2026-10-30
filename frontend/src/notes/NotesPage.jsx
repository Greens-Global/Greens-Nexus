// Dashboard > Notes (Neil, Oct 29 2026): the scratchpad that follows you.
//
// A list of notes grouped by day (month by month, with search, tags and the
// All / Pinned / Today / Shared / Trash views) beside one open note. The note
// saves itself (useNoteSync: autosave, local draft, rev check), and carries
// pin, a color rule, tags, sharing with Nexus People, version history,
// Markdown export, print / PDF and Make a Task. On a phone the list comes
// first and a note opens in the Quick Note sheet over it (PhoneSheet). The
// sub is `notes` or `notes:<id>`, so a link to one note (the share bell)
// opens it.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronLeft, ChevronRight, Search, X, Plus, Upload, Pin, PinOff, Users, History, MoreHorizontal, Trash2,
  Download, Printer, Maximize2, Minimize2, ChevronsLeft, ChevronsRight, Link as LinkIcon, Palette,
  RotateCcw, Keyboard, Hash, Check, CloudOff, Loader2, StickyNote,
} from 'lucide-react';
import { api } from '../api';
import { useRole } from '../contexts/RoleContext';
import { useIsMobile } from '../lib/useIsMobile';
import { formatDate, formatDateTime } from '../lib/datetime';
import { Modal, DateField, usePeople, Avatar, useEscapeLayer } from '../tasks/components';
import { useDialogFocus, dialogKeyDown } from '../lib/useDialogFocus';
import { useScrollLock } from '../lib/useScrollLock';
import { SkeletonBlocks, ErrorBanner } from '../components/AsyncState';
import { matchPeople } from '../lib/peopleSearch';
import NoteEditor from './NoteEditor';
import { useNoteSync } from './useNoteSync';
import { useNoteCollab, collabEligible } from './useNoteCollab';
import { diffNotes } from './notesMerge';
import { createTaskFrom, openTask } from './notesTasks';
import {
  NOTE_COLORS, colorCss, localDay, monthOf, shiftMonth, monthLabel, dayHeading, groupByDay, noteTitle, htmlToText,
  countWords, editedLabel, htmlToMarkdown, markdownToHtml, exportFileName, downloadText, printNote, rememberLastNote, quickNoteKeys,
} from './notesModel';
import './notes.css';

const VIEWS = [
  { key: 'all', label: 'All' },
  { key: 'pinned', label: 'Pinned' },
  { key: 'today', label: 'Today' },
  { key: 'shared', label: 'Shared' },
  { key: 'trash', label: 'Trash' },
];
const LIST_W_KEY = 'nx-notes-list-width';
const readNum = (k, d) => { try { const v = Number(window.localStorage.getItem(k)); return v > 0 ? v : d; } catch { return d; } };
const store = (k, v) => { try { window.localStorage.setItem(k, String(v)); } catch { /* storage unavailable */ } };


function useToast() {
  const [toast, setToast] = useState(null);
  const timer = useRef(null);
  const show = useCallback((text, action) => {
    clearTimeout(timer.current);
    setToast({ text, action });
    timer.current = setTimeout(() => setToast(null), 5200);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  const node = toast ? (
    <div className="nt-toast" role="status">
      <span>{toast.text}</span>
      {toast.action && <button type="button" onClick={() => { toast.action.run(); setToast(null); }}>{toast.action.label}</button>}
    </div>
  ) : null;
  return [show, node];
}

function StatusLine({ status, note, merged, nameOf }) {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 30000); return () => clearInterval(t); }, []);
  if (status === 'saving') return <span className="nt-status"><Loader2 size={13} className="spin" aria-hidden="true" /> Saving…</span>;
  if (status === 'dirty') return <span className="nt-status">Unsaved changes</span>;
  if (status === 'error') return <span className="nt-status is-bad"><CloudOff size={13} aria-hidden="true" /> Not saved yet - kept on this device, retrying when you type</span>;
  if (status === 'conflict') return <span className="nt-status is-warn">Changed somewhere else</span>;
  if (merged && status === 'saved') return <span className="nt-status"><Check size={13} aria-hidden="true" /> Saved · merged with {nameOf ? nameOf(merged) : merged}'s changes</span>;
  return <span className="nt-status"><Check size={13} aria-hidden="true" /> Saved{note?.updatedAt ? ` · ${editedLabel(note.updatedAt)}` : ''}</span>;
}

// Who else has the note open (Oct 30 2026): the live channel's carets when
// co-typing, else the server's heartbeat. "Live" when edits arrive as typed.
function PresenceLine({ people, peers, live, nameOf }) {
  const seen = new Map();
  (peers || []).forEach((u) => { if (u?.name) seen.set(u.name, { name: u.name, color: u.color, state: 'editing' }); });
  (people || []).forEach((p) => {
    const name = nameOf(p.email);
    if (!seen.has(name)) seen.set(name, { name, state: p.state });
  });
  const list = [...seen.values()];
  if (!list.length && !live) return null;
  const first = list[0];
  const text = !list.length ? 'Live'
    : list.length === 1 ? `${first.name} is ${first.state === 'editing' ? 'editing' : 'viewing'}`
      : `${first.name} and ${list.length - 1} ${list.length === 2 ? 'other' : 'others'} are here`;
  return (
    <span className={`nt-presence${live ? ' is-live' : ''}`} title={list.map((u) => `${u.name} - ${u.state === 'editing' ? 'Editing' : 'Viewing'}`).join('\n') || 'Edits show up as they are typed'}>
      <span className="nt-presence-dots" aria-hidden="true">
        {list.slice(0, 3).map((u) => <span key={u.name} className="nt-presence-dot" style={u.color ? { background: u.color } : undefined} />)}
        {!list.length && <span className="nt-presence-dot" />}
      </span>
      {text}{live && list.length ? ' · Live' : ''}
    </span>
  );
}

// Both people changed the same part (Oct 30 2026): only those parts are
// asked about, each side by side; everything else is already merged.
function ClashPanel({ conflict, who, onResolve }) {
  const [choices, setChoices] = useState({});
  const [titleChoice, setTitleChoice] = useState('mine');
  const n = conflict.clashes.length + (conflict.titleClash ? 1 : 0);
  const pick = (k, v) => setChoices((c) => ({ ...c, [k]: v }));
  const Choice = ({ on, set, both }) => (
    <div className="nt-clash-pick" role="radiogroup" aria-label="Which words to keep">
      {[['mine', 'Keep Mine'], ['theirs', 'Use Theirs'], ...(both ? [['both', 'Keep Both']] : [])].map(([v, label]) => (
        <button key={v} type="button" role="radio" aria-checked={(on || 'mine') === v} className={`nt-view${(on || 'mine') === v ? ' is-on' : ''}`} onClick={() => set(v)}>{label}</button>
      ))}
    </div>
  );
  return (
    <div className="nt-banner nt-clash" role="alert">
      <span className="nt-banner-text">
        {who} changed the same {n === 1 ? 'part' : `${n} parts`} while you were writing. Everything else is merged - choose for {n === 1 ? 'this part' : 'these parts'}. Your words are kept on this device until you do.
      </span>
      {conflict.titleClash && (
        <div className="nt-clash-item">
          <div className="nt-clash-side"><small>Yours</small><div>{conflict.titleClash.mine || 'Untitled Note'}</div></div>
          <div className="nt-clash-side"><small>Theirs</small><div>{conflict.titleClash.theirs || 'Untitled Note'}</div></div>
          <Choice on={titleChoice} set={setTitleChoice} />
        </div>
      )}
      {conflict.clashes.map((c, k) => (
        <div key={k} className="nt-clash-item">
          {/* Yours: this editor's own HTML; theirs: sanitized on the server. */}
          <div className="nt-clash-side"><small>Yours</small><div className="nt-prose" dangerouslySetInnerHTML={{ __html: c.mine.join('') || '<p><i>Removed</i></p>' }} /></div>
          <div className="nt-clash-side"><small>Theirs</small><div className="nt-prose" dangerouslySetInnerHTML={{ __html: c.theirs.join('') || '<p><i>Removed</i></p>' }} /></div>
          <Choice on={choices[k]} set={(v) => pick(k, v)} both={!!(c.mine.length && c.theirs.length)} />
        </div>
      ))}
      <div className="nt-clash-actions">
        <button type="button" className="nt-text-btn is-primary" onClick={() => onResolve(choices, titleChoice)}>Save Choices</button>
        <button type="button" className="nt-text-btn" onClick={() => onResolve({}, 'mine')}>Keep Mine</button>
        <button type="button" className="nt-text-btn" onClick={() => onResolve(Object.fromEntries(conflict.clashes.map((_, k) => [k, 'theirs'])), 'theirs')}>Use Theirs</button>
      </div>
    </div>
  );
}

function Popover({ open, onClose, children, label }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const down = (e) => { if (ref.current && !ref.current.parentElement.contains(e.target)) onClose(); };
    const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key, true); };
  }, [open, onClose]);
  if (!open) return null;
  return <div ref={ref} className="nt-pop" role="menu" aria-label={label}>{children}</div>;
}

function TagEditor({ tags, onChange, disabled }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const t = draft.trim().replace(/^#/, '');
    if (t && !tags.some((x) => x.toLowerCase() === t.toLowerCase())) onChange([...tags, t]);
    setDraft('');
  };
  if (disabled && !tags.length) return null;
  return (
    <div className="nt-taglist" aria-label="Tags">
      <Hash size={13} aria-hidden="true" style={{ color: 'var(--wk-faint)' }} />
      {tags.map((t) => (
        <span key={t} className="nt-tag-item">
          {t}
          {!disabled && <button type="button" aria-label={`Remove tag ${t}`} onClick={() => onChange(tags.filter((x) => x !== t))}><X size={12} /></button>}
        </span>
      ))}
      {!disabled && (
        <input value={draft} placeholder="Add Tag" aria-label="Add a tag" maxLength={40}
          onChange={(e) => setDraft(e.target.value)} onBlur={add}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); } }} />
      )}
    </div>
  );
}

function ShareDialog({ note, onClose, onChanged }) {
  const people = usePeople();
  const { myEmail } = useRole();
  const [q, setQ] = useState('');
  const [level, setLevel] = useState('read');   // what the next person shared may do
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const shared = useMemo(() => note.sharedWith || [], [note.sharedWith]);
  const byEmail = useMemo(() => Object.fromEntries(people.map((p) => [p.email, p])), [people]);
  const options = useMemo(() => matchPeople(people.filter((p) => p.email !== (myEmail || '').toLowerCase() && !shared.some((s) => s.email === p.email)), q, { limit: 8 }), [people, q, shared, myEmail]);
  const act = async (email, fn) => {
    setBusy(email); setError('');
    try { onChanged(await fn()); } catch (e) { setError(e.message || 'Could not change sharing'); } finally { setBusy(''); }
  };
  return (
    <Modal title={`Share "${noteTitle(note)}"`} onClose={onClose}
      footer={<button type="button" className="nt-text-btn" onClick={onClose}>Done</button>}>
      <div className="nt-dialog-body">
        <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>
          Share with people in Nexus People. They get one notice and find the note under Shared. Can Read sees it; Can Edit also writes in it with you - live, with each other's cursors - and every change is kept in Version History under the name of whoever made it. Pin, color, tags and the Trash stay yours.
        </div>
        {error && <ErrorBanner message={error} />}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div className="nt-search" style={{ maxWidth: 'none', flex: '1 1 auto' }}>
            <Search size={15} aria-hidden="true" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find someone by name or email" aria-label="Find someone" autoFocus />
          </div>
          <select className="nt-share-level" value={level} onChange={(e) => setLevel(e.target.value)} aria-label="What they may do">
            <option value="read">Can Read</option>
            <option value="edit">Can Edit</option>
          </select>
        </div>
        {q && (
          <div className="nt-people" style={{ flex: '0 0 auto', maxHeight: 240 }}>
            {options.length === 0 && <div className="nt-empty">Nobody in Nexus People matches "{q}".</div>}
            {options.map((p) => (
              <div key={p.email} className="nt-person">
                <Avatar email={p.email} name={p.name} size={26} />
                <span className="nt-person-name">{p.name}<small>{p.email}</small></span>
                <button type="button" className="nt-text-btn" disabled={busy === p.email}
                  onClick={() => act(p.email, () => api.noteShare(note.id, p.email, level)).then(() => setQ(''))}>Share</button>
              </div>
            ))}
          </div>
        )}
        <div className="nt-w-label">Shared With</div>
        <div className="nt-people nx-fill">
          {shared.length === 0 && <div className="nt-empty">Only you can see this note.</div>}
          {shared.map((s) => (
            <div key={s.email} className="nt-person">
              <Avatar email={s.email} name={byEmail[s.email]?.name || s.email} size={26} />
              <span className="nt-person-name">{byEmail[s.email]?.name || s.email}<small>{s.email}</small></span>
              <select value={s.can} aria-label={`What ${byEmail[s.email]?.name || s.email} may do`} disabled={busy === s.email}
                onChange={(e) => act(s.email, () => api.noteShare(note.id, s.email, e.target.value))}>
                <option value="read">Can Read</option>
                <option value="edit">Can Edit</option>
              </select>
              <button type="button" className="nt-icon-btn" aria-label={`Stop sharing with ${s.email}`} disabled={busy === s.email}
                onClick={() => act(s.email, () => api.noteUnshare(note.id, s.email))}><X size={15} /></button>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}

function HistoryDialog({ note, canRestore, onClose, onRestored, nameOf }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [pick, setPick] = useState(null);
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState('changes');   // changes | version | now
  // A copy is the note as its author left it; its changes are against the copy before it.
  const shown = useMemo(() => {
    if (!pick || !rows) return null;
    if (show === 'version') return null;
    const i = rows.findIndex((r) => r.id === pick.id);
    if (show === 'now') return diffNotes(pick.body, note.body || '');
    const older = rows[i + 1];
    return older ? diffNotes(older.body, pick.body) : null;
  }, [pick, rows, show, note.body]);
  useEffect(() => {
    let alive = true;
    api.noteVersions(note.id).then((r) => { if (alive) { setRows(r || []); setPick((r || [])[0] || null); } })
      .catch((e) => { if (alive) setError(e.message || 'Could not load the history'); });
    return () => { alive = false; };
  }, [note.id]);
  const restore = async () => {
    setBusy(true);
    try { onRestored(await api.noteRestoreVersion(note.id, pick.id)); onClose(); } catch (e) { setError(e.message || 'Could not restore'); setBusy(false); }
  };
  return (
    <Modal title="Version History" onClose={onClose}
      footer={<>
        <button type="button" className="nt-text-btn" onClick={onClose}>Close</button>
        {canRestore && <button type="button" className="nt-text-btn is-primary" disabled={!pick || busy} onClick={restore}><RotateCcw size={14} /> Restore This Version</button>}
      </>}>
      <div className="nt-dialog-body">
        {error && <ErrorBanner message={error} />}
        {rows === null && !error && <SkeletonBlocks count={3} height={56} />}
        {rows && rows.length === 0 && <div className="nt-empty"><strong>No earlier versions yet</strong>A copy is kept when you come back to a note after ten minutes or more, and whenever someone else starts writing in it, so earlier wording is never lost and you can see who changed what.</div>}
        {rows && rows.length > 0 && (
          <div className="nt-hist nx-fill">
            <div className="nt-hist-list" role="listbox" aria-label="Versions">
              {rows.map((v) => (
                <button key={v.id} type="button" role="option" aria-selected={pick?.id === v.id}
                  className={`nt-hist-row${pick?.id === v.id ? ' is-on' : ''}`} onClick={() => setPick(v)}>
                  {formatDateTime(v.createdAt)}
                  <small>{nameOf ? nameOf(v.savedBy) : v.savedBy} · {v.words} words</small>
                </button>
              ))}
            </div>
            <div className="nt-hist-view">
              {pick && (<>
                <div className="nt-qn-switch" role="tablist" aria-label="What to show" style={{ padding: '0 0 0', marginBottom: 10 }}>
                  {[['changes', 'Changes'], ['version', 'This Version'], ['now', 'Compare With Now']].map(([k, label]) => (
                    <button key={k} type="button" role="tab" aria-selected={show === k} className={`nt-view${show === k ? ' is-on' : ''}`} onClick={() => setShow(k)}>{label}</button>
                  ))}
                </div>
                <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>{pick.title || noteTitle(note)}</div>
                <div className="nt-hist-who">
                  {show === 'now' ? 'This copy against the note now: green is what has been added since, struck through what has gone.'
                    : show === 'changes' ? (shown ? `What ${nameOf ? nameOf(pick.savedBy) : pick.savedBy} changed: ${[shown.changed && `${shown.changed} edited`, shown.added && `${shown.added} added`, shown.removed && `${shown.removed} removed`].filter(Boolean).join(', ') || 'nothing in the words'}.` : `The first copy kept - written by ${nameOf ? nameOf(pick.savedBy) : pick.savedBy}.`)
                      : `As ${nameOf ? nameOf(pick.savedBy) : pick.savedBy} left it.`}
                </div>
                {/* Sanitized on the server when it was saved (routers/notes.py); the diff wraps it and escapes the words it rebuilds. */}
                <div className="nt-prose nt-diff" style={{ minHeight: 0, padding: 0 }} dangerouslySetInnerHTML={{ __html: shown ? shown.html : pick.body }} />
              </>)}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

function ShortcutsPop({ open, onClose }) {
  const mod = /Mac|iPhone|iPad/.test(navigator.platform || '') ? 'Cmd' : 'Ctrl';
  const rows = [
    ['Quick Note from anywhere', quickNoteKeys()],
    ['Save now', `${mod}+S`], ['Search notes', '/'], ['Block menu', '/ in a note'], ['Mention someone', '@'],
    ['Checklist', `${mod}+Shift+9`], ['Link', `${mod}+K`], ['Bold / Italic / Underline', `${mod}+B / I / U`],
    ['Heading 1 / 2 / 3', '# / ## / ###'], ['Exit full screen', 'Esc'],
  ];
  return (
    <Popover open={open} onClose={onClose} label="Keyboard shortcuts">
      <div style={{ padding: '4px 9px 6px', fontSize: 11, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--wk-faint)' }}>Keyboard Shortcuts</div>
      {rows.map(([a, b]) => <div key={a} className="nt-pop-row" role="none" style={{ cursor: 'default' }}>{a}<span className="nt-kbd">{b}</span></div>)}
    </Popover>
  );
}

// On a phone a note opens the way Quick Note does (Neil, Oct 29 2026): the
// same full-screen sheet as "+" > New Note, over the list, which stays where
// it was scrolled. The note's actions ride in the sheet's head, the save
// status in its foot; closing it (or Back) is the list again.
function PhoneSheet({ title, sub, color, actions, foot, onClose, children }) {
  const ref = useRef(null);
  useEscapeLayer(onClose);
  useDialogFocus(ref);
  useScrollLock(true);
  return createPortal(
    <>
      <div className="nt-qn-overlay is-page" onClick={onClose} aria-hidden="true" />
      <aside ref={ref} className="nt-qn is-page" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} onKeyDown={dialogKeyDown}>
        <div className="nt-qn-head">
          {color && <span className="nt-head-rule" style={{ background: color }} aria-hidden="true" />}
          <div style={{ flex: '1 1 auto', minWidth: 0 }}>
            <div className="nt-qn-title">{title}</div>
            {sub && <div className="nt-qn-sub">{sub}</div>}
          </div>
          {actions}
          <button type="button" className="nt-icon-btn" aria-label="Close Note" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="nt-qn-body">{children}</div>
        {foot && <div className="nt-qn-foot" aria-live="polite">{foot}</div>}
      </aside>
    </>,
    document.body,
  );
}

// The open note.
function NotePane({ id, people, onBack, onSaved, onTrashChanged, full, onToggleFull, isPhone, toast, myEmail }) {
  const collabRef = useRef(null);
  const sync = useNoteSync(id, { onSaved, collabRef });
  const { note, status, conflict, restored } = sync;
  const nameOf = useCallback((email) => {
    const e = (email || '').toLowerCase();
    if (e && e === (myEmail || '').toLowerCase()) return 'You';
    return (people || []).find((p) => p.email === e)?.name || email || 'Someone';
  }, [people, myEmail]);
  // A shared note's editors type together live (useNoteCollab).
  const eligible = collabEligible(note) && !sync.collabPaused;
  const myName = (people || []).find((p) => p.email === (myEmail || '').toLowerCase())?.name || myEmail;
  const collab = useNoteCollab(id, { enabled: eligible, me: myEmail, name: myName });
  useEffect(() => { collabRef.current = collab; }, [collab]);
  const [menu, setMenu] = useState('');      // '' | 'color' | 'more'
  const [dialog, setDialog] = useState('');  // '' | 'share' | 'history'
  const [confirmDelete, setConfirmDelete] = useState(false);
  const titleRef = useRef(null);

  useEffect(() => { if (id) rememberLastNote(id); }, [id]);
  useEffect(() => { setConfirmDelete(false); setMenu(''); }, [id]);
  // A brand-new note starts in its title.
  useEffect(() => {
    if (note && !note.title && !note.preview && note.mine && !note.trashedAt && note.kind !== 'daily') titleRef.current?.focus();
  }, [note?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Ctrl/Cmd+S saves now instead of the browser's Save Page.
  const flushNow = sync.flush;
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') { e.preventDefault(); flushNow(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [flushNow]);

  if (!id) {
    return (
      <div className="nt-pane">
        <div className="nt-empty" style={{ margin: 'auto' }}>
          <StickyNote size={28} aria-hidden="true" style={{ color: 'var(--wk-faint)', marginBottom: 8 }} />
          <strong>Pick a note or start a new one</strong>
          Everything you write saves by itself and follows you to Quick Note in the top bar.
        </div>
      </div>
    );
  }
  if (status === 'loading' || (!note && status !== 'missing' && status !== 'error')) {
    const skeleton = <div className="nt-doc"><SkeletonBlocks count={1} height={36} /><div style={{ height: 14 }} /><SkeletonBlocks count={3} height={70} /></div>;
    return isPhone ? <PhoneSheet title="Note" onClose={onBack}>{skeleton}</PhoneSheet> : <div className="nt-pane">{skeleton}</div>;
  }
  if (!note) {
    const empty = (
      <div className="nt-empty" style={{ margin: 'auto' }}>
        <strong>{status === 'missing' ? 'This note is not available' : 'Could not open this note'}</strong>
        {status === 'missing' ? 'It may have been deleted, or it is no longer shared with you.' : 'Check your connection and pick it again.'}
      </div>
    );
    return isPhone ? <PhoneSheet title="Note" onClose={onBack}>{empty}</PhoneSheet> : <div className="nt-pane">{empty}</div>;
  }

  const trashed = !!note.trashedAt;
  const readOnly = trashed || note.can === 'read';
  const text = htmlToText(note.body);
  const words = countWords(text);
  const mine = note.mine;

  const trash = async () => {
    setMenu('');
    try { await sync.flush(); const n = await api.noteTrash(note.id); sync.replace(n); onTrashChanged(n, 'trash'); toast('Moved to the Trash', { label: 'Undo', run: async () => { const r = await api.noteRestore(note.id); sync.replace(r); onTrashChanged(r, 'restore'); } }); }
    catch (e) { toast(e.message || 'Could not move it to the Trash'); }
  };
  const restore = async () => {
    try { const n = await api.noteRestore(note.id); sync.replace(n); onTrashChanged(n, 'restore'); toast('Restored'); } catch (e) { toast(e.message || 'Could not restore'); }
  };
  const deleteForever = async () => {
    try { await api.noteDeleteForever(note.id); onTrashChanged(note, 'delete'); toast('Deleted forever'); } catch (e) { toast(e.message || 'Could not delete'); }
  };
  const leave = async () => {
    setMenu('');
    try { await api.noteUnshare(note.id, myEmail); onTrashChanged(note, 'delete'); toast('You left the shared note'); } catch (e) { toast(e.message || 'Could not leave'); }
  };
  const exportMd = () => { setMenu(''); downloadText(exportFileName(note), htmlToMarkdown(note.body, noteTitle(note))); };
  const print = () => { setMenu(''); printNote(note, note.body); };
  const copyLink = async () => {
    setMenu('');
    const url = `${window.location.origin}/dashboard/notes:${note.id}`;
    try { await navigator.clipboard.writeText(url); toast('Link copied - it opens for you and the people the note is shared with'); } catch { toast(url); }
  };
  const makeTask = async (line) => {
    if (!line) { toast('Put the cursor on a line (or select text) to make it a task'); return; }
    try {
      const t = await createTaskFrom(line, note, myEmail);
      toast(`Task created: ${line.slice(0, 60)}`, t?.id ? { label: 'Open Task', run: () => openTask(t.id) } : null);
    } catch (e) { toast(e.message || 'Could not create the task'); }
  };

  const actions = (
            <div className="nt-actions">
              {mine && !trashed && (
                <button type="button" className={`nt-icon-btn${note.pinned ? ' is-on' : ''}`} aria-pressed={note.pinned}
                  aria-label={note.pinned ? 'Unpin' : 'Pin'} title={note.pinned ? 'Unpin' : 'Pin to the top and the dashboard'}
                  onClick={() => sync.setMeta({ pinned: !note.pinned })}>{note.pinned ? <PinOff size={17} /> : <Pin size={17} />}</button>
              )}
              {mine && !trashed && (
                <span style={{ position: 'relative' }}>
                  <button type="button" className="nt-icon-btn" aria-label="Color" title="Color" aria-haspopup="menu" aria-expanded={menu === 'color'}
                    onClick={() => setMenu(menu === 'color' ? '' : 'color')}><Palette size={17} /></button>
                  <Popover open={menu === 'color'} onClose={() => setMenu('')} label="Color">
                    {NOTE_COLORS.map((c) => (
                      <button key={c.key || 'none'} type="button" role="menuitemradio" aria-checked={note.color === c.key} className="nt-pop-row"
                        onClick={() => { sync.setMeta({ color: c.key }); setMenu(''); }}>
                        <span className="nt-pop-swatch" style={{ background: c.key ? c.css : 'var(--wk-line)' }} aria-hidden="true" />
                        {c.label}{note.color === c.key && <Check size={14} className="nt-pop-check" aria-hidden="true" />}
                      </button>
                    ))}
                  </Popover>
                </span>
              )}
              {mine && !trashed && (
                <button type="button" className="nt-icon-btn" aria-label="Share" title="Share" onClick={() => setDialog('share')}><Users size={17} /></button>
              )}
              {!isPhone && (
                <button type="button" className="nt-icon-btn" aria-label={full ? 'Exit Full Screen' : 'Full Screen'} title={full ? 'Exit Full Screen (Esc)' : 'Full Screen'}
                  onClick={onToggleFull}>{full ? <Minimize2 size={17} /> : <Maximize2 size={17} />}</button>
              )}
              <span style={{ position: 'relative' }}>
                <button type="button" className="nt-icon-btn" aria-label="More actions" title="More" aria-haspopup="menu" aria-expanded={menu === 'more'}
                  onClick={() => setMenu(menu === 'more' ? '' : 'more')}><MoreHorizontal size={18} /></button>
                <Popover open={menu === 'more'} onClose={() => setMenu('')} label="More actions">
                  <button type="button" role="menuitem" className="nt-pop-row" onClick={exportMd}><Download size={15} /> Export as Markdown</button>
                  <button type="button" role="menuitem" className="nt-pop-row" onClick={print}><Printer size={15} /> Print or Save as PDF</button>
                  <button type="button" role="menuitem" className="nt-pop-row" onClick={() => { setMenu(''); setDialog('history'); }}><History size={15} /> Version History</button>
                  <button type="button" role="menuitem" className="nt-pop-row" onClick={copyLink}><LinkIcon size={15} /> Copy Link</button>
                  {mine && !trashed && (<><div className="nt-pop-sep" /><button type="button" role="menuitem" className="nt-pop-row is-danger" onClick={trash}><Trash2 size={15} /> Move to Trash</button></>)}
                  {!mine && (<><div className="nt-pop-sep" /><button type="button" role="menuitem" className="nt-pop-row is-danger" onClick={leave}><X size={15} /> Leave Shared Note</button></>)}
                </Popover>
              </span>
            </div>
  );

  const doc = (
        <div className="nt-doc">
          {/* The sheet already says Daily Scratchpad - as in Quick Note, no empty title box under it. */}
          {!(isPhone && note.kind === 'daily' && !note.title) && (
            <div className="nt-head">
              <span className="nt-head-rule" style={{ background: colorCss(note.color) }} aria-hidden="true" />
              <input ref={titleRef} className="nt-title" value={note.title || ''} readOnly={readOnly} maxLength={200}
                placeholder={note.kind === 'daily' ? 'Daily Scratchpad' : 'Untitled Note'} aria-label="Note title"
                onChange={(e) => sync.edit({ title: e.target.value })} />
              {!isPhone && actions}
            </div>
          )}

          <div className="nt-meta">
            {mine && !trashed ? (
              <DateField value={note.day} compact title="The day this note belongs to"
                onChange={(v) => { if (v) sync.setMeta({ day: v }); }} />
            ) : <span>{note.day ? formatDate(note.day) : ''}</span>}
            <span>{words} {words === 1 ? 'word' : 'words'} · {text.length} characters</span>
            {!mine && <span>Shared by {note.owner}{note.can === 'read' ? ' · Can Read' : ' · Can Edit'}</span>}
            {mine && note.sharedWith?.length > 0 && (
              <button type="button" className="nt-tag" onClick={() => setDialog('share')}>
                Shared with {note.sharedWith.length} {note.sharedWith.length === 1 ? 'person' : 'people'}
              </button>
            )}
            {note.editedBy && note.editedBy !== (myEmail || '').toLowerCase() && note.updatedAt && (
              <span>Edited by {nameOf(note.editedBy)} {editedLabel(note.updatedAt).replace(/^edited /i, '')}</span>
            )}
            <PresenceLine people={sync.people} peers={collab.peers} live={collab.live} nameOf={nameOf} />
            {!readOnly && !isPhone && <StatusLine status={status} note={note} merged={sync.merged} nameOf={nameOf} />}
          </div>

          <TagEditor tags={note.tags || []} disabled={!mine || trashed} onChange={(tags) => sync.setMeta({ tags })} />

          {trashed && (
            <div className="nt-banner is-bad" role="status">
              <span className="nt-banner-text">This note is in the Trash. Restore it to edit it again.</span>
              <button type="button" className="nt-text-btn" onClick={restore}><RotateCcw size={14} /> Restore</button>
              {!confirmDelete
                ? <button type="button" className="nt-text-btn is-danger" onClick={() => setConfirmDelete(true)}><Trash2 size={14} /> Delete Forever</button>
                : (<>
                  <span>Delete forever? This cannot be undone.</span>
                  <button type="button" className="nt-text-btn is-danger" onClick={deleteForever}>Delete Forever</button>
                  <button type="button" className="nt-text-btn" onClick={() => setConfirmDelete(false)}>Cancel</button>
                </>)}
            </div>
          )}
          {conflict && (
            <ClashPanel key={conflict.server?.rev} conflict={conflict} onResolve={sync.resolve}
              who={conflict.server?.updatedBy && conflict.server.updatedBy !== (myEmail || '').toLowerCase() ? nameOf(conflict.server.updatedBy) : 'Another window'} />
          )}
          {restored && !conflict && (
            <div className="nt-banner is-info" role="status"><span className="nt-banner-text">Unsaved words from your last visit were put back and are being saved.</span></div>
          )}

          {eligible && collab.phase !== 'ready' && collab.phase !== 'failed'
            ? <div style={{ paddingTop: 14 }}><SkeletonBlocks count={3} height={56} /></div>
            : collab.phase === 'ready'
              ? <NoteEditor key={`live:${collab.epoch}`} collab={collab} readOnly={readOnly} people={people}
                  onChange={(html) => sync.edit({ body: html })} onMakeTask={readOnly ? undefined : makeTask} />
              : <NoteEditor key="saved" value={note.body || ''} readOnly={readOnly} people={people}
                  onChange={(html) => sync.edit({ body: html })} onMakeTask={readOnly ? undefined : makeTask} />}
        </div>
  );
  const dialogs = (<>
      {dialog === 'share' && <ShareDialog note={note} onClose={() => setDialog('')} onChanged={(n) => { sync.replace(n); onSaved?.(n); }} />}
      {dialog === 'history' && <HistoryDialog note={note} canRestore={!readOnly} onClose={() => setDialog('')} nameOf={nameOf}
        onRestored={(n) => { sync.replace(n, true); onSaved?.(n); toast('Version restored - the note as it was is kept in the history'); }} />}
  </>);

  if (isPhone) {
    return (
      <PhoneSheet title={note.kind === 'daily' ? 'Daily Scratchpad' : 'Note'} onClose={onBack} actions={actions} color={note.color ? colorCss(note.color) : ''}
        sub={[note.day ? formatDate(note.day) : '', !mine ? `Shared by ${note.owner}` : ''].filter(Boolean).join(' · ')}
        foot={readOnly ? <span>{trashed ? 'In the Trash' : 'Read Only'}</span> : <StatusLine status={status} note={note} merged={sync.merged} nameOf={nameOf} />}>
        {doc}
        {dialogs}
      </PhoneSheet>
    );
  }
  return (
    <div className="nt-pane">
      <div className="nt-pane-scroll">{doc}</div>
      {dialogs}
    </div>
  );
}

export default function NotesPage({ activeSub, onSubChange }) {
  const { myEmail } = useRole();
  const isPhone = useIsMobile('(max-width: 768px)');
  const people = usePeople();
  const today = localDay();
  const [view, setView] = useState('all');
  const [month, setMonth] = useState(monthOf(today));
  const [q, setQ] = useState('');
  const [qLive, setQLive] = useState('');
  const [tag, setTag] = useState('');
  const [data, setData] = useState(null);     // { notes, counts, tags }
  const [error, setError] = useState('');
  const [listOpen, setListOpen] = useState(true);
  const [listW, setListW] = useState(() => readNum(LIST_W_KEY, 320));
  const [drag, setDrag] = useState(false);
  const [full, setFull] = useState(false);
  const [showKeys, setShowKeys] = useState(false);
  const [toast, toastNode] = useToast();
  const searchRef = useRef(null);
  const fileRef = useRef(null);

  const selectedId = (activeSub || '').startsWith('notes:') ? activeSub.slice(6) : '';
  // Opening a note is looking at it: its Updated dot goes (the server marks it seen too).
  useEffect(() => {
    if (selectedId) setData((d) => (d ? { ...d, notes: d.notes.map((x) => (x.id === selectedId && x.unseen ? { ...x, unseen: false } : x)) } : d));
  }, [selectedId, data?.notes?.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const select = useCallback((id) => onSubChange?.(id ? `notes:${id}` : 'notes'), [onSubChange]);

  useEffect(() => { const t = setTimeout(() => setQ(qLive.trim()), 250); return () => clearTimeout(t); }, [qLive]);

  const byMonth = view === 'all' && !q && !tag;
  const load = useCallback(async () => {
    try {
      const r = await api.notesList({ view, q, tag, month: byMonth ? month : '', today });
      setData(r); setError('');
    } catch (e) { setError(e.message || 'Could not load your notes'); }
  }, [view, q, tag, month, byMonth, today]);
  useEffect(() => { load(); }, [load]);

  // A save (or share / restore) updates its row in place.
  const onSaved = useCallback((n) => {
    setData((d) => (d ? { ...d, notes: d.notes.map((x) => (x.id === n.id ? { ...x, ...n, preview: htmlToText(n.body).slice(0, 220) } : x)) } : d));
  }, []);
  const onTrashChanged = useCallback((n, what) => {
    if (what === 'delete') select('');
    load();
  }, [load, select]);

  const newNote = async (extra = {}) => {
    try {
      const day = byMonth && month !== monthOf(today) ? `${month}-01` : today;
      const n = await api.noteCreate({ title: '', body: '', day, ...extra });
      if (view === 'trash' || view === 'shared') setView('all');
      await load();
      select(n.id);
      return n;
    } catch (e) { toast(e.message || 'Could not create a note'); return null; }
  };

  const importFile = async (file) => {
    if (!file) return;
    if (file.size > 1_000_000) { toast('That file is too large to import (1 MB at most)'); return; }
    const text = await file.text();
    const heading = /^#\s+(.+)$/m.exec(text);
    const title = (heading ? heading[1] : file.name.replace(/\.(md|markdown|txt)$/i, '')).slice(0, 200);
    const body = markdownToHtml(heading ? text.replace(heading[0], '') : text);
    const n = await newNote({ title, body });
    if (n) toast(`Imported "${title}"`);
  };

  // "/" focuses search; Esc leaves full screen.
  useEffect(() => {
    const onKey = (e) => {
      const tag = (e.target?.tagName || '').toLowerCase();
      const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target?.isContentEditable;
      const inDialog = !!e.target?.closest?.('[role="dialog"]') || (isPhone && !!selectedId);
      if (e.key === '/' && !typing && !inDialog && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); searchRef.current?.focus(); }
      if (e.key === 'Escape' && full && !typing) setFull(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [full, isPhone, selectedId]);

  // Drag the list's edge to size it (kept per browser).
  const startDrag = (e) => {
    e.preventDefault();
    const x0 = e.clientX, w0 = listW;
    setDrag(true);
    const move = (ev) => setListW(Math.max(240, Math.min(560, w0 + ev.clientX - x0)));
    const up = (ev) => {
      setDrag(false);
      store(LIST_W_KEY, Math.max(240, Math.min(560, w0 + ev.clientX - x0)));
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };

  const groups = useMemo(() => groupByDay(data?.notes || []), [data]);
  const showList = isPhone || (listOpen && !full);
  const showPane = isPhone ? !!selectedId : true;
  const counts = data?.counts || {};

  return (
    <div className={`nt-page${full ? ' is-full' : ''}`}>
      {!full && (
        <div className="nt-bar">
          {!isPhone && (
            <button type="button" className="nt-icon-btn" aria-label={listOpen ? 'Hide the list' : 'Show the list'} title={listOpen ? 'Hide the List' : 'Show the List'}
              onClick={() => setListOpen((o) => !o)}>{listOpen ? <ChevronsLeft size={18} /> : <ChevronsRight size={18} />}</button>
          )}
          <div className="nt-month" aria-label="Month">
            <button type="button" className="nt-icon-btn" aria-label="Previous month" disabled={!byMonth} onClick={() => setMonth((m) => shiftMonth(m, -1))}><ChevronLeft size={17} /></button>
            <span className="nt-month-label" aria-live="polite">{byMonth ? monthLabel(month) : 'Every Month'}</span>
            <button type="button" className="nt-icon-btn" aria-label="Next month" disabled={!byMonth} onClick={() => setMonth((m) => shiftMonth(m, 1))}><ChevronRight size={17} /></button>
          </div>
          <div className="nt-search">
            <Search size={15} aria-hidden="true" />
            <input ref={searchRef} value={qLive} onChange={(e) => setQLive(e.target.value)} placeholder="Search notes" aria-label="Search notes"
              onKeyDown={(e) => { if (e.key === 'Escape') { setQLive(''); e.currentTarget.blur(); } }} />
            {qLive && <button type="button" className="nt-icon-btn nt-clear" aria-label="Clear search" onClick={() => setQLive('')}><X size={14} /></button>}
          </div>
          <div className="nt-views" role="tablist" aria-label="Which notes">
            {VIEWS.map((v) => (
              <button key={v.key} type="button" role="tab" aria-selected={view === v.key} className={`nt-view${view === v.key ? ' is-on' : ''}`}
                onClick={() => setView(v.key)}>
                {v.label}{counts[v.key] != null && <span className="nt-count">{counts[v.key]}</span>}
              </button>
            ))}
          </div>
          <div className="nt-bar-end">
            {!isPhone && (
              <span style={{ position: 'relative' }}>
                <button type="button" className="nt-icon-btn" aria-label="Keyboard shortcuts" title="Keyboard Shortcuts" onClick={() => setShowKeys((s) => !s)}><Keyboard size={17} /></button>
                <ShortcutsPop open={showKeys} onClose={() => setShowKeys(false)} />
              </span>
            )}
            <button type="button" className="nt-icon-btn" aria-label="Import a Markdown or text file" title="Import (.md, .txt)" onClick={() => fileRef.current?.click()}><Upload size={17} /></button>
            <input ref={fileRef} type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" hidden
              onChange={(e) => { importFile(e.target.files?.[0]); e.target.value = ''; }} />
            <button type="button" className="nt-text-btn is-primary" onClick={() => newNote()}><Plus size={15} /> New Note</button>
          </div>
        </div>
      )}
      <div className="nt-body">
        {showList && (<>
          <div className="nt-list" style={{ width: isPhone ? '100%' : listW }}>
            {(data?.tags || []).length > 0 && (
              <div className="nt-tags" aria-label="Filter by tag">
                {data.tags.map((t) => (
                  <button key={t} type="button" className={`nt-tag${tag === t ? ' is-on' : ''}`} aria-pressed={tag === t}
                    onClick={() => setTag(tag === t ? '' : t)}>#{t}</button>
                ))}
              </div>
            )}
            <div className="nt-list-scroll">
              {error && <div style={{ padding: 12 }}><ErrorBanner message={error} onRetry={load} /></div>}
              {!data && !error && <div style={{ padding: 12 }}><SkeletonBlocks count={5} height={58} borderRadius={8} /></div>}
              {data && groups.length === 0 && (
                <div className="nt-empty">
                  <strong>{q ? 'No notes match' : view === 'trash' ? 'The Trash is empty' : view === 'shared' ? 'Nothing shared with you yet' : view === 'pinned' ? 'No pinned notes' : view === 'today' ? 'Nothing for today yet' : `No notes in ${monthLabel(month)}`}</strong>
                  {q ? 'Try fewer words.' : view === 'all' || view === 'today' ? 'Start one with New Note, or jot something in Quick Note from the top bar.' : ''}
                </div>
              )}
              {groups.map((g) => (
                <section key={g.day || 'none'} aria-label={dayHeading(g.day, today)}>
                  <div className="nt-day">{dayHeading(g.day, today)}</div>
                  {g.notes.map((n) => (
                    <button key={n.id} type="button" className={`nt-row${n.id === selectedId ? ' is-on' : ''}`} onClick={() => select(n.id)}
                      aria-current={n.id === selectedId ? 'true' : undefined}>
                      {n.color && <span className="nt-row-rule" style={{ background: colorCss(n.color) }} aria-hidden="true" />}
                      <span className="nt-row-top">
                        <span className="nt-row-title">{noteTitle(n)}</span>
                        <span className="nt-row-icons">
                          {n.unseen && n.id !== selectedId && <span className="nt-unseen" role="img" aria-label="Updated since you last looked" title={`Updated by ${n.editedBy || 'someone'} since you last looked`} />}
                          {n.pinned && <Pin size={13} aria-label="Pinned" />}
                          {(n.shared || !n.mine) && <Users size={13} aria-label={n.mine ? 'Shared' : 'Shared with you'} />}
                        </span>
                      </span>
                      {n.preview && <span className="nt-row-preview">{n.preview}</span>}
                      <span className="nt-row-meta">
                        {view === 'trash' && n.trashedAt ? `Trashed ${formatDate(n.trashedAt)}` : editedLabel(n.updatedAt)}
                        {!n.mine ? ` · from ${n.owner}` : ''}{n.tags?.length ? ` · #${n.tags.join(' #')}` : ''}
                      </span>
                    </button>
                  ))}
                </section>
              ))}
              {data?.more && <div className="nt-empty">Showing the newest 500 - search to find older notes.</div>}
            </div>
          </div>
          {!isPhone && <div className={`nt-resize${drag ? ' is-drag' : ''}`} role="separator" aria-orientation="vertical" aria-label="Resize the list" onPointerDown={startDrag} />}
        </>)}
        {showPane && (
          <NotePane key={selectedId || 'none'} id={selectedId} people={people} onBack={() => select('')} onSaved={onSaved}
            onTrashChanged={onTrashChanged} full={full} onToggleFull={() => setFull((f) => !f)} isPhone={isPhone} toast={toast} myEmail={myEmail} />
        )}
      </div>
      {toastNode}
    </div>
  );
}

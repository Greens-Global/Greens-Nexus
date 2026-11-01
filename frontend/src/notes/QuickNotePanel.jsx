// Quick Note (Oct 29 2026): the slide-over that opens from the + menu's New Note (or
// Ctrl+Alt+N / Ctrl+Cmd+N) on any screen. It writes today's scratchpad - the
// one 'daily' note per day, made on the first word - or the note last opened
// on the Notes page, and links to the full page. Saving is the Notes page's
// own (useNoteSync), so both always show the same words. Make a Task works
// here as on the Notes page; what it made is said in the foot (Oct 31 2026).
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, ArrowUpRight, Check, Loader2, CloudOff } from 'lucide-react';
import { api } from '../api';
import { useRole } from '../contexts/RoleContext';
import { formatDate } from '../lib/datetime';
import { useDialogFocus } from '../lib/useDialogFocus';
import { useEscapeLayer, usePeople } from '../tasks/components';
import { ErrorBanner, SkeletonBlocks } from '../components/AsyncState';
import NoteEditor from './NoteEditor';
import { useNoteSync } from './useNoteSync';
import { createTaskFrom, openTask } from './notesTasks';
import { localDay, lastNoteId, noteTitle, writeDraft, editedLabel, quickNoteKeys } from './notesModel';
import './notes.css';

function openInNotes(id) {
  window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'dashboard', sub: id ? `notes:${id}` : 'notes' } }));
}

function Status({ status, note }) {
  if (status === 'saving') return <><Loader2 size={12} className="spin" aria-hidden="true" /> Saving…</>;
  if (status === 'dirty') return <>Unsaved changes</>;
  if (status === 'error') return <><CloudOff size={12} aria-hidden="true" /> Not saved yet - kept on this device</>;
  if (status === 'conflict') return <>Changed somewhere else - open it in Notes to choose</>;
  if (!note) return null;
  return <><Check size={12} aria-hidden="true" /> Saved{note.updatedAt ? ` · ${editedLabel(note.updatedAt)}` : ''}</>;
}

// Today has no scratchpad yet: the first words (or a voice note or video)
// make it. The hand-over to SyncedNote swaps the editor, so it waits while
// this one is recording, listening or saving a clip - what changes
// meanwhile goes into the note's local draft, which SyncedNote saves.
export const hasContent = (html) => /<(audio|video)\b/i.test(html) || !!html.replace(/<[^>]+>/g, '').trim();

function FirstWrite({ day, people, onMade }) {
  const latest = useRef('');
  const making = useRef(false);
  const made = useRef(null);     // { id, rev, title } once the note exists
  const busy = useRef(false);
  const [error, setError] = useState('');
  const handOver = () => { if (made.current && !busy.current) onMade(made.current.id); };
  const onChange = async (html) => {
    latest.current = html;
    if (made.current) { writeDraft(made.current.id, { ...made.current, body: html }); return; }
    if (making.current || !hasContent(html)) return;
    making.current = true;
    try {
      const n = await api.noteCreate({ kind: 'daily', day, body: html });
      made.current = { id: n.id, rev: n.rev, title: n.title };
      // Whatever was typed while it was being made is saved by the hand-over.
      writeDraft(n.id, { ...made.current, body: latest.current });
      handOver();
    } catch (e) {
      making.current = false;
      setError(e.message || 'Could not start today\'s scratchpad');
    }
  };
  const onBusy = (b) => { busy.current = b; if (!b) handOver(); };
  return (<>
    {error && <ErrorBanner message={error} />}
    <NoteEditor value="" onChange={onChange} onBusy={onBusy} people={people} compact autoFocus
      placeholder="Today's scratchpad. Type / for blocks, [ ] for a checklist." />
  </>);
}

function SyncedNote({ id, people, onNote, onMakeTask }) {
  const sync = useNoteSync(id);
  const { note, status } = sync;
  useEffect(() => { onNote({ note, status }); }, [note, status, onNote]);
  if (status === 'loading') return <div style={{ paddingTop: 14 }}><SkeletonBlocks count={3} height={56} /></div>;
  if (!note) return <div className="nt-empty"><strong>This note is not available</strong>It may have been deleted, or it is no longer shared with you.</div>;
  const readOnly = !!note.trashedAt || note.can === 'read';
  return (<>
    {note.kind !== 'daily' && (
      <input className="nt-title" style={{ fontSize: 19, marginTop: 12 }} value={note.title || ''} readOnly={readOnly}
        placeholder="Untitled Note" aria-label="Note title" onChange={(e) => sync.edit({ title: e.target.value })} />
    )}
    <NoteEditor value={note.body || ''} readOnly={readOnly} people={people} compact autoFocus
      onChange={(html) => sync.edit({ body: html })} onMakeTask={readOnly ? undefined : (line) => onMakeTask(line, note)}
      placeholder="Today's scratchpad. Type / for blocks, [ ] for a checklist." />
  </>);
}

export default function QuickNotePanel({ onClose }) {
  const day = localDay();
  const people = usePeople();
  const panelRef = useRef(null);
  const last = lastNoteId();
  const [dailyId, setDailyId] = useState(null);   // null = loading, '' = none yet
  const [error, setError] = useState('');
  const [mode, setMode] = useState('today');
  const [shown, setShown] = useState({ note: null, status: 'loading' });
  const [said, setSaid] = useState(null);    // { text, taskId } after Make a Task
  const saidTimer = useRef(null);
  const { myEmail } = useRole() || {};
  useEscapeLayer(onClose);
  useEffect(() => () => clearTimeout(saidTimer.current), []);
  const say = (text, taskId) => {
    clearTimeout(saidTimer.current);
    setSaid({ text, taskId });
    saidTimer.current = setTimeout(() => setSaid(null), 6000);
  };
  const makeTask = async (line, note) => {
    if (!line) { say('Put the cursor on a line (or select text) to make it a task'); return; }
    try {
      const t = await createTaskFrom(line, note, myEmail);
      say(`Task created: ${line.slice(0, 60)}`, t?.id);
    } catch (e) { say(e.message || 'Could not create the task'); }
  };
  useDialogFocus(panelRef);

  useEffect(() => {
    let alive = true;
    api.noteDaily(day).then((r) => { if (alive) setDailyId(r?.note?.id || ''); })
      .catch((e) => { if (alive) { setError(e.message || 'Could not open Quick Note'); setDailyId(''); } });
    return () => { alive = false; };
  }, [day]);

  const showLast = !!last && last !== dailyId;
  const id = mode === 'last' && showLast ? last : dailyId;

  return createPortal(
    <>
      <div className="nt-qn-overlay" onClick={onClose} aria-hidden="true" />
      <aside ref={panelRef} className="nt-qn" role="dialog" aria-modal="true" aria-label="Quick Note">
        <div className="nt-qn-head">
          <div style={{ flex: '1 1 auto', minWidth: 0 }}>
            <div className="nt-qn-title">Quick Note</div>
            <div className="nt-qn-sub">
              {mode === 'today' || !showLast ? `Today's Scratchpad · ${formatDate(day)}` : noteTitle(shown.note)}
            </div>
          </div>
          <button type="button" className="nt-text-btn" onClick={() => { openInNotes(id || ''); onClose(); }}>
            Open in Notes <ArrowUpRight size={14} aria-hidden="true" />
          </button>
          <button type="button" className="nt-icon-btn" aria-label="Close Quick Note" onClick={onClose}><X size={18} /></button>
        </div>
        {showLast && (
          <div className="nt-qn-switch" role="tablist" aria-label="Which note">
            <button type="button" role="tab" aria-selected={mode === 'today'} className={`nt-view${mode === 'today' ? ' is-on' : ''}`} onClick={() => setMode('today')}>Today</button>
            <button type="button" role="tab" aria-selected={mode === 'last'} className={`nt-view${mode === 'last' ? ' is-on' : ''}`} onClick={() => setMode('last')}>Last Opened</button>
          </div>
        )}
        <div className="nt-qn-body">
          {error && <div style={{ paddingTop: 12 }}><ErrorBanner message={error} /></div>}
          {dailyId === null && mode === 'today' && <div style={{ paddingTop: 14 }}><SkeletonBlocks count={3} height={56} /></div>}
          {dailyId === '' && mode === 'today' && !error && <FirstWrite day={day} people={people} onMade={setDailyId} />}
          {id && <SyncedNote key={id} id={id} people={people} onNote={setShown} onMakeTask={makeTask} />}
        </div>
        <div className="nt-qn-foot" aria-live="polite">
          {said ? (
            <span className="nt-qn-said">
              {said.text}
              {said.taskId && (
                <button type="button" className="nt-text-btn" onClick={() => { openTask(said.taskId); onClose(); }}>Open Task</button>
              )}
            </span>
          ) : id ? <Status status={shown.status} note={shown.note} /> : <span>Saves as you type</span>}
          {!said && <span className="nt-qn-keys">{quickNoteKeys()} opens this anywhere</span>}
        </div>
      </aside>
    </>,
    document.body,
  );
}

// One way to start a task, whatever was tapped (Neil, 11/15/2026 - plan
// https://claude.ai/artifact/EzwJbKJsvrGRWwtH1Ui4Ji). Every "new task" door -
// the module's floating +, My Tasks' and a project's bar, a person's page, a
// team, the header's Quick Actions (Share to Nexus too) and a form entry's
// Make a Task - renders this instead of picking a form itself:
//   - On a computer: the full form (CreateTaskModal), exactly as before.
//   - On a phone: the quick composer (QuickCreateTask); its Details opens the
//     full form with everything typed so far. After a task is made, "Task
//     Added" (with when it is due) offers Open and Add Another, and the row
//     that shows it lights up for a moment. Add Another keeps the date, the
//     people and the project (Neil, 11/15/2026); the priority starts at Medium.
// The page's own close (`onClose`) runs when the person is done - after the
// message, not when the sheet goes - so Add Another has somewhere to come
// back to. A new tap on the page's + while the message shows starts over.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check } from 'lucide-react';
import CreateTaskModal from './CreateTaskModal';
import QuickCreateTask from './QuickCreateTask';
import { useIsMobile } from '../lib/useIsMobile';
import { openTaskAnywhere, flashTaskRow } from './openTask';
import { dueLabel, carryDefaults } from './composerLib';

const SHOW_MS = 6000;
const NONE = {};
// A new task started anywhere (the page's +, the bolt) ends a "Task Added"
// still showing from another TaskCreate - one message, never under a sheet.
const STARTED = 'nexus:task-create-started';
let seq = 0;

export function TaskAddedToast({ task, onOpen, onAddAnother, onDone }) {
  const done = useRef(onDone);
  useEffect(() => { done.current = onDone; }, [onDone]);
  useEffect(() => {
    const t = setTimeout(() => done.current?.(), SHOW_MS);
    return () => clearTimeout(t);
  }, []);
  const when = task?.dueOn ? dueLabel(task.dueOn) : '';
  return createPortal(
    <div className="nx-task-added" role="status" aria-live="polite">
      <span className="nx-task-added-ok" aria-hidden="true"><Check size={14} strokeWidth={3} /></span>
      <span className="nx-task-added-text"><b>Task Added</b>{when ? <small>Due {when}</small> : null}</span>
      <button type="button" onClick={onOpen} className="nx-task-added-open">Open</button>
      <button type="button" onClick={onAddAnother}>Add Another</button>
    </div>,
    document.body,
  );
}

// `defaults` must keep its identity between renders (a state value or a
// memo): a NEW object while "Task Added" shows is the page asking again.
export default function TaskCreate({ defaults = NONE, onClose, onCreated, lockedProjectId = '' }) {
  const isMobile = useIsMobile();
  const [phase, setPhase] = useState('quick');   // quick | full | added
  const [start, setStart] = useState(defaults);  // what the composer opens with
  const [full, setFull] = useState(null);        // the draft Details hands the full form
  // The draft held something typed in the composer (a name, a note, a file):
  // the full form then asks before it is closed - it used to measure "changed"
  // against a form that already held those words, and discarded them silently.
  const [fullTyped, setFullTyped] = useState(false);
  const [added, setAdded] = useState(null);      // { task, carry }
  const [round, setRound] = useState(0);         // a fresh composer each time
  const addedRef = useRef(null);
  const opened = useRef(defaults);
  const [me] = useState(() => { seq += 1; return seq; });
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => {
    if (phase !== 'added') { window.dispatchEvent(new CustomEvent(STARTED, { detail: { by: me } })); return undefined; }
    const other = (e) => { if (e.detail?.by !== me) onCloseRef.current?.(); };
    window.addEventListener(STARTED, other);
    return () => window.removeEventListener(STARTED, other);
  }, [phase, round, me]);

  // The page opened it again (its + tapped while "Task Added" shows): start
  // over with what it asked for. While a form is open, what it opened with stands.
  useEffect(() => {
    if (defaults === opened.current || phase !== 'added') return;
    opened.current = defaults;
    addedRef.current = null;
    setStart(defaults); setFull(null); setAdded(null); setPhase('quick'); setRound((r) => r + 1);
  }, [defaults]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!isMobile) {
    return <CreateTaskModal defaults={defaults} onClose={onClose} onCreated={onCreated} lockedProjectId={lockedProjectId} />;
  }

  const made = (task, carry) => {
    onCreated?.(task);
    addedRef.current = { task, carry };
    setAdded({ task, carry });
    flashTaskRow(task?.id);
  };
  // The sheet goes: to the message when a task was made, else the page closes it.
  const sheetGone = () => { if (addedRef.current) setPhase('added'); else onClose?.(); };
  const anotherOne = () => {
    const next = carryDefaults(opened.current, addedRef.current?.carry, lockedProjectId);
    addedRef.current = null;
    setAdded(null); setFull(null); setStart(next); setPhase('quick'); setRound((r) => r + 1);
  };
  const openIt = () => { const id = added?.task?.id; onClose?.(); openTaskAnywhere(id); };

  return (
    <>
      {phase === 'quick' && (
        <QuickCreateTask key={round} defaults={start} lockedProjectId={lockedProjectId} onClose={sheetGone} onCreated={made}
          onFullDetails={(d, typed) => { setFull({ ...start, ...d }); setFullTyped(!!typed); setPhase('full'); }} />
      )}
      {phase === 'full' && full && (
        <CreateTaskModal defaults={full} lockedProjectId={lockedProjectId} startDirty={fullTyped}
          onCreated={(t) => made(t, { dueOn: t?.dueOn, assigneeIds: t?.assigneeIds, projectId: t?.projectId, priority: t?.priority })}
          onClose={sheetGone} />
      )}
      {phase === 'added' && added && (
        <TaskAddedToast key={added.task?.id} task={added.task} onOpen={openIt} onAddAnother={anotherOne} onDone={() => onClose?.()} />
      )}
    </>
  );
}

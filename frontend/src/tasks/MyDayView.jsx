// Tasks > My Day (Neil, Oct 22 2026) - the first tab of the Tasks page.
// Microsoft Planner / To Do's "My Day": what I am doing today. It starts
// with my tasks due today, I add the rest (a quick add at the top, or from
// Suggestions), and it empties at my local midnight. Only I see it, and
// nothing here changes a task except the checkbox, which is the module's
// ordinary complete (with its Undo). Data: tasks/myDay.js.
import { useEffect, useRef, useState } from 'react';
import { Sun, Lightbulb, Plus, X, GripVertical, Circle, CheckCircle2, XCircle, MoreHorizontal, ArrowUp, ArrowDown } from 'lucide-react';
import { useTasks } from './TasksContext';
import { useMyDay, checkMyDayClock, moveId, myDayDateLabel, progressLabel } from './myDay';
import { effectiveProjectId, fmtDate, todayISO } from './lib';
import { NX, FONT, btn, input as inputStyle, isMissed, MISSED_TITLE } from './theme';
import { useIsMobile } from './components';
import { BottomSheet } from './MobileTaskBar';
import { useCanEditTask } from './canEditTask';
import { projectLook } from './projectLook';
import { StatusLabel, PrioritySignal } from '../components/StatusLabel';
import { SkeletonBlocks, ErrorBanner } from '../components/AsyncState';
import AnchoredMenu from '../components/AnchoredMenu';
import DictateButton from '../components/DictateButton';
import AddSeveralModal from './AddSeveralModal';
import { pastedTaskList } from './batchPaste';

const card = { background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 12 };

function Progress({ done, total, isMobile }) {
  if (!total) return null;
  const pct = Math.round((done / total) * 100);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, width: isMobile ? '100%' : 'auto' }}>
      <span data-testid="myday-progress" style={{ fontSize: 12.5, fontWeight: 600, color: done === total ? NX.green : NX.dim, whiteSpace: 'nowrap' }}>
        {done === total ? 'All done for today' : progressLabel(done, total)}
      </span>
      <div role="progressbar" aria-label="My Day progress" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}
        aria-valuetext={progressLabel(done, total)}
        style={{ flex: isMobile ? 1 : 'none', width: isMobile ? 'auto' : 140, height: 4, borderRadius: 999, background: NX.border2, overflow: 'hidden' }}>
        <div className="nx-md-bar" style={{ width: `${pct}%`, height: '100%', borderRadius: 999, background: NX.green }} />
      </div>
    </div>
  );
}

function QuickAdd({ onAdd, onSeveral }) {
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);
  const submit = async () => {
    const v = title.trim();
    if (!v || busy) return;
    setBusy(true);
    try {
      await onAdd(v);
      setTitle('');
    } catch { /* onAdd said what went wrong; the text stays to try again */ }
    setBusy(false);
    ref.current?.focus();
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: `1px solid ${NX.border}` }}>
      <Plus size={16} style={{ color: NX.blue, flexShrink: 0 }} aria-hidden="true" />
      <input ref={ref} type="text" value={title} onChange={(e) => setTitle(e.target.value)} disabled={busy}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
        // A pasted list (two or more lines) is many tasks for today - Add Several (Oct 31 2026).
        onPaste={(e) => { const list = pastedTaskList(e); if (list && onSeveral) { e.preventDefault(); onSeveral(list); } }}
        placeholder="Add a task for today" aria-label="Add a task for today" maxLength={500}
        style={{ ...inputStyle, border: 'none', padding: '6px 2px', background: 'transparent', fontSize: 14 }} />
      {!busy && <DictateButton target={ref} title="Dictate a Task" />}
      {title.trim() && (
        <button type="button" onClick={submit} disabled={busy} style={{ ...btn('primary'), padding: '5px 12px', fontSize: 12.5, flexShrink: 0 }}>
          {busy ? 'Adding...' : 'Add'}
        </button>
      )}
    </div>
  );
}

// `hideToday`: on today's own list "Today" goes without saying. `short`:
// under the Overdue heading the word is already said - the date alone.
const dueShown = (t, day) => {
  const due = String(t.dueOn || '').slice(0, 10);
  return !!due && due !== day;
};
function DueLabel({ t, day, hideToday = false, short = false }) {
  const due = String(t.dueOn || '').slice(0, 10);
  if (!due || (hideToday && due === day)) return null;
  if (!t.completed && due < day) {
    return <StatusLabel size="sm" color={NX.red} label={short ? fmtDate(due) : `Overdue · ${fmtDate(due)}`} title={`Overdue - was due ${fmtDate(due)}`} />;
  }
  return (
    <span title={`Due ${fmtDate(due)}`} style={{ fontSize: 12, color: NX.faint, whiteSpace: 'nowrap' }}>
      {due === day ? 'Today' : fmtDate(due)}
    </span>
  );
}

function ProjectPill({ t, store }) {
  const pid = t.parentTaskId ? effectiveProjectId(t, store.taskById || {}) : t.projectId;
  if (!pid) return null;
  const name = store.projectName?.(pid);
  if (!name) return null;
  const color = projectLook(store.projectById?.[pid]).color;
  return <StatusLabel size="sm" color={color} label={name} title={`Project: ${name}`} style={{ maxWidth: 180 }} />;
}

function CompleteButton({ t, canEdit, onToggle }) {
  const missed = isMissed(t);
  const title = !canEdit ? 'View only - ask the project owner to edit' : missed ? MISSED_TITLE : t.completed ? 'Mark Incomplete' : 'Mark Complete';
  return (
    <button type="button" onClick={(e) => { e.stopPropagation(); if (canEdit) onToggle(t); }} disabled={!canEdit}
      title={title} aria-label={`${title}: ${t.title}`} aria-pressed={!!t.completed}
      style={{ ...btn('ghost'), padding: 0, flexShrink: 0, color: missed ? NX.faint : t.completed ? NX.green : NX.faint, cursor: canEdit ? 'pointer' : 'default', opacity: canEdit ? 1 : 0.55 }}>
      {missed ? <XCircle size={18} /> : t.completed ? <CheckCircle2 size={18} /> : <Circle size={18} />}
    </button>
  );
}

// Phones: one menu instead of the hover controls (no hover, no drag there).
function PhoneRowMenu({ t, index, count, onMove, onRemove }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const item = { ...btn('ghost'), width: '100%', justifyContent: 'flex-start', gap: 8, fontSize: 14, color: NX.ink, padding: '10px 12px' };
  const stop = (e) => e.stopPropagation();
  return (
    <span onClick={stop} style={{ display: 'inline-flex', flexShrink: 0 }}>
      <button ref={ref} type="button" onClick={() => setOpen((o) => !o)} title="More Actions" aria-label={`More actions for ${t.title}`}
        aria-haspopup="menu" aria-expanded={open} style={{ ...btn('ghost'), padding: 8, color: NX.faint }}>
        <MoreHorizontal size={18} />
      </button>
      <AnchoredMenu anchorRef={ref} open={open} onClose={() => setOpen(false)} align="end" aria-label="My Day Actions"
        style={{ width: 210, background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,0.16)', padding: 4 }}>
        {onMove && index > 0 && (
          <button type="button" role="menuitem" style={item} onClick={() => { setOpen(false); onMove(t.id, -1); }}><ArrowUp size={15} style={{ color: NX.faint }} />Move Up</button>
        )}
        {onMove && index < count - 1 && (
          <button type="button" role="menuitem" style={item} onClick={() => { setOpen(false); onMove(t.id, 1); }}><ArrowDown size={15} style={{ color: NX.faint }} />Move Down</button>
        )}
        <button type="button" role="menuitem" style={item} onClick={() => { setOpen(false); onRemove(t); }}><X size={15} style={{ color: NX.faint }} />Remove From My Day</button>
      </AnchoredMenu>
    </span>
  );
}

function Row({ t, index, openCount, day, store, canEdit, isMobile, onOpen, onToggle, onRemove, onMove, drag, slots }) {
  const movable = !t.completed && openCount > 1;
  const prio = t.priority && t.priority !== 'medium' ? <PrioritySignal priority={t.priority} /> : null;
  const meta = isMobile ? (
    <>
      <ProjectPill t={t} store={store} />
      <DueLabel t={t} day={day} hideToday />
      {prio}
    </>
  ) : (
    // Fixed slots on a desk, so the dates and priorities line up down the list.
    <>
      <span style={{ display: 'flex', justifyContent: 'flex-end', minWidth: 0, maxWidth: 200 }}><ProjectPill t={t} store={store} /></span>
      {slots.due && <span style={{ width: 150, display: 'flex', justifyContent: 'flex-end' }}><DueLabel t={t} day={day} hideToday /></span>}
      {slots.prio && <span style={{ width: 70, display: 'flex' }}>{prio}</span>}
    </>
  );
  return (
    <div role="listitem" data-myday-row={t.id} tabIndex={0} aria-label={t.title}
      aria-describedby={movable && !isMobile ? 'myday-move-hint' : undefined}
      className="nx-row-hover nx-md-row" onClick={() => onOpen(t.id)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter') { e.preventDefault(); onOpen(t.id); return; }
        if (movable && e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
          e.preventDefault();
          onMove(t.id, e.key === 'ArrowUp' ? -1 : 1, 'row');
        }
      }}
      {...(movable && !isMobile ? drag.rowProps(t.id, index) : {})}
      style={{
        position: 'relative', display: 'flex', alignItems: isMobile ? 'flex-start' : 'center', gap: 10,
        padding: isMobile ? '10px 8px 10px 14px' : '8px 12px 8px 6px', cursor: 'pointer',
        boxShadow: `inset 0 -1px 0 ${NX.border2}`,
        opacity: drag.dragId === t.id ? 0.45 : 1,
        ...(drag.dropAt === index ? { boxShadow: `inset 0 2px 0 ${NX.blue}, inset 0 -1px 0 ${NX.border2}` } : null),
        ...(drag.dropAt === index + 1 && index === openCount - 1 ? { boxShadow: `inset 0 -2px 0 ${NX.blue}` } : null),
      }}>
      {!isMobile && (
        movable ? (
          <button type="button" className="nx-md-reveal" title="Drag to reorder"
            aria-label={`Move ${t.title} (drag, or Up / Down)`}
            onMouseDown={() => drag.arm(t.id)} onMouseUp={() => drag.arm(null)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
              e.preventDefault(); e.stopPropagation();
              onMove(t.id, e.key === 'ArrowUp' ? -1 : 1, 'grip');
            }}
            style={{ border: 'none', background: 'transparent', padding: 0, display: 'flex', color: NX.faint, cursor: 'grab', flexShrink: 0, width: 16 }}>
            <GripVertical size={14} />
          </button>
        ) : <span aria-hidden="true" style={{ width: 16, flexShrink: 0 }} />
      )}
      <span style={{ display: 'flex', paddingTop: isMobile ? 1 : 0 }}>
        <CompleteButton t={t} canEdit={canEdit} onToggle={onToggle} />
      </span>
      {isMobile ? (
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14.5, fontWeight: 500, color: t.completed ? NX.faint : NX.ink, textDecoration: t.completed ? 'line-through' : 'none', overflowWrap: 'anywhere' }}>{t.title}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 4 }}>{meta}</div>
        </div>
      ) : (
        <>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13.5, fontWeight: 500, color: t.completed ? NX.faint : NX.ink, textDecoration: t.completed ? 'line-through' : 'none' }}>{t.title}</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, minWidth: 0 }}>{meta}</span>
        </>
      )}
      {isMobile ? (
        <PhoneRowMenu t={t} index={index} count={openCount} onMove={movable ? (id, d) => onMove(id, d, 'menu') : null} onRemove={onRemove} />
      ) : (
        <button type="button" className="nx-md-reveal" onClick={(e) => { e.stopPropagation(); onRemove(t); }}
          title="Remove From My Day" aria-label={`Remove ${t.title} from My Day`}
          style={{ ...btn('ghost'), padding: 4, color: NX.faint, flexShrink: 0 }}>
          <X size={15} />
        </button>
      )}
    </div>
  );
}

function SuggestionRow({ t, day, store, onAdd, onOpen }) {
  return (
    <div className="nx-row-hover" style={{ padding: '8px 12px', borderRadius: 8, cursor: 'pointer' }} onClick={() => onOpen(t.id)}>
      <div style={{ fontSize: 13.5, fontWeight: 500, color: NX.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={t.title}>{t.title}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 5, minWidth: 0 }}>
        <span style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, minWidth: 0, flex: 1 }}>
          <ProjectPill t={t} store={store} />
          <DueLabel t={t} day={day} short />
        </span>
        <button type="button" onClick={(e) => { e.stopPropagation(); onAdd(t); }} aria-label={`Add ${t.title} to My Day`}
          style={{ ...btn('outline'), padding: '4px 9px', fontSize: 12, gap: 4, flexShrink: 0 }}>
          <Plus size={13} />Add To My Day
        </button>
      </div>
    </div>
  );
}

function Suggestions({ groups, day, store, onAdd, onOpen }) {
  const shown = groups.filter((g) => g.rows.length);
  if (!shown.length) {
    return <div style={{ padding: '18px 12px', fontSize: 13, color: NX.dim }}>No suggestions right now. Tasks that are overdue, due tomorrow, in progress or newly assigned to you show up here.</div>;
  }
  return shown.map((g) => (
    <section key={g.key} aria-label={g.label} style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', fontSize: 11.5, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: g.key === 'overdue' ? NX.red : NX.faint }}>
        {g.label}<span style={{ fontWeight: 600, color: NX.faint }}>{g.rows.length}</span>
      </div>
      {g.rows.map((t) => <SuggestionRow key={t.id} t={t} day={day} store={store} onAdd={onAdd} onOpen={onOpen} />)}
    </section>
  ));
}

// Native drag from the handle only (the rest of the row is for clicking),
// the same gesture as the drawer's subtasks.
function useRowDrag(onDrop) {
  const armed = useRef(null);
  const [dragId, setDragId] = useState(null);
  const [dropAt, setDropAt] = useState(null);
  const end = () => { armed.current = null; setDragId(null); setDropAt(null); };
  return {
    dragId, dropAt,
    arm: (id) => { armed.current = id; },
    rowProps: (id, i) => ({
      draggable: true,
      onDragStart: (e) => {
        if (armed.current !== id) { e.preventDefault(); return; }
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', id); } catch { /* jsdom */ }
        setDragId(id);
      },
      onDragEnd: end,
      onDragOver: (e) => {
        if (!dragId) return;
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        const at = e.clientY > r.top + r.height / 2 ? i + 1 : i;
        if (at !== dropAt) setDropAt(at);
      },
      onDrop: (e) => {
        if (!dragId) return;
        e.preventDefault();
        onDrop(dragId, dropAt ?? i);
        end();
      },
    }),
  };
}

export default function MyDayView({ onOpen }) {
  const store = useTasks();
  const myDay = useMyDay();
  const isMobile = useIsMobile();
  const canEditTask = useCanEditTask(store);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [announce, setAnnounce] = useState('');
  const { day, status, open, done, rows, total, suggestions, me } = myDay;
  const suggestCount = suggestions.reduce((n, g) => n + g.rows.length, 0);
  // The date and priority slots are kept only when some row fills them.
  const slots = {
    due: rows.some((t) => dueShown(t, day)),
    prio: rows.some((t) => t.priority && t.priority !== 'medium'),
  };

  // Midnight: a new local date empties the list and loads the new day's.
  // Checked once a minute and when the tab comes back; nothing is fetched
  // otherwise (a focus after a long while re-reads it - see checkMyDayClock).
  useEffect(() => {
    if (!me) return undefined;
    const tick = () => checkMyDayClock(me);
    const back = () => { if (document.visibilityState !== 'hidden') checkMyDayClock(me, { focus: true }); };
    const id = setInterval(tick, 60 * 1000);
    window.addEventListener('focus', back);
    document.addEventListener('visibilitychange', back);
    return () => { clearInterval(id); window.removeEventListener('focus', back); document.removeEventListener('visibilitychange', back); };
  }, [me]);

  const openIds = open.map((t) => t.id);
  const doneIds = done.map((t) => t.id);
  const refocus = (id, where) => requestAnimationFrame(() => {
    const row = document.querySelector(`[data-myday-row="${CSS.escape(id)}"]`);
    const el = where === 'grip' ? row?.querySelector('.nx-md-reveal') : where === 'menu' ? null : row;
    el?.focus();
  });
  const move = (id, delta, where) => {
    const next = moveId(openIds, id, delta);
    if (next === openIds) return;
    myDay.reorder([...next, ...doneIds]);
    const t = open.find((x) => x.id === id);
    setAnnounce(`Moved ${t?.title || 'task'} to position ${next.indexOf(id) + 1} of ${next.length}.`);
    if (where) refocus(id, where);
  };
  const drag = useRowDrag((id, at) => {
    const from = openIds.indexOf(id);
    if (from < 0) return;
    const to = at > from ? at - 1 : at;
    if (to === from) return;
    move(id, to - from);
  });

  const toggle = (t) => {
    Promise.resolve(store.toggleComplete?.(t)).then(() => {
      // A row the store does not hold (seen only through My Day) is re-read.
      if (!store.taskById?.[t.id]) myDay.reload();
    }).catch(() => {});
  };
  const [several, setSeveral] = useState('');   // the pasted list while Add Several is open
  const [severalNote, setSeveralNote] = useState('');
  const noteTimer = useRef(null);
  const noteAdded = (msg) => { clearTimeout(noteTimer.current); setSeveralNote(msg); noteTimer.current = setTimeout(() => setSeveralNote(''), 4000); };
  useEffect(() => () => clearTimeout(noteTimer.current), []);
  const quickAdd = async (title) => {
    let created;
    try {
      created = await store.createTask({
        title, type: 'task', status: 'not_started', priority: 'medium',
        assigneeIds: [store.myEmail], ownerId: store.myEmail || '', projectId: '', teamId: '',
        dueOn: day || todayISO(),
      });
    } catch (e) {
      store.notify?.(`Could not add that task: ${e?.message || 'please try again'}`);
      throw e;
    }
    if (created?.id) await myDay.add(created);
  };
  const addSuggestion = (t) => {
    myDay.add(t);
    setAnnounce(`Added ${t.title} to My Day.`);
  };

  const header = (
    <div style={{ display: 'flex', alignItems: isMobile ? 'flex-start' : 'center', gap: 12, flexWrap: 'wrap', padding: isMobile ? '4px 2px 12px' : '4px 2px 14px' }}>
      <span aria-hidden="true" style={{ width: 36, height: 36, borderRadius: 10, background: 'rgba(217,119,6,0.12)', color: NX.amber, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <Sun size={19} />
      </span>
      <div style={{ minWidth: 0, flex: isMobile ? 1 : 'none' }}>
        <h2 style={{ margin: 0, fontSize: isMobile ? 18 : 20, fontWeight: 700, color: NX.ink, lineHeight: 1.2 }}>My Day</h2>
        <div data-testid="myday-date" style={{ fontSize: 13, color: NX.dim, marginTop: 2 }}>{myDayDateLabel(day)}</div>
      </div>
      {!isMobile && <div style={{ marginLeft: 16 }}><Progress done={done.length} total={total} /></div>}
      <button type="button" onClick={() => setSuggestOpen((o) => !o)} aria-pressed={suggestOpen} aria-expanded={suggestOpen}
        style={{ ...btn('outline'), marginLeft: 'auto', padding: '6px 11px', fontSize: 12.5, color: suggestOpen ? NX.blue : NX.ink, ...(suggestOpen ? { borderColor: NX.blue } : null) }}>
        <Lightbulb size={14} style={{ color: NX.amber }} />Suggestions
        {suggestCount > 0 && <span style={{ fontSize: 11.5, fontWeight: 700, color: NX.faint }}>{suggestCount}</span>}
      </button>
      {isMobile && total > 0 && <Progress done={done.length} total={total} isMobile />}
    </div>
  );

  const body = status === 'error' && !rows.length ? (
    <div style={{ padding: 12 }}><ErrorBanner message="My Day could not be loaded right now." onRetry={myDay.reload} /></div>
  ) : status !== 'ready' && !rows.length ? (
    <div style={{ padding: 12 }} aria-busy="true" aria-label="Loading My Day"><SkeletonBlocks count={4} height={36} borderRadius={8} /></div>
  ) : !rows.length ? (
    <div style={{ textAlign: 'center', padding: isMobile ? '40px 18px' : '52px 20px', color: NX.dim }}>
      <Sun size={34} style={{ color: NX.amber, opacity: 0.7, marginBottom: 12 }} aria-hidden="true" />
      <div style={{ fontSize: 15, fontWeight: 600, color: NX.ink }}>Nothing planned for today yet.</div>
      <div style={{ fontSize: 13, marginTop: 6 }}>Add a task above, or pick from Suggestions - what is overdue, due tomorrow and in progress.</div>
      {!suggestOpen && (
        <button type="button" onClick={() => setSuggestOpen(true)} style={{ ...btn('outline'), marginTop: 14, fontSize: 12.5 }}>
          <Lightbulb size={14} style={{ color: NX.amber }} />Open Suggestions
        </button>
      )}
    </div>
  ) : (
    <div role="list" aria-label="My Day">
      {rows.map((t, i) => (
        <Row key={t.id} t={t} index={i} openCount={open.length} day={day} store={store} canEdit={canEditTask(t)} isMobile={isMobile}
          onOpen={onOpen} onToggle={toggle} onRemove={(x) => myDay.remove(x)} onMove={move} drag={drag} slots={slots} />
      ))}
    </div>
  );

  return (
    <div style={{ fontFamily: FONT, padding: isMobile ? '12px 12px 0' : '18px 24px 0', display: 'flex', gap: 16, alignItems: 'flex-start' }}>
      <div style={{ flex: 1, minWidth: 0, maxWidth: 920, margin: suggestOpen && !isMobile ? 0 : '0 auto' }}>
        {header}
        <div className={isMobile ? 'nx-edge-card' : undefined} style={{ ...card, overflow: 'hidden' }}>
          <QuickAdd onAdd={quickAdd} onSeveral={(text) => setSeveral(text)} />
          {severalNote && <div role="status" style={{ padding: '4px 12px', fontSize: 12.5, color: NX.green, fontWeight: 600 }}>{severalNote}</div>}
          {several && (
            <AddSeveralModal defaults={{ text: several, dueOn: day || todayISO(), assigneeIds: store.myEmail ? [store.myEmail] : [], source: 'paste' }}
              onClose={() => setSeveral(null)}
              onDone={(r) => { const n = r?.topLevelIds?.length ?? r?.created ?? 0; noteAdded(`${n} task${n === 1 ? '' : 's'} added for today`); }} />
          )}
          {body}
        </div>
        <span id="myday-move-hint" style={{ display: 'none' }}>Alt plus Up or Down arrow moves this task.</span>
        <div role="status" aria-live="polite" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>{announce}</div>
      </div>
      {suggestOpen && !isMobile && (
        <aside aria-label="Suggestions" style={{ ...card, width: 340, flexShrink: 0, position: 'sticky', top: 0, maxHeight: 'calc(100vh - 220px)', display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 12px 8px 14px', borderBottom: `1px solid ${NX.border2}` }}>
            <Lightbulb size={15} style={{ color: NX.amber }} />
            <span style={{ fontSize: 14, fontWeight: 700, color: NX.ink }}>Suggestions</span>
            <button type="button" onClick={() => setSuggestOpen(false)} title="Close" aria-label="Close Suggestions" style={{ ...btn('ghost'), padding: 4, marginLeft: 'auto', color: NX.faint }}><X size={16} /></button>
          </div>
          <div className="nx-scroll" style={{ overflowY: 'auto', padding: '6px 2px 8px', minHeight: 0 }}>
            <Suggestions groups={suggestions} day={day} store={store} onAdd={addSuggestion} onOpen={onOpen} />
          </div>
        </aside>
      )}
      {suggestOpen && isMobile && (
        <BottomSheet title="Suggestions" onClose={() => setSuggestOpen(false)}>
          <div style={{ margin: '-8px -8px 0' }}>
            <Suggestions groups={suggestions} day={day} store={store} onAdd={addSuggestion} onOpen={(id) => { setSuggestOpen(false); onOpen(id); }} />
          </div>
        </BottomSheet>
      )}
    </div>
  );
}

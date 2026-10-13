// Task Module - the Task Detail drawer: a right-side, resizable, tabbed panel
// (Overview / Comments / Activity / Attachments / Subtasks / Dependencies /
// Properties). Ported from the export's features/task-detail/* (24 files) into a
// single consolidated file matching this module's inline-style idiom, wired to
// the real TasksContext store + api.js instead of the export's mocked Zustand store.
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeft, ArrowRightToLine, CornerDownRight, GripVertical, CheckCircle2, Circle, XCircle, ChevronDown, ChevronRight,
  ChevronLeft, Diamond, Repeat, ThumbsUp, Trash2, Link2, X, Clock, ShieldCheck,
  Paperclip, Download, Pin, Pencil, Plus, CalendarDays, Maximize2, Minimize2,
  RotateCcw, ThumbsDown, Share2, MoreHorizontal, UserPlus, Globe, Lock, Check, Ban, Ticket,
} from 'lucide-react';
import { api } from '../api';
import { useTasks } from './TasksContext';
import { fmtDate as fmtDateRaw, fmtDateTime, filesFromPaste, parseImportedAuthor, fmtHours, teamInProject, fieldOption, richBodyHtml, uploadTaskAttachment, taskAssignees, fieldsForTask, requiredByProjectsOf, isBlankValue, orderSubtasks, reorderedPositions, taskTracksTime } from './lib';

// Drawer shows an em-dash for an unset date rather than an empty cell.
const fmtDate = (iso) => (iso ? fmtDateRaw(iso) : '-');
import { NX, FONT, btn, input as inputStyle, STATUS_META, STATUS_ORDER, PRIORITY_META, PRIORITY_ORDER, isMissed, MISSED_TITLE } from './theme';
import { Avatar, PersonSelect, PersonMultiSelect, usePeople, useIsMobile, DateField, AttachmentViewer, ExternalTag, useImageZoom, localTodayISO, notPast, MenuCaption } from './components';
import { matchPeople } from '../lib/peopleSearch';
import { useListNav } from '../lib/listNav';
import { useFrequentCollaborators, frequentRows } from './frequentPeople';
import TeamPicks, { pickableTeams, firstTeamPick, toggleRoster } from './teamPicks';
import RichDescription, { isEmptyDoc } from './RichDescription';
import ProjectPicker from './ProjectPicker';
import DueBadge from './DueBadge';
import DueNegotiation from './DueNegotiation';
import { toDownloadUrl } from '../lib/storageView';
import AnchoredMenu from '../components/AnchoredMenu';
import { Spinner, LoadingState } from '../components/AsyncState';
import { DAYS, DAY_ABBR, recurrenceLabel, monthRuleOf, yearRuleOf, PERIODIC_PRESETS, clampDays, MAX_PERIODIC_DAYS, ruleFromDate } from './recurrence';
import { MonthDayControls, YearDayControls } from './RecurrenceParts';

const DEP_TYPES = { FS: 'Finish → Start', SS: 'Start → Start', FF: 'Finish → Finish', SF: 'Start → Finish' };
/** "On these days" - the S M T W T F S row Weekly and Custom(week) share
 *  inside the Recurrence popover. Multi-toggle, stays open (no close-on-pick)
 *  since more than one day is usually wanted. */
function RecurDayPicker({ value, onToggle }) {
  return (
    <div style={{ display: 'flex', gap: 3 }}>
      {DAY_ABBR.map((d, i) => {
        const on = value.includes(i);
        return (
          <button key={d} type="button" title={DAYS[i]} onClick={() => onToggle(i)}
            style={{
              width: 24, height: 24, borderRadius: '50%', border: `1px solid ${on ? NX.primary : NX.border}`,
              background: on ? NX.primary : 'transparent', color: on ? '#fff' : NX.dim,
              fontSize: 10.5, fontWeight: 700, cursor: 'pointer', padding: 0, fontFamily: FONT,
            }}>{d[0]}</button>
        );
      })}
    </div>
  );
}

// ── tiny inline primitives ───────────────────────────────────────────────────
// The chevron used to be decorative - it pointed down on a section that could
// not fold, which is the same "affordance that lies" the My Tasks title had.
// It now folds for real, and the rarely-used sections (Subtasks, Time Tracking,
// Approval) start CLOSED so the Overview opens on description and comments
// instead of three empty widgets.
function Section({ title, children, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ marginTop: 18, borderTop: `1px solid ${NX.border}`, paddingTop: 15 }}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, marginBottom: open ? 9 : 0,
          fontSize: 13, fontWeight: 700, color: NX.ink, background: 'transparent',
          border: 'none', padding: 0, cursor: 'pointer', fontFamily: FONT, width: '100%', textAlign: 'left',
        }}>
        <ChevronDown size={14} style={{ color: NX.faint, flexShrink: 0, transform: open ? 'none' : 'rotate(-90deg)', transition: 'transform 0.13s ease' }} />
        {title}
      </button>
      {open && children}
    </div>
  );
}
function Row({ label, children }) {
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', minHeight: 32 }}>
      <span style={{ width: 96, flexShrink: 0, color: NX.faint, fontSize: 13, paddingTop: 5 }}>{label}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', flex: 1 }}>{children}</div>
    </div>
  );
}
function Chip({ color, tint, children }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600, color, background: tint, whiteSpace: 'nowrap' }}>
      {children}
    </span>
  );
}
// Lightweight popover anchored under its trigger; closes on outside tap / Esc.
// Portaled (AnchoredMenu) so the drawer's scrolling body can't clip it, and
// kept inside the viewport - a trigger near the edge (the header's "more
// actions") used to push the panel off-screen, unreachable on a phone.
function Pop({ trigger, children, width = 200 }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  return (
    <div ref={ref} style={{ display: 'inline-flex' }}>
      {trigger(() => setOpen((o) => !o))}
      <AnchoredMenu anchorRef={ref} open={open} onClose={() => setOpen(false)}
        style={{ width, maxWidth: 'calc(100vw - 16px)', background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,0.16)', padding: 4 }}>
        <div style={{ maxHeight: 292, overflowY: 'auto' }}>{children(() => setOpen(false))}</div>
      </AnchoredMenu>
    </div>
  );
}
// Searchable list inside the "Add Dependency" popover - filters by title/code
// as you type, same shape as PersonSelect's search-then-list.
function DependencyPickerBody({ candidates, onPick }) {
  const [q, setQ] = useState('');
  const query = q.trim().toLowerCase();
  const filtered = query
    ? candidates.filter((c) => c.title.toLowerCase().includes(query) || (c.code || '').toLowerCase().includes(query))
    : candidates;
  return (
    <div>
      <input className="nx-inline-edit"
        autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a task…"
        style={{ width: '100%', border: 'none', borderBottom: `1px solid ${NX.border}`, padding: '7px 9px', marginBottom: 4, fontSize: 13, fontFamily: FONT, boxSizing: 'border-box', color: NX.ink }}
      />
      <div style={{ maxHeight: 230, overflowY: 'auto' }}>
        {filtered.length ? filtered.slice(0, 40).map((c) => (
          <MenuItem key={c.id} onClick={() => onPick(c)}>{c.title}</MenuItem>
        )) : (
          <div style={{ padding: 9, fontSize: 12, color: NX.faint, textAlign: 'center' }}>
            {candidates.length ? 'No matching tasks.' : 'No eligible tasks in this project'}
          </div>
        )}
      </div>
    </div>
  );
}
function MenuItem({ icon, onClick, danger, children }) {
  // Highlight comes from .nx-menu-row (style.css), not a useState mirror of the
  // pointer: this rendered the whole drawer on every mouse move across a menu,
  // and it was the only menu in the module that highlighted at all.
  return (
    <button className="nx-menu-row" onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '7px 9px',
      borderRadius: 7, border: 'none', cursor: 'pointer', fontSize: 13, fontFamily: FONT,
      color: danger ? NX.red : NX.ink, background: 'transparent',
    }}>{icon}{children}</button>
  );
}

// `initialTab` lets a caller open the drawer straight onto the tab that made
// them open it - the Replies log opens a task because a comment arrived by
// email, and landing on Overview would leave the reader to go find it.
// Defaults to Overview, so every existing caller behaves exactly as before.
// `zIndex`: the drawer normally sits at 3500, under Modal (4000). A caller that
// opens it FROM a modal (the ticket drawer's linked tasks) raises it above.
// Convert to Ticket (Neil, 10/05) reuses the ticket intake form itself, loaded
// only when someone converts - the Tickets module is a large chunk.
const CreateTicketModal = lazy(() => import('../tickets/TicketsView').then((m) => ({ default: m.CreateTicketModal })));

export default function TaskDetailDrawer({ taskId, onClose, onEdit, initialTab = 'overview', zIndex = 3500 }) {
  const store = useTasks();
  const { taskById, tasks, teams, projects, projectName, teamName, nameOf, myEmail, customFields = [], updateTask, deleteTask, createTask, getComments, addComment, offerUndo } = store;
  // Externals included: Assignee and Collaborators are who does the work, and
  // an external partner on a task has to be nameable there (Sagar, Sept 2 2026).
  const people = usePeople(true);

  const [activeId, setActiveId] = useState(taskId);
  // The tasks stepped through to get here - opening a subtask from its parent
  // pushes the parent - so Close, Delete and Mark Complete on a subtask land
  // back on the task you came from instead of shutting the drawer and losing
  // your place (Sagar, Oct 13 2026).
  const [trail, setTrail] = useState([]);
  useEffect(() => { setActiveId(taskId); setTrail([]); }, [taskId]);
  const openSub = (id) => { setTrail((t) => [...t, activeId]); setActiveId(id); };
  const [tab, setTab] = useState(initialTab);
  useEffect(() => setTab(initialTab), [activeId, initialTab]);
  const [shareOpen, setShareOpen] = useState(false);
  const [converting, setConverting] = useState(false);

  const task = taskById[activeId];
  const parent = task?.parentTaskId ? taskById[task.parentTaskId] : null;
  // Where leaving this task goes: the task stepped in from, else (a subtask
  // opened straight from a list) its parent, else nowhere - the drawer closes.
  const backTarget = (fromId = activeId) => {
    const prior = [...trail].reverse().find((id) => id !== fromId && taskById[id]);
    if (prior) return prior;
    const p = taskById[fromId]?.parentTaskId;
    return p && taskById[p] ? p : null;
  };
  const goBack = (fromId = activeId) => {
    const to = backTarget(fromId);
    if (!to) { onClose(); return; }
    setTrail((t) => t.slice(0, Math.max(0, t.lastIndexOf(to))));
    setActiveId(to);
  };

  // Mark Complete from the header closes the drawer once the completion has
  // played out - the task is done, so there is nothing left to do in it. The
  // store holds the save ~550ms for the unicorn (TasksContext.toggleComplete);
  // the extra beat lets "Completed" show before the panel slides away.
  // Guarded so it never closes something else: if the person switched to
  // another task, or un-completed it again, during the wait, the drawer stays.
  // Completing a SUBTASK opened inside the drawer steps back to its parent
  // instead of closing the whole thing.
  const latest = useRef({ activeId, taskById });
  useEffect(() => { latest.current = { activeId, taskById }; });
  const markComplete = () => {
    const completing = !task.completed;
    const doneId = task.id;
    const done = store.toggleComplete(task);
    if (!completing) return;
    Promise.resolve(done).then(() => setTimeout(() => {
      const now = latest.current;
      if (now.activeId !== doneId || !now.taskById[doneId]?.completed) return;
      goBack(doneId);
    }, 650));
  };

  // resizable width (persisted); default 60% of viewport, expand → full width.
  const maxW = typeof window !== 'undefined' ? window.innerWidth : 1200;
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem('nexus.taskDrawerWidth'));
    return saved >= 420 ? Math.min(saved, maxW) : Math.round(maxW * 0.6);
  });
  useEffect(() => { localStorage.setItem('nexus.taskDrawerWidth', String(width)); }, [width]);
  const dragging = useRef(false);
  useEffect(() => {
    const move = (e) => { if (dragging.current) setWidth(Math.max(420, Math.min(maxW, maxW - e.clientX))); };
    const up = () => { dragging.current = false; document.body.style.userSelect = ''; };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  }, [maxW]);
  const expanded = width >= maxW - 2;
  const toggleExpand = () => setWidth(expanded ? Math.round(maxW * 0.6) : maxW);

  // On a phone the drawer is always full-bleed: there's no room for a 60%
  // drawer, so the expand/collapse toggle and the drag-to-resize handle are
  // both dropped and the saved width is ignored.
  const isMobile = useIsMobile();

  // Derive relations from the live task list (robust against optimistic updates).
  // In display order: due date then priority, or the order they were dragged
  // into (orderSubtasks).
  const subtasks = useMemo(() => orderSubtasks(tasks.filter((t) => t.parentTaskId === activeId), taskById[activeId]),
    [tasks, activeId, taskById]);
  const blockedBy = useMemo(() => (task?.blockedByIds || []).map((id) => taskById[id]).filter(Boolean), [task, taskById]);
  const blocking = useMemo(() => (task?.blockingIds || []).map((id) => taskById[id]).filter(Boolean), [task, taskById]);
  const depCandidates = useMemo(
    () => tasks.filter((t) => t.id !== activeId && !t.parentTaskId && t.projectId === task?.projectId && !(task?.blockedByIds || []).includes(t.id)),
    [tasks, activeId, task],
  );

  if (!task) {
    // Opened before the task list has arrived (a link from an email, header
    // search, a ticket's linked task): show the drawer opening rather than
    // nothing, so a click visibly did something. Once loading is done a
    // missing task still renders nothing, exactly as before.
    if (!store.loading) return null;
    return createPortal(
      <div className="nx-tasks-portal" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} style={{ position: 'fixed', inset: 0, zIndex, fontFamily: FONT }}>
        <aside role="status" aria-live="polite" aria-busy="true" style={{ position: 'absolute', right: 0, top: 0, height: '100%', width: isMobile ? '100%' : width, maxWidth: '100%', display: 'flex', flexDirection: 'column', background: NX.surface, borderLeft: `1px solid ${NX.border}`, boxShadow: '-8px 0 40px rgba(0,0,0,0.18)' }}>
          <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '10px 14px', borderBottom: `1px solid ${NX.border}` }}>
            <button onClick={onClose} title="Close" aria-label="Close" style={{ ...btn('ghost'), padding: 7, color: NX.faint }}><X size={16} /></button>
          </div>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, padding: 24, textAlign: 'center' }}>
            <Spinner size="section" />
            <div style={{ fontSize: 15, fontWeight: 700, color: NX.ink }}>Opening task…</div>
            <div style={{ fontSize: 12.5, color: NX.faint }}>Getting the task details ready.</div>
          </div>
        </aside>
      </div>,
      document.body,
    );
  }
  // Shared the moment the task has a project or a collaborator - the same rule
  // My Tasks used for its Task Visibility column before that column was removed
  // in favor of this indicator.
  const shared = (task.followerIds || []).length > 0 || !!task.projectId;
  // The whole drawer autosaves - no Save button, every field commits on
  // change - so a saved edit needs its own confirmation the way an explicit
  // Save click gets one for free. Reuses the same undo-toast plumbing
  // completing/deleting a task already offers (TasksContext.jsx): captures
  // each touched key's PRIOR value before the write, then a single Undo
  // restores all of them together. Fires optimistically, matching how the
  // edit itself already appears in the UI before the network round trip
  // finishes - a failed save is surfaced separately by updateTask's own
  // alert, so this doesn't also need to handle that case.
  const patch = (p) => {
    const prev = {};
    for (const k of Object.keys(p)) prev[k] = task[k];
    const result = updateTask(activeId, p);
    offerUndo('Changes saved', () => updateTask(activeId, prev).catch(() => {}));
    return result;
  };

  const counts = {
    comments: (task.commentIds || []).length,
    attachments: (task.attachmentIds || []).length,
    subtasks: subtasks.length,
    dependencies: blockedBy.length + blocking.length,
  };

  const addDependency = (dep) => {
    patch({ blockedByIds: [...(task.blockedByIds || []), dep.id], dependencyTypes: { ...(task.dependencyTypes || {}), [dep.id]: 'FS' } });
    updateTask(dep.id, { blockingIds: [...(dep.blockingIds || []), activeId] });
  };
  const removeDependency = (depId) => {
    const dt = { ...(task.dependencyTypes || {}) }; delete dt[depId];
    patch({ blockedByIds: (task.blockedByIds || []).filter((x) => x !== depId), dependencyTypes: dt });
    const dep = taskById[depId];
    if (dep) updateTask(depId, { blockingIds: (dep.blockingIds || []).filter((x) => x !== activeId) });
  };
  const setDependencyType = (depId, type) => {
    patch({ dependencyTypes: { ...(task.dependencyTypes || {}), [depId]: type } });
  };

  const TABS = [
    ['overview', 'Overview'], ['comments', 'Comments'], ['activity', 'Activity'],
    ['attachments', 'Attachments'], ['subtasks', 'Subtasks'], ['dependencies', 'Dependencies'], ['properties', 'Properties'],
  ];
  // Phones stack Overview (which already contains its own Attachments block)
  // and then the Comments|All-activity block. Attachments is NOT repeated here,
  // and Subtasks/Dependencies/Properties are left off the phone layout.
  const MOBILE_SECTIONS = ['overview'];

  const paneFor = (key) => {
    switch (key) {
      case 'overview': return (
        <OverviewTab
          task={task} patch={patch} people={people} projectName={projectName} teamName={teamName} teams={teams} projects={projects}
          blockedBy={blockedBy} depCandidates={depCandidates} addDependency={addDependency} removeDependency={removeDependency}
          setDependencyType={setDependencyType}
          subtasks={subtasks} createTask={createTask} updateTask={updateTask} onOpenSub={openSub}
          nameOf={nameOf} myEmail={myEmail} getComments={getComments} addComment={addComment} refresh={store.refresh}
          onViewAllComments={() => setTab('comments')}
        />
      );
      case 'comments':     return <CommentsTab task={task} nameOf={nameOf} myEmail={myEmail} getComments={getComments} addComment={addComment} />;
      case 'activity':     return <ActivityTab taskId={activeId} nameOf={nameOf} />;
      case 'attachments':  return <AttachmentsTab task={task} refresh={store.refresh} />;
      case 'subtasks':     return <SubtasksTab task={task} subtasks={subtasks} createTask={createTask} updateTask={updateTask} people={people} onOpenSub={openSub} />;
      case 'dependencies': return <DependenciesTab blockedBy={blockedBy} blocking={blocking} task={task} removeDependency={removeDependency} />;
      case 'properties':   return <PropertiesTab task={task} nameOf={nameOf} projectName={projectName} teamName={teamName} customFields={customFields} patch={patch} />;
      default:             return null;
    }
  };

  return createPortal(
    <div className="nx-tasks-portal" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} style={{ position: 'fixed', inset: 0, zIndex, fontFamily: FONT }}>
      <aside style={{ position: 'absolute', right: 0, top: 0, height: '100%', width: isMobile ? '100%' : width, maxWidth: '100%', display: 'flex', flexDirection: 'column', background: NX.surface, borderLeft: `1px solid ${NX.border}`, boxShadow: '-8px 0 40px rgba(0,0,0,0.18)' }}>
        {/* drag handle */}
        {!isMobile && (
          <div onMouseDown={() => { dragging.current = true; document.body.style.userSelect = 'none'; }} title="Drag to resize" style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: 6, cursor: 'ew-resize', zIndex: 5 }} />
        )}

        {/* header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: `1px solid ${NX.border}`, flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {/* On a phone this collapses to its circle-check icon - the label is
                the widest thing in the header and crowds out the actions. */}
            <button onClick={markComplete} title={isMissed(task) ? MISSED_TITLE : task.completed ? 'Completed' : 'Mark Complete'}
              style={{ ...btn('outline'), padding: isMobile ? 7 : '6px 10px', fontSize: 12, color: isMissed(task) ? NX.dim : task.completed ? NX.green : NX.dim }}>
              {isMissed(task) ? <XCircle size={15} /> : task.completed ? <CheckCircle2 size={15} style={{ color: NX.green }} /> : <Circle size={15} />}
              {!isMobile && (isMissed(task) ? 'Missed' : task.completed ? 'Completed' : 'Mark Complete')}
            </button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <MembersMenu task={task} people={people} nameOf={nameOf} patch={patch} />
            <button onClick={() => setShareOpen(true)} title="Share" style={{ ...btn('outline'), padding: '6px 10px', fontSize: 12, color: NX.dim }}><Share2 size={14} /> Share</button>
            {/* Who can see this task, in the slot the Like button used to hold.
                An INDICATOR, not a control: visibility here is derived (a task
                is shared the moment it has a project or a collaborator, the
                same rule My Tasks reads), so there is nothing single to toggle -
                add a project or a collaborator and it turns. */}
            <span title={shared
              ? 'Shared - people on this task\u2019s project and its collaborators can see it'
              : 'Only me - this task has no project and no collaborators yet'}
              style={{ ...btn('ghost'), padding: 7, color: shared ? NX.green : NX.dim, cursor: 'default' }}>
              {shared ? <Globe size={16} /> : <Lock size={16} />}
            </span>
            <button onClick={() => { navigator.clipboard?.writeText(`${window.location.origin}${window.location.pathname}?task=${task.id}`); }} title="Copy Task Link" style={{ ...btn('ghost'), padding: 7, color: NX.faint }}><Link2 size={16} /></button>
            {!isMobile && (
              <button onClick={toggleExpand} title={expanded ? 'Collapse' : 'Expand'} style={{ ...btn('ghost'), padding: 7, color: NX.faint }}>
                {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
              </button>
            )}
            <Pop width={210} trigger={(t) => <button onClick={t} title="More Actions" style={{ ...btn('ghost'), padding: 7, color: NX.faint }}><MoreHorizontal size={16} /></button>}>
              {(close) => (
                <>
                  {onEdit && <MenuItem icon={<Pencil size={14} />} onClick={() => { onEdit(activeId); close(); }}>Edit Task</MenuItem>}
                  {/* Filed as a task when it is really a request for a team
                      (Neil, 10/05: "employees ... may still do it as a task"). */}
                  <MenuItem icon={<Ticket size={14} />} onClick={() => { setConverting(true); close(); }}>Convert to Ticket</MenuItem>
                  <MenuItem icon={<Diamond size={14} style={{ color: task.isMilestone ? NX.purple : undefined }} />} onClick={() => { patch({ isMilestone: !task.isMilestone }); close(); }}>
                    {task.isMilestone ? 'Unmark milestone' : 'Mark as milestone'}
                  </MenuItem>
                  <MenuItem danger icon={<Trash2 size={14} />} onClick={() => {
                    close();
                    const sub = !!task.parentTaskId;
                    if (!window.confirm(sub ? `Delete subtask "${task.title}"?` : `Delete "${task.title}" and its subtasks?`)) return;
                    const gone = activeId;
                    deleteTask(gone);
                    goBack(gone);
                  }}>
                    {task.parentTaskId ? 'Delete Subtask' : 'Delete Task'}
                  </MenuItem>
                </>
              )}
            </Pop>
            <button onClick={() => (trail.length ? goBack() : onClose())}
              title={trail.length && taskById[trail[trail.length - 1]] ? `Back to ${taskById[trail[trail.length - 1]].title}` : 'Close'}
              style={{ ...btn('ghost'), padding: 7, color: NX.faint }}><ArrowRightToLine size={18} /></button>
          </div>
        </div>

        {/* title + tabs */}
        <div style={{ padding: '14px 18px 0', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12 }}>
            {parent && (
              <button onClick={() => goBack()} title={`Back to ${parent.title}`} aria-label="Back to main task" style={{ ...btn('ghost'), padding: 4, color: NX.faint }}><ArrowLeft size={18} /></button>
            )}
            <TitleInput key={activeId} value={task.title} completed={task.completed} onCommit={(v) => v.trim() && v !== task.title && patch({ title: v.trim() })} />
          </div>
          {/* Whose subtask this is, under the title (Sagar, Oct 13 2026) -
              and the way back to it. */}
          {task.parentTaskId && (
            <div data-testid="subtask-of" style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '-6px 0 12px', fontSize: 12.5, color: NX.dim }}>
              <CornerDownRight size={14} style={{ color: NX.faint, flexShrink: 0 }} />
              <span>Subtask of</span>
              {parent ? (
                <button type="button" onClick={() => goBack()} title="Open the main task"
                  style={{ border: 'none', background: 'transparent', padding: 0, cursor: 'pointer', fontFamily: FONT, fontSize: 12.5, fontWeight: 600, color: NX.blue, textAlign: 'left', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {parent.title}
                </button>
              ) : <span style={{ fontWeight: 600 }}>a task you cannot open</span>}
            </div>
          )}
          {/* Tabs are desktop-only. A phone has no room for seven of them, so
              the body stacks every section instead (see below). */}
          {!isMobile && (
            <div className="scroll-tabs" style={{ display: 'flex', gap: 2, borderBottom: `1px solid ${NX.border}`, overflowX: 'auto' }}>
              {TABS.map(([key, label]) => {
                const on = key === tab;
                return (
                  <button key={key} onClick={() => setTab(key)} style={{
                    display: 'flex', alignItems: 'center', gap: 6, padding: '9px 12px', whiteSpace: 'nowrap',
                    border: 'none', borderBottom: `2px solid ${on ? NX.primary : 'transparent'}`, background: 'transparent',
                    cursor: 'pointer', fontSize: 13, fontWeight: 600, fontFamily: FONT, color: on ? NX.ink : NX.dim,
                  }}>
                    {label}
                    {counts[key] > 0 && <span style={{ background: NX.hover, borderRadius: 999, padding: '1px 6px', fontSize: 11, color: NX.dim }}>{counts[key]}</span>}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* body - one tab on desktop; on mobile the sections stack in a single
            scroll: Overview, Attachments, then Comments/Activity as one block
            with its own sub-tabs. Subtasks, Dependencies and Properties are
            desktop-only. */}
        <div className="scroll-tabs" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px 18px 24px' }}>
          {isMobile ? (
            <>
              {MOBILE_SECTIONS.map((key) => (
                <section key={key} style={{ marginBottom: 18 }}>
                  {key !== 'overview' && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '16px 0 10px', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.3, color: NX.faint }}>
                      {Object.fromEntries(TABS)[key]}
                      {counts[key] > 0 && <span style={{ background: NX.hover, borderRadius: 999, padding: '1px 6px', fontSize: 11, color: NX.dim }}>{counts[key]}</span>}
                    </div>
                  )}
                  {paneFor(key)}
                </section>
              ))}
              <DiscussionPane
                task={task} taskId={activeId} nameOf={nameOf} myEmail={myEmail}
                getComments={getComments} addComment={addComment}
              />
            </>
          ) : paneFor(tab)}
        </div>
        {shareOpen && <ShareModal task={task} people={people} nameOf={nameOf} patch={patch} onClose={() => setShareOpen(false)} />}
        {converting && (
          <Suspense fallback={null}>
            <CreateTicketModal onClose={() => setConverting(false)} onCreated={() => store.refresh?.()}
              fromTask={{ id: task.id, title: task.title, description: task.description, priority: task.priority,
                ownerId: task.ownerId, fileCount: (task.attachmentIds || []).length }} />
          </Suspense>
        )}
      </aside>
    </div>,
    document.body,
  );
}

// ── Members (collaborators) menu ─────────────────────────────────────────────
// Shared by MembersMenu below and the Properties tab's own Collaborators row -
// they were two copies of the same unfiltered checkbox list, easy to miss a
// search box on one and not the other. One body, used by both triggers.
// `onChange(nextEmails, adding)` gets the whole list: a Teams row (teamPicks)
// adds or removes several people in one click, so a per-email toggle no
// longer fits. `adding` is what the phone callers close the menu on.
function CollaboratorMenuBody({ people, selected, onChange }) {
  const [q, setQ] = useState('');
  const queryRef = useRef(null);
  const frequent = useFrequentCollaborators();
  const { teams, createTeam } = useTasks();
  // A team saved from here is the person's own (personal) until a manager
  // approves it - see TaskTeam.approval_status.
  const saveTeam = ({ name, memberIds }) => createTeam({ name, memberIds, personal: true });
  const filtered = q.trim() ? matchPeople(people, q) : people;
  // Nothing typed: the people you share the most tasks with first, then
  // everyone (the create window's Collaborators field does the same).
  const top = q.trim() ? [] : frequentRows(people, frequent);
  const teamRows = pickableTeams(teams, people, q).length;
  // Same as the assignee picker: once a name is checked, the query that found
  // it has done its job - reset it and put the cursor back so the next name
  // can be typed straight away.
  const pickTeam = (next, adding) => { onChange(next, adding); if (adding) { setQ(''); queryRef.current?.focus(); } };
  const pick = (email) => {
    const adding = !selected.includes(email);
    onChange(adding ? [...selected, email] : selected.filter((e) => e !== email), adding);
    if (adding) { setQ(''); queryRef.current?.focus(); }
  };
  // Up / Down move the highlight, Enter takes it (lib/listNav.js).
  const navItems = [...top, ...filtered];
  const nav = useListNav(navItems, { query: q, onPick: (u) => pick(u.email) });
  const row = (u, keyPrefix, navIndex) => (
    <label key={keyPrefix + u.email} {...nav.optionProps(navIndex)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', fontSize: 13, cursor: 'pointer' }}>
      <input type="checkbox" checked={selected.includes(u.email)} onChange={() => pick(u.email)} />
      <Avatar email={u.email} name={u.name} size={20} card={false} />
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.name}</span>
      {u.external && <ExternalTag />}
    </label>
  );
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: NX.faint, padding: '4px 6px' }}>Collaborators</div>
      <input className="nx-inline-edit" ref={queryRef} autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people…"
        {...nav.inputProps}
        onKeyDown={(e) => {
          // Enter takes the highlighted person; a search that matches a team
          // and nobody takes that team instead of doing nothing.
          const team = (e.key === 'Enter' && !navItems.length) ? firstTeamPick(teams, people, q) : null;
          if (team) { e.preventDefault(); const r = toggleRoster(selected, team.roster); pickTeam(r.next, r.adding); return; }
          nav.onKeyDown(e);
        }}
        style={{ width: '100%', boxSizing: 'border-box', border: 'none', borderBottom: `1px solid ${NX.border}`, padding: '6px 8px', fontSize: 13, fontFamily: FONT, color: NX.ink }} />
      <div className="nx-scroll" style={{ maxHeight: 260, overflowY: 'auto' }}>
        <TeamPicks teams={teams} people={people} selected={selected} query={q} onSaveTeam={saveTeam} onChange={pickTeam} />
        {top.length > 0 && <MenuCaption inset={8}>Frequent</MenuCaption>}
        {top.map((u, i) => row(u, 'f:', i))}
        {top.length > 0 ? <MenuCaption inset={8}>All</MenuCaption> : (teamRows > 0 && filtered.length > 0 && <MenuCaption inset={8}>People</MenuCaption>)}
        {filtered.map((u, i) => row(u, '', top.length + i))}
        {filtered.length === 0 && teamRows === 0 && <div style={{ padding: 8, fontSize: 12, color: NX.faint }}>{people.length === 0 ? 'No people' : 'No match'}</div>}
      </div>
    </div>
  );
}

// Same shape as CollaboratorMenuBody, for adding an EXTRA project - `exclude`
// keeps out the primary project and whatever's already added, so a project
// only ever appears once in this list.
function ProjectMenuBody({ projects, exclude, onPick }) {
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const filtered = (projects || [])
    .filter((p) => !p.archived && !exclude.includes(p.id) && (!needle || (p.name || '').toLowerCase().includes(needle)))
    .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'en', { sensitivity: 'base', numeric: true }));
  const nav = useListNav(filtered, { query: q, onPick: (p) => onPick(p.id) });
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: NX.faint, padding: '4px 6px' }}>Also in Project</div>
      <input className="nx-inline-edit" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search projects…"
        {...nav.inputProps} onKeyDown={nav.onKeyDown}
        style={{ width: '100%', boxSizing: 'border-box', border: 'none', borderBottom: `1px solid ${NX.border}`, padding: '6px 8px', fontSize: 13, fontFamily: FONT, color: NX.ink }} />
      <div className="nx-scroll" style={{ maxHeight: 220, overflowY: 'auto' }}>
        {filtered.map((p, i) => (
          <button key={p.id} type="button" tabIndex={-1} className="nx-menu-row" {...nav.optionProps(i)} onClick={() => onPick(p.id)} style={{ display: 'flex', width: '100%', textAlign: 'left', alignItems: 'center', gap: 8, padding: '6px 8px', fontSize: 13, border: 'none', background: 'transparent', cursor: 'pointer', color: NX.ink, fontFamily: FONT }}>
            {p.name}
          </button>
        ))}
        {filtered.length === 0 && <div style={{ padding: 8, fontSize: 12, color: NX.faint }}>{needle ? 'No match' : 'No other projects'}</div>}
      </div>
    </div>
  );
}

function MembersMenu({ task, people, nameOf, patch }) {
  const isMobile = useIsMobile();
  const followers = task.followerIds || [];
  return (
    <div style={{ display: 'flex', alignItems: 'center' }}>
      {followers.slice(0, 3).map((em, i) => <span key={em} style={{ marginLeft: i ? -6 : 0 }}><Avatar email={em} name={nameOf(em)} size={24} /></span>)}
      <Pop width={230} trigger={(t) => (
        <button onClick={t} title="Collaborators" style={{ ...btn('ghost'), padding: 5, marginLeft: followers.length ? 2 : 0, color: NX.faint }}><UserPlus size={16} /></button>
      )}>
        {(close) => <CollaboratorMenuBody people={people} selected={followers}
          onChange={(next, adding) => { patch({ followerIds: next }); if (isMobile && adding) close(); }} />}
      </Pop>
    </div>
  );
}

// ── Share modal ──────────────────────────────────────────────────────────────
function ShareModal({ task, people, nameOf, patch, onClose }) {
  const level = task.accessLevel || 'org';
  const followers = task.followerIds || [];
  const [copied, setCopied] = useState(false);
  const copy = () => { navigator.clipboard?.writeText(`${window.location.origin}${window.location.pathname}?task=${task.id}`); setCopied(true); setTimeout(() => setCopied(false), 1500); };
  const OPTS = [
    { key: 'org', icon: Globe, label: 'Everyone in your organization', desc: 'Any organization member can find and access this task.' },
    { key: 'restricted', icon: Lock, label: 'Members of this task and connected projects', desc: 'Only invited members and members of connected projects can access.' },
  ];
  return createPortal(
    <div className="nx-tasks-portal" onMouseDown={(e) => e.target === e.currentTarget && onClose()} style={{ position: 'fixed', inset: 0, background: 'rgba(17,24,39,0.45)', zIndex: 5000, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '9vh 16px', fontFamily: FONT }}>
      <div style={{ background: NX.surface, borderRadius: 14, width: 520, maxWidth: '100%', boxShadow: '0 24px 60px rgba(0,0,0,0.28)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '15px 20px', borderBottom: `1px solid ${NX.border}` }}>
          <div style={{ fontSize: 16, fontWeight: 700 }}>Share “{task.title}”</div>
          <button onClick={onClose} style={{ ...btn('ghost'), padding: 6 }}><X size={18} /></button>
        </div>
        <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: NX.dim, marginBottom: 8 }}>Who has access</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {OPTS.map((o) => (
                <button key={o.key} onClick={() => patch({ accessLevel: o.key })} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, textAlign: 'left', padding: 12, borderRadius: 10, border: `1px solid ${level === o.key ? NX.blue : NX.border}`, background: level === o.key ? 'rgba(37,99,235,0.10)' : NX.surface, cursor: 'pointer', fontFamily: FONT }}>
                  <o.icon size={16} style={{ color: NX.dim, marginTop: 2 }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: NX.ink }}>{o.label}</div>
                    <div style={{ fontSize: 12, color: NX.dim, marginTop: 2 }}>{o.desc}</div>
                  </div>
                  {level === o.key && <Check size={15} style={{ color: NX.blue }} />}
                </button>
              ))}
            </div>
          </div>
          {followers.length > 0 && (
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: NX.dim, marginBottom: 8 }}>Collaborators</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {followers.map((em) => <span key={em} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: `1px solid ${NX.border}`, borderRadius: 999, padding: '3px 10px 3px 3px', fontSize: 12 }}><Avatar email={em} name={nameOf(em)} size={20} /> {nameOf(em)}</span>)}
              </div>
            </div>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '13px 20px', borderTop: `1px solid ${NX.border}` }}>
          <button onClick={copy} style={btn('outline')}><Link2 size={14} /> {copied ? 'Copied!' : 'Copy link'}</button>
          <button onClick={onClose} style={btn('primary')}>Done</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── title (uncontrolled-ish, commits on blur/Enter) ─────────────────────────
function TitleInput({ value, completed, onCommit }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <input
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => onCommit(v)}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      className="nx-inline-edit"
      style={{ width: '100%', border: 'none', fontFamily: FONT, fontSize: 20, fontWeight: 700, color: completed ? NX.faint : NX.ink, textDecoration: completed ? 'line-through' : 'none' }}
    />
  );
}

// ── Overview ────────────────────────────────────────────────────────────────
function OverviewTab({ task, patch, people, projectName, teamName, teams, projects, blockedBy, depCandidates, addDependency, removeDependency, setDependencyType, subtasks, createTask, updateTask, onOpenSub, nameOf, myEmail, getComments, addComment, refresh, onViewAllComments }) {
  const isMobile = useIsMobile();
  const { statusMeta, statusOrder, statusOrderFor, customFields = [], tasks: allTasks = [] } = useTasks();
  // The task's own project, not the view's: this drawer opens from My Tasks and
  // from search, where no project is locked.
  const taskStatusOrder = statusOrderFor ? statusOrderFor(task.projectId) : statusOrder;
  const [recStep, setRecStep] = useState('root');
  // Recurrence end condition ("Ends" - Never / On date / After occurrences).
  // Local mode so "On date"/"After" stay selected before a value is entered
  // (an empty until/count is falsy and would otherwise read back as "Never").
  const [recEndMode, setRecEndMode] = useState('never');
  useEffect(() => {
    const r = task.recurrence;
    setRecEndMode(r?.until ? 'on' : r?.count != null ? 'after' : 'never');
  }, [task.id]);
  // Setting any recurrence flips the task to "Recurring"; clearing it reverts a
  // still-recurring status back to Not Started.
  const setRecurrence = (rec) => patch({
    recurrence: rec,
    status: rec ? 'recurring' : (task.status === 'recurring' ? 'not_started' : task.status),
  });
  // Pick a frequency from the popover, carrying any existing end condition over.
  const pickFreq = (base) => {
    const cur = task.recurrence || {};
    const r = { ...base };
    if (cur.until) r.until = cur.until;
    if (cur.count != null) r.count = cur.count;
    setRecEndMode(cur.until ? 'on' : cur.count != null ? 'after' : 'never');
    setRecurrence(r);
  };
  // Replace the end condition on the current recurrence (strips until+count first).
  const patchRecEnd = (changes) => {
    const base = { ...(task.recurrence || {}) };
    delete base.until; delete base.count;
    setRecurrence({ ...base, ...changes });
  };
  const onRecEndMode = (m) => {
    setRecEndMode(m);
    if (m === 'never') patchRecEnd({});
    else if (m === 'on') patchRecEnd(task.recurrence?.until ? { until: task.recurrence.until } : {});
    else if (m === 'after') patchRecEnd(task.recurrence?.count != null ? { count: task.recurrence.count } : {});
  };
  const recSel = { ...inputStyle, width: 'auto', padding: '5px 8px', fontSize: 12, cursor: 'pointer' };
  const sm = statusMeta[task.status] || {};
  const pm = PRIORITY_META[task.priority] || {};
  const projectTeams = (teams || []).filter((tm) => teamInProject(tm, task.projectId));
  const followers = task.followerIds || [];
  const toggleFollower = (email) => patch({ followerIds: followers.includes(email) ? followers.filter((e) => e !== email) : [...followers, email] });

  return (
    <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13 }}>
      <Row label="Assignee">
        <div style={{ minWidth: 220 }}>
          {/* Several people can hold one task; any of them completing it
              completes it for all (one row, one flag). Subtask rows below
              keep the single picker - a subtask is a unit of one person's
              work, and the multi picker does not fit an 18px inline row. */}
          <PersonMultiSelect value={taskAssignees(task)} people={people} addTitle="Add assignee"
            onChange={(list) => patch({ assigneeIds: list })} placeholder="Unassigned" />
        </div>
      </Row>

      <Row label="Collaborators">
        {followers.map((em) => (
          <span key={em} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: `1px solid ${NX.border}`, borderRadius: 999, padding: '3px 9px 3px 3px', fontSize: 12 }}>
            <Avatar email={em} name={nameOf(em)} size={20} /> {nameOf(em)}
            <button onClick={() => toggleFollower(em)} title="Remove" style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: NX.faint, padding: 0, display: 'flex' }}><X size={12} /></button>
          </span>
        ))}
        <Pop width={220} trigger={(t) => (
          <button onClick={t} title="Add collaborators" style={{
            width: 26, height: 26, borderRadius: '50%', border: `1.5px dashed ${NX.border}`,
            background: 'transparent', color: NX.faint, cursor: 'pointer', padding: 0,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}><UserPlus size={13} /></button>
        )}>
          {/* Same as the assignee picker: on a phone the menu covers the form,
              so adding a name closes it. Unchecking one keeps it open. */}
          {(close) => <CollaboratorMenuBody people={people} selected={followers}
            onChange={(next, adding) => { patch({ followerIds: next }); if (isMobile && adding) close(); }} />}
        </Pop>
      </Row>

      <Row label="Status">
        <Pop width={176} trigger={(t) => <button onClick={t} style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: 0 }}><Chip color={sm.color} tint={sm.tint}>{sm.label}</Chip></button>}>
          {(close) => taskStatusOrder.map((s) => <MenuItem key={s} onClick={() => { patch({ status: s }); close(); }}>{statusMeta[s]?.label || s}</MenuItem>)}
        </Pop>
      </Row>

      <Row label="Priority">
        <Pop width={160} trigger={(t) => <button onClick={t} style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: 0 }}><Chip color={pm.color} tint={pm.tint}>{pm.label}</Chip></button>}>
          {(close) => PRIORITY_ORDER.map((p) => <MenuItem key={p} onClick={() => { patch({ priority: p }); close(); }}>{PRIORITY_META[p].label}</MenuItem>)}
        </Pop>
      </Row>

      {/* Start Date was print-only here (it appears in the export block below)
          while the List view's Timeline cell was the one place that could set
          it. Editable, above Due Date, so the pair reads as the range the
          Timeline column draws. Empty is normal - it fills itself when the task
          leaves Not Started. */}
      <Row label="Start Date">
        <DateField value={task.startOn || ''} onChange={(v) => patch({ startOn: v || '' })} compact
          style={task.startOn ? { ...inputStyle, width: 'auto', padding: '6px 9px', fontSize: 12 } : undefined} />
      </Row>

      <Row label="Due Date">
        <DateField value={task.dueOn || ''} onChange={(v) => patch({ dueOn: v || '' })} compact noPast
          style={task.dueOn ? { ...inputStyle, width: 'auto', padding: '6px 9px', fontSize: 12 } : undefined} />
        <DueBadge task={task} nameOf={nameOf} />
      </Row>
      <DueNegotiation task={task} />

      <Row label="Project">
        <div style={{ minWidth: 220 }}>
          <ProjectPicker
            projects={projects} teams={teams} myEmail={myEmail}
            value={task.projectId || ''} allowNone noneLabel="No project"
            onChange={(id) => { if (id !== task.projectId) patch({ projectId: id, teamId: '', projectIds: (task.projectIds || []).filter((p) => p !== id) }); }}
          />
        </div>
      </Row>

      <Row label="Also In">
        {(task.projectIds || []).map((pid) => (
          <span key={pid} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: `1px solid ${NX.border}`, borderRadius: 999, padding: '3px 9px 3px 9px', fontSize: 12 }}>
            {projectName(pid) || pid}
            <button onClick={() => patch({ projectIds: (task.projectIds || []).filter((p) => p !== pid) })} title="Remove" style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: NX.faint, padding: 0, display: 'flex' }}><X size={12} /></button>
          </span>
        ))}
        {task.projectId ? (
          <Pop width={360} trigger={(t) => (
            <button onClick={t} title="Add another project" style={{
              width: 26, height: 26, borderRadius: '50%', border: `1.5px dashed ${NX.border}`,
              background: 'transparent', color: NX.faint, cursor: 'pointer', padding: 0,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}><Plus size={13} /></button>
          )}>
            {(close) => <ProjectMenuBody projects={projects} exclude={[task.projectId, ...(task.projectIds || [])]}
              onPick={(id) => { patch({ projectIds: [...(task.projectIds || []), id] }); close(); }} />}
          </Pop>
        ) : (
          <span style={{ color: NX.faint, fontSize: 13 }}>Pick a project first</span>
        )}
      </Row>

      <Row label="Team">
        {task.projectId ? (
          <Pop width={200} trigger={(t) => (
            <button onClick={t} style={{ display: 'flex', alignItems: 'center', gap: 5, border: 'none', background: 'transparent', cursor: 'pointer', padding: 0, color: task.teamId ? NX.ink : NX.faint, fontSize: 13, fontFamily: FONT }}>
              {teamName(task.teamId) || 'No team'} <ChevronDown size={13} style={{ color: NX.faint }} />
            </button>
          )}>
            {(close) => (
              <>
                <MenuItem icon={!task.teamId ? <Check size={13} /> : <span style={{ width: 13, display: 'inline-block' }} />} onClick={() => { patch({ teamId: '' }); close(); }}>No team</MenuItem>
                {projectTeams.length === 0 ? (
                  <div style={{ padding: 9, fontSize: 12, color: NX.faint }}>No teams in this project</div>
                ) : projectTeams.map((tm) => (
                  <MenuItem key={tm.id} icon={task.teamId === tm.id ? <Check size={13} /> : <span style={{ width: 13, display: 'inline-block' }} />} onClick={() => { patch({ teamId: tm.id }); close(); }}>{tm.name}</MenuItem>
                ))}
              </>
            )}
          </Pop>
        ) : (
          <span style={{ color: NX.faint, fontSize: 13 }}>Pick a project first</span>
        )}
      </Row>

      {/* The project's custom columns, right here on the task (Oct 13 2026) -
          they used to live only on the Properties tab, which most people
          never opened and phones do not show. */}
      <TaskCustomFieldRows task={task} customFields={customFields} projectName={projectName} patch={patch} />

      <Row label="Blocked By">
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 6 }}>
          {blockedBy.map((b) => {
            const dt = (task.dependencyTypes || {})[b.id] || 'FS';
            return (
              <div key={b.id} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
                <Pop width={210} trigger={(t) => (
                  <button onClick={t} style={{ display: 'flex', alignItems: 'center', gap: 5, border: `1px solid ${NX.border}`, borderRadius: 8, background: 'transparent', cursor: 'pointer', padding: '5px 9px', fontSize: 12, fontWeight: 600, color: NX.amber }}>
                    <Ban size={13} /> Blocked by · {dt} <ChevronDown size={11} />
                  </button>
                )}>
                  {(close) => Object.entries(DEP_TYPES).map(([k, label]) => (
                    <MenuItem key={k} icon={dt === k ? <Check size={13} /> : <span style={{ width: 13, display: 'inline-block' }} />} onClick={() => { setDependencyType(b.id, k); close(); }}>
                      {label} · {k}
                    </MenuItem>
                  ))}
                </Pop>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: `1px solid ${NX.border}`, borderRadius: 999, padding: '3px 10px', fontSize: 12, color: NX.ink }}>
                  <CheckCircle2 size={13} style={{ color: NX.faint }} />
                  {b.title}{b.dueOn ? ` · ${fmtDate(b.dueOn)}` : ''}
                  <button onClick={() => removeDependency(b.id)} style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: NX.faint, padding: 0, display: 'flex' }}><X size={12} /></button>
                </span>
              </div>
            );
          })}
          <Pop width={280} trigger={(t) => <button onClick={t} style={{ ...btn('outline'), padding: '5px 11px', fontSize: 12 }}>Add Dependency</button>}>
            {(close) => <DependencyPickerBody candidates={depCandidates} onPick={(c) => { addDependency(c); close(); }} />}
          </Pop>
        </div>
      </Row>

      <Row label="Recurrence">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
          <Pop width={300} trigger={(t) => <button onClick={() => { setRecStep('root'); t(); }} style={{ ...btn('ghost'), padding: '5px 8px', fontSize: 12 }}><Repeat size={13} /> {recurrenceLabel(task.recurrence)}</button>}>
            {(close) => {
              if (recStep === 'weekly') {
                const cur = task.recurrence?.freq === 'weekly' ? task.recurrence : {};
                const days = cur.daysOfWeek ?? (cur.dayOfWeek != null ? [cur.dayOfWeek] : [1]);
                const toggle = (i) => pickFreq({ freq: 'weekly', daysOfWeek: days.includes(i) ? days.filter((x) => x !== i) : [...days, i].sort() });
                return (<>
                  <MenuItem icon={<ChevronLeft size={14} />} onClick={() => setRecStep('root')}>Back</MenuItem>
                  <div style={{ padding: '4px 10px 8px' }}>
                    <div style={{ fontSize: 11, color: NX.faint, marginBottom: 6 }}>On these days</div>
                    <RecurDayPicker value={days} onToggle={toggle} />
                  </div>
                </>);
              }
              // Monthly and Yearly name their day with the shared controls
              // (recurrence.js): "Day 15" / "Last Day", or "the Fourth
              // Friday" - applied as each one changes, like the rest of the
              // drawer.
              if (recStep === 'monthly') {
                const cur = task.recurrence?.freq === 'monthly' ? monthRuleOf(task.recurrence) : { dayOfMonth: 1 };
                return (<>
                  <MenuItem icon={<ChevronLeft size={14} />} onClick={() => setRecStep('root')}>Back</MenuItem>
                  <div style={{ padding: '4px 10px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ fontSize: 11, color: NX.faint }}>Every month on</div>
                    <MonthDayControls value={cur} seedDate={task.dueOn} selectStyle={recSel}
                      onChange={(v) => pickFreq({ freq: 'monthly', ...v })} />
                  </div>
                </>);
              }
              if (recStep === 'yearly') {
                const cur = task.recurrence?.freq === 'yearly' ? yearRuleOf(task.recurrence) : {};
                return (<>
                  <MenuItem icon={<ChevronLeft size={14} />} onClick={() => setRecStep('root')}>Back</MenuItem>
                  <div style={{ padding: '4px 10px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ fontSize: 11, color: NX.faint }}>Every year on</div>
                    <YearDayControls value={cur} seedDate={task.dueOn} selectStyle={recSel}
                      onChange={(v) => pickFreq({ freq: 'yearly', ...v })} />
                  </div>
                </>);
              }
              if (recStep === 'periodic') {
                const cur = task.recurrence?.freq === 'periodic' ? Number(task.recurrence.daysAfterCompletion) || 1 : null;
                return (<>
                  <MenuItem icon={<ChevronLeft size={14} />} onClick={() => setRecStep('root')}>Back</MenuItem>
                  {/* Any number of days: type one, Enter or Set. */}
                  <form onSubmit={(e) => { e.preventDefault(); const n = clampDays(e.currentTarget.days.value); pickFreq({ freq: 'periodic', daysAfterCompletion: n }); close(); }}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px 8px', fontSize: 12 }}>
                    <input name="days" type="number" min="1" max={MAX_PERIODIC_DAYS} step="1" defaultValue={cur ?? ''} placeholder="Other"
                      aria-label="Days after completion" style={{ ...inputStyle, width: 72, padding: '4px 6px', fontSize: 12 }} />
                    <span style={{ color: NX.faint, flex: 1 }}>days after completion</span>
                    <button type="submit" style={{ ...btn('outline'), padding: '3px 9px', fontSize: 12 }}>Set</button>
                  </form>
                  <div className="nx-scroll" style={{ maxHeight: 260, overflowY: 'auto' }}>
                    {PERIODIC_PRESETS.map((d) => (
                      <MenuItem key={d} icon={cur === d ? <Check size={13} /> : <span style={{ width: 13, display: 'inline-block' }} />}
                        onClick={() => { pickFreq({ freq: 'periodic', daysAfterCompletion: d }); close(); }}>
                        {d} day{d === 1 ? '' : 's'} after completion
                      </MenuItem>
                    ))}
                  </div>
                </>);
              }
              if (recStep === 'custom') {
                const cur = task.recurrence?.freq === 'custom' ? task.recurrence : {};
                const unit = cur.unit || 'week';
                const interval = cur.interval || 1;
                const days = cur.daysOfWeek ?? (cur.dayOfWeek != null ? [cur.dayOfWeek] : [1]);
                const applyCustom = (partial) => {
                  const next = { unit, interval, ...partial };
                  const rec = { freq: 'custom', unit: next.unit, interval: next.interval };
                  if (next.unit === 'week') rec.daysOfWeek = next.daysOfWeek ?? days;
                  // The day a month / year unit names - kept across an
                  // interval change, dropped when the unit changes.
                  const sameUnit = next.unit === unit;
                  if (next.unit === 'month') Object.assign(rec, next.monthRule ?? (sameUnit ? monthRuleOf(cur) : { dayOfMonth: ruleFromDate(task.dueOn).dayOfMonth }));
                  if (next.unit === 'year') Object.assign(rec, next.yearRule ?? (sameUnit ? yearRuleOf({ ...cur, unit: 'year' }) : {}));
                  pickFreq(rec);
                };
                return (<>
                  <MenuItem icon={<ChevronLeft size={14} />} onClick={() => setRecStep('root')}>Back</MenuItem>
                  <div style={{ padding: '4px 10px 8px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                      <span style={{ color: NX.faint }}>Every</span>
                      <input type="number" min="1" step="1" value={interval}
                        onChange={(e) => applyCustom({ interval: Math.max(1, Number(e.target.value) || 1) })}
                        style={{ ...inputStyle, width: 50, padding: '4px 6px', fontSize: 12 }} />
                      <select value={unit} onChange={(e) => applyCustom({ unit: e.target.value })} style={recSel}>
                        <option value="day">Day{interval === 1 ? '' : 's'}</option>
                        <option value="week">Week{interval === 1 ? '' : 's'}</option>
                        <option value="month">Month{interval === 1 ? '' : 's'}</option>
                        <option value="year">Year{interval === 1 ? '' : 's'}</option>
                      </select>
                    </div>
                    {unit === 'week' && (<>
                      <div style={{ fontSize: 11, color: NX.faint }}>On these days</div>
                      <RecurDayPicker value={days} onToggle={(i) => applyCustom({ unit: 'week', daysOfWeek: days.includes(i) ? days.filter((x) => x !== i) : [...days, i].sort() })} />
                    </>)}
                    {unit === 'month' && (<>
                      <div style={{ fontSize: 11, color: NX.faint }}>On</div>
                      <MonthDayControls value={monthRuleOf(cur)} seedDate={task.dueOn} selectStyle={recSel}
                        onChange={(v) => applyCustom({ monthRule: v })} />
                    </>)}
                    {unit === 'year' && (<>
                      <div style={{ fontSize: 11, color: NX.faint }}>On</div>
                      <YearDayControls value={yearRuleOf({ ...cur, unit: 'year' })} seedDate={task.dueOn} selectStyle={recSel}
                        onChange={(v) => applyCustom({ yearRule: v })} />
                    </>)}
                  </div>
                </>);
              }
              return (<>
                <MenuItem onClick={() => { setRecEndMode('never'); setRecurrence(null); close(); }}>Does not repeat</MenuItem>
                <MenuItem onClick={() => { pickFreq({ freq: 'daily' }); close(); }}>Daily</MenuItem>
                <MenuItem onClick={() => setRecStep('weekly')}>Weekly</MenuItem>
                <MenuItem onClick={() => setRecStep('monthly')}>Monthly</MenuItem>
                <MenuItem onClick={() => setRecStep('yearly')}>Yearly</MenuItem>
                <MenuItem onClick={() => setRecStep('periodic')}>Periodically</MenuItem>
                <MenuItem onClick={() => setRecStep('custom')}>Custom</MenuItem>
              </>);
            }}
          </Pop>
          {task.recurrence && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: NX.dim }}>
              <span style={{ color: NX.faint }}>Ends</span>
              <select value={recEndMode} onChange={(e) => onRecEndMode(e.target.value)} style={recSel}>
                <option value="never">Never</option>
                <option value="on">On date</option>
                <option value="after">After occurrences</option>
              </select>
              {recEndMode === 'on' && (
                <DateField value={task.recurrence.until || ''} onChange={(v) => patchRecEnd(v ? { until: v } : {})}
                  placeholder="Pick a date" style={{ ...inputStyle, width: 'auto', padding: '5px 8px', fontSize: 12 }} />
              )}
              {recEndMode === 'after' && (
                <>
                  <input type="number" min="1" step="1" value={task.recurrence.count ?? ''} placeholder="e.g. 10"
                    onChange={(e) => patchRecEnd(e.target.value ? { count: Math.max(1, Number(e.target.value)) } : {})}
                    style={{ ...inputStyle, width: 72, padding: '5px 8px', fontSize: 12 }} />
                  <span style={{ color: NX.faint }}>times</span>
                </>
              )}
            </div>
          )}
        </div>
      </Row>

      {/* Description */}
      <Section title="Description">
        <DescriptionInput task={task} value={task.description || ''} refresh={refresh}
          onCommit={(v) => v !== (task.description || '') && patch({ description: v })} />
      </Section>

      {/* Subtasks (inline) */}
      {/* Open whenever the task has subtasks (Oct 13 2026) - folded, they
          were easy to miss. */}
      <Section key={`${task.id}:${subtasks?.length > 0}`} defaultOpen={subtasks?.length > 0}
        title={subtasks?.length ? `Subtasks ${subtasks.filter((s) => s.completed).length}/${subtasks.length}` : 'Subtasks'}>
        <SubtasksTab task={task} subtasks={subtasks || []} createTask={createTask} updateTask={updateTask} people={people} onOpenSub={onOpenSub} hideHeading />
      </Section>

      {/* Time tracking - only where the task's project tracks time, or the
          task already has time on it (Oct 13 2026; see taskTracksTime). */}
      {taskTracksTime(task, projects, allTasks) && (
        <Section defaultOpen={false} title="Time Tracking">
          <TimeTracking task={task} patch={patch} />
        </Section>
      )}

      {/* Approval */}
      <Section defaultOpen={false} title="Approval">
        <Approval task={task} patch={patch} />
      </Section>

      {/* Add comment - dropped on mobile: the Comments/All-activity block at the
          bottom of the stacked layout already has a composer. */}
      {!isMobile && (
        <Section title="Comments">
          <QuickComment task={task} addComment={addComment} getComments={getComments}
            nameOf={nameOf} myEmail={myEmail} onViewAll={onViewAllComments} />
        </Section>
      )}

      {/* Attachments */}
      <Section title="Attachments">
        <AttachmentsTab task={task} refresh={refresh} />
      </Section>
    </div>
  );
}

// Overview's comment block: the latest few comments for context, then the same
// rich editor the description uses - with @mentions, which email the people
// named (backend routers/tasks.py extract_mentions).
const RECENT_COMMENTS = 3;

// Shared by both comment composers (Overview's QuickComment and the dedicated
// CommentsTab) - one implementation of "attach a file while writing a
// comment" instead of two that can drift apart, the same reason CommentItem
// itself is shared rather than duplicated per tab.
//
// Asana's own API has no comment/story parent for an attachment (see
// asana_sync._pull_attachments), so only a comment composed here gets this
// link - grouping by commentId naturally leaves every Asana-origin and
// pre-existing attachment exactly where it already was: task-level only,
// nothing guessed at.
function useCommentAttachments(taskId) {
  const [byComment, setByComment] = useState(new Map());
  const reload = useCallback(() => {
    api.getTaskAttachments(taskId).then((rows) => {
      const m = new Map();
      for (const a of rows || []) {
        if (!a.commentId) continue;
        if (!m.has(a.commentId)) m.set(a.commentId, []);
        m.get(a.commentId).push(a);
      }
      setByComment(m);
    }).catch(() => setByComment(new Map()));
  }, [taskId]);
  useEffect(() => { reload(); }, [reload]);
  return [byComment, reload];
}

// Staged-file chips under a comment composer (the paperclip that adds them
// is in the editor toolbar - RichDescription's onStageFiles). Files aren't
// uploaded here - a comment_id is required to link them (see
// uploadPendingAttachments), and the comment doesn't exist yet while its
// composer is still open.
function PendingAttachments({ files, setFiles }) {
  const remove = (i) => setFiles((p) => p.filter((_, j) => j !== i));
  if (!files.length) return null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
      {files.map((f, i) => (
        <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, border: `1px solid ${NX.border}`, borderRadius: 20, padding: '2px 8px 2px 2px', fontSize: 11.5, color: NX.dim }}>
          {f.type.startsWith('image/')
            ? <img src={URL.createObjectURL(f)} alt="" style={{ width: 18, height: 18, borderRadius: 4, objectFit: 'cover' }} />
            : <Paperclip size={11} />}
          <span style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
          <button type="button" onClick={() => remove(i)} title="Remove" style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: NX.faint, display: 'flex' }}><X size={11} /></button>
        </span>
      ))}
    </div>
  );
}

// Best-effort per file, run after the comment itself has already posted - one
// failed upload must never look like the comment failed too.
function uploadPendingAttachments(taskId, commentId, files) {
  return Promise.all(files.map((f) => uploadTaskAttachment(taskId, f, { comment_id: commentId }).catch(() => {})));
}

// Same CLAUDE.md Ctrl+V mandate every other upload widget follows
// (imageFromPaste / filesFromPaste) - stages the image rather than uploading
// immediately, since AttachmentsTab's version can upload on the spot (already
// task-scoped) but a comment's attachment needs the comment's id first.
//
// Only for a paste that lands OUTSIDE the editor. The rich editor has its own
// handlePaste that embeds an image inline and calls preventDefault, and that
// event still bubbles out to this wrapper - so staging it again posted the same
// screenshot twice, once inline in the body and once as an attachment card
// below it. Deferring to the editor keeps the image where the writer put it.
export function onPasteStage(e, setFiles) {
  if (e.defaultPrevented || e.nativeEvent?.defaultPrevented) return;
  const files = filesFromPaste(e);
  if (files.length) { e.preventDefault(); setFiles((p) => [...p, ...files]); }
}

function QuickComment({ task, addComment, getComments, nameOf, myEmail, onViewAll }) {
  const [body, setBody] = useState('');
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState([]);
  const people = usePeople();
  const [attachments, reloadAttachments] = useCommentAttachments(task.id);

  const load = useCallback(() => {
    getComments?.(task.id).then((r) => setRows(r || [])).catch(() => setRows([]));
  }, [getComments, task.id]);
  useEffect(() => { load(); }, [load]);

  const submit = async () => {
    if (isEmptyDoc(body) || busy) return;
    setBusy(true);
    try {
      const c = await addComment(task.id, body);
      setBody('');
      if (pending.length) {
        await uploadPendingAttachments(task.id, c.id, pending);
        setPending([]);
        reloadAttachments();
      }
      load();
    } catch { /* surfaced by the store */ } finally { setBusy(false); }
  };

  // Same pin/edit/delete shape as the full Comments tab (CommentsTab) - this is
  // a preview of the identical data, not a separate simplified view, so it
  // needs the same actions rather than a read-only cut-down.
  const pin = async (c) => { await api.editTaskComment(c.id, { pinned: !c.pinned }).catch(() => {}); load(); };
  const edit = async (c, text) => { await api.editTaskComment(c.id, { body: text }).catch(() => {}); load(); };
  const del = async (c) => { if (!window.confirm('Delete this comment?')) return; await api.deleteTaskComment(c.id).catch(() => {}); load(); };

  // Newest last, like a chat log - the composer sits directly under the most
  // recent line so the thread reads top to bottom into the box you type in.
  const all = rows || [];
  const shown = all.slice(-RECENT_COMMENTS);
  const hidden = all.length - shown.length;

  return (
    <div>
      {shown.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          {hidden > 0 && (
            <button onClick={onViewAll} style={{ ...btn('ghost'), padding: 0, fontSize: 12, fontWeight: 600, color: NX.primary, marginBottom: 6 }}>
              View {hidden} earlier comment{hidden === 1 ? '' : 's'}
            </button>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {/* Same CommentItem the Comments tab uses - this used to be its own
                cut-down rendering that skipped parseImportedAuthor entirely, so
                an Asana-synced comment showed as "asana-sync" with the raw
                "[Asana · Name]" stamp still in the body instead of the real
                author. Reusing the component means the two can't drift again. */}
            {shown.map((c) => (
              <CommentItem key={c.id} c={c} nameOf={nameOf} mine={c.authorId === myEmail}
                attachments={attachments.get(c.id) || []}
                onPin={() => pin(c)} onEdit={(t) => edit(c, t)} onDelete={() => del(c)} />
            ))}
          </div>
          <button onClick={onViewAll} style={{ ...btn('ghost'), padding: 0, fontSize: 12, fontWeight: 600, color: NX.primary, marginTop: 8 }}>
            View all comments ({all.length})
          </button>
        </div>
      )}
      <div onPaste={(e) => onPasteStage(e, setPending)}>
        <RichDescription
          value={body}
          onChange={setBody}
          onSubmit={submit}
          mentionPeople={people}
          minHeight={64}
          onStageFiles={(fs) => setPending((p) => [...p, ...fs])}
        />
      </div>
      <PendingAttachments files={pending} setFiles={setPending} />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 8, gap: 8 }}>
        <span style={{ fontSize: 11, color: NX.faint }}>
          Type <b>@</b> to mention someone - they'll get an email. ⌘/Ctrl+Enter to post.
        </span>
        <button onClick={submit} disabled={isEmptyDoc(body) || busy}
          style={{ ...btn('primary'), opacity: (isEmptyDoc(body) || busy) ? 0.5 : 1, flexShrink: 0 }}>
          {busy ? 'Posting…' : 'Comment'}
        </button>
      </div>
    </div>
  );
}

function DescriptionInput({ task, value, onCommit, refresh }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);

  // "+ → Attach file" puts the file on the TASK (so it shows in Attachments and
  // syncs to Asana) and hands the stored URL back so the editor can embed it.
  const attach = async (file) => {
    const row = await uploadTaskAttachment(task.id, file).catch(() => null);
    refresh?.();
    return { url: row?.url || '', name: file.name };
  };

  return (
    <RichDescription
      value={v}
      onChange={setV}
      onCommit={(html) => onCommit(html)}
      onAttachFile={attach}
      minHeight={90}
    />
  );
}

function TimeTracking({ task, patch }) {
  const [hrs, setHrs] = useState('');
  const [mins, setMins] = useState('');
  const log = () => {
    const h = (Number(hrs) || 0) + (Number(mins) || 0) / 60;
    if (h > 0) { patch({ actualHours: (task.actualHours || 0) + h }); setHrs(''); setMins(''); }
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 18, fontSize: 13, flexWrap: 'wrap' }}>
      <div><div style={{ color: NX.faint }}>Estimate</div><div style={{ fontWeight: 700, color: NX.ink }}>{fmtHours(task.estimateHours)}</div></div>
      <div><div style={{ color: NX.faint }}>Actual</div><div style={{ fontWeight: 700, color: NX.blue }}>{fmtHours(task.actualHours)}</div></div>
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
        <input value={hrs} onChange={(e) => setHrs(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && log()} type="number" min="0" step="1" placeholder="hrs"
          style={{ ...inputStyle, width: 56, padding: '6px 8px', fontSize: 12 }} />
        <span style={{ color: NX.faint }}>:</span>
        <input value={mins} onChange={(e) => setMins(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && log()} type="number" min="0" max="59" step="5" placeholder="min"
          style={{ ...inputStyle, width: 56, padding: '6px 8px', fontSize: 12 }} />
        <button onClick={log} style={{ ...btn('primary'), padding: '7px 11px', fontSize: 12 }}><Clock size={13} /> Log</button>
      </div>
    </div>
  );
}

function Approval({ task, patch }) {
  const s = task.approvalStatus || 'none';
  if (s === 'none') {
    return <button onClick={() => patch({ approvalStatus: 'pending' })} style={{ ...btn('outline'), borderStyle: 'dashed', fontSize: 12 }}><ShieldCheck size={13} /> Request approval</button>;
  }
  const color = s === 'approved' ? NX.green : s === 'rejected' ? NX.red : NX.amber;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <Chip color={color} tint={NX.border2}>{s.replace('_', ' ')}</Chip>
      <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button onClick={() => patch({ approvalStatus: 'approved' })} style={{ ...btn('outline'), padding: '6px 10px', fontSize: 12, color: NX.green }}><ThumbsUp size={13} /> Approve</button>
        <button onClick={() => patch({ approvalStatus: 'changes_requested' })} style={{ ...btn('outline'), padding: '6px 10px', fontSize: 12, color: NX.amber }}><RotateCcw size={13} /> Changes</button>
        <button onClick={() => patch({ approvalStatus: 'rejected' })} style={{ ...btn('outline'), padding: '6px 10px', fontSize: 12, color: NX.red }}><ThumbsDown size={13} /> Reject</button>
        <button onClick={() => patch({ approvalStatus: 'none' })} title="Clear" style={{ ...btn('outline'), padding: '6px 10px', fontSize: 12, color: NX.dim }}><X size={13} /></button>
      </div>
    </div>
  );
}

// ── Comments + Activity, as one block (mobile) ───────────────────────────────
// Mirrors the reference layout: a "Comments | All activity" switcher instead of
// two separate stacked sections, since they're two views of the same thread.
function DiscussionPane({ task, taskId, nameOf, myEmail, getComments, addComment }) {
  const [view, setView] = useState('comments');
  const tab = (key, label) => {
    const on = view === key;
    return (
      <button onClick={() => setView(key)} style={{
        border: 'none', background: 'transparent', cursor: 'pointer', padding: '9px 2px',
        borderBottom: `2px solid ${on ? NX.ink : 'transparent'}`, fontFamily: FONT,
        fontSize: 14, fontWeight: on ? 700 : 600, color: on ? NX.ink : NX.dim,
      }}>{label}</button>
    );
  };
  return (
    <section style={{ borderTop: `1px solid ${NX.border}`, marginTop: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 18, borderBottom: `1px solid ${NX.border}`, marginBottom: 12 }}>
        {tab('comments', 'Comments')}
        {tab('activity', 'All activity')}
      </div>
      {view === 'comments'
        ? <CommentsTab task={task} nameOf={nameOf} myEmail={myEmail} getComments={getComments} addComment={addComment} />
        : <ActivityTab taskId={taskId} nameOf={nameOf} />}
    </section>
  );
}

// ── Comments ────────────────────────────────────────────────────────────────
function CommentsTab({ task, nameOf, myEmail, getComments, addComment }) {
  const [comments, setComments] = useState(null);
  const [body, setBody] = useState('');
  const [pending, setPending] = useState([]);
  const people = usePeople();
  const [attachments, reloadAttachments] = useCommentAttachments(task.id);
  const reload = () => getComments(task.id).then(setComments).catch(() => setComments([]));
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [task.id]);

  const submit = async () => {
    if (isEmptyDoc(body)) return;
    setBody('');
    const c = await addComment(task.id, body).catch(() => null);
    if (c && pending.length) {
      await uploadPendingAttachments(task.id, c.id, pending);
      setPending([]);
      reloadAttachments();
    }
    reload();
  };
  const pin = async (c) => { await api.editTaskComment(c.id, { pinned: !c.pinned }).catch(() => {}); reload(); };
  const edit = async (c, text) => { await api.editTaskComment(c.id, { body: text }).catch(() => {}); reload(); };
  const del = async (c) => { if (!window.confirm('Delete this comment?')) return; await api.deleteTaskComment(c.id).catch(() => {}); reload(); };

  const list = (comments || []).slice().sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));

  return (
    <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div onPaste={(e) => onPasteStage(e, setPending)}>
        <RichDescription value={body} onChange={setBody} onSubmit={submit}
          mentionPeople={people} minHeight={64}
          onStageFiles={(fs) => setPending((p) => [...p, ...fs])} />
        <PendingAttachments files={pending} setFiles={setPending} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
          <span style={{ fontSize: 11, color: NX.faint }}>
            Type <b>@</b> to mention someone - they'll get an email.
          </span>
          <button onClick={submit} disabled={isEmptyDoc(body)}
            style={{ ...btn('primary'), marginLeft: 'auto', opacity: isEmptyDoc(body) ? 0.5 : 1 }}>Send</button>
        </div>
      </div>
      {comments === null ? <LoadingState />
        : list.length === 0 ? <div style={{ color: NX.faint, fontSize: 13, textAlign: 'center', padding: 24 }}>No comments yet.</div>
          : list.map((c) => <CommentItem key={c.id} c={c} nameOf={nameOf} mine={c.authorId === myEmail}
              attachments={attachments.get(c.id) || []}
              onPin={() => pin(c)} onEdit={(t) => edit(c, t)} onDelete={() => del(c)} />)}
    </div>
  );
}
function CommentItem({ c, nameOf, mine, attachments = [], onPin, onEdit, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(c.body);
  const [hover, setHover] = useState(false);
  const [zoomImage, zoomViewer] = useImageZoom();
  const imported = parseImportedAuthor(c.body);
  const displayName = imported?.name || nameOf(c.authorId);
  const displayBody = imported ? imported.text : c.body;
  return (
    <div onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} style={{ display: 'flex', gap: 10, padding: 8, borderRadius: 10, background: c.pinned ? 'rgba(217,119,6,0.14)' : 'transparent' }}>
      <Avatar email={c.authorId} name={displayName} size={26} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: NX.ink }}>{displayName}</span>
          <span style={{ fontSize: 11, color: NX.faint }}>{fmtDateTime(c.createdAt)}</span>
          {c.editedAt && <span style={{ fontSize: 11, fontStyle: 'italic', color: NX.faint }}>(edited)</span>}
          {c.pinned && <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: NX.amber }}>Pinned</span>}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 2, opacity: hover ? 1 : 0, transition: 'opacity 0.12s' }}>
            <button onClick={onPin} title={c.pinned ? 'Unpin' : 'Pin'} style={{ ...btn('ghost'), padding: 4, color: NX.faint }}><Pin size={12} /></button>
            {mine && <>
              <button onClick={() => { setText(displayBody); setEditing(true); }} title="Edit" style={{ ...btn('ghost'), padding: 4, color: NX.faint }}><Pencil size={12} /></button>
              <button onClick={onDelete} title="Delete" style={{ ...btn('ghost'), padding: 4, color: NX.faint }}><Trash2 size={12} /></button>
            </>}
          </div>
        </div>
        {editing ? (
          <div style={{ marginTop: 6, display: 'flex', gap: 6 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <RichDescription value={text} onChange={setText} minHeight={56} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <button onClick={() => { onEdit(text); setEditing(false); }} style={{ ...btn('primary'), padding: '5px 10px', fontSize: 12 }}>Save</button>
              <button onClick={() => setEditing(false)} style={{ ...btn('outline'), padding: '5px 10px', fontSize: 12 }}>Cancel</button>
            </div>
          </div>
        ) : (
          // Bodies are HTML now (rich editor + Asana's html_text); richBodyHtml
          // sanitizes them and escapes the older plain-text rows.
          <div className="nx-rich-view" style={{ marginTop: 2, color: NX.dim }} onClick={zoomImage}
            dangerouslySetInnerHTML={{ __html: richBodyHtml(displayBody, nameOf) }} />
        )}
        {zoomViewer}
        {attachments.length > 0 && <CommentAttachments items={attachments} />}
      </div>
    </div>
  );
}

// Files attached while THIS comment was composed - see TaskAttachment.comment_id.
// An image renders as a real inline preview (not the small chip the Attachments
// tab uses); anything else renders as a named card with a Download link,
// matching Asana's own comment-attachment layout.
function CommentAttachments({ items }) {
  const [view, setView] = useState(null);   // attachment open in the in-app viewer
  // A row without a url is a failed/legacy upload (see uploadTaskAttachment) -
  // it renders as a dead card, never a broken link. Everything stored opens the
  // in-app viewer (images/videos/PDFs inline, other types a download card).
  const card = (a, body) => {
    const href = a.dataUrl || a.url;
    const style = {
      display: 'flex', alignItems: 'center', gap: 10, width: 260, padding: '9px 12px',
      border: `1px solid ${NX.border}`, borderRadius: 10, textDecoration: 'none',
      opacity: href ? 1 : 0.65,
    };
    return href
      ? <button key={a.id} type="button" onClick={() => setView({ ...a, url: href })} title={`View ${a.name}`}
          style={{ ...style, background: 'none', cursor: 'pointer', font: 'inherit', textAlign: 'left', color: 'inherit' }}>{body}</button>
      : <div key={a.id} style={style} title="This file failed to upload and isn't available - remove it and re-attach">{body}</div>;
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
      {items.map((a) => {
        const href = a.dataUrl || a.url;
        if (a.kind === 'image' && href) {
          return (
            <button key={a.id} type="button" onClick={() => setView({ ...a, url: href })} title={`View ${a.name}`}
              style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', alignSelf: 'flex-start' }}>
              <img src={href} alt={a.name}
                style={{ display: 'block', maxWidth: 320, maxHeight: 240, borderRadius: 10, border: `1px solid ${NX.border}`, objectFit: 'cover' }} />
            </button>
          );
        }
        return card(a, (
          <>
            <Paperclip size={16} style={{ color: NX.dim, flexShrink: 0 }} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: NX.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</div>
              <div style={{ fontSize: 11, color: NX.faint, display: 'flex', alignItems: 'center', gap: 4 }}>
                {href ? <><Download size={10} /> View or download</> : 'Not stored'}
              </div>
            </div>
          </>
        ));
      })}
      {view && <AttachmentViewer att={view} onClose={() => setView(null)} />}
    </div>
  );
}

// ── Activity ────────────────────────────────────────────────────────────────
function ActivityTab({ taskId, nameOf }) {
  const [rows, setRows] = useState(null);
  useEffect(() => { api.getTaskActivity(taskId).then(setRows).catch(() => setRows([])); }, [taskId]);
  if (rows === null) return <LoadingState />;
  if (!rows.length) return <div style={{ color: NX.faint, fontSize: 13, textAlign: 'center', padding: 24 }}>No activity yet.</div>;
  return (
    <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
      {rows.slice().reverse().map((a) => (
        <div key={a.id} style={{ display: 'flex', gap: 10, fontSize: 12 }}>
          <Avatar email={a.actorId} name={nameOf(a.actorId)} size={22} />
          <div>
            <span style={{ fontWeight: 600, color: NX.ink }}>{(nameOf(a.actorId) || '').split(' ')[0]}</span>{' '}
            <span style={{ color: NX.dim }}>{a.detail}</span>
            <div style={{ fontSize: 11, color: NX.faint }}>{fmtDateTime(a.at)}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Attachments ─────────────────────────────────────────────────────────────
function AttachmentsTab({ task, refresh }) {
  const [rows, setRows] = useState(null);
  const [uploads, setUploads] = useState([]);   // in-flight files: {key, name, pct}
  const [view, setView] = useState(null);   // attachment open in the in-app viewer
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);   // dragenter/dragleave fire on every child crossed, not just the panel edge
  const fileRef = useRef(null);
  const reload = () => api.getTaskAttachments(task.id).then(setRows).catch(() => setRows([]));
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [task.id]);

  const sendFile = (f) => {
    const key = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setUploads((u) => [...u, { key, name: f.name, pct: 0 }]);
    return uploadTaskAttachment(task.id, f, {}, (pct) => {
      setUploads((u) => u.map((x) => (x.key === key ? { ...x, pct } : x)));
    })
      .then(() => { reload(); refresh?.(); })
      .catch(() => {})
      .finally(() => setUploads((u) => u.filter((x) => x.key !== key)));
  };
  const onFile = (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) sendFile(f); };
  const onPaste = (e) => { const files = filesFromPaste(e); if (files.length) { e.preventDefault(); files.forEach(sendFile); } };
  const del = async (a) => { await api.deleteTaskAttachment(a.id).catch(() => {}); reload(); refresh?.(); };

  // Drag-and-drop straight onto the tab, anywhere - not just onto the Attach
  // file button - matching Ctrl+V paste already working over the whole panel.
  const onDragEnter = (e) => { e.preventDefault(); dragDepth.current += 1; if (e.dataTransfer.types.includes('Files')) setDragOver(true); };
  const onDragOver = (e) => { e.preventDefault(); };
  const onDragLeave = (e) => { e.preventDefault(); dragDepth.current = Math.max(0, dragDepth.current - 1); if (dragDepth.current === 0) setDragOver(false); };
  const onDrop = (e) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragOver(false);
    Array.from(e.dataTransfer.files || []).forEach(sendFile);
  };

  return (
    <div onPaste={onPaste} onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}
      tabIndex={0} style={{
        marginTop: 14, borderRadius: 10, transition: 'background-color .12s ease',
        ...(dragOver ? { background: NX.hover || NX.border2, boxShadow: `0 0 0 2px ${NX.primary} inset` } : {}),
      }}>
      <input ref={fileRef} type="file" multiple style={{ display: 'none' }} onChange={onFile} />
      <button onClick={() => fileRef.current?.click()} style={{ ...btn('outline'), borderStyle: 'dashed', fontSize: 12, marginBottom: 12 }}><Paperclip size={13} /> Attach file</button>
      <span style={{ fontSize: 11, color: NX.faint, marginLeft: 8 }}>or drag a file in, or press Ctrl+V to paste a screenshot</span>
      {dragOver && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '18px 12px', margin: '10px 0',
          border: `1.5px dashed ${NX.primary}`, borderRadius: 10, color: NX.primary, fontSize: 12.5, fontWeight: 600,
          pointerEvents: 'none',
        }}><Paperclip size={14} /> Drop to attach</div>
      )}
      {(rows?.length || 0) === 0 && uploads.length === 0 ? (
        rows === null ? <LoadingState />
          : <div style={{ color: NX.faint, fontSize: 13, textAlign: 'center', padding: 20 }}>No attachments yet.</div>
      )
          : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {uploads.map((u) => (
                <div key={u.key} style={{ display: 'flex', alignItems: 'center', gap: 8, border: `1px dashed ${NX.border}`, borderRadius: 10, padding: '6px 10px', fontSize: 12 }}>
                  <Paperclip size={13} style={{ color: NX.dim }} />
                  <span style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: NX.dim }}>{u.name}</span>
                  <span style={{ width: 90, height: 4, borderRadius: 2, background: NX.border2, overflow: 'hidden' }}>
                    <span style={{ display: 'block', height: '100%', width: '100%', background: NX.primary, transformOrigin: 'left', transform: `scaleX(${u.pct})`, transition: 'transform .15s linear' }} />
                  </span>
                  <span style={{ color: NX.faint, minWidth: 32, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{Math.round(u.pct * 100)}%</span>
                </div>
              ))}
              {(rows || []).map((a) => {
                const href = a.dataUrl || a.url;
                const thumb = a.kind === 'image' && href
                  ? <img src={href} alt={a.name} style={{ width: 32, height: 32, borderRadius: 6, objectFit: 'cover' }} />
                  : <Paperclip size={13} style={{ color: NX.dim }} />;
                return (
                  <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, border: `1px solid ${NX.border}`, borderRadius: 10, padding: '6px 10px', fontSize: 12 }}>
                    {href ? (
                      // Opens the IN-APP viewer (images/videos/PDFs render
                      // inline; other types get a download card) - never a new tab.
                      <button type="button" onClick={() => setView({ ...a, url: href })} title={`View ${a.name}`}
                        style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, color: 'inherit', background: 'none', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit' }}>
                        {thumb}
                        <span style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
                      </button>
                    ) : (
                      <span title="This file failed to upload and isn't available - remove it and re-attach"
                        style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, color: NX.faint }}>
                        {thumb}
                        <span style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textDecoration: 'line-through' }}>{a.name}</span>
                      </span>
                    )}
                    <span style={{ color: NX.faint }}>{a.size}</span>
                    {href && <a href={toDownloadUrl(href)} download={a.name} title="Download" style={{ color: NX.faint, display: 'flex' }}><Download size={13} /></a>}
                    <button onClick={() => del(a)} title="Remove" style={{ ...btn('ghost'), padding: 3, color: NX.faint }}><X size={13} /></button>
                  </div>
                );
              })}
            </div>
          )}
      {view && <AttachmentViewer att={view} onClose={() => setView(null)} />}
    </div>
  );
}

// ── Subtasks ────────────────────────────────────────────────────────────────
function SubtaskAssignee({ subtask, people, updateTask }) {
  return (
    <div onClick={(e) => e.stopPropagation()}>
      <Pop width={200} trigger={(t) => (
        <button onClick={t} title={subtask.assigneeId ? 'Change assignee' : 'Assign'} style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center' }}>
          {subtask.assigneeId
            ? <Avatar email={subtask.assigneeId} size={18} />
            : <span style={{ width: 18, height: 18, borderRadius: '50%', border: `1px dashed ${NX.border}`, display: 'inline-block' }} />}
        </button>
      )}>
        {(close) => (
          <>
            <MenuItem icon={!subtask.assigneeId ? <Check size={13} /> : <span style={{ width: 13, display: 'inline-block' }} />} onClick={() => { updateTask(subtask.id, { assigneeId: '' }); close(); }}>Unassigned</MenuItem>
            {people.map((p) => (
              <MenuItem key={p.email} icon={<Avatar email={p.email} name={p.name} size={16} card={false} />} onClick={() => { updateTask(subtask.id, { assigneeId: p.email }); close(); }}>{p.name}</MenuItem>
            ))}
          </>
        )}
      </Pop>
    </div>
  );
}

function SubtasksTab({ task, subtasks, createTask, updateTask, people, onOpenSub, hideHeading }) {
  const [title, setTitle] = useState('');
  const [dueOn, setDueOn] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const dateRef = useRef(null);
  const done = subtasks.filter((s) => s.completed).length;

  // A new subtask starts with the main task's collaborators, project and team
  // (Oct 13 2026) - take anyone off on the subtask itself. No due date unless
  // one is picked here.
  const add = async () => {
    const t = title.trim(); if (!t) return;
    await createTask({
      title: t, parentTaskId: task.id, projectId: task.projectId, teamId: task.teamId,
      followerIds: [...(task.followerIds || [])],
      assigneeId, dueOn, status: 'not_started', priority: 'medium', type: 'task',
    }).catch((e) => alert(e?.message || 'Could not add the subtask.'));
    setTitle(''); setDueOn(''); setAssigneeId('');
  };

  // Manual order: drag a row by its handle (or focus the handle and press Up /
  // Down). The first move numbers every subtask in the order it shows and
  // marks the main task "manual", so the dragged order then holds for everyone
  // until Sort by Due Date puts it back.
  const [dragId, setDragId] = useState(null);
  const [dropAt, setDropAt] = useState(null);           // index the dragged row would land at
  const armed = useRef(null);                           // the handle the drag started on
  const moveTo = (id, toIndex) => {
    const changes = reorderedPositions(subtasks, id, toIndex);
    if (!changes.length) return;
    for (const c of changes) updateTask(c.id, { position: c.position });
    if (task.subtaskOrder !== 'manual') updateTask(task.id, { subtaskOrder: 'manual' });
  };
  const rowDragOver = (i) => (e) => {
    if (!dragId) return;
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    setDropAt(e.clientY < r.top + r.height / 2 ? i : i + 1);
  };
  const drop = (e) => {
    e.preventDefault();
    if (dragId != null && dropAt != null) {
      const from = subtasks.findIndex((x) => x.id === dragId);
      moveTo(dragId, dropAt > from ? dropAt - 1 : dropAt);
    }
    setDragId(null); setDropAt(null);
  };

  return (
    <div style={{ marginTop: hideHeading ? 0 : 14 }}>
      {!hideHeading && <div style={{ fontSize: 13, fontWeight: 700, color: NX.ink, marginBottom: 10 }}>{subtasks.length ? `Subtasks ${done}/${subtasks.length}` : 'Subtasks'}</div>}
      {task.subtaskOrder === 'manual' && subtasks.length > 1 && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}>
          <button type="button" onClick={() => updateTask(task.id, { subtaskOrder: '' })}
            title="Order the subtasks by due date, then priority, again"
            style={{ ...btn('ghost'), padding: '2px 6px', fontSize: 11.5, color: NX.faint }}>Sort by Due Date</button>
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 10 }} onDrop={drop}
        onDragOver={(e) => { if (dragId) e.preventDefault(); }}>
        {subtasks.map((s, i) => (
          <div key={s.id} data-subtask-row={s.id} onClick={() => onOpenSub(s.id)} className="nx-row-hover"
            draggable={subtasks.length > 1}
            onDragStart={(e) => {
              // Only from the handle - the rest of the row is for clicking.
              if (armed.current !== s.id) { e.preventDefault(); return; }
              e.dataTransfer.effectAllowed = 'move';
              try { e.dataTransfer.setData('text/plain', s.id); } catch { /* jsdom */ }
              setDragId(s.id);
            }}
            onDragEnd={() => { armed.current = null; setDragId(null); setDropAt(null); }}
            onDragOver={rowDragOver(i)}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '7px 6px', borderRadius: 8, cursor: 'pointer',
              opacity: dragId === s.id ? 0.45 : 1,
              boxShadow: dropAt === i ? `inset 0 2px 0 ${NX.blue}` : dropAt === i + 1 && i === subtasks.length - 1 ? `inset 0 -2px 0 ${NX.blue}` : 'none',
            }}>
            {subtasks.length > 1 && (
              <button type="button" aria-label={`Move ${s.title} (drag, or Up / Down)`} title="Drag to reorder"
                onMouseDown={() => { armed.current = s.id; }} onMouseUp={() => { armed.current = null; }}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
                  e.preventDefault(); e.stopPropagation();
                  moveTo(s.id, i + (e.key === 'ArrowUp' ? -1 : 1));
                }}
                style={{ border: 'none', background: 'transparent', padding: 0, display: 'flex', color: NX.faint, cursor: 'grab', flexShrink: 0 }}>
                <GripVertical size={14} />
              </button>
            )}
            <button onClick={(e) => { e.stopPropagation(); updateTask(s.id, { completed: !s.completed }); }} style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: NX.faint, display: 'flex', padding: 0 }}>
              {s.completed ? <CheckCircle2 size={15} style={{ color: NX.green }} /> : <Circle size={15} />}
            </button>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, color: s.completed ? NX.faint : NX.ink, textDecoration: s.completed ? 'line-through' : 'none' }}>{s.title}</span>
            {s.dueOn && <span style={{ fontSize: 11, color: NX.faint }}>{fmtDate(s.dueOn)}</span>}
            <SubtaskAssignee subtask={s} people={people} updateTask={updateTask} />
            <ChevronRight size={14} style={{ color: NX.faint }} />
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, border: `1px dashed ${NX.border}`, borderRadius: 8, padding: '6px 10px' }}>
        <Plus size={14} style={{ color: NX.faint, flexShrink: 0 }} />
        <input className="nx-inline-edit" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} placeholder="Add subtask"
          style={{ flex: 1, minWidth: 0, border: 'none', fontFamily: FONT, fontSize: 13 }} />
        {dueOn && <span style={{ fontSize: 11, color: NX.faint }}>{fmtDate(dueOn)}</span>}
        <button onClick={() => dateRef.current?.showPicker?.() ?? dateRef.current?.focus()} title="Due Date" style={{ ...btn('ghost'), padding: 4, color: NX.faint }}><CalendarDays size={15} /></button>
        <input ref={dateRef} type="date" value={dueOn} min={localTodayISO()} onChange={(e) => setDueOn(notPast(e.target.value))} style={{ position: 'absolute', width: 0, height: 0, opacity: 0 }} tabIndex={-1} />
        <div style={{ minWidth: 150 }}>
          <PersonSelect value={assigneeId || null} people={people} onChange={(email) => setAssigneeId(email || '')} placeholder="Assignee" />
        </div>
        <button onClick={add} style={{ ...btn('primary'), padding: '6px 10px', fontSize: 12 }}>Add</button>
      </div>
    </div>
  );
}

// ── Dependencies ────────────────────────────────────────────────────────────
function DependenciesTab({ blockedBy, blocking, task, removeDependency }) {
  if (!blockedBy.length && !blocking.length) return <div style={{ color: NX.faint, fontSize: 13, textAlign: 'center', padding: 24 }}>No dependencies yet. Add one from the Overview tab.</div>;
  const line = (b, color, canRemove) => (
    <div key={b.id} style={{ display: 'flex', alignItems: 'center', gap: 8, background: NX.surface2, border: `1px solid ${NX.border}`, borderRadius: 8, padding: '7px 10px', fontSize: 12, marginBottom: 6 }}>
      <Link2 size={13} style={{ color }} />
      <span style={{ flex: 1, color: NX.ink }}>{b.title}</span>
      {b.dependencyType && DEP_TYPES[b.dependencyType] && <span style={{ color: NX.faint }}>{b.dependencyType}</span>}
      {canRemove && <button onClick={() => removeDependency(b.id)} style={{ ...btn('ghost'), padding: 2, color: NX.faint }}><X size={13} /></button>}
    </div>
  );
  return (
    <div style={{ marginTop: 14 }}>
      {blockedBy.length > 0 && <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: NX.faint, marginBottom: 6 }}>Blocked by</div>
        {blockedBy.map((b) => line({ ...b, dependencyType: (task.dependencyTypes || {})[b.id] }, NX.red, true))}
      </div>}
      {blocking.length > 0 && <div>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: NX.faint, marginBottom: 6 }}>Blocking</div>
        {blocking.map((b) => line(b, NX.amber, false))}
      </div>}
    </div>
  );
}

// ── Properties ──────────────────────────────────────────────────────────────
/** One row per custom field the task carries (fieldsForTask): a column in
 *  any project it is in, or one used everywhere. A field one of those
 *  projects requires is starred, and flagged while it is still empty -
 *  worked out from the projects the task is in NOW, so moving it out of
 *  the project drops the requirement (Oct 13 2026). */
export function TaskCustomFieldRows({ task, customFields, projectName, patch }) {
  const fields = fieldsForTask(customFields, task);
  if (!fields.length) return null;
  const values = task.customFieldValues || {};
  return fields.map((f) => {
    const by = requiredByProjectsOf(f, task);
    const missing = by.length > 0 && isBlankValue(values[f.id]);
    const where = by.filter(Boolean).map((pid) => projectName(pid)).filter(Boolean).join(', ');
    return (
      <Row key={f.id} label={<>{f.name}{by.length > 0 && <span style={{ color: NX.red }}> *</span>}</>}>
        <CustomFieldInput field={f} value={values[f.id]}
          onChange={(v) => patch({ customFieldValues: { ...values, [f.id]: v } })} />
        {missing && (
          <span role="status" style={{ fontSize: 11.5, color: NX.red, flexBasis: '100%' }}>
            Required{where ? ` in ${where}` : ''} - pick one.
          </span>
        )}
      </Row>
    );
  });
}

function PropertiesTab({ task, nameOf, projectName, teamName, customFields, patch }) {
  // The same fields the Overview shows (fieldsForTask) - not every field
  // defined anywhere in the workspace.
  const activeFields = fieldsForTask(customFields, task);
  const { statusMeta, projects = [], tasks: allTasks = [] } = useTasks();
  const tracksTime = taskTracksTime(task, projects, allTasks);
  const sm = statusMeta[task.status] || {};
  const pm = PRIORITY_META[task.priority] || {};
  const rows = [
    ['Status', <Chip color={sm.color} tint={sm.tint}>{sm.label}</Chip>],
    ['Priority', <Chip color={pm.color} tint={pm.tint}>{pm.label}</Chip>],
    ['Assignee', taskAssignees(task).length
      ? <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          {taskAssignees(task).map((e) => (
            <span key={e} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Avatar email={e} name={nameOf(e)} size={18} /> {nameOf(e)}
            </span>
          ))}
        </span>
      : 'Unassigned'],
    ['Project', task.projectId ? projectName(task.projectId) : '-'],
    ['Also In', (task.projectIds || []).length ? task.projectIds.map((id) => projectName(id) || id).join(', ') : '-'],
    ['Team', task.teamId ? teamName(task.teamId) : '-'],
    ['Start Date', fmtDate(task.startOn)],
    ['Due Date', fmtDate(task.dueOn)],
    ...(tracksTime ? [
      ['Estimate', task.estimateHours != null ? fmtHours(task.estimateHours) : '-'],
      ['Actual', task.actualHours != null ? fmtHours(task.actualHours) : '-'],
    ] : []),
    ['Milestone', task.isMilestone ? 'Yes' : 'No'],
    ['Approval', !task.approvalStatus || task.approvalStatus === 'none' ? '-' : task.approvalStatus.replace('_', ' ')],
    ['Recurrence', recurrenceLabel(task.recurrence)],
    ['Created', fmtDate(task.createdAt)],
    ['Modified', fmtDate(task.modifiedAt)],
  ];
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ border: `1px solid ${NX.border}`, borderRadius: 12, overflow: 'hidden' }}>
        {rows.map(([label, value], i) => (
          <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 12px', fontSize: 13, borderTop: i ? `1px solid ${NX.border}` : 'none' }}>
            <span style={{ width: 112, flexShrink: 0, color: NX.faint }}>{label}</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8, color: NX.ink }}>{value}</span>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 12, padding: '9px 12px', fontSize: 13, borderTop: `1px solid ${NX.border}` }}>
          <span style={{ width: 112, flexShrink: 0, color: NX.faint, paddingTop: 2 }}>Labels</span>
          <LabelsEditor tags={task.tags || []} onChange={(tags) => patch({ tags })} />
        </div>
      </div>

      {activeFields.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: NX.ink, marginBottom: 8 }}>Custom Fields</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <TaskCustomFieldRows task={task} customFields={customFields} projectName={projectName} patch={patch} />
          </div>
        </div>
      )}
    </div>
  );
}

function LabelsEditor({ tags, onChange }) {
  const [input, setInput] = useState('');
  const add = () => {
    const v = input.trim();
    if (v && !tags.includes(v)) onChange([...tags, v]);
    setInput('');
  };
  return (
    <span style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4, flex: 1 }}>
      {tags.map((t) => (
        <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: 999, fontSize: 12, fontWeight: 600, color: NX.dim, background: NX.border2 }}>
          {t}
          <button onClick={() => onChange(tags.filter((x) => x !== t))} style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: NX.faint, padding: 0, display: 'flex' }}><X size={11} /></button>
        </span>
      ))}
      <input className="nx-inline-edit" value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} onBlur={add}
        placeholder="Add label…" style={{ border: 'none', fontFamily: FONT, fontSize: 12, width: 100, color: NX.ink }} />
    </span>
  );
}

export function CustomFieldInput({ field, value, onChange }) {
  const [v, setV] = useState(value ?? '');
  const people = usePeople();
  useEffect(() => setV(value ?? ''), [value]);
  // Asana computes formula fields and rejects any write, so there is nothing to
  // edit - show the value it sent and say why it can't be changed here.
  if (field.readOnly) {
    return (
      <span title="Calculated in Asana - not editable here"
        style={{ fontSize: 13, color: NX.dim, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        {value || '-'}
        <Lock size={11} style={{ color: NX.faint }} />
      </span>
    );
  }
  if (field.type === 'people') {
    return (
      <div style={{ minWidth: 220 }}>
        <PersonMultiSelect value={Array.isArray(value) ? value : []} onChange={onChange}
          people={people} placeholder="Nobody" />
      </div>
    );
  }
  if (field.type === 'multiselect' && Array.isArray(field.options)) {
    const opts = field.options.map((o) => (typeof o === 'string' ? { id: o, label: o, color: '' } : o));
    const picked = Array.isArray(value) ? value : [];
    const toggle = (id) => onChange(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]);
    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {opts.map((o) => {
          const on = picked.includes(o.id);
          return (
            <button key={o.id} type="button" onClick={() => toggle(o.id)}
              style={{
                border: `1px solid ${on ? (o.color || NX.primary) : NX.border}`, borderRadius: 20,
                padding: '3px 10px', fontSize: 12, fontFamily: FONT, cursor: 'pointer', fontWeight: on ? 600 : 500,
                background: on ? `${o.color || NX.primary}1a` : 'transparent',
                color: on ? (o.color || NX.primary) : NX.dim,
              }}>
              {o.label}
            </button>
          );
        })}
        {opts.length === 0 && <span style={{ fontSize: 12.5, color: NX.faint }}>No options</span>}
      </div>
    );
  }
  if (field.type === 'select' && Array.isArray(field.options)) {
    // Options are {id,label,color} now; older rows are plain strings, so read
    // both shapes. The chosen option's color tints the control the way Asana's
    // single-select chips do.
    const opts = field.options.map((o) => (typeof o === 'string' ? { id: o, label: o, color: '' } : o));
    const picked = fieldOption(field, v);
    return (
      <select value={v} onChange={(e) => { setV(e.target.value); onChange(e.target.value); }}
        style={{
          ...inputStyle, width: 'auto', padding: '6px 9px', fontSize: 13,
          ...(picked?.color ? { background: `${picked.color}1a`, borderColor: picked.color, color: picked.color, fontWeight: 600 } : {}),
        }}>
        <option value="">-</option>
        {opts.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
    );
  }
  if (field.type === 'checkbox') {
    return (
      <input type="checkbox" checked={v === true || v === 'true'}
        onChange={(e) => { setV(e.target.checked); onChange(e.target.checked); }}
        style={{ width: 16, height: 16, cursor: 'pointer' }} />
    );
  }
  return (
    <input type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'} value={v}
      onChange={(e) => setV(e.target.value)} onBlur={() => onChange(v)}
      style={{ ...inputStyle, width: 'auto', minWidth: 180, padding: '6px 9px', fontSize: 13 }} />
  );
}

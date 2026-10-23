// Task Module - the Task Detail drawer: a right-side, resizable, tabbed panel
// (Overview / Comments / Activity / Attachments / Subtasks / Dependencies /
// Properties). Ported from the export's features/task-detail/* (24 files) into a
// single consolidated file matching this module's inline-style idiom, wired to
// the real TasksContext store + api.js instead of the export's mocked Zustand store.
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeft, ArrowRightToLine, CornerDownRight, GripVertical, Copy, CheckCircle2, Circle, XCircle, ChevronDown, ChevronRight,
  Diamond, Repeat, ThumbsUp, Trash2, Link2, X, Clock, ShieldCheck,
  Paperclip, Download, Pin, Pencil, Plus, Maximize2, Minimize2,
  RotateCcw, ThumbsDown, Share2, MoreHorizontal, UserPlus, Globe, Lock, Check, Ban, Ticket, LayoutTemplate, Sigma, MoveRight,
  History, Upload, HardDrive, Image as ImageIcon,
} from 'lucide-react';
import MoveTaskModal from './MoveTaskModal';
import { api } from '../api';
import { useTasks } from './TasksContext';
import { formulaEngineFor } from './formula';
import { FormulaValue } from './FormulaColumn';
import { fmtDate as fmtDateRaw, fmtDateTime, filesFromPaste, fmtHours, teamInProject, fieldOption, uploadTaskAttachment, uploadTaskAttachmentVersion, taskAssignees, fieldsForTask, requiredByProjectsOf, isBlankValue, orderSubtasks, reorderedPositions, taskTracksTime, duplicateTaskData, threadComments, taskRoleFor, roleAtLeast, richBodyHtml } from './lib';

// Drawer shows an em-dash for an unset date rather than an empty cell.
const fmtDate = (iso) => (iso ? fmtDateRaw(iso) : '-');
import { NX, FONT, btn, input as inputStyle, STATUS_META, STATUS_ORDER, PRIORITY_META, PRIORITY_ORDER, isMissed, MISSED_TITLE } from './theme';
import { Avatar, Modal, PersonMultiSelect, ChipMultiSelect, usePeople, useIsMobile, DateField, AttachmentViewer, ExternalTag, MenuCaption, PersonDot } from './components';
import { matchPeople } from '../lib/peopleSearch';
import { useListNav } from '../lib/listNav';
import { useFrequentCollaborators, frequentRows } from './frequentPeople';
import TeamPicks, { pickableTeams, firstTeamPick, toggleRoster } from './teamPicks';
import RichDescription, { isEmptyDoc } from './RichDescription';
import { myProjectIds } from './ProjectPicker';
import DueBadge from './DueBadge';
import DueNegotiation from './DueNegotiation';
import Checklist from './Checklist';
import { ShowOnCardSelect } from './CardPreview';
import { IMAGE_MODE, isCoverCandidate } from './boardLayout';
import CommentThread from './CommentThread';
import TimeTracking from './TimeTracking';
import { toDownloadUrl } from '../lib/storageView';
import { openNotificationTarget } from '../lib/openTarget';
import { useRole } from '../contexts/RoleContext';
import { dialog } from '../ui/dialog';
import { VersionChip, VersionsModal, EgnyteLinkRow, EgnyteLinkPicker } from './attachmentParts';
import { currentVersionsOf, isEgnyteLink, canVersion } from './egnyteLinks';
import { ticketNo } from '../tickets/ticketMeta';
import AnchoredMenu from '../components/AnchoredMenu';
import { Spinner, LoadingState } from '../components/AsyncState';
import { recurrenceLabel } from './recurrence';
import { useCustomSections } from './customSections';
import { RecurrenceMenu, RecurrenceEnds, repeatOption, repeatSummary } from './RecurrenceMenu';
// Moved to RecurrenceMenu.jsx with the rest of the Repeat controls; still
// importable from here.
export { CommitNumberInput } from './RecurrenceMenu';
import { StatusLabel, PrioritySignal } from '../components/StatusLabel';
import { FieldHistoryButton, HistoryChange } from './FieldHistoryPopover';
import { FieldHistoryContext, useHistoryCtx } from './fieldHistoryContext';
import { groupFieldChanges, historyFieldName } from './fieldHistory';

const DEP_TYPES = { FS: 'Finish → Start', SS: 'Start → Start', FF: 'Finish → Finish', SF: 'Start → Finish' };
const VIEW_ONLY_TITLE = 'You can view this task but not change it';
// An approval state as a Title Case chip ("changes_requested" -> "Changes Requested").
const APPROVAL_LABELS = { pending: 'Pending', approved: 'Approved', rejected: 'Rejected', changes_requested: 'Changes Requested' };
const approvalLabel = (s) => APPROVAL_LABELS[s]
  || String(s || '').split('_').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

/** The task's fields, read-only for someone below editor on its project: a
 *  disabled fieldset turns every button, input and select inside it off at
 *  once (they still read as the values they show), with no layout of its own.
 *  Rich text is not a form control, so the description renders as text
 *  separately (OverviewTab). */
function FieldsLock({ readOnly, children, style }) {
  if (!readOnly) return children;
  // The chips' remove "x" is a <span role="button"> inside the trigger
  // button, not a form control, so `disabled` does not reach it (and React
  // still delivers its click). Stopped here, in the capture phase, before
  // the span's own handler runs.
  const block = (e) => {
    // Field history is reading, not editing - viewers open it too.
    if (e.target.closest?.('[data-history-trigger]')) return;
    if (!e.target.closest?.('[role="button"]')) return;
    if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault(); e.stopPropagation();
  };
  return (
    <fieldset disabled data-testid="fields-read-only" onClickCapture={block} onKeyDownCapture={block}
      style={{ border: 0, padding: 0, margin: 0, minWidth: 0, ...style }}>
      {children}
    </fieldset>
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
// `history`: the field key(s) whose changes the clock beside the label lists
// (FieldHistoryPopover.jsx); `historyLabel` names it there when `label` is not text.
function Row({ label, children, history, historyLabel }) {
  return (
    <div className={history ? 'nx-hist-row' : undefined} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', minHeight: 32 }}>
      <span style={{ width: 96, flexShrink: 0, color: NX.faint, fontSize: 13, paddingTop: 5, display: 'flex', alignItems: 'flex-start', gap: 2 }}>
        <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{label}</span>
        {history && <span style={{ marginTop: -1 }}><FieldHistoryButton field={history} label={historyLabel || label} /></span>}
      </span>
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

// `onBackToTicket`: opened from a ticket's Tasks list - its "From Ticket" link
// then just closes back onto that ticket instead of leaving for the Tickets
// screen (Oct 14 2026).
// focusComment ({ id, threadId }, Oct 21 2026): open on the Comments and land
// on that comment, briefly highlighted - the Tasks Home Updates card opens a
// mention or a comment handed to me there, not at the top of the task.
export default function TaskDetailDrawer({ taskId, onClose, onEdit, initialTab = 'overview', zIndex = 3500, onBackToTicket = null, focusComment = null }) {
  const store = useTasks();
  const { taskById, tasks, teams, projects, projectName, teamName, nameOf, myEmail, customFields = [], updateTask, deleteTask, createTask, getComments, addComment, offerUndo } = store;
  // Externals included: Assignee and Collaborators are who does the work, and
  // an external partner on a task has to be nameable there (Sagar, Sept 2 2026).
  const people = usePeople(true);
  // Where a ticket opens for this person: the desk's Tickets screen, or
  // Support (their own requests) - same rule as dashboard/teamWidgets.
  const { can, myGrantedModules, canAccessModule } = useRole() || {};
  const ticketView = (typeof can === 'function' && can('administrator')) || myGrantedModules?.has?.('tickets') ? 'tickets' : 'support';

  const [activeId, setActiveId] = useState(taskId);
  // The tasks stepped through to get here - opening a subtask from its parent
  // pushes the parent - so Close, Delete and Mark Complete on a subtask land
  // back on the task you came from instead of shutting the drawer and losing
  // your place (Sagar, Oct 13 2026).
  const [trail, setTrail] = useState([]);
  useEffect(() => { setActiveId(taskId); setTrail([]); }, [taskId]);
  const openSub = (id) => { setTrail((t) => [...t, activeId]); setActiveId(id); };
  const startTab = focusComment ? 'comments' : initialTab;
  const [tab, setTab] = useState(startTab);
  useEffect(() => setTab(startTab), [activeId, startTab]);
  // Only on the task it was opened for, not a subtask stepped into from it.
  const focusHere = activeId === taskId ? focusComment : null;
  const [shareOpen, setShareOpen] = useState(false);
  const [converting, setConverting] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);
  // Move To... (Oct 22 2026): the id of the task being moved - this one or one of its subtasks.
  const [moving, setMoving] = useState(null);

  const task = taskById[activeId];
  const parent = task?.parentTaskId ? taskById[task.parentTaskId] : null;
  // Field history (Oct 22 2026): which task the field rows' clocks read.
  const historyScope = useMemo(() => ({ taskId: activeId, nameOf }), [activeId, nameOf]);
  // What this person may do on THIS task (Oct 21 2026), the server's rule:
  // viewer = read only; commenter = comment, attach, log time; editor and
  // up = everything. Unknown (project not loaded) keeps every control, as
  // before - the server stays the authority either way.
  const taskManager = typeof canAccessModule === 'function' && !!canAccessModule('tasks', 'manager', 'owner');
  const myRole = taskRoleFor(task, { projects, teams, taskById, email: myEmail, isManager: taskManager });
  const canEdit = myRole == null || roleAtLeast(myRole, 'editor');
  const canComment = myRole == null || roleAtLeast(myRole, 'commenter');
  // The project-only rule (require_project_role): adding a subtask, removing
  // a file someone else attached. Being assigned the task does not count.
  const projectRole = taskRoleFor(task, { projects, teams, taskById, email: myEmail, isManager: taskManager, countAssignee: false });
  const canEditProject = projectRole == null || roleAtLeast(projectRole, 'editor');
  // A subtask row: its own role (its assignees edit it).
  const canEditTask = (t) => { const r = taskRoleFor(t, { projects, teams, taskById, email: myEmail, isManager: taskManager }); return r == null || roleAtLeast(r, 'editor'); };
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
  // restores all of them together. Shown once the save has RESOLVED - it
  // used to fire before the round trip, so a refused save still said
  // "Changes saved". A failed save is surfaced by updateTask's own alert and
  // its fields put back there, so no toast at all in that case.
  const patch = (p) => {
    const prev = {};
    for (const k of Object.keys(p)) prev[k] = task[k];
    const taskIdNow = activeId;
    const result = updateTask(taskIdNow, p);
    Promise.resolve(result).then(
      () => offerUndo('Changes saved', () => updateTask(taskIdNow, prev).catch(() => {})),
      () => {},
    );
    return result;
  };

  // Duplicate (Oct 13 2026; asks what to bring over since Oct 14 - see
  // DuplicateTaskModal): a copy of this task and, if asked, its subtasks -
  // what the task is, never its comments or files - opened straight away;
  // Undo deletes the copy again. A field value changed in the dialog (the
  // Entity) goes onto every subtask too; untouched ones keep their own.
  const duplicate = async ({ title, parts, values }) => {
    try {
      const copy = await createTask(duplicateWith(task, { parts, values }, { title }));
      if (parts.subtasks) {
        const before = task.customFieldValues || {};
        const changed = Object.fromEntries(Object.entries(values).filter(([k, v]) => !sameValue(v, before[k])));
        for (const sub of subtasks) {
          await createTask(duplicateWith(sub, { parts, values: changed },
            { title: sub.title, parentTaskId: copy.id, position: sub.position })).catch(() => {});
        }
        if (task.subtaskOrder) updateTask(copy.id, { subtaskOrder: task.subtaskOrder }).catch(() => {});
      }
      offerUndo(`Duplicated "${(task.title || '').slice(0, 40)}"`, () => deleteTask(copy.id));
      setTrail([]);
      setActiveId(copy.id);
    } catch (e) {
      alert(`Could not duplicate the task: ${e?.message || e}`);
    }
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
          task={task} patch={patch} readOnly={!canEdit} canComment={canComment} canEditProject={canEditProject} canEditTask={canEditTask} people={people} projectName={projectName} teamName={teamName} teams={teams} projects={projects}
          blockedBy={blockedBy} depCandidates={depCandidates} addDependency={addDependency} removeDependency={removeDependency}
          setDependencyType={setDependencyType}
          subtasks={subtasks} createTask={createTask} updateTask={updateTask} onOpenSub={openSub} onMoveSub={setMoving}
          nameOf={nameOf} myEmail={myEmail} getComments={getComments} addComment={addComment} refresh={store.refresh}
          onViewAllComments={() => setTab('comments')}
          onOpenTicket={() => (onBackToTicket ? onBackToTicket() : openSourceTicket(task.sourceTicketId, onClose, ticketView))}
        />
      );
      case 'comments':     return <CommentsTab task={task} nameOf={nameOf} myEmail={myEmail} getComments={getComments} addComment={addComment} focusComment={focusHere} canComment={canComment} canPin={canEditProject} />;
      case 'activity':     return <ActivityTab taskId={activeId} nameOf={nameOf} />;
      case 'attachments':  return <AttachmentsTab task={task} refresh={store.refresh} canAttach={canComment} canRemoveAny={canEditProject} onShowOnCard={canEdit ? (v) => patch({ cardPreviewMode: v }) : null} />;
      case 'subtasks':     return <SubtasksTab task={task} subtasks={subtasks} createTask={createTask} updateTask={updateTask} people={people} onOpenSub={openSub} onMoveSub={setMoving}
        canAdd={canEditProject} canEditParent={canEdit} canEditTask={canEditTask} />;
      case 'dependencies': return <DependenciesTab blockedBy={blockedBy} blocking={blocking} task={task} removeDependency={removeDependency} readOnly={!canEdit} />;
      case 'properties':   return <PropertiesTab task={task} nameOf={nameOf} projectName={projectName} teamName={teamName} customFields={customFields} patch={patch} readOnly={!canEdit} />;
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
            <button onClick={markComplete} disabled={!canEdit}
              title={!canEdit ? VIEW_ONLY_TITLE : isMissed(task) ? MISSED_TITLE : task.completed ? 'Completed' : 'Mark Complete'}
              style={{ ...btn('outline'), padding: isMobile ? 7 : '6px 10px', fontSize: 12, color: isMissed(task) ? NX.dim : task.completed ? NX.green : NX.dim, ...(!canEdit ? { cursor: 'default', opacity: 0.6 } : null) }}>
              {isMissed(task) ? <XCircle size={15} /> : task.completed ? <CheckCircle2 size={15} style={{ color: NX.green }} /> : <Circle size={15} />}
              {!isMobile && (isMissed(task) ? 'Missed' : task.completed ? 'Completed' : 'Mark Complete')}
            </button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            {canEdit && <MembersMenu task={task} people={people} nameOf={nameOf} patch={patch} />}
            {canEdit && <button onClick={() => setShareOpen(true)} title="Share" style={{ ...btn('outline'), padding: '6px 10px', fontSize: 12, color: NX.dim }}><Share2 size={14} /> Share</button>}
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
                  {onEdit && canEdit && <MenuItem icon={<Pencil size={14} />} onClick={() => { onEdit(activeId); close(); }}>Edit Task</MenuItem>}
                  {/* Filed as a task when it is really a request for a team
                      (Neil, 10/05: "employees ... may still do it as a task"). */}
                  {canEdit && <MenuItem icon={<Copy size={14} />} onClick={() => { close(); setDuplicating(true); }}>Duplicate Task</MenuItem>}
                  {canEdit && !task.hrChecklist && <MenuItem icon={<MoveRight size={14} />} onClick={() => { close(); setMoving(activeId); }}>Move To...</MenuItem>}
                  <MenuItem icon={<Ticket size={14} />} onClick={() => { setConverting(true); close(); }}>Convert to Ticket</MenuItem>
                  {canEdit && <MenuItem icon={<LayoutTemplate size={14} />} onClick={() => { close(); setSavingTemplate(true); }}>Save as Template</MenuItem>}
                  {canEdit && <MenuItem icon={<Diamond size={14} style={{ color: task.isMilestone ? NX.purple : undefined }} />} onClick={() => { patch({ isMilestone: !task.isMilestone }); close(); }}>
                    {task.isMilestone ? 'Unmark Milestone' : 'Mark as Milestone'}
                  </MenuItem>}
                  {canEdit && <MenuItem danger icon={<Trash2 size={14} />} onClick={() => {
                    close();
                    const sub = !!task.parentTaskId;
                    if (!window.confirm(sub ? `Delete subtask "${task.title}"?` : `Delete "${task.title}" and its subtasks?`)) return;
                    const gone = activeId;
                    deleteTask(gone);
                    goBack(gone);
                  }}>
                    {task.parentTaskId ? 'Delete Subtask' : 'Delete Task'}
                  </MenuItem>}
                </>
              )}
            </Pop>
            <button onClick={() => (trail.length ? goBack() : onClose())}
              title={trail.length && taskById[trail[trail.length - 1]] ? `Back to ${taskById[trail[trail.length - 1]].title}` : 'Close'}
              style={{ ...btn('ghost'), padding: 7, color: NX.faint }}><ArrowRightToLine size={18} /></button>
          </div>
        </div>

        <FieldHistoryContext.Provider value={historyScope}>
        {/* title + tabs */}
        <div style={{ padding: '14px 18px 0', flexShrink: 0 }}>
          <div className="nx-hist-row" style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12 }}>
            {parent && (
              <button onClick={() => goBack()} title={`Back to ${parent.title}`} aria-label="Back to main task" style={{ ...btn('ghost'), padding: 4, color: NX.faint }}><ArrowLeft size={18} /></button>
            )}
            <TitleInput key={activeId} value={task.title} completed={task.completed} readOnly={!canEdit} onCommit={(v) => v.trim() && v !== task.title && patch({ title: v.trim() })} />
            <span style={{ display: 'inline-flex', flexShrink: 0 }}>
              <FieldHistoryButton field="title" label="Title" />
            </span>
          </div>
          {!canEdit && (
            <div data-testid="view-only-note" style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '-4px 0 12px', fontSize: 12.5, color: NX.dim }}>
              <Lock size={13} style={{ color: NX.faint, flexShrink: 0 }} />
              {canComment
                ? 'You can comment on this task, attach files and log time. Ask the project owner for edit access to change it.'
                : 'You can view this task. Ask the project owner for access to change it or comment.'}
            </div>
          )}
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
              ) : <span style={{ fontWeight: 600 }}>Private Task</span>}
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
                getComments={getComments} addComment={addComment} focusComment={focusHere} canComment={canComment} canPin={canEditProject}
              />
            </>
          ) : paneFor(tab)}
        </div>
        </FieldHistoryContext.Provider>
        {moving && <MoveTaskModal taskId={moving} onClose={() => setMoving(null)} />}
        {savingTemplate && <SaveTemplateModal task={task} subtasks={subtasks} onClose={() => setSavingTemplate(false)} />}
        {duplicating && <DuplicateTaskModal task={task} subtasks={subtasks} onClose={() => setDuplicating(false)} onDuplicate={duplicate} />}
        {shareOpen && <ShareModal task={task} people={people} nameOf={nameOf} patch={patch} onClose={() => setShareOpen(false)} />}
        {converting && (
          <Suspense fallback={null}>
            <CreateTicketModal onClose={() => setConverting(false)} onCreated={() => store.refresh?.()}
              fromTask={{ id: task.id, title: task.title, description: task.description, priority: task.priority,
                ownerId: task.ownerId, fileCount: (task.attachmentIds || []).length,
                // The task's people come over as the ticket's collaborators.
                collaboratorIds: [...taskAssignees(task), ...(task.followerIds || [])] }} />
          </Suspense>
        )}
      </aside>
    </div>,
    document.body,
  );
}

// ── Duplicate ────────────────────────────────────────────────────────────────
/** What a duplicate brings over (Neil, Oct 14 2026: "when you duplicate
 *  something it should ask what you want to come over"). Built for the
 *  one-checklist-per-entity case: copy the yearly tax return with its eleven
 *  subtasks and set the copy's Entity right here, on the copy AND every
 *  subtask, instead of opening each of them afterwards. */
const DUP_PARTS = [
  ['subtasks', 'Subtasks'], ['assignees', 'Assignees'], ['followers', 'Collaborators'],
  ['dates', 'Start and due dates'], ['recurrence', 'Recurrence'], ['fields', 'Field values'],
  ['description', 'Description'],
];

function DuplicateTaskModal({ task, subtasks, onClose, onDuplicate }) {
  const { customFields = [] } = useTasks();
  const fields = fieldsForTask(customFields, task).filter((f) => !f.readOnly);
  const [title, setTitle] = useState(`${task.title} (copy)`);
  const [parts, setParts] = useState(() => Object.fromEntries(DUP_PARTS.map(([k]) => [k, k !== 'recurrence' || !!task.recurrence?.freq])));
  const [values, setValues] = useState(() => ({ ...(task.customFieldValues || {}) }));
  const [busy, setBusy] = useState(false);
  // Every part is listed, as in Save as Template (Oct 14 2026); one this task
  // has nothing of is greyed out, says why, and is never brought over.
  const nothing = {
    subtasks: !subtasks.length && 'this task has none',
    recurrence: !task.recurrence?.freq && 'this task does not repeat',
    // Values can outlive the field list shown here (a field from another
    // project) - they still travel, so only an empty task is "none".
    fields: !fields.length && !Object.keys(task.customFieldValues || {}).length && 'this task has none',
  };
  const go = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    const kept = Object.fromEntries(DUP_PARTS.map(([k]) => [k, !nothing[k] && !!parts[k]]));
    try { await onDuplicate({ title: title.trim(), parts: kept, values }); onClose(); } finally { setBusy(false); }
  };
  const footer = (
    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
      <button type="button" onClick={onClose} style={btn('outline')}>Cancel</button>
      <button type="button" onClick={go} disabled={busy || !title.trim()} style={{ ...btn('primary'), opacity: busy || !title.trim() ? 0.6 : 1 }}>
        {busy ? 'Duplicating…' : 'Duplicate'}
      </button>
    </div>
  );
  return (
    <Modal title="Duplicate Task" onClose={onClose} footer={footer}>
      <div style={{ display: 'grid', gap: 16, fontFamily: FONT, fontSize: 13 }}>
        <label style={{ display: 'grid', gap: 5 }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: NX.dim }}>Task Name</span>
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()} style={inputStyle} />
        </label>
        <div style={{ display: 'grid', gap: 6 }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: NX.dim }}>Bring Over</span>
          {DUP_PARTS.map(([k, label]) => (
            <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: nothing[k] ? 'default' : 'pointer', color: nothing[k] ? NX.faint : NX.ink }}>
              <input type="checkbox" disabled={!!nothing[k]} checked={!nothing[k] && !!parts[k]} onChange={(e) => setParts((p) => ({ ...p, [k]: e.target.checked }))} />
              {label}
              {k === 'subtasks' && subtasks.length > 0 && <span style={{ color: NX.faint }}>({subtasks.length})</span>}
              {nothing[k] && <span style={{ fontSize: 12, color: NX.faint }}>- {nothing[k]}</span>}
            </label>
          ))}
        </div>
        {parts.fields && fields.length > 0 && (
          <div style={{ display: 'grid', gap: 8 }}>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: NX.dim }}>
              Field Values on the Copy{parts.subtasks && subtasks.length ? ' and Its Subtasks' : ''}
            </span>
            {fields.map((f) => (
              <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ width: 110, color: NX.faint }}>{f.name}</span>
                <CustomFieldInput field={f} value={values[f.id]} onChange={(v) => setValues((x) => ({ ...x, [f.id]: v }))} />
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

// ── Save as Template ─────────────────────────────────────────────────────────
/** "Convert to task template" (Neil, Oct 14 2026), the way project templates
 *  work: the task, its subtasks and checklists saved as a blueprint anyone can
 *  start again from the Templates button - the yearly tax return set up once,
 *  started for each entity. The server reads the task itself. */
const TEMPLATE_PARTS = [
  ['subtasks', 'Subtasks'], ['assignees', 'Assignees'], ['followers', 'Collaborators'],
  ['fields', 'Field values'], ['recurrence', 'Recurrence'], ['description', 'Description'], ['checklist', 'Checklists'],
];

function SaveTemplateModal({ task, subtasks, onClose }) {
  const { saveTaskAsTemplate, deleteTemplate, offerUndo } = useTasks();
  const [name, setName] = useState(task.title || '');
  const [description, setDescription] = useState('');
  const [parts, setParts] = useState(() => Object.fromEntries(TEMPLATE_PARTS.map(([k]) => [k, true])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Every part is listed, so none looks missing (Sagar, Oct 14 2026: "what
  // about the subtasks?" on a task that had none); one this task has nothing
  // of is greyed out and says why.
  const nothing = { subtasks: !subtasks.length && 'this task has none', recurrence: !task.recurrence?.freq && 'this task does not repeat' };
  const shown = TEMPLATE_PARTS.filter(([k]) => !nothing[k]);
  const save = async () => {
    if (!name.trim() || busy) return;
    setBusy(true); setError('');
    try {
      const tpl = await saveTaskAsTemplate(task.id, {
        name: name.trim(), description: description.trim(),
        parts: shown.map(([k]) => k).filter((k) => parts[k]),
      });
      offerUndo?.(`Saved "${tpl.name.slice(0, 40)}" as a template`, () => deleteTemplate(tpl.id));
      onClose();
    } catch (e) {
      setError(e?.message || 'Could not save the template.');
    } finally { setBusy(false); }
  };
  const footer = (
    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
      <button type="button" onClick={onClose} style={btn('outline')}>Cancel</button>
      <button type="button" onClick={save} disabled={busy || !name.trim()} style={{ ...btn('primary'), opacity: busy || !name.trim() ? 0.6 : 1 }}>
        {busy ? 'Saving…' : 'Save Template'}
      </button>
    </div>
  );
  return (
    <Modal title="Save as Template" onClose={onClose} footer={footer}>
      <div style={{ display: 'grid', gap: 16, fontFamily: FONT, fontSize: 13 }}>
        <label style={{ display: 'grid', gap: 5 }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: NX.dim }}>Template Name</span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} style={inputStyle} />
        </label>
        <label style={{ display: 'grid', gap: 5 }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: NX.dim }}>Description</span>
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What it is for (optional)" style={inputStyle} />
        </label>
        <div style={{ display: 'grid', gap: 6 }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: NX.dim }}>Keep</span>
          {TEMPLATE_PARTS.map(([k, label]) => (
            <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: nothing[k] ? 'default' : 'pointer', color: nothing[k] ? NX.faint : NX.ink }}>
              <input type="checkbox" disabled={!!nothing[k]} checked={!nothing[k] && !!parts[k]} onChange={(e) => setParts((p) => ({ ...p, [k]: e.target.checked }))} />
              {label}
              {k === 'subtasks' && subtasks.length > 0 && <span style={{ color: NX.faint }}>({subtasks.length})</span>}
              {nothing[k] && <span style={{ fontSize: 12, color: NX.faint }}>- {nothing[k]}</span>}
            </label>
          ))}
          <span style={{ fontSize: 12, color: NX.faint }}>
            Dates are kept relative to the due date, so a template starts on whatever date you pick. Comments, files and history are never copied.
          </span>
        </div>
        {error && <div role="alert" style={{ fontSize: 12.5, color: NX.red }}>{error}</div>}
      </div>
    </Modal>
  );
}

/** The task data for one copy, trimmed to the parts asked for. `fieldValues`
 *  replaces the copied ones for the fields the dialog showed (the main task's
 *  fields); a subtask's own extra fields stay as they were. */
function duplicateWith(t, { parts, values }, overrides = {}) {
  const d = duplicateTaskData(t, overrides);
  if (!parts.assignees) { d.assigneeIds = []; d.ownerId = ''; }
  if (!parts.followers) d.followerIds = [];
  if (!parts.dates) { d.dueOn = ''; d.startOn = ''; }
  if (!parts.description) d.description = '';
  d.customFieldValues = parts.fields ? { ...(d.customFieldValues || {}), ...(values || {}) } : {};
  if (parts.recurrence && t.recurrence?.freq && !t.parentTaskId) {
    const rule = { ...t.recurrence };
    delete rule.nextOccurrenceId; delete rule.closedAsMissed;
    d.recurrence = rule;
    d.status = 'recurring';
  }
  if (t.parentTaskId && t.recurrence?.skip) d.recurrence = { skip: true };
  return d;
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

// The Projects field's menu: tick any number (the first ticked is home). Your
// own projects first, as ProjectPicker orders them, then the rest; search
// covers the long tail.
function ProjectMenuBody({ projects, selected, mine, onToggle }) {
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const byName = (a, b) => (a.name || '').localeCompare(b.name || '', 'en', { sensitivity: 'base', numeric: true });
  const live = (projects || [])
    .filter((p) => (!p.archived || selected.includes(p.id)) && (!needle || (p.name || '').toLowerCase().includes(needle)));
  const top = live.filter((p) => mine.has(p.id)).sort(byName);
  const rest = live.filter((p) => !mine.has(p.id)).sort(byName);
  const rows = [...top, ...rest];
  const nav = useListNav(rows, { query: q, onPick: (p) => onToggle(p.id) });
  const row = (p, i) => (
    <label key={p.id} {...nav.optionProps(i)} className="nx-menu-row" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', fontSize: 13, cursor: 'pointer', color: NX.ink }}>
      <input type="checkbox" checked={selected.includes(p.id)} onChange={() => onToggle(p.id)} />
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
      {selected[0] === p.id && <span style={{ fontSize: 10.5, fontWeight: 700, color: NX.faint }}>HOME</span>}
    </label>
  );
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: NX.faint, padding: '4px 6px' }}>Projects</div>
      <input className="nx-inline-edit" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search projects…"
        {...nav.inputProps} onKeyDown={nav.onKeyDown}
        style={{ width: '100%', boxSizing: 'border-box', border: 'none', borderBottom: `1px solid ${NX.border}`, padding: '6px 8px', fontSize: 13, fontFamily: FONT, color: NX.ink }} />
      <div className="nx-scroll" style={{ maxHeight: 260, overflowY: 'auto' }}>
        {top.length > 0 && <MenuCaption inset={8}>My Projects</MenuCaption>}
        {top.map((p, i) => row(p, i))}
        {top.length > 0 && rest.length > 0 && <MenuCaption inset={8}>Other Projects</MenuCaption>}
        {rest.map((p, i) => row(p, top.length + i))}
        {rows.length === 0 && <div style={{ padding: 8, fontSize: 12, color: NX.faint }}>{needle ? 'No match' : 'No projects'}</div>}
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
  // A phone gets the full-screen sheet; elsewhere the 60% popup (.nx-popup).
  const isMobile = useIsMobile();
  const copy = () => { navigator.clipboard?.writeText(`${window.location.origin}${window.location.pathname}?task=${task.id}`); setCopied(true); setTimeout(() => setCopied(false), 1500); };
  const OPTS = [
    { key: 'org', icon: Globe, label: 'Everyone in your organization', desc: 'Any organization member can find and access this task.' },
    { key: 'restricted', icon: Lock, label: 'Members of this task and connected projects', desc: 'Only invited members and members of connected projects can access.' },
  ];
  return createPortal(
    <div className="nx-tasks-portal" onMouseDown={(e) => e.target === e.currentTarget && onClose()} style={{ position: 'fixed', inset: 0, background: 'rgba(17,24,39,0.45)', zIndex: 5000, display: 'flex', alignItems: isMobile ? 'stretch' : 'center', justifyContent: 'center', padding: isMobile ? 0 : '16px', fontFamily: FONT }}>
      {/* A flex column: header and footer stay put, the body (.nx-fill) takes
          the rest of the 60vh and scrolls - no short form over an empty half. */}
      <div className="nx-popup" role="dialog" aria-modal="true" aria-label={`Share ${task.title}`}
        style={{ background: NX.surface, borderRadius: isMobile ? 0 : 14, boxShadow: '0 24px 60px rgba(0,0,0,0.28)', display: 'flex', flexDirection: 'column', overflow: 'hidden', ...(isMobile ? { height: '100%', maxHeight: '100%' } : null) }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '15px 20px', borderBottom: `1px solid ${NX.border}`, flexShrink: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 700 }}>Share “{task.title}”</div>
          <button onClick={onClose} aria-label="Close" title="Close" style={{ ...btn('ghost'), padding: 6 }}><X size={18} /></button>
        </div>
        <div className="nx-fill nx-scroll" style={{ padding: 20, gap: 16, overflowY: 'auto' }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: NX.dim, marginBottom: 8 }}>Who Has Access</div>
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
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: isMobile ? '12px 16px calc(12px + env(safe-area-inset-bottom))' : '13px 20px', borderTop: `1px solid ${NX.border}`, flexShrink: 0 }}>
          <button onClick={copy} style={btn('outline')}><Link2 size={14} /> {copied ? 'Copied!' : 'Copy Link'}</button>
          <button onClick={onClose} style={btn('primary')}>Done</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── title (uncontrolled-ish, commits on blur/Enter) ─────────────────────────
function TitleInput({ value, completed, onCommit, readOnly = false }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <input
      value={v} readOnly={readOnly} aria-label="Task name"
      onChange={(e) => setV(e.target.value)}
      onBlur={() => { if (!readOnly) onCommit(v); }}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      className="nx-inline-edit"
      style={{ width: '100%', border: 'none', fontFamily: FONT, fontSize: 20, fontWeight: 700, color: completed ? NX.faint : NX.ink, textDecoration: completed ? 'line-through' : 'none' }}
    />
  );
}

// ── From Ticket ─────────────────────────────────────────────────────────────
/** Leave the task for the ticket it came from: the Tickets screen for
 *  whoever works the desk, Support (their own requests) for everyone else,
 *  with that ticket's drawer opened (lib/openTarget). */
function openSourceTicket(ticketId, closeDrawer, view = 'tickets') {
  if (!ticketId) return;
  closeDrawer?.();
  window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view } }));
  openNotificationTarget({ ticketId });
}

/** "Ticket #123 · Printer jammed" - the store's copy when the Tickets screen
 *  has loaded it, else a summary read. Someone who cannot see the ticket gets
 *  its number-less name and no link. */
function SourceTicketLink({ ticketId, onOpen }) {
  const { tickets = [] } = useTasks();
  const known = tickets.find((x) => x.id === ticketId);
  const [fetched, setFetched] = useState(null);   // summary | 'denied'
  useEffect(() => {
    if (known) return undefined;
    let alive = true;
    api.getTicketSummary(ticketId).then((r) => { if (alive) setFetched(r); }).catch(() => { if (alive) setFetched('denied'); });
    return () => { alive = false; };
  }, [ticketId, known]);
  const tk = known || (fetched && fetched !== 'denied' ? fetched : null);
  if (fetched === 'denied' && !known) return <span style={{ fontSize: 13, color: NX.faint, paddingTop: 5 }}>A ticket you cannot open</span>;
  if (!tk) return <span className="skel" style={{ display: 'block', width: 180, height: 14, marginTop: 8 }} />;
  return (
    <button type="button" onClick={onOpen} title="Open the ticket"
      style={{ ...btn('ghost'), padding: '5px 8px', fontSize: 13, color: NX.primary, fontWeight: 600, maxWidth: '100%', minWidth: 0 }}>
      <Ticket size={14} style={{ flexShrink: 0 }} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ticketNo(tk.code)} · {tk.subject}</span>
    </button>
  );
}

// ── Recurrence ──────────────────────────────────────────────────────────────
/** The Recurrence row: the Repeat menu (RecurrenceMenu.jsx) under a button
 *  naming the rule, with Ends beside it once the task has a schedule of its
 *  own. A subtask may also repeat with its main task, or stay behind. Keyed
 *  by task, so the Ends mode is read again for each one. */
function RecurrencePicker({ value, seedDate, onChange, subtask = false, mainRule = null }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
      <Pop width={300} trigger={(t) => (
        <button type="button" onClick={t} aria-label="Recurrence" style={{ ...btn('ghost'), padding: '5px 8px', fontSize: 12, textAlign: 'left' }}>
          <Repeat size={13} style={{ flexShrink: 0 }} /> {repeatSummary(value, { subtask, mainRule })}
        </button>
      )}>
        {(close) => <RecurrenceMenu value={value} seedDate={seedDate} onChange={onChange} close={close} subtask={subtask} mainRule={mainRule} />}
      </Pop>
      {value?.freq && <RecurrenceEnds value={value} onChange={onChange} />}
    </div>
  );
}

// Every field control on the Overview is this wide at least, so the column of
// boxes lines up (Neil, Oct 14 2026: "this is too small, make it wider").
const FIELD_W = 300;
const sameValue = (x, y) => JSON.stringify(x ?? null) === JSON.stringify(y ?? null);

/** A real dropdown for Status / Priority / Team: an outlined box, the value's
 *  color on a dot, a chevron (Neil, Oct 14 2026 - a bare chip did not read as
 *  something that could be changed). */
function MenuSelect({ label, color, options, current, onPick, ariaLabel, width = 200 }) {
  const dot = (c) => <span style={{ width: 9, height: 9, borderRadius: '50%', background: c || NX.faint, flexShrink: 0 }} />;
  return (
    <Pop width={width} trigger={(t) => (
      <button type="button" onClick={t} aria-label={ariaLabel} aria-haspopup="menu"
        style={{ ...btn('outline'), minWidth: width, justifyContent: 'space-between', padding: '6px 10px', fontSize: 13, color: NX.ink }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>{dot(color)}{label}</span>
        <ChevronDown size={15} style={{ color: NX.faint, flexShrink: 0 }} />
      </button>
    )}>
      {(close) => options.map((o) => (
        <MenuItem key={o.key} icon={dot(o.color)} onClick={() => { onPick(o.key); close(); }}>
          <span style={{ flex: 1 }}>{o.label}</span>
          {o.key === current && <Check size={13} style={{ color: NX.blue }} />}
        </MenuItem>
      ))}
    </Pop>
  );
}

/** "Also do this on the subtasks?" under the row that changed. */
function CascadeAsk({ ask, onClose }) {
  return (
    <div role="status" style={{
      marginLeft: 108, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '7px 10px',
      borderRadius: 10, background: `${NX.blue}12`, border: `1px solid ${NX.blue}40`, fontSize: 12.5, color: NX.ink,
    }}>
      <CornerDownRight size={14} style={{ color: NX.blue, flexShrink: 0 }} />
      <span style={{ flex: 1, minWidth: 160 }}>{ask.text}</span>
      <button type="button" onClick={() => { ask.apply(); onClose(); }} style={{ ...btn('primary'), padding: '5px 10px', fontSize: 12 }}>Apply to Subtasks</button>
      <button type="button" onClick={onClose} style={{ ...btn('ghost'), padding: '5px 10px', fontSize: 12 }}>Not Now</button>
    </div>
  );
}

/** Projects - the task's own project and the ones it is "also in", as ONE
 *  multi-select (Neil, Oct 14 2026: they were two rows). The first is its
 *  home project, whose statuses, sections and teams it uses; taking that one
 *  off makes the next one home. */
function ProjectsField({ task, projects, teams, myEmail, projectName, patch }) {
  const ids = [...new Set([task.projectId, ...(task.projectIds || [])].filter(Boolean))];
  const set = (next) => {
    const home = next[0] || '';
    patch({ projectId: home, projectIds: next.slice(1), ...(home !== (task.projectId || '') ? { teamId: '' } : {}) });
  };
  const toggle = (id) => set(ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);
  return (
    <Pop width={320} trigger={(t) => (
      <button type="button" onClick={t} aria-label="Projects"
        style={{ ...btn('outline'), minWidth: FIELD_W, maxWidth: '100%', justifyContent: 'space-between', height: 'auto', minHeight: 36, padding: '5px 10px' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap', minWidth: 0 }}>
          {ids.length === 0 && <span style={{ color: NX.faint, fontWeight: 400 }}>No project</span>}
          {ids.map((id, i) => (
            <span key={id} title={i === 0 ? 'Home project - its statuses and sections apply' : 'Also in this project'}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: NX.surface2, border: `1px solid ${NX.border}`, borderRadius: 20, padding: '2px 8px', fontSize: 12, color: NX.ink, fontWeight: i === 0 ? 600 : 400 }}>
              {projectName(id) || id}
              <span role="button" tabIndex={-1} title={`Remove from ${projectName(id) || 'this project'}`}
                onClick={(e) => { e.stopPropagation(); toggle(id); }}
                style={{ display: 'inline-flex', cursor: 'pointer', color: NX.faint }}><X size={11} /></span>
            </span>
          ))}
        </span>
        <ChevronDown size={15} style={{ color: NX.faint, flexShrink: 0 }} />
      </button>
    )}>
      {() => <ProjectMenuBody projects={projects} selected={ids} mine={myProjectIds(projects, teams, myEmail)} onToggle={toggle} />}
    </Pop>
  );
}

// ── Overview ────────────────────────────────────────────────────────────────
function OverviewTab({ task, patch, readOnly = false, canComment = true, canEditProject = true, canEditTask = null, people, projectName, teamName, teams, projects, blockedBy, depCandidates, addDependency, removeDependency, setDependencyType, subtasks, createTask, updateTask, onOpenSub, onMoveSub = null, nameOf, myEmail, getComments, addComment, refresh, onViewAllComments, onOpenTicket }) {
  const isMobile = useIsMobile();
  // Whether the folding sections below have anything in them.
  const hasApproval = !!task.approvalStatus && task.approvalStatus !== 'none';
  const hasComments = (task.commentIds || []).length > 0;
  const { statusMeta, statusOrder, statusOrderFor, customFields = [], tasks: allTasks = [], taskById = {} } = useTasks();
  // The task's own project, not the view's: this drawer opens from My Tasks and
  // from search, where no project is locked.
  const taskStatusOrder = statusOrderFor ? statusOrderFor(task.projectId) : statusOrder;
  const parent = task.parentTaskId ? taskById[task.parentTaskId] : null;
  // Setting any recurrence flips the task to "Recurring"; clearing it reverts a
  // still-recurring status back to Not Started.
  const setRecurrence = (rec) => patch({
    recurrence: rec,
    status: rec?.freq ? 'recurring' : (task.status === 'recurring' ? 'not_started' : task.status),
  });
  const repeatCtx = { subtask: !!task.parentTaskId, mainRule: parent?.recurrence || null };
  const sm = statusMeta[task.status] || {};
  const pm = PRIORITY_META[task.priority] || {};
  const projectTeams = (teams || []).filter((tm) => teamInProject(tm, task.projectId));
  const followers = task.followerIds || [];

  // Changes on a main task offered to its subtasks (Neil, Oct 14 2026: "the
  // subtask is the child of the parent" - change the entity on the main task
  // and it should ask whether its subtasks change too). Asked, not done
  // silently: a subtask can carry its own value on purpose. Only OPEN
  // subtasks that differ are counted.
  const [ask, setAsk] = useState(null);           // { at: 'followers' | 'fields', text, apply }
  useEffect(() => setAsk(null), [task.id]);
  const openSubs = (subtasks || []).filter((x) => !x.completed);
  const plural = (n) => `${n} subtask${n === 1 ? '' : 's'}`;
  const setFollowers = (next) => {
    patch({ followerIds: next });
    const added = next.filter((e) => !followers.includes(e));
    const removed = followers.filter((e) => !next.includes(e));
    const subs = openSubs.filter((x) => {
      const f = x.followerIds || [];
      return added.some((e) => !f.includes(e)) || removed.some((e) => f.includes(e));
    });
    if (!subs.length) { setAsk(null); return; }
    const who = [...added.map((e) => `add ${nameOf(e)}`), ...removed.map((e) => `take ${nameOf(e)} off`)].join(', ');
    setAsk({
      at: 'followers', text: `Also ${who} on the ${plural(subs.length)}?`,
      apply: () => subs.forEach((x) => updateTask(x.id, {
        followerIds: [...new Set([...(x.followerIds || []).filter((e) => !removed.includes(e)), ...added])],
      })),
    });
  };
  const patchFields = (p) => {
    const before = task.customFieldValues || {};
    const after = p.customFieldValues || {};
    const result = patch(p);
    const changed = Object.keys(after).filter((k) => !sameValue(after[k], before[k]));
    const subs = openSubs.filter((x) => changed.some((k) => !sameValue((x.customFieldValues || {})[k], after[k])));
    if (!changed.length || !subs.length) return result;
    const names = changed.map((k) => customFields.find((f) => f.id === k)?.name).filter(Boolean).join(', ') || 'this field';
    setAsk({
      at: 'fields', text: `Change ${names} on the ${plural(subs.length)} too?`,
      apply: () => subs.forEach((x) => updateTask(x.id, {
        customFieldValues: { ...(x.customFieldValues || {}), ...Object.fromEntries(changed.map((k) => [k, after[k]])) },
      })),
    });
    return result;
  };
  const askBar = (at) => ask?.at === at && <CascadeAsk ask={ask} onClose={() => setAsk(null)} />;

  return (
    <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13 }}>
      {/* The ticket it was made from, or linked to (Oct 14 2026). */}
      {task.sourceTicketId && (
        <Row label="From Ticket"><SourceTicketLink ticketId={task.sourceTicketId} onOpen={onOpenTicket} /></Row>
      )}
      {/* Same column and gap as the tab body, so locking moves nothing. */}
      <FieldsLock readOnly={readOnly} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Row label="Assignee" history="assigneeIds" historyLabel="Assignees">
        <div style={{ minWidth: FIELD_W }}>
          {/* Several people can hold one task; any of them completing it
              completes it for all (one row, one flag). */}
          <PersonMultiSelect value={taskAssignees(task)} people={people} addTitle="Add assignee"
            onChange={(list) => patch({ assigneeIds: list })} placeholder="Unassigned" />
        </div>
      </Row>

      {/* The same box as Assignee - chips, the dashed add, a chevron (Neil,
          Oct 14 2026: the two rows looked like different kinds of control). */}
      <Row label="Collaborators">
        <Pop width={240} trigger={(t) => (
          <button type="button" onClick={t} aria-label="Collaborators"
            style={{ ...btn('outline'), minWidth: FIELD_W, justifyContent: 'space-between', height: 'auto', minHeight: 36, padding: '5px 10px' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
              {followers.length === 0 && <span style={{ color: NX.faint, fontWeight: 400 }}>No collaborators</span>}
              {followers.map((em) => (
                <span key={em} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: NX.surface2, border: `1px solid ${NX.border}`, borderRadius: 20, padding: '2px 7px 2px 2px', fontSize: 12, color: NX.ink, fontWeight: 400 }}>
                  <Avatar email={em} name={nameOf(em)} size={18} card={false} />
                  {nameOf(em)}
                  {/* A span: it sits inside the trigger button. */}
                  <span role="button" tabIndex={-1} title={`Remove ${nameOf(em)}`}
                    onClick={(e) => { e.stopPropagation(); setFollowers(followers.filter((x) => x !== em)); }}
                    style={{ display: 'inline-flex', cursor: 'pointer', color: NX.faint }}><X size={11} /></span>
                </span>
              ))}
              <span aria-hidden="true" style={{
                width: 22, height: 22, borderRadius: '50%', border: `1.5px dashed ${NX.border}`, color: NX.faint, flexShrink: 0,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              }}><UserPlus size={12} /></span>
            </span>
            <ChevronDown size={15} style={{ color: NX.faint, flexShrink: 0 }} />
          </button>
        )}>
          {/* On a phone the menu covers the form, so adding a name closes it. */}
          {(close) => <CollaboratorMenuBody people={people} selected={followers}
            onChange={(next, adding) => { setFollowers(next); if (isMobile && adding) close(); }} />}
        </Pop>
      </Row>
      {askBar('followers')}

      {/* Project and Also In are one field now (Neil, Oct 14 2026), moved up
          under the people. A subtask lives in its main task's project. */}
      {!task.parentTaskId && (
        <Row label="Projects" history="projectId,projectIds">
          <ProjectsField task={task} projects={projects} teams={teams} myEmail={myEmail} projectName={projectName} patch={patch} />
        </Row>
      )}

      {/* Everything after Projects sits two to a line (Sagar, Oct 14 2026):
          Due Date | Recurrence, Start Date | Status, Priority | Team, then
          Section and the custom fields in pairs. One column on a phone. */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'minmax(0, 1fr)' : 'repeat(2, minmax(0, 1fr))', columnGap: 20, rowGap: 8, alignItems: 'start' }}>
      <Row label="Due Date" history="dueOn">
        <DateField value={task.dueOn || ''} onChange={(v) => patch({ dueOn: v || '' })} compact noPast
          repeat={repeatOption({ value: task.recurrence, seedDate: task.dueOn, onChange: setRecurrence, ...repeatCtx })}
          style={task.dueOn ? { ...inputStyle, width: 'auto', padding: '6px 9px', fontSize: 12 } : undefined} />
        <DueBadge task={task} nameOf={nameOf} />
      </Row>
      {/* Beside the due date it repeats from. A subtask repeats with its
          main task by default, and can stay behind or keep its own schedule
          (Sagar, Oct 14 2026). */}
      <Row label="Recurrence">
        <RecurrencePicker key={task.id} value={task.recurrence} seedDate={task.dueOn} onChange={setRecurrence} {...repeatCtx} />
      </Row>

      {/* Read-only, the due-date panel sits OUTSIDE the field lock (below):
          answering an extension or a proposed date takes no project role -
          the requester and the approvers (task_due.approvers_of) may be
          viewers - and the server checks who may answer. */}
      {!readOnly && <div style={{ gridColumn: '1 / -1' }}><DueNegotiation task={task} /></div>}

      {/* Empty is normal - it fills itself when the task leaves Not Started. */}
      <Row label="Start Date" history="startOn">
        <DateField value={task.startOn || ''} onChange={(v) => patch({ startOn: v || '' })} compact
          style={task.startOn ? { ...inputStyle, width: 'auto', padding: '6px 9px', fontSize: 12 } : undefined} />
      </Row>

      {/* Status and Priority are dropdowns, not chips (Neil, Oct 14 2026: a
          chip did not say it could be changed). */}
      <Row label="Status" history="status">
        <MenuSelect ariaLabel="Status" label={sm.label || task.status} color={sm.color} current={task.status}
          options={taskStatusOrder.map((x) => ({ key: x, label: statusMeta[x]?.label || x, color: statusMeta[x]?.color }))}
          onPick={(x) => patch({ status: x })} />
      </Row>

      <Row label="Priority" history="priority">
        <MenuSelect ariaLabel="Priority" label={pm.label || task.priority} color={pm.color} current={task.priority}
          options={PRIORITY_ORDER.map((x) => ({ key: x, label: PRIORITY_META[x].label, color: PRIORITY_META[x].color }))}
          onPick={(x) => patch({ priority: x })} />
      </Row>

      {/* Team only where the project HAS teams (or the task is already on
          one) - otherwise it was a row that could only say "No team" and
          read as a feature nobody could explain (Neil, Oct 14 2026). */}
      {task.projectId && (projectTeams.length > 0 || task.teamId) && (
        <Row label="Team">
          <MenuSelect ariaLabel="Team" label={teamName(task.teamId) || 'No Team'} color={task.teamId ? undefined : NX.border} current={task.teamId || ''}
            options={[{ key: '', label: 'No Team', color: NX.border }, ...projectTeams.map((tm) => ({ key: tm.id, label: tm.name, color: tm.color }))]}
            onPick={(x) => patch({ teamId: x })} />
        </Row>
      )}

      {/* Which of the project's Custom sections it is filed under. */}
      <TaskSectionRow task={task} patch={patch} />

      {/* Show On Card (Oct 22 2026): what the task's board card shows under
          its title - Planner's card preview. Editors only. */}
      <Row label="Show On Card">
        <ShowOnCardSelect task={task} disabled={readOnly} onChange={(v) => patch({ cardPreviewMode: v })}
          style={{ ...inputStyle, width: 'auto', minWidth: 180, padding: '5px 8px', fontSize: 13 }} />
      </Row>

      {/* The project's custom columns, right here on the task (Oct 13 2026) -
          they used to live only on the Properties tab, which most people
          never opened and phones do not show. */}
      <TaskCustomFieldRows task={task} customFields={customFields} projectName={projectName} patch={patchFields} />
      </div>
      {askBar('fields')}

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
                  <button onClick={() => removeDependency(b.id)} aria-label={`Remove dependency on ${b.title}`} title="Remove Dependency" style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: NX.faint, padding: 0, display: 'flex' }}><X size={12} /></button>
                </span>
              </div>
            );
          })}
          <Pop width={280} trigger={(t) => <button onClick={t} style={{ ...btn('outline'), padding: '5px 11px', fontSize: 12 }}>Add Dependency</button>}>
            {(close) => <DependencyPickerBody candidates={depCandidates} onPick={(c) => { addDependency(c); close(); }} />}
          </Pop>
        </div>
      </Row>
      </FieldsLock>
      {readOnly && <DueNegotiation task={task} />}

      {/* Description */}
      <Section title="Description">
        {readOnly ? (
          task.description
            ? <div className="nx-rich-view" data-testid="description-read-only" style={{ color: NX.ink }} dangerouslySetInnerHTML={{ __html: richBodyHtml(task.description, nameOf) }} />
            : <div style={{ fontSize: 13, color: NX.faint }}>No description.</div>
        ) : (
          <DescriptionInput task={task} value={task.description || ''} refresh={refresh}
            onCommit={(v) => v !== (task.description || '') && patch({ description: v })} />
        )}
      </Section>

      {/* Checklist (Oct 2026) - open when it has lines, folded when empty so
          a task that never needed one is not pushed down by an add box. The
          hint rides on the heading, where it shows while folded too: neither
          Neil nor Sagar could tell what the section was for (Oct 14 2026). */}
      <Section defaultOpen={(task.checklistTotal || 0) > 0} title={<>
        {task.checklistTotal ? `Checklist ${task.checklistDone || 0}/${task.checklistTotal}` : 'Checklist'}
        <span style={{ fontWeight: 400, fontSize: 12, color: NX.faint, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          Quick steps for this task. Use Subtasks for work that needs its own date or owner.
        </span>
      </>}>
        <Checklist task={task} people={people} />
      </Section>

      {/* Subtasks (inline) */}
      {/* Open whenever the task has subtasks (Oct 13 2026) - folded, they
          were easy to miss. */}
      <Section key={`subtasks:${task.id}:${subtasks?.length > 0}`} defaultOpen={subtasks?.length > 0}
        title={subtasks?.length ? `Subtasks ${subtasks.filter((s) => s.completed).length}/${subtasks.length}` : 'Subtasks'}>
        <SubtasksTab task={task} subtasks={subtasks || []} createTask={createTask} updateTask={updateTask} people={people} onOpenSub={onOpenSub} onMoveSub={onMoveSub} hideHeading
          canAdd={canEditProject} canEditParent={!readOnly} canEditTask={canEditTask} />
      </Section>

      {/* Time tracking - only where the task's project tracks time, or the
          task already has time on it (Oct 13 2026; see taskTracksTime). */}
      {taskTracksTime(task, projects, allTasks) && (
        <Section defaultOpen={false} title="Time Tracking">
          <TimeTracking task={task} canLog={canComment} />
        </Section>
      )}

      {/* Approval, Comments (and Subtasks above): open when there is
          something in them, folded when empty (Oct 13 2026). Keyed so the
          choice is made again for each task, and when content first appears. */}
      <Section key={`approval:${task.id}:${hasApproval}`} defaultOpen={hasApproval} title="Approval">
        <FieldsLock readOnly={readOnly}><Approval task={task} patch={patch} /></FieldsLock>
      </Section>

      {/* Add comment - dropped on mobile: the Comments/All-activity block at the
          bottom of the stacked layout already has a composer. */}
      {!isMobile && (canComment || hasComments) && (
        <Section key={`comments:${task.id}:${hasComments}`} defaultOpen={hasComments} title="Comments">
          <QuickComment task={task} addComment={addComment} getComments={getComments}
            nameOf={nameOf} myEmail={myEmail} onViewAll={onViewAllComments} canComment={canComment} canPin={canEditProject} />
        </Section>
      )}

      {/* Attachments */}
      <Section title="Attachments">
        <AttachmentsTab task={task} refresh={refresh} canAttach={canComment} canRemoveAny={canEditProject} onShowOnCard={readOnly ? null : (v) => patch({ cardPreviewMode: v })} />
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

// Per file, run after the comment itself has already posted - one failed
// upload must never look like the comment failed too. Resolves to the files
// that did NOT attach ([{ file, error }]) so the composer can say so and offer
// a retry onto the same comment, instead of dropping them silently.
async function uploadPendingAttachments(taskId, commentId, files) {
  const results = await Promise.allSettled(files.map((f) => uploadTaskAttachment(taskId, f, { comment_id: commentId })));
  return results
    .map((r, i) => (r.status === 'rejected' ? { file: files[i], error: r.reason?.message || 'Upload failed.' } : null))
    .filter(Boolean);
}

// A comment composer's files that did not attach: kept on screen with what
// went wrong, a Retry that sends them to the same comment, and a Dismiss.
function useCommentUploads(taskId, reloadAttachments) {
  // { taskId, commentId, items: [{ file, error }] } - kept with its task, so
  // stepping to another task in the drawer does not carry the notice over.
  const [state, setState] = useState(null);
  const failed = state?.taskId === taskId ? state : null;
  const upload = async (commentId, files) => {
    const bad = await uploadPendingAttachments(taskId, commentId, files);
    setState(bad.length ? { taskId, commentId, items: bad } : null);
    reloadAttachments();
  };
  const retry = () => failed && upload(failed.commentId, failed.items.map((x) => x.file));
  return { failed, upload, retry, dismiss: () => setState(null) };
}

function FailedUploads({ failed, onRetry, onDismiss }) {
  if (!failed?.items?.length) return null;
  const n = failed.items.length;
  return (
    <div role="alert" data-testid="comment-upload-failed" style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginTop: 8, padding: '6px 10px', border: `1px solid ${NX.red}`, borderRadius: 8, fontSize: 12 }}>
      <Paperclip size={13} style={{ color: NX.red, flexShrink: 0 }} />
      <span style={{ color: NX.ink, minWidth: 0, flex: 1 }}>
        The comment posted, but {n === 1 ? `"${failed.items[0].file.name}" did` : `${n} files did`} not attach: {failed.items[0].error}
      </span>
      <button type="button" onClick={onRetry} style={{ ...btn('outline'), padding: '3px 8px', fontSize: 11.5 }}>Retry</button>
      <button type="button" onClick={onDismiss} title="Dismiss" aria-label="Dismiss" style={{ ...btn('ghost'), padding: 3, color: NX.faint }}><X size={13} /></button>
    </div>
  );
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

function QuickComment({ task, addComment, getComments, nameOf, myEmail, onViewAll, canComment = true, canPin = true }) {
  const [body, setBody] = useState('');
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState([]);
  const people = usePeople();
  const [attachments, reloadAttachments] = useCommentAttachments(task.id);
  const uploads = useCommentUploads(task.id, reloadAttachments);

  const load = useCallback(() => {
    getComments?.(task.id).then((r) => setRows(r || [])).catch(() => setRows([]));
  }, [getComments, task.id]);
  useEffect(() => { load(); }, [load]);

  const [assignTo, setAssignTo] = useState('');
  const submit = async () => {
    if (isEmptyDoc(body) || busy) return;
    setBusy(true);
    try {
      const c = await addComment(task.id, body, assignTo ? { assignee_email: assignTo } : {});
      setBody('');
      setAssignTo('');
      if (pending.length) {
        const files = pending;
        setPending([]);
        await uploads.upload(c.id, files);
      }
      load();
    } catch { /* surfaced by the store */ } finally { setBusy(false); }
  };

  // Same pin/edit/delete shape as the full Comments tab (CommentsTab) - this is
  // a preview of the identical data, not a separate simplified view, so it
  // needs the same actions rather than a read-only cut-down.
  const handlers = useCommentHandlers(task, addComment, load, { canComment, canPin });

  // Newest last, like a chat log - the composer sits directly under the most
  // recent line so the thread reads top to bottom into the box you type in.
  // Threads, not lines: a question and its replies stay together.
  const all = rows || [];
  const threads = threadComments(all);
  const shown = threads.slice(-RECENT_COMMENTS);
  const hidden = threads.length - shown.length;

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
            {shown.map((th) => (
              <CommentThread key={th.root.id} thread={th} nameOf={nameOf} myEmail={myEmail} people={people} attachments={attachments} {...handlers} />
            ))}
          </div>
          <button onClick={onViewAll} style={{ ...btn('ghost'), padding: 0, fontSize: 12, fontWeight: 600, color: NX.primary, marginTop: 8 }}>
            View all comments ({all.length})
          </button>
        </div>
      )}
      {canComment && <div onPaste={(e) => onPasteStage(e, setPending)}>
        <RichDescription
          value={body}
          onChange={setBody}
          onSubmit={submit}
          mentionPeople={people}
          minHeight={64}
          onStageFiles={(fs) => setPending((p) => [...p, ...fs])}
        />
      </div>}
      <PendingAttachments files={pending} setFiles={setPending} />
      <FailedUploads failed={uploads.failed} onRetry={uploads.retry} onDismiss={uploads.dismiss} />
      {canComment && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 8, gap: 8 }}>
          <span style={{ fontSize: 11, color: NX.faint }}>
            Type <b>@</b> to mention someone - they'll get an email. ⌘/Ctrl+Enter to post.
          </span>
          <AssignToggle value={assignTo} onChange={setAssignTo} people={people} nameOf={nameOf} />
          <button onClick={submit} disabled={isEmptyDoc(body) || busy}
            style={{ ...btn('primary'), opacity: (isEmptyDoc(body) || busy) ? 0.5 : 1, flexShrink: 0 }}>
            {busy ? 'Posting…' : assignTo ? 'Assign Comment' : 'Comment'}
          </button>
        </div>
      )}
    </div>
  );
}

function DescriptionInput({ task, value, onCommit, refresh }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);

  // "+ → Attach file" puts the file on the TASK (so it shows in Attachments and
  // syncs to Asana) and hands the stored URL back so the editor can embed it.
  const attach = async (file) => {
    const row = await uploadTaskAttachment(task.id, file).catch((e) => {
      // Said out loud: the editor falls back to an inline copy (an image) or
      // nothing (a file), which used to look like the attach had worked.
      dialog.alert(`"${file.name}" did not attach to the task.${e?.message ? ` ${e.message}` : ''} Try again from Attachments.`, { title: 'File Not Attached' });
      return null;
    });
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

function Approval({ task, patch }) {
  const s = task.approvalStatus || 'none';
  if (s === 'none') {
    return <button onClick={() => patch({ approvalStatus: 'pending' })} style={{ ...btn('outline'), borderStyle: 'dashed', fontSize: 12 }}><ShieldCheck size={13} /> Request Approval</button>;
  }
  const color = s === 'approved' ? NX.green : s === 'rejected' ? NX.red : NX.amber;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <Chip color={color} tint={NX.border2}>{approvalLabel(s)}</Chip>
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
function DiscussionPane({ task, taskId, nameOf, myEmail, getComments, addComment, focusComment = null, canComment = true, canPin = true }) {
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
        {tab('activity', 'All Activity')}
      </div>
      {view === 'comments'
        ? <CommentsTab task={task} nameOf={nameOf} myEmail={myEmail} getComments={getComments} addComment={addComment} focusComment={focusComment} canComment={canComment} canPin={canPin} />
        : <ActivityTab taskId={taskId} nameOf={nameOf} />}
    </section>
  );
}

// ── Comments ────────────────────────────────────────────────────────────────
function CommentsTab({ task, nameOf, myEmail, getComments, addComment, focusComment = null, canComment = true, canPin = true }) {
  const [comments, setComments] = useState(null);
  const listRef = useRef(null);
  const focused = useRef(null);
  // Land on the comment the drawer was opened for, once its list is in: the
  // comment itself, else its thread's root (a resolved thread opens folded).
  useEffect(() => {
    if (!focusComment || comments === null || !listRef.current) return;
    // Once per ask to land (a new click is a new object), not on every re-read.
    if (focused.current === focusComment) return;
    const find = (id) => (id ? listRef.current.querySelector(`[data-comment-id="${CSS.escape(id)}"]`) : null);
    const el = find(focusComment.id) || find(focusComment.threadId);
    if (!el) return;
    focused.current = focusComment;
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    el.scrollIntoView?.({ block: 'center', behavior: still ? 'auto' : 'smooth' });
    el.animate?.([{ boxShadow: `0 0 0 2px ${NX.blue}` }, { boxShadow: `0 0 0 2px ${NX.blue}`, offset: 0.7 }, { boxShadow: '0 0 0 2px transparent' }],
      { duration: still ? 1 : 2400 });
  }, [focusComment, comments]);
  const [body, setBody] = useState('');
  const [pending, setPending] = useState([]);
  const people = usePeople();
  const [attachments, reloadAttachments] = useCommentAttachments(task.id);
  const uploads = useCommentUploads(task.id, reloadAttachments);
  const reload = () => getComments(task.id).then(setComments).catch(() => setComments([]));
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [task.id]);

  const [assignTo, setAssignTo] = useState('');
  const submit = async () => {
    if (isEmptyDoc(body)) return;
    setBody('');
    const c = await addComment(task.id, body, assignTo ? { assignee_email: assignTo } : {}).catch(() => null);
    setAssignTo('');
    if (c && pending.length) {
      const files = pending;
      setPending([]);
      await uploads.upload(c.id, files);
    }
    reload();
  };
  const handlers = useCommentHandlers(task, addComment, reload, { canComment, canPin });

  // Pinned threads first, then oldest first; a resolved thread renders folded
  // (CommentThread) so finished action items stop taking the room.
  const list = threadComments(comments || []).slice().sort((a, b) => (b.root.pinned ? 1 : 0) - (a.root.pinned ? 1 : 0));

  return (
    <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
      {canComment && <div onPaste={(e) => onPasteStage(e, setPending)}>
        <RichDescription value={body} onChange={setBody} onSubmit={submit}
          mentionPeople={people} minHeight={64}
          onStageFiles={(fs) => setPending((p) => [...p, ...fs])} />
        <PendingAttachments files={pending} setFiles={setPending} />
        <FailedUploads failed={uploads.failed} onRetry={uploads.retry} onDismiss={uploads.dismiss} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
          <span style={{ fontSize: 11, color: NX.faint }}>
            Type <b>@</b> to mention someone - they'll get an email.
          </span>
          <span style={{ marginLeft: 'auto' }}><AssignToggle value={assignTo} onChange={setAssignTo} people={people} nameOf={nameOf} /></span>
          <button onClick={submit} disabled={isEmptyDoc(body)}
            style={{ ...btn('primary'), opacity: isEmptyDoc(body) ? 0.5 : 1 }}>{assignTo ? 'Assign Comment' : 'Send'}</button>
        </div>
      </div>}
      {comments === null ? <LoadingState />
        : list.length === 0 ? <div style={{ color: NX.faint, fontSize: 13, textAlign: 'center', padding: 24 }}>No comments yet.</div>
          : <div ref={listRef} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {list.map((th) => <CommentThread key={th.root.id} thread={th} nameOf={nameOf} myEmail={myEmail} people={people} attachments={attachments} {...handlers} />)}
          </div>}
    </div>
  );
}

// The per-comment actions both comment surfaces share (Oct 2026): pin, edit,
// delete, reply in the thread, react, resolve, assign. Each one re-reads the
// list afterwards; the server is the source of truth for who may do what,
// and a refused action simply leaves the thread as it was.
// `canComment` / `canPin`: a reply is a new comment (commenter and up) and
// pinning takes a project editor (edit_comment) - without them the thread
// simply does not offer Reply / Pin (CommentThread hides an absent handler).
function useCommentHandlers(task, addComment, reload, { canComment = true, canPin = true } = {}) {
  const quiet = (p) => p.catch((e) => { if (e?.message) window.alert(e.message); });
  const all = {
    onPin: async (c) => { await quiet(api.editTaskComment(c.id, { pinned: !c.pinned })); reload(); },
    onEdit: async (c, text) => { await quiet(api.editTaskComment(c.id, { body: text })); reload(); },
    onDelete: async (c) => { if (!window.confirm('Delete this comment?')) return; await quiet(api.deleteTaskComment(c.id)); reload(); },
    onReply: async (root, html) => { await quiet(addComment(task.id, html, { parent_id: root.id })); reload(); },
    onReact: async (c, emoji) => { await quiet(api.reactTaskComment(c.id, emoji)); reload(); },
    onResolve: async (c, v) => { await quiet(api.editTaskComment(c.id, { resolved: v })); reload(); },
    onAssign: async (c, email) => { await quiet(api.editTaskComment(c.id, { assignee_email: email })); reload(); },
  };
  if (!canComment) delete all.onReply;
  if (!canPin) delete all.onPin;
  return all;
}

// "Assign to" beside the Send button: pick a person and the comment posts as
// an action item for them (a bell and an email of their own; closed by
// resolving it). Reads as a dot until someone is chosen.
function AssignToggle({ value, onChange, people, nameOf }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: value ? NX.ink : NX.faint, whiteSpace: 'nowrap' }}>
      <PersonDot value={value} people={people} nameOf={nameOf} onChange={onChange} size={18}
        emptyTitle="Assign this comment to someone" nobodyLabel="Nobody (not an action item)" />
      {value ? <>Assign to <b>{nameOf(value)}</b> <button type="button" onClick={() => onChange('')} aria-label="Do not assign" style={{ ...btn('ghost'), padding: 2, color: NX.faint }}><X size={11} /></button></> : 'Assign to…'}
    </span>
  );
}
// ── Activity ────────────────────────────────────────────────────────────────
// All Activity: one line per event, a save's field edits folded into one
// ("changed Priority and Start Date") so editing a task does not flood it.
// Field Changes: every recorded change on its own, with From -> To
// (Oct 22 2026, task_history.py).
const ACTIVITY_FILTERS = [['all', 'All Activity'], ['fields', 'Field Changes']];
export function ActivityTab({ taskId, nameOf }) {
  const [rows, setRows] = useState(null);
  const [filter, setFilter] = useState('all');
  const { customFields = [] } = useTasks();
  const ctx = useHistoryCtx(nameOf);
  useEffect(() => { api.getTaskActivity(taskId).then(setRows).catch(() => setRows([])); }, [taskId]);
  const shown = useMemo(() => {
    const list = rows || [];
    return (filter === 'fields' ? list.filter((a) => a.change) : groupFieldChanges(list, customFields)).slice().reverse();
  }, [rows, filter, customFields]);
  if (rows === null) return <LoadingState />;
  if (!rows.length) return <div style={{ color: NX.faint, fontSize: 13, textAlign: 'center', padding: 24 }}>No activity yet.</div>;
  return (
    <div style={{ marginTop: 14 }}>
      <div role="tablist" aria-label="Activity Filter" className="scroll-tabs" style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        {ACTIVITY_FILTERS.map(([key, label]) => {
          const on = filter === key;
          return (
            <button key={key} type="button" role="tab" aria-selected={on} onClick={() => setFilter(key)}
              style={{ ...btn(on ? 'outline' : 'ghost'), padding: '5px 10px', fontSize: 12, color: on ? NX.ink : NX.dim, whiteSpace: 'nowrap' }}>
              {label}
            </button>
          );
        })}
      </div>
      {shown.length === 0 && (
        <div style={{ color: NX.faint, fontSize: 13, textAlign: 'center', padding: 24 }}>No field changes recorded yet.</div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {shown.map((a) => {
          // The one change a line stands for, shown From -> To under it: every
          // line under Field Changes; under All Activity a status move or a
          // save that touched a single field (a fold of several stays one line).
          const one = filter === 'fields' ? a.change
            : a.type === 'field_changed' ? (a.changes?.length === 1 ? a.changes[0] : null)
              : a.type === 'status_changed' ? a.change : null;
          const text = filter === 'fields' ? `changed ${historyFieldName(a.change, customFields)}`
            : a.type === 'status_changed' && a.change ? 'changed the status' : a.detail;
          return (
            <div key={a.id} style={{ display: 'flex', gap: 10, fontSize: 12 }}>
              <Avatar email={a.actorId} name={nameOf(a.actorId)} size={22} />
              <div style={{ minWidth: 0 }}>
                <span style={{ fontWeight: 600, color: NX.ink }}>{(nameOf(a.actorId) || '').split(' ')[0]}</span>{' '}
                <span style={{ color: NX.dim }}>{text}</span>
                {one && <div style={{ marginTop: 3 }}><HistoryChange entry={one} ctx={ctx} /></div>}
                <div style={{ fontSize: 11, color: NX.faint }}>{fmtDateTime(a.at)}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Attachments ─────────────────────────────────────────────────────────────
// canAttach: may add files (commenter and up). canRemoveAny: may remove
// files someone else added (editor and up) - your own you can always remove,
// as the server allows (delete_attachment).
// File versions + Egnyte links (Oct 22 2026): each file shows its CURRENT
// version (a soft "V3" when it has more), with Upload New Version (or drop a
// file onto it) and a Versions panel; Add From Egnyte links a file or folder
// in Egnyte instead of uploading a copy. See attachmentParts.jsx.
// onShowOnCard (Oct 22 2026): an editor's "Show On Card" on each image file -
// it becomes the task's board card cover ('' puts the card back on Automatic).
function AttachmentsTab({ task, refresh, canAttach = true, canRemoveAny = true, onShowOnCard = null }) {
  const { myEmail, nameOf } = useTasks();
  const [rows, setRows] = useState(null);
  const [versionsOf, setVersionsOf] = useState(null);     // the file whose Versions panel is open
  const [egnyteOpen, setEgnyteOpen] = useState(false);
  // New versions in flight, by the attachment they replace: {pct, error}.
  const [verUploads, setVerUploads] = useState({});
  const [dropRow, setDropRow] = useState('');
  const versionFor = useRef(null);
  const versionRef = useRef(null);
  // In-flight files: {key, name, pct, file, error}. A failed one STAYS, with
  // what went wrong and a Retry - it used to vanish without a word.
  const [uploads, setUploads] = useState([]);
  const [delError, setDelError] = useState('');
  const [view, setView] = useState(null);   // attachment open in the in-app viewer
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);   // dragenter/dragleave fire on every child crossed, not just the panel edge
  const fileRef = useRef(null);
  const reload = () => api.getTaskAttachments(task.id).then((r) => setRows(currentVersionsOf(r))).catch(() => setRows([]));
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [task.id]);

  // Upload New Version: the file becomes the current version of `a`'s file.
  // It replaces the file everyone sees, so it takes the right to remove it
  // (the server's rule): whoever uploaded the FIRST version, or an editor.
  const mayReplace = (a) => canAttach && canVersion(a) && (canRemoveAny
    || (!!myEmail && (a.groupAddedBy || a.addedBy || '').toLowerCase() === myEmail.toLowerCase()));
  const sendVersion = (a, f) => {
    if (!f || !mayReplace(a)) return;
    setVerUploads((m) => ({ ...m, [a.id]: { pct: 0, error: '' } }));
    uploadTaskAttachmentVersion(a.id, f, (pct) => setVerUploads((m) => ({ ...m, [a.id]: { pct, error: '' } })))
      .then(() => { setVerUploads((m) => { const n = { ...m }; delete n[a.id]; return n; }); reload(); refresh?.(); })
      .catch((e) => setVerUploads((m) => ({ ...m, [a.id]: { pct: 0, error: `The new version of "${a.name}" did not upload: ${e?.message || 'upload failed'}.` } })));
  };
  const pickVersion = (a) => { versionFor.current = a; versionRef.current?.click(); };
  const onVersionFile = (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f && versionFor.current) sendVersion(versionFor.current, f); };
  // Dropping a file ON a file row is a new version of that file; anywhere
  // else in the panel it is still a new attachment.
  const rowDrop = (a) => (mayReplace(a) ? {
    onDragOver: (e) => { if (!e.dataTransfer?.types?.includes('Files')) return; e.preventDefault(); e.stopPropagation(); if (dropRow !== a.id) setDropRow(a.id); },
    onDragLeave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDropRow(''); },
    onDrop: (e) => {
      e.preventDefault(); e.stopPropagation();
      dragDepth.current = 0; setDragOver(false); setDropRow('');
      // The first file is the new version; any others are added as new
      // attachments, as a drop beside the row would add them - never dropped.
      const [first, ...rest] = Array.from(e.dataTransfer?.files || []);
      sendVersion(a, first);
      rest.forEach(sendFile);
    },
  } : {});

  const uploadSeq = useRef(0);
  const sendFile = (f) => {
    uploadSeq.current += 1;
    const key = `up-${uploadSeq.current}`;
    setUploads((u) => [...u, { key, name: f.name, pct: 0, file: f, error: '' }]);
    return uploadTaskAttachment(task.id, f, {}, (pct) => {
      setUploads((u) => u.map((x) => (x.key === key ? { ...x, pct } : x)));
    })
      .then(() => { setUploads((u) => u.filter((x) => x.key !== key)); reload(); refresh?.(); })
      .catch((e) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, error: e?.message || 'Upload failed.' } : x))));
  };
  const retryUpload = (u) => { setUploads((list) => list.filter((x) => x.key !== u.key)); sendFile(u.file); };
  const dismissUpload = (u) => setUploads((list) => list.filter((x) => x.key !== u.key));
  const onFile = (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) sendFile(f); };
  const onPaste = (e) => { if (!canAttach) return; const files = filesFromPaste(e); if (files.length) { e.preventDefault(); files.forEach(sendFile); } };
  // Asks first (a removed file is gone from the task for everyone) and says
  // so when the server refuses, instead of quietly re-reading the list.
  const del = async (a) => {
    const versioned = (a.versionCount || 1) > 1;
    const ok = await dialog.confirm(
      versioned
        ? `Remove version ${a.version} of "${a.name}"? The version before it becomes the current one. To remove the whole file, use Versions > Delete All Versions.`
        : `Remove "${a.name}" from this task?`,
      { title: versioned ? 'Remove Version' : 'Remove Attachment', confirmText: 'Remove', danger: true },
    );
    if (!ok) return;
    setDelError('');
    try {
      await api.deleteTaskAttachment(a.id);
    } catch (e) {
      setDelError(`Could not remove "${a.name}".${e?.message ? ` ${e.message}` : ''}`);
    }
    reload(); refresh?.();
  };
  const mayRemove = (a) => canRemoveAny || (!!a.addedBy && (a.addedBy || '').toLowerCase() === (myEmail || '').toLowerCase());

  // Drag-and-drop straight onto the tab, anywhere - not just onto the Attach
  // file button - matching Ctrl+V paste already working over the whole panel.
  const onDragEnter = (e) => { e.preventDefault(); dragDepth.current += 1; if (e.dataTransfer.types.includes('Files')) setDragOver(true); };
  const onDragOver = (e) => { e.preventDefault(); };
  const onDragLeave = (e) => { e.preventDefault(); dragDepth.current = Math.max(0, dragDepth.current - 1); if (dragDepth.current === 0) { setDragOver(false); setDropRow(''); } };
  const onDrop = (e) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragOver(false);
    setDropRow('');
    if (canAttach) Array.from(e.dataTransfer.files || []).forEach(sendFile);
  };

  return (
    <>
    <div onPaste={onPaste} onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}
      tabIndex={0} style={{
        marginTop: 14, borderRadius: 10, transition: 'background-color .12s ease',
        ...(dragOver ? { background: NX.hover || NX.border2, boxShadow: `0 0 0 2px ${NX.primary} inset` } : {}),
      }}>
      {canAttach && (
        <>
          <input ref={fileRef} type="file" multiple style={{ display: 'none' }} onChange={onFile} />
          <button onClick={() => fileRef.current?.click()} style={{ ...btn('outline'), borderStyle: 'dashed', fontSize: 12, marginBottom: 12 }}><Paperclip size={13} /> Attach File</button>
          <button type="button" onClick={() => setEgnyteOpen(true)} style={{ ...btn('outline'), fontSize: 12, marginBottom: 12, marginLeft: 8 }}><HardDrive size={13} /> Add From Egnyte</button>
          <span style={{ fontSize: 11, color: NX.faint, marginLeft: 8 }}>or drag a file in, or press Ctrl+V to paste a screenshot. Drop a file onto a file to upload a new version.</span>
          <input ref={versionRef} type="file" data-testid="version-input" style={{ display: 'none' }} onChange={onVersionFile} />
        </>
      )}
      {delError && <div role="alert" style={{ fontSize: 12, color: NX.red, marginBottom: 10 }}>{delError}</div>}
      {dragOver && canAttach && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '18px 12px', margin: '10px 0',
          border: `1.5px dashed ${NX.primary}`, borderRadius: 10, color: NX.primary, fontSize: 12.5, fontWeight: 600,
          pointerEvents: 'none',
        }}><Paperclip size={14} /> {dropRow ? 'Drop to upload a new version of that file' : 'Drop to attach'}</div>
      )}
      {(rows?.length || 0) === 0 && uploads.length === 0 ? (
        rows === null ? <LoadingState />
          : <div style={{ color: NX.faint, fontSize: 13, textAlign: 'center', padding: 20 }}>No attachments yet.</div>
      )
          : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {uploads.map((u) => (u.error ? (
                <div key={u.key} role="alert" data-testid="upload-failed" style={{ display: 'flex', alignItems: 'center', gap: 8, border: `1px solid ${NX.red}`, borderRadius: 10, padding: '6px 10px', fontSize: 12 }}>
                  <Paperclip size={13} style={{ color: NX.red }} />
                  <span style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: NX.ink }}>{u.name}</span>
                  <span style={{ color: NX.red, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={u.error}>Did not attach: {u.error}</span>
                  <button type="button" onClick={() => retryUpload(u)} style={{ ...btn('outline'), padding: '3px 8px', fontSize: 11.5 }}>Retry</button>
                  <button type="button" onClick={() => dismissUpload(u)} title="Dismiss" aria-label={`Dismiss ${u.name}`} style={{ ...btn('ghost'), padding: 3, color: NX.faint }}><X size={13} /></button>
                </div>
              ) : (
                <div key={u.key} style={{ display: 'flex', alignItems: 'center', gap: 8, border: `1px dashed ${NX.border}`, borderRadius: 10, padding: '6px 10px', fontSize: 12 }}>
                  <Paperclip size={13} style={{ color: NX.dim }} />
                  <span style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: NX.dim }}>{u.name}</span>
                  <span style={{ width: 90, height: 4, borderRadius: 2, background: NX.border2, overflow: 'hidden' }}>
                    <span style={{ display: 'block', height: '100%', width: '100%', background: NX.primary, transformOrigin: 'left', transform: `scaleX(${u.pct})`, transition: 'transform .15s linear' }} />
                  </span>
                  <span style={{ color: NX.faint, minWidth: 32, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{Math.round(u.pct * 100)}%</span>
                </div>
              )))}
              {(rows || []).map((a) => {
                if (isEgnyteLink(a)) {
                  return <EgnyteLinkRow key={a.id} a={a} onRemove={mayRemove(a) ? () => del(a) : null} />;
                }
                const href = a.dataUrl || a.url;
                const thumb = a.kind === 'image' && href
                  ? <img src={href} alt={a.name} style={{ width: 32, height: 32, borderRadius: 6, objectFit: 'cover' }} />
                  : <Paperclip size={13} style={{ color: NX.dim }} />;
                const nVersions = a.versionCount || 1;
                const up = verUploads[a.id];
                return (
                  <div key={a.id} data-testid="attachment-row" {...rowDrop(a)}
                    title={dropRow === a.id ? 'Drop to upload a new version' : undefined}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', maxWidth: '100%', border: `1px solid ${dropRow === a.id ? NX.primary : NX.border}`, borderRadius: 10, padding: '6px 10px', fontSize: 12,
                      ...(dropRow === a.id ? { boxShadow: `0 0 0 2px ${NX.primary} inset` } : null),
                    }}>
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
                    {(nVersions > 1 || (a.version || 1) > 1) && <VersionChip version={a.version} title={`Version ${a.version} of ${nVersions}`} />}
                    <span style={{ color: NX.faint }}>{a.size}</span>
                    {href && <a href={toDownloadUrl(href)} download={a.name} title="Download" style={{ color: NX.faint, display: 'flex' }}><Download size={13} /></a>}
                    {nVersions > 1 && (
                      <button type="button" onClick={() => setVersionsOf(a)} title="Versions" aria-label={`Versions of ${a.name}`}
                        style={{ ...btn('ghost'), padding: '3px 6px', fontSize: 11.5, color: NX.dim }}><History size={13} /> Versions</button>
                    )}
                    {mayReplace(a) && (
                      <button type="button" onClick={() => pickVersion(a)} disabled={!!up && !up.error} title="Upload New Version" aria-label={`Upload new version of ${a.name}`}
                        style={{ ...btn('ghost'), padding: 3, color: NX.faint }}><Upload size={13} /></button>
                    )}
                    {onShowOnCard && isCoverCandidate(a) && (() => {
                      // Any version of the picked file counts - the card shows its newest.
                      const onCard = [a.id, a.versionGroup].filter(Boolean).some((id) => task.cardPreviewMode === `${IMAGE_MODE}${id}`);
                      return (
                        <button type="button" onClick={() => onShowOnCard(onCard ? '' : `${IMAGE_MODE}${a.id}`)} aria-pressed={onCard}
                          title={onCard ? 'Shown on the board card - click to go back to Automatic' : 'Show On Card'}
                          aria-label={onCard ? `Stop showing ${a.name} on the card` : `Show ${a.name} on the card`}
                          style={{ ...btn('ghost'), padding: '3px 6px', fontSize: 11.5, color: onCard ? NX.blue : NX.dim }}>
                          <ImageIcon size={13} /> {onCard ? 'On Card' : 'Show On Card'}
                        </button>
                      );
                    })()}
                    {mayRemove(a) && <button onClick={() => del(a)} title="Remove" aria-label={`Remove ${a.name}`} style={{ ...btn('ghost'), padding: 3, color: NX.faint }}><X size={13} /></button>}
                    {up && !up.error && <span style={{ color: NX.faint, fontVariantNumeric: 'tabular-nums' }}>Uploading new version {Math.round(up.pct * 100)}%</span>}
                    {up?.error && (
                      <span role="alert" style={{ flexBasis: '100%', color: NX.red, display: 'flex', alignItems: 'center', gap: 6 }}>
                        {up.error}
                        <button type="button" onClick={() => setVerUploads((m) => { const n = { ...m }; delete n[a.id]; return n; })} title="Dismiss" aria-label="Dismiss" style={{ ...btn('ghost'), padding: 2, color: NX.faint }}><X size={12} /></button>
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
      {view && <AttachmentViewer att={view} onClose={() => setView(null)} />}
    </div>
    {/* Outside the panel: its paste / drop handlers must not see the dialogs' events. */}
      {versionsOf && (
        <VersionsModal att={versionsOf} onClose={() => setVersionsOf(null)} onChanged={() => { reload(); refresh?.(); }}
          canRemoveAny={canRemoveAny} myEmail={myEmail} nameOf={nameOf || ((e) => e)} />
      )}
      {egnyteOpen && <EgnyteLinkPicker taskId={task.id} onClose={() => setEgnyteOpen(false)} onAdded={() => { reload(); refresh?.(); }} />}
    </>
  );
}

// ── Subtasks ────────────────────────────────────────────────────────────────
/** A subtask row's people: its assignees as faces, and a click opens a
 *  searchable list to tick several on or off - right in the row, without
 *  opening the subtask (Oct 13 2026: it was one person, display only). */
// The subtask rows' people and date columns.
const SUB_PEOPLE_W = 64;
const SUB_DATE_W = 84;

function SubtaskAssignee({ subtask, people, updateTask, disabled = false }) {
  return <FacePicker value={taskAssignees(subtask)} people={people} label={`Assignees of ${subtask.title}`} disabled={disabled}
    onChange={(list) => updateTask(subtask.id, { assigneeIds: list })} />;
}

/** Faces, not names: who a subtask is for, in the width of a few avatars
 *  (Neil, Oct 14 2026 - the add row used a full-name picker). */
function FacePicker({ value, people, onChange, label, disabled = false }) {
  const [q, setQ] = useState('');
  const on = value || [];
  const filtered = matchPeople(people, q);
  const toggle = (email) => onChange(on.includes(email) ? on.filter((x) => x !== email) : [...on, email]);
  const nav = useListNav(filtered, { query: q, onPick: (p) => toggle(p.email) });
  return (
    <div onClick={(e) => e.stopPropagation()}>
      <Pop width={240} trigger={(t) => (
        <button type="button" onClick={() => { setQ(''); t(); }} aria-label={label} disabled={disabled}
          title={on.length ? `Assigned to ${on.length === 1 ? '1 person' : `${on.length} people`} - change` : 'Assign'}
          style={{ border: 'none', background: 'transparent', cursor: disabled ? 'default' : 'pointer', padding: 0, display: 'flex', alignItems: 'center' }}>
          {on.length
            ? on.slice(0, 3).map((em, i) => <span key={em} style={{ marginLeft: i ? -6 : 0 }}><Avatar email={em} size={20} card={false} /></span>)
            : <span style={{ width: 18, height: 18, borderRadius: '50%', border: `1px dashed ${NX.border}`, display: 'inline-block' }} />}
          {on.length > 3 && <span style={{ fontSize: 11, color: NX.faint, marginLeft: 3 }}>+{on.length - 3}</span>}
        </button>
      )}>
        {() => (
          <>
            <input className="nx-inline-edit" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people…"
              {...nav.inputProps} onKeyDown={nav.onKeyDown}
              style={{ width: '100%', boxSizing: 'border-box', border: 'none', borderBottom: `1px solid ${NX.border}`, padding: '6px 8px', fontSize: 13, fontFamily: FONT, color: NX.ink }} />
            {filtered.map((p, i) => (
              <label key={p.email} {...nav.optionProps(i)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', fontSize: 13, cursor: 'pointer' }}>
                <input type="checkbox" className="nx-check" checked={on.includes(p.email)} onChange={() => toggle(p.email)} />
                <Avatar email={p.email} name={p.name} size={18} card={false} />
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
              </label>
            ))}
            {filtered.length === 0 && <div style={{ padding: 8, fontSize: 12, color: NX.faint }}>No match</div>}
          </>
        )}
      </Pop>
    </div>
  );
}

// canAdd: may create subtasks here (a project editor - the server's create
// rule). canEditParent: may change the main task (its subtask order).
// canEditTask(s): may change that subtask (its own role; its assignees count).
// Opening a subtask is always allowed. Unknown roles keep every control.
function SubtasksTab({ task, subtasks, createTask, updateTask, people, onOpenSub, onMoveSub = null, hideHeading, canAdd = true, canEditParent = true, canEditTask = null }) {
  const rowEditable = (s) => (canEditTask ? canEditTask(s) : true);
  // Reordering writes every sibling's position and the main task's order.
  const canReorder = canEditParent && canAdd;
  const [title, setTitle] = useState('');
  const [dueOn, setDueOn] = useState('');
  // Who it is for: the main task's assignees until changed here.
  const [assignees, setAssignees] = useState(null);
  const [priority, setPriority] = useState('');
  // How it repeats: with the main task ({}) until changed in its calendar.
  const [rec, setRec] = useState({});
  const done = subtasks.filter((s) => s.completed).length;
  const forWhom = assignees ?? taskAssignees(task);
  const pri = priority || task.priority || 'medium';
  const mainRule = task.recurrence?.freq ? task.recurrence : null;
  const repeats = !!mainRule && !rec.skip;
  const subRepeat = (value, onChange, seedDate) => repeatOption({ value, seedDate, onChange, subtask: true, mainRule });
  const setSubRecurrence = (s, r) => updateTask(s.id, {
    recurrence: r, status: r?.freq ? 'recurring' : (s.status === 'recurring' ? 'not_started' : s.status),
  });

  // A new subtask is its main task's child (Neil, Oct 14 2026): it starts
  // with the main task's assignees, collaborators, project, team, priority
  // and field values (the Entity), and repeats with it - all changeable on
  // the subtask afterwards. No due date unless one is picked here.
  const add = async () => {
    const t = title.trim(); if (!t) return;
    await createTask({
      title: t, parentTaskId: task.id, projectId: task.projectId, teamId: task.teamId,
      followerIds: [...(task.followerIds || [])],
      customFieldValues: { ...(task.customFieldValues || {}) },
      assigneeIds: forWhom, dueOn, status: rec.freq ? 'recurring' : 'not_started', priority: pri, type: 'task',
      ...(rec.freq || rec.skip ? { recurrence: rec } : {}),
    }).catch((e) => alert(e?.message || 'Could not add the subtask.'));
    setTitle(''); setDueOn(''); setAssignees(null); setPriority(''); setRec({});
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
      {task.subtaskOrder === 'manual' && subtasks.length > 1 && canEditParent && (
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
            draggable={subtasks.length > 1 && canReorder}
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
            {subtasks.length > 1 && canReorder && (
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
            <button onClick={(e) => { e.stopPropagation(); updateTask(s.id, { completed: !s.completed }); }} disabled={!rowEditable(s)} aria-label={s.completed ? 'Mark Incomplete' : 'Mark Complete'} title={s.completed ? 'Mark Incomplete' : 'Mark Complete'} style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: NX.faint, display: 'flex', padding: 0 }}>
              {s.completed ? <CheckCircle2 size={15} style={{ color: NX.green }} /> : <Circle size={15} />}
            </button>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, color: s.completed ? NX.faint : NX.ink, textDecoration: s.completed ? 'line-through' : 'none' }}>{s.title}</span>
            {/* People, then the date, each in a fixed-width slot so every
                row lines up (Neil, Oct 14 2026: "people on the left, the
                date on the right"). */}
            <span style={{ width: SUB_PEOPLE_W, display: 'flex', justifyContent: 'flex-start', flexShrink: 0 }}>
              <SubtaskAssignee subtask={s} people={people} updateTask={updateTask} disabled={!rowEditable(s)} />
            </span>
            <span onClick={(e) => e.stopPropagation()} style={{ width: SUB_DATE_W, display: 'flex', justifyContent: 'flex-end', fontSize: 11.5, color: NX.faint, flexShrink: 0 }}>
              <DateField value={s.dueOn || ''} onChange={(v) => updateTask(s.id, { dueOn: v || '' })} compact disabled={!rowEditable(s)}
                title={s.dueOn ? 'Change due date' : 'Set due date'}
                repeat={subRepeat(s.recurrence, (r) => setSubRecurrence(s, r), s.dueOn)} />
            </span>
            {/* Move To... (Oct 22 2026): under another task, or up to the top. */}
            {onMoveSub && rowEditable(s) && !s.hrChecklist && (
              <button type="button" onClick={(e) => { e.stopPropagation(); onMoveSub(s.id); }}
                title="Move To..." aria-label={`Move ${s.title} to another task`}
                style={{ border: 'none', background: 'transparent', padding: 0, display: 'flex', color: NX.faint, cursor: 'pointer', flexShrink: 0 }}>
                <MoveRight size={14} />
              </button>
            )}
            <ChevronRight size={14} style={{ color: NX.faint, flexShrink: 0 }} />
          </div>
        ))}
      </div>
      {canAdd && <div data-testid="subtask-add" style={{ display: 'flex', alignItems: 'center', gap: 8, border: `1px dashed ${NX.border}`, borderRadius: 8, padding: '6px 10px' }}>
        <Plus size={14} style={{ color: NX.faint, flexShrink: 0 }} />
        <input className="nx-inline-edit" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} placeholder="Add subtask"
          style={{ flex: 1, minWidth: 0, border: 'none', fontFamily: FONT, fontSize: 13 }} />
        {/* A repeating main task brings its subtasks to every occurrence;
            the calendar's Repeat changes that for this one. */}
        {(repeats || rec.freq) && (
          <span title={repeatSummary(rec, { subtask: true, mainRule })} style={{ display: 'inline-flex', color: rec.freq ? NX.blue : NX.faint, flexShrink: 0 }}>
            <Repeat size={13} />
          </span>
        )}
        <Pop width={150} trigger={(t) => (
          <button type="button" onClick={t} title={`Priority: ${PRIORITY_META[pri]?.label || pri}`} aria-label="Priority"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 3, border: 'none', background: 'transparent', cursor: 'pointer', padding: 0, fontSize: 11.5, fontWeight: 600, fontFamily: FONT, color: PRIORITY_META[pri]?.color || NX.dim, flexShrink: 0 }}>
            {PRIORITY_META[pri]?.label || pri}<ChevronDown size={11} />
          </button>
        )}>
          {(close) => PRIORITY_ORDER.map((x) => <MenuItem key={x} onClick={() => { setPriority(x); close(); }}>{PRIORITY_META[x].label}</MenuItem>)}
        </Pop>
        <span style={{ width: SUB_PEOPLE_W, display: 'flex', flexShrink: 0 }}>
          <FacePicker value={forWhom} people={people} label="Assignees of the new subtask" onChange={setAssignees} />
        </span>
        {/* The Nexus calendar, the one every task date uses (Oct 13 2026) -
            it places itself on screen, flipping above when there is no room
            below. */}
        <span style={{ width: SUB_DATE_W, display: 'flex', justifyContent: 'flex-end', fontSize: 11.5, color: NX.faint, flexShrink: 0 }}>
          <DateField value={dueOn} onChange={(v) => setDueOn(v || '')} compact noPast title="Due Date"
            repeat={subRepeat(rec, (r) => setRec(r || {}), dueOn)} />
        </span>
        <button onClick={add} style={{ ...btn('primary'), padding: '6px 10px', fontSize: 12 }}>Add</button>
      </div>}
      {!canAdd && subtasks.length === 0 && <div style={{ fontSize: 12.5, color: NX.faint }}>No subtasks.</div>}
    </div>
  );
}

// ── Dependencies ────────────────────────────────────────────────────────────
function DependenciesTab({ blockedBy, blocking, task, removeDependency, readOnly = false }) {
  if (!blockedBy.length && !blocking.length) return <div style={{ color: NX.faint, fontSize: 13, textAlign: 'center', padding: 24 }}>No dependencies yet. Add one from the Overview tab.</div>;
  const line = (b, color, canRemove) => (
    <div key={b.id} style={{ display: 'flex', alignItems: 'center', gap: 8, background: NX.surface2, border: `1px solid ${NX.border}`, borderRadius: 8, padding: '7px 10px', fontSize: 12, marginBottom: 6 }}>
      <Link2 size={13} style={{ color }} />
      <span style={{ flex: 1, color: NX.ink }}>{b.title}</span>
      {b.dependencyType && DEP_TYPES[b.dependencyType] && <span style={{ color: NX.faint }}>{b.dependencyType}</span>}
      {canRemove && <button onClick={() => removeDependency(b.id)} aria-label={`Remove dependency on ${b.title}`} title="Remove Dependency" style={{ ...btn('ghost'), padding: 2, color: NX.faint }}><X size={13} /></button>}
    </div>
  );
  return (
    <div style={{ marginTop: 14 }}>
      {blockedBy.length > 0 && <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: NX.faint, marginBottom: 6 }}>Blocked by</div>
        {blockedBy.map((b) => line({ ...b, dependencyType: (task.dependencyTypes || {})[b.id] }, NX.red, !readOnly))}
      </div>}
      {blocking.length > 0 && <div>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: NX.faint, marginBottom: 6 }}>Blocking</div>
        {blocking.map((b) => line(b, NX.amber, false))}
      </div>}
    </div>
  );
}

// ── Properties ──────────────────────────────────────────────────────────────
/** "Section" - file the task under one of its project's Custom sections
 *  from the task itself (Oct 13 2026), the per-task way to do what the batch
 *  bar's Move to Section does for many. Shown only when the project has
 *  sections; a section the project no longer offers reads as No Section. */
function TaskSectionRow({ task, patch }) {
  const sec = useCustomSections(task.projectId || '__none__');
  if (!task.projectId || !sec.sections.length) return null;
  const current = sec.sections.some((x) => x.id === task.sectionId) ? task.sectionId : '';
  return (
    <Row label="Section" history="sectionId">
      <select value={current} aria-label="Section" onChange={(e) => patch({ sectionId: e.target.value })}
        style={{ ...inputStyle, width: 'auto', minWidth: 180, padding: '5px 8px', fontSize: 13, cursor: 'pointer' }}>
        <option value="">No Section</option>
        {sec.sections.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
      </select>
    </Row>
  );
}

/** One row per custom field the task carries (fieldsForTask): a column in
 *  any project it is in, or one used everywhere. A field one of those
 *  projects requires is starred, and flagged while it is still empty -
 *  worked out from the projects the task is in NOW, so moving it out of
 *  the project drops the requirement (Oct 13 2026). */
// A formula column on the task (Oct 22 2026): its computed value, read-only.
function FormulaFieldRow({ task, field, customFields }) {
  const store = useTasks();
  const engine = formulaEngineFor({ customFields, taskById: store?.taskById, nameOf: store?.nameOf });
  return (
    <Row label={field.name}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <FormulaValue task={task} field={field} engine={engine} align="left" size={13} />
        <Sigma size={11} style={{ color: NX.faint }} aria-label="Calculated by a formula" />
      </span>
    </Row>
  );
}

export function TaskCustomFieldRows({ task, customFields, projectName, patch }) {
  const fields = fieldsForTask(customFields, task);
  if (!fields.length) return null;
  const values = task.customFieldValues || {};
  return fields.map((f) => {
    if (f.type === 'formula') return <FormulaFieldRow key={f.id} task={task} field={f} customFields={customFields} />;
    const by = requiredByProjectsOf(f, task);
    const missing = by.length > 0 && isBlankValue(values[f.id]);
    const where = by.filter(Boolean).map((pid) => projectName(pid)).filter(Boolean).join(', ');
    return (
      <Row key={f.id} label={<>{f.name}{by.length > 0 && <span style={{ color: NX.red }}> *</span>}</>}
        history={f.readOnly ? undefined : f.id} historyLabel={f.name}>
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

// Properties rows whose changes are recorded (task_history.py) -> the field key(s).
const PROPERTY_HISTORY = {
  Status: 'status', Priority: 'priority', Assignee: 'assigneeIds', Projects: 'projectId,projectIds',
  'Start Date': 'startOn', 'Due Date': 'dueOn', Estimate: 'estimateHours', Milestone: 'isMilestone',
  Approval: 'approvalStatus',
};

function PropertiesTab({ task, nameOf, projectName, teamName, customFields, patch, readOnly = false }) {
  // The same fields the Overview shows (fieldsForTask) - not every field
  // defined anywhere in the workspace.
  const activeFields = fieldsForTask(customFields, task);
  const { statusMeta, projects = [], tasks: allTasks = [] } = useTasks();
  const tracksTime = taskTracksTime(task, projects, allTasks);
  const sm = statusMeta[task.status] || {};
  const pm = PRIORITY_META[task.priority] || {};
  const rows = [
    ['Status', <StatusLabel label={sm.label} color={sm.color} />],
    ['Priority', <PrioritySignal priority={task.priority} />],
    ['Assignee', taskAssignees(task).length
      ? <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          {taskAssignees(task).map((e) => (
            <span key={e} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Avatar email={e} name={nameOf(e)} size={18} /> {nameOf(e)}
            </span>
          ))}
        </span>
      : 'Unassigned'],
    ['Projects', [task.projectId, ...(task.projectIds || [])].filter(Boolean).map((id) => projectName(id) || id).join(', ') || '-'],
    ['Team', task.teamId ? teamName(task.teamId) : '-'],
    ['Start Date', fmtDate(task.startOn)],
    ['Due Date', fmtDate(task.dueOn)],
    ...(tracksTime ? [
      ['Estimate', task.estimateHours != null ? fmtHours(task.estimateHours) : '-'],
      ['Actual', task.actualHours != null ? fmtHours(task.actualHours) : '-'],
    ] : []),
    ['Milestone', task.isMilestone ? 'Yes' : 'No'],
    ['Approval', !task.approvalStatus || task.approvalStatus === 'none' ? '-' : approvalLabel(task.approvalStatus)],
    ['Recurrence', recurrenceLabel(task.recurrence)],
    ['Created', fmtDate(task.createdAt)],
    ['Modified', fmtDate(task.modifiedAt)],
  ];
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ border: `1px solid ${NX.border}`, borderRadius: 12, overflow: 'hidden' }}>
        {rows.map(([label, value], i) => (
          <div key={label} className={PROPERTY_HISTORY[label] ? 'nx-hist-row' : undefined} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 12px', fontSize: 13, borderTop: i ? `1px solid ${NX.border}` : 'none' }}>
            <span style={{ width: 112, flexShrink: 0, color: NX.faint, display: 'flex', alignItems: 'center', gap: 2 }}>
              {label}
              {PROPERTY_HISTORY[label] && <FieldHistoryButton field={PROPERTY_HISTORY[label]} label={label} />}
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8, color: NX.ink }}>{value}</span>
          </div>
        ))}
        <div className="nx-hist-row" style={{ display: 'flex', gap: 12, padding: '9px 12px', fontSize: 13, borderTop: `1px solid ${NX.border}` }}>
          <span style={{ width: 112, flexShrink: 0, color: NX.faint, paddingTop: 2, display: 'flex', alignItems: 'flex-start', gap: 2 }}>
            Labels <FieldHistoryButton field="tags" label="Labels" />
          </span>
          <FieldsLock readOnly={readOnly}><LabelsEditor tags={task.tags || []} onChange={(tags) => patch({ tags })} /></FieldsLock>
        </div>
      </div>

      {activeFields.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: NX.ink, marginBottom: 8 }}>Custom Fields</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <FieldsLock readOnly={readOnly}><TaskCustomFieldRows task={task} customFields={customFields} projectName={projectName} patch={patch} /></FieldsLock>
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
          <button onClick={() => onChange(tags.filter((x) => x !== t))} aria-label={`Remove label ${t}`} title="Remove Label" style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: NX.faint, padding: 0, display: 'flex' }}><X size={11} /></button>
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
      <span title={field.type === 'formula' ? 'Calculated by a formula - not editable' : 'Calculated in Asana - not editable here'}
        style={{ fontSize: 13, color: NX.dim, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        {field.type === 'formula' ? '-' : (value || '-')}
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
    // One dropdown, not a palette of every option as a chip (Neil, Oct 15
    // 2026: a long Trade list filled the task card). The chosen options sit
    // inside the trigger and the menu is a searchable checkbox list, the
    // same control the project pickers use.
    const opts = field.options.map((o) => (typeof o === 'string' ? { id: o, label: o } : { id: o.id, label: o.label }));
    return (
      <div style={{ minWidth: 220, maxWidth: 420, flex: 1 }}>
        <ChipMultiSelect value={Array.isArray(value) ? value : []} onChange={onChange} options={opts}
          placeholder="-" emptyText="No options" />
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
  // A date field is the shared DateField (Oct 21 2026), never a native date
  // box - that one shows the computer's region format (20-10-2026).
  if (field.type === 'date') {
    return (
      <DateField value={typeof v === 'string' ? v : ''} placeholder="-" title={field.name || 'Set date'}
        onChange={(d) => { setV(d || ''); onChange(d || ''); }}
        style={{ ...inputStyle, width: 'auto', minWidth: 180, padding: '6px 9px', fontSize: 13, cursor: 'pointer' }} />
    );
  }
  return (
    <input type={field.type === 'number' ? 'number' : 'text'} value={v}
      onChange={(e) => setV(e.target.value)} onBlur={() => onChange(v)}
      style={{ ...inputStyle, width: 'auto', minWidth: 180, padding: '6px 9px', fontSize: 13 }} />
  );
}

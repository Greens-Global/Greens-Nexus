// Task Module - the Task Detail drawer: a right-side, resizable, tabbed panel
// (Overview / Comments / Activity / Attachments / Subtasks / Dependencies /
// Properties). Ported from the export's features/task-detail/* (24 files) into a
// single consolidated file matching this module's inline-style idiom, wired to
// the real TasksContext store + api.js instead of the export's mocked Zustand store.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeft, ArrowRightToLine, CheckCircle2, Circle, ChevronDown, ChevronRight,
  ChevronLeft, Diamond, Repeat, ThumbsUp, Trash2, Link2, X, Clock, ShieldCheck,
  Paperclip, Download, Pin, Pencil, Plus, CalendarDays, Maximize2, Minimize2,
  RotateCcw, ThumbsDown, Share2, MoreHorizontal, UserPlus, Globe, Lock, Check, Ban,
} from 'lucide-react';
import { api } from '../api';
import { useTasks } from './TasksContext';
import { fmtDate as fmtDateRaw, fmtDateTime, filesFromPaste, parseImportedAuthor, fmtHours, teamInProject, fieldsForProject, fieldOption, richBodyHtml, uploadTaskAttachment } from './lib';

// Drawer shows an em-dash for an unset date rather than an empty cell.
const fmtDate = (iso) => (iso ? fmtDateRaw(iso) : '-');
import { NX, FONT, btn, input as inputStyle, STATUS_META, STATUS_ORDER, PRIORITY_META, PRIORITY_ORDER } from './theme';
import { Avatar, PersonSelect, PersonMultiSelect, usePeople, useIsMobile, DateField, AttachmentViewer } from './components';
import RichDescription, { isEmptyDoc } from './RichDescription';
import ProjectPicker from './ProjectPicker';

const DEP_TYPES = { FS: 'Finish → Start', SS: 'Start → Start', FF: 'Finish → Finish', SF: 'Start → Finish' };
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function recurrenceLabel(r) {
  if (!r || !r.freq) return 'Does not repeat';
  let base;
  if (r.freq === 'daily') base = 'Every day';
  else if (r.freq === 'weekly') base = `Every week on ${DAYS[r.dayOfWeek ?? 1]}`;
  else if (r.freq === 'monthly') base = `Every month on day ${r.dayOfMonth ?? 1}`;
  else if (r.freq === 'yearly') base = 'Every year';
  else return 'Does not repeat';
  if (r.until) base += ` until ${r.until}`;
  else if (r.count) base += ` × ${r.count}`;
  return base;
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
// Lightweight popover anchored under its trigger; closes on outside click / Esc.
// Opens left-aligned, but flips to right-aligned when that would run past the
// viewport's right edge - a trigger near the edge (the header's "more actions")
// otherwise pushes the panel off-screen, which is unreachable on a phone.
function Pop({ trigger, children, width = 200 }) {
  const [open, setOpen] = useState(false);
  const [flip, setFlip] = useState(false);
  const ref = useRef(null);
  const panelRef = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);
  useLayoutEffect(() => {
    if (!open) { setFlip(false); return; }
    const el = panelRef.current;
    if (!el) return;
    setFlip(el.getBoundingClientRect().right > window.innerWidth - 8);
  }, [open]);
  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
      {trigger(() => setOpen((o) => !o))}
      {open && (
        <div ref={panelRef} style={{ position: 'absolute', top: '100%', left: flip ? 'auto' : 0, right: flip ? 0 : 'auto', marginTop: 4, width, maxWidth: 'calc(100vw - 16px)', background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,0.16)', zIndex: 60, padding: 4, maxHeight: 300, overflowY: 'auto' }}>
          {children(() => setOpen(false))}
        </div>
      )}
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
      <input
        autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a task…"
        style={{ width: '100%', border: 'none', borderBottom: `1px solid ${NX.border}`, padding: '7px 9px', marginBottom: 4, fontSize: 13, outline: 'none', fontFamily: FONT, boxSizing: 'border-box', background: 'transparent', color: NX.ink }}
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
  const [hover, setHover] = useState(false);
  return (
    <button onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '7px 9px',
      borderRadius: 7, border: 'none', cursor: 'pointer', fontSize: 13, fontFamily: FONT,
      color: danger ? NX.red : NX.ink, background: hover ? NX.hover : 'transparent',
    }}>{icon}{children}</button>
  );
}

// `initialTab` lets a caller open the drawer straight onto the tab that made
// them open it - the Replies log opens a task because a comment arrived by
// email, and landing on Overview would leave the reader to go find it.
// Defaults to Overview, so every existing caller behaves exactly as before.
export default function TaskDetailDrawer({ taskId, onClose, onEdit, initialTab = 'overview' }) {
  const store = useTasks();
  const { taskById, tasks, teams, projects, projectName, teamName, nameOf, myEmail, customFields = [], updateTask, deleteTask, createTask, getComments, addComment } = store;
  const people = usePeople();

  const [activeId, setActiveId] = useState(taskId);
  useEffect(() => setActiveId(taskId), [taskId]);
  const [tab, setTab] = useState(initialTab);
  useEffect(() => setTab(initialTab), [activeId, initialTab]);
  const [shareOpen, setShareOpen] = useState(false);

  const task = taskById[activeId];

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
  const subtasks = useMemo(() => tasks.filter((t) => t.parentTaskId === activeId), [tasks, activeId]);
  const blockedBy = useMemo(() => (task?.blockedByIds || []).map((id) => taskById[id]).filter(Boolean), [task, taskById]);
  const blocking = useMemo(() => (task?.blockingIds || []).map((id) => taskById[id]).filter(Boolean), [task, taskById]);
  const depCandidates = useMemo(
    () => tasks.filter((t) => t.id !== activeId && !t.parentTaskId && t.projectId === task?.projectId && !(task?.blockedByIds || []).includes(t.id)),
    [tasks, activeId, task],
  );

  if (!task) return null;
  // Shared the moment the task has a project or a collaborator - the same rule
  // My Tasks used for its Task Visibility column before that column was removed
  // in favor of this indicator.
  const shared = (task.followerIds || []).length > 0 || !!task.projectId;
  const patch = (p) => updateTask(activeId, p);

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
          subtasks={subtasks} createTask={createTask} updateTask={updateTask} onOpenSub={setActiveId}
          nameOf={nameOf} myEmail={myEmail} getComments={getComments} addComment={addComment} refresh={store.refresh}
          onViewAllComments={() => setTab('comments')}
        />
      );
      case 'comments':     return <CommentsTab task={task} nameOf={nameOf} myEmail={myEmail} getComments={getComments} addComment={addComment} />;
      case 'activity':     return <ActivityTab taskId={activeId} nameOf={nameOf} />;
      case 'attachments':  return <AttachmentsTab task={task} refresh={store.refresh} />;
      case 'subtasks':     return <SubtasksTab task={task} subtasks={subtasks} createTask={createTask} updateTask={updateTask} people={people} onOpenSub={setActiveId} />;
      case 'dependencies': return <DependenciesTab blockedBy={blockedBy} blocking={blocking} task={task} removeDependency={removeDependency} />;
      case 'properties':   return <PropertiesTab task={task} nameOf={nameOf} projectName={projectName} teamName={teamName} customFields={customFields} patch={patch} />;
      default:             return null;
    }
  };

  return createPortal(
    <div className="nx-tasks-portal" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} style={{ position: 'fixed', inset: 0, zIndex: 3500, fontFamily: FONT }}>
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
            <button onClick={() => store.toggleComplete(task)} title={task.completed ? 'Completed' : 'Mark complete'}
              style={{ ...btn('outline'), padding: isMobile ? 7 : '6px 10px', fontSize: 12, color: task.completed ? NX.green : NX.dim }}>
              {task.completed ? <CheckCircle2 size={15} style={{ color: NX.green }} /> : <Circle size={15} />}
              {!isMobile && (task.completed ? 'Completed' : 'Mark complete')}
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
                  <MenuItem icon={<Diamond size={14} style={{ color: task.isMilestone ? NX.purple : undefined }} />} onClick={() => { patch({ isMilestone: !task.isMilestone }); close(); }}>
                    {task.isMilestone ? 'Unmark milestone' : 'Mark as milestone'}
                  </MenuItem>
                  <MenuItem danger icon={<Trash2 size={14} />} onClick={() => { close(); if (window.confirm(`Delete "${task.title}" and its subtasks?`)) { deleteTask(activeId); onClose(); } }}>
                    Delete task
                  </MenuItem>
                </>
              )}
            </Pop>
            <button onClick={onClose} title="Close" style={{ ...btn('ghost'), padding: 7, color: NX.faint }}><ArrowRightToLine size={18} /></button>
          </div>
        </div>

        {/* title + tabs */}
        <div style={{ padding: '14px 18px 0', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12 }}>
            {task.parentTaskId && (
              <button onClick={() => setActiveId(task.parentTaskId)} title="Back to main task" style={{ ...btn('ghost'), padding: 4, color: NX.faint }}><ArrowLeft size={18} /></button>
            )}
            <TitleInput key={activeId} value={task.title} completed={task.completed} onCommit={(v) => v.trim() && v !== task.title && patch({ title: v.trim() })} />
          </div>
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
      </aside>
    </div>,
    document.body,
  );
}

// ── Members (collaborators) menu ─────────────────────────────────────────────
// Shared by MembersMenu below and the Properties tab's own Collaborators row -
// they were two copies of the same unfiltered checkbox list, easy to miss a
// search box on one and not the other. One body, used by both triggers.
function CollaboratorMenuBody({ people, selected, onToggle }) {
  const [q, setQ] = useState('');
  const filtered = q.trim()
    ? people.filter((u) => `${u.name} ${u.email}`.toLowerCase().includes(q.trim().toLowerCase()))
    : people;
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: NX.faint, padding: '4px 6px' }}>Collaborators</div>
      <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people…"
        style={{ width: '100%', boxSizing: 'border-box', border: 'none', borderBottom: `1px solid ${NX.border}`, padding: '6px 8px', fontSize: 13, outline: 'none', fontFamily: FONT, background: 'transparent', color: NX.ink }} />
      <div className="nx-scroll" style={{ maxHeight: 220, overflowY: 'auto' }}>
        {filtered.map((u) => (
          <label key={u.email} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', fontSize: 13, cursor: 'pointer' }}>
            <input type="checkbox" checked={selected.includes(u.email)} onChange={() => onToggle(u.email)} />
            <Avatar email={u.email} name={u.name} size={20} card={false} /> {u.name}
          </label>
        ))}
        {filtered.length === 0 && <div style={{ padding: 8, fontSize: 12, color: NX.faint }}>{people.length === 0 ? 'No people' : 'No match'}</div>}
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
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: NX.faint, padding: '4px 6px' }}>Also in Project</div>
      <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search projects…"
        style={{ width: '100%', boxSizing: 'border-box', border: 'none', borderBottom: `1px solid ${NX.border}`, padding: '6px 8px', fontSize: 13, outline: 'none', fontFamily: FONT, background: 'transparent', color: NX.ink }} />
      <div className="nx-scroll" style={{ maxHeight: 220, overflowY: 'auto' }}>
        {filtered.map((p) => (
          <button key={p.id} type="button" onClick={() => onPick(p.id)} style={{ display: 'flex', width: '100%', textAlign: 'left', alignItems: 'center', gap: 8, padding: '6px 8px', fontSize: 13, border: 'none', background: 'transparent', cursor: 'pointer', color: NX.ink, fontFamily: FONT }}>
            {p.name}
          </button>
        ))}
        {filtered.length === 0 && <div style={{ padding: 8, fontSize: 12, color: NX.faint }}>{needle ? 'No match' : 'No other projects'}</div>}
      </div>
    </div>
  );
}

function MembersMenu({ task, people, nameOf, patch }) {
  const followers = task.followerIds || [];
  const toggle = (email) => patch({ followerIds: followers.includes(email) ? followers.filter((e) => e !== email) : [...followers, email] });
  return (
    <div style={{ display: 'flex', alignItems: 'center' }}>
      {followers.slice(0, 3).map((em, i) => <span key={em} style={{ marginLeft: i ? -6 : 0 }}><Avatar email={em} name={nameOf(em)} size={24} /></span>)}
      <Pop width={230} trigger={(t) => (
        <button onClick={t} title="Collaborators" style={{ ...btn('ghost'), padding: 5, marginLeft: followers.length ? 2 : 0, color: NX.faint }}><UserPlus size={16} /></button>
      )}>
        {() => <CollaboratorMenuBody people={people} selected={followers} onToggle={toggle} />}
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
      style={{ width: '100%', border: 'none', background: 'transparent', outline: 'none', fontFamily: FONT, fontSize: 20, fontWeight: 700, color: completed ? NX.faint : NX.ink, textDecoration: completed ? 'line-through' : 'none' }}
    />
  );
}

// ── Overview ────────────────────────────────────────────────────────────────
function OverviewTab({ task, patch, people, projectName, teamName, teams, projects, blockedBy, depCandidates, addDependency, removeDependency, setDependencyType, subtasks, createTask, updateTask, onOpenSub, nameOf, myEmail, getComments, addComment, refresh, onViewAllComments }) {
  const isMobile = useIsMobile();
  const { statusMeta, statusOrder, statusOrderFor } = useTasks();
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
          <PersonSelect value={task.assigneeId || null} people={people} onChange={(email) => patch({ assigneeId: email || '' })} />
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
          {() => <CollaboratorMenuBody people={people} selected={followers} onToggle={toggleFollower} />}
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

      <Row label="Due Date">
        <DateField value={task.dueOn || ''} onChange={(v) => patch({ dueOn: v || '' })} style={{ ...inputStyle, width: 'auto', padding: '6px 9px', fontSize: 12 }} />
      </Row>

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
          <Pop width={220} trigger={(t) => (
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
          <Pop width={200} trigger={(t) => <button onClick={() => { setRecStep('root'); t(); }} style={{ ...btn('ghost'), padding: '5px 8px', fontSize: 12 }}><Repeat size={13} /> {recurrenceLabel(task.recurrence)}</button>}>
            {(close) => {
              if (recStep === 'weekly') return (<>
                <MenuItem icon={<ChevronLeft size={14} />} onClick={() => setRecStep('root')}>Back</MenuItem>
                {DAYS.map((d, i) => <MenuItem key={d} onClick={() => { pickFreq({ freq: 'weekly', dayOfWeek: i }); close(); }}>{d}</MenuItem>)}
              </>);
              if (recStep === 'monthly') return (<>
                <MenuItem icon={<ChevronLeft size={14} />} onClick={() => setRecStep('root')}>Back</MenuItem>
                {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => <MenuItem key={d} onClick={() => { pickFreq({ freq: 'monthly', dayOfMonth: d }); close(); }}>Day {d}</MenuItem>)}
              </>);
              return (<>
                <MenuItem onClick={() => { setRecEndMode('never'); setRecurrence(null); close(); }}>Does not repeat</MenuItem>
                <MenuItem onClick={() => { pickFreq({ freq: 'daily' }); close(); }}>Every day</MenuItem>
                <MenuItem onClick={() => setRecStep('weekly')}>Every week</MenuItem>
                <MenuItem onClick={() => setRecStep('monthly')}>Every month</MenuItem>
                <MenuItem onClick={() => { pickFreq({ freq: 'yearly' }); close(); }}>Every year</MenuItem>
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
      <Section defaultOpen={false} title={subtasks?.length ? `Subtasks ${subtasks.filter((s) => s.completed).length}/${subtasks.length}` : 'Subtasks'}>
        <SubtasksTab task={task} subtasks={subtasks || []} createTask={createTask} updateTask={updateTask} people={people} onOpenSub={onOpenSub} hideHeading />
      </Section>

      {/* Time tracking */}
      <Section defaultOpen={false} title="Time Tracking">
        <TimeTracking task={task} patch={patch} />
      </Section>

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

// Paperclip button + hidden file input + staged-file chips, shown above a
// composer's Send button. Files aren't uploaded here - a comment_id is
// required to link them (see uploadPendingAttachments), and the comment
// doesn't exist yet while its composer is still open.
function PendingAttachments({ files, setFiles }) {
  const fileRef = useRef(null);
  const onFile = (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) setFiles((p) => [...p, f]); };
  const remove = (i) => setFiles((p) => p.filter((_, j) => j !== i));
  if (!files.length) {
    return (
      <>
        <input ref={fileRef} type="file" style={{ display: 'none' }} onChange={onFile} />
        <button type="button" onClick={() => fileRef.current?.click()} title="Attach file"
          style={{ ...btn('ghost'), padding: 5, color: NX.faint }}><Paperclip size={13} /></button>
      </>
    );
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
      <input ref={fileRef} type="file" style={{ display: 'none' }} onChange={onFile} />
      <button type="button" onClick={() => fileRef.current?.click()} title="Attach another file"
        style={{ ...btn('ghost'), padding: 5, color: NX.faint }}><Paperclip size={13} /></button>
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
        />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 8, gap: 8 }}>
        <PendingAttachments files={pending} setFiles={setPending} />
        <button onClick={submit} disabled={isEmptyDoc(body) || busy}
          style={{ ...btn('primary'), opacity: (isEmptyDoc(body) || busy) ? 0.5 : 1, flexShrink: 0 }}>
          {busy ? 'Posting…' : 'Comment'}
        </button>
      </div>
      <div style={{ fontSize: 11, color: NX.faint, marginTop: 4 }}>
        Type <b>@</b> to mention someone - they'll get an email. ⌘/Ctrl+Enter to post.
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
          mentionPeople={people} minHeight={64} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
          <span style={{ fontSize: 11, color: NX.faint }}>
            Type <b>@</b> to mention someone - they'll get an email.
          </span>
          <PendingAttachments files={pending} setFiles={setPending} />
          <button onClick={submit} disabled={isEmptyDoc(body)}
            style={{ ...btn('primary'), marginLeft: 'auto', opacity: isEmptyDoc(body) ? 0.5 : 1 }}>Send</button>
        </div>
      </div>
      {comments === null ? <div style={{ color: NX.faint, fontSize: 13, textAlign: 'center', padding: 20 }}>Loading…</div>
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
          <div className="nx-rich-view" style={{ marginTop: 2, color: NX.dim }}
            dangerouslySetInnerHTML={{ __html: richBodyHtml(displayBody, nameOf) }} />
        )}
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
  if (rows === null) return <div style={{ color: NX.faint, fontSize: 13, textAlign: 'center', padding: 24 }}>Loading…</div>;
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
        marginTop: 14, outline: 'none', borderRadius: 10, transition: 'background-color .12s ease',
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
        rows === null ? <div style={{ color: NX.faint, fontSize: 13, textAlign: 'center', padding: 20 }}>Loading…</div>
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
                    {href && <a href={href} download={a.name} title="Download" style={{ color: NX.faint, display: 'flex' }}><Download size={13} /></a>}
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

  const add = async () => {
    const t = title.trim(); if (!t) return;
    await createTask({ title: t, parentTaskId: task.id, projectId: task.projectId, teamId: task.teamId, assigneeId, dueOn, status: 'not_started', priority: 'medium', type: 'task' }).catch(() => {});
    setTitle(''); setDueOn(''); setAssigneeId('');
  };

  return (
    <div style={{ marginTop: hideHeading ? 0 : 14 }}>
      {!hideHeading && <div style={{ fontSize: 13, fontWeight: 700, color: NX.ink, marginBottom: 10 }}>{subtasks.length ? `Subtasks ${done}/${subtasks.length}` : 'Subtasks'}</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 10 }}>
        {subtasks.map((s) => (
          <div key={s.id} onClick={() => onOpenSub(s.id)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 6px', borderRadius: 8, cursor: 'pointer' }}
            onMouseEnter={(e) => (e.currentTarget.style.background = NX.hover)} onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
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
        <input value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} placeholder="Add subtask"
          style={{ flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent', fontFamily: FONT, fontSize: 13 }} />
        {dueOn && <span style={{ fontSize: 11, color: NX.faint }}>{fmtDate(dueOn)}</span>}
        <button onClick={() => dateRef.current?.showPicker?.() ?? dateRef.current?.focus()} title="Due Date" style={{ ...btn('ghost'), padding: 4, color: NX.faint }}><CalendarDays size={15} /></button>
        <input ref={dateRef} type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} style={{ position: 'absolute', width: 0, height: 0, opacity: 0 }} tabIndex={-1} />
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
function PropertiesTab({ task, nameOf, projectName, teamName, customFields, patch }) {
  // Fields scoped to this task's project (plus global ones) - not every field
  // defined anywhere in the workspace.
  const activeFields = fieldsForProject(customFields, task.projectId);
  const { statusMeta } = useTasks();
  const sm = statusMeta[task.status] || {};
  const pm = PRIORITY_META[task.priority] || {};
  const rows = [
    ['Status', <Chip color={sm.color} tint={sm.tint}>{sm.label}</Chip>],
    ['Priority', <Chip color={pm.color} tint={pm.tint}>{pm.label}</Chip>],
    ['Assignee', task.assigneeId ? <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Avatar email={task.assigneeId} name={nameOf(task.assigneeId)} size={18} /> {nameOf(task.assigneeId)}</span> : 'Unassigned'],
    ['Project', task.projectId ? projectName(task.projectId) : '-'],
    ['Also In', (task.projectIds || []).length ? task.projectIds.map((id) => projectName(id) || id).join(', ') : '-'],
    ['Team', task.teamId ? teamName(task.teamId) : '-'],
    ['Start Date', fmtDate(task.startOn)],
    ['Due Date', fmtDate(task.dueOn)],
    ['Estimate', task.estimateHours != null ? fmtHours(task.estimateHours) : '-'],
    ['Actual', task.actualHours != null ? fmtHours(task.actualHours) : '-'],
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
            {activeFields.map((f) => (
              <Row key={f.id} label={f.name}>
                <CustomFieldInput field={f} value={(task.customFieldValues || {})[f.id]} onChange={(v) => patch({ customFieldValues: { ...(task.customFieldValues || {}), [f.id]: v } })} />
              </Row>
            ))}
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
      <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} onBlur={add}
        placeholder="Add label…" style={{ border: 'none', outline: 'none', background: 'transparent', fontFamily: FONT, fontSize: 12, width: 100, color: NX.ink }} />
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

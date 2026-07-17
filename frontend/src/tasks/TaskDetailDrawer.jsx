// Task Module — the Task Detail drawer: a right-side, resizable, tabbed panel
// (Overview / Comments / Activity / Attachments / Subtasks / Dependencies /
// Properties). Ported from the export's features/task-detail/* (24 files) into a
// single consolidated file matching this module's inline-style idiom, wired to
// the real TasksContext store + api.js instead of the export's mocked Zustand store.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeft, ArrowRightToLine, CheckCircle2, Circle, ChevronDown, ChevronRight,
  ChevronLeft, Diamond, Repeat, ThumbsUp, Trash2, Link2, X, Clock, ShieldCheck,
  Paperclip, Download, Pin, Pencil, Plus, CalendarDays, Maximize2, Minimize2,
  RotateCcw, ThumbsDown, Share2, MoreHorizontal, UserPlus, Globe, Lock, Check,
} from 'lucide-react';
import { api } from '../api';
import { useTasks } from './TasksContext';
import { fmtDate as fmtDateRaw, fmtDateTime } from './lib';

// Drawer shows an em-dash for an unset date rather than an empty cell.
const fmtDate = (iso) => (iso ? fmtDateRaw(iso) : '—');
import { NX, FONT, btn, input as inputStyle, STATUS_META, STATUS_ORDER, PRIORITY_META, PRIORITY_ORDER } from './theme';
import { Avatar, PersonSelect, usePeople, useIsMobile, DateField } from './components';

const DEP_TYPES = { FS: 'Finish → Start', SS: 'Start → Start', FF: 'Finish → Finish', SF: 'Start → Finish' };
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function recurrenceLabel(r) {
  if (!r || !r.freq) return 'Does not repeat';
  let base;
  if (r.freq === 'daily') base = 'Every day';
  else if (r.freq === 'weekly') base = `Every week on ${DAYS[r.dayOfWeek ?? 1]}`;
  else if (r.freq === 'monthly') base = `Every month on day ${r.dayOfMonth ?? 1}`;
  else return 'Does not repeat';
  if (r.until) base += ` until ${r.until}`;
  else if (r.count) base += ` × ${r.count}`;
  return base;
}

// ── tiny inline primitives ───────────────────────────────────────────────────
function Section({ title, children }) {
  return (
    <div style={{ marginTop: 18, borderTop: `1px solid ${NX.border}`, paddingTop: 15 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 9, fontSize: 13, fontWeight: 700, color: NX.ink }}>
        <ChevronDown size={14} style={{ color: NX.faint }} /> {title}
      </div>
      {children}
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
// viewport's right edge — a trigger near the edge (the header's "more actions")
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

export default function TaskDetailDrawer({ taskId, onClose, onEdit }) {
  const store = useTasks();
  const { taskById, tasks, projectName, deptName, nameOf, myEmail, customFields = [], updateTask, deleteTask, createTask, getComments, addComment } = store;
  const people = usePeople();

  const [activeId, setActiveId] = useState(taskId);
  useEffect(() => setActiveId(taskId), [taskId]);
  const [tab, setTab] = useState('overview');
  useEffect(() => setTab('overview'), [activeId]);
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
  const patch = (p) => updateTask(activeId, p);

  const counts = {
    comments: (task.commentIds || []).length,
    attachments: (task.attachmentIds || []).length,
    subtasks: subtasks.length,
    dependencies: blockedBy.length + blocking.length,
  };
  const liked = (task.likedByIds || []).includes(myEmail);

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
          task={task} patch={patch} people={people} projectName={projectName} deptName={deptName}
          blockedBy={blockedBy} depCandidates={depCandidates} addDependency={addDependency} removeDependency={removeDependency}
          subtasks={subtasks} createTask={createTask} updateTask={updateTask} onOpenSub={setActiveId}
          nameOf={nameOf} myEmail={myEmail} getComments={getComments} addComment={addComment} refresh={store.refresh}
        />
      );
      case 'comments':     return <CommentsTab task={task} nameOf={nameOf} myEmail={myEmail} getComments={getComments} addComment={addComment} />;
      case 'activity':     return <ActivityTab taskId={activeId} nameOf={nameOf} />;
      case 'attachments':  return <AttachmentsTab task={task} refresh={store.refresh} />;
      case 'subtasks':     return <SubtasksTab task={task} subtasks={subtasks} createTask={createTask} updateTask={updateTask} people={people} onOpenSub={setActiveId} />;
      case 'dependencies': return <DependenciesTab blockedBy={blockedBy} blocking={blocking} task={task} removeDependency={removeDependency} />;
      case 'properties':   return <PropertiesTab task={task} nameOf={nameOf} projectName={projectName} deptName={deptName} customFields={customFields} patch={patch} />;
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
            {/* On a phone this collapses to its circle-check icon — the label is
                the widest thing in the header and crowds out the actions. */}
            <button onClick={() => store.toggleComplete(task)} title={task.completed ? 'Completed' : 'Mark complete'}
              style={{ ...btn('outline'), padding: isMobile ? 7 : '6px 10px', fontSize: 12, color: task.completed ? NX.green : NX.dim }}>
              {task.completed ? <CheckCircle2 size={15} style={{ color: NX.green }} /> : <Circle size={15} />}
              {!isMobile && (task.completed ? 'Completed' : 'Mark complete')}
            </button>
            <span style={{ fontSize: 11, fontWeight: 700, color: NX.faint }}>{task.code}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <MembersMenu task={task} people={people} nameOf={nameOf} patch={patch} />
            <button onClick={() => setShareOpen(true)} title="Share" style={{ ...btn('outline'), padding: '6px 10px', fontSize: 12, color: NX.dim }}><Share2 size={14} /> Share</button>
            <button onClick={() => patch({ likedByIds: liked ? task.likedByIds.filter((e) => e !== myEmail) : [...(task.likedByIds || []), myEmail] })} title={liked ? 'Unlike' : 'Like'} style={{ ...btn('ghost'), padding: 7, color: liked ? NX.blue : NX.faint }}>
              <ThumbsUp size={16} fill={liked ? 'currentColor' : 'none'} />
            </button>
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

        {/* body — one tab on desktop; on mobile the sections stack in a single
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
function MembersMenu({ task, people, nameOf, patch }) {
  const followers = task.followerIds || [];
  const toggle = (email) => patch({ followerIds: followers.includes(email) ? followers.filter((e) => e !== email) : [...followers, email] });
  return (
    <div style={{ display: 'flex', alignItems: 'center' }}>
      {followers.slice(0, 3).map((em, i) => <span key={em} style={{ marginLeft: i ? -6 : 0 }}><Avatar email={em} name={nameOf(em)} size={24} /></span>)}
      <Pop width={230} trigger={(t) => (
        <button onClick={t} title="Collaborators" style={{ ...btn('ghost'), padding: 5, marginLeft: followers.length ? 2 : 0, color: NX.faint }}><UserPlus size={16} /></button>
      )}>
        {() => (
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: NX.faint, padding: '4px 6px' }}>Collaborators</div>
            {people.map((u) => (
              <label key={u.email} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', fontSize: 13, cursor: 'pointer' }}>
                <input type="checkbox" checked={followers.includes(u.email)} onChange={() => toggle(u.email)} />
                <Avatar email={u.email} name={u.name} size={20} /> {u.name}
              </label>
            ))}
            {people.length === 0 && <div style={{ padding: 8, fontSize: 12, color: NX.faint }}>No people</div>}
          </div>
        )}
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
    { key: 'org', icon: Globe, label: 'Greens Global', desc: 'Any organization member can find and access this task.' },
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
function OverviewTab({ task, patch, people, projectName, deptName, blockedBy, depCandidates, addDependency, removeDependency, subtasks, createTask, updateTask, onOpenSub, nameOf, myEmail, getComments, addComment, refresh }) {
  const isMobile = useIsMobile();
  const { statusMeta, statusOrder } = useTasks();
  const [recStep, setRecStep] = useState('root');
  // Recurrence end condition ("Ends" — Never / On date / After occurrences).
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
  const dept = task.departmentId ? deptName(task.departmentId) : '';

  return (
    <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13 }}>
      <Row label="Assignee">
        <div style={{ minWidth: 220 }}>
          <PersonSelect value={task.assigneeId || null} people={people} onChange={(email) => patch({ assigneeId: email || '' })} />
        </div>
      </Row>

      <Row label="Status">
        <Pop width={176} trigger={(t) => <button onClick={t} style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: 0 }}><Chip color={sm.color} tint={sm.tint}>{sm.label}</Chip></button>}>
          {(close) => statusOrder.map((s) => <MenuItem key={s} onClick={() => { patch({ status: s }); close(); }}>{statusMeta[s]?.label || s}</MenuItem>)}
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
        <span style={{ color: NX.ink }}>{task.projectId ? projectName(task.projectId) : '—'}</span>
        {dept && <Chip color={NX.dim} tint={NX.border2}>{dept}</Chip>}
      </Row>

      <Row label="Blocked By">
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 6 }}>
          {blockedBy.map((b) => (
            <span key={b.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: `1px solid ${NX.border}`, borderRadius: 999, padding: '3px 10px', fontSize: 12, color: NX.ink }}>
              <CheckCircle2 size={13} style={{ color: NX.faint }} />
              {b.title}{b.dueOn ? ` · ${fmtDate(b.dueOn)}` : ''}
              <button onClick={() => removeDependency(b.id)} style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: NX.faint, padding: 0, display: 'flex' }}><X size={12} /></button>
            </span>
          ))}
          <Pop width={260} trigger={(t) => <button onClick={t} style={{ ...btn('outline'), padding: '5px 11px', fontSize: 12 }}>Add Dependency</button>}>
            {(close) => (depCandidates.length ? depCandidates.map((c) => (
              <MenuItem key={c.id} onClick={() => { addDependency(c); close(); }}>{c.code} · {c.title}</MenuItem>
            )) : <div style={{ padding: 9, fontSize: 12, color: NX.faint }}>No eligible tasks in this project</div>)}
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
        <DescriptionInput value={task.description || ''} onCommit={(v) => v !== (task.description || '') && patch({ description: v })} />
      </Section>

      {/* Subtasks (inline) */}
      <Section title={subtasks?.length ? `Subtasks ${subtasks.filter((s) => s.completed).length}/${subtasks.length}` : 'Subtasks'}>
        <SubtasksTab task={task} subtasks={subtasks || []} createTask={createTask} updateTask={updateTask} people={people} onOpenSub={onOpenSub} hideHeading />
      </Section>

      {/* Time tracking */}
      <Section title="Time Tracking">
        <TimeTracking task={task} patch={patch} />
      </Section>

      {/* Approval */}
      <Section title="Approval">
        <Approval task={task} patch={patch} />
      </Section>

      {/* Add comment — dropped on mobile: the Comments/All-activity block at the
          bottom of the stacked layout already has a composer. */}
      {!isMobile && (
        <Section title="Add Comment">
          <QuickComment task={task} addComment={addComment} />
        </Section>
      )}

      {/* Attachments */}
      <Section title="Attachments">
        <AttachmentsTab task={task} refresh={refresh} />
      </Section>
    </div>
  );
}

// Compact comment composer for the Overview tab.
function QuickComment({ task, addComment }) {
  const [body, setBody] = useState('');
  const submit = async () => { const b = body.trim(); if (!b) return; setBody(''); await addComment(task.id, b).catch(() => {}); };
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <textarea value={body} onChange={(e) => setBody(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(); }} rows={2} placeholder="Add a comment… (⌘/Ctrl+Enter)"
        style={{ ...inputStyle, resize: 'vertical', fontSize: 13 }} />
      <button onClick={submit} disabled={!body.trim()} style={{ ...btn('primary'), alignSelf: 'flex-end', opacity: body.trim() ? 1 : 0.5 }}>Comment</button>
    </div>
  );
}

function DescriptionInput({ value, onCommit }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <textarea value={v} onChange={(e) => setV(e.target.value)} onBlur={() => onCommit(v)} rows={3} placeholder="Add a description…"
      style={{ ...inputStyle, resize: 'vertical', fontSize: 13, lineHeight: 1.5 }} />
  );
}

function TimeTracking({ task, patch }) {
  const [hours, setHours] = useState('');
  const log = () => { const h = Number(hours); if (h > 0) { patch({ actualHours: (task.actualHours || 0) + h }); setHours(''); } };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 18, fontSize: 13 }}>
      <div><div style={{ color: NX.faint }}>Estimate</div><div style={{ fontWeight: 700, color: NX.ink }}>{task.estimateHours ?? 0}h</div></div>
      <div><div style={{ color: NX.faint }}>Actual</div><div style={{ fontWeight: 700, color: NX.blue }}>{task.actualHours ?? 0}h</div></div>
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
        <input value={hours} onChange={(e) => setHours(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && log()} type="number" min="0" step="0.25" placeholder="0.5"
          style={{ ...inputStyle, width: 72, padding: '6px 8px', fontSize: 12 }} />
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
  const reload = () => getComments(task.id).then(setComments).catch(() => setComments([]));
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [task.id]);

  const submit = async () => { const b = body.trim(); if (!b) return; setBody(''); await addComment(task.id, b).catch(() => {}); reload(); };
  const pin = async (c) => { await api.editTaskComment(c.id, { pinned: !c.pinned }).catch(() => {}); reload(); };
  const edit = async (c, text) => { await api.editTaskComment(c.id, { body: text }).catch(() => {}); reload(); };
  const del = async (c) => { if (!window.confirm('Delete this comment?')) return; await api.deleteTaskComment(c.id).catch(() => {}); reload(); };

  const list = (comments || []).slice().sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));

  return (
    <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(); }} rows={2} placeholder="Add a comment… (⌘/Ctrl+Enter)"
          style={{ ...inputStyle, resize: 'vertical', fontSize: 13 }} />
        <button onClick={submit} style={{ ...btn('primary'), alignSelf: 'flex-end' }}>Send</button>
      </div>
      {comments === null ? <div style={{ color: NX.faint, fontSize: 13, textAlign: 'center', padding: 20 }}>Loading…</div>
        : list.length === 0 ? <div style={{ color: NX.faint, fontSize: 13, textAlign: 'center', padding: 24 }}>No comments yet.</div>
          : list.map((c) => <CommentItem key={c.id} c={c} nameOf={nameOf} mine={c.authorId === myEmail} onPin={() => pin(c)} onEdit={(t) => edit(c, t)} onDelete={() => del(c)} />)}
    </div>
  );
}
function CommentItem({ c, nameOf, mine, onPin, onEdit, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(c.body);
  const [hover, setHover] = useState(false);
  return (
    <div onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} style={{ display: 'flex', gap: 10, padding: 8, borderRadius: 10, background: c.pinned ? 'rgba(217,119,6,0.14)' : 'transparent' }}>
      <Avatar email={c.authorId} name={nameOf(c.authorId)} size={26} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: NX.ink }}>{nameOf(c.authorId)}</span>
          <span style={{ fontSize: 11, color: NX.faint }}>{fmtDateTime(c.createdAt)}</span>
          {c.editedAt && <span style={{ fontSize: 11, fontStyle: 'italic', color: NX.faint }}>(edited)</span>}
          {c.pinned && <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: NX.amber }}>Pinned</span>}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 2, opacity: hover ? 1 : 0, transition: 'opacity 0.12s' }}>
            <button onClick={onPin} title={c.pinned ? 'Unpin' : 'Pin'} style={{ ...btn('ghost'), padding: 4, color: NX.faint }}><Pin size={12} /></button>
            {mine && <>
              <button onClick={() => { setText(c.body); setEditing(true); }} title="Edit" style={{ ...btn('ghost'), padding: 4, color: NX.faint }}><Pencil size={12} /></button>
              <button onClick={onDelete} title="Delete" style={{ ...btn('ghost'), padding: 4, color: NX.faint }}><Trash2 size={12} /></button>
            </>}
          </div>
        </div>
        {editing ? (
          <div style={{ marginTop: 6, display: 'flex', gap: 6 }}>
            <textarea value={text} autoFocus onChange={(e) => setText(e.target.value)} rows={2} style={{ ...inputStyle, fontSize: 13, resize: 'vertical' }} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <button onClick={() => { onEdit(text); setEditing(false); }} style={{ ...btn('primary'), padding: '5px 10px', fontSize: 12 }}>Save</button>
              <button onClick={() => setEditing(false)} style={{ ...btn('outline'), padding: '5px 10px', fontSize: 12 }}>Cancel</button>
            </div>
          </div>
        ) : <p style={{ margin: '2px 0 0', whiteSpace: 'pre-wrap', fontSize: 13, color: NX.dim }}>{c.body}</p>}
      </div>
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
const MAX_INLINE = 2 * 1024 * 1024;
function AttachmentsTab({ task, refresh }) {
  const [rows, setRows] = useState(null);
  const fileRef = useRef(null);
  const reload = () => api.getTaskAttachments(task.id).then(setRows).catch(() => setRows([]));
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [task.id]);

  const onFile = (e) => {
    const f = e.target.files?.[0]; e.target.value = '';
    if (!f) return;
    const size = `${Math.max(1, Math.round(f.size / 1024))} KB`;
    const kind = f.type.startsWith('image/') ? 'image' : 'doc';
    // Backend AttachmentCreate stores a single `url` (Supabase link, or an inline
    // data URL for small files). Reads expose it as `a.url`.
    const send = (dataUrl) => api.addTaskAttachment(task.id, { name: f.name, size, kind, url: dataUrl || '' }).then(() => { reload(); refresh?.(); }).catch(() => {});
    if (f.size <= MAX_INLINE) { const r = new FileReader(); r.onload = () => send(typeof r.result === 'string' ? r.result : undefined); r.onerror = () => send(undefined); r.readAsDataURL(f); }
    else send(undefined);
  };
  const del = async (a) => { await api.deleteTaskAttachment(a.id).catch(() => {}); reload(); refresh?.(); };

  return (
    <div style={{ marginTop: 14 }}>
      <input ref={fileRef} type="file" style={{ display: 'none' }} onChange={onFile} />
      <button onClick={() => fileRef.current?.click()} style={{ ...btn('outline'), borderStyle: 'dashed', fontSize: 12, marginBottom: 12 }}><Paperclip size={13} /> Attach file</button>
      {rows === null ? <div style={{ color: NX.faint, fontSize: 13, textAlign: 'center', padding: 20 }}>Loading…</div>
        : rows.length === 0 ? <div style={{ color: NX.faint, fontSize: 13, textAlign: 'center', padding: 20 }}>No attachments yet.</div>
          : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {rows.map((a) => (
                <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, border: `1px solid ${NX.border}`, borderRadius: 10, padding: '6px 10px', fontSize: 12 }}>
                  {a.kind === 'image' && (a.dataUrl || a.url) ? <img src={a.dataUrl || a.url} alt={a.name} style={{ width: 32, height: 32, borderRadius: 6, objectFit: 'cover' }} /> : <Paperclip size={13} style={{ color: NX.dim }} />}
                  <span style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
                  <span style={{ color: NX.faint }}>{a.size}</span>
                  {(a.dataUrl || a.url) && <a href={a.dataUrl || a.url} download={a.name} title="Download" style={{ color: NX.faint, display: 'flex' }}><Download size={13} /></a>}
                  <button onClick={() => del(a)} title="Remove" style={{ ...btn('ghost'), padding: 3, color: NX.faint }}><X size={13} /></button>
                </div>
              ))}
            </div>
          )}
    </div>
  );
}

// ── Subtasks ────────────────────────────────────────────────────────────────
function SubtasksTab({ task, subtasks, createTask, updateTask, people, onOpenSub, hideHeading }) {
  const [title, setTitle] = useState('');
  const [dueOn, setDueOn] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const dateRef = useRef(null);
  const done = subtasks.filter((s) => s.completed).length;

  const add = async () => {
    const t = title.trim(); if (!t) return;
    await createTask({ title: t, parentTaskId: task.id, projectId: task.projectId, departmentId: task.departmentId, assigneeId, dueOn, status: 'not_started', priority: 'medium', type: 'task' }).catch(() => {});
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
            {s.assigneeId && <Avatar email={s.assigneeId} size={18} />}
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
      <span style={{ flex: 1, color: NX.ink }}>{b.code} · {b.title}</span>
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
function PropertiesTab({ task, nameOf, projectName, deptName, customFields, patch }) {
  const { statusMeta } = useTasks();
  const sm = statusMeta[task.status] || {};
  const pm = PRIORITY_META[task.priority] || {};
  const rows = [
    ['Task ID', <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{task.code}</span>],
    ['Status', <Chip color={sm.color} tint={sm.tint}>{sm.label}</Chip>],
    ['Priority', <Chip color={pm.color} tint={pm.tint}>{pm.label}</Chip>],
    ['Assignee', task.assigneeId ? <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Avatar email={task.assigneeId} name={nameOf(task.assigneeId)} size={18} /> {nameOf(task.assigneeId)}</span> : 'Unassigned'],
    ['Project', task.projectId ? projectName(task.projectId) : '—'],
    ['Team', task.departmentId ? deptName(task.departmentId) : '—'],
    ['Start Date', fmtDate(task.startOn)],
    ['Due Date', fmtDate(task.dueOn)],
    ['Estimate', task.estimateHours != null ? `${task.estimateHours}h` : '—'],
    ['Actual', task.actualHours != null ? `${task.actualHours}h` : '—'],
    ['Milestone', task.isMilestone ? 'Yes' : 'No'],
    ['Approval', !task.approvalStatus || task.approvalStatus === 'none' ? '—' : task.approvalStatus.replace('_', ' ')],
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
          <span style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {(task.tags || []).length ? task.tags.map((t) => <Chip key={t} color={NX.dim} tint={NX.border2}>{t}</Chip>) : '—'}
          </span>
        </div>
      </div>

      {customFields.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: NX.ink, marginBottom: 8 }}>Custom Fields</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {customFields.map((f) => (
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

function CustomFieldInput({ field, value, onChange }) {
  const [v, setV] = useState(value ?? '');
  useEffect(() => setV(value ?? ''), [value]);
  if (field.type === 'select' && Array.isArray(field.options)) {
    return (
      <select value={v} onChange={(e) => { setV(e.target.value); onChange(e.target.value); }} style={{ ...inputStyle, width: 'auto', padding: '6px 9px', fontSize: 13 }}>
        <option value="">—</option>
        {field.options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }
  return (
    <input type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'} value={v}
      onChange={(e) => setV(e.target.value)} onBlur={() => onChange(v)}
      style={{ ...inputStyle, width: 'auto', minWidth: 180, padding: '6px 9px', fontSize: 13 }} />
  );
}

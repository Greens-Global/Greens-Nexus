// Task Module — the Task Detail drawer: a right-side, resizable, tabbed panel
// (Overview / Comments / Activity / Attachments / Subtasks / Dependencies /
// Properties). Ported from the export's features/task-detail/* (24 files) into a
// single consolidated file matching this module's inline-style idiom, wired to
// the real TasksContext store + api.js instead of the export's mocked Zustand store.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeft, ArrowRightToLine, CheckCircle2, Circle, ChevronDown, ChevronRight,
  ChevronLeft, Diamond, Repeat, ThumbsUp, Trash2, Link2, X, Clock, ShieldCheck,
  Paperclip, Download, Pin, Pencil, Plus, CalendarDays, Maximize2, Minimize2,
  RotateCcw, ThumbsDown, Share2, Bell, Copy, Check, Lock, Building2, Ban,
  Smile, Send, AtSign,
} from 'lucide-react';
import { api } from '../api';
import { useTasks } from './TasksContext';
import {
  NX, FONT, btn, input as inputStyle, STATUS_META, STATUS_ORDER, PRIORITY_META, PRIORITY_ORDER,
  DEPENDENCY_TYPE_META, DEPENDENCY_TYPE_ORDER, ACCESS_LEVEL_META, ACCESS_LEVEL_ORDER,
} from './theme';
import { Avatar, PersonSelect, usePeople, Modal } from './components';
import { CustomFieldEditor, useConfirm, toast, renderWithMentions, activeMention, EMOJIS } from './shared';

const DEP_TYPES = { FS: 'Finish → Start', SS: 'Start → Start', FF: 'Finish → Finish', SF: 'Start → Finish' };
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const lc = (s) => (s || '').toLowerCase();

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso.length <= 10 ? iso + 'T00:00:00' : iso);
  if (isNaN(d)) return iso;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function recurrenceLabel(r) {
  if (!r || !r.freq) return 'Does not repeat';
  if (r.freq === 'daily') return 'Every day';
  if (r.freq === 'weekly') return `Every week on ${DAYS[r.dayOfWeek ?? 1]}`;
  if (r.freq === 'monthly') return `Every month on day ${r.dayOfMonth ?? 1}`;
  return 'Does not repeat';
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
function Pop({ trigger, children, width = 200, align = 'left' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);
  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
      {trigger(() => setOpen((o) => !o))}
      {open && (
        <div style={{ position: 'absolute', top: '100%', [align]: 0, marginTop: 4, width, background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,0.16)', zIndex: 60, padding: 4, maxHeight: 320, overflowY: 'auto' }}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}
function MenuItem({ icon, onClick, danger, active, children }) {
  const [hover, setHover] = useState(false);
  return (
    <button onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '7px 9px',
      borderRadius: 7, border: 'none', cursor: 'pointer', fontSize: 13, fontFamily: FONT,
      color: danger ? NX.red : NX.ink, background: hover || active ? NX.hover : 'transparent',
    }}>{icon}{children}</button>
  );
}

export default function TaskDetailDrawer({ taskId, onClose, onEdit, initialTab }) {
  const store = useTasks();
  const {
    taskById, tasks, projectName, deptName, nameOf, myEmail, customFields = [],
    updateTask, deleteTask, createTask,
    getComments, addComment, editComment, pinComment, deleteComment,
    addAttachment, toggleComplete, toggleLike, toggleFollower,
    setAccessLevel, setApproval, logTime, setCustomFieldValue,
    addDependency, removeDependency, setDependencyType, addSubtask,
  } = store;
  const people = usePeople();
  const myLc = lc(myEmail);
  const [confirm, confirmNode] = useConfirm();

  const [activeId, setActiveId] = useState(taskId);
  const [tab, setTab] = useState(initialTab || 'overview');
  // External open (new taskId / initialTab) — sync both. Internal navigation
  // (back-to-parent, open subtask) goes through openTask below and resets tab.
  useEffect(() => { setActiveId(taskId); setTab(initialTab || 'overview'); }, [taskId, initialTab]);
  const openTask = (id) => { setActiveId(id); setTab('overview'); };

  const task = taskById[activeId];
  const [shareOpen, setShareOpen] = useState(false);

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
  const liked = (task.likedByIds || []).map(lc).includes(myLc);

  const copyLink = () => {
    navigator.clipboard?.writeText(`${window.location.origin}${window.location.pathname}?task=${task.id}`);
    toast('Task link copied');
  };

  const TABS = [
    ['overview', 'Overview'], ['comments', 'Comments'], ['activity', 'Activity'],
    ['attachments', 'Attachments'], ['subtasks', 'Subtasks'], ['dependencies', 'Dependencies'], ['properties', 'Properties'],
  ];

  return createPortal(
    <div onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} style={{ position: 'fixed', inset: 0, zIndex: 3500, fontFamily: FONT }}>
      <aside style={{ position: 'absolute', right: 0, top: 0, height: '100%', width, maxWidth: '100%', display: 'flex', flexDirection: 'column', background: NX.surface, borderLeft: `1px solid ${NX.border}`, boxShadow: '-8px 0 40px rgba(0,0,0,0.18)' }}>
        {/* drag handle */}
        <div onMouseDown={() => { dragging.current = true; document.body.style.userSelect = 'none'; }} title="Drag to resize" style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: 6, cursor: 'ew-resize', zIndex: 5 }} />

        {/* header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: `1px solid ${NX.border}`, flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button onClick={() => toggleComplete(task)} style={{ ...btn('outline'), padding: '6px 10px', fontSize: 12, color: task.completed ? NX.green : NX.dim }}>
              {task.completed ? <CheckCircle2 size={15} style={{ color: NX.green }} /> : <Circle size={15} />}
              {task.completed ? 'Completed' : 'Mark complete'}
            </button>
            <span style={{ fontSize: 11, fontWeight: 700, color: NX.faint }}>{task.code}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <MembersMenu task={task} people={people} nameOf={nameOf} myEmail={myEmail} toggleFollower={toggleFollower} copyLink={copyLink} />
            <button onClick={() => setShareOpen(true)} style={{ ...btn('outline'), padding: '6px 10px', fontSize: 12 }}><Share2 size={14} /> Share</button>
            <button onClick={() => toggleLike(task, myEmail)} title={liked ? 'Unlike' : 'Like'} style={{ ...btn('ghost'), padding: 7, color: liked ? NX.blue : NX.faint }}>
              <ThumbsUp size={16} fill={liked ? 'currentColor' : 'none'} />
            </button>
            <button onClick={copyLink} title="Copy task link" style={{ ...btn('ghost'), padding: 7, color: NX.faint }}><Link2 size={16} /></button>
            <button onClick={toggleExpand} title={expanded ? 'Collapse' : 'Expand'} style={{ ...btn('ghost'), padding: 7, color: NX.faint }}>
              {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            </button>
            <Pop width={210} align="right" trigger={(t) => <button onClick={t} title="More actions" style={{ ...btn('ghost'), padding: 7, color: NX.faint }}><ChevronDown size={16} /></button>}>
              {(close) => (
                <>
                  {onEdit && <MenuItem icon={<Pencil size={14} />} onClick={() => { onEdit(activeId); close(); }}>Edit task</MenuItem>}
                  <MenuItem icon={<Diamond size={14} style={{ color: task.isMilestone ? NX.purple : undefined }} />} onClick={() => { patch({ isMilestone: !task.isMilestone }); close(); }}>
                    {task.isMilestone ? 'Unmark milestone' : 'Mark as milestone'}
                  </MenuItem>
                  <MenuItem danger icon={<Trash2 size={14} />} onClick={async () => {
                    close();
                    const ok = await confirm({ title: 'Delete this task?', message: `“${task.title}” and its subtasks will be permanently deleted.`, danger: true, confirmLabel: 'Delete task' });
                    if (ok) { deleteTask(activeId); onClose(); }
                  }}>
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
              <button onClick={() => openTask(task.parentTaskId)} title="Back to main task" style={{ ...btn('ghost'), padding: 4, color: NX.faint }}><ArrowLeft size={18} /></button>
            )}
            <TitleInput key={activeId} value={task.title} completed={task.completed} onCommit={(v) => v.trim() && v !== task.title && patch({ title: v.trim() })} />
          </div>
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
        </div>

        {/* body */}
        <div className="scroll-tabs" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px 18px 24px' }}>
          {tab === 'overview' && (
            <OverviewTab
              task={task} patch={patch} people={people} projectName={projectName} deptName={deptName}
              blockedBy={blockedBy} depCandidates={depCandidates}
              addDependency={addDependency} removeDependency={removeDependency} setDependencyType={setDependencyType}
              subtasks={subtasks} addSubtask={addSubtask} toggleComplete={toggleComplete} onOpenSub={openTask}
              addComment={addComment} addAttachment={addAttachment}
              setApproval={setApproval} logTime={logTime}
            />
          )}
          {tab === 'comments' && <CommentsTab task={task} nameOf={nameOf} myLc={myLc} people={people} getComments={getComments} addComment={addComment} editComment={editComment} pinComment={pinComment} deleteComment={deleteComment} />}
          {tab === 'activity' && <ActivityTab taskId={activeId} nameOf={nameOf} />}
          {tab === 'attachments' && <AttachmentsTab task={task} refresh={store.refresh} />}
          {tab === 'subtasks' && <SubtasksTab task={task} subtasks={subtasks} createTask={createTask} updateTask={updateTask} people={people} onOpenSub={openTask} />}
          {tab === 'dependencies' && <DependenciesTab blockedBy={blockedBy} blocking={blocking} task={task} removeDependency={removeDependency} />}
          {tab === 'properties' && <PropertiesTab task={task} nameOf={nameOf} projectName={projectName} deptName={deptName} customFields={customFields} people={people} setCustomFieldValue={setCustomFieldValue} />}
        </div>
      </aside>
      {shareOpen && (
        <ShareTaskModal task={task} people={people} nameOf={nameOf} projectName={projectName} deptName={deptName}
          myEmail={myEmail} toggleFollower={toggleFollower} setAccessLevel={setAccessLevel} onClose={() => setShareOpen(false)} />
      )}
      {confirmNode}
    </div>,
    document.body,
  );
}

// ── Members menu (avatar stack + panel) ─────────────────────────────────────
function MembersMenu({ task, people, nameOf, myEmail, toggleFollower, copyLink }) {
  const followerIds = task.followerIds || [];
  const followerSet = new Set(followerIds.map(lc));
  const followers = followerIds.map((e) => ({ email: e, name: nameOf(e) || e }));
  const candidates = people.filter((p) => !followerSet.has(p.email));
  const isFollowing = followerSet.has(lc(myEmail));
  return (
    <Pop width={320} align="right" trigger={(t) => (
      <button onClick={t} title="Members" style={{ display: 'inline-flex', alignItems: 'center', border: 'none', background: 'transparent', cursor: 'pointer', padding: 0 }}>
        <span style={{ display: 'inline-flex' }}>
          {followers.slice(0, 3).map((f, i) => (
            <span key={f.email} style={{ marginLeft: i ? -8 : 0, borderRadius: '50%', boxShadow: `0 0 0 2px ${NX.surface}` }}>
              <Avatar email={f.email} name={f.name} size={26} />
            </span>
          ))}
        </span>
        <span style={{ marginLeft: 4, width: 24, height: 24, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: '50%', border: `1px dashed ${NX.border}`, color: NX.faint }}><Plus size={14} /></span>
      </button>
    )}>
      {() => (
        <div style={{ padding: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 11 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: NX.ink }}>Members</div>
            <button onClick={() => toggleFollower(task, myEmail)} title="Get notifications about activity on this task." style={{ ...btn('outline'), padding: '6px 10px', fontSize: 12 }}>
              <Bell size={14} /> {isFollowing ? 'Following' : 'Join task'}
            </button>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
            {followers.map((f) => (
              <span key={f.email} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: `1px solid ${NX.border}`, borderRadius: 999, padding: '3px 8px 3px 3px', fontSize: 12, color: NX.ink }}>
                <Avatar email={f.email} name={f.name} size={20} />
                {f.name}
                <button onClick={() => toggleFollower(task, f.email)} style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: NX.faint, padding: 0, display: 'flex' }}><X size={12} /></button>
              </span>
            ))}
            <button onClick={copyLink} title="Copy task link" style={{ ...btn('ghost'), padding: 6, color: NX.faint }}><Copy size={14} /></button>
          </div>
          {candidates.length > 0 && (
            <div style={{ marginTop: 11, borderTop: `1px solid ${NX.border}`, paddingTop: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: NX.faint, marginBottom: 4 }}>Add member</div>
              <div className="scroll-tabs" style={{ maxHeight: 160, overflowY: 'auto' }}>
                {candidates.map((u) => (
                  <button key={u.email} onClick={() => toggleFollower(task, u.email)} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', border: 'none', background: 'transparent', cursor: 'pointer', borderRadius: 8, padding: '6px 8px', fontFamily: FONT, fontSize: 13, color: NX.ink }}>
                    <Avatar email={u.email} name={u.name} size={22} /> {u.name}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </Pop>
  );
}

// ── Share modal ─────────────────────────────────────────────────────────────
function ShareTaskModal({ task, people, nameOf, projectName, deptName, myEmail, toggleFollower, setAccessLevel, onClose }) {
  const [inviteQuery, setInviteQuery] = useState('');
  const link = `${window.location.origin}${window.location.pathname}?task=${task.id}`;
  const followerIds = task.followerIds || [];
  const followerSet = new Set(followerIds.map(lc));
  const copyLink = () => { navigator.clipboard?.writeText(link); toast('Task link copied'); };

  const invite = () => {
    const q = inviteQuery.trim().toLowerCase();
    if (!q) return;
    const match = people.find((u) => u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q));
    if (!match) { toast('No matching member found'); return; }
    if (!followerSet.has(match.email)) toggleFollower(task, match.email);
    toast(`${match.name} invited`);
    setInviteQuery('');
  };

  const accessEmails = [...new Set([task.assigneeId, ...followerIds].filter(Boolean).map(lc))];
  const accessUsers = accessEmails.map((e) => ({ email: e, name: nameOf(e) || e }));
  const dept = task.departmentId ? deptName(task.departmentId) : '';

  return (
    <Modal title={`Share ${task.title}`} width={480} onClose={onClose}
      footer={<button onClick={copyLink} style={{ ...btn('outline') }}><Link2 size={14} /> Copy task link</button>}>
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: NX.ink, marginBottom: 8 }}>Invite with email</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input value={inviteQuery} onChange={(e) => setInviteQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') invite(); }}
            placeholder="Add members by name or email…" style={{ ...inputStyle, flex: 1, fontSize: 13 }} />
          <button onClick={invite} disabled={!inviteQuery.trim()} style={{ ...btn('primary'), opacity: inviteQuery.trim() ? 1 : 0.4 }}>Invite</button>
        </div>
      </div>

      <div style={{ marginBottom: 16, borderTop: `1px solid ${NX.border}`, paddingTop: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: NX.ink, marginBottom: 8 }}>Access settings</div>
        <AccessSettings task={task} setAccessLevel={setAccessLevel} />
      </div>

      <div style={{ fontSize: 13, fontWeight: 700, color: NX.ink, marginBottom: 6 }}>Who has access</div>
      <div className="scroll-tabs" style={{ maxHeight: 264, overflowY: 'auto' }}>
        {task.projectId && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, borderBottom: `1px solid ${NX.border}`, padding: '10px 0' }}>
            <span style={{ width: 36, height: 36, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 10, background: NX.surface2, color: NX.faint }}><Building2 size={16} /></span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: NX.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>#{projectName(task.projectId)}{dept ? ` - ${dept}` : ''}</div>
              <div style={{ fontSize: 12, color: NX.faint }}>Private</div>
            </div>
          </div>
        )}
        {accessUsers.map((u) => {
          const isMember = followerSet.has(u.email);
          const isAssignee = lc(task.assigneeId) === u.email;
          return (
            <div key={u.email} style={{ display: 'flex', alignItems: 'center', gap: 12, borderBottom: `1px solid ${NX.border}`, padding: '10px 0' }}>
              <Avatar email={u.email} name={u.name} size={32} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, color: NX.ink }}>
                  {u.name}
                  {isAssignee && <span style={{ flexShrink: 0, borderRadius: 5, background: NX.surface2, padding: '1px 6px', fontSize: 10, fontWeight: 700, color: NX.dim }}>Assignee</span>}
                </div>
                <div style={{ fontSize: 12, color: NX.faint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.email}</div>
              </div>
              {isMember ? (
                <button onClick={() => toggleFollower(task, u.email)} title="Remove" style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: NX.faint, display: 'flex' }}><X size={16} /></button>
              ) : (
                <button onClick={() => toggleFollower(task, u.email)} style={{ ...btn('outline'), padding: '5px 10px', fontSize: 12 }}>Join task</button>
              )}
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

function AccessSettings({ task, setAccessLevel }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);
  const level = task.accessLevel || 'org';
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button onClick={() => setOpen((o) => !o)} style={{ ...btn('outline'), width: '100%', justifyContent: 'space-between', fontWeight: 500 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Lock size={14} style={{ color: NX.faint }} /> {ACCESS_LEVEL_META[level].label}</span>
        <ChevronDown size={14} style={{ color: NX.faint }} />
      </button>
      {open && (
        <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 4, zIndex: 70, background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,0.16)', overflow: 'hidden' }}>
          {ACCESS_LEVEL_ORDER.map((lvl) => (
            <button key={lvl} onClick={() => { setAccessLevel(task.id, lvl); setOpen(false); }} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, width: '100%', textAlign: 'left', padding: '9px 11px', border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: FONT }}>
              <span style={{ marginTop: 2, width: 14, flexShrink: 0, color: NX.ink }}>{lvl === level && <Check size={14} />}</span>
              {lvl === 'org' ? <Building2 size={16} style={{ marginTop: 2, flexShrink: 0, color: NX.faint }} /> : <Lock size={16} style={{ marginTop: 2, flexShrink: 0, color: NX.faint }} />}
              <span style={{ minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 13, fontWeight: 500, color: NX.ink }}>{ACCESS_LEVEL_META[lvl].label}</span>
                <span style={{ display: 'block', fontSize: 12, color: NX.faint }}>{ACCESS_LEVEL_META[lvl].description}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
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

// ── Comment composer (@mention autocomplete + emoji picker) ──────────────────
function CommentComposer({ people, initialValue = '', onSubmit, onCancel, autoFocus, submitLabel = 'Comment', placeholder = 'Add a comment…' }) {
  const ref = useRef(null);
  const emojiWrapRef = useRef(null);
  const emojiBtnRef = useRef(null);
  const [value, setValue] = useState(initialValue);
  const [mention, setMention] = useState(null); // { query, start, left, top }
  const [emoji, setEmoji] = useState(null);      // { left, bottom }

  useEffect(() => {
    if (!emoji) return;
    const onDoc = (e) => { if (emojiWrapRef.current && !emojiWrapRef.current.contains(e.target)) setEmoji(null); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [emoji]);

  const suggestions = mention
    ? people.filter((u) => u.name.toLowerCase().includes(mention.query.toLowerCase())).slice(0, 6)
    : [];

  const recompute = (el) => {
    const found = activeMention(el.value, el.selectionStart ?? el.value.length);
    if (!found) return setMention(null);
    const r = el.getBoundingClientRect();
    setMention({ ...found, left: r.left, top: r.bottom + 4 });
  };
  const insertMention = (u) => {
    const el = ref.current;
    if (!el || !mention) return;
    const caret = el.selectionStart ?? value.length;
    const before = value.slice(0, mention.start);
    const next = `${before}@${u.name} ${value.slice(caret)}`;
    setValue(next);
    setMention(null);
    requestAnimationFrame(() => { el.focus(); const pos = (before + '@' + u.name + ' ').length; el.setSelectionRange(pos, pos); });
  };
  const insertText = (text, keepMention = false) => {
    const el = ref.current;
    const caret = el?.selectionStart ?? value.length;
    const next = value.slice(0, caret) + text + value.slice(caret);
    setValue(next);
    if (!keepMention) setEmoji(null);
    requestAnimationFrame(() => { el?.focus(); const pos = caret + text.length; el?.setSelectionRange(pos, pos); if (keepMention && el) recompute(el); });
  };
  const openEmoji = () => { const r = emojiBtnRef.current?.getBoundingClientRect(); if (r) setEmoji({ left: r.left, bottom: window.innerHeight - r.top + 6 }); };
  const submit = () => { if (!value.trim()) return; onSubmit(value.trim()); if (!onCancel) setValue(''); };

  return (
    <div style={{ position: 'relative' }}>
      <div style={{ borderRadius: 12, border: `1px solid ${NX.border}`, background: NX.surface }}>
        <textarea
          ref={ref}
          autoFocus={autoFocus}
          value={value}
          onChange={(e) => { setValue(e.target.value); recompute(e.target); }}
          onKeyUp={(e) => recompute(e.currentTarget)}
          onClick={(e) => recompute(e.currentTarget)}
          onKeyDown={(e) => {
            if (mention && suggestions.length && e.key === 'Enter') { e.preventDefault(); insertMention(suggestions[0]); return; }
            if (mention && e.key === 'Escape') { setMention(null); return; }
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
          }}
          placeholder={placeholder}
          rows={2}
          style={{ width: '100%', resize: 'none', border: 'none', outline: 'none', background: 'transparent', padding: '8px 11px', fontFamily: FONT, fontSize: 13, color: NX.ink, boxSizing: 'border-box' }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, borderTop: `1px solid ${NX.border}`, padding: '5px 8px' }}>
          <button onClick={() => insertText('@', true)} title="Mention someone" style={{ ...btn('ghost'), padding: 5, color: NX.faint }}><AtSign size={15} /></button>
          <div ref={emojiWrapRef} style={{ position: 'relative', display: 'inline-flex' }}>
            <button ref={emojiBtnRef} onClick={() => (emoji ? setEmoji(null) : openEmoji())} title="Emoji" style={{ ...btn('ghost'), padding: 5, color: NX.faint }}><Smile size={15} /></button>
            {emoji && (
              <div style={{ position: 'fixed', left: emoji.left, bottom: emoji.bottom, zIndex: 6000, width: 256, display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: 2, background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 12, padding: 8, boxShadow: '0 12px 32px rgba(0,0,0,0.18)' }}>
                {EMOJIS.map((e) => <button key={e} onClick={() => insertText(e)} style={{ border: 'none', background: 'transparent', cursor: 'pointer', borderRadius: 6, padding: 4, fontSize: 16 }}>{e}</button>)}
              </div>
            )}
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
            {onCancel && <button onClick={onCancel} style={{ ...btn('ghost'), padding: '5px 9px', fontSize: 12 }}>Cancel</button>}
            <button onClick={submit} disabled={!value.trim()} style={{ ...btn('primary'), padding: '6px 10px', fontSize: 12, opacity: value.trim() ? 1 : 0.4 }}><Send size={12} /> {submitLabel}</button>
          </div>
        </div>
      </div>
      {mention && suggestions.length > 0 && (
        <div style={{ position: 'fixed', left: mention.left, top: mention.top, zIndex: 6000, width: 224, background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 12, boxShadow: '0 12px 32px rgba(0,0,0,0.18)', overflow: 'hidden' }}>
          {suggestions.map((u) => (
            <button key={u.email} onMouseDown={(e) => { e.preventDefault(); insertMention(u); }} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '7px 10px', border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: FONT, fontSize: 13 }}>
              <Avatar email={u.email} name={u.name} size={20} /><span style={{ color: NX.ink }}>{u.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Overview ────────────────────────────────────────────────────────────────
function OverviewTab({ task, patch, people, projectName, deptName, blockedBy, depCandidates, addDependency, removeDependency, setDependencyType, subtasks, addSubtask, toggleComplete, onOpenSub, addComment, addAttachment, setApproval, logTime }) {
  const [recStep, setRecStep] = useState('root');
  const sm = STATUS_META[task.status] || {};
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
          {(close) => STATUS_ORDER.map((s) => <MenuItem key={s} onClick={() => { patch({ status: s }); close(); }}>{STATUS_META[s].label}</MenuItem>)}
        </Pop>
      </Row>

      <Row label="Priority">
        <Pop width={160} trigger={(t) => <button onClick={t} style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: 0 }}><Chip color={pm.color} tint={pm.tint}>{pm.label}</Chip></button>}>
          {(close) => PRIORITY_ORDER.map((p) => <MenuItem key={p} onClick={() => { patch({ priority: p }); close(); }}>{PRIORITY_META[p].label}</MenuItem>)}
        </Pop>
      </Row>

      <Row label="Due date">
        <input type="date" value={task.dueOn || ''} onChange={(e) => patch({ dueOn: e.target.value || '' })} style={{ ...inputStyle, width: 'auto', padding: '6px 9px', fontSize: 12 }} />
      </Row>

      <Row label="Project">
        <span style={{ color: NX.ink }}>{task.projectId ? projectName(task.projectId) : '—'}</span>
        {dept && <Chip color={NX.dim} tint={NX.border2}>{dept}</Chip>}
      </Row>

      <Row label="Dependencies">
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 6 }}>
          {blockedBy.map((b) => (
            <div key={b.id} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
              <DependencyTypeMenu task={task} blockedById={b.id} type={(task.dependencyTypes || {})[b.id] || 'FS'} setDependencyType={setDependencyType} />
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: `1px solid ${NX.border}`, borderRadius: 999, padding: '3px 10px', fontSize: 12, color: NX.ink }}>
                <CheckCircle2 size={13} style={{ color: NX.faint }} />
                {b.title}{b.dueOn ? ` · ${fmtDate(b.dueOn)}` : ''}
                <button onClick={() => removeDependency(task, b.id)} style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: NX.faint, padding: 0, display: 'flex' }}><X size={12} /></button>
              </span>
            </div>
          ))}
          <Pop width={260} trigger={(t) => <button onClick={t} style={{ ...btn('outline'), padding: '5px 11px', fontSize: 12 }}>Add dependencies</button>}>
            {(close) => (depCandidates.length ? depCandidates.map((c) => (
              <MenuItem key={c.id} onClick={() => { addDependency(task, c.id); close(); }}>{c.code} · {c.title}</MenuItem>
            )) : <div style={{ padding: 9, fontSize: 12, color: NX.faint }}>No eligible tasks in this project</div>)}
          </Pop>
        </div>
      </Row>

      <Row label="Recurrence">
        <Pop width={200} trigger={(t) => <button onClick={() => { setRecStep('root'); t(); }} style={{ ...btn('ghost'), padding: '5px 8px', fontSize: 12 }}><Repeat size={13} /> {recurrenceLabel(task.recurrence)}</button>}>
          {(close) => {
            if (recStep === 'weekly') return (<>
              <MenuItem icon={<ChevronLeft size={14} />} onClick={() => setRecStep('root')}>Back</MenuItem>
              {DAYS.map((d, i) => <MenuItem key={d} onClick={() => { patch({ recurrence: { freq: 'weekly', dayOfWeek: i } }); close(); }}>{d}</MenuItem>)}
            </>);
            if (recStep === 'monthly') return (<>
              <MenuItem icon={<ChevronLeft size={14} />} onClick={() => setRecStep('root')}>Back</MenuItem>
              {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => <MenuItem key={d} onClick={() => { patch({ recurrence: { freq: 'monthly', dayOfMonth: d } }); close(); }}>Day {d}</MenuItem>)}
            </>);
            return (<>
              <MenuItem onClick={() => { patch({ recurrence: null }); close(); }}>Does not repeat</MenuItem>
              <MenuItem onClick={() => { patch({ recurrence: { freq: 'daily' } }); close(); }}>Every day</MenuItem>
              <MenuItem onClick={() => setRecStep('weekly')}>Every week</MenuItem>
              <MenuItem onClick={() => setRecStep('monthly')}>Every month</MenuItem>
            </>);
          }}
        </Pop>
      </Row>

      {/* Description */}
      <Section title="Description">
        <DescriptionInput value={task.description || ''} onCommit={(v) => v !== (task.description || '') && patch({ description: v })} />
      </Section>

      {/* Subtasks */}
      <OverviewSubtasks task={task} subtasks={subtasks} addSubtask={addSubtask} people={people} toggleComplete={toggleComplete} onOpenSub={onOpenSub} />

      {/* Time tracking */}
      <Section title="Time tracking">
        <TimeTracking task={task} logTime={logTime} />
      </Section>

      {/* Approval */}
      <Section title="Approval">
        <Approval task={task} setApproval={setApproval} />
      </Section>

      {/* Add comment */}
      <Section title="Add comment">
        <CommentComposer people={people} onSubmit={(b) => addComment(task.id, b)} />
      </Section>

      {/* Attachments */}
      <Section title="Attachments">
        <AttachFileButton taskId={task.id} addAttachment={addAttachment} />
      </Section>
    </div>
  );
}

// "FS ▾" trigger → pick the dependency relationship type.
function DependencyTypeMenu({ task, blockedById, type, setDependencyType }) {
  return (
    <Pop width={220} trigger={(t) => (
      <button onClick={t} style={{ ...btn('outline'), padding: '4px 9px', fontSize: 12, color: NX.amber }}>
        <Ban size={13} /> Blocked by · {type} <ChevronDown size={12} />
      </button>
    )}>
      {(close) => DEPENDENCY_TYPE_ORDER.map((dt) => (
        <MenuItem key={dt} active={type === dt}
          icon={type === dt ? <Check size={14} /> : <span style={{ display: 'inline-block', width: 14 }} />}
          onClick={() => { setDependencyType(task, blockedById, dt); close(); }}>
          {DEPENDENCY_TYPE_META[dt].label} · {dt}
        </MenuItem>
      ))}
    </Pop>
  );
}

function OverviewSubtasks({ task, subtasks, addSubtask, people, toggleComplete, onOpenSub }) {
  const [title, setTitle] = useState('');
  const [dueOn, setDueOn] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const dateRef = useRef(null);
  const done = subtasks.filter((s) => s.completed).length;

  const add = async () => {
    const t = title.trim(); if (!t) return;
    await addSubtask(task, { title: t, dueOn, assigneeId }).catch(() => {});
    setTitle(''); setDueOn(''); setAssigneeId('');
  };

  return (
    <Section title={subtasks.length ? `Subtasks ${done}/${subtasks.length}` : 'Add subtask'}>
      {subtasks.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 10 }}>
          {subtasks.map((s) => (
            <div key={s.id} onClick={() => onOpenSub(s.id)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 6px', borderRadius: 8, cursor: 'pointer' }}
              onMouseEnter={(e) => (e.currentTarget.style.background = NX.hover)} onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
              <button onClick={(e) => { e.stopPropagation(); toggleComplete(s); }} style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: NX.faint, display: 'flex', padding: 0 }}>
                {s.completed ? <CheckCircle2 size={15} style={{ color: NX.green }} /> : <Circle size={15} />}
              </button>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, color: s.completed ? NX.faint : NX.ink, textDecoration: s.completed ? 'line-through' : 'none' }}>{s.title}</span>
              {s.dueOn && <span style={{ fontSize: 11, color: NX.faint }}>{fmtDate(s.dueOn)}</span>}
              {s.assigneeId && <Avatar email={s.assigneeId} size={18} />}
              <ChevronRight size={14} style={{ color: NX.faint }} />
            </div>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, border: `1px dashed ${NX.border}`, borderRadius: 8, padding: '6px 10px', position: 'relative' }}>
        <Plus size={14} style={{ color: NX.faint, flexShrink: 0 }} />
        <input value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} placeholder="Add subtask"
          style={{ flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent', fontFamily: FONT, fontSize: 13 }} />
        {dueOn && <span style={{ fontSize: 11, color: NX.faint }}>{fmtDate(dueOn)}</span>}
        <button onClick={() => (dateRef.current?.showPicker?.() ?? dateRef.current?.focus())} title="Due date" style={{ ...btn('ghost'), padding: 4, color: NX.faint }}><CalendarDays size={15} /></button>
        <input ref={dateRef} type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} style={{ position: 'absolute', width: 0, height: 0, opacity: 0 }} tabIndex={-1} />
        <div style={{ minWidth: 150 }}>
          <PersonSelect value={assigneeId || null} people={people} onChange={(email) => setAssigneeId(email || '')} placeholder="Assignee" />
        </div>
        <button onClick={add} style={{ ...btn('primary'), padding: '6px 10px', fontSize: 12 }}>Add</button>
      </div>
    </Section>
  );
}

const MAX_INLINE = 2 * 1024 * 1024;
function AttachFileButton({ taskId, addAttachment, onDone }) {
  const fileRef = useRef(null);
  const onFile = (e) => {
    const f = e.target.files?.[0]; e.target.value = '';
    if (!f) return;
    const size = `${Math.max(1, Math.round(f.size / 1024))} KB`;
    const kind = f.type.startsWith('image/') ? 'image' : 'doc';
    const send = (dataUrl) => addAttachment(taskId, { name: f.name, size, kind, url: dataUrl || '' }).then(() => onDone?.()).catch(() => {});
    if (f.size <= MAX_INLINE) { const r = new FileReader(); r.onload = () => send(typeof r.result === 'string' ? r.result : undefined); r.onerror = () => send(undefined); r.readAsDataURL(f); }
    else send(undefined);
  };
  return (
    <>
      <input ref={fileRef} type="file" style={{ display: 'none' }} onChange={onFile} />
      <button onClick={() => fileRef.current?.click()} style={{ ...btn('outline'), borderStyle: 'dashed', fontSize: 12 }}><Paperclip size={13} /> Attach file</button>
    </>
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

function TimeTracking({ task, logTime }) {
  const [hours, setHours] = useState('');
  const log = () => { const h = Number(hours); if (h > 0) { logTime(task.id, h); setHours(''); toast(`Logged ${h}h`); } };
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

function Approval({ task, setApproval }) {
  const s = task.approvalStatus || 'none';
  const set = (status, msg) => { setApproval(task.id, status); toast(msg); };
  if (s === 'none') {
    return <button onClick={() => set('pending', 'Approval requested')} style={{ ...btn('outline'), borderStyle: 'dashed', fontSize: 12 }}><ShieldCheck size={13} /> Request approval</button>;
  }
  const color = s === 'approved' ? NX.green : s === 'rejected' ? NX.red : NX.amber;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <Chip color={color} tint={NX.border2}>{s.replace('_', ' ')}</Chip>
      <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button onClick={() => set('approved', 'Approved')} style={{ ...btn('outline'), padding: '6px 10px', fontSize: 12, color: NX.green }}><ThumbsUp size={13} /> Approve</button>
        <button onClick={() => set('changes_requested', 'Changes requested')} style={{ ...btn('outline'), padding: '6px 10px', fontSize: 12, color: NX.amber }}><RotateCcw size={13} /> Changes</button>
        <button onClick={() => set('rejected', 'Rejected')} style={{ ...btn('outline'), padding: '6px 10px', fontSize: 12, color: NX.red }}><ThumbsDown size={13} /> Reject</button>
        <button onClick={() => set('none', 'Approval cleared')} title="Clear" style={{ ...btn('outline'), padding: '6px 10px', fontSize: 12, color: NX.dim }}><X size={13} /></button>
      </div>
    </div>
  );
}

// ── Comments ────────────────────────────────────────────────────────────────
function CommentsTab({ task, nameOf, myLc, people, getComments, addComment, editComment, pinComment, deleteComment }) {
  const [comments, setComments] = useState(null);
  const [confirm, confirmNode] = useConfirm();
  const reload = () => getComments(task.id).then(setComments).catch(() => setComments([]));
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [task.id]);
  const names = useMemo(() => people.map((p) => p.name), [people]);

  const submit = async (b) => { await addComment(task.id, b).catch(() => {}); reload(); };
  const pin = async (c) => { await pinComment(c.id, !c.pinned).catch(() => {}); reload(); };
  const edit = async (c, text) => { await editComment(c.id, text).catch(() => {}); reload(); };
  const del = async (c) => {
    const ok = await confirm({ title: 'Delete comment?', message: 'This comment will be permanently removed.', danger: true, confirmLabel: 'Delete' });
    if (!ok) return;
    await deleteComment(c.id, task.id).catch(() => {}); reload();
  };

  const list = (comments || []).slice().sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));

  return (
    <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <CommentComposer people={people} onSubmit={submit} />
      {comments === null ? <div style={{ color: NX.faint, fontSize: 13, textAlign: 'center', padding: 20 }}>Loading…</div>
        : list.length === 0 ? <div style={{ color: NX.faint, fontSize: 13, textAlign: 'center', padding: 24 }}>No comments yet.</div>
          : list.map((c) => <CommentItem key={c.id} c={c} nameOf={nameOf} names={names} people={people} mine={lc(c.authorId) === myLc} onPin={() => pin(c)} onEdit={(t) => edit(c, t)} onDelete={() => del(c)} />)}
      {confirmNode}
    </div>
  );
}
function CommentItem({ c, nameOf, names, people, mine, onPin, onEdit, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [hover, setHover] = useState(false);
  if (editing) {
    return (
      <div style={{ display: 'flex', gap: 10, padding: 8 }}>
        <Avatar email={c.authorId} name={nameOf(c.authorId)} size={26} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <CommentComposer people={people} initialValue={c.body} autoFocus submitLabel="Save"
            onSubmit={(t) => { onEdit(t); setEditing(false); }} onCancel={() => setEditing(false)} />
        </div>
      </div>
    );
  }
  return (
    <div onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} style={{ display: 'flex', gap: 10, padding: 8, borderRadius: 10, background: c.pinned ? '#fdf6e7' : 'transparent' }}>
      <Avatar email={c.authorId} name={nameOf(c.authorId)} size={26} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: NX.ink }}>{nameOf(c.authorId)}</span>
          <span style={{ fontSize: 11, color: NX.faint }}>{c.createdAt ? new Date(c.createdAt).toLocaleString() : ''}</span>
          {c.editedAt && <span style={{ fontSize: 11, fontStyle: 'italic', color: NX.faint }}>(edited)</span>}
          {c.pinned && <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: NX.amber }}>Pinned</span>}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 2, opacity: hover ? 1 : 0, transition: 'opacity 0.12s' }}>
            <button onClick={onPin} title={c.pinned ? 'Unpin' : 'Pin'} style={{ ...btn('ghost'), padding: 4, color: NX.faint }}><Pin size={12} /></button>
            {mine && <>
              <button onClick={() => setEditing(true)} title="Edit" style={{ ...btn('ghost'), padding: 4, color: NX.faint }}><Pencil size={12} /></button>
              <button onClick={onDelete} title="Delete" style={{ ...btn('ghost'), padding: 4, color: NX.faint }}><Trash2 size={12} /></button>
            </>}
          </div>
        </div>
        <p style={{ margin: '2px 0 0', whiteSpace: 'pre-wrap', fontSize: 13, color: NX.dim }}>{renderWithMentions(c.body, names)}</p>
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
            <div style={{ fontSize: 11, color: NX.faint }}>{a.at ? new Date(a.at).toLocaleString() : ''}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Attachments ─────────────────────────────────────────────────────────────
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
function SubtasksTab({ task, subtasks, createTask, updateTask, people, onOpenSub }) {
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
    <div style={{ marginTop: 14 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: NX.ink, marginBottom: 10 }}>{subtasks.length ? `Subtasks ${done}/${subtasks.length}` : 'Subtasks'}</div>
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, border: `1px dashed ${NX.border}`, borderRadius: 8, padding: '6px 10px', position: 'relative' }}>
        <Plus size={14} style={{ color: NX.faint, flexShrink: 0 }} />
        <input value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} placeholder="Add subtask"
          style={{ flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent', fontFamily: FONT, fontSize: 13 }} />
        {dueOn && <span style={{ fontSize: 11, color: NX.faint }}>{fmtDate(dueOn)}</span>}
        <button onClick={() => (dateRef.current?.showPicker?.() ?? dateRef.current?.focus())} title="Due date" style={{ ...btn('ghost'), padding: 4, color: NX.faint }}><CalendarDays size={15} /></button>
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
      {b.dependencyType && DEP_TYPES[b.dependencyType] && <span style={{ color: NX.faint }}>{DEPENDENCY_TYPE_META[b.dependencyType]?.label || b.dependencyType}</span>}
      {canRemove && <button onClick={() => removeDependency(task, b.id)} style={{ ...btn('ghost'), padding: 2, color: NX.faint }}><X size={13} /></button>}
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
function PropertiesTab({ task, nameOf, projectName, deptName, customFields, people, setCustomFieldValue }) {
  const sm = STATUS_META[task.status] || {};
  const pm = PRIORITY_META[task.priority] || {};
  const rows = [
    ['Task ID', <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{task.code}</span>],
    ['Status', <Chip color={sm.color} tint={sm.tint}>{sm.label}</Chip>],
    ['Priority', <Chip color={pm.color} tint={pm.tint}>{pm.label}</Chip>],
    ['Assignee', task.assigneeId ? <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Avatar email={task.assigneeId} name={nameOf(task.assigneeId)} size={18} /> {nameOf(task.assigneeId)}</span> : 'Unassigned'],
    ['Project', task.projectId ? projectName(task.projectId) : '—'],
    ['Department', task.departmentId ? deptName(task.departmentId) : '—'],
    ['Start date', fmtDate(task.startOn)],
    ['Due date', fmtDate(task.dueOn)],
    ['Estimate', task.estimateHours != null ? `${task.estimateHours}h` : '—'],
    ['Actual', task.actualHours != null ? `${task.actualHours}h` : '—'],
    ['Milestone', task.isMilestone ? 'Yes' : 'No'],
    ['Approval', !task.approvalStatus || task.approvalStatus === 'none' ? '—' : task.approvalStatus.replace('_', ' ')],
    ['Recurrence', recurrenceLabel(task.recurrence)],
    ['Created', fmtDate(task.createdAt)],
    ['Modified', fmtDate(task.modifiedAt)],
    ['Sync', task.syncedWithAsana ? <Chip color="#ffffff" tint="#111827">Synced</Chip> : <Chip color={NX.amber} tint="#fdefd7">Unsynced</Chip>],
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
          <div style={{ fontSize: 13, fontWeight: 700, color: NX.ink, marginBottom: 8 }}>Custom fields</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {customFields.map((f) => (
              <Row key={f.id} label={f.name}>
                <CustomFieldEditor field={f} value={(task.customFieldValues || {})[f.id]} onChange={(v) => setCustomFieldValue(task, f.id, v)} people={people} createdAt={task.createdAt} modifiedAt={task.modifiedAt} />
              </Row>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

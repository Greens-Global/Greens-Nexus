// Task Module - My Tasks page (ported 1:1 from the export's MyTasksPage).
// A dedicated personal view: avatar + "My tasks" header, List/Board/Calendar/
// Dashboard/Files tabs, and a List grouped into the four due-date buckets with
// inline "Add task" rows, a "Task visibility" column, and "Add section".
import { useMemo, useRef, useState } from 'react';
import { ChevronDown, Lock, Globe, Plus, List as ListIcon, Columns3, Calendar as CalIcon, LayoutDashboard, Paperclip, Circle, CheckCircle2, CornerDownRight } from 'lucide-react';
import { useTasks } from './TasksContext';
import { EMPTY_FILTER, matchesFilter, sortTasks, groupTasks, groupAddDefaults, taskIdFromUrl, personScoped, rootParent, effectiveProjectId } from './lib';
import { NX, FONT, btn, CONTROL_H, CONTROL_FS, input as inputStyle, colorForKey } from './theme';
import { Avatar, EmptyState, useClickOutside, useIsMobile, DateField, TaskCountBadges } from './components';
import { ProductivityBar, MobileFilters } from './productivity';
import MobileTaskBar from './MobileTaskBar';
import CreateTaskModal from './CreateTaskModal';
import QuickCreateTask from './QuickCreateTask';
import TaskDetailDrawer from './TaskDetailDrawer';
import { CalendarView, DashboardView } from './views/extras';
import { FilesView } from './views/more';
import BoardView from './views/board';

const VIEW_TABS = [
  { key: 'list', label: 'List', icon: ListIcon },
  { key: 'board', label: 'Board', icon: Columns3 },
  { key: 'calendar', label: 'Calendar', icon: CalIcon },
  { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { key: 'files', label: 'Files', icon: Paperclip },
];
// Group options for the mobile filter drill-in (mirrors the desktop Group select).
const MY_GROUP_OPTIONS = [
  { key: 'date', label: 'Due Date' }, { key: 'status', label: 'Status' }, { key: 'priority', label: 'Priority' },
  { key: 'project', label: 'Project' }, { key: 'assignee', label: 'Assignee' }, { key: 'none', label: 'None' },
];

// Name · Due date · Collaborators · Projects · Task visibility
const COLS = 'minmax(220px,1fr) 118px 132px 150px 138px';
const dueColor = (iso, completed) => {
  if (!iso || completed) return NX.faint;
  const today = new Date().toISOString().slice(0, 10);
  if (iso < today) return NX.red;
  if (iso === today) return NX.amber;
  return NX.dim;
};

function CollaboratorPicker({ value = [], people, onChange, anchor }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef(null);
  useClickOutside(ref, () => setOpen(false), open);
  const toggle = (email) => onChange(value.includes(email) ? value.filter((e) => e !== email) : [...value, email]);
  const filtered = (q.trim()
    ? people.filter((u) => `${u.name} ${u.email}`.toLowerCase().includes(q.trim().toLowerCase()))
    : people
  ).slice().sort((a, b) => (a.name || '').localeCompare(b.name || '', 'en', { sensitivity: 'base' }));
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }} title="Add collaborators" style={{ ...btn('ghost'), padding: '2px 6px', display: 'flex', alignItems: 'center', gap: 3 }}>
        {value.length ? (
          <>
            <div style={{ display: 'flex' }}>{value.slice(0, 3).map((em, i) => <span key={em} style={{ marginLeft: i ? -6 : 0 }}><Avatar email={em} size={20} /></span>)}</div>
            {/* Always-visible "+" so a row with collaborators still reads as
                clickable to add more, not just as a display of who's on it. */}
            <span style={{
              width: 16, height: 16, borderRadius: '50%', border: `1.5px dashed ${NX.border}`,
              color: NX.faint, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}><Plus size={10} /></span>
          </>
        ) : anchor ? <span style={{ color: NX.faint }}>{anchor}</span> : (
          <span style={{
            width: 20, height: 20, borderRadius: '50%', border: `1.5px dashed ${NX.border}`,
            color: NX.faint, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          }}><Plus size={12} /></span>
        )}
      </button>
      {open && (
        <div onClick={(e) => e.stopPropagation()} style={{ position: 'absolute', top: '100%', left: 0, marginTop: 4, width: 208, background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,0.16)', zIndex: 50 }}>
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people…"
            style={{ width: '100%', boxSizing: 'border-box', border: 'none', borderBottom: `1px solid ${NX.border}`, padding: '6px 8px', fontSize: 13, outline: 'none', fontFamily: FONT, background: 'transparent', color: NX.ink }} />
          <div style={{ maxHeight: 200, overflowY: 'auto', padding: 4 }}>
            {filtered.map((u) => (
              <label key={u.email} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', fontSize: 13, cursor: 'pointer' }}>
                <input type="checkbox" checked={value.includes(u.email)} onChange={() => toggle(u.email)} /> {u.name}
              </label>
            ))}
            {filtered.length === 0 && <div style={{ padding: 8, fontSize: 12, color: NX.faint }}>{people.length === 0 ? 'No people' : 'No match'}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function VisibilityChip({ shared }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 9px', borderRadius: 999, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap', color: shared ? NX.green : NX.dim, background: shared ? 'rgba(22,163,74,0.15)' : NX.surface2 }}>
      {shared ? <Globe size={11} /> : <Lock size={11} />} {shared ? 'Shared (public)' : 'Only me'}
    </span>
  );
}

function TaskRow({ t, people, projects, store, onOpen }) {
  // A subtask's project is its parent's; the project cell then names the parent
  // (click-through) rather than offering a select that would re-home the subtask.
  const parent = t.parentTaskId ? rootParent(t, store.taskById) : null;
  const projectId = parent ? effectiveProjectId(t, store.taskById) : t.projectId;
  const shared = (t.followerIds?.length > 0) || !!projectId;
  // Due date reads as a tinted pill (kit grammar), not bare colored text -
  // red tint overdue, amber tint today, quiet gray otherwise.
  const today = new Date().toISOString().slice(0, 10);
  const dueBg = !t.dueOn || t.completed ? 'transparent'
    : t.dueOn < today ? 'rgba(220,38,38,0.10)'
    : t.dueOn === today ? 'rgba(232,163,61,0.16)'
    : NX.surface2;
  return (
    <div onClick={() => onOpen(t.id)} className="stack-table-row" data-task-row style={{ display: 'grid', gridTemplateColumns: COLS, alignItems: 'center', gap: 8, padding: '5px 16px', borderBottom: `1px solid ${NX.border2}`, fontSize: 13.5, cursor: 'pointer' }}
      onMouseEnter={(e) => (e.currentTarget.style.background = NX.hover)} onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
        <button onClick={(e) => { e.stopPropagation(); store.toggleComplete(t); }} style={{ ...btn('ghost'), padding: 0, color: t.completed ? NX.green : NX.faint }}>{t.completed ? <CheckCircle2 size={17} /> : <Circle size={17} />}</button>
        <span title={store.statusMeta?.[t.status]?.label || t.status} style={{ width: 9, height: 9, borderRadius: 3, background: store.statusMeta?.[t.status]?.color || NX.faint, flexShrink: 0 }} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 500, color: t.completed ? NX.faint : NX.ink, textDecoration: t.completed ? 'line-through' : 'none' }}>{t.title}</span>
        {/* Same badges the Task List shows. Without them the same task looked
            emptier here than there, which is the kind of difference that reads
            as data missing rather than as a different screen. */}
        <TaskCountBadges t={t} store={store} />
      </div>
      <DateField value={t.dueOn || ''} onChange={(v) => store.updateTask(t.id, { dueOn: v })} color={dueColor(t.dueOn, t.completed)}
        title="Due Date" style={{ fontSize: 12, fontWeight: 600, padding: '3px 10px', borderRadius: 12, background: dueBg, width: 'fit-content' }} />
      <CollaboratorPicker value={t.followerIds || []} people={people} onChange={(v) => store.updateTask(t.id, { followerIds: v })} />
      {parent ? (
        <button onClick={(e) => { e.stopPropagation(); onOpen(parent.id); }} title={`Subtask of "${parent.title}"${projectId ? ` in ${store.projectName(projectId)}` : ''}`}
          style={{ ...btn('ghost'), padding: '2px 4px', fontSize: 12.5, color: NX.dim, minWidth: 0, maxWidth: '100%', justifyContent: 'flex-start' }}>
          <CornerDownRight size={12} style={{ flexShrink: 0 }} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{parent.title}{projectId ? ` · ${store.projectName(projectId)}` : ''}</span>
        </button>
      ) : (
      <select value={t.projectId || ''} onClick={(e) => e.stopPropagation()} onChange={(e) => store.updateTask(t.id, { projectId: e.target.value || null })}
        style={{ border: '1px solid transparent', borderRadius: 6, padding: '2px 4px', fontSize: 13, color: NX.dim, background: 'transparent', fontFamily: FONT, width: 'fit-content', maxWidth: '100%', cursor: 'pointer' }}>
        <option value="">No project</option>
        {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      )}
      <VisibilityChip shared={shared} />
    </div>
  );
}

function AddTaskRow({ people, projects, onAdd, defaults = {} }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');
  const [dueOn, setDueOn] = useState(defaults.dueOn || '');
  const [followerIds, setFollowerIds] = useState([]);
  const [projectId, setProjectId] = useState(defaults.projectId || '');
  const reset = () => { setTitle(''); setDueOn(defaults.dueOn || ''); setFollowerIds([]); setProjectId(defaults.projectId || ''); setEditing(false); };
  // A task added under a group inherits that group's context (bucket due date,
  // project, status, priority) - the row's own edits win over the defaults.
  const commit = () => {
    if (!title.trim()) return;
    onAdd({
      title: title.trim(), followerIds,
      dueOn: dueOn || defaults.dueOn || null,
      projectId: projectId || defaults.projectId || null,
      status: defaults.status, priority: defaults.priority, teamId: defaults.teamId,
    });
    reset();
  };
  if (!editing) {
    return (
      <button onClick={() => setEditing(true)} style={{ ...btn('ghost'), width: '100%', justifyContent: 'flex-start', padding: '5px 16px 5px 40px', color: NX.faint }}>
        <Plus size={13} /> Add Task...
      </button>
    );
  }
  const shared = followerIds.length > 0 || !!projectId;
  return (
    <div style={{ padding: '6px 16px 6px 32px' }}>
      <div style={{ display: 'grid', gridTemplateColumns: COLS, alignItems: 'center', gap: 8 }}>
        <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') reset(); }}
          placeholder="Task Name" style={{ ...inputStyle, padding: '5px 8px', fontSize: 13, borderColor: NX.blue }} />
        <DateField value={dueOn} onChange={(v) => setDueOn(v || '')} placeholder="Due Date" style={{ ...inputStyle, padding: '4px 6px', fontSize: 12, width: 'fit-content' }} />
        <CollaboratorPicker value={followerIds} people={people} onChange={setFollowerIds} anchor="Add" />
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} style={{ ...inputStyle, padding: '4px 6px', fontSize: 13, width: 'fit-content', maxWidth: '100%' }}>
          <option value="">No project</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <VisibilityChip shared={shared} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 6 }}>
        <button onClick={reset} style={{ ...btn('ghost'), fontSize: 11, padding: '4px 8px' }}>Cancel</button>
        <button onClick={commit} disabled={!title.trim()} style={{ ...btn('primary'), fontSize: 11, padding: '5px 10px', opacity: title.trim() ? 1 : 0.4 }}>Add Task</button>
      </div>
    </div>
  );
}

export default function MyTasksView() {
  const store = useTasks();
  const { tasks, projects, myEmail, createTask, nameOf } = store;
  const [view, setView] = useState('list');
  const [group, setGroup] = useState('date');
  const [filters, setFilters] = useState(EMPTY_FILTER);
  const [sort, setSort] = useState({ key: 'manual', dir: 'asc' });
  const [openId, setOpenId] = useState(taskIdFromUrl);
  const [creating, setCreating] = useState(null); // full CreateTaskModal defaults (desktop / "Full details")
  const [quickCreate, setQuickCreate] = useState(null); // mobile Asana-style quick-add defaults
  const isMobile = useIsMobile();
  // Mobile → lightweight quick-add sheet; desktop → the full form. Same context defaults either way.
  const openCreate = (defs) => (isMobile ? setQuickCreate(defs) : setCreating(defs));

  // People directory for collaborator pickers (excludes me - I'm the assignee).
  const people = useMemo(() => {
    const seen = new Map();
    for (const t of tasks) for (const em of (t.followerIds || [])) if (em && !seen.has(em)) seen.set(em, { email: em, name: nameOf(em) });
    for (const p of projects) for (const em of (p.memberIds || [])) if (em && !seen.has(em)) seen.set(em, { email: em, name: nameOf(em) });
    return [...seen.values()].filter((u) => u.email !== myEmail);
  }, [tasks, projects, myEmail, nameOf]);

  const filter = { ...filters, assigneeIds: myEmail ? [myEmail] : [] };
  // My Tasks is a to-do list, so finished work is hidden by default. Asking for
  // it explicitly (Filters -> Completed) has to win over that default, or the
  // filter matches nothing and reads as broken. `completed` and `status` are
  // kept in sync server-side, so the status filter alone is enough to decide.
  // Switching tabs starts clean. A filter set in List used to follow you into
  // Board, where the panel is out of sight, so the missing rows read as lost
  // data rather than a filter still doing its job. Saved Views set the view and
  // its filters together and go through onApplyView, not this.
  const switchView = (next) => { setView(next); setFilters(EMPTY_FILTER); };

  const wantsCompleted = filters.statuses.includes('completed');
  // Subtasks assigned to me are rows here, as in Asana's My Tasks - see
  // personScoped in lib.js for why the old top-level-only rule was wrong.
  const mine = useMemo(
    () => sortTasks(personScoped(tasks, filter).filter((t) => (wantsCompleted || !t.completed)
                                        && matchesFilter(t, filter, store.taskById)), sort),
    [tasks, filters, sort, myEmail, wantsCompleted, store.taskById],
  );
  const allMine = useMemo(() => personScoped(tasks, filter).filter((t) => matchesFilter(t, filter, store.taskById)), [tasks, filters, myEmail, store.taskById]);
  const ctx = { nameOf, projectName: store.projectName, teamName: store.teamName, taskById: store.taskById };
  const groups = useMemo(() => groupTasks(mine, group, ctx), [mine, group, nameOf, store.projectName, store.teamName, store.taskById]);
  const boardTasks = useMemo(() => sortTasks(allMine, sort), [allMine, sort]);

  const addTask = ({ title, dueOn, followerIds, projectId, status, priority, teamId }) =>
    createTask({ title, assigneeId: myEmail, status: status || 'not_started', priority: priority || 'medium', type: 'task', dueOn: dueOn || '', followerIds, projectId: projectId || '', teamId: teamId || '' }).catch(() => {});


  return (
    <div style={{ fontFamily: FONT, color: NX.ink, display: 'flex', flexDirection: 'column', height: '100%', background: NX.canvas }}>
      {/* Header - white band over the gray canvas (same anatomy as the project
          workspace; the agreed world is cards on canvas, never a white page). */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: isMobile ? '12px 12px 8px' : '18px 24px 12px', flexWrap: 'wrap', background: NX.surface }}>
        {/* No avatar: you already know whose tasks these are, and no chevron -
            the title never opened a menu, so a decorative dropdown affordance
            is a lie (owner flag, Jul 28) */}
        <div style={{ fontSize: isMobile ? 19 : 22, fontWeight: 700 }}>My Tasks</div>
        {!isMobile && <button style={{ ...btn('primary'), marginLeft: 'auto' }} onClick={() => openCreate({ assigneeId: myEmail })}><Plus size={15} /> New Task</button>}
      </div>

      {/* Desktop: view tabs + toolbar. Mobile: replaced by the floating MobileTaskBar. */}
      {!isMobile && (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, borderBottom: `1px solid ${NX.border}`, padding: '0 24px', flexWrap: 'wrap', background: NX.surface }}>
        {/* Segmented view switcher - same control as the project workspace's
            (consistency overwrite, Jul 28: no more underline tabs here) */}
        <div data-tour="task-views" className="scroll-tabs" style={{ display: 'flex', alignItems: 'center', gap: 2, background: NX.border2, borderRadius: 9, padding: 2, margin: '8px 0', overflowX: 'auto', flexShrink: 0 }}>
          {VIEW_TABS.map((tb) => (
            <button key={tb.key} onClick={() => switchView(tb.key)} title={tb.label} style={{
              ...btn('ghost'), padding: '6px 10px', borderRadius: 7, whiteSpace: 'nowrap',
              background: view === tb.key ? NX.surface : 'transparent', color: view === tb.key ? NX.ink : NX.dim,
              boxShadow: view === tb.key ? '0 1px 2px rgba(0,0,0,0.08)' : 'none',
            }}><tb.icon size={15} /> {tb.label}</button>
          ))}
        </div>
        {view === 'list' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', overflowX: 'visible', flexWrap: 'wrap' }}>
            <ProductivityBar filters={filters} setFilters={setFilters} sort={sort} setSort={setSort} hideAssignee current={{ view, group }} onApplyView={(v) => { if (v.group) setGroup(v.group); }} onOpenTask={setOpenId} />
            <select value={group} onChange={(e) => setGroup(e.target.value)} style={{ ...inputStyle, width: 'auto', flexShrink: 0, cursor: 'pointer', height: CONTROL_H, fontSize: CONTROL_FS, padding: '0 8px' }}>
              {['date', 'status', 'priority', 'project', 'assignee', 'none'].map((g) => <option key={g} value={g}>Group: {g === 'date' ? 'Due Date' : g === 'none' ? 'None' : g[0].toUpperCase() + g.slice(1)}</option>)}
            </select>
          </div>
        )}
      </div>
      )}

      {/* Body */}
      <div className="nx-scroll nx-gutter" style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: view === 'list' ? 16 : 0, paddingBottom: isMobile ? 88 : 76 }}>
        {view === 'list' ? (
          <div className={isMobile ? 'nx-edge-card' : undefined} style={{ border: `1px solid ${NX.border}`, borderRadius: 12, overflow: 'hidden', background: NX.surface }}>
            {/* Fixed-width columns (Due date/Collaborators/Projects/Visibility) don't
                shrink below their content size - scroll horizontally on narrow
                viewports instead of getting clipped by the card's rounded corners. */}
            <div style={{ overflowX: 'auto' }}>
              <div style={{ minWidth: 700 }}>
                <div style={{ display: 'grid', gridTemplateColumns: COLS, gap: 8, padding: '6px 16px', borderBottom: `1px solid ${NX.border}`, background: NX.surface2, fontSize: 12.5, fontWeight: 600, color: NX.dim }}>
                  <div>Name</div><div>Due Date</div><div>Collaborators</div><div>Projects</div><div>Task Visibility</div>
                </div>
                {groups.map((g) => {
                  const gc = g.color || colorForKey(g.key);
                  return (
                    /* Group header = a tinted full-width band (kit grammar) so
                       groups read at a glance against white task rows - the
                       color rides a quiet dot, never rails or colored text. */
                    <div key={g.key}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 16px', background: NX.surface2, borderBottom: `1px solid ${NX.border2}`, fontSize: 13.5, fontWeight: 700, color: NX.ink }}>
                        <ChevronDown size={14} style={{ color: NX.faint }} />
                        <span style={{ width: 9, height: 9, borderRadius: 3, background: gc, flexShrink: 0 }} />
                        {g.label} <span style={{ color: NX.faint, fontWeight: 600, fontSize: 12 }}>{g.tasks.length} item{g.tasks.length !== 1 ? 's' : ''}</span>
                      </div>
                      {g.tasks.map((t) => <TaskRow key={t.id} t={t} people={people} projects={projects} store={store} onOpen={setOpenId} />)}
                      <AddTaskRow key={`add-${group}-${g.key}`} people={people} projects={projects} onAdd={addTask} defaults={groupAddDefaults(group, g.key)} />
                    </div>
                  );
                })}
              </div>
            </div>
            {/* Said "Add Section" and opened the Create Task modal. There are no
                sections on this screen - the groups above come from the group-by
                control - so it is what it always was: a new task assigned to me. */}
            <button onClick={() => openCreate({ assigneeId: myEmail })} style={{ ...btn('ghost'), padding: '8px 16px', color: NX.faint }}><Plus size={15} /> Add Task</button>
          </div>
        ) : view === 'calendar' ? (
          <CalendarView tasks={mine} onOpen={setOpenId} onCreate={(iso) => openCreate({ assigneeId: myEmail, dueOn: iso })} />
        ) : view === 'files' ? (
          <FilesView tasks={allMine} onOpen={setOpenId} nameOf={nameOf} />
        ) : view === 'dashboard' ? (
          <DashboardView tasks={allMine} stats={{}} store={store} scopeKey="my-tasks" />
        ) : (
          // Same board as a project's (status columns, drag-and-drop, WIP limits,
          // swimlanes, Add section). Completed tasks are included so the
          // Completed column isn't always empty.
          <BoardView visible={boardTasks} ctx={ctx} store={store} onOpen={setOpenId} defaultAssigneeId={myEmail} />
        )}
        {view === 'list' && mine.length === 0 && group !== 'date' && <EmptyState icon={CheckCircle2} title="No Tasks" hint="You're all caught up." />}
      </div>

      {isMobile && (
        <MobileTaskBar
          views={VIEW_TABS} view={view} setView={switchView}
          onCreate={() => openCreate({ assigneeId: myEmail })}
          filterSheet={(onClose) => (
            <MobileFilters
              filters={filters} setFilters={setFilters} sort={sort} setSort={setSort}
              group={group} setGroup={setGroup} groupOptions={MY_GROUP_OPTIONS} hideAssignee
              current={{ view, group }} onApplyView={(v) => { if (v.group) setGroup(v.group); }}
              onClose={onClose}
            />
          )}
        />
      )}

      {quickCreate && <QuickCreateTask defaults={quickCreate} onClose={() => setQuickCreate(null)} onFullDetails={(d) => { setQuickCreate(null); setCreating({ ...quickCreate, ...d }); }} />}
      {creating && <CreateTaskModal defaults={creating} onClose={() => setCreating(null)} />}
      {openId && <TaskDetailDrawer taskId={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

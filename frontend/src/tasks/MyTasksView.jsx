// Task Module — My Tasks page (ported 1:1 from the export's MyTasksPage).
// A dedicated personal view: avatar + "My tasks" header, List/Board/Calendar/
// Dashboard/Files tabs, and a List grouped into the four due-date buckets with
// inline "Add task" rows, a "Task visibility" column, and "Add section".
import { useMemo, useRef, useState } from 'react';
import { ChevronDown, Lock, Globe, Plus, List as ListIcon, Columns3, Calendar as CalIcon, LayoutDashboard, Paperclip, Circle, CheckCircle2 } from 'lucide-react';
import { useTasks } from './TasksContext';
import { EMPTY_FILTER, matchesFilter, sortTasks, groupTasks } from './lib';
import { NX, FONT, btn, input as inputStyle } from './theme';
import { Avatar, EmptyState } from './components';
import { ProductivityBar } from './productivity';
import CreateTaskModal from './CreateTaskModal';
import TaskDetailDrawer from './TaskDetailDrawer';
import { CalendarView, DashboardView } from './views/extras';
import { FilesView } from './views/more';

const VIEW_TABS = [
  { key: 'list', label: 'List', icon: ListIcon },
  { key: 'board', label: 'Board', icon: Columns3 },
  { key: 'calendar', label: 'Calendar', icon: CalIcon },
  { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { key: 'files', label: 'Files', icon: Paperclip },
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
  const ref = useRef(null);
  const toggle = (email) => onChange(value.includes(email) ? value.filter((e) => e !== email) : [...value, email]);
  return (
    <div ref={ref} style={{ position: 'relative' }} onMouseLeave={() => setOpen(false)}>
      <button onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }} style={{ ...btn('ghost'), padding: '2px 6px' }}>
        {value.length ? (
          <div style={{ display: 'flex' }}>{value.slice(0, 3).map((em, i) => <span key={em} style={{ marginLeft: i ? -6 : 0 }}><Avatar email={em} size={20} /></span>)}</div>
        ) : <span style={{ color: NX.faint }}>{anchor || '—'}</span>}
      </button>
      {open && (
        <div onClick={(e) => e.stopPropagation()} style={{ position: 'absolute', top: '100%', left: 0, marginTop: 4, width: 208, background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,0.16)', zIndex: 50, maxHeight: 240, overflowY: 'auto', padding: 4 }}>
          {people.map((u) => (
            <label key={u.email} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" checked={value.includes(u.email)} onChange={() => toggle(u.email)} /> {u.name}
            </label>
          ))}
          {people.length === 0 && <div style={{ padding: 8, fontSize: 12, color: NX.faint }}>No people</div>}
        </div>
      )}
    </div>
  );
}

function VisibilityChip({ shared }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 9px', borderRadius: 999, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap', color: shared ? NX.green : NX.dim, background: shared ? '#e3f5ea' : NX.surface2 }}>
      {shared ? <Globe size={11} /> : <Lock size={11} />} {shared ? 'Shared (public)' : 'Only me'}
    </span>
  );
}

function TaskRow({ t, people, projects, store, onOpen }) {
  const shared = (t.followerIds?.length > 0) || !!t.projectId;
  return (
    <div onClick={() => onOpen(t.id)} className="stack-table-row" style={{ display: 'grid', gridTemplateColumns: COLS, alignItems: 'center', gap: 8, padding: '8px 16px', borderBottom: `1px solid ${NX.border2}`, fontSize: 13, cursor: 'pointer' }}
      onMouseEnter={(e) => (e.currentTarget.style.background = NX.hover)} onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <button onClick={(e) => { e.stopPropagation(); store.toggleComplete(t); }} style={{ ...btn('ghost'), padding: 0, color: t.completed ? NX.green : NX.faint }}>{t.completed ? <CheckCircle2 size={16} /> : <Circle size={16} />}</button>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: t.completed ? NX.faint : NX.ink, textDecoration: t.completed ? 'line-through' : 'none' }}>{t.title}</span>
      </div>
      <input type="date" value={t.dueOn || ''} onClick={(e) => e.stopPropagation()} onChange={(e) => store.updateTask(t.id, { dueOn: e.target.value || null })}
        style={{ border: '1px solid transparent', borderRadius: 6, padding: '2px 4px', fontSize: 12, fontWeight: 500, fontFamily: FONT, background: 'transparent', color: dueColor(t.dueOn, t.completed), width: 'fit-content', cursor: 'pointer' }} />
      <CollaboratorPicker value={t.followerIds || []} people={people} onChange={(v) => store.updateTask(t.id, { followerIds: v })} />
      <select value={t.projectId || ''} onClick={(e) => e.stopPropagation()} onChange={(e) => store.updateTask(t.id, { projectId: e.target.value || null })}
        style={{ border: '1px solid transparent', borderRadius: 6, padding: '2px 4px', fontSize: 13, color: NX.dim, background: 'transparent', fontFamily: FONT, width: 'fit-content', maxWidth: '100%', cursor: 'pointer' }}>
        <option value="">No project</option>
        {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <VisibilityChip shared={shared} />
    </div>
  );
}

function AddTaskRow({ people, projects, onAdd }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');
  const [dueOn, setDueOn] = useState('');
  const [followerIds, setFollowerIds] = useState([]);
  const [projectId, setProjectId] = useState('');
  const reset = () => { setTitle(''); setDueOn(''); setFollowerIds([]); setProjectId(''); setEditing(false); };
  const commit = () => { if (!title.trim()) return; onAdd({ title: title.trim(), dueOn: dueOn || null, followerIds, projectId: projectId || null }); reset(); };
  if (!editing) {
    return (
      <button onClick={() => setEditing(true)} style={{ ...btn('ghost'), width: '100%', justifyContent: 'flex-start', padding: '8px 16px 8px 40px', color: NX.faint }}>
        <Plus size={13} /> Add task...
      </button>
    );
  }
  const shared = followerIds.length > 0 || !!projectId;
  return (
    <div style={{ padding: '6px 16px 6px 32px' }}>
      <div style={{ display: 'grid', gridTemplateColumns: COLS, alignItems: 'center', gap: 8 }}>
        <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') reset(); }}
          placeholder="Task name" style={{ ...inputStyle, padding: '5px 8px', fontSize: 13, borderColor: NX.blue }} />
        <input type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} style={{ ...inputStyle, padding: '4px 6px', fontSize: 12, width: 'fit-content' }} />
        <CollaboratorPicker value={followerIds} people={people} onChange={setFollowerIds} anchor="Add" />
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} style={{ ...inputStyle, padding: '4px 6px', fontSize: 13, width: 'fit-content', maxWidth: '100%' }}>
          <option value="">No project</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <VisibilityChip shared={shared} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 6 }}>
        <button onClick={reset} style={{ ...btn('ghost'), fontSize: 11, padding: '4px 8px' }}>Cancel</button>
        <button onClick={commit} disabled={!title.trim()} style={{ ...btn('primary'), fontSize: 11, padding: '5px 10px', opacity: title.trim() ? 1 : 0.4 }}>Add task</button>
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
  const [openId, setOpenId] = useState(null);
  const [creating, setCreating] = useState(false);

  // People directory for collaborator pickers (excludes me — I'm the assignee).
  const people = useMemo(() => {
    const seen = new Map();
    for (const t of tasks) for (const em of (t.followerIds || [])) if (em && !seen.has(em)) seen.set(em, { email: em, name: nameOf(em) });
    for (const p of projects) for (const em of (p.memberIds || [])) if (em && !seen.has(em)) seen.set(em, { email: em, name: nameOf(em) });
    return [...seen.values()].filter((u) => u.email !== myEmail);
  }, [tasks, projects, myEmail, nameOf]);

  const filter = { ...filters, assigneeIds: myEmail ? [myEmail] : [] };
  const mine = useMemo(
    () => sortTasks(tasks.filter((t) => !t.parentTaskId && !t.completed && matchesFilter(t, filter)), sort),
    [tasks, filters, sort, myEmail],
  );
  const allMine = useMemo(() => tasks.filter((t) => !t.parentTaskId && matchesFilter(t, filter)), [tasks, filters, myEmail]);
  const groups = useMemo(() => groupTasks(mine, group, { nameOf, projectName: store.projectName, deptName: store.deptName }), [mine, group, nameOf, store.projectName, store.deptName]);

  const addTask = ({ title, dueOn, followerIds, projectId }) =>
    createTask({ title, assigneeId: myEmail, status: 'not_started', priority: 'medium', type: 'task', dueOn: dueOn || '', followerIds, projectId: projectId || '' }).catch(() => {});

  return (
    <div style={{ fontFamily: FONT, color: NX.ink, display: 'flex', flexDirection: 'column', height: '100%', background: NX.surface }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '18px 24px 12px' }}>
        <Avatar email={myEmail} name={nameOf(myEmail)} size={32} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 22, fontWeight: 700 }}>My tasks <ChevronDown size={18} style={{ color: NX.faint }} /></div>
        <button style={{ ...btn('primary'), marginLeft: 'auto' }} onClick={() => setCreating(true)}><Plus size={15} /> New task</button>
      </div>

      {/* View tabs + toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, borderBottom: `1px solid ${NX.border}`, padding: '0 24px', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          {VIEW_TABS.map((tb) => (
            <button key={tb.key} onClick={() => setView(tb.key)} style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '10px 12px', border: 'none', background: 'transparent', cursor: 'pointer',
              borderBottom: `2px solid ${view === tb.key ? NX.ink : 'transparent'}`, fontSize: 13, fontWeight: 600, fontFamily: FONT, color: view === tb.key ? NX.ink : NX.dim,
            }}><tb.icon size={15} /> {tb.label}</button>
          ))}
        </div>
        {view === 'list' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0' }}>
            <ProductivityBar filters={filters} setFilters={setFilters} sort={sort} setSort={setSort} current={{ view, group }} onApplyView={(v) => { if (v.group) setGroup(v.group); }} onOpenTask={setOpenId} />
            <select value={group} onChange={(e) => setGroup(e.target.value)} style={{ ...inputStyle, width: 'auto', cursor: 'pointer' }}>
              {['date', 'status', 'priority', 'project', 'assignee', 'none'].map((g) => <option key={g} value={g}>Group: {g === 'date' ? 'Due date' : g === 'none' ? 'None' : g[0].toUpperCase() + g.slice(1)}</option>)}
            </select>
          </div>
        )}
      </div>

      {/* Body */}
      <div className="nx-scroll" style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: view === 'list' ? 16 : 0 }}>
        {view === 'list' ? (
          <div style={{ border: `1px solid ${NX.border}`, borderRadius: 12, overflow: 'hidden', background: NX.surface }}>
            <div style={{ display: 'grid', gridTemplateColumns: COLS, gap: 8, padding: '8px 16px', borderBottom: `1px solid ${NX.border}`, background: NX.surface2, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: NX.faint }}>
              <div>Name</div><div>Due date</div><div>Collaborators</div><div>Projects</div><div>Task visibility</div>
            </div>
            {groups.map((g) => (
              <div key={g.key}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', background: NX.surface2, borderBottom: `1px solid ${NX.border2}`, fontSize: 13, fontWeight: 700 }}>
                  {g.color && <span style={{ width: 10, height: 10, borderRadius: '50%', background: g.color }} />}
                  <ChevronDown size={14} style={{ color: NX.faint }} /> {g.label} <span style={{ color: NX.faint, fontWeight: 400 }}>{g.tasks.length}</span>
                </div>
                {g.tasks.map((t) => <TaskRow key={t.id} t={t} people={people} projects={projects} store={store} onOpen={setOpenId} />)}
                <AddTaskRow people={people} projects={projects} onAdd={addTask} />
              </div>
            ))}
            <button onClick={() => setCreating(true)} style={{ ...btn('ghost'), padding: '12px 16px', color: NX.faint }}><Plus size={15} /> Add section</button>
          </div>
        ) : view === 'calendar' ? (
          <CalendarView tasks={mine} onOpen={setOpenId} />
        ) : view === 'files' ? (
          <FilesView tasks={allMine} onOpen={setOpenId} />
        ) : view === 'dashboard' ? (
          <DashboardView tasks={allMine} stats={{}} store={store} />
        ) : (
          <BoardMini groups={groupTasks(mine, group === 'date' ? 'status' : group, { nameOf, projectName: store.projectName })} store={store} onOpen={setOpenId} />
        )}
        {view === 'list' && mine.length === 0 && group !== 'date' && <EmptyState icon={CheckCircle2} title="No tasks" hint="You're all caught up." />}
      </div>

      {creating && <CreateTaskModal defaults={{ assigneeId: myEmail }} onClose={() => setCreating(false)} />}
      {openId && <TaskDetailDrawer taskId={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

function BoardMini({ groups, store, onOpen }) {
  return (
    <div style={{ display: 'flex', gap: 14, padding: 16, alignItems: 'flex-start', minHeight: '100%', background: NX.canvas }}>
      {groups.map((c) => (
        <div key={c.key} style={{ width: 280, flexShrink: 0, background: NX.surface, borderRadius: 12, border: `1px solid ${NX.border}` }}>
          <div style={{ padding: '11px 13px', borderBottom: `1px solid ${NX.border2}`, fontSize: 13, fontWeight: 700, display: 'flex', justifyContent: 'space-between' }}>
            <span>{c.label || 'Tasks'}</span><span style={{ color: NX.faint }}>{c.tasks.length}</span>
          </div>
          <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {c.tasks.map((t) => (
              <div key={t.id} onClick={() => onOpen(t.id)} style={{ background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 10, padding: 11, cursor: 'pointer', fontSize: 13.5, fontWeight: 500 }}>{t.title}</div>
            ))}
            {c.tasks.length === 0 && <div style={{ fontSize: 12, color: NX.faint, textAlign: 'center', padding: 12 }}>Empty</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

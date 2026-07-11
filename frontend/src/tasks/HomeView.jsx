// Task Module — Home (ported 1:1 from the export's HomePage). A customizable
// widget dashboard: a "My week/day/month" header with completed/collaborator
// stats + Customize, over a reorderable grid of widgets (My tasks · Projects ·
// Teams · Team members · Notifications), persisted to localStorage.
import { useMemo, useRef, useState } from 'react';
import { MoreHorizontal, ChevronDown, ChevronRight, CheckCircle2, Users, LayoutGrid, Plus, Circle, CalendarDays, FolderKanban, Bell, ArrowUp, ArrowDown, X, Building2 } from 'lucide-react';
import { useTasks } from './TasksContext';
import { NX, FONT, btn, card } from './theme';
import { Avatar } from './components';
import TaskDetailDrawer from './TaskDetailDrawer';

const WIDGET_META = [
  { key: 'my_tasks', label: 'My tasks' },
  { key: 'projects', label: 'Projects' },
  { key: 'teams', label: 'Teams' },
  { key: 'team_members', label: 'Team members' },
  { key: 'notifications', label: 'Notifications' },
];
const DEFAULT_LAYOUT = ['my_tasks', 'projects'];
const LAYOUT_KEY = 'nexus.homeWidgets';
const TABS = ['Upcoming', 'Overdue', 'Completed'];
const RANGES = [{ key: 'day', label: 'My day', days: 0 }, { key: 'week', label: 'My week', days: 7 }, { key: 'month', label: 'My month', days: 30 }];

const todayISO = () => new Date().toISOString().slice(0, 10);
const addDays = (iso, n) => { const d = new Date(iso); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const fmtUS = (iso) => { if (!iso) return ''; const d = new Date(iso + 'T00:00:00'); return isNaN(d) ? iso : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); };
const dueColor = (iso, done) => { if (!iso || done) return NX.faint; const t = todayISO(); return iso < t ? NX.red : iso === t ? NX.amber : NX.dim; };

export default function HomeView({ onNavigate }) {
  const store = useTasks();
  const { tasks, projects, departments, notifications, myEmail, nameOf, createTask, toggleComplete } = store;
  const [tab, setTab] = useState('Upcoming');
  const [range, setRange] = useState('week');
  const [rangeOpen, setRangeOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newDue, setNewDue] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [customizing, setCustomizing] = useState(false);
  const dateRef = useRef(null);
  const [widgets, setWidgets] = useState(() => {
    try { const raw = JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null'); if (Array.isArray(raw) && raw.length) return raw.filter((k) => WIDGET_META.some((w) => w.key === k)); } catch { /* */ }
    return DEFAULT_LAYOUT;
  });
  const persist = (next) => { localStorage.setItem(LAYOUT_KEY, JSON.stringify(next)); setWidgets(next); };

  const myTasks = useMemo(() => tasks.filter((t) => !t.parentTaskId && t.assigneeId === myEmail), [tasks, myEmail]);
  const rangeDef = RANGES.find((r) => r.key === range);
  const rangeEnd = addDays(todayISO(), rangeDef.days);
  const overdue = myTasks.filter((t) => !t.completed && t.dueOn && t.dueOn < todayISO());
  const completed = myTasks.filter((t) => t.completed);
  const upcoming = myTasks.filter((t) => !t.completed && (!t.dueOn || (t.dueOn >= todayISO() && t.dueOn <= rangeEnd)));
  const shown = tab === 'Upcoming' ? upcoming : tab === 'Overdue' ? overdue : completed;
  const collaborators = useMemo(() => { const s = new Set(); for (const t of myTasks) for (const f of (t.followerIds || [])) if (f !== myEmail) s.add(f); return s.size; }, [myTasks, myEmail]);
  const myDepartments = useMemo(() => departments.filter((d) => (d.memberIds || []).includes(myEmail)), [departments, myEmail]);
  const teamMembers = useMemo(() => { const s = new Set(); myDepartments.forEach((d) => (d.memberIds || []).forEach((id) => s.add(id))); return [...s]; }, [myDepartments]);
  const recentProjects = projects.slice(0, 4);

  const cancelCreate = () => { setCreating(false); setNewTitle(''); setNewDue(null); };
  const commitCreate = async (openDetails) => {
    const title = newTitle.trim();
    if (!title) { if (!openDetails) cancelCreate(); return; }
    const t = await createTask({ title, assigneeId: myEmail, dueOn: newDue || '', status: 'not_started', priority: 'medium', type: 'task' }).catch(() => null);
    setNewTitle(''); setNewDue(null);
    if (openDetails && t) { setCreating(false); setOpenId(t.id); }
  };

  const widgetBox = (children) => <div style={{ ...card, borderRadius: 16, padding: 20 }}>{children}</div>;
  const moreBtn = (onClick) => <button onClick={onClick} style={{ ...btn('outline'), padding: 6 }}><MoreHorizontal size={16} /></button>;

  const renderWidget = (key) => {
    if (key === 'my_tasks') return widgetBox(
      <>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Avatar email={myEmail} name={nameOf(myEmail)} size={38} />
            <button onClick={() => onNavigate('mine')} style={{ ...btn('ghost'), padding: 0, fontSize: 16, fontWeight: 700, color: NX.ink }}>My tasks</button>
          </div>
          {moreBtn(() => onNavigate('mine'))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, borderBottom: `1px solid ${NX.border}`, marginBottom: 10, fontSize: 13, fontWeight: 600 }}>
          {TABS.map((t) => (
            <button key={t} onClick={() => setTab(t)} style={{ border: 'none', background: 'transparent', cursor: 'pointer', paddingBottom: 8, borderBottom: `2px solid ${tab === t ? NX.ink : 'transparent'}`, color: tab === t ? NX.ink : NX.dim, fontFamily: FONT, fontWeight: 600 }}>
              {t}{t === 'Overdue' && overdue.length > 0 ? ` (${overdue.length})` : ''}
            </button>
          ))}
        </div>
        {creating ? (
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 8, borderBottom: `2px solid ${NX.blue}`, padding: '6px 0', marginBottom: 4 }}>
            <Circle size={16} style={{ color: NX.faint, flexShrink: 0 }} />
            <input autoFocus value={newTitle} onChange={(e) => setNewTitle(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') commitCreate(false); if (e.key === 'Escape') cancelCreate(); }} onBlur={() => commitCreate(false)} placeholder="Write a task name" style={{ flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent', fontFamily: FONT, fontSize: 13, color: NX.ink }} />
            {newDue && <span style={{ fontSize: 12, fontWeight: 500, color: dueColor(newDue, false) }}>{fmtUS(newDue)}</span>}
            <button onMouseDown={(e) => { e.preventDefault(); dateRef.current?.showPicker?.() ?? dateRef.current?.focus(); }} style={{ ...btn('ghost'), padding: 4, color: NX.faint }} title="Set due date"><CalendarDays size={16} /></button>
            <input ref={dateRef} type="date" value={newDue ?? ''} onChange={(e) => setNewDue(e.target.value || null)} style={{ position: 'absolute', width: 0, height: 0, opacity: 0 }} tabIndex={-1} />
            <button onMouseDown={(e) => { e.preventDefault(); commitCreate(true); }} style={{ ...btn('ghost'), padding: 4, color: NX.faint }} title="Details"><ChevronRight size={16} /></button>
          </div>
        ) : (
          <button onClick={() => setCreating(true)} style={{ ...btn('ghost'), padding: '6px 0', color: NX.dim, fontSize: 13, fontWeight: 500 }}><Plus size={15} /> Create task</button>
        )}
        {shown.length === 0 ? <p style={{ padding: '24px 0', textAlign: 'center', fontSize: 13, color: NX.faint }}>Nothing here.</p> : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {shown.map((t) => (
              <div key={t.id} onClick={() => setOpenId(t.id)} style={{ display: 'flex', alignItems: 'center', gap: 8, borderTop: `1px solid ${NX.border2}`, padding: '8px 0', fontSize: 13, cursor: 'pointer' }}>
                <button onClick={(e) => { e.stopPropagation(); toggleComplete(t); }} style={{ ...btn('ghost'), padding: 0, color: t.completed ? NX.green : NX.faint }}>{t.completed ? <CheckCircle2 size={16} /> : <Circle size={16} />}</button>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: t.completed ? NX.faint : NX.ink, textDecoration: t.completed ? 'line-through' : 'none' }}>{t.title}</span>
                {t.dueOn && <span style={{ fontSize: 12, fontWeight: 500, color: dueColor(t.dueOn, t.completed) }}>{fmtUS(t.dueOn)}</span>}
              </div>
            ))}
          </div>
        )}
      </>
    );
    if (key === 'projects') return widgetBox(
      <>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Projects</h2>
          {moreBtn(() => onNavigate('projects'))}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <button onClick={() => onNavigate('projects')} style={{ display: 'flex', alignItems: 'center', gap: 12, border: `1px dashed ${NX.border}`, borderRadius: 12, padding: 12, cursor: 'pointer', background: 'transparent', textAlign: 'left', fontFamily: FONT }}>
            <span style={{ display: 'flex', width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 10, border: `1px dashed ${NX.border}`, color: NX.faint }}><Plus size={18} /></span>
            <span style={{ fontSize: 13, fontWeight: 600, color: NX.dim }}>Create project</span>
          </button>
          {recentProjects.map((p) => (
            <button key={p.id} onClick={() => onNavigate({ projectId: p.id })} style={{ display: 'flex', alignItems: 'center', gap: 12, border: `1px solid ${NX.border}`, borderRadius: 12, padding: 12, cursor: 'pointer', background: NX.surface, textAlign: 'left', fontFamily: FONT }}>
              <span style={{ display: 'flex', width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 10, background: `${p.color || NX.purple}26`, color: p.color || NX.purple }}><FolderKanban size={18} /></span>
              <span style={{ fontSize: 13, fontWeight: 600, color: NX.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
            </button>
          ))}
        </div>
      </>
    );
    if (key === 'teams') return widgetBox(
      <>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Teams</h2>
          {moreBtn(() => onNavigate('teams'))}
        </div>
        {myDepartments.length === 0 ? <p style={{ padding: '16px 0', fontSize: 13, color: NX.faint }}>You're not part of any team yet.</p> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {myDepartments.map((d) => {
              const pc = projects.filter((p) => p.departmentId === d.id).length;
              return (
                <button key={d.id} onClick={() => onNavigate('teams')} style={{ display: 'flex', alignItems: 'center', gap: 12, border: `1px solid ${NX.border}`, borderRadius: 12, padding: 12, cursor: 'pointer', background: NX.surface, textAlign: 'left', fontFamily: FONT }}>
                  <span style={{ display: 'flex', width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 9, background: `${d.color}1a`, color: d.color }}><Building2 size={18} /></span>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: NX.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</div>
                    <div style={{ fontSize: 12, color: NX.faint }}>{(d.memberIds || []).length} member{(d.memberIds || []).length === 1 ? '' : 's'} · {pc} project{pc === 1 ? '' : 's'}</div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </>
    );
    if (key === 'team_members') return widgetBox(
      <>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
          <Building2 size={18} style={{ color: NX.faint }} /><h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Team members</h2><span style={{ fontSize: 13, color: NX.faint }}>{teamMembers.length}</span>
        </div>
        {teamMembers.length === 0 ? <p style={{ padding: '16px 0', fontSize: 13, color: NX.faint }}>No teammates yet.</p> : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            {teamMembers.map((em) => (
              <div key={em} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Avatar email={em} name={nameOf(em)} size={34} />
                <div style={{ minWidth: 0 }}><div style={{ fontSize: 13, fontWeight: 600, color: NX.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nameOf(em)}</div></div>
              </div>
            ))}
          </div>
        )}
      </>
    );
    if (key === 'notifications') return widgetBox(
      <>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
          <Bell size={18} style={{ color: NX.faint }} /><h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Notifications</h2>
        </div>
        {(notifications || []).length === 0 ? <p style={{ padding: '16px 0', fontSize: 13, color: NX.faint }}>You're all caught up.</p> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {(notifications || []).slice(0, 6).map((n) => (
              <div key={n.id} style={{ display: 'flex', flexDirection: 'column' }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: NX.ink }}>{n.title}</span>
                <span style={{ fontSize: 12, color: NX.dim }}>{n.body}</span>
              </div>
            ))}
          </div>
        )}
      </>
    );
    return null;
  };

  return (
    <div style={{ padding: 24, fontFamily: FONT, color: NX.ink }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'flex-end', gap: 12, marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ position: 'relative' }} onMouseLeave={() => setRangeOpen(false)}>
            <button onClick={() => setRangeOpen((o) => !o)} style={{ ...btn('outline') }}>{rangeDef.label} <ChevronDown size={14} style={{ color: NX.faint }} /></button>
            {rangeOpen && (
              <div style={{ position: 'absolute', top: '100%', left: 0, marginTop: 4, width: 150, background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,0.16)', zIndex: 40, padding: 4 }}>
                {RANGES.map((r) => <button key={r.key} onClick={() => { setRange(r.key); setRangeOpen(false); }} style={{ ...btn('ghost'), width: '100%', justifyContent: 'flex-start', color: range === r.key ? NX.blue : NX.ink }}>{r.label}</button>)}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, border: `1px solid ${NX.border}`, borderRadius: 8, padding: '8px 12px', fontSize: 13, color: NX.dim }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><CheckCircle2 size={14} style={{ color: NX.green }} /> {completed.length} tasks completed</span>
            <span style={{ width: 1, height: 16, background: NX.border }} />
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Users size={14} /> {collaborators} collaborator{collaborators === 1 ? '' : 's'}</span>
          </div>
          <button onClick={() => setCustomizing(true)} style={{ ...btn('primary') }}><LayoutGrid size={14} /> Customize</button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16, alignItems: 'start' }}>
        {widgets.map((key) => <div key={key} style={{ minWidth: 0 }}>{renderWidget(key)}</div>)}
      </div>

      {customizing && <CustomizeModal widgets={widgets} setWidgets={persist} onClose={() => setCustomizing(false)} />}
      {openId && <TaskDetailDrawer taskId={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

function CustomizeModal({ widgets, setWidgets, onClose }) {
  const [draft, setDraft] = useState(widgets);
  const available = WIDGET_META.filter((w) => !draft.includes(w.key));
  const move = (i, dir) => { const j = i + dir; if (j < 0 || j >= draft.length) return; const n = [...draft]; [n[i], n[j]] = [n[j], n[i]]; setDraft(n); };
  return (
    <div onMouseDown={(e) => e.target === e.currentTarget && onClose()} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 5000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, fontFamily: FONT }}>
      <div style={{ width: 460, maxWidth: '100%', background: NX.surface, borderRadius: 16, border: `1px solid ${NX.border}`, boxShadow: '0 24px 60px rgba(0,0,0,0.28)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: `1px solid ${NX.border}`, padding: '14px 20px' }}>
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>Customize Home</h2>
          <button onClick={onClose} style={{ ...btn('ghost'), padding: 6 }}><X size={16} /></button>
        </div>
        <div style={{ maxHeight: '70vh', overflow: 'auto', padding: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: NX.faint, marginBottom: 6 }}>Shown widgets</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 }}>
            {draft.length === 0 && <p style={{ fontSize: 12, color: NX.faint }}>No widgets. Add one below.</p>}
            {draft.map((key, i) => (
              <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 8, border: `1px solid ${NX.border}`, borderRadius: 8, padding: '8px 12px' }}>
                <span style={{ flex: 1, fontSize: 13, fontWeight: 500 }}>{WIDGET_META.find((w) => w.key === key)?.label}</span>
                <button onClick={() => move(i, -1)} disabled={i === 0} style={{ ...btn('ghost'), padding: 4, color: NX.faint, opacity: i === 0 ? 0.3 : 1 }}><ArrowUp size={14} /></button>
                <button onClick={() => move(i, 1)} disabled={i === draft.length - 1} style={{ ...btn('ghost'), padding: 4, color: NX.faint, opacity: i === draft.length - 1 ? 0.3 : 1 }}><ArrowDown size={14} /></button>
                <button onClick={() => setDraft(draft.filter((k) => k !== key))} style={{ ...btn('ghost'), padding: 4, color: NX.faint }}><X size={14} /></button>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: NX.faint, marginBottom: 6 }}>Add widgets</div>
          {available.length === 0 ? <p style={{ fontSize: 12, color: NX.faint }}>All widgets are already on your Home.</p> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {available.map((w) => (
                <button key={w.key} onClick={() => setDraft([...draft, w.key])} style={{ display: 'flex', alignItems: 'center', gap: 8, border: `1px dashed ${NX.border}`, borderRadius: 8, padding: '8px 12px', cursor: 'pointer', background: 'transparent', textAlign: 'left', fontFamily: FONT }}>
                  <Plus size={14} style={{ color: NX.faint }} /><span style={{ fontSize: 13, fontWeight: 500 }}>{w.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, borderTop: `1px solid ${NX.border}`, padding: '12px 20px' }}>
          <button onClick={onClose} style={btn('outline')}>Cancel</button>
          <button onClick={() => { setWidgets(draft); onClose(); }} style={btn('primary')}>Save layout</button>
        </div>
      </div>
    </div>
  );
}

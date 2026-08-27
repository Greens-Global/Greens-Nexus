// Task Module - Home (ported 1:1 from the export's HomePage). A customizable
// widget dashboard: a "My week/day/month" header with completed/collaborator
// stats + Customize, over a reorderable grid of widgets (My tasks · Projects ·
// Teams · Team members · Notifications), persisted to localStorage.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, CheckCircle2, Users, LayoutGrid, Plus, Circle, CalendarDays, FolderKanban, Bell, X, Building2, Flag, Clock, GripVertical, Check } from 'lucide-react';
import { useTasks } from './TasksContext';
import { fmtDate, taskIdFromUrl, taskAssignees } from './lib';
import { NX, FONT, btn, card, PRIORITY_ORDER } from './theme';
import { Avatar, useClickOutside, useIsMobile } from './components';
import TaskDetailDrawer from './TaskDetailDrawer';
import { ProjectCreateModal } from './ProjectsView';

const WIDGET_META = [
  { key: 'my_tasks', label: 'My Tasks' },
  { key: 'projects', label: 'Projects' },
  { key: 'urgent', label: 'Urgent tasks' },
  { key: 'activity', label: 'Completed this week' },
  { key: 'week', label: 'Week ahead' },
  { key: 'priorities', label: 'By priority' },
  { key: 'teams', label: 'Teams' },
  { key: 'team_members', label: 'Team Members' },
  { key: 'notifications', label: 'Notifications' },
];
const DEFAULT_LAYOUT = ['my_tasks', 'projects', 'urgent', 'activity', 'week', 'priorities'];
const PRIORITY_COLORS = { urgent: '#fc6363', high: '#ffb546', medium: '#0998c3', low: '#9699a6' };
const LAYOUT_KEY = 'nexus.homeWidgets';
const TABS = ['Upcoming', 'Overdue', 'Completed'];
const RANGES = [{ key: 'day', label: 'My Day', days: 0 }, { key: 'week', label: 'My Week', days: 7 }, { key: 'month', label: 'My Month', days: 30 }];

// Row-order masonry cell: measures its content and spans that many 8px grid
// rows, so widgets keep left-to-right order while short ones pull UP to fill
// vertical gaps (CSS columns flow top-to-bottom per column, which made drop
// positions unpredictable - this replaces that).
function MasonryCell({ masonry, style, children, ...rest }) {
  // Measure a dedicated inner wrapper, NOT firstElementChild - in customize
  // mode the first child is the absolute-positioned grip overlay (~26px),
  // which made every cell claim a tiny span and stack widgets on top of
  // each other. The wrapper's height = the widget's real height (absolute
  // overlays contribute nothing).
  const innerRef = useRef(null);
  const [span, setSpan] = useState(0);
  useEffect(() => {
    if (!masonry) return;
    const el = innerRef.current;
    if (!el) return;
    const measure = () => setSpan((s) => {
      const next = Math.ceil((el.getBoundingClientRect().height + 16) / 8);
      return next === s ? s : next;
    });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [masonry]);
  return (
    <div {...rest} style={{ ...style, ...(masonry ? { gridRowEnd: `span ${span || 40}` } : {}) }}>
      <div ref={innerRef} style={{ position: 'relative' }}>{children}</div>
    </div>
  );
}

const todayISO = () => new Date().toISOString().slice(0, 10);
const addDays = (iso, n) => { const d = new Date(iso); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const fmtUS = (iso) => fmtDate(iso);
const dueColor = (iso, done) => { if (!iso || done) return NX.faint; const t = todayISO(); return iso < t ? NX.red : iso === t ? NX.amber : NX.dim; };

export default function HomeView({ onNavigate }) {
  const store = useTasks();
  const { tasks, projects, teams, notifications, myEmail, nameOf, createTask, toggleComplete } = store;
  const [tab, setTab] = useState('Upcoming');
  const [range, setRange] = useState('week');
  const [rangeOpen, setRangeOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newDue, setNewDue] = useState(null);
  const [openId, setOpenId] = useState(taskIdFromUrl);
  const [creatingProject, setCreatingProject] = useState(false);
  const [customizing, setCustomizing] = useState(false);
  const isMobile = useIsMobile();
  const dateRef = useRef(null);
  const rangeRef = useRef(null);
  useClickOutside(rangeRef, () => setRangeOpen(false), rangeOpen);
  const [widgets, setWidgets] = useState(() => {
    try { const raw = JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null'); if (Array.isArray(raw) && raw.length) return raw.filter((k) => WIDGET_META.some((w) => w.key === k)); } catch { /* */ }
    return DEFAULT_LAYOUT;
  });
  const persist = (next) => { localStorage.setItem(LAYOUT_KEY, JSON.stringify(next)); setWidgets(next); };

  // Customize mode: drag-to-rearrange + remove + add, all inline on the grid
  // (the old list modal is gone). Autofit packs widgets masonry-style so tall
  // and short widgets fill the page without holes; both persist.
  const [dragKey, setDragKey] = useState(null);
  const [overKey, setOverKey] = useState(null);
  // Default ON: grid rows size to the tallest widget, so short widgets can
  // never tuck into the vertical gaps - masonry packing is what fills them.
  const [autofit, setAutofit] = useState(() => localStorage.getItem('nexus.homeAutofit') !== '0');
  const toggleAutofit = () => setAutofit((v) => { localStorage.setItem('nexus.homeAutofit', v ? '0' : '1'); return !v; });
  const reorder = (from, to) => {
    if (!from || from === to) return;
    const next = widgets.filter((k) => k !== from);
    next.splice(next.indexOf(to) >= 0 ? next.indexOf(to) : next.length, 0, from);
    persist(next);
  };
  const availableWidgets = WIDGET_META.filter((w) => !widgets.includes(w.key));

  // Subtasks assigned to me count as mine (Asana's My Tasks rule) - the old
  // top-level-only filter under-reported people's open work by up to a third.
  // Anything assigned to me, including tasks I share with somebody else.
  const myTasks = useMemo(() => tasks.filter((t) => t.type !== 'section' && taskAssignees(t).includes(myEmail)), [tasks, myEmail]);
  const rangeDef = RANGES.find((r) => r.key === range);
  const rangeEnd = addDays(todayISO(), rangeDef.days);
  const overdue = myTasks.filter((t) => !t.completed && t.dueOn && t.dueOn < todayISO());
  const completed = myTasks.filter((t) => t.completed);
  const upcoming = myTasks.filter((t) => !t.completed && (!t.dueOn || (t.dueOn >= todayISO() && t.dueOn <= rangeEnd)));
  const shown = tab === 'Upcoming' ? upcoming : tab === 'Overdue' ? overdue : completed;
  const collaborators = useMemo(() => { const s = new Set(); for (const t of myTasks) for (const f of (t.followerIds || [])) if (f !== myEmail) s.add(f); return s.size; }, [myTasks, myEmail]);
  const myTeams = useMemo(() => teams.filter((d) => (d.memberIds || []).includes(myEmail)), [teams, myEmail]);
  const teamMembers = useMemo(() => { const s = new Set(); myTeams.forEach((d) => (d.memberIds || []).forEach((id) => s.add(id))); return [...s]; }, [myTeams]);
  const recentProjects = projects.slice(0, 4);
  // Per-project task tallies for the monday-style progress bars on project cards.
  const projStats = useMemo(() => {
    const m = {};
    for (const t of tasks) {
      if (!t.projectId || t.parentTaskId) continue;
      const s = m[t.projectId] || (m[t.projectId] = { total: 0, done: 0 });
      s.total += 1; if (t.completed) s.done += 1;
    }
    return m;
  }, [tasks]);
  // Taskboard-kit summary tiles: my open totals split by what needs attention.
  const openMine = myTasks.filter((t) => !t.completed);
  const priorityMine = openMine.filter((t) => t.priority === 'urgent' || t.priority === 'high');
  // Kit "Urgently task" list: projects ranked by overdue load, bar = completion.
  const urgentProjects = useMemo(() => {
    const today = todayISO();
    const od = {};
    for (const t of tasks) {
      if (t.projectId && !t.parentTaskId && !t.completed && t.dueOn && t.dueOn < today) od[t.projectId] = (od[t.projectId] || 0) + 1;
    }
    return projects
      .map((p) => ({ p, overdue: od[p.id] || 0, ...(projStats[p.id] || { total: 0, done: 0 }) }))
      .filter((x) => x.total > 0)
      .sort((a, b) => b.overdue - a.overdue || (b.total - b.done) - (a.total - a.done))
      .slice(0, 4);
  }, [projects, tasks, projStats]);

  // Chart widgets - all derived from real task rows, nothing sampled.
  const dayCharts = useMemo(() => {
    const today = todayISO();
    const doneByDay = [];   // trailing 7 days, from completedAt
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const iso = d.toISOString().slice(0, 10);
      doneByDay.push({
        iso, label: d.toLocaleDateString('en-US', { weekday: 'short' }).slice(0, 2),
        n: myTasks.filter((t) => t.completed && (t.completedAt || '').slice(0, 10) === iso).length,
      });
    }
    const dueByDay = [];    // next 7 days incl. today, from dueOn (open tasks)
    for (let i = 0; i < 7; i++) {
      const d = new Date(); d.setDate(d.getDate() + i);
      const iso = d.toISOString().slice(0, 10);
      dueByDay.push({
        iso, today: iso === today,
        day: d.toLocaleDateString('en-US', { weekday: 'short' }).slice(0, 2),
        date: d.getDate(),
        n: myTasks.filter((t) => !t.completed && t.dueOn === iso).length,
      });
    }
    const prio = PRIORITY_ORDER.map((p) => ({ p, color: PRIORITY_COLORS[p], n: openMine.filter((t) => (t.priority || 'low') === p).length }));
    return { doneByDay, dueByDay, prio };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myTasks]);

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const firstName = (nameOf(myEmail) || '').split(' ')[0] || 'there';
  const todayLong = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  const cancelCreate = () => { setCreating(false); setNewTitle(''); setNewDue(null); };
  const commitCreate = async (openDetails) => {
    const title = newTitle.trim();
    if (!title) { if (!openDetails) cancelCreate(); return; }
    const t = await createTask({ title, assigneeIds: myEmail ? [myEmail] : [], dueOn: newDue || '', status: 'not_started', priority: 'medium', type: 'task' }).catch(() => null);
    setNewTitle(''); setNewDue(null);
    if (openDetails && t) { setCreating(false); setOpenId(t.id); }
  };

  const widgetBox = (children) => <div style={{ ...card, borderRadius: 16, padding: 20, breakInside: 'avoid' }}>{children}</div>;
  // Widget options (remove/drag) live on the customize-mode overlay only -
  // no always-visible more-options buttons (owner call, Jul 28).
  const moreBtn = () => null;

  const renderWidget = (key) => {
    if (key === 'my_tasks') return widgetBox(
      <>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {!isMobile && <Avatar email={myEmail} name={nameOf(myEmail)} size={38} />}
            <button onClick={() => onNavigate('mine')} style={{ ...btn('ghost'), padding: 0, fontSize: 16, fontWeight: 700, color: NX.ink }}>My Tasks</button>
          </div>
          {moreBtn(() => onNavigate('mine'))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, borderBottom: `1px solid ${NX.border}`, marginBottom: 10, fontSize: 13, fontWeight: 600, flexWrap: 'wrap' }}>
          {TABS.map((t) => (
            <button key={t} onClick={() => setTab(t)} style={{ border: 'none', background: 'transparent', cursor: 'pointer', paddingBottom: 8, borderBottom: `2px solid ${tab === t ? NX.blue : 'transparent'}`, color: tab === t ? NX.blue : NX.dim, fontFamily: FONT, fontWeight: 600 }}>
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
          <button onClick={() => setCreating(true)} style={{ ...btn('ghost'), padding: '6px 0', color: NX.dim, fontSize: 13, fontWeight: 500 }}><Plus size={15} /> Create Task</button>
        )}
        {store.loading && shown.length === 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '10px 0' }}>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span className="skel" style={{ width: 16, height: 16, borderRadius: '50%' }} />
                <span className="skel" style={{ width: `${62 - i * 9}%`, height: 12 }} />
                <span className="skel" style={{ width: 64, height: 11, marginLeft: 'auto' }} />
              </div>
            ))}
          </div>
        ) : shown.length === 0 ? <p style={{ padding: '24px 0', textAlign: 'center', fontSize: 13, color: NX.faint }}>Nothing here.</p> : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {shown.map((t) => (
              <div key={t.id} data-task-row onClick={() => setOpenId(t.id)} style={{ display: 'flex', alignItems: 'center', gap: 8, borderTop: `1px solid ${NX.border2}`, padding: '8px 6px', margin: '0 -6px', borderRadius: 6, fontSize: 13, cursor: 'pointer', transition: 'background 0.12s' }}
                onMouseEnter={(e) => { e.currentTarget.style.background = NX.hover; }} onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}>
                <button onClick={(e) => { e.stopPropagation(); toggleComplete(t); }} style={{ ...btn('ghost'), padding: 0, color: t.completed ? NX.green : NX.faint }}>{t.completed ? <CheckCircle2 size={16} /> : <Circle size={16} />}</button>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: t.completed ? NX.faint : NX.ink, textDecoration: t.completed ? 'line-through' : 'none' }}>{t.title}</span>
                {t.dueOn && <span style={{ fontSize: 12, fontWeight: 600, color: dueColor(t.dueOn, t.completed) }}>{fmtUS(t.dueOn)}</span>}
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
          {/* Create lives in the header, not as a tile in the grid. As a tile it
              took a full card slot on every screen - the whole first row on a
              phone - to hold one button, and it read as a project that was not
              one. */}
          <button onClick={() => setCreatingProject(true)} title="Create Project" aria-label="Create Project"
            style={{ ...btn('ghost'), padding: 6, color: NX.dim, flexShrink: 0, marginTop: -2 }}>
            <Plus size={20} />
          </button>
          {moreBtn(() => onNavigate('projects'))}
        </div>
        {/* Kit "Recently Visit" anatomy - colored cover band (the project's real
            color; no fabricated screenshots), then name, tally, progress. */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 12 }}>
          {recentProjects.map((p) => {
            const pc = p.color || NX.purple;
            const st = projStats[p.id] || { total: 0, done: 0 };
            const pct = st.total ? Math.round((st.done / st.total) * 100) : 0;
            return (
              <button key={p.id} onClick={() => onNavigate({ projectId: p.id })} style={{ display: 'flex', flexDirection: 'column', minWidth: 0, border: `1px solid ${NX.border}`, borderRadius: 12, padding: 0, overflow: 'hidden', cursor: 'pointer', background: NX.surface, textAlign: 'left', fontFamily: FONT, transition: 'box-shadow 0.15s, transform 0.15s' }}
                onMouseEnter={(e) => { e.currentTarget.style.boxShadow = '0 6px 18px rgba(0,0,0,0.10)'; e.currentTarget.style.transform = 'translateY(-1px)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.boxShadow = 'none'; e.currentTarget.style.transform = 'none'; }}>
                <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: 56, background: `linear-gradient(135deg, ${pc}33, ${pc}1a)`, color: pc }}>
                  <FolderKanban size={22} />
                </span>
                <span style={{ display: 'block', minWidth: 0, width: '100%', padding: '10px 12px 12px' }}>
                  <span style={{ display: 'block', fontSize: 13.5, fontWeight: 700, color: NX.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                  <span style={{ display: 'block', fontSize: 11.5, color: NX.faint, marginTop: 2 }}>{st.total ? `${st.done}/${st.total} tasks done` : 'No tasks yet'}</span>
                  {st.total > 0 && (
                    <span style={{ display: 'block', height: 5, borderRadius: 3, background: NX.border2, marginTop: 7, overflow: 'hidden' }}>
                      <span style={{ display: 'block', height: '100%', width: `${pct}%`, borderRadius: 3, background: pct === 100 ? '#00c875' : pc }} />
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      </>
    );
    if (key === 'teams') return widgetBox(
      <>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Teams</h2>
          {moreBtn(() => onNavigate('teams'))}
        </div>
        {myTeams.length === 0 ? <p style={{ padding: '16px 0', fontSize: 13, color: NX.faint }}>You're not part of any team yet.</p> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {myTeams.map((d) => {
              const proj = d.projectId ? projects.find((p) => p.id === d.projectId) : null;
              return (
                <button key={d.id} onClick={() => onNavigate('teams')} style={{ display: 'flex', alignItems: 'center', gap: 12, border: `1px solid ${NX.border}`, borderRadius: 12, padding: 12, cursor: 'pointer', background: NX.surface, textAlign: 'left', fontFamily: FONT }}>
                  <span style={{ display: 'flex', width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 9, background: `${d.color}1a`, color: d.color }}><Building2 size={18} /></span>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: NX.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</div>
                    <div style={{ fontSize: 12, color: NX.faint }}>{(d.memberIds || []).length} member{(d.memberIds || []).length === 1 ? '' : 's'} · {proj ? proj.name : 'Unassigned'}</div>
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
          <Building2 size={18} style={{ color: NX.faint }} /><h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Team Members</h2><span style={{ fontSize: 13, color: NX.faint }}>{teamMembers.length}</span>
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
    if (key === 'urgent') return widgetBox(
      <>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Urgent tasks</h2>
          {moreBtn(() => onNavigate('projects'))}
        </div>
        {urgentProjects.length === 0 ? <p style={{ padding: '16px 0', fontSize: 13, color: NX.faint }}>No projects with open tasks - nothing is on fire.</p> : (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {urgentProjects.map(({ p, overdue: od, total, done }) => (
                <button key={p.id} onClick={() => onNavigate({ projectId: p.id })}
                  style={{ ...btn('ghost'), display: 'block', width: '100%', padding: 0, textAlign: 'left' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, fontSize: 13 }}>
                    <span style={{ fontWeight: 600, color: NX.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{p.name}</span>
                    {od > 0 && <span style={{ padding: '1px 8px', borderRadius: 10, fontSize: 11, fontWeight: 700, background: `${NX.red}1a`, color: NX.red }}>{od} overdue</span>}
                    <span style={{ fontSize: 12, color: NX.faint, fontVariantNumeric: 'tabular-nums' }}>{done}/{total}</span>
                  </div>
                  {/* Kit's dark bars: near-black fill on a light track */}
                  <div style={{ height: 10, borderRadius: 99, background: NX.border2, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${total ? Math.max(4, Math.round((done / total) * 100)) : 0}%`, borderRadius: 99, background: NX.ink }} />
                  </div>
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10, fontSize: 11, color: NX.faint }}>
              <span>0%</span><span>50%</span><span>100%</span>
            </div>
          </>
        )}
      </>
    );
    if (key === 'activity') {
      const { doneByDay } = dayCharts;
      const maxDone = Math.max(...doneByDay.map((d) => d.n), 1);
      const weekTotal = doneByDay.reduce((s, d) => s + d.n, 0);
      return widgetBox(
        <>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 16 }}>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Completed this week</h2>
            <span style={{ fontSize: 13, color: NX.faint }}>{weekTotal} task{weekTotal === 1 ? '' : 's'}</span>
          </div>
          <div role="button" tabIndex={0} title="Open your completed tasks"
            onClick={() => { setTab('Completed'); onNavigate('mine'); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { setTab('Completed'); onNavigate('mine'); } }}
            style={{ display: 'flex', gap: 10, alignItems: 'flex-end', height: 96, cursor: 'pointer' }}>
            {doneByDay.map((d) => (
              <div key={d.iso} title={`${d.iso}: ${d.n} completed`}
                style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', alignItems: 'center', gap: 5, height: '100%' }}>
                {d.n > 0 && <span style={{ fontSize: 11.5, fontWeight: 700, color: '#06c698', fontVariantNumeric: 'tabular-nums' }}>{d.n}</span>}
                <div style={{ width: '100%', maxWidth: 26, height: d.n === 0 ? 3 : Math.max(10, Math.round((d.n / maxDone) * 66)), borderRadius: 99, background: d.n === 0 ? NX.border2 : 'linear-gradient(180deg, #4fd9b3 0%, #06c698 100%)' }} />
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
            {doneByDay.map((d) => <span key={d.iso} style={{ flex: 1, textAlign: 'center', fontSize: 11, color: NX.faint }}>{d.label}</span>)}
          </div>
        </>
      );
    }
    if (key === 'week') return widgetBox(
      <>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Week ahead</h2>
          {moreBtn(() => { setTab('Upcoming'); onNavigate('mine'); })}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {dayCharts.dueByDay.map((d) => (
            <div key={d.iso} role="button" tabIndex={0} title={`${d.iso}: ${d.n} due - open upcoming tasks`}
              onClick={() => { setTab('Upcoming'); onNavigate('mine'); }}
              onKeyDown={(e) => { if (e.key === 'Enter') { setTab('Upcoming'); onNavigate('mine'); } }}
              style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: '10px 4px', borderRadius: 12, background: d.today ? NX.ink : NX.hover, minWidth: 0, cursor: 'pointer' }}>
              <span style={{ fontSize: 11, color: d.today ? 'rgba(255,255,255,.7)' : NX.faint }}>{d.day}</span>
              <span style={{ fontSize: 15, fontWeight: 800, color: d.today ? '#fff' : NX.ink, fontVariantNumeric: 'tabular-nums' }}>{d.date}</span>
              <span style={{ minWidth: 20, textAlign: 'center', padding: '1px 6px', borderRadius: 10, fontSize: 11, fontWeight: 700, background: d.n > 0 ? (d.today ? 'rgba(255,255,255,.22)' : '#dff3fc') : 'transparent', color: d.n > 0 ? (d.today ? '#fff' : '#0998c3') : (d.today ? 'rgba(255,255,255,.4)' : NX.border) }}>
                {d.n > 0 ? d.n : '·'}
              </span>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 10, fontSize: 12, color: NX.faint }}>Open tasks due per day</div>
      </>
    );
    if (key === 'priorities') {
      const maxP = Math.max(...dayCharts.prio.map((x) => x.n), 1);
      return widgetBox(
        <>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 16 }}>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>By priority</h2>
            <span style={{ fontSize: 13, color: NX.faint }}>{openMine.length} open</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {dayCharts.prio.map(({ p, color, n }) => (
              <div key={p} role="button" tabIndex={0} title={`Open your ${p}-priority tasks`}
                onClick={() => { setTab('Upcoming'); onNavigate('mine'); }}
                onKeyDown={(e) => { if (e.key === 'Enter') { setTab('Upcoming'); onNavigate('mine'); } }}
                style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, cursor: 'pointer' }}>
                <span style={{ width: 62, color: NX.dim, textTransform: 'capitalize', flexShrink: 0 }}>{p}</span>
                <span style={{ flex: 1, height: 9, borderRadius: 6, background: NX.border2, overflow: 'hidden' }}>
                  <span style={{ display: 'block', height: '100%', width: `${Math.round((n / maxP) * 100)}%`, minWidth: n > 0 ? 10 : 0, borderRadius: 6, background: color }} />
                </span>
                <span style={{ fontWeight: 700, color: NX.ink, fontVariantNumeric: 'tabular-nums', width: 18, textAlign: 'right' }}>{n}</span>
              </div>
            ))}
          </div>
        </>
      );
    }
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
    <div className="nx-page" style={{ padding: '24px 24px 76px', fontFamily: FONT, color: NX.ink, height: '100%', overflow: 'auto' }}>
      {/* Desktop: workload counts left, range · stats · Customize right. Mobile:
          the range button takes the full first line so stats + Customize wrap. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: isMobile ? 12 : 20 }}>
        {/* Counts only. The greeting and the date both went: neither told the
            reader anything they didn't know, and they pushed the two numbers
            that actually matter into a subtitle. With both gone this can be
            empty (nothing upcoming, nothing overdue) - the flex row still lays
            out correctly, the right-hand controls just sit alone. */}
        <div style={{ minWidth: 0, fontSize: 15, fontWeight: 700, letterSpacing: -0.2 }}>
          {upcoming.length > 0 && <span style={{ color: NX.blue }}>{upcoming.length} upcoming</span>}
          {upcoming.length > 0 && overdue.length > 0 && <span style={{ color: NX.faint }}> · </span>}
          {overdue.length > 0 && <span style={{ color: NX.red }}>{overdue.length} overdue</span>}
        </div>
        {/* Header holds ONE page-level control (Customize) - the range picker
            and task stats moved into the "My tasks" card they actually scope,
            so switching to Tickets no longer swaps header anatomies. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: isMobile ? 'wrap' : 'nowrap', overflowX: 'visible' }}>
          {customizing ? (
            <>
              <button onClick={toggleAutofit} title="Pack widgets to fill gaps" style={{ ...btn('outline'), flexShrink: 0, whiteSpace: 'nowrap', background: autofit ? NX.hover : undefined }}>{autofit ? <Check size={14} /> : null} Autofit</button>
              <button onClick={() => { setCustomizing(false); setDragKey(null); setOverKey(null); }} style={{ ...btn('primary'), flexShrink: 0, whiteSpace: 'nowrap' }}><Check size={14} /> Done</button>
            </>
          ) : (
            <button onClick={() => setCustomizing(true)} title="Customize widgets" style={{ ...btn('outline'), flexShrink: 0, whiteSpace: 'nowrap' }}><LayoutGrid size={14} /> Customize</button>
          )}
        </div>
      </div>

      {/* Taskboard-kit summary tiles (owner-adopted concept): pastel tiles with
          solid icon chips and X/Y fractions of MY real tasks. Each tile is a
          real action - it switches the My Tasks widget tab or jumps to a view.
          Wrapped in the kit's titled section card so the row reads as one
          composed group even at full-bleed width. */}
      <div style={{ ...card, borderRadius: 16, padding: 20, marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', margin: '0 0 14px' }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800 }}>My tasks</h2>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12.5, color: NX.dim, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <CheckCircle2 size={14} style={{ color: NX.green }} /> {completed.length} completed
          </span>
          <span style={{ fontSize: 12.5, color: NX.dim, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <Users size={14} style={{ color: NX.faint }} /> {collaborators} collaborator{collaborators === 1 ? '' : 's'}
          </span>
          <div ref={rangeRef} style={{ position: 'relative' }}>
            <button onClick={() => setRangeOpen((o) => !o)} style={{ ...btn('outline'), whiteSpace: 'nowrap', padding: '6px 12px', fontSize: 12.5 }}>{rangeDef.label} <ChevronDown size={14} style={{ color: NX.faint }} /></button>
            {rangeOpen && (
              <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: 4, width: 150, background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,0.16)', zIndex: 40, padding: 4 }}>
                {RANGES.map((r) => <button key={r.key} onClick={() => { setRange(r.key); setRangeOpen(false); }} style={{ ...btn('ghost'), width: '100%', justifyContent: 'flex-start', color: range === r.key ? NX.blue : NX.ink }}>{r.label}</button>)}
              </div>
            )}
          </div>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: isMobile ? 6 : 16 }}>
        {[
          { label: 'Priority', n: priorityMine.length, of: openMine.length, unit: 'open', Icon: Flag, chip: '#06c698', bg: '#e4f5ee', go: () => onNavigate('mine'), title: 'Open my tasks' },
          { label: 'Upcoming', n: upcoming.length, of: myTasks.length, unit: 'tasks', Icon: CalendarDays, chip: '#0998c3', bg: '#dff3fc', go: () => setTab('Upcoming'), title: 'Show upcoming' },
          { label: 'Overdue', n: overdue.length, of: myTasks.length, unit: 'tasks', Icon: Clock, chip: '#7c6af0', bg: '#eae6fc', go: () => setTab('Overdue'), title: 'Show overdue' },
          { label: 'Completed', n: completed.length, of: myTasks.length, unit: 'tasks', Icon: CheckCircle2, chip: '#fc6363', bg: '#fde8e3', go: () => setTab('Completed'), title: 'Show completed' },
        ].map(({ label, n, of, unit, Icon, chip, bg, go, title }) => (
          /* Horizontal anatomy (chip left, text right) at desktop width - a
             vertical (chip-on-top) tile stretched across a wide column reads
             as empty wash there. Mobile flips to that same chip-on-top
             anatomy deliberately: 4 across a phone width leaves each tile too
             narrow for icon+text side by side, so it goes vertical and
             compact instead - smaller chip, tighter type, no unit word. */
          <button key={label} onClick={go} title={title}
            style={{
              background: bg, border: 'none', borderRadius: isMobile ? 12 : 16,
              padding: isMobile ? '10px 4px' : '16px 18px', cursor: 'pointer',
              textAlign: isMobile ? 'center' : 'left', fontFamily: FONT,
              display: 'flex', alignItems: 'center',
              flexDirection: isMobile ? 'column' : 'row', gap: isMobile ? 6 : 14,
              minWidth: 0, transition: 'transform .15s, box-shadow .15s',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = '0 8px 20px rgba(29,33,57,.10)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = 'none'; }}>
            <span style={{
              width: isMobile ? 26 : 44, height: isMobile ? 26 : 44, borderRadius: isMobile ? 8 : 13,
              background: chip, color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}>
              <Icon size={isMobile ? 13 : 20} />
            </span>
            <span style={{ display: 'flex', flexDirection: 'column', alignItems: isMobile ? 'center' : 'stretch', gap: 3, minWidth: 0 }}>
              <span style={{ fontSize: isMobile ? 10.5 : 13.5, color: NX.dim, lineHeight: 1.15 }}>{label}</span>
              <span style={{ fontSize: isMobile ? 15 : 24, fontWeight: 800, color: NX.ink, lineHeight: 1, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                {n}
                <span style={{ fontSize: isMobile ? 10.5 : 14, fontWeight: 600, color: NX.dim }}> /{of}{!isMobile ? ` ${unit}` : ''}</span>
              </span>
            </span>
          </button>
        ))}
      </div>
      </div>

      {/* Customize mode: add-widget tray (only unused widgets) */}
      {customizing && availableWidgets.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: NX.dim }}>Add widgets:</span>
          {availableWidgets.map((w) => (
            <button key={w.key} onClick={() => persist([...widgets, w.key])}
              style={{ ...btn('ghost'), border: `1px dashed ${NX.border}`, borderRadius: 20, padding: '5px 13px', fontSize: 12.5, color: NX.dim }}>
              <Plus size={13} /> {w.label}
            </button>
          ))}
        </div>
      )}

      {/* min(340px, 100%) so a column can never be wider than the viewport.
          Autofit = masonry packing (CSS columns) so short and tall widgets
          fill the page without holes; source order is still the saved order.
          Masonry is a multi-column trick - on mobile the grid is already down
          to one column (a single 340px-min track is all that fits), so there
          is nothing beside a widget for it to pack against, and a stale
          measured span (e.g. from a taller pre-data skeleton) just shows up
          as dead space before the next widget instead. Plain stacking with a
          fixed gap sidesteps that - every widget is simply its own height. */}
      <div className="nx-card-grid"
        onDragOver={customizing ? (e) => e.preventDefault() : undefined}
        onDrop={customizing ? (e) => { e.preventDefault(); if (dragKey) { reorder(dragKey, null); } setDragKey(null); setOverKey(null); } : undefined}
        style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(340px, 100%), 1fr))',
          columnGap: 16,
          ...(autofit && !isMobile ? { gridAutoRows: 8, rowGap: 0 } : { rowGap: 16, alignItems: 'start' }),
        }}>
        {widgets.map((key) => (
          <MasonryCell key={key} masonry={autofit && !isMobile}
            draggable={customizing}
            onDragStart={customizing ? () => setDragKey(key) : undefined}
            /* dragover fires continuously - functional setState with a same-value
               bail keeps it from re-rendering the whole grid per mouse move
               (the drag lag), and skipping dragLeave kills the enter/leave
               flicker churn; overKey clears on drop/end instead. */
            onDragOver={customizing ? (e) => { e.preventDefault(); if (dragKey && dragKey !== key) setOverKey((k) => (k === key ? k : key)); } : undefined}
            onDrop={customizing ? (e) => { e.preventDefault(); e.stopPropagation(); reorder(dragKey, key); setDragKey(null); setOverKey(null); } : undefined}
            onDragEnd={customizing ? () => { setDragKey(null); setOverKey(null); } : undefined}
            style={{
              minWidth: 0, position: 'relative', borderRadius: 16,
              outline: customizing ? `2px dashed ${overKey === key ? NX.primary : NX.border}` : 'none', outlineOffset: -2,
              cursor: customizing ? 'grab' : undefined,
              opacity: dragKey === key ? 0.45 : 1,
            }}>
            {customizing && (
              <div style={{ position: 'absolute', top: -12, right: 6, zIndex: 5, display: 'flex', gap: 4 }}>
                <span title="Drag to rearrange" style={{ width: 26, height: 26, borderRadius: '50%', border: `1px solid ${NX.border}`, background: NX.surface, color: NX.faint, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 2px 6px rgba(0,0,0,.12)', cursor: 'grab' }}><GripVertical size={14} /></span>
                <button onClick={() => persist(widgets.filter((k) => k !== key))} title="Remove widget"
                  style={{ width: 26, height: 26, borderRadius: '50%', border: `1px solid ${NX.border}`, background: NX.surface, color: NX.dim, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 2px 6px rgba(0,0,0,.12)', cursor: 'pointer' }}><X size={14} /></button>
              </div>
            )}
            {renderWidget(key)}
          </MasonryCell>
        ))}
      </div>
      {creatingProject && <ProjectCreateModal onClose={() => setCreatingProject(false)} onCreated={(p) => onNavigate({ projectId: p.id })} />}
      {openId && <TaskDetailDrawer taskId={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

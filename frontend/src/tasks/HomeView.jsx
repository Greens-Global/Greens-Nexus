// Task Module — Home landing. Ported from the export's nexus/home/HomePage.tsx:
// a customizable multi-widget dashboard (persisted layout, range selector,
// My-tasks tabs with quick-add, projects/teams/members/notifications widgets),
// re-fitted to the Nexus store + inline-style idiom.
import { useMemo, useRef, useState } from 'react';
import {
  CheckCircle2, Circle, Users, LayoutGrid, Plus, ChevronDown, ChevronRight,
  CalendarDays, FolderKanban, Bell, ArrowUp, ArrowDown, X, MoreHorizontal,
  Building2, Cpu, HardHat, Cog, Code2, Calculator, Megaphone, Briefcase, Wrench,
  FlaskConical, ShieldCheck, Rocket, PenTool, Landmark, Truck, Headphones, HeartPulse,
} from 'lucide-react';
import { NX, FONT, card, btn } from './theme';
import { Avatar, Modal } from './components';
import { toast } from './shared';
import { useTasks } from './TasksContext';
import TaskDetailDrawer from './TaskDetailDrawer';

// ── Widget registry + persisted layout ───────────────────────────────────────
const WIDGET_META = [
  { key: 'my_tasks', label: 'My tasks' },
  { key: 'projects', label: 'Projects' },
  { key: 'teams', label: 'Teams' },
  { key: 'team_members', label: 'Team members' },
  { key: 'notifications', label: 'Notifications' },
];
const DEFAULT_LAYOUT = ['my_tasks', 'projects'];
const LAYOUT_KEY = 'nexus.homeWidgets';

function useHomeLayout() {
  const [widgets, setWidgets] = useState(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null');
      if (Array.isArray(raw) && raw.length) return raw.filter((k) => WIDGET_META.some((w) => w.key === k));
    } catch { /* ignore */ }
    return DEFAULT_LAYOUT;
  });
  const persist = (next) => {
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(next)); } catch { /* ignore */ }
    setWidgets(next);
  };
  return { widgets, setWidgets: persist };
}

const TABS = ['Upcoming', 'Overdue', 'Completed'];
const RANGE_OPTIONS = [
  { key: 'day', label: 'My day', days: 0 },
  { key: 'week', label: 'My week', days: 7 },
  { key: 'month', label: 'My month', days: 30 },
];

// Curated department icons (keys match the export's deptIcons set).
const DEPT_ICONS = {
  building: Building2, cpu: Cpu, hardhat: HardHat, cog: Cog, code: Code2,
  calculator: Calculator, users: Users, megaphone: Megaphone, briefcase: Briefcase,
  wrench: Wrench, flask: FlaskConical, shield: ShieldCheck, rocket: Rocket,
  pen: PenTool, landmark: Landmark, truck: Truck, headphones: Headphones, heart: HeartPulse,
};
function deptIcon(key) { return (key && DEPT_ICONS[key]) || Building2; }

// ── Date helpers ──────────────────────────────────────────────────────────────
const todayISO = () => new Date().toISOString().slice(0, 10);
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
function formatUSDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d)) return iso;
  return d.toLocaleDateString('en-US');
}
function dueColor(iso, completed) {
  if (completed) return NX.faint;
  if (!iso) return NX.dim;
  const t = todayISO();
  if (iso < t) return NX.red;
  if (iso === t) return NX.amber;
  return NX.dim;
}

const widgetCard = { ...card, borderRadius: 16, padding: 20 };
const iconBtn = { ...btn('outline'), padding: 6, color: NX.dim };

export default function HomeView({ onNavigate }) {
  const { tasks, projects, departments, notifications, createTask, nameOf, projectName, myEmail, markNotificationRead, toggleComplete } = useTasks();

  const [tab, setTab] = useState('Upcoming');
  const [range, setRange] = useState('week');
  const [rangeOpen, setRangeOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newDueOn, setNewDueOn] = useState(null);
  const [openTaskId, setOpenTaskId] = useState(null);
  const [customizing, setCustomizing] = useState(false);
  const dateInputRef = useRef(null);
  const { widgets, setWidgets } = useHomeLayout();

  const myDepartments = useMemo(
    () => departments.filter((d) => (d.memberIds || []).includes(myEmail)),
    [departments, myEmail],
  );
  const teamMembers = useMemo(() => {
    const ids = new Set();
    myDepartments.forEach((d) => (d.memberIds || []).forEach((id) => ids.add(id)));
    return [...ids];
  }, [myDepartments]);

  const myNotifications = useMemo(() => (notifications || []).slice(0, 6), [notifications]);

  const myTasks = useMemo(
    () => tasks.filter((t) => !t.parentTaskId && t.assigneeId && myEmail && t.assigneeId === myEmail),
    [tasks, myEmail],
  );

  const todayStr = todayISO();
  const rangeDef = RANGE_OPTIONS.find((r) => r.key === range) || RANGE_OPTIONS[1];
  const rangeEndStr = addDays(todayStr, rangeDef.days);
  const overdue = myTasks.filter((t) => !t.completed && t.dueOn && t.dueOn < todayStr);
  const completed = myTasks.filter((t) => t.completed);
  const upcoming = myTasks.filter((t) => !t.completed && (!t.dueOn || (t.dueOn >= todayStr && t.dueOn <= rangeEndStr)));
  const shown = tab === 'Upcoming' ? upcoming : tab === 'Overdue' ? overdue : completed;

  const collaborators = useMemo(() => {
    const ids = new Set();
    for (const t of myTasks) for (const f of (t.followerIds || [])) if (f && f !== myEmail) ids.add(f);
    return ids.size;
  }, [myTasks, myEmail]);

  const recentProjects = projects.slice(0, 4);

  const cancelCreate = () => { setCreating(false); setNewTitle(''); setNewDueOn(null); };

  const commitCreate = async (openDetails = false) => {
    const title = newTitle.trim();
    if (!title) { if (!openDetails) cancelCreate(); return; }
    try {
      const created = await createTask({ title, assigneeId: myEmail, status: 'not_started', priority: 'medium', type: 'task', dueOn: newDueOn || '' });
      setNewTitle('');
      setNewDueOn(null);
      if (openDetails) { setCreating(false); setOpenTaskId(created.id); }
    } catch { toast('Could not create task'); }
  };

  const openNotif = (n) => { if (!n.read && markNotificationRead) markNotificationRead(n.id); };

  const renderWidget = (key) => {
    switch (key) {
      case 'my_tasks':
        return (
          <div style={widgetCard}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <Avatar email={myEmail} name={nameOf?.(myEmail)} size={38} />
                <button onClick={() => onNavigate?.('tasks', 'mine')} style={{ ...btn('ghost'), padding: 0, fontSize: 16, fontWeight: 800, color: NX.ink }}>My tasks</button>
              </div>
              <button onClick={() => toast('More options')} style={iconBtn} aria-label="More options"><MoreHorizontal size={16} /></button>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, borderBottom: `1px solid ${NX.border}`, marginBottom: 10, fontSize: 13, fontWeight: 600 }}>
              {TABS.map((t) => {
                const active = tab === t;
                return (
                  <button key={t} onClick={() => setTab(t)} style={{ ...btn('ghost'), padding: '0 0 9px', borderRadius: 0, color: active ? NX.ink : NX.dim, borderBottom: `2px solid ${active ? NX.ink : 'transparent'}` }}>
                    {t}{t === 'Overdue' && overdue.length > 0 ? ` (${overdue.length})` : ''}
                  </button>
                );
              })}
            </div>
            {creating ? (
              <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 8, borderBottom: `2px solid ${NX.blue}`, padding: '6px 0', marginBottom: 4 }}>
                <Circle size={16} style={{ color: NX.faint, flexShrink: 0 }} />
                <input
                  autoFocus value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') commitCreate(false); if (e.key === 'Escape') cancelCreate(); }}
                  onBlur={() => commitCreate(false)}
                  placeholder="Write a task name"
                  style={{ minWidth: 0, flex: 1, border: 'none', outline: 'none', background: 'transparent', fontSize: 13, fontFamily: FONT, color: NX.ink }}
                />
                {newDueOn && <span style={{ flexShrink: 0, fontSize: 12, fontWeight: 500, color: dueColor(newDueOn, false) }}>{formatUSDate(newDueOn)}</span>}
                <button onMouseDown={(e) => { e.preventDefault(); dateInputRef.current?.showPicker?.(); dateInputRef.current?.focus(); }} style={{ ...btn('ghost'), padding: 4, flexShrink: 0 }} title="Set due date"><CalendarDays size={16} /></button>
                <input ref={dateInputRef} type="date" value={newDueOn ?? ''} onChange={(e) => setNewDueOn(e.target.value || null)} style={{ position: 'absolute', height: 0, width: 0, opacity: 0 }} tabIndex={-1} />
                <button onMouseDown={(e) => { e.preventDefault(); commitCreate(true); }} style={{ ...btn('ghost'), padding: 4, flexShrink: 0 }} title="Open details"><ChevronRight size={16} /></button>
              </div>
            ) : (
              <button onClick={() => setCreating(true)} style={{ ...btn('ghost'), padding: '6px 0', marginBottom: 4, fontSize: 13, fontWeight: 500, color: NX.dim }}><Plus size={15} /> Create task</button>
            )}
            {shown.length === 0 ? (
              <p style={{ padding: '24px 0', textAlign: 'center', fontSize: 13, color: NX.faint }}>Nothing here.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {shown.map((t, i) => (
                  <div key={t.id} onClick={() => setOpenTaskId(t.id)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', fontSize: 13, cursor: 'pointer', borderTop: i === 0 ? 'none' : `1px solid ${NX.border2}` }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = NX.surface2; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}>
                    <button onClick={(e) => { e.stopPropagation(); toggleComplete(t); }} style={{ ...btn('ghost'), padding: 0, color: t.completed ? NX.green : NX.faint }} aria-label="Toggle complete">
                      {t.completed ? <CheckCircle2 size={16} /> : <Circle size={16} />}
                    </button>
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: t.completed ? NX.faint : NX.ink, textDecoration: t.completed ? 'line-through' : 'none' }}>{t.title}</span>
                    {t.dueOn && <span style={{ fontSize: 12, fontWeight: 500, color: dueColor(t.dueOn, t.completed), flexShrink: 0 }}>{formatUSDate(t.dueOn)}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        );

      case 'projects':
        return (
          <div style={widgetCard}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16 }}>
              <h2 style={{ fontSize: 18, fontWeight: 800, color: NX.ink, margin: 0 }}>Projects</h2>
              <button onClick={() => onNavigate?.('projects')} style={iconBtn} aria-label="Open projects"><MoreHorizontal size={16} /></button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
              <button onClick={() => onNavigate?.('projects')} style={{ display: 'flex', alignItems: 'center', gap: 12, borderRadius: 12, border: `1px dashed ${NX.border}`, padding: 12, textAlign: 'left', cursor: 'pointer', background: NX.surface, fontFamily: FONT }}
                onMouseEnter={(e) => { e.currentTarget.style.background = NX.hover; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = NX.surface; }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 40, height: 40, flexShrink: 0, borderRadius: 10, border: `1px dashed ${NX.border}`, color: NX.faint }}><Plus size={18} /></span>
                <span style={{ fontSize: 13, fontWeight: 700, color: NX.dim }}>Create project</span>
              </button>
              {recentProjects.map((p) => (
                <button key={p.id} onClick={() => onNavigate?.('projects')} style={{ display: 'flex', alignItems: 'center', gap: 12, borderRadius: 12, border: `1px solid ${NX.border}`, padding: 12, textAlign: 'left', cursor: 'pointer', background: NX.surface, fontFamily: FONT }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = NX.hover; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = NX.surface; }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 40, height: 40, flexShrink: 0, borderRadius: 10, background: NX.purple + '26', color: NX.purple }}><FolderKanban size={18} /></span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, fontWeight: 700, color: NX.ink }}>{p.name}</span>
                </button>
              ))}
            </div>
          </div>
        );

      case 'teams':
        return (
          <div style={widgetCard}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16 }}>
              <h2 style={{ fontSize: 18, fontWeight: 800, color: NX.ink, margin: 0 }}>Teams</h2>
              <button onClick={() => onNavigate?.('teams')} style={iconBtn} aria-label="Open teams"><MoreHorizontal size={16} /></button>
            </div>
            {myDepartments.length === 0 ? (
              <p style={{ padding: '16px 0', fontSize: 13, color: NX.faint }}>You're not part of any team yet.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {myDepartments.map((d) => {
                  const Icon = deptIcon(d.icon);
                  const color = d.color || NX.blue;
                  const memberCount = (d.memberIds || []).length;
                  const projectCount = projects.filter((p) => p.departmentId === d.id).length;
                  return (
                    <button key={d.id} onClick={() => onNavigate?.('teams')} style={{ display: 'flex', alignItems: 'center', gap: 12, borderRadius: 12, border: `1px solid ${NX.border}`, padding: 12, textAlign: 'left', cursor: 'pointer', background: NX.surface, fontFamily: FONT }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = NX.hover; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = NX.surface; }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 36, height: 36, flexShrink: 0, borderRadius: 10, background: `${color}1a`, color }}><Icon size={18} /></span>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, fontWeight: 700, color: NX.ink }}>{d.name}</div>
                        <div style={{ fontSize: 12, color: NX.faint }}>{memberCount} member{memberCount === 1 ? '' : 's'} · {projectCount} project{projectCount === 1 ? '' : 's'}</div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );

      case 'team_members':
        return (
          <div style={widgetCard}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
              <Building2 size={18} style={{ color: NX.faint }} />
              <h2 style={{ fontSize: 18, fontWeight: 800, color: NX.ink, margin: 0 }}>Team members</h2>
              <span style={{ fontSize: 13, color: NX.faint }}>{teamMembers.length}</span>
            </div>
            {teamMembers.length === 0 ? (
              <p style={{ padding: '16px 0', fontSize: 13, color: NX.faint }}>No teammates yet.</p>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
                {teamMembers.map((email) => (
                  <div key={email} style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                    <Avatar email={email} name={nameOf?.(email)} size={34} />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, fontWeight: 700, color: NX.ink }}>{nameOf?.(email) || email}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );

      case 'notifications':
        return (
          <div style={widgetCard}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
              <Bell size={18} style={{ color: NX.faint }} />
              <h2 style={{ fontSize: 18, fontWeight: 800, color: NX.ink, margin: 0 }}>Notifications</h2>
            </div>
            {myNotifications.length === 0 ? (
              <p style={{ padding: '16px 0', fontSize: 13, color: NX.faint }}>You're all caught up.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {myNotifications.map((n) => (
                  <div key={n.id} onClick={() => openNotif(n)} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: n.read ? 'default' : 'pointer' }}>
                    <span style={{ width: 7, height: 7, borderRadius: '50%', marginTop: 6, flexShrink: 0, background: n.read ? 'transparent' : NX.blue, border: n.read ? `1px solid ${NX.border}` : 'none' }} />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: n.read ? 600 : 700, color: NX.ink }}>{n.title || 'Update'}</div>
                      {n.body && <div style={{ fontSize: 12, color: NX.dim, marginTop: 2, lineHeight: 1.4 }}>{n.body}</div>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <div className="nx-scroll" style={{ fontFamily: FONT, color: NX.ink, height: '100%', overflow: 'auto', background: NX.canvas }}>
      <div style={{ maxWidth: 1080, margin: '0 auto', padding: '24px 20px 40px' }}>
        {/* Header strip: range · activity · customize */}
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'flex-end', gap: 12, marginBottom: 20 }}>
          <div style={{ position: 'relative' }}>
            <button onClick={() => setRangeOpen((o) => !o)} style={{ ...btn('outline'), fontWeight: 600 }}>
              {rangeDef.label} <ChevronDown size={14} style={{ color: NX.faint }} />
            </button>
            {rangeOpen && (
              <>
                <div onClick={() => setRangeOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
                <div style={{ position: 'absolute', top: '100%', left: 0, marginTop: 4, minWidth: 150, background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,0.16)', zIndex: 41, padding: 4 }}>
                  {RANGE_OPTIONS.map((r) => {
                    const active = range === r.key;
                    return (
                      <div key={r.key} onClick={() => { setRange(r.key); setRangeOpen(false); toast(`Switched to ${r.label}`); }}
                        style={{ padding: '7px 10px', borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: 'pointer', color: active ? NX.ink : NX.dim, background: active ? NX.hover : 'transparent' }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = NX.hover; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = active ? NX.hover : 'transparent'; }}>
                        {r.label}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, border: `1px solid ${NX.border}`, background: NX.surface, borderRadius: 8, padding: '8px 12px', fontSize: 13, color: NX.dim }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><CheckCircle2 size={14} style={{ color: NX.green }} /> {completed.length} tasks completed</span>
            <span style={{ width: 1, height: 16, background: NX.border }} />
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Users size={14} /> {collaborators} collaborator{collaborators === 1 ? '' : 's'}</span>
          </div>

          <button onClick={() => setCustomizing(true)} style={{ ...btn('primary'), fontWeight: 600 }}>
            <LayoutGrid size={14} /> Customize
          </button>
        </div>

        {/* Widget grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16, alignItems: 'start' }}>
          {widgets.map((key) => (
            <div key={key} style={{ minWidth: 0 }}>{renderWidget(key)}</div>
          ))}
        </div>
      </div>

      {customizing && (
        <CustomizeModal widgets={widgets} setWidgets={setWidgets} onClose={() => setCustomizing(false)} />
      )}

      {openTaskId && <TaskDetailDrawer taskId={openTaskId} onClose={() => setOpenTaskId(null)} />}
    </div>
  );
}

function CustomizeModal({ widgets, setWidgets, onClose }) {
  const [draft, setDraft] = useState(widgets);
  const available = WIDGET_META.filter((w) => !draft.includes(w.key));

  const move = (i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= draft.length) return;
    const next = [...draft];
    [next[i], next[j]] = [next[j], next[i]];
    setDraft(next);
  };
  const add = (key) => setDraft([...draft, key]);
  const remove = (key) => setDraft(draft.filter((k) => k !== key));

  return (
    <Modal
      title="Customize home"
      width={440}
      onClose={onClose}
      footer={<>
        <button onClick={onClose} style={btn('outline')}>Cancel</button>
        <button onClick={() => { setWidgets(draft); onClose(); toast('Layout saved', 'success'); }} style={btn('primary')}>Save layout</button>
      </>}
    >
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.3, color: NX.faint, marginBottom: 8 }}>Shown widgets</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 20 }}>
        {draft.length === 0 && <p style={{ fontSize: 12, color: NX.faint, margin: 0 }}>No widgets. Add one below.</p>}
        {draft.map((key, i) => (
          <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 8, borderRadius: 10, border: `1px solid ${NX.border}`, background: NX.surface, padding: '8px 12px' }}>
            <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: NX.ink }}>{WIDGET_META.find((w) => w.key === key)?.label}</span>
            <button onClick={() => move(i, -1)} disabled={i === 0} style={{ ...btn('ghost'), padding: 4, opacity: i === 0 ? 0.3 : 1 }} title="Move up"><ArrowUp size={14} /></button>
            <button onClick={() => move(i, 1)} disabled={i === draft.length - 1} style={{ ...btn('ghost'), padding: 4, opacity: i === draft.length - 1 ? 0.3 : 1 }} title="Move down"><ArrowDown size={14} /></button>
            <button onClick={() => remove(key)} style={{ ...btn('ghost'), padding: 4, color: NX.red }} title="Remove"><X size={14} /></button>
          </div>
        ))}
      </div>

      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.3, color: NX.faint, marginBottom: 8 }}>Add widgets</div>
      {available.length === 0 ? (
        <p style={{ fontSize: 12, color: NX.faint, margin: 0 }}>All widgets are already on your home.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {available.map((w) => (
            <button key={w.key} onClick={() => add(w.key)} style={{ display: 'flex', alignItems: 'center', gap: 8, borderRadius: 10, border: `1px dashed ${NX.border}`, background: NX.surface, padding: '8px 12px', textAlign: 'left', cursor: 'pointer', fontFamily: FONT }}
              onMouseEnter={(e) => { e.currentTarget.style.background = NX.hover; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = NX.surface; }}>
              <Plus size={14} style={{ color: NX.faint }} />
              <span style={{ fontSize: 13, fontWeight: 600, color: NX.ink }}>{w.label}</span>
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}

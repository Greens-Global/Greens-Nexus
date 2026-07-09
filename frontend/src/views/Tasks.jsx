// Tasks view — shell for the ported Task Module. Mounts the module's data
// provider and reproduces the export's chrome inside the Nexus shell:
//   • a primary "Task | Ticket" segmented control (+ Manage) — export's NexusPrimaryTabs
//   • module tabs Home · My Tasks · Projects · Portfolios · Teams — export's NexusModuleTabs
// Sub-view is driven by the host's activeSub/onSubChange so it round-trips through
// the URL like other Nexus modules. See docs/Task-Module-Migration-Plan.md.
import { useState } from 'react';
import { Home, CheckCircle2, FolderKanban, Briefcase, Users, Settings, X } from 'lucide-react';
import { TasksProvider } from '../tasks/TasksContext';
import TasksWorkspace from '../tasks/TasksWorkspace';
import HomeView from '../tasks/HomeView';
import MyTasksView from '../tasks/MyTasksView';
import ProjectsView from '../tasks/ProjectsView';
import PortfoliosView from '../tasks/PortfoliosView';
import TeamsView from '../tasks/TeamsView';
import TicketsView from '../tasks/TicketsView';
import ManageView from '../tasks/ManageView';
import ReportBugButton from '../tasks/ReportBug';
import { NX, FONT } from '../tasks/theme';

// Module tabs — matches the export's NexusModuleTabs exactly (no "All tasks").
const MODULE_TABS = [
  { key: 'home', label: 'Home', icon: Home },
  { key: 'mine', label: 'My Tasks', icon: CheckCircle2 },
  { key: 'projects', label: 'Projects', icon: FolderKanban },
  { key: 'portfolios', label: 'Portfolios', icon: Briefcase },
  { key: 'teams', label: 'Teams', icon: Users },
];
// Task-mode subs (Task primary tab active). 'tasks' = a project's task list drilled
// in from Projects; it has no module tab of its own, matching the export.
const TASK_SUBS = ['home', 'mine', 'projects', 'portfolios', 'teams', 'tasks'];
const DEFAULT_SUB = 'home';
const ALL_SUBS = [...TASK_SUBS, 'tickets', 'manage'];

function SubView({ sub, projectId, onNavigate, onExitManage }) {
  switch (sub) {
    case 'home':       return <HomeView onNavigate={onNavigate} />;
    case 'mine':       return <MyTasksView onOpenTask={(id) => onNavigate('open-task', id)} />;
    case 'tasks':      return <TasksWorkspace lockedProjectId={projectId} />;
    case 'projects':   return <ProjectsView onNavigate={onNavigate} />;
    case 'portfolios': return <PortfoliosView onNavigate={onNavigate} />;
    case 'teams':      return <TeamsView />;
    case 'tickets':    return <TicketsView />;
    case 'manage':     return <ManageView onExit={onExitManage} />;
    default:           return <HomeView onNavigate={onNavigate} />;
  }
}

export default function Tasks({ activeSub, onSubChange, onNavigate }) {
  const sub = ALL_SUBS.includes(activeSub) ? activeSub : DEFAULT_SUB;
  const [projectId, setProjectId] = useState(null);
  const go = (key) => (onSubChange ? onSubChange(key) : undefined);

  const onManage = sub === 'manage';
  const onTicket = sub === 'tickets';

  // Sub-view navigation. A project drill-in (from Projects) targets the generic
  // task list locked to that project; a within-module tab jump switches sub.
  const subNavigate = (a, b) => {
    if (a && typeof a === 'object' && a.projectId) { setProjectId(a.projectId); return go('tasks'); }
    if (a === 'open-task') return; // handled inside views via their own drawer
    if (a === 'tasks' && b) return go(b);
    if (ALL_SUBS.includes(a)) return go(a);
    return onNavigate ? onNavigate(a, b) : undefined;
  };

  const primaryTab = (label, active, onClick) => (
    <button onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 8, padding: '13px 0', whiteSpace: 'nowrap',
      border: 'none', borderBottom: `2px solid ${active ? NX.ink : 'transparent'}`, background: 'transparent',
      cursor: 'pointer', fontSize: 16, fontWeight: 700, fontFamily: FONT, color: active ? NX.ink : NX.dim,
    }}>{label}</button>
  );

  return (
    <TasksProvider>
      <div style={{ fontFamily: FONT, display: 'flex', flexDirection: 'column', height: '100%', background: NX.canvas }}>
        {/* Primary bar — Task | Ticket + Manage (export's NexusPrimaryTabs) */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 24, padding: '0 16px', borderBottom: `1px solid ${NX.border}`, background: NX.surface, flexShrink: 0 }}>
          {primaryTab('Task', !onTicket && !onManage, () => go(TASK_SUBS.includes(sub) ? sub : 'home'))}
          {primaryTab('Ticket', onTicket, () => go('tickets'))}
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            {onManage ? (
              <button onClick={() => go('home')} style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 8,
                border: `1px solid ${NX.primary}`, background: NX.primary, color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: FONT,
              }}><X size={14} /> Exit</button>
            ) : (
              <button onClick={() => go('manage')} style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 8,
                border: `1px solid ${NX.border}`, background: NX.surface, color: NX.ink, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: FONT,
              }}><Settings size={14} /> Manage</button>
            )}
          </div>
        </div>

        {/* Module tabs — only in Task mode (hidden on Ticket / Manage) */}
        {!onTicket && !onManage && (
          <div className="scroll-tabs" style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '0 16px', borderBottom: `1px solid ${NX.border}`, background: NX.surface, overflowX: 'auto', flexShrink: 0 }}>
            {MODULE_TABS.map(({ key, label, icon: Icon }) => {
              const on = key === sub || (key === 'projects' && sub === 'tasks');
              return (
                <button key={key} onClick={() => go(key)} style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '12px 12px', whiteSpace: 'nowrap',
                  border: 'none', borderBottom: `2px solid ${on ? NX.primary : 'transparent'}`, background: 'transparent',
                  cursor: 'pointer', fontSize: 14, fontWeight: 600, fontFamily: FONT, color: on ? NX.ink : NX.dim,
                }}><Icon size={16} /> {label}</button>
              );
            })}
          </div>
        )}

        <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          <SubView sub={sub} projectId={projectId} onNavigate={subNavigate} onExitManage={() => go('home')} />
        </div>
        <ReportBugButton />
      </div>
    </TasksProvider>
  );
}

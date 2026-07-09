// Tasks view — shell for the ported Task Module. Mounts the module's data
// provider and renders its own tab strip (the module keeps its tabs under the
// single "tasks" sidebar entry) + the active sub-view. Sub-view is driven by the
// host's activeSub/onSubChange so it round-trips through the URL like other modules.
// See docs/Task-Module-Migration-Plan.md.
import { Home, ListTodo, CheckSquare, Folder, Layers, Users, Ticket, Settings } from 'lucide-react';
import { TasksProvider } from '../tasks/TasksContext';
import TasksWorkspace from '../tasks/TasksWorkspace';
import HomeView from '../tasks/HomeView';
import ProjectsView from '../tasks/ProjectsView';
import PortfoliosView from '../tasks/PortfoliosView';
import TeamsView from '../tasks/TeamsView';
import TicketsView from '../tasks/TicketsView';
import ManageView from '../tasks/ManageView';
import { TaskToaster } from '../tasks/shared';
import ReportBugButton from '../tasks/ReportBug';
import { NX, FONT } from '../tasks/theme';

const TABS = [
  { key: 'home', label: 'Home', icon: Home },
  { key: 'mine', label: 'My tasks', icon: ListTodo },
  { key: 'tasks', label: 'All tasks', icon: CheckSquare },
  { key: 'projects', label: 'Projects', icon: Folder },
  { key: 'portfolios', label: 'Portfolios', icon: Layers },
  { key: 'teams', label: 'Teams', icon: Users },
  { key: 'tickets', label: 'Tickets', icon: Ticket },
  { key: 'manage', label: 'Manage', icon: Settings },
];
const DEFAULT_SUB = 'tasks';

function SubView({ sub, onNavigate }) {
  switch (sub) {
    case 'home':       return <HomeView onNavigate={onNavigate} />;
    case 'mine':       return <TasksWorkspace mine title="My tasks" />;
    case 'tasks':      return <TasksWorkspace title="All tasks" />;
    case 'projects':   return <ProjectsView onNavigate={onNavigate} />;
    case 'portfolios': return <PortfoliosView onNavigate={onNavigate} />;
    case 'teams':      return <TeamsView />;
    case 'tickets':    return <TicketsView />;
    case 'manage':     return <ManageView />;
    default:           return <TasksWorkspace title="All tasks" />;
  }
}

export default function Tasks({ activeSub, onSubChange, onNavigate }) {
  const sub = TABS.some((t) => t.key === activeSub) ? activeSub : DEFAULT_SUB;
  const go = (key) => (onSubChange ? onSubChange(key) : undefined);

  // Normalise navigation for sub-views: within-module tab jumps switch the
  // active sub; a project deep-link (object form) can't target a specific
  // project across the shell yet, so fall back to opening the Projects tab.
  const subNavigate = (a, b) => {
    if (a && typeof a === 'object') return go('projects');
    if (a === 'tasks' && b) return go(b);
    return onNavigate ? onNavigate(a, b) : undefined;
  };

  return (
    <TasksProvider>
      <div style={{ fontFamily: FONT, display: 'flex', flexDirection: 'column', height: '100%', background: NX.canvas }}>
        <div className="scroll-tabs" style={{ display: 'flex', gap: 2, padding: '0 16px', borderBottom: `1px solid ${NX.border}`, background: NX.surface, overflowX: 'auto', flexShrink: 0 }}>
          {TABS.map(({ key, label, icon: Icon }) => {
            const on = key === sub;
            return (
              <button key={key} onClick={() => go(key)} style={{
                display: 'flex', alignItems: 'center', gap: 7, padding: '13px 13px', whiteSpace: 'nowrap',
                border: 'none', borderBottom: `2px solid ${on ? NX.primary : 'transparent'}`, background: 'transparent',
                cursor: 'pointer', fontSize: 13.5, fontWeight: 600, fontFamily: FONT, color: on ? NX.ink : NX.dim,
              }}>
                <Icon size={15} /> {label}
              </button>
            );
          })}
        </div>
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          <SubView sub={sub} onNavigate={subNavigate} />
        </div>
        <TaskToaster />
        <ReportBugButton />
      </div>
    </TasksProvider>
  );
}

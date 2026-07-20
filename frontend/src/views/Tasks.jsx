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
import TicketsView from '../tickets/TicketsView';
import ManageView from '../tasks/ManageView';
import ReportBugButton from '../tasks/ReportBug';
import CreateMenu from '../tasks/CreateMenu';
import { useIsMobile } from '../tasks/components';
import { useRole } from '../contexts/RoleContext';
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
    case 'tasks':      return <TasksWorkspace lockedProjectId={projectId} onBack={() => onNavigate('projects')} />;
    case 'projects':   return <ProjectsView onNavigate={onNavigate} />;
    case 'portfolios': return <PortfoliosView onNavigate={onNavigate} />;
    case 'teams':      return <TeamsView onNavigate={onNavigate} />;
    case 'tickets':    return <TicketsView />;
    case 'manage':     return <ManageView onExit={onExitManage} />;
    default:           return <HomeView onNavigate={onNavigate} />;
  }
}

export default function Tasks({ activeSub, onSubChange, onNavigate }) {
  const { can } = useRole();
  // The Manage tab is an admin surface — restricted to manage access
  // (Manager / IT Admin / Global Admin). Others can neither open it nor land on
  // it via a stale URL/sub.
  const canManage = !!can?.('manager');
  const requested = ALL_SUBS.includes(activeSub) ? activeSub : DEFAULT_SUB;
  const sub = (requested === 'manage' && !canManage) ? DEFAULT_SUB : requested;
  const isMobile = useIsMobile();
  const [projectId, setProjectId] = useState(null);
  const go = (key) => (onSubChange ? onSubChange(key) : undefined);

  const onManage = sub === 'manage';
  const onTicket = sub === 'tickets';

  // A task created from the Create menu / floating + inherits the screen's
  // context — scoped to the project you've drilled into, like Asana.
  const taskDefaults = (sub === 'tasks' && projectId) ? { projectId } : {};
  // My Tasks and a project's task workspace render their own floating MobileTaskBar.
  const hasMobileBar = sub === 'mine' || sub === 'tasks';

  // Sub-view navigation. A project drill-in (from Projects) targets the generic
  // task list locked to that project; a within-module tab jump switches sub.
  const subNavigate = (a, b) => {
    if (a && typeof a === 'object' && a.projectId) { setProjectId(a.projectId); return go('tasks'); }
    if (a === 'open-task') return; // handled inside views via their own drawer
    if (a === 'tasks' && b) return go(b);
    if (ALL_SUBS.includes(a)) return go(a);
    return onNavigate ? onNavigate(a, b) : undefined;
  };

  // Tab styling matches the SOP module's Playbook/Learn bar exactly: Plus
  // Jakarta Sans, var(--text-primary)/var(--text-secondary), a 2.5px rounded
  // underline instead of a border, 10px 18px padding.
  const primaryTab = (label, active, onClick) => (
    <button onClick={onClick} className="nx-ptab" style={{
      background: 'none', border: 'none', padding: '10px 18px', whiteSpace: 'nowrap',
      fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 600, fontSize: '0.95rem',
      cursor: 'pointer', color: active ? 'var(--text-primary)' : 'var(--text-secondary)', position: 'relative',
    }}>
      {label}
      {active && <span style={{ position: 'absolute', bottom: -1, left: 0, right: 0, height: 2.5, backgroundColor: 'var(--text-primary)', borderRadius: '4px 4px 0 0' }} />}
    </button>
  );

  return (
    <TasksProvider>
      <div className="nx-tasks" style={{ fontFamily: FONT, display: 'flex', flexDirection: 'column', height: '100%', background: NX.canvas }}>
        {/* Primary bar — Task | Ticket + Create + Manage, styled to the Nexus
            global header reference (SOP's Playbook/Learn bar): shared
            .primary-btn / .secondary-btn classes, matching tab treatment. */}
        <div className="nx-primary-bar" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 16px', borderBottom: '1px solid var(--border-color)', background: 'var(--bg-card)', flexShrink: 0 }}>
          {primaryTab('Tasks', !onTicket && !onManage, () => go(TASK_SUBS.includes(sub) ? sub : 'home'))}
          {primaryTab('Tickets', onTicket, () => go('tickets'))}
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            {/* Navbar Create menu. On mobile it's shown on the screens that don't
                have their own MobileTaskBar + (My Tasks / workspace keep the bar's +). */}
            {!onManage && (!isMobile || !hasMobileBar) && <CreateMenu onNavigate={go} taskDefaults={taskDefaults} />}
            {onManage ? (
              <button className="primary-btn nx-iconbtn" onClick={() => go('home')} title="Exit" style={{ fontFamily: FONT }}>
                <X size={14} /> <span className="nx-btn-label">Exit</span>
              </button>
            ) : (canManage && !onTicket) ? (
              /* Manage is a Task-mode admin surface — hidden on the Tickets tab. */
              <button className="secondary-btn nx-iconbtn" onClick={() => go('manage')} title="Manage" style={{ fontFamily: FONT }}>
                <Settings size={14} /> <span className="nx-btn-label">Manage</span>
              </button>
            ) : null}
          </div>
        </div>

        {/* Module tabs — only in Task mode (hidden on Ticket / Manage) */}
        {!onTicket && !onManage && (
          <div className="scroll-tabs nx-module-tabs" style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '0 16px', borderBottom: `1px solid ${NX.border}`, background: NX.surface, overflowX: 'auto', flexShrink: 0 }}>
            {MODULE_TABS.map(({ key, label, icon: Icon }) => {
              const on = key === sub || (key === 'projects' && sub === 'tasks');
              return (
                <button key={key} onClick={() => go(key)} className="nx-module-tab" style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '12px 12px', whiteSpace: 'nowrap',
                  border: 'none', borderBottom: `2px solid ${on ? NX.primary : 'transparent'}`, background: 'transparent',
                  cursor: 'pointer', fontSize: 14, fontWeight: 600, fontFamily: FONT, color: on ? NX.ink : NX.dim,
                }}><Icon size={16} className="nx-module-tab-icon" /> {label}</button>
              );
            })}
          </div>
        )}

        {/* No overflow here — every sub-view owns its own header + scrolling
            body (e.g. PortfoliosView, MyTasksView). A second overflow:auto
            wrapper here double-nests scroll containers, which on some
            viewport sizes breaks height:100% propagation and clips content
            instead of letting the sub-view's own body scroll. */}
        <div style={{ flex: 1, minHeight: 0 }}>
          <SubView sub={sub} projectId={projectId} onNavigate={subNavigate} onExitManage={() => go('home')} />
        </div>
        {/* Create moved into the navbar on mobile (see the Create menu above); the
            My Tasks / workspace screens still create via their MobileTaskBar +. */}
        <ReportBugButton bottom={isMobile && hasMobileBar ? 84 : undefined} />
      </div>
    </TasksProvider>
  );
}

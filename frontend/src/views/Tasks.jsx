// Tasks view - shell for the ported Task Module. Mounts the module's data
// provider and reproduces the export's chrome inside the Nexus shell:
//   • a primary "Task | Ticket" segmented control (+ Manage) - export's NexusPrimaryTabs
//   • module tabs Home · My Tasks · Projects · Portfolios · Teams - export's NexusModuleTabs
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
import ModuleTabs from '../components/ModuleTabs';

// Module tabs - matches the export's NexusModuleTabs exactly (no "All tasks").
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

function SubView({ sub, projectId, returnTo, onNavigate, onExitManage }) {
  switch (sub) {
    case 'home':       return <HomeView onNavigate={onNavigate} />;
    case 'mine':       return <MyTasksView onOpenTask={(id) => onNavigate('open-task', id)} />;
    /* Back returns to wherever the drill-in STARTED (Home widgets link into
       projects too) - a hardcoded 'projects' stranded people who came from
       Home with a back button that went somewhere they'd never been. */
    case 'tasks':      return <TasksWorkspace lockedProjectId={projectId} onBack={() => onNavigate(returnTo || 'projects')} />;
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
  // The Manage tab is an admin surface - restricted to manage access
  // (Manager / IT Admin / Global Admin). Others can neither open it nor land on
  // it via a stale URL/sub.
  const canManage = !!can?.('manager');
  const requested = ALL_SUBS.includes(activeSub) ? activeSub : DEFAULT_SUB;
  const sub = (requested === 'manage' && !canManage) ? DEFAULT_SUB : requested;
  const isMobile = useIsMobile();
  const [projectId, setProjectId] = useState(null);
  // Where a project drill-in should return to - the sub the user was on when
  // they entered ('home' from the Home widgets, 'projects' from Projects).
  const [returnSub, setReturnSub] = useState('projects');
  const go = (key) => (onSubChange ? onSubChange(key) : undefined);

  const onManage = sub === 'manage';
  const onTicket = sub === 'tickets';

  // A task created from the Create menu / floating + inherits the screen's
  // context - scoped to the project you've drilled into, like Asana.
  const taskDefaults = (sub === 'tasks' && projectId) ? { projectId } : {};
  // My Tasks and a project's task workspace render their own floating MobileTaskBar.
  const hasMobileBar = sub === 'mine' || sub === 'tasks';

  // Sub-view navigation. A project drill-in (from Projects) targets the generic
  // task list locked to that project; a within-module tab jump switches sub.
  const subNavigate = (a, b) => {
    if (a && typeof a === 'object' && a.projectId) {
      setProjectId(a.projectId);
      setReturnSub(TASK_SUBS.includes(sub) && sub !== 'tasks' ? sub : 'projects');
      return go('tasks');
    }
    if (a === 'open-task') return; // handled inside views via their own drawer
    if (a === 'tasks' && b) return go(b);
    if (ALL_SUBS.includes(a)) return go(a);
    return onNavigate ? onNavigate(a, b) : undefined;
  };

  // Tab styling matches the SOP module's Playbook/Learn bar exactly: Plus
  // Jakarta Sans, var(--text-primary)/var(--text-secondary), a 2.5px rounded
  return (
    <TasksProvider>
      <div className="nx-tasks" style={{ fontFamily: FONT, display: 'flex', flexDirection: 'column', height: '100%', background: NX.canvas }}>
        {/* Primary bar - Tasks ⇄ Tickets is a two-MODE toggle, so it wears the
            segmented-control grammar (.wk-seg, same as chart range switches),
            not tab styling - the module's tabs already live in the top header. */}
        <div className="nx-primary-bar" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 16px', borderBottom: '1px solid var(--border-color)', background: 'var(--bg-card)', flexShrink: 0 }}>
          <div className="wk-seg">
            <button className={!onTicket && !onManage ? 'on' : ''} onClick={() => go(TASK_SUBS.includes(sub) ? sub : 'home')}>Tasks</button>
            <button className={onTicket ? 'on' : ''} onClick={() => go('tickets')}>Tickets</button>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            {/* Navbar Create menu. On mobile it's shown on the screens that don't
                have their own MobileTaskBar + (My Tasks / workspace keep the bar's +). */}
            {!onManage && (!isMobile || !hasMobileBar) && <CreateMenu onNavigate={go} taskDefaults={taskDefaults} />}
            {onManage ? (
              <button className="primary-btn nx-iconbtn" onClick={() => go('home')} title="Exit" style={{ fontFamily: FONT }}>
                <X size={14} /> <span className="nx-btn-label">Exit</span>
              </button>
            ) : (canManage && !onTicket) ? (
              /* Manage is a Task-mode admin surface - hidden on the Tickets tab. */
              <button className="secondary-btn nx-iconbtn" onClick={() => go('manage')} title="Manage" style={{ fontFamily: FONT }}>
                <Settings size={14} /> <span className="nx-btn-label">Manage</span>
              </button>
            ) : null}
          </div>
        </div>

        {/* Module tabs - only in Task mode (hidden on Ticket / Manage).
            Desktop renders them centered in the top header; phones keep the
            in-page strip (ModuleTabs handles both). 'tasks' (a drilled-in
            project task list) highlights Projects, matching the old strip. */}
        {!onTicket && !onManage && (
          <ModuleTabs
            tabs={MODULE_TABS.map(({ key, label, icon }) => ({ key, label, Icon: icon }))}
            active={sub === 'tasks' ? 'projects' : sub}
            onChange={go} />
        )}

        {/* No overflow here - every sub-view owns its own header + scrolling
            body (e.g. PortfoliosView, MyTasksView). A second overflow:auto
            wrapper here double-nests scroll containers, which on some
            viewport sizes breaks height:100% propagation and clips content
            instead of letting the sub-view's own body scroll. */}
        <div style={{ flex: 1, minHeight: 0 }}>
          <SubView sub={sub} projectId={projectId} returnTo={returnSub} onNavigate={subNavigate} onExitManage={() => go('home')} />
        </div>
        {/* Create moved into the navbar on mobile (see the Create menu above); the
            My Tasks / workspace screens still create via their MobileTaskBar +. */}
        <ReportBugButton bottom={isMobile && hasMobileBar ? 84 : undefined} />
      </div>
    </TasksProvider>
  );
}

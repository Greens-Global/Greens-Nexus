// Tasks view - shell for the ported Task Module. Mounts the module's data
// provider and reproduces the export's chrome inside the Nexus shell:
//   • module tabs Home · My Tasks · Projects · Portfolios · Teams - export's NexusModuleTabs
//   • a Manage button for admin-only settings
// Sub-view is driven by the host's activeSub/onSubChange so it round-trips through
// the URL like other Nexus modules. See docs/Task-Module-Migration-Plan.md.
// Tickets used to live here behind a Task | Ticket toggle - it's now its own
// top-level module (views/Tickets.jsx), so this file is Task-only.
import { useEffect, useState } from 'react';
import { Home, CheckCircle2, FolderKanban, Briefcase, Users, Settings, X, PlayCircle, LayoutTemplate } from 'lucide-react';
import TasksWorkspace from '../tasks/TasksWorkspace';
import HomeView from '../tasks/HomeView';
import MyTasksView from '../tasks/MyTasksView';
import ProjectsView from '../tasks/ProjectsView';
import PortfoliosView from '../tasks/PortfoliosView';
import TemplatesView from '../tasks/TemplatesView';
import TeamsView from '../tasks/TeamsView';
import ManageView from '../tasks/ManageView';
import ReportBugButton from '../tasks/ReportBug';
import CreateMenu from '../tasks/CreateMenu';
import { useIsMobile } from '../tasks/components';
import { useRole } from '../contexts/RoleContext';
import { NX, FONT } from '../tasks/theme';
import ModuleTabs from '../components/ModuleTabs';
import GuidedTour from '../components/GuidedTour';
import TaskDetailDrawer from '../tasks/TaskDetailDrawer';
import PersonView from '../tasks/PersonView';
import { EMPTY_FILTER } from '../tasks/lib';
import { buildTaskTourSteps } from '../tasks/taskTourSteps';

// Remembered per person, not per browser: on a shared machine the second
// person to sign in has not seen the tour, and inheriting somebody else's
// "already seen" would silently skip it for them.
const tourSeenKey = (email) => `nexus.taskTour.seen.${(email || 'anon').toLowerCase()}`;

// Module tabs - matches the export's NexusModuleTabs exactly (no "All tasks").
const MODULE_TABS = [
  { key: 'home', label: 'Home', icon: Home },
  { key: 'mine', label: 'My Tasks', icon: CheckCircle2 },
  { key: 'projects', label: 'Projects', icon: FolderKanban },
  { key: 'portfolios', label: 'Portfolios', icon: Briefcase },
  { key: 'templates', label: 'Templates', icon: LayoutTemplate },
  { key: 'teams', label: 'Teams', icon: Users },
];
// Task-mode subs. 'tasks' = a project's task list drilled in from Projects;
// it has no module tab of its own, matching the export.
const TASK_SUBS = ['home', 'mine', 'projects', 'portfolios', 'templates', 'teams', 'tasks'];
const DEFAULT_SUB = 'home';
const ALL_SUBS = [...TASK_SUBS, 'manage'];

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
    /* Building a project from a template drills straight into it, the same
       way Projects does - the point of the click is the new project. */
    case 'templates':  return <TemplatesView onNavigate={onNavigate} />;
    case 'teams':      return <TeamsView onNavigate={onNavigate} />;
    case 'manage':     return <ManageView onExit={onExitManage} />;
    default:           return <HomeView onNavigate={onNavigate} />;
  }
}

export default function Tasks({ activeSub, onSubChange, onNavigate }) {
  const { can, myEmail } = useRole();
  // The Manage tab is an admin surface - restricted to manage access
  // (Manager / IT Admin / Global Admin). Others can neither open it nor land on
  // it via a stale URL/sub.
  const canManage = !!can?.('manager');
  const requested = ALL_SUBS.includes(activeSub) ? activeSub : DEFAULT_SUB;
  const sub = (requested === 'manage' && !canManage) ? DEFAULT_SUB : requested;
  const isMobile = useIsMobile();
  const [tour, setTour] = useState(false);
  const [projectId, setProjectId] = useState(null);
  const [searchTaskId, setSearchTaskId] = useState(null);   // task opened from header search
  const [person, setPerson] = useState(null);               // { email, name } from header search
  const [personTasks, setPersonTasks] = useState(false);    // their page -> the full workspace
  const [searchAll, setSearchAll] = useState('');          // header search "see all" -> workspace with the query
  // Where a project drill-in should return to - the sub the user was on when
  // they entered ('home' from the Home widgets, 'projects' from Projects).
  const [returnSub, setReturnSub] = useState('projects');
  // A person opened from header search sits ON TOP of whichever sub-view was
  // active (see the render below) - switching module tabs used to change
  // `sub` underneath it while the person's page kept showing, so My Tasks/
  // Projects/etc. looked broken from there. Any tab jump exits it first.
  const go = (key) => {
    if (person) { setPerson(null); setPersonTasks(false); }
    if (searchAll) setSearchAll('');   // a tab click leaves the search results
    return onSubChange ? onSubChange(key) : undefined;
  };

  // First visit runs the tour on its own; after that it is the button only.
  // Held until myEmail resolves, otherwise the flag is written against 'anon'
  // and the real person is marked as having seen a tour they never got.
  useEffect(() => {
    if (!myEmail) return;
    let seen = true;
    try { seen = !!localStorage.getItem(tourSeenKey(myEmail)); } catch { /* private mode */ }
    if (!seen) setTour(true);
  }, [myEmail]);

  const closeTour = () => {
    setTour(false);
    // Written on close, not on finish: someone who dismisses it has decided,
    // and re-offering it on their next visit would be nagging.
    try { localStorage.setItem(tourSeenKey(myEmail), new Date().toISOString()); } catch { /* private mode */ }
  };

  // Header search lands here. The drawer is hosted at THIS level rather than
  // inside a sub-view so a result opens the same way from every tab - and this
  // component already sits inside TasksProvider, which the drawer needs.
  // `nexus:tasks-person` is the person result, and it opens a real page for
  // them (PersonView) rather than the task workspace filtered by assignee -
  // that answered "their tasks" and nothing else, with no name, role or teams.
  useEffect(() => {
    const openTask = (e) => { const id = e.detail?.taskId; if (id) setSearchTaskId(id); };
    const openPerson = (e) => {
      const email = e.detail?.email;
      if (email) { setPerson({ email, name: e.detail?.name || email }); setPersonTasks(false); }
    };
    // Header search "and N more": the dropdown caps at 20, so the full result
    // set lives here - the workspace with the same words in its search box.
    const openSearch = (e) => { const q = (e.detail?.q || '').trim(); if (q) setSearchAll(q); };
    window.addEventListener('nexus:open-task', openTask);
    window.addEventListener('nexus:tasks-person', openPerson);
    window.addEventListener('nexus:tasks-search', openSearch);
    return () => {
      window.removeEventListener('nexus:open-task', openTask);
      window.removeEventListener('nexus:tasks-person', openPerson);
      window.removeEventListener('nexus:tasks-search', openSearch);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onManage = sub === 'manage';

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
    <div className="nx-tasks" style={{ fontFamily: FONT, display: 'flex', flexDirection: 'column', height: '100%', background: NX.canvas }}>
      {/* Primary bar - Create + Manage. */}
      <div className="nx-primary-bar" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 16px', borderBottom: '1px solid var(--border-color)', background: 'var(--bg-card)', flexShrink: 0 }}>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* Navbar Create menu. On mobile it's shown on the screens that don't
              have their own MobileTaskBar + (My Tasks / workspace keep the bar's +). */}
          {!onManage && (!isMobile || !hasMobileBar) && (
            <span data-tour="task-create"><CreateMenu onNavigate={go} taskDefaults={taskDefaults} /></span>
          )}
          {!onManage && (
            <button onClick={() => setTour(true)} title="A guided walkthrough of the Task module - nothing is changed while it runs."
              className="secondary-btn nx-iconbtn" style={{ fontFamily: FONT }}>
              <PlayCircle size={14} /> <span className="nx-btn-label">Tour</span>
            </button>
          )}
          {onManage ? (
            <button className="primary-btn nx-iconbtn" onClick={() => go('home')} title="Exit" style={{ fontFamily: FONT }}>
              <X size={14} /> <span className="nx-btn-label">Exit</span>
            </button>
          ) : canManage ? (
            <button data-tour="task-manage" className="secondary-btn nx-iconbtn" onClick={() => go('manage')} title="Manage" style={{ fontFamily: FONT }}>
              <Settings size={14} /> <span className="nx-btn-label">Manage</span>
            </button>
          ) : null}
        </div>
      </div>

      {/* Module tabs - hidden on Manage. Desktop renders them centered in the
          top header; phones keep the in-page strip (ModuleTabs handles both).
          'tasks' (a drilled-in project task list) highlights Projects,
          matching the old strip. */}
      {!onManage && (
        <div data-tour="task-tabs">
          <ModuleTabs
            tabs={MODULE_TABS.map(({ key, label, icon }) => ({ key, label, Icon: icon }))}
            active={sub === 'tasks' ? 'projects' : sub}
            onChange={go} />
        </div>
      )}

      {/* No overflow here - every sub-view owns its own header + scrolling
          body (e.g. PortfoliosView, MyTasksView). A second overflow:auto
          wrapper here double-nests scroll containers, which on some
          viewport sizes breaks height:100% propagation and clips content
          instead of letting the sub-view's own body scroll. */}
      {/* data-tour tracks the active tab, so the guided tour can spotlight
          "this whole screen" without every sub-view needing its own hook. */}
      <div style={{ flex: 1, minHeight: 0 }} data-tour={`task-screen-${sub}`}>
        {searchAll ? (
          <TasksWorkspace
            key={`search-${searchAll}`}
            title={`Search · "${searchAll}"`}
            initialSearch={searchAll}
            onBack={() => setSearchAll('')}
          />
        ) : person && personTasks ? (
          /* "View all tasks" from the person page - the workspace is the right
             home for filtering and bulk edits, seeded with their assignee filter. */
          <TasksWorkspace
            title={`Tasks · ${person.name}`}
            initialFilters={{ ...EMPTY_FILTER, assigneeIds: [person.email] }}
            onBack={() => setPersonTasks(false)}
          />
        ) : person ? (
          <PersonView
            email={person.email}
            name={person.name}
            onBack={() => { setPerson(null); go('home'); }}
            onViewAllTasks={() => setPersonTasks(true)}
            onOpenProject={(id) => { setPerson(null); subNavigate({ projectId: id }); }}
          />
        ) : (
          <SubView sub={sub} projectId={projectId} returnTo={returnSub} onNavigate={subNavigate} onExitManage={() => go('home')} />
        )}
      </div>
      {/* A task opened from header search - hosted here so it works from any tab. */}
      {searchTaskId && <TaskDetailDrawer taskId={searchTaskId} onClose={() => setSearchTaskId(null)} />}
      {/* Create moved into the navbar on mobile (see the Create menu above); the
          My Tasks / workspace screens still create via their MobileTaskBar +. */}
      <ReportBugButton bottom={isMobile && hasMobileBar ? 84 : undefined} />
      {tour && (
        <GuidedTour
          steps={buildTaskTourSteps({ go, canManage, isMobile })}
          onClose={closeTour} />
      )}
    </div>
  );
}

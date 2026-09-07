// Tasks view - shell for the ported Task Module. Mounts the module's data
// provider and reproduces the export's chrome inside the Nexus shell:
//   • module tabs Home · My Tasks · Projects · Portfolios · Teams - export's NexusModuleTabs
//   • a Manage button for admin-only settings, plus a slot the active
//     sub-view can portal its own page-level control into (Home's Customize)
// Sub-view is driven by the host's activeSub/onSubChange so it round-trips through
// the URL like other Nexus modules. See docs/Task-Module-Migration-Plan.md.
// Tickets used to live here behind a Task | Ticket toggle - it's now its own
// top-level module (views/Tickets.jsx), so this file is Task-only.
import { useEffect, useState } from 'react';
import { takePendingOpen } from '../lib/pendingOpen';
import { Home, CheckCircle2, FolderKanban, Briefcase, Users, Settings } from 'lucide-react';
import TasksWorkspace from '../tasks/TasksWorkspace';
import HomeView from '../tasks/HomeView';
import MyTasksView from '../tasks/MyTasksView';
import ProjectsView from '../tasks/ProjectsView';
import PortfoliosView from '../tasks/PortfoliosView';
import TemplatesView from '../tasks/TemplatesView';
import TeamsView from '../tasks/TeamsView';
import ManageView from '../tasks/ManageView';
import CreateMenu from '../tasks/CreateMenu';
import { useIsMobile } from '../tasks/components';
import { useRole } from '../contexts/RoleContext';
import { NX, FONT, btn as btnStyle } from '../tasks/theme';
import ModuleTabs from '../components/ModuleTabs';
import GuidedTour from '../components/GuidedTour';
import TaskDetailDrawer from '../tasks/TaskDetailDrawer';
import PersonView from '../tasks/PersonView';
import { EMPTY_FILTER } from '../tasks/lib';
import { buildTaskTourSteps } from '../tasks/taskTourSteps';
import { api } from '../api';

// Tour id this module reports to the server (routers/user_tours.py). "Seen"
// is per person, not per browser or machine - see GET/POST /tours.
const TASK_TOUR_ID = 'task';

// Module tabs - matches the export's NexusModuleTabs exactly (no "All tasks").
// Templates has no tab of its own (moved under Projects, Aug 27) - it's reached
// via the "Templates" entry point on the Projects screen instead.
const MODULE_TABS = [
  { key: 'home', label: 'Home', icon: Home },
  { key: 'mine', label: 'My Tasks', icon: CheckCircle2 },
  { key: 'projects', label: 'Projects', icon: FolderKanban },
  { key: 'portfolios', label: 'Portfolios', icon: Briefcase },
  { key: 'teams', label: 'Teams', icon: Users },
];
// Task-mode subs. 'tasks' (a drilled-in project's task list) and 'templates'
// (reached from Projects) have no module tab of their own.
const TASK_SUBS = ['home', 'mine', 'projects', 'portfolios', 'templates', 'teams', 'tasks'];
// What the floating "+" makes on each screen: the thing that screen is a list
// of. A "+" on the Projects page that opened a task picker was the confusing
// part - the button is where your thumb already is when you're looking at the
// list you want to add to (Sagar, Sept 1 2026). The full menu is always a
// click away in the bar's "+ Create".
// Home and Teams are deliberately absent (Sagar, Sept 2 2026): Home's bar
// already carries Create next to Customize and Manage, and a team is made from
// Manage, not from the browsing screen.
const FAB_CREATES = {
  mine: 'task', tasks: 'task',
  projects: 'project', portfolios: 'portfolio', templates: 'template',
};
const DEFAULT_SUB = 'home';
const ALL_SUBS = [...TASK_SUBS, 'manage'];

function SubView({ sub, projectId, returnTo, onNavigate, onExitManage }) {
  switch (sub) {
    case 'home':       return <HomeView onNavigate={onNavigate} />;
    case 'mine':       return <MyTasksView onOpenTask={(id) => onNavigate('open-task', id)} onNavigate={onNavigate} />;
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
  // Held until myEmail resolves, otherwise the check would race the identity
  // load. "Seen" is read from the server (per person, not per browser) - see
  // routers/user_tours.py.
  useEffect(() => {
    if (!myEmail) return;
    let cancelled = false;
    api.getToursSeen()
      .then(({ seen }) => { if (!cancelled && !seen?.[TASK_TOUR_ID]) setTour(true); })
      .catch(() => { /* can't confirm "seen" - skip the auto-tour rather than risk nagging on every flaky load */ });
    return () => { cancelled = true; };
  }, [myEmail]);

  const closeTour = () => {
    setTour(false);
    // Written on close, not on finish: someone who dismisses it has decided,
    // and re-offering it on their next visit would be nagging. Best-effort -
    // a failed write just means the tour offers itself again next login.
    api.markTourSeen(TASK_TOUR_ID).catch(() => {});
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
    // Fired by the profile dropdown's "Tour" row (TopHeader), shown only while
    // the Task module is the active view.
    const openTour = () => setTour(true);
    window.addEventListener('nexus:open-task', openTask);
    // Lazy module: on a first visit the bell's event fired before this mounted,
    // so it also left the id behind. See lib/pendingOpen.js.
    const pending = takePendingOpen('task');
    if (pending) setSearchTaskId(pending);
    window.addEventListener('nexus:tasks-person', openPerson);
    window.addEventListener('nexus:tasks-search', openSearch);
    window.addEventListener('nexus:tasks-tour', openTour);
    return () => {
      window.removeEventListener('nexus:open-task', openTask);
      window.removeEventListener('nexus:tasks-person', openPerson);
      window.removeEventListener('nexus:tasks-search', openSearch);
      window.removeEventListener('nexus:tasks-tour', openTour);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onManage = sub === 'manage';

  // A task created from the Create menu / floating + inherits the screen's
  // context - scoped to the project you've drilled into, like Asana.
  const taskDefaults = (sub === 'tasks' && projectId) ? { projectId } : {};
  // My Tasks and a project's task workspace render their own floating MobileTaskBar.
  const hasMobileBar = sub === 'mine' || sub === 'tasks';
  // "+ Create" sits in the bar next to Manage on every screen, not just Home -
  // the whole module's create menu, reachable wherever you are. Phones don't
  // get it: that bar is down to Manage alone at phone width, and the floating
  // "+" is the better shape for a thumb anyway.
  const inlineCreate = !isMobile;
  // ...and the floating "+" makes this page's own thing (see FAB_CREATES).
  const fabCreate = FAB_CREATES[sub] || '';

  // Bottom-right corner, stacked: Report a Bug sits on the floor, the create
  // "+" rides above it. Derived from one base so a change to either offset
  // cannot slide them into each other - they overlapped for exactly that
  // reason before, each carrying its own hand-tuned number.
  const bugBottom = isMobile ? (hasMobileBar ? 84 : 14) + (onManage ? 0 : 64) : 14;
  const fabBottom = bugBottom + 46;

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
      {/* Module tabs - hidden on Manage. Desktop renders them centered in the
          top header. Phones get a fixed bottom tab bar instead (Asana-app
          style: icon over label - see MobileNav.jsx's TASK_ACTIONS, driven by
          the URL's activeSub so it needs no wiring here), so the in-page
          fallback ModuleTabs would otherwise render is suppressed with
          mobileInline={false}. 'tasks' (a drilled-in project task list) and
          'templates' (reached from the Projects screen) both highlight
          Projects, since neither has a tab of its own. */}
      {/* One bar: module tabs on the left, Manage on the right. The tabs moved
          down out of the app's top header (Sagar, Sept 1 2026) into the row
          that used to carry "+ Create" and Manage alone - that row was nearly
          empty on every screen, and the tabs fill it instead of costing a
          second one. Create is the floating "+" below, so Manage is all that
          shares the row. Hidden on Manage, which has no module tabs and
          carries its own Exit on its sub-tab strip. */}
      {!onManage && (
        <div className="nx-primary-bar" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '0 16px', borderBottom: '1px solid var(--border-color)', background: 'var(--bg-card)', flexShrink: 0 }}>
          {/* Phones get the module's tabs from MobileNav's bottom bar instead,
              so the strip is only rendered from ~641px up. */}
          <div data-tour="task-tabs" style={{ flex: 1, minWidth: 0 }}>
            {!isMobile && (
              <ModuleTabs inline
                tabs={MODULE_TABS.map(({ key, label, icon }) => ({ key, label, Icon: icon }))}
                active={(sub === 'tasks' || sub === 'templates') ? 'projects' : sub}
                onChange={go} />
            )}
          </div>
          {/* Create sits first of the three, per the module's left-to-right
              order of doing-then-arranging: make something, arrange the page,
              then administer the workspace. */}
          {inlineCreate && (
            <span data-tour="task-create">
              <CreateMenu variant="inline" onNavigate={go} taskDefaults={taskDefaults} />
            </span>
          )}
          {/* Slot for the active sub-view's own page-level control, portaled in
              by the sub-view itself (Home's Customize / Done - see HomeView).
              It sits here rather than in the page body so the module's two
              top-level controls read as one group in the same bar, instead of
              one floating over the widget grid a row below the other. */}
          <div id="nx-tasks-bar-actions" style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }} />
          {/* Outside the tab strip's own scroller, so it cannot scroll away on
              a narrow window the way Manage used to. */}
          {canManage && (
            <button data-tour="task-manage" className="nx-iconbtn" onClick={() => go('manage')} title="Manage"
              style={{ ...btnStyle('outline'), flexShrink: 0 }}>
              <Settings size={14} /> <span className="nx-btn-label">Manage</span>
            </button>
          )}
        </div>
      )}

      {/* No overflow here - every sub-view owns its own header + scrolling
          body (e.g. PortfoliosView, MyTasksView). A second overflow:auto
          wrapper here double-nests scroll containers, which on some
          viewport sizes breaks height:100% propagation and clips content
          instead of letting the sub-view's own body scroll. */}
      {/* data-tour tracks the active tab, so the guided tour can spotlight
          "this whole screen" without every sub-view needing its own hook. */}
      {/* The page's own floating create. Suppressed on Manage (nothing there is
          created this way) and, on phones, on the two screens whose own
          MobileTaskBar already carries a "+" - two floating create buttons on
          one phone screen is the thing that bar exists to avoid. */}
      {!onManage && fabCreate && (!isMobile || !hasMobileBar) && (
        <CreateMenu onNavigate={go} taskDefaults={taskDefaults} bottom={fabBottom} create={fabCreate} />
      )}

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
      {tour && (
        <GuidedTour
          steps={buildTaskTourSteps({ go, canManage, isMobile })}
          onClose={closeTour} />
      )}
    </div>
  );
}

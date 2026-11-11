import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { CalendarClock, CalendarDays, Contact, ListChecks, MonitorDot, UserPlus } from 'lucide-react';
import { api } from '../api';
import { useRole } from '../contexts/RoleContext';
import MyShifts from '../components/MyShifts';
import { SkeletonBlocks } from '../components/AsyncState';
import ShiftSchedule from '../components/ShiftSchedule';
import { hasUnsavedWork, askToLeave } from '../lib/dialogGuard';
import { canOpenWorkforceAnalytics } from '../lib/workforceAccess';
import ModuleTabs, { ModuleActions } from '../components/ModuleTabs';

// Team (Neil, Oct 13 2026; was Shifts, Sep 29): everything about the people
// you work with. Contact (the Contact Directory, moved out of Support) and
// Shifts (your group's week) for everyone; the Shift Planner for managers
// and above. Requests - the manager's inbox - moved into Dashboard >
// Approvals (Neil, 11/04/2026); old 'requests' links land there (App.jsx)
// and the planner names the requests on its dates (shifts/RequestsStrip).
// Your OWN week is Workday > My Shifts (Neil: "the personal shift data should
// move into your Workday"); old 'mine' links are redirected there (App.jsx).
// An employee asks for a swap, an offer, an open shift or time off in
// Workday > Time Off; shift settings, shift types and groups are in
// Settings > Global Settings > Shifts. Employees never change a shift - the
// backend refuses any write below manager (routers/timeclock.py
// require_shift_manage).

// Lazy: the directory is a big screen, and only its tab needs it.
const Directory = lazy(() => import('./Directory'));
const RoleChecklists = lazy(() => import('../components/HrChecklists').then(m => ({ default: m.RoleChecklists })));
// Headcount requests (Neil, Oct 27 2026): a manager asks to hire here, and the
// department line and HR decide here - shown to anyone the server says may
// raise one or has one to see (GET /hiring/headcount/meta showTab).
const HeadcountRequests = lazy(() => import('../components/hiring/HeadcountRequests'));
// Workforce Analytics (Neil, Oct 29 2026: moved here from its own left-menu
// item). Only for the people lib/workforceAccess.js names - never every
// manager; the tab is not drawn, and its address falls back to Shifts, for
// anyone else.
const WorkforceAnalytics = lazy(() => import('../components/TimeTrackingAdmin'));

// Directory right after Shift Planner (Neil, 11/04/2026 - it was last,
// Pranshu, Oct 15 2026); Team opens on Shifts.
const TABS = [
  ['shifts', 'Shifts', CalendarClock, false],
  ['schedule', 'Shift Planner', CalendarDays, true],
  ['contact', 'Directory', Contact, false],
  ['analytics', 'Workforce Analytics', MonitorDot, false],
  // A role's own checklist steps, for department heads (Neil, Oct 19) - only
  // shown to someone who keeps at least one role.
  ['role-checklists', 'Role Checklists', ListChecks, false],
  ['headcount', 'Headcount', UserPlus, false],
];

export default function Shifts({ activeSub, onSubChange }) {
  const role = useRole();
  const { can } = role;
  // The Shift Planner grant opens the planner tab below Manager (11/10/2026);
  // the server decides what it may change.
  const canManage = can('manager') || (!role.isExternal && role.canAccessModule('shifts', 'manager'));
  const canAnalytics = canOpenWorkforceAnalytics(role);
  const [keepsRoles, setKeepsRoles] = useState(false);
  useEffect(() => {
    if (role.isExternal) return;   // a guest sees the Workforce Analytics tab alone
    Promise.resolve().then(() => api.getRoleChecklistRoles())
      .then(r => setKeepsRoles((r?.roles || []).length > 0)).catch(() => {});
  }, [role.isExternal]);
  const [headcount, setHeadcount] = useState({ show: false, waiting: 0 });
  useEffect(() => {
    if (role.isExternal) return;
    Promise.resolve().then(() => api.headcountMeta())
      .then(m => setHeadcount({ show: !!m?.showTab, waiting: m?.waiting || 0 })).catch(() => {});
  }, [role.isExternal]);
  // An external (B2B guest) account reaches Team only through a Workforce
  // Analytics grant (App.jsx VIEW_ALT_GRANTS) and sees that tab alone -
  // never the group's shifts or the company directory.
  const tabs = role.isExternal
    ? TABS.filter(([key]) => key === 'analytics' && canAnalytics)
    : TABS.filter(([key, , , managerOnly]) => (canManage || !managerOnly) && (key !== 'role-checklists' || keepsRoles)
      && (key !== 'headcount' || headcount.show) && (key !== 'analytics' || canAnalytics));
  // A weather advisory's bell deep-links to one day of one group:
  // sub = "schedule:YYYY-MM-DD:<group id>[:<place>]" (Weather Call, Oct 2026;
  // the place - a jobsite - since the weather follows it, 10/30/2026). The
  // tab is the part before the first colon; the rest is where to land.
  const [subKey, focusDate = '', focusGroup = '', focusPlace = ''] = String(activeSub || '').split(':');
  // Workforce Analytics reads the part after the colon as its own tab:
  // "analytics:scorecard" (the Monday email), "analytics:coverage" (alerts).
  const tab = tabs.some(([k]) => k === subKey) ? subKey : (tabs[0]?.[0] || '');
  const focus = tab === 'schedule' && /^\d{4}-\d{2}-\d{2}$/.test(focusDate) ? { date: focusDate, groupId: focusGroup, place: focusPlace } : null;
  // A publish or nudge bell's "mine:confirm:<publish id>" (Shifts Phase 3a)
  // is your OWN week, so App.jsx sends it to Workday's My Schedule (Oct 15).
  // Consumed once: the schedule has landed (its own effect ran first), so
  // the address goes back to plain "schedule" and the same bell clicked
  // again is a change again.
  useEffect(() => { if (focus) onSubChange?.('schedule'); }, [activeSub]);   // eslint-disable-line react-hooks/exhaustive-deps
  const [toast, setToast] = useState(null);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  // Stable, so the schedule never reloads just because a toast showed.
  const show = useCallback((msg, kind) => {
    setToast({ msg, kind });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), kind === 'error' ? 5000 : 4000);
  }, []);
  const toastOk = useCallback((msg) => show(msg, 'ok'), [show]);
  const toastErr = useCallback((msg) => show(msg, 'error'), [show]);
  // Leaving the Schedule with unshared changes asks first (Neil, Oct 28 2026).
  const goTab = (key) => (key !== tab && hasUnsavedWork() ? askToLeave().then((ok) => ok && onSubChange?.(key)) : onSubChange?.(key));
  // Where the Contact tab's Manage / Export buttons go: the right end of the tab row.
  const [toolSlot, setToolSlot] = useState(null);

  return (
    <div style={{ animation: 'fadeIn var(--transition-normal) ease-in-out' }}>
      {/* No page title (Neil, 11/06/2026): the bar names the module and lights
          the tab. The tabs ride the module bar (one page header, 11/05/2026); phones
          keep the in-page strip. Contact's Manage / Export go to the bar's
          right end. */}
      <ModuleTabs tabs={tabs.map(([key, label, Icon]) => ({ key, label, Icon, badge: key === 'headcount' ? headcount.waiting : 0 }))}
        active={tab} onChange={goTab} />
      {tab === 'contact' && <ModuleActions><div ref={setToolSlot} /></ModuleActions>}

      {tab === 'contact' ? <Suspense fallback={<SkeletonBlocks count={4} height={96} />}><Directory embedded toolsTarget={toolSlot} /></Suspense>
        : tab === 'shifts' ? <MyShifts part="team" />
        : tab === 'schedule' ? <ShiftSchedule toastOk={toastOk} toastErr={toastErr} focus={focus} />
        : tab === 'role-checklists' ? <Suspense fallback={<SkeletonBlocks count={3} height={56} />}><RoleChecklists toastOk={toastOk} toastErr={toastErr} /></Suspense>
        : tab === 'analytics' ? <Suspense fallback={<SkeletonBlocks count={4} height={96} />}><WorkforceAnalytics initialSub={focusDate || undefined} embedded onTab={(id) => onSubChange?.(`analytics:${id}`)} /></Suspense>
        : tab === 'headcount' ? <Suspense fallback={<SkeletonBlocks count={3} height={56} />}><HeadcountRequests toastOk={toastOk} toastErr={toastErr} /></Suspense>
        // Named, never the fall-through: a tab nobody may see renders nothing.
        : null}

      {toast && (
        <div role="status" style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', background: toast.kind === 'error' ? 'hsl(var(--color-red))' : 'hsl(var(--color-green))', color: '#fff', borderRadius: 10, padding: '10px 18px', fontSize: 13, fontWeight: 600, zIndex: 1300, boxShadow: 'var(--shadow-lg)', maxWidth: '90vw' }}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}

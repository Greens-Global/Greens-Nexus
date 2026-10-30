import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { CalendarClock, CalendarDays, Contact, Inbox, Handshake, ListChecks, MonitorDot, UserPlus } from 'lucide-react';
import { api } from '../api';
import { useRole } from '../contexts/RoleContext';
import MyShifts from '../components/MyShifts';
import { SkeletonBlocks } from '../components/AsyncState';
import ShiftRequestsPage from '../components/ShiftRequestsPage';
import ShiftSchedule from '../components/ShiftSchedule';
import { useManagerInbox } from '../components/shifts/useManagerInbox';
import { hasUnsavedWork, askToLeave } from '../lib/dialogGuard';
import { canOpenWorkforceAnalytics } from '../lib/workforceAccess';

// Team (Neil, Oct 13 2026; was Shifts, Sep 29): everything about the people
// you work with. Contact (the Contact Directory, moved out of Support) and
// Shifts (your group's week) for everyone; Schedule and Requests - the
// manager's inbox, with a badge for what waits - for managers and above.
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

// Contact last (Pranshu, Oct 15 2026); Team opens on Shifts.
const TABS = [
  ['shifts', 'Shifts', CalendarClock, false],
  ['schedule', 'Schedule', CalendarDays, true],
  ['requests', 'Requests', Inbox, true],
  ['analytics', 'Workforce Analytics', MonitorDot, false],
  // A role's own checklist steps, for department heads (Neil, Oct 19) - only
  // shown to someone who keeps at least one role.
  ['role-checklists', 'Role Checklists', ListChecks, false],
  ['headcount', 'Headcount', UserPlus, false],
  ['contact', 'Directory', Contact, false],
];
const SUBTITLE = {
  contact: 'Find and reach anyone in the company',
  shifts: "Your group's week",
  schedule: "Build, share and adjust the team's schedule",
  requests: "Decide your team's time off, swaps, offers and open-shift requests",
  'role-checklists': "The extra onboarding, promotion, offboarding and leave steps your department's roles need",
  headcount: 'Ask to hire, and approve the requests waiting on you',
  analytics: 'Disclosed monitoring - coverage, activity, the weekly Scorecard, locations and company computers',
};

export default function Shifts({ activeSub, onSubChange }) {
  const role = useRole();
  const { can } = role;
  const canManage = can('manager');
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
  // sub = "schedule:YYYY-MM-DD:<group id>" (Weather Call, Oct 2026). The tab
  // is the part before the first colon; the rest is where to land.
  const [subKey, focusDate = '', focusGroup = ''] = String(activeSub || '').split(':');
  // Workforce Analytics reads the part after the colon as its own tab:
  // "analytics:scorecard" (the Monday email), "analytics:coverage" (alerts).
  const tab = tabs.some(([k]) => k === subKey) ? subKey : (tabs[0]?.[0] || '');
  const focus = tab === 'schedule' && /^\d{4}-\d{2}-\d{2}$/.test(focusDate) ? { date: focusDate, groupId: focusGroup } : null;
  // A publish or nudge bell's "mine:confirm:<publish id>" (Shifts Phase 3a)
  // is your OWN week, so App.jsx sends it to Workday's My Schedule (Oct 15).
  // Consumed once: the schedule has landed (its own effect ran first), so
  // the address goes back to plain "schedule" and the same bell clicked
  // again is a change again.
  useEffect(() => { if (focus) onSubChange?.('schedule'); }, [activeSub]);   // eslint-disable-line react-hooks/exhaustive-deps
  const [toast, setToast] = useState(null);
  const timer = useRef(null);
  const requests = useManagerInbox(canManage);
  useEffect(() => () => clearTimeout(timer.current), []);

  // Stable, so the schedule never reloads just because a toast showed.
  const show = useCallback((msg, kind) => {
    setToast({ msg, kind });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), kind === 'error' ? 5000 : 4000);
  }, []);
  const toastOk = useCallback((msg) => show(msg, 'ok'), [show]);
  const toastErr = useCallback((msg) => show(msg, 'error'), [show]);
  const openRequests = useCallback(() => onSubChange?.('requests'), [onSubChange]);
  // Leaving the Schedule with unshared changes asks first (Neil, Oct 28 2026).
  const goTab = (key) => (key !== tab && hasUnsavedWork() ? askToLeave().then((ok) => ok && onSubChange?.(key)) : onSubChange?.(key));
  // Where the Contact tab's Manage / Export buttons go: the right end of the tab row.
  const [toolSlot, setToolSlot] = useState(null);

  return (
    <div style={{ animation: 'fadeIn var(--transition-normal) ease-in-out' }}>
      <div className="view-header" style={{ marginBottom: 14, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0, flex: 1 }}>
          <span style={{ width: 38, height: 38, borderRadius: 10, background: 'var(--wk-brand-tint)', color: 'var(--wk-brand)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Handshake size={19} />
          </span>
          <div className="view-title-group">
            <h2 style={{ fontFamily: 'var(--wk-font)' }}>Team</h2>
            <p>{SUBTITLE[tab]}</p>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18, borderBottom: '1px solid var(--wk-line)', flexWrap: 'wrap' }}>
      <div className="scroll-tabs" role="tablist" style={{ display: 'flex', gap: 2, minWidth: 0 }}>
        {tabs.map(([key, label, Icon]) => {
          const on = tab === key;
          const badge = key === 'requests' ? requests.pendingCount : key === 'headcount' ? headcount.waiting : 0;
          return (
            <button key={key} type="button" role="tab" aria-selected={on} onClick={() => goTab(key)}
              aria-label={badge ? `${label}, ${badge} waiting` : undefined}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 14px', border: 'none', background: 'none',
                cursor: 'pointer', fontFamily: 'var(--wk-font)', fontSize: 13.5, fontWeight: on ? 700 : 600,
                color: on ? 'var(--wk-brand)' : 'var(--muted)', whiteSpace: 'nowrap', marginBottom: -1,
                borderBottom: on ? '2.5px solid var(--wk-brand)' : '2.5px solid transparent' }}>
              <Icon size={15} /> {label}
              {badge > 0 && <span style={{ fontSize: 10.5, fontWeight: 800, background: 'hsl(var(--color-red))', color: '#fff', borderRadius: 10, padding: '0 6px', minWidth: 18, textAlign: 'center' }}>{badge}</span>}
            </button>
          );
        })}
      </div>
      {tab === 'contact' && <div ref={setToolSlot} style={{ marginLeft: 'auto', padding: '4px 0' }} />}
      </div>

      {tab === 'contact' ? <Suspense fallback={<SkeletonBlocks count={4} height={96} />}><Directory embedded toolsTarget={toolSlot} /></Suspense>
        : tab === 'shifts' ? <MyShifts part="team" />
        : tab === 'schedule' ? <ShiftSchedule toastOk={toastOk} toastErr={toastErr} onOpenRequests={openRequests} focus={focus} />
        : tab === 'role-checklists' ? <Suspense fallback={<SkeletonBlocks count={3} height={56} />}><RoleChecklists toastOk={toastOk} toastErr={toastErr} /></Suspense>
        : tab === 'analytics' ? <Suspense fallback={<SkeletonBlocks count={4} height={96} />}><WorkforceAnalytics initialSub={focusDate || undefined} embedded onTab={(id) => onSubChange?.(`analytics:${id}`)} /></Suspense>
        : tab === 'headcount' ? <Suspense fallback={<SkeletonBlocks count={3} height={56} />}><HeadcountRequests toastOk={toastOk} toastErr={toastErr} /></Suspense>
        // Named, never the fall-through: a tab nobody may see renders nothing.
        : tab === 'requests' ? <ShiftRequestsPage inbox={requests.inbox} timeoff={requests.timeoff} loading={requests.loading} error={requests.error}
            onRetry={requests.reload} onChanged={requests.reload} toastOk={toastOk} toastErr={toastErr} />
        : null}

      {toast && (
        <div role="status" style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', background: toast.kind === 'error' ? 'hsl(var(--color-red))' : 'hsl(var(--color-green))', color: '#fff', borderRadius: 10, padding: '10px 18px', fontSize: 13, fontWeight: 600, zIndex: 1300, boxShadow: 'var(--shadow-lg)', maxWidth: '90vw' }}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}

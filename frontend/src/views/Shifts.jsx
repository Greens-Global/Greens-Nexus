import { useCallback, useEffect, useRef, useState } from 'react';
import { CalendarClock, CalendarDays, Inbox, UserRound } from 'lucide-react';
import { useRole } from '../contexts/RoleContext';
import MyShifts from '../components/MyShifts';
import ShiftRequestsPage from '../components/ShiftRequestsPage';
import ShiftSchedule from '../components/ShiftSchedule';
import { useManagerInbox } from '../components/shifts/useManagerInbox';

// Shifts (Sep 29 2026): its own module in My Desk. Three tabs (Charmi,
// 09/30): My Shifts for everyone; Schedule and Requests - the manager's
// inbox, with a badge for what waits - for managers and above. An employee
// asks for a swap, an offer, an open shift or time off in Workday > Time
// Off; shift settings, shift types and groups are in Settings > Global
// Settings > Shifts. Employees never change a shift - the backend refuses
// any write below manager (routers/timeclock.py require_shift_manage).

const TABS = [
  ['mine', 'My Shifts', UserRound, false],
  ['schedule', 'Schedule', CalendarDays, true],
  ['requests', 'Requests', Inbox, true],
];
const SUBTITLE = {
  mine: "Your week at a glance, and your group's",
  schedule: "Build, share and adjust the team's schedule",
  requests: "Decide your team's time off, swaps, offers and open-shift requests",
};

export default function Shifts({ activeSub, onSubChange }) {
  const { can } = useRole();
  const canManage = can('manager');
  const tabs = TABS.filter(([, , , managerOnly]) => canManage || !managerOnly);
  const tab = tabs.some(([k]) => k === activeSub) ? activeSub : 'mine';
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

  return (
    <div style={{ animation: 'fadeIn var(--transition-normal) ease-in-out' }}>
      <div className="view-header" style={{ marginBottom: 14, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0, flex: 1 }}>
          <span style={{ width: 38, height: 38, borderRadius: 10, background: 'var(--wk-brand-tint)', color: 'var(--wk-brand)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <CalendarClock size={19} />
          </span>
          <div className="view-title-group">
            <h2 style={{ fontFamily: 'var(--wk-font)' }}>Shifts</h2>
            <p>{SUBTITLE[tab]}</p>
          </div>
        </div>
      </div>

      <div className="scroll-tabs" role="tablist" style={{ display: 'flex', gap: 2, marginBottom: 18, borderBottom: '1px solid var(--wk-line)' }}>
        {tabs.map(([key, label, Icon]) => {
          const on = tab === key;
          const badge = key === 'requests' ? requests.pendingCount : 0;
          return (
            <button key={key} type="button" role="tab" aria-selected={on} onClick={() => onSubChange?.(key)}
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

      {tab === 'mine' ? <MyShifts />
        : tab === 'schedule' ? <ShiftSchedule toastOk={toastOk} toastErr={toastErr} onOpenRequests={openRequests} />
          : <ShiftRequestsPage inbox={requests.inbox} timeoff={requests.timeoff} loading={requests.loading} error={requests.error}
            onRetry={requests.reload} onChanged={requests.reload} toastOk={toastOk} toastErr={toastErr} />}

      {toast && (
        <div role="status" style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', background: toast.kind === 'error' ? 'hsl(var(--color-red))' : 'hsl(var(--color-green))', color: '#fff', borderRadius: 10, padding: '10px 18px', fontSize: 13, fontWeight: 600, zIndex: 1300, boxShadow: 'var(--shadow-lg)', maxWidth: '90vw' }}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}

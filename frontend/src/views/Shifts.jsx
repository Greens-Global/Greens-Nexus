import { useCallback, useEffect, useRef, useState } from 'react';
import { CalendarClock, CalendarDays, Inbox, Settings2, UserRound } from 'lucide-react';
import { api } from '../api';
import { useRole } from '../contexts/RoleContext';
import MyShifts from '../components/MyShifts';
import ShiftRequestsPage from '../components/ShiftRequestsPage';
import ShiftSchedule from '../components/ShiftSchedule';
import ShiftsPanel from '../components/ShiftsPanel';

// Shifts (Sep 29 2026): its own module in My Desk, below Workforce Analytics
// (Sagar) - it used to be a tab of People > Time.
//
// Everyone's module (Neil, Sep 29): the page opens on My Shifts - the
// signed-in person's week at a glance, then their team's schedule with
// themself pinned first and highlighted (it replaces Workday > Shifts).
//
// The pages sit on one tab strip, the way Teams Shifts has Schedule /
// Requests / Settings (Visesh, Sep 30): My Shifts and Requests for everyone,
// Schedule and Presets & Teams for managers and above. Requests is where a
// swap, an offer or time off is asked for - it used to be reachable only
// from a button under a published shift, so anyone with none never saw it.
// Employees never change a shift - the backend refuses any write below
// manager (routers/timeclock.py require_shift_manage), and the manager pages
// simply do not render for them.

const TABS = [
  ['mine', 'My Shifts', UserRound, false],
  ['schedule', 'Schedule', CalendarDays, true],
  ['requests', 'Requests', Inbox, false],
  ['presets', 'Presets & Teams', Settings2, true],
];
const SUBTITLE = {
  mine: "Your week at a glance, and your team's",
  schedule: "Build, publish and adjust the team's schedule",
  requests: 'Swap or offer a shift, ask for time off, and see what is waiting',
  presets: 'Shift presets, teams and who schedules them',
};

export default function Shifts({ activeSub, onSubChange }) {
  const { can } = useRole();
  const canManage = can('manager');
  const tabs = TABS.filter(([, , , managerOnly]) => canManage || !managerOnly);
  const tab = tabs.some(([k]) => k === activeSub) ? activeSub : 'mine';
  const [people, setPeople] = useState([]);
  const [toast, setToast] = useState(null);
  const timer = useRef(null);

  const needsPeople = tab === 'presets';
  useEffect(() => {
    if (!needsPeople) return undefined;
    let live = true;
    api.getPeopleDirectory().then(rows => { if (live) setPeople(Array.isArray(rows) ? rows : []); }).catch(() => {});
    return () => { live = false; };
  }, [needsPeople]);
  useEffect(() => () => clearTimeout(timer.current), []);

  // Stable, so the schedule never reloads just because a toast showed.
  const show = useCallback((msg, kind) => {
    setToast({ msg, kind });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), kind === 'error' ? 5000 : 4000);
  }, []);
  const toastOk = useCallback(msg => show(msg, 'ok'), [show]);
  const toastErr = useCallback(msg => show(msg, 'error'), [show]);

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
          return (
            <button key={key} type="button" role="tab" aria-selected={on} onClick={() => onSubChange?.(key)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 14px', border: 'none', background: 'none',
                cursor: 'pointer', fontFamily: 'var(--wk-font)', fontSize: 13.5, fontWeight: on ? 700 : 600,
                color: on ? 'var(--wk-brand)' : 'var(--muted)', whiteSpace: 'nowrap', marginBottom: -1,
                borderBottom: on ? '2.5px solid var(--wk-brand)' : '2.5px solid transparent' }}>
              <Icon size={15} /> {label}
            </button>
          );
        })}
      </div>

      {tab === 'mine' ? <MyShifts />
        : tab === 'requests' ? <ShiftRequestsPage canManage={canManage} toastOk={toastOk} toastErr={toastErr} />
          : tab === 'schedule' ? <ShiftSchedule toastOk={toastOk} toastErr={toastErr} />
            : <ShiftsPanel people={people} toastOk={toastOk} toastErr={toastErr} />}

      {toast && (
        <div role="status" style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', background: toast.kind === 'error' ? 'hsl(var(--color-red))' : 'hsl(var(--color-green))', color: '#fff', borderRadius: 10, padding: '10px 18px', fontSize: 13, fontWeight: 600, zIndex: 1300, boxShadow: 'var(--shadow-lg)', maxWidth: '90vw' }}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}

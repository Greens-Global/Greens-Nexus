import { useCallback, useEffect, useRef, useState } from 'react';
import { CalendarClock, CalendarDays, Settings2 } from 'lucide-react';
import { api } from '../api';
import ShiftSchedule from '../components/ShiftSchedule';
import ShiftsPanel from '../components/ShiftsPanel';

// Shifts (Sep 29 2026): its own module in My Desk, below Workforce Analytics
// (Sagar) - it used to be a tab of People > Time. Same two pages as before:
// the schedule grid and the shift presets / groups manager. Access is the
// People audience (App.jsx VIEW_GRANT_ALIAS): Global/IT Admin, or anyone with
// the People (hr) grant - the same people the backend's require_schedule_*
// routes admit.

const TABS = [['schedule', 'Schedule', CalendarDays], ['presets', 'Presets & Groups', Settings2]];

export default function Shifts({ activeSub, onSubChange }) {
  const tab = TABS.some(([k]) => k === activeSub) ? activeSub : 'schedule';
  const [people, setPeople] = useState([]);
  const [toast, setToast] = useState(null);
  const timer = useRef(null);

  useEffect(() => {
    let live = true;
    api.getPeopleDirectory().then(rows => { if (live) setPeople(Array.isArray(rows) ? rows : []); }).catch(() => {});
    return () => { live = false; clearTimeout(timer.current); };
  }, []);

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
      <div className="view-header" style={{ marginBottom: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
          <span style={{ width: 38, height: 38, borderRadius: 10, background: 'var(--wk-brand-tint)', color: 'var(--wk-brand)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <CalendarClock size={19} />
          </span>
          <div className="view-title-group">
            <h2 style={{ fontFamily: 'var(--wk-font)' }}>Shifts</h2>
            <p>Build and share the team's schedule</p>
          </div>
        </div>
      </div>

      <div className="scroll-tabs" role="tablist" style={{ display: 'flex', gap: 2, marginBottom: 18, borderBottom: '1px solid var(--wk-line)' }}>
        {TABS.map(([key, label, Icon]) => {
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

      {tab === 'schedule'
        ? <ShiftSchedule toastOk={toastOk} toastErr={toastErr} />
        : <ShiftsPanel people={people} toastOk={toastOk} toastErr={toastErr} />}

      {toast && (
        <div role="status" style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', background: toast.kind === 'error' ? 'hsl(var(--color-red))' : 'hsl(var(--color-green))', color: '#fff', borderRadius: 10, padding: '10px 18px', fontSize: 13, fontWeight: 600, zIndex: 1300, boxShadow: 'var(--shadow-lg)', maxWidth: '90vw' }}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, CalendarClock, CalendarDays, Settings2 } from 'lucide-react';
import { api } from '../api';
import { useRole } from '../contexts/RoleContext';
import MyShifts from '../components/MyShifts';
import ShiftSchedule from '../components/ShiftSchedule';
import ShiftsPanel from '../components/ShiftsPanel';

// Shifts (Sep 29 2026): its own module in My Desk, below Workforce Analytics
// (Sagar) - it used to be a tab of People > Time.
//
// Everyone's module (Neil, Sep 29): the page opens on My Shifts - the
// signed-in person's week at a glance, then their team's schedule with
// themself pinned first and highlighted (it replaces Workday > Shifts).
// Managers and above also get Manage: the schedule grid and the presets /
// groups manager. Employees never change a shift - the backend refuses any
// write below manager (routers/timeclock.py require_shift_manage), and the
// Manage pages simply do not render for them.

const MANAGE_TABS = [['schedule', 'Schedule', CalendarDays], ['presets', 'Presets & Groups', Settings2]];

export default function Shifts({ activeSub, onSubChange }) {
  const { can } = useRole();
  const canManage = can('manager');
  const managing = canManage && MANAGE_TABS.some(([k]) => k === activeSub);
  const tab = managing ? activeSub : 'mine';
  const [people, setPeople] = useState([]);
  const [toast, setToast] = useState(null);
  const timer = useRef(null);

  useEffect(() => {
    if (!managing) return undefined;
    let live = true;
    api.getPeopleDirectory().then(rows => { if (live) setPeople(Array.isArray(rows) ? rows : []); }).catch(() => {});
    return () => { live = false; };
  }, [managing]);
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
      <div className="view-header" style={{ marginBottom: 18, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0, flex: 1 }}>
          <span style={{ width: 38, height: 38, borderRadius: 10, background: 'var(--wk-brand-tint)', color: 'var(--wk-brand)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <CalendarClock size={19} />
          </span>
          <div className="view-title-group">
            <h2 style={{ fontFamily: 'var(--wk-font)' }}>{managing ? 'Manage Shifts' : 'Shifts'}</h2>
            <p>{managing ? "Build, publish and adjust the team's schedule" : "Your week at a glance, and your team's"}</p>
          </div>
        </div>
        {canManage && (managing ? (
          <button type="button" className="secondary-btn" onClick={() => onSubChange?.('mine')}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <ArrowLeft size={14} /> Back to My Shifts
          </button>
        ) : (
          <button type="button" className="primary-btn" onClick={() => onSubChange?.('schedule')}
            title="Adjust shifts, publish the schedule and manage presets and groups"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Settings2 size={14} /> Manage
          </button>
        ))}
      </div>

      {managing && (
        <div className="scroll-tabs" role="tablist" style={{ display: 'flex', gap: 2, marginBottom: 18, borderBottom: '1px solid var(--wk-line)' }}>
          {MANAGE_TABS.map(([key, label, Icon]) => {
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
      )}

      {!managing ? <MyShifts />
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

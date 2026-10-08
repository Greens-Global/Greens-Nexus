import { useEffect, useState } from 'react';
import { CalendarClock } from 'lucide-react';
import { api } from '../api';
import { formatHHMM } from '../lib/datetime';
import { ErrorBanner, SkeletonBlocks } from './AsyncState';

// Shifts > My Shifts > My Availability (Sep 29 2026, Teams parity): when I
// can work, per day of the week - any time, not at all, or only between two
// times. The schedule grid warns a manager who places a shift outside it; it
// never blocks them. A failed load is an error with Retry - it used to fall
// back to a blank week that Save would then write over the real one.

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const blankWeek = () => DAYS.map((_, weekday) => ({ weekday, kind: 'any', start: '09:00', end: '17:00', note: '' }));
function toWeek(saved) {
  const week = blankWeek();
  (saved || []).forEach((d) => { week[d.weekday] = { ...week[d.weekday], ...d, start: d.start || '09:00', end: d.end || '17:00' }; });
  return week;
}
const dayText = (d) => (d.kind === 'unavailable' ? 'Unavailable' : d.kind === 'available' ? `${formatHHMM(d.start)} - ${formatHHMM(d.end)}` : 'Any Time');

export default function MyAvailability() {
  const [week, setWeek] = useState(null);
  const [error, setError] = useState(null);
  const [tick, setTick] = useState(0);
  const [edit, setEdit] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    let live = true;
    setError(null);
    api.availabilityMine().then((r) => { if (live) setWeek(toWeek(r?.days)); }).catch((e) => { if (live) setError(e?.message || 'Could not load your availability.'); });
    return () => { live = false; };
  }, [tick]);

  const set = (i, patch) => setEdit((e) => e.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  const bad = edit?.find((d) => d.kind === 'available' && (!d.start || !d.end || d.start === d.end));

  async function save() {
    if (bad) return;
    setBusy(true); setMsg('');
    try {
      const r = await api.availabilitySave({ days: edit.map((d) => ({ weekday: d.weekday, kind: d.kind, start: d.start, end: d.end, note: d.note })) });
      setWeek(toWeek(r.days)); setEdit(null); setMsg('Availability saved. Your manager sees it when scheduling.');
    } catch (e) { setMsg(e?.message || 'Could not save your availability.'); }
    setBusy(false);
  }

  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--wk-line2)', borderRadius: 16, padding: '14px 16px', marginTop: 14, boxShadow: 'var(--wk-shadow)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <CalendarClock size={15} color="var(--muted)" />
        <span style={{ fontSize: 14, fontWeight: 800, flex: 1 }}>My Availability</span>
        {!edit && week && <button type="button" className="secondary-btn" onClick={() => { setEdit(week.map((d) => ({ ...d }))); setMsg(''); }} style={{ fontSize: 12 }}>Edit Availability</button>}
      </div>
      {error ? (
        <ErrorBanner message="Your availability could not be loaded right now." onRetry={() => setTick((t) => t + 1)} />
      ) : !week ? (
        <SkeletonBlocks count={1} height={44} borderRadius={10} />
      ) : !edit ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: 8 }}>
          {week.map((d) => (
            <div key={d.weekday} title={d.note || undefined} style={{ fontSize: 12.5 }}>
              <div style={{ fontWeight: 700 }}>{DAYS[d.weekday]}</div>
              <div style={{ color: d.kind === 'unavailable' ? 'hsl(var(--color-red))' : 'var(--muted)' }}>{dayText(d)}</div>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 8 }}>
          {edit.map((d, i) => (
            <div key={d.weekday} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12.5 }}>
              <span style={{ width: 90, fontWeight: 700 }}>{DAYS[d.weekday]}</span>
              <select className="form-input" aria-label={`${DAYS[d.weekday]} availability`} value={d.kind} onChange={(e) => set(i, { kind: e.target.value })}
                style={{ width: 'auto', fontSize: 12.5, padding: '4px 30px 4px 8px' }}>
                <option value="any">Any time</option>
                <option value="available">Available between</option>
                <option value="unavailable">Unavailable</option>
              </select>
              {d.kind === 'available' && (
                <>
                  <input type="time" className="form-input" aria-label={`${DAYS[d.weekday]} from`} value={d.start} onChange={(e) => set(i, { start: e.target.value })} style={{ width: 'auto', fontSize: 12.5, padding: '4px 8px' }} />
                  <span style={{ color: 'var(--muted)' }}>to</span>
                  <input type="time" className="form-input" aria-label={`${DAYS[d.weekday]} to`} value={d.end} onChange={(e) => set(i, { end: e.target.value })} style={{ width: 'auto', fontSize: 12.5, padding: '4px 8px' }} />
                </>
              )}
              {d.kind !== 'any' && (
                <input className="form-input" placeholder="Note (optional)" aria-label={`${DAYS[d.weekday]} note`} value={d.note} onChange={(e) => set(i, { note: e.target.value })}
                  style={{ flex: 1, minWidth: 140, fontSize: 12.5, padding: '4px 8px' }} />
              )}
            </div>
          ))}
          {bad && <div style={{ fontSize: 11.5, color: 'hsl(var(--color-red))' }}>Set different start and end times for {DAYS[bad.weekday]}.</div>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="secondary-btn" onClick={() => setEdit(null)}>Cancel</button>
            <button type="button" className="primary-btn" onClick={save} disabled={busy || !!bad}>{busy ? '…' : 'Save Availability'}</button>
          </div>
        </div>
      )}
      {msg && <div role="status" style={{ fontSize: 12, marginTop: 8, color: 'var(--muted)' }}>{msg}</div>}
    </div>
  );
}

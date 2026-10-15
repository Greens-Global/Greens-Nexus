import { useEffect, useState } from 'react';
import { CalendarClock, Plus, X } from 'lucide-react';
import { api } from '../api';
import { formatHHMM, formatDate, formatWeekday } from '../lib/datetime';
import { ErrorBanner, SkeletonBlocks } from './AsyncState';
import { todayIso } from './shifts/shiftLib';

// Shifts > My Shifts > My Availability (Sep 29 2026, Teams parity): when I
// can work, per day of the week - any time, not at all, or only between two
// times. The schedule grid warns a manager who places a shift outside it; it
// never blocks them. A failed load is an error with Retry - it used to fall
// back to a blank week that Save would then write over the real one.
// Shifts Phase 3b (Oct 15): two more things under the weekly pattern, saved
// with the same Save - Dates (one-off days I am unavailable or only free
// between two times; past dates stay read-only and are kept by the server)
// and Hours (preferred and most hours a week, 0 = no preference - a hint on
// the schedule grid, never a block).

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const blankWeek = () => DAYS.map((_, weekday) => ({ weekday, kind: 'any', start: '09:00', end: '17:00', note: '' }));
function toWeek(saved) {
  const week = blankWeek();
  (saved || []).forEach((d) => { week[d.weekday] = { ...week[d.weekday], ...d, start: d.start || '09:00', end: d.end || '17:00' }; });
  return week;
}
const toDates = (list) => (Array.isArray(list) ? list : [])
  .map((d) => ({ id: d.id || '', date: d.date || '', kind: d.kind === 'available' ? 'available' : 'unavailable', start: d.start || '09:00', end: d.end || '17:00', note: d.note || '' }))
  .sort((a, b) => a.date.localeCompare(b.date));
const toPrefs = (p) => ({ preferredHoursWeek: Number(p?.preferredHoursWeek) || 0, maxHoursWeek: Number(p?.maxHoursWeek) || 0 });
const dayText = (d) => (d.kind === 'unavailable' ? 'Unavailable' : d.kind === 'available' ? `${formatHHMM(d.start)} - ${formatHHMM(d.end)}` : 'Any Time');
const dateText = (d) => (d.kind === 'available' ? `Available ${formatHHMM(d.start)} - ${formatHHMM(d.end)}` : 'Unavailable');
const hoursText = (p) => {
  const bits = [];
  if (p.preferredHoursWeek > 0) bits.push(`Prefers ${p.preferredHoursWeek} hrs a week`);
  if (p.maxHoursWeek > 0) bits.push(`At most ${p.maxHoursWeek} hrs a week`);
  return bits.length ? bits.join(' · ') : 'No preference';
};
const SUB = { fontSize: 12, fontWeight: 700, color: 'var(--ink)', margin: '12px 0 6px' };
const HINT = { fontSize: 11.5, color: 'var(--muted)', marginBottom: 6 };
const INPUT = { width: 'auto', fontSize: 12.5, padding: '4px 8px' };

export default function MyAvailability() {
  const [week, setWeek] = useState(null);
  const [dates, setDates] = useState([]);
  const [prefs, setPrefs] = useState(toPrefs(null));
  const [error, setError] = useState(null);
  const [tick, setTick] = useState(0);
  const [edit, setEdit] = useState(null);           // { days, dates, prefs } while editing
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  // The line between dates that can still change and past ones: the
  // server's today (the company's shift zone, the same one the save keys
  // on), so a browser in another zone never files today's row as past and
  // drops it. The browser's date is only the fallback for an older API.
  const [serverToday, setServerToday] = useState('');
  const today = serverToday || todayIso();

  useEffect(() => {
    let live = true;
    setError(null);
    api.availabilityMine()
      .then((r) => { if (live) { setWeek(toWeek(r?.days)); setDates(toDates(r?.dates)); setPrefs(toPrefs(r?.prefs)); setServerToday(typeof r?.today === 'string' ? r.today : ''); } })
      .catch((e) => { if (live) setError(e?.message || 'Could not load your availability.'); });
    return () => { live = false; };
  }, [tick]);

  const set = (i, patch) => setEdit((e) => ({ ...e, days: e.days.map((d, j) => (j === i ? { ...d, ...patch } : d)) }));
  const setDate = (i, patch) => setEdit((e) => ({ ...e, dates: e.dates.map((d, j) => (j === i ? { ...d, ...patch } : d)) }));
  const addDate = () => setEdit((e) => ({ ...e, dates: [...e.dates, { id: '', date: '', kind: 'unavailable', start: '09:00', end: '17:00', note: '' }] }));
  const removeDate = (i) => setEdit((e) => ({ ...e, dates: e.dates.filter((_, j) => j !== i) }));
  const setPref = (k, v) => setEdit((e) => ({ ...e, prefs: { ...e.prefs, [k]: Math.max(0, Math.min(168, Math.round(Number(v) || 0))) } }));
  const badDay = edit?.days.find((d) => d.kind === 'available' && (!d.start || !d.end || d.start === d.end));
  const badDate = edit?.dates.find((d) => !d.date || d.date < today || (d.kind === 'available' && (!d.start || !d.end || d.start === d.end)));
  const badPrefs = edit && edit.prefs.preferredHoursWeek > 0 && edit.prefs.maxHoursWeek > 0 && edit.prefs.preferredHoursWeek > edit.prefs.maxHoursWeek;
  const bad = !!(badDay || badDate || badPrefs);
  const pastDates = dates.filter((d) => d.date < today);

  function startEdit() {
    setEdit({ days: week.map((d) => ({ ...d })), dates: dates.filter((d) => d.date >= today).map((d) => ({ ...d })), prefs: { ...prefs } });
    setMsg('');
  }
  async function save() {
    if (bad) return;
    setBusy(true); setMsg('');
    try {
      const r = await api.availabilitySave({
        days: edit.days.map((d) => ({ weekday: d.weekday, kind: d.kind, start: d.start, end: d.end, note: d.note })),
        dates: edit.dates.map((d) => ({ ...(d.id ? { id: d.id } : {}), date: d.date, kind: d.kind, start: d.kind === 'available' ? d.start : '', end: d.kind === 'available' ? d.end : '', note: d.note })),
        prefs: { preferredHoursWeek: edit.prefs.preferredHoursWeek, maxHoursWeek: edit.prefs.maxHoursWeek },
      });
      setWeek(toWeek(r?.days));
      setDates(r && 'dates' in r ? toDates(r.dates) : [...pastDates, ...edit.dates]);
      setPrefs(r && 'prefs' in r ? toPrefs(r.prefs) : { ...edit.prefs });
      if (typeof r?.today === 'string') setServerToday(r.today);
      setEdit(null); setMsg('Availability saved. Your manager sees it when scheduling.');
    } catch (e) { setMsg(e?.message || 'Could not save your availability.'); }
    setBusy(false);
  }

  const dateLine = (d, i) => (
    <div key={d.id || `${d.date}-${i}`} title={d.note || undefined} style={{ fontSize: 12.5, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <span style={{ fontWeight: 700 }}>{formatWeekday(d.date, 'short')} {formatDate(d.date)}</span>
      <span style={{ color: d.kind === 'unavailable' ? 'hsl(var(--color-red))' : 'var(--muted)' }}>{dateText(d)}</span>
      {d.note && <span style={{ color: 'var(--muted)' }}>· {d.note}</span>}
    </div>
  );

  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--wk-line2)', borderRadius: 16, padding: '14px 16px', marginTop: 14, boxShadow: 'var(--wk-shadow)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <CalendarClock size={15} color="var(--muted)" />
        <span style={{ fontSize: 14, fontWeight: 800, flex: 1 }}>My Availability</span>
        {!edit && week && <button type="button" className="secondary-btn" onClick={startEdit} style={{ fontSize: 12 }}>Edit Availability</button>}
      </div>
      {error ? (
        <ErrorBanner message="Your availability could not be loaded right now." onRetry={() => setTick((t) => t + 1)} />
      ) : !week ? (
        <SkeletonBlocks count={1} height={44} borderRadius={10} />
      ) : !edit ? (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: 8 }}>
            {week.map((d) => (
              <div key={d.weekday} title={d.note || undefined} style={{ fontSize: 12.5 }}>
                <div style={{ fontWeight: 700 }}>{DAYS[d.weekday]}</div>
                <div style={{ color: d.kind === 'unavailable' ? 'hsl(var(--color-red))' : 'var(--muted)' }}>{dayText(d)}</div>
              </div>
            ))}
          </div>
          <div style={SUB}>Dates</div>
          {dates.length ? (
            <div data-availability-dates style={{ display: 'grid', gap: 4 }}>
              {dates.map((d, i) => dateLine(d, i))}
            </div>
          ) : <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>No dates set. Edit to add a day you cannot work, or can only work part of.</div>}
          <div style={SUB}>Hours</div>
          <div data-availability-hours style={{ fontSize: 12.5, color: 'var(--muted)' }}>{hoursText(prefs)}</div>
        </>
      ) : (
        <div style={{ display: 'grid', gap: 8 }}>
          {edit.days.map((d, i) => (
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
                  <input type="time" className="form-input" aria-label={`${DAYS[d.weekday]} from`} value={d.start} onChange={(e) => set(i, { start: e.target.value })} style={INPUT} />
                  <span style={{ color: 'var(--muted)' }}>to</span>
                  <input type="time" className="form-input" aria-label={`${DAYS[d.weekday]} to`} value={d.end} onChange={(e) => set(i, { end: e.target.value })} style={INPUT} />
                </>
              )}
              {d.kind !== 'any' && (
                <input className="form-input" placeholder="Note (optional)" aria-label={`${DAYS[d.weekday]} note`} value={d.note} onChange={(e) => set(i, { note: e.target.value })}
                  style={{ flex: 1, minWidth: 140, fontSize: 12.5, padding: '4px 8px' }} />
              )}
            </div>
          ))}
          {badDay && <div style={{ fontSize: 11.5, color: 'hsl(var(--color-red))' }}>Set different start and end times for {DAYS[badDay.weekday]}.</div>}

          <div style={SUB}>Dates</div>
          <div style={HINT}>One-off days that differ from the week above: a day you cannot work, or can only work part of.</div>
          {pastDates.length > 0 && (
            <div style={{ display: 'grid', gap: 4, opacity: 0.7 }}>
              {pastDates.map((d, i) => dateLine(d, i))}
            </div>
          )}
          {edit.dates.map((d, i) => (
            <div key={d.id || `new-${i}`} data-date-row style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12.5 }}>
              <input type="date" className="form-input" aria-label={`Date ${i + 1}`} value={d.date} min={today} onChange={(e) => setDate(i, { date: e.target.value })} style={INPUT} />
              <select className="form-input" aria-label={`Date ${i + 1} availability`} value={d.kind} onChange={(e) => setDate(i, { kind: e.target.value })}
                style={{ width: 'auto', fontSize: 12.5, padding: '4px 30px 4px 8px' }}>
                <option value="unavailable">Unavailable</option>
                <option value="available">Available between</option>
              </select>
              {d.kind === 'available' && (
                <>
                  <input type="time" className="form-input" aria-label={`Date ${i + 1} from`} value={d.start} onChange={(e) => setDate(i, { start: e.target.value })} style={INPUT} />
                  <span style={{ color: 'var(--muted)' }}>to</span>
                  <input type="time" className="form-input" aria-label={`Date ${i + 1} to`} value={d.end} onChange={(e) => setDate(i, { end: e.target.value })} style={INPUT} />
                </>
              )}
              <input className="form-input" placeholder="Note (optional)" aria-label={`Date ${i + 1} note`} value={d.note} onChange={(e) => setDate(i, { note: e.target.value })}
                style={{ flex: 1, minWidth: 140, fontSize: 12.5, padding: '4px 8px' }} />
              <button type="button" onClick={() => removeDate(i)} aria-label={`Remove date ${i + 1}`} title="Remove"
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'inline-flex', padding: 2 }}><X size={14} /></button>
            </div>
          ))}
          <button type="button" className="secondary-btn" onClick={addDate} style={{ fontSize: 12, justifySelf: 'start', display: 'inline-flex', alignItems: 'center', gap: 5 }}><Plus size={12} /> Add Date</button>
          {badDate && <div style={{ fontSize: 11.5, color: 'hsl(var(--color-red))' }}>{!badDate.date ? 'Pick a date for every entry.' : badDate.date < today ? 'A date has to be today or later.' : `Set different start and end times for ${formatDate(badDate.date)}.`}</div>}

          <div style={SUB}>Hours</div>
          <div style={HINT}>A guide for whoever builds the schedule. 0 = no preference.</div>
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
            <label style={{ display: 'grid', gap: 4, fontSize: 12.5 }}><span style={{ fontWeight: 700 }}>Preferred Hours Per Week</span>
              <input type="number" min="0" max="168" step="1" className="form-input" aria-label="Preferred hours per week" value={edit.prefs.preferredHoursWeek}
                onChange={(e) => setPref('preferredHoursWeek', e.target.value)} style={{ width: 90, fontSize: 12.5, padding: '4px 8px' }} />
            </label>
            <label style={{ display: 'grid', gap: 4, fontSize: 12.5 }}><span style={{ fontWeight: 700 }}>Most Hours Per Week</span>
              <input type="number" min="0" max="168" step="1" className="form-input" aria-label="Most hours per week" value={edit.prefs.maxHoursWeek}
                onChange={(e) => setPref('maxHoursWeek', e.target.value)} style={{ width: 90, fontSize: 12.5, padding: '4px 8px' }} />
            </label>
          </div>
          {badPrefs && <div style={{ fontSize: 11.5, color: 'hsl(var(--color-red))' }}>Preferred hours cannot be more than your most hours.</div>}

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="secondary-btn" onClick={() => setEdit(null)}>Cancel</button>
            <button type="button" className="primary-btn" onClick={save} disabled={busy || bad}>{busy ? '…' : 'Save Availability'}</button>
          </div>
        </div>
      )}
      {msg && <div role="status" style={{ fontSize: 12, marginTop: 8, color: 'var(--muted)' }}>{msg}</div>}
    </div>
  );
}

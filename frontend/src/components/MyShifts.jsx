import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, CalendarDays, Clock, Info } from 'lucide-react';
import { api } from '../api';
import { SkeletonBlocks } from './AsyncState';

// My Workday > Shifts (Neil, Sep 23): a read-only week of the signed-in
// person's own shifts. Scheduling stays in People > Shifts; this only shows
// what a manager has published there - the shifts placed on them in the
// schedule grid, or, on days with nothing placed, their default shift preset
// on its weekdays. Time off and company holidays overlay the same days, and
// a strip at the top says whether they are on shift right now.

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function dateKey(d) { return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function startOfWeek(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return addDays(x, -x.getDay()); }
function hhmmTo12(hhmm) {
  const [h, m] = (hhmm || '').split(':').map(Number);
  if (Number.isNaN(h)) return hhmm || '';
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${String(m || 0).padStart(2, '0')} ${ampm}`;
}
function minutesOf(hhmm) { const [h, m] = (hhmm || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); }
// A shift covers `now` (minutes since midnight) - overnight shifts wrap.
function covers(s, nowMin) {
  const a = minutesOf(s.start), b = minutesOf(s.end);
  return a <= b ? nowMin >= a && nowMin < b : nowMin >= a || nowMin < b;
}
function fmtRange(a, b) {
  const md = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${md(a)} – ${md(b)}`;
}

export default function MyShifts() {
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [data, setData] = useState(null);
  const [error, setError] = useState(false);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 30000); return () => clearInterval(t); }, []);

  const start = dateKey(weekStart), end = dateKey(addDays(weekStart, 6));
  useEffect(() => {
    let live = true;
    setData(null); setError(false);
    api.timeMySchedule(start, end).then(r => { if (live) setData(r); }).catch(() => { if (live) setError(true); });
    return () => { live = false; };
  }, [start, end]);

  const todayKey = dateKey(now);
  // One entry per day: placed shifts win; otherwise the default preset on
  // its weekdays (ISO Mon=1 … Sun=7); time off and holidays ride alongside.
  const days = useMemo(() => {
    if (!data) return [];
    const placed = {};
    for (const s of data.scheduled || []) (placed[s.date] ||= []).push(s);
    const preset = data.shift;
    const presetDays = new Set((preset?.days || '').split(',').filter(Boolean));
    const off = data.timeoff || [];
    const hol = {};
    for (const h of data.holidays || []) if (h?.date) hol[h.date] = h.name || h.title || h.label || 'Company holiday';
    return Array.from({ length: 7 }, (_, i) => {
      const d = addDays(weekStart, i);
      const key = dateKey(d);
      const iso = String(d.getDay() === 0 ? 7 : d.getDay());
      const shifts = placed[key]
        || (preset && presetDays.has(iso) ? [{ id: `preset-${key}`, start: preset.start, end: preset.end, code: preset.code, label: preset.name, color: preset.color, fromPreset: true }] : []);
      const timeoff = off.filter(t => t.startDate <= key && t.endDate >= key);
      return { date: d, key, shifts, timeoff, holiday: hol[key] || null, isToday: key === todayKey };
    });
  }, [data, weekStart, todayKey]);

  // The strip: on shift now, or when the next one starts.
  const status = useMemo(() => {
    if (!data) return null;
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const today = days.find(d => d.isToday);
    const on = today?.shifts.find(s => covers(s, nowMin));
    if (on) return { on: true, text: `On shift now · ${hhmmTo12(on.start)} – ${hhmmTo12(on.end)}${on.label && !on.fromPreset ? ` · ${on.label}` : on.fromPreset && on.label ? ` · ${on.label}` : ''}` };
    // next shift, this week, after now
    for (const d of days) {
      if (d.key < todayKey) continue;
      for (const s of d.shifts) {
        if (d.key === todayKey && minutesOf(s.start) <= nowMin) continue;
        const when = d.isToday ? 'today' : d.key === dateKey(addDays(now, 1)) ? 'tomorrow' : d.date.toLocaleDateString('en-US', { weekday: 'long' });
        return { on: false, text: `Off shift · next ${when} at ${hhmmTo12(s.start)}` };
      }
    }
    return { on: false, text: 'Off shift · nothing else scheduled this week' };
  }, [data, days, now, todayKey]);

  const thisWeek = start === dateKey(startOfWeek(now));

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
        <div style={{ display: 'inline-flex', alignItems: 'center', border: '1px solid var(--wk-line2)', borderRadius: 10, overflow: 'hidden', background: 'var(--card)' }}>
          <button type="button" onClick={() => setWeekStart(w => addDays(w, -7))} title="Previous Week" aria-label="Previous week"
            style={{ border: 'none', background: 'none', padding: '7px 9px', cursor: 'pointer', color: 'var(--muted)', display: 'flex' }}><ChevronLeft size={16} /></button>
          <button type="button" onClick={() => setWeekStart(startOfWeek(new Date()))} disabled={thisWeek}
            style={{ border: 'none', borderLeft: '1px solid var(--wk-line2)', borderRight: '1px solid var(--wk-line2)', background: 'none', padding: '7px 12px', cursor: thisWeek ? 'default' : 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 700, color: 'var(--ink)' }}>
            {thisWeek ? 'This Week' : fmtRange(weekStart, addDays(weekStart, 6))}
          </button>
          <button type="button" onClick={() => setWeekStart(w => addDays(w, 7))} title="Next Week" aria-label="Next week"
            style={{ border: 'none', background: 'none', padding: '7px 9px', cursor: 'pointer', color: 'var(--muted)', display: 'flex' }}><ChevronRight size={16} /></button>
        </div>
        {thisWeek && <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>{fmtRange(weekStart, addDays(weekStart, 6))}</span>}
        {status && (
          <span style={{
            marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 7, padding: '6px 12px', borderRadius: 999, fontSize: 12.5, fontWeight: 700,
            background: status.on ? 'hsla(var(--color-green),0.12)' : 'var(--mist)', color: status.on ? 'hsl(var(--color-green))' : 'var(--muted)',
          }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: status.on ? 'hsl(var(--color-green))' : 'var(--wk-line)' }} />
            {status.text}
          </span>
        )}
      </div>

      {error ? (
        <div style={{ padding: '28px 16px', textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>Your shifts could not be loaded right now - please try again.</div>
      ) : !data ? (
        <SkeletonBlocks count={7} height={120} gridTemplateColumns="repeat(auto-fill, minmax(150px, 1fr))" />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10 }}>
          {days.map(d => (
            <div key={d.key} style={{
              background: 'var(--card)', border: `1px solid ${d.isToday ? 'var(--wk-brand)' : 'var(--wk-line2)'}`, borderRadius: 14, padding: '12px 13px', minHeight: 118,
              boxShadow: d.isToday ? '0 0 0 3px hsla(var(--color-green),0.12)' : 'var(--wk-shadow)', display: 'flex', flexDirection: 'column', gap: 8,
            }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: d.isToday ? 'var(--wk-brand)' : 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em' }}>{DOW[d.date.getDay()]}</span>
                <span style={{ fontSize: 15, fontWeight: 800, color: 'var(--ink)' }}>{d.date.getDate()}</span>
                {d.isToday && <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--wk-brand)', marginLeft: 'auto' }}>Today</span>}
              </div>
              {d.holiday && (
                <div style={{ fontSize: 12, fontWeight: 600, color: '#b45309', display: 'flex', alignItems: 'center', gap: 6 }}><CalendarDays size={12} /> {d.holiday}</div>
              )}
              {d.timeoff.map((t, i) => (
                <div key={i} style={{ fontSize: 12, fontWeight: 600, textTransform: 'capitalize', color: t.status === 'approved' ? 'hsl(var(--color-green))' : '#b45309', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <CalendarDays size={12} /> {t.type}{t.status === 'pending' ? ' (pending)' : ''}
                </div>
              ))}
              {d.shifts.length === 0 && !d.holiday && d.timeoff.length === 0 && (
                <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 'auto' }}>Off</div>
              )}
              {d.shifts.map(s => (
                <div key={s.id} style={{ borderLeft: `3px solid ${s.color || 'var(--wk-brand)'}`, paddingLeft: 9 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)', display: 'flex', alignItems: 'center', gap: 5 }}>
                    <Clock size={12} style={{ color: s.color || 'var(--wk-brand)', flexShrink: 0 }} />{hhmmTo12(s.start)} – {hhmmTo12(s.end)}
                  </div>
                  {(s.code || s.label) && <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>{s.label || s.code}</div>}
                  {s.note && <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>{s.note}</div>}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 14, fontSize: 12, color: 'var(--muted)' }}>
        <Info size={13} style={{ flexShrink: 0 }} />
        <span>Shifts are set by your manager in People. Only shifts they have shared appear here - ask them if something looks wrong.</span>
      </div>
    </div>
  );
}

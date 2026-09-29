import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, CalendarDays, Clock, Info, Users, StickyNote, Timer, Plane } from 'lucide-react';
import { api } from '../api';
import { formatDate } from '../lib/datetime';
import { SkeletonBlocks } from './AsyncState';
import { ShiftActions, RequestDialog, OpenShifts, ShiftRequestsList } from './ShiftSelfService';
import { useShiftRequests } from './useShiftRequests';
import MyAvailability from './MyAvailability';

// Shifts > My Shifts (was My Workday > Shifts until Sep 29, when it moved into
// the Shifts module for everyone; the module's Manage button, managers and
// above only, is where scheduling happens). A read-only week of the signed-in
// person's own shifts. Scheduling stays in People > Shifts; this only shows
// what a manager has published there - the shifts placed on them in the
// schedule grid, or, on days with nothing placed, their default shift preset
// on its weekdays. Time off and company holidays overlay the same days, and
// a strip at the top says whether they are on shift right now.
//
// Below their own week, their team (Neil, Sep 23: "Shifts should show all
// team shifts based on what team you are on as well as your own"): one
// week grid per shift group the manager put them in (People > Shifts >
// Groups - the same grouping bulk assignment and the BOD/EOD chat key on),
// every member a row, the person themself first. A teammate's day is built
// the same way as their own - placed published shifts, else the default
// preset on its weekdays - and approved time off shows as "Off" without
// the reason. Nobody is asked to define a team anywhere new.

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function dateKey(d) { return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
// Monday-Sunday, the same week the schedule grid shows.
function startOfWeek(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return addDays(x, -((x.getDay() + 6) % 7)); }
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
  return `${formatDate(dateKey(a))} - ${formatDate(dateKey(b))}`;
}
// "9a-5:30p": the team grid has seven columns to fit, so the times shrink.
function compact12(hhmm) {
  const [h, m] = (hhmm || '').split(':').map(Number);
  if (Number.isNaN(h)) return hhmm || '';
  const ampm = h >= 12 ? 'p' : 'a';
  const h12 = h % 12 || 12;
  return m ? `${h12}:${String(m).padStart(2, '0')}${ampm}` : `${h12}${ampm}`;
}
// A member's shifts for one day: placed published shifts win, else their
// default preset on its weekdays - the same rule the person's own cards use.
function dayShiftsFor(member, key, iso) {
  const placed = (member.scheduled || []).filter(s => s.date === key);
  if (placed.length) return placed;
  const preset = member.shift;
  if (preset && (preset.days || '').split(',').includes(iso)) {
    return [{ id: `preset-${member.email}-${key}`, start: preset.start, end: preset.end, breakMin: preset.breakMin, code: preset.code, label: preset.name, color: preset.color, fromPreset: true }];
  }
  return [];
}
// Paid minutes of a shift: its span (overnight wraps) minus its unpaid break.
function paidMin(s) {
  let d = minutesOf(s.end) - minutesOf(s.start);
  if (d < 0) d += 1440;
  return Math.max(0, d - (Number(s.breakMin) || 0));
}
function fmtHrs(min) {
  const h = min / 60;
  return `${Number.isInteger(h) ? h : h.toFixed(1)} hrs`;
}
function firstName(name, email) {
  const n = (name || '').trim();
  return n ? n.split(/\s+/)[0] : (email || '').split('@')[0];
}

export default function MyShifts() {
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [data, setData] = useState(null);
  const [error, setError] = useState(false);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 30000); return () => clearInterval(t); }, []);
  const [teamId, setTeamId] = useState(''); // which group's grid shows, when in more than one

  const start = dateKey(weekStart), end = dateKey(addDays(weekStart, 6));
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let live = true;
    setData(null); setError(false);
    api.timeMySchedule(start, end).then(r => { if (live) setData(r); }).catch(() => { if (live) setError(true); });
    return () => { live = false; };
  }, [start, end, reload]);
  // Self-service (Sep 29): my requests, what waits on me, open shifts I could take.
  const [reqs, reloadReqs] = useShiftRequests(start, end);
  const [ask, setAsk] = useState(null);          // { kind, shift } while the swap/offer form is open
  const [flash, setFlash] = useState('');
  const done = (msg) => { setAsk(null); setFlash(msg); reloadReqs(); setReload(n => n + 1); };

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
    // Day notes from the manager (Sep 29), e.g. "Inventory day".
    const dayNote = {};
    for (const n of data.dayNotes || []) dayNote[n.date] = dayNote[n.date] ? `${dayNote[n.date]} · ${n.note}` : n.note;
    return Array.from({ length: 7 }, (_, i) => {
      const d = addDays(weekStart, i);
      const key = dateKey(d);
      const iso = String(d.getDay() === 0 ? 7 : d.getDay());
      const shifts = placed[key]
        || (preset && presetDays.has(iso) ? [{ id: `preset-${key}`, start: preset.start, end: preset.end, breakMin: preset.breakMin, code: preset.code, label: preset.name, color: preset.color, fromPreset: true }] : []);
      const timeoff = off.filter(t => t.startDate <= key && t.endDate >= key);
      return { date: d, key, shifts, timeoff, holiday: hol[key] || null, note: dayNote[key] || '', isToday: key === todayKey };
    });
  }, [data, weekStart, todayKey]);

  // The strip: on shift now, or when the next one starts.
  const status = useMemo(() => {
    if (!data) return null;
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const today = days.find(d => d.isToday);
    const on = today?.shifts.find(s => covers(s, nowMin));
    if (on) return { on: true, text: `On shift now · ${hhmmTo12(on.start)} - ${hhmmTo12(on.end)}${on.label && !on.fromPreset ? ` · ${on.label}` : on.fromPreset && on.label ? ` · ${on.label}` : ''}` };
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

  // The at-a-glance strip: the next shift, the week's paid hours, time off.
  const glance = useMemo(() => {
    if (!data) return null;
    const nowMin = now.getHours() * 60 + now.getMinutes();
    let next = null;
    for (const d of days) {
      if (d.key < todayKey) continue;
      const s = d.shifts.find(x => d.key > todayKey || minutesOf(x.end) > nowMin || minutesOf(x.end) < minutesOf(x.start));
      if (s && !d.timeoff.some(t => t.status === 'approved')) { next = { d, s }; break; }
    }
    const worked = days.filter(d => d.shifts.length && !d.timeoff.some(t => t.status === 'approved'));
    const mins = worked.reduce((m, d) => m + d.shifts.reduce((a, s) => a + paidMin(s), 0), 0);
    const offDays = days.filter(d => d.timeoff.length).length;
    const pending = days.some(d => d.timeoff.some(t => t.status === 'pending'));
    return { next, mins, shiftCount: worked.reduce((n, d) => n + d.shifts.length, 0), offDays, pending };
  }, [data, days, now, todayKey]);

  // The team grid: the chosen group (or the only one), each member's seven
  // days, plus who is on shift at this moment for the summary line.
  const teams = data?.teams || [];
  const team = teams.find(t => t.id === teamId) || teams[0] || null;
  const teamRows = useMemo(() => {
    if (!team) return [];
    return team.members.map(m => ({
      ...m,
      days: days.map(d => {
        const iso = String(d.date.getDay() === 0 ? 7 : d.date.getDay());
        return {
          key: d.key, isToday: d.isToday,
          shifts: dayShiftsFor(m, d.key, iso),
          off: (m.timeoff || []).some(t => t.startDate <= d.key && t.endDate >= d.key),
        };
      }),
    }));
  }, [team, days]);
  const onNow = useMemo(() => {
    if (!team || !thisWeek) return [];
    const nowMin = now.getHours() * 60 + now.getMinutes();
    return teamRows.filter(r => {
      const today = r.days.find(d => d.isToday);
      return today && !today.off && today.shifts.some(s => covers(s, nowMin));
    });
  }, [team, teamRows, now, thisWeek]);

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
      </div>

      {/* At a glance (Sep 29): what anyone opening Shifts wants first -
          when they work next, how much this week, and any time off. */}
      {glance && !error && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 10, marginBottom: 12 }}>
          <GlanceTile icon={Clock} label={status?.on ? 'On Shift Now' : 'Next Shift'} tone={status?.on ? 'green' : 'brand'}
            value={glance.next
              ? `${glance.next.d.isToday ? 'Today' : glance.next.d.key === dateKey(addDays(now, 1)) ? 'Tomorrow' : `${DOW[glance.next.d.date.getDay()]} ${glance.next.d.date.getMonth() + 1}/${glance.next.d.date.getDate()}`}`
              : 'None this week'}
            sub={glance.next ? `${hhmmTo12(glance.next.s.start)} - ${hhmmTo12(glance.next.s.end)}${glance.next.s.label ? ` · ${glance.next.s.label}` : ''}` : 'Nothing else scheduled'} />
          <GlanceTile icon={Timer} label={thisWeek ? 'This Week' : 'That Week'} tone="brand"
            value={fmtHrs(glance.mins)}
            sub={`${glance.shiftCount} shift${glance.shiftCount === 1 ? '' : 's'} · paid time, breaks excluded`} />
          <GlanceTile icon={Plane} label="Time Off" tone={glance.offDays ? 'amber' : 'muted'}
            value={glance.offDays ? `${glance.offDays} day${glance.offDays === 1 ? '' : 's'}` : 'None'}
            sub={glance.pending ? 'Includes a pending request' : glance.offDays ? 'Approved' : 'This week'} />
        </div>
      )}

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
              {d.note && (
                <div style={{ fontSize: 12, fontWeight: 600, color: '#b45309', display: 'flex', alignItems: 'flex-start', gap: 6 }}><StickyNote size={12} style={{ flexShrink: 0, marginTop: 2 }} /> {d.note}</div>
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
                    <Clock size={12} style={{ color: s.color || 'var(--wk-brand)', flexShrink: 0 }} />{hhmmTo12(s.start)} - {hhmmTo12(s.end)}
                  </div>
                  {(s.code || s.label) && <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>{s.label || s.code}</div>}
                  {s.note && <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>{s.note}</div>}
                  {(s.activities || []).map((a, i) => (
                    <div key={i} style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>{hhmmTo12(a.start)} - {hhmmTo12(a.end)} · {a.label}</div>
                  ))}
                  <ShiftActions shift={{ ...s, date: s.date || d.key }} todayKey={todayKey} reqs={reqs} onAsk={setAsk} />
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {flash && (
        <div role="status" style={{ marginTop: 12, fontSize: 12.5, fontWeight: 600, color: 'hsl(var(--color-green))' }}>{flash}</div>
      )}
      <ShiftRequestsList reqs={reqs} onDone={done} />
      <OpenShifts reqs={reqs} onDone={done} />
      {ask && (
        <RequestDialog ask={ask} teammates={reqs?.teammates || []} todayKey={todayKey} onClose={() => setAsk(null)} onDone={done}
          teamShifts={reqs?.swapShifts || {}} />
      )}

      {data && team && (
        <div style={{ marginTop: 22 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap', marginBottom: 10 }}>
            <span className="wkc-chip"><Users size={14} /></span>
            <span style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--ink)' }}>Team Shifts</span>
            {teams.length > 1 ? (
              <select className="form-select" value={team.id} onChange={e => setTeamId(e.target.value)} aria-label="Team" style={{ width: 'auto', fontSize: 12.5, padding: '4px 28px 4px 10px' }}>
                {teams.map(t => <option key={t.id} value={t.id}>{t.name} ({t.members.length}){t.isMember === false ? ' - you manage' : ''}</option>)}
              </select>
            ) : (
              <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>{team.name} · {team.members.length} member{team.members.length === 1 ? '' : 's'}{team.isMember === false ? ' · you manage this team' : ''}</span>
            )}
            {thisWeek && (
              <span style={{ marginLeft: 'auto', fontSize: 12.5, color: 'var(--muted)' }}>
                {onNow.length === 0
                  ? 'Nobody on shift right now'
                  : `On shift now: ${onNow.map(r => r.isMe ? 'you' : firstName(r.name, r.email)).join(', ')}`}
              </span>
            )}
          </div>
          <div className="scroll-tabs" style={{ border: '1px solid var(--wk-line2)', borderRadius: 14, background: 'var(--card)', boxShadow: 'var(--wk-shadow)' }}>
            <table style={{ width: '100%', minWidth: 640, borderCollapse: 'separate', borderSpacing: 0, fontSize: 12.5 }}>
              <thead>
                <tr>
                  <th style={{ position: 'sticky', left: 0, zIndex: 1, background: 'var(--card)', textAlign: 'left', padding: '10px 12px', fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em', borderBottom: '1px solid var(--wk-line2)', minWidth: 150 }}>Member</th>
                  {days.map(d => (
                    <th key={d.key} style={{ padding: '10px 8px', textAlign: 'left', borderBottom: '1px solid var(--wk-line2)', background: d.isToday ? 'var(--wk-brand-tint)' : 'var(--card)', minWidth: 84 }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: d.isToday ? 'var(--wk-brand)' : 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em' }}>{DOW[d.date.getDay()]}</span>
                      <span style={{ fontSize: 12.5, fontWeight: 800, color: 'var(--ink)', marginLeft: 5 }}>{d.date.getDate()}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {teamRows.map(r => {
                  // You, pinned first (the API sorts you to the top) and
                  // marked so you find yourself at a glance (Neil, Sep 29):
                  // the whole row tinted, an accent bar, your name in the
                  // brand color and a filled "You" badge, then a firmer
                  // rule before your teammates.
                  const me = r.isMe;
                  const onNowRow = onNow.some(o => o.email === r.email);
                  const rowBg = me ? 'var(--wk-brand-tint)' : 'transparent';
                  const rule = me ? '2px solid var(--wk-line2)' : '1px solid var(--line)';
                  return (
                    <tr key={r.email} aria-current={me ? 'true' : undefined}>
                      <td style={{ position: 'sticky', left: 0, zIndex: 1, background: me ? 'var(--wk-brand-tint)' : 'var(--card)', padding: '9px 12px', borderBottom: rule, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 200,
                        boxShadow: me ? 'inset 3px 0 0 var(--wk-brand)' : 'none' }}>
                        {onNowRow && <span title="On shift now" style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: 'hsl(var(--color-green))', marginRight: 7, verticalAlign: 'middle' }} />}
                        <span style={{ fontWeight: me ? 800 : 600, color: me ? 'var(--wk-brand)' : 'var(--ink)' }}>{r.name || r.email}</span>
                        {me && <span style={{ fontSize: 10, fontWeight: 800, color: '#fff', background: 'var(--wk-brand)', borderRadius: 999, padding: '1px 7px', marginLeft: 7, letterSpacing: '.03em', verticalAlign: 'middle' }}>YOU</span>}
                      </td>
                      {r.days.map(d => (
                        <td key={d.key} style={{ padding: '8px 8px', borderBottom: rule, verticalAlign: 'top', background: me ? rowBg : (d.isToday ? 'hsla(var(--color-green),0.05)' : 'transparent'),
                          boxShadow: me && d.isToday ? 'inset 0 0 0 999px hsla(var(--color-green),0.06)' : 'none' }}>
                          {d.off ? (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 600, color: '#b45309' }}><CalendarDays size={11} /> Time off</span>
                          ) : d.shifts.length === 0 ? (
                            <span style={{ fontSize: 12, color: 'var(--muted)' }}>Off</span>
                          ) : d.shifts.map(sh => (
                            <div key={sh.id} title={`${hhmmTo12(sh.start)} - ${hhmmTo12(sh.end)}${sh.label ? ` · ${sh.label}` : ''}`}
                              style={{ borderLeft: `3px solid ${sh.color || 'var(--wk-brand)'}`, paddingLeft: 7, marginBottom: 4, lineHeight: 1.3 }}>
                              <div style={{ fontWeight: 700, color: 'var(--ink)', whiteSpace: 'nowrap' }}>{compact12(sh.start)}-{compact12(sh.end)}</div>
                              {(sh.code || sh.label) && <div style={{ fontSize: 11, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 110 }}>{sh.code || sh.label}</div>}
                            </div>
                          ))}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <MyAvailability />

      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 14, fontSize: 12, color: 'var(--muted)' }}>
        <Info size={13} style={{ flexShrink: 0 }} />
        <span>
          Shifts are set by your manager. Only shifts they have published appear here - ask them if something looks wrong.
          {data && teams.length === 0 && ' Your team will show here once your manager adds you to a group.'}
        </span>
      </div>
    </div>
  );
}

const GLANCE_TONE = {
  brand: { fg: 'var(--wk-brand)', bg: 'var(--wk-brand-tint)' },
  green: { fg: 'hsl(var(--color-green))', bg: 'hsla(var(--color-green),0.12)' },
  amber: { fg: '#b45309', bg: 'rgba(180,83,9,0.1)' },
  muted: { fg: 'var(--muted)', bg: 'var(--mist)' },
};

function GlanceTile({ icon: Icon, label, value, sub, tone = 'brand' }) {
  const t = GLANCE_TONE[tone] || GLANCE_TONE.brand;
  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--wk-line2)', borderRadius: 14, padding: '12px 14px', boxShadow: 'var(--wk-shadow)', display: 'flex', gap: 11, alignItems: 'center', minWidth: 0 }}>
      <span style={{ width: 34, height: 34, borderRadius: 10, background: t.bg, color: t.fg, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <Icon size={17} />
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em' }}>{label}</div>
        <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--ink)', lineHeight: 1.25 }}>{value}</div>
        <div style={{ fontSize: 11.5, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sub}</div>
      </div>
    </div>
  );
}

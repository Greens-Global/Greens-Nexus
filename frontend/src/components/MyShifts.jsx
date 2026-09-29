import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, CalendarDays, Clock, Info, StickyNote, Timer, Plane } from 'lucide-react';
import { api } from '../api';
import { formatDate, zoneClock } from '../lib/datetime';
import { zoneOptionLabel } from '../lib/worldClockZones';
import { SkeletonBlocks } from './AsyncState';
import { shiftPhase } from './shiftScheduleLib';
import TeamShiftGrid from './TeamShiftGrid';
import { ShiftActions, RequestDialog, OpenShifts, ShiftRequestsList } from './ShiftSelfService';
import { useShiftRequests } from './useShiftRequests';
import MyAvailability from './MyAvailability';

// Shifts > My Shifts (was My Workday > Shifts until Sep 29, when it moved into
// the Shifts module for everyone; the module's Manage button, managers and
// above only, is where scheduling happens). A read-only week of the signed-in
// person's own shifts: the shifts a manager placed on them in the schedule
// grid and published. Time off and company holidays overlay the same days,
// and a tile at the top says whether they are on shift right now.
//
// A day with nothing published shows the person's default preset as their
// "Usual hours" - a reminder, NOT a shift. It used to stand in as one: it
// counted toward the week's hours and "next shift" while the manager's grid
// showed that day empty, so the two screens disagreed (Sep 29 audit). Only
// published shifts count now, here and on the grid.
//
// Below their own week, their team (Neil, Sep 23: "Shifts should show all
// team shifts based on what team you are on as well as your own"): one
// week grid per shift group the manager put them in (Shifts > Manage >
// Presets & Groups - the same grouping bulk assignment and the BOD/EOD chat
// key on), every member a row, the person themself first, laid out like the
// Teams Shifts schedule (TeamShiftGrid.jsx - photos, colored shift blocks,
// open shifts, day notes). What a teammate's row carries - why they are off,
// a shift's note, activities and break - is the shift settings' call (Teams
// "Visibility"); the API sends only what this person may see.

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
function fmtRange(a, b) {
  return `${formatDate(dateKey(a))} - ${formatDate(dateKey(b))}`;
}
// A default preset's hours on one of its weekdays (ISO Mon=1 ... Sun=7), or
// null. Shown as "Usual hours" on a day with nothing published.
function usualOn(preset, iso) {
  return preset && (preset.days || '').split(',').includes(iso)
    ? { start: preset.start, end: preset.end, label: preset.name } : null;
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
  // Asking for an open shift straight from the team grid's Open Shifts row.
  const [busyOpen, setBusyOpen] = useState('');
  async function requestOpen(s) {
    setBusyOpen(s.id);
    try { await api.shiftRequestCreate({ kind: 'open', shift_id: s.id }); done('Request sent. A manager will approve it.'); }
    catch (e) { setFlash(e?.message || 'Could not send the request.'); }
    setBusyOpen('');
  }

  const todayKey = dateKey(now);
  // One entry per day: the published shifts placed on it, the usual hours
  // when there are none, and the time off and holidays that ride alongside.
  const days = useMemo(() => {
    if (!data) return [];
    const placed = {};
    for (const s of data.scheduled || []) (placed[s.date] ||= []).push(s);
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
      const shifts = placed[key] || [];
      const timeoff = off.filter(t => t.startDate <= key && t.endDate >= key);
      return { date: d, key, shifts, usual: shifts.length ? null : usualOn(data.shift, iso), timeoff,
        holiday: hol[key] || null, note: dayNote[key] || '', isToday: key === todayKey };
    });
  }, [data, weekStart, todayKey]);

  const thisWeek = start === dateKey(startOfWeek(now));

  // The clock in a shift's own zone: its preset's, else the team's.
  const clockOf = useMemo(() => {
    const seen = {};
    return (s) => (seen[s.timezone || ''] ||= zoneClock(s.timezone || data?.timeZone, now));
  }, [data, now]);

  // The at-a-glance strip: the shift they are on (or the next one), the
  // week's paid hours, and time off. Published shifts only.
  const glance = useMemo(() => {
    if (!data) return null;
    let on = null, next = null;
    for (const d of days) {
      if (d.timeoff.some(t => t.status === 'approved')) continue;
      for (const s of d.shifts) {
        const phase = shiftPhase(s, d.key, clockOf(s));
        if (phase === 'on' && !on) on = { d, s };
        else if (phase === 'ahead' && !next) next = { d, s };
      }
    }
    const worked = days.filter(d => d.shifts.length && !d.timeoff.some(t => t.status === 'approved'));
    const mins = worked.reduce((m, d) => m + d.shifts.reduce((a, s) => a + paidMin(s), 0), 0);
    const offDays = days.filter(d => d.timeoff.length).length;
    const pending = days.some(d => d.timeoff.some(t => t.status === 'pending'));
    return { on, shown: on || next, mins, shiftCount: worked.reduce((n, d) => n + d.shifts.length, 0), offDays, pending };
  }, [data, days, clockOf]);

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
        const shifts = (m.scheduled || []).filter(s => s.date === d.key);
        return {
          key: d.key, isToday: d.isToday, shifts,
          usual: shifts.length ? null : usualOn(m.shift, iso),
          off: (m.timeoff || []).find(t => t.startDate <= d.key && t.endDate >= d.key) || null,
        };
      }),
    }));
  }, [team, days]);
  const onNow = useMemo(() => {
    if (!team || !thisWeek) return [];
    return teamRows.filter(r => r.days.some(d => !d.off && d.shifts.some(s => shiftPhase(s, d.key, clockOf(s)) === 'on')));
  }, [team, teamRows, clockOf, thisWeek]);
  // "All times are shown in ..." - said only when it is true: every shift on
  // the grid runs on one zone (each preset keeps its own).
  const gridZone = useMemo(() => {
    const zones = new Set(teamRows.flatMap(r => r.days.flatMap(d => d.shifts.map(s => s.timezone || data?.timeZone || ''))));
    zones.delete('');
    return zones.size === 1 ? zoneOptionLabel([...zones][0]) : '';
  }, [teamRows, data]);
  const openList = reqs?.settings?.openShifts ? reqs.openShifts || [] : [];

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
          <GlanceTile icon={Clock} label={glance.on ? 'On Shift Now' : 'Next Shift'} tone={glance.on ? 'green' : 'brand'}
            value={glance.shown
              ? `${glance.shown.d.isToday ? 'Today' : glance.shown.d.key === dateKey(addDays(now, 1)) ? 'Tomorrow' : `${DOW[glance.shown.d.date.getDay()]} ${glance.shown.d.date.getMonth() + 1}/${glance.shown.d.date.getDate()}`}`
              : 'None this week'}
            sub={glance.shown ? `${hhmmTo12(glance.shown.s.start)} - ${hhmmTo12(glance.shown.s.end)}${glance.shown.s.label ? ` · ${glance.shown.s.label}` : ''}` : 'Nothing else published'} />
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
                <div key={i}>
                  <div style={{ fontSize: 12, fontWeight: 600, textTransform: 'capitalize', color: t.status === 'approved' ? 'hsl(var(--color-green))' : '#b45309', display: 'flex', alignItems: 'center', gap: 6 }}>
                    <CalendarDays size={12} /> {t.type}{t.status === 'pending' ? ' (pending)' : ''}
                  </div>
                  {t.note && <div title={t.note} style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Reason: {t.note}</div>}
                </div>
              ))}
              {d.shifts.length === 0 && !d.holiday && d.timeoff.length === 0 && (d.usual ? (
                <div title="Your regular hours. No shift is published for this day yet."
                  style={{ marginTop: 'auto', borderLeft: '3px dotted var(--wk-line2)', paddingLeft: 9 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)' }}>Usual hours</div>
                  <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{hhmmTo12(d.usual.start)} - {hhmmTo12(d.usual.end)}</div>
                </div>
              ) : (
                <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 'auto' }}>Off</div>
              ))}
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
      {!team && <OpenShifts reqs={reqs} onDone={done} />}
      {ask && (
        <RequestDialog ask={ask} teammates={reqs?.teammates || []} todayKey={todayKey} onClose={() => setAsk(null)} onDone={done}
          teamShifts={reqs?.swapShifts || {}} />
      )}

      {data && team && (
        <TeamShiftGrid teams={teams} team={team} onPickTeam={setTeamId} days={days} rows={teamRows} onNow={onNow}
          openShifts={openList} onRequestOpen={requestOpen} busyOpenId={busyOpen} thisWeek={thisWeek} timeZoneLabel={gridZone} />
      )}

      <MyAvailability />

      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 14, fontSize: 12, color: 'var(--muted)' }}>
        <Info size={13} style={{ flexShrink: 0 }} />
        <span>
          Shifts are set by your manager. Only shifts they have published appear here - ask them if something looks wrong.
          {data?.shift && ' Usual hours are your regular schedule, shown on days with no published shift.'}
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

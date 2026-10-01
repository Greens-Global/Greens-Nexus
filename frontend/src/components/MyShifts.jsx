import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, CalendarDays, Clock, Info, StickyNote, Timer, Plane, ArrowLeftRight } from 'lucide-react';
import { api } from '../api';
import { formatDate, zoneClock, formatHHMM } from '../lib/datetime';
import { zoneOptionLabel } from '../lib/worldClockZones';
import { useNameResolver } from '../lib/useNameResolver';
import { ErrorBanner, SkeletonBlocks } from './AsyncState';
import { shiftPhase } from './shiftScheduleLib';
import TeamShiftGrid from './TeamShiftGrid';
import ShiftRequestDialog, { PENDING } from './shifts/ShiftRequestDialog';
import { ShiftBlock, TimeOffBlock } from './shifts/ShiftBlock';
import { isoDate, weekStartOf, paidMinutes, fmtHrs, dayFullyOff, todayIso, dayHeading } from './shifts/shiftLib';
import { useShiftRequests } from './useShiftRequests';
import MyAvailability from './MyAvailability';

// Shifts > My Shifts (Sep 29; rebuilt Oct 2026). A read-only week of the
// signed-in person's own SHARED shifts, with time off and holidays beside
// them, a tile strip that says whether they are on shift right now, then
// their group's week (TeamShiftGrid) and their availability. A day with
// nothing shared shows the usual hours of their shift type as a reminder
// (never a shift, never counted) - and nothing at all otherwise (it used to
// say "Off", which reads as time off). Asking for a swap, an offer or an
// open shift lives in Workday > Time Off; the "Request" link under a shift
// here opens that same dialog with the shift filled in.

const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

export default function MyShifts() {
  const nameOf = useNameResolver();
  const [weekStart, setWeekStartPref] = useState('monday');
  const [cursor, setCursor] = useState(() => new Date());
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 30000); return () => clearInterval(t); }, []);
  const [teamId, setTeamId] = useState('');
  const first = useMemo(() => weekStartOf(cursor, weekStart), [cursor, weekStart]);
  const start = isoDate(first), end = isoDate(addDays(first, 6));
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let live = true;
    setData(null); setError(null);
    api.timeMySchedule(start, end).then((r) => {
      if (!live) return;
      setData(r);
      if (r?.weekStart === 'sunday' || r?.weekStart === 'monday') setWeekStartPref(r.weekStart);
    }).catch((e) => { if (live) setError(e?.message || 'Your shifts could not be loaded.'); });
    return () => { live = false; };
  }, [start, end, reload]);
  const [reqs, reloadReqs] = useShiftRequests(start, end);
  const [ask, setAsk] = useState(null);          // { shift } while the request dialog is open
  const [flash, setFlash] = useState('');
  const done = (msg) => { setAsk(null); setFlash(msg); reloadReqs(); setReload((n) => n + 1); };
  const [busyOpen, setBusyOpen] = useState('');
  async function requestOpen(s) {
    setBusyOpen(s.id);
    try { await api.shiftRequestCreate({ kind: 'open', shift_id: s.id }); done('Request sent. A manager will approve it.'); }
    catch (e) { setFlash(e?.message || 'Could not send the request.'); }
    setBusyOpen('');
  }

  const todayKey = todayIso();
  const days = useMemo(() => {
    if (!data) return [];
    const placed = {};
    for (const s of data.scheduled || []) (placed[s.date] ||= []).push(s);
    const off = data.timeoff || [];
    const hol = {};
    const holList = Array.isArray(data.holidays) ? data.holidays
      : Object.entries(data.holidays || {}).map(([date, h]) => ({ date, ...(h && typeof h === 'object' ? h : { name: String(h || '') }) }));
    for (const h of holList) if (h?.date) hol[h.date] = h.name || h.title || h.label || 'Company holiday';
    const dayNote = {};
    for (const n of (Array.isArray(data.dayNotes) ? data.dayNotes : [])) dayNote[n.date] = dayNote[n.date] ? `${dayNote[n.date]} · ${n.note}` : n.note;
    return Array.from({ length: 7 }, (_, i) => {
      const d = addDays(first, i);
      const key = isoDate(d);
      const iso = String(d.getDay() === 0 ? 7 : d.getDay());
      const shifts = placed[key] || [];
      const p = data.shift;
      const usual = !shifts.length && p && (p.days || '').split(',').includes(iso) ? { start: p.start, end: p.end } : null;
      return { date: d, key, shifts, usual, timeoff: off.filter((t) => t.startDate <= key && t.endDate >= key), holiday: hol[key] || null, note: dayNote[key] || '', isToday: key === todayKey };
    });
  }, [data, first, todayKey]);
  const thisWeek = start === isoDate(weekStartOf(now, weekStart));
  const clockOf = useMemo(() => {
    const seen = {};
    return (s) => (seen[s.timeZone || s.timezone || ''] ||= zoneClock(s.timeZone || s.timezone || data?.timeZone, now));
  }, [data, now]);

  // At a glance: the shift they are on (or the next one), the week's paid
  // hours, and time off. A whole approved day off takes its shifts out.
  const glance = useMemo(() => {
    if (!data) return null;
    let on = null, next = null;
    for (const d of days) {
      if (dayFullyOff(d.timeoff)) continue;
      for (const s of d.shifts) {
        const phase = shiftPhase(s, d.key, clockOf(s));
        if (phase === 'on' && !on) on = { d, s };
        else if (phase === 'ahead' && !next) next = { d, s };
      }
    }
    const worked = days.filter((d) => d.shifts.length && !dayFullyOff(d.timeoff));
    const mins = worked.reduce((m, d) => m + d.shifts.reduce((a, s) => a + paidMinutes(s), 0), 0);
    const offDays = days.filter((d) => d.timeoff.length).length;
    const pending = days.some((d) => d.timeoff.some((t) => t.status === 'pending'));
    return { on, shown: on || next, mins, shiftCount: worked.reduce((n, d) => n + d.shifts.length, 0), offDays, pending };
  }, [data, days, clockOf]);

  const teams = data?.teams || [];
  const team = teams.find((t) => t.id === teamId) || teams[0] || null;
  const teamRows = useMemo(() => {
    if (!team) return [];
    return team.members.map((m) => ({
      ...m, name: nameOf(m.email, m.name),
      days: days.map((d) => {
        const iso = String(d.date.getDay() === 0 ? 7 : d.date.getDay());
        const shifts = (m.scheduled || []).filter((s) => s.date === d.key);
        const p = m.shift;
        return { key: d.key, isToday: d.isToday, shifts, usual: !shifts.length && p && (p.days || '').split(',').includes(iso) ? { start: p.start, end: p.end } : null,
          off: (m.timeoff || []).filter((t) => t.startDate <= d.key && t.endDate >= d.key) };
      }),
    }));
  }, [team, days, nameOf]);
  const onNow = useMemo(() => {
    if (!team || !thisWeek) return [];
    return teamRows.filter((r) => r.days.some((d) => !dayFullyOff(d.off) && d.shifts.some((s) => shiftPhase(s, d.key, clockOf(s)) === 'on')));
  }, [team, teamRows, clockOf, thisWeek]);
  const teamZone = data?.timeZone || '';
  const cfg = reqs?.settings || {};
  const canAsk = (reqs?.teammates || []).length > 0 && (cfg.swaps !== false || cfg.offers !== false);
  const pendingIds = new Set((reqs?.mine || []).filter((r) => PENDING.includes(r.status)).map((r) => r.shift?.id));
  const openList = cfg.openShifts ? reqs?.openShifts || [] : [];
  const rangeText = `${formatDate(start)} - ${formatDate(end)}`;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
        <div style={{ display: 'inline-flex', alignItems: 'center', border: '1px solid var(--wk-line2)', borderRadius: 10, overflow: 'hidden', background: 'var(--card)' }}>
          <button type="button" onClick={() => setCursor((c) => addDays(c, -7))} title="Previous Week" aria-label="Previous week"
            style={{ border: 'none', background: 'none', padding: '7px 9px', cursor: 'pointer', color: 'var(--muted)', display: 'flex' }}><ChevronLeft size={16} /></button>
          <button type="button" onClick={() => setCursor(new Date())} disabled={thisWeek}
            style={{ border: 'none', borderLeft: '1px solid var(--wk-line2)', borderRight: '1px solid var(--wk-line2)', background: 'none', padding: '7px 12px', cursor: thisWeek ? 'default' : 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 700, color: 'var(--ink)' }}>
            {thisWeek ? 'This Week' : rangeText}
          </button>
          <button type="button" onClick={() => setCursor((c) => addDays(c, 7))} title="Next Week" aria-label="Next week"
            style={{ border: 'none', background: 'none', padding: '7px 9px', cursor: 'pointer', color: 'var(--muted)', display: 'flex' }}><ChevronRight size={16} /></button>
        </div>
        {thisWeek && <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>{rangeText}</span>}
        {teamZone && <span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 'auto' }}>Times in {zoneOptionLabel(teamZone)}</span>}
      </div>

      {glance && !error && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 10, marginBottom: 12 }}>
          <GlanceTile icon={Clock} label={glance.on ? 'On Shift Now' : 'Next Shift'} tone={glance.on ? 'green' : 'brand'}
            value={glance.shown ? (glance.shown.d.isToday ? 'Today' : glance.shown.d.key === isoDate(addDays(now, 1)) ? 'Tomorrow' : dayHeading(glance.shown.d.date)) : 'None this week'}
            sub={glance.shown ? `${formatHHMM(glance.shown.s.start)} - ${formatHHMM(glance.shown.s.end)}${glance.shown.s.label ? ` · ${glance.shown.s.label}` : ''}` : 'Nothing else shared'} />
          <GlanceTile icon={Timer} label="Hours" tone="brand" value={fmtHrs(glance.mins)}
            sub={`${glance.shiftCount} shift${glance.shiftCount === 1 ? '' : 's'} ${thisWeek ? 'this week' : 'that week'} · paid time, unpaid breaks excluded`} />
          <GlanceTile icon={Plane} label="Time Off" tone={glance.offDays ? 'amber' : 'muted'}
            value={glance.offDays ? `${glance.offDays} day${glance.offDays === 1 ? '' : 's'}` : 'None'}
            sub={glance.pending ? 'Includes a pending request' : glance.offDays ? 'Approved' : thisWeek ? 'This week' : 'That week'} />
        </div>
      )}

      {error ? (
        <ErrorBanner message="Your shifts could not be loaded right now." onRetry={() => setReload((n) => n + 1)} />
      ) : !data ? (
        <SkeletonBlocks count={7} height={120} gridTemplateColumns="repeat(auto-fill, minmax(150px, 1fr))" />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10 }}>
          {days.map((d) => (
            <div key={d.key} style={{
              background: 'var(--card)', border: `1px solid ${d.isToday ? 'var(--wk-brand)' : 'var(--wk-line2)'}`, borderRadius: 14, padding: '12px 13px', minHeight: 118,
              boxShadow: d.isToday ? '0 0 0 3px var(--wk-brand-tint)' : 'var(--wk-shadow)', display: 'flex', flexDirection: 'column', gap: 6,
            }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                <span style={{ fontSize: 15, fontWeight: 800, color: 'var(--ink)' }}>{d.date.getDate()}</span>
                <span style={{ fontSize: 11.5, fontWeight: 700, color: d.isToday ? 'var(--wk-brand)' : 'var(--muted)' }}>{dayHeading(d.date).replace(/ \d+$/, '')}</span>
                {d.isToday && <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--wk-brand)', marginLeft: 'auto' }}>Today</span>}
              </div>
              {d.holiday && <div style={{ fontSize: 12, fontWeight: 600, color: 'hsl(var(--color-blue))', display: 'flex', alignItems: 'center', gap: 6 }}><CalendarDays size={12} /> {d.holiday}</div>}
              {d.note && <div style={{ fontSize: 12, fontWeight: 600, color: 'hsl(var(--color-orange))', display: 'flex', alignItems: 'flex-start', gap: 6 }}><StickyNote size={12} style={{ flexShrink: 0, marginTop: 2 }} /> {d.note}</div>}
              {d.timeoff.map((t, i) => <TimeOffBlock key={t.id || i} off={t} style={{ marginBottom: 0 }} />)}
              {d.shifts.map((s) => {
                const askable = canAsk && s.date >= todayKey && !pendingIds.has(s.id);
                return (
                  <ShiftBlock key={s.id} shift={s} teamZone={teamZone} style={{ marginBottom: 0 }}>
                    {s.note && <div style={{ fontSize: 11, color: 'var(--muted)' }}>{s.note}</div>}
                    {pendingIds.has(s.id) ? <div style={{ fontSize: 11, color: 'hsl(var(--color-orange))', fontWeight: 600, marginTop: 3 }}>Request Pending</div>
                      : askable && (
                        <button type="button" onClick={() => setAsk({ shift: s })} aria-label={`Request a swap or offer for ${formatHHMM(s.start)} - ${formatHHMM(s.end)}`}
                          style={{ alignSelf: 'flex-start', marginTop: 4, display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 6,
                            border: '1px solid var(--wk-line2)', background: 'var(--card)', color: 'var(--ink)', cursor: 'pointer', fontFamily: 'inherit' }}>
                          <ArrowLeftRight size={10} /> Request
                        </button>
                      )}
                  </ShiftBlock>
                );
              })}
              {!d.shifts.length && !d.holiday && !d.timeoff.length && d.usual && (
                <div title="Your regular hours. No shift is shared for this day yet." style={{ marginTop: 'auto', borderLeft: '3px dotted var(--wk-line2)', paddingLeft: 9 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)' }}>Usual Hours</div>
                  <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{formatHHMM(d.usual.start)} - {formatHHMM(d.usual.end)}</div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {flash && <div role="status" style={{ marginTop: 12, fontSize: 12.5, fontWeight: 600, color: 'hsl(var(--color-green))' }}>{flash}</div>}
      {ask && reqs && (
        <ShiftRequestDialog reqs={reqs} myShifts={(data?.scheduled || []).filter((s) => s.date >= todayKey)} shift={ask.shift} kind={cfg.swaps !== false ? 'swap' : 'offer'}
          nameOf={nameOf} onClose={() => setAsk(null)} onDone={done} />
      )}

      {data && team && (
        <TeamShiftGrid teams={teams} team={team} onPickTeam={setTeamId} days={days} rows={teamRows} onNow={onNow}
          openShifts={openList} onRequestOpen={requestOpen} busyOpenId={busyOpen} thisWeek={thisWeek}
          timeZoneLabel={teamZone ? zoneOptionLabel(teamZone) : ''} teamZone={teamZone} />
      )}

      <MyAvailability />

      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 14, fontSize: 12, color: 'var(--muted)' }}>
        <Info size={13} style={{ flexShrink: 0 }} />
        <span>
          Shifts are set by your manager. Only shifts they have shared appear here - ask them if something looks wrong.
          {data?.shift && ' Usual hours are your regular schedule, shown on days with no shared shift.'}
          {data && teams.length === 0 && ' Your group will show here once your manager adds you to one.'}
          {' '}Swaps, offers and open-shift requests are in Workday &gt; Time Off.
        </span>
      </div>
    </div>
  );
}

const GLANCE_TONE = {
  brand: { fg: 'var(--wk-brand)', bg: 'var(--wk-brand-tint)' },
  green: { fg: 'hsl(var(--color-green))', bg: 'hsla(var(--color-green),0.12)' },
  amber: { fg: 'hsl(var(--color-orange))', bg: 'hsla(var(--color-orange),0.12)' },
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

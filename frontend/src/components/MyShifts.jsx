import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { ChevronLeft, ChevronRight, ChevronDown, ChevronUp, CalendarDays, Info, StickyNote, ArrowLeftRight, CloudRain, Check, CalendarCheck, Copy, RefreshCw } from 'lucide-react';
import { api } from '../api';
import { dialog } from '../ui/dialog';
import { zoneClock, formatHHMM, formatMonthDay, formatDate } from '../lib/datetime';
import { zoneOptionLabel } from '../lib/worldClockZones';
import { useNameResolver } from '../lib/useNameResolver';
import { useIsMobile } from '../lib/useIsMobile';
import { ErrorBanner, SkeletonBlocks } from './AsyncState';
import { shiftPhase } from './shiftScheduleLib';
import TeamShiftGrid from './TeamShiftGrid';
import ShiftRequestDialog, { PENDING } from './shifts/ShiftRequestDialog';
import { ShiftBlock, TimeOffBlock } from './shifts/ShiftBlock';
import DateBlock from './shifts/DateBlock';
import { isoDate, parseIso, weekStartOf, paidMinutes, fmtHrs, dayFullyOff, todayIso, dayShort, shortTime, shiftShortText, actualFor } from './shifts/shiftLib';
import { useShiftRequests } from './useShiftRequests';
import MyAvailability from './MyAvailability';

// Shifts > My Shifts (Sep 29; rebuilt Oct 2026; decluttered 10/02). A
// read-only week of the signed-in person's own SHARED shifts, with time off
// and holidays beside them: one line that says the week ("This week: 2
// shifts · 15.5 Hrs · no time off · next shift Tue 9:00a"), the 7-day
// strip of their own days, then their group's week (TeamShiftGrid) and
// their availability. A day with nothing shared shows the usual hours of
// their shift type as a reminder (never a shift, never counted) - and
// nothing at all otherwise (it used to say "Off", which reads as time
// off). Asking for a swap, an offer or an open shift lives in Workday >
// Time Off; the "Request" link under a shift here opens that same dialog
// with the shift filled in.
//
// `part` (Neil, Oct 13 2026): 'mine' is Workday > My Shifts - your own days,
// weather calls, availability; 'team' is Team > Shifts - your group's week.
// One component, one fetch: the group grid is built from the same week.

const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

// `embedded` (Pranshu, Oct 15 2026): the Workday Overview's My Schedule card.
// A My Week | Team switch in the toolbar flips between the two parts, so your
// group's week is one click away without leaving Workday; availability sits
// behind a toggle and the footer note is left out, so the card stays short.
// `focusConfirm` (Phase 3a): the publish a bell or email asked to have
// confirmed - its banner goes in front; the email's link is
// /shifts/mine?confirm=<publish id>, read once on mount.
export default function MyShifts({ part: partProp = 'mine', embedded = false, focusConfirm = '' }) {
  const [partState, setPart] = useState(partProp);
  const part = embedded ? partState : partProp;
  const mine = part !== 'team';
  const [availOpen, setAvailOpen] = useState(false);
  const nameOf = useNameResolver();
  const phone = useIsMobile();
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
  // Actuals (Phase 1, Oct 14): what the clock said on my own past and
  // running shifts - a bar on the block, the details on hover. Fetched
  // beside the week, never blocking it; a failed call is no bars.
  // Kept with the range it was fetched for, so another week shows nothing
  // until its own answer lands (no state reset inside the effect).
  const [fetched, setFetched] = useState(null);   // { key: 'start|end', data }
  useEffect(() => {
    if (!data || start > todayIso()) return undefined;
    let live = true;
    const key = `${start}|${end}`;
    Promise.resolve().then(() => api.timeSchedActuals(start, end))
      .then((r) => { if (live) setFetched({ key, data: r && typeof r === 'object' && r.cells ? r : null }); })
      .catch(() => { if (live) setFetched({ key, data: null }); });
    return () => { live = false; };
  }, [data, start, end]);
  const actuals = fetched && fetched.key === `${start}|${end}` ? fetched.data : null;
  const actualOf = useCallback((s, sole) => actualFor(actuals?.cells?.[`${s.email}|${s.date}`], s, sole), [actuals]);
  const [reqs, reloadReqs] = useShiftRequests(start, end);
  const [ask, setAsk] = useState(null);          // { shift } while the request dialog is open
  const [flash, setFlash] = useState('');
  const done = (msg) => { setAsk(null); setFlash(msg); reloadReqs(); setReload((n) => n + 1); };
  const [busyOpen, setBusyOpen] = useState('');
  // Weather calls on my days (Weather Call, Oct 2026): what a manager
  // decided and whether I have acknowledged it - one tap here does it.
  // And my own switch for the texts a weather call sends.
  const [calls, setCalls] = useState([]);
  const [prefs, setPrefs] = useState(null);
  const [acking, setAcking] = useState('');
  useEffect(() => {
    let live = true;
    api.weatherCallMine().then((r) => { if (live) setCalls(Array.isArray(r?.calls) ? r.calls : []); }).catch(() => {});
    api.weatherCallMyPrefs().then((r) => { if (live && r) setPrefs(r); }).catch(() => {});
    return () => { live = false; };
  }, [reload]);
  async function acknowledge(c) {
    setAcking(c.id);
    try { await api.weatherCallAck(c.id); setCalls((cs) => cs.map((x) => (x.id === c.id ? { ...x, ackAt: new Date().toISOString() } : x))); setFlash('Acknowledged. Your manager can see you saw it.'); }
    catch (e) { setFlash(e?.message || 'Could not acknowledge.'); }
    setAcking('');
  }
  async function setWeatherSms(on) {
    const before = prefs;
    setPrefs((p) => ({ ...p, weatherSms: on }));
    try { setPrefs(await api.weatherCallMyPrefsSave({ weatherSms: on })); }
    catch { setPrefs(before); setFlash('Could not save that.'); }
  }
  const openCalls = calls.filter((c) => !c.ackAt);
  // Shifts Phase 3a (Oct 14): the schedule comes to people. The shared
  // schedules I have not confirmed yet (newest first - the banner shows one
  // at a time), my Outlook calendar switch, and my iCal subscription link.
  // All three load beside the week and fail quiet: a failed call is simply
  // no banner, no switch, no link.
  const [confirms, setConfirms] = useState(null);   // null until the first answer
  const [confirmErr, setConfirmErr] = useState('');
  const [confirming, setConfirming] = useState('');
  const [calPrefs, setCalPrefs] = useState(null);
  // The share a bell or email pointed at: the prop (a bell, consumed by
  // Shifts.jsx right away, so it is kept here) or ?confirm= in the address
  // (the email), stripped once read so a refresh does not ask again.
  const [wanted, setWanted] = useState(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const id = params.get('confirm') || '';
      if (id) {
        params.delete('confirm');
        const rest = params.toString();
        window.history.replaceState(window.history.state, '', window.location.pathname + (rest ? `?${rest}` : ''));
      }
      return focusConfirm || id;
    } catch { return focusConfirm || ''; }
  });
  // A bell clicked while this is already up may name a share announced
  // after the list loaded: ask again (the list goes back to loading so the
  // "not waiting" check below waits for the fresh answer). State adjusted
  // during render, the React way for a prop change - not in an effect.
  const [confirmTick, setConfirmTick] = useState(0);
  const [seenFocus, setSeenFocus] = useState(focusConfirm);
  if (focusConfirm !== seenFocus) {
    setSeenFocus(focusConfirm);
    if (focusConfirm) { setWanted(focusConfirm); setConfirms(null); setConfirmTick((n) => n + 1); }
  }
  useEffect(() => {
    let live = true;
    Promise.resolve().then(() => api.timeMyConfirmations())
      .then((r) => { if (live) setConfirms(Array.isArray(r?.pending) ? r.pending : []); })
      .catch(() => { if (live) setConfirms((c) => c || []); });
    return () => { live = false; };
  }, [reload, confirmTick]);
  useEffect(() => {
    let live = true;
    Promise.resolve().then(() => api.timeMyPrefsGet()).then((r) => { if (live && r && typeof r === 'object') setCalPrefs(r); }).catch(() => {});
    return () => { live = false; };
  }, [reload]);
  // The share asked for is not waiting on me (confirmed already, or it was
  // superseded and went with a later confirm): say so once, quietly.
  if (wanted && confirms && !confirms.some((c) => c.publishId === wanted)) {
    setWanted('');
    setFlash('No confirmation is waiting for that schedule.');
  }
  async function confirmSchedule(c) {
    setConfirming(c.publishId); setConfirmErr('');
    setConfirms((cs) => cs.filter((x) => x.publishId !== c.publishId));   // optimistic: the next one (if any) steps up
    try { await api.timeSchedConfirm(c.publishId); }
    catch { setConfirms((cs) => (cs.some((x) => x.publishId === c.publishId) ? cs : [c, ...cs])); setConfirmErr('Could not confirm - try again.'); }
    setConfirming('');
  }
  async function setShiftCalendar(on) {
    const before = calPrefs;
    setCalPrefs((p) => ({ ...p, shiftCalendar: on }));
    try { const r = await api.timeMyPrefsSet({ shiftCalendar: on }); if (r && typeof r === 'object') setCalPrefs(r); }
    catch { setCalPrefs(before); setFlash('Could not save that.'); }
  }
  const toConfirm = (wanted && (confirms || []).find((c) => c.publishId === wanted)) || (confirms || [])[0] || null;
  const moreWaiting = (confirms || []).length - 1;
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
    const late = days.reduce((n, d) => n + d.shifts.filter((s) => actualOf(s, d.shifts.length === 1)?.status === 'late').length, 0);
    return { on, next, mins, shiftCount: worked.reduce((n, d) => n + d.shifts.length, 0), offDays, pending, late };
  }, [data, days, clockOf, actualOf]);

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
  // Live status (Miranda, Oct 21): who in the group is working, on a break
  // or clocked out, from today's punches. This week only, again every
  // minute while the tab is in view. A failed call keeps the last map, and
  // the schedule never waits on it.
  const [liveMap, setLiveMap] = useState(null);
  const hasTeam = !!team;
  useEffect(() => {
    if (mine || !thisWeek || !hasTeam) return undefined;
    let alive = true;
    const pull = () => {
      if (document.visibilityState === 'hidden') return;
      Promise.resolve().then(() => api.timeMyScheduleLive())
        .then((r) => { if (alive && r?.people && typeof r.people === 'object') setLiveMap(r.people); })
        .catch(() => {});
    };
    pull();
    const t = setInterval(pull, 60000);
    document.addEventListener('visibilitychange', pull);
    window.addEventListener('nexus:timeclock-changed', pull);   // my own punch shows at once
    return () => { alive = false; clearInterval(t); document.removeEventListener('visibilitychange', pull); window.removeEventListener('nexus:timeclock-changed', pull); };
  }, [mine, thisWeek, hasTeam]);
  const teamZone = data?.timeZone || '';
  const teamZoneLabel = teamZone ? zoneOptionLabel(teamZone) : '';
  const cfg = reqs?.settings || {};
  // Phase 3b: a release needs no teammate - the shift goes to the open pool.
  const canRelease = cfg.releaseShifts === true;
  const canAsk = ((reqs?.teammates || []).length > 0 && (cfg.swaps !== false || cfg.offers !== false)) || canRelease;
  const pendingIds = new Set((reqs?.mine || []).filter((r) => PENDING.includes(r.status)).map((r) => r.shift?.id));
  const openList = cfg.openShifts ? reqs?.openShifts || [] : [];
  const whenText = (x) => (x.d.isToday ? 'today' : x.d.key === isoDate(addDays(now, 1)) ? 'tomorrow' : dayShort(x.d.date));

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
        <div style={{ display: 'inline-flex', alignItems: 'center', border: '1px solid var(--wk-line2)', borderRadius: 10, overflow: 'hidden', background: 'var(--card)' }}>
          <button type="button" onClick={() => setCursor((c) => addDays(c, -7))} title="Previous Week" aria-label="Previous week"
            style={{ border: 'none', background: 'none', padding: '7px 9px', cursor: 'pointer', color: 'var(--muted)', display: 'flex' }}><ChevronLeft size={16} /></button>
          <button type="button" onClick={() => setCursor(new Date())} disabled={thisWeek}
            style={{ border: 'none', borderLeft: '1px solid var(--wk-line2)', borderRight: '1px solid var(--wk-line2)', background: 'none', padding: '7px 12px', cursor: thisWeek ? 'default' : 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 700, color: 'var(--ink)' }}>
            This Week
          </button>
          <button type="button" onClick={() => setCursor((c) => addDays(c, 7))} title="Next Week" aria-label="Next week"
            style={{ border: 'none', background: 'none', padding: '7px 9px', cursor: 'pointer', color: 'var(--muted)', display: 'flex' }}><ChevronRight size={16} /></button>
        </div>
        {/* The decorated date, same as the Schedule's: calendar tile, "Sep 28 - Oct 4",
            the year and week under it; a click picks a week from a month calendar. */}
        <DateBlock view="week" first={start} last={end} weekStart={weekStart} compact={phone} onPick={(ds) => setCursor(parseIso(ds))} />
        {embedded && (
          <div role="tablist" aria-label="Whose week" style={{ marginLeft: 'auto', display: 'inline-flex', gap: 2, background: 'var(--wk-line2)', borderRadius: 9, padding: 2 }}>
            {[['mine', 'My Week'], ['team', 'Team']].map(([k, label]) => (
              <button key={k} type="button" role="tab" aria-selected={part === k} onClick={() => setPart(k)}
                style={{ border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 700, padding: '5px 12px', borderRadius: 7,
                  background: part === k ? 'var(--card)' : 'transparent', color: part === k ? 'var(--ink)' : 'var(--muted)', boxShadow: part === k ? '0 1px 2px rgba(0,0,0,0.08)' : 'none' }}>
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      {mine && toConfirm && (
        <div role="note" aria-label="Confirm your schedule" data-confirm-banner={toConfirm.publishId} className="nx-needs-you--card"
          style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '10px 12px', borderRadius: 12, marginBottom: 12,
            background: 'var(--wk-brand-tint)', border: '1px solid var(--wk-brand)' }}>
          <CalendarCheck size={16} style={{ color: 'var(--wk-brand)', flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 200, fontSize: 13 }}>
            Your schedule was shared{toConfirm.at ? ` on ${formatDate(toConfirm.at)}` : ''}{toConfirm.by ? ` by ${nameOf(toConfirm.by, toConfirm.by)}` : ''}
            {Number(toConfirm.changes) > 0 ? ` (${toConfirm.changes} change${Number(toConfirm.changes) === 1 ? '' : 's'})` : ''} - have a look and confirm.
            {moreWaiting > 0 && <span style={{ color: 'var(--muted)', fontSize: 12 }}> {moreWaiting} more waiting.</span>}
            {confirmErr && <span role="status" style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{confirmErr}</span>}
          </div>
          <button type="button" className="primary-btn" onClick={() => confirmSchedule(toConfirm)} disabled={confirming === toConfirm.publishId} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
            <Check size={13} /> Confirm
          </button>
        </div>
      )}

      {mine && openCalls.length > 0 && (
        <div style={{ display: 'grid', gap: 8, marginBottom: 12 }}>
          {openCalls.map((c) => (
            <div key={c.id} role="alert" data-weather-call={c.id} className="nx-needs-you--card" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '10px 12px', borderRadius: 12,
              background: c.status === 'reinstated' ? 'hsl(var(--color-green) / 0.1)' : 'hsl(var(--color-orange) / 0.1)', border: `1px solid ${c.status === 'reinstated' ? 'hsl(var(--color-green) / 0.4)' : 'hsl(var(--color-orange) / 0.4)'}` }}>
              <CloudRain size={16} style={{ color: c.status === 'reinstated' ? 'hsl(var(--color-green))' : 'hsl(var(--color-orange))', flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 200 }}>
                <div style={{ fontSize: 13, fontWeight: 800 }}>{c.headline}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>{c.groupName} · {formatMonthDay(parseIso(c.date))}{c.reason ? ` · ${c.reason}` : ''}{c.outcome === 'cancelled' && c.status === 'active' ? ' · The day is unpaid.' : ''}</div>
              </div>
              <button type="button" className="primary-btn" onClick={() => acknowledge(c)} disabled={acking === c.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
                <Check size={13} /> Acknowledge
              </button>
            </div>
          ))}
        </div>
      )}

      {mine && glance && !error && (
        <div role="status" aria-label="Week summary" style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 12, lineHeight: 1.5 }}>
          {thisWeek ? 'This week' : 'That week'}: <b style={{ color: 'var(--ink)' }}>{glance.shiftCount} shift{glance.shiftCount === 1 ? '' : 's'}</b>
          {' · '}<b style={{ color: 'var(--ink)' }}>{fmtHrs(glance.mins)}</b>
          {' · '}{glance.offDays ? <b style={{ color: 'hsl(var(--color-orange))' }}>{glance.offDays} day{glance.offDays === 1 ? '' : 's'} off{glance.pending ? ' (one requested)' : ''}</b> : 'no time off'}
          {' · '}{glance.on ? <><b style={{ color: 'hsl(var(--color-green))' }}>on shift now</b> until {shortTime(glance.on.s.end)}</>
            : glance.next ? <>next shift <b style={{ color: 'var(--ink)' }}>{whenText(glance.next)} {shiftShortText(glance.next.s)}</b></>
              : 'next shift none'}
          {glance.late > 0 && <> · <b style={{ color: 'hsl(var(--color-orange))' }}>{glance.late} late</b></>}
        </div>
      )}
      {mine && glance && !error && calPrefs && (
        <CalendarRow prefs={calPrefs} companyOn={calPrefs.companyOutlookCalendar === true} hasMailbox={calPrefs.hasMailbox !== false}
          onToggle={setShiftCalendar} onFlash={setFlash} />
      )}

      {error ? (
        <ErrorBanner message="Your shifts could not be loaded right now." onRetry={() => setReload((n) => n + 1)} />
      ) : !data ? (
        <SkeletonBlocks count={7} height={96} gridTemplateColumns="repeat(auto-fill, minmax(150px, 1fr))" />
      ) : !mine ? null : (
        <div style={{ display: 'grid', gridTemplateColumns: phone ? '1fr' : embedded ? 'repeat(7, minmax(0, 1fr))' : 'repeat(auto-fill, minmax(150px, 1fr))', gap: phone ? 6 : 10 }}>
          {days.map((d, i) => (
            <div key={d.key} style={{
              background: 'var(--card)', border: `1px solid ${d.isToday ? 'var(--wk-brand)' : 'var(--wk-line2)'}`, borderRadius: 12, padding: '10px 11px', minHeight: phone ? 0 : 96,
              boxShadow: d.isToday ? '0 0 0 3px var(--wk-brand-tint)' : 'var(--wk-shadow)', display: 'flex', flexDirection: 'column', gap: 5,
            }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
                <span style={{ fontSize: 13.5, fontWeight: 800, color: d.isToday ? 'var(--wk-brand)' : 'var(--ink)', whiteSpace: 'nowrap' }}>{dayShort(d.date)}</span>
                {(i === 0 || d.date.getDate() === 1) && <span style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--muted)' }}>{formatMonthDay(d.date).replace(/ \d+$/, '')}</span>}
                {d.isToday && <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--wk-brand)', marginLeft: 'auto' }}>Today</span>}
              </div>
              {d.holiday && <div style={{ fontSize: 11.5, fontWeight: 600, color: 'hsl(var(--color-blue))', display: 'flex', alignItems: 'center', gap: 5 }}><CalendarDays size={11} /> {d.holiday}</div>}
              {d.note && <div title={d.note} style={{ fontSize: 11.5, fontWeight: 600, color: 'hsl(var(--color-orange))', display: 'flex', alignItems: 'flex-start', gap: 5 }}><StickyNote size={11} style={{ flexShrink: 0, marginTop: 2 }} /> <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.note}</span></div>}
              {d.timeoff.map((t, i2) => <TimeOffBlock key={t.id || i2} off={t} style={{ marginBottom: 0 }} />)}
              {d.shifts.map((s) => {
                const askable = canAsk && s.date >= todayKey && !pendingIds.has(s.id);
                return (
                  <ShiftBlock key={s.id} shift={s} teamZone={teamZone} style={{ marginBottom: 0 }} actual={actualOf(s, d.shifts.length === 1)} tapActual>
                    {s.note && <div style={{ fontSize: 10.5, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.note}</div>}
                    {pendingIds.has(s.id) ? <div style={{ fontSize: 10.5, color: 'hsl(var(--color-orange))', fontWeight: 600, marginTop: 2 }}>Request Pending</div>
                      : askable && (
                        <button type="button" onClick={() => setAsk({ shift: s })} aria-label={`Request a swap${canRelease ? ', offer or release' : ' or offer'} for ${formatHHMM(s.start)} - ${formatHHMM(s.end)}`}
                          style={{ alignSelf: 'flex-start', marginTop: 3, display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontWeight: 700, padding: '1px 7px', borderRadius: 6,
                            border: '1px solid var(--wk-line2)', background: 'var(--card)', color: 'var(--ink)', cursor: 'pointer', fontFamily: 'inherit' }}>
                          <ArrowLeftRight size={10} /> Request
                        </button>
                      )}
                  </ShiftBlock>
                );
              })}
              {!d.shifts.length && !d.holiday && !d.timeoff.length && d.usual && (
                <div title="Your regular hours. No shift is shared for this day yet." style={{ marginTop: 'auto', border: '1px dashed var(--wk-line2, var(--line))', borderRadius: 6, padding: '4px 8px' }}>
                  <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--muted)' }}>Usual Hours</div>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>{formatHHMM(d.usual.start)} - {formatHHMM(d.usual.end)}</div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {flash && <div role="status" style={{ marginTop: 12, fontSize: 12.5, fontWeight: 600, color: 'hsl(var(--color-green))' }}>{flash}</div>}
      {ask && reqs && (
        <ShiftRequestDialog reqs={reqs} myShifts={(data?.scheduled || []).filter((s) => s.date >= todayKey)} shift={ask.shift} kind={cfg.swaps !== false ? 'swap' : cfg.offers !== false ? 'offer' : 'release'}
          nameOf={nameOf} onClose={() => setAsk(null)} onDone={done} />
      )}

      {mine ? null : data && team ? (
        <TeamShiftGrid teams={teams} team={team} onPickTeam={setTeamId} days={days} rows={teamRows} onNow={onNow}
          openShifts={openList} onRequestOpen={requestOpen} busyOpenId={busyOpen} thisWeek={thisWeek} live={thisWeek ? liveMap : null}
          timeZoneLabel={teamZoneLabel} teamZone={teamZone} />
      ) : data && teamZoneLabel ? (
        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 8 }}>Times in {teamZoneLabel}</div>
      ) : null}

      {mine && embedded && (
        <button type="button" onClick={() => setAvailOpen((v) => !v)} aria-expanded={availOpen}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 12, padding: 0, border: 'none', background: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 700, color: 'var(--ink)' }}>
          {availOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />} My Availability
        </button>
      )}
      {mine && (!embedded || availOpen) && <MyAvailability />}

      {!embedded && <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 14, fontSize: 12, color: 'var(--muted)' }}>
        <Info size={13} style={{ flexShrink: 0 }} />
        <span>
          Shifts are set by your manager. Only shifts they have shared appear here - ask them if something looks wrong.
          {mine && data?.shift && ' Usual hours are your regular schedule, shown on days with no shared shift.'}
          {!mine && data && teams.length === 0 && ' Your group will show here once your manager adds you to one.'}
          {' '}Swaps, offers{canRelease ? ', releases' : ''} and open-shift requests are in Workday &gt; Time Off.
        </span>
      </div>}
      {mine && prefs && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, fontSize: 12.5, cursor: 'pointer', color: 'var(--ink)' }}>
          <input type="checkbox" checked={prefs.weatherSms !== false} onChange={(e) => setWeatherSms(e.target.checked)} aria-label="Text me when a weather call changes my shift" />
          Text me when a weather call changes my shift{prefs.phone ? '' : ' (no phone number on file - ask HR to add one)'}
        </label>
      )}
    </div>
  );
}

// The Calendar row under the week line (Shifts Phase 3a): my Outlook
// calendar switch (a personal opt-out; the company's own switch off = no
// switch, one line that says so; no Microsoft 365 mailbox on file = the
// same, the switch would do nothing) and "Subscribe in another calendar",
// which reveals my iCal link with Copy and New Link. The link is fetched
// only when asked for; a new link is confirmed first because the old one
// stops working in every calendar that uses it. `prefs` is GET
// /timeclock/my-prefs: {shiftCalendar, companyOutlookCalendar, hasMailbox}.
export function CalendarRow({ prefs, companyOn, hasMailbox = true, onToggle, onFlash }) {
  const [open, setOpen] = useState(false);
  const [link, setLink] = useState(null);     // { url } | { error }
  const [copied, setCopied] = useState(false);
  const [rotating, setRotating] = useState(false);
  const urlRef = useRef(null);
  useEffect(() => {
    if (!open || link) return undefined;
    let live = true;
    Promise.resolve().then(() => api.timeMyIcalLink())
      .then((r) => { if (live) setLink(r?.url ? { url: r.url } : { error: 'The link is not available right now.' }); })
      .catch(() => { if (live) setLink({ error: 'The link is not available right now.' }); });
    return () => { live = false; };
  }, [open, link]);
  async function copy() {
    const url = link?.url || '';
    let ok = false;
    try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(url); ok = true; } } catch { ok = false; }
    if (!ok) {
      // No clipboard API (or it was refused): select the text so Ctrl+C takes it.
      try { urlRef.current?.focus(); urlRef.current?.select(); ok = typeof document.execCommand === 'function' && document.execCommand('copy'); } catch { ok = false; }
    }
    setCopied(!!ok);
    if (ok) setTimeout(() => setCopied(false), 1600);
  }
  async function rotate() {
    const sure = await dialog.confirm('Make a new link? The old one stops working in every calendar that uses it - you will need to subscribe again with the new link.', { title: 'New Link', confirmText: 'New Link' });
    if (!sure) return;
    setRotating(true);
    try { const r = await api.timeMyIcalRotate(); setLink(r?.url ? { url: r.url } : { error: 'The link is not available right now.' }); setCopied(false); onFlash?.('New link made. The old one no longer works.'); }
    catch (e) { onFlash?.(e?.message || 'Could not make a new link.'); }
    setRotating(false);
  }
  const on = !!prefs && prefs.shiftCalendar !== false;
  return (
    <div data-calendar-row="" style={{ marginBottom: 12, fontSize: 12.5 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <CalendarDays size={13} style={{ color: 'var(--muted)', flexShrink: 0 }} />
        {/* Off by default (Oct 15 2026): with the company switch off there
            is no Outlook line at all, only the subscribe link. */}
        {!companyOn ? null : !hasMailbox ? (
          <span style={{ color: 'var(--muted)' }} title="Your shifts cannot be added to an Outlook calendar until your Nexus profile is linked to a Microsoft 365 account.">Outlook calendar: no Microsoft 365 mailbox on file</span>
        ) : (
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: prefs ? 'pointer' : 'default', color: 'var(--ink)' }}>
            <span>In your Outlook calendar</span>
            <button type="button" role="switch" aria-checked={on} aria-label="In your Outlook calendar" onClick={() => onToggle(!on)} disabled={!prefs}
              title={on ? 'Your shared shifts are added to your Outlook calendar. Turn this off to keep them out.' : 'Your shifts stay out of your Outlook calendar.'}
              style={{ border: 'none', background: 'none', padding: 0, cursor: prefs ? 'pointer' : 'default', display: 'inline-flex' }}>
              <span aria-hidden="true" style={{ width: 26, height: 15, borderRadius: 999, background: on ? 'var(--wk-brand)' : 'var(--line)', position: 'relative', flexShrink: 0, transition: 'background .15s' }}>
                <span style={{ position: 'absolute', top: 2, left: on ? 13 : 2, width: 11, height: 11, borderRadius: '50%', background: '#fff', transition: 'left .15s', boxShadow: '0 1px 2px rgba(0,0,0,.2)' }} />
              </span>
            </button>
          </label>
        )}
        {companyOn && <span aria-hidden="true" style={{ color: 'var(--muted)' }}>·</span>}
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
          style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 700, color: 'var(--wk-brand)' }}>
          Subscribe in another calendar
        </button>
      </div>
      {open && (
        <div data-ical="" style={{ marginTop: 8, padding: '8px 10px', border: '1px solid var(--wk-line2)', borderRadius: 10, background: 'var(--card)', display: 'grid', gap: 6 }}>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>Add this link as a calendar subscription in Google Calendar, Apple Calendar or any calendar app. Anyone with the link sees your shifts, so keep it to yourself.</div>
          {!link ? <div style={{ fontSize: 12, color: 'var(--muted)' }}>Getting your link...</div>
            : link.error ? <div style={{ fontSize: 12, color: 'var(--muted)' }}>{link.error}</div> : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <input ref={urlRef} readOnly value={link.url} aria-label="Calendar subscription link" className="form-input" onFocus={(e) => e.target.select()}
                  style={{ flex: 1, minWidth: 200, fontSize: 12, padding: '4px 8px', fontFamily: 'inherit' }} />
                <button type="button" className="secondary-btn" onClick={copy} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  {copied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy</>}
                </button>
                <button type="button" className="secondary-btn" onClick={rotate} disabled={rotating} title="A new link; the old one stops working" style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  <RefreshCw size={12} /> New Link
                </button>
              </div>
            )}
        </div>
      )}
    </div>
  );
}

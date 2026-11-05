// The group's week on My Shifts (redesigned 10/02): the SAME engine as the
// manager's Schedule (shifts/WeekGrid.jsx), read-only - one CSS grid, a
// Day Notes row only when there is a note, the Open Shifts row only when
// there are open shifts (with Request on each), usual hours under a name,
// whole days off as one spanning pill. On a phone it is a day list with a
// day strip, never a 7-column grid. Changing a shift is the manager's grid.
import { useEffect, useState } from 'react';
import { CalendarRange, Hand } from 'lucide-react';
import { useIsMobile } from '../lib/useIsMobile';
import { Avatar } from './ShiftScheduleExtras';
import { ShiftBlock, TimeOffBlock } from './shifts/ShiftBlock';
import WeekGrid from './shifts/WeekGrid';
import { DayStrip, PhoneRow, firstDay } from './shifts/SchedulePhone';
import { paidMinutes, fmtHrs, todayIso, shiftShortText, teamColor, minutesText } from './shifts/shiftLib';
import TeamPicker from './shifts/TeamPicker';
import { StatusLabel } from './StatusLabel';
import { formatTime, formatTimeIn } from '../lib/datetime';

const MUTED = { fontSize: 11, color: 'var(--muted)' };
const LIVE_COLOR = { working: 'hsl(var(--color-green))', break: 'hsl(var(--color-orange))', out: '#64748b' };
const LIVE_WORD = { working: ['Working', 'Working since'], break: ['On Break', 'On break since'], out: ['Clocked Out', 'Clocked out at'] };
const minsSince = (iso) => Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60000)) || 0;
const firstName = (r) => (r.isMe ? 'you' : (r.name || '').trim().split(/\s+/)[0]);
// The live team strip (Homebase lifts, Neil 11/02/2026): four soft chips in
// StatusLabel tones - In green, On Break slate, Late amber, Not In muted -
// never a solid fill. Late is the server's call (shift_expect, the one rule).
// "Not In" rather than "Off": the group holds everyone without a punch -
// off today, on leave, or a shift not started yet - so `help` says so.
const STRIP = [
  { key: 'working', word: 'In', color: 'hsl(var(--color-green))' },
  { key: 'break', word: 'On Break', color: '#64748b' },
  { key: 'late', word: 'Late', color: 'hsl(var(--color-orange))' },
  { key: 'off', word: 'Not In', color: 'var(--muted)', help: 'Not clocked in - off today, on leave, or shift not started' },
];

// `live` (Miranda, Oct 21): { email: { state, label, since } } from today's
// punches, this week only. A person in it gets a status chip under the name
// and a dot that follows the clock; anyone else keeps the scheduled dot.
// `late`: the emails the server says are late right now (no clock-in past
// their expected start + grace); the strip counts and filters on it.
export default function TeamShiftGrid({ teams, team, allTeam = null, onPickTeam, days, rows: allRows, onNow = [], openShifts = [], onRequestOpen, busyOpenId = '', thisWeek, timeZoneLabel = '', teamZone = '', live = null, late = [], body = null }) {
  const phone = useIsMobile();
  const [day, setDay] = useState(() => firstDay(days.map((d) => d.date), teamZone));
  useEffect(() => { setDay((k) => (days.some((d) => d.key === k) ? k : firstDay(days.map((d) => d.date), teamZone))); }, [days, teamZone]);
  const [stripFilter, setStripFilter] = useState('');
  if (!team) return null;
  const strip = !!(thisWeek && live);
  // Which strip group a row is in: the clock first, then the server's Late,
  // else Not In (clocked out, on leave, not expected, or not started yet).
  const lateSet = new Set((Array.isArray(late) ? late : []).map((e) => String(e || '').toLowerCase()));
  const groupOf = (r) => {
    const s = live?.[String(r.email || '').toLowerCase()];
    if (s && (s.state === 'working' || s.state === 'break')) return s.state;
    return lateSet.has(String(r.email || '').toLowerCase()) ? 'late' : 'off';
  };
  const activeFilter = strip ? stripFilter : '';
  const rows = activeFilter ? allRows.filter((r) => groupOf(r) === activeFilter) : allRows;
  const stripCount = (key) => allRows.filter((r) => groupOf(r) === key).length;
  const today = todayIso();
  const dayOf = (r, d) => r.days.find((y) => y.key === d.key);
  // Hours are the shared shifts, time off or not: a partial day beside a
  // shift keeps the shift's hours. The day's totals run over the WHOLE team
  // like weekMin - a strip chip narrows the rows shown, never the figures.
  const working = (d) => allRows.filter((r) => dayOf(r, d)?.shifts.length);
  const dayMin = (d) => working(d).reduce((a, r) => a + dayOf(r, d).shifts.reduce((b, s) => b + paidMinutes(s), 0), 0);
  const dayShifts = (d) => allRows.reduce((a, r) => a + (dayOf(r, d)?.shifts.length || 0), 0);
  const rowMin = (r) => r.days.reduce((a, d) => a + d.shifts.reduce((b, s) => b + paidMinutes(s), 0), 0);
  const weekMin = allRows.reduce((a, r) => a + rowMin(r), 0);   // the whole team's week, whatever the strip filter
  const openOn = (key) => openShifts.filter((s) => s.date === key);
  const isOn = (r) => onNow.some((o) => o.email === r.email);
  const liveOf = (email) => {
    const s = live?.[String(email || '').toLowerCase()];
    return s && LIVE_WORD[s.state] ? s : null;
  };
  // The avatar dot: the clock when there is a punch today, else the schedule.
  const dotOf = (r) => { const s = liveOf(r.email); return s ? (s.state !== 'out' && s.state) : isOn(r); };
  const liveChip = (email) => {
    const s = liveOf(email);
    if (!s) return null;
    const [word, since] = LIVE_WORD[s.state];
    const at = s.since ? (teamZone ? formatTimeIn(s.since, teamZone) : formatTime(s.since)) : '';
    return (
      // A plain dot and the word - no pill (Neil, Oct 30 2026).
      <span data-live={s.state} title={at ? `${since} ${at}` : undefined} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 600, color: 'var(--ink)', whiteSpace: 'nowrap' }}>
        <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: '50%', background: LIVE_COLOR[s.state], flexShrink: 0 }} />
        {s.state === 'break' && s.since ? `${word} · ${minutesText(minsSince(s.since))}` : word}
      </span>
    );
  };
  // Phase 3b: which team the slot belongs to, and an "Other Team" chip when
  // it is one the person is not on (openShiftsAcrossTeams) - the same words
  // the request dialog uses, from the same /shift-requests/mine payload.
  const openTeam = (s) => (s.team || s.crossTeam) && (
    <span style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap', fontSize: 10.5, color: 'var(--muted)' }}>
      {s.team && <span>{s.team}</span>}
      {s.crossTeam && <span data-cross-team title="A shift of another team. Your company lets open shifts be claimed across teams." style={{ fontSize: 10, fontWeight: 700, color: 'hsl(var(--color-blue))', border: '1px solid hsla(var(--color-blue),0.4)', borderRadius: 5, padding: '0 5px', lineHeight: 1.5 }}>Other Team</span>}
    </span>
  );
  const openAction = (s, key) => (
    s.requested
        ? <span style={{ fontSize: 10.5, fontWeight: 700, color: 'hsl(var(--color-orange))' }}>Requested</span>
        : onRequestOpen && key >= today && (
          <button type="button" onClick={() => onRequestOpen(s)} disabled={busyOpenId === s.id} aria-label={`Request the open shift on ${key}`}
            style={{ alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontWeight: 700, padding: '1px 7px', borderRadius: 6, marginTop: 3,
              border: '1px solid var(--wk-line2)', background: 'var(--card)', color: 'var(--ink)', cursor: 'pointer', fontFamily: 'inherit' }}>
            <Hand size={10} /> Request
          </button>
        )
  );
  const openExtra = (s, key) => (
    <>
      {openTeam(s)}
      {openAction(s, key)}
    </>
  );
  const openBlock = (s, key) => <ShiftBlock key={s.id} shift={s} open teamZone={teamZone}>{openExtra(s, key)}</ShiftBlock>;
  const cellBody = (d) => (
    <>
      {d.off.map((t, i) => <TimeOffBlock key={t.id || i} off={t} />)}
      {d.shifts.map((s) => <ShiftBlock key={s.id} shift={s} teamZone={teamZone} />)}
    </>
  );

  const head = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap', marginBottom: 10 }}>
      {teams.length > 1 ? (
        <TeamPicker ariaLabel="Group" compact={phone} value={team.id} onChange={onPickTeam} all={allTeam ? { people: allTeam.members.length, ...(team.id === allTeam.id ? { min: weekMin } : {}) } : null}
          teams={teams.map((t, i) => ({ id: t.id, name: t.name, color: teamColor(t.id, i), people: t.members.length, hint: t.isMember === false ? 'You manage' : '',
            ...(t.id === team.id ? { min: weekMin, open: openShifts.reduce((a, s) => a + (s.openSlots || 1), 0) } : {}) }))} />
      ) : (
        <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>{team.name} · {team.members.length} member{team.members.length === 1 ? '' : 's'}{team.isMember === false ? ' · you manage this group' : ''}</span>
      )}
      {strip ? (
        // From the clock: In / On Break / Late / Not In over the people in the grid.
        // A chip filters the rows to its people; the same chip again clears.
        <span data-live-summary role="group" aria-label="Who is on the clock" style={{ marginLeft: phone ? 0 : 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          {STRIP.map((g) => {
            const on = activeFilter === g.key;
            return (
              <button key={g.key} type="button" aria-pressed={on} onClick={() => setStripFilter((f) => (f === g.key ? '' : g.key))}
                title={[g.help, on ? `Showing ${g.word} only - click to show everyone` : `Show only ${g.word}`].filter(Boolean).join('. ')}
                style={{ padding: 0, border: 'none', background: 'none', cursor: 'pointer', fontFamily: 'inherit', borderRadius: 999, outlineOffset: 2, opacity: activeFilter && !on ? 0.55 : 1, transition: 'opacity 160ms var(--ease-out)' }}>
                <StatusLabel size="sm" label={`${g.word} ${stripCount(g.key)}`} color={g.color} style={on ? { boxShadow: 'inset 0 0 0 1px var(--c)' } : undefined} />
              </button>
            );
          })}
        </span>
      ) : thisWeek && (
        <span style={{ marginLeft: 'auto', fontSize: 12.5, color: 'var(--muted)' }}>
          {onNow.length === 0 ? 'Nobody on shift right now' : `On shift now: ${onNow.map(firstName).join(', ')}`}
        </span>
      )}
    </div>
  );
  const zoneLine = timeZoneLabel ? <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 8 }}>Times in {timeZoneLabel}</div> : null;
  // `body`: Team > Shifts' Month view - the same head (group picker), the month calendar under it.
  if (body) return <div style={{ marginTop: 22 }}>{head}{body}{zoneLine}</div>;

  if (phone) {
    const d = days.find((x) => x.key === day) || days[0];
    return (
      <div style={{ marginTop: 22 }}>
        {head}
        <DayStrip days={days.map((x) => x.date)} teamZone={teamZone} value={d?.key || ''} onChange={setDay} countOf={(k) => { const x = days.find((y) => y.key === k); return x ? dayShifts(x) : 0; }} noteOn={(k) => !!days.find((y) => y.key === k)?.note} />
        <div role="table" aria-label={`${team.name} schedule`} style={{ border: '1px solid var(--wk-line2)', borderRadius: 12, background: 'var(--card)', overflow: 'hidden' }}>
          <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--line)', background: 'var(--bg)', display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <span style={{ fontSize: 13, fontWeight: 800 }}>{team.name}</span>
            <span style={MUTED}>{d ? `${dayShifts(d)} · ${fmtHrs(dayMin(d))}` : ''}</span>
            {d?.note && <span title={d.note} style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 600, color: 'hsl(var(--color-orange))', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{d.note}</span>}
          </div>
          {d && (
            <PhoneRow data-member="open" name="Open Shifts" sub={`${openOn(d.key).reduce((a, s) => a + (s.openSlots || 1), 0)} open`}
              avatar={<span style={{ width: 28, height: 28, borderRadius: '50%', border: '1px dashed var(--wk-line2)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', flexShrink: 0 }}><CalendarRange size={13} /></span>}>
              {openOn(d.key).map((s) => openBlock(s, d.key))}
            </PhoneRow>
          )}
          {d && rows.map((r) => {
            const rd = dayOf(r, d);
            return (
              <PhoneRow key={r.email} data-member={r.email} aria-current={r.isMe ? 'true' : undefined} isMe={r.isMe} name={r.name} sub={fmtHrs(rowMin(r))} sub2={r.shift ? `Usual ${shiftShortText(r.shift)}` : ''} extra={liveChip(r.email)}
                avatar={<span style={{ position: 'relative', flexShrink: 0, display: 'flex' }}><Avatar name={r.name} photoUrl={r.photoUrl} size={28} />{dotOf(r) && <OnDot state={dotOf(r)} />}</span>}>
                {rd ? cellBody(rd) : null}
              </PhoneRow>
            );
          })}
        </div>
        {zoneLine}
      </div>
    );
  }

  // The desktop week: the same engine as the manager's Schedule, read-only.
  const byCell = {};
  const offBy = {};
  rows.forEach((r) => r.days.forEach((d) => { byCell[`${r.email}|${d.key}`] = d.shifts; offBy[`${r.email}|${d.key}`] = d.off; }));
  const openCells = {};
  openShifts.forEach((s) => { if (days.some((d) => d.key === s.date)) (openCells[`${team.id || ''}|${s.date}`] ||= []).push(s); });
  const notes = Object.fromEntries(days.filter((d) => d.note).map((d) => [d.key, d.note]));
  const holidayDates = new Set(days.filter((d) => d.holiday).map((d) => d.key));
  const rowOf = Object.fromEntries(rows.map((r) => [r.email, r]));
  const meRow = rows.find((r) => r.isMe);
  const section = { id: team.id, name: team.name, isGroup: true, members: rows.map((r) => ({ email: r.email, name: r.name, photoUrl: r.photoUrl, availability: [] })) };
  return (
    <div style={{ marginTop: 22 }}>
      {head}
      <WeekGrid ariaRole="table" ariaLabel={`${team.name} schedule`} days={days.map((d) => d.date)} sections={[section]} byCell={byCell} openCells={openCells}
        offOn={(email, ds) => offBy[`${email}|${ds}`] || []} usualOf={(email) => rowOf[email]?.shift || null} notes={notes} holidayDates={holidayDates}
        me={meRow?.email || ''} teamZone={teamZone} empWeekMin={(email) => (rowOf[email] ? rowMin(rowOf[email]) : 0)}
        dayStats={(date) => { const d = days.find((x) => x.date === date); return { shifts: dayShifts(d), people: working(d).length, min: dayMin(d) }; }}
        weekMin={weekMin} overWeeks={(email) => { const m = rowOf[email] ? rowMin(rowOf[email]) : 0; return m > 40 * 60 ? [m] : []; }} onNowOf={(email) => !!rowOf[email] && dotOf(rowOf[email])} nameExtra={live ? liveChip : null} notesRow maxHeight="none" single
        blockChildren={(s, { email, ds }) => (!email ? openExtra(s, ds) : null)} />
      {zoneLine}
    </div>
  );
}

const OnDot = ({ state }) => (
  <span data-on-dot={state === true ? 'shift' : state} title={state === 'break' ? 'On break now' : state === 'working' ? 'Working now' : 'On shift now'}
    style={{ position: 'absolute', right: -1, bottom: -1, width: 9, height: 9, borderRadius: '50%', background: state === 'break' ? 'hsl(var(--color-orange))' : 'hsl(var(--color-green))', border: '2px solid var(--card)' }} />
);

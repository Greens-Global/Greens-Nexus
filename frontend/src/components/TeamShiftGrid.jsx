// The group's week on My Shifts (redesigned 10/02): the SAME engine as the
// manager's Schedule (shifts/WeekGrid.jsx), read-only - one CSS grid, a
// Day Notes row only when there is a note, the Open Shifts row only when
// there are open shifts (with Request on each), usual hours under a name,
// whole days off as one spanning pill. On a phone it is a day list with a
// day strip, never a 7-column grid. Changing a shift is the manager's grid.
import { useEffect, useState } from 'react';
import { CalendarRange, Hand, Users } from 'lucide-react';
import { useIsMobile } from '../lib/useIsMobile';
import { Avatar } from './ShiftScheduleExtras';
import { ShiftBlock, TimeOffBlock } from './shifts/ShiftBlock';
import WeekGrid from './shifts/WeekGrid';
import { DayStrip, PhoneRow, firstDay } from './shifts/SchedulePhone';
import { paidMinutes, fmtHrs, todayIso, shiftShortText } from './shifts/shiftLib';

const MUTED = { fontSize: 11, color: 'var(--muted)' };

export default function TeamShiftGrid({ teams, team, onPickTeam, days, rows, onNow = [], openShifts = [], onRequestOpen, busyOpenId = '', thisWeek, timeZoneLabel = '', teamZone = '' }) {
  const phone = useIsMobile();
  const [day, setDay] = useState(() => firstDay(days.map((d) => d.date)));
  useEffect(() => { setDay((k) => (days.some((d) => d.key === k) ? k : firstDay(days.map((d) => d.date)))); }, [days]);
  if (!team) return null;
  const today = todayIso();
  const dayOf = (r, d) => r.days.find((y) => y.key === d.key);
  // Hours are the shared shifts, time off or not: a partial day beside a
  // shift keeps the shift's hours.
  const working = (d) => rows.filter((r) => dayOf(r, d)?.shifts.length);
  const dayMin = (d) => working(d).reduce((a, r) => a + dayOf(r, d).shifts.reduce((b, s) => b + paidMinutes(s), 0), 0);
  const dayShifts = (d) => rows.reduce((a, r) => a + (dayOf(r, d)?.shifts.length || 0), 0);
  const rowMin = (r) => r.days.reduce((a, d) => a + d.shifts.reduce((b, s) => b + paidMinutes(s), 0), 0);
  const weekMin = rows.reduce((a, r) => a + rowMin(r), 0);
  const openOn = (key) => openShifts.filter((s) => s.date === key);
  const isOn = (r) => onNow.some((o) => o.email === r.email);

  const openExtra = (s, key) => (
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
  const openBlock = (s, key) => <ShiftBlock key={s.id} shift={s} open teamZone={teamZone}>{openExtra(s, key)}</ShiftBlock>;
  const cellBody = (d) => (
    <>
      {d.off.map((t, i) => <TimeOffBlock key={t.id || i} off={t} />)}
      {d.shifts.map((s) => <ShiftBlock key={s.id} shift={s} teamZone={teamZone} />)}
    </>
  );

  const head = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap', marginBottom: 10 }}>
      <span className="wkc-chip"><Users size={14} /></span>
      <span style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--ink)' }}>Group Shifts</span>
      {teams.length > 1 ? (
        <select className="form-select" value={team.id} onChange={(e) => onPickTeam(e.target.value)} aria-label="Group" style={{ width: 'auto', fontSize: 12.5, padding: '4px 28px 4px 10px' }}>
          {teams.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.members.length}){t.isMember === false ? ' - you manage' : ''}</option>)}
        </select>
      ) : (
        <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>{team.name} · {team.members.length} member{team.members.length === 1 ? '' : 's'}{team.isMember === false ? ' · you manage this group' : ''}</span>
      )}
      {thisWeek && (
        <span style={{ marginLeft: 'auto', fontSize: 12.5, color: 'var(--muted)' }}>
          {onNow.length === 0 ? 'Nobody on shift right now' : `On shift now: ${onNow.map((r) => (r.isMe ? 'you' : (r.name || '').trim().split(/\s+/)[0])).join(', ')}`}
        </span>
      )}
    </div>
  );
  const zoneLine = timeZoneLabel ? <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 8 }}>Times in {timeZoneLabel}</div> : null;

  if (phone) {
    const d = days.find((x) => x.key === day) || days[0];
    return (
      <div style={{ marginTop: 22 }}>
        {head}
        <DayStrip days={days.map((x) => x.date)} value={d?.key || ''} onChange={setDay} countOf={(k) => { const x = days.find((y) => y.key === k); return x ? dayShifts(x) : 0; }} noteOn={(k) => !!days.find((y) => y.key === k)?.note} />
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
              <PhoneRow key={r.email} data-member={r.email} aria-current={r.isMe ? 'true' : undefined} isMe={r.isMe} name={r.name} sub={`${fmtHrs(rowMin(r))}${r.shift ? ` · Usual ${shiftShortText(r.shift)}` : ''}`}
                avatar={<span style={{ position: 'relative', flexShrink: 0, display: 'flex' }}><Avatar name={r.name} photoUrl={r.photoUrl} size={28} />{isOn(r) && <OnDot />}</span>}>
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
        weekMin={weekMin} overWeeks={(email) => { const m = rowOf[email] ? rowMin(rowOf[email]) : 0; return m > 40 * 60 ? [m] : []; }} onNowOf={(email) => !!rowOf[email] && isOn(rowOf[email])} notesRow maxHeight="none"
        blockChildren={(s, { email, ds }) => (!email ? openExtra(s, ds) : null)} />
      {zoneLine}
    </div>
  );
}

const OnDot = () => <span title="On shift now" style={{ position: 'absolute', right: -1, bottom: -1, width: 9, height: 9, borderRadius: '50%', background: 'hsl(var(--color-green))', border: '2px solid var(--card)' }} />;

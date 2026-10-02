// The group's week on My Shifts, laid out the way Microsoft Teams Shifts
// lays it out and decluttered 10/02: a "Mon 28" day header with "7 · 57 Hrs"
// muted under it, a Day Notes row only when there is a note, the group with
// its hours, an Open Shifts row, then one row per person - photo, name,
// "40 Hrs" - with each shift the same one-line block the manager's grid
// draws (shifts/ShiftBlock.jsx). Time off is its own outlined block BESIDE
// the shift, never in its place (Shifts QA 19). On a phone it is a day
// list with a day strip, never a 7-column grid. Read-only: changing a shift
// is the manager's grid.
import { useEffect, useState } from 'react';
import { CalendarRange, Hand, Users } from 'lucide-react';
import { useIsMobile } from '../lib/useIsMobile';
import { Avatar } from './ShiftScheduleExtras';
import { ShiftBlock, TimeOffBlock, UsualHint } from './shifts/ShiftBlock';
import { PersonCell, DayHeader } from './shifts/ScheduleGrid';
import { DayStrip, PhoneRow, firstDay } from './shifts/SchedulePhone';
import { paidMinutes, fmtHrs, todayIso } from './shifts/shiftLib';

const PERSON_W = 180;
const GRID = { display: 'grid', gridTemplateColumns: `${PERSON_W}px repeat(7, minmax(116px, 1fr))` };
const CELL = { borderLeft: '1px solid var(--line)', padding: 4, minHeight: 56, minWidth: 0 };
const MUTED = { fontSize: 11, color: 'var(--muted)' };
const STICKY = { position: 'sticky', left: 0, zIndex: 2, background: 'var(--card)', borderRight: '1px solid var(--line)' };

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
  const openCount = openShifts.filter((s) => days.some((d) => d.key === s.date)).reduce((a, s) => a + (s.openSlots || 1), 0);
  const notes = days.some((d) => d.note);
  const isOn = (r) => onNow.some((o) => o.email === r.email);

  const openBlock = (s, key) => (
    <ShiftBlock key={s.id} shift={s} open teamZone={teamZone}>
      {s.requested
        ? <span style={{ fontSize: 10.5, fontWeight: 700, color: 'hsl(var(--color-orange))' }}>Requested</span>
        : onRequestOpen && key >= today && (
          <button type="button" onClick={() => onRequestOpen(s)} disabled={busyOpenId === s.id} aria-label={`Request the open shift on ${key}`}
            style={{ alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontWeight: 700, padding: '1px 7px', borderRadius: 6, marginTop: 3,
              border: '1px solid var(--wk-line2)', background: 'var(--card)', color: 'var(--ink)', cursor: 'pointer', fontFamily: 'inherit' }}>
            <Hand size={10} /> Request
          </button>
        )}
    </ShiftBlock>
  );
  const cellBody = (d) => (
    <>
      {d.off.map((t, i) => <TimeOffBlock key={t.id || i} off={t} />)}
      {d.shifts.map((s) => <ShiftBlock key={s.id} shift={s} teamZone={teamZone} />)}
      {!d.shifts.length && !d.off.length && d.usual && <UsualHint start={d.usual.start} end={d.usual.end} />}
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
              <PhoneRow key={r.email} data-member={r.email} aria-current={r.isMe ? 'true' : undefined} isMe={r.isMe} name={r.name} sub={fmtHrs(rowMin(r))}
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

  return (
    <div style={{ marginTop: 22 }}>
      {head}
      <div className="scroll-tabs" style={{ border: '1px solid var(--wk-line2)', borderRadius: 12, background: 'var(--card)', boxShadow: 'var(--wk-shadow)', overflow: 'auto' }}>
        <div role="table" aria-label={`${team.name} schedule`} style={{ minWidth: PERSON_W + 7 * 116 }}>
          <div role="row" style={{ ...GRID, borderBottom: '1px solid var(--line)', background: 'var(--bg)', position: 'sticky', top: 0, zIndex: 3 }}>
            <div style={{ ...STICKY, zIndex: 4, background: 'var(--bg)', padding: '8px 12px', alignSelf: 'end', fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', whiteSpace: 'nowrap' }} title="Paid hours of everyone in the group this week">
              Week · {fmtHrs(weekMin)}
            </div>
            {days.map((d, i) => (
              <DayHeader key={d.key} d={d.date} stats={{ shifts: dayShifts(d), people: working(d).length, min: dayMin(d), first: i === 0 }} isToday={d.isToday} isHol={!!d.holiday} />
            ))}
          </div>

          {notes && (
            <div role="row" style={{ ...GRID, borderBottom: '1px solid var(--line)' }}>
              <div style={{ ...STICKY, padding: '6px 12px', fontSize: 11, color: 'var(--muted)' }}>Day Notes</div>
              {days.map((d) => (
                <div key={d.key} title={d.note || undefined} style={{ borderLeft: '1px solid var(--line)', padding: '6px 9px', fontSize: 11, color: 'hsl(var(--color-orange))', fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.note}</div>
              ))}
            </div>
          )}

          <div style={{ padding: '6px 12px', borderBottom: '1px solid var(--line)', background: 'var(--bg)', display: 'flex', alignItems: 'baseline', gap: 8, position: 'sticky', left: 0 }}>
            <span style={{ fontSize: 12.5, fontWeight: 800, color: 'var(--ink)' }}>{team.name}</span>
            <span style={MUTED}>{fmtHrs(weekMin)} · {rows.length} {rows.length === 1 ? 'person' : 'people'}</span>
          </div>

          <div role="row" data-member="open" style={{ ...GRID, borderBottom: '1px solid var(--line)' }}>
            <div style={{ ...STICKY, padding: '6px 8px 6px 12px', display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <span style={{ width: 28, height: 28, borderRadius: '50%', border: '1px dashed var(--wk-line2)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', flexShrink: 0 }}>
                <CalendarRange size={13} />
              </span>
              <span>
                <div style={{ fontSize: 12.5, fontWeight: 700 }}>Open Shifts</div>
                <div style={MUTED}>{openCount} open</div>
              </span>
            </div>
            {days.map((d) => (
              <div key={d.key} role="cell" style={{ ...CELL, background: d.isToday ? 'var(--wk-brand-tint)' : 'transparent' }}>
                {openOn(d.key).map((s) => openBlock(s, d.key))}
              </div>
            ))}
          </div>

          {rows.map((r) => {
            const me = r.isMe;
            return (
              <div key={r.email} role="row" data-member={r.email} aria-current={me ? 'true' : undefined}
                style={{ ...GRID, borderBottom: '1px solid var(--line)', background: me ? 'var(--wk-brand-tint)' : 'transparent' }}>
                <PersonCell role="rowheader" emp={{ name: r.name, photoUrl: r.photoUrl, availability: [] }} isMe={me} hrs={rowMin(r)} onNow={isOn(r)}
                  style={{ ...STICKY, background: me ? 'var(--wk-brand-tint)' : 'var(--card)', boxShadow: me ? 'inset 3px 0 0 var(--wk-brand)' : 'none' }} />
                {r.days.map((d) => (
                  <div key={d.key} role="cell" style={{ ...CELL, background: !me && d.isToday ? 'var(--wk-brand-tint)' : 'transparent' }}>
                    {cellBody(d)}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
      {zoneLine}
    </div>
  );
}

const OnDot = () => <span title="On shift now" style={{ position: 'absolute', right: -1, bottom: -1, width: 9, height: 9, borderRadius: '50%', background: 'hsl(var(--color-green))', border: '2px solid var(--card)' }} />;

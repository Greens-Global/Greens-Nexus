// The group's week on My Shifts, laid out the way Microsoft Teams Shifts
// lays it out: a day header with the date (month included), how many people
// work and for how long, a Day Notes row, the group with its hours, an Open
// Shifts row, then one row per person - photo, name, their hours - with each
// shift the same block the manager's grid draws (shifts/ShiftBlock.jsx).
// Time off is its own block BESIDE the shift, never in its place, and a
// partial day shows its hours - a 2-4 PM appointment used to wipe a 9-5 and
// take its 8 hours off the day (Shifts QA 19). Read-only: changing a shift
// is the manager's grid.
import { CalendarRange, Hand, Users } from 'lucide-react';
import { Avatar } from './ShiftScheduleExtras';
import { ShiftBlock, TimeOffBlock, UsualHint } from './shifts/ShiftBlock';
import { paidMinutes, fmtHrs, dayHeading, todayIso } from './shifts/shiftLib';

const GRID = { display: 'grid', gridTemplateColumns: '220px repeat(7, minmax(120px, 1fr))' };
const CELL = { borderLeft: '1px solid var(--line)', padding: 4, minHeight: 60, minWidth: 0 };
const MUTED = { fontSize: 11, color: 'var(--muted)' };
const STICKY = { position: 'sticky', left: 0, zIndex: 2, background: 'var(--card)', borderRight: '1px solid var(--line)' };

export default function TeamShiftGrid({ teams, team, onPickTeam, days, rows, onNow = [], openShifts = [], onRequestOpen, busyOpenId = '', thisWeek, timeZoneLabel = '', teamZone = '' }) {
  if (!team) return null;
  const today = todayIso();
  const dayOf = (r, d) => r.days.find((y) => y.key === d.key);
  // Hours are the shared shifts, time off or not: a partial day beside a
  // shift keeps the shift's hours.
  const working = (d) => rows.filter((r) => dayOf(r, d)?.shifts.length);
  const dayMin = (d) => working(d).reduce((a, r) => a + dayOf(r, d).shifts.reduce((b, s) => b + paidMinutes(s), 0), 0);
  const rowMin = (r) => r.days.reduce((a, d) => a + d.shifts.reduce((b, s) => b + paidMinutes(s), 0), 0);
  const weekMin = rows.reduce((a, r) => a + rowMin(r), 0);
  const openOn = (key) => openShifts.filter((s) => s.date === key);
  const openCount = openShifts.filter((s) => days.some((d) => d.key === s.date)).reduce((a, s) => a + (s.openSlots || 1), 0);
  const notes = days.some((d) => d.note);

  return (
    <div style={{ marginTop: 22 }}>
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

      <div className="scroll-tabs" style={{ border: '1px solid var(--wk-line2)', borderRadius: 12, background: 'var(--card)', boxShadow: 'var(--wk-shadow)', overflow: 'auto' }}>
        <div role="table" aria-label={`${team.name} schedule`} style={{ minWidth: 1060 }}>
          <div role="row" style={{ ...GRID, borderBottom: '1px solid var(--line)', background: 'var(--bg)', position: 'sticky', top: 0, zIndex: 3 }}>
            <div style={{ ...STICKY, zIndex: 4, background: 'var(--bg)', padding: '10px 12px', alignSelf: 'end' }} title="Paid hours of everyone in the group this week">
              <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--muted)' }}>Week: {fmtHrs(weekMin)}</div>
              {timeZoneLabel && <div style={{ fontSize: 10.5, color: 'var(--muted)' }}>Times in {timeZoneLabel}</div>}
            </div>
            {days.map((d) => (
              <div key={d.key} role="columnheader" style={{ borderLeft: '1px solid var(--line)', padding: '8px 10px', background: d.isToday ? 'var(--wk-brand-tint)' : 'transparent', display: 'flex', justifyContent: 'space-between', gap: 6, minWidth: 0 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 17, fontWeight: 800, lineHeight: 1.1, color: d.isToday ? 'var(--wk-brand)' : 'var(--ink)' }}>{d.date.getDate()}</div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: d.isToday ? 'var(--wk-brand)' : 'var(--muted)', whiteSpace: 'nowrap' }}>{dayHeading(d.date).replace(/ \d+$/, '')}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div title="People working" style={{ ...MUTED, display: 'inline-flex', alignItems: 'center', gap: 3 }}><Users size={10} /> {working(d).length}</div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--ink)' }}>{fmtHrs(dayMin(d))}</div>
                </div>
              </div>
            ))}
          </div>

          {notes && (
            <div role="row" style={{ ...GRID, borderBottom: '1px solid var(--line)' }}>
              <div style={{ ...STICKY, padding: '8px 12px', fontSize: 11.5, color: 'var(--muted)' }}>Day Notes</div>
              {days.map((d) => (
                <div key={d.key} title={d.note || undefined} style={{ borderLeft: '1px solid var(--line)', padding: '8px 10px', fontSize: 11.5, color: 'hsl(var(--color-orange))', fontWeight: 600, minWidth: 0 }}>{d.note}</div>
              ))}
            </div>
          )}

          <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--line)', background: 'var(--bg)', display: 'flex', alignItems: 'baseline', gap: 8, position: 'sticky', left: 0 }}>
            <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--ink)' }}>{team.name}</span>
            <span style={MUTED}>{fmtHrs(weekMin)}</span>
            <span style={{ ...MUTED, display: 'inline-flex', alignItems: 'center', gap: 3 }}><Users size={10} /> {rows.length}</span>
          </div>

          <div role="row" data-member="open" style={{ ...GRID, borderBottom: '1px solid var(--line)' }}>
            <div style={{ ...STICKY, padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
              <span style={{ width: 30, height: 30, borderRadius: '50%', border: '1px dashed var(--wk-line2)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', flexShrink: 0 }}>
                <CalendarRange size={14} />
              </span>
              <span>
                <div style={{ fontSize: 12.5, fontWeight: 700 }}>Open Shifts</div>
                <div style={MUTED}>{openCount} open</div>
              </span>
            </div>
            {days.map((d) => (
              <div key={d.key} role="cell" style={{ ...CELL, background: d.isToday ? 'var(--wk-brand-tint)' : 'transparent' }}>
                {openOn(d.key).map((s) => (
                  <ShiftBlock key={s.id} shift={s} open teamZone={teamZone}>
                    {s.requested
                      ? <span style={{ fontSize: 11, fontWeight: 700, color: 'hsl(var(--color-orange))' }}>Requested</span>
                      : onRequestOpen && d.key >= today && (
                        <button type="button" onClick={() => onRequestOpen(s)} disabled={busyOpenId === s.id} aria-label={`Request the open shift on ${d.key}`}
                          style={{ alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 6, marginTop: 3,
                            border: '1px solid var(--wk-line2)', background: 'var(--card)', color: 'var(--ink)', cursor: 'pointer', fontFamily: 'inherit' }}>
                          <Hand size={10} /> Request
                        </button>
                      )}
                  </ShiftBlock>
                ))}
              </div>
            ))}
          </div>

          {rows.map((r) => {
            const me = r.isMe;
            const on = onNow.some((o) => o.email === r.email);
            return (
              <div key={r.email} role="row" data-member={r.email} aria-current={me ? 'true' : undefined}
                style={{ ...GRID, borderBottom: me ? '2px solid var(--wk-line2)' : '1px solid var(--line)', background: me ? 'var(--wk-brand-tint)' : 'transparent' }}>
                <div role="rowheader" style={{ ...STICKY, background: me ? 'var(--wk-brand-tint)' : 'var(--card)', padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 9, minWidth: 0, boxShadow: me ? 'inset 3px 0 0 var(--wk-brand)' : 'none' }}>
                  <span style={{ position: 'relative', flexShrink: 0, display: 'flex' }}>
                    <Avatar name={r.name} photoUrl={r.photoUrl} size={32} />
                    {on && <span title="On shift now" style={{ position: 'absolute', right: -1, bottom: -1, width: 9, height: 9, borderRadius: '50%', background: 'hsl(var(--color-green))', border: '2px solid var(--card)' }} />}
                  </span>
                  <span style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: me ? 800 : 700, color: me ? 'var(--wk-brand)' : 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {r.name}
                      {me && <span style={{ fontSize: 9.5, fontWeight: 800, color: '#fff', background: 'var(--wk-brand)', borderRadius: 999, padding: '1px 6px', marginLeft: 6, letterSpacing: '.03em', verticalAlign: 'middle' }}>YOU</span>}
                    </div>
                    <div style={MUTED}>{fmtHrs(rowMin(r))}</div>
                  </span>
                </div>
                {r.days.map((d) => (
                  <div key={d.key} role="cell" style={{ ...CELL, background: !me && d.isToday ? 'var(--wk-brand-tint)' : 'transparent' }}>
                    {d.off.map((t, i) => <TimeOffBlock key={t.id || i} off={t} />)}
                    {d.shifts.map((s) => <ShiftBlock key={s.id} shift={s} teamZone={teamZone} />)}
                    {!d.shifts.length && !d.off.length && d.usual && <UsualHint start={d.usual.start} end={d.usual.end} />}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

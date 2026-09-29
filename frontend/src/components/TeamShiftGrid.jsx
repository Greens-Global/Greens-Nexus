// The team's week on My Shifts, laid out the way Microsoft Teams Shifts lays
// it out (Visesh, Sep 30 2026: "the Teams shifts UI is so different - there
// are no people pictures"): a day header with how many people work and for
// how long, a Day Notes row, the group with its hours, an Open Shifts row,
// then one row per person - photo, name, their hours - with each shift a
// colored block. Read-only: it shows what a manager has published. Changing
// a shift is the manager's grid (Shifts > Schedule).
import { CalendarDays, CalendarRange, Clock, Hand, Users } from 'lucide-react';
import { Avatar } from './ShiftScheduleExtras';
import { timeOffLabel } from './shiftScheduleLib';

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const GRID = { display: 'grid', gridTemplateColumns: '200px repeat(7, minmax(112px, 1fr))' };
const CELL = { borderLeft: '1px solid var(--line)', padding: 4, minHeight: 56, minWidth: 0 };
const MUTED = { fontSize: 11, color: 'var(--muted)' };

const toMin = (hhmm) => { const [h, m] = (hhmm || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
// Paid minutes of a shift: its span (overnight wraps) minus its unpaid break.
function paidMin(s) {
  let d = toMin(s.end) - toMin(s.start);
  if (d < 0) d += 1440;
  return Math.max(0, d - (Number(s.breakMin) || 0));
}
function fmtHrs(min) {
  const h = min / 60;
  return `${Number.isInteger(h) ? h : h.toFixed(1)} Hrs`;
}
function t12(hhmm) {
  const [h, m] = (hhmm || '').split(':').map(Number);
  if (Number.isNaN(h)) return hhmm || '';
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h >= 12 ? 'PM' : 'AM'}`;
}
// What a shift carries beyond its times, one per line.
function detailLines(s) {
  return [s.note, ...(s.activities || []).map(a => `${t12(a.start)} - ${t12(a.end)} ${a.label}`),
    s.breakMin ? `${s.breakMin} min unpaid break` : ''].filter(Boolean);
}

// One shift, as a Teams block: a soft fill in the shift's color, a solid bar
// on the left, its code on top and its hours under a clock.
function ShiftBlock({ shift: s, open = false, children }) {
  const color = s.color || (open ? '#16a34a' : '#64748b');
  const more = detailLines(s);
  return (
    <div data-shift={s.id} title={[`${t12(s.start)} - ${t12(s.end)}${s.label ? ` · ${s.label}` : ''}`, ...more].join('\n')}
      style={{ background: `${color}24`, borderLeft: `4px solid ${color}`, borderRadius: 4, padding: '5px 8px', marginBottom: 3,
        minHeight: 46, display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0,
        ...(open ? { outline: `1px dashed ${color}`, outlineOffset: -1 } : {}) }}>
      <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {s.code || s.label || (open ? 'Open' : 'Shift')}
        {open && (s.openSlots || 1) > 1 && <span style={{ fontWeight: 600, color: 'var(--muted)' }}> · {s.openSlots} spots</span>}
      </div>
      <div style={{ ...MUTED, display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        <Clock size={10} style={{ flexShrink: 0 }} /> {t12(s.start)} - {t12(s.end)}
      </div>
      {s.code && s.label && s.label !== s.code && (
        <div style={{ ...MUTED, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.label}</div>
      )}
      {more.length > 0 && (
        <div style={{ ...MUTED, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{more[0]}{more.length > 1 ? ` +${more.length - 1}` : ''}</div>
      )}
      {children}
    </div>
  );
}

export default function TeamShiftGrid({ teams, team, onPickTeam, days, rows, onNow = [], openShifts = [], onRequestOpen, busyOpenId = '',
  thisWeek, timeZoneLabel = '' }) {
  if (!team) return null;
  const working = (d) => rows.filter(r => { const x = r.days.find(y => y.key === d.key); return x && !x.off && x.shifts.length; });
  const dayMin = (d) => working(d).reduce((a, r) => a + r.days.find(y => y.key === d.key).shifts.reduce((b, s) => b + paidMin(s), 0), 0);
  const rowMin = (r) => r.days.reduce((a, d) => a + (d.off ? 0 : d.shifts.reduce((b, s) => b + paidMin(s), 0)), 0);
  const weekMin = rows.reduce((a, r) => a + rowMin(r), 0);
  const openOn = (key) => openShifts.filter(s => s.date === key);
  const openCount = openShifts.filter(s => days.some(d => d.key === s.date)).reduce((a, s) => a + (s.openSlots || 1), 0);
  const notes = days.some(d => d.note);

  return (
    <div style={{ marginTop: 22 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap', marginBottom: 10 }}>
        <span className="wkc-chip"><Users size={14} /></span>
        <span style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--ink)' }}>Team Shifts</span>
        {teams.length > 1 ? (
          <select className="form-select" value={team.id} onChange={e => onPickTeam(e.target.value)} aria-label="Team" style={{ width: 'auto', fontSize: 12.5, padding: '4px 28px 4px 10px' }}>
            {teams.map(t => <option key={t.id} value={t.id}>{t.name} ({t.members.length}){t.isMember === false ? ' - you manage' : ''}</option>)}
          </select>
        ) : (
          <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>{team.name} · {team.members.length} member{team.members.length === 1 ? '' : 's'}{team.isMember === false ? ' · you manage this team' : ''}</span>
        )}
        {thisWeek && (
          <span style={{ marginLeft: 'auto', fontSize: 12.5, color: 'var(--muted)' }}>
            {onNow.length === 0
              ? 'Nobody on shift right now'
              : `On shift now: ${onNow.map(r => (r.isMe ? 'you' : (r.name || r.email).trim().split(/\s+/)[0])).join(', ')}`}
          </span>
        )}
      </div>
      {timeZoneLabel && <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 6 }}>All times are shown in {timeZoneLabel}.</div>}

      <div className="scroll-tabs" style={{ border: '1px solid var(--wk-line2)', borderRadius: 12, background: 'var(--card)', boxShadow: 'var(--wk-shadow)', overflowX: 'auto' }}>
        <div role="table" aria-label={`${team.name} schedule`} style={{ minWidth: 990 }}>
          {/* Day header: the date, who works, for how long */}
          <div role="row" style={{ ...GRID, borderBottom: '1px solid var(--line)', background: 'var(--bg)' }}>
            <div style={{ padding: '10px 12px', fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', alignSelf: 'end' }}>Week: {fmtHrs(weekMin)}</div>
            {days.map(d => (
              <div key={d.key} role="columnheader" style={{ borderLeft: '1px solid var(--line)', padding: '8px 10px', background: d.isToday ? 'var(--wk-brand-tint)' : 'transparent',
                display: 'flex', justifyContent: 'space-between', gap: 6 }}>
                <div>
                  <div style={{ fontSize: 17, fontWeight: 800, lineHeight: 1.1, color: d.isToday ? 'var(--wk-brand)' : 'var(--ink)' }}>{d.date.getDate()}</div>
                  <div style={{ fontSize: 11, color: d.isToday ? 'var(--wk-brand)' : 'var(--muted)' }}>{DOW[d.date.getDay()]}</div>
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
              <div style={{ padding: '8px 12px', fontSize: 11.5, color: 'var(--muted)' }}>Day Notes</div>
              {days.map(d => (
                <div key={d.key} title={d.note || undefined} style={{ borderLeft: '1px solid var(--line)', padding: '8px 10px', fontSize: 11.5, color: '#b45309', fontWeight: 600, minWidth: 0 }}>{d.note}</div>
              ))}
            </div>
          )}

          {/* The group, with its hours and headcount */}
          <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--line)', background: 'var(--bg)', display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--ink)' }}>{team.name}</span>
            <span style={{ ...MUTED }}>{fmtHrs(weekMin)}</span>
            <span style={{ ...MUTED, display: 'inline-flex', alignItems: 'center', gap: 3 }}><Users size={10} /> {rows.length}</span>
          </div>

          {/* Open shifts anyone on the team can ask for */}
          <div role="row" data-member="open" style={{ ...GRID, borderBottom: '1px solid var(--line)' }}>
            <div style={{ padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
              <span style={{ width: 30, height: 30, borderRadius: '50%', border: '1px dashed var(--wk-line2)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', flexShrink: 0 }}>
                <CalendarRange size={14} />
              </span>
              <span>
                <div style={{ fontSize: 12.5, fontWeight: 700 }}>Open Shifts</div>
                <div style={MUTED}>{openCount} shift{openCount === 1 ? '' : 's'}</div>
              </span>
            </div>
            {days.map(d => (
              <div key={d.key} role="cell" style={{ ...CELL, background: d.isToday ? 'hsla(var(--color-green),0.04)' : 'transparent' }}>
                {openOn(d.key).map(s => (
                  <ShiftBlock key={s.id} shift={s} open>
                    {s.requested
                      ? <span style={{ fontSize: 11, fontWeight: 700, color: '#b45309' }}>Requested</span>
                      : onRequestOpen && (
                        <button type="button" onClick={() => onRequestOpen(s)} disabled={busyOpenId === s.id}
                          aria-label={`Request the open shift on ${d.key}`}
                          style={{ alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 6,
                            border: '1px solid var(--wk-line2)', background: 'var(--card)', color: 'var(--ink)', cursor: 'pointer', fontFamily: 'inherit' }}>
                          <Hand size={10} /> Request
                        </button>
                      )}
                  </ShiftBlock>
                ))}
              </div>
            ))}
          </div>

          {rows.map(r => {
            const me = r.isMe;
            const on = onNow.some(o => o.email === r.email);
            return (
              <div key={r.email} role="row" data-member={r.email} aria-current={me ? 'true' : undefined}
                style={{ ...GRID, borderBottom: me ? '2px solid var(--wk-line2)' : '1px solid var(--line)', background: me ? 'var(--wk-brand-tint)' : 'transparent' }}>
                <div role="rowheader" style={{ padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 9, minWidth: 0, boxShadow: me ? 'inset 3px 0 0 var(--wk-brand)' : 'none' }}>
                  <span style={{ position: 'relative', flexShrink: 0, display: 'flex' }}>
                    <Avatar name={r.name || r.email} photoUrl={r.photoUrl} size={32} />
                    {on && <span title="On shift now" style={{ position: 'absolute', right: -1, bottom: -1, width: 9, height: 9, borderRadius: '50%', background: 'hsl(var(--color-green))', border: '2px solid var(--card)' }} />}
                  </span>
                  <span style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: me ? 800 : 700, color: me ? 'var(--wk-brand)' : 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {r.name || r.email}
                      {me && <span style={{ fontSize: 9.5, fontWeight: 800, color: '#fff', background: 'var(--wk-brand)', borderRadius: 999, padding: '1px 6px', marginLeft: 6, letterSpacing: '.03em', verticalAlign: 'middle' }}>YOU</span>}
                    </div>
                    <div style={MUTED}>{fmtHrs(rowMin(r))}</div>
                  </span>
                </div>
                {r.days.map(d => (
                  <div key={d.key} role="cell" style={{ ...CELL, background: !me && d.isToday ? 'hsla(var(--color-green),0.04)' : 'transparent' }}>
                    {d.off ? (
                      // The reason and note arrive only when the shift
                      // settings share them with teammates.
                      <div title={d.off.note || undefined} style={{ background: 'rgba(244,63,94,0.10)', borderLeft: '4px solid #f43f5e', borderRadius: 4, padding: '5px 8px', minHeight: 46 }}>
                        <div style={{ fontSize: 11.5, fontWeight: 700, color: '#9f1239', display: 'flex', alignItems: 'center', gap: 4 }}>
                          <CalendarDays size={10} /> {d.off.type ? timeOffLabel(d.off.type) : 'Time off'}
                        </div>
                        <div style={{ fontSize: 11, color: '#9f1239' }}>All day</div>
                      </div>
                    ) : d.shifts.length === 0 ? (
                      d.usual
                        ? <div title="Usual hours. No shift is published for this day yet." style={{ ...MUTED, padding: '5px 4px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>Usual {t12(d.usual.start)} - {t12(d.usual.end)}</div>
                        : null
                    ) : d.shifts.map(s => <ShiftBlock key={s.id} shift={s} />)}
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

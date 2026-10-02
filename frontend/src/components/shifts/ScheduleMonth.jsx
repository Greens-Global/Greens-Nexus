// Month view (Oct 2026): a calendar, not 31 narrow columns. Each day says
// how many shifts and hours are on it, how many open spots, who is off and
// any holiday; click a day to open it. Time off, holidays and open shifts
// used to be left out of the month entirely.
import { formatDate, formatWeekday } from '../../lib/datetime';
import { isoDate, fmtHrs, planMinutes, counts, weekStartOf, timeOffWhen, isAllDayOff } from './shiftLib';
import { Avatar } from '../ShiftScheduleExtras';

// Faces on each day (Visesh, 10/02: "show the people photos in the box so we
// know who's available and who's not"): who is working, then who is off
// (faded, rose ring). Up to MAX faces each, then "+N".
const MAX = 6;
function Faces({ list, people, names, off = false }) {
  if (!list.length) return null;
  const shown = list.slice(0, MAX);
  const label = (e) => people[e]?.name || names[e] || '';
  return (
    <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 2 }}>
      {shown.map((e) => (
        <span key={e} title={`${label(e)}${off ? ' - off' : ' - working'}`} style={{ borderRadius: '50%', padding: 1, display: 'inline-flex',
          boxShadow: off ? '0 0 0 1.5px rgba(225,29,72,0.55)' : '0 0 0 1.5px hsla(var(--color-green),0.55)', opacity: off ? 0.55 : 1, filter: off ? 'grayscale(0.6)' : 'none' }}>
          <Avatar name={label(e)} photoUrl={people[e]?.photoUrl} size={24} />
        </span>
      ))}
      {list.length > MAX && <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', marginLeft: 2 }}>+{list.length - MAX}</span>}
    </div>
  );
}

export default function ScheduleMonth({ days, shifts, openShifts, timeoff, holidayDates, holidayNames, notes, visibleEmails, names, people = {}, weekStart = 'monday', onOpenDay }) {
  if (!days.length) return null;
  const first = weekStartOf(days[0], weekStart);
  const cells = [];
  for (let d = new Date(first); cells.length < 42; d.setDate(d.getDate() + 1)) {
    cells.push(new Date(d));
    if (cells.length % 7 === 0 && d >= days[days.length - 1]) break;
  }
  const month = days[0].getMonth();
  const today = isoDate(new Date());
  const headers = Array.from({ length: 7 }, (_, i) => formatWeekday(new Date(first.getFullYear(), first.getMonth(), first.getDate() + i), 'short'));
  const perDay = (ds) => {
    const placed = shifts.filter((s) => s.date === ds && counts(s));
    const open = openShifts.filter((s) => s.date === ds && counts(s)).reduce((a, s) => a + (s.openSlots || 1), 0);
    const off = (timeoff || []).filter((t) => t.startDate <= ds && ds <= t.endDate && visibleEmails.has((t.email || '').toLowerCase()));
    const offAll = new Set(off.filter((t) => isAllDayOff(t) && t.status === 'approved').map((t) => (t.email || '').toLowerCase()));
    const working = [...new Set(placed.map((s) => (s.email || '').toLowerCase()))].filter((e) => !offAll.has(e));
    const offPeople = [...new Set(off.map((t) => (t.email || '').toLowerCase()))];
    return { n: placed.length, min: placed.reduce((a, s) => a + planMinutes(s), 0), open, off, working, offPeople };
  };
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 12, overflow: 'hidden', background: 'var(--card)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', background: 'var(--bg)', borderBottom: '1px solid var(--line)' }}>
        {headers.map((h) => <div key={h} style={{ padding: '8px 10px', fontSize: 11, fontWeight: 800, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em' }}>{h}</div>)}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))' }}>
        {cells.map((d) => {
          const ds = isoDate(d);
          const inMonth = d.getMonth() === month;
          const st = inMonth ? perDay(ds) : null;
          const isToday = ds === today;
          const hol = inMonth && holidayDates.has(ds);
          return (
            <button key={ds} type="button" onClick={() => inMonth && onOpenDay(ds)} aria-label={`Open ${formatDate(ds)}`} disabled={!inMonth}
              style={{ minHeight: 104, padding: '8px 10px', display: 'flex', flexDirection: 'column', justifyContent: 'flex-start', alignItems: 'stretch', gap: 2, border: 'none', borderRight: '1px solid var(--line)', borderBottom: '1px solid var(--line)', textAlign: 'left',
                background: isToday ? 'var(--wk-brand-tint)' : hol ? 'hsla(var(--color-blue),0.06)' : 'transparent', cursor: inMonth ? 'pointer' : 'default', fontFamily: 'inherit', color: 'var(--ink)', opacity: inMonth ? 1 : 0.35 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                <span style={{ fontSize: 15, fontWeight: 800, color: isToday ? 'var(--wk-brand)' : 'var(--ink)' }}>{d.getDate()}</span>
                {hol && <span style={{ fontSize: 10, fontWeight: 700, color: 'hsl(var(--color-blue))', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{holidayNames[ds] || 'Holiday'}</span>}
              </div>
              {st && (
                <div style={{ display: 'grid', gap: 4, marginTop: 4, fontSize: 11 }}>
                  {st.n > 0 && <div style={{ fontWeight: 700 }}>{st.n} shift{st.n === 1 ? '' : 's'} <span style={{ color: 'var(--muted)', fontWeight: 600 }}>· {fmtHrs(st.min)}</span></div>}
                  {st.open > 0 && <div style={{ color: 'hsl(var(--color-green))', fontWeight: 700 }}>{st.open} open</div>}
                  <Faces list={st.working} people={people} names={names} />
                  <Faces list={st.offPeople} people={people} names={names} off />
                  {/* Faces show who is off all day; the text only says what a face cannot:
                      part of a day, or only requested. */}
                  {st.off.filter((t) => !(t.status === 'approved' && isAllDayOff(t))).slice(0, 2).map((t, i) => (
                    <div key={t.id || i} style={{ color: 'hsl(var(--color-red))', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                      title={`${names[t.email] || ''} ${isAllDayOff(t) ? 'off' : timeOffWhen(t)}`}>
                      {names[t.email]?.split(' ')[0] || 'Someone'} {t.status === 'approved' ? 'off' : 'requested off'}{isAllDayOff(t) ? '' : ` ${timeOffWhen(t)}`}
                    </div>
                  ))}
                  {notes[ds] && <div style={{ color: 'hsl(var(--color-orange))', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={notes[ds]}>{notes[ds]}</div>}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Day view (Oct 2026): a timeline of who works when. Bars sit on a 24-hour
// track; an overnight shift runs to the right edge. The header carries the
// day's headcount and hours and each person their hours. Click a bar to
// edit it, an empty track to add a shift - or, with a shift copied, to PASTE
// it there (the copied banner used to promise that and the track ignored it).
import { StickyNote, Users, CalendarRange } from 'lucide-react';
import { formatHHMM } from '../../lib/datetime';
import { Avatar } from '../ShiftScheduleExtras';
import { TimeOffBlock, HolidayBlock } from './ShiftBlock';
import { toMin, durMin, fmtHrs, paidMinutes, counts, shiftState, shiftTimeText, alpha, DEFAULT_SHIFT_COLOR, OPEN_SHIFT_COLOR, unpaidLabel } from './shiftLib';

const HOURS = [0, 3, 6, 9, 12, 15, 18, 21];
const GRID = { display: 'grid', gridTemplateColumns: '230px minmax(560px, 1fr)' };
const STICKY_LEFT = { position: 'sticky', left: 0, zIndex: 2, background: 'var(--card)', borderRight: '1px solid var(--line)' };

export default function ScheduleDay({ date, sections, shifts, openCells, notes, canManage, offOn, holOn, copied, prefs, rowEditable, shiftEditable, dragId, on,
  dragProps = () => ({}), dropProps = () => ({}), dropStyle = () => ({}), clickable = (fn) => fn }) {
  const byEmail = {};
  shifts.forEach((s) => { if (s.date === date && s.email) (byEmail[s.email] ||= []).push(s); });
  const people = new Set(Object.keys(byEmail).filter((e) => byEmail[e].some(counts)));
  // People only, like the Week total; the Open Shifts rows say their own counts.
  const dayMin = shifts.filter((s) => s.date === date && s.email && counts(s)).reduce((a, s) => a + paidMinutes(s), 0);
  const bar = (s, email) => {
    const a = toMin(s.start);
    const w = Math.min(durMin(s.start, s.end), 1440 - a);
    const st = shiftState(s);
    const color = s.color || (email ? DEFAULT_SHIFT_COLOR : OPEN_SHIFT_COLOR);
    const unpaid = unpaidLabel(s);
    return (
      <button key={s.id} type="button" data-shift={s.id} onClick={clickable((e) => { e.stopPropagation(); on.openShift(e, s, email, date); })}
        title={[shiftTimeText(s), s.label, st.title, unpaid, ...(s.conflicts || [])].filter(Boolean).join('\n')}
        {...dragProps(s)} onContextMenu={(e) => on.menu(e, { email, date, groupId: s.groupId || '', shift: s })}
        onPointerDown={(e) => { dragProps(s).onPointerDown?.(e); on.longPress(e, { email, date, groupId: s.groupId || '', shift: s }); }}
        aria-label={`${email ? 'Shift' : 'Open shift'} ${shiftTimeText(s)}${st.tag ? `, ${st.tag}` : ''}`}
        style={{ position: 'absolute', top: 6, bottom: 6, left: `${(a / 1440) * 100}%`, width: `${(w / 1440) * 100}%`, minWidth: 30,
          background: alpha(color, 0.2), borderLeft: `4px solid ${color}`, border: `1px ${s.published === false || !email ? 'dashed' : 'solid'} ${color}`, borderLeftWidth: 4, borderRadius: 6,
          fontSize: 11, fontWeight: 700, color: 'var(--ink)', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', cursor: shiftEditable(s) ? 'grab' : 'pointer',
          padding: '0 6px', textAlign: 'left', fontFamily: 'inherit', opacity: dragId === s.id ? 0.4 : s.pendingDelete ? 0.55 : 1, textDecoration: s.pendingDelete ? 'line-through' : 'none' }}>
        {shiftTimeText(s)}{s.label ? ` · ${s.label}` : ''}{unpaid ? ` · ${unpaid}` : ''}{email ? '' : ` · ${s.openSlots || 1} open`}{st.tag ? ` · ${st.tag}` : ''}
      </button>
    );
  };
  const track = (email, groupId, items, extra) => {
    const editable = rowEditable(email);
    return (
      <div onClick={clickable(() => { if (!editable) return; if (copied) on.paste(email, date, groupId); else on.add(email, date, groupId); })}
        {...dropProps(email, date)} onContextMenu={(e) => on.menu(e, { email, date, groupId, shift: null })}
        onPointerDown={(e) => on.longPress(e, { email, date, groupId, shift: null })}
        title={editable ? (copied ? 'Paste the copied shift here' : 'Add a shift') : undefined}
        style={{ ...dropStyle(email, date), position: 'relative', height: 60, borderLeft: '1px solid var(--line)', cursor: editable ? 'pointer' : 'default',
          backgroundImage: 'repeating-linear-gradient(to right, transparent 0, transparent calc(12.5% - 1px), var(--line) calc(12.5% - 1px), var(--line) 12.5%)' }}>
        {extra}
        {items.map((s) => bar(s, email))}
      </div>
    );
  };
  const openRow = (g) => {
    const gid = g.id || '';
    const items = openCells[`${gid}|${date}`] || [];
    return (
      <div key={`open-${gid}`} style={{ ...GRID, borderBottom: '1px solid var(--line)', background: 'hsla(var(--color-green),0.03)' }}>
        <div style={{ ...STICKY_LEFT, padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
          <CalendarRange size={13} color="var(--muted)" /><span style={{ fontSize: 12.5, fontWeight: 800 }}>Open Shifts</span>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>{items.filter(counts).reduce((a, s) => a + (s.openSlots || 1), 0)} open</span>
        </div>
        {track('', gid, items)}
      </div>
    );
  };
  return (
    <div style={{ overflow: 'auto', border: '1px solid var(--line)', borderRadius: 12, background: 'var(--card)', userSelect: 'none' }} onDragStart={(e) => e.preventDefault()}>
      <div style={{ minWidth: 800 }}>
        <div style={{ ...GRID, background: 'var(--bg)', borderBottom: '1px solid var(--line)', position: 'sticky', top: 0, zIndex: 3 }}>
          <div style={{ ...STICKY_LEFT, zIndex: 4, background: 'var(--bg)', padding: '8px 12px' }}>
            <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em', display: 'flex', alignItems: 'center', gap: 6 }}>
              <Users size={11} /> {people.size} {people.size === 1 ? 'person' : 'people'} · {fmtHrs(dayMin)}
            </div>
            {(notes[date] || canManage) && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 3, fontWeight: 600 }}>
                {notes[date] && <span style={{ fontSize: 11, color: 'hsl(var(--color-orange))' }}>{notes[date]}</span>}
                {canManage && <button type="button" onClick={() => on.noteEdit(date)} aria-label={notes[date] ? 'Edit the day note' : 'Add a day note'}
                  style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--muted)', padding: 0, display: 'inline-flex' }}><StickyNote size={11} /></button>}
              </div>
            )}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', borderLeft: '1px solid var(--line)' }}>
            {HOURS.map((h) => <div key={h} style={{ padding: '8px 4px', fontSize: 10.5, color: 'var(--muted)', fontWeight: 700 }}>{formatHHMM(`${String(h).padStart(2, '0')}:00`).replace(':00', '')}</div>)}
          </div>
        </div>
        {openCells.__ungrouped && prefs.open !== false && openRow({ id: '' })}
        {sections.map((g, gi) => (
          <div key={g.id || gi}>
            <div style={{ padding: '6px 12px', fontSize: 12.5, fontWeight: 800, background: 'var(--bg)', borderBottom: '1px solid var(--line)', position: 'sticky', left: 0 }}>
              {g.name} <span style={{ color: 'var(--muted)', fontWeight: 600 }}>· {g.members.length} {g.members.length === 1 ? 'person' : 'people'}</span>
            </div>
            {g.isGroup && prefs.open !== false && openRow(g)}
            {g.members.map((emp) => {
              const off = offOn(emp.email, date);
              const hol = holOn(emp.email, date);
              const items = byEmail[emp.email] || [];
              const min = items.filter(counts).reduce((a, s) => a + paidMinutes(s), 0);
              const extra = (off.length || hol) ? (
                <div style={{ position: 'absolute', top: 4, right: 6, display: 'flex', gap: 4, zIndex: 1, maxWidth: '45%' }}>
                  {hol && <HolidayBlock holiday={hol} compact style={{ marginBottom: 0 }} />}
                  {off.map((t, i) => <TimeOffBlock key={t.id || i} off={t} compact style={{ marginBottom: 0 }} />)}
                </div>
              ) : null;
              return (
                <div key={emp.email} style={{ ...GRID, borderBottom: '1px solid var(--line)' }}>
                  <div style={{ ...STICKY_LEFT, padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
                    {prefs.photos !== false && <Avatar name={emp.name} photoUrl={emp.photoUrl} size={30} />}
                    <span style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{emp.name}</div>
                      <div style={{ fontSize: 10.5, color: 'var(--muted)' }}>{fmtHrs(min)}</div>
                    </span>
                  </div>
                  {track(emp.email, g.id || '', items, extra)}
                </div>
              );
            })}
          </div>
        ))}
        {sections.length === 0 && <div style={{ padding: 24, textAlign: 'center', fontSize: 12.5, color: 'var(--muted)' }}>Nobody matches the filter.</div>}
      </div>
    </div>
  );
}

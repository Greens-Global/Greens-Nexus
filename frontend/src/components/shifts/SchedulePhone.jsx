// The schedule on a phone (Oct 2026): never a 7-column grid. A day switcher
// strip ("Mon 28 · Tue 29 ...") picks ONE day, and each person is one row
// with that day's blocks beside their name. Tap a block = the editor, tap
// an empty row = add (or paste), long-press = the menu - the same `on` the
// week grid calls. DayStrip and PhoneRow are shared with the My Shifts
// group grid so both phone screens read the same.
import { useEffect, useState } from 'react';
import { CalendarRange, StickyNote, Plus } from 'lucide-react';
import { formatDate } from '../../lib/datetime';
import { Avatar } from '../ShiftScheduleExtras';
import { ShiftBlock, TimeOffBlock, HolidayBlock } from './ShiftBlock';
import { isoDate, dayShort, fmtHrs, todayIso, planMinutes, counts, sectionKey, shiftShortText } from './shiftLib';

// The strip: one chip per day, the picked one filled, today ringed, a dot
// for a day with a note. Scrolls sideways when the week is wider than the
// screen (two weeks).
export function DayStrip({ days, value, onChange, countOf, noteOn, hoursOf }) {
  const today = todayIso();
  return (
    <div role="tablist" aria-label="Day" className="scroll-tabs" style={{ display: 'flex', gap: 6, overflowX: 'auto', padding: '2px 2px 8px', marginBottom: 2 }}>
      {days.map((d) => {
        const ds = isoDate(d);
        const on = ds === value;
        const isToday = ds === today;
        const n = countOf ? countOf(ds) : 0;
        return (
          <button key={ds} type="button" role="tab" aria-selected={on} aria-label={`${formatDate(ds)}${n ? `, ${n} shift${n === 1 ? '' : 's'}` : ''}`} onClick={() => onChange(ds)}
            style={{ flex: '1 0 auto', minWidth: 52, padding: '6px 8px', borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'center',
              border: `1px solid ${on ? 'var(--wk-brand)' : isToday ? 'var(--wk-brand)' : 'var(--line)'}`,
              background: on ? 'var(--wk-brand)' : isToday ? 'var(--wk-brand-tint)' : 'var(--card)', color: on ? '#fff' : isToday ? 'var(--wk-brand)' : 'var(--ink)' }}>
            <div style={{ fontSize: 12, fontWeight: 800, whiteSpace: 'nowrap', lineHeight: 1.2 }}>{dayShort(d)}</div>
            <div style={{ fontSize: 10, fontWeight: 600, opacity: on ? 0.9 : 0.7, whiteSpace: 'nowrap', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 3 }}>
              {hoursOf ? fmtHrs(hoursOf(ds)) : (n ? `${n} shift${n === 1 ? '' : 's'}` : '-')}
              {noteOn?.(ds) && <StickyNote size={9} aria-label="Has a note" />}
            </div>
          </button>
        );
      })}
    </div>
  );
}

// One person on one day: photo, name and hours on the left, the day's
// blocks on the right. The whole row is the drop / press target.
export function PhoneRow({ avatar, name, sub, isMe = false, onTap, children, style, ...rest }) {
  return (
    <div {...rest} onClick={onTap} style={{ display: 'grid', gridTemplateColumns: '124px minmax(0, 1fr)', gap: 8, alignItems: 'center', padding: '7px 10px', borderBottom: '1px solid var(--line)',
      background: isMe ? 'var(--wk-brand-tint)' : undefined, boxShadow: isMe ? 'inset 3px 0 0 var(--wk-brand)' : 'none', cursor: onTap ? 'pointer' : 'default', ...style }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
        {avatar}
        <span style={{ minWidth: 0 }}>
          <div style={{ fontSize: 12.5, fontWeight: isMe ? 800 : 700, color: isMe ? 'var(--wk-brand)' : 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
          {sub && <div style={{ fontSize: 10.5, color: 'var(--muted)', whiteSpace: 'nowrap' }}>{sub}</div>}
        </span>
      </div>
      <div style={{ minWidth: 0 }}>{children}</div>
    </div>
  );
}

// The day a phone opens on: today when it is in view, else the first day.
export function firstDay(days) {
  const today = todayIso();
  return days.map(isoDate).find((ds) => ds === today) || (days[0] ? isoDate(days[0]) : '');
}

export default function SchedulePhone({ days, sections, byCell, openCells, offOn, holOn, usualOf = () => null, notes, holidayDates, me, prefs, teamZone, canManage,
  rowEditable, empWeekMin, dayStats, dragId, collapsed, copied, on }) {
  const [day, setDay] = useState(() => firstDay(days));
  // A new range (next week) lands on today or its first day.
  useEffect(() => { setDay((d) => (days.some((x) => isoDate(x) === d) ? d : firstDay(days))); }, [days]);
  const d = days.find((x) => isoDate(x) === day) || days[0];
  const ds = d ? isoDate(d) : '';
  const stats = d ? dayStats(d) : { shifts: 0, min: 0 };
  const hol = holidayDates.has(ds);
  const press = (ctx) => ({ onContextMenu: (e) => on.menu(e, ctx), onPointerDown: (e) => on.longPress(e, ctx) });
  const block = (s, email, groupId) => (
    <ShiftBlock key={s.id} shift={s} open={!email} teamZone={teamZone} dragging={dragId === s.id} showConflicts={prefs.conflicts !== false}
      onOpen={(e) => on.openShift(e, s, email, ds)} {...press({ email, date: ds, groupId, shift: s })} />
  );
  const emptyTap = (email, groupId, editable) => (editable ? () => { if (copied) on.paste(email, ds, groupId); else on.cellClick(email, ds, groupId); } : undefined);
  const openRow = (g) => {
    const gid = g.id || '';
    const items = openCells[`${gid}|${ds}`] || [];
    const n = items.filter(counts).reduce((b, s) => b + (s.openSlots || 1), 0);
    const min = items.filter(counts).reduce((b, s) => b + planMinutes(s), 0);
    const editable = rowEditable('');
    return (
      <PhoneRow key={`open-${gid}`} data-open-row={gid || 'all'} name="Open Shifts" sub={`${n} open · ${fmtHrs(min)}`} onTap={!items.length ? emptyTap('', gid, editable) : undefined}
        {...press({ email: '', date: ds, groupId: gid, shift: null })} style={{ background: 'hsla(var(--color-green),0.03)' }}
        avatar={<span style={{ width: 28, height: 28, borderRadius: '50%', border: '1px dashed var(--line)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', flexShrink: 0 }}><CalendarRange size={13} /></span>}>
        {items.map((s) => block(s, '', gid))}
        {!items.length && editable && <AddHint />}
      </PhoneRow>
    );
  };
  return (
    <div>
      <DayStrip days={days} value={day} onChange={setDay} countOf={(k) => dayStats(days.find((x) => isoDate(x) === k)).shifts} noteOn={(k) => !!notes[k]} />
      <div role="list" aria-label={`Schedule for ${formatDate(ds)}`} style={{ border: '1px solid var(--line)', borderRadius: 12, background: 'var(--card)', overflow: 'hidden' }}>
        <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--line)', background: 'var(--bg)', display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span style={{ fontSize: 13, fontWeight: 800 }}>{d ? dayShort(d) : ''}</span>
          <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>{stats.shifts} · {fmtHrs(stats.min)}</span>
          {hol && <span style={{ fontSize: 10.5, fontWeight: 700, color: 'hsl(var(--color-blue))' }}>Holiday</span>}
          <span style={{ flex: 1 }} />
          {(notes[ds] || canManage) && (
            <button type="button" onClick={() => on.noteEdit(ds)} disabled={!canManage} aria-label={notes[ds] ? `Edit the note for ${formatDate(ds)}` : `Add a note for ${formatDate(ds)}`} title={notes[ds] || 'Add a day note'}
              style={{ border: 'none', background: 'none', cursor: canManage ? 'pointer' : 'default', padding: 0, display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0, maxWidth: '55%', fontFamily: 'inherit',
                fontSize: 11, fontWeight: 600, color: notes[ds] ? 'hsl(var(--color-orange))' : 'var(--muted)' }}>
              <StickyNote size={11} style={{ flexShrink: 0 }} />
              {notes[ds] && <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{notes[ds]}</span>}
            </button>
          )}
        </div>
        {openCells.__ungrouped && openRow({ id: '' })}
        {sections.length === 0 && <div style={{ padding: 24, textAlign: 'center', fontSize: 12.5, color: 'var(--muted)' }}>Nobody is on the schedule in this view.</div>}
        {sections.map((g) => {
          const key = sectionKey(g);
          const open = !collapsed.has(key);
          const groupMin = g.members.reduce((a, m) => a + empWeekMin(m.email), 0);
          return (
            <div key={key} data-team={g.id || undefined}>
              <button type="button" onClick={() => on.toggleCollapse(key)} aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} ${g.name}`}
                style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', border: 'none', borderBottom: '1px solid var(--line)', background: 'var(--bg)',
                  fontFamily: 'inherit', fontSize: 12.5, fontWeight: 800, color: 'var(--ink)', cursor: 'pointer', textAlign: 'left' }}>
                <span style={{ transform: open ? 'rotate(90deg)' : 'none', display: 'inline-flex', transition: 'transform .15s' }}>›</span>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.name}{g.archived ? ' (Archived)' : ''}</span>
                <span style={{ color: 'var(--muted)', fontWeight: 600, fontSize: 11 }}>{fmtHrs(groupMin)} · {g.members.length}</span>
              </button>
              {open && g.isGroup && prefs.open !== false && openRow(g)}
              {open && g.members.length === 0 && <div style={{ padding: '10px 12px', fontSize: 12, color: 'var(--muted)', borderBottom: '1px solid var(--line)' }}>Nobody in this group yet.</div>}
              {open && g.members.map((emp) => {
                const items = byCell[`${emp.email}|${ds}`] || [];
                const off = offOn(emp.email, ds);
                const h = holOn(emp.email, ds);
                const usual = usualOf(emp.email);
                const editable = rowEditable(emp.email);
                const isMe = emp.email === me;
                return (
                  <PhoneRow key={emp.email} data-cell={`${emp.email}|${ds}`} isMe={isMe} name={emp.name} sub={`${fmtHrs(empWeekMin(emp.email))}${usual ? ` · Usual ${shiftShortText(usual)}` : ''}`}
                    avatar={prefs.photos !== false ? <Avatar name={emp.name} photoUrl={emp.photoUrl} size={28} /> : null}
                    onTap={!items.length ? emptyTap(emp.email, g.id || '', editable) : undefined} {...press({ email: emp.email, date: ds, groupId: g.id || '', shift: null })}>
                    {h && <HolidayBlock holiday={h} />}
                    {off.map((t, i) => <TimeOffBlock key={t.id || i} off={t} />)}
                    {items.map((s) => block(s, emp.email, g.id || ''))}
                    {!items.length && !off.length && !h && editable && <AddHint />}
                  </PhoneRow>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const AddHint = () => (
  <span aria-hidden="true" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--muted)', opacity: 0.7 }}><Plus size={12} /> Add</span>
);

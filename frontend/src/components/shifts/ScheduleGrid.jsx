// The week grid (Oct 2026, Teams parity): rows 60px tall, a sticky day header
// and a sticky person column, a group header with its hours and a collapse
// chevron, an Open Shifts row PER group, the today column tinted, and a day
// header that always says its month. Cells and blocks are keyboard
// reachable: arrow keys move, Enter opens, Delete removes a draft.
// Everything the grid does goes through `on` - the container owns the data
// and the API calls.
import { Fragment } from 'react';
import { Plus, AlertTriangle, Lock, ChevronDown, ChevronRight, CalendarRange, StickyNote, MoreHorizontal, Search } from 'lucide-react';
import { formatDate } from '../../lib/datetime';
import { Avatar } from '../ShiftScheduleExtras';
import { TeamMenu } from '../ShiftTeams';
import { ShiftBlock, TimeOffBlock, HolidayBlock, UsualHint } from './ShiftBlock';
import { isoDate, dayHeading, fmtHrs, todayIso, planMinutes, counts } from './shiftLib';
import { availText } from '../shiftScheduleLib';

const ROW_H = 60;
const DAY_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const TOOL_BTN = { width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid var(--line)',
  borderRadius: 5, background: 'var(--card)', color: 'var(--muted)', cursor: 'pointer', padding: 0 };
const STICKY_LEFT = { position: 'sticky', left: 0, zIndex: 2, background: 'var(--card)' };

// Arrow keys between cells; Enter opens; Delete removes a draft.
export function gridKeys(e, on) {
  const t = e.target;
  const block = t.closest?.('[data-shift]');
  const cell = t.closest?.('[data-cell]');
  if (!cell) return;
  const r = Number(cell.dataset.r), c = Number(cell.dataset.c);
  const grid = e.currentTarget;
  const go = (nr, nc) => { const el = grid.querySelector(`[data-cell][data-r="${nr}"][data-c="${nc}"]`); if (el) { e.preventDefault(); el.focus(); } };
  if (e.key === 'ArrowRight') go(r, c + 1);
  else if (e.key === 'ArrowLeft') go(r, c - 1);
  else if (e.key === 'ArrowDown') go(r + 1, c);
  else if (e.key === 'ArrowUp') go(r - 1, c);
  else if (e.key === 'Enter' && !block && t === cell) { e.preventDefault(); on.enterCell(cell.dataset.cell); }
  else if ((e.key === 'Delete' || e.key === 'Backspace') && block) { e.preventDefault(); on.deleteKey(block.dataset.shift); }
  else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
    const box = (block || cell).getBoundingClientRect();
    e.preventDefault();
    on.menuAt({ x: box.left + 12, y: box.top + 12, cell: cell.dataset.cell, shift: block?.dataset.shift });
  }
}

export default function ScheduleGrid({ days, compact, sections, byCell, openCells, offOn, holOn, availOn, usualOn, notes, holidayDates, me, prefs, teamZone,
  canManage, rowEditable, shiftEditable, empWeekMin, dayStats, weekMin, overWeeks, copied, dropKey, dragId, collapsed, on, dragProps, personDragProps, dropProps, dropStyle, hoverCell, hoverShift, clickable, shiftTools }) {
  const today = todayIso();
  const cols = `230px repeat(${days.length}, minmax(${compact ? 48 : 128}px, 1fr))`;
  const GRID = { display: 'grid', gridTemplateColumns: cols };
  const gridMin = 230 + days.length * (compact ? 50 : 128);
  const coarse = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)')?.matches;
  let row = 0;   // keyboard row index across every section

  const dayCell = (email, ds, groupId, items, r, c, extra, editable) => (
    <div key={ds} data-cell={`${email}|${ds}`} data-r={r} data-c={c} data-group={groupId || undefined} tabIndex={r === 0 && c === 0 ? 0 : -1} role="gridcell"
      aria-label={`${email ? '' : 'Open shifts '}${formatDate(ds)}${items.length ? `, ${items.length} shift${items.length === 1 ? '' : 's'}` : ', empty'}`}
      onClick={clickable(() => { if (!items.length && editable) on.cellClick(email, ds, groupId); })}
      {...dropProps(email, ds)} {...(editable ? hoverCell(email, ds, groupId) : {})}
      onContextMenu={(e) => on.menu(e, { email, date: ds, groupId, shift: null })}
      onPointerDown={(e) => on.longPress(e, { email, date: ds, groupId, shift: null })}
      className="sched-cell"
      style={{ borderLeft: '1px solid var(--line)', padding: compact ? 2 : 4, minHeight: ROW_H, minWidth: 0, position: 'relative', outline: 'none',
        cursor: items.length || !editable ? 'default' : 'pointer', background: ds === today ? 'var(--wk-brand-tint)' : undefined, ...dropStyle(email, ds) }}>
      {extra}
      {items.map((s) => (
        <ShiftBlock key={s.id} shift={s} open={!email} compact={compact} teamZone={teamZone} tabIndex={-1} dragging={dragId === s.id}
          showConflicts={prefs.conflicts !== false}
          onOpen={(e) => on.openShift(e, s, email, ds)} dragProps={dragProps(s)} {...hoverShift(s)}
          onContextMenu={(e) => on.menu(e, { email, date: ds, groupId, shift: s })}
          onPointerDown={(e) => { dragProps(s).onPointerDown?.(e); on.longPress(e, { email, date: ds, groupId, shift: s }); }}
          tools={shiftEditable(s) && !s.pendingDelete && !compact ? (
            <span className="chip-tools" style={{ position: 'absolute', top: 3, right: 3, display: 'flex', flexDirection: 'column', gap: 2, opacity: coarse ? 1 : 0 }}>
              <button type="button" aria-label="Shift details" title="Details" onClick={(e) => { e.stopPropagation(); on.details(e, s); }} style={TOOL_BTN}><Search size={11} /></button>
              <button type="button" aria-label="Shift options" title="More options" onClick={(e) => { e.stopPropagation(); on.menu(e, { email, date: ds, groupId, shift: s }); }} style={TOOL_BTN}><MoreHorizontal size={12} /></button>
            </span>
          ) : null} />
      ))}
      {!items.length && editable && (
        <div className="sched-add" aria-hidden="true" style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', opacity: 0, pointerEvents: 'none' }}>
          <Plus size={16} />
        </div>
      )}
    </div>
  );

  const openRow = (g, r) => {
    const gid = g.id || '';
    const items = (ds) => openCells[`${gid}|${ds}`] || [];
    const min = days.reduce((a, d) => a + items(isoDate(d)).filter(counts).reduce((b, s) => b + planMinutes(s), 0), 0);
    const n = days.reduce((a, d) => a + items(isoDate(d)).filter(counts).reduce((b, s) => b + (s.openSlots || 1), 0), 0);
    return (
      <div key={`open-${gid}`} role="row" data-open-row={gid || 'all'} style={{ ...GRID, borderBottom: '1px solid var(--line)', background: 'hsla(var(--color-green),0.03)' }}>
        <div style={{ ...STICKY_LEFT, padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 9, minWidth: 0, borderRight: '1px solid var(--line)' }}>
          <span style={{ width: 30, height: 30, borderRadius: '50%', border: '1px dashed var(--line)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', flexShrink: 0 }}>
            <CalendarRange size={13} />
          </span>
          <span style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12.5, fontWeight: 800 }}>Open Shifts</div>
            <div style={{ fontSize: 10.5, color: 'var(--muted)' }}>{n} open · {fmtHrs(min)}</div>
          </span>
        </div>
        {days.map((d, c) => dayCell('', isoDate(d), gid, items(isoDate(d)), r, c, null, rowEditable('')))}
      </div>
    );
  };

  return (
    <div role="grid" aria-label="Schedule" onKeyDown={(e) => gridKeys(e, on)} onDragStart={(e) => e.preventDefault()}
      style={{ overflow: 'auto', border: '1px solid var(--line)', borderRadius: 12, maxHeight: 'calc(100vh - 150px)', userSelect: 'none', WebkitUserSelect: 'none', background: 'var(--card)' }}>
      <div style={{ minWidth: gridMin }}>
        {/* Day header */}
        <div role="row" style={{ ...GRID, borderBottom: '1px solid var(--line)', background: 'var(--bg)', position: 'sticky', top: 0, zIndex: 3 }}>
          <div style={{ ...STICKY_LEFT, zIndex: 4, background: 'var(--bg)', padding: '8px 12px', borderRight: '1px solid var(--line)', alignSelf: 'end' }}
            title="Paid hours of the people shown. Open shifts are counted on their own row.">
            <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em' }}>Week: {fmtHrs(weekMin)}</div>
            {teamZone && <div style={{ fontSize: 10.5, color: 'var(--muted)' }}>Times in {teamZone}</div>}
          </div>
          {days.map((d) => {
            const st = dayStats(d);
            const ds = isoDate(d);
            const isToday = ds === today;
            const isHol = holidayDates.has(ds);
            return (
              <div key={ds} role="columnheader" style={{ padding: compact ? '6px 4px' : '8px 10px', borderLeft: '1px solid var(--line)', minWidth: 0, background: isToday ? 'var(--wk-brand-tint)' : isHol ? 'hsla(var(--color-blue),0.06)' : 'transparent' }}>
                <button type="button" onClick={() => on.openDay(ds)} aria-label={`Open ${formatDate(ds)}`} title="Open this day"
                  style={{ display: 'flex', alignItems: 'baseline', gap: 5, border: 'none', background: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', minWidth: 0, maxWidth: '100%' }}>
                  <span style={{ fontSize: compact ? 13 : 17, fontWeight: 800, color: isToday ? 'var(--wk-brand)' : 'var(--ink)', lineHeight: 1.1 }}>{d.getDate()}</span>
                  <span style={{ fontSize: compact ? 9.5 : 11.5, fontWeight: 600, color: isToday ? 'var(--wk-brand)' : 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {compact ? dayHeading(d, 'narrow').split(' ')[0] : dayHeading(d).replace(/ \d+$/, '')}
                  </span>
                </button>
                <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                  title={`${st.shifts} shift${st.shifts === 1 ? '' : 's'} · ${st.people} ${st.people === 1 ? 'person' : 'people'} · ${fmtHrs(st.min)}`}>
                  {compact ? (st.shifts || '') : `${st.shifts} shift${st.shifts === 1 ? '' : 's'} · ${fmtHrs(st.min)}`}
                </div>
                {isHol && <div style={{ fontSize: 10, fontWeight: 700, color: 'hsl(var(--color-blue))', marginTop: 2 }}>{compact ? 'Hol' : 'Holiday'}</div>}
                {(notes[ds] || canManage) && !compact && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 3, minWidth: 0 }}>
                    {notes[ds] && <span title={notes[ds]} style={{ fontSize: 10.5, fontWeight: 600, color: 'hsl(var(--color-orange))', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{notes[ds]}</span>}
                    {canManage && (
                      <button type="button" onClick={() => on.noteEdit(ds)} aria-label={notes[ds] ? `Edit the note for ${formatDate(ds)}` : `Add a note for ${formatDate(ds)}`}
                        title={notes[ds] ? 'Edit day note' : 'Add a day note'}
                        style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--muted)', padding: 0, display: 'inline-flex', flexShrink: 0 }}>
                        <StickyNote size={11} />
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Open shifts that belong to no group (or every group, before groups existed) */}
        {openCells.__ungrouped && openRow({ id: '' }, row++)}

        {sections.length === 0 && <div style={{ padding: 24, textAlign: 'center', fontSize: 12.5, color: 'var(--muted)' }}>Nobody is on the schedule in this view.</div>}
        {sections.map((g, gi) => {
          const key = g.id || `sec-${gi}`;
          const open = !collapsed.has(key);
          const groupMin = g.members.reduce((a, m) => a + empWeekMin(m.email), 0);
          return (
            <Fragment key={key}>
              <div role="row" data-team={g.id || undefined}
                style={{ ...GRID, background: 'var(--bg)', borderBottom: '1px solid var(--line)', borderTop: gi ? '1px solid var(--line)' : 'none',
                  ...(dropKey === `team:${g.id}` ? { outline: '2px dashed var(--wk-brand)', outlineOffset: -3, background: 'var(--wk-brand-tint)' } : {}) }}>
                <div style={{ padding: '6px 12px', gridColumn: '1 / -1', fontSize: 12.5, fontWeight: 800, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', position: 'sticky', left: 0 }}>
                  <button type="button" onClick={() => on.toggleCollapse(key)} aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} ${g.name}`}
                    style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--muted)', padding: 0, display: 'inline-flex' }}>
                    {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                  </button>
                  <span>{g.name}{g.archived ? ' (Archived)' : ''}</span>
                  <span style={{ color: 'var(--muted)', fontWeight: 600 }} title="Paid hours of this group's people this week">· {fmtHrs(groupMin)} · {g.members.length} {g.members.length === 1 ? 'person' : 'people'}</span>
                  {g.id && g.canEdit && g.isGroup && (
                    <>
                      <button type="button" onClick={() => on.addMembers(g)}
                        style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--wk-brand)', fontSize: 11.5, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 3, padding: 0, fontFamily: 'inherit' }}>
                        <Plus size={12} /> Add Members
                      </button>
                      <TeamMenu team={g} canReorder={g.canReorder} onAction={(a) => on.teamAction(g, a)} />
                    </>
                  )}
                </div>
              </div>
              {open && g.isGroup && prefs.open !== false && openRow(g, row++)}
              {open && g.members.length === 0 && (
                <div style={{ padding: '10px 12px', fontSize: 12, color: 'var(--muted)', borderBottom: '1px solid var(--line)' }}>Nobody in this group yet.</div>
              )}
              {open && g.members.map((emp) => {
                const over = overWeeks(emp.email);
                const editable = rowEditable(emp.email);
                const r = row++;
                const isMe = emp.email === me;
                return (
                  <div key={emp.email} role="row" aria-current={isMe ? 'true' : undefined}
                    style={{ ...GRID, borderBottom: '1px solid var(--line)', background: isMe ? 'var(--wk-brand-tint)' : undefined }}>
                    <div {...(personDragProps ? personDragProps(emp, g) : {})}
                      style={{ ...STICKY_LEFT, background: isMe ? 'var(--wk-brand-tint)' : 'var(--card)', padding: '8px 10px 8px 12px', display: 'flex', alignItems: 'center', gap: 9, minWidth: 0,
                        borderRight: '1px solid var(--line)', boxShadow: isMe ? 'inset 3px 0 0 var(--wk-brand)' : 'none' }}
                      className="sched-person">
                      {prefs.photos !== false && <Avatar name={emp.name} photoUrl={emp.photoUrl} size={32} />}
                      <span style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 12.5, fontWeight: isMe ? 800 : 700, color: isMe ? 'var(--wk-brand)' : undefined, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {emp.name}
                          {isMe && <span style={{ fontSize: 9.5, fontWeight: 800, color: '#fff', background: 'var(--wk-brand)', borderRadius: 999, padding: '1px 6px', marginLeft: 6, letterSpacing: '.03em', verticalAlign: 'middle' }}>YOU</span>}
                        </div>
                        <div style={{ fontSize: 10.5, color: over.length ? 'hsl(var(--color-red))' : 'var(--muted)', fontWeight: over.length ? 800 : 500, display: 'flex', alignItems: 'center', gap: 3, whiteSpace: 'nowrap' }}
                          title={over.length ? `Over 40 scheduled hours in a week (${over.map(fmtHrs).join(', ')})` : 'Paid hours this week'}>
                          {over.length > 0 && <AlertTriangle size={10} aria-label="Over 40 hours" />}
                          {fmtHrs(empWeekMin(emp.email))}{over.length > 0 && ' · Over 40'}
                          {!editable && canManage && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, marginLeft: 4 }}><Lock size={9} /> View Only</span>}
                        </div>
                        {prefs.availability !== false && emp.availability?.length > 0 && (
                          <div title={`Availability: ${availText(emp.availability)}`} style={{ fontSize: 10, color: 'hsl(var(--color-orange))', fontWeight: 600 }}>Limited Availability</div>
                        )}
                      </span>
                      {canManage && editable && (
                        <button type="button" className="person-tools" aria-label={`Options for ${emp.name}`} title="Options"
                          onClick={(e) => { e.stopPropagation(); on.personMenu(e, emp, g); }}
                          style={{ ...TOOL_BTN, flexShrink: 0, opacity: coarse ? 1 : 0 }}><MoreHorizontal size={12} /></button>
                      )}
                    </div>
                    {days.map((d, c) => {
                      const ds = isoDate(d);
                      const items = byCell[`${emp.email}|${ds}`] || [];
                      const off = offOn(emp.email, ds);
                      const hol = holOn(emp.email, ds);
                      const av = availOn(emp.email, d);
                      const usual = !items.length && !off.length && !hol && av?.kind !== 'unavailable' ? usualOn(emp.email, d) : null;
                      const extra = (
                        <>
                          {hol && <HolidayBlock holiday={hol} compact={compact} />}
                          {off.map((t, i) => <TimeOffBlock key={t.id || i} off={t} compact={compact} />)}
                          {av?.kind === 'unavailable' && !off.length && !hol && (
                            <div title={`${emp.name} is unavailable on ${DAY_LONG[(d.getDay() + 6) % 7]}s`}
                              style={{ position: 'absolute', inset: 0, background: 'repeating-linear-gradient(135deg, hsla(var(--color-orange),0.12) 0 6px, transparent 6px 12px)', pointerEvents: 'none' }} />
                          )}
                          {!items.length && av?.kind === 'unavailable' && !off.length && !hol && !compact && (
                            <div style={{ fontSize: 10.5, color: 'hsl(var(--color-orange))', fontWeight: 600, padding: '4px 6px', position: 'relative' }}>Unavailable</div>
                          )}
                          {usual && <UsualHint start={usual.start} end={usual.end} compact={compact} />}
                          {av && av.kind === 'available' && !off.length && !hol && !compact && (
                            <div title={`Available ${av.start} - ${av.end} on ${DAY_LONG[(d.getDay() + 6) % 7]}s`}
                              style={{ fontSize: 10, color: 'hsl(var(--color-orange))', fontWeight: 600, padding: '0 6px 4px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', position: 'relative' }}>
                              Available {availText([av]).replace(/^\w+ /, '')}
                            </div>
                          )}
                        </>
                      );
                      return dayCell(emp.email, ds, g.id || '', items, r, c, extra, editable);
                    })}
                  </div>
                );
              })}
            </Fragment>
          );
        })}
      </div>
      {copied && <span aria-live="polite" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>A shift is copied. Press Enter on an empty day to place it.</span>}
    </div>
  );
}

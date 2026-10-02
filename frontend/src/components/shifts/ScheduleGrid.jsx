// The week grid (Oct 2026, Teams parity, decluttered 10/02): rows 56px tall,
// a sticky day header and a sticky 180px person column, a group header with
// its hours and a collapse chevron (Add Members and ⋯ appear on hover), an
// Open Shifts row PER group, the today column tinted. A block is one calm
// line; click = the editor, right-click / long-press = the menu; there are
// no hover icons on a block any more. Cells and blocks are keyboard
// reachable: arrow keys move, Enter opens, Delete removes a draft.
// Everything the grid does goes through `on` - the container owns the data
// and the API calls.
import { Fragment } from 'react';
import { Plus, AlertTriangle, Lock, ChevronDown, ChevronRight, CalendarRange, StickyNote, MoreHorizontal } from 'lucide-react';
import { formatDate, formatMonthDay } from '../../lib/datetime';
import { Avatar } from '../ShiftScheduleExtras';
import { TeamMenu } from '../ShiftTeams';
import { ShiftBlock, TimeOffBlock, HolidayBlock, UsualHint } from './ShiftBlock';
import { isoDate, dayShort, fmtHrs, todayIso, planMinutes, counts } from './shiftLib';
import { availText } from '../shiftScheduleLib';

const ROW_H = 56;
const PERSON_W = 180;
const DAY_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export const TOOL_BTN = { width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid var(--line)',
  borderRadius: 5, background: 'var(--card)', color: 'var(--muted)', cursor: 'pointer', padding: 0 };
const STICKY_LEFT = { position: 'sticky', left: 0, zIndex: 2, background: 'var(--card)' };
const ELLIPSIS = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };

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

// The person cell every grid draws: photo, name, "40 Hrs" muted (red over
// 40), a lock for a row you can only view. `tools` sits at the right.
export function PersonCell({ emp, isMe, hrs, over = [], viewOnly = false, photos = true, onNow = false, tools, style, ...rest }) {
  return (
    <div {...rest} className="sched-person"
      style={{ padding: '6px 8px 6px 12px', display: 'flex', alignItems: 'center', gap: 7, minWidth: 0, ...style }}>
      {photos && (
        <span style={{ position: 'relative', flexShrink: 0, display: 'flex' }}>
          <Avatar name={emp.name} photoUrl={emp.photoUrl} size={26} />
          {onNow && <span title="On shift now" style={{ position: 'absolute', right: -1, bottom: -1, width: 9, height: 9, borderRadius: '50%', background: 'hsl(var(--color-green))', border: '2px solid var(--card)' }} />}
        </span>
      )}
      <span style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 12, fontWeight: isMe ? 800 : 700, color: isMe ? 'var(--wk-brand)' : undefined, ...ELLIPSIS }}>
          {emp.name}
          {isMe && <span style={{ fontSize: 9, fontWeight: 800, color: '#fff', background: 'var(--wk-brand)', borderRadius: 999, padding: '1px 5px', marginLeft: 5, letterSpacing: '.03em', verticalAlign: 'middle' }}>YOU</span>}
        </div>
        <div style={{ fontSize: 10.5, color: over.length ? 'hsl(var(--color-red))' : 'var(--muted)', fontWeight: over.length ? 800 : 500, display: 'flex', alignItems: 'center', gap: 3, whiteSpace: 'nowrap' }}
          title={over.length ? `Over 40 scheduled hours in a week (${over.map(fmtHrs).join(', ')})` : 'Paid hours this week'}>
          {over.length > 0 && <AlertTriangle size={10} aria-label="Over 40 hours" />}
          {fmtHrs(hrs)}{over.length > 0 && ' · Over 40'}
          {viewOnly && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, marginLeft: 4 }}><Lock size={9} /> View Only</span>}
        </div>
        {emp.availability?.length > 0 && (
          <div title={`Availability: ${availText(emp.availability)}`} style={{ fontSize: 10, color: 'hsl(var(--color-orange))', fontWeight: 600, ...ELLIPSIS }}>Limited Availability</div>
        )}
      </span>
      {tools && <span style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', display: 'inline-flex' }}>{tools}</span>}
    </div>
  );
}

// "Mon 28" bold, the month said once where the view enters it, and the
// day's "7 · 57 Hrs" muted under it. A day note shows with its icon; the
// add-note button only appears on hover of a day with no note.
export function DayHeader({ d, stats, isToday, isHol, note, canManage, compact, coarse, onOpen, onNote, style }) {
  const ds = isoDate(d);
  const month = (d.getDate() === 1 || stats?.first) ? formatMonthDay(d).replace(/ \d+$/, '') : '';
  return (
    <div role="columnheader" className="sched-hdr" style={{ padding: compact ? '6px 4px' : '7px 9px', borderLeft: '1px solid var(--line)', minWidth: 0,
      background: isToday ? 'var(--wk-brand-tint)' : isHol ? 'hsla(var(--color-blue),0.06)' : 'transparent', ...style }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 5, minWidth: 0 }}>
        <button type="button" onClick={onOpen} aria-label={`Open ${formatDate(ds)}`} title="Open this day"
          style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', minWidth: 0, display: 'inline-flex', alignItems: 'baseline', gap: 4,
            fontSize: compact ? 12 : 13.5, fontWeight: 800, color: isToday ? 'var(--wk-brand)' : 'var(--ink)', lineHeight: 1.2, whiteSpace: 'nowrap' }}>
          {compact ? d.getDate() : dayShort(d)}
          {month && !compact && <span style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--muted)' }}>{month}</span>}
        </button>
        {isHol && <span style={{ fontSize: 10, fontWeight: 700, color: 'hsl(var(--color-blue))', ...ELLIPSIS }}>Holiday</span>}
      </div>
      {stats && (
        <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 1, ...ELLIPSIS }}
          title={`${stats.shifts} shift${stats.shifts === 1 ? '' : 's'} · ${stats.people} ${stats.people === 1 ? 'person' : 'people'} · ${fmtHrs(stats.min)}`}>
          {compact ? (stats.shifts || '') : `${stats.shifts} · ${fmtHrs(stats.min)}`}
        </div>
      )}
      {!compact && (note || canManage) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 2, minWidth: 0 }}>
          {note ? (
            canManage ? (
              <button type="button" onClick={onNote} aria-label={`Edit the note for ${formatDate(ds)}`} title={note}
                style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 0, display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0, fontFamily: 'inherit',
                  fontSize: 10.5, fontWeight: 600, color: 'hsl(var(--color-orange))' }}>
                <StickyNote size={10} style={{ flexShrink: 0 }} /><span style={ELLIPSIS}>{note}</span>
              </button>
            ) : (
              <span title={note} style={{ fontSize: 10.5, fontWeight: 600, color: 'hsl(var(--color-orange))', display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
                <StickyNote size={10} style={{ flexShrink: 0 }} /><span style={ELLIPSIS}>{note}</span>
              </span>
            )
          ) : (
            <button type="button" className="hdr-tools" onClick={onNote} aria-label={`Add a note for ${formatDate(ds)}`} title="Add a day note"
              style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--muted)', padding: 0, display: 'inline-flex', opacity: coarse ? 1 : 0 }}>
              <StickyNote size={11} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default function ScheduleGrid({ days, compact, sections, byCell, openCells, offOn, holOn, availOn, usualOn, notes, holidayDates, me, prefs, teamZone,
  canManage, rowEditable, shiftEditable, empWeekMin, dayStats, weekMin, overWeeks, copied, dropKey, dragId, collapsed, on, dragProps, personDragProps, dropProps, dropStyle, hoverCell, hoverShift, clickable }) {
  const today = todayIso();
  const cols = `${PERSON_W}px repeat(${days.length}, minmax(${compact ? 48 : 120}px, 1fr))`;
  const GRID = { display: 'grid', gridTemplateColumns: cols };
  const gridMin = PERSON_W + days.length * (compact ? 50 : 120);
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
          onPointerDown={(e) => { dragProps(s).onPointerDown?.(e); on.longPress(e, { email, date: ds, groupId, shift: s }); }} />
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
        <div style={{ ...STICKY_LEFT, padding: '6px 8px 6px 12px', display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, borderRight: '1px solid var(--line)' }}>
          <span style={{ width: 28, height: 28, borderRadius: '50%', border: '1px dashed var(--line)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', flexShrink: 0 }}>
            <CalendarRange size={13} />
          </span>
          <span style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12.5, fontWeight: 700 }}>Open Shifts</div>
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
          <div style={{ ...STICKY_LEFT, zIndex: 4, background: 'var(--bg)', padding: '8px 12px', borderRight: '1px solid var(--line)', alignSelf: 'end', fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', whiteSpace: 'nowrap' }}
            title="Paid hours of the people shown. Open shifts are counted on their own row.">
            Week · {fmtHrs(weekMin)}
          </div>
          {days.map((d, i) => {
            const ds = isoDate(d);
            return (
              <DayHeader key={ds} d={d} stats={{ ...dayStats(d), first: i === 0 }} isToday={ds === today} isHol={holidayDates.has(ds)} note={notes[ds]}
                canManage={canManage} compact={compact} coarse={coarse} onOpen={() => on.openDay(ds)} onNote={() => on.noteEdit(ds)} />
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
              <div role="row" data-team={g.id || undefined} className="sched-group"
                style={{ ...GRID, background: 'var(--bg)', borderBottom: '1px solid var(--line)', borderTop: gi ? '1px solid var(--line)' : 'none',
                  ...(dropKey === `team:${g.id}` ? { outline: '2px dashed var(--wk-brand)', outlineOffset: -3, background: 'var(--wk-brand-tint)' } : {}) }}>
                <div style={{ padding: '5px 12px', gridColumn: '1 / -1', fontSize: 12.5, fontWeight: 800, display: 'flex', alignItems: 'center', gap: 8, position: 'sticky', left: 0, minHeight: 30 }}>
                  <button type="button" onClick={() => on.toggleCollapse(key)} aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} ${g.name}`}
                    style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--muted)', padding: 0, display: 'inline-flex' }}>
                    {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                  </button>
                  <span>{g.name}{g.archived ? ' (Archived)' : ''}</span>
                  <span style={{ color: 'var(--muted)', fontWeight: 600 }} title="Paid hours of this group's people this week">{fmtHrs(groupMin)} · {g.members.length} {g.members.length === 1 ? 'person' : 'people'}</span>
                  {g.id && g.canEdit && g.isGroup && (
                    <span className="group-tools" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, opacity: coarse ? 1 : 0 }}>
                      <button type="button" onClick={() => on.addMembers(g)}
                        style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--wk-brand)', fontSize: 11.5, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 3, padding: 0, fontFamily: 'inherit' }}>
                        <Plus size={12} /> Add Members
                      </button>
                      <TeamMenu team={g} canReorder={g.canReorder} onAction={(a) => on.teamAction(g, a)} />
                    </span>
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
                    <PersonCell emp={{ ...emp, availability: prefs.availability !== false ? emp.availability : [] }} isMe={isMe} hrs={empWeekMin(emp.email)} over={over}
                      data-person={emp.email}
                      viewOnly={!editable && canManage} photos={prefs.photos !== false}
                      {...(personDragProps ? personDragProps(emp, g) : {})}
                      style={{ ...STICKY_LEFT, background: isMe ? 'var(--wk-brand-tint)' : 'var(--card)', borderRight: '1px solid var(--line)', boxShadow: isMe ? 'inset 3px 0 0 var(--wk-brand)' : 'none',
                        ...(personDragProps ? personDragProps(emp, g).style : {}) }}
                      tools={canManage && editable ? (
                        <button type="button" className="person-tools" aria-label={`Options for ${emp.name}`} title="Options"
                          onClick={(e) => { e.stopPropagation(); on.personMenu(e, emp, g); }}
                          style={{ ...TOOL_BTN, flexShrink: 0, opacity: coarse ? 1 : 0 }}><MoreHorizontal size={12} /></button>
                      ) : null} />
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
                              style={{ fontSize: 10, color: 'hsl(var(--color-orange))', fontWeight: 600, padding: '0 6px 4px', ...ELLIPSIS, position: 'relative' }}>
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

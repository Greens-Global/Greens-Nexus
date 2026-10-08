// The week grid engine (redesigned from scratch 10/02 - "wtf is this
// alignment", the owner on the production screen). ONE CSS grid holds the
// whole week: a 200px person column and one column per day, explicit rows,
// and every cell of every row placed in that same grid, so all the cells of
// a row are the same height by construction and every block sits at the top
// of its cell. Rows are `display: contents` wrappers - they carry the ARIA
// row and the data-* hooks, never a box of their own.
//
// - Today is one background token on each cell of its column; weekend
//   columns a faint gray. The header row and the person column are sticky.
// - Empty cells are empty. A person's usual hours are one muted line under
//   their name, never a hint in the cells.
// - Time off across consecutive days is ONE pill spanning those columns
//   ("Vacation · Mon 28 - Thu 1"), clipped at the week edge with a chevron;
//   a requested one is dashed. A partial day stays in its cell beside the
//   shift ("2:00p - 4:00p Medical").
// - Groups with no shifts in view start collapsed (the container remembers
//   the choice per user); the Open Shifts row shows only when the group has
//   open shifts, or slim (36px) for a manager.
//
// Used by the manager Schedule (ShiftSchedule.jsx, week and two weeks) and
// the My Shifts group grid (TeamShiftGrid.jsx). Everything it does goes
// through `on`; without `on` the grid is read-only.
import { Fragment } from 'react';
import { Plus, AlertTriangle, Lock, ChevronDown, ChevronRight, ChevronLeft, CalendarRange, CalendarDays, StickyNote, MoreHorizontal } from 'lucide-react';
import { formatDate, formatMonthDay } from '../../lib/datetime';
import { Avatar } from '../ShiftScheduleExtras';
import { TeamMenu } from '../ShiftTeams';
import { timeOffLabel, availText } from '../shiftScheduleLib';
import { ShiftBlock, TimeOffBlock, HolidayBlock } from './ShiftBlock';
import { isoDate, dayShort, fmtHrs, todayIso, planMinutes, counts, isAllDayOff, isApprovedOff, shiftShortText, parseIso, sectionKey } from './shiftLib';

export const PERSON_W = 200;
const ROW_MIN = 52;
const SLIM = 36;
const PILL_H = 22;
const PILL_GAP = 4;
const PAD = 6;
// The two column tokens. Today wins over a weekend.
export const TODAY_BG = 'color-mix(in srgb, var(--wk-brand) 7%, transparent)';
export const WEEKEND_BG = 'rgba(100,116,139,0.045)';
const ROSE_BG = 'hsla(var(--color-red),0.08)';
const ROSE_LINE = 'hsla(var(--color-red),0.32)';
const ROSE_INK = 'hsl(var(--color-red))';
const LINE = '1px solid var(--line)';
const ELLIPSIS = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const DAY_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export const TOOL_BTN = { width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', border: LINE,
  borderRadius: 6, background: 'var(--card)', color: 'var(--muted)', cursor: 'pointer', padding: 0 };
const isWeekend = (d) => d.getDay() === 0 || d.getDay() === 6;
const colBg = (d, today) => { const ds = isoDate(d); return ds === today ? TODAY_BG : isWeekend(d) ? WEEKEND_BG : undefined; };
// An opaque background for sticky header cells: the column tint over the card.
const solid = (tint) => (tint ? `linear-gradient(${tint}, ${tint}), var(--card)` : 'var(--card)');

// Arrow keys between cells; Enter opens; Delete removes a draft.
export function gridKeys(e, on) {
  const t = e.target;
  const block = t.closest?.('[data-shift]');
  const cell = t.closest?.('[data-cell]');
  if (!cell || !on) return;
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

// The person cell: 32px photo, the name bold with "You" after it for the
// signed-in person (and a 3px brand bar on the left - never a row tint),
// "9 Hrs" muted ("48 Hrs · over 40" in amber), and their usual hours as one
// muted line. Day view uses it too.
export function PersonCell({ emp, isMe = false, hrs, over = [], viewOnly = false, photos = true, onNow = false, usual = null, tools, style, ...rest }) {
  const limited = emp.availability?.length > 0;
  return (
    <div {...rest} className="sched-person"
      style={{ padding: `${PAD + 2}px ${tools ? 30 : 10}px ${PAD}px 14px`, display: 'flex', alignItems: 'flex-start', gap: 10, minWidth: 0, position: 'relative',
        boxShadow: isMe ? 'inset 3px 0 0 var(--wk-brand)' : 'none', ...style }}>
      {photos && (
        <span style={{ position: 'relative', flexShrink: 0, display: 'flex' }}>
          <Avatar name={emp.name} photoUrl={emp.photoUrl} size={32} />
          {onNow && <span title="On shift now" style={{ position: 'absolute', right: -1, bottom: -1, width: 10, height: 10, borderRadius: '50%', background: 'hsl(var(--color-green))', border: '2px solid var(--card)' }} />}
        </span>
      )}
      <span style={{ minWidth: 0, flex: 1, lineHeight: 1.35 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)', ...ELLIPSIS }}>{emp.name}</span>
          {isMe && <span style={{ fontWeight: 600, color: 'var(--wk-brand)', fontSize: 12, flexShrink: 0 }}>You</span>}
        </div>
        <div style={{ fontSize: 11.5, color: over.length ? 'hsl(var(--color-orange))' : 'var(--muted)', fontWeight: over.length ? 700 : 500, display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}
          title={over.length ? `Over 40 scheduled hours in a week (${over.map(fmtHrs).join(', ')})` : 'Paid hours this week'}>
          {over.length > 0 && <AlertTriangle size={11} aria-label="Over 40 hours" />}
          {fmtHrs(hrs)}{over.length > 0 && ' · over 40'}
          {viewOnly && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, marginLeft: 4 }}><Lock size={10} /> View Only</span>}
        </div>
        {usual && (
          <div title="Their usual hours (shift type). Fill From Usual Hours places them." style={{ fontSize: 11, color: 'var(--muted)', ...ELLIPSIS }}>
            Usual {shiftShortText(usual)}
          </div>
        )}
        {limited && (
          <div title={`Availability: ${availText(emp.availability)}`} style={{ fontSize: 11, color: 'hsl(var(--color-orange))', fontWeight: 600, ...ELLIPSIS }}>Limited Availability</div>
        )}
      </span>
      {tools && <span style={{ position: 'absolute', right: 6, top: PAD + 2, display: 'inline-flex' }}>{tools}</span>}
    </div>
  );
}

// A day header: "Mon 28" bold (the month said once, where the view enters
// it), "8 · 65 Hrs" muted under it, a note icon whose text is the hover.
export function DayHeader({ d, stats, isToday, isHol, note, canManage, compact, coarse, onOpen, onNote, coverage = null, style, ...rest }) {
  const ds = isoDate(d);
  const month = (d.getDate() === 1 || stats?.first) ? formatMonthDay(d).replace(/ \d+$/, '') : '';
  const noteIcon = note ? (
    canManage && onNote ? (
      <button type="button" onClick={onNote} aria-label={`Edit the note for ${formatDate(ds)}`} title={note}
        style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 0, display: 'inline-flex', color: 'hsl(var(--color-orange))', flexShrink: 0 }}>
        <StickyNote size={13} /><span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>{note}</span>
      </button>
    ) : (
      <span title={note} aria-label={`Note: ${note}`} style={{ display: 'inline-flex', color: 'hsl(var(--color-orange))', flexShrink: 0 }}><StickyNote size={13} /></span>
    )
  ) : canManage && onNote && !compact ? (
    <button type="button" className="hdr-tools" onClick={onNote} aria-label={`Add a note for ${formatDate(ds)}`} title="Add a day note"
      style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--muted)', padding: 0, display: 'inline-flex', opacity: coarse ? 1 : 0, flexShrink: 0 }}>
      <StickyNote size={13} />
    </button>
  ) : null;
  return (
    <div {...rest} role="columnheader" className="sched-hdr" style={{ padding: compact ? '8px 5px' : '9px 10px', borderLeft: LINE, borderBottom: LINE, minWidth: 0, ...style }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
        <button type="button" onClick={onOpen} disabled={!onOpen} aria-label={`Open ${formatDate(ds)}`} title={onOpen ? 'Open this day' : undefined}
          style={{ border: 'none', background: 'none', padding: 0, cursor: onOpen ? 'pointer' : 'default', fontFamily: 'inherit', minWidth: 0, display: 'inline-flex', alignItems: 'baseline', gap: 4,
            fontSize: compact ? 12 : 13, fontWeight: 700, color: isToday ? 'var(--wk-brand)' : 'var(--ink)', lineHeight: 1.3, whiteSpace: 'nowrap' }}>
          {compact ? d.getDate() : dayShort(d)}
          {month && !compact && <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--muted)' }}>{month}</span>}
        </button>
        {isHol && !compact && <span style={{ fontSize: 10.5, fontWeight: 700, color: 'hsl(var(--color-blue))', ...ELLIPSIS }}>Holiday</span>}
        <span style={{ flex: 1 }} />
        {noteIcon}
      </div>
      {stats && (
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 1, ...ELLIPSIS }}
          title={`${stats.shifts} shift${stats.shifts === 1 ? '' : 's'} · ${stats.people} ${stats.people === 1 ? 'person' : 'people'} · ${fmtHrs(stats.min)}`}>
          {compact ? (stats.shifts || '') : `${stats.shifts} · ${fmtHrs(stats.min)}`}
        </div>
      )}
      {coverage && <div style={{ marginTop: 6 }}>{coverage}</div>}
    </div>
  );
}

// The pills of a person's all-day time off this view: one per entry and run
// of consecutive columns, each on a lane so two never overlap.
export function timeOffSpans(days, offOn, email) {
  const byKey = new Map();
  const partial = {};
  days.forEach((d, c) => {
    const ds = isoDate(d);
    offOn(email, ds).forEach((t) => {
      if (!isAllDayOff(t)) { (partial[ds] ||= []).push(t); return; }
      const k = t.id || `${t.startDate}|${t.endDate}|${t.type}|${t.status}`;
      if (!byKey.has(k)) byKey.set(k, { t, cols: [] });
      byKey.get(k).cols.push(c);
    });
  });
  const spans = [];
  byKey.forEach(({ t, cols }) => {
    let run = [cols[0]];
    const flush = () => spans.push({ t, c0: run[0], n: run.length });
    for (let i = 1; i < cols.length; i += 1) {
      if (cols[i] === run[run.length - 1] + 1) run.push(cols[i]);
      else { flush(); run = [cols[i]]; }
    }
    flush();
  });
  spans.sort((a, b) => a.c0 - b.c0 || b.n - a.n);
  const laneEnd = [];
  spans.forEach((s) => {
    let lane = laneEnd.findIndex((end) => end < s.c0);
    if (lane < 0) { lane = laneEnd.length; laneEnd.push(0); }
    laneEnd[lane] = s.c0 + s.n - 1;
    s.lane = lane;
  });
  const lanesAt = days.map((_, c) => spans.reduce((m, s) => (c >= s.c0 && c < s.c0 + s.n ? Math.max(m, s.lane + 1) : m), 0));
  return { spans, partial, lanesAt };
}

// "Vacation · Mon 28 - Thu 1" - the short type and the whole range, said
// once across the days it covers.
export function TimeOffPill({ t, days, c0, n, lane, row, compact = false }) {
  const approved = isApprovedOff(t);
  const type = t.confidential ? 'Time Off' : (t.type ? timeOffLabel(t.type) : 'Time Off');
  const multi = t.startDate && t.endDate && t.startDate !== t.endDate;
  const range = multi ? `${dayShort(parseIso(t.startDate))} - ${dayShort(parseIso(t.endDate))}` : '';
  const first = isoDate(days[c0]);
  const last = isoDate(days[c0 + n - 1]);
  const before = !!t.startDate && t.startDate < first;
  const after = !!t.endDate && t.endDate > last;
  const fullRange = multi ? `${formatDate(t.startDate)} - ${formatDate(t.endDate)}` : formatDate(t.startDate || first);
  const title = [type, approved ? 'Approved' : 'Requested', fullRange, !t.confidential ? t.note : ''].filter(Boolean).join('\n');
  return (
    <div data-timeoff={t.id || undefined} className="sched-span" title={title} aria-label={`${approved ? '' : 'Requested '}${type}, ${fullRange}`}
      style={{ gridRow: row, gridColumn: `${c0 + 2} / span ${n}`, alignSelf: 'start', margin: `${PAD + lane * (PILL_H + PILL_GAP)}px ${PAD}px 0`, height: PILL_H, zIndex: 1,
        boxSizing: 'border-box', minWidth: 0, display: 'flex', alignItems: 'center', gap: 4, padding: compact ? '0 4px' : '0 8px', borderRadius: 6,
        background: ROSE_BG, border: `1px ${approved ? 'solid' : 'dashed'} ${ROSE_LINE}`, color: ROSE_INK, fontSize: compact ? 10.5 : 11.5, fontWeight: 700 }}>
      {before && <ChevronLeft size={12} aria-label="Continues from last week" style={{ flexShrink: 0, marginLeft: -2 }} />}
      <span style={{ ...ELLIPSIS, minWidth: 0 }}>{type}{range && !compact ? <span style={{ fontWeight: 500 }}> · {range}</span> : null}</span>
      {t.confidential && <Lock size={10} aria-label="Confidential" style={{ flexShrink: 0 }} />}
      {after && <ChevronRight size={12} aria-label="Continues next week" style={{ flexShrink: 0, marginLeft: 'auto', marginRight: -2 }} />}
    </div>
  );
}

// Coverage (10/02): "3 of 4 on" and a thin bar per day - expected = people
// whose usual hours work that weekday and who are not off; on = people with
// a shift. Met reads muted green, one short amber, two or more red. A short
// day's chip points at the missing people's empty cells.
const COVER_TONE = { met: 'hsl(var(--color-green))', short1: 'hsl(var(--color-orange))', short2: 'hsl(var(--color-red))' };
export function CoverageChip({ c, compact = false, onShort }) {
  if (!c || c.tone === 'none') return <span aria-hidden="true" data-coverage="none" style={{ display: 'block', height: compact ? 14 : 18 }} />;
  const color = COVER_TONE[c.tone];
  const pct = c.expected ? Math.min(1, c.on / c.expected) : 1;
  const tip = [c.missing.length ? `Missing: ${c.missing.map((m) => m.name).join(', ')}` : c.expected ? 'Everyone expected is on' : 'Nobody is expected (no usual hours this day)',
    c.off.length ? `Off: ${c.off.map((m) => m.name).join(', ')}` : ''].filter(Boolean).join('\n');
  const short = c.short > 0 && !!onShort;
  return (
    <button type="button" data-coverage={c.tone} onClick={short ? (e) => { e.stopPropagation(); onShort(c); } : undefined} title={tip} disabled={!short}
      aria-label={`${c.expected ? `${c.on} of ${c.expected}` : c.on} on. ${tip.replace(/\n/g, '. ')}`}
      style={{ display: 'block', width: '100%', border: 'none', background: 'none', padding: 0, cursor: short ? 'pointer' : 'default', fontFamily: 'inherit', textAlign: 'left', minWidth: 0 }}>
      <span style={{ display: 'flex', alignItems: 'baseline', gap: 4, fontSize: compact ? 10 : 10.5, fontWeight: 700, color: c.tone === 'met' ? 'var(--muted)' : color, whiteSpace: 'nowrap', overflow: 'hidden' }}>
        {c.expected ? `${c.on} of ${c.expected}` : c.on}{!compact && <span style={{ fontWeight: 500 }}>on</span>}
      </span>
      <span aria-hidden="true" style={{ display: 'block', height: 3, borderRadius: 2, background: 'var(--line)', marginTop: 2, overflow: 'hidden' }}>
        <span style={{ display: 'block', height: '100%', width: '100%', transformOrigin: 'left', transform: `scaleX(${pct})`, background: c.tone === 'met' ? 'color-mix(in srgb, hsl(var(--color-green)) 55%, transparent)' : color, borderRadius: 2 }} />
      </span>
    </button>
  );
}

export default function WeekGrid({ days, compact = false, sections, byCell, openCells, offOn, holOn = () => null, availOn = () => null, usualOf = () => null,
  notes = {}, holidayDates = new Set(), me = '', prefs = {}, teamZone = '', canManage = false,
  rowEditable = () => false, empWeekMin, dayStats, weekMin, overWeeks = () => [], copied = null, dropKey = '', dragId = '',
  isCollapsed = () => false, on = null, dragProps = () => ({}), personDragProps = null, dropProps = () => ({}), dropStyle = () => ({}),
  hoverCell = () => ({}), hoverShift = () => ({}), clickable = (fn) => fn, onNowOf = () => false, blockChildren = null,
  ariaRole = 'grid', ariaLabel = 'Schedule', notesRow = false, maxHeight = 'calc(100vh - 150px)',
  single = false, emptyNote = null, cornerTools = null, ghostOf = () => null, blockClass = () => '', motion = true, glowToday = false,
  personFill = null, usualCan = () => false, coverageOf = null, onCoverage = null, pulseCells = null, conflictCount = 0, onConflicts = null }) {
  const today = todayIso();
  const n = days.length;
  const coarse = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)')?.matches;
  const cellRole = ariaRole === 'grid' ? 'gridcell' : 'cell';
  const rows = [];          // grid-template-rows, one entry per grid row
  const out = [];
  let line = 0;
  let kr = 0;               // keyboard row index across person and open rows
  const addRow = (size) => { rows.push(size); line += 1; return line; };

  const cellStyle = (row, c, d, extra) => ({ gridRow: row, gridColumn: c + 2, borderLeft: LINE, borderBottom: LINE, minWidth: 0, position: 'relative', outline: 'none',
    background: colBg(d, today), padding: compact ? 3 : PAD, display: 'flex', flexDirection: 'column', gap: 4, ...extra });
  const stickyLeft = (row, extra) => ({ gridRow: row, gridColumn: 1, position: 'sticky', left: 0, zIndex: 2, background: 'var(--card)', borderRight: LINE, borderBottom: LINE, minWidth: 0, ...extra });

  const block = (s, email, ds, groupId) => (
    <ShiftBlock key={s.id} shift={s} open={!email} compact={compact} teamZone={teamZone} tabIndex={-1} dragging={dragId === s.id} className={blockClass(s)}
      showConflicts={prefs.conflicts !== false} style={{ marginBottom: 0 }}
      {...(on ? {
        onOpen: (e) => on.openShift(e, s, email, ds),
        dragProps: dragProps(s), ...hoverShift(s),
        onContextMenu: (e) => on.menu(e, { email, date: ds, groupId, shift: s }),
        onPointerDown: (e) => { dragProps(s).onPointerDown?.(e); on.longPress(e, { email, date: ds, groupId, shift: s }); },
      } : {})}>
      {blockChildren?.(s, { email, ds })}
    </ShiftBlock>
  );

  // One day cell. `top` is the room kept for the time-off pills above it.
  const dayCell = (row, email, d, c, groupId, items, r, editable, inner = null, top = 0) => {
    const ds = isoDate(d);
    const ghost = !items.length && editable && on && email ? ghostOf(email, ds) : null;
    const handlers = on ? {
      onClick: clickable((e) => { if (!items.length && editable) on.cellClick(email, ds, groupId, e); }),
      ...dropProps(email, ds), ...(editable ? hoverCell(email, ds, groupId) : {}),
      onContextMenu: (e) => on.menu(e, { email, date: ds, groupId, shift: null }),
      onPointerDown: (e) => on.longPress(e, { email, date: ds, groupId, shift: null }),
    } : {};
    return (
      <div key={ds} data-cell={`${email}|${ds}`} data-r={r} data-c={c} data-group={groupId || undefined} data-today={ds === today ? '' : undefined} tabIndex={on ? (r === 0 && c === 0 ? 0 : -1) : undefined} role={cellRole}
        title={ghost ? `Click to place ${shiftShortText(ghost)}${ghost.code ? ` ${ghost.code}` : ''} (their usual hours). Shift+click opens the editor.` : undefined}
        aria-label={`${email ? '' : 'Open shifts '}${formatDate(ds)}${items.length ? `, ${items.length} shift${items.length === 1 ? '' : 's'}` : ', empty'}`}
        className={`sched-cell${pulseCells?.has(`${email}|${ds}`) ? ' m-pulse-cell' : ''}`} {...handlers}
        style={cellStyle(row, c, d, { cursor: on && !items.length && editable ? 'pointer' : 'default', paddingTop: (compact ? 3 : PAD) + top, ...(on ? dropStyle(email, ds) : {}) })}>
        {inner}
        {items.map((s) => block(s, email, ds, groupId))}
        {!items.length && editable && on && (ghost ? (
          <div className="sched-add" data-ghost="" aria-hidden="true" style={{ position: 'absolute', left: compact ? 3 : PAD, right: compact ? 3 : PAD, top: (compact ? 3 : PAD) + top, opacity: 0, pointerEvents: 'none' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: compact ? '2px 4px' : '4px 8px', borderRadius: 6, border: `1px dashed ${ghost.color || 'var(--wk-line2, var(--line))'}`,
              borderLeft: `3px solid ${ghost.color || 'var(--muted)'}`, background: 'color-mix(in srgb, var(--card) 70%, transparent)', color: 'var(--muted)', fontSize: compact ? 10 : 11.5, fontWeight: 700, ...ELLIPSIS, opacity: 0.85 }}>
              <Plus size={11} style={{ flexShrink: 0 }} />
              <span style={ELLIPSIS}>{shiftShortText(ghost)}{ghost.code ? <span style={{ color: ghost.color || 'var(--muted)', marginLeft: 4 }}>{ghost.code}</span> : null}</span>
            </div>
          </div>
        ) : (
          <div className="sched-add" aria-hidden="true" style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', opacity: 0, pointerEvents: 'none' }}>
            <Plus size={16} />
          </div>
        ))}
      </div>
    );
  };

  // ── Header row ─────────────────────────────────────────────────────────
  // One team on screen: its coverage rides in the sticky header.
  const headCover = coverageOf && single && sections.length === 1 ? coverageOf(sections[0]) : null;
  const hr = addRow('auto');
  out.push(
    <div key="hdr" role="row" style={{ display: 'contents' }}>
      <div style={{ gridRow: hr, gridColumn: 1, position: 'sticky', top: 0, left: 0, zIndex: 4, background: 'var(--card)', borderRight: LINE, borderBottom: LINE,
        padding: '9px 14px', display: 'flex', alignItems: 'flex-end', gap: 6, fontSize: 12, fontWeight: 700, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
        <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {conflictCount > 0 && (
            <button type="button" data-conflict-link="" onClick={onConflicts || undefined} disabled={!onConflicts} title="Go to the first one"
              style={{ alignSelf: 'flex-start', border: 'none', background: 'hsla(var(--color-orange),0.12)', color: 'hsl(var(--color-orange))', borderRadius: 999, padding: '1px 8px',
                fontFamily: 'inherit', fontSize: 11, fontWeight: 700, cursor: onConflicts ? 'pointer' : 'default', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: '50%', background: 'hsl(var(--color-orange))' }} />
              {conflictCount} conflict{conflictCount === 1 ? '' : 's'}
            </button>
          )}
          <span title="Paid hours of the people shown. Open shifts are counted on their own row.">Week · {fmtHrs(weekMin)}</span>
          {headCover && <span style={{ fontSize: 10.5, fontWeight: 600 }} title="Expected = usual hours on that weekday, minus anyone off. On = anyone with a shift.">Coverage</span>}
        </span>
        {cornerTools}
      </div>
      {days.map((d, i) => {
        const ds = isoDate(d);
        return (
          <DayHeader key={ds} data-today={ds === today ? '' : undefined} d={d} stats={{ ...dayStats(d), first: i === 0 }} isToday={ds === today} isHol={holidayDates.has(ds)} note={notes[ds]}
            canManage={canManage} compact={compact} coarse={coarse} onOpen={on ? () => on.openDay(ds) : undefined} onNote={on ? () => on.noteEdit(ds) : undefined}
            coverage={headCover ? <CoverageChip c={headCover[i]} compact={compact} onShort={onCoverage} /> : null}
            style={{ gridRow: hr, gridColumn: i + 2, position: 'sticky', top: 0, zIndex: 3, background: solid(colBg(d, today)) }} />
        );
      })}
    </div>,
  );

  // ── Day notes (My Shifts: only when a note exists) ─────────────────────
  if (notesRow && days.some((d) => notes[isoDate(d)])) {
    const nr = addRow('auto');
    out.push(
      <div key="notes" role="row" style={{ display: 'contents' }}>
        <div style={stickyLeft(nr, { padding: '7px 14px', fontSize: 11.5, fontWeight: 600, color: 'var(--muted)' })}>Day Notes</div>
        {days.map((d, c) => {
          const note = notes[isoDate(d)];
          return (
            <div key={isoDate(d)} role={cellRole} title={note || undefined}
              style={cellStyle(nr, c, d, { display: 'block', padding: '7px 10px', fontSize: 11.5, fontWeight: 600, color: 'hsl(var(--color-orange))', ...ELLIPSIS })}>
              {note || ''}
            </div>
          );
        })}
      </div>,
    );
  }

  // ── A team with nothing this week: one friendly row ─────────────────────
  if (emptyNote) {
    const er = addRow('auto');
    out.push(<div key="empty-team" data-empty-team="" style={{ gridRow: er, gridColumn: '1 / -1', borderBottom: LINE, minWidth: 0 }}>{emptyNote}</div>);
  }

  // ── Open Shifts row ────────────────────────────────────────────────────
  const openRow = (g) => {
    const gid = g.id || '';
    const items = (ds) => openCells[`${gid}|${ds}`] || [];
    const any = days.some((d) => items(isoDate(d)).length);
    const row = addRow(any ? `minmax(${ROW_MIN}px, auto)` : `minmax(${SLIM}px, auto)`);
    const r = kr++;
    const min = days.reduce((a, d) => a + items(isoDate(d)).filter(counts).reduce((b, s) => b + planMinutes(s), 0), 0);
    const cnt = days.reduce((a, d) => a + items(isoDate(d)).filter(counts).reduce((b, s) => b + (s.openSlots || 1), 0), 0);
    const editable = rowEditable('');
    return (
      <div key={`open-${gid}`} role="row" data-open-row={gid || 'all'} data-member="open" data-ri={r} style={{ display: 'contents', '--ri': r }}>
        <div style={stickyLeft(row, { padding: any ? `${PAD + 2}px 10px ${PAD}px 14px` : '0 10px 0 14px', display: 'flex', alignItems: any ? 'flex-start' : 'center', gap: 10 })}>
          <span style={{ width: any ? 32 : 22, height: any ? 32 : 22, borderRadius: '50%', border: '1px dashed var(--wk-line2, var(--line))', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', flexShrink: 0 }}>
            <CalendarRange size={any ? 14 : 11} />
          </span>
          {any ? (
            <span style={{ minWidth: 0, lineHeight: 1.35 }}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>Open Shifts</div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{cnt} open · {fmtHrs(min)}</div>
            </span>
          ) : (
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)' }}>Open Shifts</span>
          )}
        </div>
        {days.map((d, c) => dayCell(row, '', d, c, gid, items(isoDate(d)), r, editable, null, 0))}
      </div>
    );
  };
  if (openCells.__ungrouped) out.push(openRow({ id: '' }));

  if (!sections.length) {
    const er = addRow('auto');
    out.push(<div key="empty" style={{ gridRow: er, gridColumn: '1 / -1', padding: 24, textAlign: 'center', fontSize: 12.5, color: 'var(--muted)' }}>Nobody is on the schedule in this view.</div>);
  }

  // ── Groups ─────────────────────────────────────────────────────────────
  sections.forEach((g, gi) => {
    const key = sectionKey(g);
    const collapsed = !single && isCollapsed(key);
    const groupMin = g.members.reduce((a, m) => a + empWeekMin(m.email), 0);
    const hasOpen = days.some((d) => (openCells[`${g.id || ''}|${isoDate(d)}`] || []).length);
    const hasShifts = hasOpen || g.members.some((m) => days.some((d) => (byCell[`${m.email}|${isoDate(d)}`] || []).length));
    const people = `${g.members.length} ${g.members.length === 1 ? 'person' : 'people'}`;
    if (single) {
      if (g.isGroup && prefs.open !== false && (hasOpen || canManage)) out.push(openRow(g));
    } else {
    const gr = addRow(`minmax(${SLIM}px, auto)`);
    out.push(
      <div key={`g-${key}`} role="row" data-team={g.id || undefined} style={{ display: 'contents' }}>
        <div className="sched-group" style={{ gridRow: gr, gridColumn: '1 / -1', background: 'var(--bg)', borderBottom: LINE, borderTop: gi ? LINE : 'none', display: 'flex', alignItems: 'center', minWidth: 0,
          ...(dropKey === `team:${g.id}` ? { outline: '2px dashed var(--wk-brand)', outlineOffset: -3, background: 'var(--wk-brand-tint)' } : {}) }}>
          <div style={{ position: 'sticky', left: 0, display: 'inline-flex', alignItems: 'center', gap: 8, padding: '0 14px 0 8px', minHeight: SLIM, maxWidth: '100%', minWidth: 0 }}>
            {on?.toggleCollapse ? (
              <button type="button" onClick={() => on.toggleCollapse(key)} aria-expanded={!collapsed} aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${g.name}`}
                style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--muted)', padding: 4, display: 'inline-flex', borderRadius: 6 }}>
                {collapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
              </button>
            ) : <span style={{ width: 6 }} />}
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)', whiteSpace: 'nowrap' }}>{g.name}{g.archived ? ' (Archived)' : ''}</span>
            <span style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }} title="Paid hours of this group's people this week">
              {hasShifts ? `${fmtHrs(groupMin)} · ${people}` : `${people} · no shifts this ${n > 7 ? 'view' : 'week'}`}
            </span>
            {on && g.id && g.canEdit && g.isGroup && (
              <span className="group-tools" style={{ display: 'inline-flex', alignItems: 'center', gap: 10, marginLeft: 6, opacity: coarse ? 1 : 0 }}>
                <button type="button" onClick={() => on.addMembers(g)}
                  style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--wk-brand)', fontSize: 12, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 3, padding: 0, fontFamily: 'inherit', whiteSpace: 'nowrap' }}>
                  <Plus size={12} /> Add Members
                </button>
                <TeamMenu team={g} canReorder={g.canReorder} onAction={(a) => on.teamAction(g, a)} />
              </span>
            )}
          </div>
        </div>
      </div>,
    );
    if (collapsed) return;
    const cov = coverageOf && g.members.length ? coverageOf(g) : null;
    if (cov && cov.some((c) => c.tone !== 'none')) {
      const cr = addRow('auto');
      out.push(
        <div key={`cov-${key}`} role="row" data-coverage-row={g.id || 'all'} style={{ display: 'contents' }}>
          <div style={stickyLeft(cr, { padding: '5px 14px', fontSize: 11, fontWeight: 600, color: 'var(--muted)', display: 'flex', alignItems: 'center' })}>Coverage</div>
          {days.map((d, c) => (
            <div key={isoDate(d)} role={cellRole} style={cellStyle(cr, c, d, { padding: compact ? '4px 4px' : '5px 10px' })}>
              <CoverageChip c={cov[c]} compact={compact} onShort={onCoverage} />
            </div>
          ))}
        </div>,
      );
    }
    if (g.isGroup && prefs.open !== false && (hasOpen || canManage)) out.push(openRow(g));
    }
    if (!g.members.length) {
      const er = addRow('auto');
      out.push(<div key={`none-${key}`} style={{ gridRow: er, gridColumn: '1 / -1', padding: '10px 14px', fontSize: 12, color: 'var(--muted)', borderBottom: LINE }}>Nobody in this group yet.</div>);
    }
    g.members.forEach((emp) => {
      const row = addRow(`minmax(${ROW_MIN}px, auto)`);
      const r = kr++;
      const editable = rowEditable(emp.email);
      const isMe = !!me && emp.email === me;
      const { spans, partial, lanesAt } = timeOffSpans(days, offOn, emp.email);
      const pdp = personDragProps ? personDragProps(emp, g) : {};
      out.push(
        <Fragment key={`p-${key}-${emp.email}`}>
          <div role="row" data-member={emp.email} aria-current={isMe ? 'true' : undefined} data-ri={r} style={{ display: 'contents', '--ri': r }}>
            <PersonCell role="rowheader" emp={{ ...emp, availability: prefs.availability !== false ? emp.availability : [] }} isMe={isMe} hrs={empWeekMin(emp.email)} over={overWeeks(emp.email)}
              data-person={emp.email} usual={usualOf(emp.email)} onNow={onNowOf(emp.email)}
              viewOnly={!editable && canManage} photos={prefs.photos !== false}
              {...pdp}
              style={{ ...stickyLeft(row), boxShadow: isMe ? 'inset 3px 0 0 var(--wk-brand)' : 'none', ...(pdp.style || {}) }}
              tools={on && canManage && editable ? (
                <span className="person-tools" style={{ display: 'inline-flex', flexDirection: 'column', gap: 4, opacity: coarse ? 1 : 0 }}>
                  <button type="button" aria-label={`Options for ${emp.name}`} title="Options"
                    onClick={(e) => { e.stopPropagation(); on.personMenu(e, emp, g); }}
                    style={{ ...TOOL_BTN, flexShrink: 0 }}><MoreHorizontal size={13} /></button>
                  {personFill && usualCan(emp.email) && (
                    <button type="button" aria-label={`Fill usual hours for ${emp.name}`} title="Fill Usual Hours - their usual shift on every free day in view"
                      onClick={(e) => { e.stopPropagation(); personFill(emp); }}
                      style={{ ...TOOL_BTN, flexShrink: 0, color: 'var(--wk-brand)' }}><CalendarDays size={12} /></button>
                  )}
                </span>
              ) : null} />
            {days.map((d, c) => {
              const ds = isoDate(d);
              const items = byCell[`${emp.email}|${ds}`] || [];
              const hol = holOn(emp.email, ds);
              const av = availOn(emp.email, d);
              const offHere = offOn(emp.email, ds);
              const inner = (
                <>
                  {av?.kind === 'unavailable' && !offHere.length && !hol && (
                    <div title={`${emp.name} is unavailable on ${DAY_LONG[(d.getDay() + 6) % 7]}s`} aria-label="Unavailable"
                      style={{ position: 'absolute', inset: 0, background: 'repeating-linear-gradient(135deg, hsla(var(--color-orange),0.10) 0 6px, transparent 6px 12px)', pointerEvents: 'none' }} />
                  )}
                  {hol && <HolidayBlock holiday={hol} compact={compact} style={{ marginBottom: 0 }} />}
                  {(partial[ds] || []).map((t, i) => <TimeOffBlock key={t.id || i} off={t} compact={compact} style={{ marginBottom: 0 }} />)}
                </>
              );
              const top = lanesAt[c] ? lanesAt[c] * (PILL_H + PILL_GAP) : 0;
              return dayCell(row, emp.email, d, c, g.id || '', items, r, editable, inner, top);
            })}
            {spans.map((s) => <TimeOffPill key={`${s.t.id || s.t.startDate}-${s.c0}`} t={s.t} days={days} c0={s.c0} n={s.n} lane={s.lane} row={row} compact={compact} />)}
          </div>
        </Fragment>,
      );
    });
  });

  return (
    <div role={ariaRole} aria-label={ariaLabel} onKeyDown={on ? (e) => gridKeys(e, on) : undefined} onDragStart={(e) => e.preventDefault()}
      className={`week-grid${motion ? ' m-stagger' : ''}${glowToday && motion ? ' m-today-glow' : ''}`}
      style={{ overflow: 'auto', border: LINE, borderRadius: 12, maxHeight, userSelect: on ? 'none' : undefined, WebkitUserSelect: on ? 'none' : undefined, background: 'var(--card)', position: 'relative' }}>
      <div data-week-grid="" style={{ display: 'grid', gridTemplateColumns: `${PERSON_W}px repeat(${n}, minmax(0, 1fr))`, gridTemplateRows: rows.join(' '),
        minWidth: PERSON_W + n * (compact ? 62 : 120) }}>
        {out}
      </div>
      {copied && <span aria-live="polite" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>A shift is copied. Press Enter on an empty day to place it.</span>}
    </div>
  );
}

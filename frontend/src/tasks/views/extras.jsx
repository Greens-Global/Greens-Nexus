// Task Module - Calendar (month/week with event categories + Show filter) and
// Dashboard (KPIs, status/dept/assignee bars, completion donut, time tracking,
// custom charts). Ported 1:1 from the export's NexusCalendarView / NexusDashboard.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Diamond, Sliders, Check, CalendarDays, CalendarOff, Video, Rocket, PartyPopper, Plus, CheckCircle2, Clock, AlertTriangle, ListTodo } from 'lucide-react';
import { NX, FONT, btn, input as inputStyle, STATUS_META } from '../theme';
import { taskStats } from '../lib';
import { Card, LightBar, Donut, TrendArea, CustomChartsPanel } from './charts';
import AnchoredMenu from '../../components/AnchoredMenu';
import { useRowColorMap } from '../rowColorState';
import { DateField, Modal, useIsMobile } from '../components';
import { useCanEditTask } from '../canEditTask';
import { awaitingFirstDate, clearingStopsSeries, moveTaskToDay, readPaneOpen, unscheduledTasks, writePaneOpen } from '../calendarMove';
import UnscheduledPane from './UnscheduledPane';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const toISO = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Below this width the calendar's container starts with the Unscheduled pane
// collapsed (desktop): the grid would be too cramped beside it.
const NARROW_PANE_PX = 1000;

const KIND_META = {
  due: { label: 'Due Dates', color: '#2563eb', Icon: CalendarDays },
  meeting: { label: 'Meetings', color: '#0891b2', Icon: Video },
  release: { label: 'Releases', color: '#7c3aed', Icon: Rocket },
  holiday: { label: 'Holidays', color: '#f59e0b', Icon: PartyPopper },
};

const US_HOLIDAYS = (y) => ({
  [`${y}-01-01`]: "New Year's Day",
  [`${y}-06-19`]: 'Juneteenth',
  [`${y}-07-04`]: 'Independence Day',
  [`${y}-11-11`]: 'Veterans Day',
  [`${y}-12-25`]: 'Christmas Day',
  [`${y}-12-31`]: "New Year's Eve",
});

// Fixed national holidays only - festivals on the lunar calendar (Diwali, Holi,
// Eid, etc.) move every year and would need a real almanac to place correctly,
// so they're left off rather than shown on the wrong date.
const IN_HOLIDAYS = (y) => ({
  [`${y}-01-01`]: "New Year's Day",
  [`${y}-01-26`]: 'Republic Day',
  [`${y}-05-01`]: 'Labour Day',
  [`${y}-08-15`]: 'Independence Day',
  [`${y}-10-02`]: 'Gandhi Jayanti',
  [`${y}-12-25`]: 'Christmas Day',
});

const HOLIDAY_REGIONS = { us: { label: 'US', fn: US_HOLIDAYS }, in: { label: 'India', fn: IN_HOLIDAYS } };

function holidaysForYear(y, region) {
  return (HOLIDAY_REGIONS[region] || HOLIDAY_REGIONS.us).fn(y);
}

// `store` (the Tasks store) turns on moving tasks between days (Oct 22 2026):
// drag a chip to another day (mouse; touch keeps tap-to-open so the page still
// scrolls), or right-click / Shift+F10 on it for Move To Date. A move is the
// task's own update (store.updateTask): optimistic, put back if refused, and
// a due date that needs approval comes back as a request with the chip on its
// old day. Week view has no hour slots, so a drop sets the day only.
//
// With a store the calendar also carries the Unscheduled pane (Oct 22 2026,
// views/UnscheduledPane.jsx): the open tasks in `tasks` with no due date,
// scheduled by a drop on a day (or the row's Schedule button), and a chip
// dropped on the pane loses its due date. All of it runs through moveTask
// below. `lockedProjectId` hides the project pill inside one project;
// `dueFiltered` (lib dueFilterHidesUndated) lets the pane say a due-date
// filter is why it is empty. The Teams calendar (no store) stays read-only,
// without the pane.
export function CalendarView({ tasks, onOpen, onCreate, store = null, lockedProjectId = null, dueFiltered = false }) {
  // Conditional row colors (Oct 22 2026): a task chip carries its rule's
  // color as a thin bar on its left edge.
  const rowColors = useRowColorMap();
  const [hoverDay, setHoverDay] = useState(null);
  const [dragId, setDragId] = useState(null);
  const [overIso, setOverIso] = useState(null);
  // Move To Date: { id, el } - the task and the chip it opened from.
  const [moveAt, setMoveAt] = useState(null);
  const moveFor = moveAt?.id || null;
  const moveAnchor = useMemo(() => ({ current: moveAt?.el || null }), [moveAt]);
  // Editor or better on the task (taskRoleFor, as the Board), and open.
  const canEditTask = useCanEditTask(store);
  const taskMap = useMemo(() => Object.fromEntries(tasks.map((t) => [t.id, t])), [tasks]);
  // Stable callbacks (useCallback): the memoized pane and its rows take
  // them, and a new identity on every hover would redraw them all. A first
  // date already waiting for approval is not asked for twice.
  const canSchedule = useCallback((t) => !!store?.updateTask && !!t && !t.completed && !awaitingFirstDate(t) && canEditTask(t),
    [store, canEditTask]);
  const canMove = (t) => !!t?.dueOn && canSchedule(t);
  // The one date path: a move between days, a task scheduled from the
  // Unscheduled pane, or (`iso` empty) a due date cleared on the pane.
  const moveTask = useCallback(async (id, iso) => {
    const t = taskMap[id];
    if (!canSchedule(t)) return;
    // calendarMove.moveTaskToDay - shared with the Board's Due Date columns:
    // the series refusal, a refused move put back, a held one a request for
    // approval, anything else an Undo toast.
    await moveTaskToDay(store, t, iso);
  }, [taskMap, store, canSchedule]);
  const openMove = (e, id) => setMoveAt({ id, el: e.currentTarget });
  const endDrag = useCallback(() => { setDragId(null); setOverIso(null); }, []);
  const [cursor, setCursor] = useState(() => new Date());
  const [weekly, setWeekly] = useState(false);
  const [show, setShow] = useState({ due: true, meeting: true, release: true, holiday: true });
  const [showOpen, setShowOpen] = useState(false);
  const showRef = useRef(null);
  const [region, setRegion] = useState(() => localStorage.getItem('nexus.calendarHolidayRegion') || 'us');
  useEffect(() => { localStorage.setItem('nexus.calendarHolidayRegion', region); }, [region]);
  // The Unscheduled pane: open or collapsed per person (desktop), a sheet on
  // phones. Only the count is needed here; the pane sorts and searches.
  const isMobile = useIsMobile();
  const withPane = !!store;
  const unscheduledCount = useMemo(() => (withPane ? unscheduledTasks(tasks).all.length : 0), [withPane, tasks]);
  // The person's stored choice, read again once their email is known (the
  // store can arrive without it) - adjusted during render, React's pattern
  // for state that follows a prop.
  const prefEmail = store?.myEmail || '';
  const [pref, setPref] = useState(() => ({ email: prefEmail, open: readPaneOpen(prefEmail) }));
  if (pref.email !== prefEmail) setPref({ email: prefEmail, open: readPaneOpen(prefEmail) });
  // Narrow desktop (under NARROW_PANE_PX across): the pane starts collapsed
  // there without touching the stored choice; opening it there lasts until
  // the space changes. measureRef watches the calendar's container.
  const [narrow, setNarrow] = useState(false);
  const [openWhileNarrow, setOpenWhileNarrow] = useState(false);
  const observer = useRef(null);
  const measureRef = useCallback((el) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    const apply = (w) => { if (w > 0) setNarrow(w < NARROW_PANE_PX); };
    apply(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'function') {
      observer.current = new ResizeObserver((entries) => apply(entries[0]?.contentRect?.width || 0));
      observer.current.observe(el);
    }
  }, []);
  useEffect(() => () => observer.current?.disconnect(), []);
  const [wasNarrow, setWasNarrow] = useState(narrow);
  if (wasNarrow !== narrow) { setWasNarrow(narrow); setOpenWhileNarrow(false); }
  const paneOpen = narrow ? openWhileNarrow : pref.open;
  const togglePane = useCallback(() => {
    if (narrow) { setOpenWhileNarrow((o) => !o); return; }
    setPref((p) => { writePaneOpen(p.email, !p.open); return { ...p, open: !p.open }; });
  }, [narrow]);
  const [sheetOpen, setSheetOpen] = useState(false);
  const paneShown = withPane && !isMobile && paneOpen;
  // A chip being dragged that the pane may take (its due date cleared) - not
  // the live occurrence of a repeating series, which must keep its date.
  const dragTask = dragId ? taskMap[dragId] : null;
  const clearTarget = !!dragTask && !!dragTask.dueOn && canMove(dragTask) && !clearingStopsSeries(dragTask);
  const dropClear = useCallback(() => { const id = dragId; endDrag(); moveTask(id, ''); }, [dragId, endDrag, moveTask]);
  const closeSheetAndOpen = useCallback((id) => { setSheetOpen(false); onOpen(id); }, [onOpen]);

  const days = useMemo(() => {
    if (weekly) {
      const start = new Date(cursor); start.setDate(cursor.getDate() - cursor.getDay());
      return Array.from({ length: 7 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; });
    }
    const y = cursor.getFullYear(), m = cursor.getMonth();
    const start = new Date(y, m, 1 - new Date(y, m, 1).getDay());
    return Array.from({ length: 42 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; });
  }, [cursor, weekly]);

  const holidayMap = useMemo(() => {
    const years = new Set(days.map((d) => d.getFullYear()));
    return [...years].reduce((acc, y) => Object.assign(acc, holidaysForYear(y, region)), {});
  }, [days, region]);

  const byDate = useMemo(() => {
    const map = {};
    const push = (date, ev) => (map[date] ||= []).push(ev);
    for (const t of tasks) {
      if (!t.dueOn) continue;
      const isMeeting = t.tags?.some((tag) => tag.toLowerCase().includes('meeting'));
      if (t.isMilestone) {
        if (show.release) push(t.dueOn, { kind: 'release', label: t.title, color: KIND_META.release.color, tint: `${KIND_META.release.color}1a`, taskId: t.id, completed: t.completed, isMilestone: true });
      } else if (isMeeting) {
        if (show.meeting) push(t.dueOn, { kind: 'meeting', label: t.title, color: KIND_META.meeting.color, tint: `${KIND_META.meeting.color}1a`, taskId: t.id, completed: t.completed });
      } else if (show.due) {
        const meta = STATUS_META[t.status];
        push(t.dueOn, { kind: 'due', label: t.title, color: meta?.color ?? KIND_META.due.color, tint: meta?.tint ?? `${KIND_META.due.color}1a`, taskId: t.id, completed: t.completed });
      }
    }
    if (show.holiday) for (const [iso, name] of Object.entries(holidayMap)) push(iso, { kind: 'holiday', label: name, color: KIND_META.holiday.color, tint: `${KIND_META.holiday.color}1a` });
    const rank = { holiday: 0, release: 1, meeting: 2, due: 3 };
    for (const k of Object.keys(map)) map[k].sort((a, b) => rank[a.kind] - rank[b.kind]);
    return map;
  }, [tasks, show, holidayMap]);

  const todayIso = toISO(new Date());
  const step = (dir) => setCursor((c) => (weekly ? new Date(c.getFullYear(), c.getMonth(), c.getDate() + dir * 7) : new Date(c.getFullYear(), c.getMonth() + dir, 1)));

  const rangeLabel = weekly
    ? (() => { const s = days[0], e = days[6]; return s.getMonth() === e.getMonth() ? `${MONTHS_SHORT[s.getMonth()]} ${s.getDate()} – ${e.getDate()}, ${e.getFullYear()}` : `${MONTHS_SHORT[s.getMonth()]} ${s.getDate()} – ${MONTHS_SHORT[e.getMonth()]} ${e.getDate()}, ${e.getFullYear()}`; })()
    : `${MONTHS[cursor.getMonth()]} ${cursor.getFullYear()}`;

  // Standard segmented-control option (white active pill on a gray track) -
  // matches every other mode switch in the module.
  const seg = (active) => ({ borderRadius: 7, padding: '5px 12px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', border: `1px solid ${active ? NX.border : 'transparent'}`, background: active ? NX.surface : 'transparent', color: active ? NX.ink : NX.dim, boxShadow: active ? '0 1px 2px rgba(0,0,0,0.08)' : 'none' });

  const calendar = (
    <div style={{ margin: withPane ? 0 : 16, flex: 1, minWidth: 0, borderRadius: 16, border: `1px solid ${NX.border}`, background: NX.surface, fontFamily: FONT }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, borderBottom: `1px solid ${NX.border}`, padding: '12px 16px' }}>
        <button onClick={() => step(-1)} aria-label="Previous" title="Previous" style={{ ...btn('ghost'), padding: 4 }}><ChevronLeft size={18} /></button>
        <span style={{ minWidth: 150, fontSize: 15, fontWeight: 700, color: NX.ink }}>{rangeLabel}</span>
        <button onClick={() => step(1)} aria-label="Next" title="Next" style={{ ...btn('ghost'), padding: 4 }}><ChevronRight size={18} /></button>
        <button onClick={() => setCursor(new Date())} style={{ ...btn('outline'), fontSize: 12 }}>Today</button>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {withPane && (isMobile || !paneOpen) && (
            <button type="button" onClick={() => (isMobile ? setSheetOpen(true) : togglePane())}
              title={isMobile ? 'Tasks with no due date' : 'Show the tasks with no due date'}
              style={{ ...btn('outline'), fontSize: 12 }}><CalendarOff size={13} />Unscheduled ({unscheduledCount})</button>
          )}
          <div>
            <button ref={showRef} onClick={() => setShowOpen((o) => !o)} style={{ ...btn('outline'), fontSize: 12 }}><Sliders size={13} />Show</button>
            <AnchoredMenu anchorRef={showRef} open={showOpen} onClose={() => setShowOpen(false)} align="end" role="dialog"
              style={{ width: 216, background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,0.16)', padding: '6px 0' }}>
              <div style={{ padding: '4px 12px 6px', fontSize: 12.5, fontWeight: 600, color: NX.dim }}>Show on calendar</div>
              {Object.keys(KIND_META).map((k) => {
                const { label, color, Icon } = KIND_META[k]; const on = show[k];
                return (
                  <button key={k} onClick={() => setShow((s) => ({ ...s, [k]: !s[k] }))} style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 10, padding: '6px 12px', textAlign: 'left', fontSize: 13, background: 'transparent', border: 'none', cursor: 'pointer' }}>
                    <span style={{ display: 'flex', width: 16, height: 16, alignItems: 'center', justifyContent: 'center', borderRadius: 4, border: `1px solid ${on ? color : NX.border}`, background: on ? color : 'transparent', color: '#fff' }}>{on && <Check size={11} />}</span>
                    <Icon size={14} style={{ color }} />
                    <span style={{ flex: 1, color: NX.ink }}>{label}</span>
                  </button>
                );
              })}
              {/* Holiday region lives WITH the holiday toggle it modifies -
                  not as a separate toolbar cluster (owner call, Jul 28) */}
              {show.holiday && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 12px 6px 38px' }}>
                  {Object.entries(HOLIDAY_REGIONS).map(([key, r]) => (
                    <button key={key} onClick={() => setRegion(key)} style={seg(region === key)}>{r.label}</button>
                  ))}
                </div>
              )}
            </AnchoredMenu>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', borderRadius: 9, background: NX.border2, padding: 2, gap: 2 }}>
            <button onClick={() => setWeekly(false)} style={seg(!weekly)}>Month</button>
            <button onClick={() => setWeekly(true)} style={seg(weekly)}>Week</button>
          </div>
        </div>
      </div>
      {/* Weekday header - tinted band, sentence case (kit calendar grammar) */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,minmax(0,1fr))', borderBottom: `1px solid ${NX.border}`, background: NX.surface2 }}>
        {WEEKDAYS.map((d) => <div key={d} style={{ padding: '9px 10px', fontSize: 12.5, fontWeight: 600, color: NX.dim }}>{d}</div>)}
      </div>
      {/* Day grid - minmax(0,1fr): a long title is cut off inside its day
          rather than widening that column (the Unscheduled pane leaves the
          grid narrower). */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,minmax(0,1fr))' }}>
        {days.map((d) => {
          const iso = toISO(d);
          const inMonth = weekly || d.getMonth() === cursor.getMonth();
          const events = byDate[iso] ?? [];
          const cap = weekly ? 8 : 3;
          const over = !!dragId && overIso === iso;
          return (
            <div key={iso} data-day={iso} onMouseEnter={() => setHoverDay(iso)} onMouseLeave={() => setHoverDay((h) => (h === iso ? null : h))}
              onDragOver={dragId ? (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'; if (overIso !== iso) setOverIso(iso); } : undefined}
              onDragLeave={dragId ? (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOverIso((o) => (o === iso ? null : o)); } : undefined}
              onDrop={dragId ? (e) => { e.preventDefault(); const id = dragId; endDrag(); moveTask(id, iso); } : undefined}
              style={{ borderBottom: `1px solid ${NX.border2}`, borderRight: `1px solid ${NX.border2}`, padding: 6, minHeight: weekly ? 320 : 104, background: over ? `${NX.primary}14` : inMonth ? NX.surface : NX.surface2, opacity: inMonth || over ? 1 : 0.6, boxShadow: over ? `inset 0 0 0 2px ${NX.primary}` : 'none', transition: 'background .1s' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ display: 'inline-flex', width: 24, height: 24, alignItems: 'center', justifyContent: 'center', borderRadius: '50%', fontSize: 11, fontWeight: 600, background: iso === todayIso ? NX.primary : 'transparent', color: iso === todayIso ? '#fff' : NX.dim }}>{d.getDate()}</span>
                {onCreate && inMonth && hoverDay === iso && (
                  <button onClick={() => onCreate(iso)} title="Add Task" style={{ ...btn('ghost'), padding: 2, color: NX.faint }}><Plus size={14} /></button>
                )}
              </div>
              <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>
                {events.slice(0, cap).map((ev, i) => ev.taskId ? (() => {
                  const movable = canMove(taskMap[ev.taskId]);
                  const rc = rowColors?.get(ev.taskId) || null;
                  return (
                    <button key={i} onClick={() => onOpen(ev.taskId)} data-row-color={rc?.id}
                      title={`${KIND_META[ev.kind].label}: ${ev.label}${rc ? ` (${rc.name})` : ''}${movable ? ' - drag to another day, or right-click to move it' : ''}`}
                      draggable={movable || undefined}
                      onDragStart={movable ? (e) => { setDragId(ev.taskId); try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', ev.taskId); } catch { /* no dataTransfer (tests) */ } } : undefined}
                      onDragEnd={movable ? endDrag : undefined}
                      onContextMenu={movable ? (e) => { e.preventDefault(); openMove(e, ev.taskId); } : undefined}
                      onKeyDown={movable ? (e) => { if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); openMove(e, ev.taskId); } } : undefined}
                      aria-keyshortcuts={movable ? 'Shift+F10' : undefined}
                      style={{ display: 'flex', alignItems: 'center', gap: 4, borderRadius: 6, padding: rc ? '2px 6px 2px 8px' : '2px 6px', textAlign: 'left', fontSize: 11, fontWeight: 500, border: 'none', cursor: movable ? 'grab' : 'pointer', background: ev.tint, color: ev.color, overflow: 'hidden', opacity: dragId === ev.taskId ? 0.45 : 1, boxShadow: rc ? `inset 3px 0 0 ${rc.hex}` : undefined }}>
                      {ev.isMilestone && <Diamond size={9} style={{ flexShrink: 0 }} />}
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textDecoration: ev.completed ? 'line-through' : 'none' }}>{ev.label}</span>
                    </button>
                  );
                })() : (
                  <span key={i} title={`Holiday: ${ev.label}`} style={{ display: 'flex', alignItems: 'center', gap: 4, borderRadius: 6, padding: '2px 6px', fontSize: 11, fontWeight: 500, background: ev.tint, color: ev.color, overflow: 'hidden' }}>
                    <PartyPopper size={9} style={{ flexShrink: 0 }} /><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ev.label}</span>
                  </span>
                ))}
                {events.length > cap && <span style={{ padding: '0 4px', fontSize: 10, color: NX.faint }}>+{events.length - cap} more</span>}
              </div>
            </div>
          );
        })}
      </div>
      {/* Move To Date - the drag's keyboard / menu twin. */}
      <AnchoredMenu anchorRef={moveAnchor} open={!!moveFor && !!taskMap[moveFor]} onClose={() => setMoveAt(null)} role="dialog" aria-label="Move To Date"
        style={{ width: 250, background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,0.16)', padding: 12, fontFamily: FONT }}>
        {moveFor && taskMap[moveFor] && (
          <div style={{ display: 'grid', gap: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: NX.ink }}>Move To Date</div>
            <div style={{ fontSize: 12, color: NX.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{taskMap[moveFor].title}</div>
            {/* The calendar's Clear takes the due date off - the keyboard
                twin of dropping the chip on the Unscheduled pane. */}
            <DateField value={taskMap[moveFor].dueOn || ''} title="Move To Date"
              onChange={(v) => { const id = moveFor; setMoveAt(null); moveTask(id, v || ''); }}
              style={{ ...inputStyle, padding: '6px 9px', fontSize: 12.5 }} />
          </div>
        )}
      </AnchoredMenu>
    </div>
  );
  if (!withPane) return calendar;
  return (
    <>
      <div ref={measureRef} data-testid="calendar-wrap" style={{ display: 'flex', alignItems: 'stretch', gap: 12, margin: 16 }}>
        {calendar}
        {/* The pane's content is out of the flow (absolute), so a long
            list scrolls inside the calendar's height rather than
            stretching the page. */}
        {paneShown && (
          <div style={{ position: 'relative', width: 288, flexShrink: 0, minHeight: 360, borderRadius: 16, border: `1px solid ${NX.border}`, background: NX.surface2 }}>
            <div style={{ position: 'absolute', inset: 0 }}>
              <UnscheduledPane tasks={tasks} store={store} onOpen={onOpen} lockedProjectId={lockedProjectId}
                canSchedule={canSchedule} onSchedule={moveTask} dueFiltered={dueFiltered}
                dragId={dragId} onDragRow={setDragId} onDragEnd={endDrag}
                clearTarget={clearTarget} onDropClear={dropClear} onCollapse={togglePane} />
            </div>
          </div>
        )}
      </div>
      {isMobile && sheetOpen && (
        <Modal title={`Unscheduled (${unscheduledCount})`} onClose={() => setSheetOpen(false)}>
          <UnscheduledPane tasks={tasks} store={store} onOpen={closeSheetAndOpen} lockedProjectId={lockedProjectId}
            canSchedule={canSchedule} onSchedule={moveTask} dueFiltered={dueFiltered} sheet />
        </Modal>
      )}
    </>
  );
}

export function DashboardView({ tasks, stats: pre, store, scopeKey = 'workspace', onFilter }) {
  const stats = (pre && pre.total != null) ? pre : taskStats(tasks);
  const byStatus = store.statusOrder.map((s) => ({ label: store.statusMeta[s]?.label || s, value: tasks.filter((t) => t.status === s).length, color: store.statusMeta[s]?.color, key: s })).filter((d) => d.value > 0);
  const byTeam = (store.teams || []).map((d) => ({ label: d.name, value: tasks.filter((t) => t.teamId === d.id).length, color: d.color || NX.blue, key: d.id })).filter((d) => d.value > 0);

  const byAssignee = useMemo(() => {
    const seen = new Map();
    for (const t of tasks) if (t.assigneeId && !seen.has(t.assigneeId)) seen.set(t.assigneeId, (store.nameOf?.(t.assigneeId) || t.assigneeId).split(' ')[0]);
    return [...seen.entries()].map(([id, label]) => ({ label, value: tasks.filter((t) => t.assigneeId === id).length, color: NX.blue, key: id })).filter((d) => d.value > 0);
  }, [tasks, store]);

  const totalEst = tasks.reduce((n, t) => n + (t.estimateHours ?? 0), 0);
  const totalAct = tasks.reduce((n, t) => n + (t.actualHours ?? 0), 0);
  const variance = totalAct - totalEst;

  // Completions over the trailing 14 days - feeds the trend area chart.
  const trend = useMemo(() => {
    const out = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const iso = toISO(d);
      out.push({ label: `${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}`, n: tasks.filter((t) => t.completed && t.completedAt && toISO(new Date(t.completedAt)) === iso).length });
    }
    return out;
  }, [tasks]);

  // Kit KPI tile: colored icon chip carries the meaning; the numeral stays ink.
  // Clickable when onFilter is wired in - drills straight into the List view
  // pre-filtered to that slice, same as clicking a bar below.
  const kpi = (label, value, color, Icon, onClick) => (
    <button onClick={onClick} disabled={!onClick} style={{
      borderRadius: 16, border: `1px solid ${NX.border}`, background: NX.surface, padding: '16px 18px',
      display: 'flex', alignItems: 'center', gap: 14, textAlign: 'left', font: 'inherit', color: 'inherit',
      cursor: onClick ? 'pointer' : 'default', width: '100%',
    }}>
      <span style={{ width: 42, height: 42, borderRadius: 13, background: `${color}1a`, color, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Icon size={19} /></span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <span style={{ fontSize: 13, fontWeight: 500, color: NX.dim }}>{label}</span>
        <span style={{ fontSize: 26, fontWeight: 700, lineHeight: 1, color: NX.ink, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
      </span>
    </button>
  );

  return (
    <div style={{ padding: 16, fontFamily: FONT, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 16 }}>
        {kpi('Completed', stats.completed, NX.green, CheckCircle2, onFilter && (() => onFilter({ statuses: ['completed'] })))}
        {kpi('In progress', stats.inProgress, NX.blue, Clock, onFilter && (() => onFilter({ statuses: ['in_progress'] })))}
        {kpi('Overdue', stats.overdue, NX.red, AlertTriangle, onFilter && (() => onFilter({ due: 'overdue' })))}
        {kpi('Total', stats.total, NX.primary, ListTodo, onFilter && (() => onFilter({})))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))', gap: 16 }}>
        <Card title="Completions - last 14 days"><TrendArea buckets={trend} color={NX.green} ariaLabel="Tasks completed per day, last 14 days" /></Card>
        <Card title="Tasks by Status"><LightBar data={byStatus} onSelect={onFilter && ((d) => onFilter({ statuses: [d.key] }))} /></Card>
        <Card title="Completion"><Donut total={stats.total} segments={[{ label: 'Completed', value: stats.completed, color: NX.green }, { label: 'Remaining', value: stats.total - stats.completed, color: '#d5d9e2' }]} /></Card>
        <Card title="Tasks by Team"><LightBar data={byTeam} onSelect={onFilter && ((d) => onFilter({ teamIds: [d.key] }))} /></Card>
        <Card title="Tasks by Assignee"><LightBar data={byAssignee} onSelect={onFilter && ((d) => onFilter({ assigneeIds: [d.key] }))} /></Card>
      </div>

      <Card title="Time tracking - estimate vs actual">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
          <div><div style={{ fontSize: 12.5, color: NX.dim }}>Estimated</div><div style={{ fontSize: 28, fontWeight: 700, color: NX.ink, fontVariantNumeric: 'tabular-nums' }}>{totalEst}h</div></div>
          <div><div style={{ fontSize: 12.5, color: NX.dim }}>Actual</div><div style={{ fontSize: 28, fontWeight: 700, color: NX.ink, fontVariantNumeric: 'tabular-nums' }}>{totalAct}h</div></div>
          <div><div style={{ fontSize: 12.5, color: NX.dim }}>Variance</div><div style={{ fontSize: 28, fontWeight: 700, color: variance > 0 ? NX.red : NX.green, fontVariantNumeric: 'tabular-nums' }}>{variance >= 0 ? '+' : ''}{variance.toFixed(1)}h</div></div>
        </div>
      </Card>

      <CustomChartsPanel scopeKey={scopeKey} tasks={tasks} store={store} />
    </div>
  );
}

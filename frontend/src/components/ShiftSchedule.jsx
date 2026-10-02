import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from 'react';
import { CalendarPlus, Copy as CopyIcon, CalendarDays, Undo2, X as XIcon } from 'lucide-react';
import { api } from '../api';
import { useRole } from '../contexts/RoleContext';
import { useNameResolver } from '../lib/useNameResolver';
import { useIsMobile } from '../lib/useIsMobile';
import { formatDate, formatWeekday, formatMonthYear, formatHHMM } from '../lib/datetime';
import { zoneOptionLabel } from '../lib/worldClockZones';
import { exportExcel } from '../tasks/exporting';
import { dialog } from '../ui/dialog';
import { ErrorBanner, SkeletonBlocks } from './AsyncState';
import { ShiftTypeWeek, ImportModal, ShiftMenu, PersonMenu, ShiftDetails } from './ShiftScheduleExtras';
import { printSchedule, DEFAULT_VIEW_PREFS } from './shiftScheduleLib';
import { AddMembersModal, ReorderTeamsModal, TeamMenu } from './ShiftTeams';
import { ScheduleToolbar, ShareDialog, DayNoteDialog, ViewOptionsDialog, MODAL_BACK, MODAL_CARD, DialogHead } from './shifts/ScheduleToolbar';
import TeamPicker, { ALL_TEAMS, NO_TEAM } from './shifts/TeamPicker';
import { MOTION, useReducedMotion } from './shifts/motion';
import { CopyModal, ClearModal, BulkModal } from './shifts/ScheduleDialogs';
import WeekGrid, { TOOL_BTN } from './shifts/WeekGrid';
import ScheduleDay from './shifts/ScheduleDay';
import ScheduleMonth from './shifts/ScheduleMonth';
import SchedulePhone from './shifts/SchedulePhone';
import ShiftPanel from './shifts/ShiftPanel';
import { isoDate, viewDays, weekStartOf, paidMinutes, counts, fmtHrs, hrsNumber, timeOffOn, shiftState, isUnshared, orderGroups, shiftTimeText, shiftShortText, sectionKey, teamColor, dayFullyOff, addDaysIso, parseIso, conflictMap, coverageFor } from './shifts/shiftLib';

// ── The schedule (Microsoft Teams "Shifts" style, rebuilt Oct 2026) ────────
// This file is the container: it owns the data, the API calls and the
// interactions (drag, menus, keyboard, clipboard). What is on screen is
// components/shifts/: ScheduleToolbar (one row, seven controls), WeekGrid
// (week, two weeks - one CSS grid, redesigned 10/02), ScheduleDay, ScheduleMonth, SchedulePhone (a day list
// on a phone - never a 7-column grid there), ShiftPanel (the right-hand
// editor) and ScheduleDialogs (Copy / Clear / Fill).
//
// Rows = people grouped by shift group (or location), columns = the days in
// view. A cell holds the placed shifts, with time off and holidays as their
// own blocks beside them. Hours are PAID hours (span minus unpaid), two
// decimals, "Hrs" everywhere; group subtotals and the Week total count the
// people shown, and the Open Shifts rows carry their own hours.

const WEEK_LIMIT_MIN = 40 * 60;   // over this in a week reads red (Neil, Sep 30)
const PREFS_KEY = 'nexus.shifts.viewPrefs';
function loadPrefs() {
  try { return { ...DEFAULT_VIEW_PREFS, ...(JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {}) }; }
  catch { return { ...DEFAULT_VIEW_PREFS }; }
}
const LONG_PRESS_MS = 500;
// The team switcher's memory, per user: a group id, ALL_TEAMS or NO_TEAM.
const readTeam = (key) => { try { return localStorage.getItem(key) || null; } catch { return null; } };
// A shift type's days ("1,2,3,4,5", Mon=1) as the bulk API's weekdays (Mon=0).
const presetWeekdays = (p) => {
  const d = String(p?.days || '').split(',').map(Number).filter((n) => n >= 1 && n <= 7).map((n) => n - 1);
  return d.length ? d : [0, 1, 2, 3, 4];
};
const presetOnDay = (p, ds) => presetWeekdays(p).includes((parseIso(ds).getDay() + 6) % 7);
// What it takes to put a shift back exactly as it was (Undo).
const createPayload = (s) => ({ employee_email: s.email || '', work_date: s.date, shift_id: s.shiftId || '', start_hhmm: s.start, end_hhmm: s.end, label: s.label || '', note: s.note || '',
  break_min: s.breakMin ?? 0, color: s.ownColor || '', activities: s.activities || [], group_id: s.groupId || '', ...(s.email ? {} : { open_slots: s.openSlots || 1 }) });
const SHORTCUTS = [
  ['Left / Right', 'Previous or next week (outside the grid)'], ['T', 'Today'], ['1 - 9', 'Switch to that team'],
  ['Arrow keys', 'Move between days in the grid'], ['Enter', 'Open the day or shift'], ['Shift + Click', 'Open the editor on an empty day'],
  ['Delete', 'Remove a draft'], ['Ctrl + C / Ctrl + V', 'Copy a shift, paste it on a day'], ['Esc', 'Close a menu or panel'],
];

export default function ShiftSchedule({ toastOk, toastErr, onOpenRequests }) {
  const { myEmail } = useRole() || {};
  const me = (myEmail || '').toLowerCase();
  const nameOf = useNameResolver();
  const phone = useIsMobile();
  const [view, setView] = useState('week');
  const [cursor, setCursor] = useState(() => new Date());
  const [query, setQuery] = useState('');
  const [presetFilter, setPresetFilter] = useState('');
  const [groupBy, setGroupBy] = useState('group');   // group | location | shift
  const [prefs, setPrefsState] = useState(loadPrefs);
  const setPrefs = (next) => { setPrefsState(next); try { localStorage.setItem(PREFS_KEY, JSON.stringify(next)); } catch { /* private mode */ } };
  const weekStart = prefs.weekStart === 'sunday' ? 'sunday' : 'monday';
  // Which groups are folded, per user: { key: true (folded) | false }. A
  // group the user never touched is folded when it has no shifts in view.
  const foldKey = `nexus.shifts.fold.${me || 'anon'}`;
  const [fold, setFoldState] = useState(() => { try { return JSON.parse(localStorage.getItem(foldKey) || '{}') || {}; } catch { return {}; } });
  const setFold = (next) => { setFoldState(next); try { localStorage.setItem(foldKey, JSON.stringify(next)); } catch { /* private mode */ } };
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [panel, setPanel] = useState(null);        // { cell: { email, date, existing, groupId }, mode }
  const [menu, setMenu] = useState(null);          // { x, y, email, date, groupId, shift }
  const [personMenu, setPersonMenu] = useState(null);
  const [details, setDetails] = useState(null);
  const [copied, setCopied] = useState(null);
  const [drag, setDrag] = useState(null);
  const [ghost, setGhost] = useState(null);
  const [dropKey, setDropKey] = useState('');
  const [open, setOpen] = useState('');            // which dialog: share | copy | clear | fill | import | view | note | reorder
  const [noteDate, setNoteDate] = useState('');
  const [addTo, setAddTo] = useState(null);
  const [undo, setUndo] = useState(null);          // { msg, fn, key } - the 5-second Undo bar
  const [leaving, setLeaving] = useState(() => new Set());   // drafts shrinking out
  const [fresh, setFresh] = useState(() => new Set());       // blocks that just arrived
  const [slide, setSlide] = useState(0);           // -1 / 1: which way the last week change went
  const reduce = useReducedMotion();
  const teamKey = `nexus.shifts.team.${me || 'anon'}`;
  const [teamPick, setTeamPick] = useState(() => readTeam(teamKey));
  useEffect(() => { setTeamPick(readTeam(teamKey)); }, [teamKey]);
  const [frozenDefault, setFrozenDefault] = useState(null);
  const rootRef = useRef(null);
  const scrollMem = useRef({});
  const glowRef = useRef(true);                    // today's column glows once, on the first load
  const suppressClick = useRef(false);
  const hoverRef = useRef({ shift: null, cell: null });
  const pressRef = useRef(null);

  const allDays = useMemo(() => viewDays(view, cursor, weekStart), [view, cursor, weekStart]);
  const start = isoDate(allDays[0]);
  const end = isoDate(allDays[allDays.length - 1]);
  const hideSunday = prefs.sunday === false && view !== 'day' && view !== 'month';
  const days = useMemo(() => (hideSunday ? allDays.filter((d) => d.getDay() !== 0) : allDays), [allDays, hideSunday]);
  const compact = view === 'twoweeks';

  // Refreshing after a save keeps the grid on screen; only a new range (or a
  // failed load) shows the skeleton. A failed load is an error with Retry,
  // never an empty-looking schedule with Share still offered.
  const load = useCallback(() => {
    setError(null);
    api.timeSchedule(start, end).then((r) => {
      setData(r);
      if (r?.weekStart && r.weekStart !== weekStart) setPrefsState((p) => { const n = { ...p, weekStart: r.weekStart }; try { localStorage.setItem(PREFS_KEY, JSON.stringify(n)); } catch { /* */ } return n; });
    }).catch((e) => { setError(e?.message || 'Could not load the schedule.'); });
  }, [start, end]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setData(null); }, [start, end]);
  useEffect(() => { load(); }, [load]);

  const presets = data?.shifts || [];
  const teamZone = data?.timeZone || '';                       // the IANA id, what a shift's zone is compared with
  const teamZoneLabel = teamZone ? zoneOptionLabel(teamZone) : '';   // "(GMT-7) Pacific Daylight Time - Los Angeles", said once under the grid
  const canManage = data?.canManage !== false;
  const managing = !!data && canManage;
  const canTimeOff = !data?.groupScheduler;
  const names = useMemo(() => Object.fromEntries((data?.employees || []).map((e) => [e.email, nameOf(e.email, e.name)])), [data, nameOf]);
  const empByEmail = useMemo(() => Object.fromEntries((data?.employees || []).map((e) => [e.email, { ...e, name: nameOf(e.email, e.name), availability: data?.availability?.[e.email] || [] }])), [data, nameOf]);
  const groups = useMemo(() => orderGroups(data?.groups || []), [data]);

  // ── The team on screen (10/02): one team at a time ─────────────────────
  // The remembered choice, else the first team the signed-in person is in,
  // else the team with the most shifts this week (decided once, so moving
  // between weeks never switches the team under you). All Teams is the old
  // stacked view; People Without a Team is what "Everyone Else" was.
  const liveGroups = useMemo(() => groups.filter((g) => !g.archived), [groups]);
  const groupIdSet = useMemo(() => new Set(groups.map((g) => g.id)), [groups]);
  const claimedAll = useMemo(() => new Set(liveGroups.flatMap((g) => g.members || [])), [liveGroups]);
  const noTeamEmails = useMemo(() => (data?.employees || []).map((e) => e.email).filter((e) => !claimedAll.has(e)), [data, claimedAll]);
  const computedDefault = useMemo(() => {
    if (!data) return null;
    if (!liveGroups.length) return ALL_TEAMS;
    const mine = me && liveGroups.find((g) => (g.members || []).includes(me));
    if (mine) return mine.id;
    let best = liveGroups[0], bestN = -1;
    liveGroups.forEach((g) => {
      const set = new Set(g.members || []);
      const n = (data.scheduled || []).filter((x) => (x.email ? set.has(x.email) : x.groupId === g.id)).length;
      if (n > bestN) { best = g; bestN = n; }
    });
    return best.id;
  }, [data, liveGroups, me]);
  useEffect(() => { if (computedDefault && !frozenDefault) setFrozenDefault(computedDefault); }, [computedDefault, frozenDefault]);
  const teamValid = (id) => !!id && (id === ALL_TEAMS || (id === NO_TEAM && noTeamEmails.length > 0) || groupIdSet.has(id));
  const team = !data ? (teamPick || '') : teamValid(teamPick) ? teamPick : teamValid(frozenDefault) ? frozenDefault : (computedDefault || ALL_TEAMS);
  const mode = team === ALL_TEAMS || !team ? 'all' : team === NO_TEAM ? 'none' : 'group';
  const groupFilter = mode === 'group' ? team : '';
  const pickTeam = (id) => {
    const grid = rootRef.current?.querySelector('.week-grid');
    scrollMem.current[team] = { top: grid?.scrollTop || 0, left: grid?.scrollLeft || 0 };
    setTeamPick(id);
    try { localStorage.setItem(teamKey, id); } catch { /* private mode */ }
  };
  const setGroupFilter = (id) => pickTeam(id || ALL_TEAMS);
  // Back where you were in that team's list.
  useLayoutEffect(() => {
    const grid = rootRef.current?.querySelector('.week-grid');
    const at = scrollMem.current[team];
    if (grid) { grid.scrollTop = at?.top || 0; grid.scrollLeft = at?.left || 0; }
  }, [team]);

  // Conflicts (10/02): the API's per-shift sentences plus what the grid can
  // see itself - duplicates, overlaps (overnight too), approved time off,
  // availability - one short line each; the block wears an amber dot.
  const conflicts = useMemo(() => (data ? conflictMap(data.scheduled, data.timeoff, data.availability) : {}), [data]);
  // index: "email|date" -> [shifts]; open shifts by "groupId|date".
  const byCell = useMemo(() => {
    const map = {};
    (data?.scheduled || []).forEach((s) => {
      if (s.email && (!presetFilter || s.shiftId === presetFilter)) (map[`${s.email}|${s.date}`] ||= []).push(s.pendingDelete ? s : { ...s, conflicts: conflicts[s.id] || [] });
    });
    return map;
  }, [data, presetFilter, conflicts]);
  const openAll = useMemo(() => (data?.scheduled || []).filter((s) => !s.email && (!presetFilter || s.shiftId === presetFilter)), [data, presetFilter]);
  const offOn = useCallback((email, ds) => timeOffOn(data?.timeoff, email, ds), [data]);
  const holOn = useCallback((email, ds) => data?.holidays?.[email]?.[ds], [data]);
  const holidayDates = useMemo(() => {
    const s = new Set();
    Object.values(data?.holidays || {}).forEach((byDate) => Object.keys(byDate).forEach((d) => s.add(d)));
    return s;
  }, [data]);
  const holidayNames = useMemo(() => {
    const m = {};
    Object.values(data?.holidays || {}).forEach((byDate) => Object.entries(byDate).forEach(([d, h]) => { m[d] = h?.name || 'Holiday'; }));
    return m;
  }, [data]);
  const availOn = useCallback((email, d) => (data?.availability?.[email] || []).find((a) => a.weekday === (d.getDay() + 6) % 7) || null, [data]);
  // A person's usual hours (their shift type) - one line under their name.
  const usualOf = useCallback((email) => presets.find((x) => x.id === data?.usual?.[email]) || null, [data, presets]);

  // Sections: the groups (saved order, archived apart), then everyone else;
  // or by location; or one list. Search, the group filter and Your Shifts
  // narrow every view, the totals and the export.
  const sections = useMemo(() => {
    if (!data) return [];
    const emps = Object.values(empByEmail);
    const claimed = new Set();
    let out = [];
    if (groupBy === 'location') {
      const byLoc = {};
      emps.forEach((e) => (byLoc[e.location || ''] ||= []).push(e));
      out = Object.keys(byLoc).sort((a, b) => (a === '') - (b === '') || a.localeCompare(b)).map((k) => ({ id: '', name: k || 'No Location Set', members: byLoc[k] }));
    } else if (mode === 'none') {
      out = [{ id: '', name: 'People Without a Team', members: emps }];
    } else {
      groups.forEach((g) => {
        if (g.archived && g.id !== groupFilter) return;
        const members = (g.members || []).map((m) => empByEmail[m]).filter(Boolean);
        members.forEach((m) => claimed.add(m.email));
        if (members.length || (g.canEdit && !query.trim())) out.push({ id: g.id, name: g.name, members, canEdit: !!g.canEdit, archived: !!g.archived, isGroup: true, canReorder: !data.groupScheduler && groups.every((x) => x.canEdit) });
      });
      const rest = emps.filter((e) => !claimed.has(e.email));
      if (rest.length) out.push({ id: '', name: out.length ? 'Everyone Else' : 'Everyone', members: rest });
      if (prefs.teams === false) {
        const seen = new Set();
        out = [{ id: '', name: 'Everyone', members: out.flatMap((g) => g.members).filter((m) => !seen.has(m.email) && seen.add(m.email)) }];
      }
    }
    const q = query.trim().toLowerCase();
    const picked = groupFilter ? groups.find((g) => g.id === groupFilter) : null;
    const byGroup = groupBy !== 'location' && prefs.teams !== false;
    return out
      .filter((g) => !picked || !byGroup || g.id === picked.id)
      .map((g) => ({ ...g, members: g.members.filter((m) => (!q || `${m.name || ''} ${m.email}`.toLowerCase().includes(q))
        && (!picked || byGroup || (picked.members || []).includes(m.email))
        && (mode !== 'none' || !claimedAll.has(m.email))
        && (!prefs.mine || m.email === me)
        && (!prefs.hideEmpty || days.some((d) => (byCell[`${m.email}|${isoDate(d)}`] || []).length))) }))
      .filter((g) => g.members.length || (g.id && g.canEdit && !q && !prefs.mine))
      .map((g) => ({ ...g, members: [...g.members].sort((a, b) => (b.email === me) - (a.email === me)) }));
  }, [data, empByEmail, groups, query, groupFilter, groupBy, me, prefs.teams, prefs.mine, prefs.hideEmpty, days, byCell, mode, claimedAll]);
  // One team on screen: no group header row (the switcher names it).
  const single = mode !== 'all' && groupBy !== 'location';
  const visibleEmails = useMemo(() => new Set(sections.flatMap((g) => g.members.map((m) => m.email))), [sections]);
  const visibleGroupIds = useMemo(() => new Set(sections.filter((g) => g.isGroup).map((g) => g.id)), [sections]);
  const showOpen = !prefs.mine && prefs.open !== false;
  // Open shifts by group: a shift with no groupId (older rows) sits on a
  // top row; a group's own sit on its row.
  const openCells = useMemo(() => {
    const map = {};
    if (!showOpen) return map;
    openAll.forEach((s) => {
      if (mode === 'none') {
        if (s.groupId && groupIdSet.has(s.groupId)) return;
        (map[`|${s.date}`] ||= []).push(s);
        map.__ungrouped = true;
        return;
      }
      const gid = s.groupId && visibleGroupIds.has(s.groupId) ? s.groupId : (s.groupId && groupFilter ? null : '');
      if (gid === null) return;
      if (gid === '' && groupFilter) return;
      (map[`${gid}|${s.date}`] ||= []).push(s);
      if (gid === '') map.__ungrouped = true;
    });
    return map;
  }, [openAll, showOpen, visibleGroupIds, groupFilter, mode, groupIdSet]);
  const shown = useMemo(() => [
    ...(data?.scheduled || []).filter((s) => s.email && visibleEmails.has(s.email) && (!presetFilter || s.shiftId === presetFilter)),
    ...Object.entries(openCells).filter(([k]) => k !== '__ungrouped').flatMap(([, v]) => v),
  ], [data, visibleEmails, presetFilter, openCells]);
  const notes = useMemo(() => {
    const m = {};
    (data?.dayNotes || []).forEach((n) => { if (!n.groupId || visibleGroupIds.has(n.groupId) || !groups.length) m[n.date] = m[n.date] ? `${m[n.date]} · ${n.note}` : n.note; });
    return m;
  }, [data, visibleGroupIds, groups.length]);

  // Each team's people, hours, drafts and open shifts in view - the switcher's numbers.
  const teamNumbers = useMemo(() => {
    if (!data) return { list: [], all: null, none: null };
    const inView = new Set(days.map(isoDate));
    const sched = (data.scheduled || []).filter((x) => inView.has(x.date));
    const known = new Set(Object.keys(empByEmail));
    const statFor = (emails, openOf) => {
      const set = new Set(emails.filter((e) => known.has(e)));
      let min = 0, drafts = 0, open = 0;
      sched.forEach((x) => {
        if (!(x.email ? set.has(x.email) : openOf(x))) return;
        if (x.email && counts(x)) min += paidMinutes(x);
        if (isUnshared(x)) drafts += 1;
        if (!x.email && counts(x)) open += x.openSlots || 1;
      });
      return { people: set.size, min, drafts, open };
    };
    return {
      list: groups.map((g, i) => ({ id: g.id, name: g.name, archived: !!g.archived, color: teamColor(g.id, i), ...statFor(g.members || [], (x) => x.groupId === g.id) })),
      all: statFor([...known], () => true),
      none: statFor(noTeamEmails, (x) => !x.groupId || !groupIdSet.has(x.groupId)),
    };
  }, [data, days, groups, empByEmail, noTeamEmails, groupIdSet]);

  // Paid minutes per person per week, from everything loaded.
  const weekLoad = useMemo(() => {
    const m = {};
    (data?.scheduled || []).forEach((s) => {
      if (!s.email || !counts(s)) return;
      const k = `${s.email}|${isoDate(weekStartOf(new Date(`${s.date}T00:00`), weekStart))}`;
      m[k] = (m[k] || 0) + paidMinutes(s);
    });
    return m;
  }, [data, weekStart]);
  const overWeeks = (email) => Object.entries(weekLoad).filter(([k, v]) => k.startsWith(`${email}|`) && v > WEEK_LIMIT_MIN).map(([, v]) => v);
  const empWeekMin = (email) => days.reduce((sum, d) => sum + (byCell[`${email}|${isoDate(d)}`] || []).filter(counts).reduce((a, s) => a + paidMinutes(s), 0), 0);
  const dayStats = (d) => {
    const ds = isoDate(d);
    let min = 0, shifts = 0; const people = new Set();
    shown.forEach((s) => { if (s.date === ds && counts(s) && s.email) { min += paidMinutes(s); shifts += 1; people.add(s.email); } });
    return { min, shifts, people: people.size };
  };
  const weekMin = shown.filter((s) => s.email && counts(s)).reduce((a, s) => a + paidMinutes(s), 0);
  const rowEditable = (email) => canManage && (!email || empByEmail[email]?.canEdit !== false);
  const shiftEditable = (s) => canManage && s.canEdit !== false;
  const readOnlyMsg = 'You can view this group, but only its own manager can change its schedule.';
  const localUnshared = (data?.scheduled || []).filter(isUnshared).length;
  const unsharedCount = Number.isFinite(Number(data?.unsharedCount)) && data?.unsharedCount != null ? Number(data.unsharedCount) : localUnshared;
  const discardCount = (data?.scheduled || []).filter((s) => s.hasChanges || s.pendingDelete).length;

  // ── API actions ────────────────────────────────────────────────────────
  // Undo (10/02): after a delete, move, paste, place or fill, a bar with
  // Undo for five seconds; Undo puts it back through the same API calls.
  const undoTimer = useRef(null);
  const offerUndo = (msg, fn) => {
    clearTimeout(undoTimer.current);
    if (!fn) { setUndo(null); toastOk?.(msg); return; }
    const key = Date.now();
    setUndo({ msg, fn, key });
    undoTimer.current = setTimeout(() => setUndo((u) => (u?.key === key ? null : u)), MOTION.undoMs);
  };
  useEffect(() => () => clearTimeout(undoTimer.current), []);
  async function run(fn, { ok, fail, after, undo: undoOf } = {}) {
    setBusy(true);
    try {
      const r = await fn();
      const msg = ok ? (typeof ok === 'function' ? ok(r) : ok) : '';
      const back = undoOf?.(r) || null;
      if (back) offerUndo(msg || 'Done.', back);
      else if (msg) toastOk?.(msg);
      after?.(r);
      load();
      return r;
    } catch (e) {
      setLeaving(new Set());
      toastErr?.(e?.message || fail || 'Something went wrong.'); return null;
    } finally { setBusy(false); }
  }
  const undoNow = () => {
    const u = undo; if (!u) return;
    clearTimeout(undoTimer.current); setUndo(null);
    run(u.fn, { ok: 'Undone.', fail: 'Could not undo that.' });
  };
  const publish = (payload) => run(() => api.timeSchedPublish(payload), {
    ok: (r) => {
      const bits = [];
      if (r.added) bits.push(`${r.added} new`);
      if (r.updated || r.edited) bits.push(`${r.updated || r.edited} changed`);
      if (r.removed) bits.push(`${r.removed} removed`);
      const told = r.notified ? ` ${r.notified} ${r.notified === 1 ? 'person' : 'people'} notified.` : '';
      return r.published ? `Shared with the team: ${bits.length ? bits.join(', ') : `${r.published} shift${r.published !== 1 ? 's' : ''}`}.${told}` : 'Nothing new to share.';
    }, fail: 'Could not share the schedule.', after: () => setOpen('') });
  const pasteInto = (email, date, groupId = '') => copied && run(() => api.timeSchedCreate({ employee_email: email, work_date: date, shift_id: copied.shiftId,
    start_hhmm: copied.start, end_hhmm: copied.end, label: copied.label, note: copied.note, break_min: copied.breakMin ?? 0, color: copied.ownColor || '',
    activities: copied.activities || [], group_id: email ? (copied.groupId || '') : (groupId || copied.groupId || ''), ...(email ? {} : { open_slots: 1 }) }),
  { ok: 'Shift copied here.', fail: 'Could not paste the shift.', undo: (r) => (r?.id ? () => api.timeSchedDelete(r.id) : null) });
  const saveCell = (payload) => run(() => (payload.id ? api.timeSchedUpdate(payload.id, payload) : api.timeSchedCreate(payload)),
    { ok: (r) => (r?.hasChanges ? 'Change saved. The team sees it once you share.' : 'Shift saved.'), fail: 'Could not save.', after: () => setPanel(null) });
  const delCell = (id) => {
    const s = (data?.scheduled || []).find((x) => x.id === id);
    if (s && s.published === false && !reduce) setLeaving((l) => new Set([...l, id]));   // a draft shrinks out while it goes
    return run(() => api.timeSchedDelete(id), {
      ok: (r) => (r?.pending ? "Marked for removal. It stays on the team's schedule until you share." : 'Shift removed.'), fail: 'Could not remove.', after: () => setPanel(null),
      undo: (r) => (!s ? null : r?.pending ? (s.hasChanges ? null : () => api.timeSchedDiscard(id)) : () => api.timeSchedCreate(createPayload(s))),
    });
  };
  const discardCell = (id) => run(() => api.timeSchedDiscard(id), { ok: 'Changes discarded.', fail: 'Could not discard the changes.', after: () => setPanel(null) });
  const assignOpen = (id, email) => run(() => api.timeSchedAssign(id, email), { ok: 'Shift assigned.', fail: 'Could not assign.', after: () => setPanel(null) });
  const moveShift = (s, email, date, duplicate) => {
    if (!duplicate && s.email === email && s.date === date) return;
    run(() => api.timeSchedMove(s.id, { employee_email: email, work_date: date, duplicate }), {
      ok: (r) => (duplicate ? 'Shift copied here as a draft.' : !email ? 'Moved to open shifts.' : r?.sourcePending ? 'Shift moved. The team keeps the original until you share.' : 'Shift moved.'),
      fail: 'Could not move the shift.', after: () => setPanel(null),
      undo: (r) => (!r?.shift?.id || (!duplicate && s.hasChanges) ? null : async () => {
        await api.timeSchedDelete(r.shift.id);
        if (duplicate) return;
        if (r.sourcePending) await api.timeSchedDiscard(s.id);
        else await api.timeSchedCreate(createPayload(s));
      }) });
  };
  const placePreset = (p, email, date, groupId = '') => run(() => api.timeSchedCreate({ employee_email: email, work_date: date, shift_id: p.id, group_id: groupId, ...(email ? {} : { open_slots: 1 }) }),
    { ok: `${p.code || p.name} placed as a draft.`, fail: 'Could not place the shift.', undo: (r) => (r?.id ? () => api.timeSchedDelete(r.id) : null) });
  // Fill usual hours for some people across the visible dates (one bulk call
  // per shift type); Undo removes exactly the drafts it made.
  async function fillUsual(emails, who) {
    const byPreset = {};
    emails.forEach((e) => { const p = usualOf(e); if (p) (byPreset[p.id] ||= { p, emails: [] }).emails.push(e); });
    const batches = Object.values(byPreset);
    if (!batches.length) { toastErr?.(`${who} ${emails.length === 1 ? 'has' : 'have'} no usual hours yet. Set them from a person's ⋯ menu.`); return; }
    const before = new Set((data?.scheduled || []).map((x) => x.id));
    setBusy(true);
    try {
      let made = 0;
      for (const b of batches) {
        const r = await api.timeSchedBulk({ shift_id: b.p.id, emails: b.emails, start_date: start, end_date: end, weekdays: presetWeekdays(b.p), skip_timeoff: true, overwrite: false });
        made += Number(r?.created) || 0;
      }
      const next = await api.timeSchedule(start, end);
      if (next) setData(next);
      const set = new Set(emails);
      const ids = (next?.scheduled || []).filter((x) => !before.has(x.id) && set.has(x.email) && x.published === false).map((x) => x.id);
      const msg = made ? `Placed ${made} shift${made === 1 ? '' : 's'} from usual hours for ${who}.` : `Nothing to fill - every usual day for ${who} already has a shift or time off.`;
      offerUndo(msg, ids.length ? async () => { for (const id of ids) await api.timeSchedDelete(id); } : null);
    } catch (e) { toastErr?.(e?.message || 'Could not fill the usual hours.'); }
    finally { setBusy(false); }
  }
  const copyLastWeek = (g) => run(() => api.timeSchedCopy({ source_start: addDaysIso(start, -7), source_end: addDaysIso(start, -1), target_start: start, weeks: 1,
    include_open: !g?.id, include_notes: true, include_activities: true, skip_timeoff: true, overwrite: false, include_timeoff: false, ...(g?.id ? { group_id: g.id } : {}) }), {
    ok: (r) => (r?.created ? `Copied ${r.created} shift${r.created === 1 ? '' : 's'} from last week as drafts. Share to send them.` : 'Last week had no shifts to copy.'),
    fail: 'Could not copy last week.' });
  const recolor = (s, color) => run(() => api.timeSchedUpdate(s.id, { employee_email: s.email, work_date: s.date, shift_id: s.shiftId, start_hhmm: s.start, end_hhmm: s.end,
    label: s.label, note: s.note, break_min: s.breakMin ?? 0, activities: s.activities || [], color, group_id: s.groupId || '', ...(s.email ? {} : { open_slots: s.openSlots || 1 }) }),
  { ok: 'Color changed.', fail: 'Could not change the color.' });
  const setUsual = (email, shiftId) => run(() => api.timeShiftAssign({ shift_id: shiftId || '', emails: [email] }),
    { ok: shiftId ? `${names[email]} is on ${presets.find((p) => p.id === shiftId)?.name || 'that shift type'} as their usual hours.` : `${names[email]} has no usual hours now.`, fail: 'Could not change the usual hours.' });
  const saveTimeOff = (payload, approve) => run(async () => { const r = await api.timeOffOnBehalf(payload); if (approve) await api.timeOffDecide(r.id, { status: 'approved', note: '' }); return r; },
    { ok: approve ? `Time off added for ${names[payload.employee_email] || nameOf(payload.employee_email)}.` : `Time-off request added for ${names[payload.employee_email] || nameOf(payload.employee_email)} - decide it in Requests.`, fail: 'Could not add the time off.', after: () => setPanel(null) });
  const saveDayNote = (date, note, groupId) => run(() => api.timeSchedDayNote({ work_date: date, note, ...(groupId ? { group_id: groupId } : {}) }),
    { ok: note.trim() ? 'Day note saved.' : 'Day note removed.', fail: 'Could not save the note.', after: () => setOpen('') });
  const importRows = async (rows) => {
    const r = await run(() => api.timeSchedImport({ rows }), { ok: (x) => `Added ${x.created} shift${x.created === 1 ? '' : 's'} as drafts.${x.errorCount ? ` ${x.errorCount} row${x.errorCount === 1 ? '' : 's'} skipped.` : ''} Share to send them.`, fail: 'Could not import the schedule.' });
    if (r && !r.errorCount) setOpen('');
    return r;
  };
  const copySchedule = (payload) => run(() => api.timeSchedCopy(payload), {
    ok: (r) => {
      const bits = [`Copied ${r.created} shift${r.created !== 1 ? 's' : ''} to ${formatDate(r.targetStart)} - ${formatDate(r.targetEnd)} as drafts`];
      if (r.replaced) bits.push(`replaced ${r.replaced}`);
      if (r.skipped) bits.push(`kept ${r.skipped} existing`);
      if (r.timeoffSkipped) bits.push(`skipped ${r.timeoffSkipped} on time off`);
      if (r.timeoffCopied) bits.push(`${r.timeoffCopied} time-off request${r.timeoffCopied !== 1 ? 's' : ''} to approve in Requests`);
      return `${bits.join(' · ')}. Share to send them.`;
    }, fail: 'Could not copy the schedule.', after: () => setOpen('') });
  const clearSchedule = (payload) => run(() => api.timeSchedClear(payload), {
    ok: (r) => { const bits = []; if (r.removed) bits.push(`${r.removed} draft${r.removed !== 1 ? 's' : ''} removed`); if (r.pending) bits.push(`${r.pending} shared shift${r.pending !== 1 ? 's' : ''} marked for removal until you share`); return bits.length ? `${bits.join(' · ')}.` : 'There were no shifts to clear.'; },
    fail: 'Could not clear the schedule.', after: () => setOpen('') });
  const bulkAssign = (payload) => run(() => api.timeSchedBulk(payload), {
    ok: (r) => { const bits = [`Placed ${r.created} shift${r.created !== 1 ? 's' : ''} across ${r.people} ${r.people === 1 ? 'person' : 'people'}`]; if (r.replaced) bits.push(`replaced ${r.replaced}`); if (r.skipped) bits.push(`kept ${r.skipped} existing`); if (r.timeoffSkipped) bits.push(`skipped ${r.timeoffSkipped} on time off`); return `${bits.join(' · ')}.`; },
    fail: 'Could not fill the schedule.', after: () => setOpen('') });
  async function discardAll() {
    const ok = await dialog.confirm(`Discard ${discardCount} unshared change${discardCount === 1 ? '' : 's'} in this ${view === 'month' ? 'month' : view === 'day' ? 'day' : 'week'}? Edited and removed shifts go back to what the team sees now. New drafts stay.`,
      { title: 'Discard Changes', confirmText: 'Discard' });
    if (!ok) return;
    run(() => api.timeSchedDiscardAll({ start_date: start, end_date: end }), { ok: (r) => `Discarded ${r.discarded} unshared change${r.discarded === 1 ? '' : 's'}.`, fail: 'Could not discard the changes.' });
  }
  async function teamAction(g, action) {
    const group = groups.find((x) => x.id === g.id) || g;
    if (action === 'rename') {
      const name = await dialog.prompt('Group name', { title: 'Rename Group', defaultValue: group.name, required: true, confirmText: 'Rename' });
      if (name && name.trim() && name.trim() !== group.name) run(() => api.timeShiftGroupMeta(group.id, { name: name.trim() }), { ok: 'Group renamed.', fail: 'Could not update the group.' });
    } else if (action === 'archive') {
      run(() => api.timeShiftGroupMeta(group.id, { archived: !group.archived }), { ok: group.archived ? `${group.name} restored.` : `${group.name} archived. Find it under Archived Groups.`, fail: 'Could not update the group.' });
      if (!group.archived && groupFilter === group.id) { setTeamPick(null); try { localStorage.removeItem(teamKey); } catch { /* */ } }
    } else if (action === 'reorder') setOpen('reorder');
    else if (action === 'manage') window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'admin-console', sub: 'global-shifts' } }));
    else if (action === 'delete') {
      const ok = await dialog.confirm(`Delete the group ${group.name}? Its people stay on the schedule; only the group goes.`, { title: 'Delete Group', confirmText: 'Delete', danger: true });
      if (ok) { if (groupFilter === group.id) { setTeamPick(null); setFrozenDefault(null); try { localStorage.removeItem(teamKey); } catch { /* */ } } run(() => api.timeShiftGroupDelete(group.id), { ok: 'Group deleted.', fail: 'Could not delete the group.' }); }
    }
  }
  const saveOrder = async (ids) => {
    const r = await run(() => api.timeShiftGroupOrder(ids).catch((e) => (e?.status === 404 ? api.timeShiftGroupReorder(ids) : Promise.reject(e))), { ok: 'Group order saved.', fail: 'Could not save the order.' });
    if (r) setOpen('');
  };

  // ── Clipboard, menus, keyboard ─────────────────────────────────────────
  const copyShift = (s) => { setCopied(s); toastOk?.('Shift copied. Click an empty day to place it, or press Ctrl+V over one.'); };
  const openShiftEditor = (s, email, ds) => {
    if (!shiftEditable(s)) { setDetails({ x: 200, y: 200, shift: s, readOnly: true }); return; }
    if (!email && s.canEdit === false) { toastErr?.('This open shift was posted by another manager - only they or an administrator can change it.'); return; }
    setPanel({ cell: { email: email || '', date: ds, existing: s, groupId: s.groupId || '' }, mode: 'shift' });
  };
  function menuAction(action, arg) {
    const m = menu; setMenu(null);
    if (!m) return;
    const s = m.shift;
    if (action === 'edit') openShiftEditor(s, s.email, s.date);
    else if (action === 'details') setDetails({ x: m.x, y: m.y, shift: s, readOnly: !shiftEditable(s) });
    else if (action === 'add') setPanel({ cell: { email: m.email, date: m.date, groupId: m.groupId }, mode: 'shift' });
    else if (action === 'place') placePreset(arg, m.email, m.date, m.groupId);
    else if (action === 'timeoff') setPanel({ cell: { email: m.email, date: m.date }, mode: 'timeoff' });
    else if (action === 'color') recolor(s, arg);
    else if (action === 'toOpen') moveShift(s, '', s.date, false);
    else if (action === 'copy') copyShift(s);
    else if (action === 'paste') pasteInto(m.email, m.date, m.groupId);
    else if (action === 'delete') delCell(s.id);
  }
  function personAction(action, arg) {
    const m = personMenu; setPersonMenu(null);
    if (!m) return;
    if (action === 'add') setPanel({ cell: { email: m.emp.email, date: start, groupId: m.group?.id || '' }, mode: 'shift' });
    else if (action === 'timeoff') setPanel({ cell: { email: m.emp.email, date: start }, mode: 'timeoff' });
    else if (action === 'usual') setUsual(m.emp.email, arg);
    else if (action === 'fill') fillUsual([m.emp.email], m.emp.name);
  }
  const openMenu = (e, ctx) => {
    if (!canManage) return;
    e.preventDefault(); e.stopPropagation();
    if (ctx.shift ? !shiftEditable(ctx.shift) : !rowEditable(ctx.email)) return;
    setMenu({ x: e.clientX, y: e.clientY, ...ctx, shift: ctx.shift && !ctx.shift.pendingDelete ? ctx.shift : null });
  };
  // Long-press on a touch screen opens the same menu (Teams parity); the
  // press is cancelled by moving or lifting the finger first.
  const longPress = (e, ctx) => {
    if (!canManage || e.pointerType !== 'touch') return;
    e.stopPropagation();   // the cell under a shift must not restart the press with its own context
    clearTimeout(pressRef.current?.timer);
    const at = { x: e.clientX, y: e.clientY };
    const timer = setTimeout(() => {
      pressRef.current = null;
      if (ctx.shift ? !shiftEditable(ctx.shift) : !rowEditable(ctx.email)) return;
      setMenu({ x: at.x, y: at.y, ...ctx, shift: ctx.shift && !ctx.shift.pendingDelete ? ctx.shift : null });
    }, LONG_PRESS_MS);
    const cancel = () => { clearTimeout(timer); window.removeEventListener('pointerup', cancel); window.removeEventListener('pointermove', move); };
    const move = (ev) => { if (Math.hypot(ev.clientX - at.x, ev.clientY - at.y) > 10) cancel(); };
    window.addEventListener('pointerup', cancel);
    window.addEventListener('pointermove', move);
    pressRef.current = { timer };
  };
  const keysRef = useRef(null);
  useEffect(() => { keysRef.current = { copied, canManage, copyShift, pasteInto }; });
  useEffect(() => {
    const onKey = (e) => {
      const k = keysRef.current;
      if (!k?.canManage || !(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (e.target?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      if (window.getSelection?.()?.toString()) return;
      const key = (e.key || '').toLowerCase();
      const { shift, cell: at } = hoverRef.current;
      if (key === 'c' && shift && !shift.pendingDelete) { e.preventDefault(); k.copyShift(shift); }
      else if (key === 'v' && at && k.copied) { e.preventDefault(); k.pasteInto(at.email, at.date, at.groupId); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const hoverCell = (email, date, groupId) => ({
    onMouseEnter: () => { hoverRef.current.cell = { email, date, groupId }; },
    onMouseLeave: () => { hoverRef.current.cell = null; },
    onFocus: () => { hoverRef.current.cell = { email, date, groupId }; },
  });
  const hoverShift = (s) => ({
    onMouseEnter: () => { hoverRef.current.shift = s; },
    onMouseLeave: () => { hoverRef.current.shift = null; },
    onFocus: () => { hoverRef.current.shift = s; },
  });

  // ── Drag and drop (pointer events: mouse and pen; touch long-presses) ──
  // Drop = move, Ctrl/Alt-drop = copy. A person's shift can go to anyone or
  // to an Open Shifts row; an open shift stays open (Assign gives it away).
  const accepts = (payload, email) => !!payload && rowEditable(email) && (!!payload.email || !email);
  const dropAt = (x, y) => document.elementFromPoint?.(x, y)?.closest?.('[data-drop]') ?? null;
  const beginDrag = (e, payload) => {
    const btn = e.target.closest?.('button');
    if (!canManage || e.pointerType === 'touch' || e.button !== 0 || (btn && btn !== e.currentTarget)) return;
    e.preventDefault();
    const from = { x: e.clientX, y: e.clientY };
    let moved = false;
    const label = `${payload.code || 'Shift'} ${shiftTimeText(payload)}`;
    const move = (ev) => {
      if (!moved && Math.hypot(ev.clientX - from.x, ev.clientY - from.y) < 5) return;
      if (!moved) { moved = true; setDrag(payload); document.body.classList.add('sched-dragging'); }
      setGhost({ x: ev.clientX, y: ev.clientY, label, copy: !!(ev.ctrlKey || ev.altKey) });
      const el = dropAt(ev.clientX, ev.clientY);
      const key = el?.getAttribute('data-drop');
      setDropKey(key != null && accepts(payload, key.split('|')[0]) ? key : '');
    };
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('sched-dragging');
      setGhost(null); setDrag(null); setDropKey('');
      if (!moved) return;
      suppressClick.current = true;
      setTimeout(() => { suppressClick.current = false; }, 0);
      const el = dropAt(ev.clientX, ev.clientY);
      const key = el?.getAttribute('data-drop');
      if (key == null) return;
      const [email, ds] = key.split('|');
      if (!accepts(payload, email)) return;
      moveShift(payload, email, ds, !!(ev.ctrlKey || ev.altKey));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const dragProps = (s) => (shiftEditable(s) && !s.pendingDelete ? { onPointerDown: (e) => beginDrag(e, s) } : {});
  const dropProps = (email, ds) => ({ 'data-drop': `${email}|${ds}` });
  const clickable = (fn) => (e) => { if (suppressClick.current) { e.stopPropagation(); return; } fn(e); };
  const dropStyle = (email, ds) => (dropKey === `${email}|${ds}` ? { outline: '2px dashed var(--wk-brand)', outlineOffset: -3, background: 'var(--wk-brand-tint)' } : {});
  // Drag a person onto another group's header: they join it and leave the
  // one they were dragged from (when you may change both).
  const canMovePeople = canManage && groupBy === 'group' && prefs.teams !== false && groups.some((g) => g.canEdit);
  const personDragProps = (emp, from) => (canMovePeople && from.isGroup ? {
    onPointerDown: (e) => {
      if (e.pointerType === 'touch' || e.button !== 0 || e.target.closest?.('button')) return;
      e.preventDefault();
      const at = { x: e.clientX, y: e.clientY };
      let moved = false;
      const teamAt = (x, y) => document.elementFromPoint?.(x, y)?.closest?.('[data-team]')?.getAttribute('data-team') ?? null;
      const target = (id) => groups.find((g) => g.id === id && g.canEdit && id !== from.id);
      const move = (ev) => {
        if (!moved && Math.hypot(ev.clientX - at.x, ev.clientY - at.y) < 5) return;
        if (!moved) { moved = true; document.body.classList.add('sched-dragging'); }
        setGhost({ x: ev.clientX, y: ev.clientY, label: emp.name });
        const id = teamAt(ev.clientX, ev.clientY);
        setDropKey(id && target(id) ? `team:${id}` : '');
      };
      const up = (ev) => {
        window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
        document.body.classList.remove('sched-dragging');
        setGhost(null); setDropKey('');
        if (!moved) return;
        const to = target(teamAt(ev.clientX, ev.clientY));
        if (!to) return;
        run(async () => { await api.timeShiftGroupMembers(to.id, { add: [emp.email] }); if (from.id && from.canEdit) await api.timeShiftGroupMembers(from.id, { remove: [emp.email] }); },
          { ok: `${emp.name} moved to ${to.name}.`, fail: 'Could not move them.' });
      };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    },
    title: 'Drag onto a group to move them', style: { cursor: 'grab' },
  } : {});

  // ── Export, print ──────────────────────────────────────────────────────
  const presetName = (id) => { const p = presets.find((x) => x.id === id); return p ? (p.code || p.name) : ''; };
  const groupName = (id) => groups.find((g) => g.id === id)?.name || '';
  async function exportSchedule() {
    const rows = [...shown].sort((a, b) => a.date.localeCompare(b.date) || (names[a.email] || '~').localeCompare(names[b.email] || '~') || a.start.localeCompare(b.start));
    try {
      await exportExcel({
        title: 'Schedule', filename: `schedule-${start}-to-${end}.xlsx`, rows,
        columns: [
          { header: 'Date', get: (s) => formatDate(s.date), width: 12 },
          { header: 'Day', get: (s) => formatWeekday(s.date, 'short'), width: 6 },
          { header: 'Employee', get: (s) => (s.email ? names[s.email] || nameOf(s.email) : 'Open Shift'), width: 24 },
          { header: 'Email', get: (s) => s.email, width: 28 },
          { header: 'Group', get: (s) => groupName(s.groupId), width: 16 },
          { header: 'Shift Type', get: (s) => presetName(s.shiftId), width: 14 },
          { header: 'Start', get: (s) => formatHHMM(s.start), width: 10 },
          { header: 'End', get: (s) => formatHHMM(s.end), width: 10 },
          { header: 'Unpaid Break (min)', get: (s) => Number(s.breakMin) || 0, width: 12 },
          { header: 'Paid Hours', get: (s) => hrsNumber(paidMinutes(s)), width: 10 },
          { header: 'Label', get: (s) => s.label, width: 18 },
          { header: 'Note', get: (s) => s.note, width: 24 },
          { header: 'Activities', get: (s) => (s.activities || []).map((a) => `${formatHHMM(a.start)}-${formatHHMM(a.end)} ${a.label}${a.paid === false ? ' (unpaid)' : ''}`).join('; '), width: 30 },
          { header: 'Open Spots', get: (s) => (s.email ? '' : s.openSlots || 1), width: 10 },
          { header: 'Status', get: (s) => shiftState(s).text, width: 20 },
        ],
      });
    } catch (e) { toastErr?.(e?.message || 'Could not export the schedule.'); }
  }
  function printView() {
    const openByDate = {};
    Object.entries(openCells).forEach(([k, v]) => { if (k !== '__ungrouped') (openByDate[k.split('|')[1]] ||= []).push(...v); });
    const ok = printSchedule({ title: `Schedule ${formatDate(start)} - ${formatDate(end)}`, days, groups: sections, byCell, openByDate,
      offOn: (email, ds) => offOn(email, ds)[0], holOn, notes });
    if (!ok) toastErr?.('Allow pop-ups for this site to print the schedule.');
  }

  // ── Navigation ─────────────────────────────────────────────────────────
  const shiftRange = (n) => { setSlide(n > 0 ? 1 : -1); setCursor((c) => {
    const d = new Date(c);
    if (view === 'month') return new Date(d.getFullYear(), d.getMonth() + n, 1);
    d.setDate(d.getDate() + n * (view === 'day' ? 1 : view === 'twoweeks' ? 14 : 7));
    return d;
  }); };
  const jumpTo = (ds) => { setSlide(ds < start ? -1 : ds > end ? 1 : 0); setCursor(parseIso(ds)); };
  const goToday = () => jumpTo(isoDate(new Date()));
  const showToday = !(isoDate(new Date()) >= start && isoDate(new Date()) <= end);
  const openDay = (ds) => { const [y, m, d] = ds.split('-').map(Number); setCursor(new Date(y, m - 1, d)); setView('day'); };
  const pickView = (k) => setView(k === 'week' && prefs.twoWeeks ? 'twoweeks' : k);
  // Folded groups: what the user chose, else a group (when there are
  // several sections) is folded when nothing is in view - no shifts, no open
  // shifts, nobody off. "Everyone" and a lone group never fold by themselves.
  const collapsed = useMemo(() => {
    const set = new Set();
    sections.forEach((g) => {
      const key = sectionKey(g);
      if (!g.isGroup || sections.length < 2) { if (fold[key]) set.add(key); return; }
      const busyGroup = days.some((d) => { const ds = isoDate(d); return (openCells[`${g.id || ''}|${ds}`] || []).length || g.members.some((m) => (byCell[`${m.email}|${ds}`] || []).length || offOn(m.email, ds).length); });
      if (fold[key] ?? !busyGroup) set.add(key);
    });
    return set;
  }, [sections, days, openCells, byCell, offOn, fold]);
  const toggleCollapse = (key) => setFold({ ...fold, [key]: !collapsed.has(key) });

  const gridOn = {
    cellClick: (email, ds, groupId, e) => {
      if (copied) { pasteInto(email, ds, groupId); return; }
      const usual = !e?.shiftKey && ghostOf(email, ds);
      if (usual) placePreset(usual, email, ds, groupId);
      else setPanel({ cell: { email, date: ds, groupId }, mode: 'shift' });
    },
    enterCell: (key) => { const [email, ds] = key.split('|'); if (!rowEditable(email)) return; if (copied) pasteInto(email, ds); else setPanel({ cell: { email, date: ds }, mode: 'shift' }); },
    deleteKey: (id) => { const s = (data?.scheduled || []).find((x) => x.id === id); if (s && shiftEditable(s) && s.published === false && !s.pendingDelete) delCell(s.id); },
    menuAt: ({ x, y, cell, shift }) => { const [email, ds] = cell.split('|'); const s = shift ? (data?.scheduled || []).find((q) => q.id === shift) : null; openMenu({ preventDefault() {}, stopPropagation() {}, clientX: x, clientY: y }, { email, date: ds, shift: s, groupId: s?.groupId || '' }); },
    openShift: (e, s, email, ds) => openShiftEditor(s, email, ds),
    menu: openMenu, longPress,
    details: (e, s) => setDetails({ x: e.clientX, y: e.clientY, shift: s, readOnly: !shiftEditable(s) }),
    personMenu: (e, emp, g) => setPersonMenu({ x: e.clientX, y: e.clientY, emp, group: g }),
    openDay, noteEdit: (ds) => { setNoteDate(ds); setOpen('note'); },
    addMembers: (g) => setAddTo(groups.find((x) => x.id === g.id)),
    teamAction, toggleCollapse,
    add: (email, ds, groupId) => (!rowEditable(email) ? toastErr?.(readOnlyMsg) : setPanel({ cell: { email, date: ds, groupId }, mode: 'shift' })),
    paste: (email, ds, groupId) => pasteInto(email, ds, groupId),
  };
  const ready = !!data;
  // The usual shift an empty day would get on a click (none on a whole day
  // off, a holiday, or a day outside the shift type's days).
  function ghostOf(email, ds) {
    if (!email || !managing || copied) return null;
    const p = usualOf(email);
    if (!p || !presetOnDay(p, ds) || dayFullyOff(offOn(email, ds)) || holOn(email, ds)) return null;
    return p;
  }
  // Blocks that just arrived pop in; a draft being removed shrinks out.
  const seenRef = useRef(null);
  useEffect(() => {
    if (!data) { seenRef.current = null; return undefined; }
    const ids = new Set((data.scheduled || []).map((x) => x.id));
    const prev = seenRef.current;
    seenRef.current = { start, ids };
    setLeaving((l) => (l.size ? new Set() : l));
    if (reduce || !prev || prev.start !== start) return undefined;
    const added = [...ids].filter((id) => !prev.ids.has(id));
    if (!added.length) return undefined;
    setFresh(new Set(added));
    const t = setTimeout(() => setFresh(new Set()), MOTION.pop + 240);
    return () => clearTimeout(t);
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  const blockClass = (x) => (reduce ? '' : leaving.has(x.id) ? 'm-leave' : fresh.has(x.id) ? 'm-pop' : '');
  useEffect(() => { if (data) { const t = setTimeout(() => { glowRef.current = false; }, MOTION.glow); return () => clearTimeout(t); } return undefined; }, [data]);

  // Keyboard: Left / Right move a week (outside the grid and any field), T
  // is today, 1-9 pick a team while the schedule has focus.
  const [keysOpen, setKeysOpen] = useState(false);
  const navRef = useRef(null);
  useEffect(() => { navRef.current = { shiftRange, goToday, pickTeam, liveGroups, blocked: !!panel || !!open || !!menu || !!personMenu || keysOpen }; });
  useEffect(() => {
    const onKey = (e) => {
      const k = navRef.current;
      if (!k || k.blocked || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      if (t?.closest?.('input, textarea, select, [contenteditable="true"], [role="menu"], [role="listbox"], [role="dialog"], [data-cell], [data-shift]')) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        if (t?.closest?.('button') && !t.closest('[data-sched-root]')) return;
        e.preventDefault(); k.shiftRange(e.key === 'ArrowRight' ? 1 : -1);
      } else if (e.key === 't' || e.key === 'T') { e.preventDefault(); k.goToday(); }
      else if (/^[1-9]$/.test(e.key) && (t === document.body || t?.closest?.('[data-sched-root]'))) {
        const g = k.liveGroups[Number(e.key) - 1];
        if (g) { e.preventDefault(); k.pickTeam(g.id); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // A team with nothing in view: one friendly row, Fill Usual Hours and Copy
  // Last Week a click away.
  const soleSection = single && sections.length === 1 ? sections[0] : null;
  const teamIsEmpty = !!soleSection && !!data && view !== 'month' && view !== 'day'
    && !soleSection.members.some((m) => days.some((d) => (byCell[`${m.email}|${isoDate(d)}`] || []).length))
    && !Object.keys(openCells).some((k) => k !== '__ungrouped' && (openCells[k] || []).length);
  const teamName = mode === 'none' ? 'People Without a Team' : soleSection?.name || '';
  const emptyNote = teamIsEmpty ? (
    <div style={{ position: 'sticky', left: 0, display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px', flexWrap: 'wrap', maxWidth: 'min(100%, 92vw)' }}>
      <span aria-hidden="true" style={{ width: 36, height: 36, borderRadius: 10, background: 'var(--wk-brand-tint)', color: 'var(--wk-brand)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <CalendarPlus size={17} />
      </span>
      <span style={{ minWidth: 0, flex: '1 1 260px' }}>
        <div style={{ fontSize: 13.5, fontWeight: 700 }}>No shifts yet for {teamName} {days.length > 7 ? 'in these two weeks' : 'this week'}</div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
          {managing ? "Place everyone's usual hours in one go, or bring last week forward. Both land as drafts until you share." : 'Nothing is scheduled here yet.'}
        </div>
      </span>
      {managing && (
        <span style={{ display: 'inline-flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="primary-btn" disabled={busy} onClick={() => fillUsual(soleSection.members.filter((m) => rowEditable(m.email)).map((m) => m.email), teamName)}
            style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}><CalendarDays size={13} /> Fill Usual Hours</button>
          <button type="button" className="secondary-btn" disabled={busy} onClick={() => copyLastWeek(soleSection.isGroup ? soleSection : null)}
            style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}><CopyIcon size={13} /> Copy Last Week</button>
        </span>
      )}
    </div>
  ) : null;
  // In one team's view the team's tools (Add Members, Rename, Archive...)
  // sit in the grid's corner cell, where the group header used to carry them.
  const cornerTools = managing && soleSection?.isGroup && soleSection.canEdit ? (
    <TeamMenu team={soleSection} canReorder={soleSection.canReorder} withAdd trigger={{ ...TOOL_BTN, fontSize: 13, lineHeight: 1, fontWeight: 800 }}
      onAction={(a) => (a === 'add' ? setAddTo(groups.find((x) => x.id === soleSection.id)) : teamAction(soleSection, a))} />
  ) : null;
  const personFill = (emp) => fillUsual([emp.email], emp.name);

  // Coverage (10/02): per team and day, expected vs on. A manager sees it by
  // default, a viewer turns it on under ⋯; the choice is remembered.
  const showCoverage = prefs.coverage ?? managing;
  const dayIsos = useMemo(() => days.map(isoDate), [days]);
  const coverageOf = showCoverage && groupBy === 'group' ? (g) => coverageFor(g.members, dayIsos, { byCell, offOn, usualOf }) : null;
  const [pulseCells, setPulseCells] = useState(null);
  // Bring a cell or block into view by scrolling the grid itself (and the
  // page only up or down) - scrollIntoView also slid the whole app sideways.
  const reveal = (el) => {
    if (!el) return;
    const behavior = reduce ? 'auto' : 'smooth';
    const grid = el.closest('.week-grid');
    const r = el.getBoundingClientRect();
    if (grid) {
      const g = grid.getBoundingClientRect();
      const dx = r.left < g.left + 200 ? r.left - g.left - 200 : r.right > g.right ? r.right - g.right + 12 : 0;
      const dy = r.top < g.top + 60 ? r.top - g.top - 60 : r.bottom > g.bottom ? r.bottom - g.bottom + 12 : 0;
      if (dx || dy) grid.scrollBy?.({ left: dx, top: dy, behavior });
    }
    const vh = window.innerHeight || 800;
    if (r.top < 80 || r.bottom > vh - 20) window.scrollBy?.({ top: r.top - vh / 2, behavior });
  };
  const pulseTimer = useRef(null);
  const onCoverage = (c) => {
    const keys = new Set(c.missing.map((m) => `${m.email}|${c.date}`));
    clearTimeout(pulseTimer.current);
    setPulseCells(keys);
    reveal(c.missing[0] && rootRef.current?.querySelector(`[data-cell="${c.missing[0].email}|${c.date}"]`));
    pulseTimer.current = setTimeout(() => setPulseCells(null), 1500);
  };
  useEffect(() => () => clearTimeout(pulseTimer.current), []);
  const conflictCount = prefs.conflicts === false ? 0 : shown.filter((x) => x.email && !x.pendingDelete && conflicts[x.id]?.length).length;
  const goToConflict = () => {
    const el = rootRef.current?.querySelector('.week-grid [data-conflict]');
    if (!el) return;
    reveal(el);
    el.focus?.({ preventScroll: true });
    el.classList.add('m-pulse');
    setTimeout(() => el.classList.remove('m-pulse'), 2600);
  };
  // The manager controls stay on the toolbar while loading or after a failed
  // load (disabled), so the row never jumps - the grid itself says what happened.
  const toolbarManage = data ? canManage : true;

  return (
    <div ref={rootRef} data-sched-root="" style={{ fontFamily: 'Inter,sans-serif' }}>
      <ScheduleToolbar view={view} onView={pickView} onPrev={() => shiftRange(-1)} onNext={() => shiftRange(1)} onToday={goToday}
        range={{ first: start, last: isoDate(days[days.length - 1] || allDays[allDays.length - 1]), weekStart }} onJump={jumpTo} showToday={showToday} slide={reduce ? 0 : slide}
        teamSwitcher={groups.length > 0 ? (
          <TeamPicker teams={teamNumbers.list} value={mode === 'all' ? ALL_TEAMS : team} onChange={pickTeam} all={teamNumbers.all} none={teamNumbers.none}
            compact={phone} shortcuts={!phone} style={phone ? { flex: 1 } : undefined} />
        ) : null}
        canManage={toolbarManage} busy={busy} ready={ready}
        unsharedCount={managing ? unsharedCount : 0} phone={phone}
        onAdd={(kind) => {
          if (kind === 'note') { setNoteDate(view === 'day' ? start : isoDate(new Date()) >= start && isoDate(new Date()) <= end ? isoDate(new Date()) : start); setOpen('note'); return; }
          const date = view === 'day' ? start : (isoDate(new Date()) >= start && isoDate(new Date()) <= end ? isoDate(new Date()) : start);
          const firstPerson = sections.flatMap((g) => g.members).find((m) => rowEditable(m.email))?.email || '';
          if (kind === 'open') setPanel({ cell: { email: '', date, groupId: groupFilter || groups[0]?.id || '' }, mode: 'shift' });
          else setPanel({ cell: { email: firstPerson, date }, mode: kind === 'timeoff' ? 'timeoff' : 'shift' });
        }}
        onShare={() => setOpen('share')}
        actions={{ canTimeOff, hideEmpty: !!prefs.hideEmpty, toggleHideEmpty: () => setPrefs({ ...prefs, hideEmpty: !prefs.hideEmpty }), copy: () => setOpen('copy'), fill: () => setOpen('fill'), clear: () => setOpen('clear'), importFile: () => setOpen('import'),
          exportFile: exportSchedule, print: printView, viewOptions: () => setOpen('view'), discard: discardAll, discardCount, shortcuts: () => setKeysOpen(true),
          coverage: showCoverage, toggleCoverage: () => setPrefs({ ...prefs, coverage: !showCoverage }),
          requests: () => (onOpenRequests ? onOpenRequests() : window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'shifts', sub: 'requests' } }))) }} />

      {(query.trim() || presetFilter || prefs.mine) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, fontSize: 12.5, color: 'var(--muted)', flexWrap: 'wrap' }}>
          <span>Showing {[query.trim() ? `people matching "${query.trim()}"` : '', presetFilter ? presetName(presetFilter) : '', prefs.mine ? 'your shifts only' : ''].filter(Boolean).join(' · ')}</span>
          <button type="button" className="secondary-btn" onClick={() => { setQuery(''); setPresetFilter(''); setPrefs({ ...prefs, mine: false }); }} style={{ fontSize: 12 }}>Clear Filters</button>
        </div>
      )}
      {copied && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, padding: '8px 12px', background: 'var(--wk-brand-tint)', border: '1px dashed var(--wk-brand)', borderRadius: 10, fontSize: 12.5 }}>
          <span style={{ fontWeight: 700 }}>Copied {copied.code || 'shift'} ({shiftTimeText(copied)})</span>
          <span style={{ color: 'var(--muted)' }}>- click any empty day to place it.</span>
          <div style={{ flex: 1 }} />
          <button type="button" className="secondary-btn" onClick={() => setCopied(null)} style={{ fontSize: 12 }}>Cancel</button>
        </div>
      )}

      {error ? (
        <ErrorBanner message={`The schedule could not be loaded - ${error}`} onRetry={load} />
      ) : data === null ? (
        <SkeletonBlocks count={6} height={60} borderRadius={10} />
      ) : (
      <div key={`${start}|${view}|${team}`} className={`${reduce ? '' : slide > 0 ? 'm-slide-next' : slide < 0 ? 'm-slide-prev' : 'm-fade'} ${panel ? 'm-dim' : 'm-undim'}`}>
      {phone && view !== 'month' && groupBy !== 'shift' ? (
        <SchedulePhone single={single} emptyNote={emptyNote} days={days} sections={sections} byCell={byCell} openCells={openCells} offOn={offOn} holOn={holOn} usualOf={usualOf}
          notes={notes} holidayDates={holidayDates} me={me} prefs={prefs} teamZone={teamZone} canManage={managing}
          rowEditable={rowEditable} empWeekMin={empWeekMin} dayStats={dayStats} dragId={drag?.id} collapsed={collapsed} copied={copied} on={gridOn} />
      ) : view === 'day' ? (
        <ScheduleDay single={single} date={start} sections={sections} shifts={shown} openCells={openCells} notes={notes} canManage={managing} offOn={offOn} holOn={holOn}
          copied={copied} prefs={prefs} rowEditable={rowEditable} shiftEditable={shiftEditable} dragId={drag?.id} on={gridOn}
          dragProps={dragProps} dropProps={dropProps} dropStyle={dropStyle} clickable={clickable} />
      ) : view === 'month' ? (
        <ScheduleMonth days={days} shifts={shown.filter((s) => s.email)} openShifts={shown.filter((s) => !s.email)} timeoff={data.timeoff || []}
          holidayDates={holidayDates} holidayNames={holidayNames} notes={notes} visibleEmails={visibleEmails} names={names} people={empByEmail} weekStart={weekStart} onOpenDay={openDay} />
      ) : groupBy === 'shift' ? (
        <ShiftTypeWeek days={days} shifts={shown} presets={presets} names={names} teamZone={teamZone}
          onOpen={(s) => openShiftEditor(s, s.email, s.date)} />
      ) : (
        <WeekGrid days={days} compact={compact} sections={sections} byCell={byCell} openCells={openCells} offOn={offOn} holOn={holOn} availOn={availOn} usualOf={usualOf}
          notes={notes} holidayDates={holidayDates} me={me} prefs={prefs} teamZone={teamZone} canManage={managing}
          rowEditable={rowEditable} empWeekMin={empWeekMin} dayStats={dayStats} weekMin={weekMin} overWeeks={overWeeks}
          copied={copied} dropKey={dropKey} dragId={drag?.id} isCollapsed={(k) => collapsed.has(k)} on={gridOn}
          dragProps={dragProps} personDragProps={personDragProps} dropProps={dropProps} dropStyle={dropStyle} hoverCell={hoverCell} hoverShift={hoverShift} clickable={clickable}
          single={single} emptyNote={emptyNote} cornerTools={cornerTools} ghostOf={ghostOf} blockClass={blockClass} motion={!reduce} glowToday={glowRef.current}
          personFill={managing ? personFill : null} usualCan={(email) => !!usualOf(email)}
          coverageOf={coverageOf} onCoverage={managing ? onCoverage : null} pulseCells={pulseCells} conflictCount={conflictCount} onConflicts={goToConflict} />
      )}
      </div>
      )}
      {data && teamZoneLabel && <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 8 }}>Times in {teamZoneLabel}</div>}

      {ghost && (
        <div style={{ position: 'fixed', left: ghost.x + 12, top: ghost.y + 10, zIndex: 1600, pointerEvents: 'none', fontSize: 11.5, fontWeight: 800, transform: reduce ? 'none' : 'rotate(-2deg)',
          background: 'var(--card)', border: '1px solid var(--wk-brand)', borderRadius: 6, padding: '4px 9px', boxShadow: '0 6px 18px rgba(0,0,0,0.18)' }}>
          {ghost.copy ? `Copy ${ghost.label}` : ghost.label}
        </div>
      )}
      {details && (
        <ShiftDetails at={details} shift={details.shift} name={details.shift.email ? names[details.shift.email] || nameOf(details.shift.email) : 'Open Shift'}
          status={shiftState(details.shift).text} onClose={() => setDetails(null)}
          onEdit={details.readOnly ? undefined : () => { const s = details.shift; setDetails(null); openShiftEditor(s, s.email, s.date); }} />
      )}
      {menu && <ShiftMenu menu={menu} presets={presets} canTimeOff={canTimeOff} hasCopied={!!copied} onAction={menuAction} onClose={() => setMenu(null)} />}
      {personMenu && <PersonMenu menu={personMenu} presets={presets} usualId={data?.usual?.[personMenu.emp.email] || ''} canTimeOff={canTimeOff} onAction={personAction} onClose={() => setPersonMenu(null)} />}
      {panel && (
        <ShiftPanel key={`${panel.cell.email}|${panel.cell.date}|${panel.cell.existing?.id || ''}|${panel.mode}`} cell={panel.cell} initialMode={panel.mode}
          presets={presets} groups={groups.filter((g) => !g.archived)} people={Object.values(empByEmail).filter((e) => e.canEdit !== false)} nameOf={nameOf}
          teamZone={teamZoneLabel} busy={busy} canTimeOff={canTimeOff}
          onSave={saveCell} onAssign={assignOpen} onDelete={delCell} onDiscard={discardCell}
          onCopy={(s) => { copyShift(s); setPanel(null); }} onToOpen={(s) => moveShift(s, '', s.date, false)}
          onSaveTimeOff={saveTimeOff} onClose={() => setPanel(null)} />
      )}
      {open === 'share' && (
        <ShareDialog defaultStart={start} defaultEnd={end} lastPublishedAt={data?.lastPublishedAt || ''} localCount={localUnshared} groups={groups.filter((g) => !g.archived)}
          totalCount={unsharedCount} thisWeek={{ start: isoDate(weekStartOf(new Date(), weekStart)) }}
          busy={busy} onPublish={publish} onClose={() => setOpen('')} />
      )}
      {open === 'note' && (
        <DayNoteDialog date={noteDate} onDateChange={setNoteDate} groups={groups.filter((g) => !g.archived)} notes={data?.dayNotes || []} busy={busy}
          onSave={saveDayNote} onClose={() => setOpen('')} />
      )}
      {open === 'view' && (
        <ViewOptionsDialog prefs={prefs} onPrefs={setPrefs} query={query} onQuery={setQuery} groupBy={groupBy} onGroupBy={setGroupBy}
          presetFilter={presetFilter} onPresetFilter={setPresetFilter} presets={presets} canViewByShift={view === 'week'}
          twoWeeks={view === 'twoweeks' || !!prefs.twoWeeks}
          onTwoWeeks={(on) => { setPrefs({ ...prefs, twoWeeks: on }); if (view === 'week' || view === 'twoweeks') setView(on ? 'twoweeks' : 'week'); }}
          onClose={() => setOpen('')} />
      )}
      {open === 'import' && <ImportModal employees={data?.employees || []} busy={busy} onImport={importRows} onClose={() => setOpen('')} />}
      {open === 'copy' && <CopyModal groups={groups.filter((g) => !g.archived)} defaultStart={start} defaultEnd={end} busy={busy} onApply={copySchedule} onClose={() => setOpen('')} />}
      {open === 'clear' && <ClearModal groups={groups.filter((g) => !g.archived)} defaultStart={start} defaultEnd={end} busy={busy} onApply={clearSchedule} onClose={() => setOpen('')} />}
      {open === 'fill' && (
        <BulkModal groups={groups.filter((g) => !g.archived)} shifts={presets} allEmails={(data?.employees || []).map((e) => e.email)}
          defaultStart={start} defaultEnd={end} busy={busy} onApply={bulkAssign} onClose={() => setOpen('')} />
      )}
      {open === 'reorder' && <ReorderTeamsModal groups={groups} busy={busy} onClose={() => setOpen('')} onSave={saveOrder} />}
      {addTo && (
        <AddMembersModal team={addTo} busy={busy} onClose={() => setAddTo(null)} onManage={() => { setAddTo(null); teamAction(addTo, 'manage'); }}
          onAdd={async (emails) => { const r = await run(() => api.timeShiftGroupMembers(addTo.id, { add: emails }), { ok: `Added ${emails.length} ${emails.length === 1 ? 'person' : 'people'} to ${addTo.name}.`, fail: 'Could not add them.' }); if (r) setAddTo(null); }} />
      )}

      {undo && (
        <div role="status" className="m-bar" style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', zIndex: 1450, display: 'flex', alignItems: 'center', gap: 14,
          background: 'var(--ink)', color: 'var(--card)', borderRadius: 12, padding: '10px 10px 10px 16px', fontSize: 13, fontWeight: 600, boxShadow: '0 12px 32px rgba(15,23,42,0.28)', maxWidth: 'min(560px, 92vw)' }}>
          <span style={{ minWidth: 0 }}>{undo.msg}</span>
          <button type="button" onClick={undoNow} style={{ border: 'none', background: 'color-mix(in srgb, var(--card) 16%, transparent)', color: 'inherit', borderRadius: 8, padding: '6px 12px',
            fontFamily: 'inherit', fontSize: 12.5, fontWeight: 800, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}><Undo2 size={13} /> Undo</button>
          <button type="button" aria-label="Dismiss" onClick={() => { clearTimeout(undoTimer.current); setUndo(null); }}
            style={{ border: 'none', background: 'none', color: 'inherit', opacity: 0.7, cursor: 'pointer', display: 'inline-flex', padding: 4 }}><XIcon size={14} /></button>
        </div>
      )}
      {keysOpen && (
        <div style={MODAL_BACK} onClick={(e) => e.target === e.currentTarget && setKeysOpen(false)} onKeyDown={(e) => { if (e.key === 'Escape') setKeysOpen(false); }}>
          <div role="dialog" aria-label="Keyboard Shortcuts" className="m-menu" style={{ ...MODAL_CARD, maxWidth: 440 }}>
            <DialogHead title="Keyboard Shortcuts" onClose={() => setKeysOpen(false)} />
            <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '8px 14px', marginTop: 10, alignItems: 'center' }}>
              {SHORTCUTS.map(([k, what]) => [
                <span key={`k${k}`} style={{ justifySelf: 'start', fontSize: 11.5, fontWeight: 700, padding: '2px 7px', borderRadius: 6, border: '1px solid var(--line)', background: 'var(--bg)', whiteSpace: 'nowrap' }}>{k}</span>,
                <span key={`w${k}`} style={{ fontSize: 12.5, color: 'var(--muted)' }}>{what}</span>,
              ])}
            </div>
          </div>
        </div>
      )}

      <style>{`.sched-cell:hover .sched-add, .sched-cell:focus-visible .sched-add { opacity: 1 !important; }
        .sched-cell .sched-add { transition: opacity var(--m-fast) ease-out; }
        .sched-cell:focus-visible { outline: 2px solid var(--wk-brand) !important; outline-offset: -2px; }
        .sched-chip:focus-visible { outline: 2px solid var(--wk-brand); outline-offset: 1px; }
        .sched-person:hover .person-tools, .sched-person:focus-within .person-tools { opacity: 1 !important; }
        .sched-group:hover .group-tools, .sched-group:focus-within .group-tools { opacity: 1 !important; }
        .sched-hdr:hover .hdr-tools, .sched-hdr:focus-within .hdr-tools { opacity: 1 !important; }
        @media (pointer: coarse) { .person-tools, .group-tools, .hdr-tools { opacity: 1 !important; } }
        .shift-menu-item:hover:not(:disabled), .shift-menu-item:focus-visible { background: var(--bg) !important; outline: none; }
        body.sched-dragging, body.sched-dragging * { cursor: grabbing !important; user-select: none !important; }
        body.sched-dragging .sched-span { pointer-events: none; }`}</style>
    </div>
  );
}

export { fmtHrs };

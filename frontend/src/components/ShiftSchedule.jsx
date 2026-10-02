import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
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
import { AddMembersModal, ReorderTeamsModal } from './ShiftTeams';
import { ScheduleToolbar, ShareDialog, DayNoteDialog, ViewOptionsDialog } from './shifts/ScheduleToolbar';
import { CopyModal, ClearModal, BulkModal } from './shifts/ScheduleDialogs';
import WeekGrid from './shifts/WeekGrid';
import ScheduleDay from './shifts/ScheduleDay';
import ScheduleMonth from './shifts/ScheduleMonth';
import SchedulePhone from './shifts/SchedulePhone';
import ShiftPanel from './shifts/ShiftPanel';
import { isoDate, viewDays, weekStartOf, paidMinutes, counts, fmtHrs, hrsNumber, timeOffOn, shiftState, isUnshared, orderGroups, shiftTimeText, sectionKey } from './shifts/shiftLib';

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

export default function ShiftSchedule({ toastOk, toastErr, onOpenRequests }) {
  const { myEmail } = useRole() || {};
  const me = (myEmail || '').toLowerCase();
  const nameOf = useNameResolver();
  const phone = useIsMobile();
  const [view, setView] = useState('week');
  const [cursor, setCursor] = useState(() => new Date());
  const [query, setQuery] = useState('');
  const [groupFilter, setGroupFilter] = useState('');
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

  // index: "email|date" -> [shifts]; open shifts by "groupId|date".
  const byCell = useMemo(() => {
    const map = {};
    (data?.scheduled || []).forEach((s) => { if (s.email && (!presetFilter || s.shiftId === presetFilter)) (map[`${s.email}|${s.date}`] ||= []).push(s); });
    return map;
  }, [data, presetFilter]);
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
        && (!prefs.mine || m.email === me)
        && (!prefs.hideEmpty || days.some((d) => (byCell[`${m.email}|${isoDate(d)}`] || []).length))) }))
      .filter((g) => g.members.length || (g.id && g.canEdit && !q && !prefs.mine))
      .map((g) => ({ ...g, members: [...g.members].sort((a, b) => (b.email === me) - (a.email === me)) }));
  }, [data, empByEmail, groups, query, groupFilter, groupBy, me, prefs.teams, prefs.mine, prefs.hideEmpty, days, byCell]);
  const visibleEmails = useMemo(() => new Set(sections.flatMap((g) => g.members.map((m) => m.email))), [sections]);
  const visibleGroupIds = useMemo(() => new Set(sections.filter((g) => g.isGroup).map((g) => g.id)), [sections]);
  const showOpen = !prefs.mine && prefs.open !== false;
  // Open shifts by group: a shift with no groupId (older rows) sits on a
  // top row; a group's own sit on its row.
  const openCells = useMemo(() => {
    const map = {};
    if (!showOpen) return map;
    openAll.forEach((s) => {
      const gid = s.groupId && visibleGroupIds.has(s.groupId) ? s.groupId : (s.groupId && groupFilter ? null : '');
      if (gid === null) return;
      if (gid === '' && groupFilter) return;
      (map[`${gid}|${s.date}`] ||= []).push(s);
      if (gid === '') map.__ungrouped = true;
    });
    return map;
  }, [openAll, showOpen, visibleGroupIds, groupFilter]);
  const shown = useMemo(() => [
    ...(data?.scheduled || []).filter((s) => s.email && visibleEmails.has(s.email) && (!presetFilter || s.shiftId === presetFilter)),
    ...Object.entries(openCells).filter(([k]) => k !== '__ungrouped').flatMap(([, v]) => v),
  ], [data, visibleEmails, presetFilter, openCells]);
  const notes = useMemo(() => {
    const m = {};
    (data?.dayNotes || []).forEach((n) => { if (!n.groupId || visibleGroupIds.has(n.groupId) || !groups.length) m[n.date] = m[n.date] ? `${m[n.date]} · ${n.note}` : n.note; });
    return m;
  }, [data, visibleGroupIds, groups.length]);

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
  async function run(fn, { ok, fail, after } = {}) {
    setBusy(true);
    try {
      const r = await fn();
      if (ok) toastOk?.(typeof ok === 'function' ? ok(r) : ok);
      after?.(r);
      load();
      return r;
    } catch (e) { toastErr?.(e?.message || fail || 'Something went wrong.'); return null; }
    finally { setBusy(false); }
  }
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
  { ok: 'Shift copied here.', fail: 'Could not paste the shift.' });
  const saveCell = (payload) => run(() => (payload.id ? api.timeSchedUpdate(payload.id, payload) : api.timeSchedCreate(payload)),
    { ok: (r) => (r?.hasChanges ? 'Change saved. The team sees it once you share.' : 'Shift saved.'), fail: 'Could not save.', after: () => setPanel(null) });
  const delCell = (id) => run(() => api.timeSchedDelete(id), { ok: (r) => (r?.pending ? "Marked for removal. It stays on the team's schedule until you share." : 'Shift removed.'), fail: 'Could not remove.', after: () => setPanel(null) });
  const discardCell = (id) => run(() => api.timeSchedDiscard(id), { ok: 'Changes discarded.', fail: 'Could not discard the changes.', after: () => setPanel(null) });
  const assignOpen = (id, email) => run(() => api.timeSchedAssign(id, email), { ok: 'Shift assigned.', fail: 'Could not assign.', after: () => setPanel(null) });
  const moveShift = (s, email, date, duplicate) => {
    if (!duplicate && s.email === email && s.date === date) return;
    run(() => api.timeSchedMove(s.id, { employee_email: email, work_date: date, duplicate }), {
      ok: (r) => (duplicate ? 'Shift copied here as a draft.' : !email ? 'Moved to open shifts.' : r?.sourcePending ? 'Shift moved. The team keeps the original until you share.' : 'Shift moved.'),
      fail: 'Could not move the shift.', after: () => setPanel(null) });
  };
  const placePreset = (p, email, date, groupId = '') => run(() => api.timeSchedCreate({ employee_email: email, work_date: date, shift_id: p.id, group_id: groupId, ...(email ? {} : { open_slots: 1 }) }),
    { ok: `${p.code || p.name} placed as a draft.`, fail: 'Could not place the shift.' });
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
      if (!group.archived && groupFilter === group.id) setGroupFilter('');
    } else if (action === 'reorder') setOpen('reorder');
    else if (action === 'manage') window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'admin-console', sub: 'global-shifts' } }));
    else if (action === 'delete') {
      const ok = await dialog.confirm(`Delete the group ${group.name}? Its people stay on the schedule; only the group goes.`, { title: 'Delete Group', confirmText: 'Delete', danger: true });
      if (ok) { if (groupFilter === group.id) setGroupFilter(''); run(() => api.timeShiftGroupDelete(group.id), { ok: 'Group deleted.', fail: 'Could not delete the group.' }); }
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
  const shiftRange = (n) => setCursor((c) => {
    const d = new Date(c);
    if (view === 'month') return new Date(d.getFullYear(), d.getMonth() + n, 1);
    d.setDate(d.getDate() + n * (view === 'day' ? 1 : view === 'twoweeks' ? 14 : 7));
    return d;
  });
  const rangeLabel = view === 'day' ? `${formatWeekday(days[0])}, ${formatDate(days[0])}`
    : view === 'month' ? formatMonthYear(days[0])
      : `${formatDate(days[0])} - ${formatDate(days[days.length - 1])}`;
  const openDay = (ds) => { const [y, m, d] = ds.split('-').map(Number); setCursor(new Date(y, m - 1, d)); setView('day'); };
  const pickView = (k) => setView(k === 'week' && prefs.twoWeeks ? 'twoweeks' : k);
  // Folded groups: what the user chose, else folded when nothing is in
  // view (no shifts, no open shifts, nobody off).
  const collapsed = useMemo(() => {
    const set = new Set();
    sections.forEach((g) => {
      const key = sectionKey(g);
      const busyGroup = days.some((d) => { const ds = isoDate(d); return (openCells[`${g.id || ''}|${ds}`] || []).length || g.members.some((m) => (byCell[`${m.email}|${ds}`] || []).length || offOn(m.email, ds).length); });
      if (fold[key] ?? !busyGroup) set.add(key);
    });
    return set;
  }, [sections, days, openCells, byCell, offOn, fold]);
  const toggleCollapse = (key) => setFold({ ...fold, [key]: !collapsed.has(key) });

  const gridOn = {
    cellClick: (email, ds, groupId) => (copied ? pasteInto(email, ds, groupId) : setPanel({ cell: { email, date: ds, groupId }, mode: 'shift' })),
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
  // The manager controls stay on the toolbar while loading or after a failed
  // load (disabled), so the row never jumps - the grid itself says what happened.
  const toolbarManage = data ? canManage : true;

  return (
    <div style={{ fontFamily: 'Inter,sans-serif' }}>
      <ScheduleToolbar view={view} onView={pickView} onPrev={() => shiftRange(-1)} onNext={() => shiftRange(1)} onToday={() => setCursor(new Date())}
        rangeLabel={rangeLabel} groups={groups} groupFilter={groupFilter} onGroupFilter={setGroupFilter} canManage={toolbarManage} busy={busy} ready={ready}
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
          exportFile: exportSchedule, print: printView, viewOptions: () => setOpen('view'), discard: discardAll, discardCount,
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
      ) : phone && view !== 'month' && groupBy !== 'shift' ? (
        <SchedulePhone days={days} sections={sections} byCell={byCell} openCells={openCells} offOn={offOn} holOn={holOn} usualOf={usualOf}
          notes={notes} holidayDates={holidayDates} me={me} prefs={prefs} teamZone={teamZone} canManage={managing}
          rowEditable={rowEditable} empWeekMin={empWeekMin} dayStats={dayStats} dragId={drag?.id} collapsed={collapsed} copied={copied} on={gridOn} />
      ) : view === 'day' ? (
        <ScheduleDay date={start} sections={sections} shifts={shown} openCells={openCells} notes={notes} canManage={managing} offOn={offOn} holOn={holOn}
          copied={copied} prefs={prefs} rowEditable={rowEditable} shiftEditable={shiftEditable} dragId={drag?.id} on={gridOn}
          dragProps={dragProps} dropProps={dropProps} dropStyle={dropStyle} clickable={clickable} />
      ) : view === 'month' ? (
        <ScheduleMonth days={days} shifts={shown.filter((s) => s.email)} openShifts={shown.filter((s) => !s.email)} timeoff={data.timeoff || []}
          holidayDates={holidayDates} holidayNames={holidayNames} notes={notes} visibleEmails={visibleEmails} names={names} weekStart={weekStart} onOpenDay={openDay} />
      ) : groupBy === 'shift' ? (
        <ShiftTypeWeek days={days} shifts={shown} presets={presets} names={names} teamZone={teamZone}
          onOpen={(s) => openShiftEditor(s, s.email, s.date)} />
      ) : (
        <WeekGrid days={days} compact={compact} sections={sections} byCell={byCell} openCells={openCells} offOn={offOn} holOn={holOn} availOn={availOn} usualOf={usualOf}
          notes={notes} holidayDates={holidayDates} me={me} prefs={prefs} teamZone={teamZone} canManage={managing}
          rowEditable={rowEditable} empWeekMin={empWeekMin} dayStats={dayStats} weekMin={weekMin} overWeeks={overWeeks}
          copied={copied} dropKey={dropKey} dragId={drag?.id} isCollapsed={(k) => collapsed.has(k)} on={gridOn}
          dragProps={dragProps} personDragProps={personDragProps} dropProps={dropProps} dropStyle={dropStyle} hoverCell={hoverCell} hoverShift={hoverShift} clickable={clickable} />
      )}
      {data && teamZoneLabel && <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 8 }}>Times in {teamZoneLabel}</div>}

      {ghost && (
        <div style={{ position: 'fixed', left: ghost.x + 12, top: ghost.y + 10, zIndex: 1600, pointerEvents: 'none', fontSize: 11.5, fontWeight: 800,
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

      <style>{`.sched-cell:hover .sched-add, .sched-cell:focus-visible .sched-add { opacity: 1 !important; }
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

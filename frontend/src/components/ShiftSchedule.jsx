import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { ChevronLeft, ChevronRight, Plus, Trash2, X, Clock, CalendarDays, CalendarRange, Send, Copy, Star, RotateCcw, AlertTriangle, Inbox, Download, Search, StickyNote, Printer, Upload, CalendarOff, MoreHorizontal, Lock } from 'lucide-react';
import { api } from '../api';
import { useRole } from '../contexts/RoleContext';
import { formatDate } from '../lib/datetime';
import { useUnsavedGuard } from '../lib/useUnsavedGuard';
import UnsavedChangesPrompt from './UnsavedChangesPrompt';
import ShiftRequestsInbox from './ShiftRequestsInbox';
import { exportExcel } from '../tasks/exporting';
import { dialog } from '../ui/dialog';
import { ShiftTypeWeek, ImportModal, TimeOffModal, Avatar, ShiftMenu, ShiftPalette, ShiftDetails } from './ShiftScheduleExtras';
import { printSchedule, availText, DEFAULT_VIEW_PREFS } from './shiftScheduleLib';
import { Spinner } from './AsyncState';
import { TeamSwitcher, ViewMenu, TeamMenu, AddMembersModal, ReorderTeamsModal } from './ShiftTeams';

// ── Weekly schedule grid (Microsoft Teams "Shifts" style) ─────────────────────
// Rows = employees (grouped by team), columns = the days in view: a week, two
// weeks or a month (Sunday optional).
// Each cell holds a placed shift (colour + code + time + label); approved/pending
// time off shows as a "Requested off" cell. Per-day and per-week hour totals sum
// live off the placed shift durations.

const TYPE_TINT = { vacation: '#dbeafe', sick: '#dcfce7', personal: '#ede9fe', unpaid: '#f3f4f6', other: '#fef3c7' };
// The LOCAL calendar date. toISOString() is UTC, so east of UTC (India,
// +5:30) a local-midnight Monday came out as Sunday and every column of the
// grid was keyed a day early - a shift placed under "Tue 29" was saved on the
// 28th (found Sep 29 while adding Copy schedule). Same fix as MyShifts' dateKey.
const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const toMin = (hhmm) => { const [h, m] = (hhmm || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
// An end before the start runs past midnight; an end EQUAL to the start is
// zero, not 24 h - it is a typo the server now refuses (QA D3), and any old
// row like that must not add a phantom day to the totals.
const durMin = (s, e) => { let d = toMin(e) - toMin(s); if (d < 0) d += 1440; return d; };
const fmtHrs = (min) => `${(min / 60).toFixed(min % 60 ? 1 : 0)} Hrs`;
// Scheduled hours are PAID hours: the shift's span minus its unpaid break.
const paidMin = (s) => Math.max(0, durMin(s.start, s.end) - (Number(s.breakMin) || 0));
// Hours a shift puts on the plan: an open shift needs every one of its spots
// filled, so it counts once per spot (QA D3). A person's shift counts once.
const planMin = (s) => paidMin(s) * (s.email ? 1 : Math.max(1, Number(s.openSlots) || 1));
const sameTime = (a, b) => !!a && !!b && a.slice(0, 5) === b.slice(0, 5);
const SAME_TIME_MSG = "Start and end can't be the same time.";
// A PUBLISHED shift's unshared changes (Sep 28, QA D1/D2): an edit or a
// removal waits for Publish while the team keeps seeing the published version,
// so the scheduler's grid marks both - and a pending removal no longer counts
// toward the hour totals.
const counts = (s) => !s.pendingDelete;
function pendingState(s) {
  if (s.pendingDelete) return { tag: 'Removing', title: 'Removal not published yet - the team still sees this shift until you publish.',
    style: { opacity: 0.55, textDecoration: 'line-through' } };
  if (s.hasChanges) return { tag: 'Edited', title: 'Edited - the team sees the previous version until you publish.', style: {} };
  if (s.published === false) return { tag: '', title: 'Draft - not shared with the team yet', style: {} };
  return { tag: '', title: undefined, style: {} };
}
const t12 = (hhmm) => {
  const [h, m] = (hhmm || '0:0').split(':').map(Number);
  const ap = h >= 12 ? 'p' : 'a'; const hh = h % 12 || 12;
  return m ? `${hh}:${String(m).padStart(2, '0')}${ap}` : `${hh}${ap}`;
};

// YYYY-MM-DD plus n days, on the local calendar.
function addDaysIso(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return isoDate(new Date(y, m - 1, d + n));
}

const t12Full = (hhmm) => {
  const [h, m] = (hhmm || '0:0').split(':').map(Number);
  return `${h % 12 || 12}:${String(m || 0).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
};
const STATUS_TEXT = (s) => (s.pendingDelete ? 'Removal not published' : s.hasChanges ? 'Edited, not published'
  : s.published === false ? 'Draft' : 'Published');
const VIEWS = [['day', 'Day'], ['week', 'Week'], ['twoweeks', 'Two Weeks'], ['month', 'Month']];
// Over this many scheduled hours in a Monday-Sunday week reads red (Neil, Sep
// 30: "anyone over 40 hours should be flagged").
const WEEK_LIMIT_MIN = 40 * 60;
const PREFS_KEY = 'nexus.shifts.viewPrefs';
function loadPrefs() {
  try { return { ...DEFAULT_VIEW_PREFS, ...(JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {}) }; }
  catch { return { ...DEFAULT_VIEW_PREFS }; }
}
const TOOL_BTN = { width: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid var(--line)',
  borderRadius: 4, background: 'var(--card)', color: 'var(--muted)', cursor: 'pointer', padding: 0 };
// Same palette as a preset's (ShiftsPanel), for a shift's own color (Sep 29).
const SHIFT_COLORS = ['#2563eb', '#16a34a', '#8b5cf6', '#f59e0b', '#ec4899', '#0891b2', '#dc2626', '#64748b'];

// The dates a view covers: one day, the Monday-Sunday week (or two), or the month.
function viewDays(view, cursor) {
  const c = new Date(cursor); c.setHours(0, 0, 0, 0);
  if (view === 'day') return [c];
  if (view === 'twoweeks') {
    const mon = mondayOf(c);
    return Array.from({ length: 14 }, (_, i) => new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + i));
  }
  if (view === 'month') {
    const first = new Date(c.getFullYear(), c.getMonth(), 1);
    const n = new Date(c.getFullYear(), c.getMonth() + 1, 0).getDate();
    return Array.from({ length: n }, (_, i) => new Date(first.getFullYear(), first.getMonth(), i + 1));
  }
  const mon = mondayOf(c);
  return Array.from({ length: 7 }, (_, i) => new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + i));
}

function mondayOf(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

export default function ShiftSchedule({ toastOk, toastErr }) {
  // The signed-in scheduler's own row is pinned first in its section and
  // marked, the same as on My Shifts (Neil, Sep 29: find yourself easily).
  const { myEmail } = useRole() || {};
  const me = (myEmail || '').toLowerCase();
  // Day / Week / Month (Sep 29, Teams parity) all hang off one date.
  const [view, setView] = useState('week');
  const [cursor, setCursor] = useState(() => new Date());
  const [query, setQuery] = useState('');          // name / email filter
  const [groupFilter, setGroupFilter] = useState('');
  const [presetFilter, setPresetFilter] = useState('');   // one shift type (preset), '' = all
  // The View menu (Neil, Sep 30): quick access, view by, and what shows -
  // remembered per browser.
  const [prefs, setPrefsState] = useState(loadPrefs);
  const setPrefs = (next) => { setPrefsState(next); try { localStorage.setItem(PREFS_KEY, JSON.stringify(next)); } catch { /* private mode */ } };
  const rowsBy = prefs.rowsBy === 'shifts' ? 'shifts' : 'people';   // week rows: people | shift types (Teams "view by shift")
  const [addTo, setAddTo] = useState(null);         // the team getting new members
  const [reorderOpen, setReorderOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [offCell, setOffCell] = useState(null);     // { email, date } - adding time off from the grid
  const [groupBy, setGroupBy] = useState('group');  // row sections: shift groups | locations (Neil, Sep 29)
  const [menu, setMenu] = useState(null);           // { x, y, email, date, shift? } - the right-click menu
  const [ghost, setGhost] = useState(null);         // { x, y, label, copy } - what is being dragged
  const [details, setDetails] = useState(null);     // { x, y, shift } - the magnifier's details card
  const suppressClick = useRef(false);
  const hoverRef = useRef({ shift: null, cell: null });   // under the pointer, for Ctrl+C / Ctrl+V
  const [drag, setDrag] = useState(null);          // the shift being dragged
  const [dropKey, setDropKey] = useState('');      // "email|date" under the pointer
  const [noteEdit, setNoteEdit] = useState(null);  // { date, note } while editing a day note
  const [data, setData] = useState(null);
  const [cell, setCell] = useState(null);   // { email, date, existing? }
  const [openCell, setOpenCell] = useState(null);   // { date, existing? } - open-shift editor
  // Another manager's open slot is read-only for a scoped manager (the API
  // marks it canEdit=false and refuses the write) - say so instead of opening
  // an editor whose Save would fail.
  const openExisting = (date, s) => {
    if (s.canEdit === false) {
      toastErr?.('This open shift was posted by another manager - only they or an administrator can change it.');
      return;
    }
    setOpenCell({ date, existing: s });
  };
  const [bulkOpen, setBulkOpen] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [requestCount, setRequestCount] = useState(0);   // waiting on a manager
  const [inboxTick, setInboxTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(null);   // a shift on the "clipboard" to paste into a cell

  const allDays = useMemo(() => viewDays(view, cursor), [view, cursor]);
  const start = isoDate(allDays[0]);
  const end = isoDate(allDays[allDays.length - 1]);
  // Show > Sunday off hides Sundays (Neil, Sep 30: most teams work Mon-Sat).
  const hideSunday = prefs.sunday === false && view !== 'day';
  const days = useMemo(() => (hideSunday ? allDays.filter(d => d.getDay() !== 0) : allDays), [allDays, hideSunday]);
  const compact = days.length > 7;   // Two Weeks / Month: narrow day columns

  // Refreshing after a save keeps the grid on screen (and the scroll where it
  // was); only moving to another range shows the loader.
  const load = useCallback(() => {
    api.timeSchedule(start, end).then(setData).catch(e => { setData({ employees: [], shifts: [], groups: [], scheduled: [], timeoff: [] }); toastErr?.(e?.message || 'Could not load the schedule.'); });
  }, [start, end, toastErr]);
  // Only a new range clears the grid. Clearing used to hang off `load`, which
  // also changes when a parent passes new toast functions - so every toast
  // blanked the grid to a loader and jumped the page to the top.
  useEffect(() => { setData(null); }, [start, end]);
  useEffect(() => { load(); }, [load]);

  // index: "email|date" -> [shifts]; and time off lookup. Open shifts (email '')
  // are indexed by date on their own so they render in the Open shifts row.
  const byCell = useMemo(() => {
    const map = {};
    (data?.scheduled || []).forEach(s => { if (s.email && (!presetFilter || s.shiftId === presetFilter)) (map[`${s.email}|${s.date}`] ||= []).push(s); });
    return map;
  }, [data, presetFilter]);
  const openByDate = useMemo(() => {
    const map = {};
    (data?.scheduled || []).forEach(s => { if (!s.email && (!presetFilter || s.shiftId === presetFilter)) (map[s.date] ||= []).push(s); });
    return map;
  }, [data, presetFilter]);
  const openCount = (data?.scheduled || []).reduce((a, s) => a + (!s.email ? (s.openSlots || 1) : 0), 0);
  const offOn = (email, ds) => (data?.timeoff || []).find(t => t.email === email && t.startDate <= ds && ds <= t.endDate);
  // Per-employee, not per-column (Pranshu, Sep 22: "fetch the holiday in
  // shifts so HR is aware") - two rows on the same grid can be different
  // companies/countries with different calendars, so a date can be a holiday
  // for one row and an ordinary workday for another.
  const holOn = (email, ds) => data?.holidays?.[email]?.[ds];
  // Which dates in the visible week are ANYONE's holiday - drives the small
  // marker in the day header so HR notices without scanning every row.
  const holidayDates = useMemo(() => {
    const s = new Set();
    Object.values(data?.holidays || {}).forEach(byDate => Object.keys(byDate).forEach(d => s.add(d)));
    return s;
  }, [data]);

  // group employees by shift group; the rest go under "Everyone else"
  const groupsView = useMemo(() => {
    if (!data) return [];
    const emps = data.employees;
    const byEmail = Object.fromEntries(emps.map(e => [e.email, e]));
    const claimed = new Set();
    let out = [];
    if (groupBy === 'location') {
      // By location (Neil, Sep 29: "see by locations also, not just by teams").
      const byLoc = {};
      emps.forEach(e => (byLoc[e.location || ''] ||= []).push(e));
      out = Object.keys(byLoc).sort((a, b) => (a === '') - (b === '') || a.localeCompare(b))
        .map(k => ({ name: k || 'No location set', members: byLoc[k] }));
    } else {
      // Teams (Neil, Sep 30): archived ones leave the grid unless picked in the
      // switcher; a team shows even when empty, so Add Members has a home.
      (data.groups || []).forEach(g => {
        if (g.archived && g.id !== groupFilter) return;
        const members = g.members.map(m => byEmail[m]).filter(Boolean);
        members.forEach(m => claimed.add(m.email));
        if (members.length || (g.canEdit && !query.trim())) out.push({ id: g.id, name: g.name, members, canEdit: !!g.canEdit, archived: !!g.archived });
      });
      const rest = emps.filter(e => !claimed.has(e.email));
      if (rest.length) out.push({ name: out.length ? 'Everyone else' : 'Team', members: rest });
      if (prefs.teams === false) {
        // Show > Teams off: one list, each person once.
        const seen = new Set();
        out = [{ name: 'Everyone', members: out.flatMap(g => g.members).filter(m => !seen.has(m.email) && seen.add(m.email)) }];
      }
    }
    // Search and group filter (Sep 29): every view, the totals and the export
    // follow what is left.
    const q = query.trim().toLowerCase();
    const picked = groupFilter ? (data.groups || []).find(g => g.id === groupFilter) : null;
    const byTeam = groupBy === 'group' && prefs.teams !== false;
    return out
      .filter(g => !picked || !byTeam || g.id === picked.id)
      .map(g => ({ ...g, members: g.members.filter(m => (!q || `${m.name || ''} ${m.email}`.toLowerCase().includes(q))
        && (!picked || byTeam || picked.members.includes(m.email))
        && (!prefs.mine || m.email === me)) }))
      .filter(g => g.members.length || (g.id && g.canEdit && !q && !prefs.mine))
      .map(g => ({ ...g, members: [...g.members].sort((a, b) => (b.email === me) - (a.email === me)) }));
  }, [data, query, groupFilter, groupBy, me, prefs.teams, prefs.mine]);
  const visibleEmails = useMemo(() => new Set(groupsView.flatMap(g => g.members.map(m => m.email))), [groupsView]);
  const filtering = !!(query.trim() || groupFilter || presetFilter);
  // Open shifts belong to no team, so a team filter (or Your Shifts, or Show >
  // Open Shifts off) hides them.
  const showOpen = !groupFilter && !prefs.mine && prefs.open !== false;
  const shown = useMemo(() => (data?.scheduled || [])
    .filter(s => (s.email ? visibleEmails.has(s.email) : showOpen))
    .filter(s => !presetFilter || s.shiftId === presetFilter),
  [data, visibleEmails, showOpen, presetFilter]);
  const notes = useMemo(() => Object.fromEntries((data?.dayNotes || []).filter(n => !n.groupId).map(n => [n.date, n.note])), [data]);
  const names = useMemo(() => Object.fromEntries((data?.employees || []).map(e => [e.email, e.name || e.email])), [data]);
  // A person's usual hours on a day (their default preset, on its weekdays).
  // Not a shift: nothing is on the schedule until one is placed, so it is
  // shown faintly and never counted - the same as on their own My Shifts.
  // Put one person on a preset (their "usual hours"), or take them off one.
  const setUsual = async (email, shiftId) => {
    try {
      await api.timeShiftAssign({ shift_id: shiftId || '', emails: [email] });
      toastOk?.(shiftId ? `${names[email] || email} is on ${(data?.shifts || []).find((p) => p.id === shiftId)?.name || 'that preset'} as their usual hours.` : `${names[email] || email} has no usual hours now.`);
      load();
    } catch (e) { toastErr?.(e?.message || 'Could not change the usual hours.'); }
  };
  // A person's availability on a day: weekdays are 0 = Monday, as the rows store them.
  const availOn = (email, d) => (data?.availability?.[email] || []).find((a) => a.weekday === (d.getDay() + 6) % 7) || null;
  const usualOn = (email, d) => {
    const p = (data?.shifts || []).find(x => x.id === data?.usual?.[email]);
    return p && (p.days || '').split(',').includes(String(d.getDay() || 7)) ? p : null;
  };

  // Paid minutes per person per Monday-Sunday week, from everything loaded
  // (a hidden Sunday still counts).
  const weekLoad = useMemo(() => {
    const m = {};
    (data?.scheduled || []).forEach(s => {
      if (!s.email || !counts(s)) return;
      const [y, mo, d] = s.date.split('-').map(Number);
      const k = `${s.email}|${isoDate(mondayOf(new Date(y, mo - 1, d)))}`;
      m[k] = (m[k] || 0) + paidMin(s);
    });
    return m;
  }, [data]);
  const overWeeks = (email) => Object.entries(weekLoad).filter(([k, v]) => k.startsWith(`${email}|`) && v > WEEK_LIMIT_MIN).map(([, v]) => v);
  const empWeekMin = (email) => days.reduce((sum, d) => sum + (byCell[`${email}|${isoDate(d)}`] || []).filter(counts).reduce((a, s) => a + paidMin(s), 0), 0);
  const dayStats = (d) => {
    const ds = isoDate(d);
    let min = 0; const people = new Set();
    // People = real people only; an open shift has no email (QA D3).
    shown.forEach(s => { if (s.date === ds && counts(s)) { min += planMin(s); if (s.email) people.add(s.email); } });
    return { min, people: people.size };
  };
  const weekMin = shown.filter(counts).reduce((a, s) => a + planMin(s), 0);
  const canManage = data?.canManage !== false;   // schedulers see/manage drafts
  const managing = !!data && canManage;
  // See everyone, change only your own (Neil, Sep 30): the API marks each
  // person and shift canEdit; another team's rows are read-only here.
  const empByEmail = useMemo(() => Object.fromEntries((data?.employees || []).map(e => [e.email, e])), [data]);
  const rowEditable = (email) => canManage && (!email || empByEmail[email]?.canEdit !== false);
  const shiftEditable = (s) => canManage && s.canEdit !== false;
  const readOnlyMsg = 'You can view this team, but only its own manager can change its schedule.';
  useEffect(() => {
    if (!managing) return undefined;
    let live = true;
    Promise.all([api.shiftRequestsInbox().catch(() => null), api.timeOffList('pending').catch(() => null)])
      .then(([r, t]) => { if (live) setRequestCount((r?.pending || []).length + (Array.isArray(t) ? t.length : 0)); });
    return () => { live = false; };
  }, [managing, inboxTick]);
  const unpublished = (data?.scheduled || []).filter(s => s.published === false).length;

  const [publishAsk, setPublishAsk] = useState(false);
  async function publishWeek(notify = 'changed') {
    setBusy(true);
    try {
      const r = await api.timeSchedPublish({ start_date: start, end_date: end, notify });
      setPublishAsk(false);
      const bits = [];
      if (r.added) bits.push(`${r.added} new`);
      if (r.updated) bits.push(`${r.updated} changed`);
      if (r.removed) bits.push(`${r.removed} removed`);
      const told = r.notified ? ` ${r.notified} ${r.notified === 1 ? 'person' : 'people'} notified.` : '';
      toastOk?.(r.published ? `Shared with the team: ${bits.length ? bits.join(', ') : `${r.published} shift${r.published !== 1 ? 's' : ''}`}.${told}` : 'Nothing new to share.');
      load();
    } catch (e) { toastErr?.(e?.message || 'Could not publish.'); }
    setBusy(false);
  }
  // Copy/paste: stash a shift, then click an empty cell to drop a draft copy there.
  async function pasteInto(email, date) {
    if (!copied) return;
    setBusy(true);
    try {
      await api.timeSchedCreate({ employee_email: email, work_date: date, shift_id: copied.shiftId,
        start_hhmm: copied.start, end_hhmm: copied.end, label: copied.label, note: copied.note,
        break_min: copied.breakMin ?? 0, color: copied.ownColor || '', activities: copied.activities || [],
        ...(email ? {} : { open_slots: 1 }) });
      toastOk?.('Shift copied here.'); load();
    } catch (e) { toastErr?.(e?.message || 'Could not paste the shift.'); }
    setBusy(false);
  }

  async function saveCell(payload) {
    setBusy(true);
    try {
      const r = payload.id ? await api.timeSchedUpdate(payload.id, payload) : await api.timeSchedCreate(payload);
      toastOk?.(r?.hasChanges ? 'Change saved. The team sees it once you publish.' : 'Shift saved.'); setCell(null); load();
    } catch (e) { toastErr?.(e?.message || 'Could not save.'); }
    setBusy(false);
  }
  async function delCell(id) {
    setBusy(true);
    try {
      const r = await api.timeSchedDelete(id);
      toastOk?.(r?.pending ? 'Marked for removal. It stays on the team\'s schedule until you publish.' : 'Shift removed.');
      setCell(null); setOpenCell(null); load();
    }
    catch (e) { toastErr?.(e?.message || 'Could not remove.'); }
    setBusy(false);
  }
  async function discardCell(id) {
    setBusy(true);
    try { await api.timeSchedDiscard(id); toastOk?.('Changes discarded.'); setCell(null); setOpenCell(null); load(); }
    catch (e) { toastErr?.(e?.message || 'Could not discard the changes.'); }
    setBusy(false);
  }
  async function saveOpen(payload) {
    setBusy(true);
    try {
      if (payload.id) await api.timeSchedUpdate(payload.id, payload);
      else await api.timeSchedCreate({ ...payload, employee_email: '' });
      toastOk?.('Open shift saved.'); setOpenCell(null); load();
    } catch (e) { toastErr?.(e?.message || 'Could not save.'); }
    setBusy(false);
  }
  async function assignOpen(id, email) {
    setBusy(true);
    try { await api.timeSchedAssign(id, email); toastOk?.('Shift assigned.'); setOpenCell(null); load(); }
    catch (e) { toastErr?.(e?.message || 'Could not assign.'); }
    setBusy(false);
  }
  // Drag and drop (Sep 29): drop = move, Ctrl/Alt-drop = copy. The server
  // lands a draft at the target and applies the D2 rule to the original.
  async function moveShift(s, email, date, duplicate) {
    if (!duplicate && s.email === email && s.date === date) return;
    setBusy(true);
    try {
      const r = await api.timeSchedMove(s.id, { employee_email: email, work_date: date, duplicate });
      toastOk?.(duplicate ? 'Shift copied here as a draft.'
        : !email ? 'Moved to open shifts.'
          : r?.sourcePending ? 'Shift moved. The team keeps the original until you publish.' : 'Shift moved.');
      load();
    } catch (e) { toastErr?.(e?.message || 'Could not move the shift.'); }
    setBusy(false);
  }
  async function placePreset(p, email, date) {
    setBusy(true);
    try {
      await api.timeSchedCreate({ employee_email: email, work_date: date, shift_id: p.id, ...(email ? {} : { open_slots: 1 }) });
      toastOk?.(`${p.code || p.name} placed as a draft.`); load();
    } catch (e) { toastErr?.(e?.message || 'Could not place the shift.'); }
    setBusy(false);
  }
  async function recolor(s, color) {
    setBusy(true);
    try {
      await api.timeSchedUpdate(s.id, { employee_email: s.email, work_date: s.date, shift_id: s.shiftId, start_hhmm: s.start,
        end_hhmm: s.end, label: s.label, note: s.note, break_min: s.breakMin ?? 0, color,
        ...(s.email ? {} : { open_slots: s.openSlots || 1 }) });
      toastOk?.('Color changed.'); load();
    } catch (e) { toastErr?.(e?.message || 'Could not change the color.'); }
    setBusy(false);
  }
  const copyShift = (s) => { setCopied(s); toastOk?.('Shift copied. Right-click a day and Paste, press Ctrl+V over it, or click an empty day.'); };
  function menuAction(action, arg) {
    const m = menu; setMenu(null);
    if (!m) return;
    const s = m.shift;
    if (action === 'edit') (s.email ? setCell({ email: s.email, date: s.date, existing: s }) : openExisting(s.date, s));
    else if (action === 'add') (m.email ? setCell({ email: m.email, date: m.date }) : setOpenCell({ date: m.date }));
    else if (action === 'timeoff') setOffCell({ email: m.email, date: m.date });
    else if (action === 'color') recolor(s, arg);
    else if (action === 'toOpen') moveShift(s, '', s.date, false);
    else if (action === 'copy') copyShift(s);
    else if (action === 'paste') pasteInto(m.email, m.date);
    else if (action === 'delete') delCell(s.id);
  }
  const openMenu = (e, email, date, shift) => {
    if (!canManage) return;
    e.preventDefault(); e.stopPropagation();
    if (shift ? !shiftEditable(shift) : !rowEditable(email)) return;
    setMenu({ x: e.clientX, y: e.clientY, email, date, shift: shift && !shift.pendingDelete ? shift : null });
  };
  // Ctrl+C over a shift, Ctrl+V over a day (Teams keyboard parity).
  const keysRef = useRef(null);
  useEffect(() => { keysRef.current = { copied, canManage, copyShift, pasteInto }; });
  useEffect(() => {
    const onKey = (e) => {
      const k = keysRef.current;
      if (!k?.canManage || !(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (e.target?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      if (window.getSelection?.()?.toString()) return;   // let real text copy work
      const key = (e.key || '').toLowerCase();
      const { shift, cell: at } = hoverRef.current;
      if (key === 'c' && shift && !shift.pendingDelete) { e.preventDefault(); k.copyShift(shift); }
      else if (key === 'v' && at && k.copied) { e.preventDefault(); k.pasteInto(at.email, at.date); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const hoverCell = (email, date) => ({
    onMouseEnter: () => { hoverRef.current.cell = { email, date }; },
    onMouseLeave: () => { hoverRef.current.cell = null; },
  });
  const hoverShift = (s) => ({
    onMouseEnter: () => { hoverRef.current.shift = s; },
    onMouseLeave: () => { hoverRef.current.shift = null; },
  });
  const conflictShifts = shown.filter(s => s.conflicts?.length);
  const unshared = (data?.scheduled || []).filter(s => s.hasChanges || s.pendingDelete).length;
  async function discardAll() {
    const ok = await dialog.confirm(
      `Discard ${unshared} unpublished change${unshared === 1 ? '' : 's'} in this ${viewLabel.toLowerCase()}? `
      + 'Edited and removed shifts go back to what the team sees now. New draft shifts stay.',
      { title: 'Discard Changes', confirmText: 'Discard' });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await api.timeSchedDiscardAll({ start_date: start, end_date: end });
      toastOk?.(`Discarded ${r.discarded} unpublished change${r.discarded === 1 ? '' : 's'}.`);
      load();
    } catch (e) { toastErr?.(e?.message || 'Could not discard the changes.'); }
    setBusy(false);
  }
  async function importRows(rows) {
    setBusy(true);
    try {
      const r = await api.timeSchedImport({ rows });
      toastOk?.(`Added ${r.created} shift${r.created === 1 ? '' : 's'} as drafts.${r.errorCount ? ` ${r.errorCount} row${r.errorCount === 1 ? '' : 's'} skipped.` : ''} Publish to share them.`);
      load();
      if (!r.errorCount) setImportOpen(false);
      return r;
    } catch (e) { toastErr?.(e?.message || 'Could not import the schedule.'); return null; }
    finally { setBusy(false); }
  }
  async function saveTimeOff(payload, approve) {
    setBusy(true);
    try {
      const r = await api.timeOffOnBehalf(payload);
      if (approve) await api.timeOffDecide(r.id, { status: 'approved', note: '' });
      const who = names[payload.employee_email] || payload.employee_email;
      toastOk?.(approve ? `Time off added for ${who}.` : `Time-off request added for ${who} - decide it in Requests.`);
      setOffCell(null); setInboxTick((t) => t + 1); load();
    } catch (e) { toastErr?.(e?.message || 'Could not add the time off.'); }
    setBusy(false);
  }
  function printView() {
    const ok = printSchedule({ title: `Schedule ${formatDate(start)} - ${formatDate(end)}`, days, groups: groupsView,
      byCell, openByDate: groupFilter ? {} : openByDate, offOn, holOn, notes });
    if (!ok) toastErr?.('Allow pop-ups for this site to print the schedule.');
  }
  async function saveDayNote(date, note) {
    setBusy(true);
    try {
      await api.timeSchedDayNote({ work_date: date, note });
      toastOk?.(note.trim() ? 'Day note saved.' : 'Day note removed.');
      setNoteEdit(null); load();
    } catch (e) { toastErr?.(e?.message || 'Could not save the note.'); }
    setBusy(false);
  }
  const presetName = (id) => { const p = (data?.shifts || []).find(x => x.id === id); return p ? (p.code || p.name) : ''; };
  async function exportSchedule() {
    const rows = [...shown].sort((a, b) => a.date.localeCompare(b.date) || (names[a.email] || '~').localeCompare(names[b.email] || '~') || a.start.localeCompare(b.start));
    try {
      await exportExcel({
        title: 'Schedule', filename: `schedule-${start}-to-${end}.xlsx`, rows,
        columns: [
          { header: 'Date', get: s => formatDate(s.date), width: 12 },
          { header: 'Day', get: s => new Date(`${s.date}T00:00`).toLocaleDateString('en-US', { weekday: 'short' }), width: 6 },
          { header: 'Employee', get: s => (s.email ? names[s.email] || s.email : 'Open shift'), width: 24 },
          { header: 'Email', get: s => s.email, width: 28 },
          { header: 'Shift Type', get: s => presetName(s.shiftId), width: 14 },
          { header: 'Start', get: s => t12Full(s.start), width: 10 },
          { header: 'End', get: s => t12Full(s.end), width: 10 },
          { header: 'Unpaid Break (min)', get: s => Number(s.breakMin) || 0, width: 12 },
          { header: 'Paid Hours', get: s => Math.round(paidMin(s) / 6) / 10, width: 10 },
          { header: 'Label', get: s => s.label, width: 18 },
          { header: 'Note', get: s => s.note, width: 24 },
          { header: 'Activities', get: s => (s.activities || []).map(a => `${t12Full(a.start)}-${t12Full(a.end)} ${a.label}`).join('; '), width: 30 },
          { header: 'Open Spots', get: s => (s.email ? '' : s.openSlots || 1), width: 10 },
          { header: 'Status', get: STATUS_TEXT, width: 20 },
        ],
      });
    } catch (e) { toastErr?.(e?.message || 'Could not export the schedule.'); }
  }
  const chipTitle = (s, ps) => [ps.title,
    ...(s.activities || []).map(a => `${t12Full(a.start)} - ${t12Full(a.end)}: ${a.label}`),
    s.breakMin ? `${s.breakMin} min unpaid break` : ''].filter(Boolean).join('\n') || undefined;
  // Drag and drop by mouse (Sep 29). The browser's own HTML5 drag turned into
  // a text selection when the press landed on a chip's text, so the grid
  // moves shifts itself: press a shift (or a shift type in the palette), move
  // a few pixels, release over a day. Hold Ctrl or Alt on release to copy.
  // A person's shift can go to anyone or to Open Shifts; an open shift stays
  // in the Open row (Assign gives it to a person); a shift type goes anywhere.
  const accepts = (payload, email) => !!payload && !payload.person && rowEditable(email) && (!!payload.preset || !!payload.email || !email);
  const dropAt = (x, y) => document.elementFromPoint?.(x, y)?.closest?.('[data-drop]')?.getAttribute('data-drop') ?? null;
  const beginDrag = (e, payload) => {
    // A button INSIDE the shift (details, ⋯) is a click, not a drag; the shift
    // itself may be a button (Day view).
    const btn = e.target.closest?.('button');
    if (!canManage || e.button !== 0 || (btn && btn !== e.currentTarget)) return;
    e.preventDefault();   // never start a text selection
    const from = { x: e.clientX, y: e.clientY };
    let moved = false;
    const label = payload.preset ? (payload.preset.code || payload.preset.name) : (payload.code || 'Shift');
    const move = (ev) => {
      if (!moved && Math.hypot(ev.clientX - from.x, ev.clientY - from.y) < 5) return;
      if (!moved) { moved = true; setDrag(payload); document.body.classList.add('sched-dragging'); }
      setGhost({ x: ev.clientX, y: ev.clientY, label, copy: !payload.preset && (ev.ctrlKey || ev.altKey) });
      const key = dropAt(ev.clientX, ev.clientY);
      setDropKey(key != null && accepts(payload, key.split('|')[0]) ? key : '');
    };
    const up = (ev) => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.classList.remove('sched-dragging');
      setGhost(null); setDrag(null); setDropKey('');
      if (!moved) return;
      suppressClick.current = true;           // the release is not a click on what is underneath
      setTimeout(() => { suppressClick.current = false; }, 0);
      const key = dropAt(ev.clientX, ev.clientY);
      if (key == null) return;
      const [email, ds] = key.split('|');
      if (!accepts(payload, email)) return;
      if (payload.preset) placePreset(payload.preset, email, ds);
      else moveShift(payload, email, ds, !!(ev.ctrlKey || ev.altKey));
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  const dragProps = (s) => (shiftEditable(s) && !s.pendingDelete ? { onMouseDown: (e) => beginDrag(e, s) } : {});
  // Another team's shift opens read-only details instead of the editor.
  const openShift = (e, s, email, ds) => {
    if (!shiftEditable(s)) { setDetails({ x: e.clientX, y: e.clientY, shift: s, readOnly: true }); return; }
    if (email) setCell({ email, date: ds, existing: s }); else openExisting(ds, s);
  };
  const dropProps = (email, ds) => ({ 'data-drop': `${email}|${ds}` });
  const clickable = (fn) => (e) => { if (suppressClick.current) { e.stopPropagation(); return; } fn(e); };
  // Teams' hover toolbar on a shift: a magnifier for its details and ⋯ for
  // the menu (Neil, Sep 29).
  const chipTools = (email, ds, s) => (shiftEditable(s) && !s.pendingDelete && !compact ? (
    <span className="chip-tools" style={{ position: 'absolute', top: 3, right: 3, display: 'flex', flexDirection: 'column', gap: 2, opacity: 0 }}>
      <button type="button" aria-label="Shift details" title="Details"
        onClick={(e) => { e.stopPropagation(); setDetails({ x: e.clientX, y: e.clientY, shift: s }); }} style={TOOL_BTN}><Search size={11} /></button>
      <button type="button" aria-label="Shift options" title="More options" onClick={(e) => openMenu(e, email, ds, s)} style={TOOL_BTN}><MoreHorizontal size={12} /></button>
    </span>
  ) : null);
  // The grid never selects text or lets the browser drag its content (a press
  // on a name or a time-off card used to select it and drag the selection).
  const noSelect = { userSelect: 'none', WebkitUserSelect: 'none' };
  const noNativeDrag = (e) => e.preventDefault();
  const dropStyle = (email, ds) => (dropKey === `${email}|${ds}`
    ? { outline: '2px dashed hsl(var(--color-green))', outlineOffset: -3, background: 'hsla(var(--color-green),0.06)' } : {});
  async function copySchedule(payload) {
    setBusy(true);
    try {
      const r = await api.timeSchedCopy(payload);
      const bits = [`Copied ${r.created} shift${r.created !== 1 ? 's' : ''} to ${formatDate(r.targetStart)} - ${formatDate(r.targetEnd)} as drafts`];
      if (r.replaced) bits.push(`replaced ${r.replaced}`);
      if (r.skipped) bits.push(`kept ${r.skipped} existing`);
      if (r.timeoffSkipped) bits.push(`skipped ${r.timeoffSkipped} on time off`);
      if (r.timeoffCopied) bits.push(`${r.timeoffCopied} time-off request${r.timeoffCopied !== 1 ? 's' : ''} to approve in Requests`);
      toastOk?.(bits.join(' · ') + '. Publish to share them.');
      if (r.timeoffCopied) setInboxTick((t) => t + 1);
      setCopyOpen(false); load();
    } catch (e) { toastErr?.(e?.message || 'Could not copy the schedule.'); }
    setBusy(false);
  }
  async function clearSchedule(payload) {
    setBusy(true);
    try {
      const r = await api.timeSchedClear(payload);
      const bits = [];
      if (r.removed) bits.push(`${r.removed} draft${r.removed !== 1 ? 's' : ''} removed`);
      if (r.pending) bits.push(`${r.pending} published shift${r.pending !== 1 ? 's' : ''} marked for removal until you publish`);
      toastOk?.(bits.length ? `${bits.join(' · ')}.` : 'There were no shifts to clear.');
      setClearOpen(false); load();
    } catch (e) { toastErr?.(e?.message || 'Could not clear the schedule.'); }
    setBusy(false);
  }
  async function bulkAssign(payload) {
    setBusy(true);
    try {
      const r = await api.timeSchedBulk(payload);
      const bits = [`Placed ${r.created} shift${r.created !== 1 ? 's' : ''} across ${r.people} ${r.people === 1 ? 'person' : 'people'}`];
      if (r.replaced) bits.push(`replaced ${r.replaced}`);
      if (r.skipped) bits.push(`kept ${r.skipped} existing`);
      if (r.timeoffSkipped) bits.push(`skipped ${r.timeoffSkipped} on time off`);
      toastOk?.(bits.join(' · ') + '.');
      setBulkOpen(false); load();
    } catch (e) { toastErr?.(e?.message || 'Could not fill the schedule.'); }
    setBusy(false);
  }

  async function teamCall(fn, ok) {
    setBusy(true);
    try { await fn(); if (ok) toastOk?.(ok); load(); return true; }
    catch (e) { toastErr?.(e?.message || 'Could not update the team.'); return false; }
    finally { setBusy(false); }
  }
  async function teamAction(g, action) {
    if (action === 'rename') {
      const name = await dialog.prompt('Team name', { title: 'Rename Team', defaultValue: g.name, required: true, confirmText: 'Rename' });
      if (name && name.trim() && name.trim() !== g.name) teamCall(() => api.timeShiftGroupMeta(g.id, { name: name.trim() }), 'Team renamed.');
    } else if (action === 'archive') {
      teamCall(() => api.timeShiftGroupMeta(g.id, { archived: !g.archived }),
        g.archived ? `${g.name} restored.` : `${g.name} archived. Find it under Archived Teams.`);
      if (!g.archived && groupFilter === g.id) setGroupFilter('');
    } else if (action === 'reorder') setReorderOpen(true);
    else if (action === 'manage') window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'shifts', sub: 'presets' } }));
    else if (action === 'delete') {
      const ok = await dialog.confirm(`Delete the team ${g.name}? Its people stay on the schedule; only the team goes.`,
        { title: 'Delete Team', confirmText: 'Delete', danger: true });
      if (ok) { if (groupFilter === g.id) setGroupFilter(''); teamCall(() => api.timeShiftGroupDelete(g.id), 'Team deleted.'); }
    }
  }
  async function addMembers(emails) {
    const g = addTo;
    if (await teamCall(() => api.timeShiftGroupMembers(g.id, { add: emails }),
      `Added ${emails.length} ${emails.length === 1 ? 'person' : 'people'} to ${g.name}.`)) setAddTo(null);
  }
  // Drag a person onto another team's header (Neil, Sep 30): they join that
  // team and leave the one they were dragged from (when you may change it).
  const canMovePeople = canManage && groupBy === 'group' && prefs.teams !== false && (data?.groups || []).some(g => g.canEdit);
  const beginPersonDrag = (e, email, from) => {
    if (!canMovePeople || e.button !== 0) return;
    e.preventDefault();
    const at = { x: e.clientX, y: e.clientY };
    let moved = false;
    const teamAt = (x, y) => document.elementFromPoint?.(x, y)?.closest?.('[data-team]')?.getAttribute('data-team') ?? null;
    const target = (id) => (data?.groups || []).find(g => g.id === id && g.canEdit && id !== from.id);
    const move = (ev) => {
      if (!moved && Math.hypot(ev.clientX - at.x, ev.clientY - at.y) < 5) return;
      if (!moved) { moved = true; document.body.classList.add('sched-dragging'); }
      setGhost({ x: ev.clientX, y: ev.clientY, label: names[email] || email });
      const id = teamAt(ev.clientX, ev.clientY);
      setDropKey(id && target(id) ? `team:${id}` : '');
    };
    const up = (ev) => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.classList.remove('sched-dragging');
      setGhost(null); setDropKey('');
      if (!moved) return;
      const to = target(teamAt(ev.clientX, ev.clientY));
      if (!to) return;
      const who = names[email] || email;
      teamCall(async () => {
        await api.timeShiftGroupMembers(to.id, { add: [email] });
        if (from.id && from.canEdit) await api.timeShiftGroupMembers(from.id, { remove: [email] });
      }, `${who} moved to ${to.name}.`);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const shiftRange = (n) => setCursor((c) => {
    const d = new Date(c);
    if (view === 'month') return new Date(d.getFullYear(), d.getMonth() + n, 1);
    d.setDate(d.getDate() + n * (view === 'day' ? 1 : view === 'twoweeks' ? 14 : 7));
    return d;
  });
  const rangeLabel = view === 'day'
    ? `${days[0].toLocaleDateString('en-US', { weekday: 'long' })}, ${formatDate(days[0])}`
    : view === 'month' ? days[0].toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
      : `${formatDate(days[0])} - ${formatDate(days[days.length - 1])}`;
  const viewLabel = VIEWS.find(([k]) => k === view)?.[1] || 'Week';
  const openDay = (ds) => { const [y, m, d] = ds.split('-').map(Number); setCursor(new Date(y, m - 1, d)); setView('day'); };

  const DAY_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const GRID = { display: 'grid', gridTemplateColumns: `190px repeat(${days.length}, minmax(${compact ? 44 : 120}px, 1fr))` };
  const gridMin = compact ? 190 + days.length * 46 : 190 + days.length * 120;
  const shareTitle = unpublished ? 'Share these shifts with the team' : 'Everything here is already shared';

  return (
    <div style={{ fontFamily: 'Inter,sans-serif' }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <button className="secondary-btn" onClick={() => setCursor(new Date())}
          style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 5 }}><CalendarDays size={13} /> Today</button>
        <div style={{ display: 'flex', gap: 2 }}>
          <button className="icon-btn" onClick={() => shiftRange(-1)} aria-label={`Previous ${viewLabel.toLowerCase()}`} style={{ padding: 6 }}><ChevronLeft size={16} /></button>
          <button className="icon-btn" onClick={() => shiftRange(1)} aria-label={`Next ${viewLabel.toLowerCase()}`} style={{ padding: 6 }}><ChevronRight size={16} /></button>
        </div>
        <span style={{ fontSize: 14, fontWeight: 800 }}>{rangeLabel}</span>
        <div role="group" aria-label="View" style={{ display: 'inline-flex', border: '1px solid var(--line)', borderRadius: 8, overflow: 'hidden' }}>
          {VIEWS.map(([k, label]) => (
            <button key={k} type="button" onClick={() => setView(k)} aria-pressed={view === k}
              style={{ border: 'none', padding: '5px 11px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
                background: view === k ? 'hsla(var(--color-green),0.12)' : 'transparent', color: view === k ? 'hsl(var(--color-green))' : 'var(--muted)' }}>{label}</button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        {canManage && (
          <>
            <button className="secondary-btn" onClick={() => setBulkOpen(true)}
              style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <CalendarRange size={14} /> Fill Schedule
            </button>
            <button className="secondary-btn" onClick={() => setCopyOpen(true)}
              style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Copy size={14} /> Copy Schedule
            </button>
            <button className="secondary-btn" onClick={() => setClearOpen(true)}
              style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Trash2 size={14} /> Clear
            </button>
            <button className="secondary-btn" onClick={() => setImportOpen(true)}
              style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Upload size={14} /> Import
            </button>
            <button className="secondary-btn" onClick={() => setInboxOpen(true)} aria-label={`Requests, ${requestCount} waiting`}
              style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Inbox size={14} /> Requests
              {requestCount > 0 && <span style={{ fontSize: 10.5, fontWeight: 800, background: '#b91c1c', color: '#fff', borderRadius: 10, padding: '0 6px' }}>{requestCount}</span>}
            </button>
          </>
        )}
        {canManage && unshared > 0 && (
          <button className="secondary-btn" onClick={discardAll} disabled={busy}
            title="Undo edits and removals that are not published yet"
            style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <RotateCcw size={13} /> Discard Changes ({unshared})
          </button>
        )}
        {canManage && (
          <button className={unpublished ? 'primary-btn' : 'secondary-btn'} onClick={() => setPublishAsk(true)}
            disabled={busy || !unpublished} title={shareTitle}
            style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Send size={13} /> {unpublished ? `Publish ${unpublished}` : 'All shared'}
          </button>
        )}
        <button className="secondary-btn" onClick={exportSchedule} disabled={!data}
          style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Download size={14} /> Export
        </button>
        <button className="secondary-btn" onClick={printView} disabled={!data}
          style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Printer size={14} /> Print
        </button>
        {canManage && data && prefs.conflicts !== false && (
          <span title={conflictShifts.map(s => `${names[s.email] || 'Open'} ${formatDate(s.date)}: ${s.conflicts.join(' ')}`).join('\n') || 'No conflicts'}
            style={{ fontSize: 12, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 4, color: conflictShifts.length ? '#d97706' : 'var(--muted)' }}>
            <AlertTriangle size={13} /> {conflictShifts.length} Conflict{conflictShifts.length === 1 ? '' : 's'}
          </span>
        )}
        <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 700 }}>{viewLabel}: {fmtHrs(weekMin)}</span>
      </div>

      {/* Filter (Sep 29): name/email search and a shift group. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, border: '1px solid var(--line)', borderRadius: 8, padding: '4px 10px', background: 'var(--card)', minWidth: 220 }}>
          <Search size={13} color="var(--muted)" />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search people" aria-label="Search people"
            style={{ border: 'none', outline: 'none', background: 'transparent', fontSize: 12.5, flex: 1, fontFamily: 'inherit', color: 'var(--ink)' }} />
        </label>
        <TeamSwitcher groups={data?.groups || []} value={groupFilter} onChange={setGroupFilter} />
        <select className="form-input" value={groupBy} onChange={e => setGroupBy(e.target.value)} aria-label="Group people by"
          style={{ width: 'auto', fontSize: 12.5, padding: '5px 30px 5px 10px' }}>
          <option value="group">By team</option>
          <option value="location">By location</option>
        </select>
        <select className="form-input" value={presetFilter} onChange={e => setPresetFilter(e.target.value)} aria-label="Filter by shift type"
          style={{ width: 'auto', fontSize: 12.5, padding: '5px 30px 5px 10px' }}>
          <option value="">All shift types</option>
          {(data?.shifts || []).map(p => <option key={p.id} value={p.id}>{p.code ? `${p.code} · ` : ''}{p.name}</option>)}
        </select>
        {filtering && <button type="button" className="secondary-btn" onClick={() => { setQuery(''); setGroupFilter(''); setPresetFilter(''); }} style={{ fontSize: 12 }}>Clear Filters</button>}
        <ViewMenu prefs={prefs} onChange={setPrefs} canViewByShift={view === 'week'} />
        {canManage && view !== 'day' && (
          <span style={{ fontSize: 11.5, color: 'var(--muted)', marginLeft: 'auto' }}>
            Drag a shift to move it · hold Ctrl to copy{canMovePeople ? ' · drag a name onto a team to move them' : ''}
          </span>
        )}
      </div>

      {copied && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, padding: '8px 12px',
          background: 'hsla(var(--color-green),0.08)', border: '1px dashed hsl(var(--color-green))', borderRadius: 10, fontSize: 12.5 }}>
          <Copy size={14} style={{ color: 'hsl(var(--color-green))' }} />
          <span style={{ fontWeight: 700 }}>Copied {copied.code || 'shift'} ({t12(copied.start)}-{t12(copied.end)})</span>
          <span style={{ color: 'var(--muted)' }}>- click any empty cell to place it.</span>
          <div style={{ flex: 1 }} />
          <button className="secondary-btn" onClick={() => setCopied(null)} style={{ fontSize: 12 }}>Cancel</button>
        </div>
      )}

      {data === null ? (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}><Spinner size="inline" /></div>
      ) : view === 'day' ? (
        <div style={noSelect} onDragStart={noNativeDrag}>
        <DayView date={start} groups={groupsView} shifts={shown} notes={notes} canManage={canManage}
          offOn={offOn} holOn={holOn} chipTitle={chipTitle}
          dragProps={dragProps} dropProps={dropProps} dropStyle={dropStyle} clickable={clickable}
          onMenu={(e, email, s) => openMenu(e, email, start, s)}
          onEditNote={() => setNoteEdit({ date: start, note: notes[start] || '' })}
          onOpenShift={(s) => (!shiftEditable(s) ? toastErr?.(readOnlyMsg) : s.email ? setCell({ email: s.email, date: start, existing: s }) : openExisting(start, s))}
          onAdd={(email) => (!rowEditable(email) ? toastErr?.(readOnlyMsg) : email ? setCell({ email, date: start }) : setOpenCell({ date: start }))} />
        </div>
      ) : rowsBy === 'shifts' && view === 'week' ? (
        <ShiftTypeWeek days={days} shifts={shown} presets={data.shifts || []} names={names}
          onOpen={(s) => (s.email ? setCell({ email: s.email, date: s.date, existing: s }) : openExisting(s.date, s))} />
      ) : (
        <div>
        {canManage && (
          <ShiftPalette presets={data.shifts || []} onStart={(e, p) => beginDrag(e, { preset: p })} />
        )}
        <div style={{ overflowX: 'auto', border: '1px solid var(--line)', borderRadius: 12, ...noSelect }} onDragStart={noNativeDrag}>
          <div style={{ minWidth: gridMin }}>
            {/* Day header */}
            <div style={{ ...GRID, borderBottom: '1px solid var(--line)', background: 'var(--bg)' }}>
              <div style={{ padding: '8px 12px', fontSize: 11, fontWeight: 800, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em' }}>Schedule</div>
              {days.map((d, i) => {
                const st = dayStats(d);
                const ds = isoDate(d);
                const today = ds === isoDate(new Date());
                const isHolDay = holidayDates.has(ds);
                return (
                  <div key={i} style={{ padding: compact ? '6px 4px' : '8px 10px', borderLeft: '1px solid var(--line)', minWidth: 0, background: today ? 'hsla(var(--color-green),0.06)' : isHolDay ? 'rgba(37,99,235,0.06)' : 'transparent' }}>
                    <button type="button" onClick={() => openDay(ds)} aria-label={`Open ${formatDate(ds)}`} title="Open this day"
                      style={{ display: 'flex', alignItems: 'baseline', gap: 5, border: 'none', background: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: compact ? 13 : 16, fontWeight: 800, color: today ? 'hsl(var(--color-green))' : 'var(--ink)' }}>{d.getDate()}</span>
                      <span style={{ fontSize: compact ? 9.5 : 11, color: 'var(--muted)', textTransform: 'uppercase' }}>{d.toLocaleDateString('en-US', { weekday: compact ? 'narrow' : 'short' })}</span>
                    </button>
                    <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                      title={`${st.people} ${st.people === 1 ? 'person' : 'people'} · ${fmtHrs(st.min)}`}>{compact ? Math.round(st.min / 60) || '' : `${st.people} · ${fmtHrs(st.min)}`}</div>
                    {isHolDay && <div style={{ fontSize: 10, fontWeight: 700, color: '#2563eb', marginTop: 2 }}>{compact ? 'Hol' : 'Holiday'}</div>}
                    {(notes[ds] || canManage) && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 3, minWidth: 0 }}>
                        {!compact && notes[ds] && <span title={notes[ds]} style={{ fontSize: 10.5, fontWeight: 600, color: '#b45309', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{notes[ds]}</span>}
                        {canManage && (
                          <button type="button" onClick={() => setNoteEdit({ date: ds, note: notes[ds] || '' })}
                            aria-label={notes[ds] ? `Edit the note for ${formatDate(ds)}` : `Add a note for ${formatDate(ds)}`}
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

            {/* Open shifts row (Teams-style): unassigned slots to hand out */}
            {showOpen && (
            <div style={{ ...GRID, borderBottom: '1px solid var(--line)', background: 'hsla(var(--color-green),0.03)' }}>
              <div style={{ padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <span style={{ width: 26, height: 26, borderRadius: 7, background: 'var(--card)', border: '1px dashed var(--line)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', flexShrink: 0 }}>
                  <CalendarRange size={13} />
                </span>
                <span>
                  <div style={{ fontSize: 12.5, fontWeight: 800 }}>Open Shifts</div>
                  <div style={{ fontSize: 10.5, color: 'var(--muted)' }}>{openCount} open</div>
                </span>
              </div>
              {days.map((d, di) => {
                const ds = isoDate(d);
                const items = openByDate[ds] || [];
                return (
                  <div key={di} onClick={clickable(() => !items.length && (copied ? pasteInto('', ds) : setOpenCell({ date: ds })))} {...dropProps('', ds)}
                    {...hoverCell('', ds)} onContextMenu={(e) => openMenu(e, '', ds, null)}
                    style={{ borderLeft: '1px solid var(--line)', padding: 4, minHeight: 48, cursor: items.length ? 'default' : 'pointer', position: 'relative', ...dropStyle('', ds) }}
                    className="sched-cell">
                    {items.map(s => { const ps = pendingState(s); return (
                      <div key={s.id} onClick={clickable((e) => { e.stopPropagation(); openShift(e, s, '', ds); })}
                        title={chipTitle(s, ps)} {...dragProps(s)} {...hoverShift(s)} onContextMenu={(e) => openMenu(e, '', ds, s)}
                        className="sched-chip"
                        style={{ position: 'relative', background: (s.color || '#16a34a') + '18', border: `1px dashed ${s.color || '#16a34a'}`, borderRadius: 6, padding: compact ? '3px 4px' : '5px 24px 5px 8px', marginBottom: 3, cursor: shiftEditable(s) ? 'grab' : 'pointer', overflow: 'hidden', userSelect: 'none', ...ps.style, ...(drag?.id === s.id ? { opacity: 0.4 } : {}) }}>
                        {chipTools('', ds, s)}
                        <div style={{ fontSize: 11, fontWeight: 800, color: '#166534', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4 }}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            {s.published === false && <Star size={10} fill="#f59e0b" color="#f59e0b" style={{ flexShrink: 0 }} />}
                            {s.code || 'Open'}
                            {ps.tag && <span style={{ fontSize: 9.5, fontWeight: 700, color: '#b45309' }}>{ps.tag}</span>}
                          </span>
                          {(s.openSlots || 1) > 1 && <span style={{ fontSize: 10, background: '#16a34a', color: '#fff', borderRadius: 10, padding: '0 6px' }}>×{s.openSlots}</span>}
                        </div>
                        <div style={{ fontSize: 10.5, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 3 }}><Clock size={9} /> {t12(s.start)}-{t12(s.end)}</div>
                        {s.label && <div style={{ fontSize: 10, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.label}</div>}
                      </div>
                    ); })}
                    {!items.length && (
                      <div className="sched-add" style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--line)', opacity: 0 }}>
                        <Plus size={16} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            )}

            {/* Group + employee rows */}
            {groupsView.length === 0 && (
              <div style={{ padding: 24, textAlign: 'center', fontSize: 12.5, color: 'var(--muted)' }}>No employees in scope.</div>
            )}
            {groupsView.map((g, gi) => (
              <div key={gi}>
                <div data-team={g.id || undefined}
                  style={{ ...GRID, background: 'var(--bg)', borderBottom: '1px solid var(--line)', borderTop: gi ? '1px solid var(--line)' : 'none',
                    ...(dropKey === `team:${g.id}` ? { outline: '2px dashed hsl(var(--color-green))', outlineOffset: -3, background: 'hsla(var(--color-green),0.08)' } : {}) }}>
                  <div style={{ padding: '6px 12px', gridColumn: '1 / -1', fontSize: 12, fontWeight: 800, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span>{g.name}{g.archived ? ' (Archived)' : ''}</span>
                    <span style={{ color: 'var(--muted)', fontWeight: 600 }}>· {fmtHrs(g.members.reduce((a, m) => a + empWeekMin(m.email), 0))} · {g.members.length} {g.members.length === 1 ? 'person' : 'people'}</span>
                    {g.id && g.canEdit && groupBy === 'group' && (
                      <>
                        <button type="button" onClick={() => setAddTo((data.groups || []).find(x => x.id === g.id))}
                          style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'hsl(var(--color-green))', fontSize: 11.5, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 3, padding: 0, fontFamily: 'inherit' }}>
                          <Plus size={12} /> Add Members
                        </button>
                        <TeamMenu team={g} canReorder={!data.groupScheduler && (data.groups || []).every(x => x.canEdit)} onAction={(a) => teamAction(g, a)} />
                      </>
                    )}
                  </div>
                </div>
                {g.members.length === 0 && (
                  <div style={{ padding: '10px 12px', fontSize: 12, color: 'var(--muted)', borderBottom: '1px solid var(--line)' }}>Nobody on this team yet.</div>
                )}
                {g.members.map(emp => { const over = overWeeks(emp.email); const editable = rowEditable(emp.email); return (
                  <div key={emp.email} aria-current={emp.email === me ? 'true' : undefined}
                    style={{ ...GRID, borderBottom: '1px solid var(--line)', background: emp.email === me ? 'var(--wk-brand-tint)' : undefined }}>
                    <div onMouseDown={canMovePeople ? (e) => beginPersonDrag(e, emp.email, g) : undefined}
                      title={canMovePeople ? 'Drag onto a team to move them' : undefined}
                      style={{ padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, cursor: canMovePeople ? 'grab' : undefined,
                      boxShadow: emp.email === me ? 'inset 3px 0 0 var(--wk-brand)' : 'none' }}>
                      {prefs.photos !== false && <Avatar name={emp.name || emp.email} photoUrl={emp.photoUrl} size={30} />}
                      <span style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 12.5, fontWeight: emp.email === me ? 800 : 700, color: emp.email === me ? 'var(--wk-brand)' : undefined, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {emp.name || emp.email}
                          {emp.email === me && <span style={{ fontSize: 9.5, fontWeight: 800, color: '#fff', background: 'var(--wk-brand)', borderRadius: 999, padding: '1px 6px', marginLeft: 6, letterSpacing: '.03em', verticalAlign: 'middle' }}>YOU</span>}
                        </div>
                        <div style={{ fontSize: 10.5, color: over.length ? '#b91c1c' : 'var(--muted)', fontWeight: over.length ? 800 : 400, display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' }}
                          title={over.length ? `Over 40 scheduled hours in a week (${over.map(fmtHrs).join(', ')})` : undefined}>
                          {over.length > 0 && <AlertTriangle size={10} aria-label="Over 40 hours" />}
                          {fmtHrs(empWeekMin(emp.email))}{over.length > 0 && ' · Over 40'}
                          {/* One person's usual hours (Visesh, 09/30: "how do I change an individual's timings"): a preset per person, not only per team - on rows this manager may change. */}
                          {canManage && editable && (
                            <select value={data?.usual?.[emp.email] || ''} aria-label={`Usual hours for ${emp.name || emp.email}`} title="Usual hours - the preset this person is on. Shown faintly on empty days; never counted until a shift is placed."
                              onClick={(e) => e.stopPropagation()} onChange={(e) => setUsual(emp.email, e.target.value)}
                              style={{ fontSize: 10, fontWeight: 400, height: 18, padding: '0 2px', marginLeft: 3, border: '1px solid var(--line)', borderRadius: 5, background: 'var(--card)', color: 'var(--muted)', maxWidth: 120 }}>
                              <option value="">No usual hours</option>
                              {(data?.shifts || []).map((p) => <option key={p.id} value={p.id}>{p.name} {t12(p.start)}-{t12(p.end)}</option>)}
                            </select>
                          )}
                        </div>
                        {!editable && canManage && <div style={{ fontSize: 10, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 3 }}><Lock size={9} /> View only</div>}
                        {prefs.availability !== false && data.availability?.[emp.email]?.length > 0 && (
                          <div title={`Availability: ${availText(data.availability[emp.email])}`}
                            style={{ fontSize: 10, color: '#b45309', fontWeight: 600 }}>Limited availability</div>
                        )}
                      </span>
                    </div>
                    {days.map((d, di) => {
                      const ds = isoDate(d);
                      const items = byCell[`${emp.email}|${ds}`] || [];
                      const off = offOn(emp.email, ds);
                      const hol = !off ? holOn(emp.email, ds) : null;
                      return (
                        <div key={di} onClick={clickable(() => { if (!items.length && editable) { copied ? pasteInto(emp.email, ds) : (!off && !hol && setCell({ email: emp.email, date: ds })); } })}
                          {...dropProps(emp.email, ds)} data-cell={`${emp.email}|${ds}`}
                          {...(editable ? hoverCell(emp.email, ds) : {})} onContextMenu={(e) => openMenu(e, emp.email, ds, null)}
                          style={{ borderLeft: '1px solid var(--line)', padding: compact ? 2 : 4, minHeight: 54, minWidth: 0, cursor: items.length || !editable ? 'default' : 'pointer', position: 'relative', ...dropStyle(emp.email, ds) }}
                          className="sched-cell">
                          {/* Confidential time off (Sep 29): a neutral tint (the
                              tint would name the type) and never the note - the
                              grid is often up on a shared screen, so not even
                              the approver's own view shows it here. */}
                          {off && !items.length && (
                            <div title={off.confidential ? 'Confidential time off' : undefined}
                              style={{ background: TYPE_TINT[off.type] || TYPE_TINT.other, borderRadius: 6, padding: compact ? '4px 3px' : '6px 8px', height: '100%', overflow: 'hidden' }}>
                              <div style={{ fontSize: 11, fontWeight: 700, color: '#9f1239', display: 'flex', alignItems: 'center', gap: 4 }}>
                                {off.status === 'approved' ? 'Off' : 'Requested off'}{off.confidential && <Lock size={10} aria-label="Confidential" />}
                              </div>
                              {!compact && <div style={{ fontSize: 10, color: '#9f1239' }}>
                                {off.startDate !== off.endDate ? `${formatDate(off.startDate)} - ${formatDate(off.endDate)}`
                                  : off.startTime ? `${t12Full(off.startTime)} - ${t12Full(off.endTime)}` : 'All Day'}
                              </div>}
                              {!compact && off.note && !off.confidential && <div title={off.note} style={{ fontSize: 10, color: '#9f1239', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{off.note}</div>}
                            </div>
                          )}
                          {hol && !items.length && (
                            <div title={hol.name} style={{ background: 'rgba(37,99,235,0.1)', borderRadius: 6, padding: '6px 8px', height: '100%' }}>
                              <div style={{ fontSize: 11, fontWeight: 700, color: '#2563eb' }}>
                                {hol.type === 'half_day' ? 'Half-day holiday' : 'Holiday'}
                              </div>
                              <div style={{ fontSize: 10, color: '#2563eb', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{hol.name}</div>
                            </div>
                          )}
                          {items.map(s => { const ps = pendingState(s); return (
                            <div key={s.id} onClick={clickable((e) => { e.stopPropagation(); openShift(e, s, emp.email, ds); })}
                              title={chipTitle(s, ps)} {...dragProps(s)} {...hoverShift(s)} className="sched-chip"
                              onContextMenu={(e) => openMenu(e, emp.email, ds, s)}
                              style={{ position: 'relative', background: (s.color || '#64748b') + '22', borderLeft: `3px solid ${s.color || '#64748b'}`, borderRadius: 6, padding: compact ? '3px 3px 3px 4px' : '5px 24px 5px 8px', marginBottom: 3, cursor: shiftEditable(s) ? 'grab' : 'pointer', overflow: 'hidden', userSelect: 'none',
                                ...(s.published === false ? { outline: `1.5px dashed ${s.color || '#64748b'}`, outlineOffset: -2, opacity: 0.9 } : {}), ...ps.style, ...(drag?.id === s.id ? { opacity: 0.4 } : {}) }}>
                              {chipTools(emp.email, ds, s)}
                              <div style={{ fontSize: 11, fontWeight: 800, color: '#334155', display: 'flex', alignItems: 'center', gap: 4 }}>
                                {s.published === false && <Star size={10} fill="#f59e0b" color="#f59e0b" style={{ flexShrink: 0 }} />}
                                <span>{s.code || 'Shift'}</span>
                                {ps.tag && <span style={{ fontSize: 9.5, fontWeight: 700, color: '#b45309' }}>{ps.tag}</span>}
                                {prefs.conflicts !== false && s.conflicts?.length > 0 && (
                                  <span title={s.conflicts.join('\n')} aria-label={`Warning: ${s.conflicts.join(' ')}`} style={{ marginLeft: 'auto', display: 'inline-flex' }}>
                                    <AlertTriangle size={11} color="#d97706" />
                                  </span>
                                )}
                              </div>
                              {compact ? <div style={{ fontSize: 9.5, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t12(s.start)}</div> : (
                              <div style={{ fontSize: 10.5, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 3 }}><Clock size={9} /> {t12(s.start)}-{t12(s.end)}</div>)}
                              {!compact && s.label && <div style={{ fontSize: 10, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.label}</div>}
                              {!compact && s.activities?.length > 0 && (
                                <div style={{ fontSize: 10, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {s.activities.length === 1 ? `${t12(s.activities[0].start)} ${s.activities[0].label}` : `${s.activities.length} activities`}
                                </div>
                              )}
                            </div>
                          ); })}
                          {/* The person's availability for this weekday (Visesh, 09/30: it only showed as a tag on the name): unavailable shades the whole cell; limited hours read under the usual hours. */}
                          {availOn(emp.email, d)?.kind === 'unavailable' && !off && !hol && (
                            <div title={`${emp.name || emp.email} is unavailable on ${DAY_LONG[(d.getDay() + 6) % 7]}s`}
                              style={{ position: 'absolute', inset: 0, background: 'repeating-linear-gradient(135deg, rgba(180,83,9,0.10) 0 6px, transparent 6px 12px)', pointerEvents: 'none' }} />
                          )}
                          {!items.length && !off && !hol && availOn(emp.email, d)?.kind === 'unavailable' && (
                            <div style={{ fontSize: 10.5, color: '#b45309', fontWeight: 600, padding: '4px 6px', whiteSpace: 'nowrap', position: 'relative' }}>Unavailable</div>
                          )}
                          {!items.length && !off && !hol && availOn(emp.email, d)?.kind !== 'unavailable' && usualOn(emp.email, d) && (
                            <div title="Usual hours (their default preset). Nothing is on the schedule for this day until a shift is placed."
                              style={{ fontSize: 10.5, color: 'var(--muted)', padding: '4px 6px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              Usual {t12(usualOn(emp.email, d).start)}-{t12(usualOn(emp.email, d).end)}
                            </div>
                          )}
                          {!off && !hol && availOn(emp.email, d) && availOn(emp.email, d).kind !== 'unavailable' && (
                            <div title={`Available ${t12(availOn(emp.email, d).start)}-${t12(availOn(emp.email, d).end)} on ${DAY_LONG[(d.getDay() + 6) % 7]}s`}
                              style={{ fontSize: 10, color: '#b45309', fontWeight: 600, padding: '0 6px 4px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', position: 'relative' }}>
                              Available {t12(availOn(emp.email, d).start)}-{t12(availOn(emp.email, d).end)}
                            </div>
                          )}
                          {!items.length && !off && !hol && (
                            <div className="sched-add" style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--line)', opacity: 0 }}>
                              <Plus size={16} />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ); })}
              </div>
            ))}
          </div>
        </div>
        </div>
      )}

      {ghost && (
        <div style={{ position: 'fixed', left: ghost.x + 12, top: ghost.y + 10, zIndex: 1600, pointerEvents: 'none', fontSize: 11.5, fontWeight: 800,
          background: 'var(--card)', border: '1px solid hsl(var(--color-green))', borderRadius: 6, padding: '4px 9px', boxShadow: '0 6px 18px rgba(0,0,0,0.18)' }}>
          {ghost.copy ? `Copy ${ghost.label}` : ghost.label}
        </div>
      )}

      {details && (
        <ShiftDetails at={details} shift={details.shift} name={details.shift.email ? (names[details.shift.email] || details.shift.email) : 'Open shift'}
          status={STATUS_TEXT(details.shift)} onClose={() => setDetails(null)}
          onEdit={details.readOnly ? undefined : () => { const s = details.shift; setDetails(null); (s.email ? setCell({ email: s.email, date: s.date, existing: s }) : openExisting(s.date, s)); }} />
      )}

      {menu && (
        <ShiftMenu menu={menu} colors={SHIFT_COLORS} canTimeOff={!data?.groupScheduler} hasCopied={!!copied}
          onAction={menuAction} onClose={() => setMenu(null)} />
      )}

      {cell && (
        <CellModal cell={cell} shifts={data?.shifts || []} busy={busy}
          onSave={saveCell} onDelete={delCell} onDiscard={discardCell} onClose={() => setCell(null)}
          onCopy={(s) => { setCopied(s); setCell(null); }}
          onTimeOff={data?.groupScheduler ? undefined : () => { setOffCell({ email: cell.email, date: cell.date }); setCell(null); }} />
      )}

      {offCell && (
        <TimeOffModal email={offCell.email} name={names[offCell.email]} date={offCell.date} busy={busy}
          onSave={saveTimeOff} onClose={() => setOffCell(null)} />
      )}

      {importOpen && (
        <ImportModal employees={data?.employees || []} busy={busy} onImport={importRows} onClose={() => setImportOpen(false)} />
      )}

      {publishAsk && (
        <PublishModal count={unpublished} busy={busy} onPublish={publishWeek} onClose={() => setPublishAsk(false)} />
      )}

      {addTo && (
        <AddMembersModal team={addTo} busy={busy} onAdd={addMembers} onClose={() => setAddTo(null)}
          onManage={() => { setAddTo(null); teamAction(addTo, 'manage'); }} />
      )}

      {reorderOpen && (
        <ReorderTeamsModal groups={data?.groups || []} busy={busy} onClose={() => setReorderOpen(false)}
          onSave={async (ids) => { if (await teamCall(() => api.timeShiftGroupReorder(ids), 'Team order saved.')) setReorderOpen(false); }} />
      )}

      {noteEdit && (
        <DayNoteModal date={noteEdit.date} note={noteEdit.note} busy={busy}
          onSave={(text) => saveDayNote(noteEdit.date, text)} onClose={() => setNoteEdit(null)} />
      )}

      {inboxOpen && (
        <ShiftRequestsInbox toastOk={toastOk} toastErr={toastErr} onClose={() => setInboxOpen(false)} canConfigure={data?.canConfigure ?? !data?.groupScheduler}
          onChanged={() => { setInboxTick((t) => t + 1); load(); }} />
      )}

      {copyOpen && (
        <CopyModal groups={data?.groups || []} defaultStart={start} defaultEnd={end} busy={busy}
          onApply={copySchedule} onClose={() => setCopyOpen(false)} />
      )}

      {clearOpen && (
        <ClearModal groups={data?.groups || []} defaultStart={start} defaultEnd={end} busy={busy}
          onApply={clearSchedule} onClose={() => setClearOpen(false)} />
      )}

      {bulkOpen && (
        <BulkModal groups={data?.groups || []} shifts={data?.shifts || []}
          allEmails={(data?.employees || []).map(e => e.email)}
          defaultStart={start} defaultEnd={end} busy={busy}
          onApply={bulkAssign} onClose={() => setBulkOpen(false)} />
      )}

      {openCell && (
        <OpenShiftModal cell={openCell} shifts={data?.shifts || []} people={data?.employees || []} busy={busy}
          onSave={saveOpen} onAssign={assignOpen} onDelete={delCell} onDiscard={discardCell} onClose={() => setOpenCell(null)} />
      )}

      <style>{`.sched-cell:hover .sched-add { opacity: 1 !important; } .sched-chip:hover .chip-tools, .chip-tools:focus-within { opacity: 1 !important; } .shift-menu-item:hover:not(:disabled) { background: var(--bg) !important; } body.sched-dragging, body.sched-dragging * { cursor: grabbing !important; user-select: none !important; }`}</style>
    </div>
  );
}

// Publish: who to tell (Sep 29, Teams parity). "Changed" = only people whose
// shifts were added, changed or removed (bell + email each); "team" = those,
// plus a short bell to everyone else on the schedule for these dates.
function PublishModal({ count, busy, onPublish, onClose }) {
  const [notify, setNotify] = useState('changed');
  const opt = (value, title, hint) => (
    <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px', borderRadius: 8, cursor: 'pointer',
      border: `1px solid ${notify === value ? 'hsl(var(--color-green))' : 'var(--line)'}`, background: notify === value ? 'hsla(var(--color-green),0.06)' : 'transparent' }}>
      <input type="radio" name="publish-notify" checked={notify === value} onChange={() => setNotify(value)} style={{ marginTop: 3 }} />
      <span><div style={{ fontSize: 13, fontWeight: 700 }}>{title}</div><div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{hint}</div></span>
    </label>
  );
  return (
    <div style={MODAL_BACK} onClick={e => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-label="Publish Schedule" style={{ ...MODAL_CARD, maxWidth: 440 }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
          <span style={{ fontSize: 15, fontWeight: 800, flex: 1 }}>Publish {count} Change{count === 1 ? '' : 's'}</span>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)' }}><X size={18} /></button>
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>The team sees these shifts once you publish. Who should hear about it?</div>
        <div style={{ display: 'grid', gap: 8 }}>
          {opt('changed', 'Only people whose shifts changed', 'Each gets a notification and an email listing their own changes.')}
          {opt('team', 'The whole team', 'The same, plus a short notification to everyone else on the schedule for these dates.')}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
          <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="primary-btn" onClick={() => onPublish(notify)} disabled={busy}>{busy ? '…' : 'Publish'}</button>
        </div>
      </div>
    </div>
  );
}

// A team-wide note on one day (Sep 29, Teams "day notes").
function DayNoteModal({ date, note, busy, onSave, onClose }) {
  const [text, setText] = useState(note || '');
  return (
    <div style={MODAL_BACK} onClick={e => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-label="Day Note" style={{ ...MODAL_CARD, maxWidth: 420 }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
          <span style={{ fontSize: 15, fontWeight: 800, flex: 1 }}>Day Note</span>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)' }}><X size={18} /></button>
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>
          {new Date(`${date}T00:00`).toLocaleDateString('en-US', { weekday: 'long' })}, {formatDate(date)} · the whole team sees this on the schedule and in My Shifts.
        </div>
        <textarea className="form-input" rows={3} maxLength={200} value={text} onChange={e => setText(e.target.value)}
          placeholder="e.g. Inventory day - all hands" aria-label="Day note" style={{ width: '100%', fontSize: 13, resize: 'vertical' }} />
        <div style={{ display: 'flex', gap: 8, marginTop: 14, alignItems: 'center' }}>
          {note && <button type="button" onClick={() => onSave('')} disabled={busy} style={{ background: 'none', border: 'none', color: '#b91c1c', cursor: 'pointer', fontSize: 12.5, fontWeight: 700 }}>Remove</button>}
          <div style={{ flex: 1 }} />
          <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="primary-btn" onClick={() => onSave(text)} disabled={busy || !text.trim()}
            style={{ opacity: text.trim() ? 1 : 0.55 }}>Save</button>
        </div>
      </div>
    </div>
  );
}

// Day (Sep 29): a timeline of who works when. Bars sit on a 24-hour track;
// an overnight shift runs to the right edge. Click a bar to edit it, or an
// empty track to add a shift.
function DayView({ date, groups, shifts, notes, canManage, offOn, holOn, chipTitle, onEditNote, onOpenShift, onAdd,
  dragProps = () => ({}), dropProps = () => ({}), dropStyle = () => ({}), clickable = (fn) => fn, onMenu }) {
  const byEmail = {};
  shifts.forEach(s => { if (s.date === date) (byEmail[s.email || ''] ||= []).push(s); });
  const HOURS = [0, 3, 6, 9, 12, 15, 18, 21];
  const bar = (s) => {
    const a = toMin(s.start);
    const w = Math.min(durMin(s.start, s.end), 1440 - a);
    const ps = pendingState(s);
    return (
      <button key={s.id} type="button" onClick={clickable((e) => { e.stopPropagation(); onOpenShift(s); })} title={chipTitle(s, ps)}
        {...dragProps(s)} onContextMenu={(e) => onMenu?.(e, s.email, s)}
        aria-label={`${s.email ? 'Shift' : 'Open shift'} ${t12(s.start)} to ${t12(s.end)}`}
        style={{ position: 'absolute', top: 5, bottom: 5, left: `${(a / 1440) * 100}%`, width: `${(w / 1440) * 100}%`, minWidth: 28,
          background: (s.color || '#64748b') + '33', border: `1px ${s.email ? 'solid' : 'dashed'} ${s.color || '#64748b'}`, borderRadius: 6,
          fontSize: 10.5, fontWeight: 700, color: '#334155', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', cursor: canManage ? 'grab' : 'pointer',
          padding: '0 6px', textAlign: 'left', fontFamily: 'inherit', ...ps.style }}>
        {s.published === false && '★ '}{t12(s.start)}-{t12(s.end)}{s.label ? ` · ${s.label}` : ''}{s.email ? '' : ` · ${s.openSlots || 1} open`}
      </button>
    );
  };
  const track = (email, extra) => (
    <div onClick={clickable(() => canManage && onAdd(email))} {...dropProps(email, date)} onContextMenu={(e) => onMenu?.(e, email, null)}
      style={{ ...dropStyle(email, date), position: 'relative', height: 38, borderLeft: '1px solid var(--line)', cursor: canManage ? 'pointer' : 'default',
      backgroundImage: 'repeating-linear-gradient(to right, transparent 0, transparent calc(12.5% - 1px), var(--line) calc(12.5% - 1px), var(--line) 12.5%)' }}>
      {extra}
      {(byEmail[email] || []).map(bar)}
    </div>
  );
  const GRID = { display: 'grid', gridTemplateColumns: '190px minmax(560px, 1fr)' };
  return (
    <div style={{ overflowX: 'auto', border: '1px solid var(--line)', borderRadius: 12 }}>
      <div style={{ ...GRID, background: 'var(--bg)', borderBottom: '1px solid var(--line)' }}>
        <div style={{ padding: '8px 12px', fontSize: 11, fontWeight: 800, color: 'var(--muted)', textTransform: 'uppercase' }}>
          Schedule
          {(notes[date] || canManage) && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 3, textTransform: 'none', fontWeight: 600 }}>
              {notes[date] && <span style={{ fontSize: 11, color: '#b45309' }}>{notes[date]}</span>}
              {canManage && <button type="button" onClick={onEditNote} aria-label={notes[date] ? 'Edit the day note' : 'Add a day note'}
                style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--muted)', padding: 0, display: 'inline-flex' }}><StickyNote size={11} /></button>}
            </div>
          )}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', borderLeft: '1px solid var(--line)' }}>
          {HOURS.map(h => <div key={h} style={{ padding: '8px 4px', fontSize: 10.5, color: 'var(--muted)', fontWeight: 700 }}>{t12(`${String(h).padStart(2, '0')}:00`)}</div>)}
        </div>
      </div>
      <div style={{ ...GRID, borderBottom: '1px solid var(--line)', background: 'hsla(var(--color-green),0.03)' }}>
        <div style={{ padding: '10px 12px', fontSize: 12.5, fontWeight: 800 }}>Open Shifts</div>
        {track('')}
      </div>
      {groups.map((g, gi) => (
        <div key={gi}>
          <div style={{ padding: '6px 12px', fontSize: 12, fontWeight: 800, background: 'var(--bg)', borderBottom: '1px solid var(--line)' }}>{g.name}</div>
          {g.members.map(emp => {
            const off = offOn(emp.email, date);
            const hol = !off ? holOn(emp.email, date) : null;
            const shade = off || hol ? (
              <div style={{ position: 'absolute', inset: 0, background: off ? 'rgba(244,63,94,0.08)' : 'rgba(37,99,235,0.08)', display: 'flex', alignItems: 'center', paddingLeft: 8, fontSize: 11, fontWeight: 700, color: off ? '#9f1239' : '#2563eb' }}>
                {off ? (off.status === 'approved' ? 'Off' : 'Requested off') : hol.name}
              </div>
            ) : null;
            return (
              <div key={emp.email} style={{ ...GRID, borderBottom: '1px solid var(--line)' }}>
                <div style={{ padding: '10px 12px', fontSize: 12.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{emp.name || emp.email}</div>
                {track(emp.email, shade)}
              </div>
            );
          })}
        </div>
      ))}
      {groups.length === 0 && <div style={{ padding: 24, textAlign: 'center', fontSize: 12.5, color: 'var(--muted)' }}>Nobody matches the filter.</div>}
    </div>
  );
}

const MODAL_BACK = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, fontFamily: 'Inter,sans-serif' };
const MODAL_CARD = { background: 'var(--card)', borderRadius: 14, width: '100%', maxWidth: 460, padding: 20, maxHeight: '92dvh', overflowY: 'auto' };
const LBL = { fontSize: 11, color: 'var(--muted)', marginBottom: 4, fontWeight: 600 };
const CHECK = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, cursor: 'pointer' };

// "Everyone in view" sends no people at all - the server scopes to the
// caller's team and, unlike a group, still includes open shifts.
function GroupPick({ groups, value, onChange }) {
  return (
    <select className="form-input" value={value} onChange={e => onChange(e.target.value)} style={{ width: '100%', fontSize: 13 }} aria-label="Apply to">
      <option value="">Everyone in view</option>
      {groups.map(g => <option key={g.id} value={g.id}>{g.name} ({g.members?.length || 0})</option>)}
    </select>
  );
}

// Copy schedule (Sep 28, Teams parity): lay a date range - the week on screen
// by default - down again starting on another date, as drafts, optionally
// several times back to back.
function CopyModal({ groups, defaultStart, defaultEnd, busy, onApply, onClose }) {
  const [from, setFrom] = useState(defaultStart);
  const [to, setTo] = useState(defaultEnd);
  const [target, setTarget] = useState(() => addDaysIso(defaultEnd, 1));
  const [copies, setCopies] = useState(1);
  const [groupId, setGroupId] = useState('');
  const [includeOpen, setIncludeOpen] = useState(true);
  const [includeNotes, setIncludeNotes] = useState(true);
  const [includeActs, setIncludeActs] = useState(true);
  const [skipOff, setSkipOff] = useState(true);
  const [overwrite, setOverwrite] = useState(false);
  const [copyOff, setCopyOff] = useState(false);
  const span = from && to ? Math.round((new Date(to) - new Date(from)) / 86400000) + 1 : 0;
  const lastDay = span > 0 && target ? addDaysIso(target, span * copies - 1) : '';
  const overlaps = span > 0 && target && target <= to && lastDay >= from;
  const canApply = span > 0 && span <= 31 && target && !overlaps && !busy;

  function submit() {
    const payload = { source_start: from, source_end: to, target_start: target, weeks: Number(copies),
                      include_open: includeOpen && !groupId, include_notes: includeNotes, include_activities: includeActs,
                      skip_timeoff: skipOff, overwrite, include_timeoff: copyOff };
    if (groupId) payload.group_id = groupId;
    onApply(payload);
  }

  return (
    <div style={MODAL_BACK} onClick={e => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-label="Copy Schedule" style={MODAL_CARD}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
          <span style={{ fontSize: 15, fontWeight: 800, flex: 1 }}>Copy Schedule</span>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)' }}><X size={18} /></button>
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>
          Copy these dates forward as drafts. Nothing changes for the team until you publish.
        </div>
        <div style={{ display: 'grid', gap: 14 }}>
          <div style={{ display: 'flex', gap: 10 }}>
            <label style={{ flex: 1 }}><div style={LBL}>Copy from</div><input type="date" className="form-input" value={from} onChange={e => setFrom(e.target.value)} style={{ width: '100%', fontSize: 13 }} /></label>
            <label style={{ flex: 1 }}><div style={LBL}>Through</div><input type="date" className="form-input" value={to} onChange={e => setTo(e.target.value)} style={{ width: '100%', fontSize: 13 }} /></label>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <label style={{ flex: 1 }}><div style={LBL}>Paste starting</div><input type="date" className="form-input" value={target} onChange={e => setTarget(e.target.value)} style={{ width: '100%', fontSize: 13 }} /></label>
            <label style={{ width: 120 }}><div style={LBL}>Copies</div>
              <select className="form-input" value={copies} onChange={e => setCopies(Number(e.target.value))} style={{ width: '100%', fontSize: 13 }}>
                {[1, 2, 3, 4, 5, 6, 7, 8].map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
          </div>
          <div><div style={LBL}>Apply to</div><GroupPick groups={groups} value={groupId} onChange={setGroupId} /></div>
          <label style={{ ...CHECK, opacity: groupId ? 0.5 : 1 }} title={groupId ? 'Open shifts belong to no team' : undefined}>
            <input type="checkbox" checked={includeOpen && !groupId} disabled={!!groupId} onChange={e => setIncludeOpen(e.target.checked)} /> Include open shifts
          </label>
          <label style={CHECK}><input type="checkbox" checked={includeNotes} onChange={e => setIncludeNotes(e.target.checked)} /> Include shift notes</label>
          <label style={CHECK}><input type="checkbox" checked={includeActs} onChange={e => setIncludeActs(e.target.checked)} /> Include shift activities</label>
          <label style={CHECK}><input type="checkbox" checked={skipOff} onChange={e => setSkipOff(e.target.checked)} /> Skip days a person has time off</label>
          <label style={CHECK}><input type="checkbox" checked={overwrite} onChange={e => setOverwrite(e.target.checked)} /> Replace shifts that are already there (otherwise keep them)</label>
          <label style={CHECK}><input type="checkbox" checked={copyOff} onChange={e => setCopyOff(e.target.checked)} /> Copy approved time off too (as requests to approve)</label>
          <div style={{ fontSize: 11.5, color: overlaps || span > 31 ? '#b91c1c' : 'var(--muted)' }}>
            {span > 31 ? 'Copy at most 31 days at a time.'
              : overlaps ? 'The copy would land on the dates it copies from - pick a later start.'
              : lastDay ? `Lands on ${formatDate(target)} - ${formatDate(lastDay)}.` : ''}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
          <button className="secondary-btn" onClick={onClose}>Cancel</button>
          <button className="primary-btn" onClick={submit} disabled={!canApply} style={{ opacity: canApply ? 1 : 0.55 }}>{busy ? '…' : 'Copy Shifts'}</button>
        </div>
      </div>
    </div>
  );
}

// Clear (Sep 28, Teams parity): every shift in a range at once. Same rule as
// removing one - drafts go, published shifts wait for Publish.
function ClearModal({ groups, defaultStart, defaultEnd, busy, onApply, onClose }) {
  const [from, setFrom] = useState(defaultStart);
  const [to, setTo] = useState(defaultEnd);
  const [groupId, setGroupId] = useState('');
  const [includeOpen, setIncludeOpen] = useState(true);
  const canApply = from && to && to >= from && !busy;

  function submit() {
    const payload = { start_date: from, end_date: to, include_open: includeOpen && !groupId };
    if (groupId) payload.group_id = groupId;
    onApply(payload);
  }

  return (
    <div style={MODAL_BACK} onClick={e => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-label="Clear Schedule" style={MODAL_CARD}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
          <span style={{ fontSize: 15, fontWeight: 800, flex: 1 }}>Clear Schedule</span>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)' }}><X size={18} /></button>
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>
          Remove every shift in these dates. Drafts are deleted. Published shifts are marked for removal and stay on the team's schedule until you publish - Discard Changes brings them back.
        </div>
        <div style={{ display: 'grid', gap: 14 }}>
          <div style={{ display: 'flex', gap: 10 }}>
            <label style={{ flex: 1 }}><div style={LBL}>From</div><input type="date" className="form-input" value={from} onChange={e => setFrom(e.target.value)} style={{ width: '100%', fontSize: 13 }} /></label>
            <label style={{ flex: 1 }}><div style={LBL}>To</div><input type="date" className="form-input" value={to} onChange={e => setTo(e.target.value)} style={{ width: '100%', fontSize: 13 }} /></label>
          </div>
          <div><div style={LBL}>Apply to</div><GroupPick groups={groups} value={groupId} onChange={setGroupId} /></div>
          <label style={{ ...CHECK, opacity: groupId ? 0.5 : 1 }}>
            <input type="checkbox" checked={includeOpen && !groupId} disabled={!!groupId} onChange={e => setIncludeOpen(e.target.checked)} /> Include open shifts
          </label>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
          <button className="secondary-btn" onClick={onClose}>Cancel</button>
          <button className="primary-btn" onClick={submit} disabled={!canApply}
            style={{ opacity: canApply ? 1 : 0.55, background: '#b91c1c', borderColor: '#b91c1c' }}>{busy ? '…' : 'Clear Shifts'}</button>
        </div>
      </div>
    </div>
  );
}

// Bulk assign: apply a preset to a whole group (or everyone in view) across a
// date range and chosen weekdays in one action, instead of adding a shift per
// person per day. Skips time off and (unless overwrite) days that already have
// a shift, so re-running it is safe.
function BulkModal({ groups, shifts, allEmails, defaultStart, defaultEnd, busy, onApply, onClose }) {
  const [groupId, setGroupId] = useState(groups[0]?.id || '');   // '' = everyone in view
  const [shiftId, setShiftId] = useState(shifts[0]?.id || '');
  const [from, setFrom] = useState(defaultStart);
  const [to, setTo] = useState(defaultEnd);
  const [dows, setDows] = useState([0, 1, 2, 3, 4]);   // Mon-Fri by default
  const [skipOff, setSkipOff] = useState(true);
  const [overwrite, setOverwrite] = useState(false);
  const preset = shifts.find(s => s.id === shiftId);
  const DOW = [['Mon', 0], ['Tue', 1], ['Wed', 2], ['Thu', 3], ['Fri', 4], ['Sat', 5], ['Sun', 6]];
  const toggle = (n) => setDows(d => d.includes(n) ? d.filter(x => x !== n) : [...d, n]);
  const targetCount = groupId ? (groups.find(g => g.id === groupId)?.members?.length || 0) : allEmails.length;
  const canApply = shifts.length > 0 && from && to && dows.length > 0 && !busy && (groupId || allEmails.length);

  function submit() {
    const payload = { shift_id: shiftId, start_date: from, end_date: to, weekdays: dows,
                      skip_timeoff: skipOff, overwrite };
    if (groupId) payload.group_id = groupId; else payload.emails = allEmails;
    onApply(payload);
  }

  const dirty = groupId !== (groups[0]?.id || '') || shiftId !== (shifts[0]?.id || '') || from !== defaultStart
    || to !== defaultEnd || JSON.stringify(dows) !== JSON.stringify([0, 1, 2, 3, 4]) || skipOff !== true || overwrite !== false;
  const guard = useUnsavedGuard(dirty, onClose, canApply ? submit : undefined);

  const lbl = { fontSize: 11, color: 'var(--muted)', marginBottom: 4, fontWeight: 600 };
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, fontFamily: 'Inter,sans-serif' }}
      onClick={e => e.target === e.currentTarget && guard.requestClose()}>
      <div style={{ background: 'var(--card)', borderRadius: 14, width: '100%', maxWidth: 460, padding: 20, maxHeight: '92dvh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
          <span style={{ fontSize: 15, fontWeight: 800, flex: 1 }}>Fill Schedule</span>
          <button onClick={guard.requestClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)' }}><X size={18} /></button>
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>
          Apply a shift to a whole group across a date range in one go - no more adding it per person per day.
        </div>
        {shifts.length === 0 ? (
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 14 }}>No shift presets yet - create one under “Presets & Teams” first.</div>
        ) : (
          <div style={{ display: 'grid', gap: 14 }}>
            <div>
              <div style={lbl}>Apply to</div>
              <select className="form-input" value={groupId} onChange={e => setGroupId(e.target.value)} style={{ width: '100%', fontSize: 13 }}>
                {groups.map(g => <option key={g.id} value={g.id}>{g.name} ({g.members?.length || 0})</option>)}
                <option value="">Everyone in view ({allEmails.length})</option>
              </select>
            </div>
            <div>
              <div style={lbl}>Shift preset</div>
              <select className="form-input" value={shiftId} onChange={e => setShiftId(e.target.value)} style={{ width: '100%', fontSize: 13 }}>
                {shifts.map(s => <option key={s.id} value={s.id}>{s.code ? `${s.code} · ` : ''}{s.name} ({t12Full(s.start)} - {t12Full(s.end)})</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <label style={{ flex: 1 }}><div style={lbl}>From</div><input type="date" className="form-input" value={from} onChange={e => setFrom(e.target.value)} style={{ width: '100%', fontSize: 13 }} /></label>
              <label style={{ flex: 1 }}><div style={lbl}>To</div><input type="date" className="form-input" value={to} onChange={e => setTo(e.target.value)} style={{ width: '100%', fontSize: 13 }} /></label>
            </div>
            <div>
              <div style={lbl}>Days of week</div>
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                {DOW.map(([label, n]) => {
                  const on = dows.includes(n);
                  return (
                    <button key={n} type="button" onClick={() => toggle(n)}
                      style={{ fontSize: 12, fontWeight: 700, padding: '6px 11px', borderRadius: 8, cursor: 'pointer',
                        border: `1px solid ${on ? 'var(--wk-brand, hsl(var(--color-green)))' : 'var(--line)'}`,
                        background: on ? 'hsla(var(--color-green),0.12)' : 'transparent',
                        color: on ? 'hsl(var(--color-green))' : 'var(--muted)' }}>{label}</button>
                  );
                })}
              </div>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, cursor: 'pointer' }}>
              <input type="checkbox" checked={skipOff} onChange={e => setSkipOff(e.target.checked)} /> Skip days a person has time off
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, cursor: 'pointer' }}>
              <input type="checkbox" checked={overwrite} onChange={e => setOverwrite(e.target.checked)} /> Replace shifts that are already there (otherwise keep them)
            </label>
            <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
              {targetCount} {targetCount === 1 ? 'person' : 'people'} · {preset ? `${t12Full(preset.start)} - ${t12Full(preset.end)}` : 'preset'} · {dows.length} day{dows.length !== 1 ? 's' : ''}/week
            </div>
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
          <button className="secondary-btn" onClick={onClose}>Cancel</button>
          {shifts.length > 0 && <button className="primary-btn" onClick={submit} disabled={!canApply}
            style={{ opacity: canApply ? 1 : 0.55 }}>{busy ? '…' : 'Fill Schedule'}</button>}
        </div>
      </div>
      {guard.confirming && (
        <UnsavedChangesPrompt onKeepEditing={guard.keepEditing} onDiscard={onClose}
          onSave={canApply ? guard.saveAndClose : undefined} saving={guard.saving || busy} />
      )}
    </div>
  );
}

// Open shift editor: create/edit an unassigned slot (preset + how many people
// needed) and, for an existing one, ASSIGN it to a person - which spawns their
// own shift and drops the open count (Teams "Assign open shifts").
function OpenShiftModal({ cell, shifts, people, busy, onSave, onAssign, onDelete, onDiscard, onClose }) {
  const ex = cell.existing;
  const [shiftId, setShiftId] = useState(ex?.shiftId || (shifts[0]?.id || ''));
  const [start, setStart] = useState(ex?.start || '');
  const [end, setEnd] = useState(ex?.end || '');
  const [slots, setSlots] = useState(ex?.openSlots || 1);
  const [label, setLabel] = useState(ex?.label || '');
  const [brk, setBrk] = useState(ex ? String(ex.breakMin ?? 0) : '');   // '' = the preset's
  const [color, setColor] = useState(ex?.ownColor || '');
  const [assignee, setAssignee] = useState('');
  const preset = shifts.find(s => s.id === shiftId);
  const eff = (v, p) => v || p || '';
  const effBreak = brk === '' ? (preset?.breakMin || 0) : Math.max(0, Number(brk) || 0);
  const badTimes = sameTime(eff(start, preset?.start), eff(end, preset?.end));

  function submit() {
    if (badTimes) return;
    onSave({ id: ex?.id, work_date: cell.date, shift_id: shiftId,
      start_hhmm: eff(start, preset?.start), end_hhmm: eff(end, preset?.end),
      label, open_slots: Math.max(1, Number(slots) || 1), break_min: effBreak, color });
  }

  // ex is fixed for this modal instance's lifetime (a fresh OpenShiftModal
  // mounts per cell click), so the initial useState values ARE the baseline.
  const dirty = shiftId !== (ex?.shiftId || (shifts[0]?.id || '')) || start !== (ex?.start || '')
    || end !== (ex?.end || '') || String(slots) !== String(ex?.openSlots || 1) || label !== (ex?.label || '')
    || brk !== (ex ? String(ex.breakMin ?? 0) : '') || color !== (ex?.ownColor || '');
  const guard = useUnsavedGuard(dirty, onClose, submit);

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, fontFamily: 'Inter,sans-serif' }}
      onClick={e => e.target === e.currentTarget && guard.requestClose()}>
      <div style={{ background: 'var(--card)', borderRadius: 14, width: '100%', maxWidth: 430, padding: 20, maxHeight: '92dvh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
          <span style={{ fontSize: 15, fontWeight: 800, flex: 1 }}>{ex ? 'Open Shift' : 'Add Open Shift'}</span>
          <button onClick={guard.requestClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)' }}><X size={18} /></button>
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>
          {new Date(cell.date + 'T00:00').toLocaleDateString('en-US', { weekday: 'long' })}, {formatDate(cell.date)} · an unassigned slot anyone on the team can be given
        </div>
        {shifts.length === 0 ? (
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 14 }}>No shift presets yet - create one under “Presets & Teams” first.</div>
        ) : (
          <div style={{ display: 'grid', gap: 12 }}>
            <div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>Shift preset</div>
              <select className="form-input" value={shiftId} onChange={e => { setShiftId(e.target.value); setStart(''); setEnd(''); setBrk(''); }} style={{ width: '100%', fontSize: 13 }}>
                {shifts.map(s => <option key={s.id} value={s.id}>{s.code ? `${s.code} · ` : ''}{s.name} ({t12Full(s.start)} - {t12Full(s.end)})</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <label style={{ flex: 1, fontSize: 11, color: 'var(--muted)' }}>Start<input type="time" className="form-input" value={eff(start, preset?.start)} onChange={e => setStart(e.target.value)} style={{ width: '100%', fontSize: 13 }} /></label>
              <label style={{ flex: 1, fontSize: 11, color: 'var(--muted)' }}>End<input type="time" className="form-input" value={eff(end, preset?.end)} onChange={e => setEnd(e.target.value)} style={{ width: '100%', fontSize: 13 }} /></label>
              <label style={{ width: 80, fontSize: 11, color: 'var(--muted)' }}>People<input type="number" min={1} max={50} className="form-input" value={slots} onChange={e => setSlots(e.target.value)} style={{ width: '100%', fontSize: 13 }} /></label>
              <BreakField value={brk === '' ? String(preset?.breakMin || 0) : brk} onChange={setBrk} />
            </div>
            <input className="form-input" placeholder="Label (e.g. All Properties)" value={label} onChange={e => setLabel(e.target.value)} style={{ fontSize: 13 }} />
            <ColorPick value={color} presetColor={preset?.color} onChange={setColor} />

            {ex && (
              <div style={{ borderTop: '1px solid var(--line)', paddingTop: 12 }}>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4, fontWeight: 700 }}>Assign to a person</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <select className="form-input" value={assignee} onChange={e => setAssignee(e.target.value)} style={{ flex: 1, fontSize: 13 }}>
                    <option value="">- pick someone -</option>
                    {people.map(p => <option key={p.email} value={p.email}>{p.name || p.email}</option>)}
                  </select>
                  <button className="secondary-btn" onClick={() => assignee && onAssign(ex.id, assignee)} disabled={!assignee || busy}
                    style={{ opacity: assignee ? 1 : 0.55 }}>Assign</button>
                </div>
                <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 5 }}>Gives this shift to the person and drops the open count by one.</div>
              </div>
            )}
          </div>
        )}
        {badTimes && <div role="alert" style={{ marginTop: 10, fontSize: 12, color: '#b91c1c' }}>{SAME_TIME_MSG}</div>}
        <PendingNotice ex={ex} />
        <div style={{ display: 'flex', gap: 8, marginTop: 16, alignItems: 'center' }}>
          {ex && !ex.pendingDelete && <button onClick={() => onDelete(ex.id)} disabled={busy} style={{ background: 'none', border: 'none', color: '#b91c1c', cursor: 'pointer', fontSize: 12.5, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 5 }}><Trash2 size={13} /> Remove</button>}
          <DiscardButton ex={ex} busy={busy} onDiscard={onDiscard} />
          <div style={{ flex: 1 }} />
          <button className="secondary-btn" onClick={onClose}>Cancel</button>
          {shifts.length > 0 && <button className="primary-btn" onClick={submit} disabled={busy || badTimes}
            title={badTimes ? SAME_TIME_MSG : undefined} style={{ opacity: badTimes ? 0.55 : 1 }}>{busy ? '…' : 'Save'}</button>}
        </div>
      </div>
      {guard.confirming && (
        <UnsavedChangesPrompt onKeepEditing={guard.keepEditing} onDiscard={onClose} onSave={guard.saveAndClose} saving={guard.saving || busy} />
      )}
    </div>
  );
}

// A shift's own color (Sep 29, Teams parity); "Preset" = its preset's color.
function ColorPick({ value, presetColor, onChange }) {
  const dot = (c, on, label, onClick) => (
    <button key={label} type="button" onClick={onClick} aria-label={label} aria-pressed={on} title={label}
      style={{ width: 22, height: 22, borderRadius: 6, cursor: 'pointer', background: c || 'transparent',
        border: on ? '2px solid var(--ink)' : '2px solid transparent', boxShadow: '0 0 0 1px var(--line)' }} />
  );
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>Color</div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" onClick={() => onChange('')} aria-pressed={!value}
          style={{ fontSize: 11.5, fontWeight: 700, padding: '3px 8px', borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit',
            border: !value ? '2px solid var(--ink)' : '1px solid var(--line)', background: 'var(--card)', color: 'var(--ink)',
            display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 10, height: 10, borderRadius: 3, background: presetColor || '#64748b' }} /> Preset
        </button>
        {SHIFT_COLORS.map(c => dot(c, value === c, `Color ${c}`, () => onChange(c)))}
      </div>
    </div>
  );
}

// Unpaid break minutes for this shift - starts at the preset's, editable here.
function BreakField({ value, onChange }) {
  return (
    <label style={{ width: 96, fontSize: 11, color: 'var(--muted)' }} title="Unpaid minutes inside the shift, e.g. a 30-minute lunch. Scheduled hours are shown without it.">
      Unpaid break
      <input type="number" min={0} max={480} step={5} className="form-input" value={value}
        onChange={e => onChange(e.target.value)} style={{ width: '100%', fontSize: 13 }} aria-label="Unpaid break minutes" />
    </label>
  );
}

// What is waiting on Publish for this shift, said where the manager acts on it.
function PendingNotice({ ex }) {
  if (!ex?.pendingDelete && !ex?.hasChanges) return null;
  return (
    <div style={{ marginTop: 14, padding: '8px 12px', borderRadius: 8, fontSize: 12, background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.35)', color: '#92400e' }}>
      {ex.pendingDelete
        ? 'This shift will be removed when you publish. Until then the team still sees it.'
        : 'Unpublished changes. The team sees the previous version of this shift until you publish.'}
    </div>
  );
}

function DiscardButton({ ex, busy, onDiscard }) {
  if (!onDiscard || !(ex?.pendingDelete || ex?.hasChanges)) return null;
  return (
    <button onClick={() => onDiscard(ex.id)} disabled={busy} title="Go back to the version the team sees"
      style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 12.5, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <RotateCcw size={13} /> Discard Changes
    </button>
  );
}

function CellModal({ cell, shifts, busy, onSave, onDelete, onDiscard, onClose, onCopy, onTimeOff }) {
  const ex = cell.existing;
  const [shiftId, setShiftId] = useState(ex?.shiftId || (shifts[0]?.id || ''));
  const [start, setStart] = useState(ex?.start || '');
  const [end, setEnd] = useState(ex?.end || '');
  const [label, setLabel] = useState(ex?.label || '');
  const [note, setNote] = useState(ex?.note || '');
  const [brk, setBrk] = useState(ex ? String(ex.breakMin ?? 0) : '');   // '' = the preset's
  const [warnings, setWarnings] = useState(ex?.conflicts || []);
  const [acts, setActs] = useState(() => (ex?.activities || []).map(a => ({ ...a })));
  const [color, setColor] = useState(ex?.ownColor || '');
  const preset = shifts.find(s => s.id === shiftId);
  const eff = (v, p) => v || p || '';
  const effStart = eff(start, preset?.start);
  const effEnd = eff(end, preset?.end);
  const effBreak = brk === '' ? (preset?.breakMin || 0) : Math.max(0, Number(brk) || 0);
  const badTimes = sameTime(effStart, effEnd);

  // Live warnings as the day and times change (overlap, time off, holiday) -
  // the same check the grid's warning icon comes from. Never blocks Save.
  useEffect(() => {
    if (!cell.email || !effStart || !effEnd) return undefined;
    let live = true;
    const t = setTimeout(() => {
      api.timeSchedCheck({ email: cell.email, date: cell.date, start: effStart, end: effEnd, exclude_id: ex?.id || '' })
        .then((r) => { if (live) setWarnings(r?.warnings || []); })
        .catch(() => { if (live) setWarnings([]); });
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [cell.email, cell.date, effStart, effEnd, ex?.id]);

  function submit() {
    if (badTimes) return;
    onSave({
      id: ex?.id, employee_email: cell.email, work_date: cell.date, shift_id: shiftId,
      start_hhmm: effStart, end_hhmm: effEnd,
      label, note, break_min: effBreak,
      activities: acts.filter(a => a.start && a.end).map(a => ({ start: a.start, end: a.end, label: (a.label || '').trim() })),
      color,
    });
  }

  // ex is fixed for this modal instance's lifetime (a fresh CellModal mounts
  // per cell click), so the initial useState values ARE the baseline.
  const dirty = shiftId !== (ex?.shiftId || (shifts[0]?.id || '')) || start !== (ex?.start || '')
    || end !== (ex?.end || '') || label !== (ex?.label || '') || note !== (ex?.note || '')
    || brk !== (ex ? String(ex.breakMin ?? 0) : '')
    || JSON.stringify(acts) !== JSON.stringify(ex?.activities || [])
    || color !== (ex?.ownColor || '');
  const guard = useUnsavedGuard(dirty, onClose, submit);

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, fontFamily: 'Inter,sans-serif' }}
      onClick={e => e.target === e.currentTarget && guard.requestClose()}>
      <div style={{ background: 'var(--card)', borderRadius: 14, width: '100%', maxWidth: 'clamp(420px, 60vw, 700px)', padding: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
          <span style={{ fontSize: 15, fontWeight: 800, flex: 1 }}>{ex ? 'Edit Shift' : 'Add Shift'}</span>
          <button onClick={guard.requestClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)' }}><X size={18} /></button>
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>
          {new Date(cell.date + 'T00:00').toLocaleDateString('en-US', { weekday: 'long' })}, {formatDate(cell.date)}
        </div>
        {shifts.length === 0 ? (
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 14 }}>No shift presets yet - create one under “Presets & Teams” first.</div>
        ) : (
          <div style={{ display: 'grid', gap: 12 }}>
            <div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>Shift preset</div>
              <select className="form-input" value={shiftId} onChange={e => { setShiftId(e.target.value); setStart(''); setEnd(''); setBrk(''); }} style={{ width: '100%', fontSize: 13 }}>
                {shifts.map(s => <option key={s.id} value={s.id}>{s.code ? `${s.code} · ` : ''}{s.name} ({t12Full(s.start)} - {t12Full(s.end)})</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <label style={{ flex: 1, fontSize: 11, color: 'var(--muted)' }}>Start<input type="time" className="form-input" value={eff(start, preset?.start)} onChange={e => setStart(e.target.value)} style={{ width: '100%', fontSize: 13 }} /></label>
              <label style={{ flex: 1, fontSize: 11, color: 'var(--muted)' }}>End<input type="time" className="form-input" value={eff(end, preset?.end)} onChange={e => setEnd(e.target.value)} style={{ width: '100%', fontSize: 13 }} /></label>
              <BreakField value={brk === '' ? String(preset?.breakMin || 0) : brk} onChange={setBrk} />
            </div>
            <input className="form-input" placeholder="Label (e.g. All Properties)" value={label} onChange={e => setLabel(e.target.value)} style={{ fontSize: 13 }} />
            <input className="form-input" placeholder="Note (optional)" value={note} onChange={e => setNote(e.target.value)} style={{ fontSize: 13 }} />
            <ColorPick value={color} presetColor={preset?.color} onChange={setColor} />
            {/* Activities (Sep 29, Teams parity): named blocks inside the shift. */}
            <div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>Activities</div>
              {acts.map((a, i) => (
                <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
                  <input type="time" className="form-input" aria-label={`Activity ${i + 1} start`} value={a.start}
                    onChange={e => setActs(xs => xs.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)))} style={{ width: 110, fontSize: 13 }} />
                  <input type="time" className="form-input" aria-label={`Activity ${i + 1} end`} value={a.end}
                    onChange={e => setActs(xs => xs.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)))} style={{ width: 110, fontSize: 13 }} />
                  <input className="form-input" aria-label={`Activity ${i + 1} name`} placeholder="e.g. Training" maxLength={40} value={a.label}
                    onChange={e => setActs(xs => xs.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} style={{ flex: 1, fontSize: 13 }} />
                  <button type="button" onClick={() => setActs(xs => xs.filter((_, j) => j !== i))} aria-label={`Remove activity ${i + 1}`}
                    style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'inline-flex' }}><X size={14} /></button>
                </div>
              ))}
              {acts.length < 12 && (
                <button type="button" onClick={() => setActs(xs => [...xs, { start: effStart || '12:00', end: effEnd || '13:00', label: '' }])}
                  style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'hsl(var(--color-green))', fontSize: 12.5, fontWeight: 700, padding: 0, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <Plus size={13} /> Add Activity
                </button>
              )}
            </div>
          </div>
        )}
        {warnings.length > 0 && (
          <div role="alert" style={{ marginTop: 14, padding: '8px 12px', borderRadius: 8, fontSize: 12, background: 'rgba(217,119,6,0.08)', border: '1px solid rgba(217,119,6,0.35)', color: '#92400e' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700, marginBottom: 2 }}><AlertTriangle size={13} /> Check before saving</div>
            {warnings.map((w) => <div key={w}>{w}</div>)}
            <div style={{ marginTop: 4, color: '#b45309' }}>You can still save this shift.</div>
          </div>
        )}
        {badTimes && <div role="alert" style={{ marginTop: 10, fontSize: 12, color: '#b91c1c' }}>{SAME_TIME_MSG}</div>}
        <PendingNotice ex={ex} />
        <div style={{ display: 'flex', gap: 8, marginTop: 16, alignItems: 'center' }}>
          {ex && !ex.pendingDelete && <button onClick={() => onDelete(ex.id)} disabled={busy} style={{ background: 'none', border: 'none', color: '#b91c1c', cursor: 'pointer', fontSize: 12.5, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 5 }}><Trash2 size={13} /> Remove</button>}
          <DiscardButton ex={ex} busy={busy} onDiscard={onDiscard} />
          {onTimeOff && <button onClick={onTimeOff} disabled={busy} style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 12.5, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 5 }} title="Add time off for this person instead"><CalendarOff size={13} /> Add Time Off</button>}
          {ex && onCopy && <button onClick={() => onCopy(ex)} disabled={busy} style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 12.5, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 5 }} title="Copy this shift to place on another person or day"><Copy size={13} /> Copy</button>}
          <div style={{ flex: 1 }} />
          <button className="secondary-btn" onClick={onClose}>Cancel</button>
          {shifts.length > 0 && <button className="primary-btn" onClick={submit} disabled={busy || badTimes}
            title={badTimes ? SAME_TIME_MSG : undefined} style={{ opacity: badTimes ? 0.55 : 1 }}>{busy ? '…' : 'Save'}</button>}
        </div>
      </div>
      {guard.confirming && (
        <UnsavedChangesPrompt onKeepEditing={guard.keepEditing} onDiscard={onClose} onSave={guard.saveAndClose} saving={guard.saving || busy} />
      )}
    </div>
  );
}

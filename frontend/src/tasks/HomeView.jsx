// Task Module - Home (ported 1:1 from the export's HomePage). Tasks, Updates
// and Bookmarks are its CORE (Neil, Oct 15 2026: "Tasks and Updates should be
// the core of home. Bookmarks, too"): always there, Tasks and Bookmarks down
// the left and Updates beside them as a full-height column at a desk, stacked
// on a phone. Under them, a customizable grid of the other widgets (Week
// ahead, By priority, Teams...), arranged in the person's profile. Its one
// page-level control, Customize, is portaled up into the module bar next to
// Manage rather than rendered here.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronDown, ChevronRight, SlidersHorizontal, Plus, Circle, X, GripVertical, Check, ArrowUp, ArrowDown, ArrowLeft, ArrowRight,
  CheckSquare, Star, Sun, CalendarDays, Flag, AlertCircle, CheckCircle2, Users, Bell, Trash2, Activity,
} from 'lucide-react';
import { useTasks } from './TasksContext';
import { DeletedTasksTab as RecycleBinPanel } from './ManageView';
import { taskIdFromUrl, taskAssignees } from './lib';
import { NX, FONT, btn, PRIORITY_META } from './theme';
import { useIsMobile, DateField, notPast } from './components';
import TaskDetailDrawer from './TaskDetailDrawer';
import AnchoredMenu from '../components/AnchoredMenu';
import DictateButton from '../components/DictateButton';
import { useTableValue, whenTablePrefsLoaded } from './tableCols';
import { api } from '../api';
import UpdatesCard from './HomeUpdates';
import AddSeveralModal from './AddSeveralModal';
import { pastedTaskList } from './batchPaste';
import ProjectIcon from './ProjectIcon';
import { projectLook } from './projectLook';
import { useMyDay } from './myDay';
import {
  localISO, addDays, completedOn, focusCounts, tileCounts, upcomingGroups, dueLabel, dayTitle, isRecurring,
  byDueThenPriority, projectsAtRisk, teamWorkload, completedWeeks,
} from './homeRules';
import {
  WidgetCard, WidgetHeader, ViewAll, FocusTiles, TaskLine, ProjectsAtRiskWidget, CompletedWeekWidget,
  WeekAheadWidget, ByPriorityWidget, MyDayWidget, TeamWorkloadWidget, TeamsWidget, NotificationsWidget,
} from './homeWidgets';

// Keys are what saved layouts store, so a widget renamed in the Oct 23 2026
// pass kept its key: 'urgent' is Projects at Risk (was "Urgent Tasks"),
// 'team_members' is Team Workload (was "Team Members"), 'projects' is
// Bookmarks. `desc` is the Add Widgets tray's one line; `offer: false` keeps
// a widget for whoever has it while no longer offering it (Notifications -
// the bell already holds every notice; Neil, Oct 23 2026).
const WIDGET_META = [
  { key: 'my_tasks', label: 'Tasks', Icon: CheckSquare },   // was "My Tasks" (Neil, Oct 13 2026)
  // What other people did lately on the tasks I am on (Neil, Oct 14 2026).
  { key: 'updates', label: 'Updates', Icon: Activity },
  { key: 'projects', label: 'Bookmarks', Icon: Star },
  { key: 'my_day', label: 'My Day', Icon: Sun, desc: 'Today\'s list and how much of it is done.' },
  { key: 'urgent', label: 'Projects at Risk', Icon: AlertCircle, desc: 'Your projects with overdue or due-soon work.' },
  { key: 'activity', label: 'Completed This Week', Icon: CheckCircle2, desc: 'What you finished each day, against last week.' },
  { key: 'week', label: 'Week Ahead', Icon: CalendarDays, desc: 'Your open tasks due each of the next 7 days.' },
  { key: 'priorities', label: 'By Priority', Icon: Flag, desc: 'Your open tasks by priority.' },
  { key: 'teams', label: 'Teams', Icon: Users, desc: 'The teams you are on.' },
  { key: 'team_members', label: 'Team Workload', Icon: Users, desc: 'Open and overdue work for each teammate.' },
  { key: 'notifications', label: 'Notifications', Icon: Bell, offer: false },
  // The Recycle Bin. On Home rather than under My Tasks (Neil, Sept 9): it is
  // not a view of my tasks, it is where deleted things wait - and it is meant
  // to grow past tasks to projects, portfolios and teams. A widget, so someone
  // who never deletes anything can switch it off from Customize like any other.
  { key: 'recycle', label: 'Recycle Bin', Icon: Trash2, desc: 'What you deleted, for 90 days.' },
];
// A Home nobody arranged (Neil, Oct 23 2026). A saved layout is kept as it is.
const DEFAULT_LAYOUT = ['my_tasks', 'updates', 'projects', 'my_day', 'week', 'urgent', 'priorities'];
// Always on Home, in a layout of their own above the customizable grid - not
// removable or draggable there. Saved layouts still list them; they are just
// not drawn twice.
const CORE = ['my_tasks', 'updates', 'projects'];
// The core goes side by side from this width of the Home column (two cards of
// ~430px - narrower and task titles and update sentences start to clip).
const CORE_WIDE = 860;
// Widgets added after people saved a layout. A saved layout is the whole
// list, so a new widget would never reach anyone who had arranged their Home;
// each one here is slotted in after Tasks ONCE and then recorded in the
// layout's `introduced`, so taking it off again in Customize sticks. (Updates
// was the first; it is core now, so the slotting no longer shows anywhere.)
const INTRODUCED = ['updates'];
const LAYOUT_KEY = 'nexus.homeWidgets';
const TABS = ['Upcoming', 'Overdue', 'In Progress', 'Completed'];
// Rows the Tasks card shows before View All (Charmi's Upcoming ran to hundreds).
const ROW_CAP = 12;
// Today / This Week / This Month (Neil, Oct 23 2026 - called My Day / My Week /
// My Month until Tasks got its own My Day list; the keys are unchanged).
// `days` past today: This Week is the next 7 days, today included (homeRules.WEEK_LAST).
const RANGES = [
  { key: 'day', label: 'Today', days: 0, ahead: 'today', back: 'today' },
  { key: 'week', label: 'This Week', days: 6, ahead: 'in the next 7 days', back: 'in the last 7 days' },
  { key: 'month', label: 'This Month', days: 30, ahead: 'in the next 30 days', back: 'in the last 30 days' },
];

// Row-order masonry cell: measures its content and spans that many 8px grid
// rows, so widgets keep left-to-right order while short ones pull UP to fill
// vertical gaps (CSS columns flow top-to-bottom per column, which made drop
// positions unpredictable - this replaces that).
function MasonryCell({ masonry, style, children, ...rest }) {
  // Measure a dedicated inner wrapper, NOT firstElementChild - in customize
  // mode the first child is the absolute-positioned grip overlay (~26px),
  // which made every cell claim a tiny span and stack widgets on top of
  // each other. The wrapper's height = the widget's real height (absolute
  // overlays contribute nothing).
  const innerRef = useRef(null);
  const [span, setSpan] = useState(0);
  useEffect(() => {
    if (!masonry) return;
    const el = innerRef.current;
    if (!el) return;
    const measure = () => setSpan((s) => {
      const next = Math.ceil((el.getBoundingClientRect().height + 16) / 8);
      return next === s ? s : next;
    });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [masonry]);
  return (
    <div {...rest} style={{ ...style, ...(masonry ? { gridRowEnd: `span ${span || 40}` } : {}) }}>
      <div ref={innerRef} style={{ position: 'relative' }}>{children}</div>
    </div>
  );
}

// LOCAL calendar dates throughout. toISOString() is the UTC date, which on a US
// evening is already tomorrow - "today" and the range edges were a day off.
const todayISO = () => localISO(new Date());
const dueColor = (iso, done) => { if (!iso || done) return NX.faint; const t = todayISO(); return iso < t ? NX.red : iso === t ? NX.amber : NX.dim; };

// My Day reads its list only when its card is on the page.
function MyDayCard(props) {
  const myDay = useMyDay();
  return <MyDayWidget myDay={myDay} {...props} />;
}

export default function HomeView({ onNavigate }) {
  const store = useTasks();
  const { tasks, projects, teams, notifications, myEmail, nameOf, createTask, toggleComplete, bookmarks } = store;
  const [tab, setTab] = useState('Upcoming');
  const [range, setRange] = useState('week');
  const [rangeOpen, setRangeOpen] = useState(false);
  // A chart's pick narrows the Tasks card (Oct 23 2026): a Week Ahead day or a
  // By Priority bar - { kind: 'day', iso } | { kind: 'priority', p } | null.
  const [pick, setPick] = useState(null);
  const [showUndated, setShowUndated] = useState(false);
  const tasksCardRef = useRef(null);
  const toTasksCard = () => { tasksCardRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }); };
  // A focus tile moves the keyboard to the Tasks card's selected tab once the
  // switch has rendered: with Updates leading at a desk, a plain Tab from the
  // tile would land in the Updates column first (10/31/2026).
  const focusTasksTab = useRef(false);
  useEffect(() => {
    if (!focusTasksTab.current) return;
    focusTasksTab.current = false;
    tasksCardRef.current?.querySelector('[role=tab][aria-selected="true"]')?.focus();
  });
  // My Tasks opens on the tab it was last left on; My Day's Open sets it first.
  const [, setMineView] = useTableValue('mytasks', 'view', 'list');
  const [creating, setCreating] = useState(false);
  // A list pasted into the add row (Oct 31 2026): many tasks at once, confirmed in Add Several.
  const [several, setSeveral] = useState(null);   // { text, dueOn } while the modal is open
  const [addedNote, setAddedNote] = useState('');
  // One timer for the note: a second list within 4s is not wiped by the first's timer, and an unmount clears it.
  const noteTimer = useRef(null);
  const noteAdded = (msg) => { clearTimeout(noteTimer.current); setAddedNote(msg); noteTimer.current = setTimeout(() => setAddedNote(''), 4000); };
  useEffect(() => () => clearTimeout(noteTimer.current), []);
  const [newTitle, setNewTitle] = useState('');
  const [newDue, setNewDue] = useState(null);
  // The quick-add row saves when you leave it - Enter, Tab away, or a click
  // anywhere outside the row and its calendar - and never while its date is
  // being picked (the calendar takes focus; a picked date hands it back).
  const createRowRef = useRef(null);
  const titleRef = useRef(null);
  const creatingTask = useRef(false);
  const [openId, setOpenId] = useState(taskIdFromUrl);
  // An update opens its task at the comment it is about ({ id, threadId, taskId }).
  const [openComment, setOpenComment] = useState(null);
  const openUpdate = (taskId, comment) => { setOpenComment(comment || null); setOpenId(taskId); };
  const [customizing, setCustomizing] = useState(false);
  // Customize / Autofit / Done render into the module bar's slot next to
  // Manage (Sagar, Sept 1 2026), not into a header row of their own down here.
  // The slot is a sibling rendered by Tasks.jsx in the same commit, so it only
  // exists from our first effect onward - hence the state rather than a plain
  // getElementById at render time. Null (Home reached outside the module
  // shell) simply renders nothing, which is the same as the old empty row.
  const [barSlot, setBarSlot] = useState(null);
  useEffect(() => { setBarSlot(document.getElementById('nx-tasks-bar-actions')); }, []);
  const isMobile = useIsMobile();
  const rangeRef = useRef(null);
  // The layout lives in the person's profile (the "home" document in
  // /task-prefs, Oct 2026) so the Home they arranged at a desk is the Home
  // they get on a laptop. The pre-Oct-2026 localStorage copy is lifted once.
  const [homeData, setHomeData] = useTableValue('home', 'data', undefined);
  useEffect(() => {
    let alive = true;
    whenTablePrefsLoaded().then(({ prefs, fromServer }) => {
      // Only after the server answered (not the offline fallback) and only
      // when the profile has no layout yet.
      if (!alive || !fromServer || prefs?.home?.data !== undefined) return;
      try {
        const raw = JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null');
        const autofitRaw = localStorage.getItem('nexus.homeAutofit');
        if ((Array.isArray(raw) && raw.length) || autofitRaw !== null) {
          // The old copy goes only once the profile holds it.
          Promise.resolve(setHomeData({ widgets: Array.isArray(raw) && raw.length ? raw : DEFAULT_LAYOUT, autofit: autofitRaw !== '0' }))
            .then(() => { try { localStorage.removeItem(LAYOUT_KEY); localStorage.removeItem('nexus.homeAutofit'); } catch { /* private mode */ } })
            .catch(() => {});
        }
      } catch { /* private mode */ }
    });
    return () => { alive = false; };
  }, [setHomeData]);
  const widgets = useMemo(() => {
    const raw = homeData?.widgets;
    const known = Array.isArray(raw) ? raw.filter((k) => WIDGET_META.some((w) => w.key === k)) : [];
    if (!known.length) return DEFAULT_LAYOUT;
    const seen = Array.isArray(homeData?.introduced) ? homeData.introduced : [];
    const out = [...known];
    for (const k of INTRODUCED) {
      if (!out.includes(k) && !seen.includes(k)) out.splice(out.indexOf('my_tasks') + 1, 0, k);
    }
    return out;
  }, [homeData]);
  // Every save records the introduced widgets as seen (see INTRODUCED).
  const save = (patch) => setHomeData({
    ...(homeData || {}), ...patch,
    introduced: [...new Set([...(Array.isArray(homeData?.introduced) ? homeData.introduced : []), ...INTRODUCED])],
  });
  const persist = (next) => save({ widgets: next });

  // Customize mode: drag-to-rearrange + remove + add, all inline on the grid
  // (the old list modal is gone). Autofit packs widgets masonry-style so tall
  // and short widgets fill the page without holes; both persist.
  const [dragKey, setDragKey] = useState(null);
  const [overKey, setOverKey] = useState(null);
  // Default ON: grid rows size to the tallest widget, so short widgets can
  // never tuck into the vertical gaps - masonry packing is what fills them.
  const autofit = homeData?.autofit !== false;
  const toggleAutofit = () => save({ widgets, autofit: !autofit });
  const reorder = (from, to) => {
    if (!from || from === to) return;
    const next = widgets.filter((k) => k !== from);
    next.splice(next.indexOf(to) >= 0 ? next.indexOf(to) : next.length, 0, from);
    persist(next);
  };
  const availableWidgets = WIDGET_META.filter((w) => !widgets.includes(w.key) && !CORE.includes(w.key) && w.offer !== false);
  // Keyboard and touch can't drag: Move Up / Move Down in customize mode.
  // Earlier / Later in reading order (left to right, then down); focus stays
  // on the button that moved, or its twin once the card reaches an end.
  const move = (key, by) => {
    const i = widgets.indexOf(key);
    const extras = widgets.filter((k) => !CORE.includes(k));
    const j = extras.indexOf(key) + by;
    if (i < 0 || j < 0 || j >= extras.length) return;
    const next = widgets.filter((k) => k !== key);
    const anchor = extras[j];
    const at = next.indexOf(anchor) + (by > 0 ? 1 : 0);
    next.splice(at, 0, key);
    persist(next);
    setTimeout(() => {
      const el = document.querySelector(`[data-move="${key}:${by}"]`);
      (el && !el.disabled ? el : document.querySelector(`[data-move="${key}:${-by}"]`))?.focus();
    }, 0);
  };
  // The customizable grid: everything the person put on Home but the core.
  const extraWidgets = widgets.filter((k) => !CORE.includes(k));

  // Subtasks assigned to me count as mine (Asana's My Tasks rule) - the old
  // top-level-only filter under-reported people's open work by up to a third.
  // Anything assigned to me, including tasks I share with somebody else.
  const myTasks = useMemo(() => tasks.filter((t) => t.type !== 'section' && taskAssignees(t).includes(myEmail)), [tasks, myEmail]);
  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  // An update's project: the task's own, else its parent's (a subtask's is blank).
  const projectOf = (id) => {
    const t = taskById.get(id);
    const pid = t?.projectId || (t?.parentTaskId ? taskById.get(t.parentTaskId)?.projectId : '');
    return pid && typeof store.projectName === 'function' ? store.projectName(pid) : '';
  };

  // Updates: other people's recent changes to the tasks I am on, from
  // GET /tasks/activity/mine. Read when the card is on the page and again,
  // debounced, whenever the task list moves - a task_events ping refreshes
  // `tasks`, so that is the signal that something happened.
  const [updates, setUpdates] = useState(null);   // null = not read yet
  // How far back the card reads (Load More adds a page, up to the API's 100),
  // and a nudge to read again after a row's answer is saved.
  const [updatesLimit, setUpdatesLimit] = useState(30);
  const [updatesNonce, setUpdatesNonce] = useState(0);
  const [updatesFailed, setUpdatesFailed] = useState(false);
  // Which card leads the wide core, decided ONCE per visit by the first
  // answer of the feed (see updatesLead below): 'updates' | 'tasks' | null.
  const [lead, setLead] = useState(null);
  const updatesRead = useRef(false);
  // Not before the first task data is in (that load would only trigger a
  // second read). The card is core, so it is always on the page.
  const showUpdates = !store.loading;
  // The 45s poll hands back a new `tasks` array even when nothing changed;
  // this stamp only moves when a task did.
  const tasksStamp = useMemo(() => `${tasks.length}:${tasks.reduce((m, t) => ((t.modifiedAt || '') > m ? t.modifiedAt : m), '')}`, [tasks]);
  // A task change is debounced (a burst of pings is one read); Load More and
  // a row's saved answer read at once.
  const readStamp = useRef(tasksStamp);
  useEffect(() => {
    if (!showUpdates) return undefined;
    let alive = true;
    const taskMoved = readStamp.current !== tasksStamp;
    readStamp.current = tasksStamp;
    const timer = setTimeout(() => {
      api.getMyTaskActivity({ limit: updatesLimit })
        .then((rows) => {
          if (!alive) return;
          const list = Array.isArray(rows) ? rows : [];
          updatesRead.current = true; setUpdatesFailed(false); setUpdates(list);
          setLead((l) => l ?? (list.length > 0 ? 'updates' : 'tasks'));
        })
        .catch(() => { if (!alive) return; setUpdatesFailed(true); setLead((l) => l ?? 'updates'); });
    }, updatesRead.current && taskMoved ? 800 : 0);
    return () => { alive = false; clearTimeout(timer); };
  }, [tasksStamp, showUpdates, updatesLimit, updatesNonce]);
  // New since I last looked (Oct 21): stamped on the server once per visit,
  // after the first read lands; the stamp it replaces marks what is New for
  // the rest of this visit.
  const [updatesSeenAt, setUpdatesSeenAt] = useState(null);
  const seenMarked = useRef(false);
  useEffect(() => {
    if (updates === null || seenMarked.current || typeof api.markUpdatesSeen !== 'function') return;
    seenMarked.current = true;
    api.markUpdatesSeen()
      .then((r) => setUpdatesSeenAt(r?.seenAt || ''))
      .catch(() => {});
  }, [updates]);
  const rangeDef = RANGES.find((r) => r.key === range);
  const today = todayISO();
  // The Today / This Week / This Month picker scopes Upcoming (due between
  // today and the end of the window) and Completed (finished within the same
  // window looking back). Overdue and In Progress are what they are whatever
  // the window.
  const rangeStart = addDays(today, -rangeDef.days);
  const openMine = myTasks.filter((t) => !t.completed);
  const overdue = openMine.filter((t) => t.dueOn && t.dueOn.slice(0, 10) < today).sort(byDueThenPriority);
  const inProgress = openMine.filter((t) => t.status === 'in_progress').sort(byDueThenPriority);
  const completed = myTasks.filter((t) => t.completed && completedOn(t) >= rangeStart && completedOn(t) <= today)
    .sort((a, b) => String(b.completedAt || '').localeCompare(String(a.completedAt || '')));
  const { groups: upcomingByDay, undated } = upcomingGroups(myTasks, today, rangeDef.days);
  // The tiles and the line under them: the dashboard's own rule.
  const tiles = tileCounts(myTasks, today);
  const focus = focusCounts(myTasks, today);
  const activeTile = pick ? null
    : tab === 'Overdue' ? 'overdue' : tab === 'In Progress' ? 'inProgress'
    : tab === 'Upcoming' && range === 'day' ? 'today' : tab === 'Upcoming' && range === 'week' ? 'week' : null;
  const pickTile = (key) => {
    setPick(null);
    if (key === 'overdue') setTab('Overdue');
    else if (key === 'inProgress') setTab('In Progress');
    else { setTab('Upcoming'); setRange(key === 'today' ? 'day' : 'week'); }
    focusTasksTab.current = true;
    toTasksCard();
  };
  const pickDay = (iso) => { setPick({ kind: 'day', iso }); toTasksCard(); };
  const pickPriority = (p) => { setPick({ kind: 'priority', p }); toTasksCard(); };
  const picked = !pick ? null
    : pick.kind === 'day' ? openMine.filter((t) => (t.dueOn || '').slice(0, 10) === pick.iso).sort(byDueThenPriority)
    : openMine.filter((t) => (t.priority || 'medium') === pick.p).sort(byDueThenPriority);
  const pickLabel = !pick ? '' : pick.kind === 'day' ? `Due ${dayTitle(pick.iso)}` : `${PRIORITY_META[pick.p]?.label || pick.p} Priority`;
  const myTeams = useMemo(() => teams.filter((d) => (d.memberIds || []).includes(myEmail)), [teams, myEmail]);
  const teamMembers = useMemo(() => { const s = new Set(); myTeams.forEach((d) => (d.memberIds || []).forEach((id) => s.add(id))); return [...s]; }, [myTeams]);
  // The bookmark rows, in the order the person set. A bookmark whose project
  // has gone is dropped server-side (see list_bookmarks), so this only has to
  // survive the gap between the two fetches.
  const bookmarked = useMemo(
    () => (projects || []).filter((p) => bookmarks?.has(p.id)),
    [projects, bookmarks],
  );
  const projectById = useMemo(() => new Map((projects || []).map((p) => [p.id, p])), [projects]);
  // Per-project task tallies for the progress bars on Bookmarks.
  const projStats = useMemo(() => {
    const m = {};
    for (const t of tasks) {
      if (!t.projectId || t.parentTaskId) continue;
      const s = m[t.projectId] || (m[t.projectId] = { total: 0, done: 0 });
      s.total += 1; if (t.completed) s.done += 1;
    }
    return m;
  }, [tasks]);
  const teamProjectIds = useMemo(() => myTeams.map((d) => d.projectId).filter(Boolean), [myTeams]);
  const atRisk = useMemo(() => projectsAtRisk(projects, tasks, { me: myEmail, bookmarks, today, teamProjectIds }),
    [projects, tasks, myEmail, bookmarks, today, teamProjectIds]);
  const workload = useMemo(() => teamWorkload(teamMembers, tasks, today), [teamMembers, tasks, today]);

  // Chart widgets - all derived from real task rows, nothing sampled.
  const dayCharts = useMemo(() => {
    const dueByDay = [];    // next 7 days incl. today, from dueOn (open tasks)
    for (let i = 0; i < 7; i++) {
      const iso = addDays(today, i);
      dueByDay.push({ iso, today: i === 0, n: myTasks.filter((t) => !t.completed && (t.dueOn || '').slice(0, 10) === iso).length });
    }
    const prio = {};
    for (const t of myTasks) if (!t.completed) prio[t.priority || 'medium'] = (prio[t.priority || 'medium'] || 0) + 1;
    return { dueByDay, prio, weeks: completedWeeks(myTasks, today) };
  }, [myTasks, today]);

  // A row's context: its project (a subtask's is its parent's) and its parent.
  const rowProps = (t) => {
    const parent = t.parentTaskId ? taskById.get(t.parentTaskId) : null;
    const pid = t.projectId || parent?.projectId || '';
    const project = pid ? projectById.get(pid) : null;
    return {
      project, projectName: project ? project.name : '', parentTitle: parent?.title || '',
      recurring: isRecurring(t), due: t.dueOn ? dueLabel(t.dueOn, today) : '', dueTone: dueColor((t.dueOn || '').slice(0, 10), t.completed),
    };
  };
  const openMyDay = () => { setMineView('myday'); onNavigate('mine'); };
  const openPerson = (email) => window.dispatchEvent(new CustomEvent('nexus:tasks-person', { detail: { email, name: nameOf(email) || email } }));
  const openNotification = (n) => {
    if (!n.read) store.markNotificationRead?.(n.id);
    if (n.taskId) setOpenId(n.taskId);
  };

  const cancelCreate = () => { setCreating(false); setNewTitle(''); setNewDue(null); };
  const commitCreate = async (openDetails) => {
    const title = newTitle.trim();
    if (!title) { if (!openDetails) cancelCreate(); return; }
    // One save per title: cleared before the request, so Enter then a
    // click-away cannot make it twice.
    if (creatingTask.current) return;
    creatingTask.current = true;
    const dueOn = newDue || '';
    setNewTitle(''); setNewDue(null);
    const t = await createTask({ title, assigneeIds: myEmail ? [myEmail] : [], dueOn, status: 'not_started', priority: 'medium', type: 'task' }).catch(() => null);
    creatingTask.current = false;
    if (openDetails && t) { setCreating(false); setOpenId(t.id); }
  };
  // The click-away listener always calls the latest commitCreate.
  const commitRef = useRef(commitCreate);
  useEffect(() => { commitRef.current = commitCreate; });
  useEffect(() => {
    if (!creating) return undefined;
    const away = (e) => {
      const el = e.target;
      if (createRowRef.current?.contains(el) || el?.closest?.('[data-nx-calendar]')) return;
      commitRef.current(false);
    };
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, [creating]);

  // Phones: slimmer card padding - the cards run edge to edge there (see the
  // phone block in style.css) and 20px a side cost a quarter of a task title.
  const widgetBox = (children, extra) => <WidgetCard isMobile={isMobile} style={extra}>{children}</WidgetCard>;
  // The core's width decides side by side or stacked (CORE_WIDE). Measured,
  // not a media query: the sidebar's width changes what the column gets.
  const coreRef = useRef(null);
  const [coreW, setCoreW] = useState(0);
  useEffect(() => {
    const el = coreRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    setCoreW(Math.round(el.getBoundingClientRect().width));
    const ro = new ResizeObserver(([e]) => setCoreW((w) => { const n = Math.round(e.contentRect.width); return n === w ? w : n; }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const coreWide = !isMobile && coreW >= CORE_WIDE;
  // Updates takes the left column unless its feed has loaded with nothing in
  // it (see the core below). A failed read still leads: the notice counts.
  // Decided ONCE per visit, by the feed's first answer (`lead`, set where the
  // read lands): a feed that fills up later (the poll, Load More, a row
  // answered) must not swap the two columns under the person. The only move
  // left is the one from the loading skeleton (Updates leads) to a feed that
  // came back empty.
  const updatesLead = coreWide && (lead ?? 'updates') === 'updates';
  // Takes no height of its own (absolute inside), so the Updates column is
  // exactly as tall as Tasks + Bookmarks - with a floor, for a quiet week
  // with three tasks and no bookmarks. Keyed, like the other two core cells,
  // so a change of lead MOVES the card (its For You filter, open rows and
  // scroll kept) instead of unmounting it.
  const updatesColumn = () => (
    <div key="updates" data-home-updates-column style={{ gridArea: 'updates', position: 'relative', minWidth: 0, minHeight: 520 }}>
      <div style={{ position: 'absolute', inset: 0 }}>{renderWidget('updates')}</div>
    </div>
  );
  // Today / This Week / This Month, in the Tasks card's header - the tabs it
  // scopes (Upcoming, Completed) are there, so it is too (Oct 23 2026; it sat
  // on the tiles' card at a desk before).
  const rangePicker = (
    <div>
      <button ref={rangeRef} onClick={() => setRangeOpen((o) => !o)} style={{ ...btn('outline'), whiteSpace: 'nowrap', padding: '6px 12px', fontSize: 12.5 }}>{rangeDef.label} <ChevronDown size={14} style={{ color: NX.faint }} /></button>
      <AnchoredMenu anchorRef={rangeRef} open={rangeOpen} onClose={() => setRangeOpen(false)} align="end"
        style={{ width: 150, background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,0.16)', padding: 4 }}>
        {RANGES.map((r) => <button key={r.key} onClick={() => { setRange(r.key); setRangeOpen(false); }} style={{ ...btn('ghost'), width: '100%', justifyContent: 'flex-start', color: range === r.key ? NX.blue : NX.ink }}>{r.label}</button>)}
      </AnchoredMenu>
    </div>
  );
  // The Tasks card's list for the tab (or a chart's pick), capped at ROW_CAP
  // with View All - grouped Today / Tomorrow / This Week / Later on Upcoming,
  // with the undated ones folded under No Due Date.
  // Under a Today or Tomorrow heading the row's own date would only repeat it.
  const line = (t, group) => {
    const p = rowProps(t);
    return <TaskLine key={t.id} t={t} {...p} due={group === 'today' || group === 'tomorrow' ? '' : p.due} compact={isMobile} onOpen={setOpenId} onToggle={toggleComplete} />;
  };
  const groupHead = (label, n, extra) => (
    <span style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 0 4px', fontSize: 11.5, fontWeight: 700, color: NX.faint, letterSpacing: '.02em' }}>
      {extra}{label}<span style={{ fontWeight: 600 }}>{n}</span>
    </span>
  );
  const tasksList = () => {
    if (store.loading && myTasks.length === 0) return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '10px 0' }}>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="skel" style={{ width: 16, height: 16, borderRadius: '50%' }} />
            <span className="skel" style={{ width: `${62 - i * 9}%`, height: 12 }} />
            <span className="skel" style={{ width: 64, height: 11, marginLeft: 'auto' }} />
          </div>
        ))}
      </div>
    );
    const windowWords = rangeDef.ahead;
    const lookback = rangeDef.back;
    let flat = null;
    let emptyText = 'Nothing here.';
    if (picked) { flat = picked; emptyText = pick.kind === 'day' ? 'Nothing due that day.' : 'No open tasks at that priority.'; }
    else if (tab === 'Overdue') { flat = overdue; emptyText = 'Nothing overdue.'; }
    else if (tab === 'In Progress') { flat = inProgress; emptyText = 'Nothing in progress. Set a task to In Progress to see it here.'; }
    else if (tab === 'Completed') { flat = completed; emptyText = `Nothing completed ${lookback}.`; }
    const total = flat ? flat.length : upcomingByDay.reduce((n, g) => n + g.rows.length, 0);
    const viewAll = (n) => (
      <div style={{ paddingTop: 8 }}><ViewAll label={`${n - ROW_CAP} More in My Tasks`} onClick={() => { setMineView('list'); onNavigate('mine'); }} /></div>
    );
    if (flat) {
      if (flat.length === 0) return <p style={{ padding: '24px 0', textAlign: 'center', fontSize: 13, color: NX.faint, margin: 0 }}>{emptyText}</p>;
      return <div style={{ display: 'flex', flexDirection: 'column' }}>{flat.slice(0, ROW_CAP).map((t) => line(t))}{flat.length > ROW_CAP && viewAll(flat.length)}</div>;
    }
    // Upcoming: the groups, up to ROW_CAP rows in all.
    let left = ROW_CAP;
    const blocks = [];
    for (const g of upcomingByDay) {
      if (left <= 0) break;
      const rows = g.rows.slice(0, left);
      left -= rows.length;
      blocks.push(<div key={g.key}>{groupHead(g.label, g.rows.length)}{rows.map((t) => line(t, g.key))}</div>);
    }
    return (
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {total === 0 && <p style={{ padding: '18px 0 10px', textAlign: 'center', fontSize: 13, color: NX.faint, margin: 0 }}>{`Nothing due ${windowWords}.`}</p>}
        {blocks}
        {total > ROW_CAP && viewAll(total)}
        {undated.length > 0 && (
          <div>
            <button type="button" onClick={() => setShowUndated((v) => !v)} aria-expanded={showUndated}
              style={{ ...btn('ghost'), padding: 0, marginTop: 4 }}>
              {groupHead('No Due Date', undated.length, showUndated ? <ChevronDown size={13} /> : <ChevronRight size={13} />)}
            </button>
            {showUndated && <>{undated.slice(0, ROW_CAP).map((t) => line(t))}{undated.length > ROW_CAP && viewAll(undated.length)}</>}
          </div>
        )}
      </div>
    );
  };

  const renderWidget = (key) => {
    if (key === 'my_tasks') return widgetBox(
      <div ref={tasksCardRef} data-home-tasks style={{ scrollMarginTop: 12 }}>
        <WidgetHeader Icon={CheckSquare} tone={NX.blue} title="Tasks" onTitle={() => onNavigate('mine')}
          action={(tab === 'Upcoming' || tab === 'Completed') && !pick ? rangePicker : null} />
        <div role="tablist" aria-label="Tasks"
          onKeyDown={(e) => {
            if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
            e.preventDefault();
            const i = TABS.indexOf(pick ? '' : tab);
            const next = TABS[(Math.max(0, i) + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
            setPick(null); setTab(next);
            setTimeout(() => e.currentTarget?.querySelector?.(`[data-tab="${next}"]`)?.focus(), 0);
          }}
          style={{ display: 'flex', alignItems: 'center', gap: 16, borderBottom: `1px solid ${NX.border}`, marginBottom: 10, fontSize: 13, fontWeight: 600, flexWrap: 'wrap' }}>
          {TABS.map((t) => {
            const on = tab === t && !pick;
            const n = t === 'Overdue' ? overdue.length : t === 'In Progress' ? inProgress.length : 0;
            return (
              <button key={t} type="button" role="tab" aria-selected={on} aria-controls="home-tasks-panel" tabIndex={on || (pick && t === tab) ? 0 : -1} data-tab={t}
                onClick={() => { setPick(null); setTab(t); }}
                style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: '0 0 8px', borderBottom: `2px solid ${on ? NX.blue : 'transparent'}`, color: on ? NX.blue : NX.dim, fontFamily: FONT, fontWeight: 600 }}>
                {t}{n > 0 ? ` (${n})` : ''}
              </button>
            );
          })}
        </div>
        {pick && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 6px 3px 10px', borderRadius: 999, background: `${NX.blue}1a`, color: NX.blue, fontSize: 12.5, fontWeight: 600 }}>
              {pickLabel}
              <button type="button" onClick={() => setPick(null)} aria-label="Clear Filter" title="Clear Filter"
                style={{ ...btn('ghost'), padding: 2, color: NX.blue, borderRadius: '50%' }}><X size={13} /></button>
            </span>
          </div>
        )}
        {creating ? (
          <div ref={createRowRef} style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 8, borderBottom: `2px solid ${NX.blue}`, padding: '6px 0', marginBottom: 4 }}>
            <Circle size={16} style={{ color: NX.faint, flexShrink: 0 }} />
            <input ref={titleRef} autoFocus value={newTitle} onChange={(e) => setNewTitle(e.target.value)} aria-label="Task Name"
              onKeyDown={(e) => { if (e.key === 'Enter') commitCreate(false); if (e.key === 'Escape') cancelCreate(); }}
              // Two or more lines on the clipboard are a list, not a name: Add
              // Several takes them (one task per line) - a one-line paste is typed in as before.
              onPaste={(e) => {
                const list = pastedTaskList(e);
                if (!list) return;
                e.preventDefault();
                // The due date and any text already typed travel; the typed text is the first line.
                const due = newDue; const typed = newTitle.trim();
                cancelCreate();
                setSeveral({ text: typed ? `${typed}\n${list}` : list, dueOn: due || '' });
              }}
              // Keyboard focus leaving the row saves; a pointer leaving it is the
              // document listener above (a click inside the calendar moves
              // focus too, and must not save).
              onBlur={(e) => { const to = e.relatedTarget; if (to && !createRowRef.current?.contains(to) && !to.closest?.('[data-nx-calendar]')) commitCreate(false); }}
              placeholder="Write a task name" className="nx-inline-edit" style={{ flex: 1, minWidth: 0, border: 'none', fontFamily: FONT, fontSize: 13, color: NX.ink }} />
            <DictateButton target={titleRef} title="Dictate the Task Name" style={{ width: 28, height: 28 }} size={14} />
            {/* DateField, never a native date box (it follows the computer's
                region). A picked date puts the cursor back in the title, so
                Enter saves. */}
            <DateField compact noPast value={newDue || ''} title="Set Due Date" color={newDue ? dueColor(newDue, false) : undefined}
              onChange={(v) => { setNewDue(notPast(v) || null); setTimeout(() => titleRef.current?.focus(), 0); }} />
            <button onMouseDown={(e) => { e.preventDefault(); commitCreate(true); }} style={{ ...btn('ghost'), padding: 4, color: NX.faint }} title="Details" aria-label="Details"><ChevronRight size={16} /></button>
          </div>
        ) : (
          <button onClick={() => setCreating(true)} style={{ ...btn('ghost'), padding: '6px 0', color: NX.dim, fontSize: 13, fontWeight: 500 }}><Plus size={15} /> Create Task</button>
        )}
        {addedNote && <div role="status" style={{ fontSize: 12.5, color: NX.green, fontWeight: 600, padding: '2px 0 6px' }}>{addedNote}</div>}
        {several && (
          <AddSeveralModal defaults={{ text: several.text, dueOn: several.dueOn, assigneeIds: myEmail ? [myEmail] : [], source: 'paste' }}
            onClose={() => setSeveral(null)}
            onDone={(r) => {
              // Top-level tasks, as the button counted them (subtasks ride along).
              const n = r?.topLevelIds?.length ?? r?.created ?? 0;
              noteAdded(`${n} task${n === 1 ? '' : 's'} added`);
              // Undated tasks live under the collapsed No Due Date fold - open it so the new ones show.
              if (!several?.dueOn) setShowUndated(true);
            }} />
        )}
        <div id="home-tasks-panel" role="tabpanel" aria-label={pick ? pickLabel : tab}>{tasksList()}</div>
      </div>
    );
    if (key === 'updates') return (
      <UpdatesCard updates={updates} failed={updatesFailed} seenAt={updatesSeenAt} nameOf={nameOf} statusMeta={store.statusMeta}
        taskById={taskById} onOpen={openUpdate} fill={coreWide} isMobile={isMobile}
        projectOf={projectOf} onChanged={() => setUpdatesNonce((n) => n + 1)}
        onLoadMore={updates && updates.length >= updatesLimit && updatesLimit < 100 ? () => setUpdatesLimit((n) => Math.min(100, n + 30)) : undefined} />
    );
    if (key === 'projects') return widgetBox(
      <>
        <WidgetHeader Icon={Star} tone={NX.amber} title="Bookmarks" count={bookmarked.length || null} action={{ label: 'View All', onClick: () => onNavigate('projects') }} />
        {/* Was "Projects": the four most recent, as cover-band tiles. Two
            problems with that (Neil, Sept 8) - the list was whatever the API
            returned rather than what you care about, and a tile is ~110px tall,
            so four of them filled the card. Bookmarks are chosen, and rendered
            as LINES: the same card now holds a dozen, which is the number a
            person actually watches. Bookmark from a project's own header. */}
        {bookmarked.length === 0 ? (
          <div style={{ padding: '6px 0', fontSize: 13, color: NX.faint }}>
            No bookmarks yet. Open a project and click the <strong>star</strong> next to its name to pin it here.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {bookmarked.map((p, i) => {
              const pc = projectLook(p, NX.purple).color;
              const st = projStats[p.id] || { total: 0, done: 0 };
              const pct = st.total ? Math.round((st.done / st.total) * 100) : 0;
              return (
                <button key={p.id} onClick={() => onNavigate({ projectId: p.id })}
                  className="nx-menu-row"
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left',
                    padding: '7px 8px', border: 'none', borderRadius: 7, cursor: 'pointer',
                    fontFamily: FONT, background: i % 2 === 1 ? NX.zebra : 'transparent',
                  }}>
                  <ProjectIcon project={p} size={14} fallbackColor={NX.purple} />
                  <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: NX.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                  {/* The bar is the whole point of a watch list - progress at a
                      glance, without opening anything. */}
                  <span style={{ width: 64, height: 5, borderRadius: 3, background: NX.border2, overflow: 'hidden', flexShrink: 0 }}>
                    <span style={{ display: 'block', height: '100%', width: `${pct}%`, borderRadius: 3, background: pct === 100 ? NX.green : pc }} />
                  </span>
                  <span style={{ fontSize: 11.5, color: NX.faint, flexShrink: 0, width: 46, textAlign: 'right' }}>
                    {st.total ? `${st.done}/${st.total}` : '-'}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </>,
      // Beside Updates it runs to the bottom of that column, so the two
      // sides end on one line.
      coreWide ? { height: '100%', boxSizing: 'border-box' } : undefined,
    );
    if (key === 'recycle') return widgetBox(
      <>
        <WidgetHeader Icon={Trash2} tone={NX.dim} title="Recycle Bin" style={{ marginBottom: 4 }} />
        {/* scope="mine" - what YOU deleted plus what you were assigned, enforced
            server-side and NOT widened for managers. The whole workspace's is
            Manage > Recycle Bin, which is a different question. */}
        <RecycleBinPanel store={store} scope="mine" />
      </>
    );
    if (key === 'my_day') return (
      <MyDayCard onOpenTask={setOpenId} onToggle={toggleComplete} onOpenMyDay={openMyDay} isMobile={isMobile} />
    );
    if (key === 'teams') return <TeamsWidget teams={myTeams} projects={projects} onViewAll={() => onNavigate('teams')} isMobile={isMobile} />;
    if (key === 'team_members') return <TeamWorkloadWidget rows={workload} nameOf={nameOf} me={myEmail} onOpenPerson={openPerson} isMobile={isMobile} />;
    if (key === 'urgent') return <ProjectsAtRiskWidget rows={atRisk} onOpenProject={(id) => onNavigate({ projectId: id })} onViewAll={() => onNavigate('projects')} isMobile={isMobile} />;
    if (key === 'activity') return (
      <CompletedWeekWidget weeks={dayCharts.weeks} isMobile={isMobile}
        onOpen={() => { setPick(null); setTab('Completed'); setRange('week'); toTasksCard(); }} />
    );
    if (key === 'week') return <WeekAheadWidget days={dayCharts.dueByDay} onPickDay={pickDay} isMobile={isMobile} />;
    if (key === 'priorities') return <ByPriorityWidget counts={dayCharts.prio} open={openMine.length} onPick={pickPriority} isMobile={isMobile} />;
    if (key === 'notifications') return <NotificationsWidget notifications={notifications} onOpen={openNotification} isMobile={isMobile} />;
    return null;
  };

  const metaOf = (key) => WIDGET_META.find((w) => w.key === key);
  const overlayOff = { opacity: 0.4, cursor: 'default', boxShadow: 'none' };
  const overlayBtn = { width: 26, height: 26, borderRadius: '50%', border: `1px solid ${NX.border}`, background: NX.surface, color: NX.dim, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 2px 6px rgba(0,0,0,.12)', cursor: 'pointer', padding: 0 };

  return (
    <div className="nx-page" style={{ padding: '24px 24px 76px', fontFamily: FONT, color: NX.ink, height: '100%', overflow: 'auto' }}>
      {/* The page-level controls (Customize, or Autofit + Done while
          customizing) live in the module bar beside Manage - the header row
          that used to carry them held nothing else once the greeting, the
          date and the counts went, so it cost a row to show one button. The
          range picker and task stats sit in the "My Tasks" card they actually
          scope. */}
      {barSlot && createPortal(
        customizing ? (
          <>
            <button onClick={toggleAutofit} title="Pack widgets to fill gaps" style={{ ...btn('outline'), flexShrink: 0, whiteSpace: 'nowrap', background: autofit ? NX.hover : undefined }}>{autofit ? <Check size={14} /> : null} Autofit</button>
            <button onClick={() => { setCustomizing(false); setDragKey(null); setOverKey(null); }} style={{ ...btn('primary'), flexShrink: 0, whiteSpace: 'nowrap' }}><Check size={14} /> Done</button>
          </>
        ) : (
          <button onClick={() => setCustomizing(true)} title="Customize Widgets" style={{ ...btn('outline'), flexShrink: 0, whiteSpace: 'nowrap' }}><SlidersHorizontal size={14} /> Customize</button>
        ),
        barSlot,
      )}

      {/* The four tiles (Neil, Oct 23 2026): Overdue / Due Today / This Week /
          In Progress, each a tint of what it means, each switching the Tasks
          card below; under them the dashboard's own number. They replace the
          pastel kit tiles, whose colors meant nothing (Completed was red) and
          whose "/N" divided by every task the person ever had. Not on phones
          (Neil, Oct 14): the list's tabs carry the same counts there, and the
          tiles pushed the list below the fold. */}
      {!isMobile && <FocusTiles counts={tiles} focus={focus} onPick={pickTile} active={activeTile} />}

      {/* The core. At a desk Updates LEADS (Neil, 10/31/2026): it answers
          "what changed that affects what I do next", so it takes the LEFT
          column for the full height of the other two (its list scrolls
          inside), and Tasks then Bookmarks stack one column over at full
          height. The order is swapped in the DOM too, so tab order and a
          screen reader follow the eye. The one fallback: a feed that has
          loaded EMPTY (a new hire, no collaborators yet) would put an empty
          state in the primary slot, so that day Tasks keeps the left column
          as before; while the feed is still loading, and when it failed (the
          notice is worth seeing), Updates leads. The lead is fixed for the
          visit by the feed's first answer (`lead`). Stacked - Tasks,
          Updates, Bookmarks - on a phone or a narrow window: there the add
          row and today's work stay above the fold. */}
      <div ref={coreRef} data-home-core={coreWide ? 'wide' : 'stacked'} data-home-core-lead={updatesLead ? 'updates' : 'tasks'}
        style={coreWide ? {
          display: 'grid', gap: 16, marginBottom: 16,
          gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
          gridTemplateAreas: updatesLead ? '"updates tasks" "updates bookmarks"' : '"tasks updates" "bookmarks updates"',
          gridTemplateRows: 'auto 1fr',
        } : { display: 'flex', flexDirection: 'column', gap: isMobile ? 12 : 16, marginBottom: 16 }}>
        {(() => {
          const tasksCell = <div key="tasks" style={{ gridArea: 'tasks', minWidth: 0 }}>{renderWidget('my_tasks')}</div>;
          const bookmarksCell = <div key="bookmarks" style={{ gridArea: 'bookmarks', minWidth: 0 }}>{renderWidget('projects')}</div>;
          if (!coreWide) return [tasksCell, <div key="updates" style={{ minWidth: 0 }}>{renderWidget('updates')}</div>, bookmarksCell];
          return updatesLead ? [updatesColumn(), tasksCell, bookmarksCell] : [tasksCell, updatesColumn(), bookmarksCell];
        })()}
      </div>

      {/* Customize mode: add-widget tray (only unused widgets) */}
      {customizing && availableWidgets.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: NX.dim, marginBottom: 8 }}>Add Widgets</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(240px, 100%), 1fr))', gap: 8 }}>
            {availableWidgets.map(({ key: k, label, Icon, desc }) => (
              <button key={k} type="button" onClick={() => persist([...widgets, k])}
                style={{ display: 'flex', alignItems: 'flex-start', gap: 10, textAlign: 'left', padding: '10px 12px', borderRadius: 12, border: `1px dashed ${NX.border}`, background: 'transparent', cursor: 'pointer', fontFamily: FONT }}>
                <span aria-hidden="true" style={{ width: 26, height: 26, borderRadius: 7, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: NX.hover, color: NX.dim }}>{Icon ? <Icon size={14} /> : <Plus size={14} />}</span>
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, fontWeight: 600, color: NX.ink }}><Plus size={12} /> {label}</span>
                  {desc && <span style={{ display: 'block', fontSize: 12, color: NX.faint, marginTop: 2 }}>{desc}</span>}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* min(340px, 100%) so a column can never be wider than the viewport.
          Autofit = masonry packing (CSS columns) so short and tall widgets
          fill the page without holes; source order is still the saved order.
          Masonry is a multi-column trick - on mobile the grid is already down
          to one column (a single 340px-min track is all that fits), so there
          is nothing beside a widget for it to pack against, and a stale
          measured span (e.g. from a taller pre-data skeleton) just shows up
          as dead space before the next widget instead. Plain stacking with a
          fixed gap sidesteps that - every widget is simply its own height. */}
      <div className="nx-card-grid"
        onDragOver={customizing ? (e) => e.preventDefault() : undefined}
        onDrop={customizing ? (e) => { e.preventDefault(); if (dragKey) { reorder(dragKey, null); } setDragKey(null); setOverKey(null); } : undefined}
        style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(340px, 100%), 1fr))',
          columnGap: 16,
          ...(autofit && !isMobile ? { gridAutoRows: 8, rowGap: 0 } : { rowGap: 16, alignItems: 'start' }),
        }}>
        {extraWidgets.map((key) => (
          <MasonryCell key={key} masonry={autofit && !isMobile}
            draggable={customizing}
            onDragStart={customizing ? () => setDragKey(key) : undefined}
            /* dragover fires continuously - functional setState with a same-value
               bail keeps it from re-rendering the whole grid per mouse move
               (the drag lag), and skipping dragLeave kills the enter/leave
               flicker churn; overKey clears on drop/end instead. */
            onDragOver={customizing ? (e) => { e.preventDefault(); if (dragKey && dragKey !== key) setOverKey((k) => (k === key ? k : key)); } : undefined}
            onDrop={customizing ? (e) => { e.preventDefault(); e.stopPropagation(); reorder(dragKey, key); setDragKey(null); setOverKey(null); } : undefined}
            onDragEnd={customizing ? () => { setDragKey(null); setOverKey(null); } : undefined}
            style={{
              minWidth: 0, position: 'relative', borderRadius: 16,
              outline: customizing ? `2px dashed ${overKey === key ? NX.primary : NX.border}` : 'none', outlineOffset: -2,
              cursor: customizing ? 'grab' : undefined,
              opacity: dragKey === key ? 0.45 : 1,
            }}>
            {customizing && (
              <div style={{ position: 'absolute', top: -12, right: 6, zIndex: 5, display: 'flex', gap: 4 }}>
                {!isMobile && <span title="Drag to rearrange" style={{ ...overlayBtn, color: NX.faint, cursor: 'grab' }}><GripVertical size={14} /></span>}
                {/* Dragging needs a mouse; these work by keyboard and touch. */}
                <button type="button" data-move={`${key}:-1`} onClick={() => move(key, -1)} disabled={extraWidgets.indexOf(key) === 0}
                  title="Move Earlier" aria-label={`Move ${metaOf(key)?.label || key} Earlier`} style={{ ...overlayBtn, ...(extraWidgets.indexOf(key) === 0 ? overlayOff : {}) }}>
                  {isMobile ? <ArrowUp size={14} /> : <ArrowLeft size={14} />}</button>
                <button type="button" data-move={`${key}:1`} onClick={() => move(key, 1)} disabled={extraWidgets.indexOf(key) === extraWidgets.length - 1}
                  title="Move Later" aria-label={`Move ${metaOf(key)?.label || key} Later`} style={{ ...overlayBtn, ...(extraWidgets.indexOf(key) === extraWidgets.length - 1 ? overlayOff : {}) }}>
                  {isMobile ? <ArrowDown size={14} /> : <ArrowRight size={14} />}</button>
                <button type="button" onClick={() => persist(widgets.filter((k) => k !== key))} title="Remove Widget"
                  aria-label={`Remove ${metaOf(key)?.label || key}`} style={overlayBtn}><X size={14} /></button>
              </div>
            )}
            {renderWidget(key)}
          </MasonryCell>
        ))}
      </div>
      {openId && <TaskDetailDrawer taskId={openId} onClose={() => setOpenId(null)}
        focusComment={openComment?.taskId === openId ? openComment : null} />}
    </div>
  );
}

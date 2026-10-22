/* eslint-disable react-hooks/refs -- the context value intentionally exposes a stable comment-cache ref's current map; a deliberate ref read the React-Compiler rule flags */
// Task Module - data layer. Replaces the export's React-Query + Zustand +
// NexusTaskStore with a single Nexus-style context: loads from the FastAPI
// backend, applies optimistic updates, and refetches on a task_events realtime
// ping (with a poll fallback), mirroring RequisitionContext.
import { createContext, useContext, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { api } from '../api';
import { supabase } from '../lib/supabase';
import { useRole } from '../contexts/RoleContext';
import { useNameResolver } from '../lib/useNameResolver';
import { STATUS_META, STATUS_ORDER, NX } from './theme';
import { celebrateCompletion } from './celebrate';
import { pollWhileVisible } from '../lib/pollWhileVisible';
import { loadTaskData, taskSnapshot, rememberTaskData, FIRST_PAINT } from './taskStore';
import { noteStatusChanges } from './recentChanges';
import { moveUndoBody } from './lib';

function tasksReducer(prev, v) {
  const next = typeof v === 'function' ? v(prev) : v;
  noteStatusChanges(prev, next);
  return next;
}

const Ctx = createContext(null);

// Merge the four built-in statuses with the workspace's custom statuses so every
// status surface (dropdowns, chips, board columns, filters, grouping) reflects
// what's defined in Manage → Custom Statuses. Custom-status ids are stored on
// tasks as their `status`, so both the lookup map and the ordered list key on id.
function buildStatusMeta(customStatuses) {
  const meta = { ...STATUS_META };
  for (const c of customStatuses || []) {
    meta[c.id] = { label: c.label, color: c.color || NX.dim, tint: `${c.color || NX.dim}1a` };
  }
  return meta;
}
function buildStatusOrder(customStatuses) {
  const custom = [...(customStatuses || [])].sort((a, b) => (a.position || 0) - (b.position || 0));
  return [...STATUS_ORDER, ...custom.map((c) => c.id)];
}
// Statuses a project actually uses: its own plus any global one, same convention
// as fieldsForProject. Only the ORDER is scoped, never statusMeta - a task
// carries its status id wherever it's rendered (search results, My Tasks, a
// portfolio rollup), and a meta lookup that missed would draw a raw uuid.
export const statusesForProject = (customStatuses, projectId) =>
  (customStatuses || []).filter((s) => {
    const ids = (s.projectIds || []).filter(Boolean);
    return ids.length === 0 || (projectId ? ids.includes(projectId) : false);
  });

// camelCase (frontend) → snake_case (API body). The backend serialises replies
// back to camelCase, so we only map on the way out.
const CAMEL_TO_SNAKE = {
  assigneeId: 'assignee_email', assigneeIds: 'assignee_emails',
  followerIds: 'follower_emails', likedByIds: 'liked_by_emails',
  accessLevel: 'access_level', projectId: 'project_id', sectionId: 'section_id',
  teamId: 'team_id', parentTaskId: 'parent_task_id', subtaskIds: 'subtask_ids', subtaskOrder: 'subtask_order', timeTracking: 'time_tracking',
  blockedByIds: 'blocked_by_ids', blockingIds: 'blocking_ids', dependencyTypes: 'dependency_types',
  customFieldValues: 'custom_field_values', startOn: 'start_on', dueOn: 'due_on',
  estimateHours: 'estimate_hours', actualHours: 'actual_hours', isMilestone: 'is_milestone',
  approvalStatus: 'approval_status', ownerId: 'owner_email', memberIds: 'member_emails',
  portfolioId: 'portfolio_id', parentId: 'parent_id', projectIds: 'project_ids', targetProjectId: 'target_project_id',
  requesterId: 'requester_email', linkedTaskId: 'linked_task_id', slaDueOn: 'sla_due_on', typeFields: 'type_fields',
  companyId: 'company_id', hrDepartmentId: 'hr_department_id', hrDepartmentName: 'hr_department_name',
  watcherIds: 'watcher_emails', csatRating: 'csat_rating', csatComment: 'csat_comment',
  taskIds: 'task_ids', subtaskTitles: 'subtask_titles', serviceArea: 'service_area',
  resolutionNote: 'resolution_note',
  // Project default view + shared dashboard charts (Oct 2026).
  defaultView: 'default_view', sharedCharts: 'shared_charts',
  // Convert to Ticket (Oct 6) - see backend TicketBody.from_task_id.
  fromTaskId: 'from_task_id', closeSourceTask: 'close_source_task',
  // Project-template options (save-as-template / use / duplicate) - see
  // backend ProjectTemplateBody, UseTemplateBody and DuplicateProjectBody.
  includeTasks: 'include_tasks', includeSubtasks: 'include_subtasks',
  includeCompleted: 'include_completed', includeAssignees: 'include_assignees',
  includeMembers: 'include_members', includeTeams: 'include_teams',
  includeDates: 'include_dates', resetStatus: 'reset_status',
  // Property Tickets (Oct 6) - see backend TicketBody / TicketUpdate.
  propertyAssetId: 'property_asset_id', maintenanceVendor: 'maintenance_vendor', maintenanceCost: 'maintenance_cost',
  propertyLocked: 'property_locked',
  // Honest SLA (Oct 2026) - server-derived; mapped so it never goes out camelCased.
  slaDueAt: 'sla_due_at',
  // The ticket's Unit at its property (Ops review, Oct 20).
  propertyUnit: 'property_unit',
};
function toBody(patch) {
  const out = {};
  for (const [k, v] of Object.entries(patch || {})) out[CAMEL_TO_SNAKE[k] || k] = v;
  return out;
}

// The screens that show the ticket list kept fresh by the background refresh
// (see TasksProvider): the Tickets module (/tickets, and the old
// /tasks/tickets address) and Support (/support), whose ticket drawer reads
// it. Read from the address bar, which App keeps in step with the view.
function onTicketSurface(pathname = window.location.pathname) {
  const segs = String(pathname || '').split('/').filter(Boolean);
  return segs[0] === 'tickets' || segs[0] === 'support'
    || (segs[0] === 'tasks' && segs[1] === 'tickets');
}

// Refetch the whole ticket list after a link change. A failed or odd answer
// keeps the list on screen rather than replacing it with nothing.
async function reloadTicketsInto(setTickets) {
  let rows;
  try { rows = await api.getTaskTickets(); } catch { return; }
  if (Array.isArray(rows)) setTickets(rows);
}

export function TasksProvider({ children }) {
  const { myEmail } = useRole();
  const nameOf = useNameResolver();

  // Seed from the module-scope cache (taskStore): a prefetch at boot, or an
  // earlier visit, means this mount opens with the data already in hand and
  // never shows a spinner - the refresh below then streams over the top.
  const seed = taskSnapshot();
  // Every write to the task list notes which tasks changed status or
  // completion (tasks/recentChanges.js), so a row or card that remounts in
  // its new column / group can still glow. A reducer so it runs before any
  // row renders the new list; the note is idempotent, so StrictMode's double
  // call is harmless. `setTasks` keeps useState's (value | updater) contract.
  const [tasks, setTasks] = useReducer(tasksReducer, seed?.tasks?.tasks || []);
  const [projects, setProjects] = useState(seed?.projects || []);
  const [portfolios, setPortfolios] = useState(seed?.portfolios || []);
  const [teams, setTeams] = useState(seed?.teams || []);
  const [tickets, setTicketsState] = useState(seed?.tickets || []);
  // Every local write to the ticket list (create / update / delete / link /
  // escalate, the first load) goes through this and bumps the generation, so
  // a background refresh that was already on the wire when one of them landed
  // knows its answer may predate that write and drops it (refreshTickets).
  const ticketGenRef = useRef(0);
  const ticketsRef = useRef(tickets);
  ticketsRef.current = tickets;
  const setTickets = useCallback((u) => { ticketGenRef.current += 1; setTicketsState(u); }, []);
  const [ticketComponents, setTicketComponents] = useState(seed?.ticketComponents || []);
  const [savedViews, setSavedViews] = useState(seed?.savedViews || []);
  const [ticketViews, setTicketViews] = useState(seed?.ticketViews || []);
  const [rules, setRules] = useState(seed?.rules || []);
  const [templates, setTemplates] = useState(seed?.templates || []);
  const [projectTemplates, setProjectTemplates] = useState(seed?.projectTemplates || []);
  const [customFields, setCustomFields] = useState(seed?.customFields || []);
  const [customStatuses, setCustomStatuses] = useState(seed?.customStatuses || []);
  const [notifications, setNotifications] = useState([]);
  const [memberRequests, setMemberRequests] = useState(seed?.memberRequests || []);
  const [intakeForms, setIntakeForms] = useState(seed?.intakeForms || []);
  const [changelog, setChangelog] = useState(seed?.changelog || []);
  const [loading, setLoading] = useState(!seed);
  // Tickets are not part of the first paint (FIRST_PAINT), so `loading` says
  // nothing about them. A ticket drawer opened from an email link waits on
  // THIS - a fresh list has landed - before deciding the ticket is not there
  // (TicketDrawer shows its "Opening your ticket" screen until then).
  const [ticketsLoaded, setTicketsLoaded] = useState(false);
  const ticketsLoadedRef = useRef(false);
  ticketsLoadedRef.current = ticketsLoaded;
  const commentCache = useRef({});   // taskId -> comment[]
  // The caller's running task timer (Oct 2026): {entry, task} or null. One
  // per person at a time; the module bar's chip and the drawer both read it.
  const [runningTimer, setRunningTimer] = useState(null);
  // Last server timestamp a task fetch is known-good as of - see refetchTasks.
  // A ref, not state: read inside a stable useCallback, must not itself
  // trigger a re-render when it changes.
  const sinceRef = useRef(seed?.tasks?.serverTime || '');

  // Where each collection lands. Keyed by the same names taskStore uses, so a
  // new collection needs one line there and one here.
  const applyRef = useRef(null);
  if (!applyRef.current) {
    applyRef.current = {
      tasks: (v) => { setTasks(v?.tasks || []); sinceRef.current = v?.serverTime || ''; },
      projects: setProjects, portfolios: setPortfolios, teams: setTeams,
      tickets: (v) => { setTickets(v); setTicketsLoaded(true); }, ticketComponents: setTicketComponents,
      savedViews: setSavedViews, ticketViews: setTicketViews, rules: setRules,
      templates: setTemplates, projectTemplates: setProjectTemplates,
      customFields: setCustomFields, customStatuses: setCustomStatuses,
      memberRequests: setMemberRequests, intakeForms: setIntakeForms, changelog: setChangelog,
    };
  }

  // The collections stream in one by one rather than landing together, so the
  // screen paints as soon as the three the first view needs are in instead of
  // waiting on the slowest of fifteen calls.
  // Bookmarks. Held as a Set of project ids: every consumer asks "is THIS
  // project bookmarked" (the star on a header, a row in the widget), which a
  // list would turn into a linear scan on every render.
  const [bookmarks, setBookmarks] = useState(() => new Set());
  const bookmarksRef = useRef(bookmarks);
  bookmarksRef.current = bookmarks;

  const loadCore = useCallback(async () => {
    let firstPaintLeft = FIRST_PAINT.length;
    await loadTaskData((key, value) => {
      applyRef.current[key]?.(value);
      if (FIRST_PAINT.includes(key) && --firstPaintLeft === 0) setLoading(false);
    });
    setLoading(false);
  }, []);

  const loadNotifications = useCallback(async () => {
    setNotifications(await api.getTaskNotifications().catch(() => []));
  }, []);

  // Bookmarks are their own small fetch rather than part of loadCore's batch:
  // they belong to the person, not the workspace, so they neither block first
  // paint nor need reloading when the workspace data changes.
  const loadBookmarks = useCallback(async () => {
    const rows = await api.getTaskBookmarks().catch(() => []);
    setBookmarks(new Set(rows.map((b) => b.projectId)));
  }, []);

  // A project's own sections - the Custom grouping (Oct 13 2026). Small and
  // only read under that grouping, so like bookmarks it is its own fetch and
  // never holds up first paint.
  const [sections, setSections] = useState([]);
  const loadSections = useCallback(async () => {
    const rows = await api.getTaskSections().catch(() => null);
    if (Array.isArray(rows)) setSections(rows);
  }, []);

  const loadRunningTimer = useCallback(async () => {
    setRunningTimer(await api.getRunningTaskTimer().catch(() => null));
  }, []);

  useEffect(() => { loadCore(); loadNotifications(); loadBookmarks(); loadSections(); loadRunningTimer(); }, [loadCore, loadNotifications, loadBookmarks, loadSections, loadRunningTimer]);

  // Keep the module-scope cache in step with what's on screen, so the next
  // mount (Tasks -> Tickets, or a return trip from another module) starts from
  // the edits made in this session rather than the values as first fetched.
  useEffect(() => {
    rememberTaskData({
      tasks: { tasks, serverTime: sinceRef.current },
      projects, portfolios, teams, tickets, ticketComponents, savedViews, ticketViews,
      rules, templates, projectTemplates, customFields, customStatuses, memberRequests, intakeForms, changelog,
    });
  }, [tasks, projects, portfolios, teams, tickets, ticketComponents, savedViews, ticketViews,
    rules, templates, projectTemplates, customFields, customStatuses, memberRequests, intakeForms, changelog]);

  // Realtime: refetch tasks (+notifications) on a task_events ping; 45s poll
  // fallback. Incremental (GET /tasks/delta) rather than a full replace - the
  // full workspace (~2,400 tasks) doesn't need to cross the wire again just
  // because ONE task changed. sinceRef only advances on a successful response,
  // so a failed poll leaves it untouched and the next attempt naturally
  // re-covers the gap.
  const refetchTasks = useCallback(async () => {
    const { tasks: changed, deletedIds, serverTime } = await api.getTasksDelta(sinceRef.current);
    setTasks((prev) => {
      const byId = new Map(prev.map((x) => [x.id, x]));
      for (const t of changed || []) byId.set(t.id, t);
      // A row the server returns as changed is live, whatever tombstone came
      // with it: a task deleted and then restored (Undo, the Recycle Bin)
      // still has its delete-log entry, and dropping it here would make the
      // restored task vanish until a reload (Oct 21 2026).
      const live = new Set((changed || []).map((t) => t.id));
      for (const id of deletedIds || []) if (!live.has(id)) byId.delete(id);
      return [...byId.values()];
    });
    sinceRef.current = serverTime;
  }, []);
  useEffect(() => {
    let timer = null;
    const debounced = () => { clearTimeout(timer); timer = setTimeout(() => { refetchTasks(); loadNotifications(); }, 400); };
    const stopPoll = pollWhileVisible(() => { refetchTasks().catch(() => {}); }, 45000);
    let channel = null;
    if (supabase) {
      channel = supabase.channel('task_event_pings')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'task_events' }, debounced)
        .subscribe();
    }
    return () => { stopPoll(); clearTimeout(timer); if (channel) supabase?.removeChannel(channel); };
  }, [refetchTasks, loadNotifications]);

  // Tickets: they used to load once per session, so a desk agent's list went
  // stale until a reload. Tickets do not write task_events rows (only task
  // routes ping), so there is no realtime hook to share - poll every 60s while
  // the tab is visible, and refresh straight away when the tab comes back
  // from being hidden. Quiet by design: a failed fetch keeps the list on
  // screen, and ticketsLoaded only ever moves to true.
  //  - A fetch that was in flight when a local ticket write landed is dropped
  //    (generation check) - its answer may predate that write.
  //  - An open drawer's held edits live in the drawer (its `pending` state,
  //    layered over the ticket), so replacing the list never touches them.
  //  - A ticket whose data did not change keeps its object, so the drawer and
  //    rows showing it do not re-render for nothing.
  //  - The 60s interval keeps its own timing and does not hear about the
  //    tab-return refresh, so a tick can land seconds after one. A refresh
  //    within 15s of the last good answer is skipped (on a phone hopping
  //    between apps that was the whole list downloaded twice in a row).
  const ticketsFetching = useRef(false);
  const lastTicketFetchRef = useRef(0);
  const refreshTickets = useCallback(async () => {
    if (ticketsFetching.current) return;
    if (Date.now() - lastTicketFetchRef.current < 15000) return;
    ticketsFetching.current = true;
    const gen = ticketGenRef.current;
    try {
      const rows = await api.getTaskTickets();
      if (!Array.isArray(rows)) return;
      lastTicketFetchRef.current = Date.now();
      if (gen !== ticketGenRef.current) return;
      // Read from the rendered list (ticketsRef), not a state updater: the
      // generation check above already rules out a write still waiting to
      // render, and deciding here lets an unchanged answer skip setState.
      const prev = ticketsRef.current;
      const byId = new Map(prev.map((x) => [x.id, x]));
      let same = prev.length === rows.length;
      const next = rows.map((r, i) => {
        const old = byId.get(r.id);
        const keep = old && JSON.stringify(old) === JSON.stringify(r) ? old : r;
        if (keep !== prev[i]) same = false;
        return keep;
      });
      if (!same) setTicketsState(next);
      // Already true after the first load; skipping the no-op set keeps an
      // unchanged refresh from re-rendering the module.
      if (!ticketsLoadedRef.current) setTicketsLoaded(true);
    } catch {
      // keep the list we have; the next tick tries again
    } finally {
      ticketsFetching.current = false;
    }
  }, []);
  // Only while a ticket surface is on screen: the Tickets module, or Support
  // (its ticket drawer reads this list). Every other host of a TasksProvider
  // (the Tasks view, the dashboard quick actions, the help menu's new-ticket
  // form, admin settings) leaves the list alone - otherwise the Tasks view
  // alone downloaded every ticket once a minute. The path is read at each
  // tick, not at mount, so a provider that outlives a view change follows it.
  useEffect(() => {
    const refreshIfShowing = () => { if (onTicketSurface()) refreshTickets(); };
    const stopPoll = pollWhileVisible(refreshIfShowing, 60000);
    let wasHidden = document.visibilityState === 'hidden';
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') { wasHidden = true; return; }
      if (wasHidden) { wasHidden = false; refreshIfShowing(); }
    };
    document.addEventListener('visibilitychange', onVisibility);
    // Arriving on a ticket surface from elsewhere (Tasks -> Tickets share this
    // provider) refreshes at once instead of showing a list up to a minute
    // old. App moves between views with pushState, which fires no event, so
    // the address is compared once a second - a string check, no request.
    let wasOnSurface = onTicketSurface();
    const onArrive = () => {
      const now = onTicketSurface();
      if (now && !wasOnSurface && document.visibilityState === 'visible') refreshTickets();
      wasOnSurface = now;
    };
    const arriveTimer = setInterval(onArrive, 1000);
    window.addEventListener('popstate', onArrive);
    return () => {
      stopPoll(); clearInterval(arriveTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('popstate', onArrive);
    };
  }, [refreshTickets]);

  // ── Lookups ────────────────────────────────────────────────────────────────
  const taskById = useMemo(() => Object.fromEntries(tasks.map((t) => [t.id, t])), [tasks]);
  const projectById = useCallback((id) => projects.find((p) => p.id === id), [projects]);
  const portfolioById = useCallback((id) => portfolios.find((p) => p.id === id), [portfolios]);
  const teamById = useCallback((id) => teams.find((d) => d.id === id), [teams]);
  const projectName = useCallback((id) => projectById(id)?.name || '', [projectById]);
  const teamName = useCallback((id) => teamById(id)?.name || '', [teamById]);

  const patchLocalTask = useCallback((id, patch) => {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  // A later due date can come back held for approval (Oct 13 2026, backend
  // task_due.needs_approval): the task keeps its date, so say what happened -
  // otherwise the picked date just snaps back. offerUndo is defined below.
  const offerRef = useRef(null);
  const announceHeld = useCallback((rows, patch) => {
    if (!patch || !('dueOn' in patch) || !patch.dueOn) return;
    const held = rows.filter((r) => r?.dueAgreement === 'extension_requested' && r.dueProposal?.dueOn === patch.dueOn);
    if (!held.length) return;
    offerRef.current?.(
      held.length === 1 ? 'Due date change sent for approval' : `${held.length} due date changes sent for approval`,
      () => Promise.all(held.map((r) => api.withdrawTaskDue(r.id).then((t) => patchLocalTask(t.id, t)))).catch(() => {}),
    );
  }, [patchLocalTask]);

  // People a create could not add (Oct 21 2026): POST /tasks and a template's
  // use answer with droppedPeople - not in the Nexus directory, or no longer
  // with the company. Said in ONE notice that collects every name dropped
  // while it is up (a bulk duplicate is many creates), and the key is taken
  // off the row before it is stored.
  const [dropped, setDropped] = useState(null);   // [email]
  const droppedTimer = useRef(null);
  useEffect(() => () => clearTimeout(droppedTimer.current), []);
  const noteDropped = useCallback((emails) => {
    // The API sends [{email, reason, taskId}] (POST /tasks) - plain emails are
    // accepted too, so either shape reads as a list of addresses.
    const list = (Array.isArray(emails) ? emails : [])
      .map((e) => String((e && typeof e === 'object' ? e.email : e) || '').toLowerCase()).filter(Boolean);
    if (!list.length) return;
    clearTimeout(droppedTimer.current);
    setDropped((prev) => [...new Set([...(prev || []), ...list])]);
    droppedTimer.current = setTimeout(() => setDropped(null), 12000);
  }, []);
  const takeDropped = useCallback((row) => {
    if (!row || typeof row !== 'object' || !('droppedPeople' in row)) return row;
    const { droppedPeople, ...rest } = row;
    noteDropped(droppedPeople);
    return rest;
  }, [noteDropped]);

  // ── Task actions ─────────────────────────────────────────────────────────
  const createTask = useCallback(async (data) => {
    const created = takeDropped(await api.createTask(toBody(data)));
    setTasks((prev) => [created, ...prev]);
    return created;
  }, [takeDropped]);

  // The latest task list for the actions below, which need the row as it
  // was BEFORE an optimistic change without re-creating themselves on every
  // tasks change (updateTask's identity is a dependency all over the module).
  const tasksRef = useRef(tasks);
  useEffect(() => { tasksRef.current = tasks; }, [tasks]);

  // `quiet`: the caller says what went wrong itself (Move To's dialog), so
  // no alert here as well.
  const updateTask = useCallback(async (id, patch, { quiet = false } = {}) => {
    // Snapshot the fields this patch touches, so a refused save can put them
    // back. The delta refetch alone cannot: it only returns rows that CHANGED
    // on the server, and a refused row did not - the optimistic value stuck.
    const before = tasksRef.current.find((t) => t.id === id);
    const keys = Object.keys(patch || {});
    patchLocalTask(id, patch);                     // optimistic
    try {
      const saved = await api.updateTask(id, toBody(patch));
      setTasks((prev) => prev.map((t) => (t.id === id ? saved : t)));
      announceHeld([saved], patch);
      return saved;
    } catch (e) {
      if (before) {
        // Only a field still showing THIS change goes back - a later edit to
        // the same field (or a fresher server copy) is left alone.
        setTasks((prev) => prev.map((t) => {
          if (t.id !== id) return t;
          const back = {};
          for (const k of keys) if (t[k] === patch[k]) back[k] = before[k];
          return { ...t, ...back };
        }));
      }
      refetchTasks().catch(() => {});
      // Surfaces things like a dependency-gate rejection (blocked by an
      // unfinished FS/SS/FF/SF task) - the optimistic change above was just
      // put back, so silence here would look like nothing happened.
      if (!quiet && e?.status && e.status !== 401) alert(e.message || 'Could not update this task.');
      throw e;
    }
  }, [patchLocalTask, refetchTasks, announceHeld]);

  // Undo toast - one at a time; label + a run() that reverses the action.
  // A null run() is a plain notice (no Undo button) in the same spot.
  const [undo, setUndo] = useState(null);
  const undoTimer = useRef(null);
  const offerUndo = useCallback((label, run) => {
    clearTimeout(undoTimer.current);
    setUndo({ label, run });
    undoTimer.current = setTimeout(() => setUndo(null), 6000);
  }, []);
  useEffect(() => { offerRef.current = offerUndo; }, [offerUndo]);
  const runUndo = useCallback(() => {
    clearTimeout(undoTimer.current);
    setUndo((u) => { if (u?.run) u.run(); return null; });
  }, []);

  // Completing a task celebrates (unicorn + green sweep) and holds the store
  // update briefly so the row visibly turns green BEFORE it jumps to the
  // Completed bucket. Un-completing is instant and silent. The pending set
  // guards double-clicks during the hold. Recurring tasks complete like any
  // other - the SERVER spawns the next occurrence per the actual recurrence
  // rule (daily/weekly/monthly, until/count) and it arrives on the next
  // refetch. The old client-side "roll dueOn +7 days" shortcut fought that
  // generator, hardcoded weekly, and left no completion history (Aug 12).
  const pendingComplete = useRef(new Set());
  const toggleComplete = useCallback((t) => {
    if (t.completed) return updateTask(t.id, { completed: false });
    if (pendingComplete.current.has(t.id)) return undefined;
    pendingComplete.current.add(t.id);
    celebrateCompletion();
    return new Promise((resolve) => {
      setTimeout(() => {
        pendingComplete.current.delete(t.id);
        const recurring = t.status === 'recurring' || !!t.recurrence?.freq;
        offerUndo(
          recurring
            ? `Completed "${(t.title || '').slice(0, 40)}" - next occurrence created`
            : `Completed "${(t.title || '').slice(0, 40)}"`,
          () => updateTask(t.id, { completed: false }).catch(() => {}),
        );
        resolve(updateTask(t.id, { completed: true }).catch(() => {}));
      }, 550);
    });
  }, [updateTask, offerUndo]);
  const setStatus = useCallback((id, status) => updateTask(id, { status }), [updateTask]);

  // Move To... (Neil, Oct 22 2026): put a task under another one
  // (`parentTaskId`), or make it a top-level task ('' - it stays in its
  // project unless `projectId` says otherwise, filed into `sectionId`). The
  // server moves the whole subtree with it (PATCH parent_task_id), so the
  // other rows it changed - both parents, the subtasks - come in through a
  // delta refetch. A refusal is the caller's to show (no alert). Undo moves
  // it back with what the move changed on it: its place, section, team and
  // a subtask's "skip this occurrence" rule.
  const moveTask = useCallback(async (id, { parentTaskId = '', projectId, sectionId } = {}) => {
    const before = tasksRef.current.find((t) => t.id === id);
    const body = { parentTaskId: parentTaskId || '' };
    if (!parentTaskId) {
      if (projectId !== undefined) body.projectId = projectId || '';
      if (sectionId !== undefined) body.sectionId = sectionId || '';
    }
    const saved = await updateTask(id, body, { quiet: true });
    refetchTasks().catch(() => {});
    if (before) {
      const back = moveUndoBody(before);
      const target = parentTaskId ? tasksRef.current.find((t) => t.id === parentTaskId) : null;
      offerUndo(
        target ? `Moved under "${(target.title || '').slice(0, 40)}"` : 'Made a top-level task',
        () => updateTask(id, back).then(() => refetchTasks()).catch(() => {}),
      );
    }
    return saved;
  }, [updateTask, refetchTasks, offerUndo]);

  // Rows taken off screen optimistically go back if the server refuses the
  // delete - the delta refetch never returns a row the server did not change.
  const putBack = useCallback((rows) => {
    if (!rows.length) return;
    setTasks((prev) => {
      const have = new Set(prev.map((t) => t.id));
      const missing = rows.filter((r) => r && !have.has(r.id));
      return missing.length ? [...missing, ...prev] : prev;
    });
  }, []);

  // Undo of a delete. DELETE /tasks/{id} moves the task to Trash (task_trash.py),
  // so undo RESTORES it - same id, comments, attachments, history and the
  // subtasks trashed with it - instead of recreating a copy from its fields.
  // The restored row goes straight back on screen; the delta refetch brings
  // the subtasks. Returns { restored, failed } (counts).
  const restoreTasks = useCallback(async (ids) => {
    const results = await Promise.allSettled(ids.map((id) => api.restoreTask(id)));
    const rows = results.filter((r) => r.status === 'fulfilled' && r.value?.id).map((r) => r.value);
    if (rows.length) {
      const map = Object.fromEntries(rows.map((r) => [r.id, r]));
      setTasks((prev) => [...rows, ...prev.filter((t) => !map[t.id])]);
    }
    refetchTasks().catch(() => {});
    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length) {
      const why = failed[0].reason?.message || 'Try again from the Recycle Bin.';
      alert(failed.length === ids.length && ids.length === 1
        ? `Could not restore this task. ${why}`
        : `Could not restore ${failed.length} of ${ids.length} tasks. ${why}`);
    }
    return { restored: rows.length, failed: failed.length };
  }, [refetchTasks]);

  const deleteTask = useCallback(async (id) => {
    const gone = tasksRef.current.find((t) => t.id === id);
    setTasks((prev) => prev.filter((t) => t.id !== id));   // optimistic
    try {
      await api.deleteTask(id);
    } catch (e) {
      if (gone) putBack([gone]);
      refetchTasks().catch(() => {});
      throw e;
    }
    if (gone) offerUndo(`Deleted "${(gone.title || '').slice(0, 40)}"`, () => { restoreTasks([id]).catch(() => {}); });
  }, [refetchTasks, offerUndo, putBack, restoreTasks]);

  // Several tasks in one go (bulk bar, Data Quality): one batch, ONE toast,
  // and its Undo restores every one that was deleted. A refused delete puts
  // that row back and is counted, never silently dropped. There is no bulk
  // delete endpoint, so it is one DELETE per task, all at once.
  // Returns { deleted, failed, error } (counts; error = the first refusal).
  const deleteTasks = useCallback(async (ids) => {
    const list = [...new Set(ids)];
    if (!list.length) return { deleted: 0, failed: 0, error: null };
    const gone = Object.fromEntries(tasksRef.current.filter((t) => list.includes(t.id)).map((t) => [t.id, t]));
    const drop = new Set(list);
    setTasks((prev) => prev.filter((t) => !drop.has(t.id)));   // optimistic
    const results = await Promise.allSettled(list.map((id) => api.deleteTask(id)));
    const deletedIds = list.filter((_, i) => results[i].status === 'fulfilled');
    const failedIds = list.filter((_, i) => results[i].status === 'rejected');
    if (failedIds.length) {
      putBack(failedIds.map((id) => gone[id]).filter(Boolean));
      refetchTasks().catch(() => {});
    }
    if (deletedIds.length) {
      const label = deletedIds.length === 1
        ? `Deleted "${(gone[deletedIds[0]]?.title || '').slice(0, 40)}"`
        : `Deleted ${deletedIds.length} tasks`;
      offerUndo(label, () => { restoreTasks(deletedIds).catch(() => {}); });
    }
    const error = failedIds.length ? results[list.indexOf(failedIds[0])].reason : null;
    return { deleted: deletedIds.length, failed: failedIds.length, error };
  }, [refetchTasks, offerUndo, putBack, restoreTasks]);

  const bulkUpdate = useCallback(async (ids, patch) => {
    try {
      const rows = await api.bulkUpdateTasks(ids, toBody(patch));
      const map = Object.fromEntries(rows.map((r) => [r.id, r]));
      setTasks((prev) => prev.map((t) => map[t.id] || t));
      announceHeld(rows, patch);
      return rows;
    } catch (e) {
      if (e?.status && e.status !== 401) alert(e.message || 'Could not update these tasks.');
      throw e;
    }
  }, [announceHeld]);

  // Undo of a due-date move (the Calendar drag, Oct 22 2026): the server
  // takes the move out - no extension for the trip back, no second bell.
  const undoDueChange = useCallback(async (id, at) => {
    try {
      const saved = await api.undoTaskDue(id, at);
      if (saved?.id) patchLocalTask(saved.id, saved);
      return saved;
    } catch (e) {
      refetchTasks().catch(() => {});
      if (e?.status && e.status !== 401) alert(e.message || 'Could not undo that change.');
      throw e;
    }
  }, [patchLocalTask, refetchTasks]);

  // The batch bar's Dates action (Oct 22 2026): the server moves each task
  // from its own date, so there is nothing to apply optimistically - the
  // rows it answers with land in the store. Answers the server's counts.
  const bulkDates = useCallback(async (ids, dates) => {
    try {
      const r = await api.bulkTaskDates(ids, dates);
      const map = Object.fromEntries((r?.tasks || []).map((t) => [t.id, t]));
      setTasks((prev) => prev.map((t) => map[t.id] || t));
      return r;
    } catch (e) {
      if (e?.status && e.status !== 401) alert(e.message || 'Could not change the dates.');
      throw e;
    }
  }, []);

  // Comments (loaded on demand, cached)
  const getComments = useCallback(async (taskId) => {
    const rows = await api.getTaskComments(taskId).catch(() => []);
    // Oldest first. The API orders them now, but every consumer here (the
    // drawer's Comments tab, Overview's "latest 3") reads position as time -
    // Overview literally slices the tail - so sort on arrival rather than
    // trusting each caller to remember. A comment with no createdAt sorts last,
    // where a just-written one belongs, rather than to the top of the thread.
    const at = (c) => String(c?.createdAt || '￿');
    const sorted = [...rows].sort((a, b) => at(a).localeCompare(at(b)));
    commentCache.current[taskId] = sorted;
    return sorted;
  }, []);
  // `extra`: { parent_id } for a reply in a thread, { assignee_email } to make
  // the comment an action item (Oct 2026).
  const addComment = useCallback(async (taskId, body, extra = {}) => {
    const c = await api.addTaskComment(taskId, { body, ...extra });
    commentCache.current[taskId] = [...(commentCache.current[taskId] || []), c];
    refetchTasks().catch(() => {});
    return c;
  }, [refetchTasks]);

  // ── Generic collection helpers ───────────────────────────────────────────
  const mk = (createFn, setFn) => async (data) => { const r = await createFn(toBody(data)); setFn((p) => [r, ...p]); return r; };
  const mkUpd = (updFn, setFn) => async (id, patch) => { const r = await updFn(id, toBody(patch)); setFn((p) => p.map((x) => (x.id === id ? r : x))); return r; };
  const mkDel = (delFn, setFn) => async (id) => { await delFn(id); setFn((p) => p.filter((x) => x.id !== id)); };

  // Adding/removing a project from a portfolio tags the project's own
  // portfolioId server-side too (see backend update_portfolio) - mirror that
  // here so ProjectsView's portfolio badge (which reads project.portfolioId,
  // not the portfolio's projectIds) updates without a full refetch.
  const updatePortfolio = async (id, patch) => {
    const r = await api.updateTaskPortfolio(id, toBody(patch));
    setPortfolios((p) => p.map((x) => (x.id === id ? r : x)));
    if (patch.projectIds) {
      const nextIds = new Set(r.projectIds || []);
      setProjects((prev) => prev.map((proj) => {
        if (nextIds.has(proj.id)) return proj.portfolioId === id ? proj : { ...proj, portfolioId: id };
        if (proj.portfolioId === id) return { ...proj, portfolioId: null };
        return proj;
      }));
    }
    return r;
  };

  // Batch move between portfolios. The server hands back EVERY portfolio, not
  // just the two involved: a project can only sit in one, so a move rewrites
  // the source's list as well as the destination's, and refreshing one of them
  // leaves the other showing a project it no longer holds. The projects' own
  // portfolioId is mirrored here for the same reason updatePortfolio does it -
  // ProjectsView's badge reads that field, not the portfolio's list.
  const toggleBookmark = async (projectId) => {
    // Read through a ref, not the closed-over `bookmarks` and not from inside
    // the updater. The closure was the original bug (frozen in a useMemo, so
    // the toggle only ever added); an updater that writes to an outer variable
    // would fix that but is impure, and StrictMode double-invokes updaters in
    // development, which is a trap to leave lying around. A ref is current and
    // the updater stays pure.
    const on = bookmarksRef.current.has(projectId);
    setBookmarks((prev) => {
      const n = new Set(prev);
      // Optimistic: the star is a one-click toggle and waiting on the round
      // trip makes it feel broken. Reverted below if the write fails.
      on ? n.delete(projectId) : n.add(projectId);
      return n;
    });
    try {
      if (on) await api.removeTaskBookmark(projectId);
      else await api.addTaskBookmark(projectId);
    } catch (e) {
      setBookmarks((prev) => { const n = new Set(prev); on ? n.add(projectId) : n.delete(projectId); return n; });
      throw e;
    }
  };

  const moveProjectsToPortfolio = async (projectIds, portfolioId) => {
    const r = await api.moveProjectsToPortfolio(toBody({ projectIds, portfolioId: portfolioId || '' }));
    setPortfolios(r.portfolios || []);
    const movedSet = new Set(projectIds);
    setProjects((prev) => prev.map((proj) => (
      movedSet.has(proj.id) ? { ...proj, portfolioId: portfolioId || null } : proj
    )));
    return r;
  };

  const applyProjectFollowers = (id, r) => {
    if (!r) return r;
    setProjects((prev) => prev.map((x) => {
      if (x.id !== id) return x;
      return r.name ? r : { ...x, followerIds: Array.isArray(r.followerIds) ? r.followerIds : [] };
    }));
    return r;
  };

  const actions = useMemo(() => ({
    createProject: mk(api.createTaskProject, setProjects),
    updateProject: mkUpd(api.updateTaskProject, setProjects),
    // One shared chart at a time (upsert / remove by id). The server merges
    // under a row lock, so two editors sharing at once both land. Not through
    // toBody: a chart is data, its keys stay as the Dashboard wrote them.
    shareProjectChart: async (id, chart) => { const r = await api.putTaskProjectChart(id, chart.id, chart); setProjects((p) => p.map((x) => (x.id === id ? r : x))); return r; },
    unshareProjectChart: async (id, chartId) => { const r = await api.deleteTaskProjectChart(id, chartId); setProjects((p) => p.map((x) => (x.id === id ? r : x))); return r; },
    // Follow a project (Oct 22 2026). Each answers with the project; an
    // unfollow from a project you can no longer see answers with only its
    // followers, so just those are merged in.
    followProject: async (id) => applyProjectFollowers(id, await api.followTaskProject(id)),
    unfollowProject: async (id) => applyProjectFollowers(id, await api.unfollowTaskProject(id)),
    addProjectFollower: async (id, email) => applyProjectFollowers(id, await api.addTaskProjectFollower(id, email)),
    removeProjectFollower: async (id, email) => applyProjectFollowers(id, await api.removeTaskProjectFollower(id, email)),
    // Not mkDel: a project delete bins its tasks server-side too, so the
    // whole core has to be refetched rather than just dropping the project
    // from its own list.
    deleteProject: async (id) => {
      const r = await api.deleteTaskProject(id);
      setProjects((p) => p.filter((x) => x.id !== id));
      loadCore();
      return r;
    },
    createPortfolio: mk(api.createTaskPortfolio, setPortfolios),
    updatePortfolio,
    deletePortfolio: mkDel(api.deleteTaskPortfolio, setPortfolios),
    moveProjectsToPortfolio,
    createTeam: mk(api.createTaskTeam, setTeams),
    updateTeam: mkUpd(api.updateTaskTeam, setTeams),
    deleteTeam: mkDel(api.deleteTaskTeam, setTeams),
    createTicket: mk(api.createTaskTicket, setTickets),
    updateTicket: mkUpd(api.updateTaskTicket, setTickets),
    deleteTicket: mkDel(api.deleteTaskTicket, setTickets),
    createTicketComponent: mk(api.addTicketComponent, setTicketComponents),
    deleteTicketComponent: mkDel(api.deleteTicketComponent, setTicketComponents),
    // link/escalate return the updated ticket(s); refresh the whole list so the
    // inverse link on the other ticket (and any priority bump) is reflected too.
    // The link itself is saved; a failed refetch keeps the list we have
    // (it used to replace it with [], blanking every ticket on screen).
    addTicketLink: async (id, targetId, type) => { const r = await api.addTicketLink(id, { ticket_id: targetId, type }); await reloadTicketsInto(setTickets); return r; },
    removeTicketLink: async (id, targetId) => { const r = await api.removeTicketLink(id, targetId); await reloadTicketsInto(setTickets); return r; },
    escalateTicket: async (id) => { const r = await api.escalateTicket(id); setTickets((p) => p.map((x) => (x.id === id ? r : x))); return r; },
    // The ticket list alone (Oct 2026 review): an approval decision or a
    // deleted comment changes one ticket, and `refresh` (loadCore) re-pulled
    // the whole task workspace for it.
    // Same stale guard as refreshTickets: a local ticket write that lands
    // while this fetch is on the wire wins, and the older answer is dropped.
    reloadTickets: async () => {
      const gen = ticketGenRef.current;
      let rows;
      try { rows = await api.getTaskTickets(); } catch { return; }
      if (gen !== ticketGenRef.current || !Array.isArray(rows)) return;
      setTickets(rows);
    },
    // A task made from a ticket (Oct 14 2026): the server links both sides in
    // one save and hands both back.
    createTaskFromTicket: async (id) => {
      // The create underneath is POST /tasks's, so a dropped person is said
      // here too, wherever the server puts the list.
      const top = takeDropped(await api.createTaskFromTicket(id));
      const r = { ...top, task: takeDropped(top.task) };
      setTasks((p) => [r.task, ...p.filter((x) => x.id !== r.task.id)]);
      setTickets((p) => p.map((x) => (x.id === id ? r.ticket : x)));
      return r;
    },
    createSavedView: mk(api.createTaskSavedView, setSavedViews),
    deleteSavedView: mkDel(api.deleteTaskSavedView, setSavedViews),
    createTicketView: mk(api.createTicketView, setTicketViews),
    deleteTicketView: mkDel(api.deleteTicketView, setTicketViews),
    createRule: mk(api.createTaskAutomationRule, setRules),
    updateRule: mkUpd(api.updateTaskAutomationRule, setRules),
    deleteRule: mkDel(api.deleteTaskAutomationRule, setRules),
    createTemplate: mk(api.createTaskTemplate, setTemplates),
    deleteTemplate: mkDel(api.deleteTaskTemplate, setTemplates),
    saveTaskAsTemplate: async (taskId, data) => {
      const r = await api.saveTaskAsTemplate(taskId, toBody(data));
      setTemplates((p) => [r, ...p]);
      return r;
    },
    // The main task comes back; its subtasks arrive with the refetch.
    startFromTemplate: async (id, data) => {
      const r = takeDropped(await api.useTaskTemplate(id, toBody(data)));
      setTasks((p) => [r, ...p.filter((x) => x.id !== r.id)]);
      refetchTasks().catch(() => {});
      return r;
    },
    // Project templates. Saving one is a pure read of the project, so nothing
    // else on screen changes; USING one mints a project plus its sections and
    // tasks, so the core is reloaded rather than patched - the same reason
    // deleteProject reloads instead of splicing one row out.
    createProjectTemplate: mk(api.createTaskProjectTemplate, setProjectTemplates),
    updateProjectTemplate: mkUpd(api.updateTaskProjectTemplate, setProjectTemplates),
    deleteProjectTemplate: mkDel(api.deleteTaskProjectTemplate, setProjectTemplates),
    recaptureProjectTemplate: mkUpd(api.recaptureTaskProjectTemplate, setProjectTemplates),
    // Named createProjectFrom..., not use...: a `useX` identifier reads as a
    // React hook to the rules-of-hooks lint (and to anyone skimming a call
    // site), and this is an ordinary async action.
    createProjectFromTemplate: async (id, data) => {
      const project = await api.useTaskProjectTemplate(id, toBody(data || {}));
      setProjects((p) => [project, ...p]);
      loadCore();
      return project;
    },
    duplicateProject: async (id, data) => {
      const project = await api.duplicateTaskProject(id, toBody(data || {}));
      setProjects((p) => [project, ...p]);
      loadCore();
      return project;
    },
    previewProjectTemplate: (id, params) => api.getTaskProjectTemplatePreview(id, params),
    createCustomField: mk(api.createTaskCustomField, setCustomFields),
    // Editing was never wired up, so fixing a field's name meant deleting and
    // recreating it - and task values are keyed by field id, so every value
    // already captured was orphaned by the rename.
    updateCustomField: mkUpd(api.updateTaskCustomField, setCustomFields),
    deleteCustomField: mkDel(api.deleteTaskCustomField, setCustomFields),
    // A merge deletes rows and rewrites the survivor's scope, so the list is
    // re-read rather than patched in place.
    dedupeCustomStatuses: async () => { const r = await api.dedupeTaskCustomStatuses(); await loadCore(); return r; },
    createSection: mk(api.createTaskSection, setSections),
    updateSection: mkUpd(api.updateTaskSection, setSections),
    // The server releases the section's tasks; mirror that here so they drop
    // into "No Section" without waiting for the next refresh.
    deleteSection: async (id) => {
      await api.deleteTaskSection(id);
      setSections((p) => p.filter((x) => x.id !== id));
      setTasks((prev) => prev.map((t) => (t.sectionId === id ? { ...t, sectionId: '' } : t)));
    },
    createCustomStatus: mk(api.createTaskCustomStatus, setCustomStatuses),
    updateCustomStatus: mkUpd(api.updateTaskCustomStatus, setCustomStatuses),
    deleteCustomStatus: mkDel(api.deleteTaskCustomStatus, setCustomStatuses),
    raiseMemberRequest: mk(api.createTaskMemberRequest, setMemberRequests),
    decideMemberRequest: async (id, status) => {
      const r = await api.decideTaskMemberRequest(id, status);
      setMemberRequests((p) => p.map((x) => (x.id === id ? r : x)));
      loadCore();
      return r;
    },
    createIntakeForm: mk(api.createTaskIntakeForm, setIntakeForms),
    deleteIntakeForm: mkDel(api.deleteTaskIntakeForm, setIntakeForms),
    createChangelog: mk(api.createTaskChangelog, setChangelog),
    updateChangelog: mkUpd(api.updateTaskChangelog, setChangelog),
    deleteChangelog: mkDel(api.deleteTaskChangelog, setChangelog),
    getChangelogComments: (id) => api.getTaskChangelogComments(id),
    addChangelogComment: (id, body) => api.addTaskChangelogComment(id, { body }),
  }), [loadCore, setTickets]);

  const markNotificationRead = useCallback(async (id) => {
    setNotifications((p) => p.map((n) => (n.id === id ? { ...n, read: true } : n)));
    await api.markTaskNotificationRead(id).catch(() => {});
  }, []);
  const markAllNotificationsRead = useCallback(async () => {
    setNotifications((p) => p.map((n) => ({ ...n, read: true })));
    await api.markAllTaskNotificationsRead().catch(() => {});
  }, []);

  // Merged status metadata + order (built-in + custom), recomputed when custom
  // statuses change - the single source every status surface should read from.
  const statusMeta = useMemo(() => buildStatusMeta(customStatuses), [customStatuses]);
  const statusOrder = useMemo(() => buildStatusOrder(customStatuses), [customStatuses]);
  // The board columns / grouping order for one project. Without this a status
  // invented for one project became a column on every board in the workspace.
  const statusOrderFor = useCallback(
    (projectId) => buildStatusOrder(statusesForProject(customStatuses, projectId)),
    [customStatuses],
  );

  const value = {
    loading, ticketsLoaded, myEmail, nameOf,
    tasks, projects, portfolios, teams, tickets, ticketComponents, savedViews, ticketViews, rules, templates,
    projectTemplates,
    customFields, customStatuses, statusMeta, statusOrder, statusOrderFor, notifications, memberRequests, intakeForms, changelog,
    sections,
    taskById, projectById, portfolioById, teamById, projectName, teamName,
    getComments, addComment, commentCache: commentCache.current,
    createTask, updateTask, deleteTask, deleteTasks, restoreTasks, bulkUpdate, toggleComplete, setStatus,
    moveTask,
    bulkDates, undoDueChange,
    // Puts a task the server just returned into the store as-is (the due-date
    // confirm/propose/respond calls answer with the updated task).
    applyServerTask: (saved) => { if (saved?.id) patchLocalTask(saved.id, saved); },
    // Import from CSV / Excel (Oct 22 2026, ImportTasksModal). A dry run only
    // reports. A real one can mint hundreds of tasks plus sections and select
    // options, so the workspace is re-read rather than patched row by row.
    importTasks: async (data) => {
      const r = await api.importTasks(data);
      if (!data?.dry_run) {
        await Promise.all([loadCore(), loadSections()]).catch(() => {});
      }
      return r;
    },
    // Timer (Oct 2026). Starting on a second task stops the first; the
    // stopped task comes back with its new total and lands in the store too.
    runningTimer,
    startTimer: async (taskId) => {
      const r = await api.startTaskTimer(taskId);
      if (r?.stopped?.task) patchLocalTask(r.stopped.task.id, r.stopped.task);
      setRunningTimer(r ? { entry: r.entry, task: r.task } : null);
      return r;
    },
    stopTimer: async (data = {}) => {
      const r = await api.stopTaskTimer(data);
      if (r?.task) patchLocalTask(r.task.id, r.task);
      setRunningTimer(null);
      return r;
    },
    markNotificationRead, markAllNotificationsRead, refresh: loadCore,
    offerUndo,
    // A one-line notice in the undo toast's place, with no Undo (Oct 22 2026).
    notify: (label) => offerUndo(label, null),
    // Bookmarks live HERE, not in `actions` below. That object is
    // useMemo'd on [loadCore] - i.e. built once - so anything stateful put
    // inside it is frozen at its first value: the star never filled in, and
    // toggleBookmark kept reading an empty Set and so could only ever add.
    // `value` is rebuilt every render, which is what state needs.
    bookmarks, toggleBookmark,
    // Personal teams. Both refetch: approval changes who can SEE the team and
    // where its members' project access comes from, which is more than one
    // row's worth of change.
    requestTeamApproval: async (id) => { const r = await api.requestTeamApproval(id); await loadCore(); return r; },
    decideTeamApproval: async (id, decision) => { const r = await api.decideTeamApproval(id, decision); await loadCore(); return r; },
    ...actions,
  };
  return (
    <Ctx.Provider value={value}>
      {children}
      {/* People a create could not add - above the undo toast when both show. */}
      {dropped?.length > 0 && (
        <div role="status" data-testid="dropped-people" style={{
          position: 'fixed', left: '50%', bottom: undo ? 84 : 24, transform: 'translateX(-50%)', zIndex: 6000,
          display: 'flex', alignItems: 'center', gap: 12, background: '#1f2733', color: '#fff',
          borderRadius: 10, padding: '11px 16px', boxShadow: '0 12px 32px rgba(0,0,0,0.35)',
          fontFamily: "'Inter', sans-serif", fontSize: 13, maxWidth: 'min(92vw, 560px)',
        }}>
          <span>Not added: {dropped.map((e) => nameOf(e) || e).join(', ')} - not in the Nexus directory or no longer with the company.</span>
          <button type="button" onClick={() => { clearTimeout(droppedTimer.current); setDropped(null); }} aria-label="Dismiss" title="Dismiss"
            style={{ border: 'none', background: 'none', color: '#cbd5e1', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: 2, flexShrink: 0, fontFamily: 'inherit' }}>×</button>
        </div>
      )}
      {/* Undo toast - completes, deletes, and recurring rolls offer a 6s rescue. */}
      {undo && (
        <div style={{
          position: 'fixed', left: '50%', bottom: 24, transform: 'translateX(-50%)', zIndex: 6000,
          display: 'flex', alignItems: 'center', gap: 14, background: '#1f2733', color: '#fff',
          borderRadius: 10, padding: '11px 16px', boxShadow: '0 12px 32px rgba(0,0,0,0.35)',
          fontFamily: "'Inter', sans-serif", fontSize: 13, maxWidth: 'min(92vw, 520px)',
        }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{undo.label}</span>
          {undo.run && <button onClick={runUndo} style={{ border: 'none', background: 'none', color: '#6ea8ff', fontWeight: 700, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0 }}>Undo</button>}
        </div>
      )}
    </Ctx.Provider>
  );
}

export function useTasks() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useTasks must be used within TasksProvider');
  return ctx;
}

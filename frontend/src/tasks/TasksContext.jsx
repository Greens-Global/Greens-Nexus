/* eslint-disable react-hooks/refs -- the context value intentionally exposes a stable comment-cache ref's current map; a deliberate ref read the React-Compiler rule flags */
// Task Module - data layer. Replaces the export's React-Query + Zustand +
// NexusTaskStore with a single Nexus-style context: loads from the FastAPI
// backend, applies optimistic updates, and refetches on a task_events realtime
// ping (with a poll fallback), mirroring RequisitionContext.
import { createContext, useContext, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { supabase } from '../lib/supabase';
import { useRole } from '../contexts/RoleContext';
import { useNameResolver } from '../lib/useNameResolver';
import { STATUS_META, STATUS_ORDER, NX } from './theme';
import { celebrateCompletion } from './celebrate';
import { pollWhileVisible } from '../lib/pollWhileVisible';
import { loadTaskData, taskSnapshot, rememberTaskData, FIRST_PAINT } from './taskStore';

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
  teamId: 'team_id', parentTaskId: 'parent_task_id', subtaskIds: 'subtask_ids',
  blockedByIds: 'blocked_by_ids', blockingIds: 'blocking_ids', dependencyTypes: 'dependency_types',
  customFieldValues: 'custom_field_values', startOn: 'start_on', dueOn: 'due_on',
  estimateHours: 'estimate_hours', actualHours: 'actual_hours', isMilestone: 'is_milestone',
  approvalStatus: 'approval_status', ownerId: 'owner_email', memberIds: 'member_emails',
  portfolioId: 'portfolio_id', projectIds: 'project_ids', targetProjectId: 'target_project_id',
  requesterId: 'requester_email', linkedTaskId: 'linked_task_id', slaDueOn: 'sla_due_on', typeFields: 'type_fields',
  companyId: 'company_id', hrDepartmentId: 'hr_department_id', hrDepartmentName: 'hr_department_name',
  watcherIds: 'watcher_emails', csatRating: 'csat_rating', csatComment: 'csat_comment',
  taskIds: 'task_ids', subtaskTitles: 'subtask_titles',
  // Project-template options (save-as-template / use / duplicate) - see
  // backend ProjectTemplateBody, UseTemplateBody and DuplicateProjectBody.
  includeTasks: 'include_tasks', includeSubtasks: 'include_subtasks',
  includeCompleted: 'include_completed', includeAssignees: 'include_assignees',
  includeMembers: 'include_members', includeTeams: 'include_teams',
  includeDates: 'include_dates', resetStatus: 'reset_status',
};
function toBody(patch) {
  const out = {};
  for (const [k, v] of Object.entries(patch || {})) out[CAMEL_TO_SNAKE[k] || k] = v;
  return out;
}

export function TasksProvider({ children }) {
  const { myEmail } = useRole();
  const nameOf = useNameResolver();

  // Seed from the module-scope cache (taskStore): a prefetch at boot, or an
  // earlier visit, means this mount opens with the data already in hand and
  // never shows a spinner - the refresh below then streams over the top.
  const seed = taskSnapshot();
  const [tasks, setTasks] = useState(seed?.tasks?.tasks || []);
  const [projects, setProjects] = useState(seed?.projects || []);
  const [portfolios, setPortfolios] = useState(seed?.portfolios || []);
  const [teams, setTeams] = useState(seed?.teams || []);
  const [tickets, setTickets] = useState(seed?.tickets || []);
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
  const commentCache = useRef({});   // taskId -> comment[]
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
      tickets: setTickets, ticketComponents: setTicketComponents,
      savedViews: setSavedViews, ticketViews: setTicketViews, rules: setRules,
      templates: setTemplates, projectTemplates: setProjectTemplates,
      customFields: setCustomFields, customStatuses: setCustomStatuses,
      memberRequests: setMemberRequests, intakeForms: setIntakeForms, changelog: setChangelog,
    };
  }

  // The collections stream in one by one rather than landing together, so the
  // screen paints as soon as the three the first view needs are in instead of
  // waiting on the slowest of fifteen calls.
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

  useEffect(() => { loadCore(); loadNotifications(); }, [loadCore, loadNotifications]);

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
      for (const id of deletedIds || []) byId.delete(id);
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

  // ── Task actions ─────────────────────────────────────────────────────────
  const createTask = useCallback(async (data) => {
    const created = await api.createTask(toBody(data));
    setTasks((prev) => [created, ...prev]);
    return created;
  }, []);

  const updateTask = useCallback(async (id, patch) => {
    patchLocalTask(id, patch);                     // optimistic
    try {
      const saved = await api.updateTask(id, toBody(patch));
      setTasks((prev) => prev.map((t) => (t.id === id ? saved : t)));
      return saved;
    } catch (e) {
      refetchTasks().catch(() => {});
      // Surfaces things like a dependency-gate rejection (blocked by an
      // unfinished FS/SS/FF/SF task) - the optimistic change above just got
      // reverted by the refetch, so silence here would look like nothing happened.
      if (e?.status && e.status !== 401) alert(e.message || 'Could not update this task.');
      throw e;
    }
  }, [patchLocalTask, refetchTasks]);

  // Undo toast - one at a time; label + a run() that reverses the action.
  const [undo, setUndo] = useState(null);
  const undoTimer = useRef(null);
  const offerUndo = useCallback((label, run) => {
    clearTimeout(undoTimer.current);
    setUndo({ label, run });
    undoTimer.current = setTimeout(() => setUndo(null), 6000);
  }, []);
  const runUndo = useCallback(() => {
    clearTimeout(undoTimer.current);
    setUndo((u) => { if (u) u.run(); return null; });
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

  const deleteTask = useCallback(async (id) => {
    const gone = tasks.find((t) => t.id === id);
    setTasks((prev) => prev.filter((t) => t.id !== id));   // optimistic
    try { await api.deleteTask(id); } catch (e) { refetchTasks().catch(() => {}); throw e; }
    // Undo recreates the task from its main fields (a fresh id - comments and
    // subtask links don't survive a hard delete; the fields are the rescue).
    if (gone) {
      offerUndo(`Deleted "${(gone.title || '').slice(0, 40)}"`, () => createTask({
        title: gone.title, type: gone.type || 'task', description: gone.description || '',
        status: gone.status || 'not_started', priority: gone.priority || 'medium',
        projectId: gone.projectId || '', teamId: gone.teamId || '',
        assigneeId: gone.assigneeId || '', followerIds: gone.followerIds || [],
        dueOn: gone.dueOn || '', startOn: gone.startOn || '', tags: gone.tags || [],
        estimateHours: gone.estimateHours ?? null, isMilestone: !!gone.isMilestone,
        customFieldValues: gone.customFieldValues || {},
      }).catch(() => {}));
    }
  }, [refetchTasks, tasks, offerUndo, createTask]);

  const bulkUpdate = useCallback(async (ids, patch) => {
    try {
      const rows = await api.bulkUpdateTasks(ids, toBody(patch));
      const map = Object.fromEntries(rows.map((r) => [r.id, r]));
      setTasks((prev) => prev.map((t) => map[t.id] || t));
      return rows;
    } catch (e) {
      if (e?.status && e.status !== 401) alert(e.message || 'Could not update these tasks.');
      throw e;
    }
  }, []);

  // Comments (loaded on demand, cached)
  const getComments = useCallback(async (taskId) => {
    const rows = await api.getTaskComments(taskId).catch(() => []);
    commentCache.current[taskId] = rows;
    return rows;
  }, []);
  const addComment = useCallback(async (taskId, body) => {
    const c = await api.addTaskComment(taskId, { body });
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

  const actions = useMemo(() => ({
    createProject: mk(api.createTaskProject, setProjects),
    updateProject: mkUpd(api.updateTaskProject, setProjects),
    // Not mkDel: a project delete now removes its tasks and teams server-side
    // too (and optionally the Asana project), so the whole core has to be
    // refetched rather than just dropping the project from its own list.
    deleteProject: async (id, { deleteInAsana = false } = {}) => {
      const r = await api.deleteTaskProject(id, deleteInAsana);
      setProjects((p) => p.filter((x) => x.id !== id));
      loadCore();
      return r;
    },
    createPortfolio: mk(api.createTaskPortfolio, setPortfolios),
    updatePortfolio,
    deletePortfolio: mkDel(api.deleteTaskPortfolio, setPortfolios),
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
    addTicketLink: async (id, targetId, type) => { const r = await api.addTicketLink(id, { ticket_id: targetId, type }); setTickets(await api.getTaskTickets().catch(() => [])); return r; },
    removeTicketLink: async (id, targetId) => { const r = await api.removeTicketLink(id, targetId); setTickets(await api.getTaskTickets().catch(() => [])); return r; },
    escalateTicket: async (id) => { const r = await api.escalateTicket(id); setTickets((p) => p.map((x) => (x.id === id ? r : x))); return r; },
    createSavedView: mk(api.createTaskSavedView, setSavedViews),
    deleteSavedView: mkDel(api.deleteTaskSavedView, setSavedViews),
    createTicketView: mk(api.createTicketView, setTicketViews),
    deleteTicketView: mkDel(api.deleteTicketView, setTicketViews),
    createRule: mk(api.createTaskAutomationRule, setRules),
    updateRule: mkUpd(api.updateTaskAutomationRule, setRules),
    deleteRule: mkDel(api.deleteTaskAutomationRule, setRules),
    createTemplate: mk(api.createTaskTemplate, setTemplates),
    deleteTemplate: mkDel(api.deleteTaskTemplate, setTemplates),
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
  }), [loadCore]);

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
    loading, myEmail, nameOf,
    tasks, projects, portfolios, teams, tickets, ticketComponents, savedViews, ticketViews, rules, templates,
    projectTemplates,
    customFields, customStatuses, statusMeta, statusOrder, statusOrderFor, notifications, memberRequests, intakeForms, changelog,
    taskById, projectById, portfolioById, teamById, projectName, teamName,
    getComments, addComment, commentCache: commentCache.current,
    createTask, updateTask, deleteTask, bulkUpdate, toggleComplete, setStatus,
    markNotificationRead, markAllNotificationsRead, refresh: loadCore,
    ...actions,
  };
  return (
    <Ctx.Provider value={value}>
      {children}
      {/* Undo toast - completes, deletes, and recurring rolls offer a 6s rescue. */}
      {undo && (
        <div style={{
          position: 'fixed', left: '50%', bottom: 24, transform: 'translateX(-50%)', zIndex: 6000,
          display: 'flex', alignItems: 'center', gap: 14, background: '#1f2733', color: '#fff',
          borderRadius: 10, padding: '11px 16px', boxShadow: '0 12px 32px rgba(0,0,0,0.35)',
          fontFamily: "'Inter', sans-serif", fontSize: 13, maxWidth: 'min(92vw, 520px)',
        }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{undo.label}</span>
          <button onClick={runUndo} style={{ border: 'none', background: 'none', color: '#6ea8ff', fontWeight: 700, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0 }}>Undo</button>
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

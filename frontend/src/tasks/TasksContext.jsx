// Task Module — data layer. Replaces the export's React-Query + Zustand +
// NexusTaskStore with a single Nexus-style context: loads from the FastAPI
// backend, applies optimistic updates, and refetches on a task_events realtime
// ping (with a poll fallback), mirroring RequisitionContext.
import { createContext, useContext, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { supabase } from '../lib/supabase';
import { useRole } from '../contexts/RoleContext';
import { useNameResolver } from '../lib/useNameResolver';
import { STATUS_META, STATUS_ORDER, NX } from './theme';

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

// camelCase (frontend) → snake_case (API body). The backend serialises replies
// back to camelCase, so we only map on the way out.
const CAMEL_TO_SNAKE = {
  assigneeId: 'assignee_email', followerIds: 'follower_emails', likedByIds: 'liked_by_emails',
  accessLevel: 'access_level', projectId: 'project_id', sectionId: 'section_id',
  departmentId: 'department_id', departmentIds: 'department_ids', parentTaskId: 'parent_task_id', subtaskIds: 'subtask_ids',
  blockedByIds: 'blocked_by_ids', blockingIds: 'blocking_ids', dependencyTypes: 'dependency_types',
  customFieldValues: 'custom_field_values', startOn: 'start_on', dueOn: 'due_on',
  estimateHours: 'estimate_hours', actualHours: 'actual_hours', isMilestone: 'is_milestone',
  approvalStatus: 'approval_status', ownerId: 'owner_email', memberIds: 'member_emails',
  portfolioId: 'portfolio_id', projectIds: 'project_ids', targetProjectId: 'target_project_id',
  requesterId: 'requester_email', linkedTaskId: 'linked_task_id', slaDueOn: 'sla_due_on', typeFields: 'type_fields',
  companyId: 'company_id', hrDepartmentId: 'hr_department_id',
  watcherIds: 'watcher_emails', csatRating: 'csat_rating', csatComment: 'csat_comment',
  taskIds: 'task_ids', subtaskTitles: 'subtask_titles',
};
function toBody(patch) {
  const out = {};
  for (const [k, v] of Object.entries(patch || {})) out[CAMEL_TO_SNAKE[k] || k] = v;
  return out;
}

export function TasksProvider({ children }) {
  const { myEmail } = useRole();
  const nameOf = useNameResolver();

  const [tasks, setTasks] = useState([]);
  const [projects, setProjects] = useState([]);
  const [portfolios, setPortfolios] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [tickets, setTickets] = useState([]);
  const [ticketComponents, setTicketComponents] = useState([]);
  const [savedViews, setSavedViews] = useState([]);
  const [ticketViews, setTicketViews] = useState([]);
  const [rules, setRules] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [customFields, setCustomFields] = useState([]);
  const [customStatuses, setCustomStatuses] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [memberRequests, setMemberRequests] = useState([]);
  const [intakeForms, setIntakeForms] = useState([]);
  const [changelog, setChangelog] = useState([]);
  const [loading, setLoading] = useState(true);
  const commentCache = useRef({});   // taskId -> comment[]

  const loadCore = useCallback(async () => {
    const [t, p, pf, d, tk, tc, sv, r, tpl, cf, cs, mr, intk, chl, tvw] = await Promise.all([
      api.getTasks().catch(() => []),
      api.getTaskProjects().catch(() => []),
      api.getTaskPortfolios().catch(() => []),
      api.getTaskDepartments().catch(() => []),
      api.getTaskTickets().catch(() => []),
      api.getTicketComponents().catch(() => []),
      api.getTaskSavedViews().catch(() => []),
      api.getTaskAutomationRules().catch(() => []),
      api.getTaskTemplates().catch(() => []),
      api.getTaskCustomFields().catch(() => []),
      api.getTaskCustomStatuses().catch(() => []),
      api.getTaskMemberRequests().catch(() => []),
      api.getTaskIntakeForms().catch(() => []),
      api.getTaskChangelog().catch(() => []),
      api.getTicketViews().catch(() => []),
    ]);
    setTasks(t || []); setProjects(p || []); setPortfolios(pf || []); setDepartments(d || []);
    setTickets(tk || []); setTicketComponents(tc || []); setSavedViews(sv || []); setRules(r || []); setTemplates(tpl || []);
    setCustomFields(cf || []); setCustomStatuses(cs || []); setMemberRequests(mr || []);
    setIntakeForms(intk || []); setChangelog(chl || []); setTicketViews(tvw || []);
    setLoading(false);
  }, []);

  const loadNotifications = useCallback(async () => {
    setNotifications(await api.getTaskNotifications().catch(() => []));
  }, []);

  useEffect(() => { loadCore(); loadNotifications(); }, [loadCore, loadNotifications]);

  // Realtime: refetch tasks (+notifications) on a task_events ping; 45s poll fallback.
  const refetchTasks = useCallback(async () => {
    setTasks(await api.getTasks().catch((e) => { throw e; }));
  }, []);
  useEffect(() => {
    let timer = null;
    const debounced = () => { clearTimeout(timer); timer = setTimeout(() => { refetchTasks(); loadNotifications(); }, 400); };
    const iv = setInterval(() => { refetchTasks().catch(() => {}); }, 45000);
    let channel = null;
    if (supabase) {
      channel = supabase.channel('task_event_pings')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'task_events' }, debounced)
        .subscribe();
    }
    return () => { clearInterval(iv); clearTimeout(timer); if (channel) supabase?.removeChannel(channel); };
  }, [refetchTasks, loadNotifications]);

  // ── Lookups ────────────────────────────────────────────────────────────────
  const taskById = useMemo(() => Object.fromEntries(tasks.map((t) => [t.id, t])), [tasks]);
  const projectById = useCallback((id) => projects.find((p) => p.id === id), [projects]);
  const portfolioById = useCallback((id) => portfolios.find((p) => p.id === id), [portfolios]);
  const deptById = useCallback((id) => departments.find((d) => d.id === id), [departments]);
  const projectName = useCallback((id) => projectById(id)?.name || '', [projectById]);
  const deptName = useCallback((id) => deptById(id)?.name || '', [deptById]);

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
    } catch (e) { refetchTasks().catch(() => {}); throw e; }
  }, [patchLocalTask, refetchTasks]);

  const toggleComplete = useCallback((t) => updateTask(t.id, { completed: !t.completed }), [updateTask]);
  const setStatus = useCallback((id, status) => updateTask(id, { status }), [updateTask]);

  const deleteTask = useCallback(async (id) => {
    setTasks((prev) => prev.filter((t) => t.id !== id));   // optimistic
    try { await api.deleteTask(id); } catch (e) { refetchTasks().catch(() => {}); throw e; }
  }, [refetchTasks]);

  const bulkUpdate = useCallback(async (ids, patch) => {
    const rows = await api.bulkUpdateTasks(ids, toBody(patch));
    const map = Object.fromEntries(rows.map((r) => [r.id, r]));
    setTasks((prev) => prev.map((t) => map[t.id] || t));
    return rows;
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

  const actions = useMemo(() => ({
    createProject: mk(api.createTaskProject, setProjects),
    updateProject: mkUpd(api.updateTaskProject, setProjects),
    deleteProject: mkDel(api.deleteTaskProject, setProjects),
    createPortfolio: mk(api.createTaskPortfolio, setPortfolios),
    updatePortfolio: mkUpd(api.updateTaskPortfolio, setPortfolios),
    deletePortfolio: mkDel(api.deleteTaskPortfolio, setPortfolios),
    createDepartment: mk(api.createTaskDepartment, setDepartments),
    updateDepartment: mkUpd(api.updateTaskDepartment, setDepartments),
    deleteDepartment: mkDel(api.deleteTaskDepartment, setDepartments),
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
    createCustomField: mk(api.createTaskCustomField, setCustomFields),
    deleteCustomField: mkDel(api.deleteTaskCustomField, setCustomFields),
    createCustomStatus: mk(api.createTaskCustomStatus, setCustomStatuses),
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
  // statuses change — the single source every status surface should read from.
  const statusMeta = useMemo(() => buildStatusMeta(customStatuses), [customStatuses]);
  const statusOrder = useMemo(() => buildStatusOrder(customStatuses), [customStatuses]);

  const value = {
    loading, myEmail, nameOf,
    tasks, projects, portfolios, departments, tickets, ticketComponents, savedViews, ticketViews, rules, templates,
    customFields, customStatuses, statusMeta, statusOrder, notifications, memberRequests, intakeForms, changelog,
    taskById, projectById, portfolioById, deptById, projectName, deptName,
    getComments, addComment, commentCache: commentCache.current,
    createTask, updateTask, deleteTask, bulkUpdate, toggleComplete, setStatus,
    markNotificationRead, markAllNotificationsRead, refresh: loadCore,
    ...actions,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTasks() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useTasks must be used within TasksProvider');
  return ctx;
}

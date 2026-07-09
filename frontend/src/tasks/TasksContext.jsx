// Task Module — data layer. Replaces the export's React-Query + Zustand +
// NexusTaskStore with a single Nexus-style context: loads from the FastAPI
// backend, applies optimistic updates, and refetches on a task_events realtime
// ping (with a poll fallback), mirroring RequisitionContext.
import { createContext, useContext, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { supabase } from '../lib/supabase';
import { useRole } from '../contexts/RoleContext';
import { useNameResolver } from '../lib/useNameResolver';

const Ctx = createContext(null);

// camelCase (frontend) → snake_case (API body). The backend serialises replies
// back to camelCase, so we only map on the way out.
const CAMEL_TO_SNAKE = {
  assigneeId: 'assignee_email', followerIds: 'follower_emails', likedByIds: 'liked_by_emails',
  accessLevel: 'access_level', projectId: 'project_id', sectionId: 'section_id',
  departmentId: 'department_id', parentTaskId: 'parent_task_id', subtaskIds: 'subtask_ids',
  blockedByIds: 'blocked_by_ids', blockingIds: 'blocking_ids', dependencyTypes: 'dependency_types',
  customFieldValues: 'custom_field_values', startOn: 'start_on', dueOn: 'due_on',
  estimateHours: 'estimate_hours', actualHours: 'actual_hours', isMilestone: 'is_milestone',
  approvalStatus: 'approval_status', ownerId: 'owner_email', memberIds: 'member_emails',
  portfolioId: 'portfolio_id', projectIds: 'project_ids', targetProjectId: 'target_project_id',
  requesterId: 'requester_email', linkedTaskId: 'linked_task_id', slaDueOn: 'sla_due_on',
  subtaskTitles: 'subtask_titles',
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
  const [savedViews, setSavedViews] = useState([]);
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
    const [t, p, pf, d, tk, sv, r, tpl, cf, cs, mr, intk, chl] = await Promise.all([
      api.getTasks().catch(() => []),
      api.getTaskProjects().catch(() => []),
      api.getTaskPortfolios().catch(() => []),
      api.getTaskDepartments().catch(() => []),
      api.getTaskTickets().catch(() => []),
      api.getTaskSavedViews().catch(() => []),
      api.getTaskAutomationRules().catch(() => []),
      api.getTaskTemplates().catch(() => []),
      api.getTaskCustomFields().catch(() => []),
      api.getTaskCustomStatuses().catch(() => []),
      api.getTaskMemberRequests().catch(() => []),
      api.getTaskIntakeForms().catch(() => []),
      api.getTaskChangelog().catch(() => []),
    ]);
    setTasks(t || []); setProjects(p || []); setPortfolios(pf || []); setDepartments(d || []);
    setTickets(tk || []); setSavedViews(sv || []); setRules(r || []); setTemplates(tpl || []);
    setCustomFields(cf || []); setCustomStatuses(cs || []); setMemberRequests(mr || []);
    setIntakeForms(intk || []); setChangelog(chl || []);
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
  const editComment = useCallback(async (cid, body) => {
    const c = await api.editTaskComment(cid, { body });
    if (commentCache.current[c.taskId]) commentCache.current[c.taskId] = commentCache.current[c.taskId].map((x) => (x.id === cid ? c : x));
    return c;
  }, []);
  const pinComment = useCallback(async (cid, pinned) => {
    const c = await api.editTaskComment(cid, { pinned });
    if (commentCache.current[c.taskId]) commentCache.current[c.taskId] = commentCache.current[c.taskId].map((x) => (x.id === cid ? c : x));
    return c;
  }, []);
  const deleteComment = useCallback(async (cid, taskId) => {
    await api.deleteTaskComment(cid);
    if (taskId && commentCache.current[taskId]) commentCache.current[taskId] = commentCache.current[taskId].filter((x) => x.id !== cid);
    refetchTasks().catch(() => {});
  }, [refetchTasks]);

  // Attachments
  const getAttachments = useCallback((taskId) => api.getTaskAttachments(taskId).catch(() => []), []);
  const addAttachment = useCallback(async (taskId, data) => {
    const a = await api.addTaskAttachment(taskId, data);
    refetchTasks().catch(() => {});
    return a;
  }, [refetchTasks]);
  const removeAttachment = useCallback(async (aid) => {
    await api.deleteTaskAttachment(aid);
    refetchTasks().catch(() => {});
  }, [refetchTasks]);
  const getTaskActivity = useCallback((taskId) => api.getTaskActivity(taskId).catch(() => []), []);

  // ── Task field helpers (all wrap updateTask; keep the export's action names) ─
  const setPriority = useCallback((id, priority) => updateTask(id, { priority }), [updateTask]);
  const setDue = useCallback((id, dueOn) => updateTask(id, { dueOn: dueOn || '' }), [updateTask]);
  const setStart = useCallback((id, startOn) => updateTask(id, { startOn: startOn || '' }), [updateTask]);
  const setAssignee = useCallback((id, assigneeId) => updateTask(id, { assigneeId: assigneeId || '' }), [updateTask]);
  const setMilestone = useCallback((id, isMilestone) => updateTask(id, { isMilestone }), [updateTask]);
  const setAccessLevel = useCallback((id, accessLevel) => updateTask(id, { accessLevel }), [updateTask]);
  const setApproval = useCallback((id, approvalStatus) => updateTask(id, { approvalStatus }), [updateTask]);
  const setCustomFieldValue = useCallback((task, fieldId, value) => {
    const cfv = { ...(task.customFieldValues || {}), [fieldId]: value };
    return updateTask(task.id, { customFieldValues: cfv });
  }, [updateTask]);

  // Followers / likes (toggle membership on the array, optimistic via updateTask)
  const toggleFollower = useCallback((task, email) => {
    const e = (email || '').toLowerCase();
    const cur = (task.followerIds || []).map((x) => (x || '').toLowerCase());
    const next = cur.includes(e) ? cur.filter((x) => x !== e) : [...cur, e];
    return updateTask(task.id, { followerIds: next });
  }, [updateTask]);
  const toggleLike = useCallback((task, email) => {
    const e = (email || '').toLowerCase();
    const cur = (task.likedByIds || []).map((x) => (x || '').toLowerCase());
    const next = cur.includes(e) ? cur.filter((x) => x !== e) : [...cur, e];
    return updateTask(task.id, { likedByIds: next });
  }, [updateTask]);

  // Dependencies — maintain both sides (reciprocal), mirroring the export's createActions.
  const addDependency = useCallback(async (task, otherId, type = 'FS') => {
    const blocked = [...new Set([...(task.blockedByIds || []), otherId])];
    const depTypes = { ...(task.dependencyTypes || {}), [otherId]: type };
    await updateTask(task.id, { blockedByIds: blocked, dependencyTypes: depTypes });
    const other = taskById[otherId];
    if (other) await updateTask(otherId, { blockingIds: [...new Set([...(other.blockingIds || []), task.id])] });
  }, [updateTask, taskById]);
  const removeDependency = useCallback(async (task, otherId) => {
    const depTypes = { ...(task.dependencyTypes || {}) }; delete depTypes[otherId];
    await updateTask(task.id, { blockedByIds: (task.blockedByIds || []).filter((x) => x !== otherId), dependencyTypes: depTypes });
    const other = taskById[otherId];
    if (other) await updateTask(otherId, { blockingIds: (other.blockingIds || []).filter((x) => x !== task.id) });
  }, [updateTask, taskById]);
  const setDependencyType = useCallback((task, otherId, type) => {
    return updateTask(task.id, { dependencyTypes: { ...(task.dependencyTypes || {}), [otherId]: type } });
  }, [updateTask]);

  // Subtasks — backend assigns PARENT.N code, inherits project/dept, adds default followers.
  const addSubtask = useCallback(async (parent, data = {}) => {
    const created = await createTask({
      title: data.title || 'New subtask', parentTaskId: parent.id,
      projectId: data.projectId ?? parent.projectId, departmentId: data.departmentId ?? parent.departmentId,
      assigneeId: data.assigneeId || '', dueOn: data.dueOn || '',
    });
    refetchTasks().catch(() => {});
    return created;
  }, [createTask, refetchTasks]);

  const duplicateTask = useCallback(async (id) => {
    const created = await api.duplicateTask(id);
    setTasks((prev) => [created, ...prev]);
    return created;
  }, []);
  const logTime = useCallback(async (id, hours) => {
    const saved = await api.logTaskTime(id, hours);
    setTasks((prev) => prev.map((t) => (t.id === id ? saved : t)));
    return saved;
  }, []);
  const bulkComplete = useCallback((ids) => bulkUpdate(ids, { completed: true }), [bulkUpdate]);
  const bulkDelete = useCallback(async (ids) => {
    setTasks((prev) => prev.filter((t) => !ids.includes(t.id)));   // optimistic
    try { await api.bulkDeleteTasks(ids); } catch (e) { refetchTasks().catch(() => {}); throw e; }
  }, [refetchTasks]);
  const applyTemplate = useCallback(async (templateId, overrides) => {
    const created = await api.applyTaskTemplate(templateId, overrides);
    await refetchTasks();
    return created;
  }, [refetchTasks]);
  const submitIntakeForm = useCallback(async (formId, values) => {
    const created = await api.submitTaskIntakeForm(formId, values);
    await refetchTasks();
    return created;
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
    createSavedView: mk(api.createTaskSavedView, setSavedViews),
    deleteSavedView: mkDel(api.deleteTaskSavedView, setSavedViews),
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

  const value = {
    loading, myEmail, nameOf,
    tasks, projects, portfolios, departments, tickets, savedViews, rules, templates,
    customFields, customStatuses, notifications, memberRequests, intakeForms, changelog,
    taskById, projectById, portfolioById, deptById, projectName, deptName,
    getComments, addComment, editComment, pinComment, deleteComment, commentCache: commentCache.current,
    getAttachments, addAttachment, removeAttachment, getTaskActivity,
    createTask, updateTask, deleteTask, bulkUpdate, toggleComplete, setStatus,
    setPriority, setDue, setStart, setAssignee, setMilestone, setAccessLevel, setApproval, setCustomFieldValue,
    toggleFollower, toggleLike, addDependency, removeDependency, setDependencyType,
    addSubtask, duplicateTask, logTime, bulkComplete, bulkDelete, applyTemplate, submitIntakeForm,
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

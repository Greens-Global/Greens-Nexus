import { msalInstance, msalReady } from './msalInstance';
import { apiTokenRequest } from './authConfig';

const BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:8000";

async function getAuthHeader(forceRefresh = false) {
  // Wait for MSAL to finish loading its cache before asking for a token.
  // Without this, acquireTokenSilent fails on first render and the request
  // goes out with no Authorization header, causing a 401.
  await msalReady;
  const accounts = msalInstance.getAllAccounts();
  if (!accounts.length) return {};
  try {
    const result = await msalInstance.acquireTokenSilent({
      ...apiTokenRequest,
      account: accounts[0],
      forceRefresh,
    });
    return { Authorization: `Bearer ${result.idToken}` };
  } catch {
    return {};
  }
}

// Azure App Service on the free/basic tier can take 5-15 seconds to cold-start.
// Network errors (CORS preflight timeout) get 3 attempts with 800ms/1.6s backoff.
// 5xx errors get 4 attempts with 1s/2s/4s exponential backoff — covers warm-up.
const MAX_NET_ATTEMPTS = 3;
const MAX_5XX_ATTEMPTS = 4;
// Each individual fetch is capped at 18s. Without this, a hung backend means
// the browser never resolves the request and the UI appears frozen indefinitely.
// AI endpoints (Claude formats/generates an SOP or course) routinely run longer
// than 18s — they pass a much higher timeout via options.timeoutMs so they don't
// abort with "signal is aborted without reason".
const FETCH_TIMEOUT_MS = 18_000;
const AI_TIMEOUT_MS = 120_000;

// Global health state — broadcast to the rest of the app when the backend goes
// down or comes back so a single reconnecting banner can appear rather than
// every module showing its own error independently.
let _backendDown = false;
let _downCount   = 0;
const _healthListeners = new Set();
function _setBackendDown(down) {
  if (down === _backendDown) return;
  _backendDown = down;
  _downCount   = down ? _downCount + 1 : 0;
  _healthListeners.forEach(fn => fn(down));
}
export function onBackendHealth(fn) {
  _healthListeners.add(fn);
  fn(_backendDown); // fire immediately with current state
  return () => _healthListeners.delete(fn);
}
export function isBackendDown() { return _backendDown; }

async function req(path, options = {}, attempt = 1, tokenRefreshed = false) {
  const authHeader = await getAuthHeader(tokenRefreshed);
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  let res;
  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), timeoutMs);
    try {
      res = await fetch(`${BASE}${path}`, {
        ...options,
        signal: controller.signal,
        headers: {
          // FormData bodies set their own multipart boundary — forcing JSON breaks them
          ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
          ...authHeader,
          ...(options.headers ?? {}),
        },
      });
    } finally {
      clearTimeout(tid);
    }
  } catch (err) {
    // fetch() itself threw — offline, CORS preflight dropped, cold-start, or timeout.
    if (attempt < MAX_NET_ATTEMPTS) {
      await new Promise(r => setTimeout(r, 800 * attempt));
      return req(path, options, attempt + 1, tokenRefreshed);
    }
    _setBackendDown(true);
    throw err;
  }

  // On 401 (expired token), force-refresh MSAL token and retry once
  if (res.status === 401 && !tokenRefreshed) {
    return req(path, options, attempt, true);
  }
  // Exponential backoff for 5xx — 1s, 2s, 4s — total ~7s before giving up.
  // Covers typical Azure cold-start without burning too many attempts on real errors.
  if (res.status >= 500 && attempt < MAX_5XX_ATTEMPTS) {
    await new Promise(r => setTimeout(r, Math.min(1000 * 2 ** (attempt - 1), 4000)));
    return req(path, options, attempt + 1, tokenRefreshed);
  }
  if (!res.ok) {
    let detail;
    try { detail = (await res.json())?.detail; } catch { /* not JSON */ }
    const err = new Error(detail || `API error ${res.status}`);
    err.status = res.status;
    err.detail = detail;
    if (res.status >= 500) _setBackendDown(true);
    throw err;
  }

  // Successful response — backend is up
  _setBackendDown(false);
  if (res.status === 204) return null;
  return res.json();
}

// Short-lived GET cache + in-flight dedup for reference data that rarely changes
// (allocators, approvers, people directory). Several tabs/modals each fetch these
// on mount, firing the same request many times — slow and wasteful on throttled
// connections. Sharing one promise for a TTL window collapses them into one call.
const _getCache = new Map(); // path → { ts, promise }
function cachedGet(path, ttlMs = 60_000) {
  const hit = _getCache.get(path);
  if (hit && (Date.now() - hit.ts) < ttlMs) return hit.promise;
  const promise = req(path).catch(err => { _getCache.delete(path); throw err; });
  _getCache.set(path, { ts: Date.now(), promise });
  return promise;
}

// Like req(), but for endpoints that return a file (Excel/PDF export) rather
// than JSON — returns the blob plus the filename the server suggested via
// Content-Disposition, so the caller can trigger a download.
async function reqBlob(path, options = {}, attempt = 1, tokenRefreshed = false) {
  const authHeader = await getAuthHeader(tokenRefreshed);
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  let res;
  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), timeoutMs);
    try {
      res = await fetch(`${BASE}${path}`, {
        ...options,
        signal: controller.signal,
        headers: { ...authHeader, ...(options.headers ?? {}) },
      });
    } finally {
      clearTimeout(tid);
    }
  } catch (err) {
    if (attempt < MAX_NET_ATTEMPTS) {
      await new Promise(r => setTimeout(r, 800 * attempt));
      return reqBlob(path, options, attempt + 1, tokenRefreshed);
    }
    throw err;
  }
  if (res.status === 401 && !tokenRefreshed) {
    return reqBlob(path, options, attempt, true);
  }
  if (res.status >= 500 && attempt < MAX_5XX_ATTEMPTS) {
    await new Promise(r => setTimeout(r, Math.min(1000 * 2 ** (attempt - 1), 4000)));
    return reqBlob(path, options, attempt + 1, tokenRefreshed);
  }
  if (!res.ok) {
    let detail;
    try { detail = (await res.json())?.detail; } catch { /* not JSON */ }
    const err = new Error(detail || `API error ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const disposition = res.headers.get('content-disposition') || '';
  const match = disposition.match(/filename="?([^";]+)"?/);
  return { blob: await res.blob(), filename: match?.[1] || 'download' };
}

export const api = {
  // Dashboard
  getDashboardSummary: () => req("/dashboard/summary"),

  // Tasks — core (bodies are snake_case; the TasksContext maps to/from camelCase)
  getTasks: () => req("/tasks"),
  createTask: (data) => req("/tasks", { method: "POST", body: JSON.stringify(data) }),
  updateTask: (id, data) => req(`/tasks/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteTask: (id) => req(`/tasks/${id}`, { method: "DELETE" }),
  bulkUpdateTasks: (ids, patch) => req("/tasks/bulk", { method: "POST", body: JSON.stringify({ ids, patch }) }),
  // Task comments / attachments / activity
  getTaskComments: (id) => req(`/tasks/${id}/comments`),
  addTaskComment: (id, data) => req(`/tasks/${id}/comments`, { method: "POST", body: JSON.stringify(data) }),
  editTaskComment: (cid, data) => req(`/tasks/comments/${cid}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteTaskComment: (cid) => req(`/tasks/comments/${cid}`, { method: "DELETE" }),
  getTaskAttachments: (id) => req(`/tasks/${id}/attachments`),
  addTaskAttachment: (id, data) => req(`/tasks/${id}/attachments`, { method: "POST", body: JSON.stringify(data) }),
  deleteTaskAttachment: (aid) => req(`/tasks/attachments/${aid}`, { method: "DELETE" }),
  getTaskActivity: (id) => req(`/tasks/${id}/activity`),
  getGlobalTaskActivity: () => req("/tasks/activity"),
  // Sections & custom statuses (board columns)
  getTaskSections: () => req("/tasks/meta/sections"),
  createTaskSection: (data) => req("/tasks/meta/sections", { method: "POST", body: JSON.stringify(data) }),
  updateTaskSection: (id, data) => req(`/tasks/meta/sections/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteTaskSection: (id) => req(`/tasks/meta/sections/${id}`, { method: "DELETE" }),
  getTaskCustomStatuses: () => req("/tasks/meta/custom-statuses"),
  createTaskCustomStatus: (data) => req("/tasks/meta/custom-statuses", { method: "POST", body: JSON.stringify(data) }),
  deleteTaskCustomStatus: (id) => req(`/tasks/meta/custom-statuses/${id}`, { method: "DELETE" }),
  // Projects / portfolios / departments / member requests
  getTaskProjects: () => req("/task-projects"),
  createTaskProject: (data) => req("/task-projects", { method: "POST", body: JSON.stringify(data) }),
  updateTaskProject: (id, data) => req(`/task-projects/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteTaskProject: (id) => req(`/task-projects/${id}`, { method: "DELETE" }),
  getTaskPortfolios: () => req("/task-portfolios"),
  createTaskPortfolio: (data) => req("/task-portfolios", { method: "POST", body: JSON.stringify(data) }),
  updateTaskPortfolio: (id, data) => req(`/task-portfolios/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteTaskPortfolio: (id) => req(`/task-portfolios/${id}`, { method: "DELETE" }),
  getTaskDepartments: () => req("/task-departments"),
  createTaskDepartment: (data) => req("/task-departments", { method: "POST", body: JSON.stringify(data) }),
  updateTaskDepartment: (id, data) => req(`/task-departments/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteTaskDepartment: (id) => req(`/task-departments/${id}`, { method: "DELETE" }),
  getTaskMemberRequests: () => req("/task-member-requests"),
  createTaskMemberRequest: (data) => req("/task-member-requests", { method: "POST", body: JSON.stringify(data) }),
  decideTaskMemberRequest: (id, status) => req(`/task-member-requests/${id}/decide`, { method: "POST", body: JSON.stringify({ status }) }),
  // Saved views / automation rules / templates / intake forms / custom fields
  getTaskSavedViews: () => req("/task-saved-views"),
  createTaskSavedView: (data) => req("/task-saved-views", { method: "POST", body: JSON.stringify(data) }),
  deleteTaskSavedView: (id) => req(`/task-saved-views/${id}`, { method: "DELETE" }),
  getTaskAutomationRules: () => req("/task-automation-rules"),
  createTaskAutomationRule: (data) => req("/task-automation-rules", { method: "POST", body: JSON.stringify(data) }),
  updateTaskAutomationRule: (id, data) => req(`/task-automation-rules/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteTaskAutomationRule: (id) => req(`/task-automation-rules/${id}`, { method: "DELETE" }),
  getTaskTemplates: () => req("/task-templates"),
  createTaskTemplate: (data) => req("/task-templates", { method: "POST", body: JSON.stringify(data) }),
  deleteTaskTemplate: (id) => req(`/task-templates/${id}`, { method: "DELETE" }),
  getTaskIntakeForms: () => req("/task-intake-forms"),
  createTaskIntakeForm: (data) => req("/task-intake-forms", { method: "POST", body: JSON.stringify(data) }),
  deleteTaskIntakeForm: (id) => req(`/task-intake-forms/${id}`, { method: "DELETE" }),
  getTaskCustomFields: () => req("/task-custom-fields"),
  createTaskCustomField: (data) => req("/task-custom-fields", { method: "POST", body: JSON.stringify(data) }),
  updateTaskCustomField: (id, data) => req(`/task-custom-fields/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteTaskCustomField: (id) => req(`/task-custom-fields/${id}`, { method: "DELETE" }),
  // Tickets
  getTaskTickets: () => req("/task-tickets"),
  createTaskTicket: (data) => req("/task-tickets", { method: "POST", body: JSON.stringify(data) }),
  updateTaskTicket: (id, data) => req(`/task-tickets/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteTaskTicket: (id) => req(`/task-tickets/${id}`, { method: "DELETE" }),
  // Module notification bell
  getTaskNotifications: () => req("/task-notifications"),
  markTaskNotificationRead: (id) => req(`/task-notifications/${id}/read`, { method: "POST" }),
  markAllTaskNotificationsRead: () => req("/task-notifications/read-all", { method: "POST" }),
  // Changelog / What's New
  getTaskChangelog: () => req("/task-changelog"),
  createTaskChangelog: (data) => req("/task-changelog", { method: "POST", body: JSON.stringify(data) }),
  updateTaskChangelog: (id, data) => req(`/task-changelog/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteTaskChangelog: (id) => req(`/task-changelog/${id}`, { method: "DELETE" }),
  getTaskChangelogComments: (id) => req(`/task-changelog/${id}/comments`),
  addTaskChangelogComment: (id, data) => req(`/task-changelog/${id}/comments`, { method: "POST", body: JSON.stringify(data) }),
  // Long-running: pulls commits + calls Claude, so it needs the AI timeout (not the 18s default).
  generateTaskChangelog: () => req("/task-changelog/generate", { method: "POST", timeoutMs: 120_000 }),

  // Purchase Requests
  getPurchaseRequests: () => req("/purchase-requests"),
  createPurchaseRequest: (data) => req("/purchase-requests", { method: "POST", body: JSON.stringify(data) }),
  updatePurchaseStatus: (id, status) => req(`/purchase-requests/${id}`, { method: "PATCH", body: JSON.stringify({ status }) }),

  // Reviews
  getReviews: () => req("/reviews"),
  replyToReview: (id, reply_text) => req(`/reviews/${id}/reply`, { method: "PATCH", body: JSON.stringify({ reply_text }) }),

  // Marketing
  getCampaigns: () => req("/marketing-campaigns"),

  // SOP
  getSops: () => req("/sop-updates"),
  createSop: (data) => req("/sop-updates", { method: "POST", body: JSON.stringify(data) }),

  // Knowledge Base — DB-backed SOP / Manual / Guide library
  getKbDocs:     ()         => req("/knowledge-base/documents"),
  getKbDoc:      (id)       => req(`/knowledge-base/documents/${id}`),
  createKbDoc:   (data)     => req("/knowledge-base/documents", { method: "POST", body: JSON.stringify(data) }),
  updateKbDoc:   (id, data) => req(`/knowledge-base/documents/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  submitKbDoc:   (id)       => req(`/knowledge-base/documents/${id}/submit`, { method: "POST" }),
  reviewKbDoc:   (id, data) => req(`/knowledge-base/documents/${id}/review`, { method: "POST", body: JSON.stringify(data) }),
  archiveKbDoc:  (id)       => req(`/knowledge-base/documents/${id}/archive`, { method: "POST" }),
  unarchiveKbDoc:(id)       => req(`/knowledge-base/documents/${id}/unarchive`, { method: "POST" }),
  aiFormatKbDoc: (data)     => req("/knowledge-base/ai-format", { method: "POST", body: JSON.stringify(data), timeoutMs: AI_TIMEOUT_MS }),
  askKb:         (data)     => req("/knowledge-base/ask", { method: "POST", body: JSON.stringify(data), timeoutMs: AI_TIMEOUT_MS }),
  getPageHelp:        (key, label = '') => req(`/help/page?key=${encodeURIComponent(key)}&label=${encodeURIComponent(label)}`, { timeoutMs: AI_TIMEOUT_MS }),
  regeneratePageHelp: (key, label = '') => req('/help/page/regenerate', { method: 'POST', body: JSON.stringify({ key, label }), timeoutMs: AI_TIMEOUT_MS }),
  getKbAcks:        (id)        => req(`/knowledge-base/documents/${id}/acknowledgements`),
  acknowledgeKbDoc: (id)        => req(`/knowledge-base/documents/${id}/acknowledge`, { method: "POST" }),
  setKbAckRequired: (id, value) => req(`/knowledge-base/documents/${id}/ack-required`, { method: "POST", body: JSON.stringify({ value }) }),
  getKbSignoffs:    ()          => req("/knowledge-base/signoffs"),
  getKbComments:    (id)        => req(`/knowledge-base/documents/${id}/comments`),
  addKbComment:     (id, text)  => req(`/knowledge-base/documents/${id}/comments`, { method: "POST", body: JSON.stringify({ text }) }),
  getKbSnapshots:   (id)        => req(`/knowledge-base/documents/${id}/snapshots`),
  verifyKbDoc:      (id)            => req(`/knowledge-base/documents/${id}/verify`, { method: "POST" }),
  setKbDepartments: (id, departments) => req(`/knowledge-base/documents/${id}/departments`, { method: "POST", body: JSON.stringify({ departments }) }),
  getKbInsights:    ()          => req("/knowledge-base/insights"),
  getKbActivity:    (limit = 80) => req(`/knowledge-base/activity?limit=${limit}`),
  getKbReviewers:   ()          => req("/knowledge-base/reviewers"),
  aiReviseKbDoc:    (data)      => req("/knowledge-base/ai-revise", { method: "POST", body: JSON.stringify(data), timeoutMs: AI_TIMEOUT_MS }),
  getKbPins:        ()          => req("/knowledge-base/pins"),
  toggleKbPin:      (id)        => req(`/knowledge-base/documents/${id}/pin`, { method: "POST" }),
  translateKbDoc:   (id, lang)  => req(`/knowledge-base/documents/${id}/translate`, { method: "POST", body: JSON.stringify({ lang }), timeoutMs: AI_TIMEOUT_MS }),
  uploadKbMedia:    (data)      => req('/knowledge-base/media/upload', { method: 'POST', body: JSON.stringify({ data }), timeoutMs: 60_000 }),
  signKbMedia:      (paths)     => req('/knowledge-base/media/sign', { method: 'POST', body: JSON.stringify({ paths }) }),
  // Learn (LMS)
  aiCourse:        (data)      => req("/knowledge-base/ai-course", { method: "POST", body: JSON.stringify(data), timeoutMs: AI_TIMEOUT_MS }),
  getKbCourses:    ()          => req("/knowledge-base/courses"),
  getKbCourse:     (id)        => req(`/knowledge-base/courses/${id}`),
  createKbCourse:  (data)      => req("/knowledge-base/courses", { method: "POST", body: JSON.stringify(data) }),
  updateKbCourse:  (id, data)  => req(`/knowledge-base/courses/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  kbLessonDone:    (id, lesson_id) => req(`/knowledge-base/courses/${id}/lesson-done`, { method: "POST", body: JSON.stringify({ lesson_id }) }),
  kbSubmitQuiz:    (id, answers)   => req(`/knowledge-base/courses/${id}/submit-quiz`, { method: "POST", body: JSON.stringify({ answers }) }),
  getKbCourseAttempts: (id)        => req(`/knowledge-base/courses/${id}/attempts`),
  assignKbCourse:   (id, emails, due_date) => req(`/knowledge-base/courses/${id}/assign`, { method: "POST", body: JSON.stringify({ emails, due_date }) }),
  getKbCourseAssignments: (id)     => req(`/knowledge-base/courses/${id}/assignments`),
  removeKbAssignment: (aid)        => req(`/knowledge-base/assignments/${aid}`, { method: "DELETE" }),
  getMyKbAssignments: ()           => req("/knowledge-base/my-assignments"),

  // Assets
  getAssets: () => req("/assets"),
  createAsset: (data) => req("/assets", { method: "POST", body: JSON.stringify(data) }),

  // Asset Management (property portfolio) — whole-workspace load/save.
  getPropertyWorkspace:  ()   => req("/property-assets/workspace"),
  savePropertyWorkspace: (ws) => req("/property-assets/workspace", { method: "PUT", body: JSON.stringify(ws), timeoutMs: 60_000 }),
  scanPropertyReminders: ()   => req("/property-assets/reminders/scan", { method: "POST" }),

  // Users
  getUsers: () => req("/users"),
  createUser: (data) => req("/users", { method: "POST", body: JSON.stringify(data) }),

  // Websites
  getWebsites: () => req("/websites"),
  createWebsite: (data) => req("/websites", { method: "POST", body: JSON.stringify(data) }),

  // External Links
  getExternalLinks: () => req("/external-links"),
  createExternalLink: (data) => req("/external-links", { method: "POST", body: JSON.stringify(data) }),
  clickExternalLink: (id) => req(`/external-links/${id}/click`, { method: "PATCH" }),

  // Nexus Roles
  getMyRole:    ()                    => req('/roles/me'),
  getAllRoles:   ()                   => req('/roles'),
  assignRole:   (email, role, by, displayName) => req(`/roles/${encodeURIComponent(email)}`, { method: 'PUT', body: JSON.stringify({ role, assigned_by: by, display_name: displayName || '' }) }),
  syncRoles:    (emails)             => req('/roles/sync', { method: 'POST', body: JSON.stringify({ emails }) }),

  // Access Groups
  getGroups:         ()                  => req('/groups'),
  createGroup:       (body)              => req('/groups', { method: 'POST', body: JSON.stringify(body) }),
  updateGroup:       (id, body)          => req(`/groups/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteGroup:       (id)                => req(`/groups/${id}`, { method: 'DELETE' }),
  addGroupMembers:   (id, emails)        => req(`/groups/${id}/members`, { method: 'POST', body: JSON.stringify({ emails }) }),
  removeGroupMember: (id, email)         => req(`/groups/${id}/members/${encodeURIComponent(email)}`, { method: 'DELETE' }),
  assignGroupRole:   (id, role, by)      => req(`/groups/${id}/assign-role`, { method: 'POST', body: JSON.stringify({ role, assigned_by: by }) }),

  // Job Roles (Roles & Access redesign) — a job role is a group template with a tier
  getJobRoles:       ()                  => req('/jobroles'),
  createJobRole:     (body)              => req('/jobroles', { method: 'POST', body: JSON.stringify(body) }),
  updateJobRole:     (id, body)          => req(`/jobroles/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteJobRole:     (id)                => req(`/jobroles/${id}`, { method: 'DELETE' }),
  assignJobRole:     (id, email)         => req(`/jobroles/${id}/assign`, { method: 'POST', body: JSON.stringify({ email }) }),
  unassignJobRole:   (id, email)         => req(`/jobroles/${id}/unassign`, { method: 'POST', body: JSON.stringify({ email }) }),
  getEffectiveAccess:(email)             => req(`/jobroles/effective/${encodeURIComponent(email)}`),
  // Row-level access scopes (sandbox external users to specific companies)
  getAccessScopes:   (email)             => req(`/access-scopes/${encodeURIComponent(email)}`),
  addAccessScope:    (email, body)       => req(`/access-scopes/${encodeURIComponent(email)}`, { method: 'POST', body: JSON.stringify(body) }),
  deleteAccessScope: (email, scopeId)    => req(`/access-scopes/${encodeURIComponent(email)}/${encodeURIComponent(scopeId)}`, { method: 'DELETE' }),

  // Testing module (QA) — dev-only, endpoints 404 unless NEXUS_QA_MODULE is set
  qaEnabled:        ()            => cachedGet('/qa/enabled', 300_000),
  qaCases:          ()            => req('/qa/cases'),
  qaCreateCase:     (body)        => req('/qa/cases', { method: 'POST', body: JSON.stringify(body) }),
  qaUpdateCase:     (id, body)    => req(`/qa/cases/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  qaRuns:           ()            => req('/qa/runs'),
  qaCreateRun:      (name)        => req('/qa/runs', { method: 'POST', body: JSON.stringify({ name }) }),
  qaRunResults:     (runId)       => req(`/qa/runs/${runId}/results`),
  qaUpsertResult:   (runId, body) => req(`/qa/runs/${runId}/results`, { method: 'POST', body: JSON.stringify(body) }),
  qaActivity:       ()            => req('/qa/activity'),
  qaBugs:           ()            => req('/qa/bug-reports'),
  qaCreateBug:      (body)        => req('/qa/bug-reports', { method: 'POST', body: JSON.stringify(body) }),
  qaUpdateBug:      (id, body)    => req(`/qa/bug-reports/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  qaConvertBug:     (id)          => req(`/qa/bug-reports/${id}/convert`, { method: 'POST', timeoutMs: 60_000 }),
  qaAssignments:    (runId = '')  => req(`/qa/assignments${runId ? `?run_id=${runId}` : ''}`),
  qaAssign:         (body)        => req('/qa/assignments', { method: 'POST', body: JSON.stringify(body) }),
  qaSaveFlow:       (id, flow)    => req(`/qa/cases/${id}/flow`, { method: 'POST', body: JSON.stringify({ flow }) }),
  qaGenerateE2e:    (id)          => req(`/qa/cases/${id}/generate-e2e`, { method: 'POST', timeoutMs: 90_000 }),
  qaExport:         (runId = '')  => reqBlob(`/qa/export${runId ? `?run_id=${runId}` : ''}`, { timeoutMs: 180_000 }),
  qaImport:         (file, runId = '') => { const fd = new FormData(); fd.append('file', file); return req(`/qa/import${runId ? `?run_id=${runId}` : ''}`, { method: 'POST', body: fd, timeoutMs: 180_000 }); },

  // Notifications (cross-device, stored in Supabase)
  pushNotification: (n)             => req('/notifications', { method: 'POST', body: JSON.stringify(n) }),
  getNotifications: ()               => req('/notifications'),
  markNotifRead:    (id)             => req(`/notifications/${id}/read`, { method: 'PATCH' }),
  markNotifActioned:(id)             => req(`/notifications/${id}/action`, { method: 'PATCH' }),
  deleteNotif:      (id)             => req(`/notifications/${id}`, { method: 'DELETE' }),
  sendAlert:        (data)           => req('/notifications/send-alert', { method: 'POST', body: JSON.stringify(data) }),

  // Inventory Requests (legacy — kept for backward compat with existing data)
  getInventoryItems:       ()          => req('/inventory-requests/items'),
  createInventoryItem:     (data)       => req('/inventory-requests/items', { method: 'POST', body: JSON.stringify(data) }),
  importInventoryItems:    (items)      => req('/inventory-requests/items/import', { method: 'POST', body: JSON.stringify({ items }) }),
  updateInventoryItem:     (id, data)   => req(`/inventory-requests/items/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteInventoryItem:     (id)         => req(`/inventory-requests/items/${id}`, { method: 'DELETE' }),
  getInventoryReport:      (params)     => reqBlob(`/inventory-requests/report?${new URLSearchParams(params)}`),
  getInventoryAuditLog:    (params)     => req(`/inventory-requests/audit-log?${new URLSearchParams(params)}`),
  getInventoryAllocators:  ()          => req('/inventory-requests/allocators'),
  getInventoryRequests:    ()          => req('/inventory-requests'),
  createInventoryRequest:  (data)      => req('/inventory-requests', { method: 'POST', body: JSON.stringify(data) }),
  updateInventoryRequest:  (id, data)  => req(`/inventory-requests/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

  // Items — new individual-unit system
  getItems:            (params = {})  => req(`/items?${new URLSearchParams(params)}`),
  createItem:          (data)         => req('/items', { method: 'POST', body: JSON.stringify(data) }),
  importItems:         (items)        => req('/items/import', { method: 'POST', body: JSON.stringify({ items }) }),
  updateItem:          (id, data)     => req(`/items/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteItem:          (id)           => req(`/items/${id}`, { method: 'DELETE' }),
  bulkDeleteItems:     (ids)          => req('/items/bulk-delete', { method: 'POST', body: JSON.stringify({ ids }) }),
  bulkUpdateItems:     (ids, fields)  => req('/items/bulk-update', { method: 'POST', body: JSON.stringify({ ids, fields }) }),
  // Soft-delete recycle bin (Ankush) — deleted items are restorable
  getDeletedItems:     ()             => req('/items/deleted'),
  restoreItem:         (id)           => req(`/items/${id}/restore`, { method: 'POST', body: JSON.stringify({}) }),
  bulkRestoreItems:    (ids)          => req('/items/bulk-restore', { method: 'POST', body: JSON.stringify({ ids }) }),
  // Admin-defined custom fields surfaced in the item Details panel (Ankush)
  getItemCustomFields: ()             => req('/items/custom-fields'),
  createItemCustomField: (d)          => req('/items/custom-fields', { method: 'POST', body: JSON.stringify(d) }),
  updateItemCustomField: (id, d)      => req(`/items/custom-fields/${id}`, { method: 'PATCH', body: JSON.stringify(d) }),
  deleteItemCustomField: (id)         => req(`/items/custom-fields/${id}`, { method: 'DELETE' }),
  getItemTypes:        ()             => req('/items/types'),
  addItemType:         (name)         => req('/items/types', { method: 'POST', body: JSON.stringify({ name }) }),
  deleteItemType:      (name)         => req(`/items/types/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  getItemsReport:      (params)       => reqBlob(`/items/report?${new URLSearchParams(params)}`),
  getItemsAuditLog:    (params)       => req(`/items/audit-log?${new URLSearchParams(params)}`),
  undoAuditEntry:      (audit_id, fields) => req('/items/audit-undo', { method: 'POST', body: JSON.stringify({ audit_id, fields }) }),
  getItemAllocators:   ()             => cachedGet('/items/allocators'),
  getItemApprovers:    ()             => cachedGet('/items/approvers'),
  getRolesDirectory:   ()             => cachedGet('/roles/directory'),
  // Curated Nexus People (nexus_employees), not the ~150-account M365 GAL — for
  // assigning items to real Nexus people. Same {email,name} shape.
  getPeopleDirectory:  ()             => cachedGet('/myhr/directory'),
  autoFillItemPhotos:  (item_ids, replace = false) => req('/items/auto-photos', { method: 'POST', body: JSON.stringify({ item_ids, replace }) }),
  // Permanent assignments
  getAssignments:         ()           => req('/items/assignments'),
  assignItem:             (itemId, d)  => req(`/items/${itemId}/assign`,   { method: 'POST', body: JSON.stringify(d) }),
  reassignItem:           (itemId, d)  => req(`/items/${itemId}/reassign`, { method: 'POST', body: JSON.stringify(d) }),
  assignItemToLocation:   (itemId, location) => req(`/items/${itemId}/assign-location`, { method: 'POST', body: JSON.stringify({ location }) }),
  bulkAssignLocation:     (ids, location)            => req('/items/bulk-assign-location', { method: 'POST', body: JSON.stringify({ ids, location }) }),
  bulkAssignPerson:       (ids, assignee_email, assignee_name) => req('/items/bulk-assign', { method: 'POST', body: JSON.stringify({ ids, assignee_email, assignee_name }) }),
  acceptAssignment:       (id, d)      => req(`/items/assignments/${id}/accept`,          { method: 'POST', body: JSON.stringify(d) }),
  declineAssignment:      (id, d)      => req(`/items/assignments/${id}/decline`,         { method: 'POST', body: JSON.stringify(d) }),
  initAssignmentReturn:   (id, d)      => req(`/items/assignments/${id}/initiate-return`, { method: 'POST', body: JSON.stringify(d) }),
  acceptAssignmentReturn: (id, d)      => req(`/items/assignments/${id}/accept-return`,   { method: 'POST', body: JSON.stringify(d) }),
  cancelAssignment:       (id)         => req(`/items/assignments/${id}/cancel`,          { method: 'POST', body: JSON.stringify({}) }),
  getItemCheckouts:    ()             => req('/items/checkouts'),
  createItemCheckout:  (data)         => req('/items/checkouts', { method: 'POST', body: JSON.stringify(data) }),
  updateItemCheckout:  (id, data)     => req(`/items/checkouts/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  requestItemExtension: (id, data)    => req(`/items/checkouts/${id}/extension`, { method: 'POST', body: JSON.stringify(data) }),
  resolveItemExtension: (id, data)    => req(`/items/checkouts/${id}/extension/resolve`, { method: 'POST', body: JSON.stringify(data) }),
  getItemCart:         ()             => req('/items/cart'),
  addItemToCart:       (data)         => req('/items/cart', { method: 'POST', body: JSON.stringify(data) }),
  removeItemFromCart:  (itemId)       => req(`/items/cart/${encodeURIComponent(itemId)}`, { method: 'DELETE' }),
  clearItemCart:       ()             => req('/items/cart', { method: 'DELETE' }),

  // Requisitions (persisted in Supabase)
  getRequisitions:           ()              => req('/requisitions'),
  createRequisition:         (data)          => req('/requisitions', { method: 'POST', body: JSON.stringify(data) }),
  approveRequisition:        (id, data)      => req(`/requisitions/${id}/approve`, { method: 'PATCH', body: JSON.stringify(data) }),
  rejectRequisition:         (id, data)      => req(`/requisitions/${id}/reject`, { method: 'PATCH', body: JSON.stringify(data) }),
  allocateRequisitionAsset:  (id, data)      => req(`/requisitions/${id}/allocate`, { method: 'PATCH', body: JSON.stringify(data) }),
  initiateRequisitionReturn: (id, data)      => req(`/requisitions/${id}/initiate-return`, { method: 'PATCH', body: JSON.stringify(data) }),
  confirmRequisitionReturn:  (id, data)      => req(`/requisitions/${id}/confirm-return`, { method: 'PATCH', body: JSON.stringify(data) }),
  markRequisitionLost:       (id, data)      => req(`/requisitions/${id}/mark-lost`, { method: 'PATCH', body: JSON.stringify(data) }),
  markRequisitionOrdered:    (id, data)      => req(`/requisitions/${id}/mark-ordered`, { method: 'PATCH', body: JSON.stringify(data) }),
  fulfillRequisition:        (id, data)      => req(`/requisitions/${id}/fulfill`, { method: 'PATCH', body: JSON.stringify(data) }),

  // Hardware Assets (persisted in Supabase)
  getHardwareAssets:  ()      => req('/hardware-assets'),
  createHardwareAsset:(data)  => req('/hardware-assets', { method: 'POST', body: JSON.stringify(data) }),

  // Audit Logs
  getAuditLogs: (params = {}) => {
    const qs = new URLSearchParams();
    if (params.limit)         qs.set('limit',         params.limit);
    if (params.offset)        qs.set('offset',        params.offset);
    if (params.user_email)    qs.set('user_email',    params.user_email);
    if (params.action)        qs.set('action',        params.action);
    if (params.resource_type) qs.set('resource_type', params.resource_type);
    return req(`/audit-logs?${qs.toString()}`);
  },

  // Accounting
  getTransactions: () => req("/accounting/transactions"),
  getRamp: () => req("/accounting/ramp"),
  getAma: () => req("/accounting/ama"),

  // Ops
  getOpsProjects: () => req("/ops-projects"),
  createOpsProject: (data) => req("/ops-projects", { method: "POST", body: JSON.stringify(data) }),

  // Dev
  getDevProjects: () => req("/dev-projects"),

  // LMS
  getLmsCourses: () => req("/lms-courses"),

  // HR — employee master records
  getEmployees:   ()         => req('/hr/employees'),
  createEmployee: (data)     => req('/hr/employees', { method: 'POST', body: JSON.stringify(data) }),
  updateEmployee: (id, data) => req(`/hr/employees/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteEmployee: (id)       => req(`/hr/employees/${id}`, { method: 'DELETE' }),

  // HR — companies/entities & work sites (Section A foundation)
  getEntities:    ()         => req('/hr/entities'),
  createEntity:   (data)     => req('/hr/entities', { method: 'POST', body: JSON.stringify(data) }),
  updateEntity:   (id, data) => req(`/hr/entities/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteEntity:   (id)       => req(`/hr/entities/${id}`, { method: 'DELETE' }),
  // per-company departments (managed list, not free text)
  getCompanyDepartments:    (entityId)       => req(`/hr/entities/${entityId}/departments`),
  addCompanyDepartment:     (entityId, name) => req(`/hr/entities/${entityId}/departments`, { method: 'POST', body: JSON.stringify({ name }) }),
  deleteCompanyDepartment:  (entityId, deptId) => req(`/hr/entities/${entityId}/departments/${deptId}`, { method: 'DELETE' }),
  getWorkSites:   ()         => req('/hr/work-sites'),
  createWorkSite: (data)     => req('/hr/work-sites', { method: 'POST', body: JSON.stringify(data) }),
  updateWorkSite: (id, data) => req(`/hr/work-sites/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteWorkSite: (id)       => req(`/hr/work-sites/${id}`, { method: 'DELETE' }),

  // HR — compensation + bank (restricted: hr_comp grant / owner)
  getCompensation:  (id)       => req(`/hr/employees/${id}/compensation`),
  saveCompensation: (id, data) => req(`/hr/employees/${id}/compensation`, { method: 'PUT', body: JSON.stringify(data) }),

  // HR — live assets (permanent assignments + active checkouts from Item Management)
  getEmployeeAssets: (id)      => req(`/hr/employees/${id}/assets`),
  changeEmployeeStatus: (id, data) => req(`/hr/employees/${id}/status`, { method: 'POST', body: JSON.stringify(data) }),

  // HR — mailbox export (zip of .eml via Graph; needs Mail.Read consent)
  startMailboxExport: (id)      => req(`/hr/employees/${id}/mailbox-export`, { method: 'POST' }),
  getMailboxExport:   (id)      => req(`/hr/employees/${id}/mailbox-export`),
  getExportStatus:    (jobId)   => req(`/hr/mailbox-exports/${jobId}`),
  getExportUrl:       (jobId)   => req(`/hr/mailbox-exports/${jobId}/url`),

  // HR — hiring pipeline
  getCandidates:       ()         => req('/hr/candidates'),
  getCandidateHistory: (id)       => req(`/hr/candidates/${id}/history`),
  createCandidate:     (data)     => req('/hr/candidates', { method: 'POST', body: JSON.stringify(data) }),
  updateCandidate:     (id, data) => req(`/hr/candidates/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  candidateResumeUpload: (id, form) => req(`/hr/candidates/${id}/resume`, { method: 'POST', body: form }),
  candidateResumeUrl:  (id)       => req(`/hr/candidates/${id}/resume-url`),

  // HR — AI-assisted interviews (Teams invite + questionnaire + scoring)
  ivTemplates:       ()           => req('/hr/interview-templates'),
  ivTemplateCreate:  (data)       => req('/hr/interview-templates', { method: 'POST', body: JSON.stringify(data) }),
  ivTemplateUpdate:  (id, data)   => req(`/hr/interview-templates/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  ivTemplateDelete:  (id)         => req(`/hr/interview-templates/${id}`, { method: 'DELETE' }),
  ivSchedule:        (cid, data)  => req(`/hr/candidates/${cid}/interviews`, { method: 'POST', body: JSON.stringify(data) }),
  ivList:            (cid)        => req(`/hr/candidates/${cid}/interviews`),
  ivPatch:           (iid, data)  => req(`/hr/interviews/${iid}`, { method: 'PATCH', body: JSON.stringify(data) }),
  ivPullTranscript:  (iid)        => req(`/hr/interviews/${iid}/pull-transcript`, { method: 'POST' }),
  ivAutofill:        (iid)        => req(`/hr/interviews/${iid}/autofill`, { method: 'POST' }),
  ivCalibrate:       (iid)        => req(`/hr/interviews/${iid}/calibrate`, { method: 'POST' }),
  ivLeaderboard:     (tid)        => req(`/hr/interviews/leaderboard?template_id=${tid || ''}`),
  ivRecommend:       (tid)        => req('/hr/interviews/recommend', { method: 'POST', body: JSON.stringify({ template_id: tid || '' }) }),
  ivFinalRound:      (iid, data)  => req(`/hr/interviews/${iid}/final-round`, { method: 'POST', body: JSON.stringify(data) }),

  // HR — documents (private bucket, signed URLs)
  getEmployeeDocs:   (empId)        => req(`/hr/employees/${empId}/documents`),
  uploadEmployeeDoc: (empId, form)  => req(`/hr/employees/${empId}/documents`, { method: 'POST', body: form }),
  getDocUrl:         (docId)        => req(`/hr/documents/${docId}/url`),
  uploadEmployeePhoto: (empId, form) => req(`/hr/employees/${empId}/photo`, { method: 'POST', body: form }),
  deleteEmployeeDoc: (docId)        => req(`/hr/documents/${docId}`, { method: 'DELETE' }),

  // HR — provisioning
  getProvisionSkus:  ()             => req('/hr/provision/skus'),
  provisionEmployee: (empId, data)  => req(`/hr/employees/${empId}/provision`, { method: 'POST', body: JSON.stringify(data) }),
  getProvisionRuns:  (empId)        => req(`/hr/employees/${empId}/provision/runs`),
  syncM365:          ()             => req('/hr/employees/sync-m365', { method: 'POST' }),
  syncM365Photos:    ()             => req('/hr/employees/sync-photos', { method: 'POST' }),
  pushToEntra:       (empId)        => req(`/hr/employees/${empId}/push-to-entra`, { method: 'POST' }),
  resendWelcome:     (empId)        => req(`/hr/employees/${empId}/welcome-email`, { method: 'POST' }),

  // HR — leave tracker
  getLeave:         ()          => req('/hr/leave'),
  getLeaveBalances: (empId, yr) => req(`/hr/leave/balances/${empId}?year=${yr}`),
  setLeaveBalance:  (data)      => req('/hr/leave/balances', { method: 'PUT', body: JSON.stringify(data) }),
  createLeave:      (data)      => req('/hr/leave', { method: 'POST', body: JSON.stringify(data) }),
  decideLeave:      (id, data)  => req(`/hr/leave/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

  // HR — e-sign (templates, envelopes, my-signatures inbox)
  getSignTemplates:   ()          => req('/esign/templates'),
  createSignTemplate: (data)      => req('/esign/templates', { method: 'POST', body: JSON.stringify(data) }),
  updateSignTemplate: (id, data)  => req(`/esign/templates/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteSignTemplate: (id)        => req(`/esign/templates/${id}`, { method: 'DELETE' }),
  seedSignTemplates:  ()          => req('/esign/templates/starters', { method: 'POST' }),
  uploadSignAttachment: (form)    => req('/esign/templates/attachments', { method: 'POST', body: form }),
  getSignAttachmentUrl: (path)    => req(`/esign/templates/attachment-url?path=${encodeURIComponent(path)}`),
  sendSignRequest:    (data)      => req('/esign/requests', { method: 'POST', body: JSON.stringify(data) }),
  sendSignPdf:        (form)      => req('/esign/requests/pdf', { method: 'POST', body: form }),
  getSignRequests:    ()          => req('/esign/requests'),
  getSignRequest:     (id)        => req(`/esign/requests/${id}`),
  remindSign:         (id)        => req(`/esign/requests/${id}/remind`, { method: 'POST' }),
  voidSign:           (id)        => req(`/esign/requests/${id}/void`, { method: 'POST' }),
  downloadSign:       (id)        => req(`/esign/requests/${id}/download`),
  verifySign:         (id)        => req(`/esign/requests/${id}/verify`),
  mySignatures:       ()          => req('/esign/mine'),
  mySignRender:       (pid)       => req(`/esign/mine/${pid}`),
  mySignSubmit:       (pid, data) => req(`/esign/mine/${pid}/sign`, { method: 'POST', body: JSON.stringify(data) }),
  mySignDecline:      (pid, data) => req(`/esign/mine/${pid}/decline`, { method: 'POST', body: JSON.stringify(data) }),
  correctSignParty:   (rid, pid, data) => req(`/esign/requests/${rid}/parties/${pid}`, { method: 'PATCH', body: JSON.stringify(data) }),
  getSignPartyLink:   (rid, pid)  => req(`/esign/requests/${rid}/parties/${pid}/link`),

  // ── Time clock (punch in/out with geofencing) ──────────────────────────────
  timeStatus:        ()          => req(`/timeclock/status?tz_offset_min=${new Date().getTimezoneOffset()}`),
  timePunch:         (data)      => req('/timeclock/punch', { method: 'POST', body: JSON.stringify(data) }),
  timeSelfPunch:     (data)      => req('/timeclock/punch/manual', { method: 'POST', body: JSON.stringify(data) }),
  timeMy:            (start, end) => req(`/timeclock/me?start=${start || ''}&end=${end || ''}`),
  timeTeam:          (start, end) => req(`/timeclock/team?start=${start || ''}&end=${end || ''}`),
  timeAdjustPunch:   (id, data)  => req(`/timeclock/punches/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  timeAddPunch:      (data)      => req('/timeclock/punches', { method: 'POST', body: JSON.stringify(data) }),
  timeExportCsv:     (start, end, mode) => reqBlob(`/timeclock/export.csv?start=${start || ''}&end=${end || ''}&mode=${mode || 'summary'}`),
  timeShotUpload:    (form)      => req('/timeclock/screenshot', { method: 'POST', body: form }),
  timeShots:         (date, email) => req(`/timeclock/screenshots?date=${date || ''}&email=${encodeURIComponent(email || '')}`),
  timeOffCreate:     (data)      => req('/timeclock/timeoff', { method: 'POST', body: JSON.stringify(data) }),
  timeOffMine:       ()          => req('/timeclock/timeoff/mine'),
  timeOffList:       (status)    => req(`/timeclock/timeoff?status=${status || ''}`),
  timeOffDecide:     (id, data)  => req(`/timeclock/timeoff/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  timeApprove:       (data)      => req('/timeclock/approvals', { method: 'POST', body: JSON.stringify(data) }),
  timeApprovalRevoke: (id)       => req(`/timeclock/approvals/${id}`, { method: 'PATCH' }),
  timeBodRecord:     (data)      => req('/timeclock/bod', { method: 'POST', body: JSON.stringify(data) }),
  timeBodLast:       ()          => req('/timeclock/bod/last'),
  timeAgentDownloadUrl: (platform) => req(`/timeclock/agent/download-url?platform=${encodeURIComponent(platform)}`),
  timeAgentUpload:   (platform, formData) => req(`/timeclock/agent/upload?platform=${encodeURIComponent(platform)}`, { method: 'POST', body: formData, timeoutMs: 30 * 60_000 }),
  timeAgentUploadUrl:(platform) => req(`/timeclock/agent/upload-url?platform=${encodeURIComponent(platform)}`),

  // ── Customizable dashboards (drag-and-drop widget layouts) ──
  dashViews:      (target)     => req(`/dashboards/views?target=${encodeURIComponent(target)}`),
  dashCreateView: (body)       => req('/dashboards/views', { method: 'POST', body: JSON.stringify(body) }),
  dashUpdateView: (id, body)   => req(`/dashboards/views/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  dashSetDefault: (id)         => req(`/dashboards/views/${id}/default`, { method: 'PUT' }),
  dashDeleteView: (id)         => req(`/dashboards/views/${id}`, { method: 'DELETE' }),
  dashKpis:       (scope = 'self') => req(`/dashboards/kpis?scope=${encodeURIComponent(scope)}`),

  // ── My HR (employee self-service — own record only) ──
  myHrProfile:     ()      => req('/myhr/profile'),
  personCard:      (q)     => req(`/myhr/person?q=${encodeURIComponent(q)}`),
  myHrProfileSave: (body)  => req('/myhr/profile', { method: 'PUT', body: JSON.stringify(body) }),
  myHrDocs:        ()      => req('/myhr/documents'),
  myHrDocDownload: (rid)   => req(`/myhr/documents/${rid}/download`),
  myPaystubs:      ()      => req('/myhr/paystubs'),
  myPaystubDownload: (did) => req(`/myhr/paystubs/${did}/download`),
  myAssets:        ()      => req('/myhr/assets'),
  myHrRequests:    ()      => req('/myhr/requests'),
  myHrRequestCreate: (body) => req('/myhr/requests', { method: 'POST', body: JSON.stringify(body) }),
  myHrRequestAttach: (form) => req('/myhr/requests/attachment', { method: 'POST', body: form }),
  hrSelfRequests:  (status) => req(`/hr/requests?status=${status || ''}`),
  hrSelfRequestResolve: (rid, body) => req(`/hr/requests/${rid}`, { method: 'PATCH', body: JSON.stringify(body) }),
  hrSelfRequestAttachmentUrl: (rid) => req(`/hr/requests/${rid}/attachment-url`),
  hrSelfRequestAttachToEmployee: (rid, kind) => req(`/hr/requests/${rid}/attach-to-employee`, { method: 'POST', body: JSON.stringify({ kind }) }),
  hrPaystubs:      (eid)   => req(`/hr/employees/${eid}/paystubs`),
  hrPaystubUpload: (eid, form) => req(`/hr/employees/${eid}/paystubs`, { method: 'POST', body: form }),
  timeAgentEnroll:   (data)      => req('/timeclock/agent/enroll', { method: 'POST', body: JSON.stringify(data) }),
  timeAgentDevices:  ()          => req('/timeclock/agent/devices'),
  timeAgentRevoke:   (id)        => req(`/timeclock/agent/devices/${id}`, { method: 'PATCH' }),
  timeActivity:      (email, start, end) => req(`/timeclock/activity?email=${encodeURIComponent(email)}&start=${start}&end=${end}`),
  timeMyActivity:    (date)      => req(`/timeclock/my-activity?date=${date}`),
  timeActivityDay:   (email, date) => req(`/timeclock/activity-day?email=${encodeURIComponent(email)}&date=${date}`),
  // Field-worker location tracking (manager/HR views; device pings use X-Agent-Token from the native app, not these)
  trackLive:         ()            => req('/timeclock/track/live'),
  trackPath:         (email, date) => req(`/timeclock/track/path?email=${encodeURIComponent(email)}&date=${date}`),
  timeShifts:        ()          => req('/timeclock/shifts'),
  timeShiftCreate:   (data)      => req('/timeclock/shifts', { method: 'POST', body: JSON.stringify(data) }),
  timeShiftUpdate:   (id, data)  => req(`/timeclock/shifts/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  timeShiftDelete:   (id)        => req(`/timeclock/shifts/${id}`, { method: 'DELETE' }),
  timeShiftGroups:   ()          => req('/timeclock/shift-groups'),
  timeShiftGroupCreate: (data)   => req('/timeclock/shift-groups', { method: 'POST', body: JSON.stringify(data) }),
  timeShiftGroupSet: (id, data)  => req(`/timeclock/shift-groups/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  timeShiftGroupDelete: (id)     => req(`/timeclock/shift-groups/${id}`, { method: 'DELETE' }),
  timeShiftAssign:   (data)      => req('/timeclock/shift-assign', { method: 'POST', body: JSON.stringify(data) }),
  timeShiftAssignments: ()       => req('/timeclock/shift-assignments'),
  timeMyChat:        ()          => req('/timeclock/my-chat'),
  timeSchedule:      (start, end) => req(`/timeclock/schedule?start=${start}&end=${end}`),
  timeSchedCreate:   (data)      => req('/timeclock/schedule', { method: 'POST', body: JSON.stringify(data) }),
  timeSchedUpdate:   (id, data)  => req(`/timeclock/schedule/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  timeSchedDelete:   (id)        => req(`/timeclock/schedule/${id}`, { method: 'DELETE' }),
  timePayroll:       (email, start, end) => req(`/timeclock/payroll?email=${encodeURIComponent(email)}&start=${start}&end=${end}`),
  timePayrollRate:   (data)      => req('/timeclock/payroll/rate', { method: 'PUT', body: JSON.stringify(data) }),
};

// Public signing page (/sign/{token}) talks to /esign/public/* with plain fetch —
// no MSAL involved, the token in the URL is the credential.
export const API_BASE = BASE;

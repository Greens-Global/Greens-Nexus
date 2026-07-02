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

  // Tasks
  getTasks: () => req("/tasks"),
  createTask: (data) => req("/tasks", { method: "POST", body: JSON.stringify(data) }),
  updateTask: (id, data) => req(`/tasks/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteTask: (id) => req(`/tasks/${id}`, { method: "DELETE" }),

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
  getWorkSites:   ()         => req('/hr/work-sites'),
  createWorkSite: (data)     => req('/hr/work-sites', { method: 'POST', body: JSON.stringify(data) }),
  updateWorkSite: (id, data) => req(`/hr/work-sites/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteWorkSite: (id)       => req(`/hr/work-sites/${id}`, { method: 'DELETE' }),

  // HR — compensation + bank (restricted: hr_comp grant / owner)
  getCompensation:  (id)       => req(`/hr/employees/${id}/compensation`),
  saveCompensation: (id, data) => req(`/hr/employees/${id}/compensation`, { method: 'PUT', body: JSON.stringify(data) }),

  // HR — hiring pipeline
  getCandidates:       ()         => req('/hr/candidates'),
  getCandidateHistory: (id)       => req(`/hr/candidates/${id}/history`),
  createCandidate:     (data)     => req('/hr/candidates', { method: 'POST', body: JSON.stringify(data) }),
  updateCandidate:     (id, data) => req(`/hr/candidates/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

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
  resendWelcome:     (empId)        => req(`/hr/employees/${empId}/welcome-email`, { method: 'POST' }),

  // HR — leave tracker
  getLeave:         ()          => req('/hr/leave'),
  getLeaveBalances: (empId, yr) => req(`/hr/leave/balances/${empId}?year=${yr}`),
  setLeaveBalance:  (data)      => req('/hr/leave/balances', { method: 'PUT', body: JSON.stringify(data) }),
  createLeave:      (data)      => req('/hr/leave', { method: 'POST', body: JSON.stringify(data) }),
  decideLeave:      (id, data)  => req(`/hr/leave/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
};

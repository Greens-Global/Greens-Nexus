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

const MAX_ATTEMPTS = 3;

async function req(path, options = {}, attempt = 1, tokenRefreshed = false) {
  const authHeader = await getAuthHeader(tokenRefreshed);
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...authHeader,
        ...(options.headers ?? {}),
      },
    });
  } catch (err) {
    // fetch() itself threw — offline, dropped connection, or a cold-start
    // timing out the CORS preflight. These show up as "Failed to fetch" and
    // are usually transient (a reload "fixes" them), so retry with backoff
    // instead of surfacing a scary permanent error to the user.
    if (attempt < MAX_ATTEMPTS) {
      await new Promise(r => setTimeout(r, 500 * attempt));
      return req(path, options, attempt + 1, tokenRefreshed);
    }
    throw err;
  }

  // On 401 (expired token), force-refresh MSAL token and retry once
  if (res.status === 401 && !tokenRefreshed) {
    return req(path, options, attempt, true);
  }
  // Retry on 5xx — handles Azure cold-start transient failures
  if (res.status >= 500 && attempt < MAX_ATTEMPTS) {
    await new Promise(r => setTimeout(r, 800));
    return req(path, options, attempt + 1, tokenRefreshed);
  }
  if (!res.ok) {
    let detail;
    try { detail = (await res.json())?.detail; } catch { /* not JSON */ }
    const err = new Error(detail || `API error ${res.status}`);
    err.status = res.status;
    err.detail = detail;
    throw err;
  }
  if (res.status === 204) return null;
  return res.json();
}

// Like req(), but for endpoints that return a file (Excel/PDF export) rather
// than JSON — returns the blob plus the filename the server suggested via
// Content-Disposition, so the caller can trigger a download.
async function reqBlob(path, options = {}, tokenRefreshed = false) {
  const authHeader = await getAuthHeader(tokenRefreshed);
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: { ...authHeader, ...(options.headers ?? {}) },
  });
  if (res.status === 401 && !tokenRefreshed) {
    return reqBlob(path, options, true);
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

  // Assets
  getAssets: () => req("/assets"),
  createAsset: (data) => req("/assets", { method: "POST", body: JSON.stringify(data) }),

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
  getItemsReport:      (params)       => reqBlob(`/items/report?${new URLSearchParams(params)}`),
  getItemsAuditLog:    (params)       => req(`/items/audit-log?${new URLSearchParams(params)}`),
  getItemAllocators:   ()             => req('/items/allocators'),
  getItemCheckouts:    ()             => req('/items/checkouts'),
  createItemCheckout:  (data)         => req('/items/checkouts', { method: 'POST', body: JSON.stringify(data) }),
  updateItemCheckout:  (id, data)     => req(`/items/checkouts/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
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
};

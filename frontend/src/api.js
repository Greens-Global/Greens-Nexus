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

async function req(path, options = {}, attempt = 1) {
  const authHeader = await getAuthHeader();
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...authHeader,
      ...(options.headers ?? {}),
    },
  });
  // On 401 (expired token), force-refresh MSAL token and retry once
  if (res.status === 401 && attempt === 1) {
    const freshHeader = await getAuthHeader(true);
    const res2 = await fetch(`${BASE}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...freshHeader,
        ...(options.headers ?? {}),
      },
    });
    if (!res2.ok) throw new Error(`API error ${res2.status}`);
    if (res2.status === 204) return null;
    return res2.json();
  }
  // Retry once on 5xx — handles Azure cold-start transient failures
  if (res.status >= 500 && attempt === 1) {
    await new Promise(r => setTimeout(r, 800));
    return req(path, options, 2);
  }
  if (!res.ok) throw new Error(`API error ${res.status}`);
  if (res.status === 204) return null;
  return res.json();
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
  assignRole:   (email, role, by)    => req(`/roles/${encodeURIComponent(email)}`, { method: 'PUT', body: JSON.stringify({ role, assigned_by: by }) }),
  syncRoles:    (emails)             => req('/roles/sync', { method: 'POST', body: JSON.stringify({ emails }) }),

  // Notifications (cross-device, stored in Supabase)
  pushNotification: (n)             => req('/notifications', { method: 'POST', body: JSON.stringify(n) }),
  getNotifications: ()               => req('/notifications'),
  markNotifRead:    (id)             => req(`/notifications/${id}/read`, { method: 'PATCH' }),
  markNotifActioned:(id)             => req(`/notifications/${id}/action`, { method: 'PATCH' }),
  deleteNotif:      (id)             => req(`/notifications/${id}`, { method: 'DELETE' }),

  // Inventory Requests (persisted in Supabase)
  getInventoryRequests:    ()          => req('/inventory-requests'),
  createInventoryRequest:  (data)      => req('/inventory-requests', { method: 'POST', body: JSON.stringify(data) }),
  updateInventoryRequest:  (id, data)  => req(`/inventory-requests/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

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

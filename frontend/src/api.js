import { msalInstance, msalReady } from './msalInstance';
import { apiTokenRequest, loginRequest } from './authConfig';
import { BFF_MODE, csrfToken, bffLogin } from './bffAuth';

// Recover a dead session app-wide. When even a FORCE-refreshed token still 401s,
// MSAL's silent hidden-iframe renewal is failing - modern browsers block the
// third-party cookies it needs - so the cached token is dead and can't be renewed
// silently. A top-level interactive login is first-party and isn't subject to that
// block. Centralised here so ANY request's 401 can trigger it, not just the role
// fetch. Guarded HARD so it can never redirect-loop: at most once per 60s, and if
// it recurs 3x in 5 min we STOP and fire `nexus:auth-stuck` for the UI to show a
// manual "sign in again" screen. (Step-up is a 403, so it never lands here.)
let _reauthing = false;
function _maybeReauth() {
  if (_reauthing) return;
  let acct;
  try { acct = msalInstance.getActiveAccount() || msalInstance.getAllAccounts()[0]; } catch { return; }
  if (!acct) return;   // genuinely signed out - the login gate handles that
  const now = Date.now();
  try {
    if (now - Number(sessionStorage.getItem('nexus:reauth-at') || 0) < 60_000) return;
    const win = JSON.parse(sessionStorage.getItem('nexus:reauth-win') || '[]').filter(t => now - t < 5 * 60_000);
    if (win.length >= 2) { window.dispatchEvent(new CustomEvent('nexus:auth-stuck')); return; }
    win.push(now);
    sessionStorage.setItem('nexus:reauth-win', JSON.stringify(win));
    sessionStorage.setItem('nexus:reauth-at', String(now));
  } catch { /* storage blocked - fall through and try once */ }
  _reauthing = true;
  msalInstance.loginRedirect(loginRequest).catch(() => { _reauthing = false; });
}

// BFF cookie mode: all calls go same-origin to /api (the Cloudflare Pages
// Function proxies to the backend, so the session cookie is first-party).
// Default (flag off): the existing MSAL/Bearer flow against VITE_API_BASE.
const BASE = BFF_MODE ? '/api' : (import.meta.env.VITE_API_BASE ?? "http://localhost:8000");

async function getAuthHeader(forceRefresh = false) {
  // BFF mode: identity rides the HttpOnly session cookie - no Bearer token.
  if (BFF_MODE) return {};
  // Wait for MSAL to finish loading its cache before asking for a token.
  // Without this, acquireTokenSilent fails on first render and the request
  // goes out with no Authorization header, causing a 401.
  await msalReady;
  // Prefer the ACTIVE account, not getAllAccounts()[0]: a user signed into more
  // than one Microsoft account (e.g. work + personal) can have the wrong account
  // at [0], whose token the backend rejects with 401. Pin the active account once
  // so every request uses the same identity.
  let account = msalInstance.getActiveAccount() || msalInstance.getAllAccounts()[0];
  // On a cold load the signed-in account can lag msalReady by a moment -
  // handleRedirectPromise is still resolving when the first providers mount and
  // fetch. Firing in that gap sends NO Authorization header, so the request 401s,
  // the caller retries with the token, and it succeeds - but that first-try 401 is
  // logged to the console and looks alarming. Wait briefly for the account so the
  // very first attempt already carries a token. Bounded (~2s); genuinely signed-out
  // users never reach here because the app gates fetches behind AuthenticatedTemplate.
  for (let i = 0; !account && i < 25; i++) {
    await new Promise(r => setTimeout(r, 80));
    account = msalInstance.getActiveAccount() || msalInstance.getAllAccounts()[0];
  }
  if (!account) return {};
  if (!msalInstance.getActiveAccount()) msalInstance.setActiveAccount(account);
  try {
    let result = await msalInstance.acquireTokenSilent({
      ...apiTokenRequest,
      account,
      forceRefresh,
    });
    // MSAL caches the ID and access tokens with SEPARATE lifetimes and decides
    // whether to refresh based on the ACCESS token - so acquireTokenSilent can
    // hand back an ID token that's already expired while its access token is still
    // valid. The Nexus backend authenticates off the ID token (Bearer idToken), so
    // a stale one 401s; the caller's forceRefresh retry then succeeds (the
    // transient 401s that still showed in the console after the account-wait fix).
    // Pre-empt it: if the ID token is at/near expiry, refresh now so the FIRST
    // request already carries a fresh token.
    const exp = result?.idTokenClaims?.exp;
    if (!forceRefresh && typeof exp === 'number' && exp * 1000 < Date.now() + 60_000) {
      result = await msalInstance.acquireTokenSilent({ ...apiTokenRequest, account, forceRefresh: true });
    }
    return { Authorization: `Bearer ${result.idToken}` };
  } catch {
    return {};
  }
}

// Azure App Service on the free/basic tier can take 5-15 seconds to cold-start.
// Network errors (CORS preflight timeout) get 3 attempts with 800ms/1.6s backoff.
// 5xx errors get 4 attempts with 1s/2s/4s exponential backoff - covers warm-up.
const MAX_NET_ATTEMPTS = 3;
const MAX_5XX_ATTEMPTS = 4;
// Each individual fetch is capped at 18s. Without this, a hung backend means
// the browser never resolves the request and the UI appears frozen indefinitely.
// AI endpoints (Claude formats/generates an SOP or course) routinely run longer
// than 18s - they pass a much higher timeout via options.timeoutMs so they don't
// abort with "signal is aborted without reason".
const FETCH_TIMEOUT_MS = 18_000;
const AI_TIMEOUT_MS = 120_000;

// Global health state - broadcast to the rest of the app when the backend goes
// down or comes back so a single reconnecting banner can appear rather than
// every module showing its own error independently.
let _backendDown = false;
let _downCount   = 0;
let _pendingDown = null;          // grace-period timer before the banner is shown
const _healthListeners = new Set();
const DOWN_GRACE_MS = 3500;       // must stay unreachable this long before we alarm
function _emitHealth(down) {
  _backendDown = down;
  _downCount   = down ? _downCount + 1 : 0;
  _healthListeners.forEach(fn => fn(down));
}
function _setBackendDown(down) {
  if (down) {
    // Debounce the DOWN transition. Azure cold-starts (5–15s) make a request fail
    // and then recover seconds later; flashing an alarming red banner for a blip
    // that self-heals is worse than the blip. Only show "reconnecting" if we're
    // STILL failing after a grace period - a success in the meantime cancels it.
    if (_backendDown || _pendingDown) return;
    _pendingDown = setTimeout(() => { _pendingDown = null; _emitHealth(true); }, DOWN_GRACE_MS);
    return;
  }
  // Recovered: cancel any pending alarm and hide the banner immediately.
  if (_pendingDown) { clearTimeout(_pendingDown); _pendingDown = null; }
  if (_backendDown) _emitHealth(false);
}
export function onBackendHealth(fn) {
  _healthListeners.add(fn);
  fn(_backendDown); // fire immediately with current state
  return () => _healthListeners.delete(fn);
}
export function isBackendDown() { return _backendDown; }

// ── Act As (Jul 2026) ──────────────────────────────────────────────────────
// While a session is active, every request (not just Act-As-specific ones)
// carries X-Act-As-Session so the backend's get_current_user overlays the
// impersonated employee's identity - the whole app then just works as that
// employee for free (same role/permissions/data everywhere), no per-view
// changes needed. Persisted in sessionStorage so a page refresh doesn't
// silently drop back to the real account mid-session.
const ACT_AS_KEY = 'nexus:act-as-session';
let _actAsSessionId = sessionStorage.getItem(ACT_AS_KEY) || null;

// TanStack Query cache bridge. api.js stays framework-agnostic - main.jsx hands
// it the queryClient so writes and identity switches can invalidate/clear the
// TanStack cache alongside the legacy _getCache, keeping both coherent while
// screens migrate off cachedGet onto query hooks.
let _queryClient = null;
export function setCacheBridge(client) { _queryClient = client; }

export function getActAsSessionId() { return _actAsSessionId; }
export function setActAsSessionId(id) {
  _actAsSessionId = id;
  if (id) sessionStorage.setItem(ACT_AS_KEY, id);
  else sessionStorage.removeItem(ACT_AS_KEY);
  // Identity just changed - cached GETs (role, directory, pickers) belong to
  // the PREVIOUS identity and must never leak across an Act As boundary.
  _getCache.clear();
  _queryClient?.clear();
}
function _actAsHeader() {
  return _actAsSessionId ? { 'X-Act-As-Session': _actAsSessionId } : {};
}

// ── Keep-warm: REMOVED (Aug 1, 2026) ─────────────────────────────────────────
// There used to be a /health ping here (boot + every 4 min per tab) papering
// over Azure App Service cold starts. "Always On" is now enabled on BOTH the
// dev and prod App Services, so the platform keeps the process warm and the
// ping was pure waste. If cold starts ever come back, check Always On in the
// Azure portal first - do not resurrect the ping.

// FastAPI 422 returns `detail` as an array of {loc, msg, type}. Passing that to
// new Error() stringifies to "[object Object]", which then surfaces in toasts.
// Flatten it to a readable "field: message" sentence; pass strings through.
function _detailToMessage(detail, status) {
  if (Array.isArray(detail)) {
    const parts = detail.map(d => {
      if (typeof d === 'string') return d;
      const field = Array.isArray(d?.loc) ? d.loc.filter(x => x !== 'body').join('.') : '';
      const msg = d?.msg || d?.message || '';
      return field ? `${field}: ${msg}` : msg;
    }).filter(Boolean);
    if (parts.length) return parts.join('; ');
  } else if (typeof detail === 'string' && detail) {
    return detail;
  } else if (detail && typeof detail === 'object' && detail.message) {
    // Structured error body ({ code, message, ... }) - e.g. the timecard
    // unresolved-exceptions block. Callers can still read err.detail for the rest.
    return detail.message;
  }
  return `API error ${status}`;
}

// Only idempotent methods (GET/HEAD) are safe to auto-retry on timeout/5xx.
// A POST/PATCH/PUT/DELETE that committed server-side but exceeded the 18s abort
// (Azure cold start) or 5xx'd after committing would otherwise be re-sent -
// duplicate checkouts/assignments/notifications (P1-10). No method = GET.
function _isRetryable(options) {
  const method = (options.method || 'GET').toUpperCase();
  return method === 'GET' || method === 'HEAD';
}

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
        // BFF mode: send the session cookie; double-submit the CSRF token on writes.
        ...(BFF_MODE ? { credentials: 'include' } : {}),
        headers: {
          // FormData bodies set their own multipart boundary - forcing JSON breaks them
          ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
          ...authHeader,
          ..._actAsHeader(),
          ...(BFF_MODE && (options.method || 'GET').toUpperCase() !== 'GET' ? { 'X-CSRF-Token': csrfToken() } : {}),
          ...(options.headers ?? {}),
        },
      });
    } finally {
      clearTimeout(tid);
    }
  } catch (err) {
    // fetch() itself threw - offline, CORS preflight dropped, cold-start, or timeout.
    // Only retry idempotent requests: a mutation may have committed before the abort.
    if (attempt < MAX_NET_ATTEMPTS && _isRetryable(options)) {
      await new Promise(r => setTimeout(r, 800 * attempt));
      return req(path, options, attempt + 1, tokenRefreshed);
    }
    _setBackendDown(true);
    throw err;
  }

  // BFF mode: a 401 means the session cookie is dead/absent -> server-side login
  // (the replacement for MSAL's token-refresh + interactive reauth).
  if (res.status === 401 && BFF_MODE) {
    // A 401 is usually TRANSIENT, not a dead session: the server's silent token
    // refresh raced this request, or Microsoft blipped for a moment. Retry once
    // (letting that settle) BEFORE the jarring full-page re-login - so a user
    // coming back from lunch isn't bounced through a whole-page sign-in for a
    // momentary hiccup. Only a genuinely dead session (still 401 on retry) redirects.
    if (!tokenRefreshed) {
      await new Promise(r => setTimeout(r, 700));
      return req(path, options, attempt, true);
    }
    bffLogin();
  } else if (res.status === 401 && !tokenRefreshed) {
    // On 401 (expired token), force-refresh MSAL token and retry once
    return req(path, options, attempt, true);
  } else if (res.status === 401 && tokenRefreshed) {
    // Still 401 after a forced refresh: the token is dead and silent renewal can't
    // fix it - recover with a guarded top-level interactive login.
    _maybeReauth();
  }
  // Exponential backoff for 5xx - 1s, 2s, 4s - total ~7s before giving up.
  // Covers typical Azure cold-start without burning too many attempts on real errors.
  // Mutations are never retried - a 5xx can arrive after the write committed.
  if (res.status >= 500 && attempt < MAX_5XX_ATTEMPTS && _isRetryable(options)) {
    await new Promise(r => setTimeout(r, Math.min(1000 * 2 ** (attempt - 1), 4000)));
    return req(path, options, attempt + 1, tokenRefreshed);
  }
  if (!res.ok) {
    let detail;
    try { detail = (await res.json())?.detail; } catch { /* not JSON */ }
    const err = new Error(_detailToMessage(detail, res.status));
    err.status = res.status;
    err.detail = detail;
    if (res.status >= 500) _setBackendDown(true);
    throw err;
  }

  // Successful response - backend is up
  _setBackendDown(false);
  // Any successful mutation invalidates the whole GET cache: the next read of
  // anything refetches, so cachedGet can never serve a pre-write value to the
  // user who just wrote (other users' writes are bounded by the TTLs below).
  // Same for the TanStack cache - a broad invalidate keeps migrated query hooks
  // coherent; screens tighten this to specific keys as they convert.
  if ((options.method || 'GET').toUpperCase() !== 'GET') {
    _getCache.clear();
    _queryClient?.invalidateQueries();
  }
  if (res.status === 204) return null;
  return res.json();
}

// Short-lived GET cache + in-flight dedup for reference data that rarely changes
// (allocators, approvers, people directory). Several tabs/modals each fetch these
// on mount, firing the same request many times - slow and wasteful on throttled
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
// than JSON - returns the blob plus the filename the server suggested via
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
        ...(BFF_MODE ? { credentials: 'include' } : {}),
        headers: { ...authHeader, ..._actAsHeader(), ...(options.headers ?? {}) },
      });
    } finally {
      clearTimeout(tid);
    }
  } catch (err) {
    // Same idempotency rule as req() - don't re-send a mutation that may have run.
    if (attempt < MAX_NET_ATTEMPTS && _isRetryable(options)) {
      await new Promise(r => setTimeout(r, 800 * attempt));
      return reqBlob(path, options, attempt + 1, tokenRefreshed);
    }
    throw err;
  }
  if (res.status === 401 && BFF_MODE) {
    // Same as req(): absorb a transient 401 with one retry before a full-page re-login.
    if (!tokenRefreshed) {
      await new Promise(r => setTimeout(r, 700));
      return reqBlob(path, options, attempt, true);
    }
    bffLogin();
  } else if (res.status === 401 && !tokenRefreshed) {
    return reqBlob(path, options, attempt, true);
  } else if (res.status === 401 && tokenRefreshed) {
    _maybeReauth();
  }
  if (res.status >= 500 && attempt < MAX_5XX_ATTEMPTS && _isRetryable(options)) {
    await new Promise(r => setTimeout(r, Math.min(1000 * 2 ** (attempt - 1), 4000)));
    return reqBlob(path, options, attempt + 1, tokenRefreshed);
  }
  if (!res.ok) {
    let detail;
    try { detail = (await res.json())?.detail; } catch { /* not JSON */ }
    const err = new Error(_detailToMessage(detail, res.status));
    err.status = res.status;
    err.detail = detail;
    throw err;
  }
  const disposition = res.headers.get('content-disposition') || '';
  // filename* (RFC 5987) wins when present - it is the one that survives
  // non-ASCII names; plain filename= is the ASCII fallback beside it.
  const ext = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  const plain = disposition.match(/filename="?([^";]+)"?/);
  let filename = 'download';
  if (ext) { try { filename = decodeURIComponent(ext[1]); } catch { filename = ext[1]; } }
  else if (plain) filename = plain[1];
  return { blob: await res.blob(), filename };
}

export const api = {
  // Dashboard
  getDashboardSummary: () => req("/dashboard/summary"),

  // Tasks - core (bodies are snake_case; the TasksContext maps to/from camelCase)
  getTasks: () => req("/tasks"),
  // Incremental fetch - {tasks, deletedIds, serverTime}. `since` blank returns
  // everything (no deletions), so this serves both the mount load and every
  // repeated refresh through one path. See TasksContext's sinceRef.
  getTasksDelta: (since = '') => req(`/tasks/delta${since ? `?since=${encodeURIComponent(since)}` : ''}`),
  // Header search: tasks, projects, portfolios, teams and people in one call,
  // already scoped to what the caller may see.
  // 20 is the endpoint's cap. Six looked final when 92 subtasks matched.
  searchTaskModule: (q, limit = 20) => req(`/tasks/search?q=${encodeURIComponent(q)}&limit=${limit}`),
  // A person's page: who they are, the work they hold, their projects and teams.
  getPersonProfile: (email) => req(`/tasks/people/${encodeURIComponent(email)}`),
  createTask: (data) => req("/tasks", { method: "POST", body: JSON.stringify(data) }),
  updateTask: (id, data) => req(`/tasks/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteTask: (id) => req(`/tasks/${id}`, { method: "DELETE" }),
  bulkUpdateTasks: (ids, patch) => req("/tasks/bulk", { method: "POST", body: JSON.stringify({ ids, patch }) }),
  // Tasks as .xlsx. reqBlob, not a plain link: the endpoint is bearer-
  // authenticated. Blank filter values are dropped so the server sees "no
  // constraint" rather than an empty-string match.
  exportTasksExcel: (filters = {}) => {
    const qs = new URLSearchParams();
    Object.entries(filters).forEach(([k, v]) => {
      if (v !== '' && v !== null && v !== undefined) qs.set(k, v);
    });
    // The server names the file after the export date and runs UTC, which is
    // already the previous day for an evening export in India - so send the
    // browser's own date rather than letting the file be stamped yesterday.
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    qs.set('today', `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
    return reqBlob(`/tasks/export/excel?${qs}`);
  },
  // Task comments / attachments / activity
  getTaskComments: (id) => req(`/tasks/${id}/comments`),
  addTaskComment: (id, data) => req(`/tasks/${id}/comments`, { method: "POST", body: JSON.stringify(data) }),
  editTaskComment: (cid, data) => req(`/tasks/comments/${cid}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteTaskComment: (cid) => req(`/tasks/comments/${cid}`, { method: "DELETE" }),
  // Description editor's AI rephrase - returns a suggestion the user accepts or
  // discards; it never writes to the task.
  taskAiRephrase: (data) => req("/task-ai/rephrase", { method: "POST", body: JSON.stringify(data), timeoutMs: 120000 }),
  getTaskAttachments: (id) => req(`/tasks/${id}/attachments`),
  addTaskAttachment: (id, data) => req(`/tasks/${id}/attachments`, { method: "POST", body: JSON.stringify(data) }),
  deleteTaskAttachment: (aid) => req(`/tasks/attachments/${aid}`, { method: "DELETE" }),
  ocrImage: (file) => { const fd = new FormData(); fd.append("image", file); return req("/task-ocr", { method: "POST", body: fd, timeoutMs: 60_000 }); },
  getTaskActivity: (id) => req(`/tasks/${id}/activity`),
  getGlobalTaskActivity: () => req("/tasks/activity"),
  // Sections & custom statuses (board columns)
  getTaskSections: () => req("/tasks/meta/sections"),
  createTaskSection: (data) => req("/tasks/meta/sections", { method: "POST", body: JSON.stringify(data) }),
  updateTaskSection: (id, data) => req(`/tasks/meta/sections/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteTaskSection: (id) => req(`/tasks/meta/sections/${id}`, { method: "DELETE" }),
  getTaskCustomStatuses: () => req("/tasks/meta/custom-statuses"),
  createTaskCustomStatus: (data) => req("/tasks/meta/custom-statuses", { method: "POST", body: JSON.stringify(data) }),
  updateTaskCustomStatus: (id, data) => req(`/tasks/meta/custom-statuses/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteTaskCustomStatus: (id) => req(`/tasks/meta/custom-statuses/${id}`, { method: "DELETE" }),
  // Projects / portfolios / departments / member requests
  getTaskProjects: () => req("/task-projects"),
  createTaskProject: (data) => req("/task-projects", { method: "POST", body: JSON.stringify(data) }),
  updateTaskProject: (id, data) => req(`/task-projects/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  // deleteInAsana: the operator's explicit answer to "also delete it in Asana?".
  // Omitted (false) means Nexus-only - the Asana project survives so it can be
  // imported again from scratch.
  deleteTaskProject: (id, deleteInAsana = false) =>
    req(`/task-projects/${id}${deleteInAsana ? "?delete_in_asana=true" : ""}`, { method: "DELETE" }),
  // Department names only, readable by anyone in the task module (the People
  // module's own listing needs HR access) - see list_project_departments.
  getProjectDepartments: () => req("/task-projects/meta/departments"),
  getTaskProjectAsanaLink: (id) => req(`/task-projects/${id}/asana-link`),
  // Fills team_id on tasks whose project has exactly one team. Dry run by default.
  backfillTaskTeams: (apply) => req(`/task-projects/backfill-teams?apply=${apply ? 'true' : 'false'}`, { method: 'POST', timeoutMs: 120000 }),
  getTaskPortfolios: () => req("/task-portfolios"),
  createTaskPortfolio: (data) => req("/task-portfolios", { method: "POST", body: JSON.stringify(data) }),
  updateTaskPortfolio: (id, data) => req(`/task-portfolios/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteTaskPortfolio: (id) => req(`/task-portfolios/${id}`, { method: "DELETE" }),
  getTaskTeams: () => req("/task-teams"),
  createTaskTeam: (data) => req("/task-teams", { method: "POST", body: JSON.stringify(data) }),
  updateTaskTeam: (id, data) => req(`/task-teams/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteTaskTeam: (id) => req(`/task-teams/${id}`, { method: "DELETE" }),
  getTaskMemberRequests: () => req("/task-member-requests"),
  createTaskMemberRequest: (data) => req("/task-member-requests", { method: "POST", body: JSON.stringify(data) }),
  decideTaskMemberRequest: (id, status) => req(`/task-member-requests/${id}/decide`, { method: "POST", body: JSON.stringify({ status }) }),
  // Saved views / automation rules / templates / intake forms / custom fields
  getTaskSavedViews: () => req("/task-saved-views"),
  createTaskSavedView: (data) => req("/task-saved-views", { method: "POST", body: JSON.stringify(data) }),
  deleteTaskSavedView: (id) => req(`/task-saved-views/${id}`, { method: "DELETE" }),
  getTicketViews: () => req("/task-ticket-views"),
  createTicketView: (data) => req("/task-ticket-views", { method: "POST", body: JSON.stringify(data) }),
  deleteTicketView: (id) => req(`/task-ticket-views/${id}`, { method: "DELETE" }),
  getTicketCompanies: () => req("/ticket-companies"),
  getTicketDepartments: () => req("/ticket-departments"),
  // Only the departments of the caller's own company - what ticket intake
  // offers now that company is resolved server-side instead of asked for.
  getMyTicketDepartments: () => req("/ticket-departments?mine=true"),
  asanaListProjects: (data) => req("/task-asana-projects", { method: "POST", body: JSON.stringify(data), timeoutMs: 60000 }),
  asanaImport: (data) => req("/task-asana-import", { method: "POST", body: JSON.stringify(data), timeoutMs: 600000 }),
  getAsanaSyncConfig: () => req("/asana-sync/config"),
  setAsanaSyncConfig: (data) => req("/asana-sync/config", { method: "PUT", body: JSON.stringify(data) }),
  setAsanaProjectMap: (data) => req("/asana-sync/projects", { method: "PUT", body: JSON.stringify(data) }),
  asanaSyncPull: () => req("/asana-sync/pull", { method: "POST", timeoutMs: 600000 }),
  // Additive pull: create only the Asana tasks Nexus is missing; never touch an
  // existing task. Safe when Nexus holds edits Asana doesn't.
  asanaSyncPullNew: () => req("/asana-sync/pull-new", { method: "POST", timeoutMs: 600000 }),
  asanaSyncPullPersonal: () => req("/asana-sync/pull-personal", { method: "POST", timeoutMs: 600000 }),
  asanaSyncPushAll: () => req("/asana-sync/push-all", { method: "POST", timeoutMs: 600000 }),
  asanaSyncDedupe: (apply) => req(`/asana-sync/dedupe?apply=${apply ? "true" : "false"}`, { method: "POST", timeoutMs: 600000 }),
  // Why assignees are or are not reaching Asana - the one field that can fail
  // on its own, because it is the only one that must be translated (Nexus email
  // -> Asana user gid) rather than copied.
  asanaAssigneeCheck: () => req("/asana-sync/assignee-check"),
  // Asana shows no workspace id in its UI and the ids in its URLs are PROJECT
  // ids - so offer a picker rather than have one pasted into the wrong field.
  asanaWorkspaces:    () => req("/asana-sync/workspaces"),
  // Walks every project in the workspace - same 10-min ceiling as Pull/Push all.
  // Starts a background job and returns it right away; a whole workspace takes
  // minutes and Azure kills any request at ~230s. Poll asanaSyncImportAllStatus.
  asanaSyncImportAll: () => req("/asana-sync/import-all", { method: "POST" }),
  asanaSyncImportAllStatus: () => req("/asana-sync/import-all/status"),
  // Asks the run to stop at the next project boundary; it does not kill it.
  asanaSyncImportAllCancel: () => req("/asana-sync/import-all/cancel", { method: "POST" }),
  asanaSyncPurgeOrphans: (apply) => req(`/asana-sync/purge-orphans?apply=${apply ? "true" : "false"}`, { method: "POST", timeoutMs: 600000 }),
  getAsanaSyncProjects: () => req("/asana-sync/asana-projects", { timeoutMs: 60000 }),
  getAsanaWebhooks: () => req("/asana-sync/webhooks"),
  registerAsanaWebhooks: (data) => req("/asana-sync/webhooks", { method: "POST", body: JSON.stringify(data), timeoutMs: 60000 }),
  // ── Per-user Asana connection (Account Settings) ──
  // Personal, not admin: each of these acts on the signed-in user's own grant.
  // No endpoint here ever returns the token itself.
  asanaOauthStatus:     () => req("/asana-oauth/status"),
  asanaOauthStart:      () => req("/asana-oauth/start", { method: "POST" }),
  asanaOauthDisconnect: () => req("/asana-oauth/me", { method: "DELETE" }),
  // Live check: would a comment posted NOW go out as me, or as the shared
  // sync account - and if the latter, why. Calls Asana for real.
  asanaOauthCheck:      () => req("/asana-oauth/check"),
  // Counts every Asana task assigned to ME (my own grant sees my private ones)
  // and says which are not in Nexus. Long: pages the whole list.
  asanaOauthCoverage:   () => req("/asana-oauth/coverage", { timeoutMs: 300000 }),
  // Pulls the tasks /coverage listed as missing, through MY grant. Additive.
  asanaOauthRescue:     () => req("/asana-oauth/coverage/rescue", { method: "POST", timeoutMs: 600000 }),
  deleteAsanaWebhooks: () => req("/asana-sync/webhooks", { method: "DELETE", timeoutMs: 60000 }),
  getTaskAutomationRules: () => req("/task-automation-rules"),
  createTaskAutomationRule: (data) => req("/task-automation-rules", { method: "POST", body: JSON.stringify(data) }),
  updateTaskAutomationRule: (id, data) => req(`/task-automation-rules/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteTaskAutomationRule: (id) => req(`/task-automation-rules/${id}`, { method: "DELETE" }),
  getTaskTemplates: () => req("/task-templates"),
  createTaskTemplate: (data) => req("/task-templates", { method: "POST", body: JSON.stringify(data) }),
  deleteTaskTemplate: (id) => req(`/task-templates/${id}`, { method: "DELETE" }),
  // Project templates - a whole project saved as a reusable blueprint. Distinct
  // from the single-task templates above (see models.TaskProjectTemplate).
  // Building a project can mint a hundred rows, so use/duplicate get a longer
  // timeout than the default.
  getTaskProjectTemplates: () => req("/task-project-templates"),
  createTaskProjectTemplate: (data) => req("/task-project-templates", { method: "POST", body: JSON.stringify(data), timeoutMs: 120000 }),
  updateTaskProjectTemplate: (id, data) => req(`/task-project-templates/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteTaskProjectTemplate: (id) => req(`/task-project-templates/${id}`, { method: "DELETE" }),
  useTaskProjectTemplate: (id, data) => req(`/task-project-templates/${id}/use`, { method: "POST", body: JSON.stringify(data || {}), timeoutMs: 120000 }),
  // Refresh a saved template's payload from its source project, in place -
  // keeps the template's name, category, sharing and use count.
  recaptureTaskProjectTemplate: (id, data) => req(`/task-project-templates/${id}/recapture`, { method: "POST", body: JSON.stringify(data || {}), timeoutMs: 120000 }),
  duplicateTaskProject: (id, data) => req(`/task-projects/${id}/duplicate`, { method: "POST", body: JSON.stringify(data || {}), timeoutMs: 120000 }),
  getTaskProjectTemplatePreview: (id, params = {}) => req(`/task-projects/${id}/template-preview?${new URLSearchParams(params)}`),
  getTaskIntakeForms: () => req("/task-intake-forms"),
  createTaskIntakeForm: (data) => req("/task-intake-forms", { method: "POST", body: JSON.stringify(data) }),
  deleteTaskIntakeForm: (id) => req(`/task-intake-forms/${id}`, { method: "DELETE" }),
  getTaskCustomFields: () => req("/task-custom-fields"),
  createTaskCustomField: (data) => req("/task-custom-fields", { method: "POST", body: JSON.stringify(data) }),
  updateTaskCustomField: (id, data) => req(`/task-custom-fields/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteTaskCustomField: (id) => req(`/task-custom-fields/${id}`, { method: "DELETE" }),
  // Tickets
  getTaskTickets: () => req("/task-tickets"),
  // The requester's own tickets, scoped server-side - the Support page's list.
  // The unscoped call above is the agent queue and carries every ticket in the
  // company, so filtering in the browser would still ship them all.
  getMyTickets: () => req("/task-tickets?mine=true"),
  createTaskTicket: (data) => req("/task-tickets", { method: "POST", body: JSON.stringify(data) }),
  updateTaskTicket: (id, data) => req(`/task-tickets/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteTaskTicket: (id) => req(`/task-tickets/${id}`, { method: "DELETE" }),
  getTicketComments: (id) => req(`/task-tickets/${id}/comments`),
  addTicketComment: (id, data) => req(`/task-tickets/${id}/comments`, { method: "POST", body: JSON.stringify(data) }),
  deleteTicketComment: (cid) => req(`/task-tickets/comments/${cid}`, { method: "DELETE" }),
  getTicketAttachments: (id) => req(`/task-tickets/${id}/attachments`),
  addTicketAttachment: (id, data) => req(`/task-tickets/${id}/attachments`, { method: "POST", body: JSON.stringify(data) }),
  deleteTicketAttachment: (aid) => req(`/task-tickets/attachments/${aid}`, { method: "DELETE" }),
  getTicketActivity: (id) => req(`/task-tickets/${id}/activity`),
  addTicketLink: (id, data) => req(`/task-tickets/${id}/links`, { method: "POST", body: JSON.stringify(data) }),
  removeTicketLink: (id, targetId) => req(`/task-tickets/${id}/links/${targetId}`, { method: "DELETE" }),
  escalateTicket: (id) => req(`/task-tickets/${id}/escalate`, { method: "POST" }),
  decideTicketApproval: (id, decision, note) => req(`/task-tickets/${id}/approval`, { method: "POST", body: JSON.stringify({ decision, note }) }),
  // IT Admin routes a parked request to whoever signs it off (backend refuses anyone else).
  requestTicketApproval: (id, approverEmail, note) => req(`/task-tickets/${id}/request-approval`, { method: "POST", body: JSON.stringify({ approver_email: approverEmail, note }) }),
  // Am I on the service desk? Its own endpoint because the desk roster lives in
  // the notify settings, which are manager+ only - an agent who is not a manager
  // could not read their own membership from there.
  getMyTicketAccess: () => req("/task-tickets/my-access"),
  // Ticket Outlook notification workflow - admin settings + delivery log (manager+)
  getTicketNotifySettings: () => req("/task-tickets/notify/settings"),
  updateTicketNotifySettings: (patch) => req("/task-tickets/notify/settings", { method: "PUT", body: JSON.stringify(patch) }),
  getTicketNotifyLog: (params = {}) => req(`/task-tickets/notify/log?${new URLSearchParams(params).toString()}`),
  // Task Outlook notification workflow - admin settings + delivery log (manager+)
  getTaskNotifySettings: () => req("/tasks/notify/settings"),
  updateTaskNotifySettings: (patch) => req("/tasks/notify/settings", { method: "PUT", body: JSON.stringify(patch) }),
  getTaskNotifyLog: (params = {}) => req(`/tasks/notify/log?${new URLSearchParams(params).toString()}`),
  // Replies mailed back to a task notification (manager+). The drain normally
  // runs itself every minute on the deployed API; this triggers one pass now.
  getTaskInboundLog: (params = {}) => req(`/tasks/inbound/log?${new URLSearchParams(params).toString()}`),
  drainTaskInbox: () => req("/tasks/inbound/drain", { method: "POST" }),
  // Ticket components / categories
  getTicketComponents: () => req("/task-ticket-components"),
  addTicketComponent: (data) => req("/task-ticket-components", { method: "POST", body: JSON.stringify(data) }),
  deleteTicketComponent: (id) => req(`/task-ticket-components/${id}`, { method: "DELETE" }),
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

  // Knowledge Base - DB-backed SOP / Manual / Guide library
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
  getKbFeedback:    (id)        => req(`/knowledge-base/documents/${id}/feedback`),
  submitKbFeedback: (id, helpful) => req(`/knowledge-base/documents/${id}/feedback`, { method: "POST", body: JSON.stringify({ helpful }) }),
  getKbRelated:     (id)        => req(`/knowledge-base/documents/${id}/related`),
  setKbContentText: (id, text)  => req(`/knowledge-base/documents/${id}/content-text`, { method: "PATCH", body: JSON.stringify({ text }) }),
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
  startKbRun:       (docId)        => req(`/knowledge-base/documents/${docId}/runs`, { method: "POST" }),
  updateKbRun:      (runId, data)  => req(`/knowledge-base/runs/${runId}`, { method: "PATCH", body: JSON.stringify(data) }),
  getMyKbRuns:      ()             => req("/knowledge-base/my-runs"),
  getKbRuns:        (limit = 60)   => req(`/knowledge-base/runs?limit=${limit}`),
  getKbOriginal:    (id)           => req(`/knowledge-base/documents/${id}/original`),
  cleanupKbTitles:  (dryRun = true) => req(`/knowledge-base/documents/cleanup-titles?dry_run=${dryRun}`, { method: "POST" }),
  aiSuggestKbMeta:  (data)         => req("/knowledge-base/ai-suggest-metadata", { method: "POST", body: JSON.stringify(data), timeoutMs: AI_TIMEOUT_MS }),
  // Services (Department -> Service tier)
  getKbServices:    (department = '') => req(`/knowledge-base/services${department ? `?department=${encodeURIComponent(department)}` : ''}`),
  createKbService:  (data)         => req("/knowledge-base/services", { method: "POST", body: JSON.stringify(data) }),
  updateKbService:  (id, data)     => req(`/knowledge-base/services/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteKbService:  (id)           => req(`/knowledge-base/services/${id}`, { method: "DELETE" }),
  // Tags (managed vocabulary)
  getKbTags:        ()             => req("/knowledge-base/tags"),
  createKbTag:      (data)         => req("/knowledge-base/tags", { method: "POST", body: JSON.stringify(data) }),
  updateKbTag:      (id, data)     => req(`/knowledge-base/tags/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteKbTag:      (id)           => req(`/knowledge-base/tags/${id}`, { method: "DELETE" }),

  // Assets
  getAssets: () => req("/assets"),
  createAsset: (data) => req("/assets", { method: "POST", body: JSON.stringify(data) }),

  // Asset Management (property portfolio) - whole-workspace load/save.
  getPropertyWorkspace:  ()   => req("/property-assets/workspace"),
  // Tiny {_ts} freshness marker so the background poll skips the full-blob pull
  // when nothing changed (big egress saver).
  getPropertyWorkspaceTs: ()  => req("/property-assets/workspace/ts"),
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
  getExternalLinksMeta: () => req("/external-links/meta"),
  getExternalLinksTaxonomy: () => req("/external-links/taxonomy"),
  createExternalLinkTaxonomy: (kind, name) => req("/external-links/taxonomy", { method: "POST", body: JSON.stringify({ kind, name }) }),
  renameExternalLinkTaxonomy: (id, name) => req(`/external-links/taxonomy/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  deleteExternalLinkTaxonomy: (id) => req(`/external-links/taxonomy/${id}`, { method: "DELETE" }),
  previewExternalLink: (url) => req(`/external-links/preview?${new URLSearchParams({ url })}`),
  createExternalLink: (data) => req("/external-links", { method: "POST", body: JSON.stringify(data) }),
  updateExternalLink: (id, data) => req(`/external-links/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteExternalLink: (id) => req(`/external-links/${id}`, { method: "DELETE" }),
  clickExternalLink: (id) => req(`/external-links/${id}/click`, { method: "PATCH" }),
  reorderExternalLinks: (entries) => req("/external-links/reorder", { method: "PATCH", body: JSON.stringify(entries) }),
  importExternalLinks: (rows) => req("/external-links/import", { method: "POST", body: JSON.stringify({ rows }) }),
  getExternalLinksImportTemplate: () => reqBlob("/external-links/import-template"),
  refreshLinkDescription: (id) => req(`/external-links/${id}/refresh-description`, { method: "POST" }),
  refreshAllLinkDescriptions: () => req("/external-links/refresh-descriptions", { method: "POST" }),

  // Personal Links - private, owner-scoped shortcuts (never shared/admin-visible)
  getPersonalLinks: () => req("/personal-links"),
  createPersonalLink: (data) => req("/personal-links", { method: "POST", body: JSON.stringify(data) }),
  updatePersonalLink: (id, data) => req(`/personal-links/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deletePersonalLink: (id) => req(`/personal-links/${id}`, { method: "DELETE" }),
  clickPersonalLink: (id) => req(`/personal-links/${id}/click`, { method: "PATCH" }),
  reorderPersonalLinks: (entries) => req("/personal-links/reorder", { method: "PATCH", body: JSON.stringify(entries) }),

  // Link Layout - per-user Links Module personalization (ordering, folders,
  // favorites), backend-persisted so it follows the account across devices
  // rather than living in localStorage. The bare endpoints below always
  // target "the" default Link View (auto-created on first write); pass a
  // view id to target a specific one instead - useLinkLayout.js's editing
  // flow does this while a named view other than the default is active.
  getLinkLayout: (viewId) => req(`/link-layout${viewId ? `?view=${viewId}` : ''}`),
  saveLinkLayout: (body, viewId) => req(`/link-layout${viewId ? `?view=${viewId}` : ''}`, { method: "PUT", body: JSON.stringify(body) }),
  resetLinkLayout: (scope, viewId) => {
    const params = new URLSearchParams();
    if (scope) params.set('scope', scope);
    if (viewId) params.set('view', viewId);
    const qs = params.toString();
    return req(`/link-layout${qs ? `?${qs}` : ''}`, { method: "DELETE" });
  },

  // Link Views - named, saveable External Links arrangements (Aug 14),
  // mirrors the Dashboard's own view CRUD (dashViews/dashCreateView/etc)
  // one screen over: no target/scope/department, every view is personal.
  listLinkViews:   ()             => req('/link-layout/views'),
  createLinkView:  (body)         => req('/link-layout/views', { method: 'POST', body: JSON.stringify(body) }),
  updateLinkView:  (id, body)     => req(`/link-layout/views/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  setDefaultLinkView: (id)        => req(`/link-layout/views/${id}/default`, { method: 'PUT' }),
  deleteLinkView:  (id)           => req(`/link-layout/views/${id}`, { method: 'DELETE' }),

  // Nexus Roles
  getMyRole:    ()                    => cachedGet('/roles/me'),
  getAllRoles:   ()                   => req('/roles'),
  assignRole:   (email, role, by, displayName) => req(`/roles/${encodeURIComponent(email)}`, { method: 'PUT', body: JSON.stringify({ role, assigned_by: by, display_name: displayName || '' }) }),
  syncRoles:    (emails)             => req('/roles/sync', { method: 'POST', body: JSON.stringify({ emails }) }),

  // Access Groups
  getGroups:         ()                  => cachedGet('/groups', 30_000),
  createGroup:       (body)              => req('/groups', { method: 'POST', body: JSON.stringify(body) }),
  updateGroup:       (id, body)          => req(`/groups/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteGroup:       (id)                => req(`/groups/${id}`, { method: 'DELETE' }),
  addGroupMembers:   (id, emails)        => req(`/groups/${id}/members`, { method: 'POST', body: JSON.stringify({ emails }) }),
  removeGroupMember: (id, email)         => req(`/groups/${id}/members/${encodeURIComponent(email)}`, { method: 'DELETE' }),
  assignGroupRole:   (id, role, by)      => req(`/groups/${id}/assign-role`, { method: 'POST', body: JSON.stringify({ role, assigned_by: by }) }),

  // External Users (Entra B2B guest allowlist - Roles & Access People tab, Aug 18)
  getExternalUsers:     ()            => req('/external-users'),
  createExternalUser:   (data)        => req('/external-users', { method: 'POST', body: JSON.stringify(data) }),
  updateExternalUser:   (email, data) => req(`/external-users/${encodeURIComponent(email)}`, { method: 'PATCH', body: JSON.stringify(data) }),
  resendExternalInvite: (email)       => req(`/external-users/${encodeURIComponent(email)}/invite`, { method: 'POST' }),
  removeExternalUser:   (email)       => req(`/external-users/${encodeURIComponent(email)}`, { method: 'DELETE' }),

  // Job Roles (Roles & Access redesign) - a job role is a group template with a tier
  getJobRoles:       ()                  => req('/jobroles'),
  createJobRole:     (body)              => req('/jobroles', { method: 'POST', body: JSON.stringify(body) }),
  updateJobRole:     (id, body)          => req(`/jobroles/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteJobRole:     (id)                => req(`/jobroles/${id}`, { method: 'DELETE' }),
  assignJobRole:     (id, email)         => req(`/jobroles/${id}/assign`, { method: 'POST', body: JSON.stringify({ email }) }),
  unassignJobRole:   (id, email)         => req(`/jobroles/${id}/unassign`, { method: 'POST', body: JSON.stringify({ email }) }),
  getEffectiveAccess: (email)            => req(`/jobroles/effective/${encodeURIComponent(email)}`),
  applyJobRoleManager: (id, manager_email) => req(`/jobroles/${id}/apply-manager`, { method: 'POST', body: JSON.stringify({ manager_email }) }),
  // Row-level access scopes (sandbox external users to specific companies)
  getAccessScopes:   (email)             => req(`/access-scopes/${encodeURIComponent(email)}`),
  addAccessScope:    (email, body)       => req(`/access-scopes/${encodeURIComponent(email)}`, { method: 'POST', body: JSON.stringify(body) }),
  deleteAccessScope: (email, scopeId)    => req(`/access-scopes/${encodeURIComponent(email)}/${encodeURIComponent(scopeId)}`, { method: 'DELETE' }),

  // Testing module (QA) - dev-only, endpoints 404 unless NEXUS_QA_MODULE is set
  qaEnabled:        ()            => cachedGet('/qa/enabled', 300_000),
  qaCases:          ()            => req('/qa/cases'),
  qaCreateCase:     (body)        => req('/qa/cases', { method: 'POST', body: JSON.stringify(body) }),
  qaUpdateCase:     (id, body)    => req(`/qa/cases/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  qaRuns:           ()            => req('/qa/runs'),
  qaCreateRun:      (name)        => req('/qa/runs', { method: 'POST', body: JSON.stringify({ name }) }),
  qaDeleteRun:      (runId)       => req(`/qa/runs/${runId}`, { method: 'DELETE' }),
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

  // Inventory Requests (legacy stack being retired - P2-1). The item/request CRUD
  // wrappers had no remaining callers and were removed; only the allocators list
  // survives (its backend endpoint is kept and it's still used by NotificationBell
  // + the dashboard panels).
  // Legacy /inventory-requests router was retired - the equivalent Nexus-People
  // allocator list now lives on the items router. Kept the name; repointed the URL.
  getInventoryAllocators:  ()          => req('/items/allocators'),

  // Items - new individual-unit system
  getItems:            (params = {})  => req(`/items?${new URLSearchParams(params)}`),
  // Tiny change-digest {items, checkouts} for the fallback poll - lets it re-pull
  // the full catalog only when something actually changed (huge egress saver).
  getItemsSignature:   ()             => req('/items/signature'),
  createItem:          (data)         => req('/items', { method: 'POST', body: JSON.stringify(data) }),
  importItems:         (items)        => req('/items/import', { method: 'POST', body: JSON.stringify({ items }) }),
  updateItem:          (id, data)     => req(`/items/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteItem:          (id)           => req(`/items/${id}`, { method: 'DELETE' }),
  bulkDeleteItems:     (ids)          => req('/items/bulk-delete', { method: 'POST', body: JSON.stringify({ ids }) }),
  bulkUpdateItems:     (ids, fields)  => req('/items/bulk-update', { method: 'POST', body: JSON.stringify({ ids, fields }) }),
  // Soft-delete recycle bin (Ankush) - deleted items are restorable
  getDeletedItems:     ()             => req('/items/deleted'),
  restoreItem:         (id)           => req(`/items/${id}/restore`, { method: 'POST', body: JSON.stringify({}) }),
  bulkRestoreItems:    (ids)          => req('/items/bulk-restore', { method: 'POST', body: JSON.stringify({ ids }) }),
  // Admin-defined custom fields surfaced in the item Details panel (Ankush)
  getItemCustomFields: ()             => req('/items/custom-fields'),
  createItemCustomField: (d)          => req('/items/custom-fields', { method: 'POST', body: JSON.stringify(d) }),
  updateItemCustomField: (id, d)      => req(`/items/custom-fields/${id}`, { method: 'PATCH', body: JSON.stringify(d) }),
  deleteItemCustomField: (id)         => req(`/items/custom-fields/${id}`, { method: 'DELETE' }),
  getItemTypes:        ()             => cachedGet('/items/types'),
  addItemType:         (name)         => req('/items/types', { method: 'POST', body: JSON.stringify({ name }) }),
  deleteItemType:      (name)         => req(`/items/types/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  getItemsReport:      (params)       => reqBlob(`/items/report?${new URLSearchParams(params)}`),
  getItemsAuditLog:    (params)       => req(`/items/audit-log?${new URLSearchParams(params)}`),
  undoAuditEntry:      (audit_id, fields) => req('/items/audit-undo', { method: 'POST', body: JSON.stringify({ audit_id, fields }) }),
  getItemAllocators:   ()             => cachedGet('/items/allocators'),
  getItemApprovers:    ()             => cachedGet('/items/approvers'),
  getRolesDirectory:   ()             => cachedGet('/roles/directory'),
  // Act As - start/stop are excluded from cachedGet (they're mutations); the
  // eligible-targets list is fine to cache briefly like other directories.
  getActAsEligibleTargets: ()         => cachedGet('/act-as/eligible-targets', 30_000),
  startActAs:          (target_email) => req('/act-as/start', { method: 'POST', body: JSON.stringify({ target_email }) }),
  stopActAs:           (session_id)   => req('/act-as/stop',  { method: 'POST', body: JSON.stringify({ session_id }) }),
  // Curated Nexus People (nexus_employees), not the ~150-account M365 GAL - for
  // assigning items to real Nexus people. Same {email,name} shape.
  getPeopleDirectory:  ()             => cachedGet('/myhr/directory'),
  autoFillItemPhotos:  (item_ids, replace = false) => req('/items/auto-photos', { method: 'POST', body: JSON.stringify({ item_ids, replace }) }),
  // Permanent assignments
  getAssignments:         ()           => req('/items/assignments'),
  assignItem:             (itemId, d)  => req(`/items/${itemId}/assign`,   { method: 'POST', body: JSON.stringify(d) }),
  reassignItem:           (itemId, d)  => req(`/items/${itemId}/reassign`, { method: 'POST', body: JSON.stringify(d) }),
  assignItemToLocation:   (itemId, location) => req(`/items/${itemId}/assign-location`, { method: 'POST', body: JSON.stringify({ location }) }),
  bulkAssignLocation:     (ids, location)            => req('/items/bulk-assign-location', { method: 'POST', body: JSON.stringify({ ids, location }) }),
  bulkAssignPerson:       (ids, assignee_email, assignee_name, skip_acceptance = false) => req('/items/bulk-assign', { method: 'POST', body: JSON.stringify({ ids, assignee_email, assignee_name, skip_acceptance }) }),
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
  updateRampMemo: (id, memo) => req(`/accounting/ramp/${id}`, { method: "PATCH", body: JSON.stringify({ memo }) }),
  getAma: () => req("/accounting/ama"),

  // Ops
  getOpsProjects: () => req("/ops-projects"),
  createOpsProject: (data) => req("/ops-projects", { method: "POST", body: JSON.stringify(data) }),

  // Dev
  getDevProjects: () => req("/dev-projects"),

  // LMS
  getLmsCourses: () => req("/lms-courses"),

  // HR - employee master records
  getEmployees:   ()         => req('/hr/employees'),
  createEmployee: (data)     => req('/hr/employees', { method: 'POST', body: JSON.stringify(data) }),
  updateEmployee: (id, data) => req(`/hr/employees/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteEmployee: (id)       => req(`/hr/employees/${id}`, { method: 'DELETE' }),
  // "Remove from Nexus" is reversible: the record is hidden, not destroyed.
  // These two back the Deleted filter in the directory and the Restore action.
  getDeletedEmployees: ()    => req('/hr/employees?deleted=true'),
  restoreEmployee: (id)      => req(`/hr/employees/${id}/restore`, { method: 'POST' }),

  // HR - companies/entities & work sites (Section A foundation)
  getEntities:    ()         => cachedGet('/hr/entities', 120_000),
  createEntity:   (data)     => req('/hr/entities', { method: 'POST', body: JSON.stringify(data) }),
  updateEntity:   (id, data) => req(`/hr/entities/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  getGroupManager: ()        => req('/hr/group-manager'),
  setGroupManager: (email)   => req('/hr/group-manager', { method: 'PUT', body: JSON.stringify({ email }) }),
  deleteEntity:   (id)       => req(`/hr/entities/${id}`, { method: 'DELETE' }),
  // per-company departments (managed list, not free text)
  getCompanyDepartments:    (entityId)       => req(`/hr/entities/${entityId}/departments`),
  addCompanyDepartment:     (entityId, name) => req(`/hr/entities/${entityId}/departments`, { method: 'POST', body: JSON.stringify({ name }) }),
  deleteCompanyDepartment:  (entityId, deptId) => req(`/hr/entities/${entityId}/departments/${deptId}`, { method: 'DELETE' }),
  updateCompanyDepartment:  (entityId, deptId, data) => req(`/hr/entities/${entityId}/departments/${deptId}`, { method: 'PATCH', body: JSON.stringify(data) }),
  getWorkSites:   ()         => cachedGet('/hr/work-sites', 120_000),
  createWorkSite: (data)     => req('/hr/work-sites', { method: 'POST', body: JSON.stringify(data) }),
  updateWorkSite: (id, data) => req(`/hr/work-sites/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteWorkSite: (id)       => req(`/hr/work-sites/${id}`, { method: 'DELETE' }),

  // HR - compensation + bank (restricted: hr_comp grant / owner)
  getCompensation:  (id)       => req(`/hr/employees/${id}/compensation`),
  saveCompensation: (id, data) => req(`/hr/employees/${id}/compensation`, { method: 'PUT', body: JSON.stringify(data) }),

  // HR - live assets (permanent assignments + active checkouts from Item Management)
  getEmployeeAssets: (id)      => req(`/hr/employees/${id}/assets`),
  getEmployeeBod:    (id, start, end) => req(`/hr/employees/${id}/bod?start=${start || ''}&end=${end || ''}`),
  changeEmployeeStatus: (id, data) => req(`/hr/employees/${id}/status`, { method: 'POST', body: JSON.stringify(data) }),

  // HR - mailbox export (zip of .eml via Graph; needs Mail.Read consent)
  startMailboxExport: (id)      => req(`/hr/employees/${id}/mailbox-export`, { method: 'POST' }),
  getMailboxExport:   (id)      => req(`/hr/employees/${id}/mailbox-export`),
  getExportStatus:    (jobId)   => req(`/hr/mailbox-exports/${jobId}`),
  getExportUrl:       (jobId)   => req(`/hr/mailbox-exports/${jobId}/url`),

  // HR - hiring pipeline
  getCandidates:       ()         => req('/hr/candidates'),
  getCandidateHistory: (id)       => req(`/hr/candidates/${id}/history`),
  createCandidate:     (data)     => req('/hr/candidates', { method: 'POST', body: JSON.stringify(data) }),
  updateCandidate:     (id, data) => req(`/hr/candidates/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  candidateResumeUpload: (id, form) => req(`/hr/candidates/${id}/resume`, { method: 'POST', body: form }),
  candidateResumeUrl:  (id)       => req(`/hr/candidates/${id}/resume-url`),

  // HR - AI-assisted interviews (Teams invite + questionnaire + scoring)
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

  // HR - documents (private bucket, signed URLs)
  getEmployeeDocs:   (empId)        => req(`/hr/employees/${empId}/documents`),
  uploadEmployeeDoc: (empId, form)  => req(`/hr/employees/${empId}/documents`, { method: 'POST', body: form }),
  getDocUrl:         (docId)        => req(`/hr/documents/${docId}/url`),
  uploadEmployeePhoto: (empId, form) => req(`/hr/employees/${empId}/photo`, { method: 'POST', body: form }),
  deleteEmployeeDoc: (docId)        => req(`/hr/documents/${docId}`, { method: 'DELETE' }),

  // HR - provisioning
  getProvisionSkus:  ()             => req('/hr/provision/skus'),
  provisionEmployee: (empId, data)  => req(`/hr/employees/${empId}/provision`, { method: 'POST', body: JSON.stringify(data) }),
  getProvisionRuns:  (empId)        => req(`/hr/employees/${empId}/provision/runs`),
  syncM365:          ()             => req('/hr/employees/sync-m365', { method: 'POST' }),
  syncM365Photos:    ()             => req('/hr/employees/sync-photos', { method: 'POST' }),
  syncM365TwoWay:       () => req('/hr/employees/sync-m365-two-way', { method: 'POST' }),
  syncM365TwoWayStatus: () => req('/hr/employees/sync-m365-two-way/status'),
  pushToEntra:       (empId)        => req(`/hr/employees/${empId}/push-to-entra`, { method: 'POST' }),
  resendWelcome:     (empId)        => req(`/hr/employees/${empId}/welcome-email`, { method: 'POST' }),

  // HR - leave tracker
  getLeave:         ()          => req('/hr/leave'),
  getLeaveBalances: (empId, yr) => req(`/hr/leave/balances/${empId}?year=${yr}`),
  setLeaveBalance:  (data)      => req('/hr/leave/balances', { method: 'PUT', body: JSON.stringify(data) }),
  createLeave:      (data)      => req('/hr/leave', { method: 'POST', body: JSON.stringify(data) }),
  decideLeave:      (id, data)  => req(`/hr/leave/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

  // HR - e-sign (templates, envelopes, my-signatures inbox)
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
  // keepalive: a punch fired as the tab is closing (the classic lost clock-out)
  // still reaches the server - the browser keeps the request alive past unload.
  // Body is tiny, well under the 64KB keepalive cap.
  timePunch:         (data)      => req('/timeclock/punch', { method: 'POST', body: JSON.stringify(data), keepalive: true }),
  timeExceptions:    (start, end) => req(`/timeclock/exceptions?start=${start || ''}&end=${end || ''}`),
  // Shared-PC: mint a one-time nonce the local agent claims (over localhost) so
  // clock-in can bind this employee to the physical PC. No agent = no nonce used.
  timeAgentPairChallenge: () => req('/timeclock/agent/pair-challenge', { method: 'POST', body: '{}' }),
  timeSelfPunch:     (data)      => req('/timeclock/punch/manual', { method: 'POST', body: JSON.stringify(data) }),
  timeMy:            (start, end) => req(`/timeclock/me?start=${start || ''}&end=${end || ''}`),
  timeTeam:          (start, end) => req(`/timeclock/team?start=${start || ''}&end=${end || ''}`),
  timeAdjustPunch:   (id, data)  => req(`/timeclock/punches/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  timeAddPunch:      (data)      => req('/timeclock/punches', { method: 'POST', body: JSON.stringify(data) }),
  timeExportCsv:     (start, end, mode) => reqBlob(`/timeclock/export.csv?start=${start || ''}&end=${end || ''}&mode=${mode || 'summary'}`),
  // QuickBooks Desktop time import (IIF TIMEACT rows) - Charmi imports this
  // instead of keying hours per employee by hand (Aug 21).
  timeExportIif:     (start, end) => reqBlob(`/timeclock/export.iif?start=${start || ''}&end=${end || ''}`),
  timeShotUpload:    (form)      => req('/timeclock/screenshot', { method: 'POST', body: form }),
  timeShots:         (date, email) => req(`/timeclock/screenshots?date=${date || ''}&email=${encodeURIComponent(email || '')}`),
  // Disclosed monitoring: per-shift consent, admin policy, manager-scoped gallery
  timeMonitoringConsent: () => req('/timeclock/monitoring/consent', { method: 'POST', body: JSON.stringify({ text_version: '', tz_offset_min: new Date().getTimezoneOffset() }) }),
  timeMonitoringPolicy:  () => req('/timeclock/monitoring/policy'),
  timeSetMonitoringPolicy: (data) => req('/timeclock/monitoring/policy', { method: 'PUT', body: JSON.stringify(data) }),
  timeTeamShots:     (date, email) => req(`/timeclock/team-screenshots?date=${date || ''}&email=${encodeURIComponent(email || '')}`),
  timeBodDay:        (email, date) => req(`/timeclock/bod/day?email=${encodeURIComponent(email || '')}&date=${date || ''}`),
  timeMonitoringAlerts: () => req('/timeclock/monitoring/alerts'),
  // Punch-fix requests: employee asks, approver (HR/manager) approves/rejects
  timePunchRequestCreate: (data) => req('/timeclock/punch-requests', { method: 'POST', body: JSON.stringify(data) }),
  timeMyPunchRequests:    () => req('/timeclock/punch-requests/mine'),
  timePunchRequests:      (status) => req(`/timeclock/punch-requests?status=${status || 'pending'}`),
  // Employee self-edit of a punch time (applies to display now, to pay only on approval)
  timePunchEditCreate:    (data)     => req('/timeclock/punch-edits', { method: 'POST', body: JSON.stringify(data) }),
  timePunchEditDecide:    (id, data) => req(`/timeclock/punch-edits/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  timePendingPunchEdits:  ()         => req('/timeclock/punch-edits'),
  timeSignMyTimecard:     (start)    => req('/timeclock/my-timecard/sign', { method: 'POST', body: JSON.stringify({ start: start || '' }) }),
  timeDecidePunchRequest: (id, data) => req(`/timeclock/punch-requests/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  // Employee's own bi-weekly pay-period timecard (payroll rows + composition)
  timeMyPayroll:          (start) => req(`/timeclock/my-payroll?start=${start || ''}`),
  timeOffCreate:     (data)      => req('/timeclock/timeoff', { method: 'POST', body: JSON.stringify(data) }),
  timeOffMine:       ()          => req('/timeclock/timeoff/mine'),
  timeOffList:       (status)    => req(`/timeclock/timeoff?status=${status || ''}`),
  timeOffOnBehalf:   (data)      => req('/timeclock/timeoff/on-behalf', { method: 'POST', body: JSON.stringify(data) }),
  timeOffDecide:     (id, data)  => req(`/timeclock/timeoff/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  timeApprove:       (data)      => req('/timeclock/approvals', { method: 'POST', body: JSON.stringify(data) }),
  timeApprovalRevoke: (id)       => req(`/timeclock/approvals/${id}`, { method: 'PATCH' }),
  timeBodRecord:     (data)      => req('/timeclock/bod', { method: 'POST', body: JSON.stringify(data) }),
  timeBodLast:       ()          => req('/timeclock/bod/last'),
  // My Teams chats, listed server-side via the session's Graph token (no MSAL popup).
  timeMyChats:       ()          => req('/timeclock/my-chats', { timeoutMs: 30000 }),
  timeBodTemplate:   (kind)      => req(`/timeclock/bod/template?kind=${kind || 'bod'}`),
  // Sign-in company-policy & monitoring acknowledgment
  policyStatus:      ()          => req('/policy/status'),
  policyAccept:      ()          => req('/policy/accept', { method: 'POST' }),
  policyMyAcks:      ()          => req('/policy/acknowledgments'),

  // ── Customizable dashboards (drag-and-drop widget layouts) ──
  dashViews:      (target)     => req(`/dashboards/views?target=${encodeURIComponent(target)}`),
  dashCreateView: (body)       => req('/dashboards/views', { method: 'POST', body: JSON.stringify(body) }),
  dashUpdateView: (id, body)   => req(`/dashboards/views/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  dashSetDefault: (id)         => req(`/dashboards/views/${id}/default`, { method: 'PUT' }),
  dashDeleteView: (id)         => req(`/dashboards/views/${id}`, { method: 'DELETE' }),
  dashKpis:       (scope = 'self') => req(`/dashboards/kpis?scope=${encodeURIComponent(scope)}`),
  // The caller's own Outlook agenda (M365 staff only - {available:false} otherwise)
  dashAgenda:     (start, end, tz) => req(`/dashboards/agenda?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&tz=${encodeURIComponent(tz)}`),

  // ── My HR (employee self-service - own record only) ──
  myHrProfile:     ()      => req('/myhr/profile'),
  personCard:      (q)     => req(`/myhr/person?q=${encodeURIComponent(q)}`),
  myHrProfileSave: (body)  => req('/myhr/profile', { method: 'PUT', body: JSON.stringify(body) }),
  myHrPhotoUpload: (form)  => req('/myhr/profile/photo', { method: 'POST', body: form }),
  myHrPhotoRemove: ()      => req('/myhr/profile/photo', { method: 'DELETE' }),
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
  // Device enrollment - shared by field-phone tracking (EnrolPhone). Desktop
  // agent retired; capture now runs in the browser (Chrome screen sharing).
  timeAgentEnroll:   (data)      => req('/timeclock/agent/enroll', { method: 'POST', body: JSON.stringify(data) }),
  timeAgentDevices:  ()          => req('/timeclock/agent/devices'),
  timeAgentRevoke:   (id)        => req(`/timeclock/agent/devices/${id}`, { method: 'PATCH' }),
  // The single reusable "install on every company PC" one-liner (admin only).
  timeAgentInstallCommand: ()    => req('/timeclock/agent/install-command'),
  // Link an enrolled PC to a Nexus person (assigned owner); '' unassigns.
  timeAgentAssignDevice: (id, email) => req(`/timeclock/agent/devices/${id}/assign`, { method: 'POST', body: JSON.stringify({ email }) }),
  // Hard-delete an enrolled PC record (cleanup after uninstall/decommission).
  timeAgentDeleteDevice: (id)    => req(`/timeclock/agent/devices/${id}`, { method: 'DELETE' }),
  // Live coverage roster: who's clocked in + how they're captured (agent/browser/gap).
  timeMonitoringCoverage: ()     => req('/timeclock/monitoring/coverage'),
  // Live screen view (on-demand WebRTC). request returns a session + TURN creds
  // when the person is clocked in with an online agent; poll for the agent's offer;
  // answer with the browser's SDP; ping keeps it alive; end closes it.
  timeLiveRequest:   (email, fps) => req('/timeclock/live/request', { method: 'POST', body: JSON.stringify({ email, fps: fps || 60 }) }),
  timeLivePoll:      (id)        => req(`/timeclock/live/${id}`),
  timeLiveAnswer:    (id, sdp)   => req(`/timeclock/live/${id}/answer`, { method: 'POST', body: JSON.stringify({ sdp }) }),
  timeLiveEnd:       (id)        => req(`/timeclock/live/${id}/end`, { method: 'POST', body: '{}' }),
  // Attended remote control on a live session: request shows the employee an
  // Accept/Decline prompt on their PC; nothing is injected without their accept.
  timeLiveControlRequest: (id) => req(`/timeclock/live/${id}/control/request`, { method: 'POST', body: '{}' }),
  timeLiveControlCancel:  (id) => req(`/timeclock/live/${id}/control/cancel`, { method: 'POST', body: '{}' }),
  timeLiveControlEnd:     (id) => req(`/timeclock/live/${id}/control/end`, { method: 'POST', body: '{}' }),
  // Who is watching / giving remote support on each screen right now (presence badges).
  timeLivePresence:  () => req('/timeclock/live-presence'),
  // Field-worker location tracking (manager/HR views; device pings use X-Agent-Token from the native app, not these)
  trackLive:         ()            => req('/timeclock/track/live'),
  trackPath:         (email, date) => req(`/timeclock/track/path?email=${encodeURIComponent(email)}&date=${date}`),
  timeLocations:     ()            => req('/timeclock/locations'),
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
  timePayrollRateGet: (email)    => req(`/timeclock/payroll/rate?email=${encodeURIComponent(email)}`),
  timeAutoLunchGet:  ()          => req('/timeclock/payroll/autolunch'),
  timeAutoLunchSet:  (data)      => req('/timeclock/payroll/autolunch', { method: 'PUT', body: JSON.stringify(data) }),
  timeRoundingGet:   ()          => req('/timeclock/payroll/rounding'),
  timeRoundingSet:   (data)      => req('/timeclock/payroll/rounding', { method: 'PUT', body: JSON.stringify(data) }),
  // Break policy: CA paid rest breaks + long/unended-break flags (Charmi, Aug 21)
  timeBreakPolicyGet: ()         => req('/timeclock/payroll/breakpolicy'),
  timeBreakPolicySet: (data)     => req('/timeclock/payroll/breakpolicy', { method: 'PUT', body: JSON.stringify(data) }),
  timeFinalize:      (data)      => req('/timeclock/finalize', { method: 'POST', body: JSON.stringify(data) }),
  timeUnfinalize:    (data)      => req('/timeclock/unfinalize', { method: 'POST', body: JSON.stringify(data) }),
  timeTeamExceptions:(start, end) => req(`/timeclock/team-exceptions?start=${start || ''}&end=${end || ''}`),
  // Insights dashboard (Top Apps / Top Websites / activity), from the desktop agent
  timeInsights:      (email, start, end) => req(`/timeclock/insights?email=${encodeURIComponent(email || '')}&start=${start || ''}&end=${end || ''}&tz=${new Date().getTimezoneOffset()}`),
  timeRatings:       ()          => req('/timeclock/ratings'),
  timeSetRating:     (data)      => req('/timeclock/ratings', { method: 'PUT', body: JSON.stringify(data) }),

  // ── Credential Vault (secrets only ever come back from the /reveal endpoints) ──
  cvCredentials:    ()           => req('/credvault/credentials'),
  cvCreate:         (body)       => req('/credvault/credentials', { method: 'POST', body: JSON.stringify(body) }),
  cvUpdate:         (id, body)   => req(`/credvault/credentials/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  cvDelete:         (id)         => req(`/credvault/credentials/${id}`, { method: 'DELETE' }),
  cvBulkDelete:     (ids)        => req('/credvault/credentials/bulk-delete', { method: 'POST', body: JSON.stringify({ ids }) }),
  cvRestore:        (id)         => req(`/credvault/credentials/${id}/restore`, { method: 'POST' }),
  cvPurge:          (id)         => req(`/credvault/credentials/${id}/permanent`, { method: 'DELETE' }),
  cvReveal:         (id)         => req(`/credvault/credentials/${id}/reveal`, { method: 'POST' }),
  cvCopied:         (id)         => req(`/credvault/credentials/${id}/copied`, { method: 'POST' }),
  cvImport:         (rows)       => req('/credvault/import', { method: 'POST', body: JSON.stringify({ rows }) }),
  cvShare:          (id, body)   => req(`/credvault/credentials/${id}/share`, { method: 'POST', body: JSON.stringify(body) }),
  cvRequests:       ()           => req('/credvault/requests'),
  cvApproveRequest: (id)         => req(`/credvault/requests/${id}/approve`, { method: 'POST' }),
  cvDenyRequest:    (id)         => req(`/credvault/requests/${id}/deny`, { method: 'POST' }),
  cvGrants:         ()           => req('/credvault/grants'),
  cvGrantReveal:    (id)         => req(`/credvault/grants/${id}/reveal`, { method: 'POST' }),
  cvLogs:           ()           => req('/credvault/logs'),
  cvPersonal:       ()           => req('/credvault/personal'),
  cvPersonalCreate: (body)       => req('/credvault/personal', { method: 'POST', body: JSON.stringify(body) }),
  cvPersonalDelete: (id)         => req(`/credvault/personal/${id}`, { method: 'DELETE' }),
  cvPersonalReveal: (id)         => req(`/credvault/personal/${id}/reveal`, { method: 'POST' }),
  // SMS/Email OTP (replaces step-up for company vault reveal/share) + Personal Vault password lock
  cvOtpTargets:     ()           => req('/credvault/otp/targets'),
  cvOtpRequest:     (channel)    => req('/credvault/otp/request', { method: 'POST', body: JSON.stringify({ channel }) }),
  cvOtpVerify:      (challengeId, code) => req('/credvault/otp/verify', { method: 'POST', body: JSON.stringify({ challengeId, code }) }),
  cvPersonalLockStatus: ()       => req('/credvault/personal/lock/status'),
  cvPersonalLockSetup:  (password) => req('/credvault/personal/lock/setup', { method: 'POST', body: JSON.stringify({ password }) }),
  cvPersonalLockVerify: (password) => req('/credvault/personal/lock/verify', { method: 'POST', body: JSON.stringify({ password }) }),
  cvPersonalLockForgot: (channel)  => req('/credvault/personal/lock/forgot', { method: 'POST', body: JSON.stringify({ channel }) }),
  cvPersonalLockReset:  (challengeId, code, newPassword) => req('/credvault/personal/lock/reset', { method: 'POST', body: JSON.stringify({ challengeId, code, newPassword }) }),

  // ── Documents (DMS) - Phase 1: folders + drafts/library, next to E-Sign ──
  getDocFolders:      ()             => req('/documents/folders'),
  createDocFolder:    (data)         => req('/documents/folders', { method: 'POST', body: JSON.stringify(data) }),
  getDocuments:       (params = {})  => req(`/documents?${new URLSearchParams(params)}`),
  createDocument:     (data)         => req('/documents', { method: 'POST', body: JSON.stringify(data) }),
  getDocument:        (id)           => req(`/documents/${id}`),
  updateDocument:     (id, data)     => req(`/documents/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  archiveDocument:    (id)           => req(`/documents/${id}/archive`, { method: 'POST' }),
  restoreDocument:    (id)           => req(`/documents/${id}/restore`, { method: 'POST' }),
  duplicateDocument:  (id)           => req(`/documents/${id}/duplicate`, { method: 'POST' }),
  deleteDocument:     (id)           => req(`/documents/${id}`, { method: 'DELETE' }),
  getDocumentVersions:(id)           => req(`/documents/${id}/versions`),

  // ── Documents (DMS) - Phase 3: template library + org letterheads ──
  getDocTemplates:      (params = {}) => req(`/documents/templates?${new URLSearchParams(params)}`),
  getDocTemplate:        (id)         => req(`/documents/templates/${id}`),
  createDocTemplate:     (data)       => req('/documents/templates', { method: 'POST', body: JSON.stringify(data) }),
  updateDocTemplate:     (id, data)   => req(`/documents/templates/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteDocTemplate:     (id)         => req(`/documents/templates/${id}`, { method: 'DELETE' }),
  duplicateDocTemplate:  (id)         => req(`/documents/templates/${id}/duplicate`, { method: 'POST' }),
  seedDocTemplateStarters: ()         => req('/documents/templates/starters', { method: 'POST' }),
  getDocLetterheads:     ()           => req('/documents/letterheads'),
  createDocLetterhead:   (data)       => req('/documents/letterheads', { method: 'POST', body: JSON.stringify(data) }),
  updateDocLetterhead:   (id, data)   => req(`/documents/letterheads/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteDocLetterhead:   (id)         => req(`/documents/letterheads/${id}`, { method: 'DELETE' }),

  // ── Documents (DMS) - Phase 4: PDF/DOCX export with merge resolution ──
  exportDocumentPdf:  (id) => reqBlob(`/documents/${id}/export/pdf`),
  exportDocumentDocx: (id) => reqBlob(`/documents/${id}/export/docx`),

  // ── Documents (DMS) - Phase 6: cross-module search + version content ──
  searchDocuments:    (q)         => req(`/documents/search?q=${encodeURIComponent(q)}`),
  getDocumentVersion: (did, vid)  => req(`/documents/${did}/versions/${vid}`),

  // ── Documents (DMS) - Phase 7: template version history ──
  getDocTemplateVersions: (id)        => req(`/documents/templates/${id}/versions`),
  getDocTemplateVersion:  (id, vid)   => req(`/documents/templates/${id}/versions/${vid}`),

  // ── Documents (DMS) - Import from Egnyte ──
  egnyteBrowse:    (path = '') => req(`/documents/egnyte/browse?path=${encodeURIComponent(path)}`),
  egnyteFetchFile: (path)      => reqBlob(`/documents/egnyte/file?path=${encodeURIComponent(path)}`),

  // ── Egnyte module (browse/upload at the right folder level) ──
  // These hit /egnyte/*, the module router. The two above hit /documents/egnyte/*
  // and are the DMS IMPORTER's own view (extension-filtered to what it can
  // convert) - both go through the same backend client, so do not "unify" them
  // by pointing one at the other.
  egnyteStatus:      ()                   => req('/egnyte/status'),
  egnyteFolder:      (path = '')          => req(`/egnyte/folder?path=${encodeURIComponent(path)}`),
  egnyteFile:        (path)               => reqBlob(`/egnyte/file?path=${encodeURIComponent(path)}`),
  // Same bytes, but asking to VIEW rather than download, so the response carries
  // the file's real content type and the blob can be rendered. The server grants
  // that only for its own allowlist (PDF/image/text) - see routers/egnyte.py.
  egnyteFilePreview: (path)               => reqBlob(`/egnyte/file?path=${encodeURIComponent(path)}&inline=true`),
  egnyteSearch:      (q, folder = '')     => req(`/egnyte/search?q=${encodeURIComponent(q)}&folder=${encodeURIComponent(folder)}`),
  egnyteCreateFolder:(path)               => req('/egnyte/folder', { method: 'POST', body: JSON.stringify({ path }) }),
  egnyteMove:        (path, destination)  => req('/egnyte/fs/move', { method: 'POST', body: JSON.stringify({ path, destination }) }),
  egnyteCopy:        (path, destination)  => req('/egnyte/fs/copy', { method: 'POST', body: JSON.stringify({ path, destination }) }),
  egnyteDelete:      (path)               => req('/egnyte/fs/delete', { method: 'POST', body: JSON.stringify({ path }) }),
  egnyteDescribe:    (path, description)  => req('/egnyte/fs/describe', { method: 'POST', body: JSON.stringify({ path, description }) }),
  // multipart: let the browser set the boundary, never set Content-Type by hand
  egnyteUpload:      (folder, file) => {
    const fd = new FormData();
    fd.append('folder', folder);
    fd.append('file', file);
    return req('/egnyte/upload', { method: 'POST', body: fd });
  },
  // ── Egnyte wiring registry (manager+ edits surface->folder mappings in UI) ──
  egnyteWiring:      ()                       => req('/egnyte/wiring'),
  egnyteWiringSet:   (slot, path, scopeId='') => req(`/egnyte/wiring/${encodeURIComponent(slot)}`, { method: 'PUT', body: JSON.stringify({ path, scope_id: scopeId }) }),
  egnyteWiringReset: (slot, scopeId='')       => req(`/egnyte/wiring/${encodeURIComponent(slot)}?scope_id=${encodeURIComponent(scopeId)}`, { method: 'DELETE' }),
  egnytePersonDocs:  (email)                  => req(`/egnyte/person/${encodeURIComponent(email)}`),
  egnytePersonPoint: (email, path)            => req(`/egnyte/person/${encodeURIComponent(email)}/folder`, { method: 'PUT', body: JSON.stringify({ path }) }),
  egnyteFolderGroups:      ()       => req('/egnyte/folder-groups'),
  egnyteFolderGroupOptions:()       => req('/egnyte/folder-groups/options'),
  egnyteFolderGroupPreview:(rule)   => req('/egnyte/folder-groups/preview', { method: 'POST', body: JSON.stringify({ rule }) }),
  egnyteFolderGroupDraft:  (prompt) => req('/egnyte/folder-groups/draft', { method: 'POST', body: JSON.stringify({ prompt }), timeoutMs: 90000 }),
  egnyteFolderGroupCreate: (body)   => req('/egnyte/folder-groups', { method: 'POST', body: JSON.stringify(body) }),
  egnyteFolderGroupDelete: (id)     => req(`/egnyte/folder-groups/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  egnyteFolderGroupSync:   (id)     => req(`/egnyte/folder-groups/${encodeURIComponent(id)}/sync`, { method: 'POST', timeoutMs: 120000 }),
  // Per-user Egnyte connection - browse with YOUR OWN Egnyte permissions.
  egnyteOauthStart:      () => req('/egnyte-oauth/start', { method: 'POST' }),
  egnyteOauthStatus:     () => req('/egnyte-oauth/status'),
  egnyteOauthDisconnect: () => req('/egnyte-oauth/me', { method: 'DELETE' }),
  egnytePersonProvision: (email)              => req(`/egnyte/person/${encodeURIComponent(email)}/provision`, { method: 'POST' }),
  myhrEgnyteDocs:    ()                       => req('/myhr/egnyte-documents'),
  myhrEgnyteFile:    (path)                   => reqBlob(`/myhr/egnyte-documents/file?path=${encodeURIComponent(path)}`),
  // ── Step-up MFA (fresh verification before sensitive data) ──
  stepupConfig:  ()      => req('/stepup/config'),
  stepupStatus:  ()      => req('/stepup/status'),
  stepupVerify:  (token) => req('/stepup/verify', { method: 'POST', body: JSON.stringify({ token: token || '' }) }),

  // ── Branding (login-screen accent color, Global Admin-configurable) ──
  // GET is unauthenticated on the backend (the login screen itself needs it
  // pre-login) - req() still works fine here since it just sends no auth
  // header when there's no signed-in account yet.
  getBrandingConfig:    ()        => cachedGet('/branding/config', 300_000),

  // Diagnostics
  reportClientError:    (body)    => req('/client-errors', { method: 'POST', body: JSON.stringify(body) }),
  updateBrandingConfig: (accent)  => req('/branding/config', { method: 'PUT', body: JSON.stringify({ accent }) }),

  // ── Investor Relations (GP capital management: funds, LPs, calls, distributions) ──
  // List endpoints drop empty/undefined params so filters never send "undefined".
  getIrDashboard:  ()          => req("/investor-relations/dashboard"),
  getIrFunds:      ()          => req("/investor-relations/funds"),
  createIrFund:    (data)      => req("/investor-relations/funds", { method: "POST", body: JSON.stringify(data) }),
  updateIrFund:    (id, data)  => req(`/investor-relations/funds/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteIrFund:    (id)        => req(`/investor-relations/funds/${id}`, { method: "DELETE" }),
  getIrInvestors:      ()          => req("/investor-relations/investors"),
  createIrInvestor:    (data)      => req("/investor-relations/investors", { method: "POST", body: JSON.stringify(data) }),
  updateIrInvestor:    (id, data)  => req(`/investor-relations/investors/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteIrInvestor:    (id)        => req(`/investor-relations/investors/${id}`, { method: "DELETE" }),
  getIrCommitments:    (params = {}) => req(`/investor-relations/commitments?${new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "")))}`),
  createIrCommitment:  (data)      => req("/investor-relations/commitments", { method: "POST", body: JSON.stringify(data) }),
  updateIrCommitment:  (id, data)  => req(`/investor-relations/commitments/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteIrCommitment:  (id)        => req(`/investor-relations/commitments/${id}`, { method: "DELETE" }),
  getIrCapitalCalls:       (params = {}) => req(`/investor-relations/capital-calls?${new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "")))}`),
  createIrCapitalCall:     (data)      => req("/investor-relations/capital-calls", { method: "POST", body: JSON.stringify(data) }),
  updateIrCapitalCall:     (id, data)  => req(`/investor-relations/capital-calls/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  getIrCapitalCallAllocations:    (callId)     => req(`/investor-relations/capital-calls/${callId}/allocations`),
  updateIrCapitalCallAllocation:  (id, data)   => req(`/investor-relations/capital-call-allocations/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  getIrDistributions:      (params = {}) => req(`/investor-relations/distributions?${new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "")))}`),
  createIrDistribution:    (data)      => req("/investor-relations/distributions", { method: "POST", body: JSON.stringify(data) }),
  updateIrDistribution:    (id, data)  => req(`/investor-relations/distributions/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  getIrDistributionAllocations:   (distId)     => req(`/investor-relations/distributions/${distId}/allocations`),
  updateIrDistributionAllocation: (id, data)   => req(`/investor-relations/distribution-allocations/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  getIrCapitalAccounts:       (params = {}) => req(`/investor-relations/capital-accounts?${new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "")))}`),
  getIrCapitalAccountDetail:  (investorId, fundId) => req(`/investor-relations/capital-accounts/${investorId}/${fundId}`),
  getIrDocuments:    (params = {}) => req(`/investor-relations/documents?${new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "")))}`),
  createIrDocument:  (data)      => req("/investor-relations/documents", { method: "POST", body: JSON.stringify(data) }),
  deleteIrDocument:  (id)        => req(`/investor-relations/documents/${id}`, { method: "DELETE" }),
  getIrUpdates:    (params = {}) => req(`/investor-relations/updates?${new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "")))}`),
  createIrUpdate:  (data)      => req("/investor-relations/updates", { method: "POST", body: JSON.stringify(data) }),
  updateIrUpdate:  (id, data)  => req(`/investor-relations/updates/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteIrUpdate:  (id)        => req(`/investor-relations/updates/${id}`, { method: "DELETE" }),
  seedIrDemoData:  ()          => req("/investor-relations/seed-demo-data", { method: "POST" }),
  // Investor portal - GP-side grant/revoke of deal-scoped access, plus the
  // read-only endpoints a granted external investor calls (scoped server-side).
  grantIrPortalAccess:  (investorId, fundId) => req("/investor-relations/portal-access/grant", { method: "POST", body: JSON.stringify({ investorId, fundId }) }),
  revokeIrPortalAccess: (investorId, fundId) => req(`/investor-relations/portal-access/${investorId}/${fundId}`, { method: "DELETE" }),
  getIrPortalMyDeals:   ()       => req("/investor-relations/portal/my-deals"),
  getIrPortalDeal:      (fundId) => req(`/investor-relations/portal/deals/${fundId}`),

  // ── Construction module ────────────────────────────────────────────────────
  // Media bytes are NOT in this list on purpose: the browser uploads straight to
  // Supabase and only the resulting path is registered through
  // createConstructionMedia. Routing a 100 MB clip through the API would hold it
  // in a gunicorn worker's memory for the length of a jobsite LTE upload.
  // One-time repair, not a sync step. Asana's "Task Progress" is usually a
  // PER-PROJECT field, so each project's "Waiting" arrived with its own option
  // gid and minted its own row. Idempotent - a no-op once merged.
  dedupeTaskCustomStatuses: () => req("/tasks/meta/custom-statuses/dedupe", { method: "POST" }),

  getConstructionOverview: () => req("/construction/overview"),
  getConstructionProjects: () => req("/construction/projects"),
  createConstructionProject: (data) => req("/construction/projects", { method: "POST", body: JSON.stringify(data) }),
  updateConstructionProject: (id, data) => req(`/construction/projects/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  getConstructionReviewQueue: () => req("/construction/review-queue"),
  getConstructionReports: (projectId) => req(`/construction/projects/${projectId}/reports`),
  generateConstructionReport: (projectId, data) => req(`/construction/projects/${projectId}/reports/generate`, { method: "POST", body: JSON.stringify(data) }),
  updateConstructionReport: (reportId, data) => req(`/construction/reports/${reportId}`, { method: "PATCH", body: JSON.stringify(data) }),
  publishConstructionReport: (reportId) => req(`/construction/reports/${reportId}/publish`, { method: "POST" }),
  // reqBlob, not a plain link: the endpoint is bearer-authenticated, and an
  // <a href> carries no Authorization header - it would just 401.
  exportConstructionReportPdf: (reportId) => reqBlob(`/construction/reports/${reportId}/pdf`),
  getConstructionLogs:  (projectId) => req(`/construction/projects/${projectId}/logs`),
  startConstructionLog: (projectId, data) => req(`/construction/projects/${projectId}/logs`, { method: "POST", body: JSON.stringify(data) }),
  updateConstructionLog: (logId, data) => req(`/construction/logs/${logId}`, { method: "PATCH", body: JSON.stringify(data) }),
  submitConstructionLog: (logId) => req(`/construction/logs/${logId}/submit`, { method: "POST" }),
  reviewConstructionLog: (logId, data) => req(`/construction/logs/${logId}/review`, { method: "POST", body: JSON.stringify(data) }),
  getConstructionMedia: (logId) => req(`/construction/logs/${logId}/media`),
  createConstructionMedia: (logId, data) => req(`/construction/logs/${logId}/media`, { method: "POST", body: JSON.stringify(data) }),
  deleteConstructionMedia: (mediaId) => req(`/construction/media/${mediaId}`, { method: "DELETE" }),
  // Milestones, RFIs and submittals share one set of endpoints - `kind` is one
  // of 'milestones' | 'rfis' | 'submittals'. Namespaced under /register/ so the
  // wildcard segment cannot shadow /projects/{id}/reports or /reports/{id};
  // route matching is registration-ordered and that would break silently.
  getConstructionRegister: (projectId, kind) => req(`/construction/projects/${projectId}/register/${kind}`),
  createConstructionRegisterItem: (projectId, kind, data) => req(`/construction/projects/${projectId}/register/${kind}`, { method: "POST", body: JSON.stringify(data) }),
  updateConstructionRegisterItem: (kind, id, data) => req(`/construction/register/${kind}/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteConstructionRegisterItem: (kind, id) => req(`/construction/register/${kind}/${id}`, { method: "DELETE" }),

  // IT / UniFi network dashboard. These previously lived in IT.jsx as direct
  // fetches to VITE_API_BASE with a self-acquired MSAL Bearer token, which broke
  // in cookie mode (no Bearer exists -> 401 "Missing or invalid Authorization
  // header"). Routed through req() they ride whichever auth mode is active.
  unifiOverview:  ()       => req("/unifi/overview", { timeoutMs: 20_000 }),
  unifiStats:     (siteId) => req(`/unifi/stats?siteId=${encodeURIComponent(siteId)}`, { timeoutMs: 20_000 }),
  unifiExportCsv: (siteId) => reqBlob(`/unifi/export/csv?siteId=${encodeURIComponent(siteId)}`),
};

// Public signing page (/sign/{token}) talks to /esign/public/* with plain fetch -
// no MSAL involved, the token in the URL is the credential.
export const API_BASE = BASE;

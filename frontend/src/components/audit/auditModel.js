// The unified Audit Log's pure helpers (Oct 20 2026): filters <-> address bar,
// date ranges, day grouping, module colors, value formatting, the word-level
// text diff the detail drawer draws, and the mapping that turns the legacy
// GET /audit-logs rows into the same event shape GET /audit/events returns
// (the screen falls back to it while the new endpoints are not deployed).
// No React here - AuditLog.test.jsx and the screen share these.
import { formatDate, formatDateTime, formatTime, formatWeekday } from '../../lib/datetime';

// ── Filters ─────────────────────────────────────────────────────────────────

export const DEFAULT_FILTERS = {
  module: '', person: '', as: '', action: '', range: '7d', from: '', to: '', q: '', system: false,
};

export const RANGES = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: 'Last 7 Days' },
  { key: '30d', label: 'Last 30 Days' },
  { key: 'month', label: 'This Month' },
  { key: 'custom', label: 'Custom Range' },
];

export const ACTIONS = [
  { key: 'create', label: 'Created' },
  { key: 'update', label: 'Updated' },
  { key: 'delete', label: 'Deleted' },
  { key: 'comment', label: 'Commented' },
  { key: 'login', label: 'Sign-Ins' },
  { key: 'denied', label: 'Denied' },
];

// Acting As filter: '' = anyone, 'any' = only Act As actions, else an email.
export const ACTING_AS_ANY = 'any';

const KEYS = ['module', 'person', 'as', 'action', 'range', 'from', 'to', 'q'];

// Address bar -> filters. Unknown keys are ignored; `event` opens a drawer.
export function filtersFromSearch(search) {
  const p = new URLSearchParams(search || '');
  const f = { ...DEFAULT_FILTERS };
  for (const k of KEYS) if (p.has(k)) f[k] = p.get(k) || '';
  if (!RANGES.some(r => r.key === f.range)) f.range = DEFAULT_FILTERS.range;
  f.system = p.get('system') === '1';
  return f;
}

// Filters -> address bar (defaults left out so a plain view has a clean URL).
export function searchFromFilters(f, eventId = '') {
  const p = new URLSearchParams();
  for (const k of KEYS) {
    const v = f[k];
    if (v && v !== DEFAULT_FILTERS[k]) p.set(k, v);
  }
  if (f.range !== 'custom') { p.delete('from'); p.delete('to'); }
  if (f.system) p.set('system', '1');
  if (eventId) p.set('event', eventId);
  const s = p.toString();
  return s ? `?${s}` : '';
}

export function activeFilterCount(f) {
  let n = 0;
  if (f.module) n += 1;
  if (f.person) n += 1;
  if (f.as) n += 1;
  if (f.action) n += 1;
  if (f.q) n += 1;
  if (f.system) n += 1;
  if (f.range !== DEFAULT_FILTERS.range) n += 1;
  return n;
}

const pad = (n) => String(n).padStart(2, '0');
export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// The from/to (YYYY-MM-DD, the viewer's own days) a range covers.
export function rangeDates(f, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const back = (days) => { const d = new Date(today); d.setDate(d.getDate() - days); return d; };
  switch (f.range) {
    case 'today': return { from: ymd(today), to: ymd(today) };
    case '30d': return { from: ymd(back(29)), to: ymd(today) };
    case 'month': return { from: ymd(new Date(today.getFullYear(), today.getMonth(), 1)), to: ymd(today) };
    case 'custom': return { from: f.from || '', to: f.to || '' };
    default: return { from: ymd(back(6)), to: ymd(today) };
  }
}

export function rangePhrase(f) {
  switch (f.range) {
    case 'today': return 'today';
    case '30d': return 'in the last 30 days';
    case 'month': return 'this month';
    case 'custom': {
      if (f.from && f.to) return `from ${formatDate(f.from)} to ${formatDate(f.to)}`;
      if (f.from) return `since ${formatDate(f.from)}`;
      if (f.to) return `through ${formatDate(f.to)}`;
      return 'in all recorded history';
    }
    default: return 'in the last 7 days';
  }
}

// Filters -> the GET /audit/events (and /export.csv) query params.
export function apiParams(f, extra = {}) {
  const { from, to } = rangeDates(f);
  const p = {
    module: f.module, actor: f.person, acting_as: f.as, action: f.action, q: f.q.trim(),
    from, to, include_system: f.system ? 'true' : 'false', ...extra,
  };
  return Object.fromEntries(Object.entries(p).filter(([, v]) => v !== '' && v !== undefined && v !== null));
}

// ── Time ────────────────────────────────────────────────────────────────────

// The API sends UTC; an ISO string without a zone is UTC too (the old rows).
export function toInstant(iso) {
  if (!iso) return null;
  const s = String(iso);
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) || !s.includes('T') ? s : `${s}Z`);
  return isNaN(d.getTime()) ? null : d;
}

export function relativeTime(iso, now = Date.now()) {
  const d = toInstant(iso);
  if (!d) return '';
  const s = Math.round((now - d.getTime()) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  const days = Math.round(h / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  return formatDate(d);
}

export const exactTime = (iso) => formatTime(toInstant(iso));
export const exactDateTime = (iso) => formatDateTime(toInstant(iso));

// "Tuesday, 10/20/2026" - the sticky day header.
export function dayLabel(d) {
  return `${formatWeekday(d)}, ${formatDate(d)}`;
}

// Events (newest first) -> [{ key, label, events }] by the viewer's local day.
export function groupByDay(events) {
  const out = [];
  let cur = null;
  for (const ev of events) {
    const d = toInstant(ev.at);
    const key = d ? ymd(d) : 'unknown';
    if (!cur || cur.key !== key) {
      cur = { key, label: d ? dayLabel(d) : 'Unknown Date', events: [] };
      out.push(cur);
    }
    cur.events.push(ev);
  }
  return out;
}

// Per-day counts over the range for the activity bars: facets.days when the
// API sends it, else counted from the events (only when all are loaded).
export function dayBuckets(f, days) {
  const { from, to } = rangeDates(f);
  if (!from || !to) return [];
  const start = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);
  const counts = new Map((days || []).map(d => [d.date, d.count || 0]));
  const out = [];
  for (let d = new Date(start); d <= end && out.length < 92; d.setDate(d.getDate() + 1)) {
    const k = ymd(d);
    out.push({ date: k, count: counts.get(k) || 0 });
  }
  return out;
}

export function countByDay(events) {
  const m = new Map();
  for (const ev of events) {
    const d = toInstant(ev.at);
    if (!d) continue;
    const k = ymd(d);
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m].map(([date, count]) => ({ date, count }));
}

// ── Modules ─────────────────────────────────────────────────────────────────

// Calm, distinct hues per module; anything unknown hashes into the same set,
// so a module keeps its color on every screen and every visit.
const MODULE_COLORS = {
  tasks: '#4f46e5', tickets: '#0e7490', items: '#b45309', inventory: '#b45309', hr: '#be185d',
  people: '#be185d', timeclock: '#0369a1', time: '#0369a1', shifts: '#0f766e', team: '#0f766e',
  accounting: '#15803d', esign: '#7c3aed', sign: '#7c3aed', documents: '#6d28d9', access: '#b91c1c',
  roles: '#b91c1c', settings: '#475569', auth: '#9f1239', security: '#9f1239', assets: '#a16207',
  operations: '#1d4ed8', ops: '#1d4ed8', marketing: '#c2410c', leasing: '#047857', pfs: '#334155',
  dashboards: '#0284c7', knowledge: '#4338ca', policy: '#57534e', notifications: '#64748b',
};
const FALLBACK_COLORS = ['#4f46e5', '#0e7490', '#b45309', '#be185d', '#0369a1', '#15803d', '#7c3aed', '#a16207', '#0f766e', '#c2410c'];

export function moduleColor(key = '') {
  const k = String(key).toLowerCase();
  if (MODULE_COLORS[k]) return MODULE_COLORS[k];
  let h = 0;
  for (let i = 0; i < k.length; i += 1) h = (h * 31 + k.charCodeAt(i)) >>> 0;
  return FALLBACK_COLORS[h % FALLBACK_COLORS.length];
}

export function titleCase(s = '') {
  return String(s).replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// ── Values and diffs ────────────────────────────────────────────────────────

// HTML (a rich-text comment, a task description) -> readable text with its
// line breaks. DOMParser never runs scripts or loads images.
export function htmlToText(html) {
  if (html == null) return '';
  const s = String(html);
  if (!/[<&]/.test(s)) return s;
  const withBreaks = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6]|tr|blockquote)>/gi, '\n');
  try {
    const doc = new DOMParser().parseFromString(withBreaks, 'text/html');
    return (doc.body.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
  } catch {
    return withBreaks.replace(/<[^>]+>/g, '').trim();
  }
}

const isEmptyValue = (v) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

// One value as words, by its kind. null = nothing there (the caller shows "Empty").
export function formatValue(v, kind) {
  if (kind === 'redacted') return 'Hidden for privacy';
  if (isEmptyValue(v)) return null;
  if (kind === 'bool' || typeof v === 'boolean') {
    if (v === true || v === 'true' || v === 1) return 'Yes';
    if (v === false || v === 'false' || v === 0) return 'No';
  }
  if (kind === 'number' && !isNaN(Number(v))) return Number(v).toLocaleString('en-US', { maximumFractionDigits: 6 });
  if (kind === 'date') {
    const s = String(v);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? formatDate(s, s) : (formatDateTime(toInstant(s), s));
  }
  if (kind === 'html') return htmlToText(v);
  if (kind === 'json' || typeof v === 'object') {
    try { return JSON.stringify(typeof v === 'string' ? JSON.parse(v) : v, null, 2); } catch { return String(v); }
  }
  return String(v);
}

// A one-line preview of a value for the feed ("In Progress").
export function shortValue(v, kind, max = 60) {
  const s = formatValue(v, kind);
  if (s === null) return 'Empty';
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

export const isTextKind = (kind) => kind === 'text' || kind === 'html';
// Prose gets the full-width text view: rich text always, a comment / note /
// description field always (a pushed comment must read as the comment), and
// any other text once it is long or has line breaks.
const PROSE_FIELD = /comment|body|description|note|message|reply/i;
export const isLongText = (c) => c.kind === 'html' || (c.kind === 'text' && PROSE_FIELD.test(`${c.field || ''} ${c.label || ''}`)) || isTextKind(c.kind) && (String(formatValue(c.before, c.kind) || '').length > 60
  || String(formatValue(c.after, c.kind) || '').length > 60 || /\n/.test(`${formatValue(c.before, c.kind) || ''}${formatValue(c.after, c.kind) || ''}`));

// Word-level diff (LCS) -> [{ type: 'same'|'del'|'add', text }]. Whitespace is
// kept as its own tokens so the result reads exactly like the text. Very long
// pairs skip the table (it is O(n*m)) and come back as one del + one add.
export function diffWords(before = '', after = '') {
  const a = String(before || '').split(/(\s+)/).filter(t => t !== '');
  const b = String(after || '').split(/(\s+)/).filter(t => t !== '');
  if (a.length * b.length > 400000) {
    return [...(a.length ? [{ type: 'del', text: a.join('') }] : []), ...(b.length ? [{ type: 'add', text: b.join('') }] : [])];
  }
  const n = a.length, m = b.length;
  const t = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
    }
  }
  const out = [];
  const push = (type, text) => {
    const last = out[out.length - 1];
    if (last && last.type === type) last.text += text; else out.push({ type, text });
  };
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { push('same', a[i]); i += 1; j += 1; }
    else if (t[i + 1][j] >= t[i][j + 1]) { push('del', a[i]); i += 1; }
    else { push('add', b[j]); j += 1; }
  }
  while (i < n) { push('del', a[i]); i += 1; }
  while (j < m) { push('add', b[j]); j += 1; }
  return out;
}

// ── Legacy fallback (GET /audit-logs) ───────────────────────────────────────

// Older rows were logged as raw HTTP ("PUT /myhr") - translated into plain
// English (carried over from the old Logs table, components/AdminPanel.jsx).
const LEGACY_MAP = [
  [/PUT myhr profile/, 'Updated their own profile (My HR)'],
  [/POST myhr requests/, 'Sent a request to HR'],
  [/POST timeclock punch/, 'Punched the time clock'],
  [/POST timeclock screenshot/, 'Desktop agent saved a screenshot'],
  [/POST timeclock bod/, 'Posted a start/end-of-day update'],
  [/POST timeclock timeoff/, 'Requested time off'],
  [/PATCH timeclock timeoff/, 'Decided a time-off request'],
  [/POST timeclock approvals/, 'Approved a Time Sheet'],
  [/(POST|PATCH) timeclock punches/, 'Adjusted a punch'],
  [/(POST|PATCH) timeclock agent/, 'Monitoring device activity'],
  [/(POST|PATCH|DELETE) timeclock shift/, 'Updated shifts'],
  [/POST dashboards views/, 'Created a dashboard view'],
  [/PUT dashboards views/, 'Updated a dashboard view'],
  [/DELETE dashboards views/, 'Deleted a dashboard view'],
  [/PUT property-assets workspace/, 'Saved the asset portfolio'],
  [/POST property-assets/, 'Asset portfolio activity'],
  [/POST esign templates/, 'Created a Nexus Sign template'],
  [/PUT esign templates/, 'Updated a Nexus Sign template'],
  [/POST esign requests/, 'Sent a document for signature'],
  [/\w+ esign/, 'Nexus Sign activity'],
  [/POST hr employees/, 'Added or updated an employee'],
  [/PATCH hr employees/, 'Updated an employee profile'],
  [/POST hr sync/, 'Synced people from M365'],
  [/\w+ hr/, 'HR admin activity'],
  [/\w+ knowledge-base/, 'Knowledge base activity'],
  [/POST help/, 'Updated page help'],
  [/\w+ groups/, 'Updated access groups'],
];

function legacyTitle(r) {
  const a = r.action || '';
  if (a === 'Authentication failed') return { title: 'Failed Sign-In', action: 'denied' };
  if (a === 'Authorization denied') return { title: 'Access Denied', action: 'denied' };
  const m = a.match(/^(GET|POST|PUT|PATCH|DELETE)\s+\/?(.*)$/);
  const verbAction = (v) => ({ POST: 'create', PUT: 'update', PATCH: 'update', DELETE: 'delete' }[v] || 'other');
  if (!m) {
    const l = a.toLowerCase();
    const action = /comment|replied/.test(l) ? 'comment' : /deleted|removed/.test(l) ? 'delete'
      : /created|added|submitted/.test(l) ? 'create' : /sign(ed)? in|login/.test(l) ? 'login' : /updated|changed|edited|approved|rejected/.test(l) ? 'update' : 'other';
    return { title: a, action };
  }
  const key = `${m[1]} ${r.resource_type || m[2]} ${(r.resource_id || '').toLowerCase()}`;
  for (const [re, title] of LEGACY_MAP) if (re.test(key)) return { title, action: verbAction(m[1]) };
  const verb = { POST: 'Created', PUT: 'Updated', PATCH: 'Updated', DELETE: 'Deleted' }[m[1]] || m[1];
  return { title: `${verb} ${(r.resource_type || m[2]).replace(/-/g, ' ')}`, action: verbAction(m[1]) };
}

function parseDetails(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { const p = JSON.parse(raw); return p && typeof p === 'object' ? p : {}; } catch { return {}; }
}

// Old module filter values were substrings of the action text.
export const LEGACY_MODULES = [
  { key: 'requisition', label: 'Requisitions' }, { key: 'inventory', label: 'Inventory' },
  { key: 'role', label: 'Roles' }, { key: 'task', label: 'Tasks' }, { key: 'review', label: 'Reviews' },
  { key: 'asset', label: 'Assets' }, { key: 'purchase', label: 'Purchases' }, { key: 'punch', label: 'Time Clock' },
  { key: 'time off', label: 'Time Off' }, { key: 'hr', label: 'HR' }, { key: 'sign', label: 'Nexus Sign' },
  { key: 'dashboard', label: 'Dashboards' }, { key: 'group', label: 'Access Groups' },
  { key: 'employee', label: 'Employees' }, { key: 'auth', label: 'Security' },
];

const SKIP_DETAIL = new Set(['path', 'status', 'method', 'acting_as']);

// One /audit-logs row -> the /audit/events event shape (no field diffs: the
// old log never kept a before state, so `details` become read-only facts).
export function legacyRowToEvent(r) {
  const d = parseDetails(r.details);
  const h = legacyTitle(r);
  const moduleKey = String(r.resource_type || '').toLowerCase().split(/[\s/]/)[0] || 'other';
  const facts = Object.entries(d).filter(([k, v]) => !SKIP_DETAIL.has(k) && v !== '' && v !== null && v !== undefined)
    .map(([k, v]) => ({ field: k, label: titleCase(k), value: typeof v === 'object' ? JSON.stringify(v) : String(v) }));
  return {
    id: `legacy-${r.id}`,
    legacy: true,
    at: r.timestamp,
    module: moduleKey,
    moduleLabel: titleCase(moduleKey),
    action: h.action,
    title: h.title,
    summary: '',
    actor: { email: r.user_email === 'anonymous' ? '' : r.user_email, name: r.user_email === 'anonymous' ? 'Not Signed In' : (r.user_name || '') },
    actingAs: d.acting_as ? { email: d.acting_as, name: '' } : null,
    target: r.resource_id ? { type: r.resource_type || '', id: r.resource_id, label: r.resource_id, link: null } : null,
    changesCount: 0,
    ip: r.ip_address || '',
    source: r.user_role || '',
    undone: false,
    facts,
    request: d.path ? { path: d.path, method: d.method || ((r.action || '').match(/^(GET|POST|PUT|PATCH|DELETE)/) || [''])[0], status: d.status } : null,
  };
}

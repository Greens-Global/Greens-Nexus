// Task Module - pure helpers (ported from nexus/lib/filters.ts + stats.ts).
// Operates on the runtime task shape (email used as person id).
import { PRIORITY_ORDER, PRIORITY_META, STATUS_ORDER, STATUS_META } from './theme';
import { api } from '../api';
import { supabase } from '../lib/supabase';
import { formatDate as usFormatDate, formatDateTime as usFormatDateTime } from '../lib/datetime';

export const EMPTY_FILTER = {
  assigneeIds: [], statuses: [], priorities: [], teamIds: [], projectIds: [],
  tags: [], due: 'any', dueFrom: null, dueTo: null, search: '',
  // {fieldId: [selectedOptionId, ...]} - only select-type fields are filterable;
  // a free-text or number field has no bounded option list to offer.
  customFields: {},
};

// Group/sort keys for custom fields are namespaced so they can share one key
// space with the built-ins ('status', 'priority', …) without ever colliding
// with a field whose id happens to look like one.
export const CF_PREFIX = 'cf:';
export const cfKey = (fieldId) => `${CF_PREFIX}${fieldId}`;
export const cfFieldId = (key) => (String(key || '').startsWith(CF_PREFIX) ? key.slice(CF_PREFIX.length) : '');
export const taskFieldValue = (task, fieldId) => (task.customFieldValues || {})[fieldId];

export const todayISO = () => new Date().toISOString().slice(0, 10);
export const addDays = (iso, n) => { const d = new Date(iso); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

function dueMatches(task, due, dueFrom, dueTo) {
  if (dueFrom && (!task.dueOn || task.dueOn < dueFrom)) return false;
  if (dueTo && (!task.dueOn || task.dueOn > dueTo)) return false;
  if (due === 'any') return true;
  const t = todayISO();
  if (due === 'none') return !task.dueOn;
  if (!task.dueOn) return false;
  if (due === 'overdue') return task.dueOn < t && !task.completed;
  if (due === 'today') return task.dueOn === t;
  if (due === 'week') {
    const wk = new Date(); wk.setDate(wk.getDate() + 7);
    return task.dueOn >= t && task.dueOn <= wk.toISOString().slice(0, 10);
  }
  return true;
}

export function matchesFilter(task, f = EMPTY_FILTER) {
  if (f.assigneeIds?.length && !f.assigneeIds.includes(task.assigneeId)) return false;
  if (f.statuses?.length && !f.statuses.includes(task.status)) return false;
  if (f.priorities?.length && !f.priorities.includes(task.priority)) return false;
  if (f.teamIds?.length && !f.teamIds.includes(task.teamId)) return false;
  if (f.projectIds?.length && !f.projectIds.includes(task.projectId)) return false;
  if (f.tags?.length && !f.tags.some((t) => (task.tags || []).includes(t))) return false;
  // Each selected field narrows independently (AND across fields, OR within
  // one) - the same shape as the assignee/status/priority filters above.
  for (const [fieldId, wanted] of Object.entries(f.customFields || {})) {
    if (!wanted?.length) continue;
    // multiselect/people hold a LIST, so a task matches when it carries ANY of
    // the wanted values. Comparing the array itself never matched anything.
    const have = taskFieldValue(task, fieldId);
    const hit = Array.isArray(have) ? have.some((v) => wanted.includes(v)) : wanted.includes(have);
    if (!hit) return false;
  }
  if (!dueMatches(task, f.due || 'any', f.dueFrom, f.dueTo)) return false;
  if (f.search) {
    const q = f.search.toLowerCase();
    const hay = [task.title, task.code, task.description, ...(task.tags || [])].join(' ').toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

// A team belongs to MANY projects, as Asana does it. `projectIds` is the real
// field; `projectId` is the first of them, kept for older readers - so go through
// these helpers, never `team.projectId`, which silently sees only the first.
export const teamProjectIds = (team) => (
  (team?.projectIds && team.projectIds.length) ? team.projectIds
    : (team?.projectId ? [team.projectId] : [])
);
export const teamInProject = (team, projectId) => !!projectId && teamProjectIds(team).includes(projectId);

// Custom fields are scoped to projects; empty `projectIds` = global, which is how
// every field behaved before scoping, so nothing changes until an admin narrows
// one. Outside a project only global fields apply - a project-specific field has
// no meaning on a task that isn't in that project.
export const fieldsForProject = (customFields, projectId) =>
  (customFields || []).filter((f) => {
    const ids = (f.projectIds || []).filter(Boolean);
    return ids.length === 0 || (projectId ? ids.includes(projectId) : false);
  });

// The chosen option object for a select value, so callers can render its color.
export const fieldOption = (field, value) =>
  (field?.options || []).find((o) => (o?.id ?? o) === value || (o?.label ?? o) === value) || null;

export const isSection = (t) => t.type === 'section';
export const isSubtask = (t) => !!t.parentTaskId;

/** Top-level, non-section tasks. Accepts a list or an id→task map. */
export function topLevel(tasks) {
  const list = Array.isArray(tasks) ? tasks : Object.values(tasks || {});
  return list.filter((t) => !isSubtask(t) && !isSection(t));
}

const SORTERS = {
  manual: () => 0,
  title: (a, b) => (a.title || '').localeCompare(b.title || ''),
  dueOn: (a, b) => (a.dueOn || '9999').localeCompare(b.dueOn || '9999'),
  priority: (a, b) => PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority),
  status: (a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status),
  assignee: (a, b) => (a.assigneeId || '').localeCompare(b.assigneeId || ''),
};

// A custom field sorts by its OWN order where it has one - a select by the order
// its options are defined in (Design before Build), which is what makes a stage or
// severity field read correctly. Numbers sort numerically, else text. Empty last.
function customFieldSorter(field) {
  const order = (field?.options || []).map((o) => (o?.id ?? o));
  const rank = (t) => {
    const v = taskFieldValue(t, field.id);
    if (v === undefined || v === null || v === '') return null;
    if (field.type === 'select') { const i = order.indexOf(v); return i === -1 ? order.length : i; }
    if (field.type === 'number') return Number(v);
    if (field.type === 'checkbox') return v ? 0 : 1;
    return String(v).toLowerCase();
  };
  return (a, b) => {
    const x = rank(a); const y = rank(b);
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return typeof x === 'string' ? x.localeCompare(y) : x - y;
  };
}

export function sortTasks(list, sort = { key: 'manual', dir: 'asc' }, customFields = []) {
  const fieldId = cfFieldId(sort.key);
  const field = fieldId ? (customFields || []).find((f) => f.id === fieldId) : null;
  const fn = field ? customFieldSorter(field) : (SORTERS[sort.key] || SORTERS.manual);
  const out = [...list].sort(fn);
  return sort.dir === 'desc' ? out.reverse() : out;
}

/** The context a new task inherits when added under a given group section -
 *  so "Do Today" dates it today, a status column sets that status, a project
 *  group scopes it to that project, etc. (Asana's add-from-anywhere flow). */
export function groupAddDefaults(group, key) {
  // Under a custom-field group, a new task inherits that group's value - the
  // same "add where you're looking" behavior status/priority groups have.
  const cfId = cfFieldId(group);
  if (cfId) return key && key !== '-' ? { customFieldValues: { [cfId]: key } } : {};
  if (group === 'date') {
    const today = todayISO();
    if (key === 'today') return { dueOn: today };
    if (key === 'week') return { dueOn: addDays(today, 7) };
    if (key === 'later') return { dueOn: addDays(today, 14) };
    return {}; // "Recently Assigned" → no due date
  }
  if (group === 'status') return { status: key };
  if (group === 'priority') return { priority: key };
  if (group === 'project') return key && key !== '-' ? { projectId: key } : {};
  if (group === 'team') return key && key !== '-' ? { teamId: key } : {};
  return {}; // assignee, none
}

/** Group tasks by a GroupBy key. Returns [{ key, label, tasks }] ordered sensibly. */
export function groupTasks(list, group, ctx = {}) {
  if (!group || group === 'none') return [{ key: 'all', label: '', tasks: list }];
  // Date grouping → the export's four semantic buckets, always all shown.
  if (group === 'date') {
    const today = todayISO();
    const weekEnd = addDays(today, 7);
    const out = [
      { key: 'recent', label: 'Recently Assigned', tasks: [] },
      { key: 'today', label: 'Do Today', tasks: [] },
      { key: 'week', label: 'Do Next Week', tasks: [] },
      { key: 'later', label: 'Do Later', tasks: [] },
    ];
    const by = Object.fromEntries(out.map((b) => [b.key, b]));
    for (const t of list) {
      const k = !t.dueOn ? 'recent' : t.dueOn <= today ? 'today' : t.dueOn <= weekEnd ? 'week' : 'later';
      by[k].tasks.push(t);
    }
    return out;
  }
  const buckets = new Map();
  const push = (k, label, t) => {
    if (!buckets.has(k)) buckets.set(k, { key: k, label, tasks: [] });
    buckets.get(k).tasks.push(t);
  };
  // Grouping by a custom field. Every option gets a bucket even when empty, so a
  // board grouped by Stage shows the stages nobody has reached yet; the option's
  // own color carries through to the header, as status/priority colors do.
  const cfId = cfFieldId(group);
  if (cfId) {
    const field = (ctx.customFields || []).find((f) => f.id === cfId);
    if (!field) return [{ key: 'all', label: '', tasks: list }];
    const opts = (field.options || []).map((o) => (typeof o === 'string' ? { id: o, label: o, color: '' } : o));
    const out = opts.map((o) => ({ key: o.id, label: o.label, color: o.color, tasks: [] }));
    const byKey = Object.fromEntries(out.map((g) => [g.key, g]));
    const none = { key: '-', label: `No ${field.name}`, tasks: [] };
    for (const t of list) {
      const v = taskFieldValue(t, cfId);
      const bucket = (v !== undefined && v !== null && v !== '')
        ? (byKey[v] || (byKey[v] = out[out.push({ key: String(v), label: String(v), tasks: [] }) - 1]))
        : none;
      bucket.tasks.push(t);
    }
    return [...out, ...(none.tasks.length ? [none] : [])];
  }
  // Callers may pass merged status metadata/order (built-in + custom) via ctx so
  // group-by-status headers + ordering reflect Manage → Custom Statuses.
  const statusMeta = ctx.statusMeta || STATUS_META;
  const statusOrder = ctx.statusOrder || STATUS_ORDER;
  for (const t of list) {
    if (group === 'status') push(t.status || 'not_started', statusMeta[t.status]?.label || t.status, t);
    else if (group === 'priority') push(t.priority || 'low', (t.priority || 'low').replace(/^\w/, (c) => c.toUpperCase()), t);
    else if (group === 'assignee') push(t.assigneeId || '-', ctx.nameOf ? ctx.nameOf(t.assigneeId) : (t.assigneeId || 'Unassigned'), t);
    else if (group === 'project') push(t.projectId || '-', ctx.projectName?.(t.projectId) || 'No Project', t);
    else if (group === 'team') push(t.teamId || '-', ctx.teamName?.(t.teamId) || 'No Team', t);
    else if (group === 'date') push(t.dueOn || '-', t.dueOn || 'No Due Date', t);
    else push('all', '', t);
  }
  let arr = [...buckets.values()];
  // Status and priority carry a MEANING, so their group headers use the status/
  // priority color the chips and progress bar already use. The colorForKey fallback
  // hashes the key into an avatar palette, which made "Completed" orange. Groupings
  // with no inherent color (assignee/project/team/date) still use that hash.
  if (group === 'status') {
    arr.sort((a, b) => statusOrder.indexOf(a.key) - statusOrder.indexOf(b.key));
    for (const g of arr) g.color = statusMeta[g.key]?.color;
  }
  if (group === 'priority') {
    arr.sort((a, b) => PRIORITY_ORDER.indexOf(a.key) - PRIORITY_ORDER.indexOf(b.key));
    for (const g of arr) g.color = PRIORITY_META[g.key]?.color;
  }
  return arr;
}

export function taskStats(list) {
  const total = list.length;
  const completed = list.filter((t) => t.completed).length;
  const inProgress = list.filter((t) => t.status === 'in_progress' && !t.completed).length;
  const overdue = list.filter((t) => t.dueOn && t.dueOn < todayISO() && !t.completed).length;
  return { total, completed, inProgress, overdue, pct: total ? Math.round((completed / total) * 100) : 0 };
}

// ── Clipboard ────────────────────────────────────────────────────────────────
/** Image files from a paste event (Ctrl+V screenshot). Pasted blobs sometimes
 *  arrive nameless - give them one so upload paths that read `f.name` work. */
export function filesFromPaste(e) {
  const out = [];
  for (const item of e.clipboardData?.items || []) {
    if (item.type?.startsWith('image/')) {
      const f = item.getAsFile();
      if (f) out.push(f.name ? f : new File([f], `paste-${Date.now()}.png`, { type: f.type || 'image/png' }));
    }
  }
  return out;
}

// Shared by every attach entry point (Attachments tab, comment composers,
// create modal, quick-create sheet, description "+ Attach file") - one
// File-to-TaskAttachment upload path instead of copies drifting apart.
// `extra` is spread into the create body; the comment composers pass
// { comment_id } so the attachment shows up inline under that comment instead
// of only in the flat task-level list.
// Bytes go browser -> Supabase Storage (`task-files` bucket, public, immutable
// cache), same as tickets' uploadTicketEvidence - works for any size up to the
// cap, unlike the old inline-data-URL scheme which silently recorded anything
// over 2 MB as a link-less row nobody could ever open. The data-URL branch
// survives only as the no-storage-creds local-dev fallback. A failed upload
// still records the row (url '') so the attempt isn't silently lost; renderers
// show those struck through.
const ATTACHMENT_MAX_INLINE = 2 * 1024 * 1024;   // local-dev fallback only
const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
export function attachmentKindOf(file) {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  return 'doc';
}
async function storeTaskFile(file) {
  if (!supabase) {
    if (file.size > ATTACHMENT_MAX_INLINE) return '';
    return new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(typeof r.result === 'string' ? r.result : '');
      r.onerror = () => resolve('');
      r.readAsDataURL(file);
    });
  }
  if (file.size > ATTACHMENT_MAX_BYTES) throw new Error('file is larger than 25 MB');
  const ext = (file.name.split('.').pop() || 'dat').toLowerCase();
  const path = `tasks/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { data, error } = await supabase.storage.from('task-files')
    .upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false, cacheControl: '31536000' });
  if (error || !data) throw new Error(error?.message || 'upload failed');
  return supabase.storage.from('task-files').getPublicUrl(data.path).data.publicUrl;
}
export async function uploadTaskAttachment(taskId, file, extra = {}) {
  const size = `${Math.max(1, Math.round(file.size / 1024))} KB`;
  const kind = attachmentKindOf(file);
  let url = '';
  try {
    url = await storeTaskFile(file);
  } catch (e) {
    alert(`"${file.name}" couldn't be stored: ${e?.message || 'upload failed'}. Remove the attachment and try again.`);
  }
  return api.addTaskAttachment(taskId, { name: file.name, size, kind, url, ...extra });
}

// ── Dates ────────────────────────────────────────────────────────────────────
// One date format for the whole module: mm/dd/yyyy. The views previously each
// rolled their own (`Jul 15`, `15 July 2026`, locale default…), so a task's due
// date read differently depending on which screen you were looking at. These now
// delegate to the canonical US formatter (lib/datetime) so the whole app agrees.

/** mm/dd/yyyy - e.g. 07/15/2026. Returns '' for empty, the raw value if unparseable. */
export function fmtDate(v) {
  return usFormatDate(v, v || '');
}

/** mm/dd/yyyy, h:mm AM/PM - for activity/comment timestamps. */
export function fmtDateTime(v) {
  return usFormatDateTime(v, v || '');
}

/** 1.25 -> "1h 15m", 30 -> "1d 6h" (drops any component that's zero - a day
 * count only appears once a task's estimate/actual actually crosses 24h) -
 * the estimate/actual fields store plain float hours, but showing "30h" or
 * "1.25h" isn't a format anyone reads at a glance. */
export function fmtHours(h) {
  const total = Math.round((Number(h) || 0) * 60);
  if (!total) return '0h';
  const dd = Math.floor(total / (24 * 60));
  const hh = Math.floor((total % (24 * 60)) / 60);
  const mm = total % 60;
  return [dd && `${dd}d`, hh && `${hh}h`, mm && `${mm}m`].filter(Boolean).join(' ');
}

/** The id from a copied "Copy Task Link" (?task=<id>), or '' if this page load
 * didn't come from one. Read once at mount - the workspace views pass this as
 * the initial value of their `openId` state so the drawer opens automatically. */
export function taskIdFromUrl() {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get('task') || '';
}

/** Asana-imported comments are stamped "[Asana · Name · date]\n<text>" so the
 * original author survives even when the Asana account has no matching Nexus
 * email (import falls back to author_email "asana-sync"). Pull that name out
 * so it can be shown as the real author instead of a raw fallback string, and
 * drop the bracket line from the rendered body so it isn't shown twice. */
export function parseImportedAuthor(body) {
  const s = body || '';
  const m = /^\[Asana · ([^·\]]+?)(?:\s*·\s*(\d{4}-\d{2}-\d{2}))?\]\n?/.exec(s);
  if (m) return { name: m[1].trim(), date: m[2] || '', text: s.slice(m[0].length) };
  // Rich bodies wrap the same stamp in markup: "<p><em>[Asana · Name]</em></p>".
  const h = /^\s*<p>\s*<em>\s*\[Asana · ([^·\]]+?)(?:\s*·\s*(\d{4}-\d{2}-\d{2}))?\]\s*<\/em>\s*<\/p>/i.exec(s);
  if (h) return { name: h[1].trim(), date: h[2] || '', text: s.slice(h[0].length) };
  return null;
}

// Tags and attributes the rich editor can produce, plus what Asana sends back.
// Everything else is unwrapped (children survive) rather than deleted, so a
// stray <div> costs formatting, not words.
const RICH_TAGS = new Set(['P', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'DEL',
  'CODE', 'PRE', 'BLOCKQUOTE', 'UL', 'OL', 'LI', 'A', 'IMG', 'MARK', 'SPAN',
  'H1', 'H2', 'H3', 'H4', 'HR', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH']);
const RICH_ATTRS = { A: ['href', 'title'], IMG: ['src', 'alt', 'title'] };
const SAFE_URL = /^(https?:|mailto:|data:image\/)/i;

/** Comment and description bodies are stored as HTML and come from people -
 * and from Asana, which is outside our control. Render them through this, never
 * raw: a body containing <script> or an onerror handler would otherwise run
 * with the signed-in user's session. Uses the browser parser (no dependency),
 * inert because <template> content is never fetched or executed. */
export function sanitizeRichHtml(html, nameOf) {
  if (!html) return '';
  if (typeof document === 'undefined') return '';
  const tpl = document.createElement('template');
  tpl.innerHTML = String(html);

  const walk = (node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) continue;                      // text
      if (child.nodeType !== 1) { child.remove(); continue; }  // comments, etc.
      const tag = child.tagName.toUpperCase();
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'IFRAME' || tag === 'OBJECT'
          || tag === 'EMBED' || tag === 'FORM') { child.remove(); continue; }
      walk(child);
      if (!RICH_TAGS.has(tag)) { child.replaceWith(...child.childNodes); continue; }
      for (const attr of Array.from(child.attributes)) {
        const name = attr.name.toLowerCase();
        const allowed = RICH_ATTRS[tag] || [];
        if (!allowed.includes(name)) { child.removeAttribute(attr.name); continue; }
        // javascript: and vbscript: URLs are the whole point of the allowlist.
        if ((name === 'href' || name === 'src') && !SAFE_URL.test(attr.value.trim())) {
          child.removeAttribute(attr.name);
        }
      }
      if (tag === 'A') {
        const href = child.getAttribute('href') || '';
        if (/^mailto:/i.test(href)) {
          // A mention. Show the person the way the rest of the module names
          // them - Asana's copy of the name can differ from ours, and a body
          // written elsewhere may carry the raw address as its label.
          const email = href.slice(7).trim();
          // nameOf falls back to the address for people it doesn't know, which
          // is the one thing we don't want to show - use the local part then.
          const name = nameOf?.(email);
          if (name && name !== email) child.textContent = `@${name}`;
          else if (!child.textContent.trim() || child.textContent.trim().replace(/^@/, '') === email) {
            child.textContent = `@${email.split('@')[0]}`;
          }
        } else {
          child.setAttribute('target', '_blank');
          child.setAttribute('rel', 'noreferrer noopener');
        }
      }
    }
  };
  walk(tpl.content);
  return tpl.innerHTML;
}

/** True when `body` is HTML rather than one of the old plain-text rows. Plain
 * text has to be escaped before it can be rendered as HTML, or a comment
 * containing "a < b" loses everything after the "<". */
export function richBodyHtml(body, nameOf) {
  const s = body || '';
  if (!/<[a-z/][\s\S]*>/i.test(s)) {
    return s.split('\n').filter((l) => l.trim())
      .map((l) => `<p>${l.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`)
      .join('');
  }
  return sanitizeRichHtml(s, nameOf);
}

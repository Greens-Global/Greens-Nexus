// Diagrams from Nexus data (Neil, 11/06/2026): each source turns rows the
// caller may already read into the plain graph (graph.js). A placed diagram
// is a SNAPSHOT - its boxes carry `customData.nexusDiagram` ({ id, source,
// ref, dir }) so Refresh can draw it again from today's data; nothing
// redraws by itself. No new endpoint and no second access rule: the org
// chart is the Contact Directory (company walls apply), a workflow is
// GET /workflows/{id} (its own rule), tasks are GET /tasks, a property map
// is GET /property-assets/workspace (the server's own reach, 11/08/2026).
import { api } from '../../../api';
import { parseText } from './graph';

// The directory and the task list are big reads; the sheet asks for the
// picker and then the preview (and again on each pick), so one copy is
// shared for a minute. Refresh after that reads fresh.
// shortcut: whole-list reads filtered here - a project-filtered /tasks read would be lighter if this gets slow.
const FRESH_MS = 60_000;
const cache = new Map();   // key -> { at, promise }
function shared(key, read) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.promise;
  const promise = read();
  cache.set(key, { at: Date.now(), promise });
  promise.catch(() => cache.delete(key));
  return promise;
}
export const _clearSourceCache = () => cache.clear();
const directory = () => shared('directory', () => api.getContactDirectory());
const allTasks = () => shared('tasks', () => api.getTasks());
const workspace = () => shared('assets', () => api.getPropertyWorkspace());

export const SOURCES = Object.freeze({
  org: { label: 'Org Chart from People', short: 'Org Chart' },
  workflow: { label: 'Workflow as Diagram', short: 'Workflow' },
  tasks: { label: 'Task Dependencies', short: 'Task Dependencies' },
  systems: { label: 'Systems Map', short: 'Systems' },
});

// ---- Org chart -------------------------------------------------------------

/** The reporting tree under `rootEmail` (everyone, when empty), `depth`
 *  levels down (0 = all). A box per person: name, then job title.
 *  `byCompany` (Neil, 11/08/2026: "Group By Company") boxes each company's
 *  people together, the arrows still running manager to report. */
export function orgGraph(people, rootEmail = '', depth = 0, { byCompany = false } = {}) {
  const g = orgTree(people, rootEmail, depth);
  if (!byCompany) return g;
  const byKey = new Map((people || []).filter((p) => p?.email).map((p) => [`p:${String(p.email).toLowerCase()}`, p]));
  const groups = new Map();
  for (const n of g.nodes) {
    const p = byKey.get(n.id);
    const name = String(p?.companyName || p?.company || '').trim() || 'No Company';
    if (!groups.has(name)) groups.set(name, { id: `c${groups.size + 1}`, label: name, glyph: 'building-2', parent: '', members: [] });
    groups.get(name).members.push(n.id);
  }
  return { ...g, groups: [...groups.values()] };
}

function orgTree(people, rootEmail, depth) {
  const list = (people || []).filter((p) => p?.email);
  const byEmail = new Map(list.map((p) => [String(p.email).toLowerCase(), p]));
  const kids = new Map();
  for (const p of list) {
    const m = String(p.managerEmail || '').toLowerCase();
    if (m && byEmail.has(m) && m !== String(p.email).toLowerCase()) {
      if (!kids.has(m)) kids.set(m, []);
      kids.get(m).push(p);
    }
  }
  const root = String(rootEmail || '').toLowerCase();
  const tops = root ? [byEmail.get(root)].filter(Boolean)
    : list.filter((p) => { const m = String(p.managerEmail || '').toLowerCase(); return !byEmail.has(m) || m === String(p.email).toLowerCase(); });
  const nodes = [];
  const edges = [];
  const seen = new Set();
  const walk = (p, level, parent) => {
    const key = String(p.email).toLowerCase();
    if (seen.has(key) || nodes.length >= 200) return;
    seen.add(key);
    const title = p.jobTitle || p.title || '';
    nodes.push({ id: `p:${key}`, label: title ? `${p.name || key}\n${title}` : (p.name || key), shape: 'step' });
    if (parent) edges.push({ from: parent, to: `p:${key}`, label: '' });
    if (depth && level >= depth) return;
    const sorted = [...(kids.get(key) || [])].sort((a, b) => String(a.name).localeCompare(String(b.name)));
    for (const k of sorted) walk(k, level + 1, `p:${key}`);
  };
  for (const t of tops) walk(t, 1, null);
  return { nodes, edges, truncated: nodes.length >= 200 };
}

// ---- Workflow --------------------------------------------------------------

const WF_SHAPE = { trigger: 'terminal', stop: 'terminal', gate: 'decision', if: 'decision', approval: 'decision', fault: 'note' };

/** A workflow's definition, read through the Workflows canvas's own layout
 *  (the same steps, branches and answer labels the builder draws), as a
 *  graph. Join points are folded away: what flows into one flows on. */
export function workflowGraph(definition, layoutFn, wordsFn) {
  const laid = layoutFn(definition || {});
  const kind = new Map(laid.nodes.map((n) => [n.id, n.kind]));
  const nodes = laid.nodes
    .filter((n) => n.kind !== 'ghost' && n.kind !== 'join')
    .map((n) => ({ id: `w:${n.id}`, label: String(wordsFn(n) || n.label || n.kind || '').slice(0, 160), shape: WF_SHAPE[n.kind] || 'step' }));
  const keep = new Set(nodes.map((n) => n.id.slice(2)));
  const outs = new Map();
  for (const e of laid.edges) {
    if (!outs.has(e.from)) outs.set(e.from, []);
    outs.get(e.from).push(e);
  }
  // Follow joins (and empty lanes) through to the next real box.
  const ends = (id, seen = new Set()) => {
    if (keep.has(id)) return [id];
    if (seen.has(id) || kind.get(id) === 'ghost') return [];
    seen.add(id);
    return (outs.get(id) || []).flatMap((e) => ends(e.to, seen));
  };
  const edges = [];
  const dup = new Set();
  for (const e of laid.edges) {
    if (!keep.has(e.from)) continue;
    for (const to of ends(e.to)) {
      const k = `${e.from}>${to}>${e.label || ''}`;
      if (dup.has(k)) continue;
      dup.add(k);
      edges.push({ from: `w:${e.from}`, to: `w:${to}`, label: e.label || '' });
    }
  }
  return { nodes, edges };
}

// ---- Task dependencies -----------------------------------------------------

/** A project's open tasks that wait on, or hold up, another; an arrow runs
 *  from the blocker to the task it holds up. Done tasks are drawn as
 *  Start / End ovals so the finished part of a chain reads at a glance. */
export function taskGraph(tasks, projectId) {
  const pid = String(projectId);
  const inProject = (tasks || []).filter((t) => t && (String(t.projectId) === pid || (t.projectIds || []).some((p) => String(p) === pid)));
  const byId = new Map(inProject.map((t) => [String(t.id), t]));
  const linked = new Set();
  const edges = [];
  for (const t of inProject) {
    for (const b of t.blockedByIds || []) {
      if (!byId.has(String(b))) continue;   // a blocker outside the project (or out of reach) is left off
      linked.add(String(b)); linked.add(String(t.id));
      edges.push({ from: `t:${b}`, to: `t:${t.id}`, label: '' });
    }
  }
  const done = (t) => !!t.completed || t.status === 'completed';
  const nodes = [...linked].slice(0, 200).map((id) => {
    const t = byId.get(id);
    return { id: `t:${id}`, label: t.code ? `${t.code} ${t.title || ''}`.trim() : (t.title || 'Untitled Task'), shape: done(t) ? 'terminal' : 'step' };
  });
  return { nodes, edges };
}

// ---- Systems ---------------------------------------------------------------
//
// Two maps (Neil, 11/08/2026). A Property: one Asset Management property as a
// group, its equipment, utilities and vendors in groups inside it - read
// from GET /property-assets/workspace, which carries only the assets the
// caller may see (private ones are officers', scope rows narrow the rest),
// so the server decides, never this file. Nexus Connections: what Nexus runs
// on and talks to - fixed words, no addresses, no keys - for administrators
// only (the sheet offers it to them alone, like the integration settings).

const pick = (rules, text, fallback) => {
  const t = String(text || '').toLowerCase();
  for (const [re, icon] of rules) if (re.test(t)) return icon;
  return fallback;
};
const EQUIPMENT_ICONS = [[/hvac|air|heat|cool|fan/, 'fan'], [/roof/, 'house'], [/gate|fence/, 'fence'], [/door/, 'door-closed'],
  [/camera|cctv|video/, 'cctv'], [/elevator|lift/, 'arrow-up-down'], [/fire|smoke|sprinkler|alarm/, 'alarm-smoke'], [/light|lamp/, 'lightbulb'],
  [/generator|electric|panel|power/, 'plug'], [/lock|access|keypad/, 'lock'], [/forklift/, 'forklift'], [/truck|vehicle|van|car/, 'truck']];
const UTILITY_ICONS = [[/electric|power/, 'zap'], [/water|sewer/, 'droplet'], [/gas/, 'flame'], [/internet|wifi|fiber|cable/, 'wifi'],
  [/phone/, 'phone'], [/trash|waste|refuse|recycl/, 'trash-2']];
const VENDOR_ICONS = [[/fire|life safety/, 'flame'], [/elevator/, 'arrow-up-down'], [/landscap/, 'trees'], [/pest/, 'bug'],
  [/gate|door/, 'door-open'], [/camera|access/, 'cctv'], [/janitor|porter|clean/, 'spray-can'], [/hvac/, 'fan'], [/roof/, 'house']];
const two = (a, b) => [a, b].map((s) => String(s || '').trim()).filter(Boolean).join('\n');
const kindOf = (a) => (a?.kind ? a.kind : /vehicle/i.test(a?.assetType || '') ? 'vehicle' : /equipment/i.test(a?.assetType || '') ? 'equipment' : 'property');
const sameAddress = (a, b) => { const n = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); return !!n(a) && n(a) === n(b); };

/** One property's map from the workspace the server sent: the property a
 *  group, Equipment / Utilities / Vendors groups inside it. */
export function propertyGraph(ws, propertyId) {
  const pid = String(propertyId);
  const p = (ws?.properties || []).find((x) => String(x.id) === pid && !x.deleted);
  if (!p) return { nodes: [], edges: [], groups: [] };
  const rows = (c) => (ws?.[c] || []).filter((r) => String(r.propertyId) === pid && !r.deleted);
  const nodes = [];
  const groups = [{ id: 'site', label: p.name || p.address || 'Property', glyph: 'building', parent: '', members: [] }];
  const add = (gid, label, glyph, items) => {
    if (!items.length) return;
    const g = { id: gid, label, glyph, parent: 'site', members: [] };
    const seen = new Set();
    for (const it of items.slice(0, 40)) {
      // The record's own id, so Refresh keeps each box on the same record.
      let id = `${gid}:${it.key}`;
      for (let k = 2; seen.has(id); k += 1) id = `${gid}:${it.key}~${k}`;
      seen.add(id);
      nodes.push({ id, label: it.label.slice(0, 120), shape: 'step', glyph: it.glyph });
      g.members.push(id);
    }
    groups.push(g);
  };
  const equipment = [
    ...(ws?.properties || []).filter((a) => !a.deleted && a.id !== p.id && kindOf(a) !== 'property' && (String(a.parentId || '') === pid || sameAddress(a.address, p.address)))
      .map((a) => ({ key: `a${a.id}`, label: two(a.name, [a.make, a.model].filter(Boolean).join(' ')), glyph: kindOf(a) === 'vehicle' ? 'truck' : pick(EQUIPMENT_ICONS, `${a.equipType} ${a.name}`, 'wrench') })),
    ...[...new Set(rows('warranties').map((w) => String(w.scope || '').trim()).filter(Boolean))]
      .map((s) => ({ key: `w${s.toLowerCase()}`, label: s, glyph: pick(EQUIPMENT_ICONS, s, 'wrench') })),
  ];
  add('equipment', 'Equipment', 'wrench', equipment.filter((e) => e.label));
  add('utilities', 'Utilities', 'zap', rows('utilities').map((u, i) => ({ key: u.id != null ? `r${u.id}` : `n${i}`, label: two(u.service, u.provider) || 'Utility', glyph: pick(UTILITY_ICONS, u.service, 'plug') })));
  add('vendors', 'Vendors', 'briefcase', rows('vendors').map((v, i) => ({ key: v.id != null ? `r${v.id}` : `n${i}`, label: two(v.company, v.category) || 'Vendor', glyph: pick(VENDOR_ICONS, `${v.category} ${v.company}`, 'briefcase') })));
  if (!nodes.length) return { nodes: [], edges: [], groups: [] };
  return { nodes, edges: [], groups };
}

/** Nexus and what it connects to, in the text grammar (graph.js). Fixed
 *  words - no hosts, no keys - so it can live in the client. */
export const NEXUS_MAP_TEXT = [
  'Hosting | cloud:',
  '  Cloudflare Pages | globe',
  '  Azure API | server',
  '  Supabase | database',
  'Microsoft | building-2:',
  '  Entra ID | key-round',
  '  Microsoft 365 | mail',
  '  Teams | message-square',
  'Business Systems | briefcase:',
  '  Intacct | landmark',
  '  Cubby | warehouse',
  '  Egnyte | folder',
  'Nexus in the Browser | monitor =app=> Cloudflare Pages',
  'Nexus in the Browser =data=> Azure API',
  'Nexus in the Browser -sign-in-> Entra ID',
  'Azure API => Supabase',
  'Azure API -mail-> Microsoft 365',
  'Azure API -posts-> Teams',
  'Azure API -.sync.-> Intacct',
  'Azure API -.15-min sync.-> Cubby',
  'Azure API -.file sweep.-> Egnyte',
].join('\n');

// ---- Loading ---------------------------------------------------------------

/** The choices a source's picker offers: [{ value, label }]. */
export async function sourceOptions(source) {
  if (source === 'org') {
    const d = await directory();
    const people = (d?.people || []).filter((p) => p?.email);
    return [{ value: '', label: 'Everyone' }, ...people
      .sort((a, b) => String(a.name).localeCompare(String(b.name)))
      .map((p) => ({ value: String(p.email).toLowerCase(), label: p.jobTitle ? `${p.name} - ${p.jobTitle}` : p.name }))];
  }
  if (source === 'workflow') {
    const list = await api.wfList({ scope: 'company' });
    return (Array.isArray(list) ? list : []).map((w) => ({ value: String(w.id), label: w.name || 'Untitled Workflow' }));
  }
  if (source === 'tasks') {
    const list = await api.getTaskProjects();
    return (Array.isArray(list) ? list : []).filter((p) => !p.archived).map((p) => ({ value: String(p.id), label: p.name || 'Untitled Project' }));
  }
  if (source === 'systems') {   // the properties the server let this person see
    const ws = await workspace();
    return (ws?.properties || []).filter((p) => !p.deleted && kindOf(p) === 'property')
      .map((p) => ({ value: `property:${p.id}`, label: p.name || p.address || 'Untitled Property' }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }
  return [];
}

/** The graph for one source and choice, from today's data (`fresh`: past
 *  the shared copy - Refresh). `group`: 'company' boxes an org chart by company. */
export async function loadGraph(source, ref, { fresh = false, group = '' } = {}) {
  if (fresh) cache.clear();
  if (source === 'org') {
    const d = await directory();
    return orgGraph(d?.people || [], ref, 0, { byCompany: group === 'company' });
  }
  if (source === 'systems') {
    if (ref === 'nexus') return parseText(NEXUS_MAP_TEXT);
    return propertyGraph(await workspace(), String(ref || '').replace(/^property:/, ''));
  }
  if (source === 'workflow') {
    const [w, catalog, canvas, words, defs] = await Promise.all([
      api.wfGet(ref), api.wfCatalog().catch(() => null),
      import('../../../workflows/canvas/layout'), import('../../../workflows/canvas/words'), import('../../../workflows/lib/definition'),
    ]);
    // What the builder shows: the draft when there is one, normalized the same way.
    return workflowGraph(defs.normalizeDefinition(w?.draft || w?.definition), canvas.layout, (n) => words.nodeWords(n, catalog, null));
  }
  if (source === 'tasks') {
    const tasks = await allTasks();
    return taskGraph(Array.isArray(tasks) ? tasks : tasks?.tasks || [], ref);
  }
  return { nodes: [], edges: [] };
}

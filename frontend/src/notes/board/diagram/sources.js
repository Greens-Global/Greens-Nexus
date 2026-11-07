// Diagrams from Nexus data (Neil, 11/06/2026): each source turns rows the
// caller may already read into the plain graph (graph.js). A placed diagram
// is a SNAPSHOT - its boxes carry `customData.nexusDiagram` ({ id, source,
// ref, dir }) so Refresh can draw it again from today's data; nothing
// redraws by itself. No new endpoint and no second access rule: the org
// chart is the Contact Directory (company walls apply), a workflow is
// GET /workflows/{id} (its own rule), tasks are GET /tasks.
import { api } from '../../../api';

export const SOURCES = Object.freeze({
  org: { label: 'Org Chart from People', short: 'Org Chart' },
  workflow: { label: 'Workflow as Diagram', short: 'Workflow' },
  tasks: { label: 'Task Dependencies', short: 'Task Dependencies' },
});

// ---- Org chart -------------------------------------------------------------

/** The reporting tree under `rootEmail` (everyone, when empty), `depth`
 *  levels down (0 = all). A box per person: name, then job title. */
export function orgGraph(people, rootEmail = '', depth = 0) {
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
  const inProject = (tasks || []).filter((t) => t && String(t.projectId) === String(projectId));
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

// ---- Loading ---------------------------------------------------------------

/** The choices a source's picker offers: [{ value, label }]. */
export async function sourceOptions(source) {
  if (source === 'org') {
    const d = await api.getContactDirectory();
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
  return [];
}

/** The graph for one source and choice, from today's data. */
export async function loadGraph(source, ref) {
  if (source === 'org') {
    const d = await api.getContactDirectory();
    return orgGraph(d?.people || [], ref);
  }
  if (source === 'workflow') {
    const [w, catalog, canvas, words] = await Promise.all([
      api.wfGet(ref), api.wfCatalog().catch(() => null),
      import('../../../workflows/canvas/layout'), import('../../../workflows/canvas/words'),
    ]);
    return workflowGraph(w?.definition?.trigger ? w.definition : (w?.draft || w?.definition), canvas.layout, (n) => words.nodeWords(n, catalog, null));
  }
  if (source === 'tasks') {
    const tasks = await api.getTasks();
    return taskGraph(Array.isArray(tasks) ? tasks : tasks?.tasks || [], ref);
  }
  return { nodes: [], edges: [] };
}

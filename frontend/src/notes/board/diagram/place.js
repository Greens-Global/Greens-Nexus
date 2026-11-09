// Putting a built diagram on the board (Neil, 11/06/2026) - the pure part:
// ids that never collide, the data stamp Refresh reads, and the merge that
// swaps a rebuilt diagram in as ONE change (old pieces deleted with a new
// version, reused ids bumped) so undo takes it back in one step and the live
// session's newest-version-wins carries it to everyone.

const nonce = () => Math.floor(Math.random() * 0x7fffffff);

export const newStamp = () => `dg${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** The graph with every node id under `prefix` - a diagram placed twice
 *  never shares an id; Refresh reuses its stamp so its ids stay put. */
export function prefixGraph(graph, prefix) {
  const id = (v) => `${prefix}:${v}`;
  return {
    ...graph,
    nodes: (graph?.nodes || []).map((n) => ({ ...n, id: id(n.id) })),
    edges: (graph?.edges || []).map((e) => ({ ...e, from: id(e.from), to: id(e.to) })),
    groups: (graph?.groups || []).map((g) => ({ ...g, id: id(g.id), parent: g.parent ? id(g.parent) : '', members: (g.members || []).map(id) })),
  };
}

/** A data diagram's boxes carry where they came from. */
export function stampBoxes(elements, nodeIds, meta) {
  const ids = new Set(nodeIds);
  return elements.map((e) => (ids.has(e.id) ? { ...e, customData: { ...(e.customData || {}), nexusDiagram: meta } } : e));
}

/** The data stamp on the selection (the first selected box that has one). */
export function stampOf(elements, selectedIds) {
  for (const e of elements || []) {
    if (!e.isDeleted && selectedIds?.[e.id] && e.customData?.nexusDiagram?.source) return e.customData.nexusDiagram;
  }
  return null;
}

/** The selection map of every live box carrying stamp `id`. */
export function stampSelection(elements, id) {
  const out = {};
  for (const e of elements || []) if (!e.isDeleted && e.customData?.nexusDiagram?.id === id) out[e.id] = true;
  return out;
}

/** `current` with `built` swapped in: a built element whose id is already
 *  there replaces it one version up; whatever of `replaced` the build did
 *  not bring back is deleted (one version up). New elements go on the end. */
export function mergeBuilt(current, built, replaced = new Set()) {
  const byId = new Map(built.map((e) => [e.id, e]));
  const out = [];
  for (const e of current) {
    const next = byId.get(e.id);
    if (next) {
      out.push({ ...next, version: Math.max(e.version || 1, next.version || 1) + 1, versionNonce: nonce(), isDeleted: false });
      byId.delete(e.id);
    } else if (replaced.has(e.id) && !e.isDeleted) {
      out.push({ ...e, isDeleted: true, version: (e.version || 1) + 1, versionNonce: nonce(), updated: Date.now() });
    } else {
      out.push(e);
    }
  }
  for (const e of byId.values()) out.push(e);
  return out;
}

/** Where a new diagram goes: centered on what the stage shows - unless
 *  that would land on something already drawn, then beside everything,
 *  to the right, top-aligned with it. */
export function placeOrigin(center, size, elements) {
  const at = { x: Math.round(center.x - size.w / 2), y: Math.round(center.y - size.h / 2) };
  const live = (elements || []).filter((e) => !e.isDeleted && Number.isFinite(e.x) && Number.isFinite(e.y));
  const hit = live.some((e) => e.x < at.x + size.w && at.x < e.x + (e.width || 0) && e.y < at.y + size.h && at.y < e.y + (e.height || 0));
  if (!hit) return at;
  return {
    x: Math.round(Math.max(...live.map((e) => e.x + (e.width || 0))) + 160),
    y: Math.round(Math.min(...live.map((e) => e.y))),
  };
}

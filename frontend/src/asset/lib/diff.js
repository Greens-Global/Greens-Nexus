// Row-level diff between two workspace snapshots: what a save has to carry.
//
// Every mutation in App.jsx produces a whole new store; the save does not need
// to know which of the thirty mutations ran - it compares the store before and
// after and sends only the rows that changed: an added or edited row is an
// upsert (it keeps the `_rev` it was read with, so the server can tell a stale
// row), a missing row is a delete, a new log entry is an append.
export const ROW_COLLECTIONS = ['properties', 'warranties', 'inspections', 'documents', 'ahj', 'utilities',
  'vendors', 'vservice', 'odometer', 'vdocs', 'maintenance'];

const same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** `{ properties: { upsert, delete }, ..., logs: { append } }`, or null when nothing changed. */
export function diffStore(prev, next) {
  const out = {};
  let any = false;
  for (const coll of ROW_COLLECTIONS) {
    const before = new Map();
    for (const row of prev?.[coll] || []) if (row && row.id != null) before.set(row.id, row);
    const upsert = [];
    const seen = new Set();
    for (const row of next?.[coll] || []) {
      if (!row || row.id == null) continue;
      seen.add(row.id);
      const old = before.get(row.id);
      if (!old || !same(old, row)) upsert.push(row);
    }
    const del = [...before.keys()].filter((id) => !seen.has(id));
    if (upsert.length || del.length) { out[coll] = { upsert, delete: del }; any = true; }
  }
  const had = new Set((prev?.logs || []).map((l) => l && l.id).filter(Boolean));
  const append = (next?.logs || []).filter((l) => l && l.id && !had.has(l.id));
  if (append.length) { out.logs = { append }; any = true; }
  return any ? out : null;
}

/** Folds `ops` into `into` (both the diff shape): a later upsert of a row replaces an
 *  earlier one, a delete cancels an earlier upsert, an upsert cancels an earlier delete. */
export function mergeOps(into, ops) {
  const out = into || {};
  for (const coll of ROW_COLLECTIONS) {
    const o = ops?.[coll];
    if (!o) continue;
    const cur = out[coll] || { upsert: [], delete: [] };
    const ups = new Map(cur.upsert.map((r) => [r.id, r]));
    const dels = new Set(cur.delete);
    for (const r of o.upsert || []) { ups.set(r.id, r); dels.delete(r.id); }
    for (const id of o.delete || []) { ups.delete(id); dels.add(id); }
    out[coll] = { upsert: [...ups.values()], delete: [...dels] };
  }
  if (ops?.logs?.append?.length) {
    const cur = out.logs || { append: [] };
    const ids = new Set(cur.append.map((l) => l.id));
    out.logs = { append: [...cur.append, ...ops.logs.append.filter((l) => !ids.has(l.id))] };
  }
  return out;
}

export function opsEmpty(ops) {
  if (!ops) return true;
  for (const coll of ROW_COLLECTIONS) if (ops[coll] && (ops[coll].upsert.length || ops[coll].delete.length)) return false;
  return !(ops.logs && ops.logs.append.length);
}

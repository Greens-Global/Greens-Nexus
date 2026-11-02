// A board's shared state (Notes whiteboard, Neil 11/02/2026): the engine's
// elements in a Yjs map, one entry per element id, replaced whole whenever
// that element changes; file meta (id -> {id, mimeType, url, created}) in a
// second map. Both ride the same encrypted channel a note's words do
// (collabTransport.js); this module is the glue between that document and
// the engine on screen.
//
// Rules, the engine's own (packages/excalidraw/data/reconcile.ts): every
// element carries `version` (bumped on each change) and a random
// `versionNonce`; of two copies of one element the higher version wins, a
// tie goes to the LOWER nonce, so every browser settles on the same copy
// without talking. Anything that came from the document goes on the engine
// with CAPTURE_NEVER, so the other person's work never enters this
// person's undo stack. A viewer's binding reads and renders, never writes.
//
// No engine import here: the hook that owns this (useBoardCollab) is part of
// NotesPage, and importing the engine would pull its 3 MB chunk into every
// visit to Notes. The engine's `CaptureUpdateAction.NEVER` is the string
// "NEVER" (store.ts) - mirrored below and pinned by Board.test.jsx's mock.
import * as Y from 'yjs';

export const ELEMENTS = 'elements';
export const FILES = 'files';
/** The transaction origin of this browser's own changes. */
export const LOCAL = 'nx-board-local';
export const CAPTURE_NEVER = 'NEVER';

const plain = (v) => JSON.parse(JSON.stringify(v));

/** A shared document made from a parsed scene (scene.js parseScene). */
export function seedBoardDoc(scene) {
  const doc = new Y.Doc();
  doc.transact(() => {
    const els = doc.getMap(ELEMENTS);
    for (const e of scene?.elements || []) if (e && typeof e.id === 'string') els.set(e.id, plain(e));
    const files = doc.getMap(FILES);
    for (const [id, meta] of Object.entries(scene?.files || {})) if (meta && typeof meta === 'object') files.set(id, plain({ ...meta, id: meta.id || id }));
  }, LOCAL);
  return doc;
}

/** Elements in the document, in the engine's z-order when every one carries its fractional index. */
export function docElements(doc) {
  const out = [...doc.getMap(ELEMENTS).values()];
  return orderElements(out);
}

export function docFiles(doc) {
  const out = {};
  doc.getMap(FILES).forEach((meta, id) => { out[id] = meta; });
  return out;
}

function orderElements(list) {
  if (list.length > 1 && list.every((e) => typeof e?.index === 'string' && e.index)) {
    return [...list].sort((a, b) => (a.index < b.index ? -1 : a.index > b.index ? 1 : 0));
  }
  return list;
}

// ── is a stored state safe to put on the engine? ─────────────────────────
// It came from an editor's browser, never through the server: every value
// must be a plain element - an object with a string id, finite numbers, no
// functions, nothing nested deeper than the engine's own shapes go.
function plainOk(v, depth = 0) {
  if (depth > 12) return false;
  if (v == null || typeof v === 'boolean' || typeof v === 'string') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.every((x) => plainOk(x, depth + 1));
  if (typeof v === 'object') return Object.values(v).every((x) => plainOk(x, depth + 1));
  return false;
}
/** Throws when the shared document could not be shown safely. */
export function validateBoardDoc(doc) {
  doc.getMap(ELEMENTS).forEach((e, id) => {
    if (!e || typeof e !== 'object' || Array.isArray(e)) throw new Error('A shared element is not an element');
    if (typeof e.id !== 'string' || e.id !== id || typeof e.type !== 'string') throw new Error('A shared element has no id');
    if (!plainOk(e)) throw new Error('A value in the shared board is not plain');
  });
  doc.getMap(FILES).forEach((m) => {
    if (!m || typeof m !== 'object' || typeof m.url !== 'string' || !plainOk(m)) throw new Error('A shared file is not a file');
  });
}

/** Does `theirs` replace `mine`? The engine's rule: higher version, then lower nonce. */
export function remoteWins(mine, theirs) {
  if (!mine) return true;
  if (!theirs) return false;
  const mv = mine.version || 0, tv = theirs.version || 0;
  if (tv !== mv) return tv > mv;
  const mn = mine.versionNonce ?? 0, tn = theirs.versionNonce ?? 0;
  return tn < mn;
}

/** The engine's elements merged with the document's: newest copy per id, local order kept, new ones appended. */
export function reconcile(local, remote) {
  const byId = new Map();
  const order = [];
  for (const e of local || []) if (e && e.id) { byId.set(e.id, e); order.push(e.id); }
  for (const r of remote || []) {
    if (!r || !r.id) continue;
    const mine = byId.get(r.id);
    if (!mine) { byId.set(r.id, r); order.push(r.id); } else if (remoteWins(mine, r)) byId.set(r.id, r);
  }
  return orderElements(order.map((id) => byId.get(id)));
}

/**
 * The binding between one document and one engine.
 *   attach(api, { onRemoteFiles })  - the engine is on screen: put the document's
 *                                      elements on it, and its newer ones into the document
 *   push(elements, filesMeta)       - this browser changed something (no-op for a viewer)
 *   detach()
 */
export function createBoardBinding({ doc, canEdit }) {
  const els = doc.getMap(ELEMENTS);
  const files = doc.getMap(FILES);
  let api = null;
  let onRemoteFiles = null;
  let applyQueued = false;
  let knownFiles = new Set();

  const applyRemote = () => {
    applyQueued = false;
    if (!api) return;
    const next = reconcile(api.getSceneElementsIncludingDeleted(), docElements(doc));
    api.updateScene({ elements: next, captureUpdate: CAPTURE_NEVER });
  };
  const scheduleApply = () => {
    if (applyQueued) return;
    applyQueued = true;
    queueMicrotask(applyRemote);
  };
  const onElements = (_ev, tr) => { if (tr.origin !== LOCAL) scheduleApply(); };
  const onFiles = (ev, tr) => {
    if (tr.origin === LOCAL || !onRemoteFiles) return;
    const fresh = {};
    ev.keysChanged.forEach((id) => {
      const meta = files.get(id);
      if (meta && !knownFiles.has(id)) { knownFiles.add(id); fresh[id] = meta; }
    });
    if (Object.keys(fresh).length) onRemoteFiles(fresh);
  };
  els.observe(onElements);
  files.observe(onFiles);

  const push = (elements, filesMeta) => {
    if (!canEdit) return;
    const changedEls = (elements || []).filter((e) => e && typeof e.id === 'string' && remoteWins(els.get(e.id), e));
    const newFiles = Object.entries(filesMeta || {}).filter(([id, meta]) => meta && !files.has(id));
    if (!changedEls.length && !newFiles.length) return;
    doc.transact(() => {
      for (const e of changedEls) els.set(e.id, plain(e));
      for (const [id, meta] of newFiles) { files.set(id, plain({ ...meta, id: meta.id || id })); knownFiles.add(id); }
    }, LOCAL);
  };

  return {
    attach(nextApi, opts = {}) {
      api = nextApi;
      onRemoteFiles = opts.onRemoteFiles || null;
      files.forEach((_m, id) => knownFiles.add(id));
      // What the document has goes on the engine; what the engine already
      // drew (a reopened board, a rebuilt session) goes into the document.
      if (canEdit) push(api.getSceneElementsIncludingDeleted(), {});
      scheduleApply();
    },
    push,
    detach() {
      els.unobserve(onElements);
      files.unobserve(onFiles);
      api = null;
      onRemoteFiles = null;
      knownFiles = new Set();
    },
  };
}

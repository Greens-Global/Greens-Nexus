// A Board's scene (Notes whiteboard, Neil 11/02/2026): what is saved on the
// note row's `scene` column and what the drawing engine (behind the adapter
// in ./engine, mounted by Board.jsx) is fed. Pure: no engine import, so the
// list, the API client and the tests read a scene without loading the 2.7 MB
// chunk.
//
// Shape:
//   { type: 'nexus-board', version: 1, look: 'clean' | 'sketch',
//     elements: [...engine elements], appState: {safe subset}, files: { id: {id, mimeType, url, created} } }
//
// Files never carry a dataURL here - images live in the private task-files
// bucket and the scene keeps their URL (loaded back through the signed viewer
// by files.js). App state is pruned to what a reopened board should restore:
// never selection, collaborators, open menus or the pointer.
export const SCENE_TYPE = 'nexus-board';
export const SCENE_VERSION = 1;
export const SCENE_MAX = 2_000_000;   // characters of JSON - the API refuses more (413)
export const LOOKS = ['clean', 'sketch'];
export const SAFE_APP_STATE_KEYS = [
  'viewBackgroundColor', 'gridSize', 'gridModeEnabled', 'zenModeEnabled',
  'currentItemFontFamily', 'currentItemRoughness', 'currentItemStrokeColor', 'currentItemBackgroundColor',
  'scrollX', 'scrollY', 'zoom',
];
// Deleted elements ride along for a day so a collaborator who was offline
// still receives the deletion; after that they are pruned from the saved scene.
export const DELETED_KEEP_MS = 24 * 3600 * 1000;

// The engine's font family ids (@excalidraw/excalidraw FONT_FAMILY), copied so
// this module stays engine-free: Nunito is the engine's "Normal" sans,
// Excalifont its hand-drawn face. Both ship self-hosted (copy-excalidraw-assets).
export const FONT_SANS = 6;      // Nunito
export const FONT_HAND = 5;      // Excalifont
export const FONT_CODE = 3;      // Cascadia

export const NEXUS_INK = '#1c2420';
// The Nexus palette the Clean look starts from (the picker still offers the
// engine's own swatches - the engine has no palette prop in 0.18).
export const NEXUS_COLORS = {
  ink: NEXUS_INK, green: '#15803d', blue: '#2563eb', amber: '#b45309', red: '#b91c1c', slate: '#64748b',
};

export function lookDefaults(look) {
  if (look === 'sketch') {
    return { currentItemRoughness: 1, currentItemFontFamily: FONT_HAND, currentItemStrokeColor: NEXUS_INK };
  }
  return { currentItemRoughness: 0, currentItemFontFamily: FONT_SANS, currentItemStrokeColor: NEXUS_INK };
}

const normalizeLook = (look) => (LOOKS.includes(look) ? look : 'clean');

export function emptyScene(look = 'clean') {
  const lk = normalizeLook(look);
  return {
    type: SCENE_TYPE,
    version: SCENE_VERSION,
    look: lk,
    elements: [],
    appState: { viewBackgroundColor: '#ffffff', gridModeEnabled: false, ...lookDefaults(lk) },
    files: {},
  };
}

function pruneAppState(appState) {
  const out = {};
  if (!appState || typeof appState !== 'object') return out;
  for (const k of SAFE_APP_STATE_KEYS) {
    if (appState[k] !== undefined && appState[k] !== null) out[k] = appState[k];
  }
  return out;
}

function pruneFiles(files) {
  const out = {};
  if (!files || typeof files !== 'object') return out;
  for (const [id, f] of Object.entries(files)) {
    if (!f || typeof f !== 'object' || !f.url) continue;
    // Never a picture inlined into the scene: images live in the bucket.
    if (/^\s*data:/i.test(String(f.url))) continue;
    out[id] = { id: f.id || id, mimeType: f.mimeType || 'application/octet-stream', url: String(f.url), created: Number(f.created) || Date.now() };
  }
  return out;
}

/** The saved string -> a scene. '' / null is a fresh clean board; anything
 *  that is not a Nexus board (or not JSON) is null so the caller can refuse it. */
export function parseScene(str) {
  if (str == null || str === '') return emptyScene('clean');
  let raw;
  try { raw = typeof str === 'string' ? JSON.parse(str) : str; } catch { return null; }
  if (!raw || typeof raw !== 'object' || raw.type !== SCENE_TYPE) return null;
  const look = normalizeLook(raw.look);
  return {
    type: SCENE_TYPE,
    version: Number(raw.version) || SCENE_VERSION,
    look,
    elements: Array.isArray(raw.elements) ? raw.elements : [],
    appState: { ...lookDefaults(look), ...pruneAppState(raw.appState) },
    files: pruneFiles(raw.files),
  };
}

/** Engine state -> the scene object that is saved (the adapter's toScene). */
export function buildScene({ elements, appState, filesMeta, look }) {
  const now = Date.now();
  const kept = (elements || []).filter((e) => e && (!e.isDeleted || (now - (Number(e.updated) || 0)) < DELETED_KEEP_MS));
  return {
    type: SCENE_TYPE,
    version: SCENE_VERSION,
    look: normalizeLook(look),
    elements: kept,
    appState: pruneAppState(appState),
    files: pruneFiles(filesMeta),
  };
}

/** Engine state -> the saved string. */
export function serializeScene(state) {
  return JSON.stringify(buildScene(state));
}

/**
 * The scene guard before a save (Neil, 11/02/2026): a deleted element older
 * than DELETED_KEEP_MS (its `updated` more than a day before `now`) is
 * dropped - every collaborator has had a day to receive its deletion - and
 * so is a file no kept element points at. A scene still over SCENE_MAX
 * after this is refused by Board.jsx with a notice, never sent as a 413.
 * The rule is the day, never "since this tab's last save" (11/02/2026:
 * that pruned a deletion a collaborator who saved in between had not seen,
 * so the shape came back). Pure and non-destructive: a new object, the
 * input untouched.
 */
export function compact(scene, { now = Date.now() } = {}) {
  if (!scene || typeof scene !== 'object' || !Array.isArray(scene.elements)) return scene;
  const cutoff = (Number(now) || Date.now()) - DELETED_KEEP_MS;
  const elements = scene.elements.filter((e) => e && (!e.isDeleted || (Number(e.updated) || 0) > cutoff));
  const used = new Set();
  for (const e of elements) if (e.type === 'image' && e.fileId) used.add(e.fileId);
  const files = {};
  for (const [id, meta] of Object.entries(scene.files || {})) if (used.has(id)) files[id] = meta;
  return { ...scene, elements, files };
}

/**
 * Whether two saved scenes (strings) are the same drawing. The server
 * re-dumps JSON with non-ASCII escaped (`"\ud83d\ude00"` for an emoji the
 * browser sent as itself), so the string a Board sent and the one that
 * comes back as the note's scene can differ while meaning the same thing;
 * the parsed values are compared. A string that is not JSON only equals
 * itself.
 */
export function sameScene(a, b) {
  if (a === b) return true;
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  let pa; let pb;
  try { pa = JSON.parse(a); pb = JSON.parse(b); } catch { return false; }
  return deepEqual(pa, pb);
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a); const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!Object.prototype.hasOwnProperty.call(b, k) || !deepEqual(a[k], b[k])) return false;
  return true;
}

const nonce = () => Math.floor(Math.random() * 0x7fffffff);

/** Rewrite every element for a look: roughness on everything, the font on
 *  text. Untouched elements come back as the same object so the engine only
 *  redraws what changed; changed ones get a new version and nonce so a
 *  collaborator's reconcile takes them. */
export function applyLook(elements, look) {
  const d = lookDefaults(normalizeLook(look));
  return (elements || []).map((e) => {
    if (!e || e.isDeleted) return e;
    const next = {};
    if (typeof e.roughness === 'number' && e.roughness !== d.currentItemRoughness) next.roughness = d.currentItemRoughness;
    if (e.type === 'text' && e.fontFamily !== d.currentItemFontFamily) next.fontFamily = d.currentItemFontFamily;
    if (!Object.keys(next).length) return e;
    return { ...e, ...next, version: (Number(e.version) || 0) + 1, versionNonce: nonce(), updated: Date.now() };
  });
}

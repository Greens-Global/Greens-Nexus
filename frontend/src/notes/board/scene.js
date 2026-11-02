// A board's scene (Notes whiteboard, Neil 11/02/2026) - the pure half:
// what a `kind: 'board'` note keeps in its `scene` column, read and written
// as one JSON string. The engine never sees this file; Board.jsx translates.
//
// TASK C STUB: the same signatures as the plan's Interfaces block; Task A's
// file replaces this one at merge (keep the exports identical).
export const SCENE_TYPE = 'nexus-board';
export const SCENE_MAX = 2_000_000;                  // characters of JSON
export const LOOKS = ['clean', 'sketch'];
export const SAFE_APP_STATE_KEYS = ['viewBackgroundColor', 'gridSize', 'gridModeEnabled', 'zenModeEnabled', 'currentItemFontFamily', 'currentItemRoughness', 'currentItemStrokeColor', 'currentItemBackgroundColor', 'scrollX', 'scrollY', 'zoom'];

export function lookDefaults(look = 'clean') {
  return look === 'sketch'
    ? { currentItemRoughness: 1, currentItemFontFamily: 1 }
    : { currentItemRoughness: 0, currentItemFontFamily: 2, currentItemStrokeColor: '#1c2420' };
}

export function emptyScene(look = 'clean') {
  return { type: SCENE_TYPE, version: 1, look: LOOKS.includes(look) ? look : 'clean', elements: [], appState: { viewBackgroundColor: '#ffffff', ...lookDefaults(look) }, files: {} };
}

/** Tolerant: '' (a brand-new board) is an empty Clean scene; anything that is not a board scene is null. */
export function parseScene(str) {
  if (str == null || str === '') return emptyScene('clean');
  let s;
  try { s = typeof str === 'string' ? JSON.parse(str) : str; } catch { return null; }
  if (!s || typeof s !== 'object' || s.type !== SCENE_TYPE) return null;
  return {
    type: SCENE_TYPE,
    version: Number(s.version) || 1,
    look: LOOKS.includes(s.look) ? s.look : 'clean',
    elements: Array.isArray(s.elements) ? s.elements : [],
    appState: s.appState && typeof s.appState === 'object' ? s.appState : {},
    files: s.files && typeof s.files === 'object' ? s.files : {},
  };
}

export function applyLook(elements, look) {
  const d = lookDefaults(look);
  return (elements || []).map((el) => ({ ...el, roughness: d.currentItemRoughness, ...(el.type === 'text' ? { fontFamily: d.currentItemFontFamily } : {}) }));
}

const DAY = 24 * 3600 * 1000;
export function serializeScene({ elements = [], appState = {}, filesMeta = {}, look = 'clean' }) {
  const now = Date.now();
  const kept = elements.filter((el) => !el.isDeleted || (now - (el.updated || 0)) < DAY);
  const app = {};
  for (const k of SAFE_APP_STATE_KEYS) if (appState[k] !== undefined) app[k] = appState[k];
  return JSON.stringify({ type: SCENE_TYPE, version: 1, look: LOOKS.includes(look) ? look : 'clean', elements: kept, appState: app, files: filesMeta });
}

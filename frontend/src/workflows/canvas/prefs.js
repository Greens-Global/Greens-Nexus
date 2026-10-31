// What each person keeps about the builder (10/30/2026): the view they
// last used (canvas or recipe) and the canvas skin. Per browser, in
// localStorage, read and written inside try/catch - a private window or a
// blocked store just gives the defaults (canvas, paper). Phones never ask:
// Builder forces the recipe below 640px whatever is stored.

const VIEW_KEY = 'wf-builder-view';
const SKIN_KEY = 'wf-canvas-skin';

const read = (key, allowed, fallback) => {
  try {
    const v = window.localStorage.getItem(key);
    return allowed.includes(v) ? v : fallback;
  } catch { return fallback; }
};
const write = (key, v) => { try { window.localStorage.setItem(key, v); } catch { /* a blocked store keeps the default */ } };

export const VIEWS = ['canvas', 'recipe'];
export const SKINS = ['paper', 'night'];

export const builderView = () => read(VIEW_KEY, VIEWS, 'canvas');
export const setBuilderView = (v) => write(VIEW_KEY, v);
export const canvasSkin = () => read(SKIN_KEY, SKINS, 'paper');
export const setCanvasSkin = (s) => write(SKIN_KEY, s);

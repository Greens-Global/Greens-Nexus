// Getting a board out (Notes whiteboard, Neil 11/02/2026): PNG, SVG, the
// clipboard, and the board's own file. Everything is client-side through the
// engine adapter's export calls (./engine); nothing goes to anyone's servers.
// The engine is already here whenever a board is on screen, so awaiting
// loadEngine() costs nothing then; `downloadScene` without a handle needs no
// engine at all.
import { loadEngine } from './engine';
import { serializeScene } from './scene';

/** The engine's live state as the exports want it, from the handle. */
function exportable(api) {
  return { elements: api.getSceneElements(), files: api.getFiles(), appState: { ...api.getAppState(), exportEmbedScene: false } };
}

/** A PNG of the whole board, 2x by default. `background: false` leaves it transparent. */
export async function exportPng(api, { scale = 2, background = true } = {}) {
  const engine = await loadEngine();
  return engine.exportPng(exportable(api), { scale, background });
}

/** A smaller PNG for the note list and the Dashboard widget. */
export async function exportThumb(api, width = 480) {
  const raw = exportable(api);
  if (!raw.elements.length) return null;
  const engine = await loadEngine();
  return engine.exportPng(raw, { scale: 1, background: true, padding: 12, maxWidth: width });
}

export async function exportSvg(api) {
  const engine = await loadEngine();
  return engine.exportSvg(exportable(api));
}

export async function copyPng(api) {
  const engine = await loadEngine();
  await engine.copyPng(exportable(api));
}

const safeName = (title) => (String(title || 'Untitled Board').trim() || 'Untitled Board').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80);

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The board's own file: the saved scene, re-serialized from the engine when
 *  a handle is given (so unsaved strokes are included), else the note's scene. */
export function downloadScene(note, api = null, look = note?.look) {
  const json = api
    ? serializeScene({ elements: api.getSceneElementsIncludingDeleted(), appState: api.getAppState(), filesMeta: note?.filesMeta || {}, look })
    : (note?.scene || '');
  downloadBlob(new Blob([json], { type: 'application/json' }), `${safeName(note?.title)}.nexusboard.json`);
}

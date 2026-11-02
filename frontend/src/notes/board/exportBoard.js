// Getting a board out (Notes whiteboard, Neil 11/02/2026): PNG, SVG, the
// clipboard, and the board's own file. Everything is client-side through the
// engine's export helpers; nothing goes to Excalidraw's servers.
import { exportToBlob, exportToSvg, exportToClipboard } from '@excalidraw/excalidraw';
import { serializeScene } from './scene';

const PADDING = 24;

function exportable(api) {
  const appState = api.getAppState();
  return {
    elements: api.getSceneElements(),
    files: api.getFiles(),
    appState: { ...appState, exportEmbedScene: false },
  };
}

/** A PNG of the whole board, 2x by default. `background: false` leaves it transparent. */
export async function exportPng(api, { scale = 2, background = true } = {}) {
  const { elements, files, appState } = exportable(api);
  return exportToBlob({
    elements, files, mimeType: 'image/png', exportPadding: PADDING,
    appState: { ...appState, exportBackground: background, exportScale: scale, exportWithDarkMode: false },
  });
}

/** A smaller PNG for the note list and the Dashboard widget. */
export async function exportThumb(api, width = 480) {
  const { elements, files, appState } = exportable(api);
  if (!elements.length) return null;
  return exportToBlob({
    elements, files, mimeType: 'image/png', exportPadding: 12,
    appState: { ...appState, exportBackground: true, exportScale: 1, exportWithDarkMode: false },
    getDimensions: (w, h) => { const s = Math.min(1, width / Math.max(1, w)); return { width: Math.round(w * s), height: Math.round(h * s), scale: s }; },
  });
}

export async function exportSvg(api) {
  const { elements, files, appState } = exportable(api);
  const svg = await exportToSvg({ elements, files, exportPadding: PADDING, appState: { ...appState, exportBackground: true, exportWithDarkMode: false } });
  return new XMLSerializer().serializeToString(svg);
}

export async function copyPng(api) {
  const { elements, files, appState } = exportable(api);
  await exportToClipboard({ elements, files, type: 'png', appState: { ...appState, exportBackground: true, exportWithDarkMode: false } });
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
 *  an api is given (so unsaved strokes are included), else the note's scene. */
export function downloadScene(note, api = null, look = note?.look) {
  const json = api
    ? serializeScene({ elements: api.getSceneElementsIncludingDeleted(), appState: api.getAppState(), filesMeta: note?.filesMeta || {}, look })
    : (note?.scene || '');
  downloadBlob(new Blob([json], { type: 'application/json' }), `${safeName(note?.title)}.nexusboard.json`);
}

// The Excalidraw adapter (Neil, 11/02/2026): the ONE module in the repo that
// imports @excalidraw/excalidraw (0.18, MIT, self-hosted) or its CSS -
// scripts/check-engine-imports.mjs keeps it that way. It satisfies the
// Engine contract in ./index.js; Board.jsx and the export helpers know only
// that contract. Lazy: reached through loadEngine()'s import() alone, so
// this and the package land in the vendor-excalidraw chunk together
// (vite.config.js manualChunks) and never on first paint.
//
// Nothing of the engine's own hosted features is wired: no export dialog
// (it links to its service), no library panel, no AI, no theme toggle; the
// board's menu rows are our own (Menu) and the assets are the copied fonts.
import { useCallback, useMemo } from 'react';
import {
  Excalidraw, MainMenu, THEME, CaptureUpdateAction, restoreElements,
  exportToBlob, exportToSvg, exportToClipboard,
} from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import { CAPTURE } from './index';
import { buildScene, lookDefaults } from '../scene';
import { reconcile as mergeElements } from '../boardSync';

// The engine fetches its fonts from here (copied from the package by
// scripts/copy-excalidraw-assets.mjs). main.jsx sets it before any chunk
// evaluates; this is the second line for a board mounted another way.
export const ASSET_PATH = '/excalidraw-assets/';
if (typeof window !== 'undefined' && !window.EXCALIDRAW_ASSET_PATH) window.EXCALIDRAW_ASSET_PATH = ASSET_PATH;

export const version = 'engine-0.18';

/** Elements from outside this engine (another browser over the live
 *  session, a refreshed saved scene, a draft) go through the engine's own
 *  repair, so one malformed element never throws inside the canvas loop.
 *  Text keeps its saved size unless `refreshDimensions` (a look change). */
export function restore(elements, { refreshDimensions = false } = {}) {
  const list = elements || [];
  try { return restoreElements(list, null, { refreshDimensions }); } catch { /* fall back one by one */ }
  const out = [];
  for (const el of list) {
    try { out.push(...restoreElements([el], null, { refreshDimensions })); } catch { /* dropped: it could not be drawn */ }
  }
  return out;
}

/** The engine's live state -> the saved shape (scene.js builds it; files are our metas, never the engine's dataURLs). */
export function toScene(raw) {
  return buildScene({ elements: raw?.elements, appState: raw?.appState, filesMeta: raw?.files ?? raw?.filesMeta, look: raw?.look });
}

/** A saved scene -> what the Canvas starts from. Pictures are not here:
 *  they load through the signed viewer (files.js) once the handle is up. */
export function fromScene(scene) {
  const elements = Array.isArray(scene?.elements) ? scene.elements : [];
  return {
    elements,
    appState: { ...lookDefaults(scene?.look), ...(scene?.appState || {}) },
    files: {},
    scrollToContent: elements.length > 0,
  };
}

/** The canvas's elements merged with copies from outside: the engine's own
 *  rule (newest version, then lower nonce - boardSync.js), the outside
 *  copies repaired first. */
export function reconcile(local, remote) {
  return mergeElements(local, restore(remote));
}

const PADDING = 24;
const exportable = (raw) => ({
  elements: raw?.elements || [],
  files: raw?.files || {},
  appState: { ...(raw?.appState || {}), exportEmbedScene: false, exportWithDarkMode: false },
});

/** A PNG of the whole board: 2x with a background by default; `maxWidth`
 *  bounds it (the thumbnail), `background: false` leaves it transparent. */
export async function exportPng(raw, { scale = 2, background = true, padding = PADDING, maxWidth = 0 } = {}) {
  const { elements, files, appState } = exportable(raw);
  const opts = {
    elements, files, mimeType: 'image/png', exportPadding: padding,
    appState: { ...appState, exportBackground: background, exportScale: scale },
  };
  if (maxWidth > 0) {
    opts.getDimensions = (w, h) => { const s = Math.min(1, maxWidth / Math.max(1, w)); return { width: Math.round(w * s), height: Math.round(h * s), scale: s }; };
  }
  return exportToBlob(opts);
}

export async function exportSvg(raw) {
  const { elements, files, appState } = exportable(raw);
  const svg = await exportToSvg({ elements, files, exportPadding: PADDING, appState: { ...appState, exportBackground: true } });
  return new XMLSerializer().serializeToString(svg);
}

export async function copyPng(raw) {
  const { elements, files, appState } = exportable(raw);
  await exportToClipboard({ elements, files, type: 'png', appState: { ...appState, exportBackground: true } });
}

// The board's own menu rows, in the engine's menu. Thin wrappers so the
// package's components are named here alone.
function MenuRoot({ children }) { return <MainMenu>{children}</MainMenu>; }
function MenuItem({ icon, onSelect, children }) { return <MainMenu.Item icon={icon} onSelect={onSelect}>{children}</MainMenu.Item>; }
function MenuCustom({ children }) { return <MainMenu.ItemCustom>{children}</MainMenu.ItemCustom>; }
function MenuSeparator() { return <MainMenu.Separator />; }
export const Menu = { Root: MenuRoot, Item: MenuItem, Custom: MenuCustom, Separator: MenuSeparator };

/**
 * The canvas. `scene` (a NexusScene) is read once per mount; from there the
 * engine owns the state and reports it through `onChange(raw)`; everything
 * imperative goes through the handle `onReady` hands up. Read-only is the
 * engine's view mode with no image tool; the exports, the file loader and
 * the theme toggle of the engine's own are never shown.
 */
export function Canvas({
  scene, onChange, look, readOnly = false, viewportRef, onReady, theme = 'light', name,
  phone = false, autoFocus, collaborating = false, onPointerUpdate, topRight = null, menu = null, children,
}) {
  const initialData = useMemo(() => fromScene(scene), [scene]);
  const uiOptions = useMemo(() => ({
    canvasActions: {
      changeViewBackgroundColor: !readOnly,
      clearCanvas: !readOnly,
      export: false,            // our menu exports; never the engine's dialog (it links to its own service)
      loadScene: false,
      saveToActiveFile: false,
      saveAsImage: false,
      toggleTheme: false,       // follows the app's theme
    },
    tools: { image: !readOnly },
  }), [readOnly]);
  const handleChange = useCallback((elements, appState, files) => { onChange?.({ elements, appState, files }); }, [onChange]);
  return (
    <div ref={viewportRef} className="nx-engine" data-look={look}>
      <Excalidraw
        excalidrawAPI={onReady}
        initialData={initialData}
        onChange={handleChange}
        viewModeEnabled={readOnly}
        theme={theme === 'dark' ? THEME.DARK : THEME.LIGHT}
        langCode="en-US"
        name={name || 'Untitled Board'}
        UIOptions={uiOptions}
        aiEnabled={false}
        validateEmbeddable={false}
        detectScroll={false}
        handleKeyboardGlobally={false}
        autoFocus={autoFocus ?? (!readOnly && !phone)}
        isCollaborating={collaborating}
        onPointerUpdate={onPointerUpdate}
        renderTopRightUI={topRight ? () => topRight : undefined}
      >
        {menu}
        {children}
      </Excalidraw>
    </div>
  );
}

/** The contract's capture words are the engine's own strings (store.ts) - checked by excalidraw.test.jsx. */
export const captureWords = () => ({ IMMEDIATELY: CaptureUpdateAction.IMMEDIATELY, NEVER: CaptureUpdateAction.NEVER });

const engine = { Canvas, toScene, fromScene, exportPng, exportSvg, reconcile, version, restore, copyPng, Menu, CAPTURE };
export default engine;

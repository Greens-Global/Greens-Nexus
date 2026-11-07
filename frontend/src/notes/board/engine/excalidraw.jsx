// The Excalidraw adapter (Neil, 11/02/2026): the ONE module in the repo that
// imports @excalidraw/excalidraw (0.18, MIT, self-hosted) or its CSS -
// scripts/check-engine-imports.mjs keeps it that way. It satisfies the
// Engine contract in ./index.js; Board.jsx and the export helpers know only
// that contract. Lazy: reached through loadEngine()'s import() alone, so
// this and the package land in the build's own lazy chunk for it (no
// manual chunk - see vite.config.js) and never on first paint.
//
// Nothing of the engine's own hosted features is wired: no export dialog
// (it links to its service), no library panel, no AI, no theme toggle; the
// board's menu rows are our own (Menu) and the assets are the copied fonts.
import { useCallback, useMemo } from 'react';
import {
  Excalidraw, MainMenu, THEME, CaptureUpdateAction, restoreElements,
  exportToBlob, exportToSvg, exportToClipboard, convertToExcalidrawElements,
} from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import { CAPTURE } from './index';
import { buildScene, lookDefaults, NEXUS_INK } from '../scene';
import { SHAPE_STYLE, edgePoints } from '../diagram/graph';
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

/**
 * The markup bar's hands on the engine (Board.jsx's MarkupBar, Neil
 * 11/06/2026). `root` is the element the Canvas sits in (undo / redo are the
 * engine's own history actions, reached through its keyboard handler on its
 * container - 0.18 has no api call for them).
 */
function pressKey(root, init) {
  const target = root?.querySelector?.('.excalidraw') || root;
  if (!target?.dispatchEvent) return false;
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ctrlKey: !mac, metaKey: mac, ...init }));
  return true;
}
export const markup = {
  setTool(handle, { engine: type, locked = false } = {}) {
    try { handle?.setActiveTool?.({ type, locked }); return true; } catch { return false; }
  },
  setStyle(handle, appState) {
    try { handle?.updateScene?.({ appState, captureUpdate: CaptureUpdateAction.NEVER }); } catch { /* engine not ready */ }
  },
  /** The engine's own properties panel (fill, opacity, font, layers) - on
   *  a phone it opens above the markup dock; again closes it. */
  toggleStyle(handle) {
    try {
      const open = handle?.getAppState?.()?.openMenu === 'shape';
      handle?.updateScene?.({ appState: { openMenu: open ? null : 'shape' }, captureUpdate: CaptureUpdateAction.NEVER });
    } catch { /* engine not ready */ }
  },
  undo: (root) => pressKey(root, { key: 'z', code: 'KeyZ' }),
  redo: (root) => pressKey(root, { key: 'z', code: 'KeyZ', shiftKey: true }),
  /** Built elements (a comment pin, already measured) through the engine's repair. */
  prepare: (elements) => restore(elements, { refreshDimensions: false }),
};

/**
 * The diagram builder's hands on the engine (Neil, 11/06/2026,
 * board/diagram/). `build` turns a placed graph (graph.js `layout`) into
 * elements through the engine's own skeleton converter, which ties every
 * arrow to its two boxes and measures each label; box ids are kept (Tidy Up
 * rebuilds boxes in place). `grow` is the engine's flowchart key - Ctrl/Cmd
 * + an arrow adds the next box, tied and spaced, and the key's release
 * commits it - pressed for the + buttons.
 */
const BOX_TYPE = { step: 'rectangle', decision: 'diamond', terminal: 'ellipse', note: 'rectangle' };
const ARROW_KEY = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' };
export const diagram = {
  build(placed, { look = 'clean' } = {}) {
    const d = lookDefaults(look);
    const at = new Map(placed.nodes.map((n) => [n.id, n]));
    const skeleton = [];
    for (const n of placed.nodes) {
      const s = n.style || {};
      const colors = SHAPE_STYLE[n.shape] || SHAPE_STYLE.step;
      const { fontSize, fontFamily, textColor, ...box } = s;
      skeleton.push({
        type: BOX_TYPE[n.shape] || 'rectangle', id: n.id, x: n.x, y: n.y, width: n.w, height: n.h,
        strokeColor: colors.stroke, backgroundColor: colors.fill, fillStyle: 'solid', strokeWidth: 2,
        roughness: d.currentItemRoughness, roundness: n.shape === 'step' || n.shape === 'note' ? { type: 3 } : null,
        ...box,
        label: n.label ? {
          text: n.label, fontSize: fontSize || 18, fontFamily: fontFamily || d.currentItemFontFamily, strokeColor: textColor || NEXUS_INK,
        } : undefined,
      });
    }
    for (const e of placed.edges) {
      const a = at.get(e.from);
      const b = at.get(e.to);
      if (!a || !b) continue;
      const [x1, y1, x2, y2] = edgePoints(a, b, placed.dir, 6);
      skeleton.push({
        type: 'arrow', x: x1, y: y1, width: Math.abs(x2 - x1), height: Math.abs(y2 - y1), points: [[0, 0], [x2 - x1, y2 - y1]],
        strokeColor: NEXUS_INK, strokeWidth: 2, roughness: d.currentItemRoughness, roundness: null, endArrowhead: 'arrow',
        ...(e.style || {}),
        start: { id: e.from }, end: { id: e.to },
        label: e.label ? { text: e.label, fontSize: 16, fontFamily: d.currentItemFontFamily } : undefined,
      });
    }
    return convertToExcalidrawElements(skeleton, { regenerateIds: false });
  },
  grow(root, side) {
    const key = ARROW_KEY[side];
    if (!key || !pressKey(root, { key, code: key })) return false;
    document.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Control', code: 'ControlLeft' }));   // the engine hears key-ups on document
    return true;
  },
};

/** The contract's capture words are the engine's own strings (store.ts) - checked by excalidraw.test.jsx. */
export const captureWords = () => ({ IMMEDIATELY: CaptureUpdateAction.IMMEDIATELY, NEVER: CaptureUpdateAction.NEVER });

const engine = { Canvas, toScene, fromScene, exportPng, exportSvg, reconcile, version, restore, copyPng, Menu, CAPTURE, markup, diagram };
export default engine;

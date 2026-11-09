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
import { SHAPE_STYLE, EDGE_STYLE, GROUP_STYLE, GROUP_LABEL, MARKS, edgeRoute, edgePorts, glyphBox } from '../diagram/graph';
import { glyphShapes } from '../diagram/glyphs';
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
  // A Record Card's link (customData.nexusRecord, Neil 11/07/2026) opens the
  // record inside Nexus; every other link keeps the engine's own behavior.
  onRecordOpen,
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
  const handleLinkOpen = useCallback((element, event) => {
    const ref = element?.customData?.nexusRecord?.ref;
    if (!ref || !onRecordOpen) return;
    event?.preventDefault?.();
    onRecordOpen(ref);
  }, [onRecordOpen]);
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
        onLinkOpen={handleLinkOpen}
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
 *
 * Groups, arrow kinds, glyphs and elbow arrows (Neil, 11/08/2026):
 *  - a GROUP is a rounded box (customData.nexusGroup) with its label (an
 *    unbound text, nexusGroupLabel) and glyph, sharing one engine group id
 *    with every member - not the engine's frame, which cannot hold a frame
 *    inside it and clips what it holds. Selecting a member selects the whole
 *    group, so it moves as one; an inner group carries both ids.
 *  - every arrow is an ELBOW arrow (`elbowed`), tied to its two boxes with
 *    fixed points on their sides: the first route is graph.js `edgeRoute`
 *    (right angles round every box and group label), and when a box moves
 *    the engine routes it again from the same sides. A label on an arrow is
 *    the engine's bound text, which cuts the line round it (the halo).
 *  - a GLYPH is vector: glyphs.jsx's shapes as plain lines, boxes and
 *    ellipses (nexusGlyphOf), grouped with the box they sit on.
 */
const BOX_TYPE = { step: 'rectangle', decision: 'diamond', terminal: 'ellipse', note: 'rectangle' };
const ARROW_KEY = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' };
const sizeOf = (pts) => ({ width: Math.max(...pts.map((p) => p[0])) - Math.min(...pts.map((p) => p[0])), height: Math.max(...pts.map((p) => p[1])) - Math.min(...pts.map((p) => p[1])) });
/** Neutral glyph shapes (glyphs.jsx) -> skeleton elements. */
function glyphSkeleton(shapes, { owner, groupIds, frameId }) {
  return shapes.map((p, i) => {
    const base = {
      id: `${owner}:glyph:${i}`, strokeColor: p.stroke || 'transparent', backgroundColor: p.fill || 'transparent', fillStyle: 'solid',
      strokeWidth: p.width || 1, roughness: 0, groupIds, customData: { [MARKS.glyphOf]: owner }, ...(frameId ? { frameId } : {}),
    };
    if (p.kind === 'line') {
      const [x0, y0] = p.points[0];
      const points = p.points.map(([x, y]) => [x - x0, y - y0]);
      return { ...base, type: 'line', x: x0, y: y0, points, ...sizeOf(points), roundness: null };
    }
    return { ...base, type: p.kind === 'ellipse' ? 'ellipse' : 'rectangle', x: p.x, y: p.y, width: Math.max(0.5, p.w), height: Math.max(0.5, p.h), roundness: p.r ? { type: 3, value: p.r } : null };
  });
}
export const diagram = {
  build(placed, { look = 'clean' } = {}) {
    const d = lookDefaults(look);
    const at = new Map(placed.nodes.map((n) => [n.id, n]));
    const groups = placed.groups || [];
    // A node's engine groups: its glyph's, then its group's and that group's parent.
    const chain = new Map();
    for (const g of groups) for (const m of g.members || []) chain.set(m, g.parent ? [g.id, g.parent] : [g.id]);
    const skeleton = [];
    for (const g of groups) {   // outer first: drawn behind the inner ones and the boxes
      const st = g.parent ? GROUP_STYLE.inner : GROUP_STYLE.outer;
      const ids = g.parent ? [g.id, g.parent] : [g.id];
      const lx = g.x + GROUP_LABEL.dx; const ly = g.y + GROUP_LABEL.dy;
      skeleton.push({
        type: 'rectangle', id: `${g.id}:box`, x: g.x, y: g.y, width: g.w, height: g.h,
        strokeColor: st.stroke, backgroundColor: st.fill, fillStyle: 'solid', strokeWidth: 1,
        roughness: d.currentItemRoughness, roundness: { type: 3, value: 8 }, groupIds: ids,
        customData: { [MARKS.group]: { gid: g.id, label: g.label, glyph: g.glyph || '', parent: g.parent || '' } },
      });
      if (g.glyph) {
        skeleton.push(...glyphSkeleton(glyphShapes(g.glyph, { x: lx, y: ly + 1, w: GROUP_LABEL.glyph, h: GROUP_LABEL.glyph, ink: st.ink }), { owner: g.id, groupIds: ids }));
      }
      skeleton.push({
        type: 'text', id: `${g.id}:label`, x: lx + (g.glyph ? GROUP_LABEL.glyph + 6 : 0), y: ly, text: g.label,
        fontSize: GROUP_LABEL.size, fontFamily: d.currentItemFontFamily, strokeColor: st.ink, groupIds: ids,
        customData: { [MARKS.groupLabel]: g.id },
      });
    }
    for (const n of placed.nodes) {
      const s = n.style || {};
      const colors = SHAPE_STYLE[n.shape] || SHAPE_STYLE.step;
      const { fontSize, fontFamily, textColor, textAlign, verticalAlign, groupIds: own = [], customData, ...box } = s;
      const groupIds = [...(n.glyph ? [`${n.id}:glyph`] : []), ...(chain.get(n.id) || []), ...own];
      skeleton.push({
        type: BOX_TYPE[n.shape] || 'rectangle', id: n.id, x: n.x, y: n.y, width: n.w, height: n.h,
        strokeColor: colors.stroke, backgroundColor: colors.fill, fillStyle: 'solid', strokeWidth: 2,
        roughness: d.currentItemRoughness, roundness: n.shape === 'step' || n.shape === 'note' ? { type: 3 } : null,
        ...box,
        groupIds,
        ...(customData || n.glyph ? { customData: { ...(customData || {}), nexusGlyph: n.glyph || undefined } } : {}),
        label: n.label ? {
          text: n.label, fontSize: fontSize || 18, fontFamily: fontFamily || d.currentItemFontFamily, strokeColor: textColor || NEXUS_INK,
          ...(textAlign ? { textAlign } : {}), ...(verticalAlign ? { verticalAlign } : {}),
          // the label travels with its box: same frame, same groups
          ...(box.frameId ? { frameId: box.frameId } : {}), ...(groupIds.length ? { groupIds } : {}),
        } : undefined,
      });
      if (n.glyph) {
        skeleton.push(...glyphSkeleton(glyphShapes(n.glyph, { ...glyphBox(n), ink: textColor || NEXUS_INK }), { owner: n.id, groupIds, frameId: box.frameId }));
      }
    }
    const ports = edgePorts(placed);
    placed.edges.forEach((e, i) => {
      const a = at.get(e.from);
      const b = at.get(e.to);
      if (!a || !b) return;
      const route = edgeRoute(a, b, placed, 6, ports[i]);
      const [x0, y0] = route[0];
      const points = route.map(([x, y]) => [x - x0, y - y0]);
      const kind = EDGE_STYLE[e.kind] ? e.kind : 'normal';
      const k = EDGE_STYLE[kind];
      const { groupIds: own = [], ...style } = e.style || {};
      const shared = (chain.get(e.from) || []).filter((g) => (chain.get(e.to) || []).includes(g));
      skeleton.push({
        type: 'arrow', x: x0, y: y0, points, ...sizeOf(points),
        strokeColor: k.stroke, strokeWidth: k.width, strokeStyle: k.dash ? 'dashed' : 'solid',
        roughness: d.currentItemRoughness, endArrowhead: 'arrow',
        ...style,
        roundness: null, elbowed: true, groupIds: [...shared, ...own],
        customData: { [MARKS.edge]: kind },
        start: { id: e.from }, end: { id: e.to },
        label: e.label ? { text: e.label, fontSize: 16, fontFamily: d.currentItemFontFamily, ...(shared.length ? { groupIds: shared } : {}) } : undefined,
      });
    });
    // A group label is measured before the board may have loaded its font, and
    // the engine draws a text no wider than it was measured: give it room
    // (left-aligned, so the room is invisible) or it comes out a letter short.
    return convertToExcalidrawElements(skeleton, { regenerateIds: false }).map((e) => (e.customData?.[MARKS.groupLabel]
      ? { ...e, width: Math.max(e.width || 0, Math.ceil(String(e.text || '').length * GROUP_LABEL.size * 0.62) + 4) } : e));
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

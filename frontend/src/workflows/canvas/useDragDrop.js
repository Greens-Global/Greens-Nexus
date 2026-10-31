// Drag and drop on the sheet (10/30/2026). Two drags: a block from the
// dock (a ghost rides under the pointer) and a step already on the sheet
// (the block itself lifts, tilts and follows). While either is held, the
// insert point nearest the pointer (within 40 screen px) is armed; letting
// go on it inserts or moves, letting go anywhere else drops the ghost or
// springs the step back to its slot. A press that never moves 5px is a
// tap: on a step it selects, on a dock block it appends to the workflow.
// Pointer math reads refs, never state, so it is right mid-gesture.
import { useCallback, useRef, useState } from 'react';
import { toScreen, toWorld } from './viewport';
import { measure } from './useCanvasView';

const ARM_PX = 40;
const MOVE_PX = 5;
const SPRING = 'cubic-bezier(.34,1.4,.64,1)';

export function useDragDrop({ sheetRef, viewRef, layoutRef, nodeEls, ghostRef, onInsert, onMove, canMove, onTap, onNodeClick, enabled = true, animate = true }) {
  const drag = useRef(null);
  const [armed, setArmed] = useState(null);      // the armed hot's id
  const [ghostKind, setGhostKind] = useState(''); // '' when no dock block is in the air
  const [dragging, setDragging] = useState(false);

  const nearestHot = useCallback((cx, cy, allow) => {
    const L = layoutRef.current; if (!L) return null;
    const view = viewRef.current; const box = measure(sheetRef.current) || { left: 0, top: 0 };
    let best = null; let bd = ARM_PX;
    for (const h of L.hots) {
      if (allow && !allow(h)) continue;
      const p = toScreen(view, box, h.x, h.y);
      const d = Math.hypot(p.x - cx, p.y - cy);
      if (d < bd) { bd = d; best = h; }
    }
    return best;
  }, [layoutRef, viewRef, sheetRef]);

  const finish = useCallback(() => {
    const d = drag.current; drag.current = null;
    setArmed(null); setGhostKind(''); setDragging(false);
    if (d && d.listeners) d.listeners.forEach(([t, f]) => window.removeEventListener(t, f));
    return d;
  }, []);

  const listen = useCallback((onMoveEv, onUpEv) => {
    const up = (e) => onUpEv(e);
    const ls = [['pointermove', onMoveEv], ['pointerup', up], ['pointercancel', up]];
    ls.forEach(([t, f]) => window.addEventListener(t, f));
    return ls;
  }, []);

  const nodePointerDown = useCallback((e, node) => {
    if (!enabled || e.button) return;
    if (!node.step) { // the trigger and the gate: select only
      drag.current = { type: 'select', id: node.id, sx: e.clientX, sy: e.clientY };
      drag.current.listeners = listen(() => {}, (ev) => { const d = finish(); if (d && Math.hypot(ev.clientX - d.sx, ev.clientY - d.sy) < MOVE_PX) onNodeClick && onNodeClick(d.id); });
      return;
    }
    const el = nodeEls.current.get(node.id);
    const box = measure(sheetRef.current) || { left: 0, top: 0 };
    const w = toWorld(viewRef.current, box, e.clientX, e.clientY);
    const d = { type: 'node', node, el, sx: e.clientX, sy: e.clientY, ox: w.x - node.x, oy: w.y - node.y, moved: false, hot: null };
    const from = { path: node.path, index: node.index };
    const allow = (h) => canMove(from, { path: h.insert.path, index: h.insert.index });
    const move = (ev) => {
      if (!d.moved) {
        if (Math.hypot(ev.clientX - d.sx, ev.clientY - d.sy) < MOVE_PX) return;
        d.moved = true; setDragging(true); if (el) el.classList.add('is-dragging');
      }
      const b = measure(sheetRef.current) || { left: 0, top: 0 };
      const p = toWorld(viewRef.current, b, ev.clientX, ev.clientY);
      if (el) el.style.transform = `translate(${p.x - d.ox}px, ${p.y - d.oy}px) rotate(1.5deg)`;
      const hot = nearestHot(ev.clientX, ev.clientY, allow);
      if ((hot && hot.id) !== (d.hot && d.hot.id)) { d.hot = hot; setArmed(hot ? hot.id : null); }
    };
    const upEv = () => {
      const done = finish(); if (!done) return;
      if (!done.moved) { onNodeClick && onNodeClick(node.id); return; }
      if (el) el.classList.remove('is-dragging');
      if (done.hot) { onMove(from, { path: done.hot.insert.path, index: done.hot.insert.index }); return; }
      if (el) {
        const home = `translate(${node.x}px, ${node.y}px)`;
        const lifted = el.style.transform;
        el.style.transform = home;
        if (animate && typeof el.animate === 'function') { try { el.animate([{ transform: lifted }, { transform: home }], { duration: 380, easing: SPRING }); } catch { /* no spring, still home */ } }
      }
    };
    d.listeners = listen(move, upEv);
    drag.current = d;
  }, [enabled, nodeEls, sheetRef, viewRef, canMove, nearestHot, finish, listen, onMove, onNodeClick, animate]);

  const palettePointerDown = useCallback((e, kind) => {
    if (!enabled || e.button) return;
    const d = { type: 'palette', kind, sx: e.clientX, sy: e.clientY, moved: false, hot: null };
    const place = (ev) => { const g = ghostRef.current; if (g) { g.style.left = `${ev.clientX}px`; g.style.top = `${ev.clientY}px`; } };
    const move = (ev) => {
      if (!d.moved) { if (Math.hypot(ev.clientX - d.sx, ev.clientY - d.sy) < MOVE_PX) return; d.moved = true; setDragging(true); setGhostKind(kind); }
      place(ev);
      const hot = nearestHot(ev.clientX, ev.clientY, null);
      if ((hot && hot.id) !== (d.hot && d.hot.id)) { d.hot = hot; setArmed(hot ? hot.id : null); }
    };
    const upEv = () => {
      const done = finish(); if (!done) return;
      if (!done.moved) { onTap && onTap(kind); return; }
      if (done.hot) onInsert(kind, { path: done.hot.insert.path, index: done.hot.insert.index });
    };
    d.listeners = listen(move, upEv);
    drag.current = d;
  }, [enabled, ghostRef, nearestHot, finish, listen, onInsert, onTap]);

  return { nodePointerDown, palettePointerDown, armed, ghostKind, dragging };
}

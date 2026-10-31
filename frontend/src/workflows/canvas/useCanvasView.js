// Pan and zoom state for the sheet (10/30/2026). The view is { x, y, s };
// `viewRef` always holds the latest one for pointer math that runs
// outside React's render. Opening: reading size on the trigger's column
// once the sheet has a size (fitView / openingView in viewport.js);
// plain wheel pans, Ctrl / Cmd + wheel (a trackpad pinch) zooms at the
// pointer; dragging the paper pans.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ZOOM_STEP, fitView, openingView, panBy, zoomAt } from './viewport';

export function measure(el) {
  if (!el || typeof el.getBoundingClientRect !== 'function') return null;
  const r = el.getBoundingClientRect();
  return { left: r.left || 0, top: r.top || 0, width: r.width || 0, height: r.height || 0 };
}

export function useCanvasView(sheetRef, layout, initialView = null) {
  const [view, setViewState] = useState(initialView || { x: 0, y: 0, s: 1 });
  const viewRef = useRef(view);
  const opened = useRef(!!initialView);
  const pan = useRef(null);
  const [panning, setPanning] = useState(false);
  const [box, setBox] = useState(null);

  // The sheet's size, for the minimap's viewport box: measured after every
  // layout and whenever the window changes size.
  useLayoutEffect(() => { setBox(measure(sheetRef.current)); }, [layout, sheetRef]);
  useEffect(() => {
    const onResize = () => setBox(measure(sheetRef.current));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [sheetRef]);

  const setView = useCallback((next) => {
    setViewState((prev) => { const v = typeof next === 'function' ? next(prev) : next; viewRef.current = v; return v; });
  }, []);

  // The first layout with a measurable sheet sets the opening view.
  useLayoutEffect(() => {
    if (opened.current || !layout) return;
    const box = measure(sheetRef.current);
    if (!box || !box.width) return;
    opened.current = true;
    const trigger = layout.nodes.find((n) => n.kind === 'trigger');
    setView(openingView(layout, box, trigger));
  }, [layout, sheetRef, setView]);

  const fit = useCallback(() => { if (layout) setView(fitView(layout, measure(sheetRef.current))); }, [layout, sheetRef, setView]);
  const zoomBy = useCallback((factor) => {
    const box = measure(sheetRef.current) || { width: 0, height: 0 };
    setView((v) => zoomAt(v, factor, box.width / 2, box.height / 2));
  }, [sheetRef, setView]);
  const zoomIn = useCallback(() => zoomBy(ZOOM_STEP), [zoomBy]);
  const zoomOut = useCallback(() => zoomBy(1 / ZOOM_STEP), [zoomBy]);

  // Wheel: a passive listener cannot preventDefault, so it is attached by hand.
  useEffect(() => {
    const el = sheetRef.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      e.preventDefault();
      const box = measure(el) || { left: 0, top: 0 };
      if (e.ctrlKey || e.metaKey) setView((v) => zoomAt(v, Math.exp(-e.deltaY * 0.01), e.clientX - box.left, e.clientY - box.top));
      else setView((v) => panBy(v, -e.deltaX, -e.deltaY));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [sheetRef, setView]);

  // The pan in progress keeps its `up` here so an unmount mid-drag (the view
  // toggles, the builder leaves) can take the window listeners down with it.
  const panUp = useRef(null);
  const startPan = useCallback((e) => {
    if (panUp.current) panUp.current();
    pan.current = { sx: e.clientX, sy: e.clientY, vx: viewRef.current.x, vy: viewRef.current.y };
    setPanning(true);
    const move = (ev) => { const p = pan.current; if (!p) return; setView((v) => ({ ...v, x: p.vx + (ev.clientX - p.sx), y: p.vy + (ev.clientY - p.sy) })); };
    const up = () => { pan.current = null; panUp.current = null; setPanning(false); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); };
    panUp.current = up;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }, [setView]);
  useEffect(() => () => { if (panUp.current) panUp.current(); }, []);

  return { view, viewRef, setView, fit, zoomIn, zoomOut, startPan, panning, box };
}

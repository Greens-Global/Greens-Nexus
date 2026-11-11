// Word's rulers (Neil, 11/11/2026: "There's also no ruler which should be on
// by default on both sides"). View > Ruler turns them off, remembered in the
// person's profile.
//
// The horizontal ruler sits over the page, pinned under the ribbon while the
// pages scroll: inches counted from the left margin, the margins shaded. Drag
// a margin's edge to change it (Page Setup's custom margins); drag Word's
// markers to indent the paragraphs you are in - the first-line triangle on
// top, the hanging triangle and the left-indent box under it (the box moves
// both), the right-indent triangle on the right. A drag snaps to 1/16 inch;
// hold Alt to place it freely.
//
// The vertical ruler runs down the page's left edge and follows the sheet in
// view: the top and bottom margins shaded and draggable the same way.
//
// The scales are drawn on a canvas, so they stay crisp at any zoom and cost
// nothing to redraw while the pages scroll. Indents are points (what the
// paragraph stores and the exporter prints), margins inches.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

const PX_PER_IN = 96;
const PT_TO_PX = 96 / 72;
const SNAP_IN = 1 / 16;

function themeColors(el) {
  const cs = getComputedStyle(el);
  const v = (name, fallback) => (cs.getPropertyValue(name) || '').trim() || fallback;
  return { paper: v('--card', '#ffffff'), margin: v('--mist', '#eef0f3'), tick: v('--muted', '#6b7280'), ink: v('--ink', '#111827'), line: v('--line', '#e5e7eb') };
}

// A canvas sized to its box at the device's pixel ratio. `draw(ctx, w, h,
// colors)` is the latest render's; `paint()` (stable) redraws with it, after
// every render and whenever a caller asks (a scroll).
function useCanvas(draw) {
  const ref = useRef(null);
  const drawRef = useRef(draw);
  const paint = useCallback(() => {
    const c = ref.current;
    if (!c) return;
    const w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    if (/jsdom/i.test(navigator.userAgent || '')) return;   // tests: no canvas to draw on
    let ctx;
    try { ctx = c.getContext('2d'); } catch { return; }
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    drawRef.current(ctx, w, h, themeColors(c));
  }, []);
  useLayoutEffect(() => { drawRef.current = draw; paint(); });
  return [ref, paint];
}

// Ticks every 1/8 inch along [from, to] (pixels), numbered from `origin`.
function drawScale(ctx, { from, to, origin, ppi, across, vertical, colors }) {
  ctx.fillStyle = colors.tick;
  ctx.font = '9px Inter, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const step = ppi / 8;
  const start = Math.ceil((from - origin) / step);
  const end = Math.floor((to - origin) / step);
  for (let i = start; i <= end; i += 1) {
    if (i === 0) continue;
    const pos = Math.round(origin + i * step) + 0.5;
    if (i % 8 === 0) {
      const label = String(Math.abs(i / 8));
      if (vertical) ctx.fillText(label, across / 2, pos); else ctx.fillText(label, pos, across / 2);
      continue;
    }
    const len = i % 4 === 0 ? across * 0.36 : i % 2 === 0 ? across * 0.22 : across * 0.14;
    const a = (across - len) / 2;
    if (vertical) ctx.fillRect(a, pos - 0.5, len, 1); else ctx.fillRect(pos - 0.5, a, 1, len);
  }
}

// The marker shapes, drawn in SVG so they stay crisp and take pointer events.
function Marker({ kind, x, active, title, onPointerDown }) {
  const shapes = {
    first: <path d="M0.5 0.5 H9.5 L5 6.5 Z" />,
    hanging: <path d="M5 0.5 L9.5 6.5 H0.5 Z" />,
    left: <rect x="0.5" y="0.5" width="9" height="5" rx="1" />,
    right: <path d="M5 0.5 L9.5 6.5 H0.5 Z" />,
  };
  const top = { first: 0, hanging: 9, left: 16, right: 12 }[kind];
  const h = kind === 'left' ? 6 : 7;
  return (
    <svg className={`doc-ruler-marker is-${kind}${active ? ' is-dragging' : ''}`} width="10" height={h} viewBox={`0 0 10 ${h}`}
      style={{ left: x - 5, top }} role="slider" aria-label={title} title={title} onPointerDown={onPointerDown}>
      {shapes[kind]}
    </svg>
  );
}

// ── Horizontal ────────────────────────────────────────────────────────────
// widthPx: the page's drawn width. margins: { left, right } inches.
// para: { left, first, right } points, or null outside a paragraph.
export function HRuler({ widthPx, zoom = 1, margins, para, editable = true, onMargin, onIndent }) {
  const ppi = PX_PER_IN * zoom;
  const [drag, setDrag] = useState(null);   // { kind, x }
  const mL = (drag?.kind === 'marginL' ? drag.x : margins.left * ppi);
  const mR = (drag?.kind === 'marginR' ? widthPx - drag.x : margins.right * ppi);
  const ptx = PT_TO_PX * zoom;
  const leftX = margins.left * ppi + (para ? (para.left || 0) * ptx : 0);
  const firstX = leftX + (para ? (para.first || 0) * ptx : 0);
  const rightX = widthPx - margins.right * ppi - (para ? (para.right || 0) * ptx : 0);
  const at = (kind, base) => (drag?.kind === kind ? drag.x : base);
  // The left box drags the first-line marker with it.
  const shownFirst = drag?.kind === 'left' ? firstX + (drag.x - leftX) : at('first', firstX);

  const [canvasRef] = useCanvas((ctx, w, h, colors) => {
    ctx.fillStyle = colors.paper; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = colors.margin; ctx.fillRect(0, 0, mL, h); ctx.fillRect(w - mR, 0, mR, h);
    drawScale(ctx, { from: 0, to: w, origin: mL, ppi, across: h, vertical: false, colors });
  });

  const snap = (px, e) => {
    if (e.altKey) return px;
    const step = SNAP_IN * ppi;
    return Math.round(px / step) * step;
  };
  const start = (kind) => (e) => {
    if (!editable || e.button > 0) return;
    e.preventDefault(); e.stopPropagation();
    const box = e.currentTarget.closest('.doc-hruler').getBoundingClientRect();
    const clamp = (x) => {
      const minText = 0.5 * ppi;
      if (kind === 'marginL') return Math.max(0.2 * ppi, Math.min(x, widthPx - margins.right * ppi - minText));
      if (kind === 'marginR') return Math.min(widthPx - 0.2 * ppi, Math.max(x, margins.left * ppi + minText));
      if (kind === 'right') return Math.max(leftX + minText, Math.min(x, widthPx));
      return Math.max(0, Math.min(x, rightX - minText));
    };
    let last = null;
    const move = (ev) => { last = clamp(snap(ev.clientX - box.left, ev)); setDrag({ kind, x: last }); };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDrag(null);
      if (last == null) return;
      const pt = (px) => Math.round((px / ptx) * 2) / 2;
      const inch = (px) => Math.round((px / ppi) * 1000) / 1000;
      const marginPx = margins.left * ppi;
      if (kind === 'marginL') onMargin?.('left', inch(last));
      else if (kind === 'marginR') onMargin?.('right', inch(widthPx - last));
      else if (kind === 'first') onIndent?.({ indentFirst: pt(last - leftX) });
      else if (kind === 'hanging') onIndent?.({ indentLeft: pt(last - marginPx), indentFirst: pt(firstX - last) });
      else if (kind === 'left') onIndent?.({ indentLeft: pt(last - marginPx) });
      else if (kind === 'right') onIndent?.({ indentRight: pt(widthPx - margins.right * ppi - last) });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const guide = drag ? drag.x : null;
  return (
    <div className={`doc-hruler${editable ? '' : ' is-readonly'}`} style={{ width: widthPx }} aria-label="Ruler">
      <canvas ref={canvasRef} className="doc-ruler-canvas" aria-hidden="true" />
      {editable && <span className="doc-ruler-edge" style={{ left: mL - 4 }} title="Left Margin" onPointerDown={start('marginL')} />}
      {editable && <span className="doc-ruler-edge" style={{ left: widthPx - mR - 4 }} title="Right Margin" onPointerDown={start('marginR')} />}
      {para && editable && (
        <>
          <Marker kind="first" x={shownFirst} active={drag?.kind === 'first'} title="First Line Indent" onPointerDown={start('first')} />
          <Marker kind="hanging" x={at('hanging', at('left', leftX))} active={drag?.kind === 'hanging'} title="Hanging Indent" onPointerDown={start('hanging')} />
          <Marker kind="left" x={at('left', at('hanging', leftX))} active={drag?.kind === 'left'} title="Left Indent" onPointerDown={start('left')} />
          <Marker kind="right" x={at('right', rightX)} active={drag?.kind === 'right'} title="Right Indent" onPointerDown={start('right')} />
        </>
      )}
      {guide != null && (
        <>
          <span className="doc-ruler-guide" style={{ left: guide }} aria-hidden="true" />
          <span className="doc-ruler-tip" style={{ left: guide }}>
            {drag.kind === 'marginL' ? `${(guide / ppi).toFixed(2)}" Margin`
              : drag.kind === 'marginR' ? `${((widthPx - guide) / ppi).toFixed(2)}" Margin`
                : `${((guide - margins.left * ppi) / ppi).toFixed(2)}"`}
          </span>
        </>
      )}
    </div>
  );
}

// ── Vertical ──────────────────────────────────────────────────────────────
// Follows the sheets on screen: `pagesEl()` returns the element holding the
// .doc-page boxes, `scrollerEl()` the one that scrolls them. pageHeightPx is
// one sheet's height (unzoomed), gapPx the gray space between two sheets.
export function VRuler({ zoom = 1, margins, pageHeightPx, gapPx, pagesEl, scrollerEl, editable = true, onMargin }) {
  const ppi = PX_PER_IN * zoom;
  const boxRef = useRef(null);
  const [height, setHeight] = useState(0);
  const [drag, setDrag] = useState(null);   // { side, sheetTop, y }
  const sheetsRef = useRef([]);
  const sheetTops = () => {
    const box = boxRef.current?.getBoundingClientRect();
    const host = pagesEl?.();
    if (!box || !host) return [];
    const stride = (pageHeightPx + gapPx) * zoom;
    const out = [];
    host.querySelectorAll('.doc-page').forEach((pg) => {
      const r = pg.getBoundingClientRect();
      const n = Math.max(1, Math.round((r.height + gapPx * zoom) / stride));
      for (let i = 0; i < n; i += 1) out.push(r.top - box.top + i * stride);
    });
    return out;
  };
  const [canvasRef, paint] = useCanvas((ctx, w, h, colors) => {
    const tops = sheetTops();
    sheetsRef.current = tops;
    const ph = pageHeightPx * zoom;
    for (const top of tops) {
      if (top > h || top + ph < 0) continue;
      const mt = (drag?.side === 'top' && drag.sheetTop === top ? drag.y - top : margins.top * ppi);
      const mb = (drag?.side === 'bottom' && drag.sheetTop === top ? top + ph - drag.y : margins.bottom * ppi);
      ctx.fillStyle = colors.paper; ctx.fillRect(0, top, w, ph);
      ctx.fillStyle = colors.margin; ctx.fillRect(0, top, w, mt); ctx.fillRect(0, top + ph - mb, w, mb);
      ctx.save(); ctx.beginPath(); ctx.rect(0, Math.max(0, top), w, Math.min(h, top + ph) - Math.max(0, top)); ctx.clip();
      drawScale(ctx, { from: top, to: top + ph, origin: top + mt, ppi, across: w, vertical: true, colors });
      ctx.restore();
    }
  });

  // Fill the height the desk shows, and redraw as the pages scroll or move.
  useEffect(() => {
    const scroller = scrollerEl?.();
    let raf = 0;
    const measure = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const box = boxRef.current?.getBoundingClientRect();
        const sr = scroller?.getBoundingClientRect();
        if (box && sr) setHeight(Math.max(0, Math.round(sr.bottom - box.top - 6)));
        paint();
      });
    };
    measure();
    scroller?.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    const host = pagesEl?.();
    if (ro && host) ro.observe(host);
    return () => { cancelAnimationFrame(raf); scroller?.removeEventListener('scroll', measure); window.removeEventListener('resize', measure); ro?.disconnect(); };
  }, [paint, scrollerEl, pagesEl]);

  const near = (y) => {
    const ph = pageHeightPx * zoom;
    for (const top of sheetsRef.current) {
      if (Math.abs(y - (top + margins.top * ppi)) <= 4) return { side: 'top', sheetTop: top };
      if (Math.abs(y - (top + ph - margins.bottom * ppi)) <= 4) return { side: 'bottom', sheetTop: top };
    }
    return null;
  };
  const onPointerMove = (e) => {
    if (drag || !editable) return;
    const y = e.clientY - e.currentTarget.getBoundingClientRect().top;
    e.currentTarget.style.cursor = near(y) ? 'row-resize' : '';
    e.currentTarget.title = near(y)?.side === 'top' ? 'Top Margin' : near(y)?.side === 'bottom' ? 'Bottom Margin' : '';
  };
  const onPointerDown = (e) => {
    if (!editable || e.button > 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const hit = near(e.clientY - rect.top);
    if (!hit) return;
    e.preventDefault();
    const ph = pageHeightPx * zoom;
    const minText = 1 * ppi;
    let last = null;
    const move = (ev) => {
      let y = ev.clientY - rect.top;
      if (!ev.altKey) { const step = SNAP_IN * ppi; y = hit.sheetTop + Math.round((y - hit.sheetTop) / step) * step; }
      if (hit.side === 'top') y = Math.max(hit.sheetTop + 0.2 * ppi, Math.min(y, hit.sheetTop + ph - margins.bottom * ppi - minText));
      else y = Math.min(hit.sheetTop + ph - 0.2 * ppi, Math.max(y, hit.sheetTop + margins.top * ppi + minText));
      last = y;
      setDrag({ ...hit, y });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDrag(null);
      if (last == null) return;
      const inch = (px) => Math.round((px / ppi) * 1000) / 1000;
      onMargin?.(hit.side, inch(hit.side === 'top' ? last - hit.sheetTop : hit.sheetTop + ph - last));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div ref={boxRef} className="doc-vruler" style={{ height }} aria-label="Vertical Ruler">
      <canvas ref={canvasRef} className="doc-ruler-canvas" onPointerMove={onPointerMove} onPointerDown={onPointerDown} />
      {drag && (
        <span className="doc-ruler-tip is-vertical" style={{ top: drag.y }}>
          {(((drag.side === 'top' ? drag.y - drag.sheetTop : drag.sheetTop + pageHeightPx * zoom - drag.y)) / ppi).toFixed(2)}&quot; Margin
        </span>
      )}
    </div>
  );
}

export default HRuler;

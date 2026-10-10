// The org chart surface: a top-down node tree on a pan/zoom canvas. One
// implementation for People > Org Chart (where cards can be dragged to change
// who reports to whom) and Support > Contact Directory > Org Chart (read-only,
// Teams first). The canvas owns the layout, the connectors, pan, zoom (buttons,
// ctrl + wheel, trackpad pinch, two-finger pinch), fit/center and "scroll this card
// into view"; the screen owns the data, the card and any editing.
//
// Contract: `roots` are the top-level nodes, `childrenOf(node)` their children
// (already sorted), `keyOf(node)` a stable string, `renderCard(node, meta)` the
// card. Each card is wrapped in `[data-orgkey]`; a press inside one is never a
// pan, and `focusOn(key)` finds the card by it. `collapsed` is a Set of keys
// whose children are hidden; the card's own pill toggles it through
// `meta.toggle`, so the canvas never holds that state.
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { clampZoom } from './tree';

const PAN0 = { x: 40, y: 24 };

const OrgChartCanvas = forwardRef(function OrgChartCanvas({
  roots, childrenOf, keyOf, renderCard, collapsed, onToggle,
  height = 'max(480px, calc(100vh - 380px))', borderColor = 'var(--line)', emptyText = 'No one to show.',
  hint = '', gap = 48, style, children, ariaLabel = 'Org chart',
}, ref) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState(PAN0);
  const canvasRef = useRef(null);
  const contentRef = useRef(null);
  const pointers = useRef(new Map());     // active pointers on empty space, for pinch
  const pinch = useRef(null);

  const centerView = useCallback(() => requestAnimationFrame(() => {
    const c = canvasRef.current, k = contentRef.current;
    if (!c || !k) return;
    // scrollWidth reports the untransformed layout size - no zoom correction
    // needed. When the tree is wider than the canvas this puts the middle in
    // view (edges pan-reachable) rather than left-pinning.
    setZoom(1);
    setPan({ x: (c.clientWidth - k.scrollWidth) / 2, y: 24 });
  }), []);

  const fitToView = useCallback(() => requestAnimationFrame(() => {
    const c = canvasRef.current, k = contentRef.current;
    if (!c || !k) return;
    const kw = k.scrollWidth, kh = k.scrollHeight;
    if (!kw || !kh) return;
    const s = Math.max(0.35, Math.min(1, (c.clientWidth - 48) / kw, (c.clientHeight - 48) / kh));
    setZoom(s);
    setPan({ x: Math.max(24, (c.clientWidth - kw * s) / 2), y: 24 });
  }), []);

  // Glide the canvas so a card sits center-stage (a third of the way down, so
  // its team below stays in view). `onlyIfHidden` leaves a card alone when it
  // is already fully visible - a tap on a card in view must not move it.
  // Returns true when a card was found.
  const focusOn = useCallback((key, { onlyIfHidden = false } = {}) => {
    const c = canvasRef.current, k = contentRef.current;
    if (!c || !k || !key) return false;
    const el = k.querySelector(`[data-orgkey="${CSS.escape(String(key))}"]`);
    if (!el) return false;
    const er = el.getBoundingClientRect(), cr = c.getBoundingClientRect();
    const inside = er.left >= cr.left && er.right <= cr.right && er.top >= cr.top && er.bottom <= cr.bottom;
    if (onlyIfHidden && inside) return true;
    setPan((p) => ({
      x: p.x + (cr.width / 2 - (er.left + er.width / 2 - cr.left)),
      y: p.y + (cr.height / 3 - (er.top + er.height / 2 - cr.top)),
    }));
    return true;
  }, []);

  // Zoom about a canvas point so what is under the cursor stays put. Refs
  // mirror the state so wheel and pinch handlers (which fire many times a
  // frame) compute from the latest values without nesting state updates.
  const zoomRef = useRef(1);
  const panRef = useRef(PAN0);
  useEffect(() => { zoomRef.current = zoom; }, [zoom]);
  useEffect(() => { panRef.current = pan; }, [pan]);
  const zoomTo = useCallback((next, cx, cy) => {
    const z = zoomRef.current, nz = clampZoom(next);
    if (nz === z) return;
    const c = canvasRef.current;
    const r = c ? c.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
    const px = cx == null ? r.width / 2 : cx - r.left;
    const py = cy == null ? r.height / 2 : cy - r.top;
    const p = panRef.current, f = nz / z;
    const np = { x: px - (px - p.x) * f, y: py - (py - p.y) * f };
    zoomRef.current = nz; panRef.current = np;
    setZoom(nz); setPan(np);
  }, []);
  const zoomAt = useCallback((factor, cx, cy) => zoomTo(zoomRef.current * factor, cx, cy), [zoomTo]);
  const zoomBy = useCallback((factor) => zoomAt(factor), [zoomAt]);
  const zoomIn = useCallback(() => zoomAt(1.25), [zoomAt]);
  const zoomOut = useCallback(() => zoomAt(1 / 1.25), [zoomAt]);

  useImperativeHandle(ref, () => ({
    centerView, fitToView, focusOn, zoomBy,
    bounds: () => (canvasRef.current ? canvasRef.current.getBoundingClientRect() : null),
  }), [centerView, fitToView, focusOn, zoomBy]);

  // Wheel: ctrl / cmd + wheel (and a trackpad pinch, which browsers deliver
  // as ctrl+wheel) zooms about the cursor. A plain scroll is left to the page:
  // the canvas fills most of the screen, and capturing it would trap the
  // viewer on a page whose lists continue below the chart. A native listener
  // because React's onWheel is passive and cannot preventDefault.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return undefined;
    const onWheel = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
    };
    c.addEventListener('wheel', onWheel, { passive: false });
    return () => c.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  // Drag empty space to pan (mouse, pen or one finger); two fingers on empty
  // space pinch-zoom. A press inside a card belongs to the card.
  const onPointerDown = (ev) => {
    if (ev.target.closest && ev.target.closest('[data-orgkey]')) return;
    if (ev.button != null && ev.button > 0) return;
    const c = canvasRef.current;
    if (!c) return;
    // Each pointer remembers its own grab offset, so when a pinch ends the
    // finger still down keeps panning from where the chart is now, not from
    // where it was before the pinch.
    pointers.current.set(ev.pointerId, { x: ev.clientX, y: ev.clientY, sx: ev.clientX - panRef.current.x, sy: ev.clientY - panRef.current.y });
    try { c.setPointerCapture(ev.pointerId); } catch { /* not pointer-capable (tests) */ }
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: zoomRef.current };
    }
    const move = (m) => {
      const me = pointers.current.get(m.pointerId);
      if (!me) return;
      me.x = m.clientX; me.y = m.clientY;
      if (pointers.current.size >= 2 && pinch.current) {
        const [a, b] = [...pointers.current.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch.current.dist > 0) zoomTo(pinch.current.zoom * (d / pinch.current.dist), (a.x + b.x) / 2, (a.y + b.y) / 2);
        return;
      }
      if (m.pointerId !== ev.pointerId) return;
      setPan({ x: m.clientX - me.sx, y: m.clientY - me.sy });
    };
    const up = (u) => {
      pointers.current.delete(u.pointerId);
      if (pointers.current.size < 2 && pinch.current) {
        pinch.current = null;
        for (const rest of pointers.current.values()) { rest.sx = rest.x - panRef.current.x; rest.sy = rest.y - panRef.current.y; }
      }
      if (u.pointerId !== ev.pointerId) return;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const empty = !roots || roots.length === 0;
  return (
    <div ref={canvasRef} onPointerDown={onPointerDown} role="region" aria-label={ariaLabel} data-orgchart="1"
      style={{
        position: 'relative', height, overflow: 'hidden', borderRadius: 16, border: `1px solid ${borderColor}`,
        cursor: 'grab', touchAction: 'none', background: 'var(--card)',
        backgroundImage: 'radial-gradient(circle, var(--line) 1px, transparent 1px)', backgroundSize: '26px 26px',
        ...style,
      }}>
      {empty ? (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', fontSize: 13, padding: 20, textAlign: 'center' }}>
          {emptyText}
        </div>
      ) : (
        <div ref={contentRef} style={{
          position: 'absolute', left: 0, top: 0, transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: '0 0',
          display: 'flex', alignItems: 'flex-start', gap, padding: 4, width: 'max-content',
        }}>
          {roots.map((r) => <Node key={keyOf(r)} node={r} childrenOf={childrenOf} keyOf={keyOf} renderCard={renderCard} collapsed={collapsed} onToggle={onToggle} />)}
        </div>
      )}

      {children}

      <div style={{ position: 'absolute', right: 12, bottom: 12, display: 'flex', gap: 6, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 12, padding: 5, boxShadow: 'var(--shadow-md)' }}
        onPointerDown={(e) => e.stopPropagation()}>
        <ZoomButton title="Zoom out" onClick={zoomOut}>−</ZoomButton>
        <ZoomButton title="Fit to view" onClick={fitToView} emphasis>{`${Math.round(zoom * 100)}%`}</ZoomButton>
        <ZoomButton title="Zoom in" onClick={zoomIn}>+</ZoomButton>
      </div>
      {hint && (
        <span style={{ position: 'absolute', left: 14, bottom: 14, right: 150, fontSize: 10.5, color: 'var(--muted)', pointerEvents: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {hint}
        </span>
      )}
    </div>
  );
});

export default OrgChartCanvas;

function ZoomButton({ title, onClick, emphasis = false, children }) {
  return (
    <button type="button" onClick={onClick} title={title} aria-label={title}
      style={{ minWidth: 34, height: 30, borderRadius: 8, border: 'none', background: emphasis ? 'var(--mist)' : 'transparent',
        fontSize: emphasis ? 11 : 16, fontWeight: 700, color: 'var(--ink)', cursor: 'pointer', fontFamily: 'Inter,sans-serif' }}>
      {children}
    </button>
  );
}

// Recursive top-down layout with pure-div connectors: parent stub → sibling
// rail (outer halves transparent at the ends) → child stub.
function Node({ node, childrenOf, keyOf, renderCard, collapsed, onToggle }) {
  const key = keyOf(node);
  const kids = childrenOf(node) || [];
  const isCollapsed = collapsed.has(key);
  const open = kids.length > 0 && !isCollapsed;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <div data-orgkey={key}>
        {renderCard(node, { key, kids: kids.length, collapsed: isCollapsed, toggle: () => onToggle && onToggle(key) })}
      </div>
      {open && (
        <>
          <div style={{ width: 2, height: 18, background: 'var(--line)' }} />
          <div style={{ display: 'flex', alignItems: 'flex-start' }}>
            {kids.map((k, i) => (
              <div key={keyOf(k)} style={{ position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '0 12px' }}>
                {kids.length > 1 && (
                  <div style={{ position: 'absolute', top: 0, left: 0, right: 0, display: 'flex', height: 2 }}>
                    <div style={{ flex: 1, background: i === 0 ? 'transparent' : 'var(--line)' }} />
                    <div style={{ flex: 1, background: i === kids.length - 1 ? 'transparent' : 'var(--line)' }} />
                  </div>
                )}
                <div style={{ width: 2, height: 18, background: 'var(--line)' }} />
                <Node node={k} childrenOf={childrenOf} keyOf={keyOf} renderCard={renderCard} collapsed={collapsed} onToggle={onToggle} />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// The count pill that hangs off a card's bottom edge and doubles as the
// collapse toggle. Shared so both charts fold the same way.
export function ReportsPill({ count, collapsed, onToggle, label }) {
  if (!count) return null;
  return (
    <button type="button" onClick={(ev) => { ev.stopPropagation(); onToggle(); }}
      onPointerDown={(ev) => ev.stopPropagation()}
      title={collapsed ? 'Show team' : 'Hide team'} aria-label={label || (collapsed ? `Show ${count} reports` : `Hide ${count} reports`)}
      aria-expanded={!collapsed}
      style={{ position: 'absolute', bottom: 0, left: '50%', transform: 'translateX(-50%)',
        display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 11px', borderRadius: 20,
        border: '1.5px solid var(--line)', background: collapsed ? 'var(--mist)' : 'var(--card)',
        fontSize: 10.5, fontWeight: 800, color: 'hsl(var(--color-blue))', cursor: 'pointer',
        fontFamily: 'Inter,sans-serif', boxShadow: 'var(--shadow-sm)', whiteSpace: 'nowrap' }}>
      {count}
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
        style={{ transform: collapsed ? 'rotate(90deg)' : 'rotate(-90deg)', transition: 'transform 0.12s' }}><path d="m9 18 6-6-6-6" /></svg>
    </button>
  );
}

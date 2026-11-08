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
//
// Layout (Neil, 11/07/2026 pass): only MANAGERS fan out sideways, and only
// down to `fanDepth` levels. A manager's people with no reports of their own
// stack in one column under them, hung off a stem like a printed org chart;
// below `fanDepth` even managers stack, their teams indented under them -
// so a 50-person company is two screens wide, not seven. `lineColorOf(node)`
// colors the connectors below a node (the division's color under its lead).
// The canvas is as tall as its content, between `minHeight` and the window.
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { ChevronsDownUp, ChevronsUpDown, LocateFixed, Maximize2, Minus, Plus } from 'lucide-react';
import { clampZoom } from './tree';

const PAN0 = { x: 40, y: 24 };
const STEM = 10;          // where a stacked column's rail sits, from its left edge
const ZOOM_MIN_FIT = 0.5; // Fit never goes below this - a 6px name is no chart

const OrgChartCanvas = forwardRef(function OrgChartCanvas({
  roots, childrenOf, keyOf, renderCard, collapsed, onToggle,
  height, minHeight = 360, borderColor = 'var(--line)', emptyText = 'No one to show.',
  hint = '', gap = 48, cardWidth = 228, lineColorOf = null, fanDepth = 2, style, children, ariaLabel = 'Org chart',
  onExpandAll = null, onCollapseAll = null, onFindMe = null,
}, ref) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState(PAN0);
  const [content, setContent] = useState({ w: 0, h: 0 });
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

  // Fit the whole chart, never below ZOOM_MIN_FIT. With `min`, only when the
  // fit reads at that size or larger - returns whether it fitted. Synchronous
  // so a caller can fall back in the same tick.
  const fitToView = useCallback(({ min = 0 } = {}) => {
    const c = canvasRef.current, k = contentRef.current;
    if (!c || !k) return false;
    const kw = k.scrollWidth, kh = k.scrollHeight;
    if (!kw || !kh) return false;
    const maxH = Math.max(minHeight, window.innerHeight - 240) - 48;
    const raw = Math.min(1, (c.clientWidth - 48) / kw, maxH / kh);
    if (raw < min) return false;
    const s = Math.max(ZOOM_MIN_FIT, raw);
    setZoom(s);
    setPan({ x: Math.max(24, (c.clientWidth - kw * s) / 2), y: 24 });
    return true;
  }, [minHeight]);

  // Glide the canvas so a card sits center-stage (a third of the way down, so
  // its team below stays in view). `onlyIfHidden` leaves a card alone when it
  // is already fully visible - a tap on a card in view must not move it.
  // `align: 'top'` puts it at the top center instead. Returns true when a
  // card was found.
  const focusOn = useCallback((key, { onlyIfHidden = false, align = 'center' } = {}) => {
    const c = canvasRef.current, k = contentRef.current;
    if (!c || !k || !key) return false;
    const el = k.querySelector(`[data-orgkey="${CSS.escape(String(key))}"]`);
    if (!el) return false;
    const er = el.getBoundingClientRect(), cr = c.getBoundingClientRect();
    const inside = er.left >= cr.left && er.right <= cr.right && er.top >= cr.top && er.bottom <= cr.bottom;
    if (onlyIfHidden && inside) return true;
    setPan((p) => ({
      x: p.x + (cr.width / 2 - (er.left + er.width / 2 - cr.left)),
      y: align === 'top' ? p.y + (PAN0.y - (er.top - cr.top)) : p.y + (cr.height / 3 - (er.top + er.height / 2 - cr.top)),
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
    centerView, fitToView, focusOn, zoomBy, zoomTo,
    bounds: () => (canvasRef.current ? canvasRef.current.getBoundingClientRect() : null),
  }), [centerView, fitToView, focusOn, zoomBy, zoomTo]);

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

  // The content's untransformed size, for the canvas's own height.
  const empty = !roots || roots.length === 0;
  useEffect(() => {
    const k = contentRef.current;
    if (!k || empty || typeof ResizeObserver === 'undefined') return undefined;
    const read = () => setContent((c) => (c.w === k.scrollWidth && c.h === k.scrollHeight ? c : { w: k.scrollWidth, h: k.scrollHeight }));
    read();
    const ro = new ResizeObserver(read);
    ro.observe(k);
    return () => ro.disconnect();
  }, [empty]);

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

  // As tall as the content at this zoom, never shorter than `minHeight` and
  // never past the window; a fixed `height` prop overrides.
  const maxH = typeof window === 'undefined' ? 900 : Math.max(minHeight, window.innerHeight - 240);
  const autoH = content.h ? Math.min(maxH, Math.max(minHeight, content.h * zoom + 56)) : minHeight;
  const toolBtn = (title, onClick, icon, emphasis = false) => (
    <button type="button" onClick={onClick} title={title} aria-label={title}
      style={{ minWidth: 30, height: 30, padding: emphasis ? '0 8px' : 0, borderRadius: 8, border: 'none',
        background: emphasis ? 'var(--mist)' : 'transparent', color: 'var(--ink)', cursor: 'pointer', fontFamily: 'inherit',
        fontSize: 11.5, fontWeight: 600, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontVariantNumeric: 'tabular-nums' }}>
      {icon}
    </button>
  );
  const divider = <span aria-hidden="true" style={{ width: 1, background: 'var(--line)', margin: '5px 2px' }} />;

  return (
    <div ref={canvasRef} onPointerDown={onPointerDown} role="region" aria-label={ariaLabel} data-orgchart="1"
      style={{
        position: 'relative', height: height || autoH, overflow: 'hidden', borderRadius: 8, border: `1px solid ${borderColor}`,
        cursor: 'grab', touchAction: 'none', background: 'var(--mist)', transition: 'height .18s ease-out',
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
          {roots.map((r) => <Node key={keyOf(r)} node={r} childrenOf={childrenOf} keyOf={keyOf} renderCard={renderCard} collapsed={collapsed} onToggle={onToggle} lineColorOf={lineColorOf} cardWidth={cardWidth} fanDepth={fanDepth} depth={0} />)}
        </div>
      )}

      {children}

      <div role="toolbar" aria-label="Chart view" onPointerDown={(e) => e.stopPropagation()}
        style={{ position: 'absolute', right: 10, bottom: 10, display: 'flex', gap: 2, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, padding: 4, boxShadow: 'var(--shadow-sm)' }}>
        {onExpandAll && toolBtn('Expand all teams', onExpandAll, <ChevronsUpDown size={15} />)}
        {onCollapseAll && toolBtn('Collapse all teams', onCollapseAll, <ChevronsDownUp size={15} />)}
        {(onExpandAll || onCollapseAll) && divider}
        {toolBtn('Zoom out', zoomOut, <Minus size={15} />)}
        {toolBtn('Back to 100%', () => zoomTo(1), `${Math.round(zoom * 100)}%`, true)}
        {toolBtn('Zoom in', zoomIn, <Plus size={15} />)}
        {divider}
        {toolBtn('Fit the whole chart', () => fitToView(), <Maximize2 size={14} />)}
        {onFindMe && toolBtn('Find me on the chart', onFindMe, <LocateFixed size={15} />)}
      </div>
      {hint && (
        <span style={{ position: 'absolute', left: 14, bottom: 14, right: 150, fontSize: 11.5, color: 'var(--muted)', pointerEvents: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {hint}
        </span>
      )}
    </div>
  );
});

export default OrgChartCanvas;

// Recursive top-down layout with pure-div connectors: parent stem, sibling
// rail (outer halves transparent at the ends), child stem. Children with
// reports of their own fan out as siblings; the rest stack in one column
// hung off a stem (the last sibling, or alone under the card).
function Node({ node, childrenOf, keyOf, renderCard, collapsed, onToggle, lineColorOf, cardWidth, fanDepth, depth }) {
  const key = keyOf(node);
  const kids = childrenOf(node) || [];
  const isCollapsed = collapsed.has(key);
  const open = kids.length > 0 && !isCollapsed;
  const color = (lineColorOf && lineColorOf(node)) || 'var(--line)';
  const fans = depth < fanDepth;
  const fan = open && fans ? kids.filter((k) => (childrenOf(k) || []).length > 0) : [];
  const stack = open ? kids.filter((k) => !fans || !(childrenOf(k) || []).length) : [];
  const sub = { childrenOf, keyOf, renderCard, collapsed, onToggle, lineColorOf, cardWidth, fanDepth };
  const groups = stack.length ? [...fan, stack] : fan;
  const alone = groups.length === 1 && stack.length > 0;   // only a column: an elbow joins the stem to its rail
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <div data-orgkey={key}>
        {renderCard(node, { key, kids: kids.length, collapsed: isCollapsed, toggle: () => onToggle && onToggle(key) })}
      </div>
      {open && (
        <>
          <div style={{ width: 2, height: 18, background: color }} />
          <div style={{ display: 'flex', alignItems: 'flex-start' }}>
            {groups.map((g, i) => {
              const column = Array.isArray(g);
              const first = i === 0, last = i === groups.length - 1;
              const gk = column ? `${key}:stack` : keyOf(g);
              return (
                <div key={gk} style={{ position: 'relative', display: 'flex', flexDirection: 'column', alignItems: column ? 'flex-start' : 'center', padding: column ? 0 : '0 12px' }}>
                  {groups.length > 1 && (
                    column ? (
                      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2 }}>
                        <div style={{ position: 'absolute', left: 0, width: STEM, height: 2, background: first ? 'transparent' : color }} />
                        <div style={{ position: 'absolute', left: STEM, right: 0, height: 2, background: last ? 'transparent' : color }} />
                      </div>
                    ) : (
                      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, display: 'flex', height: 2 }}>
                        <div style={{ flex: 1, background: first ? 'transparent' : color }} />
                        <div style={{ flex: 1, background: last ? 'transparent' : color }} />
                      </div>
                    )
                  )}
                  {column ? (
                    <Column people={g} color={color} stem={groups.length > 1 || alone} elbow={alone} {...sub} />
                  ) : (
                    <>
                      <div style={{ width: 2, height: 18, background: color }} />
                      <Node node={g} depth={depth + 1} {...sub} />
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// People one under another, each hung off the rail by a short stem. The
// rail runs from the top to the last person's middle. Below `fanDepth` a
// manager in the column keeps their team as another column, indented under
// them (their own pill still folds it).
function Column({ people, color, stem, elbow = false, childrenOf, keyOf, renderCard, collapsed, onToggle, lineColorOf, cardWidth, fanDepth }) {
  const width = STEM + 14 + cardWidth;
  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', paddingTop: stem ? 10 : 0 }}>
      {/* The parent's stem lands at the column's center; the elbow carries it to the rail. */}
      {elbow && <div aria-hidden="true" style={{ position: 'absolute', top: 0, left: STEM - 1, width: width / 2 - STEM + 2, height: 2, background: color }} />}
      {people.map((p, i) => {
        const last = i === people.length - 1;
        const key = keyOf(p);
        const kids = childrenOf(p) || [];
        const open = kids.length > 0 && !collapsed.has(key);
        const own = (lineColorOf && lineColorOf(p)) || color;
        // The rail above the first row reaches up to the stem; between rows
        // it is the 8px gap. Two pieces: top to the card's middle (every
        // row) and the whole row (every row but the last), so a nested team
        // below a card stays inside the rail.
        const above = i === 0 ? (stem ? 10 : 0) : 8;
        return (
          <div key={key} style={{ position: 'relative', paddingLeft: STEM + 14, paddingTop: i === 0 ? 0 : 8 }}>
            {!last && <div aria-hidden="true" style={{ position: 'absolute', left: STEM - 1, top: 0, bottom: 0, width: 2, background: color }} />}
            <div style={{ position: 'relative' }}>
              <div aria-hidden="true" style={{ position: 'absolute', left: -15, top: -above, width: 2, height: `calc(50% + ${above}px)`, background: color }} />
              <div aria-hidden="true" style={{ position: 'absolute', left: -15, top: '50%', width: 14, height: 2, background: color }} />
              <div data-orgkey={key}>
                {renderCard(p, { key, kids: kids.length, collapsed: collapsed.has(key), toggle: () => onToggle && onToggle(key) })}
              </div>
            </div>
            {open && (
              <Column people={kids} color={own} stem={false} childrenOf={childrenOf} keyOf={keyOf} renderCard={renderCard}
                collapsed={collapsed} onToggle={onToggle} lineColorOf={lineColorOf} cardWidth={cardWidth} fanDepth={fanDepth} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// The count that hangs off a card's bottom edge and doubles as the collapse
// toggle. Shared so both charts fold the same way. Ink on white, like every
// other count in Nexus - not a colored badge.
export function ReportsPill({ count, collapsed, onToggle, label, title }) {
  if (!count) return null;
  return (
    <button type="button" onClick={(ev) => { ev.stopPropagation(); onToggle(); }}
      onPointerDown={(ev) => ev.stopPropagation()}
      title={title || (collapsed ? 'Show team' : 'Hide team')} aria-label={label || (collapsed ? `Show ${count} reports` : `Hide ${count} reports`)}
      aria-expanded={!collapsed}
      style={{ position: 'absolute', bottom: 0, left: '50%', transform: 'translateX(-50%)',
        display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 9px', borderRadius: 20,
        border: '1px solid var(--line)', background: collapsed ? 'var(--mist)' : 'var(--card)',
        fontSize: 11, fontWeight: 600, color: 'var(--ink)', cursor: 'pointer', fontVariantNumeric: 'tabular-nums',
        fontFamily: 'inherit', boxShadow: 'var(--shadow-sm)', whiteSpace: 'nowrap' }}>
      {count}
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
        style={{ transform: collapsed ? 'rotate(90deg)' : 'rotate(-90deg)', transition: 'transform 0.12s' }}><path d="m9 18 6-6-6-6" /></svg>
    </button>
  );
}

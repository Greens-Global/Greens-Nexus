import { useRef, useState, useEffect } from 'react';
import { GripVertical, X, Settings2, ArrowUp, ArrowDown } from 'lucide-react';

// A dependency-free drag + resize widget grid. 12 columns; each widget carries
// { i, x, y, w, h }. In edit mode you drag by the header grip and resize from the
// SE corner - both snap to the grid. Below MOBILE_BP (or when the caller says
// `stacked`, e.g. a phone held sideways) the grid stacks to a single column in
// reading order; in edit mode each card there gets up/down arrows instead of
// drag handles (`onMove(i, -1 | 1)`), since dragging on a phone scrolls.

export const COLS = 12;
// px per row unit (gutter included via card inset). 72 puts a 2-row stat tile
// at ~144px - the height of DeskHome's stat cards - so grid tiles carry Home's
// compact proportions instead of ballooning (92 made every card ~28% taller
// than its Home counterpart; Visesh, Aug 12).
const ROW_H = 72;
const GAP = 14;
const MOBILE_BP = 700;
const MIN_W = 2, MIN_H = 2, MAX_H = 8;

// `resolveLayout(nextLayout, draggedId)` is optional: pass it to have the
// board settle collisions live (the other cards move out of the dragged one's
// way while you drag, and the resolved board is what gets saved on drop).
// Callers that don't pass it keep the original behavior exactly.
// `alwaysResizable` puts the SE resize handle on every card in VIEW mode too,
// so a card's height/width can be dragged without first entering Customize
// (moving and removing still need it). Off by default.
export default function DashboardGrid({ layout, editing, onLayoutChange, renderWidget, onRemove, onConfigure, limitsFor, resolveLayout, alwaysResizable, stacked = false, onMove, canConfigure }) {
  const ref = useRef(null);
  const [width, setWidth] = useState(1000);
  const [drag, setDrag] = useState(null);   // live drag/resize session

  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => { const w = e.contentRect.width; if (w > 0) setWidth(Math.floor(w)); });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  const mobile = stacked || width < MOBILE_BP;
  const unitW = width / COLS;

  const dragged = drag && layout.map(it => (drag.i === it.i)
    ? { ...it, x: drag.curX, y: drag.curY, w: drag.curW, h: drag.curH } : it);
  const eff = !dragged ? layout : (resolveLayout ? resolveLayout(dragged, drag.i) : dragged);
  const maxRow = eff.reduce((m, it) => Math.max(m, it.y + it.h), 1);

  function startDrag(e, it, mode) {
    if (mobile) return;
    if (!editing && !(alwaysResizable && mode === 'resize')) return;
    e.preventDefault(); e.stopPropagation();
    const sx = e.clientX, sy = e.clientY;
    const base = { ox: it.x, oy: it.y, ow: it.w, oh: it.h };
    // Per-widget resize bounds (falls back to grid-wide MIN/MAX).
    const lim = limitsFor?.(it) || {};
    const minW = lim.minW ?? MIN_W, minH = lim.minH ?? MIN_H;
    const maxW = Math.min(lim.maxW ?? COLS, COLS - base.ox);
    const maxH = lim.maxH ?? MAX_H;
    setDrag({ i: it.i, curX: it.x, curY: it.y, curW: it.w, curH: it.h });

    const move = (ev) => {
      const dx = Math.round((ev.clientX - sx) / unitW);
      const dy = Math.round((ev.clientY - sy) / ROW_H);
      setDrag(prev => {
        if (!prev) return prev;
        if (mode === 'move') {
          return { ...prev,
            curX: Math.min(Math.max(0, base.ox + dx), COLS - base.ow),
            curY: Math.max(0, base.oy + dy) };
        }
        return { ...prev,
          curW: Math.min(Math.max(minW, base.ow + dx), maxW),
          curH: Math.min(maxH, Math.max(minH, base.oh + dy)) };
      });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDrag(prev => {
        if (prev) {
          const next = layout.map(l => l.i === prev.i
            ? { ...l, x: prev.curX, y: prev.curY, w: prev.curW, h: prev.curH } : l);
          onLayoutChange(resolveLayout ? resolveLayout(next, prev.i) : next);
        }
        return null;
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // ── Mobile: single-column stack, ordered by row then column ──
  if (mobile) {
    const ordered = [...layout].sort((a, b) => (a.y - b.y) || (a.x - b.x));
    return (
      <div ref={ref} className="dash-grid" style={{ display: 'flex', flexDirection: 'column', gap: GAP }}>
        {ordered.map((it, k) => (
          // Edit mode drops the card 16px so its control bar (which sits
          // across the top edge) never covers the card above it.
          <div key={it.i} style={{ height: it.h * ROW_H, minHeight: 150, marginTop: editing ? 16 : 0 }}>
            <Card it={it} editing={editing} onRemove={onRemove} onConfigure={onConfigure}
              renderWidget={renderWidget} startDrag={() => {}} draggable={false} canConfigure={canConfigure}
              onMove={onMove} first={k === 0} last={k === ordered.length - 1} />
          </div>
        ))}
      </div>
    );
  }

  // ── Desktop: absolute-positioned grid ──
  return (
    <div ref={ref} className="dash-grid" style={{ position: 'relative', width: '100%',
      height: maxRow * ROW_H, minHeight: '68vh',
      transition: drag ? 'none' : 'height 0.15s',
      // Edit mode: a soft dot at every grid intersection reads as "snap points"
      // without the noisy full-height column lines.
      backgroundImage: editing
        ? 'radial-gradient(circle, var(--line) 1.5px, transparent 1.5px)'
        : 'none',
      backgroundSize: `${unitW}px ${ROW_H}px`,
      backgroundPosition: `${unitW / 2}px ${ROW_H / 2}px`,
      borderRadius: 16 }}>
      {/* View mode: a whisper-light line grid so the canvas doesn't feel bare */}
      {!editing && (
        <div aria-hidden style={{ position: 'absolute', inset: 0, borderRadius: 16, pointerEvents: 'none', opacity: 0.45,
          backgroundImage: 'linear-gradient(var(--line) 1px, transparent 1px), linear-gradient(90deg, var(--line) 1px, transparent 1px)',
          backgroundSize: '46px 46px',
          maskImage: 'radial-gradient(ellipse at 50% 30%, black 55%, transparent 100%)',
          WebkitMaskImage: 'radial-gradient(ellipse at 50% 30%, black 55%, transparent 100%)' }} />
      )}
      {eff.map(it => (
        <div key={it.i} style={{
          position: 'absolute', left: it.x * unitW, top: it.y * ROW_H,
          width: it.w * unitW, height: it.h * ROW_H, padding: GAP / 2,
          boxSizing: 'border-box', transition: drag?.i === it.i ? 'none' : 'left 0.15s, top 0.15s, width 0.15s, height 0.15s',
          zIndex: drag?.i === it.i ? 10 : 1 }}>
          <Card it={it} editing={editing} onRemove={onRemove} onConfigure={onConfigure}
            renderWidget={renderWidget} startDrag={startDrag} draggable alwaysResizable={alwaysResizable} canConfigure={canConfigure} />
        </div>
      ))}
    </div>
  );
}

const iconBtn = { background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 3 };
// Phone controls: 36px targets (Apple's minimum is 44pt for a lone button;
// four side by side in one bar at 36 stays comfortably tappable).
const touchBtn = { ...iconBtn, width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 8, padding: 0 };

// The cell is a transparent frame: the widget renders its OWN native card
// (.kpi-card / .dash-card) so it looks identical to the rest of the app. In edit
// mode we overlay a small control cluster + resize handle on top.
function Card({ it, editing, onRemove, onConfigure, renderWidget, startDrag, draggable, alwaysResizable, onMove, first, last, canConfigure }) {
  // A widget with no options gets no gear - it used to show one that did nothing.
  const configurable = onConfigure && (!canConfigure || canConfigure(it));
  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div style={{ width: '100%', height: '100%', pointerEvents: editing ? 'none' : 'auto' }}>
        {renderWidget(it)}
      </div>
      {editing && (
        <div style={{ position: 'absolute', inset: 0, borderRadius: 'var(--wk-r)', pointerEvents: 'none',
          boxShadow: 'inset 0 0 0 1.5px hsla(var(--color-blue),0.35)' }} />
      )}
      {editing && !draggable && (
        // Stacked (phone): reorder with arrows - there is no drag here.
        <div role="toolbar" aria-label="Widget controls" style={{ position: 'absolute', top: -20, left: '50%', transform: 'translateX(-50%)', display: 'flex', gap: 2,
          background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 11, padding: 2, boxShadow: 'var(--shadow-md)', zIndex: 5 }}>
          {onMove && <button onClick={() => onMove(it.i, -1)} disabled={first} title="Move Up" aria-label="Move Up" style={{ ...touchBtn, opacity: first ? 0.3 : 1, cursor: first ? 'default' : 'pointer' }}><ArrowUp size={17} /></button>}
          {onMove && <button onClick={() => onMove(it.i, 1)} disabled={last} title="Move Down" aria-label="Move Down" style={{ ...touchBtn, opacity: last ? 0.3 : 1, cursor: last ? 'default' : 'pointer' }}><ArrowDown size={17} /></button>}
          {configurable && <button onClick={() => onConfigure(it)} title="Configure" aria-label="Configure" style={touchBtn}><Settings2 size={17} /></button>}
          <button onClick={() => onRemove(it.i)} title="Remove" aria-label="Remove" style={{ ...touchBtn, color: 'hsl(var(--color-red))' }}><X size={18} /></button>
        </div>
      )}
      {editing && draggable && (
        <div style={{ position: 'absolute', top: -12, left: '50%', transform: 'translateX(-50%)', display: 'flex', gap: 1,
          background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 9, padding: '2px 4px', boxShadow: 'var(--shadow-md)', zIndex: 5 }}>
          {/* touch-action none: without it a finger drag on a tablet scrolls
              the page and the browser cancels the pointer stream mid-drag. */}
          <span onPointerDown={(e) => startDrag(e, it, 'move')} title="Drag to move"
            style={{ cursor: 'grab', display: 'flex', alignItems: 'center', color: 'var(--muted)', padding: 3, touchAction: 'none' }}>
            <GripVertical size={14} />
          </span>
          {configurable && <button onClick={() => onConfigure(it)} title="Configure" style={iconBtn}><Settings2 size={13} /></button>}
          <button onClick={() => onRemove(it.i)} title="Remove" style={iconBtn}><X size={14} /></button>
        </div>
      )}
      {(editing || alwaysResizable) && draggable && (
        <span onPointerDown={(e) => startDrag(e, it, 'resize')} title="Drag to resize"
          style={{ position: 'absolute', right: 3, bottom: 3, width: 16, height: 16, cursor: 'nwse-resize', touchAction: 'none',
            background: 'linear-gradient(135deg, transparent 50%, var(--muted) 50%, var(--muted) 62%, transparent 62%, transparent 74%, var(--muted) 74%, var(--muted) 86%, transparent 86%)',
            opacity: 0.7 }} />
      )}
    </div>
  );
}

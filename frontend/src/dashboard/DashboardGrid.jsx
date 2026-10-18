import { useRef, useState, useEffect } from 'react';
import { GripVertical, X, Settings2, ArrowUp, ArrowDown, Copy } from 'lucide-react';

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

// The phone stack, as rows (Oct 11). A widget the catalog marks `compact`
// (a stat, a shortcut, an Action Tile - tiles that are an icon and a number
// or a name) shares its row with the next compact one, two across, the way
// Home's stat board and an iOS home screen do; everything else keeps a full
// row of its own. Only tiles of the same height pair (a one-row pill beside
// a two-row stat would leave a dead half-cell under the pill). Reading order
// is unchanged - the pairing is only how the same order is drawn - so the
// up/down arrows still mean what they did.
export function stackRows(ordered, isCompact) {
  const rows = [];
  for (let k = 0; k < ordered.length; k++) {
    const it = ordered[k], nx = ordered[k + 1];
    if (isCompact(it) && nx && isCompact(nx) && (it.h || 2) === (nx.h || 2)) { rows.push([it, nx]); k++; }
    else rows.push([it]);
  }
  return rows;
}

// `resolveLayout(nextLayout, draggedId)` is optional: pass it to have the
// board settle collisions live (the other cards move out of the dragged one's
// way while you drag, and the resolved board is what gets saved on drop).
// Callers that don't pass it keep the original behavior exactly.
// `alwaysResizable` puts the SE resize handle on every card in VIEW mode too,
// so a card's height/width can be dragged without first entering Customize
// (moving and removing still need it). Off by default.
// `renderWidget(it, { phone })` (Oct 13) tells the widget whether the board
// is stacked right now - the grid's own decision, so a widget never has to
// guess it from a media query of its own.
// `rowsFor(it)` (Oct 13) lets a widget take a different height in the phone
// stack than it has on the board - a bare icon dock is one row on a phone
// whatever its board shape; undefined keeps the board height.
// `compactFor(it)` says which widgets pair up on a phone (see stackRows);
// `onDuplicate(i)` adds a Duplicate control beside Configure in edit mode;
// `emptyState` is what an empty board shows instead of a bare canvas.
export default function DashboardGrid({ layout, editing, onLayoutChange, renderWidget, onRemove, onConfigure, onDuplicate, limitsFor, resolveLayout, alwaysResizable, stacked = false, onMove, canConfigure, compactFor, rowsFor, emptyState = null }) {
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

  const isCompact = (it) => !!compactFor?.(it);

  // ── Mobile: single-column stack, ordered by row then column ──
  if (mobile) {
    const ordered = [...layout].sort((a, b) => (a.y - b.y) || (a.x - b.x));
    const rows = stackRows(ordered, isCompact);
    const pos = new Map(ordered.map((it, k) => [it.i, k]));
    const cell = (it) => (
      // Edit mode drops the card 16px so its control bar (which sits
      // across the top edge) never covers the card above it. A compact tile
      // keeps its own height (a one-row pill stays a pill); everything else
      // gets at least 150px so a list never collapses to a sliver.
      <div key={it.i} style={{ height: (rowsFor?.(it) || it.h) * ROW_H, minHeight: isCompact(it) || rowsFor?.(it) ? 0 : 150, marginTop: editing ? 16 : 0, minWidth: 0 }}>
        <Card it={it} editing={editing} onRemove={onRemove} onConfigure={onConfigure} onDuplicate={onDuplicate}
          renderWidget={renderWidget} startDrag={() => {}} draggable={false} canConfigure={canConfigure} stackedNow
          onMove={onMove} first={pos.get(it.i) === 0} last={pos.get(it.i) === ordered.length - 1} />
      </div>
    );
    return (
      <div ref={ref} className="dash-grid" style={{ display: 'flex', flexDirection: 'column', gap: GAP }}>
        {layout.length === 0 && emptyState}
        {rows.map(row => row.length === 1 ? cell(row[0]) : (
          // repeat(2, ...) not '1fr 1fr': style.css's phone guard stacks any
          // inline "1fr 1fr", which undid this pairing and gave every small
          // tile a full-width row (Oct 17 mobile audit).
          <div key={row[0].i} style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: GAP }}>
            {row.map(cell)}
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
      {layout.length === 0 && emptyState && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>{emptyState}</div>
      )}
      {eff.map(it => (
        <div key={it.i} style={{
          position: 'absolute', left: it.x * unitW, top: it.y * ROW_H,
          width: it.w * unitW, height: it.h * ROW_H, padding: GAP / 2,
          boxSizing: 'border-box', transition: drag?.i === it.i ? 'none' : 'left 0.15s, top 0.15s, width 0.15s, height 0.15s',
          zIndex: drag?.i === it.i ? 10 : 1 }}>
          <Card it={it} editing={editing} onRemove={onRemove} onConfigure={onConfigure} onDuplicate={onDuplicate}
            renderWidget={renderWidget} startDrag={startDrag} draggable alwaysResizable={alwaysResizable} canConfigure={canConfigure} />
        </div>
      ))}
    </div>
  );
}

const iconBtn = { background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 3 };
// Phone controls: 36px targets (Apple's minimum is 44pt for a lone button;
// four side by side in one bar at 36 stays comfortably tappable). Five
// (Duplicate joins for a configurable tile) go to 32px so the bar still fits
// a half-width paired cell on a 390px phone.
const touchBtn = { ...iconBtn, width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 8, padding: 0 };
const touchBtn5 = { ...touchBtn, width: 32, height: 32 };
// A touch tablet wide enough for the desktop grid (an iPad) gets the drag
// grip, gear and resize handle at finger size (Oct 14) - 19px icons and a
// 16px corner were mouse-sized.
const coarsePointer = () => typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;
const padBtn = { ...iconBtn, width: 32, height: 32, alignItems: 'center', justifyContent: 'center', borderRadius: 7, padding: 0 };

// The cell is a transparent frame: the widget renders its OWN native card
// (.kpi-card / .dash-card) so it looks identical to the rest of the app. In edit
// mode we overlay a small control cluster + resize handle on top.
function Card({ it, editing, onRemove, onConfigure, onDuplicate, renderWidget, startDrag, draggable, alwaysResizable, onMove, first, last, canConfigure, stackedNow }) {
  // A widget with no options gets no gear - it used to show one that did nothing.
  const configurable = onConfigure && (!canConfigure || canConfigure(it));
  const [coarse] = useState(coarsePointer);
  const deskBtn = coarse ? padBtn : iconBtn;
  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', minWidth: 0 }}>
      <div style={{ width: '100%', height: '100%', pointerEvents: editing ? 'none' : 'auto' }}>
        {renderWidget(it, { phone: !!stackedNow })}
      </div>
      {editing && (
        <div style={{ position: 'absolute', inset: 0, borderRadius: 'var(--wk-r)', pointerEvents: 'none',
          boxShadow: 'inset 0 0 0 1.5px hsla(var(--color-blue),0.35)' }} />
      )}
      {editing && !draggable && (() => {
        // Stacked (phone): reorder with arrows - there is no drag here.
        const tb = (onMove ? 2 : 0) + (configurable ? 1 : 0) + (onDuplicate ? 1 : 0) + 1 >= 5 ? touchBtn5 : touchBtn;
        return (
        <div role="toolbar" aria-label="Widget controls" style={{ position: 'absolute', top: -20, left: '50%', transform: 'translateX(-50%)', display: 'flex', gap: 2,
          background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 11, padding: 2, boxShadow: 'var(--shadow-md)', zIndex: 5 }}>
          {onMove && <button onClick={() => onMove(it.i, -1)} disabled={first} title="Move Up" aria-label="Move Up" style={{ ...tb, opacity: first ? 0.3 : 1, cursor: first ? 'default' : 'pointer' }}><ArrowUp size={17} /></button>}
          {onMove && <button onClick={() => onMove(it.i, 1)} disabled={last} title="Move Down" aria-label="Move Down" style={{ ...tb, opacity: last ? 0.3 : 1, cursor: last ? 'default' : 'pointer' }}><ArrowDown size={17} /></button>}
          {configurable && <button onClick={() => onConfigure(it)} title="Configure" aria-label="Configure" style={tb}><Settings2 size={17} /></button>}
          {onDuplicate && <button onClick={() => onDuplicate(it.i)} title="Duplicate" aria-label="Duplicate" style={tb}><Copy size={16} /></button>}
          <button onClick={() => onRemove(it.i)} title="Remove" aria-label="Remove" style={{ ...tb, color: 'hsl(var(--color-red))' }}><X size={18} /></button>
        </div>
        );
      })()}
      {editing && draggable && (
        <div style={{ position: 'absolute', top: coarse ? -18 : -12, left: '50%', transform: 'translateX(-50%)', display: 'flex', gap: 1,
          background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 9, padding: '2px 4px', boxShadow: 'var(--shadow-md)', zIndex: 5 }}>
          {/* touch-action none: without it a finger drag on a tablet scrolls
              the page and the browser cancels the pointer stream mid-drag. */}
          <span onPointerDown={(e) => startDrag(e, it, 'move')} title="Drag to move"
            style={{ cursor: 'grab', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', padding: 3, touchAction: 'none', ...(coarse ? { width: 32, height: 32, padding: 0 } : null) }}>
            <GripVertical size={coarse ? 16 : 14} />
          </span>
          {configurable && <button onClick={() => onConfigure(it)} title="Configure" aria-label="Configure" style={deskBtn}><Settings2 size={coarse ? 15 : 13} /></button>}
          {/* Duplicate (Oct 11): a second copy, same setup, placed in the
              nearest free spot - the quick way to build a row of Action Tiles. */}
          {onDuplicate && <button onClick={() => onDuplicate(it.i)} title="Duplicate" aria-label="Duplicate" style={deskBtn}><Copy size={coarse ? 15 : 13} /></button>}
          <button onClick={() => onRemove(it.i)} title="Remove" aria-label="Remove" style={deskBtn}><X size={coarse ? 16 : 14} /></button>
        </div>
      )}
      {(editing || alwaysResizable) && draggable && (
        <span onPointerDown={(e) => startDrag(e, it, 'resize')} title="Drag to resize"
          style={{ position: 'absolute', right: 3, bottom: 3, width: coarse ? 26 : 16, height: coarse ? 26 : 16, cursor: 'nwse-resize', touchAction: 'none',
            background: 'linear-gradient(135deg, transparent 50%, var(--muted) 50%, var(--muted) 62%, transparent 62%, transparent 74%, var(--muted) 74%, var(--muted) 86%, transparent 86%)',
            opacity: 0.7 }} />
      )}
    </div>
  );
}

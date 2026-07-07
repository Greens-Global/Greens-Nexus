import { useRef, useState, useEffect } from 'react';
import { GripVertical, X, Settings2 } from 'lucide-react';

// A dependency-free drag + resize widget grid. 12 columns; each widget carries
// { i, x, y, w, h }. In edit mode you drag by the header grip and resize from the
// SE corner — both snap to the grid. Below MOBILE_BP the grid stacks to a single
// column (read-only order), so it's usable on phones.

export const COLS = 12;
const ROW_H = 92;      // px per row unit (gutter included via card inset)
const GAP = 14;
const MOBILE_BP = 700;
const MIN_W = 2, MIN_H = 2, MAX_H = 8;

export default function DashboardGrid({ layout, editing, onLayoutChange, renderWidget, onRemove, onConfigure }) {
  const ref = useRef(null);
  const [width, setWidth] = useState(1000);
  const [drag, setDrag] = useState(null);   // live drag/resize session

  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => { const w = e.contentRect.width; if (w > 0) setWidth(Math.floor(w)); });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  const mobile = width < MOBILE_BP;
  const unitW = width / COLS;

  const eff = layout.map(it => (drag && drag.i === it.i)
    ? { ...it, x: drag.curX, y: drag.curY, w: drag.curW, h: drag.curH } : it);
  const maxRow = eff.reduce((m, it) => Math.max(m, it.y + it.h), 1);

  function startDrag(e, it, mode) {
    if (!editing || mobile) return;
    e.preventDefault(); e.stopPropagation();
    const sx = e.clientX, sy = e.clientY;
    const base = { ox: it.x, oy: it.y, ow: it.w, oh: it.h };
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
          curW: Math.min(Math.max(MIN_W, base.ow + dx), COLS - base.ox),
          curH: Math.min(MAX_H, Math.max(MIN_H, base.oh + dy)) };
      });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDrag(prev => {
        if (prev) onLayoutChange(layout.map(l => l.i === prev.i
          ? { ...l, x: prev.curX, y: prev.curY, w: prev.curW, h: prev.curH } : l));
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
      <div ref={ref} style={{ display: 'flex', flexDirection: 'column', gap: GAP }}>
        {ordered.map(it => (
          <div key={it.i} style={{ height: it.h * ROW_H, minHeight: 150 }}>
            <Card it={it} editing={editing} onRemove={onRemove} onConfigure={onConfigure}
              renderWidget={renderWidget} startDrag={() => {}} draggable={false} />
          </div>
        ))}
      </div>
    );
  }

  // ── Desktop: absolute-positioned grid ──
  return (
    <div ref={ref} style={{ position: 'relative', width: '100%', height: maxRow * ROW_H,
      transition: drag ? 'none' : 'height 0.15s',
      backgroundImage: editing
        ? `repeating-linear-gradient(to right, transparent 0 calc(${100 / COLS}% - 1px), var(--line) calc(${100 / COLS}% - 1px) ${100 / COLS}%)`
        : 'none',
      backgroundSize: `100% ${ROW_H}px` }}>
      {eff.map(it => (
        <div key={it.i} style={{
          position: 'absolute', left: it.x * unitW, top: it.y * ROW_H,
          width: it.w * unitW, height: it.h * ROW_H, padding: GAP / 2,
          boxSizing: 'border-box', transition: drag?.i === it.i ? 'none' : 'left 0.15s, top 0.15s, width 0.15s, height 0.15s',
          zIndex: drag?.i === it.i ? 10 : 1 }}>
          <Card it={it} editing={editing} onRemove={onRemove} onConfigure={onConfigure}
            renderWidget={renderWidget} startDrag={startDrag} draggable />
        </div>
      ))}
    </div>
  );
}

const iconBtn = { background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 3 };

// The cell is a transparent frame: the widget renders its OWN native card
// (.kpi-card / .dash-card) so it looks identical to the rest of the app. In edit
// mode we overlay a small control cluster + resize handle on top.
function Card({ it, editing, onRemove, onConfigure, renderWidget, startDrag, draggable }) {
  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div style={{ width: '100%', height: '100%', pointerEvents: editing ? 'none' : 'auto' }}>
        {renderWidget(it)}
      </div>
      {editing && (
        <div style={{ position: 'absolute', inset: 0, borderRadius: 16, pointerEvents: 'none',
          outline: '2px dashed hsla(var(--color-blue),0.45)', outlineOffset: -2 }} />
      )}
      {editing && (
        <div style={{ position: 'absolute', top: -12, left: '50%', transform: 'translateX(-50%)', display: 'flex', gap: 1,
          background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 9, padding: '2px 4px', boxShadow: 'var(--shadow-md)', zIndex: 5 }}>
          <span onPointerDown={draggable ? (e) => startDrag(e, it, 'move') : undefined} title="Drag to move"
            style={{ cursor: draggable ? 'grab' : 'default', display: 'flex', alignItems: 'center', color: 'var(--muted)', padding: 3 }}>
            <GripVertical size={14} />
          </span>
          {onConfigure && <button onClick={() => onConfigure(it)} title="Configure" style={iconBtn}><Settings2 size={13} /></button>}
          <button onClick={() => onRemove(it.i)} title="Remove" style={iconBtn}><X size={14} /></button>
        </div>
      )}
      {editing && draggable && (
        <span onPointerDown={(e) => startDrag(e, it, 'resize')} title="Drag to resize"
          style={{ position: 'absolute', right: 3, bottom: 3, width: 16, height: 16, cursor: 'nwse-resize',
            background: 'linear-gradient(135deg, transparent 50%, var(--muted) 50%, var(--muted) 62%, transparent 62%, transparent 74%, var(--muted) 74%, var(--muted) 86%, transparent 86%)',
            opacity: 0.7 }} />
      )}
    </div>
  );
}

// The full-viewport layer of Build Mode and its tools strip.
//
// While the mode is on the page underneath gets no clicks - that is the
// point - but the wheel and a finger still scroll it (forwarded to whatever
// scroller is under the pointer), so anything can be reached and pinned.
// Hover draws an outline with a small label; click = the element; drag = a
// region; a long press on touch = the element; a markup tool draws on the
// Markup layer. Esc and the strip's Off button are always one tap away.
import { useEffect, useRef, useState, useCallback } from 'react';
import {
  MapPin, Pencil, Square, ArrowUpRight, PenLine, Highlighter, Type, EyeOff, Video, Mic, Undo2,
  ListChecks, X, GripVertical, Eye, CircleStop, Palette,
} from 'lucide-react';
import Markup from './Markup';
import { elementAt, describeTarget, regionTarget, rectOf, textOf } from './lib/capture';
import { TOOLS, MARKUP_TOOLS, COLORS } from './meta';

const DRAG_PX = 6;
const LONG_PRESS_MS = 480;

function scrollTargetAt(x, y) {
  let el = elementAt(x, y);
  while (el && el !== document.body && el !== document.documentElement) {
    const cs = getComputedStyle(el);
    const scrolls = /(auto|scroll)/.test(cs.overflowY + cs.overflowX) && (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1);
    if (scrolls) return el;
    el = el.parentElement;
  }
  return null;
}
function forwardScroll(x, y, dx, dy) {
  const t = scrollTargetAt(x, y);
  if (t) t.scrollBy(dx, dy); else window.scrollBy(dx, dy);
}

const hoverLabel = (el) => {
  const tag = el.tagName.toLowerCase();
  const cls = [...el.classList].filter((c) => !/^(is-|has-)/.test(c)).slice(0, 1).join('');
  const t = textOf(el, 40);
  return `${tag}${cls ? `.${cls}` : ''}${t ? ` · ${t}` : ''}`;
};

export default function Overlay({ tool, color, interactive = true, items = [], onPick, onAdd, faintItems, faintOffset }) {
  const ref = useRef(null);
  const [hover, setHover] = useState(null);         // { rect, label }
  const [region, setRegion] = useState(null);       // drag rectangle
  const [draft, setDraft] = useState(null);         // markup item in progress
  const [textAt, setTextAt] = useState(null);       // { x, y } where a text item is being typed
  const downRef = useRef(null);
  const pressTimer = useRef(null);
  const raf = useRef(0);
  const isMarkup = MARKUP_TOOLS.has(tool);

  const clearPress = () => { clearTimeout(pressTimer.current); pressTimer.current = null; };

  // Hover outline, throttled to a frame.
  const updateHover = useCallback((x, y) => {
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => {
      const el = elementAt(x, y);
      if (!el) { setHover(null); return; }
      const b = el.getBoundingClientRect();
      setHover({ rect: { x: b.left, y: b.top, w: b.width, h: b.height }, label: hoverLabel(el) });
    });
  }, []);

  useEffect(() => () => { cancelAnimationFrame(raf.current); clearPress(); }, []);
  useEffect(() => { if (isMarkup) setHover(null); }, [isMarkup]);

  // Wheel must be a native, non-passive listener: React registers wheel as
  // passive, and a passive listener cannot preventDefault.
  useEffect(() => {
    const el = ref.current;
    if (!el || !interactive) return undefined;
    const onWheel = (e) => { e.preventDefault(); forwardScroll(e.clientX, e.clientY, e.deltaX, e.deltaY); };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [interactive]);

  const pickElement = (x, y) => {
    const el = elementAt(x, y);
    if (!el) return;
    onPick?.(describeTarget(el, 'element'), rectOf(el), 'element', el);
  };

  const onPointerDown = (e) => {
    if (!interactive || e.button > 0) return;
    const { clientX: x, clientY: y } = e;
    try { ref.current?.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    if (isMarkup) {
      if (tool === 'text') { setTextAt({ x, y }); return; }
      if (tool === 'arrow') setDraft({ type: 'arrow', x1: x, y1: y, x2: x, y2: y, color, width: 3 });
      else if (tool === 'path') setDraft({ type: 'path', points: [[x, y]], color, width: 3 });
      else setDraft({ type: tool, x, y, w: 0, h: 0, color: tool === 'highlight' ? '#facc15' : color, width: 3, _x0: x, _y0: y });
      return;
    }
    downRef.current = { x, y, lx: x, ly: y, t: Date.now(), touch: e.pointerType === 'touch', moved: false, consumed: false };
    setHover(null);
    if (e.pointerType === 'touch') {
      clearPress();
      pressTimer.current = setTimeout(() => {
        const d = downRef.current;
        if (!d || d.moved) return;
        d.consumed = true;
        if (navigator.vibrate) { try { navigator.vibrate(12); } catch { /* ignore */ } }
        pickElement(d.x, d.y);
      }, LONG_PRESS_MS);
    }
  };

  // The pointer's position applied to the item being drawn - used by every
  // move AND by the release, so a down + up with no move in between (a very
  // fast flick, some pens and trackpads, automation) still yields the item.
  const applyPoint = (d, x, y) => {
    if (!d) return d;
    if (d.type === 'arrow') return { ...d, x2: x, y2: y };
    if (d.type === 'path') return { ...d, points: [...d.points, [x, y]] };
    return { ...d, x: Math.min(d._x0, x), y: Math.min(d._y0, y), w: Math.abs(x - d._x0), h: Math.abs(y - d._y0) };
  };
  const rectFrom = (d, x, y) => ({ x: Math.min(d.x, x), y: Math.min(d.y, y), w: Math.abs(x - d.x), h: Math.abs(y - d.y) });

  const onPointerMove = (e) => {
    if (!interactive) return;
    const { clientX: x, clientY: y } = e;
    if (draft) {
      setDraft((d) => applyPoint(d, x, y));
      return;
    }
    const d = downRef.current;
    if (d) {
      const dist = Math.hypot(x - d.x, y - d.y);
      if (dist > DRAG_PX) { d.moved = true; clearPress(); }
      if (d.touch) {
        // A finger drag scrolls the page underneath; the long press is what pins.
        if (d.moved) { forwardScroll(x, y, d.lx - x, d.ly - y); d.lx = x; d.ly = y; }
        return;
      }
      if (d.moved) {
        setRegion({ x: Math.min(d.x, x), y: Math.min(d.y, y), w: Math.abs(x - d.x), h: Math.abs(y - d.y) });
        return;
      }
    }
    if (!isMarkup && e.pointerType !== 'touch') updateHover(x, y);
  };

  const onPointerUp = (e) => {
    if (!interactive) return;
    const { clientX: x, clientY: y } = e;
    try { ref.current?.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (draft) {
      const d = applyPoint(draft, x, y);
      setDraft(null);
      const big = d.type === 'arrow' ? Math.hypot(d.x2 - d.x1, d.y2 - d.y1) > 4 : d.type === 'path' ? d.points.length > 1 : (d.w > 3 && d.h > 3);
      if (big) { const { _x0, _y0, ...item } = d; onAdd?.({ ...item, id: `m${Date.now()}` }); }
      return;
    }
    const d = downRef.current;
    downRef.current = null;
    clearPress();
    if (!d) return;
    // A drag is judged by where the pointer came up, not by whether moves
    // were delivered in between.
    const dragged = d.moved || Math.hypot(x - d.x, y - d.y) > DRAG_PX;
    if (dragged && !d.touch) {
      const r = rectFrom(d, x, y);
      setRegion(null);
      if (r.w > 8 && r.h > 8) onPick?.(regionTarget(r), { ...r, pageX: Math.round(r.x + window.scrollX), pageY: Math.round(r.y + window.scrollY) }, 'region', null);
      return;
    }
    setRegion(null);
    if (d.consumed || dragged) return;
    if (d.touch) return;                         // a tap scrolls or does nothing; the long press pins
    pickElement(x, y);
  };

  const onPointerCancel = () => { downRef.current = null; clearPress(); setRegion(null); setDraft(null); };

  const commitText = (value) => {
    const t = (value || '').trim();
    if (t && textAt) onAdd?.({ id: `m${Date.now()}`, type: 'text', x: textAt.x, y: textAt.y, text: t.slice(0, 200), color: color === '#ffffff' ? '#111827' : color, size: 16 });
    setTextAt(null);
  };

  const cursor = tool === 'text' ? 'text' : isMarkup ? 'crosshair' : tool === 'edit' ? 'cell' : 'crosshair';

  return (
    <>
      <div ref={ref} className="bm-overlay" data-testid="bm-overlay" role="presentation"
        style={{ pointerEvents: interactive ? 'auto' : 'none', cursor }}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel}
        onPointerLeave={() => setHover(null)} onContextMenu={(e) => e.preventDefault()} />
      <Markup items={items} draft={draft} faintItems={faintItems} faintOffset={faintOffset} />
      {hover && interactive && !isMarkup && (
        <div className="bm-hover" style={{ left: hover.rect.x, top: hover.rect.y, width: hover.rect.w, height: hover.rect.h }} aria-hidden="true">
          <span className="bm-hover-label" style={{ top: hover.rect.y < 26 ? 'auto' : -24, bottom: hover.rect.y < 26 ? -24 : 'auto' }}>{hover.label}</span>
        </div>
      )}
      {region && <div className="bm-region" style={{ left: region.x, top: region.y, width: region.w, height: region.h }} aria-hidden="true" />}
      {textAt && (
        <input className="bm-text-input" autoFocus aria-label="Markup text" placeholder="Type, then Enter"
          style={{ left: textAt.x, top: textAt.y, color: color === '#ffffff' ? '#111827' : color }}
          onKeyDown={(e) => { if (e.key === 'Enter') commitText(e.currentTarget.value); if (e.key === 'Escape') { e.stopPropagation(); setTextAt(null); } }}
          onBlur={(e) => commitText(e.currentTarget.value)} />
      )}
    </>
  );
}

// ── Tools strip ──────────────────────────────────────────────────────────────
const ICONS = { pin: MapPin, edit: Pencil, rect: Square, arrow: ArrowUpRight, path: PenLine, highlight: Highlighter, text: Type, redact: EyeOff };

function ToolButton({ active, onClick, title, hotkey, children, className = '', ariaLabel, isMobile }) {
  return (
    <button type="button" className={`bm-tool${active ? ' is-active' : ''}${className ? ` ${className}` : ''}`} onClick={onClick}
      title={hotkey ? `${title} (${hotkey})` : title} aria-label={ariaLabel || title} aria-pressed={active ? 'true' : undefined}>
      {children}
      {hotkey && !isMobile && <span className="bm-tool-key" aria-hidden="true">{hotkey}</span>}
    </button>
  );
}

export function ToolStrip({ tool, onTool, color, onColor, canUndo, onUndo, onVideo, recording, onVoice, voiceOn, voiceSupported = true, onQueue, queueCount = 0, onOff, showPins, onTogglePins, isMobile = false }) {
  const [pos, setPos] = useState(null);            // dragged position { x, y } (desktop)
  const dragRef = useRef(null);
  const stripRef = useRef(null);
  const onGripDown = (e) => {
    if (isMobile) return;
    const b = stripRef.current.getBoundingClientRect();
    dragRef.current = { dx: e.clientX - b.left, dy: e.clientY - b.top };
    const move = (ev) => {
      const w = b.width, h = b.height;
      setPos({ x: Math.min(window.innerWidth - w - 4, Math.max(4, ev.clientX - dragRef.current.dx)), y: Math.min(window.innerHeight - h - 4, Math.max(4, ev.clientY - dragRef.current.dy)) });
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); dragRef.current = null; };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const style = pos ? { left: pos.x, top: pos.y, bottom: 'auto', transform: 'none' } : undefined;
  return (
    <div ref={stripRef} className="bm-strip" role="toolbar" aria-label="Build Mode tools" style={style}>
      {!isMobile && <span className="bm-strip-grip" onPointerDown={onGripDown} title="Drag to move" aria-hidden="true"><GripVertical size={14} /></span>}
      {TOOLS.map(({ id, label, key }) => { const Icon = ICONS[id]; return (
        <ToolButton isMobile={isMobile} key={id} active={tool === id} onClick={() => onTool(id)} title={label} hotkey={key}><Icon size={17} /></ToolButton>
      ); })}
      <span className="bm-sep" aria-hidden="true" />
      <ToolButton isMobile={isMobile} active={!!recording} onClick={onVideo} title={recording ? 'Stop Recording' : 'Record Video'} hotkey="V" className={recording ? 'is-rec' : ''}>
        {recording ? <CircleStop size={17} /> : <Video size={17} />}
      </ToolButton>
      {voiceSupported && (
        <ToolButton isMobile={isMobile} active={!!voiceOn} onClick={onVoice} title={voiceOn ? 'Stop Voice Note' : 'Voice Note'} hotkey="M"><Mic size={17} /></ToolButton>
      )}
      <ToolButton isMobile={isMobile} onClick={onUndo} title="Undo" hotkey="Z" className={canUndo ? '' : 'is-dim'}><Undo2 size={17} /></ToolButton>
      <button type="button" className="bm-tool bm-swatch" onClick={onColor} title="Color (C)" aria-label={`Markup color ${color}`}>
        <span className="bm-swatch-dot" style={{ background: color, borderColor: color === '#ffffff' ? 'var(--line)' : color }} />
        <Palette size={11} className="bm-swatch-icon" />
      </button>
      <span className="bm-sep" aria-hidden="true" />
      <ToolButton isMobile={isMobile} active={!showPins} onClick={onTogglePins} title={showPins ? 'Hide Pins' : 'Show Pins'}>{showPins ? <Eye size={17} /> : <EyeOff size={17} />}</ToolButton>
      <ToolButton isMobile={isMobile} onClick={onQueue} title="Queue" hotkey="Q">
        <ListChecks size={17} />
        {queueCount > 0 && <span className="bm-tool-badge">{queueCount}</span>}
      </ToolButton>
      <ToolButton isMobile={isMobile} onClick={onOff} title="Done - Build Mode Off" hotkey="Esc" className="is-off"><X size={17} /></ToolButton>
    </div>
  );
}

export const nextColor = (c) => COLORS[(COLORS.indexOf(c) + 1) % COLORS.length];

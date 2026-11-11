// What Nexus draws OVER a Board's canvas (Neil, 11/10/2026), placed from the
// board's scroll and zoom (viewStore.js) so it rides along with a pan:
//   - vote dots on everything a vote can land on (meet.js),
//   - the person's own Private Writing stickies, kept off the board until the
//     host reveals them (Board's tray),
//   - the sticky composer (type, Tab for the next one beside it),
//   - the measure preview (measure.js) while a length or an area is drawn,
//   - a comment's thread beside its pin (CommentThread.jsx).
// Pure placement: what each does is Board.jsx's.
import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { useView, toStage } from './viewStore';
import { stickyColor, STICKY_SIZE, STICKY_MAX } from './stickies';
import CommentThread from './CommentThread';

function Composer({ view, at, onCommit }) {
  const ref = useRef(null);
  useEffect(() => { ref.current?.focus(); }, [at.key]);
  const p = toStage(view, at.x, at.y);
  const size = STICKY_SIZE * view.zoom;
  const done = (dir) => onCommit(ref.current?.value || '', dir);
  return (
    <textarea key={at.key} ref={ref} className="nx-sticky-compose" defaultValue={at.text || ''} maxLength={STICKY_MAX}
      aria-label="Sticky Note" placeholder="Type, then Tab for the next one"
      style={{ left: p.x, top: p.y, width: size, height: size, fontSize: Math.max(11, 20 * view.zoom), background: stickyColor(at.colorKey).fill }}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Tab') { e.preventDefault(); done(e.shiftKey ? 'down' : 'right'); }
        else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); done('down'); }
        else if (e.key === 'Escape') { e.preventDefault(); done(null); }
      }}
      onBlur={() => done(null)} />
  );
}

export default function BoardOverlay({
  store, stageSize, phone = false,
  votes = null,          // { items: [{ id, x, y, w, h }], mine: Set, onToggle(id) }
  tray = null,           // { items: [{ id, x, y, text, colorKey }], onEdit(item), onRemove(id) }
  composer = null,       // { key, x, y, text, colorKey, onCommit(text, dir) }
  measure = null,        // { points: [[x, y]], hover: [x, y] | null, closed }
  thread = null,         // { box: { x, y, w, h }, ...CommentThread props }
}) {
  const view = useView(store);
  const z = view.zoom;
  let threadStyle;
  if (thread && !phone) {
    const p = toStage(view, thread.box.x + thread.box.w, thread.box.y);
    const W = 320;
    const left = p.x + 12 + W > (stageSize?.w || 1e9) ? Math.max(8, toStage(view, thread.box.x, 0).x - W - 12) : p.x + 12;
    threadStyle = { left, top: Math.max(8, Math.min(p.y, (stageSize?.h || 1e9) - 360)) };
  }
  return (
    <>
      {votes && votes.items.map((it) => {
        const p = toStage(view, it.x + it.w, it.y);
        const on = votes.mine.has(it.id);
        return (
          <button key={it.id} type="button" className={`nx-vote-dot${on ? ' is-on' : ''}`} style={{ left: p.x - 14, top: p.y - 14 }}
            aria-pressed={on} aria-label={on ? 'Take Back Your Vote' : 'Vote for This'} title={on ? 'Take Back Your Vote' : 'Vote for This'}
            onPointerDown={(e) => e.stopPropagation()} onClick={() => votes.onToggle(it.id)} />
        );
      })}
      {tray && tray.items.map((it) => {
        const p = toStage(view, it.x, it.y);
        return (
          <div key={it.id} className="nx-tray-sticky" style={{ left: p.x, top: p.y, width: STICKY_SIZE * z, height: STICKY_SIZE * z, background: stickyColor(it.colorKey).fill, fontSize: Math.max(10, 18 * z) }}
            onPointerDown={(e) => e.stopPropagation()} onDoubleClick={() => tray.onEdit(it)} title="Only you can see this until the stickies are revealed">
            <span className="nx-tray-words">{it.text}</span>
            <span className="nx-tray-tag">Only You</span>
            <button type="button" className="nx-tray-x" onClick={() => tray.onRemove(it.id)} aria-label="Remove This Sticky"><X size={12} /></button>
          </div>
        );
      })}
      {composer && <Composer view={view} at={composer} onCommit={composer.onCommit} />}
      {measure && (measure.points.length > 0) && (
        <svg className="nx-measure-preview" aria-hidden="true">
          <polyline fill={measure.closed ? 'rgba(224,49,49,.12)' : 'none'} stroke="#e03131" strokeWidth="2" strokeDasharray="6 4"
            points={[...measure.points, ...(measure.hover ? [measure.hover] : [])].map(([x, y]) => { const p = toStage(view, x, y); return `${p.x},${p.y}`; }).join(' ')} />
          {measure.points.map(([x, y], i) => { const p = toStage(view, x, y); return <circle key={i} cx={p.x} cy={p.y} r="4" fill="#e03131" />; })}
        </svg>
      )}
      {thread && <CommentThread {...thread} phone={phone} style={threadStyle} />}
    </>
  );
}

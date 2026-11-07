// Drag to reorder, the one list for it (Neil, 11/07/2026 - effects rebuilt
// from interior.dev; grew out of tickets/DragList, Pranshu Sep 30 - its
// callers import this now). The row follows the finger or mouse, the others slide
// aside to show where it lands, and on release everything glides into place
// (lib/motion useFlip). Pointer events, not HTML5 drag and drop, so it works
// on a phone too.
//
// Only the grip starts a drag - rows are full of inputs, and a whole-row drag
// would steal every text selection. The grip is a real button: Arrow Up /
// Down on it moves the row, and the move is announced. Escape cancels a drag.
// Near the top or bottom of the scrolling box a drag scrolls it along.
//
//   <ReorderList items getKey onReorder={(next) => ...} label="department"
//     renderItem={(item, handle, index, { dragging }) => <div>{handle}...</div>} />
import { useEffect, useRef, useState } from 'react';
import { GripVertical } from 'lucide-react';
import { NX } from '../tasks/theme';
import { useFlip } from '../lib/motion';

/** `items` moved from index `from` to sit at `to` (an index in the result). */
export function moved(items, from, to) {
  const next = items.slice();
  const [it] = next.splice(from, 1);
  next.splice(to, 0, it);
  return next;
}

/** Where a row dragged from `from` by `dy` px lands, given each row's
 *  {top, height} in the list. */
export function landingIndex(rects, from, dy) {
  const r = rects[from];
  const mid = r.top + r.height / 2 + dy;
  let at = 0;
  rects.forEach((o, i) => { if (i !== from && o.top + o.height / 2 < mid) at += 1; });
  return at;
}

// The nearest box that scrolls (a sheet's body, else the page).
function scroller(el) {
  for (let n = el?.parentElement; n; n = n.parentElement) {
    const y = getComputedStyle(n).overflowY;
    if ((y === 'auto' || y === 'scroll') && n.scrollHeight > n.clientHeight) return n;
  }
  return document.scrollingElement || document.documentElement;
}
const EDGE = 48;   // px from a scroller's edge where a drag nudges it along

export default function ReorderList({ items, getKey, onReorder, renderItem, gap = 6, label = 'item', disabled = false }) {
  const box = useRef(null);
  const rows = useRef(new Map());
  const live = useRef(null);                // the drag in hand, read by handlers that outlive a render
  const [drag, setDrag] = useState(null);   // { key, from, to, dy, startY, startScroll, rects }
  const [said, setSaid] = useState('');
  useFlip(box);
  const put = (d) => { live.current = d; setDrag(d); };
  // The row being dragged went away (someone else's change): drop the drag.
  const gone = !!drag && !items.some((it) => getKey(it) === drag.key);
  useEffect(() => { if (gone) put(null); }, [gone]);

  const commit = (from, to) => {
    if (to === from || from < 0 || to < 0 || to >= items.length) return;
    onReorder(moved(items, from, to));
    setSaid(`Moved to position ${to + 1} of ${items.length}`);
  };
  const end = (cancel) => {
    const d = live.current;
    if (!d) return;
    put(null);
    // By key, not the index saved at the start: the list may have changed meanwhile.
    const from = items.findIndex((it) => getKey(it) === d.key);
    if (!cancel && from >= 0) commit(from, Math.min(d.to, items.length - 1));
  };
  // Escape cancels a mouse drag too (the grip never took focus), and goes no further.
  useEffect(() => {
    if (!drag) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); end(true); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });
  const begin = (e, key, from) => {
    if (disabled || (e.button !== undefined && e.button !== 0)) return;
    e.preventDefault();
    const rects = items.map((it) => {
      const r = rows.current.get(getKey(it))?.getBoundingClientRect();
      return { top: r?.top || 0, height: r?.height || 0 };
    });
    try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* synthetic events */ }
    const sc = scroller(box.current);
    put({ key, from, to: from, dy: 0, startY: e.clientY, sc, startScroll: sc?.scrollTop || 0, rects });
  };
  const follow = (e) => {
    const d = live.current;
    if (!d) return;
    // Near a scroller's edge, nudge it along. shortcut: moves only while the pointer moves, add a rAF loop if long lists need it.
    if (d.sc) {
      const r = d.sc === document.scrollingElement || d.sc === document.documentElement
        ? { top: 0, bottom: window.innerHeight } : d.sc.getBoundingClientRect();
      if (e.clientY < r.top + EDGE) d.sc.scrollTop -= 12;
      else if (e.clientY > r.bottom - EDGE) d.sc.scrollTop += 12;
    }
    // Pointer travel plus what the list scrolled under it.
    const dy = e.clientY - d.startY + ((d.sc?.scrollTop || 0) - d.startScroll);
    put({ ...d, dy, to: landingIndex(d.rects, d.from, dy) });
  };
  // How far a row that is not being dragged slides to make room.
  const shift = (i) => {
    if (!drag || i === drag.from) return 0;
    const room = drag.rects[drag.from].height + gap;
    if (drag.from < drag.to && i > drag.from && i <= drag.to) return -room;
    if (drag.to < drag.from && i >= drag.to && i < drag.from) return room;
    return 0;
  };

  return (
    <div ref={box} className={`nx-reorder${drag ? ' is-dragging' : ''}`} style={{ display: 'flex', flexDirection: 'column', gap }}>
      {items.map((item, i) => {
        const key = getKey(item);
        const mine = drag?.key === key;
        const handle = disabled ? null : (
          <button type="button" className="nx-reorder-grip" aria-label={`Drag to reorder ${label}`} title="Drag to reorder"
            onPointerDown={(e) => begin(e, key, i)} onPointerMove={follow}
            onPointerUp={() => end(false)} onPointerCancel={() => end(true)} onLostPointerCapture={() => end(false)}
            onKeyDown={(e) => {
              if (drag) return;   // the pointer is moving it
              if (e.key === 'ArrowUp') { e.preventDefault(); commit(i, i - 1); }
              else if (e.key === 'ArrowDown') { e.preventDefault(); commit(i, i + 1); }
            }}
            style={{ border: 'none', background: 'none', padding: 2, color: NX.faint, display: 'grid', placeItems: 'center', flexShrink: 0, borderRadius: 4, touchAction: 'none' }}>
            <GripVertical size={15} />
          </button>
        );
        return (
          <div key={key} data-flip={String(key)} data-testid={`drag-row-${key}`}
            ref={(el) => { if (el) rows.current.set(key, el); else rows.current.delete(key); }}
            className={mine ? 'nx-reorder-row is-lifted' : 'nx-reorder-row'}
            style={{ transform: mine ? `translateY(${drag.dy}px)` : shift(i) ? `translateY(${shift(i)}px)` : undefined }}>
            {renderItem(item, handle, i, { dragging: mine })}
          </div>
        );
      })}
      <span className="nx-sr" aria-live="polite">{said}</span>
    </div>
  );
}

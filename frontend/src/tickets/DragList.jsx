// Drag to reorder (Pranshu, Sep 30: the up/down chevrons on departments and
// ticket types were "very bad" - make it drag and reorder). One small list
// for every reorderable thing in the ticket settings: departments, ticket
// types, intake questions, help topics.
//
// Native HTML5 drag and drop, no library. Only the grip starts a drag - the
// rows are full of inputs and pickers, and a whole-row drag would steal every
// text selection inside them. The grip is also a real button: Arrow Up / Down
// on it moves the row, so reordering does not require a mouse.
import { useState } from 'react';
import { GripVertical } from 'lucide-react';
import { NX } from '../tasks/theme';

/** `items` in their current order; `onReorder(nextItems)` gets the new order.
 * `renderItem(item, handle, index)` renders a row - put `handle` (the grip)
 * wherever it belongs in it. */
export default function DragList({ items, getKey, onReorder, renderItem, gap = 6, label = 'item' }) {
  const [dragKey, setDragKey] = useState(null);
  const [dropAt, setDropAt] = useState(null);   // insertion index 0..items.length
  const [armed, setArmed] = useState(null);     // key whose grip is held down

  const move = (from, to) => {
    // `to` is an insertion index in the ORIGINAL list.
    if (from < 0 || to < 0 || to > items.length) return;
    const next = items.slice();
    const [it] = next.splice(from, 1);
    next.splice(to > from ? to - 1 : to, 0, it);
    if (next.some((x, i) => x !== items[i])) onReorder(next);
  };
  const end = () => { setDragKey(null); setDropAt(null); setArmed(null); };
  const line = <div aria-hidden="true" style={{ height: 2, borderRadius: 2, background: 'var(--wk-brand, #16a34a)', margin: `${-gap / 2 - 1}px 0` }} />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap }}>
      {items.map((item, i) => {
        const key = getKey(item);
        const handle = (
          <button type="button" aria-label={`Drag to reorder ${label}`} title="Drag to reorder"
            onMouseDown={() => setArmed(key)}
            onMouseUp={() => { if (dragKey === null) setArmed(null); }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowUp') { e.preventDefault(); move(i, i - 1); }
              if (e.key === 'ArrowDown') { e.preventDefault(); move(i, i + 2); }
            }}
            style={{ border: 'none', background: 'none', padding: 2, cursor: dragKey ? 'grabbing' : 'grab', color: NX.faint, display: 'grid', placeItems: 'center', flexShrink: 0, borderRadius: 4 }}>
            <GripVertical size={15} />
          </button>
        );
        return (
          <div key={key}>
            {dropAt === i && dragKey !== null && line}
            <div draggable={armed === key}
              data-testid={`drag-row-${key}`}
              onDragStart={(e) => {
                setDragKey(key);
                e.dataTransfer.effectAllowed = 'move';
                try { e.dataTransfer.setData('text/plain', String(key)); } catch { /* old browsers */ }
              }}
              onDragOver={(e) => {
                if (dragKey === null) return;
                e.preventDefault();
                const r = e.currentTarget.getBoundingClientRect();
                setDropAt(e.clientY < r.top + r.height / 2 ? i : i + 1);
              }}
              onDrop={(e) => {
                e.preventDefault();
                const from = items.findIndex((x) => getKey(x) === dragKey);
                if (from >= 0 && dropAt !== null) move(from, dropAt);
                end();
              }}
              onDragEnd={end}
              style={{ opacity: dragKey === key ? 0.45 : 1, transition: 'opacity 0.12s' }}>
              {renderItem(item, handle, i)}
            </div>
            {i === items.length - 1 && dropAt === items.length && dragKey !== null && line}
          </div>
        );
      })}
    </div>
  );
}

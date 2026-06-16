import { useRef, useState } from 'react';

// iOS-mail-style swipe row: drag the content left to reveal action buttons
// under its right edge. Touch-only — mouse users never engage it, so desktop
// keeps the regular inline buttons. Tapping an action closes the row first.
// actions: [{ key, label, Icon, background, onClick }]
export default function SwipeActions({ children, actions = [], disabled = false }) {
  const ACTION_W = 84;
  const max = ACTION_W * actions.length;
  const [offset,   setOffset]   = useState(0);
  const [dragging, setDragging] = useState(false);
  const start = useRef(null);

  if (!actions.length) return children;

  const onTouchStart = e => {
    if (disabled) return;
    start.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, base: offset, locked: null };
  };
  const onTouchMove = e => {
    const s = start.current;
    if (!s) return;
    const dx = e.touches[0].clientX - s.x;
    const dy = e.touches[0].clientY - s.y;
    if (s.locked === null) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      s.locked = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (s.locked === 'x') setDragging(true);
    }
    if (s.locked !== 'x') return;
    setOffset(Math.min(max, Math.max(0, s.base - dx)));
  };
  const onTouchEnd = () => {
    if (!start.current) return;
    start.current = null;
    setDragging(false);
    setOffset(o => (o > max * 0.45 ? max : 0));
  };

  return (
    <div className="swipe-row">
      <div className="swipe-row-actions" aria-hidden={offset === 0}>
        {actions.map(a => (
          <button key={a.key}
            style={{ background: a.background, width: ACTION_W }}
            tabIndex={offset === 0 ? -1 : 0}
            onClick={() => { setOffset(0); a.onClick(); }}>
            {a.Icon && <a.Icon size={17} />}
            <span>{a.label}</span>
          </button>
        ))}
      </div>
      <div className="swipe-row-content"
        style={{ transform: `translateX(${-offset}px)`, transition: dragging ? 'none' : 'transform 0.22s ease' }}
        onTouchStart={onTouchStart} onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd} onTouchCancel={onTouchEnd}>
        {children}
      </div>
    </div>
  );
}

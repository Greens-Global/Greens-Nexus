import { useRef, useState } from 'react';

// Swipe a row sideways to clear it - the phone's own gesture for a
// notification (bell rows and toasts, phone pass 11/15/2026). Touch only: a
// mouse never starts a swipe, so a computer sees an ordinary row. A drag
// that starts mostly vertical is the list scrolling and is left alone
// (touch-action: pan-y keeps the browser scrolling it); a sideways drag past
// `threshold` of the row's width, or a quick flick, slides the row out and
// calls onAway. Anything less springs back. The click a swipe ends on is
// swallowed, so letting go never also opens the row.
//
// `label` is the word revealed behind the row while it moves ("Clear");
// leave it out for something that floats on its own (a toast).
export default function SwipeAway({ enabled = true, onAway, label = '', className = '', style, children, ...rest }) {
  const [dx, setDx] = useState(0);
  const [settling, setSettling] = useState(false);
  const [width, setWidth] = useState(320);
  const elRef = useRef(null);
  const drag = useRef(null);      // { x, y, t, axis }
  const swiped = useRef(false);

  if (!enabled) return <div className={className} style={style} {...rest}>{children}</div>;

  const onTouchStart = (e) => {
    if (e.touches.length !== 1) { drag.current = null; return; }
    const t = e.touches[0];
    drag.current = { x: t.clientX, y: t.clientY, t: Date.now(), axis: null };
    swiped.current = false;
    setWidth(elRef.current?.offsetWidth || 320);
    setSettling(false);
  };
  const onTouchMove = (e) => {
    const d = drag.current;
    if (!d) return;
    const t = e.touches[0];
    const mx = t.clientX - d.x;
    const my = t.clientY - d.y;
    if (!d.axis) {
      if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
      d.axis = Math.abs(mx) > Math.abs(my) * 1.2 ? 'x' : 'y';
    }
    if (d.axis === 'x') setDx(mx);
  };
  const onTouchEnd = () => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.axis !== 'x') return;
    swiped.current = true;
    const fast = Math.abs(dx) > 40 && Math.abs(dx) / Math.max(1, Date.now() - d.t) > 0.6;
    setSettling(true);
    if (Math.abs(dx) > width * 0.35 || fast) {
      setDx(dx < 0 ? -width : width);
      setTimeout(() => onAway?.(), 180);
    } else {
      setDx(0);
    }
  };
  const onClickCapture = (e) => {
    if (!swiped.current) return;
    swiped.current = false;
    e.stopPropagation();
    e.preventDefault();
  };

  const moving = dx !== 0;
  const row = (
    <div ref={elRef} className={className} {...rest}
      onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd} onTouchCancel={onTouchEnd}
      onClickCapture={onClickCapture}
      style={{
        ...style,
        touchAction: 'pan-y',
        transform: moving ? `translateX(${dx}px)` : undefined,
        transition: settling ? 'transform 180ms var(--ease-out, ease-out), opacity 180ms var(--ease-out, ease-out)' : 'none',
        // A toast fades as it goes; a row stays solid over its label.
        opacity: moving && !label ? Math.max(0.35, 1 - Math.abs(dx) / (width * 1.2)) : undefined,
        ...(moving && label ? { background: 'var(--card)' } : null),
      }}>
      {children}
    </div>
  );
  if (!label) return row;
  return (
    <div className="nx-swipe">
      {moving && (
        <div className={`nx-swipe-under${dx < 0 ? ' is-end' : ''}`} aria-hidden="true">{label}</div>
      )}
      {row}
    </div>
  );
}

import { Children, cloneElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// The left sidebar's tooltips (Neil, Oct 14 2026: "large and obvious ... so no
// one gets confused at all"). One line that says what the control does - "Punch
// In", "Start Break", "Tasks" - big enough to read at a glance. A control that
// cannot be pressed right now adds a quieter second line saying why ("Punch in
// first"), and the clock's status ring uses that line for its numbers. Nothing
// else gets one: an action's tooltip is its name.
//
// It replaces the browser's own `title` tooltip (small, slow, unstyled) and the
// CSS-only one the clock had, which the folded sidebar's overflow clipped - so
// on the rail the clock fell back to `title`. This one is drawn in a layer on
// the page, placed beside the control, flipped to the other side when there is
// no room and kept inside the window, so nothing can clip it.
//
// Behavior (WCAG 1.4.13, content on hover or focus):
//   - opens after a short pause on a control, so sweeping the pointer across
//     the sidebar does not flash a row of tips; once one has shown, the next
//     opens at once (scanning down the rail reads like a list)
//   - opens on keyboard focus too (focus-visible only - not on a mouse click)
//   - Escape closes it; so does pressing the control, scrolling, or leaving
//   - never on touch: a tap is the action itself, there is nothing to hover
//
// `tone` adds a thin colored rule down the left edge - green Punch In, amber
// Break, red Punch Out - color as a rule, never a chip.
const OPEN_MS = 300;
const WARM_MS = 700;
const GAP = 10;      // between the control and the tip
const EDGE = 8;      // the closest a tip comes to the window's edge
let lastClosedAt = 0;

export default function NavTip({ label, detail, side = 'right', tone, children }) {
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  const anchor = useRef(null);
  const pop = useRef(null);
  const timer = useRef(0);
  const id = useId();
  const child = Children.only(children);
  const childRef = child.props.ref;

  const setAnchor = useCallback((node) => {
    anchor.current = node;
    if (typeof childRef === 'function') childRef(node);
    else if (childRef) childRef.current = node;
  }, [childRef]);

  const show = useCallback(() => {
    clearTimeout(timer.current);
    const go = () => { openRef.current = true; setOpen(true); };
    if (Date.now() - lastClosedAt < WARM_MS) go();
    else timer.current = setTimeout(go, OPEN_MS);
  }, []);
  const hide = useCallback(() => {
    clearTimeout(timer.current);
    if (openRef.current) lastClosedAt = Date.now();
    openRef.current = false;
    setOpen(false);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);

  // Escape, a scroll or a resize closes it - a tip left floating over a page
  // that moved would point at nothing.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') hide(); };
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, [open, hide]);

  // Placed before the first paint, written straight to the node.
  useLayoutEffect(() => {
    const el = pop.current, at = anchor.current;
    if (!open || !el || !at) return;
    const a = at.getBoundingClientRect();
    const w = el.offsetWidth, h = el.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight;
    let s = side;
    if (s === 'right' && a.right + GAP + w > vw - EDGE) s = 'left';
    else if (s === 'left' && a.left - GAP - w < EDGE) s = 'right';
    else if (s === 'top' && a.top - GAP - h < EDGE) s = 'bottom';
    else if (s === 'bottom' && a.bottom + GAP + h > vh - EDGE) s = 'top';
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
    let left, top;
    if (s === 'right' || s === 'left') {
      left = s === 'right' ? a.right + GAP : a.left - GAP - w;
      top = clamp(a.top + a.height / 2 - h / 2, EDGE, vh - EDGE - h);
      el.style.setProperty('--navtip-arrow', `${a.top + a.height / 2 - top}px`);
    } else {
      left = clamp(a.left + a.width / 2 - w / 2, EDGE, vw - EDGE - w);
      top = s === 'top' ? a.top - GAP - h : a.bottom + GAP;
      el.style.setProperty('--navtip-arrow', `${a.left + a.width / 2 - left}px`);
    }
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
    el.dataset.side = s;
  }, [open, side, label, detail]);

  const chain = (theirs, ours) => (e) => { theirs?.(e); ours(e); };
  const trigger = cloneElement(child, {
    ref: setAnchor,
    onPointerEnter: chain(child.props.onPointerEnter, (e) => { if (e.pointerType !== 'touch') show(); }),
    onPointerLeave: chain(child.props.onPointerLeave, hide),
    onPointerDown: chain(child.props.onPointerDown, hide),
    onFocus: chain(child.props.onFocus, (e) => {
      let keyboard = false;
      try { keyboard = e.currentTarget.matches(':focus-visible'); } catch { /* older engines */ }
      if (keyboard) show();
    }),
    onBlur: chain(child.props.onBlur, hide),
    // The control's own name already says the label; only a reason line adds
    // anything for a screen reader.
    'aria-describedby': open && detail ? id : child.props['aria-describedby'],
  });

  return (
    <>
      {trigger}
      {open && createPortal(
        <div ref={pop} id={id} role="tooltip" className="navtip" data-side={side} data-tone={tone || undefined}>
          <span className="navtip-label">{label}</span>
          {detail && <span className="navtip-detail">{detail}</span>}
        </div>,
        document.body,
      )}
    </>
  );
}

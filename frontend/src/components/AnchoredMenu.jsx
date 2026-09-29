import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { rootZoom } from '../lib/utils';

// A dropdown / popover pinned to the button that opened it (Neil, Sep 28).
//
// Why a portal: a menu rendered inside its trigger's wrapper with
// `position: absolute` + a z-index is at the mercy of every ancestor. On a
// phone the dashboard toolbar becomes a horizontal scroller, and a scroller
// clips on BOTH axes - the "..." menu was cut off at the toolbar's bottom
// edge and read as opening "behind" the card below. A transformed ancestor
// (every .dk-rise card keeps its entrance-animation transform) traps the
// z-index the same way. No z-index can escape either. Rendering into
// document.body with `position: fixed` sidesteps both for good.
//
// Closes on a tap/click outside (pointerdown, so touch works - the old
// `onMouseLeave` close never fires on iOS), on Escape, and when the trigger
// leaves the page. Flips above the trigger when there is more room there,
// stays inside the viewport, and scrolls internally when taller than it.
//
//   const btn = useRef(null);
//   <button ref={btn} onClick={() => setOpen(o => !o)}>...</button>
//   <AnchoredMenu anchorRef={btn} open={open} onClose={() => setOpen(false)} align="end">
//     ...menu rows...
//   </AnchoredMenu>
//
// `style` styles the panel (background, border, padding, widths...); a
// maxHeight/maxWidth there is honored but also capped to the viewport.
// position, top/left and zIndex are owned here.

const GAP = 6;    // trigger -> menu
const EDGE = 8;   // menu -> viewport edge

// Same layer as the Tasks popovers: above modals (.modal-overlay is 500), so a
// menu opened inside a modal still paints over it.
export const MENU_Z = 5000;

// Open menus, innermost last: Escape closes only the top one, and stops
// there so the modal behind it stays open.
const openStack = [];

const cssLen = (v) => (typeof v === 'number' ? `${v}px` : v);

export default function AnchoredMenu({
  anchorRef, open, onClose, children, align = 'start', minWidth, style, className, role = 'menu', ...rest
}) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  // Callers pass `onClose` inline (a new function every render); reading it
  // through a ref keeps `place` stable so positioning doesn't loop.
  const closeRef = useRef(onClose);
  useLayoutEffect(() => { closeRef.current = onClose; });
  const close = useCallback(() => closeRef.current?.(), []);

  const place = useCallback(() => {
    const a = anchorRef?.current;
    const m = ref.current;
    if (!a || !m) return;
    if (!a.isConnected) { close(); return; }
    // Rects are in the OUTER (zoomed) space, CSS lengths in the INNER one -
    // see rootZoom. Work in outer pixels, divide once at the end.
    const z = rootZoom();
    const r = a.getBoundingClientRect();
    const vw = window.visualViewport?.width ?? window.innerWidth;
    const vh = window.visualViewport?.height ?? window.innerHeight;
    const w = Math.min(m.offsetWidth * z, vw - EDGE * 2);
    const h = m.scrollHeight * z;
    const below = vh - r.bottom - GAP - EDGE;
    const above = r.top - GAP - EDGE;
    const up = h > below && above > below;
    const room = Math.max(120, up ? above : below);
    const left = Math.max(EDGE, Math.min(align === 'end' ? r.right - w : r.left, vw - EDGE - w));
    const top = up ? Math.max(EDGE, r.top - GAP - Math.min(h, room)) : r.bottom + GAP;
    setPos({ left: left / z, top: top / z, maxHeight: room / z, maxWidth: (vw - EDGE * 2) / z });
  }, [anchorRef, align, close]);

  // Measure before paint so the menu never flashes at the wrong spot (a
  // reopen starts from the last spot, re-placed before the browser paints).
  useLayoutEffect(() => {
    if (!open) return undefined;
    place();
    // Content that changes size after opening (a filter, a loaded list)
    // re-places it rather than spilling off-screen.
    if (typeof ResizeObserver === 'undefined' || !ref.current) return undefined;
    const ro = new ResizeObserver(() => place());
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, [open, place]);

  // The pointerdown React routed through this menu. React events bubble
  // through portals, so a picker nested inside (PersonSelect's own portaled
  // list) counts as inside even though its DOM lives elsewhere in <body>.
  const insideEvt = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const token = {};
    openStack.push(token);
    // Bubble phase: runs after React has handled the same pointerdown.
    const onDown = (e) => {
      if (insideEvt.current === e || ref.current?.contains(e.target)) return;
      // The trigger toggles itself - closing here too would reopen it.
      if (anchorRef?.current?.contains(e.target)) return;
      close();
    };
    const onKey = (e) => {
      if (e.key !== 'Escape' || openStack[openStack.length - 1] !== token) return;
      e.stopPropagation();
      close();
      anchorRef?.current?.focus?.();
    };
    const vv = window.visualViewport;
    document.addEventListener('pointerdown', onDown);
    // Window capture runs before any modal's Escape handler.
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', place);
    // Capture: a scroll in ANY container (the phone toolbar, a modal body)
    // moves the trigger, so the menu follows it.
    window.addEventListener('scroll', place, true);
    vv?.addEventListener('resize', place);
    vv?.addEventListener('scroll', place);
    return () => {
      openStack.splice(openStack.indexOf(token), 1);
      document.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      vv?.removeEventListener('resize', place);
      vv?.removeEventListener('scroll', place);
    };
  }, [open, close, anchorRef, place]);

  if (!open) return null;
  return createPortal(
    <div
      ref={ref}
      role={role}
      className={className}
      {...rest}
      onPointerDownCapture={(e) => { insideEvt.current = e.nativeEvent; rest.onPointerDownCapture?.(e); }}
      style={{
        boxSizing: 'border-box',
        ...style,
        minWidth: minWidth ?? style?.minWidth,
        position: 'fixed',
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        // Never taller than the room beside the trigger, nor than the caller asked.
        maxHeight: pos && (style?.maxHeight != null ? `min(${cssLen(style.maxHeight)}, ${pos.maxHeight}px)` : pos.maxHeight),
        maxWidth: pos && (style?.maxWidth != null ? `min(${cssLen(style.maxWidth)}, ${pos.maxWidth}px)` : pos.maxWidth),
        overflowY: 'auto',
        zIndex: MENU_Z,
        // First frame is measured, not shown. Opacity rather than
        // visibility: a visibility-hidden subtree can't take focus, which
        // silently broke autoFocus on a menu's search box.
        ...(pos ? null : { opacity: 0, pointerEvents: 'none' }),
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

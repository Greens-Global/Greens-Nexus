import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

// Pointer-driven drag-and-drop for the Links launcher (Sep 22) - the
// iPhone home-screen model, replacing the native HTML5 drag the grid used
// before (which could only reorder at drop time, had no touch support at
// all, and made folders through a menu).
//
// What it does, in the user's terms:
//   - press a tile and it lifts under the pointer as a floating ghost;
//   - the other tiles slide out of the way live as you move;
//   - rest the ghost on another tile's icon for a beat and that tile
//     "opens up" - release to fold the two into a new folder (or, on a
//     folder tile, to drop it in);
//   - inside an open folder, drag a tile out past the folder's edge and the
//     folder closes under you; keep going and place it anywhere on the grid.
//
// How it does it, in engineering terms - the engine owns the whole gesture
// and the grid component only renders what the engine tells it:
//   - ONE engine for every grid on the page (the main grid and an open
//     folder's grid are "scopes"), so a drag can hop from one to another
//     mid-gesture (the eject case) without two drag systems negotiating.
//   - The dragged tile's own element never moves: it goes invisible in
//     place and a fixed-position clone (the ghost) follows the pointer. Its
//     slot becomes the "hole". Reordering never touches the DOM order mid-
//     drag - it changes a live `order` array, and every OTHER tile gets a
//     CSS transform that slides it from its own measured slot to the slot
//     it now occupies. Only at release does the real order commit (React
//     then re-renders in the new DOM order, in the same frame the transforms
//     clear, so nothing visibly jumps). This is why it can't break the way
//     the previous "live shift" attempt did - that one re-ordered the real
//     DOM under a native drag session and the browser lost the drag.
//   - Slot geometry is measured once at lift, relative to the grid's own
//     box, and converted back through the grid's live rect on every move,
//     so page scroll (including the auto-scroll near the viewport edges)
//     never stales it.
//   - Pointer moves don't touch React at all: the ghost is positioned
//     imperatively in a requestAnimationFrame loop with a little easing, so
//     it trails the pointer like a physical object rather than snapping.
//     React only re-renders when something discrete happens (a slot
//     changes hands, a fold target appears).
//   - Reorder vs fold is decided by WHERE on the target the pointer is
//     and for HOW LONG: the target's icon center is the fold zone (dwell
//     ~280ms to arm it); the far half of the target - past its center
//     relative to where the hole is - is the reorder trigger. Coming in
//     from the near side does nothing yet, so a slow approach lands in the
//     fold zone and a decisive sweep past the center reorders. That order
//     of zones is the whole trick; a "nearest slot wins" rule makes folding
//     impossible because the target moves away before the pointer can
//     ever reach its center.
//   - Touch: a short hold lifts the tile (a swipe before the hold scrolls
//     the page as normal - the hold is what claims the gesture, and a
//     non-passive touchmove listener then keeps the page from scrolling
//     under the drag). Outside Customize mode a mouse drag, or a longer
//     hold on a tile, enters Customize and starts the drag in one motion -
//     the phone's own long-press-to-jiggle - via onRequestEdit.
//
// Keys are opaque strings the grid picks (`folder:<id>` / `<type>:<id>`);
// the engine only asks the grid (through scopesRef) what keys a scope has,
// which are folders, and which box counts as "outside" for ejecting.
//
// Layout of this file: createDragEngine is the imperative machinery, a
// plain closure with no React in it; useTileDrag below is the thin hook
// that creates one engine per grid component, feeds it the current
// callbacks, and turns its discrete events into React state.

const LIFT_MOVE_PX = 5;        // mouse: movement that starts a drag in Customize mode
const TOUCH_HOLD_MS = 260;     // touch: hold that lifts a tile in Customize mode
const ENTER_HOLD_MS = 480;     // either: hold that enters Customize from browse mode
const TOUCH_SLOP_PX = 8;       // touch: movement before the hold that means "scrolling"
const FOLD_DWELL_MS = 280;     // resting over an icon center this long arms a fold
const FOLD_ZONE = 46;          // px box around the icon center that counts as "on the icon"
const EJECT_MARGIN = 20;       // px outside the folder box before a drag ejects
const SETTLE_MS = 230;         // ghost's flight to its slot on release
const FOLD_MS = 280;           // ghost's shrink into a fold target
const SHIFT_EASE = 'cubic-bezier(.2,.8,.2,1)';
const GHOST_LAYER_ID = 'links-drag-layer';

function ghostLayer() {
  let el = document.getElementById(GHOST_LAYER_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = GHOST_LAYER_ID;
    document.body.appendChild(el);
  }
  return el;
}

function scrollParentOf(el) {
  let node = el?.parentElement;
  while (node && node !== document.body) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return node;
    node = node.parentElement;
  }
  return null; // the window scrolls
}

function moveInOrder(order, from, to) {
  if (from === to) return order;
  const next = order.slice();
  const [k] = next.splice(from, 1);
  next.splice(to, 0, k);
  return next;
}

// Measured slot boxes relative to the scope container's own top-left, so a
// scroll between lift and release doesn't invalidate them.
function measureSlots(container, els, keys) {
  const c = container.getBoundingClientRect();
  const slots = [];
  const baseIndex = new Map();
  for (const key of keys) {
    const el = els.get(key);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    // The icon's center within the tile is measured, not assumed: on touch
    // devices the action row sits in the flow above the icon and pushes
    // it down, and the fold zone has to sit on the icon either way.
    const ir = el.querySelector('.app-tile-icon-wrap')?.getBoundingClientRect() || r;
    baseIndex.set(key, slots.length);
    slots.push({ x: r.left - c.left, y: r.top - c.top, w: r.width, h: r.height, icy: ir.top - r.top + ir.height / 2 });
  }
  return { slots, baseIndex };
}

function gapsOf(slots) {
  let gapX = 14, gapY = 20;
  for (let i = 1; i < slots.length; i++) {
    if (Math.abs(slots[i].y - slots[i - 1].y) < 2) { gapX = Math.max(4, slots[i].x - (slots[i - 1].x + slots[i - 1].w)); break; }
  }
  for (let i = 1; i < slots.length; i++) {
    if (slots[i].y > slots[i - 1].y + 2) { gapY = Math.max(4, slots[i].y - (slots[i - 1].y + slots[i - 1].h)); break; }
  }
  return { gapX, gapY };
}

// One more slot after the last one, for a tile that is entering this scope
// from elsewhere (an eject) and so has no element to measure yet.
function appendSyntheticSlot(slots, container, fallbackW, fallbackH) {
  if (slots.length === 0) return [{ x: 0, y: 0, w: fallbackW, h: fallbackH, icy: 36 }];
  const last = slots[slots.length - 1];
  const { gapX, gapY } = gapsOf(slots);
  let x = last.x + last.w + gapX, y = last.y;
  if (x + last.w > container.clientWidth + 1) { x = slots[0].x; y = last.y + last.h + gapY; }
  return [...slots, { x, y, w: last.w, h: last.h, icy: last.icy }];
}

function inflatedHit(slot, px, py, padX, padY) {
  return px >= slot.x - padX && px <= slot.x + slot.w + padX && py >= slot.y - padY && py <= slot.y + slot.h + padY;
}

// ── The engine ────────────────────────────────────────────────────────────
// env: { onUi: (ui|null) => void }. The hook binds the two React refs it
// reads at event time (scopesRef, cbsRef) through bind(), from an effect -
// never during a render. The engine owns the element registry (scope ->
// Map<key, element>) and exposes it as `els`.
function createDragEngine(env) {
  const els = new Map();
  env = { ...env, els, scopesRef: { current: {} }, cbsRef: { current: {} } };
  const bind = (refs) => { Object.assign(env, refs); };
  let s = null;          // the live gesture, null when idle
  let ui = null;         // what React last got told
  let lastDropAt = 0;
  const suppressClick = new Set();

  const publish = () => {
    ui = s ? {
      key: s.key, kind: s.kind, scope: s.scope, order: s.order, foldKey: s.foldKey || null,
      ejected: !!s.ejected, fromScope: s.fromScope,
    } : null;
    env.onUi(ui);
  };

  const loadScope = (scope, enteringKey) => {
    const meta = env.scopesRef.current[scope];
    const m = env.els.get(scope) || new Map();
    const { slots, baseIndex } = measureSlots(meta.container, m, meta.keys);
    let order = meta.keys.filter(k => baseIndex.has(k));
    let allSlots = slots;
    if (enteringKey) {
      allSlots = appendSyntheticSlot(slots, meta.container, s.ghostRect.w, s.ghostRect.h);
      order = [...order, enteringKey];
    }
    Object.assign(s, {
      scope, meta, slots: allSlots, baseIndex, order, ...gapsOf(slots),
      folderCount: meta.folderCount || 0,
      scrollEl: scrollParentOf(meta.container),
    });
  };

  const slotViewport = (slot) => {
    const c = s.meta.container.getBoundingClientRect();
    return { x: c.left + slot.x, y: c.top + slot.y, w: slot.w, h: slot.h };
  };

  const makeGhost = (el, rect) => {
    const g = el.cloneNode(true);
    g.querySelectorAll('.app-tile-actions, .app-tile-tooltip, .app-tile-info-btn').forEach(n => n.remove());
    g.classList.add('app-tile-ghost');
    g.classList.remove('app-tile-fold-target', 'app-tile-dragging', 'app-tile-holding');
    g.removeAttribute('id');
    g.style.cssText = `position:fixed;left:0;top:0;width:${rect.width}px;height:${rect.height}px;margin:0;transform:translate3d(${rect.left}px,${rect.top}px,0) scale(1);`;
    ghostLayer().appendChild(g);
    // Lift on the next frame so the scale/shadow transition plays from rest;
    // once it has, drop the transform transition so the ghost tracks the
    // eased position directly instead of lagging a second time behind it.
    requestAnimationFrame(() => g.classList.add('lifted'));
    setTimeout(() => g.classList.add('following'), 200);
    return g;
  };

  const placeGhost = (x, y, extra = 'scale(1.08)') => {
    if (s?.ghost) s.ghost.style.transform = `translate3d(${x}px,${y}px,0) ${extra}`;
  };

  // Where the pointer is, and what that means for the live order.
  const evaluate = () => {
    if (!s?.active) return;
    const { pointer } = s;

    // Eject: still in a folder scope but the pointer left the folder's box.
    if (s.meta.bounds && s.meta.ejectTo && !s.ejected) {
      const b = s.meta.bounds.getBoundingClientRect();
      const out = pointer.x < b.left - EJECT_MARGIN || pointer.x > b.right + EJECT_MARGIN
        || pointer.y < b.top - EJECT_MARGIN || pointer.y > b.bottom + EJECT_MARGIN;
      if (out) {
        s.fromScope = s.scope;
        s.ejected = true;
        s.foldCandidate = null; s.foldKey = null;
        env.cbsRef.current.onEjectStart?.(s.scope, s.key);
        loadScope(s.meta.ejectTo, s.key);
        publish();
        return;
      }
    }

    const c = s.meta.container.getBoundingClientRect();
    const px = pointer.x - c.left, py = pointer.y - c.top;
    const hole = s.order.indexOf(s.key);
    let over = -1;
    for (let i = 0; i < s.slots.length; i++) {
      if (inflatedHit(s.slots[i], px, py, s.gapX / 2, s.gapY / 2)) { over = i; break; }
    }
    const clearFold = () => {
      s.foldCandidate = null;
      if (s.foldKey) { s.foldKey = null; publish(); }
    };
    if (over === -1 || over === hole) { clearFold(); return; }

    const slot = s.slots[over];
    const targetKey = s.order[over];
    const isFolderSlot = over < s.folderCount;
    const cx = slot.x + slot.w / 2, cy = slot.y + slot.icy;
    const inCenter = Math.abs(px - cx) <= FOLD_ZONE / 2 && Math.abs(py - cy) <= FOLD_ZONE / 2;
    const inFolder = s.scope.startsWith('folder:');
    // A folder only reorders among folders; an app among apps (or anywhere
    // inside a folder); only an app on the main grid can fold.
    const canReorder = s.kind === 'folder' ? isFolderSlot : (inFolder || !isFolderSlot);
    const canFold = s.kind === 'item' && !inFolder && (s.meta.canFold?.(s.key, targetKey) ?? true);

    if (inCenter && canFold) {
      if (s.foldCandidate !== targetKey) {
        s.foldCandidate = targetKey;
        s.foldSince = performance.now();
        if (s.foldKey) { s.foldKey = null; publish(); }
      }
      return;
    }
    clearFold();
    if (!canReorder) return;
    // Reorder once the pointer is past the target's center relative to the
    // hole (same row), or anywhere on it when it sits in another row.
    const sameRow = Math.abs(slot.y - s.slots[hole].y) < 2;
    const past = !sameRow || (over > hole ? px >= cx - 4 : px <= cx + 4);
    if (!past) return;
    s.order = moveInOrder(s.order, hole, over);
    publish();
  };

  // The frame loop: eases the ghost, auto-scrolls, arms a fold after dwell.
  const frame = () => {
    if (!s?.active) return;
    s.pos.x += (s.target.x - s.pos.x) * 0.42;
    s.pos.y += (s.target.y - s.pos.y) * 0.42;
    placeGhost(s.pos.x, s.pos.y);

    const edge = 72, vh = window.innerHeight;
    let dy = 0;
    if (s.pointer.y < edge) dy = -Math.min(16, (edge - s.pointer.y) * 0.25);
    else if (s.pointer.y > vh - edge) dy = Math.min(16, (s.pointer.y - (vh - edge)) * 0.25);
    if (dy) {
      if (s.scrollEl) s.scrollEl.scrollTop += dy; else window.scrollBy(0, dy);
      evaluate(); // the slots moved under a still pointer
    }
    if (s.foldCandidate && !s.foldKey && performance.now() - s.foldSince >= FOLD_DWELL_MS) {
      s.foldKey = s.foldCandidate;
      publish();
    }
    s.raf = requestAnimationFrame(frame);
  };

  const start = (scope, key, kind, el, pointerId, clientX, clientY) => {
    const rect = el.getBoundingClientRect();
    s = {
      active: true, key, kind, scope, pointerId,
      ghostRect: { w: rect.width, h: rect.height },
      grab: { x: clientX - rect.left, y: clientY - rect.top },
      pointer: { x: clientX, y: clientY },
      target: { x: rect.left, y: rect.top },
      pos: { x: rect.left, y: rect.top },
      foldCandidate: null, foldKey: null, foldSince: 0, ejected: false, fromScope: null,
      originEl: el,
    };
    s.ghost = makeGhost(el, rect);
    loadScope(scope);
    document.body.classList.add('links-dragging');
    publish();
    s.raf = requestAnimationFrame(frame);
  };

  const finish = (mode) => {
    if (!s?.active) return;
    const g = s;
    g.active = false;
    lastDropAt = performance.now();
    cancelAnimationFrame(g.raf);
    document.body.classList.remove('links-dragging');
    const ghost = g.ghost;
    // Commit and clear in one synchronous step: React batches the grid's
    // new order and the cleared transforms into a single render.
    const done = (commit) => {
      ghost.remove();
      s = null;
      commit?.();
      publish();
    };

    if (mode === 'cancel') {
      // Fly home. If this drag had ejected, the folder comes back untouched.
      const r = g.originEl.getBoundingClientRect();
      ghost.classList.remove('lifted');
      ghost.style.transition = `transform ${SETTLE_MS}ms ${SHIFT_EASE}, box-shadow ${SETTLE_MS}ms ease`;
      ghost.style.transform = `translate3d(${r.left}px,${r.top}px,0) scale(1)`;
      setTimeout(() => done(() => { if (g.ejected) env.cbsRef.current.onEjectCancel?.(g.fromScope, g.key); }), SETTLE_MS);
      return;
    }

    if (g.foldKey) {
      const targetEl = (env.els.get(g.scope) || new Map()).get(g.foldKey);
      const iconEl = targetEl?.querySelector('.app-tile-icon-wrap') || targetEl;
      const r = iconEl ? iconEl.getBoundingClientRect() : slotViewport(g.slots[g.order.indexOf(g.foldKey)]);
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      targetEl?.classList.add('app-tile-absorb');
      ghost.style.transition = `transform ${FOLD_MS}ms cubic-bezier(.4,0,.2,1), opacity ${FOLD_MS}ms ease`;
      ghost.style.opacity = '0.15';
      ghost.style.transform = `translate3d(${cx - g.ghostRect.w / 2}px,${cy - g.ghostRect.h / 2}px,0) scale(0.22)`;
      setTimeout(() => done(() => {
        targetEl?.classList.remove('app-tile-absorb');
        env.cbsRef.current.onFold?.(g.scope, g.key, g.foldKey, g.ejected ? g.fromScope : null);
      }), FOLD_MS);
      return;
    }

    // Settle into the hole, then commit the order (and the eject, if any).
    const slot = slotViewport(g.slots[g.order.indexOf(g.key)]);
    ghost.classList.remove('lifted');
    ghost.style.transition = `transform ${SETTLE_MS}ms ${SHIFT_EASE}, box-shadow ${SETTLE_MS}ms ease`;
    ghost.style.transform = `translate3d(${slot.x}px,${slot.y}px,0) scale(1)`;
    const startOrder = g.meta.keys.filter(k => g.baseIndex.has(k));
    const changed = g.ejected || g.order.some((k, i) => startOrder[i] !== k);
    setTimeout(() => done(() => {
      if (g.ejected) env.cbsRef.current.onEject?.(g.fromScope, g.key, g.scope, g.order);
      else if (changed) env.cbsRef.current.onReorder?.(g.scope, g.order);
    }), SETTLE_MS);
  };

  // Document-level listeners for the life of the component. Not pointer
  // capture: an ejected tile's element sits inside a folder box that fades
  // away mid-drag, and capture dies with a detached element.
  const onMove = (e) => {
    if (!s?.active || e.pointerId !== s.pointerId) return;
    s.pointer = { x: e.clientX, y: e.clientY };
    s.target = { x: e.clientX - s.grab.x, y: e.clientY - s.grab.y };
    evaluate();
  };
  const onUp = (e) => { if (s?.active && e.pointerId === s.pointerId) finish('drop'); };
  const onCancel = (e) => { if (s?.active && e.pointerId === s.pointerId) finish('cancel'); };
  const onKey = (e) => { if (e.key === 'Escape' && s?.active) finish('cancel'); };
  const onTouchMove = (e) => { if (s?.active) e.preventDefault(); };
  const attach = () => {
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onCancel);
    document.addEventListener('keydown', onKey);
    document.addEventListener('touchmove', onTouchMove, { passive: false });
  };
  const detach = () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', onCancel);
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('touchmove', onTouchMove);
    if (s?.ghost) s.ghost.remove();
    if (s?.raf) cancelAnimationFrame(s.raf);
    s = null;
    document.body.classList.remove('links-dragging');
  };

  // The press that may become a drag. `draggable`: this scope drags right
  // now (a folder's inside is always live; the main grid only in Customize).
  // `holdToEdit`: browse mode - a long hold enters Customize and lifts.
  const press = (e, scope, key, kind, draggable, holdToEdit) => {
    if (e.button !== 0 || s?.active) return;
    // A press on one of the tile's own buttons (favorite, folder picker,
    // info) is theirs; a press anywhere else on the tile - including the
    // gaps of the action row - is the start of a drag.
    if (e.target.closest('.app-tile-actions button, .folder-picker, button:not(.app-tile)')) return;
    if (!draggable && !holdToEdit) return;
    const el = e.currentTarget;
    const pointerId = e.pointerId;
    const startX = e.clientX, startY = e.clientY;
    // Touch is always hold-gated (a swipe must still scroll the page). A
    // mouse drags on movement alone, in browse mode too - the lift is what
    // enters Customize there - since a desktop user expects to just drag.
    const holdGated = e.pointerType === 'touch';
    let lastX = startX, lastY = startY;
    let timer = null, armed = false, lifted = false;
    const cleanup = () => {
      clearTimeout(timer);
      el.removeEventListener('pointermove', onPressMove);
      el.removeEventListener('pointerup', cleanup);
      el.removeEventListener('pointercancel', cleanup);
      el.classList.remove('app-tile-holding');
    };
    const lift = () => {
      if (lifted) return;
      lifted = true;
      cleanup();
      suppressClick.add(key);
      if (!draggable && holdToEdit) env.cbsRef.current.onRequestEdit?.();
      start(scope, key, kind, el, pointerId, lastX, lastY);
    };
    const onPressMove = (ev) => {
      if (ev.pointerId !== pointerId) return;
      lastX = ev.clientX; lastY = ev.clientY;
      const dist = Math.hypot(ev.clientX - startX, ev.clientY - startY);
      if (holdGated) {
        // Moving before the hold means scrolling / no intent; after it,
        // any movement carries the lifted tile.
        if (!armed && dist > TOUCH_SLOP_PX) cleanup();
        else if (armed && dist > 2) lift();
      } else if (dist > LIFT_MOVE_PX) {
        lift();
      }
      // A mouse held still in browse mode also lifts after the long hold,
      // like the phone - see the timer below.
    };
    el.addEventListener('pointermove', onPressMove);
    el.addEventListener('pointerup', cleanup);
    el.addEventListener('pointercancel', cleanup);
    if (holdGated || !draggable) {
      el.classList.add('app-tile-holding');
      timer = setTimeout(() => {
        armed = true;
        el.classList.remove('app-tile-holding');
        lift(); // the hold itself lifts - the phone gesture
      }, draggable ? TOUCH_HOLD_MS : ENTER_HOLD_MS);
    }
  };

  const consumeClick = (key) => suppressClick.delete(key);
  const recentlyDropped = () => performance.now() - lastDropAt < 400;
  const state = () => s;
  const getUi = () => ui;

  return { els, bind, attach, detach, press, consumeClick, recentlyDropped, state, getUi };
}

// ── The hook ──────────────────────────────────────────────────────────────
export function useTileDrag({ editable, onRequestEdit, scopesRef, onReorder, onFold, onEjectStart, onEject, onEjectCancel }) {
  const cbs = useRef({});
  useLayoutEffect(() => {
    cbs.current = { editable, onRequestEdit, onReorder, onFold, onEjectStart, onEject, onEjectCancel };
  });
  const [ui, setUi] = useState(null);
  const [engine] = useState(() => createDragEngine({ onUi: setUi }));
  useLayoutEffect(() => { engine.bind({ scopesRef, cbsRef: cbs }); });
  useEffect(() => { engine.attach(); return () => engine.detach(); }, [engine]);

  const register = useCallback((scope, key) => (el) => {
    let m = engine.els.get(scope);
    if (!m) { m = new Map(); engine.els.set(scope, m); }
    if (el) m.set(key, el); else m.delete(key);
  }, [engine]);

  // Per-tile props: registration ref, the press that may become a drag,
  // and the click swallow for the press that lifted it.
  const tileProps = useCallback((scope, key, kind, { draggable, holdToEdit } = {}) => ({
    ref: register(scope, key),
    onPointerDown: (e) => engine.press(e, scope, key, kind, draggable, holdToEdit),
    onContextMenu: (e) => { if (draggable || holdToEdit) e.preventDefault(); },
    // The browser's own drag of the icon image would hijack a mouse drag.
    onDragStart: (e) => e.preventDefault(),
    onClickCapture: (e) => { if (engine.consumeClick(key)) { e.preventDefault(); e.stopPropagation(); } },
  }), [engine, register]);

  // Inline style that slides a tile from its measured slot to the slot it
  // holds in the live order, and hides the one being dragged.
  const tileStyle = useCallback((scope, key) => {
    const u = engine.getUi();
    const s = engine.state();
    if (!u || !s) return undefined;
    const hidden = key === u.key;
    if (u.scope !== scope) return hidden ? { visibility: 'hidden' } : undefined;
    const idx = u.order.indexOf(key);
    const base = s.baseIndex.get(key);
    if (idx < 0 || base == null) return hidden ? { visibility: 'hidden' } : undefined;
    const from = s.slots[base], to = s.slots[idx];
    const dx = to.x - from.x, dy = to.y - from.y;
    return {
      transform: dx || dy ? `translate(${dx}px, ${dy}px)` : undefined,
      transition: `transform .26s ${SHIFT_EASE}`,
      visibility: hidden ? 'hidden' : undefined,
    };
  }, [engine]);

  // FLIP for committed changes (a fold, an eject): snapshot every tile's
  // box before the commit, then after React lays out the new order, start
  // each surviving tile at its old spot and let it glide to the new one.
  // Newly appeared tiles (a fresh folder) pop in via .app-tile-enter.
  const flip = useRef({ snap: null, scope: null });
  const [flipToken, setFlipToken] = useState(0);
  const commitWithFlip = useCallback((scope, fn) => {
    const m = engine.els.get(scope) || new Map();
    const snap = new Map();
    m.forEach((el, key) => { snap.set(key, el.getBoundingClientRect()); });
    flip.current = { snap, scope };
    fn();
    setFlipToken(t => t + 1);
  }, [engine]);
  useLayoutEffect(() => {
    const { snap, scope } = flip.current;
    if (!snap) return;
    flip.current = { snap: null, scope: null };
    const m = engine.els.get(scope) || new Map();
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    m.forEach((el, key) => {
      const before = snap.get(key);
      if (!before) {
        if (!reduced) {
          el.classList.add('app-tile-enter');
          el.addEventListener('animationend', () => el.classList.remove('app-tile-enter'), { once: true });
        }
        return;
      }
      if (reduced) return;
      const after = el.getBoundingClientRect();
      const dx = before.left - after.left, dy = before.top - after.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      el.style.transition = 'none';
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      void el.offsetWidth; // flush so the next frame transitions from here
      requestAnimationFrame(() => {
        el.style.transition = `transform .32s ${SHIFT_EASE}`;
        el.style.transform = '';
        el.addEventListener('transitionend', () => { el.style.transition = ''; }, { once: true });
      });
    });
  }, [flipToken, engine]);

  const recentlyDropped = useCallback(() => engine.recentlyDropped(), [engine]);

  return { ui, tileProps, tileStyle, register, commitWithFlip, recentlyDropped, active: !!ui };
}

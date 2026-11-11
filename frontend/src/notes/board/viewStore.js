// Where the board is scrolled and zoomed, for the things Nexus draws over the
// canvas (Neil, 11/10/2026): vote dots, Private Writing stickies, the sticky
// composer, the measure preview, a comment's thread. A tiny store, so a pan
// re-renders only those layers - never Board, never the engine.
import { useSyncExternalStore } from 'react';

export function createViewStore() {
  let view = { scrollX: 0, scrollY: 0, zoom: 1 };
  const subs = new Set();
  return {
    get: () => view,
    /** From the engine's appState; listeners hear only a real move. */
    set(appState) {
      const next = { scrollX: Number(appState?.scrollX) || 0, scrollY: Number(appState?.scrollY) || 0, zoom: Number(appState?.zoom?.value) || 1 };
      if (next.scrollX === view.scrollX && next.scrollY === view.scrollY && next.zoom === view.zoom) return;
      view = next;
      subs.forEach((f) => f());
    },
    subscribe: (f) => { subs.add(f); return () => subs.delete(f); },
  };
}

export const useView = (store) => useSyncExternalStore(store.subscribe, store.get, store.get);

/** A board point on the stage (px from its top-left corner). */
export const toStage = (view, x, y) => ({ x: (x + view.scrollX) * view.zoom, y: (y + view.scrollY) * view.zoom });

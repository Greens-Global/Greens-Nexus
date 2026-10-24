import { useCallback, useEffect, useRef, useState } from 'react';
import { withFreshReads } from '../../api';

/**
 * One table's own Sync (10/23 meeting, item 13; Neil in the chat: "sync should
 * be table level and not just overall"). Pair it with reportControls'
 * SyncButton. The table's reads go out with fresh=1 (api.js withFreshReads),
 * so the server asks the accounting app again instead of answering from its
 * short cache; nothing else on the screen reloads. The screen keeps showing
 * its rows while the new ones load and swaps them in place - it never clears
 * them - so an open popup or side panel, the filters, the search, the sort and
 * the scroll position all stay as they are.
 *
 * Two shapes of screen:
 *  - a load key (`[year, period, reloads]` and an effect that reads):
 *      const ts = useTableSync();
 *      const key = JSON.stringify([year, period, reloads, ts.tick]);
 *      useEffect(() => { ts.read(() => api.getX(year)).then(...) }, [key]);
 *    `read` sends the call fresh only on the load a Sync asked for.
 *  - a load function: `const ts = useTableSync(load)`; Sync runs load() with
 *    fresh reads until the promise load returns settles.
 *
 * Returns { tick, sync, read, syncedAt } - syncedAt is when Sync was last
 * clicked, for the button's tooltip.
 */
export function useTableSync(load = null) {
  const [tick, setTick] = useState(0);
  const [syncedAt, setSyncedAt] = useState(null);
  const pending = useRef(false);
  const loadRef = useRef(load);
  useEffect(() => { loadRef.current = load; }, [load]);
  const read = useCallback((fn) => {
    if (!pending.current) return fn();
    pending.current = false;
    return withFreshReads(fn);
  }, []);
  const sync = useCallback(() => {
    setSyncedAt(new Date());
    if (loadRef.current) return Promise.resolve(withFreshReads(loadRef.current));
    pending.current = true;
    setTick((t) => t + 1);
    return undefined;
  }, []);
  return { tick, sync, read, syncedAt };
}

// Shift self-service data (Sep 29): my requests, the swaps/offers waiting
// on me, open shifts in [start, end], the teammates and the settings.
// Returns [data, reload, error] - a failed load is an error the screen can
// show with Retry, never a skeleton forever (Shifts QA 21).
import { useEffect, useState } from 'react';
import { api } from '../api';

export function useShiftRequests(start, end) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setError(null);
    api.shiftRequestsMine(start, end)
      .then((r) => { if (live) setData(r); })
      .catch((e) => { if (live) { setData(null); setError(e?.message || 'Could not load the requests.'); } });
    return () => { live = false; };
  }, [start, end, tick]);
  return [data, () => setTick((t) => t + 1), error];
}

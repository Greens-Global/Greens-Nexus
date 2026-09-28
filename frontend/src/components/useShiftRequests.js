// Shift self-service data for My Workday > Shifts (Sep 29): my requests, the
// swaps/offers waiting on me, open shifts in [start, end], and the settings.
// Returns [data, reload]. See components/ShiftSelfService.jsx.
import { useEffect, useState } from 'react';
import { api } from '../api';

export function useShiftRequests(start, end) {
  const [data, setData] = useState(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    api.shiftRequestsMine(start, end)
      .then((r) => { if (live) setData(r); })
      .catch(() => { if (live) setData(null); });
    return () => { live = false; };
  }, [start, end, tick]);
  return [data, () => setTick((t) => t + 1)];
}


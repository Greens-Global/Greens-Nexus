// The manager's inbox (Oct 2026): shift requests waiting on a manager, the
// ones still waiting on a teammate, the recently decided, and the pending
// time-off requests - loaded ONCE for the Shifts module (the Requests tab's
// badge and page share it; the schedule used to fetch it a second time) and
// refreshed every minute while the tab is visible, so a badge is never
// stale until the manager's own action.
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import { pollWhileVisible } from '../../lib/pollWhileVisible';

export const INBOX_CHANGED = 'nexus:shift-requests-changed';
export const notifyInboxChanged = () => window.dispatchEvent(new CustomEvent(INBOX_CHANGED));

export function useManagerInbox(enabled, every = 60000) {
  const [inbox, setInbox] = useState(null);
  const [timeoff, setTimeoff] = useState(null);
  const [error, setError] = useState(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    Promise.all([api.shiftRequestsInbox(), api.timeOffList('pending')])
      .then(([r, t]) => { if (live) { setInbox(r || { pending: [], recent: [] }); setTimeoff(Array.isArray(t) ? t : []); setError(null); } })
      .catch((e) => { if (live) setError(e?.message || 'Could not load the requests.'); });
    return () => { live = false; };
  }, [enabled, tick]);
  useEffect(() => {
    if (!enabled) return undefined;
    const stop = pollWhileVisible(reload, every);
    window.addEventListener(INBOX_CHANGED, reload);
    return () => { stop(); window.removeEventListener(INBOX_CHANGED, reload); };
  }, [enabled, every, reload]);
  const pendingCount = (inbox?.pending || []).length + (timeoff || []).filter((t) => t.canDecide !== false).length;
  return { inbox, timeoff, error, loading: enabled && !inbox && !error, reload, pendingCount };
}

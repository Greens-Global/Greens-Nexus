// When the Operations figures were last copied from Cubby (Oct 15 2026), with a
// "Cubby Sync Delayed" chip when the copy is late (see sync.js).
import { useEffect, useState } from 'react';
import { formatDateTime, formatTime } from '../lib/datetime';
import { SYNC_LATE_MIN, syncDelayed } from './sync';

function when(iso, now) {
  const d = new Date(iso);
  return d.toDateString() === new Date(now).toDateString() ? formatTime(d) : formatDateTime(d);
}

export default function SyncStatus({ data, syncing = false, now }) {
  // The clock ticks once a minute so a copy that turns late shows it without a reload.
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  if (!data) return null;
  const at = now ?? tick;
  const late = syncDelayed(data, at);
  let label;
  if (syncing) label = 'Syncing from Cubby…';
  else if (data.syncStatus === 'live') label = 'Read live from Cubby - first sync in progress';
  else label = data.syncedAt ? `Synced ${when(data.syncedAt, at)}` : 'Not synced yet';
  const why = data.syncStatus === 'failed'
    ? 'The last Cubby sync failed. These figures are from the last good one.'
    : data.syncStatus === 'partial'
      ? 'Some facilities could not be read from Cubby on the last sync. Their figures are from the last good one.'
      : `Cubby has not synced for more than ${SYNC_LATE_MIN} minutes.`;
  return (
    <span className="ops-sync" data-testid="ops-sync">
      <span>{label}</span>
      {late && !syncing && <span className="status-badge pill-warn" title={why}>Cubby Sync Delayed</span>}
    </span>
  );
}

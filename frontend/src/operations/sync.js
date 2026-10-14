// Cubby sync freshness (Oct 15 2026): the server copies Cubby into the database
// every 15 minutes. A copy is "delayed" when the last sync failed or only partly
// finished, or when it is older than SYNC_LATE_MIN.
export const SYNC_LATE_MIN = 45;

export function syncDelayed(data, now) {
  if (!data || data.syncStatus === 'live') return false;
  if (data.syncStatus === 'failed' || data.syncStatus === 'partial') return true;
  const t = Date.parse(data.syncedAt || '');
  return !Number.isFinite(t) || now - t > SYNC_LATE_MIN * 60_000;
}

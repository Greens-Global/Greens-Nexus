import { formatDate } from '../lib/datetime';
import { formatHM } from '../lib/hoursText';

// The scorecard's labor column (Neil, 11/21/2026): time clocked at the store's own work sites
// over the last complete days, as hours:minutes - never pay, never a name
// (backend/ops_store_hours.py). A store tied to no work site shows a dash.
export function storeHoursCell(hours, facilityId) {
  const row = hours?.stores?.[facilityId];
  if (!row) return { text: '-', title: 'No Time Clock work site covers this store.' };
  const who = row.people === 1 ? '1 person' : `${row.people} people`;
  return {
    text: formatHM(row.minutes),
    title: `${formatHM(row.minutes)} clocked by ${who} at ${row.sites.join(', ')}, ${formatDate(hours.from)} - ${formatDate(hours.to)}`,
  };
}

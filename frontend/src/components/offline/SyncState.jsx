// One queued change's state as a soft label (field offline, Neil 11/03/2026):
// Waiting to Send / Sending / Sent / Needs Your Choice / Not Sent. A screen
// that queued something shows it beside the thing:
//   <SyncState id={entry.id} />            live from the outbox
//   <SyncState entry={entry} />            an entry already in hand
import { StatusLabel } from '../StatusLabel';
import { useOutboxEntry, syncWords, syncColor } from '../../lib/offline/useOffline';

export default function SyncState({ id = '', entry: given = null, size = 'sm', style }) {
  const live = useOutboxEntry(given ? '' : id);
  const entry = given || live;
  const words = syncWords(entry);
  if (!words) return null;
  return <StatusLabel label={words} color={syncColor(entry)} size={size} style={style} title={entry?.error || undefined} />;
}

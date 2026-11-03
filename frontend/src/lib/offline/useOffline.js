// The React face of field offline (Neil, 11/03/2026; docs/Offline.md).
//
//   const { online, waiting, conflicts, failed, signedOut, entries, syncNow } = useOffline();
//   const entry = useOutboxEntry(id);          // one queued change, live
//   syncWords(entry)                          // 'Waiting to Send' | 'Sending' | 'Sent' | 'Needs Your Choice' | 'Not Sent'
//
// Reads lib/offline/status.js only (tiny, always loaded); the actions load
// the outbox when first used.
import { useSyncExternalStore } from 'react';
import { getStatus, subscribe, syncNow } from './status';

const outbox = () => import('./outbox');

export const resolveConflict = (id, choice) => outbox().then((m) => m.resolveConflict(id, choice));
export const retryEntry = (id) => outbox().then((m) => m.retryEntry(id));
export const discardEntry = (id) => outbox().then((m) => m.discardEntry(id));

export function useOffline() {
  const s = useSyncExternalStore(subscribe, getStatus, getStatus);
  return { ...s, syncNow, resolveConflict, retryEntry, discardEntry };
}

export function useOutboxEntry(id) {
  const s = useSyncExternalStore(subscribe, getStatus, getStatus);
  return id ? s.entries.find((e) => e.id === id) || null : null;
}

/** The words for one queued change's state (Title Case, the list's labels). */
export function syncWords(entry) {
  switch (entry?.state) {
    case 'sending': return 'Sending';
    case 'sent': return 'Sent';
    case 'conflict': return 'Needs Your Choice';
    case 'failed': return 'Not Sent';
    case 'pending':
    case 'parked': return 'Waiting to Send';
    default: return '';
  }
}

/** The color of that label (slate while waiting, green sent, amber a choice, red refused). */
export function syncColor(entry) {
  switch (entry?.state) {
    case 'sent': return '#16a34a';
    case 'conflict': return '#d97706';
    case 'failed': return '#dc2626';
    case 'sending': return '#2563eb';
    default: return '#64748b';
  }
}

/** "1 change" / "3 changes". */
export const changes = (n) => `${n} ${n === 1 ? 'change' : 'changes'}`;

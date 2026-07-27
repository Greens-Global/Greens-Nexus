import { useState, useEffect, useRef } from 'react';
import { hasPending, getRetryCount } from '../../lib/sync.js';

const STATE_CONFIG = {
  saved: { color: 'green', text: 'All changes saved' },
  saving: { color: 'blue', text: 'Saving…' },
  retry: { color: 'orange', text: 'Reconnecting — changes will save' },
  offline: { color: 'orange', text: 'Offline — changes will save when back online' },
};

/** Fixed bottom-left pill showing Saved/Saving/Reconnecting/Offline, polling sync globals every 900ms. */
export function SyncStatus() {
  const [, forceUpdate] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => forceUpdate((x) => x + 1), 900);
    const onNetworkChange = () => forceUpdate((x) => x + 1);
    if (typeof window !== 'undefined') {
      window.addEventListener('online', onNetworkChange);
      window.addEventListener('offline', onNetworkChange);
    }
    return () => {
      clearInterval(interval);
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', onNetworkChange);
        window.removeEventListener('offline', onNetworkChange);
      }
    };
  }, []);

  const pending = hasPending();
  const retry = getRetryCount();
  const online = typeof navigator === 'undefined' || navigator.onLine;
  const state = !online ? 'offline' : pending && retry > 0 ? 'retry' : pending ? 'saving' : 'saved';
  const cfg = STATE_CONFIG[state];
  const busy = state === 'saving' || state === 'retry';

  // Auto-hide when idle: the pill sits over the sidebar's user chip (bottom-left),
  // so a permanent "All changes saved" badge covers it. Show while there's
  // something to say (saving/retry/offline), linger ~2s after a save completes,
  // then disappear. lastBusyRef starts at 0, so a fresh mount with nothing
  // pending renders nothing. The 900ms poll re-render drives the timeout check.
  // Intentional ref-during-render: this is a poll-driven visibility timer, not
  // React-managed state, so the ref read/write here is deliberate (a newer
  // react-hooks rule flags the pattern; the behaviour is correct and stable).
  const lastBusyRef = useRef(0);
  // eslint-disable-next-line react-hooks/refs
  if (busy || state === 'offline') lastBusyRef.current = Date.now();
  // eslint-disable-next-line react-hooks/refs
  if (state === 'saved' && Date.now() - lastBusyRef.current > 2200) return null;

  return (
    <div
      title="Sync status"
      style={{
        position: 'fixed',
        left: 14,
        bottom: 'max(14px, env(safe-area-inset-bottom))',
        zIndex: 9000,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        padding: '6px 12px',
        borderRadius: 999,
        backgroundColor: 'var(--bg-card)',
        border: '1px solid var(--border-color)',
        boxShadow: 'var(--shadow-sm)',
        fontSize: '0.72rem',
        fontWeight: 600,
        color: state === 'saved' ? 'var(--text-muted)' : `hsl(var(--color-${cfg.color}))`,
        opacity: state === 'saved' ? 0.72 : 1,
        whiteSpace: 'nowrap',
        pointerEvents: 'none',
        transition: 'opacity .2s',
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          backgroundColor: `hsl(var(--color-${cfg.color}))`,
          animation: busy ? 'pulse 1s infinite' : 'none',
          flexShrink: 0,
        }}
      />
      {cfg.text}
    </div>
  );
}

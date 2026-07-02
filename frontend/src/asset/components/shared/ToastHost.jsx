import { useState, useEffect } from 'react';

// Module-level pub-sub binding: set by the mounted <ToastHost/> instance, called by
// anything elsewhere in the app that wants to fire a toast (e.g. `pushToast('Saved', 'ok')`).
// null when no ToastHost is mounted (calls are simply no-ops until one mounts).
export let pushToast = null;

const TONE_DOT_COLOR = { ok: 'green', warn: 'orange', bad: 'red', info: 'blue' };

/** Renders queued toasts bottom-center; register/unregister the `pushToast` binding on mount. */
export function ToastHost() {
  const [items, setItems] = useState([]);

  useEffect(() => {
    pushToast = (msg, tone) => {
      const id = Date.now() + Math.random();
      setItems((list) => [...list, { id, msg, tone: tone || 'ok' }]);
      setTimeout(() => setItems((list) => list.filter((x) => x.id !== id)), 2600);
    };
    return () => {
      pushToast = null;
    };
  }, []);

  return (
    <div
      style={{
        position: 'fixed',
        left: '50%',
        bottom: 'max(24px, env(safe-area-inset-bottom))',
        transform: 'translateX(-50%)',
        zIndex: 10000,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        alignItems: 'center',
        pointerEvents: 'none',
        maxWidth: '92vw',
      }}
    >
      {items.map((it) => (
        <div
          key={it.id}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 9,
            padding: '11px 17px',
            borderRadius: 10,
            backgroundColor: 'var(--bg-card)',
            border: '1px solid var(--border-color)',
            borderLeft: '3px solid ' + (it.tone === 'mut' ? 'var(--text-muted)' : `hsl(var(--color-${TONE_DOT_COLOR[it.tone] || 'green'}))`),
            boxShadow: 'var(--shadow-md)',
            fontSize: '0.85rem',
            fontWeight: 600,
            color: 'var(--text-primary)',
            pointerEvents: 'auto',
            whiteSpace: 'nowrap',
          }}
        >
          <span style={{ fontSize: '0.92rem', lineHeight: 1 }}>
            {it.tone === 'bad' ? '⚠' : it.tone === 'mut' ? '🗑' : '✓'}
          </span>
          {it.msg}
        </div>
      ))}
    </div>
  );
}

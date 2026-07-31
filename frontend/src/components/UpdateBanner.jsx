import { RefreshCw, X } from 'lucide-react';
import { useState } from 'react';
import { useBuildVersion } from '../lib/useBuildVersion';

// Non-blocking "a newer Nexus is live" prompt.
//
// Deliberately NOT automatic: a forced reload mid-task would throw away whatever
// the user is typing. They reload when it suits them - and until they do, the
// existing safety nets (ViewErrorBoundary's auto-reload, public/guard.js) still
// catch it if they navigate into a view whose chunk is already gone. This just
// means most people never reach those nets.
//
// Dismissible, because someone deep in a form should be able to make it go away;
// it reappears next session, and the nets are still behind it.
export default function UpdateBanner() {
  const stale = useBuildVersion();
  const [hidden, setHidden] = useState(false);
  if (!stale || hidden) return null;

  return (
    <div role="status" style={{
      position: 'fixed', bottom: 18, left: '50%', transform: 'translateX(-50%)',
      zIndex: 9998, display: 'flex', alignItems: 'center', gap: 12,
      background: 'var(--wk-card, #fff)', color: 'var(--wk-ink, #323338)',
      border: '1px solid var(--wk-line, #d0d4e4)', borderRadius: 10,
      boxShadow: 'var(--wk-shadow, 0 4px 12px rgba(29,33,57,.05))',
      padding: '11px 12px 11px 16px', maxWidth: 'calc(100vw - 32px)',
      fontFamily: 'var(--wk-font, inherit)',
    }}>
      <span style={{ fontSize: 13.5, fontWeight: 600 }}>A new version of Nexus is available</span>
      <button onClick={() => window.location.reload()}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          background: 'var(--wk-brand, #2b45e1)', color: '#fff', border: 0,
          borderRadius: 7, padding: '7px 14px', fontSize: 13, fontWeight: 700,
          cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
        }}>
        <RefreshCw size={13} /> Reload
      </button>
      <button onClick={() => setHidden(true)} aria-label="Dismiss"
        style={{
          background: 'none', border: 0, color: 'var(--wk-dim, #676879)',
          cursor: 'pointer', display: 'inline-flex', padding: 4,
        }}>
        <X size={15} />
      </button>
    </div>
  );
}

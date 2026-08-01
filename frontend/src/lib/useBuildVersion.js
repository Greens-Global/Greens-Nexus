import { useEffect, useState } from 'react';
import { pollWhileVisible } from './pollWhileVisible';

// Notices that this tab is running superseded code, BEFORE the user trips over
// it.
//
// Why this exists: Cloudflare Pages serves exactly one deployment per domain and
// a deploy DELETES the previous chunks. So a tab left open across a merge to dev
// holds an index.html whose hashed chunks no longer exist - the moment it lazily
// imports a view it has not loaded yet, that import 404s. ViewErrorBoundary and
// public/guard.js both recover from this, but only after the user has already
// hit a broken screen. This turns it into a prompt they act on at a moment of
// their choosing.
//
// Polls the no-store /version.json (emitted by the versionManifest plugin in
// vite.config.js) on an interval and whenever the tab regains focus - the focus
// check is the one that matters, since the classic case is a tab that sat idle
// through a deploy.
const POLL_MS = 3 * 60 * 1000;
const MINE = import.meta.env.VITE_BUILD_ID || 'dev';

export function useBuildVersion() {
  const [stale, setStale] = useState(false);

  useEffect(() => {
    // A laptop build has no real id, so every poll would look like a mismatch.
    if (MINE === 'dev') return;
    let live = true;

    async function check() {
      if (!live || document.visibilityState === 'hidden') return;
      try {
        const r = await fetch('/version.json', { cache: 'no-store' });
        if (!r.ok) return;                       // mid-deploy blip, try again later
        const { buildId } = await r.json();
        if (live && buildId && buildId !== MINE) setStale(true);
      } catch { /* offline or mid-deploy - never surface this */ }
    }

    check();
    const stopPoll = pollWhileVisible(check, POLL_MS);
    const onVis = () => { if (document.visibilityState === 'visible') check(); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', onVis);
    return () => {
      live = false;
      stopPoll();
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', onVis);
    };
  }, []);

  return stale;
}

import { RefreshCw, Sparkles, ArrowRight, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useBuildVersion } from '../lib/useBuildVersion';
import { setBuildStale, useUpdateSignal } from '../lib/updateSignal';
import { prefersReducedMotion } from './shifts/motion';

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
//
// When the waiting version brings a New Feature (not just bug fixes), it also
// offers See What's New (Neil, Oct 12 2026), which loads the new version
// straight onto What's New. Whether it does is answered by FeatureBanner from
// inside the signed-in app (lib/updateSignal.js) - this popup sits outside the
// sign-in gate and cannot ask the API itself.
//
// Motion (style.css "Update popup"): it rises in, its icon pops again if the
// news turns into new features while it is up, Reload spins while the page
// reloads, and it drops away when dismissed. Reduced motion: none of it.
const LEAVE_MS = 220;   // matches .update-banner.is-leaving

export default function UpdateBanner() {
  const stale = useBuildVersion();
  const { newFeature } = useUpdateSignal();
  useEffect(() => { setBuildStale(stale); }, [stale]);
  const [hidden, setHidden] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [reloading, setReloading] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  if (!stale || hidden) return null;

  const dismiss = () => {
    if (prefersReducedMotion()) { setHidden(true); return; }
    setLeaving(true);
    timer.current = setTimeout(() => setHidden(true), LEAVE_MS);
  };
  const reload = () => { setReloading(true); window.location.reload(); };
  // A full load (not in-app navigation): the new version, opened on What's New.
  const seeWhatsNew = () => { setReloading(true); window.location.assign('/whats-new'); };

  // `.update-banner` (style.css): centered and sized to its text on desktop;
  // on a phone it spans the screen (12px gutters), the message on top and the
  // buttons sharing the row under it.
  return (
    <div role="status" className={`update-banner${newFeature ? ' has-features' : ''}${leaving ? ' is-leaving' : ''}`}>
      {/* Keyed so the icon pops again when the news becomes "new features". */}
      <span key={newFeature ? 'features' : 'version'} className="update-banner-icon" aria-hidden="true">
        {newFeature ? <Sparkles size={18} /> : <RefreshCw size={17} />}
      </span>
      <span className="update-banner-copy">
        <span className="update-banner-text">A New Version of Nexus Is Available</span>
        <span className="update-banner-sub">
          {newFeature ? 'It comes with new features.' : 'Reload when it suits you.'}
        </span>
      </span>
      {newFeature && (
        <button onClick={seeWhatsNew} disabled={reloading} className="update-banner-whatsnew">
          See What&apos;s New <ArrowRight size={14} className="update-banner-arrow" aria-hidden="true" />
        </button>
      )}
      <button onClick={reload} disabled={reloading} className={newFeature ? 'update-banner-reload update-banner-reload-quiet' : 'update-banner-reload'}>
        <RefreshCw size={13} className={reloading ? 'update-banner-spin' : undefined} aria-hidden="true" /> {reloading ? 'Reloading…' : 'Reload'}
      </button>
      <button onClick={dismiss} aria-label="Dismiss" className="update-banner-close">
        <X size={16} />
      </button>
    </div>
  );
}

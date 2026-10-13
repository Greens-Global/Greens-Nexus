import { RefreshCw, Sparkles, ArrowRight, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useBuildVersion } from '../lib/useBuildVersion';
import { setBuildStale, useUpdateSignal } from '../lib/updateSignal';
import { hasNewFeature, summarizeCategories } from '../lib/changelogCategories';
import { prefersReducedMotion } from '../lib/reducedMotion';

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
// What the new version brings is said in categories only (Neil, Oct 12 2026):
// "Including 2 New Features and 3 Bug Fixes.", with See What's New for the
// details - which loads the new version straight onto What's New. The
// categories are answered by FeatureBanner from inside the signed-in app
// (lib/updateSignal.js); this popup sits outside the sign-in gate and cannot
// ask the API itself, so before (or without) an answer it just offers Reload.
//
// Motion (style.css "Update popup"): it rises in, its icon pops again when the
// answer arrives, Reload spins while the page reloads, and it drops away when
// dismissed. Reduced motion: none of it.
// Removal follows the slide-out's own animationend; this only catches a
// browser that never sends one.
const LEAVE_FALLBACK_MS = 1000;
// A reload the person cancelled at the browser's "Leave site?" prompt
// (unsaved work elsewhere) never unloads the page: the buttons come back.
const RELOAD_RECOVER_MS = 4000;

export default function UpdateBanner() {
  const stale = useBuildVersion();
  const { release } = useUpdateSignal();
  useEffect(() => { setBuildStale(stale); }, [stale]);
  const [hidden, setHidden] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [reloading, setReloading] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  if (!stale || hidden) return null;

  const summary = release ? summarizeCategories(release.counts) : '';
  const features = hasNewFeature(release?.counts);
  const dismiss = () => {
    if (leaving) return;
    if (prefersReducedMotion()) { setHidden(true); return; }
    setLeaving(true);
    timer.current = setTimeout(() => setHidden(true), LEAVE_FALLBACK_MS);
  };
  const onAnimationEnd = (e) => {
    if (leaving && e.target === e.currentTarget) { clearTimeout(timer.current); setHidden(true); }
  };
  const go = (navigate) => {
    setReloading(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setReloading(false), RELOAD_RECOVER_MS);
    navigate();
  };
  const reload = () => go(() => window.location.reload());
  // A full load (not in-app navigation): the new version, opened on What's New.
  const seeWhatsNew = () => go(() => window.location.assign('/whats-new'));

  // `.update-banner` (style.css): centered and sized to its text on desktop;
  // on a phone it spans the screen (12px gutters), the message on top and the
  // buttons sharing the row under it.
  return (
    <div role="status" onAnimationEnd={onAnimationEnd}
      className={`update-banner${features ? ' has-features' : ''}${leaving ? ' is-leaving' : ''}`}>
      {/* Keyed so the icon pops again when the answer arrives. */}
      <span key={summary ? 'known' : 'unknown'} className="update-banner-icon" aria-hidden="true">
        {features ? <Sparkles size={18} /> : <RefreshCw size={17} />}
      </span>
      <span className="update-banner-copy">
        <span className="update-banner-text">A New Version of Nexus Is Available</span>
        <span className="update-banner-sub">{summary ? `Including ${summary}.` : 'Reload when it suits you.'}</span>
      </span>
      {summary && (
        <button onClick={seeWhatsNew} disabled={reloading} className="update-banner-whatsnew">
          See What&apos;s New <ArrowRight size={14} className="update-banner-arrow" aria-hidden="true" />
        </button>
      )}
      <button onClick={reload} disabled={reloading} className={summary ? 'update-banner-reload update-banner-reload-quiet' : 'update-banner-reload'}>
        <RefreshCw size={13} className={reloading ? 'update-banner-spin' : undefined} aria-hidden="true" /> {reloading ? 'Reloading…' : 'Reload'}
      </button>
      <button onClick={dismiss} aria-label="Dismiss" className="update-banner-close">
        <X size={16} />
      </button>
    </div>
  );
}

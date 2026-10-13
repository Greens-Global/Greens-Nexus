import { RefreshCw, Sparkles, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useBuildVersion } from '../lib/useBuildVersion';
import { setBuildStale, useUpdateSignal } from '../lib/updateSignal';

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
export default function UpdateBanner() {
  const stale = useBuildVersion();
  const { newFeature } = useUpdateSignal();
  useEffect(() => { setBuildStale(stale); }, [stale]);
  const [hidden, setHidden] = useState(false);
  if (!stale || hidden) return null;

  // `.update-banner` (style.css): centered and sized to its text on desktop;
  // on a phone it spans the screen (12px gutters) so the message reads on one
  // or two lines instead of wrapping into a narrow column (Oct 3).
  return (
    <div role="status" className="update-banner">
      <span className="update-banner-text">
        {newFeature ? 'A new version of Nexus is available, with new features' : 'A new version of Nexus is available'}
      </span>
      {newFeature && (
        // A full load (not in-app navigation): the new version, opened on What's New.
        <button onClick={() => window.location.assign('/whats-new')} className="update-banner-whatsnew">
          <Sparkles size={13} /> See What&apos;s New
        </button>
      )}
      <button onClick={() => window.location.reload()} className={newFeature ? 'update-banner-reload update-banner-reload-quiet' : 'update-banner-reload'}>
        <RefreshCw size={13} /> Reload
      </button>
      <button onClick={() => setHidden(true)} aria-label="Dismiss" className="update-banner-close">
        <X size={16} />
      </button>
    </div>
  );
}

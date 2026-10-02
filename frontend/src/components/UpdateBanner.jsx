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

  // `.update-banner` (style.css): centered and sized to its text on desktop;
  // on a phone it spans the screen (12px gutters) so the message reads on one
  // or two lines instead of wrapping into a narrow column (Oct 3).
  return (
    <div role="status" className="update-banner">
      <span className="update-banner-text">A new version of Nexus is available</span>
      <button onClick={() => window.location.reload()} className="update-banner-reload">
        <RefreshCw size={13} /> Reload
      </button>
      <button onClick={() => setHidden(true)} aria-label="Dismiss" className="update-banner-close">
        <X size={16} />
      </button>
    </div>
  );
}

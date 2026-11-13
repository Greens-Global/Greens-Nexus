// Nexus as an installed app: what the app icon itself can do (the manifest's
// shortcuts and share_target, and the Badging API). Mounted once, signed in,
// inside the providers (App.jsx); draws nothing but the Share to Nexus sheet.
//
//   * App shortcuts - a long press or right click on the icon offers New
//     Task, New Ticket, Time Clock and Approvals. The last two are plain
//     addresses; the first two open the app at /?do=new-task|new-ticket
//     (lib/appLaunch.js) and run the SAME Quick Action the bolt runs
//     (lib/quickCreate.js runQuickAction) - never a form of their own. A
//     person who cannot use the action lands on the Dashboard.
//   * App badge - the bell's Needs Action count on the icon
//     (lib/appBadge.js; the count is lib/notificationCounts.js, the one rule).
//   * Share to Nexus - /?share=1 opens the sheet (ShareToNexus.jsx, loaded
//     only then). A share nobody came back to is removed after a day.
import { lazy, Suspense, useEffect, useState } from 'react';
import { peekLaunch, takeLaunch } from '../lib/appLaunch';
import { setAppBadge } from '../lib/appBadge';
import { useBellLists } from '../lib/notificationCounts';
import { runQuickAction } from '../lib/quickCreate';
import { sweepShare } from '../lib/shareTarget';
import { ModalLoading } from './AsyncState';

const ShareToNexus = lazy(() => import('./ShareToNexus'));

export default function InstalledApp() {
  // Left alone until the first fetch has landed (unread is null until then),
  // so a slow start never clears a count that is still true.
  const { actionable, unread } = useBellLists();
  const loaded = unread !== null;
  const waiting = actionable.length;
  useEffect(() => { if (loaded) setAppBadge(waiting); }, [loaded, waiting]);

  // The launch is read for the first paint and taken (once) after it.
  const [sharing, setSharing] = useState(() => !!peekLaunch()?.share);
  useEffect(() => {
    const launch = takeLaunch();
    if (launch?.share) return;
    sweepShare();
    if (launch?.action) runQuickAction(launch.action);
  }, []);

  if (!sharing) return null;
  return (
    <Suspense fallback={<ModalLoading />}>
      <ShareToNexus onClose={() => setSharing(false)} />
    </Suspense>
  );
}

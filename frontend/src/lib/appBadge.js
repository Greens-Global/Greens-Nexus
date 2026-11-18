// The count on the installed app's icon (the Badging API).
//
// The number is the bell's own "Needs Action" count - lib/notificationCounts.js
// (bellLists().actionable), the ONE rule the bell, the dashboard card and the
// tile already read. No request and no second count here: this only shows
// that number on the icon (components/InstalledApp.jsx keeps it in step),
// clears it at 0 and on sign out (lib/offline/read.js clearOfflineReadCache,
// the sign-out choke point). No imports, so anything may call it.
//
// Chrome and Edge (an installed app, Android and desktop) and Safari's Home
// Screen apps have the API; everywhere else every call is a no-op. A push
// does not move the badge: its payload is the notice only (title, body, url,
// tag - backend/push.py) and carries no count.
const nav = () => (typeof navigator !== 'undefined' ? navigator : null);

export const badgeSupported = () => typeof nav()?.setAppBadge === 'function';

/** Take the count off the icon. Never throws. */
export function clearAppBadge() {
  const n = nav();
  try {
    if (typeof n?.clearAppBadge === 'function') Promise.resolve(n.clearAppBadge()).catch(() => {});
    else if (typeof n?.setAppBadge === 'function') Promise.resolve(n.setAppBadge(0)).catch(() => {});
  } catch { /* not allowed here: no badge */ }
}

/** Show `count` on the icon; 0 (or anything that is not a positive number) clears it. Never throws. */
export function setAppBadge(count) {
  const n = nav();
  const value = Math.floor(Number(count));
  if (!(value > 0)) { clearAppBadge(); return; }
  try {
    if (typeof n?.setAppBadge === 'function') Promise.resolve(n.setAppBadge(value)).catch(() => {});
  } catch { /* not allowed here: no badge */ }
}

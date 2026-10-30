// Who may open Workforce Analytics (Neil, Oct 29 2026: it moved into Team,
// which everyone has - "make sure that only those who should have access to
// it have access so it doesn't become exposed to all").
//
// The ONE rule every door reads: Team's tab strip (views/Shifts.jsx), the
// phone menu and the header search (MobileMenu.jsx subsFor), and the module's
// own tabs (components/TimeTrackingAdmin.jsx MON_SUBTABS, per tab). It is the
// rule the left-menu item had: administrator and above, or an Access Group /
// job role grant on `employee-tracking` (the monitoring tabs) or
// `workforce-scorecard` (the Scorecard tab alone). A plain manager has
// neither. The server is the real lock: every endpoint behind these tabs
// checks the same grants (routers/timeclock.py require_tracking*,
// routers/workforce_scorecard.py scope_for) whatever the screen shows.
export const WORKFORCE_GRANTS = ['employee-tracking', 'workforce-scorecard'];

/** `role` is useRole(). */
export function canOpenWorkforceAnalytics(role) {
  return WORKFORCE_GRANTS.some((g) => !!role?.canAccessModule?.(g, 'administrator', 'viewer'));
}

/**
 * Its old view id (bells, the Monday Scorecard email, Insights drill-downs,
 * bookmarks, the guide) lands on Team > Workforce Analytics with the inner
 * tab kept; App.jsx applies it to every address and every navigate. Who may
 * see the tab is still Team's check above - anyone else gets Shifts.
 */
export function workforceRedirect(view, sub) {
  if (view !== 'employee-tracking') return null;
  return { view: 'shifts', sub: sub ? `analytics:${sub}` : 'analytics' };
}

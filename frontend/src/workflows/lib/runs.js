// What the Runs screen filters and pages by (Oct 28 2026). Pure, so the
// paging and the status vocabulary have tests of their own.

// A run's statuses (the Runs view) and a step's (the Actions view lists
// steps, which end done or failed).
export const RUN_STATUSES = ['running', 'waiting', 'succeeded', 'failed', 'skipped', 'cancelled', 'test'];
export const ACTION_STATUSES = ['done', 'failed'];
export const statusesFor = (kind) => (kind === 'actions' ? ACTION_STATUSES : RUN_STATUSES);

/** The calendar day (YYYY-MM-DD) an ISO stamp falls on, for the range. */
export const dayOf = (iso) => (iso ? String(iso).slice(0, 10) : '');

/** The cursor that starts paging at the end of the To day: the server pages
 *  by started_at, newest first, strictly before the cursor. */
export const beforeFor = (to) => (to ? `${to}T23:59:59.999Z` : null);

/** The rows of a page inside the From / To range. */
export const inRange = (rows, from, to) => (rows || []).filter((r) => {
  const d = dayOf(r.startedAt);
  if (from && d && d < from) return false;
  if (to && d && d > to) return false;
  return true;
});

/** The next cursor to offer: none once a page's oldest row is before From
 *  (every later page is older still). */
export const nextCursor = (page, serverNext, from) => {
  const oldest = page?.length ? dayOf(page[page.length - 1].startedAt) : '';
  if (from && oldest && oldest < from) return null;
  return serverNext || null;
};

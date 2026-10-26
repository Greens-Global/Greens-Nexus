// The decisions, kept free of Cloudflare and the network so they can be tested
// on their own: when a component counts as down, when it has recovered, and
// how a day of checks reads on the 90-day bar.

export const DOWN_AFTER = 3;      // failed checks in a row (one a minute) before "down"
export const RECOVER_AFTER = 2;   // good checks in a row before "recovered"

// What a single check can say. "unknown" = could not tell (e.g. the API is
// down, so Nexus cannot report on its database) - it never moves a state.
export const RANK = { operational: 0, unknown: 1, maintenance: 1, degraded: 2, down: 3 };

export function worst(statuses) {
  let out = 'operational';
  for (const s of statuses) if ((RANK[s] ?? 1) > (RANK[out] ?? 1)) out = s;
  return out;
}

/**
 * One component's state after one check.
 * prev: { status, failStreak, okStreak, since } (or null the first time)
 * observed: 'operational' | 'degraded' | 'down' | 'unknown'
 * Returns { state, event } - event is 'down', 'recovered' or null.
 */
export function nextState(prev, observed, nowIso) {
  // Never checked yet = unknown ("No Data"), not operational: a part that has
  // only ever answered "unknown" (not configured, API down) must not show green.
  const p = prev || { status: 'unknown', failStreak: 0, okStreak: 0, since: nowIso };
  if (observed === 'unknown') return { state: { ...p }, event: null };
  if (observed === 'down') {
    const failStreak = p.failStreak + 1;
    if (p.status !== 'down' && failStreak >= DOWN_AFTER) {
      return { state: { status: 'down', failStreak, okStreak: 0, since: nowIso }, event: 'down' };
    }
    return { state: { ...p, failStreak, okStreak: 0 }, event: null };
  }
  // operational or degraded
  const okStreak = p.okStreak + 1;
  if (p.status === 'down') {
    if (okStreak >= RECOVER_AFTER) {
      return { state: { status: observed, failStreak: 0, okStreak, since: nowIso }, event: 'recovered' };
    }
    return { state: { ...p, failStreak: 0, okStreak }, event: null };
  }
  const since = observed === p.status ? p.since : nowIso;
  return { state: { status: observed, failStreak: 0, okStreak, since }, event: null };
}

// A day on the 90-day bar, from that day's counts.
export const MAJOR_DOWN_CHECKS = 30;   // half an hour of failed minutes
export function dayStatus(row) {
  if (!row || !row.total) return 'nodata';
  if (row.down >= MAJOR_DOWN_CHECKS) return 'major';
  if (row.down > 0) return 'partial';
  if (row.degraded > 0) return 'degraded';
  return 'ok';
}

export function uptimePct(rows) {
  let total = 0;
  let down = 0;
  for (const r of rows) { total += r.total || 0; down += r.down || 0; }
  if (!total) return null;
  return Math.floor(((total - down) / total) * 10000) / 100;
}

// The company's day (Pacific), YYYY-MM-DD - the bar's days are Pacific days.
export const ZONE = 'America/Los_Angeles';
export function dayKey(date, zone = ZONE) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export function lastDays(n, now = new Date(), zone = ZONE) {
  const out = [];
  for (let i = n - 1; i >= 0; i -= 1) out.push(dayKey(new Date(now.getTime() - i * 86400000), zone));
  return [...new Set(out)];
}

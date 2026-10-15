// The live-shift arithmetic every punch tile shares (Oct 14). The Time Clock
// tile used to add "minutes since the last punch" to today's closed total -
// so after a break it dropped everything worked before the break, and it
// read 13h while My Time, on the same board, read 41m. Both now take the open
// shift from here. Pure, no imports: the Workday tiles' chunk can use it
// without pulling in the punch stack (gates, queue, geolocation).

// Server timestamps in the time clock are UTC without a zone marker.
const utc = (s) => new Date(/Z|[+-]\d\d:\d\d$/.test(s) ? s : s + 'Z');

// Walk every punch the status payload carries (last 7 days) and return the
// open shift, if any: when it was clocked in and the minutes worked so far
// (breaks excluded, an open break frozen). Null when nothing is open. A
// day's `workedMin` counts only CLOSED shifts (the server's _day_summaries),
// so the open one is rebuilt here from its punches.
export function openSession(days, last, now) {
  const all = Object.values(days || {}).flatMap(d => d?.punches || []).filter(p => p?.at && p.kind).sort((a, b) => a.at.localeCompare(b.at));
  if (!all.length) {
    // Older payload shape: elapsed from the last punch, paused on a break.
    if (!last?.at) return null;
    const inAt = utc(last.at);
    return { inAt, workedMin: last.kind === 'break_start' ? 0 : Math.max(0, Math.floor((now - inAt) / 60000)) };
  }
  let inAt = null, breakMs = 0, openBreak = null;
  for (const p of all) {
    if (p.kind === 'in') { inAt = utc(p.at); breakMs = 0; openBreak = null; }
    else if (p.kind === 'out') { inAt = null; breakMs = 0; openBreak = null; }
    else if (inAt && p.kind === 'break_start') openBreak = utc(p.at);
    else if (inAt && p.kind === 'break_end' && openBreak) { breakMs += utc(p.at) - openBreak; openBreak = null; }
  }
  if (!inAt) return null;
  const live = (now - inAt) - breakMs - (openBreak ? now - openBreak : 0);
  return { inAt, workedMin: Math.max(0, Math.floor(live / 60000)) };
}

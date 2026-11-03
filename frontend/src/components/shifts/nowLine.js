// The "now" marker on the Shifts planner (Neil, 11/02/2026; mock
// https://claude.ai/artifact/PwncxMck8YaSkFkQ8hmTHE section 4): today's
// column header in the live accent, and on a view with a time axis (the Day
// view's 24-hour track) a 2px line at the current time with a small
// "2:14 PM" label. Orange means "now" only - see "Live accent" in DESIGN.md.
//
// Time zone: the planner's times are the TEAM's wall clock ("Times in
// <team zone>" under the grid; a shift's 'HH:MM' are wall-clock strings), so
// EVERY today marker - the week grid's column, the month cell, the phone
// strip, the Shift Types header and the Day view's line - reads today from the
// team zone (plannerToday), so the marker and the line always agree. No team
// zone = the viewer's own clock.
import { useEffect, useState } from 'react';
import { zoneClock, formatHHMM } from '../../lib/datetime';

// A sticky header cell for today: the live tint over the card (opaque, so
// rows scrolling under it do not show through), a 2px live underline.
export const TODAY_HEAD = {
  background: 'linear-gradient(var(--wk-live-tint), var(--wk-live-tint)), var(--card)',
  boxShadow: 'inset 0 -2px 0 var(--wk-live)',
};
// The day label on today's header - the text-safe live ink.
export const TODAY_INK = 'var(--wk-live-ink)';
// Today's column cells: a faint live wash (the tint itself is the header's).
export const TODAY_CELL = 'color-mix(in srgb, var(--wk-live) 6%, transparent)';

const pad2 = (n) => String(n).padStart(2, '0');

// The planner's today (YYYY-MM-DD) - the team zone's date, else the viewer's.
export const plannerToday = (teamZone = '', now = new Date()) => zoneClock(teamZone, now).date;

// Where the now line sits on a 24-hour axis for `date` (YYYY-MM-DD) in
// `timeZone`: { minutes, frac (0..1 of the day), label "2:14 PM" }, or null
// when `date` is not today in that zone.
export function nowLineFor(date, timeZone, now = new Date()) {
  if (!date) return null;
  const c = zoneClock(timeZone, now);
  if (c.date !== date) return null;
  const minutes = Math.min(Math.max(c.minutes, 0), 1439);
  return {
    minutes,
    frac: minutes / 1440,
    label: formatHHMM(`${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`),
  };
}

// The current instant, refreshed on each minute boundary while `active`:
// one timeout to reach the next minute, then ONE interval, both cleared on
// unmount or when the view stops being today. Nothing animates - the line
// just moves - so reduced motion needs nothing more.
export function useMinuteNow(active = true) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!active) return undefined;
    let iv = null;
    const tick = () => setNow(new Date());
    tick();
    const t = setTimeout(() => { tick(); iv = setInterval(tick, 60000); }, 60000 - (Date.now() % 60000));
    return () => { clearTimeout(t); if (iv) clearInterval(iv); };
  }, [active]);
  return now;
}

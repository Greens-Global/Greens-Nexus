// What on a Time Sheet needs someone's attention (Neil, 11/04/2026, plan
// https://claude.ai/artifact/V1YPriqxVi3graoHsG3iMN, pick D1): one chip per
// KIND of problem, its days grouped on it ("Missing Out Thu, Fri"), worst
// first, so a busy card shows three chips and "+N More", never a wall.
// Reads the row model PayrollTimecard builds (rows of type day / line /
// auto / meal / req); the card attaches each chip's action.

export const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dayName = (ds) => WEEKDAY[new Date(`${ds}T00:00`).getDay()];

/** "Thu" / "Thu, Fri" / "3 Days" for the days a chip covers. */
export function daysText(refs) {
  const ds = [...new Set(refs.map(r => r.ds))];
  if (ds.length > 2) return `${ds.length} Days`;
  return ds.map(dayName).join(', ');
}

const pendingOn = (seg) => !!seg && ((seg.inEditStatus === 'pending' && seg.inPendingAt) || (seg.outEditStatus === 'pending' && seg.outPendingAt));

/**
 * rows      the card's row model
 * self      the employee's own card
 * isLive    (seg) => the shift is in progress right now (not missing its clock-out)
 * changed   [{ date, before, after }] - days changed since the hours were approved
 * mealsFor  show the meal check's flags (HR / managers only, never the employee)
 */
export function collectAttention(rows, { self = false, isLive = () => false, changed = [], mealsFor = true } = {}) {
  const kinds = {
    missing_out: { tone: 'bad', label: 'Missing Out', act: 'Fix', refs: [] },
    missing_in: { tone: 'bad', label: 'Missing In', act: 'Fix', refs: [] },
    break_open: { tone: 'bad', label: 'Break Not Ended', act: 'Fix', refs: [] },
    auto_out: { tone: 'bad', label: 'Auto Clock-Out', act: 'Fix', refs: [] },
    waiting: { tone: self ? 'info' : 'warn', label: '', act: 'Show', refs: [] },
    off_site: { tone: 'warn', label: 'Out of Location', act: 'Map', refs: [] },
    loc_off: { tone: 'warn', label: 'Location Off', act: 'Map', refs: [] },
    meal: { tone: 'warn', label: 'Meal Break', act: 'Show', refs: [] },
    changed: { tone: 'info', label: 'Changed Since Approval', act: 'Show', refs: [] },
  };
  for (const r of rows) {
    if (r.type === 'day' && r.seg) {
      // A row that starts where a break never ended is the break's problem
      // (Break Not Ended), not a second Missing In chip.
      if (!r.seg.in) { if (!r.fromBreak) kinds.missing_in.refs.push({ ds: r.ds, r }); }
      else if (!r.seg.out && !r.openAfter && !isLive(r.base || r.seg)) kinds.missing_out.refs.push({ ds: r.ds, r });
      if (pendingOn(r.seg)) kinds.waiting.refs.push({ ds: r.ds, r });
      if (r.segFirst) {
        const b = r.base || r.seg;
        if (b.geo === 'out_of_fence' || b.geoOut === 'out_of_fence') kinds.off_site.refs.push({ ds: r.ds, r });
        else if (b.geo === 'location_off' || b.geoOut === 'location_off') kinds.loc_off.refs.push({ ds: r.ds, r });
      }
    } else if (r.type === 'line') {
      if ((r.line === 'open' && !r.now) || (r.line === 'gap' && r.brk?.implicit)) kinds.break_open.refs.push({ ds: r.ds, r });
    } else if (r.type === 'auto') kinds.auto_out.refs.push({ ds: r.ds, r });
    else if (r.type === 'req') kinds.waiting.refs.push({ ds: r.ds, r });
    else if (r.type === 'meal' && mealsFor && r.d?.meal) kinds.meal.refs.push({ ds: r.ds, r });
  }
  (changed || []).forEach(c => kinds.changed.refs.push({ ds: c.date, change: c }));
  const n = kinds.waiting.refs.length;
  kinds.waiting.label = self ? `${n} Waiting on Your Approver` : `${n} Waiting on You`;
  const meal = kinds.meal.refs[0]?.r?.d?.meal;
  if (meal?.chip) kinds.meal.label = meal.chip;
  return Object.entries(kinds).filter(([, k]) => k.refs.length)
    .map(([kind, k]) => ({ kind, ...k, days: daysText(k.refs) }));
}

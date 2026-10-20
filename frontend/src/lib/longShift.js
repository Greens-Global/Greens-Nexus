// The AM / PM guard on typed punch times (Charmi, Oct 21 2026) - SwipeClock's
// "can't be more than 11 hours away from the first entry for this punch. Is it
// possible that AM/PM have been mis-entered?". The twin of backend/long_shift.py:
// keep the words the same. Works on datetime-local values ("YYYY-MM-DDTHH:mm")
// in one zone - every time a form compares is typed on the same clock.

export const LONG_SHIFT_MIN = 11 * 60;
const REACH_MIN = 24 * 60;

const ms = (v) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(v || '');
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : NaN;
};
const toInput = (t) => new Date(t).toISOString().slice(0, 16);
const t12 = (t) => {
  const d = new Date(t);
  const h = d.getUTCHours();
  return `${h % 12 || 12}:${String(d.getUTCMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};
const dayOf = (t) => Math.floor(t / 86400000);
const dur = (min) => {
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
};

// [first, last] of the shift a punch `kind` at `t` sits in, or null.
function span(others, kind, t) {
  const seq = [...others.map(o => ({ ...o, mine: false })), { kind, t, mine: true }]
    .sort((a, b) => a.t - b.t || (a.mine ? -1 : b.mine ? 1 : 0));
  const i = seq.findIndex(x => x.mine);
  let first = null, last = null;
  if (kind === 'in') first = t;
  else {
    for (let j = i - 1; j >= 0; j -= 1) {
      if ((t - seq[j].t) / 60000 > REACH_MIN || seq[j].kind === 'out') break;
      if (seq[j].kind === 'in') { first = seq[j].t; break; }
    }
  }
  if (kind === 'out') last = t;
  else {
    for (let j = i + 1; j < seq.length; j += 1) {
      if ((seq[j].t - t) / 60000 > REACH_MIN || seq[j].kind === 'in') break;
      if (seq[j].kind === 'out') { last = seq[j].t; break; }
    }
  }
  if (first === null) return null;
  if (last === null) { if (kind === 'in') return null; last = t; }
  if (last <= first) return null;
  return [first, last];
}

/**
 * null when fine, else { minutes, message, suggest, suggestText }.
 * `others`: the person's other punches as { kind, at } (datetime-local values),
 * `kind` / `at`: the punch being typed. `suggest` is a datetime-local value
 * (the AM / PM flip) when it makes a shift of 11 hours or less.
 */
export function checkLongShift(others, kind, at) {
  const t = ms(at);
  if (Number.isNaN(t)) return null;
  const rest = (others || []).map(o => ({ kind: o.kind, t: ms(o.at) })).filter(o => !Number.isNaN(o.t));
  const s = span(rest, kind, t);
  if (!s) return null;
  const minutes = Math.round((s[1] - s[0]) / 60000);
  if (minutes <= LONG_SHIFT_MIN) return null;
  const hour = new Date(t).getUTCHours();
  const flip = (hour < 12 ? 12 : -12) * 3600000;
  const cands = [t + flip];
  const anchor = kind !== 'in' ? s[0] : s[1];
  const shiftDays = dayOf(anchor) - dayOf(t);
  if (shiftDays) { const moved = t + shiftDays * 86400000; cands.push(moved + flip, moved); }
  let suggest = null;
  for (const c of cands) {
    const cs = span(rest, kind, c);
    if (cs && cs[1] - cs[0] > 0 && (cs[1] - cs[0]) / 60000 <= LONG_SHIFT_MIN) { suggest = c; break; }
  }
  const end = t12(s[1]) + (dayOf(s[1]) > dayOf(s[0]) ? ' the next day' : '');
  const suggestText = suggest !== null ? t12(suggest) : '';
  const message = `This makes the shift ${dur(minutes)} long (${t12(s[0])} to ${end}). `
    + (suggestText ? `Did you mean ${suggestText}? ` : '')
    + 'Check AM / PM. For a time after midnight, pick the next day.';
  return { minutes, message, suggest: suggest !== null ? toInput(suggest) : '', suggestText };
}

/** The issue among several typed punches ([{ kind, at }]), each judged
 *  against `others` plus the rest of the typed ones - the LATEST one whose
 *  AM / PM flip fixes it (the out, like SwipeClock's OUT check; 8:30 AM -
 *  9:40 PM reads as 9:40 AM, not 8:30 PM), else the first issue found.
 *  Adds `index` (which one to fix). */
export function checkTypedPunches(others, typed) {
  let found = null;
  for (let i = typed.length - 1; i >= 0; i -= 1) {
    const rest = [...(others || []), ...typed.filter((_, j) => j !== i)];
    const issue = checkLongShift(rest, typed[i].kind, typed[i].at);
    if (issue && issue.suggest) return { ...issue, index: i };
    if (issue && !found) found = { ...issue, index: i };
  }
  return found;
}

// Duplicate Day (Oct 27 2026): the words the modal and its tests share. Kept
// out of the component file so fast refresh keeps working there.
import { hm, nextDay } from './addTime';

/** Every YYYY-MM-DD from start to end, both included. */
export function periodDays(start, end) {
  const out = [];
  if (!start || !end || end < start) return out;
  for (let ds = start; ds <= end && out.length < 62; ds = nextDay(ds)) out.push(ds);
  return out;
}

/** The sentence a preview row says for a judged day. */
export function dupPlanText(r) {
  if (r.action === 'add') return `Add ${hm(r.minutes)}`;
  if (r.action === 'replace') return `Replace ${hm(r.existingMin)} with ${hm(r.minutes)}`;
  return `Skipped - ${r.reason || 'cannot take the day'}`;
}

/** What is being copied: "Copying 8:30a - 5:30p, break 12:00p - 12:30p, Sick Day". */
export function dupTemplateText(template, t12) {
  const shifts = (template || []).map((s) => {
    const at = (v) => { const [hhmm, plus] = String(v || '').split(' '); return `${t12(hhmm)}${plus ? ' (next day)' : ''}`; };
    const brk = (s.breaks || []).map(([a, b]) => `break ${at(a)} - ${at(b)}`);
    return [`${at(s.in)} - ${at(s.out)}`, ...brk, s.category || ''].filter(Boolean).join(', ');
  });
  return shifts.length ? `Copying ${shifts.join('; ')}` : 'Copying';
}

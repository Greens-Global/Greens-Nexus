// A punch time as the Time Sheet draws it (Neil, 11/04/2026: "I don't like it
// when AM and PM don't line up"): hours:minutes right-aligned in a box of
// one width, AM / PM in a box of its own (AM and PM differ in width), so a
// column of times lines up on both edges. A clock-out on the day after its
// shift carries a small "+1" that sits outside both boxes and moves nothing.
// Styles: the "Time Sheet grid" block in style.css (.ts-tm).
import { formatTimeTz, utcToInputTz } from '../../lib/displayTz';

/** "7:00am" (formatTimeTz) -> { hm: '7:00', ap: 'AM' }. */
export function timeParts(iso) {
  const s = formatTimeTz(iso);
  const m = /^(\d{1,2}:\d{2}(?::\d{2})?)\s*(am|pm)$/i.exec(s || '');
  return m ? { hm: m[1], ap: m[2].toUpperCase() } : { hm: s || '', ap: '' };
}

/** "7:00 AM" - the words a screen reader and a tooltip use. */
export const timeWords = (iso) => { const p = timeParts(iso); return p.ap ? `${p.hm} ${p.ap}` : p.hm; };

/** The punch lands on a later day than the row's date (an overnight shift). */
export function isNextDay(iso, ds) {
  if (!iso || !ds) return false;
  return utcToInputTz(iso).slice(0, 10) > ds;
}

export default function TimeText({ iso, day = '', className = '' }) {
  if (!iso) return null;
  const { hm, ap } = timeParts(iso);
  const next = isNextDay(iso, day);
  return (
    <span className={`ts-tm${className ? ` ${className}` : ''}`}>
      <b>{hm}</b><i>{'\u00a0'}{ap}</i>
      {next && <sup className="ts-next" title="The next day">+1</sup>}
    </span>
  );
}

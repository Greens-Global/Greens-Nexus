// Derives a warranty's term length (in whole months) from its start/expiration dates.
// Used by RecordModal to auto-populate the read-only "Term (Months, Auto)" field whenever
// either date changes, and again on save so the persisted value always matches the dates.

/** Whole months between `start` and `end` (calendar-aware, not just days/30). '' if either date is missing/invalid, or the range is negative. */
export function warrantyTermMonths(start, end) {
  if (!start || !end) return '';
  const s = new Date(start);
  const e = new Date(end);
  if (isNaN(s) || isNaN(e)) return '';
  let months = (e.getFullYear() - s.getFullYear()) * 12 + (e.getMonth() - s.getMonth());
  if (e.getDate() < s.getDate()) months--;
  return months < 0 ? '' : String(months);
}

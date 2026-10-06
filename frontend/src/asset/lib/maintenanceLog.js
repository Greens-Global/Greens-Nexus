// Maintenance Log helpers (Pranshu, 10/06): the log filter, its summary (spend
// kept per currency), and reading the Next Service Due / Repeats inputs.
import { formatDate } from '../../lib/datetime.js';
import { toNumber } from './format.js';
import { formatTotals } from './currency.js';

export const EMPTY_LOG_FILTER = { vendor: '', work: '', system: '', from: '', to: '' };

export function applyLogFilter(rows, f) {
  const work = (f.work || '').trim().toLowerCase();
  return rows.filter((r) => (!f.vendor || (r.vendor || '') === f.vendor)
    && (!f.system || (r.system || '') === f.system)
    && (!work || `${r.system || ''} ${r.description || ''} ${r.notes || ''}`.toLowerCase().includes(work))
    && (!f.from || (r.date || '') >= f.from)
    && (!f.to || (r.date || '') <= f.to));
}

/** Records / Last Service / Total Spend - spend per currency (hand-logged costs count as USD). */
export function logSummary(rows) {
  const dates = rows.map((r) => r.date).filter(Boolean).sort();
  const sums = {};
  rows.forEach((r) => {
    const cur = r.currency || 'USD';
    const amt = r.amount != null && r.amount !== '' ? Number(r.amount) : toNumber(r.cost);
    if (amt) sums[cur] = (sums[cur] || 0) + amt;
  });
  const spend = formatTotals(Object.entries(sums).map(([currency, amount]) => ({ currency, amount: amount.toFixed(2) })));
  return [['Records', String(rows.length)], ['Last Service', dates.length ? formatDate(dates[dates.length - 1]) : '-'], ['Total Spend', spend || '-']];
}

/** The schedule as the server takes it, or an error message. `every` may be "" while typing. */
export function readSchedule(value) {
  if (!value.nextDue) return value.unit ? { error: 'Pick the Next Service Due for a repeating service.' } : {};
  if (!value.unit) return { next_service_due: value.nextDue, recurrence_unit: '', recurrence_every: 1 };
  const every = Number(value.every);
  if (!Number.isInteger(every) || every < 1 || every > 52) return { error: 'Repeat every 1 to 52.' };
  return { next_service_due: value.nextDue, recurrence_unit: value.unit, recurrence_every: every };
}


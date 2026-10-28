// TEMPORARY stub - Task 12 (the module shell) owns the real file; take
// theirs at integration. Only `describeTrigger` is here, the one sentence
// the Templates gallery needs.
import { formatDate } from '../../lib/datetime';

const DAYS = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };

function clock(hhmm) {
  const [h, m] = String(hhmm || '08:00').split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return `${hour}:${String(m || 0).padStart(2, '0')} ${suffix}`;
}

export function describeTrigger(trigger, catalog) {
  if (!trigger) return 'No trigger yet';
  const entityLabel = (key) => (catalog?.entities || []).find((e) => e.key === key)?.label || key || 'record';
  if (trigger.kind === 'event') {
    const ev = (catalog?.events || []).find((e) => e.key === trigger.event);
    return `When ${(ev?.label || trigger.event || 'something happens').toLowerCase()}`;
  }
  if (trigger.kind === 'schedule') {
    const days = (trigger.days || []).map((d) => DAYS[d] || d).join(', ');
    const when = trigger.every === 'week' ? `every ${days || 'week'}` : trigger.every === 'month' ? 'every month' : 'every day';
    return `${when.charAt(0).toUpperCase()}${when.slice(1)} at ${clock(trigger.time)}`;
  }
  if (trigger.kind === 'date') {
    const n = Math.abs(trigger.offset_days || 0);
    const side = (trigger.offset_days || 0) < 0 ? 'before' : 'after';
    const field = trigger.field || 'date';
    return n ? `${n} days ${side} ${entityLabel(trigger.entity).toLowerCase()} ${field}` : `On ${entityLabel(trigger.entity).toLowerCase()} ${field}`;
  }
  if (trigger.kind === 'manual') return `Run by hand on a ${entityLabel(trigger.entity).toLowerCase()}`;
  return trigger.at ? `On ${formatDate(trigger.at)}` : 'When it is started';
}

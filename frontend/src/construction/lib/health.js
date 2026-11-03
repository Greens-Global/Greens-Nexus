// A job's health in words (Neil, 11/03/2026, plan item 15). The state and the
// facts are computed on the server (backend/construction_health.py - the ONE
// rule); this only says them: the label, and the short facts a manager acts on.
import { formatDate } from '../../lib/datetime';
import { TONE } from '../ui';

export const HEALTH = {
  late:     { label: 'Late',     color: TONE.red },
  at_risk:  { label: 'At Risk',  color: TONE.yellow },
  on_track: { label: 'On Track', color: TONE.green },
  complete: { label: 'Complete', color: TONE.blue },
};

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function daysWords(days) {
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days < 0) return `${plural(-days, 'day')} ago`;
  return `in ${plural(days, 'day')}`;
}

// "No log in 3 days" / "Last log today" / "No logs yet".
export function lastLogWords(h) {
  if (!h || !h.lastLogDate) return 'No logs yet';
  const d = h.daysSinceLog;
  if (d === 0) return 'Last log today';
  if (d === 1) return 'Last log yesterday';
  return `No log in ${plural(d, 'day')}`;
}

// The facts after the label, in the order they matter.
export function healthFacts(h) {
  if (!h) return [];
  const out = [];
  if (h.daysPastTarget > 0) out.push({ key: 'late', text: `${plural(h.daysPastTarget, 'day')} past target`, tone: 'bad' });
  if (h.nextMilestone) {
    out.push({ key: 'next', text: `${h.nextMilestone.name || 'Next milestone'} ${daysWords(h.nextMilestone.days)} (${formatDate(h.nextMilestone.targetDate, h.nextMilestone.targetDate)})` });
  }
  if (h.overdueRfis > 0) out.push({ key: 'rfis', text: `${plural(h.overdueRfis, 'RFI')} overdue`, tone: 'bad' });
  out.push({ key: 'log', text: lastLogWords(h), tone: h.daysSinceLog != null && h.daysSinceLog >= 3 ? 'warn' : undefined });
  return out;
}

// The progress track's state: done when complete, overdue (red) once past
// the target finish, otherwise still moving.
export function trackStateFor(project) {
  const h = project?.health;
  if ((project?.status === 'complete') || (project?.percentComplete || 0) >= 100) return 'done';
  if (h?.state === 'late') return 'overdue';
  if (project?.status === 'on_hold') return 'idle';
  return 'live';
}

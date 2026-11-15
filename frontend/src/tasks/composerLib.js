// Plain helpers for the phone New Task composer (QuickCreateTask.jsx,
// composerPickers.jsx, TaskCreate.jsx - 11/15/2026). Kept out of the
// component files so those export components only.
import { todayISO, addDays } from './lib';
import { formatDate, formatWeekday } from '../lib/datetime';

const dayOf = (iso) => new Date(`${iso}T00:00:00`).getDay();

/** What a due date reads as on a chip: Today, Tomorrow, else "Fri 11/20/2026". */
export function dueLabel(iso, today = todayISO()) {
  if (!iso) return '';
  if (iso === today) return 'Today';
  if (iso === addDays(today, 1)) return 'Tomorrow';
  return `${formatWeekday(iso, 'short')} ${formatDate(iso)}`;
}

/** The Due Date picker's quick choices, in order, never the same day twice. */
export function duePresets(today = todayISO()) {
  const dow = dayOf(today);
  const fridayIn = dow < 5 ? 5 - dow : 12 - dow;          // Sun-Thu: this week's; Fri/Sat: next week's
  const mondayIn = ((8 - dow) % 7) || 7;
  const out = [
    { label: 'Today', iso: today },
    { label: 'Tomorrow', iso: addDays(today, 1) },
    { label: dow < 5 ? 'This Friday' : 'Next Friday', iso: addDays(today, fridayIn) },
    { label: 'Next Monday', iso: addDays(today, mondayIn) },
  ];
  const seen = new Set();
  return out.filter((p) => (seen.has(p.iso) ? false : seen.add(p.iso)));
}

/** A description's words, one line per paragraph - what "Add a note" shows of a seeded (HTML) description. */
export function noteFromHtml(html) {
  const h = String(html || '').trim();
  if (!h) return '';
  if (typeof DOMParser === 'undefined' || !/<[a-z]/i.test(h)) return h;
  const doc = new DOMParser().parseFromString(h, 'text/html');
  doc.querySelectorAll('br').forEach((b) => b.replaceWith('\n'));
  doc.querySelectorAll('p, div, li, h1, h2, h3, h4, blockquote').forEach((b) => b.append('\n'));
  return (doc.body.textContent || '').replace(/\n{2,}/g, '\n').trim();
}

// The priority is not kept (Neil, 11/15/2026: "the same date, person and
// project") - an Urgent must not slide onto the next task unseen.
const DROP_ON_ANOTHER = ['title', 'description', 'files', 'suggestedProjectId', 'priority'];

/** What Add Another starts the next task with: the last task's date, people
 *  and project (Neil, 11/15/2026). The screen's own project stays locked; a project picked for
 *  the last task is only filled in (`suggestedProjectId`). */
export function carryDefaults(base = {}, carry = {}, lockedProjectId = '') {
  const rest = Object.fromEntries(Object.entries(base).filter(([k]) => !DROP_ON_ANOTHER.includes(k)));
  const locked = lockedProjectId || base.projectId || '';
  return {
    ...rest,
    dueOn: carry.dueOn || base.dueOn || '',
    assigneeIds: carry.assigneeIds?.length ? carry.assigneeIds : base.assigneeIds,
    ...(locked ? { projectId: locked } : { suggestedProjectId: carry.projectId || '' }),
  };
}

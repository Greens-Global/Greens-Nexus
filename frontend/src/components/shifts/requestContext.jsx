// What a time-off or shift request lands on (Oct 30 2026, from the old Team >
// Requests page; Approvals' Review panel since 11/04/2026): the person's
// shifts in the dates (or their usual hours when that week is not built yet,
// never as if scheduled), how many of their team are on each day, and who
// else is off - all from ONE GET /timeclock/schedule read for the dates.
import { formatDate, formatWeekday } from '../../lib/datetime';
import { shortTimeText, addDaysIso } from './shiftLib';

// Days from a to b (inclusive), at most `cap`.
export const daysOf = (a, b, cap = 14) => { const out = []; for (let d = a; d && d <= (b || a) && out.length < cap; d = addDaysIso(d, 1)) out.push(d); return out; };
const dayShort = (iso) => `${formatWeekday(iso, 'short')} ${formatDate(iso).slice(0, 5)}`;

// `email` = whose shifts and team; `skipId` = the shift being asked about
// (left out of "on that day"); `noMine` = a release (nobody takes it).
export function contextOf(sched, email, dates, skipId = '', noMine = false) {
  if (!sched || !email || !dates.length) return null;
  const em = email.toLowerCase();
  const inDates = new Set(dates);
  const mine = noMine ? [] : (sched.scheduled || []).filter((s) => (s.email || '').toLowerCase() === em && inDates.has(s.date) && !s.pendingDelete)
    .sort((a, b) => a.date.localeCompare(b.date) || String(a.start).localeCompare(String(b.start)));
  const team = (sched.groups || []).find((g) => !g.archived && (g.members || []).some((m) => String(m).toLowerCase() === em));
  const members = team ? (team.members || []).map((m) => String(m).toLowerCase()) : [];
  const built = (sched.scheduled || []).some((s) => inDates.has(s.date) && (!members.length || members.includes((s.email || '').toLowerCase())));
  const usualId = sched.usual?.[em] || '';
  const usual = !noMine && !mine.length && !built && usualId ? (sched.shifts || []).find((p) => p.id === usualId) : null;
  // The team on each day (the person themself not counted), and who else is off.
  const on = team ? dates.slice(0, 7).map((d) => {
    const people = new Set((sched.scheduled || []).filter((s) => s.date === d && !s.pendingDelete && s.id !== skipId && s.email && members.includes(s.email.toLowerCase()) && s.email.toLowerCase() !== em).map((s) => s.email.toLowerCase()));
    return { d, n: people.size, of: Math.max(0, members.length - 1) };
  }) : [];
  const off = [];
  (sched.timeoff || []).forEach((t) => {
    const who = (t.email || '').toLowerCase();
    if (who === em || (members.length && !members.includes(who)) || !['approved', 'pending'].includes(t.status)) return;
    if (dates.some((d) => d >= t.startDate && d <= (t.endDate || t.startDate)) && !off.some((o) => o.email === who)) off.push({ email: who, requested: t.status !== 'approved' });
  });
  return { mine, usual, team, on, off, noMine, more: Math.max(0, dates.length - 7) };
}

export function RequestContext({ ctx, nameOf }) {
  if (!ctx) return null;
  const { mine, usual, team, on, off, more, noMine } = ctx;
  const line = (label, body) => (
    <div style={{ display: 'flex', gap: 8, fontSize: 12.5, lineHeight: 1.45 }}>
      <span style={{ color: 'var(--muted)', minWidth: 96, flexShrink: 0 }}>{label}</span><span style={{ color: 'var(--ink)', minWidth: 0 }}>{body}</span>
    </div>
  );
  return (
    <div data-request-context="" style={{ display: 'grid', gap: 2, margin: '6px 0 2px' }}>
      {!noMine && line('Lands On', mine.length ? mine.map((s) => `${dayShort(s.date)} ${shortTimeText(s.start, s.end)}${s.code ? ` ${s.code}` : ''}`).join(', ')
        : usual ? <span>No shifts yet - usual hours {shortTimeText(usual.start, usual.end)}{usual.name ? ` (${usual.name})` : ''}; that week is not built</span>
          : <span style={{ color: 'var(--muted)' }}>No shifts in these dates</span>)}
      {team && on.length > 0 && line(`${team.name} On`, <span>{on.map((x) => `${on.length > 1 ? `${dayShort(x.d)} ` : ''}${x.n} of ${x.of}`).join(' · ')}{more ? ` · +${more} more days` : ''}</span>)}
      {line('Also Off', off.length ? off.map((o) => `${nameOf(o.email)}${o.requested ? ' (requested)' : ''}`).join(', ') : <span style={{ color: 'var(--muted)' }}>Nobody else{team ? ` on ${team.name}` : ''}</span>)}
    </div>
  );
}

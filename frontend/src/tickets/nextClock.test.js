import { describe, it, expect } from 'vitest';
import { nextClock } from './ticketMeta';

// The Next Clock cell (Tickets desk re-cut, 10/31/2026): whichever SLA clock
// bites next, in words - red only when overdue - with the exact deadline in
// the tooltip. Fixed `now` so the words never drift with the calendar.
const NOW = Date.parse('2026-10-31T17:00:00Z');
const hours = (h) => new Date(NOW + h * 3600 * 1000).toISOString();

const live = (extra = {}) => ({
  status: 'open', priority: 'medium', requesterId: 'req@example.com', assigneeId: 'agent@example.com',
  approvalStatus: 'none', ...extra,
});

describe('nextClock', () => {
  it('is empty once a ticket is resolved or closed', () => {
    for (const status of ['resolved', 'closed']) {
      const c = nextClock(live({ status, slaDueAt: hours(-5) }), NOW);
      expect(c).toMatchObject({ kind: 'none', state: 'none', label: '' });
      expect(c.at).toBe(Infinity);
    }
  });

  it('is empty when a ticket carries no deadline at all', () => {
    const c = nextClock(live(), NOW);
    expect(c.kind).toBe('none');
    expect(c.label).toBe('');
  });

  it('names the reply clock while no first response has gone out', () => {
    const c = nextClock(live({ firstResponseDueAt: hours(2), slaDueAt: hours(40) }), NOW);
    expect(c.kind).toBe('reply');
    expect(c.state).toBe('at_risk');          // medium first response = 24h; 2h left is inside the quarter
    expect(c.label).toBe('Reply due in 2h');
    expect(c.title).toMatch(/^First response due 10\/31\/2026 \d{1,2}:00 (AM|PM)$/);
    expect(c.at).toBe(Date.parse(hours(2)));
  });

  it('says how long the reply has been overdue', () => {
    const c = nextClock(live({ firstResponseDueAt: hours(-72), slaDueAt: hours(10) }), NOW);
    expect(c).toMatchObject({ kind: 'reply', state: 'overdue', label: 'Reply overdue 3d' });
  });

  it('moves on to the resolution clock once the desk has replied', () => {
    const c = nextClock(live({ firstResponseDueAt: hours(-72), firstResponseAt: hours(-70), slaDueAt: hours(-27 * 24) }), NOW);
    expect(c).toMatchObject({ kind: 'resolve', state: 'overdue', label: 'Overdue 27d' });
    expect(c.title).toMatch(/^Resolution due /);
  });

  it('a ticket the assignee raised for themselves has no reply clock', () => {
    const c = nextClock(live({ requesterId: 'agent@example.com', firstResponseDueAt: hours(-5), slaDueAt: hours(4 * 24) }), NOW);
    expect(c.kind).toBe('resolve');
    expect(c.label).toBe('Due in 4d');
    expect(c.state).toBe('ok');
  });

  it('counts a resolution clock down in words, then as a date past a week', () => {
    expect(nextClock(live({ slaDueAt: hours(5) }), NOW).label).toBe('Due in 5h');         // 72h target: 5h is inside the 18h quarter
    expect(nextClock(live({ slaDueAt: hours(5) }), NOW).state).toBe('at_risk');
    expect(nextClock(live({ slaDueAt: hours(0.5) }), NOW).label).toBe('Due in 30m');
    expect(nextClock(live({ slaDueAt: hours(30 * 24) }), NOW).label).toBe('Due 11/30/2026');
    expect(nextClock(live({ slaDueAt: hours(30 * 24) }), NOW).state).toBe('ok');
    expect(nextClock(live({ slaDueAt: hours(-3) }), NOW).label).toBe('Overdue 3h');
  });

  it('falls back to the old date-only deadline at the end of that day', () => {
    const c = nextClock(live({ slaDueOn: '2026-10-29' }), NOW);
    expect(c.kind).toBe('resolve');
    expect(c.state).toBe('overdue');
    expect(c.label).toMatch(/^Overdue [12]d$/);
    expect(c.title).toBe('Resolution due 10/29/2026');
  });

  it('reads Paused with the time since the pause, sorted after every live clock', () => {
    const paused = nextClock(live({ status: 'waiting_user', slaPaused: true, slaPausedAt: hours(-4 * 24), slaDueAt: hours(10) }), NOW);
    expect(paused).toMatchObject({ kind: 'paused', state: 'paused', label: 'Paused · 4d' });
    expect(paused.title).toMatch(/^Paused since 10\/27\/2026/);
    expect(paused.at).toBeGreaterThan(nextClock(live({ slaDueAt: hours(30 * 24) }), NOW).at);
    expect(paused.at).toBeLessThan(Infinity);
    // Awaiting approval pauses too; without a pause time the word stands alone.
    expect(nextClock(live({ approvalStatus: 'pending', slaDueAt: hours(10) }), NOW).label).toBe('Paused');
  });
});

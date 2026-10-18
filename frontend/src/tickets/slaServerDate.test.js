import { describe, it, expect, vi, afterEach } from 'vitest';
import { today, slaState } from './ticketMeta';

// The client's SLA day must be the one the server uses - the UTC date
// (_sla_breached in backend/routers/tickets.py compares sla_due_on with
// now_iso()[:10]). A local-day client disagreed with the server around
// midnight: Breached and an Escalate button the server refuses. Both move to
// datetimes together in a later PR.

afterEach(() => { vi.useRealTimers(); });

describe('SLA uses the server\'s UTC date', () => {
  it('today() is the UTC day', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 19, 2, 0)));   // 02:00 UTC Oct 19
    expect(today()).toBe('2026-10-19');
  });

  it('breached only once the UTC date is past the due date', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 18, 23, 30)));
    expect(slaState({ slaDueOn: '2026-10-18', status: 'open' })).toBe('at_risk');
    expect(slaState({ slaDueOn: '2026-10-17', status: 'open' })).toBe('breached');
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 19, 0, 30)));
    expect(slaState({ slaDueOn: '2026-10-18', status: 'open' })).toBe('breached');
  });
});

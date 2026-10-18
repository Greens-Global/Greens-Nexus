import { describe, it, expect, vi, afterEach } from 'vitest';
import { today, slaState } from './ticketMeta';
import { localIsoDate } from '../lib/datetime';

// The SLA "today" is the viewer's LOCAL day (Oct 2026 review). It was the UTC
// day, which on a US evening is already tomorrow - a ticket due today read as
// breached hours early.

afterEach(() => { vi.useRealTimers(); });

describe('SLA uses the local calendar day', () => {
  it('localIsoDate reads the local date, not the UTC one', () => {
    // 11:30 PM local on Oct 18 - for any zone west of UTC, already Oct 19 in UTC.
    const lateEvening = new Date(2026, 9, 18, 23, 30);
    expect(localIsoDate(lateEvening)).toBe('2026-10-18');
    expect(localIsoDate(lateEvening, 1)).toBe('2026-10-19');
    expect(localIsoDate(new Date(2026, 11, 31, 12), 1)).toBe('2027-01-01');
  });

  it('a ticket due today is not breached late in the evening', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 18, 23, 30));
    expect(today()).toBe('2026-10-18');
    expect(slaState({ slaDueOn: '2026-10-18', status: 'open' })).toBe('at_risk');
    expect(slaState({ slaDueOn: '2026-10-17', status: 'open' })).toBe('breached');
    expect(slaState({ slaDueOn: '2026-10-19', status: 'open' })).toBe('at_risk');
    expect(slaState({ slaDueOn: '2026-10-20', status: 'open' })).toBe('ok');
  });
});

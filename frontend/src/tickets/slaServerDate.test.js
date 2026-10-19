import { describe, it, expect, vi, afterEach } from 'vitest';
import { today, slaState, firstResponseState, fmtDueAt, slaMet, slaSortKey } from './ticketMeta';

// Honest SLA (Oct 2026): the client and the server agree on the deadline as a
// MOMENT. The server sends slaDueAt (ticket_sla.py - created + target hours +
// every completed pause) and decides a breach by it (_sla_breached in
// backend/routers/tickets.py); slaState reads the same instant, so the screen
// and the server never disagree around midnight or about a ticket filed at
// 9 AM. A row with no slaDueAt (older data) still compares its UTC date.

afterEach(() => { vi.useRealTimers(); });

const at = (iso) => { vi.useFakeTimers(); vi.setSystemTime(new Date(iso)); };

describe('SLA honest to the hour', () => {
  it('breaches the minute the deadline passes, not the next day', () => {
    const t = { slaDueAt: '2026-10-20T16:00:00+00:00', status: 'open', priority: 'urgent' };
    at('2026-10-20T15:59:00Z');
    expect(slaState(t)).toBe('at_risk');          // inside the last 6 h of an urgent ticket
    at('2026-10-20T16:01:00Z');
    expect(slaState(t)).toBe('breached');
  });

  it('is on track well before the at-risk window', () => {
    at('2026-10-19T17:00:00Z');
    expect(slaState({ slaDueAt: '2026-10-22T17:00:00+00:00', status: 'open', priority: 'medium' })).toBe('ok');
  });

  it('reads Paused while waiting on the requester, never breached', () => {
    at('2026-11-01T00:00:00Z');
    expect(slaState({ slaDueAt: '2026-10-20T16:00:00+00:00', status: 'waiting_user', slaPaused: true })).toBe('paused');
    expect(slaState({ slaDueAt: '2026-10-20T16:00:00+00:00', status: 'waiting' })).toBe('paused');
  });

  it('resolved and closed have no SLA state', () => {
    at('2026-11-01T00:00:00Z');
    expect(slaState({ slaDueAt: '2026-10-20T16:00:00+00:00', status: 'resolved', slaPaused: true })).toBe('none');
  });

  it('falls back to the UTC date for a row with no datetime', () => {
    at('2026-10-18T23:30:00Z');
    expect(today()).toBe('2026-10-18');
    expect(slaState({ slaDueOn: '2026-10-18', status: 'open' })).toBe('at_risk');
    expect(slaState({ slaDueOn: '2026-10-17', status: 'open' })).toBe('breached');
    at('2026-10-19T00:30:00Z');
    expect(slaState({ slaDueOn: '2026-10-18', status: 'open' })).toBe('breached');
    expect(slaState({ status: 'open' })).toBe('none');
  });

  it('shows the due date with its time, else the date', () => {
    expect(fmtDueAt({ slaDueAt: '2026-10-19T22:00:00+00:00' })).toMatch(/^10\/19\/2026 \d{1,2}:00 (AM|PM)$/);
    expect(fmtDueAt({ slaDueOn: '2026-10-19' })).toBe('10/19/2026');
    expect(fmtDueAt({})).toBe('-');
  });

  it('sorts by the deadline and judges SLA met to the minute', () => {
    expect(slaSortKey({ slaDueAt: '2026-10-19T22:00:00+00:00', slaDueOn: '2026-10-19' })).toBe('2026-10-19T22:00:00+00:00');
    expect(slaSortKey({ slaDueOn: '2026-10-19' })).toBe('2026-10-19');
    expect(slaMet({ slaDueAt: '2026-10-19T22:00:00+00:00', resolvedAt: '2026-10-19T21:59:00+00:00' })).toBe(true);
    expect(slaMet({ slaDueAt: '2026-10-19T22:00:00+00:00', resolvedAt: '2026-10-19T22:01:00+00:00' })).toBe(false);
    expect(slaMet({ slaDueOn: '2026-10-19', resolvedAt: '2026-10-19T23:00:00+00:00' })).toBe(true);
  });
});

describe('first response', () => {
  it('runs, goes overdue, pauses and stops', () => {
    const base = { firstResponseDueAt: '2026-10-19T20:00:00+00:00', status: 'open' };
    at('2026-10-19T19:00:00Z');
    expect(firstResponseState(base)).toBe('due');
    at('2026-10-19T20:01:00Z');
    expect(firstResponseState(base)).toBe('overdue');
    expect(firstResponseState({ ...base, status: 'waiting_user', slaPaused: true })).toBe('paused');
    expect(firstResponseState({ ...base, status: 'resolved' })).toBe('none');
    expect(firstResponseState({ ...base, firstResponseAt: '2026-10-19T19:30:00+00:00' })).toBe('responded');
    expect(firstResponseState({ status: 'open' })).toBe('none');
  });
});

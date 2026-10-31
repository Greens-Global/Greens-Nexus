import { describe, it, expect } from 'vitest';
import {
  QUEUES, DEFAULT_QUEUE, queueMatches, queueCounts, queueDefaultSort,
  queueFromLegacyScope, queueFromFilterEvent,
} from './queues';

// The desk's tabs are work queues (Neil, 10/31/2026): a filter preset each,
// counted over the whole workspace. These pin the predicates, the counts,
// the per-queue default sort and the two compatibility maps (old saved views
// and the dashboard / bell deep links).

const NOW = Date.parse('2026-10-31T12:00:00Z');
const ME = 'agent@example.com';
const ctx = { me: ME, onDesk: true, now: NOW };
const base = (over = {}) => ({
  id: 't', status: 'open', priority: 'medium', approvalStatus: 'none', requesterId: 'req@example.com',
  assigneeId: '', slaPaused: false, latestComment: null, ...over,
});

describe('queue list', () => {
  it('runs Needs Reply first and Raised by Me last, Needs Reply the default', () => {
    expect(QUEUES[0].key).toBe('needs_reply');
    expect(QUEUES[QUEUES.length - 1].key).toBe('raised');
    expect(DEFAULT_QUEUE).toBe('needs_reply');
    expect(QUEUES.map((q) => q.key)).toEqual(['needs_reply', 'unassigned', 'mine', 'due_soon', 'waiting', 'open', 'done', 'route', 'approve', 'raised']);
  });
  it('labels are Title Case and Unassigned carries the alarm tone', () => {
    for (const q of QUEUES) expect(q.label).toMatch(/^[A-Z]/);
    expect(QUEUES.find((q) => q.key === 'unassigned').tone).toBe('alarm');
    expect(QUEUES.find((q) => q.key === 'route')).toMatchObject({ hideWhenEmpty: true, onlyDesk: true });
    expect(QUEUES.find((q) => q.key === 'approve')).toMatchObject({ hideWhenEmpty: true });
  });
});

describe('needs_reply', () => {
  it('trusts the server flag when it is there', () => {
    expect(queueMatches('needs_reply', base({ needsReply: true }), ctx)).toBe(true);
    expect(queueMatches('needs_reply', base({ needsReply: false, firstResponseAt: '' }), ctx)).toBe(false);
  });
  it('falls back to the row when the flag is missing: no first response yet', () => {
    expect(queueMatches('needs_reply', base({ firstResponseAt: '' }), ctx)).toBe(true);
  });
  it('requester wrote last', () => {
    const t = base({ firstResponseAt: '2026-10-01T10:00:00', latestComment: { authorId: 'req@example.com' } });
    expect(queueMatches('needs_reply', t, ctx)).toBe(true);
  });
  it('desk wrote last', () => {
    const t = base({ firstResponseAt: '2026-10-01T10:00:00', latestComment: { authorId: ME } });
    expect(queueMatches('needs_reply', t, ctx)).toBe(false);
  });
  it('never a paused, approval-gated, closed, or self-filed-and-worked ticket', () => {
    expect(queueMatches('needs_reply', base({ slaPaused: true }), ctx)).toBe(false);
    expect(queueMatches('needs_reply', base({ status: 'waiting_user' }), ctx)).toBe(false);
    expect(queueMatches('needs_reply', base({ approvalStatus: 'pending' }), ctx)).toBe(false);
    expect(queueMatches('needs_reply', base({ status: 'resolved' }), ctx)).toBe(false);
    expect(queueMatches('needs_reply', base({ requesterId: ME, assigneeId: ME }), ctx)).toBe(false);
  });
});

describe('the other queues', () => {
  it('unassigned: live with nobody on it', () => {
    expect(queueMatches('unassigned', base(), ctx)).toBe(true);
    expect(queueMatches('unassigned', base({ assigneeId: ME }), ctx)).toBe(false);
    expect(queueMatches('unassigned', base({ status: 'closed' }), ctx)).toBe(false);
  });
  it('mine: live and assigned to me (any case)', () => {
    expect(queueMatches('mine', base({ assigneeId: 'Agent@Example.com' }), ctx)).toBe(true);
    expect(queueMatches('mine', base({ assigneeId: 'other@example.com' }), ctx)).toBe(false);
    expect(queueMatches('mine', base({ assigneeId: ME, status: 'resolved' }), ctx)).toBe(false);
  });
  it('due_soon: a breached or at-risk resolution clock, or an overdue / due first response', () => {
    // Every fixture hangs off ctx.now (10/31/2026 noon UTC), so the test
    // reads the same on any day: medium's 72h target makes the at-risk
    // window 18h.
    const at = (h) => new Date(NOW + h * 3600 * 1000).toISOString();
    const past = at(-24);
    const atRisk = at(5);
    const far = at(30 * 24);
    expect(queueMatches('due_soon', base({ slaDueAt: past }), ctx)).toBe(true);        // breached
    expect(queueMatches('due_soon', base({ slaDueAt: atRisk }), ctx)).toBe(true);      // inside the window
    expect(queueMatches('due_soon', base({ slaDueAt: at(20) }), ctx)).toBe(false);     // just outside it
    expect(queueMatches('due_soon', base({ slaDueAt: far }), ctx)).toBe(false);
    expect(queueMatches('due_soon', base({ slaDueAt: far, firstResponseDueAt: past }), ctx)).toBe(true);
    expect(queueMatches('due_soon', base({ slaDueAt: past, status: 'closed' }), ctx)).toBe(false);
    expect(queueMatches('due_soon', base({ slaDueAt: past, slaPaused: true }), ctx)).toBe(false);
    // The context's clock, not the machine's: the same row read a day later is breached.
    expect(queueMatches('due_soon', base({ slaDueAt: at(20) }), { ...ctx, now: NOW + 24 * 3600 * 1000 })).toBe(true);
  });
  it('waiting: the three parked statuses', () => {
    for (const s of ['waiting_user', 'waiting_vendor', 'on_hold']) expect(queueMatches('waiting', base({ status: s }), ctx)).toBe(true);
    expect(queueMatches('waiting', base({ status: 'in_progress' }), ctx)).toBe(false);
  });
  it('open is every live ticket, done the rest', () => {
    expect(queueMatches('open', base({ status: 'in_progress' }), ctx)).toBe(true);
    expect(queueMatches('open', base({ status: 'resolved' }), ctx)).toBe(false);
    expect(queueMatches('done', base({ status: 'resolved' }), ctx)).toBe(true);
    expect(queueMatches('done', base({ status: 'closed' }), ctx)).toBe(true);
    expect(queueMatches('done', base(), ctx)).toBe(false);
  });
  it('route is the desk\'s unrouted approvals; approve the ones parked on me', () => {
    const unrouted = base({ approvalStatus: 'pending', approverId: '' });
    expect(queueMatches('route', unrouted, ctx)).toBe(true);
    expect(queueMatches('route', unrouted, { ...ctx, onDesk: false })).toBe(false);
    expect(queueMatches('approve', base({ approvalStatus: 'pending', approverId: ME }), ctx)).toBe(true);
    expect(queueMatches('approve', base({ approvalStatus: 'pending', approverId: 'boss@example.com' }), ctx)).toBe(false);
    expect(queueMatches('approve', base({ approvalStatus: 'pending', approverId: '' }), { ...ctx, me: '' })).toBe(false);
  });
  it('raised: mine as requester, whatever the status', () => {
    expect(queueMatches('raised', base({ requesterId: ME, status: 'closed' }), ctx)).toBe(true);
    expect(queueMatches('raised', base(), ctx)).toBe(false);
  });
  it('an unknown key matches nothing', () => {
    expect(queueMatches('nope', base(), ctx)).toBe(false);
  });
});

describe('counts and sorts', () => {
  it('counts every queue over the whole list', () => {
    const list = [
      base({ id: 'a', needsReply: true }),
      base({ id: 'b', assigneeId: ME, needsReply: false, firstResponseAt: 'x' }),
      base({ id: 'c', status: 'resolved' }),
      base({ id: 'd', status: 'waiting_vendor', assigneeId: ME, needsReply: false }),
    ];
    const c = queueCounts(list, ctx);
    expect(c).toMatchObject({ needs_reply: 1, unassigned: 1, mine: 2, waiting: 1, open: 3, done: 1, raised: 0, route: 0, approve: 0 });
  });
  it('Needs Reply and Due Soon sort by the clock, everything else by Updated, newest first', () => {
    expect(queueDefaultSort('needs_reply')).toEqual({ key: 'clock', dir: 'asc' });
    expect(queueDefaultSort('due_soon')).toEqual({ key: 'clock', dir: 'asc' });
    expect(queueDefaultSort('open')).toEqual({ key: 'updated', dir: 'desc' });
    expect(queueDefaultSort('whatever')).toEqual({ key: 'updated', dir: 'desc' });
  });
});

describe('compatibility maps', () => {
  it('an old saved view\'s scope lands on a queue', () => {
    expect(queueFromLegacyScope('all')).toBe('open');
    expect(queueFromLegacyScope('mine')).toBe('raised');
    expect(queueFromLegacyScope('assigned')).toBe('mine');
    expect(queueFromLegacyScope('approve')).toBe('approve');
    expect(queueFromLegacyScope('route')).toBe('route');
    expect(queueFromLegacyScope(undefined)).toBe('open');
  });
  it('the dashboard / bell filters land on Unassigned and Mine', () => {
    expect(queueFromFilterEvent('unassigned')).toBe('unassigned');
    expect(queueFromFilterEvent('assigned')).toBe('mine');
    expect(queueFromFilterEvent('nope')).toBeNull();
  });
});

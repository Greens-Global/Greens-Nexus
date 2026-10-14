import { describe, it, expect } from 'vitest';
import {
  healthFlags, healthTone, inCollection, collectionsFor, filterCredentials, sortCredentials,
  parseSub, verifiedLabel, timeLeft, logMatches, rotationDaysLeft,
} from './vaultModel';

const me = 'olive@x.com';
const cred = (over = {}) => ({
  id: 'c1', name: 'Stripe', dept: 'Accounting', type: 'Password', tier: 'Standard', username: 'pay@x.com', url: '', note: '',
  owner: me, backupOwner: '', strength: 'strong', reused: false, rotatedDays: 10, rotationMax: 90,
  expiresInDays: null, access: 'owner', canReveal: true, canEdit: true, deletedAt: null, ...over,
});

describe('health', () => {
  it('is clean for a fresh strong password', () => {
    expect(healthFlags(cred())).toEqual([]);
    expect(healthTone(cred())).toBe('ok');
  });
  it('names what is wrong, worst first', () => {
    const flags = healthFlags(cred({ strength: 'weak', reused: true, rotatedDays: 95 }));
    expect(flags.map((f) => f.key)).toEqual(['weak', 'overdue', 'reused']);
    expect(healthTone(cred({ reused: true }))).toBe('warn');
    expect(healthTone(cred({ rotatedDays: 100 }))).toBe('bad');
  });
  it('warns ten days out and on the day', () => {
    expect(healthFlags(cred({ rotatedDays: 85 }))[0].label).toBe('Rotation Due in 5d');
    expect(healthFlags(cred({ rotatedDays: 90 }))[0].label).toBe('Rotation Due Today');
    expect(rotationDaysLeft(cred({ rotatedDays: 90 }))).toBe(0);
  });
  it('tracks a hard expiry', () => {
    expect(healthFlags(cred({ expiresInDays: 12 }))[0]).toMatchObject({ key: 'expiring', tone: 'warn' });
    expect(healthFlags(cred({ expiresInDays: -1 }))[0]).toMatchObject({ key: 'expired', tone: 'bad' });
  });
});

describe('collections', () => {
  const rows = [
    cred(), cred({ id: 'c2', name: 'Jira', dept: 'IT', owner: 'ben@x.com', access: 'shared', canEdit: false }),
    cred({ id: 'c3', name: 'Old', deletedAt: 1 }), cred({ id: 'c4', name: 'Weak', strength: 'weak', owner: 'ben@x.com', backupOwner: me }),
    cred({ id: 'c5', name: 'Hidden', owner: 'ben@x.com', access: 'request', canReveal: false, strength: 'weak' }),
  ];
  const ctx = { favorites: new Set(['c2']), myEmail: me };
  it('counts each group and lists departments that have credentials', () => {
    const cols = collectionsFor(rows, ctx);
    const byKey = Object.fromEntries(cols.map((c) => [c.key, c.count]));
    expect(byKey).toMatchObject({ all: 4, mine: 2, shared: 1, favorites: 1, attention: 1, 'dept:Accounting': 3, 'dept:IT': 1, trash: 1 });
    expect(cols.at(-1).key).toBe('trash');
  });
  it('needs attention only counts what you can actually open', () => {
    expect(inCollection(rows[4], 'attention', ctx)).toBe(false);
    expect(inCollection(rows[3], 'attention', ctx)).toBe(true);
  });
  it('filters by collection, type, tier and text', () => {
    expect(filterCredentials(rows, { collection: 'trash', ...ctx }).map((c) => c.name)).toEqual(['Old']);
    expect(filterCredentials(rows, { collection: 'all', query: 'jira', ...ctx }).map((c) => c.name)).toEqual(['Jira']);
    expect(filterCredentials(rows, { collection: 'all', query: 'ben@', ...ctx })).toHaveLength(3);
    expect(filterCredentials(rows, { collection: 'all', tier: 'Critical', ...ctx })).toEqual([]);
  });
  it('sorts by name, department, owner, rotation age and health', () => {
    const live = rows.filter((c) => !c.deletedAt);
    expect(sortCredentials(live, { col: 'name', dir: 'asc' })[0].name).toBe('Hidden');
    expect(sortCredentials(live, { col: 'name', dir: 'desc' })[0].name).toBe('Weak');
    expect(sortCredentials(live, { col: 'health', dir: 'asc' })[0].strength).toBe('weak');
    expect(sortCredentials(live, { col: 'dept', dir: 'asc' }).at(-1).dept).toBe('IT');
  });
});

describe('deep links and labels', () => {
  it('reads every kind of sub', () => {
    expect(parseSub('cred-abc')).toEqual({ tab: 'vault', credId: 'abc', collection: null });
    expect(parseSub('approvals').tab).toBe('approvals');
    expect(parseSub('personal').tab).toBe('personal');
    expect(parseSub('trash')).toEqual({ tab: 'vault', credId: null, collection: 'trash' });
    expect(parseSub('')).toEqual({ tab: null, credId: null, collection: null });
  });
  it('says until when the identity check holds, in 12-hour time', () => {
    const until = new Date(2026, 9, 14, 14, 45).getTime();
    expect(verifiedLabel(until, until - 60000)).toBe('Verified until 2:45 PM');
    expect(verifiedLabel(until, until + 1)).toBe('');
  });
  it('formats time left', () => {
    expect(timeLeft(3900000)).toBe('1h 05m');
    expect(timeLeft(272000)).toBe('04:32');
    expect(timeLeft(-5)).toBe('00:00');
  });
  it('filters the activity log', () => {
    const e = { actor: 'Olive', cred: 'Stripe', dept: 'Accounting', action: 'Revealed', ts: new Date(2026, 9, 10).getTime() };
    expect(logMatches(e, { query: 'stripe' })).toBe(true);
    expect(logMatches(e, { action: 'Edited' })).toBe(false);
    expect(logMatches(e, { from: '2026-10-11' })).toBe(false);
    expect(logMatches(e, { to: '2026-10-10' })).toBe(true);
  });
});

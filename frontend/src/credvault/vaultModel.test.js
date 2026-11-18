import { describe, it, expect } from 'vitest';
import {
  healthFlags, healthTone, inCollection, sortCredentials, sentenceCounts, listLogins, matchesQuery, flagWords, rotationRows,
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
  it('needs attention only counts what you can actually open', () => {
    expect(inCollection(rows[4], 'attention', ctx)).toBe(false);
    expect(inCollection(rows[3], 'attention', ctx)).toBe(true);
  });
  it('the sentence counts each phrase over what the API returned', () => {
    expect(sentenceCounts(rows, me)).toEqual({ open: 3, mine: 2, shared: 1, attention: 1, nobackup: 2, locked: 1, trash: 1 });
  });
  it('search is the filter: every word typed is found somewhere on the login', () => {
    const nameOf = (e) => ({ 'ben@x.com': 'Ben Builder' }[e] || e);
    const names = (query, view = 'all') => listLogins(rows, { view, query, myEmail: me, nameOf }).sections.flatMap((s) => s.rows.map((c) => c.name));
    expect(names('jira')).toEqual(['Jira']);
    expect(names('ben builder')).toEqual(['Jira', 'Weak']);                 // the owner's name, not just the email
    expect(names('accounting weak')).toEqual(['Weak']);                     // department AND state
    expect(names('it password')).toEqual(['Jira']);                         // department AND type
    expect(names('critical')).toEqual([]);                                  // tier
    expect(matchesQuery({ ...rows[0], companyName: 'Greens Storage', siteName: 'Austin', tier: 'Critical' }, 'austin greens critical')).toBe(true);
    expect(listLogins(rows, { view: 'trash', myEmail: me }).sections[0].rows.map((c) => c.name)).toEqual(['Old']);
    // What I cannot open follows the search and never mixes with what I can.
    expect(listLogins(rows, { query: 'hidden', myEmail: me }).locked.map((c) => c.name)).toEqual(['Hidden']);
    expect(names('hidden')).toEqual([]);
  });
  it('reads Favorites, Recently Used, All with nothing typed - one flat list otherwise', () => {
    const g = listLogins(rows, { favorites: new Set(['c2']), recents: ['c4', 'c2', 'zzz'], myEmail: me });
    expect(g.sections.map((s) => [s.title, s.rows.map((c) => c.id)])).toEqual([['Favorites', ['c2']], ['Recently Used', ['c4']], ['All', ['c1']]]);
    expect(g.flat).toBe(false);
    expect(listLogins(rows, { myEmail: me }).sections.map((s) => s.title)).toEqual(['']);          // nothing starred or used: no headings
    const mine = listLogins(rows, { view: 'mine', favorites: new Set(['c2']), myEmail: me });
    expect(mine.flat).toBe(true);
    expect(mine.sections[0].rows.map((c) => c.name)).toEqual(['Stripe', 'Weak']);
    expect(listLogins(rows, { view: 'attention', myEmail: me }).sections[0].rows.map((c) => c.name)).toEqual(['Weak']);
    expect(listLogins(rows, { view: 'nobackup', myEmail: me }).sections[0].rows.map((c) => c.name)).toEqual(['Hidden', 'Stripe']);   // whatever I manage, openable or not
    expect(listLogins(rows, { view: 'shared', myEmail: me }).sections[0].rows.map((c) => c.name)).toEqual(['Jira']);
    expect(listLogins(rows, { sort: 'owner', myEmail: me }).flat).toBe(true);
  });
  it('a state reads as words, and the audit file lists what rotates next', () => {
    const late = cred({ rotatedDays: 102 });
    expect(healthFlags(late).map((f) => flagWords(f, late))).toEqual(['rotation 12 days overdue']);
    const soon = cred({ rotatedDays: 89, expiresInDays: 0 });
    expect(healthFlags(soon).map((f) => flagWords(f, soon))).toEqual(['rotation due in 1 day', 'expires today']);
    const out = rotationRows([cred({ name: 'Fresh', rotatedDays: 5 }), late, cred({ name: 'Hidden', rotatedDays: 200, canReveal: false })]);
    expect(out.map((r) => [r.Name, r['Days Left']])).toEqual([['Stripe', -12], ['Fresh', 85]]);
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
    expect(parseSub('new')).toEqual({ tab: 'vault', credId: null, collection: null, create: true });   // the header's Create menu
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

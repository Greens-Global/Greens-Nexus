import { describe, it, expect } from 'vitest';
import { guessMap, applyMap, validateRows, findDuplicates, toPayload } from './importModel';

describe('import wizard model', () => {
  it('guesses the mapping from the headers people actually use', () => {
    const m = guessMap(['Website', 'Login ID', 'Pwd', 'Team', 'Comments', 'Service']);
    expect(m).toEqual({ name: 5, username: 1, secret: 2, url: 0, dept: 3, note: 4 });
    expect(guessMap(['Site Name', 'E-mail', 'Password', 'Login URL'])).toEqual({ name: 0, username: 1, secret: 2, url: 3 });
    expect(guessMap(['a', 'b'])).toEqual({});
  });
  it('turns sheet rows into credential rows, fixes links and flags what is missing', () => {
    const rows = applyMap([['GoDaddy', 'dns', 'Secr3t!', 'dcc.godaddy.com', 'IT', '', 'password', 'high'], ['', '', '', '', '', '', '', ''], ['Zoom', '', 'zoom123', 'not a link', '', '', '', '']],
      { name: 0, username: 1, secret: 2, url: 3, dept: 4, type: 6, tier: 7 });
    expect(rows).toHaveLength(2);
    const v = validateRows(rows, { defaultDept: 'IT' });
    expect(v[0]).toMatchObject({ ok: true, url: 'https://dcc.godaddy.com', tier: 'High', type: 'Password', dept: 'IT' });
    expect(v[1]).toMatchObject({ ok: false, problems: ['link is not a web address'], dept: 'IT' });
    expect(validateRows([{ name: '', secret: '', url: '', dept: '' }])[0].problems).toEqual(['no name', 'no password', 'no department']);
  });
  it('spots what the vault already holds, by name and username or by site and username', () => {
    const existing = [{ id: 'c1', name: 'GoDaddy DNS', username: 'dns', url: 'https://dcc.godaddy.com' }, { id: 'c2', name: 'Old', username: 'x', deletedAt: 1 }];
    const out = findDuplicates([{ name: 'godaddy dns', username: 'DNS', url: '' }, { name: 'DNS Portal', username: 'dns', url: 'https://www.dcc.godaddy.com/login' }, { name: 'Old', username: 'x', url: '' }], existing);
    expect(out[0].duplicateOf).toEqual({ id: 'c1', name: 'GoDaddy DNS' });
    expect(out[1].duplicateOf).toEqual({ id: 'c1', name: 'GoDaddy DNS' });
    expect(out[2].duplicateOf).toBeUndefined();                                   // trashed rows do not count
  });
  it('builds the server row with the department audience, or everyone at the company', () => {
    const r = { name: 'Wi-Fi', dept: 'IT', type: 'Password', username: 'staff', secret: 's', tier: 'Standard', url: '', note: '' };
    expect(toPayload(r, { backupOwner: 'b@x.com' })).toMatchObject({ department: 'IT', backupOwner: 'b@x.com', audiences: [{ kind: 'department', value: 'IT', level: 'open' }] });
    expect(toPayload(r, { everyone: true, companyId: 'co' }).audiences).toEqual([{ kind: 'company', value: 'co', level: 'open' }]);
  });
});

// Credentials - My Logins (Oct 29 2026): what the everyday list shows and does.
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import MyLogins from './MyLogins';
import { groupLogins, healthByDept, auditRows, siteOf, noteRecent } from './vaultModel';

const row = (over) => ({ id: 'c1', name: 'Wi-Fi', dept: 'IT', type: 'Password', tier: 'Standard', username: 'staff', url: '', owner: 'o@x.com', backupOwner: '',
  access: 'department', canReveal: true, canEdit: false, strength: 'strong', reused: false, rotatedDays: 10, rotationMax: 90, expiresInDays: null, sharedWith: 1, audiences: [], ...over });
const ROWS = [
  row(),
  row({ id: 'c2', name: 'GoDaddy', url: 'https://dcc.godaddy.com/x', username: 'dns', rotatedDays: 100 }),
  row({ id: 'c3', name: 'Intacct', dept: 'Accounting', access: 'shared', grantUntil: Date.now() + 3600000 }),
  row({ id: 'c4', name: 'Chase', dept: 'Accounting', tier: 'Critical', access: 'request', canReveal: false, username: '' }),
  row({ id: 'c5', name: 'Ramp', dept: 'Accounting', access: 'view', canReveal: false, username: 'ap@x.com' }),
];

describe('groupLogins', () => {
  it('puts favorites first, then recents, then the rest by department, and folds what I cannot open', () => {
    const g = groupLogins(ROWS, { favorites: new Set(['c3']), recents: ['c2', 'c3', 'zzz'] });
    expect(g.favorites.map((c) => c.id)).toEqual(['c3']);
    expect(g.recent.map((c) => c.id)).toEqual(['c2']);                      // c3 already shown, zzz unknown
    expect(g.byDept.map((d) => [d.dept, d.rows.map((c) => c.id)])).toEqual([['IT', ['c1']]]);
    expect(g.locked.map((c) => c.id)).toEqual(['c4', 'c5']);
    expect(g.total).toBe(3);
    expect(groupLogins(ROWS, { query: 'godaddy' }).byDept[0].rows.map((c) => c.id)).toEqual(['c2']);
  });
  it('helpers: site host, recents list, health by department, audit rows without passwords', () => {
    expect(siteOf('https://www.chase.com/business')).toBe('chase.com');
    expect(siteOf('')).toBe('');
    expect(noteRecent('b', ['a', 'b', 'c'])).toEqual(['b', 'a', 'c']);
    const h = healthByDept(ROWS);
    expect(h.find((x) => x.dept === 'IT')).toMatchObject({ total: 2, overdue: 1, noBackup: 2 });
    expect(h.find((x) => x.dept === 'Accounting')).toMatchObject({ total: 3, critical: 1 });
    const a = auditRows(ROWS, (e) => e.split('@')[0]);
    expect(a[0]).toMatchObject({ Name: 'Wi-Fi', Owner: 'o', 'Who Can Open': 'Everyone in IT', Health: 'Healthy' });
    expect(Object.keys(a[0]).some((k) => /secret/i.test(k))).toBe(false);   // the Type column says Password; no value ever is one
    expect(JSON.stringify(a)).not.toMatch(/Corr3ct|secret_enc/);
  });
});

describe('MyLogins', () => {
  const props = () => ({
    rows: ROWS, depts: ['IT', 'Accounting'], favorites: new Set(['c3']), recents: ['c2'], query: '', onQuery: vi.fn(), selectedId: null, now: Date.now(),
    nameOf: (e) => e, done: '', clipLeft: 0, onOpen: vi.fn(), onToggleFavorite: vi.fn(), onCopyUser: vi.fn(), onCopyPassword: vi.fn(), onOpenSite: vi.fn(), onRequest: vi.fn(),
  });
  it('shows sections with row actions, and the folded Not Shared list with Request Access', () => {
    const p = props();
    render(<MyLogins {...p} />);
    expect(screen.getByText('Favorites')).toBeTruthy();
    expect(screen.getByText('Recently Used')).toBeTruthy();
    expect(screen.getByText('IT')).toBeTruthy();
    expect(screen.getByText('1 needs attention')).toBeTruthy();                // GoDaddy is overdue
    expect(screen.getByText('Shared with you: 1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Copy password for Wi-Fi' }));
    expect(p.onCopyPassword).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy username for Wi-Fi' }));
    expect(p.onCopyUser).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }));
    expect(screen.queryByRole('button', { name: 'Open Wi-Fi' })).toBeNull();     // no link
    fireEvent.click(screen.getByRole('button', { name: 'Open GoDaddy' }));
    expect(p.onOpenSite).toHaveBeenCalledWith(expect.objectContaining({ id: 'c2' }));
    // Locked rows are folded; opening them offers Request Access and no copy buttons.
    expect(screen.queryByText('Chase')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Not shared with you/ }));
    const chase = within(document.querySelector('[data-login="c4"]'));
    fireEvent.click(chase.getByRole('button', { name: 'Request access to Chase' }));
    expect(p.onRequest).toHaveBeenCalledWith(expect.objectContaining({ id: 'c4' }));
    expect(chase.queryByRole('button', { name: /Copy password/ })).toBeNull();
    expect(screen.getByText(/ap@x.com/)).toBeTruthy();                           // view only still shows the username
    fireEvent.click(screen.getByRole('button', { name: 'Wi-Fi details' }));
    expect(p.onOpen).toHaveBeenCalledWith('c1');
  });
  it('says so when nothing can be opened, and shows the clipboard countdown', () => {
    const { rerender } = render(<MyLogins {...props()} rows={[ROWS[3]]} />);
    expect(screen.getByText('Nothing you can open yet')).toBeTruthy();
    rerender(<MyLogins {...props()} clipLeft={12} />);
    expect(screen.getByText('Clipboard clears in 12s')).toBeTruthy();
  });
});

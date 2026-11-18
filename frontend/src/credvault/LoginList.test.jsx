// Passwords - the one list (Neil, 11/18/2026): what a row shows and does.
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import LoginList from './LoginList';
import { healthByDept, auditRows, siteOf, noteRecent } from './vaultModel';

const row = (over) => ({ id: 'c1', name: 'Wi-Fi', dept: 'IT', type: 'Password', tier: 'Standard', username: 'staff', url: '', owner: 'o@x.com', backupOwner: '',
  access: 'department', canReveal: true, canEdit: false, strength: 'strong', reused: false, rotatedDays: 10, rotationMax: 90, expiresInDays: null, sharedWith: 1, audiences: [], ...over });
const ROWS = [
  row(),
  row({ id: 'c2', name: 'GoDaddy', url: 'https://dcc.godaddy.com/x', username: 'dns', rotatedDays: 100, hasTotp: true }),
  row({ id: 'c3', name: 'Intacct', dept: 'Accounting', access: 'shared', grantUntil: Date.now() + 3600000 }),
  row({ id: 'c4', name: 'Chase', dept: 'Accounting', tier: 'Critical', access: 'request', canReveal: false, username: '' }),
  row({ id: 'c5', name: 'Ramp', dept: 'Accounting', access: 'view', canReveal: false, username: 'ap@x.com' }),
];

describe('helpers', () => {
  it('site host, recents list, health by department, audit rows without passwords', () => {
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

describe('LoginList', () => {
  const props = () => ({
    rows: ROWS, depts: ['IT', 'Accounting'], favorites: new Set(['c3']), recents: ['c2'], query: '', onQuery: vi.fn(), view: 'all', onView: vi.fn(), sort: 'name', onSort: vi.fn(),
    selectedId: null, now: Date.now(), nameOf: (e) => e, myEmail: 'me@x.com', done: '', clipLeft: 0, autoFocus: false,
    onOpen: vi.fn(), onCopyUser: vi.fn(), onCopyPassword: vi.fn(), onOpenSite: vi.fn(), onCopyCode: vi.fn(), onRequest: vi.fn(),
  });
  it('reads Favorites, Recently Used, All; one leading button a row; the rest on the row too', () => {
    const p = props();
    render(<LoginList {...p} />);
    expect([...document.querySelectorAll('.cv-sec')].map((h) => h.textContent)).toEqual(['Favorites', 'Recently Used', 'All']);
    expect(document.querySelector('[data-sentence]').textContent).toBe('3 you can open - 1 shared with you - 1 needs attention');
    // No site: the row's one button copies the password.
    const wifi = within(document.querySelector('[data-login="c1"]'));
    expect(wifi.getByRole('button', { name: 'Copy password for Wi-Fi' }).textContent).toMatch(/Copy$/);
    fireEvent.click(wifi.getByRole('button', { name: 'Copy password for Wi-Fi' }));
    expect(p.onCopyPassword).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }));
    fireEvent.click(wifi.getByRole('button', { name: 'Copy username for Wi-Fi' }));
    expect(p.onCopyUser).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }));
    expect(wifi.queryByRole('button', { name: 'Open Wi-Fi' })).toBeNull();
    // A site: Open leads; User, Password and Code are the quiet extras.
    const dns = within(document.querySelector('[data-login="c2"]'));
    expect(dns.getAllByRole('button').slice(1).map((b) => [b.textContent.trim(), b.className.includes('is-x')])).toEqual([['User', true], ['Password', true], ['Code', true], ['Open', false]]);
    fireEvent.click(dns.getByRole('button', { name: 'Open GoDaddy' }));
    expect(p.onOpenSite).toHaveBeenCalledWith(expect.objectContaining({ id: 'c2' }));
    fireEvent.click(dns.getByRole('button', { name: 'Copy code for GoDaddy' }));
    expect(p.onCopyCode).toHaveBeenCalledWith(expect.objectContaining({ id: 'c2' }));
    expect(dns.getByText('rotation 10 days overdue').className).toContain('tone-bad');
    expect(within(document.querySelector('[data-login="c3"]')).getByText(/shared with you, .* left/)).toBeTruthy();
    // What I cannot open is folded; opened, it offers Request Access and no copy buttons.
    expect(screen.queryByText('Chase')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Not shared with you/ }));
    const chase = within(document.querySelector('[data-login="c4"]'));
    fireEvent.click(chase.getByRole('button', { name: 'Request access to Chase' }));
    expect(p.onRequest).toHaveBeenCalledWith(expect.objectContaining({ id: 'c4' }));
    expect(chase.queryByRole('button', { name: /Copy password/ })).toBeNull();
    expect(screen.getByText(/ap@x.com/)).toBeTruthy();                           // view only still shows the username
    fireEvent.click(screen.getByRole('button', { name: 'Wi-Fi details' }));
    expect(p.onOpen).toHaveBeenCalledWith('c1');
    fireEvent.click(screen.getByRole('button', { name: '1 needs attention' }));
    expect(p.onView).toHaveBeenCalledWith('attention');
  });
  it('says so when nothing can be opened, shows the clipboard countdown and the sort in force', () => {
    const { rerender } = render(<LoginList {...props()} rows={[]} />);
    expect(screen.getByText('Nothing you can open yet')).toBeTruthy();
    rerender(<LoginList {...props()} clipLeft={12} verified="Verified until 3:40 PM" sort="rotated" />);
    expect(screen.getByText('Clipboard clears in 12s')).toBeTruthy();
    expect(screen.getByText('Verified until 3:40 PM')).toBeTruthy();
    expect(screen.getByText(/sorted by oldest rotation/)).toBeTruthy();
    expect(document.querySelectorAll('.cv-sec')).toHaveLength(0);                // a sorted list is flat
  });
  it('Select Several puts a box on what I may edit and a line to move them to the trash', () => {
    const p = { ...props(), rows: [row({ canEdit: true }), ROWS[1]], selecting: true, checked: new Set(['c1']), onCheck: vi.fn(), onTrashChecked: vi.fn(), onDoneSelecting: vi.fn() };
    render(<LoginList {...p} />);
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);                     // GoDaddy is not mine to edit
    expect(document.querySelector('[data-selecting]').textContent).toMatch(/^1 selected/);
    fireEvent.click(screen.getByRole('button', { name: /Move to Trash/ }));
    expect(p.onTrashChecked).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(p.onDoneSelecting).toHaveBeenCalled();
  });
});

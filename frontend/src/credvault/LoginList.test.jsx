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
  // The register (11/25/2026): a row's facts are cells of their own, so a computer lines them up as columns.
  it('a row carries its facts as cells; the heading row sorts with the same sorts as "..."', () => {
    const p = props();
    render(<LoginList {...p} rows={[...ROWS, row({ id: 'c6', name: 'Mine', owner: 'ME@x.com', siteName: 'Kyle', strength: 'weak' })]} />);
    const cell = (id, k) => document.querySelector(`[data-login="${id}"] .cv-c-${k}`);
    expect(['user', 'dept', 'owner', 'state'].map((k) => cell('c2', k).textContent)).toEqual(['dns', 'IT', 'o@x.com', 'rotation 10 days overdue']);
    expect(cell('c6', 'owner').textContent).toBe('You');                         // your own login says so, whatever the email's case
    expect(cell('c6', 'dept').textContent).toBe('IT - Kyle');
    expect(cell('c6', 'state').querySelector('.tone-bad').textContent).toBe('weak password');
    fireEvent.click(document.querySelector('.cv-fold'));                          // the rows I cannot open are folded
    expect(cell('c1', 'owner').className).toContain('cv-wide');                  // a narrow row does not repeat the owner...
    expect(cell('c4', 'owner').className).not.toContain('cv-wide');              // ...except where you have to ask them
    expect(cell('c4', 'owner').textContent).toBe('owned by o@x.com');
    expect(cell('c4', 'state').textContent).toBe('Critical - Request Access');
    // a narrow row reads as one line: a separator only between facts that are there
    expect(document.querySelector('[data-login="c4"] .cv-l-cells').textContent).toBe('Accounting - owned by o@x.com - Critical - Request Access');
    const head = within(document.querySelector('[data-head]'));
    expect(head.getAllByRole('button').map((b) => b.textContent)).toEqual(['Login', 'Department', 'Owner', 'Status']);
    fireEvent.click(head.getByRole('button', { name: 'Owner' }));
    expect(p.onSort).toHaveBeenCalledWith('owner');
    fireEvent.click(head.getByRole('button', { name: 'Login' }));                 // the sort in force, pressed again, stays by name
    expect(p.onSort).toHaveBeenLastCalledWith('name');
  });

  // The views on the left (11/26/2026): the sentence's phrases as a standing list, then the departments.
  it('the rail lists the views and the departments; a department narrows the list and a view takes its place', () => {
    const p = props();
    render(<LoginList {...p}><button type="button">Personal Section</button></LoginList>);
    const rail = within(document.querySelector('[data-rail]'));
    const login = (id) => document.querySelector(`[data-login="${id}"]`);
    expect(rail.getAllByRole('button').map((b) => b.textContent)).toEqual(
      ['All Logins3', 'Mine0', 'Shared With Me1', 'Needs Attention1', 'No Backup Owner0', 'Accounting1', 'IT2']);
    expect(rail.getByRole('button', { name: /All Logins/ }).getAttribute('aria-current')).toBe('true');
    expect(document.querySelector('[data-title]').textContent).toBe('All Logins - 3 logins');
    expect(screen.getByRole('button', { name: 'Personal Section' })).toBeTruthy();
    fireEvent.click(rail.getByRole('button', { name: /Accounting/ }));
    expect(login('c1')).toBeNull();
    expect(login('c3')).toBeTruthy();
    expect(document.querySelector('[data-title]').textContent).toBe('Accounting - 1 login');
    expect(rail.getByRole('button', { name: /Accounting/ }).getAttribute('aria-current')).toBe('true');
    expect(rail.getByRole('button', { name: /All Logins/ }).getAttribute('aria-current')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Personal Section' })).toBeNull();   // a narrowed list is company logins only
    fireEvent.click(rail.getByRole('button', { name: /Needs Attention/ }));          // a view takes the department's place
    expect(p.onView).toHaveBeenCalledWith('attention');
    expect(login('c1')).toBeTruthy();
  });

  // Personal is a button beside the title on a computer (11/26/2026): it shows that section alone.
  it('the Personal button shows the Personal section alone, and a view brings the company logins back', () => {
    const p = { ...props(), onPersonal: vi.fn() };
    render(<LoginList {...p}><button type="button">Personal Section</button></LoginList>);
    const off = () => [...document.querySelectorAll('.cv-company')].every((el) => el.className.includes('is-off'));
    const btn = screen.getByRole('button', { name: 'Personal' });
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(off()).toBe(false);
    fireEvent.click(btn);
    expect(p.onPersonal).toHaveBeenCalledTimes(1);                                   // the section unlocks first when it has to
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(off()).toBe(true);
    expect(document.querySelector('.cv-personal-slot').className).toContain('is-on');
    expect(document.querySelector('[data-title]').textContent).toBe('Personal - private to you');
    expect(document.querySelector('[data-rail] [aria-current]')).toBeNull();
    fireEvent.click(within(document.querySelector('[data-rail]')).getByRole('button', { name: /All Logins/ }));
    expect(off()).toBe(false);
    expect(btn.getAttribute('aria-pressed')).toBe('false');
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

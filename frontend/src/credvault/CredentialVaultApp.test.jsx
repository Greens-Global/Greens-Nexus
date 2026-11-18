import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Render smoke for Passwords, the one list (Neil, 11/18/2026): what the API
// lets me open with copy on the row, a row I cannot open folded with Request
// Access, the sentence as the menu, the login as a sheet, and everything the
// five old tabs did still reachable - Personal (a section), the collections
// (the sentence's phrases), Trash / Activity / the audit export / bulk trash
// (the "..." menu), requests to approve (Dashboard > Approvals; a guest's
// own sheet), and every old deep link.

const calls = {
  cvCredentials: vi.fn(), cvRequests: vi.fn(), cvLogs: vi.fn(), cvOtpStatus: vi.fn(), cvAccess: vi.fn(),
  cvReveal: vi.fn(), cvRequest: vi.fn(), cvApproveRequest: vi.fn(), cvDenyRequest: vi.fn(), cvCopied: vi.fn(),
  getProjectDepartments: vi.fn(), getPeopleDirectory: vi.fn(), cvPersonal: vi.fn(),
};
vi.mock('../api', () => ({ api: new Proxy({}, { get: (_t, k) => (...a) => (calls[k] ? calls[k](...a) : Promise.resolve({})) }) }));
vi.mock('../contexts/RoleContext', () => ({
  useRole: () => ({ myEmail: 'olive@x.com', can: () => false, canAccessModule: () => true }),
}));
vi.mock('../lib/useNameResolver', () => ({ useNameResolver: () => (e) => ({ 'olive@x.com': 'Olive Owner', 'ben@x.com': 'Ben Builder' }[e] || e) }));
vi.mock('../components/ModuleTabs', () => ({ default: () => null, ModuleActions: ({ children }) => children }));
const exportAudit = vi.hoisted(() => vi.fn());
vi.mock('./auditExport', () => ({ exportAudit }));

const { default: CredentialVaultApp } = await import('./CredentialVaultApp');
const { DialogHost } = await import('../ui/dialog');

const mine = { id: 'c1', name: 'Stripe', dept: 'Accounting', type: 'Password', tier: 'Standard', username: 'pay@x.com', url: 'https://stripe.com', note: 'Finance login',
  owner: 'olive@x.com', backupOwner: '', strength: 'strong', reused: false, rotatedAt: '2026-10-01T00:00:00+00:00', rotatedDays: 13, rotationMax: 90, customExpiry: false,
  expiresAt: '', expiresInDays: null, hasPrevious: false, sharedWith: 1, deletedAt: null, createdAt: 1, access: 'owner', canReveal: true, canEdit: true, grantUntil: null, audiences: [] };
const theirs = { ...mine, id: 'c2', name: 'Jira Admin', dept: 'IT', username: '', note: '', owner: 'ben@x.com', access: 'request', canReveal: false, canEdit: false };
const row = (id) => document.querySelector(`[data-login="${id}"]`);

beforeEach(() => {
  Object.values(calls).forEach((f) => f.mockReset());
  calls.cvCredentials.mockResolvedValue([mine, theirs]);
  calls.cvRequests.mockResolvedValue([{ id: 'r1', credId: 'c1', cred: 'Stripe', dept: 'Accounting', requestedBy: 'Ben Builder', requestedByEmail: 'ben@x.com', sharedToEmail: 'ben@x.com', duration: '4 Hours', ts: Date.now() - 60000 }]);
  calls.cvLogs.mockResolvedValue([{ id: 'l1', actor: 'Olive Owner', actorEmail: 'olive@x.com', action: 'Created', cred: 'Stripe', credId: 'c1', dept: 'Accounting', detail: null, ts: Date.now() - 3600000 }]);
  calls.cvOtpStatus.mockResolvedValue({ verified: true, until: Date.now() + 600000, windowSec: 900 });
  calls.cvAccess.mockResolvedValue({ owner: 'olive@x.com', backupOwner: '', dept: 'Accounting', tier: 'Standard', grants: [], pending: [], heads: [], audiences: [] });
  calls.cvReveal.mockResolvedValue({ secret: 'Corr3ct-Horse!' });
  calls.cvCopied.mockResolvedValue({ ok: true });
  calls.cvRequest.mockResolvedValue({ requested: true });
  calls.getProjectDepartments.mockResolvedValue([{ name: 'Accounting' }, { name: 'IT' }]);
  calls.getPeopleDirectory.mockResolvedValue([{ email: 'olive@x.com', name: 'Olive Owner' }, { email: 'ben@x.com', name: 'Ben Builder' }]);
  calls.cvPersonal.mockResolvedValue([]);
  try { localStorage.clear(); } catch { /* none */ }
});

const more = async (name) => {
  fireEvent.click(screen.getByRole('button', { name: 'More' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: new RegExp(name) }));
};
const sentence = () => document.querySelector('[data-sentence]');

describe('Passwords', () => {
  const ready = async () => { await waitFor(() => expect(row('c1')).toBeTruthy()); };

  it('is one list: no tabs, no tiles, the sentence on top and everyone lands on it', async () => {
    render(<CredentialVaultApp />);
    await ready();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(document.querySelector('.cv-kpi, .cv-chip, .cv-health')).toBeNull();
    // Olive owns Stripe (no backup owner); Ben asks for it; Jira is not hers to open.
    expect(sentence().textContent).toBe('1 you can open - 1 yours - 1 has no backup owner - 1 request waiting');
    expect(screen.getByText(/Verified until/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Personal/ })).toBeTruthy();               // folded and locked, in the same list
  });

  it('copies from the row, never shows the password, and opens the login as a sheet', async () => {
    const writeText = vi.fn().mockResolvedValue();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<CredentialVaultApp />);
    await ready();
    expect(row('c2')).toBeNull();                                                      // folded: not mine to open
    expect(screen.getByRole('button', { name: /Not shared with you/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Copy password for Stripe' }));
    await waitFor(() => expect(calls.cvReveal).toHaveBeenCalledWith('c1'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('Corr3ct-Horse!'));
    expect(calls.cvCopied).toHaveBeenCalledWith('c1');
    expect(await screen.findByText(/Clipboard clears in/)).toBeTruthy();
    expect(screen.queryByText('Corr3ct-Horse!')).toBeNull();                          // copied, never shown
    fireEvent.click(screen.getByRole('button', { name: 'Stripe details' }));
    const dlg = await screen.findByRole('dialog', { name: 'Stripe' });
    expect(within(dlg).getByText('pay@x.com')).toBeTruthy();
    expect(within(dlg).getByText('Finance login')).toBeTruthy();
    fireEvent.click(within(dlg).getByRole('button', { name: 'Reveal Password' }));
    expect(await within(dlg).findByText('Corr3ct-Horse!')).toBeTruthy();
    expect(within(dlg).getByRole('button', { name: 'Edit' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Stripe' })).toBeNull());
    // Recently Used remembers the copy.
    expect(screen.getByText('Recently Used')).toBeTruthy();
  });

  it('my own department\'s login copies without the code; another department\'s asks for it (11/13/2026)', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn().mockResolvedValue() }, configurable: true });
    calls.cvOtpStatus.mockResolvedValue({ verified: false, until: null, windowSec: 900 });
    calls.cvCredentials.mockResolvedValue([{ ...mine, homeDept: true }, { ...mine, id: 'c3', name: 'Payroll', dept: 'HR', homeDept: false }]);
    render(<CredentialVaultApp />);
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Copy password for Stripe' }));
    await waitFor(() => expect(calls.cvReveal).toHaveBeenCalledWith('c1'));
    expect(screen.queryByText('Verify Your Identity')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Copy password for Payroll' }));
    expect(await screen.findByText('Verify Your Identity')).toBeTruthy();
    expect(calls.cvReveal).not.toHaveBeenCalledWith('c3');
  });

  it('a row I cannot open sits folded, hides the username and asks instead of revealing', async () => {
    render(<CredentialVaultApp />);
    await ready();
    fireEvent.click(screen.getByRole('button', { name: /Not shared with you/ }));
    expect(within(row('c2')).queryByRole('button', { name: /Copy password/ })).toBeNull();
    fireEvent.click(within(row('c2')).getByRole('button', { name: 'Request access to Jira Admin' }));
    const modal = await screen.findByText('Send Request');
    fireEvent.click(modal);
    await waitFor(() => expect(calls.cvRequest).toHaveBeenCalledWith('c2', { durationMs: 14400000, durationLabel: '4 Hours' }));
    expect(await screen.findByText(/Asked Ben Builder for Jira Admin/)).toBeTruthy();
    fireEvent.click(within(row('c2')).getByRole('button', { name: 'Jira Admin details' }));
    const dlg = await screen.findByRole('dialog', { name: 'Jira Admin' });
    expect(within(dlg).queryByRole('button', { name: 'Reveal Password' })).toBeNull();
    expect(within(dlg).queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('search is the filter, and it finds what I cannot open too', async () => {
    render(<CredentialVaultApp />);
    await ready();
    const box = screen.getByRole('textbox', { name: 'Search logins' });
    fireEvent.change(box, { target: { value: 'accounting olive' } });                  // department AND the owner's name
    expect(row('c1')).toBeTruthy();
    fireEvent.change(box, { target: { value: 'jira' } });
    expect(row('c1')).toBeNull();
    expect(row('c2')).toBeTruthy();                                                   // the fold opens for a search
    fireEvent.keyDown(box, { key: 'Enter' });                                         // Enter opens the first result
    expect(await screen.findByRole('dialog', { name: 'Jira Admin' })).toBeTruthy();
  });

  it('the sentence is the menu: a phrase filters the list and a second click clears it', async () => {
    calls.cvCredentials.mockResolvedValue([mine, { ...mine, id: 'c4', name: 'Bank', owner: 'ben@x.com', backupOwner: 'ben@x.com', access: 'department', canEdit: false, rotatedDays: 120 }, theirs]);
    render(<CredentialVaultApp />);
    await ready();
    expect(sentence().textContent).toBe('2 you can open - 1 yours - 1 needs attention - 1 has no backup owner - 1 request waiting');
    expect(within(row('c4')).getByText('rotation 30 days overdue').className).toContain('tone-bad');   // a state is words on the row
    fireEvent.click(screen.getByRole('button', { name: '1 needs attention' }));
    expect(row('c1')).toBeNull();
    expect(row('c4')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Personal/ })).toBeNull();            // a filtered list is company logins only
    fireEvent.click(screen.getByRole('button', { name: '1 needs attention' }));
    expect(row('c1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '1 yours' }));
    expect(row('c4')).toBeNull();
    expect(row('c1')).toBeTruthy();
  });

  it('a request to approve points at Dashboard > Approvals, where it is decided now', async () => {
    const heard = [];
    const h = (e) => heard.push(e.detail);
    window.addEventListener('nexus:navigate', h);
    try {
      render(<CredentialVaultApp />);
      await ready();
      fireEvent.click(screen.getByRole('button', { name: '1 request waiting' }));
      expect(heard).toEqual([{ view: 'dashboard', sub: 'approvals:access' }]);
      expect(screen.queryByRole('dialog', { name: 'Requests' })).toBeNull();
    } finally { window.removeEventListener('nexus:navigate', h); }
  });

  it('an outside guest has no Dashboard: the same request is decided in their own Requests sheet', async () => {
    render(<CredentialVaultApp standalone />);
    await ready();
    fireEvent.click(screen.getByRole('button', { name: '1 request waiting' }));
    const dlg = await screen.findByRole('dialog', { name: 'Requests' });
    expect(within(dlg).getByText('Ben Builder', { selector: 'strong' }).closest('p').textContent).toMatch(/asks for 4 hours of access/);
    calls.cvApproveRequest.mockResolvedValue({ ok: true });
    fireEvent.click(within(dlg).getByRole('button', { name: /Approve/ }));
    await waitFor(() => expect(calls.cvApproveRequest).toHaveBeenCalledWith('r1'));
  });

  it('"..." holds Activity, Trash, the audit export, bulk trash and the sorts', async () => {
    calls.cvCredentials.mockResolvedValue([mine, { ...mine, id: 'c9', name: 'Old Portal', deletedAt: '2026-11-01T00:00:00Z', deletedBy: 'ben@x.com' }, theirs]);
    calls.cvBulkDelete = vi.fn().mockResolvedValue({ ok: true });
    render(<><DialogHost /><CredentialVaultApp /></>);
    await ready();
    expect(row('c9')).toBeNull();                                                      // the trash is not on the list
    await more('Activity');
    const act = await screen.findByRole('dialog', { name: 'Activity' });
    expect(within(act).getByText('Created', { selector: 'span' })).toBeTruthy();
    fireEvent.click(within(act).getByRole('button', { name: /Olive Owner/ }));          // a row opens its login
    expect(await screen.findByRole('dialog', { name: 'Stripe' })).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Activity' })).toBeNull();
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Stripe' })).getByRole('button', { name: 'Close' }));
    await more('Trash');
    expect(row('c9')).toBeTruthy();
    expect(row('c1')).toBeNull();
    expect(sentence().textContent).toMatch(/^Trash - 1 login/);
    fireEvent.click(screen.getByRole('button', { name: 'Back to All' }));
    await more('Export for an Audit');
    expect(exportAudit).toHaveBeenCalledTimes(1);
    expect(exportAudit.mock.calls[0][0].map((c) => c.id)).toEqual(['c1']);            // what she manages: not Ben's Jira, not the trash
    await more('Select Several');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Stripe' }));
    fireEvent.click(screen.getByRole('button', { name: /Move to Trash/ }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Move to Trash' }));
    await waitFor(() => expect(calls.cvBulkDelete).toHaveBeenCalledWith(['c1']));
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect((await screen.findAllByRole('menuitemradio')).map((r) => [r.textContent, r.getAttribute('aria-checked')]))
      .toEqual([['Sort by Name', 'true'], ['Sort by Department', 'false'], ['Sort by Owner', 'false'], ['Sort by Oldest Rotation', 'false'], ['Sort by Needs Attention First', 'false']]);
  });

  it('"+ New" starts a company login, a personal one or an import; Personal unlocks first', async () => {
    render(<CredentialVaultApp />);
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'New' }));
    expect((await screen.findAllByRole('menuitem')).map((m) => m.querySelector('.nx-new-label').textContent)).toEqual(['Login', 'Personal Login', 'Import From a Spreadsheet...']);
    fireEvent.click(screen.getByRole('menuitem', { name: /Personal Login/ }));
    expect(await screen.findByText(/Personal Vault/, { selector: 'h3' })).toBeTruthy();   // the unlock comes first
  });

  it('every old deep link still lands: a login, a collection, the trash, Activity', async () => {
    const { rerender } = render(<CredentialVaultApp activeSub="cred-c2" />);
    expect(await screen.findByRole('dialog', { name: 'Jira Admin' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    rerender(<CredentialVaultApp activeSub="nobackup" />);
    expect(screen.getByRole('button', { name: '1 has no backup owner' }).getAttribute('aria-pressed')).toBe('true');
    rerender(<CredentialVaultApp activeSub="trash" />);
    expect(sentence().textContent).toMatch(/^Trash/);
    rerender(<CredentialVaultApp activeSub="activity" />);
    expect(await screen.findByRole('dialog', { name: 'Activity' })).toBeTruthy();
    // A repeat click on a bell arrives as an event while the address does not change.
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Activity' })).getByRole('button', { name: 'Close' }));
    window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'dashboard', sub: 'passwords:cred-c1' } }));
    expect(await screen.findByRole('dialog', { name: 'Stripe' })).toBeTruthy();
  });

  it('on a phone it is the same list and the login opens as the same sheet', async () => {
    const real = window.matchMedia;
    window.matchMedia = (q) => ({ matches: /max-width: 900px/.test(q), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
    try {
      render(<CredentialVaultApp />);
      await ready();
      expect(document.activeElement).not.toBe(screen.getByRole('textbox', { name: 'Search logins' }));   // no keyboard popping up on arrival
      fireEvent.click(screen.getByRole('button', { name: 'Stripe details' }));
      const dlg = await screen.findByRole('dialog', { name: 'Stripe' });
      expect(within(dlg).getByText('pay@x.com')).toBeTruthy();
      fireEvent.keyDown(window, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Stripe' })).toBeNull());
    } finally { window.matchMedia = real; }
  });
});

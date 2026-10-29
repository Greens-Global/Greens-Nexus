import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Render smoke for Credentials (Oct 29 2026 tabs): My Logins lists what the
// API lets me open and copies from the row, a row I cannot open sits folded
// with Request Access, Approvals shows what is waiting, Overview carries the
// numbers and the full list, and the deep link "cred-<id>" opens the drawer.

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
vi.mock('../components/ModuleTabs', () => ({
  default: ({ tabs, active, onChange }) => (
    <div role="tablist">{tabs.map((t) => <button key={t.key} role="tab" aria-selected={active === t.key} onClick={() => onChange(t.key)}>{t.label}{t.badge ? ` (${t.badge})` : ''}</button>)}</div>
  ),
}));

const { default: CredentialVaultApp } = await import('./CredentialVaultApp');

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

describe('Credentials', () => {
  // An owner lands on Overview (Pranshu, Oct 29 2026); the list is one tab away.
  const toLogins = async () => { fireEvent.click(await screen.findByRole('tab', { name: 'My Logins' })); await waitFor(() => expect(row('c1')).toBeTruthy()); };

  it('an owner lands on Overview first, with My Logins next to it', async () => {
    render(<CredentialVaultApp />);
    expect(await screen.findByText('No Backup Owner', { selector: '.cv-kpi-label' })).toBeTruthy();
    expect(within(screen.getAllByRole('tablist')[0]).getAllByRole('tab').map((t) => t.textContent)).toEqual(['Overview', 'My Logins', 'Personal', 'Approvals (1)', 'Activity']);
  });

  it('My Logins: what I can open, copy from the row, the drawer on a click', async () => {
    const writeText = vi.fn().mockResolvedValue();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<CredentialVaultApp />);
    await toLogins();
    expect(screen.getByText(/Verified until/)).toBeTruthy();
    expect(screen.getByText('Copy from the row, or open a login')).toBeTruthy();       // the empty pane
    expect(row('c2')).toBeNull();                                                      // folded: not mine to open
    expect(screen.getByRole('button', { name: /Not shared with you/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Copy password for Stripe' }));
    await waitFor(() => expect(calls.cvReveal).toHaveBeenCalledWith('c1'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('Corr3ct-Horse!'));
    expect(calls.cvCopied).toHaveBeenCalledWith('c1');
    expect(await screen.findByText(/Clipboard clears in/)).toBeTruthy();
    expect(screen.queryByText('Corr3ct-Horse!')).toBeNull();                          // copied, never shown
    fireEvent.click(screen.getByRole('button', { name: 'Stripe details' }));
    const dlg = await screen.findByRole('region', { name: 'Stripe' });
    expect(within(dlg).getByText('pay@x.com')).toBeTruthy();
    expect(within(dlg).getByText('Finance login')).toBeTruthy();
    fireEvent.click(within(dlg).getByRole('button', { name: 'Reveal Password' }));
    expect(await within(dlg).findByText('Corr3ct-Horse!')).toBeTruthy();
    expect(within(dlg).getByRole('button', { name: 'Edit' })).toBeTruthy();
    // Recently Used remembers the copy.
    expect(screen.getByText('Recently Used')).toBeTruthy();
  });

  it('a row I cannot open sits folded, hides the username and asks instead of revealing', async () => {
    render(<CredentialVaultApp />);
    await toLogins();
    fireEvent.click(screen.getByRole('button', { name: /Not shared with you/ }));
    expect(within(row('c2')).queryByRole('button', { name: /Copy password/ })).toBeNull();
    fireEvent.click(within(row('c2')).getByRole('button', { name: 'Request access to Jira Admin' }));
    const modal = await screen.findByText('Send Request');
    fireEvent.click(modal);
    await waitFor(() => expect(calls.cvRequest).toHaveBeenCalledWith('c2', { durationMs: 14400000, durationLabel: '4 Hours' }));
    expect(await screen.findByText(/Asked Ben Builder for Jira Admin/)).toBeTruthy();
    fireEvent.click(within(row('c2')).getByRole('button', { name: 'Jira Admin details' }));
    const dlg = await screen.findByRole('region', { name: 'Jira Admin' });
    expect(within(dlg).queryByRole('button', { name: 'Reveal Password' })).toBeNull();
    expect(within(dlg).queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('shows waiting requests on Approvals and approves inside the verified window', async () => {
    render(<CredentialVaultApp />);
    await screen.findByText('No Backup Owner', { selector: '.cv-kpi-label' });
    fireEvent.click(screen.getByRole('tab', { name: /^Approvals/ }));
    const who = await screen.findByText('Ben Builder', { selector: 'strong' });
    expect(who.closest('p').textContent).toMatch(/asks for 4 hours of access/);
    calls.cvApproveRequest.mockResolvedValue({ ok: true });
    fireEvent.click(screen.getByRole('button', { name: /Approve/ }));
    await waitFor(() => expect(calls.cvApproveRequest).toHaveBeenCalledWith('r1'));
  });

  it('Overview carries the numbers, the health table and the full list with its collections', async () => {
    render(<CredentialVaultApp activeSub="cred-c2" />);
    expect(await screen.findByRole('region', { name: 'Jira Admin' })).toBeTruthy();      // a deep link lands in My Logins, open
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.getByText('Copy from the row, or open a login')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Overview' }));
    expect(await screen.findByText('Needs Attention', { selector: '.cv-kpi-label' })).toBeTruthy();
    expect(screen.getByText('No Backup Owner', { selector: '.cv-kpi-label' })).toBeTruthy();
    const table = document.querySelector('.cv-health');
    expect(within(table).getByText('Accounting')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Export to Excel/ })).toBeTruthy();
    // Not an admin: the Overview covers what they manage - Ben's Jira is not in it, and there is no All Credentials.
    expect(document.getElementById('cred-row-c2')).toBeNull();
    expect(screen.queryByRole('tab', { name: /All Credentials/ })).toBeNull();
    expect(screen.getByRole('tab', { name: /Owned by Me/ }).getAttribute('aria-selected')).toBe('true');
    expect(document.getElementById('cred-row-c1')).toBeTruthy();
    expect(screen.getByText('Logins You Manage', { selector: '.cv-kpi-label' })).toBeTruthy();
  });

  it('on a phone the detail opens as a full-screen sheet', async () => {
    const real = window.matchMedia;
    window.matchMedia = (q) => ({ matches: /max-width: 900px/.test(q), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
    try {
      render(<CredentialVaultApp />);
      await toLogins();
      expect(screen.queryByText('Copy from the row, or open a login')).toBeNull();     // no inline pane on a phone
      fireEvent.click(screen.getByRole('button', { name: 'Stripe details' }));
      const dlg = await screen.findByRole('dialog', { name: 'Stripe' });
      expect(within(dlg).getByText('pay@x.com')).toBeTruthy();
      fireEvent.keyDown(window, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Stripe' })).toBeNull());
    } finally { window.matchMedia = real; }
  });
});

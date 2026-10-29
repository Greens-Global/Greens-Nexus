import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Render smoke for the rebuilt Credential Vault: the list reads the API's
// per-row access, the drawer opens, a row you cannot open offers Request
// Access instead of Reveal, Approvals shows what is waiting, and the deep link
// "cred-<id>" opens the drawer.

const calls = {
  cvCredentials: vi.fn(), cvRequests: vi.fn(), cvLogs: vi.fn(), cvOtpStatus: vi.fn(), cvAccess: vi.fn(),
  cvReveal: vi.fn(), cvRequest: vi.fn(), cvApproveRequest: vi.fn(), cvDenyRequest: vi.fn(),
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
  expiresAt: '', expiresInDays: null, hasPrevious: false, sharedWith: 1, deletedAt: null, createdAt: 1, access: 'owner', canReveal: true, canEdit: true, grantUntil: null };
const theirs = { ...mine, id: 'c2', name: 'Jira Admin', dept: 'IT', username: '', note: '', owner: 'ben@x.com', access: 'request', canReveal: false, canEdit: false };

beforeEach(() => {
  Object.values(calls).forEach((f) => f.mockReset());
  calls.cvCredentials.mockResolvedValue([mine, theirs]);
  calls.cvRequests.mockResolvedValue([{ id: 'r1', credId: 'c1', cred: 'Stripe', dept: 'Accounting', requestedBy: 'Ben Builder', requestedByEmail: 'ben@x.com', sharedToEmail: 'ben@x.com', duration: '4 Hours', ts: Date.now() - 60000 }]);
  calls.cvLogs.mockResolvedValue([{ id: 'l1', actor: 'Olive Owner', actorEmail: 'olive@x.com', action: 'Created', cred: 'Stripe', credId: 'c1', dept: 'Accounting', detail: null, ts: Date.now() - 3600000 }]);
  calls.cvOtpStatus.mockResolvedValue({ verified: true, until: Date.now() + 600000, windowSec: 900 });
  calls.cvAccess.mockResolvedValue({ owner: 'olive@x.com', backupOwner: '', dept: 'Accounting', tier: 'Standard', grants: [], pending: [] });
  calls.cvReveal.mockResolvedValue({ secret: 'Corr3ct-Horse!' });
  calls.cvRequest.mockResolvedValue({ requested: true });
  calls.getProjectDepartments.mockResolvedValue([{ name: 'Accounting' }, { name: 'IT' }]);
  calls.getPeopleDirectory.mockResolvedValue([{ email: 'olive@x.com', name: 'Olive Owner' }, { email: 'ben@x.com', name: 'Ben Builder' }]);
  calls.cvPersonal.mockResolvedValue([]);
});

describe('Credentials', () => {
  it('lists what the API allows and opens the drawer with the verified window shown', async () => {
    render(<CredentialVaultApp />);
    await waitFor(() => expect(document.getElementById('cred-row-c1')).toBeTruthy());
    expect(screen.getByText(/Verified until/)).toBeTruthy();
    expect(screen.getByText('Pick a credential')).toBeTruthy();       // the empty pane, People-style
    expect(screen.getAllByText('Owner').length).toBeGreaterThan(0);
    expect(screen.getByText('Request Access')).toBeTruthy();          // Ben's Jira row
    fireEvent.click(document.getElementById('cred-row-c1').querySelector('button'));
    const dlg = await screen.findByRole('region', { name: 'Stripe' });
    expect(within(dlg).getByText('pay@x.com')).toBeTruthy();
    expect(within(dlg).getByText('Finance login')).toBeTruthy();
    fireEvent.click(within(dlg).getByRole('button', { name: 'Reveal Password' }));
    await waitFor(() => expect(calls.cvReveal).toHaveBeenCalledWith('c1'));
    expect(await within(dlg).findByText('Corr3ct-Horse!')).toBeTruthy();
    expect(within(dlg).getByRole('button', { name: 'Edit' })).toBeTruthy();
  });

  it('a row you cannot open hides the username and asks instead of revealing', async () => {
    render(<CredentialVaultApp />);
    await waitFor(() => expect(document.getElementById('cred-row-c2')).toBeTruthy());
    fireEvent.click(document.getElementById('cred-row-c2').querySelector('button'));
    const dlg = await screen.findByRole('region', { name: 'Jira Admin' });
    expect(within(dlg).queryByRole('button', { name: 'Reveal Password' })).toBeNull();
    expect(within(dlg).queryByRole('button', { name: 'Edit' })).toBeNull();
    fireEvent.click(within(dlg).getByRole('button', { name: /Request Access/ }));
    const modal = await screen.findByText('Send Request');
    fireEvent.click(modal);
    await waitFor(() => expect(calls.cvRequest).toHaveBeenCalledWith('c2', { durationMs: 14400000, durationLabel: '4 Hours' }));
    expect(await screen.findByText(/Asked Ben Builder for Jira Admin/)).toBeTruthy();
  });

  it('shows waiting requests on Approvals and approves inside the verified window', async () => {
    render(<CredentialVaultApp />);
    await waitFor(() => expect(document.getElementById('cred-row-c1')).toBeTruthy());
    fireEvent.click(screen.getByRole('tab', { name: /^Approvals/ }));
    const who = await screen.findByText('Ben Builder', { selector: 'strong' });
    expect(who.closest('p').textContent).toMatch(/asks for 4 hours of access/);
    calls.cvApproveRequest.mockResolvedValue({ ok: true });
    fireEvent.click(screen.getByRole('button', { name: /Approve/ }));
    await waitFor(() => expect(calls.cvApproveRequest).toHaveBeenCalledWith('r1'));
  });

  it('opens the drawer from a deep link and filters by collection', async () => {
    render(<CredentialVaultApp activeSub="cred-c2" />);
    expect(await screen.findByRole('region', { name: 'Jira Admin' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.getByText('Pick a credential')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /Owned by Me/ }));
    await waitFor(() => expect(document.getElementById('cred-row-c2')).toBeNull());
    expect(document.getElementById('cred-row-c1')).toBeTruthy();
    expect(screen.getByText('Needs Attention', { selector: '.cv-kpi-label' })).toBeTruthy();
  });

  it('on a phone the detail opens as a full-screen sheet', async () => {
    const real = window.matchMedia;
    window.matchMedia = (q) => ({ matches: /max-width: 900px/.test(q), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
    try {
      render(<CredentialVaultApp />);
      await waitFor(() => expect(document.getElementById('cred-row-c1')).toBeTruthy());
      expect(screen.queryByText('Pick a credential')).toBeNull();           // no inline pane on a phone
      fireEvent.click(document.getElementById('cred-row-c1').querySelector('button'));
      const dlg = await screen.findByRole('dialog', { name: 'Stripe' });
      expect(within(dlg).getByText('pay@x.com')).toBeTruthy();
      fireEvent.keyDown(window, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Stripe' })).toBeNull());
    } finally { window.matchMedia = real; }
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';

// Hold to confirm in Credentials (Neil, Oct 30 2026): End Access and Delete
// Permanently in the drawer, and Delete on a Personal Vault row, are row
// holds of HOLD_RECORD_MS - no dialog in front of them any more.
const api = vi.hoisted(() => ({
  cvAccess: vi.fn(), cvRevokeGrant: vi.fn(), cvPersonal: vi.fn(), cvPersonalDelete: vi.fn(), cvTotp: vi.fn(),
}));
vi.mock('../api', () => ({ api }));
vi.mock('./vaultShared', async (importOriginal) => ({
  ...(await importOriginal()),
  // The unlock itself is its own flow; here it simply lets the vault open.
  PersonalLockGate: ({ onUnlocked }) => <button type="button" onClick={() => onUnlocked({ expiresInSec: 600 })}>Mock Unlock</button>,
}));

const { CredentialDetail } = await import('./CredentialDrawer');
const { default: PersonalVault } = await import('./PersonalVault');
const { DialogHost } = await import('../ui/dialog');
const { HOLD_RECORD_MS } = await import('../ui/HoldButton');

const cred = {
  id: 'c1', name: 'Stripe', dept: 'Accounting', type: 'Password', tier: 'Standard', username: 'pay@x.com', url: '', note: '',
  owner: 'olive@x.com', backupOwner: '', rotatedAt: '', rotatedDays: 0, rotationMax: 90, expiresAt: '', hasPrevious: false,
  sharedWith: 1, deletedAt: null, createdAt: 1, access: 'owner', canReveal: true, canEdit: true, grantUntil: null, audiences: [],
};
const detail = (over = {}) => (
  <CredentialDetail cred={{ ...cred, ...over }} logs={[]} myEmail="olive@x.com" nameOf={(e) => e} revealed={null}
    onReveal={vi.fn()} onHide={vi.fn()} onEdit={vi.fn()} onTrash={vi.fn()} onRestore={vi.fn()} onShare={vi.fn()}
    onRequest={vi.fn()} onClose={vi.fn()} {...over.props} />
);
const press = (el) => fireEvent.pointerDown(el, { button: 0, pointerId: 1 });

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  api.cvAccess.mockResolvedValue({ grants: [{ id: 'g1', name: 'Ben Builder', expiresAt: Date.now() + 3600000 }], pending: [], heads: [] });
});
afterEach(() => { vi.useRealTimers(); });

describe('Credential drawer holds', () => {
  it('End Access ends the grant once the hold completes, and the row leaves', async () => {
    api.cvRevokeGrant.mockResolvedValue({ ok: true });
    const onChanged = vi.fn();
    render(detail({ props: { onChanged } }));
    const btn = await screen.findByRole('button', { name: 'End access for Ben Builder, press and hold' });
    vi.useFakeTimers();
    press(btn);
    await act(async () => { vi.advanceTimersByTime(HOLD_RECORD_MS); });
    expect(api.cvRevokeGrant).toHaveBeenCalledTimes(1);
    expect(api.cvRevokeGrant).toHaveBeenCalledWith('g1');
    expect(onChanged).toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(700); });
    expect(screen.queryByText(/Ben Builder/)).toBeNull();
  });

  it('a refused End Access rewinds with the reason and keeps the row', async () => {
    api.cvRevokeGrant.mockRejectedValue(new Error('Only the owner, backup owner or an admin can end this access'));
    render(detail());
    const btn = await screen.findByRole('button', { name: 'End access for Ben Builder, press and hold' });
    vi.useFakeTimers();
    press(btn);
    await act(async () => { vi.advanceTimersByTime(HOLD_RECORD_MS); });
    expect(screen.getByRole('alert').textContent).toMatch(/Only the owner/);
    expect(screen.getByText(/Ben Builder/)).toBeTruthy();
  });

  it('Delete Permanently in the Trash is a hold that calls the purge once', async () => {
    const onPurge = vi.fn().mockResolvedValue(undefined);
    render(detail({ deletedAt: '2026-10-29T00:00:00Z', props: { onPurge } }));
    const btn = await screen.findByRole('button', { name: 'Delete Permanently, press and hold' });
    vi.useFakeTimers();
    press(btn);
    await act(async () => { vi.advanceTimersByTime(HOLD_RECORD_MS - 200); });
    expect(onPurge).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(200); });
    expect(onPurge).toHaveBeenCalledTimes(1);
  });
});

describe('Personal Vault delete', () => {
  it('a click with no press (assistive tech) asks with the ordinary dialog, then deletes', async () => {
    api.cvPersonal.mockResolvedValue([{ id: 'p1', name: 'Home Wi-Fi', type: 'Password', username: '-', note: '' }]);
    api.cvPersonalDelete.mockResolvedValue({ ok: true });
    const flash = vi.fn();
    render(<><DialogHost /><PersonalVault myEmail="olive@x.com" flash={flash} /></>);
    fireEvent.click(await screen.findByRole('button', { name: /Unlock/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Mock Unlock' }));
    const btn = await screen.findByRole('button', { name: 'Delete Home Wi-Fi, press and hold' });
    await act(async () => { fireEvent.click(btn); });
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByText(/There is no trash for personal credentials/)).toBeTruthy();
    expect(api.cvPersonalDelete).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(within(dlg).getByRole('button', { name: 'Delete' })); });
    await act(async () => {});
    expect(api.cvPersonalDelete).toHaveBeenCalledTimes(1);
    expect(api.cvPersonalDelete).toHaveBeenCalledWith('p1');
    expect(flash).toHaveBeenCalledWith('Deleted.');
  });
});

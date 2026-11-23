// The vault's code step for Dashboard > Approvals (11/18/2026): inside the
// verified window it asks nothing; outside it the vault's own card comes up
// over the page and the answer is what the person did with it.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, act } from '@testing-library/react';

const api = vi.hoisted(() => ({ cvOtpStatus: vi.fn(), cvOtpTargets: vi.fn(), cvOtpRequest: vi.fn(), cvOtpVerify: vi.fn(), cvApproveRequest: vi.fn() }));
vi.mock('../api', () => ({ api }));

const { ensureVaultCode } = await import('./vaultCode');
const { runApproval } = await import('../lib/approvalActions');

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  api.cvOtpTargets.mockResolvedValue({ email: { masked: 'p•••@greensglobal.com' }, sms: { available: false } });
  document.body.innerHTML = '';
});

describe('ensureVaultCode', () => {
  it('asks nothing inside the verified window', async () => {
    api.cvOtpStatus.mockResolvedValue({ verified: true, until: Date.now() + 60000 });
    expect(await ensureVaultCode()).toBe(true);
    expect(document.querySelector('[data-vault-code]')).toBeNull();
  });

  it('shows the code card outside it; a verified code answers yes and the card leaves', async () => {
    api.cvOtpStatus.mockResolvedValue({ verified: false, until: null });
    api.cvOtpRequest.mockResolvedValue({ challengeId: 'ch1', target: 'p•••@greensglobal.com' });
    api.cvOtpVerify.mockResolvedValue({ ok: true });
    let answer;
    await act(async () => { ensureVaultCode().then((ok) => { answer = ok; }); });
    fireEvent.click(await screen.findByRole('button', { name: 'Get Code' }));
    fireEvent.change(await screen.findByPlaceholderText('000 000'), { target: { value: '123456' } });
    await waitFor(() => expect(answer).toBe(true));
    await waitFor(() => expect(document.querySelector('[data-vault-code]')).toBeNull());
  });

  it('closing the card answers no', async () => {
    api.cvOtpStatus.mockResolvedValue({ verified: false, until: null });
    let answer;
    await act(async () => { ensureVaultCode().then((ok) => { answer = ok; }); });
    await screen.findByText('Verify Your Identity');
    await act(async () => { fireEvent.keyDown(window, { key: 'Escape' }); });
    await waitFor(() => expect(answer).toBe(false));
  });
});

describe('approving a login request from Approvals', () => {
  it('asks for the code when the server says the window closed, then approves once more', async () => {
    api.cvOtpStatus.mockResolvedValue({ verified: true, until: Date.now() + 60000 });
    api.cvApproveRequest.mockRejectedValueOnce(Object.assign(new Error('code'), { detail: { code: 'vault_otp_required' } })).mockResolvedValue({ ok: true });
    await runApproval({ kind: 'credvault_request', id: 'r1' }, 'approve');
    expect(api.cvApproveRequest).toHaveBeenCalledTimes(2);
    expect(api.cvApproveRequest).toHaveBeenLastCalledWith('r1');
  });

  it('passes on any other refusal as it is', async () => {
    api.cvApproveRequest.mockRejectedValue(new Error('Only the owner or an admin decides this'));
    await expect(runApproval({ kind: 'credvault_request', id: 'r1' }, 'approve')).rejects.toThrow('Only the owner');
    expect(api.cvApproveRequest).toHaveBeenCalledTimes(1);
  });
});

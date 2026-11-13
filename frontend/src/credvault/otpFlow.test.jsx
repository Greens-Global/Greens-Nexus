// The code to reveal a password (11/13/2026): pick Email or SMS, Get Code,
// type the code, Authenticate - nothing is sent until Get Code, and SMS waits
// for the consent box.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({ cvOtpTargets: vi.fn(), cvOtpRequest: vi.fn(), cvOtpVerify: vi.fn() }));
vi.mock('../api', () => ({ api }));

const { VaultOtpModal } = await import('./vaultShared');

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  api.cvOtpTargets.mockResolvedValue({ email: { masked: 'p•••@greensglobal.com' }, sms: { available: true, masked: '•••• 8853' } });
});

describe('Verify your identity', () => {
  it('Email: pick it, Get Code, type the code, Authenticate', async () => {
    api.cvOtpRequest.mockResolvedValue({ challengeId: 'ch1', target: 'p•••@greensglobal.com' });
    api.cvOtpVerify.mockResolvedValue({ ok: true });
    const onVerified = vi.fn();
    render(<VaultOtpModal onClose={() => {}} onVerified={onVerified} />);
    const getCode = await screen.findByRole('button', { name: 'Get Code' });
    expect(getCode.disabled).toBe(true);                                         // nothing picked yet
    fireEvent.click(screen.getByLabelText(/Authenticate via Email/));
    expect(api.cvOtpRequest).not.toHaveBeenCalled();                            // picking sends nothing
    fireEvent.click(getCode);
    await waitFor(() => expect(api.cvOtpRequest).toHaveBeenCalledWith('email'));
    fireEvent.change(await screen.findByPlaceholderText('000 000'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Authenticate' }));
    await waitFor(() => expect(onVerified).toHaveBeenCalled());
    expect(api.cvOtpVerify).toHaveBeenCalledWith('ch1', '123456');
  });

  it('SMS waits for the consent box; a failed send says why', async () => {
    api.cvOtpRequest.mockRejectedValue(new Error('Could not send the SMS code - please try Email instead.'));
    render(<VaultOtpModal onClose={() => {}} onVerified={() => {}} />);
    fireEvent.click(await screen.findByLabelText(/Authenticate via SMS/));
    expect(screen.getByRole('button', { name: 'Get Code' }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Get Code' }));
    expect(await screen.findByText('Could not send the SMS code - please try Email instead.')).toBeTruthy();
    expect(api.cvOtpRequest).toHaveBeenCalledWith('sms');
  });
});

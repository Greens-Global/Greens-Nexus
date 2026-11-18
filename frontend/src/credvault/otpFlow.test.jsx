// The code to reveal a password (11/13/2026): pick Email or SMS, Get Code,
// type the code - six digits check themselves (11/15/2026) - nothing is sent
// until Get Code, SMS waits for the consent box, and with no phone on file
// Email comes picked.
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
    const box = await screen.findByPlaceholderText('000 000');
    expect(box.getAttribute('autocomplete')).toBe('one-time-code');          // a phone offers the texted code
    fireEvent.change(box, { target: { value: '123456' } });                    // six digits check themselves
    await waitFor(() => expect(onVerified).toHaveBeenCalled());
    expect(api.cvOtpVerify).toHaveBeenCalledTimes(1);
    expect(api.cvOtpVerify).toHaveBeenCalledWith('ch1', '123456');
  });

  it('a refused code is not sent again until it changes', async () => {
    api.cvOtpRequest.mockResolvedValue({ challengeId: 'ch1', target: 'p•••@greensglobal.com' });
    api.cvOtpVerify.mockRejectedValueOnce(new Error('Incorrect code.')).mockResolvedValue({ ok: true });
    const onVerified = vi.fn();
    render(<VaultOtpModal onClose={() => {}} onVerified={onVerified} />);
    fireEvent.click(await screen.findByLabelText(/Authenticate via Email/));
    fireEvent.click(screen.getByRole('button', { name: 'Get Code' }));
    const box = await screen.findByPlaceholderText('000 000');
    fireEvent.change(box, { target: { value: '111111' } });
    expect(await screen.findByText('Incorrect code.')).toBeTruthy();
    expect(api.cvOtpVerify).toHaveBeenCalledTimes(1);
    fireEvent.change(box, { target: { value: '11111' } });
    expect(api.cvOtpVerify).toHaveBeenCalledTimes(1);                           // five digits: nothing
    fireEvent.change(box, { target: { value: '222222' } });
    await waitFor(() => expect(onVerified).toHaveBeenCalled());
    expect(api.cvOtpVerify).toHaveBeenLastCalledWith('ch1', '222222');
  });

  it('no phone on file: Email comes picked', async () => {
    api.cvOtpTargets.mockResolvedValue({ email: { masked: 'p•••@greensglobal.com' }, sms: { available: false } });
    render(<VaultOtpModal onClose={() => {}} onVerified={() => {}} />);
    const getCode = await screen.findByRole('button', { name: 'Get Code' });
    expect(getCode.disabled).toBe(false);
    expect(screen.getByLabelText(/Authenticate via Email/).checked).toBe(true);
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

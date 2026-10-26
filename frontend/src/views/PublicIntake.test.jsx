import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

// Render-smoke for the candidate's details page (/intake/{token}, Oct 14):
// the form, its required fields, the thank-you after sending, and the states
// a link can be in. Never any pay.

let page = { state: 'open', company: 'Greens Test, LLC', firstName: 'Jen', lastName: 'Doe', phone: '', role: 'Analyst',
  expiresOn: '2030-10-28', fields: ['first_name', 'last_name', 'preferred_name', 'phone', 'address', 'permanent_address',
    'emergency_name', 'emergency_relationship', 'emergency_phone'].map(key => ({ key, required: ['first_name', 'last_name', 'phone', 'address'].includes(key) })) };
const submit = vi.fn(() => Promise.resolve({ ok: true }));
vi.mock('../api', () => ({
  fetchPublicIntake: () => Promise.resolve(page),
  submitPublicIntake: (...a) => submit(...a),
}));
const { default: PublicIntake } = await import('./PublicIntake');

describe('PublicIntake', () => {
  it('asks for the details and thanks them once sent', async () => {
    render(<PublicIntake token="tok" />);
    await waitFor(() => expect(screen.getByText('Complete Your Details')).toBeTruthy());
    expect(screen.getByText('Analyst')).toBeTruthy();
    expect(screen.getByText(/10\/28\/2030/)).toBeTruthy();
    expect(screen.getByLabelText('Legal First Name *').value).toBe('Jen');
    fireEvent.change(screen.getByLabelText('Phone *'), { target: { value: '555-0100' } });
    fireEvent.change(screen.getByLabelText('Current Address *'), { target: { value: '12 Pine St' } });
    fireEvent.click(screen.getByText('Send To HR'));
    await waitFor(() => expect(screen.getByText(/^Thank You/)).toBeTruthy());
    expect(submit.mock.calls[0][1]).toMatchObject({ first_name: 'Jen', phone: '555-0100', address: '12 Pine St' });
  });

  it("asks for the packet's own Details Form and sends the answers", async () => {
    page = { ...page, state: 'open', form: [
      { key: '', label: 'Bank Details', type: 'heading' },
      { key: 'pan_number', label: 'PAN Number', type: 'text', required: true },
      { key: 'aadhaar_number', label: 'Aadhaar Number', type: 'text', last4: true },
      { key: 'account_type', label: 'Account Type', type: 'choice', options: ['Savings', 'Current'] },
    ] };
    submit.mockClear();
    render(<PublicIntake token="tok" />);
    await waitFor(() => expect(screen.getByText('Bank Details')).toBeTruthy());
    expect(screen.getByText('Only the last 4 characters are kept.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Phone *'), { target: { value: '555-0100' } });
    fireEvent.change(screen.getByLabelText('Current Address *'), { target: { value: '12 Pine St' } });
    fireEvent.change(screen.getByLabelText('PAN Number *'), { target: { value: 'ABCDE1234F' } });
    fireEvent.change(screen.getByLabelText('Account Type'), { target: { value: 'Current' } });
    fireEvent.click(screen.getByText('Send To HR'));
    await waitFor(() => expect(screen.getByText(/^Thank You/)).toBeTruthy());
    expect(submit.mock.calls[0][1].answers).toEqual({ pan_number: 'ABCDE1234F', account_type: 'Current' });
  });

  it('after a signed offer: prefilled, in sections, private questions marked, no login', async () => {
    page = { ...page, state: 'open', afterOffer: true, prefill: { address: '12 Pine St' }, form: [
      { key: 'pan_number', label: 'PAN Number', type: 'text', required: true, sensitive: true, fromTemplate: 'Onboarding Requirements' },
    ] };
    submit.mockClear();
    render(<PublicIntake token="tok" />);
    await waitFor(() => expect(screen.getByText('Your Onboarding Details')).toBeTruthy());
    expect(screen.getByText('About You')).toBeTruthy();
    expect(screen.getByText('For Your Documents')).toBeTruthy();
    expect(screen.getByText(/Private - only the payroll team sees it/)).toBeTruthy();
    expect(screen.getByLabelText('Current Address *').value).toBe('12 Pine St');
    expect(screen.queryByLabelText('Permanent Address')).toBeNull();          // "the same" is ticked
    fireEvent.change(screen.getByLabelText('Phone *'), { target: { value: '555-0100' } });
    fireEvent.change(screen.getByLabelText('PAN Number *'), { target: { value: 'ABCDE1234F' } });
    fireEvent.click(screen.getByText('Send - Prepare My Documents'));
    await waitFor(() => expect(screen.getByText(/no account or password needed/)).toBeTruthy());
    expect(submit.mock.calls[0][1]).toMatchObject({ address: '12 Pine St', permanent_address: '12 Pine St',
      answers: { pan_number: 'ABCDE1234F' } });
  });

  it('a promotion or separation page names its own documents', async () => {
    page = { ...page, state: 'open', afterOffer: false, form: [], kind: 'promotion' };
    const { unmount } = render(<PublicIntake token="tok" />);
    await waitFor(() => expect(screen.getByText(/prepare your promotion letter/)).toBeTruthy());
    expect(screen.queryByText(/hiring documents/)).toBeNull();
    unmount();
    page = { ...page, kind: 'separation' };
    render(<PublicIntake token="tok" />);
    await waitFor(() => expect(screen.getByText(/prepare your separation documents/)).toBeTruthy());
  });

  it('says when the link has expired', async () => {
    page = { ...page, state: 'expired' };
    render(<PublicIntake token="tok" />);
    await waitFor(() => expect(screen.getByText('This Link Has Expired')).toBeTruthy());
  });
});

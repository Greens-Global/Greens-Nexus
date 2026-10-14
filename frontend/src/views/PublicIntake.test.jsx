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
    await waitFor(() => expect(screen.getByText('Thank You')).toBeTruthy());
    expect(submit.mock.calls[0][1]).toMatchObject({ first_name: 'Jen', phone: '555-0100', address: '12 Pine St' });
  });

  it('says when the link has expired', async () => {
    page = { ...page, state: 'expired' };
    render(<PublicIntake token="tok" />);
    await waitFor(() => expect(screen.getByText('This Link Has Expired')).toBeTruthy());
  });
});

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Add Candidate (Neil, Oct 14): last name, email and phone are mandatory, and
// the expected interview date comes with every new candidate.

const createCandidate = vi.fn((b) => Promise.resolve({ id: 'c-new', ...b, firstName: b.first_name, lastName: b.last_name }));
vi.mock('../api', () => ({ api: {
  getEntities: () => Promise.resolve([{ id: 'co', name: 'Greens' }]),
  hiringOptions: () => Promise.resolve({ roles: [{ id: 'r1', name: 'Analyst', department: 'Accounting' }], departments: ['Accounting'], sources: [] }),
  ivTemplates: () => Promise.resolve([]),
  createCandidate: (...a) => createCandidate(...a),
} }));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ myEmail: 'hr@x.com' }) }));
const { default: CandidateFormModal } = await import('./HiringCandidateForm');

describe('Add Candidate', () => {
  it('needs last name, email and phone, and sends the expected interview date', async () => {
    const onSaved = vi.fn();
    render(<CandidateFormModal onClose={() => {}} onSaved={onSaved} toastOk={() => {}} toastErr={() => {}} />);
    await waitFor(() => expect(screen.getByText('Greens')).toBeTruthy());
    const add = () => screen.getByText('Add Candidate', { selector: 'button' });
    expect(screen.getByLabelText('Expected Interview Date *').value).toMatch(/^\d{4}-\d{2}-\d{2}$/);   // prefilled
    fireEvent.change(screen.getByLabelText('First Name *'), { target: { value: 'Jane' } });
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'co' } });
    await waitFor(() => expect(screen.getByText('Analyst - Accounting')).toBeTruthy());
    fireEvent.change(screen.getAllByRole('combobox')[1], { target: { value: 'r1' } });
    expect(add().disabled).toBe(true);                                    // no last name, email, phone yet
    fireEvent.change(screen.getByLabelText('Last Name *'), { target: { value: 'Doe' } });
    fireEvent.change(screen.getByLabelText('Personal Email *'), { target: { value: 'jane@gmail.com' } });
    expect(add().disabled).toBe(true);                                    // still no phone
    fireEvent.change(screen.getByLabelText('Phone *'), { target: { value: '555-0100' } });
    fireEvent.change(screen.getByLabelText('Expected Interview Date *'), { target: { value: '2030-11-05' } });
    expect(add().disabled).toBe(false);
    fireEvent.click(add());
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(createCandidate.mock.calls[0][0]).toMatchObject({ last_name: 'Doe', email: 'jane@gmail.com', phone: '555-0100',
      expected_interview_on: '2030-11-05' });
  });
});

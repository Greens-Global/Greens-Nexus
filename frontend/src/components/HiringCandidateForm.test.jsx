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
  updateCandidate: (...a) => updateCandidate(...a),
} }));
const updateCandidate = vi.fn((id, b) => Promise.resolve({ id, ...b }));
const confirmMock = vi.fn();
vi.mock('../ui/dialog', () => ({ dialog: { confirm: (...a) => confirmMock(...a), prompt: vi.fn(), alert: vi.fn() } }));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ myEmail: 'hr@x.com' }) }));
const { default: CandidateFormModal } = await import('./HiringCandidateForm');

describe('Add Candidate', () => {
  it('needs last name, email and phone, and sends the expected interview date', async () => {
    const onSaved = vi.fn();
    render(<CandidateFormModal onClose={() => {}} onSaved={onSaved} toastOk={() => {}} toastErr={() => {}} />);
    await waitFor(() => expect(screen.getByText('Greens')).toBeTruthy());
    const add = () => screen.getByText('Add Candidate', { selector: 'button' });
    // prefilled, and shown MM/DD/YYYY whatever the computer's region (Neil, Oct 19)
    expect(screen.getByTitle('Expected Interview Date').textContent).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
    fireEvent.change(screen.getByLabelText('First Name *'), { target: { value: 'Jane' } });
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'co' } });
    await waitFor(() => expect(screen.getByText('Analyst - Accounting')).toBeTruthy());
    fireEvent.change(screen.getAllByRole('combobox')[1], { target: { value: 'r1' } });
    expect(add().disabled).toBe(true);                                    // no last name, email, phone yet
    fireEvent.change(screen.getByLabelText('Last Name *'), { target: { value: 'Doe' } });
    fireEvent.change(screen.getByLabelText('Personal Email *'), { target: { value: 'jane@gmail.com' } });
    expect(add().disabled).toBe(true);                                    // still no phone
    fireEvent.change(screen.getByLabelText('Phone *'), { target: { value: '555-0100' } });
    expect(add().disabled).toBe(false);
    fireEvent.click(add());
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(createCandidate.mock.calls[0][0]).toMatchObject({ last_name: 'Doe', email: 'jane@gmail.com', phone: '555-0100',
      expected_interview_on: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
  });

  async function fillIn() {
    await waitFor(() => expect(screen.getByText('Greens')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('First Name *'), { target: { value: 'Elena' } });
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'co' } });
    await waitFor(() => expect(screen.getByText('Analyst - Accounting')).toBeTruthy());
    fireEvent.change(screen.getAllByRole('combobox')[1], { target: { value: 'r1' } });
    fireEvent.change(screen.getByLabelText('Last Name *'), { target: { value: 'Vasquez' } });
    fireEvent.change(screen.getByLabelText('Personal Email *'), { target: { value: 'elena@gmail.com' } });
    fireEvent.change(screen.getByLabelText('Phone *'), { target: { value: '555-0101' } });
  }

  it('the same email already in Hiring asks first, then adds on purpose (11/14/2026)', async () => {
    createCandidate.mockReset();
    const msg = 'Elena Vasquez is already in Screening for Leasing Associate - add anyway?';
    createCandidate
      .mockRejectedValueOnce(Object.assign(new Error(msg), { status: 409, detail: { code: 'duplicate_candidate', message: msg } }))
      .mockImplementation((b) => Promise.resolve({ id: 'c2', ...b, firstName: b.first_name, lastName: b.last_name }));
    confirmMock.mockReset().mockResolvedValueOnce(true);
    const onSaved = vi.fn();
    render(<CandidateFormModal onClose={() => {}} onSaved={onSaved} toastOk={() => {}} toastErr={() => {}} />);
    await fillIn();
    fireEvent.click(screen.getByText('Add Candidate', { selector: 'button' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(confirmMock.mock.calls[0][0]).toBe(msg);
    expect(confirmMock.mock.calls[0][1]).toMatchObject({ title: 'Already In Hiring', confirmText: 'Add Anyway' });
    expect(createCandidate.mock.calls.map(c => c[0].allow_duplicate)).toEqual([false, true]);
  });

  it('a duplicate HR does not want is never added', async () => {
    createCandidate.mockReset();
    createCandidate.mockRejectedValueOnce(Object.assign(new Error('dup'), { status: 409, detail: { code: 'duplicate_candidate', message: 'dup' } }));
    confirmMock.mockReset().mockResolvedValueOnce(false);
    const onSaved = vi.fn();
    render(<CandidateFormModal onClose={() => {}} onSaved={onSaved} toastOk={() => {}} toastErr={() => {}} />);
    await fillIn();
    fireEvent.click(screen.getByText('Add Candidate', { selector: 'button' }));
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(createCandidate).toHaveBeenCalledTimes(1);
    expect(onSaved).not.toHaveBeenCalled();
  });
});

describe('Edit Email (Interview through Offer)', () => {
  it('only the email can change, and it is saved on its own', async () => {
    updateCandidate.mockClear();
    const onSaved = vi.fn();
    render(<CandidateFormModal candidate={{ id: 'c1', firstName: 'Jane', lastName: 'Doe', email: 'jane@typo.com', stage: 'offer' }} emailOnly
      onClose={() => {}} onSaved={onSaved} toastOk={() => {}} toastErr={() => {}} />);
    expect(screen.getByText('Edit Email')).toBeTruthy();
    expect(screen.queryByLabelText('First Name *')).toBeNull();
    expect(screen.queryByLabelText('Phone')).toBeNull();
    fireEvent.change(screen.getByLabelText('Personal Email *'), { target: { value: 'jane@gmail.com' } });
    fireEvent.click(screen.getByText('Save Email'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(updateCandidate).toHaveBeenCalledWith('c1', { email: 'jane@gmail.com' });
  });
});

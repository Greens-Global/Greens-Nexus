import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Render-smoke for the timesheet review panel (Sep 2026): the review hand-offs
// and the Nexus Sign signatures that replaced one-click "Sign & submit".

const submit = vi.fn(() => Promise.resolve({}));
const sendBack = vi.fn(() => Promise.resolve({}));
const agree = vi.fn(() => Promise.resolve({}));
vi.mock('../api', () => ({
  api: {
    timesheetReviewSubmit: (...a) => submit(...a),
    timesheetReviewSendBack: (...a) => sendBack(...a),
    timesheetReviewAgree: (...a) => agree(...a),
  },
}));
vi.mock('./ESign', () => ({ SignModal: ({ partyId }) => <div data-testid="sign-modal">{partyId}</div> }));

const TimesheetReviewPanel = (await import('./TimesheetReviewPanel')).default;
const nameFor = (e) => ({ 'mgr@x.com': 'Max', 'emp@x.com': 'Erin', 'hr@x.com': 'Hana' }[e] || e);
const base = { id: 'r1', managerEmail: 'mgr@x.com', employeeEmail: 'emp@x.com', rounds: [], parties: [] };
const props = { self: true, anchor: '2026-09-06', periodLabel: '09/06/2026 - 09/19/2026', nameFor, onChanged: () => {} };

describe('TimesheetReviewPanel', () => {
  it('lets the employee submit a fresh timesheet', async () => {
    render(<TimesheetReviewPanel {...props} review={{ status: 'not_submitted', rounds: [], parties: [] }} />);
    fireEvent.change(screen.getByPlaceholderText(/Anything your manager/), { target: { value: 'All good' } });
    fireEvent.click(screen.getByText('Submit for Review'));
    await waitFor(() => expect(submit).toHaveBeenCalledWith('2026-09-06', 'All good'));
  });

  it('gives the manager Send Back (with a note) and Agree', async () => {
    render(<TimesheetReviewPanel {...props} self={false}
      review={{ ...base, status: 'with_manager', canAgree: true, canSendBack: true }} />);
    expect(screen.getByText('Send Back').closest('button')).toBeDisabled();   // needs a note
    fireEvent.change(screen.getByPlaceholderText(/What needs changing/), { target: { value: 'Fix Tue' } });
    fireEvent.click(screen.getByText('Send Back'));
    await waitFor(() => expect(sendBack).toHaveBeenCalledWith('r1', 'Fix Tue'));
    fireEvent.click(screen.getByText('Agree & Send for Signature'));
    await waitFor(() => expect(agree).toHaveBeenCalled());
  });

  it('shows the employee what the manager asked for', () => {
    render(<TimesheetReviewPanel {...props} review={{ ...base, status: 'with_employee', canSubmit: true,
      rounds: [{ at: '2026-09-20T10:00:00Z', by: 'mgr@x.com', action: 'sent_back', note: 'Lunch missing on Tue' }] }} />);
    expect(screen.getAllByText(/Lunch missing on Tue/).length).toBeGreaterThan(0);
    expect(screen.getByText('Resubmit')).toBeInTheDocument();
  });

  it('shows who has signed and opens Nexus Sign for my turn', () => {
    render(<TimesheetReviewPanel {...props} self={false} review={{ ...base, status: 'signing', turn: 'manager', myPartyId: 'p-mgr',
      agreedBy: 'mgr@x.com', agreedAt: '2026-09-20T10:00:00Z',
      parties: [
        { role: 'employee', name: 'Erin', status: 'signed', signedAt: '2026-09-20T11:00:00Z', signatureKind: 'paper' },
        { role: 'manager', name: 'Max', status: 'notified' },
        { role: 'hr', name: 'Hana', status: 'waiting' },
      ] }} />);
    expect(screen.getByText('On paper')).toBeInTheDocument();
    expect(screen.getByText(/Waiting for Max/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Review & Sign'));
    expect(screen.getByTestId('sign-modal')).toHaveTextContent('p-mgr');
  });

  it('says so when it is finalized', () => {
    render(<TimesheetReviewPanel {...props} review={{ ...base, status: 'completed', parties: [] }} />);
    expect(screen.getByText(/finalized for payroll/)).toBeInTheDocument();
  });
});

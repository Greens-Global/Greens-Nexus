import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Role change approvals (Pranshu, Oct 13): the manager or HR sees the reason
// and approves or declines - on the Access tab or straight from the bell.

const base = {
  id: 'rq1', employeeId: 'e1', employeeName: 'Erin Lee', fromTitle: 'Tester', toRoleName: 'Accounting Associate',
  reason: 'Covers month-end close', status: 'pending', statusLabel: 'Awaiting Approval',
  approvers: [{ email: 'max@x.com', name: 'Max', as: 'manager' }, { email: 'hana@x.com', name: 'Hana', as: 'hr' }],
  requestedBy: 'ada@x.com', requestedByName: 'Ada', createdAt: '2026-10-13T17:00:00Z',
};
let row = base;
const approve = vi.fn(() => Promise.resolve({ ...row, status: 'approved' }));
const decline = vi.fn(() => Promise.resolve({ ...row, status: 'declined' }));
vi.mock('../api', () => ({
  api: {
    getRoleChangeRequests: () => Promise.resolve([row]),
    getRoleChangeRequest: () => Promise.resolve(row),
    approveRoleChange: (...a) => approve(...a),
    declineRoleChange: (...a) => decline(...a),
    cancelRoleChange: () => Promise.resolve({ ...row, status: 'canceled' }),
    getRoleHistory: () => Promise.resolve([
      { id: 'h1', kind: 'promotion', status: 'completed', statusLabel: 'Promotion', at: '2026-10-14T17:00:00Z', from: 'Associate', to: 'Lead',
        reason: 'Great year', raisedBy: 'hana@x.com', raisedByName: 'Hana', raisedAt: '2026-10-10T17:00:00Z',
        signers: [{ name: 'Erin Lee' }, { name: 'Max' }], effectiveDate: '2026-10-01' },
      { id: 'h2', kind: 'request', status: 'approved', statusLabel: 'Approved', at: '2026-10-13T17:00:00Z', from: 'Tester', to: 'Associate',
        reason: 'Covers month-end close', raisedBy: 'ada@x.com', raisedByName: 'Ada', raisedAt: '2026-10-12T17:00:00Z',
        decidedBy: 'max@x.com', decidedByName: 'Max', signers: [] },
    ]),
  },
}));

const { RoleChangeRequestCard, RoleChangeDecisionModal, RoleHistory } = await import('./RoleChangeRequests');

describe('RoleChangeRequestCard', () => {
  beforeEach(() => { approve.mockClear(); decline.mockClear(); });

  it('shows the reason and who it waits on; an approver approves', async () => {
    row = { ...base, canDecide: true, canCancel: false };
    const onDecided = vi.fn();
    render(<RoleChangeRequestCard employeeId="e1" onDecided={onDecided} toastOk={() => {}} toastErr={() => {}} />);
    await waitFor(() => expect(screen.getByText('Covers month-end close')).toBeTruthy());
    expect(screen.getByText(/Max \(Manager\) or Hana \(HR\)/)).toBeTruthy();
    expect(screen.queryByText('Cancel Request')).toBeNull();
    fireEvent.click(screen.getByText('Approve'));
    await waitFor(() => expect(onDecided).toHaveBeenCalled());
    expect(approve).toHaveBeenCalledWith('rq1');
  });

  it('the person who asked can only cancel', async () => {
    row = { ...base, canDecide: false, canCancel: true };
    render(<RoleChangeRequestCard employeeId="e1" toastOk={() => {}} toastErr={() => {}} />);
    await waitFor(() => expect(screen.getByText('Cancel Request')).toBeTruthy());
    expect(screen.queryByText('Approve')).toBeNull();
  });
});

describe('RoleChangeDecisionModal', () => {
  it('declines with a note', async () => {
    row = { ...base, canDecide: true, canCancel: false };
    const onDecided = vi.fn();
    render(<RoleChangeDecisionModal requestId="rq1" onClose={() => {}} onDecided={onDecided} toastOk={() => {}} toastErr={() => {}} />);
    await waitFor(() => expect(screen.getByText('Role Change - Erin Lee')).toBeTruthy());
    fireEvent.click(screen.getByText('Decline'));
    fireEvent.change(screen.getByPlaceholderText(/Why not/), { target: { value: 'Not this quarter' } });
    fireEvent.click(screen.getByText('Decline Request'));
    await waitFor(() => expect(onDecided).toHaveBeenCalled());
    expect(decline).toHaveBeenCalledWith('rq1', 'Not this quarter');
  });
});

describe('RoleHistory', () => {
  it('logs who raised each change, the reason, and who approved or signed', async () => {
    render(<RoleHistory employeeId="e1" />);
    await waitFor(() => expect(screen.getByText('Lead')).toBeTruthy());
    expect(screen.getByText(/Signed by Erin Lee, Max/)).toBeTruthy();
    expect(screen.getByText(/Raised by Ada/)).toBeTruthy();
    expect(screen.getByText(/Approved by Max/)).toBeTruthy();
    expect(screen.getByText('Covers month-end close')).toBeTruthy();
  });
});

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Render-smoke for the timesheet review panel (Sep 2026): the review hand-offs
// and the Nexus Sign signature that replaced one-click "Sign & submit".
// Oct 16: the manager's Review & Approve (no signature), then the employee's
// Approve & Sign - the employee is the only signer.

const submit = vi.fn(() => Promise.resolve({}));
const sendBack = vi.fn(() => Promise.resolve({}));
const approve = vi.fn(() => Promise.resolve({}));
const approvePeriod = vi.fn(() => Promise.resolve({}));
const sign = vi.fn(() => Promise.resolve({ status: 'signing', myPartyId: 'p-emp' }));
const finalizeUnsigned = vi.fn(() => Promise.resolve({ status: 'completed' }));
const downloadSign = vi.fn(() => Promise.resolve({ url: 'http://storage/signed.pdf' }));
const sendCorrection = vi.fn(() => Promise.resolve({ status: 'signing' }));
const relock = vi.fn(() => Promise.resolve({ status: 'completed' }));
vi.mock('../api', () => ({
  api: {
    timesheetReviewSubmit: (...a) => submit(...a),
    timesheetReviewSendBack: (...a) => sendBack(...a),
    timesheetReviewApprove: (...a) => approve(...a),
    timesheetReviewApprovePeriod: (...a) => approvePeriod(...a),
    timesheetReviewSign: (...a) => sign(...a),
    timesheetReviewFinalizeUnsigned: (...a) => finalizeUnsigned(...a),
    downloadSign: (...a) => downloadSign(...a),
    timesheetReviewSendCorrection: (...a) => sendCorrection(...a),
    timesheetReviewRelock: (...a) => relock(...a),
  },
}));
vi.mock('./ESign', () => ({ SignModal: ({ partyId }) => <div data-testid="sign-modal">{partyId}</div> }));

const TimesheetReviewPanel = (await import('./TimesheetReviewPanel')).default;
const nameFor = (e) => ({ 'mgr@x.com': 'Max', 'emp@x.com': 'Erin', 'hr@x.com': 'Hana' }[e] || e);
const base = { id: 'r1', managerEmail: 'mgr@x.com', employeeEmail: 'emp@x.com', rounds: [], parties: [] };
const props = { self: true, anchor: '2026-09-06', periodLabel: '09/06/2026 - 09/19/2026', nameFor, onChanged: () => {} };

// HR corrects a finalized period (Neil, Oct 22 2026): HR / Global Admin only,
// the employee signs the corrected card again, or HR re-locks it unchanged.
describe('TimesheetReviewPanel - HR correction', () => {
  const corr = { ...base, status: 'correcting', inCorrection: true,
    correction: { by: 'hr@x.com', at: '2026-10-22T15:00:00', reason: 'Wrong lunch on Monday', acceptBy: '' } };

  it('gives HR Send to Sign when the hours changed', async () => {
    render(<TimesheetReviewPanel {...props} self={false} review={{ ...corr, isHr: true, canSendCorrection: true, canRelock: false }} />);
    expect(screen.getByText(/Wrong lunch on Monday/)).toBeTruthy();
    expect(screen.queryByText('Re-lock (No Changes)')).toBeNull();
    fireEvent.click(screen.getByText('Send to Erin to Sign'));
    await waitFor(() => expect(sendCorrection).toHaveBeenCalledWith('r1'));
  });

  it('gives HR Re-lock when nothing changed', async () => {
    render(<TimesheetReviewPanel {...props} self={false} review={{ ...corr, isHr: true, canSendCorrection: false, canRelock: true }} />);
    expect(screen.queryByText('Send to Erin to Sign')).toBeNull();
    fireEvent.click(screen.getByText('Re-lock (No Changes)'));
    await waitFor(() => expect(relock).toHaveBeenCalledWith('r1'));
  });

  it('tells the manager and the employee, with no buttons', () => {
    const { unmount } = render(<TimesheetReviewPanel {...props} self={false} review={{ ...corr, isHr: false }} />);
    expect(screen.getByText(/Only HR can change it; Erin signs it again/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Re-lock|Send to|Review & Approve/ })).toBeNull();
    unmount();
    render(<TimesheetReviewPanel {...props} review={{ ...corr }} />);
    expect(screen.getByText(/You will be asked to review and sign it again/)).toBeTruthy();
  });

  it('shows the date a corrected card out to sign is accepted', () => {
    render(<TimesheetReviewPanel {...props} review={{ ...corr, status: 'signing', correction: { ...corr.correction, acceptBy: '2026-10-25T15:00:00' } }} />);
    expect(screen.getByText(/If it is not signed or declined by 10\/25\/2026, it is accepted as sent/)).toBeTruthy();
  });
});

describe('TimesheetReviewPanel', () => {
  it('lets the employee send a fresh time sheet to their manager', async () => {
    render(<TimesheetReviewPanel {...props} review={{ status: 'not_submitted', rounds: [], parties: [] }} />);
    fireEvent.change(screen.getByPlaceholderText(/Anything your manager/), { target: { value: 'All good' } });
    fireEvent.click(screen.getByText('Send to Manager'));
    await waitFor(() => expect(submit).toHaveBeenCalledWith('2026-09-06', 'All good'));
  });

  it('will not send a time sheet with punch errors, and says why (Oct 1)', () => {
    const why = 'Fix this on your time sheet before you submit it - 09/25/2026: no clock-out - add the out time.';
    render(<TimesheetReviewPanel {...props} review={{ status: 'not_submitted', rounds: [], parties: [], submitBlocker: why }} />);
    expect(screen.getByText(why)).toBeTruthy();
    expect(screen.getByText('Send to Manager').closest('button')).toBeDisabled();
  });

  it('lets the manager approve a time sheet nobody submitted (Oct 16)', async () => {
    render(<TimesheetReviewPanel {...props} self={false}
      review={{ status: 'not_submitted', employeeEmail: 'emp@x.com', canApprove: true, agreeBlocker: '', rounds: [], parties: [] }} />);
    fireEvent.click(screen.getByText('Review & Approve'));
    await waitFor(() => expect(approvePeriod).toHaveBeenCalledWith('emp@x.com', '2026-09-06', ''));
  });

  it('will not resubmit with punch errors either', () => {
    const why = 'Fix this on your time sheet before you submit it - 09/27/2026: a clock-out with no clock-in.';
    render(<TimesheetReviewPanel {...props}
      review={{ ...base, status: 'with_employee', canSubmit: true, submitBlocker: why, rounds: [{ note: 'Fix Sun' }] }} />);
    expect(screen.getByText(why)).toBeTruthy();
    expect(screen.getByText('Resubmit').closest('button')).toBeDisabled();
  });

  it('gives the manager Send Back (with a note) and Review & Approve', async () => {
    render(<TimesheetReviewPanel {...props} self={false}
      review={{ ...base, status: 'with_manager', canAgree: true, canApprove: true, canSendBack: true }} />);
    expect(screen.getByText('Send Back').closest('button')).toBeDisabled();   // needs a note
    fireEvent.change(screen.getByPlaceholderText(/What needs changing/), { target: { value: 'Fix Tue' } });
    fireEvent.click(screen.getByText('Send Back'));
    await waitFor(() => expect(sendBack).toHaveBeenCalledWith('r1', 'Fix Tue'));
    // The buttons stay disabled until Send Back settles (flaky on a slow CI, Sep 29).
    await waitFor(() => expect(screen.getByText('Review & Approve').closest('button')).not.toBeDisabled());
    fireEvent.click(screen.getByText('Review & Approve'));
    await waitFor(() => expect(approve).toHaveBeenCalledWith('r1', ''));
    expect(screen.queryByText(/Agree & Send for Signature/)).toBeNull();
  });

  it('shows the employee what the manager asked for', () => {
    render(<TimesheetReviewPanel {...props} review={{ ...base, status: 'with_employee', canSubmit: true,
      rounds: [{ at: '2026-09-20T10:00:00Z', by: 'mgr@x.com', action: 'sent_back', note: 'Lunch missing on Tue' }] }} />);
    expect(screen.getAllByText(/Lunch missing on Tue/).length).toBeGreaterThan(0);
    expect(screen.getByText('Resubmit')).toBeInTheDocument();
  });

  it('tells the manager up front why Approve is not available yet (Sep 29)', () => {
    render(<TimesheetReviewPanel {...props} self={false} review={{ ...base, status: 'with_manager', canAgree: true, canApprove: true, canSendBack: true,
      agreeBlocker: 'This period runs to 09/30/2026. You can approve it after that day, once every day is in.' }} />);
    expect(screen.getByRole('note')).toHaveTextContent('This period runs to 09/30/2026');
    expect(screen.getByText('Review & Approve').closest('button')).toBeDisabled();
  });

  it('after HR changed the hours the employee signs the updated time sheet', async () => {
    render(<TimesheetReviewPanel {...props} review={{ ...base, status: 'approved', canEmployeeApprove: true, canSubmit: true,
      agreedBy: 'mgr@x.com', agreedAt: '2026-09-20T17:00:00Z',
      approvalLog: ['Approved by Max (manager) on 09/20/2026 at 10:00 AM', 'Hours changed by Hana (HR) on 09/21/2026 at 9:00 AM'] }} />);
    expect(screen.getByText(/HR changed your hours after Max approved them/)).toBeInTheDocument();
    expect(screen.getByText('Hours changed by Hana (HR) on 09/21/2026 at 9:00 AM')).toBeInTheDocument();
    expect(screen.getByText('Not Right - Send Back').closest('button')).toBeDisabled();   // needs a note
    fireEvent.click(screen.getByText('Sign Updated Time Sheet'));
    await waitFor(() => expect(sign).toHaveBeenCalledWith('r1'));
    expect(await screen.findByTestId('sign-modal')).toHaveTextContent('p-emp');
  });

  it('the employee who disagrees sends it back to the manager with a note', async () => {
    render(<TimesheetReviewPanel {...props} review={{ ...base, status: 'approved', canEmployeeApprove: true, canSubmit: true }} />);
    fireEvent.change(screen.getByPlaceholderText(/What is wrong/), { target: { value: 'Tuesday is short' } });
    fireEvent.click(screen.getByText('Not Right - Send Back'));
    await waitFor(() => expect(submit).toHaveBeenCalledWith('2026-09-06', 'Tuesday is short'));
  });

  it('others wait for the employee, and HR is told about the override', () => {
    render(<TimesheetReviewPanel {...props} self={false} review={{ ...base, status: 'approved', isHr: true, agreedBy: 'mgr@x.com' }} />);
    expect(screen.getByText(/waiting for Erin to sign the updated time sheet/)).toBeInTheDocument();
    expect(screen.getByText(/As HR you can change these hours at any point/)).toBeInTheDocument();
    expect(screen.queryByText('Sign Updated Time Sheet')).toBeNull();
  });

  it('shows the approval and opens Nexus Sign for the employee, the only signer (Oct 16)', () => {
    render(<TimesheetReviewPanel {...props} review={{ ...base, status: 'signing', turn: 'employee', myPartyId: 'p-emp',
      agreedBy: 'mgr@x.com', agreedAt: '2026-09-20T10:00:00Z',
      parties: [{ role: 'employee', name: 'Erin', status: 'notified' }] }} />);
    expect(screen.getByText('Approval')).toBeInTheDocument();
    expect(screen.getByText(/Waiting for Erin/)).toBeInTheDocument();
    expect(screen.queryByText(/Manager Signature/)).toBeNull();
    fireEvent.click(screen.getByText('Sign & Submit'));
    expect(screen.getByTestId('sign-modal')).toHaveTextContent('p-emp');
  });

  it('shows a paper signature once the employee has signed', () => {
    render(<TimesheetReviewPanel {...props} self={false} review={{ ...base, status: 'completed',
      agreedBy: 'mgr@x.com', agreedAt: '2026-09-20T10:00:00Z',
      parties: [{ role: 'employee', name: 'Erin', status: 'signed', signedAt: '2026-09-20T11:00:00Z', signatureKind: 'paper' }] }} />);
    expect(screen.getByText('On Paper')).toBeInTheDocument();
    expect(screen.getByText(/finalized for payroll/)).toBeInTheDocument();
  });

  it('HR finalizes for someone who left, with a reason (Oct 17)', async () => {
    render(<TimesheetReviewPanel {...props} self={false} review={{ ...base, status: 'signing', isHr: true,
      periodStart: '2026-09-06', canFinalizeUnsigned: true, employeeLeft: true, agreedBy: 'mgr@x.com' }} />);
    const btn = screen.getByRole('button', { name: /Finalize Without Employee Signature/ });
    expect(btn).toBeDisabled();                      // a reason is required
    fireEvent.change(screen.getByPlaceholderText(/finalized without their signature/), { target: { value: 'Left on 09/25' } });
    fireEvent.click(btn);
    await waitFor(() => expect(finalizeUnsigned).toHaveBeenCalledWith('emp@x.com', '2026-09-06', 'Left on 09/25'));
  });

  it('HR is told why it cannot be finalized unsigned yet', () => {
    render(<TimesheetReviewPanel {...props} self={false} review={{ ...base, status: 'signing', isHr: true,
      canFinalizeUnsigned: false, finalizeUnsignedBlocker: 'Erin has until 09/24/2026 to sign.' }} />);
    expect(screen.getByText(/has until 09\/24\/2026/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Finalize Without/ })).toBeNull();
  });

  it('a manager never sees the unsigned finalize', () => {
    render(<TimesheetReviewPanel {...props} self={false} review={{ ...base, status: 'signing', agreedBy: 'mgr@x.com' }} />);
    expect(screen.queryByText(/Employee Not Signing/)).toBeNull();
  });

  it('says when HR finalized it without the signature', () => {
    render(<TimesheetReviewPanel {...props} review={{ ...base, status: 'completed',
      rounds: [{ at: '2026-09-25T10:00:00Z', by: 'hr@x.com', action: 'finalized_unsigned', note: 'Left' }] }} />);
    expect(screen.getByText(/without the employee's signature\./)).toBeInTheDocument();
    expect(screen.queryByText(/Approved and signed/)).toBeNull();
  });

  it('says so when it is finalized', () => {
    render(<TimesheetReviewPanel {...props} review={{ ...base, status: 'completed', parties: [] }} />);
    expect(screen.getByText(/finalized for payroll/)).toBeInTheDocument();
    expect(screen.queryByText('Open Signed Copy')).toBeNull();          // no envelope, no button
  });

  it('the approving manager opens the signed copy from the Time Sheet (Neil, Oct 20)', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<TimesheetReviewPanel {...props} self={false} review={{ ...base, status: 'completed', parties: [], signRequestId: 'env-1' }} />);
    expect(screen.getByText(/filed to the employee's HR folder/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Open Signed Copy'));
    await waitFor(() => expect(downloadSign).toHaveBeenCalledWith('env-1'));
    expect(open).toHaveBeenCalledWith('http://storage/signed.pdf', '_blank', 'noopener');
    open.mockRestore();
  });
});

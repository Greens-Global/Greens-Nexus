import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Timesheets to Review (Sep 29): the reviewer's list at the top of People > Time.
// Oct 16: Approve (the manager's Review & Approve - no signature), and rows
// for closed periods nobody submitted.

const waiting = vi.fn();
const approve = vi.fn();
const approvePeriod = vi.fn();
const sendBack = vi.fn();
const sign = vi.fn();
const bulk = vi.fn();
vi.mock('../api', () => ({
  api: {
    timesheetReviewWaiting: (...a) => waiting(...a),
    timesheetReviewApprove: (...a) => approve(...a),
    timesheetReviewApprovePeriod: (...a) => approvePeriod(...a),
    timesheetReviewSendBack: (...a) => sendBack(...a),
    timesheetReviewSign: (...a) => sign(...a),
    timesheetReviewApproveBulk: (...a) => bulk(...a),
  },
}));
vi.mock('../tasks/components', () => ({
  Modal: ({ title, children, footer }) => <div role="dialog" aria-label={title}>{children}{footer}</div>,
  Avatar: ({ email, name }) => <span data-testid="avatar" data-email={email} aria-label={name} />,
}));
vi.mock('./ESign', () => ({ SignModal: ({ partyId }) => <div data-testid="sign-modal">{partyId}</div> }));

const TimesheetsToReview = (await import('./TimesheetsToReview')).default;

const row = (over) => ({
  id: 'r1', employeeEmail: 'erin@x.com', name: 'Erin Test', periodStart: '2026-09-01', periodEnd: '2026-09-30',
  payType: 'fixed', workedMin: 9630, submittedAt: '2026-09-29T10:00:00+00:00', resubmitted: false, note: 'All in',
  agreeBlocker: '', reviewFlag: '', notSubmitted: false, ...over,
});

beforeEach(() => {
  waiting.mockReset().mockResolvedValue({ reviews: [row()] });
  approve.mockReset().mockResolvedValue({});
  approvePeriod.mockReset().mockResolvedValue({});
  sendBack.mockReset().mockResolvedValue({});
  sign.mockReset().mockResolvedValue({ myPartyId: 'p-new' });
  bulk.mockReset().mockResolvedValue({ approved: 2, skipped: 0, failed: 0, results: [] });
});

describe('TimesheetsToReview', () => {
  it("shows each person's photo in front of their name (Neil, Oct 19)", async () => {
    render(<TimesheetsToReview onOpen={() => {}} />);
    const name = await screen.findByText('Erin Test');
    const avatar = document.querySelector('[data-review="erin@x.com"] [data-testid="avatar"]');
    expect(avatar.getAttribute('data-email')).toBe('erin@x.com');
    // ...ahead of the name in reading order.
    expect(avatar.compareDocumentPosition(name) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('lists what is waiting and approves in one click', async () => {
    const toastOk = vi.fn();
    render(<TimesheetsToReview onOpen={() => {}} toastOk={toastOk} />);
    expect(await screen.findByText('Erin Test')).toBeTruthy();
    expect(screen.getByText('09/01/2026 - 09/30/2026 · 160h 30m · submitted 09/29/2026')).toBeTruthy();
    expect(screen.getByText('"All in"')).toBeTruthy();
    fireEvent.click(screen.getByText('Approve'));
    await waitFor(() => expect(approve).toHaveBeenCalledWith('r1', ''));
    expect(toastOk).toHaveBeenCalledWith('Approved - sent to Erin Test to sign.');
    await waitFor(() => expect(waiting).toHaveBeenCalledTimes(2));   // refreshed after deciding
  });

  it('approves a closed period nobody submitted, with no Send Back', async () => {
    waiting.mockResolvedValue({ reviews: [row({ id: '', notSubmitted: true, submittedAt: '', note: '' })] });
    render(<TimesheetsToReview onOpen={() => {}} />);
    expect(await screen.findByText(/not submitted - period closed/)).toBeTruthy();
    expect(screen.queryByText('Send Back')).toBeNull();
    // No stray note box under it (Oct 22: every unsubmitted row showed one, the last one focused).
    expect(screen.queryByPlaceholderText('What needs changing?')).toBeNull();
    fireEvent.click(screen.getByText('Approve'));
    await waitFor(() => expect(approvePeriod).toHaveBeenCalledWith('erin@x.com', '2026-09-01', ''));
    expect(approve).not.toHaveBeenCalled();
  });

  it('sends back with a note', async () => {
    render(<TimesheetsToReview onOpen={() => {}} />);
    fireEvent.click(await screen.findByText('Send Back'));
    fireEvent.change(screen.getByLabelText('What needs changing for Erin Test'), { target: { value: 'Tuesday lunch' } });
    fireEvent.click(screen.getByText('Send'));
    await waitFor(() => expect(sendBack).toHaveBeenCalledWith('r1', 'Tuesday lunch'));
  });

  it('says why Approve is not available yet, and Review opens the time sheet', async () => {
    waiting.mockResolvedValue({ reviews: [row({ agreeBlocker: 'This period runs to 09/30/2026. You can approve it after that day, once every day is in.' })] });
    const onOpen = vi.fn();
    render(<TimesheetsToReview onOpen={onOpen} />);
    expect(await screen.findByText(/This period runs to 09\/30\/2026/)).toBeTruthy();
    expect(screen.getByText('Approve').closest('button').disabled).toBe(true);
    fireEvent.click(screen.getByText('Review'));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ employeeEmail: 'erin@x.com', periodStart: '2026-09-01', payType: 'fixed' }));
  });

  it('a time sheet HR changed is on the sign card, and signing sends the fresh copy (Oct 17)', async () => {
    waiting.mockResolvedValue({ reviews: [], toSign: [{ id: 'r9', partyId: '', role: 'employee', employeeEmail: 'erin@x.com',
      name: 'Erin Test', periodStart: '2026-09-20', periodEnd: '2026-10-03', agreedBy: 'Max Test', agreedAt: '2026-10-05T10:00:00Z',
      needsResign: true }] });
    render(<TimesheetsToReview onOpen={() => {}} />);
    expect(await screen.findByText(/HR changed your time sheet - sign the updated one/)).toBeTruthy();
    fireEvent.click(screen.getByText('Sign Updated Time Sheet'));
    await waitFor(() => expect(sign).toHaveBeenCalledWith('r9'));
    expect(await screen.findByTestId('sign-modal')).toHaveTextContent('p-new');
  });

  it('renders nothing when nothing is waiting', async () => {
    waiting.mockResolvedValue({ reviews: [] });
    const { container } = render(<TimesheetsToReview onOpen={() => {}} />);
    await waitFor(() => expect(waiting).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  // Review All Clean (Neil, Oct 17; Oct 21: tick what you looked at, only ticked ones go).
  it('approves only the clean ones ticked as reviewed, and says what stays', async () => {
    waiting.mockResolvedValue({ reviews: [
      row(),
      row({ id: '', employeeEmail: 'ezra@x.com', name: 'Ezra Test', notSubmitted: true, submittedAt: '', note: '' }),
      row({ id: 'r3', employeeEmail: 'olive@x.com', name: 'Olive Test',
        reviewFlag: 'Look at this before approving - 09/03/2026: Unusually long shift (over 12h) - check for a missed punch.' }),
      row({ id: 'r4', employeeEmail: 'max@x.com', name: 'Max Test', agreeBlocker: 'Fix this on the time sheet before you can approve - 09/04/2026: no clock-out - add the out time. Or send it back to the employee to fix.',
        reviewFlag: 'Fix this on the time sheet before you can approve - 09/04/2026: no clock-out - add the out time. Or send it back to the employee to fix.' }),
    ] });
    bulk.mockResolvedValue({ approved: 1, skipped: 0, failed: 0, results: [] });
    const toastOk = vi.fn();
    const onOpen = vi.fn();
    render(<TimesheetsToReview onOpen={onOpen} toastOk={toastOk} />);
    fireEvent.click(await screen.findByText('Review All Clean (2)'));
    const dialog = screen.getByRole('dialog', { name: 'Review All Clean' });
    expect(dialog).toHaveTextContent('Tick each time sheet once you have looked it over.');
    expect(dialog.querySelector('[data-bulk="going"]')).toHaveTextContent(/Erin Test.*Ezra Test/);
    expect(dialog).toHaveTextContent('2 time sheets stay here for one-by-one review');
    expect(dialog.querySelector('[data-bulk="skipped"]')).toHaveTextContent(/Olive Test.*Unusually long shift/);
    expect(dialog.querySelector('[data-bulk="skipped"]')).toHaveTextContent(/Max Test.*no clock-out/);
    // Nothing goes until something is ticked.
    const go = screen.getByText('Approve Reviewed (0)').closest('button');
    expect(go.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('Reviewed - Ezra Test'));
    expect(bulk).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Approve Reviewed (1)'));
    await waitFor(() => expect(bulk).toHaveBeenCalledWith([{ email: 'ezra@x.com', start: '2026-09-01' }], ''));
    await waitFor(() => expect(toastOk).toHaveBeenCalledWith('1 time sheet approved and sent to sign.'));
    await waitFor(() => expect(waiting).toHaveBeenCalledTimes(2));   // the list refreshed
    expect(screen.queryByRole('dialog')).toBeNull();
    // Reopened: the ticks start fresh, and Open hands the row to the caller.
    fireEvent.click(await screen.findByText('Review All Clean (2)'));
    expect(screen.getByLabelText('Reviewed - Ezra Test').checked).toBe(false);
    fireEvent.click(screen.getAllByText('Open')[0]);
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ employeeEmail: 'erin@x.com', periodStart: '2026-09-01' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('reports skipped and failed ones from the server', async () => {
    bulk.mockResolvedValue({ approved: 0, skipped: 0, failed: 1, results: [{ id: 'r1', status: 'failed', error: 'Storage is down.' }] });
    const toastErr = vi.fn();
    render(<TimesheetsToReview onOpen={() => {}} toastErr={toastErr} />);
    fireEvent.click(await screen.findByText('Review All Clean (1)'));
    fireEvent.click(screen.getByLabelText('Reviewed - Erin Test'));
    fireEvent.click(screen.getByText('Approve Reviewed (1)'));
    await waitFor(() => expect(toastErr).toHaveBeenCalledWith('0 time sheets approved and sent to sign, 1 failed. Storage is down.'));
  });

  it('is disabled with the reason when nothing is clean', async () => {
    waiting.mockResolvedValue({ reviews: [row({ reviewFlag: 'Look at this before approving - 09/03/2026: Unusually long shift.' })] });
    render(<TimesheetsToReview onOpen={() => {}} />);
    const btn = (await screen.findByText('Review All Clean (0)')).closest('button');
    expect(btn.disabled).toBe(true);
    expect(screen.getByText(/Nothing to review in one pass/)).toBeTruthy();
    expect(screen.getByText(/Unusually long shift/)).toBeTruthy();       // the row says why
  });
});

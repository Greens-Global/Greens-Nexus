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
vi.mock('../api', () => ({
  api: {
    timesheetReviewWaiting: (...a) => waiting(...a),
    timesheetReviewApprove: (...a) => approve(...a),
    timesheetReviewApprovePeriod: (...a) => approvePeriod(...a),
    timesheetReviewSendBack: (...a) => sendBack(...a),
    timesheetReviewSign: (...a) => sign(...a),
  },
}));
vi.mock('./ESign', () => ({ SignModal: ({ partyId }) => <div data-testid="sign-modal">{partyId}</div> }));

const TimesheetsToReview = (await import('./TimesheetsToReview')).default;

const row = (over) => ({
  id: 'r1', employeeEmail: 'erin@x.com', name: 'Erin Test', periodStart: '2026-09-01', periodEnd: '2026-09-30',
  payType: 'fixed', workedMin: 9630, submittedAt: '2026-09-29T10:00:00+00:00', resubmitted: false, note: 'All in',
  agreeBlocker: '', notSubmitted: false, ...over,
});

beforeEach(() => {
  waiting.mockReset().mockResolvedValue({ reviews: [row()] });
  approve.mockReset().mockResolvedValue({});
  approvePeriod.mockReset().mockResolvedValue({});
  sendBack.mockReset().mockResolvedValue({});
  sign.mockReset().mockResolvedValue({ myPartyId: 'p-new' });
});

describe('TimesheetsToReview', () => {
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
    expect(await screen.findByText(/HR changed the hours - sign the updated time sheet/)).toBeTruthy();
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
});

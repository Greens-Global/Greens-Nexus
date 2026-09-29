import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Timesheets to Review (Sep 29): the reviewer's list at the top of People > Time.

const waiting = vi.fn();
const agree = vi.fn();
const sendBack = vi.fn();
vi.mock('../api', () => ({
  api: {
    timesheetReviewWaiting: (...a) => waiting(...a),
    timesheetReviewAgree: (...a) => agree(...a),
    timesheetReviewSendBack: (...a) => sendBack(...a),
  },
}));

const TimesheetsToReview = (await import('./TimesheetsToReview')).default;

const row = (over) => ({
  id: 'r1', employeeEmail: 'erin@x.com', name: 'Erin Test', periodStart: '2026-09-01', periodEnd: '2026-09-30',
  payType: 'fixed', workedMin: 9630, submittedAt: '2026-09-29T10:00:00+00:00', resubmitted: false, note: 'All in',
  agreeBlocker: '', ...over,
});

beforeEach(() => {
  waiting.mockReset().mockResolvedValue({ reviews: [row()] });
  agree.mockReset().mockResolvedValue({});
  sendBack.mockReset().mockResolvedValue({});
});

describe('TimesheetsToReview', () => {
  it('lists what is waiting and agrees in one click', async () => {
    const toastOk = vi.fn();
    render(<TimesheetsToReview onOpen={() => {}} toastOk={toastOk} />);
    expect(await screen.findByText('Erin Test')).toBeTruthy();
    expect(screen.getByText('09/01/2026 - 09/30/2026 · 160h 30m · submitted 09/29/2026')).toBeTruthy();
    expect(screen.getByText('"All in"')).toBeTruthy();
    fireEvent.click(screen.getByText('Agree'));
    await waitFor(() => expect(agree).toHaveBeenCalledWith('r1', ''));
    expect(toastOk).toHaveBeenCalledWith('Agreed - sent to Erin Test to sign.');
    await waitFor(() => expect(waiting).toHaveBeenCalledTimes(2));   // refreshed after deciding
  });

  it('sends back with a note', async () => {
    render(<TimesheetsToReview onOpen={() => {}} />);
    fireEvent.click(await screen.findByText('Send Back'));
    fireEvent.change(screen.getByLabelText('What needs changing for Erin Test'), { target: { value: 'Tuesday lunch' } });
    fireEvent.click(screen.getByText('Send'));
    await waitFor(() => expect(sendBack).toHaveBeenCalledWith('r1', 'Tuesday lunch'));
  });

  it('says why Agree is not available yet, and Review opens the timecard', async () => {
    waiting.mockResolvedValue({ reviews: [row({ agreeBlocker: 'This period runs to 09/30/2026. You can agree to it after that day, once every day is in.' })] });
    const onOpen = vi.fn();
    render(<TimesheetsToReview onOpen={onOpen} />);
    expect(await screen.findByText(/This period runs to 09\/30\/2026/)).toBeTruthy();
    expect(screen.getByText('Agree').closest('button').disabled).toBe(true);
    fireEvent.click(screen.getByText('Review'));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ employeeEmail: 'erin@x.com', periodStart: '2026-09-01', payType: 'fixed' }));
  });

  it('renders nothing when nothing is waiting', async () => {
    waiting.mockResolvedValue({ reviews: [] });
    const { container } = render(<TimesheetsToReview onOpen={() => {}} />);
    await waitFor(() => expect(waiting).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });
});

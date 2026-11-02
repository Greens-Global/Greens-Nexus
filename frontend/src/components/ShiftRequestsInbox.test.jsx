import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// Shifts > Requests, the time-off card (Neil, 11/02/2026): a request the
// manager decides carries a soft recommendation chip - "Recommended:
// Approve" or "Check First" - with the reasons as its title and a small
// line. It is a hint only: Approve and Decline are exactly what they were,
// and a request the viewer cannot decide shows no chip.

const timeOffDecide = vi.fn();
vi.mock('../ui/dialog', () => ({ dialog: { confirm: vi.fn().mockResolvedValue(true), prompt: vi.fn() } }));
vi.mock('../api', () => ({
  api: {
    shiftRequestDecide: vi.fn(),
    timeOffDecide: (...a) => timeOffDecide(...a),
    timeSchedule: vi.fn().mockResolvedValue({ shifts: [], timeoff: [], people: [] }),
    getPeopleDirectory: vi.fn().mockResolvedValue([{ email: 'amy@x.com', name: 'Amy Adams' }]),
    getRolesDirectory: vi.fn().mockResolvedValue([]),
  },
}));

const Inbox = (await import('./ShiftRequestsInbox')).default;

const inbox = { pending: [], waitingOnPeer: [], recent: [], photos: {}, settings: { releaseShifts: false, swaps: false, offers: false, openShifts: false } };
const base = { id: 'to1', email: 'amy@x.com', name: 'Amy Adams', type: 'vacation', startDate: '2026-11-16', endDate: '2026-11-17',
  status: 'pending', note: 'Trip', createdAt: '2026-11-02T10:00:00', canDecide: true };
const page = (timeoff) => render(<Inbox inbox={inbox} timeoff={timeoff} loading={false} error={null} onRetry={vi.fn()} onChanged={vi.fn()} toastOk={vi.fn()} toastErr={vi.fn()} />);

beforeEach(() => { timeOffDecide.mockReset(); });

describe('Shifts > Requests - time-off recommendation', () => {
  it('shows the chip with the reasons, and the buttons are unchanged', () => {
    const reasons = ['Balance is 8 h short.', 'Mia Test is also off 11/17/2026.'];
    page([{ ...base, recommendation: { tone: 'check', label: 'Check First', reasons } }]);
    const chip = screen.getByText('Check First');
    expect(chip.closest('.nx-label').getAttribute('title')).toBe(reasons.join(' '));
    expect(screen.getByText(reasons.join(' '))).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Decline' })).toBeTruthy();
    expect(timeOffDecide).not.toHaveBeenCalled();
  });

  it('shows Recommended: Approve for a clean request', () => {
    page([{ ...base, recommendation: { tone: 'good', label: 'Recommended: Approve', reasons: ['Requested 14 days ahead.'] } }]);
    expect(screen.getByText('Recommended: Approve')).toBeTruthy();
  });

  it('shows no chip when there is no recommendation (a request the viewer cannot decide)', () => {
    page([{ ...base, canDecide: false, own: true }]);
    expect(screen.getByText(/Trip/)).toBeTruthy();   // the card did render (its note)
    expect(screen.queryByText('Check First')).toBeNull();
    expect(screen.queryByText('Recommended: Approve')).toBeNull();
    expect(document.querySelector('.nx-label')).toBeNull();
  });
});

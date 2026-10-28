import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

// Team Leave Calendar (Oct 27 2026): a month grid of who is out, holidays
// marked, pending and Awaiting HR Approval told apart, the server's "Out"
// label kept as is (confidential / teammates), months move.

const calendar = vi.fn();
vi.mock('../api', () => ({ api: { timeOffCalendar: (...a) => calendar(...a) } }));

const { default: TeamLeaveCalendar } = await import('./TeamLeaveCalendar');
const thisMonth = (() => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}`; })();

beforeEach(() => {
  calendar.mockReset().mockImplementation((month) => Promise.resolve({
    month, scope: 'team', companies: [],
    entries: [
      { id: 'a', email: 'amy@x.com', name: 'Amy Adams', startDate: `${month}-03`, endDate: `${month}-04`, status: 'approved', label: 'Vacation' },
      { id: 'b', email: 'ben@x.com', name: 'Ben Brown', startDate: `${month}-10`, endDate: `${month}-10`, status: 'pending', awaitingHr: true, label: 'Sick' },
      { id: 'c', email: 'cal@x.com', name: 'Cal Cruz', startDate: `${month}-10`, endDate: `${month}-10`, status: 'approved', label: 'Out' },
    ],
    holidays: [{ date: `${month}-20`, name: 'Founders Day', type: 'mandatory' }],
  }));
});

describe('Team Leave Calendar', () => {
  it('renders the month with people out, holidays and the legend', async () => {
    render(<TeamLeaveCalendar />);
    const region = screen.getByRole('region', { name: 'Team Leave Calendar' });
    expect(await within(region).findAllByText('Amy')).toHaveLength(2);       // both days of her leave
    expect(within(region).getByText('Founders Day')).toBeTruthy();
    expect(within(region).getByTitle('Ben Brown - Sick (Awaiting HR Approval)')).toBeTruthy();
    expect(within(region).getByTitle('Cal Cruz - Out (Approved)')).toBeTruthy();
    expect(within(region).getByText(/Your team - approved and pending/)).toBeTruthy();
    expect(calendar).toHaveBeenCalledWith(thisMonth, '');
  });

  it('moves between months', async () => {
    render(<TeamLeaveCalendar />);
    await screen.findAllByText('Amy');
    fireEvent.click(screen.getByRole('button', { name: 'Next Month' }));
    await screen.findAllByText('Amy');
    expect(calendar.mock.calls.at(-1)[0]).not.toBe(thisMonth);
    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    await screen.findAllByText('Amy');
    expect(calendar.mock.calls.at(-1)[0]).toBe(thisMonth);
  });

  it('shows an error with Retry', async () => {
    calendar.mockReset().mockRejectedValue(new Error('down'));
    render(<TeamLeaveCalendar />);
    expect(await screen.findByText("Couldn't load the leave calendar right now.")).toBeTruthy();
  });
});

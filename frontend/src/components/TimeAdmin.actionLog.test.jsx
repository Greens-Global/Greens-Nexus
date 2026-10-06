import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// People > Time (Neil, 10/06): Attendance, Screenshots and By Location are gone;
// Punch Requests and Missing Punches are one Action Log, filterable by department.

const decide = vi.fn();
vi.mock('../api', () => ({
  api: {
    timeTeam: () => Promise.resolve({ rows: [] }),
    timeOffList: () => Promise.resolve([]),
    timeMonitoringAlerts: () => Promise.resolve({ alerts: [] }),
    timesheetReviewWaiting: () => Promise.resolve({ reviews: [] }),
    timePunchRequests: () => Promise.resolve([
      { id: 'q1', employeeEmail: 'amy@x.com', employeeName: 'Amy Ops', department: 'Operations', action: 'add', punchKind: 'out', at: '2026-10-01T23:00:00', reason: 'Manager meeting' },
    ]),
    timeExceptions: () => Promise.resolve([
      { email: 'nick@x.com', name: 'Nick Build', department: 'Construction', blocking: 1,
        exceptions: [{ date: '2026-10-05', type: 'missing_out', label: 'No clock-out - open shift, needs an out time', blocking: true }] },
    ]),
    timeDecidePunchRequest: (...a) => decide(...a),
    getPeopleDirectory: () => Promise.resolve([]),
  },
}));
vi.mock('./PayrollTimecard', () => ({ default: () => <div>timecard</div> }));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ hrTeam: false }) }));

const TimeAdmin = (await import('./TimeAdmin')).default;

beforeEach(() => { decide.mockReset().mockResolvedValue({}); });

describe('People > Time Action Log', () => {
  it('has only Payroll, Action Log and Time Off', async () => {
    render(<TimeAdmin toastOk={() => {}} toastErr={() => {}} />);
    expect(await screen.findByText('Action Log')).toBeTruthy();
    ['Attendance', 'Screenshots', 'By location', 'Punch requests', 'Missing punches'].forEach(t => expect(screen.queryByText(t)).toBeNull());
  });

  it('lists requests and missing punches together, filters by department, approves', async () => {
    const toastOk = vi.fn();
    render(<TimeAdmin toastOk={toastOk} toastErr={() => {}} initialView="actions" />);
    expect(await screen.findByText('Amy Ops')).toBeTruthy();
    expect(await screen.findByText('Nick Build')).toBeTruthy();
    expect(screen.getByText('"Manager meeting"')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Department'), { target: { value: 'Construction' } });
    expect(screen.queryByText('Amy Ops')).toBeNull();
    expect(screen.getByText('Nick Build')).toBeTruthy();
    expect(screen.getByText('Fix on Timecard')).toBeTruthy();

    fireEvent.click(screen.getByText('Clear Filters'));
    const card = screen.getByText('Amy Ops').closest('div[style*="border-radius: 14px"]');
    fireEvent.click(within(card).getByText('Approve'));
    await waitFor(() => expect(decide).toHaveBeenCalledWith('q1', { status: 'approved', note: '' }));
  });
});

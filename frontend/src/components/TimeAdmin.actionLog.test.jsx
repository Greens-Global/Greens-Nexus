import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// People > Time (Neil, 10/06): Attendance, Screenshots and By Location are gone;
// Punch Requests and Missing Punches are one Action Log, filterable by department.

const decide = vi.fn();
vi.mock('../api', () => ({
  api: {
    timeTeam: () => Promise.resolve({ rows: [] }),
    timeOffList: () => Promise.resolve([]),
    timeOffAwaitingHr: () => Promise.resolve([]),
    timeOffCalendar: () => Promise.resolve({ entries: [], holidays: [] }),
    timeMonitoringAlerts: () => Promise.resolve({ alerts: [] }),
    timesheetReviewWaiting: () => Promise.resolve({ reviews: [] }),
    timeDecidedPunchRequests: () => Promise.resolve([
      { id: 'd1', employeeEmail: 'amy@x.com', employeeName: 'Amy Ops', department: 'Operations', action: 'add', punchKind: 'in', at: '2026-10-02T15:00:00',
        reason: 'Doctor visit', status: 'approved', category: 'Sick', decidedBy: 'max@x.com', decidedByName: 'Max Lead', decidedAt: '2026-10-03T16:00:00Z',
        decisionNote: 'Type changed from Personal to Sick.', createdAt: '2026-10-02T20:00:00Z' },
    ]),
    timePunchRequests: () => Promise.resolve([
      { id: 'q1', employeeEmail: 'amy@x.com', employeeName: 'Amy Ops', department: 'Operations', action: 'add', punchKind: 'out', at: '2026-10-01T23:00:00', reason: 'Manager meeting' },
      // The same fix filed twice - one row (Visesh, Oct 7).
      { id: 'q2', employeeEmail: 'amy@x.com', employeeName: 'Amy Ops', department: 'Operations', action: 'add', punchKind: 'out', at: '2026-10-01T23:00:30', reason: 'Manager meeting' },
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
    expect(screen.getAllByText('"Manager meeting"')).toHaveLength(1);    // two copies, one row
    expect(screen.getByText('2 Requests - Same Punch')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Department'), { target: { value: 'Construction' } });
    expect(screen.queryByText('Amy Ops')).toBeNull();
    expect(screen.getByText('Nick Build')).toBeTruthy();
    expect(screen.getByText('Fix on Time Sheet')).toBeTruthy();

    fireEvent.click(screen.getByText('Clear Filters'));
    const card = screen.getByText('Amy Ops').closest('div[style*="border-radius: 14px"]');
    fireEvent.click(within(card).getByText('Approve'));
    await waitFor(() => expect(decide).toHaveBeenCalledWith('q1', { status: 'approved', note: '' }));
  });

  it('Decided keeps what was asked, who decided and the note (Neil, Oct 29 2026)', async () => {
    render(<TimeAdmin toastOk={() => {}} toastErr={() => {}} initialView="actions" />);
    await screen.findByText('Nick Build');
    fireEvent.click(screen.getByRole('tab', { name: /Decided/ }));
    const row = await screen.findByTestId('decided-request');
    expect(row).toHaveTextContent('Their reason: "Doctor visit"');
    expect(row).toHaveTextContent('Approved by Max Lead');
    expect(row).toHaveTextContent('Note: "Type changed from Personal to Sick."');
    expect(screen.queryByText('Nick Build')).toBeNull();          // the open work is on the other views
  });

    it('Teams opens a chat with the person, their items typed in (Oct 28)', async () => {
    render(<TimeAdmin toastOk={() => {}} toastErr={() => {}} initialView="actions" />);
    await screen.findByText('Nick Build');
    const card = screen.getByText('Nick Build').closest('div[style*="border-radius: 14px"]');
    const url = new URL(within(card).getByText('Teams').closest('a').href);
    expect(url.searchParams.get('users')).toBe('nick@x.com');
    expect(url.searchParams.get('message')).toBe(
      'Hi Nick, about your time sheet:\n- 10/05/2026: No clock-out - open shift, needs an out time\nCan we talk it through?');
  });

  it('takes a decided request off the list before the server answers (Oct 19)', async () => {
    decide.mockReset().mockReturnValue(new Promise(() => {}));   // the save never comes back
    render(<TimeAdmin toastOk={() => {}} toastErr={() => {}} initialView="actions" />);
    await screen.findByText('Amy Ops');
    const card = screen.getByText('Amy Ops').closest('div[style*="border-radius: 14px"]');
    fireEvent.click(within(card).getByText('Approve'));
    await waitFor(() => expect(screen.queryByText('"Manager meeting"')).toBeNull());   // both copies gone
    expect(decide).toHaveBeenCalledWith('q1', { status: 'approved', note: '' });
  });
});

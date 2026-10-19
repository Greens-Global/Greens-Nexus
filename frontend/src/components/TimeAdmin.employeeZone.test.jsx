import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// Oct 19: Miranda (Pacific) asked for an 8:30 AM clock-in and her approver in
// India read 9:00 PM - the Action Log used the viewer's browser zone. The row
// now reads on the employee's clock (the request's timeZone), labeled.
// The viewer here is in India.
process.env.TZ = 'Asia/Kolkata';

vi.mock('../api', () => ({
  api: {
    timeTeam: () => Promise.resolve({ rows: [] }),
    timeOffList: () => Promise.resolve([]),
    timeMonitoringAlerts: () => Promise.resolve({ alerts: [] }),
    timesheetReviewWaiting: () => Promise.resolve({ reviews: [] }),
    timePunchRequests: () => Promise.resolve([
      // 8:30 AM PDT on 10/17 = 15:30 UTC.
      { id: 'm1', employeeEmail: 'miranda@x.com', employeeName: 'Miranda West', department: 'Operations',
        action: 'add', punchKind: 'in', at: '2026-10-17T15:30:00', reason: 'Forgot to clock in', timeZone: 'America/Los_Angeles' },
    ]),
    timeExceptions: () => Promise.resolve([]),
    timeDecidePunchRequest: () => Promise.resolve({}),
    getPeopleDirectory: () => Promise.resolve([]),
  },
}));
vi.mock('./PayrollTimecard', () => ({ default: () => <div>timecard</div> }));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ hrTeam: false }) }));

const TimeAdmin = (await import('./TimeAdmin')).default;

describe("Action Log reads a punch request on the employee's clock", () => {
  it("shows a Pacific employee's 8:30 AM as 8:30 AM PT to a viewer in India", async () => {
    render(<TimeAdmin toastOk={() => {}} toastErr={() => {}} initialView="actions" />);
    const cell = await screen.findByText('10/17/2026, 8:30 AM PT');
    expect(cell.getAttribute('title')).toBe('Your time: 10/17/2026, 9:00 PM');
    expect(screen.queryByText(/9:00 PM$/)).toBeNull();
  });
});

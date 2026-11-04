import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// The Daily Briefing's "Review <name>'s Time Sheet" rows (11/05/2026: "it
// should open the time sheet for the specific people on which it's
// clicked"). The email links to People > Time with ?timecard=<email>&start=
// <period start>&type=<pay type>; the Payroll card must open on that person
// and that period, never on whoever sorts first.

vi.mock('../api', () => ({
  api: {
    timeTeam: () => Promise.resolve({ rows: [] }),
    timeOffList: () => Promise.resolve([]),
    timeOffAwaitingHr: () => Promise.resolve([]),
    timeOffCalendar: () => Promise.resolve({ entries: [], holidays: [] }),
    timeMonitoringAlerts: () => Promise.resolve({ alerts: [] }),
    timesheetReviewWaiting: () => Promise.resolve({ reviews: [], toSign: [] }),
    timePunchRequests: () => Promise.resolve([{ id: 'pr9', employeeEmail: 'bob@x.com', name: 'Bob', action: 'add',
      punchKind: 'out', localDate: '2026-11-02', reason: 'Forgot', status: 'pending', createdAt: '2026-11-03T00:00:00' }]),
    timeExceptions: () => Promise.resolve([]),
    getPeopleDirectory: () => Promise.resolve([]),
  },
}));
vi.mock('./PayrollTimecard', () => ({
  default: ({ initialEmail, initialStart, initialPayType }) => (
    <div data-testid="card">{`${initialEmail}|${initialStart}|${initialPayType}`}</div>
  ),
}));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ hrTeam: false, myEmail: 'hr@x.com' }) }));

const TimeAdmin = (await import('./TimeAdmin')).default;

afterEach(() => window.history.replaceState(null, '', '/'));

describe('People > Time opened from a briefing link', () => {
  it('opens the clicked person on the clicked period, then drops the link from the address', async () => {
    window.history.replaceState(null, '', '/hr/hr-time?timecard=kenneth%40x.com&start=2026-10-04&type=hourly');
    render(<TimeAdmin initialView="payroll" toastOk={() => {}} toastErr={() => {}} />);
    expect((await screen.findByTestId('card')).textContent).toBe('kenneth@x.com|2026-10-04|hourly');
    expect(window.location.search).toBe('');   // a reload does not reopen it
  });

  it('opens Punch Requests on the request a briefing row names, then drops the link', async () => {
    window.history.replaceState(null, '', '/hr/hr-time-requests?punchRequest=pr9');
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    render(<TimeAdmin initialView="actions" toastOk={() => {}} toastErr={() => {}} />);
    await waitFor(() => expect(document.getElementById('punch-req-pr9')).toBeTruthy());
    await waitFor(() => expect(scrolled).toHaveBeenCalled());
    expect(window.location.search).toBe('');
  });
});

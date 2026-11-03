import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// People > Time (Neil, Oct 20): the Team Hours and Time Sheets to Review
// summary tiles on top are gone - "unnecessary clutter, the information is
// already there". The Time Sheets to Review list itself stays first.

vi.mock('../api', () => ({
  api: {
    timeTeam: () => Promise.resolve({ rows: [{ email: 'amy@x.com', name: 'Amy', workedMin: 600, days: {} }] }),
    timeOffList: () => Promise.resolve([]),
    timeOffAwaitingHr: () => Promise.resolve([]),
    timeOffCalendar: () => Promise.resolve({ entries: [], holidays: [] }),
    timeMonitoringAlerts: () => Promise.resolve({ alerts: [] }),
    timesheetReviewWaiting: () => Promise.resolve({
      reviews: [{ id: 'r1', name: 'Nayeli Sanchez', employeeEmail: 'n@x.com', periodStart: '2026-10-04', periodEnd: '2026-10-17',
        payType: 'hourly', workedMin: 2850, submittedAt: '', note: '', resubmitted: false, agreeBlocker: '', reviewFlag: '' }],
      toSign: [],
    }),
    timePunchRequests: () => Promise.resolve([]),
    timeExceptions: () => Promise.resolve([]),
    getPeopleDirectory: () => Promise.resolve([]),
  },
}));
vi.mock('./PayrollTimecard', () => ({ default: () => <div>timecard</div> }));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ hrTeam: false, myEmail: 'hr@x.com' }) }));

const TimeAdmin = (await import('./TimeAdmin')).default;

describe('People > Time header', () => {
  // 11/03/2026 (Visesh): the review list is a collapsed alert line - title,
  // the count in red - and expands on click. Still no summary tiles.
  it('has no summary tiles - the review list is a collapsed alert that expands', async () => {
    const { fireEvent } = await import('@testing-library/react');
    render(<TimeAdmin toastOk={() => {}} toastErr={() => {}} />);
    const bar = await screen.findByRole('button', { name: /Time Sheets to Review/ });
    expect(bar.getAttribute('aria-expanded')).toBe('false');
    expect(bar.textContent).toContain('1');                                    // the count rides the bar
    expect(screen.queryByText('Nayeli Sanchez')).toBeNull();                   // collapsed by default
    fireEvent.click(bar);
    expect(await screen.findByText('Nayeli Sanchez')).toBeTruthy();            // expanded shows the list
    expect(screen.queryByText('Team Hours')).toBeNull();
    expect(screen.queryByText('Waiting on your review')).toBeNull();
    expect(screen.queryByTitle(/summary strip/)).toBeNull();
    expect(document.querySelector('.kpi-card')).toBeNull();
  });
});

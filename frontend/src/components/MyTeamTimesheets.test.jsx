import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';

// My Team's Timesheets (Pranshu, 10/06): a manager's history of their
// reports' timesheets in Workday - status, period, hours (never pay) - plus who
// has not submitted the current period. Filters by employee and status; a row
// opens that timesheet. Nothing for someone nobody reports to.

const TEAM = {
  reviews: [
    { id: 'r1', employeeEmail: 'erin@x.com', name: 'Erin Test', periodStart: '2026-09-13', periodEnd: '2026-09-26', status: 'with_manager', workedMin: 4800, submittedAt: '2026-09-27T10:00:00Z' },
    { id: 'r0', employeeEmail: 'erin@x.com', name: 'Erin Test', periodStart: '2026-08-30', periodEnd: '2026-09-12', status: 'completed', workedMin: 4500, submittedAt: '2026-09-13T10:00:00Z' },
    { id: 'r2', employeeEmail: 'raj@x.com', name: 'Raj Kumar', periodStart: '2026-09-13', periodEnd: '2026-09-26', status: 'with_employee', workedMin: 4000, submittedAt: '2026-09-27T09:00:00Z' },
  ],
  notSubmitted: [{ employeeEmail: 'li@x.com', name: 'Li Chen', periodStart: '2026-09-27', periodEnd: '2026-10-10', status: 'not_submitted' }],
};
vi.mock('../api', () => ({ api: { timesheetReviewTeam: () => Promise.resolve(globalThis.__team) } }));

afterEach(cleanup);

describe("My Team's Timesheets", () => {
  it('lists the history with status and hours, filters, and opens a row', async () => {
    globalThis.__team = TEAM;
    const onOpen = vi.fn();
    const { default: MyTeamTimesheets } = await import('./MyTeamTimesheets');
    render(<MyTeamTimesheets onOpen={onOpen} />);
    expect(await screen.findByText("My Team's Timesheets")).toBeTruthy();
    // The status cell (and the filter option of the same name).
    expect(screen.getAllByText('Waiting on You').length).toBe(2);
    expect(screen.getAllByText('Back With Employee').length).toBe(2);
    expect(screen.getByText(/Not submitted yet for the current period: Li Chen/)).toBeTruthy();
    expect(screen.getByText('80h 00m')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: 'completed' } });
    const table = screen.getByRole('table');
    expect(within(table).queryByText('Raj Kumar')).toBeNull();
    fireEvent.click(within(table).getByText('Erin Test'));
    expect(onOpen).toHaveBeenCalledWith('r0');
  });

  it('renders nothing for someone nobody reports to', async () => {
    globalThis.__team = { reviews: [], notSubmitted: [] };
    const { default: MyTeamTimesheets } = await import('./MyTeamTimesheets');
    const { container } = render(<MyTeamTimesheets onOpen={() => {}} />);
    await new Promise((r) => setTimeout(r, 10));
    expect(container.textContent).toBe('');
  });
});

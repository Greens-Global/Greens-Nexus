import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Oct 20: People > Time showed and edited punches on the VIEWER's clock - a
// manager in India read a Pacific employee's 8:30 AM clock-in as 9:00 PM, and
// typing 9:00 AM into Adjust saved 9:00 AM India time. Both now use the
// employee's zone (the team row's timeZone). The viewer here is in India.
process.env.TZ = 'Asia/Kolkata';

const adjust = vi.fn(() => Promise.resolve({}));
const add = vi.fn(() => Promise.resolve({}));
// 8:30 AM PDT on 10/17 = 15:30 UTC (9:00 PM IST).
const ROW = {
  email: 'miranda@x.com', name: 'Miranda West', timeZone: 'America/Los_Angeles',
  workedMin: 480, breakMin: 0, flagCount: 0, pendingEdits: 0, days: {
    '2026-10-17': { workedMin: 480, breakMin: 0, flags: [], punches: [
      { id: 'pt1', kind: 'in', at: '2026-10-17T15:30:00', source: 'web', voided: 0 },
    ] },
  },
};

vi.mock('../api', () => ({
  api: {
    timeTeam: () => Promise.resolve({ rows: [ROW] }),
    timeOffList: () => Promise.resolve([]),
    timeOffAwaitingHr: () => Promise.resolve([]),
    timeOffCalendar: () => Promise.resolve({ entries: [], holidays: [] }),
    timeMonitoringAlerts: () => Promise.resolve({ alerts: [] }),
    timesheetReviewWaiting: () => Promise.resolve({ reviews: [] }),
    timePunchRequests: () => Promise.resolve([]),
    timeExceptions: () => Promise.resolve([]),
    timeOffTypes: () => Promise.resolve([]),
    getPeopleDirectory: () => Promise.resolve([]),
    timeAdjustPunch: (...a) => adjust(...a),
    timeAddPunch: (...a) => add(...a),
  },
}));
vi.mock('./PayrollTimecard', () => ({ default: () => <div>timecard</div> }));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ hrTeam: false }) }));

const TimeAdmin = (await import('./TimeAdmin')).default;

async function openRow() {
  render(<TimeAdmin toastOk={() => {}} toastErr={() => {}} initialView="timecards" />);
  fireEvent.click(await screen.findByText('miranda@x.com'));
}

describe("People > Time reads and edits punches on the employee's clock", () => {
  beforeEach(() => { adjust.mockClear(); add.mockClear(); });

  it("shows a Pacific employee's 8:30 AM as 8:30 AM PT to a viewer in India", async () => {
    await openRow();
    expect(await screen.findByText('8:30 AM PT', { exact: false })).toBeTruthy();
    expect(screen.queryByText(/9:00 PM/)).toBeNull();
  });

  it('shows the same time in the person drawer day row', async () => {
    render(<TimeAdmin toastOk={() => {}} toastErr={() => {}} initialView="timecards" />);
    fireEvent.click(await screen.findByText('Miranda West'));
    fireEvent.click(await screen.findByText(/Sat, Oct 17/));
    expect(await screen.findByText('8:30 AM PT', { exact: false })).toBeTruthy();
  });

  it('opens Adjust at 8:30 AM employee time and saves 9:00 AM PT as 16:00 UTC', async () => {
    await openRow();
    fireEvent.click(await screen.findByTitle('Adjust / void'));
    const input = await screen.findByDisplayValue('2026-10-17T08:30');
    expect(screen.getByText("Time (PT, the employee's clock)")).toBeTruthy();
    fireEvent.change(input, { target: { value: '2026-10-17T09:00' } });
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(adjust).toHaveBeenCalled());
    expect(adjust.mock.calls[0][0]).toBe('pt1');
    expect(adjust.mock.calls[0][1].at).toBe('2026-10-17T16:00:00');
  });

  it("adds a punch typed on the employee's clock with their zone's offset on that date", async () => {
    await openRow();
    fireEvent.click(await screen.findByText(/Add punch/));
    const inputs = document.querySelectorAll('input[type="datetime-local"]');
    fireEvent.change(inputs[inputs.length - 1], { target: { value: '2026-12-01T09:00' } });
    fireEvent.click(screen.getByRole('button', { name: /^Add$/ }));
    await waitFor(() => expect(add).toHaveBeenCalled());
    // 9:00 AM PST (winter, offset 480) = 17:00 UTC.
    expect(add.mock.calls[0][0]).toMatchObject({ at: '2026-12-01T17:00:00', tz_offset_min: 480 });
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// People > Time > Time Off (Charmi, Oct 20): status chips with counts, opening
// on Pending, and sortable Requested By / Period / Status headers.

const ROWS = [
  { id: 'a', email: 'amy@x.com', name: 'Amy Approved', type: 'vacation', status: 'approved', startDate: '2026-10-10', endDate: '2026-10-10', approver: 'hr@x.com' },
  { id: 'b', email: 'ben@x.com', name: 'Ben Pending', type: 'sick', status: 'pending', startDate: '2026-10-08', endDate: '2026-10-08' },
  { id: 'c', email: 'cal@x.com', name: 'Cal Rejected', type: 'vacation', status: 'rejected', startDate: '2026-10-06', endDate: '2026-10-06' },
  { id: 'd', email: 'dee@x.com', name: 'Dee Pending', type: 'vacation', status: 'pending', startDate: '2026-10-04', endDate: '2026-10-04' },
  { id: 'e', email: 'eve@x.com', name: 'Eve Approved', type: 'vacation', status: 'approved', startDate: '2026-10-02', endDate: '2026-10-02' },
];
let rowsForTest = ROWS;   // the period describe swaps in its own list

vi.mock('../api', () => ({
  api: {
    timeTeam: () => Promise.resolve({ rows: [] }),
    timeOffList: () => Promise.resolve(rowsForTest),
    timeOffAwaitingHr: () => Promise.resolve([]),
    timeOffCalendar: () => Promise.resolve({ entries: [], holidays: [] }),
    timeMonitoringAlerts: () => Promise.resolve({ alerts: [] }),
    timesheetReviewWaiting: () => Promise.resolve({ reviews: [] }),
    timePunchRequests: () => Promise.resolve([]),
    timeExceptions: () => Promise.resolve([]),
    getPeopleDirectory: () => Promise.resolve([]),
  },
}));
vi.mock('./PayrollTimecard', () => ({ default: () => <div>timecard</div> }));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ hrTeam: false, myEmail: 'hr@x.com' }) }));

const TimeAdmin = (await import('./TimeAdmin')).default;
const NAMES = ['Amy Approved', 'Ben Pending', 'Cal Rejected', 'Dee Pending', 'Eve Approved'];
const shownNames = () => NAMES
  .map(n => [n, screen.queryByText(n)])
  .filter(([, el]) => el)
  .sort(([, a], [, b]) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
  .map(([n]) => n);

beforeEach(() => { rowsForTest = ROWS; try { localStorage.clear(); } catch { /* none */ } });

describe('People > Time > Time Off status filter', () => {
  it('opens on Pending with the right counts, and shows only pending rows', async () => {
    render(<TimeAdmin toastOk={() => {}} toastErr={() => {}} initialView="timeoff" />);
    expect(await screen.findByText('Ben Pending')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'All (5)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Pending (2)' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Approved (2)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Rejected (1)' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Cancelled/ })).toBeNull();   // none to show
    expect(shownNames()).toEqual(['Ben Pending', 'Dee Pending']);

    fireEvent.click(screen.getByRole('button', { name: 'Approved (2)' }));
    expect(shownNames()).toEqual(['Amy Approved', 'Eve Approved']);
    expect(localStorage.getItem('nexus.timeadmin.timeoffFilter.hr@x.com')).toBe('approved');
  });

  it('remembers the chip per viewer', async () => {
    localStorage.setItem('nexus.timeadmin.timeoffFilter.hr@x.com', 'rejected');
    render(<TimeAdmin toastOk={() => {}} toastErr={() => {}} initialView="timeoff" />);
    expect(await screen.findByText('Cal Rejected')).toBeTruthy();
    expect(shownNames()).toEqual(['Cal Rejected']);
  });

  it('sorts by Status when the header is clicked, stable within a status', async () => {
    render(<TimeAdmin toastOk={() => {}} toastErr={() => {}} initialView="timeoff" />);
    await screen.findByText('Ben Pending');
    fireEvent.click(screen.getByRole('button', { name: 'All (5)' }));
    expect(shownNames()).toEqual(NAMES);   // server order

    fireEvent.click(screen.getByRole('button', { name: /^Status/ }));
    expect(shownNames()).toEqual(['Ben Pending', 'Dee Pending', 'Amy Approved', 'Eve Approved', 'Cal Rejected']);
    expect(screen.getByRole('button', { name: /^Status/ }).getAttribute('aria-sort')).toBe('ascending');

    fireEvent.click(screen.getByRole('button', { name: /^Status/ }));
    expect(shownNames()).toEqual(['Cal Rejected', 'Amy Approved', 'Eve Approved', 'Ben Pending', 'Dee Pending']);

    fireEvent.click(screen.getByRole('button', { name: /^Period/ }));
    expect(shownNames()).toEqual([...NAMES].reverse());   // oldest start first
  });
});

// Year / Month selects (Neil, Oct 21): the chip counts follow the period.
describe('People > Time > Time Off period filter', () => {
  it('filters by year and month, counts follow, empty state says so', async () => {
    rowsForTest = [
      ...ROWS,
      { id: 'f', email: 'fay@x.com', name: 'Fay Approved', type: 'vacation', status: 'approved', startDate: '2025-12-29', endDate: '2026-01-02' },
    ];
    render(<TimeAdmin toastOk={() => {}} toastErr={() => {}} initialView="timeoff" />);
    await screen.findByText('Ben Pending');
    fireEvent.click(screen.getByRole('button', { name: 'All (6)' }));
    const year = screen.getByRole('combobox', { name: 'Year' });
    const month = screen.getByRole('combobox', { name: 'Month' });
    expect([...year.options].map(o => o.textContent)).toEqual(['All Years', '2026', '2025']);
    expect(month.options.length).toBe(13);

    fireEvent.change(year, { target: { value: '2025' } });
    expect(screen.getByRole('button', { name: 'All (1)' })).toBeTruthy();   // the straddling row
    expect(screen.getByText('Fay Approved')).toBeTruthy();
    expect(screen.queryByText('Ben Pending')).toBeNull();

    fireEvent.change(year, { target: { value: '2026' } });
    fireEvent.change(month, { target: { value: '01' } });
    expect(screen.getByRole('button', { name: 'All (1)' })).toBeTruthy();   // Fay spills into Jan 2026
    fireEvent.change(month, { target: { value: '10' } });
    expect(screen.getByRole('button', { name: 'Pending (2)' })).toBeTruthy();

    fireEvent.change(month, { target: { value: '03' } });
    expect(screen.getByText('No requests in that period.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show All' }));
    expect(screen.getByRole('button', { name: 'All (6)' })).toBeTruthy();
    expect(year.value).toBe('');
  });
});

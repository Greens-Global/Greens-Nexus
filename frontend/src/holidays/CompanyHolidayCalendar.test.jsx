import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within, waitFor } from '@testing-library/react';

// A company's Holiday Calendar (Oct 29 2026): policy holidays with their
// policy chip, skip / change / reset for this company alone, the observed
// hint on an older row, and assigning a policy.

const CAL = {
  policies: [{ id: 'p1', name: 'US Holidays', weekendRule: 'keep', skipped: ['US:labor-day:2027'] }],
  holidays: [
    { id: 'h1', date: '2027-07-05', actualDate: '2027-07-04', weekday: 'Monday', name: 'Independence Day', type: 'mandatory', countries: ['US'],
      source: 'policy', policyId: 'p1', policyName: 'US Holidays', policyKey: 'US:independence-day:2027', overridden: true, observedHint: '' },
    { id: 'h2', date: '2027-02-15', actualDate: '', weekday: 'Monday', name: "Presidents' Day", type: 'mandatory', countries: ['US'],
      source: 'policy', policyId: 'p1', policyName: 'US Holidays', policyKey: 'US:presidents-day:2027', overridden: false, observedHint: '' },
    { id: 'h3', date: '2027-12-24', actualDate: '', weekday: 'Friday', name: 'Christmas Day', type: 'mandatory', countries: ['US'],
      source: 'public', policyId: '', policyName: '', policyKey: '', overridden: false,
      observedHint: 'Christmas Day is 12/25/2027, a Saturday - this company takes 12/24/2027.' },
    { id: 'h4', date: '2027-03-17', actualDate: '', weekday: 'Wednesday', name: 'Founders Day', type: 'optional', countries: [],
      source: 'manual', policyId: '', policyName: '', policyKey: '', overridden: false, observedHint: '' },
  ],
  skipped: [{ policyId: 'p1', policyName: 'US Holidays', key: 'US:labor-day:2027', date: '2027-09-06', name: 'Labor Day' }],
  available: [{ id: 'p2', name: 'India Holidays' }],
};

const api = vi.hoisted(() => ({
  getHolidayCalendar: vi.fn(),
  getPublicHolidays: vi.fn(() => Promise.resolve({ country: 'US', year: 2027, holidays: [] })),
  assignHolidayPolicy: vi.fn(),
  unassignHolidayPolicy: vi.fn(),
  skipPolicyHoliday: vi.fn(),
  updateCompanyHoliday: vi.fn(),
  resetCompanyHoliday: vi.fn(() => Promise.resolve({})),
  createCompanyHoliday: vi.fn(() => Promise.resolve({})),
  deleteCompanyHoliday: vi.fn(() => Promise.resolve({})),
}));
vi.mock('../api', () => ({ api }));
const confirm = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
vi.mock('../ui/dialog', () => ({ dialog: { confirm: (...a) => confirm(...a), alert: () => Promise.resolve() } }));

const CompanyHolidayCalendar = (await import('./CompanyHolidayCalendar')).default;
const ENTITY = { id: 'e1', name: 'Greens Global', country: 'US' };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2027, 0, 10, 9, 0));
  api.getHolidayCalendar.mockResolvedValue(CAL);
  api.assignHolidayPolicy.mockResolvedValue(CAL);
  api.unassignHolidayPolicy.mockResolvedValue(CAL);
  api.skipPolicyHoliday.mockResolvedValue(CAL);
  api.updateCompanyHoliday.mockResolvedValue({ id: 'h2', type: 'half_day', calendar: CAL });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });

async function open() {
  const props = { toastOk: vi.fn(), toastErr: vi.fn() };
  render(<CompanyHolidayCalendar entity={ENTITY} {...props} />);
  await screen.findByRole('region', { name: 'From Policies' });
  return props;
}
const rowOf = (name) => document.querySelector(`[data-holiday="${name}"]`);

describe('CompanyHolidayCalendar', () => {
  it('lists policy holidays with their policy chip, and the company\'s own apart', async () => {
    await open();
    expect(api.getHolidayCalendar).toHaveBeenCalledWith('e1', 2027);
    const fromPolicies = screen.getByRole('region', { name: 'From Policies' });
    const july = within(rowOf('Independence Day'));
    expect(within(fromPolicies).getByText('Independence Day')).toBeInTheDocument();
    expect(july.getByText('US Holidays')).toBeInTheDocument();
    expect(july.getByText('07/05/2027')).toBeInTheDocument();
    expect(july.getByText('Monday')).toBeInTheDocument();
    expect(july.getByText('Holiday is 07/04/2027 (Sunday)')).toBeInTheDocument();
    const own = screen.getByRole('region', { name: "This Company's Own" });
    expect(within(own).getByText('Founders Day')).toBeInTheDocument();
    expect(within(rowOf('Founders Day')).getByText('Added By Hand')).toBeInTheDocument();
    expect(within(rowOf('Christmas Day')).getByText('Public')).toBeInTheDocument();
  });

  it('skips a policy holiday for this company only', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: "Skip Presidents' Day For This Company" }));
    await waitFor(() => expect(api.skipPolicyHoliday).toHaveBeenCalledWith('e1', 'p1', 'US:presidents-day:2027', true, 2027));
  });

  it('marks an overridden row Changed For This Company, and Reset To Policy puts it back', async () => {
    await open();
    const july = within(rowOf('Independence Day'));
    expect(july.getByText('Changed For This Company')).toBeInTheDocument();
    expect(within(rowOf("Presidents' Day")).queryByText('Changed For This Company')).not.toBeInTheDocument();
    fireEvent.click(july.getByRole('button', { name: /Reset To Policy/ }));
    await waitFor(() => expect(api.resetCompanyHoliday).toHaveBeenCalledWith('e1', 'h1', 2027));
    await waitFor(() => expect(api.getHolidayCalendar).toHaveBeenCalledTimes(2));
  });

  it('shows the observed hint with a Change Date action', async () => {
    await open();
    const xmas = within(rowOf('Christmas Day'));
    expect(xmas.getByText(/Christmas Day is 12\/25\/2027, a Saturday - this company takes 12\/24\/2027/)).toBeInTheDocument();
    fireEvent.click(xmas.getByRole('button', { name: 'Change Date' }));
    expect(xmas.getByText('New date for this company')).toBeInTheDocument();
  });

  it('changes a type for this company', async () => {
    await open();
    fireEvent.change(screen.getByLabelText("Type for Presidents' Day"), { target: { value: 'half_day' } });
    await waitFor(() => expect(api.updateCompanyHoliday).toHaveBeenCalledWith('e1', 'h2', { type: 'half_day' }, 2027));
    // The PATCH answers the row with the calendar beside it - no second read.
    expect(api.getHolidayCalendar).toHaveBeenCalledTimes(1);
  });

  it('assigns a policy, unassigns one, and restores a skipped holiday', async () => {
    const props = await open();
    fireEvent.change(screen.getByLabelText('Assign A Policy'), { target: { value: 'p2' } });
    await waitFor(() => expect(api.assignHolidayPolicy).toHaveBeenCalledWith('e1', 'p2', 2027));
    await waitFor(() => expect(props.toastOk).toHaveBeenCalledWith('India Holidays assigned to Greens Global.'));

    const skipped = screen.getByRole('region', { name: 'Skipped For This Company' });
    fireEvent.click(within(skipped).getByRole('button', { name: 'Restore Labor Day' }));
    await waitFor(() => expect(api.skipPolicyHoliday).toHaveBeenCalledWith('e1', 'p1', 'US:labor-day:2027', false, 2027));

    fireEvent.click(screen.getByRole('button', { name: 'Unassign US Holidays' }));
    await waitFor(() => expect(api.unassignHolidayPolicy).toHaveBeenCalledWith('e1', 'p1', 2027));
    expect(confirm.mock.calls[0][1].title).toBe('Unassign US Holidays?');
  });
});

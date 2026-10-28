import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';

// People > Analytics (Oct 27 2026): the screen renders every card from the
// server's numbers, opens the people behind a count, shows money only when
// the server says the caller may see it, and never renders blank on an error.

const months = ['2026-08', '2026-09', '2026-10'];
const SUMMARY = {
  range: { from: '2026-08', to: '2026-10', months }, today: '2026-10-27', timeZone: 'America/Los_Angeles',
  canSeeMoney: false, people: 6, dataQuality: { noStartDate: 1, leftUndated: 0 },
  companies: [{ id: 'co-a', name: 'Greens US' }, { id: 'co-b', name: 'Greens India' }],
  headcount: {
    now: 4, average: 4.7,
    months: months.map((m, i) => ({ month: m, asOf: m === '2026-10' ? '2026-10-27' : `${m}-30`, total: 5 - i,
      byCompany: [{ label: 'Greens US', n: 3 }, { label: 'Greens India', n: 1 }],
      byDepartment: [{ label: 'Ops', n: 4 }], byType: [{ label: 'Full-Time', n: 4 }] })),
  },
  flow: { joiners: 2, leavers: 3, rehires: 1, months: months.map((m) => ({ month: m, joiners: 1, leavers: 1, rehires: 0 })) },
  attrition: {
    months: months.map((m) => ({ month: m, leavers: 1, avgHeadcount: 5, rate: 20, voluntaryRate: 20, involuntaryRate: 0, otherRate: 0,
      trailing12: 72.2, trailing12Voluntary: 36.1, trailing12Involuntary: 18, trailing12Leavers: 4 })),
    byCategory: [{ key: 'voluntary', label: 'Voluntary', n: 2 }, { key: 'involuntary', label: 'Involuntary', n: 1 },
      { key: 'other', label: 'Other', n: 0 }, { key: 'not_recorded', label: 'Not Recorded', n: 1 }],
    range: { leavers: 3, avgHeadcount: 5, rate: 60 }, trailing12: { trailing12: 72.2, trailing12Voluntary: 36.1, trailing12Involuntary: 18 },
  },
  tenure: { total: 4, bands: [{ key: 'lt6m', label: 'Under 6 Months', n: 1 }, { key: '2to5y', label: '2-5 Years', n: 2 }, { key: 'unknown', label: 'Start Not Recorded', n: 1 }] },
  absence: {
    days: 10.75, unplannedSick: 1.5,
    months: months.map((m) => ({ month: m, days: 3, unplannedSick: 0.5, byReason: { vacation: 2, sick: 1, personal: 0, other: 0 } })),
    byReason: [{ key: 'vacation', label: 'Vacation', days: 6 }, { key: 'sick', label: 'Sick', days: 3 },
      { key: 'personal', label: 'Personal', days: 0 }, { key: 'other', label: 'Other', days: 1 }],
  },
  liability: { unit: 'hours', hours: 144, people: 3 },
};
const MONEY = { ...SUMMARY, canSeeMoney: true,
  liability: { unit: 'hours', hours: 144, people: 3, noRate: 1,
    byCurrency: [{ currency: 'INR', amount: 28800, hours: 96, people: 1 }, { currency: 'USD', amount: 800, hours: 40, people: 1 }] } };
const PEOPLE = { title: 'Unplanned Sick - Sep 2026', total: 1,
  rows: [{ id: 'emp-ann', name: 'Ann Test', sub: 'Greens US · Ops · Full-Time', detail: '1.5 days (09/14/2026 - 09/28/2026)', value: 1.5 }] };

const getHrAnalytics = vi.fn();
const getHrAnalyticsPeople = vi.fn();
vi.mock('../api', () => ({
  api: {
    getHrAnalytics: (...a) => getHrAnalytics(...a),
    getHrAnalyticsPeople: (...a) => getHrAnalyticsPeople(...a),
  },
}));

import HrAnalytics from './HrAnalytics';

beforeEach(() => {
  getHrAnalytics.mockReset();
  getHrAnalyticsPeople.mockReset();
  getHrAnalyticsPeople.mockResolvedValue(PEOPLE);
});
afterEach(() => cleanup());

describe('People Analytics', () => {
  it('renders every card from the server numbers', async () => {
    getHrAnalytics.mockResolvedValue(SUMMARY);
    render(<HrAnalytics />);
    for (const title of ['Headcount', 'Joiners And Leavers', 'Attrition', 'Tenure', 'Absence', 'Leave Liability']) {
      expect(await screen.findByRole('region', { name: title })).toBeTruthy();
    }
    expect(screen.getByText('72.2%')).toBeTruthy();
    expect(screen.getByText('10.75')).toBeTruthy();
    expect(screen.getByText(/1 person has no start date/)).toBeTruthy();
    expect(screen.getByText('Split On 10/27/2026')).toBeTruthy();
    // No money for a caller without the Compensation grant.
    expect(screen.queryByText(/Owed In/)).toBeNull();
    expect(screen.getByText(/Amounts show to people with the Compensation grant/)).toBeTruthy();
    expect(getHrAnalytics).toHaveBeenCalledWith({ company: '', type: 'employees', from_month: '', to_month: '' });
  });

  it('opens the people behind a count and the person from the list', async () => {
    getHrAnalytics.mockResolvedValue(SUMMARY);
    const onOpenPerson = vi.fn();
    render(<HrAnalytics onOpenPerson={onOpenPerson} />);
    fireEvent.click(await screen.findByRole('button', { name: /Unplanned Sick Days/ }));
    const dialog = await screen.findByRole('dialog');
    expect(getHrAnalyticsPeople).toHaveBeenCalledWith(expect.objectContaining({ metric: 'absence', key: 'unplanned', month: '' }));
    expect(await within(dialog).findByText('Ann Test')).toBeTruthy();
    expect(within(dialog).getByText('1.5 days (09/14/2026 - 09/28/2026)')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: /Ann Test/ }));
    expect(onOpenPerson).toHaveBeenCalledWith('emp-ann');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a month bar opens that month', async () => {
    getHrAnalytics.mockResolvedValue(SUMMARY);
    render(<HrAnalytics />);
    const head = await screen.findByRole('region', { name: 'Headcount' });
    fireEvent.click(within(head).getByRole('listitem', { name: /Sep 2026: Headcount 4/ }));
    await waitFor(() => expect(getHrAnalyticsPeople).toHaveBeenCalledWith(expect.objectContaining({ metric: 'headcount', month: '2026-09' })));
  });

  it('shows the money per currency when the server allows it', async () => {
    getHrAnalytics.mockResolvedValue(MONEY);
    render(<HrAnalytics />);
    expect(await screen.findByText('Owed In USD')).toBeTruthy();
    expect(screen.getByText('$800.00')).toBeTruthy();
    expect(screen.getByText('Owed In INR')).toBeTruthy();
    expect(screen.getByText('No Pay Rate On File')).toBeTruthy();
  });

  it('changing a filter reloads with it', async () => {
    getHrAnalytics.mockResolvedValue(SUMMARY);
    render(<HrAnalytics />);
    await screen.findByRole('region', { name: 'Headcount' });
    fireEvent.click(screen.getByRole('radio', { name: 'Contractors' }));
    await waitFor(() => expect(getHrAnalytics).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'contractors' })));
    fireEvent.change(screen.getByLabelText('Company'), { target: { value: 'co-b' } });
    await waitFor(() => expect(getHrAnalytics).toHaveBeenLastCalledWith(expect.objectContaining({ company: 'co-b' })));
  });

  it('never renders blank on an error', async () => {
    getHrAnalytics.mockRejectedValue(new Error('People Analytics is for HR.'));
    render(<HrAnalytics />);
    expect(await screen.findByText('People Analytics is for HR.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try Again' })).toBeTruthy();
  });
});

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

// Settings > Companies > Holiday Policies (Oct 29 2026): the list, and Delete
// saying which companies lose the policy.

const POLICIES = [
  { id: 'p1', name: 'US Holidays', description: 'US staff', weekendRule: 'nearest_weekday', companyId: 'c1',
    companies: [{ id: 'c1', name: 'Greens Global', skipped: [] }, { id: 'c3', name: 'Greens Storage', skipped: [] }],
    holidays: [{ key: 'a' }, { key: 'b' }], years: [2027, 2026], canEdit: true },
  { id: 'p2', name: 'India Holidays', description: '', weekendRule: 'keep', companyId: 'c2', companies: [], holidays: [], years: [], canEdit: false },
];
const api = vi.hoisted(() => ({
  getHolidayPolicies: vi.fn(),
  deleteHolidayPolicy: vi.fn(() => Promise.resolve({})),
  getEntities: vi.fn(() => Promise.resolve([])),
}));
vi.mock('../api', () => ({ api }));
const confirm = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
vi.mock('../ui/dialog', () => ({ dialog: { confirm: (...a) => confirm(...a) } }));

const HolidayPoliciesPanel = (await import('./HolidayPoliciesPanel')).default;
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('HolidayPoliciesPanel', () => {
  it('lists each policy with its companies, years and weekend rule, and View for one it cannot edit', async () => {
    api.getHolidayPolicies.mockResolvedValue(POLICIES);
    render(<HolidayPoliciesPanel toastOk={vi.fn()} toastErr={vi.fn()} />);
    expect(await screen.findByText('US Holidays')).toBeInTheDocument();
    expect(screen.getByText('Greens Storage')).toBeInTheDocument();
    expect(screen.getByText(/2 holidays · 2026, 2027 · Weekends: Friday Before Or Monday After \(Federal Rule\)/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View India Holidays' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete India Holidays' })).not.toBeInTheDocument();
  });

  it('names how many companies lose a policy before deleting it', async () => {
    api.getHolidayPolicies.mockResolvedValue(POLICIES);
    render(<HolidayPoliciesPanel toastOk={vi.fn()} toastErr={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete US Holidays' }));
    await waitFor(() => expect(api.deleteHolidayPolicy).toHaveBeenCalledWith('p1'));
    // Finding 12: "lose this policy's holidays", not "lose its holidays".
    expect(confirm.mock.calls[0][0]).toMatch(/^2 companies will lose this policy's holidays: Greens Global, Greens Storage\./);
  });

  it('counts the companies outside the admin scope that lose it too (finding 4)', async () => {
    api.getHolidayPolicies.mockResolvedValue([{ ...POLICIES[0], otherCompanies: 3 },
      { ...POLICIES[1], canEdit: true, otherCompanies: 1 }]);
    render(<HolidayPoliciesPanel toastOk={vi.fn()} toastErr={vi.fn()} />);
    expect(await screen.findByText('+3 Other Companies')).toBeInTheDocument();
    expect(screen.getByText('+1 Other Company')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete US Holidays' }));
    await waitFor(() => expect(api.deleteHolidayPolicy).toHaveBeenCalledWith('p1'));
    expect(confirm.mock.calls[0][0]).toMatch(/^2 companies and 3 other companies will lose this policy's holidays: Greens Global, Greens Storage\./);
    fireEvent.click(screen.getByRole('button', { name: 'Delete India Holidays' }));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(2));
    expect(confirm.mock.calls[1][0]).toMatch(/^1 other company will lose this policy's holidays\./);
  });

  it('says so when there are no policies yet', async () => {
    api.getHolidayPolicies.mockResolvedValue([]);
    render(<HolidayPoliciesPanel toastOk={vi.fn()} toastErr={vi.fn()} />);
    expect(await screen.findByText('No Holiday Policies Yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /New Policy/ })).toBeInTheDocument();
  });
});

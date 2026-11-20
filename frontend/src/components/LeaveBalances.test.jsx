import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Paid leave balances (Oct 19 2026): the employee card, the request hint and
// HR's panel render, and the import sends what was pasted.

const leaveAdmin = vi.fn();
const leaveImport = vi.fn();
const leavePersonBalance = vi.fn();
const leaveCompareQuickbooks = vi.fn();
vi.mock('../api', () => ({
  api: {
    leaveAdmin: (...a) => leaveAdmin(...a),
    leaveImport: (...a) => leaveImport(...a),
    leavePersonBalance: (...a) => leavePersonBalance(...a),
    leaveCompareQuickbooks: (...a) => leaveCompareQuickbooks(...a),
    leaveSetCutover: vi.fn(), leaveSavePolicies: vi.fn(), leaveAdjust: vi.fn(),
    leaveAssign: vi.fn(), leaveRecalculate: vi.fn(), leaveMyBalance: vi.fn(),
  },
}));

const { default: LeaveBalancesAdmin, LeaveBalanceCard, RequestBalanceHint, bucketOf, fmtLeave, ComparePanel, rateLine, openPeriodsLine } = await import('./LeaveBalances');

const POLICY = { id: 'us-ca', name: 'US - California', unit: 'hours', hoursPerDay: 8, assigned: false };
const BAL = {
  live: true, cutover: '2026-09-01', policy: POLICY, startDate: '2024-06-01', employmentType: 'full_time',
  vacation: { method: 'per_hour', available: 12.77, upcoming: 8, pending: 0, accrualPerHour: 0.01923, grants: [], eligible: true },
  sick: { method: 'lump', available: 16, upcoming: 0, pending: 4, eligible: true, eligibleOn: '2024-08-30', expiresOn: '2026-12-31' },
};

beforeEach(() => {
  leaveAdmin.mockReset().mockResolvedValue({
    cutover: '2026-09-01', canSetup: true, defaults: ['us-ca', 'us-other', 'in', 'none'],
    policies: [{ ...POLICY, eligibleTypes: ['full_time'], sick: { method: 'lump', hours: 40, afterDays: 90 },
      vacation: { method: 'per_hour', baseHoursPerYear: 2080, tiers: [{ fromYears: 1, hoursPerYear: 40 }] } }],
    people: [{ email: 'alice@greensglobal.com', name: 'Alice Test', ...BAL }],
  });
  leaveImport.mockReset().mockResolvedValue({ imported: 1, errors: [] });
  leavePersonBalance.mockReset().mockResolvedValue({ ...BAL, canEdit: true, entries: [] });
});

describe('leave balances', () => {
  it('maps leave types to a balance', () => {
    expect(bucketOf('PTO')).toBe('vacation');
    expect(bucketOf('Medical Appointment')).toBe('sick');
    expect(bucketOf('1/2 Day')).toBe('');
    expect(fmtLeave(16, { unit: 'days', hoursPerDay: 8 })).toBe('2 days');
  });

  it('routes a type to an extra bucket through drawFromReasons (Phase 1D)', () => {
    const balance = { extraTypes: [
      { id: 'bereavement', drawFromReasons: ['bereavement', 'funeral'] },
      { id: 'medical_leave', drawFromReasons: ['medical'] },
    ] };
    expect(bucketOf('Bereavement', balance)).toBe('bereavement');
    expect(bucketOf('Funeral Leave', balance)).toBe('bereavement');
    // The policy wins over the sick keyword - one bucket, not two.
    expect(bucketOf('Medical Appointment', balance)).toBe('medical_leave');
    expect(bucketOf('Vacation', balance)).toBe('vacation');
    expect(bucketOf('Bereavement')).toBe('');
  });

  it('shows the employee card only once balances are live', () => {
    const { container, rerender } = render(<LeaveBalanceCard balance={{ live: false }} />);
    expect(container.textContent).toBe('');
    rerender(<LeaveBalanceCard balance={BAL} />);
    expect(screen.getByText('My Paid Time Off')).toBeTruthy();
    expect(screen.getByText('12h 46m')).toBeTruthy();
    // No hint line under the numbers (Neil, 11/02/2026: remove the tooltips).
    expect(screen.queryByText(/Use by 12\/31\/2026/)).toBeNull();
  });

  it('renders extra leave types alongside vacation and sick (Phase 1C)', () => {
    const withExtras = {
      ...BAL,
      extraTypes: [
        { id: 'bereavement', name: 'Bereavement', paid: true, method: 'lump',
          available: 24, upcoming: 0, pending: 0, grant: null, eligibleOn: '2024-06-01',
          eligible: true, carriesOver: false, payoutOnTerm: false },
        { id: 'floating_holiday', name: 'Floating Holiday', paid: true, method: 'lump',
          available: 0, upcoming: 0, pending: 0, grant: null, eligibleOn: '2024-08-30',
          eligible: false, carriesOver: false, payoutOnTerm: false },
        { id: 'jury_duty', name: 'Jury Duty', paid: true, method: 'tracked_only',
          available: 0, upcoming: 0, pending: 0, grant: null, eligibleOn: '',
          eligible: true, carriesOver: false, payoutOnTerm: false },
      ],
    };
    render(<LeaveBalanceCard balance={withExtras} />);
    expect(screen.getByText('Bereavement')).toBeTruthy();
    expect(screen.getByText('24h 00m')).toBeTruthy();
    expect(screen.getByText('Jury Duty')).toBeTruthy();
    expect(screen.getByText('As taken')).toBeTruthy();
    expect(screen.queryByText('Floating Holiday')).toBeNull();
  });

  it('warns when a request is bigger than the balance', () => {
    render(<RequestBalanceHint balance={BAL} type="vacation" hours={8} />);
    expect(screen.getByText(/the part over your balance would be unpaid/)).toBeTruthy();
  });

  it('answers for an extra leave type on the request form (Phase 1D)', () => {
    const balance = { ...BAL, extraTypes: [
      { id: 'bereavement', name: 'Bereavement', paid: true, method: 'lump',
        available: 24, upcoming: 0, pending: 0, drawFromReasons: ['bereavement', 'funeral'] },
      { id: 'jury_duty', name: 'Jury Duty', paid: true, method: 'tracked_only',
        available: 0, upcoming: 0, pending: 0, drawFromReasons: ['jury', 'jury duty'] },
    ] };
    const { rerender } = render(<RequestBalanceHint balance={balance} type="Bereavement" hours={8} />);
    expect(screen.getByText(/Bereavement balance: 24h 00m available/)).toBeTruthy();
    rerender(<RequestBalanceHint balance={balance} type="Jury Duty" hours={8} />);
    expect(screen.getByText(/Jury Duty days are logged - no balance to run down/)).toBeTruthy();
  });

  it('shows extra types on the HR table and the Adjust picker (Phase 1D)', async () => {
    const extras = [
      { id: 'bereavement', name: 'Bereavement', paid: true, method: 'lump',
        available: 24, upcoming: 0, pending: 0, eligible: true, drawFromReasons: ['bereavement'] },
      { id: 'jury_duty', name: 'Jury Duty', paid: true, method: 'tracked_only',
        available: 0, upcoming: 0, pending: 0, eligible: true, drawFromReasons: ['jury'] },
    ];
    leaveAdmin.mockResolvedValue({
      cutover: '2026-09-01', canSetup: true, defaults: ['us-ca'], policies: [POLICY],
      people: [{ email: 'alice@greensglobal.com', name: 'Alice Test', ...BAL, extraTypes: extras }],
    });
    leavePersonBalance.mockResolvedValue({ ...BAL, extraTypes: extras, canEdit: true,
      entries: [{ id: 'e1', bucket: 'bereavement', hours: -8, kind: 'adjust', date: '2026-10-20', note: 'Day taken' }] });
    render(<LeaveBalancesAdmin toastOk={() => {}} toastErr={() => {}} />);
    await screen.findByText('Alice Test');
    expect(screen.getByText('Other Leave')).toBeTruthy();
    expect(screen.getAllByText(/Bereavement 24h 00m/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText('Alice Test'));
    await screen.findByText(/Day taken/);
    // The ledger line names the extra bucket, and Adjust offers it (never a
    // tracked-only type - there is no balance to adjust).
    const picker = screen.getByLabelText('Balance');
    const options = Array.from(picker.querySelectorAll('option')).map(o => o.textContent);
    expect(options).toContain('Bereavement');
    expect(options.join(' ')).not.toContain('Jury Duty');
  });

  it('renders HR panel and imports pasted rows', async () => {
    render(<LeaveBalancesAdmin toastOk={() => {}} toastErr={() => {}} />);
    await screen.findByText('Alice Test');
    fireEvent.click(screen.getByText('Import Opening Balances'));
    fireEvent.change(screen.getByLabelText('Opening balances'), { target: { value: 'email,vacation,sick\nalice@greensglobal.com,32,16' } });
    fireEvent.click(screen.getByText('Import'));
    await waitFor(() => expect(leaveImport).toHaveBeenCalledWith({ unit: 'hours', rows: [{ email: 'alice@greensglobal.com', vacation: 32, sick: 16 }] }));
    fireEvent.click(screen.getByText('Alice Test'));
    await screen.findByText(/No changes yet/);
  });

  it('shows the list, Search and As Of when only a company has a start date (11/18/2026)', async () => {
    leaveAdmin.mockResolvedValue({
      cutover: '', canSetup: true, defaults: ['us-ca'], policies: [POLICY],
      companies: [{ id: 'osm', name: 'Oversite Management', cutover: '2026-10-17', own: true }],
      people: [{ email: 'alice@greensglobal.com', name: 'Alice Test', ...BAL }],
    });
    render(<LeaveBalancesAdmin toastOk={() => {}} toastErr={() => {}} />);
    await screen.findByText('Alice Test');
    expect(screen.getByLabelText('Search people')).toBeTruthy();
    expect(screen.getByText('As Of')).toBeTruthy();
  });

  it('shows the list, Search and As Of when only a company has a start date (11/18/2026)', async () => {
    leaveAdmin.mockResolvedValue({
      cutover: '', canSetup: true, defaults: ['us-ca'], policies: [POLICY],
      companies: [{ id: 'osm', name: 'Oversite Management', cutover: '2026-10-17', own: true }],
      people: [{ email: 'alice@greensglobal.com', name: 'Alice Test', ...BAL }],
    });
    render(<LeaveBalancesAdmin toastOk={() => {}} toastErr={() => {}} />);
    await screen.findByText('Alice Test');
    expect(screen.getByLabelText('Search people')).toBeTruthy();
    expect(screen.getByText('As Of')).toBeTruthy();
  });

  it('shows nothing to someone who is not HR', async () => {
    leaveAdmin.mockReset().mockRejectedValue(Object.assign(new Error('no'), { status: 403 }));
    const { container } = render(<LeaveBalancesAdmin />);
    await waitFor(() => expect(container.textContent).toBe(''));
  });
});

// Compare With QuickBooks and the reasons (11/20/2026 - Charmi: balances did
// not match QuickBooks; Neil: "a real solution").
describe('leave balances explain themselves', () => {
  it('says the rate, since when, and a period not finalized', () => {
    expect(rateLine({ method: 'per_hour', hoursPerYear: 80, tierSince: '2026-10-20' }, POLICY)).toBe('80h a year since 10/20/2026');
    expect(rateLine({ method: 'per_hour', hoursPerYear: 0, next: { date: '2027-01-11' } }, POLICY)).toBe('Starts 01/11/2027');
    expect(openPeriodsLine([{ start: '2026-11-01', end: '2026-11-14' }])).toBe('11/01/2026 - 11/14/2026 Not Finalized');
    expect(openPeriodsLine([])).toBe('');
  });

  it('compares a QuickBooks report and lists every reason', async () => {
    leaveCompareQuickbooks.mockReset().mockResolvedValue({
      periodEnd: '2026-11-14',
      people: [
        { email: 'm@x.com', name: 'Pat Example', state: 'differs', asOf: '2026-11-14',
          vacation: { nexus: 20.17, quickbooks: 17.2, difference: 2.97 }, sick: { nexus: 8, quickbooks: 8, difference: 0 },
          lines: [{ bucket: 'vacation', kind: 'rate', hours: 2.97, text: 'QuickBooks earns 40h a year, the policy 80h a year (3 years on 09/18/2026).' }] },
        { email: 'a@x.com', name: 'Sam Sample', state: 'matches', lines: [], vacation: {}, sick: {} },
      ],
      unmatched: [{ name: 'Ghost Person', code: 'E-0999' }], notInReport: [],
    });
    render(<ComparePanel toastErr={vi.fn()} />);
    const file = new File([new Uint8Array([80, 75, 3, 4])], 'qb.xlsx');
    fireEvent.change(screen.getByLabelText('QuickBooks Time Off report'), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByText('Pat Example')).toBeTruthy());
    expect(leaveCompareQuickbooks).toHaveBeenCalledWith(expect.stringContaining('base64'), 'qb.xlsx');
    expect(screen.getByText(/1 differs - 1 matches - 1 not found in Nexus/)).toBeTruthy();
    expect(screen.getByText(/QuickBooks earns 40h a year/)).toBeTruthy();
    expect(screen.getByText(/Match: Sam Sample/)).toBeTruthy();
    expect(screen.getByText(/Ghost Person \(E-0999\)/)).toBeTruthy();
  });
});

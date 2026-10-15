import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// Accounting > Reporting > Employee Compensation (Oct 15): renders people and
// the totals views, the ledger payroll expense, and the step-up gate.

const total = (o) => ({ key: '', label: 'Total', currency: 'USD', people: 1, regMin: 9600, otMin: 240, dtMin: 60, sickMin: 960, vacationMin: 0, personalMin: 0, overtimeMin: 300, leaveMin: 960, wages: 5000, ...o });
const report = {
  from: '2026-01-01', to: '2026-09-30', months: ['2026-01'],
  people: [{ email: 'pat@x.com', name: 'Pat Hourly', employeeId: 'GG-001', company: 'c1', companyName: 'Greens Global', department: 'Maintenance', title: 'Technician',
    payType: 'hourly', currency: 'USD', rate: 26, rateChanged: true, regMin: 9600, otMin: 240, dtMin: 60, sickMin: 960, vacationMin: 0, personalMin: 0, overtimeMin: 300, leaveMin: 960, wages: 5000 }],
  byCompany: [total({ key: 'c1', label: 'Greens Global' })],
  byDepartment: [total({ key: 'Maintenance', label: 'Maintenance' })],
  totals: [total()],
};
const ledger = { by: 'department', rows: [{ key: '9100', label: 'Field Ops', wages: 1000, taxes: 80, benefits: 20, total: 1100, accounts: [] }], totals: { wages: 1000, taxes: 80, benefits: 20, total: 1100 } };

vi.mock('../../api', () => ({
  api: {
    getCompensationPeople: vi.fn(async () => report),
    getCompensationLedger: vi.fn(async () => ledger),
  },
}));
vi.mock('../../stepup/StepUp', () => ({
  isStepUpRequired: (e) => e?.status === 403,
  StepUpNeeded: ({ label, onVerified }) => <button type="button" onClick={onVerified}>Verify {label}</button>,
}));

import CompensationReport from './CompensationReport';
import { api } from '../../api';

beforeEach(() => { vi.clearAllMocks(); });

describe('CompensationReport', () => {
  it('renders each person with hours and wages, and the ledger payroll', async () => {
    render(<CompensationReport />);
    expect(await screen.findByText('Pat Hourly')).toBeTruthy();
    expect(screen.getByText('Technician')).toBeTruthy();
    expect(screen.getAllByText('160.00').length).toBe(2);   // regular hours, and the total
    expect(screen.getByText('Overtime Hours')).toBeTruthy();
    expect(screen.getByText('Gross Wages')).toBeTruthy();
    expect(await screen.findByText('Field Ops')).toBeTruthy();
    expect(screen.getByText('Employer Taxes')).toBeTruthy();
    expect(api.getCompensationLedger).toHaveBeenCalledWith(expect.any(String), expect.any(String), 'department');
  });

  it('switches to the totals by company', async () => {
    render(<CompensationReport />);
    await screen.findByText('Pat Hourly');
    fireEvent.click(screen.getByRole('button', { name: 'By Company' }));
    expect(screen.queryByText('Pat Hourly')).toBeNull();
    expect(screen.getByText('Employees')).toBeTruthy();
  });

  it('asks for a fresh identity check when the backend wants one', async () => {
    api.getCompensationPeople.mockRejectedValueOnce(Object.assign(new Error('stepup_required'), { status: 403 }));
    render(<CompensationReport />);
    fireEvent.click(await screen.findByRole('button', { name: /Verify/ }));
    expect(await screen.findByText('Pat Hourly')).toBeTruthy();
    expect(api.getCompensationPeople).toHaveBeenCalledTimes(2);
  });

  it('refuses a range longer than a year', async () => {
    render(<CompensationReport />);
    await screen.findByText('Pat Hourly');
    fireEvent.change(screen.getByLabelText('From Month'), { target: { value: '2024-01' } });
    expect(screen.getByText('Pick at most 12 months.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Run Report' })).toBeDisabled();
  });
});

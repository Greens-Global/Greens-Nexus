import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// People > Time > Payroll > Retro Pay (Oct 17): renders the table and totals,
// the empty state, the step-up gate and the CSV.

const period = {
  email: 'rita@x.com', name: 'Rita Retro', periodStart: '2026-09-13', periodEnd: '2026-09-26', currency: 'USD',
  changedFrom: '2026-09-15', changedThrough: '2026-09-26', changedDays: 12, overtimeRule: 'ca',
  hours: { regMin: 960, otMin: 240, dtMin: 60, leaveMin: 0, holidayDays: 0 },
  ratePaid: 20, rateNow: [{ from: '2026-09-15', through: '2026-09-26', rate: 25 }],
  paid: { total: 700 }, now: { total: 820 }, owedByClass: { total: 120 }, owed: 120,
};
const report = {
  start: '2026-04-17', end: '2026-10-17', email: '',
  people: [{ email: 'rita@x.com', name: 'Rita Retro', currency: 'USD', owed: 120, periods: [period] }],
  totals: [{ currency: 'USD', people: 1, periods: 1, regMin: 960, otMin: 240, dtMin: 60, leaveMin: 0, paid: 700, now: 820, owed: 120 }],
  checkManually: [{ email: 'priya@x.com', name: 'Priya Fixed', periodStart: '2026-09-01', periodEnd: '2026-09-30', currency: 'INR',
    reason: 'Monthly salary: check it.', ratePaid: 30000, rateNow: [{ from: '2026-09-01', through: '2026-09-30', rate: 33000 }] }],
};
const empty = { start: '2026-04-17', end: '2026-10-17', email: '', people: [], totals: [], checkManually: [] };

vi.mock('../api', () => ({ api: { timeRetroPay: vi.fn(async () => report) } }));
vi.mock('../stepup/StepUp', () => ({
  isStepUpRequired: (e) => e?.status === 403,
  StepUpNeeded: ({ onVerified }) => <button type="button" onClick={onVerified}>Verify Identity</button>,
}));

import RetroPayReport from './RetroPayReport';
import { retroPayCsv, money } from './retroPayModel';
import { api } from '../api';

beforeEach(() => { vi.clearAllMocks(); });

describe('RetroPayReport', () => {
  it('stays closed until opened, then loads the default six months', async () => {
    render(<RetroPayReport />);
    expect(api.timeRetroPay).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Retro Pay/ }));
    expect(await screen.findByText('Rita Retro')).toBeTruthy();
    const [s, e] = api.timeRetroPay.mock.calls[0];
    expect(s < e).toBe(true);
  });

  it('renders the table with hours, rates, owed and totals', async () => {
    render(<RetroPayReport initiallyOpen />);
    fireEvent.click(screen.getByRole('button', { name: 'Run Report' }));
    expect(await screen.findByText('Rita Retro')).toBeTruthy();
    for (const h of ['Employee', 'Period', 'Hours', 'Rate Paid', 'Rate Now', 'Owed']) expect(screen.getByText(h)).toBeTruthy();
    expect(screen.getByText('09/13/2026 - 09/26/2026')).toBeTruthy();
    expect(screen.getByText('16.00 Regular')).toBeTruthy();
    expect(screen.getByText('4.00 OT 1.5x')).toBeTruthy();
    expect(screen.getByText('1.00 DT 2x')).toBeTruthy();
    expect(screen.getByText('$20.00')).toBeTruthy();
    expect(screen.getByText('$25.00')).toBeTruthy();
    expect(screen.getAllByText('$120.00').length).toBe(2);   // the row and the total
    expect(screen.getByText('Total')).toBeTruthy();
    expect(screen.getByText('Check Manually')).toBeTruthy();
    expect(screen.getByText('Monthly salary: check it.')).toBeTruthy();
  });

  it('shows the empty state', async () => {
    api.timeRetroPay.mockResolvedValueOnce(empty);
    render(<RetroPayReport initiallyOpen />);
    fireEvent.click(screen.getByRole('button', { name: 'Run Report' }));
    expect(await screen.findByText('No back-dated rate changes in this range.')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Download CSV/ })).toBeDisabled();
  });

  it('asks for a fresh identity check when the backend wants one', async () => {
    api.timeRetroPay.mockRejectedValueOnce(Object.assign(new Error('stepup_required'), { status: 403 }));
    render(<RetroPayReport initiallyOpen />);
    fireEvent.click(screen.getByRole('button', { name: 'Run Report' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Verify Identity' }));
    expect(await screen.findByText('Rita Retro')).toBeTruthy();
    expect(api.timeRetroPay).toHaveBeenCalledTimes(2);
  });

  it('refuses an inverted range', () => {
    render(<RetroPayReport initiallyOpen />);
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-12-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-11-01' } });
    expect(screen.getByText('The start date must be on or before the end date.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Run Report' })).toBeDisabled();
  });

  it('builds the CSV with US dates and cents', () => {
    const lines = retroPayCsv(report).split('\r\n');
    expect(lines[0]).toBe('Employee,Email,Period Start,Period End,Currency,Regular Hours,OT Hours (1.5x),DT Hours (2x),Leave Hours,Rate Paid,Rate Now,Paid,Now,Owed,Note');
    expect(lines[1]).toBe('Rita Retro,rita@x.com,09/13/2026,09/26/2026,USD,16.00,4.00,1.00,0.00,20.00,25.00 (09/15/2026 - 09/26/2026),700.00,820.00,120.00,');
    expect(lines[2]).toBe('Total USD,,,,USD,16.00,4.00,1.00,0.00,,,700.00,820.00,120.00,');
    expect(lines[3]).toContain('Check manually: Monthly salary: check it.');
    expect(money(-12, 'USD')).toBe('-$12.00');
    expect(money(1500, 'CAD')).toBe('CAD 1,500.00');
  });
});

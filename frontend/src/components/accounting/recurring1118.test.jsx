// Accounting chat, 11/18 (Charmi's MRI and MRE review): a part-covered MRI
// month shows what it has, an ended MRE line stays for the year it ran, and
// MRE amount changes / Paid by Tenant.
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { coverText, monthShown } from './LeasingTab';
import { AmountChanges, amountIn, dueInMonth, visibleRows } from './MreTab';

describe('MRI part-covered months', () => {
  it('shows received plus covered, and what is still open', () => {
    const c = { month: '2026-06', inForce: true, expected: 100000, received: 0, balance: 100000, status: 'unpaid', covered: 52000, coveredBy: ['2026-05', '2026-09'] };
    expect(monthShown(c)).toBe(52000);
    expect(coverText(c)).toContain('48,000.00 still open');
  });
  it('a fully covered month is unchanged', () => {
    expect(monthShown({ month: '2026-03', inForce: true, expected: 100, received: 0, balance: 100, status: 'covered', covered: 100 })).toBe(100);
  });
  it('names rent posted with no customer', () => {
    expect(coverText({ status: 'paid', untagged: 4200 })).toContain('no customer');
  });
});

describe('MRE amount changes and Paid by Tenant', () => {
  const line = { expectedAmount: 500, startDate: '2025-01-01', endDate: '', status: 'active', frequency: 'monthly',
    amountChanges: [{ from: '2026-03-01', tenantPays: true }, { from: '2026-09-01', amount: 520 }] };
  it('reads the amount of each month', () => {
    expect(amountIn(line, '2026-02')).toEqual({ amount: 500, tenantPays: false });
    expect(amountIn(line, '2026-05')).toEqual({ amount: 500, tenantPays: true });
    expect(amountIn(line, '2026-10')).toEqual({ amount: 520, tenantPays: false });
  });
  it('a tenant month is never due', () => {
    expect(dueInMonth(line, 2026, 5)).toBe(false);
    expect(dueInMonth(line, 2026, 10)).toBe(true);
  });
  it('adds and removes a change', () => {
    const onChange = vi.fn();
    render(<AmountChanges changes={[{ from: '2026-07-01', amount: 650 }]} onChange={onChange} label={{}} control={{}} hint={{}} />);
    expect(screen.getByText(/From 07\/01\/2026/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Remove the change/ }));
    expect(onChange).toHaveBeenCalledWith([]);
  });
});

describe('MRE ended lines', () => {
  const row = (over) => ({ line: { status: 'ended', vendorName: 'Assured Partners', category: 'insurance' }, months: [], paidTotal: 0, expectedYear: 0, ...over });
  it('an ended line with paid months this year stays on the sheet', () => {
    expect(visibleRows([row({ paidTotal: 5168.13, expectedYear: 5168 })])).toHaveLength(1);
  });
  it('an ended line with nothing this year waits for Show Ended', () => {
    expect(visibleRows([row({})], { showZero: true })).toHaveLength(0);
    expect(visibleRows([row({})], { showZero: true, showEnded: true })).toHaveLength(1);
  });
});

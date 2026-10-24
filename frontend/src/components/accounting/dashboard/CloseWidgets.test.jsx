import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

// Account Reconciliations (Oct 7, Neil comment 5): reconciling is an Intacct
// function only - no "Mark reconciled" column or form in Nexus; a mark made
// here before still shows, read-only.

const dash = {
  period: '2026-09', fromKey: '2026-09', book: 'accrual', scope: 'ALL', reconAccounts: [{ gl_code: '11800', kind: 'bank' }],
  m: (v) => `$${Number(v).toFixed(2)}`, ix: { byCode: new Map([['12000', { name: 'Greens Global, Inc.' }]]) }, act: vi.fn(),
};
vi.mock('./DashContext', () => ({ useDash: () => dash }));
const RECON = {
  rows: [
    { key: 'gl:1@12000', type: 'Bank', name: 'Operating Checking', ref: 'Greens Global', entityCode: '12000', gl: '1010', thru: null, book: 1200, stmt: 1200, diff: 0, status: 'Behind', source: null, mark: null, nc: false },
    { key: 'gl:2@12000', type: 'Bank', name: 'Payroll Account', ref: 'Greens Global', entityCode: '12000', gl: '1020', thru: '2026-09-30', book: 500, stmt: 500, diff: 0, status: 'Reconciled', source: 'mark', mark: { marked_by: 'Charmi Desai', marked_at: '2026-10-01T15:00:00Z' }, nc: false },
    { key: 'gl:3@12000', type: 'Credit Card', name: 'Amex 1001', ref: 'Greens Global', entityCode: '12000', gl: '21500', thru: null, book: -350, stmt: -350, diff: 0, status: 'Behind', source: null, mark: null, nc: false },
    { key: 'loan:1', type: 'Mortgage', name: 'Wells Fargo Mortgage', ref: 'Greens Global', entityCode: '12000', gl: '', thru: null, book: -90000, stmt: -90000, diff: 0, status: 'Behind', source: null, mark: null, nc: false },
    { key: 'holding:Schwab', type: 'Investment', name: 'Schwab Brokerage', ref: 'SWVXX', entityCode: '12000', gl: '11800', thru: null, book: 2500, stmt: 2500, diff: 0, status: 'Behind', source: null, mark: null, nc: false },
    { key: 'holding:Fidelity', type: 'Investment', name: 'Fidelity Holdings', ref: 'FXAIX', entityCode: '12000', gl: '14000', thru: null, book: 800, stmt: 800, diff: 0, status: 'Behind', source: null, mark: null, nc: false },
  ],
  reconciled: 1, remaining: 1, isLoading: false,
};
vi.mock('./hooks', () => ({
  useRecon: () => RECON,
  useActivity: () => ({ rows: [], isLoading: false }),
  useCloseState: () => ({ state: null, isLoading: true }),
  useDeadlines: () => ({ items: [], isLoading: false }),
  useFlux: () => ({ rows: [], hasPrior: false }),
  useIntercompany: () => ({ rows: [], isLoading: false }),
}));
vi.mock('./closeViews', () => ({ TaskViewSwitch: () => null, useCloseViews: () => ({}) }));
vi.mock('../drill', () => ({ requestReportDrill: vi.fn() }));

import { ActivityWidget, ReconWidget, activityLink } from './CloseWidgets';

describe('ReconWidget', () => {
  it('has no Mark Reconciled column or button', () => {
    const { container } = render(<ReconWidget />);
    expect(screen.queryByRole('button', { name: /mark reconciled/i })).toBeNull();
    expect(screen.queryByText(/mark reconciled/i)).toBeNull();
    const heads = [...container.querySelectorAll('thead th')].map((th) => th.textContent);
    expect(heads).toEqual(['Account', 'Entity', 'Last Reconciled', 'Reconciled Balance', 'Current Balance', 'Difference', 'Status']);
    // The group heading row spans every column.
    const group = container.querySelector('tbody td[colspan]');
    expect(group?.getAttribute('colspan')).toBe('7');
    expect(container.querySelector('form')).toBeNull();
  });

  it('spans one column fewer when compact (no Entity column)', () => {
    const { container } = render(<ReconWidget compact />);
    expect(container.querySelectorAll('thead th')).toHaveLength(6);
    expect(container.querySelector('tbody td[colspan]')?.getAttribute('colspan')).toBe('6');
  });

  it('still shows an earlier Nexus mark, read-only', () => {
    render(<ReconWidget />);
    expect(screen.getByText(/Charmi Desai/)).toBeTruthy();
  });

  // Oct 22 (Charmi and Neil, item 07): every bank and card account opens its activity report, already filtered.
  it('links every bank and card account to its activity report, already filtered', () => {
    const nav = vi.fn();
    render(<ReconWidget onNavigate={nav} />);
    fireEvent.click(screen.getByRole('button', { name: 'Operating Checking' }));
    expect(nav).toHaveBeenLastCalledWith('rpt-bank-activity:1010:12000:2026-09-01:2026-09-30');
    fireEvent.click(screen.getByRole('button', { name: 'Amex 1001' }));
    expect(nav).toHaveBeenLastCalledWith('rpt-card-activity:21500:12000:2026-09-01:2026-09-30');
    // A brokerage row whose GL account is a bank account on the ledger opens Bank Activity too.
    fireEvent.click(screen.getByRole('button', { name: 'Schwab Brokerage' }));
    expect(nav).toHaveBeenLastCalledWith('rpt-bank-activity:11800:12000:2026-09-01:2026-09-30');
    // A mortgage (no GL account) and a holding on a non-bank account stay plain text.
    expect(screen.queryByRole('button', { name: 'Wells Fargo Mortgage' })).toBeNull();
    expect(screen.getByText('Wells Fargo Mortgage')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Fidelity Holdings' })).toBeNull();
  });

  it('carries the dashboard months, the Cash book and a one-entity scope', () => {
    expect(activityLink({ type: 'Bank', gl: '1010', entityCode: '' }, { period: '2026-09', fromKey: '2026-07', book: 'cash', scope: '32000' }))
      .toBe('rpt-bank-activity:1010:32000:2026-07-01:2026-09-30:cash');
    expect(activityLink({ type: 'Bank', gl: '1010', entityCode: '' }, { period: '2026-09', fromKey: '2026-09', book: 'all', scope: 'CTL' }))
      .toBe('rpt-bank-activity:1010::2026-09-01:2026-09-30');
  });

  it('activity empty state no longer mentions marking an account', () => {
    render(<ActivityWidget />);
    expect(screen.queryByText(/mark an account/i)).toBeNull();
  });
});

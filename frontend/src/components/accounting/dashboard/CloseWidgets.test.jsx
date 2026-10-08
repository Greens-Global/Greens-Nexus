import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// Account Reconciliations (Oct 7, Neil comment 5): reconciling is an Intacct
// function only - no "Mark reconciled" column or form in Nexus; a mark made
// here before still shows, read-only.

const dash = { period: '2026-09', m: (v) => `$${Number(v).toFixed(2)}`, ix: { byCode: new Map([['12000', { name: 'Greens Global, Inc.' }]]) }, act: vi.fn() };
vi.mock('./DashContext', () => ({ useDash: () => dash }));
const RECON = {
  rows: [
    { key: 'gl:1@12000', type: 'Bank', name: 'Operating Checking', ref: 'Greens Global', entityCode: '12000', gl: '1010', thru: null, book: 1200, stmt: 1200, diff: 0, status: 'Behind', source: null, mark: null, nc: false },
    { key: 'gl:2@12000', type: 'Bank', name: 'Payroll Account', ref: 'Greens Global', entityCode: '12000', gl: '1020', thru: '2026-09-30', book: 500, stmt: 500, diff: 0, status: 'Reconciled', source: 'mark', mark: { marked_by: 'Charmi Desai', marked_at: '2026-10-01T15:00:00Z' }, nc: false },
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

import { ActivityWidget, ReconWidget } from './CloseWidgets';

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

  it('activity empty state no longer mentions marking an account', () => {
    render(<ActivityWidget />);
    expect(screen.queryByText(/mark an account/i)).toBeNull();
  });
});

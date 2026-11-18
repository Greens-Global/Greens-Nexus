import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

// 11/11/2026 (picture 4): Budget vs Actual's Actual opens the account's ledger
// lines in the side panel - the dashboard's window, book and scope - and the
// tables read in the Reports statements' number format.

const ix = { isPartner: (c) => c === '90000', rootOf: (c) => c };
vi.mock('./DashContext', () => ({
  useDash: () => ({
    m: (v, o = {}) => (o.report ? `r:${v}` : `$${v}`), loading: false, ix, scope: 'CTL', book: 'all',
    entities: [{ code: '32000' }, { code: '90000' }], fromKey: '2026-08', period: '2026-08',
  }),
}));
vi.mock('./hooks', () => ({
  usePerf: () => ({
    variances: [{ id: 'a1', gl: '40100', name: 'Rent Income', actual: 1200, budget: 1000, v: 200, good: true }],
    ytd: { lines: [{ id: 'l1' }], revenue: { a: 9000, b: 0 }, expense: { a: -4000, b: 0 }, net: { a: 5000, b: 0 }, largest: [] },
  }),
  useTrend: () => null,
}));
vi.mock('../LinesPanel', () => ({ default: ({ title, queries, report }) => <div data-testid="lines" data-title={title} data-queries={JSON.stringify(queries)} data-report={JSON.stringify(report)} /> }));

import { VarianceWidget, YtdVarianceWidget } from './PerfWidgets';

describe('Budget vs Actual drill-down', () => {
  it('opens the lines behind an Actual, in scope, and prints table figures in the report format', async () => {
    render(<VarianceWidget />);
    expect(screen.getByText('r:1000')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'r:1200' }));
    const panel = await screen.findByTestId('lines');
    expect(panel.getAttribute('data-title')).toBe('40100 Rent Income');
    expect(JSON.parse(panel.getAttribute('data-queries'))).toEqual([{ account: '40100', from: '2026-08-01', to: '2026-08-31', location: '32000' }]);
    expect(JSON.parse(panel.getAttribute('data-report'))).toMatchObject({ account: '40100', from: '2026-08-01', to: '2026-08-31', book: 'both', entities: ['32000'] });
  });
});

// 11/11/2026 (item 4): a YTD total is many accounts, so it opens the Income
// Statement for the same months, entities and book - every line drills there.
describe('YTD totals open the Income Statement', () => {
  it('sends the January-to-period window in scope, leaving the book alone for Both', () => {
    const seen = vi.fn();
    const nav = vi.fn();
    window.addEventListener('nexus:accounting-drill', (e) => seen(e.detail), { once: true });
    window.addEventListener('nexus:navigate', (e) => nav(e.detail), { once: true });
    render(<YtdVarianceWidget />);
    fireEvent.click(screen.getByRole('button', { name: 'r:4000' }));
    expect(seen).toHaveBeenCalledWith({ statement: { entities: ['32000'], from: '2026-01-01', to: '2026-08-31' } });
    expect(nav).toHaveBeenCalledWith({ view: 'accounting', sub: 'rpt-pnl' });
  });
});

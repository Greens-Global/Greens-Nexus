import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

// Debt Maturities (11/12/2026): on prod the one loan with a maturity date had
// been paid down to $0, so the chart drew a single empty 2050 bar. Years with
// nothing owed are left out, and the loans with no date are counted aloud.

const dash = { period: '2026-10', m: (v) => `$${Number(v).toFixed(0)}` };
vi.mock('./DashContext', () => ({ useBooksDown: () => false, useDash: () => dash, useDashNav: () => Object.assign(() => {}, { can: () => true }) }));
let LOANS = [];
vi.mock('./hooks', () => ({ useLoans: () => ({ loans: LOANS, isLoading: false, failed: false }), usePartners: () => ({}), useValuation: () => ({}) }));
vi.mock('./Charts', () => ({ ColoredBars: ({ data }) => <div data-testid="bars">{data.map((d) => d.label).join(',')}</div> }));

const { MaturityWidget } = await import('./CapitalWidgets');
const loan = (o) => ({ balance: 0, rate_pct: 0, monthly_pi: 0, maturity: null, ...o });
afterEach(cleanup);

describe('MaturityWidget', () => {
  it('draws no empty year and says nothing is dated yet', () => {
    LOANS = [loan({ balance: 0, maturity: '2050-09-30', monthly_pi: 2237 }), loan({ balance: 1987338 }), loan({ balance: 491705 })];
    render(<MaturityWidget />);
    expect(screen.queryByTestId('bars')).toBeNull();
    expect(screen.getByText(/Maturity date not set on 2 of 3 loans, so there is nothing to chart yet/)).toBeTruthy();
  });

  it('charts the dated years and names the loans left out', () => {
    LOANS = [loan({ balance: 500000, maturity: '2029-06-30' }), loan({ balance: 0, maturity: '2031-01-31' }), loan({ balance: 1000 })];
    render(<MaturityWidget />);
    expect(screen.getByTestId('bars').textContent).toBe('2029');
    expect(screen.getByText(/not set on 1 of 3 loans - they are not in the chart/)).toBeTruthy();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// Cash on Hand KPI (Oct 7, Neil comment 7): under "Partner Entities Only
// (Non-Controllable)" it showed $0 / "0 entities" because it only ever read
// the controllable cash. It now shows the partner entities' own cash.

let dash;
vi.mock('./DashContext', () => ({ useDash: () => dash, RUNWAY_TARGET_MONTHS: 6 }));
vi.mock('./Charts', () => ({ Sparkline: () => null }));
let trend = [];
vi.mock('./hooks', () => ({
  useTrend: () => trend,
  useHoldings: () => ({ holdings: [], isLoading: false }),
  usePerf: () => null,
  useRecon: () => ({ rows: [], isLoading: false }),
  useRunway: () => ({ fixed: 0, liquid: 0, months: 0 }),
}));

import { KpiCashWidget } from './Kpis';

const m = (v) => `$${Math.round(v).toLocaleString('en-US')}`;
const split = (ctlEntities, ncEntities, ncOnly) => {
  const ctl = ctlEntities.reduce((t, e) => t + e.balance, 0);
  const nc = ncEntities.reduce((t, e) => t + e.balance, 0);
  return { ctl, nc, total: ctl + nc, ctlEntities, ncEntities, ncOnly, onHand: ncOnly ? nc : ctl, onHandEntities: ncOnly ? ncEntities : ctlEntities };
};

beforeEach(() => { trend = []; });

describe('KpiCashWidget', () => {
  it('shows the partner entities\' cash under the non-controllable scope', () => {
    const nc = [{ code: '70000', balance: 250000, is_partner: true }, { code: '71000', balance: 50000, is_partner: true }];
    dash = { m, loading: false, cashSplit: split([], nc, true) };
    trend = [{ ctlCash: 0, ncCash: 200000 }, { ctlCash: 0, ncCash: 300000 }];
    render(<KpiCashWidget />);
    expect(screen.getByText('$300,000')).toBeTruthy();
    expect(screen.getByText(/2 partner entities/)).toBeTruthy();
    expect(screen.queryByText('$0')).toBeNull();
    expect(screen.queryByText(/0 entities/)).toBeNull();
  });

  it('keeps the controllable figure for the consolidated scope', () => {
    dash = { m, loading: false, cashSplit: split([{ code: '12000', balance: 900000 }], [{ code: '70000', balance: 100000, is_partner: true }], false) };
    render(<KpiCashWidget />);
    expect(screen.getByText('$900,000')).toBeTruthy();
    expect(screen.getByText(/\+ \$100,000 non-controllable/)).toBeTruthy();
  });
});

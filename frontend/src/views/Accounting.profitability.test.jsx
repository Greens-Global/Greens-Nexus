import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useState } from 'react';

// Oct 15 (Charmi + Neil): Profitability for everyone with Accounting (a
// limited person too - it is per entity), and Employee Compensation only at
// the Full level and never for a person limited to certain entities.
// They sit under Reports > Review and Reports > Payroll (names of 11/11/2026),
// and Employee Compensation is just "Compensation" (Oct 22).

const role = vi.hoisted(() => ({ full: true, limited: false }));
vi.mock('../api', () => ({
  api: {
    markAccountingOpened: vi.fn(async () => ({})),
    getMyAccountingAccess: vi.fn(async () => ({ limited: role.limited })),
    getAccountingLocations: vi.fn(async () => ({ entities: [] })),
    getAccountingPrefs: vi.fn(async () => ({ prefs: {} })),
    saveAccountingPrefs: vi.fn(async (p) => ({ prefs: p })),
  },
}));
vi.mock('../contexts/RoleContext', () => ({
  useRole: () => ({
    myEmail: 'me@greensglobal.com',
    canAccessModule: (mod, _bypass, level) => (mod === 'accounting' && level === 'full' ? role.full : true),
  }),
}));
vi.mock('../lib/useNameResolver', () => ({ useNameResolver: () => () => '' }));
const stub = vi.hoisted(() => (name) => ({ default: () => <div data-testid={`tab-${name}`} /> }));
vi.mock('../components/accounting/ReportsTab', () => stub('reports'));
vi.mock('../components/accounting/ProfitabilityReport', () => stub('profitability'));
vi.mock('../components/accounting/CompensationReport', () => stub('compensation'));
vi.mock('../components/accounting/dashboard/OverviewTab', () => stub('overview'));
vi.mock('../components/accounting/dashboard/DashContext', () => ({ DashProvider: ({ children }) => children }));

import Accounting from './Accounting';
import { resetAccountingPrefs } from '../components/accounting/prefs';

function Harness({ start }) {
  const [sub, setSub] = useState(start);
  return <><div data-testid="sub">{sub}</div><Accounting activeSub={sub} onSubChange={setSub} /></>;
}

beforeEach(() => { role.full = true; role.limited = false; resetAccountingPrefs(); });

describe('Reports > Profitability and Compensation', () => {
  it('opens both from the Reports menu at the Full level', async () => {
    render(<Harness start="overview" />);
    fireEvent.click(await screen.findByRole('button', { name: /^Reports/ }));
    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: 'Review' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Profitability' }));
    expect(await screen.findByTestId('tab-profitability')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Reports/ }));
    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: 'Payroll' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Compensation' }));
    expect(await screen.findByTestId('tab-compensation')).toBeTruthy();
  });

  it('keeps Employee Compensation from anyone below Full', async () => {
    role.full = false;
    render(<Harness start="compensation" />);
    await waitFor(() => expect(screen.getByTestId('sub').textContent).not.toBe('compensation'));
    fireEvent.click(screen.getByRole('button', { name: /^Reports/ }));
    // Below Full nothing in Payroll is open, so the group is gone.
    expect(screen.queryByRole('menuitem', { name: 'Payroll' })).toBeNull();
    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: 'Review' }));
    expect(screen.getByRole('menuitem', { name: 'Profitability' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Compensation' })).toBeNull();
    expect(screen.queryByTestId('tab-compensation')).toBeNull();
  });

  it('gives a limited person Profitability but not Employee Compensation', async () => {
    role.limited = true;
    render(<Harness start="profitability" />);
    expect(await screen.findByTestId('tab-profitability')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Reports/ }));
    expect(screen.queryByRole('menuitem', { name: 'Payroll' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Compensation' })).toBeNull();
  });
});

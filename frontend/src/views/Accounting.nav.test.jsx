import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { useState } from 'react';

// Oct 6 (Charmi and Neil, 10/04): the Accounting bar is Dashboard (Overview /
// Cash / Performance / Close), Reporting (Reports / Packages / PFS / MRI /
// MRE), Loans & Financing, Budget, Vendors & Customers and Tools (Data /
// Access / Allocations / Import Hub). The sub keys did not change, so old
// links land; the ledger search sits in the header on every tab.

const role = vi.hoisted(() => ({ canPfs: true, limited: false }));
vi.mock('../api', () => ({
  api: {
    markAccountingOpened: vi.fn(async () => ({})),
    getMyAccountingAccess: vi.fn(async () => ({ limited: role.limited })),
    launchAccounting: vi.fn(async () => ({ url: 'https://example.test' })),
    getAccountingPrefs: vi.fn(async () => ({ prefs: {} })),
    saveAccountingPrefs: vi.fn(async (p) => ({ prefs: p })),
  },
}));
vi.mock('../contexts/RoleContext', () => ({
  useRole: () => ({
    myEmail: 'me@greensglobal.com',
    canAccessModule: (mod) => (mod === 'pfs' ? role.canPfs : true),
  }),
}));
vi.mock('../lib/useNameResolver', () => ({ useNameResolver: () => () => '' }));
// The screens themselves have their own tests; here they only say who they are.
const stub = vi.hoisted(() => (name) => ({ default: () => <div data-testid={`tab-${name}`} /> }));
vi.mock('../components/accounting/ReportsTab', () => ({ default: ({ searchText }) => <div data-testid="tab-reports">{`search:${searchText}`}</div> }));
vi.mock('../components/accounting/PackagesTab', () => stub('packages'));
vi.mock('../components/accounting/AccessTab', () => stub('access'));
vi.mock('../components/accounting/PfsTab', () => stub('pfs'));
vi.mock('../components/accounting/MriTab', () => stub('mri'));
vi.mock('../components/accounting/MreTab', () => stub('mre'));
vi.mock('../components/accounting/LoansTab', () => stub('loans'));
vi.mock('../components/accounting/BudgetTab', () => stub('budget'));
vi.mock('../components/accounting/PartnersTab', () => stub('partners'));
vi.mock('../components/accounting/AllocationsTab', () => stub('allocations'));
vi.mock('../components/accounting/dashboard/OverviewTab', () => stub('overview'));
vi.mock('../components/accounting/dashboard/CashTab', () => stub('cash'));
vi.mock('../components/accounting/dashboard/PerformanceTab', () => stub('performance'));
vi.mock('../components/accounting/dashboard/CloseTab', () => stub('close'));
vi.mock('../components/accounting/dashboard/DataTab', () => stub('data'));
vi.mock('../components/accounting/dashboard/DashContext', () => ({ DashProvider: ({ children }) => children }));

import Accounting from './Accounting';
import { resetAccountingPrefs } from '../components/accounting/prefs';

function Harness({ start }) {
  const [sub, setSub] = useState(start);
  return <><div data-testid="sub">{sub}</div><Accounting activeSub={sub} onSubChange={setSub} /></>;
}

beforeEach(() => { role.canPfs = true; role.limited = false; resetAccountingPrefs(); });

describe('Accounting navigation', () => {
  it('draws Dashboard, Reporting and Tools as dropdowns and opens an item', async () => {
    render(<Harness start="overview" />);
    const dashboard = await screen.findByRole('button', { name: /Dashboard/ });
    expect(dashboard.getAttribute('aria-haspopup')).toBe('menu');
    expect(screen.getByRole('button', { name: /Reporting/ }).getAttribute('aria-haspopup')).toBe('menu');
    expect(screen.getByRole('button', { name: /Tools/ }).getAttribute('aria-haspopup')).toBe('menu');
    expect(screen.getByRole('button', { name: /Loans & Financing/ })).toBeTruthy();
    // The old top-level labels are gone from the bar.
    expect(screen.queryByRole('button', { name: /^Overview$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Reports$/ })).toBeNull();
    expect(screen.getByTestId('tab-overview')).toBeTruthy();

    fireEvent.click(dashboard);
    for (const item of ['Overview', 'Cash', 'Performance', 'Close']) expect(screen.getByRole('menuitem', { name: item })).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Cash' }));
    expect(screen.getByTestId('sub').textContent).toBe('cash');
    expect(await screen.findByTestId('tab-cash')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Reporting/ }));
    for (const item of ['Reports', 'Packages', 'PFS', 'MRI', 'MRE']) expect(screen.getByRole('menuitem', { name: item })).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: 'MRE' }));
    expect(await screen.findByTestId('tab-mre')).toBeTruthy();
  });

  it('keeps old deep links and group keys working', async () => {
    const { unmount } = render(<Harness start="leasing" />);
    await waitFor(() => expect(screen.getByTestId('sub').textContent).toBe('mri'));
    unmount();
    render(<Harness start="tools" />);
    await waitFor(() => expect(screen.getByTestId('sub').textContent).toBe('data'));
    expect(screen.getByTestId('tab-data')).toBeTruthy();
  });

  it('hides PFS without the grant and gives a limited person only their screens', async () => {
    role.canPfs = false;
    role.limited = true;
    render(<Harness start="overview" />);
    await waitFor(() => expect(screen.getByTestId('sub').textContent).toBe('reports'));
    expect(screen.queryByRole('button', { name: /Dashboard/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Reporting/ }));
    expect(screen.queryByRole('menuitem', { name: 'PFS' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'MRE' })).toBeTruthy();
  });

  it('draws the Dashboard in the density saved to the profile', async () => {
    const { api } = await import('../api');
    api.getAccountingPrefs.mockResolvedValueOnce({ prefs: { dashDensity: 'condensed' } });
    render(<Harness start="overview" />);
    const tab = await screen.findByTestId('tab-overview');
    await waitFor(() => expect(tab.parentElement.className).toContain('acct-dash--condensed'));
  });

  it('lists the ledger setups on the Import Hub and opens one', async () => {
    render(<Harness start="imports" />);
    fireEvent.click(await screen.findByRole('button', { name: /Scan the Ledger/ }));
    expect(screen.getByTestId('sub').textContent).toBe('mre');
  });

  it('sends header search words to Reports, and the same box drives Reports there', async () => {
    vi.useFakeTimers();
    try {
      render(<Harness start="budget" />);
      await act(async () => { await Promise.resolve(); });
      const box = screen.getByRole('textbox', { name: 'Search the ledger' });
      fireEvent.change(box, { target: { value: 'chase' } });
      await act(async () => { vi.advanceTimersByTime(700); });
      expect(screen.getByTestId('sub').textContent).toBe('reports');
      expect(screen.getByTestId('tab-reports').textContent).toBe('search:chase');
      expect(screen.getByRole('textbox', { name: 'Search the ledger' }).value).toBe('chase');
    } finally {
      vi.useRealTimers();
    }
  });
});

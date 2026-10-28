import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

// Render-smoke for the Accounting view (first one; CLAUDE.md asks for one on
// high-risk views). The tabs themselves are stubbed - what is pinned here is
// the view's own logic: which tabs a person gets, where a visit with no tab
// lands (Overview, or Reports for an entity-limited reader - the phone menu
// now relies on this, Oct 1), and the header search handing its words to
// Reports.

const apiMock = vi.hoisted(() => ({ getMyAccountingAccess: vi.fn(), markAccountingOpened: vi.fn(() => Promise.resolve()), getAccountingPrefs: vi.fn(async () => ({ prefs: {} })), saveAccountingPrefs: vi.fn(async () => ({})) }));
vi.mock('../api', () => ({ api: apiMock }));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ myEmail: 'neil@greensglobal.com', canAccessModule: (m) => m === 'accounting' }) }));
vi.mock('../lib/useNameResolver', () => ({ useNameResolver: () => () => 'Neil Kadakia' }));
vi.mock('../components/accounting/ReportsTab', () => ({ default: ({ search }) => <div data-testid="reports">{`reports:${search?.text || ''}`}</div> }));
vi.mock('../components/accounting/ReportCenter', () => ({ default: () => <div data-testid="report-center">report-center</div> }));
vi.mock('../components/accounting/PackagesTab', () => ({ default: () => <div>packages-tab</div> }));
vi.mock('../components/accounting/AccessTab', () => ({ default: () => <div>access-tab</div> }));
vi.mock('../components/accounting/PfsTab', () => ({ default: () => <div>pfs-tab</div> }));
vi.mock('../components/accounting/MriTab', () => ({ default: () => <div>mri-tab</div> }));
vi.mock('../components/accounting/dashboard/DashContext', () => ({ DashProvider: ({ children }) => children }));
vi.mock('../components/accounting/dashboard/registry', () => ({ DashNav: { Provider: ({ children }) => children } }));
vi.mock('../components/accounting/dashboard/OverviewTab', () => ({ default: () => <div>overview-tab</div> }));
vi.mock('../components/accounting/dashboard/CashTab', () => ({ default: () => <div>cash-tab</div> }));
vi.mock('../components/accounting/dashboard/PerformanceTab', () => ({ default: () => <div>performance-tab</div> }));
vi.mock('../components/accounting/dashboard/CloseTab', () => ({ default: () => <div>close-tab</div> }));
vi.mock('../components/accounting/dashboard/DataTab', () => ({ default: () => <div>data-tab</div> }));

import Accounting from './Accounting';

const tabNames = () => screen.getAllByRole('button').map((b) => b.textContent.trim()).filter((t) => t && !/Clear search/.test(t));

beforeEach(() => { vi.clearAllMocks(); });

describe('Accounting view', () => {
  it('lands on Overview with every tab when the reader is not limited', async () => {
    apiMock.getMyAccountingAccess.mockResolvedValue({ limited: false });
    const onSubChange = vi.fn();
    render(<Accounting activeSub={undefined} onSubChange={onSubChange} />);
    expect(await screen.findByText('overview-tab')).toBeTruthy();
    // The strip is grouped now (Oct 7): the Dashboard group leads, showing
    // its own name only (Oct 22: the picked page never widens the bar), and
    // the Reports group is there for everyone.
    expect(tabNames()[0]).toBe('Dashboard');
    expect(tabNames()).toContain('Reports');
    await waitFor(() => expect(onSubChange).toHaveBeenCalledWith('overview'));
  });

  it('gives an entity-limited reader Reports, Packages and MRI, and lands on Reports', async () => {
    apiMock.getMyAccountingAccess.mockResolvedValue({ limited: true });
    const onSubChange = vi.fn();
    render(<Accounting activeSub={undefined} onSubChange={onSubChange} />);
    // Oct 23: `reports` is the Report Center, the catalogue of every report.
    expect(await screen.findByTestId('report-center')).toBeTruthy();
    // No Dashboard group for an entity-limited reader: Reports leads, on the Report Center.
    expect(tabNames()[0]).toBe('Reports');
    expect(tabNames().some((t) => /^Dashboard/.test(t))).toBe(false);
    await waitFor(() => expect(onSubChange).toHaveBeenCalledWith('reports'));
    // Links made before the rename still land.
    render(<Accounting activeSub="leasing" onSubChange={() => {}} />);
    expect(await screen.findByText('mri-tab')).toBeTruthy();
  });

  it('shows a skeleton, never nothing, while access is being asked', () => {
    apiMock.getMyAccountingAccess.mockReturnValue(new Promise(() => {}));
    const { container } = render(<Accounting activeSub="overview" onSubChange={() => {}} />);
    expect(container.querySelector('.skeleton-block, [class*="skeleton"]') || container.textContent.includes('Accounting')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Overview' })).toBeNull();
  });

  it('hands the words typed in the header search to Reports', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    apiMock.getMyAccountingAccess.mockResolvedValue({ limited: false });
    const onSubChange = vi.fn();
    render(<Accounting activeSub="cash" onSubChange={onSubChange} />);
    await screen.findByText('cash-tab');
    fireEvent.click(screen.getByRole('button', { name: 'Search the Ledger' }));   // an icon since chat 10/26, item 13
    fireEvent.change(screen.getByLabelText('Search the ledger'), { target: { value: 'sunbelt' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(700); });
    // Oct 23: the statements screen, on the Income Statement (`reports` is the Report Center now).
    expect(onSubChange).toHaveBeenCalledWith('rpt-pnl');
    vi.useRealTimers();
  });

  // Oct 24 (bundle budget): every screen is fetched the first time it is
  // opened. A screen imported up front again would put it back in the
  // Accounting file, which had grown past its 1,000 KB budget.
  it('carries only the header, bar and dashboard helpers - every screen loads on first open', async () => {
    const src = (await import('./Accounting.jsx?raw')).default;
    const upFront = [...src.matchAll(/^import .* from '\.\.\/components\/accounting\/([^']+)';\r?$/gm)].map((m) => m[1]).sort();
    // ModuleSearch (the header search, chat 10/26 item 13) brings reportControls' `control` with it, as before.
    expect(upFront).toEqual(['ModuleSearch', 'assumptions', 'dashboard/DashContext', 'dashboard/registry', 'drill', 'prefs', 'reportModel']);
    expect(src).toMatch(/const OverviewTab = lazy\(/);
  });
});

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
    // its active tab, and the Reporting group is there for everyone.
    expect(tabNames()[0]).toBe('DashboardOverview');
    expect(tabNames()).toContain('Reporting');
    await waitFor(() => expect(onSubChange).toHaveBeenCalledWith('overview'));
  });

  it('gives an entity-limited reader Reports, Packages and MRI, and lands on Reports', async () => {
    apiMock.getMyAccountingAccess.mockResolvedValue({ limited: true });
    const onSubChange = vi.fn();
    render(<Accounting activeSub={undefined} onSubChange={onSubChange} />);
    expect(await screen.findByTestId('reports')).toBeTruthy();
    // No Dashboard group for an entity-limited reader: Reporting leads, on Reports.
    expect(tabNames()[0]).toBe('ReportingReports');
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
    fireEvent.change(screen.getByLabelText('Search the ledger'), { target: { value: 'sunbelt' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(700); });
    expect(onSubChange).toHaveBeenCalledWith('reports');
    vi.useRealTimers();
  });
});

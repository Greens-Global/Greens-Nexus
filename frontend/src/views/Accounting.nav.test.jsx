import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { useState } from 'react';

// Oct 22 (Neil's spec, the 10/22 call with Charmi): the Accounting bar is
// Dashboard (Overview / Cash / Performance / Close), Reports (grouped
// flyouts: Report Center, Financial, Banking & Credit Cards, Budget, Payroll
// & People, Audit & Insights), Financing, Records and Tools (Data / Access / Allocations /
// Import Hub). The picked page never widens the bar. The sub keys did not
// change, so old links land; the ledger search sits in the header on every tab.

const role = vi.hoisted(() => ({ canPfs: true, limited: false }));
vi.mock('../api', () => ({
  api: {
    markAccountingOpened: vi.fn(async () => ({})),
    getMyAccountingAccess: vi.fn(async () => ({ limited: role.limited })),
    getAccountingLocations: vi.fn(async () => ({ entities: [] })),
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
vi.mock('../components/accounting/ReportsTab', () => ({ default: ({ searchText, report, view, link }) => <div data-testid="tab-reports" data-report={report || ''} data-view={view || ''} data-link={link ? JSON.stringify(link) : ''}>{`search:${searchText}`}</div> }));
vi.mock('../components/accounting/ReportCenter', () => ({ default: ({ groups, onOpen }) => (
  <div data-testid="tab-report-center" data-groups={groups.map((g) => g.label).join('|')}>
    <button type="button" onClick={() => onOpen('rpt-balance-sheet')}>Open Memorized</button>
  </div>
) }));
vi.mock('../components/accounting/ReportBuilder', () => ({ default: ({ canEdit }) => <div data-testid="tab-report-builder" data-edit={canEdit ? 'yes' : 'no'} /> }));
vi.mock('../components/accounting/PackagesTab', () => stub('packages'));
vi.mock('../components/accounting/AccessTab', () => stub('access'));
vi.mock('../components/accounting/PfsTab', () => stub('pfs'));
vi.mock('../components/accounting/MriTab', () => stub('mri'));
vi.mock('../components/accounting/MreTab', () => stub('mre'));
vi.mock('../components/accounting/LoansTab', () => stub('loans'));
vi.mock('../components/accounting/BudgetTab', () => stub('budget'));
vi.mock('../components/accounting/PartnersTab', () => ({ default: ({ initialKind }) => <div data-testid="tab-partners" data-kind={initialKind || ''} /> }));
vi.mock('../components/accounting/AllocationsTab', () => stub('allocations'));
vi.mock('../components/accounting/AskAccountantTab', () => ({ default: ({ limited }) => <div data-testid="tab-ama" data-limited={limited ? 'yes' : 'no'} /> }));
vi.mock('../components/accounting/ManagementFeesTab', () => stub('mgmt-fees'));
vi.mock('../components/accounting/CompensationReport', () => stub('compensation'));
vi.mock('../components/accounting/dashboard/OverviewTab', () => stub('overview'));
vi.mock('../components/accounting/dashboard/CashTab', () => stub('cash'));
vi.mock('../components/accounting/dashboard/PerformanceTab', () => stub('performance'));
vi.mock('../components/accounting/dashboard/CloseTab', () => stub('close'));
vi.mock('../components/accounting/dashboard/DataTab', () => ({ default: ({ only, exclude }) => <div data-testid="tab-data" data-only={(only || []).join(',')} data-exclude={(exclude || []).join(',')} /> }));
vi.mock('../components/accounting/dashboard/DashContext', () => ({ DashProvider: ({ children }) => children }));

import Accounting from './Accounting';
import { resetAccountingPrefs } from '../components/accounting/prefs';

function Harness({ start }) {
  const [sub, setSub] = useState(start);
  return <><div data-testid="sub">{sub}</div><Accounting activeSub={sub} onSubChange={setSub} /></>;
}

/** Click a bar button, walk its flyouts, pick the last item. */
async function choose(bar, ...path) {
  fireEvent.click(await screen.findByRole('button', { name: bar }));
  let menu = screen.getAllByRole('menu').at(-1);
  for (const label of path.slice(0, -1)) {
    fireEvent.mouseEnter(within(menu).getByRole('menuitem', { name: label }));
    menu = screen.getByRole('menu', { name: label });
  }
  fireEvent.click(within(menu).getByRole('menuitem', { name: path[path.length - 1] }));
}
const menuLabels = (name) => [...screen.getByRole('menu', { name }).children].map((el) => el.textContent);

beforeEach(() => { role.canPfs = true; role.limited = false; resetAccountingPrefs(); });

describe('Accounting navigation', () => {
  it('draws exactly Dashboard, Reports, Financing, Records and Tools (Oct 22, Neil)', async () => {
    render(<Harness start="overview" />);
    await screen.findByTestId('tab-overview');
    const bar = [...document.querySelectorAll('.module-tabs-inline > button')].map((b) => b.textContent.trim());
    expect(bar).toEqual(['Dashboard', 'Reports', 'Financing', 'Records', 'Tools']);
    for (const name of [/^Dashboard/, /^Reports/, /^Financing/, /^Records/, /^Tools/]) expect(screen.getByRole('button', { name }).getAttribute('aria-haspopup')).toBe('menu');
    expect(screen.queryByRole('button', { name: /^Budget/ })).toBeNull();
  });

  it('makes Records a menu of Vendors and Customers, each opening its list (Oct 22, item 12)', async () => {
    render(<Harness start="overview" />);
    fireEvent.click(await screen.findByRole('button', { name: /^Records/ }));
    expect(menuLabels('Records')).toEqual(['Vendors', 'Customers']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Customers' }));
    expect(screen.getByTestId('sub').textContent).toBe('customers');
    expect((await screen.findByTestId('tab-partners')).getAttribute('data-kind')).toBe('customer');
    expect(screen.getByText(/Vendor and customer records/)).toBeTruthy();
    await choose(/^Records/, 'Vendors');
    expect(screen.getByTestId('sub').textContent).toBe('partners');
    await waitFor(() => expect(screen.getByTestId('tab-partners').getAttribute('data-kind')).toBe('vendor'));
  });

  it('lands the old partners link and the Records group key on Vendors', async () => {
    const { unmount } = render(<Harness start="partners" />);
    expect((await screen.findByTestId('tab-partners')).getAttribute('data-kind')).toBe('vendor');
    expect(screen.getByTestId('sub').textContent).toBe('partners');
    unmount();
    render(<Harness start="records" />);
    await waitFor(() => expect(screen.getByTestId('sub').textContent).toBe('partners'));
  });

  it('gives a limited person Vendors and Customers, as before', async () => {
    role.limited = true;
    render(<Harness start="customers" />);
    expect((await screen.findByTestId('tab-partners')).getAttribute('data-kind')).toBe('customer');
    fireEvent.click(screen.getByRole('button', { name: /^Records/ }));
    expect(menuLabels('Records')).toEqual(['Vendors', 'Customers']);
  });

  it('never names the picked page in the bar', async () => {
    render(<Harness start="overview" />);
    await screen.findByTestId('tab-overview');
    await choose(/^Reports/, 'Financial', 'Balance Sheet');
    expect(screen.getByTestId('sub').textContent).toBe('rpt-balance-sheet');
    expect(document.querySelector('.tab-group-current')).toBeNull();
    expect(screen.getByRole('button', { name: /^Reports/ }).textContent).toBe('Reports');
  });

  it('lands on Overview when Dashboard is clicked, and lists the dashboard pages', async () => {
    render(<Harness start="loans" />);
    await screen.findByTestId('tab-loans');
    fireEvent.click(screen.getByRole('button', { name: /^Dashboard/ }));
    expect(screen.getByTestId('sub').textContent).toBe('overview');
    expect(await screen.findByTestId('tab-overview')).toBeTruthy();
    for (const item of ['Overview', 'Cash', 'Performance', 'Close']) expect(screen.getByRole('menuitem', { name: item })).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Cash' }));
    expect(await screen.findByTestId('tab-cash')).toBeTruthy();
  });

  it('groups Reports into flyouts, Report Center first', async () => {
    render(<Harness start="overview" />);
    fireEvent.click(await screen.findByRole('button', { name: /^Reports/ }));
    expect(menuLabels('Reports')).toEqual(['Report Center', 'Financial', 'Banking & Credit Cards', 'Budget', 'Payroll & People', 'Audit & Insights']);
    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: 'Report Center' }));
    expect(menuLabels('Report Center')).toEqual(['Report Center', 'Report Builder', 'Packages']);
    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: 'Financial' }));
    expect(screen.queryByRole('menu', { name: 'Report Center' })).toBeNull();
    expect(menuLabels('Financial')).toEqual(['Balance Sheet', 'Trial Balance', 'Income Statement', 'General Ledger', 'Statement of Cash Flows', 'Cash Position', 'PFS']);
    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: 'Income Statement' }));
    expect(menuLabels('Income Statement')).toEqual(['T12', 'YTD vs. Prior Year', 'This Month vs. Last Month']);
    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: 'Banking & Credit Cards' }));
    expect(menuLabels('Banking & Credit Cards')).toEqual(['Credit Card Activity', 'Bank Activity']);
    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: 'Budget' }));
    expect(menuLabels('Budget')).toEqual(['Budget', 'Budget vs. Actual, YTD', 'Budget vs. Actual, MTD']);
    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: 'Payroll & People' }));
    expect(menuLabels('Payroll & People')).toEqual(['Compensation']);
    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: 'Audit & Insights' }));
    expect(menuLabels('Audit & Insights')).toEqual(['Flux Analysis', 'MRE', 'MRI', 'AMA', 'Profitability', 'Management Fees']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'MRE' }));
    expect(await screen.findByTestId('tab-mre')).toBeTruthy();
  });

  it('opens the Trial Balance and the Income Statement quick views (Oct 22)', async () => {
    render(<Harness start="overview" />);
    await choose(/^Reports/, 'Financial', 'Trial Balance');
    expect((await screen.findByTestId('tab-reports')).getAttribute('data-report')).toBe('trial-balance');
    await choose(/^Reports/, 'Financial', 'Income Statement', 'YTD vs. Prior Year');
    expect(screen.getByTestId('sub').textContent).toBe('rpt-pnl-ytd-py');
    const tab = screen.getByTestId('tab-reports');
    expect(tab.getAttribute('data-report')).toBe('pnl');
    expect(tab.getAttribute('data-view')).toBe('pnl-ytd-py');
  });

  it('opens Credit Card Activity and Bank Activity, and lands a link carrying an account (Oct 22, item 07)', async () => {
    const { unmount } = render(<Harness start="overview" />);
    await choose(/^Reports/, 'Banking & Credit Cards', 'Credit Card Activity');
    expect(screen.getByTestId('sub').textContent).toBe('rpt-card-activity');
    expect((await screen.findByTestId('tab-reports')).getAttribute('data-report')).toBe('card-activity');
    await choose(/^Reports/, 'Banking & Credit Cards', 'Bank Activity');
    await waitFor(() => expect(screen.getByTestId('tab-reports').getAttribute('data-report')).toBe('bank-activity'));
    unmount();
    // The dashboard's link: the account rides after the report key, and the sub stays as linked.
    render(<Harness start="rpt-bank-activity:11310:32000:2026-09-01:2026-09-30" />);
    const tab = await screen.findByTestId('tab-reports');
    expect(tab.getAttribute('data-report')).toBe('bank-activity');
    expect(JSON.parse(tab.getAttribute('data-link'))).toEqual({ report: 'bank-activity', account: '11310', entity: '32000', from: '2026-09-01', to: '2026-09-30', book: '' });
    expect(screen.getByTestId('sub').textContent).toBe('rpt-bank-activity:11310:32000:2026-09-01:2026-09-30');
  });

  it('gives a limited person the Banking & Credit Cards reports too', async () => {
    role.limited = true;
    render(<Harness start="rpt-card-activity:21500" />);
    expect((await screen.findByTestId('tab-reports')).getAttribute('data-report')).toBe('card-activity');
    expect(screen.getByTestId('sub').textContent).toBe('rpt-card-activity:21500');
    fireEvent.click(screen.getByRole('button', { name: /^Reports/ }));
    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: 'Banking & Credit Cards' }));
    expect(menuLabels('Banking & Credit Cards')).toEqual(['Credit Card Activity', 'Bank Activity']);
  });

  it('keeps the Budget page under Reports > Budget, with Budget vs. Actual YTD and MTD (Oct 22)', async () => {
    render(<Harness start="overview" />);
    await choose(/^Reports/, 'Budget', 'Budget');
    expect(screen.getByTestId('sub').textContent).toBe('budget');
    expect(await screen.findByTestId('tab-budget')).toBeTruthy();
    await choose(/^Reports/, 'Budget', 'Budget vs. Actual, MTD');
    const tab = await screen.findByTestId('tab-reports');
    expect(tab.getAttribute('data-report')).toBe('budget');
    expect(tab.getAttribute('data-view')).toBe('budget-mtd');
  });

  it('keeps old deep links and group keys working', async () => {
    const { unmount } = render(<Harness start="leasing" />);
    await waitFor(() => expect(screen.getByTestId('sub').textContent).toBe('mri'));
    unmount();
    const second = render(<Harness start="tools" />);
    await waitFor(() => expect(screen.getByTestId('sub').textContent).toBe('data'));
    expect(screen.getByTestId('tab-data')).toBeTruthy();
    second.unmount();
    // Statements that left the menu still open from an old link.
    const third = render(<Harness start="rpt-pnl" />);
    expect((await screen.findByTestId('tab-reports')).getAttribute('data-report')).toBe('pnl');
    expect(screen.getByTestId('sub').textContent).toBe('rpt-pnl');
    third.unmount();
    render(<Harness start="reporting" />);
    await waitFor(() => expect(screen.getByTestId('sub').textContent).toBe('reports'));
  });

  it('hides PFS without the grant and gives a limited person only their screens', async () => {
    role.canPfs = false;
    role.limited = true;
    render(<Harness start="overview" />);
    await waitFor(() => expect(screen.getByTestId('sub').textContent).toBe('reports'));
    expect(screen.queryByRole('button', { name: /^Dashboard/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Reports/ }));
    expect(screen.queryByRole('menuitem', { name: 'Payroll & People' })).toBeNull();
    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: 'Financial' }));
    expect(screen.queryByRole('menuitem', { name: 'PFS' })).toBeNull();
    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: 'Audit & Insights' }));
    expect(screen.getByRole('menuitem', { name: 'MRE' })).toBeTruthy();
    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: 'Financial' }));
    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: 'Income Statement' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'T12' }));
    expect(screen.getByTestId('sub').textContent).toBe('rpt-pnl-t12');
  });

  it('draws the Dashboard in the density saved to the profile', async () => {
    const { api } = await import('../api');
    api.getAccountingPrefs.mockResolvedValueOnce({ prefs: { dashDensity: 'condensed' } });
    render(<Harness start="overview" />);
    const tab = await screen.findByTestId('tab-overview');
    await waitFor(() => expect(tab.parentElement.className).toContain('acct-dash--condensed'));
  });

  it('drops Open Nexus Accounting everywhere and the search on PFS (Oct 7)', async () => {
    const { unmount } = render(<Harness start="budget" />);
    await screen.findByTestId('tab-budget');
    expect(screen.queryByRole('button', { name: /Open Nexus Accounting/ })).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Search the ledger' })).toBeTruthy();
    unmount();
    render(<Harness start="pfs" />);
    await screen.findByTestId('tab-pfs');
    expect(screen.queryByRole('textbox', { name: 'Search the ledger' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Open Nexus Accounting/ })).toBeNull();
  });

  it('opens the Import Hub statement converter, without the old ledger setup cards (Oct 14)', async () => {
    render(<Harness start="imports" />);
    expect(await screen.findByText('Upload a Statement')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Scan the Ledger/ })).toBeNull();
    expect(screen.queryByText(/MRI - Monthly Recurring Income/)).toBeNull();
  });

  it('opens a statement straight from the Reports menu (Oct 14, Urmi)', async () => {
    render(<Harness start="overview" />);
    await choose(/^Reports/, 'Financial', 'Balance Sheet');
    expect(screen.getByTestId('sub').textContent).toBe('rpt-balance-sheet');
    expect((await screen.findByTestId('tab-reports')).getAttribute('data-report')).toBe('balance-sheet');
  });

  it('keeps Intercompany and Investments under Financing and out of Tools (Oct 14, Charmi)', async () => {
    render(<Harness start="loans" />);
    fireEvent.click(await screen.findByRole('button', { name: /^Financing/ }));
    for (const item of ['Loans', 'Intercompany', 'Investments']) expect(screen.getByRole('menuitem', { name: item })).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Intercompany' }));
    expect((await screen.findByTestId('tab-data')).getAttribute('data-only')).toBe('intercompany');
    fireEvent.click(screen.getByRole('button', { name: /^Tools/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Data' }));
    await waitFor(() => expect(screen.getByTestId('tab-data').getAttribute('data-exclude')).toBe('loans,intercompany,holdings'));
  });

  it('has AMA and Management Fees under Audit & Insights, PFS under Financial (CR-04)', async () => {
    render(<Harness start="overview" />);
    await choose(/^Reports/, 'Audit & Insights', 'AMA');
    expect(screen.getByTestId('sub').textContent).toBe('ama');
    expect((await screen.findByTestId('tab-ama')).getAttribute('data-limited')).toBe('no');
    expect(screen.getByText(/Ask My Accountant - lines parked/)).toBeTruthy();
    await choose(/^Reports/, 'Audit & Insights', 'Management Fees');
    expect(await screen.findByTestId('tab-mgmt-fees')).toBeTruthy();
    expect(screen.queryByTestId('tab-ama')).toBeNull();
    await choose(/^Reports/, 'Financial', 'PFS');
    expect(await screen.findByTestId('tab-pfs')).toBeTruthy();
  });

  it('gives a limited person AMA and Management Fees too', async () => {
    role.limited = true;
    render(<Harness start="ama" />);
    expect((await screen.findByTestId('tab-ama')).getAttribute('data-limited')).toBe('yes');
    fireEvent.click(screen.getByRole('button', { name: /^Reports/ }));
    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: 'Audit & Insights' }));
    expect(screen.getByRole('menuitem', { name: 'Management Fees' })).toBeTruthy();
  });

  it('sends header search words to Reports, and the same box drives Reports there', async () => {
    vi.useFakeTimers();
    try {
      render(<Harness start="budget" />);
      await act(async () => { await Promise.resolve(); });
      const box = screen.getByRole('textbox', { name: 'Search the ledger' });
      fireEvent.change(box, { target: { value: 'chase' } });
      await act(async () => { vi.advanceTimersByTime(700); });
      // Oct 23: `reports` is the Report Center; the words land on the statements (Income Statement).
      expect(screen.getByTestId('sub').textContent).toBe('rpt-pnl');
      expect(screen.getByTestId('tab-reports').textContent).toBe('search:chase');
      expect(screen.getByRole('textbox', { name: 'Search the ledger' }).value).toBe('chase');
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends header search words from the Report Center to the statements too (Oct 23)', async () => {
    vi.useFakeTimers();
    try {
      render(<Harness start="reports" />);
      await act(async () => { await Promise.resolve(); });
      expect(screen.getByTestId('tab-report-center')).toBeTruthy();
      fireEvent.change(screen.getByRole('textbox', { name: 'Search the ledger' }), { target: { value: 'sunbelt' } });
      await act(async () => { vi.advanceTimersByTime(700); });
      expect(screen.getByTestId('sub').textContent).toBe('rpt-pnl');
      expect(screen.getByTestId('tab-reports').textContent).toBe('search:sunbelt');
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens the Report Center catalogue and the Report Builder from the Report Center flyout (Oct 23, item 05)', async () => {
    render(<Harness start="overview" />);
    await choose(/^Reports/, 'Report Center', 'Report Center');
    expect(screen.getByTestId('sub').textContent).toBe('reports');
    const center = await screen.findByTestId('tab-report-center');
    expect(screen.queryByTestId('tab-reports')).toBeNull();
    expect(center.getAttribute('data-groups')).toBe('Report Center|Financial|Banking & Credit Cards|Budget|Payroll & People|Audit & Insights');
    // A memorized report opened from the catalogue lands on its statement.
    fireEvent.click(screen.getByRole('button', { name: 'Open Memorized' }));
    expect(screen.getByTestId('sub').textContent).toBe('rpt-balance-sheet');
    expect((await screen.findByTestId('tab-reports')).getAttribute('data-report')).toBe('balance-sheet');
    await choose(/^Reports/, 'Report Center', 'Report Builder');
    expect(screen.getByTestId('sub').textContent).toBe('report-builder');
    expect((await screen.findByTestId('tab-report-builder')).getAttribute('data-edit')).toBe('yes');
  });

  it('gives a limited person the Report Center and the Report Builder', async () => {
    role.limited = true;
    render(<Harness start="report-builder" />);
    expect(await screen.findByTestId('tab-report-builder')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Reports/ }));
    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: 'Report Center' }));
    expect(menuLabels('Report Center')).toEqual(['Report Center', 'Report Builder', 'Packages']);
  });
});

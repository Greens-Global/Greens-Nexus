import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { useState } from 'react';

// The Accounting bar (Oct 22, Neil's spec with Charmi; Reports and Trackers
// redrawn 11/11/2026, picture 2): Dashboard (Overview / Cash / Performance /
// Close), Reports (All Reports, Report Builder, Packages, then one flyout per
// group - Financial Statements, Ledger & Banking, Budget vs. Actual, Review,
// Payroll, Tax - never a flyout inside a flyout), Trackers (the working
// tools), Financing, Records and Tools. The picked page never widens the bar.
// The sub keys did not change, so old links land; the ledger search sits in
// the header on every tab.

const role = vi.hoisted(() => ({ canPfs: true, limited: false }));
vi.mock('../api', () => ({
  api: {
    markAccountingOpened: vi.fn(async () => ({})),
    getMyAccountingAccess: vi.fn(async () => ({ limited: role.limited })),
    getAccountingLocations: vi.fn(async () => ({ entities: [] })),
    launchAccounting: vi.fn(async () => ({ url: 'https://example.test' })),
    getAccountingPrefs: vi.fn(async () => ({ prefs: {} })),
    saveAccountingPrefs: vi.fn(async (p) => ({ prefs: p })),
    // Import Hub (opened by one test below) reads its rules and pickers on open.
    getStatementRules: vi.fn(async () => ({ rules: [] })),
    getAccountingAccounts: vi.fn(async () => ({ accounts: [] })),
    getAccountingPartners: vi.fn(async () => ({ partners: [] })),
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
vi.mock('../components/accounting/ReportBuilder', () => ({ default: ({ canPublish }) => <div data-testid="tab-report-builder" data-edit={canPublish ? 'yes' : 'no'} /> }));
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
vi.mock('../components/accounting/RecordsLists', () => ({ GlAccountsTab: () => <div data-testid="tab-gl-accounts" />, EntitiesTab: () => <div data-testid="tab-entities" /> }));
vi.mock('../components/accounting/ManualJournalEntries', () => stub('manual-je'));
vi.mock('../components/accounting/PayrollSummary', () => stub('payroll-summary'));
vi.mock('../components/accounting/JournalTab', () => ({ default: ({ symbol }) => <div data-testid="tab-journal" data-symbol={symbol} /> }));
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
  it('draws exactly Dashboard, Reports, Trackers, Financing, Records and Tools', async () => {
    render(<Harness start="overview" />);
    await screen.findByTestId('tab-overview');
    const bar = [...document.querySelectorAll('.module-tabs-inline > button')].map((b) => b.textContent.trim());
    expect(bar).toEqual(['Dashboard', 'Reports', 'Trackers', 'Financing', 'Records', 'Tools']);
    for (const name of [/^Dashboard/, /^Reports/, /^Trackers/, /^Financing/, /^Records/, /^Tools/]) expect(screen.getByRole('button', { name }).getAttribute('aria-haspopup')).toBe('menu');
    expect(screen.queryByRole('button', { name: /^Budget/ })).toBeNull();
  });

  it('makes Records a menu of Vendors and Customers, each opening its list (Oct 22, item 12)', async () => {
    render(<Harness start="overview" />);
    fireEvent.click(await screen.findByRole('button', { name: /^Records/ }));
    expect(menuLabels('Records')).toEqual(['Vendors', 'Customers', 'General Ledger Accounts', 'Entities', 'Journals']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Customers' }));
    expect(screen.getByTestId('sub').textContent).toBe('customers');
    expect((await screen.findByTestId('tab-partners')).getAttribute('data-kind')).toBe('customer');
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
    expect(menuLabels('Records')).toEqual(['Vendors', 'Customers', 'General Ledger Accounts', 'Entities', 'Journals']);
  });

  it('opens Manual Journal Entries from Ledger & Banking, for a limited person too (CR-10)', async () => {
    role.limited = true;
    render(<Harness start="overview" />);
    await choose(/^Reports/, 'Ledger & Banking', 'Manual Journal Entries');
    expect(screen.getByTestId('sub').textContent).toBe('manual-je');
    expect(await screen.findByTestId('tab-manual-je')).toBeTruthy();
  });

  it('opens General Ledger Accounts, Entities and every configured journal from Records (CR-12)', async () => {
    render(<Harness start="overview" />);
    await choose(/^Records/, 'General Ledger Accounts');
    expect(await screen.findByTestId('tab-gl-accounts')).toBeTruthy();
    await choose(/^Records/, 'Entities');
    expect(await screen.findByTestId('tab-entities')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Records/ }));
    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: 'Journals' }));
    expect(menuLabels('Journals')).toEqual(['APJ', 'GJCA', 'GJC', 'PYRJ', 'PEJ', 'PIJ', 'SJI', 'GJ', 'HJCA']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'PYRJ' }));
    expect(screen.getByTestId('sub').textContent).toBe('journal-PYRJ');
    expect((await screen.findByTestId('tab-journal')).getAttribute('data-symbol')).toBe('PYRJ');
    expect(document.querySelectorAll('.module-tabs-inline > button')).toHaveLength(6);
  });

  it('never names the picked page in the bar', async () => {
    render(<Harness start="overview" />);
    await screen.findByTestId('tab-overview');
    await choose(/^Reports/, 'Financial Statements', 'Balance Sheet');
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

  it('draws Reports two levels deep, the lead pages first, and the working tools under Trackers (11/11/2026)', async () => {
    render(<Harness start="overview" />);
    fireEvent.click(await screen.findByRole('button', { name: /^Reports/ }));
    expect(menuLabels('Reports')).toEqual(['All Reports', 'Report Builder', 'Packages', 'Financial Statements', 'Ledger & Banking', 'Budget vs. Actual', 'Review', 'Payroll', 'Tax']);
    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: 'Financial Statements' }));
    expect(menuLabels('Financial Statements')).toEqual([
      'Balance Sheet', 'Trial Balance', 'Income Statement - Last 12 Months', 'Income Statement - Year to Date vs. Prior Year',
      'Income Statement - This Month vs. Last Month', 'Income Statement by Customer', 'Income Statement by Job',
      'Income Statement by Department', 'Statement of Cash Flows', 'Cash Position', 'Personal Financial Statements',
    ]);
    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: 'Ledger & Banking' }));
    expect(screen.queryByRole('menu', { name: 'Financial Statements' })).toBeNull();
    expect(menuLabels('Ledger & Banking')).toEqual(['General Ledger', 'Spend by Vendor', 'Bank Activity', 'Credit Card Activity', 'Manual Journal Entries']);
    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: 'Budget vs. Actual' }));
    expect(menuLabels('Budget vs. Actual')).toEqual(['Year to Date', 'Month to Date']);
    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: 'Review' }));
    expect(menuLabels('Review')).toEqual(['Flux Analysis', 'Profitability']);
    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: 'Payroll' }));
    expect(menuLabels('Payroll')).toEqual(['Compensation', 'Payroll Summary']);
    fireEvent.click(screen.getByRole('button', { name: /^Trackers/ }));
    expect(menuLabels('Trackers')).toEqual(['Monthly Recurring Income', 'Monthly Recurring Expenses', 'Management Fees', 'Ask My Accountant', 'Budgets']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Monthly Recurring Expenses' }));
    expect(await screen.findByTestId('tab-mre')).toBeTruthy();
  });

  it('opens the Trial Balance and the Income Statement quick views (Oct 22)', async () => {
    render(<Harness start="overview" />);
    await choose(/^Reports/, 'Financial Statements', 'Trial Balance');
    expect((await screen.findByTestId('tab-reports')).getAttribute('data-report')).toBe('trial-balance');
    await choose(/^Reports/, 'Financial Statements', 'Income Statement - Year to Date vs. Prior Year');
    expect(screen.getByTestId('sub').textContent).toBe('rpt-pnl-ytd-py');
    const tab = screen.getByTestId('tab-reports');
    expect(tab.getAttribute('data-report')).toBe('pnl');
    expect(tab.getAttribute('data-view')).toBe('pnl-ytd-py');
  });

  it('opens Credit Card Activity and Bank Activity, and lands a link carrying an account (Oct 22, item 07)', async () => {
    const { unmount } = render(<Harness start="overview" />);
    await choose(/^Reports/, 'Ledger & Banking', 'Credit Card Activity');
    expect(screen.getByTestId('sub').textContent).toBe('rpt-card-activity');
    expect((await screen.findByTestId('tab-reports')).getAttribute('data-report')).toBe('card-activity');
    await choose(/^Reports/, 'Ledger & Banking', 'Bank Activity');
    await waitFor(() => expect(screen.getByTestId('tab-reports').getAttribute('data-report')).toBe('bank-activity'));
    unmount();
    // The dashboard's link: the account rides after the report key, and the sub stays as linked.
    render(<Harness start="rpt-bank-activity:11310:32000:2026-09-01:2026-09-30" />);
    const tab = await screen.findByTestId('tab-reports');
    expect(tab.getAttribute('data-report')).toBe('bank-activity');
    expect(JSON.parse(tab.getAttribute('data-link'))).toEqual({ report: 'bank-activity', account: '11310', entity: '32000', from: '2026-09-01', to: '2026-09-30', book: '' });
    expect(screen.getByTestId('sub').textContent).toBe('rpt-bank-activity:11310:32000:2026-09-01:2026-09-30');
  });

  it('gives a limited person the Ledger & Banking reports too', async () => {
    role.limited = true;
    render(<Harness start="rpt-card-activity:21500" />);
    expect((await screen.findByTestId('tab-reports')).getAttribute('data-report')).toBe('card-activity');
    expect(screen.getByTestId('sub').textContent).toBe('rpt-card-activity:21500');
    fireEvent.click(screen.getByRole('button', { name: /^Reports/ }));
    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: 'Ledger & Banking' }));
    expect(menuLabels('Ledger & Banking')).toEqual(['General Ledger', 'Spend by Vendor', 'Bank Activity', 'Credit Card Activity', 'Manual Journal Entries']);
  });

  it('opens Budgets from Trackers and Budget vs. Actual from Reports (11/11/2026)', async () => {
    render(<Harness start="overview" />);
    await choose(/^Trackers/, 'Budgets');
    expect(screen.getByTestId('sub').textContent).toBe('budget');
    expect(await screen.findByTestId('tab-budget')).toBeTruthy();
    await choose(/^Reports/, 'Budget vs. Actual', 'Month to Date');
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
    expect(screen.queryByRole('menuitem', { name: 'Payroll' })).toBeNull();
    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: 'Financial Statements' }));
    expect(screen.queryByRole('menuitem', { name: 'Personal Financial Statements' })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Income Statement - Last 12 Months' }));
    expect(screen.getByTestId('sub').textContent).toBe('rpt-pnl-t12');
    fireEvent.click(screen.getByRole('button', { name: /^Trackers/ }));
    expect(screen.getByRole('menuitem', { name: 'Monthly Recurring Expenses' })).toBeTruthy();
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
    // Chat 10/26, item 13: the search is an icon that opens into the box.
    fireEvent.click(screen.getByRole('button', { name: 'Search the Ledger' }));
    expect(screen.getByRole('textbox', { name: 'Search the ledger' })).toBeTruthy();
    unmount();
    render(<Harness start="pfs" />);
    await screen.findByTestId('tab-pfs');
    expect(screen.queryByRole('button', { name: 'Search the Ledger' })).toBeNull();
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
    await choose(/^Reports/, 'Financial Statements', 'Balance Sheet');
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
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reference Data' }));
    await waitFor(() => expect(screen.getByTestId('tab-data').getAttribute('data-exclude')).toBe('loans,intercompany,holdings'));
  });

  it('has Ask My Accountant and Management Fees under Trackers, Personal Financial Statements under Financial Statements', async () => {
    render(<Harness start="overview" />);
    await choose(/^Trackers/, 'Ask My Accountant');
    expect(screen.getByTestId('sub').textContent).toBe('ama');
    expect((await screen.findByTestId('tab-ama')).getAttribute('data-limited')).toBe('no');
    await choose(/^Trackers/, 'Management Fees');
    expect(await screen.findByTestId('tab-mgmt-fees')).toBeTruthy();
    expect(screen.queryByTestId('tab-ama')).toBeNull();
    await choose(/^Reports/, 'Financial Statements', 'Personal Financial Statements');
    expect(await screen.findByTestId('tab-pfs')).toBeTruthy();
  });

  it('gives a limited person Ask My Accountant and Management Fees too', async () => {
    role.limited = true;
    render(<Harness start="ama" />);
    expect((await screen.findByTestId('tab-ama')).getAttribute('data-limited')).toBe('yes');
    fireEvent.click(screen.getByRole('button', { name: /^Trackers/ }));
    expect(menuLabels('Trackers')).toEqual(['Monthly Recurring Income', 'Monthly Recurring Expenses', 'Management Fees', 'Ask My Accountant', 'Budgets']);
  });

  it('sends header search words to Reports, and the same box drives Reports there', async () => {
    vi.useFakeTimers();
    try {
      render(<Harness start="budget" />);
      await act(async () => { await Promise.resolve(); });
      fireEvent.click(screen.getByRole('button', { name: 'Search the Ledger' }));
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
      fireEvent.click(screen.getByRole('button', { name: 'Search the Ledger' }));
      fireEvent.change(screen.getByRole('textbox', { name: 'Search the ledger' }), { target: { value: 'sunbelt' } });
      await act(async () => { vi.advanceTimersByTime(700); });
      expect(screen.getByTestId('sub').textContent).toBe('rpt-pnl');
      expect(screen.getByTestId('tab-reports').textContent).toBe('search:sunbelt');
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens All Reports and the Report Builder from the top of Reports (Oct 23, item 05)', async () => {
    render(<Harness start="overview" />);
    await choose(/^Reports/, 'All Reports');
    expect(screen.getByTestId('sub').textContent).toBe('reports');
    const center = await screen.findByTestId('tab-report-center');
    expect(screen.queryByTestId('tab-reports')).toBeNull();
    expect(center.getAttribute('data-groups')).toBe('Report Center|Financial Statements|Ledger & Banking|Budget vs. Actual|Review|Payroll|Tax|Trackers');
    // A memorized report opened from the catalogue lands on its statement.
    fireEvent.click(screen.getByRole('button', { name: 'Open Memorized' }));
    expect(screen.getByTestId('sub').textContent).toBe('rpt-balance-sheet');
    expect((await screen.findByTestId('tab-reports')).getAttribute('data-report')).toBe('balance-sheet');
    await choose(/^Reports/, 'Report Builder');
    expect(screen.getByTestId('sub').textContent).toBe('report-builder');
    expect((await screen.findByTestId('tab-report-builder')).getAttribute('data-edit')).toBe('yes');
  });

  it('gives a limited person All Reports and the Report Builder', async () => {
    role.limited = true;
    render(<Harness start="report-builder" />);
    expect(await screen.findByTestId('tab-report-builder')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Reports/ }));
    expect(menuLabels('Reports')).toEqual(['All Reports', 'Report Builder', 'Packages', 'Financial Statements', 'Ledger & Banking', 'Budget vs. Actual', 'Review', 'Tax']);
  });
});

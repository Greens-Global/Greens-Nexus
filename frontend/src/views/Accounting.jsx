import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Activity, ArrowLeftRight, Banknote, BookOpen, Building2, Calculator, ChartColumn, CheckSquare, CreditCard, Database, FileStack, FileText,
  Hammer, HandCoins, Handshake, KeyRound, Landmark, LayoutGrid, Library, ListChecks, MessageCircleQuestion, PieChart, Receipt,
  ReceiptText, Scale, ShieldCheck, Split, Target, TrendingUp, Upload, UserPen, Users, Wallet, Wrench,
} from 'lucide-react';
import { api } from '../api';
import { useRole } from '../contexts/RoleContext';
import { useNameResolver } from '../lib/useNameResolver';
import ModuleTabs, { ModuleActions } from '../components/ModuleTabs';
import ModuleSearch from '../components/accounting/ModuleSearch';
import { BarSearchSlotContext } from '../components/accounting/reportControls';
import { dashDensityOf, useAccountingPrefs } from '../components/accounting/prefs';
import { SkeletonBlocks } from '../components/AsyncState';
import { DashProvider } from '../components/accounting/dashboard/DashContext';
import { DashNav } from '../components/accounting/dashboard/nav';
import { useActionCounts, withBadges } from '../lib/useActionCounts';
import { REPORTS, REPORT_VIEWS, parseActivitySub } from '../components/accounting/reportModel';
import { STATEMENTS_SUB } from '../components/accounting/drill';
import { BUILDER_PUBLISH_MIN_LEVEL, PAYROLL_SUMMARY_LEVEL, RECORDS_JOURNALS, REPORT_MENU_PLACEMENT } from '../components/accounting/assumptions';

// Oct 24 (bundle budget, 10/23 meeting round 2): every screen behind the bar
// is fetched the first time it is opened, not with the Accounting view - all
// of them together had grown the view's file past its 1,000 KB budget. The
// header, the bar and the dashboard's shared provider stay here; a screen on
// its way shows the skeleton (SCREEN_LOADING), never nothing, and a file gone
// after a deploy is the view boundary's quiet reload, as for every view.
// A screen's file can start loading before it is drawn (`preload`): the first
// one opened downloads while the access check is still out (11/11/2026).
const screen = (load) => Object.assign(lazy(load), { preload: load });
const ReportsTab = screen(() => import('../components/accounting/ReportsTab'));
const PackagesTab = screen(() => import('../components/accounting/PackagesTab'));
const AccessTab = screen(() => import('../components/accounting/AccessTab'));
const PfsTab = screen(() => import('../components/accounting/PfsTab'));
const MriTab = screen(() => import('../components/accounting/MriTab'));
const LoansTab = screen(() => import('../components/accounting/LoansTab'));
const MreTab = screen(() => import('../components/accounting/MreTab'));
const ImportHub = screen(() => import('../components/accounting/ImportHub'));
const OverviewTab = screen(() => import('../components/accounting/dashboard/OverviewTab'));
const CashTab = screen(() => import('../components/accounting/dashboard/CashTab'));
const PerformanceTab = screen(() => import('../components/accounting/dashboard/PerformanceTab'));
const CloseTab = screen(() => import('../components/accounting/dashboard/CloseTab'));
const DataTab = screen(() => import('../components/accounting/dashboard/DataTab'));
const BudgetTab = screen(() => import('../components/accounting/BudgetTab'));
const PartnersTab = screen(() => import('../components/accounting/PartnersTab'));
const AllocationsTab = screen(() => import('../components/accounting/AllocationsTab'));
const ManagementFeesTab = screen(() => import('../components/accounting/ManagementFeesTab'));
// Oct 15 (Neil): AMA is Ask My Accountant; the agreements are Management Fees.
const AskAccountantTab = screen(() => import('../components/accounting/AskAccountantTab'));
// Oct 15 (Charmi + Neil): Profitability and Employee Compensation under Reporting.
const ProfitabilityReport = screen(() => import('../components/accounting/ProfitabilityReport'));
const CompensationReport = screen(() => import('../components/accounting/CompensationReport'));
const ReportCenter = screen(() => import('../components/accounting/ReportCenter'));
const ReportBuilder = screen(() => import('../components/accounting/ReportBuilder'));
const EntitiesTab = screen(() => import('../components/accounting/RecordsLists').then((m) => ({ default: m.EntitiesTab })));
const GlAccountsTab = screen(() => import('../components/accounting/RecordsLists').then((m) => ({ default: m.GlAccountsTab })));
const JournalTab = screen(() => import('../components/accounting/JournalTab'));
const ManualJournalEntries = screen(() => import('../components/accounting/ManualJournalEntries'));
const PayrollSummary = screen(() => import('../components/accounting/PayrollSummary'));
const SCREEN_LOADING = <div style={{ marginTop: 8 }}><SkeletonBlocks count={3} /></div>;

// Accounting in Nexus reads the Nexus Accounting ledger (a one-way Intacct ->
// Supabase mirror; Intacct stays the source of truth and nothing is written
// back to it - Neil, Sep 7). Sep 22: the finance dashboard joined the Reports
// surface as its own tabs - Overview (customizable widgets and role views),
// Cash (plan, scenarios, monthly budget forecast), Performance (budget vs actual vs
// prior year, commentary) and Close (checklist, reconciliations, flux). Each
// tab shows one section at a time so nobody scrolls to find a panel. The
// figures come through the backend proxy (backend/routers/accounting_dashboard.py);
// the shared bits (close ticks, marks, notes, views) live in the accounting
// database and are the same ones the accounting app shows. Data (editors and
// up) holds the reference figures the ledger does not carry.
//
// Sep 25 (Neil): Packages builds a set of memorized reports into one PDF for
// a lender; Access (Full level on Accounting) sets which entities each person
// may read. A person limited to certain entities gets Reports, Packages and
// MRI only - every other tab shows consolidated figures, and the backend refuses
// them for that person whatever the screen shows.
//
// Sep 30 (Charmi and Neil, call of 09/29): the ledger search box sits in the
// header of EVERY tab (typing lands on Reports with the words); the "Open
// Nexus Accounting" button is gone (the accounting app's own login page still
// hands off through Nexus); Leasing became a section of MRI, Monthly
// Recurring Income.

// Oct 14: Reporting opens the five statements directly (Urmi); Loans &
// Financing is a menu - Loans, Intercompany, Investments (Charmi); Import Hub
// converts a bank or brokerage statement into an Intacct import file (Neil).

// Oct 6 (Charmi and Neil, 10/04): the bar was fourteen tabs long. It is now
// six, three of them dropdowns: Dashboard (Overview / Cash / Performance /
// Close), Reporting (Reports / Packages / PFS / MRI / MRE) and Tools (Data /
// Access / Allocations / Import Hub). The sub keys did not change - a group
// is only how the bar draws them - so every deep link still lands.
// Oct 14 (Urmi: "Reporting should have the sub menu of the reports"): each of
// these opens Reports on that statement (sub key `rpt-<report>`).
//
// Oct 22 (Neil's written spec, gone through with Charmi on the 10/22 call):
// the bar is Dashboard, Reports, Financing, Records, Tools - short names, and
// the page picked never widens it (compactGroups). Reports is grouped, each
// group a flyout: Report Center (All Reports renamed), Financial (with the
// Trial Balance and three Income Statement quick views), Budget (moved off
// the bar, with Budget vs. Actual YTD / MTD), Payroll & People, Audit &
// Insights, and Banking & Credit Cards (item 07) between Financial and
// Budget. A `rpt-<report>` key opens that statement; `rpt-<view>` opens a
// quick view (REPORT_VIEWS in reportModel); an activity report's key may
// carry its account after a colon (activitySub). Older keys (rpt-pnl,
// rpt-budget) still land.
// Records > Journals: `journal-<symbol>` - lines read through the entity scope, so open to a limited person too.
const JOURNAL_SUB = 'journal-';
const journalOf = (key) => (String(key || '').startsWith(JOURNAL_SUB) ? key.slice(JOURNAL_SUB.length) : null);
const rpt = (key, label, Icon) => ({ key: `rpt-${key}`, label, Icon });
const BASE_TABS = [
  { key: 'dashboard', label: 'Dashboard', Icon: LayoutGrid, landing: 'overview', items: [
    { key: 'overview', label: 'Overview', Icon: LayoutGrid },
    { key: 'cash', label: 'Cash', Icon: Wallet },
    { key: 'performance', label: 'Performance', Icon: TrendingUp },
    { key: 'close', label: 'Close', Icon: CheckSquare },
  ] },
  { key: 'reporting', label: 'Reports', Icon: FileText, items: [
    { key: 'grp-center', label: 'Report Center', Icon: FileText, items: [
      { key: 'reports', label: 'Report Center', Icon: FileText },
      { key: 'report-builder', label: 'Report Builder', Icon: Hammer },
      { key: 'packages', label: 'Packages', Icon: FileStack },
    ] },
    { key: 'grp-financial', label: 'Financial', Icon: Scale, items: [
      rpt('balance-sheet', 'Balance Sheet', Scale),
      rpt('trial-balance', 'Trial Balance', ListChecks),
      { key: 'grp-pnl', label: 'Income Statement', Icon: TrendingUp, items: [
        rpt('pnl-t12', 'T12', TrendingUp),
        rpt('pnl-ytd-py', 'YTD vs. Prior Year', TrendingUp),
        rpt('pnl-mom', 'This Month vs. Last Month', TrendingUp),
        // 10/27 item 16 (Charmi; Neil: "Income Statement - not Profit & Loss").
        rpt('pnl-customer', 'Income Statement by Customer', Users),
        rpt('pnl-job', 'Income Statement by Job', Hammer),
        rpt('pnl-department', 'Income Statement by Department', Building2),
      ] },
      rpt('general-ledger', 'General Ledger', BookOpen),
      // 10/27 item 17 (Charmi: "pull a report by vendor name").
      rpt('vendor-spend', 'Spend by Vendor', Receipt),
      rpt('cash-flow', 'Statement of Cash Flows', ArrowLeftRight),
      rpt('cash-position', 'Cash Position', Wallet),
    ] },
    // Oct 22 (Neil, item 07): one card's or one bank account's transactions
    // without filtering the General Ledger. Every account on Overview >
    // Account Reconciliations opens these on itself (`rpt-<report>:<account>...`).
    { key: 'grp-banking', label: 'Banking & Credit Cards', Icon: Landmark, items: [
      rpt('card-activity', 'Credit Card Activity', CreditCard),
      rpt('bank-activity', 'Bank Activity', Landmark),
    ] },
    // Oct 2 (Charmi and Neil, 10/01 call): a budget per entity and year.
    { key: 'grp-budget', label: 'Budget', Icon: Calculator, items: [
      { key: 'budget', label: 'Budget', Icon: Calculator },
      rpt('budget-ytd', 'Budget vs. Actual, YTD', Target),
      rpt('budget-mtd', 'Budget vs. Actual, MTD', Target),
    ] },
    // Oct 15: wages and hours per employee (Full level on Accounting only).
    { key: 'grp-payroll', label: 'Payroll & People', Icon: HandCoins, items: [
      { key: 'compensation', label: 'Compensation', Icon: HandCoins },
      // Oct 23 (Neil, CR-09): QuickBooks' Payroll Summary, from the PYRJ import.
      { key: 'payroll-summary', label: 'Payroll Summary', Icon: ReceiptText },
    ] },
    { key: 'grp-audit', label: 'Audit & Insights', Icon: Activity, items: [
      rpt('flux', 'Flux Analysis', Activity),
      // Oct 6: Monthly Recurring Expenses, beside MRI.
      { key: 'mre', label: 'MRE', Icon: Receipt },
      { key: 'mri', label: 'MRI', Icon: KeyRound },
      // Oct 15 (Neil: "AMA means Ask My Accountant"): questions on ledger lines
      // and the lines parked on the Ask My Accountant account.
      { key: 'ama', label: 'AMA', Icon: MessageCircleQuestion },
      // Oct 23 (Neil, CR-10): the entries a person keyed in Intacct - who and when.
      { key: 'manual-je', label: 'Manual Journal Entries', Icon: UserPen },
      // Oct 15: per-entity NOI / net income / debt service vs prior year.
      { key: 'profitability', label: 'Profitability', Icon: ChartColumn },
    ] },
    // 10/27 item 18 (Neil, Viral): tax forms from the ledger - Schedule C first.
    { key: 'grp-tax', label: 'Tax', Icon: Landmark, items: [
      rpt('schedule-c', 'Schedule C (Draft)', FileText),
    ] },
  ] },
  // Oct 2 (Neil and Charmi): loans set up from the ledger and reviewed per
  // month - balances, principal and interest paid, NOI, DSCR against the
  // covenant. Per entity, so a limited person gets it too.
  // Oct 14 (Charmi: "take them out under Tools and under Loan"): Intercompany
  // and Investments left Tools > Data for this menu; Data's own Loans grid was
  // the same loans as this screen, so it is gone from Tools.
  // Oct 22 (Neil): "Loans & Financing" is now just "Financing".
  { key: 'financing', label: 'Financing', Icon: Banknote, items: [
    { key: 'loans', label: 'Loans', Icon: Banknote },
    { key: 'intercompany', label: 'Intercompany', Icon: ArrowLeftRight },
    { key: 'investments', label: 'Investments', Icon: PieChart },
  ] },
  // Oct 2 (Charmi and Neil, 10/01 call): vendor and customer records with
  // changes sent for approval. Oct 22 (Neil): "Vendors & Customers" is
  // Records, a menu - Vendors and Customers open that screen on their list
  // (`partners` stays the Vendors key, so older links land).
  // Oct 23 (Charmi's edited post, Neil, CR-12): General Ledger Accounts (the
  // chart), Entities, and a Journals flyout - one page per journal in
  // RECORDS_JOURNALS (assumptions.js), its lines with every filter.
  { key: 'records', label: 'Records', Icon: Users, items: [
    { key: 'partners', label: 'Vendors', Icon: Users },
    { key: 'customers', label: 'Customers', Icon: Users },
    { key: 'gl-accounts', label: 'General Ledger Accounts', Icon: BookOpen },
    { key: 'entities', label: 'Entities', Icon: Building2 },
    { key: 'grp-journals', label: 'Journals', Icon: Library, items: RECORDS_JOURNALS.map((s) => ({ key: `${JOURNAL_SUB}${s}`, label: s, Icon: BookOpen })) },
  ] },
  // Oct 6 (Neil: "create a Tools section in accounting"): the utility screens.
  { key: 'tools', label: 'Tools', Icon: Wrench, items: [
    { key: 'data', label: 'Data', Icon: Database },
    { key: 'access', label: 'Access', Icon: ShieldCheck },
    { key: 'allocations', label: 'Allocations', Icon: Split },
    { key: 'imports', label: 'Import Hub', Icon: Upload },
  ] },
];
// Oct 23 (Neil, CR-04): PFS and Management Fees each go in the Reports group
// REPORT_MENU_PLACEMENT (assumptions.js) names - PFS in Financial, Management
// Fees in Audit & Insights - out of the Report Center.
const PLACED = {
  pfs: { key: 'pfs', label: 'PFS', Icon: Landmark },
  // Oct 7 (Priyanka): Asset Management Agreements, billed read from the
  // ledger - first built as "AMA", renamed Management Fees on Oct 15.
  'mgmt-fees': { key: 'mgmt-fees', label: 'Management Fees', Icon: Handshake },
};
/** `items` with each PLACED item put in its group, after its `after` item (else last). */
function placeItems(items, placement = REPORT_MENU_PLACEMENT) {
  return items.map((t) => {
    if (!t.items) return t;
    let inner = placeItems(t.items, placement);
    Object.entries(placement).forEach(([key, at]) => {
      if (at.group !== t.key || !PLACED[key]) return;
      const i = inner.findIndex((x) => x.key === at.after);
      inner = i < 0 ? [...inner, PLACED[key]] : [...inner.slice(0, i + 1), PLACED[key], ...inner.slice(i + 1)];
    });
    return { ...t, items: inner };
  });
}
const TABS = placeItems(BASE_TABS);
// Every `rpt-` key (a statement or a quick view) is Reports, open to a limited person too.
const LIMITED_TABS = ['reports', 'report-builder', 'packages', 'mri', 'mre', 'loans', 'budget', 'partners', 'customers', 'imports', 'ama', 'mgmt-fees', 'profitability', 'gl-accounts', 'entities', 'manual-je'];
// Links made before a rename still land; a group's own key opens its first item.
const ALIAS = { leasing: 'mri', financing: 'loans' };
const leafKeys = (items) => items.flatMap((t) => (t.items ? leafKeys(t.items) : [t.key]));
/**
 * The statements screen (ReportsTab): a `rpt-` key. Oct 23 (Neil, item 05):
 * `reports` is the Report Center, the catalogue of every report; the ledger
 * search typed anywhere else lands on the statements, opened on the Income
 * Statement (STATEMENTS_SUB) as `reports` used to open them.
 */
const isReports = (key) => String(key || '').startsWith('rpt-');
// The part before any `:` - an activity report's account rides after it.
const rptKey = (key) => (String(key || '').startsWith('rpt-') ? key.slice(4).split(':')[0] : null);
/** The menu item a sub key lights: `rpt-bank-activity:11310` lights Bank Activity. */
const menuKey = (key) => (String(key || '').startsWith('rpt-') ? key.split(':')[0] : key);
/** The statement a `rpt-` key opens: its own, or its quick view's. Unknown -> null. */
const reportOf = (key) => {
  const k = rptKey(key);
  if (!k) return null;
  if (REPORT_VIEWS[k]) return REPORT_VIEWS[k].report;
  return REPORTS.some((r) => r.key === k) ? k : null;
};
const viewOf = (key) => (REPORT_VIEWS[rptKey(key)] ? rptKey(key) : null);
const DASH_SUBS = ['overview', 'cash', 'performance', 'close'];
// The screens that read the dashboard provider (useDash): its tabs and Data's grids.
const DASH_PROVIDER_SUBS = [...DASH_SUBS, 'data', 'intercompany', 'investments'];

// The file behind each sub key, for the preload above.
const SCREEN_OF = {
  dashboard: OverviewTab, reporting: ReportCenter, overview: OverviewTab, cash: CashTab, performance: PerformanceTab, close: CloseTab, reports: ReportCenter,
  'report-builder': ReportBuilder, packages: PackagesTab, mri: MriTab, loans: LoansTab, pfs: PfsTab, data: DataTab,
  intercompany: DataTab, investments: DataTab, access: AccessTab, budget: BudgetTab, partners: PartnersTab,
  customers: PartnersTab, allocations: AllocationsTab, mre: MreTab, imports: ImportHub, ama: AskAccountantTab,
  'mgmt-fees': ManagementFeesTab, profitability: ProfitabilityReport, compensation: CompensationReport,
  'payroll-summary': PayrollSummary, 'gl-accounts': GlAccountsTab, entities: EntitiesTab, 'manual-je': ManualJournalEntries,
};
const screenOf = (key) => (isReports(key) ? ReportsTab : journalOf(key) ? JournalTab : SCREEN_OF[key]);

export default function Accounting({ activeSub, onSubChange }) {
  // The accounting app is its own grant ("Nexus Accounting App" in Roles &
  // Access); seeing this screen does not imply it. Administrators bypass.
  const { canAccessModule, myEmail } = useRole();
  const counts = useActionCounts();
  // The Close tab's "My Tasks" matches a task owner to my role or my name.
  const nameOf = useNameResolver();
  const meName = nameOf(myEmail) || '';
  // Ticking close tasks, marking reconciliations, writing commentary and
  // editing reference figures need the editor level on the Accounting grant.
  const canEdit = canAccessModule('accounting', 'administrator', 'editor');
  // CR-05 (Neil, 23 Oct): anyone with Accounting saves and publishes Report Builder reports.
  const canPublish = canAccessModule('accounting', 'administrator', BUILDER_PUBLISH_MIN_LEVEL);
  // CR-09: Payroll Summary - wages per person, gated like Compensation (PAYROLL_SUMMARY_LEVEL).
  const canPayrollSummary = canAccessModule('accounting', 'administrator', PAYROLL_SUMMARY_LEVEL);
  // Deciding who reads which entities takes the Full level.
  const canManage = canAccessModule('accounting', 'administrator', 'full');
  // Vendor / customer change requests are decided by a manager who holds
  // the Accounting grant, or anyone at the Full level on it (the backend
  // checks the same).
  const canApprovePartners = canAccessModule('accounting', 'manager', 'full');
  // Personal financial statements: owners and the explicit grant, nobody else
  // - an administrator does not see the tab (and the backend refuses them).
  const canPfs = canAccessModule('pfs', 'owner', 'viewer');
  const canPfsEdit = canAccessModule('pfs', 'owner', 'editor');
  // Am I limited to certain entities? Asked once; until the answer is in, no
  // tab is drawn, so a limited person never sees a dashboard tab flash by.
  const [access, setAccess] = useState(null);
  // Stamp the visit for the Access tab's "last opened" column; nothing waits on it.
  useEffect(() => { api.markAccountingOpened?.()?.catch?.(() => {}); }, []);
  useEffect(() => {
    // Code only, never data: a screen this person may not open just downloads its file.
    // No sub, or a group's key, opens that group's first page.
    screenOf(ALIAS[activeSub] || activeSub || 'overview')?.preload?.().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    let alive = true;
    api.getMyAccountingAccess()
      .then((d) => { if (alive) setAccess({ limited: !!d?.limited }); })
      .catch(() => { if (alive) setAccess({ limited: false }); });
    return () => { alive = false; };
  }, []);
  const limited = !!access?.limited;
  // Oct 6: the person's Dashboard density (Overview > Density), on every Dashboard tab.
  const [prefs] = useAccountingPrefs();
  const dashDensity = dashDensityOf(prefs);
  // Data, Intercompany and Investments are the editable reference grids (editors and up).
  const allowed = (key) => (key === 'pfs' ? canPfs : journalOf(key) ? true : limited ? LIMITED_TABS.includes(key) || !!reportOf(key)
    : (!['data', 'intercompany', 'investments'].includes(key) || canEdit) && (key !== 'access' || canManage) && (key !== 'compensation' || canManage) && (key !== 'payroll-summary' || canPayrollSummary));
  // Groups (and the flyouts inside them) keep only the items this person may
  // open; an empty one goes, and a top-level group left with one item is a
  // plain tab under the group's name.
  const prune = (items) => items.map((t) => (t.items ? { ...t, items: prune(t.items) } : t))
    .filter((t) => (t.items ? t.items.length > 0 : allowed(t.key)));
  const tabs = prune(TABS)
    .map((t) => (t.items?.length === 1 && t.key === 'financing' ? { key: t.items[0].key, label: t.label, Icon: t.Icon } : t))
    .map((t) => (t.landing && !leafKeys(t.items || []).includes(t.landing) ? { ...t, landing: undefined } : t));
  const leaves = leafKeys(tabs);
  const group = tabs.find((t) => t.key === activeSub && t.items);
  // A group opens its landing item, else its first - Reports opens the Report
  // Center, not the first statement.
  const firstOf = (t) => {
    if (!t.items) return t.key;
    const keys = leafKeys(t.items);
    return [t.landing, 'reports'].find((k) => k && keys.includes(k)) || keys[0];
  };
  const wanted = group ? firstOf(group) : (ALIAS[activeSub] || activeSub);
  // Any statement or quick view lands, in the menu or not (an old rpt-pnl link).
  const reachable = (k) => leaves.includes(k) || (!!reportOf(k) && allowed(k));
  const sub = reachable(wanted) ? wanted : (tabs[0] ? firstOf(tabs[0]) : leaves[0]);
  useEffect(() => { if (access && sub !== activeSub) onSubChange?.(sub); }, [access, sub, activeSub, onSubChange]);

  // The ledger search, from any tab (Oct 6, Neil: "search bar should always
  // be on the top right in the entire accounting module"): one box, top
  // right of the header, on every tab. On Reports it IS Reports' search box
  // (the text and the spinner are shared with ReportsTab); anywhere else,
  // two characters typed open Reports with the words after a pause, Enter at
  // once. Leaving Reports clears it, so it never bounces anyone back there.
  const [searchText, setSearchText] = useState('');
  const [searchWaiting, setSearchWaiting] = useState(false);
  const searchTimer = useRef(null);
  const goSearch = (text) => {
    if (text.trim().length < 2) return;
    if (!isReports(sub)) onSubChange?.(STATEMENTS_SUB);
  };
  useEffect(() => {
    clearTimeout(searchTimer.current);
    if (!isReports(sub) && searchText.trim().length >= 2) searchTimer.current = setTimeout(() => goSearch(searchText), 600);
    return () => clearTimeout(searchTimer.current);
  }, [searchText]); // eslint-disable-line react-hooks/exhaustive-deps
  // Where the search docks (Neil, 11/06/2026): the right end of the screen's
  // own toolbar (BarSearchSlot in ControlBar and the Report Center row) - the
  // first one on the page; none (a screen with no toolbar) = the page's first
  // row, as before. `searchInUse` brings the box back open when typing on one
  // screen opens Reports and the search moves to that toolbar.
  const [searchSlots, setSearchSlots] = useState([]);
  const searchSlotApi = useMemo(() => ({
    add: (el) => setSearchSlots((s) => (s.includes(el) ? s : [...s, el])),
    remove: (el) => setSearchSlots((s) => s.filter((x) => x !== el)),
  }), []);
  const searchSlot = [...searchSlots].sort((a, b) => ((a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1))[0] || null;
  const [searchInUse, setSearchInUse] = useState(false);
  const lastSub = useRef(sub);
  useEffect(() => {
    if (isReports(lastSub.current) && !isReports(sub)) { setSearchText(''); setSearchWaiting(false); }
    lastSub.current = sub;
  }, [sub]);
  // Reports on one statement from the Reports menu; picking another report
  // in its own Report box moves the bar along (a statement in the menu lights
  // that item; any other is still its own `rpt-` key, the Report Center being
  // the catalogue since Oct 23).
  const onReportPicked = (report) => {
    const next = `rpt-${report}`;
    if (next !== sub) onSubChange?.(next);
  };
  // The Report Center lists what the Reports menu holds for this person.
  const reportGroups = tabs.find((t) => t.key === 'reporting')?.items || [];
  const reportCenter = sub === 'reports' && <ReportCenter groups={reportGroups} limited={limited} onOpen={(to) => onSubChange?.(to)} />;
  const reportsTab = isReports(sub) && (
    <ReportsTab report={reportOf(sub)} view={viewOf(sub)} link={parseActivitySub(sub)} onReportChange={onReportPicked} canEdit={canEdit}
      searchText={searchText} onSearchText={setSearchText} onWaiting={setSearchWaiting} />
  );

  const records = (
    <>
      {sub === 'gl-accounts' && <GlAccountsTab />}
      {sub === 'entities' && <EntitiesTab />}
      {journalOf(sub) && <JournalTab key={sub} symbol={journalOf(sub)} />}
      {sub === 'manual-je' && <ManualJournalEntries />}
    </>
  );
  const partnersTab = (sub === 'partners' || sub === 'customers') && (
    <PartnersTab canApprove={canApprovePartners} initialKind={sub === 'customers' ? 'customer' : 'vendor'} />
  );
  // Every tab has the same one-line header (10/02): the statement still
  // starts high on the page (Neil, Sep 25; Charmi, 10/02) and nothing moves
  // when switching tabs.

  // The dashboard provider loads the consolidated ledger, budgets, NOI and the
  // close tables the moment it mounts (10 reads, the tables every minute), so
  // it wraps only the screens that read it (11/11/2026, Neil: "faster") - the
  // Balance Sheet, Loans or MRE no longer wait behind it. Its figures stay in
  // the query cache, so coming back to the Dashboard shows them at once.
  const withDash = (body) => (DASH_PROVIDER_SUBS.includes(sub) ? (
    <DashProvider>
      {/* The dashboard's "open the report" links mean the statements (they predate the Report Center). */}
      <DashNav.Provider value={(to) => onSubChange?.(to === 'reports' ? STATEMENTS_SUB : to)}>{body}</DashNav.Provider>
    </DashProvider>
  ) : body);

  return (
    <BarSearchSlotContext.Provider value={searchSlotApi}>
    <div className="acct-module" style={{ animation: 'fadeIn var(--transition-normal) ease-in-out' }}>
      {/* One header for every tab (Visesh, 10/02: the search "keeps jumping
          on every screen change"). Oct 6 (Neil): the search sits at the TOP
          RIGHT on every tab, Reports included - title left, the search box
          last. One line, one height, everywhere. */}
      {/* No page title (Neil, 11/06/2026): the module bar names the module and
          the lit tab. The search docks at the right end of the screen's own
          toolbar (searchSlot above). Chat 10/26, item 13: an icon that opens
          on a click or Ctrl+F (ModuleSearch). Oct 7 (Neil, screenshot 3): none
          on PFS. */}
      {access && sub !== 'pfs' && (() => {
        const search = (
          <div className="acct-header-search" onFocus={() => setSearchInUse(true)} onBlur={() => setSearchInUse(false)}>
            <ModuleSearch value={searchText} onChange={setSearchText} waiting={searchWaiting && isReports(sub)} startOpen={searchInUse}
              onSubmit={(text) => { clearTimeout(searchTimer.current); goSearch(text); }} />
          </div>
        );
        return searchSlot ? createPortal(search, searchSlot) : <ModuleActions>{search}</ModuleActions>;
      })()}

      {access && <ModuleTabs tabs={withBadges(tabs, counts, 'accounting')} active={menuKey(sub)} onChange={onSubChange} compactGroups />}

      {!access ? (
        <div style={{ marginTop: 16 }}><SkeletonBlocks count={3} /></div>
      ) : limited ? (
        // No dashboard provider for a limited person: it loads the
        // consolidated ledger the moment it mounts.
        <div style={{ marginTop: 8 }}>
          <Suspense fallback={SCREEN_LOADING}>
            {reportCenter}
            {reportsTab}
            {sub === 'report-builder' && <ReportBuilder canPublish={canPublish} />}
            {sub === 'packages' && <PackagesTab />}
            {sub === 'mri' && <MriTab canEdit={canEdit} canDelete={canManage} />}
            {sub === 'loans' && <LoansTab canEdit={canEdit} />}
            {sub === 'pfs' && canPfs && <PfsTab canEdit={canPfsEdit} />}
            {sub === 'budget' && <BudgetTab canEdit={canEdit} />}
            {partnersTab}
            {records}
            {sub === 'mre' && <MreTab canEdit={canEdit} canDelete={canManage} />}
            {sub === 'imports' && <ImportHub />}
            {sub === 'ama' && <AskAccountantTab canEdit={canEdit} limited />}
            {sub === 'mgmt-fees' && <ManagementFeesTab canEdit={canEdit} />}
            {sub === 'profitability' && <ProfitabilityReport limited />}
          </Suspense>
        </div>
      ) : withDash(
            <div style={{ marginTop: 8 }} className={DASH_SUBS.includes(sub) ? `acct-dash acct-dash--${dashDensity}` : undefined}>
              <Suspense fallback={SCREEN_LOADING}>
                {sub === 'overview' && <OverviewTab canEdit={canEdit} />}
                {sub === 'cash' && <CashTab />}
                {sub === 'performance' && <PerformanceTab canEdit={canEdit} />}
                {sub === 'close' && <CloseTab canEdit={canEdit} meName={meName} />}
                {reportCenter}
                {reportsTab}
                {sub === 'report-builder' && <ReportBuilder canPublish={canPublish} />}
                {sub === 'packages' && <PackagesTab />}
                {sub === 'mri' && <MriTab canEdit={canEdit} canDelete={canManage} />}
                {sub === 'loans' && <LoansTab canEdit={canEdit} />}
                {sub === 'pfs' && canPfs && <PfsTab canEdit={canPfsEdit} />}
                {sub === 'data' && canEdit && <DataTab exclude={['loans', 'intercompany', 'holdings']} />}
                {sub === 'intercompany' && canEdit && <DataTab key="intercompany" only={['intercompany']} />}
                {sub === 'investments' && canEdit && <DataTab key="investments" only={['holdings']} />}
                {sub === 'access' && canManage && <AccessTab />}
                {sub === 'budget' && <BudgetTab canEdit={canEdit} />}
                {partnersTab}
                {records}
                {sub === 'allocations' && <AllocationsTab canEdit={canManage} />}
                {sub === 'mre' && <MreTab canEdit={canEdit} canDelete={canManage} />}
                {sub === 'imports' && <ImportHub />}
                {sub === 'ama' && <AskAccountantTab canEdit={canEdit} />}
                {sub === 'mgmt-fees' && <ManagementFeesTab canEdit={canEdit} />}
                {sub === 'profitability' && <ProfitabilityReport />}
                {sub === 'compensation' && canManage && <CompensationReport />}
                {sub === 'payroll-summary' && canPayrollSummary && <PayrollSummary />}
              </Suspense>
            </div>,
      )}
    </div>
    </BarSearchSlotContext.Provider>
  );
}

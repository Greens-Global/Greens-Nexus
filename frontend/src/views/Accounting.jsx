import { useEffect, useRef, useState } from 'react';
import { Banknote, CheckSquare, Database, ExternalLink, FileStack, FileText, KeyRound, Landmark, LayoutGrid, Loader2, Receipt, Search, ShieldCheck, TrendingUp, Upload, Wallet, Wrench, X } from 'lucide-react';
import { api } from '../api';
import { useRole } from '../contexts/RoleContext';
import { useNameResolver } from '../lib/useNameResolver';
import ModuleTabs from '../components/ModuleTabs';
import ReportsTab from '../components/accounting/ReportsTab';
import PackagesTab from '../components/accounting/PackagesTab';
import AccessTab from '../components/accounting/AccessTab';
import PfsTab from '../components/accounting/PfsTab';
import MriTab from '../components/accounting/MriTab';
import LoansTab from '../components/accounting/LoansTab';
import MreTab from '../components/accounting/MreTab';
import ImportHub from '../components/accounting/ImportHub';
import { control } from '../components/accounting/reportControls';
import { dashDensityOf, useAccountingPrefs } from '../components/accounting/prefs';
import { SkeletonBlocks } from '../components/AsyncState';
import { DashProvider } from '../components/accounting/dashboard/DashContext';
import { DashNav } from '../components/accounting/dashboard/registry';
import OverviewTab from '../components/accounting/dashboard/OverviewTab';
import CashTab from '../components/accounting/dashboard/CashTab';
import PerformanceTab from '../components/accounting/dashboard/PerformanceTab';
import CloseTab from '../components/accounting/dashboard/CloseTab';
import DataTab from '../components/accounting/dashboard/DataTab';
import BudgetTab from '../components/accounting/BudgetTab';
import PartnersTab from '../components/accounting/PartnersTab';
import AllocationsTab from '../components/accounting/AllocationsTab';
import { Calculator, Split, Users } from 'lucide-react';

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

// Oct 6 (Charmi and Neil, 10/04): the bar was fourteen tabs long. It is now
// six, three of them dropdowns: Dashboard (Overview / Cash / Performance /
// Close), Reporting (Reports / Packages / PFS / MRI / MRE) and Tools (Data /
// Access / Allocations / Import Hub). The sub keys did not change - a group
// is only how the bar draws them - so every deep link still lands.
const TABS = [
  { key: 'dashboard', label: 'Dashboard', Icon: LayoutGrid, items: [
    { key: 'overview', label: 'Overview', Icon: LayoutGrid },
    { key: 'cash', label: 'Cash', Icon: Wallet },
    { key: 'performance', label: 'Performance', Icon: TrendingUp },
    { key: 'close', label: 'Close', Icon: CheckSquare },
  ] },
  { key: 'reporting', label: 'Reporting', Icon: FileText, items: [
    { key: 'reports', label: 'Reports', Icon: FileText },
    { key: 'packages', label: 'Packages', Icon: FileStack },
    { key: 'pfs', label: 'PFS', Icon: Landmark },
    { key: 'mri', label: 'MRI', Icon: KeyRound },
    // Oct 6: Monthly Recurring Expenses, beside MRI.
    { key: 'mre', label: 'MRE', Icon: Receipt },
  ] },
  // Oct 2 (Neil and Charmi): loans set up from the ledger and reviewed per
  // month - balances, principal and interest paid, NOI, DSCR against the
  // covenant. Per entity, so a limited person gets it too.
  { key: 'loans', label: 'Loans & Financing', Icon: Banknote },
  // Oct 2 (Charmi and Neil, 10/01 call): a budget per entity and year, vendor
  // and customer records with changes sent for approval, and the monthly
  // payroll allocation entry from Time Clock hours.
  { key: 'budget', label: 'Budget', Icon: Calculator },
  { key: 'partners', label: 'Vendors & Customers', Icon: Users },
  // Oct 6 (Neil: "create a Tools section in accounting"): the utility screens.
  { key: 'tools', label: 'Tools', Icon: Wrench, items: [
    { key: 'data', label: 'Data', Icon: Database },
    { key: 'access', label: 'Access', Icon: ShieldCheck },
    { key: 'allocations', label: 'Allocations', Icon: Split },
    { key: 'imports', label: 'Import Hub', Icon: Upload },
  ] },
];
const LIMITED_TABS = ['reports', 'packages', 'mri', 'mre', 'loans', 'budget', 'partners', 'imports'];
// Links made before a rename still land; a group's own key opens its first item.
const ALIAS = { leasing: 'mri' };
const leafKeys = (tabs) => tabs.flatMap((t) => (t.items ? t.items.map((i) => i.key) : [t.key]));
const DASH_SUBS = ['overview', 'cash', 'performance', 'close'];

export default function Accounting({ activeSub, onSubChange }) {
  // The accounting app is its own grant ("Nexus Accounting App" in Roles &
  // Access); seeing this screen does not imply it. Administrators bypass.
  const { canAccessModule, myEmail } = useRole();
  // The Close tab's "My Tasks" matches a task owner to my role or my name.
  const nameOf = useNameResolver();
  const meName = nameOf(myEmail) || '';
  // Ticking close tasks, marking reconciliations, writing commentary and
  // editing reference figures need the editor level on the Accounting grant.
  const canEdit = canAccessModule('accounting', 'administrator', 'editor');
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
  const allowed = (key) => (key === 'pfs' ? canPfs : limited ? LIMITED_TABS.includes(key) : (key !== 'data' || canEdit) && (key !== 'access' || canManage));
  // Groups keep only the items this person may open; an empty group goes.
  const tabs = TABS.map((t) => (t.items ? { ...t, items: t.items.filter((i) => allowed(i.key)) } : t))
    .filter((t) => (t.items ? t.items.length > 0 : allowed(t.key)));
  const leaves = leafKeys(tabs);
  const group = tabs.find((t) => t.key === activeSub && t.items);
  const wanted = group ? group.items[0].key : (ALIAS[activeSub] || activeSub);
  const sub = leaves.includes(wanted) ? wanted : leaves[0];
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
    if (sub !== 'reports') onSubChange?.('reports');
  };
  useEffect(() => {
    clearTimeout(searchTimer.current);
    if (sub !== 'reports' && searchText.trim().length >= 2) searchTimer.current = setTimeout(() => goSearch(searchText), 600);
    return () => clearTimeout(searchTimer.current);
  }, [searchText]); // eslint-disable-line react-hooks/exhaustive-deps
  const lastSub = useRef(sub);
  useEffect(() => {
    if (lastSub.current === 'reports' && sub !== 'reports') { setSearchText(''); setSearchWaiting(false); }
    lastSub.current = sub;
  }, [sub]);

  // Open Nexus Accounting: the sign-in handoff answers with the app's URL;
  // the tab is opened first (synchronously, so the browser allows it) and
  // then pointed there.
  const [launching, setLaunching] = useState(false);
  const openAccountingApp = () => {
    if (launching) return;
    const tab = window.open('', '_blank');
    setLaunching(true);
    api.launchAccounting()
      .then(({ url }) => { if (tab) tab.location.href = url; else window.open(url, '_blank'); })
      .catch(() => { if (tab) tab.close(); })
      .finally(() => setLaunching(false));
  };

  const subtitle = {
    overview: 'Your dashboard view of the ledger - arrange the widgets that matter to your role',
    cash: 'Consolidated cash position, monthly cash plan by category, and the near-term forecast',
    performance: 'Actuals against budget and prior year, ranked by what matters, with commentary',
    close: 'Month-end close: checklist, reconciliations, balance sheet flux and controls',
    reports: 'Financial reports from the Nexus Accounting ledger',
    packages: 'Sets of memorized reports, built into one PDF for a lender',
    mri: 'Monthly recurring income - leases, and the interest and loan payments coming in',
    loans: 'Every loan from the ledger - balances, principal and interest paid, NOI and DSCR against the covenant',
    pfs: 'Personal financial statements of the guarantors, for any date',
    data: 'Loans, intercompany, investments, partner capital, cap rates, close plan and filing calendar',
    access: 'Which entities each person on the accounting team may read',
    budget: 'The budget per entity and year, by account and month, against the actuals',
    partners: 'Vendor and customer records, with changes sent to a manager for approval before they are keyed into Intacct',
    allocations: 'The monthly payroll allocation entry - wages split across entities by hours worked at each site',
    mre: 'Monthly recurring expenses - what posts every month, by vendor and entity',
    imports: 'Every setup that reads the ledger - loans, leases and recurring expenses',
  }[sub];
  // Every tab has the same one-line header (10/02): the statement still
  // starts high on the page (Neil, Sep 25; Charmi, 10/02) and nothing moves
  // when switching tabs.

  return (
    <div className="acct-module" style={{ animation: 'fadeIn var(--transition-normal) ease-in-out' }}>
      {/* One header for every tab (Visesh, 10/02: the search "keeps jumping
          on every screen change"). Oct 6 (Neil): the search sits at the TOP
          RIGHT on every tab, Reports included - title left, the quiet "Open
          Nexus Accounting" link, then the search box last. One line, one
          height, everywhere. */}
      <div className="view-header acct-header">
        <div className="acct-header-title">
          <h2>Accounting</h2>
          <p title={subtitle}>{subtitle}</p>
        </div>
        <div className="acct-header-actions">
          {/* The way into the accounting app itself. It came off the tabs on
              09/30 (Charmi: "remove it everywhere") and then nobody could find
              it (Charmi, 10/02: "I am not able to find the open Nexus
              Accounting tab?") - so it is one quiet link up here, in a new tab. */}
          {access && (
            <button type="button" onClick={openAccountingApp} disabled={launching} title="Open the Nexus Accounting app in a new tab"
              style={{ ...control, display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap', cursor: launching ? 'wait' : 'pointer', fontWeight: 600 }}>
              <ExternalLink size={14} /> {launching ? 'Opening...' : 'Open Nexus Accounting'}
            </button>
          )}
        </div>
        <div className="acct-header-search">
          {access && (
            <form role="search" onSubmit={(e) => { e.preventDefault(); clearTimeout(searchTimer.current); goSearch(searchText); }} style={{ position: 'relative', width: '100%' }}>
              {searchWaiting && sub === 'reports'
                ? <Loader2 size={14} className="spin" aria-label="Searching" style={{ position: 'absolute', left: 9, top: 8, color: 'var(--wk-brand, #2b45e1)' }} />
                : <Search size={14} style={{ position: 'absolute', left: 9, top: 8, color: 'var(--text-muted)' }} />}
              <input type="text" value={searchText} onChange={(e) => setSearchText(e.target.value)} aria-label="Search the ledger"
                placeholder="Search vendor, customer, invoice, amount, memo..." style={{ ...control, width: '100%', paddingLeft: 28, paddingRight: 26 }} />
              {searchText && (
                <button type="button" onClick={() => setSearchText('')} aria-label="Clear search"
                  style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'inline-flex', padding: 2 }}>
                  <X size={14} />
                </button>
              )}
            </form>
          )}
        </div>
      </div>

      {access && <ModuleTabs tabs={tabs} active={sub} onChange={onSubChange} />}

      {!access ? (
        <div style={{ marginTop: 16 }}><SkeletonBlocks count={3} /></div>
      ) : limited ? (
        // No dashboard provider for a limited person: it loads the
        // consolidated ledger the moment it mounts.
        <div style={{ marginTop: 8 }}>
          {sub === 'reports' && <ReportsTab searchText={searchText} onSearchText={setSearchText} onWaiting={setSearchWaiting} />}
          {sub === 'packages' && <PackagesTab />}
          {sub === 'mri' && <MriTab canEdit={canEdit} canDelete={canManage} />}
          {sub === 'loans' && <LoansTab canEdit={canEdit} />}
          {sub === 'pfs' && canPfs && <PfsTab canEdit={canPfsEdit} />}
          {sub === 'budget' && <BudgetTab canEdit={canEdit} />}
          {sub === 'partners' && <PartnersTab canApprove={canApprovePartners} />}
          {sub === 'mre' && <MreTab canEdit={canEdit} />}
          {sub === 'imports' && <ImportHub available={leaves} onOpen={(k) => onSubChange?.(k)} />}
        </div>
      ) : (
        <DashProvider>
          <DashNav.Provider value={(to) => onSubChange?.(to)}>
            <div style={{ marginTop: 8 }} className={DASH_SUBS.includes(sub) ? `acct-dash acct-dash--${dashDensity}` : undefined}>
              {sub === 'overview' && <OverviewTab canEdit={canEdit} />}
              {sub === 'cash' && <CashTab />}
              {sub === 'performance' && <PerformanceTab canEdit={canEdit} />}
              {sub === 'close' && <CloseTab canEdit={canEdit} meName={meName} />}
              {sub === 'reports' && <ReportsTab searchText={searchText} onSearchText={setSearchText} onWaiting={setSearchWaiting} />}
              {sub === 'packages' && <PackagesTab />}
              {sub === 'mri' && <MriTab canEdit={canEdit} canDelete={canManage} />}
              {sub === 'loans' && <LoansTab canEdit={canEdit} />}
              {sub === 'pfs' && canPfs && <PfsTab canEdit={canPfsEdit} />}
              {sub === 'data' && canEdit && <DataTab />}
              {sub === 'access' && canManage && <AccessTab />}
              {sub === 'budget' && <BudgetTab canEdit={canEdit} />}
              {sub === 'partners' && <PartnersTab canApprove={canApprovePartners} />}
              {sub === 'allocations' && <AllocationsTab canEdit={canManage} />}
              {sub === 'mre' && <MreTab canEdit={canEdit} />}
              {sub === 'imports' && <ImportHub available={leaves} onOpen={(k) => onSubChange?.(k)} />}
            </div>
          </DashNav.Provider>
        </DashProvider>
      )}
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { CheckSquare, Database, FileStack, FileText, KeyRound, Landmark, LayoutGrid, Search, ShieldCheck, TrendingUp, Wallet, X } from 'lucide-react';
import { api } from '../api';
import { useRole } from '../contexts/RoleContext';
import { useNameResolver } from '../lib/useNameResolver';
import ModuleTabs from '../components/ModuleTabs';
import ReportsTab from '../components/accounting/ReportsTab';
import PackagesTab from '../components/accounting/PackagesTab';
import AccessTab from '../components/accounting/AccessTab';
import PfsTab from '../components/accounting/PfsTab';
import MriTab from '../components/accounting/MriTab';
import { control } from '../components/accounting/reportControls';
import { SkeletonBlocks } from '../components/AsyncState';
import { DashProvider } from '../components/accounting/dashboard/DashContext';
import { DashNav } from '../components/accounting/dashboard/registry';
import OverviewTab from '../components/accounting/dashboard/OverviewTab';
import CashTab from '../components/accounting/dashboard/CashTab';
import PerformanceTab from '../components/accounting/dashboard/PerformanceTab';
import CloseTab from '../components/accounting/dashboard/CloseTab';
import DataTab from '../components/accounting/dashboard/DataTab';

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

const TABS = [
  { key: 'overview', label: 'Overview', Icon: LayoutGrid },
  { key: 'cash', label: 'Cash', Icon: Wallet },
  { key: 'performance', label: 'Performance', Icon: TrendingUp },
  { key: 'close', label: 'Close', Icon: CheckSquare },
  { key: 'reports', label: 'Reports', Icon: FileText },
  { key: 'packages', label: 'Packages', Icon: FileStack },
  { key: 'mri', label: 'MRI', Icon: KeyRound },
  { key: 'pfs', label: 'PFS', Icon: Landmark },
  { key: 'data', label: 'Data', Icon: Database },
  { key: 'access', label: 'Access', Icon: ShieldCheck },
];
const LIMITED_TABS = ['reports', 'packages', 'mri'];
// Links made before the rename still land.
const ALIAS = { leasing: 'mri' };

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
  const tabs = TABS.filter((t) => (t.key === 'pfs' ? canPfs : limited ? LIMITED_TABS.includes(t.key) : (t.key !== 'data' || canEdit) && (t.key !== 'access' || canManage)));
  const wanted = ALIAS[activeSub] || activeSub;
  const sub = tabs.some((t) => t.key === wanted) ? wanted : tabs[0].key;
  useEffect(() => { if (access && sub !== activeSub) onSubChange?.(sub); }, [access, sub, activeSub, onSubChange]);

  // The ledger search, from any tab: two characters typed here open Reports
  // with the words (Reports draws the same box itself, so the header's one
  // hides there). Enter goes at once.
  const [headerSearch, setHeaderSearch] = useState('');
  const [search, setSearch] = useState(null);   // { text, nonce } handed to Reports
  const nonce = useRef(0);
  const searchTimer = useRef(null);
  const goSearch = (text) => {
    const t = text.trim();
    if (t.length < 2) return;
    nonce.current += 1;
    setSearch({ text: t, nonce: nonce.current });
    setHeaderSearch('');
    if (sub !== 'reports') onSubChange?.('reports');
  };
  useEffect(() => {
    clearTimeout(searchTimer.current);
    if (headerSearch.trim().length >= 2) searchTimer.current = setTimeout(() => goSearch(headerSearch), 600);
    return () => clearTimeout(searchTimer.current);
  }, [headerSearch]); // eslint-disable-line react-hooks/exhaustive-deps

  const subtitle = {
    overview: 'Your dashboard view of the ledger - arrange the widgets that matter to your role',
    cash: 'Consolidated cash position, monthly cash plan by category, and the near-term forecast',
    performance: 'Actuals against budget and prior year, ranked by what matters, with commentary',
    close: 'Month-end close: checklist, reconciliations, balance sheet flux and controls',
    reports: 'Financial reports from the Nexus Accounting ledger',
    packages: 'Sets of memorized reports, built into one PDF for a lender',
    mri: 'Monthly recurring income - leases, and the interest and loan payments coming in',
    pfs: 'Personal financial statements of the guarantors, for any date',
    data: 'Loans, intercompany, investments, partner capital, cap rates, close plan and filing calendar',
    access: 'Which entities each person on the accounting team may read',
  }[sub];
  // Reports, Packages and Access are working screens: the statement has to
  // start high on the page (Neil, Sep 25), so their header is one line. On
  // Reports it is slimmer still (Charmi, 10/02: "adjust the top width a
  // little bit so we can get more data") - "Accounting · Financial reports
  // ..." on one line with almost no margin, so about six more rows fit.
  const slim = ['reports', 'packages', 'access', 'pfs', 'mri'].includes(sub);
  const slimmer = sub === 'reports';

  return (
    <div className="acct-module" style={{ animation: 'fadeIn var(--transition-normal) ease-in-out' }}>
      <div className="view-header" style={{ marginBottom: slimmer ? 2 : slim ? 6 : 16, alignItems: slim ? 'center' : undefined, ...(slimmer ? { minHeight: 0 } : {}) }}>
        <div className="view-title-group" style={slim ? { display: 'flex', alignItems: 'baseline', gap: slimmer ? 6 : 10, flexWrap: 'wrap' } : undefined}>
          <h2 style={slim ? { fontSize: slimmer ? '1.02rem' : '1.15rem', margin: 0, lineHeight: 1.3 } : undefined}>Accounting</h2>
          <p style={slim ? { margin: 0, fontSize: slimmer ? '0.76rem' : '0.8rem', lineHeight: 1.3 } : undefined}>{slimmer ? `· ${subtitle}` : subtitle}</p>
        </div>
        {access && sub !== 'reports' && (
          <form role="search" onSubmit={(e) => { e.preventDefault(); goSearch(headerSearch); }} style={{ position: 'relative', flex: '0 1 380px', minWidth: 200 }}>
            <Search size={14} style={{ position: 'absolute', left: 9, top: 8, color: 'var(--text-muted)' }} />
            <input type="text" value={headerSearch} onChange={(e) => setHeaderSearch(e.target.value)} aria-label="Search the ledger"
              placeholder="Search vendor, customer, invoice, amount, memo..." style={{ ...control, width: '100%', paddingLeft: 28, paddingRight: 26 }} />
            {headerSearch && (
              <button type="button" onClick={() => setHeaderSearch('')} aria-label="Clear search"
                style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'inline-flex', padding: 2 }}>
                <X size={14} />
              </button>
            )}
          </form>
        )}
      </div>

      {access && <ModuleTabs tabs={tabs} active={sub} onChange={onSubChange} />}

      {!access ? (
        <div style={{ marginTop: 16 }}><SkeletonBlocks count={3} /></div>
      ) : limited ? (
        // No dashboard provider for a limited person: it loads the
        // consolidated ledger the moment it mounts.
        <div style={{ marginTop: slimmer ? 4 : 8 }}>
          {sub === 'reports' && <ReportsTab search={search} />}
          {sub === 'packages' && <PackagesTab />}
          {sub === 'mri' && <MriTab canEdit={canEdit} canDelete={canManage} />}
          {sub === 'pfs' && canPfs && <PfsTab canEdit={canPfsEdit} />}
        </div>
      ) : (
        <DashProvider>
          <DashNav.Provider value={(to) => onSubChange?.(to)}>
            <div style={{ marginTop: slimmer ? 4 : slim ? 8 : 16 }}>
              {sub === 'overview' && <OverviewTab canEdit={canEdit} />}
              {sub === 'cash' && <CashTab />}
              {sub === 'performance' && <PerformanceTab canEdit={canEdit} />}
              {sub === 'close' && <CloseTab canEdit={canEdit} meName={meName} />}
              {sub === 'reports' && <ReportsTab search={search} />}
              {sub === 'packages' && <PackagesTab />}
              {sub === 'mri' && <MriTab canEdit={canEdit} canDelete={canManage} />}
              {sub === 'pfs' && canPfs && <PfsTab canEdit={canPfsEdit} />}
              {sub === 'data' && canEdit && <DataTab />}
              {sub === 'access' && canManage && <AccessTab />}
            </div>
          </DashNav.Provider>
        </DashProvider>
      )}
    </div>
  );
}

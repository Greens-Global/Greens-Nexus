import { useEffect, useState } from 'react';
import { CheckSquare, Database, ExternalLink, FileStack, FileText, KeyRound, Landmark, LayoutGrid, ShieldCheck, TrendingUp, Wallet } from 'lucide-react';
import { api } from '../api';
import { useRole } from '../contexts/RoleContext';
import { useNameResolver } from '../lib/useNameResolver';
import ModuleTabs from '../components/ModuleTabs';
import ReportsTab from '../components/accounting/ReportsTab';
import PackagesTab from '../components/accounting/PackagesTab';
import AccessTab from '../components/accounting/AccessTab';
import PfsTab from '../components/accounting/PfsTab';
import LeasingTab from '../components/accounting/LeasingTab';
import { SkeletonBlocks, Spinner } from '../components/AsyncState';
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
// Leasing only - every other tab shows consolidated figures, and the backend refuses
// them for that person whatever the screen shows.

const TABS = [
  { key: 'overview', label: 'Overview', Icon: LayoutGrid },
  { key: 'cash', label: 'Cash', Icon: Wallet },
  { key: 'performance', label: 'Performance', Icon: TrendingUp },
  { key: 'close', label: 'Close', Icon: CheckSquare },
  { key: 'reports', label: 'Reports', Icon: FileText },
  { key: 'packages', label: 'Packages', Icon: FileStack },
  { key: 'leasing', label: 'Leasing', Icon: KeyRound },
  { key: 'pfs', label: 'PFS', Icon: Landmark },
  { key: 'data', label: 'Data', Icon: Database },
  { key: 'access', label: 'Access', Icon: ShieldCheck },
];
const LIMITED_TABS = ['reports', 'packages', 'leasing'];

export default function Accounting({ activeSub, onSubChange }) {
  // The accounting app is its own grant ("Nexus Accounting App" in Roles &
  // Access); seeing this screen does not imply it. Administrators bypass.
  const { canAccessModule, myEmail } = useRole();
  // The Close tab's "My Tasks" matches a task owner to my role or my name.
  const nameOf = useNameResolver();
  const meName = nameOf(myEmail) || '';
  const canOpenApp = canAccessModule('accounting-app', 'administrator', 'viewer');
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
  useEffect(() => {
    let alive = true;
    api.getMyAccountingAccess()
      .then((d) => { if (alive) setAccess({ limited: !!d?.limited }); })
      .catch(() => { if (alive) setAccess({ limited: false }); });
    return () => { alive = false; };
  }, []);
  const limited = !!access?.limited;
  const tabs = TABS.filter((t) => (t.key === 'pfs' ? canPfs : limited ? LIMITED_TABS.includes(t.key) : (t.key !== 'data' || canEdit) && (t.key !== 'access' || canManage)));
  const sub = tabs.some((t) => t.key === activeSub) ? activeSub : tabs[0].key;
  useEffect(() => { if (access && sub !== activeSub) onSubChange?.(sub); }, [access, sub, activeSub, onSubChange]);

  // Single sign-on into the accounting app. Nexus is the only way in there: the
  // backend provisions the caller (role mapped from their Nexus grant) and
  // returns a one-time URL. The tab is opened synchronously on the click so
  // popup blockers allow it, then pointed at the URL once it arrives.
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState('');
  const openAccounting = () => {
    if (launching) return;
    setLaunching(true);
    setLaunchError('');
    const tab = window.open('', '_blank');
    api.launchAccounting()
      .then(({ url }) => { if (tab) tab.location = url; else window.location.assign(url); })
      .catch((e) => { if (tab) tab.close(); setLaunchError(e?.message || 'Could not open Nexus Accounting.'); })
      .finally(() => setLaunching(false));
  };

  const subtitle = {
    overview: 'Your dashboard view of the ledger - arrange the widgets that matter to your role',
    cash: 'Consolidated cash position, monthly cash plan by category, and the near-term forecast',
    performance: 'Actuals against budget and prior year, ranked by what matters, with commentary',
    close: 'Month-end close: checklist, reconciliations, balance sheet flux and controls',
    reports: 'Financial reports from the Nexus Accounting ledger',
    packages: 'Sets of memorized reports, built into one PDF for a lender',
    leasing: 'Tenants, rent, and what came in against what was expected',
    pfs: 'Personal financial statements of the guarantors, for any date',
    data: 'Loans, intercompany, investments, partner capital, cap rates, close plan and filing calendar',
    access: 'Which entities each person on the accounting team may read',
  }[sub];
  // Reports, Packages and Access are working screens: the statement has to
  // start high on the page (Neil, Sep 25), so their header is one line.
  const slim = ['reports', 'packages', 'access', 'pfs', 'leasing'].includes(sub);

  return (
    <div style={{ animation: 'fadeIn var(--transition-normal) ease-in-out' }}>
      <div className="view-header" style={{ marginBottom: slim ? 6 : 16, alignItems: slim ? 'center' : undefined }}>
        <div className="view-title-group" style={slim ? { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' } : undefined}>
          <h2 style={slim ? { fontSize: '1.15rem', margin: 0 } : undefined}>Accounting</h2>
          <p style={slim ? { margin: 0, fontSize: '0.8rem' } : undefined}>{subtitle}</p>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
          {limited ? null : canOpenApp ? (
            <button type="button" className="primary-btn" onClick={openAccounting} disabled={launching} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, ...(slim ? { fontSize: '0.8rem', padding: '5px 12px' } : {}) }}>
              {launching ? <Spinner size={16} /> : <ExternalLink size={16} />} Open Nexus Accounting
            </button>
          ) : slim ? null : (
            <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', maxWidth: 280, textAlign: 'right' }}>
              The Nexus Accounting app is granted separately in Settings &gt; Access.
            </span>
          )}
          {launchError && <span style={{ fontSize: '0.8rem', color: 'var(--bad-fg, #dc2626)' }}>{launchError}</span>}
        </div>
      </div>

      {access && <ModuleTabs tabs={tabs} active={sub} onChange={onSubChange} />}

      {!access ? (
        <div style={{ marginTop: 16 }}><SkeletonBlocks count={3} /></div>
      ) : limited ? (
        // No dashboard provider for a limited person: it loads the
        // consolidated ledger the moment it mounts.
        <div style={{ marginTop: 8 }}>
          {sub === 'reports' && <ReportsTab />}
          {sub === 'packages' && <PackagesTab />}
          {sub === 'leasing' && <LeasingTab canEdit={canEdit} canDelete={canManage} />}
          {sub === 'pfs' && canPfs && <PfsTab canEdit={canPfsEdit} />}
        </div>
      ) : (
        <DashProvider>
          <DashNav.Provider value={(to) => onSubChange?.(to)}>
            <div style={{ marginTop: slim ? 8 : 16 }}>
              {sub === 'overview' && <OverviewTab canEdit={canEdit} />}
              {sub === 'cash' && <CashTab />}
              {sub === 'performance' && <PerformanceTab canEdit={canEdit} />}
              {sub === 'close' && <CloseTab canEdit={canEdit} meName={meName} />}
              {sub === 'reports' && <ReportsTab />}
              {sub === 'packages' && <PackagesTab />}
              {sub === 'leasing' && <LeasingTab canEdit={canEdit} canDelete={canManage} />}
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

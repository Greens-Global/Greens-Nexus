import { useEffect, useState } from 'react';
import { CheckSquare, Database, ExternalLink, FileText, LayoutGrid, Loader2, TrendingUp, Wallet } from 'lucide-react';
import { api } from '../api';
import { useRole } from '../contexts/RoleContext';
import { useNameResolver } from '../lib/useNameResolver';
import ModuleTabs from '../components/ModuleTabs';
import ReportsTab from '../components/accounting/ReportsTab';
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

const TABS = [
  { key: 'overview', label: 'Overview', Icon: LayoutGrid },
  { key: 'cash', label: 'Cash', Icon: Wallet },
  { key: 'performance', label: 'Performance', Icon: TrendingUp },
  { key: 'close', label: 'Close', Icon: CheckSquare },
  { key: 'reports', label: 'Reports', Icon: FileText },
  { key: 'data', label: 'Data', Icon: Database },
];

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
  const tabs = canEdit ? TABS : TABS.filter((t) => t.key !== 'data');
  const sub = tabs.some((t) => t.key === activeSub) ? activeSub : 'overview';
  useEffect(() => { if (sub !== activeSub) onSubChange?.(sub); }, [sub, activeSub, onSubChange]);

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
    data: 'Loans, intercompany, investments, partner capital, cap rates, close plan and filing calendar',
  }[sub];

  return (
    <div style={{ animation: 'fadeIn var(--transition-normal) ease-in-out' }}>
      <div className="view-header" style={{ marginBottom: 16 }}>
        <div className="view-title-group">
          <h2>Accounting</h2>
          <p>{subtitle}</p>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
          {canOpenApp ? (
            <button type="button" className="primary-btn" onClick={openAccounting} disabled={launching} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              {launching ? <Loader2 size={16} className="spin" /> : <ExternalLink size={16} />} Open Nexus Accounting
            </button>
          ) : (
            <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', maxWidth: 280, textAlign: 'right' }}>
              The Nexus Accounting app is granted separately in Roles &amp; Access.
            </span>
          )}
          {launchError && <span style={{ fontSize: '0.8rem', color: 'var(--bad-fg, #dc2626)' }}>{launchError}</span>}
        </div>
      </div>

      <ModuleTabs tabs={tabs} active={sub} onChange={onSubChange} />

      <DashProvider>
        <DashNav.Provider value={(to) => onSubChange?.(to)}>
          <div style={{ marginTop: 16 }}>
            {sub === 'overview' && <OverviewTab canEdit={canEdit} />}
            {sub === 'cash' && <CashTab />}
            {sub === 'performance' && <PerformanceTab canEdit={canEdit} />}
            {sub === 'close' && <CloseTab canEdit={canEdit} meName={meName} />}
            {sub === 'reports' && <ReportsTab />}
            {sub === 'data' && canEdit && <DataTab />}
          </div>
        </DashNav.Provider>
      </DashProvider>
    </div>
  );
}

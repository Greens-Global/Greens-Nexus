import { useState, useEffect } from 'react';
import { TrendingUp, TrendingDown, DollarSign, Scale, ExternalLink, Loader2 } from 'lucide-react';
import { api } from '../api';
import { useRole } from '../contexts/RoleContext';
import ModuleTabs from '../components/ModuleTabs';
import PnlReport from '../components/accounting/PnlReport';
import ReportsTab from '../components/accounting/ReportsTab';

// Accounting in Nexus is read-only reporting over the Nexus Accounting ledger
// (a one-way Intacct -> Supabase mirror; Intacct stays the source of truth and
// nothing is ever written back to it - Neil, Sep 7). Only surfaces that are
// actually wired to that ledger are listed here; the old mock tabs
// (Transactions, Invoices, Budgets, Import Hub, Ramp Cards, Vendors, Ask My
// Accountant, AMA Entities, MRE, MRI, Reports) were removed Sep 8 until each
// one has real data behind it. To add a tab: add a report route in the
// accounting app (/api/internal/reports/*), a proxy in
// backend/routers/accounting.py, an api.js entry, then the tab here.
const TABS = [
  { key: 'pnl', label: 'Profit & Loss' },
  { key: 'reports', label: 'Reports' },
];

const usd = (n) => n == null ? '-' : `$${Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : Math.abs(n) >= 1e3 ? `${(n / 1e3).toFixed(0)}K` : Math.round(n).toLocaleString('en-US')}`;

export default function Accounting({ activeSub, onSubChange }) {
  const sub = TABS.some((t) => t.key === activeSub) ? activeSub : 'pnl';
  // The accounting app is its own grant ("Nexus Accounting App" in Roles &
  // Access); seeing this screen does not imply it. Administrators bypass.
  const { canAccessModule } = useRole();
  const canOpenApp = canAccessModule('accounting-app', 'administrator', 'viewer');

  // Year-to-date headline numbers for the KPI cards. The Profit & Loss tab
  // does its own range-driven fetch; this one is fixed to the calendar year so
  // the cards read the same regardless of the tab.
  const [ytd, setYtd] = useState(null);
  const [ytdError, setYtdError] = useState('');
  // Entities (Intacct locations, named) for the P&L tab's filter.
  const [locations, setLocations] = useState([]);
  useEffect(() => {
    api.getAccountingLocations().then((d) => setLocations(d?.entities || [])).catch(() => setLocations([]));
  }, []);
  useEffect(() => {
    const now = new Date();
    const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    api.getAccountingPnl(`${now.getFullYear()}-01-01`, iso(now))
      .then((d) => setYtd(d?.totals || null))
      .catch((e) => { setYtd(null); setYtdError(e?.message || 'Could not reach the accounting ledger.'); });
  }, []);

  const helper = ytd ? 'Calendar year to date' : ytdError ? 'Ledger unavailable' : 'Loading from the ledger';

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
      .then(({ url }) => {
        if (tab) tab.location = url; else window.location.assign(url);
      })
      .catch((e) => {
        if (tab) tab.close();
        setLaunchError(e?.message || 'Could not open Nexus Accounting.');
      })
      .finally(() => setLaunching(false));
  };

  return (
    <div style={{ animation: 'fadeIn var(--transition-normal) ease-in-out' }}>
      <div className="view-header" style={{ marginBottom: 24 }}>
        <div className="view-title-group">
          <h2>Accounting</h2>
          <p>Financial reports from the Nexus Accounting ledger</p>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
          {canOpenApp ? (
            <button type="button" className="primary-btn" onClick={openAccounting} disabled={launching}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
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

      {/* KPI Cards */}
      <div className="cards-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 24 }}>
        {[
          { label: 'Revenue (YTD)',      value: usd(ytd?.revenue),      color: 'card-green', Icon: TrendingUp },
          { label: 'Gross Profit (YTD)', value: usd(ytd?.gross_profit), color: 'card-green', Icon: Scale },
          { label: 'Expenses (YTD)',     value: usd(ytd?.expense),      color: 'card-blue',  Icon: TrendingDown },
          { label: 'Net Income (YTD)',   value: usd(ytd?.net_income),   color: (ytd?.net_income ?? 0) >= 0 ? 'card-green' : 'card-red', Icon: DollarSign },
        ].map(({ label, value, color, Icon }) => (
          <div key={label} className={`kpi-card ${color}`} style={{ cursor: 'pointer' }} onClick={() => onSubChange('pnl')}>
            <div className="kpi-card-header">
              <span className="kpi-title">{label}</span>
              <div className="kpi-icon-container"><Icon size={18} /></div>
            </div>
            <div className="kpi-stat" style={{ fontSize: '2rem' }}>{value}</div>
            <div className="kpi-helper" style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{helper}</div>
          </div>
        ))}
      </div>

      {/* Desktop: tabs render centered in the top header; phones keep the
          in-page strip (ModuleTabs handles both) */}
      <ModuleTabs tabs={TABS} active={sub} onChange={onSubChange} />

      <div style={{ marginBottom: 24 }}>
        {sub === 'pnl' && <PnlReport locations={locations} />}
        {sub === 'reports' && <ReportsTab />}
      </div>
    </div>
  );
}

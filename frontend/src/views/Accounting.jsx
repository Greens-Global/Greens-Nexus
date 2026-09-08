import { useState, useEffect } from 'react';
import { TrendingUp, TrendingDown, DollarSign, Scale } from 'lucide-react';
import { api } from '../api';
import ModuleTabs from '../components/ModuleTabs';
import PnlReport from '../components/accounting/PnlReport';

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
];

const usd = (n) => n == null ? '-' : `$${Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : Math.abs(n) >= 1e3 ? `${(n / 1e3).toFixed(0)}K` : Math.round(n).toLocaleString('en-US')}`;

export default function Accounting({ activeSub, onSubChange }) {
  const sub = TABS.some((t) => t.key === activeSub) ? activeSub : 'pnl';

  // Year-to-date headline numbers for the KPI cards. The Profit & Loss tab
  // does its own range-driven fetch; this one is fixed to the calendar year so
  // the cards read the same regardless of the tab.
  const [ytd, setYtd] = useState(null);
  const [ytdError, setYtdError] = useState('');
  useEffect(() => {
    const now = new Date();
    const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    api.getAccountingPnl(`${now.getFullYear()}-01-01`, iso(now))
      .then((d) => setYtd(d?.totals || null))
      .catch((e) => { setYtd(null); setYtdError(e?.message || 'Could not reach the accounting ledger.'); });
  }, []);

  const helper = ytd ? 'Calendar year to date' : ytdError ? 'Ledger unavailable' : 'Loading from the ledger';

  return (
    <div style={{ animation: 'fadeIn var(--transition-normal) ease-in-out' }}>
      <div className="view-header" style={{ marginBottom: 24 }}>
        <div className="view-title-group">
          <h2>Accounting</h2>
          <p>Financial reports from the Nexus Accounting ledger</p>
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
        {sub === 'pnl' && <PnlReport />}
      </div>
    </div>
  );
}

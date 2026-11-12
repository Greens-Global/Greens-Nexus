import { useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, Download, Landmark, Megaphone, Pin, Sprout, Trash2 } from 'lucide-react';
import { api } from '../api';
import { formatCurrency, formatDate, formatMultiple, formatPercent, statusColor, statusLabel } from './lib/format';
import { EmptyState, ErrorState, LoadingState, StatusText, useIrLoad } from './lib/ui';
import { Spinner } from '../components/AsyncState';
import { dialog } from '../ui/dialog';
import { HOLD_MAJOR_MS } from '../ui/HoldButton';

// GP-side portfolio overview: raise / call / distribute KPIs plus what needs
// attention next (upcoming calls, recent distributions, latest updates).
export default function DashboardTab({ onOpenTab }) {
  const { data, loading, error, reload } = useIrLoad(() => api.getIrDashboard(), []);
  // Live from Intacct over the linked deals; nothing shows without Accounting access.
  const { data: live } = useIrLoad(() => api.getIrFundsBooks().catch(() => null), []);
  const [seeding, setSeeding] = useState(false);
  const [seedErr, setSeedErr] = useState('');

  if (loading) return <LoadingState />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  const d = data || {};

  const seed = async () => {
    setSeeding(true); setSeedErr('');
    try {
      await api.seedIrDemoData();
      await reload();
    } catch (e) {
      setSeedErr(e?.message || 'Could not load the sample portfolio.');
    } finally {
      setSeeding(false);
    }
  };

  if (!d.fundCount) {
    return (
      <EmptyState icon={Landmark} title="No Deals Yet"
        sub="Create your first deal from the Deals tab, or load a sample portfolio to explore every screen in this module.">
        {seedErr && <div style={{ color: 'hsl(var(--color-red))', fontSize: 12.5, marginBottom: 10 }}>{seedErr}</div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
          <button className="primary-btn" onClick={() => onOpenTab('investor-funds')} style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
            <Download size={14} /> Import From Intacct
          </button>
          <button className="secondary-btn" disabled={seeding} onClick={seed} style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
            {seeding ? <Spinner size={14} /> : <Sprout size={14} />} Load Sample Portfolio
          </button>
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 10 }}>
          Demo / sample data for local review - deals, investors, commitments, capital calls, and distributions.
        </div>
      </EmptyState>
    );
  }

  // The sample portfolio goes in one held action; the server deletes only
  // what the seed made (its deals by name, its investors by name and email).
  const removeSample = () => dialog.confirm(
    'The three sample deals, their commitments, calls, distributions, documents and posts, and the sample investors are deleted. Real deals and investors stay.',
    { title: 'Remove Sample Data?', hold: true, holdMs: HOLD_MAJOR_MS, confirmText: 'Remove Sample Data', doneText: 'Removed',
      onConfirm: async () => { await api.removeIrSampleData(); await reload(); } });

  const calledPct = d.totalCommitted > 0 ? `${((d.totalCalled / d.totalCommitted) * 100).toFixed(0)}% of committed` : '-';
  const byStatus = d.fundsByStatus || {};
  const kpis = [
    ['card-blue',   'Total Committed',     formatCurrency(d.totalCommitted),   `Across ${d.fundCount} deal${d.fundCount === 1 ? '' : 's'}`],
    ['card-orange', 'Called to Date',      formatCurrency(d.totalCalled),      calledPct],
    ['card-green',  'Distributed to Date', formatCurrency(d.totalDistributed), 'Returned to LPs'],
    ['card-blue',   'Unfunded Commitment', formatCurrency(d.totalUnfunded),    'Remaining callable capital'],
    ['card-green',  'Active Investors',    d.investorCount ?? 0,               'Members with capital in'],
    ['card-blue',   'Active Deals',        d.activeFundCount ?? 0,             `${byStatus.raising ?? 0} raising · ${byStatus.exited ?? 0} exited`],
    ['card-green',  'Avg IRR',             formatPercent(d.avgIrrPct),         'Net to investors'],
    ['card-blue',   'Avg MOIC',            formatMultiple(d.avgMoic),          'Multiple on invested capital'],
  ];

  const liveRows = live?.allowed ? Object.values(live.deals || {}).filter(x => !x.error) : [];
  const liveKpis = liveRows.length ? {
    count: liveRows.length,
    partnerCapital: liveRows.reduce((t, x) => t + (x.partnerCapital || 0), 0),
    bookEquity: liveRows.reduce((t, x) => t + (x.bookEquity || 0), 0),
    cash: liveRows.reduce((t, x) => t + (x.cash || 0), 0),
  } : null;
  const calls = d.upcomingCapitalCalls || [];
  const dists = d.recentDistributions || [];
  const updates = d.recentUpdates || [];
  const today = new Date().toISOString().slice(0, 10);

  const listRow = (key, onClick, left, right) => (
    <div key={key} onClick={onClick} role="button" tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter') onClick(); }}
      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, padding: '10px 4px', borderBottom: '1px solid var(--line)', cursor: 'pointer' }}
      onMouseEnter={e => { e.currentTarget.style.background = 'var(--mist)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
      {left}
      {right}
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {d.sampleFunds > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', padding: '10px 14px', border: '1px solid var(--line)', borderRadius: 10, fontSize: 12.5, color: 'var(--ink)' }}>
          <span>{d.sampleFunds} sample deal{d.sampleFunds === 1 ? ' is' : 's are'} still here. Remove the sample data before importing real deals from Intacct.</span>
          <button type="button" className="secondary-btn" onClick={removeSample} style={{ fontSize: 12, padding: '5px 12px', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Trash2 size={13} /> Remove Sample Data
          </button>
        </div>
      )}
      {liveKpis && (
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--muted)', marginBottom: 8 }}>
            Live From Intacct - {liveKpis.count} linked deal{liveKpis.count === 1 ? '' : 's'}, as of {formatDate(live.asOf)}
          </div>
          <div className="kpi-grid">
            {[['Partner Capital', liveKpis.partnerCapital, 'Members\' capital accounts'], ['Book Equity', liveKpis.bookEquity, 'Assets less liabilities'], ['Cash', liveKpis.cash, 'Bank accounts']].map(([label, value, sub]) => (
              <div key={label} className="kpi-card card-green">
                <div className="kpi-label">{label}</div>
                <div className="kpi-value">{formatCurrency(value)}</div>
                <div className="kpi-delta">{sub}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="kpi-grid">
        {kpis.map(([cls, label, value, sub]) => (
          <div key={label} className={`kpi-card ${cls}`}>
            <div className="kpi-label">{label}</div>
            <div className="kpi-value">{value}</div>
            <div className="kpi-delta">{sub}</div>
          </div>
        ))}
      </div>

      {/* Deals by status - flat dot legend, no chips */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap', fontSize: 12.5, color: 'var(--muted)' }}>
        <span style={{ fontWeight: 700, fontSize: 11, textTransform: 'uppercase', letterSpacing: '.04em' }}>Deals by Status</span>
        {['raising', 'active', 'exited'].map(s => (
          <span key={s} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: statusColor(s) }} />
            {statusLabel(s)} <strong style={{ color: 'var(--ink)' }}>{byStatus[s] ?? 0}</strong>
          </span>
        ))}
      </div>

      <div className="dash-grid-2">
        <div className="dash-card">
          <div className="dash-card-head">
            <div>
              <div className="dash-card-title" style={{ display: 'flex', alignItems: 'center', gap: 7 }}><ArrowDownToLine size={15} /> Upcoming Capital Calls</div>
              <div className="dash-card-sub">Issued calls with capital still outstanding</div>
            </div>
          </div>
          {calls.length === 0
            ? <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '14px 0' }}>No open capital calls.</div>
            : calls.map(c => {
              const overdue = c.dueDate && c.dueDate < today && (c.pendingAmount ?? 0) > 0;
              return listRow(c.id, () => onOpenTab('investor-capital-calls'),
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.title}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 1 }}>{c.fundName} · Due {formatDate(c.dueDate)}</div>
                </div>,
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', fontVariantNumeric: 'tabular-nums' }}>{formatCurrency(c.pendingAmount)}</div>
                  <StatusText status={overdue ? 'overdue' : 'issued'} label={overdue ? 'Overdue' : 'Collecting'} size={11.5} />
                </div>);
            })}
        </div>

        <div className="dash-card">
          <div className="dash-card-head">
            <div>
              <div className="dash-card-title" style={{ display: 'flex', alignItems: 'center', gap: 7 }}><ArrowUpFromLine size={15} /> Recent Distributions</div>
              <div className="dash-card-sub">Latest capital returned to investors</div>
            </div>
          </div>
          {dists.length === 0
            ? <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '14px 0' }}>No distributions yet.</div>
            : dists.map(x => listRow(x.id, () => onOpenTab('investor-distributions'),
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{x.title}</div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 1 }}>{x.fundName} · {formatDate(x.distributionDate)}</div>
              </div>,
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'hsl(var(--color-green))', fontVariantNumeric: 'tabular-nums' }}>{formatCurrency(x.totalAmount)}</div>
                <StatusText status="paid" label="Distributed" size={11.5} />
              </div>))}
        </div>
      </div>

      <div className="dash-card">
        <div className="dash-card-head">
          <div>
            <div className="dash-card-title" style={{ display: 'flex', alignItems: 'center', gap: 7 }}><Megaphone size={15} /> Recent Updates</div>
            <div className="dash-card-sub">Latest investor communications</div>
          </div>
          <button className="secondary-btn" style={{ fontSize: 12, padding: '5px 12px' }} onClick={() => onOpenTab('investor-updates')}>View All</button>
        </div>
        {updates.length === 0
          ? <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '14px 0' }}>No updates posted yet.</div>
          : updates.map(u => listRow(u.id, () => onOpenTab('investor-updates'),
            <div style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
              {u.pinned && <Pin size={13} style={{ color: 'hsl(var(--color-blue))', flexShrink: 0 }} />}
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.title}</div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 1 }}>{u.fundName || 'All Deals'}</div>
              </div>
            </div>,
            <div style={{ fontSize: 11.5, color: 'var(--muted)', flexShrink: 0 }}>{formatDate(u.createdAt)}</div>))}
      </div>
    </div>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api } from '../../api';
import { SkeletonBlocks } from '../AsyncState';
import { formatDate } from '../../lib/datetime';

// Profit and loss, served by Greens Accounting from the Supabase mirror of the
// Intacct ledger (never from Intacct itself). Read-only. Period presets plus a
// custom range; optional Intacct location filter. Amounts are whole dollars.

const money = (n) => {
  const v = Number(n) || 0;
  const s = Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 });
  return v < 0 ? `(${s})` : s;
};
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const monthLabel = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleString('en-US', { month: 'short', year: '2-digit' });
};

function presetRange(key) {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  switch (key) {
    case 'month': return [new Date(y, m, 1), now];
    case 'last-month': return [new Date(y, m - 1, 1), new Date(y, m, 0)];
    case 'quarter': return [new Date(y, Math.floor(m / 3) * 3, 1), now];
    case 'last-year': return [new Date(y - 1, 0, 1), new Date(y - 1, 11, 31)];
    case 'ytd':
    default: return [new Date(y, 0, 1), now];
  }
}

const PRESETS = [
  { key: 'month', label: 'This Month' },
  { key: 'last-month', label: 'Last Month' },
  { key: 'quarter', label: 'This Quarter' },
  { key: 'ytd', label: 'Year to Date' },
  { key: 'custom', label: 'Custom' },
];

export default function PnlReport({ locations = [] }) {
  const [preset, setPreset] = useState('ytd');
  const [[from, to], setRange] = useState(() => presetRange('ytd').map(iso));
  const [location, setLocation] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showAccounts, setShowAccounts] = useState(false);

  useEffect(() => {
    if (preset !== 'custom') setRange(presetRange(preset).map(iso));
  }, [preset]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    api.getAccountingPnl(from, to, location || undefined)
      .then((d) => { if (alive) setData(d); })
      .catch((e) => { if (alive) setError(e?.message || 'Could not load the profit and loss.'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [from, to, location]);

  const t = data?.totals;
  const maxMonth = useMemo(() => Math.max(1, ...((data?.monthly || []).map((m) => Math.max(m.revenue, m.expenses)))), [data]);

  const card = { backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 20, boxShadow: 'var(--shadow-sm)' };
  const pill = (active) => ({
    padding: '6px 12px', borderRadius: 999, fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
    border: `1px solid ${active ? 'var(--wk-brand, #2b45e1)' : 'var(--border-color)'}`,
    background: active ? 'var(--wk-brand-tint, #e8ecfd)' : 'var(--bg-card)',
    color: active ? 'var(--wk-brand, #2b45e1)' : 'var(--text-secondary)',
  });

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      {/* Controls */}
      <div style={{ ...card, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
        <div className="scroll-tabs" style={{ display: 'flex', gap: 6 }}>
          {PRESETS.map((p) => (
            <button key={p.key} type="button" style={pill(preset === p.key)} onClick={() => setPreset(p.key)}>{p.label}</button>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto', flexWrap: 'wrap' }}>
          <input type="date" value={from} max={to} disabled={preset !== 'custom'}
            onChange={(e) => setRange([e.target.value, to])}
            style={{ padding: '6px 8px', borderRadius: 8, border: '1px solid var(--border-color)', fontSize: '0.8rem', fontFamily: 'inherit' }} />
          <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>to</span>
          <input type="date" value={to} min={from} disabled={preset !== 'custom'}
            onChange={(e) => setRange([from, e.target.value])}
            style={{ padding: '6px 8px', borderRadius: 8, border: '1px solid var(--border-color)', fontSize: '0.8rem', fontFamily: 'inherit' }} />
          <select value={location} onChange={(e) => setLocation(e.target.value)}
            style={{ padding: '6px 8px', borderRadius: 8, border: '1px solid var(--border-color)', fontSize: '0.8rem', fontFamily: 'inherit', background: 'var(--bg-card)' }}>
            <option value="">All locations</option>
            {locations.map((l) => <option key={l.code} value={l.code}>{l.name ? `${l.code} - ${l.name}` : l.code}</option>)}
          </select>
        </div>
      </div>

      {error && (
        <div style={{ ...card, borderColor: 'var(--bad-fg, #dc2626)', color: 'var(--bad-fg, #dc2626)', fontSize: '0.9rem' }}>{error}</div>
      )}

      {loading && !data && <SkeletonBlocks count={4} />}

      {t && (
        <>
          {/* Headline numbers */}
          <div className="cards-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
            {[
              { label: 'Revenue', value: t.revenue, tone: 'card-green' },
              { label: 'Gross Profit', value: t.gross_profit, tone: 'card-green' },
              { label: 'Operating Expenses', value: t.expense, tone: 'card-blue' },
              { label: 'Net Income', value: t.net_income, tone: t.net_income >= 0 ? 'card-green' : 'card-red' },
            ].map((k) => (
              <div key={k.label} className={`kpi-card ${k.tone}`}>
                <div className="kpi-card-header"><span className="kpi-title">{k.label}</span></div>
                <div className="kpi-stat" style={{ fontSize: '1.7rem', fontVariantNumeric: 'tabular-nums' }}>${money(k.value)}</div>
                <div className="kpi-helper" style={{ color: 'var(--text-secondary)' }}>
                  {formatDate(from)} - {formatDate(to)}{loading ? ' · refreshing' : ''}
                </div>
              </div>
            ))}
          </div>

          {/* Monthly trend */}
          {data.monthly?.length > 1 && (
            <div style={card}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
                <h3 style={{ fontSize: '1rem', margin: 0 }}>Revenue vs. Expenses by Month</h3>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                  <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: 'var(--ok-fg, #15803d)', marginRight: 4 }} />Revenue
                  <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: 'var(--text-muted, #9ca3af)', margin: '0 4px 0 12px' }} />Expenses
                </span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: `repeat(${data.monthly.length}, 1fr)`, gap: 8, alignItems: 'end', height: 140 }}>
                {data.monthly.map((m) => (
                  <div key={m.month} title={`${monthLabel(m.month)}: revenue $${money(m.revenue)}, expenses $${money(m.expenses)}, net $${money(m.net)}`}
                    style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, height: '100%', justifyContent: 'flex-end' }}>
                    <div style={{ display: 'flex', gap: 2, alignItems: 'end', height: 110, width: '100%', justifyContent: 'center' }}>
                      <div style={{ width: '40%', height: `${(m.revenue / maxMonth) * 100}%`, background: 'var(--ok-fg, #15803d)', borderRadius: '3px 3px 0 0', minHeight: 1 }} />
                      <div style={{ width: '40%', height: `${(m.expenses / maxMonth) * 100}%`, background: 'var(--text-muted, #9ca3af)', borderRadius: '3px 3px 0 0', minHeight: 1 }} />
                    </div>
                    <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>{monthLabel(m.month)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Statement */}
          <div style={card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div>
                <h3 style={{ fontSize: '1rem', margin: 0 }}>Profit and Loss</h3>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                  {data.org}{location ? ` · location ${location}` : ' · all locations'} · accrual · from the Nexus Accounting ledger
                </div>
              </div>
              <button type="button" className="secondary-btn" style={{ fontSize: '0.75rem', padding: '4px 10px' }} onClick={() => setShowAccounts((v) => !v)}>
                {showAccounts ? 'Hide Accounts' : 'Show Accounts'}
              </button>
            </div>
            <div className="req-table-wrapper">
              <table className="req-table" style={{ fontVariantNumeric: 'tabular-nums' }}>
                <tbody>
                  {data.sections.map((s) => (
                    <SectionRows key={s.key} section={s} open={showAccounts} />
                  ))}
                  <tr style={{ fontWeight: 700, borderTop: '2px solid var(--border-color)' }}>
                    <td>Gross Profit</td><td style={{ textAlign: 'right' }}>{money(t.gross_profit)}</td>
                  </tr>
                  <tr style={{ fontWeight: 700 }}>
                    <td>Operating Income</td><td style={{ textAlign: 'right' }}>{money(t.operating_income)}</td>
                  </tr>
                  <tr style={{ fontWeight: 800, fontSize: '1.02rem' }}>
                    <td>Net Income</td>
                    <td style={{ textAlign: 'right', color: t.net_income >= 0 ? 'var(--ok-fg, #15803d)' : 'var(--bad-fg, #dc2626)' }}>{money(t.net_income)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div style={{ marginTop: 10, fontSize: '0.72rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <RefreshCw size={11} /> Generated {formatDate(data.generated_at)}; figures refresh every 5 minutes.
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function SectionRows({ section, open }) {
  if (!section.accounts.length && !section.total) return null;
  return (
    <>
      <tr style={{ fontWeight: 700, background: 'var(--bg-secondary)' }}>
        <td>{section.label}</td>
        <td style={{ textAlign: 'right' }}>{money(section.total)}</td>
      </tr>
      {open && section.accounts.map((a) => (
        <tr key={a.account_no}>
          <td style={{ paddingLeft: 24, color: 'var(--text-secondary)' }}>
            <span style={{ fontFamily: 'monospace', fontSize: '0.78rem', marginRight: 8 }}>{a.account_no}</span>{a.title}
          </td>
          <td style={{ textAlign: 'right' }}>{money(a.amount)}</td>
        </tr>
      ))}
    </>
  );
}

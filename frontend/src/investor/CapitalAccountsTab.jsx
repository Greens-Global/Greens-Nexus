import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, FileSpreadsheet, Printer } from 'lucide-react';
import { api } from '../api';
import { formatCurrency, formatDate, formatMultiple, formatPercent } from './lib/format';
import { EmptyState, ErrorState, LoadingState, Modal, useIrLoad } from './lib/ui';

// The investor capital-account report - every deal x investor position, with
// the full dated cash-flow ledger behind each row. This is the statement an
// investor would actually receive, so the layout stays clean enough to print.

const COLS = [
  { key: 'investorName', label: 'Investor',    align: 'left'  },
  { key: 'fundName',     label: 'Deal',        align: 'left'  },
  { key: 'committed',    label: 'Committed',   align: 'right' },
  { key: 'called',       label: 'Called',      align: 'right' },
  { key: 'unfunded',     label: 'Unfunded',    align: 'right' },
  { key: 'distributed',  label: 'Distributed', align: 'right' },
  { key: 'dpi',          label: 'DPI',         align: 'right' },
  { key: 'tvpi',         label: 'TVPI',        align: 'right' },
  { key: 'irrPct',       label: 'IRR',         align: 'right' },
];

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function signedAmount(v) {
  const n = Number(v) || 0;
  return `${n < 0 ? '−' : '+'}${formatCurrency(Math.abs(n))}`;
}

// Standalone printable statement in a popup - keeps the app's modal DOM out of
// the print flow entirely.
function printStatement(det) {
  const w = window.open('', '_blank', 'width=820,height=940');
  if (!w) return;
  let running = 0;
  const rows = (det.cashFlows || []).map(cf => {
    running += Number(cf.amount) || 0;
    return `<tr>
      <td>${esc(formatDate(cf.date))}</td>
      <td>${esc(cf.label)}</td>
      <td class="t">${esc(cf.type === 'call' ? 'Capital Call' : 'Distribution')}</td>
      <td class="r">${esc(signedAmount(cf.amount))}</td>
      <td class="r">${esc(formatCurrency(running))}</td>
    </tr>`;
  }).join('');
  const cell = (label, value) => `<div class="cell"><div class="cl">${esc(label)}</div><div class="cv">${esc(value)}</div></div>`;
  w.document.write(`<!doctype html><html><head><title>Capital Account Statement - ${esc(det.investorName)}</title><style>
    body { font-family: Inter, -apple-system, 'Segoe UI', sans-serif; color: #0f172a; margin: 40px; }
    .eyebrow { font-size: 10px; letter-spacing: .12em; text-transform: uppercase; color: #64748b; font-weight: 700; }
    h1 { font-size: 22px; margin: 6px 0 2px; letter-spacing: -.02em; }
    .sub { font-size: 12px; color: #64748b; margin-bottom: 24px; }
    .grid { display: grid; grid-template-columns: repeat(4, 1fr); border-top: 1px solid #e2e8f0; border-bottom: 1px solid #e2e8f0; padding: 14px 0; margin-bottom: 28px; gap: 12px 20px; }
    .cl { font-size: 9.5px; text-transform: uppercase; letter-spacing: .06em; color: #64748b; font-weight: 700; }
    .cv { font-size: 15px; font-weight: 600; margin-top: 3px; font-variant-numeric: tabular-nums; }
    h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; margin: 0 0 10px; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: #64748b; border-bottom: 1px solid #0f172a; padding: 6px 8px; }
    td { padding: 7px 8px; border-bottom: 1px solid #e2e8f0; font-variant-numeric: tabular-nums; }
    .r { text-align: right; } th.r { text-align: right; }
    .t { color: #64748b; }
    .foot { margin-top: 32px; font-size: 10px; color: #94a3b8; }
  </style></head><body>
    <div class="eyebrow">Capital Account Statement</div>
    <h1>${esc(det.investorName)}</h1>
    <div class="sub">${esc(det.fundName)} &middot; As of ${esc(formatDate(det.asOf))}</div>
    <div class="grid">
      ${cell('Committed', formatCurrency(det.committed))}
      ${cell('Called', formatCurrency(det.called))}
      ${cell('Unfunded', formatCurrency(det.unfunded))}
      ${cell('Distributed', formatCurrency(det.distributed))}
      ${cell('DPI', formatMultiple(det.dpi))}
      ${cell('TVPI', formatMultiple(det.tvpi))}
      ${cell('Net IRR', det.irrPct === null || det.irrPct === undefined ? '-' : formatPercent(det.irrPct))}
    </div>
    <h2>Cash-Flow Ledger</h2>
    <table>
      <thead><tr><th>Date</th><th>Activity</th><th>Type</th><th class="r">Amount</th><th class="r">Net Cash Flow</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5">No cash flows recorded.</td></tr>'}</tbody>
    </table>
    <div class="foot">Generated ${esc(formatDate(new Date().toISOString()))} &middot; Nexus &middot; Amounts shown from the investor's perspective: capital calls negative, distributions positive.</div>
  </body></html>`);
  w.document.close();
  w.focus();
  w.print();
}

export default function CapitalAccountsTab() {
  const [fundFilter, setFundFilter] = useState('');
  const [investorFilter, setInvestorFilter] = useState('');
  const { data: accounts, loading, error, reload } =
    useIrLoad(() => api.getIrCapitalAccounts({ fundId: fundFilter, investorId: investorFilter }), [fundFilter, investorFilter]);

  const [funds, setFunds] = useState([]);
  const [investors, setInvestors] = useState([]);
  useEffect(() => {
    api.getIrFunds().then(d => setFunds(Array.isArray(d) ? d : [])).catch(() => {});
    api.getIrInvestors().then(d => setInvestors(Array.isArray(d) ? d : [])).catch(() => {});
  }, []);

  const [sort, setSort] = useState({ key: 'investorName', dir: 'asc' });
  const toggleSort = (key) => setSort(s => s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'investorName' || key === 'fundName' ? 'asc' : 'desc' });

  const rows = useMemo(() => {
    const list = [...(accounts || [])];
    const { key, dir } = sort;
    const mul = dir === 'asc' ? 1 : -1;
    list.sort((a, b) => {
      const av = a[key]; const bv = b[key];
      // nulls (e.g. IRR with no history) always sort last
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      if (typeof av === 'string') return av.localeCompare(bv) * mul;
      return (av - bv) * mul;
    });
    return list;
  }, [accounts, sort]);

  const totals = useMemo(() => {
    const t = { committed: 0, called: 0, unfunded: 0, distributed: 0 };
    for (const r of rows) {
      t.committed += Number(r.committed) || 0;
      t.called += Number(r.called) || 0;
      t.unfunded += Number(r.unfunded) || 0;
      t.distributed += Number(r.distributed) || 0;
    }
    t.dpi = t.called > 0 ? t.distributed / t.called : null;
    return t;
  }, [rows]);

  // Detail statement
  const [detail, setDetail] = useState(null); // { loading, error, data, row }
  const openDetail = async (row) => {
    setDetail({ loading: true, error: '', data: null, row });
    try {
      const data = await api.getIrCapitalAccountDetail(row.investorId, row.fundId);
      setDetail(d => (d && d.row === row ? { ...d, loading: false, data } : d));
    } catch (e) {
      setDetail(d => (d && d.row === row ? { ...d, loading: false, error: e?.message || 'Failed to load the statement' } : d));
    }
  };

  const fmtCell = (key, v) => {
    if (key === 'dpi' || key === 'tvpi') return formatMultiple(v);
    if (key === 'irrPct') return v === null || v === undefined ? '-' : formatPercent(v);
    return formatCurrency(v);
  };

  const det = detail?.data ? { ...detail.row, ...detail.data } : null;
  let runningNet = 0;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
        <div>
          <h3 style={{ fontSize: 16, fontWeight: 700, letterSpacing: '-0.01em', color: 'var(--ink)', margin: 0 }}>Capital Accounts</h3>
          <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '3px 0 0' }}>Every investor position - click a row for the full dated statement</p>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <select className="form-select" style={{ width: 200 }} value={fundFilter} onChange={e => setFundFilter(e.target.value)}>
            <option value="">All Deals</option>
            {funds.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
          <select className="form-select" style={{ width: 200 }} value={investorFilter} onChange={e => setInvestorFilter(e.target.value)}>
            <option value="">All Investors</option>
            {investors.map(i => <option key={i.id} value={i.id}>{i.displayName}</option>)}
          </select>
        </div>
      </div>

      {loading ? <LoadingState /> : error ? <ErrorState message={error} onRetry={reload} /> : rows.length === 0 ? (
        <EmptyState icon={FileSpreadsheet} title="No Positions Found"
          sub={fundFilter || investorFilter ? 'Nothing matches the current filters.' : 'Capital accounts appear once investors have commitments in a deal.'} />
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="req-table" style={{ minWidth: 880 }}>
            <thead>
              <tr>
                {COLS.map(c => (
                  <th key={c.key} onClick={() => toggleSort(c.key)}
                    style={{ textAlign: c.align, cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      {c.label}
                      {sort.key === c.key
                        ? (sort.dir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />)
                        : <ArrowUpDown size={11} style={{ opacity: 0.35 }} />}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={`${r.investorId}-${r.fundId}`} onClick={() => openDetail(r)} style={{ cursor: 'pointer' }}>
                  <td style={{ fontWeight: 600 }}>{r.investorName}</td>
                  <td style={{ color: 'var(--muted)' }}>{r.fundName}</td>
                  {['committed', 'called', 'unfunded', 'distributed', 'dpi', 'tvpi', 'irrPct'].map(k => (
                    <td key={k} style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtCell(k, r[k])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: '2px solid var(--ink)' }}>
                <td style={{ fontWeight: 700, paddingTop: 10 }}>Total</td>
                <td style={{ color: 'var(--muted)', fontSize: 11.5, paddingTop: 10 }}>{rows.length} position{rows.length === 1 ? '' : 's'}</td>
                {['committed', 'called', 'unfunded', 'distributed'].map(k => (
                  <td key={k} style={{ textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums', paddingTop: 10 }}>{formatCurrency(totals[k])}</td>
                ))}
                <td style={{ textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums', paddingTop: 10 }}>{formatMultiple(totals.dpi)}</td>
                <td style={{ textAlign: 'right', color: 'var(--muted)', paddingTop: 10 }}>-</td>
                <td style={{ textAlign: 'right', color: 'var(--muted)', paddingTop: 10 }}>-</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {detail && (
        <Modal title="Capital Account Statement" onClose={() => setDetail(null)} width={780}>
          {detail.loading ? <div style={{ padding: '8px 24px 24px' }}><LoadingState label="Building statement…" /></div>
            : detail.error ? <div style={{ padding: '8px 24px 24px' }}><ErrorState message={detail.error} onRetry={() => openDetail(detail.row)} /></div>
            : det && (
            <div style={{ padding: '20px 24px 24px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--muted)' }}>Investor Statement</div>
                  <div style={{ fontSize: 19, fontWeight: 700, letterSpacing: '-0.02em', color: 'var(--ink)', marginTop: 4 }}>{det.investorName}</div>
                  <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2 }}>{det.fundName} · As of {formatDate(det.asOf)}</div>
                </div>
                <button className="secondary-btn" onClick={() => printStatement(det)}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
                  <Printer size={14} /> Print Statement
                </button>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '14px 20px', borderTop: '1px solid var(--line)', borderBottom: '1px solid var(--line)', padding: '14px 0', margin: '16px 0 20px' }}>
                {[
                  ['Committed', formatCurrency(det.committed)],
                  ['Called', formatCurrency(det.called)],
                  ['Unfunded', formatCurrency(det.unfunded)],
                  ['Distributed', formatCurrency(det.distributed)],
                  ['DPI', formatMultiple(det.dpi)],
                  ['TVPI', formatMultiple(det.tvpi)],
                  ['Net IRR', det.irrPct === null || det.irrPct === undefined ? '-' : formatPercent(det.irrPct)],
                ].map(([label, value]) => (
                  <div key={label}>
                    <div style={{ fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--muted)' }}>{label}</div>
                    <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--ink)', marginTop: 3, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
                  </div>
                ))}
              </div>

              <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--ink)', marginBottom: 8 }}>Cash-Flow Ledger</div>
              {(det.cashFlows || []).length === 0 ? (
                <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '10px 0' }}>No cash flows recorded yet for this position.</div>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table className="req-table">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Activity</th>
                        <th>Type</th>
                        <th style={{ textAlign: 'right' }}>Amount</th>
                        <th style={{ textAlign: 'right' }}>Net Cash Flow</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(det.cashFlows || []).map((cf, i) => {
                        runningNet += Number(cf.amount) || 0;
                        const isCall = cf.type === 'call';
                        return (
                          <tr key={i}>
                            <td style={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{formatDate(cf.date)}</td>
                            <td style={{ fontWeight: 500 }}>{cf.label}</td>
                            <td>
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: isCall ? 'hsl(var(--color-blue))' : 'hsl(var(--color-green))', fontWeight: 600 }}>
                                <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'currentColor' }} />
                                {isCall ? 'Capital Call' : 'Distribution'}
                              </span>
                            </td>
                            <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: isCall ? 'var(--ink)' : 'hsl(var(--color-green))' }}>
                              {signedAmount(cf.amount)}
                            </td>
                            <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--muted)' }}>{formatCurrency(runningNet)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 14 }}>
                Amounts shown from the investor's perspective - capital calls negative, distributions positive.
              </div>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}

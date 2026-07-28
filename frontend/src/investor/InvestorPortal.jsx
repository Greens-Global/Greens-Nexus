import { useState } from 'react';
import { ArrowLeft, Briefcase, ExternalLink, File, FileImage, FileSpreadsheet, FileText, Pin } from 'lucide-react';
import { api } from '../api';
import { formatCurrency, formatDate, formatMultiple, formatPercent } from './lib/format';
import { EmptyState, ErrorState, LoadingState, StatusText, ThinBar, useIrLoad } from './lib/ui';

// The external investor portal - what a granted, non-staff investor sees when
// they open Investor Relations (see the role branch in views/InvestorRelations.jsx).
// Read-only by design: no tab strip, no create/edit/delete anywhere, and only
// the caller's own deals - the /portal endpoints scope every row server-side
// (ungranted deals 404), this file adds nothing on top. Deliberately no Asset
// Management links here either: investors have no access to that module.

// Category → label + accent color. Mirrors CATEGORY_META in DocumentsTab.jsx
// (not exported there) - keep the two in sync.
const CATEGORY_META = {
  subscription_agreement: { label: 'Subscription Agreement', color: 'hsl(var(--color-blue))' },
  k1:                     { label: 'K-1',                    color: 'hsl(var(--color-orange))' },
  ppm:                    { label: 'PPM',                    color: 'hsl(var(--color-blue))' },
  quarterly_report:       { label: 'Quarterly Report',       color: 'hsl(var(--color-green))' },
  capital_call_notice:    { label: 'Capital Call Notice',    color: 'hsl(var(--color-orange))' },
  distribution_notice:    { label: 'Distribution Notice',    color: 'hsl(var(--color-green))' },
  other:                  { label: 'Other',                  color: 'var(--muted)' },
};

function fileIcon(name) {
  const ext = String(name || '').split('.').pop().toLowerCase();
  if (['pdf', 'doc', 'docx'].includes(ext)) return FileText;
  if (['xls', 'xlsx', 'csv'].includes(ext)) return FileSpreadsheet;
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return FileImage;
  return File;
}

// +/− amounts, investor's perspective - same sign convention as the GP-side
// capital-account statement (CapitalAccountsTab.jsx): calls −, distributions +.
function signedAmount(v) {
  const n = Number(v) || 0;
  return `${n < 0 ? '−' : '+'}${formatCurrency(Math.abs(n))}`;
}

const isNum = v => v !== null && v !== undefined;

const stat = (label, value) => (
  <div key={label}>
    <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--muted)' }}>{label}</div>
    <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ink)', marginTop: 2, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
  </div>
);

function SectionTitle({ children }) {
  return (
    <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--ink)' }}>{children}</div>
  );
}

// Landing card - the visual language of the GP Deal cards (status dot, thin
// bar, stat grid), minus everything GP-only (investor count, manager, edit).
function DealCard({ deal: d, onOpen }) {
  return (
    <div onClick={onOpen} role="button" tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter') onOpen(); }}
      style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, padding: '18px 20px', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 13 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--ink)', letterSpacing: '-0.01em' }}>{d.fundName}</div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
            {[d.strategy, d.propertyName].filter(Boolean).join(' · ') || d.entityName || '-'}
          </div>
        </div>
        <StatusText status={d.status} />
      </div>

      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, color: 'var(--muted)', marginBottom: 5, fontVariantNumeric: 'tabular-nums' }}>
          <span>Called <strong style={{ color: 'var(--ink)' }}>{formatCurrency(d.called)}</strong></span>
          <span>Committed {formatCurrency(d.committed)}</span>
        </div>
        <ThinBar value={d.called} max={d.committed} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px 12px' }}>
        {stat('Distributed', formatCurrency(d.distributed))}
        {stat('Unfunded', formatCurrency(d.unfunded))}
        {stat('DPI', formatMultiple(d.dpi))}
        {/* TVPI / IRR stay hidden until the deal has actually exited - no
            fabricated interim valuations, DPI is the "cash back so far" number. */}
        {isNum(d.tvpi) && stat('TVPI', formatMultiple(d.tvpi))}
        {isNum(d.irrPct) && stat('Net IRR', formatPercent(d.irrPct))}
      </div>
    </div>
  );
}

// Full deal statement: terms, capital account, dated cash-flow ledger,
// documents, and updates - mirrors the GP-side statement modal's layout.
function PortalDealDetail({ fundId, onBack }) {
  const { data: deal, loading, error, reload } = useIrLoad(() => api.getIrPortalDeal(fundId), [fundId]);

  if (loading) return <LoadingState label="Loading your deal…" />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!deal) return null;

  // Precompute the running net so the JSX below stays a pure mapping.
  const flows = [];
  for (const cf of deal.cashFlows || []) {
    const prev = flows.length ? flows[flows.length - 1].net : 0;
    flows.push({ ...cf, net: prev + (Number(cf.amount) || 0) });
  }
  // Pinned first, then newest - same ordering the GP Updates tab uses.
  const updates = [...(deal.updates || [])].sort((a, b) => {
    if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
    return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  });
  const dates = [
    ['Inception', deal.inceptionDate],
    ['Close Date', deal.closeDate],
    ['Exit Date', deal.exitDate],
  ].filter(([, v]) => v);

  return (
    <div style={{ maxWidth: 860 }}>
      {onBack && (
        <button type="button" onClick={onBack}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', padding: 0, marginBottom: 14, cursor: 'pointer', color: 'var(--muted)', fontSize: 12.5, fontWeight: 600, fontFamily: 'Inter, sans-serif' }}>
          <ArrowLeft size={14} /> Back to My Deals
        </button>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--muted)' }}>Greens Global - Investor Statement</div>
          <div style={{ fontSize: 19, fontWeight: 700, letterSpacing: '-0.02em', color: 'var(--ink)', marginTop: 4 }}>{deal.fundName}</div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2 }}>
            {[deal.entityName, deal.strategy, deal.propertyName].filter(Boolean).join(' · ') || 'Deal overview'} · As of {formatDate(deal.asOf)}
          </div>
        </div>
        <StatusText status={deal.status} />
      </div>

      {dates.length > 0 && (
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginTop: 12 }}>
          {dates.map(([label, value]) => stat(label, formatDate(value)))}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '14px 20px', borderTop: '1px solid var(--line)', borderBottom: '1px solid var(--line)', padding: '14px 0', margin: '16px 0 20px' }}>
        {[
          ['Committed', formatCurrency(deal.committed)],
          ['Called', formatCurrency(deal.called)],
          ['Unfunded', formatCurrency(deal.unfunded)],
          ['Distributed', formatCurrency(deal.distributed)],
          ['DPI', formatMultiple(deal.dpi)],
          ...(isNum(deal.tvpi) ? [['TVPI', formatMultiple(deal.tvpi)]] : []),
          ...(isNum(deal.irrPct) ? [['Net IRR', formatPercent(deal.irrPct)]] : []),
        ].map(([label, value]) => (
          <div key={label}>
            <div style={{ fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--muted)' }}>{label}</div>
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--ink)', marginTop: 3, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
          </div>
        ))}
      </div>

      {(deal.description || deal.thesis) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 22 }}>
          {deal.description && (
            <div>
              <SectionTitle>About This Deal</SectionTitle>
              <p style={{ fontSize: 13, color: 'var(--ink)', lineHeight: 1.6, margin: '6px 0 0', whiteSpace: 'pre-line' }}>{deal.description}</p>
            </div>
          )}
          {deal.thesis && (
            <div>
              <SectionTitle>Investment Thesis</SectionTitle>
              <p style={{ fontSize: 13, color: 'var(--ink)', lineHeight: 1.6, margin: '6px 0 0', whiteSpace: 'pre-line' }}>{deal.thesis}</p>
            </div>
          )}
        </div>
      )}

      <div style={{ marginBottom: 24 }}>
        <SectionTitle>Cash-Flow Ledger</SectionTitle>
        {flows.length === 0 ? (
          <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '10px 0' }}>No cash flows recorded yet for this position.</div>
        ) : (
          <>
            <div style={{ overflowX: 'auto', marginTop: 8 }}>
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
                  {flows.map((cf, i) => {
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
                        <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--muted)' }}>{formatCurrency(cf.net)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 10 }}>
              Amounts shown from your perspective - capital calls negative, distributions positive.
            </div>
          </>
        )}
      </div>

      <div style={{ marginBottom: 24 }}>
        <SectionTitle>Documents</SectionTitle>
        {(deal.documents || []).length === 0 ? (
          <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '10px 0' }}>No documents have been shared for this deal yet.</div>
        ) : (
          <div style={{ overflowX: 'auto', marginTop: 8 }}>
            <table className="req-table">
              <thead>
                <tr>
                  <th>Document</th>
                  <th>Category</th>
                  <th>Date</th>
                  <th style={{ textAlign: 'right' }}>File</th>
                </tr>
              </thead>
              <tbody>
                {deal.documents.map(doc => {
                  const meta = CATEGORY_META[doc.category] || CATEGORY_META.other;
                  const Icon = fileIcon(doc.fileName || doc.fileUrl);
                  return (
                    <tr key={doc.id}>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                          <Icon size={16} style={{ color: 'var(--muted)', flexShrink: 0 }} />
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontWeight: 600 }}>{doc.title}</div>
                            {doc.fileName && <div style={{ fontSize: 11, color: 'var(--muted)', wordBreak: 'break-all' }}>{doc.fileName}</div>}
                          </div>
                        </div>
                      </td>
                      <td><span style={{ color: meta.color, fontSize: 12.5, fontWeight: 600 }}>{meta.label}</span></td>
                      <td style={{ fontSize: 12.5, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{formatDate(doc.createdAt)}</td>
                      <td style={{ textAlign: 'right' }}>
                        {doc.fileUrl ? (
                          <a href={doc.fileUrl} target="_blank" rel="noreferrer"
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'hsl(var(--color-blue))', fontSize: 12.5, fontWeight: 600, textDecoration: 'none' }}>
                            <ExternalLink size={13} /> Open
                          </a>
                        ) : (
                          <span style={{ fontSize: 12, color: 'var(--muted)', fontStyle: 'italic' }}>No file attached</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div>
        <SectionTitle>Updates</SectionTitle>
        {updates.length === 0 ? (
          <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '10px 0' }}>No updates have been posted for this deal yet.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 8 }}>
            {updates.map(u => (
              <div key={u.id} style={{
                background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, padding: '16px 18px',
                borderLeft: u.pinned ? '3px solid hsl(var(--color-blue))' : '1px solid var(--line)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  {u.pinned && <Pin size={13} style={{ color: 'hsl(var(--color-blue))', flexShrink: 0 }} />}
                  <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)' }}>{u.title}</div>
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 3 }}>
                  {u.fundName || 'General Update'} · {formatDate(u.createdAt)}
                </div>
                {u.body && <p style={{ fontSize: 13, color: 'var(--ink)', lineHeight: 1.6, margin: '10px 0 0', whiteSpace: 'pre-line' }}>{u.body}</p>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function InvestorPortal() {
  const { data: deals, loading, error, reload } = useIrLoad(() => api.getIrPortalMyDeals(), []);
  const [selectedId, setSelectedId] = useState(null);

  if (loading) return <LoadingState label="Loading your deals…" />;
  if (error) return <ErrorState message={error} onRetry={reload} />;

  const list = deals || [];
  // A single-deal investor lands straight on their statement - no pointless
  // one-item list, and no "Back to My Deals" affordance they'd wonder about.
  const activeId = selectedId ?? (list.length === 1 ? list[0].fundId : null);

  if (activeId) {
    return <PortalDealDetail fundId={activeId} onBack={list.length > 1 ? () => setSelectedId(null) : null} />;
  }

  if (list.length === 0) {
    // Calm empty state, not an error: covers revoked access and data hiccups.
    return (
      <EmptyState icon={Briefcase} title="No Deals Available"
        sub="You don't have access to any deals yet. If you're expecting to see an investment here, contact your Greens Global representative." />
    );
  }

  return (
    <div>
      <div style={{ marginBottom: 18 }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, letterSpacing: '-0.01em', color: 'var(--ink)', margin: 0 }}>My Deals</h3>
        <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '3px 0 0' }}>Your investments with Greens Global - select a deal for the full statement</p>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(330px, 1fr))', gap: 16 }}>
        {list.map(d => <DealCard key={d.fundId} deal={d} onOpen={() => setSelectedId(d.fundId)} />)}
      </div>
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, X, ChevronLeft, ChevronRight, ArrowLeft } from 'lucide-react';
import { api } from '../../api';
import { SkeletonBlocks } from '../AsyncState';
import { formatDate } from '../../lib/datetime';

// Search results and report drill-downs for Accounting -> Reports.
//
// Neil (Sep 17): "if I type in a vendor I should see every single payment made
// to them ... without having to call the accounting team." Charmi: anything
// that CONTAINS what was typed shows up, then you filter down. Neil: pick the
// entity first, keep funnelling, but never 18 clicks.
//
// So: the entity and the words come from the Reports toolbar above; this panel
// shows every matching posted line, the totals over the WHOLE result (not just
// the page), and one-click chips built from the matches themselves - the
// vendors, customers, accounts and journals they involve. A drill-down from a
// report is the same thing started from an account instead of a word.

const PAGE = 100;
const EXPORT_CAP = 10000;

const money = (n) => {
  const v = Number(n) || 0;
  if (Math.abs(v) < 0.005) return '';
  return Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const signed = (n) => {
  const v = Number(n) || 0;
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < 0 ? `(${s})` : s;
};
const partyOf = (r) => r.vendor_name || r.customer_name || r.employee_name || r.vendor_id || r.customer_id || r.employee_id || '';
const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const chip = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px', borderRadius: 999, fontSize: '0.75rem', cursor: 'pointer', border: '1px solid var(--border-color)', background: 'var(--bg-card)', color: 'var(--text-primary)', maxWidth: 260, fontFamily: 'inherit' };
const activeChip = { ...chip, cursor: 'default', border: '1px solid var(--wk-brand, #2b45e1)', background: 'var(--wk-brand-tint, #e8ecfd)', color: 'var(--wk-brand, #2b45e1)', fontWeight: 600 };

function ActiveChip({ label, onClear }) {
  return (
    <span style={activeChip}>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      <button type="button" onClick={onClear} aria-label={`Remove ${label}`} style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', color: 'inherit', display: 'inline-flex' }}><X size={12} /></button>
    </span>
  );
}

// A chip only earns its place when clicking it narrows the result: one vendor
// behind EVERY matching line is not a choice, one vendor behind some of them is
// (Neil: "as a vendor, not as an employee").
function FacetRow({ label, items, total, onPick, text }) {
  if (!items?.length || (items.length === 1 && items[0].lines >= total)) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
      <span style={{ width: 76, flexShrink: 0, fontSize: '0.72rem', color: 'var(--text-muted)' }}>{label}</span>
      {items.map((f) => {
        const name = text ? text(f) : (f.name || f.code);
        return (
          <button key={f.code} type="button" style={chip} onClick={() => onPick(f)} title={`${name} - ${f.lines.toLocaleString('en-US')} lines, net ${signed(f.net)}`}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
            <span style={{ color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>{f.lines.toLocaleString('en-US')}</span>
          </button>
        );
      })}
    </div>
  );
}

export default function LedgerSearch({ term, entity, entityName, drill, onClearDrill, onClose }) {
  // Narrowing picked from the chips. A drill-down arrives with its account set.
  const [party, setParty] = useState(null);       // { kind, code, name }
  const [account, setAccount] = useState(null);   // { code, name }
  const [journal, setJournal] = useState('');
  const [book, setBook] = useState('all');
  const [scope, setScope] = useState('all');      // all | period (a drill-down always uses its period)
  const [page, setPage] = useState(0);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);
  const seq = useRef(0);

  // A new drill-down replaces whatever was picked before it.
  useEffect(() => {
    if (!drill) return;
    setAccount({ code: drill.account, name: drill.accountName });
    setParty(null); setJournal(''); setBook('accrual'); setScope('period');
  }, [drill]);

  const usePeriod = scope === 'period' && drill;
  const params = useMemo(() => ({
    q: term || undefined,
    location: entity || undefined,
    from: usePeriod ? drill.from : undefined,
    to: usePeriod ? drill.to : undefined,
    party_kind: party?.kind,
    party: party?.code,
    account: account?.code,
    journal: journal || undefined,
    book: book === 'all' ? undefined : book,
  }), [term, entity, usePeriod, drill, party, account, journal, book]);

  const hasCriteria = (term || '').trim().length >= 2 || !!party || !!account || !!journal;

  useEffect(() => { setPage(0); }, [params]);

  useEffect(() => {
    if (!hasCriteria) { setData(null); setError(''); return; }
    const mine = ++seq.current;
    setLoading(true);
    setError('');
    api.searchAccountingLedger({ ...params, offset: page * PAGE, limit: PAGE })
      .then((d) => { if (mine === seq.current) setData(d); })
      .catch((e) => { if (mine === seq.current) { setData(null); setError(e?.message || 'Could not search the ledger.'); } })
      .finally(() => { if (mine === seq.current) setLoading(false); });
  }, [params, page, hasCriteria]);

  const total = data?.total || 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const rows = data?.rows || [];
  const facets = data?.facets || {};

  const exportCsv = async () => {
    if (!total || exporting) return;
    setExporting(true);
    try {
      // The screen shows one page; the file is the whole result (walked 1,000 at a time).
      const all = [];
      for (let offset = 0; offset < Math.min(total, EXPORT_CAP); offset += 1000) {
        const d = await api.searchAccountingLedger({ ...params, offset, limit: 1000 });
        all.push(...(d?.rows || []));
      }
      const out = [['Date', 'Entry', 'Doc No', 'Description', 'Account', 'Title', 'Entity', 'Vendor / Customer', 'Journal', 'Debit', 'Credit']];
      all.forEach((r) => out.push([formatDate(r.entry_date), r.entry_no, r.doc, r.description, r.gl_code, r.account_name, r.location_name || r.location, partyOf(r), r.journal, r.debit || '', r.credit || '']));
      const text = out.map((r) => r.map(csvCell).join(',')).join('\r\n');
      const blob = new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Ledger-Search_${(term || account?.code || party?.name || 'results').replace(/[^A-Za-z0-9]+/g, '-').slice(0, 40)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(e?.message || 'Could not export the results.');
    } finally {
      setExporting(false);
    }
  };

  const card = { backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 20, boxShadow: 'var(--shadow-sm)' };
  const select = { padding: '5px 8px', borderRadius: 8, border: '1px solid var(--border-color)', fontSize: '0.78rem', fontFamily: 'inherit', background: 'var(--bg-card)', color: 'var(--text-primary)' };

  const heading = [term ? `"${term}"` : null, party?.name, account ? `${account.code} ${account.name || ''}`.trim() : null].filter(Boolean).join(' - ') || 'Ledger lines';
  const periodText = usePeriod ? `${drill.from ? formatDate(drill.from) : 'Start'} - ${formatDate(drill.to)}` : 'All dates';

  return (
    <div style={card}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <button type="button" className="secondary-btn" onClick={onClose} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', padding: '4px 10px' }}>
          <ArrowLeft size={14} /> Back to Report
        </button>
        <div style={{ minWidth: 0 }}>
          <h3 style={{ fontSize: '1rem', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{heading}</h3>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
            {entityName} · {periodText} · {book === 'all' ? 'all books' : book}{loading && data ? ' · refreshing' : ''}
          </div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          {drill && (
            <select value={scope} onChange={(e) => setScope(e.target.value)} style={select} aria-label="Dates">
              <option value="period">Report Period</option>
              <option value="all">All Dates</option>
            </select>
          )}
          <select value={book} onChange={(e) => setBook(e.target.value)} style={select} aria-label="Book">
            <option value="all">All Books</option>
            <option value="accrual">Accrual Book</option>
            <option value="cash">Cash Book</option>
          </select>
          <button type="button" className="primary-btn" onClick={exportCsv} disabled={!total || exporting} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.8rem' }}>
            <Download size={14} /> {exporting ? 'Exporting...' : 'Export CSV'}
          </button>
        </div>
      </div>

      {(party || account || journal) && (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginBottom: 10 }}>
          <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Narrowed to</span>
          {party && <ActiveChip label={`${party.kind === 'vendor' ? 'Vendor' : 'Customer'}: ${party.name}`} onClear={() => setParty(null)} />}
          {account && <ActiveChip label={`Account: ${account.code} ${account.name || ''}`.trim()} onClear={() => { setAccount(null); if (drill) onClearDrill(); }} />}
          {journal && <ActiveChip label={`Journal: ${journal}`} onClear={() => setJournal('')} />}
        </div>
      )}

      {error && <div style={{ border: '1px solid var(--bad-fg, #dc2626)', color: 'var(--bad-fg, #dc2626)', borderRadius: 8, padding: '10px 12px', fontSize: '0.85rem', marginBottom: 10 }}>{error}</div>}

      {!hasCriteria ? (
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', padding: '24px 0', textAlign: 'center', margin: 0 }}>
          Type at least two characters - a vendor or customer name, an invoice number, or an amount like 1,500.00.
        </p>
      ) : loading && !data ? (
        <SkeletonBlocks count={4} />
      ) : data && total === 0 ? (
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', padding: '24px 0', textAlign: 'center', margin: 0 }}>
          Nothing in the ledger contains all of that{entity ? ' for this entity' : ''}. Remove a word or a filter to widen the search.
        </p>
      ) : data ? (
        <>
          <div style={{ display: 'grid', gap: 6, marginBottom: 12 }}>
            {!party && <FacetRow label="Vendors" total={total} items={facets.vendors} onPick={(f) => setParty({ kind: 'vendor', code: f.code, name: f.name || f.code })} />}
            {!party && <FacetRow label="Customers" total={total} items={facets.customers} onPick={(f) => setParty({ kind: 'customer', code: f.code, name: f.name || f.code })} />}
            {!account && <FacetRow label="Accounts" total={total} items={facets.accounts} text={(f) => `${f.code} ${f.name || ''}`} onPick={(f) => setAccount({ code: f.code, name: f.name })} />}
            {!journal && <FacetRow label="Journals" total={total} items={facets.journals} onPick={(f) => setJournal(f.code)} />}
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, fontSize: '0.8rem', marginBottom: 10, fontVariantNumeric: 'tabular-nums' }}>
            <span><strong>{total.toLocaleString('en-US')}</strong> lines</span>
            <span>Debits <strong>{signed(data.debit)}</strong></span>
            <span>Credits <strong>{signed(data.credit)}</strong></span>
            <span>Net <strong style={{ color: data.debit - data.credit < 0 ? 'var(--bad-fg, #dc2626)' : undefined }}>{signed(data.debit - data.credit)}</strong></span>
            {total > PAGE && (
              <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--text-secondary)' }}>
                Lines {(page * PAGE + 1).toLocaleString('en-US')}-{Math.min(total, (page + 1) * PAGE).toLocaleString('en-US')}
                <button type="button" className="secondary-btn" disabled={page === 0 || loading} onClick={() => setPage((p) => p - 1)} aria-label="Previous page" style={{ padding: '2px 6px' }}><ChevronLeft size={14} /></button>
                {page + 1} / {pages}
                <button type="button" className="secondary-btn" disabled={page + 1 >= pages || loading} onClick={() => setPage((p) => p + 1)} aria-label="Next page" style={{ padding: '2px 6px' }}><ChevronRight size={14} /></button>
              </span>
            )}
          </div>

          <div className="req-table-wrapper" style={{ opacity: loading ? 0.6 : 1 }}>
            <table className="req-table" style={{ fontVariantNumeric: 'tabular-nums', fontSize: '0.8rem' }}>
              <thead>
                <tr>
                  <th>Date</th><th>Entry</th><th>Doc No</th><th>Description</th><th>Account</th><th>Entity</th><th>Vendor / Customer</th><th>Journal</th>
                  <th style={{ textAlign: 'right' }}>Debit</th><th style={{ textAlign: 'right' }}>Credit</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.line_id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{formatDate(r.entry_date)}</td>
                    <td style={{ whiteSpace: 'nowrap', fontFamily: 'monospace', fontSize: '0.74rem' }}>{r.entry_no}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{r.doc}</td>
                    <td style={{ maxWidth: 340, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.description}>{r.description}</td>
                    <td style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={`${r.gl_code} ${r.account_name}`}>
                      <span style={{ fontFamily: 'monospace', fontSize: '0.74rem', marginRight: 6, color: 'var(--text-secondary)' }}>{r.gl_code}</span>{r.account_name}
                    </td>
                    <td style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.location_name || r.location}>{r.location_name || r.location}</td>
                    <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={partyOf(r)}>{partyOf(r)}</td>
                    <td style={{ whiteSpace: 'nowrap', fontFamily: 'monospace', fontSize: '0.74rem' }}>{r.journal}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{money(r.debit)}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{money(r.credit)}</td>
                  </tr>
                ))}
                {page + 1 >= pages && (
                  <tr style={{ fontWeight: 800, borderTop: '2px solid var(--border-color)' }}>
                    <td colSpan={8}>Totals - {total.toLocaleString('en-US')} lines</td>
                    <td style={{ textAlign: 'right' }}>{signed(data.debit)}</td>
                    <td style={{ textAlign: 'right' }}>{signed(data.credit)}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {total > EXPORT_CAP && (
            <div style={{ marginTop: 8, fontSize: '0.72rem', color: 'var(--text-muted)' }}>
              The export holds the first {EXPORT_CAP.toLocaleString('en-US')} lines. Narrow the search for a complete file.
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}

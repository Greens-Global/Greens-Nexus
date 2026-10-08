// Accounting tiles (Oct 1, Neil: "a widget that searches for a transaction
// and takes me straight to the ledger"). Find a Transaction is one search box
// over the ledger search endpoint (`/accounting/search`, the same one the
// Reports tab uses, so entity scoping and the every-word-must-match rule come
// for free), the top six matching lines, and a footer that opens Reports with
// the same words. Tapping a line opens Reports with the words AND that journal
// entry on top - one tap from the dashboard to the exact transaction.
//
// Loaded lazily from widgets.jsx (same as workdayWidgets.jsx) so the main
// dashboard bundle does not grow; the gallery offers the tile only to people
// who hold the Accounting grant (`module: 'accounting'` in the registry).
import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Loader2, Search } from 'lucide-react';
import { api } from '../api';
import { formatDate } from '../lib/datetime';
import { requestLedgerSearch } from '../components/accounting/drill';
import { DashCard } from './widgets.jsx';
import { noteStyle } from './workdayWidgets.jsx';

export const RESULT_LIMIT = 6;

// Figures in the Accounting module carry no symbol and two decimals; a credit
// (money out, or income) reads in parentheses like the ledger grid.
const money = (n) => (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const signed = (n) => (n < 0 ? `(${money(-n)})` : money(n));
const amountOf = (r) => (Number(r.debit) > 0 ? money(r.debit) : Number(r.credit) > 0 ? `(${money(r.credit)})` : money(0));

// One ledger line as the tile shows it: what it was, when and where, how much,
// and who the other side was.
export function transactionRows(rows) {
  return (rows || []).map((r) => ({
    key: r.line_id || `${r.entry_id}:${r.gl_code}:${r.debit}:${r.credit}`,
    entryId: r.entry_id || null,
    entryNo: r.entry_no || '',
    title: r.description || r.memo || r.entry_no || 'Ledger line',
    meta: [r.entry_date ? formatDate(r.entry_date) : '', r.entry_no, r.location_name].filter(Boolean).join(' · '),
    party: r.vendor_name || r.customer_name || r.employee_name || '',
    amount: amountOf(r),
  }));
}

function LineRow({ row, onClick }) {
  return (
    <button type="button" onClick={onClick} title={row.party ? `${row.title} - ${row.party}` : row.title}
      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 8px', border: 'none', background: 'none', borderRadius: 8, cursor: 'pointer', textAlign: 'left', fontFamily: 'var(--wk-font)', width: '100%', color: 'var(--ink)', boxSizing: 'border-box' }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--mist)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.title}</span>
        <span style={{ display: 'block', fontSize: 11.5, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {row.meta}{row.party ? ` · ${row.party}` : ''}
        </span>
      </span>
      <span style={{ fontSize: 13, fontWeight: 600, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', flexShrink: 0 }}>{row.amount}</span>
    </button>
  );
}

export function FindTransactionWidget() {
  const [q, setQ] = useState('');
  const [data, setData] = useState(null);     // { rows, total, debit, credit } for `shownFor`
  const [shownFor, setShownFor] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const seq = useRef(0);
  const term = q.trim();
  const ready = term.length >= 2;

  useEffect(() => {
    if (!ready) { setData(null); setShownFor(''); setError(''); setBusy(false); return undefined; }
    // Two or three characters match a large part of the ledger ("in" is on
    // 619,000 lines), so a short word waits longer for the rest of it - the
    // same rule as the Reports search box (Sep 29).
    const mine = ++seq.current;
    const t = setTimeout(() => {
      setBusy(true);
      setError('');
      api.searchAccountingLedger({ q: term, limit: RESULT_LIMIT })
        .then((d) => { if (mine === seq.current) { setData(d || { rows: [], total: 0 }); setShownFor(term); } })
        .catch((e) => { if (mine === seq.current) { setData(null); setShownFor(term); setError(e?.message || 'The ledger could not be searched right now.'); } })
        .finally(() => { if (mine === seq.current) setBusy(false); });
    }, term.length < 4 ? 700 : 350);
    return () => clearTimeout(t);
  }, [term, ready]);

  const openLedger = (row) => {
    if (!ready) return;
    requestLedgerSearch(row ? { q: term, entryId: row.entryId, entryNo: row.entryNo } : { q: term });
  };
  const rows = data ? transactionRows(data.rows) : [];
  const total = Number(data?.total) || 0;
  const net = (Number(data?.debit) || 0) - (Number(data?.credit) || 0);
  // Lines on screen that belong to an older search are stale: say so.
  const waiting = ready && (busy || shownFor !== term);

  return (
    <DashCard title="Find a Transaction">
      <form role="search" onSubmit={(e) => { e.preventDefault(); openLedger(null); }} style={{ position: 'relative', marginBottom: 6 }}>
        {waiting
          ? <Loader2 size={14} className="spin" aria-label="Searching" style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--wk-brand, #2b45e1)' }} />
          : <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />}
        <input className="form-input" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a transaction"
          placeholder="Vendor, invoice #, amount, memo..." style={{ paddingLeft: 32, width: '100%' }} />
      </form>

      {!ready && <div style={noteStyle}>Type at least two characters. Enter opens the ledger with your search.</div>}
      {ready && waiting && rows.length === 0 && !error && <div style={noteStyle}>Searching…</div>}
      {ready && !waiting && error && <div style={{ ...noteStyle, color: 'var(--bad-fg, #dc2626)' }}>{error}</div>}
      {ready && !waiting && !error && rows.length === 0 && (
        <div style={noteStyle}>No ledger lines match. Try fewer words or the entry number.</div>
      )}
      {rows.length > 0 && (
        <div style={{ opacity: waiting ? 0.55 : 1, transition: 'opacity 120ms' }}>
          {rows.map((r) => <LineRow key={r.key} row={r} onClick={() => openLedger(r)} />)}
        </div>
      )}

      {ready && data && !error && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 6, paddingTop: 8, borderTop: '1px solid var(--line)', fontSize: 12, color: 'var(--muted)' }}>
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>{total.toLocaleString('en-US')} {total === 1 ? 'line' : 'lines'} · {signed(net)} net</span>
          <button type="button" onClick={() => openLedger(null)} className="dash-card-link"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, border: 'none', background: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, fontWeight: 600, color: 'var(--wk-brand, #2b45e1)', padding: 0, whiteSpace: 'nowrap' }}>
            Open in Ledger <ArrowRight size={13} />
          </button>
        </div>
      )}
    </DashCard>
  );
}

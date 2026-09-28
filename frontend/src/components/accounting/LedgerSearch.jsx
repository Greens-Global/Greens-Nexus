import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight, Columns3, Download, X } from 'lucide-react';
import { api } from '../../api';
import { SkeletonBlocks } from '../AsyncState';
import { formatDate } from '../../lib/datetime';
import EntryDetail from './EntryDetail';
import { useAccountingPrefs } from './prefs';
import { usePopover } from './reportControls';
import { downloadCsv } from './reportModel';

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
//
// Sep 25 (Neil, Charmi) - the grid works like an Intacct list:
//   - a filter box under every column, and they stack ("%amazon", then a date,
//     then an amount that ends in .55); the server applies them to the whole
//     result, so the totals and the page count follow;
//   - every column can be dragged wider or narrower, shown or hidden, and the
//     layout is the person's own (Doc No is off until someone turns it on);
//   - one typeface, banded rows, and the hover fills the whole row so the eye
//     can follow a line across a wide monitor to its amount.

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
const named = (name, id) => name || id || '';
const partyOf = (r) => r.vendor_name || r.customer_name || r.employee_name || r.vendor_id || r.customer_id || r.employee_id || '';

// Every column the grid can show. `filter`: the server can narrow by it.
// `off`: hidden until the person turns it on.
export const LINE_COLUMNS = [
  { key: 'date', label: 'Date', width: 96, filter: true, text: (r) => formatDate(r.entry_date) },
  { key: 'entry', label: 'Entry', width: 108, filter: true, text: (r) => r.entry_no || '' },
  { key: 'doc', label: 'Doc No', width: 120, filter: true, off: true, text: (r) => r.doc || '' },
  { key: 'description', label: 'Description', width: 380, filter: true, text: (r) => r.description || '' },
  { key: 'memo', label: 'Memo', width: 240, off: true, text: (r) => r.memo || '' },
  { key: 'account', label: 'Account', width: 260, filter: true, text: (r) => `${r.gl_code} ${r.account_name}`.trim() },
  { key: 'entity', label: 'Entity', width: 200, filter: true, text: (r) => r.location_name || r.location || '' },
  { key: 'department', label: 'Department', width: 170, filter: true, off: true, text: (r) => named(r.department_name, r.department) },
  { key: 'party', label: 'Vendor / Customer', width: 210, filter: true, text: partyOf },
  { key: 'vendor', label: 'Vendor', width: 190, filter: true, off: true, text: (r) => named(r.vendor_name, r.vendor_id) },
  { key: 'customer', label: 'Customer', width: 190, filter: true, off: true, text: (r) => named(r.customer_name, r.customer_id) },
  { key: 'employee', label: 'Employee', width: 170, filter: true, off: true, text: (r) => named(r.employee_name, r.employee_id) },
  { key: 'project', label: 'Project-Job', width: 180, off: true, text: (r) => named(r.project_name, r.project_id) },
  { key: 'item', label: 'Item', width: 160, off: true, text: (r) => named(r.item_name, r.item_id) },
  { key: 'journal', label: 'Journal', width: 88, filter: true, text: (r) => r.journal || '' },
  { key: 'debit', label: 'Debit', width: 118, num: true, filter: true, text: (r) => money(r.debit) },
  { key: 'credit', label: 'Credit', width: 118, num: true, filter: true, text: (r) => money(r.credit) },
];
const MIN_WIDTH = 60;
const DENSITY_PY = { comfortable: '9px', compact: '5px', condensed: '2px' };

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

// The report's filters narrow the search as far as line search can: the
// entities, and one vendor / customer / employee. Anything else (departments,
// Project-Job, item, several parties) is named in the header as not applied,
// so the total here is never mistaken for the filtered report figure.
const PARTY_KINDS = ['vendor', 'customer', 'employee'];
const DIM_NAMES = { departments: 'department', vendor: 'vendor', customer: 'customer', employee: 'employee', project: 'Project-Job', item: 'item' };
function applyDims(dims, entities) {
  const place = entities.length === 1 ? { location: entities[0] } : entities.length ? { locations: entities.join(',') } : {};
  if (!dims) return { place, party: null, unapplied: [] };
  const unapplied = [];
  let party = null;
  const partyKinds = PARTY_KINDS.filter((k) => dims[k]?.length);
  if (partyKinds.length === 1 && dims[partyKinds[0]].length === 1) party = { kind: partyKinds[0], code: dims[partyKinds[0]][0], name: dims[partyKinds[0]][0] };
  else partyKinds.forEach((k) => unapplied.push(`${dims[k].length} ${DIM_NAMES[k]}${dims[k].length > 1 ? 's' : ''}`));
  ['departments', 'project', 'item'].forEach((k) => { if (dims[k]?.length) unapplied.push(`${DIM_NAMES[k]} (${dims[k].length})`); });
  return { place, party, unapplied };
}

export default function LedgerSearch({ term, entities = [], entityName, drill, onClearDrill, onClose, onBusy, dims = null }) {
  const entitiesKey = entities.join(',');
  const applied = useMemo(() => applyDims(dims, entities), [dims, entitiesKey]); // eslint-disable-line react-hooks/exhaustive-deps
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
  const [openEntry, setOpenEntry] = useState(null); // { id, no } - the entry number clicked
  const seq = useRef(0);

  // The person's own layout: which columns show and how wide.
  const [prefs, setPrefs] = useAccountingPrefs();
  const layout = prefs.lines || {};
  const visible = (c) => layout.visible?.[c.key] ?? !c.off;
  const widthOf = (c) => Math.max(MIN_WIDTH, Number(layout.widths?.[c.key]) || c.width);
  const columns = LINE_COLUMNS.filter(visible);
  const setLayout = (p) => setPrefs({ lines: { ...layout, ...p } });
  const tableWidth = columns.reduce((s, c) => s + widthOf(c), 0);

  // The filter boxes. What is typed waits a moment before the ledger is asked.
  const [typed, setTyped] = useState({});
  const [cols, setCols] = useState('');
  useEffect(() => {
    const kept = {};
    LINE_COLUMNS.forEach((c) => { const v = (typed[c.key] || '').trim(); if (c.filter && v) kept[c.key] = v; });
    const next = Object.keys(kept).length ? JSON.stringify(kept) : '';
    const t = setTimeout(() => setCols(next), 350);
    return () => clearTimeout(t);
  }, [typed]);
  const filtering = Object.values(typed).some((v) => (v || '').trim());

  // A new drill-down replaces whatever was picked before it.
  useEffect(() => {
    if (!drill) return;
    setAccount({ code: drill.account, name: drill.accountName });
    setParty(applied.party); setJournal(''); setBook(drill.book === 'cash' ? 'cash' : 'accrual'); setScope('period'); setTyped({});
  }, [drill]); // eslint-disable-line react-hooks/exhaustive-deps
  // A single vendor / customer / employee on the report follows into the search.
  useEffect(() => { setParty(applied.party); }, [applied.party?.kind, applied.party?.code]); // eslint-disable-line react-hooks/exhaustive-deps

  const usePeriod = scope === 'period' && drill;
  const params = useMemo(() => ({
    q: term || undefined,
    ...applied.place,
    from: usePeriod ? drill.from : undefined,
    to: usePeriod ? drill.to : undefined,
    party_kind: party?.kind,
    party: party?.code,
    account: account?.code,
    journal: journal || undefined,
    book: book === 'all' ? undefined : book,
    cols: cols || undefined,
  }), [term, applied.place, usePeriod, drill, party, account, journal, book, cols]);

  const hasCriteria = (term || '').trim().length >= 2 || !!party || !!account || !!journal;

  useEffect(() => { setPage(0); }, [params]);

  useEffect(() => {
    if (!hasCriteria) { setData(null); setError(''); setLoading(false); return; }
    const mine = ++seq.current;
    setLoading(true);
    setError('');
    api.searchAccountingLedger({ ...params, offset: page * PAGE, limit: PAGE })
      .then((d) => { if (mine === seq.current) setData(d); })
      .catch((e) => { if (mine === seq.current) { setData(null); setError(e?.message || 'Could not search the ledger.'); } })
      .finally(() => { if (mine === seq.current) setLoading(false); });
  }, [params, page, hasCriteria]);
  // The toolbar's search box shows the spinner while this is working.
  useEffect(() => { onBusy?.(loading); return () => onBusy?.(false); }, [loading]); // eslint-disable-line react-hooks/exhaustive-deps

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
      // The columns on screen, in their order; amounts as numbers.
      const out = [columns.map((c) => c.label)];
      all.forEach((r) => out.push(columns.map((c) => (c.num ? (r[c.key] || '') : c.text(r)))));
      downloadCsv(`Ledger-Lines_${(term || account?.code || party?.name || 'results').replace(/[^A-Za-z0-9]+/g, '-').slice(0, 40)}.csv`, out);
    } catch (e) {
      setError(e?.message || 'Could not export the results.');
    } finally {
      setExporting(false);
    }
  };

  // Drag a column's right edge to resize it; double-click puts it back.
  const startResize = (c, e) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = widthOf(c);
    const move = (ev) => setLayout({ widths: { ...(layout.widths || {}), [c.key]: Math.max(MIN_WIDTH, Math.round(startW + ev.clientX - startX)) } });
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const resetWidth = (c) => { const w = { ...(layout.widths || {}) }; delete w[c.key]; setLayout({ widths: w }); };

  const card = { backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 10, boxShadow: 'var(--shadow-sm)' };
  const select = { height: 30, padding: '0 8px', borderRadius: 8, border: '1px solid var(--border-color)', fontSize: '0.78rem', fontFamily: 'inherit', background: 'var(--bg-card)', color: 'var(--text-primary)' };

  const heading = [term ? `"${term}"` : null, party?.name, account ? `${account.code} ${account.name || ''}`.trim() : null].filter(Boolean).join(' - ') || 'Ledger lines';
  const periodText = usePeriod ? `${drill.from ? formatDate(drill.from) : 'Start'} - ${formatDate(drill.to)}` : 'All dates';
  const labelSpan = columns.filter((c) => !c.num).length;

  return (
    <div style={card}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <button type="button" className="secondary-btn" onClick={onClose} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', padding: '4px 10px' }}>
          <ArrowLeft size={14} /> Back to Report
        </button>
        <div style={{ minWidth: 0 }}>
          <h3 style={{ fontSize: '0.98rem', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{heading}</h3>
          <div style={{ fontSize: '0.76rem', color: 'var(--text-secondary)' }}>
            {entityName} · {periodText} · {book === 'all' ? 'all books' : `${book} book`}{loading ? (data ? ' · updating' : ' · searching') : ''}
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
          <ColumnChooser layout={layout} visible={visible} onChange={setLayout} />
          <button type="button" className="primary-btn" onClick={exportCsv} disabled={!total || exporting} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', height: 30, padding: '0 12px' }}>
            <Download size={14} /> {exporting ? 'Exporting...' : 'Export CSV'}
          </button>
        </div>
      </div>

      {(party || account || journal || filtering) && (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginBottom: 8 }}>
          <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Narrowed to</span>
          {party && <ActiveChip label={`${party.kind === 'vendor' ? 'Vendor' : party.kind === 'employee' ? 'Employee' : 'Customer'}: ${party.name}`} onClear={() => setParty(null)} />}
          {account && <ActiveChip label={`Account: ${account.code} ${account.name || ''}`.trim()} onClear={() => { setAccount(null); if (drill) onClearDrill(); }} />}
          {journal && <ActiveChip label={`Journal: ${journal}`} onClear={() => setJournal('')} />}
          {LINE_COLUMNS.filter((c) => (typed[c.key] || '').trim()).map((c) => (
            <ActiveChip key={c.key} label={`${c.label} contains ${typed[c.key].trim()}`} onClear={() => setTyped((t) => ({ ...t, [c.key]: '' }))} />
          ))}
          {filtering && <button type="button" onClick={() => setTyped({})} style={{ border: 'none', background: 'none', font: 'inherit', fontSize: '0.75rem', color: 'var(--text-muted)', cursor: 'pointer', textDecoration: 'underline' }}>Clear column filters</button>}
        </div>
      )}

      {applied.unapplied.length > 0 && (
        <div style={{ fontSize: '0.76rem', color: 'var(--text-secondary)', marginBottom: 8 }}>
          Report filters not applied to line search: {applied.unapplied.join(', ')}. These lines are the account's full activity for the entity and period.
        </div>
      )}

      {error && <div style={{ border: '1px solid var(--bad-fg, #dc2626)', color: 'var(--bad-fg, #dc2626)', borderRadius: 8, padding: '10px 12px', fontSize: '0.85rem', marginBottom: 10 }}>{error}</div>}

      {!hasCriteria ? (
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', padding: '24px 0', textAlign: 'center', margin: 0 }}>
          Type at least two characters - a vendor or customer name, an invoice number, or an amount like 1,500.00.
        </p>
      ) : loading && !data ? (
        <div role="status" aria-live="polite">
          <div style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', marginBottom: 8 }}>Searching the ledger...</div>
          <SkeletonBlocks count={4} />
        </div>
      ) : data ? (
        <>
          <div style={{ display: 'grid', gap: 6, marginBottom: 8 }}>
            {!party && <FacetRow label="Vendors" total={total} items={facets.vendors} onPick={(f) => setParty({ kind: 'vendor', code: f.code, name: f.name || f.code })} />}
            {!party && <FacetRow label="Customers" total={total} items={facets.customers} onPick={(f) => setParty({ kind: 'customer', code: f.code, name: f.name || f.code })} />}
            {!account && <FacetRow label="Accounts" total={total} items={facets.accounts} text={(f) => `${f.code} ${f.name || ''}`} onPick={(f) => setAccount({ code: f.code, name: f.name })} />}
            {!journal && <FacetRow label="Journals" total={total} items={facets.journals} onPick={(f) => setJournal(f.code)} />}
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, fontSize: '0.8rem', marginBottom: 8, fontVariantNumeric: 'tabular-nums' }}>
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

          <div className="acct-lines-wrap" style={{ opacity: loading ? 0.6 : 1 }}>
            <table className="acct-lines" style={{ width: tableWidth, '--acct-row-py': DENSITY_PY[prefs.density] || DENSITY_PY.compact }}>
              <colgroup>{columns.map((c) => <col key={c.key} style={{ width: widthOf(c) }} />)}</colgroup>
              <thead>
                <tr>
                  {columns.map((c) => (
                    <th key={c.key} className={c.num ? 'acct-num' : undefined} scope="col">
                      {c.label}
                      <span role="separator" aria-orientation="vertical" aria-label={`Resize the ${c.label} column`} title="Drag to resize · double-click to reset"
                        className="acct-resize" onPointerDown={(e) => startResize(c, e)} onDoubleClick={() => resetWidth(c)} />
                    </th>
                  ))}
                </tr>
                <tr className="acct-filter-row">
                  {columns.map((c) => (
                    <th key={c.key}>
                      {c.filter ? (
                        <input type="text" value={typed[c.key] || ''} onChange={(e) => setTyped((t) => ({ ...t, [c.key]: e.target.value }))}
                          aria-label={`Filter ${c.label}`} placeholder={c.key === 'date' ? 'MM/DD/YYYY' : c.num ? '0.00' : 'contains'} className={c.num ? 'acct-num' : undefined} />
                      ) : null}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.line_id}>
                    {columns.map((c) => {
                      const text = c.text(r);
                      if (c.key === 'entry' && r.entry_id) {
                        return (
                          <td key={c.key} title={text}>
                            <button type="button" className="acct-drill" onClick={() => setOpenEntry({ id: r.entry_id, no: r.entry_no })} title="Open this journal entry">{text || 'Open'}</button>
                          </td>
                        );
                      }
                      if (c.key === 'account') {
                        return <td key={c.key} title={text}><span className="acct-code">{r.gl_code}</span>{r.account_name}</td>;
                      }
                      return <td key={c.key} className={c.num ? 'acct-num' : undefined} title={c.num ? undefined : text}>{text}</td>;
                    })}
                  </tr>
                ))}
                {!rows.length && (
                  <tr><td colSpan={columns.length} style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: '22px 10px', whiteSpace: 'normal' }}>
                    Nothing in the ledger matches{filtering ? ' these filters' : ' all of that'}{entities.length ? ' for the entities picked' : ''}. {filtering ? 'Clear a column filter' : 'Remove a word or a filter'} to widen the search.
                  </td></tr>
                )}
                {rows.length > 0 && page + 1 >= pages && (
                  <tr className="acct-grand">
                    {labelSpan > 0 && <td colSpan={labelSpan}>Totals - {total.toLocaleString('en-US')} lines</td>}
                    {columns.filter((c) => c.num).map((c) => <td key={c.key} className="acct-num">{signed(data[c.key])}</td>)}
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
      {openEntry && <EntryDetail entryId={openEntry.id} entryNo={openEntry.no} onClose={() => setOpenEntry(null)} />}
    </div>
  );
}

// Which columns show. The choice is the person's own and follows them.
function ColumnChooser({ layout, visible, onChange }) {
  const [open, setOpen, ref] = usePopover();
  const customized = Object.keys(layout.visible || {}).length > 0 || Object.keys(layout.widths || {}).length > 0;
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" className="secondary-btn" onClick={() => setOpen((v) => !v)} aria-haspopup="dialog" aria-expanded={open}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', height: 30, padding: '0 10px' }}>
        <Columns3 size={14} /> Columns
      </button>
      {open && (
        <div role="dialog" aria-label="Columns" style={{ position: 'absolute', top: 'calc(100% + 4px)', right: 0, zIndex: 40, width: 240, background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 10, boxShadow: 'var(--shadow-md, 0 8px 24px rgba(0,0,0,0.12))', padding: 10 }}>
          <div style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-muted)', marginBottom: 6 }}>Show these columns</div>
          <div style={{ display: 'grid', gap: 2, maxHeight: 320, overflowY: 'auto' }}>
            {LINE_COLUMNS.map((c) => (
              <label key={c.key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.8rem', padding: '3px 4px', cursor: 'pointer' }}>
                <input type="checkbox" checked={visible(c)} onChange={(e) => onChange({ visible: { ...(layout.visible || {}), [c.key]: e.target.checked } })} />
                {c.label}
              </label>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
            <button type="button" disabled={!customized} onClick={() => onChange({ visible: {}, widths: {} })}
              style={{ border: 'none', background: 'none', font: 'inherit', fontSize: '0.75rem', color: 'var(--text-muted)', cursor: customized ? 'pointer' : 'default', textDecoration: 'underline', opacity: customized ? 1 : 0.5, padding: 0 }}>
              Reset to default
            </button>
            <button type="button" className="primary-btn" style={{ fontSize: '0.75rem', padding: '3px 12px' }} onClick={() => setOpen(false)}>Done</button>
          </div>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 6 }}>Your layout is saved for you on every computer.</div>
        </div>
      )}
    </div>
  );
}

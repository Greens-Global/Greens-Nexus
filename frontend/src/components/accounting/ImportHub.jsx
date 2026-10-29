import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowRightLeft, Clock, Download, FileSpreadsheet, Landmark, ListChecks, Upload, X } from 'lucide-react';
import { api } from '../../api';
import { EntityPicker, control } from './reportControls';
import { buildIntacctRows, classifyLines, findHeaderRow, guessColumns, readSheetFile, readTransactions, ruleFromLine, toCsv, usDate } from './statementImport';
import { PayrollHoursToQb, QbPayrollToIntacct } from './PayrollImport';
import StatementRules from './StatementRules';
import { downloadBlob } from './reportModel';

// Tools > Import Hub (Neil, 10/14: "Import Hub was intended to allow for a
// statement to be uploaded and converted into an Intacct import template,
// for example Fidelity or another bank"). The first cut held three cards
// that only pointed at the ledger setups (Loans, MRI, MRE) - those screens
// already have their own buttons, so the cards are gone.
//
// Upload a statement (CSV, or XLSX/XLS), check the columns it guessed (Date,
// Description, Amount - or Debit and Credit), give the cash account, the
// offset account and the entity, look over the preview, and download the
// Intacct General Ledger journal entry import file: one balanced entry per
// statement line. Everything happens in the browser - nothing is uploaded to
// Nexus or written to Intacct; the file is imported in Intacct by hand.
//
// Rules (Charmi, 10/27 call item 01 - the stand-alone Import Hub's rules,
// ported): every line gets an account, and a vendor or customer, from the
// first matching team rule (StatementRules.jsx, routers/import_hub.py) or
// picked on the line; Save as Rule keeps a pick for the next statement.
// Vendor and Customer filters narrow the lines shown (the download always
// has every line), and a line with no account of its own is flagged - the
// file goes out only once each one is classified or knowingly posted to the
// default offset account.
//
// Payroll (Neil, 10/15: "Payroll export to QB is not there"): two more
// tools, in PayrollImport.jsx - time-sheet hours out to QuickBooks (IIF) and
// Intacct's statistical hours journal, and a QuickBooks payroll report in to
// Intacct's payroll journal. The three tools are cards across the top; the
// one picked is remembered per browser.

const TOOLS = [
  { key: 'statement', title: 'Bank Statement to Intacct', text: 'A bank or brokerage statement as a journal entry import.', Icon: Landmark },
  { key: 'hours', title: 'Payroll Hours to QuickBooks', text: 'Approved time sheet hours as a QuickBooks time import.', Icon: Clock },
  { key: 'qb-payroll', title: 'QuickBooks Payroll to Intacct', text: 'A QuickBooks Desktop or Online payroll report as the Intacct payroll entry.', Icon: ArrowRightLeft },
];
const TOOL_KEY = 'nexus.importhub.tool';

const card = { backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, boxShadow: 'var(--shadow-sm)' };
const label = { display: 'grid', gap: 4, fontSize: '0.74rem', fontWeight: 600, color: 'var(--text-secondary)' };
const fmt = (n) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const PREVIEW = 300;
const cellInput = { ...control, width: '100%', minWidth: 90, height: 28 };
const SHOW = [['all', 'All Lines'], ['open', 'Unclassified'], ['rule', 'By a Rule'], ['hand', 'Set on the Line']];
const listOf = (d, key) => (Array.isArray(d?.[key]) ? d[key] : []);
// Filter value for "no vendor" / "no customer" (never an Intacct ID).
const NONE = '\u0000none';

function StatementToIntacct() {
  const [file, setFile] = useState(null);         // { name, rows }
  const [error, setError] = useState('');
  const [headerRow, setHeaderRow] = useState(0);
  const [map, setMap] = useState(null);
  const [flip, setFlip] = useState(false);
  const [entities, setEntities] = useState([]);
  const [setup, setSetup] = useState({ journal: 'GJCA', cashAccount: '', offsetAccount: '', location: '', department: '' });
  const set = (p) => setSetup((s) => ({ ...s, ...p }));
  const [rules, setRules] = useState([]);
  const [rulesError, setRulesError] = useState('');
  const [rulesOpen, setRulesOpen] = useState(null);   // { draft } while the Rules popup is open
  const [picks, setPicks] = useState({});             // line index -> fields picked on the line
  const [lists, setLists] = useState({ accounts: [], vendors: [], customers: [] });
  const [filter, setFilter] = useState({ vendor: '', customer: '', show: 'all' });
  const [useDefault, setUseDefault] = useState(false);

  const loadRules = useCallback(() => api.getStatementRules()
    .then((d) => { setRules(listOf(d, 'rules')); setRulesError(''); })
    .catch((e) => setRulesError(e?.message || 'Could not load the rules.')), []);
  useEffect(() => {
    let alive = true;
    api.getAccountingLocations().then((d) => { if (alive) setEntities(d?.entities || []); }).catch(() => {});
    loadRules();
    // Pick lists for the Account / Vendor / Customer boxes - typing an ID still works without them.
    Promise.allSettled([api.getAccountingAccounts(), api.getAccountingPartners('vendor'), api.getAccountingPartners('customer')]).then(([a, v, c]) => {
      if (!alive) return;
      const partners = (r) => listOf(r.value, 'partners').map((p) => ({ id: p.id, name: p.displayName || p.name }));
      setLists({ accounts: a.status === 'fulfilled' ? listOf(a.value, 'accounts') : [], vendors: v.status === 'fulfilled' ? partners(v) : [], customers: c.status === 'fulfilled' ? partners(c) : [] });
    });
    return () => { alive = false; };
  }, [loadRules]);

  const onFile = async (f) => {
    if (!f) return;
    setError('');
    try {
      const rows = (await readSheetFile(f)).filter((r) => r.some((c) => c !== ''));
      if (!rows.length) { setError('That file has no rows.'); return; }
      const h = findHeaderRow(rows);
      setFile({ name: f.name, rows });
      setHeaderRow(h);
      setMap(guessColumns(rows[h]));
      setFlip(false);
      setPicks({}); setUseDefault(false);
    } catch (e) {
      setError(e?.message || 'Could not read that file.');
    }
  };
  const reset = () => { setFile(null); setMap(null); setError(''); setPicks({}); };
  const changeHeader = (h) => { setHeaderRow(h); setMap(guessColumns(file.rows[h])); setPicks({}); };

  const header = file ? file.rows[headerRow] || [] : [];
  const { transactions, skipped } = useMemo(
    () => (file && map ? readTransactions(file.rows.slice(headerRow + 1), map, { flip }) : { transactions: [], skipped: 0 }),
    [file, map, headerRow, flip],
  );
  const totals = useMemo(() => transactions.reduce((t, x) => (x.amount > 0 ? { ...t, in: t.in + x.amount } : { ...t, out: t.out - x.amount }), { in: 0, out: 0 }), [transactions]);
  const lines = useMemo(() => classifyLines(transactions, rules, picks), [transactions, rules, picks]);
  const open = lines.filter((l) => !l.classified);
  const offset = setup.offsetAccount.trim();
  const missing = [
    !map || map.date < 0 ? 'the Date column' : '',
    map && map.mode === 'amount' && map.amount < 0 ? 'the Amount column' : '',
    map && map.mode === 'split' && map.debit < 0 && map.credit < 0 ? 'a Debit or Credit column' : '',
    !setup.journal.trim() ? 'the journal' : '',
    !setup.cashAccount.trim() ? 'the cash account' : '',
    // An unclassified line goes out only on purpose: an account (or a rule) of
    // its own, or the default offset account ticked below.
    open.length && !(useDefault && offset) ? `an account for ${open.length} unclassified ${open.length === 1 ? 'line' : 'lines'}` : '',
  ].filter(Boolean);
  const ready = file && transactions.length > 0 && missing.length === 0;
  const setPick = (i, patch) => setPicks((p) => ({ ...p, [i]: { ...(p[i] || {}), ...patch } }));
  const partnerName = (kind, id) => lists[kind].find((x) => x.id === id)?.name || '';
  const accountName = (no) => lists.accounts.find((a) => String(a.account_no) === no)?.title || '';
  const vendorsOn = [...new Set(lines.map((l) => l.vendorId).filter(Boolean))].sort();
  const customersOn = [...new Set(lines.map((l) => l.customerId).filter(Boolean))].sort();
  const shown = lines.filter((l) => (
    (!filter.vendor || (filter.vendor === NONE ? !l.vendorId : l.vendorId === filter.vendor))
    && (!filter.customer || (filter.customer === NONE ? !l.customerId : l.customerId === filter.customer))
    && (filter.show === 'all' || (filter.show === 'open' ? !l.classified : l.how === filter.show))));

  const download = () => {
    const rows = buildIntacctRows(lines, {
      journal: setup.journal.trim(), cashAccount: setup.cashAccount.trim(), offsetAccount: setup.offsetAccount.trim(),
      location: setup.location, department: setup.department.trim(),
    });
    const base = (file.name || 'statement').replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_');
    downloadBlob(`${base}_intacct_je_import.csv`, new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' }));
  };

  const colSelect = (key, text, optional = false) => (
    <label style={label}>
      {text}
      <select value={map?.[key] ?? -1} onChange={(e) => setMap((m) => ({ ...m, [key]: Number(e.target.value) }))} aria-label={text} style={{ ...control, width: '100%' }}>
        <option value={-1}>{optional ? 'None' : 'Pick a Column'}</option>
        {header.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
      </select>
    </label>
  );

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
        Upload a bank or brokerage statement (Fidelity, or any bank's CSV export) and download it as an Intacct General Ledger journal entry import file. The file is built in your browser - nothing is sent to Intacct.
      </div>

      {!file ? (
        <label style={{ ...card, padding: 28, display: 'grid', justifyItems: 'center', gap: 8, cursor: 'pointer', borderStyle: 'dashed', textAlign: 'center' }}
          onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); onFile(e.dataTransfer.files?.[0]); }}>
          <span style={{ display: 'inline-flex', padding: 10, borderRadius: 10, background: 'var(--wk-brand-tint, #e8ecfd)', color: 'var(--wk-brand, #2b45e1)' }}><Upload size={20} /></span>
          <span style={{ fontWeight: 700, fontSize: '0.9rem' }}>Upload a Statement</span>
          <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>CSV, XLSX or XLS - drop it here or click to choose</span>
          <input type="file" accept=".csv,.xlsx,.xls,text/csv" aria-label="Statement file" style={{ display: 'none' }} onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
      ) : (
        <div style={{ ...card, padding: 14, display: 'grid', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <FileSpreadsheet size={16} style={{ color: 'var(--wk-brand, #2b45e1)' }} />
            <strong style={{ fontSize: '0.86rem' }}>{file.name}</strong>
            <span style={{ fontSize: '0.76rem', color: 'var(--text-muted)' }}>{file.rows.length} rows read</span>
            <button type="button" className="secondary-btn" onClick={reset} style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.76rem', padding: '4px 10px' }}>
              <X size={13} /> Choose Another File
            </button>
          </div>

          <div>
            <h3 style={{ margin: '0 0 8px', fontSize: '0.86rem' }}>Columns</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 10 }}>
              <label style={label}>
                Header Row
                <select value={headerRow} onChange={(e) => changeHeader(Number(e.target.value))} aria-label="Header Row" style={{ ...control, width: '100%' }}>
                  {file.rows.slice(0, 40).map((r, i) => <option key={i} value={i}>{`Row ${i + 1}: ${r.filter(Boolean).slice(0, 3).join(', ')}`.slice(0, 60)}</option>)}
                </select>
              </label>
              {colSelect('date', 'Date')}
              {colSelect('description', 'Description', true)}
              {colSelect('memo', 'Memo', true)}
              {colSelect('reference', 'Reference', true)}
              <label style={label}>
                Amounts In
                <select value={map?.mode || 'amount'} onChange={(e) => setMap((m) => ({ ...m, mode: e.target.value }))} aria-label="Amounts In" style={{ ...control, width: '100%' }}>
                  <option value="amount">One Amount Column</option>
                  <option value="split">Debit and Credit Columns</option>
                </select>
              </label>
              {map?.mode === 'split' ? (<>{colSelect('debit', 'Debit (Money Out)', true)}{colSelect('credit', 'Credit (Money In)', true)}</>) : colSelect('amount', 'Amount')}
            </div>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 8, fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
              <input type="checkbox" checked={flip} onChange={(e) => setFlip(e.target.checked)} />
              Flip signs (the statement shows money out as positive)
            </label>
          </div>

          <div>
            <h3 style={{ margin: '0 0 8px', fontSize: '0.86rem' }}>Journal Entry</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 10 }}>
              <label style={label}>Journal<input value={setup.journal} onChange={(e) => set({ journal: e.target.value })} placeholder="GJCA" style={{ ...control, width: '100%' }} /></label>
              <label style={label}>Cash Account<input value={setup.cashAccount} onChange={(e) => set({ cashAccount: e.target.value })} placeholder="e.g. 10100" style={{ ...control, width: '100%' }} /></label>
              <label style={label}>Default Offset Account<input value={setup.offsetAccount} onChange={(e) => set({ offsetAccount: e.target.value })} placeholder="Lines with no rule" list="ih-accounts" style={{ ...control, width: '100%' }} /></label>
              <div style={label}>
                Entity (Location)
                <EntityPicker entities={entities} value={setup.location} onChange={(code) => set({ location: code })} noneLabel="None" ariaLabel="Entity" style={{ width: '100%', maxWidth: 'none' }} />
              </div>
              <label style={label}>Department<input value={setup.department} onChange={(e) => set({ department: e.target.value })} placeholder="Optional" style={{ ...control, width: '100%' }} /></label>
            </div>
            <p style={{ margin: '8px 0 0', fontSize: '0.74rem', color: 'var(--text-muted)' }}>
              Money in debits the cash account and credits the line's account; money out credits cash and debits it. Each line's account, vendor and customer come from the first matching rule, or what is picked on the line. One balanced entry per statement line, in the column layout of Intacct's journal entry import template.
            </p>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', fontSize: '0.8rem' }}>
            <span><strong>{transactions.length}</strong> transactions</span>
            <span>In <strong>{fmt(totals.in)}</strong></span>
            <span>Out <strong>{fmt(totals.out)}</strong></span>
            {skipped > 0 && <span style={{ color: 'var(--text-muted)' }}>{skipped} rows skipped (no date or no amount)</span>}
            <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="secondary-btn" onClick={() => setRulesOpen({ draft: null })} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.8rem', height: 32, padding: '0 12px' }}>
                <ListChecks size={14} /> Rules ({rules.length})
              </button>
              <button type="button" className="primary-btn" disabled={!ready} onClick={download}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.8rem', height: 32, padding: '0 14px' }}>
                <Download size={14} /> Download Intacct Import
              </button>
            </span>
          </div>
          {rulesError && <div role="alert" style={{ fontSize: '0.76rem', color: 'var(--danger, #dc2626)' }}>The rules could not be loaded ({rulesError}) - lines can still be classified by hand.</div>}
          {open.length > 0 && transactions.length > 0 && (
            <div role="status" data-testid="unclassified" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '8px 10px', borderRadius: 8, fontSize: '0.78rem',
              background: 'var(--warn-bg, #fff7e6)', border: '1px solid var(--warn-border, #f5d08a)', color: 'var(--warn-fg, #7a4b00)' }}>
              <AlertTriangle size={15} style={{ flexShrink: 0 }} />
              <span style={{ flex: '1 1 300px' }}><strong>{open.length} of {lines.length}</strong> lines are not classified - no rule matched and no account was picked. Give each one an account (Save as Rule keeps it for next time), or post them to the default offset account.</span>
              <button type="button" className="secondary-btn" onClick={() => setFilter((f) => ({ ...f, show: 'open' }))} style={{ fontSize: '0.76rem', padding: '3px 10px' }}>Show Them</button>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={useDefault} onChange={(e) => setUseDefault(e.target.checked)} />
                Post them to {offset || 'the default offset account'}
              </label>
            </div>
          )}
          {file && missing.length > 0 && <div role="status" style={{ fontSize: '0.76rem', color: 'var(--text-muted)' }}>Still needed: {missing.join(', ')}.</div>}

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'end' }}>
            {[['vendor', 'Vendor', vendorsOn, 'vendors'], ['customer', 'Customer', customersOn, 'customers']].map(([k, t, ids, kind]) => (
              <label key={k} style={{ ...label, minWidth: 200 }}>
                {t}
                <select value={filter[k]} onChange={(e) => setFilter((f) => ({ ...f, [k]: e.target.value }))} aria-label={`${t} Filter`} style={{ ...control, width: '100%' }}>
                  <option value="">All {t}s</option>
                  <option value={NONE}>No {t}</option>
                  {ids.map((id) => <option key={id} value={id}>{partnerName(kind, id) ? `${id} - ${partnerName(kind, id)}` : id}</option>)}
                </select>
              </label>
            ))}
            <label style={{ ...label, minWidth: 170 }}>
              Show
              <select value={filter.show} onChange={(e) => setFilter((f) => ({ ...f, show: e.target.value }))} aria-label="Show" style={{ ...control, width: '100%' }}>
                {SHOW.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
              </select>
            </label>
            {(filter.vendor || filter.customer || filter.show !== 'all') && (
              <button type="button" className="secondary-btn" onClick={() => setFilter({ vendor: '', customer: '', show: 'all' })} style={{ fontSize: '0.76rem', height: 32, padding: '0 10px' }}>Clear</button>
            )}
            <span style={{ fontSize: '0.74rem', color: 'var(--text-muted)', paddingBottom: 8 }}>{shown.length} of {lines.length} lines shown; the download has them all.</span>
          </div>

          <div className="req-table-wrapper" style={{ overflowX: 'auto', maxHeight: 520 }}>
            <table className="req-table" aria-label="Preview">
              <thead><tr><th>Date</th><th>Description</th><th style={{ textAlign: 'right' }}>Money In</th><th style={{ textAlign: 'right' }}>Money Out</th><th>Account</th><th>Vendor</th><th>Customer</th><th>Classified By</th><th aria-label="Save as Rule" /></tr></thead>
              <tbody>
                {shown.slice(0, PREVIEW).map((l) => (
                  <tr key={l.index} data-unclassified={l.classified ? undefined : '1'} style={l.classified ? undefined : { background: 'var(--warn-bg, #fff7e6)' }}>
                    <td style={{ whiteSpace: 'nowrap' }}>{usDate(l.date)}</td>
                    <td style={{ minWidth: 200 }}>{l.description}{(l.memo || l.reference) && <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{[l.memo, l.reference].filter(Boolean).join(' - ')}</div>}</td>
                    <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{l.amount > 0 ? fmt(l.amount) : ''}</td>
                    <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{l.amount < 0 ? fmt(-l.amount) : ''}</td>
                    <td><input value={l.account} list="ih-accounts" placeholder={offset && useDefault ? offset : 'Account'} aria-label={`Account for line ${l.index + 1}`} title={accountName(l.account) || undefined}
                      onChange={(e) => setPick(l.index, { account: e.target.value.trim(), accountName: accountName(e.target.value.trim()) })} style={cellInput} /></td>
                    <td><input value={l.vendorId} list="ih-vendors" placeholder="None" aria-label={`Vendor for line ${l.index + 1}`} title={l.vendorName || partnerName('vendors', l.vendorId) || undefined}
                      onChange={(e) => setPick(l.index, { vendorId: e.target.value.trim(), vendorName: partnerName('vendors', e.target.value.trim()) })} style={cellInput} /></td>
                    <td><input value={l.customerId} list="ih-customers" placeholder="None" aria-label={`Customer for line ${l.index + 1}`} title={l.customerName || partnerName('customers', l.customerId) || undefined}
                      onChange={(e) => setPick(l.index, { customerId: e.target.value.trim(), customerName: partnerName('customers', e.target.value.trim()) })} style={cellInput} /></td>
                    <td style={{ fontSize: '0.74rem', whiteSpace: 'nowrap', color: l.classified ? 'var(--text-secondary)' : 'var(--warning, #b45309)', fontWeight: l.classified ? 400 : 600 }}>
                      {l.how === 'hand' ? 'Set on the Line' : l.rule ? `Rule: ${l.rule.matchText}` : 'Unclassified'}
                    </td>
                    <td><button type="button" className="secondary-btn" onClick={() => setRulesOpen({ draft: ruleFromLine(l) })} aria-label={`Save line ${l.index + 1} as a rule`} style={{ fontSize: '0.72rem', padding: '3px 8px', whiteSpace: 'nowrap' }}>Save as Rule</button></td>
                  </tr>
                ))}
                {lines.length === 0 && <tr><td colSpan={9} style={{ color: 'var(--text-muted)' }}>No transactions read yet - check the header row and the columns.</td></tr>}
                {lines.length > 0 && shown.length === 0 && <tr><td colSpan={9} style={{ color: 'var(--text-muted)' }}>No line matches these filters.</td></tr>}
              </tbody>
            </table>
          </div>
          {shown.length > PREVIEW && <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>Showing the first {PREVIEW} of {shown.length}; the download has them all.</div>}
        </div>
      )}
      {error && <div role="alert" style={{ fontSize: '0.8rem', color: 'var(--danger, #dc2626)' }}>{error}</div>}
      <datalist id="ih-accounts">{lists.accounts.map((a) => <option key={a.account_no} value={a.account_no}>{a.title}</option>)}</datalist>
      <datalist id="ih-vendors">{lists.vendors.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</datalist>
      <datalist id="ih-customers">{lists.customers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</datalist>
      {rulesOpen && (
        <StatementRules rules={rules} draft={rulesOpen.draft} accounts={lists.accounts} vendors={lists.vendors} customers={lists.customers}
          onChanged={loadRules} onClose={() => setRulesOpen(null)} />
      )}
    </div>
  );
}

export default function ImportHub() {
  const [tool, setTool] = useState(() => {
    try { const t = localStorage.getItem(TOOL_KEY); return TOOLS.some((x) => x.key === t) ? t : 'statement'; } catch { return 'statement'; }
  });
  const pick = (t) => { setTool(t); try { localStorage.setItem(TOOL_KEY, t); } catch { /* per-browser convenience */ } };
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div className="scroll-tabs" role="tablist" aria-label="Import Tools" style={{ display: 'grid', gridAutoFlow: 'column', gridAutoColumns: 'minmax(220px, 1fr)', gap: 10 }}>
        {TOOLS.map(({ key, title, text, Icon }) => {
          const on = key === tool;
          return (
            <button key={key} type="button" role="tab" aria-selected={on} onClick={() => pick(key)}
              style={{ ...card, padding: '12px 14px', display: 'flex', gap: 10, alignItems: 'flex-start', textAlign: 'left', cursor: 'pointer', font: 'inherit', color: 'inherit',
                borderColor: on ? 'var(--wk-brand, #2b45e1)' : 'var(--border-color)', boxShadow: on ? '0 0 0 1px var(--wk-brand, #2b45e1)' : card.boxShadow }}>
              <span style={{ display: 'inline-flex', padding: 8, borderRadius: 9, background: 'var(--wk-brand-tint, #e8ecfd)', color: 'var(--wk-brand, #2b45e1)', flexShrink: 0 }}><Icon size={16} /></span>
              <span style={{ display: 'grid', gap: 2 }}>
                <strong style={{ fontSize: '0.84rem' }}>{title}</strong>
                <span style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>{text}</span>
              </span>
            </button>
          );
        })}
      </div>
      {tool === 'statement' && <StatementToIntacct />}
      {tool === 'hours' && <PayrollHoursToQb />}
      {tool === 'qb-payroll' && <QbPayrollToIntacct />}
    </div>
  );
}

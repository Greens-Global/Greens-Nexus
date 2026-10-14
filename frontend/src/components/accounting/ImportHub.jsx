import { useEffect, useMemo, useState } from 'react';
import { Download, FileSpreadsheet, Upload, X } from 'lucide-react';
import { api } from '../../api';
import { EntityPicker, control } from './reportControls';
import { buildIntacctRows, findHeaderRow, guessColumns, parseCsv, readTransactions, toCsv, usDate } from './statementImport';
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
// Payroll export to QuickBooks (also on Neil's list) is not built yet.

const card = { backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, boxShadow: 'var(--shadow-sm)' };
const label = { display: 'grid', gap: 4, fontSize: '0.74rem', fontWeight: 600, color: 'var(--text-secondary)' };
const fmt = (n) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const PREVIEW = 50;

async function readFile(file) {
  const name = (file.name || '').toLowerCase();
  if (/\.(xlsx|xls)$/.test(name)) {
    const XLSX = await import('xlsx');
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: false });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' }).map((r) => r.map((c) => String(c ?? '').trim()));
  }
  return parseCsv(await file.text());
}

export default function ImportHub() {
  const [file, setFile] = useState(null);         // { name, rows }
  const [error, setError] = useState('');
  const [headerRow, setHeaderRow] = useState(0);
  const [map, setMap] = useState(null);
  const [flip, setFlip] = useState(false);
  const [entities, setEntities] = useState([]);
  const [setup, setSetup] = useState({ journal: 'GJ', cashAccount: '', offsetAccount: '', location: '', department: '', state: 'Draft' });
  const set = (p) => setSetup((s) => ({ ...s, ...p }));

  useEffect(() => {
    let alive = true;
    api.getAccountingLocations().then((d) => { if (alive) setEntities(d?.entities || []); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const onFile = async (f) => {
    if (!f) return;
    setError('');
    try {
      const rows = (await readFile(f)).filter((r) => r.some((c) => c !== ''));
      if (!rows.length) { setError('That file has no rows.'); return; }
      const h = findHeaderRow(rows);
      setFile({ name: f.name, rows });
      setHeaderRow(h);
      setMap(guessColumns(rows[h]));
      setFlip(false);
    } catch (e) {
      setError(e?.message || 'Could not read that file.');
    }
  };
  const reset = () => { setFile(null); setMap(null); setError(''); };
  const changeHeader = (h) => { setHeaderRow(h); setMap(guessColumns(file.rows[h])); };

  const header = file ? file.rows[headerRow] || [] : [];
  const { transactions, skipped } = useMemo(
    () => (file && map ? readTransactions(file.rows.slice(headerRow + 1), map, { flip }) : { transactions: [], skipped: 0 }),
    [file, map, headerRow, flip],
  );
  const totals = useMemo(() => transactions.reduce((t, x) => (x.amount > 0 ? { ...t, in: t.in + x.amount } : { ...t, out: t.out - x.amount }), { in: 0, out: 0 }), [transactions]);
  const missing = [
    !map || map.date < 0 ? 'the Date column' : '',
    map && map.mode === 'amount' && map.amount < 0 ? 'the Amount column' : '',
    map && map.mode === 'split' && map.debit < 0 && map.credit < 0 ? 'a Debit or Credit column' : '',
    !setup.journal.trim() ? 'the journal' : '',
    !setup.cashAccount.trim() ? 'the cash account' : '',
    !setup.offsetAccount.trim() ? 'the offset account' : '',
  ].filter(Boolean);
  const ready = file && transactions.length > 0 && missing.length === 0;

  const download = () => {
    const rows = buildIntacctRows(transactions, {
      journal: setup.journal.trim(), cashAccount: setup.cashAccount.trim(), offsetAccount: setup.offsetAccount.trim(),
      location: setup.location, department: setup.department.trim(), state: setup.state,
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
              <label style={label}>Journal<input value={setup.journal} onChange={(e) => set({ journal: e.target.value })} placeholder="GJ" style={{ ...control, width: '100%' }} /></label>
              <label style={label}>Cash Account<input value={setup.cashAccount} onChange={(e) => set({ cashAccount: e.target.value })} placeholder="e.g. 10100" style={{ ...control, width: '100%' }} /></label>
              <label style={label}>Offset Account<input value={setup.offsetAccount} onChange={(e) => set({ offsetAccount: e.target.value })} placeholder="e.g. 12000" style={{ ...control, width: '100%' }} /></label>
              <div style={label}>
                Entity (Location)
                <EntityPicker entities={entities} value={setup.location} onChange={(code) => set({ location: code })} noneLabel="None" ariaLabel="Entity" style={{ width: '100%', maxWidth: 'none' }} />
              </div>
              <label style={label}>Department<input value={setup.department} onChange={(e) => set({ department: e.target.value })} placeholder="Optional" style={{ ...control, width: '100%' }} /></label>
              <label style={label}>
                State
                <select value={setup.state} onChange={(e) => set({ state: e.target.value })} aria-label="State" style={{ ...control, width: '100%' }}>
                  <option value="Draft">Draft</option>
                  <option value="Posted">Posted</option>
                </select>
              </label>
            </div>
            <p style={{ margin: '8px 0 0', fontSize: '0.74rem', color: 'var(--text-muted)' }}>
              Money in debits the cash account and credits the offset; money out credits cash and debits the offset. One balanced entry per statement line.
            </p>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', fontSize: '0.8rem' }}>
            <span><strong>{transactions.length}</strong> transactions</span>
            <span>In <strong>{fmt(totals.in)}</strong></span>
            <span>Out <strong>{fmt(totals.out)}</strong></span>
            {skipped > 0 && <span style={{ color: 'var(--text-muted)' }}>{skipped} rows skipped (no date or no amount)</span>}
            <button type="button" className="primary-btn" disabled={!ready} onClick={download}
              style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.8rem', height: 32, padding: '0 14px' }}>
              <Download size={14} /> Download Intacct Import
            </button>
          </div>
          {file && missing.length > 0 && <div role="status" style={{ fontSize: '0.76rem', color: 'var(--text-muted)' }}>Still needed: {missing.join(', ')}.</div>}

          <div className="req-table-wrapper" style={{ overflowX: 'auto', maxHeight: 420 }}>
            <table className="req-table" aria-label="Preview">
              <thead><tr><th>Date</th><th>Description</th><th>Memo</th><th>Reference</th><th style={{ textAlign: 'right' }}>Debit {setup.cashAccount || 'Cash'}</th><th style={{ textAlign: 'right' }}>Credit {setup.cashAccount || 'Cash'}</th></tr></thead>
              <tbody>
                {transactions.slice(0, PREVIEW).map((t, i) => (
                  <tr key={i}>
                    <td style={{ whiteSpace: 'nowrap' }}>{usDate(t.date)}</td>
                    <td>{t.description}</td>
                    <td>{t.memo}</td>
                    <td>{t.reference}</td>
                    <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{t.amount > 0 ? fmt(t.amount) : ''}</td>
                    <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{t.amount < 0 ? fmt(-t.amount) : ''}</td>
                  </tr>
                ))}
                {transactions.length === 0 && <tr><td colSpan={6} style={{ color: 'var(--text-muted)' }}>No transactions read yet - check the header row and the columns.</td></tr>}
              </tbody>
            </table>
          </div>
          {transactions.length > PREVIEW && <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>Showing the first {PREVIEW} of {transactions.length}; the download has them all.</div>}
        </div>
      )}
      {error && <div role="alert" style={{ fontSize: '0.8rem', color: 'var(--danger, #dc2626)' }}>{error}</div>}
    </div>
  );
}

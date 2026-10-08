import { useEffect, useMemo, useRef, useState } from 'react';
import { FileUp, Hammer, Paperclip, Trash2, X } from 'lucide-react';
import { api } from '../../api';
import Amount, { AmountInput } from './Amount';
import { SkeletonBlocks } from '../AsyncState';
import { formatDate } from '../../lib/datetime';
import { ExportMenu, control } from './reportControls';
import { downloadBlob } from './reportModel';
import { uploadToSupabase, safeFileName } from '../../investor/lib/upload';
import {
  DAY_COUNTS, SCHEDULE_FIELDS, addMonths, buildSchedule, expectedBalanceAt, findHeaderRow, guessColumns, normalizeLoan, round2, rowsFromMatrix, scheduleTotals,
} from './loanMath';

// Accounting -> Loans & Financing -> Amortization (Charmi and Neil, 10/06:
// "Add in Amortization schedule for Commercial loans, allow us to build it or
// upload an existing file from the bank").
//
//   Build    principal, rate, term, amortization (longer than the term =
//            balloon at maturity), interest-only months, first payment and
//            funding dates, 30/360 or Actual/365. The schedule is computed on
//            screen (loanMath.js, tested) and shown before it is saved.
//   Upload   the bank's Excel or CSV (or cells pasted from it): the header
//            row is found, each column guessed from its title and can be
//            changed, the parsed rows are previewed before saving. The file
//            itself is kept in the PRIVATE task-files bucket and opens
//            through the signed viewer like any other evidence.
//   Compare  what the schedule says is owed at the end of the month against
//            the ledger balance on the Loans review.
// One schedule per loan; saving again replaces it. Export is the shared
// Export menu (PDF / Excel / CSV) with banded rows, like the ledger lines.
//
// Props: { loan, canEdit, month } - `loan` is the Loans review row (or any
// object with id, lender, balance, rate/ratePct, maturity, monthlyPi);
// `month` is the YYYY-MM the ledger balance is as of (default this month).

const card = { backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, boxShadow: 'var(--shadow-sm)' };
const bad = { border: '1px solid var(--bad-fg, #dc2626)', color: 'var(--bad-fg, #dc2626)', borderRadius: 8, padding: '8px 12px', fontSize: '0.84rem' };
const warn = { fontSize: '0.78rem', color: '#92400e', background: 'rgba(217,119,6,0.08)', border: '1px solid rgba(217,119,6,0.3)', borderRadius: 8, padding: '6px 10px' };
const label = { fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' };
const num = { textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10 };
const btn = { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', height: 30, padding: '0 12px' };
const thisMonth = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (m) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const notAvailable = (e) => e?.status === 503 || /not configured|not available/i.test(e?.message || '');
const FILE_TYPES = '.xlsx,.xls,.csv';

function Chip({ tone = 'muted', children, title }) {
  const tones = {
    ok: { fg: 'var(--ok-fg, #15803d)', bg: 'rgba(21,128,61,0.10)' }, bad: { fg: 'var(--bad-fg, #dc2626)', bg: 'rgba(220,38,38,0.10)' },
    wait: { fg: '#92400e', bg: 'rgba(180,83,9,0.13)' }, brand: { fg: 'var(--wk-brand, #2b45e1)', bg: 'var(--wk-brand-tint, #e8ecfd)' },
    muted: { fg: 'var(--text-secondary)', bg: 'var(--bg-secondary)' },
  }[tone];
  return <span title={title} style={{ display: 'inline-block', padding: '1px 8px', borderRadius: 999, fontSize: '0.7rem', fontWeight: 700, color: tones.fg, background: tones.bg, whiteSpace: 'nowrap' }}>{children}</span>;
}

/** Months from the first payment to the maturity, inclusive (the term a
 *  loan's maturity implies). */
function termFromMaturity(firstPaymentDate, maturity) {
  if (!firstPaymentDate || !maturity) return '';
  const a = Number(firstPaymentDate.slice(0, 4)) * 12 + Number(firstPaymentDate.slice(5, 7));
  const b = Number(maturity.slice(0, 4)) * 12 + Number(maturity.slice(5, 7));
  return b >= a ? b - a + 1 : '';
}

function defaultParams(l) {
  const first = addMonths(`${thisMonth()}-01`, 1);
  const term = termFromMaturity(first, l.maturity) || 120;
  return { principal: l.balance > 0 ? round2(l.balance) : null, ratePct: l.ratePct ?? '', termMonths: term, amortMonths: 360, ioMonths: 0, firstPaymentDate: first, startDate: '', dayCount: '30/360' };
}

/** The schedule as the shared export table (linesExport.js). */
function scheduleExportTable(rows, l, sched) {
  const hasBalloon = rows.some((r) => r.balloon);
  const t = scheduleTotals(rows);
  const columns = [
    { label: '#', width: 40 }, { label: 'Date', width: 90 }, { label: 'Payment', num: true, width: 110 }, { label: 'Interest', num: true, width: 110 },
    { label: 'Principal', num: true, width: 110 }, ...(hasBalloon ? [{ label: 'Balloon', num: true, width: 110 }] : []), { label: 'Balance', num: true, width: 120 },
  ];
  const body = rows.map((r) => [String(r.n), formatDate(r.date), r.payment, r.interest, r.principal, ...(hasBalloon ? [r.balloon] : []), r.balance]);
  const totals = ['Total', '', t.payment, t.interest, t.principal, ...(hasBalloon ? [t.balloon] : []), ''];
  const source = sched?.source === 'upload' ? `From the bank's file${sched.fileName ? ` ${sched.fileName}` : ''}` : 'Built in Nexus';
  return {
    title: `Amortization Schedule - ${l.lender || 'Loan'}${l.loanNo ? ` #${l.loanNo}` : ''}`,
    subtitle: `${l.entityName || l.entityCode || ''}${l.entityName ? ' · ' : ''}${source} · ${rows.length} payments${rows.length ? ` · ${formatDate(rows[0].date)} - ${formatDate(rows[rows.length - 1].date)}` : ''}`,
    columns, rows: body, totals,
  };
}

export default function LoanAmortization({ loan, canEdit = false, month }) {
  const l = useMemo(() => normalizeLoan(loan), [loan]);
  const asOf = month || thisMonth();
  const [sched, setSched] = useState(undefined);   // undefined = loading, null = none kept
  const [error, setError] = useState(null);
  const [mode, setMode] = useState('view');        // view | build | upload
  const [busy, setBusy] = useState('');
  const [exporting, setExporting] = useState('');

  useEffect(() => {
    // One dialog = one loan: a different loan mounts a fresh component.
    let live = true;
    api.getLoanSchedule(l.id)
      .then((d) => { if (live) setSched(d?.schedule || null); })
      .catch((e) => { if (live) { setSched(null); setError(e); } });
    return () => { live = false; };
  }, [l.id]);

  const rows = useMemo(() => sched?.rows || [], [sched]);
  const expected = useMemo(() => expectedBalanceAt(rows, asOf), [rows, asOf]);
  const variance = expected ? round2(l.balance - expected.balance) : null;

  const save = (body) => {
    setBusy('save');
    setError(null);
    return api.saveLoanSchedule(l.id, body)
      .then((d) => { setSched(d.schedule); setMode('view'); })
      .catch((e) => setError(e))
      .finally(() => setBusy(''));
  };
  const remove = () => {
    if (!window.confirm('Remove this amortization schedule? The bank file stays in storage; the rows are removed.')) return;
    setBusy('delete');
    api.deleteLoanSchedule(l.id).then(() => setSched(null)).catch((e) => setError(e)).finally(() => setBusy(''));
  };
  const doExport = async (format) => {
    setExporting(format);
    try {
      const { linesFile } = await import('./linesExport');
      const table = scheduleExportTable(rows, l, sched);
      const file = await linesFile(table, format);
      downloadBlob(file.name, file);
    } catch (e) {
      setError(e);
    } finally {
      setExporting('');
    }
  };

  if (sched === undefined) return <SkeletonBlocks count={3} />;
  if (error && notAvailable(error)) {
    return <div style={{ ...card, padding: 18, fontSize: '0.86rem', color: 'var(--text-secondary)' }}><strong style={{ color: 'var(--text-primary)' }}>Amortization is not available here.</strong> The accounting service is not connected on this environment, so the loan cannot be read.</div>;
  }

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {error && <div style={bad}>{error.message || 'Something went wrong.'}</div>}
      {mode === 'view' && (
        <>
          <div style={{ ...card, padding: '8px 10px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
            {sched ? (
              <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <Chip tone={sched.source === 'upload' ? 'brand' : 'muted'}>{sched.source === 'upload' ? 'Bank File' : 'Built in Nexus'}</Chip>
                {rows.length} payments{rows.length ? `, ${formatDate(rows[0].date)} - ${formatDate(rows[rows.length - 1].date)}` : ''}
                {sched.fileUrl && <a href={sched.fileUrl} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Paperclip size={13} /> {sched.fileName || 'Bank File'}</a>}
                {sched.at && <span style={{ color: 'var(--text-muted)' }}>· saved {formatDate(sched.at)}{sched.by ? ` by ${sched.by}` : ''}</span>}
              </span>
            ) : <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>No amortization schedule kept for this loan yet.</span>}
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {canEdit && <button type="button" className="secondary-btn" style={btn} onClick={() => setMode('build')}><Hammer size={14} /> {sched?.source === 'build' ? 'Rebuild' : 'Build Schedule'}</button>}
              {canEdit && <button type="button" className="secondary-btn" style={btn} onClick={() => setMode('upload')}><FileUp size={14} /> Upload Bank File</button>}
              {canEdit && sched && <button type="button" className="secondary-btn" style={btn} onClick={remove} disabled={busy === 'delete'}><Trash2 size={14} /> Remove</button>}
              <ExportMenu disabled={!rows.length} items={[
                { key: 'pdf', label: 'PDF', hint: 'Banded, landscape', onPick: () => doExport('pdf'), busy: exporting === 'pdf' },
                { key: 'excel', label: 'Excel', hint: 'Amounts as numbers', onPick: () => doExport('excel'), busy: exporting === 'excel' },
                { key: 'csv', label: 'CSV', onPick: () => doExport('csv'), busy: exporting === 'csv' },
              ]} />
            </div>
          </div>
          {sched && expected && (
            <div style={{ ...card, padding: '10px 12px', display: 'flex', flexWrap: 'wrap', gap: 18, fontSize: '0.8rem', fontVariantNumeric: 'tabular-nums', alignItems: 'center' }}>
              <strong>Schedule vs Ledger - {monthLabel(asOf)}</strong>
              <span>Expected per Schedule <strong><Amount value={expected.balance} /></strong>{expected.asOf ? <span style={{ color: 'var(--text-muted)' }}> (after payment {expected.n}, {formatDate(expected.asOf)})</span> : <span style={{ color: 'var(--text-muted)' }}> (before the first payment)</span>}</span>
              <span>Ledger Balance <strong><Amount value={l.balance} /></strong></span>
              <span>Difference <strong style={{ color: Math.abs(variance) >= 1 ? 'var(--bad-fg, #dc2626)' : undefined }}><Amount value={variance} /></strong></span>
              {Math.abs(variance) < 1 ? <Chip tone="ok">Matches</Chip> : <Chip tone="wait" title="The ledger balance differs from what the schedule says is owed: a missed or extra payment, a fee, or the schedule needs updating">Check</Chip>}
            </div>
          )}
          {rows.length > 0 && <ScheduleTable rows={rows} highlight={expected?.n} />}
        </>
      )}
      {mode === 'build' && <BuildForm loan={l} initial={sched?.source === 'build' ? sched.params : null} busy={busy === 'save'} onCancel={() => setMode('view')} onSave={save} />}
      {mode === 'upload' && <UploadForm loan={l} busy={busy === 'save'} onCancel={() => setMode('view')} onSave={save} />}
    </div>
  );
}

export function ScheduleTable({ rows, highlight, maxHeight = 460 }) {
  const hasBalloon = rows.some((r) => r.balloon);
  const t = scheduleTotals(rows);
  const ref = useRef(null);
  useEffect(() => {
    // Bring the month being compared into view.
    const el = ref.current?.querySelector('[data-current="1"]');
    if (el && ref.current) ref.current.scrollTop = Math.max(0, el.offsetTop - 80);
  }, [highlight, rows]);
  return (
    <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
      <div ref={ref} className="req-table-wrapper" style={{ overflow: 'auto', maxHeight, position: 'relative' }}>
        <table className="req-table" style={{ fontVariantNumeric: 'tabular-nums' }}>
          <thead style={{ position: 'sticky', top: 0, zIndex: 1, background: 'var(--bg-card)' }}>
            <tr><th style={{ width: 48 }}>#</th><th>Date</th><th style={num}>Payment</th><th style={num}>Interest</th><th style={num}>Principal</th>{hasBalloon && <th style={num}>Balloon</th>}<th style={num}>Balance</th></tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const cur = highlight != null && r.n === highlight;
              return (
                <tr key={r.n} data-current={cur ? '1' : undefined} style={{ background: cur ? 'var(--wk-brand-tint, #e8ecfd)' : i % 2 ? 'var(--bg-secondary)' : undefined, fontWeight: cur ? 600 : undefined }}>
                  <td>{r.n}</td><td>{formatDate(r.date)}</td>
                  <td style={num}><Amount value={r.payment} zero="dash" /></td><td style={num}><Amount value={r.interest} zero="dash" /></td><td style={num}><Amount value={r.principal} zero="dash" /></td>
                  {hasBalloon && <td style={num}>{r.balloon ? <strong><Amount value={r.balloon} /></strong> : <Amount value={0} zero="dash" />}</td>}
                  <td style={num}><Amount value={r.balance} /></td>
                </tr>
              );
            })}
            <tr style={{ fontWeight: 700 }}>
              <td>Total</td><td /><td style={num}><Amount value={t.payment} /></td><td style={num}><Amount value={t.interest} /></td><td style={num}><Amount value={t.principal} /></td>
              {hasBalloon && <td style={num}><Amount value={t.balloon} /></td>}<td />
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Field({ id, title, children, hint }) {
  return (
    <div>
      <label style={label} htmlFor={id}>{title}</label>
      {children}
      {hint && <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: 3 }}>{hint}</div>}
    </div>
  );
}

function BuildForm({ loan, initial, busy, onCancel, onSave }) {
  const [p, setP] = useState(() => ({ ...defaultParams(loan), ...(initial || {}) }));
  const set = (patch) => setP((x) => ({ ...x, ...patch }));
  const result = useMemo(() => buildSchedule(p), [p]);
  const ok = !result.errors.length;
  const input = { ...control, width: '100%' };
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ ...card, padding: 14, display: 'grid', gap: 12 }}>
        <strong style={{ fontSize: '0.9rem' }}>Build Schedule</strong>
        <div style={grid}>
          <Field id="am-principal" title="Principal"><AmountInput id="am-principal" value={p.principal} onChange={(v) => set({ principal: v })} style={input} /></Field>
          <Field id="am-rate" title="Annual Rate %"><input id="am-rate" type="number" step="0.001" min="0" value={p.ratePct} onChange={(e) => set({ ratePct: e.target.value })} style={input} /></Field>
          <Field id="am-term" title="Term (Months)" hint={loan.maturity ? `Maturity on file: ${formatDate(loan.maturity)}` : 'Months to maturity'}>
            <input id="am-term" type="number" min="1" max="1200" value={p.termMonths} onChange={(e) => set({ termMonths: e.target.value })} style={input} />
          </Field>
          <Field id="am-amort" title="Amortization (Months)" hint="Longer than the term leaves a balloon"><input id="am-amort" type="number" min="1" max="1200" value={p.amortMonths} onChange={(e) => set({ amortMonths: e.target.value })} style={input} /></Field>
          <Field id="am-io" title="Interest-Only Months"><input id="am-io" type="number" min="0" max="1200" value={p.ioMonths} onChange={(e) => set({ ioMonths: e.target.value })} style={input} /></Field>
          <Field id="am-first" title="First Payment Date"><input id="am-first" type="date" value={p.firstPaymentDate} onChange={(e) => set({ firstPaymentDate: e.target.value })} style={input} /></Field>
          <Field id="am-start" title="Funding Date" hint="Optional - interest runs from it to the first payment"><input id="am-start" type="date" value={p.startDate} onChange={(e) => set({ startDate: e.target.value })} style={input} /></Field>
          <Field id="am-freq" title="Payment Frequency"><select id="am-freq" value="monthly" disabled style={input}><option value="monthly">Monthly</option></select></Field>
          <Field id="am-day" title="Day Count"><select id="am-day" value={p.dayCount} onChange={(e) => set({ dayCount: e.target.value })} style={input}>{DAY_COUNTS.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}</select></Field>
        </div>
        {loan.maturity && p.firstPaymentDate && termFromMaturity(p.firstPaymentDate, loan.maturity) && Number(p.termMonths) !== termFromMaturity(p.firstPaymentDate, loan.maturity) && (
          <div style={warn}>
            The maturity on file ({formatDate(loan.maturity)}) is {termFromMaturity(p.firstPaymentDate, loan.maturity)} months from the first payment.{' '}
            <button type="button" className="secondary-btn" style={{ fontSize: '0.72rem', padding: '1px 8px', marginLeft: 6 }} onClick={() => set({ termMonths: termFromMaturity(p.firstPaymentDate, loan.maturity) })}>Use It</button>
          </div>
        )}
        {!ok ? <div style={warn}>{result.errors.join(' ')}</div> : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, fontSize: '0.8rem', fontVariantNumeric: 'tabular-nums' }}>
            {result.ioPayment > 0 && <span>Interest-Only Payment <strong><Amount value={result.ioPayment} /></strong></span>}
            <span>Monthly P&I <strong><Amount value={result.payment} /></strong></span>
            <span>Total Interest <strong><Amount value={result.totalInterest} /></strong></span>
            <span>Balloon at Maturity <strong>{result.balloon ? <Amount value={result.balloon} /> : 'None'}</strong></span>
            {loan.monthlyPi != null && Math.abs(loan.monthlyPi - result.payment) >= 1 && <span style={{ color: '#92400e' }}>Monthly P&I on file: <Amount value={loan.monthlyPi} /></span>}
          </div>
        )}
      </div>
      {ok && <ScheduleTable rows={result.rows} maxHeight={360} />}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" className="secondary-btn" onClick={onCancel}>Cancel</button>
        <button type="button" className="primary-btn" disabled={!ok || busy} onClick={() => onSave({ source: 'build', params: p, rows: result.rows })}>{busy ? 'Saving...' : 'Save Schedule'}</button>
      </div>
    </div>
  );
}

/** Cells copied from Excel arrive as tab-separated lines. */
function matrixFromPaste(text) {
  return String(text || '').replace(/\r/g, '').split('\n').filter((line) => line.trim()).map((line) => line.split('\t').map((c) => c.trim()));
}

function UploadForm({ loan, busy, onCancel, onSave }) {
  const [file, setFile] = useState(null);
  const [book, setBook] = useState(null);         // { sheets: { name: matrix }, names }
  const [sheet, setSheet] = useState('');
  const [headerRow, setHeaderRow] = useState(0);
  const [map, setMap] = useState({});
  const [err, setErr] = useState('');
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef(null);

  const loadMatrix = (sheets, names) => {
    const first = names[0];
    setBook({ sheets, names });
    setSheet(first);
    const h = findHeaderRow(sheets[first]);
    setHeaderRow(h);
    setMap(guessColumns(sheets[first][h] || []));
  };
  const read = async (f) => {
    setErr('');
    setFile(f);
    try {
      const XLSX = await import('xlsx');
      const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' });
      const sheets = {};
      for (const n of wb.SheetNames) sheets[n] = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: '' });
      if (!wb.SheetNames.length) throw new Error('The file has no sheets.');
      loadMatrix(sheets, wb.SheetNames);
    } catch (e) {
      setBook(null);
      setErr(`Could not read "${f.name}": ${e?.message || 'not an Excel or CSV file'}.`);
    }
  };
  const onPaste = (e) => {
    const text = e.clipboardData?.getData('text/plain');
    if (!text || !text.includes('\t')) return;
    e.preventDefault();
    setFile(null);
    setErr('');
    loadMatrix({ Pasted: matrixFromPaste(text) }, ['Pasted']);
  };
  const pickSheet = (n) => {
    setSheet(n);
    const h = findHeaderRow(book.sheets[n]);
    setHeaderRow(h);
    setMap(guessColumns(book.sheets[n][h] || []));
  };
  const matrix = useMemo(() => (book ? book.sheets[sheet] || [] : []), [book, sheet]);
  const headers = matrix[headerRow] || [];
  const parsed = useMemo(() => (book ? rowsFromMatrix(matrix, headerRow, map) : { rows: [], skipped: 0 }), [book, matrix, headerRow, map]);
  const missing = SCHEDULE_FIELDS.filter((f) => f.required && !(map[f.key] >= 0)).map((f) => f.label);
  const canSave = book && !missing.length && parsed.rows.length > 0;

  const save = async () => {
    let fileUrl = '';
    let note = '';
    if (file) {
      setUploading(true);
      const path = `accounting/loan-schedules/${safeFileName(String(loan.id))}/${Date.now()}-${safeFileName(file.name)}`;
      // The private task-files bucket (Sep 22): the file opens only through
      // the signed /files/view redirect, for a signed-in person.
      const up = await uploadToSupabase(file, 'task-files', path, null);
      setUploading(false);
      if (up.error) note = up.error;
      fileUrl = up.url || '';
    }
    if (note && !window.confirm(`The bank's file could not be stored (${note}). Save the rows without it?`)) return;
    const columnMap = Object.fromEntries(Object.entries(map).map(([k, i]) => [k, i >= 0 ? String(headers[i] ?? `Column ${i + 1}`) : '']));
    onSave({ source: 'upload', rows: parsed.rows, columnMap, fileUrl, fileName: file ? file.name : 'Pasted from Excel' });
  };

  return (
    <div style={{ display: 'grid', gap: 10 }} onPaste={onPaste}>
      <div style={{ ...card, padding: 14, display: 'grid', gap: 12 }}>
        <strong style={{ fontSize: '0.9rem' }}>Upload Bank File</strong>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <input ref={inputRef} type="file" accept={FILE_TYPES} style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) read(f); e.target.value = ''; }} />
          <button type="button" className="secondary-btn" style={btn} onClick={() => inputRef.current?.click()}><FileUp size={14} /> Choose File</button>
          <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>{file ? file.name : book ? 'Pasted cells' : 'Excel (.xlsx, .xls) or CSV - or press Ctrl+V to paste the rows copied from Excel'}</span>
        </div>
        {err && <div style={bad}>{err}</div>}
        {book && (
          <>
            <div style={grid}>
              {book.names.length > 1 && (
                <Field id="up-sheet" title="Sheet"><select id="up-sheet" value={sheet} onChange={(e) => pickSheet(e.target.value)} style={{ ...control, width: '100%' }}>{book.names.map((n) => <option key={n} value={n}>{n}</option>)}</select></Field>
              )}
              <Field id="up-header" title="Header Row" hint={`Row ${headerRow + 1}: ${headers.filter(Boolean).slice(0, 4).join(', ') || '(empty)'}`}>
                <input id="up-header" type="number" min="1" max={Math.max(1, matrix.length)} value={headerRow + 1}
                  onChange={(e) => { const h = Math.max(0, Math.min(matrix.length - 1, Number(e.target.value) - 1 || 0)); setHeaderRow(h); setMap(guessColumns(matrix[h] || [])); }} style={{ ...control, width: '100%' }} />
              </Field>
              {SCHEDULE_FIELDS.map((f) => (
                <Field key={f.key} id={`up-${f.key}`} title={`${f.label}${f.required ? ' *' : ''}`}>
                  <select id={`up-${f.key}`} value={map[f.key] ?? -1} onChange={(e) => setMap((m) => ({ ...m, [f.key]: Number(e.target.value) }))} style={{ ...control, width: '100%' }}>
                    <option value={-1}>{f.required ? 'Pick a column' : 'Not in the file'}</option>
                    {headers.map((h, i) => <option key={i} value={i}>{String(h || `Column ${i + 1}`)}</option>)}
                  </select>
                </Field>
              ))}
            </div>
            {missing.length > 0 ? <div style={warn}>Pick the {missing.join(' and ')} column{missing.length > 1 ? 's' : ''}.</div>
              : <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>{parsed.rows.length} payments read{parsed.skipped ? `; ${parsed.skipped} rows without a date or balance left out (titles, totals)` : ''}. A missing principal is the payment less the interest.</div>}
          </>
        )}
      </div>
      {canSave && <ScheduleTable rows={parsed.rows} maxHeight={360} />}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" className="secondary-btn" onClick={onCancel}>Cancel</button>
        <button type="button" className="primary-btn" disabled={!canSave || busy || uploading} onClick={save}>{uploading ? 'Uploading...' : busy ? 'Saving...' : parsed.rows.length ? `Save ${parsed.rows.length} Payments` : 'Save Payments'}</button>
      </div>
    </div>
  );
}

/** The schedule in a dialog - what the Loans table opens from a row. */
export function LoanAmortizationDialog({ loan, canEdit = false, month, onClose }) {
  const l = normalizeLoan(loan);
  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <div className="modal-content" role="dialog" aria-modal="true" aria-label="Amortization schedule" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 1080, width: '100%' }}>
        <div className="modal-header">
          <div>
            <h3 style={{ margin: 0 }}>Amortization Schedule</h3>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: 2 }}>{l.lender || 'Loan'}{l.loanNo ? ` #${l.loanNo}` : ''}{l.entityName ? ` · ${l.entityName}` : ''} · ledger balance <Amount value={l.balance} /></div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        <div style={{ padding: '14px 24px 18px', maxHeight: '78vh', overflowY: 'auto' }}>
          <LoanAmortization loan={loan} canEdit={canEdit} month={month} />
        </div>
      </div>
    </div>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet, Plus, RotateCcw, Upload, X } from 'lucide-react';
import { api } from '../../api';
import { ensureStepUp, isStepUpRequired } from '../../stepup/StepUp';
import { formatDate } from '../../lib/datetime';
import { EntityPicker, control } from './reportControls';
import { downloadBlob } from './reportModel';
import { readSheetFile, toCsv } from './statementImport';
import {
  DEFAULT_PAYROLL_MAPPING, HOUR_BUCKETS, ITEM_KINDS, buildIif, buildPayrollEntries, checkBalance, employeeInfo, employeeKey, hoursFromNexus,
  hoursFromPayroll, hoursRows, loadPayrollPrefs, netPayMismatches, parseHoursFile, parseQbPayroll, payrollRows, savePayrollPrefs,
  totalsFromHoursFile, unmappedItems,
} from './payrollConvert';

// Import Hub payroll cards (Neil, 10/15: "Payroll export to QB is not there";
// "HR export and import into QB, as well as the export from QB to Intacct").
//
// Payroll Hours to QuickBooks: the period's hours from Nexus time sheets (one
// company, finalized sheets only by default - GET /timeclock/export-hours,
// payroll/HR access behind step-up) or from an uploaded hours file, previewed
// per person, then downloaded as the QuickBooks Desktop time import (IIF) or
// Intacct's statistical hours journal (STAT, the OSM hours template).
//
// QuickBooks Payroll to Intacct: a QuickBooks payroll report (the Payroll
// Summary, or a long payroll detail export) -> Intacct's payroll journal
// (PYRJ, the OSM payroll layout), one balanced entry per employee, with an
// editable payroll item -> GL mapping and employee map remembered in this
// browser; plus the STAT hours from the same report. Built in the browser;
// nothing is written to QuickBooks or Intacct.

const card = { backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, boxShadow: 'var(--shadow-sm)' };
const label = { display: 'grid', gap: 4, fontSize: '0.74rem', fontWeight: 600, color: 'var(--text-secondary)' };
const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 10 };
const num = { textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const h3 = { margin: '0 0 8px', fontSize: '0.86rem' };
const small = { fontSize: '0.74rem', color: 'var(--text-muted)' };
const btn = { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.8rem', height: 32, padding: '0 14px' };
const cellInput = { ...control, width: '100%', minWidth: 70, height: 28 };
const fmt = (n) => (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtH = (n) => (n ? (Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 }) : '');
const PREVIEW = 60;
const fileBase = (name, fallback) => (name || fallback).replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_');
const saveCsv = (name, rows) => downloadBlob(name, new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' }));

// Default period: the last 14 days ending last Saturday (Nexus pay periods run Sunday to Saturday).
function lastPeriod() {
  const d = new Date();
  d.setDate(d.getDate() - ((d.getDay() + 1) % 7 || 7));
  const iso = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  const end = iso(d);
  d.setDate(d.getDate() - 13);
  return { start: iso(d), end };
}

function usePrefs({ defaultPeriod = false } = {}) {
  const [prefs, setPrefs] = useState(() => {
    const p = loadPayrollPrefs();
    if (!defaultPeriod) return p;
    const per = lastPeriod();
    return { ...p, settings: { ...p.settings, periodStart: per.start, periodEnd: per.end } };
  });
  useEffect(() => { savePayrollPrefs(prefs); }, [prefs]);
  const setSettings = (patch) => setPrefs((p) => ({ ...p, settings: { ...p.settings, ...patch } }));
  const setEmployee = (name, patch) => setPrefs((p) => {
    const k = employeeKey(name);
    return { ...p, employees: { ...p.employees, [k]: { ...(p.employees[k] || {}), ...patch } } };
  });
  return { prefs, setPrefs, setSettings, setEmployee };
}

function useEntities() {
  const [entities, setEntities] = useState([]);
  useEffect(() => {
    let alive = true;
    api.getAccountingLocations().then((d) => { if (alive) setEntities(d?.entities || []); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  return entities;
}

function UploadZone({ title, hint, onFile, ariaLabel }) {
  return (
    <label style={{ ...card, padding: 24, display: 'grid', justifyItems: 'center', gap: 8, cursor: 'pointer', borderStyle: 'dashed', textAlign: 'center' }}
      onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); onFile(e.dataTransfer.files?.[0]); }}>
      <span style={{ display: 'inline-flex', padding: 10, borderRadius: 10, background: 'var(--wk-brand-tint, #e8ecfd)', color: 'var(--wk-brand, #2b45e1)' }}><Upload size={20} /></span>
      <span style={{ fontWeight: 700, fontSize: '0.9rem' }}>{title}</span>
      <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>{hint}</span>
      <input type="file" accept=".csv,.xlsx,.xls,text/csv" aria-label={ariaLabel} style={{ display: 'none' }} onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ''; }} />
    </label>
  );
}

function FileBar({ name, detail, onReset }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <FileSpreadsheet size={16} style={{ color: 'var(--wk-brand, #2b45e1)' }} />
      <strong style={{ fontSize: '0.86rem' }}>{name}</strong>
      <span style={{ fontSize: '0.76rem', color: 'var(--text-muted)' }}>{detail}</span>
      <button type="button" className="secondary-btn" onClick={onReset} style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.76rem', padding: '4px 10px' }}>
        <X size={13} /> Choose Another File
      </button>
    </div>
  );
}

/** The Intacct fields both cards share: journal(s), entity, default department, description prefix. */
function IntacctFields({ settings, set, entities, payroll = false }) {
  const text = (k, t, ph) => (
    <label style={label}>{t}<input value={settings[k] || ''} onChange={(e) => set({ [k]: e.target.value })} placeholder={ph} style={{ ...control, width: '100%' }} /></label>
  );
  return (
    <>
      {payroll && text('journal', 'Payroll Journal', 'PYRJ')}
      {text('hoursJournal', 'Hours Journal', 'STAT')}
      <div style={label}>
        Entity (Location)
        <EntityPicker entities={entities} value={settings.location} onChange={(code) => set({ location: code })} noneLabel="None" ariaLabel="Entity" style={{ width: '100%', maxWidth: 'none' }} />
      </div>
      {text('department', 'Default Department', 'e.g. 8000')}
      {payroll && text('netPayAccount', 'Net Pay Account', '23700')}
      {text('prefix', 'Description Prefix', 'e.g. OSM')}
    </>
  );
}

function DateField({ k, t, settings, set }) {
  return <label style={label}>{t}<input type="date" value={settings[k] || ''} onChange={(e) => set({ [k]: e.target.value })} aria-label={t} style={{ ...control, width: '100%' }} /></label>;
}

/** Employee ID / Vendor ID / Department per person, remembered in this browser. */
function EmployeeTable({ people, employeeMap, setEmployee, showVendor = true }) {
  if (!people.length) return null;
  return (
    <div className="req-table-wrapper" style={{ overflowX: 'auto', maxHeight: 320 }}>
      <table className="req-table" aria-label="Employees">
        <thead><tr><th>Employee</th><th>Employee ID</th>{showVendor && <th>Vendor ID</th>}<th>Department</th></tr></thead>
        <tbody>
          {people.map((p) => {
            const info = employeeInfo(employeeMap, p.name, { code: p.code, dept: p.dept });
            return (
              <tr key={p.name}>
                <td>{p.name}</td>
                <td><input value={info.code} onChange={(e) => setEmployee(p.name, { code: e.target.value })} aria-label={`Employee ID for ${p.name}`} style={cellInput} /></td>
                {showVendor && <td><input value={info.vendor} onChange={(e) => setEmployee(p.name, { vendor: e.target.value })} aria-label={`Vendor ID for ${p.name}`} placeholder="Optional" style={cellInput} /></td>}
                <td><input value={info.dept} onChange={(e) => setEmployee(p.name, { dept: e.target.value })} aria-label={`Department for ${p.name}`} placeholder="Default" style={cellInput} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function HoursPreview({ people, showApproval }) {
  return (
    <div className="req-table-wrapper" style={{ overflowX: 'auto', maxHeight: 420 }}>
      <table className="req-table" aria-label="Hours Preview">
        <thead>
          <tr>
            <th>Employee</th><th>Employee ID</th>
            <th style={num}>Regular</th><th style={num}>Overtime</th><th style={num}>Double Time</th><th style={num}>Sick</th><th style={num}>Vacation</th><th style={num}>Personal</th>
            {showApproval && <th>Status</th>}
          </tr>
        </thead>
        <tbody>
          {people.slice(0, PREVIEW).map((p) => (
            <tr key={p.name}>
              <td>{p.name}</td><td>{p.code}</td>
              <td style={num}>{fmtH(p.hours.regular)}</td><td style={num}>{fmtH(p.hours.overtime)}</td><td style={num}>{fmtH(p.hours.doubleTime)}</td>
              <td style={num}>{fmtH(p.hours.sick)}</td><td style={num}>{fmtH(p.hours.vacation)}</td><td style={num}>{fmtH(p.hours.personal)}</td>
              {showApproval && <td>{p.approved ? 'Approved' : 'Not Approved'}</td>}
            </tr>
          ))}
          {people.length === 0 && <tr><td colSpan={showApproval ? 9 : 8} style={{ color: 'var(--text-muted)' }}>No hours for this period.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

// ── Payroll Hours to QuickBooks ─────────────────────────────────────────────

export function PayrollHoursToQb() {
  const { prefs, setSettings, setEmployee } = usePrefs({ defaultPeriod: true });
  const s = prefs.settings;
  const entities = useEntities();
  const [source, setSource] = useState('nexus');
  const [companies, setCompanies] = useState([]);
  const [company, setCompany] = useState('');
  // Finalized time sheets only by default (Oct 19): unchecked is a draft
  // preview that includes time not signed and finalized yet.
  const [finalizedOnly, setFinalizedOnly] = useState(true);
  const [nexus, setNexus] = useState(null);      // { rows, start, end, company, finalizedOnly }
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [file, setFile] = useState(null);        // { name, entries, skipped }

  useEffect(() => {
    let alive = true;
    api.getEntities().then((d) => { if (alive) setCompanies(Array.isArray(d) ? d : []); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const withStepUp = async (fn) => {
    const up = await ensureStepUp();
    if (!up.ok) { if (!up.cancelled && !up.redirecting) setError('The identity check did not complete.'); return null; }
    try { return await fn(); } catch (e) {
      if (!isStepUpRequired(e)) throw e;
      const again = await ensureStepUp();
      return again.ok ? fn() : null;
    }
  };

  const load = async () => {
    if (!s.periodStart || !s.periodEnd) { setError('Pick the period start and end.'); return; }
    setBusy('load'); setError('');
    try {
      const d = await withStepUp(() => api.timeExportHours(s.periodStart, s.periodEnd, { company, finalizedOnly }));
      if (d) setNexus({ rows: d.rows || [], start: s.periodStart, end: s.periodEnd, company, finalizedOnly });
    } catch (e) {
      setError(e?.status === 403 ? 'Time sheet hours need payroll access in People. You can still upload an hours file.' : (e?.message || 'Could not load the hours.'));
    } finally { setBusy(''); }
  };

  const onFile = async (f) => {
    if (!f) return;
    setError('');
    try {
      const parsed = parseHoursFile((await readSheetFile(f)).filter((r) => r.some((c) => c !== '')));
      if (!parsed.found) { setError('No Employee and Hours columns found in that file.'); return; }
      setFile({ name: f.name, ...parsed });
    } catch (e) { setError(e?.message || 'Could not read that file.'); }
  };

  const people = useMemo(() => {
    if (source === 'nexus') {
      return nexus ? hoursFromNexus(nexus.rows).map((p, i) => ({ ...p, hours: nexus.rows[i].hours })) : [];
    }
    return file ? totalsFromHoursFile(file.entries) : [];
  }, [source, nexus, file]);
  const stale = source === 'nexus' && nexus && (nexus.start !== s.periodStart || nexus.end !== s.periodEnd || nexus.company !== company || nexus.finalizedOnly !== finalizedOnly);
  const have = people.length > 0 && !stale;
  const totalHours = people.reduce((t, p) => t + Object.values(p.buckets).reduce((a, b) => a + b, 0), 0);

  const downloadIif = async () => {
    if (source === 'file') {
      const text = buildIif(file.entries, { fallbackDate: s.periodEnd });
      downloadBlob(`${fileBase(file.name, 'hours')}_quickbooks.iif`, new Blob([text], { type: 'application/octet-stream' }));
      return;
    }
    setBusy('iif'); setError('');
    try {
      const res = await withStepUp(() => api.timeExportIifFor(nexus.start, nexus.end, { company: nexus.company, finalizedOnly: nexus.finalizedOnly }));
      if (res) downloadBlob(res.filename || `timeclock-${nexus.start}-to-${nexus.end}.iif`, res.blob);
    } catch (e) { setError(e?.message || 'Could not download the QuickBooks file.'); }
    finally { setBusy(''); }
  };
  const downloadStat = () => {
    const name = source === 'file' ? `${fileBase(file.name, 'hours')}_intacct_hours_import.csv` : `Intacct Hours Import - ${s.periodStart} to ${s.periodEnd}.csv`;
    saveCsv(name, hoursRows(people, { ...s, payDate: s.payDate || s.periodEnd }, prefs.employees));
  };

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
        The pay period's hours as a QuickBooks Desktop time import (IIF), so nobody keys hours into QuickBooks by hand, and as Intacct's statistical hours journal. Take them from Nexus time sheets or upload an hours file.
      </div>

      <div className="scroll-tabs" role="tablist" aria-label="Hours Source" style={{ display: 'flex', gap: 6 }}>
        {[['nexus', 'Nexus Time Sheets'], ['file', 'Upload an Hours File']].map(([k, t]) => (
          <button key={k} type="button" role="tab" aria-selected={source === k} className={source === k ? 'primary-btn' : 'secondary-btn'} onClick={() => { setSource(k); setError(''); }}
            style={{ fontSize: '0.78rem', padding: '5px 12px' }}>{t}</button>
        ))}
      </div>

      <div style={{ ...card, padding: 14, display: 'grid', gap: 12 }}>
        <div>
          <h3 style={h3}>Pay Period</h3>
          <div style={grid}>
            <DateField k="periodStart" t="Period Start" settings={s} set={setSettings} />
            <DateField k="periodEnd" t="Period End" settings={s} set={setSettings} />
            {source === 'nexus' && (
              <label style={label}>
                Company
                <select value={company} onChange={(e) => setCompany(e.target.value)} aria-label="Company" style={{ ...control, width: '100%' }}>
                  <option value="">All Companies</option>
                  {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
            )}
          </div>
          {source === 'nexus' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginTop: 10 }}>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                <input type="checkbox" checked={finalizedOnly} onChange={(e) => setFinalizedOnly(e.target.checked)} />
                Finalized time sheets only
              </label>
              <button type="button" className="primary-btn" onClick={load} disabled={busy === 'load'} style={btn}>
                {busy === 'load' ? 'Loading...' : 'Load Hours'}
              </button>
              {stale && <span style={small}>The period or filters changed - load the hours again.</span>}
            </div>
          )}
          {source === 'nexus' && !finalizedOnly && (
            <div role="note" data-testid="iif-draft-note" style={{ marginTop: 8, fontSize: '0.78rem', color: 'hsl(var(--color-orange))', fontWeight: 600 }}>
              Draft preview: includes time sheets that are not finalized yet. The QuickBooks file is named DRAFT - do not import it into payroll.
            </div>
          )}
        </div>

        {source === 'file' && (!file ? (
          <UploadZone title="Upload an Hours File" hint="CSV, XLSX or XLS with Employee and Hours columns (Date, Payroll Item and Customer:Job are read when there) - QuickBooks Time by Name works" onFile={onFile} ariaLabel="Hours file" />
        ) : (
          <FileBar name={file.name} detail={`${file.entries.length} time rows${file.skipped ? `, ${file.skipped} skipped` : ''}`} onReset={() => setFile(null)} />
        ))}

        {(source === 'nexus' ? nexus : file) && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', fontSize: '0.8rem' }}>
              <span><strong>{people.length}</strong> employees</span>
              <span><strong>{fmtH(totalHours) || 0}</strong> hours</span>
              {source === 'nexus' && nexus && <span style={small}>{formatDate(nexus.start)} to {formatDate(nexus.end)}</span>}
              <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 8, flexWrap: 'wrap' }}>
                <button type="button" className="primary-btn" disabled={!have || busy === 'iif'} onClick={downloadIif} style={btn}><Download size={14} /> {source === 'nexus' && nexus && !nexus.finalizedOnly ? 'Download Draft QuickBooks IIF' : 'Download QuickBooks IIF'}</button>
                <button type="button" className="secondary-btn" disabled={!have} onClick={downloadStat} style={btn}><Download size={14} /> Download Intacct Hours Import</button>
              </span>
            </div>
            <HoursPreview people={people} showApproval={source === 'nexus'} />
            {people.length > PREVIEW && <div style={small}>Showing the first {PREVIEW} of {people.length}; the downloads have them all.</div>}
            <p style={{ ...small, margin: 0 }}>
              QuickBooks matches the employee by name and the payroll items Regular Pay, Overtime Pay, Double-time Pay, Holiday Pay, Sick Pay, Vacation Pay and Personal Pay - they must exist in QuickBooks or be mapped when importing. Nexus time sheets use each company's names, and its QuickBooks company name, from Settings &gt; Time Clock &gt; Pay Rules &gt; Payroll Export Codes.
            </p>
          </>
        )}

        <details>
          <summary style={{ cursor: 'pointer', fontSize: '0.82rem', fontWeight: 700 }}>Intacct Hours Import Settings</summary>
          <div style={{ ...grid, marginTop: 10 }}>
            <IntacctFields settings={s} set={setSettings} entities={entities} />
            <DateField k="payDate" t="Entry Date" settings={s} set={setSettings} />
          </div>
          <p style={{ ...small, margin: '8px 0' }}>One statistical entry for the period: a line per person per bucket - P.REG (regular), P.OHR (overtime and double time), P.SHR (sick), P.VHR (vacation and personal). The entry date defaults to the period end.</p>
          <EmployeeTable people={people} employeeMap={prefs.employees} setEmployee={setEmployee} />
        </details>
      </div>
      {error && <div role="alert" style={{ fontSize: '0.8rem', color: 'var(--danger, #dc2626)' }}>{error}</div>}
    </div>
  );
}

// ── QuickBooks Payroll to Intacct ───────────────────────────────────────────

function MappingTable({ rows, onChange, onRemove }) {
  return (
    <div className="req-table-wrapper" style={{ overflowX: 'auto', maxHeight: 420 }}>
      <table className="req-table" aria-label="Payroll Item Mapping">
        <thead><tr><th>Payroll Item</th><th>Posts As</th><th>Debit Account</th><th>Credit Account</th><th>Memo</th><th>Hours Bucket</th><th aria-label="Remove" /></tr></thead>
        <tbody>
          {rows.map(({ rule, index, amount }) => (
            <tr key={`${rule.item}-${index}`}>
              <td style={{ minWidth: 160 }}>
                <input value={rule.item} onChange={(e) => onChange(index, { item: e.target.value })} aria-label="Payroll Item" style={cellInput} />
                {amount !== undefined && <div style={small}>{fmt(amount)} on this report</div>}
              </td>
              <td>
                <select value={rule.kind} onChange={(e) => onChange(index, { kind: e.target.value })} aria-label={`Posts As for ${rule.item}`} style={{ ...cellInput, minWidth: 190 }}>
                  {ITEM_KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
                </select>
              </td>
              <td><input value={rule.debit} disabled={rule.kind === 'withholding' || rule.kind === 'ignore'} onChange={(e) => onChange(index, { debit: e.target.value })} aria-label={`Debit Account for ${rule.item}`} style={cellInput} /></td>
              <td><input value={rule.credit} disabled={rule.kind === 'earning' || rule.kind === 'ignore'} onChange={(e) => onChange(index, { credit: e.target.value })} aria-label={`Credit Account for ${rule.item}`} style={cellInput} /></td>
              <td><input value={rule.memo} onChange={(e) => onChange(index, { memo: e.target.value })} aria-label={`Memo for ${rule.item}`} style={cellInput} /></td>
              <td>
                <select value={rule.hours || ''} onChange={(e) => onChange(index, { hours: e.target.value })} aria-label={`Hours Bucket for ${rule.item}`} style={cellInput}>
                  <option value="">None</option>
                  {HOUR_BUCKETS.map((b) => <option key={b.key} value={b.key}>{b.key}</option>)}
                </select>
              </td>
              <td><button type="button" className="secondary-btn" onClick={() => onRemove(index)} aria-label={`Remove ${rule.item}`} style={{ padding: '3px 6px' }}><X size={12} /></button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function QbPayrollToIntacct() {
  const { prefs, setPrefs, setSettings, setEmployee } = usePrefs();
  const s = prefs.settings;
  const entities = useEntities();
  const [file, setFile] = useState(null);       // { name, report }
  const [error, setError] = useState('');
  const [showAll, setShowAll] = useState(false);

  const onFile = async (f) => {
    if (!f) return;
    setError('');
    try {
      const report = parseQbPayroll((await readSheetFile(f)).filter((r) => r.some((c) => c !== '')));
      if (!report.employees.length) { setError('No employees found. Upload the QuickBooks Payroll Summary (employees across the top) or a payroll detail export with Employee, Payroll Item and Amount columns.'); return; }
      setFile({ name: f.name, report });
    } catch (e) { setError(e?.message || 'Could not read that file.'); }
  };

  const employees = useMemo(() => file?.report.employees || [], [file]);
  const mapping = prefs.mapping;
  const setRule = (i, patch) => setPrefs((p) => ({ ...p, mapping: p.mapping.map((m, j) => (j === i ? { ...m, ...patch } : m)) }));
  const removeRule = (i) => setPrefs((p) => ({ ...p, mapping: p.mapping.filter((_, j) => j !== i) }));
  const addRule = (item, amount) => setPrefs((p) => ({ ...p, mapping: [...p.mapping, { item, kind: amount < 0 ? 'withholding' : 'earning', debit: '', credit: '', memo: item, hours: '' }] }));
  const resetRules = () => setPrefs((p) => ({ ...p, mapping: DEFAULT_PAYROLL_MAPPING.map((m) => ({ ...m })) }));

  const unmapped = useMemo(() => unmappedItems(employees, mapping), [employees, mapping]);
  const built = useMemo(() => buildPayrollEntries(employees, mapping, s, prefs.employees), [employees, mapping, s, prefs.employees]);
  const balance = useMemo(() => checkBalance(built.entries), [built]);
  const mismatches = useMemo(() => netPayMismatches(built.entries), [built]);
  const itemTotals = useMemo(() => {
    const t = new Map();
    employees.forEach((e) => e.items.forEach((it) => t.set(employeeKey(it.item), (t.get(employeeKey(it.item)) || 0) + it.amount)));
    return t;
  }, [employees]);
  const mappingRows = mapping.map((rule, index) => ({ rule, index, amount: itemTotals.get(employeeKey(rule.item)) }))
    .filter((r) => showAll || r.amount !== undefined);
  const hoursPeople = useMemo(() => hoursFromPayroll(employees, mapping), [employees, mapping]);

  const missingAccounts = [...new Set(built.missing.map((m) => m.item))];
  const problems = [
    !s.payDate ? 'Pick the pay date.' : '',
    !s.journal.trim() ? 'Give the payroll journal.' : '',
    unmapped.length ? `Map or ignore ${unmapped.length === 1 ? 'this payroll item' : 'these payroll items'}: ${unmapped.map((u) => u.item).join(', ')}.` : '',
    missingAccounts.length ? `Give an account for: ${missingAccounts.join(', ')}.` : '',
    !balance.balanced ? `Debits (${fmt(balance.debit)}) do not equal credits (${fmt(balance.credit)})${balance.unbalanced.length ? ` for ${balance.unbalanced.map((u) => u.employee).join(', ')}` : ''}.` : '',
  ].filter(Boolean);
  const ready = file && built.entries.length > 0 && problems.length === 0;
  const allLines = built.entries.flatMap((e) => e.lines.map((l) => ({ ...l, employee: e.employee })));

  const downloadPayroll = () => saveCsv(`${fileBase(file.name, 'payroll')}_intacct_payroll_import.csv`, payrollRows(built.entries, { location: s.location }));
  const downloadHours = () => saveCsv(`${fileBase(file.name, 'payroll')}_intacct_hours_import.csv`, hoursRows(hoursPeople, s, prefs.employees));

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
        Upload the QuickBooks Payroll Summary (or a payroll detail export) and download Intacct's payroll journal entry import - one balanced entry per employee - and the statistical hours import. Built in your browser; nothing is sent to QuickBooks or Intacct.
      </div>

      {!file ? (
        <UploadZone title="Upload a QuickBooks Payroll Report" hint="CSV, XLSX or XLS - drop it here or click to choose" onFile={onFile} ariaLabel="QuickBooks payroll file" />
      ) : (
        <div style={{ ...card, padding: 14, display: 'grid', gap: 14 }}>
          <FileBar name={file.name}
            detail={`${file.report.format === 'summary' ? 'Payroll Summary' : 'Payroll Detail'} - ${employees.length} employees${file.report.period ? ` - ${file.report.period}` : ''}`}
            onReset={() => setFile(null)} />

          <div>
            <h3 style={h3}>Journal Entry</h3>
            <div style={grid}>
              <DateField k="payDate" t="Pay Date" settings={s} set={setSettings} />
              <DateField k="periodStart" t="Period Start" settings={s} set={setSettings} />
              <DateField k="periodEnd" t="Period End" settings={s} set={setSettings} />
              <IntacctFields settings={s} set={setSettings} entities={entities} payroll />
            </div>
            <p style={{ ...small, margin: '8px 0 0' }}>
              Earnings debit their expense account; withholdings and deductions credit theirs; employer taxes debit the expense and credit the liability; the net pay closes each entry on the net pay account. The pay period goes on the hours lines.
            </p>
          </div>

          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
              <h3 style={{ ...h3, margin: 0 }}>Payroll Item Mapping</h3>
              <span style={small}>Remembered in this browser.</span>
              <label style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.76rem', color: 'var(--text-secondary)' }}>
                <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show items not on this report
              </label>
              <button type="button" className="secondary-btn" onClick={resetRules} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.76rem', padding: '4px 10px' }}>
                <RotateCcw size={13} /> Reset to Defaults
              </button>
            </div>
            {unmapped.length > 0 && (
              <div role="status" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8, fontSize: '0.78rem' }}>
                <AlertTriangle size={14} style={{ color: 'var(--warning, #b45309)' }} />
                <span>Not mapped yet:</span>
                {unmapped.map((u) => (
                  <button key={u.item} type="button" className="secondary-btn" onClick={() => addRule(u.item, u.amount)} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '0.74rem', padding: '3px 8px' }}>
                    <Plus size={12} /> {u.item} ({fmt(u.amount)})
                  </button>
                ))}
              </div>
            )}
            <MappingTable rows={mappingRows} onChange={setRule} onRemove={removeRule} />
          </div>

          <details>
            <summary style={{ cursor: 'pointer', fontSize: '0.82rem', fontWeight: 700 }}>Employees ({employees.length})</summary>
            <p style={{ ...small, margin: '8px 0' }}>Employee ID fills GLENTRY_EMPLOYEEID (read from a code in the name, like "(E-0100)"), Vendor ID fills GLENTRY_VENDORID, Department overrides the default. Remembered in this browser.</p>
            <EmployeeTable people={employees} employeeMap={prefs.employees} setEmployee={setEmployee} />
          </details>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', fontSize: '0.8rem' }}>
            <span><strong>{built.entries.length}</strong> entries</span>
            <span>Debits <strong>{fmt(balance.debit)}</strong></span>
            <span>Credits <strong>{fmt(balance.credit)}</strong></span>
            {built.entries.length > 0 && (balance.balanced
              ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--success, #15803d)' }}><CheckCircle2 size={14} /> Balanced</span>
              : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--danger, #dc2626)' }}><AlertTriangle size={14} /> Not Balanced</span>)}
            <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="primary-btn" disabled={!ready} onClick={downloadPayroll} style={btn}><Download size={14} /> Download Intacct Payroll Import</button>
              <button type="button" className="secondary-btn" disabled={!ready || !s.periodStart || !s.periodEnd} onClick={downloadHours} style={btn}><Download size={14} /> Download Intacct Hours Import</button>
            </span>
          </div>
          {problems.length > 0 && (
            <div role="alert" style={{ display: 'grid', gap: 2, fontSize: '0.78rem', color: 'var(--danger, #dc2626)' }}>
              {problems.map((p) => <span key={p}>{p}</span>)}
            </div>
          )}
          {mismatches.length > 0 && (
            <div role="status" style={{ fontSize: '0.78rem', color: 'var(--warning, #b45309)' }}>
              Net pay does not match the report for {mismatches.map((m) => `${m.employee} (report ${fmt(m.report)}, entry ${fmt(m.built)})`).join('; ')} - check the mapping of their payroll items.
            </div>
          )}

          <div className="req-table-wrapper" style={{ overflowX: 'auto', maxHeight: 420 }}>
            <table className="req-table" aria-label="Preview">
              <thead><tr><th>Employee</th><th style={num}>Line</th><th>Account</th><th>Department</th><th>Memo</th><th style={num}>Debit</th><th style={num}>Credit</th></tr></thead>
              <tbody>
                {allLines.slice(0, PREVIEW).map((l, i) => (
                  <tr key={i}>
                    <td>{l.lineNo === 1 ? l.employee : ''}</td>
                    <td style={num}>{l.lineNo}</td>
                    <td style={!l.acct ? { color: 'var(--danger, #dc2626)' } : undefined}>{l.acct || 'Missing'}</td>
                    <td>{l.dept}</td>
                    <td>{l.memo}</td>
                    <td style={num}>{l.debit ? fmt(l.debit) : ''}</td>
                    <td style={num}>{l.credit ? fmt(l.credit) : ''}</td>
                  </tr>
                ))}
                {allLines.length === 0 && <tr><td colSpan={7} style={{ color: 'var(--text-muted)' }}>No lines yet - check the mapping.</td></tr>}
              </tbody>
            </table>
          </div>
          {allLines.length > PREVIEW && <div style={small}>Showing the first {PREVIEW} of {allLines.length} lines; the download has them all.</div>}
        </div>
      )}
      {error && <div role="alert" style={{ fontSize: '0.8rem', color: 'var(--danger, #dc2626)' }}>{error}</div>}
    </div>
  );
}

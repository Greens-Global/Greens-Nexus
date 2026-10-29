import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, AlertTriangle, ChevronDown } from 'lucide-react';
import { api } from '../../api';
import { SkeletonBlocks } from '../AsyncState';
import { formatDate } from '../../lib/datetime';
import Amount from './Amount';
import { BarMore, ColumnResizer, ControlBar, EntitiesPicker, ExportMenu, PeriodStepper, SyncButton, control, fitSelect } from './reportControls';
import { useColumnWidths, useFitHeight } from './tableHooks';
import { cellStyle, headStyle } from './columnStyles';
import LinesPanel from './LinesPanel';
import { useTableSync } from './tableSync';
import { EMPTY_DIMS, downloadBlob, fetchBuckets, resolveConfig } from './reportModel';
import { linesFile } from './linesExport';
import { useAccountingPrefs } from './prefs';
import { matchPeople } from '../../lib/peopleSearch';
import { useListNav } from '../../lib/listNav';
import { NO_EMPLOYEE, pickEmployees, resolveNoEmployee, summarize, tableOf } from './payrollSummaryModel';
import {
  PAYROLL_SUMMARY_DEFAULT_PRESET, PAYROLL_SUMMARY_EMPLOYEES_AS, PAYROLL_SUMMARY_EMPLOYEE_FROM_DESCRIPTION, PAYROLL_SUMMARY_FALLBACK_MAX_LINES, PAYROLL_SUMMARY_JOURNAL,
} from './assumptions';

// Accounting -> Reports -> Payroll & People -> Payroll Summary (Neil and
// Charmi, 10/22 call, CR-09: "think of a payroll summary as ... a pay stub
// that has been added up over a period of time"; team answer, 23 Oct: the
// payroll comes from QuickBooks through the journal import, and this should
// "effectively be the same as a Quickbooks Payroll Summary report"). Pick
// the pay dates, the entities and one, several or all employees: Gross Pay,
// Taxes Withheld, Deductions From Net Pay, Net Pay, Employer Taxes and
// Contributions and Total Payroll Cost, a column per employee and a Total,
// with a check that every PYRJ dollar of the period is in a row. Read in ONE
// buckets read (PYRJ, split by employee); the rows and accounts are
// PAYROLL_SUMMARY_SECTIONS in ./assumptions.js (pending Charmi's QB copy).

// Call of 10/27 with Charmi, item 17 ("everything should have the drill down
// option ... make sure this is also all resizable"): every amount opens the
// payroll journal (PYRJ) lines behind it - the row's accounts, for that
// employee (a Total: every employee shown) - in the side panel; the columns
// drag wider or narrower, kept per person. Lines with no employee on them, or
// whose employee was read from a description, are not apart on the ledger:
// their cells do not open (the Total still does).
const MAX_QUERIES = 80;
export function payrollQueries(drill, config) {
  if (!drill) return null;
  const place = config.entities.length === 1 ? { location: config.entities[0] } : config.entities.length ? { locations: config.entities.join(',') } : {};
  const who = drill.employees.length ? drill.employees : [null];
  if (drill.accounts.length * who.length > MAX_QUERIES) return null;
  return drill.accounts.flatMap((account) => who.map((e) => ({ journal: PAYROLL_SUMMARY_JOURNAL, account, from: config.from, to: config.to, ...place, ...(e ? { party_kind: 'employee', party: e } : {}) })));
}

const card = { backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, boxShadow: 'var(--shadow-sm)' };

function EmployeePicker({ employees, value, onChange }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  // Ranked like every people picker: first-name prefix, then another word, then any hit.
  const shown = matchPeople(employees, q);
  const label = !value.length ? 'All Employees' : value.length === 1 ? employees.find((e) => e.key === value[0])?.name || '1 employee' : `${value.length} Employees`;
  const toggle = (k) => onChange(value.includes(k) ? value.filter((x) => x !== k) : [...value, k]);
  const nav = useListNav(shown, { open, query: q, onPick: (e) => toggle(e.key) });
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-haspopup="listbox" aria-expanded={open} aria-label="Employees"
        style={{ ...control, display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontWeight: value.length ? 600 : 400 }}>
        {label} <ChevronDown size={13} />
      </button>
      {open && (
        <div role="listbox" aria-label="Employees" aria-multiselectable="true"
          style={{ position: 'absolute', zIndex: 30, top: 34, left: 0, width: 300, maxHeight: 360, overflowY: 'auto', ...card, padding: 8, display: 'grid', gap: 4 }}>
          <input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find an employee" aria-label="Find an employee" style={{ ...control, width: '100%' }}
            {...nav.inputProps} onKeyDown={nav.onKeyDown} />
          <div style={{ display: 'flex', gap: 8, fontSize: '0.74rem' }}>
            <button type="button" className="secondary-btn" style={{ fontSize: '0.72rem', padding: '2px 8px' }} onClick={() => onChange([])}>All</button>
            <button type="button" className="secondary-btn" style={{ fontSize: '0.72rem', padding: '2px 8px' }} onClick={() => onChange(shown.map((e) => e.key))}>Only These</button>
          </div>
          {shown.map((e, i) => (
            <label key={e.key || '~none'} {...nav.optionProps(i)} aria-selected={value.includes(e.key)} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.8rem', cursor: 'pointer' }}>
              <input type="checkbox" checked={value.includes(e.key)} onChange={() => toggle(e.key)} /> {e.name}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

export default function PayrollSummary() {
  const [prefs] = useAccountingPrefs();
  const [config, setConfig] = useState(() => resolveConfig({ report: 'general-ledger', preset: PAYROLL_SUMMARY_DEFAULT_PRESET }));
  const patch = (p) => setConfig((c) => resolveConfig({ ...c, ...p }));
  const [entities, setEntities] = useState([]);
  const [limited, setLimited] = useState(false);
  const [picked, setPicked] = useState([]);
  const [as, setAs] = useState(PAYROLL_SUMMARY_EMPLOYEES_AS);
  const [res, setRes] = useState({ key: '', data: null, error: '' });
  const [lines, setLines] = useState(null);           // the lines behind a figure (item 17)
  const closeLines = useCallback(() => setLines(null), []);
  const widths = useColumnWidths('payroll-summary', {}, { min: 60 });
  useEffect(() => {
    let alive = true;
    api.getAccountingLocations().then((d) => { if (alive) { setEntities(d?.entities || []); setLimited(!!d?.limited); } }).catch(() => {});
    return () => { alive = false; };
  }, []);

  // 10/23 meeting, item 13: Sync reads the payroll journal again (ts.tick), nothing else.
  const ts = useTableSync();
  const [box, setBox] = useState(null);
  const fit = useFitHeight(box);   // item 05: the summary scrolls inside its own box
  const key = JSON.stringify([config.from, config.to, config.entities, ts.tick]);
  useEffect(() => {
    let alive = true;
    const read = async () => {
      const cfg = { ...config, dims: { ...EMPTY_DIMS, journals: [PAYROLL_SUMMARY_JOURNAL] } };
      const d = await fetchBuckets(api, cfg, { from: config.from, to: config.to }, 'employee', 'accrual', entities);
      let rows = d?.rows || [];
      let names = d?.labels || {};
      let fallback = '';
      const loose = rows.some((r) => String(r.bucket ?? '') === NO_EMPLOYEE && (Number(r.debit) || Number(r.credit)));
      if (loose && PAYROLL_SUMMARY_EMPLOYEE_FROM_DESCRIPTION) {
        // Lines with no employee on them: read them one by one, the employee from the entry description.
        const place = config.entities.length === 1 ? { location: config.entities[0] } : config.entities.length ? { locations: config.entities.join(',') } : {};
        const lines = [];
        let total = Infinity;
        for (let offset = 0; offset < Math.min(total, PAYROLL_SUMMARY_FALLBACK_MAX_LINES); offset += 1000) {
          const page = await api.searchAccountingLedger({ journal: PAYROLL_SUMMARY_JOURNAL, from: config.from, to: config.to, ...place, offset, limit: 1000 });
          total = page?.total || 0;
          lines.push(...(page?.rows || []));
          if (!(page?.rows || []).length) break;
        }
        if (total > PAYROLL_SUMMARY_FALLBACK_MAX_LINES) {
          fallback = `More than ${PAYROLL_SUMMARY_FALLBACK_MAX_LINES.toLocaleString('en-US')} ${PAYROLL_SUMMARY_JOURNAL} lines in the period, so lines with no employee were not read one by one - pick a shorter period to see whose they are.`;
        } else {
          const r = resolveNoEmployee(rows, lines, names);
          rows = r.rows;
          names = r.names;
          if (r.moved) fallback = `${r.moved} ${PAYROLL_SUMMARY_JOURNAL} ${r.moved === 1 ? 'line has' : 'lines have'} no employee on the ledger; the employee was read from the entry description ("Payroll <date> - <employee>").`;
        }
      }
      return { rows, names, fallback };
    };
    ts.read(read).then((d) => { if (alive) setRes({ key, data: d, error: '' }); })
      .catch((e) => { if (alive) setRes({ key, data: null, error: e?.message || 'Could not read the payroll journal.' }); });
    return () => { alive = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const loading = res.key !== key;

  const full = useMemo(() => (res.data ? summarize(res.data.rows, res.data.names) : null), [res.data]);
  const summary = useMemo(() => (full ? pickEmployees(full, picked.filter((k) => full.employees.some((e) => e.key === k))) : null), [full, picked]);
  const table = useMemo(() => (summary ? tableOf(summary, as) : null), [summary, as]);
  const hasNoEmployee = !!full?.employees.some((e) => e.key === NO_EMPLOYEE);

  const [busy, setBusy] = useState('');
  const exportAs = async (format) => {
    if (!table) return;
    setBusy(format);
    try {
      const file = await linesFile({
        title: 'Payroll Summary', period: `${config.from}_${config.to}`,
        subtitle: [`${formatDate(config.from)} - ${formatDate(config.to)}`, config.entities.length ? config.entities.join(', ') : 'All Entities', `${PAYROLL_SUMMARY_JOURNAL} journal`].join(' · '),
        columns: table.columns.map((c) => ({ label: c.label, num: !!c.num, width: c.num ? 110 : 260 })),
        rows: table.rows.map((r) => [r.label, ...(r.kind === 'section' ? table.columns.slice(1).map(() => '') : r.cells)]),
        totals: null,
      }, format);
      downloadBlob(file.name, file);
    } finally {
      setBusy('');
    }
  };

  const bold = (kind) => kind === 'total' || kind === 'net' || kind === 'grand';
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr)', gap: 10 }}>
      <ControlBar style={{ ...card, padding: '8px 10px' }}>
        <PeriodStepper config={config} period="range" onChange={patch} />
        {/* Item 02, round 3 (UI test 10/24: two lines at 1100): into More go
            the layout, then the employees, Entities, Sync, then Export. */}
        <BarMore level={3} active={config.entities.length ? 1 : 0}>
        <EntitiesPicker entities={entities} value={config.entities} onChange={(codes) => patch({ entities: codes })} limited={limited} showHistorical={!!prefs.showHistoricalEntities} />
        </BarMore>
        <BarMore level={2} active={picked.length ? 1 : 0}>
        <EmployeePicker employees={full?.employees || []} value={picked} onChange={setPicked} />
        </BarMore>
        <BarMore level={1} active={as !== PAYROLL_SUMMARY_EMPLOYEES_AS ? 1 : 0}>
        <select value={as} onChange={(e) => setAs(e.target.value)} aria-label="Layout" style={{ ...control, ...fitSelect(as === 'rows' ? 'Employees as Rows' : 'Employees as Columns', { base: 'Employees as Columns' }) }}>
          <option value="columns">Employees as Columns</option>
          <option value="rows">Employees as Rows</option>
        </select>
        </BarMore>
        <div className="acct-bar-end">
          <BarMore level={4}>
          <SyncButton onSync={ts.sync} busy={loading && !!res.data} syncedAt={ts.syncedAt} />
          </BarMore>
          <BarMore level={5}>
          <ExportMenu disabled={!table} items={[
            { key: 'excel', label: 'Excel', hint: 'The summary as on screen', onPick: () => exportAs('excel'), busy: busy === 'excel' },
            { key: 'csv', label: 'CSV', hint: 'Plain values', onPick: () => exportAs('csv'), busy: busy === 'csv' },
            { key: 'pdf', label: 'PDF', hint: 'Landscape, banded, page numbers', onPick: () => exportAs('pdf'), busy: busy === 'pdf' },
          ]} />
          </BarMore>
        </div>
      </ControlBar>

      <div role="note" style={{ fontSize: '0.76rem', color: 'var(--text-secondary)', padding: '0 4px' }}>
        From the QuickBooks payroll imported into the {PAYROLL_SUMMARY_JOURNAL} journal, by pay date. Each row is a payroll item&apos;s account; what counts as gross pay, withheld, deducted or employer-paid follows the import&apos;s account mapping until Charmi&apos;s QuickBooks Payroll Summary is matched line by line.
        {hasNoEmployee && ' Lines with no employee on them are under No Employee on the Line.'}
        {res.data?.fallback ? ` ${res.data.fallback}` : ''}
      </div>
      {res.error && <div role="alert" style={{ ...card, padding: 12, color: 'var(--bad-fg, #dc2626)', fontSize: '0.84rem' }}>{res.error}</div>}
      {loading && !res.data && <div role="status" aria-label="Reading the payroll journal" style={{ ...card, padding: 12 }}><SkeletonBlocks count={6} /></div>}

      {summary && !summary.employees.length && !loading && (
        <div style={{ ...card, padding: 18, fontSize: '0.86rem', color: 'var(--text-secondary)' }}>
          No {PAYROLL_SUMMARY_JOURNAL} entries between {formatDate(config.from)} and {formatDate(config.to)}{config.entities.length ? ' for the entities picked' : ''}.
        </div>
      )}

      {table && summary.employees.length > 0 && (
        <div style={{ ...card, padding: 10, opacity: loading ? 0.6 : 1 }}>
          <h3 style={{ margin: '0 0 6px', fontSize: '0.98rem' }}>Payroll Summary</h3>
          <div style={{ fontSize: '0.76rem', color: 'var(--text-secondary)', marginBottom: 8 }}>
            {formatDate(config.from)} - {formatDate(config.to)} · {config.entities.length ? `${config.entities.length} ${config.entities.length === 1 ? 'entity' : 'entities'}` : 'All Entities'} · {summary.employees.length} {summary.employees.length === 1 ? 'employee' : 'employees'}
          </div>
          <div className="acct-report-wrap acct-scroll-box acct-fit" ref={setBox} data-testid="payroll-summary-box" style={fit}>
            <table className="acct-report">
              <thead>
                <tr>{table.columns.map((c, j) => (
                  <th key={c.key} className={c.num ? 'acct-num' : 'acct-label acct-head'} style={headStyle(widths.width(c.key), j ? null : { position: 'sticky', left: 0 })}>
                    {c.label}<ColumnResizer {...widths.resizer(c.key, c.label)} />
                  </th>
                ))}</tr>
              </thead>
              <tbody>
                {table.rows.map((r, i) => (r.kind === 'section'
                  ? <tr key={`s${i}`} className="acct-section"><td className="acct-label" colSpan={table.columns.length}>{r.label}</td></tr>
                  : (
                    <tr key={`r${i}`} className={r.kind === 'grand' ? 'acct-grand' : undefined} style={bold(r.kind) ? { fontWeight: 700 } : undefined}>
                      <td className={`acct-label${r.kind === 'account' && as === 'columns' ? ' acct-indent' : ''}`} style={cellStyle(widths.width(table.columns[0].key))} title={r.label}>{r.label}</td>
                      {r.cells.map((v, j) => {
                        const col = table.columns[j + 1];
                        const queries = Math.abs(Number(v) || 0) >= 0.005 ? payrollQueries(r.drills?.[j], config) : null;
                        const what = as === 'columns' ? `${r.label} - ${col.label}` : `${col.label} - ${r.label}`;
                        return (
                          <td key={j} className="acct-num" style={cellStyle(widths.width(col.key))}>
                            {queries
                              ? <button type="button" className="acct-drill" onClick={() => setLines({ what, queries, drill: r.drills[j] })} title="See the lines behind this amount" aria-label={`Lines behind ${what}`}><Amount value={v} zero="dash" /></button>
                              : <Amount value={v} zero="dash" />}
                          </td>
                        );
                      })}
                    </tr>
                  )))}
              </tbody>
            </table>
          </div>
          <Reconciliation check={full.check} unmapped={full.unmapped} partial={!!summary.partial} />
        </div>
      )}
      {lines && (
        <LinesPanel key={lines.what} label={lines.what} title={lines.what} widthsKey="payroll-summary" queries={lines.queries} onClose={closeLines}
          caption={`${PAYROLL_SUMMARY_JOURNAL} lines, ${lines.drill.accounts.join(', ')}, ${formatDate(config.from)} - ${formatDate(config.to)}`}
          report={{ ...(lines.drill.accounts.length === 1 ? { account: lines.drill.accounts[0], accountName: '' } : {}), from: config.from, to: config.to, entity: config.entities.length === 1 ? config.entities[0] : '',
            ...(lines.drill.employees.length === 1 ? { party: { kind: 'employee', code: lines.drill.employees[0], name: full?.employees.find((e) => e.key === lines.drill.employees[0])?.name || lines.drill.employees[0] } } : {}),
            dims: { journals: [PAYROLL_SUMMARY_JOURNAL] } }} />
      )}
    </div>
  );
}

function Reconciliation({ check, unmapped, partial }) {
  const ok = check.reconciled;
  return (
    <div role="status" aria-label="Reconciliation to the payroll journal" style={{ marginTop: 10, borderTop: '1px solid var(--border-color)', paddingTop: 8, fontSize: '0.8rem', display: 'grid', gap: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: ok ? 'var(--ok-fg, #15803d)' : 'var(--warn-fg, #b45309)', fontWeight: 600 }}>
        {ok ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
        {ok ? `Reconciles to ${PAYROLL_SUMMARY_JOURNAL}: every line of the period is in a row.` : `Does not fully reconcile to ${PAYROLL_SUMMARY_JOURNAL} - see below.`}
      </div>
      <div style={{ color: 'var(--text-secondary)' }}>
        {PAYROLL_SUMMARY_JOURNAL} for the period and entities: debits <Amount value={check.debits} />, credits <Amount value={check.credits} />{check.balanced ? ' (balanced)' : ' - they differ'}.
        {partial ? ' The check covers every employee, not only the ones picked.' : ''}
      </div>
      {unmapped.length > 0 && (
        <div style={{ color: 'var(--text-secondary)' }}>
          Accounts posted in {PAYROLL_SUMMARY_JOURNAL} that no row reads (add them to the mapping): {unmapped.map((u) => `${u.account} ${u.title} (debits ${u.debit.toLocaleString('en-US', { minimumFractionDigits: 2 })}, credits ${u.credit.toLocaleString('en-US', { minimumFractionDigits: 2 })})`).join('; ')}.
        </div>
      )}
      <div style={{ color: 'var(--text-muted)', fontSize: '0.74rem' }}>
        Net Pay is Gross Pay less Taxes Withheld and Deductions From Net Pay, as QuickBooks prints it.
      </div>
    </div>
  );
}

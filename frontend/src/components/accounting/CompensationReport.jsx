import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import { ErrorBanner } from '../AsyncState';
import Amount, { formatAmount } from './Amount';
import { BarMore, ControlBar, control, ExportMenu, SyncButton } from './reportControls';
import { useTableSync } from './tableSync';
import { useFitHeight } from './tableHooks';
import { TableViewBar, ViewHead, useTableView, viewCells, viewTable } from './tableView';
import { downloadBlob } from './reportModel';
import { linesFile } from './linesExport';
import { formatDate } from '../../lib/datetime';
import { isStepUpRequired, StepUpNeeded } from '../../stepup/StepUp';
import {
  buildingHint, combine, drillSpec, emptyReason, groupRows, HOUR_COLUMNS, hoursOf, hoursRange, lineLabel, LINES, loadErrorMessage,
  monthsBetween, payTypeLabel, periodLabel, rateLabel, statementRows, statementTable, VIEWS, withHours,
} from './compensationModel';
import { COMP_REQUEST_TIMEOUT_MS } from './assumptions';
import { ColumnFilterRow, ColumnFiltersEmpty, useColumnFilters } from './columnFilters';
import { filterCellOf, filterColumnsOf } from './viewFilterColumns';
import SidePanel from './SidePanel';
import EntryDetail from './EntryDetail';
import { parkDrillReturn, requestReportDrill, takeDrillReturn } from './drill';
import { Avatar } from '../../tasks/components';

// Accounting > Reporting > Employee Compensation (Neil, 10/15: "We still need
// to make employee compensation report"). Rebuilt after the 10/27 call with
// Charmi (items 11-19): every figure is the Intacct LEDGER's - the lines that
// carry the employee - laid out like Intacct's Employee Compensation Report
// (Payroll Expenses, Benefits, Employer Payroll Taxes, Workers' Comp, Total
// Employer Expenses, and the employee's Deductions, Taxes Withheld and Net
// Pay). Hours stay Time Clock's and say so. One table (the lower "Payroll
// Expense on the Ledger" box is gone, item 16) with By Employee / By Company /
// By Department at the top; a name opens that person's full report on the
// right, with last year beside it (Open Full widens it); any amount opens the
// ledger lines behind it (item 17). Wages for everyone are payroll figures:
// the screen is only offered at the Full level on Accounting, and the backend
// also asks for a fresh identity check (step-up).

const MAX_MONTHS = 12;
const RETURN = 'compensation';
const card = { backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, boxShadow: 'var(--shadow-sm)' };
const th = { textAlign: 'left', padding: '6px 8px', fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-color)', verticalAlign: 'bottom' };
const thNum = { ...th, textAlign: 'right' };
const td = { padding: '4px 8px', borderBottom: '1px solid var(--border-color)', fontSize: '0.8rem', verticalAlign: 'top' };
const tdNum = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
// 10/23 meeting, item 02 (fix 10/24): the words sit beside the boxes, not above them, so the bar is one line.
const inline = { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', color: 'var(--text-secondary)' };
const muted = { color: 'var(--text-muted)', fontSize: '0.72rem' };
const note = { margin: 0, padding: '8px 12px 12px', fontSize: '0.72rem', color: 'var(--text-muted)', lineHeight: 1.5 };
const seg = (on) => ({ ...control, cursor: 'pointer', fontWeight: on ? 700 : 400, color: on ? 'var(--wk-brand, #2b45e1)' : 'var(--text-primary)', borderColor: on ? 'var(--wk-brand, #2b45e1)' : 'var(--border-color)' });
const plainBtn = { border: 'none', background: 'none', padding: 0, margin: 0, font: 'inherit', color: 'inherit', cursor: 'pointer', textAlign: 'inherit' };
const drillBtn = { ...plainBtn, textDecoration: 'underline', textDecorationColor: 'var(--border-color)', textUnderlineOffset: 3 };
const linkBtn = { ...plainBtn, color: 'var(--wk-brand, #2b45e1)', textDecoration: 'underline', textUnderlineOffset: 3 };

const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
// The year so far, as Intacct's "Year Ending 12/31" column reads it.
function defaultRange(now = new Date()) {
  return [monthKey(new Date(now.getFullYear(), 0, 1)), monthKey(new Date(now.getFullYear(), 11, 1))];
}
const hrs = (min) => hoursOf(min).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (n) => `${Number(n).toLocaleString('en-US', { maximumFractionDigits: 4 })}%`;

// The table's columns for the standard table view (10/23 meeting, item 01),
// one set per grouping. Hours compare as numbers, every line of the report as
// an amount; the detail lines start hidden (Columns shows them).
function compColumns(grouping) {
  const hours = HOUR_COLUMNS.map((c) => ({ key: c.key, label: c.label, type: 'number', total: true, value: (r) => hoursOf(r[c.key]), text: (r) => (r[c.key] ? hrs(r[c.key]) : '') }));
  const money = LINES.map((l) => ({ key: l.key, label: l.label, type: 'amount', total: true, off: !l.shown, value: (r) => Number(r.cur?.[l.key]) || 0, text: (r) => formatAmount(r.cur?.[l.key] || 0) }));
  if (grouping === 'people') {
    return [
      { key: 'name', label: 'Employee', text: (r) => r.name || '', exportAs: [{ label: 'Employee', width: 160, get: (r) => r.name }, { label: 'Employee ID', width: 80, get: (r) => r.code }] },
      { key: 'company', label: 'Company', text: (r) => r.companyName || '' },
      { key: 'department', label: 'Department', text: (r) => r.department || '' },
      { key: 'title', label: 'Title', off: true, text: (r) => r.title || '' },
      { key: 'payType', label: 'Pay Type (Time Clock)', off: true, text: (r) => payTypeLabel(r.payType) },
      { key: 'rate', label: 'Rate (Time Clock)', off: true, type: 'amount', value: (r) => Number(r.rate) || 0, text: (r) => (r.rate ? formatAmount(r.rate) : '') },
      ...hours, ...money,
    ];
  }
  const head = grouping === 'company' ? 'Company' : 'Department';
  return [
    { key: 'label', label: head, text: (r) => r.label || '' },
    { key: 'people', label: 'Employees', type: 'number', total: true, value: (r) => Number(r.people) || 0, text: (r) => String(r.people ?? '') },
    ...hours, ...money,
  ];
}

// 10/27: the boxes under the headings (columnFilters.jsx, as on MRE). The
// Employee box also finds the employee ID shown under the name.
const compFilterColumns = (columns) => filterColumnsOf(columns, { instead: { name: (r) => `${r.name || ''} ${r.code || ''}` } });
const filterCell = filterCellOf();

/** Item 18: "just like dot dot dot that is loading" - never the pale blocks, never a blank screen. */
function LoadingDots({ hint, compact = false }) {
  return (
    <div role="status" aria-live="polite" className={compact ? undefined : 'acct-stack-card acct-stack-main'}
      style={compact ? { padding: '14px 4px', textAlign: 'center' } : { ...card, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, minHeight: 220, padding: '40px 16px', textAlign: 'center' }}>
      <div style={{ fontSize: compact ? '0.84rem' : '0.95rem', fontWeight: 600, color: 'var(--text-primary)' }}>
        Loading
        <span aria-hidden="true">
          {[0, 1, 2].map((i) => <span key={i} style={{ display: 'inline-block', animation: 'nxl-breathe 1.2s ease-in-out infinite', animationDelay: `${i * 0.2}s` }}>.</span>)}
        </span>
      </div>
      {hint && <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', maxWidth: 520 }}>{hint}</div>}
    </div>
  );
}

/** An amount that opens the ledger lines behind it (item 17); nothing to open on a zero. */
function DrillAmount({ value, onOpen, label }) {
  if (!Number(value)) return <Amount value={0} zero="dash" />;
  return <button type="button" style={drillBtn} onClick={onOpen} title={`Open the ledger lines behind ${label}`} aria-label={`${label}: ${formatAmount(value)} - open the ledger lines`}><Amount value={value} /></button>;
}

export default function CompensationReport() {
  // Back from the ledger lines in Reports (drill.js): the screen as it was.
  const [parked] = useState(() => takeDrillReturn(RETURN));
  const [[from, to], setRange] = useState(() => parked?.asked || defaultRange());
  const [asked, setAsked] = useState(() => parked?.asked || defaultRange());
  const [view, setView] = useState(() => parked?.view || 'people');
  const [report, setReport] = useState(null);
  const [state, setState] = useState({ loading: true, error: '', stepUp: false });
  const [hours, setHours] = useState(null);
  const [hoursState, setHoursState] = useState({ loading: true, error: '' });
  const [panel, setPanel] = useState(null);
  const [busy, setBusy] = useState('');
  // Item 05 (fix 10/24): the screen is as tall as the window; the table scrolls in its own card (style.css .acct-fit-stack).
  const [box, setBox] = useState(null);
  const fit = useFitHeight(box);

  const span = monthsBetween(from, to);
  const rangeError = span < 1 ? 'The start month must be on or before the end month.' : span > MAX_MONTHS ? `Pick at most ${MAX_MONTHS} months.` : '';

  // The ledger figures (`quiet` = a Sync, 10/23 item 13: the table stays on screen while it reads).
  const loadReport = useCallback(([f, t], quiet = false) => {
    if (quiet) setState((s) => ({ ...s, syncing: true }));
    else { setState({ loading: true, error: '', stepUp: false }); setPanel(null); }
    return api.getCompensationReport(f, t)
      .then((d) => { setReport(d); setState({ loading: false, error: '', stepUp: false }); })
      .catch((e) => {
        const stepUp = isStepUpRequired(e);
        if (!quiet || stepUp) setReport(null);
        setState({ loading: false, error: stepUp ? '' : (e?.message || 'Could not read payroll from the ledger.'), stepUp });
      });
  }, []);
  // Time Clock's hours for the months that have started - the slow read, so it
  // never holds the ledger figures back. One attempt (api.js noRetry).
  const loadHours = useCallback((range, quiet = false) => {
    const hr = hoursRange(range);
    if (!hr) { setHours({ people: [] }); setHoursState({ loading: false, error: '' }); return Promise.resolve(); }
    if (quiet) setHoursState((s) => ({ ...s, syncing: true }));
    else { setHours(null); setHoursState({ loading: true, error: '' }); }
    return api.getCompensationPeople(hr[0], hr[1], { timeoutMs: COMP_REQUEST_TIMEOUT_MS })
      .then((d) => { setHours(d); setHoursState({ loading: false, error: '' }); })
      .catch((e) => setHoursState({ loading: false, error: isStepUpRequired(e) ? '' : loadErrorMessage(e, monthsBetween(hr[0], hr[1])) }));
  }, []);
  useEffect(() => { loadReport(asked); loadHours(asked); }, [asked, loadReport, loadHours]);
  // Sync reads the ledger fresh (a correction made in Intacct shows, item 11) and the hours again.
  const sync = useTableSync(useCallback(() => Promise.all([loadReport(asked, true), loadHours(asked, true)]), [asked, loadReport, loadHours]));
  const reloadAll = () => { loadReport(asked); loadHours(asked); };

  const run = () => { if (!rangeError) setAsked([from, to]); };
  const periods = report ? { cur: { from: report.from, to: report.to }, prior: report.prior || { from: '', to: '' } } : null;
  const curLabel = report ? periodLabel(report.from, report.to) : '';
  const priorLabel = report?.prior ? periodLabel(report.prior.from, report.prior.to) : '';
  const merged = useMemo(() => withHours(report?.people, hours), [report, hours]);
  const all = useMemo(() => (view === 'people' ? merged.rows : groupRows(merged.rows, view)), [merged, view]);
  // Item 01: the standard view over the rows of the grouping picked (each grouping keeps its own); the totals follow it.
  const columns = useMemo(() => compColumns(view), [view]);
  const boxes = useMemo(() => compFilterColumns(columns), [columns]);
  const filters = useColumnFilters(all, boxes);
  const tv = useTableView(`comp-ledger-${view}`, columns, filters.rows);
  const rows = tv.rows;
  const narrowed = !!tv.count || filters.filtering;
  const total = useMemo(() => combine(rows), [rows]);
  const pickView = (k) => { if (k !== view) filters.clear(); setView(k); };
  const hoursPending = hoursState.loading && !hours;

  const exportFile = async (key, build, format) => {
    setBusy(`${key}-${format}`);
    try {
      const file = await linesFile(build(), format);
      downloadBlob(file.name, file);
    } finally { setBusy(''); }
  };
  const exportItems = (key, build, disabled) => [
    { key: 'excel', label: 'Excel', hint: 'Workbook with the totals as formulas', onPick: () => exportFile(key, build, 'excel'), busy: busy === `${key}-excel`, disabled },
    { key: 'pdf', label: 'PDF', hint: 'Landscape, ready to print', onPick: () => exportFile(key, build, 'pdf'), busy: busy === `${key}-pdf`, disabled },
    { key: 'csv', label: 'CSV', onPick: () => exportFile(key, build, 'csv'), busy: busy === `${key}-csv`, disabled },
  ];
  // Exactly what the view leaves (no Personal Hours anywhere, item 15).
  const tableExport = () => viewTable(rows, tv.columns, {
    title: `Compensation - ${VIEWS.find((v) => v.key === view)?.label || ''}`,
    subtitle: `${curLabel}  ·  From the Intacct ledger; hours from Time Clock`, period: curLabel.replace(/\//g, '-'),
  });

  const nameOf = (r) => r.name || r.label || 'Total';
  const openStatement = (r, name = nameOf(r)) => setPanel({ kind: 'statement', subject: r, name, code: r.code || '' });
  const openLines = (subject, name, key, period, account = null, back = null) => setPanel({ kind: 'lines', subject, name, key, period, account, back });
  // A drill all the way to Reports' ledger lines; Back there returns here as it is (drill.js).
  const openInReports = ({ account, accountName, subject, name, period }) => {
    parkDrillReturn(RETURN, { asked, view });
    const codes = subject.codes || [];
    requestReportDrill({
      account, accountName, from: periods[period].from, to: periods[period].to,
      ...(codes.length === 1 ? { party: { kind: 'employee', code: codes[0], name } } : { dims: { employee: codes } }),
      back: { label: 'Back to Compensation', sub: RETURN },
    });
  };
  const moneyCells = (r, name) => Object.fromEntries(LINES.map((l) => [l.key, (
    <td style={{ ...tdNum, ...(l.parts ? { fontWeight: 600 } : null) }}>
      <DrillAmount value={r.cur?.[l.key]} label={`${l.label} for ${name}`} onOpen={() => openLines(r, name, l.key, 'cur')} />
    </td>
  )]));
  const hourCells = (r, strong = false) => Object.fromEntries(HOUR_COLUMNS.map((c) => [c.key, (
    <td style={{ ...tdNum, ...(strong ? { fontWeight: 700 } : null) }} title="From Time Clock's payroll cards">{hoursPending ? <span style={muted}>...</span> : r[c.key] ? hrs(r[c.key]) : '-'}</td>
  )]));

  return (
    <div ref={setBox} className="acct-fit-stack" data-testid="compensation-stack" style={fit}>
      <ControlBar style={{ ...card, padding: '8px 10px' }}>
        <span style={inline}>
          <input type="month" value={from} onChange={(e) => setRange([e.target.value, to])} style={control} aria-label="From Month" title="From Month" />
          to
          <input type="month" value={to} onChange={(e) => setRange([from, e.target.value])} style={control} aria-label="To Month" title="To Month" />
        </span>
        <button type="button" className="primary-btn" onClick={run} disabled={!!rangeError || state.loading} style={{ height: 30, fontSize: '0.78rem' }}>Run Report</button>
        <BarMore level={1} active={view !== 'people' ? 1 : 0}>
        <div style={{ display: 'flex', gap: 4 }} role="group" aria-label="View">
          {VIEWS.map((v) => <button key={v.key} type="button" style={seg(view === v.key)} aria-pressed={view === v.key} onClick={() => pickView(v.key)}>{v.label}</button>)}
        </div>
        </BarMore>
        <TableViewBar key={view} view={tv} />
        {/* Round 3 (item 02): on a short row Sync is the fourth to move into More, Export the fifth. */}
        <div className="acct-bar-end">
          <BarMore level={4}>
          <SyncButton onSync={sync.sync} busy={!!state.syncing || !!hoursState.syncing} syncedAt={sync.syncedAt} what="Compensation" />
          </BarMore>
          <BarMore level={5}>
          <ExportMenu disabled={!report || !rows.length} items={exportItems('people', tableExport, !report)} />
          </BarMore>
        </div>
        {/* Its own line on purpose: the bar does not count it as wrapping. */}
        {rangeError && <div className="acct-bar-break" style={{ width: '100%', fontSize: '0.75rem', color: '#b91c1c' }}>{rangeError}</div>}
      </ControlBar>

      {state.stepUp ? (
        <StepUpNeeded label="Payroll, benefits and taxes by person." onVerified={reloadAll} />
      ) : state.loading ? (
        <LoadingDots hint={buildingHint(monthsBetween(asked[0], asked[1]))} />
      ) : state.error ? (
        <ErrorBanner message={state.error} onRetry={reloadAll} />
      ) : report && !report.people?.length ? (
        <div style={{ ...card, padding: 24, textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.86rem' }}>{emptyReason(report)}</div>
      ) : report && (
        <div className="acct-stack-card acct-stack-main" style={card}>
          <div style={{ padding: '10px 12px 4px', display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'baseline' }}>
            <h3 style={{ margin: 0, fontSize: '0.95rem' }}>Compensation</h3>
            <span style={muted}>{curLabel} · {report.people.length} {report.people.length === 1 ? 'employee' : 'employees'}{narrowed ? ` · ${rows.length} of ${all.length} rows pass the filters` : ''}</span>
            {hoursPending && <span role="status" style={muted}>Loading Time Clock hours... {buildingHint(monthsBetween(asked[0], asked[1]))}</span>}
          </div>
          {hoursState.error && (
            <div role="alert" style={{ margin: '0 12px 6px', fontSize: '0.76rem', color: '#b45309' }}>
              Time Clock hours could not be built: {hoursState.error}{' '}
              <button type="button" style={linkBtn} onClick={() => loadHours(asked)}>Try Again</button>
            </div>
          )}
          {/* Item 05 (round 3): the heading block pins as one piece (acct-sticky-head) -
              each heading keeps position: relative for its drag handle (ViewHead's ColumnResizer:
              widths are kept per person, item 17). 10/27: the filter boxes are in that block. */}
          <table className="acct-sticky-head acct-comp" style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead>
              <tr>
                {tv.columns.map((c) => {
                  const w = tv.manualWidth(c.key);
                  return <ViewHead key={c.key} view={tv} col={c} aria-label={c.label} style={{ ...(c.type ? thNum : th), position: 'relative', ...(w ? { width: w, minWidth: w, maxWidth: w } : null) }} />;
                })}
              </tr>
              <ColumnFilterRow columns={tv.columns} filterColumns={boxes} typed={filters.typed} onChange={filters.setFilter} cellProps={filterCell} />
            </thead>
            <tbody>
              {!rows.length && <ColumnFiltersEmpty colSpan={tv.columns.length} onClear={filters.clear} />}
              {rows.map((r) => (
                <tr key={view === 'people' ? r.code : r.key || 'none'}>
                  {viewCells(tv, {
                    name: (
                      <td style={td}>
                        <button type="button" style={{ ...plainBtn, display: 'inline-flex', alignItems: 'center', gap: 8 }} onClick={() => openStatement(r)} title={`Open ${r.name}'s compensation report`}>
                          <Avatar email={r.email} name={r.name} size={26} card={false} />
                          <span><strong>{r.name}</strong><div style={muted}>{r.code}</div></span>
                        </button>
                      </td>
                    ),
                    company: <td style={td}>{r.companyName || <span style={muted}>No Company</span>}</td>,
                    department: <td style={td}>{r.department || <span style={muted}>-</span>}</td>,
                    title: <td style={td}>{r.title || <span style={muted}>-</span>}</td>,
                    payType: <td style={td}>{payTypeLabel(r.payType) || <span style={muted}>-</span>}</td>,
                    rate: (
                      <td style={tdNum} title={r.rateChanged ? 'The rate changed in these months; the latest is shown.' : rateLabel(r)}>
                        <Amount value={r.rate} zero="dash" />{r.currency && r.currency !== 'USD' ? ` ${r.currency}` : ''}{r.rateChanged ? ' *' : ''}
                        <div style={muted}>{rateLabel(r)}</div>
                      </td>
                    ),
                    label: <td style={td}><button type="button" style={{ ...plainBtn, fontWeight: 700 }} onClick={() => openStatement(r)} title={`Open the compensation report for ${r.label}`}>{r.label}</button></td>,
                    people: <td style={tdNum}>{r.people}</td>,
                    ...hourCells(r),
                    ...moneyCells(r, nameOf(r)),
                  })}
                </tr>
              ))}
            </tbody>
            {!!rows.length && (
              <tfoot>
                <tr>
                  {viewCells(tv, {
                    [view === 'people' ? 'name' : 'label']: <td style={{ ...td, fontWeight: 700 }}><button type="button" style={{ ...plainBtn, fontWeight: 700 }} onClick={() => openStatement(total, 'Total')}>Total</button></td>,
                    people: <td style={{ ...tdNum, fontWeight: 700 }}>{total.people}</td>,
                    ...hourCells(total, true),
                    ...Object.fromEntries(LINES.map((l) => [l.key, (
                      <td style={{ ...tdNum, fontWeight: 700 }}><DrillAmount value={total.cur?.[l.key]} label={`${l.label}, total`} onOpen={() => openLines(total, 'Total', l.key, 'cur')} /></td>
                    )])),
                  }, () => <td style={td} />)}
                </tr>
              </tfoot>
            )}
          </table>
          <p style={note}>
            Payroll, benefits and taxes are the Intacct ledger&apos;s lines that carry the employee; Sync reads them again, so a correction made in Intacct shows here.
            Every other expense line with the employee on it counts under Other Benefits, by account. Deductions and taxes withheld are taken out of pay, so they show as negatives.
            Workers&apos; Comp is the rate on the person&apos;s pay setup (People &gt; Pay, Benefits &amp; Bank) times Bonus plus Salaried / Hourly Payroll, year by year.
            Hours are Time Clock&apos;s payroll cards. Click a name for the full report with last year beside it; click any amount for the ledger lines behind it.
            {report.notInPeople ? ` ${report.notInPeople} ${report.notInPeople === 1 ? 'employee on the ledger has' : 'employees on the ledger have'} no matching employee ID in People, so they show the ledger's name and no company or department.` : ''}
            {merged.timeClockOnly.length ? ` Time Clock hours but nothing on the ledger: ${merged.timeClockOnly.join(', ')}.` : ''}
          </p>
        </div>
      )}

      {panel?.kind === 'statement' && report && (
        <StatementPanel key={`s-${panel.name}`} panel={panel} curLabel={curLabel} priorLabel={priorLabel} onClose={() => setPanel(null)}
          onLines={(key, period, account) => openLines(panel.subject, panel.name, key, period, account, panel)}
          exportItems={(build) => exportItems('statement', build, false)} />
      )}
      {panel?.kind === 'lines' && report && (
        <LinesPanel key={`l-${panel.name}-${panel.key}-${panel.period}-${panel.account || ''}`} panel={panel} periods={periods}
          onClose={() => setPanel(null)} onBack={panel.back ? () => setPanel(panel.back) : null} onReports={openInReports} />
      )}
    </div>
  );
}

/** Close on Escape (SidePanel leaves Escape to its caller) - unless a popup above it is open. */
function useEscape(onClose, off = false) {
  useEffect(() => {
    if (off) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, off]);
}

/** One person's report, Intacct's layout, last year beside the period asked (item 13). */
function StatementPanel({ panel, curLabel, priorLabel, onClose, onLines, exportItems }) {
  useEscape(onClose);
  const { subject, name, code } = panel;
  const rows = statementRows(subject);
  const caption = [subject.companyName, subject.department, subject.title].filter(Boolean).join(' · ') || (subject.people > 1 ? `${subject.people} employees` : '');
  const cell = (r, period) => {
    if (r.kind === 'heading') return <td style={tdNum} />;
    if (r.kind === 'hours') return <td style={tdNum} title="From Time Clock's payroll cards, for the period asked">{period === 'cur' && r.cur != null ? (r.cur ? r.cur.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '-') : <span style={muted}>-</span>}</td>;
    const strong = r.kind === 'total';
    return (
      <td style={{ ...tdNum, ...(strong ? { fontWeight: 700 } : null) }}>
        <DrillAmount value={r[period]} label={`${r.label} for ${name}, ${period === 'cur' ? curLabel : priorLabel}`} onOpen={() => onLines(r.key, period, r.kind === 'account' ? r.account : null)} />
      </td>
    );
  };
  return (
    <SidePanel label="Employee Compensation Report" title={`${name}${code ? ` (${code})` : ''}`} caption={caption || 'Employee Compensation Report'} onClose={onClose}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ ...muted, flex: 1 }}>Employee Compensation Report - from the Intacct ledger; hours from Time Clock. Click an amount for its ledger lines.</span>
        <ExportMenu items={exportItems(() => statementTable(subject, { name: `${name}${code ? ` (${code})` : ''}`, curLabel, priorLabel }))} />
      </div>
      <div style={{ ...card, overflowX: 'auto' }}>
        <table aria-label={`Employee Compensation Report - ${name}`} style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr><th style={th} /><th style={thNum}>{priorLabel}</th><th style={thNum}>{curLabel}</th></tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.kind}-${r.key || r.label}-${r.account || i}`} style={r.strong ? { background: 'var(--bg-secondary)' } : undefined}>
                {r.kind === 'heading'
                  ? <td colSpan={3} style={{ ...td, fontWeight: 700, color: 'var(--wk-brand, #2b45e1)', paddingTop: 10 }}>{r.label}</td>
                  : (
                    <>
                      <td style={{ ...td, paddingLeft: r.kind === 'account' ? 32 : r.kind === 'total' ? 8 : 18, fontWeight: r.kind === 'total' ? 700 : 400, ...(r.kind === 'account' ? { color: 'var(--text-secondary)' } : null) }}>{r.label}</td>
                      {cell(r, 'prior')}
                      {cell(r, 'cur')}
                    </>
                  )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <WorkersCompNote subject={subject} />
    </SidePanel>
  );
}

/** How Workers' Comp was worked out: the rate in force each year x that year's gross wages (item 14). */
function WorkersCompNote({ subject, period = 'cur' }) {
  const parts = subject.workersComp?.[period] || [];
  if (!parts.length) {
    const none = subject.codes?.length === 1 && subject.hasRate === false;
    return <p style={{ ...muted, margin: 0 }}>{none ? "No workers' comp rate is set for this person. HR or payroll adds it on People > Pay, Benefits & Bank." : "Workers' Comp: no rate in force for these months."}</p>;
  }
  return (
    <div style={{ ...muted, display: 'grid', gap: 2 }}>
      <strong>Workers&apos; Comp</strong>
      {parts.map((w, i) => (
        <span key={`${w.name || ''}-${w.year}-${i}`}>
          {w.name && subject.codes?.length > 1 ? `${w.name}: ` : ''}{w.year}: {pct(w.ratePct)} of {formatAmount(w.gross)} gross wages = {formatAmount(w.amount)}{w.rateYear !== w.year ? ` (the rate set for ${w.rateYear})` : ''}
        </span>
      ))}
    </div>
  );
}

const NO_LINES = { lines: [], total: 0 };

/** The ledger lines behind one figure: date, entry, account, vendor, memo, amount (item 17). */
function LinesPanel({ panel, periods, onClose, onBack, onReports }) {
  const { subject, name, key, period, account } = panel;
  const range = periods[period];
  const spec = useMemo(() => drillSpec(subject, key, period, account), [subject, key, period, account]);
  // The panel is keyed by the figure, so another figure starts a fresh read.
  const nothing = !spec.accounts.length || !spec.employees.length;
  const [fetched, setFetched] = useState(null);
  const [error, setError] = useState('');
  const [entry, setEntry] = useState(null);
  useEscape(onClose, !!entry);
  const specKey = JSON.stringify(spec);
  useEffect(() => {
    if (nothing) return undefined;
    let alive = true;
    api.getCompensationLines({ from: range.from, to: range.to, employees: spec.employees, accounts: spec.accounts })
      .then((d) => { if (alive) setFetched(d); })
      .catch((e) => { if (alive) setError(e?.message || 'Could not read the ledger lines.'); });
    return () => { alive = false; };
  }, [specKey, range.from, range.to]); // eslint-disable-line react-hooks/exhaustive-deps
  const data = nothing ? NO_LINES : fetched;
  const accountRow = account ? (subject.accounts?.[period]?.[key] || []).filter((a) => a.account === account) : [];
  const figure = account ? accountRow.reduce((s, a) => s + a.amount, 0) : Number(subject[period]?.[key]) || 0;
  const wc = key === 'workersComp';
  const title = `${lineLabel(key)}${account ? ` - ${account} ${accountRow[0]?.title || ''}`.trimEnd() : ''}`;
  const lines = data?.lines || [];
  const off = data && !wc && Math.abs((Number(data.total) || 0) - figure) > 0.005;
  const accountsShown = [...new Map(lines.map((l) => [l.account, l.accountName])).entries()];
  return (
    <SidePanel label="Ledger Lines" title={title} caption={`${name} · ${periodLabel(range.from, range.to)} · ${formatAmount(figure)}`} onClose={onClose}>
      {onBack && <div><button type="button" style={linkBtn} onClick={onBack}>Back to {name}&apos;s report</button></div>}
      {wc && <WorkersCompNote subject={subject} period={period} />}
      {wc && <div style={{ ...muted, fontWeight: 600 }}>The gross wages it is worked out on - the Bonus and Salaried / Hourly Payroll lines:</div>}
      {error ? <ErrorBanner message={error} /> : !data ? <LoadingDots compact hint="Reading the ledger lines." /> : (
        <div style={{ ...card, overflowX: 'auto' }}>
          <table aria-label={`Ledger lines - ${title}`} style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead>
              <tr><th style={th}>Date</th><th style={th}>Entry</th><th style={th}>Account</th><th style={th}>Vendor</th><th style={th}>Memo</th><th style={thNum}>Amount</th></tr>
            </thead>
            <tbody>
              {!lines.length && <tr><td colSpan={6} style={{ ...td, padding: 14, color: 'var(--text-secondary)' }}>No ledger lines.</td></tr>}
              {lines.map((l, i) => (
                <tr key={`${l.id || i}-${l.account}`}>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>{formatDate(l.date)}</td>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>{l.entryId ? <button type="button" style={linkBtn} onClick={() => setEntry({ id: l.entryId, no: l.entryNo })} title="Open this journal entry">{l.entryNo || 'Open'}</button> : l.entryNo}</td>
                  <td style={td}><span className="acct-code">{l.account}</span> {l.accountName}</td>
                  <td style={td}>{l.vendor || <span style={muted}>-</span>}</td>
                  <td style={td}>{l.memo || l.description || <span style={muted}>-</span>}</td>
                  <td style={tdNum}><Amount value={l.amount} /></td>
                </tr>
              ))}
            </tbody>
            {!!lines.length && (
              <tfoot><tr><td colSpan={5} style={{ ...td, fontWeight: 700 }}>Total - {lines.length} {lines.length === 1 ? 'line' : 'lines'}</td><td style={{ ...tdNum, fontWeight: 700 }}><Amount value={data.total} /></td></tr></tfoot>
            )}
          </table>
        </div>
      )}
      {data?.truncated && <p style={{ ...muted, margin: 0 }}>More lines than shown here - open the account in Reports for every line.</p>}
      {off && <p role="note" style={{ ...muted, margin: 0, color: '#b45309' }}>These lines add up to {formatAmount(data.total)}; the report shows {formatAmount(figure)}. The ledger may have changed since the report was read - Sync reads it again.</p>}
      {!!accountsShown.length && (
        <div style={{ ...muted, display: 'flex', flexWrap: 'wrap', gap: '4px 12px', alignItems: 'baseline' }}>
          <span>Open in Reports:</span>
          {accountsShown.map(([acct, accountName]) => (
            <button key={acct} type="button" style={linkBtn} onClick={() => onReports({ account: acct, accountName, subject, name, period })}>{acct} {accountName}</button>
          ))}
        </div>
      )}
      {entry && <EntryDetail entryId={entry.id} entryNo={entry.no} onClose={() => setEntry(null)} />}
    </SidePanel>
  );
}

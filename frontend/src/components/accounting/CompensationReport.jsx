import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Printer } from 'lucide-react';
import { api } from '../../api';
import { ErrorBanner } from '../AsyncState';
import Amount, { formatAmount } from './Amount';
import { BarMore, ColumnResizer, ControlBar, control, CustomizeButton, ExportMenu, SyncButton, Toggle } from './reportControls';
import { useAccountingPrefs } from './prefs';
import { useTableSync } from './tableSync';
import { useColumnWidths, useFitHeight } from './tableHooks';
import { TableViewBar, ViewHead, useTableView, viewCells, viewTable } from './tableView';
import { downloadBlob } from './reportModel';
import { linesFile } from './linesExport';
import { formatDate } from '../../lib/datetime';
import { isStepUpRequired, StepUpNeeded } from '../../stepup/StepUp';
import {
  buildingHint, combine, drillSpec, emptyReason, groupRows, HOUR_COLUMNS, hoursOf, hoursRange, lineLabel, LINES, loadErrorMessage,
  monthsBetween, payTypeLabel, periodLabel, rateLabel, statementRows, statementTable, visibleRows, VIEWS, withHours,
} from './compensationModel';
import { COMP_REQUEST_TIMEOUT_MS } from './assumptions';
import { ColumnFilterRow, ColumnFiltersEmpty, useColumnFilters } from './columnFilters';
import { filterCellOf, filterColumnsOf } from './viewFilterColumns';
import SidePanel from './SidePanel';
import EntryDetail from './EntryDetail';
import { parkDrillReturn, requestReportDrill, takeDrillReturn } from './drill';
import { Avatar, DateField } from '../../tasks/components';
import { formatHM, formatHoursHM } from '../../lib/hoursText';
import { WarnMark } from './warnMark';

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
const th = { textAlign: 'left', padding: '6px 8px', fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-color)', verticalAlign: 'bottom' };
const thNum = { ...th, textAlign: 'right' };
const td = { padding: '4px 8px', borderBottom: '1px solid var(--border-color)', fontSize: 13, verticalAlign: 'top' };
const tdNum = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
// 10/23 meeting, item 02 (fix 10/24): the words sit beside the boxes, not above them, so the bar is one line.
const inline = { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text-secondary)' };
const muted = { color: 'var(--text-muted)', fontSize: 12 };
const note = { margin: 0, padding: '8px 12px 12px', fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 };
const seg = (on) => ({ ...control, cursor: 'pointer', fontWeight: on ? 700 : 400, color: on ? 'var(--wk-brand, #2b45e1)' : 'var(--text-primary)', borderColor: on ? 'var(--wk-brand, #2b45e1)' : 'var(--border-color)' });
const plainBtn = { border: 'none', background: 'none', padding: 0, margin: 0, font: 'inherit', color: 'inherit', cursor: 'pointer', textAlign: 'inherit' };
const drillBtn = { ...plainBtn, textDecoration: 'underline', textDecorationColor: 'var(--border-color)', textUnderlineOffset: 3 };
const linkBtn = { ...plainBtn, color: 'var(--wk-brand, #2b45e1)', textDecoration: 'underline', textUnderlineOffset: 3 };

const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
// The year so far, as Intacct's "Year Ending 12/31" column reads it.
function defaultRange(now = new Date()) {
  return [monthKey(new Date(now.getFullYear(), 0, 1)), monthKey(new Date(now.getFullYear(), 11, 1))];
}
// Hours on screen read as H:MM (Neil, 11/04/2026: no decimal hours); the
// column's `value` and the exports keep the number.
const hrs = (min) => formatHM(min);
const pct = (n) => `${Number(n).toLocaleString('en-US', { maximumFractionDigits: 4 })}%`;

// The table's columns for the standard table view (10/23 meeting, item 01),
// one set per grouping. Hours compare as numbers, every line of the report as
// an amount; the detail lines start hidden (Columns shows them).
function compColumns(grouping) {
  const hours = HOUR_COLUMNS.map((c) => ({ key: c.key, label: c.label, type: 'number', total: true, value: (r) => hoursOf(r[c.key]), text: (r) => (r[c.key] ? hrs(r[c.key]) : '') }));
  const money = LINES.map((l) => ({ key: l.key, label: l.label, type: 'amount', total: true, off: !l.shown, value: (r) => Number(r.cur?.[l.key]) || 0, text: (r) => formatAmount(r.cur?.[l.key] || 0) }));
  if (grouping === 'people') {
    return [
      { key: 'name', label: 'Employee', fixed: true, text: (r) => r.name || '', exportAs: [{ label: 'Employee', width: 160, get: (r) => r.name }, { label: 'Employee ID', width: 80, get: (r) => r.code }] },
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
    { key: 'label', label: head, fixed: true, text: (r) => r.label || '' },
    { key: 'people', label: 'Employees', type: 'number', total: true, value: (r) => Number(r.people) || 0, text: (r) => String(r.people ?? '') },
    ...hours, ...money,
  ];
}

// 10/27: the boxes under the headings (columnFilters.jsx, as on MRE). The
// Employee box also finds the employee ID shown under the name.
const compFilterColumns = (columns) => filterColumnsOf(columns, { instead: { name: (r) => `${r.name || ''} ${r.code || ''}` } });
// The first column (the name) stays put while the amounts scroll sideways.
// Its background comes from the .acct-comp row rules in style.css (banding
// and hover, Charmi 10/30), which paint every cell solid so the amounts
// scroll UNDER the pinned name rather than through it.
const PINNED = new Set(['name', 'label']);
const pin = { position: 'sticky', left: 0, zIndex: 1 };
const filterCell = (col) => filterCellOf(PINNED.has(col.key) ? col.key : '')(col);

/** Item 18: "just like dot dot dot that is loading" - never the pale blocks, never a blank screen. */
function LoadingDots({ hint, compact = false }) {
  return (
    <div role="status" aria-live="polite" className={compact ? undefined : 'acct-stack-card acct-stack-main'}
      style={compact ? { padding: '14px 4px', textAlign: 'center' } : { ...card, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, minHeight: 220, padding: '40px 16px', textAlign: 'center' }}>
      <div style={{ fontSize: compact ? 13 : 15, fontWeight: 600, color: 'var(--text-primary)' }}>
        Loading
        <span aria-hidden="true">
          {[0, 1, 2].map((i) => <span key={i} style={{ display: 'inline-block', animation: 'nxl-breathe 1.2s ease-in-out infinite', animationDelay: `${i * 0.2}s` }}>.</span>)}
        </span>
      </div>
      {hint && <div style={{ fontSize: 13, color: 'var(--text-secondary)', maxWidth: 520 }}>{hint}</div>}
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

  // 10/30 (Neil: "What does this RUN REPORT do? If nothing then please take
  // it out"): no button - a valid range runs itself after a beat, so picking
  // both months costs one read, not two.
  useEffect(() => {
    if (rangeError || (from === asked[0] && to === asked[1])) return undefined;
    const t = setTimeout(() => setAsked([from, to]), 600);
    return () => clearTimeout(t);
  }, [from, to, rangeError, asked]);
  const periods = report ? { cur: { from: report.from, to: report.to }, prior: report.prior || { from: '', to: '' } } : null;
  const curLabel = report ? periodLabel(report.from, report.to) : '';
  const priorLabel = report?.prior ? periodLabel(report.prior.from, report.prior.to) : '';
  // Charmi / Neil, Teams 11/05/2026: inactive employees are left out unless
  // Customize > Show Inactive Employees is on (off by default, kept per person).
  const [prefs, setPrefs] = useAccountingPrefs();
  const showInactive = !!prefs.compShowInactive;
  const merged = useMemo(() => withHours(report?.people, hours), [report, hours]);
  const kept = useMemo(() => (showInactive ? merged.rows : merged.rows.filter((r) => r.active !== false)), [merged, showInactive]);
  const hiddenInactive = merged.rows.length - kept.length;
  const all = useMemo(() => (view === 'people' ? kept : groupRows(kept, view)), [kept, view]);
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
  // Charmi, Teams 11/05/2026 ("Can we have drill down options here as well"):
  // a person's hours open the days behind them, from their Time Sheet.
  const hourCells = (r, strong = false) => Object.fromEntries(HOUR_COLUMNS.map((c) => [c.key, (
    <td style={{ ...tdNum, ...(strong ? { fontWeight: 700 } : null) }} title="From Time Clock's payroll cards">
      {hoursPending ? <span style={muted}>...</span> : !r[c.key] ? '-' : r.email && view === 'people'
        ? <button type="button" style={drillBtn} onClick={() => setPanel({ kind: 'hours', subject: r, name: r.name, key: c.key })} title={`Open the days behind ${r.name}'s ${c.short} hours`}>{hrs(r[c.key])}</button>
        : hrs(r[c.key])}
    </td>
  )]));

  return (
    <>
    <div ref={setBox} className="acct-fit-stack" data-testid="compensation-stack" style={fit}>
      <ControlBar style={{ ...card, padding: '8px 10px' }}>
        <span style={inline}>
          <span style={{ width: 130 }}><DateField monthOnly value={from} onChange={(v) => v && setRange([v, to])} title="From Month" style={{ ...control, width: '100%' }} /></span>
          to
          <span style={{ width: 130 }}><DateField monthOnly value={to} onChange={(v) => v && setRange([from, v])} title="To Month" style={{ ...control, width: '100%' }} /></span>
        </span>
        <BarMore level={1} active={view !== 'people' ? 1 : 0}>
        <div style={{ display: 'flex', gap: 4 }} role="group" aria-label="View">
          {VIEWS.map((v) => <button key={v.key} type="button" style={seg(view === v.key)} aria-pressed={view === v.key} onClick={() => pickView(v.key)}>{v.label}</button>)}
        </div>
        </BarMore>
        <TableViewBar key={view} view={tv} />
        <BarMore level={2} active={showInactive ? 1 : 0}>
          <CustomizeButton active={showInactive}>
            <Toggle checked={showInactive} onChange={(v) => setPrefs({ compShowInactive: v })} label="Show Inactive Employees"
              hint="People marked inactive in People are left out until this is on." />
          </CustomizeButton>
        </BarMore>
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
        <div style={{ ...card, padding: 24, textAlign: 'center', color: 'var(--text-secondary)', fontSize: 14 }}>{emptyReason(report)}</div>
      ) : report && (
        <div className="acct-stack-card acct-stack-main" style={card}>
          <div style={{ padding: '10px 12px 4px', display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'baseline' }}>
            <h3 style={{ margin: 0, fontSize: 15 }}>Compensation</h3>
            <span style={muted}>{curLabel} · {kept.length} {kept.length === 1 ? 'employee' : 'employees'}{hiddenInactive ? ` (${hiddenInactive} inactive hidden)` : ''}{narrowed ? ` · ${rows.length} of ${all.length} rows pass the filters` : ''}</span>
            {hoursPending && <span role="status" style={muted}>Loading Time Clock hours... {buildingHint(monthsBetween(asked[0], asked[1]))}</span>}
          </div>
          {hoursState.error && (
            <div role="alert" style={{ margin: '0 12px 6px', fontSize: 12, color: 'var(--warn-fg)' }}>
              <WarnMark />
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
                  // Headings wrap (a dozen amounts at 1440): each column is as wide as its filter box, not its title.
                  return (
                    <ViewHead key={c.key} view={tv} col={c} aria-label={c.label} className={PINNED.has(c.key) ? 'acct-head' : undefined}
                      style={{ ...(c.type ? thNum : th), position: PINNED.has(c.key) ? 'sticky' : 'relative', ...(w ? { width: w, minWidth: w, maxWidth: w } : null) }}>
                      <span style={{ whiteSpace: 'normal' }}>{c.label}</span>
                    </ViewHead>
                  );
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
                      <td style={{ ...td, ...pin }}>
                        <button type="button" style={{ ...plainBtn, display: 'inline-flex', alignItems: 'center', gap: 8 }} onClick={() => openStatement(r)} title={`Open ${r.name}'s compensation report`}>
                          <Avatar email={r.email} name={r.name} size={26} card={false} />
                          <span><strong>{r.name}</strong><div style={muted}>{r.code}</div>
                            {r.nameMismatch && <div style={{ ...muted, color: 'var(--warn-fg)' }} title={`In People, ${r.code} is on ${r.nameMismatch}'s record. Fix the employee code on People > Job.`}><WarnMark />People has {r.code} on {r.nameMismatch}</div>}
                          </span>
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
                    label: <td style={{ ...td, ...pin }}><button type="button" style={{ ...plainBtn, fontWeight: 700 }} onClick={() => openStatement(r)} title={`Open the compensation report for ${r.label}`}>{r.label}</button></td>,
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
                    [view === 'people' ? 'name' : 'label']: <td style={{ ...td, ...pin, fontWeight: 700 }}><button type="button" style={{ ...plainBtn, fontWeight: 700 }} onClick={() => openStatement(total, 'Total')}>Total</button></td>,
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
    </div>
    {/* Beside the stack, not in it: the stack lets each child grow to its content
        (.acct-fit-stack > *), which stretched the fixed panel past the window so a
        long report could not scroll (1440 check, 10/28). */}
    {panel?.kind === 'statement' && report && (
      <StatementPanel key={`s-${panel.name}`} panel={panel} curLabel={curLabel} priorLabel={priorLabel} onClose={() => setPanel(null)}
        onLines={(key, period, account) => openLines(panel.subject, panel.name, key, period, account, panel)}
        exportItems={(build) => exportItems('statement', build, false)} />
    )}
    {panel?.kind === 'hours' && (
      <HoursPanel key={`h-${panel.subject.email}-${panel.key}`} panel={panel} range={hoursRange(asked)} onClose={() => setPanel(null)} />
    )}
    {panel?.kind === 'lines' && report && (
      <LedgerLinesPanel key={`l-${panel.name}-${panel.key}-${panel.period}-${panel.account || ''}`} panel={panel} periods={periods}
        onClose={() => setPanel(null)} onBack={panel.back ? () => setPanel(panel.back) : null} onReports={openInReports} />
    )}
    </>
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

/** Print a built file (the statement's PDF) from a hidden frame; a blocked frame opens it in a new tab instead. */
function printFile(file) {
  const url = URL.createObjectURL(file);
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  frame.onload = () => {
    try { frame.contentWindow.focus(); frame.contentWindow.print(); } catch { window.open(url, '_blank', 'noopener'); }
    // Long enough for the print dialog to have read the file.
    setTimeout(() => { frame.remove(); URL.revokeObjectURL(url); }, 60_000);
  };
  frame.src = url;
  document.body.appendChild(frame);
}

const fmtHours = (n) => formatHoursHM(n);
const FOLDING = new Set(['section', 'heading']);

/**
 * One person's report, Intacct's Employee Compensation Report (item 13): the
 * person and code over last year and the period asked; Employee Metrics
 * (Rates, Hours Worked, Accruals), Employer Expenses and Employee Net Pay,
 * each group folding like Intacct's triangles with its own total; Print and
 * Excel as on Intacct's bar (Email is left out until Charmi asks).
 */
function StatementPanel({ panel, curLabel, priorLabel, onClose, onLines, exportItems }) {
  useEscape(onClose);
  const { subject, name, code } = panel;
  const rows = useMemo(() => statementRows(subject), [subject]);
  const [folded, setFolded] = useState(() => new Set());
  const [printing, setPrinting] = useState(false);
  const [printError, setPrintError] = useState('');
  const foldId = (r) => (r.kind === 'section' ? r.section : r.group);
  const toggle = (id) => setFolded((f) => { const n = new Set(f); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allIds = useMemo(() => rows.filter((r) => FOLDING.has(r.kind)).map(foldId), [rows]);
  const anyFolded = folded.size > 0;
  const shown = visibleRows(rows, folded);
  const heading = `${name}${code ? ` (${code})` : ''}`;
  const table = () => statementTable(subject, { name: heading, curLabel, priorLabel });
  const print = async () => {
    setPrinting(true);
    setPrintError('');
    try { printFile(await linesFile(table(), 'pdf')); } catch (e) { setPrintError(e?.message || 'Could not build the page to print.'); } finally { setPrinting(false); }
  };
  const caption = [subject.companyName, subject.department, subject.title].filter(Boolean).join(' · ') || (subject.people > 1 ? `${subject.people} employees` : '');
  const cell = (r, period) => {
    const v = r[period];
    const isFolded = FOLDING.has(r.kind) && folded.has(foldId(r));
    // An open heading leaves its figure to its total row; a folded one shows it, as Intacct does.
    if (FOLDING.has(r.kind) && !isFolded) return <td style={tdNum} />;
    if (v == null) return <td style={tdNum}><span style={muted}>-</span></td>;
    const strong = r.kind === 'total' || isFolded;
    if (r.hours || r.kind === 'hours') {
      return <td style={{ ...tdNum, ...(strong ? { fontWeight: 700 } : null) }} title="From Time Clock's payroll cards, for the period asked">{v ? fmtHours(v) : '-'}</td>;
    }
    if (r.kind === 'rate') return <td style={tdNum} title={r.key === 'fixed' ? 'Monthly salary on the pay setup (Time Clock)' : 'Hourly rate on the pay setup (Time Clock)'}><Amount value={v} zero="dash" /></td>;
    return (
      <td style={{ ...tdNum, ...(strong ? { fontWeight: 700 } : null) }}>
        <DrillAmount value={v} label={`${r.label} for ${name}, ${period === 'cur' ? curLabel : priorLabel}`} onOpen={() => onLines(r.key, period, r.kind === 'account' ? r.account : null)} />
      </td>
    );
  };
  const labelCell = (r) => {
    const pad = 8 + r.level * 16;
    if (FOLDING.has(r.kind)) {
      const id = foldId(r);
      const open = !folded.has(id);
      return (
        <td style={{ ...td, paddingLeft: pad - 2, paddingTop: r.kind === 'section' ? 10 : 6 }}>
          <button type="button" style={{ ...plainBtn, display: 'inline-flex', alignItems: 'center', gap: 4, fontWeight: 700, color: 'var(--wk-brand, #2b45e1)' }}
            aria-expanded={open} onClick={() => toggle(id)} title={open ? `Fold ${r.label}` : `Open ${r.label}`}>
            {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}{r.label}
          </button>
        </td>
      );
    }
    return <td style={{ ...td, paddingLeft: pad + 16, fontWeight: r.kind === 'total' ? 700 : 400, ...(r.kind === 'account' ? { color: 'var(--text-secondary)' } : null) }}>{r.label}</td>;
  };
  return (
    <SidePanel label="Employee Compensation Report" title={heading} caption={caption || 'Employee Compensation Report'} onClose={onClose}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ ...muted, flex: 1, minWidth: 220 }}>From the Intacct ledger; hours and rates from Time Clock. Click an amount for its ledger lines.</span>
        <button type="button" style={{ ...control, cursor: 'pointer' }} onClick={() => setFolded(anyFolded ? new Set() : new Set(allIds))}>{anyFolded ? 'Expand All' : 'Collapse All'}</button>
        <button type="button" style={{ ...control, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }} onClick={print} disabled={printing} aria-busy={printing}>
          <Printer size={14} aria-hidden="true" />Print
        </button>
        <ExportMenu items={exportItems(table)} />
      </div>
      {printError && <ErrorBanner message={printError} />}
      <div style={{ ...card, overflowX: 'auto' }}>
        <table aria-label={`Employee Compensation Report - ${name}`} style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr><th style={{ ...th, borderBottom: 'none' }} /><th colSpan={2} style={{ ...thNum, textAlign: 'center', borderBottom: 'none', color: 'var(--text-primary)', fontSize: 13 }}>{heading}</th></tr>
            <tr><th style={th} /><th style={thNum}>{priorLabel}</th><th style={thNum}>{curLabel}</th></tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={`${r.kind}-${r.section}-${r.group || ''}-${r.key || r.label}-${r.account || i}`} style={r.strong ? { background: 'var(--bg-secondary)' } : undefined}>
                {labelCell(r)}
                {cell(r, 'prior')}
                {cell(r, 'cur')}
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
          {w.name && subject.codes?.length > 1 ? `${w.name}: ` : ''}{w.year}: {pct(w.ratePct)}{w.classCode ? ` (Class ${w.classCode})` : ''} of {formatAmount(w.gross)} gross wages = {formatAmount(w.amount)}{w.rateYear !== w.year ? ` (the rate set for ${w.rateYear})` : ''}
        </span>
      ))}
    </div>
  );
}

const monthEndOf = (m) => `${m}-${String(new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0).getDate()).padStart(2, '0')}`;
const HOUR_DAY_KEY = { regMin: (d) => d.regMin, overtimeMin: (d) => (d.otMin || 0) + (d.dtMin || 0), sickMin: (d) => d.sickMin, vacationMin: (d) => d.vacationMin };

/** The days behind one person's hours: their Time Sheet's days, month by month, the column clicked first. */
function HoursPanel({ panel, range, onClose }) {
  useEscape(onClose);
  const { subject, name, key } = panel;
  const [days, setDays] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!range) return undefined;
    let alive = true;
    const months = [];
    for (let m = range[0]; m <= range[1]; m = monthKey(new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 1))) months.push(m);
    Promise.all(months.map((m) => api.timePayroll(subject.email, `${m}-01`, monthEndOf(m))))
      .then((cards) => {
        if (!alive) return;
        const seen = new Map();
        cards.forEach((c) => (c?.days || []).forEach((d) => { if (d?.date) seen.set(d.date, d); }));
        setDays([...seen.values()].sort((a, b) => a.date.localeCompare(b.date)));
      })
      .catch((e) => { if (alive) setError(e?.message || 'Could not read the Time Sheet.'); });
    return () => { alive = false; };
  }, [subject.email, range?.[0], range?.[1]]); // eslint-disable-line react-hooks/exhaustive-deps
  const cols = HOUR_COLUMNS;
  const val = (d, k) => Number(HOUR_DAY_KEY[k](d)) || 0;
  const loaded = range ? days : [];
  const shown = (loaded || []).filter((d) => cols.some((c) => val(d, c.key)));
  const sum = (k) => shown.reduce((n, d) => n + val(d, k), 0);
  const label = cols.find((c) => c.key === key)?.short || '';
  const openSheet = () => window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'timeclock', sub: 'timesheet' } }));
  return (
    <SidePanel label="Hours" title={`${name} - ${label} Hours`} caption={range ? periodLabel(`${range[0]}-01`, monthEndOf(range[1])) : ''} onClose={onClose}>
      <span style={muted}>Each day from {name}&apos;s Time Sheet. <button type="button" style={linkBtn} onClick={openSheet}>Open Time Sheets</button></span>
      {error ? <ErrorBanner message={error} /> : !loaded ? <LoadingDots compact hint="Reading the Time Sheet." /> : (
        <div style={{ ...card, overflowX: 'auto' }}>
          <table aria-label={`Hours by day - ${name}`} style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead><tr><th style={th}>Date</th>{cols.map((c) => <th key={c.key} style={{ ...thNum, ...(c.key === key ? { color: 'var(--text-primary)' } : null) }}>{c.short}</th>)}</tr></thead>
            <tbody>
              {!shown.length && <tr><td colSpan={cols.length + 1} style={{ ...td, padding: 14, color: 'var(--text-secondary)' }}>No hours on the Time Sheet for these months.</td></tr>}
              {shown.map((d) => (
                <tr key={d.date}>
                  <td style={td}>{formatDate(d.date)}</td>
                  {cols.map((c) => <td key={c.key} style={{ ...tdNum, ...(c.key === key ? { fontWeight: 700 } : null) }}>{val(d, c.key) ? hrs(val(d, c.key)) : '-'}</td>)}
                </tr>
              ))}
            </tbody>
            {!!shown.length && (
              <tfoot><tr><td style={{ ...td, fontWeight: 700 }}>Total - {shown.length} {shown.length === 1 ? 'day' : 'days'}</td>{cols.map((c) => <td key={c.key} style={{ ...tdNum, fontWeight: 700 }}>{hrs(sum(c.key))}</td>)}</tr></tfoot>
            )}
          </table>
        </div>
      )}
    </SidePanel>
  );
}

const NO_LINES = { lines: [], total: 0 };

// Intacct's General Ledger report columns (10/27 call, 14:48: the lines behind
// Valinda's Fuel) plus the entry and account, with a running balance. Each
// drags to its width, kept per person (useColumnWidths).
const GL_COLUMNS = [
  { key: 'date', label: 'Date', width: 92, text: (l) => formatDate(l.entry_date) },
  { key: 'entry', label: 'Entry', width: 86 },
  { key: 'doc', label: 'Doc', width: 64, text: (l) => l.doc },
  { key: 'account', label: 'Account', width: 140 },
  { key: 'memo', label: 'Memo', width: 150, text: (l) => l.memo || l.description },
  { key: 'location', label: 'Entity', width: 112, text: (l) => l.location_name || l.location },
  { key: 'vendor', label: 'Vendor', width: 110, text: (l) => l.vendor_name || l.vendor_id },
  { key: 'customer', label: 'Customer', width: 90, text: (l) => l.customer_name || l.customer_id },
  { key: 'item', label: 'Item', width: 80, text: (l) => l.item_name || l.item_id },
  { key: 'employee', label: 'Employee', width: 110, text: (l) => l.employee_name || l.employee_id },
  { key: 'department', label: 'Department', width: 90, text: (l) => l.department_name || l.department },
  { key: 'debit', label: 'Debit', width: 84, num: true },
  { key: 'credit', label: 'Credit', width: 84, num: true },
  { key: 'balance', label: 'Balance', width: 92, num: true },
];
const GL_WIDTHS = Object.fromEntries(GL_COLUMNS.map((c) => [c.key, c.width]));

/** The ledger lines behind one figure, in Intacct's General Ledger columns; each entry opens its transaction (item 17). */
function LedgerLinesPanel({ panel, periods, onClose, onBack, onReports }) {
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
  const accountsShown = [...new Map(lines.map((l) => [l.gl_code, l.account_name])).entries()];
  const cw = useColumnWidths('compensation-lines', GL_WIDTHS, { min: 50 });
  // The balance after each line, as on Intacct's General Ledger.
  const running = useMemo(() => (data?.lines || []).reduce((acc, l) => {
    acc.push(Math.round(((acc.at(-1) || 0) + (Number(l.amount) || 0)) * 100) / 100);
    return acc;
  }, []), [data]);
  const sum = (k) => lines.reduce((n, l) => n + (Number(l[k]) || 0), 0);
  const glCell = (c, l, i) => {
    if (c.key === 'entry') {
      return l.entry_id
        ? <button type="button" style={linkBtn} onClick={() => setEntry({ id: l.entry_id, no: l.entry_no })} title="Open the transaction behind this line">{l.entry_no || 'Open'}</button>
        : l.entry_no;
    }
    if (c.key === 'account') return <><span className="acct-code">{l.gl_code}</span> {l.account_name}</>;
    if (c.key === 'balance') return <Amount value={running[i]} />;
    if (c.num) return <Amount value={Number(l[c.key]) || 0} zero="dash" />;
    return c.text(l) || <span style={muted}>-</span>;
  };
  return (
    <SidePanel label="Ledger Lines" title={title} caption={`${name} · ${periodLabel(range.from, range.to)} · ${formatAmount(figure)}`} onClose={onClose}>
      {onBack && <div><button type="button" style={linkBtn} onClick={onBack}>Back to {name}&apos;s report</button></div>}
      {wc && <WorkersCompNote subject={subject} period={period} />}
      {wc && <div style={{ ...muted, fontWeight: 600 }}>The gross wages it is worked out on - the Bonus and Salaried / Hourly Payroll lines:</div>}
      {!!lines.length && <div style={muted}>Open Full shows every column; drag a heading&apos;s edge to resize it (kept for you).</div>}
      {error ? <ErrorBanner message={error} /> : !data ? <LoadingDots compact hint="Reading the ledger lines." /> : (
        <div style={{ ...card, overflowX: 'auto' }}>
          <table aria-label={`Ledger lines - ${title}`} style={{ borderCollapse: 'collapse', tableLayout: 'fixed', width: GL_COLUMNS.reduce((n, c) => n + (cw.width(c.key) || c.width), 0) }}>
            <thead>
              <tr>
                {GL_COLUMNS.map((c) => (
                  <th key={c.key} style={{ ...(c.num ? thNum : th), position: 'relative', width: cw.width(c.key) }}>
                    {c.label}<ColumnResizer {...cw.resizer(c.key, c.label)} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {!lines.length && <tr><td colSpan={GL_COLUMNS.length} style={{ ...td, padding: 14, color: 'var(--text-secondary)' }}>No ledger lines.</td></tr>}
              {lines.map((l, i) => (
                <tr key={`${l.line_id || i}-${l.gl_code}`}>
                  {GL_COLUMNS.map((c) => (
                    <td key={c.key} style={c.num ? tdNum : { ...td, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.text ? c.text(l) || undefined : undefined}>{glCell(c, l, i)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
            {!!lines.length && (
              <tfoot>
                <tr>
                  <td colSpan={GL_COLUMNS.length - 3} style={{ ...td, fontWeight: 700 }}>Total - {lines.length} {lines.length === 1 ? 'line' : 'lines'}</td>
                  <td style={{ ...tdNum, fontWeight: 700 }}><Amount value={sum('debit')} zero="dash" /></td>
                  <td style={{ ...tdNum, fontWeight: 700 }}><Amount value={sum('credit')} zero="dash" /></td>
                  <td style={{ ...tdNum, fontWeight: 700 }}><Amount value={data.total} /></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
      {data?.truncated && <p style={{ ...muted, margin: 0 }}>More lines than shown here - open the account in Reports for every line.</p>}
      {off && <p role="note" style={{ ...muted, margin: 0, color: 'var(--warn-fg)' }}><WarnMark />These lines add up to {formatAmount(data.total)}; the report shows {formatAmount(figure)}. The ledger may have changed since the report was read - Sync reads it again.</p>}
      {!!accountsShown.length && (
        <div style={{ ...muted, display: 'flex', flexWrap: 'wrap', gap: '4px 12px', alignItems: 'baseline' }}>
          <span>Open in Reports:</span>
          {accountsShown.map(([acct, accountName]) => (
            <button key={acct} type="button" style={linkBtn} onClick={() => onReports({ account: acct, accountName, subject, name, period })}>{acct} {accountName}</button>
          ))}
        </div>
      )}
      {entry && <EntryDetail key={entry.id} entryId={entry.id} entryNo={entry.no} onClose={() => setEntry(null)} panel />}
    </SidePanel>
  );
}

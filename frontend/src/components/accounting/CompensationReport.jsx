import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import AsyncSection, { SkeletonBlocks } from '../AsyncState';
import Amount, { formatAmount } from './Amount';
import { BarMore, ControlBar, control, ExportMenu, SyncButton } from './reportControls';
import { useTableSync } from './tableSync';
import { useFitHeight } from './tableHooks';
import { TableViewBar, ViewHead, useTableView, viewCells, viewTable } from './tableView';
import { downloadBlob } from './reportModel';
import { linesFile } from './linesExport';
import { formatDate } from '../../lib/datetime';
import { isStepUpRequired, StepUpNeeded } from '../../stepup/StepUp';
import { buildingHint, compensationTable, emptyReason, HOUR_COLUMNS, hoursOf, LEDGER_SPLIT_COLUMNS, ledgerTable, loadErrorMessage, monthsBetween, payTypeLabel, rateLabel, viewRows, VIEWS } from './compensationModel';
import { COMP_REQUEST_TIMEOUT_MS } from './assumptions';

// Accounting > Reporting > Employee Compensation (Neil, 10/15: "We still need
// to make employee compensation report"). For a run of months: each person's
// company, department, title, pay type and rate, regular / overtime / double
// time hours, sick / vacation / personal leave hours and gross wages - straight
// from the Time Clock payroll card, the same engine as the timecard and the
// Allocations entry - with totals by company and department. Below it, payroll
// expense on the ledger by department or employee, where employer taxes and
// benefits are booked. Wages for everyone are payroll figures: the screen is
// only offered at the Full level on Accounting, and the backend also asks for
// a fresh identity check (step-up) like the payroll card.

const MAX_MONTHS = 12;
const card = { backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, boxShadow: 'var(--shadow-sm)' };
const th = { textAlign: 'left', padding: '6px 8px', fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-color)', verticalAlign: 'bottom' };
const thNum = { ...th, textAlign: 'right' };
const td = { padding: '4px 8px', borderBottom: '1px solid var(--border-color)', fontSize: '0.8rem', verticalAlign: 'top' };
const tdNum = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
// 10/23 meeting, item 02 (fix 10/24): the words sit beside the boxes, not above them, so the bar is one line.
const inline = { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', color: 'var(--text-secondary)' };
const muted = { color: 'var(--text-muted)', fontSize: '0.72rem' };
const seg = (on) => ({ ...control, cursor: 'pointer', fontWeight: on ? 700 : 400, color: on ? 'var(--wk-brand, #2b45e1)' : 'var(--text-primary)', borderColor: on ? 'var(--wk-brand, #2b45e1)' : 'var(--border-color)' });

const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
function defaultRange(now = new Date()) {
  const last = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return [monthKey(new Date(last.getFullYear(), 0, 1)), monthKey(last)];
}
const hrs = (min) => hoursOf(min).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// The people table's columns for the standard table view (10/23 meeting,
// item 01), one set per grouping: hours compare as numbers, rates and wages
// as amounts. Employee ID and the currency export beside them, as before.
function compColumns(grouping) {
  const hours = HOUR_COLUMNS.map((c) => ({ key: c.key, label: c.label, type: 'number', total: true, value: (r) => hoursOf(r[c.key]), text: (r) => (r[c.key] ? hrs(r[c.key]) : '') }));
  const wages = { key: 'wages', label: 'Gross Wages', type: 'amount', total: true, value: (r) => Number(r.wages) || 0, text: (r) => formatAmount(r.wages) };
  if (grouping === 'people') {
    return [
      { key: 'name', label: 'Employee', text: (r) => r.name || '', exportAs: [{ label: 'Employee', width: 160, get: (r) => r.name }, { label: 'Employee ID', width: 80, get: (r) => r.employeeId }] },
      { key: 'company', label: 'Company', text: (r) => r.companyName || '', exportAs: [{ label: 'Company', width: 140, get: (r) => r.companyName }] },
      { key: 'department', label: 'Department', text: (r) => r.department || '', exportAs: [{ label: 'Department', width: 110, get: (r) => r.department }] },
      { key: 'title', label: 'Title', text: (r) => r.title || '', exportAs: [{ label: 'Title', width: 120, get: (r) => r.title }] },
      { key: 'payType', label: 'Pay Type', text: (r) => payTypeLabel(r.payType), exportAs: [{ label: 'Pay Type', width: 60, get: (r) => payTypeLabel(r.payType) }, { label: 'Currency', width: 55, get: (r) => r.currency }] },
      { key: 'rate', label: 'Rate', type: 'amount', value: (r) => Number(r.rate) || 0, text: (r) => formatAmount(r.rate) },
      ...hours, wages,
    ];
  }
  const head = grouping === 'company' ? 'Company' : 'Department';
  return [
    { key: 'label', label: head, text: (r) => r.label || '', exportAs: [{ label: head, width: 180, get: (r) => r.label }, { label: 'Currency', width: 60, get: (r) => r.currency }] },
    { key: 'people', label: 'Employees', type: 'number', total: true, value: (r) => Number(r.people) || 0, text: (r) => String(r.people ?? '') },
    ...hours, wages,
  ];
}

/** The totals by currency over some rows (wages in USD and INR never add together). */
function totalsOf(rows, grouping) {
  const by = new Map();
  rows.forEach((r) => {
    const t = by.get(r.currency) || { currency: r.currency, people: 0, wages: 0, ...Object.fromEntries(HOUR_COLUMNS.map((c) => [c.key, 0])) };
    t.people += grouping === 'people' ? 1 : Number(r.people) || 0;
    t.wages = Math.round((t.wages + (Number(r.wages) || 0)) * 100) / 100;
    HOUR_COLUMNS.forEach((c) => { t[c.key] += Number(r[c.key]) || 0; });
    by.set(r.currency, t);
  });
  return [...by.values()];
}

export default function CompensationReport() {
  const [[from, to], setRange] = useState(() => defaultRange());
  const [asked, setAsked] = useState(() => defaultRange());
  const [view, setView] = useState('people');
  const [data, setData] = useState(null);
  const [state, setState] = useState({ loading: true, error: '', stepUp: false });
  const [by, setBy] = useState('department');
  const [ledger, setLedger] = useState(null);
  const [ledgerState, setLedgerState] = useState({ loading: false, error: '' });
  const [busy, setBusy] = useState('');
  // Item 05 (fix 10/24): the screen is as tall as the window; the two tables
  // share what the bar leaves, each scrolling in its own card (style.css
  // .acct-fit-stack).
  const [box, setBox] = useState(null);
  const fit = useFitHeight(box);

  const span = monthsBetween(from, to);
  const rangeError = span < 1 ? 'The start month must be on or before the end month.' : span > MAX_MONTHS ? `Pick at most ${MAX_MONTHS} months.` : '';

  // `quiet` (a Sync, 10/23 meeting item 13): the table stays on screen while it reads.
  const loadPeople = useCallback(([f, t], quiet = false) => {
    if (quiet) setState((s) => ({ ...s, syncing: true }));
    else setState({ loading: true, error: '', stepUp: false });
    // One attempt (api.js noRetry): the server stops a run that runs long and
    // says why, so a failure is shown at once instead of after silent retries.
    return api.getCompensationPeople(f, t, { timeoutMs: COMP_REQUEST_TIMEOUT_MS })
      .then((d) => { setData(d); setState({ loading: false, error: '', stepUp: false }); })
      .catch((e) => { setData(null); setState({ loading: false, error: isStepUpRequired(e) ? '' : loadErrorMessage(e, monthsBetween(f, t)), stepUp: isStepUpRequired(e) }); });
  }, []);
  const loadLedger = useCallback(([f, t], b, quiet = false) => {
    setLedgerState(quiet ? (s) => ({ ...s, syncing: true }) : { loading: true, error: '' });
    return api.getCompensationLedger(f, t, b)
      .then((d) => { setLedger(d); setLedgerState({ loading: false, error: '' }); })
      .catch((e) => { setLedger(null); setLedgerState({ loading: false, error: isStepUpRequired(e) ? 'Verify your identity above to see the ledger figures.' : (e?.message || 'Could not read payroll expense from the ledger.') }); });
  }, []);
  useEffect(() => { loadPeople(asked); }, [asked, loadPeople]);
  // The ledger read waits for the people read: it needs the same identity check.
  // (Once there are people: a Sync of the people does not re-read the ledger.)
  const peopleIn = !!data;
  useEffect(() => { if (peopleIn) loadLedger(asked, by); }, [peopleIn, asked, by, loadLedger]);
  // Item 13: each table has its own Sync - the people's re-reads only the
  // people, the ledger's only the ledger figures.
  const peopleSync = useTableSync(useCallback(() => loadPeople(asked, true), [asked, loadPeople]));
  const ledgerSync = useTableSync(useCallback(() => loadLedger(asked, by, true), [asked, by, loadLedger]));

  const run = () => { if (!rangeError) setAsked([from, to]); };
  const period = data ? `${formatDate(data.from)} - ${formatDate(data.to)}` : '';
  const all = useMemo(() => viewRows(data, view), [data, view]);
  // Item 01: the standard view over the rows of the grouping picked (each
  // grouping keeps its own); the totals follow it once it filters.
  const columns = useMemo(() => compColumns(view), [view]);
  const tv = useTableView(`comp-${view}`, columns, all);
  const rows = tv.rows;
  const totals = tv.count ? totalsOf(rows, view) : data?.totals || [];
  // Exactly what the view leaves, with one Total line per currency when there are several.
  const peopleTable = () => {
    const base = compensationTable(data, view, { period });
    const currencies = [...new Set(rows.map((r) => r.currency))];
    const t = viewTable(rows, tv.columns, { title: base.title, subtitle: base.subtitle, period: base.period, totals: currencies.length <= 1 });
    if (currencies.length <= 1) return t;
    const lines = currencies.map((cur) => {
      const one = viewTable(rows.filter((r) => r.currency === cur), tv.columns, { totals: true });
      return (one.totals || []).map((v) => (typeof v === 'string' && v.startsWith('Total') ? `Total ${cur}` : v));
    });
    return { ...t, rows: [...t.rows, ...lines] };
  };

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
          {VIEWS.map((v) => <button key={v.key} type="button" style={seg(view === v.key)} aria-pressed={view === v.key} onClick={() => setView(v.key)}>{v.label}</button>)}
        </div>
        </BarMore>
        <TableViewBar key={view} view={tv} />
        <div className="acct-bar-end">
          <SyncButton onSync={peopleSync.sync} busy={!!state.syncing} syncedAt={peopleSync.syncedAt} what="Compensation" />
          <ExportMenu disabled={!data || !rows.length} items={exportItems('people', peopleTable, !data)} />
        </div>
        {rangeError && <div style={{ width: '100%', fontSize: '0.75rem', color: '#b91c1c' }}>{rangeError}</div>}
      </ControlBar>

      {state.stepUp ? (
        <StepUpNeeded label="Wages and hours by person." onVerified={() => loadPeople(asked)} />
      ) : (
        <AsyncSection loading={state.loading} error={!!state.error} errorMessage={state.error} onRetry={() => loadPeople(asked)}
          skeleton={(
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div role="status" style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{buildingHint(monthsBetween(asked[0], asked[1]))}</div>
              <SkeletonBlocks count={2} />
            </div>
          )}
          isEmpty={!!data && !data.people?.length}
          emptyContent={<div style={{ ...card, padding: 24, textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.86rem' }}>{emptyReason(data)}</div>}>
          {data && (
            <div className="acct-stack-card acct-stack-main" style={card}>
              <div style={{ padding: '10px 12px 4px', display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'baseline' }}>
                <h3 style={{ margin: 0, fontSize: '0.95rem' }}>Compensation</h3>
                <span style={muted}>{period} · {data.people.length} {data.people.length === 1 ? 'employee' : 'employees'}{tv.count ? ` · ${rows.length} of ${all.length} rows pass the filters` : ''}</span>
              </div>
              <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                <thead>
                  <tr>
                    {tv.columns.map((c) => {
                      const w = tv.manualWidth(c.key);
                      return <ViewHead key={c.key} view={tv} col={c} aria-label={c.label} style={{ ...(c.type ? thNum : th), position: 'relative', ...(w ? { width: w, minWidth: w, maxWidth: w } : null) }} />;
                    })}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={view === 'people' ? r.email : `${r.key}-${r.currency}`}>
                      {viewCells(tv, {
                        name: <td style={td}><strong>{r.name}</strong>{r.employeeId ? <div style={muted}>{r.employeeId}</div> : null}</td>,
                        company: <td style={td}>{r.companyName || <span style={muted}>No Company</span>}</td>,
                        department: <td style={td}>{r.department || <span style={muted}>-</span>}</td>,
                        title: <td style={td}>{r.title || <span style={muted}>-</span>}</td>,
                        payType: <td style={td}>{payTypeLabel(r.payType)}</td>,
                        rate: (
                          <td style={tdNum} title={r.rateChanged ? 'The rate changed in these months; the latest is shown.' : rateLabel(r)}>
                            <Amount value={r.rate} zero="dash" />{r.currency !== 'USD' ? ` ${r.currency}` : ''}{r.rateChanged ? ' *' : ''}
                            <div style={muted}>{rateLabel(r)}</div>
                          </td>
                        ),
                        label: <td style={td}><strong>{r.label}</strong>{r.currency !== 'USD' ? <span style={muted}> {r.currency}</span> : null}</td>,
                        people: <td style={tdNum}>{r.people}</td>,
                        ...Object.fromEntries(HOUR_COLUMNS.map((c) => [c.key, <td style={tdNum}>{r[c.key] ? hrs(r[c.key]) : '-'}</td>])),
                        wages: <td style={{ ...tdNum, fontWeight: 600 }}><Amount value={r.wages} zero="dash" />{r.currency !== 'USD' ? ` ${r.currency}` : ''}</td>,
                      })}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  {totals.map((t) => (
                    <tr key={t.currency}>
                      {viewCells(tv, {
                        [view === 'people' ? 'name' : 'label']: <td style={{ ...td, fontWeight: 700 }}>{totals.length > 1 ? `Total ${t.currency}` : 'Total'}</td>,
                        people: <td style={{ ...tdNum, fontWeight: 700 }}>{t.people}</td>,
                        ...Object.fromEntries(HOUR_COLUMNS.map((c) => [c.key, <td style={{ ...tdNum, fontWeight: 700 }}>{hrs(t[c.key])}</td>])),
                        wages: <td style={{ ...tdNum, fontWeight: 700 }}><Amount value={t.wages} zero="dash" />{t.currency !== 'USD' ? ` ${t.currency}` : ''}</td>,
                      }, () => <td style={td} />)}
                    </tr>
                  ))}
                </tfoot>
              </table>
              <p style={{ margin: 0, padding: '8px 12px 12px', fontSize: '0.72rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                Hours and gross wages are each month&apos;s Time Clock payroll card added up. Leave hours are Sick Day / PTO punches, paid at the base rate.
                A salaried person&apos;s rate is the monthly salary and all their worked time is regular. * The rate changed in these months; the latest is shown.
                {totals.length > 1 ? ' Wages in different currencies are totaled separately.' : ''}
              </p>
            </div>
          )}
        </AsyncSection>
      )}

      {data && !state.stepUp && (
        <div className="acct-stack-card" style={card}>
          <div style={{ padding: '10px 12px 4px', display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
            <h3 style={{ margin: 0, fontSize: '0.95rem', flex: 1 }}>Payroll Expense on the Ledger</h3>
            <div style={{ display: 'flex', gap: 4 }} role="group" aria-label="Ledger Group By">
              {[['department', 'By Department'], ['employee', 'By Employee']].map(([k, l]) => <button key={k} type="button" style={seg(by === k)} aria-pressed={by === k} onClick={() => setBy(k)}>{l}</button>)}
            </div>
            <SyncButton onSync={ledgerSync.sync} busy={!!ledgerState.syncing} syncedAt={ledgerSync.syncedAt} what="Ledger" />
            <ExportMenu disabled={!ledger?.rows?.length} items={exportItems('ledger', () => ledgerTable(ledger, { period }), !ledger)} />
          </div>
          <AsyncSection loading={ledgerState.loading} error={!!ledgerState.error} errorMessage={ledgerState.error} onRetry={() => loadLedger(asked, by)} skeleton={<SkeletonBlocks count={1} height={80} />}
            isEmpty={!!ledger && !ledger.rows?.length}
            emptyContent={<p style={{ margin: 0, padding: '8px 12px 14px', color: 'var(--text-secondary)', fontSize: '0.82rem' }}>No payroll accounts posted on the ledger in these months.</p>}>
            {ledger && (
              <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                <thead><tr><th style={th}>{ledger.by === 'employee' ? 'Employee' : 'Department'}</th><th style={thNum}>Wages</th><th style={thNum}>Employer Taxes</th><th style={thNum}>Benefits</th>
                  {LEDGER_SPLIT_COLUMNS.map((c) => <th key={c.key} style={thNum}>{c.label}</th>)}<th style={thNum}>Total</th></tr></thead>
                <tbody>
                  {ledger.rows.map((r) => (
                    <tr key={r.key || 'none'}>
                      <td style={td}>{r.label}{r.key && r.key !== r.label ? <span style={muted}> {r.key}</span> : null}</td>
                      <td style={tdNum}><Amount value={r.wages} zero="dash" /></td>
                      <td style={tdNum}><Amount value={r.taxes} zero="dash" /></td>
                      <td style={tdNum}><Amount value={r.benefits} zero="dash" /></td>
                      {LEDGER_SPLIT_COLUMNS.map((c) => <td key={c.key} style={tdNum}><Amount value={r[c.key]} zero="dash" /></td>)}
                      <td style={{ ...tdNum, fontWeight: 600 }}><Amount value={r.total} zero="dash" /></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td style={{ ...td, fontWeight: 700 }}>Total</td>
                    <td style={{ ...tdNum, fontWeight: 700 }}><Amount value={ledger.totals.wages} zero="dash" /></td>
                    <td style={{ ...tdNum, fontWeight: 700 }}><Amount value={ledger.totals.taxes} zero="dash" /></td>
                    <td style={{ ...tdNum, fontWeight: 700 }}><Amount value={ledger.totals.benefits} zero="dash" /></td>
                    {LEDGER_SPLIT_COLUMNS.map((c) => <td key={c.key} style={{ ...tdNum, fontWeight: 700 }}><Amount value={ledger.totals[c.key]} zero="dash" /></td>)}
                    <td style={{ ...tdNum, fontWeight: 700 }}><Amount value={ledger.totals.total} zero="dash" /></td>
                  </tr>
                </tfoot>
              </table>
            )}
          </AsyncSection>
          <p style={{ margin: 0, padding: '8px 12px 12px', fontSize: '0.72rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
            Expense accounts whose titles say payroll, salary, wage, bonus or commission count as wages; payroll tax, FICA, FUTA, SUTA and Medicare as employer taxes;
            health, dental, 401(k), retirement and workers&apos; comp as benefits. Contract labor is not payroll.
            {LEDGER_SPLIT_COLUMNS.length ? ' Direct is payroll booked to cost of sales (labor charged to properties and jobs); Indirect is payroll booked to operating and other expense (overhead).' : ''}
          </p>
        </div>
      )}
    </div>
  );
}

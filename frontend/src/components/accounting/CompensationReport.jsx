import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import AsyncSection, { SkeletonBlocks } from '../AsyncState';
import Amount from './Amount';
import { ControlBar, control, ExportMenu, SyncButton } from './reportControls';
import { useTableSync } from './tableSync';
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
const label = { fontSize: '0.72rem', color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', gap: 3 };
const muted = { color: 'var(--text-muted)', fontSize: '0.72rem' };
const seg = (on) => ({ ...control, cursor: 'pointer', fontWeight: on ? 700 : 400, color: on ? 'var(--wk-brand, #2b45e1)' : 'var(--text-primary)', borderColor: on ? 'var(--wk-brand, #2b45e1)' : 'var(--border-color)' });

const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
function defaultRange(now = new Date()) {
  const last = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return [monthKey(new Date(last.getFullYear(), 0, 1)), monthKey(last)];
}
const hrs = (min) => hoursOf(min).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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
  const rows = useMemo(() => viewRows(data, view), [data, view]);
  const totals = data?.totals || [];

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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <ControlBar style={{ ...card, padding: 12, alignItems: 'flex-end' }}>
        <label style={label}>From Month
          <input type="month" value={from} onChange={(e) => setRange([e.target.value, to])} style={control} aria-label="From Month" />
        </label>
        <label style={label}>To Month
          <input type="month" value={to} onChange={(e) => setRange([from, e.target.value])} style={control} aria-label="To Month" />
        </label>
        <button type="button" className="primary-btn" onClick={run} disabled={!!rangeError || state.loading} style={{ height: 30, fontSize: '0.78rem' }}>Run Report</button>
        <div style={{ display: 'flex', gap: 4 }} role="group" aria-label="View">
          {VIEWS.map((v) => <button key={v.key} type="button" style={seg(view === v.key)} aria-pressed={view === v.key} onClick={() => setView(v.key)}>{v.label}</button>)}
        </div>
        <div className="acct-bar-end">
          <SyncButton onSync={peopleSync.sync} busy={!!state.syncing} syncedAt={peopleSync.syncedAt} what="Compensation" />
          <ExportMenu disabled={!data || !rows.length} items={exportItems('people', () => compensationTable(data, view, { period }), !data)} />
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
            <div style={{ ...card, overflow: 'auto' }}>
              <div style={{ padding: '10px 12px 4px', display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'baseline' }}>
                <h3 style={{ margin: 0, fontSize: '0.95rem' }}>Compensation</h3>
                <span style={muted}>{period} · {data.people.length} {data.people.length === 1 ? 'employee' : 'employees'}</span>
              </div>
              <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                <thead>
                  <tr>
                    {view === 'people' ? (
                      <><th style={th}>Employee</th><th style={th}>Company</th><th style={th}>Department</th><th style={th}>Title</th><th style={th}>Pay Type</th><th style={thNum}>Rate</th></>
                    ) : (
                      <><th style={th}>{view === 'company' ? 'Company' : 'Department'}</th><th style={thNum}>Employees</th></>
                    )}
                    {HOUR_COLUMNS.map((c) => <th key={c.key} style={thNum}>{c.label}</th>)}
                    <th style={thNum}>Gross Wages</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={view === 'people' ? r.email : `${r.key}-${r.currency}`}>
                      {view === 'people' ? (
                        <>
                          <td style={td}><strong>{r.name}</strong>{r.employeeId ? <div style={muted}>{r.employeeId}</div> : null}</td>
                          <td style={td}>{r.companyName || <span style={muted}>No Company</span>}</td>
                          <td style={td}>{r.department || <span style={muted}>-</span>}</td>
                          <td style={td}>{r.title || <span style={muted}>-</span>}</td>
                          <td style={td}>{payTypeLabel(r.payType)}</td>
                          <td style={tdNum} title={r.rateChanged ? 'The rate changed in these months; the latest is shown.' : rateLabel(r)}>
                            <Amount value={r.rate} zero="dash" />{r.currency !== 'USD' ? ` ${r.currency}` : ''}{r.rateChanged ? ' *' : ''}
                            <div style={muted}>{rateLabel(r)}</div>
                          </td>
                        </>
                      ) : (
                        <>
                          <td style={td}><strong>{r.label}</strong>{r.currency !== 'USD' ? <span style={muted}> {r.currency}</span> : null}</td>
                          <td style={tdNum}>{r.people}</td>
                        </>
                      )}
                      {HOUR_COLUMNS.map((c) => <td key={c.key} style={tdNum}>{r[c.key] ? hrs(r[c.key]) : '-'}</td>)}
                      <td style={{ ...tdNum, fontWeight: 600 }}><Amount value={r.wages} zero="dash" />{r.currency !== 'USD' ? ` ${r.currency}` : ''}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  {totals.map((t) => (
                    <tr key={t.currency}>
                      <td style={{ ...td, fontWeight: 700 }} colSpan={view === 'people' ? 5 : 1}>{totals.length > 1 ? `Total ${t.currency}` : 'Total'}</td>
                      <td style={{ ...tdNum, fontWeight: 700 }}>{view === 'people' ? '' : t.people}</td>
                      {HOUR_COLUMNS.map((c) => <td key={c.key} style={{ ...tdNum, fontWeight: 700 }}>{hrs(t[c.key])}</td>)}
                      <td style={{ ...tdNum, fontWeight: 700 }}><Amount value={t.wages} zero="dash" />{t.currency !== 'USD' ? ` ${t.currency}` : ''}</td>
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
        <div style={{ ...card, overflow: 'auto' }}>
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

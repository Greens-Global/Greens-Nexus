import { useEffect, useMemo, useState } from 'react';
import { Calculator, Copy, FilePlus, RefreshCw, Save, Trash2 } from 'lucide-react';
import { api } from '../../api';
import Amount, { AmountInput, Figure, formatAmount } from './Amount';
import { SkeletonBlocks } from '../AsyncState';
import { formatDate } from '../../lib/datetime';
import { EntityPicker, ExportMenu, Pager, control } from './reportControls';
import { usePaged } from './tableHooks';
import { downloadBlob } from './reportModel';
import { FREQUENCIES, PLAN_KINDS, RATE_INDEXES, existingDebt, mortgagePlan, normalizeLoan, planImpact, planKind, scheduleTotals, t12From, yearlySchedule } from './loanMath';
import { NOI_BASES, entityNois } from './LoanStress';

// Accounting -> Loans & Financing -> Loan Planning (Charmi, item 25, Oct 15:
// "New Loan Planning / Mortgage Calculator").
//
//   Calculator     a loan amount (or purchase price and down payment), rate,
//                  amortization, term (a shorter term leaves a balloon),
//                  interest-only months, payment frequency, start date,
//                  closing costs and points. Shows the payment, total
//                  interest, balloon, cash to close and the whole schedule by
//                  month or by year, exported like every other table.
//   DSCR check     pick the entity the loan is for: its NOI (the basis and
//                  addback kept on the Stress Test - T12 by default) against
//                  its open loans' debt service sized the way the Stress Test
//                  sizes it, plus this loan's, and the Max Loan at the target
//                  DSCR (1.25x unless typed).
//   Planned Loans  a calculation worth keeping is saved by name per entity
//                  with its lender, expected close date and notes; two or
//                  three are compared side by side. Editors save and remove;
//                  viewers open and compare.
// The arithmetic is loanMath.js (tested in loanPlanning.test.js).
//
// Oct 22 (Neil, Oct 16): the Mortgage Calculator is the Loan Calculator, in
// three sections - Residential and Commercial (basic: ten inputs at most;
// Commercial's shorter term leaves a balloon) and Other (everything: purchase
// price, closing costs, points, extra principal every payment or once, rate
// periods). A Fixed or Variable rate; Variable is an index (SOFR, 10-Year
// Treasury, Prime, Custom) plus a margin, and the index can be pulled live
// (GET /accounting/loan-plans/index-rate - the New York Fed and the US
// Treasury, Prime derived from the Fed funds target). Beside the P&I payment,
// the interest expense alone: the interest-only payment at the rate, interest
// in the first year and per year on average, and the total. A plan saved
// before the sections opens in the one it fits (loanMath.planKind).
//
// Props: { loans (the open loans of the Loans review), entities (the entity
// list), picked (the entity filter on top), canEdit, to (the period end the
// NOI and balances are as of) }.

const card = { backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, boxShadow: 'var(--shadow-sm)' };
const bad = { border: '1px solid var(--bad-fg, #dc2626)', color: 'var(--bad-fg, #dc2626)', borderRadius: 8, padding: '8px 12px', fontSize: '0.84rem' };
const hint = { fontSize: '0.78rem', color: 'var(--text-secondary)' };
const label = { fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' };
const num = { textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 };
const btn = { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', height: 30, padding: '0 12px' };
const input = { ...control, width: '100%' };
const sectionTitle = { fontSize: '0.74rem', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--text-muted)' };
const pct = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? '-' : `${Number(v).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}%`);
const x = (v) => (v == null ? '-' : `${Number(v).toFixed(2)}x`);
const MAX_COMPARE = 3;
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const years = (v) => (v === '' || v == null ? '-' : `${Number(v)} ${Number(v) === 1 ? 'Year' : 'Years'}`);

const EMPTY_PLAN = {
  kind: 'commercial', rateType: 'fixed', index: 'sofr', indexRatePct: '', marginPct: '', indexAsOf: '',
  usePurchase: false, loanAmount: null, purchasePrice: null, downPct: 25, ratePct: '', amortYears: 30, termYears: 10, ioMonths: 0,
  frequency: 'monthly', startDate: '', closingCosts: null, pointsPct: '', extraPayment: null, extraPayments: [], ratePeriods: [],
  dscrTarget: 1.25, noi: null, lender: '', closeDate: '', notes: '',
};
// The amortization / term a section opens with (applied on a switch only while
// the figures are still the other section's defaults - typed ones are kept).
const SECTION_DEFAULTS = { residential: { amortYears: 30, termYears: 30 }, commercial: { amortYears: 30, termYears: 10 }, other: null };
const indexLabel = (k) => (RATE_INDEXES.find((i) => i.key === k) || RATE_INDEXES[0]).label;
const rateNote = (p) => (p?.rateType === 'variable' ? `${indexLabel(p.index)} + ${pct(p.marginPct || 0)}` : '');

function Chip({ tone = 'muted', children, title }) {
  const tones = {
    ok: { fg: 'var(--ok-fg, #15803d)', bg: 'rgba(21,128,61,0.10)' }, bad: { fg: 'var(--bad-fg, #dc2626)', bg: 'rgba(220,38,38,0.10)' },
    muted: { fg: 'var(--text-secondary)', bg: 'var(--bg-secondary)' },
  }[tone];
  return <span title={title} style={{ display: 'inline-block', padding: '1px 8px', borderRadius: 999, fontSize: '0.7rem', fontWeight: 700, color: tones.fg, background: tones.bg, whiteSpace: 'nowrap' }}>{children}</span>;
}
const resultChip = (impact) => (impact.pass == null ? <Chip>No NOI</Chip> : impact.pass ? <Chip tone="ok">Pass</Chip> : <Chip tone="bad">Below Target</Chip>);

function Field({ id, title, children, note }) {
  return (
    <div>
      <label style={label} htmlFor={id}>{title}</label>
      {children}
      {note && <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: 3 }}>{note}</div>}
    </div>
  );
}

function Tile({ title, children, sub }) {
  return (
    <div style={{ background: 'var(--bg-secondary)', borderRadius: 10, padding: '8px 12px', minWidth: 0 }}>
      <div style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-secondary)' }}>{title}</div>
      <div style={{ fontSize: '1.02rem', fontWeight: 700, fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>{children}</div>
      {sub && <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

/**
 * NOI per entity for the plans on screen: the Stress Test's kept basis
 * (T12 / Annualized YTD / Manual) and addback, T12 from the Loans review when
 * the entity has a loan there, else read from the ledger for the twelve
 * months ending `to`.
 */
function usePlanningNoi(codes, { loans, settings, to }) {
  const fromLoans = useMemo(() => Object.fromEntries(loans.map((r) => normalizeLoan(r)).filter((l) => l.noiT12 != null).map((l) => [l.entityCode, l.noiT12])), [loans]);
  const needT12 = codes.filter((c) => (settings[c]?.noiBasis || 't12') === 't12' && fromLoans[c] == null);
  const needYtd = codes.filter((c) => settings[c]?.noiBasis === 'ytd');
  const key = `${needT12.join(',')}|${needYtd.join(',')}|${to}`;
  const [read, setRead] = useState({ key: '', t12: {}, ytd: {} });
  useEffect(() => {
    if ((!needT12.length && !needYtd.length) || !api.getLoanEntityNoi) return undefined;
    let alive = true;
    const t12 = needT12.length ? api.getLoanEntityNoi({ entities: needT12, from: t12From(to), to }).then((d) => d?.entities || {}).catch(() => ({})) : Promise.resolve({});
    const ytd = needYtd.length ? api.getLoanEntityNoi({ entities: needYtd, to }).then((d) => d?.entities || {}).catch(() => ({})) : Promise.resolve({});
    Promise.all([t12, ytd]).then(([a, b]) => { if (alive) setRead({ key, t12: a, ytd: b }); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const loading = (needT12.length > 0 || needYtd.length > 0) && read.key !== key;
  const t12 = useMemo(() => {
    const out = { ...fromLoans };
    for (const [c, v] of Object.entries(read.t12)) if (out[c] == null && v?.noi != null) out[c] = v.noi;
    return out;
  }, [fromLoans, read.t12]);
  const nois = useMemo(() => entityNois(codes, { settings, defaultBasis: 't12', t12, ytd: read.ytd }), [codes, settings, t12, read.ytd]);
  return { nois, loading };
}

/** A plan worked out against its entity. */
function evaluate(params, code, { loans, excluded, nois }) {
  const plan = mortgagePlan(params);
  const debt = existingDebt(loans, code, excluded);
  const typed = params.noi != null && params.noi !== '';
  const noi = typed ? Number(params.noi) : nois[code]?.adjusted ?? null;
  const impact = planImpact({ plan, noi, existingDebtService: debt.debtService, dscrTarget: params.dscrTarget, ratePct: plan.rate, amortYears: params.amortYears, frequency: params.frequency });
  return { plan, debt, impact, noiTyped: typed };
}

function scheduleTable(kind, plan, title, subtitle) {
  if (kind === 'year') {
    const ys = yearlySchedule(plan.rows, plan.frequency.perYear);
    const t = scheduleTotals(plan.rows);
    return {
      title, subtitle,
      columns: [{ label: 'Year', width: 70 }, { label: 'Payments', width: 80 }, { label: 'Payment', num: true, width: 110 }, { label: 'Interest', num: true, width: 110 },
        { label: 'Principal', num: true, width: 110 }, { label: 'Balloon', num: true, width: 110 }, { label: 'Year-End Balance', num: true, width: 120 }],
      rows: ys.map((y) => [String(y.year), String(y.payments), y.payment, y.interest, y.principal, y.balloon, y.balance]),
      totals: ['Total', String(plan.rows.length), t.payment, t.interest, t.principal, t.balloon, ''],
    };
  }
  const t = scheduleTotals(plan.rows);
  return {
    title, subtitle,
    columns: [{ label: '#', width: 50 }, { label: 'Date', width: 90 }, { label: 'Payment', num: true, width: 110 }, { label: 'Interest', num: true, width: 110 },
      { label: 'Principal', num: true, width: 110 }, { label: 'Balloon', num: true, width: 110 }, { label: 'Balance', num: true, width: 120 }],
    rows: plan.rows.map((r) => [String(r.n), r.date ? formatDate(r.date) : '', r.payment, r.interest, r.principal, r.balloon, r.balance]),
    totals: ['Total', '', t.payment, t.interest, t.principal, t.balloon, ''],
  };
}

function Schedule({ plan, name }) {
  const [kind, setKind] = useState('month');
  const [exporting, setExporting] = useState('');
  const [error, setError] = useState('');
  const rows = useMemo(() => (kind === 'year' ? yearlySchedule(plan.rows, plan.frequency.perYear) : plan.rows), [kind, plan]);
  const paged = usePaged(rows, kind === 'year' ? 0 : plan.frequency.perYear * 2, [kind, plan.rows.length, plan.payment]);
  const t = scheduleTotals(plan.rows);
  const hasBalloon = plan.balloon > 0;
  const doExport = async (format) => {
    setExporting(format);
    setError('');
    try {
      const { linesFile } = await import('./linesExport');
      const subtitle = `${formatAmount(plan.amount)} at ${pct(plan.rate)} · ${plan.frequency.label} · ${plan.payments} payments${hasBalloon ? ` · balloon ${formatAmount(plan.balloon)}` : ''}`;
      const file = await linesFile(scheduleTable(kind, plan, `Amortization Schedule - ${name || 'Loan Planning'}${kind === 'year' ? ' (By Year)' : ''}`, subtitle), format);
      downloadBlob(file.name, file);
    } catch (e) {
      setError(e?.message || 'Could not export the schedule.');
    } finally {
      setExporting('');
    }
  };
  return (
    <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: '8px 10px', borderBottom: '1px solid var(--border-color)' }}>
        <strong style={{ fontSize: '0.86rem' }}>Amortization Schedule</strong>
        <div role="group" aria-label="Schedule by" style={{ display: 'inline-flex', gap: 4 }}>
          {[['month', 'By Payment'], ['year', 'By Year']].map(([k, l]) => (
            <button key={k} type="button" className={kind === k ? 'primary-btn' : 'secondary-btn'} aria-pressed={kind === k} onClick={() => setKind(k)} style={{ fontSize: '0.74rem', height: 26, padding: '0 10px' }}>{l}</button>
          ))}
        </div>
        <span style={{ ...hint, fontSize: '0.74rem' }}>{plan.payments} payments{plan.maturityDate ? `, last ${formatDate(plan.maturityDate)}` : ''}</span>
        <div style={{ marginLeft: 'auto' }}>
          <ExportMenu disabled={!plan.rows.length} items={[
            { key: 'excel', label: 'Excel', hint: 'Amounts as numbers, totals in bold', onPick: () => doExport('excel'), busy: exporting === 'excel' },
            { key: 'csv', label: 'CSV', hint: 'Plain values', onPick: () => doExport('csv'), busy: exporting === 'csv' },
            { key: 'pdf', label: 'PDF', hint: 'Banded, page numbers', onPick: () => doExport('pdf'), busy: exporting === 'pdf' },
          ]} />
        </div>
      </div>
      {error && <div style={{ ...bad, margin: 10 }}>{error}</div>}
      <div className="req-table-wrapper" style={{ overflow: 'auto', maxHeight: 520 }}>
        <table className="req-table" style={{ fontVariantNumeric: 'tabular-nums' }}>
          <thead style={{ position: 'sticky', top: 0, zIndex: 1, background: 'var(--bg-card)' }}>
            {kind === 'year'
              ? <tr><th>Year</th><th style={num}>Payments</th><th style={num}>Payment</th><th style={num}>Interest</th><th style={num}>Principal</th>{hasBalloon && <th style={num}>Balloon</th>}<th style={num}>Year-End Balance</th></tr>
              : <tr><th style={{ width: 48 }}>#</th><th>Date</th><th style={num}>Payment</th><th style={num}>Interest</th><th style={num}>Principal</th>{hasBalloon && <th style={num}>Balloon</th>}<th style={num}>Balance</th></tr>}
          </thead>
          <tbody>
            {paged.rows.map((r, i) => (
              <tr key={kind === 'year' ? r.year : r.n} style={{ background: i % 2 ? 'var(--bg-secondary)' : undefined }}>
                {kind === 'year' ? <><td>{r.year}</td><td style={num}>{r.payments}</td></> : <><td>{r.n}</td><td>{r.date ? formatDate(r.date) : '-'}</td></>}
                <td style={num}><Amount value={r.payment} zero="dash" /></td><td style={num}><Amount value={r.interest} zero="dash" /></td><td style={num}><Amount value={r.principal} zero="dash" /></td>
                {hasBalloon && <td style={num}>{r.balloon ? <strong><Amount value={r.balloon} /></strong> : <Amount value={0} zero="dash" />}</td>}
                <td style={num}><Amount value={r.balance} /></td>
              </tr>
            ))}
            <tr style={{ fontWeight: 700 }}>
              <td>Total</td><td style={kind === 'year' ? num : undefined}>{kind === 'year' ? plan.rows.length : ''}</td>
              <td style={num}><Amount value={t.payment} /></td><td style={num}><Amount value={t.interest} /></td><td style={num}><Amount value={t.principal} /></td>
              {hasBalloon && <td style={num}><Amount value={t.balloon} /></td>}<td />
            </tr>
          </tbody>
        </table>
      </div>
      <Pager page={paged.page} pages={paged.pages} from={paged.from} to={paged.to} total={paged.total} setPage={paged.setPage} style={{ padding: '6px 10px' }} />
    </div>
  );
}

function DscrCheck({ code, entityName, ev, noiInfo, noiLoading, target }) {
  const { impact, debt, plan, noiTyped } = ev;
  if (!code && !noiTyped) {
    return <div style={{ ...card, padding: '10px 12px', ...hint }}>Pick the entity the loan is for (or type its NOI) to check the DSCR and see the Max Loan at {x(target)}.</div>;
  }
  const basis = noiTyped ? 'Typed' : (NOI_BASES.find(([k]) => k === noiInfo?.basis) || NOI_BASES[0])[1];
  return (
    <div style={{ ...card, padding: '10px 12px', display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <strong style={{ fontSize: '0.86rem' }}>DSCR Check{entityName ? ` - ${entityName}` : ''}</strong>
        {resultChip(impact)}
        <span style={{ ...hint, fontSize: '0.74rem' }}>NOI {basis}{!noiTyped && noiInfo?.addback ? ' plus the Stress Test addback' : ''}; existing debt service is the entity&apos;s {debt.loans} open {debt.loans === 1 ? 'loan' : 'loans'} sized as on the Stress Test.</span>
      </div>
      {impact.noi == null ? (
        <div style={hint}>{noiLoading ? 'Reading the NOI...' : 'No NOI on file for this entity - type one under NOI to check the DSCR.'}</div>
      ) : (
        <div style={{ ...grid, gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
          <Tile title="NOI"><Amount value={impact.noi} /></Tile>
          <Tile title="Existing Debt Service" sub={impact.dscrBefore != null ? `DSCR ${x(impact.dscrBefore)}` : 'No open loans'}><Amount value={impact.existingDebtService} /></Tile>
          <Tile title="This Loan" sub={`DSCR on its own ${x(impact.dscrLoanOnly)}`}><Amount value={impact.planDebtService} /></Tile>
          <Tile title="Total Debt Service" sub={impact.dscrDuringIo != null ? `${x(impact.dscrDuringIo)} while interest only` : null}><Amount value={impact.totalDebtService} /></Tile>
          <Tile title="DSCR After" sub={`Target ${x(impact.target)}`}><span style={{ color: impact.pass === false ? 'var(--bad-fg, #dc2626)' : undefined }}>{x(impact.dscrAfter)}</span></Tile>
          <Tile title="NOI Cushion" sub="How far NOI can fall before the target breaks"><Amount value={impact.cushion} /></Tile>
          <Tile title={`Max Loan at ${x(impact.target)}`} sub={`After existing debt; ${formatAmount(impact.maxLoanStandalone)} on its own`}><Amount value={impact.maxLoan} /></Tile>
        </div>
      )}
      {plan.errors.length > 0 && impact.noi != null && <div style={hint}>Enter the rate and amortization to size the Max Loan.</div>}
    </div>
  );
}

function PlannedList({ planned, evals, entityName, selected, onToggle, onOpen, onDelete, canEdit, openId }) {
  if (!planned.length) {
    return <div style={{ ...card, padding: '10px 12px', ...hint }}>No planned loans yet.{canEdit ? ' Work one out in the calculator below and Save it to compare it with others.' : ' An editor on Accounting can save them here.'}</div>;
  }
  return (
    <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
      <div className="req-table-wrapper" style={{ overflow: 'auto' }}>
        <table className="req-table" style={{ fontVariantNumeric: 'tabular-nums' }}>
          <thead>
            <tr>
              <th title={`Compare up to ${MAX_COMPARE}`}>Compare</th><th>Name</th><th>Entity</th><th>Lender</th><th style={num}>Loan Amount</th><th style={num}>Rate</th>
              <th>Amortization / Term</th><th style={num}>Monthly Payment</th><th style={num}>Annual Debt Service</th><th style={num}>DSCR After</th><th>Result</th><th>Expected Close</th>
              {canEdit && <th style={{ width: 36 }} />}
            </tr>
          </thead>
          <tbody>
            {planned.map((p) => {
              const ev = evals[p.id];
              const on = selected.includes(p.id);
              return (
                <tr key={p.id} onClick={() => onOpen(p)} style={{ cursor: 'pointer', background: openId === p.id ? 'var(--wk-brand-tint, #e8ecfd)' : undefined }}>
                  <td onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" aria-label={`Compare ${p.name}`} checked={on} disabled={!on && selected.length >= MAX_COMPARE} onChange={() => onToggle(p.id)} />
                  </td>
                  <td><strong>{p.name}</strong>{p.params?.notes ? <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', maxWidth: 260, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={p.params.notes}>{p.params.notes}</div> : null}</td>
                  <td>{entityName(p.entityCode)}</td>
                  <td>{p.params?.lender || '-'}</td>
                  <td style={num}><Amount value={ev.plan.amount} zero="dash" /></td>
                  <td style={num}>{pct(ev.plan.rate)}{rateNote(p.params) && <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>{rateNote(p.params)}</div>}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{years(p.params?.amortYears)} / {years(p.params?.termYears || p.params?.amortYears)}</td>
                  <td style={num}>{ev.plan.errors.length ? '-' : <Amount value={ev.plan.monthlyPayment} />}</td>
                  <td style={num}>{ev.plan.errors.length ? '-' : <Amount value={ev.plan.annualDebtService} />}</td>
                  <td style={num}><Figure text={x(ev.impact.dscrAfter)} /></td>
                  <td>{resultChip(ev.impact)}</td>
                  <td>{p.params?.closeDate ? formatDate(p.params.closeDate) : '-'}</td>
                  {canEdit && (
                    <td onClick={(e) => e.stopPropagation()}>
                      <button type="button" aria-label={`Remove ${p.name}`} title="Remove" onClick={() => onDelete(p)} style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'inline-flex', padding: 2 }}><Trash2 size={14} /></button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Compare({ items, entityName, onClear }) {
  const line = (title, render) => ({ title, render });
  const lines = [
    line('Entity', (p) => entityName(p.entityCode)),
    line('Lender', (p) => p.params?.lender || '-'),
    line('Loan Amount', (p, ev) => <Amount value={ev.plan.amount} />),
    line('Section', (p, ev) => (PLAN_KINDS.find((k) => k.key === ev.plan.kind) || PLAN_KINDS[1]).label),
    line('Rate', (p, ev) => pct(ev.plan.rate)),
    line('Rate Type', (p) => (p.params?.rateType === 'variable' ? `Variable (${rateNote(p.params)})` : 'Fixed')),
    line('Amortization', (p) => years(p.params?.amortYears)),
    line('Term', (p) => years(p.params?.termYears || p.params?.amortYears)),
    line('Interest-Only', (p) => (Number(p.params?.ioMonths) ? `${p.params.ioMonths} Months` : 'None')),
    line('Payment Frequency', (p, ev) => ev.plan.frequency.label),
    line('Monthly Payment (P&I)', (p, ev) => (ev.plan.errors.length ? '-' : <Amount value={ev.plan.monthlyPayment} />)),
    line('Interest-Only Payment', (p, ev) => (ev.plan.ioPayment ? <Amount value={ev.plan.ioPayment} /> : '-')),
    line('Annual Debt Service', (p, ev) => <Amount value={ev.plan.annualDebtService} zero="dash" />),
    line('Interest Expense, First Year', (p, ev) => <Amount value={ev.plan.firstYearInterest} zero="dash" />),
    line('Interest Expense per Year (Average)', (p, ev) => <Amount value={ev.plan.avgAnnualInterest} zero="dash" />),
    line('Total Interest', (p, ev) => <Amount value={ev.plan.totalInterest} zero="dash" />),
    line('Balloon at Maturity', (p, ev) => (ev.plan.balloon ? <Amount value={ev.plan.balloon} /> : 'None')),
    line('Maturity', (p, ev) => (ev.plan.maturityDate ? formatDate(ev.plan.maturityDate) : '-')),
    line('Closing Costs and Points', (p, ev) => <Amount value={ev.plan.upfrontCosts} zero="dash" />),
    line('NOI', (p, ev) => (ev.impact.noi == null ? '-' : <Amount value={ev.impact.noi} />)),
    line('Total Debt Service', (p, ev) => <Amount value={ev.impact.totalDebtService} zero="dash" />),
    line('DSCR Before', (p, ev) => x(ev.impact.dscrBefore)),
    line('DSCR After', (p, ev) => x(ev.impact.dscrAfter)),
    line('Result', (p, ev) => resultChip(ev.impact)),
    line('Max Loan at Target', (p, ev) => (ev.impact.maxLoan == null ? '-' : <Amount value={ev.impact.maxLoan} />)),
    line('Expected Close', (p) => (p.params?.closeDate ? formatDate(p.params.closeDate) : '-')),
  ];
  // The lowest payment / highest DSCR stands out.
  const best = (pick, low) => {
    const vals = items.map(({ ev }) => pick(ev)).filter((v) => v != null && !Number.isNaN(v));
    return vals.length > 1 ? (low ? Math.min(...vals) : Math.max(...vals)) : null;
  };
  const bestPay = best((ev) => (ev.plan.errors.length ? null : ev.plan.monthlyPayment), true);
  const bestDscr = best((ev) => ev.impact.dscrAfter, false);
  const mark = (title, ev) => (title === 'Monthly Payment (P&I)' && bestPay != null && ev.plan.monthlyPayment === bestPay)
    || (title === 'DSCR After' && bestDscr != null && ev.impact.dscrAfter === bestDscr);
  return (
    <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderBottom: '1px solid var(--border-color)' }}>
        <strong style={{ fontSize: '0.86rem' }}>Compare Planned Loans</strong>
        <span style={{ ...hint, fontSize: '0.74rem' }}>The lowest payment and the highest DSCR are in bold.</span>
        <button type="button" className="secondary-btn" onClick={onClear} style={{ ...btn, height: 26, marginLeft: 'auto' }}>Clear</button>
      </div>
      <div className="req-table-wrapper" style={{ overflow: 'auto' }}>
        <table className="req-table" style={{ fontVariantNumeric: 'tabular-nums' }}>
          <thead><tr><th style={{ minWidth: 170 }} />{items.map(({ p }) => <th key={p.id} style={{ ...num, minWidth: 160 }}>{p.name}</th>)}</tr></thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.title}>
                <td style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>{l.title}</td>
                {items.map(({ p, ev }) => <td key={p.id} style={{ ...num, fontWeight: mark(l.title, ev) ? 700 : undefined }}>{l.render(p, ev)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const fromSaved = (p) => ({ ...EMPTY_PLAN, ...(p.params || {}), kind: planKind(p.params || {}) });

// A list of rows of numbers (Other's one-time extra payments and rate
// periods): one line each, Add and Remove.
function RowsEditor({ id, title, rows = [], fields, addLabel, onChange, note }) {
  const setRow = (i, k, v) => onChange(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <span style={label} id={`${id}-label`}>{title}</span>
      {rows.map((r, i) => (
        <div key={i} role="group" aria-label={`${title} ${i + 1}`} style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          {fields.map((f) => (f.amount
            ? <AmountInput key={f.key} id={`${id}-${i}-${f.key}`} value={r[f.key] ?? null} onChange={(v) => setRow(i, f.key, v)} aria-label={`${f.label} ${i + 1}`} placeholder={f.label} style={{ ...control, width: 150 }} />
            : <input key={f.key} type="number" min={f.min ?? 0} step={f.step ?? 1} value={r[f.key] ?? ''} onChange={(e) => setRow(i, f.key, e.target.value)} aria-label={`${f.label} ${i + 1}`} placeholder={f.label} style={{ ...control, width: 130 }} />))}
          <button type="button" className="secondary-btn" onClick={() => onChange(rows.filter((_x, j) => j !== i))} aria-label={`Remove ${title} ${i + 1}`} style={{ ...btn, height: 28, padding: '0 8px' }}><Trash2 size={13} /></button>
        </div>
      ))}
      <div><button type="button" className="secondary-btn" onClick={() => onChange([...rows, {}])} style={{ ...btn, height: 28 }}>{addLabel}</button></div>
      {note && <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>{note}</div>}
    </div>
  );
}

export default function LoanPlanning({ loans = [], entities = [], picked = [], canEdit = false, to = '' }) {
  const [planned, setPlanned] = useState(undefined);       // undefined = reading
  const [loadError, setLoadError] = useState('');
  const [settings, setSettings] = useState({});
  const [excluded, setExcluded] = useState(() => new Set());
  const [form, setForm] = useState(() => ({ ...EMPTY_PLAN, startDate: todayIso() }));
  const [meta, setMeta] = useState(() => ({ id: null, name: '', entityCode: picked.length === 1 ? picked[0] : '' }));
  const [selected, setSelected] = useState([]);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);
  const [live, setLive] = useState(null);           // the live index read: { index, ratePct, asOf, source, note, stale } | { error }
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const switchKind = (kind) => setForm((f) => {
    const from = SECTION_DEFAULTS[f.kind];
    const to = SECTION_DEFAULTS[kind];
    const untouched = from && Number(f.amortYears) === from.amortYears && Number(f.termYears) === from.termYears;
    return { ...f, kind, ...(to && untouched ? to : {}) };
  });
  const pullIndex = () => {
    if (!api.getLoanIndexRate || form.index === 'custom') return;
    setBusy('index');
    setLive(null);
    api.getLoanIndexRate(form.index)
      .then((d) => { setLive(d); set({ indexRatePct: d.ratePct, indexAsOf: d.asOf || '' }); })
      .catch((e) => setLive({ error: e?.message || 'Could not read the rate just now. Type it instead.' }))
      .finally(() => setBusy(''));
  };

  useEffect(() => {
    let alive = true;
    api.getPlannedLoans().then((d) => { if (alive) setPlanned(d?.planned || []); })
      .catch((e) => { if (alive) { setPlanned([]); setLoadError(e?.message || 'Could not read the planned loans.'); } });
    api.getLoanStressSettings?.()
      ?.then((d) => { if (alive) { setSettings(d?.entities || {}); setExcluded(new Set(d?.excluded || [])); } })
      ?.catch(() => { /* none kept, or not available here: T12 */ });
    return () => { alive = false; };
  }, []);

  const shown = useMemo(() => (planned || []).filter((p) => !picked.length || picked.includes(p.entityCode)), [planned, picked]);
  const codes = useMemo(() => [...new Set([meta.entityCode, ...shown.map((p) => p.entityCode)].filter(Boolean))].sort(), [meta.entityCode, shown]);
  const { nois, loading: noiLoading } = usePlanningNoi(codes, { loans, settings, to: to || todayIso() });
  const names = useMemo(() => {
    const m = new Map(entities.map((e) => [e.code, e.name]));
    loans.forEach((r) => { const l = normalizeLoan(r); if (l.entityCode && !m.has(l.entityCode)) m.set(l.entityCode, l.entityName); });
    return m;
  }, [entities, loans]);
  const entityName = (code) => (code ? `${names.get(code) || 'Entity'} (${code})` : '-');
  const pickerEntities = useMemo(() => (entities.length ? entities : [...names.entries()].map(([code, name]) => ({ code, name }))), [entities, names]);

  const ctx = { loans, excluded, nois };
  const ev = evaluate(form, meta.entityCode, ctx);
  const evals = Object.fromEntries(shown.map((p) => [p.id, evaluate(fromSaved(p), p.entityCode, ctx)]));
  const compareItems = selected.map((id) => shown.find((p) => p.id === id)).filter(Boolean).map((p) => ({ p, ev: evals[p.id] }));
  const plan = ev.plan;
  const ok = !plan.errors.length;
  const dirtyName = meta.name.trim();

  const startNew = () => { setLive(null); setForm((f) => ({ ...EMPTY_PLAN, kind: f.kind, ...(SECTION_DEFAULTS[f.kind] || {}), startDate: todayIso() })); setMeta({ id: null, name: '', entityCode: picked.length === 1 ? picked[0] : '' }); setMsg(null); };
  const open = (p) => { setLive(null); setForm(fromSaved(p)); setMeta({ id: p.id, name: p.name, entityCode: p.entityCode }); setMsg(null); };
  const toggle = (id) => setSelected((s) => (s.includes(id) ? s.filter((v) => v !== id) : s.length >= MAX_COMPARE ? s : [...s, id]));
  // Half-typed rows of Other's lists are not kept (the API takes numbers only).
  const filled = (v) => v !== '' && v != null && !Number.isNaN(Number(v));
  const body = () => ({
    name: dirtyName, entityCode: meta.entityCode,
    params: {
      ...form,
      extraPayments: (form.extraPayments || []).filter((r) => filled(r.n) && Number(r.n) >= 1 && filled(r.amount)).map((r) => ({ n: Number(r.n), amount: Number(r.amount) })),
      ratePeriods: (form.ratePeriods || []).filter((r) => filled(r.fromPayment) && Number(r.fromPayment) >= 1 && filled(r.ratePct)).map((r) => ({ fromPayment: Number(r.fromPayment), ratePct: Number(r.ratePct) })),
    },
  });
  const save = (asNew) => {
    if (!dirtyName) { setMsg({ text: 'Name the planned loan to save it.', bad: true }); return; }
    if (!meta.entityCode) { setMsg({ text: 'Pick the entity the loan is for to save it.', bad: true }); return; }
    setBusy('save');
    const call = meta.id && !asNew ? api.updatePlannedLoan(meta.id, body()) : api.createPlannedLoan(body());
    call.then((d) => {
      const p = d?.planned;
      if (!p) return;
      setPlanned((list) => [p, ...(list || []).filter((y) => y.id !== p.id)]);
      setMeta({ id: p.id, name: p.name, entityCode: p.entityCode });
      setMsg({ text: `Saved ${p.name}.` });
    }).catch((e) => setMsg({ text: e?.message || 'Could not save the planned loan.', bad: true })).finally(() => setBusy(''));
  };
  const remove = (p) => {
    if (!window.confirm(`Remove the planned loan "${p.name}"?`)) return;
    api.deletePlannedLoan(p.id).then(() => {
      setPlanned((list) => (list || []).filter((y) => y.id !== p.id));
      setSelected((s) => s.filter((v) => v !== p.id));
      if (meta.id === p.id) setMeta((m) => ({ ...m, id: null }));
      setMsg({ text: `Removed ${p.name}.` });
    }).catch((e) => setMsg({ text: e?.message || 'Could not remove it.', bad: true }));
  };

  const freq = plan.frequency;
  const other = form.kind === 'other';
  const variable = form.rateType === 'variable';
  const indexNote = live?.error ? <span style={{ color: 'var(--bad-fg, #dc2626)' }}>{live.error}</span>
    : live && live.index === form.index && form.indexAsOf
      ? `${live.label || indexLabel(form.index)} ${pct(live.ratePct)} as of ${formatDate(live.asOf)}${live.stale ? ' (the last rate read - the source did not answer)' : ''} - ${live.source}${live.note ? `. ${live.note}` : ''}`
      : form.indexAsOf ? `As of ${formatDate(form.indexAsOf)}` : form.index === 'custom' ? 'Type the index rate' : 'Type it, or Pull Live Rate';
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {msg && (
        <div role="status" style={{ ...card, padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 10, fontSize: '0.82rem', color: msg.bad ? 'var(--bad-fg, #dc2626)' : 'var(--ok-fg, #15803d)' }}>
          <span style={{ flex: 1 }}>{msg.text}</span>
          <button type="button" className="secondary-btn" onClick={() => setMsg(null)} style={{ fontSize: '0.74rem', padding: '2px 10px' }}>Dismiss</button>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={sectionTitle}>Planned Loans</span>
        {planned && <span style={{ ...hint, fontSize: '0.74rem' }}>{shown.length} {shown.length === 1 ? 'loan' : 'loans'}{picked.length ? ' in the entities picked' : ''} · tick two or three to compare · click one to open it</span>}
      </div>
      {loadError && <div style={bad}>{loadError}</div>}
      {planned === undefined ? <SkeletonBlocks count={2} /> : (
        <PlannedList planned={shown} evals={evals} entityName={entityName} selected={selected} onToggle={toggle} onOpen={open} onDelete={remove} canEdit={canEdit} openId={meta.id} />
      )}
      {compareItems.length >= 2 && <Compare items={compareItems} entityName={entityName} onClear={() => setSelected([])} />}

      <div style={{ ...card, padding: 14, display: 'grid', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Calculator size={16} style={{ color: 'var(--wk-brand, #2b45e1)' }} />
          <strong style={{ fontSize: '0.92rem' }}>{meta.id ? `Planned Loan - ${meta.name}` : 'Loan Calculator'}</strong>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="secondary-btn" style={btn} onClick={startNew}><FilePlus size={14} /> New Calculation</button>
            {canEdit && meta.id && <button type="button" className="secondary-btn" style={btn} disabled={busy === 'save' || !ok} onClick={() => save(true)}><Copy size={14} /> Save as New</button>}
            {canEdit && <button type="button" className="primary-btn" style={btn} disabled={busy === 'save' || !ok} onClick={() => save(false)}><Save size={14} /> {busy === 'save' ? 'Saving...' : meta.id ? 'Save Changes' : 'Save Planned Loan'}</button>}
          </div>
        </div>

        <div className="scroll-tabs" role="tablist" aria-label="Loan Calculator" style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border-color)' }}>
          {PLAN_KINDS.map((k) => (
            <button key={k.key} type="button" role="tab" aria-selected={form.kind === k.key} onClick={() => switchKind(k.key)}
              style={{ border: 'none', background: 'none', cursor: 'pointer', padding: '6px 12px', fontSize: '0.82rem', fontWeight: form.kind === k.key ? 700 : 500, whiteSpace: 'nowrap',
                color: form.kind === k.key ? 'var(--wk-brand, #2b45e1)' : 'var(--text-secondary)', borderBottom: `2px solid ${form.kind === k.key ? 'var(--wk-brand, #2b45e1)' : 'transparent'}`, marginBottom: -1 }}>{k.label}</button>
          ))}
        </div>
        <div style={hint}>
          {form.kind === 'residential' ? 'A home loan: the basics, fully amortizing unless the term is shorter.'
            : form.kind === 'commercial' ? 'A commercial loan: usually a shorter term than the amortization, with the balloon at maturity.'
              : 'Every option: a purchase price and down payment, closing costs and points, extra principal, and rate periods.'}
        </div>

        <span style={sectionTitle}>Loan</span>
        <div style={grid}>
          {other && (
            <Field id="lp-basis" title="Size the Loan From">
              <select id="lp-basis" value={form.usePurchase ? 'purchase' : 'amount'} onChange={(e) => set({ usePurchase: e.target.value === 'purchase' })} style={input}>
                <option value="amount">Loan Amount</option><option value="purchase">Purchase Price and Down Payment</option>
              </select>
            </Field>
          )}
          {other && form.usePurchase ? <>
            <Field id="lp-price" title="Purchase Price"><AmountInput id="lp-price" value={form.purchasePrice} onChange={(v) => set({ purchasePrice: v })} style={input} /></Field>
            <Field id="lp-down" title="Down Payment %" note={plan.ltvPct != null ? `Loan ${formatAmount(plan.amount)} · LTV ${plan.ltvPct}%` : null}>
              <input id="lp-down" type="number" min="0" max="100" step="0.5" value={form.downPct ?? ''} onChange={(e) => set({ downPct: e.target.value })} style={input} />
            </Field>
          </> : (
            <Field id="lp-amount" title="Loan Amount"><AmountInput id="lp-amount" value={form.loanAmount} onChange={(v) => set({ loanAmount: v })} style={input} /></Field>
          )}
          <Field id="lp-rate-type" title="Fixed or Variable">
            <select id="lp-rate-type" value={form.rateType || 'fixed'} onChange={(e) => set({ rateType: e.target.value })} style={input}><option value="fixed">Fixed</option><option value="variable">Variable</option></select>
          </Field>
          {variable ? <>
            <Field id="lp-index" title="Index">
              <select id="lp-index" value={form.index || 'sofr'} onChange={(e) => { set({ index: e.target.value }); setLive(null); }} style={input}>{RATE_INDEXES.map((i) => <option key={i.key} value={i.key}>{i.label}</option>)}</select>
            </Field>
            <Field id="lp-index-rate" title="Index Rate %" note={indexNote}>
              <div style={{ display: 'flex', gap: 6 }}>
                <input id="lp-index-rate" type="number" min="-5" max="50" step="0.01" value={form.indexRatePct ?? ''} onChange={(e) => set({ indexRatePct: e.target.value, indexAsOf: '' })} style={{ ...input, flex: 1, minWidth: 0 }} />
                {form.index !== 'custom' && api.getLoanIndexRate && (
                  <button type="button" className="secondary-btn" onClick={pullIndex} disabled={busy === 'index'} title={`Read today's ${indexLabel(form.index)} from a public source`} style={{ ...btn, height: 30, padding: '0 8px', whiteSpace: 'nowrap' }}>
                    <RefreshCw size={13} /> {busy === 'index' ? 'Reading...' : 'Pull Live Rate'}
                  </button>
                )}
              </div>
            </Field>
            <Field id="lp-margin" title="Margin %" note={plan.rate != null && form.indexRatePct !== '' ? `Rate now ${pct(plan.rate)}` : 'Added to the index'}>
              <input id="lp-margin" type="number" min="-20" max="30" step="0.05" value={form.marginPct ?? ''} onChange={(e) => set({ marginPct: e.target.value })} style={input} />
            </Field>
          </> : (
            <Field id="lp-rate" title="Interest Rate %"><input id="lp-rate" type="number" min="0" max="50" step="0.125" value={form.ratePct ?? ''} onChange={(e) => set({ ratePct: e.target.value })} style={input} /></Field>
          )}
          <Field id="lp-amort" title="Amortization (Years)"><input id="lp-amort" type="number" min="1" max="100" value={form.amortYears ?? ''} onChange={(e) => set({ amortYears: e.target.value })} style={input} /></Field>
          <Field id="lp-term" title="Term (Years)" note={form.kind === 'commercial' ? 'The balloon is due at the end of the term' : 'Shorter than the amortization leaves a balloon'}><input id="lp-term" type="number" min="0" max="100" step="0.5" value={form.termYears ?? ''} onChange={(e) => set({ termYears: e.target.value })} style={input} /></Field>
          <Field id="lp-io" title="Interest-Only (Months)"><input id="lp-io" type="number" min="0" max="1200" value={form.ioMonths ?? ''} onChange={(e) => set({ ioMonths: e.target.value })} style={input} /></Field>
          <Field id="lp-freq" title="Payment Frequency">
            <select id="lp-freq" value={form.frequency} onChange={(e) => set({ frequency: e.target.value })} style={input}>{FREQUENCIES.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}</select>
          </Field>
          <Field id="lp-start" title="Start Date" note="The first payment is one period later"><input id="lp-start" type="date" value={form.startDate || ''} onChange={(e) => set({ startDate: e.target.value })} style={input} /></Field>
          {other && <>
            <Field id="lp-closing" title="Closing Costs"><AmountInput id="lp-closing" value={form.closingCosts} onChange={(v) => set({ closingCosts: v })} style={input} /></Field>
            <Field id="lp-points" title="Points %" note={plan.points ? `${formatAmount(plan.points)}` : null}><input id="lp-points" type="number" min="0" max="20" step="0.125" value={form.pointsPct ?? ''} onChange={(e) => set({ pointsPct: e.target.value })} style={input} /></Field>
            <Field id="lp-extra" title="Extra Principal per Payment" note={plan.totalExtra ? `${formatAmount(plan.totalExtra)} extra in all` : null}><AmountInput id="lp-extra" value={form.extraPayment} onChange={(v) => set({ extraPayment: v })} style={input} /></Field>
          </>}
        </div>
        {other && (
          <div style={{ ...grid, gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
            <RowsEditor id="lp-once" title="One-Time Extra Payments" rows={form.extraPayments || []} addLabel="Add an Extra Payment" onChange={(v) => set({ extraPayments: v })}
              fields={[{ key: 'n', label: 'Payment #', min: 1 }, { key: 'amount', label: 'Amount', amount: true }]} note="Extra principal paid with that payment." />
            <RowsEditor id="lp-steps" title="Rate Periods" rows={form.ratePeriods || []} addLabel="Add a Rate Period" onChange={(v) => set({ ratePeriods: v })}
              fields={[{ key: 'fromPayment', label: 'From Payment #', min: 1 }, { key: 'ratePct', label: 'Rate %', step: 0.125 }]} note="From that payment on, the rate changes and the payment is re-sized over the rest of the amortization." />
          </div>
        )}

        <span style={sectionTitle}>Plan and DSCR</span>
        <div style={grid}>
          <Field id="lp-name" title="Name"><input id="lp-name" type="text" maxLength={120} placeholder="e.g. Chase 10/30 Refinance" value={meta.name} onChange={(e) => setMeta((m) => ({ ...m, name: e.target.value }))} style={input} /></Field>
          <div>
            <span style={label}>Entity</span>
            <EntityPicker entities={pickerEntities} value={meta.entityCode} onChange={(code) => setMeta((m) => ({ ...m, entityCode: code || '' }))} placeholder="Pick an Entity" ariaLabel="Entity the loan is for" style={{ width: '100%' }} />
          </div>
          <Field id="lp-lender" title="Lender"><input id="lp-lender" type="text" maxLength={120} value={form.lender || ''} onChange={(e) => set({ lender: e.target.value })} style={input} /></Field>
          <Field id="lp-close" title="Expected Close"><input id="lp-close" type="date" value={form.closeDate || ''} onChange={(e) => set({ closeDate: e.target.value })} style={input} /></Field>
          <Field id="lp-target" title="DSCR Target"><input id="lp-target" type="number" min="0.5" max="10" step="0.05" value={form.dscrTarget ?? ''} onChange={(e) => set({ dscrTarget: e.target.value })} style={input} /></Field>
          <Field id="lp-noi" title="NOI" note={ev.noiTyped ? 'Typed - clear it to use the entity\'s' : nois[meta.entityCode]?.adjusted != null ? `Entity's: ${formatAmount(nois[meta.entityCode].adjusted)}` : 'Optional - the entity\'s when blank'}>
            <AmountInput id="lp-noi" value={form.noi} onChange={(v) => set({ noi: v })} placeholder={nois[meta.entityCode]?.adjusted != null ? formatAmount(nois[meta.entityCode].adjusted) : '0.00'} style={input} />
          </Field>
        </div>
        <Field id="lp-notes" title="Notes"><textarea id="lp-notes" rows={2} maxLength={2000} value={form.notes || ''} onChange={(e) => set({ notes: e.target.value })} style={{ ...input, height: 'auto', padding: '6px 9px', resize: 'vertical' }} /></Field>

        {!ok ? <div style={hint}>{plan.errors.join(' ')}</div> : (
          <div style={{ ...grid, gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
            <Tile title="Monthly Payment (P&I)" sub={freq.key !== 'monthly' ? `${freq.label} payment ${formatAmount(plan.payment)}` : plan.ioPayment ? 'After the interest-only months' : null}><Amount value={plan.monthlyPayment} /></Tile>
            {plan.ioPayment > 0 && <Tile title="Interest-Only Payment" sub={`${plan.ioPayments} ${freq.key === 'monthly' ? 'months' : 'payments'}`}><Amount value={plan.ioPayment} /></Tile>}
            <Tile title="Annual Debt Service" sub={plan.ioPayment ? `First year ${formatAmount(plan.firstYearDebtService)}` : null}><Amount value={plan.annualDebtService} /></Tile>
            <Tile title="Balloon at Maturity" sub={plan.maturityDate ? formatDate(plan.maturityDate) : null}>{plan.balloon ? <Amount value={plan.balloon} /> : 'None'}</Tile>
            {plan.upfrontCosts > 0 && <Tile title="Closing Costs and Points" sub={`Net proceeds ${formatAmount(plan.netProceeds)}`}><Amount value={plan.upfrontCosts} /></Tile>}
            {plan.cashToClose != null && <Tile title="Cash to Close" sub={`Down payment ${formatAmount(plan.downPayment)}`}><Amount value={plan.cashToClose} /></Tile>}
          </div>
        )}
        {ok && <>
          <span style={sectionTitle}>Interest Expense Only</span>
          <div role="group" aria-label="Interest Expense Only" style={{ ...grid, gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
            <Tile title="Interest-Only Payment" sub={`${freq.label} at ${pct(plan.rate)}${freq.key !== 'monthly' ? ` · ${formatAmount(plan.interestOnlyMonthly)} a month` : ''}`}><Amount value={plan.interestOnlyPayment} /></Tile>
            <Tile title="Interest per Year" sub={`At ${pct(plan.rate)} on the full amount`}><Amount value={plan.interestOnlyAnnual} /></Tile>
            <Tile title="Interest Expense, First Year" sub="On the schedule"><Amount value={plan.firstYearInterest} /></Tile>
            <Tile title="Interest Expense per Year" sub="Average over the schedule"><Amount value={plan.avgAnnualInterest} /></Tile>
            <Tile title="Total Interest"><Amount value={plan.totalInterest} /></Tile>
          </div>
        </>}
      </div>

      <DscrCheck code={meta.entityCode} entityName={meta.entityCode ? entityName(meta.entityCode) : ''} ev={ev} noiInfo={nois[meta.entityCode]} noiLoading={noiLoading} target={Number(form.dscrTarget) || 1.25} />
      {ok && <Schedule plan={plan} name={dirtyName || (meta.entityCode ? entityName(meta.entityCode) : '')} />}
    </div>
  );
}

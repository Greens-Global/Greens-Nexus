import { useCallback, useEffect, useMemo, useState } from 'react';
import { ExternalLink, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { api } from '../../api';
import Amount, { AmountInput, formatAmount } from './Amount';
import { formatDate } from '../../lib/datetime';
import { ControlBar, CustomizeButton, DENSITIES, EntityPicker, ExportMenu, GlAccountPicker, Pager, SyncButton, control } from './reportControls';
import {
  MGMT_FEE_DEFAULT_BASIS, MGMT_FEE_DEFAULT_FLAT, MGMT_FEE_DEFAULT_MONTHLY_MINIMUM, MGMT_FEE_DEFAULT_PERIOD, MGMT_FEE_DEFAULT_RATE, MGMT_FEE_DEFAULT_THRESHOLD, MGMT_FEE_DEFAULT_THRESHOLD_BASIS, MGMT_FEE_TIER_FLAT_IS_ANNUAL,
} from './assumptions';
import { useCustomizePrefs, useFitHeight, usePaged } from './tableHooks';
import { TableViewBar, ViewHead, useTableView, viewCells, viewTable } from './tableView';
import { downloadBlob } from './reportModel';
import { linesFile } from './linesExport';
import { useTableSync } from './tableSync';
import { cellStyle, headStyle } from './columnStyles';
import { requestReportDrill } from './drill';
import { Chip } from './LoanSetupDialog';
import { Dialog } from './LoanDialogs';
import { notAvailable } from './LoansTab';

// Accounting -> Reporting -> Management Fees, the Asset Management Agreements
// (Priyanka, Oct 7: "We still need to build AMA"). Oct 15 (Neil): AMA means
// Ask My Accountant (AskAccountantTab.jsx), so this screen is "Management
// Fees" in the menu and its title; its sub key, its API (/accounting/ama/*)
// and its saved column widths ('ama') did not move, so no data changed. The old mock (the "AMA Entity Billing
// Tracker", removed in 78bf25db) listed entity, status, fee rate, billed YTD,
// next billing and the agreement; this is the real version, kept simple and
// editable:
//   - One row per agreement: the managed entity, the manager entity that
//     earns the fee, the status, the fee (a percent of the managed entity's
//     revenue, or a flat amount per billing period), Billed YTD (the net
//     credits on the fee GL account, read from the ledger - click it for the
//     lines in Reports), Expected YTD, the difference and the next billing.
//   - + Add Agreement / the pencil open the editor; the trash removes one,
//     confirmed in place (Remove / Keep - no browser dialog).
//   - The module's standard table controls: filter, Customize (Row Density,
//     Rows per Page, Show Historical Entities), resizable columns, a Pager.
//   - A ledger read that fails shows on its own row; the list still draws.
//
// Oct 23 (Charmi, 22 Oct call, CR-03): the fee can be the operating
// agreement's rule - "Percent or Flat": X% of the managed entity's gross when
// the gross is above a threshold, else a flat amount, each set per agreement.
// A Period picker (Year to Date, a quarter, a month) drives two new columns,
// Gross Revenue (read from the ledger) and Calculated Fee; Billed / Expected
// YTD run through the period's end. Fee GL Account is a searchable picker.
// Every default an open question left to us is in ./assumptions.js.
//
// Oct 23, team answer (Neil): "Usually it's 3% of gross revenue or
// $3,000/month, whichever is higher ... built in property by property" - the
// Greater Of basis, each agreement with its own rate and monthly minimum, the
// default for a new agreement. The Calculated Fee cell says which rule
// applied (Percent / Minimum / Mixed, the months on each side in its tooltip).

const card = { backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, boxShadow: 'var(--shadow-sm)' };
const bad = { border: '1px solid var(--bad-fg, #dc2626)', color: 'var(--bad-fg, #dc2626)', borderRadius: 8, padding: '8px 12px', fontSize: '0.84rem' };
const num = { textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const dash = <span style={{ color: 'var(--text-muted)' }}>-</span>;
const label = { fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' };
const fieldError = { fontSize: '0.7rem', color: 'var(--bad-fg, #dc2626)', marginTop: 3 };
const hint = { fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 3 };
const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 };
const full = { ...control, width: '100%' };

export const STATUSES = ['Active', 'Pending Review', 'Ended'];
export const FREQUENCIES = ['Monthly', 'Quarterly', 'Annually'];
const STATUS_TONE = { Active: 'ok', 'Pending Review': 'wait', Ended: 'muted' };
export const BASES = [['greater_of', 'Greater of Percent or Monthly Minimum'], ['percent_revenue', 'Percent of Revenue'], ['flat', 'Flat Amount'], ['percent_or_flat', 'Percent or Flat (Threshold)']];
const TIER = { percent: ['ok', 'Percent'], flat: ['muted', 'Flat'], minimum: ['muted', 'Minimum'], mixed: ['wait', 'Mixed'] };
const months = (n) => `${n} ${n === 1 ? 'month' : 'months'}`;
export const THRESHOLD_BASES = [['annual', 'Annual Gross'], ['period', 'Period Gross']];
const basisName = (k) => THRESHOLD_BASES.find(([x]) => x === k)?.[1] || k;
const FLAT_PER = MGMT_FEE_TIER_FLAT_IS_ANNUAL ? 'a year' : 'per billing period';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "3.50% of revenue" / "$2,500.00 Monthly" / "3.00% of gross over $100,000.00, else $3,000.00 a year". */
export function feeText(a) {
  if (a.feeBasis === 'flat') return `$${formatAmount(a.flatAmount)} ${a.billingFrequency || 'Monthly'}`;
  if (a.feeBasis === 'greater_of') return `${Number(a.feeRate || 0).toFixed(2)}% of gross or $${formatAmount(a.flatAmount ?? MGMT_FEE_DEFAULT_MONTHLY_MINIMUM)}/month, whichever is higher`;
  if (a.feeBasis === 'percent_or_flat') {
    return `${Number(a.feeRate || 0).toFixed(2)}% of gross over $${formatAmount(a.thresholdAmount ?? MGMT_FEE_DEFAULT_THRESHOLD)}, else $${formatAmount(a.flatAmount)} ${FLAT_PER}`;
  }
  return `${Number(a.feeRate || 0).toFixed(2)}% of revenue`;
}

/** The periods of `year` that have started by `today`: [[key, label]], Year to Date first. */
export function periodOptions(year, today = new Date()) {
  const last = year < today.getFullYear() ? 12 : today.getMonth() + 1;
  const out = [['ytd', year < today.getFullYear() ? 'Full Year' : 'Year to Date']];
  for (let q = 1; q <= 4; q += 1) {
    if (q * 3 - 2 <= last) out.push([`q${q}`, `Q${q} (${MONTHS[q * 3 - 3].slice(0, 3)} - ${MONTHS[q * 3 - 1].slice(0, 3)})`]);
  }
  for (let m = 1; m <= last; m += 1) out.push([`m${String(m).padStart(2, '0')}`, MONTHS[m - 1]]);
  return out;
}

/** Why the Calculated Fee is what it is, for its tooltip. */
export function calcTitle(r) {
  if (r.error) return r.error;
  if (r.calculatedFee == null) return undefined;
  if (!r.feeTier) return 'Not in force in this period';
  if (r.feeBasis === 'greater_of') {
    const pct = `${Number(r.feeRate || 0).toFixed(2)}% of gross`;
    const min = `the $${formatAmount(r.minimumUsed ?? r.flatAmount)} monthly minimum`;
    const by = r.compareBy === 'window' ? 'over the period' : 'month by month';
    if (r.feeTier === 'percent') return `${pct} was higher (${months(r.percentMonths || 0)}, compared ${by})`;
    if (r.feeTier === 'minimum') return `${min} was higher (${months(r.minimumMonths || 0)}, compared ${by})`;
    return `Compared ${by}: ${pct} in ${months(r.percentMonths || 0)}, ${min} in ${months(r.minimumMonths || 0)}`;
  }
  if (r.feeBasis === 'percent_or_flat') {
    const test = `${basisName(r.thresholdBasisUsed)} ${formatAmount(r.testGross)} is ${r.feeTier === 'percent' ? 'above' : 'not above'} the threshold ${formatAmount(r.thresholdUsed)}`;
    return r.feeTier === 'percent'
      ? `${test}: ${Number(r.feeRate || 0).toFixed(2)}% of gross ${formatAmount(r.grossRevenue)}`
      : `${test}: flat ${formatAmount(r.flatAmount)} ${FLAT_PER}, ${r.periodBillings} billing ${r.periodBillings === 1 ? 'date' : 'dates'} in the period`;
  }
  if (r.feeBasis === 'flat') return `${r.periodBillings || 0} billing ${r.periodBillings === 1 ? 'date' : 'dates'} in the period`;
  return `${Number(r.feeRate || 0).toFixed(2)}% of gross ${formatAmount(r.grossRevenue)}`;
}

/** "15000 Greens Escondido, LLC." - number first, as the entity pickers show it. */
export function entityText(entities, code) {
  if (!code) return '';
  const e = (entities || []).find((x) => x.code === code);
  return e?.name ? `${code} ${e.name}` : code;
}

/** The rows the filter lets through. */
export function visibleRows(rows, entities, text = '') {
  const q = text.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) => [entityText(entities, r.entityCode), entityText(entities, r.managerEntityCode), r.status, r.feeGlAccount, r.notes, feeText(r)]
    .some((v) => String(v || '').toLowerCase().includes(q)));
}

function SkeletonRows({ rows = 5, cols = 10 }) {
  return Array.from({ length: rows }, (_x, i) => (
    <tr key={`sk${i}`} aria-hidden="true">
      {Array.from({ length: cols }, (_y, j) => (
        <td key={j}><div className="nx-skel" style={{ height: 12, borderRadius: 4, width: j < 2 ? '80%' : '60%', '--i': i }} /></td>
      ))}
    </tr>
  ));
}

// Pencil and trash: the trash is confirmed in place, never a browser dialog.
function RowActions({ row, name, onEdit, onRemove }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  if (asking) {
    return (
      <span role="group" aria-label={`Remove the agreement of ${name}?`} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}>
        <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>Remove?</span>
        <button type="button" className="primary-btn" disabled={busy} onClick={() => { setBusy(true); onRemove(row).finally(() => { setBusy(false); setAsking(false); }); }}
          style={{ fontSize: '0.72rem', height: 24, padding: '0 8px', background: 'var(--bad-fg, #dc2626)', borderColor: 'var(--bad-fg, #dc2626)' }}>{busy ? 'Removing...' : 'Remove'}</button>
        <button type="button" className="secondary-btn" disabled={busy} onClick={() => setAsking(false)} style={{ fontSize: '0.72rem', height: 24, padding: '0 8px' }}>Keep</button>
      </span>
    );
  }
  return (
    <span style={{ display: 'inline-flex', gap: 2 }}>
      <button type="button" className="icon-btn" aria-label={`Edit the agreement of ${name}`} onClick={onEdit} style={{ padding: 4, color: 'var(--text-muted)' }}><Pencil size={13} /></button>
      <button type="button" className="icon-btn" aria-label={`Remove the agreement of ${name}`} title="Remove this agreement" onClick={() => setAsking(true)} style={{ padding: 4, color: 'var(--text-muted)' }}><Trash2 size={13} /></button>
    </span>
  );
}

const blank = () => ({
  entityCode: '', managerEntityCode: '', status: 'Active', feeBasis: MGMT_FEE_DEFAULT_BASIS,
  feeRate: MGMT_FEE_DEFAULT_BASIS === 'greater_of' ? MGMT_FEE_DEFAULT_RATE : '',
  flatAmount: MGMT_FEE_DEFAULT_BASIS === 'greater_of' ? MGMT_FEE_DEFAULT_MONTHLY_MINIMUM : null, billingFrequency: 'Monthly',
  startDate: '', endDate: '', feeGlAccount: '', agreementUrl: '', notes: '', thresholdAmount: null, thresholdBasis: '',
});

/** Field-by-field problems with an agreement being edited ({} = none). */
export function validateAgreement(d) {
  const e = {};
  if (!d.entityCode) e.entityCode = 'Pick the managed entity.';
  if (d.managerEntityCode && d.managerEntityCode === d.entityCode) e.managerEntityCode = 'The manager cannot be the managed entity.';
  if (d.feeBasis !== 'flat') {
    const r = Number(d.feeRate);
    if (d.feeRate === '' || d.feeRate == null || !(r > 0 && r <= 100)) e.feeRate = 'Type a percent above 0 and up to 100.';
  }
  if (d.feeBasis === 'greater_of') {
    if (d.flatAmount == null || d.flatAmount === '' || !(Number(d.flatAmount) >= 0)) e.flatAmount = 'Type the monthly minimum.';
  } else if (d.feeBasis !== 'percent_revenue' && !(Number(d.flatAmount) > 0)) {
    e.flatAmount = d.feeBasis === 'flat' ? 'Type the fee per billing period.' : 'Type the flat fee charged at or under the threshold.';
  }
  if (d.feeBasis === 'percent_or_flat' && (d.thresholdAmount == null || d.thresholdAmount === '' || !(Number(d.thresholdAmount) >= 0))) {
    e.thresholdAmount = 'Type the gross income threshold.';
  }
  if (!d.startDate) e.startDate = 'Pick the start date.';
  if (d.endDate && d.startDate && d.endDate < d.startDate) e.endDate = 'It ends before it starts.';
  const url = (d.agreementUrl || '').trim();
  if (url && !/^https?:\/\/[^\s/]+/i.test(url)) e.agreementUrl = 'The link must start with http:// or https://.';
  return e;
}

export function AgreementDialog({ agreement = null, entities, showHistorical = false, onClose, onSaved }) {
  const [d, setD] = useState(() => (agreement ? {
    ...blank(), ...agreement, feeRate: agreement.feeRate ?? '', flatAmount: agreement.flatAmount ?? null,
    managerEntityCode: agreement.managerEntityCode || '', endDate: agreement.endDate || '', feeGlAccount: agreement.feeGlAccount || '',
    agreementUrl: agreement.agreementUrl || '', notes: agreement.notes || '',
    thresholdAmount: agreement.thresholdAmount ?? null, thresholdBasis: agreement.thresholdBasis || '',
  } : blank()));
  // Picking Percent or Flat fills the operating agreement's figures (./assumptions.js) into whatever is still empty.
  // Greater Of fills the team's percent and monthly minimum the same way.
  const pickBasis = (feeBasis) => setD((x) => {
    const rate = x.feeRate === '' || x.feeRate == null ? MGMT_FEE_DEFAULT_RATE : x.feeRate;
    if (feeBasis === 'greater_of') return { ...x, feeBasis, feeRate: rate, flatAmount: x.flatAmount ?? MGMT_FEE_DEFAULT_MONTHLY_MINIMUM };
    if (feeBasis !== 'percent_or_flat') return { ...x, feeBasis };
    return { ...x, feeBasis, feeRate: rate, flatAmount: x.flatAmount ?? MGMT_FEE_DEFAULT_FLAT, thresholdAmount: x.thresholdAmount ?? MGMT_FEE_DEFAULT_THRESHOLD };
  });
  const loadAccounts = useCallback(() => api.getAmaAccounts(), []);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (patch) => setD((x) => ({ ...x, ...patch }));
  const save = (ev) => {
    ev.preventDefault();
    const found = validateAgreement(d);
    setErrors(found);
    if (Object.keys(found).length) return;
    setBusy(true);
    setError('');
    const body = {
      entityCode: d.entityCode, managerEntityCode: d.managerEntityCode || '', status: d.status, feeBasis: d.feeBasis,
      feeRate: d.feeBasis !== 'flat' ? Number(d.feeRate) : null, flatAmount: d.feeBasis !== 'percent_revenue' ? Number(d.flatAmount) : null,
      billingFrequency: d.billingFrequency, startDate: d.startDate, endDate: d.endDate || '', feeGlAccount: d.feeGlAccount.trim(),
      agreementUrl: d.agreementUrl.trim(), notes: d.notes.trim(),
      thresholdAmount: d.feeBasis === 'percent_or_flat' ? Number(d.thresholdAmount) : null,
      thresholdBasis: d.feeBasis === 'percent_or_flat' ? d.thresholdBasis || '' : '',
    };
    const call = agreement ? api.updateAmaAgreement(agreement.id, body) : api.createAmaAgreement(body);
    call.then(onSaved).catch((err) => { setError(err?.message || 'Could not save the agreement.'); setBusy(false); });
  };
  const err = (k) => (errors[k] ? <div style={fieldError} role="alert">{errors[k]}</div> : null);
  return (
    <Dialog title={agreement ? 'Change Agreement' : 'Add Agreement'} onClose={onClose} onSubmit={save} busy={busy} submitLabel={agreement ? 'Save' : 'Add Agreement'} error={error} width={720}
      sub="The fee one entity earns for managing another, worked out from the managed entity's gross revenue on the ledger. Billed YTD is read on the fee GL account.">
      <div style={grid}>
        <div>
          <span style={label} id="ama-entity-label">Managed Entity</span>
          <EntityPicker entities={entities} value={d.entityCode} onChange={(code) => set({ entityCode: code })} showHistorical={showHistorical}
            placeholder="Pick an Entity" ariaLabel="Managed Entity" active={false} style={{ ...full, maxWidth: 'none' }} />
          {err('entityCode')}
        </div>
        <div>
          <span style={label} id="ama-manager-label">Manager Entity</span>
          <EntityPicker entities={entities} value={d.managerEntityCode} onChange={(code) => set({ managerEntityCode: code })} showHistorical={showHistorical}
            noneLabel="None" ariaLabel="Manager Entity" active={false} style={{ ...full, maxWidth: 'none' }} />
          {err('managerEntityCode') || <div style={hint}>The entity that earns and bills the fee.</div>}
        </div>
        <div>
          <label style={label} htmlFor="ama-status">Status</label>
          <select id="ama-status" value={d.status} onChange={(e) => set({ status: e.target.value })} style={full}>
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      </div>
      <div style={grid}>
        <div>
          <label style={label} htmlFor="ama-basis">Fee Basis</label>
          <select id="ama-basis" value={d.feeBasis} onChange={(e) => pickBasis(e.target.value)} style={full}>
            {BASES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          {d.feeBasis === 'percent_or_flat' && <div style={hint}>The percent when gross is above the threshold, else the flat fee.</div>}
          {d.feeBasis === 'greater_of' && <div style={hint}>Each month, the higher of the percent of that month&apos;s gross and the minimum.</div>}
        </div>
        {d.feeBasis !== 'flat' && (
          <div>
            <label style={label} htmlFor="ama-rate">Fee Rate %</label>
            <input id="ama-rate" type="number" step="0.01" min="0" max="100" value={d.feeRate} onChange={(e) => set({ feeRate: e.target.value })} style={full} />
            {err('feeRate') || <div style={hint}>Of the managed entity&apos;s {d.feeBasis === 'percent_revenue' ? 'revenue' : 'gross revenue'}.</div>}
          </div>
        )}
        {d.feeBasis === 'percent_or_flat' && (
          <>
            <div>
              <label style={label} htmlFor="ama-threshold">Gross Income Threshold</label>
              <AmountInput id="ama-threshold" value={d.thresholdAmount} onChange={(v) => set({ thresholdAmount: v })} style={full} />
              {err('thresholdAmount') || <div style={hint}>The percent applies when gross is above it.</div>}
            </div>
            <div>
              <label style={label} htmlFor="ama-threshold-basis">Threshold Measured On</label>
              <select id="ama-threshold-basis" value={d.thresholdBasis} onChange={(e) => set({ thresholdBasis: e.target.value })} style={full}>
                <option value="">{`${basisName(MGMT_FEE_DEFAULT_THRESHOLD_BASIS)} (Default)`}</option>
                {THRESHOLD_BASES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
              <div style={hint}>Annual: the year&apos;s gross through the period. Period: the period&apos;s own gross.</div>
            </div>
          </>
        )}
        {d.feeBasis !== 'percent_revenue' && (
          <div>
            <label style={label} htmlFor="ama-flat">{d.feeBasis === 'flat' ? 'Flat Amount' : d.feeBasis === 'greater_of' ? 'Monthly Minimum' : 'Flat Fee (At or Under Threshold)'}</label>
            <AmountInput id="ama-flat" value={d.flatAmount} onChange={(v) => set({ flatAmount: v })} style={full} />
            {err('flatAmount') || <div style={hint}>{d.feeBasis === 'greater_of' ? 'Per month, whatever the billing frequency.' : d.feeBasis === 'flat' || !MGMT_FEE_TIER_FLAT_IS_ANNUAL ? 'Per billing period.' : 'A year, spread over its billing dates.'}</div>}
          </div>
        )}
        <div>
          <label style={label} htmlFor="ama-frequency">Billing Frequency</label>
          <select id="ama-frequency" value={d.billingFrequency} onChange={(e) => set({ billingFrequency: e.target.value })} style={full}>
            {FREQUENCIES.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </div>
        <div>
          <label style={label} htmlFor="ama-start">Start Date</label>
          <input id="ama-start" type="date" value={d.startDate} onChange={(e) => set({ startDate: e.target.value })} style={full} />
          {err('startDate') || <div style={hint}>Billing dates count from it.</div>}
        </div>
        <div>
          <label style={label} htmlFor="ama-end">End Date</label>
          <input id="ama-end" type="date" value={d.endDate} onChange={(e) => set({ endDate: e.target.value })} style={full} />
          {err('endDate') || <div style={hint}>Blank = open-ended.</div>}
        </div>
        <div>
          <span style={label} id="ama-gl-label">Fee GL Account</span>
          <GlAccountPicker value={d.feeGlAccount} onChange={(code) => set({ feeGlAccount: code.slice(0, 40) })} load={loadAccounts}
            ariaLabel="Fee GL Account" style={{ ...full, maxWidth: 'none' }} />
          <div style={hint}>Where the fee posts. Billed YTD is read from it.</div>
        </div>
      </div>
      <div>
        <label style={label} htmlFor="ama-url">Agreement Link</label>
        <input id="ama-url" type="url" value={d.agreementUrl} maxLength={1000} onChange={(e) => set({ agreementUrl: e.target.value })} placeholder="https://... (Egnyte or SharePoint)" style={full} />
        {err('agreementUrl')}
      </div>
      <div>
        <label style={label} htmlFor="ama-notes">Notes</label>
        <textarea id="ama-notes" value={d.notes} maxLength={2000} rows={2} onChange={(e) => set({ notes: e.target.value })} style={{ ...full, height: 'auto', resize: 'vertical', fontFamily: 'inherit' }} />
      </div>
    </Dialog>
  );
}

const thisYear = () => new Date().getFullYear();

// The agreements' columns for the standard table view (10/23 meeting, item
// 01): the figures typed as amounts (the totals line adds up the ones it
// always did), the next billing as a date, the row's buttons last.
export function feeColumns(entities, canEdit) {
  const money = (key, label, field, total = false) => ({
    key, label, type: 'amount', total, value: (r) => (r[field] == null ? null : Number(r[field])), text: (r) => (r[field] == null ? '' : formatAmount(r[field])),
  });
  return [
    { key: 'entity', label: 'Entity', text: (r) => entityText(entities, r.entityCode) },
    { key: 'manager', label: 'Manager Entity', text: (r) => entityText(entities, r.managerEntityCode) },
    { key: 'status', label: 'Status', text: (r) => r.status || '' },
    { key: 'fee', label: 'Fee', text: (r) => feeText(r) },
    money('gross', 'Gross Revenue', 'grossRevenue'),
    money('calculated', 'Calculated Fee', 'calculatedFee', true),
    money('billed', 'Billed YTD', 'billedYtd', true),
    money('expected', 'Expected YTD', 'expectedYtd', true),
    money('difference', 'Difference', 'difference', true),
    { key: 'next', label: 'Next Billing', type: 'date', value: (r) => r.nextBilling || '', text: (r) => (r.nextBilling ? formatDate(r.nextBilling) : '') },
    { key: 'agreement', label: 'Agreement', text: (r) => r.agreementUrl || '' },
    ...(canEdit ? [{ key: 'actions', label: 'Actions', fixed: true, noFilter: true, noSort: true, exportAs: [], text: () => '' }] : []),
  ];
}

export default function ManagementFeesTab({ canEdit = false }) {
  const custom = useCustomizePrefs(['density', 'pageSize', 'historicalEntities']);
  const py = DENSITIES.find((x) => x.key === custom.density)?.py || '5px';
  const [year, setYear] = useState(thisYear);
  const [picked, setPeriod] = useState(MGMT_FEE_DEFAULT_PERIOD);
  const periods = useMemo(() => periodOptions(year), [year]);
  // A month that has not started in the year now picked falls back to the year.
  const period = periods.some(([k]) => k === picked) ? picked : 'ytd';
  const [text, setText] = useState('');
  const [entities, setEntities] = useState([]);
  const [reloads, setReloads] = useState(0);
  const [res, setRes] = useState({ key: null, data: null, error: null });
  const [dialog, setDialog] = useState(null);   // 'add' | { edit: row }
  const [sent, setSent] = useState(null);
  const [box, setBox] = useState(null);
  const fit = useFitHeight(box);

  useEffect(() => {
    api.getAccountingLocations?.().then((x) => setEntities(x?.entities || [])).catch(() => setEntities([]));
  }, []);

  // 10/23 meeting, item 13: Sync reads the agreements again (ts.tick), nothing else.
  const ts = useTableSync();
  const key = JSON.stringify([year, period, reloads, ts.tick]);
  useEffect(() => {
    let alive = true;
    ts.read(() => api.getAmaSummary(year, period))
      .then((x) => { if (alive) setRes({ key, data: x, error: null }); })
      .catch((e) => { if (alive) setRes({ key, data: null, error: e }); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const load = () => setReloads((n) => n + 1);
  const loading = res.key !== key;
  const error = loading ? null : res.error;
  const data = res.data;
  const all = useMemo(() => data?.rows || [], [data]);
  const searched = useMemo(() => visibleRows(all, entities, text), [all, entities, text]);
  // 10/23 meeting, item 01: the standard view over what the filter box leaves;
  // the widths dragged before it (saved as 'ama') are the defaults.
  const columns = useMemo(() => feeColumns(entities, canEdit), [entities, canEdit]);
  const view = useTableView('mgmt-fees', columns, searched, { widthsKey: 'ama' });
  const rows = view.rows;
  const paged = usePaged(rows, custom.pageSize, [year, period, text, view.state]);
  const [busy, setBusy] = useState('');
  const exportAs = async (format) => {
    setBusy(format);
    try {
      const span = data?.periodFrom ? `${formatDate(data.periodFrom)} - ${formatDate(data.periodTo)}` : asOf ? `Through ${formatDate(asOf)}` : String(year);
      const file = await linesFile(viewTable(rows, view.columns, { title: 'Management Fees', period: span.replace(/\//g, '-'), subtitle: `${rows.length} ${rows.length === 1 ? 'agreement' : 'agreements'} · ${span}` }), format);
      downloadBlob(file.name, file);
    } catch (e) {
      setSent({ text: e?.message || 'Could not export.', bad: true });
    } finally {
      setBusy('');
    }
  };
  const unavailable = error && notAvailable(error);
  const asOf = data?.asOf || '';
  const years = Array.from({ length: 6 }, (_x, i) => thisYear() - i);
  const sum = (k) => Math.round(rows.reduce((s, r) => s + (Number(r[k]) || 0), 0) * 100) / 100;
  const cols = view.columns.length;

  const remove = (row) => api.deleteAmaAgreement(row.id)
    .then(() => { setSent({ text: `Removed the agreement of ${entityText(entities, row.entityCode)}.` }); load(); })
    .catch((e) => setSent({ text: e?.message || 'Could not remove the agreement.', bad: true }));
  const drill = (r) => requestReportDrill({ account: r.feeGlAccount, accountName: 'Asset management fee', from: `${r.year || year}-01-01`, to: r.asOf || asOf, entity: r.billingEntityCode || r.entityCode });

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <style>{`.acct-ama tbody > tr > td { padding-top: var(--ama-py, 5px); padding-bottom: var(--ama-py, 5px); }`}</style>
      <div>
        <h3 style={{ margin: 0, fontSize: '1rem' }}>Management Fees</h3>
        <p style={{ margin: '2px 0 0', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
          Asset management agreements: each managed entity&apos;s gross revenue and the fee it works out to, with what was billed this year, all read from the ledger.
        </p>
      </div>

      <ControlBar style={{ ...card, padding: '8px 10px' }}>
        <select value={year} onChange={(e) => setYear(Number(e.target.value))} aria-label="Year" style={control}>
          {years.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
        <select value={period} onChange={(e) => setPeriod(e.target.value)} aria-label="Period" style={control}
          title="The period Gross Revenue and Calculated Fee cover. Billed and Expected YTD run from January 1 through its end.">
          {periods.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <div style={{ position: 'relative' }}>
          <Search size={12} style={{ position: 'absolute', left: 8, top: 9, color: 'var(--text-muted)' }} />
          <input type="text" value={text} onChange={(e) => setText(e.target.value)} placeholder="Filter agreements" aria-label="Filter agreements" style={{ ...control, width: 180, paddingLeft: 24 }} />
        </div>
        <TableViewBar view={view} />
        <div className="acct-bar-end">
          <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
            Agreements <strong>{rows.length}</strong> · Calculated Fee <strong><Amount value={sum('calculatedFee')} /></strong> · Billed YTD <strong><Amount value={sum('billedYtd')} /></strong>
          </span>
          <SyncButton onSync={ts.sync} busy={loading && !!data} syncedAt={ts.syncedAt} />
          <CustomizeButton {...custom} />
          <ExportMenu disabled={!rows.length} items={[
            { key: 'excel', label: 'Excel', hint: 'The agreements on screen, as filtered', onPick: () => exportAs('excel'), busy: busy === 'excel' },
            { key: 'csv', label: 'CSV', hint: 'Plain values, one row per agreement', onPick: () => exportAs('csv'), busy: busy === 'csv' },
          ]} />
          {canEdit && !unavailable && (
            <button type="button" className="primary-btn" onClick={() => setDialog('add')}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', height: 30, padding: '0 12px' }}>
              <Plus size={14} /> Add Agreement
            </button>
          )}
        </div>
      </ControlBar>

      {sent && (
        <div role="status" style={{ ...card, padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 10, fontSize: '0.82rem', color: sent.bad ? 'var(--bad-fg, #dc2626)' : 'var(--ok-fg, #15803d)' }}>
          <span style={{ flex: 1 }}>{sent.text}</span>
          <button type="button" className="secondary-btn" onClick={() => setSent(null)} style={{ fontSize: '0.74rem', padding: '2px 10px' }}>Dismiss</button>
        </div>
      )}

      {error && (unavailable ? (
        <div style={{ ...card, padding: 18, fontSize: '0.86rem', color: 'var(--text-secondary)' }}>
          <strong style={{ color: 'var(--text-primary)' }}>Management Fees are not available here.</strong> The accounting service is not connected on this environment.
        </div>
      ) : (
        <div style={{ ...bad, display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ flex: 1 }}>{error.message || 'Could not read the agreements.'}</span>
          <button type="button" className="secondary-btn" onClick={load} style={{ fontSize: '0.76rem' }}>Try Again</button>
        </div>
      ))}

      {!error && !loading && !all.length && (
        <div style={{ ...card, padding: 18, fontSize: '0.86rem', color: 'var(--text-secondary)', display: 'grid', gap: 6, maxWidth: 760 }}>
          <strong style={{ color: 'var(--text-primary)' }}>No asset management agreements yet.</strong>
          <span>{canEdit ? 'Add one with + Add Agreement: the managed entity, the fee and how often it is billed.' : 'An editor on Accounting can add them here.'}</span>
        </div>
      )}
      {!error && !loading && all.length > 0 && !rows.length && (
        <div style={{ ...card, padding: 14, fontSize: '0.84rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span>No agreement matches the filters.</span>
          {view.dirty && <button type="button" className="secondary-btn" onClick={view.clear} style={{ fontSize: '0.76rem' }}>Clear</button>}
        </div>
      )}

      {!error && (loading || rows.length > 0) && (
        <div style={{ ...card, padding: 0, overflow: 'hidden' }} aria-busy={loading}>
          {/* 10/23 meeting, item 05: the agreements scroll inside this box, headings pinned. */}
          <div className="req-table-wrapper acct-scroll-box" ref={setBox} data-testid="mgmt-fees-box" style={fit}>
            <table className="req-table acct-ama" style={{ fontVariantNumeric: 'tabular-nums', '--ama-py': py }}>
              <thead>
                <tr>
                  {view.columns.map((c) => (c.key === 'actions' ? <th key={c.key} aria-label="Actions" style={{ width: 60 }} /> : (
                    <ViewHead key={c.key} view={view} col={c} aria-label={c.label} style={headStyle(view.manualWidth(c.key), c.type === 'amount' ? num : null)} />
                  )))}
                </tr>
              </thead>
              <tbody>
                {loading && !data ? <SkeletonRows cols={cols} /> : paged.rows.map((r) => {
                  const name = entityText(entities, r.entityCode);
                  const failed = !!r.error;
                  const w = (k) => view.manualWidth(k);
                  return (
                    <tr key={r.id} style={loading ? { opacity: 0.6 } : undefined}>
                      {viewCells(view, {
                      entity: <td style={cellStyle(w('entity'), { fontWeight: 600 })} title={name}>
                        {name}
                        {failed && <> <Chip tone="bad" title={r.error}>Not Read</Chip></>}
                      </td>,
                      manager: <td style={cellStyle(w('manager'))} title={entityText(entities, r.managerEntityCode) || undefined}>{r.managerEntityCode ? entityText(entities, r.managerEntityCode) : dash}</td>,
                      status: <td style={cellStyle(w('status'))}><Chip tone={STATUS_TONE[r.status] || 'muted'}>{r.status}</Chip></td>,
                      fee: <td style={cellStyle(w('fee'), { whiteSpace: 'nowrap' })} title={feeText(r)}>{feeText(r)}</td>,
                      gross: <td style={cellStyle(w('gross'), num)}
                        title={failed ? r.error : r.grossError || (r.periodFrom ? `${entityText(entities, r.entityCode)} gross revenue, ${formatDate(r.periodFrom)} - ${formatDate(r.periodTo)}` : undefined)}>
                        {r.grossRevenue == null ? dash : <Amount value={r.grossRevenue} />}
                      </td>,
                      calculated: <td style={cellStyle(w('calculated'), { ...num, fontWeight: 600 })} title={calcTitle(r)}>
                        {r.calculatedFee == null ? dash : <Amount value={r.calculatedFee} />}
                        {(r.feeBasis === 'percent_or_flat' || r.feeBasis === 'greater_of') && TIER[r.feeTier] && <> <Chip tone={TIER[r.feeTier][0]}>{TIER[r.feeTier][1]}</Chip></>}
                      </td>,
                      billed: <td style={cellStyle(w('billed'), num)} title={failed ? r.error : r.feeGlAccount ? `Net credits on GL ${r.feeGlAccount} in ${r.billingEntityCode} - click for the ledger lines` : 'Set a fee GL account to read what was billed'}>
                        {r.billedYtd == null ? dash : (
                          <button type="button" className="acct-drill" aria-label={`Ledger lines behind the billed fee of ${name}`} onClick={() => drill(r)}><Amount value={r.billedYtd} /></button>
                        )}
                      </td>,
                      expected: <td style={cellStyle(w('expected'), num)}
                        title={failed ? r.error : r.feeBasis === 'greater_of' && r.expectedTier ? `Through ${formatDate(r.asOf)}: ${months(r.ytdPercentMonths || 0)} at the percent, ${months(r.ytdMinimumMonths || 0)} at the minimum` : r.feeBasis === 'flat' ? `${r.periodsElapsed || 0} billing ${r.periodsElapsed === 1 ? 'date' : 'dates'} so far this year` : r.revenueYtd != null ? `${Number(r.feeRate || 0).toFixed(2)}% of revenue ${formatAmount(r.revenueYtd)}` : undefined}>
                        {r.expectedYtd == null ? dash : <Amount value={r.expectedYtd} />}
                      </td>,
                      difference: <td style={cellStyle(w('difference'), { ...num, color: r.difference != null && r.difference < -0.005 ? 'var(--bad-fg, #dc2626)' : undefined })}
                        title={r.difference != null ? 'Billed less expected' : undefined}>
                        {r.difference == null ? dash : <Amount value={r.difference} zero="dash" />}
                      </td>,
                      next: <td style={cellStyle(w('next'))}>{r.nextBilling ? formatDate(r.nextBilling) : dash}</td>,
                      agreement: <td style={cellStyle(w('agreement'), { whiteSpace: 'nowrap' })}>
                        {r.agreementUrl ? (
                          <a href={r.agreementUrl} target="_blank" rel="noopener noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--wk-brand, #2b45e1)', fontSize: '0.8rem' }}>
                            View Agreement <ExternalLink size={12} />
                          </a>
                        ) : dash}
                      </td>,
                      actions: <td style={{ whiteSpace: 'nowrap' }}><RowActions row={r} name={name} onEdit={() => setDialog({ edit: r })} onRemove={remove} /></td>,
                      })}
                    </tr>
                  );
                })}
              </tbody>
              {!loading && rows.length > 0 && (
                <tfoot>
                  <tr style={{ fontWeight: 700 }}>
                    {/* No gross total: two agreements on one entity would count it twice. */}
                    {viewCells(view, {
                      entity: (
                        <td>
                          Total
                          <div style={{ fontWeight: 400, fontSize: '0.74rem', color: 'var(--text-muted)' }}>
                            {data?.periodFrom ? `${formatDate(data.periodFrom)} - ${formatDate(data.periodTo)}` : asOf ? `Through ${formatDate(asOf)}` : ''}
                          </div>
                        </td>
                      ),
                      calculated: <td style={num}><Amount value={sum('calculatedFee')} zero="dash" /></td>,
                      billed: <td style={num}><Amount value={sum('billedYtd')} zero="dash" /></td>,
                      expected: <td style={num}><Amount value={sum('expectedYtd')} zero="dash" /></td>,
                      difference: <td style={num}><Amount value={sum('difference')} zero="dash" /></td>,
                    })}
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
          {!loading && <Pager {...paged} style={{ borderTop: '1px solid var(--border-color)' }} />}
        </div>
      )}

      {dialog === 'add' && <AgreementDialog entities={entities} showHistorical={custom.showHistorical} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); load(); }} />}
      {dialog?.edit && <AgreementDialog agreement={dialog.edit} entities={entities} showHistorical={custom.showHistorical} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); load(); }} />}
    </div>
  );
}

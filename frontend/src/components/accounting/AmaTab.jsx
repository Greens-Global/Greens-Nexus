import { useEffect, useMemo, useState } from 'react';
import { ExternalLink, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { api } from '../../api';
import Amount, { AmountInput, formatAmount } from './Amount';
import { formatDate } from '../../lib/datetime';
import { ColumnResizer, CustomizeButton, DENSITIES, EntityPicker, Pager, control } from './reportControls';
import { useColumnWidths, useCustomizePrefs, usePaged } from './tableHooks';
import { cellStyle, headStyle } from './columnStyles';
import { requestReportDrill } from './drill';
import { Chip } from './LoanSetupDialog';
import { Dialog } from './LoanDialogs';
import { notAvailable } from './LoansTab';

// Accounting -> Reporting -> AMA, Asset Management Agreements (Priyanka,
// Oct 7: "We still need to build AMA"). The old mock (the "AMA Entity Billing
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
// [key (saved widths), header, figure]
const COLUMNS = [
  ['entity', 'Entity'], ['manager', 'Manager Entity'], ['status', 'Status'], ['fee', 'Fee'], ['billed', 'Billed YTD', true], ['expected', 'Expected YTD', true],
  ['difference', 'Difference', true], ['next', 'Next Billing'], ['agreement', 'Agreement'],
];

/** "3.50% of revenue" / "$2,500.00 Monthly". */
export function feeText(a) {
  if (a.feeBasis === 'flat') return `$${formatAmount(a.flatAmount)} ${a.billingFrequency || 'Monthly'}`;
  return `${Number(a.feeRate || 0).toFixed(2)}% of revenue`;
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
  return rows.filter((r) => [entityText(entities, r.entityCode), entityText(entities, r.managerEntityCode), r.status, r.feeGlAccount, r.notes]
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
  entityCode: '', managerEntityCode: '', status: 'Active', feeBasis: 'percent_revenue', feeRate: '', flatAmount: null, billingFrequency: 'Monthly',
  startDate: '', endDate: '', feeGlAccount: '', agreementUrl: '', notes: '',
});

/** Field-by-field problems with an agreement being edited ({} = none). */
export function validateAgreement(d) {
  const e = {};
  if (!d.entityCode) e.entityCode = 'Pick the managed entity.';
  if (d.managerEntityCode && d.managerEntityCode === d.entityCode) e.managerEntityCode = 'The manager cannot be the managed entity.';
  if (d.feeBasis === 'percent_revenue') {
    const r = Number(d.feeRate);
    if (d.feeRate === '' || d.feeRate == null || !(r > 0 && r <= 100)) e.feeRate = 'Type a percent above 0 and up to 100.';
  } else if (!(Number(d.flatAmount) > 0)) {
    e.flatAmount = 'Type the fee per billing period.';
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
  } : blank()));
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
      feeRate: d.feeBasis === 'percent_revenue' ? Number(d.feeRate) : null, flatAmount: d.feeBasis === 'flat' ? Number(d.flatAmount) : null,
      billingFrequency: d.billingFrequency, startDate: d.startDate, endDate: d.endDate || '', feeGlAccount: d.feeGlAccount.trim(),
      agreementUrl: d.agreementUrl.trim(), notes: d.notes.trim(),
    };
    const call = agreement ? api.updateAmaAgreement(agreement.id, body) : api.createAmaAgreement(body);
    call.then(onSaved).catch((err) => { setError(err?.message || 'Could not save the agreement.'); setBusy(false); });
  };
  const err = (k) => (errors[k] ? <div style={fieldError} role="alert">{errors[k]}</div> : null);
  return (
    <Dialog title={agreement ? 'Change Agreement' : 'Add Agreement'} onClose={onClose} onSubmit={save} busy={busy} submitLabel={agreement ? 'Save' : 'Add Agreement'} error={error} width={720}
      sub="The fee one entity earns for managing another. Billed YTD is read from the ledger on the fee GL account.">
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
          <select id="ama-basis" value={d.feeBasis} onChange={(e) => set({ feeBasis: e.target.value })} style={full}>
            <option value="percent_revenue">Percent of Revenue</option>
            <option value="flat">Flat Amount</option>
          </select>
        </div>
        {d.feeBasis === 'percent_revenue' ? (
          <div>
            <label style={label} htmlFor="ama-rate">Fee Rate %</label>
            <input id="ama-rate" type="number" step="0.01" min="0" max="100" value={d.feeRate} onChange={(e) => set({ feeRate: e.target.value })} style={full} />
            {err('feeRate') || <div style={hint}>Of the managed entity's revenue.</div>}
          </div>
        ) : (
          <div>
            <label style={label} htmlFor="ama-flat">Flat Amount</label>
            <AmountInput id="ama-flat" value={d.flatAmount} onChange={(v) => set({ flatAmount: v })} style={full} />
            {err('flatAmount') || <div style={hint}>Per billing period.</div>}
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
          <label style={label} htmlFor="ama-gl">Fee GL Account</label>
          <input id="ama-gl" type="text" value={d.feeGlAccount} maxLength={40} onChange={(e) => set({ feeGlAccount: e.target.value })} placeholder="e.g. 40500" style={full} />
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

export default function AmaTab({ canEdit = false }) {
  const custom = useCustomizePrefs(['density', 'pageSize', 'historicalEntities']);
  const py = DENSITIES.find((x) => x.key === custom.density)?.py || '5px';
  const cw = useColumnWidths('ama');
  const [year, setYear] = useState(thisYear);
  const [text, setText] = useState('');
  const [entities, setEntities] = useState([]);
  const [reloads, setReloads] = useState(0);
  const [res, setRes] = useState({ key: null, data: null, error: null });
  const [dialog, setDialog] = useState(null);   // 'add' | { edit: row }
  const [sent, setSent] = useState(null);

  useEffect(() => {
    api.getAccountingLocations?.().then((x) => setEntities(x?.entities || [])).catch(() => setEntities([]));
  }, []);

  const key = JSON.stringify([year, reloads]);
  useEffect(() => {
    let alive = true;
    api.getAmaSummary(year)
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
  const rows = useMemo(() => visibleRows(all, entities, text), [all, entities, text]);
  const paged = usePaged(rows, custom.pageSize, [year, text]);
  const unavailable = error && notAvailable(error);
  const asOf = data?.asOf || '';
  const years = Array.from({ length: 6 }, (_x, i) => thisYear() - i);
  const sum = (k) => Math.round(rows.reduce((s, r) => s + (Number(r[k]) || 0), 0) * 100) / 100;
  const cols = COLUMNS.length + (canEdit ? 1 : 0);

  const remove = (row) => api.deleteAmaAgreement(row.id)
    .then(() => { setSent({ text: `Removed the agreement of ${entityText(entities, row.entityCode)}.` }); load(); })
    .catch((e) => setSent({ text: e?.message || 'Could not remove the agreement.', bad: true }));
  const drill = (r) => requestReportDrill({ account: r.feeGlAccount, accountName: 'Asset management fee', from: `${r.year || year}-01-01`, to: r.asOf || asOf, entity: r.billingEntityCode || r.entityCode });

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <style>{`.acct-ama tbody > tr > td { padding-top: var(--ama-py, 5px); padding-bottom: var(--ama-py, 5px); }`}</style>
      <div>
        <h3 style={{ margin: 0, fontSize: '1rem' }}>Asset Management Agreements</h3>
        <p style={{ margin: '2px 0 0', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
          The fee each managed entity owes under its agreement, with what was billed this year read from the ledger.
        </p>
      </div>

      <div style={{ ...card, padding: '8px 10px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <select value={year} onChange={(e) => setYear(Number(e.target.value))} aria-label="Year" style={control}>
          {years.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
        <div style={{ position: 'relative' }}>
          <Search size={12} style={{ position: 'absolute', left: 8, top: 9, color: 'var(--text-muted)' }} />
          <input type="text" value={text} onChange={(e) => setText(e.target.value)} placeholder="Filter agreements" aria-label="Filter agreements" style={{ ...control, width: 180, paddingLeft: 24 }} />
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
            Agreements <strong>{rows.length}</strong> · Billed YTD <strong><Amount value={sum('billedYtd')} /></strong>
          </span>
          <CustomizeButton {...custom} />
          {canEdit && !unavailable && (
            <button type="button" className="primary-btn" onClick={() => setDialog('add')}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', height: 30, padding: '0 12px' }}>
              <Plus size={14} /> Add Agreement
            </button>
          )}
        </div>
      </div>

      {sent && (
        <div role="status" style={{ ...card, padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 10, fontSize: '0.82rem', color: sent.bad ? 'var(--bad-fg, #dc2626)' : 'var(--ok-fg, #15803d)' }}>
          <span style={{ flex: 1 }}>{sent.text}</span>
          <button type="button" className="secondary-btn" onClick={() => setSent(null)} style={{ fontSize: '0.74rem', padding: '2px 10px' }}>Dismiss</button>
        </div>
      )}

      {error && (unavailable ? (
        <div style={{ ...card, padding: 18, fontSize: '0.86rem', color: 'var(--text-secondary)' }}>
          <strong style={{ color: 'var(--text-primary)' }}>Asset Management Agreements are not available here.</strong> The accounting service is not connected on this environment.
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
        <div style={{ ...card, padding: 14, fontSize: '0.84rem', color: 'var(--text-secondary)' }}>No agreement matches the filter.</div>
      )}

      {!error && (loading || rows.length > 0) && (
        <div style={{ ...card, padding: 0, overflow: 'hidden' }} aria-busy={loading}>
          <div className="req-table-wrapper" style={{ overflowX: 'auto' }}>
            <table className="req-table acct-ama" style={{ fontVariantNumeric: 'tabular-nums', '--ama-py': py }}>
              <thead>
                <tr>
                  {COLUMNS.map(([k, l, isNum]) => (
                    <th key={k} aria-label={l} style={headStyle(cw.width(k), isNum ? num : null)}>{l}<ColumnResizer {...cw.resizer(k, l)} /></th>
                  ))}
                  {canEdit && <th style={{ width: 60 }} />}
                </tr>
              </thead>
              <tbody>
                {loading && !data ? <SkeletonRows cols={cols} /> : paged.rows.map((r) => {
                  const name = entityText(entities, r.entityCode);
                  const failed = !!r.error;
                  return (
                    <tr key={r.id} style={loading ? { opacity: 0.6 } : undefined}>
                      <td style={cellStyle(cw.width('entity'), { fontWeight: 600 })} title={name}>
                        {name}
                        {failed && <> <Chip tone="bad" title={r.error}>Not Read</Chip></>}
                      </td>
                      <td style={cellStyle(cw.width('manager'))} title={entityText(entities, r.managerEntityCode) || undefined}>{r.managerEntityCode ? entityText(entities, r.managerEntityCode) : dash}</td>
                      <td style={cellStyle(cw.width('status'))}><Chip tone={STATUS_TONE[r.status] || 'muted'}>{r.status}</Chip></td>
                      <td style={cellStyle(cw.width('fee'), { whiteSpace: 'nowrap' })}>{feeText(r)}</td>
                      <td style={cellStyle(cw.width('billed'), num)} title={failed ? r.error : r.feeGlAccount ? `Net credits on GL ${r.feeGlAccount} in ${r.billingEntityCode} - click for the ledger lines` : 'Set a fee GL account to read what was billed'}>
                        {r.billedYtd == null ? dash : (
                          <button type="button" className="acct-drill" aria-label={`Ledger lines behind the billed fee of ${name}`} onClick={() => drill(r)}><Amount value={r.billedYtd} /></button>
                        )}
                      </td>
                      <td style={cellStyle(cw.width('expected'), num)}
                        title={failed ? r.error : r.feeBasis === 'flat' ? `${r.periodsElapsed || 0} billing ${r.periodsElapsed === 1 ? 'date' : 'dates'} so far this year` : r.revenueYtd != null ? `${Number(r.feeRate || 0).toFixed(2)}% of revenue ${formatAmount(r.revenueYtd)}` : undefined}>
                        {r.expectedYtd == null ? dash : <Amount value={r.expectedYtd} />}
                      </td>
                      <td style={cellStyle(cw.width('difference'), { ...num, color: r.difference != null && r.difference < -0.005 ? 'var(--bad-fg, #dc2626)' : undefined })}
                        title={r.difference != null ? 'Billed less expected' : undefined}>
                        {r.difference == null ? dash : <Amount value={r.difference} zero="dash" />}
                      </td>
                      <td style={cellStyle(cw.width('next'))}>{r.nextBilling ? formatDate(r.nextBilling) : dash}</td>
                      <td style={cellStyle(cw.width('agreement'), { whiteSpace: 'nowrap' })}>
                        {r.agreementUrl ? (
                          <a href={r.agreementUrl} target="_blank" rel="noopener noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--wk-brand, #2b45e1)', fontSize: '0.8rem' }}>
                            View Agreement <ExternalLink size={12} />
                          </a>
                        ) : dash}
                      </td>
                      {canEdit && <td style={{ whiteSpace: 'nowrap' }}><RowActions row={r} name={name} onEdit={() => setDialog({ edit: r })} onRemove={remove} /></td>}
                    </tr>
                  );
                })}
              </tbody>
              {!loading && rows.length > 0 && (
                <tfoot>
                  <tr style={{ fontWeight: 700 }}>
                    <td>Total</td><td /><td /><td />
                    <td style={num}><Amount value={sum('billedYtd')} zero="dash" /></td>
                    <td style={num}><Amount value={sum('expectedYtd')} zero="dash" /></td>
                    <td style={num}><Amount value={sum('difference')} zero="dash" /></td>
                    <td colSpan={cols - 7} style={{ fontWeight: 400, fontSize: '0.74rem', color: 'var(--text-muted)' }}>{asOf ? `Through ${formatDate(asOf)}` : ''}</td>
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

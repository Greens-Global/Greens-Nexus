// Financing on an Asset Management property - added for the Oct 7 accounting
// feedback (Charmi 10/03 #25, "wire this data into Asset Mgt"). Note: this is
// self-contained and mounted with a few lines in asset/App.jsx; the property
// keeps its ledger entity as `entityCode` in its workspace payload (no new
// column - property_assets stores the whole object as JSON).
//
// It reads GET /accounting/loans/by-entity/{code} (api.getLoansByEntity): the
// open loans of that entity and its sub-entities - lender, loan #, balance,
// rate, maturity, monthly payment, DSCR and the Egnyte folders - behind the
// same accounting entity scope as Accounting > Loans, so a person without
// access to the entity gets a plain message, never a crash.
//
// The look (Neil, 11/17/2026): no card, a hairline table. `variant="rail"` is
// the overview rail's Financing block - each loan as two lines, the totals as
// one sentence, the entity and Change on a quiet line; the page draws the
// block's heading.
import { useCallback, useEffect, useState } from 'react';
import { FileText, FolderOpen } from 'lucide-react';
import { api } from '../api';
import { SkeletonBlocks } from './AsyncState';
import { formatDate } from '../lib/datetime';
import { formatAmount } from './accounting/Amount';
import { EntityPicker } from './accounting/reportControls';

const card = { marginTop: 24 };
const th = { textAlign: 'left', fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)', padding: '6px 8px', borderBottom: '1px solid var(--border-color)', whiteSpace: 'nowrap' };
const td = { fontSize: 13, padding: '8px 8px', borderBottom: '1px solid var(--border-color)', whiteSpace: 'nowrap' };
const num = { textAlign: 'right', fontVariantNumeric: 'tabular-nums' };
const note = { fontSize: 13, color: 'var(--text-secondary)', margin: '6px 0 0', lineHeight: 1.5 };
const link = { color: 'hsl(var(--color-green))', display: 'inline-flex', marginRight: 8 };
const textBtn = { border: 'none', background: 'none', padding: 0, font: 'inherit', fontWeight: 600, color: 'hsl(var(--color-green))', cursor: 'pointer' };

const money = (v) => (v == null || v === '' ? '-' : `$${formatAmount(v)}`);
const rate = (r) => (r.ratePct == null ? '-' : `${Number(r.ratePct).toLocaleString('en-US', { maximumFractionDigits: 3 })}%${r.rateType ? ` ${r.rateType}` : ''}`);
const dscr = (v) => (v == null ? '-' : `${Number(v).toFixed(2)}x`);
const folder = (path) => String(path || '').split('/').filter(Boolean).pop() || 'Egnyte';

export default function PropertyLoans({ property, onSaveEntityCode = null, variant = 'full' }) {
  const code = String(property?.entityCode || '').trim();
  const [state, setState] = useState({ loading: false, data: null, error: null });
  const [picking, setPicking] = useState(false);
  const [entities, setEntities] = useState(null);   // the ledger's entities, read when the picker opens
  const [entitiesError, setEntitiesError] = useState('');

  const load = useCallback(() => {
    if (!code) { setState({ loading: false, data: null, error: null }); return () => {}; }
    let alive = true;
    setState({ loading: true, data: null, error: null });
    api.getLoansByEntity(code)
      .then((d) => { if (alive) setState({ loading: false, data: d || { loans: [] }, error: null }); })
      .catch((e) => { if (alive) setState({ loading: false, data: null, error: e || {} }); });
    return () => { alive = false; };
  }, [code]);
  useEffect(() => load(), [load]);

  const openPicker = () => {
    setPicking(true);
    if (entities) return;
    setEntitiesError('');
    api.getAccountingLocations()
      .then((d) => setEntities(d?.entities || []))
      .catch((e) => { setEntities([]); setEntitiesError(e?.status === 403 ? 'You do not have access to Accounting, so the ledger entities cannot be listed.' : (e?.message || 'Could not read the ledger entities.')); });
  };
  const pick = (next) => { setPicking(false); if (onSaveEntityCode && next !== code) onSaveEntityCode(next); };

  const loans = state.data?.loans || [];
  const totals = state.data?.totals;
  const entityName = loans[0]?.entityName || (entities || []).find((e) => e.code === code)?.name || '';

  const picker = picking && (entities && !entitiesError ? (
    <EntityPicker entities={entities} value={code} onChange={pick} noneLabel="None" placeholder="Pick the Ledger Entity" ariaLabel="Ledger Entity" align="right" />
  ) : !entities ? <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Loading entities...</span> : null);

  if (variant === 'rail') {
    return (
      <div aria-label="Financing" role="group">
        {!code ? (
          <p style={{ ...note, margin: 0 }}>
            No ledger entity set, so loans from the books can&apos;t show.{' '}
            {onSaveEntityCode && !picking && <button type="button" onClick={openPicker} style={textBtn}>Set Ledger Entity</button>}
          </p>
        ) : state.loading ? (
          <div role="status" aria-live="polite">
            <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>Loading the loans...</span>
            <SkeletonBlocks count={2} height={32} borderRadius={8} />
          </div>
        ) : state.error ? (
          state.error.status === 403
            ? <p style={{ ...note, margin: 0 }}>You do not have accounting access to entity {code}, so its loans are not shown.</p>
            : <p style={{ ...note, margin: 0 }}>Could not read the loans for entity {code}{state.error.message ? ` - ${state.error.message}` : ''}. <button type="button" onClick={load} style={textBtn}>Try Again</button></p>
        ) : !loans.length ? (
          <p style={{ ...note, margin: 0 }}>No open loans on the ledger for entity {code}.</p>
        ) : (
          <div>
            {loans.map((r) => (
              <div key={r.id || `${r.lender}-${r.loanNo}`} style={{ padding: '6px 0' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 13 }}>
                  <span style={{ flex: 1, minWidth: 0, fontWeight: 500, color: 'var(--text-primary)' }}>{r.lender || 'Loan'}{r.loanNo ? ` ${r.loanNo}` : ''}</span>
                  <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--text-primary)' }}>{money(r.balance)}</span>
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
                  {[rate(r) !== '-' && rate(r), r.maturity && `matures ${formatDate(r.maturity)}`, r.monthlyPayment != null && `${money(r.monthlyPayment)} a month`].filter(Boolean).join(' · ')}
                  {r.dscr != null && <> · <span style={{ color: r.belowCovenant ? 'hsl(var(--color-red))' : undefined, fontWeight: r.belowCovenant ? 600 : 400 }} title={r.covenantMin != null ? `Covenant minimum ${dscr(r.covenantMin)}` : undefined}>DSCR {dscr(r.dscr)}{r.belowCovenant ? ', below covenant' : ''}</span></>}
                  {r.docsUrl ? <> · <a href={r.docsUrl} target="_blank" rel="noreferrer" aria-label={`Loan documents of ${r.lender || r.loanNo}`} style={{ color: 'hsl(var(--color-green))' }}>Documents</a></> : null}
                  {r.statementsUrl ? <> · <a href={r.statementsUrl} target="_blank" rel="noreferrer" aria-label={`Loan statements of ${r.lender || r.loanNo}`} style={{ color: 'hsl(var(--color-green))' }}>Statements</a></> : null}
                </div>
              </div>
            ))}
            {totals && loans.length > 1 && <p style={{ ...note, color: 'var(--text-primary)' }}>{loans.length} loans · {money(totals.balance)} · {money(totals.monthlyPayment)} a month</p>}
          </div>
        )}
        {code && (
          <p style={{ ...note, fontSize: 12, marginTop: 8 }}>
            Ledger entity {entityName ? `${entityName} (${code})` : code}{state.data?.asOf ? `, as of ${formatDate(state.data.asOf)}` : ''}.
            {onSaveEntityCode && !picking && <>{' '}<button type="button" onClick={openPicker} style={{ ...textBtn, fontSize: 12 }}>Change</button></>}
          </p>
        )}
        {picking && <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>{picker}<button type="button" className="secondary-btn" onClick={() => setPicking(false)} style={{ fontSize: 12, padding: '4px 10px' }}>Cancel</button></div>}
        {picking && entitiesError && <p role="alert" style={note}>{entitiesError}</p>}
      </div>
    );
  }

  return (
    <section aria-label="Financing" style={card}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Financing</h3>
        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          {code ? `Ledger Entity: ${entityName ? `${entityName} (${code})` : code}` : 'No ledger entity set'}
          {state.data?.asOf ? ` · as of ${formatDate(state.data.asOf)}` : ''}
        </span>
        {onSaveEntityCode && (
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            {picker}
            {!picking && (
              <button type="button" className="secondary-btn" onClick={openPicker} style={{ fontSize: 12, padding: '4px 10px' }}>
                {code ? 'Change Entity' : 'Set Ledger Entity'}
              </button>
            )}
            {picking && <button type="button" className="secondary-btn" onClick={() => setPicking(false)} style={{ fontSize: 12, padding: '4px 10px' }}>Cancel</button>}
          </div>
        )}
      </div>
      {picking && entitiesError && <p role="alert" style={note}>{entitiesError}</p>}

      {!code ? (
        <p style={note}>No ledger entity is set for this property, so its loans cannot be shown.{onSaveEntityCode ? ' Set the entity that owns it to see the loans booked there.' : ''}</p>
      ) : state.loading ? (
        <div role="status" aria-live="polite" style={{ marginTop: 10 }}>
          <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>Loading the loans...</span>
          <SkeletonBlocks count={2} height={36} borderRadius={8} />
        </div>
      ) : state.error ? (
        state.error.status === 403 ? (
          <p style={note}>You do not have accounting access to entity {code}, so its loans are not shown. Ask an accounting administrator for access.</p>
        ) : (
          <p style={note}>
            Could not read the loans for entity {code}{state.error.message ? ` - ${state.error.message}` : ''}.{' '}
            <button type="button" onClick={load} style={textBtn}>Try Again</button>
          </p>
        )
      ) : !loans.length ? (
        <p style={note}>No open loans on the ledger for entity {code}.</p>
      ) : (
        <div style={{ overflowX: 'auto', marginTop: 10 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={th}>Lender</th><th style={th}>Loan #</th><th style={{ ...th, ...num }}>Balance</th><th style={th}>Rate</th>
                <th style={th}>Maturity</th><th style={{ ...th, ...num }}>Monthly Payment</th><th style={{ ...th, ...num }}>DSCR</th><th style={th}>Documents</th>
              </tr>
            </thead>
            <tbody>
              {loans.map((r) => (
                <tr key={r.id || `${r.lender}-${r.loanNo}`}>
                  <td style={td}>{r.lender || '-'}{loans.some((x) => x.entityCode !== code) && r.entityCode ? <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{r.entityName || r.entityCode}</div> : null}</td>
                  <td style={td}>{r.loanNo || '-'}</td>
                  <td style={{ ...td, ...num }}>{money(r.balance)}</td>
                  <td style={td}>{rate(r)}</td>
                  <td style={td}>{r.maturity ? formatDate(r.maturity) : '-'}</td>
                  <td style={{ ...td, ...num }}>{money(r.monthlyPayment)}</td>
                  <td style={{ ...td, ...num, color: r.belowCovenant ? 'var(--bad-fg, #dc2626)' : undefined }} title={r.covenantMin != null ? `Covenant minimum ${dscr(r.covenantMin)}` : undefined}>{dscr(r.dscr)}</td>
                  <td style={td}>
                    {r.docsUrl ? <a href={r.docsUrl} target="_blank" rel="noreferrer" style={link} aria-label={`Loan documents of ${r.lender || r.loanNo}`} title={`Documents: ${folder(r.docsPath)}`}><FolderOpen size={14} /></a> : null}
                    {r.statementsUrl ? <a href={r.statementsUrl} target="_blank" rel="noreferrer" style={link} aria-label={`Loan statements of ${r.lender || r.loanNo}`} title={`Statements: ${folder(r.statementsPath)}`}><FileText size={14} /></a> : null}
                    {!r.docsUrl && !r.statementsUrl && '-'}
                  </td>
                </tr>
              ))}
            </tbody>
            {totals && loans.length > 1 && (
              <tfoot>
                <tr>
                  <td style={{ ...td, fontWeight: 600 }} colSpan={2}>Total - {loans.length} loans</td>
                  <td style={{ ...td, ...num, fontWeight: 600 }}>{money(totals.balance)}</td>
                  <td style={td} colSpan={2} />
                  <td style={{ ...td, ...num, fontWeight: 600 }}>{money(totals.monthlyPayment)}</td>
                  <td style={td} colSpan={2} />
                </tr>
              </tfoot>
            )}
          </table>
          {(state.data?.notes || []).length > 0 && <p style={{ ...note, fontSize: 12 }}>{state.data.notes.join(' ')}</p>}
        </div>
      )}
    </section>
  );
}

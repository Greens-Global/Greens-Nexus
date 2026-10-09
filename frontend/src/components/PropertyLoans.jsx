// Financing on an Asset Management property - added for the Oct 7 accounting
// feedback (Charmi 10/03 #25, "wire this data into Asset Mgt"). Ankush: this is
// self-contained and mounted with a few lines in asset/App.jsx; the property
// keeps its ledger entity as `entityCode` in its workspace payload (no new
// column - property_assets stores the whole object as JSON).
//
// It reads GET /accounting/loans/by-entity/{code} (api.getLoansByEntity): the
// open loans of that entity and its sub-entities - lender, loan #, balance,
// rate, maturity, monthly payment, DSCR and the Egnyte folders - behind the
// same accounting entity scope as Accounting > Loans, so a person without
// access to the entity gets a plain message, never a crash.
import { useCallback, useEffect, useState } from 'react';
import { FileText, FolderOpen, Landmark } from 'lucide-react';
import { api } from '../api';
import { SkeletonBlocks } from './AsyncState';
import { formatDate } from '../lib/datetime';
import { formatAmount } from './accounting/Amount';
import { EntityPicker } from './accounting/reportControls';

const card = { backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 14, boxShadow: 'var(--shadow-sm)', padding: '14px 16px', marginTop: 16 };
const th = { textAlign: 'left', fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-secondary)', padding: '6px 8px', borderBottom: '1px solid var(--border-color)', whiteSpace: 'nowrap' };
const td = { fontSize: '0.82rem', padding: '7px 8px', borderBottom: '1px solid var(--border-color)', whiteSpace: 'nowrap' };
const num = { textAlign: 'right', fontVariantNumeric: 'tabular-nums' };
const note = { fontSize: '0.84rem', color: 'var(--text-secondary)', margin: '6px 0 0' };
const link = { color: 'var(--wk-brand, #2b45e1)', display: 'inline-flex', marginRight: 8 };

const money = (v) => (v == null || v === '' ? '-' : `$${formatAmount(v)}`);
const rate = (r) => (r.ratePct == null ? '-' : `${Number(r.ratePct).toLocaleString('en-US', { maximumFractionDigits: 3 })}%${r.rateType ? ` ${r.rateType}` : ''}`);
const dscr = (v) => (v == null ? '-' : `${Number(v).toFixed(2)}x`);
const folder = (path) => String(path || '').split('/').filter(Boolean).pop() || 'Egnyte';

export default function PropertyLoans({ property, onSaveEntityCode = null }) {
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

  return (
    <section aria-label="Financing" style={card}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
        <Landmark size={16} style={{ color: 'var(--text-muted)' }} />
        <h3 style={{ margin: 0, fontSize: '0.98rem' }}>Financing</h3>
        <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
          {code ? `Ledger Entity: ${entityName ? `${entityName} (${code})` : code}` : 'No ledger entity set'}
          {state.data?.asOf ? ` · as of ${formatDate(state.data.asOf)}` : ''}
        </span>
        {onSaveEntityCode && (
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            {picking && entities && !entitiesError ? (
              <EntityPicker entities={entities} value={code} onChange={pick} noneLabel="None" placeholder="Pick the Ledger Entity" ariaLabel="Ledger Entity" align="right" />
            ) : picking && !entities ? (
              <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>Loading entities...</span>
            ) : null}
            {!picking && (
              <button type="button" className="secondary-btn" onClick={openPicker} style={{ fontSize: '0.78rem', padding: '4px 10px' }}>
                {code ? 'Change Entity' : 'Set Ledger Entity'}
              </button>
            )}
            {picking && <button type="button" className="secondary-btn" onClick={() => setPicking(false)} style={{ fontSize: '0.78rem', padding: '4px 10px' }}>Cancel</button>}
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
            <button type="button" onClick={load} style={{ border: 'none', background: 'none', padding: 0, font: 'inherit', color: 'var(--wk-brand, #2b45e1)', cursor: 'pointer', textDecoration: 'underline' }}>Try Again</button>
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
                  <td style={td}>{r.lender || '-'}{loans.some((x) => x.entityCode !== code) && r.entityCode ? <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{r.entityName || r.entityCode}</div> : null}</td>
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
          {(state.data?.notes || []).length > 0 && <p style={{ ...note, fontSize: '0.74rem' }}>{state.data.notes.join(' ')}</p>}
        </div>
      )}
    </section>
  );
}

import { useState } from 'react';
import { X } from 'lucide-react';
import { offerWords } from './loanTermModel';

// Terms From Asset Management (Neil, 11/19/2026). A loan's rate and maturity are typed, not read
// from Intacct - and production had them typed on the PROPERTY (a maturity on 9, a rate on 6)
// while the loans had almost none. GET /accounting/loans/term-suggestions ties a property's
// typed debt to its loan by rules (backend/loan_term_suggest.py: the loan number, then the
// lender, then the entity's only loan) and this lists the offers. Nothing is filled by itself:
// an editor ticks the loans and presses Fill, and each one goes through the ordinary loan save.
// No box around it: a hairline above and below, rows divided by hairlines.

const WHY = {
  number: 'the loan number matches',
  lender: 'the lender matches',
  only: 'it is the only loan of this entity',
};

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const ROW = { display: 'flex', alignItems: 'flex-start', gap: 12, padding: '10px 0', borderTop: '1px solid var(--border-color)' };

/**
 * props: offers (from offersFor), onApply(chosen offers) -> Promise, onClose, busy.
 */
export default function LoanTermOffers({ offers, onApply, onClose, busy = false }) {
  const [off, setOff] = useState(() => new Set());     // the loans the person unticked
  const chosen = offers.filter((o) => !off.has(o.loanId));
  const toggle = (id) => setOff((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return (
    <section aria-label="Terms From Asset Management" style={{ borderTop: '1px solid var(--border-color)', borderBottom: '1px solid var(--border-color)', padding: '14px 0' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Terms From Asset Management</h3>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 2 }}>
            Typed on the property, missing on the loan. Tick the ones that are right; the rest stay as they are.
          </div>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close Terms From Asset Management" style={{ padding: 4, color: 'var(--text-secondary)' }}><X size={16} /></button>
      </div>
      <div role="list" aria-label="Loans with terms to fill" style={{ maxHeight: 360, overflowY: 'auto', borderBottom: '1px solid var(--border-color)' }}>
        {offers.map((o) => {
          const name = o.loan.lender || o.loan.loanNo || 'Loan';
          return (
            <label key={o.loanId} role="listitem" style={{ ...ROW, cursor: busy ? 'default' : 'pointer' }}>
              <input type="checkbox" checked={!off.has(o.loanId)} disabled={busy} onChange={() => toggle(o.loanId)} aria-label={`Fill ${name}`}
                style={{ margin: '2px 0 0', width: 15, height: 15, accentColor: 'hsl(var(--color-green))' }} />
              <span style={{ flex: '1 1 0', minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
                  {name}{o.loan.loanNo && o.loan.lender ? ` ${o.loan.loanNo}` : ''}
                  {o.loan.entityName ? <span style={{ fontWeight: 400, color: 'var(--text-secondary)' }}> - {o.loan.entityName}</span> : null}
                </span>
                <span style={{ display: 'block', fontSize: 13, color: 'var(--text-primary)', marginTop: 2, fontVariantNumeric: 'tabular-nums' }}>{offerWords(o)}</span>
                <span style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
                  Typed on {o.propertyName || 'a property'}{WHY[o.why] ? ` - ${WHY[o.why]}` : ''}.
                </span>
              </span>
            </label>
          );
        })}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginTop: 12 }}>
        <button type="button" className="primary-btn" disabled={busy || !chosen.length} onClick={() => onApply(chosen)}>
          {busy ? 'Filling...' : chosen.length ? `Fill ${plural(chosen.length, 'Loan', 'Loans')}` : 'Fill Loans'}
        </button>
        <button type="button" className="secondary-btn" disabled={busy} onClick={onClose}>Cancel</button>
        <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
          {chosen.length ? 'Each term can still be changed on the loan afterward.' : 'Tick a loan to fill its terms.'}
        </span>
      </div>
    </section>
  );
}

import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Pencil, X } from 'lucide-react';
import Amount from './Amount';
import { formatDate } from '../../lib/datetime';
import { loanTypeLabel, useBackdropClose } from './LoanDialogs';
import LoanDetail from './LoanDetail';
import { WarnMark } from './warnMark';

// Accounting -> Loans & Financing, one loan opened (Charmi, Teams 11/19/2026:
// "Can you clean the UI for loans and finance ... it is very hard to work
// with"; 11/04: "This page still looks very clumsy"). A loan used to open as
// a grey panel squeezed under its row, the width of the table, with its
// figures, wiring, folders, payments and the Amortization / Stress buttons
// spread across it. It is a sheet from the right now (CLAUDE.md popups rule),
// read top to bottom: the terms (typed ones change in place), what was paid
// in the period, then how the loan is wired, its Egnyte folders and its
// payments (LoanDetail, unchanged), and the two tools at the foot. Every
// figure is the row's own - nothing is worked out here.
//
// z-index 480, under the shared overlay's 500: Change Loan, the entry, the
// ledger lines, the schedule and the stress test all open OVER this sheet,
// whatever their place in the document.

const SHEET_Z = 480;
const muted = { color: 'var(--text-muted)' };
const sectionTitle = { margin: 0, fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' };
const rowStyle = { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 16, padding: '7px 0', borderBottom: '1px solid var(--border-color)', fontSize: 13 };
const valueStyle = { textAlign: 'right', fontVariantNumeric: 'tabular-nums', minWidth: 0, overflowWrap: 'anywhere' };

function Line({ label, children, title }) {
  return (
    <div style={rowStyle} title={title}>
      <span style={{ color: 'var(--text-secondary)', flexShrink: 0 }}>{label}</span>
      <span style={valueStyle}>{children}</span>
    </div>
  );
}

const dash = <span style={muted}>-</span>;
const money = (v, zero = false) => (v == null ? dash : <Amount value={v} zero={zero ? 'dash' : undefined} />);
// A posted figure: the table's own drawing (it opens its ledger lines) when given.

/** The loan's flags in plain words (no chips), one quiet line. */
export function loanFlags(r) {
  const out = [];
  if (r.lineOfCredit) out.push({ key: 'loc', text: 'Line of Credit', tone: 'brand' });
  if (r.wiring === 'manual') out.push({ key: 'manual', text: 'Manual', tone: 'muted', title: 'Kept by hand - not in Intacct' });
  if (r.wiring === 'missing') out.push({ key: 'wiring', text: 'Check Wiring', tone: 'warn', title: `GL ${r.glAccount} has no lines in this entity on the ledger - check the principal account under Change Loan.` });
  if (r.wiring === 'ok' && !r.closed && r.interestSource === 'none') out.push({ key: 'interest', text: 'Link Interest Account', tone: 'warn', title: 'No interest expense account is linked - pick it under Change Loan (pencil) so Interest Paid is read from the ledger.' });
  if (r.closed) out.push({ key: 'closed', text: 'Closed', tone: 'muted' });
  return out;
}
const TONE = { brand: 'var(--wk-brand, #2b45e1)', muted: 'var(--text-muted)', warn: 'var(--warn-fg)' };
export function Flags({ loan, style = null }) {
  const flags = loanFlags(loan);
  if (!flags.length) return null;
  return (
    <span style={{ display: 'flex', flexWrap: 'wrap', gap: '0 10px', fontSize: 12, fontWeight: 400, ...(style || {}) }}>
      {flags.map((f) => (
        <span key={f.key} title={f.title} style={{ color: TONE[f.tone], display: 'inline-flex', alignItems: 'center', gap: 3 }}>
          {f.tone === 'warn' && <WarnMark size={11} />}{f.text}
        </span>
      ))}
    </span>
  );
}

/**
 * `term(field, shown)` draws a typed term (Rate, Maturity, Monthly Payment)
 * the way the table does - a button that changes it in place for an editor.
 */
export default function LoanSheet({ loan, from, to, canEdit, term, figure = null, dscrText, rateText, onEdit, onPlan, onClose, blocked = false, onOpenEntry, onDrill, onSaved }) {
  const name = loan.lender || loan.loanNo || 'Loan';
  const backdrop = useBackdropClose(onClose);
  useEffect(() => {
    // Escape closes the sheet - not while something opened over it is up.
    const onKey = (e) => { if (e.key === 'Escape' && !blocked) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, blocked]);
  const sub = [loan.loanNo ? `Loan # ${loan.loanNo}` : '', loan.entityName || '', loan.internal ? 'Internal' : 'External'].filter(Boolean).join(' · ');
  const body = (
    <div className="modal-overlay" role="presentation" {...backdrop} style={{ zIndex: SHEET_Z }}>
      <div className="modal-content nx-popup acct-loans" role="dialog" aria-modal="true" aria-label={name} style={{ width: 'max(60vw, 720px)' }}>
        <div className="modal-header" style={{ alignItems: 'flex-start' }}>
          <div style={{ minWidth: 0 }}>
            <h3 style={{ margin: 0, fontSize: 18, fontWeight: 600, overflowWrap: 'anywhere' }}>{name}</h3>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 2 }}>{sub}</div>
            <Flags loan={loan} style={{ marginTop: 4 }} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            {canEdit && (
              <button type="button" className="secondary-btn" onClick={onEdit} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Pencil size={13} /> Change Loan
              </button>
            )}
            <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
          </div>
        </div>
        <div style={{ padding: '6px 24px 20px', display: 'grid', gap: 22, alignContent: 'start', flex: 1, minHeight: 0, overflowY: 'auto' }}>
          <section aria-label="Terms" style={{ display: 'grid' }}>
            <h4 style={sectionTitle}>Terms</h4>
            <Line label={`Balance as of ${formatDate(to)}`}>{figure ? figure('balance') : loan.wiring === 'missing' ? dash : money(loan.balance)}</Line>
            <Line label="Rate" title="Typed, not read from Intacct">{term('ratePct', rateText(loan) || dash)}</Line>
            <Line label="Maturity" title="Typed, not read from Intacct">{term('maturity', loan.maturity ? formatDate(loan.maturity) : dash)}</Line>
            <Line label="Monthly Payment" title="Typed, not read from Intacct">{term('monthlyPayment', loan.monthlyPayment == null ? dash : <Amount value={loan.monthlyPayment} />)}</Line>
            <Line label="Original Principal">{figure ? figure('original') : <>{money(loan.originalPrincipal)}{loan.originalPrincipalEdited && <span style={{ ...muted, fontSize: 12, marginLeft: 4 }}>edited</span>}</>}</Line>
            <Line label="Loan Type">{loanTypeLabel(loan.loanType) || dash}</Line>
            <Line label="DSCR" title={loan.dscr == null ? 'Nothing was serviced in the trailing twelve months' : undefined}>
              {loan.dscr == null ? dash : <span style={{ color: loan.belowCovenant ? 'var(--bad-fg, #dc2626)' : undefined, fontWeight: loan.belowCovenant ? 600 : undefined }}>{dscrText(loan)}</span>}
            </Line>
          </section>
          <section aria-label="In the Period" style={{ display: 'grid' }}>
            <h4 style={sectionTitle}>{from ? `${formatDate(from)} - ${formatDate(to)}` : `To ${formatDate(to)}`}</h4>
            <Line label="Principal Paid">{figure ? figure('principal') : money(loan.principalPaid, true)}</Line>
            <Line label="Interest Paid">{figure ? figure('interest') : money(loan.interestPaid, true)}</Line>
            <Line label="Debt Service">{figure ? figure('ds') : money(loan.debtService, true)}</Line>
            {loan.lineOfCredit && <Line label="Draws">{money(loan.draws, true)}</Line>}
          </section>
          <LoanDetail loan={loan} from={from} to={to} onOpenEntry={onOpenEntry} onDrill={onDrill} canEdit={canEdit} onSaved={onSaved} plain />
          <section aria-label="Tools" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <button type="button" className="secondary-btn" onClick={() => onPlan('amortization')}>Amortization Schedule</button>
            <button type="button" className="secondary-btn" onClick={() => onPlan('stress')}>Stress Test</button>
          </section>
        </div>
      </div>
    </div>
  );
  return typeof document === 'undefined' ? body : createPortal(body, document.body);
}

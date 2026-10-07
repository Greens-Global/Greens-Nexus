import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, Folder, X } from 'lucide-react';
import { api } from '../../api';
import Amount, { AmountInput, formatAmount } from './Amount';
import { EntityPicker, control } from './reportControls';
import { formatDate } from '../../lib/datetime';
import FolderPickModal from '../../egnyte/EgnyteFolderPick';

// Accounting -> Loans & Financing: Change Loan and + Add > Manual (Charmi and
// Neil, 10/03-10/04).
//
// Change Loan edits one fin_loans row - the same row Data > Loans keeps - and
// what Nexus keeps beside it:
//   Loan Name and Loan #     editable; the GL wiring stays as it is
//   Loan Type                Term Loan or Line of Credit (Oct 7: Draws show
//                            only for a line of credit); Automatic = read
//                            from the GL title ("LOC", "line of credit")
//   Principal Account        the liability the balance and the principal
//                            paid are read from (pick from the entity's
//                            accounts, or none: kept by hand)
//   Interest Account         the expense account the interest is read from;
//                            Automatic matches it by title
//   Original Principal       blank = the ledger's first credit on the account
//   Rate, Maturity, Monthly Payment   typed (the ledger cannot say them)
//   Internal / External      intercompany loans start Internal
//   Documents Folder / Statements Folder  an Egnyte folder each: Browse picks
//                            it in the same Files picker as Save to Files, or
//                            paste the path or the Egnyte link; Clear unwires
//
// + Add > Manual: a loan that is not in Intacct - lender, entity, loan #,
// original principal, balance, rate, maturity, monthly payment, type,
// Internal / External and the two folders.
//
// Oct 7 (Charmi, 23:21 - "the pencil opens Change Loan and it closes by
// itself", a BLOCKER): the window closed on ANY click whose target was its
// backdrop. A real browser sends exactly that in two everyday cases jsdom
// never produces: the second click of a double-click on the pencil (the
// backdrop appears under the pointer after the first click, so the second
// lands on it), and a press that starts in a field and is released past the
// window's edge (selecting the old value to type over it - the browser
// fires the click on the common ancestor, the backdrop). The backdrop now
// closes only on a single click that was also PRESSED on the backdrop, and
// not in the first moments after the window opens; the window is portaled to
// <body> so nothing in the Loans table's layout can clip or re-target it.

const label = { fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' };
const bad = { border: '1px solid var(--bad-fg, #dc2626)', color: 'var(--bad-fg, #dc2626)', borderRadius: 8, padding: '8px 12px', fontSize: '0.84rem' };
const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 10 };
const hint = { fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 3 };
const full = { ...control, width: '100%' };
const section = { fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginTop: 4 };

export const LOAN_TYPES = [['term', 'Term Loan'], ['line_of_credit', 'Line of Credit']];
export const loanTypeLabel = (t) => (LOAN_TYPES.find(([k]) => k === t) || [null, 'Term Loan'])[1];
/** The last part of an Egnyte path, for a link's text. */
export const folderName = (p) => String(p || '').split('/').filter(Boolean).pop() || '';

/** Backdrop handlers that close only on a deliberate click on the backdrop:
 *  pressed AND released there, a single click, not right after opening. */
export function useBackdropClose(onClose, graceMs = 400) {
  const pressed = useRef(false);
  const openedAt = useRef(Number.POSITIVE_INFINITY);
  useEffect(() => { openedAt.current = Date.now(); }, []);
  return {
    onMouseDown: (e) => { pressed.current = e.target === e.currentTarget; },
    onClick: (e) => {
      const deliberate = e.target === e.currentTarget && pressed.current && (e.detail || 1) <= 1 && Date.now() - openedAt.current >= graceMs;
      pressed.current = false;
      if (deliberate) onClose();
    },
  };
}

export function Dialog({ title, sub, onClose, onSubmit, busy, submitLabel, error, children, width = 720, footer = null }) {
  const backdrop = useBackdropClose(onClose);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const body = (
    <div className="modal-overlay" role="presentation" {...backdrop}>
      <form className="modal-content" role="dialog" aria-modal="true" aria-label={title} onSubmit={onSubmit} style={{ maxWidth: width }}>
        <div className="modal-header">
          <div>
            <h3 style={{ margin: 0 }}>{title}</h3>
            {sub && <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: 2 }}>{sub}</div>}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        <div style={{ padding: '14px 24px 6px', display: 'grid', gap: 12, maxHeight: '70vh', overflowY: 'auto' }}>
          {error && <div style={bad}>{error}</div>}
          {children}
        </div>
        <div className="modal-footer" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', padding: '10px 24px 16px' }}>
          {footer}
          <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary-btn" disabled={busy}>{busy ? 'Saving...' : submitLabel}</button>
        </div>
      </form>
    </div>
  );
  return typeof document === 'undefined' ? body : createPortal(body, document.body);
}

// An Egnyte folder: typed or pasted (path or link), or picked with Browse in
// the Files picker (the one Save to Files uses); Clear unwires it.
export function EgnyteField({ id, labelText, value, url, onChange }) {
  const [browsing, setBrowsing] = useState(false);
  return (
    <div>
      <label style={label} htmlFor={id}>{labelText}</label>
      <div style={{ display: 'flex', gap: 6 }}>
        <input id={id} type="text" value={value} onChange={(e) => onChange(e.target.value)} placeholder="/Shared/... or an Egnyte folder link" style={{ ...control, flex: 1, minWidth: 0 }} />
        <button type="button" className="secondary-btn" onClick={() => setBrowsing(true)} aria-haspopup="dialog" aria-label={`Browse for ${labelText}`}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', height: 30, padding: '0 10px' }}><Folder size={14} /> Browse</button>
        {value && <button type="button" className="secondary-btn" onClick={() => onChange('')} aria-label={`Clear ${labelText}`} style={{ fontSize: '0.78rem', height: 30, padding: '0 10px' }}>Clear</button>}
        {url && <a href={url} target="_blank" rel="noreferrer" aria-label={`Open ${labelText} in Egnyte`} title="Open in Egnyte" style={{ ...control, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 30, padding: 0, color: 'var(--text-secondary)' }}><ExternalLink size={14} /></a>}
      </div>
      {browsing && createPortal(
        <FolderPickModal startPath={value && value.startsWith('/') ? value : '/Shared'} showTree title={`${labelText} - Pick a Folder`}
          hint='Click through to the folder, then press "Use This Folder".'
          onPick={(p) => { onChange(p); setBrowsing(false); }} onClose={() => setBrowsing(false)} />,
        document.body,
      )}
    </div>
  );
}

const typeOptions = (
  <>
    <option value="external">External</option>
    <option value="internal">Internal</option>
  </>
);

export function EditLoanDialog({ loan, to, onClose, onSaved }) {
  const [d, setD] = useState(() => ({
    lender: loan.lender || '', loanNo: loan.loanNo || '', glAccount: loan.glAccount || '',
    interestAccount: loan.interestSource === 'wired' ? loan.interestAccount : '',
    originalPrincipal: loan.originalPrincipalEdited ? loan.originalPrincipal : null,
    balance: loan.wiring === 'manual' ? loan.balance : null,
    ratePct: loan.ratePct ?? '', rateType: loan.rateType || 'fixed', maturity: loan.maturity || '', monthlyPayment: loan.monthlyPayment ?? null,
    covenantMin: loan.covenantTyped ? loan.covenantMin : '', type: loan.internal ? 'internal' : 'external',
    loanType: loan.loanTypeGuessed === false ? loan.loanType || '' : '',
    docsPath: loan.docsPath || '', statementsPath: loan.statementsPath || '', notes: loan.notes || '', isActive: loan.isActive !== false,
  }));
  const [accounts, setAccounts] = useState(null);   // { principal: [], interest: [] } | null while loading
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (patch) => setD((x) => ({ ...x, ...patch }));
  useEffect(() => {
    let alive = true;
    if (!loan.entityCode) return undefined;
    const read = api.getLoanAccountsSlow || api.getLoanAccounts;
    read(loan.entityCode, to)
      .then((a) => { if (alive) setAccounts(a); })
      .catch(() => { if (alive) setAccounts({ principal: [], interest: [], failed: true }); });
    return () => { alive = false; };
  }, [loan.entityCode, to]);
  const principalList = useMemo(() => {
    const list = (accounts?.principal || []).filter((a) => (loan.kind === 'given' ? a.section === 'asset' : a.section === 'liability'));
    return d.glAccount && !list.some((a) => a.code === d.glAccount) ? [{ code: d.glAccount, title: loan.glTitle || '(not on this entity\'s ledger)' }, ...list] : list;
  }, [accounts, d.glAccount, loan.kind, loan.glTitle]);
  const interestList = useMemo(() => {
    const list = accounts?.interest || [];
    return d.interestAccount && !list.some((a) => a.code === d.interestAccount) ? [{ code: d.interestAccount, title: '', interest: true }, ...list] : list;
  }, [accounts, d.interestAccount]);
  const auto = loan.interestSource !== 'wired' && loan.interestAccounts?.length
    ? `Automatic (now ${loan.interestAccounts.map((a) => `GL ${a.code}`).join(', ')}${loan.interestSource === 'shared' ? ', shared' : ''})` : 'Automatic';
  const ledgerOriginal = loan.originalPrincipalLedger;
  const autoType = loan.loanTypeGuessed === false ? 'Automatic (from the GL title)' : `Automatic (now ${loanTypeLabel(loan.loanType)})`;

  const save = (e) => {
    e.preventDefault();
    if (!d.lender.trim()) { setError('The loan needs a name.'); return; }
    setBusy(true);
    setError('');
    const body = {
      lender: d.lender.trim(), loanNo: d.loanNo.trim(), ratePct: d.ratePct === '' ? 0 : Number(d.ratePct), rateType: d.rateType, maturity: d.maturity || '',
      monthlyPayment: d.monthlyPayment == null ? 0 : Number(d.monthlyPayment), covenantMin: d.covenantMin === '' ? 0 : Number(d.covenantMin), notes: d.notes, isActive: d.isActive,
      interestAccount: d.interestAccount || null, originalPrincipal: d.originalPrincipal == null ? null : Number(d.originalPrincipal),
      docsPath: d.docsPath.trim(), statementsPath: d.statementsPath.trim(),
    };
    if ((d.type === 'internal') !== !!loan.internal) body.internal = d.type === 'internal';
    if (d.glAccount !== (loan.glAccount || '')) body.glAccount = d.glAccount;
    if (!d.glAccount && d.balance != null) body.balance = Number(d.balance);
    if (d.loanType !== (loan.loanTypeGuessed === false ? loan.loanType || '' : '')) body.loanType = d.loanType;
    api.updateLoan(loan.id, '', body)
      .then(onSaved).catch((err) => { setError(err?.message || 'Could not save.'); setBusy(false); });
  };

  return (
    <Dialog title="Change Loan" onClose={onClose} onSubmit={save} busy={busy} submitLabel="Save" error={error}
      sub={<>{loan.entityName} ({loan.entityCode}) · balance <Amount value={loan.balance} /> as of {formatDate(to)}. The same loan as Accounting &gt; Data &gt; Loans.</>}>
      <div style={grid}>
        <div><label style={label} htmlFor="loan-lender">Loan Name (Lender)</label><input id="loan-lender" type="text" value={d.lender} maxLength={120} onChange={(e) => set({ lender: e.target.value })} style={full} /></div>
        <div><label style={label} htmlFor="loan-no">Loan #</label><input id="loan-no" type="text" value={d.loanNo} maxLength={40} onChange={(e) => set({ loanNo: e.target.value })} style={full} /></div>
        <div><label style={label} htmlFor="loan-type">Internal or External</label><select id="loan-type" value={d.type} onChange={(e) => set({ type: e.target.value })} style={full}>{typeOptions}</select></div>
        <div>
          <label style={label} htmlFor="loan-kind">Loan Type</label>
          <select id="loan-kind" value={d.loanType} onChange={(e) => set({ loanType: e.target.value })} style={full}>
            <option value="">{autoType}</option>
            {LOAN_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <div style={hint}>Draws show only for a Line of Credit.</div>
        </div>
      </div>

      <div style={section}>Ledger Wiring</div>
      <div style={grid}>
        <div>
          <label style={label} htmlFor="loan-gl">Principal Account</label>
          <select id="loan-gl" value={d.glAccount} onChange={(e) => set({ glAccount: e.target.value })} style={full} disabled={!loan.entityCode}>
            <option value="">None - kept by hand</option>
            {principalList.map((a) => <option key={a.code} value={a.code}>{a.code}{a.title ? ` ${a.title}` : ''}{a.balance != null ? ` (${formatAmount(a.balance)})` : ''}</option>)}
          </select>
          <div style={hint}>{accounts === null && loan.entityCode ? 'Reading the entity\'s accounts...' : 'The balance and the principal paid (the debits in the period) are read from it.'}</div>
        </div>
        <div>
          <label style={label} htmlFor="loan-interest">Interest Account</label>
          <select id="loan-interest" value={d.interestAccount} onChange={(e) => set({ interestAccount: e.target.value })} style={full} disabled={!loan.entityCode}>
            <option value="">{auto}</option>
            {interestList.map((a) => <option key={a.code} value={a.code}>{a.code}{a.title ? ` ${a.title}` : ''}{a.interest ? '' : ' (not titled Interest)'}</option>)}
          </select>
          <div style={hint}>Interest paid is the net debits to this account in the period.</div>
        </div>
        <div>
          <label style={label} htmlFor="loan-original">Original Principal</label>
          <AmountInput id="loan-original" value={d.originalPrincipal} onChange={(v) => set({ originalPrincipal: v })} placeholder={ledgerOriginal != null ? formatAmount(ledgerOriginal) : '0.00'} style={full} />
          <div style={hint}>{ledgerOriginal != null ? `Blank = the ledger's first credit, ${formatAmount(ledgerOriginal)}${loan.originalPrincipalDate ? ` on ${formatDate(loan.originalPrincipalDate)}` : ''}.` : 'Blank = the first credit on the principal account.'}</div>
        </div>
        {!d.glAccount && (
          <div>
            <label style={label} htmlFor="loan-balance">Balance</label>
            <AmountInput id="loan-balance" value={d.balance} onChange={(v) => set({ balance: v })} style={full} />
            <div style={hint}>Kept by hand: no principal account.</div>
          </div>
        )}
      </div>

      <div style={section}>Terms</div>
      <div style={grid}>
        <div><label style={label} htmlFor="loan-rate">Rate %</label><input id="loan-rate" type="number" step="0.001" min="0" value={d.ratePct} onChange={(e) => set({ ratePct: e.target.value })} style={full} /></div>
        <div><label style={label} htmlFor="loan-rate-type">Fixed or Variable</label><select id="loan-rate-type" value={d.rateType} onChange={(e) => set({ rateType: e.target.value })} style={full}><option value="fixed">Fixed</option><option value="variable">Variable</option></select></div>
        <div><label style={label} htmlFor="loan-maturity">Maturity</label><input id="loan-maturity" type="date" value={d.maturity} onChange={(e) => set({ maturity: e.target.value })} style={full} /></div>
        <div><label style={label} htmlFor="loan-payment">Monthly Payment</label><AmountInput id="loan-payment" value={d.monthlyPayment} onChange={(v) => set({ monthlyPayment: v })} style={full} /></div>
        <div><label style={label} htmlFor="loan-cov">Covenant Minimum (DSCR)</label><input id="loan-cov" type="number" step="0.01" min="0" value={d.covenantMin} onChange={(e) => set({ covenantMin: e.target.value })} placeholder="1.35" style={full} /></div>
      </div>

      <div style={section}>Egnyte</div>
      <EgnyteField id="loan-docs" labelText="Documents Folder" value={d.docsPath} url={loan.docsUrl} onChange={(v) => set({ docsPath: v })} />
      <EgnyteField id="loan-statements" labelText="Statements Folder" value={d.statementsPath} url={loan.statementsUrl} onChange={(v) => set({ statementsPath: v })} />

      <div><label style={label} htmlFor="loan-notes">Notes</label><input id="loan-notes" type="text" value={d.notes} maxLength={200} onChange={(e) => set({ notes: e.target.value })} style={full} /></div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.82rem' }}>
        <input type="checkbox" checked={d.isActive} onChange={(e) => set({ isActive: e.target.checked })} /> Active (an inactive loan is closed: hidden unless Show Closed Loans)
      </label>
    </Dialog>
  );
}

export function ManualLoanDialog({ entities, showHistorical = false, onClose, onSaved }) {
  const [d, setD] = useState({ lender: '', entityCode: '', loanNo: '', originalPrincipal: null, balance: null, ratePct: '', rateType: 'fixed', maturity: '', monthlyPayment: null, type: 'external', loanType: 'term', docsPath: '', statementsPath: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (patch) => setD((x) => ({ ...x, ...patch }));
  const save = (e) => {
    e.preventDefault();
    if (!d.lender.trim()) { setError('Give the loan a lender.'); return; }
    if (!d.entityCode) { setError('Pick the entity that owes the loan.'); return; }
    setBusy(true);
    setError('');
    api.createManualLoan({
      lender: d.lender.trim(), entityCode: d.entityCode, loanNo: d.loanNo.trim(), originalPrincipal: d.originalPrincipal, balance: d.balance ?? 0,
      ratePct: d.ratePct === '' ? null : Number(d.ratePct), rateType: d.rateType, maturity: d.maturity || null, monthlyPayment: d.monthlyPayment, internal: d.type === 'internal',
      loanType: d.loanType, docsPath: d.docsPath.trim() || null, statementsPath: d.statementsPath.trim() || null,
    }).then(onSaved).catch((err) => { setError(err?.message || 'Could not add the loan.'); setBusy(false); });
  };
  return (
    <Dialog title="Add a Loan by Hand" onClose={onClose} onSubmit={save} busy={busy} submitLabel="Add Loan" error={error} width={680}
      sub="A loan that is not in Intacct. Its balance is kept by hand here; wire a principal account later under Change Loan to read it from the ledger.">
      <div style={grid}>
        <div><label style={label} htmlFor="manual-lender">Lender</label><input id="manual-lender" type="text" value={d.lender} maxLength={120} onChange={(e) => set({ lender: e.target.value })} style={full} autoFocus /></div>
        <div>
          <span style={label} id="manual-entity-label">Entity</span>
          <EntityPicker entities={entities} value={d.entityCode} onChange={(code) => set({ entityCode: code })} showHistorical={showHistorical}
            placeholder="Pick an Entity" active={false} style={{ ...full, maxWidth: 'none' }} />

        </div>
        <div><label style={label} htmlFor="manual-no">Loan #</label><input id="manual-no" type="text" value={d.loanNo} maxLength={40} onChange={(e) => set({ loanNo: e.target.value })} style={full} /></div>
        <div><label style={label} htmlFor="manual-original">Original Principal</label><AmountInput id="manual-original" value={d.originalPrincipal} onChange={(v) => set({ originalPrincipal: v })} style={full} /></div>
        <div><label style={label} htmlFor="manual-balance">Balance</label><AmountInput id="manual-balance" value={d.balance} onChange={(v) => set({ balance: v })} style={full} /></div>
        <div><label style={label} htmlFor="manual-rate">Rate %</label><input id="manual-rate" type="number" step="0.001" min="0" value={d.ratePct} onChange={(e) => set({ ratePct: e.target.value })} style={full} /></div>
        <div><label style={label} htmlFor="manual-rate-type">Fixed or Variable</label><select id="manual-rate-type" value={d.rateType} onChange={(e) => set({ rateType: e.target.value })} style={full}><option value="fixed">Fixed</option><option value="variable">Variable</option></select></div>
        <div><label style={label} htmlFor="manual-maturity">Maturity</label><input id="manual-maturity" type="date" value={d.maturity} onChange={(e) => set({ maturity: e.target.value })} style={full} /></div>
        <div><label style={label} htmlFor="manual-payment">Monthly Payment</label><AmountInput id="manual-payment" value={d.monthlyPayment} onChange={(v) => set({ monthlyPayment: v })} style={full} /></div>
        <div><label style={label} htmlFor="manual-type">Internal or External</label><select id="manual-type" value={d.type} onChange={(e) => set({ type: e.target.value })} style={full}>{typeOptions}</select></div>
        <div><label style={label} htmlFor="manual-kind">Loan Type</label><select id="manual-kind" value={d.loanType} onChange={(e) => set({ loanType: e.target.value })} style={full}>{LOAN_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
      </div>
      <div style={section}>Egnyte</div>
      <EgnyteField id="manual-docs" labelText="Documents Folder" value={d.docsPath} onChange={(v) => set({ docsPath: v })} />
      <EgnyteField id="manual-statements" labelText="Statements Folder" value={d.statementsPath} onChange={(v) => set({ statementsPath: v })} />
    </Dialog>
  );
}

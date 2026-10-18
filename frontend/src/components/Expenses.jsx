// Expense reimbursement (Neil, Oct 17 2026) - routers/expenses.py.
//
//   MyExpenses     Workday > Expenses: submit a claim (receipt + proof of
//                  payment), see your claims, fix and resubmit a sent-back one.
//   TeamExpenses   Team > Requests (pending + history of your team) and
//                  People > person > Expenses (`email` narrows to one person).
//   ExpenseQueue   Reimbursements (the `reimbursements` grant): accounting
//                  approves, marks paid, exports CSV.
//
// One detail popup (ExpenseDetail) serves all three; the buttons in its
// footer are the only thing that differs. Files go to the private
// ticket-evidence bucket and open through /files/view (storageView.js).
import { useCallback, useEffect, useState } from 'react';
import { Receipt, Upload, X, FileText, Download } from 'lucide-react';
import { api } from '../api';
import { Modal } from '../tasks/components';
import { filesFromPaste } from '../tasks/lib';
import { uploadTicketEvidence } from '../tickets/evidenceUpload';
import AsyncSection, { SkeletonBlocks, Spinner } from './AsyncState';
import { formatDate, formatDateTime } from '../lib/datetime';

const CATEGORIES = [
  ['travel', 'Travel'], ['meals', 'Meals'], ['mileage', 'Mileage'], ['supplies', 'Supplies'],
  ['software', 'Software'], ['equipment', 'Equipment'], ['other', 'Other'],
];
const CATEGORY_LABEL = Object.fromEntries(CATEGORIES);
const CURRENCIES = ['USD', 'INR', 'CAD'];
const PAY_METHODS = [['ach', 'ACH / Bank Transfer'], ['payroll', 'With Payroll'], ['check', 'Check'], ['other', 'Other']];

const STATUS = {
  submitted:        { label: 'Awaiting Manager',    color: '#b45309', tint: 'rgba(180,83,9,0.1)' },
  manager_approved: { label: 'Awaiting Accounting', color: '#1d4ed8', tint: 'rgba(29,78,216,0.08)' },
  approved:         { label: 'Approved - To Pay',   color: 'hsl(var(--color-green))', tint: 'hsla(var(--color-green),0.1)' },
  paid:             { label: 'Paid',                color: 'hsl(var(--color-green))', tint: 'hsla(var(--color-green),0.16)' },
  sent_back:        { label: 'Sent Back',           color: '#b45309', tint: 'rgba(180,83,9,0.1)' },
  rejected:         { label: 'Rejected',            color: '#b91c1c', tint: 'rgba(185,28,28,0.08)' },
  canceled:         { label: 'Canceled',            color: 'var(--muted)', tint: 'var(--mist)' },
};
const STEP_LABEL = {
  submitted: 'Submitted', resubmitted: 'Resubmitted', canceled: 'Canceled',
  manager_approve: 'Approved by Manager', manager_reject: 'Rejected by Manager', manager_send_back: 'Sent Back by Manager',
  accounting_approve: 'Approved by Accounting', accounting_reject: 'Rejected by Accounting',
  accounting_send_back: 'Sent Back by Accounting', paid: 'Paid',
};

const HD = { fontSize: 13.5, fontWeight: 600, color: 'var(--ink)' };
const LBL = { fontSize: 12, fontWeight: 600, color: 'var(--ink)' };
const INPUT = { width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--line)',
  background: 'var(--card)', color: 'var(--ink)', fontSize: 13, fontFamily: 'inherit' };
const CARD = { background: 'var(--card)', border: '1px solid var(--wk-line2, var(--line))', borderRadius: 16,
  boxShadow: 'var(--wk-shadow)', marginBottom: 12 };
const BTN = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: 8, border: '1px solid var(--line)',
  background: 'var(--card)', color: 'var(--ink)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' };
const PRIMARY = { ...BTN, background: 'var(--wk-brand, #1f6f43)', borderColor: 'transparent', color: '#fff' };
const DANGER = { ...BTN, color: '#b91c1c' };

const money = (amount, currency = 'USD') => {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount || 0);
  } catch {
    return `${currency} ${(amount || 0).toFixed(2)}`;
  }
};
const isImage = (u) => /\.(png|jpe?g|gif|webp)(\?|$|%3F)/i.test(decodeURIComponent(u || ''));
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function StatusChip({ status }) {
  const s = STATUS[status] || { label: status, color: 'var(--muted)', tint: 'var(--mist)' };
  return (
    <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 10px', borderRadius: 999, whiteSpace: 'nowrap',
      background: s.tint, color: s.color }}>{s.label}</span>
  );
}

// ── Files ────────────────────────────────────────────────────────────────────

function FileThumbs({ urls, onRemove }) {
  if (!urls?.length) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {urls.map((u, i) => (
        <div key={u} style={{ position: 'relative' }}>
          <a href={u} target="_blank" rel="noreferrer" title="Open full size"
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 92, height: 92, borderRadius: 10,
              border: '1px solid var(--line)', overflow: 'hidden', background: 'var(--mist)', color: 'var(--muted)', textDecoration: 'none' }}>
            {isImage(u)
              ? <img src={u} alt={`Attachment ${i + 1}`} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              : <span style={{ display: 'grid', justifyItems: 'center', gap: 4, fontSize: 11, fontWeight: 600 }}><FileText size={22} />PDF</span>}
          </a>
          {onRemove && (
            <button type="button" onClick={() => onRemove(u)} aria-label="Remove file"
              style={{ position: 'absolute', top: -6, right: -6, width: 20, height: 20, borderRadius: 999, border: 'none',
                background: '#b91c1c', color: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <X size={12} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

// Click to pick, or click the box and press Ctrl+V to paste a screenshot.
function FileDrop({ label, hint, urls, onChange }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const upload = async (files) => {
    if (!files.length) return;
    setBusy(true); setErr('');
    try {
      const added = [];
      for (const f of files) {
        if (f.size > 15 * 1024 * 1024) throw new Error(`${f.name} is over 15 MB`);
        if (!/^image\//.test(f.type) && f.type !== 'application/pdf') throw new Error('Attach a photo, screenshot or PDF');
        added.push(await uploadTicketEvidence(f, 'expense'));
      }
      onChange([...urls, ...added]);
    } catch (e) {
      setErr(e.message || 'Upload failed');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <span style={LBL}>{label}</span>
      <label tabIndex={0} onPaste={e => { const f = filesFromPaste(e); if (f.length) { e.preventDefault(); upload(f); } }}
        style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', borderRadius: 10, cursor: 'pointer',
          border: '1.5px dashed var(--line)', background: 'var(--mist)', fontSize: 12.5, color: 'var(--muted)' }}>
        {busy ? <Spinner size={14} /> : <Upload size={15} />}
        <span><b style={{ color: 'var(--ink)' }}>Choose files</b> or click here and press Ctrl+V to paste a screenshot. {hint}</span>
        <input type="file" accept="image/*,application/pdf" multiple hidden disabled={busy}
          onChange={e => { upload([...e.target.files]); e.target.value = ''; }} />
      </label>
      {err && <span style={{ fontSize: 12, color: '#b91c1c' }}>{err}</span>}
      <FileThumbs urls={urls} onRemove={u => onChange(urls.filter(x => x !== u))} />
    </div>
  );
}

// ── Claim form (new or resubmit) ─────────────────────────────────────────────

const blank = () => ({ expense_date: today(), vendor: '', category: 'supplies', amount: '', currency: 'USD',
  description: '', receipt_urls: [], payment_proof_urls: [] });

function ClaimForm({ initial, onDone, onCancel }) {
  const [f, setF] = useState(initial || blank());
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const set = (k) => (v) => setF(p => ({ ...p, [k]: v?.target ? v.target.value : v }));
  const submit = async () => {
    setSaving(true); setErr('');
    try {
      const body = { ...f, amount: Number(f.amount) };
      const row = f.id ? await api.expenseResubmit(f.id, body) : await api.expenseSubmit(body);
      setF(blank());
      onDone(row);
    } catch (e) {
      setErr(e.message || 'Could not submit');
    } finally {
      setSaving(false);
    }
  };
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, alignItems: 'end' }}>
        <label style={{ display: 'grid', gap: 5 }}><span style={LBL}>Date Paid</span>
          <input type="date" max={today()} value={f.expense_date} onChange={set('expense_date')} style={INPUT} /></label>
        <label style={{ display: 'grid', gap: 5 }}><span style={LBL}>Paid To</span>
          <input value={f.vendor} onChange={set('vendor')} placeholder="Vendor or store" style={INPUT} /></label>
        <label style={{ display: 'grid', gap: 5 }}><span style={LBL}>Category</span>
          <select value={f.category} onChange={set('category')} style={INPUT}>
            {CATEGORIES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select></label>
        <label style={{ display: 'grid', gap: 5 }}><span style={LBL}>Amount</span>
          <div style={{ display: 'flex', gap: 6 }}>
            <input type="number" min="0" step="0.01" inputMode="decimal" value={f.amount} onChange={set('amount')} placeholder="0.00" style={INPUT} />
            <select value={f.currency} onChange={set('currency')} style={{ ...INPUT, width: 78 }} aria-label="Currency">
              {CURRENCIES.map(c => <option key={c}>{c}</option>)}
            </select>
          </div></label>
      </div>
      <label style={{ display: 'grid', gap: 5 }}><span style={LBL}>What Was It For</span>
        <textarea rows={2} value={f.description} onChange={set('description')} placeholder="e.g. Paint and rollers for unit 4 turnover"
          style={{ ...INPUT, resize: 'vertical' }} /></label>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12 }}>
        <FileDrop label="Receipt" hint="The itemized receipt or invoice." urls={f.receipt_urls} onChange={set('receipt_urls')} />
        <FileDrop label="Proof of Payment" hint="Card slip, statement line or transfer confirmation." urls={f.payment_proof_urls} onChange={set('payment_proof_urls')} />
      </div>
      {err && <div role="alert" style={{ fontSize: 12.5, color: '#b91c1c' }}>{err}</div>}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        {onCancel && <button type="button" style={BTN} onClick={onCancel}>Cancel</button>}
        <button type="button" style={{ ...PRIMARY, opacity: saving ? 0.6 : 1 }} disabled={saving} onClick={submit}>
          {saving && <Spinner size={12} color="#fff" />} {f.id ? 'Resubmit Claim' : 'Submit Claim'}
        </button>
      </div>
    </div>
  );
}

// ── List + detail ────────────────────────────────────────────────────────────

function ClaimRows({ claims, onOpen, showPerson }) {
  return claims.map(c => (
    <button key={c.id} type="button" onClick={() => onOpen(c)}
      style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 16px', width: '100%', textAlign: 'left',
        border: 'none', borderBottom: '1px solid var(--line)', background: 'none', cursor: 'pointer', flexWrap: 'wrap', fontFamily: 'inherit' }}>
      <span style={{ width: 30, height: 30, borderRadius: 8, background: 'var(--mist)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <Receipt size={15} color="var(--muted)" />
      </span>
      <div style={{ minWidth: 160, flex: '1 1 220px' }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)' }}>
          {showPerson ? `${c.employeeName || c.employeeEmail} - ` : ''}{c.vendor}
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>{formatDate(c.expenseDate)} · {CATEGORY_LABEL[c.category] || c.category}</div>
      </div>
      <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)', minWidth: 90, textAlign: 'right' }}>{money(c.amount, c.currency)}</span>
      <StatusChip status={c.status} />
    </button>
  ));
}

function DecisionBar({ onDecide, busy }) {
  const [note, setNote] = useState('');
  return (
    <div style={{ display: 'grid', gap: 8, width: '100%' }}>
      <input value={note} onChange={e => setNote(e.target.value)} placeholder="Note (required to send back or reject)" style={INPUT} />
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        <button type="button" style={DANGER} disabled={busy} onClick={() => onDecide('reject', note)}>Reject</button>
        <button type="button" style={BTN} disabled={busy} onClick={() => onDecide('send_back', note)}>Send Back</button>
        <button type="button" style={PRIMARY} disabled={busy} onClick={() => onDecide('approve', note)}>
          {busy && <Spinner size={12} color="#fff" />} Approve
        </button>
      </div>
    </div>
  );
}

function PaidBar({ onPaid, busy }) {
  const [p, setP] = useState({ paid_on: today(), payment_method: 'ach', payment_ref: '' });
  const set = (k) => (e) => setP(x => ({ ...x, [k]: e.target.value }));
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'end', flexWrap: 'wrap', width: '100%', justifyContent: 'flex-end' }}>
      <label style={{ display: 'grid', gap: 4 }}><span style={LBL}>Paid On</span>
        <input type="date" value={p.paid_on} onChange={set('paid_on')} style={INPUT} /></label>
      <label style={{ display: 'grid', gap: 4 }}><span style={LBL}>Method</span>
        <select value={p.payment_method} onChange={set('payment_method')} style={INPUT}>
          {PAY_METHODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select></label>
      <label style={{ display: 'grid', gap: 4, flex: '1 1 160px' }}><span style={LBL}>Reference</span>
        <input value={p.payment_ref} onChange={set('payment_ref')} placeholder="Transfer or check number" style={INPUT} /></label>
      <button type="button" style={PRIMARY} disabled={busy} onClick={() => onPaid(p)}>
        {busy && <Spinner size={12} color="#fff" />} Mark Paid
      </button>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ display: 'grid', gap: 2 }}>
      <span style={{ fontSize: 11.5, color: 'var(--muted)', fontWeight: 600 }}>{label}</span>
      <span style={{ fontSize: 13.5, color: 'var(--ink)' }}>{children || '-'}</span>
    </div>
  );
}

export function ExpenseDetail({ claim: c, onClose, footer }) {
  return (
    <Modal title={`${c.vendor} - ${money(c.amount, c.currency)}`} onClose={onClose} footer={footer}>
      <div style={{ display: 'grid', gap: 18, fontFamily: 'Inter,sans-serif' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 14 }}>
          <Field label="Employee">{c.employeeName || c.employeeEmail}</Field>
          <Field label="Date Paid">{formatDate(c.expenseDate)}</Field>
          <Field label="Category">{CATEGORY_LABEL[c.category] || c.category}</Field>
          <Field label="Amount">{money(c.amount, c.currency)}</Field>
          <Field label="Status"><StatusChip status={c.status} /></Field>
          {c.status === 'paid' && <Field label="Paid">{formatDate(c.paidOn)} · {(PAY_METHODS.find(m => m[0] === c.paymentMethod) || [])[1]}{c.paymentRef ? ` · ${c.paymentRef}` : ''}</Field>}
        </div>
        {c.description && <Field label="What Was It For">{c.description}</Field>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14 }}>
          <div style={{ display: 'grid', gap: 6 }}><span style={LBL}>Receipt</span><FileThumbs urls={c.receiptUrls} /></div>
          <div style={{ display: 'grid', gap: 6 }}><span style={LBL}>Proof of Payment</span><FileThumbs urls={c.paymentProofUrls} /></div>
        </div>
        <div style={{ display: 'grid', gap: 8 }}>
          <span style={LBL}>Timeline</span>
          {(c.history || []).map((h, i) => (
            <div key={i} style={{ display: 'flex', gap: 10, fontSize: 12.5, alignItems: 'baseline' }}>
              <span style={{ width: 8, height: 8, borderRadius: 999, background: 'var(--wk-brand, #1f6f43)', flexShrink: 0, transform: 'translateY(-1px)' }} />
              <span style={{ color: 'var(--ink)', fontWeight: 600 }}>{STEP_LABEL[h.action] || h.action}</span>
              <span style={{ color: 'var(--muted)' }}>{h.byName || h.by} · {formatDateTime(h.at)}</span>
              {h.note && <span style={{ color: 'var(--ink)' }}>- {h.note}</span>}
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}

function useClaims(load) {
  const [state, setState] = useState({ data: null, error: null });
  const reload = useCallback(() => {
    load().then(data => setState({ data, error: null }), error => setState(s => ({ data: s.data, error })));
  }, [load]);
  useEffect(reload, [reload]);
  return [state, reload, (data) => setState({ data, error: null })];
}

function replace(list, row) {
  return (list || []).map(c => (c.id === row.id ? row : c));
}

// ── Workday > Expenses ───────────────────────────────────────────────────────

export function MyExpenses({ toast }) {
  const [{ data, error }, reload, setData] = useClaims(api.expensesMine);
  const [open, setOpen] = useState(null);
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const done = (row, text) => {
    setData([row, ...(data || []).filter(c => c.id !== row.id)]);
    setOpen(null); setEditing(null);
    toast?.(true, text);
  };
  const cancel = async (c) => {
    setBusy(true);
    try { done(await api.expenseCancel(c.id), 'Claim canceled'); }
    catch (e) { toast?.(false, e.message || 'Could not cancel'); }
    finally { setBusy(false); }
  };
  const editFrom = (c) => ({ id: c.id, expense_date: c.expenseDate, vendor: c.vendor, category: c.category, amount: String(c.amount),
    currency: c.currency, description: c.description, receipt_urls: c.receiptUrls, payment_proof_urls: c.paymentProofUrls });
  return (
    <>
      <div style={{ ...CARD, padding: '16px 18px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 6 }}>
          <span className="wkc-chip"><Receipt size={14} /></span>
          <span style={HD}>Request a Reimbursement</span>
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 14 }}>
          Paid for something for the company? Attach the receipt and proof that you paid. Your manager approves it, then accounting pays you back.
        </div>
        <ClaimForm onDone={row => done(row, 'Claim submitted - your manager has been notified')} />
      </div>
      <div style={{ ...CARD, overflow: 'hidden', marginBottom: 24 }}>
        <div style={{ padding: '13px 16px', borderBottom: '1px solid var(--line)' }}><span style={HD}>My Claims</span></div>
        <AsyncSection loading={data === null} error={error && data === null} onRetry={reload}
          skeleton={<div style={{ padding: 16 }}><SkeletonBlocks count={2} height={18} /></div>}
          isEmpty={data?.length === 0}
          emptyContent={<div style={{ padding: 18, fontSize: 12.5, color: 'var(--muted)', textAlign: 'center' }}>No claims yet.</div>}>
          <ClaimRows claims={data || []} onOpen={setOpen} />
        </AsyncSection>
      </div>
      {open && !editing && (
        <ExpenseDetail claim={open} onClose={() => setOpen(null)} footer={(open.status === 'submitted' || open.status === 'sent_back') && (
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', width: '100%' }}>
            <button type="button" style={DANGER} disabled={busy} onClick={() => cancel(open)}>Cancel Claim</button>
            {open.status === 'sent_back' && <button type="button" style={PRIMARY} onClick={() => setEditing(editFrom(open))}>Edit & Resubmit</button>}
          </div>
        )} />
      )}
      {editing && (
        <Modal title="Edit & Resubmit" onClose={() => setEditing(null)}>
          <ClaimForm initial={editing} onCancel={() => setEditing(null)} onDone={row => done(row, 'Claim resubmitted')} />
        </Modal>
      )}
    </>
  );
}

// ── Team > Requests, People > person > Expenses ──────────────────────────────

export function TeamExpenses({ email = '', toastOk, toastErr }) {
  const load = useCallback(() => api.expensesTeam(email), [email]);
  const [{ data, error }, reload, setData] = useClaims(load);
  const [tab, setTab] = useState(email ? 'history' : 'pending');
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState(false);
  const pending = (data || []).filter(c => c.status === 'submitted');
  const shown = tab === 'pending' ? pending : (data || []);
  const decide = async (action, note) => {
    setBusy(true);
    try {
      const row = await api.expenseManagerDecide(open.id, { action, note });
      setData(replace(data, row)); setOpen(null);
      toastOk?.(action === 'approve' ? 'Approved - sent to accounting' : action === 'reject' ? 'Claim rejected' : 'Sent back to the employee');
    } catch (e) {
      toastErr?.(e.message || 'Could not save');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ ...CARD, overflow: 'hidden', marginTop: email ? 0 : 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--line)', flexWrap: 'wrap' }}>
        <span style={HD}>Expense Claims</span>
        <span style={{ flex: 1 }} />
        {[['pending', `Pending${pending.length ? ` (${pending.length})` : ''}`], ['history', 'All Claims']].map(([k, l]) => (
          <button key={k} type="button" onClick={() => setTab(k)}
            style={{ ...BTN, padding: '5px 12px', background: tab === k ? 'var(--mist)' : 'var(--card)', fontWeight: tab === k ? 700 : 600 }}>{l}</button>
        ))}
      </div>
      <AsyncSection loading={data === null} error={error && data === null} onRetry={reload}
        skeleton={<div style={{ padding: 16 }}><SkeletonBlocks count={2} height={18} /></div>}
        isEmpty={shown.length === 0}
        emptyContent={<div style={{ padding: 18, fontSize: 12.5, color: 'var(--muted)', textAlign: 'center' }}>
          {tab === 'pending' ? 'No expense claims waiting on you.' : 'No expense claims yet.'}</div>}>
        <ClaimRows claims={shown} onOpen={setOpen} showPerson={!email} />
      </AsyncSection>
      {open && (
        <ExpenseDetail claim={open} onClose={() => setOpen(null)}
          footer={open.status === 'submitted' && <DecisionBar busy={busy} onDecide={decide} />} />
      )}
    </div>
  );
}

// ── Reimbursements (accounting) ──────────────────────────────────────────────

const QUEUE_TABS = [['manager_approved', 'To Review'], ['approved', 'To Pay'], ['paid', 'Paid'], ['', 'All']];

function exportCsv(rows) {
  const head = ['Employee', 'Email', 'Date Paid', 'Paid To', 'Category', 'Amount', 'Currency', 'Status', 'Paid On', 'Method', 'Reference', 'Description'];
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = rows.map(c => [c.employeeName, c.employeeEmail, formatDate(c.expenseDate), c.vendor, CATEGORY_LABEL[c.category] || c.category,
    c.amount.toFixed(2), c.currency, (STATUS[c.status] || {}).label || c.status, formatDate(c.paidOn), c.paymentMethod, c.paymentRef, c.description].map(cell).join(','));
  const url = URL.createObjectURL(new Blob([[head.map(cell).join(','), ...lines].join('\r\n')], { type: 'text/csv' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `reimbursements-${today()}.csv` });
  a.click();
  URL.revokeObjectURL(url);
}

export function ExpenseQueue() {
  const [{ data, error }, reload, setData] = useClaims(api.expensesQueue);
  const [tab, setTab] = useState('manager_approved');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const claims = data?.claims || [];
  const needle = q.trim().toLowerCase();
  const shown = claims.filter(c => (!tab || c.status === tab)
    && (!needle || `${c.employeeName} ${c.employeeEmail} ${c.vendor}`.toLowerCase().includes(needle)));
  const count = (s) => claims.filter(c => c.status === s).length;
  const act = async (call, text) => {
    setBusy(true);
    try {
      const row = await call();
      setData({ ...data, claims: replace(claims, row) }); setOpen(null); setMsg({ ok: true, text });
    } catch (e) {
      setMsg({ ok: false, text: e.message || 'Could not save' });
    } finally {
      setBusy(false);
    }
  };
  const footer = open && data?.canReview && (
    open.status === 'manager_approved'
      ? <DecisionBar busy={busy} onDecide={(action, note) => act(() => api.expenseReview(open.id, { action, note }),
        action === 'approve' ? 'Approved - ready to pay' : action === 'reject' ? 'Claim rejected' : 'Sent back to the employee')} />
      : open.status === 'approved'
        ? <PaidBar busy={busy} onPaid={p => act(() => api.expenseMarkPaid(open.id, p), 'Marked paid - the employee has been notified')} />
        : null);
  return (
    <div style={{ fontFamily: 'Inter,sans-serif', maxWidth: 1100, margin: '0 auto' }}>
      {msg && (
        <div role="status" style={{ padding: '10px 14px', borderRadius: 10, marginBottom: 12, fontSize: 13, fontWeight: 600,
          background: msg.ok ? 'hsla(var(--color-green),0.1)' : 'rgba(220,38,38,0.08)', color: msg.ok ? 'hsl(var(--color-green))' : '#b91c1c' }}>{msg.text}</div>
      )}
      <div style={{ ...CARD, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--line)', flexWrap: 'wrap' }}>
          <div className="scroll-tabs" style={{ display: 'flex', gap: 6 }}>
            {QUEUE_TABS.map(([k, l]) => (
              <button key={k || 'all'} type="button" onClick={() => setTab(k)}
                style={{ ...BTN, padding: '5px 12px', background: tab === k ? 'var(--mist)' : 'var(--card)', fontWeight: tab === k ? 700 : 600 }}>
                {l}{k && k !== 'paid' && count(k) ? ` (${count(k)})` : ''}
              </button>
            ))}
          </div>
          <span style={{ flex: 1 }} />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search person or vendor" style={{ ...INPUT, width: 220 }} />
          <button type="button" style={BTN} disabled={!shown.length} onClick={() => exportCsv(shown)}><Download size={14} /> Export CSV</button>
        </div>
        <AsyncSection loading={data === null} error={error && data === null} onRetry={reload}
          skeleton={<div style={{ padding: 16 }}><SkeletonBlocks count={3} height={18} /></div>}
          isEmpty={shown.length === 0}
          emptyContent={<div style={{ padding: 24, fontSize: 12.5, color: 'var(--muted)', textAlign: 'center' }}>Nothing here.</div>}>
          <ClaimRows claims={shown} onOpen={setOpen} showPerson />
        </AsyncSection>
      </div>
      {open && <ExpenseDetail claim={open} onClose={() => setOpen(null)} footer={footer || null} />}
    </div>
  );
}

export default ExpenseQueue;

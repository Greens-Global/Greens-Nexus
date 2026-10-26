// Workday > Reimbursements (Oct 18 2026). Someone without a company card
// pays for something the company agreed to; this is how they get paid back
// instead of an email forwarded eight times. One tile beside Ask HR opens one
// panel (not a new tab): My Reimbursements, To Approve (for whoever was
// picked to approve one), HR (to approve, to pay, paid - HR as on time
// sheets). The People profile's Reimbursements tab is PersonReimbursements below.
// Server side: routers/reimbursements.py.
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppWindow, ArrowRight, Check, ChevronDown, FileText, Laptop, Package, Plane, Plus, Receipt, Settings2, Tag, Upload, Utensils, X } from 'lucide-react';
import { api } from '../api';
import { usePopupNudge } from '../lib/usePopupNudge';
import { Spinner } from './AsyncState';
import { formatDate, formatDateTime } from '../lib/datetime';
import { currencyOptions } from '../asset/lib/currency';
import { DateField, PersonSelect } from '../tasks/components';

export const OPEN_REIMBURSEMENTS = 'nexus:open-reimbursements';
const CATEGORIES = [
  ['travel', 'Travel'], ['meals', 'Meals'], ['supplies', 'Supplies'],
  ['software', 'Software'], ['equipment', 'Equipment'], ['other', 'Other'],
];
const CATEGORY_LABEL = Object.fromEntries(CATEGORIES);
// How the form asks for each kind of expense.
const CAT = {
  travel: { Icon: Plane, item: 'Trip', itemHint: 'e.g. "Flight to Austin for the site visit"', date: 'Travel Date',
    paidTo: 'Airline, Hotel or Vendor', paidToHint: 'e.g. Delta, Marriott, Uber', purpose: 'Business Purpose', purposeHint: 'Why the trip, and who approved it' },
  meals: { Icon: Utensils, item: 'Meal', itemHint: 'e.g. "Team lunch after the inspection"', date: 'Date',
    paidTo: 'Restaurant', paidToHint: 'Where you ate', purpose: 'Who Attended and Why', purposeHint: 'e.g. "Neil, Charmi and two vendors - project kickoff"' },
  supplies: { Icon: Package, item: 'Supplies', itemHint: 'e.g. "Printer paper and toner"', date: 'Purchase Date',
    paidTo: 'Store or Website', paidToHint: 'e.g. Staples, Amazon', purpose: 'Business Purpose', purposeHint: 'What they were needed for' },
  software: { Icon: AppWindow, item: 'Software or Subscription', itemHint: 'e.g. "Figma Professional, 1 year"', date: 'Purchase Date',
    paidTo: 'Vendor', paidToHint: 'e.g. Adobe, Microsoft', purpose: 'Business Purpose', purposeHint: 'What you use it for' },
  equipment: { Icon: Laptop, item: 'Item', itemHint: 'e.g. "27-inch monitor"', date: 'Purchase Date',
    paidTo: 'Store or Website', paidToHint: 'e.g. Best Buy, Amazon', purpose: 'Business Purpose', purposeHint: 'e.g. "Second screen for my home office - Neil agreed on 10/17"' },
  other: { Icon: Tag, item: 'What Was It?', itemHint: 'e.g. "Parking at the client office"', date: 'Date',
    paidTo: 'Paid To', paidToHint: 'Who you paid', purpose: 'Business Purpose', purposeHint: 'Why it was a company expense' },
};
const PAY_METHODS = [['payroll', 'With Payroll'], ['ach', 'ACH / Bank Transfer'], ['check', 'Check'], ['other', 'Other']];
const PAY_LABEL = Object.fromEntries(PAY_METHODS);
const STATUS_LOOK = {
  'Waiting for Approval': { bg: 'rgba(180,83,9,0.12)', fg: '#b45309' },
  'Waiting for Receipt': { bg: 'rgba(180,83,9,0.12)', fg: '#b45309' },
  'With HR': { bg: 'hsla(var(--color-blue),0.12)', fg: 'hsl(var(--color-blue))' },
  'Approved - To Pay': { bg: 'hsla(var(--color-blue),0.12)', fg: 'hsl(var(--color-blue))' },
  Paid: { bg: 'hsla(var(--color-green),0.12)', fg: 'hsl(var(--color-green))' },
  'Sent Back': { bg: 'rgba(180,83,9,0.12)', fg: '#b45309' },
  Rejected: { bg: 'rgba(185,28,28,0.1)', fg: 'hsl(var(--color-red))' },
  Canceled: { bg: 'var(--mist)', fg: 'var(--muted)' },
};
const HR_TABS = [['approver_approved', 'To Approve'], ['hr_approved', 'To Pay'], ['paid', 'Paid']];
const lbl = { fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', display: 'block', margin: '10px 0 4px' };
const full = { width: '100%' };
const small = { fontSize: 12, padding: '5px 10px' };

const money = (n, cur) => {
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur || 'USD' }).format(n || 0); }
  catch { return `${(n || 0).toFixed(2)} ${cur || ''}`; }
};
const categoryText = (r) => CATEGORY_LABEL[r.category] || r.category;
const todayIso = () => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`; };
const imagesFromPaste = (e) => {
  const out = [];
  for (const it of e.clipboardData?.items || []) {
    if (it.type?.startsWith('image/')) {
      const f = it.getAsFile();
      if (f) out.push(f.name ? f : new File([f], `receipt-${Date.now()}.png`, { type: f.type || 'image/png' }));
    }
  }
  return out;
};

async function uploadAll(files) {
  const out = [];
  for (const file of files) {
    const form = new FormData();
    form.append('file', file);
    out.push(await api.uploadReimbursementReceipt(form));   // { path, name }
  }
  return out;
}

async function openReceipt(id, i, onErr) {
  try { const r = await api.reimbursementReceiptUrl(id, i); if (r?.url) window.open(r.url, '_blank', 'noopener'); }
  catch (e) { onErr?.(e?.message || 'Could not open the receipt'); }
}

function StatusChip({ label }) {
  const m = STATUS_LOOK[label] || STATUS_LOOK.Canceled;
  return <span style={{ padding: '2px 10px', borderRadius: 14, fontSize: 11, fontWeight: 700, background: m.bg, color: m.fg, flexShrink: 0, whiteSpace: 'nowrap' }}>{label}</span>;
}

/** Receipts: Choose Files, or paste a screenshot / photo (Ctrl+V). */
function ReceiptPicker({ files, onFiles, compact = false }) {
  const ref = useRef(null);
  const add = (list) => onFiles([...files, ...list].slice(0, 10));
  return (
    <div onPaste={(e) => { const f = imagesFromPaste(e); if (f.length) { e.preventDefault(); add(f); } }} tabIndex={0}
      aria-label="Receipts - choose files or press Ctrl+V to paste a picture"
      style={{ border: '1px dashed var(--wk-line2, var(--line))', borderRadius: 10, padding: compact ? '8px 10px' : '12px 14px', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <input ref={ref} type="file" multiple accept="image/*,application/pdf" style={{ display: 'none' }}
        onChange={(e) => { add([...(e.target.files || [])]); e.target.value = ''; }} />
      <button type="button" className="secondary-btn" onClick={() => ref.current?.click()}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, ...small }}>
        <Upload size={13} /> {files.length ? 'Add More' : 'Choose Receipts'}
      </button>
      {files.map((f, i) => (
        <span key={`${f.name}-${i}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--ink)', background: 'var(--mist)', borderRadius: 8, padding: '4px 10px', maxWidth: 240 }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
          <X size={12} style={{ cursor: 'pointer', flexShrink: 0 }} aria-label={`Remove ${f.name}`} onClick={() => onFiles(files.filter((_, j) => j !== i))} />
        </span>
      ))}
      {!files.length && <span style={{ fontSize: 12, color: 'var(--muted)' }}>Photos or PDFs, or press Ctrl+V to paste a picture.</span>}
    </div>
  );
}

// The form follows the category (Oct 18 2026): "What Did You Buy?" made no
// sense for a trip or a meal. The category comes first; the one description
// field, who was paid and the purpose are worded for that kind of expense.
const blankForm = () => ({ item: '', category: '', amount: '', currency: 'USD', purchaseDate: '', vendor: '', details: '', approver: '' });
const formFrom = (r) => ({ item: r.item, category: r.category, amount: String(r.amount), currency: r.currency,
  purchaseDate: r.purchaseDate, vendor: r.vendor, details: r.details, approver: r.approverEmail });

/** New claim, or the fix of a sent-back one (`editing`). */
function ClaimForm({ people, editing = null, onDone, flash }) {
  const [f, setF] = useState(() => (editing ? formFrom(editing) : blankForm()));
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const kind = CAT[f.category];
  const amount = parseFloat(f.amount);
  const future = f.purchaseDate && f.purchaseDate > todayIso();
  const ok = kind && f.item.trim() && f.details.trim() && amount > 0 && !future;
  const send = async () => {
    if (!ok) return;
    setBusy(true);
    try {
      const receipts = files.length ? await uploadAll(files) : [];
      const body = {
        item: f.item.trim(), amount, currency: f.currency, category: f.category,
        // Other's own words are the description itself - no second "what kind" box.
        category_other: f.category === 'other' ? f.item.trim().slice(0, 100) : '',
        purchase_date: f.purchaseDate, vendor: f.vendor.trim(), details: f.details.trim(), approver_email: f.approver, receipts,
      };
      const row = editing ? await api.resubmitReimbursement(editing.id, body) : await api.createReimbursement(body);
      flash(`Sent to ${row.approverName || 'your approver'} for approval`);
      onDone(row);
    } catch (e) { flash(e?.message || 'Could not send it', false); }
    finally { setBusy(false); }
  };
  return (
    <div style={{ borderBottom: '1px solid var(--line)', paddingBottom: 16, marginBottom: 14 }}>
      {editing && <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)', marginBottom: 4 }}>Fix and Resubmit</div>}
      <span style={{ ...lbl, marginTop: 0 }} id="rb-cat">What Kind of Expense?</span>
      <div role="radiogroup" aria-labelledby="rb-cat" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {CATEGORIES.map(([k, l]) => {
          const Icon = CAT[k].Icon;
          const on = f.category === k;
          return (
            <button key={k} type="button" role="radio" aria-checked={on} onClick={() => setF((x) => ({ ...x, category: k }))}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: 999, cursor: 'pointer', fontSize: 12.5, fontWeight: 700,
                border: `1px solid ${on ? 'var(--wk-brand, #2b45e1)' : 'var(--line)'}`,
                background: on ? 'var(--wk-brand-tint, rgba(43,69,225,.08))' : 'var(--card)', color: on ? 'var(--wk-brand, #2b45e1)' : 'var(--ink)' }}>
              <Icon size={14} /> {l}
            </button>
          );
        })}
      </div>
      {!kind ? (
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 10 }}>Pick the kind of expense to fill in the details.</div>
      ) : (<>
        <label style={lbl} htmlFor="rb-item">{kind.item}</label>
        <input id="rb-item" className="form-input" style={full} value={f.item} onChange={set('item')} autoFocus placeholder={kind.itemHint} />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
          <div>
            <label style={lbl} htmlFor="rb-amount">Amount Paid</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <input id="rb-amount" className="form-input" type="number" min="0" step="0.01" inputMode="decimal" style={{ flex: 1, minWidth: 0 }} value={f.amount} onChange={set('amount')} placeholder="0.00" />
              <select className="form-input" aria-label="Currency" value={f.currency} onChange={set('currency')} style={{ width: 92 }}>
                {currencyOptions().map((c) => <option key={c.code} value={c.code} title={c.label}>{c.code}</option>)}
              </select>
            </div>
          </div>
          <div>
            <span style={lbl}>{kind.date}</span>
            <div className="form-input" style={{ ...full, display: 'flex', alignItems: 'center' }}>
              <DateField value={f.purchaseDate} onChange={(v) => setF((x) => ({ ...x, purchaseDate: v || '' }))} placeholder="MM/DD/YYYY"
                title={kind.date} style={{ width: '100%' }} />
            </div>
            {future && <div style={{ fontSize: 11.5, color: 'hsl(var(--color-red))', marginTop: 4 }}>That date has not happened yet.</div>}
          </div>
          <div>
            <label style={lbl} htmlFor="rb-vendor">{kind.paidTo}</label>
            <input id="rb-vendor" className="form-input" style={full} value={f.vendor} onChange={set('vendor')} placeholder={kind.paidToHint} />
          </div>
        </div>
        <label style={lbl} htmlFor="rb-details">{kind.purpose}</label>
        <textarea id="rb-details" className="form-input" rows={2} style={{ ...full, resize: 'vertical' }} value={f.details} onChange={set('details')}
          placeholder={kind.purposeHint} />
        <label style={lbl} htmlFor="rb-approver">Who Approves It</label>
        <PersonSelect id="rb-approver" value={f.approver || null} onChange={(v) => setF((x) => ({ ...x, approver: v || '' }))}
          people={people.map((p) => ({ email: p.email, name: p.name || p.email }))} placeholder="My Manager" noneLabel="My Manager"
          style={{ borderRadius: 10, padding: '9px 13px', fontSize: 13.5, fontWeight: 400 }} />
        <label style={lbl}>Receipts{editing && editing.receipts.length ? ` (${editing.receipts.length} already attached)` : ''}</label>
        <ReceiptPicker files={files} onFiles={setFiles} />
        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>No receipt yet? Send it now and add it later. HR approves it once the receipt is attached.</div>
      </>)}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
        <button type="button" className="secondary-btn" onClick={() => onDone(null)} disabled={busy}>Cancel</button>
        <button type="button" className="primary-btn" onClick={send} disabled={busy || !ok}>
          {busy ? <><Spinner size={13} /> Sending…</> : editing ? 'Resubmit' : 'Send for Approval'}
        </button>
      </div>
    </div>
  );
}

/** One claim, with whatever this viewer can do to it.
 *  as: 'mine' | 'approve' | 'hr' | 'view' */
function ClaimRow({ r, as, onChanged, onEdit, flash }) {
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState('');        // '' | 'send_back' | 'reject' | 'pay' | 'receipt'
  const [note, setNote] = useState('');
  const [files, setFiles] = useState([]);
  const [pay, setPay] = useState({ paidOn: todayIso(), method: 'payroll', ref: '' });
  const [showHistory, setShowHistory] = useState(false);
  const reset = () => { setMode(''); setNote(''); setFiles([]); };
  const run = async (fn, okMsg) => {
    setBusy(true);
    try { const u = await fn(); onChanged(u); reset(); if (okMsg) flash(okMsg); }
    catch (e) { flash(e?.message || 'Could not save', false); }
    finally { setBusy(false); }
  };
  const decide = (action) => run(() => api.decideReimbursement(r.id, { action, note }),
    action === 'approve' ? 'Approved' : action === 'reject' ? 'Rejected' : 'Sent back');
  const canDecide = (as === 'approve' && r.status === 'submitted') || (as === 'hr' && r.status === 'approver_approved');
  const mineOpen = as === 'mine' && ['submitted', 'approver_approved', 'sent_back'].includes(r.status);
  const who = as === 'mine' ? (r.approverName ? `Approver: ${r.approverName}` : '') : r.name;
  return (
    <div style={{ padding: '10px 0', borderBottom: '1px solid var(--line)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)' }}>{r.item}</span>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)' }}>{money(r.amount, r.currency)}</span>
        <span style={{ flex: 1 }} />
        <StatusChip label={r.statusLabel} />
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {who && <span>{who}</span>}
        <span>{categoryText(r)}</span>
        {r.purchaseDate && <span>Bought {formatDate(r.purchaseDate + 'T12:00:00')}</span>}
        {r.vendor && <span>{r.vendor}</span>}
        <span>Filed {formatDate(r.createdAt)}</span>
        {r.paidOn && <span>Paid {formatDate(r.paidOn + 'T12:00:00')}{r.paymentMethod ? ` · ${PAY_LABEL[r.paymentMethod] || r.paymentMethod}` : ''}{r.paymentRef ? ` · ${r.paymentRef}` : ''}</span>}
      </div>
      {r.details && <div style={{ fontSize: 12.5, color: 'var(--ink)', marginTop: 4 }}>{r.details}</div>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        {r.receipts.map((x, i) => (
          <button key={i} type="button" className="secondary-btn" onClick={() => openReceipt(r.id, i, (m) => flash(m, false))}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, ...small }}>
            <FileText size={12} /> {r.receipts.length > 1 ? x.name || `Receipt ${i + 1}` : 'View Receipt'}
          </button>
        ))}
        {mineOpen && r.status !== 'sent_back' && mode !== 'receipt' && (
          <button type="button" className="secondary-btn" onClick={() => setMode('receipt')} style={small}>Add Receipt</button>
        )}
        {as === 'mine' && r.status === 'sent_back' && (
          <button type="button" className="primary-btn" onClick={() => onEdit(r)} style={small}>Fix and Resubmit</button>
        )}
        {as === 'mine' && ['submitted', 'sent_back'].includes(r.status) && (
          <button type="button" className="secondary-btn" disabled={busy} onClick={() => run(() => api.cancelReimbursement(r.id), 'Canceled')} style={small}>Cancel Request</button>
        )}
        {canDecide && mode === '' && (<>
          <button type="button" className="primary-btn" disabled={busy || (as === 'hr' && !r.receipts.length)} onClick={() => decide('approve')}
            title={as === 'hr' && !r.receipts.length ? 'Waiting for the receipt' : undefined}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, ...small }}><Check size={12} /> Approve</button>
          <button type="button" className="secondary-btn" disabled={busy} onClick={() => setMode('send_back')} style={small}>Send Back</button>
          <button type="button" className="secondary-btn" disabled={busy} onClick={() => setMode('reject')} style={small}>Reject</button>
        </>)}
        {as === 'hr' && r.status === 'hr_approved' && mode === '' && (
          <button type="button" className="primary-btn" disabled={busy} onClick={() => setMode('pay')} style={small}>Mark Paid</button>
        )}
        {(r.history || []).length > 0 && (
          <button type="button" onClick={() => setShowHistory((s) => !s)} aria-expanded={showHistory}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: 12, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
            History <ChevronDown size={12} style={{ transform: showHistory ? 'rotate(180deg)' : undefined }} />
          </button>
        )}
      </div>
      {showHistory && (
        <ol style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12, color: 'var(--muted)', display: 'grid', gap: 3 }}>
          {r.history.map((h, i) => (
            <li key={i}><strong style={{ color: 'var(--ink)' }}>{h.label}</strong> · {h.byName} · {formatDateTime(h.at)}{h.note ? ` - “${h.note}”` : ''}</li>
          ))}
        </ol>
      )}
      {mode === 'receipt' && (
        <div style={{ marginTop: 8, display: 'grid', gap: 8 }}>
          <ReceiptPicker files={files} onFiles={setFiles} compact />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="secondary-btn" onClick={reset} disabled={busy}>Cancel</button>
            <button type="button" className="primary-btn" disabled={busy || !files.length}
              onClick={() => run(async () => api.addReimbursementReceipts(r.id, { receipts: await uploadAll(files) }), 'Receipt added')}>
              {busy ? <><Spinner size={13} /> Saving…</> : 'Save Receipts'}
            </button>
          </div>
        </div>
      )}
      {(mode === 'send_back' || mode === 'reject') && (
        <div style={{ marginTop: 8, display: 'grid', gap: 8 }}>
          <textarea className="form-input" rows={2} value={note} onChange={(e) => setNote(e.target.value)} autoFocus style={{ ...full, resize: 'vertical' }}
            aria-label={mode === 'reject' ? 'Why it is rejected' : 'What to fix'}
            placeholder={mode === 'reject' ? 'Why it is rejected (the employee sees this)' : 'What to fix (the employee sees this)'} />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="secondary-btn" onClick={reset} disabled={busy}>Cancel</button>
            <button type="button" className="primary-btn" disabled={busy || !note.trim()} onClick={() => decide(mode)}>
              {mode === 'reject' ? 'Reject' : 'Send Back'}
            </button>
          </div>
        </div>
      )}
      {mode === 'pay' && (
        <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8, alignItems: 'end' }}>
          <label style={{ display: 'grid', gap: 4, fontSize: 11.5, fontWeight: 700, color: 'var(--muted)' }}>Paid On
            <input className="form-input" type="date" value={pay.paidOn} onChange={(e) => setPay((p) => ({ ...p, paidOn: e.target.value }))} />
          </label>
          <label style={{ display: 'grid', gap: 4, fontSize: 11.5, fontWeight: 700, color: 'var(--muted)' }}>Method
            <select className="form-input" value={pay.method} onChange={(e) => setPay((p) => ({ ...p, method: e.target.value }))}>
              {PAY_METHODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
          <label style={{ display: 'grid', gap: 4, fontSize: 11.5, fontWeight: 700, color: 'var(--muted)' }}>Reference
            <input className="form-input" value={pay.ref} onChange={(e) => setPay((p) => ({ ...p, ref: e.target.value }))} placeholder="Check or transfer number" />
          </label>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="secondary-btn" onClick={reset} disabled={busy}>Cancel</button>
            <button type="button" className="primary-btn" disabled={busy || !pay.paidOn}
              onClick={() => run(() => api.payReimbursement(r.id, { paid_on: pay.paidOn, payment_method: pay.method, payment_ref: pay.ref }), 'Marked paid')}>
              Mark Paid
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function usePeople(on) {
  const [people, setPeople] = useState([]);
  useEffect(() => {
    if (!on) return undefined;
    let alive = true;
    api.getPeopleDirectory()
      .then((rows) => { if (alive) setPeople((rows || []).map((u) => ({ email: (u.email || '').toLowerCase(), name: u.name || u.display_name || '' })).filter((p) => p.email).sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email, 'en-US'))); })
      .catch(() => { if (alive) setPeople([]); });
    return () => { alive = false; };
  }, [on]);
  return people;
}

const EMPTY = { mine: [], toApprove: [], hr: [], canHr: false };
const counts = (d) => ({
  approve: (d?.toApprove || []).filter((r) => r.status === 'submitted').length,
  hrApprove: (d?.hr || []).filter((r) => r.status === 'approver_approved').length,
  hrPay: (d?.hr || []).filter((r) => r.status === 'hr_approved').length,
  mine: (d?.mine || []).filter((r) => ['submitted', 'approver_approved', 'hr_approved', 'sent_back'].includes(r.status)).length,
  sentBack: (d?.mine || []).filter((r) => r.status === 'sent_back').length,
});

/** The Workday tile plus its panel. `autoOpen` opens it (a bell's link). */
export default function ReimbursementsTile({ autoOpen = false, flash = () => {} }) {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(!!autoOpen);
  // A click outside nudges instead of closing (lib/usePopupNudge.js).
  const { nudge, reset: resetNudge, popupClass, closeClass } = usePopupNudge();
  useEffect(() => { if (!open) resetNudge(); }, [open, resetNudge]);
  const [tab, setTab] = useState('mine');
  const [hrTab, setHrTab] = useState('approver_approved');
  const [form, setForm] = useState(null);       // null | 'new' | the sent-back claim being fixed
  const people = usePeople(open && !!form);
  // Opening lands on what needs this person first.
  const landRef = useRef(!!autoOpen);
  const load = useCallback(() => api.getReimbursements()
    .then((d) => {
      setData(d);
      if (landRef.current) {
        landRef.current = false;
        const c = counts(d);
        if (c.approve) setTab('approve');
        else if (c.hrApprove || c.hrPay) { setTab('hr'); setHrTab(c.hrApprove ? 'approver_approved' : 'hr_approved'); }
        else setTab('mine');
      }
    })
    .catch(() => setData(EMPTY)), []);
  const openPanel = useCallback(() => { landRef.current = true; setOpen(true); load(); }, [load]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    window.addEventListener(OPEN_REIMBURSEMENTS, openPanel);
    return () => window.removeEventListener(OPEN_REIMBURSEMENTS, openPanel);
  }, [openPanel]);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const c = counts(data);
  const waiting = c.approve + c.hrApprove + c.hrPay + c.sentBack;
  const sub = c.approve ? `${c.approve} to approve` : c.hrApprove ? `${c.hrApprove} for HR` : c.hrPay ? `${c.hrPay} to pay`
    : c.sentBack ? `${c.sentBack} sent back` : c.mine ? `${c.mine} in progress` : 'Expenses you paid for';
  const replace = (u) => setData((d) => {
    if (!d || !u) return d;
    const swap = (list) => (list || []).map((x) => (x.id === u.id ? u : x));
    return { ...d, mine: swap(d.mine), toApprove: swap(d.toApprove), hr: swap(d.hr) };
  });
  // HR's queue is not a tab beside the person's own claims: it opens from
  // Manage in the header (Neil, Oct 26), and the tabs below lead back out.
  const tabs = [['mine', 'My Reimbursements', c.mine],
    ...((data?.toApprove || []).length ? [['approve', 'To Approve', c.approve]] : [])];
  const managing = tab === 'hr';
  const hrWaiting = c.hrApprove + c.hrPay;
  const list = tab === 'approve' ? (data?.toApprove || []) : tab === 'hr' ? (data?.hr || []).filter((r) => r.status === hrTab) : (data?.mine || []);

  return (<>
    <button type="button" className="dk-stat wd-stat wd-askhr wd-reimb" onClick={openPanel}
      aria-label={waiting ? `Reimbursements, ${sub}` : 'Reimbursements'}>
      <span className="wd-askhr-badge" aria-hidden="true">
        <Receipt size={18} />
        {waiting > 0 && <span className="wd-askhr-dot" />}
      </span>
      <span className="wd-stat-text">
        <span className="wd-askhr-title">Reimbursements</span>
        <span className={`wd-askhr-sub${waiting ? ' wd-askhr-sub--new' : ''}`}>{sub}</span>
      </span>
      <span className="wd-askhr-cta" aria-hidden="true">{waiting ? 'Review' : 'Open'} <ArrowRight size={13} /></span>
      <ArrowRight className="wd-askhr-go" size={15} aria-hidden="true" />
    </button>
    {open && (
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
        onClick={nudge}>
        <div role="dialog" aria-label="Reimbursements" className={popupClass} onClick={(e) => e.stopPropagation()}
          style={{ background: 'var(--card)', borderRadius: 14, width: '85vw', minWidth: 'min(420px, 100%)', maxWidth: '100%', height: '85vh', maxHeight: '100%', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
          <div style={{ padding: '16px 18px 12px', display: 'flex', alignItems: 'center', gap: 10, borderBottom: '1px solid var(--line)' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--ink)' }}>Reimbursements</div>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>Paid for something yourself? Send it for approval, then HR pays you back.</div>
            </div>
            <button type="button" className={closeClass} onClick={() => setOpen(false)} aria-label="Close"
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex' }}><X size={16} /></button>
          </div>
          <div style={{ overflowY: 'auto', flex: 1, minHeight: 0, padding: '14px 18px 18px', display: 'flex', flexDirection: 'column' }}>
            {form && (
              <ClaimForm key={form === 'new' ? 'new' : form.id} people={people} editing={form === 'new' ? null : form} flash={flash}
                onDone={(row) => {
                  setForm(null);
                  if (!row) return;
                  setData((d) => ({ ...(d || EMPTY), mine: [row, ...((d?.mine || []).filter((x) => x.id !== row.id))] }));
                }} />
            )}
            {/* One toolbar under the header (Sagar, Oct 27): the tabs on the left, Manage
                and + New on the right - they used to crowd the title row. */}
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ minWidth: 0 }}>
                {managing && (
                  <div style={{ fontWeight: 700, fontSize: 13.5, color: 'var(--ink)', marginBottom: 2 }}>Manage - HR</div>
                )}
                {/* The segmented control Purchase Requests uses (Workday's .wd-seg -
                    Sagar, Oct 27), for the person's tabs and Manage's alike. */}
                {tabs.length > 1 && !managing && (
                  <div style={{ marginBottom: 10 }}>
                    <div className="wd-seg" role="tablist" aria-label="Reimbursements">
                      {tabs.map(([k, label, n]) => (
                        <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
                          {label}{n ? ` (${n})` : ''}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {tab === 'hr' && (
                  <div style={{ margin: '6px 0 10px' }}>
                    <div className="wd-seg" role="tablist" aria-label="HR">
                      {HR_TABS.map(([k, label]) => {
                        const n = (data?.hr || []).filter((r) => r.status === k).length;
                        return (
                          <button key={k} type="button" role="tab" aria-selected={hrTab === k} className={hrTab === k ? 'on' : ''} onClick={() => setHrTab(k)}>
                            {label}{n ? ` (${n})` : ''}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', gap: 8, flexShrink: 0, marginLeft: 'auto', marginBottom: 10 }}>
                {!form && data?.canHr && (
                  <button type="button" className="secondary-btn" aria-pressed={managing}
                    onClick={() => setTab(managing ? 'mine' : 'hr')}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '6px 12px',
                      ...(managing ? { background: 'var(--ink)', color: 'var(--card)', borderColor: 'var(--ink)' } : {}) }}>
                    <Settings2 size={13} /> Manage{hrWaiting ? ` (${hrWaiting})` : ''}
                  </button>
                )}
                {!form && (
                  <button type="button" className="primary-btn" aria-label="New Reimbursement" onClick={() => { setForm('new'); setTab('mine'); }}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '6px 12px' }}>
                    <Plus size={13} /> New
                  </button>
                )}
              </div>
            </div>
            <div className="nx-fill">
            {!data ? <div style={{ padding: 20, textAlign: 'center' }}><Spinner size={16} /></div>
              : list.length === 0 ? (
                <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '14px 0' }}>
                  {tab === 'approve' ? 'Nothing waiting on you.' : tab === 'hr' ? 'Nothing here.' : 'Nothing filed yet. Use New to send one.'}
                </div>
              ) : list.map((r) => (
                <ClaimRow key={r.id} r={r} as={tab === 'approve' ? 'approve' : tab === 'hr' ? 'hr' : 'mine'} onChanged={replace} flash={flash}
                  onEdit={(row) => setForm(row)} />
              ))}
            </div>
          </div>
        </div>
      </div>
    )}
  </>);
}

/** People > person > Reimbursements: every claim one person filed. */
export function PersonReimbursements({ email, toastErr }) {
  const [rows, setRows] = useState(null);
  const errRef = useRef(toastErr);
  useEffect(() => { errRef.current = toastErr; }, [toastErr]);
  useEffect(() => {
    let alive = true;
    api.personReimbursements(email).then((r) => { if (alive) setRows(r || []); })
      .catch((e) => { if (alive) { setRows([]); errRef.current?.(e?.message || 'Could not load reimbursements'); } });
    return () => { alive = false; };
  }, [email]);
  if (!rows) return <div style={{ padding: 20, textAlign: 'center' }}><Spinner size={16} /></div>;
  if (!rows.length) return <div style={{ fontSize: 13, color: 'var(--muted)', padding: '16px 0' }}>No reimbursements filed.</div>;
  const flash = (m, ok = true) => { if (!ok) errRef.current?.(m); };
  return <div>{rows.map((r) => <ClaimRow key={r.id} r={r} as="view" onChanged={() => {}} onEdit={() => {}} flash={flash} />)}</div>;
}

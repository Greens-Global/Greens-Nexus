// Salary advances on the Time Sheet (Neil, Oct 29 2026: "Workday is not the
// right place for this"). Nobody asks for their own advance. On someone
// else's Time Sheet their DIRECT manager asks HR for one (Send To HR), HR
// with the pay grant grants it, HR without it sends a request - the server's
// `canAsk` (salary_advance.can_request_for) says which. Below the card the
// person's advances the viewer may see (salary_advance.view_of), with HR's
// actions: Approve / Decline, Mark Paid Out, Move an installment, Change
// Schedule, Cancel. The employee's own Time Sheet shows "Your Salary
// Advances", read-only. Each repayment is a "Salary Advance Repayment" line
// on the card. Server side: routers/salary_advances.py + salary_advance.py.
import { useCallback, useEffect, useState } from 'react';
import { Banknote, ChevronDown, Plus, Trash2 } from 'lucide-react';
import { api } from '../api';
import { Spinner } from './AsyncState';
import { StatusLabel } from './StatusLabel';
import { formatDate, formatDateTime } from '../lib/datetime';
import { DateField, Modal } from '../tasks/components';

const STATUS_COLOR = {
  requested: '#b45309', approved: '#2563eb', declined: '#b91c1c', paid_out: '#2563eb',
  repaying: '#7c3aed', repaid: '#16a34a', canceled: '#64748b',
};
const ROW_STATUS = { scheduled: ['Scheduled', '#64748b'], deducted: ['Repaid', '#16a34a'] };
const PAY_METHODS = [['ach', 'ACH / Bank Transfer'], ['payroll', 'With Payroll'], ['check', 'Check'], ['other', 'Other']];
const lbl = { fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', display: 'block', margin: '10px 0 4px' };
const small = { fontSize: 12, padding: '5px 10px' };
const pill = { display: 'inline-flex', alignItems: 'center', gap: 5, background: 'none', border: '1px solid var(--wk-line2)', borderRadius: 999, padding: '5px 12px', fontFamily: 'var(--wk-font)', fontSize: 12, fontWeight: 700, color: 'var(--ink)', cursor: 'pointer' };
const todayIso = () => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`; };
const day = (iso) => (iso ? formatDate(`${iso.slice(0, 10)}T12:00:00`) : '');

const money = (n, cur) => {
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur || 'USD' }).format(n || 0); }
  catch { return `${(n || 0).toFixed(2)} ${cur || ''}`; }
};

/** The person's advances and what the viewer may ask for:
 *  GET /salary-advances/person/{email}. null until it answers (or when the
 *  viewer may not open it - then the panel and the button stay hidden). */
export function useTimeSheetAdvances(email) {
  // Kept with the email it answers for: another person's sheet shows nothing
  // of the last one while its own answer is on the way.
  const [got, setGot] = useState({ email: '', data: null });
  useEffect(() => {
    if (!email) return undefined;
    let alive = true;
    api.personSalaryAdvances(email)
      .then((d) => { if (alive) setGot({ email, data: d || null }); })
      .catch(() => { if (alive) setGot({ email, data: null }); });
    return () => { alive = false; };
  }, [email]);
  const edit = useCallback((fn) => setGot((g) => (g.data ? { ...g, data: { ...g.data, advances: fn(g.data.advances || []) } } : g)), []);
  const add = useCallback((row) => { if (row) edit((list) => [row, ...list]); }, [edit]);
  const replace = useCallback((row) => {
    if (row) edit((list) => list.map((x) => (x.id === row.id ? { ...row, skippedFinalized: undefined } : x)));
  }, [edit]);
  return { data: email && got.email === email ? got.data : null, add, replace };
}

/** Ask HR for an advance for this person (their manager, HR without the
 *  pay grant), or grant one (HR with it). POST /salary-advances/for/{email}. */
function AdvanceForm({ grant, email, name, payCurrency = 'USD', maxInstallments = 24, onClose, onDone, toastOk, toastErr }) {
  const [f, setF] = useState({ amount: '', reason: '', installments: '1' });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const amount = parseFloat(f.amount);
  const n = parseInt(f.installments, 10);
  const ok = amount > 0 && f.reason.trim().length >= 3 && n >= 1 && n <= maxInstallments;
  const send = async () => {
    if (!ok) return;
    setBusy(true);
    try {
      const row = await api.askSalaryAdvanceFor(email, { amount, reason: f.reason.trim(), installments: n, currency: payCurrency });
      // HR without the pay grant never sees the amount again - it typed it, so say it once here.
      toastOk?.(grant ? `Advance of ${money(amount, payCurrency)} granted to ${name}` : `Sent to HR - ${money(amount, payCurrency)} for ${name}`);
      onDone(row);
    } catch (e) { toastErr?.(e?.message || 'Could not send it'); }
    finally { setBusy(false); }
  };
  const per = amount > 0 && n > 0 ? amount / n : 0;
  return (
    <Modal title={grant ? `Grant A Salary Advance - ${name}` : `Ask For A Salary Advance - ${name}`} onClose={onClose}
      isDirty={!!(f.amount || f.reason)}
      footer={<>
        <button type="button" className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="primary-btn" onClick={send} disabled={busy || !ok}>
          {busy ? <><Spinner size={13} /> Sending…</> : grant ? 'Grant Advance' : 'Send To HR'}
        </button>
      </>}>
      <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 4 }}>
        {grant ? 'Approved at once. Mark it Paid Out once it is paid - repayment starts the pay period after.'
          : `HR approves it and pays it out. It is repaid from ${name}'s pay, starting the pay period after it is paid out.`}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
        <div>
          <label style={lbl} htmlFor="sa-amount">Amount ({payCurrency})</label>
          <input id="sa-amount" className="form-input" type="number" min="0" step="0.01" inputMode="decimal" style={{ width: '100%' }}
            value={f.amount} onChange={set('amount')} placeholder="0.00" autoFocus />
        </div>
        <div>
          <label style={lbl} htmlFor="sa-n">Repay Over (Pay Periods)</label>
          <input id="sa-n" className="form-input" type="number" min="1" max={maxInstallments} step="1" style={{ width: '100%' }}
            value={f.installments} onChange={set('installments')} />
          {per > 0 && n > 1 && <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}>About {money(per, payCurrency)} a pay period.</div>}
        </div>
      </div>
      <label style={lbl} htmlFor="sa-reason">What It Is For</label>
      <div className="nx-fill" style={{ display: 'flex', flexDirection: 'column' }}>
        <textarea id="sa-reason" className="form-input" style={{ width: '100%', flex: 1, minHeight: 90, resize: 'vertical' }}
          value={f.reason} onChange={set('reason')} placeholder={grant ? 'Why HR is granting it' : 'e.g. "Car repair before the move" - HR sees this'} />
      </div>
    </Modal>
  );
}

/** The toolbar button: "Grant A Salary Advance" (HR with the pay grant) or
 *  "Ask For A Salary Advance" (the direct manager, HR without it). Nothing
 *  when the viewer may not ask - never on your own Time Sheet. */
export function AskAdvanceButton({ adv, toastOk, toastErr }) {
  const [open, setOpen] = useState(false);
  const d = adv?.data;
  if (!d?.canAsk) return null;
  const grant = d.canAsk === 'grant';
  return (
    <>
      <button type="button" data-ask-advance onClick={() => setOpen(true)} style={pill}
        title={grant ? 'Give this person a salary advance - approved at once, repaid from later pay periods' : 'Ask HR for a salary advance for this person - repaid from later pay periods'}>
        <Banknote size={13} /> {grant ? 'Grant A Salary Advance' : 'Ask For A Salary Advance'}
      </button>
      {open && (
        <AdvanceForm grant={grant} email={d.email} name={d.name || d.email} payCurrency={d.payCurrency} maxInstallments={d.maxInstallments}
          onClose={() => setOpen(false)} toastOk={toastOk} toastErr={toastErr}
          onDone={(row) => { setOpen(false); adv.add(row); }} />
      )}
    </>
  );
}

/** HR: replace what is left to repay. */
function ScheduleEditor({ adv, onClose, onSaved, toastOk, toastErr }) {
  const left = adv.schedule.filter((s) => s.status === 'scheduled');
  const [rows, setRows] = useState(() => (left.length ? left : [{ date: '', amount: adv.balance }]).map((s) => ({ date: s.date, amount: String(s.amount) })));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const total = rows.reduce((t, r) => t + (parseFloat(r.amount) || 0), 0);
  const adds = Math.abs(total - adv.balance) < 0.005;
  const ok = adds && reason.trim().length >= 3 && rows.every((r) => r.date && parseFloat(r.amount) > 0);
  const save = async () => {
    setBusy(true);
    try {
      const out = await api.setSalaryAdvanceSchedule(adv.id, { reason: reason.trim(), installments: rows.map((r) => ({ date: r.date, amount: parseFloat(r.amount) })) });
      toastOk?.(out.skippedFinalized ? 'Schedule saved - a finalized pay period was skipped' : 'Schedule saved');
      onSaved(out);
    } catch (e) { toastErr?.(e?.message || 'Could not save'); }
    finally { setBusy(false); }
  };
  return (
    <Modal title={`Change Repayment - ${adv.name}`} onClose={onClose} isDirty={!!reason}
      footer={<>
        <button type="button" className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="primary-btn" onClick={save} disabled={busy || !ok}>Save Schedule</button>
      </>}>
      <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
        {money(adv.balance, adv.currency)} is still owed. Pick the pay periods it comes out of - any day of the period works,
        and a finalized period moves to the next open one.
      </div>
      <div className="nx-fill" style={{ marginTop: 10 }}>
        {rows.map((r, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 140px 32px', gap: 8, alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
            <div className="form-input" style={{ display: 'flex', alignItems: 'center' }}>
              <DateField value={r.date} onChange={(v) => setRows((x) => x.map((y, j) => (j === i ? { ...y, date: v || '' } : y)))} placeholder="MM/DD/YYYY" title="Pay period" style={{ width: '100%' }} />
            </div>
            <input className="form-input" type="number" min="0" step="0.01" aria-label={`Installment ${i + 1} amount`} value={r.amount}
              onChange={(e) => setRows((x) => x.map((y, j) => (j === i ? { ...y, amount: e.target.value } : y)))} />
            <button type="button" aria-label={`Remove installment ${i + 1}`} disabled={rows.length === 1}
              onClick={() => setRows((x) => x.filter((_, j) => j !== i))}
              style={{ background: 'none', border: 'none', cursor: rows.length === 1 ? 'default' : 'pointer', color: 'var(--muted)', display: 'flex' }}><Trash2 size={14} /></button>
          </div>
        ))}
        <button type="button" className="secondary-btn" style={{ ...small, marginTop: 8, display: 'inline-flex', alignItems: 'center', gap: 5 }}
          onClick={() => setRows((x) => [...x, { date: '', amount: '' }])}><Plus size={12} /> Add Installment</button>
        <div style={{ fontSize: 12, marginTop: 8, color: adds ? 'var(--muted)' : 'hsl(var(--color-red))' }}>
          Adds up to {money(total, adv.currency)} of {money(adv.balance, adv.currency)}.
        </div>
        <label style={lbl} htmlFor="sa-sched-why">Reason</label>
        <textarea id="sa-sched-why" className="form-input" rows={2} style={{ width: '100%', resize: 'vertical' }} value={reason}
          onChange={(e) => setReason(e.target.value)} placeholder="Why the schedule changes (logged, and the person is told)" />
      </div>
    </Modal>
  );
}

/** One advance and whatever this viewer can do to it. `mine`: the
 *  employee's own sheet (read-only). `asker`: the viewer asked for it
 *  (may cancel while it waits). HR's actions follow `a.canDecide`. */
function AdvanceRow({ a, mine, asker, onChanged, toastOk, toastErr }) {
  const [mode, setMode] = useState('');          // '' | decline | cancel | pay | move:<id> | schedule
  const [note, setNote] = useState('');
  const [pay, setPay] = useState({ paidOn: todayIso(), method: 'ach', ref: '' });
  const [moveTo, setMoveTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const act = !mine && !!a.canDecide;
  const shown = a.amount !== undefined;
  const reset = () => { setMode(''); setNote(''); setMoveTo(''); };
  const run = async (fn, okMsg) => {
    setBusy(true);
    try { const u = await fn(); onChanged(u); reset(); if (okMsg) toastOk?.(typeof okMsg === 'function' ? okMsg(u) : okMsg); }
    catch (e) { toastErr?.(e?.message || 'Could not save'); }
    finally { setBusy(false); }
  };
  const moving = mode.startsWith('move:') ? mode.slice(5) : '';
  const owed = ['paid_out', 'repaying'].includes(a.status);
  const balance = a.balance !== undefined && (owed || a.status === 'repaid');
  return (
    <div data-advance={a.id} style={{ padding: '10px 12px', borderTop: '1px solid var(--wk-line2)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)' }}>{shown ? money(a.amount, a.currency) : 'Salary Advance'}</span>
        <span style={{ flex: 1 }} />
        <StatusLabel label={a.statusLabel} color={STATUS_COLOR[a.status]} size="sm" />
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <span>{a.source === 'grant' ? `Granted by ${a.requestedByName}` : `Requested ${day(a.requestedAt)}${a.requestedByName ? ` by ${a.requestedByName}` : ''}`}</span>
        <span>{a.installments} pay period{a.installments === 1 ? '' : 's'}</span>
        {a.paidOn && <span>Paid out {day(a.paidOn)}</span>}
        {balance && <span>Repaid {money(a.repaid, a.currency)} · Balance {money(a.balance, a.currency)}</span>}
      </div>
      {a.reason && <div style={{ fontSize: 12.5, color: 'var(--ink)', marginTop: 4 }}>{a.reason}</div>}
      {a.decisionNote && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>HR: {a.decisionNote}</div>}
      {a.schedule.length > 0 && (
        <div style={{ marginTop: 8, border: '1px solid var(--wk-line2)', borderRadius: 10, overflow: 'hidden' }}>
          {a.schedule.map((s, i) => {
            const [word, color] = ROW_STATUS[s.status] || [s.status, '#64748b'];
            return (
              <div key={s.id} style={{ borderTop: i ? '1px solid var(--wk-line2)' : 'none', padding: '7px 10px', fontSize: 12.5 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <span style={{ color: 'var(--ink)', minWidth: 0, flex: 1 }}>Pay period {day(s.periodStart)} - {day(s.periodEnd)}{s.carriedFrom ? ' (carried forward)' : ''}</span>
                  {s.amount !== undefined && <span style={{ fontWeight: 700, color: 'var(--ink)' }}>{money(s.status === 'deducted' ? s.deductedAmount : s.amount, s.currency)}</span>}
                  <StatusLabel label={word} color={color} size="sm" />
                  {act && s.status === 'scheduled' && owed && !moving && (
                    <button type="button" className="secondary-btn" style={small} disabled={busy} onClick={() => { setMode(`move:${s.id}`); setMoveTo(''); }}>Move Later</button>
                  )}
                </div>
                {moving === s.id && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 8, marginTop: 8, alignItems: 'end' }}>
                    <div>
                      <span style={lbl}>Any Day of the New Pay Period</span>
                      <div className="form-input" style={{ display: 'flex', alignItems: 'center' }}>
                        <DateField value={moveTo} onChange={(v) => setMoveTo(v || '')} placeholder="MM/DD/YYYY" title="New pay period" style={{ width: '100%' }} />
                      </div>
                    </div>
                    <div>
                      <label style={lbl} htmlFor={`sa-move-${s.id}`}>Reason</label>
                      <input id={`sa-move-${s.id}`} className="form-input" style={{ width: '100%' }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Logged, and the person is told" />
                    </div>
                    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                      <button type="button" className="secondary-btn" onClick={reset} disabled={busy}>Cancel</button>
                      <button type="button" className="primary-btn" disabled={busy || !moveTo || note.trim().length < 3}
                        onClick={() => run(() => api.moveSalaryAdvanceInstallment(a.id, s.id, { date: moveTo, reason: note.trim() }),
                          (u) => (u.skippedFinalized ? 'Moved - past a finalized pay period' : 'Installment moved'))}>Move</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        {act && a.status === 'requested' && mode === '' && (<>
          <button type="button" className="primary-btn" style={small} disabled={busy} onClick={() => run(() => api.decideSalaryAdvance(a.id, { action: 'approve' }), 'Approved')}>Approve</button>
          <button type="button" className="secondary-btn" style={small} disabled={busy} onClick={() => setMode('decline')}>Decline</button>
        </>)}
        {act && a.status === 'approved' && mode === '' && (
          <button type="button" className="primary-btn" style={small} disabled={busy} onClick={() => setMode('pay')}>Mark Paid Out</button>
        )}
        {act && owed && mode === '' && (
          <button type="button" className="secondary-btn" style={small} disabled={busy} onClick={() => setMode('schedule')}>Change Schedule</button>
        )}
        {mode === '' && !mine && ((asker && a.status === 'requested') || (act && ['requested', 'approved'].includes(a.status))) && (
          <button type="button" className="secondary-btn" style={small} disabled={busy}
            onClick={() => (act ? setMode('cancel') : run(() => api.cancelSalaryAdvance(a.id, {}), 'Canceled'))}>Cancel Request</button>
        )}
        {(a.history || []).length > 0 && (
          <button type="button" onClick={() => setShowHistory((x) => !x)} aria-expanded={showHistory}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: 12, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
            History <ChevronDown size={12} style={{ transform: showHistory ? 'rotate(180deg)' : undefined }} />
          </button>
        )}
      </div>
      {showHistory && (
        <ol style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12, color: 'var(--muted)', display: 'grid', gap: 3 }}>
          {a.history.map((h, i) => (
            <li key={i}><strong style={{ color: 'var(--ink)' }}>{h.label}</strong> · {h.byName || 'Nexus'} · {formatDateTime(h.at)}{h.note ? ` - "${h.note}"` : ''}</li>
          ))}
        </ol>
      )}
      {(mode === 'decline' || mode === 'cancel') && (
        <div style={{ marginTop: 8, display: 'grid', gap: 8 }}>
          <textarea className="form-input" rows={2} value={note} onChange={(e) => setNote(e.target.value)} autoFocus style={{ width: '100%', resize: 'vertical' }}
            aria-label="Why" placeholder="Why (the person sees this)" />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="secondary-btn" onClick={reset} disabled={busy}>Back</button>
            <button type="button" className="primary-btn" disabled={busy || !note.trim()}
              onClick={() => run(() => (mode === 'decline' ? api.decideSalaryAdvance(a.id, { action: 'decline', note: note.trim() })
                : api.cancelSalaryAdvance(a.id, { note: note.trim() })), mode === 'decline' ? 'Declined' : 'Canceled')}>
              {mode === 'decline' ? 'Decline' : 'Cancel Advance'}
            </button>
          </div>
        </div>
      )}
      {mode === 'pay' && (
        <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8, alignItems: 'end' }}>
          <div>
            <span style={lbl}>Paid Out On</span>
            <div className="form-input" style={{ display: 'flex', alignItems: 'center' }}>
              <DateField value={pay.paidOn} onChange={(v) => setPay((p) => ({ ...p, paidOn: v || '' }))} max={todayIso()} placeholder="MM/DD/YYYY" title="Paid out on" style={{ width: '100%' }} />
            </div>
          </div>
          <label style={{ display: 'grid', gap: 4, fontSize: 11.5, fontWeight: 700, color: 'var(--muted)' }}>Method
            <select className="form-input" value={pay.method} onChange={(e) => setPay((p) => ({ ...p, method: e.target.value }))}>
              {PAY_METHODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
          <label style={{ display: 'grid', gap: 4, fontSize: 11.5, fontWeight: 700, color: 'var(--muted)' }}>Reference
            <input className="form-input" value={pay.ref} onChange={(e) => setPay((p) => ({ ...p, ref: e.target.value }))} placeholder="Transfer or check number" />
          </label>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="secondary-btn" onClick={reset} disabled={busy}>Cancel</button>
            <button type="button" className="primary-btn" disabled={busy || !pay.paidOn}
              onClick={() => run(() => api.paySalaryAdvance(a.id, { paid_on: pay.paidOn, payment_method: pay.method, payment_ref: pay.ref }), 'Marked paid out - the repayment schedule is set')}>
              Mark Paid Out
            </button>
          </div>
        </div>
      )}
      {!mine && !shown && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>Amounts and decisions need the pay grant (Pay & Benefits).</div>}
      {mode === 'schedule' && <ScheduleEditor adv={a} onClose={reset} onSaved={(u) => { onChanged(u); reset(); }} toastOk={toastOk} toastErr={toastErr} />}
    </div>
  );
}

/** The section below the card: "Your Salary Advances" on your own Time
 *  Sheet, "Salary Advances" on someone else's. Nothing when there is
 *  nothing this viewer may see. */
export default function TimeSheetAdvances({ adv, self = false, me = '', toastOk, toastErr }) {
  const list = adv?.data?.advances || [];
  if (!list.length) return null;
  const myEmail = (me || '').toLowerCase();
  return (
    <section data-timesheet-advances style={{ marginTop: 14, border: '1px solid var(--wk-line2)', borderRadius: 14, background: 'var(--card)', boxShadow: 'var(--wk-shadow)', overflow: 'hidden' }}>
      <div style={{ padding: '8px 12px', background: 'var(--wk-hover)', fontSize: 12, fontWeight: 600, color: 'var(--wk-dim)' }}>
        {self ? 'Your Salary Advances' : 'Salary Advances'}
        <span style={{ fontWeight: 400, marginLeft: 6 }}>- {self ? 'repaid from your pay, a line on the pay period it comes out of.' : 'repaid from later pay periods, a line on each one.'}</span>
      </div>
      {list.map((a) => (
        <AdvanceRow key={a.id} a={a} mine={self} asker={!!myEmail && (a.requestedBy || '').toLowerCase() === myEmail && a.source !== 'grant'}
          onChanged={adv.replace} toastOk={toastOk} toastErr={toastErr} />
      ))}
    </section>
  );
}

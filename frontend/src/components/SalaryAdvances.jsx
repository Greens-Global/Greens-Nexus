// Workday > Salary Advance (Neil, Oct 27 2026). Pay given ahead of payday and
// taken back out of later pay periods. The manager tier and up ask for their
// own; HR (as on time sheets) approves or declines, can grant one to anyone,
// marks it Paid Out and changes how it is repaid - always with a reason.
// Each repayment is a "Salary Advance Repayment" line on the Time Sheet.
// One card on the Overview (hidden for anyone with no option, no advance
// and no HR role); HR's queue opens from Manage. Server side:
// routers/salary_advances.py + salary_advance.py.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Banknote, ChevronDown, Plus, Settings2, Trash2 } from 'lucide-react';
import { api } from '../api';
import { Spinner } from './AsyncState';
import { StatusLabel } from './StatusLabel';
import { formatDate, formatDateTime } from '../lib/datetime';
import { DateField, Modal, PersonSelect } from '../tasks/components';

export const OPEN_SALARY_ADVANCES = 'nexus:open-salary-advances';

const STATUS_COLOR = {
  requested: '#b45309', approved: '#2563eb', declined: '#b91c1c', paid_out: '#2563eb',
  repaying: '#7c3aed', repaid: '#16a34a', canceled: '#64748b',
};
const ROW_STATUS = { scheduled: ['Scheduled', '#64748b'], deducted: ['Repaid', '#16a34a'] };
const PAY_METHODS = [['ach', 'ACH / Bank Transfer'], ['payroll', 'With Payroll'], ['check', 'Check'], ['other', 'Other']];
const HR_TABS = [['requested', 'To Decide'], ['approved', 'To Pay Out'], ['active', 'Repaying'], ['done', 'Closed']];
const inTab = (a, k) => (k === 'active' ? ['paid_out', 'repaying'].includes(a.status)
  : k === 'done' ? ['repaid', 'declined', 'canceled'].includes(a.status) : a.status === k);
const lbl = { fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', display: 'block', margin: '10px 0 4px' };
const small = { fontSize: 12, padding: '5px 10px' };
const todayIso = () => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`; };
const day = (iso) => (iso ? formatDate(`${iso.slice(0, 10)}T12:00:00`) : '');

const money = (n, cur) => {
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur || 'USD' }).format(n || 0); }
  catch { return `${(n || 0).toFixed(2)} ${cur || ''}`; }
};

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

/** Ask for my own advance, or (HR) grant one to someone. */
function AdvanceForm({ grant = false, payCurrency = 'USD', maxInstallments = 24, onClose, onDone, flash }) {
  const people = usePeople(grant);
  const [f, setF] = useState({ email: '', amount: '', reason: '', installments: '1' });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const amount = parseFloat(f.amount);
  const n = parseInt(f.installments, 10);
  const ok = amount > 0 && f.reason.trim().length >= 3 && n >= 1 && n <= maxInstallments && (!grant || f.email);
  const send = async () => {
    if (!ok) return;
    setBusy(true);
    try {
      const body = { amount, reason: f.reason.trim(), installments: n, currency: grant ? '' : payCurrency };
      const row = grant ? await api.grantSalaryAdvance({ ...body, email: f.email }) : await api.requestSalaryAdvance(body);
      flash(grant ? `Advance granted to ${row.name}` : 'Sent to HR for approval');
      onDone(row);
    } catch (e) { flash(e?.message || 'Could not send it', false); }
    finally { setBusy(false); }
  };
  const per = amount > 0 && n > 0 ? amount / n : 0;
  return (
    <Modal title={grant ? 'Grant a Salary Advance' : 'Request a Salary Advance'} onClose={onClose}
      isDirty={!!(f.amount || f.reason)}
      footer={<>
        <button type="button" className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="primary-btn" onClick={send} disabled={busy || !ok}>
          {busy ? <><Spinner size={13} /> Sending…</> : grant ? 'Grant Advance' : 'Send to HR'}
        </button>
      </>}>
      <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 4 }}>
        {grant ? 'Approved at once. Mark it Paid Out once it is paid - repayment starts the pay period after.'
          : 'HR approves it and pays it out. It is repaid from your pay, starting the pay period after it is paid out.'}
      </div>
      {grant && (<>
        <label style={lbl} htmlFor="sa-person">Who</label>
        <PersonSelect id="sa-person" value={f.email || null} onChange={(v) => setF((x) => ({ ...x, email: v || '' }))}
          people={people} placeholder="Pick a person" allowNone={false}
          style={{ borderRadius: 10, padding: '9px 13px', fontSize: 13.5, fontWeight: 400 }} />
      </>)}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
        <div>
          <label style={lbl} htmlFor="sa-amount">Amount{grant ? '' : ` (${payCurrency})`}</label>
          <input id="sa-amount" className="form-input" type="number" min="0" step="0.01" inputMode="decimal" style={{ width: '100%' }}
            value={f.amount} onChange={set('amount')} placeholder="0.00" autoFocus={!grant} />
          {grant && <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}>In the person's pay currency.</div>}
        </div>
        <div>
          <label style={lbl} htmlFor="sa-n">Repay Over (Pay Periods)</label>
          <input id="sa-n" className="form-input" type="number" min="1" max={maxInstallments} step="1" style={{ width: '100%' }}
            value={f.installments} onChange={set('installments')} />
          {per > 0 && n > 1 && <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}>About {grant ? per.toFixed(2) : money(per, payCurrency)} a pay period.</div>}
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

/** HR: replace what is left to repay. */
function ScheduleEditor({ adv, onClose, onSaved, flash }) {
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
      flash(out.skippedFinalized ? 'Schedule saved - a finalized pay period was skipped' : 'Schedule saved');
      onSaved(out);
    } catch (e) { flash(e?.message || 'Could not save', false); }
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

/** One advance and whatever this viewer can do to it. as: 'mine' | 'hr' */
function AdvanceRow({ a, as, onChanged, flash }) {
  const [mode, setMode] = useState('');          // '' | decline | cancel | pay | move:<id> | schedule
  const [note, setNote] = useState('');
  const [pay, setPay] = useState({ paidOn: todayIso(), method: 'ach', ref: '' });
  const [moveTo, setMoveTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const hr = as === 'hr';
  // An advance is pay (Oct 27 2026): HR without the pay grant sees that it
  // exists - no amounts (the server leaves them out) - and cannot act on it.
  const act = hr && a.canDecide !== false;
  const shown = a.amount !== undefined;
  const reset = () => { setMode(''); setNote(''); setMoveTo(''); };
  const run = async (fn, okMsg) => {
    setBusy(true);
    try { const u = await fn(); onChanged(u); reset(); if (okMsg) flash(typeof okMsg === 'function' ? okMsg(u) : okMsg); }
    catch (e) { flash(e?.message || 'Could not save', false); }
    finally { setBusy(false); }
  };
  const moving = mode.startsWith('move:') ? mode.slice(5) : '';
  const owed = ['paid_out', 'repaying'].includes(a.status);
  return (
    <div style={{ padding: '12px 0', borderBottom: '1px solid var(--line)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {hr && <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)' }}>{a.name}</span>}
        {shown && <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)' }}>{money(a.amount, a.currency)}</span>}
        <span style={{ flex: 1 }} />
        <StatusLabel label={a.statusLabel} color={STATUS_COLOR[a.status]} size="sm" />
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <span>{a.source === 'grant' ? `Granted by ${a.requestedByName}` : `Requested ${day(a.requestedAt)}`}</span>
        <span>{a.installments} pay period{a.installments === 1 ? '' : 's'}</span>
        {a.paidOn && <span>Paid out {day(a.paidOn)}</span>}
        {shown && (owed || a.status === 'repaid') && <span>Repaid {money(a.repaid, a.currency)} · Balance {money(a.balance, a.currency)}</span>}
      </div>
      {a.reason && <div style={{ fontSize: 12.5, color: 'var(--ink)', marginTop: 4 }}>{a.reason}</div>}
      {a.decisionNote && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>HR: {a.decisionNote}</div>}
      {a.schedule.length > 0 && (
        <div style={{ marginTop: 8, border: '1px solid var(--line)', borderRadius: 10, overflow: 'hidden' }}>
          {a.schedule.map((s, i) => {
            const [word, color] = ROW_STATUS[s.status] || [s.status, '#64748b'];
            return (
              <div key={s.id} style={{ borderTop: i ? '1px solid var(--line)' : 'none', padding: '7px 10px', fontSize: 12.5 }}>
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
        {mode === '' && ((as === 'mine' && a.status === 'requested') || (act && ['requested', 'approved'].includes(a.status))) && (
          <button type="button" className="secondary-btn" style={small} disabled={busy}
            onClick={() => (hr ? setMode('cancel') : run(() => api.cancelSalaryAdvance(a.id, {}), 'Canceled'))}>Cancel Request</button>
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
      {hr && !shown && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>Amounts and decisions need the pay grant (Pay & Benefits).</div>}
      {mode === 'schedule' && <ScheduleEditor adv={a} onClose={reset} onSaved={(u) => { onChanged(u); reset(); }} flash={flash} />}
    </div>
  );
}

const EMPTY = { mine: [], hr: [], canRequest: false, canHr: false, show: false, payCurrency: 'USD', maxInstallments: 24 };

/** The Overview card, its request form and HR's Manage panel. `autoOpen`
 *  (a salary advance bell) opens Manage for HR. */
export default function SalaryAdvancesCard({ autoOpen = false, flash = () => {} }) {
  const [data, setData] = useState(null);
  const [form, setForm] = useState('');             // '' | request | grant
  const [manage, setManage] = useState(false);
  const [hrTab, setHrTab] = useState('requested');
  const landRef = useRef(!!autoOpen);
  const load = useCallback(() => api.getSalaryAdvances()
    .then((d) => {
      const v = { ...EMPTY, ...(d || {}) };
      setData(v);
      if (landRef.current) {
        landRef.current = false;
        const waiting = (v.hr || []).find((a) => a.canDecide !== false && ['requested', 'approved'].includes(a.status));
        if (v.canHr && waiting) { setManage(true); setHrTab(waiting.status); }
      }
    })
    .catch(() => setData(EMPTY)), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const open = () => { landRef.current = true; load(); };
    window.addEventListener(OPEN_SALARY_ADVANCES, open);
    return () => window.removeEventListener(OPEN_SALARY_ADVANCES, open);
  }, [load]);
  const replace = (u) => setData((d) => {
    if (!d || !u) return d;
    const swap = (list) => (list || []).map((x) => (x.id === u.id ? { ...u, skippedFinalized: undefined } : x));
    return { ...d, mine: swap(d.mine), hr: swap(d.hr) };
  });
  // A card that may not exist for this person: nothing until the answer is in.
  if (!data || !data.show) return null;
  const waiting = (data.hr || []).filter((a) => a.canDecide !== false && ['requested', 'approved'].includes(a.status)).length;
  const mine = data.mine || [];
  const list = (data.hr || []).filter((a) => inTab(a, hrTab));
  return (
    <div className="dash-card" data-salary-advances>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
        <span className="dk-chip dk-chip--green" style={{ width: 32, height: 32 }}><Banknote size={16} /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--ink)' }}>Salary Advance</div>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>Pay ahead of payday, repaid from later pay periods.</div>
        </div>
        {data.canHr && (
          <button type="button" className="secondary-btn" onClick={() => setManage(true)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, ...small }}>
            <Settings2 size={13} /> Manage{waiting ? ` (${waiting})` : ''}
          </button>
        )}
        {data.canRequest && (
          <button type="button" className="primary-btn" onClick={() => setForm('request')}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, ...small }}>
            <Plus size={13} /> Request Advance
          </button>
        )}
      </div>
      {mine.length === 0 ? (
        <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '8px 0 2px' }}>
          {data.canRequest ? 'No salary advances. Use Request Advance to ask HR for one.' : 'No salary advances of your own.'}
        </div>
      ) : mine.map((a) => <AdvanceRow key={a.id} a={a} as="mine" onChanged={replace} flash={flash} />)}

      {form && (
        <AdvanceForm grant={form === 'grant'} payCurrency={data.payCurrency} maxInstallments={data.maxInstallments}
          onClose={() => setForm('')} flash={flash}
          onDone={(row) => {
            setForm('');
            setData((d) => (form === 'grant' ? { ...d, hr: [row, ...(d.hr || [])] } : { ...d, mine: [row, ...(d.mine || [])] }));
          }} />
      )}
      {manage && (
        <Modal title="Salary Advances - HR" onClose={() => setManage(false)}
          footer={<button type="button" className="secondary-btn" onClick={() => setManage(false)}>Done</button>}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
            <div className="wd-seg" role="tablist" aria-label="Salary Advances">
              {HR_TABS.map(([k, label]) => {
                const n = (data.hr || []).filter((a) => inTab(a, k)).length;
                return (
                  <button key={k} type="button" role="tab" aria-selected={hrTab === k} className={hrTab === k ? 'on' : ''} onClick={() => setHrTab(k)}>
                    {label}{n ? ` (${n})` : ''}
                  </button>
                );
              })}
            </div>
            <span style={{ flex: 1 }} />
            {data.canGrant !== false && (
              <button type="button" className="primary-btn" onClick={() => setForm('grant')}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, ...small }}><Plus size={13} /> Grant Advance</button>
            )}
          </div>
          <div className="nx-fill">
            {list.length === 0
              ? <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '14px 0' }}>Nothing here.</div>
              : list.map((a) => <AdvanceRow key={a.id} a={a} as="hr" onChanged={replace} flash={flash} />)}
          </div>
        </Modal>
      )}
    </div>
  );
}

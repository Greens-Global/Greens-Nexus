// HR's actions on an employee (Neil, Oct 8 call): "After an employee is in,
// they're either moving up, they're changing a role, or they're leaving" -
// all from People, not Settings.
//
//   RoleChangeModal - Change Role. In People it asks first: a role change
//                  without a promotion switches the role now (no letter,
//                  no approval) with a required reason; a promotion opens
//                  PromoteModal. Settings > Access passes no onPromote, so it
//                  is only the direct change (Neil, Oct 22).
//   PromoteModal - Promote: the new role, title, effective date
//                  (can be in the past), responsibilities and pay -> a preview
//                  of the letter's signing order -> sent through Nexus Sign:
//                  the employee signs, then the manager. When it is fully
//                  signed the role, access and pay change, and the letter is
//                  filed in their Egnyte folder (My HR > My Documents).
//
// Promote and Offboard show What They Get (Hiring Setup round 2), live from
// promotion/options and offboard/options: the letter or package this
// employee's row resolves to, the new role's duties and who signs. A missing
// promotion letter is amber and Review Letter stays off (Change Role Now still
// works); a missing separation package never blocks - the offboarding runs
// without documents. Set It Up / Add Duties open the Hiring Setup over the
// form, which keeps its values.
import { useEffect, useRef, useState } from 'react';
import { X, Send, FileSignature, FolderOpen, TrendingUp, ArrowRight, AlertTriangle, LogOut, Shield } from 'lucide-react';
import { api } from '../api';
import { Spinner } from './AsyncState';
import { usDay, EmailPreviewModal, Problem, PacketsModal } from './HiringPacket';
import { WhatTheyGetCard, HrQuestionFields, splitAnswers, unanswered } from './OfferModal';
import { EXIT_TYPE_LABELS } from '../lib/wordSamples';
import { usePeopleDirectory } from '../lib/queries';
import { currencyOptions } from '../asset/lib/currency';
import PersonSearchSelect from './PersonSearchSelect';
import { DateField } from '../tasks/components';

const lbl = { fontSize: 11, fontWeight: 700, color: 'var(--muted)', display: 'block', margin: '12px 0 4px', textTransform: 'uppercase', letterSpacing: '.04em' };
const hint = { fontSize: 11.5, color: 'var(--muted)', marginTop: 4, lineHeight: 1.5 };
const FREQUENCIES = [['annual', 'Per Year'], ['monthly', 'Per Month'], ['semimonthly', 'Twice A Month'], ['biweekly', 'Every Two Weeks'], ['weekly', 'Per Week']];
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

const card = { marginTop: 14, background: 'var(--mist)', border: '1px solid var(--line)', borderRadius: 12, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 };
const cardTitle = { fontSize: 13.5, fontWeight: 800 };

// The Hiring Setup over Promote / Offboard, opened on the thing to fix.
function SetupOver({ fix, companyId, onClose, toastErr }) {
  if (!fix) return null;
  return <PacketsModal initialCompanyId={companyId} focus={fix} toastOk={() => {}} toastErr={toastErr || (() => {})} onClose={onClose} />;
}
const fixOf = (g, companyId) => ({ entityId: g.fix.target?.entityId || companyId, ...(g.fix.target || {}) });
// The preview's typed-in blanks: an empty one never overrides an HR answer typed since.
const filled = o => Object.fromEntries(Object.entries(o).filter(([, v]) => String(v || '').trim()));

function Warn({ children }) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', background: 'hsla(var(--color-orange),0.1)', color: 'hsl(var(--color-orange))', borderRadius: 10, padding: '8px 12px', fontSize: 12, marginTop: 8 }}>
      <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} /><span>{children}</span>
    </div>
  );
}

// Change Role (Pranshu, Oct 13): "it should be simple" - ask whether it is a
// promotion. Without one, the role changes now - only HR, IT Admins and
// Global Admins see this (Neil, Oct 22: no approval, but never without a
// logged reason). A promotion goes to the letter. Used in People and in
// Settings > Access (which passes its own `roles`, no onPromote, and knows
// the person by workEmail).
export function RoleChangeModal({ employee: e, roles: givenRoles, onClose, onPromote, onChanged, toastErr }) {
  const [plain, setPlain] = useState(!onPromote);
  const [fetched, setFetched] = useState(null);
  const [roleId, setRoleId] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (givenRoles) return;
    api.hiringOptions(e.company || '').then(o => setFetched(o.roles || [])).catch(() => setFetched([]));
  }, [e.company, givenRoles]);
  const roles = givenRoles || fetched;
  const name = [e.firstName, e.lastName].filter(Boolean).join(' ');
  const role = (roles || []).find(r => r.id === roleId);

  async function save() {
    setBusy(true);
    try {
      onChanged(await api.changeRoleNow(e.id || e.workEmail, { role_id: roleId, reason }));
    } catch (err) { toastErr(err?.message || 'Could not change the role.'); setBusy(false); }
  }
  // The role is their Nexus access: no work email, no role (the API's 409, said up front).
  const noEmail = !e.workEmail;
  const choice = (on, Icon, color, title, sub, onClick, off = false) => (
    <button type="button" onClick={onClick} disabled={off}
      style={{ display: 'flex', gap: 12, alignItems: 'flex-start', width: '100%', textAlign: 'left', padding: '12px 14px', marginTop: 10, borderRadius: 12, cursor: off ? 'not-allowed' : 'pointer', opacity: off ? 0.55 : 1, fontFamily: 'Inter,sans-serif', color: 'var(--ink)',
        border: `1.5px solid ${on ? 'var(--pine)' : 'var(--line)'}`, background: on ? 'hsla(var(--color-green),0.06)' : 'var(--card)' }}>
      <Icon size={18} style={{ color, flexShrink: 0, marginTop: 1 }} />
      <div><div style={{ fontWeight: 700, fontSize: 13.5 }}>{title}</div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2, lineHeight: 1.5 }}>{sub}</div></div>
    </button>
  );

  return (
    <div onClick={ev => ev.target === ev.currentTarget && onClose()}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1250, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div className="nx-popup" style={{ background: 'var(--card)', borderRadius: 16, display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)', fontFamily: 'Inter,sans-serif' }}>
        <div style={{ padding: '16px 22px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <Shield size={17} style={{ color: 'var(--pine)' }} />
          <div style={{ flex: 1, fontWeight: 800, fontSize: 15.5 }}>Change Role - {name}</div>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        <div className="nx-fill" style={{ overflowY: 'auto', padding: '6px 22px 18px' }}>
          {onPromote && choice(plain, Shield, 'var(--pine)', 'Role Change Without Promotion',
            noEmail ? 'They need a work email first.' : 'Their access and title follow the new role right away - no letter to sign.',
            () => setPlain(true), noEmail)}
          {onPromote && choice(false, TrendingUp, 'hsl(var(--color-green))', 'Promotion',
            'A promotion letter with the new responsibilities, pay and effective date, signed through Nexus Sign.', onPromote)}
          {plain && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 16, fontSize: 13, flexWrap: 'wrap' }}>
                <span style={{ padding: '6px 12px', borderRadius: 10, background: 'var(--mist)' }}>{e.jobTitle || 'No title yet'}</span>
                <ArrowRight size={15} style={{ color: 'var(--muted)' }} />
                <span style={{ padding: '6px 12px', borderRadius: 10, background: 'hsla(var(--color-green),0.1)', fontWeight: 700 }}>{role?.name || 'pick the new role'}</span>
              </div>
              <label style={lbl}>New Role *</label>
              <select className="form-input" style={{ width: '100%' }} value={roleId} onChange={ev => setRoleId(ev.target.value)}>
                <option value="">{roles === null ? 'Loading roles...' : '- pick a role -'}</option>
                {(roles || []).map(r => <option key={r.id} value={r.id}>{r.name}{r.department ? ` - ${r.department}` : ''}</option>)}
              </select>
              <label style={lbl}>Reason *</label>
              <textarea className="form-input" rows={3} style={{ width: '100%', resize: 'vertical', fontFamily: 'Inter,sans-serif', fontSize: 13 }}
                value={reason} onChange={ev => setReason(ev.target.value)} placeholder="e.g. Moving to the Accounting team to cover month-end close" />
              <div style={hint}>Required - kept in their role history, and their manager sees it.</div>
            </>
          )}
        </div>
        <div style={{ padding: '12px 22px', borderTop: '1px solid var(--line)', display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
          {plain && (
            <button className="primary-btn" onClick={save} disabled={busy || !roleId || !reason.trim()} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {busy ? <Spinner size={14} /> : <Shield size={14} />} Change Role
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// Every question a letter asks HR is needed: an empty one prints as Unfilled and stops the letter at Verify.
const allRequired = (qs) => (qs || []).map(q => ({ ...q, required: true }));
const MissingAnswers = ({ list }) => (list.length > 0
  ? <div role="status" style={{ ...hint, color: '#b45309' }}>Answer {list.map(q => q.label).join(', ')} before you review.</div> : null);

export function PromoteModal({ employee: e, mode = 'promotion', canSeePay, onClose, onSent, toastErr }) {
  const changeType = mode;
  const [roles, setRoles] = useState(null);
  const [f, setF] = useState({ role_id: '', job_title: '', effective_date: todayIso(), responsibilities: '', reason: '', salary_text: '' });
  const [pay, setPay] = useState({ base: '', payBasis: 'salary', frequency: 'annual', currency: 'USD' });
  const [extra, setExtra] = useState({});
  const [preview, setPreview] = useState(null);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState('');
  const [mail, setMail] = useState(null);
  const [opts, setOpts] = useState(null);           // promotion/options: the letter, the new role's duties, who signs
  const [optsErr, setOptsErr] = useState('');
  const [answers, setAnswers] = useState({});       // the letter's own HR Answers questions
  const [fix, setFix] = useState(null);
  const [reload, setReload] = useState(0);
  const typed = useRef(false);                     // HR edited the duties: a later prefill never overwrites them
  const prefilled = useRef('');
  useEffect(() => { api.hiringOptions(e.company || '').then(o => setRoles(o.roles || [])).catch(() => setRoles([])); }, [e.company]);
  useEffect(() => {
    let alive = true;
    api.promotionOptions(e.id, f.role_id).then(o => {
      if (!alive) return;
      setOpts(o); setOptsErr('');
      const text = o?.duties?.text || '';
      if (o?.duties && !typed.current && text !== prefilled.current) {
        prefilled.current = text;                                // untyped, so the box still holds the last prefill
        setF(p => ({ ...p, responsibilities: text }));
        setPreview(null);                                        // the shown letter had the old duties
      }
    }).catch(err => { if (alive) { setOpts(null); setOptsErr(err?.message || 'Could not find the promotion letter.'); } });
    return () => { alive = false; };
  }, [e.id, f.role_id, reload]);
  const set = (k, v) => { setF(p => ({ ...p, [k]: v })); setPreview(null); };
  const setP = (k, v) => { setPay(p => ({ ...p, [k]: v })); setPreview(null); };
  const name = [e.firstName, e.lastName].filter(Boolean).join(' ');
  const role = (roles || []).find(r => r.id === f.role_id);
  const past = f.effective_date && f.effective_date < todayIso();
  const gets = opts?.whatTheyGet || [];
  const blocked = gets.some(g => g.blocks);
  const questions = allRequired(opts?.hrQuestions);
  const toAnswer = unanswered(questions, answers, canSeePay);
  const body = () => {
    const { merge, payValues } = splitAnswers(questions, answers, canSeePay);
    return {
      inputs: { ...f, change_type: changeType, merge: { ...filled(extra), ...merge } },
      pay: canSeePay && String(pay.base).trim() ? { ...pay, base: Number(pay.base) } : null,
      pay_values: payValues,
      excluded_ack: ack,
    };
  };
  const missing = (preview?.unresolved || []).filter(k => !(extra[k] || '').trim());

  async function review() {
    setBusy('preview');
    try {
      const p = await api.previewPromotion(e.id, body());
      setPreview(p);
      setExtra(prev => Object.fromEntries((p.unresolved || []).map(k => [k, prev[k] || ''])));
    } catch (err) { toastErr(err?.message || 'Could not build the letter.'); }
    setBusy('');
  }
  async function send() {
    setBusy('send');
    try { onSent(await api.sendPromotion(e.id, body())); }
    catch (err) { toastErr(err?.message || 'Could not send the letter.'); setBusy(''); }
  }
  // A letter built from Documents (Oct 14): generated now, verified by HR,
  // then sent - the review opens next.
  const docsMode = preview?.engine === 'documents';
  async function start() {
    setBusy('send');
    try {
      const b = body();
      const ev = await api.startPromotion(e.id, { inputs: b.inputs, pay: b.pay, pay_values: b.pay_values });
      onSent({ ...ev, openReview: true });
    } catch (err) { toastErr(err?.message || 'Could not start the letter.'); setBusy(''); }
  }
  const input = (label, key, props = {}) => (
    <div><label style={lbl}>{label}</label>
      <input className="form-input" style={{ width: '100%' }} value={f[key]} onChange={ev => set(key, ev.target.value)} {...props} /></div>
  );

  return (
    <div onClick={ev => ev.target === ev.currentTarget && onClose()}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1250, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div className="nx-popup" style={{ background: 'var(--card)', borderRadius: 16, display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)', fontFamily: 'Inter,sans-serif' }}>
        <div style={{ padding: '16px 22px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <TrendingUp size={17} style={{ color: 'hsl(var(--color-green))' }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 800, fontSize: 15.5 }}>{changeType === 'promotion' ? 'Promote' : 'Change Role'} - {name}</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 1 }}>A letter through Nexus Sign: {name} signs, then their manager. It takes effect when both have signed.</div>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        <div style={{ overflowY: 'auto', flex: 1, padding: '6px 22px 18px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14, fontSize: 13, flexWrap: 'wrap' }}>
            <span style={{ padding: '6px 12px', borderRadius: 10, background: 'var(--mist)' }}>{e.jobTitle || 'No title yet'}</span>
            <ArrowRight size={15} style={{ color: 'var(--muted)' }} />
            <span style={{ padding: '6px 12px', borderRadius: 10, background: 'hsla(var(--color-green),0.1)', fontWeight: 700 }}>{f.job_title || role?.name || 'pick the new role'}</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 260px), 1fr))', gap: '0 14px' }}>
            <div><label style={lbl}>New Role *</label>
              <select className="form-input" style={{ width: '100%' }} value={f.role_id}
                onChange={ev => { const r = (roles || []).find(x => x.id === ev.target.value); setF(p => ({ ...p, role_id: ev.target.value, job_title: r ? r.name : p.job_title })); setPreview(null); setOpts(null); }}>
                <option value="">{roles === null ? 'Loading roles...' : '- pick a role -'}</option>
                {(roles || []).map(r => <option key={r.id} value={r.id}>{r.name}{r.department ? ` - ${r.department}` : ''}</option>)}
              </select>
              <div style={hint}>The role sets their access in Nexus - it changes when the letter is signed.</div></div>
            {input('Title In The Letter', 'job_title', { placeholder: 'Defaults to the role name' })}
            <div><label style={lbl}>Effective Date *</label>
              <div className="form-input" style={{ width: '100%', display: 'flex', alignItems: 'center' }}>
                <DateField value={f.effective_date} onChange={x => set('effective_date', x || '')} placeholder="MM/DD/YYYY" title="Effective date" style={{ width: '100%' }} />
              </div></div>
          </div>
          {past && <Warn>The effective date is in the past. Pay is dated from it; any time sheet from then that is already signed is flagged for HR to review, not changed.</Warn>}
          <div aria-label="What They Get" style={card}>
            <div style={cardTitle}>What They Get</div>
            {!opts && optsErr ? <div role="alert" style={{ fontSize: 12.5, color: '#b45309', fontWeight: 600 }}>{optsErr}</div>
              : !opts ? <Spinner size={16} />
                : <WhatTheyGetCard lines={gets} blocked={opts.blocked} onFix={g => setFix(fixOf(g, e.company))} />}
          </div>
          <label style={lbl}>New Role's Duties</label>
          <textarea className="form-input" rows={5} style={{ width: '100%', resize: 'vertical', fontFamily: 'Inter,sans-serif', fontSize: 13 }} aria-label="New Role's Duties"
            placeholder="What changes in their day-to-day - printed in the letter" value={f.responsibilities}
            onChange={ev => { typed.current = true; set('responsibilities', ev.target.value); }} />
          {opts?.duties?.text && (
            <div style={hint}>From {opts.duties.versionId && opts.duties.versionLabel ? opts.duties.versionLabel : "the role's Standard"} - change them for this letter only. The role is not changed.</div>
          )}
          {questions.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0 14px' }}>
              <HrQuestionFields questions={questions} answers={answers} setAnswers={(fn) => { setAnswers(fn); setPreview(null); }} canSeePay={canSeePay} idPrefix="pr-q" />
            </div>
          )}
          <MissingAnswers list={toAnswer} />
          {canSeePay ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '0 14px' }}>
              <div><label style={lbl}>New Pay</label>
                <input className="form-input" type="number" min="0" step="0.01" style={{ width: '100%' }} value={pay.base} onChange={ev => setP('base', ev.target.value)} placeholder="Leave blank if pay stays" /></div>
              <div><label style={lbl}>Paid</label>
                <select className="form-input" style={{ width: '100%' }} value={pay.payBasis} onChange={ev => setP('payBasis', ev.target.value)}>
                  <option value="salary">Salary</option><option value="hourly">Hourly</option>
                </select></div>
              {pay.payBasis === 'salary' && <div><label style={lbl}>Frequency</label>
                <select className="form-input" style={{ width: '100%' }} value={pay.frequency} onChange={ev => setP('frequency', ev.target.value)}>
                  {FREQUENCIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select></div>}
              <div><label style={lbl}>Currency</label>
                <select className="form-input" style={{ width: '100%' }} value={pay.currency} onChange={ev => setP('currency', ev.target.value)}>
                  {currencyOptions().map(c => <option key={c.code} value={c.code}>{c.label}</option>)}
                </select></div>
            </div>
          ) : (
            <>{input('Pay As Written In The Letter', 'salary_text', { placeholder: 'e.g. $95,000 per year, or "unchanged"' })}
              <div style={hint}>Pay & Benefits access is needed to change their payroll rate.</div></>
          )}
          {input('Reason *', 'reason', { placeholder: 'e.g. Annual review - exceeded targets' })}
          <div style={hint}>Required - kept in their role history.</div>

          {preview && docsMode && (
            <div style={{ marginTop: 18, border: '1px solid var(--line)', borderRadius: 12, padding: '12px 14px', background: 'var(--mist)' }}>
              <div style={{ fontWeight: 800, fontSize: 13.5 }}>{preview.title}</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14, marginTop: 8 }}>
                <div>
                  <div style={{ ...lbl, marginTop: 0 }}>Documents</div>
                  {preview.documents.map((d, i) => <div key={i} style={{ fontSize: 12.5 }}>{i + 1}. {d}</div>)}
                </div>
                <div>
                  <div style={{ ...lbl, marginTop: 0 }}>Signing Order</div>
                  {preview.recipients.map(r => <div key={`${r.order}-${r.email}`} style={{ fontSize: 12.5 }}>{r.order}. {r.name} ({r.isSubject ? 'the employee' : r.roleLabel}) - {r.actionLabel}</div>)}
                </div>
                <div>
                  <div style={{ ...lbl, marginTop: 0 }}>The Change</div>
                  <div style={{ fontSize: 12.5 }}>{preview.fromTitle || '-'} to <b>{preview.toTitle}</b>, effective <b>{usDay(preview.effectiveDate)}</b></div>
                </div>
              </div>
              <div style={{ fontSize: 12.5, marginTop: 10, padding: '8px 11px', borderRadius: 10, background: 'var(--card)' }}>
                Nothing goes to {name} yet: the letter is generated from Documents, and <b>{preview.verifier?.name || 'HR'}</b> ({preview.verifier?.roleLabel || 'HR'}) checks it and sends it.
              </div>
              {(preview.signedPeriods || []).length > 0 && <Warn>Already signed for the new pay period: {preview.signedPeriods.map(p => p.label).join(', ')}. These will be flagged for HR to review - not repriced.</Warn>}
              {(preview.problems || []).map(p => <Problem key={p}>{p}</Problem>)}
            </div>
          )}
          {preview && !docsMode && (
            <div style={{ marginTop: 18, border: '1px solid var(--line)', borderRadius: 12, padding: '12px 14px', background: 'var(--mist)' }}>
              <div style={{ fontWeight: 800, fontSize: 13.5 }}>{preview.title}</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14, marginTop: 8 }}>
                <div>
                  <div style={{ ...lbl, marginTop: 0 }}>Signing Order</div>
                  {preview.recipients.map(r => <div key={`${r.order}-${r.email}`} style={{ fontSize: 12.5 }}>{r.order}. {r.who === 'employee' ? `${r.name} (${r.email})` : r.who === 'manager' ? `${r.name} (manager)` : `You (${r.role}) - countersign after them`}</div>)}
                </div>
                <div>
                  <div style={{ ...lbl, marginTop: 0 }}>The Change</div>
                  <div style={{ fontSize: 12.5 }}>{preview.fromTitle || '-'} to <b>{preview.toTitle}</b>, effective <b>{usDay(preview.effectiveDate)}</b>{preview.salaryText ? <> at <b>{preview.salaryText}</b></> : null}</div>
                  {preview.salaryText && preview.payInLetter === false && <Problem>This letter does not show pay - {preview.salaryText} will be set as their pay when they sign, but they will not read it in the documents. Add {'{{salary}}'} to the template under Documents &gt; Nexus Sign &gt; Templates, or leave pay blank.</Problem>}
                </div>
                <div>
                  <div style={{ ...lbl, marginTop: 0 }}>Filed In Egnyte</div>
                  <div style={{ fontSize: 12.5, display: 'flex', gap: 6 }}><FolderOpen size={13} style={{ flexShrink: 0, marginTop: 2, color: 'var(--muted)' }} />{name} &gt; {preview.egnyteSubfolder}</div>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12.5 }}>{name} gets the letter by email with a link to sign; their manager gets one after.</span>
                <button type="button" className="secondary-btn" style={{ fontSize: 11.5, padding: '3px 10px' }}
                  onClick={() => setMail({ event: 'promotion', entityId: preview.entityId, templateId: preview.templateId, note: preview.emailMessage || '' })}>Preview Email</button>
                <button type="button" className="secondary-btn" style={{ fontSize: 11.5, padding: '3px 10px' }}
                  onClick={() => setMail({ event: 'promotion', entityId: preview.entityId, templateId: preview.templateId, role: 'manager' })}>Manager Email</button>
              </div>
              {(preview.signedPeriods || []).length > 0 && <Warn>Already signed for the new pay period: {preview.signedPeriods.map(p => p.label).join(', ')}. These will be flagged for HR to review - not repriced.</Warn>}
              {(preview.unresolved || []).length > 0 && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0 14px' }}>
                  {preview.unresolved.map(k => (
                    <div key={k}><label style={lbl}>{k.replace(/_/g, ' ')}</label>
                      <input className="form-input" style={{ width: '100%' }} value={extra[k] || ''} onChange={ev => setExtra(p => ({ ...p, [k]: ev.target.value }))} /></div>
                  ))}
                </div>
              )}
              <label style={{ display: 'flex', gap: 9, alignItems: 'flex-start', cursor: 'pointer', marginTop: 14 }}>
                <input type="checkbox" checked={ack} onChange={ev => setAck(ev.target.checked)} style={{ width: 15, height: 15, marginTop: 1, flexShrink: 0, accentColor: 'var(--pine)' }} />
                <span style={{ fontSize: 12, lineHeight: 1.5 }}>I confirm this is not a record that cannot be signed electronically.</span>
              </label>
            </div>
          )}
        </div>
        {mail && <EmailPreviewModal {...mail} onClose={() => setMail(null)} />}
        <div style={{ padding: '12px 22px', borderTop: '1px solid var(--line)', display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button className="secondary-btn" onClick={onClose} disabled={!!busy}>Cancel</button>
          {!preview ? (
            <button className="primary-btn" onClick={review} disabled={!!busy || blocked || toAnswer.length > 0 || !f.role_id || !f.effective_date || !f.reason.trim()} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {busy === 'preview' ? <Spinner size={14} /> : <FileSignature size={14} />} Review Letter
            </button>
          ) : docsMode ? (
            <button className="primary-btn" onClick={start} disabled={!!busy || !f.reason.trim() || (preview.problems || []).length > 0} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {busy === 'send' ? <Spinner size={14} /> : <FileSignature size={14} />} Generate Letter
            </button>
          ) : (
            <button className="primary-btn" onClick={send} disabled={!!busy || !ack || !f.reason.trim() || missing.length > 0} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {busy === 'send' ? <Spinner size={14} /> : <Send size={14} />} Send For Signature
            </button>
          )}
        </div>
      </div>
      <SetupOver fix={fix} companyId={e.company} toastErr={toastErr} onClose={() => { setFix(null); setReload(n => n + 1); }} />
    </div>
  );
}


// ── Offboard (Neil, Oct 8: 28:19 - 30:04) ────────────────────────────────────
// "it should very clearly say what company are they with, what is the
// off-boarding package". The last day decides where the paperwork goes
// (today = personal email, their access ends now; later = work email) and
// when they become Left (today = now; later = Nexus does it on the day).
// Labels per Charmi (Oct 20 2026); the stored keys stay as they were.
const EXIT_TYPES = Object.entries(EXIT_TYPE_LABELS);

export function OffboardModal({ employee: e, companyName, onClose, onSent, toastErr }) {
  const { data: people = [] } = usePeopleDirectory();
  const [f, setF] = useState({ last_day: todayIso(), exit_type: '', reason: '', send_package: true, start_checklist: true });
  const [mailbox, setMailbox] = useState('remove');
  const [trustees, setTrustees] = useState(() => (e.managerEmail ? [e.managerEmail.toLowerCase()] : []));
  const [handoverTo, setHandoverTo] = useState('');
  const [exportRequested, setExportRequested] = useState(false);
  const [extra, setExtra] = useState({});
  const [preview, setPreview] = useState(null);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState('');
  const [mail, setMail] = useState(null);
  const [opts, setOpts] = useState(null);           // offboard/options: the separation package, who signs
  const [answers, setAnswers] = useState({});
  const [fix, setFix] = useState(null);
  const [reload, setReload] = useState(0);
  const packTouched = useRef(false);               // HR set Send The Separation Package: options never undo it
  useEffect(() => {
    let alive = true;
    // starts at what can be sent; an older API (no options) keeps today's default
    api.offboardOptions(e.id).then(o => {
      if (!alive) return;
      setOpts(o);
      if (!packTouched.current) setF(p => ({ ...p, send_package: !!o.canSendPackage }));
    }).catch(() => {});
    return () => { alive = false; };
  }, [e.id, reload]);
  const set = (k, v) => { setF(p => ({ ...p, [k]: v })); setPreview(null); };
  const name = [e.firstName, e.lastName].filter(Boolean).join(' ');
  const nameOf = em => people.find(p => p.email === em)?.name || em;
  const immediate = f.last_day && f.last_day <= todayIso();
  const noPackage = !!opts && !opts.canSendPackage;
  const packageFix = (opts?.whatTheyGet || []).find(g => g.key === 'package' && g.fix);
  const questions = allRequired(opts?.hrQuestions);
  const toAnswer = unanswered(questions, answers, false);
  const body = () => ({
    inputs: { ...f, merge: { ...filled(extra), ...splitAnswers(questions, answers, false).merge }, offboarding: { mailboxAction: mailbox, delegateTo: mailbox === 'share' ? trustees : [],
      exportRequested, handoverTo } },
    excluded_ack: ack,
  });
  // Documents engine: PacketReview names any blank, and the employee fills their own - only a PDF asks here.
  const typedBlanks = preview?.engine === 'documents' ? [] : (preview?.unresolved || []);
  const missing = typedBlanks.filter(k => !(extra[k] || '').trim());

  async function review() {
    setBusy('preview');
    try {
      const p = await api.previewOffboard(e.id, body());
      setPreview(p);
      setExtra(prev => Object.fromEntries((p.unresolved || []).map(k => [k, prev[k] || ''])));
    } catch (err) { toastErr(err?.message || 'Could not prepare the offboarding.'); }
    setBusy('');
  }
  async function go() {
    setBusy('send');
    try { onSent(await api.offboard(e.id, { ...body(), excluded_ack: preview?.engine === 'documents' ? true : ack })); }
    catch (err) { toastErr(err?.message || 'Could not offboard.'); setBusy(''); }
  }
  const radio = (val, label, sub) => (
    <label style={{ display: 'flex', gap: 10, padding: '9px 11px', borderRadius: 10, border: `1px solid ${mailbox === val ? 'var(--pine)' : 'var(--line)'}`, background: mailbox === val ? 'hsla(var(--color-green),0.06)' : 'transparent', cursor: 'pointer', marginBottom: 8 }}>
      <input type="radio" name="offMailbox" checked={mailbox === val} onChange={() => { setMailbox(val); setPreview(null); }} style={{ marginTop: 2 }} />
      <div><div style={{ fontSize: 13, fontWeight: 600 }}>{label}</div><div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{sub}</div></div>
    </label>
  );
  return (
    <div onClick={ev => ev.target === ev.currentTarget && onClose()}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1250, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div className="nx-popup" style={{ background: 'var(--card)', borderRadius: 16, display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)', fontFamily: 'Inter,sans-serif' }}>
        <div style={{ padding: '16px 22px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <LogOut size={17} style={{ color: 'hsl(var(--color-red))' }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 800, fontSize: 15.5 }}>Offboard - {name}</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 1 }}>{companyName || 'Their company'} · {e.jobTitle || 'No title'}</div>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        <div style={{ overflowY: 'auto', flex: 1, padding: '6px 22px 18px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))', gap: '0 14px' }}>
            <div><label style={lbl}>Last Day *</label>
              <div className="form-input" style={{ width: '100%', display: 'flex', alignItems: 'center' }}>
                <DateField value={f.last_day} onChange={x => set('last_day', x || '')} placeholder="MM/DD/YYYY" title="Last day" style={{ width: '100%' }} />
              </div></div>
            <div><label style={lbl}>Why They Are Leaving *</label>
              <select className="form-input" style={{ width: '100%' }} value={f.exit_type} onChange={ev => set('exit_type', ev.target.value)}>
                <option value="">- pick one -</option>
                {EXIT_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select></div>
          </div>
          <div style={{ marginTop: 10, borderRadius: 10, padding: '9px 12px', fontSize: 12.5,
            background: immediate ? 'hsla(var(--color-red),0.08)' : 'hsla(var(--color-blue),0.08)' }}>
            {immediate
              ? <>Today: their access ends as soon as you confirm, and the paperwork goes to their <b>personal email</b>{e.personalEmail ? ` (${e.personalEmail})` : ' - none on file yet'}.</>
              : <>They keep their access through {usDay(f.last_day)}; the morning after, Nexus marks them Left by itself. The paperwork goes to their <b>work email</b>{e.workEmail ? ` (${e.workEmail})` : ''} - if it is still unsigned when their account closes, it moves to their personal email.</>}
          </div>
          <label style={lbl}>Reason (kept on the record)</label>
          <input className="form-input" style={{ width: '100%' }} value={f.reason} onChange={ev => set('reason', ev.target.value)} placeholder="e.g. Moving out of state" />

          <label style={lbl}>Their Mailbox</label>
          {radio('remove', 'Block sign-in and release the license', 'Mail stops; the license goes back to the pool.')}
          {radio('share', 'Keep it as a shared mailbox', 'Someone keeps reading their mail - pick who below.')}
          {mailbox === 'share' && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
                {trustees.map(t => (
                  <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 6px 3px 10px', borderRadius: 999, background: 'var(--mist)', border: '1px solid var(--line)', fontSize: 12 }}>
                    {nameOf(t)}<button type="button" onClick={() => setTrustees(x => x.filter(y => y !== t))} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 2 }}><X size={12} /></button>
                  </span>
                ))}
              </div>
              <PersonSearchSelect placeholder="+ who gets their mail" groups={[{ label: 'Nexus People', people: people.filter(p => !trustees.includes(p.email)) }]}
                onPick={em => em && setTrustees(x => [...x, em])} />
            </div>
          )}
          <label style={lbl}>Their Tasks Go To</label>
          {handoverTo ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>{nameOf(handoverTo)}
              <button type="button" className="secondary-btn" style={{ fontSize: 11.5, padding: '3px 10px' }} onClick={() => setHandoverTo('')}>Change</button></div>
          ) : (
            <PersonSearchSelect placeholder="Blank = their supervisor" groups={[{ label: 'Nexus People', people: people.filter(p => p.email !== (e.workEmail || '').toLowerCase()) }]}
              onPick={em => setHandoverTo(em || '')} />
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, cursor: 'pointer' }}>
              <input type="checkbox" checked={exportRequested} onChange={ev => setExportRequested(ev.target.checked)} style={{ accentColor: 'var(--pine)' }} /> Export their mailbox first
            </label>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, cursor: 'pointer' }}>
              <input type="checkbox" checked={f.start_checklist} onChange={ev => set('start_checklist', ev.target.checked)} style={{ accentColor: 'var(--pine)' }} /> Start the offboarding checklist
            </label>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, cursor: noPackage ? 'not-allowed' : 'pointer', opacity: noPackage ? 0.6 : 1 }}>
              <input type="checkbox" checked={f.send_package && !noPackage} disabled={noPackage} onChange={ev => { packTouched.current = true; set('send_package', ev.target.checked); }} style={{ accentColor: 'var(--pine)' }} /> Send the separation package through Nexus Sign
            </label>
            {noPackage && (
              <div style={{ ...hint, marginTop: 0, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span>{opts.noPackageText}</span>
                {packageFix && <button type="button" className="secondary-btn" style={{ fontSize: 11.5, padding: '3px 10px' }} onClick={() => setFix(fixOf(packageFix, e.company))}>Set It Up</button>}
              </div>
            )}
          </div>
          {opts && !noPackage && (
            <div aria-label="What They Get" style={card}>
              <div style={cardTitle}>What They Get</div>
              <WhatTheyGetCard lines={opts.whatTheyGet || []} onFix={g => setFix(fixOf(g, e.company))} />
            </div>
          )}
          {questions.length > 0 && f.send_package && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0 14px' }}>
              <HrQuestionFields questions={questions} answers={answers} setAnswers={(fn) => { setAnswers(fn); setPreview(null); }} canSeePay={false} idPrefix="ob-q" />
            </div>
          )}
          {f.send_package && <MissingAnswers list={toAnswer} />}

          {preview && (
            <div style={{ marginTop: 18, border: '1px solid var(--line)', borderRadius: 12, padding: '12px 14px', background: 'var(--mist)' }}>
              <div style={{ fontWeight: 800, fontSize: 13.5 }}>{preview.immediate ? `${name} leaves today` : `${name} leaves on ${usDay(preview.lastDay)}`}</div>
              {preview.package && preview.engine === 'documents' ? (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14, marginTop: 8 }}>
                    <div>
                      <div style={{ ...lbl, marginTop: 0 }}>Package</div>
                      {preview.documents.map((d, i) => <div key={i} style={{ fontSize: 12.5 }}>{i + 1}. {d}</div>)}
                      <div style={hint}>Goes to {preview.sendTo} - {preview.why}.</div>
                    </div>
                    <div>
                      <div style={{ ...lbl, marginTop: 0 }}>Signing Order</div>
                      {preview.recipients.map(r => <div key={`${r.order}-${r.email}`} style={{ fontSize: 12.5 }}>{r.order}. {r.name} ({r.isSubject ? 'leaving' : r.roleLabel}) - {r.actionLabel}</div>)}
                    </div>
                  </div>
                  <div style={{ fontSize: 12.5, marginTop: 10, padding: '8px 11px', borderRadius: 10, background: 'var(--card)' }}>
                    The offboarding goes ahead as set above. The package is generated from Documents and sent once <b>{preview.verifier?.name || 'HR'}</b> ({preview.verifier?.roleLabel || 'HR'}) has checked it.
                  </div>
                  {(preview.problems || []).map(p => <Problem key={p}>{p}</Problem>)}
                </>
              ) : preview.package ? (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14, marginTop: 8 }}>
                  <div>
                    <div style={{ ...lbl, marginTop: 0 }}>Package</div>
                    {preview.documents.map((d, i) => <div key={i} style={{ fontSize: 12.5 }}>{i + 1}. {d}</div>)}
                    <div style={hint}>Goes to {preview.sendTo} - {preview.why}.</div>
                    <button type="button" className="secondary-btn" style={{ fontSize: 11.5, padding: '3px 10px', marginTop: 6 }}
                      onClick={() => setMail({ event: 'separation', entityId: preview.entityId, templateId: preview.templateId, note: preview.emailMessage || '' })}>Preview Email</button>
                  </div>
                  <div>
                    <div style={{ ...lbl, marginTop: 0 }}>Signing Order</div>
                    {preview.recipients.map(r => <div key={`${r.order}-${r.email}`} style={{ fontSize: 12.5 }}>{r.order}. {r.isSubject ? name : r.role === 'manager' ? `${r.name} (manager)` : `You (${r.role}) - countersign after ${name}`}</div>)}
                  </div>
                  <div>
                    <div style={{ ...lbl, marginTop: 0 }}>Filed In Egnyte</div>
                    <div style={{ fontSize: 12.5, display: 'flex', gap: 6 }}><FolderOpen size={13} style={{ flexShrink: 0, marginTop: 2, color: 'var(--muted)' }} />{name} &gt; {preview.egnyteSubfolder}</div>
                  </div>
                </div>
              ) : <div style={{ fontSize: 12.5, marginTop: 6 }}>No paperwork - only the offboarding itself.</div>}
              {typedBlanks.length > 0 && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0 14px' }}>
                  {typedBlanks.map(k => (
                    <div key={k}><label style={lbl}>{k.replace(/_/g, ' ')}</label>
                      <input className="form-input" style={{ width: '100%' }} value={extra[k] || ''} onChange={ev => setExtra(p => ({ ...p, [k]: ev.target.value }))} /></div>
                  ))}
                </div>
              )}
              {preview.package && preview.engine !== 'documents' && (
                <label style={{ display: 'flex', gap: 9, alignItems: 'flex-start', cursor: 'pointer', marginTop: 14 }}>
                  <input type="checkbox" checked={ack} onChange={ev => setAck(ev.target.checked)} style={{ width: 15, height: 15, marginTop: 1, flexShrink: 0, accentColor: 'var(--pine)' }} />
                  <span style={{ fontSize: 12, lineHeight: 1.5 }}>I confirm this is not a record that cannot be signed electronically.</span>
                </label>
              )}
            </div>
          )}
        </div>
        {mail && <EmailPreviewModal {...mail} onClose={() => setMail(null)} />}
        <div style={{ padding: '12px 22px', borderTop: '1px solid var(--line)', display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button className="secondary-btn" onClick={onClose} disabled={!!busy}>Cancel</button>
          {!preview ? (
            <button className="primary-btn" onClick={review} disabled={!!busy || !f.last_day || !f.exit_type || (mailbox === 'share' && !trustees.length) || (f.send_package && toAnswer.length > 0)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {busy === 'preview' ? <Spinner size={14} /> : <FileSignature size={14} />} Review
            </button>
          ) : (
            <button className="primary-btn" onClick={go}
              disabled={!!busy || (preview.package && preview.engine !== 'documents' && !ack) || missing.length > 0
                || (preview.engine === 'documents' && (preview.problems || []).length > 0)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: preview.immediate ? 'hsl(var(--color-red))' : undefined }}>
              {busy === 'send' ? <Spinner size={14} /> : <LogOut size={14} />} {preview.immediate ? 'Offboard Now' : 'Schedule Offboarding'}
            </button>
          )}
        </div>
      </div>
      <SetupOver fix={fix} companyId={e.company} toastErr={toastErr} onClose={() => { setFix(null); setReload(n => n + 1); }} />
    </div>
  );
}

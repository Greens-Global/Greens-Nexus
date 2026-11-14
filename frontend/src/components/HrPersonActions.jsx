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
//   OffboardModal - Offboard: the ONLY way someone becomes Left (Neil,
//                  11/03/2026). The last day is the termination date; the
//                  server runs every leaver step once (hr.apply_status_change).
// All three are sheets from the right (the shared Modal); a question inside
// stays dialog.confirm.
import { useEffect, useRef, useState } from 'react';
import { X, Send, FileSignature, FolderOpen, TrendingUp, ArrowRight, AlertTriangle, LogOut, Shield, FileText, ChevronRight, CalendarClock } from 'lucide-react';
import { api } from '../api';
import { Spinner } from './AsyncState';
import { usDay, EmailPreviewModal, Problem } from './HiringPacket';
import { usePeopleDirectory } from '../lib/queries';
import { currencyOptions } from '../asset/lib/currency';
import PersonSearchSelect from './PersonSearchSelect';
import { DateField, Modal } from '../tasks/components';
import HoldButton, { HOLD_MAJOR_MS } from '../ui/HoldButton';
import { dialog } from '../ui/dialog';
import { VIEW_TO_PATH } from '../lib/routes';

const lbl = { fontSize: 11, fontWeight: 700, color: 'var(--muted)', display: 'block', margin: '12px 0 4px', textTransform: 'uppercase', letterSpacing: '.04em' };
const hint = { fontSize: 12, color: 'var(--muted)', marginTop: 4, lineHeight: 1.5 };
const FREQUENCIES = [['annual', 'Per Year'], ['monthly', 'Per Month'], ['semimonthly', 'Twice A Month'], ['biweekly', 'Every Two Weeks'], ['weekly', 'Per Week']];
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

function Warn({ children }) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', background: 'hsla(var(--color-orange),0.1)', color: 'hsl(var(--color-orange))', borderRadius: 10, padding: '8px 12px', fontSize: 12, marginTop: 8 }}>
      <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} /><span>{children}</span>
    </div>
  );
}

// Change Role (Pranshu, Oct 13): "it should be simple" - ask whether it is a
// promotion. Without one, the role changes now - only HR, Administrators and
// Super Administrators see this (Neil, Oct 22: no approval, but never without a
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

  // An external or guest (often Staged, never "a current employee") keeps
  // the direct assignment Settings always gave them - the same reason asked.
  const external = ['guest', 'external'].includes(e.identityType || 'internal');
  async function save() {
    setBusy(true);
    try {
      if (external) {
        const res = await api.assignJobRole(roleId, e.workEmail, reason);
        onChanged({ roleId, roleName: role?.name || '', warning: res?.warning || '' });
      } else {
        onChanged(await api.changeRoleNow(e.id || e.workEmail, { role_id: roleId, reason }));
      }
    } catch (err) { toastErr(err?.message || 'Could not change the role.'); setBusy(false); }
  }
  // The role is their Nexus access: no work email, no role (the API's 409, said up front).
  const noEmail = !e.workEmail;
  const choice = (on, Icon, color, title, sub, onClick, off = false) => (
    <button type="button" onClick={onClick} disabled={off}
      style={{ display: 'flex', gap: 12, alignItems: 'flex-start', width: '100%', textAlign: 'left', padding: '12px 14px', marginTop: 10, borderRadius: 12, cursor: off ? 'not-allowed' : 'pointer', opacity: off ? 0.55 : 1, fontFamily: 'Inter,sans-serif', color: 'var(--ink)',
        border: `1.5px solid ${on ? 'var(--pine)' : 'var(--line)'}`, background: on ? 'hsla(var(--color-green),0.06)' : 'var(--card)' }}>
      <Icon size={18} style={{ color, flexShrink: 0, marginTop: 1 }} />
      <div><div style={{ fontWeight: 700, fontSize: 13 }}>{title}</div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2, lineHeight: 1.5 }}>{sub}</div></div>
    </button>
  );

  return (
    <Modal title={`Change Role - ${name}`} onClose={onClose} zIndex={4100} isDirty={!!(roleId || reason.trim()) && !busy}
      footer={<>
        <button className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
        {plain && (
          <button className="primary-btn" onClick={save} disabled={busy || !roleId || !reason.trim()} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {busy ? <Spinner size={14} /> : <Shield size={14} />} Change Role
          </button>
        )}
      </>}>
        <div className="nx-fill" style={{ fontFamily: 'Inter,sans-serif' }}>
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
    </Modal>
  );
}

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
  useEffect(() => { api.hiringOptions(e.company || '').then(o => setRoles(o.roles || [])).catch(() => setRoles([])); }, [e.company]);
  const set = (k, v) => { setF(p => ({ ...p, [k]: v })); setPreview(null); };
  const setP = (k, v) => { setPay(p => ({ ...p, [k]: v })); setPreview(null); };
  const name = [e.firstName, e.lastName].filter(Boolean).join(' ');
  const role = (roles || []).find(r => r.id === f.role_id);
  const past = f.effective_date && f.effective_date < todayIso();
  const body = () => ({
    inputs: { ...f, change_type: changeType, merge: extra },
    pay: canSeePay && String(pay.base).trim() ? { ...pay, base: Number(pay.base) } : null,
    excluded_ack: ack,
  });
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
      const ev = await api.startPromotion(e.id, { inputs: b.inputs, pay: b.pay });
      onSent({ ...ev, openReview: true });
    } catch (err) { toastErr(err?.message || 'Could not start the letter.'); setBusy(''); }
  }
  const input = (label, key, props = {}) => (
    <div><label style={lbl}>{label}</label>
      <input className="form-input" style={{ width: '100%' }} value={f[key]} onChange={ev => set(key, ev.target.value)} {...props} /></div>
  );

  return (
    <Modal title={`${changeType === 'promotion' ? 'Promote' : 'Change Role'} - ${name}`} onClose={onClose} zIndex={4100}
      isDirty={!!(f.role_id || f.reason.trim() || f.responsibilities.trim()) && !busy}
      footer={<>
        <button className="secondary-btn" onClick={onClose} disabled={!!busy}>Cancel</button>
        {!preview ? (
          <button className="primary-btn" onClick={review} disabled={!!busy || !f.role_id || !f.effective_date || !f.reason.trim()} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
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
      </>}>
        <div style={{ fontFamily: 'Inter,sans-serif' }}>
          <div style={{ fontSize: 13, color: 'var(--muted)' }}>A letter through Nexus Sign: {name} signs, then their manager. It takes effect when both have signed.</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14, fontSize: 13, flexWrap: 'wrap' }}>
            <span style={{ padding: '6px 12px', borderRadius: 10, background: 'var(--mist)' }}>{e.jobTitle || 'No title yet'}</span>
            <ArrowRight size={15} style={{ color: 'var(--muted)' }} />
            <span style={{ padding: '6px 12px', borderRadius: 10, background: 'hsla(var(--color-green),0.1)', fontWeight: 700 }}>{f.job_title || role?.name || 'pick the new role'}</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 260px), 1fr))', gap: '0 14px' }}>
            <div><label style={lbl}>New Role *</label>
              <select className="form-input" style={{ width: '100%' }} value={f.role_id}
                onChange={ev => { const r = (roles || []).find(x => x.id === ev.target.value); setF(p => ({ ...p, role_id: ev.target.value, job_title: r ? r.name : p.job_title })); setPreview(null); }}>
                <option value="">{roles === null ? 'Loading roles...' : '- pick a role -'}</option>
                {(roles || []).map(r => <option key={r.id} value={r.id}>{r.name}{r.department ? ` - ${r.department}` : ''}</option>)}
              </select>
              <div style={hint}>The role sets their access in Nexus - it changes when the letter is signed.</div></div>
            {input('Title In The Letter', 'job_title', { placeholder: 'Defaults to the role name' })}
            <div><label style={lbl}>Effective Date *</label>
              <DateField value={f.effective_date} onChange={v => set('effective_date', v || '')} placeholder="MM/DD/YYYY" title="Effective date" style={{ width: '100%' }} /></div>
          </div>
          {past && <Warn>The effective date is in the past. Pay is dated from it; any time sheet from then that is already signed is flagged for HR to review, not changed.</Warn>}
          <label style={lbl}>New Responsibilities</label>
          <textarea className="form-input" rows={3} style={{ width: '100%', resize: 'vertical', fontFamily: 'Inter,sans-serif', fontSize: 13 }}
            placeholder="What changes in their day-to-day - printed in the letter" value={f.responsibilities} onChange={ev => set('responsibilities', ev.target.value)} />
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
              <div style={{ fontWeight: 800, fontSize: 13 }}>{preview.title}</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14, marginTop: 8 }}>
                <div>
                  <div style={{ ...lbl, marginTop: 0 }}>Documents</div>
                  {preview.documents.map((d, i) => <div key={i} style={{ fontSize: 13 }}>{i + 1}. {d}</div>)}
                </div>
                <div>
                  <div style={{ ...lbl, marginTop: 0 }}>Signing Order</div>
                  {preview.recipients.map(r => <div key={`${r.order}-${r.email}`} style={{ fontSize: 13 }}>{r.order}. {r.name} ({r.isSubject ? 'the employee' : r.roleLabel}) - {r.actionLabel}</div>)}
                </div>
                <div>
                  <div style={{ ...lbl, marginTop: 0 }}>The Change</div>
                  <div style={{ fontSize: 13 }}>{preview.fromTitle || '-'} to <b>{preview.toTitle}</b>, effective <b>{usDay(preview.effectiveDate)}</b></div>
                </div>
              </div>
              <div style={{ fontSize: 13, marginTop: 10, padding: '8px 11px', borderRadius: 10, background: 'var(--card)' }}>
                Nothing goes to {name} yet: the letter is generated from Documents, and <b>{preview.verifier?.name || 'HR'}</b> ({preview.verifier?.roleLabel || 'HR'}) checks it and sends it.
              </div>
              {(preview.signedPeriods || []).length > 0 && <Warn>Already signed for the new pay period: {preview.signedPeriods.map(p => p.label).join(', ')}. These will be flagged for HR to review - not repriced.</Warn>}
              {(preview.problems || []).map(p => <Problem key={p}>{p}</Problem>)}
            </div>
          )}
          {preview && !docsMode && (
            <div style={{ marginTop: 18, border: '1px solid var(--line)', borderRadius: 12, padding: '12px 14px', background: 'var(--mist)' }}>
              <div style={{ fontWeight: 800, fontSize: 13 }}>{preview.title}</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14, marginTop: 8 }}>
                <div>
                  <div style={{ ...lbl, marginTop: 0 }}>Signing Order</div>
                  {preview.recipients.map(r => <div key={`${r.order}-${r.email}`} style={{ fontSize: 13 }}>{r.order}. {r.who === 'employee' ? `${r.name} (${r.email})` : r.who === 'manager' ? `${r.name} (manager)` : `You (${r.role}) - countersign after them`}</div>)}
                </div>
                <div>
                  <div style={{ ...lbl, marginTop: 0 }}>The Change</div>
                  <div style={{ fontSize: 13 }}>{preview.fromTitle || '-'} to <b>{preview.toTitle}</b>, effective <b>{usDay(preview.effectiveDate)}</b>{preview.salaryText ? <> at <b>{preview.salaryText}</b></> : null}</div>
                  {preview.salaryText && preview.payInLetter === false && <Problem>This letter does not show pay - {preview.salaryText} will be set as their pay when they sign, but they will not read it in the documents. Add {'{{salary}}'} to the template under Documents &gt; Nexus Sign &gt; Templates, or leave pay blank.</Problem>}
                </div>
                <div>
                  <div style={{ ...lbl, marginTop: 0 }}>Filed In Egnyte</div>
                  <div style={{ fontSize: 13, display: 'flex', gap: 6 }}><FolderOpen size={13} style={{ flexShrink: 0, marginTop: 2, color: 'var(--muted)' }} />{name} &gt; {preview.egnyteSubfolder}</div>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13 }}>{name} gets the letter by email with a link to sign; their manager gets one after.</span>
                <button type="button" className="secondary-btn" style={{ fontSize: 12, padding: '3px 10px' }}
                  onClick={() => setMail({ event: 'promotion', entityId: preview.entityId, templateId: preview.templateId, note: preview.emailMessage || '' })}>Preview Email</button>
                <button type="button" className="secondary-btn" style={{ fontSize: 12, padding: '3px 10px' }}
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
    </Modal>
  );
}


// ── Offboard (Neil, Oct 8: 28:19 - 30:04) ────────────────────────────────────
// "it should very clearly say what company are they with, what is the
// off-boarding package". The last day decides where the paperwork goes
// (today = personal email, their access ends now; later = work email) and
// when they become Left (today = now; later = Nexus does it on the day).
// Labels per Charmi (Oct 20 2026); the stored keys stay as they were.
const EXIT_TYPES = [['resignation', 'Voluntary Resignation'], ['resignation_no_notice', 'Job Abandonment'],
  ['termination', 'Termination'], ['end_of_contract', 'End Of Contract'], ['retirement', 'Retirement'], ['death', 'Death']];

// Kept as a shared mailbox (Neil, 11/14/2026): Graph cannot convert a
// mailbox or grant access to it, so these are the Exchange steps IT runs by
// hand - the same ones Change Status shows - and the exit carries "Mailbox
// Handover Pending" until HR ticks them done.
const EXO_MAILBOXES = 'https://admin.exchange.microsoft.com/#/mailboxes';
export function MailboxHandoverSteps({ upn, trustees = [], nameOf = (x) => x, toastOk, toastErr }) {
  const script = ['Connect-ExchangeOnline', `Set-Mailbox -Identity ${upn || '<user-upn>'} -Type Shared`,
    ...trustees.map((t) => `Add-MailboxPermission -Identity ${upn || '<user-upn>'} -User ${t} -AccessRights FullAccess -AutoMapping $true`)].join('\n');
  const copy = () => navigator.clipboard?.writeText(script)
    .then(() => toastOk?.('PowerShell copied to clipboard.'))
    .catch(() => toastErr?.('Copy failed - select the text and copy it by hand.'));
  return (
    <div>
      <div style={{ fontSize: 13, lineHeight: 1.5 }}>
        Microsoft 365 cannot do this part by itself. In the Exchange admin center, convert the mailbox to a shared mailbox and give {trustees.length ? trustees.map(nameOf).join(', ') : 'the people you picked'} Full Access - or run the PowerShell below. Then tick Mailbox Handover done on the exit.
      </div>
      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', margin: '8px 0 6px', display: 'flex', alignItems: 'center', gap: 8 }}>
        Run in Exchange PowerShell
        <button type="button" className="secondary-btn" onClick={copy} style={{ padding: '2px 10px', fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 4 }}><FileText size={11} /> Copy</button>
      </div>
      <pre style={{ margin: 0, background: '#1e293b', color: '#e5e7eb', borderRadius: 8, padding: '10px 12px', fontSize: 11, lineHeight: 1.6, overflowX: 'auto', whiteSpace: 'pre', fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace' }}>{script}</pre>
      <a href={EXO_MAILBOXES} target="_blank" rel="noopener noreferrer" className="secondary-btn" style={{ marginTop: 8, fontSize: 12, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 10px' }}>Exchange Admin Center <ChevronRight size={12} /></a>
    </div>
  );
}

// Where a setting that names the leaver is changed, opened in a new tab so
// the Offboard sheet keeps what was typed.
const settingHref = (link) => `/${VIEW_TO_PATH[link?.view] || link?.view || ''}${link?.sub ? `/${link.sub}` : ''}`;

// `initial` ({ exit_type, reason }) prefills the form - End Employment on a
// probation opens this with Termination and the probation reason (Oct 27 2026).
export function OffboardModal({ employee: e, companyName, initial = null, onClose, onSent, toastErr }) {
  const { data: people = [] } = usePeopleDirectory();
  // The Last Day starts EMPTY (Neil, 11/14/2026): today is one tap, never
  // the default - a slip of the finger used to end someone's access.
  const [f, setF] = useState({ last_day: '', exit_type: initial?.exit_type || '', reason: initial?.reason || '', send_package: true, start_checklist: true });
  // Their direct reports, the settings that name them and the server's own
  // "today" (the business zone, not this computer's date).
  const [ctx, setCtx] = useState(null);
  useEffect(() => {
    let live = true;
    api.offboardContext(e.id).then((c) => { if (live) setCtx(c || {}); })
      .catch(() => { if (live) setCtx({ reports: [], rolesHeld: [], failed: true }); });
    return () => { live = false; };
  }, [e.id]);
  const [reportsTo, setReportsTo] = useState('');
  const [mailbox, setMailbox] = useState('remove');
  const [trustees, setTrustees] = useState(() => (e.managerEmail ? [e.managerEmail.toLowerCase()] : []));
  const [handoverTo, setHandoverTo] = useState('');
  const [includeCompleted, setIncludeCompleted] = useState(false);
  const [exportRequested, setExportRequested] = useState(false);
  const [extra, setExtra] = useState({});
  const [preview, setPreview] = useState(null);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState('');
  const [mail, setMail] = useState(null);
  const set = (k, v) => { setF(p => ({ ...p, [k]: v })); setPreview(null); };
  const name = [e.firstName, e.lastName].filter(Boolean).join(' ');
  const nameOf = em => people.find(p => p.email === em)?.name || em;
  const today = ctx?.today || todayIso();
  const immediate = !!f.last_day && f.last_day <= today;
  const reports = (ctx?.reports || []).filter(r => r.kind === 'manager');
  const covered = (ctx?.reports || []).filter(r => r.kind === 'backup');
  const needsManager = reports.length > 0 && !reportsTo;
  const body = () => ({
    inputs: { ...f, merge: extra, offboarding: { mailboxAction: mailbox, delegateTo: mailbox === 'share' ? trustees : [],
      exportRequested, handoverTo, handoverIncludeCompleted: includeCompleted, reportsTo } },
    excluded_ack: ack,
  });
  const missing = (preview?.unresolved || []).filter(k => !(extra[k] || '').trim());

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
  // Offboard Now (a last day of today) ends their access at once, so it is
  // held (Hold to confirm, Neil, Oct 30 2026); a refusal rewinds the button
  // with the reason, success hands the result on once the check has shown.
  // Schedule Offboarding stays a click - it can still be cancelled.
  const sent = useRef(null);
  async function goNow() {
    setBusy('send');
    try { sent.current = await api.offboard(e.id, { ...body(), excluded_ack: preview?.engine === 'documents' ? true : ack }); }
    catch (err) { setBusy(''); throw new Error(err?.message || 'Could not offboard.', { cause: err }); }
  }
  const radio = (val, label, sub) => (
    <label style={{ display: 'flex', gap: 10, padding: '9px 11px', borderRadius: 10, border: `1px solid ${mailbox === val ? 'var(--pine)' : 'var(--line)'}`, background: mailbox === val ? 'hsla(var(--color-green),0.06)' : 'transparent', cursor: 'pointer', marginBottom: 8 }}>
      <input type="radio" name="offMailbox" checked={mailbox === val} onChange={() => { setMailbox(val); setPreview(null); }} style={{ marginTop: 2 }} />
      <div><div style={{ fontSize: 13, fontWeight: 600 }}>{label}</div><div style={{ fontSize: 12, color: 'var(--muted)' }}>{sub}</div></div>
    </label>
  );
  return (
    <Modal title={`Offboard - ${name}`} onClose={onClose} zIndex={4100} isDirty={!!(f.exit_type || f.reason.trim()) && !busy}
      footer={<>
        <button className="secondary-btn" onClick={onClose} disabled={!!busy}>Cancel</button>
        {!preview ? (
          <button className="primary-btn" onClick={review} disabled={!!busy || !ctx || !f.last_day || !f.exit_type || (mailbox === 'share' && !trustees.length) || needsManager}
            title={!f.last_day ? 'Pick their last day first' : needsManager ? 'Pick who their direct reports report to' : undefined}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {busy === 'preview' ? <Spinner size={14} /> : <FileSignature size={14} />} Review
          </button>
        ) : preview.immediate ? (
          <HoldButton label="Offboard Now" doneLabel="Offboarded" icon={LogOut} holdMs={HOLD_MAJOR_MS}
            fallbackMessage={`Offboard ${name} now? Their access ends at once - Microsoft 365, Nexus and their phones.`}
            onConfirm={goNow} onDone={() => onSent(sent.current)}
            disabled={(!!busy && busy !== 'send') || (preview.package && preview.engine !== 'documents' && !ack) || missing.length > 0
              || (preview.engine === 'documents' && (preview.problems || []).length > 0)} />
        ) : (
          <button className="primary-btn" onClick={go}
            disabled={!!busy || (preview.package && preview.engine !== 'documents' && !ack) || missing.length > 0
              || (preview.engine === 'documents' && (preview.problems || []).length > 0)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {busy === 'send' ? <Spinner size={14} /> : <LogOut size={14} />} Schedule Offboarding
          </button>
        )}
      </>}>
        <div style={{ fontFamily: 'Inter,sans-serif' }}>
          <div style={{ fontSize: 13, color: 'var(--muted)' }}>{companyName || 'Their company'} · {e.jobTitle || 'No title'}</div>
          {/* One way to leave (Neil, 11/03/2026): Offboard is the only path to
              Left. The last day is the termination date on their record. */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))', gap: '0 14px' }}>
            <div><label style={lbl}>Last Day (Termination Date) *</label>
              <DateField value={f.last_day} onChange={v => set('last_day', v || '')} placeholder="MM/DD/YYYY" title="Last day" style={{ width: '100%' }} />
              <button type="button" className="secondary-btn" onClick={() => set('last_day', today)} disabled={!!busy}
                aria-pressed={f.last_day === today}
                style={{ marginTop: 6, fontSize: 12, padding: '4px 10px', display: 'inline-flex', alignItems: 'center', gap: 5, color: 'hsl(var(--color-red))' }}>
                <LogOut size={12} /> Today - Access Ends Now
              </button></div>
            <div><label style={lbl}>Why They Are Leaving *</label>
              <select className="form-input" style={{ width: '100%' }} value={f.exit_type} onChange={ev => set('exit_type', ev.target.value)}>
                <option value="">- pick one -</option>
                {EXIT_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select></div>
          </div>
          {f.last_day ? (
            <div style={{ marginTop: 10, borderRadius: 10, padding: '9px 12px', fontSize: 13,
              background: immediate ? 'hsla(var(--color-red),0.08)' : 'hsla(var(--color-blue),0.08)' }}>
              {immediate
                ? <>{f.last_day === today ? 'Today' : `${usDay(f.last_day)} is already past`}: their access ends as soon as you confirm, and the paperwork goes to their <b>personal email</b>{e.personalEmail ? ` (${e.personalEmail})` : ' - none on file yet'}.</>
                : <>They keep their access through {usDay(f.last_day)}; the morning after, Nexus marks them Left by itself. The paperwork goes to their <b>work email</b>{e.workEmail ? ` (${e.workEmail})` : ''} - if it is still unsigned when their account closes, it moves to their personal email. The offboarding checklist starts now.</>}
            </div>
          ) : <div style={hint}>Pick their last day. A day ahead keeps their access through it; today ends it as soon as you confirm.</div>}
          <label style={lbl}>Reason (kept on the record)</label>
          <input className="form-input" style={{ width: '100%' }} value={f.reason} onChange={ev => set('reason', ev.target.value)} placeholder="e.g. Moving out of state" />

          {/* Direct reports need a manager from the day they leave (Neil,
              11/14/2026): required when there are any; they move when the
              person becomes Left. */}
          {reports.length > 0 && (<>
            <label style={lbl}>Their Direct Reports Go To *</label>
            <div style={{ fontSize: 13, marginBottom: 6 }}>
              {reports.length} direct report{reports.length === 1 ? '' : 's'}: {reports.map(r => r.name).join(', ')}
            </div>
            {reportsTo ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>{nameOf(reportsTo)}
                <button type="button" className="secondary-btn" style={{ fontSize: 12, padding: '3px 10px' }} onClick={() => { setReportsTo(''); setPreview(null); }}>Change</button></div>
            ) : (
              <PersonSearchSelect placeholder="Who they report to from now on" groups={[{ label: 'Nexus People', people: people.filter(p => p.email !== (e.workEmail || '').toLowerCase()) }]}
                onPick={em => { setReportsTo(em || ''); setPreview(null); }} />
            )}
            <div style={hint}>Their Reports To changes when {e.firstName || 'they'} becomes Left.</div>
          </>)}
          {covered.length > 0 && (
            <div style={hint}>They are also the Backup Manager for {covered.map(r => r.name).join(', ')} - that goes back to the default backup when they leave.</div>
          )}
          {ctx?.failed && <Problem>Their direct reports could not be checked - close this and try again.</Problem>}

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
              <button type="button" className="secondary-btn" style={{ fontSize: 12, padding: '3px 10px' }} onClick={() => setHandoverTo('')}>Change</button></div>
          ) : (
            <PersonSearchSelect placeholder="Blank = their supervisor" groups={[{ label: 'Nexus People', people: people.filter(p => p.email !== (e.workEmail || '').toLowerCase()) }]}
              onPick={em => setHandoverTo(em || '')} />
          )}
          <div style={hint}>Their open tasks move to this person, in one project of their previously assigned tasks. Equipment they hold is returned and their future shifts come off the schedule.</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" checked={includeCompleted} onChange={ev => { setIncludeCompleted(ev.target.checked); setPreview(null); }} style={{ accentColor: 'var(--pine)' }} /> Include their completed tasks
            </label>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" checked={exportRequested} onChange={ev => setExportRequested(ev.target.checked)} style={{ accentColor: 'var(--pine)' }} /> Export their mailbox first
            </label>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" checked={f.start_checklist} onChange={ev => set('start_checklist', ev.target.checked)} style={{ accentColor: 'var(--pine)' }} /> Start the offboarding checklist
            </label>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" checked={f.send_package} onChange={ev => set('send_package', ev.target.checked)} style={{ accentColor: 'var(--pine)' }} /> Send the separation package through Nexus Sign
            </label>
          </div>

          {preview && (
            <div style={{ marginTop: 18, border: '1px solid var(--line)', borderRadius: 12, padding: '12px 14px', background: 'var(--mist)' }}>
              <div style={{ fontWeight: 800, fontSize: 13 }}>{preview.immediate ? `${name} leaves today` : `${name} leaves on ${usDay(preview.lastDay)}`}</div>
              {preview.package && preview.engine === 'documents' ? (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14, marginTop: 8 }}>
                    <div>
                      <div style={{ ...lbl, marginTop: 0 }}>Package</div>
                      {preview.documents.map((d, i) => <div key={i} style={{ fontSize: 13 }}>{i + 1}. {d}</div>)}
                      <div style={hint}>Goes to {preview.sendTo} - {preview.why}.</div>
                    </div>
                    <div>
                      <div style={{ ...lbl, marginTop: 0 }}>Signing Order</div>
                      {preview.recipients.map(r => <div key={`${r.order}-${r.email}`} style={{ fontSize: 13 }}>{r.order}. {r.name} ({r.isSubject ? 'leaving' : r.roleLabel}) - {r.actionLabel}</div>)}
                    </div>
                  </div>
                  <div style={{ fontSize: 13, marginTop: 10, padding: '8px 11px', borderRadius: 10, background: 'var(--card)' }}>
                    The offboarding goes ahead as set above. The package is generated from Documents and sent once <b>{preview.verifier?.name || 'HR'}</b> ({preview.verifier?.roleLabel || 'HR'}) has checked it.
                  </div>
                  {(preview.problems || []).map(p => <Problem key={p}>{p}</Problem>)}
                </>
              ) : preview.package ? (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14, marginTop: 8 }}>
                  <div>
                    <div style={{ ...lbl, marginTop: 0 }}>Package</div>
                    {preview.documents.map((d, i) => <div key={i} style={{ fontSize: 13 }}>{i + 1}. {d}</div>)}
                    <div style={hint}>Goes to {preview.sendTo} - {preview.why}.</div>
                    <button type="button" className="secondary-btn" style={{ fontSize: 12, padding: '3px 10px', marginTop: 6 }}
                      onClick={() => setMail({ event: 'separation', entityId: preview.entityId, templateId: preview.templateId, note: preview.emailMessage || '' })}>Preview Email</button>
                  </div>
                  <div>
                    <div style={{ ...lbl, marginTop: 0 }}>Signing Order</div>
                    {preview.recipients.map(r => <div key={`${r.order}-${r.email}`} style={{ fontSize: 13 }}>{r.order}. {r.isSubject ? name : r.role === 'manager' ? `${r.name} (manager)` : `You (${r.role}) - countersign after ${name}`}</div>)}
                  </div>
                  <div>
                    <div style={{ ...lbl, marginTop: 0 }}>Filed In Egnyte</div>
                    <div style={{ fontSize: 13, display: 'flex', gap: 6 }}><FolderOpen size={13} style={{ flexShrink: 0, marginTop: 2, color: 'var(--muted)' }} />{name} &gt; {preview.egnyteSubfolder}</div>
                  </div>
                </div>
              ) : <div style={{ fontSize: 13, marginTop: 6 }}>No paperwork - only the offboarding itself.</div>}
              {(preview.unresolved || []).length > 0 && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0 14px' }}>
                  {preview.unresolved.map(k => (
                    <div key={k}><label style={lbl}>{k.replace(/_/g, ' ')}</label>
                      <input className="form-input" style={{ width: '100%' }} value={extra[k] || ''} onChange={ev => setExtra(p => ({ ...p, [k]: ev.target.value }))} /></div>
                  ))}
                </div>
              )}
              {reportsTo && reports.length > 0 && (
                <div style={{ fontSize: 13, marginTop: 10 }}>
                  {reports.length} direct report{reports.length === 1 ? '' : 's'} will report to <b>{nameOf(reportsTo)}</b> {preview.immediate ? 'now' : `from ${usDay(preview.lastDay)}`}.
                </div>
              )}
              {mailbox === 'share' && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ ...lbl, marginTop: 0 }}>Shared Mailbox - Done By Hand</div>
                  <MailboxHandoverSteps upn={e.workEmail} trustees={trustees} nameOf={nameOf} toastErr={toastErr} />
                </div>
              )}
              {(ctx?.rolesHeld || []).length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ ...lbl, marginTop: 0 }}>Settings That Name Them</div>
                  <div style={hint}>Nexus does not change these by itself - open each and pick someone else.</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
                    {ctx.rolesHeld.map((r, i) => (
                      <div key={`${r.label}-${r.where}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, flexWrap: 'wrap' }}>
                        <span style={{ flex: 1, minWidth: 0 }}><b>{r.label}</b> - {r.where}</span>
                        <a href={settingHref(r.link)} target="_blank" rel="noopener noreferrer" className="secondary-btn"
                          style={{ fontSize: 12, padding: '3px 10px', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          Change It <ChevronRight size={12} />
                        </a>
                      </div>
                    ))}
                  </div>
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
    </Modal>
  );
}

// ── Change Last Day (Neil, 11/14/2026) ───────────────────────────────────────
// Moves a scheduled exit - its date, the checklist's due dates, the exit
// record - and never voids or re-sends the separation package. A day of
// today or earlier ends their access now, so it is held like Offboard Now.
export function ChangeLastDayModal({ employee: e, current = '', onClose, onDone, toastErr }) {
  const [day, setDay] = useState('');
  const [today, setToday] = useState(todayIso());
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    api.offboardContext(e.id).then((c) => { if (live && c?.today) setToday(c.today); }).catch(() => {});
    return () => { live = false; };
  }, [e.id]);
  const name = [e.firstName, e.lastName].filter(Boolean).join(' ') || 'them';
  const now = !!day && day <= today;
  async function save() {
    setBusy(true);
    try { onDone(await api.changeLastDay(e.id, day)); }
    catch (err) { toastErr?.(err?.message || 'Could not change the last day.'); setBusy(false); }
  }
  function endNow() {
    dialog.confirm(`End ${name}'s access now? Their last day becomes ${usDay(day)} and Nexus marks them Left at once - Microsoft 365, Nexus and their phones. The separation package is not sent again.`, {
      title: 'End Access Now?', hold: true, holdMs: HOLD_MAJOR_MS, confirmText: 'End Access Now', doneText: 'Offboarded',
      onConfirm: async () => {
        let out;
        try { out = await api.changeLastDay(e.id, day); }
        catch (err) { throw new Error(err?.message || 'Could not end their access.', { cause: err }); }
        onDone(out);
      },
    });
  }
  return (
    <Modal title={`Change Last Day - ${name}`} onClose={onClose} zIndex={4100} isDirty={!!day && !busy}
      footer={<>
        <button className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
        {now ? (
          <button className="primary-btn" onClick={endNow} disabled={busy || day === current}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <LogOut size={14} /> End Access Now
          </button>
        ) : (
          <button className="primary-btn" onClick={save} disabled={busy || !day || day === current}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {busy ? <Spinner size={14} /> : <CalendarClock size={14} />} Save Last Day
          </button>
        )}
      </>}>
      <div style={{ fontFamily: 'Inter,sans-serif' }}>
        <div style={{ fontSize: 13 }}>Their last day is <b>{current ? usDay(current) : '-'}</b>.</div>
        <label style={lbl}>New Last Day *</label>
        <DateField value={day} onChange={v => setDay(v || '')} placeholder="MM/DD/YYYY" title="New last day" style={{ width: '100%', maxWidth: 260 }} />
        <div>
          <button type="button" className="secondary-btn" onClick={() => setDay(today)} disabled={busy}
            style={{ marginTop: 6, fontSize: 12, padding: '4px 10px', display: 'inline-flex', alignItems: 'center', gap: 5, color: 'hsl(var(--color-red))' }}>
            <LogOut size={12} /> Today - Access Ends Now
          </button>
        </div>
        {now
          ? <div style={{ marginTop: 10, borderRadius: 10, padding: '9px 12px', fontSize: 13, background: 'hsla(var(--color-red),0.08)' }}>Their access ends as soon as you confirm.</div>
          : <div style={hint}>The checklist's due dates move with it. The separation package is not voided or sent again.</div>}
      </div>
    </Modal>
  );
}

// ── Send Separation Package (Neil, 11/14/2026) ───────────────────────────────
// For someone already Left (or an exit whose package was never sent or was
// declined, voided or expired): the package goes out by itself - their
// status and last day stay as they are. They sign first, the company
// countersigns after.
export function SeparationPackageModal({ employee: e, onClose, onSent, toastErr }) {
  const [exitType, setExitType] = useState('');
  const [preview, setPreview] = useState(null);
  const [extra, setExtra] = useState({});
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState('');
  const name = [e.firstName, e.lastName].filter(Boolean).join(' ') || 'them';
  const body = () => ({ inputs: { exit_type: exitType, merge: extra }, excluded_ack: ack });
  const missing = (preview?.unresolved || []).filter(k => !(extra[k] || '').trim());
  async function review() {
    setBusy('preview');
    try {
      const p = await api.previewSeparationPackage(e.id, body());
      setPreview(p);
      setExtra(prev => Object.fromEntries((p.unresolved || []).map(k => [k, prev[k] || ''])));
    } catch (err) { toastErr?.(err?.message || 'Could not prepare the package.'); }
    setBusy('');
  }
  async function send() {
    setBusy('send');
    try { onSent(await api.sendSeparationPackage(e.id, { ...body(), excluded_ack: preview?.engine === 'documents' ? true : ack })); }
    catch (err) { toastErr?.(err?.message || 'Could not send the package.'); setBusy(''); }
  }
  return (
    <Modal title={`Send Separation Package - ${name}`} onClose={onClose} zIndex={4100}
      footer={<>
        <button className="secondary-btn" onClick={onClose} disabled={!!busy}>Cancel</button>
        {!preview ? (
          <button className="primary-btn" onClick={review} disabled={!!busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {busy === 'preview' ? <Spinner size={14} /> : <FileSignature size={14} />} Review
          </button>
        ) : (
          <button className="primary-btn" onClick={send}
            disabled={!!busy || missing.length > 0 || (preview.engine !== 'documents' && !ack) || (preview.engine === 'documents' && (preview.problems || []).length > 0)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {busy === 'send' ? <Spinner size={14} /> : <Send size={14} />} Send Package
          </button>
        )}
      </>}>
      <div style={{ fontFamily: 'Inter,sans-serif' }}>
        <div style={{ fontSize: 13, lineHeight: 1.5 }}>Their status and last day stay as they are - only the paperwork goes out.</div>
        <label style={lbl}>Why They Left</label>
        <select className="form-input" style={{ width: '100%', maxWidth: 320 }} value={exitType} onChange={ev => { setExitType(ev.target.value); setPreview(null); }}>
          <option value="">As recorded on their exit</option>
          {EXIT_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        {preview && (
          <div style={{ marginTop: 16, border: '1px solid var(--line)', borderRadius: 12, padding: '12px 14px', background: 'var(--mist)' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
              <div>
                <div style={{ ...lbl, marginTop: 0 }}>Package</div>
                {(preview.documents || []).map((d, i) => <div key={i} style={{ fontSize: 13 }}>{i + 1}. {d}</div>)}
                <div style={hint}>Goes to {preview.sendTo} - {preview.why}.</div>
              </div>
              <div>
                <div style={{ ...lbl, marginTop: 0 }}>Signing Order</div>
                {(preview.recipients || []).map(r => <div key={`${r.order}-${r.email}`} style={{ fontSize: 13 }}>{r.order}. {r.isSubject ? name : r.role === 'manager' ? `${r.name} (manager)` : `${r.name || 'You'} - countersign after ${name}`}</div>)}
              </div>
            </div>
            {(preview.problems || []).map(p => <Problem key={p}>{p}</Problem>)}
            {(preview.unresolved || []).length > 0 && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0 14px' }}>
                {preview.unresolved.map(k => (
                  <div key={k}><label style={lbl}>{k.replace(/_/g, ' ')}</label>
                    <input className="form-input" style={{ width: '100%' }} value={extra[k] || ''} onChange={ev => setExtra(p => ({ ...p, [k]: ev.target.value }))} /></div>
                ))}
              </div>
            )}
            {preview.engine !== 'documents' && (
              <label style={{ display: 'flex', gap: 9, alignItems: 'flex-start', cursor: 'pointer', marginTop: 14 }}>
                <input type="checkbox" checked={ack} onChange={ev => setAck(ev.target.checked)} style={{ width: 15, height: 15, marginTop: 1, flexShrink: 0, accentColor: 'var(--pine)' }} />
                <span style={{ fontSize: 12, lineHeight: 1.5 }}>I confirm this is not a record that cannot be signed electronically.</span>
              </label>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

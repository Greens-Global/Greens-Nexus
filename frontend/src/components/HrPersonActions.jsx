// HR's actions on an employee (Neil, Oct 8 call): "After an employee is in,
// they're either moving up, they're changing a role, or they're leaving" -
// all from People, not Settings.
//
//   PromoteModal - Promote / Change Role: the new role, title, effective date
//                  (can be in the past), responsibilities and pay -> a preview
//                  of the letter's signing order -> sent through Nexus Sign:
//                  the employee signs, then the manager. When it is fully
//                  signed the role, access and pay change, and the letter is
//                  filed in their Egnyte folder (My HR > My Documents).
import { useEffect, useState } from 'react';
import { X, Send, FileSignature, FolderOpen, TrendingUp, ArrowRight, AlertTriangle, LogOut } from 'lucide-react';
import { api } from '../api';
import { Spinner } from './AsyncState';
import { usDay, EmailPreviewModal, Problem } from './HiringPacket';
import { usePeopleDirectory } from '../lib/queries';
import PersonSearchSelect from './PersonSearchSelect';

const lbl = { fontSize: 11, fontWeight: 700, color: 'var(--muted)', display: 'block', margin: '12px 0 4px', textTransform: 'uppercase', letterSpacing: '.04em' };
const hint = { fontSize: 11.5, color: 'var(--muted)', marginTop: 4, lineHeight: 1.5 };
const FREQUENCIES = [['annual', 'Per Year'], ['monthly', 'Per Month'], ['semimonthly', 'Twice A Month'], ['biweekly', 'Every Two Weeks'], ['weekly', 'Per Week']];
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

function Warn({ children }) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', background: 'hsla(var(--color-orange),0.1)', color: 'hsl(var(--color-orange))', borderRadius: 10, padding: '8px 12px', fontSize: 12, marginTop: 8 }}>
      <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} /><span>{children}</span>
    </div>
  );
}

export function PromoteModal({ employee: e, mode = 'promotion', canSeePay, onClose, onSent, toastErr }) {
  const [changeType, setChangeType] = useState(mode);
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
  const input = (label, key, props = {}) => (
    <div><label style={lbl}>{label}</label>
      <input className="form-input" style={{ width: '100%' }} value={f[key]} onChange={ev => set(key, ev.target.value)} {...props} /></div>
  );

  return (
    <div onClick={ev => ev.target === ev.currentTarget && onClose()}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1250, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: 'var(--card)', borderRadius: 16, width: '100%', maxWidth: 'clamp(560px, 64vw, 1000px)', maxHeight: 'min(92dvh, 840px)', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)', fontFamily: 'Inter,sans-serif' }}>
        <div style={{ padding: '16px 22px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <TrendingUp size={17} style={{ color: 'hsl(var(--color-green))' }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 800, fontSize: 15.5 }}>{changeType === 'promotion' ? 'Promote' : 'Change Role'} - {name}</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 1 }}>A letter through Nexus Sign: {name} signs, then their manager. It takes effect when both have signed.</div>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        <div style={{ overflowY: 'auto', flex: 1, padding: '6px 22px 18px' }}>
          <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
            {[['promotion', 'Promotion'], ['role_change', 'Role Change']].map(([k, l]) => (
              <button key={k} type="button" onClick={() => { setChangeType(k); setPreview(null); }}
                style={{ padding: '6px 14px', borderRadius: 999, fontSize: 12.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'Inter,sans-serif',
                  border: `1.5px solid ${changeType === k ? 'var(--pine)' : 'var(--line)'}`, background: changeType === k ? 'var(--pine)' : 'var(--card)', color: changeType === k ? '#fff' : 'var(--ink)' }}>{l}</button>
            ))}
          </div>
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
            {input('Effective Date *', 'effective_date', { type: 'date' })}
          </div>
          {past && <Warn>The effective date is in the past. Pay is dated from it; any timesheet from then that is already signed is flagged for HR to review, not changed.</Warn>}
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
                  <option value="USD">USD</option><option value="INR">INR</option>
                </select></div>
            </div>
          ) : (
            <>{input('Pay As Written In The Letter', 'salary_text', { placeholder: 'e.g. $95,000 per year, or "unchanged"' })}
              <div style={hint}>Pay & Benefits access is needed to change their payroll rate.</div></>
          )}
          {input('Reason (kept on the record)', 'reason', { placeholder: 'e.g. Annual review - exceeded targets' })}

          {preview && (
            <div style={{ marginTop: 18, border: '1px solid var(--line)', borderRadius: 12, padding: '12px 14px', background: 'var(--mist)' }}>
              <div style={{ fontWeight: 800, fontSize: 13.5 }}>{preview.title}</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14, marginTop: 8 }}>
                <div>
                  <div style={{ ...lbl, marginTop: 0 }}>Signing Order</div>
                  {preview.recipients.map(r => <div key={`${r.order}-${r.email}`} style={{ fontSize: 12.5 }}>{r.order}. {r.who === 'employee' ? `${r.name} (${r.email})` : r.who === 'manager' ? `${r.name} (manager)` : `You (${r.role}) - sign now`}</div>)}
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
            <button className="primary-btn" onClick={review} disabled={!!busy || !f.role_id || !f.effective_date} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {busy === 'preview' ? <Spinner size={14} /> : <FileSignature size={14} />} Review Letter
            </button>
          ) : (
            <button className="primary-btn" onClick={send} disabled={!!busy || !ack || missing.length > 0} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {busy === 'send' ? <Spinner size={14} /> : <Send size={14} />} Send For Signature
            </button>
          )}
        </div>
      </div>
    </div>
  );
}


// ── Offboard (Neil, Oct 8: 28:19 - 30:04) ────────────────────────────────────
// "it should very clearly say what company are they with, what is the
// off-boarding package". The last day decides where the paperwork goes
// (today = personal email, their access ends now; later = work email) and
// when they become Left (today = now; later = Nexus does it on the day).
const EXIT_TYPES = [['resignation', 'Resignation'], ['resignation_no_notice', 'Resignation Without Notice'],
  ['termination', 'Termination'], ['end_of_contract', 'End Of Contract'], ['retirement', 'Retirement'], ['death', 'Death']];

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
  const set = (k, v) => { setF(p => ({ ...p, [k]: v })); setPreview(null); };
  const name = [e.firstName, e.lastName].filter(Boolean).join(' ');
  const nameOf = em => people.find(p => p.email === em)?.name || em;
  const immediate = f.last_day && f.last_day <= todayIso();
  const body = () => ({
    inputs: { ...f, merge: extra, offboarding: { mailboxAction: mailbox, delegateTo: mailbox === 'share' ? trustees : [],
      exportRequested, handoverTo } },
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
    try { onSent(await api.offboard(e.id, body())); }
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
      <div style={{ background: 'var(--card)', borderRadius: 16, width: '100%', maxWidth: 'clamp(560px, 62vw, 960px)', maxHeight: 'min(92dvh, 860px)', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)', fontFamily: 'Inter,sans-serif' }}>
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
              <input type="date" className="form-input" style={{ width: '100%' }} value={f.last_day} onChange={ev => set('last_day', ev.target.value)} /></div>
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
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, cursor: 'pointer' }}>
              <input type="checkbox" checked={f.send_package} onChange={ev => set('send_package', ev.target.checked)} style={{ accentColor: 'var(--pine)' }} /> Send the separation package through Nexus Sign
            </label>
          </div>

          {preview && (
            <div style={{ marginTop: 18, border: '1px solid var(--line)', borderRadius: 12, padding: '12px 14px', background: 'var(--mist)' }}>
              <div style={{ fontWeight: 800, fontSize: 13.5 }}>{preview.immediate ? `${name} leaves today` : `${name} leaves on ${usDay(preview.lastDay)}`}</div>
              {preview.package ? (
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
                    {preview.recipients.map(r => <div key={`${r.order}-${r.email}`} style={{ fontSize: 12.5 }}>{r.order}. {r.isSubject ? name : r.role === 'manager' ? `${r.name} (manager)` : `You (${r.role}) - sign now`}</div>)}
                  </div>
                  <div>
                    <div style={{ ...lbl, marginTop: 0 }}>Filed In Egnyte</div>
                    <div style={{ fontSize: 12.5, display: 'flex', gap: 6 }}><FolderOpen size={13} style={{ flexShrink: 0, marginTop: 2, color: 'var(--muted)' }} />{name} &gt; {preview.egnyteSubfolder}</div>
                  </div>
                </div>
              ) : <div style={{ fontSize: 12.5, marginTop: 6 }}>No paperwork - only the offboarding itself.</div>}
              {(preview.unresolved || []).length > 0 && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0 14px' }}>
                  {preview.unresolved.map(k => (
                    <div key={k}><label style={lbl}>{k.replace(/_/g, ' ')}</label>
                      <input className="form-input" style={{ width: '100%' }} value={extra[k] || ''} onChange={ev => setExtra(p => ({ ...p, [k]: ev.target.value }))} /></div>
                  ))}
                </div>
              )}
              {preview.package && (
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
            <button className="primary-btn" onClick={review} disabled={!!busy || !f.last_day || !f.exit_type || (mailbox === 'share' && !trustees.length)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {busy === 'preview' ? <Spinner size={14} /> : <FileSignature size={14} />} Review
            </button>
          ) : (
            <button className="primary-btn" onClick={go} disabled={!!busy || (preview.package && !ack) || missing.length > 0}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: preview.immediate ? 'hsl(var(--color-red))' : undefined }}>
              {busy === 'send' ? <Spinner size={14} /> : <LogOut size={14} />} {preview.immediate ? 'Offboard Now' : 'Schedule Offboarding'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

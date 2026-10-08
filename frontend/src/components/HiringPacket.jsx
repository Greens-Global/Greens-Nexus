// Hiring packet through Nexus Sign (Neil/Pranshu call, Oct 8).
//
//   PacketsModal         - Hiring > Packets: which Nexus Sign template (the
//                          company's merged PDFs) each company sends, the
//                          welcome note, and the Egnyte subfolder it is filed in
//   SendHiringPacketModal - Offer stage: the offer details -> a preview of
//                          exactly what goes out -> send; HR signs right away
//   HiringPacketStatus   - the packet on a candidate: who has signed, sign
//                          now, void, and where it was filed
//   PacketSigner         - full-screen Nexus Sign view for HR's own signature
//
// The server (backend/hr_life_events.py) does the work: it hires the person
// when the packet is fully signed and files it in their Egnyte folder - the
// folder My HR > My Documents already shows them.
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Send, FileSignature, RefreshCw, Ban, FolderOpen, CheckCircle, Clock, AlertTriangle, Plus, Trash2 } from 'lucide-react';
import { api } from '../api';
import { dialog } from '../ui/dialog';
import { formatDateTime } from '../lib/datetime';
import { usePeopleDirectory } from '../lib/queries';
import { Spinner } from './AsyncState';
import PersonSearchSelect from './PersonSearchSelect';
import { SignModal } from './ESign';

const ENABLED_EVENTS = ['hire'];      // promotion / separation arrive with their screens
const WORKER_LABEL = { any: 'Everyone', employee: 'Employees Only', contractor: 'Contractors Only' };
const EMPLOYMENT_TYPES = [['full_time', 'Full-Time'], ['part_time', 'Part-Time'], ['contractor', 'Contractor'], ['intern', 'Intern']];
const FREQUENCIES = [['annual', 'Per Year'], ['monthly', 'Per Month'], ['semimonthly', 'Twice A Month'], ['biweekly', 'Every Two Weeks'], ['weekly', 'Per Week']];

const lbl = { fontSize: 11, fontWeight: 700, color: 'var(--muted)', display: 'block', margin: '12px 0 4px', textTransform: 'uppercase', letterSpacing: '.04em' };
const hint = { fontSize: 11.5, color: 'var(--muted)', marginTop: 4, lineHeight: 1.5 };

// 'YYYY-MM-DD' -> 'MM/DD/YYYY' without a timezone shift (a date-only string
// parsed as a Date is UTC midnight - the day before in the US).
export function usDay(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  return m ? `${m[2]}/${m[3]}/${m[1]}` : (iso || '');
}

const Overlay = ({ children, onClose, wide }) => (
  <div onClick={e => e.target === e.currentTarget && onClose()}
    style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1250, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
    <div style={{ background: 'var(--card)', borderRadius: 16, width: '100%', maxWidth: wide ? 'clamp(680px, 70vw, 1080px)' : 'clamp(520px, 60vw, 860px)', maxHeight: 'min(92dvh, 820px)', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)', fontFamily: 'Inter,sans-serif' }}>
      {children}
    </div>
  </div>
);
const Head = ({ title, sub, onClose }) => (
  <div style={{ padding: '16px 22px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontWeight: 800, fontSize: 15.5 }}>{title}</div>
      {sub && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 1 }}>{sub}</div>}
    </div>
    <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
  </div>
);
const Problem = ({ children }) => (
  <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', background: 'hsla(var(--color-orange),0.1)', color: 'hsl(var(--color-orange))', borderRadius: 10, padding: '8px 12px', fontSize: 12, marginTop: 8 }}>
    <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} /><span>{children}</span>
  </div>
);

// ── Status chips ─────────────────────────────────────────────────────────────
const EVENT_STATUS = {
  awaiting_sender: ['Awaiting Your Signature', 'orange'],
  sent:            ['Waiting On The New Hire', 'blue'],
  completed:       ['Fully Signed', 'green'],
  declined:        ['Declined', 'red'],
  voided:          ['Voided', 'gray'],
  expired:         ['Expired', 'gray'],
};
const PARTY_STATUS = { waiting: 'Not Yet', notified: 'Invited', viewed: 'Opened', signed: 'Signed', declined: 'Declined' };
function StatusChip({ label, tone }) {
  const bg = tone === 'gray' ? 'var(--mist)' : `hsla(var(--color-${tone}),0.12)`;
  const fg = tone === 'gray' ? 'var(--muted)' : `hsl(var(--color-${tone}))`;
  return <span style={{ padding: '3px 10px', borderRadius: 12, fontSize: 11, fontWeight: 700, background: bg, color: fg, whiteSpace: 'nowrap' }}>{label}</span>;
}

// ── HR's own signature, full screen (same as the timesheet review) ───────────
export function PacketSigner({ partyId, onClose, onDone, toastOk, toastErr }) {
  if (!partyId) return null;
  return createPortal(
    <div style={{ position: 'fixed', inset: 0, zIndex: 4000, background: 'var(--bg, #f4f5f7)', display: 'flex', flexDirection: 'column' }}>
      <SignModal partyId={partyId} onClose={onClose} onDone={onDone}
        toastOk={toastOk || (() => {})} toastErr={toastErr || (() => {})} />
    </div>, document.body);
}

// ── Hiring > Packets ─────────────────────────────────────────────────────────
function PacketRow({ row, templates, companyId, onSaved, onRemoved, toastErr }) {
  const [f, setF] = useState({
    template_id: row.templateId || '', subject_role: row.subjectRole || 'employee',
    email_message: row.emailMessage || '', egnyte_subfolder: row.egnyteSubfolder || '',
  });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  const choices = templates.filter(t => !t.entityId || t.entityId === companyId);
  const tpl = choices.find(t => t.id === f.template_id);
  const roles = tpl?.roles || [];
  const dirty = f.template_id !== (row.templateId || '') || f.subject_role !== (row.subjectRole || 'employee')
    || f.email_message !== (row.emailMessage || '') || f.egnyte_subfolder !== (row.egnyteSubfolder || '');

  async function save() {
    setBusy(true);
    try {
      onSaved(await api.savePacket({ entity_id: companyId, event: row.event, worker_type: row.workerType, ...f }));
    } catch (e) { toastErr(e?.message || 'Could not save the packet.'); }
    setBusy(false);
  }
  async function remove() {
    if (row.id && !await dialog.confirm('Remove this packet setting?', { title: 'Remove Packet', confirmText: 'Remove' })) return;
    setBusy(true);
    try { if (row.id) await api.deletePacket(row.id); onRemoved(row); }
    catch (e) { toastErr(e?.message || 'Could not remove it.'); setBusy(false); }
  }

  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 12, padding: '12px 14px', marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <b style={{ fontSize: 13 }}>{WORKER_LABEL[row.workerType]}</b>
        {!row.id && <StatusChip label="Not Saved" tone="gray" />}
        <span style={{ flex: 1 }} />
        <button className="secondary-btn" onClick={remove} disabled={busy} style={{ fontSize: 11.5, padding: '4px 10px', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <Trash2 size={12} /> Remove
        </button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,2fr) minmax(0,1fr)', gap: 12 }}>
        <div>
          <label style={lbl}>Nexus Sign Template</label>
          <select className="form-input" style={{ width: '100%' }} value={f.template_id}
            onChange={e => { const t = choices.find(x => x.id === e.target.value); set('template_id', e.target.value);
              const keys = (t?.roles || []).map(r => r.key);
              if (keys.length && !keys.includes(f.subject_role)) set('subject_role', keys.includes('employee') ? 'employee' : keys[keys.length - 1]); }}>
            <option value="">- pick a template -</option>
            {choices.map(t => <option key={t.id} value={t.id}>{t.name}{t.documents > 1 ? ` (${t.documents} documents)` : ''}</option>)}
          </select>
          <div style={hint}>The template holds the merged PDFs and where each person signs - build it in Documents &gt; Nexus Sign &gt; Templates.</div>
        </div>
        <div>
          <label style={lbl}>The New Hire Signs As</label>
          <select className="form-input" style={{ width: '100%' }} value={f.subject_role} onChange={e => set('subject_role', e.target.value)} disabled={!roles.length}>
            {(roles.length ? roles : [{ key: f.subject_role, label: f.subject_role }]).map(r =>
              <option key={r.key} value={r.key}>{r.label || r.key}</option>)}
          </select>
          <div style={hint}>You sign every other role when you send, so the new hire signs last.</div>
        </div>
      </div>
      <label style={lbl}>Welcome Note In The Email</label>
      <textarea className="form-input" rows={3} style={{ width: '100%', resize: 'vertical', fontFamily: 'Inter,sans-serif', fontSize: 13 }}
        placeholder="Welcome to the team! Please review and sign your offer letter and onboarding documents."
        value={f.email_message} onChange={e => set('email_message', e.target.value)} />
      <label style={lbl}>Egnyte Subfolder</label>
      <input className="form-input" style={{ width: '100%' }} value={f.egnyte_subfolder} onChange={e => set('egnyte_subfolder', e.target.value)}
        placeholder={row.defaultSubfolder || 'Hiring Documents'} />
      <div style={hint}>Inside the new hire's own folder (Human Resources &gt; Employees &gt; their name), which they see in My HR &gt; My Documents. Blank uses "{row.defaultSubfolder || 'Hiring Documents'}".</div>
      {(row.problems || []).map(p => <Problem key={p}>{p}</Problem>)}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
        <button className="primary-btn" onClick={save} disabled={busy || !f.template_id || (!dirty && row.id)}
          style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {busy ? <Spinner size={13} /> : <CheckCircle size={13} />} Save
        </button>
      </div>
    </div>
  );
}

export function PacketsModal({ onClose, toastOk, toastErr }) {
  const [data, setData] = useState(null);
  const [entities, setEntities] = useState([]);
  const [companyId, setCompanyId] = useState('');
  const [drafts, setDrafts] = useState([]);       // unsaved rows the user added
  const load = () => api.getPackets().then(setData).catch(e => { toastErr(e?.message || 'Could not load packets.'); onClose(); });
  useEffect(() => { load(); api.getEntities().then(setEntities).catch(() => {}); }, []);

  const events = (data?.events || []).filter(e => ENABLED_EVENTS.includes(e.key));
  const rowsFor = (ev) => {
    const saved = (data?.settings || []).filter(s => (s.entityId || '') === companyId && s.event === ev.key)
      .map(s => ({ ...s, defaultSubfolder: ev.defaultSubfolder }));
    const extra = drafts.filter(d => d.event === ev.key && !saved.some(s => s.workerType === d.workerType));
    return [...saved, ...extra];
  };
  const inherited = (ev) => companyId && (data?.settings || []).filter(s => !s.entityId && s.event === ev.key);
  const addRow = (ev, wt) => setDrafts(p => [...p, { event: ev.key, workerType: wt, defaultSubfolder: ev.defaultSubfolder, problems: [] }]);
  const company = companyId ? (entities.find(e => e.id === companyId)?.name || 'This company') : 'Every company';

  return (
    <Overlay onClose={onClose} wide>
      <Head title="Packets" sub="What each company sends through Nexus Sign when someone is hired" onClose={onClose} />
      <div style={{ overflowY: 'auto', flex: 1, padding: '14px 22px 22px' }}>
        {!data ? <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}><Spinner size="section" /></div> : (
          <>
            <label style={{ ...lbl, marginTop: 0 }}>Company</label>
            <select className="form-input" style={{ width: '100%', maxWidth: 360 }} value={companyId} onChange={e => { setCompanyId(e.target.value); setDrafts([]); }}>
              <option value="">Default (Every Company)</option>
              {entities.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
            <div style={hint}>A company without its own packet uses the default. Add a separate packet for contractors when they sign different documents.</div>
            {events.map(ev => {
              const rows = rowsFor(ev);
              const inh = inherited(ev) || [];
              const missing = ['any', 'employee', 'contractor'].filter(wt => !rows.some(r => r.workerType === wt));
              return (
                <div key={ev.key} style={{ marginTop: 18 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <FileSignature size={15} style={{ color: 'var(--muted)' }} />
                    <b style={{ fontSize: 14 }}>{ev.label}</b>
                    <span style={{ fontSize: 12, color: 'var(--muted)' }}>- {company}</span>
                  </div>
                  {rows.length === 0 && (
                    <div style={{ fontSize: 12.5, color: 'var(--muted)', border: '1px dashed var(--line)', borderRadius: 12, padding: '12px 14px', marginBottom: 10 }}>
                      {inh.length ? `Uses the default: ${inh.map(s => `${s.templateName} (${WORKER_LABEL[s.workerType]})`).join(', ')}.`
                        : companyId ? 'No packet yet - this company cannot send a hiring packet until one is set here or as the default.'
                          : 'No default packet yet.'}
                    </div>
                  )}
                  {rows.map(r => (
                    <PacketRow key={`${companyId}-${r.event}-${r.workerType}-${r.id || 'new'}`} row={r} templates={data.templates} companyId={companyId} toastErr={toastErr}
                      onSaved={() => { setDrafts(p => p.filter(d => !(d.event === r.event && d.workerType === r.workerType))); load(); toastOk('Packet saved.'); }}
                      onRemoved={() => { setDrafts(p => p.filter(d => !(d.event === r.event && d.workerType === r.workerType))); load(); }} />
                  ))}
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {missing.map(wt => (
                      <button key={wt} className="secondary-btn" onClick={() => addRow(ev, wt)}
                        style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                        <Plus size={12} /> {wt === 'any' ? 'Packet For Everyone' : `Packet For ${WORKER_LABEL[wt].replace(' Only', '')}`}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </>
        )}
      </div>
    </Overlay>
  );
}

// ── Offer stage: send the hiring packet ──────────────────────────────────────
export function SendHiringPacketModal({ candidate: c, canSeePay, onClose, onSent, toastErr }) {
  const { data: people = [] } = usePeopleDirectory();
  const [f, setF] = useState({
    job_title: c.roleTitle || '', department: c.department || '', start_date: (c.expectedStart || '').slice(0, 10),
    manager_email: '', employment_type: 'full_time', salary_text: '',
  });
  const [pay, setPay] = useState({ base: '', payBasis: 'salary', frequency: 'annual', currency: 'USD' });
  const [extra, setExtra] = useState({});          // fields the template needs that Nexus can't fill
  const [preview, setPreview] = useState(null);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState('');
  const set = (k, v) => { setF(p => ({ ...p, [k]: v })); setPreview(null); };
  const setP = (k, v) => { setPay(p => ({ ...p, [k]: v })); setPreview(null); };
  const manager = people.find(p => p.email === f.manager_email);
  const body = () => ({
    inputs: { ...f, merge: extra },
    pay: canSeePay && String(pay.base).trim() ? { ...pay, base: Number(pay.base) } : null,
    excluded_ack: ack,
  });
  const missing = (preview?.unresolved || []).filter(k => !(extra[k] || '').trim());

  async function review() {
    setBusy('preview');
    try {
      const p = await api.previewHiringPacket(c.id, body());
      setPreview(p);
      setExtra(prev => Object.fromEntries((p.unresolved || []).map(k => [k, prev[k] || ''])));
    } catch (e) { toastErr(e?.message || 'Could not build the packet.'); }
    setBusy('');
  }
  // A filled-in extra field is re-checked on the next review; the send
  // re-validates everything server-side either way.
  async function send() {
    setBusy('send');
    try { onSent(await api.sendHiringPacket(c.id, body())); }
    catch (e) { toastErr(e?.message || 'Could not send the packet.'); setBusy(''); }
  }

  const name = [c.firstName, c.lastName].filter(Boolean).join(' ');
  const input = (label, key, props = {}) => (
    <div><label style={lbl}>{label}</label>
      <input className="form-input" style={{ width: '100%' }} value={f[key]} onChange={e => set(key, e.target.value)} {...props} /></div>
  );
  return (
    <Overlay onClose={onClose} wide>
      <Head title={`Send Hiring Packet - ${name}`} sub={`Goes to ${c.email || 'their personal email'}. You sign first, then ${c.firstName || 'they'} signs.`} onClose={onClose} />
      <div style={{ overflowY: 'auto', flex: 1, padding: '6px 22px 18px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0 14px' }}>
          {input('Job Title *', 'job_title')}
          {input('Department', 'department')}
          {input('Start Date *', 'start_date', { type: 'date' })}
          <div><label style={lbl}>Employment Type</label>
            <select className="form-input" style={{ width: '100%' }} value={f.employment_type} onChange={e => set('employment_type', e.target.value)}>
              {EMPLOYMENT_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select></div>
          <div style={{ gridColumn: '1 / -1' }}><label style={lbl}>Supervisor</label>
            {manager ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{manager.name || manager.email}</span>
                <button type="button" className="secondary-btn" style={{ fontSize: 11.5, padding: '3px 10px' }} onClick={() => set('manager_email', '')}>Change</button>
              </div>
            ) : (
              <PersonSearchSelect placeholder="Type a name or email" groups={[{ label: 'Nexus People', people }]} onPick={v => set('manager_email', v)} />
            )}
          </div>
        </div>
        {canSeePay ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '0 14px' }}>
            <div><label style={lbl}>Pay</label>
              <input className="form-input" type="number" min="0" step="0.01" style={{ width: '100%' }} value={pay.base} onChange={e => setP('base', e.target.value)} placeholder="0.00" /></div>
            <div><label style={lbl}>Paid</label>
              <select className="form-input" style={{ width: '100%' }} value={pay.payBasis} onChange={e => setP('payBasis', e.target.value)}>
                <option value="salary">Salary</option><option value="hourly">Hourly</option>
              </select></div>
            {pay.payBasis === 'salary' && (
              <div><label style={lbl}>Frequency</label>
                <select className="form-input" style={{ width: '100%' }} value={pay.frequency} onChange={e => setP('frequency', e.target.value)}>
                  {FREQUENCIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select></div>
            )}
            <div><label style={lbl}>Currency</label>
              <select className="form-input" style={{ width: '100%' }} value={pay.currency} onChange={e => setP('currency', e.target.value)}>
                <option value="USD">USD</option><option value="INR">INR</option>
              </select></div>
            <div style={{ gridColumn: '1 / -1', ...hint }}>Printed in the offer letter and set as their pay from the start date once they sign.</div>
          </div>
        ) : (
          <>{input('Pay As Written In The Letter', 'salary_text', { placeholder: 'e.g. $85,000 per year' })}
            <div style={hint}>Pay & Benefits access is needed to set their payroll rate - HR can add it on their profile after they sign.</div></>
        )}

        {preview && (
          <div style={{ marginTop: 18, border: '1px solid var(--line)', borderRadius: 12, padding: '12px 14px', background: 'var(--mist)' }}>
            <div style={{ fontWeight: 800, fontSize: 13.5 }}>{preview.title}</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14, marginTop: 8 }}>
              <div>
                <div style={{ ...lbl, marginTop: 0 }}>Documents</div>
                {preview.documents.map((d, i) => <div key={i} style={{ fontSize: 12.5 }}>{i + 1}. {d}</div>)}
              </div>
              <div>
                <div style={{ ...lbl, marginTop: 0 }}>Signing Order</div>
                {preview.recipients.map(r => (
                  <div key={`${r.order}-${r.email}`} style={{ fontSize: 12.5 }}>
                    {r.order}. {r.isSubject ? `${r.name} (${r.email})` : `You (${r.role})`}{r.isSubject ? '' : ' - signs now'}
                  </div>
                ))}
              </div>
              <div>
                <div style={{ ...lbl, marginTop: 0 }}>Filed In Egnyte</div>
                <div style={{ fontSize: 12.5, display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                  <FolderOpen size={13} style={{ flexShrink: 0, marginTop: 2, color: 'var(--muted)' }} />
                  <span>{preview.company} &gt; Human Resources &gt; {f.employment_type === 'contractor' ? 'Contractors' : 'Employees'} &gt; {name} &gt; {preview.egnyteSubfolder}</span>
                </div>
              </div>
            </div>
            <div style={{ fontSize: 12.5, marginTop: 10 }}>
              Starts <b>{usDay(preview.startDate)}</b>{preview.salaryText ? <> at <b>{preview.salaryText}</b></> : null}.
            </div>
            {preview.emailMessage && <div style={{ fontSize: 12.5, marginTop: 8, fontStyle: 'italic' }}>"{preview.emailMessage}"</div>}
            {(preview.unresolved || []).length > 0 && (
              <div style={{ marginTop: 10 }}>
                <Problem>The template needs a few more details Nexus doesn't have.</Problem>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0 14px' }}>
                  {preview.unresolved.map(k => (
                    <div key={k}><label style={lbl}>{k.replace(/_/g, ' ')}</label>
                      <input className="form-input" style={{ width: '100%' }} value={extra[k] || ''} onChange={e => setExtra(p => ({ ...p, [k]: e.target.value }))} /></div>
                  ))}
                </div>
              </div>
            )}
            <label style={{ display: 'flex', gap: 9, alignItems: 'flex-start', cursor: 'pointer', marginTop: 14 }}>
              <input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)}
                style={{ width: 15, height: 15, marginTop: 1, flexShrink: 0, accentColor: 'var(--pine)' }} />
              <span style={{ fontSize: 12, lineHeight: 1.5 }}>I confirm this is not a record that cannot be signed electronically.</span>
            </label>
          </div>
        )}
      </div>
      <div style={{ padding: '12px 22px', borderTop: '1px solid var(--line)', display: 'flex', gap: 10, justifyContent: 'flex-end', flexShrink: 0 }}>
        <button className="secondary-btn" onClick={onClose} disabled={!!busy}>Cancel</button>
        {!preview ? (
          <button className="primary-btn" onClick={review} disabled={!!busy || !f.job_title.trim() || !f.start_date}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {busy === 'preview' ? <Spinner size={14} /> : <FileSignature size={14} />} Review Packet
          </button>
        ) : (
          <button className="primary-btn" onClick={send} disabled={!!busy || !ack || missing.length > 0}
            title={missing.length ? 'Fill in the missing details first' : !ack ? 'Confirm the document type first' : ''}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {busy === 'send' ? <Spinner size={14} /> : <Send size={14} />} Send And Sign
          </button>
        )}
      </div>
    </Overlay>
  );
}

// ── The packet on a candidate ────────────────────────────────────────────────
export function HiringPacketStatus({ candidateId, refreshKey, onSignNow, onChanged, onEvents, toastOk, toastErr }) {
  const [events, setEvents] = useState(null);
  const [busy, setBusy] = useState('');
  const load = () => api.getLifeEvents({ candidateId })
    .then(rows => { setEvents(rows); onEvents?.(rows); })
    .catch(() => { setEvents([]); onEvents?.([]); });
  useEffect(() => { load(); }, [candidateId, refreshKey]);
  const ev = useMemo(() => (events || []).find(e => e.kind === 'hire') || null, [events]);
  if (events === null) return <div style={{ padding: '8px 0' }}><Spinner size={16} /></div>;
  if (!ev) return null;

  const [label, tone] = EVENT_STATUS[ev.status] || [ev.status, 'gray'];
  async function act(kind) {
    if (kind === 'void' && !await dialog.confirm('Void this hiring packet? The new hire can no longer sign it.', { title: 'Void Packet', confirmText: 'Void' })) return;
    setBusy(kind);
    try {
      if (kind === 'void') { await api.voidLifeEvent(ev.id); toastOk('Packet voided.'); }
      else { const out = await api.retryLifeEventFiling(ev.id); toastOk(out.filingStatus === 'filed' ? 'Filed in Egnyte.' : 'Still not filed - see the reason below.'); }
      await load(); onChanged?.();
    } catch (e) { toastErr(e?.message || 'That did not work.'); }
    setBusy('');
  }
  return (
    <div style={{ marginTop: 14, border: '1px solid var(--line)', borderRadius: 12, padding: '12px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <FileSignature size={14} style={{ color: 'var(--muted)' }} />
        <b style={{ fontSize: 13 }}>Hiring Packet</b>
        <StatusChip label={label} tone={tone} />
        <span style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--muted)' }}>Sent {formatDateTime(ev.createdAt)}</span>
      </div>
      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {ev.parties.map(p => (
          <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
            {p.status === 'signed' ? <CheckCircle size={13} style={{ color: 'hsl(var(--color-green))' }} /> : <Clock size={13} style={{ color: 'var(--muted)' }} />}
            <span style={{ flex: 1 }}>{p.order}. {p.name}{p.isSubject ? '' : ' (company)'}</span>
            <span style={{ color: 'var(--muted)' }}>{p.status === 'signed' && p.signedAt ? `Signed ${formatDateTime(p.signedAt)}` : (PARTY_STATUS[p.status] || p.status)}</span>
          </div>
        ))}
      </div>
      {ev.status === 'declined' && ev.declineReason && <Problem>Declined: {ev.declineReason}</Problem>}
      {ev.status === 'completed' && (
        <div style={{ marginTop: 8, fontSize: 12, display: 'flex', gap: 6, alignItems: 'flex-start',
          color: ev.filingStatus === 'filed' ? 'hsl(var(--color-green))' : ev.filingStatus === 'failed' ? 'hsl(var(--color-red))' : 'var(--muted)' }}>
          <FolderOpen size={13} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>{ev.filingStatus === 'filed' ? `Filed in Egnyte: ${ev.filingPath}`
            : ev.filingStatus === 'failed' ? `Not filed in Egnyte: ${ev.filingError}`
              : `Filing in Egnyte${ev.filingError ? ` - last try: ${ev.filingError}` : '...'}`}</span>
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
        {ev.senderPartyId && (
          <button className="primary-btn" onClick={() => onSignNow(ev.senderPartyId)} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <FileSignature size={12} /> Sign Now
          </button>
        )}
        {['awaiting_sender', 'sent'].includes(ev.status) && (
          <button className="secondary-btn" onClick={() => act('void')} disabled={!!busy} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            {busy === 'void' ? <Spinner size={12} /> : <Ban size={12} />} Void
          </button>
        )}
        {ev.status === 'completed' && ev.filingStatus !== 'filed' && (
          <button className="secondary-btn" onClick={() => act('retry')} disabled={!!busy} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            {busy === 'retry' ? <Spinner size={12} /> : <RefreshCw size={12} />} Retry Filing
          </button>
        )}
      </div>
    </div>
  );
}

// Whether a packet is out (so the Offer stage hides "Send" and shows the status).
export function packetIsActive(events) {
  return (events || []).some(e => e.kind === 'hire' && ['awaiting_sender', 'sent'].includes(e.status));
}

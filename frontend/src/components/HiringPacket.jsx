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
import { PacketEditor, describeRoles } from './PacketTemplates';

const ENABLED_EVENTS = ['hire', 'promotion', 'separation'];
const OTHER_ROLE = '__other__';

// The email a packet sends, exactly as the person receives it (sample person,
// real company, the packet's own welcome note and documents).
export function EmailPreviewModal({ event, entityId = '', templateId = '', note = '', role = 'subject', onClose }) {
  const [mail, setMail] = useState(null);
  const [err, setErr] = useState('');
  const [stage, setStage] = useState('invite');       // the sign-now email, or the "it's official" one after
  useEffect(() => {
    setMail(null);
    api.packetEmailPreview({ event, entityId, templateId, note, role, stage }).then(setMail).catch(e => setErr(e?.message || 'Could not render the email.'));
  }, [event, entityId, templateId, note, role, stage]);
  return (
    <div onClick={e => e.target === e.currentTarget && onClose()}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: 'var(--card)', borderRadius: 16, width: '100%', maxWidth: 'clamp(560px, 60vw, 1100px)', height: 'min(92dvh, 860px)', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)', fontFamily: 'Inter,sans-serif' }}>
        <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em' }}>Email Preview - Subject</div>
            <div style={{ fontWeight: 700, fontSize: 14, marginTop: 2 }}>{mail?.subject || (err ? '' : '...')}</div>
          </div>
          {role !== 'manager' && (
            <div style={{ display: 'flex', gap: 4, background: 'var(--mist)', borderRadius: 999, padding: 3 }}>
              {[['invite', 'To Sign'], ['completed', 'After Signing']].map(([k, l]) => (
                <button key={k} type="button" onClick={() => setStage(k)}
                  style={{ border: 'none', borderRadius: 999, padding: '5px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'Inter,sans-serif',
                    background: stage === k ? 'var(--pine)' : 'transparent', color: stage === k ? '#fff' : 'var(--ink)' }}>{l}</button>
              ))}
            </div>
          )}
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        {err ? <div style={{ padding: 20 }}><Problem>{err}</Problem></div>
          : !mail ? <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}><Spinner size="section" /></div>
            : <iframe title="Email preview" srcDoc={mail.html} sandbox="" style={{ flex: 1, border: 'none', borderRadius: '0 0 16px 16px', background: '#f3f4f6' }} />}
      </div>
    </div>
  );
}
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
    <div style={{ background: 'var(--card)', borderRadius: 16, width: '100%', maxWidth: wide ? 'clamp(560px, 60vw, 1100px)' : 'clamp(560px, 60vw, 1100px)', maxHeight: 'min(92dvh, 820px)', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)', fontFamily: 'Inter,sans-serif' }}>
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
export const Problem = ({ children }) => (
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
// One event at a time, one table: each row is a packet - the role it is for,
// its documents, its signers, where it is filed. Edited whole in PacketEditor.
const TH = { fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em', textAlign: 'left', padding: '8px 12px', borderBottom: '1px solid var(--line)', whiteSpace: 'nowrap' };
const TD = { fontSize: 12.5, padding: '11px 12px', borderBottom: '1px solid var(--line)', verticalAlign: 'top' };
const IconBtn = ({ title, onClick, disabled, danger, children }) => (
  <button type="button" title={title} aria-label={title} onClick={onClick} disabled={disabled}
    style={{ width: 30, height: 30, borderRadius: 8, border: '1px solid var(--line)', background: 'var(--card)', cursor: disabled ? 'default' : 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: danger ? 'hsl(var(--color-red))' : 'var(--ink)', opacity: disabled ? 0.5 : 1 }}>
    {children}
  </button>
);

function PacketRow({ row, onEdit, onRemoved, toastErr, companyName }) {
  const [busy, setBusy] = useState(false);
  const [mail, setMail] = useState(null);
  const docs = [...(row.documents || []), ...(row.hasLetter ? ['Typed letter'] : [])];
  async function remove() {
    const after = row.roleNames?.length ? `${describeRoles(row.roleNames)} will use the Every role packet instead.` : 'Roles without a packet of their own cannot be sent one until a new Every role packet is saved.';
    if (!await dialog.confirm(`Remove "${row.templateName}"? ${after} Packets already sent are not affected.`, { title: 'Remove Packet', confirmText: 'Remove' })) return;
    setBusy(true);
    try { await api.deletePacket(row.id); onRemoved(row); }
    catch (e) { toastErr(e?.message || 'Could not remove it.'); setBusy(false); }
  }
  return (
    <>
      <tr>
        {companyName !== undefined && <td style={{ ...TD, whiteSpace: 'nowrap' }}>{companyName || <span style={{ color: 'var(--muted)' }}>Every company</span>}</td>}
        <td style={TD}>
          <div style={{ fontWeight: 700 }}>{row.templateName || 'Unnamed packet'}</div>
          {(row.problems || []).map(p => <div key={p} style={{ color: 'hsl(var(--color-orange))', fontSize: 11.5, marginTop: 3 }}>{p}</div>)}
        </td>
        <td style={TD}>
          <StatusChip label={describeRoles(row.roleNames)} tone={row.roleNames?.length ? 'green' : 'gray'} />
          {row.workerType && row.workerType !== 'any' && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>{WORKER_LABEL[row.workerType]}</div>}
        </td>
        <td style={TD}>{docs.length ? docs.map(d => <div key={d}>{d}</div>) : <span style={{ color: 'var(--muted)' }}>-</span>}</td>
        <td style={TD}>{(row.signers || []).map((x, i) => <div key={i}>{i + 1}. {x}</div>)}</td>
        <td style={{ ...TD, color: 'var(--muted)' }}>{row.effectiveSubfolder || row.egnyteSubfolder || '-'}</td>
        <td style={{ ...TD, whiteSpace: 'nowrap', textAlign: 'right' }}>
          <span style={{ display: 'inline-flex', gap: 6 }}>
            <IconBtn title="Preview Email" onClick={() => setMail({ event: row.event, entityId: row.entityId, templateId: row.templateId, note: row.emailMessage })}><Send size={13} /></IconBtn>
            <IconBtn title="Edit" onClick={onEdit}><FileSignature size={13} /></IconBtn>
            <IconBtn title="Remove" onClick={remove} disabled={busy} danger><Trash2 size={13} /></IconBtn>
          </span>
        </td>
      </tr>
      {mail && <EmailPreviewModal {...mail} onClose={() => setMail(null)} />}
    </>
  );
}

export function PacketsModal({ onClose, toastOk, toastErr }) {
  const [data, setData] = useState(null);
  const [entities, setEntities] = useState([]);
  const [companyId, setCompanyId] = useState('');
  const [tab, setTab] = useState('hire');
  const [editing, setEditing] = useState(null);     // { event, row | null }
  const load = () => api.getPackets().then(setData).catch(e => { toastErr(e?.message || 'Could not load packets.'); onClose(); });
  useEffect(() => { load(); api.getEntities().then(setEntities).catch(() => {}); }, []);

  const events = (data?.events || []).filter(e => ENABLED_EVENTS.includes(e.key));
  const ev = events.find(e => e.key === tab) || events[0];
  const entityName = (id) => (id ? (entities.find(e => e.id === id)?.name || 'Unknown company') : '');
  // "All companies" (no company picked) lists every packet with its company;
  // a company picked lists its own.
  const all = !companyId;
  const mine = (s) => all || (s.entityId || '') === companyId;
  const rows = ev ? (data?.settings || []).filter(s => mine(s) && s.event === ev.key)
    .sort((a, b) => (entityName(a.entityId) || '').localeCompare(entityName(b.entityId) || '')
      || (a.roleIds?.length ? 1 : 0) - (b.roleIds?.length ? 1 : 0) || (a.templateName || '').localeCompare(b.templateName || '')) : [];
  const inherited = ev && companyId ? (data?.settings || []).filter(s => !s.entityId && s.event === ev.key) : [];
  const hasGeneral = rows.some(r => !(r.roleIds || []).length && (all ? !r.entityId : true));
  const company = companyId ? (entities.find(e => e.id === companyId)?.name || 'This company') : 'Every company';
  const countFor = (key) => (data?.settings || []).filter(s => mine(s) && s.event === key).length;

  return (
    <Overlay onClose={onClose} wide>
      <div style={{ padding: '16px 22px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 14, flexShrink: 0 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 800, fontSize: 15.5 }}>Packets</div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 1 }}>What goes out through Nexus Sign when someone is hired, promoted or leaves</div>
        </div>
        <select className="form-input" style={{ width: 240 }} value={companyId} onChange={e => setCompanyId(e.target.value)} aria-label="Company">
          <option value="">All Companies</option>
          {entities.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
        <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
      </div>
      <div style={{ overflowY: 'auto', flex: 1, padding: '14px 22px 22px' }}>
        {!data ? <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}><Spinner size="section" /></div> : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
              <div className="scroll-tabs" style={{ display: 'flex', gap: 4, background: 'var(--mist)', borderRadius: 10, padding: 3 }}>
                {events.map(e => (
                  <button key={e.key} type="button" onClick={() => setTab(e.key)}
                    style={{ border: 'none', borderRadius: 8, padding: '6px 14px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'Inter,sans-serif', whiteSpace: 'nowrap',
                      background: ev?.key === e.key ? 'var(--card)' : 'transparent', color: 'var(--ink)', boxShadow: ev?.key === e.key ? '0 1px 3px rgba(0,0,0,0.15)' : 'none' }}>
                    {e.label}{countFor(e.key) ? <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>{countFor(e.key)}</span> : null}
                  </button>
                ))}
              </div>
              <span style={{ flex: 1 }} />
              {ev && (
                <button type="button" className="primary-btn" onClick={() => setEditing({ event: ev, row: null })}
                  style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <Plus size={13} /> Add Packet
                </button>
              )}
            </div>
            {ev && rows.length === 0 && (
              <div style={{ textAlign: 'center', border: '1px dashed var(--line)', borderRadius: 12, padding: '36px 20px' }}>
                <FileSignature size={26} style={{ color: 'var(--muted)' }} />
                <div style={{ fontSize: 14, fontWeight: 700, marginTop: 8 }}>No {ev.label.toLowerCase()} for {company} yet</div>
                <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 4, maxWidth: 520, margin: '4px auto 0', lineHeight: 1.5 }}>
                  {inherited.length
                    ? `${company} uses the default: ${inherited.map(s => `${s.templateName} (${describeRoles(s.roleNames)})`).join(', ')}. Add a packet to give it its own.`
                    : companyId ? `${company} cannot send one until a packet is added here or for every company.`
                      : 'Add a packet: upload the PDF, place the signature boxes and an Offer Field for the salary, and save. A packet added here, with no company picked, is for every company.'}
                </div>
                <button type="button" className="primary-btn" onClick={() => setEditing({ event: ev, row: null })} style={{ fontSize: 12.5, marginTop: 14, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <Plus size={13} /> Add Packet
                </button>
              </div>
            )}
            {ev && rows.length > 0 && (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    {all && <th style={TH}>Company</th>}<th style={TH}>Packet</th><th style={TH}>For Role</th><th style={TH}>Documents</th><th style={TH}>Signs</th><th style={TH}>Filed In</th><th style={TH} />
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <PacketRow key={r.id} row={r} toastErr={toastErr} onEdit={() => setEditing({ event: ev, row: r })}
                      companyName={all ? entityName(r.entityId) : undefined}
                      onRemoved={() => { load(); toastOk('Packet removed.'); }} />
                  ))}
                </tbody>
              </table>
            )}
            {ev && rows.length > 0 && (
              <div style={hint}>
                A role with its own packet gets that one - the company's, else the one for every company; every other role gets the Every role packet{companyId ? ', the company\'s or the one for every company' : ''}.
                {!hasGeneral && ` Roles without a packet of their own have nothing to fall back on here - add a packet for Every role to cover the rest.`}
              </div>
            )}
          </>
        )}
      </div>
      {editing && (
        <PacketEditor packet={editing.row} event={editing.event.key} eventLabel={editing.event.label}
          companyId={editing.row ? (editing.row.entityId || '') : companyId}
          companyName={editing.row ? (entityName(editing.row.entityId) || 'Every company') : company}
          defaultSubfolder={editing.event.defaultSubfolder} toastErr={toastErr}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); toastOk('Packet saved.'); }} />
      )}
    </Overlay>
  );
}

// ── Offer stage: send the hiring packet ──────────────────────────────────────
export function SendHiringPacketModal({ candidate: c, canSeePay, onClose, onSent, toastErr }) {
  const { data: people = [] } = usePeopleDirectory();
  // The job title is one of the company's roles (Pranshu, Oct 8); "Other"
  // names a new one - added to the company's roles at send, with no access
  // until an administrator sets it.
  const [f, setF] = useState({
    role_id: c.roleId || (c.roleTitle ? OTHER_ROLE : ''), new_role_name: c.roleId ? '' : (c.roleTitle || ''),
    department: c.department || '', start_date: (c.expectedStart || '').slice(0, 10),
    // The offer stands until this day; the link dies after it. A week is the
    // usual window - still HR's call.
    offer_expires: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
    manager_email: '', employment_type: 'full_time', salary_text: '',
  });
  const [opts, setOpts] = useState({ roles: [], departments: [] });
  const [mail, setMail] = useState(null);           // the email preview being shown
  const [pay, setPay] = useState({ base: '', payBasis: 'salary', frequency: 'annual', currency: 'USD' });
  const [extra, setExtra] = useState({});          // fields the template needs that Nexus can't fill
  const [preview, setPreview] = useState(null);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState('');
  const set = (k, v) => { setF(p => ({ ...p, [k]: v })); setPreview(null); };
  // The company's roles; the role's default manager is the likely supervisor
  // - prefilled, still changeable.
  useEffect(() => {
    if (!c.company) return;
    api.hiringOptions(c.company).then(o => {
      setOpts({ roles: o.roles || [], departments: o.departments || [] });
      const r = (o.roles || []).find(x => x.id === c.roleId);
      if (r?.defaultManagerEmail) setF(p => (p.manager_email ? p : { ...p, manager_email: r.defaultManagerEmail }));
    }).catch(() => {});
  }, [c.roleId, c.company]);
  const isOther = f.role_id === OTHER_ROLE;
  const role = opts.roles.find(r => r.id === f.role_id);
  const pickRole = (id) => {
    const r = opts.roles.find(x => x.id === id);
    setF(p => ({ ...p, role_id: id, department: r ? (r.department || p.department) : p.department,
                 manager_email: p.manager_email || r?.defaultManagerEmail || '' }));
    setPreview(null);
  };
  const setP = (k, v) => { setPay(p => ({ ...p, [k]: v })); setPreview(null); };
  const manager = people.find(p => p.email === f.manager_email);
  const body = () => ({
    inputs: { ...f, role_id: isOther ? '' : f.role_id, new_role_name: isOther ? f.new_role_name.trim() : '', merge: extra },
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
          <div><label style={lbl}>Job Title *</label>
            <select className="form-input" style={{ width: '100%' }} value={f.role_id} onChange={e => pickRole(e.target.value)}>
              <option value="">- pick the role -</option>
              {opts.roles.map(r => <option key={r.id} value={r.id}>{r.name}{r.department ? ` - ${r.department}` : ''}</option>)}
              <option value={OTHER_ROLE}>Other (a new role)</option>
            </select></div>
          {isOther ? (
            <>
              {input('New Role Name *', 'new_role_name', { placeholder: 'e.g. Leasing Coordinator' })}
              <div><label style={lbl}>Department *</label>
                <select className="form-input" style={{ width: '100%' }} value={f.department} onChange={e => set('department', e.target.value)}>
                  <option value="">- pick a department -</option>
                  {opts.departments.map(d => <option key={d} value={d}>{d}</option>)}
                </select></div>
            </>
          ) : (
            <div><label style={lbl}>Department</label>
              <div className="form-input" style={{ width: '100%', background: 'var(--mist)', color: role?.department ? 'var(--ink)' : 'var(--muted)', display: 'flex', alignItems: 'center' }}>
                {role ? (role.department || 'The role has no department') : 'Set by the role'}
              </div></div>
          )}
          {input('Start Date *', 'start_date', { type: 'date' })}
          {input('Offer Expires *', 'offer_expires', { type: 'date', max: f.start_date || undefined, title: 'They can review and sign through this day; after it the link stops working.' })}
          <div><label style={lbl}>Employment Type</label>
            <select className="form-input" style={{ width: '100%' }} value={f.employment_type} onChange={e => set('employment_type', e.target.value)}>
              {EMPLOYMENT_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select></div>
          {isOther && (
            <div style={{ gridColumn: '1 / -1' }}>
              <Problem>"{f.new_role_name.trim() || 'The new role'}" is not one of this company's roles yet. Sending adds it to the company's roles with NO access - you and the administrators get a reminder to set its access in Settings &gt; Access.</Problem>
            </div>
          )}
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
              {preview.expiresOn && <> They can sign through <b>{usDay(preview.expiresOn)}</b>; after that the link expires and the packet reads Expired.</>}
            </div>
            {preview.rehire && (
              <div style={{ fontSize: 12.5, marginTop: 8, padding: '8px 11px', borderRadius: 10, background: 'hsla(var(--color-blue),0.08)' }}>
                <b>Rehire:</b> {preview.rehire.name} ({preview.rehire.employeeCode || 'no code'}) is already in People as {preview.rehire.status}. When they sign, that record is reactivated as Onboarding - no second record is created.
              </div>
            )}
            {preview.salaryText && preview.payInLetter === false && <Problem>This packet's letter does not show pay - {preview.salaryText} will be set as their pay when they sign, but they will not read it in the documents. Add {'{{salary}}'} to the template under Documents &gt; Nexus Sign &gt; Templates, or leave pay blank.</Problem>}
            {preview.newRole && <Problem>New role "{preview.newRole}" will be added to {preview.company}'s roles with no access - set its access in Settings &gt; Access after sending.</Problem>}
            <div style={{ fontSize: 12.5, marginTop: 10, padding: '8px 11px', borderRadius: 10, background: 'var(--mist)' }}>
              <b>Nothing goes to {name} yet.</b> Review And Sign opens the finished packet - your PDFs with this offer's pay and dates printed in - for you to read and sign for the company. The welcome email goes out only after you sign; if something is wrong, decline on that screen and send a corrected packet.
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
              <span style={{ fontSize: 12.5 }}>{name} then gets the welcome email with a link to sign.</span>
              <button type="button" className="secondary-btn" style={{ fontSize: 11.5, padding: '3px 10px' }}
                onClick={() => setMail({ event: 'hire', entityId: c.company || '', templateId: preview.templateId, note: preview.emailMessage || '' })}>Preview Email</button>
            </div>
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
      {mail && <EmailPreviewModal {...mail} onClose={() => setMail(null)} />}
      <div style={{ padding: '12px 22px', borderTop: '1px solid var(--line)', display: 'flex', gap: 10, justifyContent: 'flex-end', flexShrink: 0 }}>
        <button className="secondary-btn" onClick={onClose} disabled={!!busy}>Cancel</button>
        {!preview ? (
          <button className="primary-btn" onClick={review} disabled={!!busy || !f.role_id || (isOther && (!f.new_role_name.trim() || !f.department)) || !f.start_date || !f.offer_expires}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {busy === 'preview' ? <Spinner size={14} /> : <FileSignature size={14} />} Review Packet
          </button>
        ) : (
          <button className="primary-btn" onClick={send} disabled={!!busy || !ack || missing.length > 0}
            title={missing.length ? 'Fill in the missing details first' : !ack ? 'Confirm the document type first' : ''}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {busy === 'send' ? <Spinner size={14} /> : <Send size={14} />} Review And Sign
          </button>
        )}
      </div>
    </Overlay>
  );
}

// ── The packet on a candidate ────────────────────────────────────────────────
// One life event (hiring packet, promotion letter, separation package): who
// has signed, Sign Now for HR's own turn, Void, and where it was filed.
export function LifeEventCard({ ev, onSignNow, onChanged, toastOk, toastErr, hideSign = false }) {
  const [busy, setBusy] = useState('');
  const [label, tone] = ev.status === 'sent' && ev.kind !== 'hire' ? ['Out For Signature', 'blue'] : (EVENT_STATUS[ev.status] || [ev.status, 'gray']);
  const what = ev.title || 'Packet';
  async function act(kind) {
    if (kind === 'void' && !await dialog.confirm(`Void this ${what.toLowerCase()}? It can no longer be signed. To change the pay or any other detail, void it and send a new one with the new values - a letter that is out is never edited.`, { title: 'Void', confirmText: 'Void' })) return;
    if (kind === 'cancel' && !await dialog.confirm('Cancel this offboarding? They stay active, and any paperwork still out is voided.', { title: 'Cancel Offboarding', confirmText: 'Cancel Offboarding', cancelText: 'Keep It' })) return;
    setBusy(kind);
    try {
      if (kind === 'void') { await api.voidLifeEvent(ev.id); toastOk?.(`${what} voided.`); }
      else if (kind === 'cancel') { await api.cancelOffboarding(ev.id); toastOk?.('Offboarding canceled.'); }
      else if (kind === 'apply') { await api.retryLifeEventApply(ev.id); toastOk?.('Applied.'); }
      else { const out = await api.retryLifeEventFiling(ev.id); toastOk?.(out.filingStatus === 'filed' ? 'Filed in Egnyte.' : 'Still not filed - see the reason below.'); }
      onChanged?.();
    } catch (e) { toastErr?.(e?.message || 'That did not work.'); }
    setBusy('');
  }
  const flagged = (ev.flags || []).find(f => f.code === 'signed_timesheets');
  // Signed in Nexus Sign, but Nexus could not apply it (the hire that never
  // became an employee) - the one state that must never sit quietly.
  const failed = (ev.flags || []).find(f => f.code === 'apply_failed');
  return (
    <div style={{ marginTop: 14, border: '1px solid var(--line)', borderRadius: 12, padding: '12px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <FileSignature size={14} style={{ color: 'var(--muted)' }} />
        <b style={{ fontSize: 13 }}>{what}</b>
        <StatusChip label={label} tone={tone} />
        <span style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--muted)' }}>Sent {formatDateTime(ev.createdAt)}</span>
      </div>
      {ev.kind === 'separation' && ev.applyStatus === 'scheduled' && (
        <div style={{ fontSize: 12.5, marginTop: 6, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Clock size={13} style={{ color: 'hsl(var(--color-blue))' }} /> Last day {usDay(ev.effectiveDate)} - Nexus marks them Left the morning after.
          <button className="secondary-btn" onClick={() => act('cancel')} disabled={!!busy} style={{ fontSize: 11.5, padding: '3px 10px' }}>
            {busy === 'cancel' ? <Spinner size={12} /> : 'Cancel Offboarding'}
          </button>
        </div>
      )}
      {ev.kind === 'hire' && ev.inputs?.offer_expires && ['awaiting_sender', 'sent'].includes(ev.status) && (
        <div style={{ fontSize: 12.5, marginTop: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
          <Clock size={13} style={{ color: 'var(--muted)' }} /> Offer open through {usDay(ev.inputs.offer_expires)} - the link expires after that day.
        </div>
      )}
      {ev.applyNote && (ev.status === 'completed' || ev.applyStatus) && <div style={{ fontSize: 12, marginTop: 6 }}>{ev.applyNote}</div>}
      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {ev.parties.map(p => (
          <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
            {p.status === 'signed' ? <CheckCircle size={13} style={{ color: 'hsl(var(--color-green))' }} /> : <Clock size={13} style={{ color: 'var(--muted)' }} />}
            <span style={{ flex: 1 }}>{p.order}. {p.name}{p.isSubject ? '' : ` (${p.role === 'manager' ? 'manager' : 'company'})`}</span>
            <span style={{ color: 'var(--muted)' }}>{p.status === 'signed' && p.signedAt ? `Signed ${formatDateTime(p.signedAt)}` : (PARTY_STATUS[p.status] || p.status)}</span>
          </div>
        ))}
      </div>
      {ev.status === 'declined' && ev.declineReason && <Problem>Declined: {ev.declineReason}</Problem>}
      {failed && ev.status !== 'completed' && (
        <Problem>Signed, but not applied: {failed.message}. The signatures are safe - use Retry; if it keeps failing, send this message to support.</Problem>
      )}
      {flagged && (ev.status === 'completed'
        ? <Problem>Signed timesheets from {usDay(ev.effectiveDate)} were not repriced: {flagged.periods.map(x => x.label).join(', ')}. Review them in Time.</Problem>
        : <Problem>The new pay starts {usDay(ev.effectiveDate)}, inside timesheets already signed ({flagged.periods.map(x => x.label).join(', ')}). They will not be repriced - review them once this is signed.</Problem>)}
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
        {ev.senderPartyId && onSignNow && !hideSign && (
          <button className="primary-btn" onClick={() => onSignNow(ev.senderPartyId)} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <FileSignature size={12} /> Sign Now
          </button>
        )}
        {['awaiting_sender', 'sent'].includes(ev.status) && (
          <button className="secondary-btn" onClick={() => act('void')} disabled={!!busy} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            {busy === 'void' ? <Spinner size={12} /> : <Ban size={12} />} Void
          </button>
        )}
        {failed && ev.status !== 'completed' && (
          <button className="primary-btn" onClick={() => act('apply')} disabled={!!busy} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            {busy === 'apply' ? <Spinner size={12} /> : <RefreshCw size={12} />} Retry
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

export function HiringPacketStatus({ candidateId, refreshKey, onSignNow, onChanged, onEvents, toastOk, toastErr, hideSign = false }) {
  const [events, setEvents] = useState(null);
  const load = () => api.getLifeEvents({ candidateId })
    .then(rows => { setEvents(rows); onEvents?.(rows); })
    .catch(() => { setEvents([]); onEvents?.([]); });
  useEffect(() => { load(); }, [candidateId, refreshKey]);
  const ev = useMemo(() => (events || []).find(e => e.kind === 'hire') || null, [events]);
  if (events === null) return <div style={{ padding: '8px 0' }}><Spinner size={16} /></div>;
  if (!ev) return null;
  return <LifeEventCard ev={ev} onSignNow={onSignNow} toastOk={toastOk} toastErr={toastErr} hideSign={hideSign}
    onChanged={() => { load(); onChanged?.(); }} />;
}

// The letters on a person (People > profile): anything still out for
// signature, plus the latest finished one while it is recent or not filed.
export function PersonLifeEvents({ employeeId, refreshKey, onSignNow, toastOk, toastErr }) {
  const [events, setEvents] = useState([]);
  const load = () => api.getLifeEvents({ employeeId }).then(setEvents).catch(() => setEvents([]));
  useEffect(() => { load(); }, [employeeId, refreshKey]);
  const recent = Date.now() - 14 * 86400000;
  const shown = events.filter(e => ['awaiting_sender', 'sent'].includes(e.status) || e.applyStatus === 'scheduled'
    || (e.status === 'completed' && (e.filingStatus !== 'filed' || new Date(e.completedAt).getTime() > recent))
    || (e.flags || []).some(f => f.code === 'apply_failed')
    || (['declined', 'expired'].includes(e.status) && new Date(e.createdAt).getTime() > recent));
  if (!shown.length) return null;
  return <div>{shown.map(ev => <LifeEventCard key={ev.id} ev={ev} onSignNow={onSignNow} onChanged={load} toastOk={toastOk} toastErr={toastErr} />)}</div>;
}

// Whether a packet is out (so the Offer stage hides "Send" and shows the status).
export function packetIsActive(events) {
  return (events || []).some(e => e.kind === 'hire' && ['awaiting_sender', 'sent'].includes(e.status));
}

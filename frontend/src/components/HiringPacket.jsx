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
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Send, FileSignature, RefreshCw, Ban, FolderOpen, CheckCircle, Clock, AlertTriangle, Plus, Trash2, Copy, Info } from 'lucide-react';
import { api } from '../api';
import { dialog } from '../ui/dialog';
import { formatDateTime } from '../lib/datetime';
import { currencyOptions } from '../asset/lib/currency';
import { usePeopleDirectory } from '../lib/queries';
import { Spinner } from './AsyncState';
import PersonSearchSelect from './PersonSearchSelect';
import { leadsFor } from './HiringSchedule';
import { REPORTS_TO } from './OfferModal';
import { SignModal } from './ESign';
import DetailsFormFields from './DetailsFormFields';
import { PacketEditor, describeRoles } from './PacketTemplates';
import HiringSetup from './hiring/HiringSetup';
import { DocumentsPacketEditor, packetCopy } from './DocumentsPacketEditor';
import { readinessSummary } from '../lib/packetFlow';
import PacketReview from './PacketReview';
import FolderPickModal from '../egnyte/EgnyteFolderPick';

const ENABLED_EVENTS = ['offer', 'hire', 'promotion', 'separation'];
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
      <div className="nx-popup" style={{ background: 'var(--card)', borderRadius: 16, height: 'min(92dvh, 860px)', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)', fontFamily: 'Inter,sans-serif' }}>
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

const Overlay = ({ children, onClose }) => (
  <div onClick={e => e.target === e.currentTarget && onClose()}
    style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1250, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
    <div style={{ background: 'var(--card)', borderRadius: 16, width: 'max(min(100%, 560px), 60vw)', maxWidth: '100%', minHeight: 'min(60vh, 90dvh)', maxHeight: '90dvh', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)', fontFamily: 'Inter,sans-serif' }}>
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
  // Packets built from Documents (Oct 14) exist before they are sent.
  intake:          ['Waiting On Details', 'blue'],
  review:          ['Ready For Review', 'orange'],
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

function PacketRow({ row, onEdit, onDuplicate, onRemoved, toastErr, companyName }) {
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
          {row.engine === 'documents' && readinessSummary(row.readiness) && (() => {
            const s = readinessSummary(row.readiness);
            const open = (row.readiness || []).filter(c => !c.ok).map(c => c.label).join(', ');
            return (
              <button type="button" onClick={onEdit} title={open || 'Everything a hire needs is in place'}
                style={{ marginTop: 5, border: 'none', cursor: 'pointer', padding: 0, background: 'none' }}>
                <StatusChip label={s.label} tone={s.tone} />
              </button>
            );
          })()}
          {row.engine === 'pdf' && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 3 }}>Uploaded PDFs - rebuild it from Documents</div>}
          {(row.problems || []).map(p => <div key={p} style={{ color: 'hsl(var(--color-orange))', fontSize: 11.5, marginTop: 3 }}>{p}</div>)}
        </td>
        <td style={TD}>
          {/* Place first (Neil, Oct 22) - "Employees in CA, US"; a role only when the packet is limited to one. */}
          <StatusChip label={row.place || describeRoles(row.roleNames)} tone={row.country ? 'green' : 'orange'} />
          {!row.country && <div style={{ fontSize: 11, color: 'hsl(var(--color-orange))', marginTop: 4 }}>No place set - pick Works In so it never reaches the wrong country</div>}
          {row.roleNames?.length > 0 && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>Only {describeRoles(row.roleNames)}</div>}
        </td>
        <td style={TD}>{docs.length ? docs.map(d => <div key={d}>{d}</div>) : <span style={{ color: 'var(--muted)' }}>-</span>}</td>
        <td style={TD}>{(row.signers || []).map((x, i) => <div key={i}>{i + 1}. {x}</div>)}</td>
        <td style={{ ...TD, color: 'var(--muted)' }}>{row.effectiveSubfolder || row.egnyteSubfolder || '-'}</td>
        <td style={{ ...TD, whiteSpace: 'nowrap', textAlign: 'right' }}>
          <span style={{ display: 'inline-flex', gap: 6 }}>
            <IconBtn title="Preview Email" onClick={() => setMail({ event: row.event, entityId: row.entityId, templateId: row.templateId, note: row.emailMessage })}><Send size={13} /></IconBtn>
            <IconBtn title="Edit" onClick={onEdit}><FileSignature size={13} /></IconBtn>
            {row.engine === 'documents' && <IconBtn title="Duplicate" onClick={onDuplicate}><Copy size={13} /></IconBtn>}
            <IconBtn title="Remove" onClick={remove} disabled={busy} danger><Trash2 size={13} /></IconBtn>
          </span>
        </td>
      </tr>
      {mail && <EmailPreviewModal {...mail} onClose={() => setMail(null)} />}
    </>
  );
}

export function PacketsModal({ onClose, toastOk = () => {}, toastErr = () => {}, initialCompanyId = null, focus = null }) {
  const [data, setData] = useState(null);
  const [entities, setEntities] = useState([]);
  const [companyId, setCompanyId] = useState('');
  // Hiring Setup first (Oct 23): the way in; the event tabs are Advanced.
  const [tab, setTab] = useState('overview');
  const [editing, setEditing] = useState(null);     // { event, row | null }
  // A packet saved here reloads Hiring Setup too; the offer's focus is used once.
  const [rev, setRev] = useState(0);
  const [focusLeft, setFocusLeft] = useState(focus);
  const load = () => {
    return api.getPackets().then(d => { setData(d); setRev(r => r + 1); }).catch(e => { toastErr(e?.message || 'Could not load packets.'); onClose(); });
  };
  useEffect(() => { load(); api.getEntities().then(setEntities).catch(() => {}); }, []);
  // A template written since this window opened shows up when a packet opens.
  const refreshCatalog = () => api.getPackets().then(setData).catch(() => {});
  useEffect(() => { if (editing) refreshCatalog(); }, [!!editing]);   // eslint-disable-line react-hooks/exhaustive-deps

  const events = (data?.events || []).filter(e => ENABLED_EVENTS.includes(e.key));
  const ev = tab === 'overview' ? null : (events.find(e => e.key === tab) || events[0]);
  // Fetched fresh: Hiring Setup may have made the row since this window opened.
  const openPacket = (id) => api.getPackets().then(d => {
    setData(d);
    const row = (d.settings || []).find(x => x.id === id);
    const e = row && (d.events || []).find(x => x.key === row.event && ENABLED_EVENTS.includes(x.key));
    if (row && e) setEditing({ event: e, row });
    else toastErr('That packet is not in use any more.');
  }).catch(e => toastErr(e?.message || 'Could not open the packet.'));
  const entityName = (id) => (id ? (entities.find(e => e.id === id)?.name || 'Unknown company') : '');
  // "All companies" (no company picked) lists every packet with its company;
  // a company picked lists its own.
  const all = !companyId;
  const mine = (s) => all || (s.entityId || '') === companyId;
  const rows = ev ? (data?.settings || []).filter(s => mine(s) && s.event === ev.key)
    .sort((a, b) => (entityName(a.entityId) || '').localeCompare(entityName(b.entityId) || '')
      || (a.roleIds?.length ? 1 : 0) - (b.roleIds?.length ? 1 : 0) || (a.templateName || '').localeCompare(b.templateName || '')) : [];
  const inherited = ev && companyId ? (data?.settings || []).filter(s => !s.entityId && s.event === ev.key) : [];
  const company = companyId ? (entities.find(e => e.id === companyId)?.name || 'This company') : 'Every company';
  // Roles born from Add Candidate's "Other" with no hiring packet yet (Neil,
  // Oct 12) - listed on the Hire tab with a one-click Add that opens the editor
  // for that role and its company.
  const needing = (data?.rolesNeedingPacket || []).filter(r => all || (r.companyId || '') === companyId);
  const addFor = (role) => {
    const hire = events.find(e => e.key === 'hire') || ev;
    if (!companyId && role.companyId) setCompanyId(role.companyId);
    setEditing({ event: hire, row: null, seed: { roleIds: [role.id] }, companyId: role.companyId || '' });
  };
  const countFor = (key) => (data?.settings || []).filter(s => mine(s) && s.event === key).length;

  return (
    <Overlay onClose={onClose} wide>
      <div style={{ padding: '16px 22px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: '8px 14px', flexShrink: 0, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 220px', minWidth: 0 }}>
          <div style={{ fontWeight: 800, fontSize: 15.5 }}>Hiring Documents</div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 1 }}>What goes out through Nexus Sign when someone is hired, promoted or leaves</div>
        </div>
        {tab !== 'overview' && (
          <select className="form-input" style={{ width: 240, maxWidth: '100%' }} value={companyId} onChange={e => setCompanyId(e.target.value)} aria-label="Company">
            <option value="">All Companies</option>
            {entities.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        )}
        <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
      </div>
      <div style={{ overflowY: 'auto', flex: 1, padding: '14px 22px 22px' }}>
        {!data ? <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}><Spinner size="section" /></div> : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
              <div className="scroll-tabs" style={{ display: 'flex', gap: 4, background: 'var(--mist)', borderRadius: 10, padding: 3, maxWidth: '100%' }}>
                <button type="button" onClick={() => setTab('overview')}
                  style={{ border: 'none', borderRadius: 8, padding: '6px 14px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'Inter,sans-serif', whiteSpace: 'nowrap',
                    background: tab === 'overview' ? 'var(--card)' : 'transparent', color: 'var(--ink)', boxShadow: tab === 'overview' ? '0 1px 3px rgba(0,0,0,0.15)' : 'none' }}>
                  Hiring Setup
                </button>
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
            {tab === 'overview' && (
              <HiringSetup toastOk={toastOk} toastErr={toastErr} initialCompanyId={initialCompanyId} focus={focusLeft} onFocusUsed={() => setFocusLeft(null)}
                refreshKey={rev} onAdvanced={(settingId) => (settingId ? openPacket(settingId) : setTab('offer'))} />
            )}
            {ev?.key === 'hire' && needing.length > 0 && (
              <div role="status" style={{ border: '1px solid rgba(180,83,9,0.35)', background: 'rgba(180,83,9,0.07)', borderRadius: 12, padding: '12px 14px', marginBottom: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 700, color: '#b45309' }}>
                  <AlertTriangle size={14} /> {needing.length === 1 ? 'A role added while hiring has no packet yet' : `${needing.length} roles added while hiring have no packet yet`}
                </div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3, lineHeight: 1.5 }}>Each was typed in as Other on Add Candidate. Until it has a packet of its own, the company's "Every role" packet goes out for it (if there is one).</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
                  {needing.map(r => (
                    <div key={r.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, border: '1px solid var(--line)', background: 'var(--card)', borderRadius: 10, padding: '6px 8px 6px 12px', fontSize: 12.5 }}>
                      <span style={{ fontWeight: 600 }}>{r.name}{r.department ? ` - ${r.department}` : ''}</span>
                      {all && r.companyName && <span style={{ color: 'var(--muted)' }}>{r.companyName}</span>}
                      <button type="button" className="primary-btn" onClick={() => addFor(r)} style={{ fontSize: 12, padding: '4px 10px', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <Plus size={12} /> Add Packet
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {ev && rows.length === 0 && (
              <div style={{ textAlign: 'center', border: '1px dashed var(--line)', borderRadius: 12, padding: '36px 20px' }}>
                <FileSignature size={26} style={{ color: 'var(--muted)' }} />
                <div style={{ fontSize: 14, fontWeight: 700, marginTop: 8 }}>No {ev.label.toLowerCase()} for {company} yet</div>
                <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 4, maxWidth: 520, margin: '4px auto 0', lineHeight: 1.5 }}>
                  {inherited.length
                    ? `${company} uses the default: ${inherited.map(s => `${s.templateName} (${describeRoles(s.roleNames)})`).join(', ')}. Add a packet to give it its own.`
                    : companyId ? `${company} cannot send one until a packet is added here or for every company.`
                      : 'Add a packet: pick its documents from Documents > Templates and set who signs, by role. A packet added here, with no company picked, is for every company.'}
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
                    {all && <th style={TH}>Company</th>}<th style={TH}>Packet</th><th style={TH}>For</th><th style={TH}>Documents</th><th style={TH}>Signs</th><th style={TH}>Filed In</th><th style={TH} />
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <PacketRow key={r.id} row={r} toastErr={toastErr} onEdit={() => setEditing({ event: ev, row: r })}
                      onDuplicate={() => setEditing({ event: ev, row: null, seed: packetCopy(r), companyId: r.entityId || '' })}
                      companyName={all ? entityName(r.entityId) : undefined}
                      onRemoved={() => { load(); toastOk('Packet removed.'); }} />
                  ))}
                </tbody>
              </table>
            )}
            {ev && rows.length > 0 && (
              <div style={hint}>
                Each hire gets the one for where they work and how they are hired: a state&apos;s before the country&apos;s, employees or contractors
                before both, this company&apos;s before the one for every company - and one limited to a role only wins among those for the same place.
                One for another country or state is never sent.
              </div>
            )}
          </>
        )}
      </div>
      {editing && (editing.row ? editing.row.engine === 'documents' : true) && (
        <DocumentsPacketEditor packet={editing.row || editing.seed || null} event={editing.event.key} eventLabel={editing.event.label}
          catalog={data} companies={entities} onRefreshCatalog={refreshCatalog}
          companyId={editing.row ? (editing.row.entityId || '') : (editing.companyId ?? companyId)}
          companyName={editing.row ? (entityName(editing.row.entityId) || 'Every company') : (editing.companyId ? (entityName(editing.companyId) || 'This company') : company)}
          defaultSubfolder={editing.event.defaultSubfolder} toastErr={toastErr}
          onClose={() => setEditing(null)}
          onSaved={(saved) => { setEditing(e => (e ? { ...e, row: saved } : e)); load(); toastOk('Packet saved - Ready To Send at the top shows anything still missing.'); }} />
      )}
      {editing && editing.row && editing.row.engine !== 'documents' && (
        <PacketEditor packet={editing.row || editing.seed || null} event={editing.event.key} eventLabel={editing.event.label}
          companyId={editing.row ? (editing.row.entityId || '') : (editing.companyId ?? companyId)}
          companyName={editing.row ? (entityName(editing.row.entityId) || 'Every company') : (editing.companyId ? (entityName(editing.companyId) || 'This company') : company)}
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
    manager_email: '', employment_type: 'full_time', salary_text: '', packet_id: '',
  });
  const [opts, setOpts] = useState({ roles: [], departments: [], leads: {} });
  const autoMgr = useRef('');                          // the supervisor Nexus filled in, not HR
  // The packet Nexus picks for the company and role, and the others HR may
  // send instead. Re-picked when the role or employment type changes until
  // HR chooses one by hand.
  const [packets, setPackets] = useState(null);
  const [packetTouched, setPacketTouched] = useState(false);
  useEffect(() => {
    api.hiringPacketOptions(c.id, { employment_type: f.employment_type, role_id: f.role_id === OTHER_ROLE ? '' : f.role_id })
      .then(p => { setPackets(p); if (!packetTouched) setF(prev => ({ ...prev, packet_id: p.pickedId || '' })); })
      .catch(() => setPackets({ pickedId: '', picked: null, options: [] }));
  }, [c.id, f.role_id, f.employment_type]);
  const [mail, setMail] = useState(null);           // the email preview being shown
  // A packet built from Documents (Oct 14) starts instead of sending: the Four
  // Options (role, pay, timings, job description) and the person's details,
  // then the documents are generated and HR verifies them before anything goes.
  const [timing, setTiming] = useState({ work_start: '09:00', work_end: '17:00', work_days: ['mon', 'tue', 'wed', 'thu', 'fri'], timings_text: '' });
  const [jds, setJds] = useState([]);
  const [jdId, setJdId] = useState('');
  const [payText, setPayText] = useState('');
  const [fills, setFills] = useState('hr');           // who fills in the details: 'hr' now, or 'candidate' (a link)
  const [details, setDetails] = useState({ first_name: c.firstName || '', last_name: c.lastName || '', preferred_name: '', phone: c.phone || '',
    address: '', permanent_address: '', emergency_name: '', emergency_relationship: '', emergency_phone: '' });
  useEffect(() => {
    api.getDocTemplates({ category: 'job_description', status: 'active' }).then(r => setJds(r || [])).catch(() => setJds([]));
  }, []);
  const setD = (k, v) => setDetails(p => ({ ...p, [k]: v }));
  const [answers, setAnswers] = useState({});        // the packet's own Details Form (Oct 14)
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
      setOpts({ roles: o.roles || [], departments: o.departments || [], leads: o.departmentLeads || {} });
      const r = (o.roles || []).find(x => x.id === c.roleId);
      const d = r ? r.defaultManagerEmail : leadsFor(o.departmentLeads, c.roleId ? '' : c.department)[0];
      autoMgr.current = d || '';
      if (d) setF(p => (p.manager_email ? p : { ...p, manager_email: d }));
    }).catch(() => {});
  }, [c.roleId, c.company]);
  const isOther = f.role_id === OTHER_ROLE;
  const role = opts.roles.find(r => r.id === f.role_id);
  // Same rule as the offer: one Nexus filled in follows the role or department; HR's own pick is kept.
  const withMgr = (next, email) => {
    const keep = f.manager_email && f.manager_email !== autoMgr.current;
    autoMgr.current = email || '';
    return keep ? next : { ...next, manager_email: email || '' };
  };
  const pickRole = (id) => {
    const r = opts.roles.find(x => x.id === id);
    const department = r ? (r.department || f.department) : f.department;
    setF(withMgr({ ...f, role_id: id, department }, r ? r.defaultManagerEmail : id === OTHER_ROLE ? leadsFor(opts.leads, department)[0] : ''));
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
  const chosen = (packets?.options || []).find(o => o.id === f.packet_id);
  const docsMode = chosen?.engine === 'documents';
  async function start() {
    setBusy('start');
    try {
      const b = body();
      const ev = await api.startHiringPacket(c.id, {
        intake: fills,
        inputs: { ...b.inputs, ...timing, jd_template_id: jdId },
        pay: b.pay,
        pay_values: canSeePay && payText.trim() ? { salary: payText.trim() } : null,
        details: fills === 'hr' ? { ...details, answers } : {},
      });
      onSent(fills === 'hr' ? { ...ev, openReview: true } : ev);
    } catch (e) { toastErr(e?.message || 'Could not start the packet.'); setBusy(''); }
  }
  const DAYS = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']];

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
      <Head title={docsMode ? `Start Hiring Packet - ${name}` : `Send Hiring Packet - ${name}`}
        sub={docsMode ? `Pick the four options and enter ${c.firstName || 'their'} details - the documents are generated at once, and HR checks them before anything goes to ${c.email || 'them'}.`
          : `Goes to ${c.email || 'their personal email'}. ${c.firstName || 'They'} signs first, then you countersign for the company.`} onClose={onClose} />
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
                <select className="form-input" style={{ width: '100%' }} value={f.department} onChange={e => { setF(withMgr({ ...f, department: e.target.value }, leadsFor(opts.leads, e.target.value)[0])); setPreview(null); }}>
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
          <div style={{ gridColumn: '1 / -1' }}><label style={lbl}>Packet</label>
            <select className="form-input" style={{ width: '100%' }} value={f.packet_id} disabled={!packets}
              onChange={e => { setPacketTouched(true); set('packet_id', e.target.value); }}>
              {!packets && <option value="">Finding the packet...</option>}
              {packets && packets.options.length === 0 && <option value="">No hiring packet set up for this company - add one in Settings &gt; Hiring</option>}
              {(packets?.options || []).map(o => (
                <option key={o.id} value={o.id}>{o.templateName} - {o.why}{o.companyName ? ` (${o.companyName})` : ''}{o.id === packets.pickedId ? ' - matched' : ''}</option>
              ))}
            </select>
            <div style={hint}>{packets?.picked
              ? <>Nexus matched <b>{packets.picked.templateName}</b> {packets.picked.why} - change it here if this hire needs a different one.</>
              : packets ? 'No packet matches this company and role yet.' : ''}</div>
            {/* Ready To Send (Oct 14): say now what would stop this hire later.
                Signing once is offered on the review, so it is not listed. */}
            {(chosen?.readiness || []).filter(c => !c.ok && !c.key.startsWith('once:')).map(c => (
              <Problem key={c.key}>{c.label}: {c.detail} Fix it in Settings &gt; Hiring &gt; Hiring Documents.</Problem>
            ))}
          </div>
          {isOther && (
            <div style={{ gridColumn: '1 / -1' }}>
              <Problem>"{f.new_role_name.trim() || 'The new role'}" is not one of this company's roles yet. Sending adds it to the company's roles with NO access - you and the administrators get a reminder to set its access in Settings &gt; Access.</Problem>
            </div>
          )}
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={{ ...lbl, display: 'flex', alignItems: 'center', gap: 6 }} title={REPORTS_TO}>
              Supervisor <Info size={13} aria-label={REPORTS_TO} style={{ color: 'var(--muted)', cursor: 'help' }} />
            </label>
            {manager ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{manager.name || manager.email}</span>
                <button type="button" className="secondary-btn" style={{ fontSize: 11.5, padding: '3px 10px' }} onClick={() => set('manager_email', '')}>Change</button>
              </div>
            ) : (
              <PersonSearchSelect placeholder="Type a name or email" groups={[{ label: 'Nexus People', people }]} onPick={v => set('manager_email', v)} />
            )}
            <div style={hint}>{REPORTS_TO}</div>
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
                {currencyOptions().map(c => <option key={c.code} value={c.code}>{c.label}</option>)}
              </select></div>
            {docsMode && (
              <div style={{ gridColumn: '1 / -1' }}><label style={lbl}>Or Pay As Written (Optional)</label>
                <input className="form-input" style={{ width: '100%' }} value={payText} onChange={e => setPayText(e.target.value)}
                  placeholder="e.g. $22.00 per hour plus commission - printed instead of the amount above" /></div>
            )}
            <div style={{ gridColumn: '1 / -1', ...hint }}>Printed in the offer letter and set as their pay from the start date once they sign.{docsMode ? ' Pay written as text is printed but not set on Pay & Benefits.' : ''}</div>
          </div>
        ) : docsMode ? (
          <div style={hint}>Pay & Benefits access is needed to enter pay - whoever verifies the packet can add it at review.</div>
        ) : (
          <>{input('Pay As Written In The Letter', 'salary_text', { placeholder: 'e.g. $85,000 per year' })}
            <div style={hint}>Pay & Benefits access is needed to set their payroll rate - HR can add it on their profile after they sign.</div></>
        )}

        {docsMode && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '0 14px' }}>
              <div><label style={lbl}>Starts At</label>
                <input className="form-input" type="time" style={{ width: '100%' }} value={timing.work_start} onChange={e => setTiming(t => ({ ...t, work_start: e.target.value }))} /></div>
              <div><label style={lbl}>Ends At</label>
                <input className="form-input" type="time" style={{ width: '100%' }} value={timing.work_end} onChange={e => setTiming(t => ({ ...t, work_end: e.target.value }))} /></div>
              <div style={{ gridColumn: '1 / -1' }}><label style={lbl}>Work Days</label>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {DAYS.map(([k, l]) => {
                    const on = timing.work_days.includes(k);
                    return <button key={k} type="button" onClick={() => setTiming(t => ({ ...t, work_days: on ? t.work_days.filter(x => x !== k) : [...t.work_days, k] }))}
                      style={{ padding: '4px 10px', borderRadius: 999, border: '1px solid var(--line)', fontSize: 12, cursor: 'pointer', fontFamily: 'Inter,sans-serif',
                        background: on ? 'var(--pine)' : 'var(--card)', color: on ? '#fff' : 'var(--ink)' }}>{l}</button>;
                  })}
                </div></div>
              <div style={{ gridColumn: '1 / -1' }}><label style={lbl}>Or Describe The Timings (Optional)</label>
                <input className="form-input" style={{ width: '100%' }} value={timing.timings_text} onChange={e => setTiming(t => ({ ...t, timings_text: e.target.value }))}
                  placeholder="e.g. Rotating shifts, 40 hours a week - printed instead of the hours above" /></div>
              <div style={{ gridColumn: '1 / -1' }}><label style={lbl}>Job Description</label>
                <select className="form-input" style={{ width: '100%' }} value={jdId} onChange={e => setJdId(e.target.value)}>
                  <option value="">None</option>
                  {jds.map(t => <option key={t.id} value={t.id}>{t.name}{t.publishedVersion ? '' : ' (Not Published)'}</option>)}
                </select>
                <div style={hint}>{jds.length ? 'Added to the packet as its own document.' : 'No job descriptions yet - create one in Documents > Templates with category Job Description.'}</div></div>
            </div>
            <div style={{ marginTop: 16, borderTop: '1px solid var(--line)', paddingTop: 4 }}>
              <div style={{ fontSize: 13, fontWeight: 800, marginTop: 10 }}>{c.firstName || 'Their'}'s Details</div>
              <div style={{ display: 'flex', gap: 4, background: 'var(--mist)', borderRadius: 10, padding: 3, width: 'fit-content', marginTop: 8 }}>
                {[['candidate', `${c.firstName || 'They'} Fills Them In`], ['hr', 'I Will']].map(([k, l]) => (
                  <button key={k} type="button" onClick={() => setFills(k)}
                    style={{ border: 'none', borderRadius: 8, padding: '6px 14px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'Inter,sans-serif',
                      background: fills === k ? 'var(--card)' : 'transparent', color: 'var(--ink)', boxShadow: fills === k ? '0 1px 3px rgba(0,0,0,0.15)' : 'none' }}>{l}</button>
                ))}
              </div>
              {fills === 'candidate' ? (
                <div style={hint}>{c.firstName || 'They'} gets an email at {c.email || 'their personal email'} with a link to enter their legal name, address, phone and an emergency contact. The documents are generated the moment they send them, and HR is asked to verify.</div>
              ) : <div style={hint}>Printed in the documents and saved on People when they sign. Use their legal name.</div>}
              {fills === 'hr' && <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0 14px' }}>
                {[['Legal First Name *', 'first_name'], ['Legal Last Name *', 'last_name'], ['Preferred Name', 'preferred_name'], ['Phone', 'phone']].map(([l, k]) => (
                  <div key={k}><label style={lbl}>{l}</label><input className="form-input" style={{ width: '100%' }} value={details[k]} onChange={e => setD(k, e.target.value)} /></div>
                ))}
                {[['Current Address', 'address'], ['Permanent Address', 'permanent_address']].map(([l, k]) => (
                  <div key={k} style={{ gridColumn: '1 / -1' }}><label style={lbl}>{l}</label><input className="form-input" style={{ width: '100%' }} value={details[k]} onChange={e => setD(k, e.target.value)} /></div>
                ))}
                {[['Emergency Contact', 'emergency_name'], ['Relationship', 'emergency_relationship'], ['Emergency Phone', 'emergency_phone']].map(([l, k]) => (
                  <div key={k}><label style={lbl}>{l}</label><input className="form-input" style={{ width: '100%' }} value={details[k]} onChange={e => setD(k, e.target.value)} /></div>
                ))}
              </div>}
              {fills === 'hr' && (chosen?.detailsForm || []).length > 0 && (
                // The packet's own Details Form (Oct 14). Anything left empty
                // shows on the review, and a required one blocks sending.
                <DetailsFormFields form={chosen.detailsForm} values={answers} onChange={setAnswers}
                  className="form-input" labelStyle={lbl} gridMin={200} idPrefix="hp" />
              )}
              {fills === 'candidate' && (chosen?.detailsForm || []).length > 0 && (
                <div style={hint}>The link also asks for: {chosen.detailsForm.filter(f => f.type !== 'heading').map(f => f.label).join(', ')}.</div>
              )}
            </div>
          </>
        )}

        {preview && !docsMode && (
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
              <b>Nothing goes to {name} until you click Send Packet.</b> {name} signs the finished packet first - your PDFs with this offer's pay and dates printed in - and you countersign for the company after them, never before. If something is wrong, void it and send a corrected packet.
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
        {docsMode ? (
          <button className="primary-btn" onClick={start}
            disabled={!!busy || !f.role_id || (isOther && (!f.new_role_name.trim() || !f.department)) || !f.start_date || !f.offer_expires
              || (fills === 'hr' && (!details.first_name.trim() || !details.last_name.trim()))}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {busy === 'start' ? <Spinner size={14} /> : fills === 'hr' ? <FileSignature size={14} /> : <Send size={14} />}
            {fills === 'hr' ? 'Generate Documents' : 'Send Details Link'}
          </button>
        ) : !preview ? (
          <button className="primary-btn" onClick={review} disabled={!!busy || !f.role_id || (isOther && (!f.new_role_name.trim() || !f.department)) || !f.start_date || !f.offer_expires}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {busy === 'preview' ? <Spinner size={14} /> : <FileSignature size={14} />} Review Packet
          </button>
        ) : (
          <button className="primary-btn" onClick={send} disabled={!!busy || !ack || missing.length > 0}
            title={missing.length ? 'Fill in the missing details first' : !ack ? 'Confirm the document type first' : ''}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {busy === 'send' ? <Spinner size={14} /> : <Send size={14} />} Send Packet
          </button>
        )}
      </div>
    </Overlay>
  );
}

// ── The packet on a candidate ────────────────────────────────────────────────
// An offboarding sent with no separation package (unticked, or the company
// has none set up) is born "completed" with nothing signed and nothing to
// file. It read "Fully Signed" with "Filing in Egnyte..." forever and a Retry
// Filing that could only fail (Charmi, Oct 20 2026) - it is No Paperwork.
export const noPaperwork = ev => ev.status === 'completed' && !ev.signRequestId && !(ev.documents || []).length;

// One life event (hiring packet, promotion letter, separation package): who
// has signed, Sign Now for HR's own turn, Void, and where it was filed.
// `compact`: one line for a signed one on the Documents tab; `filing={false}`
// leaves the Egnyte line to that row (Neil, Oct 22 1:01:35).
export function LifeEventCard({ ev, onSignNow, onChanged, toastOk, toastErr, hideSign = false, egnyteEmail = '', compact = false, filing = true }) {
  const [busy, setBusy] = useState('');
  const [picking, setPicking] = useState(null);      // File Manually: the folder the picker opens at
  const [reviewOpen, setReviewOpen] = useState(false);
  const docs = ev.engine === 'documents';
  const bare = noPaperwork(ev);
  const [label, tone] = bare ? ['No Paperwork', 'gray']
    : ev.status === 'sent' && ev.kind === 'offer' ? ['Waiting On The Candidate', 'blue']
    : ev.status === 'sent' && ev.kind !== 'hire' ? ['Out For Signature', 'blue']
      : docs && ev.status === 'awaiting_sender' ? ['Awaiting Company Sign-Off', 'orange']
        : ev.kind === 'offer' && ev.status === 'completed' ? ['Signed - Hired', 'green']
          : (EVENT_STATUS[ev.status] || [ev.status, 'gray']);
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
  // File Manually (Pranshu, Oct 15 2026): automatic filing cannot find or
  // make the folder - HR picks one that exists in Egnyte, and every signed,
  // unfiled document of this person goes there together. Picked with the
  // Egnyte folder picker (Neil, Oct 22: "you click on Browse and you can add
  // it. You don't add the URL"), opened at the person's folder when Nexus
  // knows it; a pasted path or link still works through its Go To Folder.
  async function openPicker() {
    setBusy('manual');
    const known = egnyteEmail ? await api.egnytePersonDocs(egnyteEmail).catch(() => null) : null;
    setBusy('');
    setPicking(known?.folder || '');
  }
  async function fileInto(folder) {
    setPicking(null);
    if (!folder) return;
    setBusy('manual');
    try {
      const out = await api.fileLifeEventManually(ev.id, folder);
      const filed = (out.events || []).filter(e => e.filingStatus === 'filed').length;
      const left = (out.events || []).length - filed;
      toastOk?.(left ? `Filed ${filed} - ${left} could not be filed, see the reason on it.` : `Filed in Egnyte: ${folder}`);
      onChanged?.();
    } catch (e) { toastErr?.(e?.message || 'That did not work.'); }
    setBusy('');
  }
  const flagged = (ev.flags || []).find(f => f.code === 'signed_timesheets');
  // Signed in Nexus Sign, but Nexus could not apply it (the hire that never
  // became an employee) - the one state that must never sit quietly.
  const failed = (ev.flags || []).find(f => f.code === 'apply_failed');
  // The offer is signed but the hiring packet could not start by itself (no
  // packet set up yet) - HR starts it here once it is (Oct 14).
  const notStarted = ev.kind === 'offer' && ev.status === 'completed' && (ev.flags || []).find(f => f.code === 'packet_not_started');
  async function startPacket() {
    setBusy('packet');
    try {
      const out = await api.startPacketAfterOffer(ev.candidateId);
      toastOk?.(out.intakeUrl ? `Hiring packet started - ${ev.subjectName} was emailed a link for their details.` : 'Hiring packet started.');
      onChanged?.();
    } catch (e) { toastErr?.(e?.message || 'Could not start the hiring packet.'); }
    setBusy('');
  }
  const unfiled = ev.status === 'completed' && !bare && ev.filingStatus !== 'filed';
  const filingColor = ev.filingStatus === 'filed' ? 'hsl(var(--color-green))' : ev.filingStatus === 'failed' ? 'hsl(var(--color-red))' : 'var(--muted)';
  const filingText = ev.filingStatus === 'filed' ? `Filed in Egnyte: ${ev.filingPath}`
    : ev.filingStatus === 'failed' ? `Not filed in Egnyte: ${ev.filingError}`
      : `Filing in Egnyte${ev.filingError ? ` - try ${ev.filingAttempts || 1} did not work: ${ev.filingError}. Nexus tries again by itself` : '...'}`;
  const filingButtons = unfiled && (
    <>
      <button className="secondary-btn" onClick={() => act('retry')} disabled={!!busy} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        {busy === 'retry' ? <Spinner size={12} /> : <RefreshCw size={12} />} Retry Filing
      </button>
      {/* Pending after a failed try too, not only once it gives up. */}
      {(ev.filingError || ev.filingAttempts > 0) && (
        <button className="secondary-btn" onClick={openPicker} disabled={!!busy} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          {busy === 'manual' ? <Spinner size={12} /> : <FolderOpen size={12} />} File Manually
        </button>
      )}
    </>
  );
  const modals = (
    <>
      {picking !== null && (
        <FolderPickModal startPath={picking} title="File Manually In Egnyte"
          hint={`Browse to the Egnyte folder to file into (it must already exist), or paste its path or Egnyte link, then press "Use This Folder". The offer letter and hiring packet are filed there together.`}
          onPick={fileInto} onClose={() => setPicking(null)} />
      )}
      {reviewOpen && (
        <PacketReview eventId={ev.id} onClose={() => setReviewOpen(false)} onChanged={onChanged}
          onSignNow={onSignNow} toastOk={toastOk} toastErr={toastErr} />
      )}
    </>
  );
  if (compact) return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '8px 0', borderTop: '1px solid var(--line)', fontSize: 12.5 }}>
      <FileSignature size={13} style={{ color: 'var(--muted)', flexShrink: 0 }} />
      <b>{what}</b>
      <StatusChip label={label} tone={tone} />
      {ev.completedAt && <span style={{ color: 'var(--muted)' }}>Signed {formatDateTime(ev.completedAt)}</span>}
      <span title={filingText} style={{ flex: 1, minWidth: 160, color: filingColor, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{filingText}</span>
      {docs && (
        <button className="secondary-btn" onClick={() => setReviewOpen(true)} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <FileSignature size={12} /> Documents
        </button>
      )}
      {filingButtons}
      {modals}
    </div>
  );
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
      {['offer', 'hire'].includes(ev.kind) && (ev.inputs?.due_on || ev.inputs?.offer_expires) && ['awaiting_sender', 'sent', 'intake'].includes(ev.status) && (
        <div style={{ fontSize: 12.5, marginTop: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
          <Clock size={13} style={{ color: 'var(--muted)' }} />
          {ev.inputs?.after_offer ? `Paperwork link open through ${usDay(ev.inputs.due_on)} - no login needed.`
            : `Offer open through ${usDay(ev.inputs.offer_expires)} - the link expires after that day.`}
        </div>
      )}
      {notStarted && <Problem>The hiring packet did not start: {notStarted.message}</Problem>}
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
        ? <Problem>Signed time sheets from {usDay(ev.effectiveDate)} were not repriced: {flagged.periods.map(x => x.label).join(', ')}. Review them in Time.</Problem>
        : <Problem>The new pay starts {usDay(ev.effectiveDate)}, inside time sheets already signed ({flagged.periods.map(x => x.label).join(', ')}). They will not be repriced - review them once this is signed.</Problem>)}
      {bare && (
        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--muted)', display: 'flex', gap: 6, alignItems: 'flex-start' }}>
          <FolderOpen size={13} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>No separation package was sent, so there is nothing to sign or file in Egnyte.</span>
        </div>
      )}
      {filing && ev.status === 'completed' && !bare && (
        <div style={{ marginTop: 8, fontSize: 12, display: 'flex', gap: 6, alignItems: 'flex-start', color: filingColor }}>
          <FolderOpen size={13} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>{filingText}</span>
        </div>
      )}
      {['intake', 'review'].includes(ev.status) && (
        <div style={{ fontSize: 12.5, marginTop: 6, color: 'var(--muted)' }}>
          {ev.status === 'review'
            ? `${(ev.documents || []).length} document${(ev.documents || []).length === 1 ? '' : 's'} generated - nothing is sent until HR verifies them.`
            : `Waiting for ${ev.subjectName} to fill in their details.`}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
        {['intake', 'review'].includes(ev.status) && (
          <button className="primary-btn" onClick={() => setReviewOpen(true)} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <FileSignature size={12} /> Open Review
          </button>
        )}
        {docs && !['intake', 'review'].includes(ev.status) && (
          <button className="secondary-btn" onClick={() => setReviewOpen(true)} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <FileSignature size={12} /> Documents
          </button>
        )}
        {ev.senderPartyId && onSignNow && !hideSign && (
          <button className="primary-btn" onClick={() => onSignNow(ev.senderPartyId)} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <FileSignature size={12} /> Sign Now
          </button>
        )}
        {['awaiting_sender', 'sent', 'intake', 'review'].includes(ev.status) && (
          <button className="secondary-btn" onClick={() => act('void')} disabled={!!busy} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            {busy === 'void' ? <Spinner size={12} /> : <Ban size={12} />} Void
          </button>
        )}
        {notStarted && (
          <button className="primary-btn" onClick={startPacket} disabled={!!busy} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            {busy === 'packet' ? <Spinner size={12} /> : <Send size={12} />} Start Hiring Packet
          </button>
        )}
        {failed && ev.status !== 'completed' && (
          <button className="primary-btn" onClick={() => act('apply')} disabled={!!busy} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            {busy === 'apply' ? <Spinner size={12} /> : <RefreshCw size={12} />} Retry
          </button>
        )}
        {filing && filingButtons}
      </div>
      {modals}
    </div>
  );
}

export function HiringPacketStatus({ candidateId, refreshKey, onSignNow, onChanged, onEvents, toastOk, toastErr, hideSign = false }) {
  const [events, setEvents] = useState(null);
  const load = () => api.getLifeEvents({ candidateId })
    .then(rows => { setEvents(rows); onEvents?.(rows); })
    .catch(() => { setEvents([]); onEvents?.([]); });
  useEffect(() => { load(); }, [candidateId, refreshKey]);
  // The offer letter, then the hiring packet that follows it (Oct 14) - the
  // latest of each, a voided one only when nothing newer stands.
  const shown = useMemo(() => ['offer', 'hire'].map(kind => {
    const mine = (events || []).filter(e => e.kind === kind);
    return mine.find(e => e.status !== 'voided') || mine[0] || null;
  }).filter(Boolean), [events]);
  // The offer is signed but its hiring packet was voided, declined or
  // expired (or never started): start it again from here.
  const offerDone = shown.find(e => e.kind === 'offer' && e.status === 'completed');
  const hireEv = shown.find(e => e.kind === 'hire');
  const restart = offerDone && hireEv && ['voided', 'declined', 'expired'].includes(hireEv.status);
  const [busy, setBusy] = useState(false);
  async function startAgain() {
    setBusy(true);
    try {
      const out = await api.startPacketAfterOffer(candidateId);
      toastOk?.(out.intakeUrl ? `Hiring packet started again - ${out.subjectName} was emailed a new link for their details.` : 'Hiring packet started.');
      load(); onChanged?.();
    } catch (e) { toastErr?.(e?.message || 'Could not start the hiring packet.'); }
    setBusy(false);
  }
  if (events === null) return <div style={{ padding: '8px 0' }}><Spinner size={16} /></div>;
  if (!shown.length) return null;
  return (
    <>
      {shown.map(ev => <LifeEventCard key={ev.id} ev={ev} onSignNow={onSignNow} toastOk={toastOk} toastErr={toastErr} hideSign={hideSign}
        onChanged={() => { load(); onChanged?.(); }} />)}
      {restart && (
        <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 12.5 }}>
          <span style={{ color: 'var(--muted)' }}>Their hiring packet is {hireEv.status} - their right to work paperwork is not done.</span>
          <button type="button" className="primary-btn" onClick={startAgain} disabled={busy} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            {busy ? <Spinner size={12} /> : <Send size={12} />} Start Hiring Packet Again
          </button>
        </div>
      )}
    </>
  );
}

// The letters on a person (People > profile). Above the tabs: only what HR
// still acts on - out for details or signature, a scheduled last day, a
// packet that did not start, a failed apply, a recent decline. Signed ones
// (`signed`) are one line each on the Documents tab, their Egnyte filing
// with them - so an Egnyte outage never pins a card to the header (Neil,
// Oct 22 1:01:35: "how do I get these two things off of here?").
export function PersonLifeEvents({ employeeId, workEmail = '', refreshKey, onSignNow, onChanged, toastOk, toastErr, signed = false }) {
  const [events, setEvents] = useState([]);
  const load = () => api.getLifeEvents({ employeeId }).then(setEvents).catch(() => setEvents([]));
  useEffect(() => { load(); }, [employeeId, refreshKey]);
  const recent = Date.now() - 14 * 86400000;
  const shown = signed ? events.filter(e => e.status === 'completed' && !noPaperwork(e))
    : events.filter(e => ['intake', 'review', 'awaiting_sender', 'sent'].includes(e.status) || e.applyStatus === 'scheduled'
      || (e.kind === 'offer' && (e.flags || []).some(f => f.code === 'packet_not_started'))
      || (e.flags || []).some(f => f.code === 'apply_failed')
      || (['declined', 'expired'].includes(e.status) && new Date(e.createdAt).getTime() > recent));
  // A signed packet waiting for its Egnyte filing: the server files it within
  // a minute or two (then retries with backoff), so re-read this card while
  // one is pending - it used to sit on "Filing in Egnyte..." until a reload.
  // Bounded: every 30 seconds for up to 10 minutes per profile open.
  const filingPending = shown.some(e => e.status === 'completed' && e.filingStatus === 'pending');
  const polls = useRef(0);
  useEffect(() => { polls.current = 0; }, [employeeId]);
  useEffect(() => {
    if (!filingPending || polls.current >= 20) return undefined;
    const t = setTimeout(() => { polls.current += 1; load(); }, 30000);
    return () => clearTimeout(t);
  }, [filingPending, events]);   // eslint-disable-line react-hooks/exhaustive-deps
  if (!shown.length) return null;
  // A cancel or void changes the person too (People re-reads - Oct 20 2026).
  const cards = shown.map(ev => <LifeEventCard key={ev.id} ev={ev} egnyteEmail={workEmail} compact={signed} filing={signed}
    onSignNow={onSignNow} onChanged={() => { load(); onChanged?.(); }} toastOk={toastOk} toastErr={toastErr} />);
  if (!signed) return <div>{cards}</div>;
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--ink)', marginBottom: 4 }}>Signed Paperwork</div>
      {cards}
    </div>
  );
}

// Right to work compliance (Neil, Oct 14): "they can't receive their first
// paycheck until they complete X amount of paperwork." The hiring packet that
// follows a signed offer, as one line HR can't miss on the profile and on the
// Compliance tab - complete, or what it is waiting on.
const PAPERWORK_WAIT = {
  intake: 'waiting for them to fill in their details (no login)',
  review: 'waiting for HR to verify the documents',
  awaiting_sender: 'waiting for the company to sign',
  sent: 'waiting for them to sign (no login)',
  declined: 'they declined it - fix it and send it again',
  expired: 'the link expired - send it again',
};
export function paperworkState(events) {
  const hires = (events || []).filter(e => e.kind === 'hire');
  const ev = hires.find(e => e.status !== 'voided') || null;
  // Only voided ones after a signed offer: still not done - say so.
  if (!ev && hires.length && (events || []).some(e => e.kind === 'offer' && e.status === 'completed')) {
    return { done: false, ev: hires[0], why: 'the hiring packet was voided - start it again from their Hiring card' };
  }
  const offer = (events || []).find(e => e.kind === 'offer' && e.status === 'completed');
  if (ev?.status === 'completed') return { done: true, ev };
  if (ev) return { done: false, ev, why: PAPERWORK_WAIT[ev.status] || ev.status };
  const stuck = offer && (offer.flags || []).find(f => f.code === 'packet_not_started');
  if (stuck) return { done: false, ev: offer, why: `the hiring packet has not started - ${stuck.message}` };
  return null;          // hired before offers and packets, or not hired through Nexus
}
// `pendingOnly` (the profile header): gone once signed - Compliance keeps the
// done line (Neil, Oct 22 19:20: the Overview "has gotten so messy").
export function PaperworkStatus({ employeeId, refreshKey, pendingOnly = false }) {
  const [events, setEvents] = useState(null);
  useEffect(() => { api.getLifeEvents({ employeeId }).then(setEvents).catch(() => setEvents([])); }, [employeeId, refreshKey]);
  const st = paperworkState(events);
  if (!st || (pendingOnly && st.done)) return null;
  const tone = st.done ? 'green' : ['declined', 'expired'].includes(st.ev?.status) ? 'red' : 'orange';
  return (
    <div role="status" style={{ display: 'flex', gap: 10, alignItems: 'flex-start', borderRadius: 12, padding: '10px 14px', margin: '10px 0',
      background: `hsla(var(--color-${tone}),0.08)`, border: `1px solid hsla(var(--color-${tone}),0.3)` }}>
      {st.done ? <CheckCircle size={16} style={{ color: `hsl(var(--color-${tone}))`, flexShrink: 0, marginTop: 1 }} />
        : <AlertTriangle size={16} style={{ color: `hsl(var(--color-${tone}))`, flexShrink: 0, marginTop: 1 }} />}
      <div style={{ fontSize: 12.5, lineHeight: 1.5 }}>
        <b>{st.done ? 'Onboarding Paperwork Complete' : 'Onboarding Paperwork Not Complete'}</b>
        <div style={{ color: 'var(--muted)' }}>
          {st.done ? `Their hiring packet was signed${st.ev.completedAt ? ` on ${formatDateTime(st.ev.completedAt)}` : ''} - right to work paperwork is on file.`
            : `Hold their first paycheck until it is signed - ${st.why}.`}
        </div>
      </div>
    </div>
  );
}

// Whether an offer letter or packet is out (so the Offer stage hides "Make
// Offer" / "Send" and shows the status).
export function packetIsActive(events) {
  return (events || []).some(e => ['offer', 'hire'].includes(e.kind) && ['intake', 'review', 'awaiting_sender', 'sent'].includes(e.status));
}

// A packet built from the Documents module (Neil, Oct 14): "we add the
// documents on the document module, and then ... create packages, so it pulls
// from the document module and it pulls in the appropriate documents".
//
//   Documents      - templates from Documents > Templates, in order. The packet
//                    stores which templates, never a copy: an edit published in
//                    Documents is the edit, for every packet that uses it.
//   Signing Order  - by ROLE, never by person ("HR has to do this, this
//                    person's manager has to do this"). The same roles People
//                    > Checklists uses, plus the company's Authorized Signatory;
//                    each step shows who holds that role today.
//   Verified By    - the role whose holder checks the filled-in documents
//                    before anything goes out for signature.
//   Signs Once     - a company step (HR, Authorized Signatory...) can sign
//                    the packet ONCE; that signature then goes on every packet
//                    until someone else holds the role (Pranshu, Oct 14).
//   Details Form   - what the new hire fills in on their link beyond name,
//                    phone, address and emergency contact: any country, any
//                    field, each a {{variable}} the templates print.
//
// The server (backend/hr_packet_docs.py) owns every rule; the problems it
// returns are shown as they are.
import { useEffect, useMemo, useState } from 'react';
import { X, Plus, Trash2, FileText, ChevronUp, ChevronDown, CheckCircle, AlertTriangle, Eye, ExternalLink, ListChecks, PenTool, Heading } from 'lucide-react';
import { api } from '../api';
import { setPendingOpen } from '../lib/pendingOpen';
import { flowFor, keyLabel, formKey, readinessSummary } from '../lib/packetFlow';
import { Spinner } from './AsyncState';
import SignOnceModal from './SignOnceModal';
import PacketReadiness from './PacketReadiness';
import { formatDate } from '../lib/datetime';

const lbl = { fontSize: 11, fontWeight: 700, color: 'var(--muted)', display: 'block', margin: '14px 0 5px', textTransform: 'uppercase', letterSpacing: '.04em' };
const hint = { fontSize: 11.5, color: 'var(--muted)', marginTop: 5, lineHeight: 1.5 };
const iconBtn = { padding: '4px 6px', display: 'inline-flex', alignItems: 'center' };

const Problem = ({ children }) => (
  <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', background: 'hsla(var(--color-orange),0.1)', color: 'hsl(var(--color-orange))', borderRadius: 10, padding: '8px 12px', fontSize: 12, marginTop: 8 }}>
    <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} /><span>{children}</span>
  </div>
);
const Chip = ({ tone = 'gray', children, title }) => (
  <span title={title} style={{ padding: '2px 8px', borderRadius: 10, fontSize: 10.5, fontWeight: 700, whiteSpace: 'nowrap',
    background: tone === 'gray' ? 'var(--mist)' : `hsla(var(--color-${tone}),0.12)`,
    color: tone === 'gray' ? 'var(--muted)' : `hsl(var(--color-${tone}))` }}>{children}</span>
);

// Roles the company holds - only these can Sign Once (the server re-checks).
const ONCE_ROLES = (role) => !['employee', 'manager', 'sender'].includes(role);
const FIELD_TYPES = [['text', 'Text'], ['longtext', 'Long Text'], ['number', 'Number'], ['date', 'Date'], ['email', 'Email'],
  ['phone', 'Phone'], ['yesno', 'Yes / No'], ['choice', 'Dropdown']];

function PreviewModal({ templateId, name, companyId, flow, letterheadId, onClose, toastErr }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    let made = '';
    api.renderPacketPreview({ template_id: templateId, entity_id: companyId || '', flow, letterhead_id: letterheadId || '' })
      .then(({ blob }) => { made = URL.createObjectURL(blob); setUrl(made); })
      .catch(e => { toastErr(e?.message || 'Could not render the preview.'); onClose(); });
    return () => { if (made) URL.revokeObjectURL(made); };
  }, [templateId]);   // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div onClick={e => e.target === e.currentTarget && onClose()}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: 'var(--card)', borderRadius: 16, width: '100%', maxWidth: 'clamp(560px, 60vw, 1000px)', height: 'min(92dvh, 900px)', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)', fontFamily: 'Inter,sans-serif' }}>
        <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 800, fontSize: 14 }}>{name} - Preview With Sample Person</div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>The published version, filled with a sample person. Anything Nexus would ask for shows in [brackets].</div>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        {url ? <iframe title="Packet document preview" src={url} style={{ flex: 1, border: 'none', borderRadius: '0 0 16px 16px' }} />
          : <div style={{ display: 'flex', justifyContent: 'center', padding: 50 }}><Spinner size="section" /></div>}
      </div>
    </div>
  );
}

/** The editor. `packet` is a saved documents row from /hr/packets (null for a
 *  new one, or a seed like {roleIds}); `catalog` is that same response. */
export function DocumentsPacketEditor({ packet, event, eventLabel, companyId, companyName, defaultSubfolder, catalog, onClose, onSaved, toastErr }) {
  const [p, setP] = useState(() => ({
    id: packet?.engine === 'documents' ? packet.id : '',
    name: packet?.name || '',
    roleIds: packet?.roleIds || [],
    docIds: packet?.docTemplateIds || [],
    flow: packet?.flow?.map(({ key, role, action, once }) => ({ key, role, action, ...(once ? { once: true } : {}) })) || [],
    detailsForm: (packet?.detailsForm || []).map(f => ({ ...f, options: f.options || [] })),
    verifyRole: packet?.verifyRole || 'hr',
    letterheadId: packet?.letterheadId || '',
    payMode: packet?.payMode || '',
    emailMessage: packet?.emailMessage || '',
    egnyteSubfolder: packet?.egnyteSubfolder || '',
  }));
  const [companyRoles, setCompanyRoles] = useState(null);
  const [holders, setHolders] = useState(null);
  const [letterheads, setLetterheads] = useState([]);
  const [busy, setBusy] = useState(false);
  const [serverProblems, setServerProblems] = useState([]);
  const [preview, setPreview] = useState(null);
  const [adding, setAdding] = useState('');
  const [onceStatus, setOnceStatus] = useState(packet?.signOnce || []);
  const [signing, setSigning] = useState(null);
  // Ready To Send (Oct 14): the server's checklist for the saved packet.
  const [readiness, setReadiness] = useState(packet?.engine === 'documents' ? (packet.readiness || []) : []);
  const [formNote, setFormNote] = useState('');
  const refreshReady = () => {
    if (!p.id) return;
    api.packetReadiness(p.id).then(r => setReadiness(r.readiness || [])).catch(() => {});
    if (companyId) api.signOnceStatus(p.id, companyId).then(setOnceStatus).catch(() => {});
  };
  const set = (k, v) => { setP(x => ({ ...x, [k]: v })); setServerProblems([]); };
  // Who signs once for this company, and whether they have (with isMe).
  useEffect(() => {
    if (!p.id || !companyId) return;
    api.signOnceStatus(p.id, companyId).then(setOnceStatus).catch(() => {});
  }, [p.id, companyId]);

  useEffect(() => { api.hiringOptions(companyId || '').then(o => setCompanyRoles(o.roles || [])).catch(() => setCompanyRoles([])); }, [companyId]);
  useEffect(() => { api.packetRoleHolders(companyId || '').then(setHolders).catch(() => setHolders({})); }, [companyId]);
  useEffect(() => { api.getDocLetterheads().then(setLetterheads).catch(() => setLetterheads([])); }, []);

  const templates = useMemo(() => catalog?.docTemplates || [], [catalog]);
  const byId = useMemo(() => Object.fromEntries(templates.map(t => [t.id, t])), [templates]);
  const docs = p.docIds.map(id => byId[id] || { id, name: 'A template that is no longer active', missing: true, signs: [] });
  const roleOpts = catalog?.flowRoles || [];
  const verifyOpts = catalog?.verifyRoles || [];
  const actionOpts = catalog?.actions || [];
  const today = (role) => {
    if (role === 'employee') return event === 'hire' ? 'the new hire' : event === 'separation' ? 'the person leaving' : 'the employee';
    if (role === 'manager') return event === 'hire' ? 'the supervisor on the offer' : 'their manager';
    if (role === 'sender') return 'whoever starts it';
    if (!holders) return '...';
    const h = holders[role];
    return h?.email ? `today: ${h.name}` : 'nobody yet';
  };

  const setDocs = (ids) => {
    const nextDocs = ids.map(id => byId[id]).filter(Boolean);
    setP(x => ({ ...x, docIds: ids, flow: flowFor(x.flow, nextDocs, event) }));
    setServerProblems([]);
  };
  const move = (list, i, d) => { const n = [...list]; const j = i + d; if (j < 0 || j >= n.length) return list; [n[i], n[j]] = [n[j], n[i]]; return n; };
  const setStep = (i, patch) => set('flow', p.flow.map((s, j) => j === i ? { ...s, ...patch } : s));
  const addStep = () => {
    let key = 'copy'; let n = 1;
    while (p.flow.some(s => s.key === key)) { n += 1; key = `copy_${n}`; }
    const at = p.flow.findIndex(s => s.role === 'employee');
    const step = { key, role: 'hr', action: 'copy' };
    set('flow', at >= 0 && event !== 'promotion' ? [...p.flow.slice(0, at), step, ...p.flow.slice(at)] : [...p.flow, step]);
  };

  // ── Details Form ──
  const formKeys = new Set(p.detailsForm.map(f => f.key || formKey(f.label)).filter(Boolean));
  const wanted = [];
  docs.forEach(d => (d.variables || []).forEach(v => {
    if (!formKeys.has(v.token) && !wanted.some(w => w.token === v.token)) wanted.push(v);
  }));
  const setField = (i, patch) => set('detailsForm', p.detailsForm.map((f, j) => j === i ? { ...f, ...patch } : f));
  // The checklist's "Add To Details Form": every variable nothing fills, in one go.
  const addVariables = (vars) => {
    const have = new Set(p.detailsForm.map(f => f.key || formKey(f.label)));
    const add = vars.filter(v => !have.has(v.token)).map(v => ({ key: v.token, label: v.label, required: true, sensitive: false, last4: false, options: [],
      type: ['date', 'email', 'number'].includes(v.type) ? v.type : 'text' }));
    if (add.length) set('detailsForm', [...p.detailsForm, ...add]);
    setFormNote(`Added ${add.length} field${add.length === 1 ? '' : 's'} to the Details Form below - click Save Packet to keep them.`);
  };
  const summary = readinessSummary(readiness);
  const addField = (f) => set('detailsForm', [...p.detailsForm, { label: '', type: 'text', required: false, sensitive: false, last4: false, options: [], ...f }]);

  // Quick checks while typing; the server's full list arrives on Save.
  const local = [];
  if (!p.name.trim()) local.push('Give the packet a name.');
  if (!p.docIds.length) local.push('Add at least one document from Documents > Templates.');
  docs.filter(d => !d.missing && !d.publishedVersion).forEach(d => local.push(`"${d.name}" has not been published yet - open it in Documents and click Publish.`));
  if (!p.flow.some(s => s.role === 'employee')) local.push('One step must be The Person (the one the packet is about).');
  p.detailsForm.forEach(f => { if (!String(f.label || '').trim()) local.push('Every field on the Details Form needs a label.'); });
  const problems = [...new Set([...local, ...serverProblems])];

  async function save() {
    setBusy(true);
    try {
      const saved = await api.saveDocumentsPacket({
        id: p.id, entity_id: companyId || '', event, name: p.name.trim(), role_ids: p.roleIds,
        doc_template_ids: p.docIds, flow: p.flow, verify_role: p.verifyRole, letterhead_id: p.letterheadId,
        pay_mode: p.payMode, email_message: p.emailMessage, egnyte_subfolder: p.egnyteSubfolder,
        details_form: event === 'hire' ? p.detailsForm.map(({ key, label, type, required, sensitive, last4, options, help }) => ({
          key: key || '', label, type, required: !!required, sensitive: !!sensitive, last4: !!last4, options: options || [], help: help || '',
        })) : [],
      });
      // Stay open on the checklist: what is still missing shows at once.
      setP(x => ({ ...x, id: saved.id }));
      setReadiness(saved.readiness || []);
      onSaved(saved);
    } catch (e) {
      setServerProblems([e?.message || 'Could not save the packet.']);
    }
    setBusy(false);
  }
  const openTemplate = (id) => {
    setPendingOpen('doc-template', id);
    window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'documents', sub: 'documents-templates' } }));
  };
  const available = templates.filter(t => !p.docIds.includes(t.id));
  const who = event === 'hire' ? 'new hire' : event === 'promotion' ? 'employee' : 'person leaving';
  const verifyHolder = holders && holders[p.verifyRole];

  return (
    <div onClick={e => e.target === e.currentTarget && onClose()}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: 'var(--card)', borderRadius: 16, width: '100%', maxWidth: 'clamp(560px, 64vw, 1120px)', maxHeight: 'min(94dvh, 920px)', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)', fontFamily: 'Inter,sans-serif' }}>
        <div style={{ padding: '16px 22px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 800, fontSize: 15.5 }}>{p.id ? 'Edit' : 'New'} {eventLabel} - {companyName}</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 1 }}>Built from Documents &gt; Templates. The wording is edited there; this packet always uses the published version.</div>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        <div style={{ overflowY: 'auto', flex: 1, padding: '2px 22px 18px' }}>
          {p.id && readiness.length > 0 && (
            <div style={{ border: '1px solid var(--line)', borderRadius: 12, padding: '10px 12px', marginTop: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <b style={{ fontSize: 13 }}>Ready To Send</b>
                {summary && <Chip tone={summary.tone}>{summary.label}</Chip>}
                <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>Everything a hire needs before this packet can go out.</span>
              </div>
              <PacketReadiness checks={readiness} toastErr={toastErr}
                meEmails={onceStatus.filter(s => s.isMe).map(s => s.email)}
                onChanged={refreshReady}
                onSignOnce={(step) => setSigning(onceStatus.find(s => s.key === step) || { key: step, roleLabel: 'HR', name: '' })}
                onAddToForm={addVariables} />
              {formNote && <div style={{ ...hint, color: 'hsl(var(--color-orange))' }}>{formNote}</div>}
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '0 16px' }}>
            <div>
              <label style={lbl}>Packet Name</label>
              <input className="form-input" style={{ width: '100%' }} value={p.name} onChange={e => set('name', e.target.value)} placeholder={`e.g. ${eventLabel} - IT Dev Associate`} autoFocus />
            </div>
            <div>
              <label style={lbl}>For Which Role</label>
              {companyRoles === null ? <Spinner size={14} /> : (
                <select className="form-input" style={{ width: '100%' }} value={p.roleIds[0] || ''} onChange={e => set('roleIds', e.target.value ? [e.target.value] : [])}>
                  <option value="">Every role</option>
                  <optgroup label={`${companyName || 'Company'} Roles`}>
                    {companyRoles.filter(r => r.companyId).map(r => <option key={r.id} value={r.id}>{r.name}{r.department ? ` - ${r.department}` : ''}</option>)}
                  </optgroup>
                  <optgroup label="Shared Roles">
                    {companyRoles.filter(r => !r.companyId).map(r => <option key={r.id} value={r.id}>{r.name}{r.department ? ` - ${r.department}` : ''}</option>)}
                  </optgroup>
                </select>
              )}
            </div>
          </div>
          <div style={hint}>Nexus picks the packet by company and job role when {event === 'hire' ? 'a candidate reaches Offer' : event === 'promotion' ? 'someone is promoted' : 'someone is offboarded'}. "Every role" covers the roles with no packet of their own.</div>

          <label style={lbl}>Documents (From Documents &gt; Templates)</label>
          {docs.length === 0 && (
            <div style={{ fontSize: 12.5, color: 'var(--muted)', border: '1px dashed var(--line)', borderRadius: 12, padding: '12px 14px' }}>
              No documents yet. Add the offer letter, NDA, addendums - each its own template, written once in Documents with variables and signature blocks.
            </div>
          )}
          {docs.map((d, i) => (
            <div key={d.id} style={{ border: '1px solid var(--line)', borderRadius: 12, padding: '10px 12px', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ width: 22, height: 22, borderRadius: '50%', background: 'var(--mist)', fontSize: 11, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{i + 1}</span>
              <FileText size={16} style={{ color: 'var(--pine)', flexShrink: 0 }} />
              <div style={{ flex: '1 1 220px', minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</div>
                <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 4, alignItems: 'center' }}>
                  {d.missing ? <Chip tone="red">Not Available</Chip>
                    : !d.publishedVersion ? <Chip tone="orange" title="Open it in Documents and click Publish">Not Published</Chip>
                      : <Chip tone="green">Published v{d.publishedVersion}</Chip>}
                  {d.hasUnpublishedChanges && <Chip tone="orange" title="Someone is editing it - packets keep the published version until Publish Changes">Unpublished Changes</Chip>}
                  <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                    {(d.signs || []).length ? `Signs: ${d.signs.map(keyLabel).join(', ')}` : 'No signature blocks'}
                  </span>
                </div>
              </div>
              {!d.missing && d.publishedVersion > 0 && (
                <button type="button" className="secondary-btn" onClick={() => setPreview(d)} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}><Eye size={12} /> Preview</button>
              )}
              {!d.missing && (
                <button type="button" className="secondary-btn" onClick={() => openTemplate(d.id)} title="Edit the wording in Documents" style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}><ExternalLink size={12} /> Open In Documents</button>
              )}
              <button type="button" className="secondary-btn" disabled={i === 0} onClick={() => setDocs(move(p.docIds, i, -1))} style={iconBtn} aria-label="Move up"><ChevronUp size={13} /></button>
              <button type="button" className="secondary-btn" disabled={i === docs.length - 1} onClick={() => setDocs(move(p.docIds, i, 1))} style={iconBtn} aria-label="Move down"><ChevronDown size={13} /></button>
              <button type="button" className="secondary-btn" onClick={() => setDocs(p.docIds.filter(x => x !== d.id))} style={iconBtn} aria-label="Remove document"><Trash2 size={13} /></button>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 4 }}>
            <select className="form-input" style={{ flex: '1 1 260px', maxWidth: 420 }} value={adding} onChange={e => setAdding(e.target.value)}>
              <option value="">{available.length ? 'Pick a template to add...' : 'Every active template is already in this packet'}</option>
              {available.map(t => <option key={t.id} value={t.id}>{t.name}{t.publishedVersion ? '' : ' (Not Published)'}</option>)}
            </select>
            <button type="button" className="secondary-btn" disabled={!adding} onClick={() => { setDocs([...p.docIds, adding]); setAdding(''); }}
              style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}><Plus size={12} /> Add Document</button>
          </div>
          <div style={hint}>The Job Description is picked per {who} when the packet starts - it does not need to be here.</div>

          <label style={lbl}>Signing Order (By Role)</label>
          {p.flow.length === 0 && <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Add a document - each signer its signature blocks name gets a step here.</div>}
          {p.flow.map((s, i) => (
            <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7, flexWrap: 'wrap' }}>
              <span style={{ width: 22, height: 22, borderRadius: '50%', background: 'var(--mist)', fontSize: 11, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{i + 1}</span>
              <span style={{ fontSize: 12.5, fontWeight: 700, width: 110, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={`Signature blocks for "${s.key}"`}>{keyLabel(s.key)}</span>
              <select className="form-input" style={{ width: 190 }} value={s.role} onChange={e => setStep(i, { role: e.target.value })} aria-label="Role">
                {roleOpts.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
              </select>
              <select className="form-input" style={{ width: 140 }} value={s.action} onChange={e => setStep(i, { action: e.target.value })} aria-label="Action">
                {actionOpts.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
              </select>
              {s.action === 'sign' && ONCE_ROLES(s.role) && (
                <label title="The company signs this packet once - that signature then goes on every packet automatically"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                  <input type="checkbox" checked={!!s.once} onChange={e => setStep(i, { once: e.target.checked || undefined })} style={{ accentColor: 'var(--pine)' }} />
                  Signs Once
                </label>
              )}
              <span style={{ fontSize: 11.5, color: 'var(--muted)', flex: 1, minWidth: 120 }}>{today(s.role)}</span>
              <button type="button" className="secondary-btn" disabled={i === 0} onClick={() => set('flow', move(p.flow, i, -1))} style={iconBtn} aria-label="Move up"><ChevronUp size={13} /></button>
              <button type="button" className="secondary-btn" disabled={i === p.flow.length - 1} onClick={() => set('flow', move(p.flow, i, 1))} style={iconBtn} aria-label="Move down"><ChevronDown size={13} /></button>
              <button type="button" className="secondary-btn" onClick={() => set('flow', p.flow.filter((_, j) => j !== i))} style={iconBtn} aria-label="Remove step"><Trash2 size={13} /></button>
            </div>
          ))}
          <button type="button" className="secondary-btn" onClick={addStep} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}><Plus size={12} /> Add Step</button>
          <div style={hint}>
            Roles are the same ones People &gt; Checklists uses - change who holds HR, IT or Payroll there (or the company's HR contact and Authorized Signatory in People &gt; Companies) and every packet follows.
            {event !== 'promotion' && ` The ${who} signs last.`}
          </div>

          {p.flow.some(s => s.once) && (
            <>
              <label style={lbl}>Company Signature (Signs Once)</label>
              {!p.id || !companyId ? (
                <div style={hint}>{!p.id ? 'Save the packet, then the person who holds the role signs it once here.'
                  : 'This packet is for every company - each company\'s signer signs once, the first time it is sent for them (from the packet\'s review).'}</div>
              ) : onceStatus.map(s => (
                <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', border: '1px solid var(--line)', borderRadius: 12, padding: '10px 12px', marginBottom: 8 }}>
                  <PenTool size={15} style={{ color: s.signed ? 'hsl(var(--color-green))' : 'hsl(var(--color-orange))', flexShrink: 0 }} />
                  <div style={{ flex: '1 1 240px', fontSize: 12.5 }}>
                    <b>{s.roleLabel}</b> - {s.name || 'nobody holds this role yet'}
                    <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
                      {s.signed ? `Signed once on ${formatDate(s.adoptedAt)} - applied to every packet automatically.`
                        : s.previous ? `${s.previous.name} signed before, but ${s.name || 'someone else'} holds ${s.roleLabel} now - they sign once before the next packet can go.`
                          : 'Not signed yet - nothing can be sent until they sign once.'}
                    </div>
                  </div>
                  {s.signed ? <Chip tone="green">Signed</Chip> : s.isMe
                    ? <button type="button" className="primary-btn" onClick={() => setSigning(s)} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}><PenTool size={12} /> Sign Once</button>
                    : <Chip tone="orange">Waiting For {s.name || s.roleLabel}</Chip>}
                </div>
              ))}
            </>
          )}

          {event === 'hire' && (
            <>
              <label style={lbl}>Details Form</label>
              <div style={hint}>
                Name, phone, address and emergency contact are always asked. Add anything else this packet needs - an ID number, bank details, date of birth -
                for any country. Each field is a variable the templates print, shown as <code>{'{{like_this}}'}</code>.
              </div>
              {wanted.length > 0 && (
                <div style={{ border: '1px dashed var(--line)', borderRadius: 12, padding: '10px 12px', marginTop: 8, fontSize: 12.5 }}>
                  Your documents also print these, and nothing fills them yet:
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                    {wanted.map(v => (
                      <button key={v.token} type="button" className="secondary-btn" onClick={() => addField({ key: v.token, label: v.label, type: ['date', 'email', 'number'].includes(v.type) ? v.type : 'text' })}
                        style={{ fontSize: 11.5, padding: '3px 10px', display: 'inline-flex', alignItems: 'center', gap: 4 }}><Plus size={11} /> {v.label}</button>
                    ))}
                  </div>
                  <div style={{ ...hint, marginTop: 6 }}>Add each to the form, or give it a Default Value in the template if it is the same for everyone (a client name).</div>
                </div>
              )}
              {p.detailsForm.map((f, i) => f.type === 'heading' ? (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
                  <Heading size={14} style={{ color: 'var(--muted)' }} />
                  <input className="form-input" style={{ flex: 1, fontWeight: 700 }} value={f.label} placeholder="Section heading, e.g. Bank Details" onChange={e => setField(i, { label: e.target.value })} />
                  <button type="button" className="secondary-btn" disabled={i === 0} onClick={() => set('detailsForm', move(p.detailsForm, i, -1))} style={iconBtn} aria-label="Move up"><ChevronUp size={13} /></button>
                  <button type="button" className="secondary-btn" disabled={i === p.detailsForm.length - 1} onClick={() => set('detailsForm', move(p.detailsForm, i, 1))} style={iconBtn} aria-label="Move down"><ChevronDown size={13} /></button>
                  <button type="button" className="secondary-btn" onClick={() => set('detailsForm', p.detailsForm.filter((_, j) => j !== i))} style={iconBtn} aria-label="Remove heading"><Trash2 size={13} /></button>
                </div>
              ) : (
                <div key={i} style={{ border: '1px solid var(--line)', borderRadius: 12, padding: '10px 12px', marginTop: 8 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <input className="form-input" style={{ flex: '1 1 200px' }} value={f.label} placeholder="Label, e.g. PAN Number" onChange={e => setField(i, { label: e.target.value })} aria-label="Field label" />
                    <select className="form-input" style={{ width: 150 }} value={f.type} onChange={e => setField(i, { type: e.target.value, ...(e.target.value === 'text' || e.target.value === 'number' ? {} : { last4: false }) })} aria-label="Field type">
                      {FIELD_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                    </select>
                    <code style={{ fontSize: 11, color: 'var(--muted)' }}>{`{{${f.key || formKey(f.label) || '...'}}}`}</code>
                    <button type="button" className="secondary-btn" disabled={i === 0} onClick={() => set('detailsForm', move(p.detailsForm, i, -1))} style={iconBtn} aria-label="Move up"><ChevronUp size={13} /></button>
                    <button type="button" className="secondary-btn" disabled={i === p.detailsForm.length - 1} onClick={() => set('detailsForm', move(p.detailsForm, i, 1))} style={iconBtn} aria-label="Move down"><ChevronDown size={13} /></button>
                    <button type="button" className="secondary-btn" onClick={() => set('detailsForm', p.detailsForm.filter((_, j) => j !== i))} style={iconBtn} aria-label="Remove field"><Trash2 size={13} /></button>
                  </div>
                  <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 8, fontSize: 12 }}>
                    {[['required', 'Required', 'They cannot send the form without it'],
                      ['sensitive', 'Sensitive', 'Bank details, ID numbers: only people with Pay & Benefits access see it or the documents that print it'],
                      ...(f.type === 'text' || f.type === 'number' ? [['last4', 'Last 4 Only', 'Only the last 4 characters are kept - and printed (XXXX 1234). For national ID numbers']] : [])].map(([k, l, t]) => (
                      <label key={k} title={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
                        <input type="checkbox" checked={!!f[k]} onChange={e => setField(i, { [k]: e.target.checked })} style={{ accentColor: 'var(--pine)' }} /> {l}
                      </label>
                    ))}
                  </div>
                  {f.type === 'choice' && (
                    <input className="form-input" style={{ width: '100%', marginTop: 8 }} placeholder="Choices, separated by commas - e.g. Savings, Current"
                      value={(f.options || []).join(', ')} onChange={e => setField(i, { options: e.target.value.split(',').map(x => x.trim()).filter(Boolean) })} aria-label="Choices" />
                  )}
                </div>
              ))}
              <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                <button type="button" className="secondary-btn" onClick={() => addField({})} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}><Plus size={12} /> Add Field</button>
                <button type="button" className="secondary-btn" onClick={() => addField({ type: 'heading' })} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}><Heading size={12} /> Add Section Heading</button>
              </div>
            </>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '0 16px' }}>
            <div>
              <label style={lbl}>Verified By</label>
              <select className="form-input" style={{ width: '100%' }} value={p.verifyRole} onChange={e => set('verifyRole', e.target.value)}>
                {verifyOpts.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
              </select>
              <div style={hint}>Checks every filled-in document before anything is sent{verifyHolder?.email ? ` - today: ${verifyHolder.name}` : holders ? ' - nobody holds this role yet' : ''}. Only they can send it.</div>
            </div>
            <div>
              <label style={lbl}>Letterhead</label>
              <select className="form-input" style={{ width: '100%' }} value={p.letterheadId} onChange={e => set('letterheadId', e.target.value)}>
                <option value="">Template's Own</option>
                {letterheads.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
              <div style={hint}>Used by the templates that require a letterhead. Pick this company's own.</div>
            </div>
            <div>
              <label style={lbl}>Pay</label>
              <select className="form-input" style={{ width: '100%' }} value={p.payMode} onChange={e => set('payMode', e.target.value)}>
                <option value="">{event === 'separation' ? 'By Event - Where A Document Prints Pay' : 'By Event - Every Document Shows Pay'}</option>
                <option value="always">Treat Every Document As Showing Pay</option>
                <option value="auto">Only Where A Document Prints Pay</option>
              </select>
              <div style={hint}>Who can open these documents. Changing it needs Pay &amp; Benefits access.</div>
            </div>
          </div>

          <label style={lbl}>When Signed</label>
          <div style={{ fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 8 }}>
            <ListChecks size={14} style={{ color: 'var(--muted)' }} />
            {event === 'hire' ? 'They are hired, and their Onboarding Checklist starts (People > Checklists).'
              : event === 'promotion' ? 'The new role, title and pay apply from the effective date.'
                : 'Their Offboarding Checklist starts with the offboarding (People > Checklists).'}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '0 16px' }}>
            <div>
              <label style={lbl}>Welcome Note In The Email</label>
              <textarea className="form-input" rows={2} style={{ width: '100%', resize: 'vertical', fontFamily: 'Inter,sans-serif', fontSize: 13 }}
                placeholder="Welcome to the team! Please review and sign your documents."
                value={p.emailMessage} onChange={e => set('emailMessage', e.target.value)} />
            </div>
            <div>
              <label style={lbl}>Egnyte Subfolder</label>
              <input className="form-input" style={{ width: '100%' }} value={p.egnyteSubfolder} onChange={e => set('egnyteSubfolder', e.target.value)} placeholder={defaultSubfolder || 'Hiring Documents'} />
              <div style={hint}>Inside the {who}'s own folder. Blank uses "{defaultSubfolder || 'Hiring Documents'}".</div>
            </div>
          </div>

          {problems.map(x => <Problem key={x}>{x}</Problem>)}
        </div>
        <div style={{ padding: '12px 22px', borderTop: '1px solid var(--line)', display: 'flex', gap: 8, justifyContent: 'flex-end', flexShrink: 0 }}>
          <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="primary-btn" onClick={save} disabled={busy || local.length > 0} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, opacity: local.length ? 0.6 : 1 }}>
            {busy ? <Spinner size={13} /> : <CheckCircle size={13} />} Save Packet
          </button>
        </div>
      </div>
      {signing && (
        <SignOnceModal packetId={p.id} entityId={companyId} step={signing} packetName={p.name} companyName={companyName}
          toastErr={toastErr} onClose={() => setSigning(null)} onDone={(status) => { setOnceStatus(status); setSigning(null); refreshReady(); }} />
      )}
      {preview && (
        <PreviewModal templateId={preview.id} name={preview.name} companyId={companyId} flow={p.flow}
          letterheadId={p.letterheadId} toastErr={toastErr} onClose={() => setPreview(null)} />
      )}
    </div>
  );
}

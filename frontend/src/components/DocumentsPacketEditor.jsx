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
//
// The server (backend/hr_packet_docs.py) owns every rule; the problems it
// returns are shown as they are.
import { useEffect, useMemo, useState } from 'react';
import { X, Plus, Trash2, FileText, ChevronUp, ChevronDown, CheckCircle, AlertTriangle, Eye, ExternalLink, ListChecks } from 'lucide-react';
import { api } from '../api';
import { setPendingOpen } from '../lib/pendingOpen';
import { flowFor, keyLabel } from '../lib/packetFlow';
import { Spinner } from './AsyncState';

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
    flow: packet?.flow?.map(({ key, role, action }) => ({ key, role, action })) || [],
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
  const set = (k, v) => { setP(x => ({ ...x, [k]: v })); setServerProblems([]); };

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

  // Quick checks while typing; the server's full list arrives on Save.
  const local = [];
  if (!p.name.trim()) local.push('Give the packet a name.');
  if (!p.docIds.length) local.push('Add at least one document from Documents > Templates.');
  docs.filter(d => !d.missing && !d.publishedVersion).forEach(d => local.push(`"${d.name}" has not been published yet - open it in Documents and click Publish.`));
  if (!p.flow.some(s => s.role === 'employee')) local.push('One step must be The Person (the one the packet is about).');
  const problems = [...new Set([...local, ...serverProblems])];

  async function save() {
    setBusy(true);
    try {
      const saved = await api.saveDocumentsPacket({
        id: p.id, entity_id: companyId || '', event, name: p.name.trim(), role_ids: p.roleIds,
        doc_template_ids: p.docIds, flow: p.flow, verify_role: p.verifyRole, letterhead_id: p.letterheadId,
        pay_mode: p.payMode, email_message: p.emailMessage, egnyte_subfolder: p.egnyteSubfolder,
      });
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
      {preview && (
        <PreviewModal templateId={preview.id} name={preview.name} companyId={companyId} flow={p.flow}
          letterheadId={p.letterheadId} toastErr={toastErr} onClose={() => setPreview(null)} />
      )}
    </div>
  );
}

// A packet - what a company sends through Nexus Sign for a life event
// (hiring packet, promotion letter, separation package), edited as ONE thing:
// which job roles it is for, who signs, the company's PDFs with the signature
// boxes placed once and Offer Fields that print each offer's pay and dates,
// an optional typed letter, the welcome note and the Egnyte subfolder.
// Nexus Sign only signs; the template behind a packet is Nexus's business,
// never HR's (Pranshu, Oct 8).
import { useEffect, useRef, useState } from 'react';
import { X, Plus, Trash2, FileText, UploadCloud, ChevronUp, ChevronDown, PenTool, CheckCircle, AlertTriangle } from 'lucide-react';
import { api } from '../api';
import { Spinner } from './AsyncState';
import { AttachmentPlacer, MERGE_FIELDS } from './ESign';

const MERGE_LABEL = Object.fromEntries(MERGE_FIELDS);
const DEFAULT_SIGNERS = {
  hire: [{ key: 'company', label: 'Company Representative' }, { key: 'employee', label: 'Employee / Candidate' }],
  promotion: [{ key: 'employee', label: 'Employee' }, { key: 'manager', label: 'Manager' }],
  separation: [{ key: 'company', label: 'Company Representative' }, { key: 'employee', label: 'Employee' }],
};
const SIGNER_HINT = {
  hire: 'The new hire signs last; you sign every other role when you send.',
  promotion: 'The employee signs first, then their manager.',
  separation: 'The person leaving signs last; you sign for the company when you send.',
};
const lbl = { fontSize: 11, fontWeight: 700, color: 'var(--muted)', display: 'block', margin: '12px 0 4px', textTransform: 'uppercase', letterSpacing: '.04em' };
const hint = { fontSize: 11.5, color: 'var(--muted)', marginTop: 4, lineHeight: 1.5 };
const Problem = ({ children }) => (
  <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', background: 'hsla(var(--color-orange),0.1)', color: 'hsl(var(--color-orange))', borderRadius: 10, padding: '8px 12px', fontSize: 12, marginTop: 8 }}>
    <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} /><span>{children}</span>
  </div>
);
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || 'signer';
const toParagraphs = (text) => String(text || '').split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);

/** What a document's placed fields add up to, for the list ("2 signatures · Salary"). */
export function describeFields(fields) {
  const fs = fields || [];
  const signs = fs.filter(f => f.type === 'sign').length;
  const merges = fs.filter(f => f.type === 'merge').map(f => MERGE_LABEL[f.merge] || 'Offer Field');
  const other = fs.length - signs - merges.length;
  const parts = [];
  if (signs) parts.push(`${signs} signature${signs === 1 ? '' : 's'}`);
  if (merges.length) parts.push(merges.join(', '));
  if (other) parts.push(`${other} other field${other === 1 ? '' : 's'}`);
  return parts.length ? parts.join(' · ') : 'No fields placed yet';
}

/** Why a packet cannot be saved as it stands, or [] when it can. */
export function templateProblems(t) {
  const out = [];
  if (!String(t.name || '').trim()) out.push('Give the packet a name.');
  const roles = (t.roles || []).filter(r => r.key);
  if (!roles.length) out.push('Add at least one signer.');
  const docs = (t.attachments || []).filter(a => a.path);
  const body = toParagraphs(t.bodyText);
  if (!docs.length && !body.length) out.push('Upload a PDF or type the letter - the packet is empty.');
  const signedRoles = new Set();
  docs.forEach(a => (a.fields || []).forEach(f => { if (f.type === 'sign' && f.role) signedRoles.add(f.role); }));
  body.forEach(p => { for (const m of p.matchAll(/\[\[sign:([a-z0-9_]+)\]\]/g)) signedRoles.add(m[1]); });
  roles.filter(r => !signedRoles.has(r.key)).forEach(r => out.push(`${r.label || r.key} has nowhere to sign - place a Signature box for them on a document, or put [[sign:${r.key}]] in the letter.`));
  return out;
}

/** "Every role" or the role names a packet is for. */
export function describeRoles(roleNames) {
  return roleNames?.length ? roleNames.join(', ') : 'Every role';
}

/** The one editor for a packet. `packet` is a saved row from /hr/packets
 *  (null for a new one); `event` is hire | promotion | separation. */
export function PacketEditor({ packet, event, eventLabel, companyId, companyName, defaultSubfolder, onClose, onSaved, toastErr }) {
  const [t, setT] = useState(() => ({
    id: packet?.id || '',
    name: packet?.templateName || '',
    roleIds: packet?.roleIds || [],
    roles: packet?.roles?.length ? packet.roles.map((r, i) => ({ ...r, order: r.order || i + 1 })) : DEFAULT_SIGNERS[event] || DEFAULT_SIGNERS.hire,
    attachments: packet?.attachments || [],
    bodyText: (packet?.body || []).join('\n\n'),
    emailMessage: packet?.emailMessage || '',
    egnyteSubfolder: packet?.egnyteSubfolder || '',
  }));
  const [companyRoles, setCompanyRoles] = useState(null);
  const [placing, setPlacing] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showLetter, setShowLetter] = useState(() => (packet?.body || []).length > 0);
  const fileRef = useRef(null);
  const set = (k, v) => setT(p => ({ ...p, [k]: v }));
  const problems = templateProblems(t);
  const roles = t.roles;
  useEffect(() => {
    api.hiringOptions(companyId || '').then(o => setCompanyRoles(o.roles || [])).catch(() => setCompanyRoles([]));
  }, [companyId]);

  async function upload(file) {
    if (!file) return;
    if (!/\.pdf$/i.test(file.name)) { toastErr('Only PDF files can be added to a packet.'); return; }
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const a = await api.uploadSignAttachment(form);
      set('attachments', [...t.attachments, { ...a, fields: [] }]);
    } catch (e) { toastErr(e?.message || 'Could not upload the PDF.'); }
    setUploading(false);
    if (fileRef.current) fileRef.current.value = '';
  }
  const move = (list, i, d) => { const n = [...list]; const j = i + d; if (j < 0 || j >= n.length) return list; [n[i], n[j]] = [n[j], n[i]]; return n; };
  const setRole = (i, patch) => set('roles', roles.map((r, j) => j === i ? { ...r, ...patch } : r));
  const addRole = () => {
    const label = `Signer ${roles.length + 1}`;
    let key = slug(label); while (roles.some(r => r.key === key)) key += '_';
    set('roles', [...roles, { key, label, order: roles.length + 1 }]);
  };
  const toggleRole = (id) => set('roleIds', t.roleIds.includes(id) ? t.roleIds.filter(x => x !== id) : [...t.roleIds, id]);
  async function save() {
    setBusy(true);
    try {
      const saved = await api.savePacketWhole({
        id: t.id, entity_id: companyId || '', event, name: t.name.trim(), role_ids: t.roleIds,
        signers: roles.map((r, i) => ({ key: r.key, label: (r.label || r.key).trim(), order: i + 1 })),
        attachments: t.attachments, body: toParagraphs(t.bodyText),
        email_message: t.emailMessage, egnyte_subfolder: t.egnyteSubfolder,
      });
      onSaved(saved);
    } catch (e) { toastErr(e?.message || 'Could not save the packet.'); }
    setBusy(false);
  }
  const who = event === 'hire' ? 'new hire' : event === 'promotion' ? 'employee' : 'person leaving';

  return (
    <div onClick={e => e.target === e.currentTarget && onClose()}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: 'var(--card)', borderRadius: 16, width: '100%', maxWidth: 'clamp(560px, 64vw, 900px)', maxHeight: 'min(92dvh, 880px)', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)', fontFamily: 'Inter,sans-serif' }}>
        <div style={{ padding: '16px 22px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 800, fontSize: 15.5 }}>{t.id ? 'Edit' : 'New'} {eventLabel} - {companyName}</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 1 }}>Your PDFs with the signature boxes placed once; Offer Fields print each offer's pay and dates at send.</div>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        <div style={{ overflowY: 'auto', flex: 1, padding: '4px 22px 18px' }}>
          <label style={lbl}>Packet Name</label>
          <input className="form-input" style={{ width: '100%' }} value={t.name} onChange={e => set('name', e.target.value)} placeholder={`e.g. ${eventLabel} - IT`} autoFocus />

          <label style={lbl}>For Which Roles</label>
          {companyRoles === null ? <Spinner size={14} /> : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              <button type="button" onClick={() => set('roleIds', [])}
                style={{ borderRadius: 999, padding: '5px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'Inter,sans-serif',
                  border: `1.5px solid ${t.roleIds.length === 0 ? 'var(--pine)' : 'var(--line)'}`, background: t.roleIds.length === 0 ? 'var(--mist)' : 'var(--card)', color: 'var(--ink)' }}>
                Every role
              </button>
              {companyRoles.map(r => {
                const on = t.roleIds.includes(r.id);
                return (
                  <button key={r.id} type="button" onClick={() => toggleRole(r.id)}
                    style={{ borderRadius: 999, padding: '5px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'Inter,sans-serif',
                      border: `1.5px solid ${on ? 'var(--pine)' : 'var(--line)'}`, background: on ? 'var(--mist)' : 'var(--card)', color: 'var(--ink)' }}>
                    {on ? '✓ ' : ''}{r.name}{r.department ? <span style={{ color: 'var(--muted)', fontWeight: 500 }}> · {r.department}</span> : null}
                  </button>
                );
              })}
            </div>
          )}
          <div style={hint}>Pick the job roles this packet is for - IT gets one packet, Accounting another. "Every role" is the packet for roles that have no packet of their own. A role can be in one packet only.</div>

          <label style={lbl}>Documents</label>
          {t.attachments.length === 0 && <div style={{ fontSize: 12.5, color: 'var(--muted)', border: '1px dashed var(--line)', borderRadius: 12, padding: '12px 14px' }}>No PDF yet. Upload your {eventLabel.toLowerCase()} - the offer letter, NDA and the rest can be one merged PDF or several.</div>}
          {t.attachments.map((a, i) => (
            <div key={a.path} style={{ border: '1px solid var(--line)', borderRadius: 12, padding: '10px 12px', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 10 }}>
              <FileText size={16} style={{ color: 'var(--pine)', flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{a.pages || '?'} page{a.pages === 1 ? '' : 's'} · {describeFields(a.fields)}</div>
              </div>
              <button type="button" className="secondary-btn" onClick={() => setPlacing(i)} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}><PenTool size={12} /> Place Fields</button>
              <button type="button" className="secondary-btn" disabled={i === 0} onClick={() => set('attachments', move(t.attachments, i, -1))} style={{ padding: '4px 6px' }} aria-label="Move up"><ChevronUp size={13} /></button>
              <button type="button" className="secondary-btn" disabled={i === t.attachments.length - 1} onClick={() => set('attachments', move(t.attachments, i, 1))} style={{ padding: '4px 6px' }} aria-label="Move down"><ChevronDown size={13} /></button>
              <button type="button" className="secondary-btn" onClick={() => set('attachments', t.attachments.filter((_, j) => j !== i))} style={{ padding: '4px 6px' }} aria-label="Remove document"><Trash2 size={13} /></button>
            </div>
          ))}
          <input ref={fileRef} type="file" accept=".pdf,application/pdf" style={{ display: 'none' }} onChange={e => upload(e.target.files?.[0])} />
          <button type="button" className="secondary-btn" disabled={uploading} onClick={() => fileRef.current?.click()} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 4 }}>
            {uploading ? <Spinner size={12} /> : <UploadCloud size={12} />} Upload PDF
          </button>
          <div style={hint}>Place Fields opens the PDF: drop a Signature box for each signer where they sign, and an <b>Offer Field</b> on the blank salary line (or start date, job title) - it is printed from the offer every time this packet is sent, so one packet serves every pay.</div>

          <label style={lbl}>Signers, In Order</label>
          {roles.map((r, i) => (
            <div key={r.key} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span style={{ width: 22, height: 22, borderRadius: '50%', background: 'var(--mist)', fontSize: 11, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{i + 1}</span>
              <input className="form-input" style={{ flex: 1 }} value={r.label} onChange={e => setRole(i, { label: e.target.value })} placeholder="Who signs here" />
              <button type="button" className="secondary-btn" disabled={i === 0} onClick={() => set('roles', move(roles, i, -1))} style={{ padding: '4px 6px' }} aria-label="Move up"><ChevronUp size={13} /></button>
              <button type="button" className="secondary-btn" disabled={i === roles.length - 1} onClick={() => set('roles', move(roles, i, 1))} style={{ padding: '4px 6px' }} aria-label="Move down"><ChevronDown size={13} /></button>
              <button type="button" className="secondary-btn" disabled={roles.length <= 1} onClick={() => set('roles', roles.filter((_, j) => j !== i))} style={{ padding: '4px 6px' }} aria-label="Remove signer"><Trash2 size={13} /></button>
            </div>
          ))}
          <button type="button" className="secondary-btn" onClick={addRole} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}><Plus size={12} /> Add Signer</button>
          <div style={hint}>{SIGNER_HINT[event] || SIGNER_HINT.hire}</div>

          <label style={lbl}>Welcome Note In The Email</label>
          <textarea className="form-input" rows={2} style={{ width: '100%', resize: 'vertical', fontFamily: 'Inter,sans-serif', fontSize: 13 }}
            placeholder="Welcome to the team! Please review and sign your offer letter and onboarding documents."
            value={t.emailMessage} onChange={e => set('emailMessage', e.target.value)} />

          <label style={lbl}>Egnyte Subfolder</label>
          <input className="form-input" style={{ width: '100%' }} value={t.egnyteSubfolder} onChange={e => set('egnyteSubfolder', e.target.value)} placeholder={defaultSubfolder || 'Hiring Documents'} />
          <div style={hint}>Inside the {who}'s own folder (Human Resources &gt; Employees &gt; their name), which they see in My HR &gt; My Documents. Blank uses "{defaultSubfolder || 'Hiring Documents'}".</div>

          {showLetter ? (
            <>
              <label style={lbl}>Letter Text (Optional)</label>
              <textarea className="form-input" rows={5} style={{ width: '100%', resize: 'vertical', fontFamily: 'Inter,sans-serif', fontSize: 13 }}
                value={t.bodyText} onChange={e => set('bodyText', e.target.value)}
                placeholder={'Dear {{first_name}},\n\nWe are pleased to offer you the position of {{job_title}} at {{company}}, starting {{start_date}} at {{salary}}.\n\n[[sign:company]]\n\n[[sign:employee]]'} />
              <div style={hint}>Typed pages that go in front of the PDFs. Blank line = new paragraph; {'{{salary}}'}, {'{{start_date}}'}, {'{{job_title}}'}, {'{{first_name}}'}, {'{{company}}'} fill in at send; [[sign:company]] on its own line is a signature line.</div>
            </>
          ) : (
            <button type="button" className="secondary-btn" onClick={() => setShowLetter(true)} style={{ fontSize: 12, marginTop: 14 }}>Add A Typed Letter Instead Of A PDF</button>
          )}

          {problems.map(p => <Problem key={p}>{p}</Problem>)}
        </div>
        <div style={{ padding: '12px 22px', borderTop: '1px solid var(--line)', display: 'flex', gap: 8, justifyContent: 'flex-end', flexShrink: 0 }}>
          <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="primary-btn" onClick={save} disabled={busy || problems.length > 0} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, opacity: problems.length ? 0.6 : 1 }}>
            {busy ? <Spinner size={13} /> : <CheckCircle size={13} />} Save Packet
          </button>
        </div>
      </div>
      {placing !== null && t.attachments[placing] && (
        <AttachmentPlacer attachment={t.attachments[placing]} roles={roles} toastErr={toastErr}
          onClose={() => setPlacing(null)}
          onSave={(fields) => set('attachments', t.attachments.map((a, j) => j === placing ? { ...a, fields } : a))} />
      )}
    </div>
  );
}

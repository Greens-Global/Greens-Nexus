// Add / Edit Candidate (Neil, Oct 8 call).
//
// The order follows how HR actually fills it in: the hiring company first
// (it decides which roles and departments exist), then the role the person
// applies for - picked from the roles already made in Settings > Access, so
// the department fills itself in - or "Other", which asks for the title and
// the department. Source is a list (Referral, LinkedIn, Indeed...). The resume
// goes in here, as the first step, not later from the candidate card.
// The same form edits a candidate (Neil: the email "has no option to change").
import { useEffect, useRef, useState } from 'react';
import { X, Plus, Upload, FileText, CheckCircle } from 'lucide-react';
import { api } from '../api';
import { useUnsavedGuard } from '../lib/useUnsavedGuard';
import UnsavedChangesPrompt from './UnsavedChangesPrompt';
import { Spinner } from './AsyncState';

const OTHER = '__other__';
const FL = { fontSize: 11, fontWeight: 700, color: 'var(--muted)', display: 'block', marginBottom: 5, letterSpacing: '.04em', textTransform: 'uppercase' };
const hint = { fontSize: 11.5, color: 'var(--muted)', marginTop: 4 };
const RESUME_TYPES = '.pdf,.doc,.docx';
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function initialForm(c) {
  const known = ['Referral', 'LinkedIn', 'Indeed', 'Company Website', 'Job Fair', 'Recruiter / Agency', 'Walk-In'];
  const src = c?.source || '';
  const otherSrc = src && !known.includes(src);
  return {
    first_name: c?.firstName || '', last_name: c?.lastName || '', email: c?.email || '', phone: c?.phone || '',
    company: c?.company || '', role_id: c ? (c.roleId || (c.roleTitle ? OTHER : '')) : '',
    role_title: c?.roleTitle || '', department: c?.department || '',
    expected_start: (c?.expectedStart || '').slice(0, 10),
    source: otherSrc ? 'Other' : src, source_other: otherSrc ? src.replace(/^Other - /, '') : '',
    notes: c?.notes || '',
  };
}

export default function CandidateFormModal({ candidate, onClose, onSaved, toastErr, extraSection }) {
  const editing = !!candidate;
  const [f, setF] = useState(() => initialForm(candidate));
  const start = useRef(JSON.stringify(initialForm(candidate)));
  const [entities, setEntities] = useState([]);
  const [opts, setOpts] = useState({ roles: [], departments: [], sources: [] });
  const [optsBusy, setOptsBusy] = useState(false);
  const [resume, setResume] = useState(null);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));

  // Companies come server-filtered: a company-scoped admin only sees (and can
  // only pick) their own, and the backend refuses anything else anyway.
  useEffect(() => { api.getEntities().then(setEntities).catch(() => {}); }, []);
  useEffect(() => {
    let live = true;
    setOptsBusy(true);
    api.hiringOptions(f.company)
      .then(o => { if (live) setOpts(o); })
      .catch(() => {})
      .finally(() => { if (live) setOptsBusy(false); });
    return () => { live = false; };
  }, [f.company]);

  const role = opts.roles.find(r => r.id === f.role_id);
  const isOther = f.role_id === OTHER;
  function pickRole(id) {
    const r = opts.roles.find(x => x.id === id);
    setF(p => ({ ...p, role_id: id, role_title: r ? r.name : (id === OTHER ? '' : p.role_title),
                 department: r ? (r.department || p.department) : p.department }));
  }
  function pickCompany(id) {
    // A role belongs to a company - changing the company clears a role from the old one.
    setF(p => ({ ...p, company: id, role_id: p.role_id === OTHER ? OTHER : '', department: p.role_id === OTHER ? p.department : '' }));
  }
  function takeFile(file) {
    if (!file) return;
    if (!/\.(pdf|docx?)$/i.test(file.name)) { toastErr('Resumes can be PDF or Word files.'); return; }
    if (file.size > 15 * 1024 * 1024) { toastErr('That file is over 15 MB.'); return; }
    setResume(file);
  }

  const email = f.email.trim();
  const problems = [
    !f.first_name.trim() && 'First name',
    !f.company && 'Hiring company',
    !f.role_id && 'Role applying for',
    isOther && !f.role_title.trim() && 'Role title',
    isOther && !f.department && 'Department',
    email && !EMAIL_RE.test(email) && 'A valid email',
    f.source === 'Other' && !f.source_other.trim() && 'Where they came from',
  ].filter(Boolean);
  const dirty = JSON.stringify(f) !== start.current || !!resume;

  async function save() {
    if (problems.length || busy) return;
    setBusy(true);
    const body = {
      first_name: f.first_name.trim(), last_name: f.last_name.trim(), email, phone: f.phone.trim(),
      company: f.company, role_id: isOther ? '' : f.role_id,
      role_title: isOther ? f.role_title.trim() : (role?.name || f.role_title),
      department: isOther ? f.department : (role?.department || f.department),
      expected_start: f.expected_start,
      source: f.source === 'Other' ? `Other - ${f.source_other.trim()}` : f.source,
      notes: f.notes,
    };
    try {
      let saved = editing ? await api.updateCandidate(candidate.id, body) : await api.createCandidate(body);
      if (resume) {
        const form = new FormData(); form.append('file', resume);
        try { saved = await api.candidateResumeUpload(saved.id, form); }
        catch (e) { toastErr(`Saved, but the resume did not upload: ${e?.message || 'try again from the candidate'}`); }
      }
      onSaved(saved);
      onClose();
    } catch (err) { toastErr(err?.message || 'Could not save the candidate.'); setBusy(false); }
  }
  const guard = useUnsavedGuard(dirty, onClose, problems.length ? undefined : save);

  const input = (label, key, props = {}) => (
    <div><label style={FL}>{label}</label>
      <input className="form-input" style={{ width: '100%' }} value={f[key]} onChange={e => set(key, e.target.value)} {...props} /></div>
  );
  const companyName = entities.find(e => e.id === f.company)?.name;

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => e.target === e.currentTarget && guard.requestClose()}>
      <div style={{ background: 'var(--card)', borderRadius: 16, width: '100%', maxWidth: 'clamp(520px, 60vw, 980px)', maxHeight: 'min(92dvh, 760px)', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)' }}>
        <div style={{ padding: '18px 24px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, flex: 1 }}>{editing ? 'Edit Candidate' : 'Add Candidate'}</h3>
          <button onClick={guard.requestClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        <div style={{ overflowY: 'auto', flex: 1, padding: '18px 24px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14 }}>
          {input('First Name *', 'first_name', { autoFocus: !editing })}
          {input('Last Name', 'last_name')}
          {input('Personal Email', 'email', { type: 'email', placeholder: 'Where interview invites and the hiring packet go' })}
          {input('Phone', 'phone')}

          <div><label style={FL}>Hiring Company *</label>
            <select className="form-input" style={{ width: '100%' }} value={f.company} onChange={e => pickCompany(e.target.value)}>
              <option value="">- pick a company -</option>
              {entities.map(en => <option key={en.id} value={en.id}>{en.name}</option>)}
            </select></div>
          <div><label style={FL}>Role Applying For *</label>
            <select className="form-input" style={{ width: '100%' }} value={f.role_id} onChange={e => pickRole(e.target.value)} disabled={!f.company}>
              <option value="">{f.company ? (optsBusy ? 'Loading roles...' : '- pick a role -') : 'Pick the company first'}</option>
              {opts.roles.map(r => <option key={r.id} value={r.id}>{r.name}{r.department ? ` - ${r.department}` : ''}</option>)}
              <option value={OTHER}>Other (not a role yet)</option>
            </select>
            {f.company && !optsBusy && opts.roles.length === 0 && <div style={hint}>{companyName || 'This company'} has no roles yet - pick Other, or add roles in Settings &gt; Access.</div>}
          </div>

          {isOther ? (
            <>
              {input('Role Title *', 'role_title', { placeholder: 'e.g. Leasing Coordinator' })}
              <div><label style={FL}>Department *</label>
                <select className="form-input" style={{ width: '100%' }} value={f.department} onChange={e => set('department', e.target.value)}>
                  <option value="">- pick a department -</option>
                  {opts.departments.map(d => <option key={d} value={d}>{d}</option>)}
                </select>
                <div style={hint}>Not a role in Settings yet - an administrator can add it there before they're hired.</div>
              </div>
            </>
          ) : (
            <div><label style={FL}>Department</label>
              <div className="form-input" style={{ width: '100%', background: 'var(--mist)', color: role?.department ? 'var(--ink)' : 'var(--muted)', display: 'flex', alignItems: 'center' }}>
                {role ? (role.department || 'The role has no department set') : 'Set by the role'}
              </div></div>
          )}
          {input('Expected Start', 'expected_start', { type: 'date' })}

          <div><label style={FL}>Source</label>
            <select className="form-input" style={{ width: '100%' }} value={f.source} onChange={e => set('source', e.target.value)}>
              <option value="">- where did they come from -</option>
              {(opts.sources.length ? opts.sources : ['Referral', 'LinkedIn', 'Indeed', 'Other']).map(s => <option key={s} value={s}>{s}</option>)}
            </select></div>
          {f.source === 'Other' && input('Came From *', 'source_other', { placeholder: 'e.g. Glassdoor' })}

          <div style={{ gridColumn: '1 / -1' }}><label style={FL}>Resume</label>
            <div onDragOver={e => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
              onDrop={e => { e.preventDefault(); setDrag(false); takeFile(e.dataTransfer.files?.[0]); }}
              onClick={() => fileRef.current?.click()}
              style={{ border: `1.5px dashed ${drag ? 'var(--pine)' : 'var(--line)'}`, borderRadius: 12, padding: '14px 16px', cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: 10, background: drag ? 'hsla(var(--color-green),0.05)' : 'transparent' }}>
              {resume ? <CheckCircle size={18} style={{ color: 'hsl(var(--color-green))' }} /> : editing && candidate.resumeUrl ? <FileText size={18} style={{ color: 'var(--muted)' }} /> : <Upload size={18} style={{ color: 'var(--muted)' }} />}
              <span style={{ fontSize: 12.5, flex: 1 }}>
                {resume ? resume.name : editing && candidate.resumeUrl ? 'A resume is on file - drop a new one to replace it' : 'Drop the resume here, or click to choose (PDF or Word)'}
              </span>
              {resume && <button type="button" className="secondary-btn" style={{ fontSize: 11.5, padding: '3px 10px' }} onClick={e => { e.stopPropagation(); setResume(null); }}>Remove</button>}
            </div>
            <input ref={fileRef} type="file" accept={RESUME_TYPES} style={{ display: 'none' }} onChange={e => { takeFile(e.target.files?.[0]); e.target.value = ''; }} />
          </div>

          <div style={{ gridColumn: '1 / -1' }}><label style={FL}>Notes</label>
            <textarea className="form-input" rows={2} style={{ width: '100%', resize: 'vertical', fontFamily: 'Inter,sans-serif', fontSize: 13 }} value={f.notes} onChange={e => set('notes', e.target.value)} /></div>
          {extraSection}
        </div>
        <div style={{ padding: '14px 24px', borderTop: '1px solid var(--line)', display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'flex-end', flexShrink: 0, flexWrap: 'wrap' }}>
          {problems.length > 0 && dirty && <span style={{ fontSize: 11.5, color: 'var(--muted)', marginRight: 'auto' }}>Still needed: {problems.join(', ')}</span>}
          <button className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="primary-btn" onClick={save} disabled={!!problems.length || busy || (editing && !dirty)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {busy ? <Spinner size={14} /> : editing ? <CheckCircle size={14} /> : <Plus size={14} />} {editing ? 'Save Changes' : 'Add Candidate'}
          </button>
        </div>
      </div>
      {guard.confirming && (
        <UnsavedChangesPrompt onKeepEditing={guard.keepEditing} onDiscard={onClose} onSave={problems.length ? undefined : guard.saveAndClose} saving={busy} />
      )}
    </div>
  );
}

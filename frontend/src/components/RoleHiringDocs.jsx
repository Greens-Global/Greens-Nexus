// A role's own hiring paperwork (Neil, Oct 22): "the role gets filled into the
// hiring packet, not the hiring packet into the role... the only thing that
// changes is a different confidentiality agreement and a different job
// description based on roles". One packet per place (California employee,
// India contractor...) serves every role; here a role writes its duties once
// - printed wherever a document uses Role Description - and names the
// documents it brings: each one either added to whatever packet the hire
// gets, or replacing one of that packet's (the standard confidentiality
// agreement).
import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Trash2, Save, FileText, Upload, Eye, EyeOff, ExternalLink, AlertTriangle } from 'lucide-react';
import { api } from '../api';
import { formatDate } from '../lib/datetime';
import { dialog } from '../ui/dialog';
import { Spinner } from './AsyncState';

const lbl = { display: 'block', fontSize: 12, fontWeight: 700, margin: '14px 0 6px' };
const hint = { fontSize: 12, color: 'var(--muted)', lineHeight: 1.5, marginTop: 4 };
const pill = (on) => ({ padding: '5px 14px', borderRadius: 999, border: '1px solid var(--line)', fontSize: 12.5, fontWeight: 600,
  cursor: 'pointer', fontFamily: 'Inter,sans-serif', background: on ? 'var(--pine)' : 'var(--card)', color: on ? '#fff' : 'var(--ink)' });
const iconBtn = { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 };

// The role's job description as a FILE (Neil, 11/03/2026): a PDF, or a Word
// file the server turns into one exactly as it looks. It goes out after the
// offer letter, page for page, instead of the typed duties. Uploading or
// removing saves at once - it is a file, not a typed field.
function JdFile({ role, onSaved, toastOk, toastErr }) {
  const f = role.jd_file || {};
  const input = useRef(null);
  const [busy, setBusy] = useState('');
  const [preview, setPreview] = useState('');
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  async function upload(file) {
    if (input.current) input.current.value = '';
    if (!file) return;
    setBusy('upload');
    try {
      onSaved?.(await api.uploadRoleJdFile(role.id, file));
      setPreview('');
      toastOk(`Uploaded - ${role.name} offers now send this file after the offer letter.`);
    } catch (e) { toastErr(e?.message || 'Could not upload the file.'); }
    setBusy('');
  }
  async function remove() {
    setBusy('remove');
    try {
      onSaved?.(await api.removeRoleJdFile(role.id));
      setPreview('');
      toastOk('Removed - offers for this role print the typed duties again.');
    } catch (e) { toastErr(e?.message || 'Could not remove the file.'); }
    setBusy('');
  }
  async function view() {
    if (preview) { setPreview(''); return; }
    setBusy('view');
    try { setPreview(URL.createObjectURL((await api.roleJdFilePdf(role.id)).blob)); } catch (e) { toastErr(e?.message || 'Could not open the file.'); }
    setBusy('');
  }

  const picker = (
    <input ref={input} type="file" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      style={{ display: 'none' }} aria-label="Job description file" onChange={e => upload(e.target.files?.[0])} />
  );
  if (!f.name) {
    return (
      <div style={{ border: '1px dashed var(--line)', borderRadius: 10, padding: 18, textAlign: 'center' }}>
        {picker}
        <button type="button" className="secondary-btn" disabled={!!busy} onClick={() => input.current?.click()} style={iconBtn}>
          {busy === 'upload' ? <Spinner size={13} /> : <Upload size={13} />} Choose A PDF Or Word File
        </button>
        <div style={hint}>A Word file is turned into a PDF exactly as it looks. Up to 15 MB.</div>
      </div>
    );
  }
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 10, padding: 12 }}>
      {picker}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
        <FileText size={18} style={{ color: 'var(--pine)', flexShrink: 0 }} />
        <div style={{ flex: '1 1 200px', minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, wordBreak: 'break-word' }}>{f.name}</div>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            {f.pages} {f.pages === 1 ? 'page' : 'pages'}{f.uploadedAt ? ` - uploaded ${formatDate(f.uploadedAt)}` : ''}
          </div>
        </div>
        <button type="button" className="secondary-btn" disabled={!!busy} onClick={view} style={iconBtn}>
          {busy === 'view' ? <Spinner size={13} /> : preview ? <EyeOff size={13} /> : <Eye size={13} />} {preview ? 'Hide' : 'View'}
        </button>
        <button type="button" className="secondary-btn" disabled={!!busy} onClick={() => input.current?.click()} style={iconBtn}>
          {busy === 'upload' ? <Spinner size={13} /> : <Upload size={13} />} Replace
        </button>
        <button type="button" className="secondary-btn" disabled={!!busy} onClick={remove} style={iconBtn} aria-label="Remove job description file">
          {busy === 'remove' ? <Spinner size={13} /> : <Trash2 size={13} />} Remove
        </button>
      </div>
      {preview && <iframe title={`${role.name} job description`} src={preview} style={{ width: '100%', height: 520, border: '1px solid var(--line)', borderRadius: 8, marginTop: 12 }} />}
    </div>
  );
}

// The role's job description kept in Documents (Pranshu, 11/04/2026): "whatever
// change we do in the document ... should automatically get updated over here".
// A link, not a copy - every offer prints the template's published wording as
// it stands that day. A select saves on change (Settings saves one way).
const openTemplate = (id) => window.open(`/documents/documents-templates${id ? `?template=${encodeURIComponent(id)}` : ''}`, '_blank', 'noopener');

function JdFromDocuments({ role, templates, onSaved, toastOk, toastErr }) {
  const [busy, setBusy] = useState(false);
  const linked = role.jd_template || {};
  const jds = (templates || []).filter(t => (t.category || '') === 'job_description');
  async function link(id) {
    setBusy(true);
    try {
      onSaved?.(await api.updateJobRole(role.id, { jd_template_id: id }));
      toastOk(id ? `Linked - ${role.name} offers now print this job description from Documents.` : 'Unlinked - offers print the typed duties or the file again.');
    } catch (e) { toastErr(e?.message || 'Could not save.'); }
    setBusy(false);
  }
  if (templates === null) return <Spinner size={16} />;
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 10, padding: 12 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <select aria-label="Job description from Documents" className="form-input" style={{ flex: '1 1 260px', minWidth: 0 }}
          value={linked.id || ''} disabled={busy} onChange={e => link(e.target.value)}>
          <option value="">{jds.length ? '- pick a job description -' : 'No job descriptions in Documents yet'}</option>
          {jds.map(t => <option key={t.id} value={t.id}>{t.name}{t.publishedVersion ? '' : ' (Not Published)'}</option>)}
          {linked.id && !jds.some(t => t.id === linked.id) && <option value={linked.id}>{linked.name || 'A template that is not active'}</option>}
        </select>
        {busy && <Spinner size={14} />}
        {linked.id && <button type="button" className="secondary-btn" onClick={() => openTemplate(linked.id)} style={iconBtn}><ExternalLink size={13} /> Open In Documents</button>}
        <button type="button" className="secondary-btn" onClick={() => openTemplate('')} style={iconBtn}><Plus size={13} /> New In Documents</button>
      </div>
      <div style={hint}>
        Linked, not copied: each new offer prints the template&apos;s published wording as it stands that day - change it in Documents and publish,
        and the next offer has it. Offers already made keep what they were sent with. In Documents give it the category Job Description.
      </div>
      {(linked.missing || linked.active === false) && (
        <div style={{ ...hint, display: 'flex', gap: 6 }}><AlertTriangle size={13} style={{ color: 'hsl(var(--color-yellow))' }} /> This template is archived or gone - pick another.</div>
      )}
      {linked.id && linked.publishedVersion === 0 && (
        <div style={{ ...hint, display: 'flex', gap: 6 }}><AlertTriangle size={13} style={{ color: 'hsl(var(--color-yellow))' }} /> Not published yet - publish it in Documents before an offer can use it.</div>
      )}
    </div>
  );
}

export default function RoleHiringDocs({ role, onSaved, toastOk, toastErr }) {
  const [duties, setDuties] = useState(role.job_description || '');
  const [docs, setDocs] = useState(() => (role.hiring_docs || []).map(d => ({ templateId: d.templateId, replaces: d.replaces || '' })));
  const [templates, setTemplates] = useState(null);
  const [busy, setBusy] = useState(false);
  const [jdMode, setJdMode] = useState(role.jd_template?.id ? 'docs' : role.jd_file?.name ? 'file' : 'type');
  const [sources, setSources] = useState([]);           // roles whose job description can be copied here
  useEffect(() => {
    api.getDocTemplates({ status: 'active' }).then(r => setTemplates(Array.isArray(r) ? r : (r?.templates || []))).catch(() => setTemplates([]));
    api.getJdSources().then(r => setSources(Array.isArray(r) ? r : [])).catch(() => setSources([]));
  }, []);
  // Copy From Another Role (Pranshu, 11/03/2026): the same role in another company comes first.
  const sourceLabel = s => `${s.name} - ${s.companyName || 'Shared'}`;
  const copyOptions = useMemo(() => {
    const same = s => (s.name || '').trim().toLowerCase() === (role.name || '').trim().toLowerCase();
    return sources.filter(s => s.id !== role.id).sort((a, b) => (same(b) - same(a)) || sourceLabel(a).localeCompare(sourceLabel(b)));
  }, [sources, role.id, role.name]);
  async function copyFrom(id) {
    const src = copyOptions.find(s => s.id === id);
    if (!src) return;
    const has = duties.trim() || (role.job_description || '').trim() || role.jd_file?.name;
    if (has && !await dialog.confirm(`Replace ${role.name}'s job description with the one from ${sourceLabel(src)}?`,
      { title: 'Copy Job Description', confirmText: 'Replace' })) return;
    setBusy(true);
    try {
      const saved = await api.copyRoleJd(role.id, id);
      onSaved?.(saved);
      setDuties(saved.job_description || '');
      setJdMode(saved.jd_template?.id ? 'docs' : saved.jd_file?.name ? 'file' : 'type');
      toastOk(`Copied the job description from ${sourceLabel(src)}.`);
    } catch (e) { toastErr(e?.message || 'Could not copy the job description.'); }
    setBusy(false);
  }
  const byId = useMemo(() => Object.fromEntries((templates || []).map(t => [t.id, t])), [templates]);
  const dirty = duties !== (role.job_description || '')
    || JSON.stringify(docs) !== JSON.stringify((role.hiring_docs || []).map(d => ({ templateId: d.templateId, replaces: d.replaces || '' })));
  const incomplete = docs.some(d => !d.templateId);
  const setDoc = (i, patch) => setDocs(list => list.map((d, j) => (j === i ? { ...d, ...patch } : d)));

  async function save() {
    if (incomplete) { toastErr('Pick a document on every row, or remove the empty row.'); return; }
    setBusy(true);
    try {
      const saved = await api.updateJobRole(role.id, { job_description: duties, hiring_docs: docs });
      onSaved?.(saved);
      toastOk('Saved - every packet this role is hired with now uses these.');
    } catch (e) { toastErr(e?.message || 'Could not save.'); }
    setBusy(false);
  }

  return (
    <div style={{ marginTop: 6 }}>
      <div style={lbl}>Job Description</div>
      <div style={{ ...hint, marginTop: 0, marginBottom: 10 }}>
        Goes out with every offer for this role, after the offer letter, with a box the candidate ticks to say they read it.
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <div role="radiogroup" aria-label="Job description" style={{ display: 'flex', gap: 6 }}>
          <button type="button" role="radio" aria-checked={jdMode === 'type'} style={pill(jdMode === 'type')} onClick={() => setJdMode('type')}>Type It</button>
          <button type="button" role="radio" aria-checked={jdMode === 'file'} style={pill(jdMode === 'file')} onClick={() => setJdMode('file')}>Upload A File</button>
          <button type="button" role="radio" aria-checked={jdMode === 'docs'} style={pill(jdMode === 'docs')} onClick={() => setJdMode('docs')}>Pick From Documents</button>
        </div>
        {copyOptions.length > 0 && (
          <select aria-label="Copy job description from" className="form-input" value="" disabled={busy}
            onChange={e => copyFrom(e.target.value)} style={{ marginLeft: 'auto', flex: '0 1 300px', minWidth: 0, fontSize: 12.5 }}>
            <option value="">Copy From Another Role</option>
            {copyOptions.map(s => <option key={s.id} value={s.id}>{sourceLabel(s)}{s.file ? ` (${s.file})` : ''}</option>)}
          </select>
        )}
      </div>
      {jdMode === 'docs' ? <JdFromDocuments role={role} templates={templates} onSaved={onSaved} toastOk={toastOk} toastErr={toastErr} />
        : jdMode === 'file' ? <JdFile role={role} onSaved={onSaved} toastOk={toastOk} toastErr={toastErr} /> : (
        <>
          {(role.jd_file?.name || role.jd_template?.id) && (
            <div style={{ ...hint, marginTop: 0, marginBottom: 8, display: 'flex', gap: 6, alignItems: 'flex-start' }}>
              <AlertTriangle size={13} style={{ color: 'hsl(var(--color-yellow))', flexShrink: 0, marginTop: 2 }} />
              <span>{role.jd_file?.name
                ? `${role.jd_file.name} is attached and goes out instead of these duties - remove it under Upload A File to use them.`
                : `${role.jd_template.name || 'A Documents template'} goes out instead of these duties - unlink it under Pick From Documents to use them.`}</span>
            </div>
          )}
          <textarea id={`jd-${role.id}`} aria-label="Job Description (Duties)" className="form-input" rows={6} style={{ width: '100%', resize: 'vertical', fontFamily: 'inherit' }}
            value={duties} onChange={e => setDuties(e.target.value)}
            placeholder={`What a ${role.name} does - duties, responsibilities, requirements.`} />
          <div style={hint}>Printed by the Job Description document wherever it uses <b>Role Description</b>, so one document serves every role.</div>
        </>
      )}

      <div style={{ ...lbl, marginTop: 20 }}>Role Documents</div>
      <div style={hint}>
        Documents only this role signs - for example its own confidentiality agreement. They go out with whatever packet the person is hired with
        (California, Texas, India...). Replaces swaps out one of the packet&apos;s documents; otherwise the document is added after the packet&apos;s own.
      </div>
      {templates === null ? <div style={{ marginTop: 10 }}><Spinner size={16} /></div> : (
        <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
          {docs.length === 0 && <div style={{ fontSize: 13, color: 'var(--muted)' }}>None - this role signs exactly what its place&apos;s packet holds.</div>}
          {docs.map((d, i) => (
            <div key={i} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', padding: 10, border: '1px solid var(--line)', borderRadius: 8 }}>
              <FileText size={15} style={{ color: 'var(--pine)', flexShrink: 0 }} />
              <select aria-label="Role document" className="form-input" style={{ flex: '2 1 200px', minWidth: 0 }} value={d.templateId}
                onChange={e => setDoc(i, { templateId: e.target.value })}>
                <option value="">- pick a document -</option>
                {(templates || []).filter(t => t.id === d.templateId || !docs.some(x => x.templateId === t.id)).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                {d.templateId && !byId[d.templateId] && <option value={d.templateId}>A template that is not active</option>}
              </select>
              <select aria-label="Replaces" className="form-input" style={{ flex: '1 1 180px', minWidth: 0 }} value={d.replaces}
                onChange={e => setDoc(i, { replaces: e.target.value })}>
                <option value="">Added To The Packet</option>
                {(templates || []).filter(t => t.id !== d.templateId).map(t => <option key={t.id} value={t.id}>Replaces {t.name}</option>)}
              </select>
              <button type="button" className="secondary-btn" onClick={() => setDocs(list => list.filter((_, j) => j !== i))}
                aria-label="Remove role document" title="Remove" style={{ padding: '6px 9px' }}><Trash2 size={13} /></button>
            </div>
          ))}
          <div>
            <button type="button" className="secondary-btn" onClick={() => setDocs(list => [...list, { templateId: '', replaces: '' }])}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Plus size={13} /> Add Document</button>
          </div>
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
        <button type="button" className="primary-btn" onClick={save} disabled={!dirty || busy}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, opacity: !dirty || busy ? 0.6 : 1 }}>
          {busy ? <Spinner size={13} /> : <Save size={13} />} Save
        </button>
      </div>
    </div>
  );
}

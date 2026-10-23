// A role's own hiring paperwork (Neil, Oct 22): "the role gets filled into the
// hiring packet, not the hiring packet into the role... the only thing that
// changes is a different confidentiality agreement and a different job
// description based on roles". One packet per place (California employee,
// India contractor...) serves every role; here a role writes its duties once
// - printed wherever a document uses Role Description - and names the
// documents it brings: each one either added to whatever packet the hire
// gets, or replacing one of that packet's (the standard confidentiality
// agreement). The duties are edited in Set Up Hiring's Job Description popup
// (Oct 23): a Standard text plus versions by Hired As, place and company.
import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, Save, FileText } from 'lucide-react';
import { api } from '../api';
import { Spinner } from './AsyncState';
import RoleDutiesModal from './hiring/RoleDutiesModal';

const lbl = { display: 'block', fontSize: 12, fontWeight: 700, margin: '14px 0 6px' };
const hint = { fontSize: 12, color: 'var(--muted)', lineHeight: 1.5, marginTop: 4 };

export default function RoleHiringDocs({ role, onSaved, toastOk, toastErr }) {
  const [duties, setDuties] = useState(role.job_description || '');
  const [editingDuties, setEditingDuties] = useState(false);
  const [docs, setDocs] = useState(() => (role.hiring_docs || []).map(d => ({ templateId: d.templateId, replaces: d.replaces || '' })));
  const [templates, setTemplates] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.getDocTemplates({ status: 'active' }).then(r => setTemplates(Array.isArray(r) ? r : (r?.templates || []))).catch(() => setTemplates([]));
  }, []);
  const byId = useMemo(() => Object.fromEntries((templates || []).map(t => [t.id, t])), [templates]);
  const dirty = JSON.stringify(docs) !== JSON.stringify((role.hiring_docs || []).map(d => ({ templateId: d.templateId, replaces: d.replaces || '' })));
  const incomplete = docs.some(d => !d.templateId);
  const setDoc = (i, patch) => setDocs(list => list.map((d, j) => (j === i ? { ...d, ...patch } : d)));

  async function save() {
    if (incomplete) { toastErr('Pick a document on every row, or remove the empty row.'); return; }
    setBusy(true);
    try {
      const saved = await api.updateJobRole(role.id, { hiring_docs: docs });
      onSaved?.(saved);
      toastOk('Saved - every packet this role is hired with now uses these.');
    } catch (e) { toastErr(e?.message || 'Could not save.'); }
    setBusy(false);
  }

  return (
    <div style={{ marginTop: 6 }}>
      <div style={lbl}>Job Description (Duties)</div>
      <div style={{ fontSize: 13, whiteSpace: 'pre-line', color: duties ? 'var(--ink)' : 'var(--muted)', border: '1px solid var(--line)', borderRadius: 8, padding: 10, maxHeight: 120, overflow: 'hidden' }}>
        {duties || 'Not written yet.'}
      </div>
      <div style={{ ...hint, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
        <span style={{ flex: 1 }}>Printed wherever a hiring document uses <b>Role Description</b>, so one Job Description document serves every role. Contractors, part-time staff or another place can get their own version.</span>
        <button type="button" className="secondary-btn" onClick={() => setEditingDuties(true)}>Edit Job Description</button>
      </div>
      {editingDuties && (
        <RoleDutiesModal roleId={role.id} entityId={role.company_id || ''} toastErr={toastErr}
          onClose={() => { setEditingDuties(false); api.getRoleDuties(role.id, role.company_id || '').then(d => setDuties(d.versions?.[0]?.text || '')).catch(() => {}); }} />
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
                <option value="@jd">Replaces: Job Description</option>
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

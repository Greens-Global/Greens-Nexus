import { useState, useEffect, useCallback } from 'react';
import { useMsal } from '@azure/msal-react';
import { useRole } from '../contexts/RoleContext';
import { api } from '../api';
import {
  BookOpen, CheckSquare, FilePlus, Search, Clock, Sparkles, Play, BadgeCheck,
  Users, X, ArrowLeft, Plus, Trash2, Edit3, Send, Archive, Loader,
} from 'lucide-react';

// Greens Global's real departments (mirrors backend DEPT_ABBR).
const DEPARTMENTS = [
  'Operations', 'Revenue Management', 'Real Estate Development', 'People (HR)',
  'Finance & Accounting', 'IT', 'Marketing', 'Admin',
];
const DOC_TYPES = ['SOP', 'Manual', 'Guide'];

const STATUS_META = {
  draft:             { label: 'Draft',             bg: 'var(--bg-secondary)',      fg: 'var(--text-secondary)' },
  in_review:         { label: 'In Review',         bg: 'hsla(38, 92%, 50%, 0.14)', fg: 'hsl(32, 80%, 38%)' },
  changes_requested: { label: 'Changes Requested', bg: 'hsla(0, 84%, 60%, 0.12)',  fg: 'hsl(0, 70%, 45%)' },
  approved:          { label: 'Approved',          bg: 'hsla(145, 63%, 42%, 0.14)', fg: 'hsl(145, 55%, 30%)' },
  archived:          { label: 'Archived',          bg: 'var(--bg-secondary)',      fg: 'var(--text-muted)' },
};

const TAB_LABELS = { index: 'SOP Index', review: 'Review Queue', lms: 'LMS (Learning Portal)' };

const Badge = ({ status }) => {
  const m = STATUS_META[status] || STATUS_META.draft;
  return (
    <span style={{
      backgroundColor: m.bg, color: m.fg, fontSize: '0.72rem', fontWeight: 700,
      padding: '3px 10px', borderRadius: 999, whiteSpace: 'nowrap',
    }}>{m.label}</span>
  );
};

const blankBody = () => ({
  purpose: '', scopeText: '', materials: [], responsibilities: [],
  definitions: [], procedure: [], safety: [], references: [],
});
const blankDraft = (name, email) => ({
  id: null, title: '', doc_type: 'SOP', departments: [], reviewer_email: '',
  reviewer_name: '', version: '0.1', effective_date: '', body: blankBody(),
  owner_name: name, owner_email: email, _raw: '',
});

// ── seeded LMS demo data (unchanged — made real in a later PR) ──────────────
const INIT_COURSES = [
  { id: 101, title: 'Onsite Safety & Hazard Compliance', category: 'OPS', duration: '2 hours', progress: 100, status: 'Completed' },
  { id: 102, title: 'Sage Intacct Accounting Basics', category: 'Accounting', duration: '4 hours', progress: 40, status: 'Enrolled' },
  { id: 103, title: 'GDPR & Corporate IT Security Training', category: 'IT', duration: '1 hour', progress: 0, status: 'Enrolled' },
  { id: 104, title: 'Construction Blueprint Interpretation', category: 'Development', duration: '3 hours', progress: 100, status: 'Completed' },
  { id: 105, title: 'HubSpot Lead Routing & Sales Operations', category: 'Marketing', duration: '1.5 hours', progress: 85, status: 'Enrolled' },
];

const fmtDate = (s) => (s ? new Date(s.length > 10 ? s : s + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—');

export default function SOP({ activeSub, onSubChange }) {
  const sub = activeSub || 'index';
  const { accounts } = useMsal();
  const { can, myEmail } = useRole();
  const myName = accounts[0]?.name || myEmail || 'Me';
  const isManager = can('manager');

  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [mode, setMode] = useState('list'); // list | detail | editor
  const [selected, setSelected] = useState(null);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);

  const [search, setSearch] = useState('');
  const [deptFilter, setDeptFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');

  // review modal
  const [reviewDoc, setReviewDoc] = useState(null);
  const [reviewNote, setReviewNote] = useState('');

  // LMS (unchanged)
  const [courses, setCourses] = useState(INIT_COURSES);
  const [showCourseModal, setShowCourseModal] = useState(false);
  const [courseForm, setCourseForm] = useState({ title: '', category: 'OPS', duration: '' });

  const refresh = useCallback(() => {
    setLoading(true);
    api.getKbDocs()
      .then(d => { setDocs(d); setErr(''); })
      .catch(e => setErr(e.message || 'Failed to load documents'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const canEdit = (d) => isManager || (d.owner_email === myEmail && (d.status === 'draft' || d.status === 'changes_requested'));
  const canReview = (d) => isManager && d.status === 'in_review';

  // ── filtering ──
  const docSearchText = (d) => {
    const b = d.body || {};
    return [d.title, d.doc_code, d.owner_name, b.purpose, b.scopeText,
      (b.procedure || []).map(s => s.text + ' ' + (s.detail || '')).join(' '),
      (b.references || []).join(' ')].join('  ').toLowerCase();
  };
  const filtered = docs.filter(d => {
    if (deptFilter !== 'all' && !(d.departments || []).includes(deptFilter)) return false;
    if (typeFilter !== 'all' && d.doc_type !== typeFilter) return false;
    if (statusFilter !== 'all' && d.status !== statusFilter) return false;
    if (search && !docSearchText(d).includes(search.toLowerCase().trim())) return false;
    return true;
  });
  const reviewQueue = docs.filter(d =>
    (d.status === 'in_review' && isManager) ||
    (d.status === 'changes_requested' && d.owner_email === myEmail));

  // ── navigation ──
  const openDetail = (d) => { setSelected(d); setMode('detail'); };
  const openCreate = () => { setDraft(blankDraft(myName, myEmail)); setMode('editor'); };
  const openEdit = (d) => {
    setDraft({
      id: d.id, title: d.title, doc_type: d.doc_type, departments: [...(d.departments || [])],
      reviewer_email: d.reviewer_email || '', reviewer_name: d.reviewer_name || '',
      version: d.version, effective_date: d.effective_date || '',
      body: { ...blankBody(), ...(d.body || {}) }, owner_name: d.owner_name, owner_email: d.owner_email, _raw: '',
    });
    setMode('editor');
  };
  const backToList = () => { setMode('list'); setSelected(null); setDraft(null); };

  const switchTab = (key) => { backToList(); onSubChange(key); };

  // ── editor body helpers ──
  const setBody = (patch) => setDraft(p => ({ ...p, body: { ...p.body, ...patch } }));
  const addItem = (field, val) => setBody({ [field]: [...draft.body[field], val] });
  const updItem = (field, i, val) => setBody({ [field]: draft.body[field].map((x, j) => j === i ? val : x) });
  const delItem = (field, i) => setBody({ [field]: draft.body[field].filter((_, j) => j !== i) });
  const toggleDept = (dep) => setDraft(p => ({
    ...p, departments: p.departments.includes(dep) ? p.departments.filter(x => x !== dep) : [...p.departments, dep],
  }));

  // ── save / workflow ──
  const payloadFromDraft = () => ({
    title: draft.title, doc_type: draft.doc_type, departments: draft.departments,
    reviewer_email: draft.reviewer_email, reviewer_name: draft.reviewer_name,
    version: draft.version, effective_date: draft.effective_date, body: draft.body,
  });

  const save = async (submit) => {
    if (!draft.title.trim()) { setErr('Add a title before saving.'); return; }
    if (submit && !draft.reviewer_email.trim()) { setErr('Enter a reviewing manager email to submit.'); return; }
    setBusy(true); setErr('');
    try {
      let doc = draft.id
        ? await api.updateKbDoc(draft.id, payloadFromDraft())
        : await api.createKbDoc(payloadFromDraft());
      if (submit) doc = await api.submitKbDoc(doc.id);
      refresh();
      setSelected(doc); setMode('detail'); setDraft(null);
    } catch (e) { setErr(e.message || 'Save failed'); }
    finally { setBusy(false); }
  };

  const submitDoc = async (d) => {
    setBusy(true); setErr('');
    try { const doc = await api.submitKbDoc(d.id); refresh(); setSelected(doc); }
    catch (e) { setErr(e.message || 'Submit failed'); }
    finally { setBusy(false); }
  };

  const doReview = async (decision) => {
    if (decision === 'request_changes' && !reviewNote.trim()) { setErr('Add a note describing the changes needed.'); return; }
    setBusy(true); setErr('');
    try {
      const doc = await api.reviewKbDoc(reviewDoc.id, { decision, note: reviewNote });
      setReviewDoc(null); setReviewNote(''); refresh();
      if (selected?.id === doc.id) setSelected(doc);
    } catch (e) { setErr(e.message || 'Review failed'); }
    finally { setBusy(false); }
  };

  const archiveDoc = async (d) => {
    setBusy(true);
    try { const doc = await api.archiveKbDoc(d.id); refresh(); setSelected(doc); }
    catch (e) { setErr(e.message || 'Archive failed'); }
    finally { setBusy(false); }
  };

  const runAiFormat = async () => {
    const content = draft._raw?.trim() || [draft.title, draft.body.purpose].filter(Boolean).join('\n');
    if (!content) { setErr('Add raw notes, a title, or a purpose for the AI to work from.'); return; }
    setAiBusy(true); setErr('');
    try {
      const { sop } = await api.aiFormatKbDoc({ content, title: draft.title, departments: draft.departments });
      setDraft(p => ({
        ...p,
        title: p.title || sop.title || '',
        body: {
          ...p.body,
          purpose: sop.purpose || p.body.purpose,
          scopeText: sop.scopeText || p.body.scopeText,
          materials: sop.materials?.length ? sop.materials : p.body.materials,
          responsibilities: sop.responsibilities?.length ? sop.responsibilities : p.body.responsibilities,
          definitions: sop.definitions?.length ? sop.definitions : p.body.definitions,
          procedure: sop.procedure?.length ? sop.procedure : p.body.procedure,
          safety: sop.safety?.length ? sop.safety : p.body.safety,
          references: sop.references?.length ? sop.references : p.body.references,
        },
      }));
    } catch (e) { setErr(e.message || 'AI formatting failed'); }
    finally { setAiBusy(false); }
  };

  // ── LMS (unchanged) ──
  const completed = courses.filter(c => c.status === 'Completed').length;
  const inProgress = courses.filter(c => c.status === 'Enrolled').length;
  const studyLesson = (id) => setCourses(prev => prev.map(c => {
    if (c.id !== id) return c;
    const p = Math.min(c.progress + 20, 100);
    return { ...c, progress: p, status: p >= 100 ? 'Completed' : 'Enrolled' };
  }));
  const submitCourse = (e) => {
    e.preventDefault();
    setCourses(prev => [...prev, { id: Math.floor(200 + Math.random() * 800), ...courseForm, progress: 0, status: 'Enrolled' }]);
    setShowCourseModal(false);
    setCourseForm({ title: '', category: 'OPS', duration: '' });
  };

  const errBanner = err && (
    <div style={{ backgroundColor: 'hsla(0,84%,60%,0.1)', border: '1px solid hsla(0,84%,60%,0.3)', color: 'hsl(0,70%,42%)', padding: '10px 14px', borderRadius: 8, marginBottom: 16, fontSize: '0.85rem' }}>{err}</div>
  );

  // ════════════════════ DETAIL ════════════════════
  if (mode === 'detail' && selected) {
    const d = selected;
    const b = d.body || {};
    const deptLabel = (d.departments || []).length ? d.departments.join(', ') : 'Unassigned';
    const section = (title, content) => (
      <div style={{ marginBottom: 22 }}>
        <h3 style={{ fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'hsl(var(--color-blue))', borderBottom: '2px solid var(--border-color)', paddingBottom: 6, marginBottom: 10, fontWeight: 700 }}>{title}</h3>
        {content}
      </div>
    );
    return (
      <div style={{ animation: 'fadeIn var(--transition-normal) ease-in-out' }}>
        <button className="secondary-btn" onClick={backToList} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 16, height: 34 }}>
          <ArrowLeft size={15} /> Back
        </button>
        {errBanner}
        <div className="view-header" style={{ marginBottom: 20, alignItems: 'flex-start' }}>
          <div className="view-title-group">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-secondary)', backgroundColor: 'var(--bg-secondary)', borderRadius: 6, padding: '2px 8px' }}>{d.doc_type}</span>
              <Badge status={d.status} />
            </div>
            <h2>{d.title}</h2>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {canEdit(d) && <button className="secondary-btn" onClick={() => openEdit(d)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 38 }}><Edit3 size={14} /> Edit</button>}
            {(d.status === 'draft' || d.status === 'changes_requested') && (d.owner_email === myEmail || isManager) && (
              <button className="primary-btn" disabled={busy} onClick={() => submitDoc(d)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 38 }}><Send size={14} /> Submit for review</button>
            )}
            {canReview(d) && <button className="primary-btn" onClick={() => { setReviewDoc(d); setReviewNote(''); }} style={{ backgroundColor: 'hsl(var(--color-green))', display: 'inline-flex', alignItems: 'center', gap: 6, height: 38 }}><CheckSquare size={14} /> Review</button>}
            {d.status === 'approved' && isManager && <button className="secondary-btn" onClick={() => archiveDoc(d)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 38 }}><Archive size={14} /> Archive</button>}
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 280px', gap: 24, alignItems: 'start' }}>
          <div style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 24, boxShadow: 'var(--shadow-sm)', maxWidth: 820 }}>
            {/* header grid */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 1, backgroundColor: 'var(--border-color)', border: '1px solid var(--border-color)', borderRadius: 10, overflow: 'hidden', marginBottom: 22 }}>
              {[['SOP ID', d.doc_code || '—'], ['Type', d.doc_type], ['Version', 'v' + d.version], ['Owner', d.owner_name || '—'], ['Reviewer', d.reviewer_name || d.reviewer_email || '—'], ['Effective', fmtDate(d.effective_date)], ['Updated', fmtDate(d.updated_at)]].map(([k, v]) => (
                <div key={k} style={{ backgroundColor: 'var(--bg-card)', padding: '10px 13px' }}>
                  <div style={{ fontSize: '0.65rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: 3 }}>{k}</div>
                  <div style={{ fontSize: '0.85rem', fontWeight: 500, color: 'var(--text-primary)' }}>{v}</div>
                </div>
              ))}
              <div style={{ backgroundColor: 'var(--bg-card)', padding: '10px 13px', gridColumn: '1 / -1' }}>
                <div style={{ fontSize: '0.65rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: 3 }}>Applies to</div>
                <div style={{ fontSize: '0.85rem', fontWeight: 500, color: 'var(--text-primary)' }}>{deptLabel}</div>
              </div>
            </div>

            {b.purpose && section('Purpose', <p style={{ color: 'var(--text-primary)', margin: 0, lineHeight: 1.6 }}>{b.purpose}</p>)}
            {b.scopeText && section('Scope', <p style={{ color: 'var(--text-primary)', margin: 0, lineHeight: 1.6 }}>{b.scopeText}</p>)}
            {b.materials?.length > 0 && section('Materials & required items', <ul style={{ margin: 0, paddingLeft: 20, color: 'var(--text-primary)', lineHeight: 1.7 }}>{b.materials.map((m, i) => <li key={i}>{m}</li>)}</ul>)}
            {b.responsibilities?.length > 0 && section('Responsibilities', (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                <tbody>{b.responsibilities.map((r, i) => (
                  <tr key={i}><td style={{ padding: '7px 11px', border: '1px solid var(--border-color)', fontWeight: 600, width: '32%', backgroundColor: 'var(--bg-secondary)' }}>{r.role}</td><td style={{ padding: '7px 11px', border: '1px solid var(--border-color)' }}>{r.duty}</td></tr>
                ))}</tbody>
              </table>
            ))}
            {b.definitions?.length > 0 && section('Definitions', (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                <tbody>{b.definitions.map((r, i) => (
                  <tr key={i}><td style={{ padding: '7px 11px', border: '1px solid var(--border-color)', fontWeight: 600, width: '32%', backgroundColor: 'var(--bg-secondary)' }}>{r.term}</td><td style={{ padding: '7px 11px', border: '1px solid var(--border-color)' }}>{r.def}</td></tr>
                ))}</tbody>
              </table>
            ))}
            {section('Procedure', b.procedure?.length > 0 ? (
              <ol style={{ margin: 0, paddingLeft: 0, listStyle: 'none', counterReset: 'step' }}>
                {b.procedure.map((s, i) => (
                  <li key={i} style={{ position: 'relative', padding: '10px 0 10px 40px', borderBottom: '1px solid var(--bg-secondary)', color: 'var(--text-primary)' }}>
                    <span style={{ position: 'absolute', left: 0, top: 9, width: 26, height: 26, borderRadius: 8, backgroundColor: 'var(--bg-secondary)', color: 'hsl(var(--color-blue))', fontWeight: 700, fontSize: '0.8rem', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{i + 1}</span>
                    {s.text}
                    {s.detail && <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: 4 }}>{s.detail}</div>}
                  </li>
                ))}
              </ol>
            ) : <p style={{ color: 'var(--text-muted)', margin: 0 }}>No steps recorded.</p>)}
            {b.safety?.length > 0 && section('Safety & compliance', <ul style={{ margin: 0, paddingLeft: 20, color: 'var(--text-primary)', lineHeight: 1.7 }}>{b.safety.map((s, i) => <li key={i}>{s}</li>)}</ul>)}
            {b.references?.length > 0 && section('References', <ul style={{ margin: 0, paddingLeft: 20, color: 'var(--text-primary)', lineHeight: 1.7 }}>{b.references.map((s, i) => <li key={i}>{s}</li>)}</ul>)}
          </div>

          {/* rail */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 16, boxShadow: 'var(--shadow-sm)' }}>
              <h3 style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', margin: '0 0 12px' }}>Status</h3>
              <Badge status={d.status} />
              {d.status === 'in_review' && <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', margin: '10px 0 0' }}>Submitted to {d.reviewer_name || d.reviewer_email} for approval.</p>}
              {d.status === 'changes_requested' && d.review_note && <p style={{ fontSize: '0.8rem', color: 'hsl(0,70%,45%)', margin: '10px 0 0' }}>{d.review_note}</p>}
              {d.status === 'approved' && <p style={{ fontSize: '0.8rem', color: 'hsl(145,55%,32%)', margin: '10px 0 0' }}>Published and live in the library.</p>}
            </div>
            <div style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 16, boxShadow: 'var(--shadow-sm)' }}>
              <h3 style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', margin: '0 0 12px' }}>Revision history</h3>
              {(d.revision_history || []).length === 0 ? <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', margin: 0 }}>No activity yet.</p> : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {d.revision_history.map((r, i) => (
                    <div key={i} style={{ borderLeft: '2px solid var(--border-color)', paddingLeft: 11 }}>
                      <div style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-primary)' }}>v{r.version} <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>· {fmtDate(r.date)}</span></div>
                      <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: 2 }}>{r.notes}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
        {reviewModal()}
      </div>
    );
  }

  // ════════════════════ EDITOR ════════════════════
  if (mode === 'editor' && draft) {
    const isNew = !draft.id;
    const listEditor = (field, label, placeholder) => (
      <div className="ed-block" style={{ marginBottom: 16 }}>
        <label style={{ fontSize: '0.85rem', fontWeight: 600, display: 'block', marginBottom: 8 }}>{label}</label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {draft.body[field].map((v, i) => (
            <div key={i} style={{ display: 'flex', gap: 8 }}>
              <input className="form-input" value={v} placeholder={placeholder} onChange={e => updItem(field, i, e.target.value)} style={{ flex: 1 }} />
              <button className="secondary-btn" onClick={() => delItem(field, i)} style={{ width: 40, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Trash2 size={15} /></button>
            </div>
          ))}
        </div>
        <button className="secondary-btn" onClick={() => addItem(field, '')} style={{ marginTop: 8, height: 32, fontSize: '0.8rem', display: 'inline-flex', alignItems: 'center', gap: 5 }}><Plus size={13} /> Add</button>
      </div>
    );
    const pairEditor = (field, label, k1, k2, p1, p2) => (
      <div className="ed-block" style={{ marginBottom: 16 }}>
        <label style={{ fontSize: '0.85rem', fontWeight: 600, display: 'block', marginBottom: 8 }}>{label}</label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {draft.body[field].map((row, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 2fr auto', gap: 8 }}>
              <input className="form-input" value={row[k1] || ''} placeholder={p1} onChange={e => updItem(field, i, { ...row, [k1]: e.target.value })} />
              <input className="form-input" value={row[k2] || ''} placeholder={p2} onChange={e => updItem(field, i, { ...row, [k2]: e.target.value })} />
              <button className="secondary-btn" onClick={() => delItem(field, i)} style={{ width: 40, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Trash2 size={15} /></button>
            </div>
          ))}
        </div>
        <button className="secondary-btn" onClick={() => addItem(field, { [k1]: '', [k2]: '' })} style={{ marginTop: 8, height: 32, fontSize: '0.8rem', display: 'inline-flex', alignItems: 'center', gap: 5 }}><Plus size={13} /> Add</button>
      </div>
    );

    return (
      <div style={{ animation: 'fadeIn var(--transition-normal) ease-in-out', maxWidth: 860 }}>
        <button className="secondary-btn" onClick={backToList} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 16, height: 34 }}>
          <ArrowLeft size={15} /> {isNew ? 'Cancel' : 'Back'}
        </button>
        <h2 style={{ marginBottom: 4 }}>{isNew ? 'New' : 'Edit'} {draft.doc_type}</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: 20 }}>Fill the standard template, or paste raw notes and let Claude format it into the Greens Global standard.</p>
        {errBanner}

        {/* AI banner */}
        <div style={{ border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-card)', borderRadius: 12, padding: 16, marginBottom: 18, boxShadow: 'var(--shadow-sm)' }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12 }}>
            <div style={{ width: 34, height: 34, borderRadius: 9, backgroundColor: 'hsla(215,100%,50%,0.1)', color: 'hsl(var(--color-blue))', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto' }}><Sparkles size={18} /></div>
            <div style={{ flex: 1 }}>
              <strong style={{ fontSize: '0.9rem', display: 'block' }}>Format with Claude AI</strong>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Paste an existing document or rough notes, then populate every section.</span>
            </div>
            <button className="primary-btn" disabled={aiBusy} onClick={runAiFormat} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 38 }}>
              {aiBusy ? <Loader size={15} style={{ animation: 'spin 0.7s linear infinite' }} /> : <Sparkles size={15} />} {aiBusy ? 'Formatting…' : 'Format with Claude'}
            </button>
          </div>
          <textarea className="form-input" value={draft._raw} placeholder="Paste existing SOP text or bullet notes here…" onChange={e => setDraft(p => ({ ...p, _raw: e.target.value }))} style={{ width: '100%', minHeight: 80, resize: 'vertical' }} />
        </div>

        <div className="form-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', marginBottom: 16 }}>
          <div className="form-group"><label>Title</label><input className="form-input" value={draft.title} placeholder="e.g. Unit Move-In Procedure" onChange={e => setDraft(p => ({ ...p, title: e.target.value }))} /></div>
          <div className="form-group"><label>Type</label><select className="form-select" value={draft.doc_type} onChange={e => setDraft(p => ({ ...p, doc_type: e.target.value }))}>{DOC_TYPES.map(t => <option key={t}>{t}</option>)}</select></div>
          <div className="form-group"><label>Version</label><input className="form-input" value={draft.version} onChange={e => setDraft(p => ({ ...p, version: e.target.value }))} /></div>
          <div className="form-group"><label>Effective date</label><input type="date" className="form-input" value={draft.effective_date} onChange={e => setDraft(p => ({ ...p, effective_date: e.target.value }))} /></div>
          <div className="form-group"><label>Reviewing manager email</label><input className="form-input" value={draft.reviewer_email} placeholder="manager@greensglobal.com" onChange={e => setDraft(p => ({ ...p, reviewer_email: e.target.value }))} /></div>
          <div className="form-group"><label>Reviewer name <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional)</span></label><input className="form-input" value={draft.reviewer_name} onChange={e => setDraft(p => ({ ...p, reviewer_name: e.target.value }))} /></div>
        </div>

        <div className="form-group" style={{ marginBottom: 20 }}>
          <label>Applies to departments</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
            {DEPARTMENTS.map(dep => {
              const on = draft.departments.includes(dep);
              return <button key={dep} onClick={() => toggleDept(dep)} style={{ fontSize: '0.8rem', padding: '6px 12px', borderRadius: 999, border: '1px solid', borderColor: on ? 'var(--text-primary)' : 'var(--border-color)', backgroundColor: on ? 'var(--text-primary)' : 'var(--bg-card)', color: on ? 'var(--bg-card)' : 'var(--text-secondary)', fontWeight: 500, cursor: 'pointer' }}>{dep}</button>;
            })}
          </div>
        </div>

        <div className="form-group" style={{ marginBottom: 16 }}><label>Purpose</label><textarea className="form-input" value={draft.body.purpose} placeholder="Why this document exists…" onChange={e => setBody({ purpose: e.target.value })} style={{ minHeight: 70, resize: 'vertical' }} /></div>
        <div className="form-group" style={{ marginBottom: 16 }}><label>Scope</label><textarea className="form-input" value={draft.body.scopeText} placeholder="Who and what this applies to…" onChange={e => setBody({ scopeText: e.target.value })} style={{ minHeight: 70, resize: 'vertical' }} /></div>
        {listEditor('materials', 'Materials & required items', 'e.g. Master key set')}
        {pairEditor('responsibilities', 'Responsibilities', 'role', 'duty', 'Role', 'Responsibility')}
        {pairEditor('definitions', 'Definitions', 'term', 'def', 'Term', 'Definition')}

        {/* procedure */}
        <div className="ed-block" style={{ marginBottom: 16 }}>
          <label style={{ fontSize: '0.85rem', fontWeight: 600, display: 'block', marginBottom: 8 }}>Procedure</label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {draft.body.procedure.map((s, i) => (
              <div key={i} style={{ border: '1px solid var(--border-color)', borderRadius: 10, padding: 10, backgroundColor: 'var(--bg-secondary)' }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{ width: 26, height: 26, borderRadius: 8, backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', color: 'hsl(var(--color-blue))', fontWeight: 700, fontSize: '0.8rem', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto' }}>{i + 1}</span>
                  <input className="form-input" value={s.text} placeholder={`Step ${i + 1}…`} onChange={e => updItem('procedure', i, { ...s, text: e.target.value })} style={{ flex: 1 }} />
                  <button className="secondary-btn" onClick={() => delItem('procedure', i)} style={{ width: 40, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Trash2 size={15} /></button>
                </div>
                <textarea className="form-input" value={s.detail || ''} placeholder="Optional detail / note for this step…" onChange={e => updItem('procedure', i, { ...s, detail: e.target.value })} style={{ marginTop: 8, marginLeft: 34, width: 'calc(100% - 34px)', minHeight: 38, resize: 'vertical', fontSize: '0.85rem' }} />
              </div>
            ))}
          </div>
          <button className="secondary-btn" onClick={() => addItem('procedure', { text: '', detail: '' })} style={{ marginTop: 8, height: 32, fontSize: '0.8rem', display: 'inline-flex', alignItems: 'center', gap: 5 }}><Plus size={13} /> Add step</button>
        </div>

        {listEditor('safety', 'Safety & compliance', 'e.g. Never enter a unit alone if…')}
        {listEditor('references', 'References', 'e.g. OPS-021 Access Control')}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap', paddingTop: 8, borderTop: '1px solid var(--border-color)', marginTop: 8 }}>
          <button className="secondary-btn" onClick={backToList}>Cancel</button>
          <button className="secondary-btn" disabled={busy} onClick={() => save(false)}>Save draft</button>
          <button className="primary-btn" disabled={busy} onClick={() => save(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Send size={14} /> Save &amp; submit for review</button>
        </div>
      </div>
    );
  }

  // ════════════════════ LIST (tabs) ════════════════════
  function reviewModal() {
    if (!reviewDoc) return null;
    return (
      <div className="modal-overlay" style={{ display: 'flex' }}>
        <div className="modal-content">
          <div className="modal-header"><h3>Review · {reviewDoc.title}</h3><button className="close-btn" onClick={() => setReviewDoc(null)}><X size={18} /></button></div>
          <div style={{ padding: '4px 0' }}>
            <p style={{ fontSize: '0.83rem', color: 'var(--text-secondary)', marginBottom: 14 }}>Approving publishes this version to the library. Requesting changes returns it to the author with your notes.</p>
            <div className="form-group">
              <label>Review note <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(required when requesting changes)</span></label>
              <textarea className="form-input" value={reviewNote} onChange={e => setReviewNote(e.target.value)} placeholder="What needs to change, or why you're approving…" style={{ minHeight: 80, resize: 'vertical' }} />
            </div>
          </div>
          <div className="modal-footer">
            <button className="secondary-btn" disabled={busy} onClick={() => doReview('request_changes')} style={{ color: 'hsl(0,70%,45%)' }}>Request changes</button>
            <button className="primary-btn" disabled={busy} onClick={() => doReview('approve')} style={{ backgroundColor: 'hsl(var(--color-green))' }}>Approve &amp; publish</button>
          </div>
        </div>
      </div>
    );
  }

  const docTable = (list, emptyMsg) => (
    list.length === 0
      ? <div style={{ textAlign: 'center', padding: 40, border: '1px dashed var(--border-color)', borderRadius: 8, color: 'var(--text-secondary)' }}>{emptyMsg}</div>
      : (
        <div style={{ border: '1px solid var(--border-color)', borderRadius: 12, overflow: 'hidden', backgroundColor: 'var(--bg-card)', boxShadow: 'var(--shadow-sm)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr style={{ backgroundColor: 'var(--bg-secondary)' }}>
              {['Document', 'Type', 'Departments', 'Status', 'Owner', 'Updated'].map(h => (
                <th key={h} style={{ textAlign: 'left', padding: '11px 14px', fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)', fontWeight: 700, borderBottom: '1px solid var(--border-color)' }}>{h}</th>
              ))}
            </tr></thead>
            <tbody>{list.map(d => (
              <tr key={d.id} onClick={() => openDetail(d)} style={{ cursor: 'pointer', borderBottom: '1px solid var(--border-color)' }}
                onMouseEnter={e => e.currentTarget.style.backgroundColor = 'var(--bg-secondary)'} onMouseLeave={e => e.currentTarget.style.backgroundColor = 'transparent'}>
                <td style={{ padding: '11px 14px' }}><div style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '0.9rem' }}>{d.title}</div><div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontFamily: 'monospace' }}>{d.doc_code || '—'} · v{d.version}</div></td>
                <td style={{ padding: '11px 14px', fontSize: '0.82rem' }}>{d.doc_type}</td>
                <td style={{ padding: '11px 14px', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>{(d.departments || []).length ? d.departments.join(', ') : 'Unassigned'}</td>
                <td style={{ padding: '11px 14px' }}><Badge status={d.status} /></td>
                <td style={{ padding: '11px 14px', fontSize: '0.82rem' }}>{d.owner_name || '—'}</td>
                <td style={{ padding: '11px 14px', fontSize: '0.78rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{fmtDate(d.updated_at)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )
  );

  return (
    <div style={{ animation: 'fadeIn var(--transition-normal) ease-in-out' }}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 24, borderBottom: '1px solid var(--border-color)', paddingBottom: 1 }}>
        {Object.entries(TAB_LABELS).map(([key, label]) => (
          <button key={key} onClick={() => switchTab(key)} style={{ background: 'none', border: 'none', padding: '10px 18px', fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 600, fontSize: '0.95rem', cursor: 'pointer', color: sub === key ? 'var(--text-primary)' : 'var(--text-secondary)', position: 'relative' }}>
            {label}
            {key === 'review' && reviewQueue.length > 0 && <span style={{ marginLeft: 7, backgroundColor: 'hsl(var(--color-blue))', color: '#fff', borderRadius: 999, padding: '1px 7px', fontSize: '0.7rem' }}>{reviewQueue.length}</span>}
            {sub === key && <span style={{ position: 'absolute', bottom: -1, left: 0, right: 0, height: 2.5, backgroundColor: 'var(--text-primary)', borderRadius: '4px 4px 0 0' }} />}
          </button>
        ))}
      </div>
      {errBanner}

      {/* SOP Index */}
      {sub === 'index' && (
        <>
          <div className="view-header" style={{ marginBottom: 24 }}>
            <div className="view-title-group"><h2>SOP Index</h2><p>Standard Operating Procedures and company documentation</p></div>
            <button className="primary-btn" onClick={openCreate} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><FilePlus size={16} /> New SOP</button>
          </div>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 20 }}>
            <div style={{ position: 'relative', flex: '1 1 240px', minWidth: 200 }}>
              <Search size={18} style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
              <input type="text" className="form-input" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search title, ID, or document text…" style={{ paddingLeft: 44, width: '100%', height: 42 }} />
            </div>
            <select className="form-select" value={deptFilter} onChange={e => setDeptFilter(e.target.value)} style={{ height: 42 }}><option value="all">All departments</option>{DEPARTMENTS.map(d => <option key={d}>{d}</option>)}</select>
            <select className="form-select" value={typeFilter} onChange={e => setTypeFilter(e.target.value)} style={{ height: 42 }}><option value="all">All types</option>{DOC_TYPES.map(t => <option key={t}>{t}</option>)}</select>
            <select className="form-select" value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={{ height: 42 }}><option value="all">All statuses</option>{Object.entries(STATUS_META).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
          </div>

          {loading
            ? <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-secondary)' }}><Loader size={20} style={{ animation: 'spin 0.7s linear infinite' }} /> Loading…</div>
            : <>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: 10 }}>{filtered.length} document{filtered.length === 1 ? '' : 's'}</div>
                {docTable(filtered, docs.length === 0 ? 'No documents yet. Click “New SOP” to create the first one.' : 'No documents match your filters.')}
              </>}
        </>
      )}

      {/* Review Queue */}
      {sub === 'review' && (
        <>
          <div className="view-header" style={{ marginBottom: 24 }}>
            <div className="view-title-group"><h2>Review Queue</h2><p>SOPs awaiting a manager's approval, plus anything returned to you for changes</p></div>
          </div>
          {!isManager && reviewQueue.length === 0 && (
            <div style={{ backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 8, padding: '12px 14px', fontSize: '0.83rem', color: 'var(--text-secondary)', marginBottom: 16 }}>
              The review queue shows SOPs awaiting a manager's approval, plus anything returned to you for changes.
            </div>
          )}
          {loading ? <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-secondary)' }}><Loader size={20} style={{ animation: 'spin 0.7s linear infinite' }} /> Loading…</div>
            : docTable(reviewQueue, 'Queue is clear — nothing is waiting on review right now.')}
        </>
      )}

      {/* LMS — unchanged demo (made real in a later PR) */}
      {sub === 'lms' && (
        <>
          <div className="view-header" style={{ marginBottom: 24 }}>
            <div className="view-title-group"><h2>Learning Management System (LMS)</h2><p>Assign and monitor professional construction compliance courses and training</p></div>
            <button className="primary-btn" onClick={() => setShowCourseModal(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>+ Register Course</button>
          </div>
          <div className="cards-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 24 }}>
            {[
              { label: 'Total Courses', value: courses.length, helper: 'Compliance courses cataloged', color: 'card-blue', Icon: BookOpen },
              { label: 'Completed Training', value: completed, helper: 'Completed credentials issued', color: 'card-green', Icon: BadgeCheck },
              { label: 'Ongoing Training', value: inProgress, helper: 'Enrolled course paths in progress', color: 'card-blue', Icon: Users },
            ].map(({ label, value, helper, color, Icon }) => (
              <div key={label} className={`kpi-card ${color}`} style={{ cursor: 'default' }}>
                <div className="kpi-card-header"><span className="kpi-title">{label}</span><div className="kpi-icon-container"><Icon size={20} /></div></div>
                <div className="kpi-stat" style={{ fontSize: '2rem' }}>{value}</div>
                <div className="kpi-helper">{helper}</div>
              </div>
            ))}
          </div>
          <div style={{ marginBottom: 16 }}>
            <h3 style={{ fontSize: '1.1rem', fontFamily: "'Plus Jakarta Sans', sans-serif", marginBottom: 4 }}>Greens Nexus Course Catalog</h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Compliance training curricula</p>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
            {courses.map(course => {
              const isDone = course.status === 'Completed';
              return (
                <div key={course.id} style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 20, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: 16 }}>
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                      <span style={{ backgroundColor: 'var(--border-color)', color: 'var(--text-secondary)', fontSize: '0.7rem', borderRadius: 4, padding: '1px 6px', fontWeight: 600 }}>{course.category}</span>
                      <span className={`status-badge ${isDone ? 'status-approved' : 'status-pending'}`} style={{ fontSize: '0.7rem', padding: '1px 6px' }}>{course.status}</span>
                    </div>
                    <strong style={{ fontSize: '0.95rem', fontFamily: "'Plus Jakarta Sans', sans-serif", display: 'block', marginBottom: 4, color: 'var(--text-primary)', lineHeight: 1.3 }}>{course.title}</strong>
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 4 }}><Clock size={12} /> {course.duration} training</span>
                  </div>
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', marginBottom: 4 }}><span style={{ color: 'var(--text-secondary)' }}>Syllabus Progress</span><strong style={{ fontFamily: 'monospace' }}>{course.progress}%</strong></div>
                    <div style={{ width: '100%', height: 6, backgroundColor: 'var(--border-color)', borderRadius: 3, overflow: 'hidden' }}><div style={{ width: `${course.progress}%`, height: '100%', backgroundColor: isDone ? 'hsl(var(--color-green))' : 'hsl(var(--color-blue))', borderRadius: 3, transition: 'width 0.3s ease' }} /></div>
                  </div>
                  <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: 12, display: 'flex', justifyContent: 'flex-end' }}>
                    {isDone
                      ? <button className="secondary-btn" disabled style={{ height: 32, fontSize: '0.8rem', display: 'inline-flex', alignItems: 'center', gap: 4 }}><CheckSquare size={12} /> Course Complete</button>
                      : <button className="primary-btn" onClick={() => studyLesson(course.id)} style={{ height: 32, fontSize: '0.8rem', display: 'inline-flex', alignItems: 'center', gap: 4, padding: '0 12px' }}><Play size={12} /> Study Lesson</button>}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {reviewModal()}

      {showCourseModal && (
        <div className="modal-overlay" style={{ display: 'flex' }}>
          <div className="modal-content" style={{ maxWidth: 500 }}>
            <div className="modal-header"><h3>Register New Compliance Course</h3><button className="close-btn" onClick={() => setShowCourseModal(false)}><X size={18} /></button></div>
            <form onSubmit={submitCourse}>
              <div className="form-grid" style={{ gridTemplateColumns: '1fr' }}>
                <div className="form-group"><label>Course Title</label><input type="text" className="form-input" required placeholder="e.g. Forklift Certification Training" value={courseForm.title} onChange={e => setCourseForm(p => ({ ...p, title: e.target.value }))} /></div>
                <div className="form-group"><label>Department Category</label><select className="form-select" value={courseForm.category} onChange={e => setCourseForm(p => ({ ...p, category: e.target.value }))}>{['OPS', 'Accounting', 'IT', 'Development', 'Marketing'].map(c => <option key={c}>{c}</option>)}</select></div>
                <div className="form-group"><label>Estimated Duration</label><input type="text" className="form-input" required placeholder="e.g. 2 hours" value={courseForm.duration} onChange={e => setCourseForm(p => ({ ...p, duration: e.target.value }))} /></div>
              </div>
              <div className="modal-footer"><button type="button" className="secondary-btn" onClick={() => setShowCourseModal(false)}>Cancel</button><button type="submit" className="primary-btn">Create Course</button></div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

import { useState, useEffect, useCallback, useRef } from 'react';
import { useMsal } from '@azure/msal-react';
import { useRole } from '../contexts/RoleContext';
import { api } from '../api';
import {
  BookOpen, CheckSquare, Search, Clock, Sparkles,
  X, ArrowLeft, Plus, Trash2, Edit3, Send, Archive, Loader, ChevronUp, ChevronDown,
  Image as ImageIcon, Paperclip, Settings, Grid3x3, BarChart3, GraduationCap,
} from 'lucide-react';

const rid = () => 'r' + Math.random().toString(36).slice(2, 9);
const initials = (n) => (n || '?').split(' ').map(p => p[0]).join('').slice(0, 2).toUpperCase();

// ── version diff (word-level LCS) ──
const _diffBox = { fontSize: '0.85rem', lineHeight: 1.6, color: 'var(--text-primary)', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 10, padding: '11px 13px', whiteSpace: 'pre-wrap' };
const _add = { background: 'hsla(145,63%,42%,0.22)', color: 'hsl(145,55%,26%)', textDecoration: 'none', borderRadius: 3, padding: '0 2px' };
const _del = { background: 'hsla(0,84%,60%,0.18)', color: 'hsl(0,65%,40%)', borderRadius: 3, padding: '0 2px' };
function lcsDiff(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = []; let i = 0, j = 0;
  while (i < n && j < m) { if (a[i] === b[j]) { ops.push({ t: 'eq', v: a[i] }); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ t: 'del', v: a[i] }); i++; } else { ops.push({ t: 'add', v: b[j] }); j++; } }
  while (i < n) ops.push({ t: 'del', v: a[i++] });
  while (j < m) ops.push({ t: 'add', v: b[j++] });
  return ops;
}
function TextDiff({ oldS, newS }) {
  const o = oldS || '', nw = newS || '';
  if (o === nw) return <div style={{ ..._diffBox, color: o ? 'var(--text-secondary)' : 'var(--text-muted)', fontStyle: o ? 'normal' : 'italic' }}>{o || '(empty — unchanged)'}</div>;
  return <div style={_diffBox}>{lcsDiff(o.split(/(\s+)/), nw.split(/(\s+)/)).map((p, k) => p.t === 'eq' ? <span key={k}>{p.v}</span> : p.t === 'add' ? <ins key={k} style={_add}>{p.v}</ins> : <del key={k} style={_del}>{p.v}</del>)}</div>;
}
function ListDiff({ oldArr, newArr, fmt }) {
  const f = fmt || (x => String(x));
  const a = (oldArr || []).map(f), b = (newArr || []).map(f);
  if (JSON.stringify(a) === JSON.stringify(b)) return <div style={{ ..._diffBox, color: a.length ? 'var(--text-secondary)' : 'var(--text-muted)', fontStyle: a.length ? 'normal' : 'italic' }}>{a.length ? a.map((x, k) => <div key={k}>{x}</div>) : '(empty — unchanged)'}</div>;
  return <div style={_diffBox}>{lcsDiff(a, b).map((p, k) => <div key={k} style={{ padding: '2px 8px', borderRadius: 6, margin: '2px 0', ...(p.t === 'add' ? { background: 'hsla(145,63%,42%,0.14)', color: 'hsl(145,55%,26%)' } : p.t === 'del' ? { background: 'hsla(0,84%,60%,0.12)', color: 'hsl(0,65%,40%)', textDecoration: 'line-through' } : { color: 'var(--text-muted)' }) }}>{(p.t === 'add' ? '+ ' : p.t === 'del' ? '− ' : '  ') + p.v}</div>)}</div>;
}

// Greens Global's real departments (mirrors backend DEPT_ABBR).
const DEPARTMENTS = [
  'Operations', 'Revenue Management', 'Real Estate Development', 'People (HR)',
  'Finance & Accounting', 'IT', 'Marketing', 'Admin',
];
const DOC_TYPES = ['SOP', 'Manual', 'Guide'];
const DEPT_ABBR = {
  'Operations': 'OPS', 'Revenue Management': 'RM', 'Real Estate Development': 'RED',
  'People (HR)': 'HR', 'Finance & Accounting': 'FIN', 'IT': 'IT', 'Marketing': 'MKT', 'Admin': 'ADM',
};

const STATUS_META = {
  draft:             { label: 'Draft',             bg: 'var(--bg-secondary)',      fg: 'var(--text-secondary)' },
  in_review:         { label: 'In Review',         bg: 'hsla(38, 92%, 50%, 0.14)', fg: 'hsl(32, 80%, 38%)' },
  changes_requested: { label: 'Changes Requested', bg: 'hsla(0, 84%, 60%, 0.12)',  fg: 'hsl(0, 70%, 45%)' },
  approved:          { label: 'Approved',          bg: 'hsla(145, 63%, 42%, 0.14)', fg: 'hsl(145, 55%, 30%)' },
  archived:          { label: 'Archived',          bg: 'var(--bg-secondary)',      fg: 'var(--text-muted)' },
};

const TAB_LABELS = { index: 'Playbook', review: 'Review Queue', signoffs: 'Sign-offs', lms: 'Learn' };

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
  definitions: [], procedure: [], safety: [], references: [], attachments: [], media: [],
});

// Resize an image file to a JPEG data URL (≤1100px) so it stores inline with the doc.
function fileToAsset(file) {
  return new Promise(res => {
    if (!file.type || !file.type.startsWith('image/')) { res({ name: file.name, type: 'file' }); return; }
    const img = new Image(); const url = URL.createObjectURL(file);
    img.onload = () => {
      const max = 1100; const sc = Math.min(1, max / img.width);
      const w = Math.max(1, Math.round(img.width * sc)), h = Math.max(1, Math.round(img.height * sc));
      let data = '';
      try { const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').drawImage(img, 0, 0, w, h); data = c.toDataURL('image/jpeg', 0.82); } catch (e) { /* ignore */ }
      URL.revokeObjectURL(url); res({ name: file.name, type: 'image', data });
    };
    img.onerror = () => { URL.revokeObjectURL(url); res({ name: file.name, type: 'file' }); };
    img.src = url;
  });
}
function pickFiles(multiple, cb) {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*'; if (multiple) inp.multiple = true;
  inp.onchange = async () => { const files = [...(inp.files || [])]; if (files.length) cb(await Promise.all(files.map(fileToAsset))); };
  inp.click();
}
// Embed a training video (YouTube / Loom / Vimeo / direct mp4) or fall back to a link.
function mediaEmbed(m, key) {
  const url = (m && m.url) || '';
  let src = '';
  const yt = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([\w-]{6,})/); if (yt) src = 'https://www.youtube.com/embed/' + yt[1];
  const lo = url.match(/loom\.com\/(?:share|embed)\/([\w-]+)/); if (lo) src = 'https://www.loom.com/embed/' + lo[1];
  const vm = url.match(/vimeo\.com\/(?:video\/)?(\d+)/); if (vm) src = 'https://player.vimeo.com/video/' + vm[1];
  const frame = { position: 'relative', width: '100%', maxWidth: 560, aspectRatio: '16 / 9', borderRadius: 11, overflow: 'hidden', border: '1px solid var(--border-color)', background: '#000' };
  const fill = { position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0 };
  if (src) return <div key={key} style={frame}><iframe src={src} title={m.title || 'video'} allowFullScreen loading="lazy" style={fill} /></div>;
  if (/\.(mp4|webm|ogg)$/i.test(url)) return <div key={key} style={frame}><video src={url} controls preload="metadata" style={fill} /></div>;
  return <a key={key} href={url} target="_blank" rel="noopener noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: '0.88rem', color: 'hsl(var(--color-blue))', fontWeight: 600 }}>▶ {m.title || url}</a>;
}
const blankDraft = (name, email) => ({
  id: null, title: '', doc_type: 'SOP', departments: [], reviewer_email: '',
  reviewer_name: '', version: '0.1', effective_date: '', body: blankBody(),
  require_ack: false, review_every_months: 12, retention_months: 84,
  owner_name: name, owner_email: email, _raw: '',
});

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
  const [showCompare, setShowCompare] = useState(true); // imported-source compare panel

  const [search, setSearch] = useState('');
  const [deptFilter, setDeptFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [libView, setLibView] = useState('list'); // list | cards | outline
  const [searchMode, setSearchMode] = useState('search'); // search | ask
  const [ask, setAsk] = useState({ q: '', loading: false, answer: null, sources: [], grounded: true });

  // review modal
  const [reviewDoc, setReviewDoc] = useState(null);
  const [reviewNote, setReviewNote] = useState('');

  // sign-offs
  const [ackInfo, setAckInfo] = useState(null);
  const [signOpen, setSignOpen] = useState(false);
  const [signName, setSignName] = useState('');
  const [signoffs, setSignoffs] = useState([]);
  const [insights, setInsights] = useState(null);
  const [activity, setActivity] = useState(null); // manager activity log
  const pendingDiff = useRef(null); // { version } — auto-open diff after a log bounceback
  const [lightbox, setLightbox] = useState(null); // image src to zoom

  // comments + version history
  const [comments, setComments] = useState([]);
  const [commentText, setCommentText] = useState('');
  const [snapshots, setSnapshots] = useState([]);
  const [diff, setDiff] = useState(null); // { from, to } indices into snapshots
  const [docLang, setDocLang] = useState('en');
  const [translating, setTranslating] = useState('');

  // LMS (Learn)
  const [lmsCourses, setLmsCourses] = useState([]);
  const [lmsMode, setLmsMode] = useState('list'); // list | player | editor
  const [lmsManage, setLmsManage] = useState(false); // course-authoring view, entered from Manage
  const [lmsCourse, setLmsCourse] = useState(null); // loaded course detail
  const [player, setPlayer] = useState(null); // { idx, mode:'lesson'|'quiz'|'result', answers, lastScore, lastPassed, results }
  const [courseDraft, setCourseDraft] = useState(null);

  const refresh = useCallback(() => {
    setLoading(true);
    api.getKbDocs()
      .then(d => { setDocs(d); setErr(''); })
      .catch(e => setErr(e.message || 'Failed to load documents'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // load acknowledgements, comments and version snapshots when viewing a document
  useEffect(() => {
    if (mode === 'detail' && selected) {
      setAckInfo(null); setComments([]); setSnapshots([]); setCommentText(''); setDocLang('en');
      api.getKbAcks(selected.id).then(setAckInfo).catch(() => {});
      api.getKbComments(selected.id).then(setComments).catch(() => {});
      api.getKbSnapshots(selected.id).then(snaps => {
        setSnapshots(snaps);
        // bounceback from the activity log: jump straight to the diff for this version
        const want = pendingDiff.current;
        pendingDiff.current = null;
        if (want && snaps.length >= 2) {
          let to = snaps.map(s => s.version).lastIndexOf(want.version);
          if (to <= 0) to = snaps.length - 1;
          setDiff({ from: Math.max(0, to - 1), to });
        }
      }).catch(() => {});
    }
  }, [mode, selected]);
  const postComment = async () => {
    const t = commentText.trim();
    if (!t) return;
    try { const list = await api.addKbComment(selected.id, t); setComments(list); setCommentText(''); }
    catch (e) { setErr(e.message || 'Failed to post comment'); }
  };
  // load sign-offs for the Sign-offs tab and the Playbook "For you" strip
  useEffect(() => {
    if (sub === 'signoffs' || sub === 'index') api.getKbSignoffs().then(setSignoffs).catch(() => {});
  }, [sub, docs]);
  useEffect(() => {
    if (sub === 'insights') api.getKbInsights().then(setInsights).catch(() => {});
  }, [sub, docs]);
  useEffect(() => {
    if (sub === 'manage' && isManager) { setActivity(null); api.getKbActivity().then(setActivity).catch(() => setActivity([])); }
  }, [sub, isManager, docs]);

  // jump from the activity log to a document (and, when diffable, straight to its version diff)
  const openActivity = (e) => {
    const d = docs.find(x => x.id === e.doc_id);
    if (!d) return;
    pendingDiff.current = e.diffable ? { version: e.version } : null;
    openDetail(d);
  };

  const toggleMatrix = async (doc, dep) => {
    const has = (doc.departments || []).includes(dep);
    const next = has ? doc.departments.filter(x => x !== dep) : [...(doc.departments || []), dep];
    setDocs(prev => prev.map(x => x.id === doc.id ? { ...x, departments: next } : x));
    try { await api.setKbDepartments(doc.id, next); } catch (e) { setErr(e.message || 'Failed'); refresh(); }
  };
  const toggleMatrixAll = async (doc) => {
    const next = DEPARTMENTS.length === (doc.departments || []).length ? [] : [...DEPARTMENTS];
    setDocs(prev => prev.map(x => x.id === doc.id ? { ...x, departments: next } : x));
    try { await api.setKbDepartments(doc.id, next); } catch (e) { setErr(e.message || 'Failed'); refresh(); }
  };

  const reloadAcks = () => { if (selected) api.getKbAcks(selected.id).then(setAckInfo).catch(() => {}); };
  const doSign = async () => {
    try { const info = await api.acknowledgeKbDoc(selected.id); setAckInfo(info); setSignOpen(false); setSignName(''); }
    catch (e) { setErr(e.message || 'Sign-off failed'); }
  };
  const toggleAckRequired = async (val) => {
    try { const doc = await api.setKbAckRequired(selected.id, val); setSelected(doc); refresh(); reloadAcks(); }
    catch (e) { setErr(e.message || 'Failed to update sign-off setting'); }
  };
  const verifyDoc = async () => {
    try { const doc = await api.verifyKbDoc(selected.id); setSelected(doc); refresh(); }
    catch (e) { setErr(e.message || 'Failed to mark verified'); }
  };
  const translateDoc = async (lang) => {
    if (lang === 'en') { setDocLang('en'); return; }
    if (selected.body?.translations?.[lang]) { setDocLang(lang); return; }
    setTranslating(lang); setErr('');
    try { const doc = await api.translateKbDoc(selected.id, lang); setSelected(doc); setDocLang(lang); }
    catch (e) { setErr(e.message || 'Translation unavailable'); }
    finally { setTranslating(''); }
  };

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
  const openCreateManual = () => { setDraft({ ...blankDraft(myName, myEmail), doc_type: 'Manual' }); setMode('editor'); };
  const openEdit = (d) => {
    setDraft({
      id: d.id, title: d.title, doc_type: d.doc_type, departments: [...(d.departments || [])],
      reviewer_email: d.reviewer_email || '', reviewer_name: d.reviewer_name || '',
      version: d.version, effective_date: d.effective_date || '', require_ack: !!d.require_ack,
      review_every_months: d.review_every_months || 12, retention_months: d.retention_months || 84,
      body: { ...blankBody(), ...(d.body || {}) }, owner_name: d.owner_name, owner_email: d.owner_email, _raw: '',
    });
    setMode('editor');
  };
  const backToList = () => { setMode('list'); setSelected(null); setDraft(null); };

  const switchTab = (key) => { backToList(); setLmsMode('list'); setLmsCourse(null); setPlayer(null); setCourseDraft(null); setLmsManage(false); onSubChange(key); };
  const openCourseManager = () => { switchTab('lms'); setLmsManage(true); };

  // ── editor body helpers ──
  const setBody = (patch) => setDraft(p => ({ ...p, body: { ...p.body, ...patch } }));
  const addItem = (field, val) => setBody({ [field]: [...draft.body[field], val] });
  const updItem = (field, i, val) => setBody({ [field]: draft.body[field].map((x, j) => j === i ? val : x) });
  const delItem = (field, i) => setBody({ [field]: draft.body[field].filter((_, j) => j !== i) });
  const toggleDept = (dep) => setDraft(p => ({
    ...p, departments: p.departments.includes(dep) ? p.departments.filter(x => x !== dep) : [...p.departments, dep],
  }));

  // ── manual chapter helpers (chapters live in body.chapters) ──
  const setChapters = (fn) => setDraft(p => ({ ...p, body: { ...p.body, chapters: fn(p.body.chapters || []) } }));
  const addChapter = () => setChapters(chs => [...chs, { _id: rid(), title: `Chapter ${chs.length + 1}`, intro: '', sections: [] }]);
  const delChapter = (cid) => setChapters(chs => chs.filter(c => c._id !== cid));
  const moveChapter = (cid, dir) => setChapters(chs => { const i = chs.findIndex(c => c._id === cid); const j = dir === 'up' ? i - 1 : i + 1; if (i < 0 || j < 0 || j >= chs.length) return chs; const a = [...chs]; [a[i], a[j]] = [a[j], a[i]]; return a; });
  const updChapter = (cid, patch) => setChapters(chs => chs.map(c => c._id === cid ? { ...c, ...patch } : c));
  const addSection = (cid, kind) => setChapters(chs => chs.map(c => c._id === cid ? { ...c, sections: [...(c.sections || []), { _id: rid(), kind, title: '', body: '', docId: '' }] } : c));
  const delSection = (cid, sid) => setChapters(chs => chs.map(c => c._id === cid ? { ...c, sections: (c.sections || []).filter(s => s._id !== sid) } : c));
  const moveSection = (cid, sid, dir) => setChapters(chs => chs.map(c => { if (c._id !== cid) return c; const a = [...(c.sections || [])]; const i = a.findIndex(s => s._id === sid); const j = dir === 'up' ? i - 1 : i + 1; if (i < 0 || j < 0 || j >= a.length) return c; [a[i], a[j]] = [a[j], a[i]]; return { ...c, sections: a }; }));
  const updSection = (cid, sid, patch) => setChapters(chs => chs.map(c => c._id === cid ? { ...c, sections: (c.sections || []).map(s => s._id === sid ? { ...s, ...patch } : s) } : c));

  // ── save / workflow ──
  const payloadFromDraft = () => ({
    title: draft.title, doc_type: draft.doc_type, departments: draft.departments,
    reviewer_email: draft.reviewer_email, reviewer_name: draft.reviewer_name,
    version: draft.version, effective_date: draft.effective_date, body: draft.body,
    require_ack: draft.require_ack,
    review_every_months: parseInt(draft.review_every_months, 10) || 12,
    retention_months: parseInt(draft.retention_months, 10) || 84,
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

  // managers can take a draft straight to published in one step (create → submit → approve)
  const saveAndPublish = async () => {
    if (!draft.title.trim()) { setErr('Add a title before publishing.'); return; }
    setBusy(true); setErr('');
    try {
      const payload = { ...payloadFromDraft(), reviewer_email: draft.reviewer_email || myEmail, reviewer_name: draft.reviewer_name || myName };
      let doc = draft.id ? await api.updateKbDoc(draft.id, payload) : await api.createKbDoc(payload);
      doc = await api.submitKbDoc(doc.id);
      doc = await api.reviewKbDoc(doc.id, { decision: 'approve', note: draft._importSource ? 'Imported and published.' : 'Published.' });
      refresh();
      setSelected(doc); setMode('detail'); setDraft(null);
    } catch (e) { setErr(e.message || 'Publish failed'); }
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
    const raw = draft._raw?.trim();
    const content = raw || [draft.title, draft.body.purpose].filter(Boolean).join('\n');
    if (!content) { setErr('Paste or upload an existing document, or add a title/purpose for the AI to work from.'); return; }
    setAiBusy(true); setErr('');
    try {
      const { sop } = await api.aiFormatKbDoc({ content, title: draft.title, departments: draft.departments });
      setDraft(p => ({
        ...p,
        title: p.title || sop.title || '',
        // when working from pasted/uploaded source, keep it for the side-by-side compare
        _importSource: raw ? content : p._importSource,
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
      if (raw) setShowCompare(true);
    } catch (e) { setErr(e.message || 'AI formatting failed'); }
    finally { setAiBusy(false); }
  };

  // read a text-like file into the editor's raw-notes box (for importing an existing document)
  const importFile = (file) => {
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { setErr('That file is over 2 MB — paste the relevant text instead.'); return; }
    const reader = new FileReader();
    reader.onload = () => setDraft(p => p ? { ...p, _raw: String(reader.result || ''), title: p.title || file.name.replace(/\.[^.]+$/, '') } : p);
    reader.onerror = () => setErr('Could not read that file. Try pasting the text instead.');
    reader.readAsText(file);
  };

  // ── Ask AI ──
  const doAsk = async () => {
    const q = ask.q.trim();
    if (!q) return;
    setAsk(a => ({ ...a, loading: true, answer: null, sources: [] }));
    try {
      const r = await api.askKb({ question: q });
      setAsk(a => ({ ...a, loading: false, answer: r.answer, sources: r.sources || [], grounded: r.grounded !== false }));
    } catch (e) {
      setAsk(a => ({ ...a, loading: false, answer: e.message || 'Something went wrong answering that.', sources: [] }));
    }
  };
  const openSourceById = (id) => { const d = docs.find(x => x.id === id); if (d) openDetail(d); };

  // ── LMS (Learn) ──
  useEffect(() => { if (sub === 'lms' && lmsMode === 'list') api.getKbCourses().then(setLmsCourses).catch(() => {}); }, [sub, lmsMode]);

  const coursePct = (c) => {
    if (c.status_for_me === 'Completed') return 100;
    const steps = (c.lesson_count || 0) + (c.question_count ? 1 : 0) || 1;
    const done = (c.progress?.lessons_done?.length || 0) + (c.progress?.passed ? 1 : 0);
    return Math.min(100, Math.round(done / steps * 100));
  };
  const openCourse = async (id) => {
    try { const c = await api.getKbCourse(id); setLmsCourse(c); setPlayer({ idx: 0, mode: 'lesson', answers: {}, lastScore: null, lastPassed: false, results: {} }); setLmsMode('player'); }
    catch (e) { setErr(e.message || 'Failed to open course'); }
  };
  const reloadCourse = async () => { if (lmsCourse) { const c = await api.getKbCourse(lmsCourse.id); setLmsCourse(c); return c; } };
  const markLessonDone = async () => {
    const c = lmsCourse, lessons = c.lessons || [];
    const l = lessons[player.idx];
    try { await api.kbLessonDone(c.id, l._id); } catch (e) { /* non-fatal */ }
    const updated = await reloadCourse();
    if (player.idx < lessons.length - 1) setPlayer(p => ({ ...p, idx: p.idx + 1 }));
    else if (c.quiz?.questions?.length) setPlayer(p => ({ ...p, mode: 'quiz' }));
    else setPlayer(p => ({ ...p, mode: 'result', lastPassed: true, lastScore: 100 }));
    return updated;
  };
  const submitQuiz = async () => {
    const c = lmsCourse, qs = c.quiz?.questions || [];
    if (qs.some(q => player.answers[q._id] == null)) { setErr('Answer all questions first.'); return; }
    try {
      const r = await api.kbSubmitQuiz(c.id, player.answers);
      setPlayer(p => ({ ...p, mode: 'result', lastScore: r.score, lastPassed: r.passed, results: r.results }));
      reloadCourse();
    } catch (e) { setErr(e.message || 'Quiz submission failed'); }
  };
  const blankCourse = () => ({ id: null, title: '', description: '', departments: [], est_minutes: 15, lessons: [], quiz: { passPct: 80, questions: [] } });
  const openCourseEditor = async (id) => {
    if (!id) { setCourseDraft(blankCourse()); setLmsMode('editor'); return; }
    try { const c = await api.getKbCourse(id); setCourseDraft({ id: c.id, title: c.title, description: c.description, departments: [...(c.departments || [])], est_minutes: c.est_minutes, lessons: c.lessons || [], quiz: c.quiz?.questions ? c.quiz : { passPct: 80, questions: [] } }); setLmsMode('editor'); }
    catch (e) { setErr(e.message || 'Failed to open course'); }
  };
  const saveCourse = async (publish) => {
    const d = courseDraft;
    if (!d.title.trim()) { setErr('Add a course title.'); return; }
    const payload = { title: d.title, description: d.description, departments: d.departments, est_minutes: parseInt(d.est_minutes, 10) || 15, lessons: d.lessons, quiz: d.quiz, publish };
    try {
      if (d.id) await api.updateKbCourse(d.id, payload); else await api.createKbCourse(payload);
      setCourseDraft(null); setLmsMode('list'); api.getKbCourses().then(setLmsCourses).catch(() => {});
    } catch (e) { setErr(e.message || 'Save failed'); }
  };
  // course-draft mutation helpers
  const cdSet = (patch) => setCourseDraft(p => ({ ...p, ...patch }));
  const cdAddLesson = (type) => setCourseDraft(p => ({ ...p, lessons: [...p.lessons, { _id: rid(), type, title: '', body: '', docId: '' }] }));
  const cdUpdLesson = (id, patch) => setCourseDraft(p => ({ ...p, lessons: p.lessons.map(l => l._id === id ? { ...l, ...patch } : l) }));
  const cdDelLesson = (id) => setCourseDraft(p => ({ ...p, lessons: p.lessons.filter(l => l._id !== id) }));
  const cdAddQ = () => setCourseDraft(p => ({ ...p, quiz: { ...p.quiz, questions: [...p.quiz.questions, { _id: rid(), q: '', options: ['', '', '', ''], answer: 0 }] } }));
  const cdUpdQ = (id, patch) => setCourseDraft(p => ({ ...p, quiz: { ...p.quiz, questions: p.quiz.questions.map(q => q._id === id ? { ...q, ...patch } : q) } }));
  const cdDelQ = (id) => setCourseDraft(p => ({ ...p, quiz: { ...p.quiz, questions: p.quiz.questions.filter(q => q._id !== id) } }));

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
    const isMan = d.doc_type === 'Manual' && (b.chapters || []).length > 0;
    const manualBody = () => {
      const chs = b.chapters || [];
      const sectionCount = chs.reduce((n, c) => n + (c.sections || []).length, 0);
      const paras = (txt) => (txt || '').split('\n').map(x => x.trim()).filter(Boolean);
      return (
        <div>
          <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 12, padding: '16px 18px', marginBottom: 24 }}>
            <div style={{ fontSize: '0.68rem', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 10 }}>Contents · {chs.length} chapter{chs.length !== 1 ? 's' : ''} · {sectionCount} section{sectionCount !== 1 ? 's' : ''}</div>
            <ol style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {chs.map(c => <li key={c._id} style={{ fontSize: '0.88rem', color: 'var(--text-primary)', fontWeight: 600 }}>{c.title}</li>)}
            </ol>
          </div>
          {chs.map((c, i) => (
            <section key={c._id} style={{ marginBottom: 28 }}>
              <h2 style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: '1.15rem', fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 8px', paddingBottom: 10, borderBottom: '2px solid var(--border-color)' }}>
                <span style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--text-primary)', color: 'var(--bg-card)', fontSize: '0.85rem', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto' }}>{i + 1}</span>{c.title}
              </h2>
              {c.intro && <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.65, margin: '0 0 16px' }}>{c.intro}</p>}
              {(c.sections || []).map(s => {
                if (s.kind === 'sop') {
                  const sop = docs.find(x => x.id === s.docId);
                  return (
                    <div key={s._id} style={{ marginBottom: 18 }}>
                      <h3 style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 8px' }}>{s.title || (sop ? sop.title : 'Linked SOP')}</h3>
                      {sop ? (
                        <div style={{ border: '1px solid var(--border-color)', borderRadius: 10, padding: 14, background: 'var(--bg-secondary)' }}>
                          <div style={{ fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', fontFamily: 'inherit', marginBottom: 8 }}>Linked SOP · {sop.doc_code} · v{sop.version} · {(STATUS_META[sop.status] || {}).label}</div>
                          {sop.body?.purpose && <p style={{ margin: '0 0 10px', color: 'var(--text-primary)', fontSize: '0.88rem', lineHeight: 1.6 }}>{sop.body.purpose}</p>}
                          {sop.body?.procedure?.length > 0 && (
                            <ol style={{ margin: '0 0 10px', paddingLeft: 18, color: 'var(--text-secondary)', fontSize: '0.85rem', lineHeight: 1.6 }}>
                              {sop.body.procedure.slice(0, 6).map((st, j) => <li key={j}>{st.text}</li>)}
                              {sop.body.procedure.length > 6 && <li style={{ listStyle: 'none', color: 'var(--text-muted)' }}>…and {sop.body.procedure.length - 6} more steps</li>}
                            </ol>
                          )}
                          <button className="secondary-btn" onClick={() => openDetail(sop)} style={{ height: 32, fontSize: '0.8rem' }}>Open full SOP</button>
                        </div>
                      ) : <div style={{ fontSize: '0.82rem', color: 'hsl(32,80%,38%)', background: 'hsla(38,92%,50%,0.12)', borderRadius: 8, padding: '8px 12px' }}>Linked SOP not found.</div>}
                    </div>
                  );
                }
                return <div key={s._id} style={{ marginBottom: 18 }}><h3 style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 8px' }}>{s.title || 'Section'}</h3><div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.65 }}>{paras(s.body).map((x, j) => <p key={j} style={{ margin: '0 0 8px' }}>{x}</p>)}</div></div>;
              })}
            </section>
          ))}
        </div>
      );
    };
    const LANGS = [['en', 'English'], ['es', 'Español'], ['hi', 'हिन्दी']];
    const trx = (docLang !== 'en' && b.translations) ? (b.translations[docLang] || {}) : {};
    const dTitle = trx.title || d.title;
    const tPurpose = (trx.purpose != null && trx.purpose !== '') ? trx.purpose : b.purpose;
    const tScope = (trx.scopeText != null && trx.scopeText !== '') ? trx.scopeText : b.scopeText;
    const tSafety = (docLang !== 'en' && Array.isArray(trx.safety)) ? trx.safety : b.safety;
    const tProcedure = (docLang !== 'en' && Array.isArray(trx.procedure))
      ? (b.procedure || []).map((s, i) => ({ ...s, text: trx.procedure[i]?.text || s.text, detail: trx.procedure[i]?.detail || s.detail }))
      : b.procedure;
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
              {d.require_ack && <span style={{ fontSize: '0.7rem', fontWeight: 700, color: 'hsl(32,80%,38%)', background: 'hsla(38,92%,50%,0.14)', borderRadius: 999, padding: '3px 10px' }}>Sign-off required</span>}
              {d.is_stale && <span style={{ fontSize: '0.7rem', fontWeight: 700, color: 'hsl(32,80%,38%)', background: 'hsla(38,92%,50%,0.14)', borderRadius: 999, padding: '3px 10px' }}>Needs review</span>}
            </div>
            <h2>{dTitle}</h2>
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

        {!isMan && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
            <span style={{ fontSize: '0.66rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', fontWeight: 700 }}>Language</span>
            {LANGS.map(([code, label]) => { const has = code === 'en' || b.translations?.[code]; return (
              <button key={code} onClick={() => translateDoc(code)} disabled={translating === code} style={{ padding: '5px 12px', borderRadius: 999, fontSize: '0.78rem', fontWeight: 500, cursor: 'pointer', border: '1px solid', borderStyle: has ? 'solid' : 'dashed', borderColor: docLang === code ? 'var(--text-primary)' : 'var(--border-color)', background: docLang === code ? 'var(--text-primary)' : 'var(--bg-card)', color: docLang === code ? 'var(--bg-card)' : 'var(--text-secondary)' }}>{translating === code ? 'Translating…' : label}{!has ? ' +' : ''}</button>
            ); })}
          </div>
        )}
        {docLang !== 'en' && <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 9, padding: '8px 11px', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 14 }}>Machine-translated to {({ es: 'Spanish', hi: 'Hindi' })[docLang]}. The English version is authoritative.</div>}

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

            {tPurpose && section('Purpose', <p style={{ color: 'var(--text-primary)', margin: 0, lineHeight: 1.6 }}>{tPurpose}</p>)}
            {tScope && section('Scope', <p style={{ color: 'var(--text-primary)', margin: 0, lineHeight: 1.6 }}>{tScope}</p>)}
            {isMan && manualBody()}
            {!isMan && <>
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
            {section('Procedure', tProcedure?.length > 0 ? (
              <ol style={{ margin: 0, paddingLeft: 0, listStyle: 'none', counterReset: 'step' }}>
                {tProcedure.map((s, i) => (
                  <li key={i} style={{ position: 'relative', padding: '10px 0 10px 40px', borderBottom: '1px solid var(--bg-secondary)', color: 'var(--text-primary)' }}>
                    <span style={{ position: 'absolute', left: 0, top: 9, width: 26, height: 26, borderRadius: 8, backgroundColor: 'var(--bg-secondary)', color: 'hsl(var(--color-blue))', fontWeight: 700, fontSize: '0.8rem', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{i + 1}</span>
                    {s.text}
                    {s.detail && <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: 4 }}>{s.detail}</div>}
                    {s.image && <img src={s.image} alt="step illustration" onClick={() => setLightbox(s.image)} style={{ marginTop: 9, maxWidth: 360, width: '100%', borderRadius: 10, border: '1px solid var(--border-color)', display: 'block', cursor: 'zoom-in' }} />}
                  </li>
                ))}
              </ol>
            ) : <p style={{ color: 'var(--text-muted)', margin: 0 }}>No steps recorded.</p>)}
            {tSafety?.length > 0 && section('Safety & compliance', <ul style={{ margin: 0, paddingLeft: 20, color: 'var(--text-primary)', lineHeight: 1.7 }}>{tSafety.map((s, i) => <li key={i}>{s}</li>)}</ul>)}
            {b.references?.length > 0 && section('References', <ul style={{ margin: 0, paddingLeft: 20, color: 'var(--text-primary)', lineHeight: 1.7 }}>{b.references.map((s, i) => <li key={i}>{s}</li>)}</ul>)}
            {b.media?.length > 0 && section('Training media', <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>{b.media.map((m, i) => mediaEmbed(m, i))}</div>)}
            {b.attachments?.length > 0 && section('Attachments & diagrams', (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                {b.attachments.map((a, i) => a.type === 'image' && a.data
                  ? <img key={i} src={a.data} alt={a.name} onClick={() => setLightbox(a.data)} style={{ height: 120, borderRadius: 10, border: '1px solid var(--border-color)', cursor: 'zoom-in' }} />
                  : <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: '0.8rem', color: 'var(--text-secondary)', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 10, padding: '10px 12px' }}><Paperclip size={14} />{a.name}</span>)}
              </div>
            ))}
            </>}

            <div style={{ marginTop: 26, borderTop: '2px solid var(--border-color)', paddingTop: 18 }}>
              <h3 style={{ fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'hsl(var(--color-blue))', margin: '0 0 14px', fontWeight: 700 }}>Discussion <span style={{ fontFamily: 'inherit', color: 'var(--text-muted)' }}>{comments.length}</span></h3>
              {comments.length === 0
                ? <div style={{ fontSize: '0.83rem', color: 'var(--text-muted)', marginBottom: 4 }}>No comments yet. Start the discussion below.</div>
                : comments.map(c => (
                  <div key={c.id} style={{ display: 'flex', gap: 11, padding: '12px 0', borderBottom: '1px solid var(--bg-secondary)' }}>
                    <span style={{ flex: '0 0 auto', width: 32, height: 32, borderRadius: '50%', background: 'var(--bg-secondary)', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: '0.72rem' }}>{initials(c.author_name)}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}><span style={{ fontWeight: 600, fontSize: '0.82rem' }}>{c.author_name}</span><span style={{ marginLeft: 'auto', fontSize: '0.7rem', color: 'var(--text-muted)', fontFamily: 'inherit' }}>{fmtDate(c.created_at)}</span></div>
                      <div style={{ fontSize: '0.85rem', color: 'var(--text-primary)', marginTop: 4, whiteSpace: 'pre-wrap', wordWrap: 'break-word' }}>{c.text}</div>
                    </div>
                  </div>
                ))}
              <div style={{ display: 'flex', gap: 11, marginTop: 14 }}>
                <span style={{ flex: '0 0 auto', width: 32, height: 32, borderRadius: '50%', background: 'var(--text-primary)', color: 'var(--bg-card)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: '0.72rem' }}>{initials(myName)}</span>
                <textarea className="form-input" value={commentText} onChange={e => setCommentText(e.target.value)} placeholder="Add a comment…" style={{ flex: 1, minHeight: 46, resize: 'vertical' }} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}><button className="primary-btn" onClick={postComment} style={{ height: 34, fontSize: '0.82rem' }}>Post comment</button></div>
            </div>
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

            {d.status === 'approved' && (
              <div style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 16, boxShadow: 'var(--shadow-sm)' }}>
                <h3 style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', margin: '0 0 12px' }}>Freshness</h3>
                {d.is_stale
                  ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', fontWeight: 700, color: 'hsl(32,80%,38%)', background: 'hsla(38,92%,50%,0.14)', borderRadius: 999, padding: '4px 10px' }}>Needs review</span>
                  : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', fontWeight: 700, color: 'hsl(145,55%,30%)', background: 'hsla(145,63%,42%,0.14)', borderRadius: 999, padding: '4px 10px' }}><CheckSquare size={13} /> Verified</span>}
                <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: 8 }}>{d.verified_at ? `Last verified ${fmtDate(d.verified_at)}${d.verified_by ? ` by ${d.verified_by}` : ''}.` : 'Not yet verified.'}</div>
                <div style={{ fontSize: '0.78rem', color: d.is_stale ? 'hsl(32,80%,38%)' : 'var(--text-muted)', marginTop: 3 }}>Every {d.review_every_months} mo · next due {fmtDate(d.next_review)}.</div>
                {isManager && <button className={d.is_stale ? 'primary-btn' : 'secondary-btn'} onClick={verifyDoc} style={{ marginTop: 10, width: '100%', height: 32, fontSize: '0.8rem' }}>Mark verified today</button>}
              </div>
            )}

            {(d.require_ack || isManager) && (() => {
              const myAck = ackInfo?.signed?.find(s => s.user_email === myEmail);
              return (
                <div style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 16, boxShadow: 'var(--shadow-sm)' }}>
                  <h3 style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', margin: '0 0 12px' }}>Acknowledgement</h3>
                  {isManager && (
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: '0.8rem', marginBottom: d.require_ack ? 12 : 0 }}>
                      <input type="checkbox" checked={!!d.require_ack} onChange={e => toggleAckRequired(e.target.checked)} style={{ width: 15, height: 15, cursor: 'pointer' }} /> Require sign-off
                    </label>
                  )}
                  {d.require_ack ? (d.status === 'approved' ? (
                    <>
                      {myAck
                        ? <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'hsla(145,63%,42%,0.12)', color: 'hsl(145,55%,30%)', borderRadius: 8, padding: '10px 12px', fontSize: '0.8rem', fontWeight: 500 }}><CheckSquare size={15} /> You acknowledged v{d.version} on {fmtDate(myAck.signed_at)}</div>
                        : <button className="primary-btn" onClick={() => { setSignName(''); setSignOpen(true); }} style={{ width: '100%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}><Edit3 size={14} /> Review &amp; acknowledge</button>}
                      <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: 10 }}>{ackInfo?.count ?? 0} acknowledgement{(ackInfo?.count ?? 0) === 1 ? '' : 's'} · v{d.version}</div>
                      {isManager && ackInfo?.signed?.length > 0 && (
                        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 5 }}>
                          {ackInfo.signed.map((s, i) => (
                            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: '0.78rem' }}>
                              <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'hsl(145,63%,42%)', flex: '0 0 auto' }} />
                              <span style={{ fontWeight: 500 }}>{s.user_name || s.user_email}</span>
                              <span style={{ marginLeft: 'auto', fontSize: '0.72rem', color: 'var(--text-muted)', fontFamily: 'inherit' }}>{fmtDate(s.signed_at)}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  ) : <p style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', margin: '4px 0 0' }}>Sign-off will be requested from staff once this is approved.</p>)
                    : <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: '4px 0 0' }}>No sign-off required for this document.</p>}
                </div>
              );
            })()}
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
              {snapshots.length >= 2 && (
                <button className="secondary-btn" onClick={() => setDiff({ from: snapshots.length - 2, to: snapshots.length - 1 })} style={{ marginTop: 12, width: '100%', height: 34, fontSize: '0.8rem' }}>Compare versions</button>
              )}
            </div>
          </div>
        </div>
        {diff && (() => {
          const snaps = snapshots;
          const A = snaps[Math.min(diff.from, snaps.length - 1)], B = snaps[Math.min(diff.to, snaps.length - 1)];
          const ab = A.body || {}, bb = B.body || {};
          const opt = (sel) => snaps.map((s, i) => <option key={i} value={i}>v{s.version} · {fmtDate(s.date)}{s.author ? ' · ' + s.author : ''}</option>);
          const field = (label, node) => <div style={{ marginBottom: 16 }}><h4 style={{ fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', margin: '0 0 7px' }}>{label}</h4>{node}</div>;
          return (
            <div className="modal-overlay" style={{ display: 'flex' }} onClick={e => { if (e.target === e.currentTarget) setDiff(null); }}>
              <div className="modal-content" style={{ maxWidth: 660 }}>
                <div className="modal-header"><h3>Version history &amp; diff</h3><button className="close-btn" onClick={() => setDiff(null)}><X size={18} /></button></div>
                <div style={{ maxHeight: '66vh', overflow: 'auto', padding: '4px 2px' }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
                    <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>Compare</span>
                    <select className="form-select" value={diff.from} onChange={e => setDiff(p => ({ ...p, from: +e.target.value }))} style={{ height: 36 }}>{opt(diff.from)}</select>
                    <span style={{ color: 'var(--text-muted)' }}>→</span>
                    <select className="form-select" value={diff.to} onChange={e => setDiff(p => ({ ...p, to: +e.target.value }))} style={{ height: 36 }}>{opt(diff.to)}</select>
                  </div>
                  {field('Title', <TextDiff oldS={A.title} newS={B.title} />)}
                  {field('Departments', <ListDiff oldArr={A.departments} newArr={B.departments} />)}
                  {field('Purpose', <TextDiff oldS={ab.purpose} newS={bb.purpose} />)}
                  {field('Scope', <TextDiff oldS={ab.scopeText} newS={bb.scopeText} />)}
                  {field('Materials', <ListDiff oldArr={ab.materials} newArr={bb.materials} />)}
                  {field('Responsibilities', <ListDiff oldArr={ab.responsibilities} newArr={bb.responsibilities} fmt={r => `${r.role}: ${r.duty}`} />)}
                  {field('Procedure', <ListDiff oldArr={ab.procedure} newArr={bb.procedure} fmt={s => s.text + (s.detail ? ` — ${s.detail}` : '') + (s.image ? ' [image]' : '')} />)}
                  {field('Safety', <ListDiff oldArr={ab.safety} newArr={bb.safety} />)}
                  {field('References', <ListDiff oldArr={ab.references} newArr={bb.references} />)}
                </div>
                <div className="modal-footer"><button className="primary-btn" onClick={() => setDiff(null)}>Done</button></div>
              </div>
            </div>
          );
        })()}
        {lightbox && (
          <div onClick={() => setLightbox(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.82)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 30, zIndex: 200, cursor: 'zoom-out' }}>
            <img src={lightbox} alt="" style={{ maxWidth: '100%', maxHeight: '100%', borderRadius: 10 }} />
          </div>
        )}
        {signOpen && (
          <div className="modal-overlay" style={{ display: 'flex' }}>
            <div className="modal-content">
              <div className="modal-header"><h3>Acknowledge &amp; sign off</h3><button className="close-btn" onClick={() => setSignOpen(false)}><X size={18} /></button></div>
              <div style={{ padding: '4px 0' }}>
                <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 10, padding: 14, fontSize: '0.85rem', color: 'var(--text-primary)', lineHeight: 1.6, marginBottom: 14 }}>
                  I, <b>{myName}</b>, confirm that I have read and understood <b>{d.title}</b> ({d.doc_code}, version {d.version}), and I agree to follow it in my role.
                </div>
                <div className="form-group"><label>Type your full name to sign</label><input className="form-input" autoComplete="off" value={signName} placeholder={myName} onChange={e => setSignName(e.target.value)} /></div>
                <p style={{ fontSize: '0.72rem', color: 'var(--text-muted)', margin: '8px 0 0' }}>Signed electronically and recorded with a timestamp against this version.</p>
              </div>
              <div className="modal-footer">
                <button className="secondary-btn" onClick={() => setSignOpen(false)}>Cancel</button>
                <button className="primary-btn" disabled={signName.trim().toLowerCase() !== myName.toLowerCase()} onClick={doSign}>Sign &amp; acknowledge</button>
              </div>
            </div>
          </div>
        )}
        {reviewModal()}
      </div>
    );
  }

  // ════════════════════ EDITOR ════════════════════
  if (mode === 'editor' && draft) {
    const isNew = !draft.id;
    const isManual = draft.doc_type === 'Manual';
    const chapters = draft.body.chapters || [];
    const sopOpts = docs.filter(d => d.doc_type !== 'Manual' && d.id !== draft.id).sort((a, b) => (a.doc_code || '').localeCompare(b.doc_code || ''));
    // editor layout primitives — roomy, card-grouped sections with generous spacing
    const cardStyle = { background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 16, padding: '22px 24px', marginBottom: 18, boxShadow: 'var(--shadow-sm)' };
    const secLabel = { fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', fontWeight: 700, display: 'block', marginBottom: 12 };
    const fieldLabel = { fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-primary)', display: 'block', marginBottom: 7 };
    const bigText = { width: '100%', fontSize: '0.95rem', lineHeight: 1.65, padding: '13px 15px', resize: 'vertical' };
    const section = (title, hint, children) => (
      <div style={cardStyle}>
        <div style={{ marginBottom: 16 }}>
          <h3 style={{ fontSize: '1rem', fontWeight: 700, margin: 0, fontFamily: "'Plus Jakarta Sans', sans-serif", color: 'var(--text-primary)' }}>{title}</h3>
          {hint && <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', margin: '3px 0 0' }}>{hint}</p>}
        </div>
        {children}
      </div>
    );
    const moveBtns = (canUp, canDn, onUp, onDn) => (
      <>
        <button className="secondary-btn" disabled={!canUp} onClick={onUp} style={{ width: 36, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><ChevronUp size={15} /></button>
        <button className="secondary-btn" disabled={!canDn} onClick={onDn} style={{ width: 36, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><ChevronDown size={15} /></button>
      </>
    );
    const chapterBuilder = () => (
      <div className="ed-block" style={{ marginBottom: 16 }}>
        <label style={{ fontSize: '0.85rem', fontWeight: 600, display: 'block', marginBottom: 8 }}>Chapters <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>— each section is inline text or a live link to an existing SOP</span></label>
        {chapters.map((c, ci) => (
          <div key={c._id} style={{ border: '1px solid var(--border-color)', borderRadius: 12, padding: 14, marginBottom: 12, background: 'var(--bg-card)' }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
              <span style={{ width: 26, height: 26, borderRadius: 8, background: 'var(--text-primary)', color: 'var(--bg-card)', fontWeight: 700, fontSize: '0.8rem', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto' }}>{ci + 1}</span>
              <input className="form-input" value={c.title} placeholder="Chapter title" onChange={e => updChapter(c._id, { title: e.target.value })} style={{ flex: 1, fontWeight: 600 }} />
              {moveBtns(ci > 0, ci < chapters.length - 1, () => moveChapter(c._id, 'up'), () => moveChapter(c._id, 'down'))}
              <button className="secondary-btn" onClick={() => delChapter(c._id)} style={{ width: 36, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Trash2 size={15} /></button>
            </div>
            <textarea className="form-input" value={c.intro || ''} placeholder="Chapter intro (optional)…" onChange={e => updChapter(c._id, { intro: e.target.value })} style={{ width: '100%', minHeight: 50, resize: 'vertical', marginBottom: 10, fontSize: '0.85rem' }} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {(c.sections || []).map((s, si) => (
                <div key={s._id} style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 10, padding: 11 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                    <select className="form-select" value={s.kind} onChange={e => updSection(c._id, s._id, { kind: e.target.value })} style={{ width: 140, flex: '0 0 auto' }}>
                      <option value="text">Text section</option>
                      <option value="sop">Linked SOP</option>
                    </select>
                    <input className="form-input" value={s.title} placeholder="Section title" onChange={e => updSection(c._id, s._id, { title: e.target.value })} style={{ flex: 1 }} />
                    {moveBtns(si > 0, si < c.sections.length - 1, () => moveSection(c._id, s._id, 'up'), () => moveSection(c._id, s._id, 'down'))}
                    <button className="secondary-btn" onClick={() => delSection(c._id, s._id)} style={{ width: 36, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Trash2 size={15} /></button>
                  </div>
                  {s.kind === 'sop'
                    ? <select className="form-select" value={s.docId || ''} onChange={e => { const o = sopOpts.find(x => x.id === e.target.value); updSection(c._id, s._id, { docId: e.target.value, title: s.title || (o ? o.title : '') }); }} style={{ width: '100%' }}><option value="">— select an SOP —</option>{sopOpts.map(o => <option key={o.id} value={o.id}>{o.doc_code || '—'} · {o.title}</option>)}</select>
                    : <textarea className="form-input" value={s.body || ''} placeholder="Section text…" onChange={e => updSection(c._id, s._id, { body: e.target.value })} style={{ width: '100%', minHeight: 56, resize: 'vertical', fontSize: '0.85rem' }} />}
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button className="secondary-btn" onClick={() => addSection(c._id, 'text')} style={{ height: 32, fontSize: '0.8rem', display: 'inline-flex', alignItems: 'center', gap: 5 }}><Plus size={13} /> Text section</button>
              <button className="secondary-btn" onClick={() => addSection(c._id, 'sop')} style={{ height: 32, fontSize: '0.8rem', display: 'inline-flex', alignItems: 'center', gap: 5 }}><Plus size={13} /> SOP section</button>
            </div>
          </div>
        ))}
        <button className="secondary-btn" onClick={addChapter} style={{ height: 34, fontSize: '0.82rem', display: 'inline-flex', alignItems: 'center', gap: 6 }}><Plus size={14} /> Add chapter</button>
      </div>
    );
    const listEditor = (field, label, placeholder) => section(label, null, (<>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {draft.body[field].map((v, i) => (
            <div key={i} style={{ display: 'flex', gap: 8 }}>
              <input className="form-input" value={v} placeholder={placeholder} onChange={e => updItem(field, i, e.target.value)} style={{ flex: 1, padding: '11px 14px' }} />
              <button className="secondary-btn" onClick={() => delItem(field, i)} style={{ width: 44, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto' }}><Trash2 size={15} /></button>
            </div>
          ))}
          {draft.body[field].length === 0 && <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', margin: 0 }}>None yet.</p>}
        </div>
        <button className="secondary-btn" onClick={() => addItem(field, '')} style={{ marginTop: 12, height: 36, fontSize: '0.82rem', display: 'inline-flex', alignItems: 'center', gap: 5 }}><Plus size={14} /> Add</button>
      </>));
    const pairEditor = (field, label, k1, k2, p1, p2) => section(label, null, (<>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {draft.body[field].map((row, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 2fr auto', gap: 8 }}>
              <input className="form-input" value={row[k1] || ''} placeholder={p1} onChange={e => updItem(field, i, { ...row, [k1]: e.target.value })} style={{ padding: '11px 14px' }} />
              <input className="form-input" value={row[k2] || ''} placeholder={p2} onChange={e => updItem(field, i, { ...row, [k2]: e.target.value })} style={{ padding: '11px 14px' }} />
              <button className="secondary-btn" onClick={() => delItem(field, i)} style={{ width: 44, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto' }}><Trash2 size={15} /></button>
            </div>
          ))}
          {draft.body[field].length === 0 && <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', margin: 0 }}>None yet.</p>}
        </div>
        <button className="secondary-btn" onClick={() => addItem(field, { [k1]: '', [k2]: '' })} style={{ marginTop: 12, height: 36, fontSize: '0.82rem', display: 'inline-flex', alignItems: 'center', gap: 5 }}><Plus size={14} /> Add</button>
      </>));

    return (
      <div style={{ animation: 'fadeIn var(--transition-normal) ease-in-out', maxWidth: 920, margin: '0 auto' }}>
        <button className="secondary-btn" onClick={backToList} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 18, height: 34 }}>
          <ArrowLeft size={15} /> {isNew ? 'Cancel' : 'Back'}
        </button>
        <h2 style={{ marginBottom: 4, fontSize: '1.7rem' }}>{isNew ? 'New' : 'Edit'} {draft.doc_type}</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: 22 }}>Fill in the sections below, or paste raw notes and let Claude format it into the Greens Global standard.</p>
        {errBanner}

        {draft._importSource && (
          <div style={{ border: '1px solid var(--border-color)', background: 'var(--bg-card)', borderRadius: 12, marginBottom: 18, overflow: 'hidden', boxShadow: 'var(--shadow-sm)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', borderBottom: showCompare ? '1px solid var(--border-color)' : 'none', background: 'var(--bg-secondary)' }}>
              <Sparkles size={16} style={{ color: 'hsl(var(--color-blue))', flex: '0 0 auto' }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <strong style={{ fontSize: '0.88rem' }}>Imported source ↔ proposed SOP</strong>
                <div style={{ fontSize: '0.76rem', color: 'var(--text-secondary)' }}>Check that the AI captured everything, then edit the sections below. Nothing is saved until you submit or publish.</div>
              </div>
              <button className="secondary-btn" disabled={aiBusy} onClick={runAiFormat} style={{ height: 32, fontSize: '0.78rem', display: 'inline-flex', alignItems: 'center', gap: 5, flex: '0 0 auto' }}>{aiBusy ? <Loader size={13} style={{ animation: 'spin 0.7s linear infinite' }} /> : <Sparkles size={13} />} Re-run AI</button>
              <button className="secondary-btn" onClick={() => setShowCompare(v => !v)} style={{ height: 32, fontSize: '0.78rem', flex: '0 0 auto' }}>{showCompare ? 'Hide' : 'Compare'}</button>
            </div>
            {showCompare && (() => {
              const b = draft.body;
              const sec = (label, node) => node ? <div style={{ marginBottom: 12 }}><div style={{ fontSize: '0.64rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', fontWeight: 700, marginBottom: 3 }}>{label}</div>{node}</div> : null;
              const ul = (arr) => arr?.length ? <ul style={{ margin: 0, paddingLeft: 18, fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>{arr.map((x, i) => <li key={i}>{x}</li>)}</ul> : null;
              const txt = (s) => s ? <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{s}</div> : null;
              const proposed = [
                sec('Purpose', txt(b.purpose)),
                sec('Scope', txt(b.scopeText)),
                sec('Materials', ul(b.materials)),
                sec('Responsibilities', b.responsibilities?.length ? ul(b.responsibilities.map(r => `${r.role}: ${r.duty}`)) : null),
                sec('Procedure', b.procedure?.length ? <ol style={{ margin: 0, paddingLeft: 18, fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>{b.procedure.map((s, i) => <li key={i}>{s.text}{s.detail ? <span style={{ color: 'var(--text-muted)' }}> — {s.detail}</span> : null}</li>)}</ol> : null),
                sec('Safety', ul(b.safety)),
                sec('References', ul(b.references)),
              ].filter(Boolean);
              return (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr' }}>
                  <div style={{ borderRight: '1px solid var(--border-color)', padding: 14, minWidth: 0 }}>
                    <div style={{ fontSize: '0.66rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', fontWeight: 700, marginBottom: 8 }}>Imported source</div>
                    <div style={{ maxHeight: 320, overflow: 'auto', fontSize: '0.78rem', color: 'var(--text-secondary)', lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{draft._importSource}</div>
                  </div>
                  <div style={{ padding: 14, minWidth: 0 }}>
                    <div style={{ fontSize: '0.66rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', fontWeight: 700, marginBottom: 8 }}>Proposed (editable below)</div>
                    <div style={{ maxHeight: 320, overflow: 'auto' }}>{proposed.length ? proposed : <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Nothing extracted yet — edit the sections below, or re-run the AI.</div>}</div>
                  </div>
                </div>
              );
            })()}
          </div>
        )}

        {!isManual && !draft._importSource && <>{/* Import / AI-format panel */}
        <div style={{ border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-card)', borderRadius: 12, padding: 16, marginBottom: 18, boxShadow: 'var(--shadow-sm)' }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
            <div style={{ width: 34, height: 34, borderRadius: 9, backgroundColor: 'hsla(215,100%,50%,0.1)', color: 'hsl(var(--color-blue))', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto' }}><Sparkles size={18} /></div>
            <div style={{ flex: 1, minWidth: 180 }}>
              <strong style={{ fontSize: '0.9rem', display: 'block' }}>Start from an existing document</strong>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Paste or upload an existing SOP (or rough notes) and Claude formats every section. Optional — you can also just fill it in below.</span>
            </div>
            <label className="secondary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 38, cursor: 'pointer', margin: 0, flex: '0 0 auto' }}>
              <Paperclip size={15} /> Upload file
              <input type="file" accept=".txt,.md,.markdown,.csv,.json,.html,.htm,.rtf,.log" onChange={e => { importFile(e.target.files[0]); e.target.value = ''; }} style={{ display: 'none' }} />
            </label>
            <button className="primary-btn" disabled={aiBusy} onClick={runAiFormat} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 38, flex: '0 0 auto' }}>
              {aiBusy ? <Loader size={15} style={{ animation: 'spin 0.7s linear infinite' }} /> : <Sparkles size={15} />} {aiBusy ? 'Formatting…' : 'Format with Claude'}
            </button>
          </div>
          <textarea className="form-input" value={draft._raw} placeholder="Paste existing SOP text or bullet notes here, or upload a file above…" onChange={e => setDraft(p => ({ ...p, _raw: e.target.value }))} style={{ width: '100%', minHeight: 90, resize: 'vertical' }} />
        </div></>}

        {/* Prominent title field */}
        <div style={cardStyle}>
          <label style={fieldLabel}>Document title</label>
          <input className="form-input" value={draft.title} placeholder="e.g. Unit Move-In Procedure" onChange={e => setDraft(p => ({ ...p, title: e.target.value }))} style={{ fontSize: '1.35rem', fontWeight: 600, padding: '14px 16px', height: 'auto', fontFamily: "'Plus Jakarta Sans', sans-serif" }} />
        </div>

        {section('Document details', null, (<>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 18 }}>
            <div className="form-group"><label>Type</label><select className="form-select" value={draft.doc_type} onChange={e => setDraft(p => ({ ...p, doc_type: e.target.value }))} style={{ padding: '11px 36px 11px 14px' }}>{DOC_TYPES.map(t => <option key={t}>{t}</option>)}</select></div>
            <div className="form-group"><label>Version</label><input className="form-input" value={draft.version} onChange={e => setDraft(p => ({ ...p, version: e.target.value }))} style={{ padding: '11px 14px' }} /></div>
            <div className="form-group"><label>Effective date</label><input type="date" className="form-input" value={draft.effective_date} onChange={e => setDraft(p => ({ ...p, effective_date: e.target.value }))} style={{ padding: '11px 14px' }} /></div>
            <div className="form-group"><label>Reviewing manager email</label><input className="form-input" value={draft.reviewer_email} placeholder="manager@greensglobal.com" onChange={e => setDraft(p => ({ ...p, reviewer_email: e.target.value }))} style={{ padding: '11px 14px' }} /></div>
            <div className="form-group"><label>Reviewer name <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional)</span></label><input className="form-input" value={draft.reviewer_name} onChange={e => setDraft(p => ({ ...p, reviewer_name: e.target.value }))} style={{ padding: '11px 14px' }} /></div>
            <div className="form-group"><label>Review cadence (months)</label><input className="form-input" value={draft.review_every_months} onChange={e => setDraft(p => ({ ...p, review_every_months: e.target.value }))} style={{ padding: '11px 14px' }} /></div>
            <div className="form-group"><label>Retention (months)</label><input className="form-input" value={draft.retention_months} onChange={e => setDraft(p => ({ ...p, retention_months: e.target.value }))} style={{ padding: '11px 14px' }} /></div>
          </div>
          <div style={{ marginTop: 20 }}>
            <label style={fieldLabel}>Applies to departments</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {DEPARTMENTS.map(dep => {
                const on = draft.departments.includes(dep);
                return <button key={dep} onClick={() => toggleDept(dep)} style={{ fontSize: '0.82rem', padding: '8px 14px', borderRadius: 999, border: '1px solid', borderColor: on ? 'var(--text-primary)' : 'var(--border-color)', backgroundColor: on ? 'var(--text-primary)' : 'var(--bg-card)', color: on ? 'var(--bg-card)' : 'var(--text-secondary)', fontWeight: 500, cursor: 'pointer' }}>{dep}</button>;
              })}
            </div>
          </div>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 10, marginTop: 18, cursor: 'pointer', fontSize: '0.85rem' }}>
            <input type="checkbox" checked={!!draft.require_ack} onChange={e => setDraft(p => ({ ...p, require_ack: e.target.checked }))} style={{ width: 17, height: 17, cursor: 'pointer' }} />
            Require acknowledgement (e-signature sign-off) from staff once approved
          </label>
        </>))}

        {section('Overview', 'Set the context for this document.', (<>
          <div style={{ marginBottom: 18 }}>
            <label style={fieldLabel}>Purpose</label>
            <textarea className="form-input" value={draft.body.purpose} placeholder="Why this document exists…" onChange={e => setBody({ purpose: e.target.value })} style={{ ...bigText, minHeight: 120 }} />
          </div>
          <div>
            <label style={fieldLabel}>Scope</label>
            <textarea className="form-input" value={draft.body.scopeText} placeholder="Who and what this applies to…" onChange={e => setBody({ scopeText: e.target.value })} style={{ ...bigText, minHeight: 120 }} />
          </div>
        </>))}

        {isManual ? chapterBuilder() : (<>
        {listEditor('materials', 'Materials & required items', 'e.g. Master key set')}
        {pairEditor('responsibilities', 'Responsibilities', 'role', 'duty', 'Role', 'Responsibility')}
        {pairEditor('definitions', 'Definitions', 'term', 'def', 'Term', 'Definition')}

        {/* procedure */}
        {section('Procedure', 'List the steps in order. Add a note or a picture to any step.', (<>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {draft.body.procedure.map((s, i) => (
              <div key={i} style={{ border: '1px solid var(--border-color)', borderRadius: 12, padding: 14, backgroundColor: 'var(--bg-secondary)' }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                  <span style={{ width: 30, height: 30, borderRadius: 9, backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', color: 'hsl(var(--color-blue))', fontWeight: 700, fontSize: '0.85rem', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto', marginTop: 2 }}>{i + 1}</span>
                  <textarea className="form-input" value={s.text} placeholder={`Step ${i + 1} — what to do…`} onChange={e => updItem('procedure', i, { ...s, text: e.target.value })} style={{ flex: 1, minHeight: 46, resize: 'vertical', fontSize: '0.92rem', lineHeight: 1.55, padding: '11px 14px' }} />
                  <button className="secondary-btn" title="Attach picture" onClick={() => pickFiles(false, ([a]) => { if (a?.type === 'image') updItem('procedure', i, { ...s, image: a.data }); })} style={{ width: 42, height: 42, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto' }}><ImageIcon size={16} /></button>
                  <button className="secondary-btn" onClick={() => delItem('procedure', i)} style={{ width: 42, height: 42, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto' }}><Trash2 size={16} /></button>
                </div>
                <textarea className="form-input" value={s.detail || ''} placeholder="Optional detail / note for this step…" onChange={e => updItem('procedure', i, { ...s, detail: e.target.value })} style={{ marginTop: 10, marginLeft: 40, width: 'calc(100% - 40px)', minHeight: 46, resize: 'vertical', fontSize: '0.88rem', lineHeight: 1.55, padding: '10px 14px' }} />
                {s.image && <div style={{ marginTop: 10, marginLeft: 40, display: 'flex', alignItems: 'center', gap: 10 }}><img src={s.image} alt="step" style={{ height: 60, borderRadius: 8, border: '1px solid var(--border-color)' }} /><button className="secondary-btn" onClick={() => updItem('procedure', i, { ...s, image: '' })} style={{ height: 32, fontSize: '0.8rem' }}>Remove picture</button></div>}
              </div>
            ))}
            {draft.body.procedure.length === 0 && <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', margin: 0 }}>No steps yet.</p>}
          </div>
          <button className="secondary-btn" onClick={() => addItem('procedure', { text: '', detail: '' })} style={{ marginTop: 12, height: 36, fontSize: '0.82rem', display: 'inline-flex', alignItems: 'center', gap: 5 }}><Plus size={14} /> Add step</button>
        </>))}

        {listEditor('safety', 'Safety & compliance', 'e.g. Never enter a unit alone if…')}
        {listEditor('references', 'References', 'e.g. OPS-021 Access Control')}

        {section('Attachments & diagrams', null, (<>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {(draft.body.attachments || []).map((a, i) => (
              <div key={i} style={{ position: 'relative', border: '1px solid var(--border-color)', borderRadius: 10, overflow: 'hidden', width: 122, background: 'var(--bg-card)' }}>
                {a.type === 'image' && a.data
                  ? <img src={a.data} alt={a.name} style={{ width: 122, height: 80, objectFit: 'cover', display: 'block' }} />
                  : <div style={{ height: 80, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}><Paperclip size={18} /></div>}
                <div style={{ padding: '6px 8px', fontSize: '0.7rem', borderTop: '1px solid var(--border-color)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.name}</div>
                <button onClick={() => setBody({ attachments: (draft.body.attachments || []).filter((_, j) => j !== i) })} style={{ position: 'absolute', top: 5, right: 5, width: 22, height: 22, borderRadius: 6, background: 'rgba(0,0,0,.55)', color: '#fff', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><X size={12} /></button>
              </div>
            ))}
          </div>
          <button className="secondary-btn" onClick={() => pickFiles(true, assets => setBody({ attachments: [...(draft.body.attachments || []), ...assets] }))} style={{ marginTop: 12, height: 36, fontSize: '0.82rem', display: 'inline-flex', alignItems: 'center', gap: 5 }}><Plus size={14} /> Add files / pictures</button>
        </>))}
        </>)}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap', paddingTop: 8, borderTop: '1px solid var(--border-color)', marginTop: 8 }}>
          <button className="secondary-btn" onClick={backToList}>Cancel</button>
          <button className="secondary-btn" disabled={busy} onClick={() => save(false)}>Save draft</button>
          <button className="secondary-btn" disabled={busy} onClick={() => save(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Send size={14} /> Save &amp; submit for review</button>
          {isManager && <button className="primary-btn" disabled={busy} onClick={saveAndPublish} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><CheckSquare size={14} /> Save &amp; publish</button>}
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

  const deptChips = (d) => {
    const ds = d.departments || [];
    if (!ds.length) return <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Unassigned</span>;
    return (
      <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
        {ds.slice(0, 3).map(x => <span key={x} style={{ fontSize: '0.66rem', fontWeight: 600, color: 'var(--text-secondary)', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 999, padding: '1px 7px' }}>{DEPT_ABBR[x] || x}</span>)}
        {ds.length > 3 && <span style={{ fontSize: '0.66rem', color: 'var(--text-muted)' }}>+{ds.length - 3}</span>}
      </span>
    );
  };

  const statsRow = () => {
    const tiles = [
      ['Documents', docs.length, 'var(--text-primary)'],
      ['Drafts', docs.filter(d => d.status === 'draft' || d.status === 'changes_requested').length, 'var(--text-secondary)'],
      ['In Review', docs.filter(d => d.status === 'in_review').length, 'hsl(32,80%,40%)'],
      ['Approved', docs.filter(d => d.status === 'approved').length, 'hsl(145,55%,32%)'],
    ];
    return (
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
        {tiles.map(([l, v, c]) => (
          <div key={l} style={{ display: 'flex', alignItems: 'baseline', gap: 7, background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 9, padding: '7px 13px' }}>
            <span style={{ fontSize: '1.05rem', fontWeight: 700, fontFamily: 'inherit', lineHeight: 1, color: c }}>{v}</span>
            <span style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)' }}>{l}</span>
          </div>
        ))}
      </div>
    );
  };

  const recentStrip = () => {
    const recent = docs.slice().sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || '')).slice(0, 5);
    if (!recent.length) return null;
    return (
      <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 14, padding: '14px 14px 16px', marginBottom: 22 }}>
        <div style={{ fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-secondary)', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 7, padding: '0 2px 12px' }}><Clock size={13} /> Recently updated</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(208px, 1fr))', gap: 10 }}>
          {recent.map(d => (
            <button key={d.id} onClick={() => openDetail(d)} style={{ textAlign: 'left', cursor: 'pointer', background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 11, padding: '12px 13px', boxShadow: 'var(--shadow-sm)', display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}><Badge status={d.status} /><span style={{ fontSize: '0.68rem', color: 'var(--text-muted)', fontFamily: 'inherit' }}>{fmtDate(d.updated_at)}</span></div>
              <div style={{ fontWeight: 600, fontSize: '0.85rem', lineHeight: 1.3, color: 'var(--text-primary)' }}>{d.title}</div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', fontFamily: 'inherit' }}>{d.doc_code || '—'} · v{d.version}</div>
            </button>
          ))}
        </div>
      </div>
    );
  };

  // Employee-facing strip on the Playbook: what each person needs to act on
  const myTasksStrip = () => {
    const pending = (signoffs || []).filter(s => !s.my_signed);
    return (
      <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 14, padding: '14px 14px 16px', marginBottom: 22 }}>
        <div style={{ fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-secondary)', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 7, padding: '0 2px 12px' }}>
          <CheckSquare size={13} /> For you
          {pending.length > 0 && <span style={{ background: 'hsla(38,92%,50%,0.16)', color: 'hsl(32,80%,38%)', borderRadius: 999, padding: '1px 8px', fontSize: '0.7rem' }}>{pending.length}</span>}
        </div>
        {pending.length === 0
          ? <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.84rem', color: 'var(--text-secondary)', padding: '0 2px 2px' }}><CheckSquare size={15} style={{ color: 'hsl(145,55%,40%)' }} /> You're all caught up — nothing is waiting on your sign-off.</div>
          : <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 10 }}>
              {pending.map(s => (
                <button key={s.id} onClick={() => openSourceById(s.id)} style={{ textAlign: 'left', cursor: 'pointer', background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 11, padding: '12px 13px', boxShadow: 'var(--shadow-sm)', display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span style={{ alignSelf: 'flex-start', fontSize: '0.66rem', fontWeight: 700, color: 'hsl(32,80%,38%)', background: 'hsla(38,92%,50%,0.14)', borderRadius: 999, padding: '2px 9px' }}>Sign-off required</span>
                  <div style={{ fontWeight: 600, fontSize: '0.85rem', lineHeight: 1.3, color: 'var(--text-primary)' }}>{s.title}</div>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{s.doc_code || '—'} · v{s.version}</div>
                  <span style={{ fontSize: '0.78rem', fontWeight: 600, color: 'hsl(var(--color-blue))' }}>Review &amp; sign →</span>
                </button>
              ))}
            </div>}
      </div>
    );
  };

  const cardGrid = (list, emptyMsg) => (
    list.length === 0
      ? <div style={{ textAlign: 'center', padding: 40, border: '1px dashed var(--border-color)', borderRadius: 8, color: 'var(--text-secondary)' }}>{emptyMsg}</div>
      : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 14 }}>
          {list.map(d => {
            const b = d.body || {};
            return (
              <button key={d.id} onClick={() => openDetail(d)} style={{ textAlign: 'left', cursor: 'pointer', background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 14, padding: 16, boxShadow: 'var(--shadow-sm)', display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
                  <div>
                    <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', fontFamily: 'inherit' }}>{d.doc_code || '—'}</div>
                    <div style={{ fontWeight: 600, fontSize: '0.95rem', lineHeight: 1.3, color: 'var(--text-primary)', marginTop: 2 }}>{d.title}</div>
                  </div>
                  <Badge status={d.status} />
                </div>
                {b.purpose && <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: 1.5, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{b.purpose}</div>}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 'auto', paddingTop: 8, borderTop: '1px solid var(--bg-secondary)' }}>
                  <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>{d.doc_type} · v{d.version}</span>
                  {deptChips(d)}
                </div>
              </button>
            );
          })}
        </div>
      )
  );

  const outlineView = (list, emptyMsg) => {
    if (!list.length) return <div style={{ textAlign: 'center', padding: 40, border: '1px dashed var(--border-color)', borderRadius: 8, color: 'var(--text-secondary)' }}>{emptyMsg}</div>;
    const groups = [];
    DEPARTMENTS.forEach(dep => { const ds = list.filter(d => (d.departments || []).includes(dep)); if (ds.length) groups.push([dep, ds]); });
    const unassigned = list.filter(d => !(d.departments || []).length);
    if (unassigned.length) groups.push(['Unassigned', unassigned]);
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {groups.map(([dep, ds]) => (
          <div key={dep} style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, boxShadow: 'var(--shadow-sm)', overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 15px', fontSize: '0.9rem', fontWeight: 600, color: 'var(--text-primary)', borderBottom: '1px solid var(--border-color)' }}>
              <BookOpen size={15} style={{ color: 'var(--text-secondary)' }} /> {dep}
              <span style={{ marginLeft: 'auto', fontSize: '0.7rem', background: 'var(--bg-secondary)', color: 'var(--text-secondary)', borderRadius: 999, padding: '2px 9px', fontWeight: 600 }}>{ds.length}</span>
            </div>
            {ds.map(d => (
              <button key={d.id} onClick={() => openDetail(d)} style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left', padding: '11px 15px', background: 'transparent', border: 'none', borderTop: '1px solid var(--bg-secondary)', cursor: 'pointer' }}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontWeight: 600, fontSize: '0.85rem', color: 'var(--text-primary)' }}>{d.title}</span>
                  <span style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-muted)', fontFamily: 'inherit' }}>{d.doc_code || '—'} · {d.doc_type} · v{d.version} · {d.owner_name || ''}</span>
                </span>
                <Badge status={d.status} />
              </button>
            ))}
          </div>
        ))}
      </div>
    );
  };

  const askAnswer = () => (
    <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 14, padding: 14, marginBottom: 18 }}>
      {ask.loading && <div style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', display: 'inline-flex', alignItems: 'center', gap: 8 }}><Loader size={15} style={{ animation: 'spin 0.7s linear infinite' }} /> Searching your SOPs…</div>}
      {!ask.loading && ask.answer != null && (
        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 11, padding: 14 }}>
          <div style={{ fontSize: '0.88rem', lineHeight: 1.6, color: 'var(--text-primary)', whiteSpace: 'pre-wrap' }}>{ask.answer}</div>
          {ask.sources?.length > 0 ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', marginTop: 12, fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              Sources:
              {ask.sources.map(s => <button key={s.id} onClick={() => openSourceById(s.id)} style={{ fontSize: '0.72rem', background: 'var(--bg-secondary)', color: 'hsl(var(--color-blue))', border: '1px solid var(--border-color)', borderRadius: 999, padding: '3px 10px', cursor: 'pointer', fontWeight: 600 }}>{s.doc_code || s.title}</button>)}
            </div>
          ) : <div style={{ marginTop: 12, fontSize: '0.75rem', color: 'hsl(32, 80%, 38%)' }}>No matching SOP found — worth adding one.</div>}
        </div>
      )}
      {!ask.loading && ask.answer == null && <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>Ask a question in the box above — answers are grounded only in your SOPs and cite their source.</div>}
    </div>
  );

  const manageCard = (Icon, title, desc, cta, onClick) => (
    <button onClick={onClick} style={{ textAlign: 'left', cursor: 'pointer', background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 14, padding: 16, display: 'flex', flexDirection: 'column', gap: 8, boxShadow: 'var(--shadow-sm)' }}>
      <div style={{ width: 36, height: 36, borderRadius: 10, background: 'var(--bg-secondary)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-primary)' }}><Icon size={18} /></div>
      <div style={{ fontWeight: 600, fontSize: '0.95rem', color: 'var(--text-primary)' }}>{title}</div>
      <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>{desc}</div>
      <span style={{ marginTop: 2, fontSize: '0.82rem', fontWeight: 600, color: 'hsl(var(--color-blue))' }}>{cta} →</span>
    </button>
  );

  const actionTile = (label, count, hint, Icon, onClick, urgent) => (
    <button onClick={onClick} style={{ textAlign: 'left', cursor: 'pointer', background: 'var(--bg-card)', border: '1px solid', borderColor: urgent ? 'hsla(38,92%,50%,0.55)' : 'var(--border-color)', borderRadius: 14, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 6, boxShadow: 'var(--shadow-sm)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ width: 32, height: 32, borderRadius: 9, background: urgent ? 'hsla(38,92%,50%,0.16)' : 'var(--bg-secondary)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: urgent ? 'hsl(32,80%,38%)' : 'var(--text-primary)' }}><Icon size={16} /></span>
        <span style={{ fontSize: '1.7rem', fontWeight: 700, lineHeight: 1, color: urgent ? 'hsl(32,80%,38%)' : 'var(--text-primary)' }}>{count}</span>
      </div>
      <div style={{ fontWeight: 600, fontSize: '0.9rem', color: 'var(--text-primary)' }}>{label}</div>
      <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)' }}>{hint}</div>
    </button>
  );

  const viewToggle = () => (
    <div style={{ display: 'inline-flex', gap: 6 }}>
      {[['list', 'List'], ['cards', 'Cards'], ['outline', 'By department']].map(([k, l]) => (
        <button key={k} onClick={() => setLibView(k)} style={{ padding: '7px 13px', borderRadius: 999, fontSize: '0.78rem', fontWeight: 500, cursor: 'pointer', border: '1px solid', borderColor: libView === k ? 'var(--text-primary)' : 'var(--border-color)', background: libView === k ? 'var(--text-primary)' : 'var(--bg-card)', color: libView === k ? 'var(--bg-card)' : 'var(--text-secondary)' }}>{l}</button>
      ))}
    </div>
  );

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
                <td style={{ padding: '11px 14px' }}><div style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '0.9rem' }}>{d.title}</div><div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontFamily: 'inherit' }}>{d.doc_code || '—'} · v{d.version}</div></td>
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
        {isManager && (
          <button onClick={() => switchTab('manage')} style={{ marginLeft: 'auto', alignSelf: 'center', display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: 9, border: '1px solid', borderColor: ['manage', 'matrix', 'insights'].includes(sub) ? 'var(--text-primary)' : 'var(--border-color)', background: ['manage', 'matrix', 'insights'].includes(sub) ? 'var(--text-primary)' : 'var(--bg-card)', color: ['manage', 'matrix', 'insights'].includes(sub) ? 'var(--bg-card)' : 'var(--text-secondary)', fontSize: '0.85rem', fontWeight: 600, cursor: 'pointer' }}><Settings size={15} /> Manage</button>
        )}
      </div>
      {errBanner}

      {/* SOP Index */}
      {sub === 'index' && (
        <>
          <div className="view-header" style={{ marginBottom: 20 }}>
            <div className="view-title-group"><h2>Playbook</h2><p>Your SOPs, manuals, and guides — all in one place</p></div>
            <button className="primary-btn" onClick={openCreate} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Plus size={16} /> New SOP</button>
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 16, background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 10, boxShadow: 'var(--shadow-sm)' }}>
            <div style={{ display: 'inline-flex', background: 'var(--bg-secondary)', borderRadius: 9, padding: 3, flex: '0 0 auto' }}>
              {[['search', 'Search', Search], ['ask', 'Ask AI', Sparkles]].map(([m, label, Icon]) => (
                <button key={m} onClick={() => setSearchMode(m)} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 12px', borderRadius: 7, border: 'none', cursor: 'pointer', fontSize: '0.82rem', fontWeight: 600, background: searchMode === m ? 'var(--bg-card)' : 'transparent', color: searchMode === m ? (m === 'ask' ? 'hsl(266,72%,56%)' : 'var(--text-primary)') : (m === 'ask' ? 'hsl(266,40%,55%)' : 'var(--text-secondary)'), boxShadow: searchMode === m ? 'var(--shadow-sm)' : 'none' }}><Icon size={14} /> {label}</button>
              ))}
            </div>
            <div style={{ position: 'relative', flex: '1 1 240px', minWidth: 200 }}>
              <Search size={16} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
              {searchMode === 'search'
                ? <input type="text" className="form-input" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search title, ID, or document text…" style={{ paddingLeft: 36, width: '100%', height: 38, fontSize: '0.88rem' }} />
                : <input type="text" className="form-input" value={ask.q} onChange={e => setAsk(a => ({ ...a, q: e.target.value }))} onKeyDown={e => { if (e.key === 'Enter') doAsk(); }} placeholder="Ask the knowledge base… e.g. When do we run the gate audit?" style={{ paddingLeft: 36, width: '100%', height: 38, fontSize: '0.88rem' }} />}
            </div>
            {searchMode === 'search' ? (<>
              <select className="form-select" value={deptFilter} onChange={e => setDeptFilter(e.target.value)} style={{ height: 38, fontSize: '0.85rem', width: 'auto' }}><option value="all">All departments</option>{DEPARTMENTS.map(d => <option key={d}>{d}</option>)}</select>
              <select className="form-select" value={typeFilter} onChange={e => setTypeFilter(e.target.value)} style={{ height: 38, fontSize: '0.85rem', width: 'auto' }}><option value="all">All types</option>{DOC_TYPES.map(t => <option key={t}>{t}</option>)}</select>
              <select className="form-select" value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={{ height: 38, fontSize: '0.85rem', width: 'auto' }}><option value="all">All statuses</option>{Object.entries(STATUS_META).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
            </>) : (
              <button className="primary-btn" disabled={ask.loading} onClick={doAsk} style={{ height: 38, display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.85rem', background: 'linear-gradient(135deg, hsl(258,82%,62%), hsl(288,70%,58%))', border: 'none', color: '#fff' }}>{ask.loading ? <Loader size={15} style={{ animation: 'spin 0.7s linear infinite' }} /> : <Sparkles size={15} />} {ask.loading ? 'Asking…' : 'Ask'}</button>
            )}
          </div>

          {searchMode === 'ask' && askAnswer()}
          {searchMode === 'search' && myTasksStrip()}

          {searchMode === 'search' && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
              <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>{filtered.length} document{filtered.length === 1 ? '' : 's'}</div>
              {viewToggle()}
            </div>
          )}

          {loading
            ? <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-secondary)' }}><Loader size={20} style={{ animation: 'spin 0.7s linear infinite' }} /> Loading…</div>
            : (() => {
                const empty = docs.length === 0 ? 'No documents yet — click “New SOP” to start your first draft.' : 'No documents match your filters.';
                if (libView === 'cards') return cardGrid(filtered, empty);
                if (libView === 'outline') return outlineView(filtered, empty);
                return docTable(filtered, empty);
              })()}
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

      {/* Sign-offs */}
      {sub === 'signoffs' && (() => {
        const openDoc = (id) => { const dd = docs.find(x => x.id === id); if (dd) openDetail(dd); };
        const mine = signoffs.filter(s => !s.my_signed);
        const groupHead = (txt, n) => <div style={{ fontSize: '0.85rem', fontWeight: 700, margin: '20px 2px 10px', display: 'flex', alignItems: 'center', gap: 8 }}>{txt}{n != null && <span style={{ fontSize: '0.72rem', background: 'var(--bg-secondary)', color: 'var(--text-secondary)', borderRadius: 999, padding: '2px 9px', fontWeight: 600 }}>{n}</span>}</div>;
        const note = (txt) => <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 8, padding: '12px 14px', fontSize: '0.83rem', color: 'var(--text-secondary)' }}>{txt}</div>;
        const table = (rows, mode2) => (
          <div style={{ border: '1px solid var(--border-color)', borderRadius: 12, overflow: 'hidden', background: 'var(--bg-card)', boxShadow: 'var(--shadow-sm)' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <tbody>{rows.map(s => (
                <tr key={s.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                  <td style={{ padding: '11px 14px', cursor: 'pointer' }} onClick={() => openDoc(s.id)}><div style={{ fontWeight: 600, fontSize: '0.9rem', color: 'var(--text-primary)' }}>{s.title}</div><div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontFamily: 'inherit' }}>{s.doc_code} · v{s.version}</div></td>
                  <td style={{ padding: '11px 14px', fontSize: '0.78rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{mode2 === 'all' ? `${s.signed_count} signed` : ''}</td>
                  <td style={{ padding: '11px 14px', textAlign: 'right' }}>
                    {s.my_signed
                      ? <span style={{ fontSize: '0.72rem', fontWeight: 700, color: 'hsl(145,55%,30%)', background: 'hsla(145,63%,42%,0.12)', borderRadius: 999, padding: '3px 10px' }}>You signed</span>
                      : <button className="primary-btn" onClick={() => openDoc(s.id)} style={{ height: 32, fontSize: '0.8rem' }}>Review &amp; sign</button>}
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        );
        return (
          <>
            <div className="view-header" style={{ marginBottom: 12 }}><div className="view-title-group"><h2>Sign-offs</h2><p>Policies and SOPs that require an e-signature acknowledgement</p></div></div>
            {groupHead('Your sign-offs', mine.length || null)}
            {mine.length ? table(mine, 'mine') : note("You're all caught up — no acknowledgements outstanding.")}
            {isManager && (<>
              {groupHead('All policies requiring sign-off', signoffs.length || null)}
              {signoffs.length ? table(signoffs, 'all') : note('No approved policies currently require sign-off.')}
            </>)}
          </>
        );
      })()}

      {/* Manage hub (managers) — dashboard */}
      {sub === 'manage' && isManager && (() => {
        const staleCount = docs.filter(d => d.is_stale).length;
        const signoffCount = docs.filter(d => d.require_ack && d.status === 'approved').length;
        const draftCount = docs.filter(d => d.status === 'draft' || d.status === 'changes_requested').length;
        const sectionHead = (txt) => <h3 style={{ fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', fontWeight: 700, margin: '26px 2px 12px' }}>{txt}</h3>;
        const ACT = {
          created:   { Icon: Plus,        color: 'hsl(var(--color-blue))' },
          submitted: { Icon: Send,        color: 'hsl(var(--color-blue))' },
          approved:  { Icon: CheckSquare, color: 'hsl(145,55%,38%)' },
          changes:   { Icon: Edit3,       color: 'hsl(32,80%,42%)' },
          archived:  { Icon: Archive,     color: 'var(--text-muted)' },
          verified:  { Icon: CheckSquare, color: 'hsl(145,55%,38%)' },
          edited:    { Icon: Edit3,       color: 'var(--text-secondary)' },
          update:    { Icon: Clock,       color: 'var(--text-secondary)' },
        };
        return (
        <>
          <div className="view-header" style={{ marginBottom: 18 }}>
            <div className="view-title-group"><h2>Manage</h2><p>Your knowledge-base control center — review, assign, and keep content fresh</p></div>
            <button className="primary-btn" onClick={openCreate} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Plus size={16} /> New SOP</button>
          </div>

          {statsRow()}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(178px, 1fr))', gap: 12 }}>
            {actionTile('Pending review', reviewQueue.length, 'Awaiting your approval', Send, () => switchTab('review'), reviewQueue.length > 0)}
            {actionTile('Needs review', staleCount, 'Past their review date', Clock, () => switchTab('insights'), staleCount > 0)}
            {actionTile('Sign-offs', signoffCount, 'Policies requiring acknowledgement', CheckSquare, () => switchTab('signoffs'), false)}
            {actionTile('Drafts in progress', draftCount, 'Not yet submitted for review', Edit3, () => { setStatusFilter('draft'); switchTab('index'); }, false)}
          </div>

          <div style={{ marginTop: 22 }}>{recentStrip()}</div>

          {sectionHead('Quick actions')}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: 14 }}>
            {manageCard(BookOpen, 'New manual', 'Build a chaptered manual that links existing SOPs into one reference.', 'Create manual', openCreateManual)}
            {manageCard(Grid3x3, 'Assignment Matrix', 'Set which departments each document applies to, in one grid.', 'Open matrix', () => switchTab('matrix'))}
            {manageCard(BarChart3, 'Insights', 'Usage, freshness, content gaps, and training completion across the library.', 'Open insights', () => switchTab('insights'))}
            {manageCard(GraduationCap, 'Training courses', 'Author, edit, and publish Learn courses and quizzes.', 'Manage courses', openCourseManager)}
          </div>

          {sectionHead('Activity log')}
          <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, boxShadow: 'var(--shadow-sm)', overflow: 'hidden' }}>
            {activity === null
              ? <div style={{ textAlign: 'center', padding: 28, color: 'var(--text-secondary)' }}><Loader size={18} style={{ animation: 'spin 0.7s linear infinite' }} /></div>
              : activity.length === 0
                ? <div style={{ textAlign: 'center', padding: 28, color: 'var(--text-muted)', fontSize: '0.85rem' }}>No activity yet.</div>
                : <div style={{ maxHeight: 460, overflow: 'auto' }}>
                    {activity.map((e, i) => {
                      const a = ACT[e.kind] || ACT.update;
                      return (
                        <button key={i} onClick={() => openActivity(e)} title={e.diffable ? 'Open document and show what changed' : 'Open document'} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', width: '100%', textAlign: 'left', padding: '11px 14px', background: 'transparent', border: 'none', borderTop: i ? '1px solid var(--bg-secondary)' : 'none', cursor: 'pointer' }}
                          onMouseEnter={ev => ev.currentTarget.style.background = 'var(--bg-secondary)'} onMouseLeave={ev => ev.currentTarget.style.background = 'transparent'}>
                          <span style={{ marginTop: 1, width: 30, height: 30, borderRadius: 8, flex: '0 0 auto', background: 'var(--bg-secondary)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: a.color }}><a.Icon size={15} /></span>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: '0.86rem', color: 'var(--text-primary)' }}><span style={{ fontWeight: 600 }}>{e.title}</span> <span style={{ color: 'var(--text-muted)', fontSize: '0.76rem' }}>{e.doc_code}{e.version ? ' · v' + e.version : ''}</span></div>
                            <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.notes || 'Updated.'}</div>
                          </div>
                          <div style={{ flex: '0 0 auto', textAlign: 'right' }}>
                            <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{fmtDate(e.date)}</div>
                            {e.author && <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{e.author}</div>}
                            {e.diffable && <div style={{ fontSize: '0.72rem', fontWeight: 600, color: 'hsl(var(--color-blue))', whiteSpace: 'nowrap' }}>View change →</div>}
                          </div>
                        </button>
                      );
                    })}
                  </div>}
          </div>
        </>
        );
      })()}

      {/* Assignment Matrix (managers) */}
      {sub === 'matrix' && isManager && (() => {
        const rows = docs.slice().sort((a, b) => (a.doc_code || '').localeCompare(b.doc_code || ''));
        return (
          <>
            <button className="secondary-btn" onClick={() => switchTab('manage')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 14, height: 32, fontSize: '0.82rem' }}><ArrowLeft size={14} /> Manage</button>
            <div className="view-header" style={{ marginBottom: 16 }}><div className="view-title-group"><h2>Assignment Matrix</h2><p>Tap a cell to assign or unassign a department. “All” applies or clears every department for that document.</p></div></div>
            <div style={{ overflowX: 'auto', border: '1px solid var(--border-color)', borderRadius: 12, background: 'var(--bg-card)' }}>
              <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 700 }}>
                <thead><tr>
                  <th style={{ position: 'sticky', left: 0, background: 'var(--bg-secondary)', textAlign: 'left', padding: '10px 14px', fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)', fontWeight: 700, minWidth: 220, zIndex: 1 }}>Document</th>
                  <th style={{ background: 'var(--bg-secondary)', padding: '10px 6px', fontSize: '0.62rem', color: 'var(--text-muted)', fontWeight: 700 }}>ALL</th>
                  {DEPARTMENTS.map(dep => <th key={dep} title={dep} style={{ background: 'var(--bg-secondary)', padding: '10px 6px', fontSize: '0.62rem', color: 'var(--text-muted)', fontWeight: 700 }}>{DEPT_ABBR[dep]}</th>)}
                </tr></thead>
                <tbody>{rows.map(d => { const isAll = DEPARTMENTS.length === (d.departments || []).length; return (
                  <tr key={d.id} style={{ borderTop: '1px solid var(--border-color)' }}>
                    <td style={{ position: 'sticky', left: 0, background: 'var(--bg-card)', padding: '10px 14px', minWidth: 220 }}><div style={{ fontWeight: 600, fontSize: '0.83rem' }}>{d.title}</div><div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', fontFamily: 'inherit' }}>{d.doc_code} · {d.doc_type}</div></td>
                    <td style={{ textAlign: 'center', padding: '6px' }}><button onClick={() => toggleMatrixAll(d)} style={{ fontSize: '0.62rem', fontWeight: 700, padding: '4px 8px', borderRadius: 999, border: '1.5px solid', borderColor: isAll ? 'var(--text-primary)' : 'var(--border-color)', background: isAll ? 'var(--text-primary)' : 'var(--bg-card)', color: isAll ? 'var(--bg-card)' : 'var(--text-muted)', cursor: 'pointer' }}>All</button></td>
                    {DEPARTMENTS.map(dep => { const on = (d.departments || []).includes(dep); return (
                      <td key={dep} style={{ textAlign: 'center', padding: '6px' }}>
                        <button onClick={() => toggleMatrix(d, dep)} title={`${d.title} → ${dep}`} style={{ width: 24, height: 24, borderRadius: 7, border: '1.5px solid', borderColor: on ? 'var(--text-primary)' : 'var(--border-color)', background: on ? 'var(--text-primary)' : 'var(--bg-card)', color: '#fff', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{on ? <CheckSquare size={13} /> : ''}</button>
                      </td>
                    ); })}
                  </tr>
                ); })}</tbody>
              </table>
            </div>
          </>
        );
      })()}

      {/* Insights (managers) */}
      {sub === 'insights' && isManager && (() => {
        const i = insights;
        const tile = (label, value, color) => <div style={{ flex: '1 1 130px', background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, padding: '14px 16px', boxShadow: 'var(--shadow-sm)' }}><div style={{ fontSize: '0.62rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)' }}>{label}</div><div style={{ fontSize: '1.6rem', fontWeight: 700, fontFamily: 'inherit', lineHeight: 1.1, color: color || 'var(--text-primary)' }}>{value}</div></div>;
        const card = (title, node) => <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 14, padding: 16, boxShadow: 'var(--shadow-sm)' }}><h3 style={{ fontSize: '0.85rem', fontWeight: 700, margin: '0 0 12px' }}>{title}</h3>{node}</div>;
        const muted = (t) => <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>{t}</div>;
        return (
          <>
            <button className="secondary-btn" onClick={() => switchTab('manage')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 14, height: 32, fontSize: '0.82rem' }}><ArrowLeft size={14} /> Manage</button>
            <div className="view-header" style={{ marginBottom: 16 }}><div className="view-title-group"><h2>Insights</h2><p>Usage, freshness, and training across the knowledge base</p></div></div>
            {!i ? <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-secondary)' }}><Loader size={20} style={{ animation: 'spin 0.7s linear infinite' }} /> Loading…</div> : (
              <>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
                  {tile('Documents', i.total)}{tile('Approved', i.approved, 'hsl(145,55%,30%)')}{tile('In review', i.in_review)}{tile('Needs review', i.needs_review.length, i.needs_review.length ? 'hsl(32,80%,38%)' : undefined)}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
                  {card(<>Needs review <span style={{ fontFamily: 'inherit', color: 'var(--text-muted)' }}>{i.needs_review.length}</span></>, i.needs_review.length ? i.needs_review.map(d => <button key={d.id} onClick={() => openSourceById(d.id)} style={{ display: 'flex', width: '100%', textAlign: 'left', background: 'transparent', border: 'none', borderTop: '1px solid var(--bg-secondary)', padding: '9px 2px', cursor: 'pointer', alignItems: 'center', gap: 8 }}><span style={{ flex: 1, minWidth: 0 }}><span style={{ display: 'block', fontSize: '0.82rem', fontWeight: 500 }}>{d.title}</span><span style={{ display: 'block', fontSize: '0.7rem', color: 'var(--text-muted)' }}>{d.doc_code} · last verified {fmtDate(d.verified_at)}</span></span><span style={{ fontSize: '0.66rem', fontWeight: 700, color: 'hsl(32,80%,38%)', background: 'hsla(38,92%,50%,0.14)', borderRadius: 999, padding: '2px 8px' }}>overdue</span></button>) : muted('Everything is within its review window.'))}
                  {card('Most viewed', i.most_viewed.length ? i.most_viewed.map(d => <button key={d.id} onClick={() => openSourceById(d.id)} style={{ display: 'flex', width: '100%', textAlign: 'left', background: 'transparent', border: 'none', borderTop: '1px solid var(--bg-secondary)', padding: '9px 2px', cursor: 'pointer', alignItems: 'center', gap: 8 }}><span style={{ flex: 1, minWidth: 0 }}><span style={{ display: 'block', fontSize: '0.82rem', fontWeight: 500 }}>{d.title}</span><span style={{ display: 'block', fontSize: '0.7rem', color: 'var(--text-muted)', fontFamily: 'inherit' }}>{d.doc_code}</span></span><span style={{ fontFamily: 'inherit', fontSize: '0.82rem', color: 'var(--text-secondary)' }}>{d.views}</span></button>) : muted('No views recorded yet.'))}
                  {card('Training completion', i.courses.length ? i.courses.map(c => <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, borderTop: '1px solid var(--bg-secondary)', padding: '9px 2px' }}><span style={{ flex: 1, minWidth: 0 }}><span style={{ display: 'block', fontSize: '0.82rem', fontWeight: 500 }}>{c.title}</span><span style={{ display: 'block', fontSize: '0.7rem', color: 'var(--text-muted)' }}>{c.status}</span></span><span style={{ fontFamily: 'inherit', fontSize: '0.82rem', color: 'var(--text-secondary)' }}>{c.completed}/{c.learners} done</span></div>) : muted('No courses yet.'))}
                </div>
              </>
            )}
          </>
        );
      })()}

      {/* Learn (LMS) — list */}
      {sub === 'lms' && lmsMode === 'list' && (() => {
        const published = lmsCourses.filter(c => c.status === 'published');
        const statusChip = (s) => { const m = s === 'Completed' ? STATUS_META.approved : s === 'In progress' ? STATUS_META.in_review : STATUS_META.draft; return <span style={{ backgroundColor: m.bg, color: m.fg, fontSize: '0.72rem', fontWeight: 700, padding: '3px 10px', borderRadius: 999 }}>{s}</span>; };
        const manageView = isManager && lmsManage;
        if (manageView) {
          return (
            <>
              <button className="secondary-btn" onClick={() => switchTab('manage')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 16, height: 34 }}><ArrowLeft size={15} /> Manage</button>
              <div className="view-header" style={{ marginBottom: 16 }}>
                <div className="view-title-group"><h2>Training courses</h2><p>Author, edit, and publish courses and quizzes for the Learn tab.</p></div>
                <button className="primary-btn" onClick={() => openCourseEditor(null)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Plus size={15} /> New course</button>
              </div>
              <div style={{ border: '1px solid var(--border-color)', borderRadius: 12, overflow: 'hidden', background: 'var(--bg-card)' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}><tbody>
                  {lmsCourses.length === 0 ? <tr><td style={{ padding: 16, color: 'var(--text-secondary)', fontSize: '0.85rem' }}>No courses yet — create one with “New course”.</td></tr> : lmsCourses.map(c => (
                    <tr key={c.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                      <td style={{ padding: '11px 14px' }}><div style={{ fontWeight: 600, fontSize: '0.88rem' }}>{c.title}</div><div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontFamily: 'inherit' }}>{c.course_code} · {c.lesson_count} lessons</div></td>
                      <td style={{ padding: '11px 14px' }}><span style={{ fontSize: '0.7rem', fontWeight: 700, color: c.status === 'published' ? 'hsl(145,55%,30%)' : 'var(--text-secondary)', background: c.status === 'published' ? 'hsla(145,63%,42%,0.12)' : 'var(--bg-secondary)', borderRadius: 999, padding: '3px 10px' }}>{c.status}</span></td>
                      <td style={{ padding: '11px 14px', textAlign: 'right' }}><button className="secondary-btn" onClick={() => openCourse(c.id)} style={{ height: 30, fontSize: '0.78rem', marginRight: 6 }}>Preview</button><button className="secondary-btn" onClick={() => openCourseEditor(c.id)} style={{ height: 30, fontSize: '0.78rem' }}>Edit</button></td>
                    </tr>
                  ))}
                </tbody></table>
              </div>
            </>
          );
        }
        return (
          <>
            <div className="view-header" style={{ marginBottom: 16 }}>
              <div className="view-title-group"><h2>Learn</h2><p>Training built from your SOPs and guides — work through the lessons, pass the quiz, and your completion is recorded.</p></div>
            </div>
            <div style={{ fontSize: '0.85rem', fontWeight: 700, margin: '6px 2px 12px' }}>My learning</div>
            {published.length === 0
              ? <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 8, padding: '12px 14px', fontSize: '0.83rem', color: 'var(--text-secondary)' }}>No courses published yet.</div>
              : <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 14 }}>
                  {published.map(c => { const st = c.status_for_me; const pct = coursePct(c); return (
                    <div key={c.id} style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 14, padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>{statusChip(st)}<span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{c.est_minutes} min</span></div>
                      <div style={{ fontWeight: 600, fontSize: '0.95rem', color: 'var(--text-primary)', lineHeight: 1.3 }}>{c.title}</div>
                      <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: 1.5, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{c.description}</div>
                      <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{c.lesson_count} lesson{c.lesson_count === 1 ? '' : 's'}{c.question_count ? ` · ${c.question_count}-question quiz` : ''}</div>
                      <div style={{ height: 8, borderRadius: 999, background: 'var(--bg-secondary)', overflow: 'hidden', margin: '4px 0' }}><div style={{ width: `${pct}%`, height: '100%', background: 'hsl(145,63%,42%)' }} /></div>
                      <button className={st === 'Completed' ? 'secondary-btn' : 'primary-btn'} onClick={() => openCourse(c.id)} style={{ height: 34, fontSize: '0.82rem' }}>{st === 'Completed' ? 'Review' : st === 'Not started' ? 'Start' : 'Continue'}</button>
                    </div>
                  ); })}
                </div>}
          </>
        );
      })()}

      {/* Learn — course player */}
      {sub === 'lms' && lmsMode === 'player' && lmsCourse && (() => {
        const c = lmsCourse, lessons = c.lessons || [], quiz = c.quiz || {}, hasQuiz = (quiz.questions || []).length > 0, prog = c.progress || { lessons_done: [] };
        const pct = c.status_for_me === 'Completed' ? 100 : Math.min(100, Math.round(((prog.lessons_done?.length || 0) + (prog.passed ? 1 : 0)) / ((lessons.length + (hasQuiz ? 1 : 0)) || 1) * 100));
        const navItem = (label, done, on, onClick) => <button key={label} onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', padding: '9px 11px', borderRadius: 9, border: '1px solid', borderColor: on ? 'var(--border-color)' : 'transparent', background: on ? 'var(--bg-card)' : 'transparent', color: on ? 'var(--text-primary)' : 'var(--text-secondary)', fontWeight: on ? 600 : 400, fontSize: '0.83rem', cursor: 'pointer' }}><span style={{ flex: '0 0 auto', width: 22, height: 22, borderRadius: '50%', background: done ? 'hsl(145,63%,42%)' : 'var(--bg-secondary)', color: done ? '#fff' : 'var(--text-muted)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.66rem', fontWeight: 700 }}>{done ? '✓' : label[0]}</span><span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span></button>;
        let main = null;
        if (player.mode === 'lesson') {
          const l = lessons[player.idx] || lessons[0]; const done = (prog.lessons_done || []).includes(l?._id);
          const sop = l?.type === 'sop' ? docs.find(x => x.id === l.docId) : null;
          main = (
            <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 14, padding: 20 }}>
              <div style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)' }}>Lesson {player.idx + 1} of {lessons.length}</div>
              <h2 style={{ fontSize: '1.15rem', margin: '4px 0 12px', fontWeight: 700 }}>{l?.title}</h2>
              {l?.type === 'sop'
                ? (sop ? <div style={{ border: '1px solid var(--border-color)', borderRadius: 10, padding: 14, background: 'var(--bg-secondary)' }}><div style={{ fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', fontFamily: 'inherit', marginBottom: 8 }}>Linked SOP · {sop.doc_code} · v{sop.version}</div>{sop.body?.purpose && <p style={{ margin: '0 0 10px', color: 'var(--text-primary)', fontSize: '0.88rem', lineHeight: 1.6 }}>{sop.body.purpose}</p>}{sop.body?.procedure?.length > 0 && <ol style={{ margin: '0 0 10px', paddingLeft: 18, color: 'var(--text-secondary)', fontSize: '0.85rem', lineHeight: 1.6 }}>{sop.body.procedure.map((s, j) => <li key={j}>{s.text}</li>)}</ol>}<button className="secondary-btn" onClick={() => openDetail(sop)} style={{ height: 30, fontSize: '0.78rem' }}>Open full SOP</button></div> : <div style={{ fontSize: '0.83rem', color: 'var(--text-muted)' }}>Linked SOP not found.</div>)
                : <div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.65 }}>{(l?.body || '').split('\n').map(x => x.trim()).filter(Boolean).map((x, j) => <p key={j} style={{ margin: '0 0 10px' }}>{x}</p>)}</div>}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--border-color)' }}>
                {player.idx > 0 ? <button className="secondary-btn" onClick={() => setPlayer(p => ({ ...p, idx: p.idx - 1 }))} style={{ height: 34 }}>Previous</button> : <span />}
                <button className="primary-btn" onClick={markLessonDone} style={{ height: 34 }}>{done ? (player.idx < lessons.length - 1 ? 'Next lesson' : (hasQuiz ? 'Go to quiz' : 'Finish course')) : 'Mark complete & continue'}</button>
              </div>
            </div>
          );
        } else if (player.mode === 'quiz') {
          main = (
            <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 14, padding: 20 }}>
              <h2 style={{ fontSize: '1.15rem', margin: '0 0 4px', fontWeight: 700 }}>Quiz</h2>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.82rem', margin: '0 0 16px' }}>Answer all questions. Pass mark: {quiz.passPct}%.</p>
              {(quiz.questions || []).map((q, qi) => (
                <div key={q._id} style={{ padding: '12px 0', borderBottom: '1px solid var(--bg-secondary)' }}>
                  <div style={{ fontWeight: 600, fontSize: '0.88rem', marginBottom: 8 }}>{qi + 1}. {q.q}</div>
                  {q.options.map((o, oi) => o.trim() && (
                    <label key={oi} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '9px 11px', border: '1px solid', borderColor: player.answers[q._id] === oi ? 'var(--text-primary)' : 'var(--border-color)', borderRadius: 9, marginBottom: 6, fontSize: '0.85rem', cursor: 'pointer', background: player.answers[q._id] === oi ? 'var(--bg-secondary)' : 'transparent' }}>
                      <input type="radio" name={`q_${q._id}`} checked={player.answers[q._id] === oi} onChange={() => setPlayer(p => ({ ...p, answers: { ...p.answers, [q._id]: oi } }))} /> {o}
                    </label>
                  ))}
                </div>
              ))}
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 16 }}><button className="secondary-btn" onClick={() => setPlayer(p => ({ ...p, mode: 'lesson' }))} style={{ height: 34 }}>Back to lessons</button><button className="primary-btn" onClick={submitQuiz} style={{ height: 34 }}>Submit quiz</button></div>
            </div>
          );
        } else {
          main = (
            <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 14, padding: '34px 20px', textAlign: 'center' }}>
              <div style={{ width: 54, height: 54, borderRadius: '50%', margin: '0 auto', display: 'flex', alignItems: 'center', justifyContent: 'center', background: player.lastPassed ? 'hsla(145,63%,42%,0.14)' : 'hsla(0,84%,60%,0.12)', color: player.lastPassed ? 'hsl(145,55%,30%)' : 'hsl(0,70%,45%)' }}>{player.lastPassed ? <CheckSquare size={26} /> : <X size={26} />}</div>
              <h2 style={{ fontSize: '1.2rem', margin: '14px 0 6px' }}>{player.lastPassed ? 'Course completed' : 'Not quite — try again'}</h2>
              <p style={{ color: 'var(--text-secondary)', margin: 0 }}>You scored <b>{player.lastScore}%</b>{hasQuiz ? ` (pass mark ${quiz.passPct}%)` : ''}.</p>
              <div style={{ marginTop: 16, display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
                {player.lastPassed ? <button className="primary-btn" onClick={() => { setLmsMode('list'); api.getKbCourses().then(setLmsCourses).catch(() => {}); }} style={{ height: 34 }}>Back to Learn</button> : <><button className="primary-btn" onClick={() => setPlayer(p => ({ ...p, mode: 'quiz', answers: {} }))} style={{ height: 34 }}>Retake quiz</button><button className="secondary-btn" onClick={() => setPlayer(p => ({ ...p, mode: 'lesson' }))} style={{ height: 34 }}>Review lessons</button></>}
              </div>
            </div>
          );
        }
        return (
          <>
            <button className="secondary-btn" onClick={() => { setLmsMode('list'); api.getKbCourses().then(setLmsCourses).catch(() => {}); }} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 16, height: 34 }}><ArrowLeft size={15} /> Back to Learn</button>
            <div style={{ marginBottom: 6 }}><div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontFamily: 'inherit' }}>{c.course_code} · {lessons.length} lessons{hasQuiz ? ' · quiz' : ''}</div><h1 style={{ fontSize: '1.3rem', margin: '4px 0 0', fontWeight: 700 }}>{c.title}</h1></div>
            <div style={{ height: 8, borderRadius: 999, background: 'var(--bg-secondary)', overflow: 'hidden', margin: '12px 0 18px' }}><div style={{ width: `${pct}%`, height: '100%', background: 'hsl(145,63%,42%)' }} /></div>
            <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 20, alignItems: 'start' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {lessons.map((l, i) => navItem(l.title, (prog.lessons_done || []).includes(l._id), player.mode === 'lesson' && player.idx === i, () => setPlayer(p => ({ ...p, mode: 'lesson', idx: i }))))}
                {hasQuiz && navItem(`Quiz · ${quiz.questions.length} questions`, prog.passed, player.mode !== 'lesson', () => setPlayer(p => ({ ...p, mode: 'quiz' })))}
              </div>
              <div style={{ minWidth: 0 }}>{main}</div>
            </div>
          </>
        );
      })()}

      {/* Learn — course authoring */}
      {sub === 'lms' && lmsMode === 'editor' && courseDraft && (() => {
        const d = courseDraft; const sopOpts = docs.filter(x => x.doc_type !== 'Manual').sort((a, b) => (a.doc_code || '').localeCompare(b.doc_code || ''));
        return (
          <div style={{ maxWidth: 820 }}>
            <button className="secondary-btn" onClick={() => { setCourseDraft(null); setLmsMode('list'); }} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 16, height: 34 }}><ArrowLeft size={15} /> {d.id ? 'Back' : 'Cancel'}</button>
            <h2 style={{ marginBottom: 4 }}>{d.id ? 'Edit course' : 'New course'}</h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: 18 }}>Assemble lessons from readings or existing SOPs, add an optional quiz, then publish.</p>
            {errBanner}
            <div className="form-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px,1fr))', marginBottom: 14 }}>
              <div className="form-group"><label>Title</label><input className="form-input" value={d.title} placeholder="e.g. New Hire Orientation" onChange={e => cdSet({ title: e.target.value })} /></div>
              <div className="form-group"><label>Estimated minutes</label><input className="form-input" value={d.est_minutes} onChange={e => cdSet({ est_minutes: e.target.value })} /></div>
            </div>
            <div className="form-group" style={{ marginBottom: 14 }}><label>Description</label><textarea className="form-input" value={d.description} placeholder="What this course covers…" onChange={e => cdSet({ description: e.target.value })} style={{ minHeight: 60, resize: 'vertical' }} /></div>
            <div className="form-group" style={{ marginBottom: 18 }}><label>Assign to departments</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>{DEPARTMENTS.map(dep => { const on = d.departments.includes(dep); return <button key={dep} onClick={() => cdSet({ departments: on ? d.departments.filter(x => x !== dep) : [...d.departments, dep] })} style={{ fontSize: '0.8rem', padding: '6px 12px', borderRadius: 999, border: '1px solid', borderColor: on ? 'var(--text-primary)' : 'var(--border-color)', background: on ? 'var(--text-primary)' : 'var(--bg-card)', color: on ? 'var(--bg-card)' : 'var(--text-secondary)', cursor: 'pointer' }}>{dep}</button>; })}</div>
            </div>
            <div style={{ fontSize: '0.85rem', fontWeight: 700, margin: '6px 0 10px' }}>Lessons</div>
            {d.lessons.map((l, i) => (
              <div key={l._id} style={{ border: '1px solid var(--border-color)', borderRadius: 10, padding: 12, marginBottom: 10, background: 'var(--bg-card)' }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                  <span style={{ fontWeight: 700, fontSize: '0.8rem', color: 'var(--text-muted)' }}>{i + 1}</span>
                  <select className="form-select" value={l.type} onChange={e => cdUpdLesson(l._id, { type: e.target.value })} style={{ width: 130, flex: '0 0 auto' }}><option value="text">Reading</option><option value="sop">Linked SOP</option></select>
                  <input className="form-input" value={l.title} placeholder="Lesson title" onChange={e => cdUpdLesson(l._id, { title: e.target.value })} style={{ flex: 1 }} />
                  <button className="secondary-btn" onClick={() => cdDelLesson(l._id)} style={{ width: 36, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Trash2 size={15} /></button>
                </div>
                {l.type === 'sop'
                  ? <select className="form-select" value={l.docId || ''} onChange={e => { const o = sopOpts.find(x => x.id === e.target.value); cdUpdLesson(l._id, { docId: e.target.value, title: l.title || (o ? o.title : '') }); }} style={{ width: '100%' }}><option value="">— select an SOP —</option>{sopOpts.map(o => <option key={o.id} value={o.id}>{o.doc_code} · {o.title}</option>)}</select>
                  : <textarea className="form-input" value={l.body} placeholder="Lesson text… (new lines become paragraphs)" onChange={e => cdUpdLesson(l._id, { body: e.target.value })} style={{ width: '100%', minHeight: 60, resize: 'vertical', fontSize: '0.85rem' }} />}
              </div>
            ))}
            <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}><button className="secondary-btn" onClick={() => cdAddLesson('text')} style={{ height: 32, fontSize: '0.8rem' }}><Plus size={13} /> Add reading</button><button className="secondary-btn" onClick={() => cdAddLesson('sop')} style={{ height: 32, fontSize: '0.8rem' }}><Plus size={13} /> Add SOP lesson</button></div>
            <div style={{ fontSize: '0.85rem', fontWeight: 700, margin: '6px 0 10px' }}>Quiz <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: '0.78rem' }}>· optional</span></div>
            <div className="form-group" style={{ maxWidth: 200, marginBottom: 12 }}><label>Pass mark (%)</label><input className="form-input" value={d.quiz.passPct} onChange={e => cdSet({ quiz: { ...d.quiz, passPct: e.target.value } })} /></div>
            {d.quiz.questions.map((q, qi) => (
              <div key={q._id} style={{ border: '1px solid var(--border-color)', borderRadius: 10, padding: 12, marginBottom: 10, background: 'var(--bg-card)' }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}><span style={{ fontWeight: 700, fontSize: '0.8rem', color: 'var(--text-muted)' }}>Q{qi + 1}</span><input className="form-input" value={q.q} placeholder="Question text" onChange={e => cdUpdQ(q._id, { q: e.target.value })} style={{ flex: 1 }} /><button className="secondary-btn" onClick={() => cdDelQ(q._id)} style={{ width: 36, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Trash2 size={15} /></button></div>
                {q.options.map((o, oi) => (
                  <label key={oi} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <input type="radio" name={`ans_${q._id}`} checked={q.answer === oi} onChange={() => cdUpdQ(q._id, { answer: oi })} title="Mark correct" />
                    <input className="form-input" value={o} placeholder={`Option ${oi + 1}`} onChange={e => cdUpdQ(q._id, { options: q.options.map((x, j) => j === oi ? e.target.value : x) })} style={{ flex: 1 }} />
                  </label>
                ))}
                <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 4 }}>Select the radio next to the correct answer.</div>
              </div>
            ))}
            <button className="secondary-btn" onClick={cdAddQ} style={{ height: 32, fontSize: '0.8rem', marginBottom: 18 }}><Plus size={13} /> Add question</button>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap', paddingTop: 8, borderTop: '1px solid var(--border-color)' }}>
              <button className="secondary-btn" onClick={() => { setCourseDraft(null); setLmsMode('list'); }}>Cancel</button>
              <button className="secondary-btn" onClick={() => saveCourse(false)}>Save draft</button>
              <button className="primary-btn" onClick={() => saveCourse(true)}>Publish</button>
            </div>
          </div>
        );
      })()}

      {reviewModal()}
    </div>
  );
}

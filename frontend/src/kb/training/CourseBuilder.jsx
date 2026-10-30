// Building a course: lessons from the Library or written here, checkpoints,
// the question pool, settings, who takes it, versions, the report. Edits
// are a draft until Publish; learners keep the live version.
import { useEffect, useRef, useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Image from '@tiptap/extension-image';
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table';
import { ArrowLeft, Plus, Trash2, ArrowUp, ArrowDown, BookOpen, FileText, HelpCircle, Sparkles, Check, Users, History, BarChart3, AlertTriangle, Loader2, X, Bell, Unlock, Upload } from 'lucide-react';
import { api } from '../../api';
import AsyncSection from '../../components/AsyncState';
import { Modal, DateField } from '../../tasks/components';
import { Chip, Banner, Stat, Av, TrainingChip } from '../components/Chips';
import { PeopleMultiPick } from '../components/PeoplePick';
import AudienceModal, { normalizeAudience } from '../components/AudienceModal';
import { useToast, errText } from '../components/Toast';
import { KB_NODES } from '../editor/extensions.jsx';
import { goKb, fmtDate, blankDoc, plural } from '../lib';
import Sessions from './Sessions';
import { FeedbackSummary } from './CourseFeedback';
import { importFileAsIs, baseTitle } from '../editor/importFile';

const newId = (p) => `${p}_${Math.random().toString(36).slice(2, 10)}`;
const blankQuestion = () => ({ _id: newId('q'), type: 'single', q: '', options: ['', '', '', ''], answer: [], explanation: '', lessonId: '' });

function LessonEditor({ lesson, onChange }) {
  const editor = useEditor({
    extensions: [StarterKit.configure({ heading: { levels: [2, 3] }, link: { openOnClick: false } }), Placeholder.configure({ placeholder: 'Write the lesson. Short paragraphs, one idea each.' }),
      // tables and pictures, like a Library page, so an imported Word or PDF file keeps them
      Image.configure({ inline: false, allowBase64: false }), Table.configure({ resizable: false }), TableRow, TableHeader, TableCell, ...KB_NODES],
    content: lesson.blocks || blankDoc(),
    onUpdate: ({ editor: ed }) => onChange({ blocks: ed.getJSON() }),
  });
  useEffect(() => { if (editor && lesson.blocks && JSON.stringify(editor.getJSON()) !== JSON.stringify(lesson.blocks)) editor.commands.setContent(lesson.blocks); }, [lesson._id]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div>
      <div className="kb-toolbar" style={{ position: 'static' }}>
        <button type="button" onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}>Heading</button>
        <button type="button" onClick={() => editor?.chain().focus().toggleBulletList().run()}>Bullets</button>
        <button type="button" onClick={() => editor?.chain().focus().insertSteps().run()}>Steps</button>
        <button type="button" onClick={() => editor?.chain().focus().insertCallout('tip').run()}>Tip</button>
        <button type="button" onClick={() => editor?.chain().focus().insertCallout('warning').run()}>Warning</button>
      </div>
      <div className="kb-editor" style={{ minHeight: 220 }}><EditorContent editor={editor} /></div>
    </div>
  );
}

function PagePicker({ onPick, onClose }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState([]);
  useEffect(() => { api.kbSearch(q, { limit: 25 }).then((r) => setRows(r.results || [])).catch(() => {}); }, [q]);
  return (
    <Modal title="Add a Library Page as a Lesson" onClose={onClose} minHeight="50vh">
      <div className="kb" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <input className="kb-input" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search published pages" />
        {rows.map((p) => <button key={p.id} type="button" className="kb-row link" style={{ width: '100%', textAlign: 'left', background: 'none', border: 0, borderTop: '1px solid var(--kb-line)', font: 'inherit', cursor: 'pointer' }} onClick={() => { onPick(p); onClose(); }}><Chip color="#1e7b4e">{p.type_label}</Chip><span className="kb-grow"><span className="kb-title">{p.title}</span><span className="kb-meta"> · v{p.version}</span></span></button>)}
      </div>
    </Modal>
  );
}

function QuestionEditor({ q, lessons, onChange, onDelete }) {
  const set = (patch) => onChange({ ...q, ...patch });
  const setType = (t) => set({ type: t, answer: [], keywords: t === 'short' ? (q.keywords || []) : undefined,
    options: (t === 'short' || t === 'photo') ? [] : t === 'tf' ? ['True', 'False'] : (q.options.length >= 2 && q.type !== 'tf' ? q.options : ['', '', '', '']) });
  const choice = !['order', 'short', 'photo'].includes(q.type);
  return (
    <div className="kb-card soft" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <select className="kb-select" style={{ width: 'auto' }} value={q.type} onChange={(e) => setType(e.target.value)}><option value="single">One answer</option><option value="multi">Several answers</option><option value="tf">True or false</option><option value="order">Put in order</option><option value="short">Short answer</option><option value="photo">Photo proof</option></select>
        <select className="kb-select" style={{ width: 'auto' }} value={q.lessonId} onChange={(e) => set({ lessonId: e.target.value })}><option value="">Reread: any lesson</option>{lessons.map((L) => <option key={L._id} value={L._id}>Reread: {L.title}</option>)}</select>
        <button type="button" className="kb-ibtn" style={{ marginLeft: 'auto' }} aria-label="Delete question" onClick={onDelete}><Trash2 /></button>
      </div>
      <input className="kb-input" value={q.q} onChange={(e) => set({ q: e.target.value })} placeholder="The question" />
      {q.type === 'short' && (
        <div className="kb-field"><label>Keywords The Answer Must Use</label>
          <input className="kb-input" value={(q.keywords || []).join(', ')} onChange={(e) => set({ keywords: e.target.value.split(',').map((k) => k.trim()).filter(Boolean) })} placeholder="harness|safety belt, helmet" />
          <div className="kb-help">Comma between keywords; every one must appear. "a|b" accepts either word. Learners never see these.</div></div>
      )}
      {q.type === 'order' && <div className="kb-help">Enter the items in their RIGHT order; learners see them shuffled.</div>}
      {q.type === 'photo' && <div className="kb-help">The learner uploads a photo. The course owner or their manager approves it or sends it back from Manage &gt; Health before the quiz counts.</div>}
      {!['short', 'photo'].includes(q.type) && <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {q.options.map((o, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {q.type === 'order' ? <b style={{ width: 18 }}>{i + 1}.</b> : <input type={q.type === 'multi' ? 'checkbox' : 'radio'} checked={q.answer.includes(i)} onChange={() => set({ answer: q.type === 'multi' ? (q.answer.includes(i) ? q.answer.filter((x) => x !== i) : [...q.answer, i]) : [i] })} aria-label={`Option ${i + 1} is correct`} style={{ accentColor: 'var(--kb-green)' }} />}
            <input className="kb-input" value={o} disabled={q.type === 'tf'} onChange={(e) => set({ options: q.options.map((x, j) => (j === i ? e.target.value : x)) })} placeholder={`Option ${i + 1}`} />
            {q.type !== 'tf' && q.options.length > 2 && <button type="button" className="kb-ibtn" style={{ width: 28, height: 28 }} aria-label="Remove option" onClick={() => set({ options: q.options.filter((_, j) => j !== i), answer: q.answer.filter((a) => a !== i).map((a) => (a > i ? a - 1 : a)) })}><X size={13} /></button>}
          </div>
        ))}
        {q.type !== 'tf' && q.options.length < (q.type === 'order' ? 8 : 6) && <button type="button" className="kb-btn sm ghost" style={{ alignSelf: 'flex-start' }} onClick={() => set({ options: [...q.options, ''] })}><Plus />{q.type === 'order' ? 'Item' : 'Option'}</button>}
      </div>}
      <input className="kb-input" value={q.explanation} onChange={(e) => set({ explanation: e.target.value })} placeholder="If missed, point to where to reread (never the answer): 'See Lesson 2, step 4'" />
      {choice && !q.answer.length && <div className="kb-meta" style={{ color: '#b91c1c' }}>Mark the correct option{q.type === 'multi' ? 's' : ''}.</div>}
      {q.type === 'short' && !(q.keywords || []).length && <div className="kb-meta" style={{ color: '#b91c1c' }}>Add at least one keyword.</div>}
    </div>
  );
}

export default function CourseBuilder({ id, me }) {
  const toast = useToast();
  const isNew = id === 'new';
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState(null);
  const [err, setErr] = useState('');
  const [tab, setTab] = useState('lessons');
  const [cur, setCur] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pick, setPick] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [genOpen, setGenOpen] = useState(false);
  const [genPages, setGenPages] = useState([]);
  const [genJob, setGenJob] = useState(null);
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignEmails, setAssignEmails] = useState([]);
  const [assignDue, setAssignDue] = useState('');
  const [assignments, setAssignments] = useState(null);
  const [ruleOpen, setRuleOpen] = useState(false);
  const [report, setReport] = useState(null);
  const [publishNote, setPublishNote] = useState('');
  const [publishOpen, setPublishOpen] = useState(false);
  const timer = useRef(null);

  const load = () => { if (isNew) return; setErr(''); api.kbCourseBuilder(id).then((d) => { setData(d); setDraft(d.draft); setDirty(false); if (!cur && d.draft.lessons[0]) setCur(d.draft.lessons[0]._id); }).catch((e) => setErr(errText(e))); };
  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (silent = true) => {
    if (!draft || !data) return;
    setSaving(true);
    try {
      const d = await api.kbUpdateCourse(data.course.id, { title: draft.title, description: draft.description, overview: draft.overview, est_minutes: draft.est_minutes, recert_months: draft.recert_months, departments: draft.departments, lessons: draft.lessons, quiz: draft.quiz, rev: data.rev });
      setData(d); setDirty(false); if (!silent) toast('Saved');
    } catch (e) { toast(errText(e), 'err'); } finally { setSaving(false); }
  };
  useEffect(() => { if (!dirty) return undefined; clearTimeout(timer.current); timer.current = setTimeout(() => save(true), 1500); return () => clearTimeout(timer.current); }, [dirty, draft]); // eslint-disable-line react-hooks/exhaustive-deps
  const patch = (p) => { setDraft((d) => ({ ...d, ...p })); setDirty(true); };
  const patchLesson = (lid, p) => patch({ lessons: draft.lessons.map((L) => (L._id === lid ? { ...L, ...p } : L)) });
  const moveLesson = (i, d) => { const n = [...draft.lessons]; const j = i + d; if (j < 0 || j >= n.length) return; [n[i], n[j]] = [n[j], n[i]]; patch({ lessons: n }); };
  const addLesson = (L) => { patch({ lessons: [...draft.lessons, L] }); setCur(L._id); };
  // Import a Word or PDF file as a lesson (Oct 29 2026, no AI): same reader as the Library import.
  const importRef = useRef(null);
  const [importing, setImporting] = useState('');
  const importLesson = async (file) => {
    if (!file) return;
    setImporting(file.name);
    try {
      const out = await importFileAsIs(file, { keepOriginal: true });
      addLesson({ _id: newId('l'), type: 'text', title: (out.title || baseTitle(file.name) || 'Imported Lesson').slice(0, 200), blocks: out.blocks, docId: '', docVersion: '', summary: '' });
      toast(out.warnings?.length ? `Imported, check the lesson: ${out.warnings[0]}` : 'Imported as a lesson. Check it, then publish the course.');
    } catch (e) { toast(errText(e, 'Could not import the file'), 'err'); } finally { setImporting(''); }
  };
  const quiz = draft?.quiz || { passPct: 80, drawCount: 0, maxTries: 3, shuffle: true, questions: [] };
  const setQuiz = (p) => patch({ quiz: { ...quiz, ...p } });

  const create = async () => {
    if (!newTitle.trim()) return;
    try { const d = await api.kbCreateCourse({ title: newTitle.trim() }); goKb('builder', d.course.id); } catch (e) { toast(errText(e), 'err'); }
  };
  const publish = async () => {
    await save(true);
    try { const d = await api.kbPublishCourse(data.course.id, { change_note: publishNote }); setData(d); setDraft(d.draft); setPublishOpen(false); toast(`Published v${d.course.major}`); } catch (e) { toast(errText(e), 'err'); }
  };
  const generate = async () => {
    try { const j = await api.kbGenerateCourse(data.course.id, { doc_ids: genPages.map((p) => p.id), title_hint: draft.title, questions: 15 }); setGenJob(j); } catch (e) { toast(errText(e), 'err'); }
  };
  useEffect(() => {
    if (!genJob || genJob.status === 'done' || genJob.status === 'failed') { if (genJob?.status === 'done') { toast('Nexus added lessons and questions to the draft'); setGenOpen(false); setGenJob(null); load(); } if (genJob?.status === 'failed') { toast(genJob.error || 'Generation failed', 'err'); setGenJob(null); } return undefined; }
    const t = setTimeout(() => api.kbJob(genJob.id).then(setGenJob).catch(() => {}), 1500);
    return () => clearTimeout(t);
  }, [genJob]); // eslint-disable-line react-hooks/exhaustive-deps
  const loadAssignments = () => api.kbCourseAssignments(data.course.id).then(setAssignments).catch((e) => toast(errText(e), 'err'));
  useEffect(() => { if (tab === 'people' && data && !assignments) loadAssignments(); if (tab === 'report' && data && !report) api.kbCourseReport(data.course.id).then(setReport).catch((e) => toast(errText(e), 'err')); }, [tab, data]); // eslint-disable-line react-hooks/exhaustive-deps

  if (isNew) {
    return (
      <div className="kb-page" style={{ maxWidth: 640 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><button type="button" className="kb-ibtn" style={{ width: 30, height: 30 }} aria-label="Back" onClick={() => goKb('training')}><ArrowLeft /></button><span className="kb-meta">Training / New Course</span></div>
        <h1 className="kb-h1" style={{ margin: 0 }}>New Course</h1>
        <div className="kb-card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="kb-field"><label>Title</label><input className="kb-input" autoFocus style={{ fontSize: 17 }} value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="Site Safety Basics" onKeyDown={(e) => { if (e.key === 'Enter') create(); }} /></div>
          <div className="kb-help">You add lessons next: Library pages pinned to their version, or lessons written here. Nexus can draft lessons and a question pool from pages you pick.</div>
          <button type="button" className="kb-btn pri" style={{ alignSelf: 'flex-end' }} onClick={create}>Create Draft</button>
        </div>
      </div>
    );
  }

  const lesson = draft?.lessons.find((L) => L._id === cur);
  // Incomplete by type (WP 5.5): short needs a keyword, order two items, choices a marked answer.
  const incomplete = (q) => !q.q.trim() || (q.type === 'photo' ? false : q.type === 'short' ? !(q.keywords || []).length
    : q.type === 'order' ? q.options.filter((o) => String(o).trim()).length < 2
      : (!q.answer.length || q.options.some((o) => !String(o).trim())));
  const invalid = quiz.questions.filter(incomplete).length;
  return (
    <AsyncSection loading={!data && !err} error={err ? new Error(err) : null} errorMessage={err} onRetry={load}>
      {data && draft && (
        <div className="kb-page">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <button type="button" className="kb-ibtn" style={{ width: 30, height: 30 }} aria-label="Back" onClick={() => goKb('training')}><ArrowLeft /></button>
            <span className="kb-meta">Training / Courses /</span>
            <input className="kb-bare kb-h1" style={{ fontSize: 22, margin: 0, border: 0, background: 'transparent', color: 'inherit', flex: '1 1 240px', minWidth: 0 }} value={draft.title} onChange={(e) => patch({ title: e.target.value })} aria-label="Course title" />
            <Chip color={data.course.status === 'published' ? '#1e7b4e' : '#64748b'}>{data.course.status === 'published' ? `v${data.course.major} live` : 'Draft'}</Chip>
            <span className="kb-meta">{saving ? 'Saving' : dirty ? 'Unsaved' : 'Saved'}</span>
            <button type="button" className="kb-btn sm" onClick={() => goKb('course', data.course.id)}>Preview</button>
            <button type="button" className="kb-btn sm pri" disabled={!draft.lessons.length} onClick={() => { setPublishOpen(true); }}><Check />{data.course.status === 'published' ? `Publish v${data.course.major + 1}` : 'Publish'}</button>
          </div>
          {data.dirty && <Banner kind="amber" icon={AlertTriangle}><b>v{data.course.major} stays live</b> while you edit. People mid-course finish the version they started. <button type="button" className="kb-btn sm ghost" onClick={() => { if (window.confirm('Discard the unpublished edits?')) api.kbDiscardCourseDraft(data.course.id).then((d) => { setData(d); setDraft(d.draft); }).catch((e) => toast(errText(e), 'err')); }}>Discard Edits</button></Banner>}

          <div className="kb-seg" style={{ alignSelf: 'flex-start' }}>
            {[['lessons', 'Lessons'], ['quiz', `Quiz (${quiz.questions.length})`], ['settings', 'Settings'], ['people', 'Who Takes It'],
              ...((draft.delivery || data.course.delivery) === 'in_person' ? [['sessions', 'Sessions']] : []), ['report', 'Report'], ['versions', 'Versions']].map(([k, l]) => <button key={k} type="button" className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}
          </div>

          {tab === 'lessons' && (
            <div className="kb-cols">
              <aside className="kb-rail" style={{ flex: '0 1 320px', maxWidth: 340 }}>
                <section className="kb-card" style={{ padding: 14 }}>
                  {draft.lessons.length === 0 && <div className="kb-empty">No lessons yet.</div>}
                  {draft.lessons.map((L, i) => (
                    <div key={L._id} className={`kb-lesson${cur === L._id ? ' on' : ''}`} onClick={() => setCur(L._id)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') setCur(L._id); }}>
                      <span className="num">{i + 1}</span>
                      <span className="kb-grow"><span style={{ fontWeight: 600, fontSize: 13.5, display: 'block' }} className="kb-ellipsis">{L.title}</span><span className="kb-meta">{L.type === 'page' ? `Library page v${L.docVersion}${L.page?.newer ? ` (now v${L.page.current_version})` : ''}` : L.type === 'checkpoint' ? `Checkpoint · ${plural((L.questions || []).length, 'question')}` : 'Written here'}</span></span>
                      <span style={{ display: 'flex' }}><button type="button" className="kb-ibtn" style={{ width: 24, height: 24, border: 0 }} aria-label="Up" onClick={(e) => { e.stopPropagation(); moveLesson(i, -1); }}><ArrowUp size={12} /></button><button type="button" className="kb-ibtn" style={{ width: 24, height: 24, border: 0 }} aria-label="Down" onClick={(e) => { e.stopPropagation(); moveLesson(i, 1); }}><ArrowDown size={12} /></button></span>
                    </div>
                  ))}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
                    <button type="button" className="kb-btn sm" onClick={() => setPick(true)}><BookOpen />Add a Library Page</button>
                    <button type="button" className="kb-btn sm" onClick={() => addLesson({ _id: newId('l'), type: 'text', title: 'New Lesson', blocks: blankDoc(), docId: '', docVersion: '', summary: '' })}><FileText />Write a Lesson</button>
                    <button type="button" className="kb-btn sm" disabled={!!importing} onClick={() => importRef.current?.click()}>{importing ? <><Loader2 className="kb-spin" />Importing...</> : <><Upload />Import a Word or PDF</>}</button>
                    <input ref={importRef} type="file" accept=".docx,.pdf" hidden aria-label="Import a Word or PDF file as a lesson" onChange={(e) => { importLesson(e.target.files?.[0]); e.target.value = ''; }} />
                    <button type="button" className="kb-btn sm" onClick={() => addLesson({ _id: newId('l'), type: 'checkpoint', title: 'Checkpoint', questions: [blankQuestion()], docId: '', docVersion: '' })}><HelpCircle />Add a Checkpoint</button>
                    {me?.ai && <button type="button" className="kb-btn sm" onClick={() => setGenOpen(true)}><Sparkles />Generate with Nexus</button>}
                  </div>
                </section>
              </aside>
              <div className="kb-main">
                {!lesson && <div className="kb-card soft kb-empty">Pick a lesson, or add one.</div>}
                {lesson && (
                  <section className="kb-card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <input className="kb-input" style={{ fontSize: 17, fontWeight: 600 }} value={lesson.title} onChange={(e) => patchLesson(lesson._id, { title: e.target.value })} aria-label="Lesson title" />
                      <button type="button" className="kb-ibtn" aria-label="Delete lesson" onClick={() => { if (window.confirm('Remove this lesson?')) { patch({ lessons: draft.lessons.filter((L) => L._id !== lesson._id) }); setCur(''); } }}><Trash2 /></button>
                    </div>
                    {lesson.type === 'page' && (
                      <>
                        <div className="kb-banner blue"><BookOpen /><div className="kb-grow"><b>{lesson.page?.title || 'Library page'}</b> {lesson.page?.code ? `(${lesson.page.code})` : ''} pinned to v{lesson.docVersion}. Later edits to the page do not change this course until you update it.
                          {lesson.page?.newer && <> <button type="button" className="kb-btn sm" style={{ marginLeft: 6 }} onClick={() => patchLesson(lesson._id, { docVersion: lesson.page.current_version })}>Update to v{lesson.page.current_version}</button></>}
                          {lesson.page?.status && lesson.page.status !== 'approved' && <span style={{ color: '#b91c1c' }}> This page is {lesson.page.status}; publish it before the course.</span>}</div></div>
                        <textarea className="kb-textarea" style={{ minHeight: 60 }} value={lesson.summary || ''} onChange={(e) => patchLesson(lesson._id, { summary: e.target.value })} placeholder="One or two lines to introduce the lesson" />
                        <a href="#p" onClick={(e) => { e.preventDefault(); goKb('page', lesson.docId); }}>Open the page</a>
                      </>
                    )}
                    {lesson.type === 'text' && <LessonEditor lesson={lesson} onChange={(p) => patchLesson(lesson._id, p)} />}
                    {lesson.type === 'checkpoint' && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        <div className="kb-meta">A checkpoint sits between lessons: a few questions graded on the spot, with what to reread. It never counts as a final quiz try.</div>
                        {(lesson.questions || []).map((q) => <QuestionEditor key={q._id} q={q} lessons={draft.lessons.filter((L) => L.type !== 'checkpoint')} onChange={(nq) => patchLesson(lesson._id, { questions: lesson.questions.map((x) => (x._id === q._id ? nq : x)) })} onDelete={() => patchLesson(lesson._id, { questions: lesson.questions.filter((x) => x._id !== q._id) })} />)}
                        <button type="button" className="kb-btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => patchLesson(lesson._id, { questions: [...(lesson.questions || []), blankQuestion()] })}><Plus />Question</button>
                      </div>
                    )}
                  </section>
                )}
              </div>
            </div>
          )}

          {tab === 'quiz' && (
            <div className="kb-cols">
              <div className="kb-main">
                {quiz.questions.length === 0 && <div className="kb-card soft kb-empty">No questions yet. A course with no quiz just says Completed when the lessons are done.</div>}
                {quiz.questions.map((q) => <QuestionEditor key={q._id} q={q} lessons={draft.lessons.filter((L) => L.type !== 'checkpoint')} onChange={(nq) => setQuiz({ questions: quiz.questions.map((x) => (x._id === q._id ? nq : x)) })} onDelete={() => setQuiz({ questions: quiz.questions.filter((x) => x._id !== q._id) })} />)}
                <div style={{ display: 'flex', gap: 8 }}><button type="button" className="kb-btn" onClick={() => setQuiz({ questions: [...quiz.questions, blankQuestion()] })}><Plus />Question</button>{me?.ai && <button type="button" className="kb-btn" onClick={() => setGenOpen(true)}><Sparkles />Generate Questions</button>}</div>
              </div>
              <aside className="kb-rail">
                <section className="kb-card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <h3 className="kb-h3">Quiz Settings</h3>
                  <div className="kb-field"><label>Pass mark</label><div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><input type="number" min="1" max="100" className="kb-input" style={{ width: 90 }} value={quiz.passPct} onChange={(e) => setQuiz({ passPct: Number(e.target.value) || 80 })} /><span className="kb-meta">%</span></div></div>
                  <div className="kb-field"><label>Draw</label><div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><input type="number" min="0" max={quiz.questions.length} className="kb-input" style={{ width: 90 }} value={quiz.drawCount} onChange={(e) => setQuiz({ drawCount: Number(e.target.value) || 0 })} /><span className="kb-meta">of {quiz.questions.length} per try (0 = all)</span></div></div>
                  <div className="kb-field"><label>Tries</label><div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><input type="number" min="1" max="10" className="kb-input" style={{ width: 90 }} value={quiz.maxTries} onChange={(e) => setQuiz({ maxTries: Number(e.target.value) || 3 })} /><span className="kb-meta">then a manager unlocks</span></div></div>
                  <label className="kb-check"><input type="checkbox" checked={quiz.shuffle !== false} onChange={(e) => setQuiz({ shuffle: e.target.checked })} />Shuffle questions and options</label>
                  {invalid > 0 && <div className="kb-banner amber"><AlertTriangle /><div>{invalid} question{invalid === 1 ? ' is' : 's are'} incomplete and will be dropped on publish.</div></div>}
                  <div className="kb-meta">Learners never see the right answers. A miss shows the question and where to reread.</div>
                </section>
              </aside>
            </div>
          )}

          {tab === 'sessions' && <Sessions course={data.course} />}

          {tab === 'settings' && (
            <section className="kb-card" style={{ maxWidth: 640, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div className="kb-field"><label>How It's Taken</label>
                <div className="kb-seg" style={{ alignSelf: 'flex-start' }}>
                  {[['online', 'Online'], ['in_person', 'In Person']].map(([k, l]) => <button key={k} type="button" className={(draft.delivery || 'online') === k ? 'on' : ''} onClick={() => patch({ delivery: k })}>{l}</button>)}
                </div>
                <div className="kb-help">{(draft.delivery || 'online') === 'in_person'
                  ? 'Completed only when a trainer marks the person Attended at a session, or signs them off a hands-on check. Lessons are reading before the session.'
                  : 'Completed when every lesson is done and the quiz is passed.'}</div></div>
              <div className="kb-field"><label>Description</label><textarea className="kb-textarea" style={{ minHeight: 60 }} value={draft.description} onChange={(e) => patch({ description: e.target.value })} placeholder="One sentence on who this is for and what they will be able to do" /></div>
              <div className="kb-field"><label>What you'll learn</label>{(draft.overview || []).map((o, i) => <div key={i} style={{ display: 'flex', gap: 6 }}><input className="kb-input" value={o} onChange={(e) => patch({ overview: draft.overview.map((x, j) => (j === i ? e.target.value : x)) })} /><button type="button" className="kb-ibtn" aria-label="Remove" onClick={() => patch({ overview: draft.overview.filter((_, j) => j !== i) })}><X size={14} /></button></div>)}<button type="button" className="kb-btn sm ghost" style={{ alignSelf: 'flex-start' }} onClick={() => patch({ overview: [...(draft.overview || []), ''] })}><Plus />Outcome</button></div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div className="kb-field"><label>Time</label><div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><input type="number" min="1" className="kb-input" style={{ width: 90 }} value={draft.est_minutes} onChange={(e) => patch({ est_minutes: Number(e.target.value) || 15 })} /><span className="kb-meta">minutes</span></div></div>
                <div className="kb-field"><label>Renew every</label><div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><input type="number" min="0" className="kb-input" style={{ width: 90 }} value={draft.recert_months} onChange={(e) => patch({ recert_months: Number(e.target.value) || 0 })} /><span className="kb-meta">months (0 = never)</span></div></div>
              </div>
              <div className="kb-help">A renewal is assigned 30 days before a certificate expires, and the person starts over.</div>
            </section>
          )}

          {tab === 'people' && (
            <div className="kb-cols">
              <div className="kb-main">
                <section className="kb-card">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}><h3 className="kb-h3">Assigned</h3><span className="kb-meta">{assignments ? plural(assignments.length, 'person', 'people') : ''}</span>
                    <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}><button type="button" className="kb-btn sm" onClick={() => setRuleOpen(true)}><Users />Assign by Audience</button><button type="button" className="kb-btn sm pri" disabled={data.course.status !== 'published'} onClick={() => setAssignOpen(true)}><Plus />Assign People</button></span></div>
                  {data.course.status !== 'published' && <div className="kb-meta" style={{ marginBottom: 8 }}>Publish the course before assigning it.</div>}
                  {data.rules.map((r) => <div key={r.id} className="kb-row"><Chip color="#2b6cb0">Rule</Chip><div className="kb-grow"><div className="kb-title">{r.audience_text}</div><div className="kb-meta">due {r.due_days} days after start{r.renew_months ? `, renews every ${r.renew_months} months` : ''} · {r.matches} match now{r.active ? '' : ' · off'}</div></div><button type="button" className="kb-btn sm ghost" onClick={() => api.kbDeleteRule(r.id).then(load)}>Turn Off</button></div>)}
                  {(assignments || []).map((a) => <div key={a.id} className="kb-row"><Av name={a.name} email={a.email} size={24} /><div className="kb-grow"><div className="kb-title">{a.name}</div><div className="kb-meta">{a.source}{a.due_date ? ` · due ${fmtDate(a.due_date)}` : ''}</div></div><TrainingChip status={a.status} /><button type="button" className="kb-btn sm ghost" aria-label="Remove" onClick={() => api.kbRemoveAssignment(a.id).then(loadAssignments)}><X /></button></div>)}
                </section>
              </div>
            </div>
          )}

          {tab === 'report' && (
            <AsyncSection loading={!report}>
              {report && (
                <div className="kb-page">
                  <div className="kb-stats"><Stat value={report.stats.assigned} label="assigned" /><Stat value={report.stats.completed} label="completed" color="#1e7b4e" /><Stat value={report.stats.overdue} label="overdue" color={report.stats.overdue ? '#dc2626' : undefined} /><Stat value={report.stats.locked} label="locked out" color={report.stats.locked ? '#b45309' : undefined} /><Stat value={`${report.stats.avg_score}%`} label="average score" /></div>
                  <div className="kb-cols">
                    <section className="kb-card kb-main">
                      <table className="kb-table"><thead><tr><th>Person</th><th>Status</th><th>Score</th><th>Tries</th><th /></tr></thead><tbody>
                        {report.people.map((p) => (
                          <tr key={p.email}>
                            <td><span style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Av name={p.name} email={p.email} size={24} />{p.name}</span></td>
                            <td><TrainingChip status={p.status} />{p.due_date && <div className="kb-meta">due {fmtDate(p.due_date)}</div>}</td>
                            <td>{p.score != null ? `${p.score}%` : ''}</td>
                            <td>{p.tries_used} of {p.tries_allowed}{p.last_missed?.length > 0 && <div className="kb-meta">missed: {p.last_missed.slice(0, 2).map((m) => m.q).join('; ')}</div>}</td>
                            <td>{p.locked && <button type="button" className="kb-btn sm" onClick={() => api.kbUnlockQuiz(data.course.id, p.email).then(() => { toast(`Unlocked for ${p.name}`); api.kbCourseReport(data.course.id).then(setReport); }).catch((e) => toast(errText(e), 'err'))}><Unlock />Unlock</button>}</td>
                          </tr>
                        ))}
                      </tbody></table>
                    </section>
                    <aside className="kb-rail"><FeedbackSummary feedback={report.feedback} /><section className="kb-card"><h3 className="kb-h3" style={{ marginBottom: 8 }}>Hardest Questions</h3>{report.hardest.filter((h) => h.missed).map((h) => <div key={h.id} className="kb-row"><div className="kb-grow" style={{ fontSize: 13 }}>{h.q}</div><Chip color="#dc2626">{h.missed}</Chip></div>)}{!report.hardest.some((h) => h.missed) && <div className="kb-meta">No misses recorded yet.</div>}</section></aside>
                  </div>
                </div>
              )}
            </AsyncSection>
          )}

          {tab === 'versions' && (
            <section className="kb-card" style={{ maxWidth: 640 }}>
              <h3 className="kb-h3" style={{ marginBottom: 8 }}>Versions</h3>
              {data.versions.length === 0 && <div className="kb-empty">Not published yet.</div>}
              {data.versions.map((v) => <div key={v.id} className="kb-row"><History size={16} style={{ color: 'var(--kb-dim)' }} /><div className="kb-grow"><div className="kb-title">v{v.major} <span className="kb-meta" style={{ fontWeight: 400 }}>{fmtDate(v.published_at)} · {v.published_by}</span></div><div className="kb-meta">{v.lessons} lessons, {v.questions} questions{v.change_note ? ` · ${v.change_note}` : ''}</div></div></div>)}
            </section>
          )}

          {pick && <PagePicker onClose={() => setPick(false)} onPick={(p) => addLesson({ _id: newId('l'), type: 'page', title: p.title, docId: p.id, docVersion: p.version, blocks: null, summary: p.summary || '', page: { id: p.id, title: p.title, code: p.code, current_version: p.version, status: p.status, newer: false } })} />}
          {genOpen && (
            <Modal title="Generate with Nexus" onClose={() => setGenOpen(false)} minHeight="50vh" footer={<div className="kb" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}><button type="button" className="kb-btn" onClick={() => setGenOpen(false)}>Cancel</button><button type="button" className="kb-btn pri" disabled={!genPages.length || !!genJob} onClick={generate}>{genJob ? <><Loader2 className="kb-spin" />Working</> : <><Sparkles />Draft Lessons and Questions</>}</button></div>}>
              <div className="kb" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div className="kb-meta">Pick up to 8 published pages. Nexus drafts a lesson per page and 15 questions that point back to where the answer is. Everything lands in the draft for you to edit; nothing is published.</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{genPages.map((p) => <span key={p.id} className="kb-tag">{p.title}<button type="button" aria-label="Remove" onClick={() => setGenPages(genPages.filter((x) => x.id !== p.id))} style={{ border: 0, background: 'none', cursor: 'pointer', padding: 0, display: 'inline-flex', color: 'inherit' }}><X size={11} /></button></span>)}</div>
                <GenPicker onPick={(p) => { if (!genPages.some((x) => x.id === p.id) && genPages.length < 8) setGenPages([...genPages, p]); }} />
                {genJob && <div className="kb-progress"><i style={{ width: genJob.status === 'running' ? '60%' : '15%', transition: 'width 1s' }} /></div>}
              </div>
            </Modal>
          )}
          {assignOpen && (
            <Modal title="Assign People" onClose={() => setAssignOpen(false)} minHeight="40vh" footer={<div className="kb" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}><button type="button" className="kb-btn" onClick={() => setAssignOpen(false)}>Cancel</button><button type="button" className="kb-btn pri" disabled={!assignEmails.length} onClick={() => api.kbAssignCourse(data.course.id, assignEmails, assignDue).then((r) => { toast(`Assigned to ${r.assigned}`); setAssignOpen(false); setAssignEmails([]); loadAssignments(); }).catch((e) => toast(errText(e), 'err'))}>Assign</button></div>}>
              <div className="kb" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div className="kb-field"><label>People</label><PeopleMultiPick value={assignEmails} onChange={setAssignEmails} /></div>
                <div className="kb-field"><label>Due</label><DateField value={assignDue} onChange={setAssignDue} placeholder="No due date" noPast style={{ minHeight: 40, borderRadius: 10, width: 220 }} /></div>
                <div className="kb-help">For a whole department or job title, use Assign by Audience instead; new hires are picked up automatically.</div>
              </div>
            </Modal>
          )}
          {ruleOpen && <AudienceModal value={normalizeAudience({})} title="Assign by Audience" dueLabel="Due" renewLabel="Renew every" onClose={() => setRuleOpen(false)} onChange={(a) => api.kbCreateRule({ kind: 'course', target_id: data.course.id, audience: a, due_days: a.due_days, renew_months: a.renew_months }).then(() => { toast('Rule saved. Matching people are assigned now and new hires as they start.'); load(); setAssignments(null); }).catch((e) => toast(errText(e), 'err'))} />}
          {publishOpen && (
            <Modal title={data.course.status === 'published' ? `Publish v${data.course.major + 1}` : 'Publish the Course'} onClose={() => setPublishOpen(false)} minHeight="30vh" footer={<div className="kb" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}><button type="button" className="kb-btn" onClick={() => setPublishOpen(false)}>Cancel</button><button type="button" className="kb-btn pri" onClick={publish}><Check />Publish</button></div>}>
              <div className="kb" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div className="kb-meta">{draft.lessons.length} lessons, {quiz.questions.length - invalid} questions{quiz.drawCount ? ` (${quiz.drawCount} drawn per try)` : ''}, {quiz.passPct}% to pass. {data.course.status === 'published' ? 'People mid-course finish the version they started; new learners get this one.' : 'Assign it afterward under Who Takes It.'}</div>
                <div className="kb-field"><label>What changed</label><input className="kb-input" value={publishNote} onChange={(e) => setPublishNote(e.target.value)} placeholder="Shown in the version list" /></div>
              </div>
            </Modal>
          )}
        </div>
      )}
    </AsyncSection>
  );
}

function GenPicker({ onPick }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState([]);
  useEffect(() => { api.kbSearch(q, { limit: 12 }).then((r) => setRows(r.results || [])).catch(() => {}); }, [q]);
  return (
    <div>
      <input className="kb-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search published pages" />
      <div style={{ maxHeight: 220, overflow: 'auto', marginTop: 6 }}>
        {rows.map((p) => <button key={p.id} type="button" className="kb-row link" style={{ width: '100%', textAlign: 'left', background: 'none', border: 0, borderTop: '1px solid var(--kb-line)', font: 'inherit', cursor: 'pointer', padding: '8px 0' }} onClick={() => onPick(p)}><Chip color="#1e7b4e">{p.type_label}</Chip><span className="kb-grow kb-ellipsis">{p.title}</span><Plus size={14} /></button>)}
      </div>
    </div>
  );
}

export { Bell, BarChart3 };

// The one editor. A draft page edits in place; a published page edits as
// a revision (readers keep the live version until it is approved).
// Autosaves, warns before leaving, prompts for missing sections, shows
// Nexus suggestions one at a time.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Image from '@tiptap/extension-image';
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table';
import { ArrowLeft, Bold, Italic, Underline as UnderlineIcon, Link2, Heading2, Heading3, List, ListOrdered, ListChecks, AlertTriangle, Lightbulb, Table as TableIcon, Image as ImageIcon, Play, BookOpen, Plus, Eye, Sparkles, Send, Check, Trash2, X, Loader2, Undo2, Redo2, Save } from 'lucide-react';
import { api } from '../../api';
import AsyncSection from '../../components/AsyncState';
import AnchoredMenu from '../../components/AnchoredMenu';
import { Modal } from '../../tasks/components';
import UnsavedChangesPrompt from '../../components/UnsavedChangesPrompt';
import Blocks from '../components/Blocks';
import { Chip, TypeChip, Banner } from '../components/Chips';
import PeoplePick from '../components/PeoplePick';
import AudienceModal, { normalizeAudience } from '../components/AudienceModal';
import { useToast, errText } from '../components/Toast';
import ImportModal from './ImportModal';
import { KB_NODES } from './extensions.jsx';
import { PAGE_TYPES, EXPECTED_SECTIONS, goKb, blankDoc, sectionNames, isDocBlank, readAsDataUrl, fmtDateTime } from '../lib';

const AUTOSAVE_MS = 1500;

function PagePickerModal({ onPick, onClose }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState([]);
  useEffect(() => { api.kbSearch(q, { limit: 20 }).then((r) => setRows(r.results || [])).catch(() => {}); }, [q]);
  return (
    <Modal title="Embed a Page" onClose={onClose} minHeight="50vh">
      <div className="kb" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <input className="kb-input" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search published pages" />
        {rows.map((p) => (
          <button key={p.id} type="button" className="kb-row link" style={{ width: '100%', textAlign: 'left', background: 'none', border: 0, borderTop: '1px solid var(--kb-line)', font: 'inherit', cursor: 'pointer' }} onClick={() => { onPick(p); onClose(); }}>
            <TypeChip type={p.page_type} /><span className="kb-grow"><span className="kb-title">{p.title}</span><span className="kb-meta"> {p.code ? `· ${p.code}` : ''} · v{p.version}</span></span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

function SubmitModal({ page, revision, me, onClose, onDone }) {
  const toast = useToast();
  const direct = page && (page.page_type === 'how_to' || page.page_type === 'reference');
  const [reviewer, setReviewer] = useState(revision?.reviewer_email || page?.reviewer_email || '');
  const [kind, setKind] = useState(revision?.change_kind || 'minor');
  const [note, setNote] = useState(revision?.change_note || '');
  const [busy, setBusy] = useState(false);
  const canPublishDirect = direct || me?.can_manage;
  const go = async (publish) => {
    setBusy(true);
    try {
      if (revision) {
        const out = await api.kbSubmitRevision(revision.id, { reviewer_email: reviewer, change_kind: kind, change_note: note });
        toast(out.status === 'merged' ? `Published as v${out.page.version}` : 'Sent for review');
        onDone(out.status === 'merged' ? 'page' : 'revision', out);
      } else if (publish) {
        const out = await api.kbPublishPage(page.id, { change_note: note });
        toast(`Published as v${out.version}`);
        onDone('page', out);
      } else {
        const out = await api.kbSubmitPage(page.id, { reviewer_email: reviewer, change_note: note });
        toast('Sent for review');
        onDone('page', out);
      }
    } catch (e) { toast(errText(e), 'err'); } finally { setBusy(false); }
  };
  const needsReviewer = !canPublishDirect || (revision && !direct);
  return (
    <Modal title={revision ? 'Submit the Revision' : canPublishDirect ? 'Publish' : 'Submit for Review'} onClose={onClose} minHeight="40vh"
           footer={<div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
             <button type="button" className="kb-btn" onClick={onClose}>Cancel</button>
             {!revision && canPublishDirect && <button type="button" className="kb-btn pri" disabled={busy} onClick={() => go(true)}><Check />Publish Now</button>}
             {(revision || !canPublishDirect) && <button type="button" className="kb-btn pri" disabled={busy || (needsReviewer && !reviewer && !page?.collection?.length)} onClick={() => go(false)}><Send />{revision && direct ? 'Publish Revision' : 'Send for Review'}</button>}
           </div>}>
      <div className="kb" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {revision && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="kb-label">What kind of change is this?</div>
            <label className={`kb-radio${kind === 'minor' ? ' on' : ''}`}><input type="radio" checked={kind === 'minor'} onChange={() => setKind('minor')} /><span><b>Small fix</b> → v{revision.next_version && kind === 'minor' ? revision.next_version : `${page.version.split('.')[0]}.${Number(page.version.split('.')[1] || 0) + 1}`}<div className="kb-help">Typos, clearer wording, a photo. Signatures stay valid.</div></span></label>
            <label className={`kb-radio${kind === 'major' ? ' on' : ''}`}><input type="radio" checked={kind === 'major'} onChange={() => setKind('major')} /><span><b>Real change</b> → v{Number(page.version.split('.')[0]) + 1}.0<div className="kb-help">Steps added or removed, rules changed.{page.require_ack ? ' Everyone signs again.' : ''}</div></span></label>
          </div>
        )}
        {!direct && <div className="kb-field"><label>Reviewer</label><PeoplePick value={reviewer} onChange={setReviewer} preferManagers placeholder="Who approves this" /><div className="kb-help">Someone other than you: a {PAGE_TYPES[page.page_type]?.label || 'page'} needs a second person. The collection owner can always approve.</div></div>}
        <div className="kb-field"><label>{revision ? 'What changed' : 'Note'}</label><textarea className="kb-textarea" style={{ minHeight: 80 }} value={note} onChange={(e) => setNote(e.target.value)} placeholder={revision ? 'Shown in the version list and, for a policy, in the re-sign notice' : 'Anything the reviewer should know'} /></div>
        {!revision && canPublishDirect && <div className="kb-help">{direct ? `A ${PAGE_TYPES[page.page_type].label} goes live as soon as you publish it.` : 'As a Knowledge Base manager you can publish directly, or send it to someone for a second look.'}</div>}
      </div>
    </Modal>
  );
}

export default function Editor({ id, me }) {
  const toast = useToast();
  const isNew = id === 'new' || id.startsWith('new:');
  const isImport = id === 'import';
  const [page, setPage] = useState(null);
  const [revision, setRevision] = useState(null);
  const [err, setErr] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState('');
  const [preview, setPreview] = useState(false);
  const [submitOpen, setSubmitOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(isImport);
  const [pickPage, setPickPage] = useState(false);
  const [audienceOpen, setAudienceOpen] = useState(false);
  const [blockMenu, setBlockMenu] = useState(false);
  const [leaving, setLeaving] = useState(null);
  const [dismissed, setDismissed] = useState([]);
  const [instruction, setInstruction] = useState('');
  const [suggestions, setSuggestions] = useState(null);
  const [suggestBusy, setSuggestBusy] = useState(false);
  const [collections, setCollections] = useState([]);
  const [tags, setTags] = useState([]);
  const [tagInput, setTagInput] = useState('');
  const [settings, setSettings] = useState({ title: '', summary: '', page_type: 'how_to', collection_id: '', tags: [], reviewer_email: '', owner_email: '', review_every_months: 0, require_ack: false, audience: null, signing: 'in_page' });
  const [newCreate, setNewCreate] = useState(isNew ? { collection_id: id.startsWith('new:') ? id.slice(4) : '', title: '', page_type: 'how_to', template: 'how_to' } : null);
  const [loadedDoc, setLoadedDoc] = useState(null);   // what the editor shows once both it and the page exist
  const plusRef = useRef(null);
  const saveTimer = useRef(null);
  const latestDoc = useRef(null);

  const target = revision || page;   // what the editor writes to
  const uploadImage = useCallback(async (file) => {
    const r = await api.kbUploadMedia(await readAsDataUrl(file), 'pages');
    return r.url;
  }, []);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: { openOnClick: false, autolink: true }, codeBlock: {} }),
      Placeholder.configure({ placeholder: 'Write here. Press + for steps, callouts, tables and more.' }),
      Image.configure({ inline: false, allowBase64: false }),
      Table.configure({ resizable: false }), TableRow, TableHeader, TableCell,
      ...KB_NODES,
    ],
    content: blankDoc(),
    editorProps: {
      attributes: { class: 'kb-prosemirror', spellcheck: 'true' },
      handlePaste: (view, event) => {
        const files = Array.from(event.clipboardData?.files || []).filter((f) => f.type.startsWith('image/'));
        if (!files.length) return false;
        event.preventDefault();
        files.forEach((f) => uploadImage(f).then((url) => editor?.chain().focus().setImage({ src: url, alt: f.name }).run()).catch((e) => toast(errText(e, 'Image upload failed'), 'err')));
        return true;
      },
      handleDrop: (view, event) => {
        const files = Array.from(event.dataTransfer?.files || []).filter((f) => f.type.startsWith('image/'));
        if (!files.length) return false;
        event.preventDefault();
        files.forEach((f) => uploadImage(f).then((url) => editor?.chain().focus().setImage({ src: url, alt: f.name }).run()).catch((e) => toast(errText(e, 'Image upload failed'), 'err')));
        return true;
      },
    },
    onUpdate: ({ editor: ed }) => { latestDoc.current = ed.getJSON(); setDirty(true); },
  });

  // ── load ──
  const load = useCallback(async () => {
    setErr('');
    try {
      if (isNew || isImport) return;
      const p = await api.kbPage(id);
      setPage(p);
      setSettings({ title: p.title, summary: p.summary, page_type: p.page_type, collection_id: p.collection_id, tags: p.tags, reviewer_email: p.reviewer_email, owner_email: p.owner_email,
                    review_every_months: p.review_every_months, require_ack: p.require_ack, audience: p.audience, signing: p.signing });
      let doc = p.blocks;
      if (p.status === 'approved') {
        const r = await api.kbOpenRevision(p.id);
        setRevision(r);
        doc = r.blocks;
        setSettings((s) => ({ ...s, title: r.title, summary: r.summary }));
      } else if (p.status === 'in_review') {
        setErr('This page is in review. Withdraw it from the page to edit it again.');
        return;
      }
      latestDoc.current = doc || blankDoc();
      setLoadedDoc({ doc: latestDoc.current });
      setDirty(false);
    } catch (e) { setErr(errText(e)); }
  }, [id, isNew, isImport]);
  useEffect(() => { load(); }, [load]);
  // The editor instance can arrive after the page (and React's dev double
  // mount replaces it once), so the content is set whenever both are ready.
  useEffect(() => {
    if (!editor || editor.isDestroyed || !loadedDoc) return;
    editor.commands.setContent(loadedDoc.doc);
  }, [editor, loadedDoc]);
  useEffect(() => { api.kbCollections().then(setCollections).catch(() => {}); api.kbTags().then(setTags).catch(() => {}); }, []);

  // ── save ──
  const save = useCallback(async (silent = true) => {
    if (!target || !editor || editor.isDestroyed) return null;
    const doc = latestDoc.current || editor.getJSON();
    setSaving(true);
    try {
      let out;
      if (revision) {
        out = await api.kbUpdateRevision(revision.id, { blocks: doc, title: settings.title, summary: settings.summary, rev: revision.updated_at });
        setRevision(out);
      } else {
        out = await api.kbUpdatePage(page.id, { blocks: doc, title: settings.title, summary: settings.summary, rev: page.updated_at });
        setPage(out);
      }
      setDirty(false); setSavedAt(new Date().toISOString());
      if (!silent) toast('Saved');
      return out;
    } catch (e) {
      if (e.status === 409) toast(errText(e), 'err'); else if (!silent) toast(errText(e, 'Could not save'), 'err');
      return null;
    } finally { setSaving(false); }
  }, [target, editor, revision, page, settings.title, settings.summary, toast]);
  useEffect(() => {
    if (!dirty || !target) return undefined;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => save(true), AUTOSAVE_MS);
    return () => clearTimeout(saveTimer.current);
  }, [dirty, settings.title, settings.summary, target, save]);
  useEffect(() => {
    const onUnload = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [dirty]);

  // settings save on change (not content)
  const patchSettings = async (patch) => {
    setSettings((s) => ({ ...s, ...patch }));
    if (!page) return;
    try { const out = await api.kbUpdatePage(page.id, patch); setPage(out); } catch (e) { toast(errText(e), 'err'); }
  };

  // ── create (new page / import) ──
  const create = async (extra = {}) => {
    const body = { ...newCreate, ...extra };
    if (!body.title?.trim()) { toast('Give the page a title', 'err'); return; }
    try {
      const p = await api.kbCreatePage(body);
      toast('Draft created');
      goKb('editor', p.id);
    } catch (e) { toast(errText(e), 'err'); }
  };

  const leave = () => {
    const back = () => (page ? goKb('page', page.id) : goKb('home'));
    if (dirty) setLeaving(() => back); else back();
  };

  // ── missing sections ──
  const doc = latestDoc.current || editor?.getJSON();
  const have = useMemo(() => sectionNames(doc || {}), [doc]); // eslint-disable-line react-hooks/exhaustive-deps
  const missing = (EXPECTED_SECTIONS[settings.page_type] || []).filter((s) => !have.has(s.toLowerCase()) && !dismissed.includes(s) && !(s === 'Steps' && JSON.stringify(doc || '').includes('"steps"')));
  const addSection = (name) => {
    if (!editor || editor.isDestroyed) return;
    const chain = editor.chain().focus('end').insertContent({ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: name }] });
    if (name === 'Steps') chain.insertSteps(); else if (name === 'Safety') chain.insertCallout('safety'); else chain.insertContent({ type: 'paragraph' });
    chain.run();
  };

  // ── Nexus suggestions ──
  const askNexus = async () => {
    if (!instruction.trim() || !page) return;
    setSuggestBusy(true);
    try { const r = await api.kbSuggest(page.id, { instruction, blocks: latestDoc.current || editor.getJSON() }); setSuggestions(r.suggestions); if (!r.suggestions.length) toast('Nexus had nothing to change'); }
    catch (e) { toast(errText(e), 'err'); } finally { setSuggestBusy(false); }
  };
  const applySuggestion = (s, accept) => {
    if (accept && editor && !editor.isDestroyed) {
      const cur = editor.getJSON();
      const content = [...(cur.content || [])];
      if (s.action === 'replace' && s.block) content[s.index] = s.block;
      else if (s.action === 'insert_after' && s.block) content.splice(s.index + 1, 0, s.block);
      else if (s.action === 'delete') content.splice(s.index, 1);
      editor.commands.setContent({ type: 'doc', content });
      latestDoc.current = editor.getJSON();
      setDirty(true);
      // later indexes shift by one after an insert/delete
      setSuggestions((list) => list.filter((x) => x !== s).map((x) => (s.action === 'insert_after' && x.index > s.index ? { ...x, index: x.index + 1 } : s.action === 'delete' && x.index > s.index ? { ...x, index: x.index - 1 } : x)));
      return;
    }
    setSuggestions((list) => list.filter((x) => x !== s));
  };

  const insert = (what) => {
    if (!editor || editor.isDestroyed) return;
    const c = editor.chain().focus();
    if (what === 'steps') c.insertSteps().run();
    else if (what === 'warning' || what === 'tip' || what === 'note' || what === 'safety') c.insertCallout(what).run();
    else if (what === 'checklist') c.insertChecklist().run();
    else if (what === 'table') c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
    else if (what === 'h2') c.toggleHeading({ level: 2 }).run();
    else if (what === 'h3') c.toggleHeading({ level: 3 }).run();
    else if (what === 'bullets') c.toggleBulletList().run();
    else if (what === 'numbers') c.toggleOrderedList().run();
    else if (what === 'image') { const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*'; inp.onchange = () => { const f = inp.files?.[0]; if (f) uploadImage(f).then((url) => editor.chain().focus().setImage({ src: url, alt: f.name }).run()).catch((e) => toast(errText(e), 'err')); }; inp.click(); }
    else if (what === 'video') { const url = window.prompt('Video link (YouTube, Loom, Vimeo, SharePoint):'); if (url && /^https:\/\//.test(url)) c.insertContent({ type: 'video', attrs: { url, title: '' } }).run(); else if (url) toast('Use an https:// link', 'err'); }
    else if (what === 'embed') setPickPage(true);
    else if (what === 'link') { const url = window.prompt('Link to:'); if (url) c.setLink({ href: url }).run(); }
    setBlockMenu(false);
  };

  // ── new page screen ──
  if (newCreate) {
    return (
      <div className="kb-page" style={{ maxWidth: 760 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><button type="button" className="kb-ibtn" style={{ width: 30, height: 30 }} aria-label="Back" onClick={() => goKb('home')}><ArrowLeft /></button><span className="kb-meta">Knowledge Base / New Page</span></div>
        <h1 className="kb-h1" style={{ margin: 0 }}>New Page</h1>
        <div className="kb-card" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="kb-field"><label>Title</label><input className="kb-input" autoFocus style={{ fontSize: 17 }} value={newCreate.title} onChange={(e) => setNewCreate({ ...newCreate, title: e.target.value })} placeholder="Reset a Tenant's Gate Code" onKeyDown={(e) => { if (e.key === 'Enter') create(); }} /></div>
          <div className="kb-field"><label>What kind of page</label>
            <div className="kb-grid3">
              {Object.values(PAGE_TYPES).map((t) => (
                <button key={t.key} type="button" className="kb-coll" style={newCreate.page_type === t.key ? { borderColor: t.color, background: `color-mix(in srgb, ${t.color} 8%, var(--kb-card))` } : {}} onClick={() => setNewCreate({ ...newCreate, page_type: t.key, template: t.key })}>
                  <Chip color={t.color}>{t.label}</Chip><div className="kb-meta">{t.blurb}</div>
                </button>
              ))}
            </div>
          </div>
          <div className="kb-field"><label>Collection</label>
            <select className="kb-select" value={newCreate.collection_id} onChange={(e) => setNewCreate({ ...newCreate, collection_id: e.target.value })}>
              <option value="">Choose later</option>
              {collections.filter((c) => !c.parent_id).map((c) => <optgroup key={c.id} label={c.name}><option value={c.id}>{c.name}</option>{collections.filter((x) => x.parent_id === c.id).map((x) => <option key={x.id} value={x.id}>{c.name} / {x.name}</option>)}</optgroup>)}
            </select></div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <button type="button" className="kb-btn" onClick={() => setImportOpen(true)}>Import Instead</button>
            <button type="button" className="kb-btn pri" onClick={() => create()}>Start Writing</button>
          </div>
        </div>
        {importOpen && <ImportModal defaultCollection={newCreate.collection_id} onClose={() => setImportOpen(false)} onOpenInEditor={(d) => { setImportOpen(false); create({ ...d, template: '' }); }} />}
      </div>
    );
  }
  if (isImport) {
    return (
      <div className="kb-page">
        {importOpen ? <ImportModal onClose={() => goKb('home')} onOpenInEditor={(d) => { setImportOpen(false); setNewCreate({ collection_id: d.collection_id, title: d.title, page_type: d.page_type, template: '' }); api.kbCreatePage({ ...d, template: '' }).then((p) => { toast('Draft created from the import'); goKb('editor', p.id); }).catch((e) => toast(errText(e), 'err')); }} /> : <div className="kb-empty">Opening the editor...</div>}
      </div>
    );
  }

  const status = revision ? `Revision of v${page?.version}` : page ? page.status.replace('_', ' ') : '';
  return (
    <AsyncSection loading={!page && !err} error={err ? new Error(err) : null} errorMessage={err} onRetry={load}>
      {page && (
        <div className="kb-page">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <button type="button" className="kb-ibtn" style={{ width: 30, height: 30 }} aria-label="Back" onClick={leave}><ArrowLeft /></button>
            <span className="kb-meta">Knowledge Base / {page.collection?.map((c) => c.name).join(' / ') || 'No collection'} /</span>
            <TypeChip type={settings.page_type} />
            <Chip color={revision ? '#b45309' : '#64748b'}>{status}</Chip>
            <span className="kb-meta" style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              {saving ? <><Loader2 size={13} className="kb-spin" />Saving</> : dirty ? 'Unsaved changes' : savedAt ? `Saved ${fmtDateTime(savedAt)}` : ''}
            </span>
            <button type="button" className="kb-btn sm" onClick={() => save(false)} disabled={saving || !dirty}><Save />Save</button>
            <button type="button" className={`kb-btn sm${preview ? ' on' : ''}`} onClick={() => setPreview(!preview)}><Eye />{preview ? 'Back to Editing' : 'Preview'}</button>
            <button type="button" className="kb-btn sm pri" onClick={async () => { await save(true); setSubmitOpen(true); }} disabled={isDocBlank(doc || {})}><Send />{revision ? 'Submit Revision' : (settings.page_type === 'how_to' || settings.page_type === 'reference' || me?.can_manage) ? 'Publish' : 'Submit for Review'}</button>
          </div>

          {revision && <Banner kind="amber" icon={AlertTriangle}><b>Readers still see v{page.version}.</b> This revision goes live after it is approved. {revision.status === 'changes_requested' && revision.review_note ? `Reviewer asked: "${revision.review_note}"` : ''}
            <button type="button" className="kb-btn sm ghost" style={{ marginLeft: 8 }} onClick={() => { if (window.confirm('Discard this revision? The live page is untouched.')) api.kbDiscardRevision(revision.id).then(() => goKb('page', page.id)).catch((e) => toast(errText(e), 'err')); }}><Trash2 />Discard Revision</button></Banner>}
          {page.status === 'changes_requested' && page.review_note && !revision && <Banner kind="amber" icon={AlertTriangle}><b>Changes requested:</b> {page.review_note}</Banner>}

          <div className="kb-cols" style={{ gap: 24 }}>
            <div className="kb-card kb-article" style={{ padding: '24px 32px 32px' }}>
              <input className="kb-bare kb-h1" style={{ width: '100%', border: 0, background: 'transparent', color: 'inherit', padding: 0, margin: '0 0 6px' }} value={settings.title} onChange={(e) => { setSettings({ ...settings, title: e.target.value }); setDirty(true); }} placeholder="Page title" aria-label="Title" />
              <input className="kb-input" style={{ border: 0, padding: 0, fontSize: 15, color: 'var(--kb-dim)', background: 'transparent', marginBottom: 12 }} value={settings.summary} onChange={(e) => { setSettings({ ...settings, summary: e.target.value }); setDirty(true); }} placeholder="One line on what this page is for (shown in search results)" aria-label="Summary" />

              {missing.length > 0 && !preview && (
                <div className="kb-banner amber" style={{ marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}><AlertTriangle />
                  <div className="kb-grow">A {PAGE_TYPES[settings.page_type]?.label} usually has {missing.map((m, i) => <span key={m}>{i > 0 ? ', ' : ''}<b>{m}</b></span>)}.</div>
                  {missing.map((m) => <span key={m} style={{ display: 'inline-flex', gap: 4 }}><button type="button" className="kb-btn sm" onClick={() => addSection(m)}><Plus />Add {m}</button><button type="button" className="kb-btn sm ghost" aria-label={`Dismiss ${m}`} onClick={() => setDismissed([...dismissed, m])}><X /></button></span>)}
                </div>
              )}

              {preview ? <Blocks doc={doc} embeds={page.embeds} /> : (
                <>
                  <div className="kb-toolbar">
                    <button ref={plusRef} type="button" className="on" onClick={() => setBlockMenu(true)}><Plus />Add Block</button>
                    <AnchoredMenu anchorRef={plusRef} open={blockMenu} onClose={() => setBlockMenu(false)} minWidth={320}>
                      <div className="kb kb-blockmenu">
                        {[['h2', Heading2, 'Heading', 'A section'], ['h3', Heading3, 'Subheading', ''], ['steps', ListOrdered, 'Steps', 'Numbered, with photos'], ['checklist', ListChecks, 'Checklist', 'Tick boxes'],
                          ['bullets', List, 'Bullet List', ''], ['numbers', ListOrdered, 'Numbered List', 'Plain numbers'], ['warning', AlertTriangle, 'Warning', 'Yellow callout'], ['safety', AlertTriangle, 'Safety', 'Red callout'],
                          ['tip', Lightbulb, 'Tip', 'Green callout'], ['table', TableIcon, 'Table', '3 by 3 to start'], ['image', ImageIcon, 'Image', 'Upload or paste'], ['video', Play, 'Video Link', 'YouTube, Loom, Vimeo'],
                          ['embed', BookOpen, 'Embed a Page', 'Another page, by title']].map(([k, Icon, l, s]) => (
                          <button key={k} type="button" onClick={() => insert(k)}><Icon /><span>{l}{s && <small>{s}</small>}</span></button>
                        ))}
                      </div>
                    </AnchoredMenu>
                    <span className="sep" />
                    <button type="button" className={editor?.isActive('bold') ? 'on' : ''} onClick={() => editor?.chain().focus().toggleBold().run()} aria-label="Bold"><Bold /></button>
                    <button type="button" className={editor?.isActive('italic') ? 'on' : ''} onClick={() => editor?.chain().focus().toggleItalic().run()} aria-label="Italic"><Italic /></button>
                    <button type="button" className={editor?.isActive('underline') ? 'on' : ''} onClick={() => editor?.chain().focus().toggleUnderline().run()} aria-label="Underline"><UnderlineIcon /></button>
                    <button type="button" className={editor?.isActive('link') ? 'on' : ''} onClick={() => (editor?.isActive('link') ? editor.chain().focus().unsetLink().run() : insert('link'))} aria-label="Link"><Link2 /></button>
                    <span className="sep" />
                    <button type="button" className={editor?.isActive('heading', { level: 2 }) ? 'on' : ''} onClick={() => insert('h2')}><Heading2 />H2</button>
                    <button type="button" className={editor?.isActive('heading', { level: 3 }) ? 'on' : ''} onClick={() => insert('h3')}><Heading3 />H3</button>
                    <button type="button" className={editor?.isActive('bulletList') ? 'on' : ''} onClick={() => insert('bullets')} aria-label="Bullet list"><List /></button>
                    <button type="button" onClick={() => insert('steps')}><ListOrdered />Steps</button>
                    <button type="button" onClick={() => insert('warning')}><AlertTriangle />Warning</button>
                    <button type="button" onClick={() => insert('tip')}><Lightbulb />Tip</button>
                    <button type="button" onClick={() => insert('image')}><ImageIcon />Image</button>
                    <span className="sep" />
                    <button type="button" onClick={() => editor?.chain().focus().undo().run()} aria-label="Undo"><Undo2 /></button>
                    <button type="button" onClick={() => editor?.chain().focus().redo().run()} aria-label="Redo"><Redo2 /></button>
                    {editor?.isActive('table') && <><span className="sep" /><button type="button" onClick={() => editor.chain().focus().addRowAfter().run()}>+ Row</button><button type="button" onClick={() => editor.chain().focus().addColumnAfter().run()}>+ Column</button><button type="button" onClick={() => editor.chain().focus().deleteRow().run()}>- Row</button><button type="button" onClick={() => editor.chain().focus().deleteColumn().run()}>- Column</button><button type="button" onClick={() => editor.chain().focus().deleteTable().run()}>Delete Table</button></>}
                  </div>
                  <div className="kb-editor"><EditorContent editor={editor} /></div>
                  <div className="kb-meta">Paste an image anywhere with Ctrl+V. Mod+Enter inside a step adds the next step.</div>
                </>
              )}
            </div>

            <aside className="kb-rail" style={{ flex: '1 1 260px', maxWidth: 320 }}>
              <section className="kb-card">
                <h3 className="kb-h3" style={{ marginBottom: 10 }}>Settings</h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {!revision && page.status !== 'approved' && (
                    <div className="kb-field"><label>Type</label><select className="kb-select" value={settings.page_type} onChange={(e) => patchSettings({ page_type: e.target.value, require_ack: e.target.value === 'policy' ? true : settings.require_ack })}>{Object.values(PAGE_TYPES).map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}</select></div>
                  )}
                  <div className="kb-field"><label>Collection</label>
                    <select className="kb-select" value={settings.collection_id} onChange={(e) => patchSettings({ collection_id: e.target.value })}>
                      <option value="">None</option>
                      {collections.filter((c) => !c.parent_id).map((c) => <optgroup key={c.id} label={c.name}><option value={c.id}>{c.name}</option>{collections.filter((x) => x.parent_id === c.id).map((x) => <option key={x.id} value={x.id}>{c.name} / {x.name}</option>)}</optgroup>)}
                    </select></div>
                  <div className="kb-field"><label>Owner</label><PeoplePick value={settings.owner_email} onChange={(v) => patchSettings({ owner_email: v })} allowClear={false} /></div>
                  {settings.page_type !== 'how_to' && settings.page_type !== 'reference' && <div className="kb-field"><label>Reviewer</label><PeoplePick value={settings.reviewer_email} onChange={(v) => patchSettings({ reviewer_email: v })} preferManagers placeholder="Required for approval" /></div>}
                  <div className="kb-field"><label>Review every</label><select className="kb-select" value={settings.review_every_months} onChange={(e) => patchSettings({ review_every_months: Number(e.target.value) })}><option value={0}>Collection's cycle</option>{[3, 6, 12, 24].map((m) => <option key={m} value={m}>{m} months</option>)}</select></div>
                  <div className="kb-field"><label>Tags</label>
                    <div className="kb-input" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {settings.tags.map((t) => <span key={t} className="kb-tag">{t}<button type="button" aria-label={`Remove ${t}`} onClick={() => patchSettings({ tags: settings.tags.filter((x) => x !== t) })} style={{ border: 0, background: 'none', cursor: 'pointer', padding: 0, display: 'inline-flex', color: 'inherit' }}><X size={11} /></button></span>)}
                      <input list="kb-tag-list" value={tagInput} onChange={(e) => setTagInput(e.target.value)} placeholder="Add a tag" className="kb-bare" style={{ border: 0, font: 'inherit', fontSize: 13, flex: '1 1 80px', minWidth: 0, background: 'transparent', color: 'inherit' }}
                             onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ',') && tagInput.trim()) { e.preventDefault(); const t = tagInput.trim().toLowerCase(); if (!settings.tags.includes(t)) patchSettings({ tags: [...settings.tags, t] }); setTagInput(''); } }} />
                      <datalist id="kb-tag-list">{tags.map((t) => <option key={t.name} value={t.name} />)}</datalist>
                    </div></div>
                  <label className="kb-check"><input type="checkbox" checked={!!settings.require_ack} onChange={(e) => patchSettings({ require_ack: e.target.checked })} />People must sign this page</label>
                  {settings.require_ack && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 24 }}>
                      <div className="kb-meta">Who signs: <b>{page.audience_text || 'Everyone'}</b> <a href="#aud" onClick={(e) => { e.preventDefault(); setAudienceOpen(true); }}>Change</a></div>
                      {page.nexus_sign_available && <label className="kb-check" style={{ fontSize: 13 }}><input type="checkbox" checked={settings.signing === 'nexus_sign'} onChange={(e) => patchSettings({ signing: e.target.checked ? 'nexus_sign' : 'in_page' })} />Send through Nexus Sign instead of in-page</label>}
                    </div>
                  )}
                  {page.translations?.length > 0 && <div className="kb-meta">Languages: {page.translations.map((t) => `${t.lang.toUpperCase()}${t.outdated ? ' (outdated)' : ''}`).join(', ')}. A translation falls out of date when a new version goes live.</div>}
                </div>
              </section>
              {me?.ai && (
                <section className="kb-card">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}><Sparkles size={16} style={{ color: 'var(--kb-green)' }} /><h3 className="kb-h3">Edit with Nexus</h3></div>
                  <div className="kb-meta" style={{ marginBottom: 8 }}>Ask for a change. Nexus shows each suggestion and you accept or skip it, one at a time. It never rewrites the page.</div>
                  <textarea className="kb-textarea" style={{ minHeight: 64 }} value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="Add a warning about wet floors to step 2. Shorten the purpose." />
                  <button type="button" className="kb-btn sm" style={{ marginTop: 8 }} disabled={suggestBusy || !instruction.trim()} onClick={askNexus}>{suggestBusy ? <><Loader2 className="kb-spin" />Thinking</> : <><Sparkles />Suggest</>}</button>
                  {suggestions?.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
                      {suggestions.map((s, i) => (
                        <div key={i} className="kb-suggest">
                          <div className="kb-meta"><b>{s.action === 'delete' ? 'Remove' : s.action === 'insert_after' ? 'Add after block' : 'Change block'} {s.index + 1}</b>{s.reason ? ` · ${s.reason}` : ''}</div>
                          {s.before && s.action !== 'insert_after' && <div className="before">{s.before}</div>}
                          {s.after && <div className="after">{s.after}</div>}
                          <div style={{ display: 'flex', gap: 6 }}><button type="button" className="kb-btn sm pri" onClick={() => applySuggestion(s, true)}><Check />Accept</button><button type="button" className="kb-btn sm" onClick={() => applySuggestion(s, false)}>Skip</button></div>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              )}
            </aside>
          </div>

          {submitOpen && <SubmitModal page={page} revision={revision} me={me} onClose={() => setSubmitOpen(false)} onDone={(kind, out) => { setSubmitOpen(false); setDirty(false); goKb(kind === 'page' ? 'page' : 'revision', kind === 'page' ? page.id : out.id); }} />}
          {pickPage && <PagePickerModal onClose={() => setPickPage(false)} onPick={(p) => editor?.chain().focus().insertContent({ type: 'embedPage', attrs: { docId: p.id, title: p.title } }).run()} />}
          {audienceOpen && <AudienceModal value={normalizeAudience(settings.audience)} onClose={() => setAudienceOpen(false)} onChange={(a) => patchSettings({ audience: a })} title="Who Must Sign" dueLabel="Sign within" renewLabel="Sign again every" />}
          {leaving && <UnsavedChangesPrompt onKeepEditing={() => setLeaving(null)} onDiscard={() => { setDirty(false); leaving(); }} onSave={async () => { await save(false); leaving(); }} saving={saving} />}
        </div>
      )}
    </AsyncSection>
  );
}

import { useEffect, useRef, useState, useCallback } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import { generateJSON } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import {
  X, Loader2, Eye, EyeOff, Bold, Italic, Underline, List, ListOrdered,
  Table as TableIcon, ImagePlus, SeparatorHorizontal, Undo, Redo, Check, AlertCircle, Award,
  Users, FileDown, Printer, Send, History, RotateCcw,
  AlignLeft, AlignCenter, AlignRight, AlignJustify, Link2, Link2Off, FileSearch,
  Shapes, Square, Circle, Minus, Triangle, ArrowRight, Type, Upload, Cloud, Sparkles, FileStack,
  Indent, Outdent, RotateCw, Rows, Columns, Combine, SquareSplitHorizontal, Trash2,
} from 'lucide-react';
import { api } from '../api';
import { MERGE_TOKENS, FRIENDLY_MERGE, SHAPE_DEFAULTS, WRAP_MODES } from '../lib/docBuilderExtensions';
import { BODY_EXTENSIONS } from '../lib/docBuilderSchema';
import { uploadToSupabase, imageFromPaste } from '../lib/docBuilderUpload';
import { importDocumentFile } from '../lib/docBuilderImport';
import { PAGE_SIZES, ORIENTATIONS, MARGIN_PRESETS, DEFAULT_PAGE_SETUP, pageCanvasStyle } from '../lib/pageSetup';
import EgnyteBrowser from './EgnyteBrowser';
import DefineMergeFieldModal from './DefineMergeFieldModal';

const FONT_GROUPS = {
  'Sans-serif': ['Inter', 'Arial', 'Helvetica', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Segoe UI', 'Calibri', 'Roboto', 'Open Sans', 'Lato', 'Montserrat'],
  'Serif': ['Times New Roman', 'Georgia', 'Garamond', 'Cambria', 'Palatino Linotype', 'Book Antiqua'],
  'Monospace': ['Courier New', 'Consolas', 'Monaco', 'Lucida Console'],
  'Display': ['Comic Sans MS', 'Impact', 'Brush Script MT'],
};
const FONT_SIZES = ['10', '11', '12', '14', '16', '18', '20', '24', '28', '32', '36', '48'];
const SHAPE_TYPES = [
  { type: 'rectangle', label: 'Rectangle', Icon: Square },
  { type: 'circle', label: 'Circle', Icon: Circle },
  { type: 'line', label: 'Line', Icon: Minus },
  { type: 'triangle', label: 'Triangle', Icon: Triangle },
  { type: 'arrow', label: 'Arrow', Icon: ArrowRight },
];

// ── Document Builder (Phase 2, generalized for Templates in Phase 3) ────────
// Rich-text editor shared by Documents AND DocTemplates — both store the same
// content shape, so `kind` ('document'|'template') just swaps which API calls
// load/save it and which field holds the display name (title vs name).
// Opened in-place (same "replace the tab content" convention ESign.jsx uses
// for SignModal/SendWizard — a plain early return, not a portal/overlay).
// content shape: { body: <TipTap JSON>, header: <TipTap JSON|null>,
// footer: <TipTap JSON|null> }. Phase 1 drafts have content: {} — treated as
// an empty body with no header/footer.

const AUTOSAVE_MS = 1500;
const SAVE_LABEL = { idle: '', saving: 'Saving…', saved: 'Saved', error: 'Save failed' };

const KIND_API = {
  document: { get: api.getDocument, update: api.updateDocument, nameKey: 'title',
              getVersions: api.getDocumentVersions, getVersion: api.getDocumentVersion },
  template: { get: api.getDocTemplate, update: api.updateDocTemplate, nameKey: 'name',
              getVersions: api.getDocTemplateVersions, getVersion: api.getDocTemplateVersion },
};

function safeName(name) {
  return (name || 'image').replace(/[^a-zA-Z0-9._-]/g, '_');
}

function downloadBlob({ blob, filename }) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function ToolbarBtn({ onClick, active, disabled, title, children }) {
  return (
    <button type="button" title={title} onClick={onClick} disabled={disabled}
      className={active ? 'is-active' : ''}
      style={{ opacity: disabled ? 0.4 : 1 }}>
      {children}
    </button>
  );
}

export default function DocumentBuilder({ docId, kind = 'document', employees = [], entities = [], onClose, toastOk, toastErr }) {
  const { get: apiGet, update: apiUpdate, nameKey, getVersions, getVersion } = KIND_API[kind];
  const [doc, setDoc] = useState(null);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState('');
  const [preview, setPreview] = useState(false);
  const [saveStatus, setSaveStatus] = useState('idle');
  const [headerVisible, setHeaderVisible] = useState(false);
  const [footerVisible, setFooterVisible] = useState(false);
  const [letterheads, setLetterheads] = useState([]);
  const [letterheadId, setLetterheadId] = useState('');
  const [requiresLetterhead, setRequiresLetterhead] = useState(false);
  const [lhPickerOpen, setLhPickerOpen] = useState(false);
  const [employeeId, setEmployeeId] = useState('');
  const [entityId, setEntityId] = useState('');
  const [mergeOverrides, setMergeOverrides] = useState({});
  const [newVarName, setNewVarName] = useState('');
  const [newVarValue, setNewVarValue] = useState('');
  const [mergePickerOpen, setMergePickerOpen] = useState(false);
  const [exporting, setExporting] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [versions, setVersions] = useState(null);
  const [restoringId, setRestoringId] = useState('');
  const [linkPopoverOpen, setLinkPopoverOpen] = useState(false);
  const [linkUrlDraft, setLinkUrlDraft] = useState('');
  const [pdfPreviewUrl, setPdfPreviewUrl] = useState('');
  const [pdfPreviewLoading, setPdfPreviewLoading] = useState(false);
  const [shapePopoverOpen, setShapePopoverOpen] = useState(false);
  const [shapeFill, setShapeFill] = useState('#dbeafe');
  const [shapeStroke, setShapeStroke] = useState('#2563eb');
  const [shapeWrapMode, setShapeWrapMode] = useState('inline');
  const [textboxPopoverOpen, setTextboxPopoverOpen] = useState(false);
  const [textboxWrapMode, setTextboxWrapMode] = useState('inline');
  const [importPopoverOpen, setImportPopoverOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [egnyteOpen, setEgnyteOpen] = useState(false);
  // Template Builder (Phase 13) — field_defs is the single source of truth for
  // a merge field's type/required/default/validation; only meaningful when
  // kind==='template' (Documents generated from one just carry resolved
  // values, not the field metadata itself).
  const [fieldDefs, setFieldDefs] = useState([]);
  const [mergeFieldModal, setMergeFieldModal] = useState(null); // null | { range?: {from,to}, existingDef?: object, initialLabel?: string }
  // Page Setup (Phase 14) — content.pageSetup, a sibling of body/header/footer
  // in the same JSON blob (no schema change needed).
  const [pageSetup, setPageSetup] = useState(DEFAULT_PAGE_SETUP);
  const [pageSetupOpen, setPageSetupOpen] = useState(false);
  const saveTimer = useRef(null);
  const fileInputRef = useRef(null);
  const importInputRef = useRef(null);
  // Guards against a real data-loss bug: onUpdate (and therefore autosave)
  // must never fire before the real content has actually been pushed into
  // these editors. Without this, any update event that slips through during
  // the async load window (Ctrl+S, a stray transaction, a fast remount) saves
  // the editor's still-EMPTY default doc and silently overwrites real content.
  // Flips true only at the end of a successful load/applyContent below.
  const hydratedRef = useRef(false);
  // Bumped on every selection change so the contextual Table/Shape/Textbox/
  // Image toolbars below (which read bodyEditor.isActive(...) at render
  // time) actually re-render as the cursor moves — TipTap's own state
  // changes don't trigger a React re-render on their own.
  const [, setSelectionTick] = useState(0);

  const bodyEditor = useEditor({
    extensions: [
      ...BODY_EXTENSIONS,
      Placeholder.configure({ placeholder: 'Start typing your document…' }),
    ],
    content: null,
    onUpdate: () => { if (hydratedRef.current) scheduleSave(); },
    onSelectionUpdate: () => setSelectionTick((t) => t + 1),
  });

  const headerEditor = useEditor({
    extensions: [StarterKit, Placeholder.configure({ placeholder: 'Header text…' })],
    content: null,
    onUpdate: () => { if (hydratedRef.current) scheduleSave(); },
  });

  const footerEditor = useEditor({
    extensions: [StarterKit, Placeholder.configure({ placeholder: 'Footer text…' })],
    content: null,
    onUpdate: () => { if (hydratedRef.current) scheduleSave(); },
  });

  // Pushes a { body, header, footer } content object into the three editor
  // instances — shared by the initial load below AND by History's "Restore"
  // (Phase 6), so hydration only has one implementation.
  const applyContent = useCallback((content) => {
    const c = content && typeof content === 'object' ? content : {};
    bodyEditor?.commands.setContent(c.body || null, { emitUpdate: false });
    if (c.header) { setHeaderVisible(true); headerEditor?.commands.setContent(c.header, { emitUpdate: false }); }
    else { setHeaderVisible(false); headerEditor?.commands.clearContent(); }
    if (c.footer) { setFooterVisible(true); footerEditor?.commands.setContent(c.footer, { emitUpdate: false }); }
    else { setFooterVisible(false); footerEditor?.commands.clearContent(); }
  }, [bodyEditor, headerEditor, footerEditor]);

  // Load the document once, then push its content into the (already-created,
  // still-empty) editor instances — avoids recreating editors on every
  // re-render, which would drop cursor position/undo history.
  useEffect(() => {
    let cancelled = false;
    hydratedRef.current = false; // re-arm the guard whenever the editor instances change
    apiGet(docId).then(d => {
      if (cancelled) return;
      setDoc(d);
      setTitle(d[nameKey]);
      setLetterheadId(d.letterheadId || '');
      setRequiresLetterhead(!!d.requiresLetterhead);
      setEmployeeId(d.employeeId || '');
      setEntityId(d.entityId || '');
      setMergeOverrides(d.mergeOverrides || {});
      setFieldDefs(d.fieldDefs || []);
      setPageSetup({ ...DEFAULT_PAGE_SETUP, ...(d.content?.pageSetup || {}) });
      applyContent(d.content);
      hydratedRef.current = true;
      setLoading(false);
    }).catch(e => { toastErr?.(e.message || `Failed to load ${kind}`); onClose?.(); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, bodyEditor, headerEditor, footerEditor]);

  useEffect(() => { api.getDocLetterheads().then(setLetterheads).catch(() => setLetterheads([])); }, []);

  useEffect(() => {
    bodyEditor?.setEditable(!preview);
    headerEditor?.setEditable(!preview);
    footerEditor?.setEditable(!preview);
  }, [preview, bodyEditor, headerEditor, footerEditor]);

  const currentContent = useCallback(() => ({
    body: bodyEditor?.getJSON() ?? null,
    header: headerVisible ? (headerEditor?.getJSON() ?? null) : null,
    footer: footerVisible ? (footerEditor?.getJSON() ?? null) : null,
    pageSetup,
  }), [bodyEditor, headerEditor, footerEditor, headerVisible, footerVisible, pageSetup]);

  // Page Setup panel changes save immediately (like the letterhead/employee
  // pickers) rather than going through the debounced content autosave —
  // these are deliberate, infrequent choices, not typing.
  const updatePageSetup = (patch) => {
    const next = { ...pageSetup, ...patch };
    setPageSetup(next);
    const content = { ...currentContent(), pageSetup: next };
    const payload = kind === 'document' ? { content, note: 'Page setup changed' } : { content };
    apiUpdate(docId, payload).catch((e) => toastErr?.(e.message || 'Failed to update page setup'));
  };
  const toggleHeader = () => {
    if (headerVisible) { setHeaderVisible(false); headerEditor?.commands.clearContent(); scheduleSave(); }
    else setHeaderVisible(true);
  };
  const toggleFooter = () => {
    if (footerVisible) { setFooterVisible(false); footerEditor?.commands.clearContent(); scheduleSave(); }
    else setFooterVisible(true);
  };

  const doSave = useCallback(() => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    // Defensive, belt-and-suspenders: even if something calls doSave directly
    // (Ctrl+S, the close-flush) before load finishes, never persist an
    // unhydrated editor's empty default doc over real saved content.
    if (!hydratedRef.current) return;
    setSaveStatus('saving');
    const payload = kind === 'document'
      ? { content: currentContent(), note: 'Autosave' }
      : { content: currentContent() };
    apiUpdate(docId, payload)
      .then(() => setSaveStatus('saved'))
      .catch(() => setSaveStatus('error'));
  }, [docId, currentContent, kind, apiUpdate]);

  const scheduleSave = useCallback(() => {
    setSaveStatus('idle');
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(doSave, AUTOSAVE_MS);
  }, [doSave]);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); doSave(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doSave]);

  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); }, []);

  const saveTitle = () => {
    const t = title.trim();
    if (!t || t === doc?.[nameKey]) return;
    apiUpdate(docId, { [nameKey]: t }).catch(e => toastErr?.(e.message || 'Failed to rename'));
  };

  const close = () => {
    // While viewing the rendered Preview & Send screen, X should back out to
    // the editor (mirroring "Back to Edit"), not exit the document entirely
    // — the two are easy to conflate since both sit in the same top-left
    // corner, but only edit mode's X should actually leave the document.
    if (kind === 'document' && preview) {
      setPreview(false);
      closePdfPreview();
      return;
    }
    if (saveTimer.current) doSave();
    onClose?.();
  };

  const changeLetterhead = (id) => {
    setLetterheadId(id);
    setLhPickerOpen(false);
    apiUpdate(docId, { letterheadId: id }).catch(e => toastErr?.(e.message || 'Failed to update letterhead'));
  };

  const toggleRequiresLetterhead = () => {
    const next = !requiresLetterhead;
    setRequiresLetterhead(next);
    apiUpdate(docId, { requiresLetterhead: next }).catch(e => toastErr?.(e.message || 'Failed to update'));
  };

  const activeLetterhead = letterheads.find(l => l.id === letterheadId);

  const changeEmployee = (id) => {
    setEmployeeId(id);
    apiUpdate(docId, { employeeId: id }).catch(e => toastErr?.(e.message || 'Failed to update'));
  };

  const changeEntity = (id) => {
    setEntityId(id);
    apiUpdate(docId, { entityId: id }).catch(e => toastErr?.(e.message || 'Failed to update'));
  };

  const empLabel = (e) => `${e.firstName || ''} ${e.lastName || ''}`.trim() || e.workEmail || e.id;
  const activeEmployee = employees.find(e => e.id === employeeId);

  // Manual merge-field values + custom variables (Phase 11). mergeOverrides
  // is a flat, document-scoped dict — persistent regardless of which
  // Employee/Entity is currently selected (a manual value is a deliberate
  // correction/definition on this document, not tied to the subject). The
  // backend already resolves overrides as "wins over auto-resolved value"
  // for both built-in tokens AND arbitrary custom keys (services/merge_fields.py),
  // so this is purely a client-side editor over that one dict.
  const saveMergeOverrides = (next) => {
    setMergeOverrides(next);
    apiUpdate(docId, { mergeOverrides: next }).catch(e => toastErr?.(e.message || 'Failed to save merge data'));
  };
  const setOverrideValue = (token, value) => {
    const next = { ...mergeOverrides };
    if (value.trim()) next[token] = value; else delete next[token];
    saveMergeOverrides(next);
  };
  const customVarKeys = Object.keys(mergeOverrides).filter(k => !MERGE_TOKENS.includes(k));
  const addCustomVariable = () => {
    const key = newVarName.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
    if (!key || !newVarValue.trim()) return;
    saveMergeOverrides({ ...mergeOverrides, [key]: newVarValue.trim() });
    setNewVarName(''); setNewVarValue('');
  };
  const removeOverride = (key) => {
    const next = { ...mergeOverrides };
    delete next[key];
    saveMergeOverrides(next);
  };
  const humanizeKey = (key) => key.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());

  const doExport = (format) => {
    setExporting(format);
    const call = format === 'pdf' ? api.exportDocumentPdf(docId) : api.exportDocumentDocx(docId);
    call.then(downloadBlob).catch(e => toastErr?.(e.message || 'Export failed')).finally(() => setExporting(''));
  };

  // In-app PDF Preview — renders the exported PDF in an iframe (browsers have
  // a native PDF viewer for that) rather than hand-rolling pdfjs-dist canvas
  // rendering like PdfEditor.jsx does for field placement, a different problem.
  const openPdfPreview = () => {
    setPdfPreviewLoading(true);
    api.exportDocumentPdf(docId).then(({ blob }) => setPdfPreviewUrl(URL.createObjectURL(blob)))
      .catch(e => toastErr?.(e.message || 'Failed to prepare preview'))
      .finally(() => setPdfPreviewLoading(false));
  };

  const closePdfPreview = () => {
    if (pdfPreviewUrl) URL.revokeObjectURL(pdfPreviewUrl);
    setPdfPreviewUrl('');
  };

  const applyLink = () => {
    const url = linkUrlDraft.trim();
    if (url) bodyEditor?.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
    setLinkPopoverOpen(false); setLinkUrlDraft('');
  };

  const removeLink = () => {
    bodyEditor?.chain().focus().unsetLink().run();
    setLinkPopoverOpen(false); setLinkUrlDraft('');
  };

  const toggleLinkPopover = () => {
    setLinkUrlDraft(bodyEditor?.getAttributes('link')?.href || '');
    setLinkPopoverOpen(o => !o);
  };

  // Default x/y (Phase 9, only meaningful for non-inline wrap modes) — the
  // cursor's current screen position converted to coordinates relative to
  // .doc-page's own box, so a freshly-inserted floating shape/textbox starts
  // roughly where the user was typing instead of always at (0,0).
  const insertPageCoords = () => {
    if (!bodyEditor) return { x: 40, y: 40 };
    try {
      const pos = bodyEditor.state.selection.from;
      const coords = bodyEditor.view.coordsAtPos(pos);
      const pageEl = bodyEditor.view.dom.closest('.doc-page');
      const rect = pageEl?.getBoundingClientRect();
      if (!rect) return { x: 40, y: 40 };
      return { x: Math.max(0, Math.round(coords.left - rect.left)), y: Math.max(0, Math.round(coords.top - rect.top)) };
    } catch {
      return { x: 40, y: 40 };
    }
  };

  const insertShape = (shapeType) => {
    const { width, height } = SHAPE_DEFAULTS[shapeType] || SHAPE_DEFAULTS.rectangle;
    const { x, y } = insertPageCoords();
    // scrollIntoView: shapes insert at the current cursor position, which can
    // be well off-screen in a long document — without this the insert looks
    // like it silently failed even though it worked.
    bodyEditor?.chain().focus().insertContent({
      type: 'docShape',
      attrs: { shapeType, width, height, fillColor: shapeFill, strokeColor: shapeStroke, x, y, wrapMode: shapeWrapMode },
    }).scrollIntoView().run();
    setShapePopoverOpen(false);
  };

  const insertTextbox = () => {
    const { x, y } = insertPageCoords();
    bodyEditor?.chain().focus().insertContent({
      type: 'docTextbox',
      attrs: { x, y, wrapMode: textboxWrapMode },
      content: [{ type: 'paragraph' }],
    }).scrollIntoView().run();
    setTextboxPopoverOpen(false);
  };

  // Phase 5 bridge: export to PDF, hand it to E-Sign's existing SendWizard via
  // the same window.__esignPrefill + nexus:navigate handoff HR->Hiring already
  // uses — no new backend send path, no change to esign.py's compliance logic.
  const doSendForSignature = () => {
    if (doc?.signRequestId && !window.confirm('This document was already sent for signature. Start a new envelope anyway?')) return;
    setExporting('send');
    api.exportDocumentPdf(docId).then(({ blob, filename }) => {
      const pdfFile = new File([blob], filename.endsWith('.pdf') ? filename : `${filename}.pdf`, { type: 'application/pdf' });
      window.__esignPrefill = { title, file: pdfFile, source: 'pdf', sourceDocumentId: docId, parties: [] };
      window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'documents', sub: 'documents-esign' } }));
    }).catch(e => toastErr?.(e.message || 'Failed to prepare document for signature')).finally(() => setExporting(''));
  };

  // Save as Template — copies this document's current content (its
  // mergeField chips included: Document.content always keeps the raw
  // {{token}} nodes, resolved against employee/entity/overrides only at
  // export time, never baked into literal text) into a brand-new DocTemplate
  // via the same create endpoint the Templates library itself uses.
  const [savingTemplate, setSavingTemplate] = useState(false);
  const saveAsTemplate = () => {
    const name = (window.prompt('Template name', title || 'Untitled Template') || '').trim();
    if (!name) return;
    setSavingTemplate(true);
    api.createDocTemplate({ name, category: 'general', requiresLetterhead, letterheadId, content: currentContent() })
      .then(() => toastOk?.(`Saved as template "${name}"`))
      .catch(e => toastErr?.(e.message || 'Failed to save as template'))
      .finally(() => setSavingTemplate(false));
  };

  const openHistory = () => {
    setHistoryOpen(true);
    getVersions(docId).then(setVersions).catch(() => setVersions([]));
  };

  // Restore does NOT rewrite history in place — it PATCHes the old content
  // back on as a brand-new version, so the full audit trail stays intact.
  const restoreVersion = (v) => {
    setRestoringId(v.id);
    getVersion(docId, v.id).then(full => {
      applyContent(full.content);
      return apiUpdate(docId, { content: full.content, note: `Restored from v${v.versionNo}` });
    }).then(d => { setDoc(d); toastOk?.(`Restored version ${v.versionNo}`); setHistoryOpen(false); })
      .catch(e => toastErr?.(e.message || 'Failed to restore version'))
      .finally(() => setRestoringId(''));
  };

  const insertMergeField = (e) => {
    const token = e.target.value;
    if (!token) return;
    bodyEditor?.chain().focus().insertContent({ type: 'mergeField', attrs: { token } }).run();
    e.target.value = '';
  };

  // Template Builder (Phase 13) — "select text → Convert to Merge Field".
  // Captures the selection's own range rather than trusting "current
  // selection" once the modal (and its own inputs) has stolen focus.
  const openConvertToMergeField = () => {
    if (!bodyEditor) return;
    const { from, to } = bodyEditor.state.selection;
    if (from === to) { toastErr?.('Select some text first, then click Convert to Merge Field.'); return; }
    const text = bodyEditor.state.doc.textBetween(from, to, ' ');
    setMergeFieldModal({ range: { from, to }, initialLabel: text });
  };

  // Double-click an existing chip to edit its type/required/default/
  // validation without moving it — chips render as plain HTML (not a TipTap
  // NodeView), so this is a delegated DOM listener rather than a node-level
  // click handler.
  useEffect(() => {
    if (!bodyEditor || kind !== 'template') return;
    const dom = bodyEditor.view.dom;
    const onDblClick = (e) => {
      const chip = e.target.closest?.('[data-merge-token]');
      if (!chip) return;
      const token = chip.getAttribute('data-merge-token');
      const existingDef = fieldDefs.find((f) => f.token === token)
        || { token, label: FRIENDLY_MERGE[token] || token, type: 'text', required: false, validation: {} };
      setMergeFieldModal({ existingDef });
    };
    dom.addEventListener('dblclick', onDblClick);
    return () => dom.removeEventListener('dblclick', onDblClick);
  }, [bodyEditor, kind, fieldDefs]);

  const saveMergeFieldDef = (def) => {
    if (mergeFieldModal?.range) {
      const { from, to } = mergeFieldModal.range;
      bodyEditor?.chain().focus().insertContentAt({ from, to }, { type: 'mergeField', attrs: { token: def.token } }).run();
    }
    const next = [...fieldDefs.filter((f) => f.token !== def.token), def];
    setFieldDefs(next);
    apiUpdate(docId, { fieldDefs: next }).catch((e) => toastErr?.(e.message || 'Failed to save the merge field'));
    setMergeFieldModal(null);
  };

  const doUploadImage = async (file) => {
    const path = `document-images/${docId}/${Date.now()}-${safeName(file.name)}`;
    const { url, error } = await uploadToSupabase(file, 'document-images', path);
    if (error) { toastErr?.(error); return; }
    bodyEditor?.chain().focus().setImage({ src: url }).run();
  };

  const onPickImage = (e) => {
    const file = e.target.files?.[0];
    if (file) doUploadImage(file);
    e.target.value = '';
  };

  const onBodyPaste = (e) => {
    const f = imageFromPaste(e);
    if (f) { e.preventDefault(); doUploadImage(f); }
  };

  // Phase 10: import a Word/PDF/text file, replacing the body content.
  // uploadImportedImage wraps the same uploadToSupabase() helper used for
  // toolbar/paste image inserts (Phase 2) rather than embedding data URIs, so
  // imported images end up as ordinary hosted images, not bloating the
  // document JSON. Unrecognized image bytes from a .docx (e.g. WMF/EMF)
  // simply fail the upload's type check and are skipped — same "failed image
  // doesn't crash the import" convention doc_export.py already follows.
  const uploadImportedImage = async (bytes, mime, n) => {
    const extGuess = (mime || '').split('/')[1]?.split('+')[0] || 'png';
    const path = `document-images/${docId}/imported-${Date.now()}-${n}.${extGuess}`;
    const file = new File([bytes], `imported-${n}.${extGuess}`, { type: mime || 'image/png' });
    const { url, error } = await uploadToSupabase(file, 'document-images', path);
    return error ? '' : url;
  };

  const doImportFile = async (file) => {
    if (!file) return;
    if (!bodyEditor?.isEmpty && !window.confirm('This will replace the current document content. Continue?')) return;
    setImporting(true);
    try {
      const { html, json: directJson, pageSetup: importedPageSetup, warnings } = await importDocumentFile(file, { uploadImage: uploadImportedImage });
      const json = directJson || generateJSON(html || '<p></p>', BODY_EXTENSIONS);
      bodyEditor?.commands.setContent(json);
      // .docx imports carry the source file's own page size/orientation/
      // margins (docxToTiptap.js) — apply them so the imported page setup
      // matches the original, not whatever this document had before.
      if (importedPageSetup) updatePageSetup(importedPageSetup);
      if (warnings?.length) toastErr?.(`Imported with notes: ${warnings.slice(0, 2).join(' ')}`);
      else toastOk?.('Imported — review formatting before sending');
      setImportPopoverOpen(false);
    } catch (e) {
      toastErr?.(e.message || 'Failed to import document');
    } finally {
      setImporting(false);
    }
  };

  const onPickImportFile = (e) => {
    const file = e.target.files?.[0];
    if (file) doImportFile(file);
    e.target.value = '';
  };

  const onPickEgnyteFile = (file) => {
    setEgnyteOpen(false);
    doImportFile(file);
  };

  if (loading || !doc) return (
    <div style={{ padding: 60, textAlign: 'center', color: 'var(--muted)' }}>
      <Loader2 size={22} style={{ animation: 'spin 1s linear infinite' }} />
    </div>
  );

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <button onClick={close} title="Close"
          style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 8, padding: 7, cursor: 'pointer', display: 'flex' }}>
          <X size={16} />
        </button>
        <input value={title} onChange={e => setTitle(e.target.value)} onBlur={saveTitle}
          onKeyDown={e => e.key === 'Enter' && e.target.blur()}
          style={{ flex: '1 1 260px', fontSize: 16, fontWeight: 700, border: 'none', background: 'none', outline: 'none', fontFamily: 'Inter, sans-serif', color: 'var(--ink)' }} />
        <span style={{ fontSize: 11.5, color: saveStatus === 'error' ? 'hsl(var(--color-red))' : 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 70 }}>
          {saveStatus === 'saving' && <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} />}
          {saveStatus === 'saved' && <Check size={12} />}
          {saveStatus === 'error' && <AlertCircle size={12} />}
          {SAVE_LABEL[saveStatus]}
        </span>
        {!preview && kind === 'template' && (
          <label style={{ fontSize: 11.5, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer', whiteSpace: 'nowrap' }}>
            <input type="checkbox" checked={requiresLetterhead} onChange={toggleRequiresLetterhead} /> Requires letterhead
          </label>
        )}
        {!preview && (
          <div style={{ position: 'relative' }}>
            <button onClick={() => setLhPickerOpen(o => !o)}
              style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 8, padding: '7px 12px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600, fontFamily: 'Inter, sans-serif' }}>
              <Award size={14} /> {activeLetterhead ? activeLetterhead.name : 'No letterhead'}
            </button>
            {lhPickerOpen && (
              <div style={{ position: 'absolute', top: '110%', right: 0, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, boxShadow: 'var(--shadow-lg)', zIndex: 20, minWidth: 200, padding: 6 }}>
                <button onClick={() => changeLetterhead('')}
                  style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: '7px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 12.5, color: 'var(--ink)' }}>No letterhead</button>
                {letterheads.map(l => (
                  <button key={l.id} onClick={() => changeLetterhead(l.id)}
                    style={{ display: 'block', width: '100%', textAlign: 'left', background: l.id === letterheadId ? 'var(--mist)' : 'none', border: 'none', padding: '7px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 12.5, color: 'var(--ink)' }}>
                    {l.name}{l.isDefault ? ' (default)' : ''}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {!preview && (
          <div style={{ position: 'relative' }}>
            <button onClick={() => setMergePickerOpen(o => !o)}
              style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 8, padding: '7px 12px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600, fontFamily: 'Inter, sans-serif' }}>
              <Users size={14} /> {activeEmployee ? empLabel(activeEmployee) : 'Merge data'}
            </button>
            {mergePickerOpen && (
              <div style={{ position: 'absolute', top: '110%', right: 0, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, boxShadow: 'var(--shadow-lg)', zIndex: 20, width: 300, maxHeight: '70vh', overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                {kind === 'document' && (
                  <>
                    <div>
                      <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 4 }}>Employee (merge subject)</label>
                      <select className="form-input" style={{ width: '100%', fontSize: 12.5 }} value={employeeId} onChange={e => changeEmployee(e.target.value)}>
                        <option value="">None</option>
                        {employees.map(e => <option key={e.id} value={e.id}>{empLabel(e)}</option>)}
                      </select>
                    </div>
                    <div>
                      <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 4 }}>Entity (company)</label>
                      <select className="form-input" style={{ width: '100%', fontSize: 12.5 }} value={entityId} onChange={e => changeEntity(e.target.value)}>
                        <option value="">None</option>
                        {entities.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
                      </select>
                    </div>
                  </>
                )}
                {kind === 'template' && (
                  <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                    Default values set here are copied onto every new document created from this template.
                  </div>
                )}

                <div style={{ borderTop: '1px solid var(--line)', paddingTop: 8 }}>
                  <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 6 }}>
                    Field values (overrides the auto-filled value; leave blank to use the auto-filled value)
                  </label>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                    {MERGE_TOKENS.map(t => (
                      <div key={t} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: 11, color: 'var(--muted)', width: 100, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={FRIENDLY_MERGE[t]}>{FRIENDLY_MERGE[t]}</span>
                        <input key={`${t}-${mergeOverrides[t] || ''}`} className="form-input" defaultValue={mergeOverrides[t] || ''}
                          placeholder="auto" style={{ flex: 1, fontSize: 11.5, padding: '4px 7px' }}
                          onBlur={e => setOverrideValue(t, e.target.value)}
                          onKeyDown={e => e.key === 'Enter' && e.target.blur()} />
                      </div>
                    ))}
                  </div>
                </div>

                <div style={{ borderTop: '1px solid var(--line)', paddingTop: 8 }}>
                  <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 6 }}>Custom variables</label>
                  {customVarKeys.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 8 }}>
                      {customVarKeys.map(key => (
                        <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ fontSize: 11, color: 'var(--muted)', width: 100, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={key}>{humanizeKey(key)}</span>
                          <input key={`${key}-${mergeOverrides[key]}`} className="form-input" defaultValue={mergeOverrides[key] || ''}
                            style={{ flex: 1, fontSize: 11.5, padding: '4px 7px' }}
                            onBlur={e => setOverrideValue(key, e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && e.target.blur()} />
                          <button onClick={() => removeOverride(key)} title="Remove variable"
                            style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', display: 'flex', padding: 2 }}>
                            <X size={13} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 5 }}>
                    <input className="form-input" placeholder="variable_name" value={newVarName}
                      onChange={e => setNewVarName(e.target.value)} style={{ flex: 1, fontSize: 11.5, padding: '4px 7px' }} />
                    <input className="form-input" placeholder="Value" value={newVarValue}
                      onChange={e => setNewVarValue(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && addCustomVariable()}
                      style={{ flex: 1, fontSize: 11.5, padding: '4px 7px' }} />
                    <button onClick={addCustomVariable} disabled={!newVarName.trim() || !newVarValue.trim()}
                      style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 6, padding: '4px 8px', cursor: 'pointer', fontSize: 11, fontWeight: 600, opacity: (!newVarName.trim() || !newVarValue.trim()) ? 0.5 : 1 }}>
                      Add
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
        {!preview && (
          <div style={{ position: 'relative' }}>
            <button onClick={() => setImportPopoverOpen(o => !o)} disabled={importing} title="Import Document"
              style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 8, padding: '7px 12px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600, fontFamily: 'Inter, sans-serif', opacity: importing ? 0.6 : 1 }}>
              {importing ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Upload size={14} />} {importing ? 'Importing…' : 'Import'}
            </button>
            {importPopoverOpen && (
              <div style={{ position: 'absolute', top: '110%', left: 0, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, boxShadow: 'var(--shadow-lg)', zIndex: 20, padding: 12, display: 'flex', flexDirection: 'column', gap: 8, minWidth: 260 }}>
                <div style={{ fontSize: 12, fontWeight: 700 }}>Import from Word, PDF, or text</div>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                  .docx keeps full formatting; .pdf imports text only. This replaces the current document body.
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button onClick={() => importInputRef.current?.click()} disabled={importing}
                    style={{ background: 'none', border: '1px dashed var(--line)', borderRadius: 8, padding: '10px 12px', flex: 1, cursor: 'pointer', fontSize: 12, fontWeight: 600, color: 'var(--ink)', display: 'inline-flex', alignItems: 'center', gap: 6, justifyContent: 'center' }}>
                    <Upload size={13} /> Choose file…
                  </button>
                  <button onClick={() => setEgnyteOpen(true)} disabled={importing}
                    style={{ background: 'none', border: '1px dashed var(--line)', borderRadius: 8, padding: '10px 12px', flex: 1, cursor: 'pointer', fontSize: 12, fontWeight: 600, color: 'var(--ink)', display: 'inline-flex', alignItems: 'center', gap: 6, justifyContent: 'center' }}>
                    <Cloud size={13} /> Egnyte…
                  </button>
                </div>
                <input ref={importInputRef} type="file" accept=".docx,.doc,.pdf,.txt" onChange={onPickImportFile} style={{ display: 'none' }} />
                {egnyteOpen && <EgnyteBrowser onPick={onPickEgnyteFile} onClose={() => setEgnyteOpen(false)} />}
              </div>
            )}
          </div>
        )}
        {kind === 'document' && !preview && (
          <button onClick={() => { setPreview(true); openPdfPreview(); }} disabled={pdfPreviewLoading}
            className="primary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, opacity: pdfPreviewLoading ? 0.6 : 1 }}>
            {pdfPreviewLoading ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Send size={14} />} Preview & Send
          </button>
        )}
        {kind === 'document' && preview && (
          <>
            <button onClick={() => window.print()} title="Print"
              style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 8, padding: '7px 12px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600, fontFamily: 'Inter, sans-serif' }}>
              <Printer size={14} /> Print
            </button>
            <button onClick={saveAsTemplate} disabled={savingTemplate} title="Save as Template"
              style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 8, padding: '7px 12px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600, fontFamily: 'Inter, sans-serif', opacity: savingTemplate ? 0.6 : 1 }}>
              {savingTemplate ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <FileStack size={14} />} Save as Template
            </button>
            <button onClick={() => doExport('pdf')} disabled={!!exporting} title="Export PDF"
              style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 8, padding: '7px 12px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600, fontFamily: 'Inter, sans-serif', opacity: exporting ? 0.6 : 1 }}>
              <FileDown size={14} /> {exporting === 'pdf' ? 'Exporting…' : 'Export PDF'}
            </button>
            <button onClick={() => doExport('docx')} disabled={!!exporting} title="Export DOCX"
              style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 8, padding: '7px 12px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600, fontFamily: 'Inter, sans-serif', opacity: exporting ? 0.6 : 1 }}>
              <FileDown size={14} /> {exporting === 'docx' ? 'Exporting…' : 'Export DOCX'}
            </button>
            <button onClick={doSendForSignature} disabled={!!exporting} title="Send for Signature"
              className="primary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, opacity: exporting ? 0.6 : 1 }}>
              <Send size={14} /> {exporting === 'send' ? 'Preparing…' : 'Send for Signature'}
            </button>
            <button onClick={() => { setPreview(false); closePdfPreview(); }} title="Back to Edit"
              style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 8, padding: '7px 12px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600, fontFamily: 'Inter, sans-serif' }}>
              <EyeOff size={14} /> Back to Edit
            </button>
          </>
        )}
        {kind !== 'document' && (
          <button onClick={() => setPreview(p => !p)}
            style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 8, padding: '7px 12px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600, fontFamily: 'Inter, sans-serif' }}>
            {preview ? <EyeOff size={14} /> : <Eye size={14} />} {preview ? 'Edit' : 'Preview'}
          </button>
        )}
        <button onClick={openHistory} title="Version History"
          style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 8, padding: 7, cursor: 'pointer', display: 'flex' }}>
          <History size={16} />
        </button>
      </div>

      {kind === 'document' && preview ? (
        // Real rendered preview (Phase 17) — shows the document exactly as it
        // will download: same backend PDF pipeline as Export PDF, so real
        // pagination and a real page break, not the editor's own WYSIWYG
        // canvas with editing merely disabled (which never looked like a
        // finished document and rendered page breaks as a cosmetic divider).
        // Inline in the page (not a modal) per the same reasoning as the
        // rest of this module's "replace the tab content" convention.
        <div style={{ flex: 1, minHeight: '70vh', display: 'flex', flexDirection: 'column' }}>
          {pdfPreviewLoading ? (
            <div style={{ padding: 60, textAlign: 'center', color: 'var(--muted)' }}><Loader2 size={22} style={{ animation: 'spin 1s linear infinite' }} /></div>
          ) : pdfPreviewUrl ? (
            <iframe title="Document Preview" src={pdfPreviewUrl} style={{ flex: 1, border: '1px solid var(--line)', borderRadius: 8, width: '100%', minHeight: '70vh' }} />
          ) : null}
        </div>
      ) : (
      <>
      {!preview && bodyEditor && (
        <div className="doc-toolbar">
          <div style={{ position: 'relative' }}>
            <ToolbarBtn title="Page Setup" onClick={() => setPageSetupOpen(o => !o)}><FileStack size={15} /></ToolbarBtn>
            {pageSetupOpen && (
              <div style={{ position: 'absolute', top: '110%', left: 0, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, boxShadow: 'var(--shadow-lg)', zIndex: 20, width: 260, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div>
                  <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 4 }}>Page Size</label>
                  <select className="form-input" style={{ width: '100%', fontSize: 12.5 }} value={pageSetup.size}
                    onChange={e => updatePageSetup({ size: e.target.value })}>
                    {PAGE_SIZES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 4 }}>Orientation</label>
                  <select className="form-input" style={{ width: '100%', fontSize: 12.5 }} value={pageSetup.orientation}
                    onChange={e => updatePageSetup({ orientation: e.target.value })}>
                    {ORIENTATIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 4 }}>Margins</label>
                  <select className="form-input" style={{ width: '100%', fontSize: 12.5 }} value={pageSetup.margins}
                    onChange={e => updatePageSetup({ margins: e.target.value })}>
                    {MARGIN_PRESETS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                  </select>
                </div>
                <div style={{ borderTop: '1px solid var(--line)', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label style={{ fontSize: 12.5, display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}>
                    Header <input type="checkbox" checked={headerVisible} onChange={toggleHeader} />
                  </label>
                  <label style={{ fontSize: 12.5, display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}>
                    Footer <input type="checkbox" checked={footerVisible} onChange={toggleFooter} />
                  </label>
                </div>
              </div>
            )}
          </div>
          <span className="doc-toolbar-sep" />
          <ToolbarBtn title="Bold" active={bodyEditor.isActive('bold')} onClick={() => bodyEditor.chain().focus().toggleBold().run()}><Bold size={15} /></ToolbarBtn>
          <ToolbarBtn title="Italic" active={bodyEditor.isActive('italic')} onClick={() => bodyEditor.chain().focus().toggleItalic().run()}><Italic size={15} /></ToolbarBtn>
          <ToolbarBtn title="Underline" active={bodyEditor.isActive('underline')} onClick={() => bodyEditor.chain().focus().toggleUnderline().run()}><Underline size={15} /></ToolbarBtn>
          <span className="doc-toolbar-sep" />
          <select onChange={e => { const v = e.target.value; if (v) bodyEditor.chain().focus().setFontFamily(v).run(); else bodyEditor.chain().focus().unsetFontFamily().run(); }}
            value={bodyEditor.getAttributes('textStyle').fontFamily || ''} title="Font family"
            style={{ fontSize: 12, fontFamily: 'Inter, sans-serif', border: '1px solid var(--line)', borderRadius: 7, padding: '5px 6px', cursor: 'pointer', color: 'var(--ink)', background: 'var(--card)', maxWidth: 116 }}>
            <option value="">Font</option>
            {Object.entries(FONT_GROUPS).map(([group, fonts]) => (
              <optgroup key={group} label={group}>
                {fonts.map(f => <option key={f} value={f}>{f}</option>)}
              </optgroup>
            ))}
          </select>
          <select onChange={e => { const v = e.target.value; if (v) bodyEditor.chain().focus().setFontSize(`${v}px`).run(); else bodyEditor.chain().focus().unsetFontSize().run(); }}
            value={(bodyEditor.getAttributes('textStyle').fontSize || '').replace('px', '')} title="Font size"
            style={{ fontSize: 12, fontFamily: 'Inter, sans-serif', border: '1px solid var(--line)', borderRadius: 7, padding: '5px 6px', cursor: 'pointer', color: 'var(--ink)', background: 'var(--card)', width: 58 }}>
            <option value="">Size</option>
            {FONT_SIZES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <input type="color" title="Text color" value={bodyEditor.getAttributes('textStyle').color || '#111827'}
            onChange={e => bodyEditor.chain().focus().setColor(e.target.value).run()}
            style={{ width: 26, height: 26, padding: 0, border: '1px solid var(--line)', borderRadius: 6, cursor: 'pointer', background: 'none' }} />
          <span className="doc-toolbar-sep" />
          <ToolbarBtn title="Align left" active={bodyEditor.isActive({ textAlign: 'left' })} onClick={() => bodyEditor.chain().focus().setTextAlign('left').run()}><AlignLeft size={15} /></ToolbarBtn>
          <ToolbarBtn title="Align center" active={bodyEditor.isActive({ textAlign: 'center' })} onClick={() => bodyEditor.chain().focus().setTextAlign('center').run()}><AlignCenter size={15} /></ToolbarBtn>
          <ToolbarBtn title="Align right" active={bodyEditor.isActive({ textAlign: 'right' })} onClick={() => bodyEditor.chain().focus().setTextAlign('right').run()}><AlignRight size={15} /></ToolbarBtn>
          <ToolbarBtn title="Justify" active={bodyEditor.isActive({ textAlign: 'justify' })} onClick={() => bodyEditor.chain().focus().setTextAlign('justify').run()}><AlignJustify size={15} /></ToolbarBtn>
          <span className="doc-toolbar-sep" />
          <div style={{ position: 'relative' }}>
            <ToolbarBtn title="Link" active={bodyEditor.isActive('link')} onClick={toggleLinkPopover}><Link2 size={15} /></ToolbarBtn>
            {linkPopoverOpen && (
              <div style={{ position: 'absolute', top: '110%', left: 0, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, boxShadow: 'var(--shadow-lg)', zIndex: 20, padding: 8, display: 'flex', gap: 6, alignItems: 'center' }}>
                <input className="form-input" style={{ fontSize: 12, width: 180 }} placeholder="https://…" value={linkUrlDraft}
                  onChange={e => setLinkUrlDraft(e.target.value)} onKeyDown={e => e.key === 'Enter' && applyLink()} autoFocus />
                <button onClick={applyLink} className="primary-btn" style={{ fontSize: 11.5, padding: '5px 10px' }}>Apply</button>
                {bodyEditor.isActive('link') && (
                  <button onClick={removeLink} title="Remove link" style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 6, padding: 5, cursor: 'pointer', display: 'flex' }}><Link2Off size={13} /></button>
                )}
              </div>
            )}
          </div>
          <span className="doc-toolbar-sep" />
          <ToolbarBtn title="Bullet list" active={bodyEditor.isActive('bulletList')} onClick={() => bodyEditor.chain().focus().toggleBulletList().run()}><List size={15} /></ToolbarBtn>
          <ToolbarBtn title="Numbered list" active={bodyEditor.isActive('orderedList')} onClick={() => bodyEditor.chain().focus().toggleOrderedList().run()}><ListOrdered size={15} /></ToolbarBtn>
          {(bodyEditor.isActive('bulletList') || bodyEditor.isActive('orderedList')) && (
            <>
              <ToolbarBtn title="Decrease indent (outdent)" onClick={() => bodyEditor.chain().focus().liftListItem('listItem').run()}><Outdent size={15} /></ToolbarBtn>
              <ToolbarBtn title="Increase indent (nest under previous item)" onClick={() => bodyEditor.chain().focus().sinkListItem('listItem').run()}><Indent size={15} /></ToolbarBtn>
            </>
          )}
          <span className="doc-toolbar-sep" />
          <ToolbarBtn title="Insert table" onClick={() => bodyEditor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}><TableIcon size={15} /></ToolbarBtn>
          <ToolbarBtn title="Insert image" onClick={() => fileInputRef.current?.click()}><ImagePlus size={15} /></ToolbarBtn>
          <div style={{ position: 'relative' }}>
            <ToolbarBtn title="Insert shape" onClick={() => setShapePopoverOpen(o => !o)}><Shapes size={15} /></ToolbarBtn>
            {shapePopoverOpen && (
              <div style={{ position: 'absolute', top: '110%', left: 0, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, boxShadow: 'var(--shadow-lg)', zIndex: 20, padding: 10, display: 'flex', flexDirection: 'column', gap: 8, minWidth: 200 }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <label style={{ fontSize: 11, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 5 }}>
                    Fill <input type="color" value={shapeFill} onChange={e => setShapeFill(e.target.value)}
                      style={{ width: 22, height: 22, padding: 0, border: '1px solid var(--line)', borderRadius: 5, cursor: 'pointer' }} />
                  </label>
                  <label style={{ fontSize: 11, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 5 }}>
                    Stroke <input type="color" value={shapeStroke} onChange={e => setShapeStroke(e.target.value)}
                      style={{ width: 22, height: 22, padding: 0, border: '1px solid var(--line)', borderRadius: 5, cursor: 'pointer' }} />
                  </label>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {SHAPE_TYPES.map(({ type, label, Icon }) => (
                    <button key={type} title={label} onClick={() => insertShape(type)}
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'none', border: '1px solid var(--line)', borderRadius: 8, width: 32, height: 32, cursor: 'pointer', color: 'var(--ink)' }}>
                      <Icon size={16} />
                    </button>
                  ))}
                </div>
                <label style={{ fontSize: 11, color: 'var(--muted)', display: 'flex', flexDirection: 'column', gap: 3 }}>
                  Text wrap
                  <select value={shapeWrapMode} onChange={e => setShapeWrapMode(e.target.value)}
                    style={{ fontSize: 12, fontFamily: 'Inter, sans-serif', border: '1px solid var(--line)', borderRadius: 7, padding: '5px 6px', cursor: 'pointer', color: 'var(--ink)', background: 'var(--card)' }}>
                    {WRAP_MODES.map(w => <option key={w.value} value={w.value}>{w.label}</option>)}
                  </select>
                </label>
              </div>
            )}
          </div>
          <div style={{ position: 'relative' }}>
            <ToolbarBtn title="Insert text box" onClick={() => setTextboxPopoverOpen(o => !o)}><Type size={15} /></ToolbarBtn>
            {textboxPopoverOpen && (
              <div style={{ position: 'absolute', top: '110%', left: 0, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, boxShadow: 'var(--shadow-lg)', zIndex: 20, padding: 10, display: 'flex', flexDirection: 'column', gap: 8, minWidth: 180 }}>
                <label style={{ fontSize: 11, color: 'var(--muted)', display: 'flex', flexDirection: 'column', gap: 3 }}>
                  Text wrap
                  <select value={textboxWrapMode} onChange={e => setTextboxWrapMode(e.target.value)}
                    style={{ fontSize: 12, fontFamily: 'Inter, sans-serif', border: '1px solid var(--line)', borderRadius: 7, padding: '5px 6px', cursor: 'pointer', color: 'var(--ink)', background: 'var(--card)' }}>
                    {WRAP_MODES.map(w => <option key={w.value} value={w.value}>{w.label}</option>)}
                  </select>
                </label>
                <button onClick={insertTextbox} className="primary-btn" style={{ fontSize: 11.5, padding: '6px 10px' }}>Insert text box</button>
              </div>
            )}
          </div>
          <ToolbarBtn title="Insert page break" onClick={() => bodyEditor.chain().focus().insertContent({ type: 'pageBreak' }).run()}><SeparatorHorizontal size={15} /></ToolbarBtn>
          {kind === 'template' && (
            <ToolbarBtn title="Select text, then click to convert it into a named merge field" onClick={openConvertToMergeField}>
              <Sparkles size={15} />
            </ToolbarBtn>
          )}
          <select onChange={insertMergeField} defaultValue=""
            style={{ fontSize: 12, fontFamily: 'Inter, sans-serif', border: '1px solid var(--line)', borderRadius: 7, padding: '5px 8px', cursor: 'pointer', color: 'var(--ink)', background: 'var(--card)' }}>
            <option value="">✨ Insert auto-filled detail…</option>
            {MERGE_TOKENS.map(t => <option key={t} value={t}>{FRIENDLY_MERGE[t]}</option>)}
            {customVarKeys.length > 0 && (
              <optgroup label="Custom variables">
                {customVarKeys.map(k => <option key={k} value={k}>{humanizeKey(k)}</option>)}
              </optgroup>
            )}
          </select>
          <span className="doc-toolbar-sep" />
          <ToolbarBtn title="Undo" onClick={() => bodyEditor.chain().focus().undo().run()}><Undo size={15} /></ToolbarBtn>
          <ToolbarBtn title="Redo" onClick={() => bodyEditor.chain().focus().redo().run()}><Redo size={15} /></ToolbarBtn>
          <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/gif,image/webp" onChange={onPickImage} style={{ display: 'none' }} />
        </div>
      )}

      {/* Contextual toolbars — appear only while the cursor/selection is
          inside the relevant node, mirroring Word's "click a table/picture/
          shape and its own ribbon shows up" behavior instead of cluttering
          the main toolbar with buttons that only apply some of the time. */}
      {!preview && bodyEditor?.isActive('table') && (
        <div className="doc-toolbar" style={{ marginTop: -8 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', paddingLeft: 4 }}>Table:</span>
          <ToolbarBtn title="Add row above" onClick={() => bodyEditor.chain().focus().addRowBefore().run()}><Rows size={15} /><span style={{ fontSize: 10 }}>↑+</span></ToolbarBtn>
          <ToolbarBtn title="Add row below" onClick={() => bodyEditor.chain().focus().addRowAfter().run()}><Rows size={15} /><span style={{ fontSize: 10 }}>↓+</span></ToolbarBtn>
          <ToolbarBtn title="Delete row" onClick={() => bodyEditor.chain().focus().deleteRow().run()}><Rows size={15} /><Trash2 size={11} /></ToolbarBtn>
          <span className="doc-toolbar-sep" />
          <ToolbarBtn title="Add column left" onClick={() => bodyEditor.chain().focus().addColumnBefore().run()}><Columns size={15} /><span style={{ fontSize: 10 }}>←+</span></ToolbarBtn>
          <ToolbarBtn title="Add column right" onClick={() => bodyEditor.chain().focus().addColumnAfter().run()}><Columns size={15} /><span style={{ fontSize: 10 }}>→+</span></ToolbarBtn>
          <ToolbarBtn title="Delete column" onClick={() => bodyEditor.chain().focus().deleteColumn().run()}><Columns size={15} /><Trash2 size={11} /></ToolbarBtn>
          <span className="doc-toolbar-sep" />
          <ToolbarBtn title="Merge cells" onClick={() => bodyEditor.chain().focus().mergeCells().run()}><Combine size={15} /></ToolbarBtn>
          <ToolbarBtn title="Split cell" onClick={() => bodyEditor.chain().focus().splitCell().run()}><SquareSplitHorizontal size={15} /></ToolbarBtn>
          <ToolbarBtn title="Toggle header row" active={bodyEditor.isActive('tableHeader')} onClick={() => bodyEditor.chain().focus().toggleHeaderRow().run()}>H</ToolbarBtn>
          <span className="doc-toolbar-sep" />
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--muted)' }} title="Shade the current cell">
            Shade
            <input type="color" defaultValue="#f3f4f6"
              onChange={(e) => {
                const attrName = bodyEditor.isActive('tableHeader') ? 'tableHeader' : 'tableCell';
                bodyEditor.chain().focus().updateAttributes(attrName, { backgroundColor: e.target.value }).run();
              }}
              style={{ width: 22, height: 22, padding: 0, border: '1px solid var(--line)', borderRadius: 5, cursor: 'pointer' }} />
          </label>
          <ToolbarBtn title="Delete table" onClick={() => bodyEditor.chain().focus().deleteTable().run()}><Trash2 size={15} /></ToolbarBtn>
        </div>
      )}

      {!preview && (bodyEditor?.isActive('docShape') || bodyEditor?.isActive('docTextbox') || bodyEditor?.isActive('image')) && (
        <div className="doc-toolbar" style={{ marginTop: -8 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', paddingLeft: 4 }}>
            {bodyEditor.isActive('docShape') ? 'Shape:' : bodyEditor.isActive('docTextbox') ? 'Text box:' : 'Image:'}
          </span>
          {(() => {
            const type = bodyEditor.isActive('docShape') ? 'docShape' : bodyEditor.isActive('docTextbox') ? 'docTextbox' : 'image';
            const attrs = bodyEditor.getAttributes(type);
            const rotate = (delta) => bodyEditor.chain().focus().updateAttributes(type, { rotation: ((attrs.rotation || 0) + delta + 360) % 360 }).run();
            return (
              <>
                <label style={{ fontSize: 11, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  Wrap
                  <select value={attrs.wrapMode || 'inline'} onChange={(e) => bodyEditor.chain().focus().updateAttributes(type, { wrapMode: e.target.value }).run()}
                    style={{ fontSize: 12, fontFamily: 'Inter, sans-serif', border: '1px solid var(--line)', borderRadius: 7, padding: '4px 6px', cursor: 'pointer', color: 'var(--ink)', background: 'var(--card)' }}>
                    {WRAP_MODES.map(w => <option key={w.value} value={w.value}>{w.label}</option>)}
                  </select>
                </label>
                <ToolbarBtn title="Rotate left 90°" onClick={() => rotate(-90)}><RotateCcw size={15} /></ToolbarBtn>
                <ToolbarBtn title="Rotate right 90°" onClick={() => rotate(90)}><RotateCw size={15} /></ToolbarBtn>
                {type === 'docShape' && (
                  <>
                    <label style={{ fontSize: 11, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      Fill <input type="color" value={attrs.fillColor || '#dbeafe'} onChange={(e) => bodyEditor.chain().focus().updateAttributes('docShape', { fillColor: e.target.value }).run()}
                        style={{ width: 22, height: 22, padding: 0, border: '1px solid var(--line)', borderRadius: 5, cursor: 'pointer' }} />
                    </label>
                    <label style={{ fontSize: 11, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      Stroke <input type="color" value={attrs.strokeColor || '#2563eb'} onChange={(e) => bodyEditor.chain().focus().updateAttributes('docShape', { strokeColor: e.target.value }).run()}
                        style={{ width: 22, height: 22, padding: 0, border: '1px solid var(--line)', borderRadius: 5, cursor: 'pointer' }} />
                    </label>
                  </>
                )}
                {type === 'docTextbox' && (
                  <>
                    <label style={{ fontSize: 11, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      Border <input type="color" value={attrs.borderColor || '#9ca3af'} onChange={(e) => bodyEditor.chain().focus().updateAttributes('docTextbox', { borderColor: e.target.value }).run()}
                        style={{ width: 22, height: 22, padding: 0, border: '1px solid var(--line)', borderRadius: 5, cursor: 'pointer' }} />
                    </label>
                    <label style={{ fontSize: 11, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      Fill <input type="color" value={attrs.fillColor && attrs.fillColor !== 'transparent' ? attrs.fillColor : '#ffffff'}
                        onChange={(e) => bodyEditor.chain().focus().updateAttributes('docTextbox', { fillColor: e.target.value }).run()}
                        style={{ width: 22, height: 22, padding: 0, border: '1px solid var(--line)', borderRadius: 5, cursor: 'pointer' }} />
                    </label>
                  </>
                )}
                {type === 'image' && (
                  <label style={{ fontSize: 11, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 4, flex: 1, minWidth: 140 }}>
                    Alt text
                    <input value={attrs.alt || ''} placeholder="Describe this image…"
                      onChange={(e) => bodyEditor.chain().focus().updateAttributes('image', { alt: e.target.value }).run()}
                      style={{ flex: 1, fontSize: 12, border: '1px solid var(--line)', borderRadius: 7, padding: '4px 7px', color: 'var(--ink)', background: 'var(--card)' }} />
                  </label>
                )}
              </>
            );
          })()}
        </div>
      )}

      {!preview && !headerVisible && (
        <button onClick={() => setHeaderVisible(true)}
          style={{ background: 'none', border: 'none', color: 'var(--muted)', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', marginBottom: 6 }}>+ Add header</button>
      )}

      <div className="doc-page" style={{ display: 'flex', flexDirection: 'column', ...pageCanvasStyle(pageSetup) }}>
        {activeLetterhead && (
          <div>
            {activeLetterhead.headerJson?.text && (
              <div className="doc-letterhead-tagline">{activeLetterhead.headerJson.text}</div>
            )}
            <div className="doc-letterhead">
              {activeLetterhead.logoPath && <img src={activeLetterhead.logoPath} alt={activeLetterhead.name} />}
              <div>
                <div className="doc-letterhead-name">{activeLetterhead.name}</div>
                {activeLetterhead.address && <div className="doc-letterhead-address">{activeLetterhead.address}</div>}
              </div>
            </div>
            {activeLetterhead.footerJson?.text && (
              <div className="doc-letterhead-tagline" style={{ marginTop: -10, marginBottom: 12 }}>{activeLetterhead.footerJson.text}</div>
            )}
          </div>
        )}
        {headerVisible && (
          <div className="doc-band">
            {!preview && (
              <button onClick={() => { setHeaderVisible(false); headerEditor?.commands.clearContent(); scheduleSave(); }}
                style={{ float: 'right', background: 'none', border: 'none', color: 'var(--muted)', fontSize: 10.5, cursor: 'pointer' }}>Remove header</button>
            )}
            <EditorContent editor={headerEditor} className="doc-editor" onPaste={onBodyPaste} />
          </div>
        )}

        {/* flex:1 so the body fills whatever space is left between header and
            footer up to the page's minHeight — without this the footer
            followed the body directly in document flow and left a bare gap
            below it whenever the body was short. */}
        <div style={{ flex: 1 }}>
          <EditorContent editor={bodyEditor} className="doc-editor" onPaste={onBodyPaste} />
        </div>

        {footerVisible && (
          <div className="doc-band doc-footer">
            {!preview && (
              <button onClick={() => { setFooterVisible(false); footerEditor?.commands.clearContent(); scheduleSave(); }}
                style={{ float: 'right', background: 'none', border: 'none', color: 'var(--muted)', fontSize: 10.5, cursor: 'pointer' }}>Remove footer</button>
            )}
            <EditorContent editor={footerEditor} className="doc-editor" />
          </div>
        )}
      </div>

      {!preview && !footerVisible && (
        <button onClick={() => setFooterVisible(true)}
          style={{ background: 'none', border: 'none', color: 'var(--muted)', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', marginTop: 6 }}>+ Add footer</button>
      )}
      </>
      )}

      {historyOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
          onClick={() => setHistoryOpen(false)}>
          <div style={{ background: 'var(--card)', borderRadius: 16, width: '100%', maxWidth: 480, maxHeight: '80vh', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)' }}
            onClick={e => e.stopPropagation()}>
            <div style={{ padding: '18px 20px', borderBottom: '1px solid var(--line)', fontSize: 15, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}>
              <History size={16} /> Version History
            </div>
            <div style={{ padding: 12, overflowY: 'auto', flex: 1 }}>
              {!versions ? (
                <div style={{ padding: 30, textAlign: 'center', color: 'var(--muted)' }}><Loader2 size={20} style={{ animation: 'spin 1s linear infinite' }} /></div>
              ) : versions.length === 0 ? (
                <div style={{ padding: '20px 8px', color: 'var(--muted)', fontSize: 12.5 }}>No saved versions yet.</div>
              ) : versions.map((v, i) => (
                <div key={v.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 8px', borderBottom: '1px solid var(--line)' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 700 }}>Version {v.versionNo}{i === 0 && <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 800, color: 'hsl(var(--color-green))' }}>CURRENT</span>}</div>
                    <div style={{ fontSize: 11, color: 'var(--muted)' }}>{v.editedBy} · {(v.editedAt || '').slice(0, 16).replace('T', ' ')}{v.note ? ` · ${v.note}` : ''}</div>
                  </div>
                  {i !== 0 && (
                    <button onClick={() => restoreVersion(v)} disabled={!!restoringId}
                      style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 8, padding: '6px 10px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 600, opacity: restoringId ? 0.6 : 1 }}>
                      {restoringId === v.id ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <RotateCcw size={12} />} Restore
                    </button>
                  )}
                </div>
              ))}
            </div>
            <div style={{ padding: '12px 20px', borderTop: '1px solid var(--line)', display: 'flex', justifyContent: 'flex-end' }}>
              <button onClick={() => setHistoryOpen(false)} style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 8, padding: '8px 16px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>Close</button>
            </div>
          </div>
        </div>
      )}

      {mergeFieldModal && (
        <DefineMergeFieldModal
          initialLabel={mergeFieldModal.initialLabel}
          existingDef={mergeFieldModal.existingDef}
          existingTokens={fieldDefs.map((f) => f.token)}
          onSave={saveMergeFieldDef}
          onCancel={() => setMergeFieldModal(null)}
        />
      )}
    </div>
  );
}

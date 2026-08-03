import { useEffect, useRef, useState, useCallback } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import { generateJSON, generateHTML } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import {
  X, Loader2, Eye, EyeOff, Bold, Italic, Underline, List, ListOrdered,
  Table as TableIcon, ImagePlus, SeparatorHorizontal, Undo, Redo, Check, AlertCircle, Award,
  Users, FileDown, Printer, Send, History, RotateCcw,
  AlignLeft, AlignCenter, AlignRight, AlignJustify, Link2, Link2Off, FileSearch,
  Shapes, Square, Circle, Minus, Triangle, ArrowRight, Type, Upload, Cloud, Sparkles, FileStack,
  Indent, Outdent, RotateCw, Rows, Columns, Combine, SquareSplitHorizontal, Trash2, Plus,
  Copy, MoreVertical, FileText as PageIcon, Pilcrow, PaintBucket,
  Paintbrush, Search, Smile, Bookmark,
  Scissors, ClipboardCopy, ClipboardPaste, Strikethrough, Subscript as SubscriptIcon, Superscript as SuperscriptIcon,
  Highlighter, ArrowDownAZ, ArrowUpZA, RectangleHorizontal, MousePointerSquareDashed, ListTree,
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
const SYMBOL_CHARS = ['©', '®', '™', '°', '±', '×', '÷', '•', '…', '–', '—', '§', '¶', '†', '‡', '∞', '√', '≈', '≠', '≤', '≥', '€', '£', '¥', '¢', '½', '¼', '¾', 'α', 'β', 'π', 'Ω', '→', '←', '↑', '↓'];
const EMOJI_CHARS = ['😀', '😂', '😊', '😍', '🙌', '👍', '👎', '🙏', '🎉', '🔥', '✅', '❌', '⚠️', '💡', '📌', '📎', '📅', '⏰', '💬', '📧', '🚀', '⭐', '❤️', '👀', '🤔', '😅', '🙂', '🎯', '📈', '📉'];
const SHAPE_TYPES = [
  { type: 'rectangle', label: 'Rectangle', Icon: Square },
  { type: 'circle', label: 'Circle', Icon: Circle },
  { type: 'line', label: 'Line', Icon: Minus },
  { type: 'triangle', label: 'Triangle', Icon: Triangle },
  { type: 'arrow', label: 'Arrow', Icon: ArrowRight },
];

// ── Document Builder (Phase 2, generalized for Templates in Phase 3) ────────
// Rich-text editor shared by Documents AND DocTemplates - both store the same
// content shape, so `kind` ('document'|'template') just swaps which API calls
// load/save it and which field holds the display name (title vs name).
// Opened in-place (same "replace the tab content" convention ESign.jsx uses
// for SignModal/SendWizard - a plain early return, not a portal/overlay).
// content shape: { body: <TipTap JSON>, header: <TipTap JSON|null>,
// footer: <TipTap JSON|null> }. Phase 1 drafts have content: {} - treated as
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

const genPageId = () => 'pg_' + Math.random().toString(36).slice(2, 10);
// Backward compat: a document saved before pages were real, independent
// units has content.body - one continuous TipTap doc with pageBreak nodes as
// manual dividers. Split it into real pages once, on load, so an old
// document upgrades cleanly instead of the app needing to understand two
// content shapes forever.
function splitBodyIntoPages(bodyJson) {
  const nodes = bodyJson?.content || [];
  const segs = [[]];
  for (const n of nodes) {
    if (n.type === 'pageBreak') segs.push([]);
    else segs[segs.length - 1].push(n);
  }
  return segs.map(content => ({ id: genPageId(), json: { type: 'doc', content } }));
}
// "Format only" duplication - strips actual content (text, images, shapes,
// textboxes, merge fields) but keeps every structural node as-is: heading
// levels, table row/column counts and cell shading, list type. The only
// thing "format, not content" can honestly mean without a separate per-page
// layout concept.
const STRIP_AS_CONTENT = new Set(['image', 'docShape', 'docTextbox', 'mergeField']);
function stripToFormat(nodes) {
  const out = [];
  for (const n of nodes) {
    if (n.type === 'text' || STRIP_AS_CONTENT.has(n.type)) continue;
    const clone = { type: n.type };
    if (n.attrs) clone.attrs = { ...n.attrs };
    if (Array.isArray(n.content)) {
      const inner = stripToFormat(n.content);
      if (inner.length) clone.content = inner;
    }
    out.push(clone);
  }
  return out;
}

// One genuinely independent page = one TipTap editor instance bound to its
// own page-shaped sheet, matching how Canva/Slides/PowerPoint actually work
// (manually-paginated, independent canvases - none of them auto-reflow
// content across pages either; that needs a custom layout/measurement engine
// no browser gives you for free, which is why Google Docs/Word Online had to
// build one from scratch). A hook can't be called conditionally/dynamically
// inside the parent's render, so each page is its own component instance -
// that's the actual reason this is split out, not just organization.
function DocPage({ pageId, pageNumber, pageCount, docTitle, initialJson, editable, pageSetup, showMarks, onReady, onUpdate, onActivity, onPaste, onTocClick }) {
  const editor = useEditor({
    extensions: [...BODY_EXTENSIONS, Placeholder.configure({ placeholder: 'Start typing your document…' })],
    content: initialJson || null,
    editable,
    onUpdate: () => onUpdate(),
    onSelectionUpdate: () => onActivity(pageId),
  });
  useEffect(() => {
    if (!editor) return;
    onReady(pageId, editor);
    return () => onReady(pageId, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);
  useEffect(() => { editor?.setEditable(editable); }, [editable, editor]);
  const border = pageSetup.pageBorder;
  return (
    <div className={`doc-page${pageSetup.lineNumbers ? ' doc-line-numbers' : ''}`}
      style={{
        display: 'flex', flexDirection: 'column', margin: '0 auto 28px', ...pageCanvasStyle(pageSetup),
        background: pageSetup.pageColor || '#fff',
        border: border?.style ? `${border.width || 1}px ${border.style} ${border.color || '#111827'}` : undefined,
      }}
      onFocus={() => onActivity(pageId)}
      onClick={(e) => {
        const link = e.target.closest && e.target.closest('a[href^="#toc:"]');
        if (link) { e.preventDefault(); onTocClick(link.getAttribute('href')); return; }
        onActivity(pageId);
      }}>
      <div style={{ flex: 1, columnCount: pageSetup.columns > 1 ? pageSetup.columns : undefined, columnGap: pageSetup.columns > 1 ? 32 : undefined }}>
        <EditorContent editor={editor} className={`doc-editor${showMarks ? ' show-marks' : ''}`} onPaste={(e) => onPaste(pageId, e)} />
      </div>
      {/* A running footer on every page, on by default - title left, page
          number right, the standard document-footer layout. Purely a
          display row (not part of the editable doc/TipTap content) - each
          page's own index/count IS the real page number now that pages are
          true independent units, no separate counter to keep in sync, and
          the title is plain text (not an editor), so unlike the optional
          custom footer below, this CAN genuinely repeat on every page. */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, fontSize: 10.5, color: '#9ca3af', marginTop: 10, paddingTop: 8, borderTop: '1px solid #eceef1', userSelect: 'none' }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{docTitle}</span>
        <span style={{ flex: '0 0 auto' }}>Page {pageNumber} of {pageCount}</span>
      </div>
    </div>
  );
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

export default function DocumentBuilder({ docId, kind = 'document', employees = [], entities = [], onClose, toastOk, toastErr, quickSections = [], onContentSaved }) {
  const { get: apiGet, update: apiUpdate, nameKey, getVersions, getVersion } = KIND_API[kind];
  const [doc, setDoc] = useState(null);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState('');
  const [preview, setPreview] = useState(false);
  const [showMarks, setShowMarks] = useState(false); // Word's "Show/Hide ¶" - CSS-only, view preference not saved with the doc
  // Word-style ribbon tabs (Home/Insert/Layout - Phase 18). References/Review/
  // View/Help aren't built - Comments, Equation Editor, and Table of Contents
  // are real subsystems (data model + UI of their own), not toolbar buttons,
  // and were explicitly deferred to their own pass.
  const [ribbonTab, setRibbonTab] = useState('home');
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [replaceQuery, setReplaceQuery] = useState('');
  const [findMatches, setFindMatches] = useState([]); // [{pageId, from, to}]
  const [findIndex, setFindIndex] = useState(-1);
  const formatPainterRef = useRef(null); // captured marks while "painting", or null when off
  const [painterActive, setPainterActive] = useState(false);
  const [bookmarkPopoverOpen, setBookmarkPopoverOpen] = useState(false);
  const [newBookmarkName, setNewBookmarkName] = useState('');
  const [symbolPopoverOpen, setSymbolPopoverOpen] = useState(false);
  const [symbolTab, setSymbolTab] = useState('symbols'); // 'symbols' | 'emoji'
  const [saveStatus, setSaveStatus] = useState('idle');
  const [headerVisible, setHeaderVisible] = useState(false);
  const [footerVisible, setFooterVisible] = useState(false);
  const [letterheads, setLetterheads] = useState([]);
  const [letterheadId, setLetterheadId] = useState('');
  const [requiresLetterhead, setRequiresLetterhead] = useState(false);
  const [lhPickerOpen, setLhPickerOpen] = useState(false);
  // Add-a-letterhead (any user, not just admins - see routers/documents.py
  // create_letterhead) - a small inline form inside the same dropdown rather
  // than a separate admin screen, so a custom letterhead is one click away
  // right where you'd reach for it.
  const [newLhOpen, setNewLhOpen] = useState(false);
  const [newLhBusy, setNewLhBusy] = useState(false);
  const [newLhName, setNewLhName] = useState('');
  const [newLhAddress, setNewLhAddress] = useState('');
  const [newLhLogoUrl, setNewLhLogoUrl] = useState('');
  const [newLhLogoBusy, setNewLhLogoBusy] = useState(false);
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
  // Template Builder (Phase 13) - field_defs is the single source of truth for
  // a merge field's type/required/default/validation; only meaningful when
  // kind==='template' (Documents generated from one just carry resolved
  // values, not the field metadata itself).
  const [fieldDefs, setFieldDefs] = useState([]);
  const [mergeFieldModal, setMergeFieldModal] = useState(null); // null | { range?: {from,to}, existingDef?: object, initialLabel?: string }
  // Page Setup (Phase 14) - content.pageSetup, a sibling of body/header/footer
  // in the same JSON blob (no schema change needed).
  const [pageSetup, setPageSetup] = useState(DEFAULT_PAGE_SETUP);
  const [pageSetupOpen, setPageSetupOpen] = useState(false);
  // Pages (each a real independent editor instance - see DocPage above).
  // `pages` only tracks existence/order/the seed content a freshly
  // added/duplicated page mounts with; once a page's DocPage has mounted,
  // its live TipTap editor (in editorsRef) is the source of truth for its
  // content, not this array. activePageId is whichever page most recently
  // had focus/a selection change - toolbar commands and contextual "is X
  // active" checks all route through it.
  const [pages, setPages] = useState([]);
  const [activePageId, setActivePageId] = useState('');
  const editorsRef = useRef(new Map()); // pageId -> live TipTap editor
  const pendingFocusId = useRef(''); // page just added/duplicated - focus+scroll to it once its editor registers
  const [pageMenuOpen, setPageMenuOpen] = useState(''); // page id whose "..." menu is open, or ''
  const saveTimer = useRef(null);
  const fileInputRef = useRef(null);
  const importInputRef = useRef(null);
  // Guards against a real data-loss bug for header/footer (still single
  // shared editors, unlike the pages): onUpdate (and therefore autosave)
  // must never fire before real content has actually been pushed into them.
  // Without this, an update event that slips through during the async load
  // window (Ctrl+S, a stray transaction, a fast remount) saves the editor's
  // still-EMPTY default doc and silently overwrites real content. Flips true
  // only at the end of a successful load/applyContent below. Pages don't
  // need this - each one is CREATED with its real content already in place
  // (useEditor's `content` option), never hydrated via a later setContent
  // call, so there's no empty-then-filled window for them to leak through.
  const hydratedRef = useRef(false);
  // Bumped whenever any page's selection changes, or a page
  // registers/unregisters, so the contextual Table/Shape/Textbox/Image
  // toolbars and the Pages panel (which read the active editor's state at
  // render time) actually re-render - TipTap's own state changes don't
  // trigger a React re-render on their own.
  const [, setSelectionTick] = useState(0);

  // Native scrollIntoView on the page's own sheet, not TipTap's
  // scrollIntoView option - that one asks ProseMirror to walk up looking for
  // a scrollable ancestor, which is a heuristic that doesn't reliably find
  // this app's actual scroll container. Element.scrollIntoView() is the
  // browser doing it directly, no heuristics involved.
  // .focus() on a contenteditable triggers the browser's OWN native
  // "scroll the caret into view" - a tiny, minimal-effort scroll that just
  // barely reveals the cursor line, and it can fire after (overriding) a
  // scrollIntoView called in the same tick since TipTap applies the focus
  // transaction's DOM update on the next frame. Deferring this call to the
  // frame after focus (rAF) lets it run last and actually win, and
  // block:'center' shows the page's surrounding context instead of just
  // scraping the top edge into view.
  const goToPage = useCallback((pageId, cursorPos = 'start') => {
    const ed = editorsRef.current.get(pageId);
    if (!ed) return;
    ed.commands.focus(cursorPos);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        ed.view.dom.closest('.doc-page')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    });
  }, []);
  const registerPageEditor = useCallback((pageId, editor) => {
    if (editor) {
      editorsRef.current.set(pageId, editor);
      if (pendingFocusId.current === pageId) {
        pendingFocusId.current = '';
        goToPage(pageId, 'end');
      }
    } else {
      editorsRef.current.delete(pageId);
    }
    setSelectionTick((t) => t + 1);
  }, [goToPage]);
  const onPageUpdate = useCallback(() => { scheduleSave(); setSelectionTick((t) => t + 1); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const onPageActivity = useCallback((pageId) => {
    setActivePageId(pageId);
    setSelectionTick((t) => t + 1);
    // Format Painter: a non-empty selection made anywhere while "painting"
    // is armed gets the captured marks applied, then the painter turns off -
    // same one-shot behavior as Word's paintbrush.
    const marks = formatPainterRef.current;
    const ed = editorsRef.current.get(pageId);
    if (marks && ed && !ed.state.selection.empty) {
      let chain = ed.chain().focus();
      chain = marks.bold ? chain.setBold() : chain.unsetBold();
      chain = marks.italic ? chain.setItalic() : chain.unsetItalic();
      chain = marks.underline ? chain.setUnderline() : chain.unsetUnderline();
      if (marks.color) chain = chain.setColor(marks.color);
      if (marks.fontFamily) chain = chain.setFontFamily(marks.fontFamily);
      if (marks.fontSize) chain = chain.setFontSize(marks.fontSize);
      chain.run();
      formatPainterRef.current = null;
      setPainterActive(false);
    }
  }, []);
  const activeEditor = editorsRef.current.get(activePageId);

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

  // Pushes a { pages, header, footer } content object into place - shared by
  // the initial load below AND by History's "Restore", so hydration only has
  // one implementation. Setting `pages` with fresh ids remounts every DocPage
  // (React key-based), so restoring an old version that had a different page
  // count is exactly "throw away the current pages, mount new ones" - no
  // stale per-page editor state can bleed through.
  const applyContent = useCallback((content) => {
    const c = content && typeof content === 'object' ? content : {};
    const pageList = Array.isArray(c.pages) && c.pages.length
      ? c.pages.map(p => ({ id: p.id || genPageId(), json: p.json || null }))
      : splitBodyIntoPages(c.body); // backward compat with pre-rewrite documents
    editorsRef.current = new Map();
    setPages(pageList);
    setActivePageId(pageList[0]?.id || '');
    if (c.header) { setHeaderVisible(true); headerEditor?.commands.setContent(c.header, { emitUpdate: false }); }
    else { setHeaderVisible(false); headerEditor?.commands.clearContent(); }
    if (c.footer) { setFooterVisible(true); footerEditor?.commands.setContent(c.footer, { emitUpdate: false }); }
    else { setFooterVisible(false); footerEditor?.commands.clearContent(); }
  }, [headerEditor, footerEditor]);

  // Load the document once. Pages mount themselves with their real content
  // already in place (no separate hydration push needed - see DocPage).
  useEffect(() => {
    let cancelled = false;
    hydratedRef.current = false; // re-arm the header/footer guard whenever those editor instances change
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
  }, [docId, headerEditor, footerEditor]);

  useEffect(() => { api.getDocLetterheads().then(setLetterheads).catch(() => setLetterheads([])); }, []);

  useEffect(() => {
    headerEditor?.setEditable(!preview);
    footerEditor?.setEditable(!preview);
  }, [preview, headerEditor, footerEditor]);

  const currentContent = useCallback(() => ({
    pages: pages.map(p => {
      const ed = editorsRef.current.get(p.id);
      return { id: p.id, json: ed ? ed.getJSON() : (p.json || { type: 'doc', content: [] }) };
    }),
    header: headerVisible ? (headerEditor?.getJSON() ?? null) : null,
    footer: footerVisible ? (footerEditor?.getJSON() ?? null) : null,
    pageSetup,
  }), [pages, headerEditor, footerEditor, headerVisible, footerVisible, pageSetup]);

  // Page Setup panel changes save immediately (like the letterhead/employee
  // pickers) rather than going through the debounced content autosave -
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
      .then(() => { setSaveStatus('saved'); onContentSaved?.(payload.content); })
      .catch(() => setSaveStatus('error'));
  }, [docId, currentContent, kind, apiUpdate, onContentSaved]);

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
    // - the two are easy to conflate since both sit in the same top-left
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

  const uploadLhLogo = async (file) => {
    setNewLhLogoBusy(true);
    try {
      const path = `letterheads/${Date.now()}-${safeName(file.name)}`;
      const { url, error } = await uploadToSupabase(file, 'document-images', path);
      if (error) { toastErr?.(error); return; }
      setNewLhLogoUrl(url);
    } finally { setNewLhLogoBusy(false); }
  };

  const createLetterhead = async () => {
    if (!newLhName.trim()) { toastErr?.('Give the letterhead a name'); return; }
    setNewLhBusy(true);
    try {
      const created = await api.createDocLetterhead({ name: newLhName.trim(), logoPath: newLhLogoUrl, address: newLhAddress.trim() });
      setLetterheads(prev => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
      setNewLhOpen(false); setNewLhName(''); setNewLhAddress(''); setNewLhLogoUrl('');
      changeLetterhead(created.id);
      toastOk?.('Letterhead added');
    } catch (e) { toastErr?.(e.message || 'Failed to create letterhead'); }
    finally { setNewLhBusy(false); }
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
  // is a flat, document-scoped dict - persistent regardless of which
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

  // In-app PDF Preview - renders the exported PDF in an iframe (browsers have
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
    if (url) activeEditor?.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
    setLinkPopoverOpen(false); setLinkUrlDraft('');
  };

  // Word's Paragraph group: Increase/Decrease Indent works on ANY paragraph,
  // not just list items - inside a list it still sinks/lifts the list item
  // (existing, correct behavior), otherwise it steps a plain paragraph's own
  // indent level (0-8, ~24px each) via the attribute added in
  // docBuilderSchema.js.
  const currentBlockType = () => (activeEditor?.isActive('heading') ? 'heading' : 'paragraph');
  const changeIndent = (delta) => {
    if (!activeEditor) return;
    if (activeEditor.isActive('bulletList') || activeEditor.isActive('orderedList')) {
      activeEditor.chain().focus()[delta > 0 ? 'sinkListItem' : 'liftListItem']('listItem').run();
      return;
    }
    const type = currentBlockType();
    const current = activeEditor.getAttributes(type).indent || 0;
    const next = Math.max(0, Math.min(8, current + delta));
    activeEditor.chain().focus().updateAttributes(type, { indent: next }).run();
  };
  const setLineHeight = (value) => {
    if (!activeEditor) return;
    activeEditor.chain().focus().updateAttributes(currentBlockType(), { lineHeight: value || null }).run();
  };
  const setParagraphShading = (color) => {
    if (!activeEditor) return;
    activeEditor.chain().focus().updateAttributes(currentBlockType(), { backgroundColor: color || null }).run();
  };

  // Word's Home > Styles quick gallery - one click sets both the semantic
  // block type and its look, same as clicking "Heading 1" in Word.
  const applyStyle = (style) => {
    if (!activeEditor) return;
    if (style === 'normal') activeEditor.chain().focus().setParagraph().run();
    else activeEditor.chain().focus().setHeading({ level: style }).run();
  };

  // Word's Home > Clipboard > Format Painter - click to capture the current
  // selection's formatting, then the NEXT selection made anywhere in the
  // document gets it applied (handled in onPageActivity below, since that's
  // already the one place every page's selection change is routed through).
  const PAINTABLE_MARKS = ['bold', 'italic', 'underline'];
  const toggleFormatPainter = () => {
    if (painterActive) { formatPainterRef.current = null; setPainterActive(false); return; }
    if (!activeEditor) return;
    const marks = {};
    PAINTABLE_MARKS.forEach(m => { marks[m] = activeEditor.isActive(m); });
    const ts = activeEditor.getAttributes('textStyle');
    if (ts.color) marks.color = ts.color;
    if (ts.fontFamily) marks.fontFamily = ts.fontFamily;
    if (ts.fontSize) marks.fontSize = ts.fontSize;
    formatPainterRef.current = marks;
    setPainterActive(true);
  };

  // Word's Home > Clipboard > Cut/Copy/Paste - the editor is a native
  // contenteditable so Ctrl+X/C/V already work without any button; these
  // exist for mouse-only users, same as Word's own toolbar buttons.
  const clipboardAction = (cmd) => { activeEditor?.chain().focus(); document.execCommand(cmd); };

  // Word's Home > Font > Grow/Shrink Font - steps the current selection's
  // font size through FONT_SIZES, defaulting from 12 if none is set yet.
  const stepFontSize = (delta) => {
    if (!activeEditor) return;
    const current = parseInt(activeEditor.getAttributes('textStyle').fontSize || '12', 10);
    const idx = FONT_SIZES.findIndex(s => Number(s) >= current);
    const nextIdx = Math.max(0, Math.min(FONT_SIZES.length - 1, (idx === -1 ? FONT_SIZES.length - 1 : idx) + delta));
    activeEditor.chain().focus().setFontSize(`${FONT_SIZES[nextIdx]}px`).run();
  };

  // Word's Home > Font > Change Case. ProseMirror has no "transform selected
  // text in place, keep the marks" command, so this reads the plain text,
  // transforms it, and replaces the range - same low-level insertText
  // approach Find & Replace uses. Marks already on that text (bold, color,
  // etc.) are unaffected since insertText only swaps the character content.
  const changeCase = (mode) => {
    if (!activeEditor) return;
    const { from, to, empty } = activeEditor.state.selection;
    if (empty) return;
    const text = activeEditor.state.doc.textBetween(from, to, '\n');
    let out = text;
    if (mode === 'upper') out = text.toUpperCase();
    else if (mode === 'lower') out = text.toLowerCase();
    else if (mode === 'title') out = text.replace(/\w\S*/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase());
    else if (mode === 'sentence') out = text.toLowerCase().replace(/(^\s*\w|[.!?]\s*\w)/g, c => c.toUpperCase());
    activeEditor.view.dispatch(activeEditor.state.tr.insertText(out, from, to));
  };

  // Word's Home > Paragraph > Sort - alphabetizes the list items (or plain
  // paragraphs) in the current selection. Reorders the actual nodes via a
  // transaction rather than just their text, so nested formatting inside
  // each item travels with it.
  const sortSelection = (dir) => {
    if (!activeEditor) return;
    const { $from } = activeEditor.state.selection;
    let depth = -1;
    for (let d = $from.depth; d > 0; d--) {
      if (['bulletList', 'orderedList'].includes($from.node(d).type.name)) { depth = d; break; }
    }
    if (depth === -1) return;
    const listNode = $from.node(depth);
    const listStart = $from.before(depth) + 1;
    const items = [];
    listNode.forEach(child => items.push(child));
    const sorted = [...items].sort((a, b) => {
      const cmp = a.textContent.localeCompare(b.textContent);
      return dir === 'desc' ? -cmp : cmp;
    });
    if (sorted.every((n, i) => n === items[i])) return;
    activeEditor.view.dispatch(activeEditor.state.tr.replaceWith(listStart, listStart + listNode.content.size, sorted));
  };

  // Word's Home > Paragraph > Borders - toggles a simple 1px border on the
  // current block, same on/off pattern as paragraph shading above it.
  const toggleParagraphBorder = () => {
    if (!activeEditor) return;
    const type = currentBlockType();
    const has = !!activeEditor.getAttributes(type).border;
    activeEditor.chain().focus().updateAttributes(type, { border: has ? null : '1px solid #111827' }).run();
  };

  // Word's Insert > Bookmarks - a named, invisible-on-export anchor. Stored
  // as a real node in the doc (docBuilderExtensions.js), so "go to bookmark"
  // is just "find the node with this name and select it" - no separate
  // position registry to keep in sync as the document is edited.
  const insertBookmark = () => {
    const name = newBookmarkName.trim().replace(/[^a-zA-Z0-9_ -]/g, '');
    if (!name || !activeEditor) return;
    activeEditor.chain().focus().insertContent({ type: 'bookmark', attrs: { name } }).run();
    setNewBookmarkName('');
  };
  const currentPageBookmarks = () => {
    if (!activeEditor) return [];
    const names = [];
    activeEditor.state.doc.descendants((node) => { if (node.type.name === 'bookmark' && node.attrs.name) names.push(node.attrs.name); });
    return names;
  };
  const goToBookmark = (name) => {
    if (!activeEditor) return;
    let target = null;
    activeEditor.state.doc.descendants((node, pos) => { if (target == null && node.type.name === 'bookmark' && node.attrs.name === name) target = pos; });
    if (target == null) return;
    goToPage(activePageId, target + 1);
    setBookmarkPopoverOpen(false);
  };

  // Word's Insert > Symbols/Emoji - plain-text insert, not chips/nodes (a
  // symbol IS just a character once inserted, same as typing it).
  const insertSymbol = (ch) => { activeEditor?.chain().focus().insertContent(ch).run(); };

  // Word's Insert > Table of Contents - scans every page's headings (each
  // page is its own independent editor, so this walks editorsRef rather than
  // one shared doc) and drops a static list at the cursor. Known scope trim:
  // entries show the page number but aren't clickable jump links - the pages
  // are genuinely separate TipTap instances, so a real "click to jump" would
  // need cross-editor event wiring; noted rather than half-built.
  // Every entry is a real jump link now: each heading gets a bookmark (reusing
  // the same node Insert > Bookmark uses) inserted as its first inline child
  // if it doesn't already have one, and the TOC list item links to it via a
  // "#toc:<pageId>:<bookmarkName>" href - not a real URL, just a scheme
  // goToTocLink below recognizes. Link's openOnClick is already false (see
  // docBuilderSchema.js), so clicking never tries to navigate the browser;
  // the click handler on each DocPage (onTocClick) intercepts it instead.
  const slugifyHeading = (s) => (s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40)) || 'section';
  const insertTableOfContents = () => {
    if (!activeEditor) return;
    const entries = [];
    pages.forEach((p, pageIdx) => {
      const ed = editorsRef.current.get(p.id);
      if (!ed) return;
      const usedNames = new Set();
      ed.state.doc.descendants((node) => { if (node.type.name === 'bookmark') usedNames.add(node.attrs.name); });
      const insertions = []; // { pos, name } - pos is the start of the heading's inline content
      ed.state.doc.forEach((node, offset) => {
        if (node.type.name !== 'heading') return;
        const text = node.textContent.trim();
        if (!text) return;
        const firstChild = node.content.firstChild;
        if (firstChild && firstChild.type.name === 'bookmark') {
          entries.push({ level: node.attrs.level || 1, text, page: pageIdx + 1, pageId: p.id, name: firstChild.attrs.name });
          return;
        }
        let base = slugifyHeading(text), name = base, i = 1;
        while (usedNames.has(name)) name = `${base}_${i++}`;
        usedNames.add(name);
        insertions.push({ pos: offset + 1, name });
        entries.push({ level: node.attrs.level || 1, text, page: pageIdx + 1, pageId: p.id, name });
      });
      if (insertions.length) {
        let tr = ed.state.tr;
        insertions.sort((a, b) => b.pos - a.pos).forEach(({ pos, name }) => {
          tr = tr.insert(pos, ed.schema.nodes.bookmark.create({ name }));
        });
        ed.view.dispatch(tr);
      }
    });
    if (!entries.length) { toastErr?.('No headings found to build a table of contents from'); return; }
    const listItems = entries.map(e => ({
      type: 'listItem',
      content: [{
        type: 'paragraph', attrs: { indent: Math.max(0, e.level - 1) },
        content: [{ type: 'text', text: `${e.text} — p.${e.page}`, marks: [{ type: 'link', attrs: { href: `#toc:${e.pageId}:${e.name}` } }] }],
      }],
    }));
    activeEditor.chain().focus('end').insertContent([
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Table of Contents' }] },
      { type: 'bulletList', content: listItems },
      { type: 'paragraph' },
    ]).run();
  };
  const goToTocLink = (href) => {
    const m = /^#toc:([^:]+):(.+)$/.exec(href || '');
    if (!m) return;
    const [, pageId, name] = m;
    const ed = editorsRef.current.get(pageId);
    if (!ed) return;
    let target = null;
    ed.state.doc.descendants((node, pos) => { if (target == null && node.type.name === 'bookmark' && node.attrs.name === name) target = pos; });
    goToPage(pageId, target != null ? target + 1 : 'start');
  };

  // Word's Home > Editing > Find & Replace. ProseMirror has no built-in
  // find/replace, so this walks each page's text nodes into one flat string
  // (with a position map back to real doc positions) to search, then a
  // Transaction.insertText(text, from, to) does the actual replace - the
  // correct low-level op for "replace this range with plain text", not a
  // content-parsing command. Searches every page, not just the active one -
  // "find" that only searched the page you happened to be on wouldn't be
  // find, it'd be luck.
  const findInEditor = (ed, query) => {
    const ql = query.toLowerCase();
    let full = ''; const positions = [];
    ed.state.doc.descendants((node, pos) => {
      if (node.isText) { for (let i = 0; i < node.text.length; i++) positions.push(pos + i); full += node.text; }
    });
    const fullLower = full.toLowerCase();
    const matches = []; let idx = 0;
    while (true) {
      const found = fullLower.indexOf(ql, idx);
      if (found === -1) break;
      matches.push({ from: positions[found], to: positions[found + ql.length - 1] + 1 });
      idx = found + 1;
    }
    return matches;
  };
  const jumpToMatch = (m) => {
    const ed = editorsRef.current.get(m.pageId);
    if (!ed) return;
    ed.chain().setTextSelection({ from: m.from, to: m.to }).focus().run();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      ed.view.dom.closest('.doc-page')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }));
  };
  const runFind = () => {
    const q = findQuery.trim();
    if (!q) { setFindMatches([]); setFindIndex(-1); return; }
    const all = [];
    pages.forEach(p => {
      const ed = editorsRef.current.get(p.id);
      if (ed) findInEditor(ed, q).forEach(m => all.push({ pageId: p.id, ...m }));
    });
    setFindMatches(all);
    setFindIndex(all.length ? 0 : -1);
    if (all.length) jumpToMatch(all[0]);
  };
  const findStep = (dir) => {
    if (!findMatches.length) return;
    const next = (findIndex + dir + findMatches.length) % findMatches.length;
    setFindIndex(next); jumpToMatch(findMatches[next]);
  };
  const replaceCurrent = () => {
    if (findIndex < 0 || !findMatches[findIndex]) return;
    const m = findMatches[findIndex];
    const ed = editorsRef.current.get(m.pageId);
    if (!ed) return;
    ed.view.dispatch(ed.state.tr.insertText(replaceQuery, m.from, m.to));
    setTimeout(runFind, 0);
  };
  const replaceAll = () => {
    if (!findMatches.length) return;
    const byPage = new Map();
    findMatches.forEach(m => { if (!byPage.has(m.pageId)) byPage.set(m.pageId, []); byPage.get(m.pageId).push(m); });
    byPage.forEach((matches, pageId) => {
      const ed = editorsRef.current.get(pageId);
      if (!ed) return;
      // Highest position first, so replacing one match doesn't shift the
      // doc positions of the ones still queued after it.
      let tr = ed.state.tr;
      [...matches].sort((a, b) => b.from - a.from).forEach(m => { tr = tr.insertText(replaceQuery, m.from, m.to); });
      ed.view.dispatch(tr);
    });
    setTimeout(runFind, 0);
  };

  const removeLink = () => {
    activeEditor?.chain().focus().unsetLink().run();
    setLinkPopoverOpen(false); setLinkUrlDraft('');
  };

  const toggleLinkPopover = () => {
    setLinkUrlDraft(activeEditor?.getAttributes('link')?.href || '');
    setLinkPopoverOpen(o => !o);
  };

  // Default x/y (Phase 9, only meaningful for non-inline wrap modes) - the
  // cursor's current screen position converted to coordinates relative to
  // .doc-page's own box, so a freshly-inserted floating shape/textbox starts
  // roughly where the user was typing instead of always at (0,0).
  const insertPageCoords = () => {
    if (!activeEditor) return { x: 40, y: 40 };
    try {
      const pos = activeEditor.state.selection.from;
      const coords = activeEditor.view.coordsAtPos(pos);
      const pageEl = activeEditor.view.dom.closest('.doc-page');
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
    // be well off-screen in a long document - without this the insert looks
    // like it silently failed even though it worked.
    activeEditor?.chain().focus().insertContent({
      type: 'docShape',
      attrs: { shapeType, width, height, fillColor: shapeFill, strokeColor: shapeStroke, x, y, wrapMode: shapeWrapMode },
    }).scrollIntoView().run();
    setShapePopoverOpen(false);
  };

  const insertTextbox = () => {
    const { x, y } = insertPageCoords();
    activeEditor?.chain().focus().insertContent({
      type: 'docTextbox',
      attrs: { x, y, wrapMode: textboxWrapMode },
      content: [{ type: 'paragraph' }],
    }).scrollIntoView().run();
    setTextboxPopoverOpen(false);
  };

  // Phase 5 bridge: export to PDF, hand it to E-Sign's existing SendWizard via
  // the same window.__esignPrefill + nexus:navigate handoff HR->Hiring already
  // uses - no new backend send path, no change to esign.py's compliance logic.
  const doSendForSignature = () => {
    if (doc?.signRequestId && !window.confirm('This document was already sent for signature. Start a new envelope anyway?')) return;
    setExporting('send');
    api.exportDocumentPdf(docId).then(({ blob, filename }) => {
      const pdfFile = new File([blob], filename.endsWith('.pdf') ? filename : `${filename}.pdf`, { type: 'application/pdf' });
      window.__esignPrefill = { title, file: pdfFile, source: 'pdf', sourceDocumentId: docId, parties: [] };
      window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'documents', sub: 'documents-esign' } }));
    }).catch(e => toastErr?.(e.message || 'Failed to prepare document for signature')).finally(() => setExporting(''));
  };

  // Save as Template - copies this document's current content (its
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

  // Restore does NOT rewrite history in place - it PATCHes the old content
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
    activeEditor?.chain().focus().insertContent({ type: 'mergeField', attrs: { token } }).run();
    e.target.value = '';
  };

  // Template Builder (Phase 13) - "select text → Convert to Merge Field".
  // Captures the selection's own range rather than trusting "current
  // selection" once the modal (and its own inputs) has stolen focus.
  const openConvertToMergeField = () => {
    if (!activeEditor) return;
    const { from, to } = activeEditor.state.selection;
    if (from === to) { toastErr?.('Select some text first, then click Convert to Merge Field.'); return; }
    const text = activeEditor.state.doc.textBetween(from, to, ' ');
    setMergeFieldModal({ range: { from, to }, initialLabel: text });
  };

  // Double-click an existing chip to edit its type/required/default/
  // validation without moving it - chips render as plain HTML (not a TipTap
  // NodeView), so this is a delegated DOM listener rather than a node-level
  // click handler.
  useEffect(() => {
    if (!activeEditor || kind !== 'template') return;
    const dom = activeEditor.view.dom;
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
  }, [activeEditor, kind, fieldDefs]);

  const saveMergeFieldDef = (def) => {
    if (mergeFieldModal?.range) {
      const { from, to } = mergeFieldModal.range;
      activeEditor?.chain().focus().insertContentAt({ from, to }, { type: 'mergeField', attrs: { token: def.token } }).run();
    }
    const next = [...fieldDefs.filter((f) => f.token !== def.token), def];
    setFieldDefs(next);
    apiUpdate(docId, { fieldDefs: next }).catch((e) => toastErr?.(e.message || 'Failed to save the merge field'));
    setMergeFieldModal(null);
  };

  // Quick sections (e.g. Purpose/Process/Notes for a KB SOP): drop a bordered
  // sectionBox at the end of the active page, with the cursor placed inside
  // it, so the author starts typing INTO the section rather than under a
  // heading they'd have to remember to indent under. A plain paragraph
  // sibling always follows the box - clicking below it lands there, outside
  // the box, so the next section (or any trailing content) is ordinary
  // unwrapped body text, not accidentally nested inside the last section.
  // Caller-supplied (quickSections prop) - this component stays
  // domain-agnostic, the KB module is what knows SOPs want Purpose/Process/Notes.
  const insertQuickSection = (heading) => {
    if (!activeEditor) return;
    const insertPos = activeEditor.state.doc.content.size;
    activeEditor.chain().focus('end')
      .insertContent([
        { type: 'sectionBox', attrs: { label: heading }, content: [{ type: 'paragraph' }] },
        { type: 'paragraph' },
      ])
      .run();
    activeEditor.chain().focus(insertPos + 2).run();
  };

  // Pages panel actions - each page is a real array entry (see the `pages`
  // state comment above), so these are ordinary array splices, not
  // ProseMirror position math against one shared document.
  const addPage = () => {
    const id = genPageId();
    pendingFocusId.current = id;
    setPages(prev => [...prev, { id, json: null }]);
    scheduleSave(); // new page mounts with content already in place, which never fires onUpdate on its own
  };
  const duplicatePage = (idx, withContent) => {
    const src = pages[idx];
    if (!src) return;
    const srcEditor = editorsRef.current.get(src.id);
    const srcJson = srcEditor ? srcEditor.getJSON() : (src.json || { type: 'doc', content: [] });
    let content = withContent ? JSON.parse(JSON.stringify(srcJson.content || [])) : stripToFormat(srcJson.content || []);
    if (!content.length) content = [{ type: 'paragraph' }]; // a genuinely blank/content-only page strips to nothing - keep the page itself real
    const id = genPageId();
    pendingFocusId.current = id;
    setPages(prev => { const next = [...prev]; next.splice(idx + 1, 0, { id, json: { type: 'doc', content } }); return next; });
    setPageMenuOpen('');
    scheduleSave();
  };
  const deletePage = (idx) => {
    if (pages.length <= 1) return;
    const id = pages[idx].id;
    setPages(prev => prev.filter((_, i) => i !== idx));
    editorsRef.current.delete(id);
    setPageMenuOpen('');
    scheduleSave();
  };

  const doUploadImage = async (pageId, file) => {
    const path = `document-images/${docId}/${Date.now()}-${safeName(file.name)}`;
    const { url, error } = await uploadToSupabase(file, 'document-images', path);
    if (error) { toastErr?.(error); return; }
    editorsRef.current.get(pageId)?.chain().focus().setImage({ src: url }).run();
  };

  const onPickImage = (e) => {
    const file = e.target.files?.[0];
    if (file && activePageId) doUploadImage(activePageId, file);
    e.target.value = '';
  };

  const onBodyPaste = (pageId, e) => {
    const f = imageFromPaste(e);
    if (f) { e.preventDefault(); doUploadImage(pageId, f); }
  };

  // Phase 10: import a Word/PDF/text file, replacing the body content.
  // uploadImportedImage wraps the same uploadToSupabase() helper used for
  // toolbar/paste image inserts (Phase 2) rather than embedding data URIs, so
  // imported images end up as ordinary hosted images, not bloating the
  // document JSON. Unrecognized image bytes from a .docx (e.g. WMF/EMF)
  // simply fail the upload's type check and are skipped - same "failed image
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
    const isEmpty = pages.length <= 1 && (activeEditor?.isEmpty ?? true);
    if (!isEmpty && !window.confirm('This will replace the current document content. Continue?')) return;
    setImporting(true);
    try {
      const { html, json: directJson, pageSetup: importedPageSetup, warnings } = await importDocumentFile(file, { uploadImage: uploadImportedImage });
      const json = directJson || generateJSON(html || '<p></p>', BODY_EXTENSIONS);
      // The imported doc still carries pageBreak markers (docxToTiptap.js
      // preserves Word's own page breaks) - split it into real pages the same
      // way a pre-rewrite document upgrades on load, rather than dumping the
      // whole import onto a single page.
      const newPages = splitBodyIntoPages(json);
      editorsRef.current = new Map();
      setPages(newPages);
      setActivePageId(newPages[0]?.id || '');
      // .docx imports carry the source file's own page size/orientation/
      // margins (docxToTiptap.js) - apply them so the imported page setup
      // matches the original, not whatever this document had before.
      if (importedPageSetup) updatePageSetup(importedPageSetup);
      if (warnings?.length) toastErr?.(`Imported with notes: ${warnings.slice(0, 2).join(' ')}`);
      else toastOk?.('Imported - review formatting before sending');
      setImportPopoverOpen(false);
      scheduleSave();
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
              <div style={{ position: 'absolute', top: '110%', right: 0, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, boxShadow: 'var(--shadow-lg)', zIndex: 20, width: newLhOpen ? 260 : 200, padding: 6 }}>
                {!newLhOpen ? (<>
                  <button onClick={() => changeLetterhead('')}
                    style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: '7px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 12.5, color: 'var(--ink)' }}>No letterhead</button>
                  {letterheads.map(l => (
                    <button key={l.id} onClick={() => changeLetterhead(l.id)}
                      style={{ display: 'block', width: '100%', textAlign: 'left', background: l.id === letterheadId ? 'var(--mist)' : 'none', border: 'none', padding: '7px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 12.5, color: 'var(--ink)' }}>
                      {l.name}{l.isDefault ? ' (default)' : ''}
                    </button>
                  ))}
                  <div style={{ borderTop: '1px solid var(--line)', margin: '4px 0' }} />
                  <button onClick={() => setNewLhOpen(true)}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: '7px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 12.5, fontWeight: 600, color: 'var(--ink)' }}>
                    <Plus size={13} /> Add letterhead…
                  </button>
                </>) : (
                  <div style={{ padding: 4 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                      <span style={{ fontSize: 12.5, fontWeight: 700 }}>New letterhead</span>
                      <button onClick={() => setNewLhOpen(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex' }}><X size={14} /></button>
                    </div>
                    <input value={newLhName} onChange={e => setNewLhName(e.target.value)} placeholder="Name (e.g. IT Department)"
                      style={{ width: '100%', fontSize: 12.5, padding: '7px 9px', border: '1px solid var(--line)', borderRadius: 7, marginBottom: 6, fontFamily: 'Inter, sans-serif' }} />
                    <input value={newLhAddress} onChange={e => setNewLhAddress(e.target.value)} placeholder="Address (optional)"
                      style={{ width: '100%', fontSize: 12.5, padding: '7px 9px', border: '1px solid var(--line)', borderRadius: 7, marginBottom: 8, fontFamily: 'Inter, sans-serif' }} />
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, cursor: 'pointer', marginBottom: 10 }}>
                      {newLhLogoUrl ? <img src={newLhLogoUrl} alt="" style={{ height: 26, maxWidth: 90, objectFit: 'contain' }} />
                        : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--muted)' }}>{newLhLogoBusy ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Upload size={13} />} Upload logo (optional)</span>}
                      <input type="file" accept="image/*" style={{ display: 'none' }}
                        onChange={e => { const f = e.target.files?.[0]; if (f) uploadLhLogo(f); e.target.value = ''; }} />
                    </label>
                    <button disabled={newLhBusy || newLhLogoBusy} onClick={createLetterhead}
                      style={{ width: '100%', background: 'var(--ink)', color: '#fff', border: 'none', borderRadius: 7, padding: '8px 0', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                      {newLhBusy ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Check size={13} />} Add & use
                    </button>
                  </div>
                )}
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
        // Real rendered preview (Phase 17) - shows the document exactly as it
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
      {!preview && activeEditor && (
        <>
          <div style={{ display: 'flex', gap: 2, marginBottom: 2 }}>
            {[['home', 'Home'], ['insert', 'Insert'], ['layout', 'Layout']].map(([key, label]) => (
              <button key={key} onClick={() => setRibbonTab(key)}
                style={{ fontSize: 12.5, fontWeight: 600, padding: '6px 14px', border: 'none', borderBottom: ribbonTab === key ? '2px solid var(--ink)' : '2px solid transparent', background: 'none', cursor: 'pointer', color: ribbonTab === key ? 'var(--ink)' : 'var(--muted)', fontFamily: 'Inter, sans-serif' }}>
                {label}
              </button>
            ))}
          </div>
        <div className="doc-toolbar">
          {ribbonTab === 'home' && (
          <>
          <ToolbarBtn title="Cut" onClick={() => clipboardAction('cut')}><Scissors size={15} /></ToolbarBtn>
          <ToolbarBtn title="Copy" onClick={() => clipboardAction('copy')}><ClipboardCopy size={15} /></ToolbarBtn>
          <ToolbarBtn title="Paste" onClick={() => clipboardAction('paste')}><ClipboardPaste size={15} /></ToolbarBtn>
          <ToolbarBtn title="Format Painter - click, then select text to copy the formatting onto" active={painterActive} onClick={toggleFormatPainter}><Paintbrush size={15} /></ToolbarBtn>
          <span className="doc-toolbar-sep" />
          <ToolbarBtn title="Bold" active={activeEditor.isActive('bold')} onClick={() => activeEditor.chain().focus().toggleBold().run()}><Bold size={15} /></ToolbarBtn>
          <ToolbarBtn title="Italic" active={activeEditor.isActive('italic')} onClick={() => activeEditor.chain().focus().toggleItalic().run()}><Italic size={15} /></ToolbarBtn>
          <ToolbarBtn title="Underline" active={activeEditor.isActive('underline')} onClick={() => activeEditor.chain().focus().toggleUnderline().run()}><Underline size={15} /></ToolbarBtn>
          <ToolbarBtn title="Strikethrough" active={activeEditor.isActive('strike')} onClick={() => activeEditor.chain().focus().toggleStrike().run()}><Strikethrough size={15} /></ToolbarBtn>
          <ToolbarBtn title="Subscript" active={activeEditor.isActive('subscript')} onClick={() => activeEditor.chain().focus().toggleSubscript().run()}><SubscriptIcon size={15} /></ToolbarBtn>
          <ToolbarBtn title="Superscript" active={activeEditor.isActive('superscript')} onClick={() => activeEditor.chain().focus().toggleSuperscript().run()}><SuperscriptIcon size={15} /></ToolbarBtn>
          <span className="doc-toolbar-sep" />
          <select onChange={e => { const v = e.target.value; if (v) activeEditor.chain().focus().setFontFamily(v).run(); else activeEditor.chain().focus().unsetFontFamily().run(); }}
            value={activeEditor.getAttributes('textStyle').fontFamily || ''} title="Font family"
            style={{ fontSize: 12, fontFamily: 'Inter, sans-serif', border: '1px solid var(--line)', borderRadius: 7, padding: '5px 6px', cursor: 'pointer', color: 'var(--ink)', background: 'var(--card)', maxWidth: 116 }}>
            <option value="">Font</option>
            {Object.entries(FONT_GROUPS).map(([group, fonts]) => (
              <optgroup key={group} label={group}>
                {fonts.map(f => <option key={f} value={f}>{f}</option>)}
              </optgroup>
            ))}
          </select>
          <ToolbarBtn title="Shrink font" onClick={() => stepFontSize(-1)}><span style={{ fontSize: 11, fontWeight: 700 }}>A↓</span></ToolbarBtn>
          <select onChange={e => { const v = e.target.value; if (v) activeEditor.chain().focus().setFontSize(`${v}px`).run(); else activeEditor.chain().focus().unsetFontSize().run(); }}
            value={(activeEditor.getAttributes('textStyle').fontSize || '').replace('px', '')} title="Font size"
            style={{ fontSize: 12, fontFamily: 'Inter, sans-serif', border: '1px solid var(--line)', borderRadius: 7, padding: '5px 6px', cursor: 'pointer', color: 'var(--ink)', background: 'var(--card)', width: 58 }}>
            <option value="">Size</option>
            {FONT_SIZES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <ToolbarBtn title="Grow font" onClick={() => stepFontSize(1)}><span style={{ fontSize: 14, fontWeight: 700 }}>A↑</span></ToolbarBtn>
          <select title="Change case" defaultValue="" onChange={e => { if (e.target.value) changeCase(e.target.value); e.target.value = ''; }}
            style={{ fontSize: 12, fontFamily: 'Inter, sans-serif', border: '1px solid var(--line)', borderRadius: 7, padding: '5px 4px', cursor: 'pointer', color: 'var(--ink)', background: 'var(--card)', width: 46 }}>
            <option value="">Aa</option>
            <option value="upper">UPPERCASE</option>
            <option value="lower">lowercase</option>
            <option value="title">Capitalize Each Word</option>
            <option value="sentence">Sentence case</option>
          </select>
          <input type="color" title="Text color" value={activeEditor.getAttributes('textStyle').color || '#111827'}
            onChange={e => activeEditor.chain().focus().setColor(e.target.value).run()}
            style={{ width: 26, height: 26, padding: 0, border: '1px solid var(--line)', borderRadius: 6, cursor: 'pointer', background: 'none' }} />
          <label style={{ display: 'inline-flex', alignItems: 'center', cursor: 'pointer' }} title="Highlight color">
            <Highlighter size={15} style={{ color: 'var(--ink)' }} />
            <input type="color" defaultValue="#fef08a"
              onChange={e => activeEditor.chain().focus().toggleHighlight({ color: e.target.value }).run()}
              style={{ width: 16, height: 16, padding: 0, border: '1px solid var(--line)', borderRadius: 4, cursor: 'pointer', background: 'none', marginLeft: 2 }} />
          </label>
          <span className="doc-toolbar-sep" />
          <select title="Styles" defaultValue="" onChange={e => { if (e.target.value) applyStyle(e.target.value === 'normal' ? 'normal' : Number(e.target.value)); e.target.value = ''; }}
            style={{ fontSize: 12, fontFamily: 'Inter, sans-serif', border: '1px solid var(--line)', borderRadius: 7, padding: '5px 6px', cursor: 'pointer', color: 'var(--ink)', background: 'var(--card)', width: 96 }}>
            <option value="">Styles</option>
            <option value="normal">Normal</option>
            <option value="1">Heading 1</option>
            <option value="2">Heading 2</option>
            <option value="3">Heading 3</option>
          </select>
          <span className="doc-toolbar-sep" />
          <ToolbarBtn title="Align left" active={activeEditor.isActive({ textAlign: 'left' })} onClick={() => activeEditor.chain().focus().setTextAlign('left').run()}><AlignLeft size={15} /></ToolbarBtn>
          <ToolbarBtn title="Align center" active={activeEditor.isActive({ textAlign: 'center' })} onClick={() => activeEditor.chain().focus().setTextAlign('center').run()}><AlignCenter size={15} /></ToolbarBtn>
          <ToolbarBtn title="Align right" active={activeEditor.isActive({ textAlign: 'right' })} onClick={() => activeEditor.chain().focus().setTextAlign('right').run()}><AlignRight size={15} /></ToolbarBtn>
          <ToolbarBtn title="Justify" active={activeEditor.isActive({ textAlign: 'justify' })} onClick={() => activeEditor.chain().focus().setTextAlign('justify').run()}><AlignJustify size={15} /></ToolbarBtn>
          <span className="doc-toolbar-sep" />
          <div style={{ position: 'relative' }}>
            <ToolbarBtn title="Link" active={activeEditor.isActive('link')} onClick={toggleLinkPopover}><Link2 size={15} /></ToolbarBtn>
            {linkPopoverOpen && (
              <div style={{ position: 'absolute', top: '110%', left: 0, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, boxShadow: 'var(--shadow-lg)', zIndex: 20, padding: 8, display: 'flex', gap: 6, alignItems: 'center' }}>
                <input className="form-input" style={{ fontSize: 12, width: 180 }} placeholder="https://…" value={linkUrlDraft}
                  onChange={e => setLinkUrlDraft(e.target.value)} onKeyDown={e => e.key === 'Enter' && applyLink()} autoFocus />
                <button onClick={applyLink} className="primary-btn" style={{ fontSize: 11.5, padding: '5px 10px' }}>Apply</button>
                {activeEditor.isActive('link') && (
                  <button onClick={removeLink} title="Remove link" style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 6, padding: 5, cursor: 'pointer', display: 'flex' }}><Link2Off size={13} /></button>
                )}
              </div>
            )}
          </div>
          <span className="doc-toolbar-sep" />
          <ToolbarBtn title="Bullet list" active={activeEditor.isActive('bulletList')} onClick={() => activeEditor.chain().focus().toggleBulletList().run()}><List size={15} /></ToolbarBtn>
          <ToolbarBtn title="Numbered list" active={activeEditor.isActive('orderedList')} onClick={() => activeEditor.chain().focus().toggleOrderedList().run()}><ListOrdered size={15} /></ToolbarBtn>
          <ToolbarBtn title="Decrease indent" onClick={() => changeIndent(-1)}><Outdent size={15} /></ToolbarBtn>
          <ToolbarBtn title="Increase indent" onClick={() => changeIndent(1)}><Indent size={15} /></ToolbarBtn>
          <span className="doc-toolbar-sep" />
          <select title="Line spacing" defaultValue="" onChange={e => setLineHeight(e.target.value)}
            style={{ fontSize: 12, fontFamily: 'Inter, sans-serif', border: '1px solid var(--line)', borderRadius: 7, padding: '5px 4px', cursor: 'pointer', color: 'var(--ink)', background: 'var(--card)', width: 30 }}>
            <option value="">‒</option>
            {['1', '1.15', '1.5', '2'].map(v => <option key={v} value={v}>{v}</option>)}
          </select>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 3, cursor: 'pointer' }} title="Paragraph shading">
            <PaintBucket size={15} style={{ color: 'var(--ink)' }} />
            <input type="color" defaultValue="#ffffff" onChange={e => setParagraphShading(e.target.value)}
              style={{ width: 16, height: 16, padding: 0, border: '1px solid var(--line)', borderRadius: 4, cursor: 'pointer', background: 'none' }} />
          </label>
          <ToolbarBtn title="Paragraph border" active={!!activeEditor.getAttributes(currentBlockType()).border} onClick={toggleParagraphBorder}><RectangleHorizontal size={15} /></ToolbarBtn>
          <ToolbarBtn title="Sort A to Z (list items)" onClick={() => sortSelection('asc')}><ArrowDownAZ size={15} /></ToolbarBtn>
          <ToolbarBtn title="Sort Z to A (list items)" onClick={() => sortSelection('desc')}><ArrowUpZA size={15} /></ToolbarBtn>
          <ToolbarBtn title="Show/Hide ¶ marks" active={showMarks} onClick={() => setShowMarks(s => !s)}><Pilcrow size={15} /></ToolbarBtn>
          <span className="doc-toolbar-sep" />
          <ToolbarBtn title="Find & Replace" active={findOpen} onClick={() => setFindOpen(o => !o)}><Search size={15} /></ToolbarBtn>
          <ToolbarBtn title="Select all" onClick={() => activeEditor.chain().focus().selectAll().run()}><MousePointerSquareDashed size={15} /></ToolbarBtn>
          </>
          )}

          {ribbonTab === 'insert' && (
          <>
          <ToolbarBtn title="Insert table" onClick={() => activeEditor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}><TableIcon size={15} /></ToolbarBtn>
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
          {kind === 'document' && <ToolbarBtn title="Page break / add page" onClick={addPage}><SeparatorHorizontal size={15} /></ToolbarBtn>}
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
          <div style={{ position: 'relative' }}>
            <ToolbarBtn title="Bookmark" active={bookmarkPopoverOpen} onClick={() => setBookmarkPopoverOpen(o => !o)}><Bookmark size={15} /></ToolbarBtn>
            {bookmarkPopoverOpen && (
              <div style={{ position: 'absolute', top: '110%', left: 0, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, boxShadow: 'var(--shadow-lg)', zIndex: 20, padding: 10, display: 'flex', flexDirection: 'column', gap: 8, minWidth: 200 }}>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input className="form-input" style={{ fontSize: 12, flex: 1 }} placeholder="Bookmark name" value={newBookmarkName}
                    onChange={e => setNewBookmarkName(e.target.value)} onKeyDown={e => e.key === 'Enter' && insertBookmark()} autoFocus />
                  <button onClick={insertBookmark} className="primary-btn" style={{ fontSize: 11.5, padding: '5px 10px' }}>Add</button>
                </div>
                {currentPageBookmarks().length > 0 && (
                  <div style={{ borderTop: '1px solid var(--line)', paddingTop: 6, display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 140, overflowY: 'auto' }}>
                    {currentPageBookmarks().map(name => (
                      <button key={name} onClick={() => goToBookmark(name)}
                        style={{ textAlign: 'left', background: 'none', border: 'none', padding: '4px 6px', fontSize: 12, cursor: 'pointer', color: 'var(--ink)', borderRadius: 5 }}>
                        ⚑ {name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
          <ToolbarBtn title="Table of Contents - lists every heading with its page number" onClick={insertTableOfContents}><ListTree size={15} /></ToolbarBtn>
          <div style={{ position: 'relative' }}>
            <ToolbarBtn title="Symbol / Emoji" active={symbolPopoverOpen} onClick={() => setSymbolPopoverOpen(o => !o)}><Smile size={15} /></ToolbarBtn>
            {symbolPopoverOpen && (
              <div style={{ position: 'absolute', top: '110%', left: 0, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, boxShadow: 'var(--shadow-lg)', zIndex: 20, padding: 10, width: 220 }}>
                <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
                  <button onClick={() => setSymbolTab('symbols')} style={{ fontSize: 11.5, fontWeight: 600, padding: '4px 10px', border: 'none', borderBottom: symbolTab === 'symbols' ? '2px solid var(--ink)' : '2px solid transparent', background: 'none', cursor: 'pointer', color: symbolTab === 'symbols' ? 'var(--ink)' : 'var(--muted)' }}>Symbols</button>
                  <button onClick={() => setSymbolTab('emoji')} style={{ fontSize: 11.5, fontWeight: 600, padding: '4px 10px', border: 'none', borderBottom: symbolTab === 'emoji' ? '2px solid var(--ink)' : '2px solid transparent', background: 'none', cursor: 'pointer', color: symbolTab === 'emoji' ? 'var(--ink)' : 'var(--muted)' }}>Emoji</button>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, maxHeight: 160, overflowY: 'auto' }}>
                  {(symbolTab === 'symbols' ? SYMBOL_CHARS : EMOJI_CHARS).map((ch, i) => (
                    <button key={i} onClick={() => { insertSymbol(ch); setSymbolPopoverOpen(false); }} title={ch}
                      style={{ fontSize: 16, background: 'none', border: 'none', cursor: 'pointer', padding: 4, borderRadius: 5, lineHeight: 1 }}>
                      {ch}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          </>
          )}

          {ribbonTab === 'layout' && (
          <>
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
                <div>
                  <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 4 }}>Columns</label>
                  <select className="form-input" style={{ width: '100%', fontSize: 12.5 }} value={pageSetup.columns || 1}
                    onChange={e => updatePageSetup({ columns: Number(e.target.value) })}>
                    <option value={1}>One</option>
                    <option value={2}>Two</option>
                    <option value={3}>Three</option>
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 4 }}>
                    Page Border
                  </label>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <select className="form-input" style={{ flex: 1, fontSize: 12.5 }}
                      value={pageSetup.pageBorder?.style || ''}
                      onChange={e => updatePageSetup({ pageBorder: e.target.value ? { ...(pageSetup.pageBorder || {}), style: e.target.value, width: pageSetup.pageBorder?.width || 1, color: pageSetup.pageBorder?.color || '#111827' } : null })}>
                      <option value="">None</option>
                      <option value="solid">Solid</option>
                      <option value="dashed">Dashed</option>
                      <option value="double">Double</option>
                    </select>
                    {pageSetup.pageBorder?.style && (
                      <input type="color" value={pageSetup.pageBorder?.color || '#111827'}
                        onChange={e => updatePageSetup({ pageBorder: { ...pageSetup.pageBorder, color: e.target.value } })}
                        style={{ width: 24, height: 24, padding: 0, border: '1px solid var(--line)', borderRadius: 5, cursor: 'pointer' }} />
                    )}
                  </div>
                </div>
                <div>
                  <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    Page Colour
                    <input type="color" value={pageSetup.pageColor || '#ffffff'}
                      onChange={e => updatePageSetup({ pageColor: e.target.value === '#ffffff' ? null : e.target.value })}
                      style={{ width: 24, height: 24, padding: 0, border: '1px solid var(--line)', borderRadius: 5, cursor: 'pointer' }} />
                  </label>
                </div>
                <label style={{ fontSize: 12.5, display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}>
                  Line numbers <input type="checkbox" checked={!!pageSetup.lineNumbers} onChange={e => updatePageSetup({ lineNumbers: e.target.checked })} />
                </label>
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
          {kind === 'document' && <ToolbarBtn title="Breaks - insert a page break" onClick={addPage}><SeparatorHorizontal size={15} /></ToolbarBtn>}
          <span className="doc-toolbar-sep" />
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, color: 'var(--muted)' }} title="Space before paragraph, in points">
            Before
            <input type="number" min={0} max={72} step={1}
              value={activeEditor.getAttributes(currentBlockType()).spacingBefore || ''}
              onChange={e => activeEditor.chain().focus().updateAttributes(currentBlockType(), { spacingBefore: e.target.value ? Number(e.target.value) : null }).run()}
              style={{ width: 44, fontSize: 12, border: '1px solid var(--line)', borderRadius: 6, padding: '4px 5px' }} />
            pt
          </label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, color: 'var(--muted)' }} title="Space after paragraph, in points">
            After
            <input type="number" min={0} max={72} step={1}
              value={activeEditor.getAttributes(currentBlockType()).spacingAfter || ''}
              onChange={e => activeEditor.chain().focus().updateAttributes(currentBlockType(), { spacingAfter: e.target.value ? Number(e.target.value) : null }).run()}
              style={{ width: 44, fontSize: 12, border: '1px solid var(--line)', borderRadius: 6, padding: '4px 5px' }} />
            pt
          </label>
          </>
          )}

          <span className="doc-toolbar-sep" />
          <ToolbarBtn title="Undo" onClick={() => activeEditor.chain().focus().undo().run()}><Undo size={15} /></ToolbarBtn>
          <ToolbarBtn title="Redo" onClick={() => activeEditor.chain().focus().redo().run()}><Redo size={15} /></ToolbarBtn>
          <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/gif,image/webp" onChange={onPickImage} style={{ display: 'none' }} />
        </div>

        {findOpen && (
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, margin: '4px 0 10px', padding: '8px 10px', background: 'var(--mist)', border: '1px solid var(--line)', borderRadius: 8 }}>
            <input className="form-input" style={{ fontSize: 12, width: 160 }} placeholder="Find" value={findQuery}
              onChange={e => setFindQuery(e.target.value)} onKeyDown={e => e.key === 'Enter' && runFind()} autoFocus />
            <input className="form-input" style={{ fontSize: 12, width: 160 }} placeholder="Replace with" value={replaceQuery}
              onChange={e => setReplaceQuery(e.target.value)} onKeyDown={e => e.key === 'Enter' && replaceCurrent()} />
            <button onClick={runFind} className="primary-btn" style={{ fontSize: 11.5, padding: '5px 10px' }}>Find</button>
            <button onClick={() => findStep(-1)} disabled={!findMatches.length} style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 6, padding: '5px 8px', cursor: findMatches.length ? 'pointer' : 'default', fontSize: 12 }}>Prev</button>
            <button onClick={() => findStep(1)} disabled={!findMatches.length} style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 6, padding: '5px 8px', cursor: findMatches.length ? 'pointer' : 'default', fontSize: 12 }}>Next</button>
            <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{findMatches.length ? `${findIndex + 1} of ${findMatches.length}` : 'No matches'}</span>
            <button onClick={replaceCurrent} disabled={!findMatches.length} style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 6, padding: '5px 10px', cursor: findMatches.length ? 'pointer' : 'default', fontSize: 12 }}>Replace</button>
            <button onClick={replaceAll} disabled={!findMatches.length} style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 6, padding: '5px 10px', cursor: findMatches.length ? 'pointer' : 'default', fontSize: 12 }}>Replace All</button>
            <button onClick={() => { setFindOpen(false); setFindMatches([]); setFindIndex(-1); }} title="Close" style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)' }}><X size={15} /></button>
          </div>
        )}
        </>
      )}

      {!preview && quickSections.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, margin: '-6px 0 14px' }}>
          <span style={{ fontSize: 11.5, color: 'var(--muted)', fontWeight: 600 }}>Add section:</span>
          {quickSections.map(s => (
            <button key={s.heading} onClick={() => insertQuickSection(s.heading)} title={s.hint || `Insert a "${s.heading}" heading`}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--mist)', border: '1px solid var(--line)', borderRadius: 8, padding: '6px 12px', cursor: 'pointer', fontSize: 12.5, fontWeight: 600, color: 'var(--ink)', fontFamily: 'Inter, sans-serif' }}>
              <Plus size={13} /> {s.heading}
            </button>
          ))}
        </div>
      )}

      {/* Contextual toolbars - appear only while the cursor/selection is
          inside the relevant node, mirroring Word's "click a table/picture/
          shape and its own ribbon shows up" behavior instead of cluttering
          the main toolbar with buttons that only apply some of the time. */}
      {!preview && activeEditor?.isActive('table') && (
        <div className="doc-toolbar" style={{ marginTop: -8 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', paddingLeft: 4 }}>Table:</span>
          <ToolbarBtn title="Add row above" onClick={() => activeEditor.chain().focus().addRowBefore().run()}><Rows size={15} /><span style={{ fontSize: 10 }}>↑+</span></ToolbarBtn>
          <ToolbarBtn title="Add row below" onClick={() => activeEditor.chain().focus().addRowAfter().run()}><Rows size={15} /><span style={{ fontSize: 10 }}>↓+</span></ToolbarBtn>
          <ToolbarBtn title="Delete row" onClick={() => activeEditor.chain().focus().deleteRow().run()}><Rows size={15} /><Trash2 size={11} /></ToolbarBtn>
          <span className="doc-toolbar-sep" />
          <ToolbarBtn title="Add column left" onClick={() => activeEditor.chain().focus().addColumnBefore().run()}><Columns size={15} /><span style={{ fontSize: 10 }}>←+</span></ToolbarBtn>
          <ToolbarBtn title="Add column right" onClick={() => activeEditor.chain().focus().addColumnAfter().run()}><Columns size={15} /><span style={{ fontSize: 10 }}>→+</span></ToolbarBtn>
          <ToolbarBtn title="Delete column" onClick={() => activeEditor.chain().focus().deleteColumn().run()}><Columns size={15} /><Trash2 size={11} /></ToolbarBtn>
          <span className="doc-toolbar-sep" />
          <ToolbarBtn title="Merge cells" onClick={() => activeEditor.chain().focus().mergeCells().run()}><Combine size={15} /></ToolbarBtn>
          <ToolbarBtn title="Split cell" onClick={() => activeEditor.chain().focus().splitCell().run()}><SquareSplitHorizontal size={15} /></ToolbarBtn>
          <ToolbarBtn title="Toggle header row" active={activeEditor.isActive('tableHeader')} onClick={() => activeEditor.chain().focus().toggleHeaderRow().run()}>H</ToolbarBtn>
          <span className="doc-toolbar-sep" />
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--muted)' }} title="Shade the current cell">
            Shade
            <input type="color" defaultValue="#f3f4f6"
              onChange={(e) => {
                const attrName = activeEditor.isActive('tableHeader') ? 'tableHeader' : 'tableCell';
                activeEditor.chain().focus().updateAttributes(attrName, { backgroundColor: e.target.value }).run();
              }}
              style={{ width: 22, height: 22, padding: 0, border: '1px solid var(--line)', borderRadius: 5, cursor: 'pointer' }} />
          </label>
          <ToolbarBtn title="Delete table" onClick={() => activeEditor.chain().focus().deleteTable().run()}><Trash2 size={15} /></ToolbarBtn>
        </div>
      )}

      {!preview && (activeEditor?.isActive('docShape') || activeEditor?.isActive('docTextbox') || activeEditor?.isActive('image')) && (
        <div className="doc-toolbar" style={{ marginTop: -8 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', paddingLeft: 4 }}>
            {activeEditor.isActive('docShape') ? 'Shape:' : activeEditor.isActive('docTextbox') ? 'Text box:' : 'Image:'}
          </span>
          {(() => {
            const type = activeEditor.isActive('docShape') ? 'docShape' : activeEditor.isActive('docTextbox') ? 'docTextbox' : 'image';
            const attrs = activeEditor.getAttributes(type);
            const rotate = (delta) => activeEditor.chain().focus().updateAttributes(type, { rotation: ((attrs.rotation || 0) + delta + 360) % 360 }).run();
            return (
              <>
                <label style={{ fontSize: 11, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  Wrap
                  <select value={attrs.wrapMode || 'inline'} onChange={(e) => activeEditor.chain().focus().updateAttributes(type, { wrapMode: e.target.value }).run()}
                    style={{ fontSize: 12, fontFamily: 'Inter, sans-serif', border: '1px solid var(--line)', borderRadius: 7, padding: '4px 6px', cursor: 'pointer', color: 'var(--ink)', background: 'var(--card)' }}>
                    {WRAP_MODES.map(w => <option key={w.value} value={w.value}>{w.label}</option>)}
                  </select>
                </label>
                <ToolbarBtn title="Rotate left 90°" onClick={() => rotate(-90)}><RotateCcw size={15} /></ToolbarBtn>
                <ToolbarBtn title="Rotate right 90°" onClick={() => rotate(90)}><RotateCw size={15} /></ToolbarBtn>
                {type === 'docShape' && (
                  <>
                    <label style={{ fontSize: 11, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      Fill <input type="color" value={attrs.fillColor || '#dbeafe'} onChange={(e) => activeEditor.chain().focus().updateAttributes('docShape', { fillColor: e.target.value }).run()}
                        style={{ width: 22, height: 22, padding: 0, border: '1px solid var(--line)', borderRadius: 5, cursor: 'pointer' }} />
                    </label>
                    <label style={{ fontSize: 11, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      Stroke <input type="color" value={attrs.strokeColor || '#2563eb'} onChange={(e) => activeEditor.chain().focus().updateAttributes('docShape', { strokeColor: e.target.value }).run()}
                        style={{ width: 22, height: 22, padding: 0, border: '1px solid var(--line)', borderRadius: 5, cursor: 'pointer' }} />
                    </label>
                  </>
                )}
                {type === 'docTextbox' && (
                  <>
                    <label style={{ fontSize: 11, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      Border <input type="color" value={attrs.borderColor || '#9ca3af'} onChange={(e) => activeEditor.chain().focus().updateAttributes('docTextbox', { borderColor: e.target.value }).run()}
                        style={{ width: 22, height: 22, padding: 0, border: '1px solid var(--line)', borderRadius: 5, cursor: 'pointer' }} />
                    </label>
                    <label style={{ fontSize: 11, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      Fill <input type="color" value={attrs.fillColor && attrs.fillColor !== 'transparent' ? attrs.fillColor : '#ffffff'}
                        onChange={(e) => activeEditor.chain().focus().updateAttributes('docTextbox', { fillColor: e.target.value }).run()}
                        style={{ width: 22, height: 22, padding: 0, border: '1px solid var(--line)', borderRadius: 5, cursor: 'pointer' }} />
                    </label>
                  </>
                )}
                {type === 'image' && (
                  <label style={{ fontSize: 11, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 4, flex: 1, minWidth: 140 }}>
                    Alt text
                    <input value={attrs.alt || ''} placeholder="Describe this image…"
                      onChange={(e) => activeEditor.chain().focus().updateAttributes('image', { alt: e.target.value }).run()}
                      style={{ flex: 1, fontSize: 12, border: '1px solid var(--line)', borderRadius: 7, padding: '4px 7px', color: 'var(--ink)', background: 'var(--card)' }} />
                  </label>
                )}
              </>
            );
          })()}
        </div>
      )}

      <div style={{ display: 'flex', gap: 18, alignItems: 'flex-start' }}>
      {kind === 'document' && !preview && (() => {
        const canvas = pageCanvasStyle(pageSetup);
        const thumbW = 92, thumbH = Math.round(thumbW * (canvas.minHeight / canvas.maxWidth));
        const scale = thumbW / canvas.maxWidth;
        return (
          <div style={{ flex: '0 0 116px', display: 'flex', flexDirection: 'column', gap: 8, background: 'var(--mist)', border: '1px solid var(--line)', borderRadius: 10, padding: 10, alignSelf: 'flex-start' }}>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Pages</div>
            {pages.map((p, i) => {
              const ed = editorsRef.current.get(p.id);
              const json = ed ? ed.getJSON() : (p.json || { type: 'doc', content: [{ type: 'paragraph' }] });
              return (
              <div key={p.id} style={{ position: 'relative' }}>
                <div onClick={() => goToPage(p.id)}
                  style={{ width: thumbW, height: thumbH, border: p.id === activePageId ? '2px solid hsl(var(--color-blue))' : '1px solid var(--line)', borderRadius: 6, overflow: 'hidden', background: '#fff', boxShadow: 'var(--shadow-sm)', cursor: 'pointer' }}>
                  <div style={{ width: canvas.maxWidth, transform: `scale(${scale})`, transformOrigin: 'top left', pointerEvents: 'none' }}
                    dangerouslySetInnerHTML={{ __html: generateHTML(json, BODY_EXTENSIONS) }} />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 3, gap: 2 }}>
                  <span onClick={() => goToPage(p.id)} style={{ fontSize: 10.5, color: 'var(--muted)', fontWeight: 600, cursor: 'pointer' }}>Page {i + 1}</span>
                  <button onClick={() => setPageMenuOpen(pageMenuOpen === p.id ? '' : p.id)} title="Page options"
                    style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', padding: 1, color: 'var(--muted)', flex: '0 0 auto' }}>
                    <MoreVertical size={13} />
                  </button>
                </div>
                {pageMenuOpen === p.id && (<>
                  <div onClick={() => setPageMenuOpen('')} style={{ position: 'fixed', inset: 0, zIndex: 29 }} />
                  <div style={{ position: 'absolute', top: '100%', right: 0, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 9, boxShadow: 'var(--shadow-lg)', zIndex: 30, minWidth: 190, padding: 5 }}>
                    <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', padding: '4px 8px', textTransform: 'uppercase', letterSpacing: '0.03em' }}>Duplicate page</div>
                    <button onClick={() => duplicatePage(i, true)}
                      style={{ display: 'flex', alignItems: 'center', gap: 7, width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: '7px 8px', borderRadius: 6, cursor: 'pointer', fontSize: 12.5, color: 'var(--ink)' }}>
                      <Copy size={13} /> With all contents
                    </button>
                    <button onClick={() => duplicatePage(i, false)} title="Keeps headings/tables/lists, clears the actual text and images"
                      style={{ display: 'flex', alignItems: 'center', gap: 7, width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: '7px 8px', borderRadius: 6, cursor: 'pointer', fontSize: 12.5, color: 'var(--ink)' }}>
                      <PageIcon size={13} /> With format only (layout, no text)
                    </button>
                    {pages.length > 1 && (<>
                      <div style={{ borderTop: '1px solid var(--line)', margin: '4px 0' }} />
                      <button onClick={() => deletePage(i)}
                        style={{ display: 'flex', alignItems: 'center', gap: 7, width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: '7px 8px', borderRadius: 6, cursor: 'pointer', fontSize: 12.5, color: 'hsl(var(--color-red))' }}>
                        <Trash2 size={13} /> Delete page
                      </button>
                    </>)}
                  </div>
                </>)}
              </div>
              );
            })}
            <button onClick={addPage}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, width: thumbW, height: 40, border: '1px dashed var(--line)', borderRadius: 6, background: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600, color: 'var(--muted)' }}>
              <Plus size={14} /> Add page
            </button>
          </div>
        );
      })()}
      <div style={{ flex: 1, minWidth: 0, background: 'var(--mist)', borderRadius: 12, padding: '20px 24px 4px' }}>

      {!preview && !headerVisible && (
        <button onClick={() => setHeaderVisible(true)}
          style={{ background: 'none', border: 'none', color: 'var(--muted)', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', marginBottom: 6 }}>+ Add header</button>
      )}
      {/* Letterhead (logo/name, read-only) and header (editable) sit in the
          SAME row, aligned with each other - not one stacked above the
          other, which read as two unrelated bands. Shown once (not
          per-page): the letterhead used to repeat on every sheet, but
          header/footer can't (TipTap can't mount one editor instance twice),
          and having the letterhead repeat while its aligned header didn't
          made the misalignment worse, not better - consistent beats
          "technically repeats" here. */}
      {(activeLetterhead || headerVisible) && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, maxWidth: pageCanvasStyle(pageSetup).maxWidth, margin: '0 auto 16px', paddingBottom: 12, borderBottom: '2px solid #111827' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            {activeLetterhead?.logoPath && <img src={activeLetterhead.logoPath} alt={activeLetterhead.name} style={{ height: 34, maxWidth: 140, objectFit: 'contain', flex: '0 0 auto' }} />}
            {activeLetterhead && (
              <div style={{ minWidth: 0 }}>
                <div className="doc-letterhead-name" style={{ whiteSpace: 'nowrap' }}>{activeLetterhead.name}</div>
                {activeLetterhead.address && <div className="doc-letterhead-address">{activeLetterhead.address}</div>}
              </div>
            )}
          </div>
          {headerVisible && (
            <div style={{ flex: '1 1 auto', maxWidth: 340, textAlign: 'right' }}>
              {!preview && (
                <button onClick={() => { setHeaderVisible(false); headerEditor?.commands.clearContent(); scheduleSave(); }}
                  style={{ float: 'right', background: 'none', border: 'none', color: 'var(--muted)', fontSize: 10.5, cursor: 'pointer', marginBottom: 2 }}>Remove header</button>
              )}
              <div style={{ clear: 'both' }}><EditorContent editor={headerEditor} className="doc-editor doc-inline-editor" /></div>
            </div>
          )}
        </div>
      )}

      {/* Each page is its own bounded sheet with real separation between them
          (the CSS gap/shadow doing double duty as both "this looks like
          stacked paper" AND the actual boundary between two independent
          editors) - not one continuous scroll with a dashed-line marker. */}
      {pages.map((p, i) => (
        <DocPage key={p.id} pageId={p.id} pageNumber={i + 1} pageCount={pages.length} docTitle={title || 'Untitled'} initialJson={p.json} editable={!preview} pageSetup={pageSetup} showMarks={showMarks}
          onReady={registerPageEditor} onUpdate={onPageUpdate}
          onActivity={onPageActivity} onPaste={onBodyPaste} onTocClick={goToTocLink} />
      ))}

      {/* Same alignment fix at the bottom: the letterhead's own footer
          tagline (if it has one) and the document's footer editor share one
          row instead of stacking. */}
      {(activeLetterhead?.footerJson?.text || footerVisible) && (
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, maxWidth: pageCanvasStyle(pageSetup).maxWidth, margin: '16px auto 0', paddingTop: 12, borderTop: '1px solid var(--line)' }}>
          {activeLetterhead?.footerJson?.text && <div className="doc-letterhead-tagline" style={{ margin: 0 }}>{activeLetterhead.footerJson.text}</div>}
          {footerVisible && (
            <div style={{ flex: '1 1 auto', maxWidth: 340, marginLeft: 'auto', textAlign: 'right' }}>
              {!preview && (
                <button onClick={() => { setFooterVisible(false); footerEditor?.commands.clearContent(); scheduleSave(); }}
                  style={{ float: 'right', background: 'none', border: 'none', color: 'var(--muted)', fontSize: 10.5, cursor: 'pointer', marginBottom: 2 }}>Remove footer</button>
              )}
              <div style={{ clear: 'both' }}><EditorContent editor={footerEditor} className="doc-editor doc-inline-editor" /></div>
            </div>
          )}
        </div>
      )}

      {!preview && !footerVisible && (
        <button onClick={() => setFooterVisible(true)}
          style={{ background: 'none', border: 'none', color: 'var(--muted)', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', marginTop: 6 }}>+ Add footer</button>
      )}
      </div>
      </div>
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

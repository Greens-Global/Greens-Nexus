import { Fragment, useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import { generateJSON, generateHTML } from '@tiptap/core';
import Placeholder from '@tiptap/extension-placeholder';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import {
  X, Eye, EyeOff, Bold, Italic, Underline, List, ListOrdered,
  Table as TableIcon, ImagePlus, SeparatorHorizontal, Undo, Redo, Check, AlertCircle, Award,
  Users, FileDown, Printer, Send, History, RotateCcw,
  AlignLeft, AlignCenter, AlignRight, AlignJustify, Link2, Link2Off, FileSearch,
  Shapes, Square, Circle, Minus, Triangle, ArrowRight, Type, Upload, Cloud, Sparkles, FileStack, ZoomIn, ZoomOut,
  Indent, Outdent, RotateCw, Rows, Columns, Combine, SquareSplitHorizontal, Trash2, Plus,
  Copy, MoreVertical, FileText as PageIcon, Pilcrow, PaintBucket,
  Paintbrush, Search, Smile, Bookmark,
  Scissors, ClipboardCopy, ClipboardPaste, Strikethrough, Subscript as SubscriptIcon, Superscript as SuperscriptIcon,
  Highlighter, ArrowDownAZ, ArrowUpZA, RectangleHorizontal, MousePointerSquareDashed, ListTree,
  Variable, Lock, LockOpen, Wand2, ListChecks, PenLine, BadgeCheck,
  Mic, Ruler as RulerIcon, PanelLeft, BookOpen, SpellCheck, Accessibility, MessageSquare, Hash, Stamp, HelpCircle,
  FilePlus, Eraser, Baseline, AlignVerticalSpaceAround, LayoutPanelTop, Columns2,
  FlipHorizontal, FlipVertical, Frame, Replace, Image as ImageIcon, Move, Crop,
} from 'lucide-react';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { Group, BigBtn, SmallBtn, Menu, ColorGrid, TableGrid, THEME_COLORS, STANDARD_COLORS, HIGHLIGHT_COLORS, useDismiss, RibbonBar, PickList, SizeBox } from './docRibbon/ui';
import StyleGallery from './docRibbon/StyleGallery';
import StatusBar from './docRibbon/StatusBar';
import { HRuler, VRuler, TabGlyph, TAB_LABEL } from './docRibbon/Ruler';
import { cleanTabStops, TAB_ALIGNS } from '../lib/docTabs';
import { numberFootnotes } from '../lib/docFootnote';
import { useTableValue } from '../tasks/tableCols';
import NavigationPane from './docRibbon/NavigationPane';
import RibbonDisplay from './docRibbon/RibbonDisplay';
import { ParagraphDialog, FontDialog } from './docRibbon/Dialogs';
import KeyTips from './docRibbon/KeyTips';
import VariablesPane from './docRibbon/VariablesPane';
import { WordCountDialog, AccessibilityDialog } from './docRibbon/WordCountDialog';
import { countWords, accessibilityIssues, headingsOf } from './docRibbon/docStats';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import CommentsPane from './docComments/CommentsPane';
import { useDocComments } from './docComments/useDocComments';
import { commentAnchorEl } from '../lib/docCommentMark';
import { useRole } from '../contexts/RoleContext';
import { canDictate, useDictation, spokenAfter } from '../lib/voice';
import { listChanges } from '../lib/docTrackChanges';
import { dialog } from '../ui/dialog';
import { isUntitled, suggestName, defaultName, UNTITLED_DOCUMENT, UNTITLED_TEMPLATE } from '../lib/untitled';
import NameOnClose from './docRibbon/NameOnClose';
import MenuBar, { ShortcutsCard } from './docRibbon/MenuBar';
import { STYLES as PARA_STYLES, currentStyle } from './docRibbon/StyleGallery';
import FullScreenButton, { useFullScreen } from './FullScreenButton';
import { api, API_BASE } from '../api';
import { MERGE_TOKENS, FRIENDLY_MERGE, SHAPE_DEFAULTS, WRAP_MODES } from '../lib/docBuilderExtensions';
import { FILLED_WHEN } from '../lib/mergeFieldTypes';
import { BODY_EXTENSIONS, LIVE_BODY_EXTENSIONS, repairDocJson } from '../lib/docBuilderSchema';
import { seedLiveDoc, validateLiveDoc, pageField, syncPageIds, isRemoteTr, LOCAL, livePageIds, livePageJson } from '../docLive/docModel';
import { useLiveSession } from '../docLive/useLiveSession';
import ShareDocumentDialog, { LivePeople } from '../docLive/ShareDocumentDialog';
import { caretColor } from '../notes/useNoteCollab';
import { uploadToSupabase, imageFromPaste } from '../lib/docBuilderUpload';
import { importDocumentFile } from '../lib/docBuilderImport';
import { slugifyToken, variableFromDrop } from '../lib/mergeFieldTypes';
import { extractVariables, mergeFieldDefs, sharedDefs, tokensInDoc } from '../lib/extractVariables';
import { Pagination, paginationKey, planBreaks, measureLines, posAtLineStart, marginGrowth, SHEET_SPACE_PX } from '../lib/docBuilderPagination';
import { PAGE_SIZES, ORIENTATIONS, MARGIN_PRESETS, DEFAULT_PAGE_SETUP, marginsOf, pageCanvasStyle, textFlowPx, sheetPadding, scrollableAncestor } from '../lib/pageSetup';
import { useIsMobile } from '../lib/useIsMobile';
import EgnyteBrowser from './EgnyteBrowser';
import DefineMergeFieldModal from './DefineMergeFieldModal';
import TemplateFieldsPanel from './TemplateFieldsPanel';
import VariableLibrary from './VariableLibrary';
import AnchoredMenu from './AnchoredMenu';
import { Spinner } from './AsyncState';
import { PersonSelect, usePeople } from '../tasks/components';
import { formatPacificDateTime } from '../lib/datetime';

const FONT_GROUPS = {
  'Sans-serif': ['Inter', 'Arial', 'Helvetica', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Segoe UI', 'Calibri', 'Roboto', 'Open Sans', 'Lato', 'Montserrat'],
  'Serif': ['Times New Roman', 'Georgia', 'Garamond', 'Cambria', 'Palatino Linotype', 'Book Antiqua'],
  'Monospace': ['Courier New', 'Consolas', 'Monaco', 'Lucida Console'],
  'Display': ['Comic Sans MS', 'Impact', 'Brush Script MT'],
};
// A complete {{token}} somewhere in the page's text - the cheap check that
// decides whether the (more expensive) conversion pass is worth running.
// Does this content say anything at all? Text, a picture, a variable chip, a
// shape or a table all count; a lone empty paragraph does not. Used to refuse
// a save that would blank a document that had content a moment ago.
const SUBSTANTIVE = new Set(['image', 'mergeField', 'docShape', 'docTextbox', 'table', 'pageBreak', 'bookmark', 'signatureBlock', 'footnote']);

// Who signs, when a template has no Signers list yet (Oct 14).
const DEFAULT_SIGNERS = [{ key: 'employee', label: 'Employee', order: 1 }, { key: 'company', label: 'Company', order: 2 }];
const signerKeyOf = (label) => String(label || '').trim().toLowerCase()
  .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
const chipTone = (tone) => ({
  fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 999, whiteSpace: 'nowrap',
  color: `hsl(var(--color-${tone}))`, background: `hsla(var(--color-${tone}), 0.12)`,
});

export function isEmptyContent(content) {
  let found = false;
  const walk = (n) => {
    if (found || !n || typeof n !== 'object') return;
    if (n.type === 'text' && (n.text || '').trim()) { found = true; return; }
    if (SUBSTANTIVE.has(n.type)) { found = true; return; }
    (n.content || []).forEach(walk);
  };
  for (const page of (content?.pages || [])) walk(page?.json);
  if (!found) { walk(content?.header); walk(content?.footer); }
  return !found;
}

const TOKEN_IN_PAGE_RE = /\{\{\s*[A-Za-z0-9_.]+\s*\}\}/;

const FONT_SIZES = ['10', '11', '12', '14', '16', '18', '20', '24', '28', '32', '36', '48'];
// Word's ribbon tabs (11/11/2026). Variables is Word's Mailings for Nexus.
const RIBBON_TABS = [['home', 'Home'], ['insert', 'Insert'], ['design', 'Design'], ['layout', 'Layout'], ['references', 'References'], ['variables', 'Variables'], ['review', 'Review'], ['view', 'View']];
const SYMBOL_CHARS = [
  '©', '®', '™', '°', '§', '¶', '†', '‡', '•', '…', '–', '—', '«', '»', '‹', '›', '“', '”', '‘', '’', '„', '¡', '¿', '‰', '№', '¦',
  '±', '×', '÷', '≈', '≠', '≤', '≥', '∞', '√', '∑', '∏', '∫', '∂', '∆', '∇', '∈', '∉', '∩', '∪', '⊂', '⊃', '∧', '∨', '¬', '∝', '∴', '∵', '∠', '⊥', '∥', '‖', '⁄', '¹', '²', '³', '½', '¼', '¾', '⅓', '⅔', '⅛', '⅜', '⅝', '⅞', 'µ',
  '€', '£', '¥', '¢', '₹', '₽', '₩', '₺', '₫', '฿', '₪',
  'α', 'β', 'γ', 'δ', 'ε', 'ζ', 'η', 'θ', 'λ', 'μ', 'π', 'ρ', 'σ', 'τ', 'φ', 'χ', 'ψ', 'ω', 'Γ', 'Δ', 'Θ', 'Λ', 'Ξ', 'Π', 'Σ', 'Φ', 'Ψ', 'Ω',
  '→', '←', '↑', '↓', '↔', '↕', '⇒', '⇐', '⇔', '↗', '↘', '↩', '↪', '⟶', '➔', '➜', '➤',
  '✓', '✔', '✗', '✘', '☐', '☑', '☒', '★', '☆', '✦', '✧', '♦', '♠', '♣', '♥', '◆', '◇', '■', '□', '▪', '▫', '●', '○', '◦', '▲', '▼', '◄', '►', '◊', '†', '☎', '✉', '✂', '✎', '✏', '⌘', '⌥', '⇧', '⌫', '⏎',
  'À', 'Á', 'Â', 'Ä', 'Å', 'Æ', 'Ç', 'È', 'É', 'Ê', 'Ë', 'Ñ', 'Ö', 'Ø', 'Ü', 'ß', 'à', 'á', 'â', 'ä', 'å', 'æ', 'ç', 'è', 'é', 'ê', 'ë', 'ì', 'í', 'î', 'ï', 'ñ', 'ò', 'ó', 'ô', 'ö', 'ø', 'ù', 'ú', 'û', 'ü', 'ÿ', '℃', '℉', 'Ω', '℗', '℠',
];
const EMOJI_CHARS = [
  '😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣', '🙂', '😊', '😇', '😍', '🥰', '😘', '😎', '🤓', '🧐', '🤔', '🤨', '😐', '😶', '🙄', '😏', '😬', '😴', '😷', '🤒', '🤕', '🤢', '🥳', '😢', '😭', '😱', '😤', '😡', '🤯', '😳', '🥺', '🤗', '🤫', '🤭', '🫡', '🫠',
  '👍', '👎', '👌', '✌️', '🤞', '🤝', '👏', '🙌', '🙏', '💪', '👋', '🤙', '☝️', '👆', '👇', '👉', '👈', '✋', '🤲', '✍️', '👀', '👁️', '🧠', '🗣️',
  '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '💔', '💯', '✅', '❌', '⚠️', '❗', '❓', '‼️', '⭐', '🌟', '✨', '🔥', '💥', '💡', '🔔', '🔕', '🚫', '⛔', '🔴', '🟠', '🟡', '🟢', '🔵', '⚫', '⚪', '🔒', '🔓', '🔑',
  '📌', '📍', '📎', '🖇️', '📅', '📆', '🗓️', '⏰', '⏳', '⌛', '🕒', '📧', '📨', '📩', '📬', '📞', '☎️', '📱', '💻', '🖥️', '🖨️', '⌨️', '🖱️', '💾', '📀', '📷', '🎥', '🎬', '🎤', '🎧', '📢', '📣', '💬', '💭', '🗨️',
  '📈', '📉', '📊', '📋', '📁', '📂', '🗂️', '📄', '📃', '📑', '📰', '🗞️', '📚', '📖', '📝', '✏️', '🖊️', '🖋️', '✒️', '📏', '📐', '✂️', '🗑️', '🔍', '🔎', '🧾', '💰', '💵', '💳', '🧮', '🏷️', '🎯', '🏆', '🥇', '🥈', '🥉', '🎉', '🎊', '🎁', '🎈',
  '🚀', '✈️', '🚗', '🚚', '🏠', '🏢', '🏭', '🏗️', '🔧', '🔨', '🛠️', '⚙️', '🧰', '🔩', '🪜', '🧹', '🧯', '🪣', '🌍', '🌎', '🌏', '🗺️', '☀️', '🌤️', '☁️', '🌧️', '⛈️', '❄️', '🌈', '⚡', '🌡️', '☕', '🍕', '🍔', '🥗', '🍎', '🐶', '🐱', '🌱', '🌳', '🌸', '🌻', '🏖️', '⛺',
];
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
function DocPage({ pageId, pageNumber, pageCount, docTitle, initialJson, editable, pageSetup, compact, zoom, firstSheetPx, showMarks,
  bandInfo, sheetBase = 0, onSheets, topSlot, headerSlot, footerSlot, paginate = true, live = null,
  onReady, onUpdate, onActivity, onPaste, onVariableDrop, onTocClick }) {
  // Live (docLive/docModel.js): the page's words are its fragment of the
  // shared document, with everyone's named carets; otherwise its own JSON.
  const editor = useEditor({
    extensions: live
      ? [...LIVE_BODY_EXTENSIONS, Placeholder.configure({ placeholder: 'Start typing your document…' }), Pagination,
          Collaboration.configure({ document: live.doc, field: pageField(pageId) }),
          CollaborationCaret.configure({ provider: { awareness: live.awareness }, user: live.user })]
      : [...BODY_EXTENSIONS, Placeholder.configure({ placeholder: 'Start typing your document…' }), Pagination],
    content: live ? undefined : (initialJson || null),
    editable,
    onUpdate: ({ transaction }) => onUpdate(pageId, transaction),
    onSelectionUpdate: () => onActivity(pageId),
    editorProps: {
      // A variable dragged in (from the library or the Variables Used rail)
      // is placed here, as a chip, and ProseMirror is told the drop is
      // handled - left to itself it ALSO pastes the drag's plain-text
      // "{{token}}" fallback, which the detector then turns into a second
      // chip (Sagar, 11/04/2026: "it's coming two variables"). The page's
      // onDrop below sees the mark and leaves a handled drop alone.
      handleDrop: (view, event) => {
        const token = variableFromDrop(event);
        if (!token || !view.editable) return false;
        event.preventDefault();
        event.nxVariableHandled = true;
        const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
        const pos = at ? at.pos : view.state.selection.from;
        view.dispatch(view.state.tr.insert(pos, view.state.schema.nodes.mergeField.create({ token })));
        onActivity(pageId);
        return true;
      },
    },
  });
  useEffect(() => {
    if (!editor) return;
    // A page this person just added with words in it (Duplicate, an import):
    // live, its fragment starts empty - the words go in once, from here.
    if (live && initialJson && !live.doc.getXmlFragment(pageField(pageId)).length) editor.commands.setContent(initialJson);
    onReady(pageId, editor);
    return () => onReady(pageId, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);
  useEffect(() => { editor?.setEditable(editable); }, [editable, editor]);

  // The page's own geometry, in layout px: the margins the gutter bands and
  // the margin-dwelling header/footer are drawn in.
  const m = marginsOf(pageSetup);
  // A header or footer taller than its margin pushes the body away instead of
  // running over it (Word's behavior): the margin grows by what sticks out,
  // measured from the margin-dwelling band itself.
  const [grow, setGrow] = useState({ top: 0, bottom: 0 });
  const headRef = useRef(null);
  const footRef = useRef(null);
  const baseMt = Math.round(m.top * 96);
  const baseMb = Math.round(m.bottom * 96);
  const headPad = Math.round(baseMt * 0.38);
  const footPad = Math.round(baseMb * 0.38);
  useEffect(() => {
    if (compact || typeof ResizeObserver === 'undefined') return undefined;
    const measure = () => {
      const z = zoom || 1;
      const h = (el) => (el ? el.getBoundingClientRect().height / z : 0);
      const next = { top: marginGrowth(baseMt, headPad, h(headRef.current)), bottom: marginGrowth(baseMb, footPad, h(footRef.current)) };
      setGrow((g) => (g.top === next.top && g.bottom === next.bottom ? g : next));
    };
    const ro = new ResizeObserver(measure);
    if (headRef.current) ro.observe(headRef.current);
    if (footRef.current) ro.observe(footRef.current);
    measure();
    return () => ro.disconnect();
  }, [compact, zoom, baseMt, baseMb, headPad, footPad]);
  const geometry = useMemo(() => ({
    mt: baseMt + grow.top, mb: baseMb + grow.bottom, headPad, footPad,
    pl: Math.round(m.left * 96), pr: Math.round(m.right * 96),
    pageColor: pageSetup.pageColor || '#fff',
  }), [baseMt, baseMb, grow.top, grow.bottom, headPad, footPad, m.left, m.right, pageSetup.pageColor]);
  // What every gutter band shows: header/footer HTML and the page total, plus
  // where this page's sheets start in the whole document.
  const revRef = useRef(0);
  const info = useMemo(() => ({ ...(bandInfo || {}), geometry, base: sheetBase, rev: ++revRef.current }),
    [bandInfo, geometry, sheetBase]);
  const infoRef = useRef(info);
  useEffect(() => {
    infoRef.current = info;
    if (!editor || editor.isDestroyed) return;
    editor.view.dispatch(editor.state.tr.setMeta(paginationKey, { info }));
  }, [info, editor]);
  const [sheets, setSheets] = useState(1);

  // ── Lay the content out onto sheets ───────────────────────────────────────
  // Measure the top-level blocks as they actually sit, work out where each
  // sheet runs out, and lay a gutter in there - between two blocks, or
  // between two lines of a paragraph. The measurement subtracts the gutters
  // already laid in, or every pass would add another one and the document
  // would walk down the screen. Phones and multi-column pages flow freely.
  const grown = grow.top + grow.bottom;
  const sheetPx = compact || pageSetup.columns > 1 || !paginate ? 0 : Math.max(1, textFlowPx(pageSetup) - grown);
  const firstPx = firstSheetPx ? Math.max(1, firstSheetPx - grown) : undefined;
  const repaginate = useCallback(() => {
    if (!editor || editor.isDestroyed) return;
    if (!sheetPx) {
      // View > Separate Pages off (or a phone): one continuous flow, no gutters.
      if (paginationKey.getState(editor.state)?.breaks?.length) editor.view.dispatch(editor.state.tr.setMeta(paginationKey, { breaks: [] }));
      setSheets(1);
      onSheets?.(pageId, 1);
      return;
    }
    const dom = editor.view.dom;
    const children = Array.from(dom.children);
    const kids = children.filter((el) => !el.classList.contains('doc-sheet-gutter'));
    if (!kids.length) return;
    const z = zoom || 1;
    const prev = paginationKey.getState(editor.state)?.breaks || [];

    // Gutter height already laid in, by the block whose span holds it: one
    // between blocks sits in the span of the block above it, one inside a
    // paragraph sits in that paragraph's own span.
    const laidIn = new Map();
    let blockIdx = -1;
    const add = (i, el) => laidIn.set(i, (laidIn.get(i) || 0) + el.getBoundingClientRect().height / z);
    for (const el of children) {
      if (el.classList.contains('doc-sheet-gutter')) { if (blockIdx >= 0) add(blockIdx, el); continue; }
      blockIdx += 1;
      for (const g of el.querySelectorAll('.doc-sheet-gutter')) add(blockIdx, g);
    }

    const originTop = dom.getBoundingClientRect().top;
    const tops = kids.map((el) => (el.getBoundingClientRect().top - originTop) / z);
    const total = dom.getBoundingClientRect().height / z;
    const heights = kids.map((_, i) => {
      const next = i + 1 < tops.length ? tops[i + 1] : total;
      return Math.max(0, next - tops[i] - (laidIn.get(i) || 0));
    });

    // index -> document position, so a gutter can be placed before the block.
    const posByIndex = [];
    editor.state.doc.forEach((_node, offset) => { posByIndex.push(offset); });
    const next = [];
    // An Insert > Page Break marker ends its sheet: the block after it starts the next.
    const forced = (i) => i > 0 && kids[i - 1].classList.contains('doc-pagebreak');
    for (const b of planBreaks(heights, sheetPx, firstPx, (i) => measureLines(kids[i], z), forced)) {
      if (posByIndex[b.index] === undefined) continue;
      if (!b.line) { next.push({ index: b.index, gap: b.gap, pos: posByIndex[b.index] }); continue; }
      const pos = posAtLineStart(editor.view, kids[b.index], b.line);
      if (pos == null) continue;   // nothing to anchor to: the paragraph runs across, as before
      next.push({ index: b.index, gap: b.gap, pos, line: true });
    }

    const same = next.length === prev.length
      && next.every((b, i) => prev[i] && prev[i].pos === b.pos && Math.abs(prev[i].gap - b.gap) < 1);
    if (same) return;   // nothing to do - and dispatching anyway would loop
    editor.view.dispatch(editor.state.tr.setMeta(paginationKey, { breaks: next, info: infoRef.current }));
    setSheets(next.length + 1);
    onSheets?.(pageId, next.length + 1);
  }, [editor, sheetPx, firstPx, zoom, onSheets, pageId]);

  // Re-lay out after content, geometry or zoom changes. rAF lets the browser
  // finish the layout we are about to measure.
  useEffect(() => {
    if (!editor) return undefined;
    let raf = 0;
    let timer = 0;
    const run = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { raf = requestAnimationFrame(repaginate); }, 180);
    };
    run();
    editor.on('update', run);
    return () => { editor.off('update', run); clearTimeout(timer); cancelAnimationFrame(raf); };
  }, [editor, repaginate]);

  const border = pageSetup.pageBorder;
  const g = geometry;
  // The text frame is always whole sheets tall, so the last sheet is a full
  // page with its footer in the bottom margin, never a page cut off under
  // the last line.
  const frameMin = sheetPx ? (firstPx || sheetPx) + (sheets - 1) * (sheetPx + g.mb + SHEET_SPACE_PX + g.mt) : undefined;
  const total = bandInfo?.total || pageCount;
  const staticBand = (html) => <div className="doc-sheet-head-text" dangerouslySetInnerHTML={{ __html: html || '' }} />;
  // Insert > Page Numbers: where the number sits on this page's own margins
  // (the gutter bands between sheets follow the same choice).
  const numbersAt = bandInfo?.pageNumbers || 'bottom-right';
  const numberSide = numbersAt.split('-')[1] || 'right';
  return (
    <div className={`doc-page${pageSetup.lineNumbers ? ' doc-line-numbers' : ''}`}
      style={{
        display: 'flex', flexDirection: 'column', margin: '0 auto 28px', ...pageCanvasStyle(pageSetup, { compact }),
        ...(!compact && (grow.top || grow.bottom) ? { paddingTop: g.mt, paddingBottom: g.mb } : {}),
        background: pageSetup.pageColor || '#fff',
        border: border?.style ? `${border.width || 1}px ${border.style} ${border.color || '#111827'}` : undefined,
      }}
      onFocus={() => onActivity(pageId)}
      onClick={(e) => {
        const link = e.target.closest && e.target.closest('a[href^="#toc:"]');
        if (link) { e.preventDefault(); onTocClick(link.getAttribute('href')); return; }
        onActivity(pageId);
      }}>
      {pageSetup.watermark && <div className="doc-page-watermark" aria-hidden="true">{pageSetup.watermark}</div>}
      {compact ? (headerSlot && <div style={{ marginBottom: 8 }}>{headerSlot}</div>) : (
        <div className="doc-page-margin-head" style={{ left: g.pl, right: g.pr, top: headPad, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
          <div ref={headRef} style={{ flex: '1 1 auto', minWidth: 0 }}>{headerSlot ?? staticBand(bandInfo?.headerHtml)}</div>
          {numbersAt.startsWith('top') && <span className={`doc-page-pageno is-${numberSide}`} style={{ flex: '0 0 auto', whiteSpace: 'nowrap', userSelect: 'none' }}>Page {sheetBase + 1} of {total}</span>}
        </div>
      )}
      {topSlot}
      <div style={{ flex: 1, minHeight: frameMin, columnCount: pageSetup.columns > 1 ? pageSetup.columns : undefined, columnGap: pageSetup.columns > 1 ? 32 : undefined }}>
        <EditorContent editor={editor} className={`doc-editor${showMarks ? ' show-marks' : ''}`}
          onPaste={(e) => onPaste(pageId, e)}
          // dragOver must be cancelled or the browser refuses the drop.
          onDragOver={(e) => { if (editable) e.preventDefault(); }}
          onDrop={(e) => { if (editable) onVariableDrop(pageId, e); }} />
      </div>
      {compact ? (
        <>
          {footerSlot && <div style={{ marginTop: 8 }}>{footerSlot}</div>}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, fontSize: 10.5, color: '#9ca3af', marginTop: 10, paddingTop: 8, borderTop: '1px solid #eceef1', userSelect: 'none' }}>{/* type-ok: the document page footer (paper) */}
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{docTitle}</span>
            <span style={{ flex: '0 0 auto' }}>Page {pageNumber} of {pageCount}</span>
          </div>
        </>
      ) : (
        /* The last sheet's footer, in the bottom margin like every other
           sheet's (the gutter bands draw the ones in between). */
        <div className="doc-page-margin-foot" style={{ left: g.pl, right: g.pr, bottom: footPad, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12 }}>
          <div ref={footRef} style={{ flex: '1 1 auto', minWidth: 0 }}>{footerSlot ?? staticBand(bandInfo?.footerHtml)}</div>
          {numbersAt.startsWith('bottom') && <span className={`doc-page-pageno is-${numberSide}`} style={{ flex: '0 0 auto', whiteSpace: 'nowrap', userSelect: 'none' }}>Page {sheetBase + sheets} of {total}</span>}
        </div>
      )}
    </div>
  );
}

// A menu at the mouse (Word's right-click on a picture). Items are
// { label, icon, hint, onClick, active, heading, sub } or '-'.
function ContextMenu({ x, y, items, onClose }) {
  const ref = useRef(null);
  useDismiss(ref, true, onClose);
  const left = Math.min(x, (typeof window !== 'undefined' ? window.innerWidth : 9999) - 240);
  const top = Math.min(y, (typeof window !== 'undefined' ? window.innerHeight : 9999) - 420);
  return (
    <div ref={ref} className="doc-ribbon-panel doc-ctx-menu" role="menu" style={{ position: 'fixed', left, top, width: 230 }}>
      {items.map((it, i) => (it === '-' ? <div key={i} className="doc-ribbon-sep" /> : it.heading ? (
        <div key={it.label} className="doc-ctx-heading">{it.label}</div>
      ) : (
        <button key={it.label} type="button" role="menuitem" className={`doc-ribbon-item${it.active ? ' is-active' : ''}${it.sub ? ' is-sub' : ''}`}
          onClick={() => { it.onClick?.(); onClose(); }}>
          {it.icon && <it.icon size={14} />}
          <span style={{ flex: 1 }}>{it.label}</span>
          {it.hint && <span className="doc-ctx-hint">{it.hint}</span>}
        </button>
      )))}
    </div>
  );
}


function DocumentBuilderInner({ docId, kind = 'document', employees = [], entities = [], onClose, toastOk, toastErr, quickSections = [], onContentSaved, live = null, readOnly = false }) {
  const { get: apiGet, update: apiUpdate, nameKey, getVersions, getVersion } = KIND_API[kind];
  // Phone layout. The editor is a Word-shaped surface - a fixed-width page, a
  // 36-button ribbon and a thumbnail rail - none of which fit a 375px screen
  // as authored, so each is given a phone form rather than being hidden.
  const isMobile = useIsMobile();
  const [doc, setDoc] = useState(null);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState('');
  const [preview, setPreview] = useState(false);
  // Canvas zoom (Sagar, Sep 17). CSS `zoom`, not `transform: scale()` - zoom
  // reflows the layout box, so ProseMirror's caret placement and posAtCoords
  // stay correct. A transform leaves the layout box at its old size and the
  // editor then puts the caret where the text used to be, which is exactly the
  // class of bug this module already fought once.
  const [zoom, setZoom] = useState(1);
  // Requirement 7: a generated document is FINAL - it carries the approved
  // template language with the supplied values, so it is not freely editable
  // afterwards. The server enforces this (documents.py refuses a content
  // PATCH on a final document); this is the same rule made visible, so nobody
  // types into a page whose save is going to be rejected.
  const [unlocking, setUnlocking] = useState(false);
  const isLocked = kind === 'document' && doc?.status === 'final';
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
  // Picture Format (Pranshu, 11/05/2026: Word Online's Picture tab and its
  // right-click menu). The tab shows while a picture is selected.
  const [lockAspect, setLockAspect] = useState(true);
  const [imgMenu, setImgMenu] = useState(null);           // { x, y } of the open right-click menu
  const [cropping, setCropping] = useState(false);        // Picture > Crop: the edge handles are out
  const changePictureRef = useRef(false);                 // the next picked file replaces the selected picture
  const [saveStatus, setSaveStatus] = useState('idle');
  const [shareOpen, setShareOpen] = useState(false);
  // Whether this document has ever held real content in this session - the
  // empty-save guard only bites once we know there is something to lose.
  const lastGoodRef = useRef(false);
  // Emptying a document ON PURPOSE stays possible: Ctrl+S saves exactly what
  // is on screen. It is only the unattended autosave that refuses to blank a
  // document, because an autosave firing on a half-built editor is what caused
  // the loss - nobody asked for that write.
  const [headerVisible, setHeaderVisible] = useState(false);
  const [footerVisible, setFooterVisible] = useState(false);
  const [letterheads, setLetterheads] = useState([]);
  const [letterheadId, setLetterheadId] = useState('');
  const [requiresLetterhead, setRequiresLetterhead] = useState(false);
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
  const [exporting, setExporting] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [versions, setVersions] = useState(null);
  const [restoringId, setRestoringId] = useState('');
  const [linkPopoverOpen, setLinkPopoverOpen] = useState(false);
  const [linkUrlDraft, setLinkUrlDraft] = useState('');
  const [pdfPreviewUrl, setPdfPreviewUrl] = useState('');
  const [pdfPreviewLoading, setPdfPreviewLoading] = useState(false);

  // ── Preview fills the window ────────────────────────────────────────────
  // Sagar, Sep 17: "make the preview window larger and expand the height of
  // the window to the bottom of the screen", and move the action row up.
  //
  // The box was minHeight:70vh, so it stopped well short of the bottom and
  // left dead space under a document people read page by page. What sits
  // above it is not a constant we can subtract - .viewport's padding alone is
  // set at seven breakpoints, from 32px down to 8px - so measure where the box
  // actually begins and claim the rest of the window. The negative bottom
  // margin cancels .viewport's own bottom padding, which would otherwise
  // become a scrollbar the moment the box reaches the bottom edge.
  const previewBoxRef = useRef(null);
  const [previewFill, setPreviewFill] = useState(null);
  const [previewPull, setPreviewPull] = useState(0);
  useLayoutEffect(() => {
    if (!preview) { setPreviewFill(null); setPreviewPull(0); return; }
    const measure = () => {
      const el = previewBoxRef.current;
      if (!el) return;
      const vp = el.closest('.viewport');
      const cs = vp ? getComputedStyle(vp) : null;
      const padB = cs ? parseFloat(cs.paddingBottom) || 0 : 0;
      const padT = cs ? parseFloat(cs.paddingTop) || 0 : 0;
      // Lift the action row toward the top, but never eat the gutter whole -
      // at the 8px breakpoint there is nothing to reclaim.
      setPreviewPull(Math.min(14, Math.max(0, padT - 8)));
      const top = el.getBoundingClientRect().top;
      setPreviewFill({ height: Math.max(340, Math.round(window.innerHeight - top)), marginBottom: -padB });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [preview, pdfPreviewUrl, pdfPreviewLoading]);
  const [shapePopoverOpen, setShapePopoverOpen] = useState(false);
  const [shapeFill, setShapeFill] = useState('#dbeafe');
  const [shapeStroke, setShapeStroke] = useState('#2563eb');
  const [shapeWrapMode, setShapeWrapMode] = useState('inline');
  const [importPopoverOpen, setImportPopoverOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [egnyteOpen, setEgnyteOpen] = useState(false);
  // Template Builder (Phase 13) - field_defs is the single source of truth for
  // a merge field's type/required/default/validation; only meaningful when
  // kind==='template' (Documents generated from one just carry resolved
  // values, not the field metadata itself).
  const [fieldDefs, setFieldDefs] = useState([]);
  // Signature blocks + Publish (Oct 14). signerRoles is the template's Signers
  // list - who signs a document made from it, in order; a signature block
  // names one of them. Publishing releases the wording to the HR packets.
  const [signerRoles, setSignerRoles] = useState([]);
  const [sigPopoverOpen, setSigPopoverOpen] = useState(false);
  const [sigDraft, setSigDraft] = useState({ role: '', label: '', withName: true, withDate: true, newSigner: '' });
  const [publishing, setPublishing] = useState(false);
  // Template Fields panel: every variable and the type of answer it takes.
  // `newTokens` are the ones an import/paste just added, marked NEW in the list.
  const [fieldsPanel, setFieldsPanel] = useState(null);   // null | { newTokens: [] }
  const [mergeFieldModal, setMergeFieldModal] = useState(null); // null | { range?: {from,to}, existingDef?: object, initialLabel?: string }
  // The Variables rail (Sagar, 11/04/2026), on demand (Neil, 11/11/2026):
  // In This Document or Add More (the library), over the right margin.
  const [varsOpen, setVarsOpen] = useState(false);
  const [varsTab, setVarsTab] = useState('used');
  // Variables > Preview Results (Word's Mailings): every chip shows the value
  // the document will print - the same resolution an export uses
  // (GET /documents/{id}/merge-values); a template shows its Merge Data
  // defaults. Highlight Fields: Word's gray field shading, on by default.
  const [previewResults, setPreviewResults] = useState(false);
  const [previewValues, setPreviewValues] = useState(null);
  const [fieldShading, setFieldShading] = useState(true);
  // The variables placed in THIS document, in page order, each with how many
  // places it is used (Sagar, 11/04/2026: "whatever variable is used in that
  // particular document it should be listed at right side so we can reuse the
  // same variable wherever we want"). The rail beside the pages lists them;
  // scanUsedVars (below the header and footer editors) fills it, debounced,
  // because it reads every page's JSON.
  const [usedVars, setUsedVars] = useState([]);
  const usedTimerRef = useRef(null);
  const scanUsedVarsRef = useRef(null);
  const scheduleUsedScan = useCallback(() => {
    if (usedTimerRef.current) clearTimeout(usedTimerRef.current);
    usedTimerRef.current = setTimeout(() => { usedTimerRef.current = null; scanUsedVarsRef.current?.(); }, 300);
  }, []);
  useEffect(() => () => { if (usedTimerRef.current) clearTimeout(usedTimerRef.current); }, []);
  // The Make Variable bubble: where the current text selection starts on
  // screen while a template page has one (a double-click selects the word).
  const [selBubble, setSelBubble] = useState(null);
  // /documents/variables: every built-in (with WHEN Nexus fills it) and every
  // custom field the other templates define - the insert picker's groups, the
  // Template Fields panel's Filled By Nexus rows and its shared definitions.
  const [variables, setVariables] = useState([]);
  const [activating, setActivating] = useState(false);
  // Page Setup (Phase 14) - content.pageSetup, a sibling of body/header/footer
  // in the same JSON blob (no schema change needed).
  const [pageSetup, setPageSetup] = useState(DEFAULT_PAGE_SETUP);
  // Read inside goToSheet, which is a stable callback - refs keep it stable
  // instead of rebuilding every thumbnail's handler on each zoom keystroke.
  const pageSetupRef = useRef(pageSetup);
  useEffect(() => { pageSetupRef.current = pageSetup; }, [pageSetup]);
  const zoomRef = useRef(1);
  useEffect(() => { zoomRef.current = zoom; }, [zoom]);
  const [pageSetupOpen, setPageSetupOpen] = useState(false);
  // Word's View tab, this browser only: Separate Pages (pagination), Ruler,
  // Navigation pane; Review > Spelling (the browser's own spellcheck).
  const [viewPrefs, setViewPrefs] = useState({ paginate: true, nav: false, spell: true });
  const setPref = (k, v) => setViewPrefs((p) => ({ ...p, [k]: v }));
  // View > Ruler: on by default, both rulers (Neil, 11/11/2026); turning it
  // off is remembered in the person's profile, on every computer.
  const [rulerOn, setRulerOn] = useTableValue('documents', 'ruler', true);
  // The tab stop a click on the ruler sets - the box in the rulers' corner.
  const [tabType, setTabType] = useState('left');
  // Word's dialog launchers: Font (Ctrl+D) and Paragraph.
  const [fontDlg, setFontDlg] = useState(false);
  const [paraDlg, setParaDlg] = useState(false);
  // View > Navigation (Word's pane, 11/11/2026): Headings, Pages or Results.
  // It floats in the desk margin beside the page and is off until opened -
  // the old always-on Pages rail lives in its Pages tab.
  const [navTab, setNavTab] = useState('headings');
  const [navQuery, setNavQuery] = useState('');
  const [navHit, setNavHit] = useState(-1);
  const openNav = (tab) => { setNavTab(tab); setPref('nav', true); };
  // Review > Track Changes (Pranshu, 11/05/2026), as Word Online has it:
  // Off / For Everyone (saved with the document, so whoever opens it next
  // keeps tracking) / Just Mine (this browser only); Markup On Page shows the
  // insertions and deletions, Markup In Margin the final text with a bar.
  // Viewing is Word's read-only mode. lib/docTrackChanges.js does the work.
  const [tracking, setTracking] = useState('off');      // off | everyone | mine
  const [markupView, setMarkupView] = useState('all');  // all | simple
  const [viewingOnly, setViewingOnly] = useState(false);
  const [wordCountOpen, setWordCountOpen] = useState(false);
  // Comments (Review tab, Nov 2026): the threads live on the server
  // (routers/doc_comments.py), the page keeps one `comment` mark per thread,
  // and the pane opens beside the pages.
  const { myEmail: me = '', myLevel = 1 } = useRole() || {};
  const commentStore = useDocComments(kind, docId);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [activeComment, setActiveComment] = useState('');
  const [commentDraft, setCommentDraft] = useState(null);
  // The active thread's mark lights up; a click on any mark opens its thread.
  useEffect(() => {
    document.querySelectorAll('.doc-comment-mark.is-active').forEach((el) => el.classList.remove('is-active'));
    if (activeComment) document.querySelectorAll(`[data-comment-id="${CSS.escape(activeComment)}"]`).forEach((el) => el.classList.add('is-active'));
  }, [activeComment, commentStore.comments]);
  useEffect(() => {
    const onClick = (e) => {
      const el = e.target.closest?.('[data-comment-id]');
      if (!el || !e.target.closest('.doc-page')) return;
      setActiveComment(el.getAttribute('data-comment-id'));
      setCommentsOpen(true);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);
  // A thread deleted, by anyone, takes its mark with it.
  useEffect(() => {
    if (commentStore.loading) return;
    const ids = new Set(commentStore.comments.map((c) => c.id));
    for (const ed of editorsRef.current.values()) {
      const stale = new Set();
      ed.state.doc.descendants((n) => { n.marks.forEach((m) => { if (m.type.name === 'comment' && m.attrs.id && !ids.has(m.attrs.id)) stale.add(m.attrs.id); }); });
      stale.forEach((id) => ed.commands.unsetComment(id));
    }
  }, [commentStore.comments, commentStore.loading]);
  const [a11yIssues, setA11yIssues] = useState(null);
  const [full, toggleFull] = useFullScreen('documents');
  // The menu bar's two of its own (Neil, 11/10/2026): the shortcuts card, and
  // Word's Collapse Ribbon (Ctrl+F1) - the tabs stay, the buttons fold away;
  // remembered in this browser.
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // Ribbon Display Options (Word's, 11/11/2026): Classic (the full ribbon),
  // Simplified (one line of the most used buttons, as Word Online) or Show
  // Tabs Only (Ctrl+F1 - the old Collapse Ribbon). Remembered in this browser;
  // the old collapsed flag still reads as Tabs Only.
  const [ribbonMode, setRibbonModeState] = useState(() => {
    try {
      const m = localStorage.getItem('nexus.docRibbonMode');
      if (m === 'classic' || m === 'simplified' || m === 'tabs') return m;
      return localStorage.getItem('nexus.docRibbonCollapsed') === '1' ? 'tabs' : 'classic';
    } catch { return 'classic'; }
  });
  const lastOpenModeRef = useRef(ribbonMode === 'tabs' ? 'classic' : ribbonMode);
  const setRibbonMode = useCallback((m) => {
    if (m !== 'tabs') lastOpenModeRef.current = m;
    setRibbonModeState(m);
    try { localStorage.setItem('nexus.docRibbonMode', m); } catch { /* private mode: this visit only */ }
  }, []);
  const ribbonCollapsed = ribbonMode === 'tabs';
  const setRibbonCollapsed = useCallback((v) => setRibbonMode(v ? 'tabs' : lastOpenModeRef.current), [setRibbonMode]);
  const toggleRibbon = useCallback(() => setRibbonModeState((cur) => {
    const next = cur === 'tabs' ? lastOpenModeRef.current : 'tabs';
    if (cur !== 'tabs') lastOpenModeRef.current = cur;
    try { localStorage.setItem('nexus.docRibbonMode', next); } catch { /* private mode */ }
    return next;
  }), []);
  // Shortcuts the menus list that the editor did not already have, live only
  // while focus is inside this document (the header's Ctrl+F search stays
  // the app's). Handlers are read through a ref so the listener is set once.
  const menuKeysRef = useRef({});
  useEffect(() => {
    const onKey = (e) => {
      const root = rootRef.current;
      if (!root || !root.contains(e.target)) return;
      const k = menuKeysRef.current;
      const key = e.key.toLowerCase();
      const hit = (fn) => { e.preventDefault(); e.stopPropagation(); fn?.(); };
      // Word's own, while typing on a page (11/11/2026). Ctrl+1/2/5 and
      // Ctrl+Shift+N are the browser's and cannot be taken over.
      const onPage = !!e.target.closest?.('.ProseMirror');
      if (onPage && e.key === 'F3' && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) { if (k.cycleCase) hit(k.cycleCase); return; }
      if (!(e.ctrlKey || e.metaKey)) return;
      if (onPage && !e.altKey && k.word) {
        const w = k.word;
        if (!e.shiftKey && key === 'e') { hit(() => w.align('center')); return; }
        if (!e.shiftKey && key === 'l') { hit(() => w.align('left')); return; }
        if (!e.shiftKey && key === 'r') { hit(() => w.align('right')); return; }
        if (!e.shiftKey && key === 'j') { hit(() => w.align('justify')); return; }
        if (!e.shiftKey && e.key === ']') { hit(() => w.size(1)); return; }
        if (!e.shiftKey && e.key === '[') { hit(() => w.size(-1)); return; }
        if (e.shiftKey && (e.key === '>' || e.key === '.')) { hit(() => w.size(1)); return; }
        if (e.shiftKey && (e.key === '<' || e.key === ',')) { hit(() => w.size(-1)); return; }
        if (key === 'm') { hit(() => w.indent(e.shiftKey ? -1 : 1)); return; }
        if (key === 't') { hit(() => w.hanging(e.shiftKey ? -1 : 1)); return; }
        if (!e.shiftKey && key === 'q') { hit(w.clearParagraph); return; }
        if (!e.shiftKey && e.key === ' ') { hit(w.clearCharacter); return; }
      }
      if (key === 'h' && !e.shiftKey && !e.altKey) hit(k.find);
      else if (key === 'k' && !e.shiftKey && !e.altKey) hit(k.link);
      else if (key === 'enter' && !e.shiftKey && !e.altKey) hit(k.pageBreak);
      else if (key === 'm' && e.altKey) hit(k.comment);
      else if (key === '\\' && !e.shiftKey) hit(k.clearFormatting);
      else if (key === '/' && !e.shiftKey && !e.altKey) hit(k.shortcuts);
      else if (key === 'c' && e.shiftKey && !e.altKey) hit(k.wordCount);
      else if (key === 'd' && !e.shiftKey && !e.altKey) hit(k.font);
      else if (key === 'f' && e.altKey && !e.shiftKey) hit(k.footnote);
      else if (e.key === 'F1') hit(k.collapseRibbon);
    };
    // Capture: Ctrl+Enter must reach this before the editor makes it a line break.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  const rootRef = useRef(null);
  // KeyTips open a tab through this (stable, so its key listener is set once).
  const keyTipTabRef = useRef((tab) => { setRibbonModeState((m) => (m === 'tabs' ? lastOpenModeRef.current : m)); setRibbonTab(tab); });
  const canvasRef = useRef(null);
  const rulerPagesElRef = useRef(() => canvasRef.current);
  const rulerScrollerElRef = useRef(() => canvasRef.current?.closest('.nx-docb-canvas') || null);
  const titleRef = useRef(null);
  const activeEditorRef = useRef(null);
  const trackUser = useMemo(() => {
    const row = employees.find((e) => (e.workEmail || '').toLowerCase() === me);
    return { email: me, name: row ? `${row.firstName || ''} ${row.lastName || ''}`.trim() || me : me };
  }, [employees, me]);
  const applyTracking = useCallback((ed) => {
    if (!ed || ed.isDestroyed) return;
    ed.commands.setTrackChanges(tracking !== 'off', trackUser);
    ed.commands.setMarkupView(markupView);
  }, [tracking, trackUser, markupView]);
  const applyTrackingRef = useRef(applyTracking);
  useEffect(() => { applyTrackingRef.current = applyTracking; }, [applyTracking]);
  // Home > Dictate: the browser's own speech recognition (lib/voice.js, the
  // same as Notes). The words land as they are spoken (Pranshu, 11/05/2026:
  // "it should write in flow"): the phrase still being recognized is real
  // text at the cursor, rewritten each time the browser revises it, and left
  // as it stands once the browser calls it final.
  const spokenRef = useRef(null);   // { ed, from, to } of the phrase being spoken
  const putSpoken = useCallback((said, final) => {
    const live = spokenRef.current;
    const ed = live?.ed || activeEditorRef.current;
    if (!ed || ed.isDestroyed) { spokenRef.current = null; return; }
    const size = ed.state.doc.content.size;
    const from = Math.min(live ? live.from : ed.state.selection.from, size);
    const to = Math.min(live ? live.to : ed.state.selection.to, size);
    const before = ed.state.doc.textBetween(Math.max(0, from - 2), from, ' ');
    const text = spokenAfter(before, said);
    const tr = ed.state.tr.insertText(text, from, to);
    tr.setSelection(TextSelection.create(tr.doc, from + text.length));
    ed.view.dispatch(tr);
    spokenRef.current = final || !text ? null : { ed, from, to: from + text.length };
  }, []);
  const dictation = useDictation((said) => putSpoken(said, true));
  useEffect(() => {
    if (!dictation.listening) { spokenRef.current = null; return; }
    if (dictation.interim || spokenRef.current) putSpoken(dictation.interim, false);
  }, [dictation.interim, dictation.listening, putSpoken]);
  // Pages (each a real independent editor instance - see DocPage above).
  // `pages` only tracks existence/order/the seed content a freshly
  // added/duplicated page mounts with; once a page's DocPage has mounted,
  // its live TipTap editor (in editorsRef) is the source of truth for its
  // content, not this array. activePageId is whichever page most recently
  // had focus/a selection change - toolbar commands and contextual "is X
  // active" checks all route through it.
  const [pages, setPages] = useState([]);
  const pagesRef = useRef([]);
  useEffect(() => { pagesRef.current = pages; }, [pages]);
  const [activePageId, setActivePageId] = useState('');
  const editorsRef = useRef(new Map()); // pageId -> live TipTap editor
  const pendingFocusId = useRef(''); // page just added/duplicated - focus+scroll to it once its editor registers
  const [pageMenuOpen, setPageMenuOpen] = useState(''); // page id whose "..." menu is open, or ''
  const pageMenuBtn = useRef(null); // the open page's "..." button - the menu anchors to it
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
  const [selectionTick, setSelectionTick] = useState(0);

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
  // Sagar, Sep 17: "clicking on the particular page (left pane) should
  // navigate to the correct part in the document". The rail's thumbnails are
  // SLICES of one continuously-flowing page, so scrolling the PAGE into view
  // only ever reached slice 1. Scroll to the slice's own offset instead.
  const goToSheet = useCallback((pageId, slice) => {
    const ed = editorsRef.current.get(pageId);
    const pageEl = ed?.view?.dom?.closest('.doc-page');
    if (!pageEl) return;
    if (!slice) { pageEl.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    const scroller = scrollableAncestor(pageEl);
    // CSS `zoom` scales the rendered box getBoundingClientRect reports, while
    // textFlowPx is in unzoomed layout pixels - without this, page 5 at 150%
    // lands around page 3.
    // One sheet's stride: its text frame, both margins and the gray gap.
    const ps = pageSetupRef.current;
    const mg = marginsOf(ps);
    const stride = textFlowPx(ps) + Math.round((mg.top + mg.bottom) * 96) + SHEET_SPACE_PX;
    const offset = slice * stride * (zoomRef.current || 1);
    const isDoc = scroller === document.scrollingElement || scroller === document.documentElement;
    const scrollerTop = isDoc ? 0 : scroller.getBoundingClientRect().top;
    const delta = pageEl.getBoundingClientRect().top - scrollerTop;
    scroller.scrollTo({ top: scroller.scrollTop + delta + offset - 8, behavior: 'smooth' });
  }, []);

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
      applyTrackingRef.current(editor);
      scheduleUsedScan();
      if (pendingFocusId.current === pageId) {
        pendingFocusId.current = '';
        goToPage(pageId, 'end');
      }
    } else {
      editorsRef.current.delete(pageId);
    }
    setSelectionTick((t) => t + 1);
  }, [goToPage, scheduleUsedScan]);
  // Every page edit routes its autosave through this ref, NOT through a
  // captured scheduleSave. It used to close over the first render's
  // scheduleSave -> doSave -> currentContent, whose `pages` was still the
  // initial [] - so every keystroke scheduled a save that persisted
  // `pages: []` and wiped the document body. A plain dependency cannot fix it
  // (scheduleSave is declared further down, and naming it here would read the
  // binding before its declaration), so the ref is refreshed on every render
  // just below scheduleSave itself.
  const scheduleSaveRef = useRef(null);
  // {{tokens}} become real merge fields whenever they appear on the page -
  // driven by the editor's own update, not by the paste event.
  //
  // Hooking the paste was wrong twice over: the handler runs before ProseMirror
  // has committed a rich paste (it captures Word HTML through a hidden element
  // and applies it a tick or two later), and it covers only one of the ways
  // text arrives. Watching the document instead catches a paste, a drag, an
  // undo that brings a token back, and simply typing one - and needs no
  // knowledge of how the editor schedules its work.
  const detectRef = useRef(null);         // refreshed every render, like scheduleSaveRef
  const detectTimerRef = useRef(null);
  // How many SHEETS each editor page's content actually fills.
  //
  // Sagar, Sep 17, twice: "it's a 6 page document but the left panel shows only
  // one page". Each page's live pagination (DocPage) reports how many sheets
  // it laid out, and the rail draws one thumbnail per sheet.
  //
  // This is the BROWSER's reckoning of where the pages fall. The exported PDF
  // is laid out by reportlab, a different engine with its own metrics, so the
  // two can disagree by a page on a long document. It is an honest preview of
  // the pagination, not a promise about the PDF.
  // How much of page 1 the letterhead takes. The exporter draws it into the
  // first page's HEADER, so page 1's text frame is that much shorter; without
  // reserving the same band the editor fits more onto page 1 than the PDF does.
  const letterheadRef = useRef(null);
  const [letterheadPx, setLetterheadPx] = useState(0);
  const [pageSpans, setPageSpans] = useState({});
  const onSheets = useCallback((pageId, n) => {
    setPageSpans((prev) => (prev[pageId] === n ? prev : { ...prev, [pageId]: n }));
  }, []);
  // The header and footer every sheet repeats: the gutter bands and the page
  // margins draw them as static HTML, the editors themselves live on the
  // first and last page.
  const [bandHtml, setBandHtml] = useState({ headerHtml: '', footerHtml: '' });


  const onPageUpdate = useCallback((pageId, tr) => {
    // Someone else's typing arrived: they save it, and their own {{token}} scan runs on their side.
    if (isRemoteTr(tr)) { setSelectionTick((t) => t + 1); scheduleUsedScan(); return; }
    scheduleSaveRef.current?.();
    setSelectionTick((t) => t + 1);
    scheduleUsedScan();
    if (!pageId) return;
    // Debounced: the scan reads the page's text, which is not free on a long
    // document, and nobody wants a chip appearing mid-word.
    if (detectTimerRef.current) clearTimeout(detectTimerRef.current);
    detectTimerRef.current = setTimeout(() => {
      detectTimerRef.current = null;
      const ed = editorsRef.current.get(pageId);
      if (!ed || !TOKEN_IN_PAGE_RE.test(ed.state.doc.textContent)) return;
      detectRef.current?.(pageId, { quiet: true });
    }, 600);
  }, [scheduleUsedScan]);
  useEffect(() => () => { if (detectTimerRef.current) clearTimeout(detectTimerRef.current); }, []);
  const onPageActivity = useCallback((pageId) => {
    setActivePageId(pageId);
    setSelectionTick((t) => t + 1);
  }, []);
  const activeEditor = editorsRef.current.get(activePageId);

  const commentRoots = commentStore.comments.filter((c) => !c.parentId);
  const startComment = () => {
    if (!activeEditor || activeEditor.state.selection.empty) { toastErr?.('Select the text to comment on first.'); return; }
    const { from, to } = activeEditor.state.selection;
    const quote = activeEditor.state.doc.textBetween(from, to, ' ').trim().slice(0, 300);
    setCommentDraft({ quote, from, to, pageId: activePageId });
    setCommentsOpen(true);
  };
  const onCommentSaved = (c, draft) => {
    const ed = editorsRef.current.get(draft.pageId);
    if (ed && c?.id) ed.chain().setTextSelection({ from: draft.from, to: draft.to }).setComment(c.id).run();
    setCommentDraft(null);
    setActiveComment(c?.id || '');
  };
  const selectComment = (id) => {
    setActiveComment(id);
    setCommentsOpen(true);
    for (const ed of editorsRef.current.values()) {
      const el = commentAnchorEl(ed.view.dom, id);
      if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); break; }
    }
  };
  const stepComment = (dir) => {
    if (!commentRoots.length) return;
    const i = commentRoots.findIndex((c) => c.id === activeComment);
    selectComment(commentRoots[(i + dir + commentRoots.length) % commentRoots.length].id);
  };
  // A thread is gone for good, so the ribbon's Delete holds inside the dialog
  // that says so (the pane's own Delete holds on the row).
  const deleteActiveComment = async () => {
    if (!activeComment) return;
    dialog.confirm('Delete this comment thread and its replies?', {
      hold: true, confirmText: 'Delete', doneText: 'Deleted',
      onConfirm: async () => { await commentStore.remove(activeComment); setActiveComment(''); },
    });
  };
  activeEditorRef.current = activeEditor;
  // Review > Spelling: the browser underlines misspellings on every page.
  useEffect(() => {
    rootRef.current?.querySelectorAll('.ProseMirror').forEach((el) => el.setAttribute('spellcheck', viewPrefs.spell ? 'true' : 'false'));
  }, [viewPrefs.spell, pages, selectionTick]);

  // The same schema as the pages, so a header imported from Word keeps its
  // font, size, alignment and table - a plain StarterKit threw them away.
  const bandExtensions = (field, placeholder) => (live
    ? [...LIVE_BODY_EXTENSIONS, Placeholder.configure({ placeholder }),
        Collaboration.configure({ document: live.doc, field }),
        CollaborationCaret.configure({ provider: { awareness: live.awareness }, user: live.user })]
    : [...BODY_EXTENSIONS, Placeholder.configure({ placeholder })]);
  const headerEditor = useEditor({
    extensions: bandExtensions('header', 'Header text…'),
    content: live ? undefined : null,
    onUpdate: ({ transaction }) => { if (hydratedRef.current && !isRemoteTr(transaction)) scheduleSave(); scheduleUsedScan(); },
  });

  const footerEditor = useEditor({
    extensions: bandExtensions('footer', 'Footer text…'),
    content: live ? undefined : null,
    onUpdate: ({ transaction }) => { if (hydratedRef.current && !isRemoteTr(transaction)) scheduleSave(); scheduleUsedScan(); },
  });

  // The static copies every sheet band shows. `pages` is a dependency on
  // purpose: a load or an import sets the editors' content without an update
  // event, and changes the page list at the same time.
  useEffect(() => {
    if (!headerEditor || !footerEditor) return undefined;
    const refresh = () => setBandHtml({
      headerHtml: headerVisible ? headerEditor.getHTML() : '',
      footerHtml: footerVisible ? footerEditor.getHTML() : '',
    });
    refresh();
    headerEditor.on('update', refresh);
    footerEditor.on('update', refresh);
    return () => { headerEditor.off('update', refresh); footerEditor.off('update', refresh); };
  }, [headerEditor, footerEditor, headerVisible, footerVisible, pages]);

  // Every merge field on the pages (in page order), the header and the footer,
  // counted. Kept as the same array when nothing changed so the rail does not
  // re-render on every keystroke.
  const scanUsedVars = useCallback(() => {
    const counts = new Map();
    const walk = (json) => {
      if (!json || typeof json !== 'object') return;
      if (json.type === 'mergeField' && json.attrs?.token) counts.set(json.attrs.token, (counts.get(json.attrs.token) || 0) + 1);
      for (const c of json.content || []) walk(c);
    };
    for (const p of pages) walk(editorsRef.current.get(p.id)?.getJSON());
    walk(headerEditor?.getJSON());
    walk(footerEditor?.getJSON());
    const next = [...counts].map(([token, count]) => ({ token, count }));
    setUsedVars((prev) => (prev.length === next.length && prev.every((v, i) => v.token === next[i].token && v.count === next[i].count)) ? prev : next);
  }, [pages, headerEditor, footerEditor]);
  useEffect(() => { scanUsedVarsRef.current = scanUsedVars; }, [scanUsedVars]);
  // A page added, removed or restored, or Preview remounting every editor.
  useEffect(() => { scheduleUsedScan(); }, [pages, preview, scheduleUsedScan]);

  // Pushes a { pages, header, footer } content object into place - shared by
  // the initial load below AND by History's "Restore", so hydration only has
  // one implementation. Setting `pages` with fresh ids remounts every DocPage
  // (React key-based), so restoring an old version that had a different page
  // count is exactly "throw away the current pages, mount new ones" - no
  // stale per-page editor state can bleed through.
  const applyContent = useCallback((content) => {
    const c = content && typeof content === 'object' ? content : {};
    if (live) {
      // Live: the words are in the shared document already - only the page
      // list and which bands show are read from it; nothing is pushed in.
      const meta = live.doc.getMap('meta');
      const ids = live.doc.getArray('pages').toArray();
      editorsRef.current = new Map();
      if (!isEmptyContent({ pages: c.pages || [], header: c.header, footer: c.footer })) lastGoodRef.current = true;
      setPages(ids.map((id) => ({ id, json: null })));
      setActivePageId(ids[0] || '');
      setHeaderVisible(!!meta.get('header'));
      setFooterVisible(!!meta.get('footer'));
      return;
    }
    const pageList = Array.isArray(c.pages) && c.pages.length
      // repairDocJson: a document saved by the old .docx importer holds block
      // images inside paragraphs, which ProseMirror loads and then throws on as
      // soon as anyone types in that paragraph. Repair on the way in, so an
      // already-broken document becomes editable without a re-import.
      ? c.pages.map(p => ({ id: p.id || genPageId(), json: p.json ? repairDocJson(p.json) : null }))
      : splitBodyIntoPages(c.body); // backward compat with pre-rewrite documents
    editorsRef.current = new Map();
    // Arm the empty-save guard from what we LOADED, not from what has been
    // typed since - otherwise the very first autosave after opening a full
    // document is the one that can blank it.
    if (!isEmptyContent({ pages: pageList, header: c.header, footer: c.footer })) {
      lastGoodRef.current = true;
    }
    setPages(pageList);
    setActivePageId(pageList[0]?.id || '');
    if (c.header) { setHeaderVisible(true); headerEditor?.commands.setContent(c.header, { emitUpdate: false }); }
    else { setHeaderVisible(false); headerEditor?.commands.clearContent(); }
    if (c.footer) { setFooterVisible(true); footerEditor?.commands.setContent(c.footer, { emitUpdate: false }); }
    else { setFooterVisible(false); footerEditor?.commands.clearContent(); }
  }, [headerEditor, footerEditor, live]);

  // Load the document once. Pages mount themselves with their real content
  // already in place (no separate hydration push needed - see DocPage).
  useEffect(() => {
    let cancelled = false;
    hydratedRef.current = false; // re-arm the header/footer guard whenever those editor instances change
    apiGet(docId).then(d => {
      if (cancelled) return;
      setDoc(d);
      // An unnamed document shows an empty title box saying "Untitled Document" (lib/untitled.js).
      setTitle(isUntitled(d[nameKey]) ? '' : d[nameKey]);
      setLetterheadId(d.letterheadId || '');
      setRequiresLetterhead(!!d.requiresLetterhead);
      setEmployeeId(d.employeeId || '');
      setEntityId(d.entityId || '');
      setMergeOverrides(d.mergeOverrides || {});
      setFieldDefs(d.fieldDefs || []);
      setSignerRoles(d.signerRoles || []);
      const liveMeta = live ? live.doc.getMap('meta') : null;
      setPageSetup({ ...DEFAULT_PAGE_SETUP, ...((liveMeta ? liveMeta.get('pageSetup') : null) || d.content?.pageSetup || {}) });
      setTracking((liveMeta ? liveMeta.get('trackChanges') : d.content?.trackChanges) ? 'everyone' : 'off');
      applyContent(d.content);
      hydratedRef.current = true;
      setLoading(false);
    }).catch(e => { toastErr?.(e.message || `Failed to load ${kind}`); onClose?.(); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, headerEditor, footerEditor]);

  // Live: a colleague's page added / removed / moved, a band shown or hidden,
  // the page setup or Track Changes changed - all arrive through the shared
  // document. And what this person does to them goes out the same way.
  useEffect(() => {
    if (!live) return undefined;
    const arr = live.doc.getArray('pages');
    const meta = live.doc.getMap('meta');
    const onPages = () => {
      const ids = arr.toArray();
      setPages((prev) => (prev.length === ids.length && prev.every((p, i) => p.id === ids[i]))
        ? prev : ids.map((id) => prev.find((p) => p.id === id) || { id, json: null }));
    };
    const onMeta = (ev) => {
      if (ev.transaction.origin === LOCAL) return;
      setHeaderVisible(!!meta.get('header'));
      setFooterVisible(!!meta.get('footer'));
      const ps = meta.get('pageSetup');
      if (ps) setPageSetup({ ...DEFAULT_PAGE_SETUP, ...ps });
      const on = !!meta.get('trackChanges');
      setTracking((t) => (on ? 'everyone' : t === 'everyone' ? 'off' : t));
    };
    arr.observe(onPages);
    meta.observe(onMeta);
    return () => { arr.unobserve(onPages); meta.unobserve(onMeta); };
  }, [live]);
  useEffect(() => {
    if (!live || loading || !pages.length) return;
    syncPageIds(live.doc, pages.map((p) => p.id));
  }, [live, loading, pages]);
  useEffect(() => {
    if (!live || loading || readOnly) return;
    const meta = live.doc.getMap('meta');
    live.doc.transact(() => {
      if (meta.get('header') !== headerVisible) meta.set('header', headerVisible);
      if (meta.get('footer') !== footerVisible) meta.set('footer', footerVisible);
      if (JSON.stringify(meta.get('pageSetup') || null) !== JSON.stringify(pageSetup)) meta.set('pageSetup', pageSetup);
      if (meta.get('trackChanges') !== (tracking === 'everyone')) meta.set('trackChanges', tracking === 'everyone');
    }, LOCAL);
  }, [live, loading, readOnly, headerVisible, footerVisible, pageSetup, tracking]);

  useEffect(() => { api.getDocLetterheads().then(setLetterheads).catch(() => setLetterheads([])); }, []);
  useEffect(() => { api.getDocVariables().then(v => setVariables(Array.isArray(v) ? v : [])).catch(() => setVariables([])); }, []);

  useEffect(() => {
    headerEditor?.setEditable(!preview && !viewingOnly && !readOnly);
    footerEditor?.setEditable(!preview && !viewingOnly && !readOnly);
  }, [preview, viewingOnly, readOnly, headerEditor, footerEditor]);
  useEffect(() => {
    [...editorsRef.current.values(), headerEditor, footerEditor].forEach(applyTracking);
  }, [applyTracking, headerEditor, footerEditor, pages]);

  // Live: the page list and which bands show are read from the shared
  // document itself, so a save made right after merging a colleague's newer
  // state carries their pages too (React state catches up a render later).
  const currentContent = useCallback(() => ({
    pages: live
      ? livePageIds(live.doc).map((id) => {
        const ed = editorsRef.current.get(id);
        return { id, json: ed ? ed.getJSON() : livePageJson(live.doc, id) };
      })
      : pages.map(p => {
        const ed = editorsRef.current.get(p.id);
        return { id: p.id, json: ed ? ed.getJSON() : (p.json || { type: 'doc', content: [] }) };
      }),
    header: (live ? live.doc.getMap('meta').get('header') : headerVisible) ? (headerEditor?.getJSON() ?? null) : null,
    footer: (live ? live.doc.getMap('meta').get('footer') : footerVisible) ? (footerEditor?.getJSON() ?? null) : null,
    pageSetup,
    trackChanges: tracking === 'everyone',
  }), [pages, headerEditor, footerEditor, headerVisible, footerVisible, pageSetup, tracking, live]);

  // Every save goes through this ref, never through a captured currentContent.
  // TipTap/useEditor option callbacks and any useCallback that forgets a dep
  // hold whichever closure existed when they were created; serializing the
  // document from one of those means writing state as it was on some earlier
  // render. Refreshed on every render (the ModuleTabs onChangeRef idiom), so
  // "what is in the editor right now" has exactly one answer.
  const currentContentRef = useRef(currentContent);
  useEffect(() => { currentContentRef.current = currentContent; });

  // Page Setup panel changes save immediately (like the letterhead/employee
  // pickers) rather than going through the debounced content autosave -
  // these are deliberate, infrequent choices, not typing.
  const updatePageSetup = (patch) => {
    const next = { ...pageSetup, ...patch };
    setPageSetup(next);
    const content = { ...currentContent(), pageSetup: next };
    const payload = kind === 'document' ? { content, note: 'Page setup changed' } : { content };
    (live ? live.save(() => ({ ...currentContentRef.current(), pageSetup: next }), { note: payload.note }) : apiUpdate(docId, payload))
      .catch((e) => toastErr?.(e.message || 'Failed to update page setup'));
  };
  // Track Changes For Everyone is a document setting: saved at once, like Page Setup.
  const setTrackingMode = (mode) => {
    setTracking(mode);
    if (isLocked) return;
    const content = { ...currentContent(), trackChanges: mode === 'everyone' };
    const payload = kind === 'document' ? { content, note: mode === 'everyone' ? 'Track Changes turned on' : 'Track Changes turned off' } : { content };
    (live ? live.save(() => ({ ...currentContentRef.current(), trackChanges: mode === 'everyone' }), { note: payload.note }) : apiUpdate(docId, payload))
      .catch((e) => toastErr?.(e.message || 'Failed to save Track Changes'));
  };
  useEffect(() => { setTrackingModeRef.current = setTrackingMode; });
  // Accept / Reject at the cursor (or the next change when the cursor is not on one), then move on.
  const resolveChange = (accept) => {
    const ed = activeEditor;
    if (!ed) return;
    const cmd = accept ? 'acceptChange' : 'rejectChange';
    if (!ed.can()[cmd]()) ed.commands.selectChange(1);
    ed.chain().focus()[cmd]().selectChange(1).run();
    setSelectionTick((t) => t + 1);
  };
  const resolveAll = (accept) => {
    [...editorsRef.current.values(), headerEditor, footerEditor].forEach((ed) => ed?.commands[accept ? 'acceptAllChanges' : 'rejectAllChanges']());
    setSelectionTick((t) => t + 1);
  };
  const changeCount = [...editorsRef.current.values(), headerEditor, footerEditor]
    .reduce((n, ed) => n + (ed && !ed.isDestroyed ? listChanges(ed.state.doc).length : 0), 0);
  const docMode = viewingOnly ? 'Viewing' : tracking !== 'off' ? 'Reviewing' : 'Editing';
  const toggleHeader = () => {
    if (headerVisible) { setHeaderVisible(false); headerEditor?.commands.clearContent(); scheduleSave(); }
    else setHeaderVisible(true);
  };
  const toggleFooter = () => {
    if (footerVisible) { setFooterVisible(false); footerEditor?.commands.clearContent(); scheduleSave(); }
    else setFooterVisible(true);
  };

  const doSave = useCallback(({ allowEmpty = false } = {}) => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    // Defensive, belt-and-suspenders: even if something calls doSave directly
    // (Ctrl+S, the close-flush) before load finishes, never persist an
    // unhydrated editor's empty default doc over real saved content.
    if (!hydratedRef.current || readOnly) return Promise.resolve();
    const content = currentContentRef.current();
    // A document ALWAYS has at least one page: applyContent seeds one for even
    // an empty/legacy document, and Delete Page refuses to remove the last.
    // So an empty `pages` here is never the user's document - it is some
    // pre-hydration state leaking into a save, and writing it destroys the
    // body (that is exactly how a real Loan Agreement lost its content).
    // Drop the write instead; the next legitimate save persists real content.
    if (!Array.isArray(content.pages) || content.pages.length === 0) {
      console.warn('[DocumentBuilder] refusing to save a document with no pages');
      return Promise.resolve();
    }
    // ...and the same judgement one level down. A page can exist and still be
    // EMPTY, which the check above waves through - that is how a template with
    // 138 blocks in it autosaved `chars=0` every couple of seconds, racing the
    // real save at the same version number. Whichever landed last won, so the
    // content survived or vanished by luck while the header said "Saved".
    //
    // An empty save is only ever refused when we KNOW the document had content
    // (lastGoodRef): emptying a document deliberately has to keep working, and
    // a genuinely blank new template must still save.
    if (isEmptyContent(content) && lastGoodRef.current && !allowEmpty) {
      console.warn('[DocumentBuilder] refusing to overwrite saved content with an empty document');
      return Promise.resolve();
    }
    if (!isEmptyContent(content)) lastGoodRef.current = true;
    setSaveStatus('saving');
    const payload = kind === 'document' ? { content, note: 'Autosave' } : { content };
    // Live: the save carries the shared state and merges a colleague's newer save first.
    return (live ? live.save(() => currentContentRef.current(), { note: 'Autosave' }) : apiUpdate(docId, payload))
      .then((res) => {
        setSaveStatus('saved'); onContentSaved?.(payload.content);
        // A template's chip (Published / Unpublished Changes) follows each save.
        if (kind === 'template' && res) {
          setDoc(d => (d ? { ...d, version: res.version, publishedVersion: res.publishedVersion,
                             hasUnpublishedChanges: res.hasUnpublishedChanges,
                             signatureRoles: res.signatureRoles } : d));
        }
      })
      .catch(() => setSaveStatus('error'));
  }, [docId, kind, apiUpdate, onContentSaved, live, readOnly]);

  // The server renders PDF/DOCX from the SAVED row, so anything that asks the
  // backend to render (Preview & Send, Export, Send for Signature) has to let
  // the debounced autosave land first - otherwise it renders the document as
  // it was up to AUTOSAVE_MS ago, which reads as "my preview is blank/stale".
  const flushPendingSave = useCallback(
    () => (saveTimer.current ? doSave() : Promise.resolve()), [doSave]);

  const scheduleSave = useCallback(() => {
    setSaveStatus('idle');
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(doSave, AUTOSAVE_MS);
  }, [doSave]);
  useEffect(() => { scheduleSaveRef.current = scheduleSave; });
  // Live: a planned restart (the channel key moved on) saves what is waiting first.
  useEffect(() => { live?.setFlush(() => (saveTimer.current ? doSave() : null)); }, [live, doSave]);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); doSave({ allowEmpty: true }); }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'e') { e.preventDefault(); setTrackingModeRef.current(trackingRef.current === 'off' ? 'everyone' : 'off'); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doSave]);

  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); }, []);
  const trackingRef = useRef(tracking);
  useEffect(() => { trackingRef.current = tracking; }, [tracking]);
  const setTrackingModeRef = useRef(() => {});

  // Blank is never saved: the box goes back to the name it had (or stays
  // empty on a still-unnamed document). The saved name is kept on `doc` so
  // the next comparison - and the name check on Close - read the real one.
  const saveTitle = () => {
    const t = title.trim();
    if (!t) { if (!isUntitled(doc?.[nameKey])) setTitle(doc?.[nameKey] || ''); return Promise.resolve(); }
    if (t === doc?.[nameKey]) return Promise.resolve();
    return apiUpdate(docId, { [nameKey]: t })
      .then(() => setDoc((d) => (d ? { ...d, [nameKey]: t } : d)))
      .catch(e => toastErr?.(e.message || 'Failed to rename'));
  };

  // Who is asked to name an unnamed document or template on Close: an editor
  // of a draft.
  const mayName = (kind === 'document' || kind === 'template') && !readOnly && !isLocked && doc?.access !== 'view';
  // "Name This Document" (Neil, 11/10/2026, and templates since 11/11/2026):
  // an unnamed one cannot be closed without a name; Keep Editing stays put.
  // The name is filled in already - the first line, else "Document - <date>".
  const [nameAsk, setNameAsk] = useState(null);   // { suggestion, resolve }
  const askName = async () => {
    const text = pages.map((p) => editorsRef.current.get(p.id)?.getText?.({ blockSeparator: '\n' }) || '').join('\n');
    const answer = await new Promise((resolve) => setNameAsk({ suggestion: suggestName(text) || defaultName(kind), resolve }));
    setNameAsk(null);
    if (!answer || isUntitled(answer.name)) return false;
    const name = answer.name;
    try {
      await apiUpdate(docId, { [nameKey]: name, ...(kind === 'template' && answer.category ? { category: answer.category } : {}) });
      setTitle(name);
      setDoc((d) => (d ? { ...d, [nameKey]: name, ...(kind === 'template' && answer.category ? { category: answer.category } : {}) } : d));
      return true;
    } catch (e) {
      toastErr?.(e.message || 'Failed to rename');
      return false;
    }
  };

  const close = () => {
    // While viewing the rendered Preview & Send screen, X should back out to
    // the editor (mirroring "Back to Edit"), not exit the document entirely
    // - the two are easy to conflate since both sit in the same top-left
    // corner, but only edit mode's X should actually leave the document.
    if (kind === 'document' && preview) {
      setPreview(false);
      closePdfPreview();
      return Promise.resolve(false);
    }
    // Still unnamed and nothing written in it: a draft somebody opened and
    // closed again is not kept, so the list does not fill with empty
    // "Untitled" rows (11/11/2026). Only the owner's own unshared draft.
    // `mine` is the server's word (GET /documents/{id}, /templates/{id}).
    const mine = doc?.mine === true;
    if (mayName && mine && !(doc?.sharedWith || []).length && isUntitled(title.trim() || doc?.[nameKey])
        && doc?.status === 'draft' && !doc?.publishedVersion && isEmptyContent(currentContentRef.current?.())) {
      if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
      return (kind === 'template' ? api.deleteDocTemplate(docId) : api.deleteDocument(docId))
        .then(() => toastOk?.(`Nothing was written, so the blank ${kind} was not kept.`))
        .catch(() => {})
        .then(() => { onClose?.(); return true; });
    }
    // Still unnamed: ask for a name first; Keep Editing cancels the close.
    // Resolves true once it really closed (File > New Document waits on it).
    if (mayName && isUntitled(title.trim() || doc?.[nameKey])) {
      return askName().then((named) => (named ? Promise.resolve(flushPendingSave()).finally(() => onClose?.()).then(() => true) : false));
    }
    // Wait for the pending write before unmounting. This used to fire doSave()
    // and call onClose() in the same breath: the component went away while the
    // request was still in flight, which is what "it says Saved and then
    // discards everything" looked like from the outside.
    return Promise.resolve(flushPendingSave()).finally(() => onClose?.()).then(() => true);
  };

  const changeLetterhead = (id) => {
    setLetterheadId(id);
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

  useLayoutEffect(() => {
    const el = letterheadRef.current;
    if (!el) { setLetterheadPx(0); return undefined; }
    const measure = () => {
      const h = el.getBoundingClientRect().height / (zoom || 1);
      setLetterheadPx(Number.isFinite(h) ? Math.round(h) : 0);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [activeLetterhead, pageSetup, zoom, preview]);

  // The first sheet is shorter by the letterhead band; later sheets are full.
  const firstSheetPx = Math.max(1, textFlowPx(pageSetup) - (letterheadPx || 0));
  // Where each page's sheets start in the whole document, and the total -
  // what every band's "Page 3 of 9" is counted from.
  const sheetStarts = [];
  let totalSheets = 0;
  for (const p of pages) { sheetStarts.push(totalSheets); totalSheets += Math.max(1, pageSpans[p.id] || 1); }
  const bandInfo = useMemo(() => ({ ...bandHtml, total: totalSheets, pageNumbers: pageSetup.pageNumbers || 'bottom-right' }), [bandHtml, totalSheets, pageSetup.pageNumbers]);

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
  // The merge-subject picker's rows, keyed by work email (so the photo shows)
  // or by id for anyone without one; `id` is what the document saves.
  const employeeRows = useMemo(() => {
    const seen = new Set();
    return employees.map(e => {
      let email = (e.workEmail || '').toLowerCase();
      if (!email || seen.has(email)) email = `id:${e.id}`.toLowerCase();
      seen.add(email);
      return { id: e.id, email, name: `${e.firstName || ''} ${e.lastName || ''}`.trim() || e.workEmail || e.id };
    });
  }, [employees]);

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
  // Every variable this template knows about, from either place it can be
  // declared: a default value typed into Merge data, or a field definition
  // (which is what import/Detect variables writes). Listing only the first set
  // meant a detected variable appeared as a chip in the document but was
  // missing from Merge data and the insert picker - you could see it and not
  // set a default for it.
  const builtins = useMemo(() => Object.fromEntries(variables.filter(v => v.source === 'builtin')
    .map(v => [v.token, { label: v.label, when: v.when }])), [variables]);
  const builtinSet = useMemo(() => new Set([...MERGE_TOKENS, ...Object.keys(builtins)]), [builtins]);
  const customVarKeys = useMemo(() => {
    const keys = Object.keys(mergeOverrides).filter(k => !builtinSet.has(k));
    for (const fd of fieldDefs) {
      if (fd?.token && !builtinSet.has(fd.token) && !keys.includes(fd.token)) keys.push(fd.token);
    }
    return keys;
  }, [mergeOverrides, fieldDefs, builtinSet]);
  // The label a field definition gave it, so the picker reads "Offer - Letter
  // Date" rather than a bare token.
  const varLabel = useMemo(() => {
    const out = {};
    for (const fd of fieldDefs) if (fd?.token && fd.label) out[fd.token] = fd.label;
    return out;
  }, [fieldDefs]);
  const shared = useMemo(() => sharedDefs(variables, docId), [variables, docId]);
  // The chips on the page say what the field definition calls them - or,
  // with Preview Results on, the value the document will print. The chip's
  // own label (what the node renders) is kept in data-base to come back to.
  useEffect(() => {
    const eds = [...editorsRef.current.values(), headerEditor, footerEditor].filter((e) => e && !e.isDestroyed);
    for (const ed of eds) {
      ed.view.dom.querySelectorAll('.tpl-chip[data-merge-token]').forEach((el) => {
        if (el.dataset.base == null) el.dataset.base = el.textContent;
        const token = el.getAttribute('data-merge-token');
        const label = varLabel[token] || el.dataset.base;
        const value = previewResults && previewValues ? String(previewValues[token] ?? '').trim() : '';
        const text = value || label;
        if (el.textContent !== text) el.textContent = text;
        el.classList.toggle('is-value', !!value);
        el.classList.toggle('is-missing', previewResults && !value);
      });
    }
  }, [varLabel, pages, previewResults, previewValues, selectionTick, headerEditor, footerEditor]);
  useEffect(() => {
    if (!previewResults && !varsOpen) return undefined;
    let live = true;
    const t = setTimeout(() => {
      if (kind !== 'document') { setPreviewValues({ ...mergeOverrides }); return; }
      api.documentMergeValues(docId)
        .then((r) => { if (live) setPreviewValues({ ...(r?.values || {}), ...mergeOverrides }); })
        .catch((e) => { if (live) { setPreviewValues({}); toastErr?.(e.message || 'Could not load the values to preview'); } });
    }, 350);   // a Merge Data change saves first
    return () => { live = false; clearTimeout(t); };
  }, [previewResults, varsOpen, kind, docId, employeeId, entityId, mergeOverrides]);   // eslint-disable-line react-hooks/exhaustive-deps
  // The insert picker, grouped by WHEN Nexus fills each built-in. Until the
  // library answers, the short list it always had.
  const builtinGroups = useMemo(() => {
    const list = variables.filter(v => v.source === 'builtin');
    if (!list.length) return [['Filled By Nexus', MERGE_TOKENS.map(t => [t, FRIENDLY_MERGE[t]])]];
    return FILLED_WHEN.map(([when, label]) => [label, list.filter(v => (v.when || 'document') === when).map(v => [v.token, v.label])])
      .filter(([, items]) => items.length);
  }, [variables]);
  // Every token placed on the pages, header and footer - the panel lists the
  // built-ins among them as Filled By Nexus.
  const openFieldsPanel = (newTokens = []) => {
    const out = [];
    for (const p of pages) tokensInDoc(editorsRef.current.get(p.id)?.getJSON(), out);
    tokensInDoc(headerEditor?.getJSON(), out);
    tokensInDoc(footerEditor?.getJSON(), out);
    setFieldsPanel({ newTokens, docTokens: out });
  };
  const addCustomVariable = () => {
    const key = slugifyToken(newVarName);   // keeps the dotted taxonomy (principal.amount)
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
    flushPendingSave()
      .then(() => (format === 'pdf' ? api.exportDocumentPdf(docId)
        : kind === 'template' ? api.exportTemplateDocx(docId) : api.exportDocumentDocx(docId)))
      .then(downloadBlob).catch(e => toastErr?.(e.message || 'Export failed')).finally(() => setExporting(''));
  };

  // Open in Word (Pranshu, Nov 5 2026): Word on the computer opens the same
  // .docx as Export DOCX through Office's ms-word: link and a short-lived
  // signed file link (routers/doc_word_link.py). Edits in Word stay on the
  // computer - nothing saves back into Nexus.
  const openInWord = () => {
    setExporting('word');
    flushPendingSave()
      .then(() => api.documentWordLink(docId))
      .then(({ path }) => {
        const fileUrl = new URL(`${API_BASE}${path}`, window.location.origin).href;
        const a = document.createElement('a');
        a.href = `ms-word:ofe|u|${fileUrl}`;
        a.click();
        toastOk?.('Opening in Word. Changes you make in Word save on your computer, not in Nexus. No Word on this computer? Use Export DOCX.');
      })
      .catch(e => toastErr?.(e.message || 'Could not open in Word'))
      .finally(() => setExporting(''));
  };

  // In-app PDF Preview - renders the exported PDF in an iframe (browsers have
  // a native PDF viewer for that) rather than hand-rolling pdfjs-dist canvas
  // rendering like PdfEditor.jsx does for field placement, a different problem.
  const openPdfPreview = () => {
    setPdfPreviewLoading(true);
    flushPendingSave()
      .then(() => api.exportDocumentPdf(docId))
      .then(({ blob }) => setPdfPreviewUrl(URL.createObjectURL(blob)))
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

  // Word's Home > Clipboard > Format Painter - click to capture the current
  // selection's formatting; the NEXT selection you make, anywhere, gets it
  // when the mouse button (or Shift) comes up, then the brush turns off.
  // Not on selection change (11/05/2026: that fired once more for the very
  // selection the brush was armed on, so the brush went off before you
  // picked anything, and mid-drag it would have painted one character).
  const PAINTABLE_MARKS = ['bold', 'italic', 'underline'];
  // One click paints once; a double-click on the button keeps the brush on
  // until Escape or another click, as in Word. A plain click in the text
  // paints the word under the cursor.
  const toggleFormatPainter = (sticky = false) => {
    if (painterActive && !sticky) { formatPainterRef.current = null; setPainterActive(false); return; }
    if (!activeEditor) return;
    const marks = {};
    PAINTABLE_MARKS.forEach(m => { marks[m] = activeEditor.isActive(m); });
    const ts = activeEditor.getAttributes('textStyle');
    if (ts.color) marks.color = ts.color;
    if (ts.fontFamily) marks.fontFamily = ts.fontFamily;
    if (ts.fontSize) marks.fontSize = ts.fontSize;
    const { from, to } = activeEditor.state.selection;
    formatPainterRef.current = { marks, armed: { ed: activeEditor, from, to } };
    setPainterActive(sticky ? 'sticky' : 'once');
    toastOk?.(sticky ? 'Format Painter stays on. Select or click text to paint it; press Esc to stop.' : 'Select or click the text to paste this formatting onto.');
  };
  useEffect(() => {
    if (!painterActive) return undefined;
    const paint = () => {
      const brush = formatPainterRef.current;
      const ed = [...editorsRef.current.values(), headerEditor, footerEditor].find((x) => x && !x.isDestroyed && x.view.hasFocus()) || activeEditorRef.current;
      if (!brush || !ed || !ed.view.hasFocus()) return;
      let { from, to } = ed.state.selection;
      if (from === to) {           // a click: the word under the cursor
        const $p = ed.state.doc.resolve(from);
        const text = $p.parent.textContent, start = $p.start(), off = from - start;
        const isWord = (ch) => ch && /[\w'’-]/.test(ch);
        if (!isWord(text[off]) && !isWord(text[off - 1])) return;
        let a = off, b = off;
        while (isWord(text[a - 1])) a -= 1;
        while (isWord(text[b])) b += 1;
        from = start + a; to = start + b;
      }
      if (brush.armed.ed === ed && brush.armed.from === from && brush.armed.to === to) return;
      const m = brush.marks;
      let chain = ed.chain().focus().setTextSelection({ from, to });
      chain = m.bold ? chain.setBold() : chain.unsetBold();
      chain = m.italic ? chain.setItalic() : chain.unsetItalic();
      chain = m.underline ? chain.setUnderline() : chain.unsetUnderline();
      if (m.color) chain = chain.setColor(m.color);
      if (m.fontFamily) chain = chain.setFontFamily(m.fontFamily);
      if (m.fontSize) chain = chain.setFontSize(m.fontSize);
      chain.run();
      if (painterActive === 'sticky') return;
      formatPainterRef.current = null;
      setPainterActive(false);
    };
    // After the event settles: a double-click's word selection lands after its mouseup.
    const later = () => setTimeout(paint, 0);
    const onKey = (e) => {
      if (e.key === 'Shift') later();
      if (e.key === 'Escape') { formatPainterRef.current = null; setPainterActive(false); }
    };
    document.addEventListener('mouseup', later);
    document.addEventListener('dblclick', later);
    document.addEventListener('keyup', onKey);
    return () => { document.removeEventListener('mouseup', later); document.removeEventListener('dblclick', later); document.removeEventListener('keyup', onKey); };
  }, [painterActive, headerEditor, footerEditor]);

  // Picture Format helpers. Sizes show in inches like Word (96px an inch).
  const imgAttrs = activeEditor?.isActive('image') ? activeEditor.getAttributes('image') : null;
  // Keeps the picture selected after the write (a replaced node drops its selection).
  const setImg = (patch) => { const pos = activeEditor.state.selection.from; activeEditor.chain().focus().updateAttributes('image', patch).setNodeSelection(pos).run(); };
  const imgEl = () => { const d = imgAttrs && activeEditor.view.nodeDOM(activeEditor.state.selection.from); return d?.querySelector?.('img') || null; };
  const imgBox = imgAttrs ? { w: imgAttrs.width || imgEl()?.clientWidth || 0, h: imgAttrs.height || imgEl()?.clientHeight || 0 } : null;
  const sizeImg = (dim, inches) => {
    const px = Math.max(10, Math.round(Number(inches) * 96));
    if (!Number.isFinite(px)) return;
    const ratio = imgBox.w && imgBox.h ? imgBox.w / imgBox.h : null;
    if (!lockAspect || !ratio) { setImg({ [dim]: px }); return; }
    setImg(dim === 'width' ? { width: px, height: Math.round(px / ratio) } : { height: px, width: Math.round(px * ratio) });
  };
  const alignImg = (side) => {
    if ((imgAttrs?.wrapMode || 'inline') === 'inline' || side === 'center') {
      const pos = activeEditor.state.selection.from;
      activeEditor.chain().focus().updateAttributes('image', side === 'center' ? { wrapMode: 'inline', x: 0, y: 0 } : {}).setTextAlign(side).setNodeSelection(pos).run();
    } else setImg({ wrapMode: side === 'right' ? 'squareRight' : 'square', x: 0, y: 0 });
  };
  const resetImg = () => setImg({ width: null, height: null, rotation: 0, flipH: false, flipV: false, borderColor: null, frame: 'none', crop: null, wrapMode: 'inline', x: 0, y: 0 });
  // Crop mode marks the selected picture's box so its edge handles show
  // (lib/docBuilderExtensions.js draws and drags them); it ends with the
  // selection, Escape, or the button.
  const cropBox = () => imgEl()?.parentElement || null;
  useEffect(() => {
    const el = cropping && imgAttrs ? cropBox() : null;
    if (!el) return undefined;
    el.classList.add('is-cropping');
    const onKey = (e) => { if (e.key === 'Escape') setCropping(false); };
    document.addEventListener('keydown', onKey);
    return () => { el.classList.remove('is-cropping'); document.removeEventListener('keydown', onKey); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cropping, imgAttrs?.src, selectionTick]);
  const changePicture = () => { changePictureRef.current = true; fileInputRef.current?.click(); };
  const PICTURE_WRAPS = [['inline', 'In Line with Text'], ['square', 'Square Left'], ['squareRight', 'Square Right'], ['behind', 'Behind Text'], ['front', 'In Front of Text']];
  // Right-click on a picture: select it and open the menu where the mouse is.
  const onPagesContextMenu = (e) => {
    const wrap = e.target.closest?.('.doc-image-wrap');
    if (!wrap || preview || isLocked || viewingOnly) return;
    const entry = [...editorsRef.current.entries()].find(([, ed]) => ed && !ed.isDestroyed && ed.view.dom.contains(wrap));
    if (!entry) return;
    e.preventDefault();
    const [pageId, ed] = entry;
    let pos = ed.view.posAtDOM(wrap, 0);
    if (ed.state.doc.nodeAt(pos)?.type.name !== 'image') pos -= 1;
    if (ed.state.doc.nodeAt(pos)?.type.name !== 'image') return;
    ed.view.dispatch(ed.state.tr.setSelection(NodeSelection.create(ed.state.doc, pos)));
    setActivePageId(pageId);
    setSelectionTick((t) => t + 1);
    setImgMenu({ x: e.clientX, y: e.clientY });
  };
  // The Picture tab opens with the picture and closes with it, as in Word.
  const pictureSelected = !!imgAttrs;
  useEffect(() => {
    if (pictureSelected) setRibbonTab('picture');
    else { setRibbonTab((t) => (t === 'picture' ? 'home' : t)); setCropping(false); }
  }, [pictureSelected]);

  // Word's Home > Clipboard > Cut/Copy/Paste - the editor is a native
  // contenteditable so Ctrl+X/C/V already work without any button; these
  // exist for mouse-only users, same as Word's own toolbar buttons.
  const clipboardAction = (cmd) => { activeEditor?.chain().focus(); document.execCommand(cmd); };
  // Paste > Keep Text Only. The clipboard API needs permission; without it the
  // keyboard already does this.
  const pasteTextOnly = () => {
    navigator.clipboard?.readText?.()
      .then((t) => { if (t) activeEditor?.chain().focus().insertContent(t).run(); })
      .catch(() => toastErr?.('Press Ctrl+Shift+V to paste as plain text.'));
  };
  // Home > Bullets / Numbering galleries.
  const setBullets = (style) => {
    if (!activeEditor) return;
    const c = activeEditor.chain().focus();
    if (!activeEditor.isActive('bulletList')) c.toggleBulletList();
    c.updateAttributes('bulletList', { listStyle: style }).run();
  };
  const setNumbering = (type) => {
    if (!activeEditor) return;
    const c = activeEditor.chain().focus();
    if (!activeEditor.isActive('orderedList')) c.toggleOrderedList();
    c.updateAttributes('orderedList', { type }).run();
  };
  const setParaAttr = (patch) => activeEditor?.chain().focus().updateAttributes(currentBlockType(), patch).run();
  // View > Zoom > Page Width / Fit: the canvas column's width against the page's.
  const zoomToPageWidth = () => {
    const w = canvasRef.current?.clientWidth;
    const { maxWidth } = pageCanvasStyle(pageSetup);
    if (w && maxWidth) setZoom(Math.min(2, Math.max(0.5, Math.floor(((w - 48) / maxWidth) * 100) / 100)));
  };
  const zoomToFit = () => {
    const w = canvasRef.current?.clientWidth;
    const { maxWidth, minHeight } = pageCanvasStyle(pageSetup);
    if (!w || !maxWidth) return;
    const byHeight = (window.innerHeight - 320) / (minHeight || maxWidth * 1.3);
    setZoom(Math.min(2, Math.max(0.5, Math.floor(Math.min((w - 48) / maxWidth, byHeight) * 100) / 100)));
  };
  const goToHeading = (h) => {
    const ed = editorsRef.current.get(h.pageId);
    if (!ed) return;
    goToPage(h.pageId, h.pos + 1);
  };
  // Word's Header & Footer opens the header for editing; it never removes
  // one (that is the Remove header / Remove footer button in the margin).
  // It used to clear both on a second click - an imported header gone in one
  // click, with no confirm.
  const toggleHeaderFooter = () => {
    if (!headerVisible) setHeaderVisible(true);
    if (!footerVisible) setFooterVisible(true);
    requestAnimationFrame(() => headerEditor?.commands.focus('end'));
  };
  const openHelp = () => window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'support', sub: 'documentation' } }));

  // Word's Home > Font > Grow/Shrink Font - steps the current selection's
  // font size through FONT_SIZES, defaulting from 12 if none is set yet.
  const stepFontSize = (delta) => {
    if (!activeEditor) return;
    // parseFloat, not parseInt: an imported Word document can carry a
    // fractional size (12.2pt from a source stating 4.3mm), and truncating
    // it to 12 makes Grow step to the size it is already closest to.
    const current = parseFloat(activeEditor.getAttributes('textStyle').fontSize || '12') || 12;
    const idx = FONT_SIZES.findIndex(s => Number(s) >= current);
    const nextIdx = Math.max(0, Math.min(FONT_SIZES.length - 1, (idx === -1 ? FONT_SIZES.length - 1 : idx) + delta));
    activeEditor.chain().focus().setFontSize(`${FONT_SIZES[nextIdx]}pt`).run();
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
        content: [{ type: 'text', text: `${e.text} - p.${e.page}`, marks: [{ type: 'link', attrs: { href: `#toc:${e.pageId}:${e.name}` } }] }],
      }],
    }));
    // The heading starts with a "__toc" bookmark so Update / Remove can find
    // the block again; the bookmark is invisible on export like any other.
    const block = [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'bookmark', attrs: { name: '__toc' } }, { type: 'text', text: 'Table of Contents' }] },
      { type: 'bulletList', content: listItems },
      { type: 'paragraph' },
    ];
    const existing = findTocRange();
    if (existing) existing.editor.chain().focus().deleteRange(existing).insertContentAt(existing.from, block).run();
    else activeEditor.chain().focus('end').insertContent(block).run();
  };
  // { editor, from, to } of the generated table of contents (heading + list), or null.
  const findTocRange = () => {
    for (const p of pages) {
      const ed = editorsRef.current.get(p.id);
      if (!ed) continue;
      let found = null;
      ed.state.doc.forEach((node, offset, index) => {
        if (found || node.type.name !== 'heading') return;
        const first = node.content.firstChild;
        if (!first || first.type.name !== 'bookmark' || first.attrs.name !== '__toc') return;
        const next = ed.state.doc.maybeChild(index + 1);
        const to = offset + node.nodeSize + (next && next.type.name === 'bulletList' ? next.nodeSize : 0);
        found = { editor: ed, from: offset, to };
      });
      if (found) return found;
    }
    return null;
  };
  const removeTableOfContents = () => {
    const r = findTocRange();
    if (!r) { toastErr?.('There is no table of contents to remove.'); return; }
    r.editor.chain().focus().deleteRange(r).run();
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
  // Word's contextual tabs show while their object is selected; a tab whose
  // object is gone falls back to Home.
  const inTable = !!activeEditor?.isActive('table');
  const shapeType = activeEditor?.isActive('docShape') ? 'docShape' : activeEditor?.isActive('docTextbox') ? 'docTextbox' : null;
  const shownTab = (ribbonTab === 'picture' && !imgAttrs) || (/^table/.test(ribbonTab) && !inTable) || (ribbonTab === 'shape' && !shapeType) ? 'home' : ribbonTab;
  const navShown = !preview && !isMobile && viewPrefs.nav;
  const showRulers = !preview && !isMobile && !!rulerOn;
  const rulerPagesEl = rulerPagesElRef.current;
  const rulerScrollerEl = rulerScrollerElRef.current;
  const commentsShown = !preview && !isMobile && commentsOpen;
  const varsShown = !preview && !isMobile && varsOpen && !commentsOpen;
  const navResults = (() => {
    const q = navQuery.trim();
    if (!navShown || navTab !== 'results' || !q) return null;
    const out = [];
    pages.forEach((pg) => {
      const ed = editorsRef.current.get(pg.id);
      if (!ed || ed.isDestroyed) return;
      const size = ed.state.doc.content.size;
      findInEditor(ed, q).forEach((m) => {
        if (out.length >= 200) return;
        const before = ed.state.doc.textBetween(Math.max(0, m.from - 32), m.from, ' ');
        const after = ed.state.doc.textBetween(m.to, Math.min(size, m.to + 48), ' ');
        out.push({ pageId: pg.id, from: m.from, to: m.to, before: (m.from - 32 > 0 ? '…' : '') + before, match: ed.state.doc.textBetween(m.from, m.to, ' '), after });
      });
    });
    return out;
  })();
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
      attrs: { x, y, wrapMode: 'inline' },
      content: [{ type: 'paragraph' }],
    }).scrollIntoView().run();
  };

  // ── Signature blocks (Oct 14) ─────────────────────────────────────────────
  // Where each signer signs is part of the template, so a packet built from it
  // goes to Nexus Sign with every box already on its line.
  const signerOptions = signerRoles.length ? signerRoles : DEFAULT_SIGNERS;
  const saveSignerRoles = (next) => {
    const ordered = next.map((r, i) => ({ ...r, order: i + 1 }));
    setSignerRoles(ordered);
    if (kind !== 'template') return;
    apiUpdate(docId, { signerRoles: ordered })
      .then(res => res && setDoc(d => (d ? { ...d, hasUnpublishedChanges: res.hasUnpublishedChanges, signerRoles: res.signerRoles } : d)))
      .catch(e => toastErr?.(e.message || 'Failed to save the signers'));
  };
  const addSigner = () => {
    const label = sigDraft.newSigner.trim();
    const key = signerKeyOf(label);
    if (!key) return;
    if (!signerOptions.some(r => r.key === key)) saveSignerRoles([...signerOptions, { key, label }]);
    setSigDraft(d => ({ ...d, role: key, newSigner: '' }));
  };
  const usedSignerKeys = () => {
    const used = new Set();
    const walk = (n) => {
      if (!n || typeof n !== 'object') return;
      if (n.type === 'signatureBlock' && n.attrs?.role) used.add(n.attrs.role);
      (n.content || []).forEach(walk);
    };
    for (const p of pages) walk(editorsRef.current.get(p.id)?.getJSON() || p.json);
    return used;
  };
  const removeSigner = (key) => {
    if (usedSignerKeys().has(key)) {
      toastErr?.('A signature block on the page uses this signer - delete the block first.');
      return;
    }
    saveSignerRoles(signerRoles.filter(r => r.key !== key));
  };
  const insertSignatureBlock = () => {
    const role = sigDraft.role || signerOptions[0]?.key || 'employee';
    activeEditor?.chain().focus().insertContent({
      type: 'signatureBlock',
      attrs: { role, label: sigDraft.label.trim(), withName: sigDraft.withName, withDate: sigDraft.withDate },
    }).scrollIntoView().run();
    // A template's Signers list always covers its blocks.
    if (kind === 'template' && !signerRoles.some(r => r.key === role)) {
      const known = signerOptions.find(r => r.key === role);
      saveSignerRoles([...signerRoles, known || { key: role, label: role }]);
    }
    setSigPopoverOpen(false);
    setSigDraft(d => ({ ...d, label: '' }));
  };

  // Publish: release this template's current wording to the HR packets that
  // use it. Autosave never does this - a half-typed edit never reaches a
  // candidate. Documents already out for signature never change.
  const publishTemplate = async () => {
    if (publishing) return;
    if (!(await dialog.confirm(`Publish "${title}"? New documents and HR packets that have not been sent yet use this wording. Documents already made or out for signature do not change.`, { confirmText: 'Publish' }))) return;
    setPublishing(true);
    try {
      await flushPendingSave();
      const res = await api.publishDocTemplate(docId);
      setDoc(d => ({ ...d, ...res }));
      setSignerRoles(res.signerRoles || []);
      toastOk?.(`Published version ${res.publishedVersion}.`);
    } catch (e) {
      toastErr?.(e.message || 'Could not publish the template');
    } finally { setPublishing(false); }
  };

  // Restore an archived template. If it was never published this also publishes
  // (documents.update_template).
  const activateTemplate = async () => {
    if (activating) return;
    setActivating(true);
    try {
      await flushPendingSave();
      const res = await api.updateDocTemplate(docId, { status: 'active' });
      setDoc(d => ({ ...d, ...res }));
      toastOk?.(res.publishedVersion ? `Restored - published version ${res.publishedVersion}.` : 'Restored.');
    } catch (e) {
      toastErr?.(e.message || 'Could not restore the template');
    } finally { setActivating(false); }
  };

  // Phase 5 bridge: hand the document to E-Sign's existing SendWizard via the
  // same window.__esignPrefill + nexus:navigate handoff HR->Hiring already
  // uses - no new backend send path, no change to esign.py's compliance logic.
  // The PDF comes from /signing-pdf (Oct 14): rendered once with its signature
  // blocks measured, so each signer's fields arrive already placed.
  const doSendForSignature = async () => {
    if (doc?.signRequestId && !(await dialog.confirm('This document was already sent for signature. Start a new envelope anyway?', { confirmText: 'Start New Envelope' }))) return;
    setExporting('send');
    flushPendingSave().then(() => api.documentSigningPdf(docId)).then((out) => {
      window.__esignPrefill = { title, source: 'pdf', sourceDocumentId: docId, parties: [], signing: out };
      window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'documents', sub: 'documents-esign' } }));
    }).catch(e => toastErr?.(e.message || 'Failed to prepare document for signature')).finally(() => setExporting(''));
  };

  // Save as Template - copies this document's current content (its
  // mergeField chips included: Document.content always keeps the raw
  // {{token}} nodes, resolved against employee/entity/overrides only at
  // export time, never baked into literal text) into a brand-new DocTemplate
  // via the same create endpoint the Templates library itself uses.
  const [savingTemplate, setSavingTemplate] = useState(false);
  const saveAsTemplate = async () => {
    const name = ((await dialog.prompt('Template name', { defaultValue: title || UNTITLED_TEMPLATE })) || '').trim();
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
      // Live: saved outside the session on purpose - the server drops the
      // shared state, so everyone's session (this one too) rebuilds from it.
      if (live) return apiUpdate(docId, { content: full.content, note: `Restored from v${v.versionNo}` }).then((d) => { live.restart(); return d; });
      applyContent(full.content);
      return apiUpdate(docId, { content: full.content, note: `Restored from v${v.versionNo}` });
    }).then(d => { setDoc(d); toastOk?.(`Restored version ${v.versionNo}`); setHistoryOpen(false); })
      .catch(e => toastErr?.(e.message || 'Failed to restore version'))
      .finally(() => setRestoringId(''));
  };

  // One way in for every variable insertion - the toolbar picker, the library
  // panel and a drag-and-drop all land here, so a variable is always a
  // mergeField NODE and never typed "{{token}}" text that silently never
  // populates because of a typo.
  const insertVariable = (token) => {
    if (!token) return;
    activeEditor?.chain().focus().insertContent({ type: 'mergeField', attrs: { token } }).run();
  };

  // Variables > Previous / Next: select the variable before or after the
  // cursor, in page order, and bring it into view (Word's Go To Field).
  const stepField = (dir, token = null) => {
    const eds = pages.map((p) => [p.id, editorsRef.current.get(p.id)]).filter(([, e]) => e && !e.isDestroyed);
    const all = [];
    eds.forEach(([, e], pi) => e.state.doc.descendants((n, pos) => { if (n.type.name === 'mergeField' && (!token || n.attrs.token === token)) all.push({ e, pos, pi }); }));
    if (!all.length) { toastOk?.('There are no variables in this document yet.'); return; }
    const curPi = Math.max(0, eds.findIndex(([pid]) => pid === activePageId));
    const sel = activeEditor?.state.selection;
    const curPos = sel ? sel.from : -1;
    const after = (f) => f.pi > curPi || (f.pi === curPi && f.pos > curPos);
    const before = (f) => f.pi < curPi || (f.pi === curPi && f.pos < curPos);
    let f = dir > 0 ? all.find(after) : [...all].reverse().find(before);
    if (!f) f = dir > 0 ? all[0] : all[all.length - 1];
    f.e.chain().focus().setNodeSelection(f.pos).run();
    requestAnimationFrame(() => f.e.view.nodeDOM(f.pos)?.scrollIntoView?.({ block: 'center', behavior: 'smooth' }));
  };
  // References > Footnotes (Word's): numbered across every page, in order.
  useEffect(() => { numberFootnotes(pages.map((pg) => editorsRef.current.get(pg.id))); }, [pages, selectionTick]);
  const footnoteList = () => {
    const out = [];
    pages.forEach((pg) => {
      const e = editorsRef.current.get(pg.id);
      if (!e || e.isDestroyed) return;
      e.state.doc.descendants((n, pos) => { if (n.type.name === 'footnote') out.push({ e, pos, text: n.attrs.text || '' }); });
    });
    return out;
  };
  const insertFootnote = async () => {
    const e = activeEditor;
    if (!e) return;
    const at = e.state.selection.to;
    const text = await dialog.prompt('Footnote', { defaultValue: '', confirmText: 'Insert', required: true, placeholder: 'The note at the foot of the page' });
    if (!text || !text.trim() || e.isDestroyed) return;
    e.chain().focus().insertContentAt(at, { type: 'footnote', attrs: { text: text.trim() } }).run();
  };
  const editFootnote = async (e, pos) => {
    const node = e.state.doc.nodeAt(pos);
    if (!node || node.type.name !== 'footnote') return;
    const text = await dialog.prompt('Footnote', { defaultValue: node.attrs.text || '', confirmText: 'Save' });
    if (text == null || e.isDestroyed) return;
    const cur = e.state.doc.nodeAt(pos);
    if (!cur || cur.type.name !== 'footnote') return;
    if (!text.trim()) e.chain().focus().deleteRange({ from: pos, to: pos + cur.nodeSize }).run();
    else e.chain().focus().command(({ tr }) => { tr.setNodeMarkup(pos, undefined, { ...cur.attrs, text: text.trim() }); return true; }).run();
  };
  const editFootnoteRef = useRef(editFootnote);
  editFootnoteRef.current = editFootnote;
  useEffect(() => {
    const onClick = (ev) => {
      const el = ev.target.closest?.('sup.doc-footnote');
      if (!el || !el.closest('.doc-page')) return;
      for (const e of editorsRef.current.values()) {
        if (!e.view.dom.contains(el)) continue;
        if (!e.isEditable) return;
        editFootnoteRef.current(e, e.view.posAtDOM(el, 0));
        return;
      }
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);
  const stepFootnote = () => {
    const list = footnoteList();
    if (!list.length) { toastOk?.('There are no footnotes in this document yet.'); return; }
    const curPos = activeEditor?.state.selection.from ?? -1;
    const pageOrder = pages.map((pg) => editorsRef.current.get(pg.id));
    const ai = pageOrder.indexOf(activeEditor);
    const f = list.find((x) => pageOrder.indexOf(x.e) > ai || (x.e === activeEditor && x.pos > curPos)) || list[0];
    f.e.chain().focus().setNodeSelection(f.pos).run();
    requestAnimationFrame(() => f.e.view.nodeDOM(f.pos)?.scrollIntoView?.({ block: 'center', behavior: 'smooth' }));
  };
  // Opens the Variables rail; Comments, its neighbor on the right, steps aside.
  const openVars = (tab = 'used') => { setVarsTab(tab); setVarsOpen(true); setCommentsOpen(false); };
  const toggleVars = (tab) => { if (varsOpen && varsTab === tab) setVarsOpen(false); else openVars(tab); };
  useEffect(() => { if (commentsOpen) setVarsOpen(false); }, [commentsOpen]);

  // Converts every {{token}} already sitting on the page into a real merge
  // field. Import does this automatically; this is for content that arrived
  // some other way - pasted in, or written before the importer knew how - and
  // for the documents that are already saved with their braces showing.
  const [detecting, setDetecting] = useState(false);
  const detectVariablesOn = async (onlyPageId, { quiet = false } = {}) => {
    if (detecting) return;
    setDetecting(true);
    try {
      let total = 0;
      const found = [];
      for (const p of pages) {
        if (onlyPageId && p.id !== onlyPageId) continue;
        const ed = editorsRef.current.get(p.id);
        if (!ed) continue;
        const { json, tokens } = extractVariables(ed.getJSON());
        if (!tokens.length) continue;
        total += tokens.length;
        tokens.forEach(t => { if (!found.includes(t)) found.push(t); });
        // emitUpdate keeps the autosave honest - the page really did change.
        ed.commands.setContent(json, { emitUpdate: true });
      }
      if (!total) { if (!quiet) toastOk?.('No {{variables}} found on this page.'); return; }
      let added = [];
      if (kind === 'template') {
        const merged = mergeFieldDefs(fieldDefs, found, { builtins: builtinSet, shared });
        added = merged.added;
        if (added.length) {
          setFieldDefs(merged.fieldDefs);
          await apiUpdate(docId, { fieldDefs: merged.fieldDefs });
          // Pasted from Word, or typed: same reason as the import path - offer
          // the types straight away rather than leaving the guesses standing.
          openFieldsPanel(added.map(fd => fd.token));
        }
      }
      scheduleSave();
      toastOk?.(`${found.length} variable${found.length === 1 ? '' : 's'} converted`
        + (added.length ? `, ${added.length} added to this template.` : '.'));
    } catch (e) {
      toastErr?.(e.message || 'Could not convert the variables on this page');
    } finally { setDetecting(false); }
  };

  const detectVariables = () => detectVariablesOn(null);
  detectRef.current = detectVariablesOn;   // so the update handler calls today's closure

  // Dropping a variable from the library onto the page inserts it exactly
  // where it was dropped, not wherever the cursor happened to be.
  const onVariableDrop = (pageId, e) => {
    const token = variableFromDrop(e);
    if (!token) return;                       // some other drag (a file, text) - leave it alone
    e.preventDefault();
    if (e.nativeEvent?.nxVariableHandled) return;   // the page editor placed it (handleDrop above)
    const ed = editorsRef.current.get(pageId);
    if (!ed) return;
    const at = ed.view.posAtCoords({ left: e.clientX, top: e.clientY });
    const chain = ed.chain().focus();
    (at ? chain.insertContentAt(at.pos, { type: 'mergeField', attrs: { token } })
        : chain.insertContent({ type: 'mergeField', attrs: { token } })).run();
    onPageActivity(pageId);
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
      // A built-in has nothing to set - Nexus fills it; show where from.
      if (builtinSet.has(token) && !fieldDefs.some((f) => f.token === token)) { openFieldsPanel(); return; }
      const start = shared[token] ? mergeFieldDefs([], [token], { shared }).added[0] : {};
      const existingDef = fieldDefs.find((f) => f.token === token)
        || { token, label: FRIENDLY_MERGE[token] || token, type: 'text', required: false, validation: {}, ...start };
      setMergeFieldModal({ existingDef });
    };
    dom.addEventListener('dblclick', onDblClick);
    return () => dom.removeEventListener('dblclick', onDblClick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeEditor, kind, fieldDefs, builtinSet, shared]);

  // Open a placed variable's field for editing - the rail's double-click and
  // the chip's double-click above do the same thing.
  const editVariable = (token) => {
    if (builtinSet.has(token) && !fieldDefs.some((f) => f.token === token)) { openFieldsPanel(); return; }
    const start = shared[token] ? mergeFieldDefs([], [token], { shared }).added[0] : {};
    const existingDef = fieldDefs.find((f) => f.token === token)
      || { token, label: FRIENDLY_MERGE[token] || token, type: 'text', required: false, validation: {}, ...start };
    setMergeFieldModal({ existingDef });
  };

  // The Make Variable bubble (Sagar, 11/04/2026: "if we double click on any
  // text it should show us the option to make that as a variable"). A
  // double-click selects the word and a drag selects a phrase; either way a
  // non-empty text selection on an editable template page shows one button
  // over where it starts, and that button is Convert to Merge Field for
  // exactly that range. It follows the selection through scrolls and goes
  // away when the selection collapses or the page loses focus.
  useEffect(() => {
    if (!activeEditor || kind !== 'template' || preview || isLocked) { setSelBubble(null); return undefined; }
    const place = () => {
      const { from, to, empty } = activeEditor.state.selection;
      if (empty || !activeEditor.isFocused) { setSelBubble(null); return; }
      const text = activeEditor.state.doc.textBetween(from, to, ' ').trim();
      if (!text) { setSelBubble(null); return; }
      try {
        const at = activeEditor.view.coordsAtPos(from);
        setSelBubble({ left: at.left, top: at.top, text });
      } catch { setSelBubble(null); }
    };
    const hide = () => setSelBubble(null);
    place();
    activeEditor.on('blur', hide);
    activeEditor.on('focus', place);
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      activeEditor.off('blur', hide);
      activeEditor.off('focus', place);
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
    // selectionTick: every selection change and every edit bumps it.
  }, [activeEditor, kind, preview, isLocked, selectionTick]);

  const saveFieldDefs = (next) => {
    setFieldDefs(next);
    apiUpdate(docId, { fieldDefs: next }).catch((e) => toastErr?.(e.message || 'Could not save the template fields'));
  };

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
  const addPage = (at = null) => {
    const id = genPageId();
    pendingFocusId.current = id;
    setPages(prev => {
      if (at == null || at >= prev.length) return [...prev, { id, json: null }];
      const next = [...prev]; next.splice(Math.max(0, at), 0, { id, json: null }); return next;
    });
    scheduleSave(); // new page mounts with content already in place, which never fires onUpdate on its own
  };
  // Insert > Blank Page: Word's - a new page right after the one you are on.
  const activeIdx = () => Math.max(0, pages.findIndex((pg) => pg.id === activePageId));
  const blankPage = () => addPage(activeIdx() + 1);
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
    const replace = changePictureRef.current;
    changePictureRef.current = false;
    const path = `${docId}/${Date.now()}-${safeName(file.name)}`;
    const { url, error } = await uploadToSupabase(file, 'document-images', path);
    if (error) { toastErr?.(error); return; }
    const ed = editorsRef.current.get(pageId);
    if (replace && ed?.isActive('image')) ed.chain().focus().updateAttributes('image', { src: url }).run();
    else ed?.chain().focus().setImage({ src: url }).run();
  };

  const onPickImage = (e) => {
    const file = e.target.files?.[0];
    if (file && activePageId) doUploadImage(activePageId, file);
    e.target.value = '';
  };

  const onBodyPaste = (pageId, e) => {
    const f = imageFromPaste(e);
    if (f) { e.preventDefault(); doUploadImage(pageId, f); return; }
    // Nothing else to do here: {{tokens}} in pasted text are picked up by the
    // page's own update watcher above, whenever ProseMirror gets round to
    // committing them.
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
    const path = `${docId}/imported-${Date.now()}-${n}.${extGuess}`;
    const file = new File([bytes], `imported-${n}.${extGuess}`, { type: mime || 'image/png' });
    const { url, error } = await uploadToSupabase(file, 'document-images', path);
    return error ? '' : url;
  };

  const doImportFile = async (file) => {
    if (!file) return;
    const isEmpty = pages.length <= 1 && (activeEditor?.isEmpty ?? true);
    if (!isEmpty && !(await dialog.confirm('This will replace the current document content. Continue?', { confirmText: 'Replace' }))) return;
    setImporting(true);
    try {
      const { html, json: rawJson, pageSetup: importedPageSetup, header: rawHeader, footer: rawFooter, warnings, comments: importedComments } = await importDocumentFile(file, { uploadImage: uploadImportedImage });
      // A Word file's comments become this document's Review threads (Neil,
      // 11/11/2026: "fully word compatible"); the marks are pointed at them.
      // Each says who wrote it in Word - the thread itself is the importer's.
      const commentIds = {};
      for (const c of importedComments || []) {
        try {
          const who = c.author ? `${c.author} (in Word): ` : 'From Word: ';
          const made = await commentStore.add(`${who}${c.text}`, c.quote);
          if (made?.id) commentIds[c.id] = made.id;
        } catch { /* the words stay; the mark goes below */ }
      }
      const pointComments = (node) => {
        if (!node || typeof node !== 'object') return node;
        const out = { ...node };
        if (Array.isArray(out.marks)) {
          out.marks = out.marks.flatMap((m) => (m.type !== 'comment' ? [m] : commentIds[m.attrs?.id] ? [{ ...m, attrs: { ...m.attrs, id: commentIds[m.attrs.id] } }] : []));
          if (!out.marks.length) delete out.marks;
        }
        if (Array.isArray(out.content)) out.content = out.content.map(pointComments);
        return out;
      };
      const directJson = rawJson ? pointComments(rawJson) : rawJson;
      const importedHeader = rawHeader ? pointComments(rawHeader) : rawHeader;
      const importedFooter = rawFooter ? pointComments(rawFooter) : rawFooter;
      const json = directJson || generateJSON(html || '<p></p>', BODY_EXTENSIONS);
      // The imported doc still carries pageBreak markers (docxToTiptap.js
      // preserves Word's own page breaks) - split it into real pages the same
      // way a pre-rewrite document upgrades on load, rather than dumping the
      // whole import onto a single page.
      // Any {{token}} the Word document was written with becomes a real merge
      // field here, and the template gains a definition for each new one. Two
      // reasons: nobody should have to delete placeholders and re-insert them
      // one at a time, and a token left as plain TEXT never populates at all -
      // the generator only substitutes merge-field nodes.
      const { json: withFields, tokens } = extractVariables(repairDocJson(json));
      const newPages = splitBodyIntoPages(withFields);
      editorsRef.current = new Map();
      setPages(newPages);
      setActivePageId(newPages[0]?.id || '');
      // .docx imports carry the source file's own page size/orientation/
      // margins (docxToTiptap.js) - apply them so the imported page setup
      // matches the original, not whatever this document had before.
      if (importedPageSetup) updatePageSetup(importedPageSetup);
      // The Word file's own header and footer replace this document's, like
      // its body does - a .docx with none clears them.
      if (directJson) {
        const band = (json, setVisible, ed) => {
          if (json) { setVisible(true); ed?.commands.setContent(repairDocJson(json), { emitUpdate: false }); }
          else { setVisible(false); ed?.commands.clearContent(); }
        };
        band(importedHeader, setHeaderVisible, headerEditor);
        band(importedFooter, setFooterVisible, footerEditor);
      }
      // Save the discovered variables onto the template, leaving any the author
      // already configured by hand exactly as they are.
      let added = [];
      if (tokens.length && kind === 'template') {
        const merged = mergeFieldDefs(fieldDefs, tokens, { builtins: builtinSet, shared });
        added = merged.added;
        if (added.length) {
          setFieldDefs(merged.fieldDefs);
          await apiUpdate(docId, { fieldDefs: merged.fieldDefs })
            .catch(e => toastErr?.(e.message || 'Imported, but the variables could not be saved'));
        }
      }
      // Straight into the field list when an import brought variables in: the
      // types are only guesses from the names until somebody says otherwise,
      // and this is the moment the author is looking at the template.
      if (added.length) openFieldsPanel(added.map(fd => fd.token));
      const found = tokens.length
        ? ` ${tokens.length} variable${tokens.length === 1 ? '' : 's'} detected${added.length ? `, ${added.length} added to this template` : ''}.`
        : '';
      const filed = Object.keys(commentIds).length;
      if (filed) { setCommentsOpen(true); }
      const commentNote = filed ? ` ${filed} comment${filed === 1 ? '' : 's'} from Word ${filed === 1 ? 'is' : 'are'} on the Review tab.` : '';
      if (warnings?.length) toastErr?.(`Imported with notes: ${warnings.slice(0, 2).join(' ')}${found}${commentNote}`);
      else toastOk?.(`Imported - review formatting before sending.${found}${commentNote}`);
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
      <Spinner size="section" />
    </div>
  );

  // The menu bar (Neil, 11/10/2026): every command, by menu, with its icon
  // and shortcut - the ribbon's own actions, nothing new behind them.
  const ed = activeEditor;
  const isDoc = kind === 'document';
  const editing = !preview && !readOnly && !isLocked && !viewingOnly;
  const blockAttrs = ed ? ed.getAttributes(currentBlockType()) : {};
  const curStyle = currentStyle(ed);
  // The ruler's markers: the paragraph you are in, in points. A level-based
  // indent (Increase Indent) reads as 18 pt a level, the exporter's measure.
  const paraIndents = (() => {
    if (!ed || ed.isDestroyed || !editing) return null;
    const a = blockAttrs || {};
    const left = a.indentLeft != null ? Number(a.indentLeft) || 0 : (Number(a.indent) || 0) * 18;
    return { left, first: Number(a.indentFirst) || 0, right: Number(a.indentRight) || 0 };
  })();
  // A ruler drag: every paragraph and heading in the selection takes it. A
  // measured left indent replaces the level-based one, so the two never add.
  const applyIndents = (patch) => {
    if (!ed) return;
    const attrs = {};
    for (const [k, v] of Object.entries(patch)) attrs[k] = v ? v : null;
    if ('indentLeft' in attrs) attrs.indent = 0;
    ed.chain().focus().updateAttributes('paragraph', attrs).updateAttributes('heading', attrs).run();
  };
  // The ruler's tab stops: the paragraph you are in; a change is written to
  // every paragraph and heading in the selection.
  const paraTabs = paraIndents ? cleanTabStops(blockAttrs.tabStops) : [];
  const applyTabStops = (next) => {
    if (!ed) return;
    const v = cleanTabStops(next);
    ed.chain().focus().updateAttributes('paragraph', { tabStops: v.length ? v : null }).updateAttributes('heading', { tabStops: v.length ? v : null }).run();
  };
  // A ruler's margin edge: Page Setup's Custom margins, that one side changed.
  const setMarginInches = (side, inches) => {
    updatePageSetup({ margins: 'custom', marginIn: { ...marginsOf(pageSetup), [side]: inches } });
  };
  const openOnRibbon = (tab, open) => { setRibbonCollapsed(false); setRibbonTab(tab); open?.(); };
  const keyTipTab = keyTipTabRef.current;
  const pageBreak = () => ed?.chain().focus().insertContent([{ type: 'pageBreak' }, { type: 'paragraph' }]).run();
  const linkCmd = () => openOnRibbon('insert', toggleLinkPopover);
  const commentCmd = () => { if (ed && !ed.state.selection.empty) startComment(); else toastOk?.('Select the words to comment on first.'); };
  const clearFormatting = () => ed?.chain().focus().unsetAllMarks().clearNodes().run();
  const spacing = (label, v) => ({ label, checked: blockAttrs.lineHeight === v, onClick: () => setLineHeight(v), disabled: !editing });
  const mark = (label, name, toggle, icon, shortcut) => ({ label, icon, shortcut, checked: !!ed?.isActive(name), disabled: !editing || !ed, onClick: () => ed?.chain().focus()[toggle]().run() });
  const align = (label, v, icon, shortcut) => ({ label, icon, shortcut, cardLabel: `Align ${label}`, checked: !!ed?.isActive({ textAlign: v }), disabled: !editing || !ed, onClick: () => ed?.chain().focus().setTextAlign(v).run() });
  menuKeysRef.current = {
    find: () => setFindOpen(true), link: editing ? linkCmd : null, pageBreak: editing ? pageBreak : null, comment: commentCmd,
    clearFormatting: editing ? clearFormatting : null, shortcuts: () => setShortcutsOpen(true), wordCount: () => setWordCountOpen(true), collapseRibbon: toggleRibbon,
    font: editing && ed ? () => setFontDlg(true) : null,
    footnote: editing && ed ? insertFootnote : null,
    cycleCase: editing && ed ? () => {
      const { from, to, empty } = ed.state.selection;
      if (empty) return;
      const t = ed.state.doc.textBetween(from, to, '\n');
      changeCase(t === t.toUpperCase() ? 'lower' : t === t.toLowerCase() ? 'title' : 'upper');   // Word's Shift+F3 cycle
    } : null,
    word: editing && ed ? {
      align: (v) => ed.chain().focus().setTextAlign(v).run(),
      size: stepFontSize,
      indent: changeIndent,
      // Ctrl+T: a hanging indent half an inch deeper (Ctrl+Shift+T undoes one).
      hanging: (dir) => {
        const a = paraIndents || { left: 0, first: 0 };
        const left = Math.max(0, a.left + 36 * dir);
        applyIndents({ indentLeft: left, indentFirst: left ? Math.min(0, a.first - 36 * dir) : 0 });
      },
      clearParagraph: () => ed.chain().focus().updateAttributes('paragraph', { textAlign: null, indent: 0, indentLeft: null, indentFirst: null, indentRight: null, spacingBefore: null, spacingAfter: null, lineHeight: null, tabStops: null }).updateAttributes('heading', { textAlign: null, indentLeft: null, indentFirst: null, indentRight: null }).run(),
      clearCharacter: () => ed.chain().focus().unsetAllMarks().run(),
    } : null,
  };
  const docMenus = [
    { label: 'File', items: [
      { label: 'New Document', icon: FilePlus, onClick: () => close().then((ok) => { if (ok) window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'documents', sub: 'documents-new' } })); }) },
      { label: 'Rename', icon: Type, disabled: readOnly || isLocked, onClick: () => { titleRef.current?.focus(); titleRef.current?.select(); } },
      isDoc && doc?.access && { label: 'Share...', icon: Users, onClick: () => setShareOpen(true) },
      '-',
      !preview && { label: 'Import a File...', icon: Upload, disabled: !editing, onClick: () => setImportPopoverOpen(true) },
      { label: 'Version History', icon: History, onClick: openHistory },
      '-',
      isDoc && { label: 'Download', icon: FileDown, items: [
        { label: 'PDF Document (.pdf)', disabled: !!exporting, onClick: () => doExport('pdf') },
        { label: 'Word Document (.docx)', disabled: !!exporting, onClick: () => doExport('docx') },
      ] },
      !isDoc && { label: 'Download as Word (.docx)', icon: FileDown, hint: 'Variables as merge fields', disabled: !!exporting, onClick: () => doExport('docx') },
      isDoc && { label: 'Open in Word', icon: PageIcon, disabled: !!exporting, onClick: openInWord },
      isDoc && { label: 'Save as Template', icon: FileStack, disabled: savingTemplate, onClick: saveAsTemplate },
      isDoc && { label: 'Preview & Send', icon: Send, onClick: () => { setPreview(true); openPdfPreview(); } },
      '-',
      { label: 'Page Setup...', icon: FileStack, onClick: () => openOnRibbon('layout', () => setPageSetupOpen(true)) },
      { label: 'Print', icon: Printer, shortcut: 'Mod+P', onClick: () => window.print() },
      '-',
      { label: 'Close', icon: X, onClick: close },
    ] },
    { label: 'Edit', items: [
      { label: 'Undo', icon: Undo, shortcut: 'Mod+Z', disabled: !editing || !ed?.can().undo(), onClick: () => ed?.chain().focus().undo().run() },
      { label: 'Redo', icon: Redo, shortcut: 'Mod+Y', disabled: !editing || !ed?.can().redo(), onClick: () => ed?.chain().focus().redo().run() },
      '-',
      { label: 'Cut', icon: Scissors, shortcut: 'Mod+X', disabled: !editing, onClick: () => clipboardAction('cut') },
      { label: 'Copy', icon: ClipboardCopy, shortcut: 'Mod+C', onClick: () => clipboardAction('copy') },
      { label: 'Paste', icon: ClipboardPaste, shortcut: 'Mod+V', disabled: !editing, onClick: () => clipboardAction('paste') },
      { label: 'Paste Without Formatting', shortcut: 'Mod+Shift+V', disabled: !editing, onClick: pasteTextOnly },
      '-',
      { label: 'Select All', icon: MousePointerSquareDashed, shortcut: 'Mod+A', onClick: () => ed?.chain().focus().selectAll().run() },
      { label: 'Format Painter', icon: Paintbrush, checked: !!painterActive, disabled: !editing, onClick: () => toggleFormatPainter(false) },
      '-',
      { label: 'Find and Replace', icon: Search, shortcut: 'Mod+H', onClick: () => setFindOpen(true) },
    ] },
    { label: 'View', items: [
      { label: 'Mode', icon: docMode === 'Viewing' ? EyeOff : docMode === 'Reviewing' ? PenLine : Type, hint: docMode, items: [
        { label: 'Editing', checked: docMode === 'Editing', onClick: () => { setViewingOnly(false); if (tracking !== 'off') setTrackingMode('off'); } },
        { label: 'Reviewing', checked: docMode === 'Reviewing', onClick: () => { setViewingOnly(false); setTrackingMode('everyone'); } },
        { label: 'Viewing', checked: docMode === 'Viewing', onClick: () => setViewingOnly(true) },
      ] },
      '-',
      { label: 'Print Layout', checked: !!viewPrefs.paginate, onClick: () => setPref('paginate', !viewPrefs.paginate) },
      { label: 'Reading View', icon: BookOpen, onClick: () => { setPreview(true); if (isDoc) openPdfPreview(); } },
      '-',
      { label: 'Show Ruler', checked: !!rulerOn, onClick: () => setRulerOn(!rulerOn) },
      { label: 'Show Navigation', checked: !!viewPrefs.nav, onClick: () => setPref('nav', !viewPrefs.nav) },
      { label: 'Show Comments', checked: !!commentsOpen, onClick: () => setCommentsOpen((o) => !o) },
      { label: 'Show Header & Footer', checked: !!(headerVisible || footerVisible), onClick: toggleHeaderFooter },
      { label: 'Show Formatting Marks', checked: !!showMarks, onClick: () => setShowMarks((v) => !v) },
      '-',
      { label: 'Zoom', icon: ZoomIn, hint: `${Math.round(zoom * 100)}%`, items: [
        ...[50, 75, 100, 125, 150, 200].map((n) => ({ label: `${n}%`, checked: Math.round(zoom * 100) === n, onClick: () => setZoom(n / 100) })),
        '-', { label: 'Page Width', onClick: zoomToPageWidth }, { label: 'Fit Page', onClick: zoomToFit },
      ] },
      '-',
      { label: 'Collapse Ribbon', shortcut: 'Mod+F1', checked: ribbonCollapsed, onClick: toggleRibbon },
      { label: 'Full Screen', checked: !!full, onClick: toggleFull },
    ] },
    { label: 'Insert', items: [
      { label: 'Picture', icon: ImagePlus, disabled: !editing, items: [
        { label: 'From This Device...', onClick: () => fileInputRef.current?.click() },
        { label: 'From the Clipboard', onClick: () => toastOk?.('Click where the picture goes and press Ctrl+V with it on the clipboard.') },
      ] },
      { label: 'Table', icon: TableIcon, disabled: !editing || !ed, items: [
        ...[[2, 2], [3, 3], [4, 4], [3, 5], [5, 5]].map(([c, rr]) => ({ label: `${c} x ${rr} Table`, onClick: () => ed?.chain().focus().insertTable({ rows: rr, cols: c, withHeaderRow: false }).run() })),
        '-', { label: 'Other Sizes...', onClick: () => openOnRibbon('insert') },
      ] },
      { label: 'Drawing', icon: Shapes, disabled: !editing, onClick: () => openOnRibbon('insert', () => setShapePopoverOpen(true)) },
      { label: 'Text Box', icon: Type, disabled: !editing, onClick: insertTextbox },
      '-',
      { label: 'Link', icon: Link2, shortcut: 'Mod+K', disabled: !editing, onClick: linkCmd },
      { label: 'Bookmark', icon: Bookmark, disabled: !editing, onClick: () => openOnRibbon('insert', () => setBookmarkPopoverOpen(true)) },
      { label: 'Table of Contents', icon: ListTree, disabled: !editing, items: [
        { label: 'Insert Table of Contents', onClick: insertTableOfContents },
        { label: 'Update Table of Contents', onClick: insertTableOfContents, disabled: !findTocRange() },
        { label: 'Remove Table of Contents', onClick: removeTableOfContents, disabled: !findTocRange() },
      ] },
      { label: 'Comment', icon: MessageSquare, shortcut: 'Mod+Alt+M', onClick: commentCmd },
      '-',
      { label: 'Header & Footer', icon: LayoutPanelTop, checked: !!(headerVisible || footerVisible), onClick: toggleHeaderFooter },
      { label: 'Page Numbers', icon: Hash, items: [
        ...[['bottom-left', 'Bottom Left'], ['bottom-center', 'Bottom Center'], ['bottom-right', 'Bottom Right'], ['top-right', 'Top Right']].map(([v, l]) => ({ label: l, checked: pageSetup.pageNumbers === v, onClick: () => updatePageSetup({ pageNumbers: v }) })),
        '-', { label: 'Remove Page Numbers', onClick: () => updatePageSetup({ pageNumbers: 'none' }) },
      ] },
      { label: 'Page Break', icon: SeparatorHorizontal, shortcut: 'Mod+Enter', disabled: !editing || !ed, onClick: pageBreak },
      isDoc && { label: 'Blank Page', icon: FilePlus, disabled: !editing, onClick: blankPage },
      '-',
      { label: 'Special Characters...', icon: Smile, disabled: !editing, onClick: () => openOnRibbon('insert', () => setSymbolPopoverOpen(true)) },
      { label: 'Signature Block...', icon: PenLine, disabled: !editing, onClick: () => openOnRibbon('insert', () => { setSigPopoverOpen(true); setSigDraft((d) => ({ ...d, role: d.role || signerOptions[0]?.key || '' })); }) },
      { label: 'Variable...', icon: Variable, disabled: !editing, onClick: () => openVars('library') },
    ] },
    { label: 'Format', items: [
      { label: 'Font...', icon: Type, shortcut: 'Mod+D', disabled: !editing || !ed, onClick: () => setFontDlg(true) },
      { label: 'Paragraph...', icon: Pilcrow, disabled: !editing || !ed, onClick: () => setParaDlg(true) },
      '-',
      { label: 'Text', icon: Bold, items: [
        mark('Bold', 'bold', 'toggleBold', Bold, 'Mod+B'),
        mark('Italic', 'italic', 'toggleItalic', Italic, 'Mod+I'),
        mark('Underline', 'underline', 'toggleUnderline', Underline, 'Mod+U'),
        mark('Strikethrough', 'strike', 'toggleStrike', Strikethrough, 'Mod+Shift+S'),
        '-',
        mark('Superscript', 'superscript', 'toggleSuperscript', SuperscriptIcon, 'Mod+.'),
        mark('Subscript', 'subscript', 'toggleSubscript', SubscriptIcon, 'Mod+,'),
        '-',
        { label: 'Grow Font', shortcut: 'Mod+]', onClick: () => stepFontSize(1), disabled: !editing },
        { label: 'Shrink Font', shortcut: 'Mod+[', onClick: () => stepFontSize(-1), disabled: !editing },
        { label: 'Change Case', shortcut: 'Shift+F3', onClick: () => menuKeysRef.current.cycleCase?.(), disabled: !editing },
        { label: 'Clear Character Formatting', shortcut: 'Mod+Space', onClick: () => ed?.chain().focus().unsetAllMarks().run(), disabled: !editing },
      ] },
      { label: 'Paragraph Styles', icon: Pilcrow, hint: curStyle?.label, disabled: !editing || !ed, items: PARA_STYLES.map((st) => ({
        label: st.label, cardLabel: st.key === 'normal' ? 'Normal Text' : undefined, checked: curStyle?.key === st.key,
        shortcut: st.key === 'normal' ? 'Mod+Alt+0' : /^h[1-4]$/.test(st.key) ? `Mod+Alt+${st.key[1]}` : undefined,
        onClick: () => st.apply(ed.chain().focus()).run(),
      })) },
      { label: 'Align', icon: AlignLeft, disabled: !editing || !ed, items: [
        align('Left', 'left', AlignLeft, 'Mod+L'), align('Center', 'center', AlignCenter, 'Mod+E'), align('Right', 'right', AlignRight, 'Mod+R'), align('Justified', 'justify', AlignJustify, 'Mod+J'),
      ] },
      { label: 'Line & Paragraph Spacing', icon: AlignVerticalSpaceAround, disabled: !editing || !ed, items: [
        spacing('Single', '1.2'), spacing('1.15', '1.38'), spacing('1.5', '1.8'), spacing('Double', '2.4'), '-',
        blockAttrs.spacingBefore ? { label: 'Remove Space Before Paragraph', onClick: () => setParaAttr({ spacingBefore: null }) } : { label: 'Add Space Before Paragraph', onClick: () => setParaAttr({ spacingBefore: 12 }) },
        blockAttrs.spacingAfter ? { label: 'Remove Space After Paragraph', onClick: () => setParaAttr({ spacingAfter: null }) } : { label: 'Add Space After Paragraph', onClick: () => setParaAttr({ spacingAfter: 12 }) },
      ] },
      { label: 'Bullets & Numbering', icon: List, disabled: !editing || !ed, items: [
        { label: 'Bulleted List', icon: List, shortcut: 'Mod+Shift+8', checked: !!ed?.isActive('bulletList'), onClick: () => ed?.chain().focus().toggleBulletList().run() },
        { label: 'Numbered List', icon: ListOrdered, shortcut: 'Mod+Shift+7', checked: !!ed?.isActive('orderedList'), onClick: () => ed?.chain().focus().toggleOrderedList().run() },
        '-',
        { label: 'Increase Indent', icon: Indent, shortcut: 'Mod+M', onClick: () => changeIndent(1) },
        { label: 'Decrease Indent', icon: Outdent, shortcut: 'Mod+Shift+M', onClick: () => changeIndent(-1) },
        { label: 'Hanging Indent', shortcut: 'Mod+T', onClick: () => menuKeysRef.current.word?.hanging(1) },
        { label: 'Clear Paragraph Formatting', shortcut: 'Mod+Q', onClick: () => menuKeysRef.current.word?.clearParagraph() },
      ] },
      { label: 'Change Case', icon: Type, disabled: !editing || !ed, items: [
        { label: 'Sentence case', onClick: () => changeCase('sentence') }, { label: 'lowercase', onClick: () => changeCase('lower') },
        { label: 'UPPERCASE', onClick: () => changeCase('upper') }, { label: 'Capitalize Each Word', onClick: () => changeCase('title') },
      ] },
      { label: 'Columns', icon: Columns2, disabled: !editing, items: [[1, 'One'], [2, 'Two'], [3, 'Three']].map(([n, l]) => ({ label: l, checked: (pageSetup.columns || 1) === n, onClick: () => updatePageSetup({ columns: n }) })) },
      '-',
      { label: 'Clear Formatting', icon: Eraser, shortcut: 'Mod+\\', disabled: !editing || !ed, onClick: clearFormatting },
    ] },
    { label: 'Tools', items: [
      { label: 'Spelling', icon: SpellCheck, checked: !!viewPrefs.spell, onClick: () => setPref('spell', !viewPrefs.spell) },
      { label: 'Word Count', icon: FileSearch, shortcut: 'Mod+Shift+C', onClick: () => setWordCountOpen(true) },
      { label: 'Check Accessibility', icon: Accessibility, onClick: () => setA11yIssues(accessibilityIssues([...editorsRef.current.values()])) },
      '-',
      { label: 'Track Changes', icon: PenLine, hint: tracking === 'off' ? 'Off' : tracking === 'mine' ? 'Just Mine' : 'For Everyone', items: [
        { label: 'Off', checked: tracking === 'off', onClick: () => setTrackingMode('off') },
        { label: 'For Everyone', cardLabel: 'Track Changes On / Off', checked: tracking === 'everyone', shortcut: 'Mod+Shift+E', onClick: () => setTrackingMode('everyone') },
        { label: 'Just Mine', checked: tracking === 'mine', onClick: () => setTrackingMode('mine') },
        '-',
        { label: 'Accept All Changes', disabled: !changeCount, onClick: () => resolveAll(true) },
        { label: 'Reject All Changes', disabled: !changeCount, onClick: () => resolveAll(false) },
      ] },
      canDictate() && { label: dictation.listening ? 'Stop Dictating' : 'Dictate', icon: Mic, checked: dictation.listening, disabled: !editing, onClick: () => (dictation.listening ? dictation.stop() : dictation.start()) },
      '-',
      { label: 'Detect Variables', icon: Wand2, disabled: !editing || detecting, onClick: detectVariables },
      { label: 'Variables', icon: Variable, checked: !!varsOpen, onClick: () => (varsOpen ? setVarsOpen(false) : openVars('used')) },
      { label: 'Preview Results', icon: Eye, checked: previewResults, onClick: () => setPreviewResults((v) => !v) },
      kind === 'template' && { label: 'Template Fields', icon: ListChecks, onClick: () => openFieldsPanel() },
    ] },
    { label: 'Help', items: [
      { label: 'Documents Guide', icon: HelpCircle, onClick: openHelp },
      { label: 'Keyboard Shortcuts', icon: BookOpen, shortcut: 'Mod+/', onClick: () => setShortcutsOpen(true) },
      { label: 'Search the Menus', icon: Search, shortcut: 'Alt+/', onClick: () => document.querySelector('.doc-mb-search input')?.focus() },
    ] },
  ].map((m) => ({ ...m, items: m.items.filter(Boolean).filter((it, i, a) => it !== '-' || (i > 0 && a[i - 1] !== '-' && i < a.length - 1)) }));

  // The title row's old popovers, now drawn in the ribbon (Design > Letterhead,
  // Variables > Merge Data) and in File > Import a File... (11/11/2026).
  const letterheadPanel = () => (
    <div className="nx-docb-lhpanel" style={{ width: newLhOpen ? 260 : 220, padding: 2 }}>
      {!newLhOpen ? (<>
        <button onClick={() => changeLetterhead('')}
          style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: '7px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 13, color: 'var(--ink)' }}>No Letterhead</button>
        {letterheads.map(l => (
          <button key={l.id} onClick={() => changeLetterhead(l.id)}
            style={{ display: 'block', width: '100%', textAlign: 'left', background: l.id === letterheadId ? 'var(--mist)' : 'none', border: 'none', padding: '7px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 13, color: 'var(--ink)' }}>
            {l.name}{l.isDefault ? ' (default)' : ''}
          </button>
        ))}
        <div style={{ borderTop: '1px solid var(--line)', margin: '4px 0' }} />
        <button onClick={() => setNewLhOpen(true)}
          style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: '7px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>
          <Plus size={13} /> Add Letterhead…
        </button>
      </>) : (
        <div style={{ padding: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 700 }}>New Letterhead</span>
            <button onClick={() => setNewLhOpen(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex' }}><X size={14} /></button>
          </div>
          <input value={newLhName} onChange={e => setNewLhName(e.target.value)} placeholder="Name (e.g. IT Department)"
            style={{ width: '100%', fontSize: 13, padding: '7px 9px', border: '1px solid var(--line)', borderRadius: 7, marginBottom: 6, fontFamily: 'Inter, sans-serif' }} />
          <input value={newLhAddress} onChange={e => setNewLhAddress(e.target.value)} placeholder="Address (optional)"
            style={{ width: '100%', fontSize: 13, padding: '7px 9px', border: '1px solid var(--line)', borderRadius: 7, marginBottom: 8, fontFamily: 'Inter, sans-serif' }} />
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, cursor: 'pointer', marginBottom: 10 }}>
            {newLhLogoUrl ? <img src={newLhLogoUrl} alt="" style={{ height: 26, maxWidth: 90, objectFit: 'contain' }} />
              : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--muted)' }}>{newLhLogoBusy ? <Spinner size={13} /> : <Upload size={13} />} Upload logo (optional)</span>}
            <input type="file" accept="image/*" style={{ display: 'none' }}
              onChange={e => { const f = e.target.files?.[0]; if (f) uploadLhLogo(f); e.target.value = ''; }} />
          </label>
          <button disabled={newLhBusy || newLhLogoBusy} onClick={createLetterhead}
            style={{ width: '100%', background: 'var(--ink)', color: '#fff', border: 'none', borderRadius: 7, padding: '8px 0', fontSize: 13, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
            {newLhBusy ? <Spinner size={13} /> : <Check size={13} />} Add & Use
          </button>
        </div>
      )}
    </div>
  );
  const mergeDataPanel = () => (
    <div className="nx-docb-mergepanel" style={{ width: 300, padding: 6, display: 'flex', flexDirection: 'column', gap: 10 }}>
      {kind === 'document' && (
        <>
          <div>
            <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 4 }}>Employee (merge subject)</label>
            <PersonSelect value={employeeRows.find(r => r.id === employeeId)?.email || null}
              onChange={v => { const id = employeeRows.find(r => r.email === v)?.id || ''; if (id !== employeeId) changeEmployee(id); }}
              people={employeeRows} placeholder="None" noneLabel="None" ariaLabel="Employee (merge subject)"
              style={{ height: 36, padding: '0 13px', borderRadius: 10, fontSize: 13, fontWeight: 400 }} />
          </div>
          <div>
            <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 4 }}>Entity (company)</label>
            <select className="form-input" style={{ width: '100%', fontSize: 13 }} value={entityId} onChange={e => changeEntity(e.target.value)}>
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
                placeholder="auto" style={{ flex: 1, fontSize: 12, padding: '4px 7px' }}
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
                <span style={{ fontSize: 11, color: 'var(--muted)', width: 100, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={key}>{varLabel[key] || humanizeKey(key)}</span>
                <input key={`${key}-${mergeOverrides[key]}`} className="form-input" defaultValue={mergeOverrides[key] || ''}
                  placeholder={varLabel[key] ? 'asked for on create' : ''}
                  style={{ flex: 1, fontSize: 12, padding: '4px 7px' }}
                  onBlur={e => setOverrideValue(key, e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && e.target.blur()} />
                {/* A variable the template DEFINES is removed by deleting its
                    field, not by clearing a default here - so the X only
                    appears for a plain typed-in default. */}
                {mergeOverrides[key] !== undefined && (
                  <button onClick={() => removeOverride(key)} title="Clear this default value"
                    style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', display: 'flex', padding: 2 }}>
                    <X size={13} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', gap: 5 }}>
          <input className="form-input" placeholder="variable_name" value={newVarName}
            onChange={e => setNewVarName(e.target.value)} style={{ flex: 1, fontSize: 12, padding: '4px 7px' }} />
          <input className="form-input" placeholder="Value" value={newVarValue}
            onChange={e => setNewVarValue(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addCustomVariable()}
            style={{ flex: 1, fontSize: 12, padding: '4px 7px' }} />
          <button onClick={addCustomVariable} disabled={!newVarName.trim() || !newVarValue.trim()}
            style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 6, padding: '4px 8px', cursor: 'pointer', fontSize: 11, fontWeight: 600, opacity: (!newVarName.trim() || !newVarValue.trim()) ? 0.5 : 1 }}>
            Add
          </button>
        </div>
      </div>
    </div>
  );
  // Insert A Variable: the searchable pick list on Insert > Nexus and on Variables.
  const insertVariablePick = () => (
    <PickList ariaLabel="Insert a variable" label="Insert A Variable" placeholder="Insert A Variable" width={280} buttonWidth={170} value=""
      groups={[
        ...builtinGroups.map(([label, items]) => [label, items.map(([t, l]) => [t, l])]),
        ...(customVarKeys.length ? [['Custom Fields In This Template', customVarKeys.map(k => [k, varLabel[k] || humanizeKey(k)])]] : []),
      ]}
      onPick={(token) => insertVariable(token)} />
  );
  const importPanel = () => (
    <>
      <div style={{ fontSize: 15, fontWeight: 700 }}>Import a File</div>
      <div style={{ fontSize: 11, color: 'var(--muted)' }}>
        A Word file (.docx) keeps its formatting; a PDF brings in its text only. The file replaces what is on the pages now.
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button onClick={() => importInputRef.current?.click()} disabled={importing}
          style={{ background: 'none', border: '1px dashed var(--line)', borderRadius: 8, padding: '10px 12px', flex: 1, cursor: 'pointer', fontSize: 12, fontWeight: 600, color: 'var(--ink)', display: 'inline-flex', alignItems: 'center', gap: 6, justifyContent: 'center' }}>
          <Upload size={13} /> Choose File…
        </button>
        <button onClick={() => setEgnyteOpen(true)} disabled={importing}
          style={{ background: 'none', border: '1px dashed var(--line)', borderRadius: 8, padding: '10px 12px', flex: 1, cursor: 'pointer', fontSize: 12, fontWeight: 600, color: 'var(--ink)', display: 'inline-flex', alignItems: 'center', gap: 6, justifyContent: 'center' }}>
          <Cloud size={13} /> Egnyte…
        </button>
      </div>
      <input ref={importInputRef} type="file" accept=".docx,.doc,.pdf,.txt" onChange={onPickImportFile} style={{ display: 'none' }} />
      {egnyteOpen && <EgnyteBrowser onPick={onPickEgnyteFile} onClose={() => setEgnyteOpen(false)} />}
    </>
  );

  // View > Navigation > Pages: the thumbnails the old Pages rail drew.
  const pageThumbs = () => {
    const canvas = pageCanvasStyle(pageSetup);
    const thumbW = 92, thumbH = Math.round(thumbW * (canvas.minHeight / canvas.maxWidth));
    const scale = thumbW / canvas.maxWidth;
    return (
      <div className="nx-docb-thumbs">
        {/* One thumbnail per SHEET as the browser lays the pages out. The
            exported PDF is rendered by a different engine, so a long
            document can differ by a page - the note says so. */}
        <p className="nx-docb-thumbs-note">Where the pages fall in this browser. The PDF can differ by a page on a long document.</p>
        {(() => { let sheetNo = 0; return pages.map((p, i) => {
          const ed = editorsRef.current.get(p.id);
          const json = ed ? ed.getJSON() : (p.json || { type: 'doc', content: [{ type: 'paragraph' }] });
          const html = generateHTML(json, BODY_EXTENSIONS);
          // The sheet's own geometry, reproduced so the slices line up with
          // what the editor is actually showing: the thumbnail used to
          // render the body at the FULL page width with no margins, so its
          // line breaks - and therefore its height - never matched the page.
          const { padV, padH } = sheetPadding(canvas);
          const sheet = textFlowPx(pageSetup);
          const spans = Math.max(1, pageSpans[p.id] || 1);
          return Array.from({ length: spans }, (_, slice) => {
            sheetNo += 1;
            const label = sheetNo;
            // Only the first slice carries the page menu and the selected
            // outline: duplicate/delete act on the EDITOR page, and a slice
            // is not one.
            const isFirst = slice === 0;
            return (
          <div key={`${p.id}:${slice}`} style={{ position: 'relative' }}>
            <div onClick={() => goToSheet(p.id, slice)}
              onContextMenu={isFirst ? (e) => { e.preventDefault(); e.stopPropagation(); setPageMenuOpen(p.id); } : undefined}
              style={{ width: thumbW, height: thumbH, border: (isFirst && p.id === activePageId) ? '2px solid hsl(var(--color-blue))' : '1px solid var(--line)', borderRadius: 6, overflow: 'hidden', background: '#fff', boxShadow: 'var(--shadow-sm)', cursor: 'pointer' }}>
              <div style={{ width: canvas.maxWidth, boxSizing: 'border-box', padding: `${padV}px ${padH}px`,
                  transform: `scale(${scale}) translateY(${-slice * sheet}px)`, transformOrigin: 'top left', pointerEvents: 'none' }}
                dangerouslySetInnerHTML={{ __html: html }} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 3, gap: 2 }}>
              <span onClick={() => goToSheet(p.id, slice)} style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600, cursor: 'pointer' }}>Page {label}</span>
              {isFirst && (
              <button ref={pageMenuOpen === p.id ? pageMenuBtn : undefined} onClick={() => setPageMenuOpen(pageMenuOpen === p.id ? '' : p.id)} title="Page options"
                style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', padding: 1, color: 'var(--muted)', flex: '0 0 auto' }}>
                <MoreVertical size={13} />
              </button>
              )}
            </div>
            {/* Portaled: the thumbnail rail scrolls, which clipped the
                old in-place menu. Closes on an outside tap or Escape. */}
            {isFirst && pageMenuOpen === p.id && (
              <AnchoredMenu anchorRef={pageMenuBtn} open onClose={() => setPageMenuOpen('')} align="end" minWidth={190}
                style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 9, boxShadow: 'var(--shadow-lg)', padding: 5 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', padding: '4px 8px', textTransform: 'uppercase', letterSpacing: '0.03em' }}>Duplicate page</div>
                <button onClick={() => duplicatePage(i, true)}
                  style={{ display: 'flex', alignItems: 'center', gap: 7, width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: '7px 8px', borderRadius: 6, cursor: 'pointer', fontSize: 13, color: 'var(--ink)' }}>
                  <Copy size={13} /> With all contents
                </button>
                <button onClick={() => duplicatePage(i, false)} title="Keeps headings/tables/lists, clears the actual text and images"
                  style={{ display: 'flex', alignItems: 'center', gap: 7, width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: '7px 8px', borderRadius: 6, cursor: 'pointer', fontSize: 13, color: 'var(--ink)' }}>
                  <PageIcon size={13} /> With format only (layout, no text)
                </button>
                {pages.length > 1 && (<>
                  <div style={{ borderTop: '1px solid var(--line)', margin: '4px 0' }} />
                  <button onClick={() => deletePage(i)}
                    style={{ display: 'flex', alignItems: 'center', gap: 7, width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: '7px 8px', borderRadius: 6, cursor: 'pointer', fontSize: 13, color: 'hsl(var(--color-red))' }}>
                    <Trash2 size={13} /> Delete page
                  </button>
                </>)}
              </AnchoredMenu>
            )}
          </div>
            );
          });
        }); })()}
        <button onClick={() => addPage()}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, width: thumbW, height: 40, border: '1px dashed var(--line)', borderRadius: 6, background: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600, color: 'var(--muted)' }}>
          <Plus size={14} /> Add page
        </button>
      </div>
    );
  };

  return (
    <div className={`nx-docb${painterActive ? ' doc-painting' : ''}${preview ? ' is-preview' : ''}${fieldShading ? '' : ' doc-fields-plain'}${previewResults ? ' doc-previewing' : ''}`} ref={rootRef} style={previewPull ? { marginTop: -previewPull } : undefined}>
      {/* The header, Word / Google Docs style (Neil, 11/10/2026): Close, the
          file's mark, its name (typed in place; "Untitled Document" until it
          has one), the save state, then the actions. */}
      <div className="nx-docb-head" style={{ marginBottom: preview ? 6 : 8 }}>
        <button onClick={close} title="Close" aria-label="Close" className="nx-docb-hbtn is-icon">
          <X size={16} />
        </button>
        <span className={`nx-docb-mark is-${kind}`} aria-hidden="true">{kind === 'template' ? <FileStack size={16} /> : <PageIcon size={16} />}</span>
        <div className="nx-docb-titlecol">
        <div className="nx-docb-titlerow">
        <input ref={titleRef} className="nx-inline-edit nx-docb-title" value={title} onChange={e => setTitle(e.target.value)} onBlur={saveTitle}
          onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') { setTitle(isUntitled(doc?.[nameKey]) ? '' : doc?.[nameKey] || ''); e.target.blur(); } }}
          placeholder={kind === 'document' ? UNTITLED_DOCUMENT : UNTITLED_TEMPLATE} aria-label={kind === 'document' ? 'Document name' : 'Template name'}
          readOnly={readOnly || isLocked} />
        <span className="nx-docb-save" style={{ color: saveStatus === 'error' ? 'hsl(var(--color-red))' : undefined }}>
          {saveStatus === 'saving' && <Spinner size={12} />}
          {saveStatus === 'saved' && <Check size={12} />}
          {saveStatus === 'error' && <AlertCircle size={12} />}
          {SAVE_LABEL[saveStatus]}
        </span>
        {/* Word's Quick Access: Undo and Redo beside the name (11/11/2026). */}
        {!preview && activeEditor && (
          <span className="nx-docb-qat" role="group" aria-label="Quick Access">
            <button type="button" className="nx-docb-qbtn" title="Undo (Ctrl+Z)" aria-label="Undo" disabled={!editing || !activeEditor.can().undo()}
              onMouseDown={(e) => e.preventDefault()} onClick={() => activeEditor.chain().focus().undo().run()}><Undo size={15} /></button>
            <button type="button" className="nx-docb-qbtn" title="Redo (Ctrl+Y)" aria-label="Redo" disabled={!editing || !activeEditor.can().redo()}
              onMouseDown={(e) => e.preventDefault()} onClick={() => activeEditor.chain().focus().redo().run()}><Redo size={15} /></button>
          </span>
        )}
        </div>
        {!preview && activeEditor && <MenuBar menus={docMenus} />}
        </div>
        {live && <LivePeople peers={live.peers} status={live.status} />}
        {!preview && !isMobile && (
          <button type="button" className={`nx-docb-hbtn nx-docb-compact${commentsOpen ? ' is-on' : ''}`} title="Comments" aria-pressed={commentsOpen}
            onClick={() => setCommentsOpen((o) => !o)}>
            <MessageSquare size={14} /> Comments
          </button>
        )}
        {kind === 'document' && doc?.access && (
          <button type="button" className="nx-docb-hbtn nx-docb-compact" title="Share" onClick={() => setShareOpen(true)}>
            <Users size={14} /> Share
          </button>
        )}
        {shareOpen && (
          <ShareDocumentDialog doc={doc} canManage={doc.access === 'owner'} onClose={() => setShareOpen(false)}
            onChanged={(out) => { if (out) setDoc((d) => ({ ...d, sharedWith: out.sharedWith || [] })); toastOk?.('Sharing updated'); }} />
        )}
        {/* One Publish (Neil, 10/31/2026): Active and Published merged - new documents and HR packets read what is published. */}
        {kind === 'template' && doc.status !== 'archived' && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
            title="New documents and HR packets use the published wording. Editing saves as you type; Publish releases it.">
            {doc.status === 'draft' ? <span style={chipTone('orange')}>Draft - Not Usable Yet</span>
              : doc.hasUnpublishedChanges ? <span style={chipTone('orange')}>Unpublished Changes</span>
              : <span style={chipTone('green')}>Published{doc.publishedVersion ? ` v${doc.publishedVersion}` : ''}</span>}
            {(doc.status === 'draft' || doc.hasUnpublishedChanges) && !preview && (
              <button onClick={publishTemplate} disabled={publishing} className="primary-btn"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, opacity: publishing ? 0.6 : 1 }}>
                {publishing ? <Spinner size={14} /> : <BadgeCheck size={14} />}
                {doc.hasUnpublishedChanges ? 'Publish Changes' : 'Publish'}
              </button>
            )}
          </span>
        )}
        {kind === 'template' && doc.status === 'archived' && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
            title="An archived template makes nothing until it is restored.">
            <span style={{ ...chipTone('blue'), color: 'var(--muted)', background: 'var(--mist)' }}>Archived</span>
            {!preview && (
              <button onClick={activateTemplate} disabled={activating} className="primary-btn"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, opacity: activating ? 0.6 : 1 }}>
                {activating ? <Spinner size={14} /> : <BadgeCheck size={14} />}
                Restore
              </button>
            )}
          </span>
        )}
        {kind === 'document' && !preview && (
          <button onClick={() => { setPreview(true); openPdfPreview(); }} disabled={pdfPreviewLoading}
            className="primary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, opacity: pdfPreviewLoading ? 0.6 : 1 }}>
            {pdfPreviewLoading ? <Spinner size={14} /> : <Send size={14} />} Preview & Send
          </button>
        )}
        {kind === 'document' && preview && (
          <>
            <button onClick={() => window.print()} title="Print"
              className="nx-docb-hbtn">
              <Printer size={14} /> Print
            </button>
            <button onClick={saveAsTemplate} disabled={savingTemplate} title="Save as Template"
              className="nx-docb-hbtn" style={{ opacity: savingTemplate ? 0.6 : 1 }}>
              {savingTemplate ? <Spinner size={14} /> : <FileStack size={14} />} Save as Template
            </button>
            <button onClick={() => doExport('pdf')} disabled={!!exporting} title="Export PDF"
              className="nx-docb-hbtn" style={{ opacity: exporting ? 0.6 : 1 }}>
              <FileDown size={14} /> {exporting === 'pdf' ? 'Exporting…' : 'Export PDF'}
            </button>
            <button onClick={() => doExport('docx')} disabled={!!exporting} title="Export DOCX"
              className="nx-docb-hbtn" style={{ opacity: exporting ? 0.6 : 1 }}>
              <FileDown size={14} /> {exporting === 'docx' ? 'Exporting…' : 'Export DOCX'}
            </button>
            <button onClick={openInWord} disabled={!!exporting} title="Open in Word on this computer to keep editing"
              className="nx-docb-hbtn" style={{ opacity: exporting ? 0.6 : 1 }}>
              <PageIcon size={14} /> {exporting === 'word' ? 'Opening…' : 'Open in Word'}
            </button>
            <button onClick={doSendForSignature} disabled={!!exporting} title="Send for Signature"
              className="primary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, opacity: exporting ? 0.6 : 1 }}>
              <Send size={14} /> {exporting === 'send' ? 'Preparing…' : 'Send for Signature'}
            </button>
            <button onClick={() => { setPreview(false); closePdfPreview(); }} title="Back to Edit"
              className="nx-docb-hbtn">
              <EyeOff size={14} /> Back to Edit
            </button>
          </>
        )}
        {kind !== 'document' && (
          <button onClick={() => setPreview(p => !p)}
            className="nx-docb-hbtn">
            {preview ? <EyeOff size={14} /> : <Eye size={14} />} {preview ? 'Edit' : 'Preview'}
          </button>
        )}
        <button onClick={openHistory} title="Version History" aria-label="Version History" className="nx-docb-hbtn is-icon">
          <History size={16} />
        </button>
        <FullScreenButton on={full} onToggle={toggleFull} className="nx-docb-hbtn nx-docb-compact" />
      </div>

      {kind === 'document' && preview ? (
        // Real rendered preview (Phase 17) - shows the document exactly as it
        // will download: same backend PDF pipeline as Export PDF, so real
        // pagination and a real page break, not the editor's own WYSIWYG
        // canvas with editing merely disabled (which never looked like a
        // finished document and rendered page breaks as a cosmetic divider).
        // Inline in the page (not a modal) per the same reasoning as the
        // rest of this module's "replace the tab content" convention.
        <div ref={previewBoxRef}
          style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 340, ...(previewFill || {}) }}>
          {pdfPreviewLoading ? (
            <div style={{ padding: 60, textAlign: 'center', color: 'var(--muted)' }}><Spinner size="section" /></div>
          ) : pdfPreviewUrl ? (
            <iframe title="Document Preview" src={pdfPreviewUrl} style={{ flex: 1, border: '1px solid var(--line)', borderRadius: 8, width: '100%', minHeight: 0 }} />
          ) : null}
        </div>
      ) : (
      <>
      {!preview && activeEditor && (
        <div className="doc-ribbon-sticky">
          <div className="doc-ribbon-tabs" role="tablist">
            {/* Word's tabs (11/11/2026). File and Help are the menu bar's: its
                File and Help menus hold every command those two tabs had. */}
            {RIBBON_TABS.map(([key, label]) => (
              <button key={key} type="button" role="tab" data-tab={key} aria-selected={shownTab === key} onClick={() => { if (ribbonCollapsed && shownTab === key) setRibbonCollapsed(false); else setRibbonTab(key); }}
                className={`doc-ribbon-tab${shownTab === key ? ' is-active' : ''}`}>
                {label}
              </button>
            ))}
            {inTable && [['tableDesign', 'Table Design'], ['tableLayout', 'Table Layout']].map(([key, label]) => (
              <button key={key} type="button" role="tab" data-tab={key} aria-selected={shownTab === key} onClick={() => { setRibbonCollapsed(false); setRibbonTab(key); }}
                className={`doc-ribbon-tab is-context${shownTab === key ? ' is-active' : ''}`}>{label}</button>
            ))}
            {imgAttrs && (
              <button type="button" role="tab" data-tab="picture" aria-selected={shownTab === 'picture'} onClick={() => setRibbonTab('picture')}
                className={`doc-ribbon-tab is-context${shownTab === 'picture' ? ' is-active' : ''}`}>Picture Format</button>
            )}
            {shapeType && (
              <button type="button" role="tab" data-tab="shape" aria-selected={shownTab === 'shape'} onClick={() => { setRibbonCollapsed(false); setRibbonTab('shape'); }}
                className={`doc-ribbon-tab is-context${shownTab === 'shape' ? ' is-active' : ''}`}>Shape Format</button>
            )}
            <RibbonDisplay mode={ribbonMode} onMode={setRibbonMode} onToggle={toggleRibbon} />
          </div>
        {isLocked && (
          /* Requirement 7 made visible. The server refuses the write either
             way; this says WHY the page will not take a keystroke, and offers
             the one deliberate way out. */
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
            padding: '9px 14px', marginBottom: 10, borderRadius: 9,
            background: 'rgba(251,191,36,0.14)', border: '1px solid rgba(217,119,6,0.35)',
          }}>
            <Lock size={14} style={{ color: '#b45309', flexShrink: 0 }} />
            <span style={{ fontSize: 13, color: '#92400e', flex: 1, minWidth: 180 }}>
              This document is final. It carries the approved template language with the values it was
              generated from, so it is read-only.
            </span>
            <button className="secondary-btn" disabled={unlocking}
              onClick={async () => {
                if (!(await dialog.confirm('Unlock this document for editing? The change is recorded in its history.', { confirmText: 'Unlock' }))) return;
                setUnlocking(true);
                try {
                  const updated = await api.unlockDocument(docId);
                  setDoc(updated);
                  toastOk?.('Unlocked - this document is now a draft.');
                } catch (e) { toastErr?.(e.message || 'Could not unlock this document'); }
                finally { setUnlocking(false); }
              }}
              style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {unlocking ? <Spinner size={13} /> : <LockOpen size={13} />} Unlock to Edit
            </button>
          </div>
        )}
        {/* One row, never wrapped (Neil, 11/10/2026): groups that do not fit
            go into More at the end (docRibbon/ui.jsx RibbonBar). */}
        {!ribbonCollapsed && <RibbonBar tabKey={shownTab} className={ribbonMode === 'simplified' ? 'is-simplified' : ''} role="toolbar" aria-label={`${shownTab} ribbon`} render={() => (<>
          {shownTab === 'home' && (
          <>
          <Group label="Clipboard">
            <Menu big icon={ClipboardPaste} label="Paste" items={[{ label: 'Paste', onClick: () => clipboardAction('paste') }, { label: 'Keep Text Only', onClick: pasteTextOnly }]} />
            <div className="doc-ribbon-stack">
              <SmallBtn icon={Scissors} title="Cut" onClick={() => clipboardAction('cut')} />
              <SmallBtn icon={ClipboardCopy} title="Copy" onClick={() => clipboardAction('copy')} />
            </div>
            <BigBtn icon={Paintbrush} label="Format Painter" title="Format Painter - click, then select or click the text to copy the formatting onto. Double-click to paint several places; Esc stops." active={!!painterActive} onClick={() => toggleFormatPainter(false)} onDoubleClick={() => toggleFormatPainter(true)} />
          </Group>
          <Group label="Font" onLaunch={() => setFontDlg(true)} launchTitle="Font (Ctrl+D)">
            <div className="doc-ribbon-stack">
              <div className="doc-ribbon-row">
                {/* Word's Font box: each name shown in its own face, searchable (Neil, 11/10/2026). */}
                <PickList ariaLabel="Font" placeholder="Font" emptyLabel="Default Font" width={230}
                  value={activeEditor.getAttributes('textStyle').fontFamily || ''}
                  label={activeEditor.getAttributes('textStyle').fontFamily || 'Default Font'}
                  groups={Object.entries(FONT_GROUPS).map(([group, fonts]) => [group, fonts.map(f => [f, f])])}
                  preview={(f) => ({ fontFamily: `"${f}", Inter, sans-serif` })}
                  onPick={(v) => { if (v) activeEditor.chain().focus().setFontFamily(v).run(); else activeEditor.chain().focus().unsetFontFamily().run(); }} />
                {/* Type a size and press Enter, or pick one. Points, as in Word and as the
                    exporter prints them (11/11/2026; it wrote px, which showed a 12 as 9 pt). */}
                <SizeBox sizes={FONT_SIZES} value={(activeEditor.getAttributes('textStyle').fontSize || '').replace(/(px|pt)$/, '')}
                  onPick={(v) => { if (v) activeEditor.chain().focus().setFontSize(`${v}pt`).run(); else activeEditor.chain().focus().unsetFontSize().run(); }} />
                <SmallBtn title="Grow Font" onClick={() => stepFontSize(1)}><span style={{ fontSize: 13, fontWeight: 700 }}>A↑</span></SmallBtn>
                <SmallBtn title="Shrink Font" onClick={() => stepFontSize(-1)}><span style={{ fontSize: 11, fontWeight: 700 }}>A↓</span></SmallBtn>
                <Menu label="Aa" title="Change Case" items={[
                  { label: 'Sentence case', onClick: () => changeCase('sentence') }, { label: 'lowercase', onClick: () => changeCase('lower') },
                  { label: 'UPPERCASE', onClick: () => changeCase('upper') }, { label: 'Capitalize Each Word', onClick: () => changeCase('title') }]} />
                <SmallBtn icon={Eraser} title="Clear All Formatting" onClick={() => activeEditor.chain().focus().unsetAllMarks().clearNodes().run()} />
              </div>
              <div className="doc-ribbon-row">
                <SmallBtn icon={Bold} title="Bold" active={activeEditor.isActive('bold')} onClick={() => activeEditor.chain().focus().toggleBold().run()} />
                <SmallBtn icon={Italic} title="Italic" active={activeEditor.isActive('italic')} onClick={() => activeEditor.chain().focus().toggleItalic().run()} />
                <SmallBtn icon={Underline} title="Underline" active={activeEditor.isActive('underline')} onClick={() => activeEditor.chain().focus().toggleUnderline().run()} />
                <SmallBtn icon={Strikethrough} title="Strikethrough" active={activeEditor.isActive('strike')} onClick={() => activeEditor.chain().focus().toggleStrike().run()} />
                <SmallBtn icon={SubscriptIcon} title="Subscript" active={activeEditor.isActive('subscript')} onClick={() => activeEditor.chain().focus().toggleSubscript().run()} />
                <SmallBtn icon={SuperscriptIcon} title="Superscript" active={activeEditor.isActive('superscript')} onClick={() => activeEditor.chain().focus().toggleSuperscript().run()} />
                <Menu icon={Highlighter} title="Text Highlight Color" active={activeEditor.isActive('highlight')} width={150}>
                  <ColorGrid rows={[0, 5, 10].map(i => HIGHLIGHT_COLORS.slice(i, i + 5))} current={activeEditor.getAttributes('highlight').color}
                    onPick={hex => activeEditor.chain().focus().setHighlight({ color: hex }).run()}
                    onNone={() => activeEditor.chain().focus().unsetHighlight().run()} more={false} />
                </Menu>
                <Menu icon={Baseline} title="Font Color" width={260}>
                  <ColorGrid rows={[THEME_COLORS.map(h => [h]), STANDARD_COLORS.map(h => [h])]} current={activeEditor.getAttributes('textStyle').color}
                    onPick={hex => activeEditor.chain().focus().setColor(hex).run()}
                    onNone={() => activeEditor.chain().focus().unsetColor().run()} noneLabel="Automatic" />
                </Menu>
              </div>
            </div>
          </Group>
          <Group label="Paragraph" onLaunch={() => setParaDlg(true)} launchTitle="Paragraph Settings">
            <div className="doc-ribbon-stack">
              <div className="doc-ribbon-row">
                <Menu icon={List} title="Bullets" active={activeEditor.isActive('bulletList')} items={[
                  { label: '•  Disc', onClick: () => setBullets('disc') }, { label: '○  Circle', onClick: () => setBullets('circle') },
                  { label: '▪  Square', onClick: () => setBullets('square') }, '-',
                  { label: 'None', onClick: () => { if (activeEditor.isActive('bulletList')) activeEditor.chain().focus().toggleBulletList().run(); } }]} />
                <Menu icon={ListOrdered} title="Numbering" active={activeEditor.isActive('orderedList')} items={[
                  { label: '1.  2.  3.', onClick: () => setNumbering(null) }, { label: '1)  2)  3)', onClick: () => setNumbering(null) },
                  { label: 'I.  II.  III.', onClick: () => setNumbering('I') }, { label: 'A.  B.  C.', onClick: () => setNumbering('A') },
                  { label: 'a)  b)  c)', onClick: () => setNumbering('a') }, { label: 'a.  b.  c.', onClick: () => setNumbering('a') },
                  { label: 'i.  ii.  iii.', onClick: () => setNumbering('i') }, '-',
                  { label: 'None', onClick: () => { if (activeEditor.isActive('orderedList')) activeEditor.chain().focus().toggleOrderedList().run(); } }]} />
                <SmallBtn icon={Outdent} title="Decrease Indent" onClick={() => changeIndent(-1)} />
                <SmallBtn icon={Indent} title="Increase Indent" onClick={() => changeIndent(1)} />
                <SmallBtn icon={ArrowDownAZ} title="Sort A to Z (list items)" onClick={() => sortSelection('asc')} />
                <SmallBtn icon={ArrowUpZA} title="Sort Z to A (list items)" onClick={() => sortSelection('desc')} />
                <SmallBtn icon={Pilcrow} title="Show/Hide ¶" active={showMarks} onClick={() => setShowMarks(s => !s)} />
              </div>
              <div className="doc-ribbon-row">
                <SmallBtn icon={AlignLeft} title="Align Left" active={activeEditor.isActive({ textAlign: 'left' })} onClick={() => activeEditor.chain().focus().setTextAlign('left').run()} />
                <SmallBtn icon={AlignCenter} title="Center" active={activeEditor.isActive({ textAlign: 'center' })} onClick={() => activeEditor.chain().focus().setTextAlign('center').run()} />
                <SmallBtn icon={AlignRight} title="Align Right" active={activeEditor.isActive({ textAlign: 'right' })} onClick={() => activeEditor.chain().focus().setTextAlign('right').run()} />
                <SmallBtn icon={AlignJustify} title="Justify" active={activeEditor.isActive({ textAlign: 'justify' })} onClick={() => activeEditor.chain().focus().setTextAlign('justify').run()} />
                <Menu icon={AlignVerticalSpaceAround} title="Line and Paragraph Spacing" items={[
                  // The editor's multiple is Word's x 1.2 (lib/docxToTiptap.js LINE_NORMAL).
                  { label: '1.0', onClick: () => setLineHeight('1.2'), active: activeEditor.getAttributes(currentBlockType()).lineHeight === '1.2' },
                  { label: '1.15', onClick: () => setLineHeight('1.38'), active: activeEditor.getAttributes(currentBlockType()).lineHeight === '1.38' },
                  { label: '1.5', onClick: () => setLineHeight('1.8'), active: activeEditor.getAttributes(currentBlockType()).lineHeight === '1.8' },
                  { label: '2.0', onClick: () => setLineHeight('2.4'), active: activeEditor.getAttributes(currentBlockType()).lineHeight === '2.4' },
                  { label: '2.5', onClick: () => setLineHeight('3'), active: activeEditor.getAttributes(currentBlockType()).lineHeight === '3' },
                  { label: '3.0', onClick: () => setLineHeight('3.6'), active: activeEditor.getAttributes(currentBlockType()).lineHeight === '3.6' }, '-',
                  // Word swaps Add for Remove once the space is there.
                  ...(activeEditor.getAttributes(currentBlockType()).spacingBefore
                    ? [{ label: 'Remove Space Before Paragraph', onClick: () => setParaAttr({ spacingBefore: null }) }]
                    : [{ label: 'Add Space Before Paragraph', onClick: () => setParaAttr({ spacingBefore: 12 }) }]),
                  ...(activeEditor.getAttributes(currentBlockType()).spacingAfter
                    ? [{ label: 'Remove Space After Paragraph', onClick: () => setParaAttr({ spacingAfter: null }) }]
                    : [{ label: 'Add Space After Paragraph', onClick: () => setParaAttr({ spacingAfter: 12 }) }]),
                  { label: 'Line Spacing Options…', title: 'Exact values on the Layout tab', onClick: () => setRibbonTab('layout') }]} />
                <Menu icon={PaintBucket} title="Shading" width={260}>
                  <ColorGrid rows={[THEME_COLORS.map(h => [h]), STANDARD_COLORS.map(h => [h])]} current={activeEditor.getAttributes(currentBlockType()).backgroundColor}
                    onPick={hex => setParagraphShading(hex)} onNone={() => setParagraphShading(null)} />
                </Menu>
                <Menu icon={RectangleHorizontal} title="Borders" active={!!activeEditor.getAttributes(currentBlockType()).border} items={[
                  // shortcut: one border on all four sides; a per-side border needs a per-side attribute, add one when a document asks for it.
                  { label: 'All Borders', onClick: () => setParaAttr({ border: '1px solid #111827' }) },
                  { label: 'Outside Borders', onClick: () => setParaAttr({ border: '1px solid #111827' }) },
                  { label: 'Bottom Border', title: 'Draws the full box for now', onClick: () => setParaAttr({ border: '1px solid #111827' }) },
                  { label: 'Top Border', title: 'Draws the full box for now', onClick: () => setParaAttr({ border: '1px solid #111827' }) }, '-',
                  { label: 'No Border', onClick: () => setParaAttr({ border: null }) }]} />
              </div>
            </div>
          </Group>
          <Group label="Styles"><StyleGallery editor={activeEditor} compact={ribbonMode === 'simplified'} /></Group>
          <Group label="Editing">
            <BigBtn icon={Search} label="Find" title="Find & Replace" active={findOpen} onClick={() => setFindOpen(o => !o)} />
            <BigBtn icon={Replace} label="Replace" title="Replace (Ctrl+H)" onClick={() => { setFindOpen(true); requestAnimationFrame(() => document.querySelector('.nx-docb input[placeholder="Replace with"]')?.focus()); }} />
            <BigBtn icon={MousePointerSquareDashed} label="Select All" onClick={() => activeEditor.chain().focus().selectAll().run()} />
          </Group>
          {canDictate() && (
            <Group label="Voice">
              <BigBtn icon={Mic} label={dictation.listening ? 'Stop' : 'Dictate'} title={dictation.error || 'Dictate - type what you say'} active={dictation.listening}
                onClick={() => (dictation.listening ? dictation.stop() : dictation.start())} />
            </Group>
          )}
          </>
          )}

          {shownTab === 'insert' && (
          <>
          <Group label="Pages">
            <BigBtn icon={SeparatorHorizontal} label="Page Break" title="Start the next line on a new page" onClick={() => activeEditor.chain().focus().insertContent([{ type: 'pageBreak' }, { type: 'paragraph' }]).run()} />
            {kind === 'document' && <BigBtn icon={FilePlus} label="Blank Page" title="Add a blank page after this one" onClick={blankPage} />}
            {kind === 'document' && (
              <Menu big icon={Copy} label="Duplicate Page" title="Duplicate this page" items={[
                { label: 'With All Contents', onClick: () => duplicatePage(activeIdx(), true) },
                { label: 'With Format Only (Layout, No Text)', onClick: () => duplicatePage(activeIdx(), false) },
              ]} />
            )}
          </Group>
          <Group label="Tables">
            <Menu big icon={TableIcon} label="Table" width={220}>
              {(closeMenu) => (
                <>
                  <TableGrid onPick={(r, c) => { activeEditor.chain().focus().insertTable({ rows: r, cols: c, withHeaderRow: false }).run(); closeMenu(); }} />
                  <div className="doc-ribbon-sep" />
                  <form className="doc-ribbon-field" style={{ padding: '4px 6px', gap: 6 }}
                    onSubmit={(e) => { e.preventDefault(); const f = e.currentTarget; const r = Math.max(1, Math.min(50, Number(f.rows.value) || 2)); const c = Math.max(1, Math.min(20, Number(f.cols.value) || 2)); activeEditor.chain().focus().insertTable({ rows: r, cols: c, withHeaderRow: false }).run(); closeMenu(); }}>
                    <input name="cols" type="number" min={1} max={20} defaultValue={3} aria-label="Columns" /> x
                    <input name="rows" type="number" min={1} max={50} defaultValue={3} aria-label="Rows" />
                    <button type="submit" className="primary-btn" style={{ fontSize: 12, padding: '4px 9px' }}>Insert Table</button>
                  </form>
                </>
              )}
            </Menu>
          </Group>
          <Group label="Illustrations">
            <Menu big icon={ImagePlus} label="Picture" items={[
              { label: 'This Device…', onClick: () => fileInputRef.current?.click() },
              { label: 'Paste From Clipboard', title: 'Copy a picture, click the page, then press Ctrl+V', onClick: () => toastOk?.('Click where the picture goes and press Ctrl+V with it on the clipboard.') }]} />
          <div style={{ position: 'relative' }}>
            <BigBtn icon={Shapes} label="Drawing" title="Shapes" active={shapePopoverOpen} onClick={() => setShapePopoverOpen(o => !o)} />
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
          {/* One click, like Word: the box lands inline; Wrap and colors are on the Text box bar it then shows. */}
          <BigBtn icon={Type} label="Text Box" title="Text Box" onClick={insertTextbox} />
          </Group>
          {/* Everything that is Nexus's own, not Word's, in one place: the
              signature block, merge-field variables and their tools. */}
          <Group label="Nexus">
          <div style={{ position: 'relative' }}>
            <BigBtn icon={PenLine} label="Signature" title="Signature Block - where a signer signs" active={sigPopoverOpen}
              onClick={() => { setSigPopoverOpen(o => !o); setSigDraft(d => ({ ...d, role: d.role || signerOptions[0]?.key || '' })); }} />
            {sigPopoverOpen && (
              <div style={{ position: 'absolute', top: '110%', left: 0, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, boxShadow: 'var(--shadow-lg)', zIndex: 20, padding: 12, display: 'flex', flexDirection: 'column', gap: 9, width: 270 }}>
                <div style={{ fontSize: 13, fontWeight: 700 }}>Insert Signature Block</div>
                <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.45 }}>
                  The signer's signature, name and date fields land here automatically when this is sent for signature.
                </div>
                <label style={{ fontSize: 11, color: 'var(--muted)', display: 'flex', flexDirection: 'column', gap: 3 }}>
                  Who Signs Here
                  <select value={sigDraft.role} onChange={e => setSigDraft(d => ({ ...d, role: e.target.value }))}
                    style={{ fontSize: 12, fontFamily: 'Inter, sans-serif', border: '1px solid var(--line)', borderRadius: 7, padding: '5px 6px', color: 'var(--ink)', background: 'var(--card)' }}>
                    {signerOptions.map(r => <option key={r.key} value={r.key}>{r.label || r.key}</option>)}
                  </select>
                </label>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input className="form-input" style={{ fontSize: 12, flex: 1 }} placeholder="New signer, e.g. Manager"
                    value={sigDraft.newSigner} onChange={e => setSigDraft(d => ({ ...d, newSigner: e.target.value }))}
                    onKeyDown={e => e.key === 'Enter' && addSigner()} />
                  <button onClick={addSigner} disabled={!signerKeyOf(sigDraft.newSigner)} className="secondary-btn"
                    style={{ fontSize: 12, padding: '5px 10px' }}>Add Signer</button>
                </div>
                <label style={{ fontSize: 11, color: 'var(--muted)', display: 'flex', flexDirection: 'column', gap: 3 }}>
                  Caption (optional)
                  <input className="form-input" style={{ fontSize: 12 }} placeholder="e.g. For {{company_legal}}"
                    value={sigDraft.label} onChange={e => setSigDraft(d => ({ ...d, label: e.target.value }))} />
                </label>
                <div style={{ display: 'flex', gap: 14, fontSize: 12 }}>
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
                    <input type="checkbox" checked={sigDraft.withName} onChange={e => setSigDraft(d => ({ ...d, withName: e.target.checked }))} /> Name Line
                  </label>
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
                    <input type="checkbox" checked={sigDraft.withDate} onChange={e => setSigDraft(d => ({ ...d, withDate: e.target.checked }))} /> Date Line
                  </label>
                </div>
                <button onClick={insertSignatureBlock} className="primary-btn" style={{ fontSize: 12, padding: '7px 10px' }}>Insert Signature Block</button>
                {kind === 'template' && signerRoles.length > 0 && (
                  <div style={{ borderTop: '1px solid var(--line)', paddingTop: 8 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', marginBottom: 4 }}>Signers On This Template</div>
                    {signerRoles.map((r, i) => (
                      <div key={r.key} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '3px 0' }}>
                        <span style={{ width: 18, color: 'var(--muted)', fontWeight: 700 }}>{i + 1}</span>
                        <span style={{ flex: 1 }}>{r.label || r.key}</span>
                        <button title="Remove this signer" onClick={() => removeSigner(r.key)}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 2 }}><X size={12} /></button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
          <BigBtn icon={Variable} label="Variables" title="Variables - the ones in this document, and the library" active={varsOpen} onClick={() => (varsOpen ? setVarsOpen(false) : openVars('used'))} />
          {insertVariablePick()}
          </Group>
          <Group label="Links">
          <div style={{ position: 'relative' }}>
            <BigBtn icon={Link2} label="Link" active={activeEditor.isActive('link')} onClick={toggleLinkPopover} />
            {linkPopoverOpen && (
              <div style={{ position: 'absolute', top: '110%', left: 0, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, boxShadow: 'var(--shadow-lg)', zIndex: 20, padding: 8, display: 'flex', gap: 6, alignItems: 'center' }}>
                <input className="form-input" style={{ fontSize: 12, width: 180 }} placeholder="https://…" value={linkUrlDraft}
                  onChange={e => setLinkUrlDraft(e.target.value)} onKeyDown={e => e.key === 'Enter' && applyLink()} autoFocus />
                <button onClick={applyLink} className="primary-btn" style={{ fontSize: 12, padding: '5px 10px' }}>Apply</button>
                {activeEditor.isActive('link') && (
                  <button onClick={removeLink} title="Remove Link" style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 6, padding: 5, cursor: 'pointer', display: 'flex' }}><Link2Off size={13} /></button>
                )}
              </div>
            )}
          </div>
          <div style={{ position: 'relative' }}>
            <BigBtn icon={Bookmark} label="Bookmarks" active={bookmarkPopoverOpen} onClick={() => setBookmarkPopoverOpen(o => !o)} />
            {bookmarkPopoverOpen && (
              <div style={{ position: 'absolute', top: '110%', left: 0, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, boxShadow: 'var(--shadow-lg)', zIndex: 20, padding: 10, display: 'flex', flexDirection: 'column', gap: 8, minWidth: 200 }}>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input className="form-input" style={{ fontSize: 12, flex: 1 }} placeholder="Bookmark name" value={newBookmarkName}
                    onChange={e => setNewBookmarkName(e.target.value)} onKeyDown={e => e.key === 'Enter' && insertBookmark()} autoFocus />
                  <button onClick={insertBookmark} className="primary-btn" style={{ fontSize: 12, padding: '5px 10px' }}>Add</button>
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
          <Menu big icon={ListTree} label="Table of Contents" items={[
            { label: 'Insert Table of Contents', onClick: insertTableOfContents },
            { label: 'Update Table of Contents', onClick: insertTableOfContents, disabled: !findTocRange() },
            { label: 'Remove Table of Contents', onClick: removeTableOfContents, disabled: !findTocRange() }]} />
          </Group>
          <Group label="Comments">
            <BigBtn icon={MessageSquare} label="New Comment" title="Comment on the selected text" onClick={startComment}
              disabled={!activeEditor || activeEditor.state.selection.empty} />
          </Group>
          <Group label="Header & Footer">
            <BigBtn icon={LayoutPanelTop} label="Header & Footer" active={headerVisible || footerVisible} onClick={toggleHeaderFooter} />
            <Menu big icon={Hash} label="Page Numbers" items={[
              ...[['bottom-left', 'Bottom Left'], ['bottom-center', 'Bottom Center'], ['bottom-right', 'Bottom Right'], ['top-right', 'Top Right']].map(([v, l]) => ({ label: l, onClick: () => updatePageSetup({ pageNumbers: v }), active: (pageSetup.pageNumbers || 'bottom-right') === v })),
              '-', { label: 'Remove Page Numbers', onClick: () => updatePageSetup({ pageNumbers: 'none' }), active: pageSetup.pageNumbers === 'none' }]} />
          </Group>
          <Group label="Symbols">
          <div style={{ position: 'relative' }}>
            <BigBtn icon={Smile} label="Symbol" title="Symbol / Emoji" active={symbolPopoverOpen} onClick={() => setSymbolPopoverOpen(o => !o)} />
            {symbolPopoverOpen && (
              <div style={{ position: 'absolute', top: '110%', background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, boxShadow: 'var(--shadow-lg)', zIndex: 20, padding: 10, width: 336, right: 0 }}>
                <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
                  {[['symbols', 'Symbols'], ['emoji', 'Emoji']].map(([key, label]) => (
                    <button key={key} type="button" onClick={() => setSymbolTab(key)} aria-selected={symbolTab === key} role="tab"
                      style={{ width: 'auto', height: 'auto', fontSize: 12, fontWeight: 600, padding: '4px 10px', border: 'none', borderRadius: 0, borderBottom: symbolTab === key ? '2px solid var(--ink)' : '2px solid transparent', background: 'none', cursor: 'pointer', color: symbolTab === key ? 'var(--ink)' : 'var(--muted)' }}>{label}</button>
                  ))}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(10, 1fr)', gap: 2, maxHeight: 220, overflowY: 'auto' }}>
                  {(symbolTab === 'symbols' ? SYMBOL_CHARS : EMOJI_CHARS).map((ch, i) => (
                    <button key={i} onClick={() => { insertSymbol(ch); setSymbolPopoverOpen(false); }} title={ch}
                      style={{ width: '100%', height: 30, fontSize: 15, background: 'none', border: 'none', cursor: 'pointer', padding: 4, borderRadius: 5, lineHeight: 1 }}>
                      {ch}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          </Group>
          </>
          )}

          {shownTab === 'design' && (
          <>
          <Group label="Letterhead">
            <Menu big icon={Award} label={activeLetterhead ? activeLetterhead.name : 'Letterhead'} title={`Letterhead: ${activeLetterhead ? activeLetterhead.name : 'None'}`}
              width={newLhOpen ? 276 : 236} onOpenChange={(o) => { if (!o) setNewLhOpen(false); }}>
              {() => letterheadPanel()}
            </Menu>
            {kind === 'template' && (
              <BigBtn icon={BadgeCheck} label="Requires Letterhead" title="Documents made from this template always carry a letterhead"
                active={requiresLetterhead} onClick={toggleRequiresLetterhead} />
            )}
          </Group>
          <Group label="Page Background">
            <Menu big icon={PaintBucket} label="Page Color" width={260}>
              <ColorGrid rows={[THEME_COLORS.map(h => [h]), STANDARD_COLORS.map(h => [h])]} current={pageSetup.pageColor}
                onPick={hex => updatePageSetup({ pageColor: hex })} onNone={() => updatePageSetup({ pageColor: null })} />
            </Menu>
            <Menu big icon={Stamp} label="Watermark" width={220}>
              {(closeMenu) => (
                <>
                  {['DRAFT', 'CONFIDENTIAL', 'SAMPLE', 'DO NOT COPY'].map(w => (
                    <button key={w} type="button" className={`doc-ribbon-item${pageSetup.watermark === w ? ' is-active' : ''}`} onClick={() => { updatePageSetup({ watermark: w }); closeMenu(); }}>{w}</button>
                  ))}
                  <form className="doc-ribbon-field" style={{ padding: '4px 6px', gap: 6 }} onSubmit={(e) => { e.preventDefault(); updatePageSetup({ watermark: e.currentTarget.text.value.trim().slice(0, 40) || null }); closeMenu(); }}>
                    <input name="text" defaultValue={pageSetup.watermark || ''} placeholder="Custom text" aria-label="Custom watermark" style={{ width: 120 }} />
                    <button type="submit" className="primary-btn" style={{ fontSize: 12, padding: '4px 9px' }}>Set</button>
                  </form>
                  <div className="doc-ribbon-sep" />
                  <button type="button" className="doc-ribbon-item" onClick={() => { updatePageSetup({ watermark: null }); closeMenu(); }}>Remove Watermark</button>
                </>
              )}
            </Menu>
          </Group>
          </>
          )}

          {shownTab === 'layout' && (
          <>
          <Group label="Page Setup" onLaunch={() => setPageSetupOpen(true)} launchTitle="Page Setup">
          <Menu big icon={RectangleHorizontal} label="Margins" items={[
            { label: 'Normal - 1" all around', onClick: () => updatePageSetup({ margins: 'normal' }), active: pageSetup.margins === 'normal' },
            { label: 'Narrow - 0.5" all around', onClick: () => updatePageSetup({ margins: 'narrow' }), active: pageSetup.margins === 'narrow' },
            { label: 'Moderate - 1" top and bottom, 0.75" sides', onClick: () => updatePageSetup({ margins: 'custom', marginIn: { top: 1, bottom: 1, left: 0.75, right: 0.75 } }) },
            { label: 'Wide - 1.5" all around', onClick: () => updatePageSetup({ margins: 'wide' }), active: pageSetup.margins === 'wide' }, '-',
            { label: 'Custom Margins…', onClick: () => { if (pageSetup.margins !== 'custom') updatePageSetup({ margins: 'custom', marginIn: marginsOf(pageSetup) }); setPageSetupOpen(true); }, active: pageSetup.margins === 'custom' }]} />
          <Menu big icon={RotateCw} label="Orientation" items={ORIENTATIONS.map(o => ({ label: o.label, onClick: () => updatePageSetup({ orientation: o.value }), active: pageSetup.orientation === o.value }))} />
          <Menu big icon={PageIcon} label="Size" items={PAGE_SIZES.map(s => ({ label: s.label, onClick: () => updatePageSetup({ size: s.value }), active: pageSetup.size === s.value }))} />
          <Menu big icon={Columns2} label="Columns" items={[[1, 'One'], [2, 'Two'], [3, 'Three']].map(([n, l]) => ({ label: l, onClick: () => updatePageSetup({ columns: n }), active: (pageSetup.columns || 1) === n }))} />
          <Menu big icon={SeparatorHorizontal} label="Breaks" items={[
            { label: 'Page Break', onClick: () => activeEditor.chain().focus().insertContent([{ type: 'pageBreak' }, { type: 'paragraph' }]).run() },
            ...(kind === 'document' ? [{ label: 'New Page at the End', onClick: addPage }] : [])]} />
          <Menu big icon={Hash} label="Line Numbers" items={[
            { label: 'None', onClick: () => updatePageSetup({ lineNumbers: false }), active: !pageSetup.lineNumbers },
            { label: 'Continuous', onClick: () => updatePageSetup({ lineNumbers: true }), active: !!pageSetup.lineNumbers }]} />
          <div style={{ position: 'relative' }}>
            <BigBtn icon={FileStack} label="More…" title="Page Setup" active={pageSetupOpen} onClick={() => setPageSetupOpen(o => !o)} />
            {pageSetupOpen && (
              <div style={{ position: 'absolute', top: '110%', left: 0, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, boxShadow: 'var(--shadow-lg)', zIndex: 20, width: 260, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div>
                  <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 4 }}>Page Size</label>
                  <select className="form-input" style={{ width: '100%', fontSize: 13 }} value={pageSetup.size}
                    onChange={e => updatePageSetup({ size: e.target.value })}>
                    {PAGE_SIZES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 4 }}>Orientation</label>
                  <select className="form-input" style={{ width: '100%', fontSize: 13 }} value={pageSetup.orientation}
                    onChange={e => updatePageSetup({ orientation: e.target.value })}>
                    {ORIENTATIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 4 }}>Margins</label>
                  <select className="form-input" style={{ width: '100%', fontSize: 13 }} value={pageSetup.margins}
                    onChange={e => updatePageSetup(e.target.value === 'custom'
                      ? { margins: 'custom', marginIn: marginsOf(pageSetup) }
                      : { margins: e.target.value })}>
                    {MARGIN_PRESETS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                  </select>
                  {pageSetup.margins === 'custom' && (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 6 }}>
                      {['top', 'bottom', 'left', 'right'].map(side => (
                        <label key={side} style={{ fontSize: 11, color: 'var(--muted)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                          {side[0].toUpperCase() + side.slice(1)}
                          <input type="number" min="0.2" max="3" step="0.05" className="form-input" style={{ width: 64, fontSize: 12, padding: '3px 6px' }}
                            value={marginsOf(pageSetup)[side]}
                            onChange={e => updatePageSetup({ marginIn: { ...marginsOf(pageSetup), [side]: Number(e.target.value) } })} />
                        </label>
                      ))}
                      <span style={{ gridColumn: '1 / -1', fontSize: 11, color: 'var(--muted)' }}>Inches</span>
                    </div>
                  )}
                </div>
                <div>
                  <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 4 }}>Columns</label>
                  <select className="form-input" style={{ width: '100%', fontSize: 13 }} value={pageSetup.columns || 1}
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
                    <select className="form-input" style={{ flex: 1, fontSize: 13 }}
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
                    Page Color
                    <input type="color" value={pageSetup.pageColor || '#ffffff'}
                      onChange={e => updatePageSetup({ pageColor: e.target.value === '#ffffff' ? null : e.target.value })}
                      style={{ width: 24, height: 24, padding: 0, border: '1px solid var(--line)', borderRadius: 5, cursor: 'pointer' }} />
                  </label>
                </div>
                <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}>
                  Line numbers <input type="checkbox" checked={!!pageSetup.lineNumbers} onChange={e => updatePageSetup({ lineNumbers: e.target.checked })} />
                </label>
                <div style={{ borderTop: '1px solid var(--line)', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}>
                    Header <input type="checkbox" checked={headerVisible} onChange={toggleHeader} />
                  </label>
                  <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}>
                    Footer <input type="checkbox" checked={footerVisible} onChange={toggleFooter} />
                  </label>
                </div>
              </div>
            )}
          </div>
          </Group>
          <Group label="Paragraph" onLaunch={() => setParaDlg(true)} launchTitle="Paragraph Settings">
            <div className="doc-ribbon-stack">
              <div className="doc-ribbon-row">
                {[['indentLeft', 'Indent Left', 'Left indent, in points'], ['indentRight', 'Indent Right', 'Right indent, in points']].map(([key, label, hint]) => (
                  <label key={key} className="doc-ribbon-field" title={hint}>
                    {label}
                    <input type="number" min={0} max={360} step={6} value={activeEditor.getAttributes(currentBlockType())[key] || ''}
                      onChange={e => setParaAttr({ [key]: e.target.value ? Number(e.target.value) : null })} /> pt
                  </label>
                ))}
              </div>
              <div className="doc-ribbon-row">
                {[['spacingBefore', 'Spacing Before', 'Space before paragraph, in points'], ['spacingAfter', 'Spacing After', 'Space after paragraph, in points']].map(([key, label, hint]) => (
                  <label key={key} className="doc-ribbon-field" title={hint}>
                    {label}
                    <input type="number" min={0} max={72} step={1} value={activeEditor.getAttributes(currentBlockType())[key] ?? ''}
                      onChange={e => setParaAttr({ [key]: e.target.value ? Number(e.target.value) : null })} /> pt
                  </label>
                ))}
              </div>
            </div>
          </Group>
          </>
          )}

          {shownTab === 'references' && (
          <>
          <Group label="Table of Contents">
            <BigBtn icon={ListTree} label={findTocRange() ? 'Update Table' : 'Table of Contents'} title="Table of Contents - lists every heading with its page number" onClick={insertTableOfContents} />
            <BigBtn icon={Trash2} label="Remove" title="Remove Table of Contents" onClick={removeTableOfContents} disabled={!findTocRange()} />
          </Group>
          <Group label="Footnotes">
            <BigBtn icon={SuperscriptIcon} label="Insert Footnote" title="Insert Footnote (Ctrl+Alt+F) - a numbered note at the foot of the page" disabled={!editing} onClick={insertFootnote} />
            <BigBtn icon={ChevronRight} label="Next Footnote" title="Next footnote" onClick={stepFootnote} />
            <Menu big icon={ListOrdered} label="Notes" title="Every footnote in this document" width={300}>
              {(closeMenu) => {
                const list = footnoteList();
                return list.length ? list.map((f, i) => (
                  <button key={`${i}-${f.pos}`} type="button" className="doc-ribbon-item" title="Edit this footnote"
                    onClick={() => { closeMenu(); editFootnote(f.e, f.pos); }}>
                    <span style={{ fontWeight: 700, minWidth: 18 }}>{i + 1}</span>
                    <span style={{ whiteSpace: 'normal' }}>{f.text}</span>
                  </button>
                )) : <div className="doc-ribbon-pick-none">No footnotes yet.</div>;
              }}
            </Menu>
          </Group>
          </>
          )}

          {shownTab === 'variables' && (
          <>
          <Group label="Insert">
            <BigBtn icon={Variable} label="Variable Library" title="Variable Library - browse every variable and drag one in"
              active={varsOpen && varsTab === 'library'} onClick={() => toggleVars('library')} />
            {insertVariablePick()}
          </Group>
          <Group label="Create">
            {kind === 'template' && (
              <BigBtn icon={Sparkles} label="Make Variable" title="Select text, then click to convert it into a named merge field" onClick={openConvertToMergeField} />
            )}
            <BigBtn icon={detecting ? Spinner : Wand2} label="Detect" title="Find {{variables}} written on the page and turn them into real merge fields"
              disabled={detecting} onClick={detectVariables} />
            {kind === 'template' && (
              <BigBtn icon={ListChecks} label="Fields" title="Template Fields - set the type of answer each variable takes"
                active={!!fieldsPanel} onClick={() => openFieldsPanel()} />
            )}
          </Group>
          <Group label="Preview">
            <BigBtn icon={Eye} label="Preview Results" title="Preview Results - show the values this document will print in place of the variable names"
              active={previewResults} onClick={() => setPreviewResults((v) => !v)} />
            <BigBtn icon={Highlighter} label="Highlight Fields" title="Highlight Fields - Word's gray shading on every variable"
              active={fieldShading} onClick={() => setFieldShading((v) => !v)} />
          </Group>
          <Group label="Values">
            <Menu big icon={Users} label="Merge Data" title={`Merge Data: ${activeEmployee ? empLabel(activeEmployee) : 'Nobody picked'}`} width={316}>
              {() => mergeDataPanel()}
            </Menu>
          </Group>
          <Group label="In This Document">
            <BigBtn icon={ListChecks} label={`Variables Used (${usedVars.length})`} title="Variables Used - every variable placed in this document"
              active={varsOpen && varsTab === 'used'} onClick={() => toggleVars('used')} />
            <BigBtn icon={ChevronLeft} label="Previous" title="Previous variable" disabled={!usedVars.length} onClick={() => stepField(-1)} />
            <BigBtn icon={ChevronRight} label="Next" title="Next variable" disabled={!usedVars.length} onClick={() => stepField(1)} />
          </Group>
          </>
          )}

          {shownTab === 'review' && (
          <>
          <Group label="Proofing">
            <BigBtn icon={SpellCheck} label="Spelling" title="Underline misspelled words (the browser's own spelling check)" active={viewPrefs.spell} onClick={() => setPref('spell', !viewPrefs.spell)} />
            <BigBtn icon={FileSearch} label="Word Count" onClick={() => setWordCountOpen(true)} />
            <BigBtn icon={Accessibility} label="Check Accessibility" onClick={() => setA11yIssues(accessibilityIssues([...editorsRef.current.values()]))} />
          </Group>
          <Group label="Comments">
            <BigBtn icon={MessageSquare} label="New Comment" title="Comment on the selected text" onClick={startComment}
              disabled={!activeEditor || activeEditor.state.selection.empty} />
            <BigBtn icon={Trash2} label="Delete" title="Delete the selected comment thread" onClick={deleteActiveComment} disabled={!activeComment} />
            <BigBtn icon={ChevronLeft} label="Previous" title="Previous comment" onClick={() => stepComment(-1)} disabled={commentRoots.length < 2} />
            <BigBtn icon={ChevronRight} label="Next" title="Next comment" onClick={() => stepComment(1)} disabled={commentRoots.length < 2} />
            <BigBtn icon={MessageSquare} label="Show Comments" title="Show or hide the comments pane" active={commentsOpen} onClick={() => setCommentsOpen((o) => !o)} />
          </Group>
          <Group label="Tracking">
            <Menu big icon={PenLine} label="Track Changes" title="Mark every insertion and deletion with who made it (Ctrl+Shift+E)" active={tracking !== 'off'} items={[
              { label: 'Off', onClick: () => setTrackingMode('off'), active: tracking === 'off' },
              { label: 'For Everyone', title: 'Saved with the document: whoever opens it next keeps tracking', onClick: () => setTrackingMode('everyone'), active: tracking === 'everyone' },
              { label: 'Just Mine', title: 'Track my changes in this browser only', onClick: () => setTrackingMode('mine'), active: tracking === 'mine' }]} />
            <Menu big icon={Eye} label="Markup View" items={[
              { label: 'Markup On Page', title: 'All Markup: insertions underlined, deletions struck through', onClick: () => setMarkupView('all'), active: markupView === 'all' },
              { label: 'Markup In Margin', title: 'Simple Markup: the final text, with a bar beside every changed paragraph', onClick: () => setMarkupView('simple'), active: markupView === 'simple' }]} />
          </Group>
          <Group label="Changes">
            <Menu big icon={Check} label="Accept" title="Accept the change at the cursor and move to the next" disabled={!changeCount} items={[
              { label: 'Accept And Move To Next', onClick: () => resolveChange(true) },
              { label: 'Accept All Changes', onClick: () => resolveAll(true) }]} />
            <Menu big icon={X} label="Reject" title="Reject the change at the cursor and move to the next" disabled={!changeCount} items={[
              { label: 'Reject And Move To Next', onClick: () => resolveChange(false) },
              { label: 'Reject All Changes', onClick: () => resolveAll(false) }]} />
            <BigBtn icon={ChevronLeft} label="Previous" title="Previous tracked change" onClick={() => { activeEditor?.chain().focus().selectChange(-1).run(); setSelectionTick((t) => t + 1); }} disabled={!changeCount} />
            <BigBtn icon={ChevronRight} label="Next" title="Next tracked change" onClick={() => { activeEditor?.chain().focus().selectChange(1).run(); setSelectionTick((t) => t + 1); }} disabled={!changeCount} />
            <span style={{ fontSize: 11, color: 'var(--muted)', alignSelf: 'center', padding: '0 4px', whiteSpace: 'nowrap' }}>{changeCount === 1 ? '1 change' : `${changeCount} changes`}</span>
          </Group>
          <Group label="Mode">
            <Menu big icon={docMode === 'Viewing' ? EyeOff : docMode === 'Reviewing' ? PenLine : Type} label={docMode} title="Editing: make any changes. Reviewing: every change is tracked. Viewing: read, change nothing." items={[
              { label: 'Editing', title: 'Make any changes', onClick: () => { setViewingOnly(false); if (tracking !== 'off') setTrackingMode('off'); }, active: docMode === 'Editing' },
              { label: 'Reviewing', title: 'Track every change for everyone', onClick: () => { setViewingOnly(false); setTrackingMode('everyone'); }, active: docMode === 'Reviewing' },
              { label: 'Viewing', title: 'Read the document, change nothing', onClick: () => setViewingOnly(true), active: docMode === 'Viewing' }]} />
          </Group>
          </>
          )}

          {shownTab === 'view' && (
          <>
          <Group label="Views">
            <BigBtn icon={PageIcon} label="Separate Pages" title="Lay the document out as pages" active={viewPrefs.paginate} onClick={() => setPref('paginate', !viewPrefs.paginate)} />
            <BigBtn icon={BookOpen} label="Reading View" title="Read the document without the editing tools" onClick={() => { setPreview(true); if (kind === 'document') openPdfPreview(); }} />
          </Group>
          <Group label="Zoom">
            <Menu big icon={ZoomIn} label="Zoom" items={[
              ...[50, 75, 100, 150, 200].map(p => ({ label: `${p}%`, onClick: () => setZoom(p / 100), active: Math.round(zoom * 100) === p })),
              '-', { label: 'Page Width', onClick: zoomToPageWidth }, { label: 'Fit Page', onClick: zoomToFit }]} />
            <BigBtn icon={ZoomOut} label="100%" onClick={() => setZoom(1)} active={zoom === 1} />
          </Group>
          <Group label="Show">
            <BigBtn icon={RulerIcon} label="Ruler" title="Ruler - both rulers, to set margins, indents and tab stops" active={!!rulerOn} onClick={() => setRulerOn(!rulerOn)} />
            <BigBtn icon={PanelLeft} label="Navigation" active={viewPrefs.nav} onClick={() => setPref('nav', !viewPrefs.nav)} />
            <BigBtn icon={LayoutPanelTop} label="Header & Footer" active={headerVisible || footerVisible} onClick={toggleHeaderFooter} />
            <BigBtn icon={Pilcrow} label="Formatting Marks" active={showMarks} onClick={() => setShowMarks(s => !s)} />
          </Group>
          </>
          )}

          {shownTab === 'tableDesign' && inTable && (
          <>
          <Group label="Table Style Options">
            <BigBtn icon={Rows} label="Header Row" title="Toggle header row" active={activeEditor.isActive('tableHeader')} onClick={() => activeEditor.chain().focus().toggleHeaderRow().run()} />
            <BigBtn icon={Columns} label="First Column" title="Toggle header column" onClick={() => activeEditor.chain().focus().toggleHeaderColumn().run()} />
          </Group>
          <Group label="Table Styles">
            <Menu big icon={PaintBucket} label="Shading" title="Shade the current cell" width={260}>
              <ColorGrid rows={[THEME_COLORS.map(h => [h]), STANDARD_COLORS.map(h => [h])]}
                current={activeEditor.getAttributes(activeEditor.isActive('tableHeader') ? 'tableHeader' : 'tableCell').backgroundColor}
                onPick={(hex) => activeEditor.chain().focus().updateAttributes(activeEditor.isActive('tableHeader') ? 'tableHeader' : 'tableCell', { backgroundColor: hex }).run()}
                onNone={() => activeEditor.chain().focus().updateAttributes(activeEditor.isActive('tableHeader') ? 'tableHeader' : 'tableCell', { backgroundColor: null }).run()} />
            </Menu>
            <Menu big icon={RectangleHorizontal} label="Borders" title="Table borders" items={[
              { label: 'All Borders', active: activeEditor.getAttributes('table').borders !== 'none', onClick: () => activeEditor.chain().focus().updateAttributes('table', { borders: null }).run() },
              { label: 'No Border', active: activeEditor.getAttributes('table').borders === 'none', onClick: () => activeEditor.chain().focus().updateAttributes('table', { borders: 'none' }).run() },
            ]} />
          </Group>
          </>
          )}

          {shownTab === 'tableLayout' && inTable && (
          <>
          <Group label="Rows & Columns">
            <BigBtn icon={Rows} label="Insert Above" title="Add row above" onClick={() => activeEditor.chain().focus().addRowBefore().run()} />
            <BigBtn icon={Rows} label="Insert Below" title="Add row below" onClick={() => activeEditor.chain().focus().addRowAfter().run()} />
            <BigBtn icon={Columns} label="Insert Left" title="Add column left" onClick={() => activeEditor.chain().focus().addColumnBefore().run()} />
            <BigBtn icon={Columns} label="Insert Right" title="Add column right" onClick={() => activeEditor.chain().focus().addColumnAfter().run()} />
            <Menu big icon={Trash2} label="Delete" title="Delete cells, rows, columns or the table" items={[
              { label: 'Delete Row', onClick: () => activeEditor.chain().focus().deleteRow().run() },
              { label: 'Delete Column', onClick: () => activeEditor.chain().focus().deleteColumn().run() },
              { label: 'Delete Table', onClick: () => activeEditor.chain().focus().deleteTable().run() },
            ]} />
          </Group>
          <Group label="Merge">
            <BigBtn icon={Combine} label="Merge Cells" title="Merge cells" onClick={() => activeEditor.chain().focus().mergeCells().run()} />
            <BigBtn icon={SquareSplitHorizontal} label="Split Cell" title="Split cell" onClick={() => activeEditor.chain().focus().splitCell().run()} />
          </Group>
          </>
          )}

          {shownTab === 'shape' && shapeType && (() => {
            const attrs = activeEditor.getAttributes(shapeType);
            const rotate = (delta) => activeEditor.chain().focus().updateAttributes(shapeType, { rotation: ((attrs.rotation || 0) + delta + 360) % 360 }).run();
            const fillKey = 'fillColor';
            const lineKey = shapeType === 'docShape' ? 'strokeColor' : 'borderColor';
            return (
              <>
              <Group label="Shape Styles">
                <Menu big icon={PaintBucket} label={shapeType === 'docShape' ? 'Shape Fill' : 'Fill'} title="Fill color" width={260}>
                  <ColorGrid rows={[THEME_COLORS.map(h => [h]), STANDARD_COLORS.map(h => [h])]} current={attrs[fillKey]}
                    onPick={(hex) => activeEditor.chain().focus().updateAttributes(shapeType, { [fillKey]: hex }).run()}
                    onNone={() => activeEditor.chain().focus().updateAttributes(shapeType, { [fillKey]: 'transparent' }).run()} />
                </Menu>
                <Menu big icon={RectangleHorizontal} label={shapeType === 'docShape' ? 'Shape Outline' : 'Border'} title="Outline color" width={260}>
                  <ColorGrid rows={[THEME_COLORS.map(h => [h]), STANDARD_COLORS.map(h => [h])]} current={attrs[lineKey]}
                    onPick={(hex) => activeEditor.chain().focus().updateAttributes(shapeType, { [lineKey]: hex }).run()} more />
                </Menu>
              </Group>
              <Group label="Arrange">
                <Menu big icon={Move} label="Wrap Text" title="Wrap text around it" items={WRAP_MODES.map((w) => ({
                  label: w.label, active: (attrs.wrapMode || 'inline') === w.value, onClick: () => activeEditor.chain().focus().updateAttributes(shapeType, { wrapMode: w.value }).run(),
                }))} />
                <BigBtn icon={RotateCcw} label="Rotate Left" title="Rotate left 90°" onClick={() => rotate(-90)} />
                <BigBtn icon={RotateCw} label="Rotate Right" title="Rotate right 90°" onClick={() => rotate(90)} />
              </Group>
              </>
            );
          })()}

          {shownTab === 'picture' && imgAttrs && (
          <>
          <Group label="Picture Styles">
            <Menu big icon={Frame} label="Styles" title="Picture style" items={[
              { label: 'No Style', onClick: () => setImg({ frame: 'none' }), active: (imgAttrs.frame || 'none') === 'none' },
              { label: 'Simple Frame', onClick: () => setImg({ frame: 'simple' }), active: imgAttrs.frame === 'simple' },
              { label: 'Soft Shadow', onClick: () => setImg({ frame: 'shadow' }), active: imgAttrs.frame === 'shadow' },
              { label: 'Rounded Corners', onClick: () => setImg({ frame: 'rounded' }), active: imgAttrs.frame === 'rounded' }]} />
            <Menu big icon={Square} label="Border" title="Picture border color" width={236}>
              <ColorGrid rows={[THEME_COLORS.map((c) => [c]), STANDARD_COLORS.map((c) => [c])]} current={imgAttrs.borderColor}
                onPick={(hex) => setImg({ borderColor: hex })} onNone={() => setImg({ borderColor: null })} noneLabel="No Border" />
            </Menu>
          </Group>
          <Group label="Arrange">
            <Menu big icon={Move} label="Wrap Text" title="How the text goes around the picture" items={PICTURE_WRAPS.map(([value, label]) => ({ label, onClick: () => setImg({ wrapMode: value, x: 0, y: 0 }), active: (imgAttrs.wrapMode || 'inline') === value }))} />
            <Menu big icon={AlignCenter} label="Align" items={[
              { label: 'Align Left', icon: AlignLeft, onClick: () => alignImg('left') },
              { label: 'Align Center', icon: AlignCenter, onClick: () => alignImg('center') },
              { label: 'Align Right', icon: AlignRight, onClick: () => alignImg('right') }]} />
            <Menu big icon={RotateCw} label="Rotate" items={[
              { label: 'Rotate Right 90°', icon: RotateCw, onClick: () => setImg({ rotation: ((imgAttrs.rotation || 0) + 90) % 360 }) },
              { label: 'Rotate Left 90°', icon: RotateCcw, onClick: () => setImg({ rotation: ((imgAttrs.rotation || 0) + 270) % 360 }) },
              { label: 'Flip Vertical', icon: FlipVertical, onClick: () => setImg({ flipV: !imgAttrs.flipV }), active: !!imgAttrs.flipV },
              { label: 'Flip Horizontal', icon: FlipHorizontal, onClick: () => setImg({ flipH: !imgAttrs.flipH }), active: !!imgAttrs.flipH }]} />
          </Group>
          <Group label="Size">
            <BigBtn icon={Crop} label="Crop" title="Crop - drag the edge handles; the picture keeps its size and the box shrinks. Esc or Crop again to finish." active={cropping} onClick={() => setCropping((c) => !c)} />
            <div className="doc-ribbon-stack" style={{ gap: 4 }}>
              <label className="doc-ribbon-field">Height
                <input type="number" step="0.1" min="0.1" aria-label="Picture height, in inches" value={imgBox.h ? (imgBox.h / 96).toFixed(2) : ''}
                  onChange={(e) => sizeImg('height', e.target.value)} /> in
              </label>
              <label className="doc-ribbon-field">Width
                <input type="number" step="0.1" min="0.1" aria-label="Picture width, in inches" value={imgBox.w ? (imgBox.w / 96).toFixed(2) : ''}
                  onChange={(e) => sizeImg('width', e.target.value)} /> in
              </label>
            </div>
            <label className="doc-ribbon-field" title="Keep the picture's proportions when one side changes">
              <input type="checkbox" checked={lockAspect} onChange={(e) => setLockAspect(e.target.checked)} /> Lock aspect ratio
            </label>
          </Group>
          <Group label="Picture">
            <BigBtn icon={Replace} label="Change Picture" title="Swap in another picture, keeping the size and wrap" onClick={changePicture} />
            <BigBtn icon={RotateCcw} label="Reset Picture" title="Back to the picture as inserted: size, rotation, border, style and wrap" onClick={resetImg} />
            <BigBtn icon={Trash2} label="Delete" title="Delete this picture" onClick={() => activeEditor.chain().focus().deleteSelection().run()} />
          </Group>
          <Group label="Accessibility">
            <label className="doc-ribbon-field" style={{ minWidth: 200 }}>Alt Text
              <input value={imgAttrs.alt || ''} placeholder="Describe this picture…" aria-label="Alt text" style={{ flex: 1 }}
                onChange={(e) => setImg({ alt: e.target.value })} />
            </label>
          </Group>
          </>
          )}
        </>)} />}
        <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/gif,image/webp" onChange={onPickImage} style={{ display: 'none' }} />

        {findOpen && (
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, margin: '4px 0 10px', padding: '8px 10px', background: 'var(--mist)', border: '1px solid var(--line)', borderRadius: 8 }}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setFindOpen(false); setFindMatches([]); setFindIndex(-1); activeEditor?.commands.focus(); } }}>
            <input className="form-input" style={{ fontSize: 12, width: 160 }} placeholder="Find" value={findQuery}
              onChange={e => setFindQuery(e.target.value)} onKeyDown={e => e.key === 'Enter' && runFind()} autoFocus />
            <input className="form-input" style={{ fontSize: 12, width: 160 }} placeholder="Replace with" value={replaceQuery}
              onChange={e => setReplaceQuery(e.target.value)} onKeyDown={e => e.key === 'Enter' && replaceCurrent()} />
            <button onClick={runFind} className="primary-btn" style={{ fontSize: 12, padding: '5px 10px' }}>Find</button>
            <button onClick={() => findStep(-1)} disabled={!findMatches.length} style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 6, padding: '5px 8px', cursor: findMatches.length ? 'pointer' : 'default', fontSize: 12 }}>Prev</button>
            <button onClick={() => findStep(1)} disabled={!findMatches.length} style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 6, padding: '5px 8px', cursor: findMatches.length ? 'pointer' : 'default', fontSize: 12 }}>Next</button>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>{findMatches.length ? `${findIndex + 1} of ${findMatches.length}` : 'No matches'}</span>
            <button onClick={replaceCurrent} disabled={!findMatches.length} style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 6, padding: '5px 10px', cursor: findMatches.length ? 'pointer' : 'default', fontSize: 12 }}>Replace</button>
            <button onClick={replaceAll} disabled={!findMatches.length} style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 6, padding: '5px 10px', cursor: findMatches.length ? 'pointer' : 'default', fontSize: 12 }}>Replace All</button>
            <button onClick={() => { setFindOpen(false); setFindMatches([]); setFindIndex(-1); }} title="Close" style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)' }}><X size={15} /></button>
          </div>
        )}
        </div>
      )}

      {!preview && quickSections.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, margin: '-6px 0 14px' }}>
          <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>Add section:</span>
          {quickSections.map(s => (
            <button key={s.heading} onClick={() => insertQuickSection(s.heading)} title={s.hint || `Insert a "${s.heading}" heading`}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--mist)', border: '1px solid var(--line)', borderRadius: 8, padding: '6px 12px', cursor: 'pointer', fontSize: 13, fontWeight: 600, color: 'var(--ink)', fontFamily: 'Inter, sans-serif' }}>
              <Plus size={13} /> {s.heading}
            </button>
          ))}
        </div>
      )}

      {imgMenu && imgAttrs && (
        <ContextMenu x={imgMenu.x} y={imgMenu.y} onClose={() => setImgMenu(null)} items={[
          { label: 'Cut', icon: Scissors, hint: 'Ctrl+X', onClick: () => clipboardAction('cut') },
          { label: 'Copy', icon: ClipboardCopy, hint: 'Ctrl+C', onClick: () => clipboardAction('copy') },
          { label: 'Paste', icon: ClipboardPaste, hint: 'Ctrl+V', onClick: () => clipboardAction('paste') },
          '-',
          { label: 'Change Picture…', icon: Replace, onClick: changePicture },
          { label: 'Crop', icon: Crop, onClick: () => { setRibbonTab('picture'); setCropping(true); } },
          { label: 'Wrap Text', heading: true },
          ...PICTURE_WRAPS.map(([value, label]) => ({ label, sub: true, active: (imgAttrs.wrapMode || 'inline') === value, onClick: () => setImg({ wrapMode: value, x: 0, y: 0 }) })),
          '-',
          { label: 'Format Picture', icon: ImageIcon, onClick: () => setRibbonTab('picture') },
          { label: 'Reset Picture', icon: RotateCcw, onClick: resetImg },
          { label: 'Delete Picture', icon: Trash2, onClick: () => activeEditor.chain().focus().deleteSelection().run() },
        ]} />
      )}
      {/* The desk (11/11/2026): the page alone, centered on the gray. The
          Navigation pane (View > Navigation) and Comments float over the
          margins; they push the page aside only when a margin is too narrow
          for them (style.css ".nx-docb-desk"). */}
      <div className={`nx-docb-desk${navShown ? ' has-left' : ''}${commentsShown || varsShown ? ' has-right' : ''}`}
        style={{ '--nx-page-w': `${Math.round(pageCanvasStyle(pageSetup).maxWidth * zoom) + 48}px` }}>
      <div className="nx-docb-canvas" onContextMenu={onPagesContextMenu}>
      <div ref={canvasRef} className="nx-docb-pagecol">
      {showRulers && (() => {
        const pageW = pageCanvasStyle(pageSetup).maxWidth;
        return (
          <div className="doc-rulers">
            <div className="doc-rulers-inner" style={{ width: Math.round(pageW * zoom) }}>
              <button type="button" className="doc-ruler-corner" disabled={!editing}
                title={`${TAB_LABEL[tabType]} - click the ruler to set one. Click here for another kind.`} aria-label={`Tab stop type: ${TAB_LABEL[tabType]}`}
                onClick={() => setTabType((t) => TAB_ALIGNS[(TAB_ALIGNS.indexOf(t) + 1) % TAB_ALIGNS.length])}>
                <TabGlyph align={tabType} size={11} />
              </button>
              <HRuler widthPx={Math.round(pageW * zoom)} zoom={zoom} margins={marginsOf(pageSetup)} para={paraIndents}
                editable={editing} onMargin={setMarginInches} onIndent={applyIndents}
                tabs={paraTabs} tabType={tabType} onTabs={applyTabStops} />
              {viewPrefs.paginate && (
                <VRuler zoom={zoom} margins={marginsOf(pageSetup)} pageHeightPx={pageCanvasStyle(pageSetup).minHeight} gapPx={SHEET_SPACE_PX}
                  pagesEl={rulerPagesEl} scrollerEl={rulerScrollerEl} editable={editing} onMargin={setMarginInches} />
              )}
            </div>
          </div>
        );
      })()}
      <div style={zoom === 1 ? undefined : { zoom }}>

      {/* Each page is its own bounded sheet. The letterhead sits at the top of
          page 1's text frame (the exporter reserves the same band); the header
          and footer EDITORS live in page 1's top margin and the last page's
          bottom margin, and every sheet in between repeats them as static
          bands (DocPage draws those). TipTap cannot mount one editor twice,
          which is why the editable copy exists once. */}
      {pages.map((p, i) => {
        const isFirst = i === 0;
        const isLast = i === pages.length - 1;
        const smallBtn = (label, onClick, extra = {}) => (preview ? null : (
          <button type="button" onClick={onClick}
            style={{ background: 'none', border: 'none', color: 'var(--muted)', fontSize: 11, fontWeight: 600, cursor: 'pointer', padding: 0, ...extra }}>{label}</button>
        ));
        const headerSlot = !isFirst ? undefined : headerVisible ? (
          <div>
            {smallBtn('Remove header', () => { setHeaderVisible(false); headerEditor?.commands.clearContent(); scheduleSave(); }, { float: 'right', marginLeft: 8 })}
            <EditorContent editor={headerEditor} className="doc-editor doc-inline-editor" />
          </div>
        ) : (smallBtn('+ Add header', () => setHeaderVisible(true)) ?? <span />);
        const footerSlot = !isLast ? undefined : (
          <div>
            {activeLetterhead?.footerJson?.text && <div className="doc-letterhead-tagline" style={{ margin: 0 }}>{activeLetterhead.footerJson.text}</div>}
            {footerVisible ? (
              <>
                {smallBtn('Remove footer', () => { setFooterVisible(false); footerEditor?.commands.clearContent(); scheduleSave(); }, { float: 'right', marginLeft: 8 })}
                <EditorContent editor={footerEditor} className="doc-editor doc-inline-editor" />
              </>
            ) : smallBtn('+ Add footer', () => setFooterVisible(true))}
          </div>
        );
        const topSlot = isFirst && activeLetterhead ? (
          <div ref={letterheadRef} style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, marginBottom: 16, paddingBottom: 12, borderBottom: '2px solid #111827' }}>
            {activeLetterhead.logoPath && <img src={activeLetterhead.logoPath} alt={activeLetterhead.name} style={{ height: 34, maxWidth: 140, objectFit: 'contain', flex: '0 0 auto' }} />}
            <div style={{ minWidth: 0 }}>
              <div className="doc-letterhead-name" style={{ whiteSpace: 'nowrap' }}>{activeLetterhead.name}</div>
              {activeLetterhead.address && <div className="doc-letterhead-address">{activeLetterhead.address}</div>}
            </div>
          </div>
        ) : null;
        // Between two pages (and after the last), a "+ Add Page" that shows
        // on hover - zero height, so it never moves the pagination.
        const gap = kind === 'document' && !preview && !isMobile && !isLocked && !viewingOnly && !readOnly && (
          <div className="nx-docb-pagegap">
            <button type="button" onClick={() => addPage(i + 1)} title={isLast ? 'Add a page at the end' : `Add a page after page ${i + 1}`}>
              <Plus size={12} /> Add Page
            </button>
          </div>
        );
        return (
          <Fragment key={p.id}>
          <DocPage pageId={p.id} pageNumber={i + 1} pageCount={pages.length} docTitle={title || 'Untitled'} initialJson={p.json} editable={!preview && !isLocked && !viewingOnly && !readOnly} live={live} pageSetup={pageSetup} compact={isMobile} zoom={zoom}
            firstSheetPx={isFirst ? firstSheetPx : undefined} showMarks={showMarks}
            bandInfo={bandInfo} sheetBase={sheetStarts[i]} onSheets={onSheets} paginate={viewPrefs.paginate}
            topSlot={topSlot} headerSlot={headerSlot} footerSlot={footerSlot}
            onReady={registerPageEditor} onUpdate={onPageUpdate}
            onActivity={onPageActivity} onPaste={onBodyPaste} onVariableDrop={onVariableDrop} onTocClick={goToTocLink} />
          {gap}
          </Fragment>
        );
      })}
      </div>
      </div>
      </div>
      {navShown && (
        <aside className="nx-docb-pane is-left" aria-label="Navigation">
          <NavigationPane tab={navTab} onTab={setNavTab} headings={headingsOf(editorsRef.current, pages)} onGo={goToHeading}
            pages={kind === 'document' ? pageThumbs() : null} onClose={() => setPref('nav', false)}
            query={navQuery} onQuery={(q) => { setNavQuery(q); setNavHit(-1); }}
            results={navResults} activeResult={navHit} onResult={(i) => { setNavHit(i); jumpToMatch(navResults[i]); }} />
        </aside>
      )}
      {varsShown && (
        <aside className="nx-docb-pane is-right" aria-label="Variables">
          <VariablesPane tab={varsTab} onTab={setVarsTab} kind={kind} onClose={() => setVarsOpen(false)}
            rows={usedVars.map((v) => {
              const def = fieldDefs.find((f) => f.token === v.token);
              const value = String((previewValues && previewValues[v.token]) || mergeOverrides[v.token] || '').trim();
              return {
                token: v.token, count: v.count, value,
                label: def?.label || varLabel[v.token] || FRIENDLY_MERGE[v.token] || v.token,
                meta: builtinSet.has(v.token) && !def ? 'Filled By Nexus' : (def?.type || 'text'),
              };
            })}
            onInsert={insertVariable} onEdit={editVariable} onGo={(token) => stepField(1, token)}
            library={(
              <VariableLibrary open embedded onClose={() => setVarsOpen(false)} onInsert={insertVariable} localVariables={customVarKeys}
                anchorLabel={kind === 'template' ? 'the template' : 'the document'}
                used={Object.fromEntries(usedVars.map((v) => [v.token, v.count]))} />
            )} />
        </aside>
      )}
      {commentsShown && (
        <aside className="nx-docb-pane is-right" aria-label="Comments">
          <CommentsPane store={commentStore} me={me} isAdmin={myLevel >= 4}
            ownerEmail={String(doc?.ownerEmail || doc?.createdBy || '').toLowerCase()}
            activeId={activeComment} onSelect={selectComment}
            draft={commentDraft} onDraftSaved={onCommentSaved} onDraftCancel={() => setCommentDraft(null)}
            onClose={() => setCommentsOpen(false)} />
        </aside>
      )}
      </div>
      </>
      )}

      {selBubble && (
        <div className="nx-docb-bubble" style={{ left: selBubble.left, top: selBubble.top }} role="toolbar" aria-label="Selected text">
          <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={openConvertToMergeField}
            title={`Make "${selBubble.text.slice(0, 40)}" a variable`}>
            <Sparkles size={12} /> Make Variable
          </button>
        </div>
      )}

      {!preview && (
        <StatusBar page={(sheetStarts[pages.findIndex(p => p.id === activePageId)] || 0) + 1} pages={totalSheets}
          words={countWords([...editorsRef.current.values()]).words} zoom={zoom} setZoom={setZoom}
          onFit={zoomToFit} onPageWidth={zoomToPageWidth} onWordCount={() => setWordCountOpen(true)}
          onPages={!isMobile ? () => openNav(kind === 'document' ? 'pages' : 'headings') : undefined}
          variables={usedVars.length} onVariables={() => (varsOpen ? setVarsOpen(false) : openVars('used'))}
          tracking={tracking} onTracking={() => openOnRibbon('review')}
          view={viewPrefs.paginate ? 'print' : 'web'}
          onView={(v) => { if (v === 'read') { setPreview(true); if (isDoc) openPdfPreview(); } else setPref('paginate', v === 'print'); }} />
      )}
      {wordCountOpen && <WordCountDialog stats={countWords([...editorsRef.current.values()])} pages={totalSheets} onClose={() => setWordCountOpen(false)} />}
      {a11yIssues && <AccessibilityDialog issues={a11yIssues} onClose={() => setA11yIssues(null)} />}

      {historyOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
          onClick={() => setHistoryOpen(false)}>
          <div className="nx-popup" style={{ background: 'var(--card)', borderRadius: 16, display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)' }}
            onClick={e => e.stopPropagation()}>
            <div style={{ padding: '18px 20px', borderBottom: '1px solid var(--line)', fontSize: 15, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}>
              <History size={16} /> Version History
            </div>
            <div style={{ padding: 12, overflowY: 'auto', flex: 1 }}>
              {!versions ? (
                <div style={{ padding: 30, textAlign: 'center', color: 'var(--muted)' }}><Spinner size="section" /></div>
              ) : versions.length === 0 ? (
                <div style={{ padding: '20px 8px', color: 'var(--muted)', fontSize: 13 }}>No saved versions yet.</div>
              ) : versions.map((v, i) => (
                <div key={v.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 8px', borderBottom: '1px solid var(--line)' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>Version {v.versionNo}{i === 0 && <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 800, color: 'hsl(var(--color-green))' }}>CURRENT</span>}</div>
                    <div style={{ fontSize: 11, color: 'var(--muted)' }}>{v.editedBy} · {formatPacificDateTime(v.editedAt, '-')}{v.note ? ` · ${v.note}` : ''}</div>
                  </div>
                  {i !== 0 && (
                    <button onClick={() => restoreVersion(v)} disabled={!!restoringId}
                      style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 8, padding: '6px 10px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 600, opacity: restoringId ? 0.6 : 1 }}>
                      {restoringId === v.id ? <Spinner size={12} /> : <RotateCcw size={12} />} Restore
                    </button>
                  )}
                </div>
              ))}
            </div>
            <div style={{ padding: '12px 20px', borderTop: '1px solid var(--line)', display: 'flex', justifyContent: 'flex-end' }}>
              <button onClick={() => setHistoryOpen(false)} style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 8, padding: '8px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Close</button>
            </div>
          </div>
        </div>
      )}

      {paraDlg && ed && (
        <ParagraphDialog attrs={blockAttrs} onClose={() => setParaDlg(false)}
          onApply={(patch) => ed.chain().focus().updateAttributes('paragraph', patch).updateAttributes('heading', patch).run()} />
      )}
      {fontDlg && ed && (() => {
        const ts = ed.getAttributes('textStyle');
        return (
          <FontDialog fonts={FONT_GROUPS} onClose={() => setFontDlg(false)}
            marks={{ fontFamily: ts.fontFamily, fontSize: ts.fontSize, color: ts.color, bold: ed.isActive('bold'), italic: ed.isActive('italic'), underline: ed.isActive('underline'), strike: ed.isActive('strike'), superscript: ed.isActive('superscript'), subscript: ed.isActive('subscript') }}
            onApply={(m) => {
              let c = ed.chain().focus();
              c = m.fontFamily ? c.setFontFamily(m.fontFamily) : c.unsetFontFamily();
              c = m.fontSize ? c.setFontSize(m.fontSize) : c.unsetFontSize();
              c = m.color ? c.setColor(m.color) : c.unsetColor();
              c = m.bold ? c.setBold() : c.unsetBold();
              c = m.italic ? c.setItalic() : c.unsetItalic();
              c = m.underline ? c.setUnderline() : c.unsetUnderline();
              c = m.strike ? c.setStrike() : c.unsetStrike();
              c = m.superscript ? c.setSuperscript() : c.unsetSuperscript();
              c = m.subscript ? c.setSubscript() : c.unsetSubscript();
              c.run();
            }} />
        );
      })()}
      {importPopoverOpen && !preview && (
        <div className="modal-overlay" onClick={() => { if (!importing) setImportPopoverOpen(false); }}>
          <div className="modal-content nx-popup nx-center nx-docb-import" role="dialog" aria-label="Import a File" onClick={(e) => e.stopPropagation()}>
            {importPanel()}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, alignItems: 'center' }}>
              {importing && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)', marginRight: 'auto' }}><Spinner size={13} /> Importing…</span>}
              <button type="button" className="secondary-btn" disabled={importing} onClick={() => setImportPopoverOpen(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}


      {fieldsPanel && kind === 'template' && (
        <TemplateFieldsPanel
          fieldDefs={fieldDefs} tokens={fieldsPanel.newTokens} highlight={fieldsPanel.newTokens}
          docTokens={fieldsPanel.docTokens} builtins={builtins} shared={shared}
          onChange={saveFieldDefs}
          onEdit={(fd) => { setFieldsPanel(null); setMergeFieldModal({ existingDef: fd }); }}
          onClose={() => setFieldsPanel(null)} />
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
      {shortcutsOpen && <ShortcutsCard menus={docMenus} onClose={() => setShortcutsOpen(false)} />}
      {nameAsk && <NameOnClose kind={kind} suggestion={nameAsk.suggestion} category={doc?.category} onDone={nameAsk.resolve} />}
      {!preview && !isMobile && <KeyTips rootRef={rootRef} onTab={keyTipTab} />}
    </div>
  );
}


// ── Live editing (Neil, 11/05/2026, routers/documents.py "Working together") ─
// Every draft document someone may edit opens in a live session: everyone in
// it types together with named carets (docLive/). A viewer, a final document,
// a template or a session that could not start opens the builder as it always
// was. The build variable VITE_DOCS_LIVE=off turns live editing off.
const DOCS_LIVE_OFF = import.meta.env.VITE_DOCS_LIVE === 'off';

export default function DocumentBuilder(props) {
  if ((props.kind || 'document') !== 'document' || DOCS_LIVE_OFF) return <DocumentBuilderInner {...props} />;
  return <LiveDocumentGate {...props} />;
}

function LiveDocumentGate(props) {
  const [row, setRow] = useState(null);
  useEffect(() => {
    let alive = true;
    api.getDocument(props.docId).then((d) => { if (alive) setRow(d || {}); })
      .catch(() => { if (alive) setRow({}); });   // the builder's own load reports it
    return () => { alive = false; };
  }, [props.docId]);
  if (!row) return <div style={{ padding: 20 }}><Spinner size={18} /></div>;
  const eligible = (row.access === 'owner' || row.access === 'edit') && row.status === 'draft';
  if (!eligible) return <DocumentBuilderInner {...props} readOnly={row.access === 'view'} />;
  return <LiveDocumentSession {...props} />;
}

function LiveDocumentSession(props) {
  const { myEmail } = useRole() || {};
  const people = usePeople();
  const me = (myEmail || '').toLowerCase();
  const name = people.find((p) => p.email === me)?.name || me;
  const live = useLiveSession({ docId: props.docId, enabled: true, me, name, seed: seedLiveDoc, validate: validateLiveDoc });
  const user = useMemo(() => ({ name, color: caretColor(me) }), [name, me]);
  const liveProp = useMemo(() => (live.doc ? { ...live, user } : null), [live, user]);
  // A session that could not start opens the saved copy READ ONLY: an
  // editable copy outside the session would save over what others type live.
  if (live.status === 'failed') return (
    <>
      <div role="status" style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '8px 12px', marginBottom: 8, border: '1px solid var(--line)', borderRadius: 10, fontSize: 13, background: 'var(--card)' }}>
        Live editing could not start, so this is the saved copy, read only.
        <button type="button" className="secondary-btn" onClick={live.restart}>Try Again</button>
      </div>
      <DocumentBuilderInner {...props} readOnly />
    </>
  );
  if (!liveProp) return <div style={{ padding: 20, display: 'flex', gap: 8, alignItems: 'center', color: 'var(--muted)', fontSize: 13 }}><Spinner size={16} /> Opening...</div>;
  return <DocumentBuilderInner key={liveProp.doc.guid} {...props} live={liveProp} />;
}

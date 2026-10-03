// Task Module - rich description editor. TipTap document with an Asana-style
// toolbar, shared by the Create-a-Task modal and the task detail drawer.
//
// The value is HTML. Old plain-text descriptions still render (TipTap wraps
// them in a paragraph), so no migration. Outbound sync sends this HTML to
// Asana's html_notes - see backend/asana_sync.py.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Image from '@tiptap/extension-image';
import { Mark, mergeAttributes } from '@tiptap/core';
import {
  Plus, Undo2, Redo2, Bold, Italic, Underline as UnderlineIcon, Highlighter,
  Strikethrough, List, ListOrdered, IndentIncrease, Link2, Code, SquareCode,
  Sparkles, Check, X, Loader2, Paperclip, ImagePlus,
} from 'lucide-react';
import { NX, FONT } from './theme';
import { Avatar } from './components';
import { useImageZoom } from './components';
import AnchoredMenu from '../components/AnchoredMenu';
import { api } from '../api';
import { matchPeople } from '../lib/peopleSearch';
import { useIsMobile } from '../lib/useIsMobile';
import { rootZoom } from '../lib/utils';

// Highlight, as a local mark. @tiptap/extension-highlight would be a new
// dependency for one mark; StarterKit already ships everything else the toolbar
// needs (underline, link, code, code block, lists, strike, history).
const Highlight = Mark.create({
  name: 'highlight',
  parseHTML: () => [{ tag: 'mark' }],
  renderHTML: ({ HTMLAttributes }) => ['mark', mergeAttributes(HTMLAttributes), 0],
  addCommands() {
    return { toggleHighlight: () => ({ commands }) => commands.toggleMark(this.name) };
  },
});

// An empty TipTap document serializes as "<p></p>", not "" - callers comparing
// against '' would otherwise see every untouched description as dirty.
export const isEmptyDoc = (html) => !String(html || '').replace(/<p>\s*<\/p>/g, '').replace(/<[^>]*>/g, '').trim();

// Built per editor rather than shared, so each one can carry its own
// placeholder - a description says "Add more detail…", a ticket's internal note
// has to say it is a note (Sagar, Sept 2 2026). Everything else is identical.
const buildExtensions = (placeholder) => [
  StarterKit.configure({
    link: { openOnClick: false, autolink: true, HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' } },
  }),
  Highlight,
  // allowBase64: a pasted/inserted image with no task to upload to yet (the
  // Create Task form, a ticket reply) is stored inline as a data: URL. The
  // extension's default parse rule SKIPS data: images, so they showed while
  // typing, saved fine, and then vanished from the editor on the next load.
  Image.configure({ inline: false, allowBase64: true, HTMLAttributes: { style: 'max-width:100%;height:auto;border-radius:8px' } }),
  Placeholder.configure({ placeholder }),
];

// `big`: the phone toolbar's 36px touch targets (Oct 2026).
function Btn({ icon: Icon, label, active, disabled, onClick, big = false }) {
  return (
    <button type="button" title={label} aria-label={label} disabled={disabled}
      // onMouseDown-preventDefault keeps the selection alive: a plain onClick
      // blurs the editor first, so the command would apply to nothing.
      onMouseDown={(e) => { e.preventDefault(); if (!disabled) onClick(); }}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: big ? 36 : 28, height: big ? 36 : 28, borderRadius: big ? 8 : 6, border: 'none', flexShrink: 0,
        background: active ? NX.border2 : 'transparent',
        color: disabled ? NX.faint : (active ? NX.ink : NX.dim),
        cursor: disabled ? 'default' : 'pointer',
      }}>
      <Icon size={big ? 18 : 15} />
    </button>
  );
}

const Divider = () => <span style={{ width: 1, height: 18, background: NX.border, flexShrink: 0, margin: '0 2px' }} />;

export default function RichDescription({
  value, onChange, onCommit, autoFocus = false, minHeight = 120,
  // Task attachments. Given a File, the parent stores it and returns
  // { url, name } (or null). Undefined = the "+" menu only offers inline images.
  onAttachFile,
  // People available to @mention. Undefined disables mentions entirely.
  mentionPeople,
  // Ctrl/Cmd+Enter submit (comment composer).
  onSubmit,
  placeholder = 'Add more detail…',
  toolbar = true,
  // false = a picture is NEVER embedded as a base64 data: URL: "Insert
  // image…", paste and the "+" menu all go through onAttachFile (which must
  // upload and return { url, name, kind }), and a failed upload says so
  // instead of falling back to inline data. The ticket reply composer (Oct
  // 2026) - a phone photo inlined as base64 made a multi-MB comment, and the
  // server now refuses one. Default true: Tasks behave exactly as before.
  allowInlineData = true,
  // Told the number of uploads still in flight whenever it changes (0 when
  // they have all landed), so a parent can hold its own Send/Done until the
  // pictures are in the document.
  onUploadingChange,
}) {
  const isMobile = useIsMobile();
  const [addOpen, setAddOpen] = useState(false);
  // Uploads still in flight and the last upload problem - shown only for an
  // editor that uploads (allowInlineData false).
  const [uploading, setUploading] = useState(0);
  const [notice, setNotice] = useState('');
  const uploadingCbRef = useRef(onUploadingChange);
  useEffect(() => { uploadingCbRef.current = onUploadingChange; }, [onUploadingChange]);
  useEffect(() => { uploadingCbRef.current?.(uploading); }, [uploading]);
  // Unmounting mid-upload (e.g. switching drawer tabs) must not leave the
  // parent believing an upload is still running - its Done would stay held
  // forever. The late result has no editor to land in, so report zero.
  useEffect(() => () => { uploadingCbRef.current?.(0); }, []);
  const frameRef = useRef(null);
  const caretRef = useRef(null);
  const [ai, setAi] = useState(null);   // { busy, error, suggestion, original }
  // @mention autocomplete: { query, index, coords } while an @word is being typed.
  const [mention, setMention] = useState(null);
  const addRef = useRef(null);
  const fileRef = useRef(null);
  const imageRef = useRef(null);
  // Double-click, not click: a single click on an image in the editor selects
  // it (to delete or move it), which must keep working.
  const [zoomImage, zoomViewer] = useImageZoom();
  // handlePaste is captured once when the editor is created, so it can't close
  // over `attach` directly - that would freeze the first render's callback.
  const pasteRef = useRef(() => {});
  // Same reason as pasteRef: editorProps/onUpdate are captured once at creation.
  const mentionScanRef = useRef(() => {});
  const mentionKeyRef = useRef(() => false);
  const submitRef = useRef(null);

  const editor = useEditor({
    // eslint-disable-next-line react-hooks/exhaustive-deps
    extensions: useMemo(() => buildExtensions(placeholder), [placeholder]),
    content: value || '',
    autofocus: autoFocus,
    onUpdate: ({ editor: ed }) => { onChange?.(ed.getHTML()); mentionScanRef.current(ed); },
    onBlur: ({ editor: ed }) => onCommit?.(ed.getHTML()),
    editorProps: {
      handleKeyDown: (_view, event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && submitRef.current) {
          event.preventDefault(); submitRef.current(); return true;
        }
        return mentionKeyRef.current(event);
      },
      // Ctrl+V of a screenshot embeds it (and attaches it to the task when the
      // parent supports that) - the module-wide clipboard rule from CLAUDE.md.
      // Returning false for everything else leaves TipTap's normal HTML/text
      // paste handling alone.
      handlePaste: (_view, event) => {
        const files = [...(event.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
        if (!files.length) return false;
        event.preventDefault();
        // One after another, so several pasted images keep their order.
        (async () => { for (const f of files) await pasteRef.current(f); })();
        return true;
      },
    },
  });

  // Re-sync when the task changes under us (drawer switching tasks, or a pull
  // landing new content). Guarded on equality so it doesn't stomp typing.
  useEffect(() => {
    // isDestroyed, not just truthiness. TipTap tears the schema down on destroy,
    // so getHTML() on a dead editor throws "Cannot read properties of null
    // (reading 'cached')" - which took out the whole view through
    // ViewErrorBoundary. React's StrictMode remount runs this effect again after
    // the cleanup has already destroyed it, so the window is not hypothetical:
    // it is every mount in development.
    if (!editor || editor.isDestroyed) return;
    const next = value || '';
    if (next !== editor.getHTML()) editor.commands.setContent(next, { emitUpdate: false });
  }, [value, editor]);

  // Inserted AFTER the current selection, never over it. An image that has
  // just been inserted is left selected (a node selection), and setImage /
  // insertContent replace a selection - so picking two pictures used to put the
  // second one in place of the first, leaving only one.
  const insertAfterSelection = useCallback((content) => {
    if (!editor || editor.isDestroyed) return;   // the read/upload outlived the editor
    editor.chain().focus().insertContentAt(editor.state.selection.to, content).run();
  }, [editor]);
  const placeImage = useCallback((src) => insertAfterSelection({ type: 'image', attrs: { src } }), [insertAfterSelection]);

  const readInline = useCallback(async (file) => {
    const src = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });
    if (src) placeImage(src);
  }, [placeImage]);

  // allowInlineData false: upload, then embed by URL - never base64.
  const uploadAndPlace = useCallback(async (file) => {
    if (!onAttachFile) { setNotice("Pictures and files can't be added here."); return; }
    setNotice('');
    setUploading((n) => n + 1);
    let saved = null;
    let why = '';
    try { saved = await onAttachFile(file); } catch (e) { why = e?.message || ''; }
    finally { setUploading((n) => Math.max(0, n - 1)); }
    if (!editor || editor.isDestroyed) return;   // the upload outlived the editor
    if (!saved?.url) {
      setNotice(`"${file.name}" couldn't be uploaded${why ? `: ${why}` : ''}. Nothing was added - try again.`);
      return;
    }
    // The parent says what it stored: a HEIC this browser could not convert
    // is a download (a link), not a picture that would show as broken.
    const isImg = saved.kind ? saved.kind === 'image' : file.type.startsWith('image/');
    if (isImg) placeImage(saved.url);
    else insertAfterSelection([
      { type: 'text', marks: [{ type: 'link', attrs: { href: saved.url } }], text: saved.name || file.name },
      { type: 'text', text: ' ' },
    ]);
  }, [editor, onAttachFile, placeImage, insertAfterSelection]);

  const insertImage = useCallback((file) => (allowInlineData ? readInline(file) : uploadAndPlace(file)),
    [allowInlineData, readInline, uploadAndPlace]);

  const attach = useCallback(async (file) => {
    if (!allowInlineData) { await uploadAndPlace(file); return; }
    // Asana parity: the file lands on the task AND, when it's an image, embeds
    // inline where the cursor is.
    const saved = await onAttachFile?.(file).catch(() => null);
    if (!editor || editor.isDestroyed) return;   // the upload outlived the editor
    if (file.type.startsWith('image/')) {
      if (saved?.url) placeImage(saved.url);
      else await readInline(file);
    } else if (saved?.url) {
      insertAfterSelection(`<a href="${saved.url}">${saved.name || file.name}</a> `);
    }
  }, [editor, allowInlineData, uploadAndPlace, readInline, placeImage, insertAfterSelection, onAttachFile]);

  // A mention is a mailto link, not a custom node: it reuses the Link mark (no extra
  // TipTap package) and degrades to a working mailto anywhere the HTML is rendered
  // plainly, including notification email. The backend scans those hrefs
  // (routers/tasks.py extract_mentions).
  const people = useMemo(() => mentionPeople || [], [mentionPeople]);
  const matches = useMemo(() => {
    if (!mention) return [];
    return matchPeople(people, mention.query, { limit: 6 });
  }, [mention, people]);

  const scanForMention = useCallback((ed) => {
    if (!mentionPeople) return;
    const { state } = ed;
    const { from, empty } = state.selection;
    if (!empty) { setMention(null); return; }
    // Text of the current block up to the cursor.
    const before = state.doc.textBetween(Math.max(0, from - 60), from, '\n', '\ufffc');
    const m = /(^|[\s(])@([\w.\-']*)$/.exec(before);
    if (!m) { setMention(null); return; }
    // Phone: where the "@" is, relative to the editor frame - the popup is
    // anchored there (AnchoredMenu), so it can flip above the line when the
    // on-screen keyboard leaves no room below. The "@", not the caret: it
    // stays put while the name is typed, and AnchoredMenu only places itself
    // when it opens (the menu is re-keyed below if the "@" itself moves).
    const at = from - m[2].length - 1;
    let caret = null;
    if (isMobile && frameRef.current) {
      try {
        const c = ed.view.coordsAtPos(at);
        const r = frameRef.current.getBoundingClientRect();
        const z = rootZoom();
        caret = { left: (c.left - r.left) / z, top: (c.top - r.top) / z, height: Math.max(16, (c.bottom - c.top) / z) };
      } catch {
        caret = { left: 12, top: 10, height: 18 };
      }
    }
    setMention((prev) => ({ query: m[2], from: at, index: prev ? prev.index : 0, caret }));
  }, [mentionPeople, isMobile]);

  useEffect(() => { mentionScanRef.current = scanForMention; }, [scanForMention]);
  useEffect(() => { submitRef.current = onSubmit || null; }, [onSubmit]);
  // Declared before the key handler below, which calls it - a `const` isn't
  // hoisted, so referencing it from an effect defined above throws.
  const insertMention = useCallback((person) => {
    if (!editor || !mention || !person) return;
    editor.chain().focus()
      .deleteRange({ from: mention.from, to: editor.state.selection.from })
      .insertContent([
        { type: 'text', marks: [{ type: 'link', attrs: { href: `mailto:${person.email}` } }],
          text: `@${person.name}` },
        { type: 'text', text: ' ' },
      ])
      // Otherwise the link mark keeps applying to whatever is typed next.
      .unsetMark('link')
      .run();
    setMention(null);
    onChange?.(editor.getHTML());
  }, [editor, mention, onChange]);

  useEffect(() => {
    mentionKeyRef.current = (event) => {
      if (!mention || matches.length === 0) return false;
      if (event.key === 'ArrowDown') { event.preventDefault(); setMention((m) => ({ ...m, index: (m.index + 1) % matches.length })); return true; }
      if (event.key === 'ArrowUp') { event.preventDefault(); setMention((m) => ({ ...m, index: (m.index - 1 + matches.length) % matches.length })); return true; }
      if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); insertMention(matches[mention.index] || matches[0]); return true; }
      if (event.key === 'Escape') { setMention(null); return true; }
      return false;
    };
  }, [mention, matches, insertMention]);

  // Keep the paste hook pointing at the current `attach`.
  useEffect(() => { pasteRef.current = (f) => (onAttachFile ? attach(f) : insertImage(f)); }, [attach, insertImage, onAttachFile]);

  const setLink = useCallback(() => {
    const prev = editor?.getAttributes('link')?.href || '';
    const url = window.prompt('Link URL', prev);
    if (url === null) return;
    if (!url.trim()) { editor?.chain().focus().extendMarkRange('link').unsetLink().run(); return; }
    const href = /^(https?:|mailto:|\/)/i.test(url.trim()) ? url.trim() : `https://${url.trim()}`;
    editor?.chain().focus().extendMarkRange('link').setLink({ href }).run();
  }, [editor]);

  // Rephrase the plain text, show it beside the original, and only replace the
  // document if the user accepts. Nothing is overwritten optimistically.
  const rephrase = useCallback(async () => {
    if (!editor) return;
    const original = editor.getText().trim();
    if (!original) { setAi({ error: 'Write something first.' }); return; }
    setAi({ busy: true, original });
    try {
      const res = await api.taskAiRephrase({ text: original });
      setAi({ suggestion: res.text, original });
    } catch (e) {
      setAi({ error: e.message || 'Could not rephrase that.' });
    }
  }, [editor]);

  const acceptAi = useCallback(() => {
    const text = ai?.suggestion || '';
    const html = text.split(/\n{2,}/).map((p) =>
      `<p>${p.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])).replace(/\n/g, '<br>')}</p>`).join('');
    editor?.chain().focus().setContent(html).run();
    onChange?.(editor?.getHTML());
    onCommit?.(editor?.getHTML());
    setAi(null);
  }, [ai, editor, onChange, onCommit]);

  // Phone: 16px in the editable area. iOS Safari zooms the page into any
  // focused editable under 16px (contenteditable included - style.css's 16px
  // phone rule covers only inputs), and that zoom also shifts the visual
  // viewport the mention popup is placed against. Desktop keeps style.css's
  // 13.5px.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const dom = editor.view?.dom;
    if (!dom) return;
    if (isMobile) dom.style.setProperty('font-size', '16px');
    else dom.style.removeProperty('font-size');
  }, [editor, isMobile]);

  const can = useMemo(() => editor?.can().chain().focus(), [editor]);
  if (!editor) return null;

  const wrap = { border: `1px solid ${NX.border}`, borderRadius: 10, background: NX.surface, fontFamily: FONT };

  return (
    <div style={wrap}>
      <div ref={frameRef} className="nx-rich" style={{ padding: '10px 12px', minHeight, cursor: 'text', position: 'relative' }}
        onClick={() => editor.chain().focus().run()} onDoubleClick={zoomImage}>
        <EditorContent editor={editor} />
        {zoomViewer}
        {isMobile && mention && (
          // Phone (Oct 2026): the list hangs off the caret through
          // AnchoredMenu - portaled (the drawer body clips), flipped above
          // the line when the keyboard leaves no room below (it measures the
          // visualViewport), with rows big enough to tap. The absolute list
          // below opened under the editor, i.e. behind the keyboard.
          <span ref={caretRef} aria-hidden="true" style={{ position: 'absolute', left: mention.caret?.left ?? 12, top: mention.caret?.top ?? 10,
            width: 1, height: mention.caret?.height ?? 18, pointerEvents: 'none' }} />
        )}
        <AnchoredMenu key={mention?.caret ? `${Math.round(mention.caret.left)}:${Math.round(mention.caret.top)}` : 'at'}
          anchorRef={caretRef} open={!!(isMobile && mention && matches.length > 0)} onClose={() => setMention(null)}
          role="listbox" aria-label="Mention someone"
          style={{ minWidth: 240, maxWidth: 320, maxHeight: 260, background: NX.surface, border: `1px solid ${NX.border}`,
                   borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,0.16)', padding: 4 }}>
          {matches.map((p, i) => (
            <button key={p.email} type="button" role="option" aria-selected={i === mention?.index}
              // mousedown keeps the editor focused (and the keyboard up);
              // click does the insert.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => insertMention(p)}
              style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', minHeight: 44, padding: '6px 10px', borderRadius: 8,
                       border: 'none', cursor: 'pointer', fontSize: 14, fontFamily: FONT, color: NX.ink, textAlign: 'left',
                       background: i === mention?.index ? NX.hover : 'transparent' }}>
              <Avatar email={p.email} name={p.name} size={26} />
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
            </button>
          ))}
        </AnchoredMenu>
        {!isMobile && mention && matches.length > 0 && (
          <div style={{ position: 'absolute', left: 8, bottom: -6, transform: 'translateY(100%)', zIndex: 70,
                        minWidth: 240, background: NX.surface, border: `1px solid ${NX.border}`,
                        borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,0.16)', padding: 4 }}>
            {matches.map((p, i) => (
              <div key={p.email} onMouseDown={(e) => { e.preventDefault(); insertMention(p); }}
                onMouseEnter={() => setMention((m) => ({ ...m, index: i }))}
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 6,
                         cursor: 'pointer', fontSize: 13,
                         background: i === mention.index ? NX.hover : 'transparent' }}>
                <Avatar email={p.email} name={p.name} size={22} />
                <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {ai?.suggestion && (
        <div style={{ borderTop: `1px solid ${NX.border2}`, padding: '10px 12px', background: NX.hover }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, fontWeight: 700, color: NX.purple, marginBottom: 6 }}>
            <Sparkles size={13} />Suggested rewrite
          </div>
          <div style={{ fontSize: 13, color: NX.ink, whiteSpace: 'pre-wrap', marginBottom: 8 }}>{ai.suggestion}</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button type="button" onClick={acceptAi}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 10px', borderRadius: 7, border: 'none', background: NX.primary, color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: FONT }}>
              <Check size={13} />Use this
            </button>
            <button type="button" onClick={() => setAi(null)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 10px', borderRadius: 7, border: `1px solid ${NX.border}`, background: 'transparent', color: NX.dim, fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: FONT }}>
              <X size={13} />Discard
            </button>
          </div>
        </div>
      )}
      {ai?.error && (
        <div style={{ borderTop: `1px solid ${NX.border2}`, padding: '7px 12px', fontSize: 12, color: NX.red }}>{ai.error}</div>
      )}
      {!allowInlineData && uploading > 0 && (
        <div role="status" style={{ borderTop: `1px solid ${NX.border2}`, padding: '7px 12px', fontSize: 12, color: NX.dim, display: 'flex', alignItems: 'center', gap: 6 }}>
          <Loader2 size={13} className="spin" />Uploading {uploading}…
        </div>
      )}
      {notice && (
        <div role="alert" style={{ borderTop: `1px solid ${NX.border2}`, padding: '4px 4px 4px 12px', fontSize: 12, color: NX.red, display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ flex: 1, minWidth: 0 }}>{notice}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setNotice('')}
            style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: isMobile ? 36 : 26, height: isMobile ? 36 : 26, border: 'none', background: 'transparent', color: NX.red, cursor: 'pointer', flexShrink: 0 }}>
            <X size={13} />
          </button>
        </div>
      )}

      {toolbar && (
      <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? 2 : 1, flexWrap: isMobile ? 'nowrap' : 'wrap', padding: isMobile ? '3px 6px' : '5px 8px', borderTop: `1px solid ${NX.border2}` }}>
        <span ref={addRef} style={{ display: 'inline-flex' }}>
          <Btn icon={Plus} label="Attach" big={isMobile} active={addOpen} onClick={() => setAddOpen((o) => !o)} />
          {/* Portaled: the editor frame and the modal/drawer body around it
              both clip, and the toolbar sits at the frame's bottom edge. */}
          <AnchoredMenu anchorRef={addRef} open={addOpen} onClose={() => setAddOpen(false)}
            style={{ width: isMobile ? 210 : 190, background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,0.16)', padding: 4 }}>
            {onAttachFile && (
              <button type="button" onClick={() => { setAddOpen(false); fileRef.current?.click(); }}
                style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '7px 8px', border: 'none', background: 'transparent', borderRadius: 6, cursor: 'pointer', fontSize: 13, color: NX.ink, fontFamily: FONT, textAlign: 'left', ...(isMobile ? { minHeight: 44, fontSize: 14 } : null) }}>
                <Paperclip size={14} style={{ color: NX.dim }} />Attach file…
              </button>
            )}
            <button type="button" onClick={() => { setAddOpen(false); imageRef.current?.click(); }}
              style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '7px 8px', border: 'none', background: 'transparent', borderRadius: 6, cursor: 'pointer', fontSize: 13, color: NX.ink, fontFamily: FONT, textAlign: 'left', ...(isMobile ? { minHeight: 44, fontSize: 14 } : null) }}>
              <ImagePlus size={14} style={{ color: NX.dim }} />Insert image…
            </button>
            {/* No clipboard shortcut on a phone. */}
            {!isMobile && <div style={{ padding: '4px 8px 2px', fontSize: 11, color: NX.faint }}>or press Ctrl+V to paste</div>}
          </AnchoredMenu>
        </span>
        {/* `multiple`: a batch of photos is picked in one go. Uploaded one after
            another (not in parallel) so they land in the order they were picked. */}
        <input ref={fileRef} type="file" multiple style={{ display: 'none' }}
          onChange={async (e) => { const fs = [...(e.target.files || [])]; e.target.value = ''; for (const f of fs) await attach(f); }} />
        <input ref={imageRef} type="file" accept="image/*" multiple style={{ display: 'none' }}
          onChange={async (e) => { const fs = [...(e.target.files || [])]; e.target.value = ''; for (const f of fs) await insertImage(f); }} />

        {isMobile ? (<>
          {/* Phone (Oct 2026): the six that matter, at 36px, on one row - the
              full set wrapped to three rows of 28px targets above the
              keyboard. Desktop keeps the full toolbar below. */}
          <Btn big icon={Bold} label="Bold" active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()} />
          <Btn big icon={Italic} label="Italic" active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()} />
          <Btn big icon={List} label="Bulleted list" active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()} />
          <Btn big icon={ListOrdered} label="Numbered list" active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()} />
          <Btn big icon={Link2} label="Link" active={editor.isActive('link')} onClick={setLink} />
        </>) : (<>
        <Divider />
        <Btn icon={Undo2} label="Undo" disabled={!can?.undo().run} onClick={() => editor.chain().focus().undo().run()} />
        <Btn icon={Redo2} label="Redo" onClick={() => editor.chain().focus().redo().run()} />
        <Divider />
        <Btn icon={Bold} label="Bold" active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()} />
        <Btn icon={Italic} label="Italic" active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()} />
        <Btn icon={UnderlineIcon} label="Underline" active={editor.isActive('underline')} onClick={() => editor.chain().focus().toggleUnderline().run()} />
        <Btn icon={Highlighter} label="Highlight" active={editor.isActive('highlight')} onClick={() => editor.chain().focus().toggleHighlight().run()} />
        <Btn icon={Strikethrough} label="Strikethrough" active={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()} />
        <Divider />
        <Btn icon={List} label="Bulleted list" active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()} />
        <Btn icon={ListOrdered} label="Numbered list" active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()} />
        <Btn icon={IndentIncrease} label="Indent list item" onClick={() => editor.chain().focus().sinkListItem('listItem').run()} />
        <Divider />
        <Btn icon={Link2} label="Link" active={editor.isActive('link')} onClick={setLink} />
        <Btn icon={Code} label="Inline code" active={editor.isActive('code')} onClick={() => editor.chain().focus().toggleCode().run()} />
        <Btn icon={SquareCode} label="Code block" active={editor.isActive('codeBlock')} onClick={() => editor.chain().focus().toggleCodeBlock().run()} />
        <Divider />
        <Btn icon={ai?.busy ? Loader2 : Sparkles} label="Rephrase with AI" disabled={ai?.busy} onClick={rephrase} />
        </>)}
      </div>
      )}
    </div>
  );
}

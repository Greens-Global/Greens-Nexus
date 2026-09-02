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
import { useClickOutside } from './components';
import { api } from '../api';
import { matchPeople } from '../lib/peopleSearch';

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
  Image.configure({ inline: false, HTMLAttributes: { style: 'max-width:100%;height:auto;border-radius:8px' } }),
  Placeholder.configure({ placeholder }),
];

function Btn({ icon: Icon, label, active, disabled, onClick }) {
  return (
    <button type="button" title={label} aria-label={label} disabled={disabled}
      // onMouseDown-preventDefault keeps the selection alive: a plain onClick
      // blurs the editor first, so the command would apply to nothing.
      onMouseDown={(e) => { e.preventDefault(); if (!disabled) onClick(); }}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 28, height: 28, borderRadius: 6, border: 'none', flexShrink: 0,
        background: active ? NX.border2 : 'transparent',
        color: disabled ? NX.faint : (active ? NX.ink : NX.dim),
        cursor: disabled ? 'default' : 'pointer',
      }}>
      <Icon size={15} />
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
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [ai, setAi] = useState(null);   // { busy, error, suggestion, original }
  // @mention autocomplete: { query, index, coords } while an @word is being typed.
  const [mention, setMention] = useState(null);
  const addRef = useRef(null);
  const addPanelRef = useRef(null);
  const fileRef = useRef(null);
  const imageRef = useRef(null);
  // handlePaste is captured once when the editor is created, so it can't close
  // over `attach` directly - that would freeze the first render's callback.
  const pasteRef = useRef(() => {});
  // Same reason as pasteRef: editorProps/onUpdate are captured once at creation.
  const mentionScanRef = useRef(() => {});
  const mentionKeyRef = useRef(() => false);
  const submitRef = useRef(null);
  useClickOutside([addRef, addPanelRef], () => setAddOpen(false), addOpen);

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
        files.forEach((f) => pasteRef.current(f));
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

  const insertImage = useCallback((file) => {
    const reader = new FileReader();
    // Fires after the read completes, which can be after the modal closed.
    reader.onload = () => {
      if (!editor || editor.isDestroyed) return;
      editor.chain().focus().setImage({ src: String(reader.result) }).run();
    };
    reader.readAsDataURL(file);
  }, [editor]);

  const attach = useCallback(async (file) => {
    // Asana parity: the file lands on the task AND, when it's an image, embeds
    // inline where the cursor is.
    const saved = await onAttachFile?.(file).catch(() => null);
    if (!editor || editor.isDestroyed) return;   // the upload outlived the editor
    if (file.type.startsWith('image/')) {
      if (saved?.url) editor?.chain().focus().setImage({ src: saved.url }).run();
      else insertImage(file);
    } else if (saved?.url) {
      editor?.chain().focus().extendMarkRange('link')
        .insertContent(`<a href="${saved.url}">${saved.name || file.name}</a>`).run();
    }
  }, [editor, insertImage, onAttachFile]);

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
    setMention((prev) => ({ query: m[2], from: from - m[2].length - 1, index: prev ? prev.index : 0 }));
  }, [mentionPeople]);

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

  const can = useMemo(() => editor?.can().chain().focus(), [editor]);
  if (!editor) return null;

  const wrap = { border: `1px solid ${NX.border}`, borderRadius: 10, background: NX.surface, fontFamily: FONT };

  return (
    <div style={wrap}>
      <div className="nx-rich" style={{ padding: '10px 12px', minHeight, cursor: 'text', position: 'relative' }}
        onClick={() => editor.chain().focus().run()}>
        <EditorContent editor={editor} />
        {mention && matches.length > 0 && (
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

      {toolbar && (
      <div style={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', padding: '5px 8px', borderTop: `1px solid ${NX.border2}` }}>
        <span ref={addRef} style={{ position: 'relative', display: 'inline-flex' }}>
          <Btn icon={Plus} label="Attach" active={addOpen} onClick={() => setAddOpen((o) => !o)} />
          {addOpen && (
            <div ref={addPanelRef} style={{ position: 'absolute', bottom: '100%', left: 0, marginBottom: 6, width: 190, zIndex: 60, background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,0.16)', padding: 4 }}>
              {onAttachFile && (
                <button type="button" onClick={() => { setAddOpen(false); fileRef.current?.click(); }}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '7px 8px', border: 'none', background: 'transparent', borderRadius: 6, cursor: 'pointer', fontSize: 13, color: NX.ink, fontFamily: FONT, textAlign: 'left' }}>
                  <Paperclip size={14} style={{ color: NX.dim }} />Attach file…
                </button>
              )}
              <button type="button" onClick={() => { setAddOpen(false); imageRef.current?.click(); }}
                style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '7px 8px', border: 'none', background: 'transparent', borderRadius: 6, cursor: 'pointer', fontSize: 13, color: NX.ink, fontFamily: FONT, textAlign: 'left' }}>
                <ImagePlus size={14} style={{ color: NX.dim }} />Insert image…
              </button>
              <div style={{ padding: '4px 8px 2px', fontSize: 11, color: NX.faint }}>or press Ctrl+V to paste</div>
            </div>
          )}
        </span>
        <input ref={fileRef} type="file" style={{ display: 'none' }}
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) attach(f); }} />
        <input ref={imageRef} type="file" accept="image/*" style={{ display: 'none' }}
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) insertImage(f); }} />

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
      </div>
      )}
    </div>
  );
}

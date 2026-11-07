// Callouts and toggles (Neil, 11/07/2026): two container blocks for the Notes
// editor, from the toolbar, the phone bar's Aa row and the "/" menu.
//
//   Callout - <div data-type="callout" data-tone="info|tip|warning">blocks</div>
//             a tinted box with an icon; Note, Tip and Warning.
//   Toggle  - <div data-type="toggle" data-summary="Title" data-open="true|false">blocks</div>
//             a collapsible section: its title is typed in the header, the
//             chevron folds the body. An editor's fold is saved (a section
//             can ship folded); a reader's fold is theirs alone.
//
// The server's sanitizer (routers/notes.py _NoteSanitizer) keeps exactly these
// attributes on exactly these two <div>s; every value is checked again on the
// way out (renderHTML), as noteExtensions.js does for live co-typing.
//
// Enter on an empty last line inside one steps out of it (like a list), and
// Backspace at the start of an empty one-line block unwraps it.
import { useState } from 'react';
import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewWrapper, NodeViewContent, ReactNodeViewRenderer } from '@tiptap/react';
import { Info, Lightbulb, TriangleAlert, ChevronRight } from 'lucide-react';
import { EDITED } from './noteMedia';

export const TONES = ['info', 'tip', 'warning'];
const safeTone = (v) => (TONES.includes(v) ? v : 'info');
const safeSummary = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').slice(0, 200) : '');
const TONE_ICON = { info: Info, tip: Lightbulb, warning: TriangleAlert };
export const TONE_LABEL = { info: 'Note', tip: 'Tip', warning: 'Warning' };

// Enter on an empty paragraph that is the last child of the container: out of it.
// Backspace at the start of the container's only, empty paragraph: unwrap it.
function exitKeys(name) {
  return {
    Enter: ({ editor }) => {
      const { $from, empty } = editor.state.selection;
      if (!empty || $from.parent.type.name !== 'paragraph' || $from.parent.content.size) return false;
      if ($from.depth < 2 || $from.node(-1).type.name !== name) return false;
      if ($from.index(-1) !== $from.node(-1).childCount - 1 || $from.node(-1).childCount < 2) return false;
      return editor.chain().lift('paragraph').run();
    },
    Backspace: ({ editor }) => {
      const { $from, empty } = editor.state.selection;
      if (!empty || $from.parentOffset !== 0 || $from.depth < 2 || $from.node(-1).type.name !== name) return false;
      if ($from.index(-1) !== 0 || $from.parent.content.size) return false;
      return editor.chain().lift('paragraph').run();
    },
  };
}

function CalloutView({ node }) {
  const tone = safeTone(node.attrs.tone);
  const Icon = TONE_ICON[tone];
  return (
    <NodeViewWrapper className="nt-callout" data-tone={tone}>
      <span className="nt-callout-icon" contentEditable={false} aria-label={TONE_LABEL[tone]} role="img"><Icon size={16} strokeWidth={2} /></span>
      <NodeViewContent className="nt-callout-body" />
    </NodeViewWrapper>
  );
}

export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes() {
    return {
      tone: { default: 'info', parseHTML: (el) => safeTone(el.getAttribute('data-tone')), renderHTML: (a) => ({ 'data-tone': safeTone(a.tone) }) },
    };
  },
  parseHTML() { return [{ tag: 'div[data-type="callout"]' }]; },
  renderHTML({ HTMLAttributes }) { return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'callout' }), 0]; },
  addCommands() {
    return {
      setCallout: (tone) => ({ commands }) => commands.wrapIn(this.name, { tone: safeTone(tone) }),
    };
  },
  addKeyboardShortcuts() { return exitKeys(this.name); },
  addNodeView() { return ReactNodeViewRenderer(CalloutView); },
});

function ToggleView({ node, editor, getPos }) {
  const summary = safeSummary(node.attrs.summary);
  const savedOpen = node.attrs.open !== false;
  const [readerOpen, setReaderOpen] = useState(null);   // a reader's own fold, never saved
  const editable = editor.isEditable;
  const open = editable ? savedOpen : (readerOpen ?? savedOpen);
  // An editor's change is a real edit of the note: it carries EDITED so it saves.
  const setAttr = (patch) => {
    const pos = getPos();
    if (typeof pos !== 'number') return;
    editor.chain().command(({ tr }) => {
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...patch });
      tr.setMeta(EDITED, true);
      return true;
    }).run();
  };
  const flip = () => (editable ? setAttr({ open: !open }) : setReaderOpen(!open));
  return (
    <NodeViewWrapper className={`nt-toggle${open ? ' is-open' : ''}`}>
      <div className="nt-toggle-head" contentEditable={false}>
        <button type="button" className="nt-toggle-chev" aria-expanded={open} onClick={flip}
          aria-label={open ? `Fold ${summary || 'this section'}` : `Unfold ${summary || 'this section'}`}>
          <ChevronRight size={15} strokeWidth={2.2} aria-hidden="true" />
        </button>
        {editable
          ? <input className="nt-toggle-title" value={summary} placeholder="Toggle title" aria-label="Toggle title" maxLength={200}
              onChange={(e) => setAttr({ summary: safeSummary(e.target.value) })} />
          : <button type="button" className="nt-toggle-title is-read" onClick={flip}>{summary || 'Untitled Section'}</button>}
      </div>
      <NodeViewContent className="nt-toggle-body" hidden={!open} />
    </NodeViewWrapper>
  );
}

export const Toggle = Node.create({
  name: 'toggle',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes() {
    return {
      summary: { default: '', parseHTML: (el) => safeSummary(el.getAttribute('data-summary') || ''), renderHTML: (a) => (safeSummary(a.summary) ? { 'data-summary': safeSummary(a.summary) } : {}) },
      open: { default: true, parseHTML: (el) => el.getAttribute('data-open') !== 'false', renderHTML: (a) => ({ 'data-open': a.open === false ? 'false' : 'true' }) },
    };
  },
  parseHTML() { return [{ tag: 'div[data-type="toggle"]' }]; },
  renderHTML({ HTMLAttributes }) { return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'toggle' }), 0]; },
  addCommands() {
    return {
      setToggle: () => ({ commands }) => commands.wrapIn(this.name, { summary: '', open: true }),
    };
  },
  addKeyboardShortcuts() { return exitKeys(this.name); },
  // Typing in the title box is the input's own business, not the editor's.
  addNodeView() {
    return ReactNodeViewRenderer(ToggleView, {
      stopEvent: ({ event }) => event.target instanceof HTMLElement && !!event.target.closest('.nt-toggle-head'),
    });
  },
});

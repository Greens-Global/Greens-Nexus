// A board inside a note (Insert Board / Mark Up, 11/02/2026): a TipTap node
// that shows the board's thumbnail and title and opens the board on click.
// It is saved as
//   <a data-type="boardEmbed" data-note="note_x" data-thumb="<our storage>" title="T">T</a>
// so the server's sanitizer (routers/notes.py _NoteSanitizer) keeps exactly
// those attributes, a note exported or shown as plain HTML still reads as a
// link to the board, and nothing but a note id and our own picture URL can
// ride along (data-thumb outside our storage is dropped on both sides).
import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import { PenTool, X } from 'lucide-react';
import { isOwnImageUrl } from '../../lib/storageView';
import { openBoard } from '../newBoard';
import { EDITED } from '../noteMedia';

export const NOTE_REF = /^note_[A-Za-z0-9]{1,64}$/;
const safeId = (v) => (typeof v === 'string' && NOTE_REF.test(v) ? v : '');
const safeThumb = (v) => (typeof v === 'string' && isOwnImageUrl(v) && !/^data:/i.test(v) ? v : '');
const safeTitle = (v) => (typeof v === 'string' ? v.slice(0, 200) : '');

function EmbedView({ node, editor, getPos }) {
  const noteId = safeId(node.attrs.noteId);
  const thumb = safeThumb(node.attrs.thumbUrl);
  const title = safeTitle(node.attrs.title) || 'Untitled Board';
  const remove = () => {
    const pos = getPos();
    if (typeof pos !== 'number') return;
    editor.chain().setMeta(EDITED, true).deleteRange({ from: pos, to: pos + node.nodeSize }).run();
  };
  return (
    <NodeViewWrapper className="nt-board-embed" contentEditable={false} data-drag-handle="">
      <button type="button" className="nt-board-embed-open" onClick={() => noteId && openBoard(noteId)} disabled={!noteId}
        title={`Open the board "${title}"`} aria-label={`Open the board ${title}`}>
        {thumb
          ? <img className="nt-board-embed-thumb" src={thumb} alt="" loading="lazy" />
          : <span className="nt-board-embed-thumb is-empty" aria-hidden="true"><PenTool size={18} /></span>}
        <span className="nt-board-embed-text">
          <span className="nt-board-embed-kicker">Board</span>
          <span className="nt-board-embed-title">{title}</span>
        </span>
      </button>
      {editor.isEditable && (
        <button type="button" className="nt-media-x" aria-label="Remove Board" title="Remove Board" onClick={remove}>
          <X size={14} aria-hidden="true" />
        </button>
      )}
    </NodeViewWrapper>
  );
}

export const BoardEmbed = Node.create({
  name: 'boardEmbed',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes() {
    return {
      noteId: { default: '', parseHTML: (el) => safeId(el.getAttribute('data-note') || ''), renderHTML: (a) => ({ 'data-note': safeId(a.noteId) }) },
      title: { default: '', parseHTML: (el) => safeTitle(el.getAttribute('title') || el.textContent || ''), renderHTML: (a) => ({ title: safeTitle(a.title) }) },
      thumbUrl: { default: '', parseHTML: (el) => safeThumb(el.getAttribute('data-thumb') || ''), renderHTML: (a) => (safeThumb(a.thumbUrl) ? { 'data-thumb': safeThumb(a.thumbUrl) } : {}) },
    };
  },
  parseHTML() { return [{ tag: 'a[data-type="boardEmbed"]' }]; },
  renderHTML({ node, HTMLAttributes }) {
    return ['a', mergeAttributes(HTMLAttributes, { 'data-type': 'boardEmbed' }), safeTitle(node.attrs.title) || 'Untitled Board'];
  },
  addCommands() {
    return {
      insertBoard: (attrs) => ({ chain }) => chain().insertContent({ type: this.name, attrs: { noteId: safeId(attrs?.noteId), title: safeTitle(attrs?.title), thumbUrl: safeThumb(attrs?.thumbUrl) } }).run(),
    };
  },
  addNodeView() { return ReactNodeViewRenderer(EmbedView); },
});

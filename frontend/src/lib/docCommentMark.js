// The anchor of a comment on a Documents page (Review tab, Nov 2026).
//
// A comment's WORDS live on the server (routers/doc_comments.py); the page
// keeps only this mark, carrying the comment id, over the text it was made
// on - so the text can be retyped around it and the thread still points at
// something, and an export ignores it (doc_export.py reads named marks only).
import { Mark, mergeAttributes } from '@tiptap/core';

export const CommentMark = Mark.create({
  name: 'comment',
  // Not inclusive: typing at the end of a commented span is plain text.
  inclusive: false,
  excludes: '',

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-comment-id'),
        renderHTML: (attrs) => (attrs.id ? { 'data-comment-id': attrs.id } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-comment-id]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes({ class: 'doc-comment-mark' }, HTMLAttributes), 0];
  },

  addCommands() {
    return {
      setComment: (id) => ({ commands }) => commands.setMark(this.name, { id }),
      unsetComment: (id) => ({ tr, state, dispatch }) => {
        // Only the span(s) carrying THIS id, wherever they are.
        const type = state.schema.marks[this.name];
        state.doc.descendants((node, pos) => {
          if (!node.isText) return;
          const mark = node.marks.find((m) => m.type === type && m.attrs.id === id);
          if (mark && dispatch) tr.removeMark(pos, pos + node.nodeSize, mark);
        });
        return true;
      },
    };
  },
});

/** The DOM span a comment id is anchored to, if the text still exists. */
export function commentAnchorEl(root, id) {
  return root?.querySelector?.(`[data-comment-id="${CSS.escape(String(id))}"]`) || null;
}

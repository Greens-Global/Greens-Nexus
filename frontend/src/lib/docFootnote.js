// Word's footnotes (Neil, 11/11/2026: "Make sure it's fully word
// compatible"). A footnote is an inline `footnote` node carrying the note's
// words; it shows as its number (the builder numbers every note across the
// pages, in order) with the words on hover. References > Insert Footnote
// (Ctrl+Alt+F) adds one; a click on the number edits it, an empty note
// removes it. Word gets real footnotes (doc_export._docx_add_footnotes), the
// PDF numbered notes after the text, and a Word file's footnotes and
// endnotes come in as these (lib/docxToTiptap.js).
import { Node, mergeAttributes } from '@tiptap/core';

export const Footnote = Node.create({
  name: 'footnote',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      text: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-footnote') || '',
        renderHTML: (attrs) => ({ 'data-footnote': attrs.text || '' }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'sup[data-footnote]', priority: 100 }];   // before the Superscript mark's <sup>
  },

  renderHTML({ HTMLAttributes }) {
    return ['sup', mergeAttributes(HTMLAttributes, { class: 'doc-footnote', title: HTMLAttributes['data-footnote'] || '' }), '*'];
  },

  renderText() { return ''; },

  // The number is the builder's to write (it counts across pages), so the
  // view ignores its own text changing.
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('sup');
      dom.className = 'doc-footnote';
      dom.contentEditable = 'false';
      dom.setAttribute('data-footnote', node.attrs.text || '');
      dom.title = node.attrs.text || '';
      dom.textContent = '*';
      return {
        dom,
        ignoreMutation: () => true,
        update: (next) => {
          if (next.type.name !== 'footnote') return false;
          dom.setAttribute('data-footnote', next.attrs.text || '');
          dom.title = next.attrs.text || '';
          return true;
        },
      };
    };
  },
});

// Number every footnote across the page editors, in page order.
export function numberFootnotes(editors) {
  let n = 0;
  for (const ed of editors) {
    if (!ed || ed.isDestroyed) continue;
    ed.view.dom.querySelectorAll('sup.doc-footnote').forEach((el) => {
      n += 1;
      const s = String(n);
      if (el.textContent !== s) el.textContent = s;
    });
  }
  return n;
}

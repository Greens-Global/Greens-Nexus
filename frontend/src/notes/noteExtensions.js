// The Notes editor's extensions (Oct 29 2026), in their own file so the
// live co-typing runtime (collabRuntime.js) builds the same schema to seed a
// note's shared state from its HTML. With `collab` (Oct 30 2026) the shared
// Yjs document owns the words and the undo history, so StarterKit's own
// undo/redo is off and the collaboration extensions come last.
//
// Words that arrive through the shared document (co-typing) have never been
// through the server's sanitizer or any parseHTML, so every attribute that
// reaches the page is checked again on the way OUT (renderHTML): alignment
// is one of a few words, a link carries only its href (constant target and
// rel, no class), a code block's language is a short plain word, a voice
// note or video plays only from our own storage (`strict`), and a value of
// the wrong type renders as nothing rather than throwing.
import StarterKit from '@tiptap/starter-kit';
import { mergeAttributes } from '@tiptap/core';
import Placeholder from '@tiptap/extension-placeholder';
import Highlight from '@tiptap/extension-highlight';
import TextAlign from '@tiptap/extension-text-align';
import Link from '@tiptap/extension-link';
import CodeBlock from '@tiptap/extension-code-block';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table';
import { NoteAudio, NoteVideo } from './noteMedia';

const ALIGN = ['left', 'center', 'right', 'justify'];
const SafeTextAlign = TextAlign.extend({
  addGlobalAttributes() {
    return (this.parent?.() || []).map((g) => ({
      ...g,
      attributes: Object.fromEntries(Object.entries(g.attributes).map(([k, a]) => [k, {
        ...a,
        renderHTML: (attrs) => (ALIGN.includes(attrs[k]) ? { style: `text-align: ${attrs[k]}` } : {}),
      }])),
    }));
  },
});

const LINK_REL = 'noopener noreferrer';
export const SafeLink = Link.extend({
  addAttributes() {
    const p = this.parent?.() || {};
    return {
      ...p,
      href: { ...p.href, renderHTML: (a) => ({ href: typeof a.href === 'string' ? a.href : '' }) },
      target: { default: '_blank', parseHTML: () => '_blank', renderHTML: () => ({ target: '_blank' }) },
      rel: { default: LINK_REL, parseHTML: () => LINK_REL, renderHTML: () => ({ rel: LINK_REL }) },
      class: { default: null, parseHTML: () => null, renderHTML: () => ({}) },
      title: { default: null, renderHTML: (a) => (typeof a.title === 'string' && a.title ? { title: a.title.slice(0, 300) } : {}) },
    };
  },
});

const LANG = /^[a-z0-9+#-]{1,30}$/i;
export const SafeCodeBlock = CodeBlock.extend({
  renderHTML({ node, HTMLAttributes }) {
    const lang = typeof node.attrs.language === 'string' && LANG.test(node.attrs.language) ? node.attrs.language : '';
    return ['pre', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes),
      ['code', { class: lang ? this.options.languageClassPrefix + lang : null }, 0]];
  },
});

// Table cells: alignment is left / center / right or nothing; spans are
// small whole numbers; a column width is a list of numbers.
const CELL_ALIGN = ['left', 'center', 'right'];
const span = (v) => (Number.isInteger(v) && v >= 1 && v <= 100 ? v : 1);
const safeCell = (Cell) => Cell.extend({
  addAttributes() {
    const p = this.parent?.() || {};
    return {
      ...p,
      colspan: { ...p.colspan, renderHTML: (a) => (span(a.colspan) > 1 ? { colspan: span(a.colspan) } : {}) },
      rowspan: { ...p.rowspan, renderHTML: (a) => (span(a.rowspan) > 1 ? { rowspan: span(a.rowspan) } : {}) },
      colwidth: {
        ...p.colwidth,
        renderHTML: (a) => (Array.isArray(a.colwidth) && a.colwidth.every((w) => Number.isFinite(w))
          ? { colwidth: a.colwidth.join(',') } : {}),
      },
      align: { ...p.align, renderHTML: (a) => (CELL_ALIGN.includes(a.align) ? { style: `text-align: ${a.align}` } : {}) },
    };
  },
});
const SafeTableCell = safeCell(TableCell);
const SafeTableHeader = safeCell(TableHeader);

/**
 * buildExtensions(placeholder, collab?, { strict }?) - `strict` (always on
 * with `collab`) plays voice notes and videos only from our own storage.
 */
export function buildExtensions(placeholder, collab = null, { strict = false } = {}) {
  const strictSrc = strict || !!collab;
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      link: false,
      codeBlock: false,
      // Co-typing: Yjs owns undo; and no trailing empty paragraph - every
      // editor that joined would add its own to the shared document, and a
      // note ending in a list grew one blank line per visit.
      ...(collab ? { undoRedo: false, trailingNode: false } : {}),
    }),
    SafeLink.configure({ openOnClick: false, autolink: true, HTMLAttributes: { rel: LINK_REL, target: '_blank' } }),
    SafeCodeBlock,
    Highlight,
    SafeTextAlign.configure({ types: ['heading', 'paragraph'] }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Table.configure({ resizable: false }),
    TableRow, SafeTableHeader, SafeTableCell,
    Placeholder.configure({ placeholder }),
    NoteAudio.configure({ strictSrc }), NoteVideo.configure({ strictSrc }),
    ...(collab?.extensions || []),
  ];
}

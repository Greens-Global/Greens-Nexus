import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Paragraph from '@tiptap/extension-paragraph';
import Heading from '@tiptap/extension-heading';
import { Table, TableRow, TableHeader as BaseTableHeader, TableCell as BaseTableCell } from '@tiptap/extension-table';
import { BulletList } from '@tiptap/extension-list';
import TextAlign from '@tiptap/extension-text-align';
import { TextStyleKit } from '@tiptap/extension-text-style';
import Link from '@tiptap/extension-link';
import Subscript from '@tiptap/extension-subscript';
import Superscript from '@tiptap/extension-superscript';
import Highlight from '@tiptap/extension-highlight';
import { MergeField, PageBreak, DocShape, DocTextbox, ResizableImage, Bookmark, SectionBox, SignatureBlock } from './docBuilderExtensions';
import { boldTextNode } from './markdownBold';
import { CommentMark } from './docCommentMark';
import { TrackChanges } from './docTrackChanges';
import { Tab, TAB_STOPS_ATTR } from './docTabs';

// Word-style cell shading - TipTap's stock TableCell/TableHeader carry no
// background-color attribute, so both are extended identically with one
// (read from/written to inline `style`, same pattern MergeField's chip uses).
const CELL_BG_ATTR = {
  backgroundColor: {
    default: null,
    parseHTML: (el) => el.style.backgroundColor || null,
    renderHTML: (attrs) => (attrs.backgroundColor ? { style: `background-color: ${attrs.backgroundColor}` } : {}),
  },
};
const TableCell = BaseTableCell.extend({ addAttributes() { return { ...this.parent?.(), ...CELL_BG_ATTR }; } });
const TableHeader = BaseTableHeader.extend({ addAttributes() { return { ...this.parent?.(), ...CELL_BG_ATTR }; } });

// Word's "Paragraph" ribbon group (indent level, line spacing, shading) -
// stock Paragraph/Heading carry none of these, so both get the same three
// attributes, same pattern as CELL_BG_ATTR above. TipTap merges every
// attribute's own renderHTML output into one combined `style` string for
// nodes (like these) that don't override renderHTML() themselves, so having
// three separate style-producing attributes here is safe, not conflicting.
const PARAGRAPH_STYLE_ATTRS = {
  indent: {
    default: 0,
    parseHTML: (el) => parseInt(el.getAttribute('data-indent') || '0', 10) || 0,
    renderHTML: (attrs) => (attrs.indent ? { 'data-indent': attrs.indent, style: `margin-left: ${attrs.indent * 24}px` } : {}),
  },
  lineHeight: {
    default: null,
    parseHTML: (el) => el.style.lineHeight || null,
    renderHTML: (attrs) => (attrs.lineHeight ? { style: `line-height: ${attrs.lineHeight}` } : {}),
  },
  backgroundColor: {
    default: null,
    parseHTML: (el) => el.style.backgroundColor || null,
    renderHTML: (attrs) => (attrs.backgroundColor ? { style: `background-color: ${attrs.backgroundColor}` } : {}),
  },
  border: {
    default: null,
    parseHTML: (el) => el.style.border || null,
    renderHTML: (attrs) => (attrs.border ? { style: `border: ${attrs.border}` } : {}),
  },
  spacingBefore: {
    default: null,
    parseHTML: (el) => (el.style.marginTop ? parseFloat(el.style.marginTop) : null),
    renderHTML: (attrs) => (attrs.spacingBefore ? { style: `margin-top: ${attrs.spacingBefore}pt` } : {}),
  },
  spacingAfter: {
    default: null,
    parseHTML: (el) => (el.style.marginBottom ? parseFloat(el.style.marginBottom) : null),
    renderHTML: (attrs) => (attrs.spacingAfter != null ? { style: `margin-bottom: ${attrs.spacingAfter}pt` } : {}),
  },
  // Word's Indent Left / First Line (Layout tab, and every imported .docx with
  // an indented paragraph or a hanging first line). Points, like the spacing.
  // Rendered after `indent` so a measured indent wins over the level-based one.
  indentLeft: {
    default: null,
    parseHTML: (el) => (el.style.marginLeft && /pt$/.test(el.style.marginLeft) ? parseFloat(el.style.marginLeft) : null),
    renderHTML: (attrs) => (attrs.indentLeft ? { style: `margin-left: ${attrs.indentLeft}pt` } : {}),
  },
  indentFirst: {
    default: null,
    parseHTML: (el) => (el.style.textIndent ? parseFloat(el.style.textIndent) : null),
    renderHTML: (attrs) => (attrs.indentFirst ? { style: `text-indent: ${attrs.indentFirst}pt` } : {}),
  },
  indentRight: {
    default: null,
    parseHTML: (el) => (el.style.marginRight && /pt$/.test(el.style.marginRight) ? parseFloat(el.style.marginRight) : null),
    renderHTML: (attrs) => (attrs.indentRight ? { style: `margin-right: ${attrs.indentRight}pt` } : {}),
  },
  // Word's tab stops (lib/docTabs.js): [{ pos (pt from the margin), align }].
  ...TAB_STOPS_ATTR,
};

// Word's bullet gallery (disc, circle, square) - the list's own marker style.
const StyledBulletList = BulletList.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      listStyle: {
        default: null,
        parseHTML: (el) => el.style.listStyleType || null,
        renderHTML: (attrs) => (attrs.listStyle ? { style: `list-style-type: ${attrs.listStyle}` } : {}),
      },
    };
  },
});

// Word draws a table with no borders at all (a layout table, a form) as
// bare text; the editor shows faint gridlines so it can still be edited.
const StyledTable = Table.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      borders: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-borders') || null,
        renderHTML: (attrs) => (attrs.borders ? { 'data-borders': attrs.borders } : {}),
      },
    };
  },
});
const StyledParagraph = Paragraph.extend({ addAttributes() { return { ...this.parent?.(), ...PARAGRAPH_STYLE_ATTRS }; } });
const StyledHeading = Heading.extend({ addAttributes() { return { ...this.parent?.(), ...PARAGRAPH_STYLE_ATTRS }; } });

// The body editor's extension list, pulled out of DocumentBuilder.jsx (Phase
// 10) so it can also drive generateJSON() for document import - both places
// need the exact same schema, or imported HTML would parse into JSON the live
// editor doesn't fully recognize. Placeholder is deliberately excluded (it's
// decoration-only, contributes nothing to the schema, and each editor needs
// its own placeholder text) - DocumentBuilder.jsx appends it locally.
export const BODY_EXTENSIONS = [
  // link: false - StarterKit ships its own Link; the configured one below is
  // the one in use (two registered as "link" was a TipTap warning on every mount).
  StarterKit.configure({ paragraph: false, heading: false, link: false, bulletList: false }),
  StyledParagraph, StyledHeading, StyledBulletList,
  // Inline, like Word: a picture lives in the run where it was placed, so a
  // Teams transcript's speaker avatar sits beside the name rather than on a
  // line of its own. The node view is already built for it
  // (.doc-image-wrap is display:inline-block, vertical-align:middle).
  ResizableImage.configure({ inline: true }),
  StyledTable.configure({ resizable: true }),
  TableRow, TableHeader, TableCell,
  MergeField, PageBreak, DocShape, DocTextbox, Bookmark, SectionBox,
  SignatureBlock, Tab,
  TextStyleKit,
  Subscript, Superscript, Highlight.configure({ multicolor: true }),
  TextAlign.configure({ types: ['paragraph', 'heading'] }),
  // autolink: true - typing/pasting a bare URL now auto-converts to a real
  // hyperlink, matching Word; previously explicitly disabled.
  Link.configure({ openOnClick: false, autolink: true }),
  // The anchor of a comment thread (Review tab); the words live on the server.
  CommentMark,
  // Track Changes (Review tab): the insertion / deletion marks and the tracker.
  TrackChanges,
];

// ── Structural repair ────────────────────────────────────────────────────────
// ProseMirror does NOT validate on load: Node.fromJSON happily builds a
// document whose content violates the schema, and the editor then throws
// "Called contentMatchAt on a node with invalid content" on the first
// transform that touches the bad node. To the person typing that reads as
// "this document won't let me type, and undo does nothing" - on some
// paragraphs but not others, because only the invalid ones fail.
//
// The .docx importer used to emit exactly that: `image` is a BLOCK node here
// (the server exporter reads images at block level, so it has to be), but a
// Word inline picture arrives inside a run and was written into the
// paragraph's inline content. A Teams transcript is one avatar per speaker
// turn, so most paragraphs in the document were unusable.
//
// The importer emits valid structure now. This repairs what is already SAVED,
// on the way into the editor - a document written by the old importer would
// otherwise stay broken forever, and re-importing it is not something anyone
// would think to do.
let _schema = null;
const schemaOf = () => (_schema ||= getSchema(BODY_EXTENSIONS));

function repairNodes(node, schema) {
  if (!node || typeof node !== 'object' || !node.type) return [];
  if (!Array.isArray(node.content) || !node.content.length) return [node];
  const spec = schema.nodes[node.type];
  let children = node.content.flatMap(c => repairNodes(c, schema));
  // Literal **pairs** saved as text become bold (lib/markdownBold.js) - not in
  // a block that takes no marks (a code block).
  if (spec?.isTextblock && schema.marks.bold && spec.allowsMarkType(schema.marks.bold)) {
    children = children.flatMap(c => (c.type === 'text' ? boldTextNode(c) : [c]));
  }
  const isInline = (n) => !!schema.nodes[n.type]?.isInline;

  // A textblock (paragraph, heading) may hold inline content only. Lift any
  // block child out, splitting the paragraph around it and keeping order.
  if (spec?.isTextblock) {
    const out = [];
    let run = [];
    const flush = () => { if (run.length) { out.push({ ...node, content: run }); run = []; } };
    for (const child of children) {
      if (isInline(child)) run.push(child);
      else { flush(); out.push(child); }
    }
    flush();
    // Everything lifted out: the paragraph only ever held the block node, so
    // it leaves with it rather than staying behind as a blank line.
    return out.length ? out : [];
  }

  // A block container (doc, list item, table cell) may not hold inline content
  // directly - wrap any stray runs in a paragraph.
  if (spec && /block|paragraph/.test(spec.spec.content || '')) {
    const out = [];
    let run = [];
    const flush = () => { if (run.length) { out.push({ type: 'paragraph', content: run }); run = []; } };
    for (const child of children) {
      if (isInline(child)) run.push(child);
      else { flush(); out.push(child); }
    }
    flush();
    return [{ ...node, content: out }];
  }

  return [{ ...node, content: children }];
}

// Repairs one page/body document. Returns the input untouched when it is
// already valid, so a good document is never rewritten.
export function repairDocJson(json) {
  if (!json || typeof json !== 'object') return json;
  const [repaired] = repairNodes(json, schemaOf());
  if (!repaired) return json;
  // A doc must have at least one block; an empty one renders as nothing at all.
  if (!repaired.content?.length) return { ...repaired, content: [{ type: 'paragraph' }] };
  return repaired;
}

// A live Document Builder session (docLive/docModel.js, Neil 11/05/2026): the
// same schema with StarterKit's own undo history off - Undo / Redo come from
// the shared document instead (TipTap's Collaboration), so a person undoes
// only their own typing, never a colleague's.
export const LIVE_BODY_EXTENSIONS = BODY_EXTENSIONS.map((e) => (e.name === 'starterKit' ? e.configure({ undoRedo: false }) : e));

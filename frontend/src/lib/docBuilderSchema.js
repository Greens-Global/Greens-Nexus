import StarterKit from '@tiptap/starter-kit';
import Paragraph from '@tiptap/extension-paragraph';
import Heading from '@tiptap/extension-heading';
import { Table, TableRow, TableHeader as BaseTableHeader, TableCell as BaseTableCell } from '@tiptap/extension-table';
import TextAlign from '@tiptap/extension-text-align';
import { TextStyleKit } from '@tiptap/extension-text-style';
import Link from '@tiptap/extension-link';
import Subscript from '@tiptap/extension-subscript';
import Superscript from '@tiptap/extension-superscript';
import Highlight from '@tiptap/extension-highlight';
import { MergeField, PageBreak, DocShape, DocTextbox, ResizableImage, Bookmark, SectionBox } from './docBuilderExtensions';

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
    renderHTML: (attrs) => (attrs.spacingAfter ? { style: `margin-bottom: ${attrs.spacingAfter}pt` } : {}),
  },
};
const StyledParagraph = Paragraph.extend({ addAttributes() { return { ...this.parent?.(), ...PARAGRAPH_STYLE_ATTRS }; } });
const StyledHeading = Heading.extend({ addAttributes() { return { ...this.parent?.(), ...PARAGRAPH_STYLE_ATTRS }; } });

// The body editor's extension list, pulled out of DocumentBuilder.jsx (Phase
// 10) so it can also drive generateJSON() for document import - both places
// need the exact same schema, or imported HTML would parse into JSON the live
// editor doesn't fully recognize. Placeholder is deliberately excluded (it's
// decoration-only, contributes nothing to the schema, and each editor needs
// its own placeholder text) - DocumentBuilder.jsx appends it locally.
export const BODY_EXTENSIONS = [
  StarterKit.configure({ paragraph: false, heading: false }),
  StyledParagraph, StyledHeading,
  ResizableImage,
  Table.configure({ resizable: true }),
  TableRow, TableHeader, TableCell,
  MergeField, PageBreak, DocShape, DocTextbox, Bookmark, SectionBox,
  TextStyleKit,
  Subscript, Superscript, Highlight.configure({ multicolor: true }),
  TextAlign.configure({ types: ['paragraph', 'heading'] }),
  // autolink: true - typing/pasting a bare URL now auto-converts to a real
  // hyperlink, matching Word; previously explicitly disabled.
  Link.configure({ openOnClick: false, autolink: true }),
];

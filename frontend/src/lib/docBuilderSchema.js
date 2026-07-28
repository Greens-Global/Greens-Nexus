import StarterKit from '@tiptap/starter-kit';
import { Table, TableRow, TableHeader as BaseTableHeader, TableCell as BaseTableCell } from '@tiptap/extension-table';
import TextAlign from '@tiptap/extension-text-align';
import { TextStyleKit } from '@tiptap/extension-text-style';
import Link from '@tiptap/extension-link';
import { MergeField, PageBreak, DocShape, DocTextbox, ResizableImage } from './docBuilderExtensions';

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

// The body editor's extension list, pulled out of DocumentBuilder.jsx (Phase
// 10) so it can also drive generateJSON() for document import - both places
// need the exact same schema, or imported HTML would parse into JSON the live
// editor doesn't fully recognize. Placeholder is deliberately excluded (it's
// decoration-only, contributes nothing to the schema, and each editor needs
// its own placeholder text) - DocumentBuilder.jsx appends it locally.
export const BODY_EXTENSIONS = [
  StarterKit,
  ResizableImage,
  Table.configure({ resizable: true }),
  TableRow, TableHeader, TableCell,
  MergeField, PageBreak, DocShape, DocTextbox,
  TextStyleKit,
  TextAlign.configure({ types: ['paragraph', 'heading'] }),
  // autolink: true - typing/pasting a bare URL now auto-converts to a real
  // hyperlink, matching Word; previously explicitly disabled.
  Link.configure({ openOnClick: false, autolink: true }),
];

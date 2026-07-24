import StarterKit from '@tiptap/starter-kit';
import TiptapImage from '@tiptap/extension-image';
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table';
import TextAlign from '@tiptap/extension-text-align';
import { TextStyleKit } from '@tiptap/extension-text-style';
import Link from '@tiptap/extension-link';
import { MergeField, PageBreak, DocShape, DocTextbox } from './docBuilderExtensions';

// The body editor's extension list, pulled out of DocumentBuilder.jsx (Phase
// 10) so it can also drive generateJSON() for document import — both places
// need the exact same schema, or imported HTML would parse into JSON the live
// editor doesn't fully recognize. Placeholder is deliberately excluded (it's
// decoration-only, contributes nothing to the schema, and each editor needs
// its own placeholder text) — DocumentBuilder.jsx appends it locally.
export const BODY_EXTENSIONS = [
  StarterKit,
  TiptapImage,
  Table.configure({ resizable: true }),
  TableRow, TableHeader, TableCell,
  MergeField, PageBreak, DocShape, DocTextbox,
  TextStyleKit,
  TextAlign.configure({ types: ['paragraph', 'heading'] }),
  Link.configure({ openOnClick: false, autolink: false }),
];

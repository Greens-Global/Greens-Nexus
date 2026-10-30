// The Notes editor's extensions (Oct 29 2026), in their own file so the
// live co-typing runtime (collabRuntime.js) builds the same schema to seed a
// note's shared state from its HTML. With `collab` (Oct 30 2026) the shared
// Yjs document owns the words and the undo history, so StarterKit's own
// undo/redo is off and the collaboration extensions come last.
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Highlight from '@tiptap/extension-highlight';
import TextAlign from '@tiptap/extension-text-align';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table';
import { NoteAudio, NoteVideo } from './noteMedia';

export function buildExtensions(placeholder, collab = null) {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      link: { openOnClick: false, autolink: true, HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' } },
      ...(collab ? { undoRedo: false } : {}),
    }),
    Highlight,
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Table.configure({ resizable: false }),
    TableRow, TableHeader, TableCell,
    Placeholder.configure({ placeholder }),
    NoteAudio, NoteVideo,
    ...(collab?.extensions || []),
  ];
}

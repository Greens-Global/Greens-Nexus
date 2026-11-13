// "+ New" on the Notes page (Neil, 11/12/2026: "it should say + New, not New
// Note, From Template, and New Board. Make it a dropdown type like we did for
// the other modules"). The shared NewButton (components/NewButton.jsx, the
// one "+ New" across Nexus) with Notes' four ways to start, each opening the
// flow it always did:
//
//   Note                     - a blank note at once (newNote)
//   Board                    - the board starter picker (board/TemplatePicker)
//   Note From a Template...  - the note starter picker (NoteTemplatePicker)
//   Import a File...         - a .md / .txt file as a new note
//
// Import moved in from its own icon in the bar: it makes a new note, so it
// belongs with the others (Documents keeps "Open a File..." under its New the
// same way).
import { FileText, LayoutTemplate, Upload } from 'lucide-react';
import NewButton from '../components/NewButton';
import BoardIcon from '../components/icons/BoardIcon';

export const NEW_ITEMS = [
  { key: 'note', label: 'Note', hint: 'A blank page to write in', Icon: FileText },
  { key: 'board', label: 'Board', hint: 'Draw, plan and mark things up', Icon: BoardIcon },
  { key: 'template', label: 'Note From a Template...', hint: 'Meeting notes, a 1:1, a site walk', Icon: LayoutTemplate, sep: true },
  { key: 'import', label: 'Import a File...', hint: 'A Markdown or text file', Icon: Upload },
];

export default function NewMenu({ onPick, compact = false }) {
  return (
    <NewButton items={NEW_ITEMS} onPick={onPick} compact={compact} testId="nt-new"
      className="nt-text-btn is-primary" title="Start a note or a board" menuLabel="New" />
  );
}

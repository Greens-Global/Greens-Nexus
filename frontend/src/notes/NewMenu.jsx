// "+ New" on the Notes page (Neil, 11/12/2026: "it should say + New, not New
// Note, From Template, and New Board. Make it a dropdown type like we did for
// the other modules"). ONE primary button in the bar, the way Tasks has
// "+ Create" and Documents one New split; every way to start something in
// Notes sits under it, each opening the flow it always did:
//
//   Note                     - a blank note at once (newNote)
//   Board                    - the board starter picker (board/TemplatePicker)
//   Note From a Template...  - the note starter picker (NoteTemplatePicker)
//   Import a File...         - a .md / .txt file as a new note
//
// Import moved in from its own icon in the bar: it makes a new note, so it
// belongs with the others (Documents keeps "Open a File..." under its New the
// same way). The menu is AnchoredMenu (a portal: outside click, Escape, never
// clipped); arrow keys, Home and End move through it and it opens with the
// first row focused, so the keyboard reaches every choice.
import { Fragment, useEffect, useRef, useState } from 'react';
import { ChevronDown, FileText, LayoutTemplate, Plus, Upload } from 'lucide-react';
import AnchoredMenu from '../components/AnchoredMenu';
import BoardIcon from '../components/icons/BoardIcon';

export const NEW_ITEMS = [
  { key: 'note', label: 'Note', hint: 'A blank page to write in', Icon: FileText },
  { key: 'board', label: 'Board', hint: 'Draw, plan and mark things up', Icon: BoardIcon },
  { key: 'template', label: 'Note From a Template...', hint: 'Meeting notes, a 1:1, a site walk', Icon: LayoutTemplate, sep: true },
  { key: 'import', label: 'Import a File...', hint: 'A Markdown or text file', Icon: Upload },
];

export default function NewMenu({ onPick, compact = false }) {
  const [open, setOpen] = useState(false);
  const btn = useRef(null);
  const panel = useRef(null);

  // Open with the first row focused (after AnchoredMenu has placed the panel).
  useEffect(() => {
    if (!open) return undefined;
    const t = setTimeout(() => panel.current?.querySelector('[role="menuitem"]')?.focus(), 30);
    return () => clearTimeout(t);
  }, [open]);

  const pick = (key) => { setOpen(false); onPick(key); };
  const onKeyDown = (e) => {
    const rows = [...(panel.current?.querySelectorAll('[role="menuitem"]') || [])];
    if (!rows.length) return;
    const at = rows.indexOf(document.activeElement);
    const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: rows.length - 1 }[e.key];
    if (to == null) return;
    e.preventDefault();
    rows[(to + rows.length) % rows.length].focus();
  };

  return (
    <>
      <button ref={btn} type="button" className={`nt-text-btn is-primary nt-new-btn${compact ? ' is-compact' : ''}`} data-testid="nt-new"
        aria-haspopup="menu" aria-expanded={open} aria-label="New" title="Start a note or a board"
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === 'ArrowDown' && !open) { e.preventDefault(); setOpen(true); } }}>
        <Plus size={15} aria-hidden="true" /> New <ChevronDown size={14} className="nt-new-caret" aria-hidden="true" />
      </button>
      <AnchoredMenu anchorRef={btn} open={open} onClose={() => setOpen(false)} align="end" className="nt-new-menu" aria-label="New">
        <div ref={panel} role="none" onKeyDown={onKeyDown}>
          {NEW_ITEMS.map(({ key, label, hint, Icon, sep }) => (
            <Fragment key={key}>
              {sep && <div className="nt-new-sep" role="separator" />}
              <button type="button" role="menuitem" className="nt-new-item" onClick={() => pick(key)}>
                <Icon size={16} aria-hidden="true" />
                <span className="nt-new-words"><span className="nt-new-label">{label}</span><span className="nt-new-hint">{hint}</span></span>
              </button>
            </Fragment>
          ))}
        </div>
      </AnchoredMenu>
    </>
  );
}

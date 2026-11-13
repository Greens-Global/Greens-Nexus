// The Document Builder on a phone (Neil, 11/13/2026: "the new document that
// gets created absolutely sucks on mobile"). The computer's menu bar and
// two-row ribbon took half the screen before a word was typed, so on a phone:
//
//   * DocPhoneBar - the formatting a phone needs, riding on top of the
//     keyboard like the Notes phone bar (the same look - notes.css `.nt-pb`):
//     undo / redo, bold / italic / underline, lists and indents, alignment and
//     a picture on the main row; Aa opens a second row with the styles,
//     strikethrough, link, table, page break and All Formatting (the full
//     ribbon, for fonts, sizes and colors).
//   * PhoneMenuSheet - the menu bar's File / Edit / View / Insert / Format /
//     Tools / Help as one sheet: the SAME `docMenus` the computer draws (a menu
//     is { label, items }, an item '-' or { label, icon, onClick, disabled,
//     checked, items }), so the phone never has a second copy of a command.
import { useState } from 'react';
import {
  Undo, Redo, Bold, Italic, Underline, Strikethrough, List, ListOrdered, IndentDecrease, IndentIncrease,
  AlignLeft, AlignCenter, AlignRight, AlignJustify, ImagePlus, CaseSensitive, Pilcrow, Heading1, Heading2,
  Heading3, Link2, Table as TableIcon, SeparatorHorizontal, PanelTop, KeyboardOff, Check, ChevronRight, ChevronLeft,
} from 'lucide-react';
import { Modal } from '../../tasks/components';
import { useKeyboardInset, keyboardUp } from '../../lib/useVisualViewport';
import '../../notes/notes.css';

function PBtn({ icon: Icon, label, active, disabled, onClick }) {
  return (
    <button type="button" className={`nt-pb-btn${active ? ' is-on' : ''}`} title={label} aria-label={label}
      aria-pressed={active === undefined ? undefined : String(!!active)} disabled={disabled} tabIndex={-1}
      // onMouseDown keeps the page's selection and the keyboard; a click would blur it first.
      onMouseDown={(e) => { e.preventDefault(); if (!disabled) onClick(); }}>
      <Icon size={20} strokeWidth={1.9} aria-hidden="true" />
    </button>
  );
}

const ALIGNS = [['left', AlignLeft, 'Align Left'], ['center', AlignCenter, 'Center'], ['right', AlignRight, 'Align Right'], ['justify', AlignJustify, 'Justify']];

/** The phone's formatting bar. `ed` is the page's editor (TipTap). */
export function DocPhoneBar({ ed, editing, onPicture, onLink, onPageBreak, onAllFormatting }) {
  const [more, setMore] = useState(false);
  const inset = useKeyboardInset(true);
  if (!ed || ed.isDestroyed) return null;
  const has = (cmd) => typeof ed.commands[cmd] === 'function';
  const on = (name, attrs) => !!ed.isActive(name, attrs);
  const run = (fn) => () => { fn(ed.chain().focus()).run(); };
  const off = !editing;
  const alignNow = ALIGNS.find(([v]) => ed.isActive({ textAlign: v })) || ALIGNS[0];
  const nextAlign = ALIGNS[(ALIGNS.indexOf(alignNow) + 1) % ALIGNS.length];
  const canLift = ed.can().liftListItem?.('listItem');
  const canSink = ed.can().sinkListItem?.('listItem');
  return (
    <div className="nt-pb doc-pb" role="toolbar" aria-label="Formatting"
      style={{ bottom: inset, ...(inset && keyboardUp() ? { paddingBottom: 0 } : null) }}>
      {more && (
        <div className="nt-pb-row is-more">
          <PBtn icon={Pilcrow} label="Normal Text" active={on('paragraph') && !on('heading')} disabled={off} onClick={run((c) => c.setParagraph())} />
          <PBtn icon={Heading1} label="Heading 1" active={on('heading', { level: 1 })} disabled={off} onClick={run((c) => c.toggleHeading({ level: 1 }))} />
          <PBtn icon={Heading2} label="Heading 2" active={on('heading', { level: 2 })} disabled={off} onClick={run((c) => c.toggleHeading({ level: 2 }))} />
          <PBtn icon={Heading3} label="Heading 3" active={on('heading', { level: 3 })} disabled={off} onClick={run((c) => c.toggleHeading({ level: 3 }))} />
          {has('toggleStrike') && <PBtn icon={Strikethrough} label="Strikethrough" active={on('strike')} disabled={off} onClick={run((c) => c.toggleStrike())} />}
          <PBtn icon={Link2} label="Link" active={on('link')} disabled={off} onClick={() => { setMore(false); onLink(); }} />
          {has('insertTable') && <PBtn icon={TableIcon} label="Insert Table" disabled={off} onClick={run((c) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: false }))} />}
          <PBtn icon={SeparatorHorizontal} label="Page Break" disabled={off} onClick={onPageBreak} />
          <PBtn icon={PanelTop} label="All Formatting - fonts, sizes and colors" onClick={() => { setMore(false); onAllFormatting(); }} />
          <PBtn icon={KeyboardOff} label="Hide Keyboard" onClick={() => { setMore(false); ed.commands.blur(); }} />
        </div>
      )}
      <div className="nt-pb-main">
        <div className="nt-pb-row">
          <PBtn icon={Undo} label="Undo" disabled={off || !ed.can().undo()} onClick={run((c) => c.undo())} />
          <PBtn icon={Redo} label="Redo" disabled={off || !ed.can().redo()} onClick={run((c) => c.redo())} />
          <span className="nt-pb-sep" aria-hidden="true" />
          <PBtn icon={Bold} label="Bold" active={on('bold')} disabled={off} onClick={run((c) => c.toggleBold())} />
          <PBtn icon={Italic} label="Italic" active={on('italic')} disabled={off} onClick={run((c) => c.toggleItalic())} />
          {has('toggleUnderline') && <PBtn icon={Underline} label="Underline" active={on('underline')} disabled={off} onClick={run((c) => c.toggleUnderline())} />}
          <span className="nt-pb-sep" aria-hidden="true" />
          <PBtn icon={List} label="Bulleted List" active={on('bulletList')} disabled={off} onClick={run((c) => c.toggleBulletList())} />
          <PBtn icon={ListOrdered} label="Numbered List" active={on('orderedList')} disabled={off} onClick={run((c) => c.toggleOrderedList())} />
          <PBtn icon={IndentDecrease} label="Outdent" disabled={off || !canLift} onClick={run((c) => c.liftListItem('listItem'))} />
          <PBtn icon={IndentIncrease} label="Indent" disabled={off || !canSink} onClick={run((c) => c.sinkListItem('listItem'))} />
          {has('setTextAlign') && (
            <PBtn icon={alignNow[1]} label={`${alignNow[2]} - tap for ${nextAlign[2]}`} disabled={off} onClick={run((c) => c.setTextAlign(nextAlign[0]))} />
          )}
          <PBtn icon={ImagePlus} label="Picture - take one or pick from the library" disabled={off} onClick={onPicture} />
        </div>
        {/* Aa stays put at the right edge; the row beside it scrolls if it must. */}
        <PBtn icon={CaseSensitive} label="More Formatting" active={more} onClick={() => setMore((m) => !m)} />
      </div>
    </div>
  );
}

const clean = (items) => (items || []).filter((it) => it && (it === '-' || it.label));

/** The menu bar as one phone sheet: the menus, then a menu's commands. */
export function PhoneMenuSheet({ menus, startAt = '', onClose }) {
  const [path, setPath] = useState(() => {
    const m = startAt && menus.find((x) => x?.label === startAt);
    return m ? [m] : [];
  });
  const here = path[path.length - 1];
  const items = here ? clean(here.items) : menus.filter(Boolean);
  const runIt = (it) => { onClose(); setTimeout(() => it.onClick?.(), 0); };
  return (
    <Modal title={here ? here.label : 'Menu'} onClose={onClose}>
      <div className="doc-pm" role="menu" aria-label={here ? here.label : 'Menu'}>
        {here && (
          <button type="button" className="doc-pm-back" onClick={() => setPath((p) => p.slice(0, -1))}>
            <ChevronLeft size={16} aria-hidden="true" /> {path.length > 1 ? path[path.length - 2].label : 'Menu'}
          </button>
        )}
        {items.map((it, i) => {
          if (it === '-') return <div key={`s${i}`} className="doc-pm-line" role="separator" />;
          const Icon = it.icon;
          const sub = !here || !!it.items;
          return (
            <button key={`${it.label}-${i}`} type="button" role="menuitem" className="doc-pm-row" disabled={it.disabled}
              onClick={() => (sub ? setPath((p) => [...p, it]) : runIt(it))}>
              {here && <span className="doc-pm-ic" aria-hidden="true">{it.checked ? <Check size={17} /> : Icon ? <Icon size={17} /> : null}</span>}
              <span className="doc-pm-label">{it.label}{it.hint && <span className="doc-pm-hint">{it.hint}</span>}</span>
              {sub && <ChevronRight size={16} className="doc-pm-chev" aria-hidden="true" />}
            </button>
          );
        })}
      </div>
    </Modal>
  );
}

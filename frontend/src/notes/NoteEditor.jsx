// The Notes editor (Oct 29 2026): TipTap with the formatting a scratchpad
// needs - headings, lists, checklists, quote, code, tables, highlight, links,
// alignment - plus Markdown shortcuts (StarterKit's input rules: "# ", "- ",
// "1. ", "[ ] ", "> ", "```", **bold**), a "/" menu of blocks and @mentions
// from Nexus People. A mention is a mailto link (the task editor's shape), so
// it stays readable anywhere the HTML lands; a note is private, so a mention
// notifies nobody. "Make a Task" turns the selection or the current line into
// a task (the page does the creating).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Highlight from '@tiptap/extension-highlight';
import TextAlign from '@tiptap/extension-text-align';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table';
import {
  Undo2, Redo2, Bold, Italic, Underline, Strikethrough, Highlighter, Code, Heading1, Heading2, Heading3,
  List, ListOrdered, ListChecks, IndentIncrease, IndentDecrease, Quote, SquareCode, AlignLeft, AlignCenter,
  AlignRight, Link2, Table as TableIcon, Minus, CalendarDays, Pilcrow, ListPlus, Rows3, Columns3, Trash2, Check, X,
} from 'lucide-react';
import { matchPeople } from '../lib/peopleSearch';
import { formatDate } from '../lib/datetime';

const SLASH = [
  { key: 'text', label: 'Text', hint: 'Plain paragraph', icon: Pilcrow, run: (c) => c.setParagraph() },
  { key: 'h1', label: 'Heading 1', hint: 'Large section title', icon: Heading1, keys: 'title big', run: (c) => c.setHeading({ level: 1 }) },
  { key: 'h2', label: 'Heading 2', hint: 'Medium section title', icon: Heading2, keys: 'subtitle', run: (c) => c.setHeading({ level: 2 }) },
  { key: 'h3', label: 'Heading 3', hint: 'Small section title', icon: Heading3, run: (c) => c.setHeading({ level: 3 }) },
  { key: 'check', label: 'Checklist', hint: 'To-dos you can tick off', icon: ListChecks, keys: 'todo task checkbox', run: (c) => c.toggleTaskList() },
  { key: 'bullet', label: 'Bulleted List', hint: 'Simple list', icon: List, keys: 'ul unordered', run: (c) => c.toggleBulletList() },
  { key: 'number', label: 'Numbered List', hint: 'Ordered steps', icon: ListOrdered, keys: 'ol ordered', run: (c) => c.toggleOrderedList() },
  { key: 'quote', label: 'Quote', hint: 'Set a passage apart', icon: Quote, keys: 'blockquote', run: (c) => c.toggleBlockquote() },
  { key: 'code', label: 'Code Block', hint: 'Monospaced text', icon: SquareCode, keys: 'pre snippet', run: (c) => c.toggleCodeBlock() },
  { key: 'table', label: 'Table', hint: '3 x 3 with a header row', icon: TableIcon, keys: 'grid', run: (c) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }) },
  { key: 'divider', label: 'Divider', hint: 'A horizontal rule', icon: Minus, keys: 'hr line rule', run: (c) => c.setHorizontalRule() },
  { key: 'date', label: "Today's Date", hint: 'Insert the date', icon: CalendarDays, keys: 'today now', run: (c) => c.insertContent(`${formatDate(new Date())} `) },
];

function buildExtensions(placeholder) {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      link: { openOnClick: false, autolink: true, HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' } },
    }),
    Highlight,
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Table.configure({ resizable: false }),
    TableRow, TableHeader, TableCell,
    Placeholder.configure({ placeholder }),
  ];
}

function Btn({ icon: Icon, label, active, disabled, onClick }) {
  return (
    <button type="button" className={`nt-tb-btn${active ? ' is-on' : ''}`} title={label} aria-label={label}
      aria-pressed={active ? 'true' : undefined} disabled={disabled} tabIndex={-1}
      // onMouseDown keeps the editor's selection; a click would blur it first.
      onMouseDown={(e) => { e.preventDefault(); if (!disabled) onClick(); }}>
      <Icon size={15} strokeWidth={1.9} aria-hidden="true" />
    </button>
  );
}
const Sep = () => <span className="nt-tb-sep" aria-hidden="true" />;

export default function NoteEditor({
  value, onChange, readOnly = false, people, placeholder = "Write anything. Type / for blocks, @ to mention someone.",
  onMakeTask, autoFocus = false, toolbar = true, compact = false,
}) {
  const [menu, setMenu] = useState(null);   // { kind: 'slash'|'mention', query, from, index }
  const [link, setLink] = useState(null);   // { href } while the link bar is open
  const changeRef = useRef(onChange);
  useEffect(() => { changeRef.current = onChange; }, [onChange]);
  const scanRef = useRef(() => {});
  const keyRef = useRef(() => false);
  // Only a person's edit is a change. Loading a note can make the editor
  // adjust it by itself (a trailing paragraph after a list, attribute order),
  // and passing that on saved every note just for being opened.
  const touched = useRef(false);
  const touch = () => { touched.current = true; };

  const editor = useEditor({
    // eslint-disable-next-line react-hooks/exhaustive-deps
    extensions: useMemo(() => buildExtensions(placeholder), []),
    content: value || '',
    editable: !readOnly,
    autofocus: autoFocus ? 'end' : false,
    shouldRerenderOnTransaction: true,
    onUpdate: ({ editor: ed }) => { if (touched.current) changeRef.current?.(ed.getHTML()); scanRef.current(ed); },
    onSelectionUpdate: ({ editor: ed }) => scanRef.current(ed),
    editorProps: {
      attributes: { class: 'nt-prose', 'aria-label': 'Note text', role: 'textbox', 'aria-multiline': 'true' },
      handleKeyDown: (_view, event) => { touched.current = true; return keyRef.current(event); },
      handleDOMEvents: {
        beforeinput: () => { touched.current = true; return false; },
        paste: () => { touched.current = true; return false; },
        drop: () => { touched.current = true; return false; },
        cut: () => { touched.current = true; return false; },
        change: () => { touched.current = true; return false; },   // a checklist box
      },
    },
  });

  useEffect(() => { if (editor && !editor.isDestroyed) editor.setEditable(!readOnly); }, [editor, readOnly]);

  // A different note (or a server copy taken over) replaces the content;
  // guarded on equality so it never fights typing.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const next = value || '';
    if (next !== editor.getHTML()) editor.commands.setContent(next, { emitUpdate: false });
  }, [value, editor]);

  const items = useMemo(() => {
    if (!menu) return [];
    if (menu.kind === 'mention') return matchPeople(people || [], menu.query, { limit: 6 });
    const q = menu.query.toLowerCase();
    return SLASH.filter((s) => !q || s.label.toLowerCase().includes(q) || (s.keys || '').includes(q)).slice(0, 12);
  }, [menu, people]);

  useEffect(() => {
    scanRef.current = (ed) => {
      if (readOnly) return;
      const { from, empty } = ed.state.selection;
      if (!empty) { setMenu(null); return; }
      const before = ed.state.doc.textBetween(Math.max(0, from - 60), from, '\n', '￼');
      let m = /(^|\s)\/([\w ]{0,20})$/.exec(before);
      if (m && !/ {2}/.test(m[2])) {
        setMenu((p) => ({ kind: 'slash', query: m[2], from: from - m[2].length - 1, index: p?.kind === 'slash' ? p.index : 0 }));
        return;
      }
      m = people?.length ? /(^|[\s(])@([\w.\-']{0,40})$/.exec(before) : null;
      if (m) {
        setMenu((p) => ({ kind: 'mention', query: m[2], from: from - m[2].length - 1, index: p?.kind === 'mention' ? p.index : 0 }));
        return;
      }
      setMenu(null);
    };
  }, [people, readOnly]);

  const choose = useCallback((item) => {
    if (!editor || !menu || !item) return;
    touched.current = true;
    const range = { from: menu.from, to: editor.state.selection.from };
    if (menu.kind === 'mention') {
      editor.chain().focus().deleteRange(range).insertContent([
        { type: 'text', marks: [{ type: 'link', attrs: { href: `mailto:${item.email}` } }], text: `@${item.name}` },
        { type: 'text', text: ' ' },
      ]).unsetMark('link').run();
    } else {
      item.run(editor.chain().focus().deleteRange(range)).run();
    }
    setMenu(null);
  }, [editor, menu]);

  const openLink = () => {
    if (!editor) return;
    setLink({ href: editor.getAttributes('link')?.href || '' });
  };

  useEffect(() => {
    keyRef.current = (event) => {
      if (menu && items.length) {
        if (event.key === 'ArrowDown') { event.preventDefault(); setMenu((m) => ({ ...m, index: (m.index + 1) % items.length })); return true; }
        if (event.key === 'ArrowUp') { event.preventDefault(); setMenu((m) => ({ ...m, index: (m.index - 1 + items.length) % items.length })); return true; }
        if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); choose(items[menu.index] || items[0]); return true; }
      }
      if (menu && event.key === 'Escape') { event.preventDefault(); setMenu(null); return true; }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openLink(); return true; }
      return false;
    };
  });

  const applyLink = (href) => {
    const v = (href || '').trim();
    touch();
    const chain = editor.chain().focus().extendMarkRange('link');
    if (!v) chain.unsetLink().run();
    else chain.setLink({ href: /^(https?:|mailto:)/i.test(v) ? v : `https://${v}` }).run();
    setLink(null);
  };

  const makeTask = () => {
    if (!editor || !onMakeTask) return;
    const { from, to, empty, $from } = editor.state.selection;
    const text = empty ? $from.parent.textContent : editor.state.doc.textBetween(from, to, ' ');
    onMakeTask(text.replace(/\s+/g, ' ').trim());
  };

  // The menu floats under the caret, kept on screen.
  let menuPos = null;
  if (menu && items.length && editor && !editor.isDestroyed) {
    try {
      const c = editor.view.coordsAtPos(Math.min(menu.from, editor.state.doc.content.size));
      const w = 260, h = Math.min(items.length * 44 + 12, 340);
      const vw = window.innerWidth, vh = window.innerHeight;
      menuPos = { left: Math.max(8, Math.min(c.left, vw - w - 8)), top: c.bottom + h + 8 > vh ? Math.max(8, c.top - h - 6) : c.bottom + 6, width: w };
    } catch { menuPos = null; }
  }

  const e = editor;
  const on = (name, attrs) => !!e?.isActive(name, attrs);
  const run = (fn) => () => { if (e) { touch(); fn(e.chain().focus()).run(); } };
  const inTable = on('table');

  return (
    <div className={`nt-editor${compact ? ' is-compact' : ''}${readOnly ? ' is-readonly' : ''}`}>
      {toolbar && !readOnly && (
        <div className="nt-toolbar" role="toolbar" aria-label="Formatting">
          <Btn icon={Undo2} label="Undo (Ctrl+Z)" disabled={!e?.can().undo()} onClick={run((c) => c.undo())} />
          <Btn icon={Redo2} label="Redo (Ctrl+Y)" disabled={!e?.can().redo()} onClick={run((c) => c.redo())} />
          <Sep />
          <Btn icon={Heading1} label="Heading 1" active={on('heading', { level: 1 })} onClick={run((c) => c.toggleHeading({ level: 1 }))} />
          <Btn icon={Heading2} label="Heading 2" active={on('heading', { level: 2 })} onClick={run((c) => c.toggleHeading({ level: 2 }))} />
          <Btn icon={Heading3} label="Heading 3" active={on('heading', { level: 3 })} onClick={run((c) => c.toggleHeading({ level: 3 }))} />
          <Sep />
          <Btn icon={Bold} label="Bold (Ctrl+B)" active={on('bold')} onClick={run((c) => c.toggleBold())} />
          <Btn icon={Italic} label="Italic (Ctrl+I)" active={on('italic')} onClick={run((c) => c.toggleItalic())} />
          <Btn icon={Underline} label="Underline (Ctrl+U)" active={on('underline')} onClick={run((c) => c.toggleUnderline())} />
          <Btn icon={Strikethrough} label="Strikethrough" active={on('strike')} onClick={run((c) => c.toggleStrike())} />
          <Btn icon={Highlighter} label="Highlight" active={on('highlight')} onClick={run((c) => c.toggleHighlight())} />
          <Btn icon={Code} label="Inline Code" active={on('code')} onClick={run((c) => c.toggleCode())} />
          <Sep />
          <Btn icon={ListChecks} label="Checklist (Ctrl+Shift+9)" active={on('taskList')} onClick={run((c) => c.toggleTaskList())} />
          <Btn icon={List} label="Bulleted List" active={on('bulletList')} onClick={run((c) => c.toggleBulletList())} />
          <Btn icon={ListOrdered} label="Numbered List" active={on('orderedList')} onClick={run((c) => c.toggleOrderedList())} />
          <Btn icon={IndentIncrease} label="Indent (Tab)" disabled={!(e?.can().sinkListItem('listItem') || e?.can().sinkListItem('taskItem'))}
            onClick={run((c) => (e.can().sinkListItem('taskItem') ? c.sinkListItem('taskItem') : c.sinkListItem('listItem')))} />
          <Btn icon={IndentDecrease} label="Outdent (Shift+Tab)" disabled={!(e?.can().liftListItem('listItem') || e?.can().liftListItem('taskItem'))}
            onClick={run((c) => (e.can().liftListItem('taskItem') ? c.liftListItem('taskItem') : c.liftListItem('listItem')))} />
          <Sep />
          <Btn icon={Quote} label="Quote" active={on('blockquote')} onClick={run((c) => c.toggleBlockquote())} />
          <Btn icon={SquareCode} label="Code Block" active={on('codeBlock')} onClick={run((c) => c.toggleCodeBlock())} />
          <Btn icon={Link2} label="Link (Ctrl+K)" active={on('link')} onClick={openLink} />
          <Btn icon={TableIcon} label="Insert Table" onClick={run((c) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }))} />
          <Sep />
          <Btn icon={AlignLeft} label="Align Left" active={on({ textAlign: 'left' })} onClick={run((c) => c.setTextAlign('left'))} />
          <Btn icon={AlignCenter} label="Align Center" active={on({ textAlign: 'center' })} onClick={run((c) => c.setTextAlign('center'))} />
          <Btn icon={AlignRight} label="Align Right" active={on({ textAlign: 'right' })} onClick={run((c) => c.setTextAlign('right'))} />
          {onMakeTask && (<>
            <Sep />
            <button type="button" className="nt-tb-text" tabIndex={-1} title="Make a task from the selection or the current line"
              onMouseDown={(ev) => { ev.preventDefault(); makeTask(); }}>
              <ListPlus size={15} strokeWidth={1.9} aria-hidden="true" /> Make a Task
            </button>
          </>)}
        </div>
      )}
      {!readOnly && inTable && (
        <div className="nt-subbar" role="toolbar" aria-label="Table">
          <span className="nt-subbar-label">Table</span>
          <button type="button" tabIndex={-1} onMouseDown={(ev) => { ev.preventDefault(); touch(); e.chain().focus().addRowAfter().run(); }}><Rows3 size={14} aria-hidden="true" /> Add Row</button>
          <button type="button" tabIndex={-1} onMouseDown={(ev) => { ev.preventDefault(); touch(); e.chain().focus().addColumnAfter().run(); }}><Columns3 size={14} aria-hidden="true" /> Add Column</button>
          <button type="button" tabIndex={-1} onMouseDown={(ev) => { ev.preventDefault(); touch(); e.chain().focus().deleteRow().run(); }}>Delete Row</button>
          <button type="button" tabIndex={-1} onMouseDown={(ev) => { ev.preventDefault(); touch(); e.chain().focus().deleteColumn().run(); }}>Delete Column</button>
          <button type="button" tabIndex={-1} onMouseDown={(ev) => { ev.preventDefault(); touch(); e.chain().focus().deleteTable().run(); }}><Trash2 size={14} aria-hidden="true" /> Delete Table</button>
        </div>
      )}
      {link && (
        <form className="nt-subbar" onSubmit={(ev) => { ev.preventDefault(); applyLink(link.href); }}>
          <Link2 size={14} aria-hidden="true" />
          <input autoFocus value={link.href} onChange={(ev) => setLink({ href: ev.target.value })} placeholder="Paste or type a link"
            aria-label="Link address" onKeyDown={(ev) => { if (ev.key === 'Escape') { ev.preventDefault(); setLink(null); e?.commands.focus(); } }} />
          <button type="submit"><Check size={14} aria-hidden="true" /> Apply</button>
          {on('link') && <button type="button" onClick={() => applyLink('')}>Remove Link</button>}
          <button type="button" aria-label="Close" onClick={() => { setLink(null); e?.commands.focus(); }}><X size={14} aria-hidden="true" /></button>
        </form>
      )}
      <EditorContent editor={editor} className="nt-content" />
      {menuPos && createPortal(
        <div className="nt-menu" role="listbox" aria-label={menu.kind === 'mention' ? 'Mention someone' : 'Insert a block'}
          style={{ left: menuPos.left, top: menuPos.top, width: menuPos.width }}>
          {items.map((it, i) => {
            const Icon = it.icon;
            return (
              <button key={it.key || it.email} type="button" role="option" aria-selected={i === menu.index}
                className={`nt-menu-row${i === menu.index ? ' is-on' : ''}`}
                onMouseDown={(ev) => { ev.preventDefault(); choose(it); }}
                onMouseEnter={() => setMenu((m) => (m ? { ...m, index: i } : m))}>
                {Icon ? <Icon size={16} strokeWidth={1.8} aria-hidden="true" /> : <span className="nt-menu-at" aria-hidden="true">@</span>}
                <span className="nt-menu-main">
                  <span className="nt-menu-label">{it.label || it.name}</span>
                  <span className="nt-menu-hint">{it.hint || it.email}</span>
                </span>
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}

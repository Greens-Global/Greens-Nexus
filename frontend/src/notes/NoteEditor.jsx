// The Notes editor (Oct 29 2026): TipTap with the formatting a scratchpad
// needs - headings, lists, checklists, quote, code, tables, highlight, links,
// alignment - plus Markdown shortcuts (StarterKit's input rules: "# ", "- ",
// "1. ", "[ ] ", "> ", "```", **bold**), a "/" menu of blocks and @mentions
// from Nexus People. A mention is a mailto link (the task editor's shape), so
// it stays readable anywhere the HTML lands; a note is private, so a mention
// notifies nobody. "Make a Task" turns the selection or the current line into
// a task (the page does the creating).
//
// Voice notes, videos and dictation (Oct 29 2026, noteMedia.jsx): Record a
// Voice Note and Add Video keep a player in the note; Dictate types what you
// say. On a phone the formatting moves to a bar that rides on top of the
// keyboard - lists, indent and the microphone first, the rest behind Aa.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useEditor, EditorContent } from '@tiptap/react';
import { buildExtensions } from './noteExtensions';
import {
  Undo2, Redo2, Bold, Italic, Underline, Strikethrough, Highlighter, Code, Heading1, Heading2, Heading3,
  List, ListOrdered, ListChecks, IndentIncrease, IndentDecrease, Quote, SquareCode, AlignLeft, AlignCenter,
  AlignRight, Link2, Table as TableIcon, Minus, CalendarDays, Pilcrow, ListPlus, Rows3, Columns3, Trash2, Check, X,
  Mic, AudioLines, Clapperboard, Square, Loader2, CaseSensitive, KeyboardOff,
} from 'lucide-react';
import { matchPeople } from '../lib/peopleSearch';
import { formatDate } from '../lib/datetime';
import { useIsMobile } from '../lib/useIsMobile';
import { useKeyboardInset, keyboardUp } from '../lib/useVisualViewport';
import {
  EDITED, mediaKind, checkMedia, mediaFiles, uploadNoteMedia, useVoiceRecorder, useDictation,
  canRecord, canDictate, clock,
} from './noteMedia';

// The notes phone layout (notes.css "phone").
const PHONE = '(max-width: 768px)';

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

// The phone bar's buttons: 44px, an action on click (the mousedown is
// cancelled so the editor keeps its selection and the keyboard stays up).
function PBtn({ icon: Icon, label, active, disabled, danger, onClick, children }) {
  return (
    <button type="button" className={`nt-pb-btn${active ? ' is-on' : ''}${danger ? ' is-danger' : ''}`} aria-label={label} title={label}
      aria-pressed={active === undefined ? undefined : String(!!active)} disabled={disabled}
      onMouseDown={(e) => e.preventDefault()} onClick={onClick}>
      <Icon size={19} strokeWidth={1.9} aria-hidden="true" />{children}
    </button>
  );
}

// Recording, listening, saving a clip or a problem with one: one line.
function MediaStatus({ voice, dictation, busy, error, onDismiss }) {
  if (voice.recording) {
    return (
      <div className="nt-rec" role="status">
        <span className="nt-rec-dot" aria-hidden="true" />
        <span className="nt-rec-text">Recording <b>{clock(voice.seconds)}</b></span>
        <button type="button" className="nt-rec-btn" onMouseDown={(e) => e.preventDefault()} onClick={voice.cancel}>Cancel</button>
        <button type="button" className="nt-rec-btn is-primary" onMouseDown={(e) => e.preventDefault()} onClick={voice.stop}>
          <Square size={12} fill="currentColor" aria-hidden="true" /> Stop and Save
        </button>
      </div>
    );
  }
  if (dictation.listening) {
    return (
      <div className="nt-rec is-listening" role="status">
        <span className="nt-rec-dot" aria-hidden="true" />
        <span className="nt-rec-text">{dictation.interim ? <i>{dictation.interim}</i> : 'Listening - start talking'}</span>
        <button type="button" className="nt-rec-btn is-primary" onMouseDown={(e) => e.preventDefault()} onClick={dictation.stop}>Done</button>
      </div>
    );
  }
  if (busy) {
    return (
      <div className="nt-rec" role="status">
        <Loader2 size={14} className="spin" aria-hidden="true" />
        <span className="nt-rec-text">
          Saving {busy.kind === 'video' ? 'video' : 'voice note'}{busy.progress ? ` ${Math.round(busy.progress * 100)}%` : '…'}
          {busy.waiting ? ` - ${busy.waiting} more waiting` : ''}
        </span>
      </div>
    );
  }
  if (error) {
    return (
      <div className="nt-rec is-bad" role="alert">
        <span className="nt-rec-text">{error}</span>
        <button type="button" className="nt-rec-btn" aria-label="Dismiss" onClick={onDismiss}><X size={13} aria-hidden="true" /></button>
      </div>
    );
  }
  return null;
}

export default function NoteEditor({
  value, onChange, readOnly = false, people, placeholder = "Write anything. Type / for blocks, @ to mention someone.",
  onMakeTask, autoFocus = false, toolbar = true, compact = false, onBusy, collab = null, onRemoteChange,
}) {
  const [menu, setMenu] = useState(null);   // { kind: 'slash'|'mention', query, from, index }
  const [link, setLink] = useState(null);   // { href } while the link bar is open
  const changeRef = useRef(onChange);
  const collabRef = useRef(collab);
  const remoteRef = useRef(onRemoteChange);
  useEffect(() => { remoteRef.current = onRemoteChange; collabRef.current = collab; });
  useEffect(() => { changeRef.current = onChange; }, [onChange]);
  const scanRef = useRef(() => {});
  const keyRef = useRef(() => false);
  // Only a person's edit is a change. Loading a note can make the editor
  // adjust it by itself (a trailing paragraph after a list, attribute order),
  // and passing that on saved every note just for being opened.
  const touched = useRef(false);
  const touch = () => { touched.current = true; };
  const phone = useIsMobile(PHONE);
  const [busy, setBusy] = useState(null);       // { kind, progress } while a clip uploads
  const [mediaErr, setMediaErr] = useState('');
  const [focused, setFocused] = useState(false);
  const [more, setMore] = useState(false);      // the phone bar's Aa row
  const videoInput = useRef(null);
  const mediaRef = useRef(() => {});

  const editor = useEditor({
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // With `collab` (a live co-typing session, useNoteCollab) the shared
    // document owns the words; the parent remounts this editor per session.
    extensions: useMemo(() => buildExtensions(placeholder, collab), []),
    ...(collab ? {} : { content: value || '' }),
    editable: !readOnly,
    autofocus: autoFocus ? 'end' : false,
    shouldRerenderOnTransaction: true,
    // A click inside a player (its Remove) fires no key or input event, so
    // it marks its own transaction (noteMedia.jsx MediaView).
    onUpdate: ({ editor: ed, transaction }) => {
      if (transaction?.getMeta(EDITED)) touched.current = true;
      // Someone else's typing arriving live is theirs to save, not ours.
      const theirs = collabRef.current?.isRemote(transaction);
      if (touched.current && !theirs) changeRef.current?.(ed.getHTML());
      else if (theirs) remoteRef.current?.(ed.getHTML());
      scanRef.current(ed);
    },
    onSelectionUpdate: ({ editor: ed }) => scanRef.current(ed),
    editorProps: {
      attributes: { class: 'nt-prose', 'aria-label': 'Note text', role: 'textbox', 'aria-multiline': 'true' },
      handleKeyDown: (_view, event) => { touched.current = true; return keyRef.current(event); },
      // A voice note or video pasted or dropped in is saved like a recorded one.
      handlePaste: (_view, event) => {
        const files = mediaFiles(event.clipboardData?.files);
        if (!files.length) return false;
        event.preventDefault();
        mediaRef.current(files[0]);
        return true;
      },
      handleDrop: (_view, event, _slice, moved) => {
        const files = moved ? [] : mediaFiles(event.dataTransfer?.files);
        if (!files.length) return false;
        event.preventDefault();
        mediaRef.current(files[0]);
        return true;
      },
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

  // Whether the person is in the note (the phone bar shows while they are).
  // A short grace on blur: tapping a bar button must not flicker it away.
  useEffect(() => {
    if (!editor) return undefined;
    let t;
    const onFocus = () => { clearTimeout(t); setFocused(true); };
    const onBlur = () => { clearTimeout(t); t = setTimeout(() => setFocused(false), 150); };
    editor.on('focus', onFocus);
    editor.on('blur', onBlur);
    return () => { clearTimeout(t); editor.off('focus', onFocus); editor.off('blur', onBlur); };
  }, [editor]);

  // One clip at a time: check, upload with progress, then put the player
  // where the cursor was when it started - moved along with any typing done
  // during the upload. A clip that arrives meanwhile waits its turn.
  const queue = useRef([]);
  const uploading = useRef(false);
  const addMedia = async (file) => {
    if (!editor || editor.isDestroyed || readOnly) return;
    const bad = checkMedia(file);
    if (bad) { setMediaErr(bad); return; }
    if (uploading.current) { queue.current.push(file); setBusy((b) => (b ? { ...b, waiting: queue.current.length } : b)); return; }
    uploading.current = true;
    const kind = mediaKind(file);
    let at = editor.state.selection.to;
    const follow = ({ transaction }) => { at = transaction.mapping.map(at); };
    editor.on('transaction', follow);
    setMediaErr('');
    setBusy({ kind, progress: 0, waiting: queue.current.length });
    try {
      const src = await uploadNoteMedia(file, (p) => setBusy((b) => ({ ...(b || {}), kind, progress: p })));
      if (editor.isDestroyed) return;
      touched.current = true;
      editor.chain().insertContentAt(Math.min(at, editor.state.doc.content.size),
        { type: kind === 'video' ? 'noteVideo' : 'noteAudio', attrs: { src } }).run();
    } catch (err) {
      setMediaErr(`Could not save the ${kind === 'video' ? 'video' : 'voice note'}: ${err?.message || 'try again'}.`.replace(/\.\.$/, '.'));
    } finally {
      editor.off('transaction', follow);
      uploading.current = false;
      const next = queue.current.shift();
      if (next && !editor.isDestroyed) mediaRef.current(next);
      else setBusy(null);
    }
  };
  useEffect(() => { mediaRef.current = addMedia; });

  const voice = useVoiceRecorder((file) => mediaRef.current(file));
  // Dictated words go in at the cursor, with a space when they follow a word.
  const dictation = useDictation((text) => {
    if (!editor || editor.isDestroyed) return;
    touched.current = true;
    const { $from } = editor.state.selection;
    const prev = $from.parentOffset ? $from.parent.textBetween($from.parentOffset - 1, $from.parentOffset, '', ' ') : '';
    editor.chain().focus().insertContent(`${prev && !/\s/.test(prev) ? ' ' : ''}${text}`).run();
  });
  const recordOk = canRecord();
  const dictateOk = canDictate();
  const live = voice.recording || dictation.listening;
  // Recording, listening or saving a clip: the parent must not swap this
  // editor out from under it (Quick Note's first-write hand-over).
  const onBusyRef = useRef(onBusy);
  useEffect(() => { onBusyRef.current = onBusy; }, [onBusy]);
  const working = live || !!busy;
  useEffect(() => { onBusyRef.current?.(working); }, [working]);
  const err = mediaErr || voice.error || dictation.error;
  const clearErr = () => { setMediaErr(''); voice.setError(''); dictation.setError(''); };
  const toggleVoice = () => { clearErr(); if (voice.recording) voice.stop(); else voice.start(); };
  const toggleDictate = () => { clearErr(); if (dictation.listening) dictation.stop(); else dictation.start(); };
  const pickVideo = () => { clearErr(); videoInput.current?.click(); };
  const showPhoneBar = phone && toolbar && !readOnly && (focused || live || !!busy || !!err);
  const inset = useKeyboardInset(showPhoneBar);

  // A different note (or a server copy taken over - someone else's save
  // re-read in place) replaces the content; guarded on equality so it never
  // fights typing, and the cursor stays where it was. Not while co-typing:
  // the shared document brings other people's words itself.
  useEffect(() => {
    if (!editor || editor.isDestroyed || collabRef.current) return;
    const next = value || '';
    if (next === editor.getHTML()) return;
    const { from, to } = editor.state.selection;
    const focused = editor.isFocused;
    editor.commands.setContent(next, { emitUpdate: false });
    if (focused) {
      const size = editor.state.doc.content.size;
      try { editor.commands.setTextSelection({ from: Math.min(from, size), to: Math.min(to, size) }); } catch { /* past the end */ }
    }
  }, [value, editor]);
  // The live session reads the words to save from this editor.
  useEffect(() => { if (editor && collab) collab.bindEditor(editor); }, [editor, collab]);

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
      {toolbar && !readOnly && !phone && (
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
          <Sep />
          {dictateOk && <Btn icon={Mic} label={dictation.listening ? 'Stop Dictating' : 'Dictate - type what you say'} active={dictation.listening}
            disabled={voice.recording} onClick={toggleDictate} />}
          {recordOk && <Btn icon={AudioLines} label={voice.recording ? 'Stop and Save the Voice Note' : 'Record a Voice Note'} active={voice.recording}
            disabled={dictation.listening} onClick={toggleVoice} />}
          <Btn icon={Clapperboard} label="Add a Video" disabled={live} onClick={pickVideo} />
          {onMakeTask && (<>
            <Sep />
            <button type="button" className="nt-tb-text" tabIndex={-1} title="Make a task from the selection or the current line"
              onMouseDown={(ev) => { ev.preventDefault(); makeTask(); }}>
              <ListPlus size={15} strokeWidth={1.9} aria-hidden="true" /> Make a Task
            </button>
          </>)}
        </div>
      )}
      {!readOnly && !phone && <MediaStatus voice={voice} dictation={dictation} busy={busy} error={err} onDismiss={clearErr} />}
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
      <EditorContent editor={editor} className={`nt-content${showPhoneBar ? ' has-phonebar' : ''}`} />
      {!readOnly && (
        <input ref={videoInput} type="file" accept="video/*" hidden aria-hidden="true" tabIndex={-1}
          onChange={(ev) => { const f = ev.target.files?.[0]; ev.target.value = ''; if (f) addMedia(f); }} />
      )}
      {showPhoneBar && e && createPortal(
        <div className="nt-pb" role="toolbar" aria-label="Formatting" style={{ bottom: inset, ...(inset && keyboardUp() ? { paddingBottom: 0 } : null) }}>
          <MediaStatus voice={voice} dictation={dictation} busy={busy} error={err} onDismiss={clearErr} />
          {more && (
            <div className="nt-pb-row is-more">
              <PBtn icon={Heading1} label="Heading 1" active={on('heading', { level: 1 })} onClick={run((c) => c.toggleHeading({ level: 1 }))} />
              <PBtn icon={Heading2} label="Heading 2" active={on('heading', { level: 2 })} onClick={run((c) => c.toggleHeading({ level: 2 }))} />
              <PBtn icon={Bold} label="Bold" active={on('bold')} onClick={run((c) => c.toggleBold())} />
              <PBtn icon={Italic} label="Italic" active={on('italic')} onClick={run((c) => c.toggleItalic())} />
              <PBtn icon={Underline} label="Underline" active={on('underline')} onClick={run((c) => c.toggleUnderline())} />
              <PBtn icon={Strikethrough} label="Strikethrough" active={on('strike')} onClick={run((c) => c.toggleStrike())} />
              <PBtn icon={Highlighter} label="Highlight" active={on('highlight')} onClick={run((c) => c.toggleHighlight())} />
              <PBtn icon={Quote} label="Quote" active={on('blockquote')} onClick={run((c) => c.toggleBlockquote())} />
              <PBtn icon={Link2} label="Link" active={on('link')} onClick={openLink} />
              <PBtn icon={TableIcon} label="Insert Table" onClick={run((c) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }))} />
              <PBtn icon={Minus} label="Divider" onClick={run((c) => c.setHorizontalRule())} />
              {onMakeTask && <PBtn icon={ListPlus} label="Make a Task" onClick={makeTask} />}
              <PBtn icon={Undo2} label="Undo" disabled={!e.can().undo()} onClick={run((c) => c.undo())} />
              <PBtn icon={Redo2} label="Redo" disabled={!e.can().redo()} onClick={run((c) => c.redo())} />
              <PBtn icon={KeyboardOff} label="Hide Keyboard" onClick={() => { setMore(false); e.commands.blur(); }} />
            </div>
          )}
          <div className="nt-pb-main">
          <div className="nt-pb-row">
            <PBtn icon={ListChecks} label="Checklist" active={on('taskList')} onClick={run((c) => c.toggleTaskList())} />
            <PBtn icon={List} label="Bulleted List" active={on('bulletList')} onClick={run((c) => c.toggleBulletList())} />
            <PBtn icon={ListOrdered} label="Numbered List" active={on('orderedList')} onClick={run((c) => c.toggleOrderedList())} />
            <PBtn icon={IndentDecrease} label="Outdent" disabled={!(e.can().liftListItem('listItem') || e.can().liftListItem('taskItem'))}
              onClick={run((c) => (e.can().liftListItem('taskItem') ? c.liftListItem('taskItem') : c.liftListItem('listItem')))} />
            <PBtn icon={IndentIncrease} label="Indent" disabled={!(e.can().sinkListItem('listItem') || e.can().sinkListItem('taskItem'))}
              onClick={run((c) => (e.can().sinkListItem('taskItem') ? c.sinkListItem('taskItem') : c.sinkListItem('listItem')))} />
            <span className="nt-pb-sep" aria-hidden="true" />
            {dictateOk && <PBtn icon={Mic} label={dictation.listening ? 'Stop Dictating' : 'Dictate'} active={dictation.listening} danger={dictation.listening}
              disabled={voice.recording} onClick={toggleDictate} />}
            {recordOk && <PBtn icon={AudioLines} label={voice.recording ? 'Stop and Save the Voice Note' : 'Record a Voice Note'} active={voice.recording}
              danger={voice.recording} disabled={dictation.listening} onClick={toggleVoice} />}
            <PBtn icon={Clapperboard} label="Add a Video" disabled={live} onClick={pickVideo} />
          </div>
          {/* Aa stays put at the right edge; the row beside it scrolls if it must. */}
          <PBtn icon={CaseSensitive} label="More Formatting" active={more} onClick={() => setMore((m) => !m)} />
          </div>
        </div>,
        document.body,
      )}
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

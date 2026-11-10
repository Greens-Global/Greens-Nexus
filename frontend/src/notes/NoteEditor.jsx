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
// On the web they sit, named, at the right of the toolbar, which never
// scrolls them out of sight - the formatting wraps instead - and the "/" menu
// offers them too (Neil, Oct 31 2026: "i can't seem to find them").
//
// Photos and Start With (Neil, 11/10/2026): Photo (a computer) and Photo or
// Video (the phone bar: the phone offers its camera, the library or a file)
// keep a small tile that opens full size (noteMedia.jsx); a picture pasted
// or dropped in is saved the same way. An empty note offers what it can
// start as - Text, Checklist, Bulleted List, Numbered List, Table, Photo or
// a template - so a list or a table is one tap (StartWith).
//
// Record Links (Neil, 11/06/2026, recordLink.jsx): [[ opens a picker of
// notes, tasks, jobs and Knowledge Base pages and puts a chip that opens the
// record; Link to a Record sits in the toolbar, the phone bar's Aa row and
// the "/" menu.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useEditor, EditorContent } from '@tiptap/react';
import { buildExtensions } from './noteExtensions';
import {
  Undo2, Redo2, Bold, Italic, Underline, Strikethrough, Highlighter, Code, Heading1, Heading2, Heading3,
  List, ListOrdered, ListChecks, IndentIncrease, IndentDecrease, Quote, SquareCode, AlignLeft, AlignCenter,
  AlignRight, Link2, Table as TableIcon, Minus, CalendarDays, Pilcrow, ListPlus, Rows3, Columns3, Trash2, Check, X,
  Mic, AudioLines, Clapperboard, Square, Loader2, CaseSensitive, KeyboardOff, PenTool, FileSymlink,
  Info, Lightbulb, TriangleAlert, ListCollapse,
  ListTodo, Camera, ImagePlus, Type as TypeIcon, LayoutTemplate,
} from 'lucide-react';
import { matchPeople } from '../lib/peopleSearch';
import { formatDate } from '../lib/datetime';
import { useIsMobile } from '../lib/useIsMobile';
import { useKeyboardInset, keyboardUp } from '../lib/useVisualViewport';
import BoardPicker from './board/BoardPicker';
import { useRecordSearch, recordContent, RECORD_META } from './recordLink';
import { boxesKey, syncBoxesFromTasks, listenForBoxTicks } from './checklistTasks';
import { TextSelection } from '@tiptap/pm/state';
import {
  EDITED, noteMediaKind, checkNoteMedia, mediaFiles, uploadNoteMedia, useVoiceRecorder, useDictation,
  canRecord, canDictate, clock,
} from './noteMedia';
import NoteTemplatePicker from './NoteTemplatePicker';
import { noteTemplate } from './noteTemplates';

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
  { key: 'livelist', label: 'Live Task List', hint: 'My tasks or a project, always up to date', icon: ListTodo, keys: 'tasks project embed view live list todo', run: (c) => c.insertLiveList() },
  { key: 'callout', label: 'Callout', hint: 'A note set apart in a box', icon: Info, keys: 'note box info aside', run: (c) => c.setCallout('info') },
  { key: 'tip', label: 'Tip Callout', hint: 'A helpful tip in a box', icon: Lightbulb, keys: 'callout hint idea', run: (c) => c.setCallout('tip') },
  { key: 'warning', label: 'Warning Callout', hint: 'Something to watch out for', icon: TriangleAlert, keys: 'callout caution danger alert', run: (c) => c.setCallout('warning') },
  { key: 'toggle', label: 'Toggle', hint: 'A section that folds away', icon: ListCollapse, keys: 'collapse fold expand details accordion', run: (c) => c.setToggle() },
  { key: 'record', label: 'Link to a Record', hint: 'A note, task, job or page - or type [[', icon: FileSymlink, keys: 'page note task job board kb knowledge mention backlink [[', run: (c) => c.insertContent('[[') },
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
// The toolbar's capture buttons carry their name beside the icon (the name
// folds away when the toolbar is narrow - notes.css).
function TBtn({ icon: Icon, label, text, active, disabled, danger, keep, onClick }) {
  return (
    <button type="button" className={`nt-tb-text${active ? ' is-on' : ''}${danger ? ' is-danger' : ''}${keep ? ' is-key' : ''}`} title={label} aria-label={label}
      aria-pressed={active === undefined ? undefined : String(!!active)} disabled={disabled} tabIndex={-1}
      onMouseDown={(e) => { e.preventDefault(); if (!disabled) onClick(); }}>
      <Icon size={15} strokeWidth={1.9} aria-hidden="true" /><span className="nt-tb-word">{text}</span>
    </button>
  );
}

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
// What an empty note can start as (Neil, 11/10/2026: "templates of if we want
// to make it a list or a table or just regular text"). One tap shapes the
// first line; it goes away as soon as the note has anything in it.
const STARTS = [
  { key: 'text', label: 'Text', icon: TypeIcon },
  { key: 'check', label: 'Checklist', icon: ListChecks },
  { key: 'bullet', label: 'Bulleted List', short: 'Bullets', icon: List },
  { key: 'number', label: 'Numbered List', short: 'Numbered', icon: ListOrdered },
  { key: 'table', label: 'Table', icon: TableIcon },
  { key: 'photo', label: 'Photo', icon: Camera },
  { key: 'templates', label: 'Templates', icon: LayoutTemplate },
];
function StartWith({ phone, onPick }) {
  return (
    <div className="nt-start" role="group" aria-label="Start this note as">
      <span className="nt-start-label">Start with</span>
      <div className="nt-start-row">
        {STARTS.map((s) => (
          <button key={s.key} type="button" className="nt-start-chip" onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(s.key)}
            aria-label={s.key === 'templates' ? 'Templates - meeting notes, site walk, handover and your own' : `Start with ${s.label}`}>
            <s.icon size={16} strokeWidth={1.9} aria-hidden="true" />
            <span>{phone && s.short ? s.short : s.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

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
          Saving {busy.kind === 'video' ? 'video' : busy.kind === 'image' ? 'photo' : 'voice note'}{busy.progress ? ` ${Math.round(busy.progress * 100)}%` : '…'}
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
  value, onChange, readOnly = false, people, placeholder = "Write anything. Type / for blocks, @ to mention someone, [[ to link a record.",
  onMakeTask, autoFocus = false, toolbar = true, compact = false, onBusy, collab = null, onRemoteChange, noteId = '',
  starters = true,
}) {
  const [menu, setMenu] = useState(null);   // { kind: 'slash'|'mention'|'record', query, from, index }
  const [link, setLink] = useState(null);   // { href } while the link bar is open
  const [boardPick, setBoardPick] = useState(false);   // Insert Board picker (board/BoardPicker.jsx)
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
  const photoInput = useRef(null);   // Photo (image/*) on a computer; Photo or Video on a phone
  const [tplOpen, setTplOpen] = useState(false);
  const mediaRef = useRef(() => {});
  const actRef = useRef({});
  // Checklist lines that are tasks (checklistTasks.js): when the set of task
  // boxes changes (the note loads, a line becomes a task), their ticks are
  // brought up to date with the tasks - editors only.
  const boxesRef = useRef(() => {});

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
      boxesRef.current(ed);
    },
    onCreate: ({ editor: ed }) => boxesRef.current(ed),
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
    const bad = checkNoteMedia(file);
    if (bad) { setMediaErr(bad); return; }
    if (uploading.current) { queue.current.push(file); setBusy((b) => (b ? { ...b, waiting: queue.current.length } : b)); return; }
    uploading.current = true;
    const kind = noteMediaKind(file);
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
        { type: kind === 'video' ? 'noteVideo' : kind === 'image' ? 'noteImage' : 'noteAudio', attrs: { src } }).run();
    } catch (err) {
      setMediaErr(`Could not save the ${kind === 'video' ? 'video' : kind === 'image' ? 'photo' : 'voice note'}: ${err?.message || 'try again'}.`.replace(/\.\.$/, '.'));
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
  const pickPhoto = () => { clearErr(); photoInput.current?.click(); };
  const openBoardPick = () => { if (!readOnly) setBoardPick(true); };
  const insertBoard = (attrs) => { setBoardPick(false); if (!editor) return; touched.current = true; editor.chain().focus().setMeta(EDITED, true).insertBoard(attrs).run(); };
  useEffect(() => { actRef.current = { dictate: toggleDictate, voice: toggleVoice, video: pickVideo, photo: pickPhoto, board: openBoardPick }; });
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

  const records = useRecordSearch(menu?.kind === 'record' ? menu.query : null, noteId);
  const items = useMemo(() => {
    if (!menu) return [];
    if (menu.kind === 'record') return records.rows;
    if (menu.kind === 'mention') return matchPeople(people || [], menu.query, { limit: 6 });
    const q = menu.query.toLowerCase();
    // Dictate, Voice Note and Video from the "/" menu too, where the browser can.
    const capture = [
      dictateOk && { key: 'dictate', label: 'Dictate', hint: 'Type what you say', icon: Mic, keys: 'voice speech talk speak mic', act: 'dictate' },
      recordOk && { key: 'voice', label: 'Voice Note', hint: 'Record a clip that stays in the note', icon: AudioLines, keys: 'audio record recording mic', act: 'voice' },
      { key: 'photo', label: 'Photo', hint: 'A picture - or paste one with Ctrl+V', icon: ImagePlus, keys: 'picture image camera snap pic', act: 'photo' },
      { key: 'video', label: 'Video', hint: 'Add a clip from this computer', icon: Clapperboard, keys: 'movie clip film', act: 'video' },
      { key: 'board', label: 'Board', hint: 'Insert one of your boards', icon: PenTool, keys: 'whiteboard drawing sketch markup', act: 'board' },
    ].filter(Boolean);
    return [...SLASH, ...(live ? [] : capture)].filter((s) => !q || s.label.toLowerCase().includes(q) || (s.keys || '').includes(q)).slice(0, 24);
  }, [menu, people, dictateOk, recordOk, live, records.rows]);

  useEffect(() => {
    scanRef.current = (ed) => {
      if (readOnly) return;
      const { from, empty } = ed.state.selection;
      if (!empty) { setMenu(null); return; }
      const before = ed.state.doc.textBetween(Math.max(0, from - 60), from, '\n', '￼');
      // [[ - a link to a record; what follows is the search (recordLink.jsx).
      let m = /\[\[([^[\]\n￼]{0,40})$/.exec(before);
      if (m) {
        setMenu((p) => ({ kind: 'record', query: m[1], from: from - m[1].length - 2, index: p?.kind === 'record' ? p.index : 0 }));
        return;
      }
      m = /(^|\s)\/([\w ]{0,20})$/.exec(before);
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
    if (menu.kind === 'record') {
      editor.chain().focus().deleteRange(range).insertContent(recordContent(item)).run();
    } else if (menu.kind === 'mention') {
      editor.chain().focus().deleteRange(range).insertContent([
        { type: 'text', marks: [{ type: 'link', attrs: { href: `mailto:${item.email}` } }], text: `@${item.name}` },
        { type: 'text', text: ' ' },
      ]).unsetMark('link').run();
    } else if (item.act) {
      editor.chain().focus().deleteRange(range).run();
      actRef.current[item.act]?.();
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

  // Link to a Record from a button: types the [[ that opens the picker.
  const startRecordLink = () => {
    if (!editor || readOnly) return;
    touch();
    editor.chain().focus().insertContent('[[').run();
  };

  // The line (or selection) becomes a link to the task it made, on a
  // checklist line, so ticking it finishes the task (checklistTasks.js). If
  // the note changed while the task was being made, the words stay as they
  // are - the notice still opens the task.
  const makeTask = async () => {
    if (!editor || !onMakeTask) return;
    const { from, to, empty, $from } = editor.state.selection;
    const text = (empty ? $from.parent.textContent : editor.state.doc.textBetween(from, to, ' ')).replace(/\s+/g, ' ').trim();
    const range = empty ? { from: $from.start(), to: $from.end() } : { from, to };
    const before = editor.state.doc;
    const task = await onMakeTask(text);
    if (!task?.id || !text || editor.isDestroyed || editor.state.doc !== before) return;
    touched.current = true;
    const chain = editor.chain().setMeta(EDITED, true)
      .insertContentAt(range, recordContent({ kind: 'task', id: task.id, title: task.title || text }));
    const inList = ['taskItem', 'listItem'].includes($from.node(Math.max(0, $from.depth - 1))?.type?.name);
    (inList || !empty ? chain : chain.setTextSelection(range.from).toggleTaskList())
      // The cursor after the link, so the next Enter starts a new line, never an empty one above it.
      .command(({ tr }) => { tr.setSelection(TextSelection.create(tr.doc, tr.selection.$from.end())); return true; })
      .run();
  };

  useEffect(() => {
    if (!editor || readOnly) { boxesRef.current = () => {}; return undefined; }
    let key = null;
    let timer = 0;
    boxesRef.current = (ed) => {
      const k = boxesKey(ed.state.doc);
      if (k === key) return;
      key = k;
      clearTimeout(timer);
      if (k) timer = setTimeout(() => { syncBoxesFromTasks(ed, EDITED).then((n) => { if (n) touched.current = true; }); }, 600);
    };
    boxesRef.current(editor);
    const off = listenForBoxTicks(editor, EDITED, setMediaErr);
    return () => { clearTimeout(timer); off(); boxesRef.current = () => {}; };
  }, [editor, readOnly]);

  // The menu floats under the caret, kept on screen.
  let menuPos = null;
  // The record picker shows even with no rows yet: it says it is looking, or found nothing.
  if (menu && (items.length || menu.kind === 'record') && editor && !editor.isDestroyed) {
    try {
      const c = editor.view.coordsAtPos(Math.min(menu.from, editor.state.doc.content.size));
      const w = menu.kind === 'record' ? 320 : 260, h = Math.min(Math.max(1, items.length) * 44 + 12, 340);
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
          <div className="nt-tb-fmt">
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
          <Btn icon={Info} label="Callout - a note in a box" active={on('callout')} onClick={run((c) => c.setCallout('info'))} />
          <Btn icon={ListCollapse} label="Toggle - a section that folds away" active={on('toggle')} onClick={run((c) => c.setToggle())} />
          <Btn icon={SquareCode} label="Code Block" active={on('codeBlock')} onClick={run((c) => c.toggleCodeBlock())} />
          <Btn icon={Minus} label="Divider" onClick={run((c) => c.setHorizontalRule())} />
          <Btn icon={Link2} label="Link (Ctrl+K)" active={on('link')} onClick={openLink} />
          <Btn icon={FileSymlink} label="Link to a Record - a note, task, job or page ([[)" onClick={startRecordLink} />
          <Btn icon={TableIcon} label="Insert Table" onClick={run((c) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }))} />
          <Sep />
          <Btn icon={AlignLeft} label="Align Left" active={on({ textAlign: 'left' })} onClick={run((c) => c.setTextAlign('left'))} />
          <Btn icon={AlignCenter} label="Align Center" active={on({ textAlign: 'center' })} onClick={run((c) => c.setTextAlign('center'))} />
          <Btn icon={AlignRight} label="Align Right" active={on({ textAlign: 'right' })} onClick={run((c) => c.setTextAlign('right'))} />
          </div>
          <div className="nt-tb-capture">
          {dictateOk && <TBtn icon={Mic} text={dictation.listening ? 'Stop' : 'Dictate'} label={dictation.listening ? 'Stop Dictating' : 'Dictate - type what you say'}
            active={dictation.listening} danger={dictation.listening} keep disabled={voice.recording} onClick={toggleDictate} />}
          {recordOk && <TBtn icon={AudioLines} text={voice.recording ? 'Stop and Save' : 'Voice Note'} label={voice.recording ? 'Stop and Save the Voice Note' : 'Record a Voice Note'}
            active={voice.recording} danger={voice.recording} disabled={dictation.listening} onClick={toggleVoice} />}
          <TBtn icon={ImagePlus} text="Photo" label="Add a Photo - or paste one with Ctrl+V" disabled={live} onClick={pickPhoto} />
          <TBtn icon={Clapperboard} text="Video" label="Add a Video" disabled={live} onClick={pickVideo} />
          <TBtn icon={PenTool} text="Board" label="Insert Board - one of your boards, as a picture that opens it" active={boardPick} onClick={openBoardPick} />
          <Btn icon={ListTodo} label="Live Task List - my tasks or a project, always up to date" onClick={run((c) => c.insertLiveList())} />
          {onMakeTask && <TBtn icon={ListPlus} text="Make a Task" label="Make a Task - from the selection or the current line" onClick={makeTask} />}
          </div>
        </div>
      )}
      {!readOnly && !phone && <MediaStatus voice={voice} dictation={dictation} busy={busy} error={err} onDismiss={clearErr} />}
      {boardPick && <BoardPicker phone={phone} onClose={() => setBoardPick(false)} onPick={insertBoard} />}
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
      {!readOnly && (
        // No `capture`: the phone then asks Take Photo or Video / Photo Library / Choose File.
        // Several at once go in one after another (addMedia's queue).
        <input ref={photoInput} type="file" accept={phone ? 'image/*,video/*' : 'image/*'} multiple hidden aria-hidden="true" tabIndex={-1}
          onChange={(ev) => { const files = [...(ev.target.files || [])]; ev.target.value = ''; files.forEach((f) => addMedia(f)); }} />
      )}
      {!readOnly && starters && e && e.isEmpty && !live && !busy && (
        <StartWith phone={phone} onPick={(key) => {
          touch();
          if (key === 'photo') { pickPhoto(); return; }
          if (key === 'templates') { setTplOpen(true); return; }
          const c = e.chain().focus();
          if (key === 'check') c.toggleTaskList().run();
          else if (key === 'bullet') c.toggleBulletList().run();
          else if (key === 'number') c.toggleOrderedList().run();
          else if (key === 'table') c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
          else c.setParagraph().run();
        }} />
      )}
      {tplOpen && (
        <NoteTemplatePicker onClose={() => setTplOpen(false)}
          onPick={(key) => { const t = noteTemplate(key); setTplOpen(false); if (t && e) { touch(); e.chain().focus().setMeta(EDITED, true).insertContent(t.body()).run(); } }}
          onPickNote={(n) => { setTplOpen(false); if (n?.body && e) { touch(); e.chain().focus().setMeta(EDITED, true).insertContent(n.body).run(); } }} />
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
              <PBtn icon={Info} label="Callout" active={on('callout')} onClick={run((c) => c.setCallout('info'))} />
              <PBtn icon={ListCollapse} label="Toggle" active={on('toggle')} onClick={run((c) => c.setToggle())} />
              <PBtn icon={Link2} label="Link" active={on('link')} onClick={openLink} />
              <PBtn icon={FileSymlink} label="Link to a Record" onClick={() => { setMore(false); startRecordLink(); }} />
              <PBtn icon={TableIcon} label="Insert Table" onClick={run((c) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }))} />
              <PBtn icon={Minus} label="Divider" onClick={run((c) => c.setHorizontalRule())} />
              <PBtn icon={PenTool} label="Insert Board" active={boardPick} onClick={() => { setMore(false); openBoardPick(); }} />
              <PBtn icon={ListTodo} label="Live Task List" onClick={run((c) => c.insertLiveList())} />
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
            <PBtn icon={Camera} label="Photo or Video - take one or pick from the library" disabled={live} onClick={pickPhoto} />
          </div>
          {/* Aa stays put at the right edge; the row beside it scrolls if it must. */}
          <PBtn icon={CaseSensitive} label="More Formatting" active={more} onClick={() => setMore((m) => !m)} />
          </div>
        </div>,
        document.body,
      )}
      {menuPos && createPortal(
        <div className="nt-menu" role="listbox" aria-label={menu.kind === 'mention' ? 'Mention someone' : menu.kind === 'record' ? 'Link to a record' : 'Insert a block'}
          style={{ left: menuPos.left, top: menuPos.top, width: menuPos.width }}>
          {menu.kind === 'record' && !items.length && (
            <div className="nt-menu-empty" role="status">
              {records.loading ? 'Looking…' : menu.query.trim() ? `Nothing matches "${menu.query.trim()}"` : 'Type to find a note, task, job or page'}
            </div>
          )}
          {menu.kind === 'record' && items.map((it, i) => {
            const meta = RECORD_META[it.kind] || RECORD_META.note;
            const Icon = meta.icon;
            return (
              <button key={it.key} type="button" role="option" aria-selected={i === menu.index}
                className={`nt-menu-row${i === menu.index ? ' is-on' : ''}`}
                onMouseDown={(ev) => { ev.preventDefault(); choose(it); }}
                onMouseEnter={() => setMenu((m) => (m ? { ...m, index: i } : m))}>
                <Icon size={16} strokeWidth={1.8} aria-hidden="true" />
                <span className="nt-menu-main">
                  <span className="nt-menu-label">{it.title}</span>
                  <span className="nt-menu-hint">{[meta.label, it.detail].filter(Boolean).join(' · ')}</span>
                </span>
              </button>
            );
          })}
          {menu.kind !== 'record' && items.map((it, i) => {
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

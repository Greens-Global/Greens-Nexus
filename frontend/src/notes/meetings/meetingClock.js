// Meeting Notes (Neil, 11/12/2026): the meeting clock on a note's lines.
//
// While a meeting note is open around its meeting (from MEET_EARLY_MS before
// the start to MEET_LATE_MS after the end), every paragraph or heading the
// person starts writing is stamped with the moment they started it -
// `data-at="<Unix seconds>"` on the block, which the server's sanitizer keeps
// (routers/notes.py, `_AT`). The stamp shows as a small time at the line's end
// and a click opens the Teams transcript at that moment.
//
// The attribute is in EVERY Notes editor's schema (noteExtensions.js), so a
// stamp survives live co-typing, the HTML round trip and the collab seed;
// stamping and the time chips only happen where the note's page hands this
// extension a meeting (`editor.storage.meetingClock.meeting`). Typing that
// arrives from someone else live is never stamped by the receiver, and a new
// block made by Enter starts unstamped (keepOnSplit: false) - it is stamped
// when its first words are typed.
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { formatTime } from '../../lib/datetime';

export const meetingClockKey = new PluginKey('meetingClock');
export const STAMPED = ['paragraph', 'heading'];
export const MEET_EARLY_MS = 10 * 60 * 1000;
export const MEET_LATE_MS = 15 * 60 * 1000;
const AT = /^\d{10}$/;

export const safeAt = (v) => (typeof v === 'string' && AT.test(v) ? v : null);

/** Whether `now` is inside the window a meeting's lines are stamped in. */
export function clockRunning(meeting, now = Date.now()) {
  if (!meeting?.startMs || !meeting?.endMs) return false;
  return now >= meeting.startMs - MEET_EARLY_MS && now <= meeting.endMs + MEET_LATE_MS;
}

function chips(doc, meeting) {
  if (!meeting) return DecorationSet.empty;
  const out = [];
  doc.descendants((node, pos) => {
    if (!STAMPED.includes(node.type.name)) return true;
    const at = safeAt(node.attrs.at);
    if (at && node.textContent.trim()) {
      out.push(Decoration.widget(pos + 1, () => {
        const el = document.createElement(meeting.onJump ? 'button' : 'span');
        if (meeting.onJump) {
          el.type = 'button';
          el.title = 'See the transcript at this moment';
          el.addEventListener('mousedown', (e) => { e.preventDefault(); meeting.onJump(Number(at)); });
        }
        el.className = 'nt-at';
        el.contentEditable = 'false';
        el.textContent = formatTime(new Date(Number(at) * 1000));
        return el;
      }, { side: -1, key: `at-${at}-${meeting.onJump ? 1 : 0}`, ignoreSelection: true, stopEvent: () => true }));
    }
    return false;     // a paragraph's or a heading's inside holds no more blocks
  });
  return DecorationSet.create(doc, out);
}

export const MeetingClock = Extension.create({
  name: 'meetingClock',

  addStorage() {
    // meeting: { startMs, endMs, onJump? } | null - set by NoteEditor's `meeting` prop.
    // isRemote: (transaction) => bool - live co-typing's own test for someone else's typing.
    return { meeting: null, isRemote: () => false };
  },

  addGlobalAttributes() {
    return [{
      types: STAMPED,
      attributes: {
        at: {
          default: null,
          keepOnSplit: false,
          parseHTML: (el) => safeAt(el.getAttribute('data-at')),
          renderHTML: (a) => (safeAt(a.at) ? { 'data-at': a.at } : {}),
        },
      },
    }];
  },

  addProseMirrorPlugins() {
    const storage = this.storage;
    return [new Plugin({
      key: meetingClockKey,
      state: {
        init: (_, state) => chips(state.doc, storage.meeting),
        apply: (tr, old, _prev, state) => (tr.docChanged || tr.getMeta(meetingClockKey) ? chips(state.doc, storage.meeting) : old),
      },
      props: { decorations: (state) => meetingClockKey.getState(state) },
      appendTransaction: (trs, _old, state) => {
        const meeting = storage.meeting;
        if (!clockRunning(meeting) || !trs.some((t) => t.docChanged)) return null;
        if (trs.some((t) => t.getMeta(meetingClockKey) || storage.isRemote?.(t))) return null;
        const { $from } = state.selection;
        const node = $from.parent;
        if (!STAMPED.includes(node.type.name) || safeAt(node.attrs.at) || !node.textContent.trim()) return null;
        const at = String(Math.floor(Date.now() / 1000));
        return state.tr.setNodeMarkup($from.before($from.depth), undefined, { ...node.attrs, at })
          .setMeta(meetingClockKey, 'stamp').setMeta('addToHistory', false);
      },
    })];
  },
});

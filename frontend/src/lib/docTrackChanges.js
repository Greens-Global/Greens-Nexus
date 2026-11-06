// Track Changes for a Documents page (Pranshu, Nov 5 2026), built the way
// Word Online behaves: with tracking on, typed text is an INSERTION (colored
// and underlined) and deleted text stays on the page as a DELETION (colored
// and struck through) until someone accepts or rejects it. Each change knows
// who made it and when. Accept keeps the insertion / removes the deletion;
// Reject removes the insertion / restores the deletion. Markup view: "all"
// shows both on the page, "simple" shows the final text with a bar in the
// margin (deletions hidden). The exporter prints the accepted text
// (doc_export.py skips deletion marks).
//
// How tracking works: every transaction that changes the document (and is
// not ours, not undo/redo) is compared with ProseMirror's changeset; the
// inserted ranges get the insertion mark and the deleted text is put back
// with the deletion mark. Deleting your own insertion really deletes it.
// shortcut: structure-only edits (joining paragraphs, list changes, marks)
// are not tracked, Word tracks those too; add when someone needs it.
import { Extension, Mark, mergeAttributes } from '@tiptap/core';
import { ChangeSet } from '@tiptap/pm/changeset';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { formatDateTime } from './datetime';

export const trackKey = new PluginKey('nexusTrackChanges');

const COLORS = ['#c00000', '#0b5cad', '#1b7f3b', '#8a3ab9', '#b8520a', '#0e7c86', '#a31d7a', '#5a5a00'];
/** One stable color per author, like Word's per-reviewer colors. */
export function authorColor(email = '') {
  let h = 0;
  for (const ch of String(email).toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

function changeAttrs() {
  return {
    author: { default: '', parseHTML: (el) => el.getAttribute('data-author') || '', renderHTML: (a) => ({ 'data-author': a.author }) },
    name: { default: '', parseHTML: (el) => el.getAttribute('data-name') || '', renderHTML: (a) => ({ 'data-name': a.name }) },
    at: { default: '', parseHTML: (el) => el.getAttribute('data-at') || '', renderHTML: (a) => ({ 'data-at': a.at }) },
  };
}

function changeTitle(kind, attrs) {
  const when = attrs.at ? formatDateTime(attrs.at) : '';
  return `${kind} by ${attrs.name || attrs.author || 'someone'}${when ? `, ${when}` : ''}`;
}

export const InsertionMark = Mark.create({
  name: 'insertion',
  excludes: 'deletion',
  addAttributes: changeAttrs,
  parseHTML() { return [{ tag: 'ins[data-author]' }]; },
  renderHTML({ HTMLAttributes, mark }) {
    return ['ins', mergeAttributes(HTMLAttributes, { class: 'doc-change doc-change-ins', style: `--chg:${authorColor(mark.attrs.author)}`, title: changeTitle('Inserted', mark.attrs) }), 0];
  },
});

export const DeletionMark = Mark.create({
  name: 'deletion',
  excludes: 'insertion',
  addAttributes: changeAttrs,
  parseHTML() { return [{ tag: 'del[data-author]' }]; },
  renderHTML({ HTMLAttributes, mark }) {
    return ['del', mergeAttributes(HTMLAttributes, { class: 'doc-change doc-change-del', style: `--chg:${authorColor(mark.attrs.author)}`, title: changeTitle('Deleted', mark.attrs) }), 0];
  },
});

/** Every change on the page in order: {from, to, type, author, name, at}. A
 *  change is one run of text carrying the same mark by the same author. */
export function listChanges(doc) {
  const out = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    const m = node.marks.find((x) => x.type.name === 'insertion' || x.type.name === 'deletion');
    if (!m) return;
    const last = out[out.length - 1];
    if (last && last.to === pos && last.type === m.type.name && last.author === m.attrs.author) { last.to = pos + node.nodeSize; return; }
    out.push({ from: pos, to: pos + node.nodeSize, type: m.type.name, author: m.attrs.author, name: m.attrs.name, at: m.attrs.at });
  });
  return out;
}

/** The change at `pos` (or the first one touching [from, to]). */
export function changeAt(doc, from, to = from) {
  const all = listChanges(doc);
  return all.find((c) => c.to > from && c.from < to) || all.find((c) => c.from === from || c.to === from) || null;
}

function resolve(tr, change, accept) {
  // Accept keeps what the insertion says and drops the deleted text; reject
  // does the opposite. Positions are mapped so several resolve in one tr.
  const from = tr.mapping.map(change.from), to = tr.mapping.map(change.to);
  const keepText = change.type === 'insertion' ? accept : !accept;
  if (keepText) tr.removeMark(from, to, tr.doc.type.schema.marks[change.type]);
  else tr.delete(from, to);
}

function stateOf(editorState) { return trackKey.getState(editorState) || {}; }

/** The attrs of a same-kind change by the same author touching `pos`, so
 *  keystrokes extend one change instead of starting a new one each. */
function neighborAttrs(doc, pos, typeName, author) {
  const $pos = doc.resolve(pos);
  for (const n of [$pos.nodeBefore, $pos.nodeAfter]) {
    const m = n && n.isText && n.marks.find((x) => x.type.name === typeName && x.attrs.author === author);
    if (m) return m.attrs;
  }
  return null;
}

function markAll(tr, from, to, markType, attrs, dropType) {
  const use = neighborAttrs(tr.doc, from, markType.name, attrs.author) || neighborAttrs(tr.doc, to, markType.name, attrs.author) || attrs;
  tr.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) return;
    const a = Math.max(from, pos), b = Math.min(to, pos + node.nodeSize);
    if (dropType) tr.removeMark(a, b, dropType);
    tr.addMark(a, b, markType.create(use));
  });
}

/** Backspace (dir -1) / Delete (dir 1) with tracking on, the way Word does
 *  it: a character already deleted is stepped over, your own insertion goes
 *  for real, anything else is struck through and the caret moves on. Handled
 *  here so the caret never depends on where the browser left it. */
function trackedDelete(editor, dir) {
  const { state } = editor;
  const { on, user } = stateOf(state);
  const { $from, empty } = state.selection;
  if (!on || !empty || !$from.parent.isTextblock) return false;
  if (dir < 0 ? $from.parentOffset === 0 : $from.parentOffset === $from.parent.content.size) return false;
  const node = dir < 0 ? $from.nodeBefore : $from.nodeAfter;
  if (!node || !node.isText) return false;
  const pos = $from.pos, a = dir < 0 ? pos - 1 : pos, b = a + 1;
  const author = (user || {}).email || '';
  const tr = state.tr.setMeta(trackKey, 'tracked');
  if (node.marks.some((m) => m.type.name === 'deletion')) {
    tr.setSelection(TextSelection.create(tr.doc, dir < 0 ? a : b));
  } else if (node.marks.some((m) => m.type.name === 'insertion' && m.attrs.author === author)) {
    tr.delete(a, b);
  } else {
    const deletion = state.schema.marks.deletion;
    const attrs = neighborAttrs(state.doc, dir < 0 ? b : a, 'deletion', author)
      || { author, name: (user || {}).name || '', at: new Date().toISOString() };
    tr.addMark(a, b, deletion.create(attrs)).setSelection(TextSelection.create(tr.doc, dir < 0 ? a : b));
  }
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

/** Build the tracked version of a change on top of `newState` (which already
 *  has the raw change applied); `maps` are the raw transaction's step maps.
 *  Returns null when there is nothing to track. */
export function trackTransaction(maps, oldState, newState, user) {
  const changes = ChangeSet.create(oldState.doc).addSteps(newState.doc, maps, null).changes;
  if (!changes.length) return null;
  const { insertion, deletion } = newState.schema.marks;
  const attrs = { author: user.email || '', name: user.name || '', at: new Date().toISOString() };
  const out = newState.tr.setMeta(trackKey, 'tracked');
  let touched = false;
  let cursor = null;
  for (let i = changes.length - 1; i >= 0; i--) {
    const c = changes[i];
    const deleted = oldState.doc.slice(c.fromA, c.toA);
    // Only deleted TEXT inside one paragraph comes back; a structure change passes as is.
    const flat = deleted.openStart === 0 && deleted.openEnd === 0 && deleted.content.childCount > 0 && deleted.content.firstChild.isInline;
    if (c.fromB < c.toB) { markAll(out, c.fromB, c.toB, insertion, attrs, deletion); touched = true; }
    if (flat) {
      // Text the author inserted themselves goes for real; the rest is marked.
      const nodes = [];
      deleted.content.forEach((n) => {
        if (!n.isText) { nodes.push(n); return; }
        if (n.marks.some((m) => m.type.name === 'insertion' && m.attrs.author === attrs.author)) return;
        const marks = n.marks.filter((m) => m.type.name !== 'deletion' && m.type.name !== 'insertion');
        nodes.push(n.mark([...marks, deletion.create(n.marks.find((m) => m.type.name === 'deletion')?.attrs || attrs)]));
      });
      if (nodes.length) {
        const share = neighborAttrs(out.doc, c.fromB, 'deletion', attrs.author);
        if (share) nodes.forEach((n, i) => { if (n.isText) nodes[i] = n.mark(n.marks.map((m) => (m.type.name === 'deletion' && m.attrs.author === attrs.author ? deletion.create(share) : m))); });
        out.insert(c.fromB, nodes);
        touched = true;
        const delLen = nodes.reduce((s, n) => s + n.nodeSize, 0);
        const backspace = c.fromB === c.toB && oldState.selection.empty && oldState.selection.from === c.toA;
        cursor = backspace ? c.fromB : c.fromB + delLen + (c.toB - c.fromB);
      }
    }
  }
  if (!touched) return null;
  if (cursor != null) out.setSelection(TextSelection.create(out.doc, Math.min(cursor, out.doc.content.size)));
  return out;
}

export const TrackChanges = Extension.create({
  name: 'nexusTrackChanges',
  addOptions() { return { user: { email: '', name: '' } }; },
  addExtensions() { return [InsertionMark, DeletionMark]; },

  addCommands() {
    return {
      // `user` is {email, name}: who the changes are by (set once per editor).
      setTrackChanges: (on, user) => ({ tr, dispatch }) => { if (dispatch) tr.setMeta(trackKey, { on: !!on, ...(user ? { user } : {}) }); return true; },
      setMarkupView: (view) => ({ tr, dispatch }) => { if (dispatch) tr.setMeta(trackKey, { markup: view }); return true; },
      acceptChange: () => ({ tr, state, dispatch }) => {
        const c = changeAt(state.doc, state.selection.from, state.selection.to);
        if (!c) return false;
        if (dispatch) { resolve(tr, c, true); tr.setMeta(trackKey, 'tracked'); }
        return true;
      },
      rejectChange: () => ({ tr, state, dispatch }) => {
        const c = changeAt(state.doc, state.selection.from, state.selection.to);
        if (!c) return false;
        if (dispatch) { resolve(tr, c, false); tr.setMeta(trackKey, 'tracked'); }
        return true;
      },
      acceptAllChanges: () => ({ tr, state, dispatch }) => {
        const all = listChanges(state.doc);
        if (!all.length) return false;
        if (dispatch) { all.forEach((c) => resolve(tr, c, true)); tr.setMeta(trackKey, 'tracked'); }
        return true;
      },
      rejectAllChanges: () => ({ tr, state, dispatch }) => {
        const all = listChanges(state.doc);
        if (!all.length) return false;
        if (dispatch) { all.forEach((c) => resolve(tr, c, false)); tr.setMeta(trackKey, 'tracked'); }
        return true;
      },
      selectChange: (dir) => ({ tr, state, dispatch }) => {
        const all = listChanges(state.doc);
        if (!all.length) return false;
        const { from } = state.selection;
        const next = dir > 0 ? (all.find((c) => c.from > from) || all[0]) : ([...all].reverse().find((c) => c.from < from) || all[all.length - 1]);
        if (dispatch) tr.setSelection(TextSelection.create(tr.doc, next.from, next.to)).scrollIntoView();
        return true;
      },
    };
  },

  addKeyboardShortcuts() {
    return {
      Backspace: () => trackedDelete(this.editor, -1),
      Delete: () => trackedDelete(this.editor, 1),
    };
  },

  addProseMirrorPlugins() {
    const ext = this;
    return [new Plugin({
      key: trackKey,
      state: {
        init: () => ({ on: false, markup: 'all' }),
        apply(tr, prev) {
          const meta = tr.getMeta(trackKey);
          return meta && typeof meta === 'object' ? { ...prev, ...meta } : prev;
        },
      },
      appendTransaction(trs, oldState, newState) {
        if (!stateOf(newState).on) return null;
        // A live session's remote typing, Undo / Redo and first render arrive with y-sync's meta: never tracked as mine.
        if (!trs.every((t) => t.docChanged && t.getMeta(trackKey) !== 'tracked' && !t.getMeta('history$') && !t.getMeta('y-sync$')?.isChangeOrigin)) return null;
        return trackTransaction(trs.flatMap((t) => t.mapping.maps), oldState, newState, stateOf(newState).user || ext.options.user);
      },
      props: {
        attributes(state) { return { class: `doc-markup-${stateOf(state).markup || 'all'}${stateOf(state).on ? ' is-tracking' : ''}` }; },
        decorations(state) {
          // The margin bar beside every paragraph that holds a change.
          const decos = [];
          state.doc.descendants((node, pos) => {
            if (!node.isTextblock) return;
            let has = false;
            node.descendants((n) => { if (n.isText && n.marks.some((m) => m.type.name === 'insertion' || m.type.name === 'deletion')) has = true; });
            if (has) decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'doc-changed-block' }));
            return false;
          });
          return DecorationSet.create(state.doc, decos);
        },
      },
    })];
  },
});

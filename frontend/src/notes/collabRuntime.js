// Live co-typing's heavy half (Notes, Neil, Oct 30 2026), loaded only when a
// shared note is opened by one of its editors (useNoteCollab imports it):
// the TipTap collaboration extensions with named carets and seeding a
// shared document from a note's HTML. The channel itself - the encrypted
// wire, the trust gate, resync - is collabTransport.js, shared with the
// boards (board/useBoardCollab.js, 11/02/2026).
import { getSchema, generateJSON } from '@tiptap/core';
import { DOMSerializer } from '@tiptap/pm/model';
import { prosemirrorJSONToYDoc, ySyncPluginKey, yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import { buildExtensions } from './noteExtensions';
import { Y, docFrom, encodeState, applyState, newAwareness, connect } from './collabTransport';

// The channel itself lives in collabTransport.js (shared with the boards);
// re-exported so this module stays the one import for a note's live session.
export { Y, docFrom, encodeState, applyState, newAwareness, connect };

export const FIELD = 'default';

/** A shared document made from the note's HTML, the way the editor would read it. */
export function seedDoc(html) {
  const exts = buildExtensions('');
  const json = generateJSON(html || '<p></p>', exts);
  return prosemirrorJSONToYDoc(getSchema(exts), json, FIELD);
}

// ── is a shared document safe to put on screen? ───────────────────────────
// A stored state came from an editor's browser, not through the server's
// sanitizer: before it mounts, every attribute must be a plain value of the
// right kind, the document must fit the schema, and it must render.
const SPAN_KEYS = new Set(['colspan', 'rowspan']);
function attrsOk(attrs) {
  for (const [k, v] of Object.entries(attrs || {})) {
    if (SPAN_KEYS.has(k) && v != null && !(Number.isInteger(v) && v >= 1 && v <= 100)) return false;
    if (v == null || typeof v === 'boolean') continue;
    if (typeof v === 'string') { if (v.length > 8000) return false; continue; }
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) return false;
      continue;
    }
    if (k === 'colwidth' && Array.isArray(v) && v.every((w) => w == null || Number.isFinite(w))) continue;
    return false;
  }
  return true;
}
function treeOk(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 60) return false;
  if (!attrsOk(node.attrs)) return false;
  if ((node.marks || []).some((m) => !attrsOk(m?.attrs))) return false;
  return (node.content || []).every((c) => treeOk(c, depth + 1));
}

let checkSchema = null;
/** Throws when the shared document could not be shown safely. */
export function validateDoc(doc) {
  const exts = buildExtensions('', null, { strict: true });
  checkSchema ||= getSchema(exts);
  const json = yXmlFragmentToProsemirrorJSON(doc.getXmlFragment(FIELD));
  if (!treeOk(json)) throw new Error('A value in the shared note is not plain text');
  const node = checkSchema.nodeFromJSON(json);
  node.check();
  DOMSerializer.fromSchema(checkSchema).serializeFragment(node.content, { document });
}

/** True for an editor transaction that came from someone else's typing. */
export const isRemote = (tr) => !!tr?.getMeta(ySyncPluginKey)?.isChangeOrigin;

/** The editor extensions for one shared document: content and undo from Yjs, named carets. */
export function collabExtensions(doc, awareness, user) {
  return [
    Collaboration.configure({ document: doc, field: FIELD }),
    CollaborationCaret.configure({ provider: { awareness }, user }),
  ];
}


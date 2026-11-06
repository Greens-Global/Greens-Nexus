// The shared document behind a live Document Builder session (Neil,
// 11/05/2026, routers/documents.py "Working together"). One Y.Doc holds the
// whole document the way the builder holds it - independent pages, a header,
// a footer and a few document settings:
//   Y.Array 'pages'          page ids, in order
//   Y.XmlFragment 'page:<id>' one page's body (TipTap/ProseMirror)
//   Y.XmlFragment 'header' / 'footer'
//   Y.Map 'meta'             header / footer shown, pageSetup, trackChanges
// The saved `content` ({pages, header, footer, pageSetup, trackChanges}) is
// still what the server renders and exports; every live save writes both.
import * as Y from 'yjs';
import { getSchema } from '@tiptap/core';
import { DOMSerializer } from '@tiptap/pm/model';
import { prosemirrorJSONToYXmlFragment, yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';
import { BODY_EXTENSIONS, repairDocJson } from '../lib/docBuilderSchema';

export const LOCAL = 'nx-local';
export const pageField = (id) => `page:${id}`;
const EMPTY = { type: 'doc', content: [{ type: 'paragraph' }] };
const newId = () => 'pg_' + Math.random().toString(36).slice(2, 10);

let schema = null;
const schemaOf = () => (schema ||= getSchema(BODY_EXTENSIONS));

/** The pages a saved content object holds (a pre-pages document is split at its page breaks). */
export function pagesOf(content) {
  const c = content && typeof content === 'object' ? content : {};
  if (Array.isArray(c.pages) && c.pages.length) return c.pages.map((p) => ({ id: p.id || newId(), json: p.json || EMPTY }));
  const segs = [[]];
  for (const n of c.body?.content || []) {
    if (n.type === 'pageBreak') segs.push([]);
    else segs[segs.length - 1].push(n);
  }
  return segs.map((content) => ({ id: newId(), json: { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] } }));
}

/** A fresh shared document from saved content. */
export function seedLiveDoc(content) {
  const c = content && typeof content === 'object' ? content : {};
  const doc = new Y.Doc();
  const pages = pagesOf(c);
  const s = schemaOf();
  doc.transact(() => {
    for (const p of pages) prosemirrorJSONToYXmlFragment(s, repairDocJson(p.json), doc.getXmlFragment(pageField(p.id)));
    doc.getArray('pages').push(pages.map((p) => p.id));
    if (c.header) prosemirrorJSONToYXmlFragment(s, repairDocJson(c.header), doc.getXmlFragment('header'));
    if (c.footer) prosemirrorJSONToYXmlFragment(s, repairDocJson(c.footer), doc.getXmlFragment('footer'));
    const meta = doc.getMap('meta');
    meta.set('header', !!c.header);
    meta.set('footer', !!c.footer);
    meta.set('pageSetup', c.pageSetup && typeof c.pageSetup === 'object' ? c.pageSetup : null);
    meta.set('trackChanges', !!c.trackChanges);
  });
  return doc;
}

// ── is a stored state safe to put on screen? ─────────────────────────────
// It came from an editor's browser, not through any server check: every
// attribute must be plain data, every fragment must fit the schema and render.
function plain(v, depth = 0) {
  if (v == null || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'string') return v.length <= 200_000;
  if (depth > 4) return false;
  if (Array.isArray(v)) return v.length <= 1000 && v.every((x) => plain(x, depth + 1));
  if (typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) return Object.values(v).every((x) => plain(x, depth + 1));
  return false;
}
function treeOk(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 80) return false;
  if (!plain(node.attrs || null)) return false;
  if ((node.marks || []).some((m) => !plain(m?.attrs || null))) return false;
  return (node.content || []).every((c) => treeOk(c, depth + 1));
}
function checkFragment(doc, field) {
  if (!doc.getXmlFragment(field).length) return;     // not written yet (a page a peer just added, no header)
  const json = yXmlFragmentToProsemirrorJSON(doc.getXmlFragment(field));
  if (!treeOk(json)) throw new Error(`A value in ${field} is not plain data`);
  const node = schemaOf().nodeFromJSON(json);
  node.check();
  DOMSerializer.fromSchema(schemaOf()).serializeFragment(node.content, { document });
}

/** Throws when the shared document could not be shown safely. */
export function validateLiveDoc(doc) {
  const ids = doc.getArray('pages').toArray();
  if (!ids.length || ids.length > 500 || !ids.every((id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id))) {
    throw new Error('The page list is not valid');
  }
  if (new Set(ids).size !== ids.length) throw new Error('A page is listed twice');
  for (const id of ids) checkFragment(doc, pageField(id));
  checkFragment(doc, 'header');
  checkFragment(doc, 'footer');
  const meta = doc.getMap('meta').toJSON();
  if (!plain(meta)) throw new Error('The document settings are not plain data');
}

/** Make the shared page list match `ids` with the fewest inserts and deletes (a peer's concurrent add survives). */
export function syncPageIds(doc, ids) {
  const arr = doc.getArray('pages');
  const cur = arr.toArray();
  if (cur.length === ids.length && cur.every((x, i) => x === ids[i])) return;
  doc.transact(() => {
    const want = new Set(ids);
    for (let i = cur.length - 1; i >= 0; i -= 1) if (!want.has(cur[i])) arr.delete(i, 1);
    // What is left keeps its relative order; place each wanted id where `ids` puts it.
    ids.forEach((id, i) => {
      const now = arr.toArray();
      const at = now.indexOf(id);
      if (at === i) return;
      if (at >= 0) arr.delete(at, 1);
      arr.insert(Math.min(i, arr.length), [id]);
    });
  }, LOCAL);
}

/** True for an editor transaction that came from someone else's typing (y-sync's own meta) -
 *  never this person's own Undo / Redo, which also arrives through the shared document. */
export function isRemoteTr(tr) {
  const m = tr?.getMeta?.('y-sync$');
  return !!m?.isChangeOrigin && !m.isUndoRedoOperation;
}

/** The page ids a save writes: the shared list, each once (a move two people made at once can list one twice). */
export const livePageIds = (doc) => [...new Set(doc.getArray('pages').toArray())];

/** A page's words straight from the shared document (a page whose editor has not mounted yet). */
export const livePageJson = (doc, id) => {
  const json = yXmlFragmentToProsemirrorJSON(doc.getXmlFragment(pageField(id)));
  return json?.content?.length ? json : EMPTY;
};

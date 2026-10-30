// Live co-typing's heavy half (Notes, Neil, Oct 30 2026), loaded only when a
// shared note is opened by one of its editors (useNoteCollab imports it):
// Yjs, the TipTap collaboration extensions with named carets, seeding a
// shared document from a note's HTML, and the wire protocol over the note's
// encrypted Supabase Realtime broadcast channel.
//
// Wire (every payload sealed with the note's AES-GCM key, collabCrypto.js;
// tagged with the session epoch so an older session's edits are ignored):
//   0 update   - a Yjs update typed here
//   1 hello    - my state vector; answer with what I lack (2), yours (3) and your caret (4)
//   2 diff     - a Yjs update answering 1 or 3
//   3 vector   - your state vector; answer with what you lack (2)
//   4 presence - a y-protocols awareness update (who and where the caret is)
//
// Each message is bound to the note and the epoch (AES-GCM additional data),
// so it cannot be replayed onto another note or relabeled as another
// session's. While the session is not TRUSTED (the tab was hidden, or a
// message did not open - the key may have moved on) nothing from the channel
// is applied and nobody is answered: the hook re-checks the key with the
// server first, then `resync()` asks the others for what was missed.
import * as Y from 'yjs';
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import { getSchema, generateJSON } from '@tiptap/core';
import { DOMSerializer } from '@tiptap/pm/model';
import { prosemirrorJSONToYDoc, ySyncPluginKey, yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import { buildExtensions } from './noteExtensions';
import { seal, open, toB64, fromB64, boundTo } from './collabCrypto';

export { Y };

export const FIELD = 'default';
const REMOTE = 'nx-remote';
const MAX_MESSAGE = 200_000;    // base64 characters; a bigger sync is left to the saved state

/** A shared document made from the note's HTML, the way the editor would read it. */
export function seedDoc(html) {
  const exts = buildExtensions('');
  const json = generateJSON(html || '<p></p>', exts);
  return prosemirrorJSONToYDoc(getSchema(exts), json, FIELD);
}

export function docFrom(b64) {
  const doc = new Y.Doc();
  if (b64) Y.applyUpdate(doc, fromB64(b64), REMOTE);
  return doc;
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

export const encodeState = (doc) => toB64(Y.encodeStateAsUpdate(doc));
export const applyState = (doc, b64) => { if (b64) Y.applyUpdate(doc, fromB64(b64), REMOTE); };

/** True for an editor transaction that came from someone else's typing. */
export const isRemote = (tr) => !!tr?.getMeta(ySyncPluginKey)?.isChangeOrigin;

/** The editor extensions for one shared document: content and undo from Yjs, named carets. */
export function collabExtensions(doc, awareness, user) {
  return [
    Collaboration.configure({ document: doc, field: FIELD }),
    CollaborationCaret.configure({ provider: { awareness }, user }),
  ];
}

export function newAwareness(doc, user) {
  const a = new Awareness(doc);
  a.setLocalStateField('user', user);
  return a;
}

/**
 * Joins the encrypted channel. Returns { close(), resync() }.
 * hooks: onLive(bool), onForeignEpoch(), onUnreadable(), trusted() -> bool
 */
export function connect({ supabase, channelName, key, noteId, epoch, doc, awareness, hooks }) {
  const chan = supabase.channel(channelName, { config: { broadcast: { self: false } } });
  const aad = boundTo(noteId, epoch);
  const trusted = () => (hooks.trusted ? hooks.trusted() : true);
  let closed = false;
  let queue = [];
  let timer = null;

  const send = async (type, bytes) => {
    if (closed) return;
    const msg = new Uint8Array(bytes.length + 1);
    msg[0] = type;
    msg.set(bytes, 1);
    const d = await seal(key, msg, aad);
    if (d.length > MAX_MESSAGE || closed) return;
    try { await chan.send({ type: 'broadcast', event: 'm', payload: { e: epoch, d } }); } catch { /* the saved state covers it */ }
  };

  const onUpdate = (update, origin) => {
    if (origin === REMOTE) return;
    queue.push(update);
    clearTimeout(timer);
    timer = setTimeout(() => {
      const merged = queue.length === 1 ? queue[0] : Y.mergeUpdates(queue);
      queue = [];
      send(0, merged);
    }, 40);
  };
  const onAware = ({ added, updated, removed }, origin) => {
    if (origin !== 'local') return;
    const changed = added.concat(updated, removed);
    if (changed.length) send(4, encodeAwarenessUpdate(awareness, changed));
  };
  doc.on('update', onUpdate);
  awareness.on('update', onAware);

  chan.on('broadcast', { event: 'm' }, async ({ payload }) => {
    if (closed || !payload || typeof payload.d !== 'string') return;
    if (payload.e !== epoch) { hooks.onForeignEpoch?.(); return; }
    // Not trusted right now: apply nothing, answer nobody (the hook is
    // checking the key; resync() catches up afterwards).
    if (!trusted()) return;
    const msg = await open(key, payload.d, aad);
    if (!msg || !msg.length) { hooks.onUnreadable?.(); return; }
    if (closed || !trusted()) return;
    const type = msg[0], data = msg.subarray(1);
    try {
      if (type === 0 || type === 2) Y.applyUpdate(doc, data, REMOTE);
      else if (type === 1) {
        // A newcomer: what it lacks, what we lack, and who is here.
        send(2, Y.encodeStateAsUpdate(doc, data));
        send(3, Y.encodeStateVector(doc));
        send(4, encodeAwarenessUpdate(awareness, [awareness.clientID]));
      }
      else if (type === 3) send(2, Y.encodeStateAsUpdate(doc, data));
      else if (type === 4) applyAwarenessUpdate(awareness, data, REMOTE);
    } catch { /* a malformed update is dropped */ }
  });
  chan.subscribe((status) => {
    if (closed) return;
    if (status === 'SUBSCRIBED') {
      hooks.onLive?.(true);
      send(1, Y.encodeStateVector(doc));
      send(4, encodeAwarenessUpdate(awareness, [awareness.clientID]));
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
      hooks.onLive?.(false);
    }
  });

  return {
    // After a fresh key check: ask the others for whatever was missed.
    resync() {
      send(1, Y.encodeStateVector(doc));
      send(4, encodeAwarenessUpdate(awareness, [awareness.clientID]));
    },
    close() {
      // Tell the others this caret is gone, then leave.
      try { removeAwarenessStates(awareness, [awareness.clientID], 'local'); } catch { /* gone */ }
      setTimeout(() => {
        closed = true;
        clearTimeout(timer);
        doc.off('update', onUpdate);
        awareness.off('update', onAware);
        try { supabase.removeChannel(chan); } catch { /* gone */ }
      }, 50);
    },
  };
}

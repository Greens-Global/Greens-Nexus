// One open note kept in step with the server (Notes, Oct 29 2026).
//
// Typing changes the note on screen at once, writes a local draft (so a tab
// switch, a reload or a crash loses nothing) and saves shortly after the
// typing stops. Every save carries the rev the note was read with. Leaving
// (another note, another view, the tab hidden) saves at once.
//
// Working together (Neil, Oct 30 2026):
//   - When someone else saved in between (409), the two versions are merged
//     block by block against the copy both started from (notesMerge.js):
//     only a block both changed differently is asked about (`clashes`),
//     never the whole note.
//   - While the note is open and visible it beats every few seconds
//     (POST /presence): who else is here (`people`), and when the note
//     moved on and nothing is waiting to save here, it is re-read in place.
//   - A shared note's editors co-type live (`collabRef` -> useNoteCollab):
//     the shared Yjs state rides along with each save - always with the
//     editor's whole body, so the saved words never lag the state - and a
//     409 takes the server's state in (Yjs merges it) and saves again. When
//     the live state was rebuilt elsewhere (Quick Note, a restore), the words
//     typed here are merged into the saved copy, the new session is joined
//     and the merged words go into IT - never a plain save, which would drop
//     the state the others just rebuilt.
//   - A Board (kind 'board', Neil 11/02/2026) saves its `scene` the same way
//     the body saves (typed = dirty, SAVE_MS later = a PATCH with the rev;
//     the draft keeps a scene under DRAFT_SCENE_MAX so a reload loses
//     nothing). A board never sends a `body`. Its scene is never saved whole
//     over another copy: every save reconciles the scene drawn here into the
//     server's copy at the rev it was read with, element by element (the
//     engine's rule, boardSync.reconcile: the newer version wins, a tie goes
//     to the lower nonce; pictures are the union) - so a 409, a draft from
//     an older rev, or a second tab never wipes the shapes someone else drew.
//   - A save the server refuses for what it carries (413 too large, 400 not
//     a board) is not retried: the field is dropped, `problem` holds the
//     server's words for the status line, and the last good scene stays on
//     the server; the next change tries again.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { clearDraft, readDraft, writeDraft } from './notesModel';
import { mergeNotes, mergeTitle } from './notesMerge';
import { normalizeHtml } from './noteSafeHtml';
import { reconcile } from './board/boardSync.js';
import { parseScene, serializeScene } from './board/scene.js';

const MERGE = { norm: normalizeHtml };
const REJOIN_MS = 15000;    // longest a save waits for the new live session

export const SAVE_MS = 800;
const DRAFT_SCENE_MAX = 500_000;   // a board scene the local draft still keeps (localStorage has ~5 MB in all)
export const BEAT_MS = 8000;
const EDITING_MS = 30000;   // typed this recently = "editing" to the others

/** Two copies of a board -> one: `mine` reconciled into `theirs` per element
 *  (newer version, then lower nonce), pictures the union, the view and the
 *  look this side's. A copy that does not parse gives way to the other. */
export function mergeScenes(mine, theirs) {
  if (mine == null || mine === theirs) return theirs ?? mine;
  const m = parseScene(mine);
  const t = parseScene(theirs);
  if (!m) return theirs;
  if (!t) return mine;
  return serializeScene({
    elements: reconcile(t.elements, m.elements),
    appState: m.appState,
    filesMeta: { ...t.files, ...m.files },
    look: m.look,
  });
}

// A refusal for what the save carried (never a network blip): which fields to drop.
function refusedFields(err, sent, board) {
  const msg = typeof err?.detail === 'string' ? err.detail : (err?.message || '');
  if (err?.status === 413) return board ? ['scene'] : [];
  if (err?.status !== 400) return null;
  const by = [[/thumbnail/i, 'thumbUrl'], [/source/i, 'source'], [/board|drawing|picture/i, 'scene'], [/day/i, 'day'], [/color/i, 'color'], [/body/i, 'body']];
  const hit = by.filter(([re, f]) => re.test(msg) && f in sent).map(([, f]) => f);
  return hit.length ? [hit[0]] : [];
}

// status: loading | saved | dirty | saving | conflict | error | missing
export function useNoteSync(id, { onSaved, collabRef } = {}) {
  const [note, setNote] = useState(null);
  const [status, setStatus] = useState(id ? 'loading' : 'missing');
  const [conflict, setConflict] = useState(null);   // { server, clashes, titleClash, choices } on a clash
  const [restored, setRestored] = useState(false);  // an unsaved draft came back
  const [merged, setMerged] = useState('');         // who the last automatic merge took words from
  const [people, setPeople] = useState([]);         // others with the note open: { email, state }
  const [problem, setProblem] = useState('');       // the server's words for a save it refused (413 / 400)
  const noteRef = useRef(null);
  const pending = useRef(null);       // fields typed since the last save went out
  const rev = useRef(0);
  const base = useRef({ title: '', body: '', scene: '' });   // the server's copy at `rev`
  const inFlight = useRef(false);
  const timer = useRef(null);
  const savedCb = useRef(onSaved);
  const conflictRef = useRef(null);
  const saveRef = useRef(null);
  const lastEdit = useRef(0);
  useEffect(() => { savedCb.current = onSaved; }, [onSaved]);

  const external = useRef(false);   // pending.body was merged outside the editor: put it into the live state
  const rejoin = useRef(null);      // { from: epoch, at } while joining a rebuilt live session
  const put = useCallback((n) => { noteRef.current = n; setNote(n); }, []);
  const setBase = (n) => { base.current = { title: n?.title || '', body: n?.body || '', scene: n?.scene || '' }; };
  const live = () => {
    const c = collabRef?.current;
    return c && c.phase === 'ready' && c.epoch ? c : null;
  };

  // The server moved on: merge what was typed here into its copy.
  const mergeIn = useCallback((server) => {
    const cur = noteRef.current;
    if (server.kind === 'board') {
      // No words to merge on a board: the title merges, and the shapes
      // drawn here are reconciled into the server's per element (both
      // sides' new shapes kept, the newer copy of one shape wins) - never
      // this copy whole over theirs.
      const p = pending.current || {};
      const title = mergeTitle(base.current.title, p.title ?? cur?.title ?? '', server.title || '');
      const scene = p.scene != null ? mergeScenes(p.scene, server.scene || '') : null;
      rev.current = server.rev;
      setBase(server);
      put({ ...server, title: title.title, scene: scene ?? server.scene });
      const next = {};
      for (const k of Object.keys(p)) if (k !== 'body' && k !== 'title' && k !== 'scene') next[k] = p[k];
      if (title.title !== (server.title || '')) next.title = title.title;
      if (scene != null && scene !== (server.scene || '')) next.scene = scene;
      pending.current = Object.keys(next).length ? next : null;
      setMerged(server.updatedBy || 'someone');
      return true;
    }
    const mine = { title: pending.current?.title ?? cur?.title ?? '', body: pending.current?.body ?? cur?.body ?? '' };
    const body = mergeNotes(base.current.body, mine.body, server.body || '', {}, MERGE);
    const title = mergeTitle(base.current.title, mine.title, server.title || '');
    rev.current = server.rev;
    setBase(server);
    if (body.clashes.length || title.clash) {
      const c = { server, mine, clashes: body.clashes, titleClash: title.clash ? title : null };
      conflictRef.current = c;
      setConflict(c);
      put({ ...server, title: mine.title, body: mine.body });
      setStatus('conflict');
      return false;
    }
    const changedHere = body.html !== (server.body || '') || title.title !== (server.title || '');
    put({ ...server, title: title.title, body: body.html });
    pending.current = changedHere ? { ...(pending.current || {}), title: title.title, body: body.html } : null;
    if (changedHere) external.current = true;
    setMerged(server.updatedBy || 'someone');
    return true;
  }, [put]);

  const save = useCallback(async () => {
    clearTimeout(timer.current);
    const n = noteRef.current;
    if (!n || !pending.current || inFlight.current) return;
    if (n.can === 'read') { pending.current = null; return; }
    // Joining a rebuilt live session: wait for it (a plain save now would
    // drop the state the others just rebuilt) - at most REJOIN_MS.
    const waitAgain = () => { timer.current = setTimeout(() => saveRef.current(), 400); };
    if (rejoin.current) {
      const c0 = collabRef?.current;
      const joining = c0 && (c0.phase === 'loading' || (c0.phase === 'ready' && c0.epoch === rejoin.current.from));
      if (joining && Date.now() - rejoin.current.at < REJOIN_MS) { waitAgain(); return; }
      rejoin.current = null;
    }
    let c = live();
    if (c && external.current && 'body' in pending.current) {
      // Words merged outside the editor go into the shared document first.
      if (!c.setHtml(pending.current.body)) {
        if (Date.now() - (rejoin.current?.at || 0) < REJOIN_MS) { waitAgain(); return; }
        c = null;
      }
    }
    external.current = false;
    const sent = pending.current;
    pending.current = null;
    inFlight.current = true;
    setStatus('saving');
    const board = n.kind === 'board';
    const payload = { rev: rev.current, ...sent };
    if (board) {
      delete payload.body;
      // The engine here may not hold what the server took in since it
      // opened (a merge, a refresh): reconciled into the server's copy at
      // this rev, never one copy whole over the other.
      if (payload.scene != null) payload.scene = mergeScenes(payload.scene, base.current.scene);
    }
    if (c) {
      // Always the editor's whole body with the state, so the saved words
      // (readers, search, the list) never lag what the state holds.
      const html = c.getHtml();
      if (html != null) payload.body = html;
      payload.ydoc = c.encodeState();
      payload.yepoch = c.epoch;
    }
    let again = false;
    let refused = false;     // a 413 / 400: nothing goes out again until the next change
    try {
      const res = await api.noteUpdate(n.id, payload);
      rev.current = res.rev;
      setBase(res);
      const cur = noteRef.current;
      if (cur && cur.id === res.id) {
        // Keep whatever was typed while the save was out.
        put({ ...res, title: pending.current?.title ?? cur.title, body: pending.current?.body ?? cur.body,
          ...(board ? { scene: pending.current?.scene ?? res.scene } : {}) });
      }
      setProblem('');
      if (!pending.current) { clearDraft(n.id); setStatus('saved'); }
      savedCb.current?.(res);
    } catch (err) {
      pending.current = { ...sent, ...(pending.current || {}) };
      const d = err?.status === 409 ? err.detail : null;
      const bad = d ? null : refusedFields(err, sent, board);
      if (d?.note && c && d.epoch) {
        // The live state was rebuilt elsewhere (Quick Note, a restore):
        // merge these words into the saved copy, join the new session, and
        // the next save puts the merged words into it (setHtml above).
        if (!board) pending.current = { ...pending.current, body: c.getHtml() ?? pending.current.body };
        mergeIn(d.note);
        if (pending.current) external.current = true;
        rejoin.current = { from: c.epoch, at: Date.now() };
        c.restart();
        again = !!pending.current;
      } else if (d?.note && c && d.collab) {
        // Someone else saved first: take their state in (Yjs merges it) and save again.
        c.applyState(d.collab.ydoc);
        const t = mergeTitle(base.current.title, pending.current.title ?? noteRef.current?.title ?? '', d.note.title || '');
        rev.current = d.note.rev;
        setBase(d.note);
        if (board && pending.current.scene != null) pending.current.scene = mergeScenes(pending.current.scene, d.note.scene || '');
        put({ ...d.note, title: t.title, body: c.getHtml() ?? d.note.body, ...(board ? { scene: pending.current.scene ?? d.note.scene } : {}) });
        if ('title' in pending.current) pending.current.title = t.title;
        again = true;
      } else if (d?.note) {
        again = mergeIn(d.note);
      } else if (bad) {
        // Refused for what it carried: re-sending it would be refused
        // forever. Drop the field (unless something newer was drawn since),
        // say why, keep the last good copy on the server.
        for (const f of bad) if (pending.current[f] === sent[f]) delete pending.current[f];
        if (!Object.keys(pending.current).length) pending.current = null;
        setProblem((typeof err.detail === 'string' && err.detail) || err.message || 'This could not be saved.');
        setStatus('error');
        refused = !bad.some((f) => pending.current && f in pending.current && pending.current[f] !== sent[f]);
      } else {
        setStatus('error');
      }
    } finally {
      inFlight.current = false;
    }
    if (pending.current && noteRef.current?.id === n.id && !conflictRef.current && !refused) {
      timer.current = setTimeout(() => saveRef.current(), again ? 0 : SAVE_MS);
    } else if (!pending.current && !conflictRef.current && again) {
      setStatus('saved');
    }
  }, [put, mergeIn]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { saveRef.current = save; }, [save]);
  useEffect(() => { conflictRef.current = conflict; }, [conflict]);

  // Load (and on leaving, save).
  useEffect(() => {
    let alive = true;
    pending.current = null;
    setConflict(null);
    conflictRef.current = null;
    setRestored(false);
    setMerged('');
    setPeople([]);
    setProblem('');
    external.current = false;
    rejoin.current = null;
    if (!id) { put(null); setStatus('missing'); return undefined; }
    setStatus('loading');
    api.noteGet(id).then((n) => {
      if (!alive) return;
      rev.current = n.rev;
      const draft = n.can === 'read' ? null : readDraft(id);
      const board = n.kind === 'board';
      const sceneDiffers = board && typeof draft?.scene === 'string' && draft.scene !== (n.scene || '');
      const titleDiffers = !!draft && (draft.title ?? n.title) !== n.title;
      const differs = draft && (titleDiffers || sceneDiffers || (!board && (draft.body ?? n.body) !== n.body));
      if (differs && board) {
        // Drawn here and never saved. A board never sends a body. Same rev:
        // put it back as it was; the rev moved on: the shapes drawn here go
        // into the server's copy per element (never the draft alone over
        // a collaborator's newer work), the title merges.
        const same = draft.rev === n.rev;
        const title = same ? (draft.title ?? n.title) : mergeTitle(draft.baseTitle ?? '', draft.title ?? n.title ?? '', n.title || '').title;
        const scene = sceneDiffers ? (same ? draft.scene : mergeScenes(draft.scene, n.scene || '')) : (n.scene || '');
        setBase(n);
        const next = {};
        if (title !== n.title) next.title = title;
        if (scene !== (n.scene || '')) next.scene = scene;
        if (Object.keys(next).length) {
          put({ ...n, ...next });
          pending.current = next;
          setRestored(true);
          if (!same) setMerged(n.updatedBy || 'someone');
          setStatus('dirty');
          timer.current = setTimeout(() => saveRef.current(), SAVE_MS);
        } else {
          clearDraft(id);
          put(n);
          setStatus('saved');
        }
      } else if (differs && draft.rev === n.rev) {
        // Typed here and never saved: put it back and save it.
        setBase(n);
        put({ ...n, title: draft.title ?? n.title, body: draft.body ?? n.body });
        pending.current = { title: draft.title ?? n.title, body: draft.body ?? n.body };
        rev.current = n.rev;
        setRestored(true);
        setStatus('dirty');
        timer.current = setTimeout(() => saveRef.current(), SAVE_MS);
      } else if (differs) {
        // Typed here, and the note changed somewhere else since: merge
        // against the copy the typing started from (kept with the draft).
        base.current = { title: draft.baseTitle ?? '', body: draft.baseBody ?? '' };
        put({ ...n, title: draft.title ?? n.title, body: draft.body ?? n.body });
        pending.current = { title: draft.title ?? n.title, body: draft.body ?? n.body };
        setRestored(true);
        if (mergeIn(n)) {
          setStatus('dirty');
          timer.current = setTimeout(() => saveRef.current(), SAVE_MS);
        }
      } else {
        if (draft) clearDraft(id);
        setBase(n);
        put(n);
        setStatus('saved');
      }
    }).catch((err) => {
      if (!alive) return;
      put(null);
      setStatus(err?.status === 404 ? 'missing' : 'error');
    });
    return () => {
      alive = false;
      clearTimeout(timer.current);
      if (pending.current) saveRef.current();
    };
  }, [id, put, mergeIn]);

  // Hidden tab / closing: save now (the draft covers a save that cannot finish).
  useEffect(() => {
    const flush = () => { if (document.visibilityState === 'hidden' || !document.visibilityState) saveRef.current(); };
    const onHide = () => saveRef.current();
    document.addEventListener('visibilitychange', flush);
    window.addEventListener('pagehide', onHide);
    return () => { document.removeEventListener('visibilitychange', flush); window.removeEventListener('pagehide', onHide); };
  }, []);

  // Re-read the note in place (someone else saved and nothing waits here).
  const refresh = useCallback(async () => {
    const n = noteRef.current;
    if (!n || pending.current || inFlight.current || conflictRef.current) return;
    try {
      const fresh = await api.noteGet(n.id);
      if (pending.current || inFlight.current || conflictRef.current || noteRef.current?.id !== fresh.id) return;
      const c = live();
      if (c && api.noteCollab) {
        // Co-typing: the words come through the shared state (the channel
        // may be down - take the saved state in, Yjs merges it). The rev
        // moves on ONLY with that state applied: a rev without the words
        // would let the next save write the others' paragraph away.
        let st;
        try { st = await api.noteCollab(fresh.id); } catch { return; /* next beat; a save meanwhile merges on its 409 */ }
        if (st.yepoch !== c.epoch) { c.restart(); return; }
        if (pending.current || inFlight.current || conflictRef.current || noteRef.current?.id !== fresh.id) return;
        c.applyState(st.ydoc);
        rev.current = st.rev;
        setBase({ title: st.title, body: st.body });
        put({ ...fresh, rev: st.rev, title: st.title, body: c.getHtml() ?? st.body });
        return;
      }
      rev.current = fresh.rev;
      setBase(fresh);
      put(fresh);
    } catch { /* next beat */ }
  }, [put]); // eslint-disable-line react-hooks/exhaustive-deps

  // The heartbeat: here, and whether the note moved on.
  useEffect(() => {
    if (!id || !api.notePresence) return undefined;
    let stop = false;
    const beat = async () => {
      if (stop || (document.visibilityState && document.visibilityState !== 'visible') || !noteRef.current) return;
      const editing = Date.now() - lastEdit.current < EDITING_MS;
      try {
        const r = await api.notePresence(id, editing ? 'editing' : 'viewing');
        if (stop || !r) return;
        setPeople(Array.isArray(r.people) ? r.people : []);
        const c = live();
        if (c && r.yepoch !== c.epoch && !pending.current && !inFlight.current) { c.restart(); return; }
        // The key moved on (an editor was removed): join the new channel.
        if (c && r.keyTag && c.keyTag && r.keyTag !== c.keyTag) { c.restart(); return; }
        if (r.rev !== rev.current) refresh();
      } catch { /* next beat */ }
    };
    const first = setTimeout(beat, 1200);
    const t = setInterval(beat, BEAT_MS);
    const onVis = () => { if (document.visibilityState === 'visible') beat(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { stop = true; clearTimeout(first); clearInterval(t); document.removeEventListener('visibilitychange', onVis); };
  }, [id, refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  // Title / body typing.
  const edit = useCallback((fields) => {
    const n = noteRef.current;
    if (!n || n.can === 'read') return;
    const board = n.kind === 'board';
    // A board has no words: a body never goes into its pending save or its draft.
    const f = board && 'body' in fields ? Object.fromEntries(Object.entries(fields).filter(([k]) => k !== 'body')) : fields;
    if (!Object.keys(f).length) return;
    const next = { ...n, ...f };
    put(next);
    lastEdit.current = Date.now();
    pending.current = { ...(pending.current || {}), ...f };
    if (board) {
      const sceneDraft = typeof next.scene === 'string' && next.scene.length <= DRAFT_SCENE_MAX ? { scene: next.scene } : {};
      writeDraft(n.id, { rev: rev.current, title: next.title, baseTitle: base.current.title, ...sceneDraft });
    } else {
      writeDraft(n.id, { rev: rev.current, title: next.title, body: next.body, baseTitle: base.current.title, baseBody: base.current.body });
    }
    if (conflictRef.current) return;
    setStatus('dirty');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => saveRef.current(), SAVE_MS);
  }, [put]);

  // Someone else's words arriving live: shown (word count, list preview), never saved from here.
  const seeRemote = useCallback((body) => {
    const n = noteRef.current;
    if (n && n.body !== body) put({ ...n, body });
  }, [put]);

  // Pin, color, tags, day: saved at once (with any typing still waiting).
  const setMeta = useCallback((fields) => {
    const n = noteRef.current;
    if (!n || !n.mine) return;
    put({ ...n, ...fields });
    pending.current = { ...(pending.current || {}), ...fields };
    if (!conflictRef.current) saveRef.current();
  }, [put]);

  // Fields any editor may write at once (a board's thumbnail): saved with
  // whatever else is waiting. Pin / color / tags / day stay the owner's (setMeta).
  const setFields = useCallback((fields) => {
    const n = noteRef.current;
    if (!n || n.can === 'read' || n.trashedAt) return;
    put({ ...n, ...fields });
    pending.current = { ...(pending.current || {}), ...fields };
    if (!conflictRef.current) saveRef.current();
  }, [put]);

  // A clash settled: choices[k] = 'mine' | 'theirs' | 'both' per clashing
  // block, title 'mine' | 'theirs'. The result is saved over the server copy.
  const resolve = useCallback((choices = {}, titleChoice = 'mine') => {
    const c = conflictRef.current;
    if (!c) return;
    const body = mergeNotes(base.current.body, c.mine.body, c.server.body || '', choices, MERGE).html;
    const title = c.titleClash ? (titleChoice === 'theirs' ? c.titleClash.theirs : c.titleClash.mine) : (noteRef.current?.title ?? c.mine.title);
    rev.current = c.server.rev;
    pending.current = { ...(pending.current || {}), title, body };
    put({ ...c.server, title, body });
    external.current = true;
    setConflict(null);
    conflictRef.current = null;
    saveRef.current();
  }, [put]);

  const keepMine = useCallback(() => resolve({}, 'mine'), [resolve]);

  // Their words for every clash; what was typed here elsewhere stays.
  const takeTheirs = useCallback(() => {
    const c = conflictRef.current;
    if (!c) return;
    resolve(Object.fromEntries(c.clashes.map((_, k) => [k, 'theirs'])), 'theirs');
  }, [resolve]);

  // A copy the server handed back from another action (share, trash, restore
  // a version): take it as the new base without losing typing in flight.
  // `hard` (a restored version) replaces the words too.
  const replace = useCallback((n, hard = false) => {
    if (!n) return;
    rev.current = n.rev;
    setBase(n);
    const cur = noteRef.current;
    if (hard) { pending.current = null; clearDraft(n.id); setStatus('saved'); }
    put(pending.current && cur ? { ...n, title: cur.title, body: cur.body } : n);
  }, [put]);

  return {
    note, status, conflict, restored, merged, people, problem,
    edit, seeRemote, setMeta, setFields, resolve, keepMine, takeTheirs, replace, refresh, flush: save,
  };
}

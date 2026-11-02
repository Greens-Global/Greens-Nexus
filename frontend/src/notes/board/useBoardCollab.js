// Live collaboration on one open board (Notes whiteboard, Neil 11/02/2026).
//
// The same session a shared note's co-typing uses (useNoteCollab), with the
// engine's elements in the shared document instead of words: a board shared
// with Can Edit people is opened by one of its editors; the shared document
// comes from the server (GET /notes/{id}/collab) or, when the board has none
// yet, is seeded from its saved scene by exactly one browser (POST
// /collab/seed: the first wins, a second joins the winner's). Changes then
// travel encrypted over the board's Realtime channel (collabTransport.js);
// the channel is a speed-up only - every save carries the shared state too,
// so two people whose channel is down still end up with each other's shapes.
//
// What goes over the wire: each changed element, whole, keyed by its id
// (boardSync.js: the newest version wins, a tie goes to the lower nonce -
// the engine's own rule), new image meta, and presence: who, where their
// pointer is, which shapes they hold selected. The others' pointers are
// drawn by the engine as collaborator cursors with their names.
//
// status: off | connecting | live | stale. `live` = the channel is up and
// trusted; `stale` = the tab was hidden or a message did not open (the key
// may have moved on), so nothing from the channel is applied until the
// server confirms the key and `resync()` catches up - exactly as notes do.
// `phase` / `epoch` / `keyTag` / `encodeState` / `applyState` / `restart` /
// `getHtml` / `setHtml` are the surface useNoteSync reads through collabRef,
// so a board's save carries its live state the way a note's does.
//
// A viewer (Can View) is never here: the key is handed to editors only
// (GET /collab is 403 for a read share), so a viewer follows the saves
// instead (Board.jsx applies a refreshed scene). The binding still refuses
// to write for a `canEdit: false` caller, as a second line.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api';
import { supabase } from '../../lib/supabase';
import { importKey, newEpoch } from '../collabCrypto';
import { caretColor } from '../useNoteCollab';
import { parseScene } from './scene';

const POINTER_MS = 50;
const noop = () => {};

/** The engine's collaborators map from everyone else's awareness state. */
export function collaboratorsFrom(awareness, myClientId) {
  const out = new Map();
  awareness.getStates().forEach((s, id) => {
    if (id === myClientId || !s?.user) return;
    const sel = Array.isArray(s.sel) ? s.sel : [];
    out.set(String(id), {
      id: s.user.email || String(id),
      username: s.user.name || s.user.email || 'Someone',
      color: { background: s.user.color || '#64748b', stroke: s.user.color || '#64748b' },
      pointer: s.pointer && Number.isFinite(s.pointer.x) && Number.isFinite(s.pointer.y)
        ? { x: s.pointer.x, y: s.pointer.y, tool: s.pointer.tool === 'laser' ? 'laser' : 'pointer' } : undefined,
      button: s.button === 'down' ? 'down' : 'up',
      selectedElementIds: Object.fromEntries(sel.filter((x) => typeof x === 'string').map((x) => [x, true])),
    });
  });
  return out;
}

export function useBoardCollab({ note, canEdit, enabled, me, name }) {
  const noteId = note?.id || '';
  const on = !!enabled && !!noteId;
  const [phase, setPhase] = useState('off');
  const [live, setLive] = useState(false);
  const [trusted, setTrusted] = useState(true);
  const [peers, setPeers] = useState([]);
  const [session, setSession] = useState(null);   // { rt, sync, doc, awareness, binding, epoch, keyTag, conn }
  const [gen, setGen] = useState(0);
  const restart = useCallback(() => setGen((g) => g + 1), []);
  // The engine, and what Board asked us to do with remote files - kept across
  // sessions so a rebuilt session re-attaches to the same engine.
  const apiRef = useRef(null);
  const optsRef = useRef({});
  const sessionRef = useRef(null);
  useEffect(() => { sessionRef.current = session; }, [session]);
  const pointerTimer = useRef(0);
  const pointerNext = useRef(null);
  const lastSel = useRef('');

  useEffect(() => {
    if (!on) return undefined;
    let alive = true;
    let conn = null;
    let awareness = null;
    let binding = null;
    let keyCheck = 0;
    let trustedNow = true;
    let later = null;
    let onVisible = null;
    (async () => {
      try {
        const [rt, sync] = await Promise.all([import('../collabTransport'), import('./boardSync')]);
        if (!alive) return;
        setPhase('loading');
        setTrusted(true);
        let st = await api.noteCollab(noteId);
        let doc = null;
        let reset = false;
        for (let attempt = 0; alive && !doc && attempt < 4; attempt += 1) {
          if (st.yepoch) {
            const stored = rt.docFrom(st.ydoc);
            try { sync.validateBoardDoc(stored); doc = stored; break; } catch (bad) {
              // Not safe to show: drop it on the server (once) and rebuild from the saved scene.
              if (reset) throw bad;
              reset = true;
              await api.noteCollabReset(noteId);
              st = await api.noteCollab(noteId);
              continue;
            }
          }
          const fresh = sync.seedBoardDoc(parseScene(st.scene) || { elements: [], files: {} });
          const epoch = newEpoch();
          try {
            await api.noteCollabSeed(noteId, { rev: st.rev, ydoc: rt.encodeState(fresh), yepoch: epoch });
            doc = fresh;
            st = { ...st, yepoch: epoch };
          } catch (err) {
            if (err?.status !== 409) throw err;
            const won = err.detail?.collab;
            st = won?.yepoch ? { ...st, ...won } : await api.noteCollab(noteId);   // joined someone else's, or the board moved on
          }
        }
        if (!alive) return;
        if (!doc) throw new Error('Could not start the live session');
        const user = { name: name || me, color: caretColor(me), email: me };
        awareness = rt.newAwareness(doc, user);
        const others = () => {
          const out = [];
          awareness.getStates().forEach((s, id) => { if (id !== doc.clientID && s?.user) out.push(s.user); });
          setPeers(out);
          const eng = apiRef.current;
          if (eng) { try { eng.updateScene({ collaborators: collaboratorsFrom(awareness, doc.clientID) }); } catch { /* engine not ready */ } }
        };
        awareness.on('change', others);
        binding = sync.createBoardBinding({ doc, canEdit: !!canEdit });
        if (apiRef.current) binding.attach(apiRef.current, optsRef.current);
        const sess = { rt, sync, doc, awareness, binding, epoch: st.yepoch, keyTag: st.keyTag || '', conn: null };
        setSession(sess);
        setPhase('ready');
        // No realtime here: the saves still carry the shared state.
        if (!supabase) return;
        const key = await importKey(st.key);
        if (!alive) return;
        // Is this session's key still the board's key? At most every few
        // seconds unless `now` (the tab just came back).
        const check = async (now = false) => {
          const wait = 5000 - (Date.now() - keyCheck);
          if (!now && wait > 0) {
            if (!later) later = setTimeout(() => { later = null; check(true); }, wait);
            return;
          }
          keyCheck = Date.now();
          try {
            const cur = await api.noteCollab(noteId);
            if (!alive) return;
            if (cur.yepoch !== st.yepoch || cur.channel !== st.channel) { restart(); return; }
            if (!trustedNow) { trustedNow = true; setTrusted(true); conn?.resync(); }
          } catch (err) {
            if (alive && (err?.status === 403 || err?.status === 404)) { setPhase('failed'); setLive(false); }
          }
        };
        onVisible = () => {
          if (document.visibilityState === 'hidden') { trustedNow = false; setTrusted(false); return; }
          check(true);
        };
        document.addEventListener('visibilitychange', onVisible);
        conn = rt.connect({
          supabase, channelName: st.channel, key, noteId, epoch: st.yepoch, doc, awareness,
          hooks: {
            onLive: (isLive) => { if (alive) setLive(isLive); },
            trusted: () => trustedNow,
            // Someone is on a newer session: ask the server.
            onForeignEpoch: () => check(),
            // A message that did not open: the key may have moved on - trust
            // nothing on the channel until the server says it has not.
            onUnreadable: () => { trustedNow = false; setTrusted(false); check(); },
          },
        });
        sess.conn = conn;
        if (document.visibilityState === 'hidden') { trustedNow = false; setTrusted(false); }
      } catch {
        if (alive) { setPhase('failed'); setSession(null); }
      }
    })();
    return () => {
      alive = false;
      clearTimeout(later);
      if (onVisible) document.removeEventListener('visibilitychange', onVisible);
      conn?.close();
      binding?.detach();
      setTimeout(() => { try { awareness?.destroy(); } catch { /* gone */ } }, 100);
      // This session is over (disabled, a restart, another board): nothing of it stays on screen.
      setSession(null); setPhase('off'); setLive(false); setTrusted(true); setPeers([]);
    };
  }, [noteId, on, gen, me, name, canEdit, restart]);

  // The engine is on screen (Board.jsx calls this once it has the api; again
  // if the collab object changed). Idempotent.
  const attach = useCallback((eng, opts = {}) => {
    apiRef.current = eng;
    optsRef.current = opts || {};
    const s = sessionRef.current;
    if (s && eng) {
      s.binding.attach(eng, optsRef.current);
      try { eng.updateScene({ collaborators: collaboratorsFrom(s.awareness, s.doc.clientID) }); } catch { /* engine not ready */ }
    }
  }, []);

  // This browser changed something: elements and image meta into the shared
  // document, the selection into presence.
  const onChange = useCallback((elements, filesMeta, selectedElementIds) => {
    const s = sessionRef.current;
    if (!s) return;
    s.binding.push(elements, filesMeta);
    const sel = Object.keys(selectedElementIds || {}).sort();
    const key = sel.join(',');
    if (key !== lastSel.current) { lastSel.current = key; s.awareness.setLocalStateField('sel', sel); }
  }, []);

  // The pointer, at most every POINTER_MS (trailing).
  const pointer = useCallback((payload) => {
    const s = sessionRef.current;
    if (!s || !payload?.pointer) return;
    pointerNext.current = payload;
    if (pointerTimer.current) return;
    pointerTimer.current = setTimeout(() => {
      pointerTimer.current = 0;
      const p = pointerNext.current;
      const cur = sessionRef.current;
      if (!p || !cur) return;
      cur.awareness.setLocalStateField('pointer', { x: p.pointer.x, y: p.pointer.y, tool: p.pointer.tool === 'laser' ? 'laser' : 'pointer' });
      cur.awareness.setLocalStateField('button', p.button === 'down' ? 'down' : 'up');
    }, POINTER_MS);
  }, []);
  useEffect(() => () => clearTimeout(pointerTimer.current), []);

  const resync = useCallback(() => { sessionRef.current?.conn?.resync(); }, []);

  // The live state could not be used: drop it on the server (the next
  // opener rebuilds it from the saved scene) and finish on the saves.
  const fail = useCallback(() => {
    setPhase('failed');
    setSession(null);
    setLive(false);
    if (noteId) api.noteCollabReset(noteId).catch(() => { /* the next opener checks it again */ });
  }, [noteId]);

  const status = !on ? 'off' : phase !== 'ready' ? (phase === 'failed' ? 'off' : 'connecting') : !live ? 'connecting' : trusted ? 'live' : 'stale';

  return useMemo(() => ({
    enabled: on, phase, status, live: status === 'live', peers, restart, resync, attach, onChange, pointer, fail,
    epoch: session?.epoch || '',
    keyTag: session?.keyTag || '',
    // The surface useNoteSync reads (a board has no words to hand over).
    getHtml: () => null,
    setHtml: () => true,
    isRemote: () => false,
    encodeState: () => (session ? session.rt.encodeState(session.doc) : ''),
    applyState: (b64) => { if (session) session.rt.applyState(session.doc, b64); },
    bindEditor: noop,
  }), [on, phase, status, peers, restart, resync, attach, onChange, pointer, fail, session]);
}

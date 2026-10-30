// Live co-typing for one open note (Neil, Oct 30 2026).
//
// Only for a SHARED note opened by one of its editors (the owner or a Can
// Edit share); a private note, a read-only share and a browser without
// Supabase or WebCrypto stay on the ordinary saves (useNoteSync re-reads
// them and merges block by block). The shared document comes from the
// server (GET /notes/{id}/collab) - or, when the note has none yet, is
// seeded from its HTML by exactly one browser (POST /collab/seed: the
// first wins, a second joins the winner's). Edits then travel encrypted
// over the note's Realtime channel (collabRuntime.js); the channel is a
// speed-up only - the saves carry the shared state too, so two people
// whose channel is down still end up with each other's words.
//
// phase: off | loading | ready | failed. `restart()` drops this session and
// joins afresh (the state was rebuilt elsewhere). A stored state this
// browser cannot show safely (collabRuntime.validateDoc) is dropped on the
// server (POST /collab/reset) and rebuilt from the saved words once; `fail()`
// (the live editor crashed) does the same and leaves this visit on the
// ordinary saves.
//
// Trust: the key can move on (an editor removed) while this tab was hidden
// and its heartbeat paused. So a hidden tab stops trusting the channel, and
// coming back - or any message that does not open - asks the server for the
// current key first; until then nothing from the channel is applied or
// answered (collabRuntime connect), and once it checks out, resync() fetches
// whatever was missed.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { supabase } from '../lib/supabase';
import { canEncrypt, importKey, newEpoch } from './collabCrypto';

// Caret colors, picked by email so a person keeps theirs.
const CARETS = ['#00854d', '#2563eb', '#c2410c', '#7c3aed', '#be123c', '#0f766e', '#a16207', '#4f46e5'];
export function caretColor(email) {
  let h = 0;
  for (const ch of String(email || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return CARETS[h % CARETS.length];
}

export function collabEligible(note) {
  if (!note || note.trashedAt || note.can === 'read') return false;
  const shared = note.mine ? (note.sharedWith || []).length > 0 : true;
  return shared && !!supabase && canEncrypt();
}

export function useNoteCollab(noteId, { enabled, me, name }) {
  const [phase, setPhase] = useState('off');
  const [live, setLive] = useState(false);
  const [peers, setPeers] = useState([]);
  const [session, setSession] = useState(null);   // { rt, doc, awareness, epoch, extensions }
  const [gen, setGen] = useState(0);
  const editorRef = useRef(null);
  const restart = useCallback(() => setGen((g) => g + 1), []);

  useEffect(() => {
    if (!enabled || !noteId) { setPhase('off'); setSession(null); setLive(false); setPeers([]); return undefined; }
    let alive = true;
    let conn = null;
    let awareness = null;
    let keyCheck = 0;
    let trusted = true;
    let later = null;
    let onVisible = null;
    setPhase('loading');
    (async () => {
      try {
        const rt = await import('./collabRuntime');
        let st = await api.noteCollab(noteId);
        let doc = null;
        let reset = false;
        for (let attempt = 0; alive && !doc && attempt < 4; attempt += 1) {
          if (st.yepoch) {
            const stored = rt.docFrom(st.ydoc);
            try { rt.validateDoc(stored); doc = stored; break; } catch (bad) {
              // Not safe to show: drop it on the server (once) and rebuild from the saved words.
              if (reset) throw bad;
              reset = true;
              await api.noteCollabReset(noteId);
              st = await api.noteCollab(noteId);
              continue;
            }
          }
          const fresh = rt.seedDoc(st.body);
          const epoch = newEpoch();
          try {
            await api.noteCollabSeed(noteId, { rev: st.rev, ydoc: rt.encodeState(fresh), yepoch: epoch });
            doc = fresh;
            st = { ...st, yepoch: epoch };
          } catch (err) {
            if (err?.status !== 409) throw err;
            const won = err.detail?.collab;
            st = won?.yepoch ? { ...st, ...won } : await api.noteCollab(noteId);   // joined someone else's, or the note moved on
          }
        }
        if (!alive) return;
        if (!doc) throw new Error('Could not start the live session');
        const user = { name: name || me, color: caretColor(me) };
        awareness = rt.newAwareness(doc, user);
        const others = () => {
          const out = [];
          awareness.getStates().forEach((s, id) => { if (id !== doc.clientID && s?.user) out.push(s.user); });
          setPeers(out);
        };
        awareness.on('change', others);
        const extensions = rt.collabExtensions(doc, awareness, user);
        setSession({ rt, doc, awareness, epoch: st.yepoch, keyTag: st.keyTag || '', extensions });
        setPhase('ready');
        // No realtime here: the saves still carry the shared state.
        if (!supabase) return;
        const key = await importKey(st.key);
        if (!alive) return;
        // Is this session's key still the note's key? At most every few
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
            if (!trusted) { trusted = true; conn?.resync(); }
          } catch (err) {
            if (alive && (err?.status === 403 || err?.status === 404)) { setPhase('failed'); setLive(false); }
          }
        };
        onVisible = () => {
          if (document.visibilityState === 'hidden') { trusted = false; return; }
          check(true);
        };
        document.addEventListener('visibilitychange', onVisible);
        conn = rt.connect({
          supabase, channelName: st.channel, key, noteId, epoch: st.yepoch, doc, awareness,
          hooks: {
            onLive: (on) => { if (alive) setLive(on); },
            trusted: () => trusted,
            // Someone is on a newer session: ask the server.
            onForeignEpoch: () => check(),
            // A message that did not open: the key may have moved on - trust
            // nothing on the channel until the server says it has not.
            onUnreadable: () => { trusted = false; check(); },
          },
        });
        if (document.visibilityState === 'hidden') trusted = false;
      } catch {
        if (alive) { setPhase('failed'); setSession(null); }
      }
    })();
    return () => {
      alive = false;
      clearTimeout(later);
      if (onVisible) document.removeEventListener('visibilitychange', onVisible);
      conn?.close();
      setTimeout(() => { try { awareness?.destroy(); } catch { /* gone */ } }, 100);
    };
  }, [noteId, enabled, gen, me, name, restart]);

  const bindEditor = useCallback((editor) => { editorRef.current = editor; }, []);

  // The live editor could not render the shared state: drop it on the
  // server (the next opener rebuilds it from the saved words) and finish
  // this visit on the ordinary saves.
  const fail = useCallback(() => {
    setPhase('failed');
    setSession(null);
    setLive(false);
    if (noteId) api.noteCollabReset(noteId).catch(() => { /* the next opener checks it again */ });
  }, [noteId]);

  return useMemo(() => ({
    phase, live, peers, restart, bindEditor, fail,
    epoch: session?.epoch || '',
    keyTag: session?.keyTag || '',
    extensions: session?.extensions || null,
    isRemote: session ? session.rt.isRemote : () => false,
    getHtml: () => (editorRef.current && !editorRef.current.isDestroyed ? editorRef.current.getHTML() : null),
    // Put words that were merged outside the editor into the shared document.
    setHtml: (html) => {
      const ed = editorRef.current;
      if (!ed || ed.isDestroyed) return false;
      ed.commands.setContent(html || '', { emitUpdate: false });
      return true;
    },
    encodeState: () => (session ? session.rt.encodeState(session.doc) : ''),
    applyState: (b64) => { if (session) session.rt.applyState(session.doc, b64); },
  }), [phase, live, peers, restart, bindEditor, session]);
}

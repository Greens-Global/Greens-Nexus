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
// joins afresh (the state was rebuilt elsewhere).
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
    setPhase('loading');
    (async () => {
      try {
        const rt = await import('./collabRuntime');
        let st = await api.noteCollab(noteId);
        let doc = null;
        for (let attempt = 0; alive && !doc && attempt < 3; attempt += 1) {
          if (st.yepoch) { doc = rt.docFrom(st.ydoc); break; }
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
        setSession({ rt, doc, awareness, epoch: st.yepoch, extensions });
        setPhase('ready');
        // No realtime here: the saves still carry the shared state.
        if (!supabase) return;
        const key = await importKey(st.key);
        if (!alive) return;
        const check = async () => {
          if (Date.now() - keyCheck < 5000) return;
          keyCheck = Date.now();
          try {
            const now = await api.noteCollab(noteId);
            if (alive && (now.yepoch !== st.yepoch || now.channel !== st.channel)) restart();
          } catch (err) {
            if (alive && (err?.status === 403 || err?.status === 404)) { setPhase('failed'); setLive(false); }
          }
        };
        conn = rt.connect({
          supabase, channelName: st.channel, key, epoch: st.yepoch, doc, awareness,
          hooks: {
            onLive: (on) => { if (alive) setLive(on); },
            // Someone is on a newer session, or the key moved on (an editor
            // was removed): ask the server, at most every few seconds.
            onForeignEpoch: () => check(),
            onUnreadable: () => check(),
          },
        });
      } catch {
        if (alive) { setPhase('failed'); setSession(null); }
      }
    })();
    return () => {
      alive = false;
      conn?.close();
      setTimeout(() => { try { awareness?.destroy(); } catch { /* gone */ } }, 100);
    };
  }, [noteId, enabled, gen, me, name, restart]);

  const bindEditor = useCallback((editor) => { editorRef.current = editor; }, []);

  return useMemo(() => ({
    phase, live, peers, restart, bindEditor,
    epoch: session?.epoch || '',
    extensions: session?.extensions || null,
    isRemote: session ? session.rt.isRemote : () => false,
    getHtml: () => (editorRef.current && !editorRef.current.isDestroyed ? editorRef.current.getHTML() : null),
    encodeState: () => (session ? session.rt.encodeState(session.doc) : ''),
    applyState: (b64) => { if (session) session.rt.applyState(session.doc, b64); },
  }), [phase, live, peers, restart, bindEditor, session]);
}

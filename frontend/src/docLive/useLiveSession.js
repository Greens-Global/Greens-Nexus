// One live editing session on a Document or a Sheet (Neil, 11/05/2026,
// routers/documents.py "Working together").
//
// The same session Notes and boards run (notes/board/useBoardCollab.js), for a
// Documents row: the shared Yjs document comes from the server
// (GET /documents/{id}/collab) or, when there is none yet, is seeded from the
// saved content by exactly one browser (POST /collab/seed: the first wins, a
// second joins the winner's). Changes travel encrypted over the document's
// Realtime channel (notes/collabTransport.js); the channel is a speed-up
// only - every save carries the shared state, so two people whose channel is
// down still end up with each other's changes. The engine is the caller's:
// `seed(content)` builds a Y.Doc from saved content and `validate(doc)`
// throws when a stored state is not safe to show.
//
// status: off | connecting | live | stale | failed | saves (no Realtime here:
// the saves alone carry everyone's changes). `stale` = the tab was
// hidden or a message did not open (the key may have moved on): nothing from
// the channel is applied until the server confirms the key and resync()
// catches up.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { supabase } from '../lib/supabase';
import { importKey, newEpoch } from '../notes/collabCrypto';
import { caretColor } from '../notes/useNoteCollab';

export function useLiveSession({ docId, enabled, me, name, seed, validate }) {
  const on = !!enabled && !!docId;
  const [phase, setPhase] = useState('off');
  const [live, setLive] = useState(false);
  const [trusted, setTrusted] = useState(true);
  const [peers, setPeers] = useState([]);
  const [session, setSession] = useState(null);   // { rt, doc, awareness, epoch, rev, conn }
  const [gen, setGen] = useState(0);
  const restart = useCallback(() => setGen((g) => g + 1), []);
  const sessionRef = useRef(null);
  useEffect(() => { sessionRef.current = session; }, [session]);
  const nameRef = useRef(name);
  useEffect(() => { nameRef.current = name; }, [name]);
  const engineRef = useRef({ seed, validate });
  useEffect(() => { engineRef.current = { seed, validate }; }, [seed, validate]);

  useEffect(() => {
    if (!on) return undefined;
    let alive = true;
    let conn = null;
    let awareness = null;
    let keyCheck = 0;
    let trustedNow = true;
    let later = null;
    let onVisible = null;
    (async () => {
      try {
        const rt = await import('../notes/collabTransport');
        if (!alive) return;
        setPhase('loading');
        setTrusted(true);
        let st = await api.documentCollab(docId);
        let doc = null;
        let reset = false;
        for (let attempt = 0; alive && !doc && attempt < 4; attempt += 1) {
          if (st.yepoch) {
            const stored = rt.docFrom(st.ydoc);
            try { engineRef.current.validate(stored); doc = stored; break; } catch (bad) {
              // Not safe to show: drop it on the server (once) and rebuild from the saved content.
              if (reset) throw bad;
              reset = true;
              await api.documentCollabReset(docId);
              st = await api.documentCollab(docId);
              continue;
            }
          }
          const fresh = engineRef.current.seed(st.content);
          const epoch = newEpoch();
          try {
            await api.documentCollabSeed(docId, { rev: st.rev, ydoc: rt.encodeState(fresh), yepoch: epoch });
            doc = fresh;
            st = { ...st, yepoch: epoch };
          } catch (err) {
            if (err?.status !== 409) throw err;
            const won = err.detail?.collab;
            st = won?.yepoch ? { ...st, ...won } : await api.documentCollab(docId);
          }
        }
        if (!alive) return;
        if (!doc) throw new Error('Could not start the live session');
        awareness = rt.newAwareness(doc, { name: nameRef.current || me, color: caretColor(me), email: me });
        awareness.on('change', () => {
          const out = [];
          awareness.getStates().forEach((s, id) => { if (id !== doc.clientID && s?.user) out.push(s.user); });
          setPeers(out);
        });
        const sess = { rt, doc, awareness, epoch: st.yepoch, rev: st.rev, keyTag: st.keyTag || '', conn: null };
        setSession(sess);
        setPhase('ready');
        if (!supabase) return;       // no realtime here: the saves still carry the shared state
        const key = await importKey(st.key);
        if (!alive) return;
        const check = async (now = false) => {
          const wait = 5000 - (Date.now() - keyCheck);
          if (!now && wait > 0) {
            if (!later) later = setTimeout(() => { later = null; check(true); }, wait);
            return;
          }
          keyCheck = Date.now();
          try {
            const cur = await api.documentHead(docId);
            if (!alive) return;
            if (cur.yepoch !== st.yepoch || (cur.keyTag && cur.keyTag !== st.keyTag)) { restart(); return; }
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
          supabase, channelName: st.channel, key, noteId: `doc:${docId}`, epoch: st.yepoch, doc, awareness,
          hooks: {
            onLive: (isLive) => { if (alive) setLive(isLive); },
            trusted: () => trustedNow,
            onForeignEpoch: () => check(),
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
      setTimeout(() => { try { awareness?.destroy(); } catch { /* gone */ } }, 100);
      setSession(null); setPhase('off'); setLive(false); setTrusted(true); setPeers([]);
    };
  }, [docId, on, gen, me, restart]);

  // A name that arrives mid-session goes into presence as is.
  useEffect(() => {
    const aw = session?.awareness;
    if (!aw || !name) return;
    try {
      const cur = aw.getLocalState()?.user || {};
      if (cur.name !== name) aw.setLocalStateField('user', { ...cur, name, email: me, color: cur.color || caretColor(me) });
    } catch { /* the session is closing */ }
  }, [name, me, session]);

  // Save the content `build(doc)` makes, with the shared state. A rev someone
  // else moved on is merged (their state into ours) and sent again; an epoch
  // the server no longer has restarts the session.
  const save = useCallback(async (build, extra = {}) => {
    const s = sessionRef.current;
    if (!s) return null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const out = await api.updateDocument(docId, {
          ...extra, content: build(s.doc), ydoc: s.rt.encodeState(s.doc), yepoch: s.epoch, rev: s.rev,
        });
        s.rev = out?.currentVersion || s.rev + 1;
        return out;
      } catch (err) {
        if (err?.status !== 409) throw err;
        const d = err.detail || {};
        if (d.epoch || !d.collab) { restart(); throw err; }
        if (d.collab.ydoc) s.rt.applyState(s.doc, d.collab.ydoc);
        s.rev = d.collab.rev || s.rev;
      }
    }
    throw new Error('This document keeps changing - try again in a moment.');
  }, [docId, restart]);

  const fail = useCallback(() => {
    setPhase('failed');
    setSession(null);
    setLive(false);
    if (docId) api.documentCollabReset(docId).catch(() => { /* the next opener checks it again */ });
  }, [docId]);

  const status = !on ? 'off' : phase === 'failed' ? 'failed' : phase === 'ready' && !supabase ? 'saves' : phase !== 'ready' || !live ? 'connecting' : trusted ? 'live' : 'stale';

  return useMemo(() => ({
    status, ready: !!session, peers, restart, fail, save,
    doc: session?.doc || null, awareness: session?.awareness || null,
  }), [status, session, peers, restart, fail, save]);
}

/** A viewer's follow-along: true once the document moved since `rev`. Polls /head every 10 s while visible. */
export function useHeadPoll(docId, rev, enabled) {
  const [movedPast, setMovedPast] = useState(0);   // the rev the document moved past, 0 = not yet
  useEffect(() => {
    if (!enabled || !docId) return undefined;
    const t = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      api.documentHead(docId).then((h) => { if ((h?.rev || 0) > (rev || 0)) setMovedPast(rev || 0); }).catch(() => { /* next tick */ });
    }, 10_000);
    return () => clearInterval(t);
  }, [docId, rev, enabled]);
  return enabled && movedPast === (rev || 0) && movedPast !== 0;
}

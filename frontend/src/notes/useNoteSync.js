// One open note kept in step with the server (Notes, Oct 29 2026).
//
// Typing changes the note on screen at once, writes a local draft (so a tab
// switch, a reload or a crash loses nothing) and saves shortly after the
// typing stops. Every save carries the rev the note was read with; when
// someone else saved in between the server says 409 with its copy, and the
// screen offers Keep Mine / Use Theirs - neither side is dropped silently.
// Leaving (another note, another view, the tab hidden) saves at once.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { clearDraft, readDraft, writeDraft } from './notesModel';

export const SAVE_MS = 800;

// status: loading | saved | dirty | saving | conflict | error | missing
export function useNoteSync(id, { onSaved } = {}) {
  const [note, setNote] = useState(null);
  const [status, setStatus] = useState(id ? 'loading' : 'missing');
  const [conflict, setConflict] = useState(null);   // the server copy on a 409
  const [restored, setRestored] = useState(false);  // an unsaved draft came back
  const noteRef = useRef(null);
  const pending = useRef(null);       // fields typed since the last save went out
  const rev = useRef(0);
  const inFlight = useRef(false);
  const timer = useRef(null);
  const savedCb = useRef(onSaved);
  const conflictRef = useRef(null);
  const saveRef = useRef(null);
  useEffect(() => { savedCb.current = onSaved; }, [onSaved]);

  const put = useCallback((n) => { noteRef.current = n; setNote(n); }, []);

  const save = useCallback(async () => {
    clearTimeout(timer.current);
    const n = noteRef.current;
    if (!n || !pending.current || inFlight.current) return;
    if (n.can === 'read') { pending.current = null; return; }
    const sent = pending.current;
    pending.current = null;
    inFlight.current = true;
    setStatus('saving');
    try {
      const res = await api.noteUpdate(n.id, { rev: rev.current, ...sent });
      rev.current = res.rev;
      const cur = noteRef.current;
      if (cur && cur.id === res.id) {
        // Keep whatever was typed while the save was out.
        put({ ...res, title: pending.current?.title ?? cur.title, body: pending.current?.body ?? cur.body });
      }
      if (!pending.current) { clearDraft(n.id); setStatus('saved'); }
      savedCb.current?.(res);
    } catch (err) {
      pending.current = { ...sent, ...(pending.current || {}) };
      if (err?.status === 409 && err?.detail?.note) {
        setConflict(err.detail.note);
        setStatus('conflict');
      } else {
        setStatus('error');
      }
    } finally {
      inFlight.current = false;
    }
    if (pending.current && noteRef.current?.id === n.id && !conflictRef.current) {
      timer.current = setTimeout(() => saveRef.current(), SAVE_MS);
    }
  }, [put]);
  useEffect(() => { saveRef.current = save; }, [save]);
  useEffect(() => { conflictRef.current = conflict; }, [conflict]);

  // Load (and on leaving, save).
  useEffect(() => {
    let alive = true;
    pending.current = null;
    setConflict(null);
    setRestored(false);
    if (!id) { put(null); setStatus('missing'); return undefined; }
    setStatus('loading');
    api.noteGet(id).then((n) => {
      if (!alive) return;
      rev.current = n.rev;
      const draft = n.can === 'read' ? null : readDraft(id);
      const differs = draft && ((draft.body ?? n.body) !== n.body || (draft.title ?? n.title) !== n.title);
      if (differs && draft.rev === n.rev) {
        // Typed here and never saved: put it back and save it.
        put({ ...n, title: draft.title ?? n.title, body: draft.body ?? n.body });
        pending.current = { title: draft.title ?? n.title, body: draft.body ?? n.body };
        setRestored(true);
        setStatus('dirty');
        timer.current = setTimeout(() => saveRef.current(), SAVE_MS);
      } else if (differs) {
        // Typed here, and the note changed somewhere else since: ask.
        put({ ...n, title: draft.title ?? n.title, body: draft.body ?? n.body });
        pending.current = { title: draft.title ?? n.title, body: draft.body ?? n.body };
        setConflict(n);
        setStatus('conflict');
      } else {
        if (draft) clearDraft(id);
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
  }, [id, put]);

  // Hidden tab / closing: save now (the draft covers a save that cannot finish).
  useEffect(() => {
    const flush = () => { if (document.visibilityState === 'hidden' || !document.visibilityState) saveRef.current(); };
    const onHide = () => saveRef.current();
    document.addEventListener('visibilitychange', flush);
    window.addEventListener('pagehide', onHide);
    return () => { document.removeEventListener('visibilitychange', flush); window.removeEventListener('pagehide', onHide); };
  }, []);

  // Title / body typing.
  const edit = useCallback((fields) => {
    const n = noteRef.current;
    if (!n || n.can === 'read') return;
    const next = { ...n, ...fields };
    put(next);
    pending.current = { ...(pending.current || {}), ...fields };
    writeDraft(n.id, { rev: rev.current, title: next.title, body: next.body });
    if (conflictRef.current) return;
    setStatus('dirty');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => saveRef.current(), SAVE_MS);
  }, [put]);

  // Pin, color, tags, day: saved at once (with any typing still waiting).
  const setMeta = useCallback((fields) => {
    const n = noteRef.current;
    if (!n || !n.mine) return;
    put({ ...n, ...fields });
    pending.current = { ...(pending.current || {}), ...fields };
    if (!conflictRef.current) saveRef.current();
  }, [put]);

  const keepMine = useCallback(() => {
    const server = conflictRef.current;
    const n = noteRef.current;
    if (!server || !n) return;
    rev.current = server.rev;
    pending.current = { title: n.title, body: n.body, ...(pending.current || {}) };
    put({ ...server, title: n.title, body: n.body });
    setConflict(null);
    conflictRef.current = null;
    saveRef.current();
  }, [put]);

  const takeTheirs = useCallback(() => {
    const server = conflictRef.current;
    if (!server) return;
    rev.current = server.rev;
    pending.current = null;
    clearDraft(server.id);
    put(server);
    setConflict(null);
    setStatus('saved');
  }, [put]);

  // A copy the server handed back from another action (share, trash, restore
  // a version): take it as the new base without losing typing in flight.
  // `hard` (a restored version) replaces the words too.
  const replace = useCallback((n, hard = false) => {
    if (!n) return;
    rev.current = n.rev;
    const cur = noteRef.current;
    if (hard) { pending.current = null; clearDraft(n.id); setStatus('saved'); }
    put(pending.current && cur ? { ...n, title: cur.title, body: cur.body } : n);
  }, [put]);

  return { note, status, conflict, restored, edit, setMeta, keepMine, takeTheirs, replace, flush: save };
}

// The shell's side of the bridge (public/pdf-editor-app/nexus-bridge.js): the one
// place PdfEditorModule talks to the iframe. Every message is checked for origin
// and source, every send names the exact origin, and bytes are transferred.
import { useCallback, useEffect, useRef, useState } from 'react';
import { setInlineDirty } from '../../lib/dialogGuard';

const READY_WAIT_MS = 20_000;
const REPLY_WAIT_MS = 180_000;

export const NO_DOC = { hasDoc: false, dirty: false, name: '', pages: 0, redacted: false };

const announce = (hasDoc) => window.dispatchEvent(new CustomEvent('nexus:pdf-doc-state', { detail: { hasDoc } }));

export default function usePdfEngine(frameRef, config, handlers) {
  const [doc, setDoc] = useState(NO_DOC);
  const docRef = useRef(NO_DOC);
  const handlersRef = useRef(handlers);
  const configRef = useRef(config);
  const readyRef = useRef(false);
  const readyWaitersRef = useRef([]);
  const repliesRef = useRef(new Map());
  const nextIdRef = useRef(1);
  // A shell open is under way: the new name it brings is not a local file.
  const openingRef = useRef(false);
  useEffect(() => { handlersRef.current = handlers; configRef.current = config; });

  const post = useCallback((msg, transfer) => {
    const win = frameRef.current?.contentWindow;
    if (!win) return false;
    try { win.postMessage(msg, window.location.origin, transfer || []); return true; } catch { return false; }
  }, [frameRef]);

  const applyState = useCallback((next) => {
    const prev = docRef.current;
    const merged = { ...prev };
    ['hasDoc', 'dirty', 'name', 'pages', 'redacted'].forEach((key) => {
      if (next[key] !== undefined) merged[key] = next[key];
    });
    if (!merged.hasDoc) Object.assign(merged, NO_DOC);
    docRef.current = merged;
    setDoc(merged);
    if (merged.hasDoc !== prev.hasDoc) announce(merged.hasDoc);
    if (!merged.hasDoc && prev.hasDoc) handlersRef.current.onClosed?.();
    else if (!openingRef.current && merged.hasDoc && merged.name && merged.name !== prev.name) {
      handlersRef.current.onLocalOpen?.(merged);
    }
  }, []);

  useEffect(() => {
    const replies = repliesRef.current;
    const onMessage = (e) => {
      if (e.origin !== window.location.origin) return;
      if (!frameRef.current || e.source !== frameRef.current.contentWindow) return;
      const d = e.data;
      if (!d || typeof d.type !== 'string') return;
      switch (d.type) {
        case 'pdf-editor:doc-state':   // the engine's own, kept: hasDoc always, dirty once it has it
          applyState({ hasDoc: !!d.hasDoc, ...(d.dirty === undefined ? {} : { dirty: !!d.dirty }) });
          break;
        case 'pdf-bridge:ready':
          // The engine reloads itself to close a file, so a second ready is an empty editor.
          applyState(NO_DOC);
          readyRef.current = true;
          readyWaitersRef.current.splice(0).forEach((w) => w.resolve());
          post({ type: 'nexus:pdf-config', ...configRef.current });
          break;
        case 'pdf-bridge:state':
          applyState({ hasDoc: !!d.hasDoc, dirty: !!d.dirty, name: String(d.name || ''),
            pages: Number(d.pages) || 0, redacted: !!d.redacted });
          break;
        case 'pdf-bridge:local-open':
          if (!openingRef.current) handlersRef.current.onLocalOpen?.(docRef.current);
          break;
        case 'pdf-bridge:action':
          handlersRef.current.onAction?.(d.action);
          break;
        case 'pdf-bridge:did':
          handlersRef.current.onDid?.(d);
          break;
        case 'pdf-bridge:reply': {
          const waiter = replies.get(d.id);
          if (!waiter) return;
          replies.delete(d.id);
          clearTimeout(waiter.timer);
          if (d.ok) waiter.resolve(d);
          else waiter.reject(new Error(d.error || 'failed'));
          break;
        }
        default:
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [frameRef, applyState, post]);

  // Moving anywhere else in Nexus asks first (lib/dialogGuard.js, App.jsx navigate()).
  useEffect(() => { setInlineDirty('pdf-tools', doc.hasDoc && doc.dirty); }, [doc.hasDoc, doc.dirty]);
  useEffect(() => () => { setInlineDirty('pdf-tools', false); announce(false); }, []);

  const whenReady = useCallback(() => new Promise((resolve, reject) => {
    if (readyRef.current) { resolve(); return; }
    const waiter = { resolve: () => { clearTimeout(timer); resolve(); } };
    const timer = setTimeout(() => {
      readyWaitersRef.current = readyWaitersRef.current.filter((w) => w !== waiter);
      reject(new Error('not ready'));
    }, READY_WAIT_MS);
    readyWaitersRef.current.push(waiter);
  }), []);

  const request = useCallback(async (type, payload, transfer) => {
    await whenReady();
    return new Promise((resolve, reject) => {
      const id = nextIdRef.current;
      nextIdRef.current += 1;
      const timer = setTimeout(() => { repliesRef.current.delete(id); reject(new Error('timeout')); }, REPLY_WAIT_MS);
      repliesRef.current.set(id, { resolve, reject, timer });
      if (!post({ type, id, ...payload }, transfer)) {
        repliesRef.current.delete(id);
        clearTimeout(timer);
        reject(new Error('no frame'));
      }
    });
  }, [post, whenReady]);

  const openBytes = useCallback(async (bytes, name) => {
    openingRef.current = true;
    try {
      const reply = await request('nexus:pdf-open', { bytes, name }, [bytes]);
      applyState({ hasDoc: true, dirty: false, name: reply.name || name, pages: reply.pages, redacted: !!reply.redacted });
      return reply;
    } finally {
      openingRef.current = false;
    }
  }, [request, applyState]);

  const build = useCallback(() => request('nexus:pdf-build', {}), [request]);
  const markSaved = useCallback(() => {
    post({ type: 'nexus:pdf-mark-saved' });
    applyState({ dirty: false });
  }, [post, applyState]);
  const sendConfig = useCallback(() => {
    if (readyRef.current) post({ type: 'nexus:pdf-config', ...configRef.current });
  }, [post]);

  return { doc, docRef, openBytes, build, markSaved, sendConfig };
}

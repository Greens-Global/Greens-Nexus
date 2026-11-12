// Meeting Notes, Phase 3 (Neil, 11/12/2026): one recording, start to stop.
//
//   start(source)  - called INSIDE the tap on Start Transcribing (after the
//                    consent check), so the audio can start on an iPhone.
//                    Opens a session on the server (with the consent),
//                    listens, and turns speech into text with Whisper on this
//                    device - the model downloads while it already listens,
//                    so nothing said in the first minute is lost. If Whisper
//                    cannot run here, the browser's own speech service takes
//                    over (microphone only).
//   stop()         - stops listening, finishes the last few seconds, ends
//                    the session.
//
// The words go to the server a few lines at a time (and again until they
// land), so a closed tab loses at most the last few seconds. The screen is
// kept awake while listening (a phone that sleeps stops the microphone).
// The audio itself is never kept or sent.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../../api';
import { Chunker, attribute, segmentId, RATE } from './audio';
import { createCapture, canCapture, canShareTab, isPhoneLike } from './capture';
import { BrowserSpeech, browserSpeech, getEngine, pickModel, whisperSupported, MODELS } from './engine';

const TICK_MS = 1000;      // the clock and the sending of words
const SLOW = 0.85;       // a computer slower than this share of real time switches to the small model

export function transcriberSupport() {
  return {
    capture: canCapture(),
    whisper: whisperSupported(),
    browser: !!browserSpeech(),
    tab: canShareTab(),
    phone: isPhoneLike(),
  };
}

const newId = () => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export function useTranscriber(noteId, { onStarted } = {}) {
  const [state, setState] = useState({ phase: 'idle' });   // idle | starting | loading | listening | finishing | error
  const [live, setLive] = useState([]);                      // this recording's words, as they come
  const r = useRef({});
  const set = (patch) => setState((s) => ({ ...s, ...patch }));

  const sendNow = useCallback(async () => {
    const x = r.current;
    if (x.sending || !x.pending?.length || !x.session) return;
    x.sending = true;
    const batch = x.pending.slice(0, 100);
    try {
      await api.meetingRecordedSegments(noteId, x.session, batch);
      x.pending = x.pending.slice(batch.length);
      set({ unsent: x.pending.length });
    } catch {
      set({ unsent: x.pending.length });   // kept, sent again on the next beat
    } finally { x.sending = false; }
  }, [noteId]);

  const add = useCallback((segs) => {
    if (!segs.length) return;
    const x = r.current;
    x.pending = [...(x.pending || []), ...segs];
    setLive((l) => [...l, ...segs]);
  }, []);

  const keepAwake = useCallback(async () => {
    try { if (navigator.wakeLock && document.visibilityState === 'visible') r.current.wake = await navigator.wakeLock.request('screen'); } catch { /* not offered here */ }
  }, []);

  // Whisper: take pieces off the queue one at a time.
  const pump = useCallback(async () => {
    const x = r.current;
    if (x.busy || !x.ready) return;
    x.busy = true;
    try {
      while (x.queue.length) {
        const piece = x.queue.shift();
        set({ behind: Math.round(x.queue.reduce((s, p) => s + p.seconds, 0)) });
        let res;
        try { res = await x.engine.transcribe(piece.audio); } catch (e) { set({ warn: e.message }); continue; }
        x.chunk += 1;
        const segs = (res.chunks.length ? res.chunks : [{ start: 0, end: piece.seconds, text: res.text }])
          .filter((c) => c.text && !/^\[.*\]$|^\(.*\)$/.test(c.text))         // "[BLANK_AUDIO]", "(music)"
          .map((c, k) => ({
            id: segmentId(x.session, x.chunk, k),
            at: x.t0 + piece.offset + c.start,
            end: x.t0 + piece.offset + (c.end || c.start),
            speaker: attribute(x.frames, piece.offset + c.start, piece.offset + (c.end || c.start + 1), x.hasTab),
            text: c.text,
          }));
        add(segs);
        x.frames = x.frames.filter((f) => f.t >= piece.offset + piece.seconds - 1);
        // Keep up: a machine that reads slower than the meeting moves to the small model.
        const rtf = res.ms / 1000 / Math.max(1, piece.seconds);
        x.rtf = x.rtf == null ? rtf : x.rtf * 0.6 + rtf * 0.4;
        if (x.size === 'base' && x.chunk >= 2 && x.rtf > SLOW && !x.downshifted) {
          x.downshifted = true;
          x.size = 'tiny';
          set({ model: 'tiny', note: 'Switched to the faster speech model to keep up.' });
          try { await x.engine.load('tiny', (p) => set({ progress: p })); } catch { /* keep the current one */ }
        }
      }
      set({ behind: 0 });
    } finally { x.busy = false; }
    if (x.finishing && !x.queue.length) x.doneFinishing?.();
  }, [add]);

  const startBrowser = useCallback(async (session) => {
    const x = r.current;
    x.speech = new BrowserSpeech();
    let n = 0;
    x.speech.start({
      onPhrase: ({ text, at }) => { n += 1; add([{ id: segmentId(session, 'b', n), at, end: Date.now() / 1000, speaker: '', text }]); },
      onError: (e) => set({ phase: 'error', error: e.message }),
    });
  }, [add]);

  const cleanup = useCallback(() => {
    const x = r.current;
    clearInterval(x.timer);
    x.cap?.stop();
    x.speech?.stop();
    try { x.wake?.release?.(); } catch { /* gone */ }
    document.removeEventListener('visibilitychange', x.onVis);
  }, []);

  const start = useCallback((source = 'mic') => {
    const support = transcriberSupport();
    const useWhisper = support.whisper && support.capture;
    if (!useWhisper && !(support.browser && source === 'mic')) {
      setState({ phase: 'error', error: source === 'mic+tab'
        ? 'This browser cannot transcribe a call - use Chrome or Edge on a computer.'
        : 'This browser cannot transcribe - use Chrome, Edge or Safari.' });
      return;
    }
    // Made synchronously, inside the tap - an iPhone only starts audio from one.
    const cap = useWhisper ? createCapture() : null;
    const session = newId();
    const x = { cap, session, queue: [], frames: [], chunk: 0, pending: [], ready: false, size: pickModel(navigator, support.phone),
      engine: useWhisper ? getEngine() : null, hasTab: false, t0: Date.now() / 1000 };
    r.current = x;
    setLive([]);
    setState({ phase: 'starting', engine: useWhisper ? 'whisper' : 'browser', source, model: x.size, startedAt: Date.now(), elapsed: 0, behind: 0, unsent: 0 });
    (async () => {
      try {
        await api.meetingRecordedStart(noteId, { id: session, engine: useWhisper ? 'whisper' : 'browser', source, consent: true });
      } catch (e) { cleanup(); setState({ phase: 'error', error: e.message || 'Could not start the recording' }); return; }
      x.timer = setInterval(() => { set({ elapsed: Math.round((Date.now() - (r.current.t0 * 1000)) / 1000) }); sendNow(); }, TICK_MS);
      x.onVis = () => { if (document.visibilityState === 'visible' && !x.stopped) keepAwake(); };
      document.addEventListener('visibilitychange', x.onVis);
      keepAwake();
      onStarted?.(Date.now());
      if (!useWhisper) { await startBrowser(session); set({ phase: 'listening' }); return; }
      const chunker = new Chunker({ rate: RATE });
      try {
        const opened = await cap.open({
          source,
          onTabEnded: () => set({ note: 'The call stopped being shared - still listening to your microphone.' }),
          onAudio: (samples, level) => {
            const t = chunker.offset / RATE + chunker.length / RATE;
            x.frames.push({ t, d: level.seconds, mic: level.mic, tab: level.tab });
            for (const piece of chunker.push(samples)) { x.queue.push(piece); pump(); }
          },
        });
        x.hasTab = !!opened?.hasTab;
        x.t0 = Date.now() / 1000;
        x.chunker = chunker;
      } catch (e) {
        cleanup();
        api.meetingRecordedEnd(noteId, session).catch(() => {});
        setState({ phase: 'error', error: e?.name === 'NotAllowedError' ? 'The microphone was not allowed - allow it in the browser and try again.' : (e.message || 'Could not open the microphone') });
        return;
      }
      set({ phase: 'loading', progress: { loaded: 0, total: MODELS[x.size].mb * 1e6 } });
      try {
        await x.engine.load(x.size, (p) => set({ progress: p }));
        x.ready = true;
        if (!x.stopped) set({ phase: 'listening' });
        pump();
      } catch (e) {
        // Whisper could not load here (no signal for the first download, too little memory):
        // the browser's own speech service carries on with the microphone, if there is one.
        x.cap.stop();
        if (support.browser && source === 'mic' && !x.stopped) {
          x.queue = [];
          const fb = newId();
          x.session = fb;
          try { await api.meetingRecordedStart(noteId, { id: fb, engine: 'browser', source, consent: true }); } catch { /* the words still show here */ }
          api.meetingRecordedEnd(noteId, session).catch(() => {});
          await startBrowser(fb);
          set({ phase: 'listening', engine: 'browser', note: `The on-device speech model could not load (${e.message}) - using the browser's speech service instead.` });
        } else {
          cleanup();
          setState({ phase: 'error', error: `The speech model could not load: ${e.message}` });
        }
      }
    })();
  }, [noteId, cleanup, keepAwake, pump, sendNow, startBrowser, onStarted]);

  const stop = useCallback(async () => {
    const x = r.current;
    if (!x.session || x.stopped) return;
    x.stopped = true;
    x.cap?.stop();
    x.speech?.stop();
    set({ phase: 'finishing' });
    const rest = x.chunker?.flush();
    if (rest && x.engine) x.queue.push(rest);
    // Stopped while the model was still downloading: what was said is read once it is here.
    if (x.engine && x.queue.length && !x.ready) {
      try { await (x.engine.loading || x.engine.load(x.size)); x.ready = true; } catch { /* nothing to read it with */ }
    }
    if (x.ready && x.queue.length) {
      x.finishing = true;
      await new Promise((resolve) => { x.doneFinishing = resolve; pump(); });
    }
    for (let i = 0; i < 4 && x.pending.length; i += 1) {
      await sendNow();
      if (x.pending.length) await new Promise((res) => setTimeout(res, 1500));
    }
    await api.meetingRecordedEnd(noteId, x.session).catch(() => {});
    cleanup();
    setState((s) => ({ ...s, phase: 'idle', unsent: x.pending.length }));
  }, [noteId, cleanup, pump, sendNow]);

  // Leaving the note mid-recording stops it cleanly.
  useEffect(() => () => { if (r.current.session && !r.current.stopped) { r.current.stopped = true; cleanup(); } }, [cleanup]);

  return { state, live, start, stop };
}

/** A recorded voice note to text, on this device. */
export async function transcribeRecording(blob, onProgress) {
  if (!whisperSupported()) throw new Error('This browser cannot transcribe recordings - use Chrome, Edge or Safari.');
  const { decodeToPcm } = await import('./capture');
  const pcm = await decodeToPcm(blob);
  const engine = getEngine();
  await engine.load(engine.model || pickModel(navigator, isPhoneLike()), onProgress);
  const res = await engine.transcribe(pcm);
  return res.chunks.length ? res.chunks.map((c) => c.text) : [res.text].filter(Boolean);
}

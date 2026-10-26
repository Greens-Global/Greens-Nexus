// Recording for a Pin: screen + mic through lib/screenRecorder.js (the
// Testing module's stepRecorder is NOT used - it hard-navigates on stop),
// speech-to-text through the browser's SpeechRecognition where it exists,
// and a contact sheet - a grid of frames grabbed every 3 s from the
// tab-capture stream (screenshot.js) while the recording runs.
import { startScreenRecording, stopScreenRecording, isScreenRecording, setRecordingMic, recordingMicOn } from '../../lib/screenRecorder';
import { grabFrame, thumbnail, tabStream } from './screenshot';

export const speechSupported = () => typeof window !== 'undefined' && !!(window.SpeechRecognition || window.webkitSpeechRecognition);

const mmss = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

/**
 * Continuous speech-to-text. onFinal(text) once per finished phrase,
 * onInterim(text) with the phrase in progress. Returns stop(). Chrome ends a
 * session after a pause, so it is restarted until stop() is called.
 */
export function startSpeech({ onFinal, onInterim, onError } = {}) {
  const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Ctor) return () => {};
  let wanted = true;
  let rec = null;
  const begin = () => {
    if (!wanted) return;
    rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || 'en-US';
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const t = (r[0]?.transcript || '').trim();
        if (!t) continue;
        if (r.isFinal) onFinal?.(t); else interim += `${t} `;
      }
      onInterim?.(interim.trim());
    };
    rec.onerror = (e) => { if (e?.error === 'not-allowed' || e?.error === 'service-not-allowed') { wanted = false; onError?.(e.error); } };
    rec.onend = () => { if (wanted) setTimeout(begin, 250); };
    try { rec.start(); } catch { /* already started */ }
  };
  begin();
  return () => { wanted = false; try { rec?.stop(); } catch { /* ignore */ } rec = null; };
}

/** Frames (small canvases) -> one PNG grid with a time stamp under each. */
export async function contactSheet(frames, cols = 4) {
  if (!frames.length) return null;
  const w = frames[0].canvas.width;
  const h = frames[0].canvas.height;
  const gap = 8;
  const label = 18;
  const rows = Math.ceil(frames.length / cols);
  const sheet = document.createElement('canvas');
  sheet.width = cols * w + (cols + 1) * gap;
  sheet.height = rows * (h + label) + (rows + 1) * gap;
  const ctx = sheet.getContext('2d');
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, sheet.width, sheet.height);
  frames.forEach((f, i) => {
    const x = gap + (i % cols) * (w + gap);
    const y = gap + Math.floor(i / cols) * (h + label + gap);
    ctx.drawImage(f.canvas, x, y);
    ctx.fillStyle = '#e2e8f0';
    ctx.font = '600 12px Inter, sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText(f.stamp, x + 2, y + h + 3);
  });
  return new Promise((resolve) => { if (!sheet.toBlob) { resolve(null); return; } sheet.toBlob(resolve, 'image/png'); });
}

export const isRecording = () => isScreenRecording();

/**
 * Start a recording. onTranscript(text) is called live; onDone({ video,
 * sheet, transcript, durationMs }) once when it ends (video null when it was
 * cancelled). Throws when screen capture is unsupported; a declined picker
 * resolves to false quietly.
 */
// `audio` (Oct 27): With Audio or Without Audio, picked when Record is
// clicked; setRecordAudio switches the mic - and the live transcript with it -
// while it records.
let _setAudio = null;
export const setRecordAudio = (on) => (_setAudio ? _setAudio(on) : Promise.resolve(false));
export const recordAudioOn = () => recordingMicOn();

export async function startRecording({ audio = true, onTranscript, onDone } = {}) {
  const t0 = Date.now();
  const finals = [];
  let interim = '';
  const emit = () => onTranscript?.([...finals, interim ? `[${mmss(Date.now() - t0)}] ${interim}` : ''].filter(Boolean).join('\n'));
  const listen = () => (speechSupported()
    ? startSpeech({ onFinal: (t) => { finals.push(`[${mmss(Date.now() - t0)}] ${t}`); interim = ''; emit(); }, onInterim: (t) => { interim = t; emit(); } })
    : () => {});
  let stopListening = audio ? listen() : () => {};
  const stopSpeech = () => stopListening();
  _setAudio = async (on) => {
    const mic = await setRecordingMic(on);
    stopListening();
    stopListening = mic ? listen() : () => {};
    return mic;
  };
  const frames = [];
  const sheetTimer = setInterval(async () => {
    try {
      const frame = await grabFrame();
      if (frame) frames.push({ canvas: thumbnail(frame, 320), stamp: mmss(Date.now() - t0) });
      if (frames.length >= 24) clearInterval(sheetTimer);   // six minutes of frames is plenty for a sheet
    } catch { /* a frame missed is not a problem */ }
  }, 3000);
  let ok = false;
  try {
    // The live tab stream, when there is one, so the person is not asked to
    // share twice; screenRecorder clones it and leaves ours running.
    ok = await startScreenRecording({ voice: audio, micSwitch: true, quiet: true, stream: tabStream() }, async (blob) => {
      clearInterval(sheetTimer);
      stopSpeech();
      _setAudio = null;
      const sheet = frames.length ? await contactSheet(frames) : null;
      onDone?.({ video: blob, sheet, transcript: finals.join('\n'), durationMs: Date.now() - t0 });
    });
  } catch (err) {
    clearInterval(sheetTimer);
    stopSpeech();
    _setAudio = null;
    if (err?.name === 'NotAllowedError') return false;
    throw err;
  }
  return !!ok;
}

export function stopRecording() { stopScreenRecording(); }

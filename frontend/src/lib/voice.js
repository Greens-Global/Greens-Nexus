// Voice in Nexus (Notes, Oct 29 2026; every module, Neil, Oct 30 2026).
//
//   useVoiceRecorder - records the microphone in the browser (MediaRecorder)
//                      and hands back a File; the caller uploads it to its
//                      own private bucket like any attachment.
//   useDictation     - speech to text by the BROWSER's own speech service
//                      (Web Speech API: Apple's on an iPhone, Google's in
//                      Chrome) - the same thing the phone keyboard's mic
//                      does. No Anthropic, nothing Nexus pays for; AI stays
//                      off (ai_switch.py). Browsers without it (Firefox)
//                      simply do not show a mic (canDictate).
//   mediaKind / checkMedia / withType - voice note and video limits and the
//                      iPhone .mov-without-a-type fix.
//
// The buttons on top: components/DictateButton.jsx (any text box) and
// components/VoiceNoteButton.jsx (record a clip). Notes' editor nodes stay in
// notes/noteMedia.jsx.
import { useCallback, useEffect, useRef, useState } from 'react';

export const MEDIA_MAX = { audio: 25 * 1024 * 1024, video: 50 * 1024 * 1024 };
export const VOICE_MAX_SEC = 15 * 60;   // a voice note stops by itself at 15 minutes

/** 'audio' | 'video' | '' from the type, or the extension (iOS can hand over a .mov with no type). */
export function mediaKind(file) {
  const t = (file?.type || '').toLowerCase();
  if (t.startsWith('audio/')) return 'audio';
  if (t.startsWith('video/')) return 'video';
  const ext = (file?.name || '').split('.').pop()?.toLowerCase();
  if (['mp4', 'mov', 'm4v', 'webm'].includes(ext)) return 'video';
  if (['m4a', 'mp3', 'aac', 'ogg', 'wav', 'weba', 'opus'].includes(ext)) return 'audio';
  return '';
}

const mb = (n) => Math.round(n / 1024 / 1024);

/** '' when the file can go in a note, else a message for the person. */
export function checkMedia(file) {
  const kind = mediaKind(file);
  if (!kind) return 'Only voice notes and videos can be added here.';
  if (!file.size) return 'That file is empty.';
  if (file.size > MEDIA_MAX[kind]) {
    return kind === 'video'
      ? `That video is ${mb(file.size)} MB. The limit is ${mb(MEDIA_MAX.video)} MB - record a shorter clip and try again.`
      : `That recording is ${mb(file.size)} MB. The limit is ${mb(MEDIA_MAX.audio)} MB.`;
  }
  return '';
}

const TYPE_BY_EXT = {
  mov: 'video/quicktime', mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm',
  m4a: 'audio/mp4', mp3: 'audio/mpeg', aac: 'audio/aac', ogg: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', weba: 'audio/webm',
};

/** The file with a real content type: iOS can hand over a .mov with none,
 *  and storage would then serve it as a download instead of a video. */
export function withType(file) {
  if (file.type) return file;
  const ext = (file.name || '').split('.').pop()?.toLowerCase();
  const type = TYPE_BY_EXT[ext];
  return type ? new File([file], file.name, { type, lastModified: file.lastModified }) : file;
}

// ── recording a voice note ────────────────────────────────────────────────
// MP4 first: it plays on every phone and computer (an older iPhone cannot
// play WebM); browsers that cannot record it fall through to WebM / Ogg.
const VOICE_TYPES = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg'];

export const canRecord = () => typeof window !== 'undefined' && !!window.MediaRecorder && !!navigator.mediaDevices?.getUserMedia;

function micError(e) {
  const n = e?.name || '';
  if (n === 'NotAllowedError' || n === 'SecurityError') return 'Nexus needs the microphone. Allow it for this site in your browser settings, then try again.';
  if (n === 'NotFoundError') return 'No microphone was found on this device.';
  return 'The microphone could not start. Close other apps using it and try again.';
}

/**
 * { recording, seconds, error, start(), stop(), cancel() }. stop() hands the
 * clip to onDone(file); cancel() throws it away.
 */
export function useVoiceRecorder(onDone) {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState('');
  const rec = useRef(null);
  const keep = useRef(true);
  const starting = useRef(false);   // waiting on the microphone permission
  const mounted = useRef(true);
  const doneRef = useRef(onDone);
  useEffect(() => { doneRef.current = onDone; }, [onDone]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const start = useCallback(async () => {
    // A second tap while the permission prompt is up must not open a second
    // microphone that nothing would ever close.
    if (rec.current || starting.current) return;
    starting.current = true;
    setError('');
    let stream = null;
    const release = () => { try { stream?.getTracks().forEach((t) => t.stop()); } catch { /* already stopped */ } };
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mounted.current) { release(); return; }   // the note closed while asking
      const mime = VOICE_TYPES.find((m) => window.MediaRecorder.isTypeSupported?.(m)) || '';
      const r = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks = [];
      keep.current = true;
      r.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
      r.onstop = () => {
        release();
        if (rec.current === r) rec.current = null;
        if (mounted.current) setRecording(false);
        if (!keep.current || !chunks.length) return;
        const type = (r.mimeType || mime || 'audio/webm').split(';')[0];
        const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
        doneRef.current?.(new File(chunks, `voice-note-${Date.now()}.${ext}`, { type }));
      };
      rec.current = r;
      r.start(1000);
      setSeconds(0);
      setRecording(true);
    } catch (e) {
      release();
      rec.current = null;
      if (mounted.current) setError(micError(e));
    } finally {
      starting.current = false;
    }
  }, []);

  const stop = useCallback(() => { try { rec.current?.stop(); } catch { rec.current = null; setRecording(false); } }, []);
  const cancel = useCallback(() => { keep.current = false; stop(); }, [stop]);

  useEffect(() => {
    if (!recording) return undefined;
    const t = setInterval(() => setSeconds((s) => {
      if (s + 1 >= VOICE_MAX_SEC) stop();
      return s + 1;
    }), 1000);
    return () => clearInterval(t);
  }, [recording, stop]);

  // Leaving the note mid-recording keeps nothing and frees the microphone
  // (the recorder's onstop stops the tracks).
  useEffect(() => () => {
    keep.current = false;
    const r = rec.current;
    try { r?.stop(); } catch { try { r?.stream?.getTracks().forEach((t) => t.stop()); } catch { /* gone */ } }
  }, []);

  return { recording, seconds, error, setError, start, stop, cancel };
}

// ── dictation ─────────────────────────────────────────────────────────────
const Recognition = () => (typeof window === 'undefined' ? null : window.SpeechRecognition || window.webkitSpeechRecognition || null);
export const canDictate = () => !!Recognition();

function speechError(code) {
  if (code === 'not-allowed' || code === 'service-not-allowed') return 'Nexus needs the microphone to type what you say. Allow it for this site in your browser settings.';
  if (code === 'network') return 'Dictation needs a connection. Check your signal and try again.';
  if (code === 'audio-capture') return 'No microphone was found on this device.';
  return '';   // no-speech, aborted: just stop quietly
}

/**
 * { listening, interim, error, start(), stop() }. Each finished phrase goes
 * to onText(text) as it is recognized, so the words land while you talk.
 */
export function useDictation(onText) {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState('');
  const rec = useRef(null);
  const typed = useRef(new Set());   // final results already typed, by index
  const textRef = useRef(onText);
  useEffect(() => { textRef.current = onText; }, [onText]);

  const start = useCallback(() => {
    const R = Recognition();
    if (!R || rec.current) return;
    setError('');
    const r = new R();
    r.continuous = true;
    r.interimResults = true;
    r.lang = navigator.language || 'en-US';
    typed.current = new Set();
    // Chrome on Android hands back earlier final results again (resultIndex
    // 0 each time); each one is typed once.
    r.onresult = (e) => {
      let live = '';
      for (let i = e.resultIndex; i < e.results.length; i += 1) {
        const res = e.results[i];
        const said = res[0]?.transcript || '';
        if (!res.isFinal) { live += said; continue; }
        if (typed.current.has(i)) continue;
        typed.current.add(i);
        if (said.trim()) textRef.current?.(said.trim());
      }
      setInterim(live.trim());
    };
    r.onerror = (e) => { const m = speechError(e.error); if (m) setError(m); };
    r.onend = () => { rec.current = null; setListening(false); setInterim(''); };
    rec.current = r;
    try { r.start(); setListening(true); } catch { rec.current = null; setListening(false); }
  }, []);

  const stop = useCallback(() => { try { rec.current?.stop(); } catch { rec.current = null; setListening(false); } }, []);

  useEffect(() => () => { try { rec.current?.abort(); } catch { /* gone */ } }, []);

  return { listening, interim, error, setError, start, stop };
}

// ── spoken words as text ──────────────────────────────────────────────────
/** `said` as it should follow `before`: a space after a word, capitalized at the start or after a sentence. */
export function spokenAfter(before, said) {
  const text = String(said || '').trim();
  if (!text) return '';
  const start = !String(before || '').trim() || /[.!?\n]\s*$/.test(before);
  const words = start ? text.charAt(0).toUpperCase() + text.slice(1) : text;
  return `${before && !/\s$/.test(before) ? ' ' : ''}${words}`;
}

// ── typing into a plain box ───────────────────────────────────────────────
const valueSetter = (el) => Object.getOwnPropertyDescriptor(
  el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set;

/** Types `text` at the cursor of an input or textarea, spaced and capitalized like a sentence. */
export function insertAtCursor(el, text) {
  if (!el || !text) return;
  const value = el.value || '';
  const start = el.selectionStart ?? value.length;
  const end = el.selectionEnd ?? start;
  const before = value.slice(0, start);
  const after = value.slice(end);
  const sentenceStart = !before.trim() || /[.!?\n]\s*$/.test(before);
  let words = sentenceStart ? text.charAt(0).toUpperCase() + text.slice(1) : text;
  if (before && !/\s$/.test(before)) words = ` ${words}`;
  if (after && !/^\s/.test(after)) words = `${words} `;
  const max = el.maxLength > 0 ? el.maxLength : Infinity;
  const next = (before + words + after).slice(0, max);
  valueSetter(el).call(el, next);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  const caret = Math.min(next.length, before.length + words.length);
  try { el.setSelectionRange(caret, caret); } catch { /* an input type without a selection */ }
}


export const clock = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

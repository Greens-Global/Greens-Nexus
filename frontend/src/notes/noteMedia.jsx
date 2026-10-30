// Voice notes, videos and dictation in Notes (Neil, Oct 29 2026).
//
//   Voice Note - records the microphone in the browser (MediaRecorder) and
//                keeps the clip in the note as a player.
//   Video      - a clip from the phone's camera or library (or any file on a
//                computer, pasted or dropped in) kept in the note as a player.
//   Dictate    - speech to text typed at the cursor, by the BROWSER's own
//                speech service (Web Speech API: Apple's on an iPhone,
//                Google's in Chrome). No Anthropic, nothing Nexus pays for -
//                AI stays off (ai_switch.py). Browsers without it (Firefox)
//                simply do not show the button.
//
// Clips go browser -> the private `task-files` bucket under notes/ through the
// Tasks module's uploader (storeTaskFile), so they are opened only through the
// signed-in viewer like every other evidence file. The note keeps the
// canonical URL; the server keeps only <audio>/<video> whose src is our
// storage (routers/notes.py _NoteSanitizer).
import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { storeTaskFile } from '../tasks/lib';
import { isOwnImageUrl } from '../lib/storageView';

// Transaction meta: a change the person made that came with no key or input
// event (Remove on a player). NoteEditor saves on it.
export const EDITED = 'noteEdited';

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

/** Upload one clip; resolves to the URL the note shows. Throws a readable Error. */
export async function uploadNoteMedia(file, onProgress) {
  const bad = checkMedia(file);
  if (bad) throw new Error(bad);
  const url = await storeTaskFile(withType(file), onProgress, 'notes', MEDIA_MAX[mediaKind(file)]);
  if (!url) throw new Error('Could not save that clip. Try again.');
  return url;
}

/** Files on a paste or drop that are voice notes or videos. */
export function mediaFiles(list) {
  return [...(list || [])].filter((f) => mediaKind(f));
}

// ── the two nodes ─────────────────────────────────────────────────────────
// While co-typing, a clip arrives from the shared document, not through the
// server's sanitizer: play it only from our own storage (lib/storageView).
const live = (editor) => editor.extensionManager.extensions.some((e) => e.name === 'collaboration');
const playable = (editor, src) => !live(editor) || (isOwnImageUrl(src) && !/^data:/i.test(src));

function MediaView({ node, editor, getPos }) {
  const { src: raw } = node.attrs;
  const src = playable(editor, raw) ? raw : '';
  const video = node.type.name === 'noteVideo';
  const remove = () => {
    const pos = getPos();
    if (typeof pos !== 'number') return;
    editor.chain().setMeta(EDITED, true).deleteRange({ from: pos, to: pos + node.nodeSize }).run();
  };
  return (
    <NodeViewWrapper className={`nt-media ${video ? 'is-video' : 'is-audio'}`} contentEditable={false} data-drag-handle="">
      {video
        ? <video src={src} controls playsInline preload="metadata" />
        : <audio src={src} controls preload="metadata" />}
      {editor.isEditable && (
        <button type="button" className="nt-media-x" aria-label={video ? 'Remove Video' : 'Remove Voice Note'}
          title={video ? 'Remove Video' : 'Remove Voice Note'} onClick={remove}>
          <X size={14} aria-hidden="true" />
        </button>
      )}
    </NodeViewWrapper>
  );
}

const mediaNode = (name, tag, extra) => Node.create({
  name,
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes() { return { src: { default: '' } }; },
  parseHTML() { return [{ tag: `${tag}[src]`, getAttrs: (el) => ({ src: el.getAttribute('src') || '' }) }]; },
  renderHTML({ HTMLAttributes }) { return [tag, mergeAttributes(HTMLAttributes, { controls: '', preload: 'metadata', ...extra })]; },
  addNodeView() { return ReactNodeViewRenderer(MediaView); },
});

export const NoteAudio = mediaNode('noteAudio', 'audio', {});
export const NoteVideo = mediaNode('noteVideo', 'video', { playsinline: '' });

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

export const clock = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

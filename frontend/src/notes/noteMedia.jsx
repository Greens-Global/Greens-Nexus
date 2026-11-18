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
// canonical URL; the server keeps only <audio>/<video>/<img> whose src is our
// storage (routers/notes.py _NoteSanitizer).
//
// Photos, and a small preview (Neil, 11/10/2026: "on mobile ... I don't see
// an option to take a picture. Picture or video should not occupy the whole
// note - a small preview, and if clicked on it can be larger"). A photo is
// its own node (noteImage, an <img>); photos and videos show as tiles that
// line up in a row, and a tap opens them full size in MediaViewer, which
// steps through every photo and video in the note. A voice note stays a slim
// player. Phone photos are scaled down before upload (shrinkPhoto).
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import { X, Play, ChevronLeft, ChevronRight, Trash2, AudioLines } from 'lucide-react';
import { storeTaskFile } from '../tasks/lib';
import { isOwnImageUrl } from '../lib/storageView';
import { MEDIA_MAX, checkMedia, mediaKind, withType } from '../lib/voice';
import { transcribeOn } from './meetings/access';

// The recorder, dictation and the clip limits live in lib/voice.js so every
// module can use them (Neil, Oct 30 2026); re-exported for Notes' callers.
export {
  MEDIA_MAX, VOICE_MAX_SEC, mediaKind, checkMedia, withType, canRecord, useVoiceRecorder, canDictate, useDictation, clock,
} from '../lib/voice';

// Transaction meta: a change the person made that came with no key or input
// event (Remove on a player). NoteEditor saves on it.
export const EDITED = 'noteEdited';

// Photos: what a note takes, and how big one may be before it is scaled.
export const PHOTO_MAX = 25 * 1024 * 1024;
const PHOTO_EDGE = 2400;      // longest side kept, in pixels
const PHOTO_TYPES = /^image\/(jpeg|png|gif|webp|heic|heif)$/i;

/** 'image' | 'audio' | 'video' | '' - what a note can hold. */
export function noteMediaKind(file) {
  const t = (file?.type || '').toLowerCase();
  if (t.startsWith('image/')) return 'image';
  const ext = (file?.name || '').split('.').pop()?.toLowerCase();
  if (!t && ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif'].includes(ext)) return 'image';
  return mediaKind(file);
}

/** A readable reason a file cannot go in a note, or ''. */
export function checkNoteMedia(file) {
  if (noteMediaKind(file) !== 'image') return checkMedia(file);
  if (!file.size) return 'That file is empty.';
  if (file.type && !PHOTO_TYPES.test(file.type)) return 'That kind of picture cannot be added. Use a JPEG, PNG, GIF or WebP.';
  if (file.size > PHOTO_MAX) return `That picture is ${Math.round(file.size / 1024 / 1024)} MB. The limit is ${PHOTO_MAX / 1024 / 1024} MB.`;
  return '';
}

/**
 * A phone photo is 3-12 MB at 4000+ pixels; a note needs far less. Scale
 * the longest side to PHOTO_EDGE as a JPEG. A GIF (it may move), a small
 * picture, or anything the browser cannot draw goes up as it is.
 */
export async function shrinkPhoto(file) {
  if (/gif/i.test(file.type || '') || file.size < 600 * 1024) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, PHOTO_EDGE / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
    bmp.close?.();
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.85));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], (file.name || 'photo').replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch {
    return file;
  }
}

/** Upload one photo, voice note or video; resolves to the URL the note shows. Throws a readable Error. */
export async function uploadNoteMedia(file, onProgress) {
  const bad = checkNoteMedia(file);
  if (bad) throw new Error(bad);
  const kind = noteMediaKind(file);
  const ready = kind === 'image' ? await shrinkPhoto(file) : withType(file);
  const url = await storeTaskFile(ready, onProgress, 'notes', kind === 'image' ? PHOTO_MAX : MEDIA_MAX[kind]);
  if (!url) throw new Error(`Could not save that ${kind === 'image' ? 'picture' : 'clip'}. Try again.`);
  return url;
}

/** Files on a paste or drop that are photos, voice notes or videos. */
export function mediaFiles(list) {
  return [...(list || [])].filter((f) => noteMediaKind(f));
}

// ── the two nodes ─────────────────────────────────────────────────────────
// While co-typing, a clip arrives from the shared document, not through the
// server's sanitizer: play it only from our own storage (lib/storageView).
const live = (editor) => editor.extensionManager.extensions.some((e) => e.name === 'collaboration');
const playable = (editor, src) => !live(editor) || (isOwnImageUrl(src) && !/^data:/i.test(src));

// Every photo and video in the note, in order - what the viewer steps through.
function viewables(editor) {
  const out = [];
  editor.state.doc.descendants((n, pos) => {
    if (n.type.name === 'noteImage' || n.type.name === 'noteVideo') out.push({ pos, kind: n.type.name === 'noteImage' ? 'image' : 'video', src: n.attrs.src, alt: n.attrs.alt || '' });
  });
  return out;
}

/**
 * Full size: one photo or video at a time over a dark backdrop, Previous /
 * Next (and the arrow keys, and a swipe on a phone) through the note's
 * photos and videos, Remove for someone who can edit. Escape or Close
 * leaves. Rendered at the top of the page so no card or sheet clips it.
 */
export function MediaViewer({ items, start = 0, canEdit = false, onRemove, onClose }) {
  const [i, setI] = useState(Math.min(start, Math.max(0, items.length - 1)));
  const [touchX, setTouchX] = useState(null);
  const item = items[i];
  const go = (d) => setI((x) => (items.length ? (x + d + items.length) % items.length : 0));
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
      else if (e.key === 'ArrowRight') go(1);
      else if (e.key === 'ArrowLeft') go(-1);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });
  if (!item) return null;
  const many = items.length > 1;
  return createPortal(
    <div className="nt-viewer" role="dialog" aria-modal="true" aria-label={item.kind === 'image' ? 'Photo' : 'Video'}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onTouchStart={(e) => setTouchX(e.touches[0]?.clientX ?? null)}
      onTouchEnd={(e) => { const x = e.changedTouches[0]?.clientX; if (many && touchX != null && x != null && Math.abs(x - touchX) > 60) go(x < touchX ? 1 : -1); setTouchX(null); }}>
      <div className="nt-viewer-bar">
        <span className="nt-viewer-count">{many ? `${i + 1} of ${items.length}` : item.kind === 'image' ? 'Photo' : 'Video'}</span>
        {canEdit && onRemove && (
          <button type="button" className="nt-viewer-btn" onClick={() => { onRemove(item); onClose(); }}>
            <Trash2 size={16} aria-hidden="true" /> Remove
          </button>
        )}
        <button type="button" className="nt-viewer-btn is-icon" aria-label="Close" onClick={onClose}><X size={20} aria-hidden="true" /></button>
      </div>
      <div className="nt-viewer-stage" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        {item.kind === 'image'
          ? <img key={item.src} src={item.src} alt={item.alt || 'Photo'} />
          : <video key={item.src} src={item.src} controls autoPlay playsInline />}
      </div>
      {many && (<>
        <button type="button" className="nt-viewer-nav is-prev" aria-label="Previous" onClick={() => go(-1)}><ChevronLeft size={26} aria-hidden="true" /></button>
        <button type="button" className="nt-viewer-nav is-next" aria-label="Next" onClick={() => go(1)}><ChevronRight size={26} aria-hidden="true" /></button>
      </>)}
    </div>,
    document.body,
  );
}

function MediaView({ node, editor, getPos }) {
  const { src: raw, alt } = node.attrs;
  const src = playable(editor, raw) ? raw : '';
  const kind = node.type.name === 'noteImage' ? 'image' : node.type.name === 'noteVideo' ? 'video' : 'audio';
  const [viewing, setViewing] = useState(null);   // { items, start } while open
  const what = kind === 'image' ? 'Photo' : kind === 'video' ? 'Video' : 'Voice Note';
  // Transcribe (Meeting Notes Phase 3, Neil 11/12/2026, testers first): the
  // voice note turned into text on this device, put under it as a folded
  // Transcript - the recording is read here and never sent anywhere.
  const [tr, setTr] = useState(null);   // { working, text } | { error }
  const transcribe = async () => {
    setTr({ working: true, text: 'Turning it into text on this device' });
    try {
      const [{ api }, { transcribeRecording }] = await Promise.all([import('../api'), import('./meetings/capture/useTranscriber')]);
      const blob = await api.viewerBlob(raw);
      const lines = await transcribeRecording(blob, (p) => setTr({ working: true,
        text: `Getting the speech model ready - ${Math.round((p.loaded || 0) / 1e6)} of ${Math.round((p.total || 0) / 1e6)} MB, once on this device` }));
      if (!lines.length) { setTr({ error: 'No words were heard in this voice note.' }); return; }
      const pos = getPos();
      if (typeof pos !== 'number' || editor.isDestroyed) return;
      const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      editor.chain().setMeta(EDITED, true).insertContentAt(pos + node.nodeSize,
        `<div data-type="toggle" data-summary="Transcript" data-open="true">${lines.map((l) => `<p>${esc(l)}</p>`).join('')}</div>`).run();
      setTr(null);
    } catch (e) {
      setTr({ error: `Could not transcribe it: ${e?.message || 'try again'}` });
    }
  };
  const removeAt = (pos, size) => editor.chain().setMeta(EDITED, true).deleteRange({ from: pos, to: pos + size }).run();
  const remove = () => {
    const pos = getPos();
    if (typeof pos === 'number') removeAt(pos, node.nodeSize);
  };
  const open = () => {
    const items = viewables(editor);
    const here = getPos();
    setViewing({ items, start: Math.max(0, items.findIndex((it) => it.pos === here)) });
  };
  return (
    <NodeViewWrapper className={`nt-media is-${kind}${kind === 'audio' ? '' : ' is-tile'}`} contentEditable={false} data-drag-handle="">
      {kind === 'audio' && <audio src={src} controls preload="metadata" />}
      {kind === 'audio' && src && editor.isEditable && transcribeOn() && (
        <div className="nt-media-tr">
          <button type="button" className="nt-text-btn" onClick={transcribe} disabled={!!tr?.working}
            title="Turn this voice note into text, on this device">
            <AudioLines size={13} aria-hidden="true" /> {tr?.working ? 'Transcribing…' : 'Transcribe'}
          </button>
          {tr?.working && <span role="status">{tr.text}</span>}
          {tr?.error && <span role="alert" className="is-bad">{tr.error}</span>}
        </div>
      )}
      {kind !== 'audio' && (
        <button type="button" className="nt-tile" onClick={open} aria-label={`Open ${what}`} title={`Open ${what}`} disabled={!src}>
          {kind === 'image'
            ? <img src={src} alt={alt || 'Photo'} loading="lazy" decoding="async" draggable={false} />
            // #t=0.1: iPhone Safari paints the first frame only when asked for a time.
            : <video src={src ? `${src}#t=0.1` : ''} muted playsInline preload="metadata" tabIndex={-1} />}
          {kind === 'video' && <span className="nt-tile-play" aria-hidden="true"><Play size={18} fill="currentColor" /></span>}
        </button>
      )}
      {editor.isEditable && (
        <button type="button" className="nt-media-x" aria-label={`Remove ${what}`} title={`Remove ${what}`} onClick={remove}>
          <X size={14} aria-hidden="true" />
        </button>
      )}
      {viewing && (
        <MediaViewer items={viewing.items} start={viewing.start} canEdit={editor.isEditable} onClose={() => setViewing(null)}
          onRemove={(it) => { const n = editor.state.doc.nodeAt(it.pos); if (n) removeAt(it.pos, n.nodeSize); }} />
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
  // strictSrc (co-typing, and HTML shown outside the editor): only a clip in
  // our own storage keeps its src - a shared document never went through the
  // server's sanitizer (noteExtensions.js).
  addOptions() { return { strictSrc: false }; },
  addAttributes() {
    return {
      src: {
        default: '',
        renderHTML: (a) => {
          const src = typeof a.src === 'string' ? a.src : '';
          return { src: !this.options.strictSrc || (isOwnImageUrl(src) && !/^data:/i.test(src)) ? src : '' };
        },
      },
    };
  },
  parseHTML() { return [{ tag: `${tag}[src]`, getAttrs: (el) => ({ src: el.getAttribute('src') || '' }) }]; },
  renderHTML({ HTMLAttributes }) { return [tag, mergeAttributes(HTMLAttributes, { controls: '', preload: 'metadata', ...extra })]; },
  addNodeView() { return ReactNodeViewRenderer(MediaView); },
});

export const NoteAudio = mediaNode('noteAudio', 'audio', {});
export const NoteVideo = mediaNode('noteVideo', 'video', { playsinline: '' });

// A photo: <img src alt> in the note's HTML, shown as a tile (MediaView).
export const NoteImage = Node.create({
  name: 'noteImage',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,
  addOptions() { return { strictSrc: false }; },
  addAttributes() {
    return {
      src: {
        default: '',
        renderHTML: (a) => {
          const src = typeof a.src === 'string' ? a.src : '';
          return { src: !this.options.strictSrc || (isOwnImageUrl(src) && !/^data:/i.test(src)) ? src : '' };
        },
      },
      alt: { default: '', renderHTML: (a) => (a.alt ? { alt: String(a.alt).slice(0, 200) } : {}) },
    };
  },
  // A board's picture is inside its own card (BoardEmbed), never a photo of its
  // own; under strictSrc a picture from anywhere but our storage is dropped.
  parseHTML() {
    const strict = this.options.strictSrc;
    return [{
      tag: 'img[src]',
      getAttrs: (el) => {
        const src = el.getAttribute('src') || '';
        if (el.closest('a[data-type="boardEmbed"]')) return false;
        if (strict && (!isOwnImageUrl(src) || /^data:/i.test(src))) return false;
        return { src, alt: el.getAttribute('alt') || '' };
      },
    }];
  },
  renderHTML({ HTMLAttributes }) { return ['img', mergeAttributes(HTMLAttributes)]; },
  addNodeView() { return ReactNodeViewRenderer(MediaView); },
});

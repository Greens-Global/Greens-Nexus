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
import { X } from 'lucide-react';
import { storeTaskFile } from '../tasks/lib';
import { isOwnImageUrl } from '../lib/storageView';
import { MEDIA_MAX, checkMedia, mediaKind, withType } from '../lib/voice';

// The recorder, dictation and the clip limits live in lib/voice.js so every
// module can use them (Neil, Oct 30 2026); re-exported for Notes' callers.
export {
  MEDIA_MAX, VOICE_MAX_SEC, mediaKind, checkMedia, withType, canRecord, useVoiceRecorder, canDictate, useDictation, clock,
} from '../lib/voice';

// Transaction meta: a change the person made that came with no key or input
// event (Remove on a player). NoteEditor saves on it.
export const EDITED = 'noteEdited';

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

// TicketEvidence - split out of TicketsView.jsx (Oct 2026); the code below
// moved verbatim, see TicketsView.jsx for the module overview.
import { useRef, useState } from 'react';
import { Paperclip, X, Image as ImageIcon, Video, Upload as UploadIcon, Mic, CircleDot } from 'lucide-react';
import { startScreenRecording, primeReturnCue } from '../lib/screenRecorder';
import { NX, btn } from '../tasks/theme';
import { dialog as appDialog } from '../ui/dialog';
import { Spinner } from '../components/AsyncState';
import AnchoredMenu from '../components/AnchoredMenu';

// Shared Record + Upload control - a screen recording (optionally with mic
// narration) or a plain file picker. `onFile(file)` gets a plain File each
// time (recordings become File objects too); the caller decides whether to
// queue it locally (pre-creation) or upload it immediately (post-creation).
// `compact` (the Create a Ticket form, Oct 1): a slimmer pair that sits in a
// row directly under the description editor instead of a featured red button
// at the foot of the form - same actions, same recording flow.
// `quiet` (the Create a Ticket form, Oct 28 2026 - Neil: calm intake): plain
// text buttons in the bar under the description, the record dot the only red.
function RecordUploadButtons({ onFile, disabled, showRecord = true, onRecordingChange, compact = false, quiet = false }) {
  const fileRef = useRef(null);
  const [menu, setMenu] = useState(false);
  const [recording, setRecording] = useState(false);
  const setRec = (v) => { setRecording(v); onRecordingChange?.(v); };
  // The submenu used to close itself via a position:fixed full-viewport
  // backdrop div. That div sits above everything else in the modal
  // (including the scrollable body), so any wheel/touch scroll while the
  // menu was open hit the backdrop instead of the scroll container and did
  // nothing - the modal looked frozen until the menu was dismissed.
  // AnchoredMenu closes on an outside tap without ever intercepting scroll,
  // and renders above the modal body so it is never clipped by it.
  const recordBtnRef = useRef(null);

  const record = async (voice) => {
    setMenu(false);
    try {
      const started = await startScreenRecording({ voice }, (blob) => {
        // File FIRST, recording-state second: onRecordingChange(false) may
        // trigger the navigate-back-and-resume flow (recordingDraft.js), and
        // the clip must already be in the draft when the form reopens.
        // null = cancelled or genuinely empty; both end quietly. The old
        // "came out empty - try again" alert fired on every Cancel too, which
        // read as a failure when the user had simply changed their mind.
        if (blob) onFile(new File([blob], `ticket-recording-${Date.now()}.webm`, { type: 'video/webm' }));
        setRec(false);
      });
      if (started) setRec(true);
    } catch (e) {
      setRec(false);
      // NotAllowedError covers both "dismissed the picker" and "denied
      // permission" in Chrome - quiet in both cases, same as Testing's
      // startBugRecording. Anything else (unsupported browser, NotFoundError,
      // etc.) is worth telling the requester about.
      if (e?.name !== 'NotAllowedError' && e?.name !== 'AbortError') {
        appDialog.alert(e?.message || 'Could not start screen recording.');
      }
    }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      {showRecord && (
        <div style={{ position: 'relative' }}>
          {/* Record is the featured action here - a screen recording tells us
              more about a broken workflow than a paragraph of description
              ever will, so it's styled to be noticed, not just discoverable. */}
          {/* Asks for notification permission HERE - a dedicated click, well
              before the getDisplayMedia screen/window/tab picker shows up -
              rather than right before that picker, where the two browser
              prompts landing back-to-back meant the permission one (easy to
              mistake for spam next to the picker everyone expects) was very
              likely getting reflexively dismissed. That's the "come back"
              cue this button promises. */}
          <button ref={recordBtnRef} type="button" disabled={disabled || recording} onClick={() => { primeReturnCue(); setMenu((m) => !m); }}
            style={quiet ? {
              ...btn('ghost'), fontSize: 12.5, fontWeight: 600, color: NX.ink, padding: '5px 8px',
              display: 'inline-flex', alignItems: 'center', gap: 6,
            } : compact ? {
              ...btn('outline'), fontSize: 12.5, fontWeight: 600, color: NX.red,
              borderColor: 'rgba(220,38,38,0.45)', display: 'inline-flex', alignItems: 'center', gap: 6,
            } : {
              ...btn('primary'), background: NX.red, borderColor: NX.red,
              padding: '11px 18px', fontSize: 14, fontWeight: 700, borderRadius: 10,
              boxShadow: recording ? 'none' : '0 2px 8px rgba(220,38,38,0.28)',
              display: 'inline-flex', alignItems: 'center', gap: 8,
            }}>
            {recording ? <Spinner size="inline" /> : <CircleDot size={compact || quiet ? 14 : 17} style={quiet ? { color: NX.red } : undefined} />}
            {recording ? 'Recording…' : 'Record Screen'}
          </button>
          <AnchoredMenu anchorRef={recordBtnRef} open={menu} onClose={() => setMenu(false)}
            style={{ background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 10, boxShadow: '0 10px 30px rgba(0,0,0,.18)', padding: 4, width: 210 }}>
            <button type="button" role="menuitem" onClick={() => record(false)} style={{ ...btn('ghost'), width: '100%', justifyContent: 'flex-start', gap: 8, fontSize: 12 }}>
              <Video size={14} /> Screen Recording
            </button>
            <button type="button" role="menuitem" onClick={() => record(true)} style={{ ...btn('ghost'), width: '100%', justifyContent: 'flex-start', gap: 8, fontSize: 12 }}>
              <Mic size={14} /> Screen + Narration
            </button>
          </AnchoredMenu>
        </div>
      )}
      <button type="button" disabled={disabled} onClick={() => fileRef.current?.click()}
        style={quiet
          ? { ...btn('ghost'), fontSize: 12.5, fontWeight: 600, color: NX.ink, padding: '5px 8px', display: 'inline-flex', alignItems: 'center', gap: 6 }
          : { ...btn('outline'), fontSize: compact ? 12.5 : 12, fontWeight: compact ? 600 : undefined, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        {quiet ? <Paperclip size={14} /> : <UploadIcon size={13} />} {quiet ? 'Attach File' : 'Upload Attachment'}
      </button>
      <input ref={fileRef} type="file" multiple style={{ display: 'none' }}
        onChange={(e) => { const files = Array.from(e.target.files || []); e.target.value = ''; files.forEach(onFile); }} />
    </div>
  );
}

// Pending-attachment chip for the create-ticket form (local File, not yet uploaded).
function PendingFileChip({ file, onRemove }) {
  const isVideo = file.type.startsWith('video/');
  const isImage = file.type.startsWith('image/');
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: `1px solid ${NX.border}`, borderRadius: 999, padding: '3px 9px 3px 8px', fontSize: 12 }}>
      {isVideo ? <Video size={13} style={{ color: NX.dim }} /> : isImage ? <ImageIcon size={13} style={{ color: NX.dim }} /> : <Paperclip size={13} style={{ color: NX.dim }} />}
      <span style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.name}</span>
      <button type="button" onClick={onRemove} title="Remove" style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: NX.faint, padding: 0, display: 'flex' }}><X size={12} /></button>
    </span>
  );
}

export { RecordUploadButtons, PendingFileChip };

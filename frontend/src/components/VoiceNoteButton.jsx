// Record a voice note (Neil, Oct 30 2026): one tap starts the microphone, a
// red dot and the clock show it is recording, Stop hands the clip to the
// caller as a File (onFile) - the caller uploads it with its own attachments
// to its own private bucket. Cancel throws it away. 15 minutes at most
// (lib/voice.js). Browsers that cannot record get no button.
import { AudioLines, Square, X } from 'lucide-react';
import { canRecord, clock, useVoiceRecorder } from '../lib/voice';

export default function VoiceNoteButton({ onFile, disabled, compact = false, className = '', style }) {
  const v = useVoiceRecorder(onFile);
  if (!canRecord()) return null;
  if (v.recording) {
    return (
      <span className="nx-rec" role="status" aria-live="polite">
        <span className="nx-rec-dot" aria-hidden="true" />
        <span className="nx-rec-time">Recording {clock(v.seconds)}</span>
        <button type="button" className="nx-rec-stop" onClick={v.stop}><Square size={12} aria-hidden="true" /> Stop</button>
        <button type="button" className="nx-rec-x" aria-label="Cancel the Voice Note" title="Cancel" onClick={v.cancel}><X size={14} aria-hidden="true" /></button>
      </span>
    );
  }
  return (
    <>
      <button type="button" className={`nx-voice ${compact ? 'is-compact' : ''} ${className}`.trim()} style={style} disabled={disabled}
        aria-label="Record a Voice Note" title="Record a Voice Note" onClick={v.start}>
        <AudioLines size={16} aria-hidden="true" />{!compact && <span>Voice Note</span>}
      </button>
      {v.error && <span className="nx-rec-error" role="alert">{v.error}</span>}
    </>
  );
}

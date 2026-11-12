// Meeting Notes, Phase 3 (Neil, 11/12/2026): Start Transcribing.
//
// Asks first, every time (Neil: "Yes" to consent): a centered question that
// says what happens to the audio (nothing leaves the device; only the words
// are kept, in this note) and will not start until the person ticks that
// everyone in the meeting agreed to be transcribed. On a computer it also
// offers the call in a browser tab (Zoom, Google Meet, Teams on the web) as
// well as the microphone. Then the live line: Getting Ready (the one-time
// download, with its progress), Transcribing and the clock (the live accent),
// Stop, Finishing.
import { useEffect, useId, useState } from 'react';
import { Mic, Square, MonitorSpeaker, Loader2 } from 'lucide-react';
import { Modal } from '../../tasks/components';
import ProgressTrack from '../../ui/ProgressTrack';
import { MODELS } from './capture/engine';
import { transcriberSupport, useTranscriber } from './capture/useTranscriber';

const clock = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const mb = (b) => Math.round((b || 0) / 1e6);

export function ConsentDialog({ onClose, onStart, support }) {
  const [agreed, setAgreed] = useState(false);
  const [source, setSource] = useState('mic');
  const id = useId();
  const engineLine = support.whisper
    ? 'Speech is turned into text on this device. The audio is never saved or sent anywhere - only the words are kept, in this note, for the people who can open it.'
    : "This browser turns speech into text with its own speech service, which sends the audio to Google or Apple to recognize it. Only the words are kept, in this note, for the people who can open it.";
  return (
    // backToClose off: on a phone this question sits over the note's own sheet,
    // and taking its Back entry off again would close the note under it.
    <Modal title="Start Transcribing" onClose={onClose} placement="center" width="480px" minHeight="auto" backToClose={false}
      footer={(
        <div className="nt-consent-foot">
          <button type="button" className="nt-text-btn" onClick={onClose}>Cancel</button>
          {/* start() runs inside this tap: an iPhone only starts audio from one. */}
          <button type="button" className="nt-text-btn is-primary" disabled={!agreed} onClick={() => onStart(source)}>
            <Mic size={14} aria-hidden="true" /> Start Transcribing
          </button>
        </div>
      )}>
      <div className="nt-consent">
        <p>{engineLine}</p>
        {support.tab && (
          <fieldset className="nt-consent-src">
            <legend>What to Listen To</legend>
            <label><input type="radio" name={`${id}-src`} checked={source === 'mic'} onChange={() => setSource('mic')} /> This device's microphone <span>a meeting in the room</span></label>
            <label><input type="radio" name={`${id}-src`} checked={source === 'mic+tab'} onChange={() => setSource('mic+tab')} disabled={!support.whisper} /> The microphone and a call in this browser <span>Zoom, Google Meet or Teams in a tab - the browser asks which tab to share; turn on its audio</span></label>
          </fieldset>
        )}
        <label className="nt-consent-check">
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
          <span>Everyone in this meeting has agreed to be transcribed.</span>
        </label>
        <p className="nt-consent-law">Some states require everyone's consent before a conversation is recorded. Say that you are transcribing before you start.</p>
      </div>
    </Modal>
  );
}

export default function Recorder({ noteId, onStarted, onLive, onRecording }) {
  const [asking, setAsking] = useState(false);
  const support = transcriberSupport();
  const t = useTranscriber(noteId, { onStarted });
  const { phase } = t.state;
  const active = ['starting', 'loading', 'listening', 'finishing'].includes(phase);

  useEffect(() => { onLive?.(t.live); }, [t.live]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { onRecording?.(active, t.state.startedAt || 0, phase); }, [active, phase]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!support.capture && !support.browser) return null;
  const p = t.state.progress;
  const loadingModel = phase === 'loading' && p;
  return (
    <div className="nt-trn-line">
      {!active && (
        <button type="button" className="nt-text-btn" onClick={() => setAsking(true)} title="Turn what is said into text, on this device">
          <Mic size={14} aria-hidden="true" /> Start Transcribing
        </button>
      )}
      {active && (
        <span className="nt-trn-live" role="status">
          {phase === 'finishing'
            ? <><Loader2 size={13} className="nt-spin" aria-hidden="true" /> Finishing the Transcript</>
            : <><span className="nt-mtg-live" aria-hidden="true" /> {phase === 'listening' ? 'Transcribing' : 'Getting Ready'} {clock(t.state.elapsed || 0)}</>}
          {t.state.source === 'mic+tab' && <MonitorSpeaker size={13} aria-label="With the call in this browser" />}
        </span>
      )}
      {active && phase !== 'finishing' && (
        <button type="button" className="nt-text-btn" onClick={() => t.stop()}><Square size={12} aria-hidden="true" /> Stop</button>
      )}
      {loadingModel && (
        <div className="nt-trn-progress">
          <ProgressTrack size="sm" state="live" value={p.total ? p.loaded / p.total : 0} label="Downloading the speech model"
            valueText={`${mb(p.loaded)} of ${mb(p.total) || MODELS[t.state.model || 'tiny'].mb} MB`} />
          <span>Getting the speech model ready - once on this device. Already listening.</span>
        </div>
      )}
      {active && t.state.behind > 30 && <span className="nt-trn-hint">About {Math.round(t.state.behind)} seconds behind - it catches up after you stop.</span>}
      {active && t.state.note && <span className="nt-trn-hint">{t.state.note}</span>}
      {t.state.unsent > 0 && <span className="nt-trn-hint">{t.state.unsent} lines waiting to save - they will be sent when the connection is back.</span>}
      {phase === 'error' && <span className="nt-trn-err" role="alert">{t.state.error}</span>}
      {asking && (
        <ConsentDialog support={support} onClose={() => setAsking(false)}
          onStart={(source) => { setAsking(false); t.start(source); }} />
      )}
    </div>
  );
}

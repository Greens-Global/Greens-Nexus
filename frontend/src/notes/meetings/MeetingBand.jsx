// Meeting Notes (Neil, 11/12/2026): what a meeting note shows around the
// editor.
//
//   useMeetingOfNote - the meeting behind a note (GET /meetings/notes/{id});
//                      null for every other note, without asking the server
//                      (a meeting note's `source.kind` is 'meeting').
//   MeetingBand      - one line under the note's title: when, In Progress
//                      while it runs, Join / Open in Teams, Transcript, and
//                      the people invited with Share With Attendees for the
//                      owner.
//   TranscriptView   - the Teams transcript read now (never stored): who said
//                      what at what time, the cue a note line points at
//                      highlighted, how much each person spoke. Beside the
//                      note on a computer, under the band on a phone.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Video, ScrollText, UserPlus, X, RefreshCw, ExternalLink } from 'lucide-react';
import { api } from '../../api';
import { SkeletonBlocks } from '../../components/AsyncState';
import { formatDate, formatTime } from '../../lib/datetime';
import { teamsMeetingChatUrl } from '../../lib/teamsLinks';
import { attendeeList, cueIndexAt, joinable, meetingPhase, speakerShares } from './meetingModel';

export const isMeetingNote = (note) => !!note && note.kind !== 'board' && note.source?.kind === 'meeting';

export function useMeetingOfNote(noteId, enabled) {
  const [meeting, setMeeting] = useState(null);
  useEffect(() => {
    setMeeting(null);
    if (!noteId || !enabled) return undefined;
    let live = true;
    api.meetingOfNote(noteId).then((m) => { if (live) setMeeting(m); }).catch(() => {});
    return () => { live = false; };
  }, [noteId, enabled]);
  return meeting;
}

const SHOWN = 8;

export function MeetingBand({ note, meeting, people, myEmail, transcriptOpen, onTranscript, onShared, toast }) {
  const [sharing, setSharing] = useState(false);
  const [all, setAll] = useState(false);
  if (!meeting) return null;
  const phase = meetingPhase(meeting);
  const invited = attendeeList(meeting, people, myEmail);
  const shared = new Set((note.sharedWith || []).map((s) => s.email));
  const toShare = invited.filter((p) => p.inNexus && !shared.has(p.email));
  const shown = all ? invited : invited.slice(0, SHOWN);

  // One share per person through the Notes share route (one bell each, Nexus People only).
  const shareAll = async () => {
    setSharing(true);
    let done = 0;
    let last = null;
    for (const p of toShare) {
      try { last = await api.noteShare(note.id, p.email, 'read'); done += 1; } catch { /* counted below */ }
    }
    setSharing(false);
    if (last) onShared?.(last);
    const missed = toShare.length - done;
    toast?.(done ? `Shared with ${done} ${done === 1 ? 'person' : 'people'} - Can Read${missed ? `; ${missed} could not be shared` : ''}` : 'Could not share the note');
  };

  return (
    <section className="nt-mtg-band" aria-label="Meeting">
      <div className="nt-mtg-band-line">
        <Video size={15} aria-hidden="true" className="nt-mtg-band-ico" />
        <span>
          {formatDate(meeting.start)} · {formatTime(meeting.start)} - {formatTime(meeting.end)}
        </span>
        {phase === 'live' && <span className="nt-mtg-now"><span className="nt-mtg-live" aria-hidden="true" /> In Progress</span>}
        <span className="nt-mtg-band-end">
          {meeting.invited && joinable(meeting) && (
            <a className="nt-text-btn" href={meeting.joinUrl} target="_blank" rel="noopener noreferrer"><Video size={14} aria-hidden="true" /> Join</a>
          )}
          {meeting.invited && (
            <button type="button" className={`nt-text-btn${transcriptOpen ? ' is-on' : ''}`} aria-pressed={transcriptOpen}
              onClick={onTranscript} title="The Teams transcript of this meeting, beside your notes">
              <ScrollText size={14} aria-hidden="true" /> Transcript
            </button>
          )}
          {note.mine && !note.trashedAt && toShare.length > 0 && (
            <button type="button" className="nt-text-btn" onClick={shareAll} disabled={sharing}
              title={`Share these notes (Can Read) with ${toShare.map((p) => p.name).join(', ')}`}>
              <UserPlus size={14} aria-hidden="true" /> {sharing ? 'Sharing…' : 'Share With Attendees'}
            </button>
          )}
        </span>
      </div>
      {invited.length > 0 && (
        <div className="nt-mtg-people">
          {shown.map((p) => (
            <span key={p.email} className="nt-mtg-person" title={p.email}>{p.name}</span>
          ))}
          {invited.length > SHOWN && (
            <button type="button" className="nt-tag" onClick={() => setAll((a) => !a)}>{all ? 'Fewer' : `+${invited.length - SHOWN} More`}</button>
          )}
        </div>
      )}
      {!meeting.invited && (
        <div className="nt-mtg-hint">You were not on this meeting's invite, so its transcript and join link are not shown - only the notes.</div>
      )}
    </section>
  );
}

export function TranscriptView({ noteId, focus, onClose, inline = false }) {
  const [state, setState] = useState({ phase: 'loading' });   // loading | ready | none | error
  const listRef = useRef(null);
  const [hit, setHit] = useState(-1);

  const load = useCallback(async () => {
    setState({ phase: 'loading' });
    try {
      setState({ phase: 'ready', data: await api.meetingTranscript(noteId) });
    } catch (e) {
      setState({ phase: e?.status === 404 ? 'none' : 'error', message: e?.message || 'Could not read the transcript' });
    }
  }, [noteId]);
  useEffect(() => { load(); }, [load]);

  const cues = state.data?.cues || [];
  // A note line's time: the cue said just before it, scrolled to and lit.
  useEffect(() => {
    if (state.phase !== 'ready' || !focus?.at) return;
    const k = cueIndexAt(cues, focus.at);
    setHit(k);
    listRef.current?.querySelector(`[data-cue="${k}"]`)?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  }, [focus, state.phase]); // eslint-disable-line react-hooks/exhaustive-deps

  const shares = state.phase === 'ready' ? speakerShares(cues) : [];
  const chat = state.data?.chatThreadId;
  return (
    <aside className={`nt-tx${inline ? ' is-inline' : ''}`} aria-label="Transcript">
      <div className="nt-tx-head">
        <strong>Transcript</strong>
        <span className="nt-tx-head-end">
          {state.phase !== 'loading' && (
            <button type="button" className="nt-icon-btn" aria-label="Read it again from Teams" title="Read It Again" onClick={load}><RefreshCw size={15} /></button>
          )}
          <button type="button" className="nt-icon-btn" aria-label="Close the transcript" title="Close" onClick={onClose}><X size={16} /></button>
        </span>
      </div>
      {state.phase === 'loading' && <div style={{ padding: 12 }}><SkeletonBlocks count={4} height={44} /></div>}
      {state.phase === 'none' && <div className="nt-empty"><strong>No transcript yet</strong>{state.message}</div>}
      {state.phase === 'error' && (
        <div className="nt-empty"><strong>Could not read the transcript</strong>{state.message}
          <div style={{ marginTop: 10 }}><button type="button" className="nt-text-btn" onClick={load}>Try Again</button></div>
        </div>
      )}
      {state.phase === 'ready' && (<>
        {shares.length > 0 && (
          <div className="nt-tx-shares" aria-label="Who spoke how much">
            {shares.slice(0, 6).map((s) => <span key={s.name}>{s.name} {s.pct}%</span>)}
          </div>
        )}
        <ol className="nt-tx-list" ref={listRef}>
          {cues.map((c, k) => (
            <li key={k} data-cue={k} className={k === hit ? 'is-hit' : ''}>
              <div className="nt-tx-meta"><span className="nt-tx-who">{c.speaker || 'Unknown Speaker'}</span> <span>{formatTime(new Date(c.at * 1000))}</span></div>
              <div className="nt-tx-text">{c.text}</div>
            </li>
          ))}
        </ol>
        <div className="nt-tx-foot">
          <span>Read from Teams{state.data.truncated ? ' (the first part of a long call)' : ''} - Nexus keeps no copy.</span>
          {chat && (
            <a className="nt-text-btn" href={teamsMeetingChatUrl(chat)} target="_blank" rel="noopener noreferrer"
              title={state.data.recordings ? 'The meeting chat in Teams - the recording is there' : 'The meeting chat in Teams'}>
              <ExternalLink size={14} aria-hidden="true" /> {state.data.recordings ? 'Recording in Teams' : 'Open in Teams'}
            </a>
          )}
        </div>
      </>)}
    </aside>
  );
}

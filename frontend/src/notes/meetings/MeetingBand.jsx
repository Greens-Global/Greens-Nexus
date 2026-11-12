// Meeting Notes (Neil, 11/12/2026): what a meeting note shows around the
// editor.
//
//   useMeetingOfNote - the meeting behind a note (GET /meetings/notes/{id});
//                      null for every other note, without asking the server
//                      (a meeting note's `source.kind` is 'meeting').
//   MeetingBand      - one line under the note's title: when, In Progress
//                      while it runs, Join, Transcript (Ready once Teams has
//                      one), and the people invited with Share With Attendees
//                      for the owner. Phase 2: in a recurring series, Last
//                      Time - the reader's note from the previous meeting and
//                      the tasks made from it that are still open.
//   TranscriptView   - the Teams transcript read now (never stored). Phase 2:
//                      a Highlights tab (possible action items with Make a
//                      Task, decisions, open questions - read by rules on the
//                      server, meeting_highlights.py, no AI) beside the full
//                      Transcript (who said what at what time, how much each
//                      person spoke, the cue a note line points at lit).
//                      Beside the note on a computer, under the band on a phone.
//                      Phase 3: a meeting outside Teams (or one recorded here
//                      anyway) shows the transcript recorded IN NEXUS - words
//                      only, sessions with the consent, voices that can be
//                      named, Delete Transcript for the note's owner.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Video, ScrollText, UserPlus, X, RefreshCw, ExternalLink, History, ListChecks, Check, MapPin, Trash2 } from 'lucide-react';
import { api } from '../../api';
import { SkeletonBlocks } from '../../components/AsyncState';
import { formatDate, formatTime } from '../../lib/datetime';
import { teamsMeetingChatUrl } from '../../lib/teamsLinks';
import { createTaskFrom, openTask } from '../notesTasks';
import { dialog } from '../../ui/dialog';
import HoldButton from '../../ui/HoldButton';
import Recorder from './Recorder';
import { attendeeList, cueIndexAt, joinable, meetingPhase, speakerShares } from './meetingModel';

export const isMeetingNote = (note) => !!note && note.kind !== 'board' && note.source?.kind === 'meeting';

export function useMeetingOfNote(noteId, enabled, refresh = 0) {
  const [meeting, setMeeting] = useState(null);
  useEffect(() => { setMeeting(null); }, [noteId]);
  useEffect(() => {
    if (!noteId || !enabled) return undefined;
    let live = true;
    api.meetingOfNote(noteId).then((m) => { if (live) setMeeting(m); }).catch(() => {});
    return () => { live = false; };
  }, [noteId, enabled, refresh]);
  return meeting;
}

const SHOWN = 8;

function LastTime({ previous, onOpenNote }) {
  if (!previous) return null;
  const tasks = previous.openTasks || [];
  return (
    <div className="nt-mtg-last">
      <div className="nt-mtg-last-line">
        <History size={14} aria-hidden="true" />
        <span>Last Time:</span>
        <button type="button" className="nt-link-btn" onClick={() => onOpenNote?.(previous.noteId)} title="Open the notes from the last meeting">
          {previous.title || 'Notes'} · {formatDate(previous.start)}
        </button>
        <span className="nt-mtg-last-count">{tasks.length ? `${tasks.length} open ${tasks.length === 1 ? 'task' : 'tasks'}` : 'no open tasks'}</span>
      </div>
      {tasks.length > 0 && (
        <ul className="nt-mtg-last-tasks">
          {tasks.map((t) => (
            <li key={t.id}>
              <button type="button" className="nt-link-btn" onClick={() => openTask(t.id)} title="Open the task">
                {t.code ? <span className="nt-mtg-code">{t.code}</span> : null}{t.title}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const KIND_WORD = { other: 'Meeting', adhoc: 'Meeting', teams: 'Teams Meeting' };

export function MeetingBand({ note, meeting, people, myEmail, transcriptOpen, onTranscript, onShared, onOpenNote, toast,
  recording = false, recorderProps = null }) {
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
        {meeting.kind === 'teams' || !meeting.kind
          ? <Video size={15} aria-hidden="true" className="nt-mtg-band-ico" />
          : <MapPin size={15} aria-hidden="true" className="nt-mtg-band-ico" />}
        <span title={KIND_WORD[meeting.kind || 'teams']}>
          {formatDate(meeting.start)} · {formatTime(meeting.start)}{meeting.end ? ` - ${formatTime(meeting.end)}` : ''}
        </span>
        {phase === 'live' && <span className="nt-mtg-now"><span className="nt-mtg-live" aria-hidden="true" /> In Progress</span>}
        <span className="nt-mtg-band-end">
          {meeting.invited && joinable(meeting) && (
            <a className="nt-text-btn" href={meeting.joinUrl} target="_blank" rel="noopener noreferrer"><Video size={14} aria-hidden="true" /> Join</a>
          )}
          {meeting.onlineUrl && (
            <a className="nt-text-btn" href={meeting.onlineUrl} target="_blank" rel="noopener noreferrer" title="Open the meeting's own link">
              <ExternalLink size={14} aria-hidden="true" /> Open Meeting Link
            </a>
          )}
          {((meeting.invited && meeting.kind !== 'other' && meeting.kind !== 'adhoc') || meeting.recorded?.exists || recording) && (
            <button type="button" className={`nt-text-btn${transcriptOpen ? ' is-on' : ''}`} aria-pressed={transcriptOpen}
              onClick={onTranscript} title={meeting.transcriptReady ? 'Teams has the transcript - open it beside your notes' : 'The Teams transcript of this meeting, beside your notes'}>
              <ScrollText size={14} aria-hidden="true" /> Transcript
              {meeting.transcriptReady && <span className="nt-mtg-ready"><Check size={12} aria-hidden="true" /> Ready</span>}
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
      {invited.length > 0 && meeting.kind !== 'adhoc' && (
        <div className="nt-mtg-people">
          {shown.map((p) => (
            <span key={p.email} className="nt-mtg-person" title={p.email}>{p.name}</span>
          ))}
          {invited.length > SHOWN && (
            <button type="button" className="nt-tag" onClick={() => setAll((a) => !a)}>{all ? 'Fewer' : `+${invited.length - SHOWN} More`}</button>
          )}
        </div>
      )}
      {meeting.mayRecord && !note.trashedAt && recorderProps && <Recorder {...recorderProps} />}
      <LastTime previous={meeting.previous} onOpenNote={onOpenNote} />
      {!meeting.invited && meeting.kind !== 'adhoc' && (
        <div className="nt-mtg-hint">You were not on this meeting's invite, so its Teams transcript and join link are not shown - only the notes.</div>
      )}
    </section>
  );
}

const KINDS = [
  { key: 'actions', label: 'Possible Action Items' },
  { key: 'decisions', label: 'Decisions' },
  { key: 'questions', label: 'Open Questions' },
];

function Highlights({ highlights, note, myEmail, toast, onJump }) {
  const [made, setMade] = useState({});      // `${kind}:${k}` -> task id ('' while creating)
  const total = KINDS.reduce((n, k) => n + (highlights?.[k.key]?.length || 0), 0);
  if (!total) {
    return (
      <div className="nt-empty">
        <strong>Nothing stood out</strong>
        Highlights pick up lines like "I'll send the quote by Friday", "Let's go with the Austin vendor" and real questions. The full transcript is one tab over.
      </div>
    );
  }
  const makeTask = async (id, item) => {
    setMade((m) => ({ ...m, [id]: '' }));
    try {
      const t = await createTaskFrom(item.text, note, myEmail);
      setMade((m) => ({ ...m, [id]: t?.id || 'done' }));
      toast?.(`Task created: ${item.text.slice(0, 60)}`, t?.id ? { label: 'Open Task', run: () => openTask(t.id) } : null);
    } catch (e) {
      setMade((m) => { const n = { ...m }; delete n[id]; return n; });
      toast?.(e?.message || 'Could not create the task');
    }
  };
  return (
    <div className="nt-tx-hl">
      {KINDS.map(({ key, label }) => {
        const items = highlights?.[key] || [];
        if (!items.length) return null;
        return (
          <section key={key} aria-label={label}>
            <div className="nt-tx-hl-title">{label} <span>{items.length}</span></div>
            <ul>
              {items.map((it, k) => {
                const id = `${key}:${k}`;
                const state = made[id];
                return (
                  <li key={id}>
                    <div className="nt-tx-meta">
                      <span className="nt-tx-who">{it.speaker || 'Unknown Speaker'}</span>
                      <button type="button" className="nt-link-btn" onClick={() => onJump(it.i)} title="See it in the transcript">
                        {formatTime(new Date(it.at * 1000))}
                      </button>
                      {it.due && <span className="nt-tx-due">{it.due}</span>}
                    </div>
                    <div className="nt-tx-text">{it.text}</div>
                    {key === 'actions' && note && (
                      <div className="nt-tx-hl-act">
                        {state && state !== 'done'
                          ? <button type="button" className="nt-text-btn" onClick={() => openTask(state)}><Check size={13} aria-hidden="true" /> Open Task</button>
                          : state === 'done'
                            ? <span className="nt-tx-made"><Check size={13} aria-hidden="true" /> Task Created</span>
                            : <button type="button" className="nt-text-btn" disabled={state === ''} onClick={() => makeTask(id, it)}>
                                <ListChecks size={13} aria-hidden="true" /> {state === '' ? 'Creating…' : 'Make a Task'}
                              </button>}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
      <p className="nt-tx-hl-foot">Picked by wording, not AI - check each one before you act on it.</p>
    </div>
  );
}

const nameOfBy = (email, myEmail) => (email && email.toLowerCase() === (myEmail || '').toLowerCase() ? 'you' : email);

export function TranscriptView({ noteId, note = null, myEmail = '', toast, focus, onClose, inline = false,
  sources = ['teams'], liveCues = [], recording = false, reloadKey = 0 }) {
  const [state, setState] = useState({ phase: 'loading' });   // loading | ready | none | error
  const listRef = useRef(null);
  const [hit, setHit] = useState(-1);
  const [tab, setTab] = useState('');          // '' = not picked yet: Highlights when there are any
  const [jump, setJump] = useState(null);      // { k, seq } - a highlight's cue to show
  const [source, setSource] = useState(sources.includes('recorded') && (recording || sources[0] !== 'teams') ? 'recorded' : sources[0]);
  useEffect(() => { if (!sources.includes(source)) setSource(sources[0]); }, [sources.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (recording && sources.includes('recorded')) setSource('recorded'); }, [recording]); // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(async () => {
    setState({ phase: 'loading' });
    try {
      const data = source === 'recorded' ? await api.meetingRecorded(noteId) : await api.meetingTranscript(noteId);
      setState({ phase: 'ready', data });
    } catch (e) {
      setState({ phase: e?.status === 404 ? 'none' : 'error', message: e?.message || 'Could not read the transcript' });
    }
  }, [noteId, source]);
  useEffect(() => { load(); }, [load, reloadKey]);

  const recorded = source === 'recorded';
  const stored = state.data?.cues || [];
  const cues = recorded && liveCues.length
    ? (() => { const have = new Set(stored.map((c) => c.id)); return [...stored, ...liveCues.filter((c) => !have.has(c.id))].sort((a, b) => a.at - b.at); })()
    : stored;
  const hl = state.data?.highlights;
  const hlCount = KINDS.reduce((n, k) => n + (hl?.[k.key]?.length || 0), 0);
  const shown = tab || (focus?.at || !hlCount || recording ? 'transcript' : 'highlights');

  // Show cue k in the transcript: switch there, light it, scroll to it.
  const showCue = useCallback((k) => {
    if (k < 0) return;
    setTab('transcript');
    setHit(k);
    setJump((j) => ({ k, seq: (j?.seq || 0) + 1 }));
  }, []);
  // A note line's time: the cue said just before it.
  useEffect(() => {
    if (state.phase !== 'ready' || !focus?.at) return;
    showCue(cueIndexAt(cues, focus.at));
  }, [focus, state.phase]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!jump || shown !== 'transcript') return;
    listRef.current?.querySelector(`[data-cue="${jump.k}"]`)?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  }, [jump, shown]);
  // While recording, follow the newest line.
  useEffect(() => {
    if (recording && shown === 'transcript' && !jump) listRef.current?.lastElementChild?.scrollIntoView?.({ block: 'end' });
  }, [cues.length, recording, shown, jump]);

  const rename = async (label, current) => {
    if (!recorded || !state.data?.mayRecord || !label) return;
    const name = await dialog.prompt('Who is this voice?', { title: 'Name This Voice', defaultValue: current === label ? '' : current, confirmText: 'Save' });
    if (name == null) return;
    try {
      const data = await api.meetingRecordedSpeakers(noteId, { ...(state.data.speakers || {}), [label]: name.trim() });
      setState({ phase: 'ready', data });
    } catch (e) { toast?.(e.message || 'Could not name the voice'); }
  };
  const remove = async () => {
    try { await api.meetingRecordedDelete(noteId); } catch (e) { throw new Error(e.message || 'Could not delete the transcript', { cause: e }); }
    toast?.('Transcript deleted');
    load();
  };

  const shares = state.phase === 'ready' ? speakerShares(cues) : [];
  const chat = state.data?.chatThreadId;
  const sessions = recorded ? (state.data?.sessions || []) : [];
  const first = sessions[0];
  const empty = state.phase === 'ready' && recorded && !cues.length;
  return (
    <aside className={`nt-tx${inline ? ' is-inline' : ''}`} aria-label="Transcript">
      <div className="nt-tx-head">
        {state.phase === 'ready' && !empty ? (
          <div className="nt-tx-tabs scroll-tabs" role="tablist" aria-label="Transcript views">
            <button type="button" role="tab" aria-selected={shown === 'highlights'} className={`nt-view${shown === 'highlights' ? ' is-on' : ''}`}
              onClick={() => setTab('highlights')}>Highlights{hlCount > 0 && <span className="nt-count">{hlCount}</span>}</button>
            <button type="button" role="tab" aria-selected={shown === 'transcript'} className={`nt-view${shown === 'transcript' ? ' is-on' : ''}`}
              onClick={() => setTab('transcript')}>Transcript</button>
          </div>
        ) : <strong>Transcript</strong>}
        <span className="nt-tx-head-end">
          {state.phase !== 'loading' && (
            <button type="button" className="nt-icon-btn" aria-label={recorded ? 'Read it again' : 'Read it again from Teams'} title="Read It Again" onClick={load}><RefreshCw size={15} /></button>
          )}
          <button type="button" className="nt-icon-btn" aria-label="Close the transcript" title="Close" onClick={onClose}><X size={16} /></button>
        </span>
      </div>
      {sources.length > 1 && (
        <div className="nt-tx-src" role="group" aria-label="Which transcript">
          <button type="button" aria-pressed={source === 'teams'} className={source === 'teams' ? 'is-on' : ''} onClick={() => { setSource('teams'); setTab(''); }}>From Teams</button>
          <button type="button" aria-pressed={recorded} className={recorded ? 'is-on' : ''} onClick={() => { setSource('recorded'); setTab(''); }}>Recorded in Nexus</button>
        </div>
      )}
      {state.phase === 'loading' && <div style={{ padding: 12 }}><SkeletonBlocks count={4} height={44} /></div>}
      {state.phase === 'none' && <div className="nt-empty"><strong>No transcript yet</strong>{state.message}</div>}
      {state.phase === 'error' && (
        <div className="nt-empty"><strong>Could not read the transcript</strong>{state.message}
          <div style={{ marginTop: 10 }}><button type="button" className="nt-text-btn" onClick={load}>Try Again</button></div>
        </div>
      )}
      {empty && (
        <div className="nt-empty"><strong>{recording ? 'Listening' : 'Nothing recorded yet'}</strong>
          {recording ? 'The first words show here a few seconds after they are said.' : 'Press Start Transcribing above to turn what is said into text, on this device.'}
        </div>
      )}
      {state.phase === 'ready' && !empty && shown === 'highlights' && (
        <div className="nt-tx-list">
          <Highlights highlights={hl} note={note} myEmail={myEmail} toast={toast} onJump={showCue} />
        </div>
      )}
      {state.phase === 'ready' && !empty && shown === 'transcript' && (<>
        {shares.length > 1 && (
          <div className="nt-tx-shares" aria-label="Who spoke how much">
            {shares.slice(0, 6).map((sh) => <span key={sh.name}>{sh.name} {sh.pct}%</span>)}
          </div>
        )}
        <ol className="nt-tx-list" ref={listRef}>
          {cues.map((c, k) => (
            <li key={c.id || k} data-cue={k} className={k === hit ? 'is-hit' : ''}>
              <div className="nt-tx-meta">
                {recorded && c.label && state.data?.mayRecord
                  ? <button type="button" className="nt-tx-who nt-link-btn" title="Name this voice" onClick={() => rename(c.label, c.speaker)}>{c.speaker}</button>
                  : (c.speaker || !recorded) && <span className="nt-tx-who">{c.speaker || 'Unknown Speaker'}</span>}
                <span>{formatTime(new Date(c.at * 1000))}</span>
              </div>
              <div className="nt-tx-text">{c.text}</div>
            </li>
          ))}
        </ol>
      </>)}
      {state.phase === 'ready' && !recorded && (
        <div className="nt-tx-foot">
          <span>Read from Teams{state.data.truncated ? ' (the first part of a long call)' : ''} - Nexus keeps no copy.</span>
          {chat && (
            <a className="nt-text-btn" href={teamsMeetingChatUrl(chat)} target="_blank" rel="noopener noreferrer"
              title={state.data.recordings ? 'The meeting chat in Teams - the recording is there' : 'The meeting chat in Teams'}>
              <ExternalLink size={14} aria-hidden="true" /> {state.data.recordings ? 'Recording in Teams' : 'Open in Teams'}
            </a>
          )}
        </div>
      )}
      {state.phase === 'ready' && recorded && !empty && (
        <div className="nt-tx-foot">
          <span>
            Recorded in Nexus - only the words are kept, the audio never left the device.
            {first && ` Started ${formatDate(first.startedAt)} ${formatTime(first.startedAt)} by ${nameOfBy(first.by, myEmail)}; everyone present agreed.`}
            {first?.engine === 'browser' && " Turned into text by the browser's speech service."}
          </span>
          {state.data?.mayDelete && !recording && (
            <HoldButton size="sm" label="Delete Transcript" doneLabel="Deleted" icon={Trash2} onConfirm={remove}
              fallbackMessage="Delete this meeting's transcript for good? The notes stay." />
          )}
        </div>
      )}
    </aside>
  );
}

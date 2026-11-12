// Meeting Notes (Neil, 11/12/2026): the day's Teams meetings, from the
// person's own Outlook calendar (GET /meetings/day), each with Take Notes /
// Open Notes and Join. Opening one makes its note once (POST /meetings/notes)
// and hands the id back to the Notes page. A sheet from the right on a
// computer, the bottom sheet on a phone - the shared Modal. Phase 2: the
// person's own opt-in to the Transcript Ready bell sits at its foot.
import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Video, NotebookPen, CalendarX2 } from 'lucide-react';
import { api } from '../../api';
import { Modal } from '../../tasks/components';
import { SkeletonBlocks } from '../../components/AsyncState';
import { SwitchRow } from '../../components/settings/SettingsUI';
import { formatTime } from '../../lib/datetime';
import { addDays, dayHeading, localDay } from '../notesModel';
import { dayBounds, joinable, meetingPhase } from './meetingModel';

function Row({ m, busy, onOpen }) {
  const phase = meetingPhase(m);
  const others = (m.attendees || []).length;
  return (
    <li className={`nt-mtg-row${phase === 'ended' ? ' is-past' : ''}`}>
      <div className="nt-mtg-when">
        <span>{formatTime(m.start)}</span>
        <span className="nt-mtg-to">{formatTime(m.end)}</span>
      </div>
      <div className="nt-mtg-main">
        <div className="nt-mtg-title">
          {phase === 'live' && <span className="nt-mtg-live" aria-label="In Progress" title="In Progress" />}
          {m.subject}
        </div>
        <div className="nt-mtg-sub">
          {m.isOrganizer ? 'You organized' : `Organized by ${m.organizer?.name || m.organizer?.email || 'someone'}`}
          {others > 0 && ` · ${others} ${others === 1 ? 'person' : 'people'} invited`}
        </div>
      </div>
      <div className="nt-mtg-actions">
        {joinable(m) && (
          <a className="nt-text-btn" href={m.joinUrl} target="_blank" rel="noopener noreferrer" title="Join in Teams">
            <Video size={14} aria-hidden="true" /> Join
          </a>
        )}
        <button type="button" className={`nt-text-btn${m.noteId ? '' : ' is-primary'}`} disabled={busy} onClick={() => onOpen(m)}>
          <NotebookPen size={14} aria-hidden="true" /> {busy ? 'Opening…' : m.noteId ? 'Open Notes' : 'Take Notes'}
        </button>
      </div>
    </li>
  );
}

export default function MeetingsSheet({ onClose, onOpened }) {
  const today = localDay();
  const [day, setDay] = useState(today);
  const [data, setData] = useState(null);     // { enabled, reason, meetings }
  const [error, setError] = useState('');
  const [opening, setOpening] = useState('');
  // The Transcript Ready bell: off until the person turns it on (opt-in, Neil 11/12/2026).
  const [alerts, setAlerts] = useState(null);
  const [alertsMsg, setAlertsMsg] = useState('');
  useEffect(() => {
    let live = true;
    Promise.resolve(api.meetingsAccess?.()).then((r) => { if (live) setAlerts(!!r?.alerts); }).catch(() => {});
    return () => { live = false; };
  }, []);
  const toggleAlerts = async (on) => {
    setAlerts(on); setAlertsMsg('');
    try {
      await api.meetingAlerts(on);
      setAlertsMsg(on ? 'On - you get a bell when a transcript is ready.' : 'Off.');
    } catch (e) { setAlerts(!on); setAlertsMsg(e?.message || 'Could not change it'); }
  };

  const load = useCallback(async () => {
    setData(null); setError('');
    try {
      const { start, end } = dayBounds(day);
      setData(await api.meetingsDay(start, end));
    } catch (e) { setError(e.message || 'Could not read your calendar'); }
  }, [day]);
  useEffect(() => { load(); }, [load]);

  const open = async (m) => {
    if (m.noteId) { onOpened(m.noteId); return; }
    setOpening(m.eventId);
    try {
      const r = await api.meetingNoteOpen(m.eventId, day);
      onOpened(r.noteId, r.created);
    } catch (e) { setError(e.message || 'Could not start the notes'); }
    finally { setOpening(''); }
  };

  const meetings = data?.meetings || [];
  return (
    <Modal title="Meetings" onClose={onClose} width="560px">
      <div className="nt-mtg-day" role="group" aria-label="Day">
        <button type="button" className="nt-icon-btn" aria-label="Previous day" onClick={() => setDay((d) => addDays(d, -1))}><ChevronLeft size={17} /></button>
        <span className="nt-mtg-day-label" aria-live="polite">{dayHeading(day, today)}</span>
        <button type="button" className="nt-icon-btn" aria-label="Next day" onClick={() => setDay((d) => addDays(d, 1))}><ChevronRight size={17} /></button>
        {day !== today && <button type="button" className="nt-tag" onClick={() => setDay(today)}>Today</button>}
      </div>
      {error && (
        <div className="nt-banner is-bad" role="alert">
          <span className="nt-banner-text">{error}</span>
          <button type="button" className="nt-text-btn" onClick={load}>Try Again</button>
        </div>
      )}
      {!data && !error && <SkeletonBlocks count={3} height={56} />}
      {data && !data.enabled && (
        <div className="nt-empty"><strong>Your calendar is not connected yet</strong>{data.reason}</div>
      )}
      {data?.enabled && meetings.length === 0 && (
        <div className="nt-empty">
          <CalendarX2 size={26} aria-hidden="true" style={{ color: 'var(--wk-faint)', marginBottom: 8 }} />
          <strong>No Teams meetings {day === today ? 'today' : 'this day'}</strong>
          Meetings with a Teams link on your Outlook calendar show here.
        </div>
      )}
      {meetings.length > 0 && (
        <ul className="nt-mtg-list">
          {meetings.map((m) => <Row key={m.eventId} m={m} busy={opening === m.eventId} onOpen={open} />)}
        </ul>
      )}
      {data?.enabled && alerts !== null && (
        <div className="nt-mtg-alerts">
          <SwitchRow id="nt-mtg-alerts" title="Tell Me When a Transcript Is Ready" checked={alerts} onChange={toggleAlerts}
            desc="After a meeting you took notes for, a bell when Teams publishes its transcript - it opens your notes with the transcript beside them." />
          {alertsMsg && <div className="nt-mtg-alerts-msg" role="status">{alertsMsg}</div>}
        </div>
      )}
      {data?.enabled && (
        <p className="nt-mtg-foot">
          Take Notes during the call; each line keeps the time you wrote it. After the call, the Teams transcript opens beside
          your notes - turn on transcription in the meeting so there is one. Nexus links to the transcript and recording in Teams and keeps no copy.
        </p>
      )}
    </Modal>
  );
}

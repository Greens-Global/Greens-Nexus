// The facilitation strip at the top of a Board (Neil, 11/10/2026, meet.js):
// the shared timer, the open vote and Private Writing, each with its
// controls, for everyone on the board at once. Pure UI - Board.jsx owns what
// each button does to the shared map.
import { useEffect, useState } from 'react';
import { Timer, Pause, Play, Plus, X, Vote, EyeOff } from 'lucide-react';
import { clock, timeLeft } from './meet';

function useNow(on) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!on) return undefined;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [on]);
  return now;
}

export default function MeetBar({ state, canEdit, myLeft = 0, cast = 0, tray = 0, onTimer, onVote, onReveal }) {
  const { timer, vote, silent } = state || {};
  const now = useNow(!!timer && !timer.paused);
  if (!timer && !vote && !silent) return null;
  const left = timeLeft(timer, now);
  const up = !!timer && left <= 0;
  return (
    <div className="nx-meet" role="region" aria-label="Meeting" data-testid="nx-meet">
      {timer && (
        <div className={`nx-meet-item${up ? ' is-up' : ''}${timer.paused ? '' : ' is-live'}`}>
          <Timer size={15} aria-hidden />
          <span className="nx-meet-clock" aria-live={up ? 'assertive' : 'off'}>{up ? "Time's Up" : clock(left)}</span>
          {canEdit && !up && (timer.paused
            ? <button type="button" className="nx-meet-btn" onClick={() => onTimer?.('resume')} aria-label="Resume Timer" title="Resume"><Play size={14} /></button>
            : <button type="button" className="nx-meet-btn" onClick={() => onTimer?.('pause')} aria-label="Pause Timer" title="Pause"><Pause size={14} /></button>)}
          {canEdit && <button type="button" className="nx-meet-btn" onClick={() => onTimer?.('add')} aria-label="Add a Minute" title="Add a Minute"><Plus size={14} /></button>}
          {canEdit && <button type="button" className="nx-meet-btn" onClick={() => onTimer?.('stop')} aria-label="Stop Timer" title="Stop"><X size={14} /></button>}
        </div>
      )}
      {vote && (
        <div className="nx-meet-item">
          <Vote size={15} aria-hidden />
          <span>{myLeft} of {vote.perPerson} Votes Left</span>
          <span className="nx-meet-dim">{cast} cast</span>
          {canEdit && <button type="button" className="nx-meet-text is-primary" onClick={() => onVote?.('results')}>Show Results</button>}
          {canEdit && <button type="button" className="nx-meet-btn" onClick={() => onVote?.('cancel')} aria-label="Cancel Vote" title="Cancel Vote"><X size={14} /></button>}
        </div>
      )}
      {silent && (
        <div className="nx-meet-item">
          <EyeOff size={15} aria-hidden />
          <span>Private Writing{tray ? ` - ${tray} of yours hidden` : ''}</span>
          {canEdit && <button type="button" className="nx-meet-text is-primary" onClick={onReveal}>Reveal Stickies</button>}
        </div>
      )}
    </div>
  );
}

import { ChevronRight } from 'lucide-react';
import { fmtHM } from '../lib/timeclockStore';
import ShiftTrack from '../components/ShiftTrack';
import { formatTime } from '../lib/datetime';
import { trackNoteText } from '../lib/shiftTrack';

// The header's time chip. Nothing at all for someone who is not time-tracked
// (Neil, Oct 14: "Clocked Out - Open time clock" on a salaried person's
// dashboard made no sense) and nothing until the status has loaded, so the
// chip never flashes Clocked Out before it knows. On a break it says so.
// Today's shift rides along the pill's bottom edge as a hairline track
// (Neil, 11/02/2026: orange while clocked in, green once done, nothing with
// no shift today) - the pill keeps its size and its one line; the track's
// words are in the hover title.
export function SessionChip({ mine, onOpen }) {
  // 'unknown' is also a first status read that failed: the chip stays away
  // rather than claim Clocked Out (the Workday widgets say Unavailable).
  if (!mine || mine.exempt || mine.state === 'exempt' || mine.state === 'unknown') return null;   // the store's view-model says 'exempt' as a state
  const on = mine.state === 'in' || mine.state === 'break';
  const trackText = trackNoteText(mine.track, formatTime);
  // A button's children are presentational, so the track's progressbar text
  // never reaches a screen reader from inside it - the name carries it.
  const said = mine.state === 'break' ? `On Break · ${fmtHM(mine.todayMin)}`
    : on ? `Clocked In · ${fmtHM(mine.todayMin)}` : 'Clocked Out · Open Time Clock';
  return (
    <button
      className={`dk-session-chip${on ? ' dk-session-chip--on' : ''}${mine.track ? ' has-track' : ''}`}
      onClick={onOpen}
      aria-label={trackText ? `${said} - ${trackText}` : undefined}
      title={trackText ? `Open Time Clock - ${trackText}` : 'Open Time Clock'}
      style={{ flexShrink: 0, whiteSpace: 'nowrap' }}
    >
      <span className={`dk-dot ${on ? 'dk-dot--up' : 'dk-dot--off'}`} />
      {mine.state === 'break' ? <>On Break · <b>{fmtHM(mine.todayMin)}</b></>
        : on ? <>Clocked In · <b>{fmtHM(mine.todayMin)}</b></>
          : <>Clocked Out<span className="dk-session-long"> · Open Time Clock</span></>}
      {/* Phones only: the chip leads the toolbar row there, and the chevron
          says a tap opens the Time Clock (style.css hides it elsewhere). */}
      <ChevronRight size={15} className="dk-session-go" aria-hidden="true" />
      {mine.track && <ShiftTrack track={mine.track} size="sm" ends={false} note={false} marker={false} className="dk-session-track" />}
    </button>
  );
}

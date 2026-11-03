// Today's shift as a track (Neil, 11/02/2026, mock
// https://claude.ai/artifact/PwncxMck8YaSkFkQ8hmTHE section 1): the expected
// start and end at the ends, a ringed marker at "now", orange (the live
// accent) while clocked in, green once the shift is complete, and one line
// under it ("4h 16m left in today's shift"). The math is lib/shiftTrack.js;
// the bar is ui/ProgressTrack.jsx. Nothing at all with no track (no shift
// today) - never a made-up bar.
//
// `size` 'md' (the Workday card, My Time) or 'sm' (the chips); `ends` and
// `note` can be left off where there is no room - the note is then still
// what a screen reader hears, and the hover title.
import ProgressTrack from '../ui/ProgressTrack';
import { formatTime } from '../lib/datetime';
import { trackNote } from '../lib/shiftTrack';

export default function ShiftTrack({ track, size = 'md', ends = true, note = true, marker = true, className = '', style }) {
  if (!track) return null;
  const n = trackNote(track, formatTime);
  const text = n ? `${n.strong}${n.rest}` : '';
  return (
    <div className={`nx-shift-track${className ? ` ${className}` : ''}`} style={style} title={note ? undefined : text}>
      <ProgressTrack
        value={track.value}
        state={track.state}
        size={size}
        marker={marker && track.marker}
        start={ends ? formatTime(track.start) : undefined}
        end={ends ? formatTime(track.end) : undefined}
        note={note && n ? <><b>{n.strong}</b>{n.rest}</> : undefined}
        label="Today's shift"
        valueText={`${text} (${formatTime(track.start)} to ${formatTime(track.end)})`}
      />
    </div>
  );
}

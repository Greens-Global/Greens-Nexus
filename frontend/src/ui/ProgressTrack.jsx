// Progress track (Neil, 11/02/2026; mock https://claude.ai/artifact/PwncxMck8YaSkFkQ8hmTHE).
// THE one progress bar for new work: a running shift, onboarding, payroll
// readiness, miles to the next service, a project's tasks. The filled part is
// solid, the rest is a dashed track; optional end labels above, an optional
// note below, an optional ringed marker at "now".
//
//   state 'live'    still moving - the live accent (--wk-live, orange; cobalt
//                   for a company whose brand is orange / red)
//         'done'    finished - green (--wk-green)
//         'overdue' past due - red (--wk-red)
//         'idle'    not started / paused - gray
//   With no `state`, a value of 1 or more is 'done', anything else 'live'.
//
// Props
//   value   0..1, clamped (NaN = 0)
//   state   see above
//   start / end   end labels, already formatted by the caller (formatTime etc.)
//   note    a node under the bar; its <b> / <strong> part takes the state's ink
//           (--wk-live-ink / --ok-fg / --bad-fg), the rest stays muted
//   marker  a ringed dot at the current position (never shown when done)
//   size    'md' (6px, default) | 'sm' (4px)
//   label   the accessible name (aria-label)
//   valueText  what a screen reader hears; defaults to the note's text, else "67%"
//   className / style   passed to the wrapper
//
// <ProgressTrack value={worked / planned} start="9:02 AM" end="5:30 PM" marker
//   label="Today's shift" note={<><b>4h 16m left</b> in today's shift</>} />
//
// Orange is never a button, a warning or a count badge - see the "Live
// accent" block in style.css and DESIGN.md.
import { Children, isValidElement } from 'react';

export const TRACK_STATES = ['live', 'done', 'overdue', 'idle'];

export function clampProgress(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(n, 0), 1);
}

export function trackState(value, state) {
  if (TRACK_STATES.includes(state)) return state;
  return clampProgress(value) >= 1 ? 'done' : 'live';
}

// The plain text of a node (strings, numbers, nested elements), for aria-valuetext.
export function nodeText(node) {
  let out = '';
  Children.forEach(node, (c) => {
    if (c == null || typeof c === 'boolean') return;
    if (typeof c === 'string' || typeof c === 'number') out += c;
    else if (isValidElement(c)) out += nodeText(c.props.children);
  });
  return out;
}

export default function ProgressTrack({
  value = 0, state, start, end, note, marker = false, size = 'md', label, valueText,
  className = '', style,
}) {
  const v = clampProgress(value);
  const st = trackState(value, state);
  const pct = Math.round(v * 1000) / 10;   // one decimal, so a slow shift still moves
  const text = valueText || nodeText(note).trim() || `${Math.round(v * 100)}%`;
  const showMarker = marker && st !== 'done';
  return (
    <div className={`nx-track is-${st} is-${size === 'sm' ? 'sm' : 'md'}${className ? ` ${className}` : ''}`} style={style}>
      {(start || end) && (
        <div className="nx-track-ends">
          <span>{start}</span>
          <span>{end}</span>
        </div>
      )}
      <div
        className="nx-track-bar"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(v * 100)}
        aria-valuetext={text}
      >
        <span className="nx-track-fill" style={{ width: `${pct}%` }} />
        {showMarker && <span className="nx-track-marker" style={{ left: `${pct}%` }} aria-hidden="true" />}
      </div>
      {note != null && note !== false && note !== '' && <div className="nx-track-note">{note}</div>}
    </div>
  );
}

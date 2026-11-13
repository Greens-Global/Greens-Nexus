// The Quick Actions bolt (Neil, 11/13/2026). Its SHAPE follows the reference
// Neil sent ("I liked the shape of the yellow lightning bolt ... it felt more
// prominent"): a chunky two-block bolt - a wide upper block leaning right, a
// notch, then a lower block that sweeps out to the right and down to a sharp
// point at the bottom left - with rounded corners and a darker extruded edge
// along its right and bottom that gives it depth. Its COLOR is ours: the
// gradient is on the bolt (bright green to deep green; "the gradient on the
// bolt and the background to look less flashy"), the lower block a shade
// deeper than the upper. Green only - never yellow or orange (Live accent).
// .qc-btn in style.css draws the calm tile behind it.
import { useId } from 'react';

// The outline in a 24 x 24 box (traced from the reference, 1.5 to 22.5 tall).
const BOLT = 'M7.3 1.5H16.4L14.4 8.3 20.3 8.9 7.9 22.5 8.8 13.3 3.7 13Z';
// The lower block: from the notch, out to the right tip, down to the point,
// back up to the left notch.
const LOWER = 'M14.4 8.3 20.3 8.9 7.9 22.5 8.8 13.3Z';

export default function BoltIcon({ size = 24, style, ...rest }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={style} aria-hidden="true" focusable="false" {...rest}>
      <defs>
        <linearGradient id={`${id}-face`} x1="0.15" y1="0" x2="0.55" y2="1">
          <stop offset="0" stopColor="#5eeca3" />
          <stop offset="0.5" stopColor="#22c777" />
          <stop offset="1" stopColor="#00a25b" />
        </linearGradient>
        <linearGradient id={`${id}-lower`} x1="0.4" y1="0" x2="0.3" y2="1">
          <stop offset="0" stopColor="#1dbd70" />
          <stop offset="1" stopColor="#008a4c" />
        </linearGradient>
      </defs>
      <g strokeLinejoin="round" strokeLinecap="round">
        {/* the extruded edge: the same bolt, nudged right and down, deep green */}
        <path d={BOLT} transform="translate(0.45 0.6)" fill="#006b3a" stroke="#006b3a" strokeWidth="0.9" />
        {/* the face, lit from the top left */}
        <path d={BOLT} fill={`url(#${id}-face)`} stroke={`url(#${id}-face)`} strokeWidth="0.9" />
        {/* the lower block, a shade deeper - the step the reference shows */}
        <path d={LOWER} fill={`url(#${id}-lower)`} opacity="0.35" />
      </g>
    </svg>
  );
}

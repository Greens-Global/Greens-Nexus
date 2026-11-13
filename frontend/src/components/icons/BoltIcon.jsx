// The Quick Actions bolt (Neil, 11/13/2026). Its SHAPE follows the reference
// Neil sent ("I liked the shape of the yellow lightning bolt ... it felt more
// prominent"): a chunky two-block bolt - a wide upper block leaning right, a
// notch, then a lower block that sweeps out to the right and down to a sharp
// point at the bottom left - with rounded corners.
// It is a THIN 3D OBJECT, not a flat shape with a shadow (Neil: "the corners
// are part of it"): the same outline is stacked from the back to the front in
// thin steps, so its right and bottom side walls are solid, joined to the face
// at every corner, a mid green that darkens toward the back; the face sits on
// top with a faint light edge. Its COLOR is ours: the gradient is on the bolt
// (bright green to brand green; "the gradient on the bolt and the background
// to look less flashy"). Green only - never yellow or orange (Live accent).
// .qc-btn in style.css draws the calm tile behind it.
import { useId } from 'react';

// The outline in a 24 x 24 box (traced from the reference).
const BOLT = 'M7.1 1.4H16.2L14.2 8.2 20.1 8.8 7.7 22.2 8.6 13.2 3.5 12.9Z';
// The lower block: from the notch, out to the right tip, down to the point,
// back up to the left notch - a shade deeper on the face.
const LOWER = 'M14.2 8.2 20.1 8.8 7.7 22.2 8.6 13.2Z';
// The depth: how far the back sits right and down, and in how many steps.
const DEPTH = { x: 0.62, y: 0.78, steps: 9 };
// The side walls from the back (deepest) to just behind the face.
const SIDE_BACK = [0, 92, 51];     // #005c33
const SIDE_FRONT = [10, 134, 74];  // #0a864a
const mix = (a, b, t) => `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(',')})`;

export default function BoltIcon({ size = 24, style, ...rest }) {
  const id = useId().replace(/:/g, '');
  const layers = Array.from({ length: DEPTH.steps }, (_, k) => {
    const i = DEPTH.steps - k;                    // the back first
    const t = 1 - i / DEPTH.steps;                // 0 at the back, near 1 at the front
    return { x: (DEPTH.x * i) / DEPTH.steps, y: (DEPTH.y * i) / DEPTH.steps, color: mix(SIDE_BACK, SIDE_FRONT, t) };
  });
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={style} aria-hidden="true" focusable="false" {...rest}>
      <defs>
        {/* One long, even blend from the lit top left to the brand green
            (Neil, 11/13/2026: "blend the gradient a little better"). */}
        <linearGradient id={`${id}-face`} x1="0.2" y1="0" x2="0.5" y2="1">
          <stop offset="0" stopColor="#56e9a0" />
          <stop offset="0.35" stopColor="#3ad88d" />
          <stop offset="0.7" stopColor="#1cbe72" />
          <stop offset="1" stopColor="#0aa962" />
        </linearGradient>
        <linearGradient id={`${id}-lower`} x1="0.4" y1="0" x2="0.3" y2="1">
          <stop offset="0" stopColor="#1dbd70" stopOpacity="0" />
          <stop offset="1" stopColor="#008a4c" />
        </linearGradient>
      </defs>
      <g strokeLinejoin="round" strokeLinecap="round">
        {/* the body: thin slices from the back to the front make solid side walls */}
        {layers.map((l) => (
          <path key={`${l.x}`} d={BOLT} transform={`translate(${l.x.toFixed(3)} ${l.y.toFixed(3)})`}
            fill={l.color} stroke={l.color} strokeWidth="0.9" />
        ))}
        {/* the face, lit from the top left */}
        <path d={BOLT} fill={`url(#${id}-face)`} stroke={`url(#${id}-face)`} strokeWidth="0.9" />
        {/* the lower block, a shade deeper - the step the reference shows */}
        <path d={LOWER} fill={`url(#${id}-lower)`} opacity="0.22" />
        {/* the face's edge, where it turns into the side walls - barely there
            (Neil, 11/13/2026: "minimize the striking-ness of the stroke") */}
        <path d={BOLT} fill="none" stroke="#c9f9de" strokeOpacity="0.18" strokeWidth="0.25" />
      </g>
    </svg>
  );
}

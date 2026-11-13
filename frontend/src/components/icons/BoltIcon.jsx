// The Quick Actions bolt (Neil, 11/13/2026).
//
// SHAPE: FITTED to the reference Neil sent ("I liked the shape of the yellow
// lightning bolt ... get it exactly right" / "it needs a tighter waist"). The
// outline was not drawn by eye: its seven corners and each corner's own
// rounding were solved against the reference face's pixels until the two
// overlapped 97.5% - the deep right notch and left notch that make the tight
// waist, the upper block's lean, soft top corners and right tip, a sharp left
// notch and a near-sharp bottom point. Every corner's rounding was then
// taken in a fifth (Neil: "the roundness is too exaggerated"); the corners
// themselves did not move. Change it only by fitting again.
//
// DEPTH: a THIN 3D OBJECT, not a flat shape with a shadow ("the corners are
// part of it"): the outline is stacked from the back to the front in thin
// slices, so its right and bottom side walls are solid and joined to the face
// at every corner, a green that darkens toward the back - the slab's thickness
// measured from the reference too. The face meets the walls by color alone,
// no drawn edge ("make the stroke blend in better").
//
// COLOR: ours. The gradient is on the bolt, one even blend from the lit top
// left to the brand green ("the gradient on the bolt and the background to
// look less flashy"), the lower block a shade deeper. Green only - never
// yellow or orange (Live accent). .qc-btn in style.css draws the calm tile.
import { useId } from 'react';

// The fitted outline in a 24 x 24 box (each corner a curve of its own size,
// 80% of the fitted one).
const BOLT = 'M8.64 1.28L14.35 1.26Q16.41 1.25 15.54 3.12L13.2 8.18Q12.94 8.73 13.55 8.74L19.11 8.88Q21.22 8.93 19.68 10.38L7.48 21.82Q7.22 22.06 7.26 21.71L8.35 13.37L3.14 13.4Q2.34 13.4 2.6 12.64L5.83 3.3Q6.52 1.3 8.64 1.28Z';
// The lower block (the notches to the right tip and the bottom point), tinted
// a shade deeper and clipped to the face so it never pokes past a rounded tip.
const LOWER = 'M12.94 8.73 21.22 8.93 7.22 22.06 8.35 13.37Z';
// The slab's depth (right, down) and how many slices draw it.
const DEPTH = { x: 0.44, y: 0.69, steps: 8 };
// The side walls from the back (deepest) to just behind the face.
const SIDE_BACK = [3, 104, 58];    // #03683a
const SIDE_FRONT = [12, 150, 82];  // #0c9652 - close to the face's lower green, so they blend
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
        <clipPath id={`${id}-clip`}><path d={BOLT} /></clipPath>
      </defs>
      <g strokeLinejoin="round">
        {/* the body: thin slices from the back to the front make solid side walls */}
        {layers.map((l) => (
          <path key={`${l.x}`} d={BOLT} transform={`translate(${l.x.toFixed(3)} ${l.y.toFixed(3)})`}
            fill={l.color} stroke={l.color} strokeWidth="0.2" />
        ))}
        {/* the face, lit from the top left */}
        <path d={BOLT} fill={`url(#${id}-face)`} stroke={`url(#${id}-face)`} strokeWidth="0.2" />
        {/* the lower block, a shade deeper - the step the reference shows */}
        <path d={LOWER} fill={`url(#${id}-lower)`} opacity="0.22" clipPath={`url(#${id}-clip)`} />
      </g>
    </svg>
  );
}

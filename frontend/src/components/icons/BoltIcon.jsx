// The Quick Actions bolt (Neil, 11/13/2026).
//
// SHAPE: FITTED to the reference Neil sent ("I liked the shape of the yellow
// lightning bolt ... get it exactly right" / "it needs a tighter waist"). The
// outline was not drawn by eye: its seven corners and each corner's own
// rounding were solved against the reference face's pixels until the two
// overlapped 97.5% - the deep right notch and left notch that make the tight
// waist, the upper block's lean, soft top corners and right tip, a sharp left
// notch and a near-sharp bottom point. Every corner's rounding was then
// taken in by half (Neil: "the roundness is too exaggerated" / "50% less
// round is good"); the corners themselves did not move. Change it only by
// fitting again.
//
// DEPTH: a THIN 3D OBJECT, not a flat shape with a shadow ("the corners are
// part of it"): the outline is stacked from the back to the front in thin
// slices, so its right and bottom side walls are solid and joined to the face
// at every corner, a green that darkens toward the back - the slab's thickness
// measured from the reference too. The face meets the walls by color alone,
// no drawn edge ("make the stroke blend in better").
//
// COLOR: ours, lit the way the reference is. The reference's face is two
// tones with a deeper band running down the bolt's length - from the top
// right corner to the left notch - between a lighter upper left and a
// lighter lower block; its band has hard edges. Ours keeps the band where
// the reference has it (measured from its pixels) and blends it in ("a
// little more like the original but blended much better ... the original
// is too sharp"), with a soft light from the top and a touch of depth toward
// the bottom point. Green only - never yellow or orange (Live accent).
// .qc-btn in style.css draws the calm tile.
import { useId } from 'react';

// The fitted outline in a 24 x 24 box (each corner a curve of its own size,
// half the fitted one).
const BOLT = 'M7.84 1.29L15.12 1.25Q16.41 1.25 15.87 2.42L13.1 8.38Q12.94 8.73 13.32 8.73L19.9 8.9Q21.22 8.93 20.25 9.84L7.38 21.91Q7.22 22.06 7.24 21.84L8.35 13.37L2.84 13.4Q2.34 13.4 2.5 12.93L6.09 2.55Q6.52 1.3 7.84 1.29Z';
// The band runs along (-0.66, 0.75); the face gradient runs across it, along
// n = (0.751, 0.661), from the bolt's nearest point (5.75 along n) to its
// farthest (21.83). The reference's band sits at 10.95 - 15.27 along n.
const ACROSS = { x1: 4.32, y1: 3.8, x2: 16.39, y2: 14.42 };
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
        <linearGradient id={`${id}-face`} gradientUnits="userSpaceOnUse" {...ACROSS}>
          <stop offset="0" stopColor="#4fe39d" />
          <stop offset="0.22" stopColor="#43dc94" />
          <stop offset="0.42" stopColor="#27c47c" />
          <stop offset="0.52" stopColor="#27c47c" />
          <stop offset="0.72" stopColor="#3dd68e" />
          <stop offset="1" stopColor="#33cc85" />
        </linearGradient>
        <linearGradient id={`${id}-light`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.2" />
          <stop offset="0.45" stopColor="#ffffff" stopOpacity="0" />
          <stop offset="0.62" stopColor="#00552e" stopOpacity="0" />
          <stop offset="1" stopColor="#00552e" stopOpacity="0.16" />
        </linearGradient>
      </defs>
      <g strokeLinejoin="round">
        {/* the body: thin slices from the back to the front make solid side walls */}
        {layers.map((l) => (
          <path key={`${l.x}`} d={BOLT} transform={`translate(${l.x.toFixed(3)} ${l.y.toFixed(3)})`}
            fill={l.color} stroke={l.color} strokeWidth="0.2" />
        ))}
        {/* the face: the band down its length, blended */}
        <path d={BOLT} fill={`url(#${id}-face)`} stroke={`url(#${id}-face)`} strokeWidth="0.2" />
        {/* a soft light from the top, a touch of depth toward the bottom point */}
        <path d={BOLT} fill={`url(#${id}-light)`} />
      </g>
    </svg>
  );
}

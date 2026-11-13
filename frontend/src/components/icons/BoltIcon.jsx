// The Quick Actions bolt (Neil, 11/13/2026). Its SHAPE follows the reference
// Neil sent ("I liked the shape of the yellow lightning bolt ... it felt more
// prominent"): a chunky two-block bolt - a wide upper block leaning right, a
// notch, then a lower block that sweeps out to the right and down to a sharp
// point at the bottom left - with rounded corners.
// It is a THIN 3D OBJECT, not a flat shape with a shadow (Neil: "the corners
// are part of it"): the same outline is stacked from the back to the front in
// thin steps, so its right and bottom side walls are solid, joined to the face
// at every corner, a mid green that darkens toward the back; the face sits on
// top and meets them by color alone, no drawn edge. Its COLOR is ours: the gradient is on the bolt
// (bright green to brand green; "the gradient on the bolt and the background
// to look less flashy"). Green only - never yellow or orange (Live accent).
// .qc-btn in style.css draws the calm tile behind it.
import { useId } from 'react';

// The outline in a 24 x 24 box, TRACED FROM THE REFERENCE'S PIXELS (Neil,
// 11/13/2026: "the center is a little tighter ... there's a little angle to
// it"): its face's edges fitted row by row - the deep right notch that pulls
// the waist in, the upper block leaning at the reference's angle, the lower
// block's left edge a touch off vertical. Set inside the traced lines by half
// the round 1.4 stroke below (the reference's soft corners), so the edges land on them and only the corners round.
const BOLT = 'M7.88 2.2H15.61L12.78 9.87 19.36 10.51 8.85 20.61 9.84 13.15 4.05 13.15Z';
// The lower block: from the notch, out to the right tip, down to the point,
// back up to the left notch - a shade deeper on the face.
const LOWER = 'M12.78 9.87 19.36 10.51 8.85 20.61 9.84 13.15Z';
// The depth: how far the back sits right and down, and in how many steps.
// Measured from the reference too: a thin slab, a little deeper down than right.
const DEPTH = { x: 0.42, y: 0.62, steps: 8 };
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
            fill={l.color} stroke={l.color} strokeWidth="1.4" />
        ))}
        {/* the face, lit from the top left */}
        <path d={BOLT} fill={`url(#${id}-face)`} stroke={`url(#${id}-face)`} strokeWidth="1.4" />
        {/* the lower block, a shade deeper - the step the reference shows */}
        <path d={LOWER} fill={`url(#${id}-lower)`} opacity="0.22" />
      </g>
    </svg>
  );
}

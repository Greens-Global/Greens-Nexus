// The Quick Actions bolt (Neil, 11/13/2026: "make the action button look
// cooler ... a badass button. Take the best elements but keep it our green"):
// a faceted, filled bolt - the light upper-left face and a mint lower-right
// face split along the bolt's spine, so it reads as a solid 3D shape on the
// green tile (.qc-btn in style.css draws the tile, its rim and its gloss).
// Colors stay white and mint: the bolt is never yellow or orange (Live accent).
import { useId } from 'react';

export default function BoltIcon({ size = 22, style, ...rest }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={style} aria-hidden="true" focusable="false" {...rest}>
      <defs>
        <linearGradient id={`${id}-lit`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#e9fbf1" />
        </linearGradient>
        <linearGradient id={`${id}-shade`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#d3f6e2" />
          <stop offset="1" stopColor="#a8ebc5" />
        </linearGradient>
      </defs>
      {/* the whole bolt, the lit face */}
      <path d="M15.2 1.8 3.6 13.9h7.3L8.6 22.2 20.4 9.6h-7.2Z" fill={`url(#${id}-lit)`}
        stroke={`url(#${id}-lit)`} strokeWidth="1.2" strokeLinejoin="round" />
      {/* the shaded face: right of the spine from the top point to the bottom point */}
      <path d="M15.2 1.8 13.2 9.6h7.2L8.6 22.2Z" fill={`url(#${id}-shade)`}
        stroke={`url(#${id}-shade)`} strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

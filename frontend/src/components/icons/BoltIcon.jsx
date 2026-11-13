// The Quick Actions bolt (Neil, 11/13/2026: "a badass button ... keep it our
// green"; then "the gradient on the bolt and the background to look less
// flashy"): a faceted, filled bolt carrying the gradient itself - the lit
// upper-left face bright green to brand green, the shaded lower-right face
// brand green to deep green, split along the spine so it reads as a solid 3D
// shape on a calm tile (.qc-btn in style.css). Green only: never yellow or
// orange (Live accent).
import { useId } from 'react';

export default function BoltIcon({ size = 22, style, ...rest }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={style} aria-hidden="true" focusable="false" {...rest}>
      <defs>
        {/* The gradient is ON the bolt (Neil, 11/13/2026): bright green lit
            from the top, down to the brand green; the shaded face runs
            brand green to deep green. */}
        <linearGradient id={`${id}-lit`} x1="0.2" y1="0" x2="0.6" y2="1">
          <stop offset="0" stopColor="#6ef2ad" />
          <stop offset="0.55" stopColor="#1fc274" />
          <stop offset="1" stopColor="#00a25b" />
        </linearGradient>
        <linearGradient id={`${id}-shade`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#12b066" />
          <stop offset="1" stopColor="#006b3a" />
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

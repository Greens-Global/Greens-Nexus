import { useEffect, useRef } from 'react';

// A small HSV color wheel (Sep 27) for Settings > Brand Color: hue around the
// circle, saturation from the center out, with a brightness slider beside it
// for dark colors. Canvas-drawn, no dependency. The handle takes pointer drags
// (mouse, pen, touch - touch-action:none stops the page scrolling under a
// finger) and the keyboard: Left/Right turn the hue, Up/Down change saturation.
// Lazy-loaded by views/BrandingPoliciesSettings.jsx, only when Custom is picked.

function hsvToHex(h, s, v) {
  const f = (n) => {
    const k = (n + h / 60) % 6;
    return Math.round(255 * v * (1 - s * Math.max(0, Math.min(k, 4 - k, 1))));
  };
  return '#' + [f(5), f(3), f(1)].map(x => x.toString(16).padStart(2, '0')).join('');
}

function hexToHsv(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const v = Math.max(r, g, b), d = v - Math.min(r, g, b);
  let h = 0;
  if (d) h = 60 * (v === r ? ((g - b) / d + 6) % 6 : v === g ? (b - r) / d + 2 : (r - g) / d + 4);
  return [h, v ? d / v : 0, v];
}

const SIZE = 180, R = SIZE / 2;

export default function ColorWheel({ hex, onChange }) {
  const canvas = useRef(null);
  const [h, s, v] = hexToHsv(hex);

  // The wheel only depends on brightness; redraw when it changes.
  useEffect(() => {
    const ctx = canvas.current?.getContext?.('2d');
    if (!ctx) return;
    const img = ctx.createImageData(SIZE, SIZE);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const dx = x - R, dy = y - R, d = Math.hypot(dx, dy);
        if (d > R) continue;
        const c = hsvToHex((Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360, d / R, v);
        const n = parseInt(c.slice(1), 16), i = (y * SIZE + x) * 4;
        img.data.set([n >> 16, (n >> 8) & 255, n & 255, 255], i);
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [v]);

  const set = (nh, ns, nv = v) => onChange(hsvToHex((nh + 360) % 360, Math.min(Math.max(ns, 0), 1), nv));
  const pick = (e) => {
    const r = canvas.current.getBoundingClientRect();
    const dx = e.clientX - r.left - R, dy = e.clientY - r.top - R;
    set(Math.atan2(dy, dx) * 180 / Math.PI, Math.hypot(dx, dy) / R);
  };
  const key = (e) => {
    const step = { ArrowLeft: [-5, 0], ArrowRight: [5, 0], ArrowUp: [0, 0.05], ArrowDown: [0, -0.05] }[e.key];
    if (step) { e.preventDefault(); set(h + step[0], s + step[1]); }
  };
  const a = h * Math.PI / 180;

  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
      <div style={{ position: 'relative', width: SIZE, height: SIZE, touchAction: 'none' }}
        onPointerDown={e => { e.currentTarget.setPointerCapture?.(e.pointerId); pick(e); }}
        onPointerMove={e => { if (e.buttons) pick(e); }}>
        <canvas ref={canvas} width={SIZE} height={SIZE} style={{ borderRadius: '50%', display: 'block' }} />
        <div role="slider" tabIndex={0} aria-label="Hue and saturation" aria-valuemin={0} aria-valuemax={360}
          aria-valuenow={Math.round(h)} aria-valuetext={`Hue ${Math.round(h)} degrees, saturation ${Math.round(s * 100)}%`}
          onKeyDown={key}
          style={{ position: 'absolute', left: R + Math.cos(a) * s * R - 9, top: R + Math.sin(a) * s * R - 9,
            width: 18, height: 18, borderRadius: '50%', border: '3px solid #fff', boxShadow: '0 0 0 1px rgba(0,0,0,.4)',
            background: hex, cursor: 'grab' }} />
      </div>
      <label style={{ fontSize: 12, color: 'var(--muted)', display: 'grid', gap: 4 }}>
        Brightness {Math.round(v * 100)}%
        <input type="range" min={10} max={100} value={Math.round(v * 100)}
          onChange={e => set(h, s, e.target.value / 100)} />
      </label>
    </div>
  );
}

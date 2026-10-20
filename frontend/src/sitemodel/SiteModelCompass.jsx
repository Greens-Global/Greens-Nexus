// Compass and tilt buttons on the site map (Visesh, Oct 20 2026: "how do I
// rotate the map"). Like Google Maps: the needle shows where north is; click it
// to face north again, drag it left / right to turn; the arrows turn in steps;
// 2D / 3D flips between looking straight down and the usual angle.
import { useEffect, useRef, useState } from 'react';

const FONT = "'Inter', system-ui, sans-serif";
const btn = {
  width: 36, height: 36, display: 'grid', placeItems: 'center', border: 'none', background: 'transparent',
  color: '#1d1f1a', cursor: 'pointer', font: `600 12px ${FONT}`, padding: 0,
};
const STEP = Math.PI / 8;   // 22.5 degrees per arrow click

export default function SiteModelCompass({ viewerRef }) {
  const [cam, setCam] = useState({ heading: 0, tilt: 1 });
  const drag = useRef(null);

  // Follow the camera (drags, fly-tos, Reset View) - cheap: one read per frame, a render only on change.
  useEffect(() => {
    let raf; let last = '';
    const tick = () => {
      const c = viewerRef.current?.getCamera?.();
      if (c) { const key = `${c.heading.toFixed(3)}|${c.tilt.toFixed(3)}`; if (key !== last) { last = key; setCam(c); } }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [viewerRef]);

  const v = () => viewerRef.current;
  if (!v()?.getCamera) return null;
  const flat = cam.tilt > 1.3;

  const onDown = (e) => { e.stopPropagation(); drag.current = { x: e.clientX, moved: false }; e.currentTarget.setPointerCapture(e.pointerId); };
  const onMove = (e) => {
    const d = drag.current; if (!d) return;
    const dx = e.clientX - d.x; if (Math.abs(dx) > 2) d.moved = true;
    d.x = e.clientX; v()?.turnBy?.(-dx * 0.012);
  };
  const onUp = () => { const d = drag.current; drag.current = null; if (d && !d.moved) v()?.faceNorth?.(); };

  return (
    <div className="sm-compass" style={{ position: 'absolute', right: 12, top: 112, zIndex: 3, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, fontFamily: FONT }}
      onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
      <div style={{ display: 'flex', alignItems: 'center', background: 'rgba(255,255,255,0.96)', borderRadius: 999, boxShadow: '0 4px 14px rgba(20,40,30,0.18)' }}>
        <button type="button" style={btn} aria-label="Turn Left" title="Turn Left" onClick={() => v()?.turnBy?.(STEP)}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 3v6h6" /></svg>
        </button>
        <button type="button" aria-label="Compass: click to face north, drag to turn" title="Click to face north · Drag to turn"
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => { drag.current = null; }}
          style={{ ...btn, width: 44, height: 44, borderRadius: 999, background: '#fff', boxShadow: 'inset 0 0 0 1px rgba(20,40,30,0.12)', cursor: 'grab', touchAction: 'none' }}>
          <svg width="30" height="30" viewBox="0 0 30 30" aria-hidden="true" style={{ transform: `rotate(${(cam.heading * 180) / Math.PI}deg)`, transition: drag.current ? 'none' : 'transform 0.12s' }}>
            <polygon points="15,3 19,15 11,15" fill="#d93025" />
            <polygon points="15,27 19,15 11,15" fill="#9aa09a" />
          </svg>
        </button>
        <button type="button" style={btn} aria-label="Turn Right" title="Turn Right" onClick={() => v()?.turnBy?.(-STEP)}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 3v6h-6" /></svg>
        </button>
      </div>
      <button type="button" aria-label={flat ? 'Tilt to 3D' : 'Look straight down (2D)'} title={flat ? 'Tilt to 3D' : 'Look straight down'}
        onClick={() => v()?.toggleTilt?.()}
        style={{ ...btn, width: 44, height: 32, borderRadius: 999, background: 'rgba(255,255,255,0.96)', boxShadow: '0 4px 14px rgba(20,40,30,0.18)' }}>
        {flat ? '3D' : '2D'}
      </button>
    </div>
  );
}

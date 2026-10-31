// The sheet in miniature (10/30/2026): every block as a colored rect, the
// ink as faint strokes, and the part of the sheet the person is looking at
// as an accent box. Display only; it answers "where am I on a big sheet".
import { nodeColor } from './palette';

export default function Minimap({ layout, catalog, view, box }) {
  if (!layout) return null;
  const W = 172; const H = 112;
  const k = Math.min(W / layout.w, H / layout.h);
  const ox = (W - layout.w * k) / 2; const oy = (H - layout.h * k) / 2;
  let vp = null;
  if (box && box.width && view) {
    const wx = -view.x / view.s; const wy = -view.y / view.s;
    vp = { left: ox + wx * k, top: oy + wy * k, width: (box.width / view.s) * k, height: (box.height / view.s) * k };
  }
  return (
    <div className="wfc-mini" aria-hidden="true" data-testid="wfc-minimap">
      <svg viewBox={`0 0 ${layout.w} ${layout.h}`} preserveAspectRatio="xMidYMid meet">
        {layout.edges.map((e) => <path key={e.id} d={e.d} fill="none" stroke="var(--cv-edge)" strokeWidth="3" opacity=".6" />)}
        {layout.nodes.filter((n) => n.kind !== 'join' && n.kind !== 'ghost').map((n) => (
          <rect key={n.id} x={n.x} y={n.y} width={n.w} height={n.h} rx="14" opacity=".85"
            fill={n.kind === 'fault' ? 'transparent' : nodeColor(n, catalog)} stroke={n.kind === 'fault' ? 'var(--cv-edge)' : 'none'} />
        ))}
      </svg>
      {vp && <div className="wfc-mini-vp" style={vp} />}
    </div>
  );
}

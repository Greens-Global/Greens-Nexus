// The markup layer: an SVG the size of the viewport that draws the items of
// the pin being made (and, faintly, the items of an open pin, shifted by how
// far its target has moved since capture). Never takes pointer events - the
// Overlay owns drawing and hands the in-progress item down as `draft`.

const ARROW_HEAD = 14;

function Arrow({ it, dx, dy }) {
  const x1 = it.x1 + dx, y1 = it.y1 + dy, x2 = it.x2 + dx, y2 = it.y2 + dy;
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const head = ARROW_HEAD + (it.width || 3) * 2;
  const p1 = [x2 - head * Math.cos(ang - Math.PI / 7), y2 - head * Math.sin(ang - Math.PI / 7)];
  const p2 = [x2 - head * Math.cos(ang + Math.PI / 7), y2 - head * Math.sin(ang + Math.PI / 7)];
  return (
    <g>
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={it.color} strokeWidth={it.width || 3} strokeLinecap="round" />
      <polygon points={`${x2},${y2} ${p1[0]},${p1[1]} ${p2[0]},${p2[1]}`} fill={it.color} />
    </g>
  );
}

export function MarkupItem({ it, dx = 0, dy = 0, faint = false }) {
  if (!it) return null;
  const op = faint ? 0.55 : 1;
  switch (it.type) {
    case 'rect':
      return <rect x={it.x + dx} y={it.y + dy} width={Math.max(0, it.w)} height={Math.max(0, it.h)} fill="none" stroke={it.color} strokeWidth={it.width || 3} rx={3} opacity={op} />;
    case 'highlight':
      return <rect x={it.x + dx} y={it.y + dy} width={Math.max(0, it.w)} height={Math.max(0, it.h)} fill={it.color || '#facc15'} opacity={0.35 * op} />;
    case 'redact':
      return (
        <g opacity={op}>
          <rect x={it.x + dx} y={it.y + dy} width={Math.max(0, it.w)} height={Math.max(0, it.h)} fill="url(#bm-redact)" stroke="#0f172a" strokeWidth={1.5} strokeDasharray="4 3" />
          {it.w > 60 && it.h > 16 && (
            <text x={it.x + dx + it.w / 2} y={it.y + dy + it.h / 2} textAnchor="middle" dominantBaseline="middle" fill="#fff" fontFamily="Inter, sans-serif" fontSize={11} fontWeight={700} style={{ paintOrder: 'stroke', stroke: '#0f172a', strokeWidth: 3 }}>REDACTED</text>
          )}
        </g>
      );
    case 'arrow':
      return <g opacity={op}><Arrow it={it} dx={dx} dy={dy} /></g>;
    case 'path':
      return <polyline points={(it.points || []).map(([x, y]) => `${x + dx},${y + dy}`).join(' ')} fill="none" stroke={it.color} strokeWidth={it.width || 3} strokeLinecap="round" strokeLinejoin="round" opacity={op} />;
    case 'text':
      return (
        <text x={it.x + dx} y={it.y + dy} dominantBaseline="hanging" fill={it.color || '#111827'} fontFamily="Inter, sans-serif" fontSize={it.size || 16} fontWeight={700}
          style={{ paintOrder: 'stroke', stroke: 'rgba(255,255,255,0.95)', strokeWidth: 4, strokeLinejoin: 'round' }} opacity={op}>{it.text}</text>
      );
    default:
      return null;
  }
}

export default function Markup({ items = [], draft = null, faintItems = [], faintOffset = { dx: 0, dy: 0 } }) {
  return (
    <svg className="bm-markup" data-testid="bm-markup" width="100%" height="100%" aria-hidden="true"
      style={{ position: 'fixed', inset: 0, width: '100vw', height: '100vh', pointerEvents: 'none', zIndex: 5905, overflow: 'visible' }}>
      <defs>
        <pattern id="bm-redact" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="8" height="8" fill="rgba(15,23,42,0.85)" />
          <line x1="0" y1="0" x2="0" y2="8" stroke="rgba(255,255,255,0.18)" strokeWidth="3" />
        </pattern>
      </defs>
      {faintItems.map((it, i) => <MarkupItem key={`f${i}`} it={it} dx={faintOffset.dx} dy={faintOffset.dy} faint />)}
      {items.map((it, i) => <MarkupItem key={it.id || i} it={it} />)}
      {draft && <MarkupItem it={draft} />}
    </svg>
  );
}

// The site model as a flat plan (Oct 20 2026): what the stage shows when the
// device has no WebGL, so the screen is never blank. Same geometry, same unit
// colors (the active layer's, or occupancy for owners, neutral for customers),
// the route from the gate as a line, and a tap selects a unit.
import { memo, useMemo } from 'react';
import { baseUnitColor } from './siteModelViewer.js';

const hex = (n) => '#' + n.toString(16).padStart(6, '0');

export const SiteModelPlan2D = memo(function SiteModelPlan2D({ model, mode = 'customer', colors = null, selected = null, route = null, onSelect }) {
  const box = useMemo(() => {
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    const take = (u, v) => { u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); };
    (model.buildings || []).forEach((b) => { take(b.u[0], b.v[0]); take(b.u[1], b.v[1]); });
    (model.units || []).forEach((x) => { take(x.u, x.v); take(x.u + x.wu, x.v + x.dv); });
    (model.gates || []).forEach((g) => take(g.uv[0], g.uv[1]));
    if (!isFinite(u0)) return '0 0 100 100';
    const pad = 12;
    return `${u0 - pad} ${-v1 - pad} ${u1 - u0 + 2 * pad} ${v1 - v0 + 2 * pad}`;
  }, [model]);
  const parcels = model.parcels ? model.parcels.map((p) => p.uv) : model.parcel ? [model.parcel] : [];
  const pts = (arr) => arr.map((p) => `${p[0]},${-p[1]}`).join(' ');
  const sel = selected ? (model.units || []).find((x) => x.n === selected) : null;
  return (
    <svg viewBox={box} role="img" aria-label={`${model.property?.name || 'Site'} plan`} style={{ width: '100%', height: '100%', display: 'block', background: '#e9ebe4' }}>
      {parcels.filter((p) => p && p.length > 2).map((p, i) => <polygon key={`p${i}`} points={pts(p)} fill="#f4f3ee" stroke="#1f6f4a" strokeWidth={0.6} />)}
      {(model.buildings || []).map((b) => (
        <g key={b.id}>
          <rect x={b.u[0]} y={-b.v[1]} width={b.u[1] - b.u[0]} height={b.v[1] - b.v[0]} fill="#ffffff" stroke="#55584f" strokeWidth={0.4} />
          <text x={(b.u[0] + b.u[1]) / 2} y={-(b.v[0] + b.v[1]) / 2} fontSize={4} textAnchor="middle" dominantBaseline="middle" fill="#3d4038" style={{ pointerEvents: 'none', fontWeight: 600 }}>{b.letters?.length ? b.letters.join(' / ') : b.name}</text>
        </g>
      ))}
      {(model.units || []).map((x) => {
        const cx = x.u + x.wu / 2, cy = -(x.v + x.dv / 2);
        const fill = x.n === selected ? '#ff7a00' : hex(baseUnitColor(x, mode, colors));
        return (
          <rect key={x.n} data-unit={x.n} x={x.u + 0.06} y={-(x.v + x.dv) + 0.06} width={Math.max(0.3, x.wu - 0.12)} height={Math.max(0.3, x.dv - 0.12)}
            transform={x.rot ? `rotate(${-x.rot} ${cx} ${cy})` : undefined} fill={fill} stroke="rgba(0,0,0,0.25)" strokeWidth={0.1}
            style={{ cursor: onSelect ? 'pointer' : 'default' }} onClick={onSelect ? () => onSelect(x) : undefined}>
            <title>{x.n}</title>
          </rect>
        );
      })}
      {route && route.points.length > 1 && <polyline points={pts(route.points)} fill="none" stroke="#1a73e8" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" strokeDasharray="3 1.6" />}
      {route && route.stops.map((s, i) => (
        <g key={`s${i}`}>
          <circle cx={s.uv[0]} cy={-s.uv[1]} r={2} fill={s.end ? '#ff7a00' : '#1a73e8'} stroke="#fff" strokeWidth={0.5} />
          <text x={s.uv[0]} y={-s.uv[1]} fontSize={2.4} textAnchor="middle" dominantBaseline="central" fill="#fff" style={{ pointerEvents: 'none', fontWeight: 700 }}>{i + 1}</text>
        </g>
      ))}
      {(model.gates || []).map((g) => (
        <g key={g.id}>
          <circle cx={g.uv[0]} cy={-g.uv[1]} r={1.6} fill="#1f6f4a" />
          <text x={g.uv[0]} y={-g.uv[1] - 3} fontSize={3.4} textAnchor="middle" fill="#1f6f4a" style={{ fontWeight: 700 }}>{g.name}</text>
        </g>
      ))}
      {sel && <rect x={sel.u - 0.6} y={-(sel.v + sel.dv) - 0.6} width={sel.wu + 1.2} height={sel.dv + 1.2} fill="none" stroke="#ff7a00" strokeWidth={0.6} />}
    </svg>
  );
});

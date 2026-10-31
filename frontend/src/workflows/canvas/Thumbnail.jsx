// A workflow's silhouette as a small picture (Blueprint, 10/30/2026): the
// Templates gallery shows one per card so a workflow is recognized by its
// shape before its name is read. Drawn from the row's compact `shape`
// (canvas/shape.js) through the same layout engine as the canvas, at
// thumbnail scale: rounded blocks in the kind's color, the connectors as
// ink, the joins as dots. The fault lane is left out.
//
// The Workflows list is a table, and a whole sheet squeezed into a 40px row
// reads as a row of dots - so a row shows the ShapeStrip instead: the steps
// as colored tiles in reading order, smaller inside a branch or a loop.
import { useMemo } from 'react';
import { JOIN_R, layout } from './layout';
import { definitionFromShape } from './shape';

export const COLOR = {
  trigger: 'var(--ink)',
  gate: '#475569',
  action: 'var(--wk-brand)',
  if: 'hsl(271,60%,48%)',
  approval: 'hsl(236,60%,52%)',
  wait: 'hsl(30,80%,48%)',
  for_each: 'hsl(174,60%,36%)',
  stop: '#64748b',
};
const KIND_WORD = { trigger: 'Trigger', action: 'Action', if: 'If / Else', approval: 'Ask For Approval', wait: 'Wait', for_each: 'For Each', stop: 'Stop' };

function picture(shape) {
  const L = layout(definitionFromShape(shape));
  // the main tree only: the fault lane hangs to the right of everything else
  const fault = L.nodes.find((n) => n.id === 'fault');
  const cut = fault ? fault.x - 1 : Infinity;
  const nodes = L.nodes.filter((n) => n.x < cut);
  const frames = L.frames.filter((f) => f.x < cut);
  const edges = L.edges.filter((e) => e.to !== 'tail' && e.a.x < cut && e.b.x < cut);
  const xs = nodes.map((n) => n.x).concat(frames.map((f) => f.x));
  const xe = nodes.map((n) => n.x + n.w).concat(frames.map((f) => f.x + f.w));
  const ys = nodes.map((n) => n.y).concat(frames.map((f) => f.y));
  const ye = nodes.map((n) => n.y + n.h).concat(frames.map((f) => f.y + f.h));
  const pad = 24;
  const box = { x: Math.min(...xs) - pad, y: Math.min(...ys) - pad, w: Math.max(...xe) - Math.min(...xs) + 2 * pad, h: Math.max(...ye) - Math.min(...ys) + 2 * pad };
  return { nodes, frames, edges, box };
}

export default function Thumbnail({ shape, width = 56, height = 36, title = 'Workflow shape' }) {
  const key = JSON.stringify(shape || []);
  const { nodes, frames, edges, box } = useMemo(() => picture(JSON.parse(key)), [key]);
  return (
    <svg data-testid="wf-thumb" role="img" aria-label={title} width={width} height={height}
      viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`} preserveAspectRatio="xMidYMid meet"
      style={{ display: 'block', maxWidth: '100%', flexShrink: 0 }}>
      {frames.map((f) => (
        <rect key={f.id} x={f.x} y={f.y} width={f.w} height={f.h} rx={16} fill="none" stroke="var(--muted)" strokeOpacity=".45" strokeWidth={3} strokeDasharray="8 8" />
      ))}
      {edges.map((e) => <path key={e.id} d={e.d} fill="none" stroke="var(--muted)" strokeOpacity=".55" strokeWidth={3} strokeDasharray={e.dashed ? '8 8' : undefined} />)}
      {nodes.map((n) => {
        if (n.kind === 'join') return <circle key={n.id} cx={n.x + JOIN_R} cy={n.y + JOIN_R} r={JOIN_R + 2} fill="var(--muted)" />;
        if (n.kind === 'ghost') return <rect key={n.id} x={n.x} y={n.y} width={n.w} height={n.h} rx={12} fill="none" stroke="var(--muted)" strokeOpacity=".5" strokeWidth={3} strokeDasharray="8 8" />;
        const fill = COLOR[n.kind] || COLOR.action;
        return (
          <g key={n.id}>
            <rect x={n.x} y={n.y} width={n.w} height={n.h} rx={n.kind === 'stop' ? n.h / 2 : 18} fill="var(--card)" stroke="var(--line)" strokeWidth={2} />
            <rect x={n.x + 12} y={n.y + 14} width={40} height={40} rx={n.kind === 'trigger' ? 20 : 12} fill={fill} />
            {n.kind !== 'stop' && <rect x={n.x + 64} y={n.y + 22} width={Math.max(20, n.w - 90)} height={9} rx={4} fill="var(--line)" />}
            {n.kind !== 'stop' && <rect x={n.x + 64} y={n.y + 39} width={Math.max(12, (n.w - 90) * 0.6)} height={9} rx={4} fill="var(--line)" />}
          </g>
        );
      })}
    </svg>
  );
}

// The steps as tiles, reading order, depth first: a step inside a branch or
// a loop is a smaller tile. At most `max` tiles, then "+N".
export function flattenShape(shape, depth = 0, out = []) {
  (Array.isArray(shape) ? shape : []).forEach((s) => {
    if (!Array.isArray(s) || !s.length) return;
    out.push({ kind: String(s[0]), depth });
    (Array.isArray(s[1]) ? s[1] : []).forEach((lane) => flattenShape(lane, depth + 1, out));
  });
  return out;
}

export function ShapeStrip({ shape, max = 12, title = 'Workflow shape' }) {
  const tiles = useMemo(() => flattenShape(shape), [shape]);
  const shown = tiles.slice(0, max);
  const more = tiles.length - shown.length;
  const words = shown.map((t) => KIND_WORD[t.kind] || t.kind).join(', ');
  return (
    <span data-testid="wf-shape" role="img" aria-label={`${title}: ${words || 'no steps yet'}${more > 0 ? ` and ${more} more` : ''}`}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 3, height: 12, flexShrink: 0 }}>
      <span aria-hidden="true" style={{ width: 12, height: 12, borderRadius: 6, background: COLOR.trigger, opacity: .8 }} />
      {shown.map((t, i) => (
        <span key={i} aria-hidden="true" style={{
          width: t.depth ? 8 : 12, height: t.depth ? 8 : 12, borderRadius: t.kind === 'stop' ? 6 : 3,
          background: COLOR[t.kind] || COLOR.action, opacity: t.depth ? .7 : .95,
        }} />
      ))}
      {more > 0 && <span aria-hidden="true" style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--muted)', marginLeft: 2 }}>+{more}</span>}
    </span>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import { FS } from '../../../lib/typeScale';
import { downloadBlob } from '../reportModel';
import { SHAPES, layout as layoutGraph, pctText, shortMoney, wrapText } from './structureModel';

// Accounting > Entities (Neil, 11/17/2026: "visual representations and
// graphics that would be applicable in diagrams to explain each entity
// structure correctly"). One drawing for the whole structure and for one
// entity: the legal-chart shapes (structureModel SHAPES), owners above what
// they own with the percentage on each line, dashed lines for who manages
// an entity and who lends to it, properties under their owner. Laid out by
// structureModel.layout; drawn here in the theme's colors. Download gives an
// SVG or a PNG for a lender package, always drawn light on white.

const PRINT_VARS = {
  '--ec-ink': '#0f172a', '--ec-muted': '#64748b', '--ec-line': '#94a3b8', '--ec-bg': '#ffffff',
  '--ec-accent': '#00845a', '--ec-soft': '#e6f4ee',
};

function Shape({ n, focus }) {
  const { x, y, w, h } = n;
  const ended = ['dissolved', 'sold'].includes(n.status);
  const common = {
    fill: focus ? 'var(--ec-soft)' : 'var(--ec-bg)',
    stroke: focus ? 'var(--ec-accent)' : n.kind === 'hidden' ? 'var(--ec-line)' : 'var(--ec-ink)',
    strokeWidth: focus ? 2.2 : 1.3,
    strokeDasharray: ended || n.shape === 'unknown' || n.kind === 'hidden' || n.shape === 'group' ? '5 4' : undefined,
  };
  switch (n.shape) {
    case 'partnership':
      return <polygon points={`${x + w / 2},${y} ${x + w},${y + h} ${x},${y + h}`} {...common} />;
    case 'disregarded':
      return (
        <g>
          <rect x={x} y={y} width={w} height={h} rx={2} {...common} />
          <ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2 - 7} ry={h / 2 - 6} fill="none" stroke={common.stroke} strokeWidth={1} />
        </g>
      );
    case 'trust': {
      const c = Math.min(14, w / 4, h / 4);
      const pts = [[x + c, y], [x + w - c, y], [x + w, y + c], [x + w, y + h - c], [x + w - c, y + h], [x + c, y + h], [x, y + h - c], [x, y + c]];
      return <polygon points={pts.map((p) => p.join(',')).join(' ')} {...common} />;
    }
    case 'individual':
    case 'group':
      return <ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} {...common} />;
    case 'property':
      return <polygon points={`${x + w / 2},${y} ${x + w},${y + h * 0.34} ${x + w},${y + h} ${x},${y + h} ${x},${y + h * 0.34}`} {...common} strokeWidth={1.1} />;
    case 'lender':
      return <rect x={x} y={y} width={w} height={h} rx={14} {...common} stroke="var(--ec-muted)" strokeDasharray="2 3" />;
    default:
      return (
        <g>
          <rect x={x} y={y} width={w} height={h} rx={2} {...common} />
          {n.taxClass === 's_corp' && <text x={x + 8} y={y + 15} fontSize={FS.meta} fontWeight={700} fill="var(--ec-ink)">S</text>}
        </g>
      );
  }
}

/** Where the words sit inside a shape, and how many characters a line holds. */
function textBox(n) {
  if (n.shape === 'partnership') return { cy: n.y + n.h * 0.66, chars: 17 };
  if (n.shape === 'property') return { cy: n.y + n.h * 0.66, chars: 18 };
  if (n.shape === 'individual' || n.shape === 'group') return { cy: n.y + n.h / 2, chars: 20 };
  return { cy: n.y + n.h / 2, chars: 24 };
}

function Words({ n, focus }) {
  const { cy, chars } = textBox(n);
  const ended = ['dissolved', 'sold'].includes(n.status);
  const lines = wrapText(n.label, chars, 2);
  const sub = ended ? (n.status === 'sold' ? 'Sold' : 'Dissolved') : n.kind === 'entity' ? n.code : n.sub;
  const lineH = 14;
  const top = cy - ((lines.length + (sub ? 1 : 0)) * lineH) / 2 + 10;
  return (
    <g pointerEvents="none">
      {lines.map((l, i) => (
        <text key={i} x={n.x + n.w / 2} y={top + i * lineH} textAnchor="middle" fontSize={FS.label} fontWeight={focus ? 700 : 600} fill="var(--ec-ink)">{l}</text>
      ))}
      {sub && <text x={n.x + n.w / 2} y={top + lines.length * lineH} textAnchor="middle" fontSize={FS.meta} fill="var(--ec-muted)">{sub}</text>}
    </g>
  );
}

function Edge({ e }) {
  const d = `M ${e.points.map((p) => p.join(' ')).join(' L ')}`;
  const dashed = e.kind === 'manages' || e.kind === 'lends';
  const label = e.kind === 'owns' ? pctText(e.pct) || '%?' : e.kind === 'manages' ? (e.label || 'Manager')
    : e.kind === 'lends' ? `Loan ${shortMoney(e.balance)}${e.rate ? ` at ${Number(e.rate).toFixed(2)}%` : ''}` : '';
  return (
    <g>
      <path d={d} fill="none" stroke={dashed ? 'var(--ec-muted)' : 'var(--ec-line)'} strokeWidth={e.kind === 'holds' ? 1 : 1.3}
        strokeDasharray={dashed ? '6 4' : undefined} />
      {label && (
        <text x={e.labelAt[0]} y={e.labelAt[1]} textAnchor="middle" fontSize={FS.meta} fontWeight={e.kind === 'owns' ? 700 : 500}
          fill={e.kind === 'owns' && e.pct === null ? 'var(--ec-muted)' : 'var(--ec-ink)'}
          stroke="var(--ec-bg)" strokeWidth={4} paintOrder="stroke" strokeLinejoin="round">{label}</text>
      )}
    </g>
  );
}

function Drawing({ lay, focus, onOpen, title, svgRef }) {
  return (
    <svg ref={svgRef} xmlns="http://www.w3.org/2000/svg" viewBox={`0 0 ${lay.width} ${lay.height}`} width={lay.width} height={lay.height}
      role="img" aria-label={title} style={{ display: 'block', fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif' }}>
      <rect x={0} y={0} width={lay.width} height={lay.height} fill="var(--ec-bg)" />
      {lay.edges.filter((e) => e.kind !== 'owns').map((e, i) => <Edge key={`s${i}`} e={e} />)}
      {lay.edges.filter((e) => e.kind === 'owns').map((e, i) => <Edge key={`o${i}`} e={e} />)}
      {lay.nodes.map((n) => {
        const open = onOpen && (n.kind === 'entity' || n.kind === 'property' || n.kind === 'investor');
        return (
          <g key={n.id} className={open ? 'ent-chart-node' : undefined} role={open ? 'button' : undefined} tabIndex={open ? 0 : undefined}
            aria-label={open ? `Open ${n.label}` : undefined} style={open ? { cursor: 'pointer' } : undefined}
            onClick={open ? () => onOpen(n) : undefined}
            onKeyDown={open ? (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onOpen(n); } } : undefined}>
            <title>{[n.label, n.sub && n.sub !== n.code ? n.sub : '', n.code].filter(Boolean).join(' - ')}</title>
            <Shape n={n} focus={n.id === focus} />
            <Words n={n} focus={n.id === focus} />
          </g>
        );
      })}
    </svg>
  );
}

/** The legend: only the shapes this chart uses, each drawn small. */
export function ShapeLegend({ shapes }) {
  const used = SHAPES.filter((s) => !shapes || shapes.has(s.key));
  if (!used.length) return null;
  return (
    <div className="ent-legend" aria-label="What the shapes mean">
      {used.map((s) => {
        const n = { id: s.key, shape: s.key, kind: s.key === 'group' ? 'group' : 'entity', x: 1, y: 1, w: s.key === 'partnership' ? 30 : 28, h: s.key === 'partnership' ? 22 : 18 };
        return (
          <span key={s.key} title={s.note} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <svg width={32} height={24} aria-hidden="true" style={{ '--ec-bg': 'transparent' }}><Shape n={n} focus={false} /></svg>
            <span>{s.label}</span>
          </span>
        );
      })}
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <svg width={32} height={24} aria-hidden="true"><path d="M2 12 H30" stroke="var(--ec-muted)" strokeWidth={1.3} strokeDasharray="6 4" /></svg>
        <span>Manages or Lends</span>
      </span>
    </div>
  );
}

/**
 * <StructureChart graph={{nodes, edges}} focus="e:67000" onOpen={(node) => ...} />
 * `beside` puts lenders next to the entity (structureModel.withLenders).
 */
export default function StructureChart({ graph, focus = '', beside = {}, onOpen, title = 'Entity structure', fileName = 'entity-structure', empty = null }) {
  const lay = useMemo(() => layoutGraph(graph || { nodes: [], edges: [] }, { beside }), [graph, beside]);
  const [fit, setFit] = useState(true);
  const [printing, setPrinting] = useState('');
  const printRef = useRef(null);
  const shapes = useMemo(() => new Set(lay.nodes.map((n) => n.shape).filter(Boolean)), [lay]);

  useEffect(() => {
    if (!printing || !printRef.current) return;
    const svg = printRef.current;
    const text = new XMLSerializer().serializeToString(svg)
      .replace(/var\((--ec-[a-z]+)\)/g, (_m, v) => PRINT_VARS[v] || '#000000');
    const kind = printing;
    setPrinting('');
    if (kind === 'svg') {
      downloadBlob(`${fileName}.svg`, new Blob([text], { type: 'image/svg+xml' }));
      return;
    }
    const img = new Image();
    const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
    img.onload = () => {
      const scale = 2;
      const c = document.createElement('canvas');
      c.width = lay.width * scale;
      c.height = lay.height * scale;
      const ctx = c.getContext('2d');
      if (!ctx) { URL.revokeObjectURL(url); return; }
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob((b) => { if (b) downloadBlob(`${fileName}.png`, b); }, 'image/png');
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  }, [printing, fileName, lay]);

  if (!lay.nodes.length) return empty;
  return (
    <div className="ent-chart">
      <div className="ent-chart-bar">
        <button type="button" className="ent-link" onClick={() => setFit((f) => !f)}>{fit ? 'Actual Size' : 'Fit to Width'}</button>
        <button type="button" className="ent-link" onClick={() => setPrinting('png')}><Download size={13} aria-hidden="true" /> PNG</button>
        <button type="button" className="ent-link" onClick={() => setPrinting('svg')}><Download size={13} aria-hidden="true" /> SVG</button>
      </div>
      <div className="ent-chart-scroll">
        <div style={fit ? { width: '100%', maxWidth: lay.width } : { width: lay.width }} className="ent-chart-fit">
          <Drawing lay={lay} focus={focus} onOpen={onOpen} title={title} />
        </div>
      </div>
      <ShapeLegend shapes={shapes} />
      {printing && (
        <div aria-hidden="true" style={{ position: 'absolute', left: -99999, top: 0, ...PRINT_VARS }}>
          <Drawing lay={lay} focus={focus} title={title} svgRef={printRef} />
        </div>
      )}
    </div>
  );
}

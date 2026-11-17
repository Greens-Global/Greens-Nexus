import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, Maximize2, Minus, Plus } from 'lucide-react';
import { FS } from '../../../lib/typeScale';
import { downloadBlob } from '../reportModel';
import { SHAPES, layout as layoutGraph, pctText, shortMoney, wrapText } from './structureModel';

// Accounting > Entities - the structure chart (Neil, 11/17/2026: "world
// class enterprise grade"). Every node is a card: the entity's name, its
// code, where it was formed and how it is taxed, with the tax-chart shape
// as its glyph (triangle = partnership, rectangle = corporation, rectangle
// with an oval = disregarded, octagon = trust - backend legal_entities.
// shape_of is the one rule). Owners sit above what they own with the
// percentage where the line meets the card; dashed lines are who manages it
// and who lends to it; properties hang under their owner on a dotted line.
//
// It reads like a drawing tool: Fit, zoom (the buttons or Ctrl + scroll),
// drag the canvas to move around, and hovering a card lights its whole
// ownership chain and fades the rest. PNG / SVG downloads are drawn light on
// white for a lender package, whatever the theme.

const PRINT_VARS = {
  '--ec-ink': '#0f172a', '--ec-muted': '#5b6678', '--ec-faint': '#94a3b8', '--ec-line': '#a9b5c6', '--ec-card': '#ffffff',
  '--ec-border': '#d9e0ea', '--ec-canvas': '#ffffff', '--ec-dot': '#ffffff', '--ec-accent': '#00845a', '--ec-soft': '#ecf7f2',
  '--ec-corp': '#4560d8', '--ec-part': '#0b8f62', '--ec-disr': '#5a6f87', '--ec-trust': '#a8701a', '--ec-person': '#6b7790',
  '--ec-prop': '#0d7c8a', '--ec-lend': '#8a6a3a', '--ec-halo': '#ffffff',
};
const GLYPH_COLOR = {
  corporation: 'var(--ec-corp)', partnership: 'var(--ec-part)', disregarded: 'var(--ec-disr)', trust: 'var(--ec-trust)',
  individual: 'var(--ec-person)', group: 'var(--ec-person)', property: 'var(--ec-prop)', lender: 'var(--ec-lend)',
  unknown: 'var(--ec-faint)', hidden: 'var(--ec-faint)',
};
const TAX_WORD = { partnership: 'Partnership', disregarded: 'Disregarded', c_corp: 'C Corp', s_corp: 'S Corp', trust: 'Trust' };
const ENDED = { dissolved: 'Dissolved', sold: 'Sold' };

/** The glyph key a node draws: its tax shape, or what kind of party it is. */
const glyphOf = (n) => (n.kind === 'entity' ? n.shape || 'unknown' : n.kind === 'investor' || n.kind === 'person' ? (n.shape === 'trust' ? 'trust' : n.shape === 'partnership' || n.shape === 'corporation' ? n.shape : 'individual')
  : n.kind === 'group' ? 'group' : n.kind === 'property' ? 'property' : n.kind === 'lender' ? 'lender' : 'hidden');

/** A crisp 24 x 24 glyph at (x, y). */
export function Glyph({ g, x = 0, y = 0, s = 24, sCorp = false }) {
  const c = GLYPH_COLOR[g] || 'var(--ec-faint)';
  const p = { stroke: c, strokeWidth: 1.7, fill: c, fillOpacity: 0.13, strokeLinejoin: 'round', strokeLinecap: 'round' };
  const k = s / 24;
  let inner;
  switch (g) {
    case 'corporation':
      inner = <><rect x={2.5} y={5} width={19} height={14} rx={1.5} {...p} />{sCorp && <text x={12} y={15.5} textAnchor="middle" fontSize={9} fontWeight={700} fill={c} stroke="none">S</text>} {/* type-ok: a letter inside a 24-unit icon */}</>;
      break;
    case 'partnership':
      inner = <><path d="M12 3.5 L21.5 20 H2.5 Z" {...p} /></>;
      break;
    case 'disregarded':
      inner = <><rect x={2.5} y={5} width={19} height={14} rx={1.5} {...p} /><ellipse cx={12} cy={12} rx={6.6} ry={4.2} fill="none" stroke={c} strokeWidth={1.4} /></>;
      break;
    case 'trust':
      inner = <><path d="M8 3.5 H16 L20.5 8 V16 L16 20.5 H8 L3.5 16 V8 Z" {...p} /></>;
      break;
    case 'individual':
      inner = <><circle cx={12} cy={8.2} r={3.6} {...p} /><path d="M4.8 20 C5.6 15.6 8.4 13.6 12 13.6 C15.6 13.6 18.4 15.6 19.2 20 Z" {...p} /></>;
      break;
    case 'group':
      inner = <><circle cx={8.2} cy={9} r={3} {...p} /><circle cx={15.8} cy={9} r={3} {...p} /><path d="M2.5 19.5 C3.2 15.8 5.4 14 8.2 14 C11 14 13.2 15.8 13.9 19.5 Z" {...p} /><path d="M10.1 19.5 C10.8 15.8 13 14 15.8 14 C18.6 14 20.8 15.8 21.5 19.5 Z" {...p} /></>;
      break;
    case 'property':
      inner = <><path d="M3.5 11 L12 4 L20.5 11 V20 H3.5 Z" {...p} /><path d="M10 20 V14.5 H14 V20" fill="none" stroke={c} strokeWidth={1.4} /></>;
      break;
    case 'lender':
      inner = <><path d="M3 9 L12 4 L21 9 Z" {...p} /><path d="M5.5 10.5 V17 M9.8 10.5 V17 M14.2 10.5 V17 M18.5 10.5 V17" stroke={c} strokeWidth={1.6} /><path d="M3 19.5 H21" stroke={c} strokeWidth={1.8} /></>;
      break;
    case 'hidden':
      inner = <><rect x={5} y={10.5} width={14} height={9.5} rx={2} {...p} /><path d="M8.2 10.5 V8 A3.8 3.8 0 0 1 15.8 8 V10.5" fill="none" stroke={c} strokeWidth={1.6} /></>;
      break;
    default:
      inner = <><rect x={2.5} y={5} width={19} height={14} rx={1.5} {...p} fillOpacity={0} strokeDasharray="3 2.5" /></>;
      break;
  }
  return <g transform={`translate(${x} ${y}) scale(${k})`}>{inner}</g>;
}

function metaOf(n) {
  if (n.kind === 'entity') {
    const ended = ENDED[n.status];
    return [n.code, n.state, ended || TAX_WORD[n.taxClass] || (n.shape === 'unknown' ? 'Type not set' : '')].filter(Boolean).join('  ·  ');
  }
  if (n.kind === 'group') return 'Outside investors';
  if (n.kind === 'person') return 'Person';
  if (n.kind === 'hidden') return 'Outside your access';
  return n.sub || '';
}

function Card({ n, focus, dim, onOpen, onHover }) {
  const ended = !!ENDED[n.status];
  const open = onOpen && ['entity', 'property', 'investor'].includes(n.kind) && !focus;
  const textX = n.x + 50;
  const chars = Math.floor((n.w - 62) / 7.3);
  const lines = wrapText(n.label, chars, 2);
  const meta = metaOf(n);
  const block = lines.length * 16 + (meta ? 15 : 0);
  const top = n.y + (n.h - block) / 2 + 12;
  return (
    <g className="ent-node" data-dim={dim ? '' : undefined} opacity={ended ? 0.62 : 1}
      role={open ? 'button' : undefined} tabIndex={open ? 0 : undefined} aria-label={open ? `Open ${n.label}` : undefined}
      style={{ cursor: open ? 'pointer' : 'default' }}
      onClick={open ? () => onOpen(n) : undefined}
      onKeyDown={open ? (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onOpen(n); } } : undefined}
      onPointerEnter={() => onHover?.(n.id)} onPointerLeave={() => onHover?.(null)} onFocus={() => onHover?.(n.id)} onBlur={() => onHover?.(null)}>
      <title>{[n.label, n.kind === 'entity' ? n.sub : '', meta].filter(Boolean).join('\n')}</title>
      <rect className="ent-node-card" x={n.x} y={n.y} width={n.w} height={n.h} rx={10}
        fill={focus ? 'var(--ec-soft)' : 'var(--ec-card)'} stroke={focus ? 'var(--ec-accent)' : 'var(--ec-border)'}
        strokeWidth={focus ? 2 : 1} strokeDasharray={ended || n.kind === 'hidden' ? '5 4' : undefined} filter="url(#ec-shadow)" />
      <Glyph g={glyphOf(n)} x={n.x + 15} y={n.y + n.h / 2 - 12} sCorp={n.taxClass === 's_corp'} />
      {lines.map((l, i) => (
        <text key={i} x={textX} y={top + i * 16} fontSize={FS.body} fontWeight={600} fill="var(--ec-ink)">{l}</text>
      ))}
      {meta && (
        <text x={textX} y={top + lines.length * 16 + 1} fontSize={FS.meta} fill="var(--ec-muted)" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {meta}{n.deal && n.kind === 'entity' && <tspan fill="var(--ec-accent)" fontWeight={600}>{'  ·  Deal'}</tspan>}
        </text>
      )}
    </g>
  );
}

/** An orthogonal path with rounded corners through `pts`. */
function rounded(pts, r = 10) {
  if (pts.length < 3) return `M ${pts.map((p) => p.join(' ')).join(' L ')}`;
  let d = `M ${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i += 1) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[i + 1];
    const a = Math.min(r, Math.hypot(x1 - x0, y1 - y0) / 2, Math.hypot(x2 - x1, y2 - y1) / 2);
    if (a < 0.5) { d += ` L ${x1} ${y1}`; continue; }
    const ux = Math.sign(x1 - x0); const uy = Math.sign(y1 - y0);
    const vx = Math.sign(x2 - x1); const vy = Math.sign(y2 - y1);
    d += ` L ${x1 - ux * a} ${y1 - uy * a} Q ${x1} ${y1} ${x1 + vx * a} ${y1 + vy * a}`;
  }
  const last = pts[pts.length - 1];
  return `${d} L ${last[0]} ${last[1]}`;
}

function Edge({ e, dim }) {
  const style = e.kind === 'owns' ? { stroke: 'var(--ec-line)', strokeWidth: 1.6 }
    : e.kind === 'holds' ? { stroke: 'var(--ec-line)', strokeWidth: 1.3, strokeDasharray: '1.5 4', strokeLinecap: 'round' }
      : { stroke: e.kind === 'lends' ? 'var(--ec-lend)' : 'var(--ec-muted)', strokeWidth: 1.4, strokeDasharray: '6 5' };
  const label = e.kind === 'owns' ? pctText(e.pct) || '% not set' : e.kind === 'manages' ? (e.label || 'Manager')
    : e.kind === 'lends' ? `${shortMoney(e.balance)} loan${e.rate ? ` at ${Number(e.rate).toFixed(2)}%` : ''}` : '';
  const end = e.points[e.points.length - 1];
  return (
    <g className="ent-edge" data-dim={dim ? '' : undefined}>
      <path d={rounded(e.points)} fill="none" {...style} />
      {e.kind === 'owns' && <circle cx={end[0]} cy={end[1]} r={2.6} fill="var(--ec-line)" />}
      {label && (
        <text x={e.labelAt[0]} y={e.labelAt[1]} textAnchor="middle" fontSize={e.kind === 'owns' ? FS.label : FS.meta}
          fontWeight={e.kind === 'owns' ? 700 : 500}
          fill={e.kind === 'owns' ? (e.pct === null || e.pct === undefined ? 'var(--ec-faint)' : 'var(--ec-ink)') : 'var(--ec-muted)'}
          stroke="var(--ec-halo)" strokeWidth={5} paintOrder="stroke" strokeLinejoin="round" style={{ fontVariantNumeric: 'tabular-nums' }}>{label}</text>
      )}
    </g>
  );
}

/** Everything connected to `id` through ownership, both ways, plus its direct manager, lender and property lines. */
function chainOf(id, edges) {
  if (!id) return null;
  const keep = new Set([id]);
  const walk = (start, dir) => {
    const stack = [start];
    while (stack.length) {
      const cur = stack.pop();
      edges.forEach((e) => {
        if (e.kind !== 'owns' && e.kind !== 'holds') return;
        const next = dir === 'up' ? (e.to === cur ? e.from : null) : (e.from === cur ? e.to : null);
        if (next && !keep.has(next)) { keep.add(next); stack.push(next); }
      });
    }
  };
  walk(id, 'up');
  walk(id, 'down');
  edges.forEach((e) => { if ((e.kind === 'manages' || e.kind === 'lends') && (e.from === id || e.to === id)) { keep.add(e.from); keep.add(e.to); } });
  return keep;
}

function Drawing({ lay, focus, onOpen, title, svgRef, print = false, hover = null, onHover }) {
  const lit = useMemo(() => (print ? null : chainOf(hover, lay.edges)), [hover, lay, print]);
  const dimEdge = (e) => !!lit && !(lit.has(e.from) && lit.has(e.to));
  return (
    <svg ref={svgRef} xmlns="http://www.w3.org/2000/svg" viewBox={`0 0 ${lay.width} ${lay.height}`} width={lay.width} height={lay.height}
      role="img" aria-label={title} style={{ display: 'block', fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif' }}>
      <defs>
        <pattern id="ec-dots" width={18} height={18} patternUnits="userSpaceOnUse"><circle cx={1.5} cy={1.5} r={1.1} fill="var(--ec-dot)" /></pattern>
        <filter id="ec-shadow" x="-10%" y="-20%" width="120%" height="150%">
          <feDropShadow dx={0} dy={1} stdDeviation={1} floodColor="#0f172a" floodOpacity={0.06} />
          <feDropShadow dx={0} dy={4} stdDeviation={6} floodColor="#0f172a" floodOpacity={0.06} />
        </filter>
      </defs>
      <rect x={0} y={0} width={lay.width} height={lay.height} fill="var(--ec-canvas)" />
      {!print && <rect x={0} y={0} width={lay.width} height={lay.height} fill="url(#ec-dots)" />}
      {lay.edges.filter((e) => e.kind !== 'owns').map((e, i) => <Edge key={`s${i}`} e={e} dim={dimEdge(e)} />)}
      {lay.edges.filter((e) => e.kind === 'owns').map((e, i) => <Edge key={`o${i}`} e={e} dim={dimEdge(e)} />)}
      {lay.nodes.map((n) => <Card key={n.id} n={n} focus={n.id === focus} dim={!!lit && !lit.has(n.id)} onOpen={print ? null : onOpen} onHover={print ? null : onHover} />)}
    </svg>
  );
}

/** The legend: the glyphs this chart uses, and the three kinds of line. */
export function ShapeLegend({ shapes }) {
  const used = SHAPES.filter((s) => !shapes || shapes.has(s.key));
  return (
    <div className="ent-legend" aria-label="What the shapes mean">
      {used.map((s) => (
        <span key={s.key} title={s.note} className="ent-legend-item">
          <svg width={18} height={18} viewBox="0 0 24 24" aria-hidden="true"><Glyph g={s.key} /></svg>
          {s.label}
        </span>
      ))}
      <span className="ent-legend-item"><svg width={26} height={10} aria-hidden="true"><path d="M1 5 H25" stroke="var(--ec-line)" strokeWidth={1.6} /></svg>Owns</span>
      <span className="ent-legend-item"><svg width={26} height={10} aria-hidden="true"><path d="M1 5 H25" stroke="var(--ec-muted)" strokeWidth={1.4} strokeDasharray="6 5" /></svg>Manages or Lends</span>
    </div>
  );
}

const ZOOMS = [0.35, 0.5, 0.67, 0.8, 1, 1.25, 1.5, 2];

/**
 * <StructureChart graph={{nodes, edges}} focus="e:67000" onOpen={(node) => ...} />
 * `beside` puts lenders next to the entity (structureModel.withLenders).
 */
export default function StructureChart({ graph, focus = '', beside = {}, onOpen, title = 'Entity structure', fileName = 'entity-structure', empty = null, maxHeight = '72vh' }) {
  const lay = useMemo(() => layoutGraph(graph || { nodes: [], edges: [] }, { beside }), [graph, beside]);
  const [zoom, setZoom] = useState(null);   // null = fit to the frame's width
  const [boxW, setBoxW] = useState(0);
  const [hover, setHover] = useState(null);
  const [printing, setPrinting] = useState('');
  const frameRef = useRef(null);
  const printRef = useRef(null);
  const drag = useRef(null);
  const shapes = useMemo(() => new Set(lay.nodes.map((n) => glyphOf(n))), [lay]);

  useEffect(() => {
    const el = frameRef.current;
    if (!el) return undefined;
    const measure = () => setBoxW(el.clientWidth || 0);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [lay.nodes.length]);

  const fit = boxW ? Math.min(1, Math.max(0.3, (boxW - 2) / lay.width)) : 1;
  const scale = zoom ?? fit;
  const step = useCallback((dir) => setZoom((z) => {
    const cur = z ?? fit;
    const next = dir > 0 ? ZOOMS.find((v) => v > cur + 0.01) : [...ZOOMS].reverse().find((v) => v < cur - 0.01);
    return next ?? cur;
  }), [fit]);

  // Ctrl + scroll zooms (plain scrolling still scrolls the page).
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return undefined;
    const onWheel = (ev) => { if (!ev.ctrlKey && !ev.metaKey) return; ev.preventDefault(); step(ev.deltaY < 0 ? 1 : -1); };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [step]);

  const onPointerDown = (ev) => {
    if (ev.button !== 0 || ev.target.closest?.('.ent-node')) return;
    drag.current = { x: ev.clientX, y: ev.clientY, left: frameRef.current.scrollLeft, top: frameRef.current.scrollTop };
    frameRef.current.setPointerCapture?.(ev.pointerId);
  };
  const onPointerMove = (ev) => {
    if (!drag.current) return;
    frameRef.current.scrollLeft = drag.current.left - (ev.clientX - drag.current.x);
    frameRef.current.scrollTop = drag.current.top - (ev.clientY - drag.current.y);
  };
  const endDrag = () => { drag.current = null; };

  useEffect(() => {
    if (!printing || !printRef.current) return;
    const text = new XMLSerializer().serializeToString(printRef.current)
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
      const k = 2;
      const c = document.createElement('canvas');
      c.width = lay.width * k;
      c.height = lay.height * k;
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
  const counts = {
    entities: lay.nodes.filter((n) => n.kind === 'entity').length,
    owners: lay.nodes.filter((n) => ['person', 'investor', 'group'].includes(n.kind)).length,
  };
  return (
    <div className="ent-chart">
      <div className="ent-chart-bar">
        <span className="ent-chart-count">
          {counts.entities} {counts.entities === 1 ? 'entity' : 'entities'}{counts.owners ? `, ${counts.owners} ${counts.owners === 1 ? 'owner' : 'owners'} outside them` : ''}
        </span>
        <span className="ent-chart-tools" role="group" aria-label="Zoom">
          <button type="button" onClick={() => step(-1)} aria-label="Zoom out" title="Zoom out (Ctrl + scroll)"><Minus size={14} /></button>
          <span className="ent-chart-zoom" aria-live="polite">{Math.round(scale * 100)}%</span>
          <button type="button" onClick={() => step(1)} aria-label="Zoom in" title="Zoom in (Ctrl + scroll)"><Plus size={14} /></button>
          <button type="button" onClick={() => setZoom(null)} aria-pressed={zoom === null} title="Fit the chart to the window"><Maximize2 size={13} /> Fit</button>
        </span>
        <span className="ent-chart-tools" role="group" aria-label="Download">
          <button type="button" onClick={() => setPrinting('png')} title="Download a PNG"><Download size={13} /> PNG</button>
          <button type="button" onClick={() => setPrinting('svg')} title="Download an SVG"><Download size={13} /> SVG</button>
        </span>
      </div>
      <div ref={frameRef} className="ent-chart-frame" style={{ maxHeight }}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag}>
        <div style={{ width: lay.width * scale, height: lay.height * scale, margin: scale === fit && zoom === null ? '0 auto' : undefined }} className="ent-chart-sized">
          <div style={{ width: lay.width, height: lay.height, transform: `scale(${scale})`, transformOrigin: '0 0' }}>
            <Drawing lay={lay} focus={focus} onOpen={onOpen} title={title} hover={hover} onHover={setHover} />
          </div>
        </div>
      </div>
      <ShapeLegend shapes={shapes} />
      {printing && (
        <div aria-hidden="true" style={{ position: 'absolute', left: -99999, top: 0, ...PRINT_VARS }}>
          <Drawing lay={lay} focus={focus} title={title} svgRef={printRef} print />
        </div>
      )}
    </div>
  );
}

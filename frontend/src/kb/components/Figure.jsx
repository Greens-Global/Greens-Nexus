// Figures (Neil, 11/07/2026: "graphics and visual elements in the courses").
// A figure is a diagram drawn from DATA in the page's blocks - never an
// image file - so it is crisp at any width, follows light and dark mode,
// needs no storage and carries no license. Eight kinds, each a small shape
// (backend/kb_blocks.py FIGURE_KINDS keeps the same list):
//
//   steps     { title, caption, items: [{ label, note }] }            a flow, left to right
//   timeline  { title, caption, items: [{ at, label, note, tone }] }  what happens when
//   compare   { title, caption, columns: [{ name, note, facts: [] }] } side by side
//   sizes     { title, caption, unit, items: [{ name, w, h, note }] } rectangles to scale
//   bars      { title, caption, unit, max, items: [{ label, value, low, text, tone }] }
//   stats     { title, caption, items: [{ value, label, note }] }     the numbers that matter
//   layout    { title, caption, cols, rows, regions: [{ label, note, x, y, w, h, tone }] }
//   cycle     { title, caption, items: [{ label, note }] }            a loop
//   drawing   { title, caption, draw, label, note }                   one line drawing (drawings.jsx), large
//   drawings  { title, caption, items: [{ draw, label, note }] }      a gallery of drawings
//
// tone: '' | 'ok' (green) | 'live' (the live accent) | 'warn' (amber) | 'bad' (red)
import { ChevronRight } from 'lucide-react';
import Drawing from './drawings';

const TONE = { ok: 'var(--kb-green)', live: 'var(--wk-live, #ed631a)', warn: '#d97706', bad: '#dc2626' };
const tone = (t) => TONE[t] || '';

function Frame({ kind, title, caption, children, wide = false }) {
  return (
    <figure className={`kb-fig kb-fig--${kind}${wide ? ' wide' : ''}`} role="group" aria-label={title || kind}>
      {title && <figcaption className="kb-fig-title">{title}</figcaption>}
      <div className="kb-fig-body">{children}</div>
      {caption && <figcaption className="kb-fig-caption">{caption}</figcaption>}
    </figure>
  );
}

function Steps({ d }) {
  const items = d.items || [];
  return (
    <ol className="kb-fig-steps">
      {items.map((it, i) => (
        <li key={i}>
          <span className="kb-fig-n">{i + 1}</span>
          <span className="kb-fig-text"><b>{it.label}</b>{it.note && <span>{it.note}</span>}</span>
          {i < items.length - 1 && <span className="kb-fig-arrow" aria-hidden="true"><ChevronRight size={16} /></span>}
        </li>
      ))}
    </ol>
  );
}

function Timeline({ d }) {
  return (
    <ol className="kb-fig-timeline">
      {(d.items || []).map((it, i) => (
        <li key={i} style={tone(it.tone) ? { '--tone': tone(it.tone) } : undefined}>
          <span className="kb-fig-at">{it.at}</span>
          <span className="kb-fig-dot" aria-hidden="true" />
          <span className="kb-fig-text"><b>{it.label}</b>{it.note && <span>{it.note}</span>}</span>
        </li>
      ))}
    </ol>
  );
}

function Compare({ d }) {
  const cols = d.columns || [];
  return (
    <div className="kb-fig-compare" style={{ '--n': Math.max(1, Math.min(cols.length, 4)) }}>
      {cols.map((c, i) => (
        <div key={i} className="kb-fig-col">
          <div className="kb-fig-colname">{c.name}</div>
          {c.note && <div className="kb-fig-colnote">{c.note}</div>}
          <ul>{(c.facts || []).map((f, j) => <li key={j}>{f}</li>)}</ul>
        </div>
      ))}
    </div>
  );
}

function Sizes({ d }) {
  const items = (d.items || []).filter((it) => Number(it.w) > 0 && Number(it.h) > 0);
  const maxDim = Math.max(1, ...items.map((it) => Math.max(Number(it.w), Number(it.h))));
  const k = Math.max(4, Math.min(12, 170 / maxDim));   // pixels per unit, the biggest at most ~170px
  const unit = d.unit || 'ft';
  return (
    <div className="kb-fig-sizes">
      {items.map((it, i) => (
        <div key={i} className="kb-fig-size">
          <div className="kb-fig-box" style={{ width: Math.round(Number(it.w) * k), height: Math.round(Number(it.h) * k) }}>
            <span>{it.name || `${it.w}x${it.h}`}</span>
          </div>
          <div className="kb-fig-sizemeta"><b>{it.w} x {it.h} {unit}</b>{it.note && <span>{it.note}</span>}</div>
        </div>
      ))}
    </div>
  );
}

function Bars({ d }) {
  const items = d.items || [];
  const max = Number(d.max) > 0 ? Number(d.max) : Math.max(1, ...items.map((it) => Number(it.value) || 0));
  return (
    <div className="kb-fig-bars">
      {items.map((it, i) => {
        const v = Math.max(0, Math.min(max, Number(it.value) || 0));
        const low = it.low != null ? Math.max(0, Math.min(v, Number(it.low) || 0)) : 0;
        return (
          <div key={i} className="kb-fig-bar" style={tone(it.tone) ? { '--tone': tone(it.tone) } : undefined}>
            <span className="kb-fig-barlabel">{it.label}</span>
            <span className="kb-fig-track" aria-hidden="true"><i style={{ left: `${(low / max) * 100}%`, width: `${((v - low) / max) * 100}%` }} /></span>
            <span className="kb-fig-barval">{it.text || `${it.low != null ? `${it.low} to ` : ''}${it.value}${d.unit ? ` ${d.unit}` : ''}`}</span>
          </div>
        );
      })}
    </div>
  );
}

function Stats({ d }) {
  return (
    <dl className="kb-fig-stats">
      {(d.items || []).map((it, i) => (
        <div key={i}><dd>{it.value}</dd><dt>{it.label}{it.note && <span>{it.note}</span>}</dt></div>
      ))}
    </dl>
  );
}

function Layout({ d }) {
  const cols = Math.max(1, Math.min(24, Number(d.cols) || 12));
  const rows = Math.max(1, Math.min(24, Number(d.rows) || 8));
  return (
    <div className="kb-fig-layout" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, 34px)` }} role="img" aria-label={(d.regions || []).map((r) => r.label).join(', ')}>
      {(d.regions || []).map((r, i) => {
        const x = Math.max(1, Math.min(cols, Number(r.x) || 1));
        const y = Math.max(1, Math.min(rows, Number(r.y) || 1));
        const w = Math.max(1, Math.min(cols - x + 1, Number(r.w) || 1));
        const h = Math.max(1, Math.min(rows - y + 1, Number(r.h) || 1));
        return (
          <div key={i} className={`kb-fig-region${r.tone ? ` ${r.tone}` : ''}${h === 1 ? ' one' : ''}`} style={{ gridColumn: `${x} / span ${w}`, gridRow: `${y} / span ${h}` }}>
            <b>{r.label}</b>{r.note && <span>{r.note}</span>}
          </div>
        );
      })}
    </div>
  );
}

function Cycle({ d }) {
  const items = (d.items || []).slice(0, 8);
  const n = items.length;
  const R = 34;   // percent of the box: a node half its width wide still sits inside the box
  const pos = (i) => { const a = (-Math.PI / 2) + (2 * Math.PI * i) / n; return { x: 50 + R * Math.cos(a), y: 50 + R * Math.sin(a) }; };
  return (
    <div className="kb-fig-cycle">
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <defs><marker id="kb-fig-head" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="currentColor" /></marker></defs>
        {items.map((_, i) => {
          const a = pos(i); const b = pos((i + 1) % n);
          // a short arc from one node to the next, leaving room for the labels
          const sweep = n > 1 ? 1 : 0;
          return <path key={i} d={`M ${a.x} ${a.y} A ${R} ${R} 0 0 ${sweep} ${b.x} ${b.y}`} fill="none" stroke="currentColor" strokeWidth="1.2" markerEnd="url(#kb-fig-head)" strokeDasharray="0" />;
        })}
      </svg>
      {items.map((it, i) => { const p = pos(i); return <div key={i} className="kb-fig-node" style={{ left: `${p.x}%`, top: `${p.y}%` }}><b>{it.label}</b>{it.note && <span>{it.note}</span>}</div>; })}
    </div>
  );
}

function OneDrawing({ d }) {
  return (
    <div className="kb-fig-drawing">
      <Drawing name={d.draw} title={d.label || d.title} />
      {(d.label || d.note) && <div className="kb-fig-text" style={{ alignItems: 'center', textAlign: 'center' }}>{d.label && <b>{d.label}</b>}{d.note && <span>{d.note}</span>}</div>}
    </div>
  );
}

function Drawings({ d }) {
  return (
    <div className="kb-fig-drawings">
      {(d.items || []).map((it, i) => (
        <div key={i} className="kb-fig-draw">
          <Drawing name={it.draw} title={it.label} />
          <div className="kb-fig-text">{it.label && <b>{it.label}</b>}{it.note && <span>{it.note}</span>}</div>
        </div>
      ))}
    </div>
  );
}

const KINDS = { steps: Steps, timeline: Timeline, compare: Compare, sizes: Sizes, bars: Bars, stats: Stats, layout: Layout, cycle: Cycle, drawing: OneDrawing, drawings: Drawings };

export default function Figure({ kind, data }) {
  const Body = KINDS[kind];
  const d = data && typeof data === 'object' ? data : {};
  if (!Body) return null;
  return <Frame kind={kind} title={d.title} caption={d.caption} wide={kind === 'layout' || kind === 'compare' || kind === 'drawings'}><Body d={d} /></Frame>;
}

// Starting shapes for the editor's Add Block > Figure.
export const FIGURE_TEMPLATES = {
  steps: { title: 'How it goes', items: [{ label: 'First', note: 'what happens' }, { label: 'Then', note: '' }, { label: 'Finally', note: '' }] },
  timeline: { title: 'Day by day', items: [{ at: 'Day 1', label: 'Rent is due', tone: '' }, { at: 'Day 11', label: 'Late fee posts', tone: 'warn' }] },
  compare: { title: 'Side by side', columns: [{ name: 'Option A', facts: ['One fact', 'Another'] }, { name: 'Option B', facts: ['One fact', 'Another'] }] },
  sizes: { title: 'To scale', unit: 'ft', items: [{ name: '5x5', w: 5, h: 5, note: 'a closet' }, { name: '10x10', w: 10, h: 10, note: 'a one-bedroom apartment' }] },
  bars: { title: 'How they compare', unit: '%', max: 100, items: [{ label: 'One', value: 60 }, { label: 'Two', value: 35 }] },
  stats: { title: 'The numbers', items: [{ value: '1 in 8', label: 'households rent storage' }, { value: '85%', label: 'national occupancy' }] },
  layout: { title: 'Where things are', cols: 12, rows: 6, regions: [{ label: 'Left menu', x: 1, y: 1, w: 3, h: 6 }, { label: 'Header', x: 4, y: 1, w: 9, h: 1 }, { label: 'The page', x: 4, y: 2, w: 9, h: 5, tone: 'ok' }] },
  cycle: { title: 'Round and round', items: [{ label: 'Rent due' }, { label: 'Autopay runs' }, { label: 'Paid through' }] },
  drawing: { title: 'Measure hitch to bumper', draw: 'measure-length', label: 'The storage length', note: 'from the coupler to the rearmost thing on the back' },
  drawings: { title: 'What they look like', items: [{ draw: 'rv-class-a', label: 'Class A', note: '25 to 45 ft' }, { draw: 'rv-travel-trailer', label: 'Travel trailer', note: '12 to 35 ft, plus the tongue' }] },
};
export const FIGURE_KINDS = Object.keys(KINDS);

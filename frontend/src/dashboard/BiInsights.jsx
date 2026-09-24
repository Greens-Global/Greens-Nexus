import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  PieChart, Pie, Cell, ResponsiveContainer, Tooltip,
  BarChart, Bar, XAxis, YAxis, LabelList, CartesianGrid,
  AreaChart, Area, LineChart, Line,
  FunnelChart, Funnel, LabelList as FunnelLabelList,
  Treemap,
} from 'recharts';
import {
  RefreshCw, Download, Search, X, SlidersHorizontal, ChevronDown, ChevronRight,
  BarChartHorizontal, ChartColumn, ChartBarStacked, ChartLine, ChartArea,
  ChartPie, PieChart as PieChartIcon, Grid2x2, Funnel as FunnelIcon, Table2, Hash,
} from 'lucide-react';
import { api } from '../api';
import { SkeletonBlocks } from '../components/AsyncState';
import { navigate } from './widgets.jsx';
import DashboardGrid from './DashboardGrid';
import { compactLayout } from './useDashboards.js';

// Real per-module management metrics on a Power BI-style report canvas
// (Neil, Sep 14: "implement all those [visual types] here, so the user can
// see their dashboard in their own visual card"). Every module card carries
// the actual Power BI visualizations-pane picker (Card, Bar, Column, Stacked
// Bar, Line, Area, Pie, Donut, Treemap, Funnel, Table) - the viewer chooses
// how THEIR card renders, same as clicking a visual in Power BI's pane, and
// the choice is remembered per browser. One CategoryChart dispatcher renders
// whichever geometry is picked from the SAME underlying data (stats), using
// the more specific real shape (breakdown/trend/funnel/table) when the
// module has one and the geometry can use it. Data: GET /dashboards/insights.
const TONE_COLOR = { good: 'green', warning: 'orange', critical: 'red', neutral: 'blue' };
const TONE_LABEL = { critical: 'Critical', warning: 'Warning', good: 'Good', neutral: 'Neutral' };
const TONE_ORDER = ['critical', 'warning', 'neutral', 'good'];
const SEVERITY_RANK = { critical: 3, warning: 2, neutral: 1, good: 0 };
const C = (color) => `hsl(var(--color-${color}))`;
const CARD = { background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10 };

// Sensible starting geometry per module - the picker can always override it.
const DEFAULT_GEOMETRY = {
  tasks: 'bar', attendance: 'area', tickets: 'donut',
  knowledge_base: 'treemap', operations: 'card', documents: 'stack',
  it: 'card', construction: 'bar', asset_management: 'card',
  people: 'funnel', credential_vault: 'bar', accounting: 'card',
};

const CHART_TYPES = [
  { key: 'card', label: 'Card', Icon: Hash },
  { key: 'bar', label: 'Bar Chart', Icon: BarChartHorizontal },
  { key: 'column', label: 'Column Chart', Icon: ChartColumn },
  { key: 'stack', label: 'Stacked Bar', Icon: ChartBarStacked },
  { key: 'line', label: 'Line Chart', Icon: ChartLine },
  { key: 'area', label: 'Area Chart', Icon: ChartArea },
  { key: 'pie', label: 'Pie Chart', Icon: ChartPie },
  { key: 'donut', label: 'Donut Chart', Icon: PieChartIcon },
  { key: 'treemap', label: 'Treemap', Icon: Grid2x2 },
  { key: 'funnel', label: 'Funnel', Icon: FunnelIcon },
  { key: 'table', label: 'Table', Icon: Table2 },
];

const LS_KEY = 'nexus:bi-visual-picks';
function loadPicks() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch { return {}; }
}
function savePicks(picks) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(picks)); } catch { /* ignore */ }
}

// Customize (Pranshu, Sep 14): "same customization as we have in dashboard
// module" - reuses the personal Dashboard's own drag/resize grid engine
// (DashboardGrid.jsx - the exact component CustomDashboard.jsx uses) instead
// of a bespoke picker, so dragging a card's corner really does grow the chart
// inside it, and dragging its header really does move it. Layout persists
// per browser the same way the visual-type picks above do.
const LS_LAYOUT = 'nexus:bi-layout';
function loadLayout() {
  try { const v = JSON.parse(localStorage.getItem(LS_LAYOUT)); return Array.isArray(v) ? v : null; } catch { return null; }
}
function saveLayout(layout) {
  try { localStorage.setItem(LS_LAYOUT, JSON.stringify(layout)); } catch { /* ignore */ }
}
// Starting w/h (12-col grid, 72px rows) per module - a card with a real
// chart starts taller than a plain KPI-card module; Customize can resize
// either away from these.
// h:3 (216px) was a few pixels under what a plain-KPI module actually needs
// once its tiles wrap to a second row - header + padding eats ~62px and two
// rows of tiles want ~150px - so Item Management / IT / Asset Management got
// their bottom row sliced off by the card's own overflow:hidden (Sagar,
// Sep 14: "looks like it's cropped in between"). h:4 clears it; ModuleCard
// also scrolls rather than crops if a card is dragged smaller than its tiles.
const DEFAULT_SIZE = {
  tasks: { w: 4, h: 5 }, attendance: { w: 4, h: 5 }, tickets: { w: 4, h: 5 },
  knowledge_base: { w: 4, h: 5 }, operations: { w: 4, h: 4 }, documents: { w: 4, h: 5 },
  it: { w: 4, h: 4 }, construction: { w: 4, h: 5 }, asset_management: { w: 4, h: 4 },
  people: { w: 4, h: 5 }, credential_vault: { w: 4, h: 5 }, accounting: { w: 4, h: 4 },
};
const sizeOf = (modId) => DEFAULT_SIZE[modId] || { w: 4, h: 4 };

// Resizing has to PUSH the neighbors, not land on top of them: the grid is
// absolutely positioned, so on its own an enlarged card just overlaps whatever
// was beside it (Sagar, Sep 14 - "if I expand the size of a tile then it
// should shift other tiles dynamically without collapsing"). The card under
// the pointer is pinned exactly where the pointer put it; every other card
// keeps its column AND its width - only y moves - so neighbors slide down to
// make room and slide back up when the card shrinks again. Nothing is resized
// or dropped to make space.
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
// Same vertical gravity, no pinned card: used after a collapse/expand so the
// freed rows actually close up instead of leaving a hole under the folded
// card (Sagar, Sep 14). Columns and widths are untouched - only y moves.
function packUp(items) {
  const placed = [];
  for (const it of [...items].sort((a, b) => (a.y - b.y) || (a.x - b.x))) {
    let y = 0;
    while (placed.some(p => overlaps({ ...it, y }, p))) y++;
    placed.push({ ...it, y });
  }
  return items.map(it => placed.find(p => p.i === it.i) || it);
}
function resolveAround(items, anchorId) {
  const anchor = items.find(it => it.i === anchorId);
  if (!anchor) return compactLayout(items);
  const placed = [anchor];
  const rest = items.filter(it => it.i !== anchorId).sort((a, b) => (a.y - b.y) || (a.x - b.x));
  for (const it of rest) {
    let y = 0;
    while (placed.some(p => overlaps({ ...it, y }, p))) y++;
    placed.push({ ...it, y });
  }
  return items.map(it => placed.find(p => p.i === it.i) || it);
}
function defaultLayoutFor(modules) {
  return compactLayout(modules.map(m => ({ i: m.id, x: 0, y: 0, ...sizeOf(m.id) })));
}

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
function downloadCsv(name, rows) {
  const text = rows.map(r => r.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function worstTone(mod) {
  let best = null, rank = -1;
  for (const s of mod.stats || []) {
    const r = SEVERITY_RANK[s.tone] ?? 0;
    if (r > rank) { rank = r; best = s.tone; }
  }
  return best || 'neutral';
}
function matchesFilters(stat, tone, query) {
  if (tone !== 'all' && stat.tone !== tone) return false;
  if (query && !stat.label.toLowerCase().includes(query)) return false;
  return true;
}

// ── Rectangular slicer button grid (flat, Power BI report filter style) ──
function SlicerGrid({ options, isActive, onPick, cols = 2 }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 4 }}>
      {options.map(opt => {
        const active = isActive(opt.value);
        return (
          <button key={opt.value} onClick={() => onPick(opt.value)}
            style={{
              fontSize: 11, fontWeight: 600, padding: '7px 8px', borderRadius: 6, cursor: 'pointer',
              border: `1px solid ${active ? 'var(--ink)' : 'var(--line)'}`,
              background: active ? 'var(--ink)' : 'var(--card)',
              color: active ? 'var(--paper)' : 'var(--ink)',
              display: 'flex', alignItems: 'center', gap: 5, textAlign: 'left', minWidth: 0,
            }}>
            {opt.dot && <span style={{ width: 6, height: 6, borderRadius: 99, background: active ? 'var(--paper)' : opt.dot, flexShrink: 0 }} />}
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ── The Power BI "Visualizations pane" picker, collapsed to one button ──
// Eleven always-visible icons filled the whole card header and ran straight
// over the module title (Sagar, Sep 14). The trigger now shows the CURRENT
// visual's own icon and opens the full list on click, so the title gets the
// header back. The menu is position:fixed off the button's rect because the
// card itself is overflow:hidden inside its grid cell and would clip it.
function VisualPicker({ value, onPick }) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState(null);
  const btnRef = useRef(null);
  const current = CHART_TYPES.find(t => t.key === value) || CHART_TYPES[0];

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('pointerdown', close);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [open]);

  const toggle = (e) => {
    e.stopPropagation();
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setRect(r);
    setOpen(o => !o);
  };

  return (
    <>
      <button ref={btnRef} onPointerDown={e => e.stopPropagation()} onClick={toggle}
        title={`Visual: ${current.label}`}
        style={{
          height: 24, padding: '0 5px', display: 'inline-flex', alignItems: 'center', gap: 3,
          borderRadius: 5, cursor: 'pointer', flexShrink: 0,
          border: `1px solid ${open ? 'var(--wk-brand)' : 'var(--line)'}`,
          background: open ? 'var(--wk-brand-tint)' : 'var(--card)',
          color: open ? 'var(--wk-brand)' : 'var(--muted)',
        }}>
        <current.Icon size={13} />
        <ChevronDown size={11} />
      </button>
      {open && rect && (
        <div onPointerDown={e => e.stopPropagation()}
          style={{
            ...CARD, position: 'fixed', zIndex: 1500, width: 170, padding: 4,
            top: Math.min(rect.bottom + 6, window.innerHeight - 340),
            left: Math.max(8, Math.min(rect.right - 170, window.innerWidth - 178)),
            maxHeight: 330, overflowY: 'auto', boxShadow: 'var(--shadow-md)',
          }}>
          {CHART_TYPES.map(t => {
            const active = t.key === value;
            return (
              <button key={t.key} onClick={() => { onPick(t.key); setOpen(false); }}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '7px 9px',
                  borderRadius: 6, border: 'none', cursor: 'pointer', textAlign: 'left', fontSize: 12,
                  fontWeight: active ? 700 : 600,
                  background: active ? 'var(--wk-brand-tint)' : 'none',
                  color: active ? 'var(--wk-brand)' : 'var(--ink)',
                }}>
                <t.Icon size={13} style={{ flexShrink: 0 }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}

// ── Right-rail section that folds away (Sagar, Sep 14) - the rail carries
// three stacked blocks and on a short screen you scroll past the filters to
// reach Needs Attention. Open/closed is remembered per browser, alongside the
// visual picks and the layout. ──
const LS_RAIL = 'nexus:bi-rail-open';
function loadRail() {
  try { return JSON.parse(localStorage.getItem(LS_RAIL) || '{}'); } catch { return {}; }
}
function RailSection({ id, title, open, onToggle, children }) {
  return (
    <div>
      <button onClick={() => onToggle(id)} aria-expanded={open}
        style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 5, padding: 0, marginBottom: open ? 6 : 0,
          background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left',
          fontSize: 10.5, fontWeight: 800, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {title}
      </button>
      {open && children}
    </div>
  );
}

// ── Plain "Card" / "Multi-row card" visual ──
function KpiCard({ stat, onClick }) {
  const color = TONE_COLOR[stat.tone] || 'blue';
  return (
    <div onClick={onClick ? () => onClick(stat) : undefined}
      style={{ ...CARD, background: `hsla(var(--color-${color}), 0.10)`, border: `1px solid hsla(var(--color-${color}), 0.25)`, padding: '12px 14px', minWidth: 0, cursor: onClick ? 'pointer' : 'default' }}>
      <div style={{ fontSize: 24, fontWeight: 800, color: C(color), fontVariantNumeric: 'tabular-nums', lineHeight: 1.1 }}>{stat.value}</div>
      <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--muted)', marginTop: 4 }}>{stat.label}</div>
    </div>
  );
}
function KpiCardRow({ rows, onClick }) {
  if (!rows.length) return null;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(104px, 1fr))', gap: 8, alignContent: 'start' }}>
      {rows.map(s => <KpiCard key={s.label} stat={s} onClick={onClick} />)}
    </div>
  );
}

// ── Generic table visual ──
function StatsTable({ rows, columns, fill = false }) {
  if (!rows.length) return <div style={{ fontSize: 12, color: 'var(--muted)' }}>No data.</div>;
  const cols = columns || ['label', 'value'];
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 6, overflow: 'hidden', ...(fill ? { height: '100%', display: 'flex', flexDirection: 'column' } : {}) }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 10px', background: 'var(--mist)', fontSize: 10.5, fontWeight: 800, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.3, flexShrink: 0 }}>
        {cols.map(c => <span key={c}>{c === 'label' ? 'Metric' : c === 'value' ? 'Value' : c === 'detail' ? 'Detail' : c}</span>)}
      </div>
      <div style={fill ? { flex: 1, minHeight: 0, overflow: 'auto' } : { maxHeight: 168, overflow: 'auto' }}>
        {rows.map((r, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '7px 10px', borderTop: i ? '1px solid var(--line)' : 'none', fontSize: 12 }}>
            <span title={String(r[cols[0]] ?? '')} style={{ fontWeight: 600, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r[cols[0]]}</span>
            <span title={String(r[cols[1]] ?? '')} style={{ fontWeight: 700, color: r.tone ? C(TONE_COLOR[r.tone] || 'blue') : 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r[cols[1]]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Bar / Column (same geometry, transposed) ──
// Recharts clips category-axis text at the axis's own pixel width with no
// ellipsis and no wrap - a name/email longer than that width was rendering
// cut off mid-character (the "!@greensstorage.com" report: that's the tail
// end of a longer address, sliced by the SVG viewport, not bad data).
// Truncate deliberately instead, with the full value in a native <title> so
// hovering still shows it, and render in --ink (not --muted) at a readable
// weight/size so it isn't just low-contrast gray.
function makeTruncatingTick(pixelWidth) {
  const maxChars = Math.max(6, Math.floor(pixelWidth / 6.4));
  return function Tick({ x, y, payload }) {
    const full = String(payload.value);
    const text = full.length > maxChars ? full.slice(0, maxChars - 1) + '…' : full;
    return (
      <g transform={`translate(${x},${y})`}>
        <title>{full}</title>
        <text x={-6} y={0} dy={4} textAnchor="end" fontSize={11.5} fontWeight={600} fill="var(--ink)">{text}</text>
      </g>
    );
  };
}

function BarGeom({ data, vertical, onBarClick, labelWidth = 150, height }) {
  const h = height ?? (vertical ? Math.max(90, data.length * 30) : 180);
  return (
    <ResponsiveContainer width="100%" height={h}>
      <BarChart data={data} layout={vertical ? 'vertical' : 'horizontal'}
        margin={vertical ? { top: 2, right: 30, left: 0, bottom: 2 } : { top: 6, right: 8, left: 0, bottom: 24 }}
        barCategoryGap={9}>
        {vertical ? (
          <YAxis type="category" dataKey="label" width={labelWidth} tick={makeTruncatingTick(labelWidth - 14)} axisLine={false} tickLine={false} />
        ) : (
          <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'var(--muted)' }} axisLine={false} tickLine={false} interval={0} angle={-25} textAnchor="end" height={50} />
        )}
        {vertical ? <XAxis type="number" hide /> : <YAxis tick={{ fontSize: 10.5, fill: 'var(--muted)' }} axisLine={false} tickLine={false} width={32} allowDecimals={false} />}
        <Tooltip cursor={{ fill: 'var(--mist)' }} contentStyle={{ fontSize: 12, borderRadius: 6 }} />
        <Bar dataKey="value" radius={vertical ? [0, 4, 4, 0] : [4, 4, 0, 0]} barSize={vertical ? 13 : 28} isAnimationActive={false}
          onClick={onBarClick ? (d) => onBarClick(d?.payload) : undefined} cursor={onBarClick ? 'pointer' : 'default'}>
          {data.map((d, i) => <Cell key={i} fill={d.fill} />)}
          {vertical && <LabelList dataKey="value" position="right" style={{ fontSize: 11, fontWeight: 700, fill: 'var(--ink)' }} />}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

// ── Stacked bar (single segmented bar + legend) ──
function StackedBarGeom({ data }) {
  const total = data.reduce((a, d) => a + d.value, 0);
  if (!total) return null;
  return (
    <div>
      <div style={{ display: 'flex', height: 24, borderRadius: 5, overflow: 'hidden' }}>
        {data.map(d => <div key={d.label} title={`${d.label}: ${d.value}`} style={{ width: `${(d.value / total) * 100}%`, background: d.fill, minWidth: d.value ? 3 : 0 }} />)}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 9 }}>
        {data.map(d => (
          <div key={d.label} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
            <span style={{ width: 7, height: 7, borderRadius: 99, background: d.fill, flexShrink: 0 }} />
            <span style={{ color: 'var(--muted)', fontWeight: 600 }}>{d.label}</span>
            <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{d.value}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Line / Area ──
function LineAreaGeom({ data, area, height = 160 }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      {area ? (
        <AreaChart data={data} margin={{ top: 6, right: 8, left: 0, bottom: 2 }}>
          <defs>
            <linearGradient id="bi-area-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={C('blue')} stopOpacity={0.35} />
              <stop offset="100%" stopColor={C('blue')} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--line)" />
          <XAxis dataKey="label" tick={{ fontSize: 10.5, fill: 'var(--muted)' }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fontSize: 10.5, fill: 'var(--muted)' }} axisLine={false} tickLine={false} width={32} allowDecimals={false} />
          <Tooltip contentStyle={{ fontSize: 12, borderRadius: 6 }} />
          <Area type="monotone" dataKey="value" stroke={C('blue')} strokeWidth={2} fill="url(#bi-area-fill)" isAnimationActive={false} />
        </AreaChart>
      ) : (
        <LineChart data={data} margin={{ top: 6, right: 8, left: 0, bottom: 2 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--line)" />
          <XAxis dataKey="label" tick={{ fontSize: 10.5, fill: 'var(--muted)' }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fontSize: 10.5, fill: 'var(--muted)' }} axisLine={false} tickLine={false} width={32} allowDecimals={false} />
          <Tooltip contentStyle={{ fontSize: 12, borderRadius: 6 }} />
          <Line type="monotone" dataKey="value" stroke={C('blue')} strokeWidth={2.5} dot={{ r: 3 }} isAnimationActive={false} />
        </LineChart>
      )}
    </ResponsiveContainer>
  );
}

// ── Pie / Donut ──
function PieGeom({ data, donut, fill = false }) {
  const total = data.reduce((a, d) => a + d.value, 0);
  if (!total) return null;
  const size = 96;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, height: fill ? '100%' : 'auto' }}>
      <div style={{ width: size, height: size, flexShrink: 0 }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={data} dataKey="value" nameKey="label" innerRadius={donut ? size * 0.29 : 0} outerRadius={size * 0.46} paddingAngle={2} stroke="none" isAnimationActive={false}>
              {data.map(d => <Cell key={d.label} fill={d.fill} />)}
            </Pie>
            <Tooltip formatter={(v, n) => [v, n]} contentStyle={{ fontSize: 12, borderRadius: 6 }} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6, ...(fill ? { height: '100%', overflow: 'auto' } : {}) }}>
        {data.map(d => (
          <div key={d.label} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, flexShrink: 0 }}>
            <span style={{ width: 8, height: 8, borderRadius: 99, flexShrink: 0, background: d.fill }} />
            <span style={{ color: 'var(--muted)', fontWeight: 600, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.label}</span>
            <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{d.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Treemap ──
function TreemapGeom({ data, height = 140 }) {
  const rows = data.filter(d => d.value > 0);
  if (!rows.length) return null;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <Treemap data={rows} dataKey="value" nameKey="label" stroke="var(--card)" isAnimationActive={false}
        content={({ x, y, width, height, name, value, fill }) => (
          <g>
            <rect x={x} y={y} width={width} height={height} fill={fill} rx={4} />
            {width > 46 && height > 24 && (
              <>
                <text x={x + 8} y={y + 18} fontSize={11} fontWeight={700} fill="#fff">{name}</text>
                <text x={x + 8} y={y + 32} fontSize={13} fontWeight={800} fill="#fff">{value}</text>
              </>
            )}
          </g>
        )}>
        {rows.map(d => <Cell key={d.label} fill={d.fill} />)}
      </Treemap>
    </ResponsiveContainer>
  );
}

// ── Funnel ──
function FunnelGeom({ data, height = 180 }) {
  if (!data.length || !data.some(d => d.value > 0)) return null;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <FunnelChart>
        <Tooltip contentStyle={{ fontSize: 12, borderRadius: 6 }} />
        <Funnel dataKey="value" data={data} nameKey="label" isAnimationActive={false}>
          {data.map(d => <Cell key={d.label} fill={d.fill} />)}
          <FunnelLabelList position="right" dataKey="label" style={{ fontSize: 11, fill: 'var(--ink)', fontWeight: 600 }} />
          <FunnelLabelList position="center" dataKey="value" style={{ fontSize: 12, fill: '#fff', fontWeight: 800 }} />
        </Funnel>
      </FunnelChart>
    </ResponsiveContainer>
  );
}

const FUNNEL_PALETTE = ['blue', 'purple', 'gold', 'orange', 'green'];

// The dispatcher: one geometry key, the right data source for it (preferring
// the module's real shaped data - breakdown/trend/funnel/table - over the
// generic stats list when the chosen visual can use it), one render path.
function CategoryChart({ geometry, mod, stats, onDrill }) {
  const tinted = (rows) => rows.map(d => ({ ...d, fill: C(TONE_COLOR[d.tone] || 'blue') }));
  const drill = onDrill ? (datum) => datum?.key && onDrill(mod.id, datum.key, datum.label) : undefined;
  switch (geometry) {
    case 'card':
      return <KpiCardRow rows={stats} onClick={drill ? (s) => drill(s) : undefined} />;
    case 'table': {
      if (mod.table?.length) return <StatsTable rows={mod.table.map(r => ({ label: r.employee, value: r.device }))} columns={['label', 'value']} fill />;
      return <StatsTable rows={stats.map(s => ({ label: s.label, value: s.value, tone: s.tone }))} fill />;
    }
    case 'bar':
      return <BarGeom data={tinted(stats)} vertical onBarClick={drill} height="100%" />;
    case 'column':
      return <BarGeom data={tinted(stats)} vertical={false} onBarClick={drill} height="100%" />;
    case 'stack':
      return <StackedBarGeom data={tinted(mod.breakdown?.length ? mod.breakdown : stats)} />;
    case 'line':
      return <LineAreaGeom data={mod.trend?.length ? mod.trend : stats} area={false} height="100%" />;
    case 'area':
      return <LineAreaGeom data={mod.trend?.length ? mod.trend : stats} area height="100%" />;
    case 'pie':
      return <PieGeom data={tinted(mod.breakdown?.length ? mod.breakdown : stats)} donut={false} fill />;
    case 'donut':
      return <PieGeom data={tinted(mod.breakdown?.length ? mod.breakdown : stats)} donut fill />;
    case 'treemap':
      return <TreemapGeom data={tinted(mod.breakdown?.length ? mod.breakdown : stats)} height="100%" />;
    case 'funnel': {
      const src = mod.funnel?.length ? mod.funnel : stats;
      const withFill = src.map((d, i) => ({ ...d, fill: d.tone ? C(TONE_COLOR[d.tone]) : C(FUNNEL_PALETTE[i % FUNNEL_PALETTE.length]) }));
      return <FunnelGeom data={withFill} height="100%" />;
    }
    default:
      return null;
  }
}

// ── KPI ribbon: flat colored blocks, one per alert level, page-wide total ──
function Ribbon({ modules }) {
  const totals = { critical: 0, warning: 0, neutral: 0, good: 0 };
  let counted = 0;
  for (const mod of modules) for (const s of mod.stats || []) {
    if (typeof s.value !== 'number') continue;
    totals[s.tone] = (totals[s.tone] || 0) + s.value;
    counted++;
  }
  if (!counted) return null;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8 }}>
      {TONE_ORDER.map(tone => (
        <div key={tone} style={{ ...CARD, background: `hsla(var(--color-${TONE_COLOR[tone]}), 0.12)`, border: `1px solid hsla(var(--color-${TONE_COLOR[tone]}), 0.25)`, padding: '12px 14px' }}>
          <div style={{ fontSize: 24, fontWeight: 800, color: C(TONE_COLOR[tone]), fontVariantNumeric: 'tabular-nums', lineHeight: 1.1 }}>{totals[tone].toLocaleString()}</div>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', marginTop: 3 }}>{TONE_LABEL[tone]} Signals</div>
        </div>
      ))}
    </div>
  );
}

// Fills its DashboardGrid cell (height:100%, real drag/resize from Customize
// - see DEFAULT_SIZE/defaultLayoutFor above) as a flex column: fixed header,
// then a chart area that actually grows/shrinks with the card, same as every
// widget on the personal Dashboard fills its own grid cell.
function ModuleCard({ mod, tone, query, geometry, onGeometry, onDrill, collapsed, onToggleCollapse }) {
  const stats = (mod.stats || []).filter(s => matchesFilters(s, tone, query));
  const hasAny = stats.length || mod.breakdown?.length || mod.trend?.length || mod.funnel?.length || mod.table?.length;
  if (!hasAny) return null;

  const exportCard = () => {
    const rows = [['Metric', 'Value', 'Alert Level']];
    stats.forEach(s => rows.push([s.label, s.value, TONE_LABEL[s.tone] || s.tone]));
    downloadCsv(`bi-${mod.id}.csv`, rows);
  };

  return (
    <div style={{ ...CARD, padding: 16, borderLeft: `3px solid ${C(TONE_COLOR[worstTone(mod)])}`, height: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, marginBottom: collapsed ? 0 : 10, flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: 1 }}>
          <button onClick={onToggleCollapse} title={collapsed ? 'Expand' : 'Collapse'}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 0, flexShrink: 0, pointerEvents: 'auto' }}>
            {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          </button>
          {/* Title Case at a readable size and free to use the width the
              picker gave back; it ellipsizes (with the full name on hover)
              instead of colliding with the controls the way the old
              uppercase, never-shrinking label did. */}
          <div title={mod.label}
            style={{ fontSize: 13.5, fontWeight: 800, color: 'var(--ink)', letterSpacing: 0.1, cursor: mod.nav ? 'pointer' : 'default', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            onClick={() => mod.nav && navigate(mod.nav)}>
            {mod.label}
          </div>
        </div>
        {!collapsed && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <VisualPicker value={geometry} onPick={g => onGeometry(mod.id, g)} />
            {stats.length > 0 && (
              <button onClick={exportCard} title="Download this card as CSV"
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 2, flexShrink: 0 }}>
                <Download size={13} />
              </button>
            )}
          </div>
        )}
      </div>

      {!collapsed && (
        <>
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column',
            overflowY: geometry === 'card' || geometry === 'table' ? 'auto' : 'hidden' }}>
            <CategoryChart geometry={geometry} mod={mod} stats={stats} onDrill={onDrill} />
          </div>

          {geometry !== 'card' && stats.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--line)', flexShrink: 0 }}>
              {stats.map(s => (
                <div key={s.key} onClick={onDrill ? () => onDrill(mod.id, s.key, s.label) : undefined}
                  style={{ cursor: onDrill ? 'pointer' : 'default' }}>
                  <div style={{ fontSize: 16, fontWeight: 800, color: C(TONE_COLOR[s.tone] || 'blue'), fontVariantNumeric: 'tabular-nums' }}>{s.value}</div>
                  <div style={{ fontSize: 10.5, color: 'var(--muted)', fontWeight: 600 }}>{s.label}</div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Drill-down modal: "click Open, see who" (Pranshu, Sep 14) - the real
// employee-level breakdown behind whichever bar/tile was clicked, from
// GET /dashboards/insights/drilldown. Not every metric has one (there's no
// "who" for SSL Expiring) - a 404 shows a plain explanation instead of an
// empty chart pretending to be real data. ──
function DrilldownModal({ request, onClose }) {
  const [state, setState] = useState({ loading: true, kind: 'by_person', rows: [], title: '', error: '' });
  useEffect(() => {
    let alive = true;
    setState({ loading: true, kind: 'by_person', rows: [], title: '', error: '' });
    api.dashInsightsDrilldown(request.moduleId, request.metric)
      .then(r => { if (alive) setState({ loading: false, kind: r.kind || 'by_person', rows: r.rows || [], title: r.title || request.label, error: '' }); })
      .catch(e => { if (alive) setState({ loading: false, kind: 'by_person', rows: [], title: request.label, error: e?.message || 'No breakdown available for this metric yet.' }); });
    return () => { alive = false; };
  }, [request.moduleId, request.metric]);

  // "by_person" rows are {label, value} - a real count per person, charted.
  // "list" rows are {label, detail} - the affected records themselves (no
  // "who" for e.g. a down website), shown as a plain list, not faked into bars.
  const barData = state.kind === 'by_person' ? state.rows.map(r => ({ ...r, fill: C('blue') })) : [];

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div onClick={e => e.stopPropagation()} className="bi-modal" style={{ ...CARD, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px', borderBottom: '1px solid var(--line)' }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--ink)' }}>{state.title || request.label}</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={16} /></button>
        </div>
        <div style={{ padding: 18, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'auto' }}>
          {state.loading ? (
            <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Loading…</div>
          ) : state.error ? (
            <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{state.error}</div>
          ) : !state.rows.length ? (
            <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Nothing currently matches this metric.</div>
          ) : state.kind === 'list' ? (
            <StatsTable rows={state.rows} columns={['label', 'detail']} fill />
          ) : (
            <BarGeom data={barData} vertical labelWidth={220} />
          )}
        </div>
      </div>
    </div>
  );
}

// ── Live feed of every critical/warning metric across every module
// (unaffected by the module picker) - drill-in list. Lives in the RIGHT rail
// under the filters (Sagar, Sep 14: "why it's in bottom, it should be in
// right side"), so it stays on screen beside the cards instead of sitting
// below a full board you have to scroll past. This reverses Pranshu's
// Sep 14 "bring Needs Attention below modules" - it is a one-line move of
// <AttentionFeed/> between the two columns if that needs to go back. ──
function AttentionFeed({ modules, onPick, open, onToggle }) {
  const rows = [];
  for (const mod of modules) for (const s of mod.stats || []) {
    if ((s.tone === 'critical' || s.tone === 'warning') && typeof s.value === 'number' && s.value > 0) {
      rows.push({ ...s, moduleId: mod.id, moduleLabel: mod.label });
    }
  }
  rows.sort((a, b) => (SEVERITY_RANK[b.tone] - SEVERITY_RANK[a.tone]) || (b.value - a.value));
  return (
    <div style={{ ...CARD, padding: 14 }}>
      <button onClick={() => onToggle('attention')} aria-expanded={open}
        style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 5, padding: 0, marginBottom: open ? 10 : 0,
          background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left',
          fontSize: 11.5, fontWeight: 800, color: 'var(--ink)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        Needs Attention
        {!open && rows.length > 0 && (
          <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 800, color: C('red'), fontVariantNumeric: 'tabular-nums' }}>{rows.length}</span>
        )}
      </button>
      {!open ? null : rows.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>Nothing needs attention right now.</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 6, maxHeight: 360, overflowY: 'auto' }}>
          {rows.map((r, i) => (
            <button key={i} onClick={() => onPick(r.moduleId)} className="bi-feed-row"
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', border: '1px solid var(--line)', borderRadius: 7, background: 'none', cursor: 'pointer', textAlign: 'left' }}>
              <span style={{ width: 6, height: 6, borderRadius: 99, background: C(TONE_COLOR[r.tone]), flexShrink: 0 }} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.label}</div>
                <div style={{ fontSize: 10, color: 'var(--muted)' }}>{r.moduleLabel}</div>
              </div>
              <div style={{ fontSize: 12.5, fontWeight: 800, color: C(TONE_COLOR[r.tone]), fontVariantNumeric: 'tabular-nums' }}>{r.value}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function BiInsights() {
  const [state, setState] = useState({ loading: true, modules: [], at: '' });
  const [layout, setLayoutState] = useState(null);   // [{i,x,y,w,h}] - null until modules are known
  const [editing, setEditing] = useState(false);
  const [tone, setTone] = useState('all');
  const [query, setQuery] = useState('');
  const [picks, setPicks] = useState(loadPicks);
  const [railOpen, setRailOpen] = useState(() => ({ tone: true, modules: true, attention: true, ...loadRail() }));
  const [drillRequest, setDrillRequest] = useState(null);
  const alive = useRef(true);
  const onDrill = (moduleId, metric, label) => setDrillRequest({ moduleId, metric, label });

  const setLayout = (next) => { setLayoutState(next); saveLayout(next); };
  const toggleRail = (id) => setRailOpen(prev => {
    const next = { ...prev, [id]: !prev[id] };
    try { localStorage.setItem(LS_RAIL, JSON.stringify(next)); } catch { /* ignore */ }
    return next;
  });

  const load = useCallback(async () => {
    try {
      const r = await api.dashInsights();
      if (!alive.current) return;
      const modules = r.modules || [];
      setState({ loading: false, modules, at: r.at || '' });
      setLayoutState(prev => {
        if (prev) return prev;
        const saved = loadLayout();
        const known = saved ? saved.filter(it => modules.some(m => m.id === it.i)) : null;
        return known && known.length ? known : defaultLayoutFor(modules);
      });
    } catch {
      if (alive.current) setState(s => ({ ...s, loading: false }));
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    load();
    const t = setInterval(load, 30000);
    return () => { alive.current = false; clearInterval(t); };
  }, [load]);

  const setGeometry = (modId, g) => setPicks(prev => {
    const next = { ...prev, [modId]: g };
    savePicks(next);
    return next;
  });
  const geometryFor = (modId) => picks[modId] || DEFAULT_GEOMETRY[modId] || 'bar';

  const safeLayout = layout || [];
  const visibleIds = new Set(safeLayout.map(it => it.i));
  const q = query.trim().toLowerCase();
  const moduleFiltered = useMemo(
    () => safeLayout.map(it => state.modules.find(m => m.id === it.i)).filter(Boolean),
    [safeLayout, state.modules]
  );
  const hiddenModules = state.modules.filter(m => !visibleIds.has(m.id));

  // Toggle a card on/off - same job DashboardGrid's own remove(X) does in
  // edit mode, but also reachable from the sidebar list and from "Needs
  // Attention" without entering Customize first.
  const toggleModule = (id) => {
    if (visibleIds.has(id)) { setLayout(compactLayout(safeLayout.filter(it => it.i !== id))); return; }
    // Append, then bin-pack. Dropping the card at {x:0, y:maxY} and leaving it
    // there is why re-checking modules gave every one of them a row to itself
    // (Sagar, Sep 14 - uncheck all, tick a few back, one tile per row);
    // compactLayout pulls each new card up into the first free slot instead.
    const maxY = safeLayout.reduce((m, it) => Math.max(m, it.y + it.h), 0);
    setLayout(compactLayout([...safeLayout, { i: id, x: 0, y: maxY, ...sizeOf(id) }]));
  };
  const pickOnly = (id) => {
    const existing = safeLayout.find(it => it.i === id);
    setLayout([existing || { i: id, x: 0, y: 0, ...sizeOf(id) }]);
  };
  const resetLayout = () => setLayout(defaultLayoutFor(state.modules));

  // Collapse: shrink a card to just its header (h:1), remembering the height
  // to restore on expand. Stored on the layout item itself so it persists
  // the same way position/size do.
  const toggleCollapse = (id) => {
    setLayout(packUp(safeLayout.map(it => {
      if (it.i !== id) return it;
      return it.collapsed
        ? { ...it, collapsed: false, h: it.prevH || sizeOf(id).h }
        : { ...it, collapsed: true, prevH: it.h, h: 1 };
    })));
  };

  const exportAll = () => {
    const rows = [['Module', 'Metric', 'Value', 'Alert Level']];
    moduleFiltered.forEach(mod => (mod.stats || []).filter(s => matchesFilters(s, tone, q))
      .forEach(s => rows.push([mod.label, s.label, s.value, TONE_LABEL[s.tone] || s.tone])));
    downloadCsv('business-intelligence.csv', rows);
  };

  return (
    <div style={{ animation: 'fadeIn var(--transition-normal) ease-in-out' }}>
      <style>{`
        .bi-feed-row:hover { background: var(--mist); }
        /* Drill-down dialog: 60% of the viewport in both directions on
           desktop (Sagar, Sep 14). Below that a 60% box is too small to read,
           so narrow screens get most of the width and a taller sheet. */
        .bi-modal { width: 60vw; height: 60vh; }
        @media (max-width: 900px) {
          .bi-modal { width: 92vw; height: 80vh; }
        }
        @media (max-width: 1080px) {
          .bi-layout { flex-direction: column !important; }
          .bi-layout > aside { width: 100% !important; max-height: none !important; }
        }
      `}</style>

      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 16, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: 'var(--ink)' }}>Business Intelligence</h2>
          <p style={{ margin: '3px 0 0', fontSize: 12.5, color: 'var(--muted)' }}>
            {editing
              ? "Drag a card's header to move it, or its bottom-right corner to resize its width and height together."
              : <>Real-time KPIs across every module{state.at ? ` · updated ${new Date(state.at).toLocaleTimeString()}` : ''} · drag any card's bottom-right corner to resize it</>}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {editing && hiddenModules.length > 0 && (
            <div style={{ position: 'relative' }}>
              <select value="" onChange={e => e.target.value && toggleModule(e.target.value)}
                className="form-input" style={{ fontSize: 12.5, fontWeight: 600, padding: '6px 28px 6px 10px', width: 'auto' }}>
                <option value="" disabled>+ Add card…</option>
                {hiddenModules.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            </div>
          )}
          {editing && (
            <button className="secondary-btn" onClick={resetLayout} style={{ fontSize: 12.5, fontWeight: 600 }}>Reset layout</button>
          )}
          <button className="secondary-btn" onClick={() => setEditing(e => !e)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600 }}>
            {editing ? <><X size={14} /> Done</> : <><SlidersHorizontal size={14} /> Customize</>}
          </button>
          <button className="secondary-btn" onClick={exportAll} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600 }}><Download size={13} /> Export</button>
          <button className="secondary-btn" onClick={load} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600 }}><RefreshCw size={13} /> Refresh</button>
        </div>
      </div>

      {state.loading ? (
        <div style={{ padding: '8px 0' }}><SkeletonBlocks count={4} height={190} /></div>
      ) : (
        <div className="bi-layout" style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>

          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ marginBottom: 14 }}><Ribbon modules={moduleFiltered} /></div>
            {/* Same drag/resize grid engine the personal Dashboard's own
                Customize mode uses (DashboardGrid.jsx) - drag a card's header
                to move it, drag its SE corner to resize it, both snap to a
                12-column grid. Auto-saves on every change (no separate Save
                step - this board has no backend view, just localStorage). */}
            <DashboardGrid
              layout={safeLayout}
              editing={editing}
              onLayoutChange={setLayout}
              onRemove={toggleModule}
              limitsFor={() => ({ minW: 3, minH: 2, maxW: 12, maxH: 10 })}
              resolveLayout={resolveAround}
              alwaysResizable
              renderWidget={(it) => {
                const mod = state.modules.find(m => m.id === it.i);
                if (!mod) return null;
                return <ModuleCard mod={mod} tone={tone} query={q} geometry={geometryFor(mod.id)} onGeometry={setGeometry} onDrill={onDrill}
                  collapsed={!!it.collapsed} onToggleCollapse={() => toggleCollapse(it.i)} />;
              }}
            />
            {safeLayout.length === 0 && (
              <div style={{ padding: '60px 0', textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>No cards on this board. Click Customize to add some.</div>
            )}
          </div>

          <aside style={{ width: 248, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ position: 'relative' }}>
              <Search size={13} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
              <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search metrics…"
                className="form-input" style={{ width: '100%', boxSizing: 'border-box', fontSize: 12, padding: '7px 10px 7px 28px', borderRadius: 6 }} />
            </div>

            <RailSection id="tone" title="Alert Level" open={railOpen.tone} onToggle={toggleRail}>
              <SlicerGrid cols={2} options={['all', ...TONE_ORDER].map(t => ({ value: t, label: t === 'all' ? 'All' : TONE_LABEL[t], dot: t === 'all' ? null : C(TONE_COLOR[t]) }))}
                isActive={v => v === tone} onPick={setTone} />
            </RailSection>

            <RailSection id="modules" title="Modules" open={railOpen.modules} onToggle={toggleRail}>
              <SlicerGrid cols={1} options={state.modules.map(m => ({ value: m.id, label: m.label, dot: C(TONE_COLOR[worstTone(m)]) }))}
                isActive={v => visibleIds.has(v)}
                onPick={toggleModule}
              />
            </RailSection>

            <AttentionFeed modules={state.modules} onPick={pickOnly} open={railOpen.attention} onToggle={toggleRail} />
          </aside>
        </div>
      )}

      {drillRequest && <DrilldownModal request={drillRequest} onClose={() => setDrillRequest(null)} />}
    </div>
  );
}

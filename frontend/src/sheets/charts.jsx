// Sheets: charts drawn as plain SVG (no chart library) - column, bar, line,
// area, pie and scatter from a range, in a floating box on the grid that its
// editors move and resize. Axis labels in US number formats; a legend when
// there is more than one series (or slices).
import { useRef, useState } from 'react';
import { X } from 'lucide-react';
import { withCommas, formatValue } from './format.js';
import { CHART_TYPES } from './model.js';

// Eight categorical colors that hold up on light and dark cards.
const PALETTE = ['#2563eb', '#16a34a', '#d97706', '#9333ea', '#0891b2', '#db2777', '#65a30d', '#64748b'];
const TYPE_LABEL = { column: 'Column', bar: 'Bar', line: 'Line', area: 'Area', pie: 'Pie', scatter: 'Scatter' };

/** About five round steps covering lo..hi (always including 0 for bars). */
function niceTicks(lo, hi, count = 5) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
  if (lo === hi) { lo = lo > 0 ? 0 : lo - 1; hi = hi > 0 ? hi : hi + 1; }
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
  const start = Math.floor(lo / step) * step, out = [];
  for (let v = start; v <= hi + step * 0.5 && out.length < 20; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}
/** 1,200 / 1.2K / 3.4M - short US labels for an axis. */
function axisLabel(v, nf) {
  if (nf === 'percent') return `${withCommas(v * 100, 0)}%`;
  const pre = nf === 'currency' ? '$' : '';
  const a = Math.abs(v);
  if (a >= 1e9) return `${v < 0 ? '-' : ''}${pre}${Number((a / 1e9).toPrecision(3))}B`;
  if (a >= 1e6) return `${v < 0 ? '-' : ''}${pre}${Number((a / 1e6).toPrecision(3))}M`;
  if (a >= 1e4) return `${v < 0 ? '-' : ''}${pre}${Number((a / 1e3).toPrecision(3))}K`;
  return (v < 0 ? '-' : '') + pre + withCommas(a, Number.isInteger(v) ? 0 : Math.min(2, (String(a).split('.')[1] || '').length));
}

const muted = { fill: 'var(--muted)', fontSize: 11, fontFamily: 'Inter, sans-serif' };

export function ChartSVG({ type, data, width, height, title }) {
  const { categories, series } = data;
  const pie = type === 'pie';
  const legend = pie ? categories.map((c, i) => ({ name: c, color: PALETTE[i % PALETTE.length] })) : series.length > 1 ? series.map((s, i) => ({ name: s.name, color: PALETTE[i % PALETTE.length] })) : [];
  const top = (title ? 26 : 8) + (legend.length ? 20 : 0);
  const nf = series[0]?.nf || '';
  const W = Math.max(160, width), H = Math.max(110, height);
  const head = (
    <>
      {title && <text x={12} y={18} style={{ fill: 'var(--ink)', fontSize: 13, fontWeight: 700, fontFamily: 'Inter, sans-serif' }}>{title}</text>}
      {legend.length > 0 && (
        <g transform={`translate(12, ${top - 12})`}>
          {legend.slice(0, 8).map((l, i) => (
            <g key={i} transform={`translate(${i * Math.min(120, (W - 24) / Math.min(8, legend.length))}, 0)`}>
              <rect width={10} height={10} y={-9} rx={2} fill={l.color} />
              <text x={14} y={0} style={muted}>{String(l.name).slice(0, 16)}</text>
            </g>
          ))}
        </g>
      )}
    </>
  );
  if (!series.length || !categories.length) {
    return <svg width={W} height={H} role="img" aria-label="Empty chart">{head}<text x={W / 2} y={H / 2} textAnchor="middle" style={muted}>Pick a range with numbers to chart</text></svg>;
  }

  if (pie) {
    const vals = series[0].values.map((v) => (v && v > 0 ? v : 0));
    const total = vals.reduce((s, v) => s + v, 0) || 1;
    const cx = W / 2, cy = top + (H - top) / 2, rad = Math.max(10, Math.min(W, H - top) / 2 - 10);
    const starts = vals.map((_, i) => -Math.PI / 2 + (vals.slice(0, i).reduce((s, x) => s + x, 0) / total) * Math.PI * 2);
    return (
      <svg width={W} height={H} role="img" aria-label={`${title || 'Pie chart'}: ${categories.map((c, i) => `${c} ${withCommas(vals[i] / total * 100, 0)}%`).join(', ')}`}>
        {head}
        {vals.map((v, i) => {
          const a0 = starts[i], a1 = a0 + (v / total) * Math.PI * 2;
          const large = a1 - a0 > Math.PI ? 1 : 0;
          const p = v >= total ? `M ${cx} ${cy - rad} A ${rad} ${rad} 0 1 1 ${cx - 0.01} ${cy - rad} Z`
            : `M ${cx} ${cy} L ${cx + rad * Math.cos(a0)} ${cy + rad * Math.sin(a0)} A ${rad} ${rad} 0 ${large} 1 ${cx + rad * Math.cos(a1)} ${cy + rad * Math.sin(a1)} Z`;
          const mid = (a0 + a1) / 2;
          return (
            <g key={i}>
              <path d={p} fill={PALETTE[i % PALETTE.length]} stroke="var(--card)" strokeWidth={1.5}><title>{`${categories[i]}: ${formatValue(v, { nf })} (${withCommas(v / total * 100, 1)}%)`}</title></path>
              {v / total > 0.06 && <text x={cx + rad * 0.62 * Math.cos(mid)} y={cy + rad * 0.62 * Math.sin(mid) + 4} textAnchor="middle" style={{ fill: '#fff', fontSize: 11, fontWeight: 600, fontFamily: 'Inter, sans-serif' }}>{`${withCommas(v / total * 100, 0)}%`}</text>}
            </g>
          );
        })}
      </svg>
    );
  }

  const horiz = type === 'bar';
  const scatter = type === 'scatter';
  const ys = scatter && series.length > 1 ? series.slice(1) : series;
  const xsNum = scatter && series.length > 1 ? series[0].values : null;
  const allY = ys.flatMap((s) => s.values).filter((v) => v != null);
  const lo = Math.min(0, ...allY), hi = Math.max(0, ...allY);
  const ticks = niceTicks(lo, hi);
  const tLo = ticks[0], tHi = ticks[ticks.length - 1];
  const left = horiz ? Math.min(110, 12 + Math.max(...categories.map((c) => String(c).length)) * 6.5) : 12 + Math.max(...ticks.map((t) => axisLabel(t, nf).length)) * 6.5;
  const right = 14, bottom = 28;
  const pw = Math.max(20, W - left - right), ph = Math.max(20, H - top - bottom);
  const vPos = (v) => (horiz ? left + ((v - tLo) / (tHi - tLo || 1)) * pw : top + ph - ((v - tLo) / (tHi - tLo || 1)) * ph);
  const n = categories.length;
  const band = (horiz ? ph : pw) / n;
  const cPos = (i) => (horiz ? top : left) + band * (i + 0.5);
  let xTicks = null, xPos = cPos;
  if (xsNum) {
    const xv = xsNum.filter((v) => v != null);
    xTicks = niceTicks(Math.min(...xv), Math.max(...xv));
    const xl = xTicks[0], xh = xTicks[xTicks.length - 1];
    xPos = (i) => left + (((xsNum[i] ?? xl) - xl) / (xh - xl || 1)) * pw;
  }
  const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor((horiz ? ph : pw) / (horiz ? 16 : 56)))));

  return (
    <svg width={W} height={H} role="img" aria-label={`${title || TYPE_LABEL[type] + ' chart'} of ${ys.map((s) => s.name).join(', ')}`}>
      {head}
      {ticks.map((t) => (
        <g key={t}>
          {horiz
            ? <line x1={vPos(t)} x2={vPos(t)} y1={top} y2={top + ph} stroke="var(--line)" />
            : <line x1={left} x2={left + pw} y1={vPos(t)} y2={vPos(t)} stroke="var(--line)" />}
          {horiz
            ? <text x={vPos(t)} y={top + ph + 16} textAnchor="middle" style={muted}>{axisLabel(t, nf)}</text>
            : <text x={left - 6} y={vPos(t) + 4} textAnchor="end" style={muted}>{axisLabel(t, nf)}</text>}
        </g>
      ))}
      {xTicks
        ? xTicks.map((t) => {
          const x = left + ((t - xTicks[0]) / (xTicks[xTicks.length - 1] - xTicks[0] || 1)) * pw;
          return <text key={'x' + t} x={x} y={top + ph + 16} textAnchor="middle" style={muted}>{axisLabel(t, series[0].nf)}</text>;
        })
        : categories.map((c, i) => (i % every ? null : horiz
          ? <text key={'c' + i} x={left - 6} y={cPos(i) + 4} textAnchor="end" style={muted}>{String(c).slice(0, 16)}</text>
          : <text key={'c' + i} x={cPos(i)} y={top + ph + 16} textAnchor="middle" style={muted}>{String(c).slice(0, 12)}</text>))}
      {ys.map((s, si) => {
        const color = PALETTE[(scatter && series.length > 1 ? si + 1 : si) % PALETTE.length];
        if (type === 'column' || type === 'bar') {
          const bw = (band * 0.75) / ys.length;
          return s.values.map((v, i) => {
            if (v == null) return null;
            const o = (horiz ? top : left) + band * i + band * 0.125 + bw * si;
            const a = vPos(Math.max(0, tLo)), b2 = vPos(v);
            return horiz
              ? <rect key={`${si}-${i}`} x={Math.min(a, b2)} y={o} width={Math.abs(b2 - a)} height={Math.max(1, bw - 1)} fill={color} rx={1.5}><title>{`${categories[i]}, ${s.name}: ${formatValue(v, { nf: s.nf })}`}</title></rect>
              : <rect key={`${si}-${i}`} x={o} y={Math.min(a, b2)} width={Math.max(1, bw - 1)} height={Math.abs(b2 - a)} fill={color} rx={1.5}><title>{`${categories[i]}, ${s.name}: ${formatValue(v, { nf: s.nf })}`}</title></rect>;
          });
        }
        const pts = s.values.map((v, i) => (v == null ? null : [xPos(i), vPos(v), v, i])).filter(Boolean);
        if (scatter) return pts.map(([x, y, v, i]) => <circle key={`${si}-${i}`} cx={x} cy={y} r={3.5} fill={color}><title>{`${s.name}: ${formatValue(v, { nf: s.nf })}`}</title></circle>);
        const d = pts.map(([x, y], k) => `${k ? 'L' : 'M'} ${x} ${y}`).join(' ');
        return (
          <g key={si}>
            {type === 'area' && pts.length > 1 && <path d={`${d} L ${pts[pts.length - 1][0]} ${vPos(Math.max(0, tLo))} L ${pts[0][0]} ${vPos(Math.max(0, tLo))} Z`} fill={color} opacity={0.18} />}
            <path d={d} fill="none" stroke={color} strokeWidth={2} />
            {pts.length <= 40 && pts.map(([x, y, v, i]) => <circle key={i} cx={x} cy={y} r={2.5} fill={color}><title>{`${categories[i]}, ${s.name}: ${formatValue(v, { nf: s.nf })}`}</title></circle>)}
          </g>
        );
      })}
      <line x1={left} x2={horiz ? left : left + pw} y1={horiz ? top : top + ph} y2={top + ph} stroke="var(--muted)" />
    </svg>
  );
}

/** The floating chart on the grid. Dragging the head moves it; the corner resizes it. */
export function ChartBox({ chart, data, selected, canEdit, zoom = 1, onSelect, onChange, onDelete }) {
  const [live, setLive] = useState(null);         // {x, y, w, h} while dragging
  const startRef = useRef(null);
  const box = live || chart;
  const drag = (e, mode) => {
    if (!canEdit || e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    onSelect();
    startRef.current = { x: e.clientX, y: e.clientY, box: { x: chart.x, y: chart.y, w: chart.w, h: chart.h } };
    let last = null;
    const move = (ev) => {
      const s = startRef.current;
      const dx = (ev.clientX - s.x) / zoom, dy = (ev.clientY - s.y) / zoom;
      last = mode === 'move'
        ? { ...s.box, x: Math.max(0, s.box.x + dx), y: Math.max(0, s.box.y + dy) }
        : { ...s.box, w: Math.max(160, Math.min(2000, s.box.w + dx)), h: Math.max(120, Math.min(2000, s.box.h + dy)) };
      setLive(last);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      setLive(null);
      if (last) onChange({ x: Math.round(last.x), y: Math.round(last.y), w: Math.round(last.w), h: Math.round(last.h) });
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  return (
    <div className={`nxs-chart${selected ? ' is-on' : ''}`} data-chart={chart.id} style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
      onMouseDown={(e) => { e.stopPropagation(); onSelect(); }}>
      <div className="nxs-chart-head" onMouseDown={(e) => drag(e, 'move')}>
        {selected && canEdit ? (
          <>
            <select aria-label="Chart Type" value={chart.type} onMouseDown={(e) => e.stopPropagation()} onChange={(e) => onChange({ type: e.target.value })}>
              {CHART_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
            </select>
            <input aria-label="Chart Title" placeholder="Chart Title" defaultValue={chart.title || ''} maxLength={200}
              onMouseDown={(e) => e.stopPropagation()} onBlur={(e) => onChange({ title: e.target.value.trim() })}
              onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') e.currentTarget.blur(); }} />
            <button type="button" aria-label="Delete Chart" title="Delete Chart" onMouseDown={(e) => e.stopPropagation()} onClick={onDelete}><X size={14} /></button>
          </>
        ) : <span className="nxs-chart-grip" aria-hidden="true" />}
      </div>
      <ChartSVG type={chart.type} data={data} width={box.w - 2} height={box.h - 30} title={chart.title} />
      {selected && canEdit && <span className="nxs-chart-rz" aria-hidden="true" onMouseDown={(e) => drag(e, 'size')} />}
    </div>
  );
}

import { useMemo } from 'react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { money } from '../../../accounting/dashboard/model/money';
import { BRAND, seriesColor } from './Bits';

// Recharts wrappers with the dashboard's conventions: brand color, compact
// money axes, one tooltip look. Each takes plain arrays so widgets stay thin.

const compact = (v) => money(v, { compact: true });
const tick = { fontSize: 11, fill: 'var(--text-muted)' };
const tooltipStyle = { fontSize: 12, borderRadius: 8, border: '1px solid var(--border-color)', background: 'var(--bg-card)', color: 'var(--text-primary)', fontFamily: 'inherit' };

export function Sparkline({ values, color = BRAND, height = 36 }) {
  const data = useMemo(() => values.map((v, i) => ({ i, v })), [values]);
  if (values.length < 2) return null;
  return (
    <div aria-hidden style={{ height, width: '100%' }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 4, right: 2, bottom: 0, left: 2 }}>
          <Area type="monotone" dataKey="v" stroke={color} strokeWidth={1.8} fill={color} fillOpacity={0.12} isAnimationActive={false} dot={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function AreaTrend({ data, series, height = 180, zero = true }) {
  return (
    <div style={{ height, width: '100%' }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} strokeOpacity={0.15} />
          <XAxis dataKey="label" tick={tick} tickLine={false} axisLine={false} interval="preserveStartEnd" />
          <YAxis tick={tick} tickLine={false} axisLine={false} tickFormatter={(v) => compact(Number(v))} width={58} domain={zero ? [0, 'auto'] : ['auto', 'auto']} />
          <Tooltip contentStyle={tooltipStyle} formatter={(v, name) => [money(Number(v)), series.find((s) => s.key === name)?.label ?? name]} />
          {series.map((s, i) => (
            <Area key={s.key} type="monotone" dataKey={s.key} stroke={s.color ?? seriesColor(i)} strokeWidth={s.dashed ? 1.5 : 2} strokeDasharray={s.dashed ? '4 4' : undefined}
              fill={s.color ?? seriesColor(i)} fillOpacity={s.dashed ? 0 : 0.1} dot={false} isAnimationActive={false} connectNulls={false} />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function Bars({ data, series, height = 180, stacked, xKey = 'label' }) {
  return (
    <div style={{ height, width: '100%' }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barGap={3}>
          <CartesianGrid vertical={false} strokeOpacity={0.15} />
          <XAxis dataKey={xKey} tick={tick} tickLine={false} axisLine={false} />
          <YAxis tick={tick} tickLine={false} axisLine={false} tickFormatter={(v) => compact(Number(v))} width={58} />
          <Tooltip contentStyle={tooltipStyle} cursor={{ fillOpacity: 0.06 }} formatter={(v, name) => [money(Number(v)), series.find((s) => s.key === name)?.label ?? name]} />
          {series.map((s, i) => (
            <Bar key={s.key} dataKey={s.key} fill={s.color ?? seriesColor(i)} radius={[4, 4, 0, 0]} stackId={stacked ? (s.stackId ?? 'a') : undefined} isAnimationActive={false} maxBarSize={34} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Single-series bars with a color per bar (maturities by year, days to close). */
export function ColoredBars({ data, height = 160, valueLabel }) {
  const fmt = (v) => (valueLabel ? valueLabel(Number(v)) : money(Number(v)));
  return (
    <div style={{ height, width: '100%' }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} strokeOpacity={0.15} />
          <XAxis dataKey="label" tick={tick} tickLine={false} axisLine={false} />
          <YAxis tick={tick} tickLine={false} axisLine={false} tickFormatter={(v) => (valueLabel ? valueLabel(Number(v)) : compact(Number(v)))} width={52} />
          <Tooltip contentStyle={tooltipStyle} cursor={{ fillOpacity: 0.06 }} formatter={(v) => [fmt(v), '']} />
          <Bar dataKey="value" radius={[4, 4, 0, 0]} isAnimationActive={false} maxBarSize={40}>
            {data.map((d, i) => <Cell key={i} fill={d.color} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function Lines({ data, series, height = 170, zero = true, hline, xKey = 'label' }) {
  return (
    <div style={{ height, width: '100%' }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} strokeOpacity={0.15} />
          <XAxis dataKey={xKey} tick={tick} tickLine={false} axisLine={false} interval="preserveStartEnd" />
          <YAxis tick={tick} tickLine={false} axisLine={false} tickFormatter={(v) => compact(Number(v))} width={58} domain={zero ? [0, 'auto'] : ['auto', 'auto']} />
          <Tooltip contentStyle={tooltipStyle} formatter={(v, name) => [money(Number(v)), series.find((s) => s.key === name)?.label ?? name]} />
          {hline ? <ReferenceLine y={hline.v} stroke="#dc2626" strokeDasharray="4 4" label={hline.label ? { value: hline.label, fontSize: 10, fill: '#dc2626', position: 'insideTopRight' } : undefined} /> : null}
          {series.map((s, i) => (
            <Line key={s.key} type="monotone" dataKey={s.key} stroke={s.color ?? seriesColor(i)} strokeWidth={s.dashed ? 1.5 : 2} strokeDasharray={s.dashed ? '5 4' : undefined} dot={false} isAnimationActive={false} connectNulls={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Donut with a center label. */
export function Donut({ rows, total, label, sub, subColor, size = 176 }) {
  const data = rows.filter((r) => r.value > 0);
  return (
    <div style={{ position: 'relative', flexShrink: 0, width: size, height: size }}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie data={data} dataKey="value" nameKey="name" innerRadius={size * 0.34} outerRadius={size * 0.47} paddingAngle={1.5} stroke="none" isAnimationActive={false}>
            {data.map((d, i) => <Cell key={i} fill={d.color} />)}
          </Pie>
          <Tooltip contentStyle={tooltipStyle} formatter={(v, name) => [money(Number(v)), name]} />
        </PieChart>
      </ResponsiveContainer>
      <div style={{ pointerEvents: 'none', position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>
        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{label}</div>
        <div style={{ fontSize: '1.1rem', fontWeight: 700, lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' }}>{money(total, { compact: true })}</div>
        {sub ? <div style={{ fontSize: '0.7rem', fontWeight: 600, color: subColor }}>{sub}</div> : null}
      </div>
    </div>
  );
}

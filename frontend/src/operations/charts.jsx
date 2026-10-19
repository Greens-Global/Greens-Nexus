// Operations charts. One job per chart, one y-axis each, colors by role from
// ops.css (never a series color on text). Every chart has a hover tooltip and
// sits beside a table that carries the same figures.
import {
  ResponsiveContainer, BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Cell, LabelList,
} from 'recharts';
import { AGING, count, dayLabel, money, monthLabel, pct } from './model';

const AXIS = { fontSize: 11.5, fill: 'var(--muted)' };
const GRID = 'var(--ops-grid)';
const AGE_COLORS = ['var(--ops-age-1)', 'var(--ops-age-2)', 'var(--ops-age-3)', 'var(--ops-age-4)', 'var(--ops-age-5)'];
const moneyTick = (v) => money(v, { compact: true });

export function Legend({ items }) {
  return (
    <div className="ops-legend">
      {items.map(([label, color]) => <span key={label}><i style={{ background: color }} />{label}</span>)}
    </div>
  );
}

function Tip({ active, payload, title, rows }) {
  if (!active || !payload || !payload.length) return null;
  const d = payload[0].payload;
  return (
    <div className="ops-tip">
      <div className="ops-tip-title">{title(d)}</div>
      {rows(d).map(([label, value, color]) => (
        <div className="ops-tip-row" key={label}>
          <span>{color && <i style={{ background: color }} />}{label}</span><b>{value}</b>
        </div>
      ))}
    </div>
  );
}

// Empty and near-empty charts say so instead of drawing an axis around nothing.
function Frame({ height, empty, children }) {
  if (empty) return <div className="ops-empty" style={{ height, display: 'grid', placeItems: 'center' }}>{empty}</div>;
  return <div style={{ width: '100%', height }}><ResponsiveContainer width="100%" height="100%">{children}</ResponsiveContainer></div>;
}

// Rented / vacant / off-market STORAGE units per facility - where the empty
// space is. Mailboxes are not in `units` (see occupancy.js).
export function UnitMixChart({ facilities, onPick }) {
  const data = facilities.map((f) => ({ id: f.id, name: f.shortName, ...f.units }));
  const pick = onPick ? { onClick: (d) => onPick((d?.payload || d)?.id), cursor: 'pointer' } : {};
  return (
    <Frame height={Math.max(150, data.length * 46 + 34)} empty={data.length ? null : 'No facilities to show.'}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 4 }} barCategoryGap={12}>
        <CartesianGrid horizontal={false} stroke={GRID} />
        <XAxis type="number" tick={AXIS} axisLine={false} tickLine={false} tickFormatter={count} />
        <YAxis type="category" dataKey="name" tick={{ ...AXIS, fontSize: 12.5, fill: 'var(--ink)' }} axisLine={false} tickLine={false} width={104} />
        <Tooltip cursor={{ fill: 'var(--ops-grid)' }} content={<Tip title={(d) => d.name} rows={(d) => [
          ['Rented', `${count(d.rented)} (${pct(d.rented, d.rented + d.vacant, 0)} of rentable)`, 'var(--ops-s1)'],
          ['Vacant', count(d.vacant), 'var(--ops-s2)'],
          ['Off Market', count(d.unavailable), 'var(--ops-neutral)'],
          ['Storage Units', count(d.total)],
        ]} />} />
        <Bar dataKey="rented" stackId="u" fill="var(--ops-s1)" stroke="var(--ops-surface)" strokeWidth={2} isAnimationActive={false} {...pick} />
        <Bar dataKey="vacant" stackId="u" fill="var(--ops-s2)" stroke="var(--ops-surface)" strokeWidth={2} isAnimationActive={false} {...pick} />
        <Bar dataKey="unavailable" stackId="u" fill="var(--ops-neutral)" stroke="var(--ops-surface)" strokeWidth={2} radius={[0, 4, 4, 0]} isAnimationActive={false} {...pick} />
      </BarChart>
    </Frame>
  );
}

// Units rented at each month end - is the property filling or emptying.
export function RentedTrendChart({ history }) {
  const data = history.map((h) => ({ ...h, label: monthLabel(h.month) }));
  const values = data.map((d) => d.rented);
  const lo = Math.min(...values), hi = Math.max(...values);
  const pad = Math.max(2, Math.round((hi - lo) * 0.25));
  return (
    <Frame height={230} empty={data.length > 1 ? null : 'Not enough lease history yet.'}>
      <LineChart data={data} margin={{ top: 10, right: 16, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} stroke={GRID} />
        <XAxis dataKey="label" tick={AXIS} axisLine={false} tickLine={false} interval="preserveStartEnd" minTickGap={18} />
        <YAxis tick={AXIS} axisLine={false} tickLine={false} width={44} domain={[Math.max(0, lo - pad), hi + pad]} tickFormatter={count} allowDecimals={false} />
        <Tooltip cursor={{ stroke: 'var(--muted)', strokeDasharray: '3 3' }} content={<Tip title={(d) => d.label} rows={(d) => [
          ['Units Rented', count(d.rented), 'var(--ops-s1)'],
          ['Move-Ins', count(d.moveIns)],
          ['Move-Outs', count(d.moveOuts)],
        ]} />} />
        <Line type="monotone" dataKey="rented" stroke="var(--ops-s1)" strokeWidth={2} dot={false} activeDot={{ r: 5, stroke: 'var(--ops-surface)', strokeWidth: 2 }} isAnimationActive={false} />
      </LineChart>
    </Frame>
  );
}

// Move-ins against move-outs, month by month.
export function MovesChart({ history }) {
  const data = history.map((h) => ({ ...h, label: monthLabel(h.month) }));
  return (
    <Frame height={230} empty={data.some((d) => d.moveIns || d.moveOuts) ? null : 'No move-ins or move-outs on record.'}>
      <BarChart data={data} margin={{ top: 10, right: 16, bottom: 0, left: 0 }} barGap={2} barCategoryGap="24%">
        <CartesianGrid vertical={false} stroke={GRID} />
        <XAxis dataKey="label" tick={AXIS} axisLine={false} tickLine={false} interval="preserveStartEnd" minTickGap={18} />
        <YAxis tick={AXIS} axisLine={false} tickLine={false} width={34} allowDecimals={false} />
        <Tooltip cursor={{ fill: 'var(--ops-grid)' }} content={<Tip title={(d) => d.label} rows={(d) => [
          ['Move-Ins', count(d.moveIns), 'var(--ops-s1)'],
          ['Move-Outs', count(d.moveOuts), 'var(--ops-s2)'],
          ['Net', `${d.moveIns - d.moveOuts > 0 ? '+' : ''}${d.moveIns - d.moveOuts}`],
        ]} />} />
        <Bar dataKey="moveIns" fill="var(--ops-s1)" radius={[4, 4, 0, 0]} isAnimationActive={false} />
        <Bar dataKey="moveOuts" fill="var(--ops-s2)" radius={[4, 4, 0, 0]} isAnimationActive={false} />
      </BarChart>
    </Frame>
  );
}

// Past-due dollars by how old the balance is. Darker = older = harder to collect.
export function AgingChart({ buckets, onPick }) {
  const data = AGING.map((a, i) => ({ key: a.key, label: a.label, amount: buckets[a.key] || 0, color: AGE_COLORS[i] }));
  const total = data.reduce((a, d) => a + d.amount, 0);
  return (
    <Frame height={230} empty={total ? null : 'Nothing is past due.'}>
      <BarChart data={data} margin={{ top: 22, right: 16, bottom: 0, left: 0 }} barCategoryGap="22%">
        <CartesianGrid vertical={false} stroke={GRID} />
        <XAxis dataKey="label" tick={AXIS} axisLine={false} tickLine={false} interval={0} />
        <YAxis tick={AXIS} axisLine={false} tickLine={false} width={52} tickFormatter={moneyTick} />
        <Tooltip cursor={{ fill: 'var(--ops-grid)' }} content={<Tip title={(d) => d.label} rows={(d) => [
          ['Past Due', money(d.amount), d.color],
          ['Share of Total', pct(d.amount, total, 0)],
        ]} />} />
        <Bar dataKey="amount" radius={[4, 4, 0, 0]} isAnimationActive={false}
          {...(onPick ? { onClick: (d) => onPick((d?.payload || d)?.key), cursor: 'pointer' } : {})}>
          {data.map((d) => <Cell key={d.label} fill={d.color} />)}
          <LabelList dataKey="amount" position="top" formatter={(v) => (v ? money(v, { compact: true }) : '')} style={{ fontSize: 11.5, fill: 'var(--ink)', fontWeight: 600 }} />
        </Bar>
      </BarChart>
    </Frame>
  );
}

// Money collected per day over the last 30 days.
export function CollectionsChart({ daily }) {
  const data = daily.map((d) => ({ ...d, label: d.label || dayLabel(d.date) }));
  return (
    <Frame height={230} empty={data.some((d) => d.collected) ? null : 'No payments in this period.'}>
      <BarChart data={data} margin={{ top: 10, right: 16, bottom: 0, left: 0 }} barCategoryGap="18%">
        <CartesianGrid vertical={false} stroke={GRID} />
        <XAxis dataKey="label" tick={AXIS} axisLine={false} tickLine={false} interval="preserveStartEnd" minTickGap={22} />
        <YAxis tick={AXIS} axisLine={false} tickLine={false} width={52} tickFormatter={moneyTick} />
        <Tooltip cursor={{ fill: 'var(--ops-grid)' }} content={<Tip title={(d) => d.label} rows={(d) => [
          ['Collected', money(d.collected), 'var(--ops-s1)'],
          ['Failed Payments', count(d.failed)],
        ]} />} />
        <Bar dataKey="collected" fill="var(--ops-s1)" radius={[3, 3, 0, 0]} isAnimationActive={false} />
      </BarChart>
    </Frame>
  );
}

// Past-due balance day by day, from the saved daily history.
export function PastDueTrendChart({ points }) {
  const data = points.map((p) => ({ ...p, label: dayLabel(p.date) }));
  return (
    <Frame height={200} empty={data.length >= 3 ? null : 'This line starts drawing after three days of saved history. Nexus saves one point per facility per day from today on.'}>
      <LineChart data={data} margin={{ top: 10, right: 16, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} stroke={GRID} />
        <XAxis dataKey="label" tick={AXIS} axisLine={false} tickLine={false} interval="preserveStartEnd" minTickGap={22} />
        <YAxis tick={AXIS} axisLine={false} tickLine={false} width={52} tickFormatter={moneyTick} domain={[0, 'auto']} />
        <Tooltip cursor={{ stroke: 'var(--muted)', strokeDasharray: '3 3' }} content={<Tip title={(d) => d.label} rows={(d) => [['Past Due', money(d.pastDue), 'var(--ops-s1)']]} />} />
        <Line type="monotone" dataKey="pastDue" stroke="var(--ops-s1)" strokeWidth={2} dot={false} activeDot={{ r: 5, stroke: 'var(--ops-surface)', strokeWidth: 2 }} isAnimationActive={false} />
      </LineChart>
    </Frame>
  );
}

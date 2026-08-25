// Task Module - Dashboard chart primitives (Card / LightBar / Donut) and the
// Custom Charts panel + builder. Ported from the export's dashboard/charts.tsx
// and CustomCharts.tsx to the Nexus inline-style idiom. Custom charts persist to
// localStorage, namespaced by a scope key (project id, or "workspace").
import { useMemo, useRef, useState } from 'react';
import { Plus, BarChart3, LineChart as LineIcon, PieChart, Hash, Trash2, Pencil, ChevronDown, Check, X } from 'lucide-react';
import { NX, FONT, btn, input as inputStyle, STATUS_META, STATUS_ORDER, PRIORITY_META, PRIORITY_ORDER } from '../theme';
import { useUnsavedGuard } from '../../lib/useUnsavedGuard';
import UnsavedChangesPrompt from '../../components/UnsavedChangesPrompt';

const PALETTE = ['#2563eb', '#16a34a', '#f59e0b', '#7c3aed', '#dc2626', '#0891b2', '#db2777', '#65a30d'];

// ── primitives ───────────────────────────────────────────────────────────────
export function Card({ title, children }) {
  return (
    <div style={{ borderRadius: 16, border: `1px solid ${NX.border}`, background: NX.surface, padding: 20 }}>
      <div style={{ marginBottom: 16, fontSize: 14, fontWeight: 700, color: NX.ink }}>{title}</div>
      {children}
    </div>
  );
}

export function LightBar({ data, onSelect }) {
  // Kit bar list: quiet label, slim rounded bar on a track, ink count outside
  // (numbers wear text tokens, never white-on-series-color). When onSelect is
  // given, each row becomes a real button that drills into the List view
  // filtered to that slice - a bar chart people can click, not just look at.
  const max = Math.max(1, ...data.map((d) => d.value));
  if (data.length === 0) return <Empty />;
  const Row = onSelect ? 'button' : 'div';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
      {data.map((d) => (
        <Row key={d.label} onClick={onSelect ? () => onSelect(d) : undefined}
          style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 12, fontSize: 13, textAlign: 'left',
            background: 'none', border: 'none', padding: 0, margin: 0, font: 'inherit', color: 'inherit',
            cursor: onSelect ? 'pointer' : 'default', borderRadius: 6 }}>
          <span style={{ width: 96, flexShrink: 0, color: NX.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.label}</span>
          <div style={{ height: 9, flex: 1, borderRadius: 6, background: NX.surface2, overflow: 'hidden' }}>
            <div style={{ height: '100%', borderRadius: 6, width: `${Math.max(5, (d.value / max) * 100)}%`, background: d.color }} />
          </div>
          <span style={{ width: 26, textAlign: 'right', fontWeight: 700, color: NX.ink, fontVariantNumeric: 'tabular-nums' }}>{d.value}</span>
        </Row>
      ))}
    </div>
  );
}

export function Donut({ segments, total, unit = 'tasks' }) {
  // Kit donut: slim ring with 2px gaps, center total + quiet unit label.
  const r = 46, stroke = 14, c = 2 * Math.PI * r, GAP = 2.5;
  const live = segments.filter((s) => s.value > 0);
  let off = 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 26, flexWrap: 'wrap' }}>
      <div style={{ position: 'relative' }}>
        <svg width={124} height={124} viewBox="0 0 124 124">
          <circle cx={62} cy={62} r={r} fill="none" stroke={NX.surface2} strokeWidth={stroke} />
          <g transform="rotate(-90 62 62)">
            {total > 0 && live.map((s) => {
              const len = Math.max((s.value / total) * c - (live.length > 1 ? GAP : 0), 1.5);
              const el = <circle key={s.label} cx={62} cy={62} r={r} fill="none" stroke={s.color} strokeWidth={stroke} strokeDasharray={`${len} ${c - len}`} strokeDashoffset={-off} />;
              off += (s.value / total) * c; return el;
            })}
          </g>
        </svg>
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', lineHeight: 1.15 }}>
          <span style={{ fontSize: 24, fontWeight: 700, color: NX.ink, fontVariantNumeric: 'tabular-nums' }}>{total}</span>
          <span style={{ fontSize: 10.5, color: NX.faint }}>{unit}</span>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
        {segments.map((s) => (
          <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 13, color: NX.dim }}>
            <span style={{ width: 9, height: 9, borderRadius: 3, background: s.color, flexShrink: 0 }} /> {s.label}
            <span style={{ fontWeight: 700, color: NX.ink, fontVariantNumeric: 'tabular-nums' }}>{s.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function TrendArea({ buckets, color = NX.primary, height = 90, ariaLabel }) {
  // Smooth gradient area (the reference kits' hero chart) - generic over
  // {label, n} buckets so any view can feed it real counts.
  const W = 320, H = height, PAD = 4;
  const max = Math.max(...buckets.map((b) => b.n), 1);
  const px = (i) => PAD + (i / Math.max(buckets.length - 1, 1)) * (W - PAD * 2);
  const py = (n) => H - PAD - (n / max) * (H - PAD * 2);
  const pts = buckets.map((b, i) => ({ x: px(i), y: py(b.n) }));
  const curve = pts.reduce((acc, p, i, arr) => {
    if (!i) return `M ${p.x} ${p.y}`;
    const p0 = arr[i - 1], cx = (p0.x + p.x) / 2;
    return `${acc} C ${cx} ${p0.y}, ${cx} ${p.y}, ${p.x} ${p.y}`;
  }, '');
  const gid = `ta-${color.replace(/[^a-z0-9]/gi, '')}`;
  const last = pts[pts.length - 1];
  return (
    <div>
      <div style={{ position: 'relative' }}>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" role="img" aria-label={ariaLabel}>
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.22" />
              <stop offset="100%" stopColor={color} stopOpacity="0.02" />
            </linearGradient>
          </defs>
          <path d={`${curve} L ${pts[pts.length - 1].x} ${H - PAD} L ${PAD} ${H - PAD} Z`} fill={`url(#${gid})`} />
          <path d={curve} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        </svg>
        <span style={{ position: 'absolute', left: `${(last.x / W) * 100}%`, top: `${(last.y / H) * 100}%`, width: 9, height: 9, borderRadius: '50%', background: color, border: `2px solid ${NX.surface}`, transform: 'translate(-50%, -50%)', pointerEvents: 'none' }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, fontSize: 10.5, color: NX.faint }}>
        <span>{buckets[0]?.label}</span>
        <span>{buckets[Math.floor(buckets.length / 2)]?.label}</span>
        <span>{buckets[buckets.length - 1]?.label}</span>
      </div>
    </div>
  );
}

function Empty() {
  return <div style={{ padding: '32px 0', textAlign: 'center', fontSize: 12, color: NX.faint }}>No matching data.</div>;
}

// ── custom charts ────────────────────────────────────────────────────────────
const STYLE_OPTIONS = [
  { key: 'bar', label: 'Bar' }, { key: 'lollipop', label: 'Lollipop' },
  { key: 'line', label: 'Line' }, { key: 'donut', label: 'Donut' }, { key: 'number', label: 'Number' },
];
const DIMENSIONS = [
  { key: 'status', label: 'Status' }, { key: 'priority', label: 'Priority' },
  { key: 'assignee', label: 'Assignee' }, { key: 'project', label: 'Project' }, { key: 'team', label: 'Team' },
];
const METRICS = [
  { key: 'count', label: 'Task Count' }, { key: 'sum_estimate', label: 'Estimated Hours' }, { key: 'sum_actual', label: 'Actual Hours' },
];
const KEY = 'nexus.customCharts';

const readAll = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } };
const autoTitle = (cfg) => {
  const m = cfg.metric === 'count' ? 'Total tasks' : cfg.metric === 'sum_estimate' ? 'Estimated hours' : 'Actual hours';
  return `${m} by ${(DIMENSIONS.find((d) => d.key === cfg.dimension)?.label || '').toLowerCase()}`;
};

function passes(t, f) {
  if (f.statuses.length && !f.statuses.includes(t.status)) return false;
  if (f.priorities.length && !f.priorities.includes(t.priority)) return false;
  if (f.assigneeIds.length && !(t.assigneeId && f.assigneeIds.includes(t.assigneeId))) return false;
  return true;
}

// Group tasks into {label,value,color} by the chart's dimension/metric.
function computeSeries(cfg, tasks, store) {
  const rows = tasks.filter((t) => passes(t, cfg.filters));
  const val = (group) => cfg.metric === 'count' ? group.length
    : cfg.metric === 'sum_estimate' ? group.reduce((n, t) => n + (t.estimateHours ?? 0), 0)
      : group.reduce((n, t) => n + (t.actualHours ?? 0), 0);
  const statusMeta = (k) => STATUS_META[k] || (() => { const c = store.customStatuses.find((s) => s.id === k); return c ? { label: c.label, color: c.color } : { label: k, color: NX.dim }; })();

  if (cfg.dimension === 'status') {
    const keys = [...STATUS_ORDER, ...store.customStatuses.map((s) => s.id)];
    return keys.map((s) => ({ label: statusMeta(s).label, value: val(rows.filter((t) => t.status === s)), color: statusMeta(s).color })).filter((d) => d.value > 0);
  }
  if (cfg.dimension === 'priority') {
    return PRIORITY_ORDER.map((p) => ({ label: PRIORITY_META[p].label, value: val(rows.filter((t) => t.priority === p)), color: PRIORITY_META[p].color })).filter((d) => d.value > 0);
  }
  if (cfg.dimension === 'team') {
    return store.teams.map((d) => ({ label: d.name, value: val(rows.filter((t) => t.teamId === d.id)), color: d.color || NX.blue })).filter((d) => d.value > 0);
  }
  if (cfg.dimension === 'project') {
    return store.projects.map((p, i) => ({ label: p.name, value: val(rows.filter((t) => t.projectId === p.id)), color: PALETTE[i % PALETTE.length] })).filter((d) => d.value > 0);
  }
  // assignee - derived from the tasks themselves
  const seen = new Map();
  for (const t of rows) if (t.assigneeId && !seen.has(t.assigneeId)) seen.set(t.assigneeId, (store.nameOf?.(t.assigneeId) || t.assigneeId).split(' ')[0]);
  const out = [...seen.entries()].map(([id, label], i) => ({ label, value: val(rows.filter((t) => t.assigneeId === id)), color: PALETTE[i % PALETTE.length] })).filter((d) => d.value > 0);
  const un = val(rows.filter((t) => !t.assigneeId));
  if (un > 0) out.push({ label: 'Unassigned', value: un, color: NX.faint });
  return out;
}

function LineChart({ data, labels }) {
  if (data.length === 0) return <Empty />;
  const max = Math.max(...data.map((d) => d.value), 1);
  const w = 100, h = 46, pad = 4;
  const step = data.length > 1 ? (w - pad * 2) / (data.length - 1) : 0;
  const pts = data.map((d, i) => [pad + i * step, h - pad - (d.value / max) * (h - pad * 2)]);
  return (
    <div>
      <svg viewBox={`0 0 ${w} ${h}`} style={{ height: 160, width: '100%' }} preserveAspectRatio="none">
        <polyline points={pts.map((p) => p.join(',')).join(' ')} fill="none" stroke={NX.purple} strokeWidth={0.8} vectorEffect="non-scaling-stroke" />
        {pts.map((p, i) => <circle key={i} cx={p[0]} cy={p[1]} r={1.1} fill={NX.purple} />)}
      </svg>
      <div style={{ marginTop: 4, display: 'flex', justifyContent: 'space-between', fontSize: 10, color: NX.faint }}>
        {data.map((d, i) => <span key={i} style={{ flex: 1, textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.label}{labels ? ` (${d.value})` : ''}</span>)}
      </div>
    </div>
  );
}

function Lollipop({ data }) {
  if (data.length === 0) return <Empty />;
  const max = Math.max(...data.map((d) => d.value), 1);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {data.map((d, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
          <span style={{ width: 80, flexShrink: 0, color: NX.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.label}</span>
          <span style={{ position: 'relative', height: 10, flex: 1 }}>
            <span style={{ position: 'absolute', left: 0, top: 4, height: 2, width: `${(d.value / max) * 100}%`, background: d.color, opacity: 0.5, borderRadius: 999 }} />
            <span style={{ position: 'absolute', top: '50%', transform: 'translateY(-50%)', left: `calc(${(d.value / max) * 100}% - 5px)`, width: 10, height: 10, borderRadius: 999, background: d.color }} />
          </span>
          <span style={{ width: 24, textAlign: 'right', fontWeight: 700, color: NX.ink }}>{d.value}</span>
        </div>
      ))}
    </div>
  );
}

function ChartRenderer({ cfg, data }) {
  if (cfg.style === 'number') { const total = data.reduce((n, d) => n + d.value, 0); return <div style={{ height: 128, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 48, fontWeight: 700, color: NX.ink }}>{Number.isInteger(total) ? total : total.toFixed(1)}</div>; }
  if (cfg.style === 'donut') return data.length ? <Donut total={data.reduce((n, d) => n + d.value, 0)} segments={data} /> : <Empty />;
  if (cfg.style === 'line') return <LineChart data={data} labels={cfg.dataLabels} />;
  if (cfg.style === 'lollipop') return <Lollipop data={data} />;
  return data.length ? <LightBar data={data} /> : <Empty />;
}

export function CustomChartsPanel({ scopeKey, tasks, store }) {
  const [charts, setCharts] = useState(() => readAll()[scopeKey] ?? []);
  const [editing, setEditing] = useState(null);
  const [adding, setAdding] = useState(false);

  const persist = (next) => { const all = readAll(); all[scopeKey] = next; localStorage.setItem(KEY, JSON.stringify(all)); setCharts(next); };
  const save = (cfg) => persist(charts.some((c) => c.id === cfg.id) ? charts.map((c) => (c.id === cfg.id ? cfg : c)) : [...charts, cfg]);
  const remove = (id) => persist(charts.filter((c) => c.id !== id));

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '8px 2px 12px' }}>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: NX.ink }}>Custom Charts</h3>
        <button onClick={() => setAdding(true)} style={btn('outline')}><Plus size={14} />Add Chart</button>
      </div>
      {charts.length === 0 ? (
        <div style={{ borderRadius: 16, border: `1px dashed ${NX.border}`, background: NX.surface, padding: '32px 16px', textAlign: 'center', fontSize: 13, color: NX.faint }}>
          No custom charts yet. Click <span style={{ fontWeight: 700, color: NX.ink }}>Add Chart</span> to build one from any dimension, metric and filter.
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))', gap: 16 }}>
          {charts.map((cfg) => (
            <Card key={cfg.id} title={
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cfg.title}</span>
                <button onClick={() => setEditing(cfg)} title="Edit" style={{ ...btn('ghost'), padding: 4, color: NX.faint }}><Pencil size={13} /></button>
                <button onClick={() => remove(cfg.id)} title="Remove" style={{ ...btn('ghost'), padding: 4, color: NX.faint }}><Trash2 size={13} /></button>
              </span>
            }>
              <ChartRenderer cfg={cfg} data={computeSeries(cfg, tasks, store)} />
            </Card>
          ))}
        </div>
      )}
      {(adding || editing) && (
        <AddChartModal tasks={tasks} store={store} initial={editing}
          onClose={() => { setAdding(false); setEditing(null); }}
          onSave={(cfg) => { save(cfg); setAdding(false); setEditing(null); }} />
      )}
    </div>
  );
}

function MultiFilter({ label, options, selected, onToggle }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ borderRadius: 8, border: `1px solid ${NX.border}` }}>
      <button onClick={() => setOpen((o) => !o)} style={{ display: 'flex', width: '100%', alignItems: 'center', justifyContent: 'space-between', padding: '8px 10px', fontSize: 13, fontWeight: 500, color: NX.ink, background: 'transparent', border: 'none', cursor: 'pointer' }}>
        {label}{selected.length ? ` · ${selected.length}` : ''} <ChevronDown size={14} style={{ color: NX.faint, transform: open ? 'rotate(180deg)' : 'none' }} />
      </button>
      {open && (
        <div style={{ maxHeight: 160, overflow: 'auto', borderTop: `1px solid ${NX.border}`, padding: '4px 0' }}>
          {options.map((o) => (
            <button key={o.value} onClick={() => onToggle(o.value)} style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 8, padding: '6px 10px', textAlign: 'left', fontSize: 13, color: NX.ink, background: 'transparent', border: 'none', cursor: 'pointer' }}>
              <span style={{ display: 'flex', width: 16, height: 16, alignItems: 'center', justifyContent: 'center', borderRadius: 4, border: `1px solid ${selected.includes(o.value) ? NX.blue : NX.border}`, background: selected.includes(o.value) ? NX.blue : 'transparent', color: '#fff' }}>{selected.includes(o.value) && <Check size={11} />}</span>
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function AddChartModal({ tasks, store, initial, onClose, onSave }) {
  const [cfg, setCfg] = useState(initial || { id: `chart-${Date.now()}`, title: '', style: 'bar', dimension: 'status', metric: 'count', filters: { statuses: [], priorities: [], assigneeIds: [] }, dataLabels: true });
  const [titleTouched, setTitleTouched] = useState(!!initial);
  const patch = (p) => setCfg((c) => ({ ...c, ...p }));
  const title = titleTouched && cfg.title ? cfg.title : autoTitle(cfg);
  const data = useMemo(() => computeSeries({ ...cfg, title }, tasks, store), [cfg, title, tasks, store]);
  const toggle = (key, v) => setCfg((c) => { const arr = c.filters[key]; return { ...c, filters: { ...c.filters, [key]: arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v] } }; });

  const sel = { ...inputStyle, cursor: 'pointer', appearance: 'auto' };
  const lbl = { display: 'block', fontSize: 12, color: NX.dim, marginBottom: 4 };

  const initialCfgRef = useRef(cfg);
  const dirty = JSON.stringify(cfg) !== JSON.stringify(initialCfgRef.current);
  const guard = useUnsavedGuard(dirty, onClose, () => onSave({ ...cfg, title }));

  // Assignee filter options derived from tasks.
  const assignees = useMemo(() => {
    const seen = new Map();
    for (const t of tasks) if (t.assigneeId && !seen.has(t.assigneeId)) seen.set(t.assigneeId, store.nameOf?.(t.assigneeId) || t.assigneeId);
    return [...seen.entries()].map(([value, label]) => ({ value, label }));
  }, [tasks, store]);

  return (
    <div onMouseDown={(e) => e.target === e.currentTarget && guard.requestClose()} style={{ position: 'fixed', inset: 0, zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(17,24,39,0.45)', padding: 16, fontFamily: FONT }}>
      <div style={{ display: 'flex', flexDirection: 'column', height: '88vh', width: '100%', maxWidth: 1000, overflow: 'hidden', borderRadius: 16, border: `1px solid ${NX.border}`, background: NX.surface, boxShadow: '0 24px 60px rgba(0,0,0,0.28)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '13px 20px', borderBottom: `1px solid ${NX.border}`, flexShrink: 0 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>{initial ? 'Edit Chart' : 'Add Chart'}</h2>
          <button onClick={guard.requestClose} style={{ ...btn('ghost'), padding: 6 }}><X size={18} /></button>
        </div>
        <div style={{ display: 'flex', minHeight: 0, flex: 1, flexWrap: 'wrap' }}>
          {/* Preview */}
          <div className="nx-scroll" style={{ minWidth: 300, flex: '1 1 340px', overflow: 'auto', borderRight: `1px solid ${NX.border}`, padding: 24 }}>
            <input value={title} onChange={(e) => { setTitleTouched(true); patch({ title: e.target.value }); }}
              style={{ marginBottom: 16, width: '100%', border: '1px solid transparent', borderRadius: 8, background: 'transparent', fontSize: 20, fontWeight: 700, color: NX.ink, outline: 'none', padding: '4px 6px', fontFamily: FONT }} />
            <ChartRenderer cfg={{ ...cfg, title }} data={data} />
          </div>
          {/* Controls */}
          <div className="nx-scroll" style={{ width: 320, flexShrink: 0, overflow: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 18 }}>
            <div>
              <div style={{ marginBottom: 8, fontSize: 13, fontWeight: 700 }}>Chart Details</div>
              <label style={lbl}>Chart Style</label>
              <select value={cfg.style} onChange={(e) => patch({ style: e.target.value })} style={sel}>{STYLE_OPTIONS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select>
            </div>
            <div style={{ borderTop: `1px solid ${NX.border}`, paddingTop: 16 }}>
              <div style={{ marginBottom: 8, fontSize: 13, fontWeight: 700 }}>Chart Data</div>
              <label style={lbl}>X-Axis (Group By)</label>
              <select value={cfg.dimension} onChange={(e) => patch({ dimension: e.target.value })} style={sel}>{DIMENSIONS.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}</select>
              <label style={{ ...lbl, marginTop: 12 }}>Y-axis (metric)</label>
              <select value={cfg.metric} onChange={(e) => patch({ metric: e.target.value })} style={sel}>{METRICS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}</select>
            </div>
            <div style={{ borderTop: `1px solid ${NX.border}`, paddingTop: 16 }}>
              <div style={{ marginBottom: 8, fontSize: 13, fontWeight: 700 }}>Filters</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <MultiFilter label="Status" selected={cfg.filters.statuses} onToggle={(v) => toggle('statuses', v)}
                  options={[...STATUS_ORDER.map((s) => ({ value: s, label: STATUS_META[s].label })), ...store.customStatuses.map((s) => ({ value: s.id, label: s.label }))]} />
                <MultiFilter label="Priority" selected={cfg.filters.priorities} onToggle={(v) => toggle('priorities', v)}
                  options={PRIORITY_ORDER.map((p) => ({ value: p, label: PRIORITY_META[p].label }))} />
                <MultiFilter label="Assignee" selected={cfg.filters.assigneeIds} onToggle={(v) => toggle('assigneeIds', v)} options={assignees} />
              </div>
            </div>
            <div style={{ borderTop: `1px solid ${NX.border}`, paddingTop: 16 }}>
              <div style={{ marginBottom: 8, fontSize: 13, fontWeight: 700 }}>Data Annotations</div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: NX.ink, cursor: 'pointer' }}>
                <input type="checkbox" checked={cfg.dataLabels} onChange={(e) => patch({ dataLabels: e.target.checked })} /> Data labels
              </label>
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, padding: '13px 20px', borderTop: `1px solid ${NX.border}`, flexShrink: 0 }}>
          <button onClick={onClose} style={btn('outline')}>Cancel</button>
          <button onClick={() => onSave({ ...cfg, title })} style={btn('primary')}>{initial ? 'Save chart' : 'Add chart'}</button>
        </div>
      </div>
      {guard.confirming && (
        <UnsavedChangesPrompt onKeepEditing={guard.keepEditing} onDiscard={onClose} onSave={guard.saveAndClose} saving={guard.saving} />
      )}
    </div>
  );
}

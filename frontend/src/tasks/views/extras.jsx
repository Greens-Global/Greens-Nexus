// Task Module — Calendar (month/week grid, event typing) and Dashboard
// (KPIs + completion donut, department/assignee bars, time tracking, and a
// persisted Custom Charts builder). Ported from the export's NexusCalendarView
// / NexusDashboard + charts + CustomCharts to the Nexus inline-style idiom.
import { useState, useMemo, useCallback } from 'react';
import {
  ChevronLeft, ChevronRight, Diamond, Sliders, Check, CalendarDays, Video, Rocket,
  PartyPopper, Plus, BarChart3, LineChart as LineIcon, PieChart, Hash, Trash2, Pencil, ChevronDown, X,
} from 'lucide-react';
import { NX, FONT, STATUS_META, STATUS_ORDER, PRIORITY_META, card, btn, input as inputStyle, colorForKey } from '../theme';
import { taskStats } from '../lib';
import { Donut, BarList, Popover } from '../shared';

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const isoOf = (d) => { const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000); return z.toISOString().slice(0, 10); };

// ── Calendar ─────────────────────────────────────────────────────────────────
const KIND_META = {
  due:     { label: 'Due dates', color: '#2563eb', Icon: CalendarDays },
  meeting: { label: 'Meetings',  color: '#0891b2', Icon: Video },
  release: { label: 'Releases',  color: '#7c3aed', Icon: Rocket },
  holiday: { label: 'Holidays',  color: '#f59e0b', Icon: PartyPopper },
};

/** Fixed-date public holidays for a given year (extend as needed). */
function holidaysForYear(y) {
  return {
    [`${y}-01-01`]: "New Year's Day",
    [`${y}-06-19`]: 'Juneteenth',
    [`${y}-07-04`]: 'Independence Day',
    [`${y}-11-11`]: 'Veterans Day',
    [`${y}-12-25`]: 'Christmas Day',
    [`${y}-12-31`]: "New Year's Eve",
  };
}

export function CalendarView({ tasks, onOpen }) {
  const [cursor, setCursor] = useState(() => new Date());
  const [weekly, setWeekly] = useState(false);
  const [show, setShow] = useState({ due: true, meeting: true, release: true, holiday: true });

  const days = useMemo(() => {
    if (weekly) {
      const start = new Date(cursor);
      start.setDate(cursor.getDate() - cursor.getDay());
      return Array.from({ length: 7 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; });
    }
    const y = cursor.getFullYear(), m = cursor.getMonth();
    const start = new Date(y, m, 1 - new Date(y, m, 1).getDay());
    return Array.from({ length: 42 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; });
  }, [cursor, weekly]);

  const holidayMap = useMemo(() => {
    const years = new Set(days.map((d) => d.getFullYear()));
    return [...years].reduce((acc, y) => Object.assign(acc, holidaysForYear(y)), {});
  }, [days]);

  const byDate = useMemo(() => {
    const map = {};
    const push = (date, ev) => (map[date] ||= []).push(ev);
    for (const t of tasks) {
      if (!t.dueOn) continue;
      const isMeeting = (t.tags || []).some((tag) => String(tag).toLowerCase().includes('meeting'));
      if (t.isMilestone) {
        if (show.release) push(t.dueOn, { kind: 'release', label: t.title, color: KIND_META.release.color, tint: `${KIND_META.release.color}1a`, taskId: t.id, completed: t.completed, isMilestone: true });
      } else if (isMeeting) {
        if (show.meeting) push(t.dueOn, { kind: 'meeting', label: t.title, color: KIND_META.meeting.color, tint: `${KIND_META.meeting.color}1a`, taskId: t.id, completed: t.completed });
      } else if (show.due) {
        const meta = STATUS_META[t.status];
        push(t.dueOn, { kind: 'due', label: t.title, color: meta?.color || KIND_META.due.color, tint: meta?.tint || `${KIND_META.due.color}1a`, taskId: t.id, completed: t.completed });
      }
    }
    if (show.holiday) {
      for (const [iso, name] of Object.entries(holidayMap)) push(iso, { kind: 'holiday', label: name, color: KIND_META.holiday.color, tint: `${KIND_META.holiday.color}1a` });
    }
    const rank = { holiday: 0, release: 1, meeting: 2, due: 3 };
    for (const k of Object.keys(map)) map[k].sort((a, b) => rank[a.kind] - rank[b.kind]);
    return map;
  }, [tasks, show, holidayMap]);

  const todayIso = isoOf(new Date());
  const step = (dir) => setCursor((c) => (weekly ? new Date(c.getFullYear(), c.getMonth(), c.getDate() + dir * 7) : new Date(c.getFullYear(), c.getMonth() + dir, 1)));

  const rangeLabel = weekly
    ? (() => {
        const s = days[0], e = days[6];
        return s.getMonth() === e.getMonth()
          ? `${MONTHS_SHORT[s.getMonth()]} ${s.getDate()} – ${e.getDate()}, ${e.getFullYear()}`
          : `${MONTHS_SHORT[s.getMonth()]} ${s.getDate()} – ${MONTHS_SHORT[e.getMonth()]} ${e.getDate()}, ${e.getFullYear()}`;
      })()
    : `${MONTHS[cursor.getMonth()]} ${cursor.getFullYear()}`;

  const segBtn = (active) => ({ ...btn('ghost'), padding: '4px 10px', borderRadius: 6, fontSize: 12, fontWeight: 600, background: active ? NX.primary : 'transparent', color: active ? '#fff' : NX.dim });

  return (
    <div style={{ margin: 16, border: `1px solid ${NX.border}`, borderRadius: 14, background: NX.surface, fontFamily: FONT, overflow: 'hidden' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, borderBottom: `1px solid ${NX.border}`, padding: '10px 14px' }}>
        <button onClick={() => step(-1)} style={iconBtn}><ChevronLeft size={17} /></button>
        <span style={{ minWidth: 150, fontSize: 15, fontWeight: 700, color: NX.ink }}>{rangeLabel}</span>
        <button onClick={() => step(1)} style={iconBtn}><ChevronRight size={17} /></button>
        <button onClick={() => setCursor(new Date())} style={{ ...btn('outline'), padding: '5px 10px', fontSize: 12 }}>Today</button>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          <Popover align="right" width={210} trigger={(toggle) => (
            <button onClick={toggle} style={{ ...btn('outline'), padding: '6px 10px', fontSize: 12 }}><Sliders size={13} /> Show</button>
          )}>
            {() => (
              <>
                <div style={{ padding: '4px 9px', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: NX.faint }}>Show on calendar</div>
                {Object.keys(KIND_META).map((k) => {
                  const { label, color, Icon } = KIND_META[k];
                  const on = show[k];
                  return (
                    <div key={k} onClick={() => setShow((s) => ({ ...s, [k]: !s[k] }))} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 9px', borderRadius: 7, fontSize: 13, cursor: 'pointer', color: NX.ink }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = NX.hover; }} onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 16, height: 16, borderRadius: 4, border: `1px solid ${on ? color : NX.border}`, background: on ? color : 'transparent' }}>
                        {on && <Check size={11} color="#fff" />}
                      </span>
                      <Icon size={14} style={{ color }} />
                      <span style={{ flex: 1 }}>{label}</span>
                    </div>
                  );
                })}
              </>
            )}
          </Popover>

          <div style={{ display: 'flex', alignItems: 'center', border: `1px solid ${NX.border}`, borderRadius: 8, padding: 2 }}>
            <button onClick={() => setWeekly(false)} style={segBtn(!weekly)}>Month</button>
            <button onClick={() => setWeekly(true)} style={segBtn(weekly)}>Week</button>
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', borderBottom: `1px solid ${NX.border}` }}>
        {DOW.map((d) => <div key={d} style={{ padding: '8px 8px', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: NX.faint }}>{d}</div>)}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)' }}>
        {days.map((d, i) => {
          const iso = isoOf(d);
          const inMonth = weekly || d.getMonth() === cursor.getMonth();
          const events = byDate[iso] || [];
          const cap = weekly ? 8 : 3;
          const isToday = iso === todayIso;
          return (
            <div key={i} style={{ borderRight: `1px solid ${NX.border}`, borderBottom: `1px solid ${NX.border}`, padding: 6, minHeight: weekly ? 320 : 104, background: inMonth ? NX.surface : NX.surface2, opacity: inMonth ? 1 : 0.6 }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, borderRadius: '50%', fontSize: 11, fontWeight: 600, color: isToday ? '#fff' : NX.dim, background: isToday ? NX.primary : 'transparent' }}>{d.getDate()}</span>
              <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>
                {events.slice(0, cap).map((ev, j) => (
                  ev.taskId ? (
                    <button key={j} onClick={() => onOpen(ev.taskId)} title={`${KIND_META[ev.kind].label}: ${ev.label}`} style={{ display: 'flex', alignItems: 'center', gap: 4, border: 'none', borderRadius: 6, padding: '2px 6px', fontSize: 11, fontWeight: 500, cursor: 'pointer', textAlign: 'left', background: ev.tint, color: ev.color, overflow: 'hidden' }}>
                      {ev.isMilestone && <Diamond size={9} style={{ flexShrink: 0 }} />}
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textDecoration: ev.completed ? 'line-through' : 'none' }}>{ev.label}</span>
                    </button>
                  ) : (
                    <span key={j} title={`Holiday: ${ev.label}`} style={{ display: 'flex', alignItems: 'center', gap: 4, borderRadius: 6, padding: '2px 6px', fontSize: 11, fontWeight: 500, background: ev.tint, color: ev.color, overflow: 'hidden' }}>
                      <PartyPopper size={9} style={{ flexShrink: 0 }} />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ev.label}</span>
                    </span>
                  )
                ))}
                {events.length > cap && <span style={{ padding: '0 4px', fontSize: 10, color: NX.faint }}>+{events.length - cap} more</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
const iconBtn = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, borderRadius: 8, border: `1px solid ${NX.border}`, background: NX.surface, cursor: 'pointer', color: NX.dim };

// ── Dashboard ────────────────────────────────────────────────────────────────
export function DashboardView({ tasks, stats: pre, store }) {
  const stats = pre || taskStats(tasks);

  const byStatus = STATUS_ORDER.map((s) => ({ label: STATUS_META[s].label, value: tasks.filter((t) => t.status === s).length, color: STATUS_META[s].color }));
  const byDept = (store?.departments || []).map((d) => ({ label: d.name, value: tasks.filter((t) => t.departmentId === d.id).length, color: d.color || colorForKey(d.name) })).filter((d) => d.value > 0);
  const assignees = [...new Set(tasks.filter((t) => t.assigneeId).map((t) => t.assigneeId))];
  const byAssignee = assignees.map((email) => ({ label: String(store?.nameOf?.(email) || email).split(' ')[0], value: tasks.filter((t) => t.assigneeId === email).length, color: NX.blue })).filter((d) => d.value > 0);

  const totalEst = tasks.reduce((n, t) => n + (t.estimateHours || 0), 0);
  const totalAct = tasks.reduce((n, t) => n + (t.actualHours || 0), 0);
  const variance = totalAct - totalEst;

  const kpi = (label, value, color) => (
    <div style={{ ...card, padding: 16, flex: 1, minWidth: 150 }}>
      <div style={{ fontSize: 12.5, color: NX.dim, fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 800, color: color || NX.ink, marginTop: 4 }}>{value}</div>
    </div>
  );
  const panel = (title, children) => (
    <div style={{ ...card, padding: 18, flex: 1, minWidth: 300 }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: NX.ink, marginBottom: 14 }}>{title}</div>
      {children}
    </div>
  );

  return (
    <div style={{ padding: 16, fontFamily: FONT }}>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        {kpi('Total', stats.total)}
        {kpi('In progress', stats.inProgress, NX.blue)}
        {kpi('Completed', stats.completed, NX.green)}
        {kpi('Overdue', stats.overdue, NX.red)}
        {kpi('Complete', `${stats.pct}%`, NX.purple)}
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        {panel('Tasks by status', <BarList rows={byStatus} />)}
        {panel('Completion status', (
          <Donut
            centerValue={stats.total}
            centerLabel="Total"
            segments={[
              { label: 'Completed', value: stats.completed, color: '#16a34a' },
              { label: 'Incomplete', value: stats.total - stats.completed, color: '#7c3aed' },
            ]}
          />
        ))}
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        {panel('Tasks by department', byDept.length ? <BarList rows={byDept} /> : <div style={{ fontSize: 12, color: NX.faint }}>No data</div>)}
        {panel('Tasks by assignee', byAssignee.length ? <BarList rows={byAssignee} /> : <div style={{ fontSize: 12, color: NX.faint }}>No data</div>)}
      </div>

      <div style={{ ...card, padding: 18, marginBottom: 12 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: NX.ink, marginBottom: 14 }}>Time tracking — estimate vs actual</div>
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
          <div><div style={{ fontSize: 12, color: NX.dim }}>Estimated</div><div style={{ fontSize: 28, fontWeight: 800, color: NX.ink }}>{totalEst}h</div></div>
          <div><div style={{ fontSize: 12, color: NX.dim }}>Actual</div><div style={{ fontSize: 28, fontWeight: 800, color: NX.blue }}>{totalAct}h</div></div>
          <div><div style={{ fontSize: 12, color: NX.dim }}>Variance</div><div style={{ fontSize: 28, fontWeight: 800, color: variance > 0 ? NX.red : NX.green }}>{variance >= 0 ? '+' : ''}{variance.toFixed(1)}h</div></div>
        </div>
      </div>

      <CustomChartsPanel scopeKey="workspace" tasks={tasks} store={store} />
    </div>
  );
}

// ── Custom Charts ────────────────────────────────────────────────────────────
const STYLE_META = [
  { key: 'bar', label: 'Bar', Icon: BarChart3 },
  { key: 'lollipop', label: 'Lollipop', Icon: BarChart3 },
  { key: 'line', label: 'Line', Icon: LineIcon },
  { key: 'donut', label: 'Donut', Icon: PieChart },
  { key: 'number', label: 'Number', Icon: Hash },
];
const DIMENSION_LABEL = { status: 'Status', priority: 'Priority', assignee: 'Assignee', project: 'Project', department: 'Department' };
const METRIC_LABEL = { count: 'Task count', sum_estimate: 'Estimated hours', sum_actual: 'Actual hours' };
const PALETTE = ['#2563eb', '#16a34a', '#f59e0b', '#7c3aed', '#dc2626', '#0891b2', '#db2777', '#65a30d'];

function autoTitle(cfg) {
  const m = cfg.metric === 'count' ? 'Total tasks' : cfg.metric === 'sum_estimate' ? 'Estimated hours' : 'Actual hours';
  return `${m} by ${DIMENSION_LABEL[cfg.dimension].toLowerCase()}`;
}

const CC_KEY = 'nexus.customCharts';
function ccReadAll() { try { return JSON.parse(localStorage.getItem(CC_KEY) || '{}'); } catch { return {}; } }
function useCustomCharts(scopeKey) {
  const [charts, setCharts] = useState(() => ccReadAll()[scopeKey] || []);
  const persist = useCallback((next) => { const all = ccReadAll(); all[scopeKey] = next; localStorage.setItem(CC_KEY, JSON.stringify(all)); setCharts(next); }, [scopeKey]);
  const save = useCallback((cfg) => persist(charts.some((c) => c.id === cfg.id) ? charts.map((c) => (c.id === cfg.id ? cfg : c)) : [...charts, cfg]), [charts, persist]);
  const remove = useCallback((id) => persist(charts.filter((c) => c.id !== id)), [charts, persist]);
  return { charts, save, remove };
}

// Nexus store has no users/statusMeta — derive them from tasks + customStatuses.
function statusMetaOf(store) {
  const extra = (store?.customStatuses || []).reduce((acc, s) => { acc[s.id] = { label: s.label || s.name || s.id, color: s.color || '#64748b' }; return acc; }, {});
  return { ...STATUS_META, ...extra };
}
function usersOf(store) {
  const emails = [...new Set((store?.tasks || []).filter((t) => t.assigneeId).map((t) => t.assigneeId))];
  return emails.map((email) => ({ id: email, name: String(store?.nameOf?.(email) || email) }));
}

function passesFilters(t, f) {
  if (f.statuses.length && !f.statuses.includes(t.status)) return false;
  if (f.priorities.length && !f.priorities.includes(t.priority)) return false;
  if (f.assigneeIds.length && !(t.assigneeId && f.assigneeIds.includes(t.assigneeId))) return false;
  return true;
}

function computeSeries(cfg, tasks, store) {
  const statusMeta = statusMetaOf(store);
  const users = usersOf(store);
  const rows = tasks.filter((t) => passesFilters(t, cfg.filters));
  const val = (group) =>
    cfg.metric === 'count' ? group.length
      : cfg.metric === 'sum_estimate' ? group.reduce((n, t) => n + (t.estimateHours || 0), 0)
        : group.reduce((n, t) => n + (t.actualHours || 0), 0);

  if (cfg.dimension === 'status') {
    const keys = [...STATUS_ORDER, ...(store?.customStatuses || []).map((s) => s.id)];
    return keys.map((s) => ({ label: statusMeta[s]?.label || s, value: val(rows.filter((t) => t.status === s)), color: statusMeta[s]?.color || '#64748b' })).filter((d) => d.value > 0);
  }
  if (cfg.dimension === 'priority') {
    return Object.keys(PRIORITY_META).map((p) => ({ label: PRIORITY_META[p].label, value: val(rows.filter((t) => t.priority === p)), color: PRIORITY_META[p].color })).filter((d) => d.value > 0);
  }
  if (cfg.dimension === 'department') {
    return (store?.departments || []).map((d) => ({ label: d.name, value: val(rows.filter((t) => t.departmentId === d.id)), color: d.color || colorForKey(d.name) })).filter((d) => d.value > 0);
  }
  if (cfg.dimension === 'project') {
    return (store?.projects || []).map((p, i) => ({ label: p.name, value: val(rows.filter((t) => t.projectId === p.id)), color: PALETTE[i % PALETTE.length] })).filter((d) => d.value > 0);
  }
  const out = users.map((u, i) => ({ label: u.name.split(' ')[0], value: val(rows.filter((t) => t.assigneeId === u.id)), color: PALETTE[i % PALETTE.length] })).filter((d) => d.value > 0);
  const un = val(rows.filter((t) => !t.assigneeId));
  if (un > 0) out.push({ label: 'Unassigned', value: un, color: '#94a3b8' });
  return out;
}

function ChartEmpty() { return <div style={{ padding: '32px 0', textAlign: 'center', fontSize: 12, color: NX.faint }}>No matching data.</div>; }

function LineChart({ data, labels }) {
  if (!data.length) return <ChartEmpty />;
  const max = Math.max(...data.map((d) => d.value), 1);
  const w = 100, h = 46, pad = 4;
  const step = data.length > 1 ? (w - pad * 2) / (data.length - 1) : 0;
  const pts = data.map((d, i) => [pad + i * step, h - pad - (d.value / max) * (h - pad * 2)]);
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  return (
    <div>
      <svg viewBox={`0 0 ${w} ${h}`} style={{ height: 160, width: '100%' }} preserveAspectRatio="none">
        <path d={path} fill="none" stroke="#7c3aed" strokeWidth={0.8} vectorEffect="non-scaling-stroke" />
        {pts.map((p, i) => <circle key={i} cx={p[0]} cy={p[1]} r={1.1} fill="#7c3aed" />)}
      </svg>
      <div style={{ marginTop: 4, display: 'flex', justifyContent: 'space-between', fontSize: 10, color: NX.faint }}>
        {data.map((d, i) => <span key={i} style={{ flex: 1, textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.label}{labels ? ` (${d.value})` : ''}</span>)}
      </div>
    </div>
  );
}

function Lollipop({ data }) {
  if (!data.length) return <ChartEmpty />;
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
          <span style={{ width: 28, textAlign: 'right', fontWeight: 700, color: NX.ink }}>{d.value}</span>
        </div>
      ))}
    </div>
  );
}

function NumberTile({ data }) {
  const total = data.reduce((n, d) => n + d.value, 0);
  return <div style={{ display: 'flex', height: 128, alignItems: 'center', justifyContent: 'center', fontSize: 48, fontWeight: 800, color: NX.ink }}>{Number.isInteger(total) ? total : total.toFixed(1)}</div>;
}

function ChartRenderer({ cfg, data }) {
  if (cfg.style === 'number') return <NumberTile data={data} />;
  if (cfg.style === 'donut') return data.length ? <Donut centerValue={data.reduce((n, d) => n + d.value, 0)} segments={data} /> : <ChartEmpty />;
  if (cfg.style === 'line') return <LineChart data={data} labels={cfg.dataLabels} />;
  if (cfg.style === 'lollipop') return <Lollipop data={data} />;
  return data.length ? <BarList rows={data} /> : <ChartEmpty />;
}

function CustomChartsPanel({ scopeKey, tasks, store }) {
  const { charts, save, remove } = useCustomCharts(scopeKey);
  const [editing, setEditing] = useState(null);
  const [adding, setAdding] = useState(false);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '8px 2px 12px' }}>
        <h3 style={{ fontSize: 15, fontWeight: 700, color: NX.ink, margin: 0 }}>Custom charts</h3>
        <button onClick={() => setAdding(true)} style={{ ...btn('outline'), fontSize: 12 }}><Plus size={14} /> Add chart</button>
      </div>
      {charts.length === 0 ? (
        <div style={{ border: `1px dashed ${NX.border}`, borderRadius: 14, background: NX.surface, padding: '32px 16px', textAlign: 'center', fontSize: 13, color: NX.faint }}>
          No custom charts yet. Click <span style={{ fontWeight: 600, color: NX.ink }}>Add chart</span> to build one from any dimension, metric and filter.
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 14 }}>
          {charts.map((cfg) => (
            <div key={cfg.id} style={{ ...card, padding: 18 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
                <span style={{ flex: 1, fontSize: 14, fontWeight: 700, color: NX.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cfg.title}</span>
                <button onClick={() => setEditing(cfg)} title="Edit" style={{ ...btn('ghost'), padding: 4, color: NX.faint }}><Pencil size={13} /></button>
                <button onClick={() => remove(cfg.id)} title="Remove" style={{ ...btn('ghost'), padding: 4, color: NX.faint }}><Trash2 size={13} /></button>
              </div>
              <ChartRenderer cfg={cfg} data={computeSeries(cfg, tasks, store)} />
            </div>
          ))}
        </div>
      )}

      {(adding || editing) && (
        <AddChartModal
          tasks={tasks}
          store={store}
          initial={editing}
          onClose={() => { setAdding(false); setEditing(null); }}
          onSave={(cfg) => { save(cfg); setAdding(false); setEditing(null); }}
        />
      )}
    </div>
  );
}

function Select({ value, onChange, options }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

function MultiFilter({ label, options, selected, onToggle }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ border: `1px solid ${NX.border}`, borderRadius: 8 }}>
      <button onClick={() => setOpen((o) => !o)} style={{ display: 'flex', width: '100%', alignItems: 'center', justifyContent: 'space-between', padding: '8px 10px', fontSize: 13, fontWeight: 500, color: NX.ink, background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: FONT }}>
        <span>{label}{selected.length ? ` · ${selected.length}` : ''}</span>
        <ChevronDown size={14} style={{ color: NX.faint, transform: open ? 'rotate(180deg)' : 'none' }} />
      </button>
      {open && (
        <div style={{ maxHeight: 160, overflow: 'auto', borderTop: `1px solid ${NX.border}`, padding: '4px 0' }}>
          {options.map((o) => {
            const on = selected.includes(o.value);
            return (
              <button key={o.value} onClick={() => onToggle(o.value)} style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 8, padding: '6px 10px', textAlign: 'left', fontSize: 13, color: NX.ink, background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: FONT }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 16, height: 16, borderRadius: 4, border: `1px solid ${on ? NX.blue : NX.border}`, background: on ? NX.blue : 'transparent', color: '#fff' }}>{on && <Check size={11} />}</span>
                {o.label}
              </button>
            );
          })}
          {options.length === 0 && <div style={{ padding: '6px 10px', fontSize: 12, color: NX.faint }}>No options</div>}
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

  const toggle = (key, v) => setCfg((c) => {
    const arr = c.filters[key];
    return { ...c, filters: { ...c.filters, [key]: arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v] } };
  });

  const statusMeta = statusMetaOf(store);
  const users = usersOf(store);
  const sectionHead = { fontSize: 13, fontWeight: 700, color: NX.ink, marginBottom: 8 };
  const lbl = { display: 'block', fontSize: 12, color: NX.dim, margin: '0 0 4px' };

  return (
    <div onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} style={{ position: 'fixed', inset: 0, zIndex: 5000, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(17,24,39,0.45)', padding: 16, fontFamily: FONT }}>
      <div style={{ display: 'flex', flexDirection: 'column', height: '88vh', width: '100%', maxWidth: 1100, overflow: 'hidden', borderRadius: 16, border: `1px solid ${NX.border}`, background: NX.surface, boxShadow: '0 24px 60px rgba(0,0,0,0.3)' }}>
        <div style={{ display: 'flex', flexShrink: 0, alignItems: 'center', justifyContent: 'space-between', borderBottom: `1px solid ${NX.border}`, padding: '13px 20px' }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, color: NX.ink, margin: 0 }}>{initial ? 'Edit chart' : 'Add chart'}</h2>
          <button onClick={onClose} style={{ ...btn('ghost'), padding: 6 }}><X size={18} /></button>
        </div>
        <div style={{ display: 'flex', minHeight: 0, flex: 1, flexWrap: 'wrap' }}>
          <div style={{ minHeight: 0, flex: '1 1 340px', overflow: 'auto', borderRight: `1px solid ${NX.border}`, padding: 24 }}>
            <input value={title} onChange={(e) => { setTitleTouched(true); patch({ title: e.target.value }); }} style={{ ...inputStyle, fontSize: 20, fontWeight: 700, border: '1px solid transparent', marginBottom: 16 }} />
            <ChartRenderer cfg={{ ...cfg, title }} data={data} />
          </div>
          <div style={{ width: 320, flexShrink: 0, overflow: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 20 }}>
            <div>
              <div style={sectionHead}>Chart details</div>
              <label style={lbl}>Chart style</label>
              <Select value={cfg.style} onChange={(v) => patch({ style: v })} options={STYLE_META.map((s) => ({ value: s.key, label: s.label }))} />
            </div>
            <div style={{ borderTop: `1px solid ${NX.border}`, paddingTop: 16 }}>
              <div style={sectionHead}>Chart data</div>
              <label style={lbl}>X-axis (group by)</label>
              <Select value={cfg.dimension} onChange={(v) => patch({ dimension: v })} options={Object.keys(DIMENSION_LABEL).map((d) => ({ value: d, label: DIMENSION_LABEL[d] }))} />
              <label style={{ ...lbl, marginTop: 12 }}>Y-axis (metric)</label>
              <Select value={cfg.metric} onChange={(v) => patch({ metric: v })} options={Object.keys(METRIC_LABEL).map((m) => ({ value: m, label: METRIC_LABEL[m] }))} />
            </div>
            <div style={{ borderTop: `1px solid ${NX.border}`, paddingTop: 16 }}>
              <div style={sectionHead}>Filters</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <MultiFilter label="Status" selected={cfg.filters.statuses} onToggle={(v) => toggle('statuses', v)}
                  options={[...STATUS_ORDER, ...(store?.customStatuses || []).map((s) => s.id)].map((s) => ({ value: s, label: statusMeta[s]?.label || s }))} />
                <MultiFilter label="Priority" selected={cfg.filters.priorities} onToggle={(v) => toggle('priorities', v)}
                  options={Object.keys(PRIORITY_META).map((p) => ({ value: p, label: PRIORITY_META[p].label }))} />
                <MultiFilter label="Assignee" selected={cfg.filters.assigneeIds} onToggle={(v) => toggle('assigneeIds', v)}
                  options={users.map((u) => ({ value: u.id, label: u.name }))} />
              </div>
            </div>
            <div style={{ borderTop: `1px solid ${NX.border}`, paddingTop: 16 }}>
              <div style={sectionHead}>Data annotations</div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: NX.ink }}>
                <input type="checkbox" checked={cfg.dataLabels} onChange={(e) => patch({ dataLabels: e.target.checked })} /> Data labels
              </label>
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', flexShrink: 0, alignItems: 'center', justifyContent: 'flex-end', gap: 8, borderTop: `1px solid ${NX.border}`, padding: '13px 20px' }}>
          <button onClick={onClose} style={{ ...btn('outline') }}>Cancel</button>
          <button onClick={() => onSave({ ...cfg, title })} style={{ ...btn('primary') }}>{initial ? 'Save chart' : 'Add chart'}</button>
        </div>
      </div>
    </div>
  );
}

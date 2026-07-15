// Task Module — Calendar (month/week with event categories + Show filter) and
// Dashboard (KPIs, status/dept/assignee bars, completion donut, time tracking,
// custom charts). Ported 1:1 from the export's NexusCalendarView / NexusDashboard.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Diamond, Sliders, Check, CalendarDays, Video, Rocket, PartyPopper } from 'lucide-react';
import { NX, FONT, btn, STATUS_META, STATUS_ORDER } from '../theme';
import { taskStats } from '../lib';
import { Card, LightBar, Donut, CustomChartsPanel } from './charts';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const toISO = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const KIND_META = {
  due: { label: 'Due dates', color: '#2563eb', Icon: CalendarDays },
  meeting: { label: 'Meetings', color: '#0891b2', Icon: Video },
  release: { label: 'Releases', color: '#7c3aed', Icon: Rocket },
  holiday: { label: 'Holidays', color: '#f59e0b', Icon: PartyPopper },
};

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
  const [showOpen, setShowOpen] = useState(false);
  const showRef = useRef(null);

  useEffect(() => {
    if (!showOpen) return;
    const onDown = (e) => { if (showRef.current && !showRef.current.contains(e.target)) setShowOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [showOpen]);

  const days = useMemo(() => {
    if (weekly) {
      const start = new Date(cursor); start.setDate(cursor.getDate() - cursor.getDay());
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
      const isMeeting = t.tags?.some((tag) => tag.toLowerCase().includes('meeting'));
      if (t.isMilestone) {
        if (show.release) push(t.dueOn, { kind: 'release', label: t.title, color: KIND_META.release.color, tint: `${KIND_META.release.color}1a`, taskId: t.id, completed: t.completed, isMilestone: true });
      } else if (isMeeting) {
        if (show.meeting) push(t.dueOn, { kind: 'meeting', label: t.title, color: KIND_META.meeting.color, tint: `${KIND_META.meeting.color}1a`, taskId: t.id, completed: t.completed });
      } else if (show.due) {
        const meta = STATUS_META[t.status];
        push(t.dueOn, { kind: 'due', label: t.title, color: meta?.color ?? KIND_META.due.color, tint: meta?.tint ?? `${KIND_META.due.color}1a`, taskId: t.id, completed: t.completed });
      }
    }
    if (show.holiday) for (const [iso, name] of Object.entries(holidayMap)) push(iso, { kind: 'holiday', label: name, color: KIND_META.holiday.color, tint: `${KIND_META.holiday.color}1a` });
    const rank = { holiday: 0, release: 1, meeting: 2, due: 3 };
    for (const k of Object.keys(map)) map[k].sort((a, b) => rank[a.kind] - rank[b.kind]);
    return map;
  }, [tasks, show, holidayMap]);

  const todayIso = toISO(new Date());
  const step = (dir) => setCursor((c) => (weekly ? new Date(c.getFullYear(), c.getMonth(), c.getDate() + dir * 7) : new Date(c.getFullYear(), c.getMonth() + dir, 1)));

  const rangeLabel = weekly
    ? (() => { const s = days[0], e = days[6]; return s.getMonth() === e.getMonth() ? `${MONTHS_SHORT[s.getMonth()]} ${s.getDate()} – ${e.getDate()}, ${e.getFullYear()}` : `${MONTHS_SHORT[s.getMonth()]} ${s.getDate()} – ${MONTHS_SHORT[e.getMonth()]} ${e.getDate()}, ${e.getFullYear()}`; })()
    : `${MONTHS[cursor.getMonth()]} ${cursor.getFullYear()}`;

  const seg = (active) => ({ borderRadius: 7, padding: '4px 10px', fontSize: 12, fontWeight: 600, cursor: 'pointer', border: 'none', background: active ? NX.primary : 'transparent', color: active ? '#fff' : NX.dim });

  return (
    <div style={{ margin: 16, borderRadius: 16, border: `1px solid ${NX.border}`, background: NX.surface, fontFamily: FONT }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, borderBottom: `1px solid ${NX.border}`, padding: '12px 16px' }}>
        <button onClick={() => step(-1)} style={{ ...btn('ghost'), padding: 4 }}><ChevronLeft size={18} /></button>
        <span style={{ minWidth: 150, fontSize: 15, fontWeight: 700, color: NX.ink }}>{rangeLabel}</span>
        <button onClick={() => step(1)} style={{ ...btn('ghost'), padding: 4 }}><ChevronRight size={18} /></button>
        <button onClick={() => setCursor(new Date())} style={{ ...btn('outline'), fontSize: 12 }}>Today</button>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          <div ref={showRef} style={{ position: 'relative' }}>
            <button onClick={() => setShowOpen((o) => !o)} style={{ ...btn('outline'), fontSize: 12 }}><Sliders size={13} />Show</button>
            {showOpen && (
              <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: 4, width: 208, background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,0.16)', zIndex: 40, padding: '4px 0' }}>
                <div style={{ padding: '4px 12px', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: NX.faint }}>Show on calendar</div>
                {Object.keys(KIND_META).map((k) => {
                  const { label, color, Icon } = KIND_META[k]; const on = show[k];
                  return (
                    <button key={k} onClick={() => setShow((s) => ({ ...s, [k]: !s[k] }))} style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 10, padding: '6px 12px', textAlign: 'left', fontSize: 13, background: 'transparent', border: 'none', cursor: 'pointer' }}>
                      <span style={{ display: 'flex', width: 16, height: 16, alignItems: 'center', justifyContent: 'center', borderRadius: 4, border: `1px solid ${on ? color : NX.border}`, background: on ? color : 'transparent', color: '#fff' }}>{on && <Check size={11} />}</span>
                      <Icon size={14} style={{ color }} />
                      <span style={{ flex: 1, color: NX.ink }}>{label}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', borderRadius: 8, border: `1px solid ${NX.border}`, padding: 2 }}>
            <button onClick={() => setWeekly(false)} style={seg(!weekly)}>Month</button>
            <button onClick={() => setWeekly(true)} style={seg(weekly)}>Week</button>
          </div>
        </div>
      </div>
      {/* Weekday header */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', borderBottom: `1px solid ${NX.border}` }}>
        {WEEKDAYS.map((d) => <div key={d} style={{ padding: '8px', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: NX.faint }}>{d}</div>)}
      </div>
      {/* Day grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)' }}>
        {days.map((d) => {
          const iso = toISO(d);
          const inMonth = weekly || d.getMonth() === cursor.getMonth();
          const events = byDate[iso] ?? [];
          const cap = weekly ? 8 : 3;
          return (
            <div key={iso} style={{ borderBottom: `1px solid ${NX.border}`, borderRight: `1px solid ${NX.border}`, padding: 6, minHeight: weekly ? 320 : 104, background: inMonth ? NX.surface : NX.surface2, opacity: inMonth ? 1 : 0.6 }}>
              <span style={{ display: 'inline-flex', width: 24, height: 24, alignItems: 'center', justifyContent: 'center', borderRadius: '50%', fontSize: 11, fontWeight: 600, background: iso === todayIso ? NX.primary : 'transparent', color: iso === todayIso ? '#fff' : NX.dim }}>{d.getDate()}</span>
              <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>
                {events.slice(0, cap).map((ev, i) => ev.taskId ? (
                  <button key={i} onClick={() => onOpen(ev.taskId)} title={`${KIND_META[ev.kind].label}: ${ev.label}`} style={{ display: 'flex', alignItems: 'center', gap: 4, borderRadius: 6, padding: '2px 6px', textAlign: 'left', fontSize: 11, fontWeight: 500, border: 'none', cursor: 'pointer', background: ev.tint, color: ev.color, overflow: 'hidden' }}>
                    {ev.isMilestone && <Diamond size={9} style={{ flexShrink: 0 }} />}
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textDecoration: ev.completed ? 'line-through' : 'none' }}>{ev.label}</span>
                  </button>
                ) : (
                  <span key={i} title={`Holiday: ${ev.label}`} style={{ display: 'flex', alignItems: 'center', gap: 4, borderRadius: 6, padding: '2px 6px', fontSize: 11, fontWeight: 500, background: ev.tint, color: ev.color, overflow: 'hidden' }}>
                    <PartyPopper size={9} style={{ flexShrink: 0 }} /><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ev.label}</span>
                  </span>
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

export function DashboardView({ tasks, stats: pre, store, scopeKey = 'workspace' }) {
  const stats = (pre && pre.total != null) ? pre : taskStats(tasks);
  const byStatus = STATUS_ORDER.map((s) => ({ label: STATUS_META[s].label, value: tasks.filter((t) => t.status === s).length, color: STATUS_META[s].color }));
  const byDept = (store.departments || []).map((d) => ({ label: d.name, value: tasks.filter((t) => t.departmentId === d.id).length, color: d.color || NX.blue })).filter((d) => d.value > 0);

  const byAssignee = useMemo(() => {
    const seen = new Map();
    for (const t of tasks) if (t.assigneeId && !seen.has(t.assigneeId)) seen.set(t.assigneeId, (store.nameOf?.(t.assigneeId) || t.assigneeId).split(' ')[0]);
    return [...seen.entries()].map(([id, label]) => ({ label, value: tasks.filter((t) => t.assigneeId === id).length, color: NX.blue })).filter((d) => d.value > 0);
  }, [tasks, store]);

  const totalEst = tasks.reduce((n, t) => n + (t.estimateHours ?? 0), 0);
  const totalAct = tasks.reduce((n, t) => n + (t.actualHours ?? 0), 0);
  const variance = totalAct - totalEst;

  const kpi = (label, value, color) => (
    <div style={{ borderRadius: 16, border: `1px solid ${NX.border}`, background: NX.surface, padding: 20 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: NX.dim }}>{label}</div>
      <div style={{ marginTop: 12, fontSize: 34, fontWeight: 700, lineHeight: 1, color }}>{value}</div>
    </div>
  );

  return (
    <div style={{ padding: 16, fontFamily: FONT, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16 }}>
        {kpi('Completed', stats.completed, NX.green)}
        {kpi('In progress', stats.inProgress, NX.blue)}
        {kpi('Overdue', stats.overdue, NX.red)}
        {kpi('Total', stats.total, NX.ink)}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))', gap: 16 }}>
        <Card title="Tasks by status"><LightBar data={byStatus} /></Card>
        <Card title="Completion status"><Donut total={stats.total} segments={[{ label: 'Completed', value: stats.completed, color: NX.green }, { label: 'Incomplete', value: stats.total - stats.completed, color: NX.purple }]} /></Card>
        <Card title="Tasks by department"><LightBar data={byDept} /></Card>
        <Card title="Tasks by assignee"><LightBar data={byAssignee} /></Card>
      </div>

      <Card title="Time tracking — estimate vs actual">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
          <div><div style={{ fontSize: 12, color: NX.dim }}>Estimated</div><div style={{ fontSize: 28, fontWeight: 700, color: NX.ink }}>{totalEst}h</div></div>
          <div><div style={{ fontSize: 12, color: NX.dim }}>Actual</div><div style={{ fontSize: 28, fontWeight: 700, color: NX.blue }}>{totalAct}h</div></div>
          <div><div style={{ fontSize: 12, color: NX.dim }}>Variance</div><div style={{ fontSize: 28, fontWeight: 700, color: variance > 0 ? NX.red : NX.green }}>{variance >= 0 ? '+' : ''}{variance.toFixed(1)}h</div></div>
        </div>
      </Card>

      <CustomChartsPanel scopeKey={scopeKey} tasks={tasks} store={store} />
    </div>
  );
}

// Task Module — Calendar (month grid) and Dashboard (stats) views.
import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { NX, FONT, STATUS_META, STATUS_ORDER, PRIORITY_META, PRIORITY_ORDER, card } from '../theme';
import { taskStats } from '../lib';

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function CalendarView({ tasks, onOpen }) {
  const [cursor, setCursor] = useState(() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() }; });
  const first = new Date(cursor.y, cursor.m, 1);
  const start = new Date(first); start.setDate(1 - first.getDay());
  const cells = Array.from({ length: 42 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; });
  const iso = (d) => d.toISOString().slice(0, 10);
  const byDay = {};
  for (const t of tasks) if (t.dueOn) (byDay[t.dueOn] ||= []).push(t);
  const monthLabel = first.toLocaleString('default', { month: 'long', year: 'numeric' });
  const shift = (n) => setCursor((c) => { const d = new Date(c.y, c.m + n, 1); return { y: d.getFullYear(), m: d.getMonth() }; });

  return (
    <div style={{ padding: 16, fontFamily: FONT }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <button onClick={() => shift(-1)} style={iconBtn}><ChevronLeft size={17} /></button>
        <div style={{ fontSize: 16, fontWeight: 700, minWidth: 170 }}>{monthLabel}</div>
        <button onClick={() => shift(1)} style={iconBtn}><ChevronRight size={17} /></button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 6 }}>
        {DOW.map((d) => <div key={d} style={{ fontSize: 11.5, fontWeight: 700, color: NX.faint, textAlign: 'center', padding: 4 }}>{d}</div>)}
        {cells.map((d, i) => {
          const inMonth = d.getMonth() === cursor.m;
          const items = byDay[iso(d)] || [];
          const isToday = iso(d) === iso(new Date());
          return (
            <div key={i} style={{ ...card, minHeight: 92, padding: 6, opacity: inMonth ? 1 : 0.45, background: NX.surface }}>
              <div style={{ fontSize: 11.5, fontWeight: 600, color: isToday ? NX.blue : NX.dim, marginBottom: 4 }}>{d.getDate()}</div>
              {items.slice(0, 3).map((t) => (
                <div key={t.id} onClick={() => onOpen(t.id)} title={t.title} style={{ fontSize: 11, padding: '2px 5px', borderRadius: 5, marginBottom: 3, cursor: 'pointer', color: STATUS_META[t.status]?.color || NX.ink, background: STATUS_META[t.status]?.tint || NX.border2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.title}</div>
              ))}
              {items.length > 3 && <div style={{ fontSize: 10.5, color: NX.faint }}>+{items.length - 3} more</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
const iconBtn = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, borderRadius: 8, border: `1px solid ${NX.border}`, background: NX.surface, cursor: 'pointer', color: NX.dim };

export function DashboardView({ tasks, stats: pre, store }) {
  const stats = pre || taskStats(tasks);
  const byStatus = STATUS_ORDER.map((s) => ({ ...STATUS_META[s], key: s, n: tasks.filter((t) => t.status === s).length }));
  const byPriority = PRIORITY_ORDER.map((p) => ({ ...PRIORITY_META[p], key: p, n: tasks.filter((t) => t.priority === p).length }));
  const kpi = (label, value, color) => (
    <div style={{ ...card, padding: 16, flex: 1, minWidth: 150 }}>
      <div style={{ fontSize: 12.5, color: NX.dim, fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 800, color: color || NX.ink, marginTop: 4 }}>{value}</div>
    </div>
  );
  const bar = (rows) => (
    <div style={{ ...card, padding: 16, flex: 1, minWidth: 260 }}>
      {rows.map((r) => {
        const pct = stats.total ? Math.round((r.n / stats.total) * 100) : 0;
        return (
          <div key={r.key} style={{ marginBottom: 11 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, marginBottom: 4 }}><span style={{ color: NX.ink, fontWeight: 600 }}>{r.label}</span><span style={{ color: NX.faint }}>{r.n}</span></div>
            <div style={{ height: 8, borderRadius: 6, background: NX.border2, overflow: 'hidden' }}><div style={{ width: `${pct}%`, height: '100%', background: r.color }} /></div>
          </div>
        );
      })}
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
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 260 }}><div style={{ fontSize: 13, fontWeight: 700, margin: '2px 2px 8px' }}>By status</div>{bar(byStatus)}</div>
        <div style={{ flex: 1, minWidth: 260 }}><div style={{ fontSize: 13, fontWeight: 700, margin: '2px 2px 8px' }}>By priority</div>{bar(byPriority)}</div>
      </div>
    </div>
  );
}

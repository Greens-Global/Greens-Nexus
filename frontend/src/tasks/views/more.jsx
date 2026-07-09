// Task Module — additional view kinds: Timeline (gantt), Files (attachment
// gallery), Workload (per-assignee load). Ported from the export's
// NexusTimelineView / NexusFilesView / NexusWorkloadView to the Nexus idiom.
import { useEffect, useMemo, useState } from 'react';
import { Diamond, File, FileImage, FileText, Paperclip, Search, AlertTriangle, Download } from 'lucide-react';
import { api } from '../../api';
import { NX, FONT, btn, input as inputStyle, STATUS_META } from '../theme';
import { Avatar, EmptyState } from '../components';

const DAY = 86400000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const toISO = (d) => d.toISOString().slice(0, 10);
const fromISO = (s) => new Date(s + 'T00:00:00');
const addDays = (iso, n) => { const d = fromISO(iso); d.setDate(d.getDate() + n); return toISO(d); };
const fmtDate = (iso) => { if (!iso) return ''; const d = new Date(iso.length <= 10 ? iso + 'T00:00:00' : iso); return isNaN(d) ? iso : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); };

// ── Timeline (gantt) ─────────────────────────────────────────────────────────
const DAY_W = 26, ROW_H = 44, LABEL_W = 230;
export function TimelineView({ tasks, onOpen }) {
  const rows = useMemo(() => tasks.filter((t) => t.startOn || t.dueOn), [tasks]);
  const { start, totalDays } = useMemo(() => {
    const dates = rows.flatMap((t) => [t.startOn, t.dueOn].filter(Boolean));
    const min = dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : toISO(new Date());
    const max = dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : toISO(new Date());
    const s = addDays(min, -3);
    const days = Math.max(42, Math.round((fromISO(max).getTime() - fromISO(s).getTime()) / DAY) + 10);
    return { start: s, totalDays: days };
  }, [rows]);

  if (rows.length === 0) {
    return <div style={{ padding: 16 }}><EmptyState icon={Diamond} title="Nothing scheduled" hint="Give tasks a start or due date to see them on the timeline." /></div>;
  }

  const dayOffset = (iso) => Math.round((fromISO(iso).getTime() - fromISO(start).getTime()) / DAY);
  const barGeom = (t) => {
    const s = t.startOn || t.dueOn, e = t.dueOn || t.startOn;
    return { left: dayOffset(s) * DAY_W, width: Math.max(DAY_W, (dayOffset(e) - dayOffset(s) + 1) * DAY_W) };
  };
  const weeks = [];
  for (let i = 0; i < totalDays; i += 7) { const d = fromISO(addDays(start, i)); weeks.push({ x: i * DAY_W, label: `${d.getDate()}`, month: d.getDate() <= 7 ? MONTHS[d.getMonth()] : '' }); }
  const todayX = dayOffset(toISO(new Date())) * DAY_W;
  const gridW = totalDays * DAY_W, gridH = Math.max(rows.length * ROW_H, 120);

  return (
    <div className="nx-scroll" style={{ margin: 16, overflow: 'auto', border: `1px solid ${NX.border}`, borderRadius: 14, background: NX.surface, fontFamily: FONT }}>
      <div style={{ width: LABEL_W + gridW }}>
        <div style={{ position: 'sticky', top: 0, zIndex: 10, display: 'flex', borderBottom: `1px solid ${NX.border}`, background: NX.surface }}>
          <div style={{ width: LABEL_W, flexShrink: 0, borderRight: `1px solid ${NX.border}` }} />
          <div style={{ position: 'relative', width: gridW, height: 40 }}>
            {weeks.map((w, i) => (
              <div key={i} style={{ position: 'absolute', top: 0, height: '100%', borderLeft: `1px solid ${NX.border2}`, paddingLeft: 4, fontSize: 11, color: NX.faint, left: w.x }}>
                {w.month && <span style={{ fontWeight: 700, color: NX.ink }}>{w.month} </span>}{w.label}
              </div>
            ))}
            {todayX >= 0 && todayX <= gridW && <div style={{ position: 'absolute', top: 0, height: '100%', width: 2, background: NX.blue, left: todayX }} />}
          </div>
        </div>
        <div style={{ display: 'flex' }}>
          <div style={{ width: LABEL_W, flexShrink: 0, borderRight: `1px solid ${NX.border}` }}>
            {rows.map((t) => (
              <button key={t.id} onClick={() => onOpen(t.id)} style={{ display: 'flex', alignItems: 'center', gap: 8, height: ROW_H, width: '100%', border: 'none', borderBottom: `1px solid ${NX.border2}`, padding: '0 12px', textAlign: 'left', background: 'transparent', cursor: 'pointer', fontSize: 12, fontFamily: FONT }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: NX.faint }}>{t.code}</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: NX.ink }}>{t.title}</span>
              </button>
            ))}
          </div>
          <div style={{ position: 'relative', width: gridW, height: gridH }}>
            {rows.map((_, i) => <div key={i} style={{ position: 'absolute', left: 0, right: 0, borderBottom: `1px solid ${NX.border2}`, top: (i + 1) * ROW_H - 1 }} />)}
            {todayX >= 0 && todayX <= gridW && <div style={{ position: 'absolute', top: 0, height: '100%', width: 2, background: `${NX.blue}99`, left: todayX }} />}
            {rows.map((t, i) => {
              const g = barGeom(t);
              const meta = STATUS_META[t.status] || { label: t.status, color: NX.dim };
              if (t.isMilestone) {
                return <button key={t.id} onClick={() => onOpen(t.id)} title={t.title} style={{ position: 'absolute', left: g.left, top: i * ROW_H + 10, height: 24, border: 'none', background: 'transparent', cursor: 'pointer' }}><Diamond size={18} fill={meta.color} style={{ color: meta.color }} /></button>;
              }
              return (
                <button key={t.id} onClick={() => onOpen(t.id)} title={`${t.title} (${meta.label})`} style={{ position: 'absolute', left: g.left, width: g.width, top: i * ROW_H + 8, height: 28, display: 'flex', alignItems: 'center', gap: 4, borderRadius: 6, padding: '0 8px', fontSize: 11, fontWeight: 600, color: '#fff', border: 'none', cursor: 'pointer', background: meta.color, overflow: 'hidden' }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: 0.95 }}>{t.title}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Files (attachment gallery across the visible tasks) ──────────────────────
function iconFor(kind) {
  if (kind === 'image') return <FileImage size={18} style={{ color: NX.teal }} />;
  if (kind === 'doc') return <FileText size={18} style={{ color: NX.blue }} />;
  return <File size={18} style={{ color: NX.dim }} />;
}
export function FilesView({ tasks, onOpen }) {
  const [rows, setRows] = useState(null);
  const [query, setQuery] = useState('');
  useEffect(() => {
    let alive = true;
    const withAtt = tasks.filter((t) => (t.attachmentIds || []).length);
    if (!withAtt.length) { setRows([]); return; }
    Promise.all(withAtt.map((t) => api.getTaskAttachments(t.id).then((as) => (as || []).map((a) => ({ a, t }))).catch(() => [])))
      .then((all) => { if (alive) setRows(all.flat().sort((x, y) => String(y.a.addedAt || '').localeCompare(String(x.a.addedAt || '')))); });
    return () => { alive = false; };
  }, [tasks]);

  const files = useMemo(() => {
    if (!rows) return [];
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(({ a, t }) => `${a.name} ${t.title} ${t.code}`.toLowerCase().includes(q));
  }, [rows, query]);

  return (
    <div style={{ padding: 16, fontFamily: FONT }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 14 }}>
        <div style={{ position: 'relative', width: 300 }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: NX.faint }} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search files or tasks…" style={{ ...inputStyle, paddingLeft: 32 }} />
        </div>
        <span style={{ fontSize: 12, color: NX.dim }}>{files.length} file{files.length === 1 ? '' : 's'}</span>
      </div>
      {rows === null ? <div style={{ color: NX.faint, fontSize: 13, textAlign: 'center', padding: 30 }}>Loading…</div>
        : files.length === 0 ? <EmptyState icon={Paperclip} title="No attachments yet" hint="Files attached to any task show up here." />
          : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
              {files.map(({ a, t }) => (
                <div key={a.id} style={{ display: 'flex', flexDirection: 'column', gap: 8, border: `1px solid ${NX.border}`, borderRadius: 12, background: NX.surface, padding: 14 }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
                    {iconFor(a.kind)}
                    {(a.dataUrl || a.url) && <a href={a.dataUrl || a.url} download={a.name} title="Download" style={{ color: NX.faint }}><Download size={14} /></a>}
                  </div>
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, fontWeight: 600, color: NX.ink }} title={a.name}>{a.name}</div>
                  <div style={{ fontSize: 11, color: NX.faint }}>{a.size}{a.addedAt ? ` · ${fmtDate(a.addedAt)}` : ''}</div>
                  <button onClick={() => onOpen(t.id)} style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2, border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 12, color: NX.dim, padding: 0 }}>
                    <span style={{ background: NX.surface2, borderRadius: 4, padding: '1px 6px', fontSize: 10, fontWeight: 700 }}>{t.code}</span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</span>
                  </button>
                </div>
              ))}
            </div>
          )}
    </div>
  );
}

// ── Workload (open-task hours per assignee) ──────────────────────────────────
const CAPACITY = 40; // default weekly capacity (Nexus has no per-user capacity field)
export function WorkloadView({ tasks, nameOf }) {
  const rows = useMemo(() => {
    const open = tasks.filter((t) => !t.completed && t.assigneeId);
    const byPerson = new Map();
    for (const t of open) {
      const e = byPerson.get(t.assigneeId) || { email: t.assigneeId, tasks: 0, hours: 0 };
      e.tasks += 1; e.hours += t.estimateHours || 0;
      byPerson.set(t.assigneeId, e);
    }
    return [...byPerson.values()].sort((a, b) => b.hours - a.hours);
  }, [tasks]);
  const maxHours = Math.max(1, CAPACITY, ...rows.map((r) => r.hours));

  if (!rows.length) return <div style={{ padding: 16 }}><EmptyState icon={AlertTriangle} title="No assigned open tasks" hint="Assign tasks with estimates to see workload." /></div>;

  return (
    <div style={{ margin: 16, border: `1px solid ${NX.border}`, borderRadius: 14, background: NX.surface, padding: 20, fontFamily: FONT }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: NX.ink }}>Team workload</div>
        <div style={{ fontSize: 12, color: NX.dim }}>Open task hours vs {CAPACITY}h weekly capacity</div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {rows.map((r) => {
          const over = r.hours > CAPACITY;
          return (
            <div key={r.email} style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <div style={{ width: 190, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
                <Avatar email={r.email} name={nameOf(r.email)} size={30} />
                <div style={{ lineHeight: 1.2 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: NX.ink }}>{nameOf(r.email)}</div>
                  <div style={{ fontSize: 11, color: NX.faint }}>{r.tasks} open task{r.tasks === 1 ? '' : 's'}</div>
                </div>
              </div>
              <div style={{ position: 'relative', height: 30, flex: 1, borderRadius: 8, background: NX.surface2, overflow: 'hidden' }}>
                <div style={{ position: 'absolute', top: 0, height: '100%', borderRight: `2px dashed ${NX.faint}`, left: `${(CAPACITY / maxHours) * 100}%` }} />
                <div style={{ display: 'flex', alignItems: 'center', height: '100%', borderRadius: 8, padding: '0 8px', fontSize: 11, fontWeight: 700, color: '#fff', width: `${(r.hours / maxHours) * 100}%`, background: over ? NX.red : NX.blue }}>{r.hours}h</div>
              </div>
              <div style={{ width: 116, flexShrink: 0, fontSize: 12 }}>
                {over ? <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontWeight: 600, color: NX.red }}><AlertTriangle size={13} /> Over by {r.hours - CAPACITY}h</span>
                  : <span style={{ color: NX.dim }}>{CAPACITY - r.hours}h free</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

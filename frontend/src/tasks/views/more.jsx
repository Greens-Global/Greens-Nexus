// Task Module - additional view kinds: Timeline (gantt), Files (attachment
// gallery), Workload (per-assignee load). Ported from the export's
// NexusTimelineView / NexusFilesView / NexusWorkloadView to the Nexus idiom.
import { useEffect, useMemo, useRef, useState } from 'react';
import { LoadingState } from '../../components/AsyncState';
import { Diamond, File, FileImage, FileText, Paperclip, Search, AlertTriangle, Download } from 'lucide-react';
import { api } from '../../api';
import { NX, FONT, btn, input as inputStyle, STATUS_META } from '../theme';
import { Avatar, EmptyState, AttachmentViewer } from '../components';
import { fmtDate, taskAssignees } from '../lib';
import { toDownloadUrl } from '../../lib/storageView';
import { useTasks } from '../TasksContext';
import { daysFromPixels, dragModeAt, dragDates, describeMove, HANDLE_W } from '../timelineDrag';

const DAY = 86400000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const toISO = (d) => d.toISOString().slice(0, 10);
const fromISO = (s) => new Date(s + 'T00:00:00');
const addDays = (iso, n) => { const d = fromISO(iso); d.setDate(d.getDate() + n); return toISO(d); };


// Initials from a display name or email (e.g. "Sagar Shoundik" → "SS").
const initialsOf = (label = '') => {
  const s = String(label).trim();
  if (!s) return '';
  const parts = s.includes('@') ? s.split('@')[0].split(/[._-]/) : s.split(/\s+/);
  return parts.filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');
};

// ── Timeline (gantt) ─────────────────────────────────────────────────────────
const DAY_W = 26, ROW_H = 44, LABEL_W = 230;
const MAX_TIMELINE_ROWS = 300;
export function TimelineView({ tasks, onOpen, nameOf }) {
  const { applyServerTask } = useTasks();
  // Drag (Oct 2026): a bar moves, or its start / end edge stretches. The bar
  // follows the pointer by whole days; on release the server moves the task
  // AND pushes whatever waits on it (POST /tasks/{id}/reschedule), and the
  // notice says what moved. `justDragged` keeps the click that ends a drag
  // from also opening the task.
  const [drag, setDrag] = useState(null);           // { id, mode, startX, days }
  const [busyId, setBusyId] = useState(null);
  const [notice, setNotice] = useState('');
  const justDragged = useRef(false);
  const noticeTimer = useRef(null);
  useEffect(() => () => clearTimeout(noticeTimer.current), []);
  const say = (text) => {
    clearTimeout(noticeTimer.current);
    setNotice(text);
    noticeTimer.current = setTimeout(() => setNotice(''), 6000);
  };
  const allDated = useMemo(() => tasks.filter((t) => t.startOn || t.dueOn), [tasks]);
  // Render cap: each timeline row draws a label, grid line, bar and dependency
  // arrows; thousands of rows freeze the tab. Cap the rows (the Gantt geometry,
  // rowOf and gridH all derive from this, so capping here keeps them consistent).
  const rows = allDated.length > MAX_TIMELINE_ROWS ? allDated.slice(0, MAX_TIMELINE_ROWS) : allDated;
  const { start, totalDays } = useMemo(() => {
    const dates = rows.flatMap((t) => [t.startOn, t.dueOn].filter(Boolean));
    const min = dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : toISO(new Date());
    const max = dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : toISO(new Date());
    const s = addDays(min, -3);
    const days = Math.max(42, Math.round((fromISO(max).getTime() - fromISO(s).getTime()) / DAY) + 10);
    return { start: s, totalDays: days };
  }, [rows]);

  if (rows.length === 0) {
    return <div style={{ padding: 16 }}><EmptyState icon={Diamond} title="Nothing Scheduled" hint="Give tasks a start or due date to see them on the timeline." /></div>;
  }

  const dayOffset = (iso) => Math.round((fromISO(iso).getTime() - fromISO(start).getTime()) / DAY);
  // The dragged bar is drawn where the pointer has taken it, arrows included.
  const previewOf = (t) => {
    if (!drag || drag.id !== t.id || !drag.days) return t;
    const d = dragDates(t, drag.mode, drag.days);
    return d ? { ...t, ...d } : t;
  };
  const barGeom = (raw) => {
    const t = previewOf(raw);
    const s = t.startOn || t.dueOn, e = t.dueOn || t.startOn;
    return { left: dayOffset(s) * DAY_W, width: Math.max(DAY_W, (dayOffset(e) - dayOffset(s) + 1) * DAY_W) };
  };

  const onBarPointerDown = (t, e) => {
    if (e.button !== 0 || busyId) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const mode = t.isMilestone ? 'move' : dragModeAt(e.clientX - rect.left, rect.width || barGeom(t).width);
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDrag({ id: t.id, mode, startX: e.clientX, days: 0 });
  };
  const onBarPointerMove = (t, e) => {
    if (!drag || drag.id !== t.id) return;
    const days = daysFromPixels(e.clientX - drag.startX);
    if (days !== drag.days) setDrag({ ...drag, days });
  };
  const onBarPointerUp = async (t, e) => {
    if (!drag || drag.id !== t.id) return;
    const days = daysFromPixels(e.clientX - drag.startX);
    const dates = dragDates(t, drag.mode, days);
    setDrag(null);
    if (!dates) return;
    justDragged.current = true;
    setTimeout(() => { justDragged.current = false; }, 0);
    setBusyId(t.id);
    try {
      const res = await api.rescheduleTask(t.id, { start_on: dates.startOn, due_on: dates.dueOn });
      if (res?.task) applyServerTask(res.task);
      for (const m of res?.moved || []) applyServerTask(m);
      say(describeMove(t.title, dates, (res?.moved || []).length, (res?.skipped || []).length, fmtDate));
    } catch (err) {
      say(err?.message || 'That move did not save. Try again.');
    } finally {
      setBusyId(null);
    }
  };
  const openUnlessDragged = (id) => { if (!justDragged.current) onOpen(id); };
  const cursorFor = (t) => {
    if (drag && drag.id === t.id) return drag.mode === 'move' ? 'grabbing' : 'ew-resize';
    return 'grab';
  };
  const rowOf = new Map(rows.map((t, i) => [t.id, i]));
  const weeks = [];
  for (let i = 0; i < totalDays; i += 7) { const d = fromISO(addDays(start, i)); weeks.push({ x: i * DAY_W, label: `${d.getDate()}`, month: d.getDate() <= 7 ? MONTHS[d.getMonth()] : '' }); }
  const todayX = dayOffset(toISO(new Date())) * DAY_W;
  const gridW = totalDays * DAY_W, gridH = Math.max(rows.length * ROW_H, 120);

  return (
    <>
    {allDated.length > MAX_TIMELINE_ROWS && (
      <div style={{ margin: '16px 16px 0', padding: '8px 12px', borderRadius: 8, background: NX.border2, color: NX.dim, fontSize: 12, fontFamily: FONT }}>
        Showing {MAX_TIMELINE_ROWS} of {allDated.length} scheduled tasks - filter to narrow the timeline.
      </div>
    )}
    <div role="status" aria-live="polite" style={{ margin: '12px 16px 0', minHeight: 18, fontSize: 12, fontFamily: FONT, color: notice ? NX.ink : NX.faint }}>
      {notice || 'Drag a bar to move it, or its edge to change the start or due date. Tasks waiting on it move with it.'}
    </div>
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
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: NX.ink }}>{t.title}</span>
              </button>
            ))}
          </div>
          <div style={{ position: 'relative', width: gridW, height: gridH }}>
            {rows.map((_, i) => <div key={i} style={{ position: 'absolute', left: 0, right: 0, borderBottom: `1px solid ${NX.border2}`, top: (i + 1) * ROW_H - 1 }} />)}
            {todayX >= 0 && todayX <= gridW && <div style={{ position: 'absolute', top: 0, height: '100%', width: 2, background: `${NX.blue}99`, left: todayX }} />}
            {/* Dependency arrows: blocker → blocked (elbow connector with arrowhead). */}
            <svg style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} width={gridW} height={gridH}>
              {rows.flatMap((t) => (t.blockedByIds || []).map((bid) => {
                if (!rowOf.has(bid)) return null;
                const from = rows[rowOf.get(bid)];
                const fg = barGeom(from), tg = barGeom(t);
                const x1 = fg.left + fg.width, y1 = rowOf.get(bid) * ROW_H + ROW_H / 2;
                const x2 = tg.left, y2 = rowOf.get(t.id) * ROW_H + ROW_H / 2;
                const midX = Math.max(x1 + 12, x2 - 12);
                return (
                  <g key={`${bid}-${t.id}`}>
                    <path d={`M ${x1} ${y1} H ${midX} V ${y2} H ${x2}`} fill="none" stroke="#94a3b8" strokeWidth={1.5} />
                    <path d={`M ${x2} ${y2} l -6 -4 l 0 8 z`} fill="#94a3b8" />
                  </g>
                );
              }))}
            </svg>
            {rows.map((t, i) => {
              const g = barGeom(t);
              const meta = STATUS_META[t.status] || { label: t.status, color: NX.dim };
              const dragging = drag?.id === t.id;
              const pointer = {
                onPointerDown: (e) => onBarPointerDown(t, e),
                onPointerMove: (e) => onBarPointerMove(t, e),
                onPointerUp: (e) => onBarPointerUp(t, e),
                onPointerCancel: () => setDrag(null),
              };
              if (t.isMilestone) {
                return <button key={t.id} {...pointer} onClick={() => openUnlessDragged(t.id)} title={t.title} aria-label={t.title} data-bar={t.id} style={{ position: 'absolute', left: g.left, top: i * ROW_H + 10, height: 24, border: 'none', background: 'transparent', cursor: cursorFor(t), touchAction: 'none', zIndex: dragging ? 3 : 1, opacity: busyId === t.id ? 0.6 : 1 }}><Diamond size={18} fill={meta.color} style={{ color: meta.color }} /></button>;
              }
              const [primary = ''] = taskAssignees(t);
              const ini = primary ? initialsOf(nameOf ? nameOf(primary) : primary) : '';
              const edge = { position: 'absolute', top: 0, bottom: 0, width: HANDLE_W, cursor: 'ew-resize' };
              return (
                <button key={t.id} {...pointer} onClick={() => openUnlessDragged(t.id)} title={`${t.title} (${meta.label})`} aria-label={t.title} data-bar={t.id}
                  style={{ position: 'absolute', left: g.left, width: g.width, top: i * ROW_H + 8, height: 28, display: 'flex', alignItems: 'center', gap: 4, borderRadius: 6, padding: '0 8px', fontSize: 11, fontWeight: 600, color: '#fff', border: 'none', cursor: cursorFor(t), background: meta.color, overflow: 'hidden', touchAction: 'none', zIndex: dragging ? 3 : 1, opacity: busyId === t.id ? 0.6 : 1, boxShadow: dragging ? '0 6px 18px rgba(0,0,0,0.25)' : 'none', transition: dragging ? 'none' : 'left 0.12s, width 0.12s' }}>
                  <span style={{ ...edge, left: 0 }} />
                  {ini && <span style={{ flexShrink: 0, fontWeight: 700, opacity: 0.9 }}>{ini}</span>}
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: 0.95 }}>{t.title}</span>
                  <span style={{ ...edge, right: 0 }} />
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
    </>
  );
}

// ── Files (attachment gallery across the visible tasks) ──────────────────────
function iconFor(kind) {
  if (kind === 'image') return <FileImage size={18} style={{ color: NX.teal }} />;
  if (kind === 'doc') return <FileText size={18} style={{ color: NX.blue }} />;
  return <File size={18} style={{ color: NX.dim }} />;
}
export function FilesView({ tasks, onOpen, nameOf }) {
  const [rows, setRows] = useState(null);
  const [query, setQuery] = useState('');
  const [view, setView] = useState(null);   // attachment open in the in-app viewer
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
      {rows === null ? <LoadingState />
        : files.length === 0 ? <EmptyState icon={Paperclip} title="No Attachments Yet" hint="Files attached to any task show up here." />
          : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
              {files.slice(0, 200).map(({ a, t }) => {
                const href = a.dataUrl || a.url;
                return (
                <div key={a.id} style={{ display: 'flex', flexDirection: 'column', gap: 8, border: `1px solid ${NX.border}`, borderRadius: 12, background: NX.surface, padding: 14 }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
                    {iconFor(a.kind)}
                    {href && <a href={toDownloadUrl(href)} download={a.name} title="Download" style={{ color: NX.faint }}><Download size={14} /></a>}
                  </div>
                  {href ? (
                    // Opens the in-app viewer - never a new tab.
                    <button type="button" onClick={() => setView({ ...a, url: href })} title={`View ${a.name}`}
                      style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, fontWeight: 600, color: NX.ink, background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit' }}>{a.name}</button>
                  ) : (
                    <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, fontWeight: 600, color: NX.faint, textDecoration: 'line-through' }}
                      title="This file failed to upload and isn't available">{a.name}</div>
                  )}
                  <div style={{ fontSize: 11, color: NX.faint }}>{a.size}{a.addedAt ? ` · ${fmtDate(a.addedAt)}` : ''}</div>
                  <button onClick={() => onOpen(t.id)} title={t.title} style={{ display: 'block', width: '100%', textAlign: 'left', marginTop: 2, border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 12, color: NX.blue, padding: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t.title}
                  </button>
                  {a.addedBy && <div style={{ fontSize: 11, color: NX.faint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nameOf?.(a.addedBy) || a.addedBy}</div>}
                </div>
                );
              })}
              {files.length > 200 && <div style={{ gridColumn: '1 / -1', padding: '6px 2px', fontSize: 12, color: NX.faint }}>Showing 200 of {files.length} files - search to narrow down.</div>}
            </div>
          )}
      {view && <AttachmentViewer att={view} onClose={() => setView(null)} />}
    </div>
  );
}

// ── Workload (open-task hours per assignee) ──────────────────────────────────
const CAPACITY = 40; // default weekly capacity (Nexus has no per-user capacity field)
export function WorkloadView({ tasks, nameOf }) {
  const rows = useMemo(() => {
    // Counted per ASSIGNEE, not per task: a task two people share is real work
    // on both their plates, and a workload view that credited only the primary
    // would under-report the second person's load - the exact thing this screen
    // exists to show.
    const open = tasks.filter((t) => !t.completed && taskAssignees(t).length);
    const byPerson = new Map();
    for (const t of open) {
      for (const who of taskAssignees(t)) {
        const e = byPerson.get(who) || { email: who, tasks: 0, hours: 0 };
        e.tasks += 1; e.hours += t.estimateHours || 0;
        byPerson.set(who, e);
      }
    }
    return [...byPerson.values()].sort((a, b) => b.hours - a.hours);
  }, [tasks]);
  const maxHours = Math.max(1, CAPACITY, ...rows.map((r) => r.hours));

  if (!rows.length) return <div style={{ padding: 16 }}><EmptyState icon={AlertTriangle} title="No Assigned Open Tasks" hint="Assign tasks with estimates to see workload." /></div>;

  return (
    <div style={{ margin: 16, border: `1px solid ${NX.border}`, borderRadius: 14, background: NX.surface, padding: 20, fontFamily: FONT }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: NX.ink }}>Team Workload</div>
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

// Task Module - Board view (1:1 port of the export's NexusBoardView).
// Status columns (built-in + custom statuses) with drag-and-drop, per-column
// WIP limits, collapsible columns, an "Add section" column that creates a
// custom status, an inline comment composer on cards, and orthogonal swimlanes
// (None / Assignee / Priority / Project). Grey columns, white cards.
import { useMemo, useRef, useState, useEffect } from 'react';
import {
  Circle, CheckCircle2, MessageSquare, Diamond, Plus, Trash2, ChevronsLeft, ChevronsRight,
  MoreHorizontal, Gauge, Rows3, ChevronDown,
} from 'lucide-react';
import { NX, FONT, btn, input as inputStyle, STATUS_META, STATUS_ORDER, PRIORITY_META } from '../theme';
import { cfKey, cfFieldId, taskFieldValue, fieldsForProject } from '../lib';
import { Avatar, PriorityChip, useClickOutside } from '../components';
import { fmtDate } from '../lib';

const SECTION_PALETTE = ['#4573fa', '#8b6bf0', '#14a76c', '#e8a33d', '#e0844e', '#e8384f', '#29a8ab', '#db2777'];
const SWIMLANE_OPTIONS = [
  { key: 'none', label: 'None' }, { key: 'assignee', label: 'Assignee' },
  { key: 'priority', label: 'Priority' }, { key: 'project', label: 'Project' },
];
const PRIORITY_LANE_ORDER = ['urgent', 'high', 'medium', 'low'];

const dueColor = (iso, completed) => {
  if (!iso || completed) return NX.faint;
  const today = new Date().toISOString().slice(0, 10);
  if (iso < today) return NX.red;
  if (iso === today) return NX.amber;
  return NX.dim;
};
const fmtDue = (iso) => fmtDate(iso);

// defaultAssigneeId: who cards added from a column header belong to. My Tasks
// passes the current user - a task created there with no assignee would drop
// straight out of the view.
// Per-column card render cap. Each card is heavy; an unfiltered board can have
// thousands of tasks in one status column, which freezes the tab. Cap the cards
// drawn per column (headers/counts stay accurate) and show a "+N more" note -
// same reasoning as the list view's render cap.
const MAX_BOARD_CARDS = 100;
function MoreCards({ n }) {
  return (
    <div style={{ padding: '6px 4px', fontSize: 12, color: NX.faint, fontFamily: FONT }}>
      + {n} more - search or filter to narrow down
    </div>
  );
}

export default function BoardView({ visible, ctx, store, onOpen, lockedProjectId, defaultAssigneeId = '' }) {
  const [dragId, setDragId] = useState(null);
  const [dragOver, setDragOver] = useState(null);
  const [addIn, setAddIn] = useState(null);
  const [commentOpenId, setCommentOpenId] = useState(null);
  const [draft, setDraft] = useState('');
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [swimlane, setSwimlane] = useState('none');
  // Select-type custom fields become swimlane choices too. Memoized because `lanes`
  // depends on it, and a fresh array every render would defeat that memo.
  const boardFields = useMemo(
    () => fieldsForProject(store.customFields || [], lockedProjectId)
      .filter((f) => f.type === 'select' && (f.options || []).length),
    [store.customFields, lockedProjectId],
  );
  const swimOptions = [...SWIMLANE_OPTIONS, ...boardFields.map((f) => ({ key: cfKey(f.id), label: f.name }))];
  const [addingSection, setAddingSection] = useState(false);
  const [sectionName, setSectionName] = useState('');
  const [swimOpen, setSwimOpen] = useState(false);
  const swimRef = useRef(null);
  const [wip, setWip] = useState(() => { try { return JSON.parse(localStorage.getItem('nexus.board.wip') || '{}'); } catch { return {}; } });

  const setLimit = (status, n) => setWip((prev) => {
    const next = { ...prev };
    if (n == null || n <= 0) delete next[status]; else next[status] = n;
    localStorage.setItem('nexus.board.wip', JSON.stringify(next));
    return next;
  });

  const customStatusIds = useMemo(() => new Set(store.customStatuses.map((s) => s.id)), [store.customStatuses]);
  const statuses = useMemo(() => [...STATUS_ORDER, ...store.customStatuses.map((s) => s.id)], [store.customStatuses]);
  const statusMeta = (key) => STATUS_META[key]
    || (() => { const c = store.customStatuses.find((s) => s.id === key); return c ? { label: c.label, color: c.color, tint: `${c.color}1a` } : { label: key, color: NX.dim, tint: NX.border2 }; })();

  useClickOutside(swimRef, () => setSwimOpen(false), swimOpen);

  const toggleCollapse = (s) => setCollapsed((prev) => { const n = new Set(prev); n.has(s) ? n.delete(s) : n.add(s); return n; });

  const postComment = (id) => {
    if (!draft.trim()) return;
    store.addComment(id, draft.trim()).catch(() => {});
    setDraft(''); setCommentOpenId(null);
  };

  const createSection = () => {
    if (!sectionName.trim()) return;
    const color = SECTION_PALETTE[store.customStatuses.length % SECTION_PALETTE.length];
    store.createCustomStatus({ label: sectionName.trim(), color }).catch(() => {});
    setSectionName(''); setAddingSection(false);
  };

  const deleteSection = (status) => {
    if (window.confirm(`Delete "${statusMeta(status).label}"? Tasks in it move back to Not Started.`)) {
      for (const t of visible.filter((x) => x.status === status)) store.setStatus(t.id, 'not_started');
      store.deleteCustomStatus(status).catch(() => {});
    }
  };

  // Swimlane rows - derived from the visible tasks so no people directory needed.
  const lanes = useMemo(() => {
    if (swimlane === 'none') return [{ key: 'all', label: '', match: () => true }];
    if (swimlane === 'priority') {
      return PRIORITY_LANE_ORDER
        .map((p) => ({ key: p, label: PRIORITY_META[p]?.label || p, match: (t) => t.priority === p }))
        .filter((l) => visible.some(l.match));
    }
    const cfId = cfFieldId(swimlane);
    if (cfId) {
      const field = boardFields.find((f) => f.id === cfId);
      if (!field) return [{ key: 'all', label: '', match: () => true }];
      const opts = (field.options || []).map((o) => (typeof o === 'string' ? { id: o, label: o } : o));
      const out = opts.map((o) => ({ key: o.id, label: o.label, match: (t) => taskFieldValue(t, cfId) === o.id }));
      if (visible.some((t) => !taskFieldValue(t, cfId))) {
        out.push({ key: '__none', label: `No ${field.name}`, match: (t) => !taskFieldValue(t, cfId) });
      }
      return out.filter((l) => visible.some(l.match));
    }
    if (swimlane === 'assignee') {
      const seen = new Map();
      for (const t of visible) if (t.assigneeId && !seen.has(t.assigneeId)) seen.set(t.assigneeId, ctx.nameOf?.(t.assigneeId) || t.assigneeId);
      const out = [...seen.entries()].map(([id, label]) => ({ key: id, label, match: (t) => t.assigneeId === id }));
      if (visible.some((t) => !t.assigneeId)) out.push({ key: '__none', label: 'Unassigned', match: (t) => !t.assigneeId });
      return out;
    }
    // project
    const seen = new Map();
    for (const t of visible) if (t.projectId && !seen.has(t.projectId)) seen.set(t.projectId, store.projectName(t.projectId));
    const out = [...seen.entries()].map(([id, label]) => ({ key: id, label, match: (t) => t.projectId === id }));
    if (visible.some((t) => !t.projectId)) out.push({ key: '__none', label: 'No project', match: (t) => !t.projectId });
    return out;
  }, [swimlane, visible, ctx, store, boardFields]);

  const drop = (status, lane) => {
    if (!dragId) { setDragOver(null); return; }
    store.setStatus(dragId, status);
    if (lane && swimlane !== 'none' && lane.key !== 'all') {
      if (swimlane === 'assignee') store.updateTask(dragId, { assigneeId: lane.key === '__none' ? '' : lane.key });
      else if (swimlane === 'priority') store.updateTask(dragId, { priority: lane.key });
      else if (swimlane === 'project') store.updateTask(dragId, { projectId: lane.key === '__none' ? '' : lane.key });
    }
    setDragId(null); setDragOver(null);
  };

  const addTask = (status, title) => {
    const t = title.trim(); if (!t) return;
    store.createTask({ title: t, type: 'task', status, priority: 'medium', projectId: lockedProjectId || '', assigneeId: defaultAssigneeId || '' }).catch(() => {});
    setAddIn(null);
  };

  const renderCard = (t) => {
    const dc = dueColor(t.dueOn, t.completed);
    // Kit card signature: a colored project tag pill leads the card (hidden
    // when the whole board is already locked to one project).
    const proj = !lockedProjectId && t.projectId ? store.projects.find((p) => p.id === t.projectId) : null;
    const projColor = proj?.color || NX.purple;
    return (
      <div key={t.id} draggable data-task-row onDragStart={() => setDragId(t.id)} onDragEnd={() => setDragId(null)} onClick={() => onOpen(t.id)}
        onMouseEnter={(e) => { e.currentTarget.style.boxShadow = '0 6px 16px rgba(0,0,0,0.09)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.boxShadow = '0 1px 2px rgba(0,0,0,0.04)'; }}
        style={{ background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 12, padding: 14, cursor: 'grab', boxShadow: '0 1px 2px rgba(0,0,0,0.04)', opacity: dragId === t.id ? 0.5 : 1, transition: 'box-shadow .15s' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          {proj && (
            <span style={{ padding: '2px 8px', borderRadius: 5, fontSize: 10.5, fontWeight: 600, background: `${projColor}1a`, color: projColor, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 130 }}>{proj.name}</span>
          )}
          <span style={{ fontSize: 10, fontWeight: 700, color: NX.faint, letterSpacing: 0.3 }}>{t.code}</span>
          {t.isMilestone && <Diamond size={11} style={{ color: NX.purple }} />}
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 2 }}>
            <button onClick={(e) => { e.stopPropagation(); onOpen(t.id); }} onMouseDown={(e) => e.stopPropagation()} title="More Actions" style={{ ...btn('ghost'), padding: 3, color: NX.faint }}><MoreHorizontal size={15} /></button>
            <button onClick={(e) => { e.stopPropagation(); store.toggleComplete(t); }} onMouseDown={(e) => e.stopPropagation()} style={{ ...btn('ghost'), padding: 0, color: t.completed ? NX.green : NX.faint }}>{t.completed ? <CheckCircle2 size={15} /> : <Circle size={15} />}</button>
          </div>
        </div>
        <div style={{ marginTop: 8, fontSize: 13, fontWeight: 600, color: t.completed ? NX.faint : NX.ink, textDecoration: t.completed ? 'line-through' : 'none' }}>{t.title}</div>
        <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <PriorityChip priority={t.priority} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button onClick={(e) => { e.stopPropagation(); setDraft(''); setCommentOpenId((id) => (id === t.id ? null : t.id)); }} onMouseDown={(e) => e.stopPropagation()}
              style={{ ...btn('ghost'), padding: 2, gap: 2, fontSize: 11, color: commentOpenId === t.id ? NX.blue : NX.faint }}>
              <MessageSquare size={11} />{t.commentIds?.length > 0 ? t.commentIds.length : ''}
            </button>
            {t.dueOn && <span style={{ fontSize: 11, color: dc }}>{fmtDue(t.dueOn)}</span>}
            {t.assigneeId && <Avatar email={t.assigneeId} name={ctx.nameOf?.(t.assigneeId)} size={20} />}
          </div>
        </div>
        {commentOpenId === t.id && (
          <div style={{ marginTop: 8, borderTop: `1px solid ${NX.border}`, paddingTop: 8 }} onClick={(e) => e.stopPropagation()}>
            <textarea autoFocus value={draft} onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); postComment(t.id); } }}
              placeholder="Add a comment…" rows={2} style={{ ...inputStyle, resize: 'none', fontSize: 12, fontFamily: FONT }} />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 6 }}>
              <button onClick={() => setCommentOpenId(null)} style={{ ...btn('ghost'), fontSize: 11, padding: '4px 8px' }}>Cancel</button>
              <button onClick={() => postComment(t.id)} disabled={!draft.trim()} style={{ ...btn('primary'), fontSize: 11, padding: '5px 10px', opacity: draft.trim() ? 1 : 0.4 }}>Post</button>
            </div>
          </div>
        )}
      </div>
    );
  };

  const ColumnHeader = ({ status, count }) => {
    const m = statusMeta(status);
    const limit = wip[status];
    const over = limit != null && count > limit;
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 6px', marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: m.color, flexShrink: 0 }} />
          <span style={{ fontSize: 13, fontWeight: 700, color: NX.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.label}</span>
          <span style={{ fontSize: 12, fontWeight: 600, padding: '0 4px', borderRadius: 4, color: over ? NX.red : NX.faint, background: over ? 'rgba(220,38,38,0.14)' : 'transparent' }}>{count}{limit != null ? ` / ${limit}` : ''}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 1, flexShrink: 0 }}>
          <WipMenu limit={limit} onSet={(v) => setLimit(status, v)} />
          {customStatusIds.has(status) && (
            <button onClick={() => deleteSection(status)} title="Delete Section" style={{ ...btn('ghost'), padding: 4, color: NX.faint }}><Trash2 size={14} /></button>
          )}
          <button onClick={() => setAddIn(status)} title="Add Task" style={{ ...btn('ghost'), padding: 4, color: NX.faint }}><Plus size={15} /></button>
          {swimlane === 'none' && (
            <button onClick={() => toggleCollapse(status)} title="Collapse Section" style={{ ...btn('ghost'), padding: 4, color: NX.faint }}><ChevronsLeft size={15} /></button>
          )}
        </div>
      </div>
    );
  };

  const swimLabel = SWIMLANE_OPTIONS.find((o) => o.key === swimlane).label;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: NX.canvas, fontFamily: FONT, padding: 16 }}>
      {/* Board toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexShrink: 0 }}>
        <div ref={swimRef} style={{ position: 'relative' }}>
          <button onClick={() => setSwimOpen((o) => !o)} style={{ ...btn('outline'), fontSize: 12.5 }}>
            <Rows3 size={14} /> Swimlanes: {swimLabel} <ChevronDown size={13} style={{ color: NX.faint }} />
          </button>
          {swimOpen && (
            <div style={{ position: 'absolute', top: '100%', left: 0, marginTop: 4, width: 176, background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,0.16)', zIndex: 40, padding: 4 }}>
              {swimOptions.map((o) => (
                <button key={o.key} onClick={() => { setSwimlane(o.key); setSwimOpen(false); }} style={{ ...btn('ghost'), width: '100%', justifyContent: 'flex-start', color: swimlane === o.key ? NX.blue : NX.ink, background: swimlane === o.key ? NX.hover : 'transparent' }}>{o.label}</button>
              ))}
            </div>
          )}
        </div>
        <span style={{ fontSize: 11, color: NX.faint, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          Set a WIP limit with the <Gauge size={11} /> in each column header.
        </span>
      </div>

      {swimlane === 'none' ? (
        /* Standard columns */
        <div className="nx-scroll" style={{ display: 'flex', alignItems: 'flex-start', gap: 16, flex: 1, minHeight: 0, overflowX: 'auto', paddingBottom: 4 }}>
          {statuses.map((status) => {
            const tasks = visible.filter((t) => t.status === status);
            const m = statusMeta(status);
            const limit = wip[status];
            const over = limit != null && tasks.length > limit;
            const isOver = dragOver === status;
            return collapsed.has(status) ? (
              <button key={status} onClick={() => toggleCollapse(status)}
                onDragOver={(e) => { e.preventDefault(); setDragOver(status); }} onDragLeave={() => setDragOver((d) => (d === status ? null : d))} onDrop={(e) => { e.stopPropagation(); drop(status); }}
                style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, width: 40, flexShrink: 0, alignSelf: 'stretch', borderRadius: 16, border: `1px solid ${isOver ? NX.blue : NX.border}`, background: NX.surface2, padding: '12px 0', cursor: 'pointer' }} title="Expand Section">
                <ChevronsRight size={14} style={{ color: NX.faint }} />
                <span style={{ width: 10, height: 10, borderRadius: '50%', background: m.color }} />
                <span style={{ fontSize: 11, fontWeight: 700, color: NX.faint }}>{tasks.length}</span>
                <span style={{ marginTop: 4, fontSize: 12, fontWeight: 700, color: NX.ink, whiteSpace: 'nowrap', writingMode: 'vertical-rl' }}>{m.label}</span>
              </button>
            ) : (
              <div key={status}
                onDragOver={(e) => { e.preventDefault(); setDragOver(status); }} onDragLeave={() => setDragOver((d) => (d === status ? null : d))} onDrop={() => drop(status)}
                style={{ display: 'flex', flexDirection: 'column', width: 300, flexShrink: 0, alignSelf: 'stretch', minHeight: 0, borderRadius: 16, border: `1px solid ${over ? 'rgba(220,38,38,0.5)' : isOver ? NX.blue : NX.border}`, background: NX.surface2, padding: 10 }}>
                <ColumnHeader status={status} count={tasks.length} />
                {over && <div style={{ marginBottom: 8, borderRadius: 8, background: 'rgba(220,38,38,0.14)', color: NX.red, padding: '4px 8px', fontSize: 11, fontWeight: 700 }}>Over WIP limit ({tasks.length}/{limit})</div>}
                <div className="nx-scroll" style={{ display: 'flex', flexDirection: 'column', gap: 12, flex: 1, minHeight: 0, overflowY: 'auto', paddingRight: 2 }}>
                  {addIn === status && <AddCard onAdd={(title) => addTask(status, title)} onCancel={() => setAddIn(null)} />}
                  {tasks.slice(0, MAX_BOARD_CARDS).map(renderCard)}
                  {tasks.length > MAX_BOARD_CARDS && <MoreCards n={tasks.length - MAX_BOARD_CARDS} />}
                </div>
              </div>
            );
          })}
          <AddSectionColumn {...{ addingSection, setAddingSection, sectionName, setSectionName, createSection }} />
        </div>
      ) : (
        /* Swimlanes */
        <div className="nx-scroll" style={{ flex: 1, minHeight: 0, overflow: 'auto', paddingBottom: 4 }}>
          <div style={{ minWidth: 'max-content' }}>
            <div style={{ display: 'flex', gap: 16, borderBottom: `1px solid ${NX.border}`, paddingBottom: 4 }}>
              {statuses.map((status) => (
                <div key={status} style={{ width: 300, flexShrink: 0 }}>
                  <ColumnHeader status={status} count={visible.filter((t) => t.status === status).length} />
                </div>
              ))}
            </div>
            {lanes.map((lane) => (
              <div key={lane.key} style={{ borderBottom: `1px solid ${NX.border}` }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', fontSize: 12, fontWeight: 700, color: NX.ink }}>
                  <Rows3 size={13} style={{ color: NX.faint }} />{lane.label}
                  <span style={{ fontSize: 11, fontWeight: 400, color: NX.faint }}>{visible.filter(lane.match).length}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, paddingBottom: 12 }}>
                  {statuses.map((status) => {
                    const tasks = visible.filter((t) => t.status === status && lane.match(t));
                    const zoneKey = `${lane.key}:${status}`;
                    return (
                      <div key={status}
                        onDragOver={(e) => { e.preventDefault(); setDragOver(zoneKey); }} onDragLeave={() => setDragOver((d) => (d === zoneKey ? null : d))} onDrop={() => drop(status, lane)}
                        style={{ display: 'flex', flexDirection: 'column', gap: 12, width: 300, flexShrink: 0, minHeight: 80, borderRadius: 12, border: `1px solid ${dragOver === zoneKey ? NX.blue : 'transparent'}`, background: dragOver === zoneKey ? NX.hover : 'transparent', padding: 8 }}>
                        {tasks.slice(0, MAX_BOARD_CARDS).map(renderCard)}
                        {tasks.length > MAX_BOARD_CARDS && <MoreCards n={tasks.length - MAX_BOARD_CARDS} />}
                        <button onClick={() => setAddIn(status)} style={{ ...btn('ghost'), justifyContent: 'center', border: `1px dashed ${NX.border}`, fontSize: 11, color: NX.faint, padding: '6px 0' }}><Plus size={12} />Add</button>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function AddCard({ onAdd, onCancel }) {
  const [title, setTitle] = useState('');
  return (
    <div style={{ border: `1px solid ${NX.blue}`, borderRadius: 12, padding: 8, background: NX.surface }}>
      <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') onAdd(title); if (e.key === 'Escape') onCancel(); }}
        placeholder="Task name" style={{ ...inputStyle, padding: '6px 8px', fontSize: 13, border: 'none' }} />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 4 }}>
        <button onClick={onCancel} style={{ ...btn('ghost'), fontSize: 11, padding: '4px 8px' }}>Cancel</button>
        <button onClick={() => onAdd(title)} disabled={!title.trim()} style={{ ...btn('primary'), fontSize: 11, padding: '5px 10px', opacity: title.trim() ? 1 : 0.4 }}>Add</button>
      </div>
    </div>
  );
}

function AddSectionColumn({ addingSection, setAddingSection, sectionName, setSectionName, createSection }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: 260, flexShrink: 0, borderRadius: 16, border: `1px dashed ${NX.border}`, padding: 10 }}>
      {addingSection ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input autoFocus value={sectionName} onChange={(e) => setSectionName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') createSection(); if (e.key === 'Escape') { setAddingSection(false); setSectionName(''); } }}
            placeholder="Section name" style={{ ...inputStyle, padding: '6px 8px', fontSize: 13 }} />
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={createSection} disabled={!sectionName.trim()} style={{ ...btn('primary'), fontSize: 12, opacity: sectionName.trim() ? 1 : 0.4 }}>Add</button>
            <button onClick={() => { setAddingSection(false); setSectionName(''); }} style={{ ...btn('ghost'), fontSize: 12 }}>Cancel</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setAddingSection(true)} style={{ ...btn('ghost'), justifyContent: 'flex-start', color: NX.faint, padding: '8px 8px' }}><Plus size={15} />Add Section</button>
      )}
    </div>
  );
}

function WipMenu({ limit, onSet }) {
  const [open, setOpen] = useState(false);
  const [val, setVal] = useState(limit ?? '');
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button onClick={() => { setVal(limit ?? ''); setOpen((o) => !o); }} title="Set WIP limit" style={{ ...btn('ghost'), padding: 4, color: limit != null ? NX.blue : NX.faint }}><Gauge size={14} /></button>
      {open && (
        <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: 4, width: 176, background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,0.16)', zIndex: 40, padding: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: NX.dim, marginBottom: 6 }}>WIP limit</div>
          <input type="number" min={0} autoFocus value={val} onChange={(e) => setVal(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { onSet(val === '' ? null : Number(val) || null); setOpen(false); } }}
            placeholder="No limit" style={{ ...inputStyle, padding: '6px 8px', fontSize: 13 }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
            <button onClick={() => { onSet(null); setOpen(false); }} style={{ ...btn('ghost'), fontSize: 11, padding: '4px 6px', color: NX.dim }}>Clear</button>
            <span style={{ fontSize: 10, color: NX.faint }}>Enter to save</span>
          </div>
        </div>
      )}
    </div>
  );
}

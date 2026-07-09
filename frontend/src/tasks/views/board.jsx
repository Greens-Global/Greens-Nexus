// Task Module — Board view (ported from the export's NexusBoardView).
// Kanban columns for the active grouping with drag-and-drop between columns
// (updates the grouped field), an inline add-task per column, and per-column
// WIP limits persisted to localStorage with an over-limit warning.
import { useMemo, useState } from 'react';
import { CheckCircle2, Circle, Plus, Gauge, X } from 'lucide-react';
import { groupTasks } from '../lib';
import { NX, FONT, btn, input as inputStyle, STATUS_META, STATUS_ORDER, PRIORITY_META, PRIORITY_ORDER } from '../theme';
import { Avatar, PriorityChip } from '../components';

// group key → the task field that dragging a card between columns updates.
const FIELD = { status: 'status', priority: 'priority', assignee: 'assigneeId', project: 'projectId', department: 'departmentId' };

export default function BoardView({ visible, group, ctx, store, onOpen, lockedProjectId }) {
  const g = group === 'none' ? 'status' : group;
  const field = FIELD[g] || 'status';
  const [dragId, setDragId] = useState(null);
  const [overCol, setOverCol] = useState(null);
  const [addIn, setAddIn] = useState(null);
  const [wip, setWip] = useState(() => { try { return JSON.parse(localStorage.getItem('nexus.board.wip') || '{}'); } catch { return {}; } });
  const setLimit = (key, v) => setWip((w) => { const n = { ...w, [`${g}:${key}`]: v }; localStorage.setItem('nexus.board.wip', JSON.stringify(n)); return n; });

  // Column list: seed all statuses/priorities (incl. empty); derive others from data.
  const columns = useMemo(() => {
    const grouped = groupTasks(visible, g, ctx);
    const byKey = Object.fromEntries(grouped.map((gr) => [gr.key, gr]));
    if (g === 'status') return STATUS_ORDER.map((s) => byKey[s] || { key: s, label: STATUS_META[s].label, color: STATUS_META[s].color, tasks: [] });
    if (g === 'priority') return PRIORITY_ORDER.map((p) => byKey[p] || { key: p, label: PRIORITY_META[p].label, color: PRIORITY_META[p].color, tasks: [] });
    return grouped;
  }, [visible, g, ctx]);

  const drop = (colKey) => {
    setOverCol(null);
    if (!dragId) return;
    const t = store.taskById[dragId];
    const val = colKey === '—' || colKey === 'none' ? null : colKey;
    if (t && (t[field] ?? null) !== val) {
      if (field === 'status') store.setStatus(dragId, val);
      else store.updateTask(dragId, { [field]: val });
    }
    setDragId(null);
  };

  const addTask = (colKey, title) => {
    const t = title.trim(); if (!t) return;
    const patch = { title: t, type: 'task', status: 'not_started', priority: 'medium', projectId: lockedProjectId || '' };
    if (field !== 'status' || colKey !== 'not_started') patch[field] = (colKey === '—' || colKey === 'none') ? '' : colKey;
    if (field === 'status') patch.status = colKey;
    store.createTask(patch).catch(() => {});
    setAddIn(null);
  };

  return (
    <div style={{ display: 'flex', gap: 14, padding: 16, alignItems: 'flex-start', minHeight: '100%', background: NX.canvas, fontFamily: FONT }}>
      {columns.map((c) => {
        const limit = wip[`${g}:${c.key}`];
        const over = limit != null && c.tasks.length > limit;
        const isOver = overCol === c.key;
        return (
          <div key={c.key}
            onDragOver={(e) => { e.preventDefault(); setOverCol(c.key); }}
            onDragLeave={() => setOverCol((o) => (o === c.key ? null : o))}
            onDrop={(e) => { e.preventDefault(); drop(c.key); }}
            style={{ width: 288, flexShrink: 0, background: NX.surface, borderRadius: 12, border: `1px solid ${isOver ? NX.blue : NX.border}`, transition: 'border-color 0.12s' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '11px 13px', borderBottom: `1px solid ${NX.border2}` }}>
              {c.color && <span style={{ width: 9, height: 9, borderRadius: '50%', background: c.color }} />}
              <span style={{ fontSize: 13, fontWeight: 700 }}>{c.label || 'Tasks'}</span>
              <span style={{ color: NX.faint, fontSize: 12 }}>{c.tasks.length}{limit != null ? `/${limit}` : ''}</span>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 2 }}>
                <WipMenu limit={limit} onSet={(v) => setLimit(c.key, v)} />
                <button onClick={() => setAddIn(addIn === c.key ? null : c.key)} title="Add task" style={{ ...btn('ghost'), padding: 4, color: NX.faint }}><Plus size={15} /></button>
              </div>
            </div>
            <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 9, maxHeight: '70vh', overflowY: 'auto' }}>
              {over && <div style={{ borderRadius: 8, background: '#fde5e5', color: NX.red, padding: '4px 8px', fontSize: 11, fontWeight: 700 }}>Over WIP limit ({c.tasks.length}/{limit})</div>}
              {addIn === c.key && <AddCard onAdd={(title) => addTask(c.key, title)} onCancel={() => setAddIn(null)} />}
              {c.tasks.map((t) => (
                <div key={t.id} draggable onDragStart={() => setDragId(t.id)} onDragEnd={() => setDragId(null)} onClick={() => onOpen(t.id)}
                  style={{ background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 10, padding: 11, cursor: 'grab', boxShadow: '0 1px 2px rgba(0,0,0,0.04)', opacity: dragId === t.id ? 0.5 : 1 }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                    <button onClick={(e) => { e.stopPropagation(); store.toggleComplete(t); }} style={{ ...btn('ghost'), padding: 0, color: t.completed ? NX.green : NX.faint }}>{t.completed ? <CheckCircle2 size={17} /> : <Circle size={17} />}</button>
                    <div style={{ fontSize: 13.5, fontWeight: 500, flex: 1, textDecoration: t.completed ? 'line-through' : 'none', color: t.completed ? NX.faint : NX.ink }}>{t.title}</div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 9, flexWrap: 'wrap' }}>
                    <PriorityChip priority={t.priority} />
                    {t.dueOn && <span style={{ fontSize: 11.5, color: NX.dim }}>{t.dueOn}</span>}
                    {t.projectId && <span style={{ fontSize: 11.5, color: NX.faint }}>{store.projectName(t.projectId)}</span>}
                    <div style={{ marginLeft: 'auto' }}>{t.assigneeId ? <Avatar email={t.assigneeId} name={ctx.nameOf?.(t.assigneeId)} size={22} /> : null}</div>
                  </div>
                </div>
              ))}
              {c.tasks.length === 0 && addIn !== c.key && <div style={{ fontSize: 12, color: NX.faint, textAlign: 'center', padding: 14 }}>Drop tasks here</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function AddCard({ onAdd, onCancel }) {
  const [title, setTitle] = useState('');
  return (
    <div style={{ border: `1px solid ${NX.blue}`, borderRadius: 10, padding: 8, background: NX.surface }}>
      <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { onAdd(title); } if (e.key === 'Escape') onCancel(); }}
        placeholder="Task name" style={{ ...inputStyle, padding: '6px 8px', fontSize: 13, border: 'none' }} />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 4 }}>
        <button onClick={onCancel} style={{ ...btn('ghost'), fontSize: 11, padding: '4px 8px' }}>Cancel</button>
        <button onClick={() => onAdd(title)} disabled={!title.trim()} style={{ ...btn('primary'), fontSize: 11, padding: '5px 10px', opacity: title.trim() ? 1 : 0.4 }}>Add</button>
      </div>
    </div>
  );
}

function WipMenu({ limit, onSet }) {
  const [open, setOpen] = useState(false);
  const [val, setVal] = useState(limit ?? '');
  return (
    <div style={{ position: 'relative' }} onMouseLeave={() => setOpen(false)}>
      <button onClick={() => { setVal(limit ?? ''); setOpen((o) => !o); }} title="Set WIP limit" style={{ ...btn('ghost'), padding: 4, color: limit != null ? NX.blue : NX.faint }}><Gauge size={14} /></button>
      {open && (
        <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: 4, width: 160, background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,0.16)', zIndex: 40, padding: 10 }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: NX.faint, marginBottom: 6 }}>WIP limit</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input type="number" min={0} value={val} onChange={(e) => setVal(e.target.value)} placeholder="none" style={{ ...inputStyle, padding: '5px 8px', fontSize: 12 }} />
            <button onClick={() => { onSet(val === '' ? undefined : Number(val)); setOpen(false); }} style={{ ...btn('primary'), padding: '5px 9px', fontSize: 12 }}>Set</button>
          </div>
          {limit != null && <button onClick={() => { onSet(undefined); setOpen(false); }} style={{ ...btn('ghost'), fontSize: 11, marginTop: 6, color: NX.faint }}><X size={12} /> Clear limit</button>}
        </div>
      )}
    </div>
  );
}

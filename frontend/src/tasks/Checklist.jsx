// Task Module - the checklist inside a task (Oct 2026): the small steps that
// do not deserve to be subtasks. Flat, ordered lines; tick, rename, hand to
// a person, drag to reorder, paste a list to add several at once. The
// backend (routers/tasks.py, /tasks/{id}/checklist) keeps the task row's
// checklistTotal / checklistDone in step, and every write here hands the
// returned task back to the store so list rows and board cards update
// without a refetch.
import { useEffect, useRef, useState } from 'react';
import { Check, CheckCircle2, Circle, GripVertical, Plus, X } from 'lucide-react';
import { api } from '../api';
import { useTasks } from './TasksContext';
import { NX, FONT, btn } from './theme';
import { Avatar } from './components';
import { itemsFromPaste } from './lib';
import AnchoredMenu from '../components/AnchoredMenu';

function ItemAssignee({ item, people, nameOf, onChange, disabled }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const [q, setQ] = useState('');
  const shown = q ? people.filter((p) => p.name.toLowerCase().includes(q.toLowerCase())) : people;
  const name = item.assigneeId ? nameOf(item.assigneeId) : '';
  return (
    <div ref={ref} style={{ display: 'inline-flex' }} onClick={(e) => e.stopPropagation()}>
      <button type="button" disabled={disabled} onClick={() => setOpen((o) => !o)}
        title={name ? `${name} - change` : 'Hand this step to someone'}
        style={{ border: 'none', background: 'transparent', cursor: disabled ? 'default' : 'pointer', padding: 0, display: 'flex', alignItems: 'center' }}>
        {item.assigneeId
          ? <Avatar email={item.assigneeId} name={name} size={18} />
          : <span style={{ width: 18, height: 18, borderRadius: '50%', border: `1px dashed ${NX.border}`, display: 'inline-block' }} />}
      </button>
      <AnchoredMenu anchorRef={ref} open={open} onClose={() => { setOpen(false); setQ(''); }}
        style={{ width: 220, background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,0.16)', padding: 4 }}>
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people"
          style={{ width: '100%', boxSizing: 'border-box', border: `1px solid ${NX.border}`, borderRadius: 7, padding: '6px 8px', fontFamily: FONT, fontSize: 12.5, marginBottom: 4, outline: 'none' }} />
        <div style={{ maxHeight: 240, overflowY: 'auto' }}>
          <button type="button" onClick={() => { onChange(''); setOpen(false); }} style={rowBtn}>
            {!item.assigneeId ? <Check size={13} /> : <span style={{ width: 13 }} />}<span>Nobody</span>
          </button>
          {shown.map((p) => (
            <button key={p.email} type="button" onClick={() => { onChange(p.email); setOpen(false); }} style={rowBtn}>
              <Avatar email={p.email} name={p.name} size={16} card={false} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
              {item.assigneeId === p.email && <Check size={13} style={{ marginLeft: 'auto' }} />}
            </button>
          ))}
        </div>
      </AnchoredMenu>
    </div>
  );
}
const rowBtn = { display: 'flex', alignItems: 'center', gap: 8, width: '100%', border: 'none', background: 'transparent', cursor: 'pointer', padding: '6px 8px', borderRadius: 6, fontFamily: FONT, fontSize: 12.5, color: NX.ink, textAlign: 'left' };

/**
 * canEdit: may add / rename / reorder / delete (project editor). Anyone who
 * can see the task can tick a line that names them; the server enforces it,
 * this only decides what the row offers.
 */
export default function Checklist({ task, people = [], canEdit = true, autoFocusAdd = false }) {
  const { applyServerTask, nameOf, myEmail } = useTasks();
  const [items, setItems] = useState(null);
  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editText, setEditText] = useState('');
  const [dragId, setDragId] = useState(null);
  const [error, setError] = useState('');
  const taskId = task?.id;

  useEffect(() => {
    let alive = true;
    api.getTaskChecklist(taskId).then((rows) => { if (alive) setItems(rows || []); }).catch(() => { if (alive) setItems([]); });
    return () => { alive = false; };
  }, [taskId]);

  const fail = (e) => setError(e?.message || 'That did not save. Try again.');
  const takeTask = (res) => { if (res?.task) applyServerTask(res.task); };

  const add = async (titles) => {
    const list = (titles || [draft]).map((s) => s.trim()).filter(Boolean);
    if (!list.length) return;
    setDraft('');
    setError('');
    try {
      const res = await api.addTaskChecklistItems(taskId, list.length === 1 ? { title: list[0] } : { title: '', titles: list });
      setItems((prev) => [...(prev || []), ...(res.items || [])]);
      takeTask(res);
    } catch (e) { fail(e); }
  };

  const update = async (item, patch) => {
    const before = items;
    setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, ...patch } : i)));
    try {
      const res = await api.updateTaskChecklistItem(item.id, patch);
      setItems((prev) => prev.map((i) => (i.id === item.id ? res.item : i)));
      takeTask(res);
    } catch (e) { setItems(before); fail(e); }
  };

  const remove = async (item) => {
    const before = items;
    setItems((prev) => prev.filter((i) => i.id !== item.id));
    try { takeTask(await api.deleteTaskChecklistItem(item.id)); } catch (e) { setItems(before); fail(e); }
  };

  const dropOn = async (targetId) => {
    if (!dragId || dragId === targetId) { setDragId(null); return; }
    const ids = items.map((i) => i.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(targetId);
    ids.splice(from, 1);
    ids.splice(to, 0, dragId);
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    setItems(ids.map((id) => byId[id]));
    setDragId(null);
    try { setItems(await api.reorderTaskChecklist(taskId, ids)); } catch (e) { fail(e); }
  };

  const commitRename = (item) => {
    const v = editText.trim();
    setEditingId(null);
    if (v && v !== item.title) update(item, { title: v });
  };

  if (items === null) return <div style={{ fontSize: 12.5, color: NX.faint, padding: '4px 0' }}>Loading checklist…</div>;
  const done = items.filter((i) => i.done).length;

  return (
    <div data-testid="checklist">
      {items.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <div style={{ flex: 1, height: 5, borderRadius: 999, background: NX.border2 || NX.border, overflow: 'hidden' }}>
            <div style={{ width: `${Math.round((done / items.length) * 100)}%`, height: '100%', background: done === items.length ? NX.green : NX.blue, transition: 'width 0.2s' }} />
          </div>
          <span style={{ fontSize: 11.5, color: NX.faint, whiteSpace: 'nowrap' }}>{done}/{items.length}</span>
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        {items.map((item) => {
          const mine = item.assigneeId && item.assigneeId === myEmail;
          const canTick = canEdit || mine;
          return (
            <div key={item.id} draggable={canEdit} onDragStart={() => setDragId(item.id)} onDragOver={(e) => canEdit && e.preventDefault()} onDrop={() => dropOn(item.id)}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 4px', borderRadius: 7, opacity: dragId === item.id ? 0.5 : 1, background: 'transparent' }}
              onMouseEnter={(e) => { e.currentTarget.style.background = NX.hover; e.currentTarget.querySelector('[data-x]')?.style.setProperty('opacity', '1'); }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.querySelector('[data-x]')?.style.setProperty('opacity', '0'); }}>
              {canEdit && <GripVertical size={13} style={{ color: NX.faint, cursor: 'grab', flexShrink: 0 }} />}
              <button type="button" disabled={!canTick} aria-label={item.done ? 'Mark not done' : 'Mark done'} onClick={() => update(item, { done: !item.done })}
                style={{ border: 'none', background: 'transparent', cursor: canTick ? 'pointer' : 'default', padding: 0, display: 'flex', color: item.done ? NX.green : NX.faint }}>
                {item.done ? <CheckCircle2 size={16} /> : <Circle size={16} />}
              </button>
              {editingId === item.id ? (
                <input autoFocus value={editText} onChange={(e) => setEditText(e.target.value)} onBlur={() => commitRename(item)}
                  onKeyDown={(e) => { if (e.key === 'Enter') commitRename(item); if (e.key === 'Escape') setEditingId(null); }}
                  style={{ flex: 1, minWidth: 0, border: `1px solid ${NX.blue}`, borderRadius: 6, padding: '3px 6px', fontFamily: FONT, fontSize: 13, outline: 'none' }} />
              ) : (
                <span onClick={() => { if (canEdit) { setEditingId(item.id); setEditText(item.title); } }}
                  title={item.done && item.doneBy ? `Done by ${nameOf(item.doneBy)}` : (canEdit ? 'Click to rename' : undefined)}
                  style={{ flex: 1, minWidth: 0, fontSize: 13, color: item.done ? NX.faint : NX.ink, textDecoration: item.done ? 'line-through' : 'none', cursor: canEdit ? 'text' : 'default', overflowWrap: 'anywhere' }}>
                  {item.title}
                </span>
              )}
              <ItemAssignee item={item} people={people} nameOf={nameOf} disabled={!canEdit} onChange={(email) => update(item, { assignee_email: email })} />
              {canEdit && (
                <button type="button" data-x aria-label="Remove item" onClick={() => remove(item)}
                  style={{ ...btn('ghost'), padding: 2, color: NX.faint, opacity: 0, transition: 'opacity 0.1s' }}><X size={13} /></button>
              )}
            </div>
          );
        })}
      </div>
      {canEdit && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, border: `1px dashed ${NX.border}`, borderRadius: 8, padding: '6px 10px', marginTop: items.length ? 6 : 0 }}>
          <Plus size={14} style={{ color: NX.faint, flexShrink: 0 }} />
          <input value={draft} autoFocus={autoFocusAdd} onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
            onPaste={(e) => { const many = itemsFromPaste(e.clipboardData?.getData('text')); if (many) { e.preventDefault(); add(many); } }}
            placeholder={items.length ? 'Add an item' : 'Add an item, or paste a list'}
            aria-label="Add checklist item"
            style={{ flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent', fontFamily: FONT, fontSize: 13 }} />
          {draft.trim() && <button type="button" onClick={() => add()} style={{ ...btn('primary'), padding: '5px 10px', fontSize: 12 }}>Add</button>}
        </div>
      )}
      {!canEdit && items.length === 0 && <div style={{ fontSize: 12.5, color: NX.faint }}>No checklist on this task.</div>}
      {error && <div style={{ fontSize: 12, color: NX.red, marginTop: 6 }}>{error}</div>}
    </div>
  );
}

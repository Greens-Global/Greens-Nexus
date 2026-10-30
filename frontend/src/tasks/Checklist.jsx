// Task Module - the checklist inside a task (Oct 2026): the small steps that
// do not deserve to be subtasks. Flat, ordered lines; tick, rename, hand to
// a person, drag to reorder, paste a list to add several at once. The
// backend (routers/tasks.py, /tasks/{id}/checklist) keeps the task row's
// checklistTotal / checklistDone in step, and every write here hands the
// returned task back to the store so list rows and board cards update
// without a refetch.
// Convert to Subtask (Oct 22 2026): a line's "..." menu turns it into a
// subtask of the task (one server call - the line goes, the subtask arrives
// in the Subtasks list), with a toast whose Open steps into it.
import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Circle, GripVertical, ListTree, MoreHorizontal, Plus, X } from 'lucide-react';
import { draftKey, useTaskDraft } from './taskDrafts';
import { api } from '../api';
import { useTasks } from './TasksContext';
import { NX, FONT, btn } from './theme';
import { Avatar, PersonDot, SelectMenu } from './components';
import { itemsFromPaste } from './lib';

/** A line's "..." menu. Only rendered for the people who may convert it. */
function ItemMenu({ item, onConvert }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  return (
    <span ref={ref} style={{ display: 'inline-flex', flexShrink: 0 }}>
      <button type="button" aria-label={`Actions for ${item.title}`} title="More" aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen((v) => !v)} style={{ ...btn('ghost'), padding: 2, color: NX.faint }}>
        <MoreHorizontal size={14} />
      </button>
      {open && (
        <SelectMenu anchorRef={ref} onClose={() => setOpen(false)} minWidth={190}>
          <div role="menu" style={{ padding: 4 }}>
            <button type="button" role="menuitem" className="nx-menu-row" onClick={() => { setOpen(false); onConvert(item); }}
              style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '7px 9px', borderRadius: 7, border: 'none', cursor: 'pointer', fontSize: 13, fontFamily: FONT, color: NX.ink, background: 'transparent' }}>
              <ListTree size={14} /> Convert to Subtask
            </button>
          </div>
        </SelectMenu>
      )}
    </span>
  );
}

/**
 * canEdit: may add / rename / reorder / delete (project editor). Anyone who
 * can see the task can tick a line that names them; the server enforces it,
 * this only decides what the row offers. canConvert: may turn a line into a
 * subtask (editor of the task AND of its project - the Add Subtask rule -
 * and never on an HR checklist task); onOpenTask(id) opens the new subtask.
 */
export default function Checklist({ task, people = [], canEdit = true, canConvert = false, onOpenTask = null, autoFocusAdd = false }) {
  const { applyServerTask, nameOf, myEmail, convertChecklistItem, offerUndo } = useTasks();
  const [items, setItems] = useState(null);
  // The line being typed is kept per task (taskDrafts.js): another tab or
  // closing the drawer used to wipe it.
  const [lineDraft, setLineDraft, clearLine] = useTaskDraft(draftKey(task?.id, 'checklist'), { taskId: task?.id, kind: 'checklist' });
  const draft = lineDraft.text || '';
  const setDraft = (v) => (v ? setLineDraft({ text: v }) : clearLine());
  const [editingId, setEditingId] = useState(null);
  const [editText, setEditText] = useState('');
  const [dragId, setDragId] = useState(null);
  const [error, setError] = useState('');
  const taskId = task?.id;

  useEffect(() => {
    let alive = true;
    api.getTaskChecklist(taskId).then((rows) => { if (alive) setItems(rows || []); }).catch(() => { if (alive) setItems([]); });
    return () => { alive = false; };
    // The counters move when someone else ticks or adds a line (the realtime
    // ping refetches the task), and the rows here have to follow.
  }, [taskId, task?.checklistTotal, task?.checklistDone]);

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

  const convert = async (item) => {
    const before = items;
    setItems((prev) => prev.filter((i) => i.id !== item.id));
    setError('');
    try {
      const r = await convertChecklistItem(item.id);
      const id = r?.subtask?.id;
      offerUndo?.('Converted to a subtask', id && onOpenTask ? () => onOpenTask(id) : null, 'Open');
    } catch (e) {
      // A line someone else already removed or converted (409) stays gone.
      if (e?.status === 409) { setError(e.message || 'That item is no longer there.'); return; }
      setItems(before);
      fail(e);
    }
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
                  style={{ flex: 1, minWidth: 0, border: `1px solid ${NX.blue}`, borderRadius: 6, padding: '3px 6px', fontFamily: FONT, fontSize: 13 }} />
              ) : (
                <span onClick={() => { if (canEdit) { setEditingId(item.id); setEditText(item.title); } }}
                  title={item.done && item.doneBy ? `Done by ${nameOf(item.doneBy)}` : (canEdit ? 'Click to rename' : undefined)}
                  style={{ flex: 1, minWidth: 0, fontSize: 13, color: item.done ? NX.faint : NX.ink, textDecoration: item.done ? 'line-through' : 'none', cursor: canEdit ? 'text' : 'default', overflowWrap: 'anywhere' }}>
                  {item.title}
                </span>
              )}
              <PersonDot value={item.assigneeId} people={people} nameOf={nameOf} disabled={!canEdit} onChange={(email) => update(item, { assignee_email: email })} emptyTitle="Hand this step to someone" />
              {canEdit && canConvert && <ItemMenu item={item} onConvert={convert} />}
              {canEdit && (
                <button type="button" data-x aria-label="Remove item" onClick={() => remove(item)}
                  className="nx-touch-reveal" style={{ ...btn('ghost'), padding: 2, color: NX.faint, opacity: 0, transition: 'opacity 0.1s' }}><X size={13} /></button>
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
            style={{ flex: 1, minWidth: 0, border: 'none', background: 'transparent', fontFamily: FONT, fontSize: 13 }} />
          {draft.trim() && <button type="button" onClick={() => add()} style={{ ...btn('primary'), padding: '5px 10px', fontSize: 12 }}>Add</button>}
        </div>
      )}
      {!canEdit && items.length === 0 && <div style={{ fontSize: 12.5, color: NX.faint }}>No checklist on this task.</div>}
      {error && <div style={{ fontSize: 12, color: NX.red, marginTop: 6 }}>{error}</div>}
    </div>
  );
}

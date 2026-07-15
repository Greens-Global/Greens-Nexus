// Task Module — create/edit-task modal (ported 1:1 from the export's
// CreateTaskModal): Title, Description, Project, Assignee, Priority, Status,
// Due date, Estimated hours, Recurrence, Labels, Subtasks, Attachments — wired
// to the TasksContext (subtasks + attachments created after the parent).
import { useRef, useState } from 'react';
import { Plus, X, Paperclip, ListChecks, CircleCheck, Save } from 'lucide-react';
import { api } from '../api';
import { useTasks } from './TasksContext';
import { Modal, PersonSelect, usePeople, DateField } from './components';
import { NX, FONT, input, btn, STATUS_META, PRIORITY_META, STATUS_ORDER, PRIORITY_ORDER } from './theme';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const label = { fontSize: 12, fontWeight: 600, color: NX.dim, marginBottom: 5, display: 'block' };
const field = { marginBottom: 0 };
const MAX_INLINE = 2 * 1024 * 1024;

export default function CreateTaskModal({ onClose, defaults = {}, taskId }) {
  const store = useTasks();
  const { createTask, updateTask, deleteTask, tasks, projects, departments, projectById, myEmail } = store;
  const people = usePeople();
  const fileRef = useRef(null);
  const editing = taskId ? store.taskById[taskId] : null;
  const isEdit = !!editing;

  const [form, setForm] = useState(() => ({
    title: editing?.title ?? '', description: editing?.description ?? '',
    // New tasks default to the creator; editing keeps whatever the task has
    // (an unassigned task must stay unassigned).
    assigneeId: editing ? (editing.assigneeId ?? null) : (defaults.assigneeId ?? myEmail ?? null),
    priority: editing?.priority ?? 'medium', status: editing?.status ?? 'not_started',
    projectId: editing?.projectId ?? defaults.projectId ?? '', departmentId: editing?.departmentId ?? defaults.departmentId ?? '',
    dueOn: editing?.dueOn ?? '', estimate: editing?.estimateHours != null ? String(editing.estimateHours) : '',
    recurFreq: editing?.recurrence?.freq ?? 'none', recurDow: editing?.recurrence?.dayOfWeek ?? 1, recurDom: editing?.recurrence?.dayOfMonth ?? 1,
    labels: editing?.tags ?? [],
  }));
  const [labelInput, setLabelInput] = useState('');
  const [subtaskInput, setSubtaskInput] = useState('');
  const [subtasks, setSubtasks] = useState(() => editing ? tasks.filter((t) => t.parentTaskId === editing.id).map((t) => ({ id: t.id, title: t.title })) : []);
  const [attachments, setAttachments] = useState([]);   // new files only (File objects)
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const addLabel = () => { const v = labelInput.trim(); if (v && !form.labels.includes(v)) set('labels', [...form.labels, v]); setLabelInput(''); };
  const addSubtask = () => { const v = subtaskInput.trim(); if (v) setSubtasks((s) => [...s, { title: v }]); setSubtaskInput(''); };
  const onFiles = (list) => { if (list) setAttachments((prev) => [...prev, ...Array.from(list)]); };

  const recurrence = () => {
    if (form.recurFreq === 'none') return null;
    const r = { freq: form.recurFreq, interval: 1 };
    if (form.recurFreq === 'weekly') r.dayOfWeek = Number(form.recurDow);
    if (form.recurFreq === 'monthly') r.dayOfMonth = Number(form.recurDom);
    return r;
  };
  const uploadAttachment = async (parentId, f) => {
    const size = `${Math.max(1, Math.round(f.size / 1024))} KB`;
    const kind = f.type.startsWith('image/') ? 'image' : 'doc';
    const send = (url) => api.addTaskAttachment(parentId, { name: f.name, size, kind, url: url || '' }).catch(() => {});
    if (f.size <= MAX_INLINE) return new Promise((res) => { const r = new FileReader(); r.onload = () => res(send(typeof r.result === 'string' ? r.result : '')); r.onerror = () => res(send('')); r.readAsDataURL(f); });
    return send('');
  };

  const submit = async () => {
    if (!form.title.trim() || busy) return;
    setBusy(true);
    const deptId = form.departmentId || (form.projectId ? projectById(form.projectId)?.departmentId : '') || '';
    const core = {
      title: form.title.trim(), description: form.description, assigneeId: form.assigneeId || '',
      priority: form.priority, status: form.status, projectId: form.projectId || '', departmentId: deptId,
      dueOn: form.dueOn || '', estimateHours: form.estimate ? Number(form.estimate) : null, tags: form.labels, recurrence: recurrence(),
    };
    try {
      let parentId = taskId;
      if (isEdit) {
        await updateTask(taskId, core);
        const kept = subtasks.filter((s) => s.id).map((s) => s.id);
        for (const t of tasks.filter((t) => t.parentTaskId === taskId)) if (!kept.includes(t.id)) await deleteTask(t.id).catch(() => {});
        for (const s of subtasks) if (s.id) { if (store.taskById[s.id]?.title !== s.title) await updateTask(s.id, { title: s.title }).catch(() => {}); }
      } else {
        const created = await createTask(core);
        parentId = created.id;
      }
      for (const s of subtasks.filter((s) => !s.id)) await createTask({ title: s.title, parentTaskId: parentId, projectId: form.projectId || '', departmentId: deptId, status: 'not_started', priority: 'medium', type: 'task' }).catch(() => {});
      for (const f of attachments) await uploadAttachment(parentId, f);
      onClose(true);
    } catch (e) { alert(`Could not save task: ${e.message || e}`); setBusy(false); }
  };

  const sel = { ...input, cursor: 'pointer' };
  return (
    <Modal title={isEdit ? 'Edit task' : 'Create task'} width={640} onClose={() => onClose(false)} footer={
      <>
        <button style={btn('ghost')} onClick={() => onClose(false)}>Cancel</button>
        <button style={{ ...btn('primary'), opacity: busy || !form.title.trim() ? 0.6 : 1 }} onClick={submit} disabled={busy || !form.title.trim()}>
          {isEdit ? <><Save size={15} /> Save changes</> : <><Plus size={15} /> Create task</>}
        </button>
      </>
    }>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={field}>
          <label style={label}>Title <span style={{ color: NX.red }}>*</span></label>
          <input autoFocus value={form.title} onChange={(e) => set('title', e.target.value)} placeholder="What needs to be done?" style={input}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(); }} />
        </div>
        <div style={field}>
          <label style={label}>Description</label>
          <textarea value={form.description} onChange={(e) => set('description', e.target.value)} rows={3} placeholder="Add more detail…" style={{ ...input, resize: 'vertical', fontFamily: FONT }} />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div style={field}>
            <label style={label}>Project</label>
            <select value={form.projectId} onChange={(e) => set('projectId', e.target.value)} style={sel}>
              <option value="">No project</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div style={field}>
            <label style={label}>Assignee</label>
            <PersonSelect value={form.assigneeId} onChange={(v) => set('assigneeId', v)} people={people} />
          </div>
          <div style={field}>
            <label style={label}>Priority</label>
            <select value={form.priority} onChange={(e) => set('priority', e.target.value)} style={sel}>
              {PRIORITY_ORDER.map((p) => <option key={p} value={p}>{PRIORITY_META[p].label}</option>)}
            </select>
          </div>
          <div style={field}>
            <label style={label}>Status</label>
            <select value={form.status} onChange={(e) => set('status', e.target.value)} style={sel}>
              {STATUS_ORDER.map((s) => <option key={s} value={s}>{STATUS_META[s].label}</option>)}
            </select>
          </div>
          <div style={field}>
            <label style={label}>Due date</label>
            <DateField value={form.dueOn} onChange={(v) => set('dueOn', v || '')} placeholder="Pick a date" style={input} />
          </div>
          <div style={field}>
            <label style={label}>Estimated hours</label>
            <input type="number" min="0" step="0.5" value={form.estimate} onChange={(e) => set('estimate', e.target.value)} placeholder="0" style={input} />
          </div>
          <div style={field}>
            <label style={label}>Recurrence</label>
            <select value={form.recurFreq} onChange={(e) => set('recurFreq', e.target.value)} style={sel}>
              <option value="none">Does not repeat</option>
              <option value="daily">Every day</option>
              <option value="weekly">Every week</option>
              <option value="monthly">Every month</option>
            </select>
          </div>
          {form.recurFreq === 'weekly' && (
            <div style={field}>
              <label style={label}>Day of week</label>
              <select value={form.recurDow} onChange={(e) => set('recurDow', e.target.value)} style={sel}>
                {DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
              </select>
            </div>
          )}
          {form.recurFreq === 'monthly' && (
            <div style={field}>
              <label style={label}>Day of month</label>
              <select value={form.recurDom} onChange={(e) => set('recurDom', e.target.value)} style={sel}>
                {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>Day {d}</option>)}
              </select>
            </div>
          )}
        </div>

        <div style={field}>
          <label style={label}>Labels</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
            {form.labels.map((l) => (
              <span key={l} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: NX.border2, color: NX.dim, borderRadius: 6, padding: '3px 8px', fontSize: 12, fontWeight: 600 }}>
                {l}<button onClick={() => set('labels', form.labels.filter((x) => x !== l))} style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: NX.faint, display: 'flex', padding: 0 }}><X size={12} /></button>
              </span>
            ))}
            <input value={labelInput} onChange={(e) => setLabelInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addLabel(); } }} placeholder="Add label + Enter" style={{ ...input, width: 160, padding: '5px 9px', fontSize: 13 }} />
          </div>
        </div>

        <div style={field}>
          <label style={label}>Subtasks</label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {subtasks.map((s, i) => (
              <div key={s.id ?? `new-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 8, border: `1px solid ${NX.border}`, borderRadius: 8, padding: '6px 10px', fontSize: 13 }}>
                <CircleCheck size={15} style={{ color: NX.faint }} /><span style={{ flex: 1 }}>{s.title}</span>
                <button onClick={() => setSubtasks((arr) => arr.filter((_, x) => x !== i))} style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: NX.faint, display: 'flex' }}><X size={13} /></button>
              </div>
            ))}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, border: `1px dashed ${NX.border}`, borderRadius: 8, padding: '6px 10px' }}>
              <ListChecks size={15} style={{ color: NX.faint }} />
              <input value={subtaskInput} onChange={(e) => setSubtaskInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addSubtask(); } }} placeholder="Add subtask + Enter" style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', fontFamily: FONT, fontSize: 13 }} />
            </div>
          </div>
        </div>

        <div style={field}>
          <label style={label}>Attachments</label>
          <input ref={fileRef} type="file" multiple style={{ display: 'none' }} onChange={(e) => { onFiles(e.target.files); e.target.value = ''; }} />
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
            {attachments.map((f, i) => (
              <span key={`${f.name}-${i}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, border: `1px solid ${NX.border}`, borderRadius: 8, padding: '3px 8px', fontSize: 12 }}>
                <Paperclip size={12} /> {f.name}
                <button onClick={() => setAttachments((arr) => arr.filter((_, x) => x !== i))} style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: NX.faint, display: 'flex' }}><X size={12} /></button>
              </span>
            ))}
            <button type="button" onClick={() => fileRef.current?.click()} style={{ ...btn('outline'), fontSize: 12, padding: '6px 10px' }}><Paperclip size={13} /> Attach file</button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

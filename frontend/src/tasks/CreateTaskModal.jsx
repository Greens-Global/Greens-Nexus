// Task Module — create-task modal.
import { useState } from 'react';
import { useTasks } from './TasksContext';
import { Modal, PersonSelect, usePeople } from './components';
import { NX, FONT, input, btn, STATUS_META, PRIORITY_META, STATUS_ORDER, PRIORITY_ORDER } from './theme';

const label = { fontSize: 12, fontWeight: 600, color: NX.dim, marginBottom: 5, display: 'block' };
const field = { marginBottom: 14 };

export default function CreateTaskModal({ onClose, defaults = {} }) {
  const { createTask, projects, departments } = useTasks();
  const people = usePeople();
  const [form, setForm] = useState({
    title: '', description: '', assigneeId: null, priority: 'medium', status: 'not_started',
    projectId: defaults.projectId || '', departmentId: defaults.departmentId || '', dueOn: '',
    ...defaults,
  });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async () => {
    if (!form.title.trim() || busy) return;
    setBusy(true);
    try {
      await createTask({
        title: form.title.trim(), description: form.description, assigneeId: form.assigneeId || '',
        priority: form.priority, status: form.status, projectId: form.projectId || '',
        departmentId: form.departmentId || '', dueOn: form.dueOn || '',
      });
      onClose(true);
    } catch (e) { alert(`Could not create task: ${e.message || e}`); setBusy(false); }
  };

  const sel = { ...input, appearance: 'auto', cursor: 'pointer' };
  return (
    <Modal title="Create task" onClose={() => onClose(false)} footer={
      <>
        <button style={btn('outline')} onClick={() => onClose(false)}>Cancel</button>
        <button style={{ ...btn('primary'), opacity: busy ? 0.6 : 1 }} onClick={submit} disabled={busy}>{busy ? 'Creating…' : 'Create task'}</button>
      </>
    }>
      <div style={field}>
        <label style={label}>Title</label>
        <input autoFocus value={form.title} onChange={(e) => set('title', e.target.value)} placeholder="What needs to be done?" style={input}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(); }} />
      </div>
      <div style={field}>
        <label style={label}>Description</label>
        <textarea value={form.description} onChange={(e) => set('description', e.target.value)} rows={3} style={{ ...input, resize: 'vertical', fontFamily: FONT }} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div style={field}>
          <label style={label}>Assignee</label>
          <PersonSelect value={form.assigneeId} onChange={(v) => set('assigneeId', v)} people={people} />
        </div>
        <div style={field}>
          <label style={label}>Due date</label>
          <input type="date" value={form.dueOn} onChange={(e) => set('dueOn', e.target.value)} style={input} />
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
          <label style={label}>Project</label>
          <select value={form.projectId} onChange={(e) => set('projectId', e.target.value)} style={sel}>
            <option value="">No project</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div style={field}>
          <label style={label}>Department</label>
          <select value={form.departmentId} onChange={(e) => set('departmentId', e.target.value)} style={sel}>
            <option value="">No department</option>
            {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>
      </div>
    </Modal>
  );
}

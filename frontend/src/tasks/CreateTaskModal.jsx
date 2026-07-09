// Task Module — create/edit-task modal (dual mode, ported from the export's CreateTaskModal.tsx).
import { useEffect, useRef, useState } from 'react';
import { X, Paperclip, Plus, Save, ListChecks } from 'lucide-react';
import { useTasks } from './TasksContext';
import { Modal, PersonSelect, usePeople } from './components';
import { toast } from './shared';
import { NX, FONT, input, btn, STATUS_META, PRIORITY_META, STATUS_ORDER, PRIORITY_ORDER } from './theme';

const label = { fontSize: 12, fontWeight: 600, color: NX.dim, marginBottom: 5, display: 'block' };
const field = { marginBottom: 14 };
const req = <span style={{ color: NX.red }}>*</span>;
const errText = { fontSize: 12, color: NX.red, marginTop: 4 };
const DAYS_OF_WEEK = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export default function CreateTaskModal({ taskId, defaults = {}, defaultStatus, onClose }) {
  const {
    createTask, updateTask, addSubtask, addAttachment, removeAttachment, deleteTask,
    projects, departments, projectById, taskById, tasks, getAttachments, myEmail,
  } = useTasks();
  const people = usePeople();
  const fileRef = useRef(null);

  const editing = taskId ? taskById[taskId] : undefined;
  const isEdit = Boolean(editing);

  // ── Field state (prefilled in edit mode) ───────────────────────────────────
  const [title, setTitle] = useState(editing?.title ?? '');
  const [description, setDescription] = useState(editing?.description ?? '');
  const [projectId, setProjectId] = useState(editing?.projectId ?? (defaults.projectId || projects[0]?.id || ''));
  const [manualDept, setManualDept] = useState(editing?.departmentId ?? (defaults.departmentId || ''));
  const [assigneeId, setAssigneeId] = useState(editing?.assigneeId ?? (myEmail || null));
  const [priority, setPriority] = useState(editing?.priority ?? 'medium');
  const [status, setStatus] = useState(editing?.status ?? defaultStatus ?? 'not_started');
  const [dueOn, setDueOn] = useState(editing?.dueOn ?? '');
  const [estimate, setEstimate] = useState(editing?.estimateHours != null ? String(editing.estimateHours) : '');
  const [recurFreq, setRecurFreq] = useState(
    editing?.recurrence?.freq === 'yearly' ? 'monthly' : (editing?.recurrence?.freq ?? 'none'));
  const [recurDayOfWeek, setRecurDayOfWeek] = useState(editing?.recurrence?.dayOfWeek ?? 0);
  const [recurDayOfMonth, setRecurDayOfMonth] = useState(editing?.recurrence?.dayOfMonth ?? 1);
  const [labels, setLabels] = useState(editing?.tags ?? []);
  const [labelInput, setLabelInput] = useState('');

  // Subtasks are stored as their own tasks (parentTaskId); derive existing ones at mount.
  const [origSubIds] = useState(() => (editing ? tasks.filter((t) => t.parentTaskId === taskId).map((t) => t.id) : []));
  const [subtasks, setSubtasks] = useState(() =>
    editing ? tasks.filter((t) => t.parentTaskId === taskId).map((t) => ({ id: t.id, title: t.title })) : []);
  const [subtaskInput, setSubtaskInput] = useState('');

  // Attachments loaded on demand in edit mode.
  const [attachments, setAttachments] = useState([]);
  const [origAttIds, setOrigAttIds] = useState([]);
  useEffect(() => {
    if (!editing) return undefined;
    let alive = true;
    getAttachments(taskId).then((rows) => {
      if (!alive) return;
      const mapped = (rows || []).map((a) => ({ id: a.id, name: a.name, size: a.size, kind: a.kind }));
      setAttachments(mapped);
      setOrigAttIds(mapped.map((a) => a.id));
    }).catch(() => {});
    return () => { alive = false; };
  }, [editing, taskId, getAttachments]);

  const [attemptedSubmit, setAttemptedSubmit] = useState(false);
  const [busy, setBusy] = useState(false);

  // ── Derived department (auto from project; manual only when project has none) ─
  const derivedDeptId = projectId ? (projectById(projectId)?.departmentId ?? null) : null;
  const showManualDept = Boolean(projectId) && !derivedDeptId;

  // ── Validation ──────────────────────────────────────────────────────────────
  const titleValid = Boolean(title.trim());
  const projectValid = Boolean(projectId);
  const dueDateValid = Boolean(dueOn);
  const formValid = titleValid && projectValid && dueDateValid;

  // ── List builders ────────────────────────────────────────────────────────────
  const addLabel = () => {
    const v = labelInput.trim();
    if (v && !labels.includes(v)) setLabels((l) => [...l, v]);
    setLabelInput('');
  };
  const addSubtaskDraft = () => {
    const v = subtaskInput.trim();
    if (v) setSubtasks((s) => [...s, { title: v }]);
    setSubtaskInput('');
  };
  const onFiles = (list) => {
    if (!list) return;
    setAttachments((prev) => [
      ...prev,
      ...Array.from(list).map((f) => ({
        name: f.name,
        size: `${Math.max(1, Math.round(f.size / 1024))} KB`,
        kind: f.type.startsWith('image/') ? 'image' : 'doc',
      })),
    ]);
  };

  const submit = async () => {
    setAttemptedSubmit(true);
    if (!formValid || busy) return;
    setBusy(true);

    const departmentId = derivedDeptId ?? (manualDept || null);
    const recurrence = recurFreq === 'none' ? null : {
      freq: recurFreq,
      interval: 1,
      ...(recurFreq === 'weekly' ? { dayOfWeek: recurDayOfWeek } : {}),
      ...(recurFreq === 'monthly' ? { dayOfMonth: recurDayOfMonth } : {}),
    };
    const core = {
      title: title.trim(),
      description: description.trim(),
      projectId,
      departmentId,
      assigneeId: assigneeId || myEmail || '',
      priority,
      status,
      dueOn,
      estimateHours: estimate ? Number(estimate) : null,
      tags: labels,
      recurrence,
    };

    try {
      if (isEdit) {
        // Optimistic core edit (updateTask rolls back internally on API failure).
        await updateTask(taskId, core);

        // Subtasks: delete removed, add new, rename changed.
        const keptSub = subtasks.filter((s) => s.id).map((s) => s.id);
        for (const id of origSubIds) {
          if (!keptSub.includes(id)) await deleteTask(id);
        }
        for (const s of subtasks) {
          if (s.id) {
            if (taskById[s.id]?.title !== s.title) await updateTask(s.id, { title: s.title });
          } else {
            await addSubtask(editing, { title: s.title });
          }
        }

        // Attachments: remove dropped, add new.
        const keptAtt = attachments.filter((a) => a.id).map((a) => a.id);
        for (const id of origAttIds) {
          if (!keptAtt.includes(id)) await removeAttachment(id);
        }
        for (const a of attachments.filter((a) => !a.id)) {
          await addAttachment(taskId, { name: a.name, size: a.size, kind: a.kind, url: '' });
        }

        toast(`Saved changes to “${title.trim()}”`, 'success');
      } else {
        const created = await createTask(core);
        for (const s of subtasks) await addSubtask(created, { title: s.title });
        for (const a of attachments) await addAttachment(created.id, { name: a.name, size: a.size, kind: a.kind, url: '' });
        toast(`Created “${title.trim()}”`, 'success');
      }
      onClose();
    } catch (e) {
      toast(`Couldn't save changes: ${e.message || e}`);
      setBusy(false);
    }
  };

  const sel = { ...input, appearance: 'auto', cursor: 'pointer' };
  const bad = (isBad) => (isBad ? { borderColor: NX.red } : null);

  return (
    <Modal title={isEdit ? 'Edit task' : 'Create task'} width={620} onClose={onClose} footer={
      <>
        <button style={btn('outline')} onClick={onClose}>Cancel</button>
        <button
          style={{ ...btn('primary'), opacity: (busy || (attemptedSubmit && !formValid)) ? 0.6 : 1 }}
          onClick={submit}
          disabled={busy || (attemptedSubmit && !formValid)}
        >
          {isEdit ? <Save size={15} /> : <Plus size={15} />}
          {busy ? 'Saving…' : (isEdit ? 'Save changes' : 'Create task')}
        </button>
      </>
    }>
      <div style={field}>
        <label style={label}>Title {req}</label>
        <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs to be done?"
          style={{ ...input, ...bad(attemptedSubmit && !titleValid) }}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(); }} />
        {attemptedSubmit && !titleValid && <div style={errText}>Title is required</div>}
      </div>

      <div style={field}>
        <label style={label}>Description</label>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder="Add more detail…"
          style={{ ...input, resize: 'vertical', fontFamily: FONT }} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div style={field}>
          <label style={label}>Project {req}</label>
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)} style={{ ...sel, ...bad(attemptedSubmit && !projectValid) }}>
            <option value="">Select project</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          {attemptedSubmit && !projectValid && <div style={errText}>Project is required</div>}
        </div>
        <div style={field}>
          <label style={label}>Assignee</label>
          <PersonSelect value={assigneeId} onChange={(v) => setAssigneeId(v)} people={people} />
        </div>
        <div style={field}>
          <label style={label}>Priority</label>
          <select value={priority} onChange={(e) => setPriority(e.target.value)} style={sel}>
            {PRIORITY_ORDER.map((p) => <option key={p} value={p}>{PRIORITY_META[p].label}</option>)}
          </select>
        </div>
        <div style={field}>
          <label style={label}>Status</label>
          <select value={status} onChange={(e) => setStatus(e.target.value)} style={sel}>
            {STATUS_ORDER.map((s) => <option key={s} value={s}>{STATUS_META[s].label}</option>)}
          </select>
        </div>
        <div style={field}>
          <label style={label}>Due date {req}</label>
          <input type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)}
            style={{ ...input, ...bad(attemptedSubmit && !dueDateValid) }} />
          {attemptedSubmit && !dueDateValid && <div style={errText}>Due date is required</div>}
        </div>
        <div style={field}>
          <label style={label}>Estimated hours</label>
          <input type="number" min="0" step="0.5" value={estimate} onChange={(e) => setEstimate(e.target.value)} placeholder="0" style={input} />
        </div>
        <div style={field}>
          <label style={label}>Recurrence</label>
          <select value={recurFreq} onChange={(e) => setRecurFreq(e.target.value)} style={sel}>
            <option value="none">Does not repeat</option>
            <option value="daily">Every day</option>
            <option value="weekly">Every week</option>
            <option value="monthly">Every month</option>
          </select>
        </div>
        {recurFreq === 'weekly' && (
          <div style={field}>
            <label style={label}>Day of week</label>
            <select value={String(recurDayOfWeek)} onChange={(e) => setRecurDayOfWeek(Number(e.target.value))} style={sel}>
              {DAYS_OF_WEEK.map((d, i) => <option key={d} value={String(i)}>{d}</option>)}
            </select>
          </div>
        )}
        {recurFreq === 'monthly' && (
          <div style={field}>
            <label style={label}>Day of month</label>
            <select value={String(recurDayOfMonth)} onChange={(e) => setRecurDayOfMonth(Number(e.target.value))} style={sel}>
              {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => <option key={d} value={String(d)}>Day {d}</option>)}
            </select>
          </div>
        )}
        {showManualDept && (
          <div style={field}>
            <label style={label}>Department</label>
            <select value={manualDept} onChange={(e) => setManualDept(e.target.value)} style={sel}>
              <option value="">No department</option>
              {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
        )}
      </div>

      {/* Labels */}
      <div style={field}>
        <label style={label}>Labels</label>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
          {labels.map((l) => (
            <span key={l} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 9px', borderRadius: 999, fontSize: 12, fontWeight: 600, background: NX.hover, color: NX.ink }}>
              {l}
              <button type="button" onClick={() => setLabels((arr) => arr.filter((x) => x !== l))}
                style={{ ...btn('ghost'), padding: 0, color: NX.faint }} aria-label={`Remove ${l}`}><X size={13} /></button>
            </span>
          ))}
          <input value={labelInput} onChange={(e) => setLabelInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addLabel(); } }}
            placeholder="Add label + Enter" style={{ ...input, width: 170, padding: '6px 10px' }} />
        </div>
      </div>

      {/* Subtasks */}
      <div style={field}>
        <label style={label}>Subtasks</label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {subtasks.map((s, i) => (
            <div key={s.id ?? `new-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 8, border: `1px solid ${NX.border}`, borderRadius: 8, padding: '7px 10px', fontSize: 13, color: NX.ink }}>
              <ListChecks size={15} style={{ color: NX.faint, flexShrink: 0 }} />
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.title}</span>
              <button type="button" onClick={() => setSubtasks((arr) => arr.filter((_, x) => x !== i))}
                style={{ ...btn('ghost'), padding: 0, color: NX.faint }} aria-label="Remove subtask"><X size={14} /></button>
            </div>
          ))}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, border: `1px dashed ${NX.border}`, borderRadius: 8, padding: '7px 10px' }}>
            <ListChecks size={15} style={{ color: NX.faint, flexShrink: 0 }} />
            <input value={subtaskInput} onChange={(e) => setSubtaskInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addSubtaskDraft(); } }}
              placeholder="Add subtask + Enter"
              style={{ flex: 1, border: 'none', outline: 'none', fontSize: 13, fontFamily: FONT, color: NX.ink, background: 'transparent' }} />
          </div>
        </div>
      </div>

      {/* Attachments */}
      <div style={field}>
        <label style={label}>Attachments</label>
        <input ref={fileRef} type="file" multiple style={{ display: 'none' }} onChange={(e) => { onFiles(e.target.files); e.target.value = ''; }} />
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          {attachments.map((f, i) => (
            <span key={f.id ?? `new-${i}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: `1px solid ${NX.border}`, borderRadius: 999, padding: '3px 10px', fontSize: 12, color: NX.ink }}>
              <Paperclip size={12} style={{ color: NX.faint }} />
              {f.name}
              <span style={{ color: NX.faint }}>{f.size}</span>
              <button type="button" onClick={() => setAttachments((arr) => arr.filter((_, x) => x !== i))}
                style={{ ...btn('ghost'), padding: 0, color: NX.faint }} aria-label={`Remove ${f.name}`}><X size={13} /></button>
            </span>
          ))}
          <button type="button" onClick={() => fileRef.current?.click()} style={{ ...btn('outline'), padding: '6px 10px' }}>
            <Paperclip size={14} /> Attach file
          </button>
        </div>
      </div>
    </Modal>
  );
}

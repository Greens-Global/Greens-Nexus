// Task Module - create/edit-task modal (ported 1:1 from the export's
// CreateTaskModal): Title, Description, Project, Assignee, Priority, Status,
// Due date, Estimated hours, Recurrence, Labels, Subtasks, Attachments - wired
// to the TasksContext (subtasks + attachments created after the parent).
import { useRef, useState } from 'react';
import { Plus, X, Paperclip, ListChecks, CircleCheck, Save, Image as ImageIcon, ScanText, Camera, ImagePlus } from 'lucide-react';
import { api } from '../api';
import { useTasks } from './TasksContext';
import { Modal, PersonSelect, PersonMultiSelect, usePeople, DateField, useIsMobile } from './components';
import { ProjectCreateModal } from './ProjectsView';
import { CustomFieldInput } from './TaskDetailDrawer';
import { filesFromPaste, teamInProject, fieldsForProject, uploadTaskAttachment } from './lib';
import ProjectPicker from './ProjectPicker';
import RichDescription from './RichDescription';
import { NX, FONT, input, btn, STATUS_META, PRIORITY_META, STATUS_ORDER, PRIORITY_ORDER } from './theme';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const label = { fontSize: 12, fontWeight: 600, color: NX.dim, marginBottom: 5, display: 'block' };
const field = { marginBottom: 0 };

export default function CreateTaskModal({ onClose, defaults = {}, taskId, lockedProjectId = '' }) {
  const store = useTasks();
  const { createTask, updateTask, deleteTask, tasks, projects, teams, myEmail, customFields = [] } = store;
  const people = usePeople();
  const fileRef = useRef(null);
  const editing = taskId ? store.taskById[taskId] : null;
  const isEdit = !!editing;

  const [form, setForm] = useState(() => ({
    title: editing?.title ?? defaults.title ?? '', description: editing?.description ?? '',
    // New tasks default assignee AND owner to the creator; editing keeps whatever
    // the task has (an unassigned / unowned task must stay that way).
    assigneeId: editing ? (editing.assigneeId ?? null) : (defaults.assigneeId ?? myEmail ?? null),
    ownerId: editing ? (editing.ownerId ?? null) : (defaults.ownerId ?? myEmail ?? null),
    priority: editing?.priority ?? defaults.priority ?? 'medium', status: editing?.status ?? defaults.status ?? 'not_started',
    projectId: editing?.projectId ?? defaults.projectId ?? '',
    teamId: editing?.teamId ?? defaults.teamId
      ?? (() => {
        // Opened inside a project (or with one defaulted): inherit its team when
        // that's unambiguous, so the common case needs no extra click.
        const pid = defaults.projectId || lockedProjectId || '';
        const own = pid ? (store.teams || []).filter((t) => teamInProject(t, pid)) : [];
        return own.length === 1 ? own[0].id : '';
      })(),
    dueOn: editing?.dueOn ?? defaults.dueOn ?? '',
    estimateHrs: editing?.estimateHours ? String(Math.floor(editing.estimateHours)) : '',
    estimateMin: editing?.estimateHours && editing.estimateHours % 1 ? String(Math.round((editing.estimateHours % 1) * 60)) : '',
    recurFreq: editing?.recurrence?.freq ?? 'none', recurDow: editing?.recurrence?.dayOfWeek ?? 1, recurDom: editing?.recurrence?.dayOfMonth ?? 1,
    recurEnd: editing?.recurrence?.until ? 'on' : editing?.recurrence?.count ? 'after' : 'never',
    recurUntil: editing?.recurrence?.until ?? '', recurCount: editing?.recurrence?.count != null ? String(editing.recurrence.count) : '',
    followerIds: editing?.followerIds ?? defaults.followerIds ?? [],
    labels: editing?.tags ?? [],
    customFieldValues: editing?.customFieldValues ?? {},
  }));
  const [labelInput, setLabelInput] = useState('');
  const [subtaskInput, setSubtaskInput] = useState('');
  const [subtasks, setSubtasks] = useState(() => editing ? tasks.filter((t) => t.parentTaskId === editing.id).map((t) => ({ id: t.id, title: t.title })) : []);
  const [attachments, setAttachments] = useState([]);   // new files only (File objects)
  const [busy, setBusy] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  // Frozen on first render (not re-derived from `editing`/`defaults`, which can
  // change identity across re-renders) so later edits always compare against
  // what was actually loaded into the form.
  const [initialForm] = useState(() => form);
  const [initialSubtasks] = useState(() => subtasks);
  const dirty = JSON.stringify(form) !== JSON.stringify(initialForm)
    || JSON.stringify(subtasks) !== JSON.stringify(initialSubtasks)
    || attachments.length > 0;

  const addLabel = () => { const v = labelInput.trim(); if (v && !form.labels.includes(v)) set('labels', [...form.labels, v]); setLabelInput(''); };
  const addSubtask = () => { const v = subtaskInput.trim(); if (v) setSubtasks((s) => [...s, { title: v }]); setSubtaskInput(''); };
  const onFiles = (list) => { if (list) setAttachments((prev) => [...prev, ...Array.from(list)]); };
  const onPasteFiles = (e) => { const files = filesFromPaste(e); if (files.length) { e.preventDefault(); onFiles(files); } };

  // Mobile capture shortcuts in the footer - photo / attach / scan, mirroring the
  // quick-create sheet so the same three actions are one tap away on a phone
  // instead of buried at the bottom of a long scrolling form.
  const isMobile = useIsMobile();
  const camRef = useRef(null);
  const libRef = useRef(null);
  const scanRef = useRef(null);
  const [photoMenu, setPhotoMenu] = useState(false);
  const [ocrBusy, setOcrBusy] = useState(false);

  // ABC scanner → capture a photo, OCR it server-side, append the text to the title.
  const onScan = async (e) => {
    const f = e.target.files?.[0]; e.target.value = '';
    if (!f) return;
    setOcrBusy(true);
    try {
      const { text } = await api.ocrImage(f);
      if (text && text.trim()) set('title', (form.title ? `${form.title} ` : '') + text.trim().replace(/\s+/g, ' '));
      else alert('No text found in the image.');
    } catch { alert("Couldn't extract text from the image."); }
    finally { setOcrBusy(false); }
  };

  const recurrence = () => {
    if (form.recurFreq === 'none') return null;
    const r = { freq: form.recurFreq, interval: 1 };
    if (form.recurFreq === 'weekly') r.dayOfWeek = Number(form.recurDow);
    if (form.recurFreq === 'monthly') r.dayOfMonth = Number(form.recurDom);
    if (form.recurEnd === 'on' && form.recurUntil) r.until = form.recurUntil;
    if (form.recurEnd === 'after' && form.recurCount) r.count = Math.max(1, Number(form.recurCount));
    return r;
  };
  // Selecting a recurrence flips the task to the "Recurring" status; clearing it
  // back to "Does not repeat" reverts a still-recurring status to Not Started.
  const setRecurFreq = (v) => setForm((f) => ({
    ...f, recurFreq: v,
    status: v !== 'none' ? 'recurring' : (f.status === 'recurring' ? 'not_started' : f.status),
  }));
  const uploadAttachment = (parentId, f) => uploadTaskAttachment(parentId, f).catch(() => {});

  // Required on CREATE: Task Name, Assignee, Due Date, Project (a locked project
  // already satisfies the last). Editing is NOT gated - the rule is about what a
  // new task must carry, and gating Save would strand every older task.
  const missing = isEdit ? [] : [
    !form.title.trim() && 'title',
    !form.assigneeId && 'assignee',
    !form.dueOn && 'due',
    !(lockedProjectId || form.projectId) && 'project',
  ].filter(Boolean);
  // Only the fields that apply to the chosen project - a field scoped to
  // another project must not appear, let alone be required here.
  const activeFields = fieldsForProject(customFields, lockedProjectId || form.projectId);
  // A read-only field is calculated in Asana and can never be filled in here,
  // so requiring one would make the form unsubmittable. List-shaped values
  // (multiselect/people) are empty as [], which is not '' - checking only for ''
  // let a required one through empty.
  const isBlank = (v) => v == null || v === '' || (Array.isArray(v) && v.length === 0);
  const missingFields = isEdit ? [] : activeFields.filter(
    (f) => f.required && !f.readOnly && isBlank(form.customFieldValues[f.id]));
  const canSubmit = missing.length === 0 && missingFields.length === 0 && !busy;
  const req = <span style={{ color: NX.red }}>*</span>;
  const missStyle = (key) => (missing.includes(key) ? { borderColor: NX.red } : null);

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    const core = {
      title: form.title.trim(), description: form.description, assigneeId: form.assigneeId || '', ownerId: form.ownerId || '',
      priority: form.priority, status: form.recurFreq !== 'none' ? 'recurring' : form.status, projectId: form.projectId || '', teamId: form.teamId || '',
      dueOn: form.dueOn || '', estimateHours: (form.estimateHrs || form.estimateMin) ? (Number(form.estimateHrs || 0) + Number(form.estimateMin || 0) / 60) : null, tags: form.labels, recurrence: recurrence(),
      followerIds: form.followerIds,
      customFieldValues: form.customFieldValues,
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
      for (const s of subtasks.filter((s) => !s.id)) await createTask({ title: s.title, parentTaskId: parentId, projectId: form.projectId || '', teamId: form.teamId || '', status: 'not_started', priority: 'medium', type: 'task' }).catch(() => {});
      for (const f of attachments) await uploadAttachment(parentId, f);
      onClose(true);
    } catch (e) { alert(`Could not save task: ${e.message || e}`); setBusy(false); }
  };

  const sel = { ...input, cursor: 'pointer' };
  return (
    <Modal title={isEdit ? 'Edit Task' : 'Create a Task'} width={640} onClose={() => onClose(false)}
      isDirty={dirty} onSave={canSubmit ? submit : undefined} footer={
      <>
        {/* Phone only - desktop already has the Attachments field in view without
            scrolling, and a camera/scan shortcut is meaningless with a mouse. */}
        {isMobile && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 2, marginRight: 'auto', position: 'relative' }}>
            <button type="button" title="Add photo" aria-label="Add photo" onClick={() => setPhotoMenu((v) => !v)}
              style={{ ...btn('ghost'), padding: 7, color: NX.dim }}><ImageIcon size={20} /></button>
            <button type="button" title="Attach file" aria-label="Attach file" onClick={() => fileRef.current?.click()}
              style={{ ...btn('ghost'), padding: 7, color: NX.dim }}><Paperclip size={20} /></button>
            <button type="button" title="Scan text" aria-label="Scan text" disabled={ocrBusy} onClick={() => scanRef.current?.click()}
              style={{ ...btn('ghost'), padding: 7, color: NX.dim, opacity: ocrBusy ? 0.5 : 1 }}><ScanText size={20} /></button>
            {ocrBusy && <span style={{ fontSize: 12, color: NX.faint }}>Scanning…</span>}
            {attachments.length > 0 && (
              <span style={{ fontSize: 12, color: NX.faint, marginLeft: 2 }}>{attachments.length}</span>
            )}
            {photoMenu && (
              /* Opens upward - the footer is pinned to the bottom of the modal. */
              <div style={{ position: 'absolute', bottom: '100%', left: 0, marginBottom: 6, background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 10, boxShadow: '0 10px 28px rgba(0,0,0,0.18)', zIndex: 10, padding: 4, minWidth: 180 }}>
                <button type="button" onClick={() => { setPhotoMenu(false); camRef.current?.click(); }} style={{ ...btn('ghost'), width: '100%', justifyContent: 'flex-start', gap: 8 }}><Camera size={16} /> Take photo</button>
                <button type="button" onClick={() => { setPhotoMenu(false); libRef.current?.click(); }} style={{ ...btn('ghost'), width: '100%', justifyContent: 'flex-start', gap: 8 }}><ImagePlus size={16} /> Choose from device</button>
              </div>
            )}
            {/* capture="environment" opens the rear camera on a phone. */}
            <input ref={camRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={(e) => { onFiles(e.target.files); e.target.value = ''; }} />
            <input ref={libRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => { onFiles(e.target.files); e.target.value = ''; }} />
            <input ref={scanRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={onScan} />
          </div>
        )}
        <button style={btn('ghost')} onClick={() => onClose(false)}>Cancel</button>
        <button title={missing.length ? 'Fill in the required fields (marked *)' : undefined}
          style={{ ...btn('primary'), opacity: !canSubmit ? 0.6 : 1 }} onClick={submit} disabled={!canSubmit}>
          {isEdit ? <><Save size={15} /> Save Changes</> : <><Plus size={15} /> Create Task</>}
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
          {/* No onAttachFile: the task doesn't exist yet, so there's nothing to
              attach a file TO. The "+" menu still offers inline images (embedded
              as data URLs), and files can be attached from the task drawer once
              it's created. */}
          <RichDescription value={form.description} onChange={(html) => set('description', html)} />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {/* Already scoped to a project (opened from inside one) - no need to
              show/change Project or Team here. */}
          {!lockedProjectId && (
            <>
              <div style={field}>
                <label style={label}>Project {!isEdit && req}</label>
                {/* Was a bare <select> of every project in database order. With
                    ~30 of them that is the "unorganized and difficult" the end
                    user reported: the ones you work in are ordered first, the
                    rest follow alphabetically, and search covers the tail. */}
                <ProjectPicker
                  projects={projects} teams={teams} myEmail={myEmail}
                  value={form.projectId}
                  invalid={missing.includes('project')}
                  allowNone={isEdit} noneLabel="No project"
                  placeholder={isEdit ? 'No project' : 'Select a project…'}
                  onCreateNew={() => setCreatingProject(true)}
                  onChange={(pid) => {
                    // Pre-fill Team from the project when there's exactly one
                    // associated team - with several there's no right answer, so
                    // it stays blank and the picker below lists them.
                    const own = teams.filter((t) => teamInProject(t, pid));
                    setForm((f) => ({ ...f, projectId: pid, teamId: own.length === 1 ? own[0].id : '' }));
                  }} />
              </div>
              <div style={field}>
                <label style={label}>Team</label>
                <select value={form.teamId} onChange={(e) => set('teamId', e.target.value)} disabled={!form.projectId} style={{ ...sel, ...(!form.projectId ? { opacity: 0.6, cursor: 'not-allowed' } : {}) }}>
                  <option value="">{form.projectId ? 'No team' : 'Pick a project first'}</option>
                  {teams.filter((t) => teamInProject(t, form.projectId)).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>
            </>
          )}
          <div style={field}>
            <label style={label}>Assignee {!isEdit && req}</label>
            <div style={{ borderRadius: 8, ...missStyle('assignee'), ...(missing.includes('assignee') ? { border: `1px solid ${NX.red}` } : {}) }}>
              <PersonSelect value={form.assigneeId} onChange={(v) => set('assigneeId', v)} people={people} />
            </div>
          </div>
          <div style={field}>
            <label style={label}>Collaborators</label>
            <PersonMultiSelect value={form.followerIds} onChange={(v) => set('followerIds', v)} people={people} placeholder="Add collaborators…" />
          </div>
          <div style={field}>
            <label style={label}>Due Date {!isEdit && req}</label>
            <DateField value={form.dueOn} onChange={(v) => set('dueOn', v || '')} placeholder="Pick a date" style={{ ...input, ...missStyle('due') }} />
          </div>
          <div style={field}>
            <label style={label}>Recurrence</label>
            <select value={form.recurFreq} onChange={(e) => setRecurFreq(e.target.value)} style={sel}>
              <option value="none">Does not repeat</option>
              <option value="daily">Every day</option>
              <option value="weekly">Every week</option>
              <option value="monthly">Every month</option>
              <option value="yearly">Every year</option>
            </select>
          </div>
          {form.recurFreq === 'weekly' && (
            <div style={field}>
              <label style={label}>Day of Week</label>
              <select value={form.recurDow} onChange={(e) => set('recurDow', e.target.value)} style={sel}>
                {DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
              </select>
            </div>
          )}
          {form.recurFreq === 'monthly' && (
            <div style={field}>
              <label style={label}>Day of Month</label>
              <select value={form.recurDom} onChange={(e) => set('recurDom', e.target.value)} style={sel}>
                {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>Day {d}</option>)}
              </select>
            </div>
          )}
          {form.recurFreq !== 'none' && (
            <div style={field}>
              <label style={label}>Ends</label>
              <select value={form.recurEnd} onChange={(e) => set('recurEnd', e.target.value)} style={sel}>
                <option value="never">Never</option>
                <option value="on">On date</option>
                <option value="after">After occurrences</option>
              </select>
            </div>
          )}
          {form.recurFreq !== 'none' && form.recurEnd === 'on' && (
            <div style={field}>
              <label style={label}>End Date</label>
              <DateField value={form.recurUntil} onChange={(v) => set('recurUntil', v || '')} placeholder="Pick a date" style={input} />
            </div>
          )}
          {form.recurFreq !== 'none' && form.recurEnd === 'after' && (
            <div style={field}>
              <label style={label}>Occurrences</label>
              <input type="number" min="1" step="1" value={form.recurCount} onChange={(e) => set('recurCount', e.target.value)} placeholder="e.g. 10" style={input} />
            </div>
          )}
          <div style={field}>
            <label style={label}>Priority</label>
            <select value={form.priority} onChange={(e) => set('priority', e.target.value)} style={sel}>
              {PRIORITY_ORDER.map((p) => <option key={p} value={p}>{PRIORITY_META[p].label}</option>)}
            </select>
          </div>
          <div style={field}>
            <label style={label}>Status</label>
            <select value={form.recurFreq !== 'none' ? 'recurring' : form.status} onChange={(e) => set('status', e.target.value)} disabled={form.recurFreq !== 'none'} style={{ ...sel, ...(form.recurFreq !== 'none' ? { opacity: 0.7, cursor: 'not-allowed' } : {}) }}>
              {/* Follows the chosen project, same as activeFields above. */}
              {(store.statusOrderFor ? store.statusOrderFor(lockedProjectId || form.projectId) : store.statusOrder).map((s) => <option key={s} value={s}>{store.statusMeta[s]?.label || s}</option>)}
            </select>
            {form.recurFreq !== 'none' && <span style={{ fontSize: 11, color: NX.faint, marginTop: 3 }}>Recurring tasks are always “Recurring”.</span>}
          </div>
          <div style={field}>
            <label style={label}>Estimated Time</label>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="number" min="0" step="1" value={form.estimateHrs} onChange={(e) => set('estimateHrs', e.target.value)} placeholder="hrs" style={{ ...input, flex: 1, minWidth: 0 }} />
              <span style={{ fontWeight: 700, color: '#6b7280' }}>:</span>
              <input type="number" min="0" max="59" step="5" value={form.estimateMin} onChange={(e) => set('estimateMin', e.target.value)} placeholder="min" style={{ ...input, flex: 1, minWidth: 0 }} />
            </div>
          </div>
          <div style={field}>
            <label style={label}>Task Owner</label>
            <PersonSelect value={form.ownerId} onChange={(v) => set('ownerId', v)} people={people} placeholder="No owner" />
          </div>
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

        {activeFields.length > 0 && (
          <div style={field}>
            <label style={label}>Custom Fields</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {activeFields.map((f) => (
                <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ width: 120, flexShrink: 0, fontSize: 13, color: NX.dim }}>
                    {f.name} {!isEdit && f.required && req}
                  </span>
                  <CustomFieldInput field={f} value={form.customFieldValues[f.id]} onChange={(v) => set('customFieldValues', { ...form.customFieldValues, [f.id]: v })} />
                </div>
              ))}
            </div>
          </div>
        )}

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

        <div onPaste={onPasteFiles} tabIndex={0} style={{ ...field, outline: 'none' }}>
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
            <span style={{ fontSize: 11, color: NX.faint }}>or press Ctrl+V to paste a screenshot</span>
          </div>
        </div>
      </div>

      {/* Inline "create a project" - the new project is auto-selected for this task. */}
      {creatingProject && <ProjectCreateModal onClose={() => setCreatingProject(false)} onCreated={(p) => set('projectId', p.id)} />}
    </Modal>
  );
}

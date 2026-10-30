// Start as Task: the SOP's steps become a task checklist. 60vw popup.
import { useEffect, useState } from 'react';
import { Camera, CheckSquare } from 'lucide-react';
import { Modal, DateField } from '../../tasks/components';
import { api } from '../../api';
import { useRole } from '../../contexts/RoleContext';
import PeoplePick from './PeoplePick';
import { useToast, errText } from './Toast';
import { goView } from '../lib';

const REPEATS = [['', 'Once'], ['daily', 'Every Day'], ['weekly', 'Every Week'], ['monthly', 'Every Month']];

export default function StartTaskModal({ page, onClose }) {
  const { myEmail } = useRole();
  const toast = useToast();
  const [title, setTitle] = useState(page.title);
  const [assignee, setAssignee] = useState(myEmail || '');
  const [due, setDue] = useState('');
  const [priority, setPriority] = useState('medium');
  const [project, setProject] = useState('');
  const [note, setNote] = useState('');
  const [repeat, setRepeat] = useState('');
  const [projects, setProjects] = useState([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.getTaskProjects().then((rows) => setProjects(Array.isArray(rows) ? rows : (rows?.projects || []))).catch(() => {}); }, []);
  const steps = page.steps || [];
  const photoSteps = steps.filter((s) => s.photoRequired).length;

  const start = async () => {
    setBusy(true);
    try {
      const out = await api.kbStartTask(page.id, {
        title, assignee_email: assignee, due_on: due, priority, project_id: project, note,
        recurrence: repeat ? { freq: repeat, interval: 1 } : null,
      });
      toast(`Task ${out.code || ''} created with ${out.steps} steps`.replace('  ', ' '));
      window.dispatchEvent(new CustomEvent('nexus:data-written'));
      onClose();
      goView('tasks', 'mine');
      setTimeout(() => window.dispatchEvent(new CustomEvent('nexus:open-task', { detail: { taskId: out.task_id } })), 0);
    } catch (e) { toast(errText(e, 'Could not create the task'), 'err'); } finally { setBusy(false); }
  };

  return (
    <Modal title="Start as Task" onClose={onClose}
           footer={<div className="kb" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
             <span className="kb-meta" style={{ marginRight: 'auto' }}>{steps.length} steps become the checklist{photoSteps ? `, ${photoSteps} need a photo` : ''}</span>
             <button type="button" className="kb-btn" onClick={onClose}>Cancel</button>
             <button type="button" className="kb-btn pri" disabled={busy || !title.trim()} onClick={start}><CheckSquare />Create Task</button></div>}>
      <div className="kb" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 18 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="kb-field"><label>Task Name</label><input className="kb-input" value={title} onChange={(e) => setTitle(e.target.value)} /></div>
          <div className="kb-field"><label>Assign To</label><PeoplePick value={assignee} onChange={setAssignee} allowClear={false} /></div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div className="kb-field"><label>Due</label><DateField value={due} onChange={setDue} placeholder="No due date" noPast style={{ minHeight: 40, borderRadius: 10 }} /></div>
            <div className="kb-field"><label>Priority</label>
              <select className="kb-select" value={priority} onChange={(e) => setPriority(e.target.value)}>
                <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="urgent">Urgent</option>
              </select></div>
          </div>
          <div className="kb-field"><label>Project</label>
            <select className="kb-select" value={project} onChange={(e) => setProject(e.target.value)}>
              <option value="">No project</option>
              {projects.filter((p) => !p.archived).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select></div>
          <div className="kb-field"><label>Repeats</label>
            <div className="kb-seg">{REPEATS.map(([k, l]) => <button key={k} type="button" className={k === repeat ? 'on' : ''} onClick={() => setRepeat(k)}>{l}</button>)}</div>
            {repeat && <div className="kb-help">A repeating task is a template: each time it comes around the checklist starts fresh, and when this page gets a new version the steps follow.</div>}
          </div>
          <div className="kb-field"><label>Note</label><textarea className="kb-textarea" style={{ minHeight: 70 }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anything the assignee should know" /></div>
        </div>
        <div className="kb-card soft" style={{ padding: 14, alignSelf: 'start' }}>
          <div className="kb-label" style={{ marginBottom: 8 }}>Checklist Preview</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: '50vh', overflow: 'auto' }}>
            {steps.map((s, i) => (
              <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 13.5 }}>
                <span style={{ width: 18, height: 18, border: '1.5px solid var(--kb-line)', borderRadius: 5, flex: '0 0 auto', marginTop: 2 }} />
                <span className="kb-grow">{s.title}{s.photoRequired && <span className="kb-tag" style={{ marginLeft: 6 }}><Camera size={11} /> photo</span>}</span>
              </div>
            ))}
          </div>
          <div className="kb-help" style={{ marginTop: 10 }}>Linked to {page.code || 'this page'} v{page.version}. Photos, comments and completion work as in any task.</div>
        </div>
      </div>
    </Modal>
  );
}

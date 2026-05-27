import { useState } from 'react';
import { Folder, Clock, Triangle, MessageSquare, UserCheck, RefreshCw, Plus, Search, SlidersHorizontal, User, Calendar, CheckCircle, X } from 'lucide-react';

const INIT_TASKS = [
  { id: 'TASK-001', title: 'Update financial report Q2', assignee: 'Sarah Johnson', project: 'Financial Reporting', dueDate: '2026-05-23', hours: '4h est. / 2.5h actual', comment: 'Last: Working on final review (2 hours ago)', priority: 'High', status: 'In Progress', dept: 'Accounting', synced: true },
  { id: 'TASK-002', title: 'Review site concrete excavation', assignee: 'Michael Chen', project: 'Onsite Operations', dueDate: '2026-05-24', hours: '2h est. / 2.0h actual', comment: 'Last: Soil inspection complete (1 day ago)', priority: 'High', status: 'In Progress', dept: 'OPS', synced: true },
  { id: 'TASK-003', title: 'Draft subcontractor legal framing agreement', assignee: 'Emily Rodriguez', project: 'Legal & Contracts', dueDate: '2026-05-25', hours: '6h est. / 4.0h actual', comment: 'Last: Awaiting legal team review (3 hours ago)', priority: 'Medium', status: 'Needs Review', dept: 'Development', synced: true },
  { id: 'TASK-004', title: 'Regulatory permit filing Site-B', assignee: 'Emily Rodriguez', project: 'Regulatory Permitting', dueDate: '2026-05-22', hours: '3h est. / 3.0h actual', comment: '', priority: 'High', status: 'Overdue', dept: 'Development', synced: true },
  { id: 'TASK-005', title: 'Google Ads restructuring', assignee: 'Jessica Taylor', project: 'Marketing & Ads', dueDate: '2026-05-24', hours: '4h est. / 2.5h actual', comment: 'Last: Setup keyword match types (4 hours ago)', priority: 'Medium', status: 'In Progress', dept: 'Marketing', synced: true },
  { id: 'TASK-006', title: 'IT firewall server patching', assignee: 'David Kim', project: 'IT Security', dueDate: '2026-05-26', hours: '5h est. / 0h actual', comment: '', priority: 'Low', status: 'In Progress', dept: 'IT Support', synced: false },
  { id: 'TASK-007', title: 'Submit Q2 vendor invoice report', assignee: 'Sarah Johnson', project: 'Accounting Audit', dueDate: '2026-05-25', hours: '3h est. / 0h actual', comment: '', priority: 'Medium', status: 'To Do', dept: 'Accounting', synced: true },
  { id: 'TASK-008', title: 'Audit site concrete deliveries', assignee: 'Marcus Vance', project: 'Material Logs', dueDate: '2026-05-21', hours: '8h est. / 6h actual', comment: 'Last: Audit logs in progress (1 week ago)', priority: 'Low', status: 'To Do', dept: 'OPS', synced: true },
];

const priorityStyle = (p) => {
  if (p === 'High' || p === 'Urgent') return { backgroundColor: 'hsla(var(--color-red), 0.12)', color: 'hsl(var(--color-red))' };
  if (p === 'Medium') return { backgroundColor: 'hsla(var(--color-orange), 0.12)', color: 'hsl(var(--color-orange))' };
  return { backgroundColor: 'hsla(var(--color-blue), 0.08)', color: 'hsl(var(--color-blue))' };
};

export default function Tasks() {
  const [tasks, setTasks] = useState(INIT_TASKS);
  const [activeTab, setActiveTab] = useState('all');
  const [search, setSearch] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({ title: '', assignee: '', project: '', dueDate: '', est: '', act: '', priority: 'Medium', status: 'To Do', dept: 'OPS', comment: '' });

  const inProgress = tasks.filter(t => t.status === 'In Progress').length;
  const overdue = tasks.filter(t => t.status === 'Overdue').length;
  const noComments = tasks.filter(t => !t.comment).length;
  const needsReview = tasks.filter(t => t.status === 'Needs Review').length;

  let filtered = tasks;
  if (activeTab === 'needs-attention') filtered = filtered.filter(t => t.status === 'Overdue' || t.priority === 'High' || t.priority === 'Urgent');
  if (search) filtered = filtered.filter(t => [t.title, t.project, t.assignee, t.id].some(f => f.toLowerCase().includes(search.toLowerCase())));

  const complete = (id) => setTasks(prev => prev.map(t => t.id === id ? { ...t, status: 'Completed' } : t));
  const addComment = (id) => {
    const text = prompt('Enter a new comment for this task:');
    if (text) setTasks(prev => prev.map(t => t.id === id ? { ...t, comment: `Last: ${text} (Just now)` } : t));
  };

  const submitTask = (e) => {
    e.preventDefault();
    const newTask = {
      id: `TASK-0${tasks.length + 1}`,
      title: form.title, assignee: form.assignee, project: form.project,
      dueDate: form.dueDate,
      hours: `${form.est}h est. / ${form.act || 0}h actual`,
      comment: form.comment ? `Last: ${form.comment} (Just now)` : '',
      priority: form.priority, status: form.status, dept: form.dept, synced: true,
    };
    setTasks(prev => [newTask, ...prev]);
    setShowModal(false);
    setForm({ title: '', assignee: '', project: '', dueDate: '', est: '', act: '', priority: 'Medium', status: 'To Do', dept: 'OPS', comment: '' });
  };

  return (
    <div style={{ animation: 'fadeIn var(--transition-normal) ease-in-out' }}>
      <div className="view-header" style={{ marginBottom: 24 }}>
        <div className="view-title-group">
          <h2>Tasks</h2>
          <p>Asana-integrated task system with full project tracking</p>
        </div>
        <div style={{ display: 'flex', gap: 12 }}>
          <button className="secondary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }} onClick={() => alert('Synchronizing with Asana cloud...')}>
            <RefreshCw size={16} /> Sync with Asana
          </button>
          <button className="primary-btn" style={{ backgroundColor: '#000', color: '#fff', display: 'inline-flex', alignItems: 'center', gap: 8 }} onClick={() => setShowModal(true)}>
            <Plus size={16} /> New Task
          </button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="cards-grid" style={{ gridTemplateColumns: 'repeat(5, 1fr)', marginBottom: 24 }}>
        {[
          { label: 'Total Tasks', value: tasks.length, color: 'card-blue', Icon: Folder },
          { label: 'In Progress', value: inProgress, color: 'card-blue', Icon: Clock, accent: 'blue' },
          { label: 'Overdue', value: overdue, color: 'card-red', Icon: Triangle, accent: 'red' },
          { label: 'No Comments', value: noComments, color: 'card-orange', Icon: MessageSquare, accent: 'orange' },
          { label: 'Needs Review', value: needsReview, color: 'card-purple', Icon: UserCheck, accent: 'purple' },
        ].map(({ label, value, color, Icon, accent }) => (
          <div key={label} className={`kpi-card ${color}`} style={{ cursor: 'default' }}>
            <div className="kpi-card-header">
              <span className="kpi-title" style={accent ? { color: `hsl(var(--color-${accent}))` } : {}}>{label}</span>
              <div className="kpi-icon-container" style={accent ? { color: `hsl(var(--color-${accent}))` } : {}}><Icon size={18} /></div>
            </div>
            <div className="kpi-stat" style={{ fontSize: '2rem', ...(accent ? { color: `hsl(var(--color-${accent}))` } : {}) }}>{value}</div>
          </div>
        ))}
      </div>

      {/* Filter Pills */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
        {[{ id: 'all', label: 'All Tasks' }, { id: 'mobile', label: 'Mobile View' }, { id: 'needs-attention', label: 'Needs Attention' }].map(p => (
          <button key={p.id} onClick={() => setActiveTab(p.id)} style={{
            border: 'none', padding: '6px 14px', borderRadius: 20, fontWeight: 600, fontSize: '0.85rem', cursor: 'pointer',
            backgroundColor: activeTab === p.id ? 'var(--text-primary)' : 'var(--bg-card)',
            color: activeTab === p.id ? 'var(--bg-primary)' : 'var(--text-secondary)',
            border: '1px solid var(--border-color)',
          }}>{p.label}</button>
        ))}
      </div>

      {/* Search */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 24, alignItems: 'center' }}>
        <div style={{ position: 'relative', flex: 1, maxWidth: 400 }}>
          <Search size={16} style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
          <input type="text" className="form-input" style={{ paddingLeft: 40, width: '100%' }} placeholder="Search tasks..." value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <button className="secondary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }} onClick={() => alert('Task filter overlays toggled.')}>
          <SlidersHorizontal size={16} /> Filters
        </button>
      </div>

      {/* Task Cards */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {filtered.length === 0
          ? <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-secondary)', border: '1px dashed var(--border-color)', borderRadius: 12 }}>No matching tasks found.</div>
          : filtered.map(task => (
            <div key={task.id} style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, padding: '20px 24px', boxShadow: 'var(--shadow-sm)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 24 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem', fontFamily: 'monospace', fontWeight: 600 }}>{task.id}</span>
                  <span style={{ fontWeight: 700, fontSize: '1.05rem', color: 'var(--text-primary)' }}>{task.title}</span>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center', fontSize: '0.825rem', color: 'var(--text-secondary)' }}>
                  {[{ Icon: User, label: task.assignee }, { Icon: Folder, label: task.project }, { Icon: Calendar, label: new Date(task.dueDate).toLocaleDateString() }, { Icon: Clock, label: task.hours }].map(({ Icon, label }) => (
                    <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Icon size={14} color="var(--text-muted)" /><span>{label}</span></div>
                  ))}
                </div>
                {task.comment && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: 4 }}>
                    <MessageSquare size={14} color="hsl(var(--color-orange))" />
                    <span style={{ fontStyle: 'italic' }}>{task.comment}</span>
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexShrink: 0 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span className="status-badge" style={{ ...priorityStyle(task.priority), borderRadius: 20, padding: '4px 10px' }}>{task.priority}</span>
                  <span className="status-badge" style={{ backgroundColor: 'var(--border-color)', color: 'var(--text-secondary)', borderRadius: 20, padding: '4px 10px' }}>{task.status}</span>
                  <span className="status-badge" style={{ backgroundColor: 'hsla(215, 100%, 50%, 0.1)', color: 'hsl(215, 100%, 45%)', borderRadius: 20, padding: '4px 10px' }}>{task.dept}</span>
                  {task.synced
                    ? <span className="status-badge" style={{ backgroundColor: '#111827', color: '#fff', borderRadius: 20, padding: '4px 10px' }}>✓ Synced</span>
                    : <span className="status-badge" style={{ borderRadius: 20, padding: '4px 10px' }}>Local</span>
                  }
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="secondary-btn" style={{ padding: 6, borderRadius: 8, width: 34, height: 34, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }} title="Add comment" onClick={() => addComment(task.id)}>
                    <MessageSquare size={16} />
                  </button>
                  {task.status !== 'Completed' && (
                    <button className="secondary-btn" style={{ padding: 6, borderRadius: 8, width: 34, height: 34, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }} title="Mark completed" onClick={() => complete(task.id)}>
                      <CheckCircle size={16} />
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))
        }
      </div>

      {/* New Task Modal */}
      {showModal && (
        <div className="modal-overlay" style={{ display: 'flex' }}>
          <div className="modal-content">
            <div className="modal-header">
              <h3>Create New Task</h3>
              <button className="close-btn" onClick={() => setShowModal(false)}><X size={18} /></button>
            </div>
            <form onSubmit={submitTask}>
              <div className="form-grid">
                <div className="form-group form-group-full">
                  <label htmlFor="t-title">Task Name</label>
                  <input id="t-title" type="text" className="form-input" placeholder="e.g. Update financial report Q2" required value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label>Assignee Name</label>
                  <input type="text" className="form-input" placeholder="Sarah Johnson" required value={form.assignee} onChange={e => setForm(f => ({ ...f, assignee: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label>Project / Category</label>
                  <input type="text" className="form-input" placeholder="Financial Reporting" required value={form.project} onChange={e => setForm(f => ({ ...f, project: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label>Est. Hours</label>
                  <input type="number" className="form-input" min="1" placeholder="4" required value={form.est} onChange={e => setForm(f => ({ ...f, est: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label>Actual Hours</label>
                  <input type="number" className="form-input" min="0" step="0.1" placeholder="2.5" value={form.act} onChange={e => setForm(f => ({ ...f, act: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label>Priority</label>
                  <select className="form-select" value={form.priority} onChange={e => setForm(f => ({ ...f, priority: e.target.value }))}>
                    {['Low', 'Medium', 'High', 'Urgent'].map(p => <option key={p}>{p}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label>Status</label>
                  <select className="form-select" value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>
                    {['To Do', 'In Progress', 'Needs Review', 'Overdue'].map(s => <option key={s}>{s}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label>Department</label>
                  <select className="form-select" value={form.dept} onChange={e => setForm(f => ({ ...f, dept: e.target.value }))}>
                    {['Accounting', 'OPS', 'IT Support', 'Development', 'Marketing', 'Admin'].map(d => <option key={d}>{d}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label>Due Date</label>
                  <input type="date" className="form-input" required value={form.dueDate} onChange={e => setForm(f => ({ ...f, dueDate: e.target.value }))} />
                </div>
                <div className="form-group form-group-full">
                  <label>Latest Comment (Optional)</label>
                  <input type="text" className="form-input" placeholder="Working on final review..." value={form.comment} onChange={e => setForm(f => ({ ...f, comment: e.target.value }))} />
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="secondary-btn" onClick={() => setShowModal(false)}>Cancel</button>
                <button type="submit" className="primary-btn">Save Task</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

import { useState } from 'react';
import { Folder, AlertCircle, MessageSquare, Clock, Users, SlidersHorizontal, Download } from 'lucide-react';

const EMPLOYEES = [
  { name: 'Sarah Johnson', dept: 'Accounting', tasks: 8, est: 32, act: 18, completed: 3, inprogress: 4, overdue: 1, workload: 85 },
  { name: 'Michael Chen', dept: 'OPS', tasks: 12, est: 48, act: 24, completed: 5, inprogress: 6, overdue: 1, workload: 95 },
  { name: 'Emily Rodriguez', dept: 'Development', tasks: 6, est: 24, act: 12, completed: 2, inprogress: 3, overdue: 1, workload: 70 },
  { name: 'David Kim', dept: 'IT Support', tasks: 5, est: 20, act: 10, completed: 1, inprogress: 3, overdue: 1, workload: 60 },
  { name: 'Jessica Taylor', dept: 'Marketing', tasks: 9, est: 36, act: 20, completed: 4, inprogress: 4, overdue: 1, workload: 75 },
  { name: 'Marcus Vance', dept: 'OPS', tasks: 5, est: 20, act: 16, completed: 2, inprogress: 3, overdue: 0, workload: 50 },
];

export default function ManagerDashboard() {
  const [activeTab, setActiveTab] = useState('workload');

  const totalTasks = EMPLOYEES.reduce((s, e) => s + e.tasks, 0);
  const totalOverdue = EMPLOYEES.reduce((s, e) => s + e.overdue, 0);
  const totalEst = EMPLOYEES.reduce((s, e) => s + e.est, 0);

  const workloadColor = (w) => w >= 90 ? 'hsl(var(--color-red))' : w >= 75 ? 'hsl(var(--color-orange))' : 'hsl(var(--color-blue))';

  const tabs = [
    { id: 'workload', label: 'Workload by Employee' },
    { id: 'projects', label: 'Project-wise Tasks' },
    { id: 'actions', label: 'Pending Actions' },
    { id: 'calendar', label: 'Team Calendar' },
  ];

  return (
    <div style={{ animation: 'fadeIn var(--transition-normal) ease-in-out' }}>
      <div className="view-header">
        <div className="view-title-group">
          <h2>Manager Dashboard</h2>
          <p>Team workload, task analytics, and performance overview</p>
        </div>
        <div style={{ display: 'flex', gap: 12 }}>
          <button className="secondary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <SlidersHorizontal size={16} /> Filters
          </button>
          <button className="secondary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <Download size={16} /> Export Report
          </button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="cards-grid" style={{ gridTemplateColumns: 'repeat(5, 1fr)', marginBottom: 24 }}>
        {[
          { label: 'Total Tasks', value: totalTasks, helper: 'Across all employees', color: 'card-blue', Icon: Folder },
          { label: 'Overdue Tasks', value: totalOverdue, helper: 'Requires attention', color: 'card-red', Icon: AlertCircle },
          { label: 'Pending Action', value: 3, helper: 'No comment/action', color: 'card-orange', Icon: MessageSquare },
          { label: 'Estimated Hours', value: `${totalEst}h`, helper: 'This week', color: 'card-blue', Icon: Clock },
          { label: 'Team Members', value: EMPLOYEES.length, helper: 'Active employees', color: 'card-green', Icon: Users },
        ].map(({ label, value, helper, color, Icon }) => (
          <div key={label} className={`kpi-card ${color}`} style={{ cursor: 'default' }}>
            <div className="kpi-card-header">
              <span className="kpi-title">{label}</span>
              <div className="kpi-icon-container"><Icon size={18} /></div>
            </div>
            <div className="kpi-stat" style={{ fontSize: '2rem' }}>{value}</div>
            <div className="kpi-helper">{helper}</div>
          </div>
        ))}
      </div>

      {/* Tab Navigation */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 20 }}>
        {tabs.map(t => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            style={{
              border: 'none', padding: '7px 16px', borderRadius: 20, fontWeight: 600, fontSize: '13px',
              fontFamily: 'Inter, sans-serif', cursor: 'pointer', transition: 'all 0.13s',
              background: activeTab === t.id ? 'var(--ink)' : 'rgba(0,0,0,0.05)',
              color: activeTab === t.id ? 'var(--sidebar-active-text)' : 'var(--muted)',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className="requisitions-list-card">
        {activeTab === 'workload' && (
          <>
            <div style={{ marginBottom: 20 }}>
              <h3 style={{ fontSize: '15px', fontWeight: 700, letterSpacing: '-.02em' }}>Employee Workload Analysis</h3>
              <p style={{ color: 'var(--muted)', fontSize: '13px', marginTop: 3 }}>Task distribution and estimated time per employee</p>
            </div>
            <div className="req-table-wrapper">
              <table className="req-table">
                <thead>
                  <tr>
                    <th>Employee</th><th>Department</th><th>Total Tasks</th><th>Est. Hours</th>
                    <th>Actual Hours</th><th>Completed</th><th>In Progress</th><th>Overdue</th><th>Workload</th>
                  </tr>
                </thead>
                <tbody>
                  {EMPLOYEES.map(e => (
                    <tr key={e.name}>
                      <td style={{ fontWeight: 600 }}>{e.name}</td>
                      <td>{e.dept}</td>
                      <td style={{ fontWeight: 500 }}>{e.tasks}</td>
                      <td>{e.est}h</td>
                      <td>{e.act}h</td>
                      <td>
                        <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, borderRadius: '50%', backgroundColor: 'var(--text-primary)', color: 'var(--bg-primary)', fontWeight: 700, fontSize: '0.75rem' }}>
                          {e.completed}
                        </span>
                      </td>
                      <td style={{ paddingLeft: 18, fontWeight: 600, color: 'var(--text-secondary)' }}>{e.inprogress}</td>
                      <td>
                        {e.overdue > 0
                          ? <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, borderRadius: '50%', backgroundColor: 'hsl(var(--color-red))', color: 'white', fontWeight: 700, fontSize: '0.75rem' }}>{e.overdue}</span>
                          : <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>0</span>
                        }
                      </td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, width: 140 }}>
                          <div style={{ flex: 1, height: 6, backgroundColor: 'var(--border-color)', borderRadius: 3, overflow: 'hidden' }}>
                            <div style={{ width: `${e.workload}%`, height: '100%', backgroundColor: workloadColor(e.workload), borderRadius: 3 }} />
                          </div>
                          <span style={{ fontSize: '0.8rem', fontWeight: 600, minWidth: 28 }}>{e.workload}%</span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {activeTab === 'projects' && (
          <>
            <h3>Project-wise Tasks Analysis</h3>
            <p style={{ color: 'var(--text-secondary)', marginBottom: 20 }}>Distribution of current construction project tasks across active job sites.</p>
            <div className="req-table-wrapper">
              <table className="req-table">
                <thead><tr><th>Project Name</th><th>Department</th><th>Assigned Tasks</th><th>Progress</th><th>Priority Breakdown</th></tr></thead>
                <tbody>
                  {[
                    { name: 'Oakridge Estate Subdivisions', dept: 'Development', tasks: 14, progress: 75, badges: [{ label: '4 Urgent', color: 'red' }, { label: '6 Medium', color: 'orange' }] },
                    { name: 'Downtown Commercial Complex', dept: 'OPS', tasks: 22, progress: 50, badges: [{ label: '8 Urgent', color: 'red' }, { label: '10 Low', color: 'blue' }] },
                    { name: 'Corporate Office Renovation', dept: 'IT / Admin', tasks: 9, progress: 90, badges: [{ label: '9 Completed', color: 'green' }] },
                  ].map(p => (
                    <tr key={p.name}>
                      <td style={{ fontWeight: 600 }}>{p.name}</td>
                      <td>{p.dept}</td>
                      <td>{p.tasks} Tasks</td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <div style={{ flex: 1, height: 6, backgroundColor: 'var(--border-color)', borderRadius: 3, overflow: 'hidden' }}>
                            <div style={{ width: `${p.progress}%`, height: '100%', backgroundColor: p.progress >= 90 ? 'hsl(var(--color-green))' : p.progress >= 60 ? 'hsl(var(--color-blue))' : 'hsl(var(--color-orange))', borderRadius: 3 }} />
                          </div>
                          <span style={{ fontSize: '0.8rem', fontWeight: 600 }}>{p.progress}%</span>
                        </div>
                      </td>
                      <td>{p.badges.map(b => <span key={b.label} className="status-badge" style={{ backgroundColor: `hsla(var(--color-${b.color}), 0.1)`, color: `hsl(var(--color-${b.color}))`, marginRight: 4 }}>{b.label}</span>)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {activeTab === 'actions' && (
          <>
            <h3>Pending Action Alerts</h3>
            <p style={{ color: 'var(--text-secondary)', marginBottom: 20 }}>Manager alerts requiring approval or commentary.</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {[
                { color: 'red', title: 'Overdue Task Alert', body: 'Sarah Johnson has not updated "Q2 Invoice Audit" (due 2 days ago).', btn: 'Send Reminder' },
                { color: 'orange', title: 'Material Approval Needed', body: 'Apex Concrete Requisition #8492 ($14,400) requires leadership sign-off.', btn: 'Review Req' },
                { color: 'blue', title: 'Shift Discrepancy', body: 'Michael Chen logged 12 hours overtime on Site-B excavation without approval.', btn: 'Acknowledge' },
              ].map(a => (
                <div key={a.title} style={{ border: '1px solid var(--border-color)', borderRadius: 8, padding: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center', backgroundColor: 'var(--bg-primary)' }}>
                  <div>
                    <strong style={{ color: `hsl(var(--color-${a.color}))` }}>{a.title}</strong>
                    <div style={{ fontSize: '0.9rem', marginTop: 4 }}>{a.body}</div>
                  </div>
                  <button className="primary-btn" style={{ padding: '6px 12px', fontSize: '0.8rem', backgroundColor: `hsl(var(--color-${a.color}))` }}>{a.btn}</button>
                </div>
              ))}
            </div>
          </>
        )}

        {activeTab === 'calendar' && (
          <>
            <h3>Team Schedule Calendar</h3>
            <p style={{ color: 'var(--text-secondary)', marginBottom: 20 }}>Onsite shift and safety briefing rosters for the current week.</p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12, textAlign: 'center' }}>
              {[
                { day: 'Mon', date: 'May 26', label: 'Safety briefing', color: 'blue' },
                { day: 'Tue', date: 'May 27', label: 'Foundation pouring', color: 'purple' },
                { day: 'Wed', date: 'May 28', label: 'Slab inspection', color: 'green' },
                { day: 'Thu', date: 'May 29', label: 'Site audit', color: 'orange' },
                { day: 'Fri', date: 'May 30', label: 'Roster finalization', color: 'red' },
              ].map(d => (
                <div key={d.day} style={{ border: '1px solid var(--border-color)', padding: 12, borderRadius: 8 }}>
                  <strong>{d.day}</strong>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: 4 }}>{d.date}</div>
                  <div style={{ backgroundColor: `hsla(var(--color-${d.color}), 0.1)`, color: `hsl(var(--color-${d.color}))`, padding: 4, borderRadius: 4, fontSize: '0.75rem', marginTop: 8 }}>{d.label}</div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

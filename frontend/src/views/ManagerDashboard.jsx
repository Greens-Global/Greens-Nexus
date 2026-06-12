import { useState, useEffect } from 'react';
import { useMsal } from '@azure/msal-react';
import { Folder, AlertCircle, MessageSquare, Clock, Users, SlidersHorizontal, Download, CheckCircle, XCircle, ChevronDown, Package, Eye, Mail, Filter, Loader2 } from 'lucide-react';
import { useRequisitions }  from '../contexts/RequisitionContext';
import { useInventory }     from '../contexts/InventoryContext';
import { useNotifications } from '../contexts/NotificationContext';
import { useRole }          from '../contexts/RoleContext';
import { api }              from '../api';

const EMPLOYEES = [
  { name: 'Sarah Johnson',    dept: 'Accounting',  tasks: 8,  est: 32, act: 18, completed: 3, inprogress: 4, overdue: 1, workload: 85 },
  { name: 'Michael Chen',     dept: 'OPS',         tasks: 12, est: 48, act: 24, completed: 5, inprogress: 6, overdue: 1, workload: 95 },
  { name: 'Emily Rodriguez',  dept: 'Development', tasks: 6,  est: 24, act: 12, completed: 2, inprogress: 3, overdue: 1, workload: 70 },
  { name: 'David Kim',        dept: 'IT Support',  tasks: 5,  est: 20, act: 10, completed: 1, inprogress: 3, overdue: 1, workload: 60 },
  { name: 'Jessica Taylor',   dept: 'Marketing',   tasks: 9,  est: 36, act: 20, completed: 4, inprogress: 4, overdue: 1, workload: 75 },
  { name: 'Marcus Vance',     dept: 'OPS',         tasks: 5,  est: 20, act: 16, completed: 2, inprogress: 3, overdue: 0, workload: 50 },
];

const MANAGER_NAME = 'Visesh Lodha';

export default function ManagerDashboard() {
  // ── All hooks must be at the top ──────────────────────────────────────────
  const { can }            = useRole();
  const { accounts }       = useMsal();
  const myEmail            = (accounts[0]?.username ?? '').toLowerCase();
  const myName             = accounts[0]?.name ?? MANAGER_NAME;
  const { requisitions, hwAssets, pendingManagerCount, approveRequisition, rejectRequisition } = useRequisitions();
  const { requests: invRequests, approveRequest: approveInvReq, rejectRequest: rejectInvReq, allocateItem } = useInventory();
  const { sendOverdueAlert, addNotification } = useNotifications();

  const [activeTab,       setActiveTab]       = useState('workload');
  const [rejectingId,     setRejectingId]     = useState(null);
  const [rejectReason,    setRejectReason]    = useState('');
  const [expandedReq,     setExpandedReq]     = useState(null);
  const [rejectingInvId,  setRejectingInvId]  = useState(null);
  const [rejectInvReason, setRejectInvReason] = useState('');
  const [approvingInvId,  setApprovingInvId]  = useState(null);
  const [pickedAllocator, setPickedAllocator] = useState('');
  const [approvingBusy,   setApprovingBusy]   = useState(false);
  const [allocators,      setAllocators]      = useState([]);
  const [whoHasWhatDept,  setWhoHasWhatDept]  = useState('All');
  const [alertSent,       setAlertSent]       = useState({});
  const [allocating,      setAllocating]      = useState({});
  const [allocErrors,     setAllocErrors]     = useState({});

  // Who the manager can hand an approved request off to — fetched once for the dropdown.
  useEffect(() => {
    if (!can('manager')) return;
    api.getInventoryAllocators().then(setAllocators).catch(() => {});
  }, [can]);

  function handleApproveInv(req) {
    const chosen = allocators.find(a => a.email === pickedAllocator);
    if (!chosen) return;
    setApprovingBusy(true);
    approveInvReq(req.id, MANAGER_NAME, chosen.email, chosen.name)
      .then(() => {
        addNotification({
          type:        'allocate_request',
          recipient:   chosen.email,
          refId:       req.id,
          itemName:    req.itemName,
          requestedBy: req.requestedBy,
          title:       'Allocate an Item',
          body:        `${MANAGER_NAME} approved ${req.requestedBy}'s request for ${req.itemName} and assigned it to you to hand over.`,
          action:      { label: 'Allocate Now →', kind: 'allocate' },
        });
        setApprovingInvId(null);
        setPickedAllocator('');
      })
      .catch(() => {})
      .finally(() => setApprovingBusy(false));
  }

  function handleAllocate(row) {
    setAllocating(p => ({ ...p, [row.key]: true }));
    setAllocErrors(p => ({ ...p, [row.key]: null }));
    allocateItem(row.reqId, myName).then(() => {
      addNotification({
        type:      'allocated',
        recipient: row.employeeEmail || row.employee,
        title:     'Item Allocated ✓',
        body:      `Your ${row.item} has been allocated and is ready for collection. Please pick it up from your supervisor.`,
        action:    { label: 'Track Request →', view: 'inventory', sub: 'my-requests' },
      });
    }).catch(err => {
      // Most common failure: atomic stock-reservation rejected the allocation
      // because available_qty ran out between approval and pickup — surface
      // that explicitly so the manager isn't left guessing why nothing happened.
      const msg = /409|stock/i.test(err?.message || '')
        ? `Not enough ${row.item} in stock to allocate right now.`
        : `Couldn't allocate ${row.item} — please try again.`;
      setAllocErrors(p => ({ ...p, [row.key]: msg }));
    }).finally(() => {
      setAllocating(p => ({ ...p, [row.key]: false }));
    });
  }

  // ── Access gate (after hooks) ─────────────────────────────────────────────
  if (!can('supervisor')) {
    return (
      <div className="view-header">
        <div className="view-title-group">
          <h2>Manager Dashboard</h2>
          <p>You need Supervisor access or above to view this section.</p>
        </div>
      </div>
    );
  }

  const totalTasks  = EMPLOYEES.reduce((s, e) => s + e.tasks, 0);
  const totalOverdue = EMPLOYEES.reduce((s, e) => s + e.overdue, 0);
  const totalEst    = EMPLOYEES.reduce((s, e) => s + e.est, 0);

  const workloadColor = (w) => w >= 90 ? 'hsl(var(--color-red))' : w >= 75 ? 'hsl(var(--color-orange))' : 'hsl(var(--color-blue))';

  const pendingReqs    = requisitions.filter(r => r.status === 'pending_manager');
  const pendingInvReqs = invRequests.filter(r => r.status === 'pending');

  const handleApprove = (id) => {
    approveRequisition(id, MANAGER_NAME);
  };

  const handleReject = (id) => {
    if (!rejectReason.trim()) return;
    rejectRequisition(id, MANAGER_NAME, rejectReason.trim());
    setRejectingId(null);
    setRejectReason('');
  };

  const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

  // ── Who Has What data ───────────────────────────────────────────────────────
  const now = Date.now();
  const todayStr = new Date().toISOString().split('T')[0];

  // Pending allocation: approved but not yet given to employee. Managers see
  // everything here (oversight + override); supervisors only see what's been
  // assigned to them specifically — matches the backend's allocation gate.
  const pendingAlloc = invRequests
    .filter(r => r.status === 'approved' &&
      (can('manager') || (r.assignedAllocatorEmail || '').toLowerCase() === myEmail))
    .map(r => ({
      key: r.id, employee: r.requestedBy, employeeEmail: r.requestedByEmail ?? '',
      raisedBy: r.raisedBy,
      item: r.itemName, dept: r.department, reqId: r.id,
      approvedAt: r.resolvedAt, approvedBy: r.resolvedBy,
      assignedTo: r.assignedAllocatorName || '',
      assignedToEmail: (r.assignedAllocatorEmail || '').toLowerCase(),
    }));

  // Temporary: allocated (physically given) and not yet returned
  const tempItems = invRequests
    .filter(r => r.status === 'allocated')
    .map(r => {
      const startDate = r.allocatedAt ?? r.createdAt;
      const dueDate   = new Date(new Date(startDate).getTime() + (r.days || 1) * 86400000);
      const isOverdue = dueDate < new Date();
      return {
        key:       r.id,
        employee:  r.requestedBy,
        raisedBy:  r.raisedBy,
        item:      r.itemName,
        dept:      r.department,
        type:      'Temporary',
        since:     r.allocatedAt ?? r.createdAt,
        dueDate:   dueDate.toISOString().split('T')[0],
        isOverdue,
        reqId:     r.id,
      };
    });

  // Permanent: hwAssets checked out (with or without a requisition)
  const permItems = hwAssets
    .filter(a => a.status === 'Checked Out' && a.assignedTo && a.assignedTo !== 'Unassigned')
    .map(a => {
      const linkedReq  = requisitions.find(r => r.assetId === a.id && r.status === 'asset_allocated');
      const isOverdue  = linkedReq?.expectedReturnDate && linkedReq.expectedReturnDate < todayStr;
      return {
        key:       a.id,
        employee:  a.assignedTo,
        item:      a.name,
        dept:      a.dept,
        type:      'Permanent',
        since:     a.lastUpdated,
        dueDate:   linkedReq?.expectedReturnDate ?? '—',
        isOverdue: !!isOverdue,
        reqId:     a.id,
      };
    });

  const allCheckedOut = [...tempItems, ...permItems];
  const WHWDEPTS = ['All', 'IT', 'Construction', 'Operations', 'Accounting'];
  const filteredWHW = whoHasWhatDept === 'All'
    ? allCheckedOut
    : allCheckedOut.filter(i => i.dept === whoHasWhatDept || i.dept?.toLowerCase().includes(whoHasWhatDept.toLowerCase()));

  function handleSendOverdueAlert(row) {
    sendOverdueAlert(row.reqId, row.employee, row.item);
    setAlertSent(p => ({ ...p, [row.key]: true }));
  }

  const totalPending = pendingManagerCount + pendingInvReqs.length;
  const overdueCount = allCheckedOut.filter(i => i.isOverdue).length;
  const isManager    = can('manager');

  const tabs = [
    ...(isManager ? [
      { id: 'workload',     label: 'Workload by Employee' },
      { id: 'projects',     label: 'Project-wise Tasks' },
      { id: 'actions',      label: `Pending Actions${totalPending > 0 ? ` (${totalPending})` : ''}` },
    ] : []),
    { id: 'who-has-what', label: `Who Has What${overdueCount > 0 ? ` ⚠ ${overdueCount}` : ''}` },
    ...(isManager ? [{ id: 'calendar', label: 'Team Calendar' }] : []),
  ];

  // Default to who-has-what for supervisors who can't see workload
  const effectiveTab = activeTab === 'workload' && !isManager ? 'who-has-what' : activeTab;

  // Phone bottom bar: this dashboard's tabs become the bar's actions
  // (contextual-bar pattern; the in-page pills hide ≤640 via .md-tabs)
  useEffect(() => {
    if (!window.matchMedia('(max-width: 900px)').matches) return;
    const SHORT = { workload: 'Workload', projects: 'Projects', actions: `Actions${totalPending > 0 ? ` (${totalPending})` : ''}`, 'who-has-what': 'Who Has', calendar: 'Calendar' };
    window.dispatchEvent(new CustomEvent('nexus:mobile-actions', {
      detail: { actions: tabs.map(t => ({ id: t.id, label: SHORT[t.id] || t.label, active: t.id === effectiveTab })) },
    }));
    const h = e => e.detail?.id && setActiveTab(e.detail.id);
    window.addEventListener('nexus:mobile-action', h);
    return () => {
      window.removeEventListener('nexus:mobile-action', h);
      window.dispatchEvent(new CustomEvent('nexus:mobile-actions', { detail: { actions: null } }));
    };
  }, [effectiveTab, isManager, totalPending, overdueCount]); // eslint-disable-line react-hooks/exhaustive-deps

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
          { label: 'Total Tasks',     value: totalTasks,              helper: 'Across all employees', color: 'card-blue',   Icon: Folder,        tab: 'workload' },
          { label: 'Overdue Tasks',   value: totalOverdue,            helper: 'Requires attention',   color: 'card-red',    Icon: AlertCircle,   tab: 'actions'  },
          { label: 'Pending Action',  value: 3 + pendingManagerCount, helper: 'No comment/action',    color: 'card-orange', Icon: MessageSquare, tab: 'actions'  },
          { label: 'Estimated Hours', value: `${totalEst}h`,          helper: 'This week',            color: 'card-blue',   Icon: Clock,         tab: 'workload' },
          { label: 'Team Members',    value: EMPLOYEES.length,        helper: 'Active employees',     color: 'card-green',  Icon: Users,         tab: 'workload' },
        ].map(({ label, value, helper, color, Icon, tab }) => (
          <div key={label} className={`kpi-card ${color}`} style={{ cursor: 'pointer' }} onClick={() => setActiveTab(tab)}>
            <div className="kpi-card-header">
              <span className="kpi-title">{label}</span>
              <div className="kpi-icon-container"><Icon size={18} /></div>
            </div>
            <div className="kpi-stat" style={{ fontSize: '2rem' }}>{value}</div>
            <div className="kpi-helper">{helper}</div>
          </div>
        ))}
      </div>

      {/* Tab Navigation — desktop; phones use the bottom action bar */}
      <div className="md-tabs" style={{ display: 'flex', gap: 6, marginBottom: 20 }}>
        {tabs.map(t => (
          <button key={t.id} className={`tab-pill${activeTab === t.id ? ' active' : ''}`} onClick={() => setActiveTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className="requisitions-list-card">

        {/* ── Workload ── */}
        {effectiveTab === 'workload' && (
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

        {/* ── Projects ── */}
        {effectiveTab === 'projects' && (
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

        {/* ── Pending Actions ── */}
        {effectiveTab === 'actions' && (
          <>
            {/* Purchase Requisitions awaiting approval */}
            <div style={{ marginBottom: 28 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
                <div>
                  <h3 style={{ fontSize: '15px', fontWeight: 700, letterSpacing: '-.02em', marginBottom: 2 }}>Purchase Requisitions</h3>
                  <p style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>Review and approve or reject employee asset requests.</p>
                </div>
                {pendingManagerCount > 0 && (
                  <span className="status-badge status-pending" style={{ fontSize: '0.8rem' }}>{pendingManagerCount} pending</span>
                )}
              </div>

              {pendingReqs.length === 0 ? (
                <div style={{ border: '1px dashed var(--border-color)', borderRadius: 8, padding: '28px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.9rem' }}>
                  No purchase requisitions awaiting approval.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {pendingReqs.map(req => (
                    <div key={req.id} style={{ border: '1px solid var(--border-color)', borderRadius: 8, overflow: 'hidden', backgroundColor: 'var(--bg-primary)' }}>
                      {/* Main row */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '14px 16px' }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                            <span style={{ fontFamily: 'monospace', fontSize: '0.78rem', color: 'var(--text-muted)', background: 'var(--border-color)', padding: '2px 7px', borderRadius: 4 }}>{req.id}</span>
                            <strong style={{ fontSize: '0.92rem' }}>{req.item}</strong>
                            <span style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>× {req.quantity}</span>
                          </div>
                          <div style={{ marginTop: 5, fontSize: '0.84rem', color: 'var(--text-secondary)', display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                            <span><strong>By:</strong> {req.employeeName}</span>
                            <span><strong>Dept:</strong> {req.employeeDept}</span>
                            <span><strong>Supervisor:</strong> {req.supervisorName}</span>
                            <span><strong>Submitted:</strong> {fmtDate(req.createdAt)}</span>
                          </div>
                        </div>

                        {/* Expand reason */}
                        <button
                          onClick={() => setExpandedReq(expandedReq === req.id ? null : req.id)}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 4, borderRadius: 4, display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.78rem' }}>
                          Reason <ChevronDown size={13} style={{ transform: expandedReq === req.id ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }} />
                        </button>

                        {/* Action buttons (hidden while in reject input mode) */}
                        {rejectingId !== req.id && (
                          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                            <button
                              className="primary-btn"
                              style={{ padding: '5px 14px', fontSize: '0.82rem', background: 'hsl(var(--color-green))' }}
                              onClick={() => handleApprove(req.id)}>
                              <CheckCircle size={13} /> Approve
                            </button>
                            <button
                              className="secondary-btn"
                              style={{ padding: '5px 14px', fontSize: '0.82rem', color: 'hsl(var(--color-red))', borderColor: 'hsl(var(--color-red))' }}
                              onClick={() => { setRejectingId(req.id); setRejectReason(''); }}>
                              <XCircle size={13} /> Reject
                            </button>
                          </div>
                        )}
                      </div>

                      {/* Reason expansion */}
                      {expandedReq === req.id && (
                        <div style={{ borderTop: '1px solid var(--border-color)', padding: '10px 16px', background: 'var(--bg-card)', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                          <strong>Reason:</strong> {req.reason || '—'}
                        </div>
                      )}

                      {/* Rejection reason input */}
                      {rejectingId === req.id && (
                        <div style={{ borderTop: '1px solid var(--border-color)', padding: '12px 16px', background: 'hsla(0,80%,50%,0.04)' }}>
                          <p style={{ fontSize: '0.82rem', marginBottom: 8, color: 'hsl(var(--color-red))', fontWeight: 600 }}>Enter rejection reason:</p>
                          <textarea
                            className="form-input" rows={2}
                            style={{ width: '100%', resize: 'vertical', fontSize: '0.85rem' }}
                            placeholder="Explain why this request is being rejected..."
                            value={rejectReason}
                            onChange={e => setRejectReason(e.target.value)}
                            autoFocus
                          />
                          <div style={{ display: 'flex', gap: 8, marginTop: 10, justifyContent: 'flex-end' }}>
                            <button
                              className="secondary-btn"
                              style={{ padding: '5px 12px', fontSize: '0.82rem' }}
                              onClick={() => { setRejectingId(null); setRejectReason(''); }}>
                              Cancel
                            </button>
                            <button
                              className="primary-btn"
                              style={{ padding: '5px 14px', fontSize: '0.82rem', background: 'hsl(var(--color-red))' }}
                              onClick={() => handleReject(req.id)}
                              disabled={!rejectReason.trim()}>
                              Confirm Reject
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Divider */}
            <div style={{ borderTop: '1px solid var(--border-color)', marginBottom: 20 }} />

            {/* Inventory Requests */}
            <div style={{ marginBottom: 28 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
                <div>
                  <h3 style={{ fontSize: '15px', fontWeight: 700, letterSpacing: '-.02em', marginBottom: 2 }}>Inventory Requests</h3>
                  <p style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>Review and approve or reject employee inventory requests.</p>
                </div>
                {pendingInvReqs.length > 0 && (
                  <span className="status-badge status-pending" style={{ fontSize: '0.8rem' }}>{pendingInvReqs.length} pending</span>
                )}
              </div>

              {pendingInvReqs.length === 0 ? (
                <div style={{ border: '1px dashed var(--border-color)', borderRadius: 8, padding: '28px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.9rem' }}>
                  No inventory requests awaiting approval.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {pendingInvReqs.map(req => (
                    <div key={req.id} style={{ border: '1px solid var(--border-color)', borderRadius: 8, overflow: 'hidden', backgroundColor: 'var(--bg-primary)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '14px 16px' }}>
                        <div style={{ width: 34, height: 34, borderRadius: 8, background: 'hsla(var(--color-blue),0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                          <Package size={16} color="hsl(var(--color-blue))" />
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                            <span style={{ fontFamily: 'monospace', fontSize: '0.78rem', color: 'var(--text-muted)', background: 'var(--border-color)', padding: '2px 7px', borderRadius: 4 }}>{req.id}</span>
                            <strong style={{ fontSize: '0.92rem' }}>{req.itemName}</strong>
                            <span style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>× {req.quantity} &nbsp;·&nbsp; {req.days}d</span>
                          </div>
                          <div style={{ marginTop: 5, fontSize: '0.84rem', color: 'var(--text-secondary)', display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                            <span><strong>By:</strong> {req.requestedBy}</span>
                            <span><strong>Dept:</strong> {req.department}</span>
                            <span><strong>Reason:</strong> {req.reason}</span>
                            <span><strong>Submitted:</strong> {fmtDate(req.createdAt)}</span>
                          </div>
                        </div>
                        {rejectingInvId !== req.id && approvingInvId !== req.id && (
                          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                            <button
                              className="primary-btn"
                              style={{ padding: '5px 14px', fontSize: '0.82rem', background: 'hsl(var(--color-green))' }}
                              onClick={() => { setApprovingInvId(req.id); setPickedAllocator(''); }}>
                              <CheckCircle size={13} /> Approve
                            </button>
                            <button
                              className="secondary-btn"
                              style={{ padding: '5px 14px', fontSize: '0.82rem', color: 'hsl(var(--color-red))', borderColor: 'hsl(var(--color-red))' }}
                              onClick={() => { setRejectingInvId(req.id); setRejectInvReason(''); }}>
                              <XCircle size={13} /> Reject
                            </button>
                          </div>
                        )}
                      </div>
                      {approvingInvId === req.id && (
                        <div style={{ borderTop: '1px solid var(--border-color)', padding: '12px 16px', background: 'hsla(var(--color-green),0.04)' }}>
                          <p style={{ fontSize: '0.82rem', marginBottom: 8, color: 'hsl(var(--color-green))', fontWeight: 600 }}>Who should hand this item over to {req.requestedBy}?</p>
                          <select
                            className="form-input"
                            style={{ width: '100%', maxWidth: 280, fontSize: '0.85rem' }}
                            value={pickedAllocator}
                            onChange={e => setPickedAllocator(e.target.value)}
                            autoFocus>
                            <option value="">Select a person…</option>
                            {allocators.map(a => (
                              <option key={a.email} value={a.email}>{a.name}</option>
                            ))}
                          </select>
                          <div style={{ display: 'flex', gap: 8, marginTop: 10, justifyContent: 'flex-end' }}>
                            <button className="secondary-btn" style={{ padding: '5px 12px', fontSize: '0.82rem' }}
                              onClick={() => { setApprovingInvId(null); setPickedAllocator(''); }} disabled={approvingBusy}>
                              Cancel
                            </button>
                            <button
                              className="primary-btn"
                              style={{ padding: '5px 14px', fontSize: '0.82rem', background: 'hsl(var(--color-green))' }}
                              onClick={() => handleApproveInv(req)}
                              disabled={!pickedAllocator || approvingBusy}>
                              {approvingBusy ? <><Loader2 size={13} style={{ animation: 'spin 0.7s linear infinite' }} /> Approving…</> : 'Confirm Approval'}
                            </button>
                          </div>
                        </div>
                      )}
                      {rejectingInvId === req.id && (
                        <div style={{ borderTop: '1px solid var(--border-color)', padding: '12px 16px', background: 'hsla(0,80%,50%,0.04)' }}>
                          <p style={{ fontSize: '0.82rem', marginBottom: 8, color: 'hsl(var(--color-red))', fontWeight: 600 }}>Enter rejection reason:</p>
                          <textarea
                            className="form-input" rows={2}
                            style={{ width: '100%', resize: 'vertical', fontSize: '0.85rem' }}
                            placeholder="Explain why this request is being rejected..."
                            value={rejectInvReason}
                            onChange={e => setRejectInvReason(e.target.value)}
                            autoFocus
                          />
                          <div style={{ display: 'flex', gap: 8, marginTop: 10, justifyContent: 'flex-end' }}>
                            <button className="secondary-btn" style={{ padding: '5px 12px', fontSize: '0.82rem' }} onClick={() => setRejectingInvId(null)}>Cancel</button>
                            <button
                              className="primary-btn"
                              style={{ padding: '5px 14px', fontSize: '0.82rem', background: 'hsl(var(--color-red))' }}
                              onClick={() => { rejectInvReq(req.id, MANAGER_NAME, rejectInvReason); setRejectingInvId(null); setRejectInvReason(''); }}
                              disabled={!rejectInvReason.trim()}>
                              Confirm Reject
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Divider */}
            <div style={{ borderTop: '1px solid var(--border-color)', marginBottom: 20 }} />

            {/* Other alerts */}
            <h3 style={{ marginBottom: 14 }}>Other Pending Alerts</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {[
                { color: 'red',    title: 'Overdue Task Alert',      body: 'Sarah Johnson has not updated "Q2 Invoice Audit" (due 2 days ago).', btn: 'Send Reminder' },
                { color: 'orange', title: 'Material Approval Needed', body: 'Apex Concrete Requisition #8492 ($14,400) requires leadership sign-off.', btn: 'Review Req' },
                { color: 'blue',   title: 'Shift Discrepancy',        body: 'Michael Chen logged 12 hours overtime on Site-B excavation without approval.', btn: 'Acknowledge' },
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

        {/* ── Who Has What ── */}
        {effectiveTab === 'who-has-what' && (
          <>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', flexWrap:'wrap', gap:12, marginBottom:20 }}>
              <div>
                <h3 style={{ fontSize:15, fontWeight:700, margin:0 }}>Who Has What</h3>
                <p style={{ fontSize:13, color:'var(--muted)', marginTop:3 }}>
                  All assets currently checked out — <strong>Permanent</strong> (via Purchase Requisition) and <strong>Temporary</strong> (via Inventory).
                </p>
              </div>
              <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                <Filter size={14} style={{ color:'var(--muted)' }} />
                <select value={whoHasWhatDept} onChange={e => setWhoHasWhatDept(e.target.value)}
                  className="form-input" style={{ padding:'6px 10px', fontSize:13, height:34 }}>
                  {WHWDEPTS.map(d => <option key={d}>{d}</option>)}
                </select>
              </div>
            </div>

            {/* ── Pending Allocation ── */}
            {pendingAlloc.length > 0 && (
              <div style={{ marginBottom:24, border:'1px solid hsla(var(--color-blue),0.25)', borderRadius:12, overflow:'hidden', background:'hsla(var(--color-blue),0.03)' }}>
                <div style={{ padding:'12px 16px', borderBottom:'1px solid hsla(var(--color-blue),0.15)', display:'flex', alignItems:'center', gap:8 }}>
                  <span style={{ fontSize:12, fontWeight:700, color:'hsl(var(--color-blue))', textTransform:'uppercase', letterSpacing:'.05em' }}>
                    Pending Allocation — {pendingAlloc.length}
                  </span>
                  <span style={{ fontSize:11.5, color:'var(--muted)' }}>Approved by manager, awaiting physical handover by supervisor</span>
                </div>
                <table className="req-table" style={{ fontSize:13 }}>
                  <thead>
                    <tr>
                      <th>Employee</th><th>Item</th><th>Dept</th><th>Approved</th><th>Assigned To</th><th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pendingAlloc.map(row => (
                      <tr key={row.key}>
                        <td style={{ fontWeight:600 }}>
                          {row.employee}
                          {row.raisedBy && row.raisedBy !== row.employee && (
                            <div style={{ fontSize:10.5, color:'var(--muted)', fontWeight:400 }}>via {row.raisedBy}</div>
                          )}
                        </td>
                        <td>{row.item}</td>
                        <td style={{ color:'var(--muted)' }}>{row.dept}</td>
                        <td style={{ color:'var(--muted)', fontSize:12 }}>
                          {row.approvedAt ? new Date(row.approvedAt).toLocaleDateString('en-US',{month:'short',day:'numeric'}) : '—'}
                          {row.approvedBy && <div style={{ fontSize:10.5 }}>by {row.approvedBy}</div>}
                        </td>
                        <td style={{ fontSize:12 }}>
                          {row.assignedTo || <span style={{ color:'var(--muted)' }}>—</span>}
                          {row.assignedToEmail === myEmail && (
                            <div style={{ fontSize:10, color:'hsl(var(--color-blue))', fontWeight:600 }}>You</div>
                          )}
                        </td>
                        <td>
                          <button
                            onClick={() => handleAllocate(row)}
                            disabled={!!allocating[row.key]}
                            style={{ display:'inline-flex', alignItems:'center', gap:5, padding:'5px 12px', borderRadius:7, border:'none', background:'hsl(var(--color-green))', color:'#fff', fontSize:12, fontWeight:600, cursor: allocating[row.key] ? 'default' : 'pointer', opacity: allocating[row.key] ? 0.6 : 1, fontFamily:'Inter,sans-serif' }}>
                            {allocating[row.key]
                              ? <><Loader2 size={13} style={{ animation:'spin 0.7s linear infinite' }} /> Allocating…</>
                              : <><CheckCircle size={13} /> Mark Allocated</>}
                          </button>
                          {allocErrors[row.key] && (
                            <div style={{ marginTop:6, display:'flex', alignItems:'center', gap:5, fontSize:11, color:'hsl(var(--color-red))', maxWidth:220 }}>
                              <AlertCircle size={12} style={{ flexShrink:0 }} /> {allocErrors[row.key]}
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Summary row */}
            <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:12, marginBottom:20 }}>
              {[
                { label:'Total Checked Out', value: allCheckedOut.length },
                { label:'Temporary',         value: tempItems.length },
                { label:'Overdue',           value: overdueCount, red: overdueCount > 0 },
              ].map(({ label, value, red }) => (
                <div key={label} style={{ background:'var(--card)', border:`1px solid ${red && value > 0 ? 'hsla(var(--color-red),0.3)' : 'var(--line)'}`, borderRadius:10, padding:'12px 16px' }}>
                  <div style={{ fontSize:11, fontWeight:700, color:'var(--muted)', textTransform:'uppercase', letterSpacing:'.04em' }}>{label}</div>
                  <div style={{ fontSize:24, fontWeight:700, marginTop:4, color: red && value > 0 ? 'hsl(var(--color-red))' : 'var(--ink)' }}>{value}</div>
                </div>
              ))}
            </div>

            {filteredWHW.length === 0 ? (
              <div style={{ textAlign:'center', padding:'48px 0', color:'var(--muted)', fontSize:14 }}>
                No assets currently checked out{whoHasWhatDept !== 'All' ? ` for ${whoHasWhatDept}` : ''}.
              </div>
            ) : (
              <div style={{ border:'1px solid var(--line)', borderRadius:12, overflow:'hidden' }}>
                <table className="req-table" style={{ fontSize:13 }}>
                  <thead>
                    <tr>
                      <th>Employee</th>
                      <th>Item</th>
                      <th>Dept</th>
                      <th>Type</th>
                      <th>Since</th>
                      <th>Due / Return</th>
                      <th>Status</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredWHW.map(row => (
                      <tr key={row.key} style={{ background: row.isOverdue ? 'hsla(var(--color-red),0.04)' : 'transparent' }}>
                        <td style={{ fontWeight:600 }}>
                          {row.employee}
                          {row.raisedBy && row.raisedBy !== row.employee && (
                            <div style={{ fontSize:10.5, color:'var(--muted)', fontWeight:400 }}>via {row.raisedBy}</div>
                          )}
                        </td>
                        <td>{row.item}</td>
                        <td style={{ color:'var(--muted)' }}>{row.dept}</td>
                        <td>
                          <span style={{
                            padding:'2px 8px', borderRadius:20, fontSize:11, fontWeight:600,
                            background: row.type === 'Temporary' ? 'hsla(var(--color-blue),0.1)' : 'hsla(var(--color-purple),0.1)',
                            color: row.type === 'Temporary' ? 'hsl(var(--color-blue))' : 'hsl(var(--color-purple))',
                          }}>
                            {row.type}
                          </span>
                        </td>
                        <td style={{ color:'var(--muted)', fontSize:12 }}>
                          {row.since ? new Date(row.since).toLocaleDateString('en-US',{month:'short',day:'numeric'}) : '—'}
                        </td>
                        <td style={{ fontWeight: row.isOverdue ? 700 : 400, color: row.isOverdue ? 'hsl(var(--color-red))' : 'var(--ink)' }}>
                          {row.isOverdue && '⚠ '}{row.dueDate === '—' ? '—' : row.dueDate}
                        </td>
                        <td>
                          {row.isOverdue ? (
                            <span style={{ padding:'2px 8px', borderRadius:20, fontSize:11, fontWeight:700, background:'hsla(var(--color-red),0.12)', color:'hsl(var(--color-red))' }}>
                              Overdue
                            </span>
                          ) : (
                            <span style={{ padding:'2px 8px', borderRadius:20, fontSize:11, fontWeight:600, background:'hsla(var(--color-green),0.1)', color:'hsl(var(--color-green))' }}>
                              Active
                            </span>
                          )}
                        </td>
                        <td>
                          {row.isOverdue && (
                            alertSent[row.key] ? (
                              <span style={{ fontSize:11.5, color:'hsl(var(--color-green))', fontWeight:600, display:'flex', alignItems:'center', gap:4 }}>
                                <CheckCircle size={12} /> Alert sent
                              </span>
                            ) : (
                              <button onClick={() => handleSendOverdueAlert(row)}
                                style={{ display:'inline-flex', alignItems:'center', gap:5, padding:'4px 10px', borderRadius:7, border:'1px solid hsla(var(--color-orange),0.3)', background:'hsla(var(--color-orange),0.08)', color:'hsl(var(--color-orange))', fontSize:11.5, fontWeight:600, cursor:'pointer', fontFamily:'Inter,sans-serif' }}>
                                <Mail size={11} /> Send Alert
                              </button>
                            )
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        {/* ── Calendar ── */}
        {effectiveTab === 'calendar' && (
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

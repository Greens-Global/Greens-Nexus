// Heavy dashboard widgets ported from the old Overview / Team Analytics screens
// (Dashboard.jsx portfolio + ManagerDashboard tabs). Lazy-loaded by widgets.jsx
// so TimeAdmin & co. stay out of the main bundle.
import { useState, useEffect, useRef } from 'react';
import { useMsal } from '@azure/msal-react';
import { MapPin, CheckCircle, XCircle, ChevronDown, Package, Mail, Filter, Loader2, AlertCircle } from 'lucide-react';
import { useRequisitions }  from '../contexts/RequisitionContext';
import { useInventory }     from '../contexts/InventoryContext';
import { useNotifications } from '../contexts/NotificationContext';
import { useRole }          from '../contexts/RoleContext';
import { api }              from '../api';
import TimeAdmin            from '../components/TimeAdmin';
import { navigate }         from './widgets.jsx';

const Card = ({ title, sub, action, children }) => (
  <div className="dash-card" style={{ height: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column' }}>
    {(title || action) && (
      <div className="dash-card-head" style={{ marginBottom: 12 }}>
        <div>
          {title && <div className="dash-card-title">{title}</div>}
          {sub && <div className="dash-card-sub">{sub}</div>}
        </div>
        {action}
      </div>
    )}
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>{children}</div>
  </div>
);

const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '-';

// ── Pending approvals (REAL - ported from ManagerDashboard "Pending Actions") ──
export function ApprovalsPanel() {
  const { accounts } = useMsal();
  const myName = accounts[0]?.name ?? 'Manager';
  const { can } = useRole();
  const { requisitions, pendingManagerCount, approveRequisition, rejectRequisition } = useRequisitions();
  const { requests: invRequests, approveRequest: approveInvReq, rejectRequest: rejectInvReq } = useInventory();
  const { addNotification } = useNotifications();

  const [rejectingId,     setRejectingId]     = useState(null);
  const [rejectReason,    setRejectReason]    = useState('');
  const [expandedReq,     setExpandedReq]     = useState(null);
  const [rejectingInvId,  setRejectingInvId]  = useState(null);
  const [rejectInvReason, setRejectInvReason] = useState('');
  const [approvingInvId,  setApprovingInvId]  = useState(null);
  const [pickedAllocator, setPickedAllocator] = useState('');
  const [approvingBusy,   setApprovingBusy]   = useState(false);
  const [allocators,      setAllocators]      = useState([]);

  useEffect(() => {
    if (!can('manager')) return;
    api.getInventoryAllocators().then(setAllocators).catch(() => {});
  }, [can]);

  const pendingReqs    = requisitions.filter(r => r.status === 'pending_manager');
  const pendingInvReqs = invRequests.filter(r => r.status === 'pending');

  function handleApproveInv(req) {
    const chosen = allocators.find(a => a.email === pickedAllocator);
    if (!chosen) return;
    setApprovingBusy(true);
    approveInvReq(req.id, myName, chosen.email, chosen.name)
      .then(() => {
        addNotification({
          type: 'allocate_request', recipient: chosen.email, refId: req.id,
          itemName: req.itemName, requestedBy: req.requestedBy,
          title: 'Allocate an Item',
          body: `${myName} approved ${req.requestedBy}'s request for ${req.itemName} and assigned it to you to hand over.`,
          action: { label: 'Allocate Now →', kind: 'allocate' },
        });
        setApprovingInvId(null);
        setPickedAllocator('');
      })
      .catch(() => {})
      .finally(() => setApprovingBusy(false));
  }

  const total = pendingManagerCount + pendingInvReqs.length;

  return (
    <Card title="Pending Approvals" sub="Purchase requisitions and inventory requests awaiting you"
      action={total > 0 && <span className="status-badge status-pending" style={{ fontSize: '0.78rem' }}>{total} pending</span>}>

      {/* Purchase requisitions */}
      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em', margin: '2px 0 8px' }}>Purchase requisitions</div>
      {pendingReqs.length === 0 ? (
        <div style={{ border: '1px dashed var(--line)', borderRadius: 8, padding: '16px 0', textAlign: 'center', color: 'var(--muted)', fontSize: 12.5, marginBottom: 16 }}>
          None awaiting approval.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
          {pendingReqs.map(req => (
            <div key={req.id} style={{ border: '1px solid var(--line)', borderRadius: 8, overflow: 'hidden', background: 'var(--paper)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 13px', flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 180 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontFamily: 'monospace', fontSize: '0.74rem', color: 'var(--muted)', background: 'var(--mist)', padding: '2px 6px', borderRadius: 4 }}>{req.id}</span>
                    <strong style={{ fontSize: '0.9rem' }}>{req.item}</strong>
                    <span style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>× {req.quantity}</span>
                  </div>
                  <div style={{ marginTop: 4, fontSize: '0.8rem', color: 'var(--muted)', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                    <span><strong>By:</strong> {req.employeeName}</span>
                    <span><strong>Dept:</strong> {req.employeeDept}</span>
                    <span><strong>Submitted:</strong> {fmtDate(req.createdAt)}</span>
                  </div>
                </div>
                <button onClick={() => setExpandedReq(expandedReq === req.id ? null : req.id)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', padding: 4, display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.76rem' }}>
                  Reason <ChevronDown size={13} style={{ transform: expandedReq === req.id ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }} />
                </button>
                {rejectingId !== req.id && (
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    <button className="primary-btn" style={{ padding: '5px 12px', fontSize: '0.8rem', background: 'hsl(var(--color-green))' }}
                      onClick={() => approveRequisition(req.id, myName)}>
                      <CheckCircle size={13} /> Approve
                    </button>
                    <button className="secondary-btn" style={{ padding: '5px 12px', fontSize: '0.8rem', color: 'hsl(var(--color-red))', borderColor: 'hsl(var(--color-red))' }}
                      onClick={() => { setRejectingId(req.id); setRejectReason(''); }}>
                      <XCircle size={13} /> Reject
                    </button>
                  </div>
                )}
              </div>
              {expandedReq === req.id && (
                <div style={{ borderTop: '1px solid var(--line)', padding: '9px 13px', background: 'var(--mist)', fontSize: '0.83rem', color: 'var(--muted)' }}>
                  <strong>Reason:</strong> {req.reason || '-'}
                </div>
              )}
              {rejectingId === req.id && (
                <div style={{ borderTop: '1px solid var(--line)', padding: '10px 13px', background: 'hsla(0,80%,50%,0.04)' }}>
                  <p style={{ fontSize: '0.8rem', marginBottom: 7, color: 'hsl(var(--color-red))', fontWeight: 600 }}>Enter rejection reason:</p>
                  <textarea className="form-input" rows={2} style={{ width: '100%', resize: 'vertical', fontSize: '0.84rem' }}
                    placeholder="Explain why this request is being rejected..."
                    value={rejectReason} onChange={e => setRejectReason(e.target.value)} autoFocus />
                  <div style={{ display: 'flex', gap: 8, marginTop: 8, justifyContent: 'flex-end' }}>
                    <button className="secondary-btn" style={{ padding: '5px 12px', fontSize: '0.8rem' }}
                      onClick={() => { setRejectingId(null); setRejectReason(''); }}>Cancel</button>
                    <button className="primary-btn" style={{ padding: '5px 12px', fontSize: '0.8rem', background: 'hsl(var(--color-red))' }}
                      onClick={() => { if (rejectReason.trim()) { rejectRequisition(req.id, myName, rejectReason.trim()); setRejectingId(null); setRejectReason(''); } }}
                      disabled={!rejectReason.trim()}>Confirm Reject</button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Inventory requests */}
      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em', margin: '2px 0 8px' }}>Inventory requests</div>
      {pendingInvReqs.length === 0 ? (
        <div style={{ border: '1px dashed var(--line)', borderRadius: 8, padding: '16px 0', textAlign: 'center', color: 'var(--muted)', fontSize: 12.5 }}>
          None awaiting approval.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {pendingInvReqs.map(req => (
            <div key={req.id} style={{ border: '1px solid var(--line)', borderRadius: 8, overflow: 'hidden', background: 'var(--paper)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 13px', flexWrap: 'wrap' }}>
                <div style={{ width: 30, height: 30, borderRadius: 8, background: 'hsla(var(--color-blue),0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <Package size={15} color="hsl(var(--color-blue))" />
                </div>
                <div style={{ flex: 1, minWidth: 180 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontFamily: 'monospace', fontSize: '0.74rem', color: 'var(--muted)', background: 'var(--mist)', padding: '2px 6px', borderRadius: 4 }}>{req.id}</span>
                    <strong style={{ fontSize: '0.9rem' }}>{req.itemName}</strong>
                    <span style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>× {req.quantity} · {req.days}d</span>
                  </div>
                  <div style={{ marginTop: 4, fontSize: '0.8rem', color: 'var(--muted)', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                    <span><strong>By:</strong> {req.requestedBy}</span>
                    <span><strong>Dept:</strong> {req.department}</span>
                    <span><strong>Reason:</strong> {req.reason}</span>
                  </div>
                </div>
                {rejectingInvId !== req.id && approvingInvId !== req.id && (
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    <button className="primary-btn" style={{ padding: '5px 12px', fontSize: '0.8rem', background: 'hsl(var(--color-green))' }}
                      onClick={() => { setApprovingInvId(req.id); setPickedAllocator(''); }}>
                      <CheckCircle size={13} /> Approve
                    </button>
                    <button className="secondary-btn" style={{ padding: '5px 12px', fontSize: '0.8rem', color: 'hsl(var(--color-red))', borderColor: 'hsl(var(--color-red))' }}
                      onClick={() => { setRejectingInvId(req.id); setRejectInvReason(''); }}>
                      <XCircle size={13} /> Reject
                    </button>
                  </div>
                )}
              </div>
              {approvingInvId === req.id && (
                <div style={{ borderTop: '1px solid var(--line)', padding: '10px 13px', background: 'hsla(var(--color-green),0.04)' }}>
                  <p style={{ fontSize: '0.8rem', marginBottom: 7, color: 'hsl(var(--color-green))', fontWeight: 600 }}>Who should hand this item over to {req.requestedBy}?</p>
                  <select className="form-input" style={{ width: '100%', maxWidth: 280, fontSize: '0.84rem' }}
                    value={pickedAllocator} onChange={e => setPickedAllocator(e.target.value)} autoFocus>
                    <option value="">Select a person…</option>
                    {allocators.map(a => <option key={a.email} value={a.email}>{a.name}</option>)}
                  </select>
                  <div style={{ display: 'flex', gap: 8, marginTop: 8, justifyContent: 'flex-end' }}>
                    <button className="secondary-btn" style={{ padding: '5px 12px', fontSize: '0.8rem' }}
                      onClick={() => { setApprovingInvId(null); setPickedAllocator(''); }} disabled={approvingBusy}>Cancel</button>
                    <button className="primary-btn" style={{ padding: '5px 12px', fontSize: '0.8rem', background: 'hsl(var(--color-green))' }}
                      onClick={() => handleApproveInv(req)} disabled={!pickedAllocator || approvingBusy}>
                      {approvingBusy ? <><Loader2 size={13} style={{ animation: 'spin 0.7s linear infinite' }} /> Approving…</> : 'Confirm Approval'}
                    </button>
                  </div>
                </div>
              )}
              {rejectingInvId === req.id && (
                <div style={{ borderTop: '1px solid var(--line)', padding: '10px 13px', background: 'hsla(0,80%,50%,0.04)' }}>
                  <p style={{ fontSize: '0.8rem', marginBottom: 7, color: 'hsl(var(--color-red))', fontWeight: 600 }}>Enter rejection reason:</p>
                  <textarea className="form-input" rows={2} style={{ width: '100%', resize: 'vertical', fontSize: '0.84rem' }}
                    placeholder="Explain why this request is being rejected..."
                    value={rejectInvReason} onChange={e => setRejectInvReason(e.target.value)} autoFocus />
                  <div style={{ display: 'flex', gap: 8, marginTop: 8, justifyContent: 'flex-end' }}>
                    <button className="secondary-btn" style={{ padding: '5px 12px', fontSize: '0.8rem' }} onClick={() => setRejectingInvId(null)}>Cancel</button>
                    <button className="primary-btn" style={{ padding: '5px 12px', fontSize: '0.8rem', background: 'hsl(var(--color-red))' }}
                      onClick={() => { rejectInvReq(req.id, myName, rejectInvReason); setRejectingInvId(null); setRejectInvReason(''); }}
                      disabled={!rejectInvReason.trim()}>Confirm Reject</button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ── Who has what (REAL - ported from ManagerDashboard) ────────────────────────
export function WhoHasWhatPanel() {
  const { accounts } = useMsal();
  const myEmail = (accounts[0]?.username ?? '').toLowerCase();
  const myName  = accounts[0]?.name ?? '';
  const { can } = useRole();
  const { requisitions, hwAssets } = useRequisitions();
  const { requests: invRequests, allocateItem } = useInventory();
  const { sendOverdueAlert, addNotification } = useNotifications();

  const [dept,        setDept]        = useState('All');
  const [alertSent,   setAlertSent]   = useState({});
  const [allocating,  setAllocating]  = useState({});
  const [allocErrors, setAllocErrors] = useState({});

  const todayStr = new Date().toISOString().split('T')[0];

  const pendingAlloc = invRequests
    .filter(r => r.status === 'approved' &&
      (can('manager') || (r.assignedAllocatorEmail || '').toLowerCase() === myEmail))
    .map(r => ({
      key: r.id, employee: r.requestedBy, employeeEmail: r.requestedByEmail ?? '',
      raisedBy: r.raisedBy, item: r.itemName, dept: r.department, reqId: r.id,
      approvedAt: r.resolvedAt, approvedBy: r.resolvedBy,
      assignedTo: r.assignedAllocatorName || '',
      assignedToEmail: (r.assignedAllocatorEmail || '').toLowerCase(),
    }));

  const tempItems = invRequests
    .filter(r => r.status === 'allocated')
    .map(r => {
      const startDate = r.allocatedAt ?? r.createdAt;
      const dueDate   = new Date(new Date(startDate).getTime() + (r.days || 1) * 86400000);
      return {
        key: r.id, employee: r.requestedBy, raisedBy: r.raisedBy, item: r.itemName,
        dept: r.department, type: 'Temporary', since: r.allocatedAt ?? r.createdAt,
        dueDate: dueDate.toISOString().split('T')[0], isOverdue: dueDate < new Date(), reqId: r.id,
      };
    });

  const permItems = hwAssets
    .filter(a => a.status === 'Checked Out' && a.assignedTo && a.assignedTo !== 'Unassigned')
    .map(a => {
      const linkedReq = requisitions.find(r => r.assetId === a.id && r.status === 'asset_allocated');
      const isOverdue = linkedReq?.expectedReturnDate && linkedReq.expectedReturnDate < todayStr;
      return {
        key: a.id, employee: a.assignedTo, item: a.name, dept: a.dept, type: 'Permanent',
        since: a.lastUpdated, dueDate: linkedReq?.expectedReturnDate ?? '-', isOverdue: !!isOverdue, reqId: a.id,
      };
    });

  const all = [...tempItems, ...permItems];
  const DEPTS = ['All', 'IT', 'Construction', 'Operations', 'Accounting'];
  const filtered = dept === 'All' ? all
    : all.filter(i => i.dept === dept || i.dept?.toLowerCase().includes(dept.toLowerCase()));
  const overdueCount = all.filter(i => i.isOverdue).length;

  function handleAllocate(row) {
    setAllocating(p => ({ ...p, [row.key]: true }));
    setAllocErrors(p => ({ ...p, [row.key]: null }));
    allocateItem(row.reqId, myName).then(() => {
      addNotification({
        type: 'allocated', recipient: row.employeeEmail || row.employee,
        title: 'Item Allocated ✓',
        body: `Your ${row.item} has been allocated and is ready for collection. Please pick it up from your supervisor.`,
        action: { label: 'Track Request →', view: 'inventory', sub: 'checkouts' },
      });
    }).catch(err => {
      const msg = /409|stock/i.test(err?.message || '')
        ? `Not enough ${row.item} in stock to allocate right now.`
        : `Couldn't allocate ${row.item} - please try again.`;
      setAllocErrors(p => ({ ...p, [row.key]: msg }));
    }).finally(() => setAllocating(p => ({ ...p, [row.key]: false })));
  }

  return (
    <Card title={`Who has what${overdueCount ? ` - ⚠ ${overdueCount} overdue` : ''}`}
      sub="Everything currently checked out, permanent and temporary"
      action={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Filter size={13} style={{ color: 'var(--muted)' }} />
          <select value={dept} onChange={e => setDept(e.target.value)} className="form-input"
            style={{ padding: '5px 8px', fontSize: 12.5, height: 'auto' }}>
            {DEPTS.map(d => <option key={d}>{d}</option>)}
          </select>
        </span>
      }>

      {pendingAlloc.length > 0 && (
        <div style={{ marginBottom: 14, border: '1px solid hsla(var(--color-blue),0.25)', borderRadius: 10, background: 'hsla(var(--color-blue),0.03)', padding: 10 }}>
          <div style={{ fontSize: 11.5, fontWeight: 700, color: 'hsl(var(--color-blue))', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 8 }}>
            Pending allocation - {pendingAlloc.length}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {pendingAlloc.map(row => (
              <div key={row.key} onClick={() => navigate('inventory', 'checkouts')} title="Open in Item Management"
                style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', cursor: 'pointer', border: '1px solid var(--line)', borderRadius: 8, padding: '9px 11px', background: 'var(--card)' }}>
                <div style={{ flex: 1, minWidth: 150 }}>
                  <strong style={{ fontSize: 13 }}>{row.employee}</strong>
                  <span style={{ fontSize: 12.5, color: 'var(--muted)' }}> - {row.item}</span>
                  <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                    {row.assignedTo ? <>Assigned to {row.assignedToEmail === myEmail ? 'you' : row.assignedTo}</> : 'Unassigned'}
                    {row.approvedAt && <> · approved {new Date(row.approvedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</>}
                  </div>
                </div>
                <div>
                  <button onClick={(e) => { e.stopPropagation(); handleAllocate(row); }} disabled={!!allocating[row.key]}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: 7, border: 'none', background: 'hsl(var(--color-green))', color: '#fff', fontSize: 12, fontWeight: 600, cursor: allocating[row.key] ? 'default' : 'pointer', opacity: allocating[row.key] ? 0.6 : 1, fontFamily: 'Inter,sans-serif' }}>
                    {allocating[row.key]
                      ? <><Loader2 size={12} style={{ animation: 'spin 0.7s linear infinite' }} /> Allocating…</>
                      : <><CheckCircle size={12} /> Mark Allocated</>}
                  </button>
                  {allocErrors[row.key] && (
                    <div style={{ marginTop: 5, display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'hsl(var(--color-red))' }}>
                      <AlertCircle size={11} style={{ flexShrink: 0 }} /> {allocErrors[row.key]}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '28px 0', color: 'var(--muted)', fontSize: 13 }}>
          No assets currently checked out{dept !== 'All' ? ` for ${dept}` : ''}.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {filtered.map(row => (
            <div key={row.key} onClick={() => navigate('inventory', 'checkouts')}
              title="Open in Item Management"
              onMouseEnter={e => e.currentTarget.style.borderColor = 'hsl(var(--color-blue))'}
              onMouseLeave={e => e.currentTarget.style.borderColor = row.isOverdue ? 'hsla(var(--color-red),0.35)' : 'var(--line)'}
              style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', cursor: 'pointer', border: `1px solid ${row.isOverdue ? 'hsla(var(--color-red),0.35)' : 'var(--line)'}`, borderRadius: 8, padding: '9px 11px', background: row.isOverdue ? 'hsla(var(--color-red),0.03)' : 'var(--paper)' }}>
              <div style={{ flex: 1, minWidth: 160 }}>
                <strong style={{ fontSize: 13 }}>{row.employee}</strong>
                <span style={{ fontSize: 12.5, color: 'var(--muted)' }}> - {row.item}</span>
                {row.raisedBy && row.raisedBy !== row.employee && (
                  <span style={{ fontSize: 11, color: 'var(--muted)' }}> (via {row.raisedBy})</span>
                )}
                <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
                  {row.dept} · since {row.since ? new Date(row.since).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '-'} ·{' '}
                  <span style={{ fontWeight: row.isOverdue ? 700 : 500, color: row.isOverdue ? 'hsl(var(--color-red))' : 'var(--muted)' }}>
                    {row.isOverdue && '⚠ '}due {row.dueDate}
                  </span>
                </div>
              </div>
              <span style={{ padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 600,
                background: row.type === 'Temporary' ? 'hsla(var(--color-blue),0.1)' : 'hsla(var(--color-purple),0.1)',
                color: row.type === 'Temporary' ? 'hsl(var(--color-blue))' : 'hsl(var(--color-purple))' }}>{row.type}</span>
              {row.isOverdue ? (
                alertSent[row.key] ? (
                  <span style={{ fontSize: 11.5, color: 'hsl(var(--color-green))', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <CheckCircle size={12} /> Alert sent
                  </span>
                ) : (
                  <button onClick={(e) => { e.stopPropagation(); sendOverdueAlert(row.reqId, row.employee, row.item); setAlertSent(p => ({ ...p, [row.key]: true })); }}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 10px', borderRadius: 7, border: '1px solid hsla(var(--color-orange),0.3)', background: 'hsla(var(--color-orange),0.08)', color: 'hsl(var(--color-orange))', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'Inter,sans-serif' }}>
                    <Mail size={11} /> Send Alert
                  </button>
                )
              ) : (
                <span style={{ padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 600, background: 'hsla(var(--color-green),0.1)', color: 'hsl(var(--color-green))' }}>Active</span>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ── Team time (REAL - TimeAdmin, scoped server-side to direct reports) ────────
export function TeamTimePanel() {
  const [tmsg, setTmsg] = useState(null);
  return (
    <Card title="Team Time" sub="Your direct reports' punches, approvals and time off - HR sees the whole company under HR → Time">
      {tmsg && (
        <div style={{ padding: '9px 14px', borderRadius: 10, marginBottom: 12, fontSize: 12.5, fontWeight: 600,
          background: tmsg.ok ? 'hsla(var(--color-green),0.1)' : 'rgba(220,38,38,0.08)',
          color: tmsg.ok ? 'hsl(var(--color-green))' : '#b91c1c' }}>{tmsg.t}</div>
      )}
      <TimeAdmin
        toastOk={(t) => { setTmsg({ ok: true, t }); setTimeout(() => setTmsg(null), 5000); }}
        toastErr={(t) => { setTmsg({ ok: false, t }); setTimeout(() => setTmsg(null), 6000); }} />
    </Card>
  );
}

// ── Portfolio widgets (ported from the old Dashboard Overview; sample data) ───
const FACILITIES = [
  { id: 'hv', name: 'Harbor View Storage',   city: 'Tacoma, WA',   occ: 94, units: 612, rented: 575, mrr: 88200, climate: true },
  { id: 'ds', name: 'Downtown Self Storage', city: 'Portland, OR', occ: 88, units: 480, rented: 422, mrr: 71400, climate: true },
  { id: 'rs', name: 'Riverside Storage',     city: 'Eugene, OR',   occ: 76, units: 350, rented: 266, mrr: 39800, climate: false },
  { id: 'll', name: 'Lakeline Storage',      city: 'Bend, OR',     occ: 91, units: 528, rented: 480, mrr: 66100, climate: true },
  { id: 'sm', name: 'Summit Storage',        city: 'Spokane, WA',  occ: 69, units: 290, rented: 200, mrr: 27500, climate: false },
];
const TREND = [
  { m: 'Dec', occ: 81 }, { m: 'Jan', occ: 83 }, { m: 'Feb', occ: 84 },
  { m: 'Mar', occ: 86 }, { m: 'Apr', occ: 85 }, { m: 'May', occ: 88 },
];
const TASKS = [
  { title: 'Approve Lakeline repaving change order', dept: 'Construction',     due: 'Today',    prio: 'high' },
  { title: 'Q2 occupancy report - Asset Management', dept: 'Asset Management', due: 'Today',    prio: 'high' },
  { title: 'Reply to Downtown 4-star review',        dept: 'Operations',       due: 'Tomorrow', prio: 'med' },
  { title: 'Renew Evergreen Electrical COI',         dept: 'Accounting',       due: 'May 30',   prio: 'high' },
  { title: 'Onboard new Summit site manager',        dept: 'HR',               due: 'Jun 2',    prio: 'med' },
];

function OccupancyChart() {
  const containerRef = useRef(null);
  const [w, setW] = useState(500);
  const [hovered, setHovered] = useState(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      if (width > 0) setW(Math.floor(width));
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  const h = 168, padX = 38, padY = 20, min = 75, max = 95;
  const xs = i => padX + i * ((w - padX * 2) / (TREND.length - 1));
  const ys = v => padY + ((max - v) / (max - min)) * (h - padY * 2 - 18);
  const pts = TREND.map((d, i) => `${xs(i)},${ys(d.occ)}`).join(' ');
  const area = `M ${xs(0)},${h - 18} ` + TREND.map((d, i) => `L ${xs(i)},${ys(d.occ)}`).join(' ') + ` L ${xs(TREND.length - 1)},${h - 18} Z`;

  return (
    <div ref={containerRef} style={{ width: '100%' }}>
      <svg width={w} height={h} style={{ display: 'block', overflow: 'visible', color: 'var(--ink)' }}>
        <defs>
          <linearGradient id="og" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.13" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill="url(#og)" />
        <polyline className="chart-line" points={pts} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
        {hovered !== null && (
          <line x1={xs(hovered)} y1={padY} x2={xs(hovered)} y2={h - 18} stroke="var(--muted)" strokeWidth="1" strokeDasharray="3 3" opacity="0.55" />
        )}
        {TREND.map((d, i) => (
          <g key={d.m} className="chart-dot">
            <circle cx={xs(i)} cy={ys(d.occ)} r={hovered === i ? 5.5 : 3.5} fill="currentColor" style={{ transition: 'r 0.15s ease' }} />
            <text x={xs(i)} y={h - 3} fontSize="10.5" textAnchor="middle" fontFamily="Inter, sans-serif"
              fontWeight={hovered === i ? 600 : 400}
              style={{ fill: hovered === i ? 'var(--ink)' : 'var(--muted)', transition: 'fill 0.15s' }}>{d.m}</text>
          </g>
        ))}
        {hovered !== null && (() => {
          const tx = Math.min(Math.max(xs(hovered), 42), w - 42);
          const ty = Math.max(ys(TREND[hovered].occ) - 52, 4);
          return (
            <g style={{ pointerEvents: 'none' }}>
              <rect x={tx - 30} y={ty} width={60} height={38} rx={9} fill="var(--ink)" />
              <polygon points={`${tx - 5},${ty + 38} ${tx + 5},${ty + 38} ${tx},${ty + 44}`} fill="var(--ink)" />
              <text x={tx} y={ty + 13} textAnchor="middle" fontSize="10" fontFamily="Inter, sans-serif" fill="rgba(255,255,255,0.6)">{TREND[hovered].m}</text>
              <text x={tx} y={ty + 30} textAnchor="middle" fontSize="14" fontFamily="Inter, sans-serif" fontWeight="700" fill="white">{TREND[hovered].occ}%</text>
            </g>
          );
        })()}
        {TREND.map((d, i) => {
          const zw = (w - padX * 2) / (TREND.length - 1);
          return (
            <rect key={`hz${i}`} x={xs(i) - zw / 2} y={0} width={zw} height={h} fill="transparent"
              style={{ cursor: 'crosshair' }} onMouseEnter={() => setHovered(i)} onMouseLeave={() => setHovered(null)} />
          );
        })}
      </svg>
    </div>
  );
}

export function OccupancyPanel() {
  const totalMrr = FACILITIES.reduce((a, f) => a + f.mrr, 0);
  const avgOcc = Math.round(FACILITIES.reduce((a, f) => a + f.occ, 0) / FACILITIES.length);
  return (
    <Card title="Occupancy Trend" sub="Portfolio average, last 6 months"
      action={<span style={{ fontSize: 12.5, color: 'var(--muted)' }}><strong style={{ color: 'var(--ink)' }}>{avgOcc}%</strong> avg · <strong style={{ color: 'var(--ink)' }}>${(totalMrr / 1000).toFixed(1)}k</strong> MRR</span>}>
      <OccupancyChart />
    </Card>
  );
}

export function FacilitiesPanel() {
  return (
    <Card title="Facilities" sub="Live occupancy across the Greens Storage portfolio">
      <div className="facilities-grid">
        {FACILITIES.map(f => (
          <div key={f.id} className="facility-card">
            <div className="facility-head">
              <div>
                <div className="facility-name">{f.name}</div>
                <div className="facility-city"><MapPin size={10} /> {f.city}</div>
              </div>
              {f.climate && <span className="facility-badge">Climate</span>}
            </div>
            <div className="occ-row">
              <div className="occ-bar"><span style={{ width: `${f.occ}%` }} /></div>
              <span className="occ-pct">{f.occ}%</span>
            </div>
            <div className="facility-foot">
              <span>{f.rented}/{f.units} units</span>
              <span className="mrr-tag">${(f.mrr / 1000).toFixed(1)}k MRR</span>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

export function TasksPanel() {
  return (
    <Card title="Tasks" sub="Across all departments"
      action={<button className="link-btn" style={{ marginTop: 0 }} onClick={() => navigate('tasks')}>View All →</button>}>
      <div className="task-list">
        {TASKS.map((t, i) => (
          <div key={i} className="task-row">
            <span className={`prio-dot prio-${t.prio}`} />
            <div className="task-content">
              <div className="task-title">{t.title}</div>
              <div className="task-dept">{t.dept}</div>
            </div>
            <span className={`task-due${t.due === 'Today' ? ' today' : ''}`}>{t.due}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

// ── Team analytics (sample data, ported from ManagerDashboard) ────────────────
const EMPLOYEES = [
  { name: 'Sarah Johnson',   dept: 'Accounting',  tasks: 8,  est: 32, act: 18, completed: 3, inprogress: 4, overdue: 1, workload: 85 },
  { name: 'Michael Chen',    dept: 'OPS',         tasks: 12, est: 48, act: 24, completed: 5, inprogress: 6, overdue: 1, workload: 95 },
  { name: 'Emily Rodriguez', dept: 'Development', tasks: 6,  est: 24, act: 12, completed: 2, inprogress: 3, overdue: 1, workload: 70 },
  { name: 'David Kim',       dept: 'IT Support',  tasks: 5,  est: 20, act: 10, completed: 1, inprogress: 3, overdue: 1, workload: 60 },
  { name: 'Jessica Taylor',  dept: 'Marketing',   tasks: 9,  est: 36, act: 20, completed: 4, inprogress: 4, overdue: 1, workload: 75 },
  { name: 'Marcus Vance',    dept: 'OPS',         tasks: 5,  est: 20, act: 16, completed: 2, inprogress: 3, overdue: 0, workload: 50 },
];
const PROJECTS = [
  { name: 'Oakridge Estate Subdivisions',  dept: 'Development', tasks: 14, progress: 75, badges: [{ label: '4 Urgent', color: 'red' }, { label: '6 Medium', color: 'orange' }] },
  { name: 'Downtown Commercial Complex',   dept: 'OPS',         tasks: 22, progress: 50, badges: [{ label: '8 Urgent', color: 'red' }, { label: '10 Low', color: 'blue' }] },
  { name: 'Corporate Office Renovation',   dept: 'IT / Admin',  tasks: 9,  progress: 90, badges: [{ label: '9 Completed', color: 'green' }] },
];

export function WorkloadPanel() {
  const workloadColor = (w) => w >= 90 ? 'hsl(var(--color-red))' : w >= 75 ? 'hsl(var(--color-orange))' : 'hsl(var(--color-blue))';
  return (
    <Card title="Workload by Employee" sub="Task distribution and estimated time per employee">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {EMPLOYEES.map(e => (
          <div key={e.name} style={{ border: '1px solid var(--line)', borderRadius: 10, padding: 11, background: 'var(--paper)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
              <strong style={{ fontSize: 13 }}>{e.name}</strong>
              <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{e.dept}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
              <div style={{ flex: 1, height: 6, background: 'var(--mist)', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{ width: `${e.workload}%`, height: '100%', background: workloadColor(e.workload), borderRadius: 3 }} />
              </div>
              <span style={{ fontSize: 12, fontWeight: 700 }}>{e.workload}%</span>
            </div>
            <div style={{ display: 'flex', gap: 12, marginTop: 8, fontSize: 11.5, color: 'var(--muted)', flexWrap: 'wrap' }}>
              <span><strong style={{ color: 'var(--ink)' }}>{e.tasks}</strong> tasks</span>
              <span><strong style={{ color: 'var(--ink)' }}>{e.act}h</strong> of {e.est}h</span>
              <span style={{ color: 'hsl(var(--color-green))', fontWeight: 600 }}>{e.completed} done</span>
              {e.overdue > 0 && <span style={{ color: 'hsl(var(--color-red))', fontWeight: 700 }}>{e.overdue} overdue</span>}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

export function ProjectsPanel() {
  return (
    <Card title="Project-wise Tasks" sub="Distribution across active job sites">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {PROJECTS.map(p => (
          <div key={p.name} style={{ border: '1px solid var(--line)', borderRadius: 10, padding: 11, background: 'var(--paper)' }}>
            <strong style={{ fontSize: 13 }}>{p.name}</strong>
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>{p.dept} · {p.tasks} tasks</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
              <div style={{ flex: 1, height: 6, background: 'var(--mist)', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{ width: `${p.progress}%`, height: '100%', borderRadius: 3, background: p.progress >= 90 ? 'hsl(var(--color-green))' : p.progress >= 60 ? 'hsl(var(--color-blue))' : 'hsl(var(--color-orange))' }} />
              </div>
              <span style={{ fontSize: 12, fontWeight: 700 }}>{p.progress}%</span>
            </div>
            <div style={{ marginTop: 8 }}>
              {p.badges.map(b => <span key={b.label} className="status-badge" style={{ backgroundColor: `hsla(var(--color-${b.color}), 0.1)`, color: `hsl(var(--color-${b.color}))`, marginRight: 4 }}>{b.label}</span>)}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

export function TeamCalendarPanel() {
  const WEEK = [
    { day: 'Mon', label: 'Safety briefing',     color: 'blue' },
    { day: 'Tue', label: 'Foundation pouring',  color: 'purple' },
    { day: 'Wed', label: 'Slab inspection',     color: 'green' },
    { day: 'Thu', label: 'Site audit',          color: 'orange' },
    { day: 'Fri', label: 'Roster finalization', color: 'red' },
  ];
  // Real dates for the current week (Mon–Fri)
  const now = new Date();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  return (
    <Card title="Team Calendar" sub="Onsite shift and safety briefing rosters this week">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 10, textAlign: 'center' }}>
        {WEEK.map((d, i) => {
          const date = new Date(monday); date.setDate(monday.getDate() + i);
          return (
            <div key={d.day} style={{ border: '1px solid var(--line)', padding: 10, borderRadius: 10 }}>
              <strong style={{ fontSize: 13 }}>{d.day}</strong>
              <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 3 }}>{date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</div>
              <div style={{ background: `hsla(var(--color-${d.color}), 0.1)`, color: `hsl(var(--color-${d.color}))`, padding: 4, borderRadius: 5, fontSize: 11, marginTop: 7 }}>{d.label}</div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

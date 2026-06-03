import { useState, useRef, useEffect } from 'react';
import { Bell, CheckCircle, XCircle, Package, ShoppingCart, RotateCcw, Check, X, Trash2 } from 'lucide-react';
import { useNotifications } from '../contexts/NotificationContext';
import { useInventory }      from '../contexts/InventoryContext';
import { useRequisitions }   from '../contexts/RequisitionContext';
import { useMsal }           from '@azure/msal-react';
import { useRole }           from '../contexts/RoleContext';

const MANAGER_NAME = 'Visesh Lodha';

function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1)  return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const TYPE_META = {
  inv_request:   { icon: Package,      label: 'Inventory Request',  color: 'var(--color-blue)'   },
  req_pending:   { icon: ShoppingCart, label: 'Purchase Requisition', color: 'var(--color-orange)' },
  item_returned: { icon: RotateCcw,    label: 'Item Returned',       color: 'var(--color-green)'  },
  approved:      { icon: CheckCircle,  label: 'Request Approved',    color: 'var(--color-green)'  },
  rejected:      { icon: XCircle,      label: 'Request Rejected',    color: 'var(--color-red)'    },
};

export default function NotificationBell({ onNavigate }) {
  const { notifications, unreadCount, markRead, markAllRead, dismiss, clearRead, addNotification, markActioned } = useNotifications();
  const { approveRequest, rejectRequest, requests: invRequests } = useInventory();
  const { approveRequisition, rejectRequisition }   = useRequisitions();
  const { accounts } = useMsal();
  const { can }      = useRole();
  const myName  = accounts[0]?.name     ?? '';
  const myEmail = (accounts[0]?.username ?? '').toLowerCase();

  const [open,         setOpen]         = useState(false);
  const [rejectingId,  setRejectingId]  = useState(null);
  const [rejectReason, setRejectReason] = useState('');
  const panelRef = useRef(null);

  useEffect(() => {
    function onClickOut(e) {
      if (panelRef.current && !panelRef.current.contains(e.target)) setOpen(false);
    }
    if (open) document.addEventListener('mousedown', onClickOut);
    return () => document.removeEventListener('mousedown', onClickOut);
  }, [open]);

  function handleOpen() {
    setOpen(o => !o);
  }

  function handleAction(n, action) {
    const refId       = n.refId       ?? '';
    const itemName    = n.itemName    ?? 'the item';
    const requestedBy = n.requestedBy ?? '';

    if (n.type === 'inv_request') {
      if (action === 'approve') {
        approveRequest(refId, MANAGER_NAME);
        markActioned(n.id);
        dismiss(n.id);
        // Resolve recipient email: prefer from notification action, then from the live request record
        const invReq = invRequests.find(r => r.id === refId);
        const recipientEmail = n.action?.requestedByEmail ?? invReq?.requestedByEmail ?? '';
        addNotification({
          type:        'approved',
          recipient:   recipientEmail || requestedBy,
          requestedBy, itemName,
          title: 'Request Approved ✓',
          body:  `Your request for ${itemName} has been approved. It will be assigned to you by your supervisor shortly.`,
          action: { label: 'Track Request →', view: 'inventory', sub: 'my-requests' },
        });
      } else { setRejectingId(n.id); }
    } else if (n.type === 'req_pending') {
      if (action === 'approve') {
        approveRequisition(refId, MANAGER_NAME);
        markActioned(n.id);
        dismiss(n.id);
        addNotification({ type: 'approved', recipient: requestedBy, requestedBy, itemName,
          title: 'Requisition Approved ✓',
          body:  `Your purchase requisition has been approved by ${MANAGER_NAME}. Your supervisor will allocate the asset to you.`,
        });
      } else { setRejectingId(n.id); }
    }
  }

  function submitReject(n) {
    if (!rejectReason.trim()) return;
    const refId       = n.refId       ?? '';
    const itemName    = n.itemName    ?? 'the item';
    const requestedBy = n.requestedBy ?? '';

    if (n.type === 'inv_request') {
      rejectRequest(refId, MANAGER_NAME, rejectReason.trim());
      const invReq = invRequests.find(r => r.id === refId);
      const recipientEmail = n.action?.requestedByEmail ?? invReq?.requestedByEmail ?? '';
      addNotification({
        type:        'rejected',
        recipient:   recipientEmail || requestedBy,
        requestedBy, itemName,
        title: 'Request Rejected',
        body:  `Your request for ${itemName} was not approved. Reason: "${rejectReason.trim()}"`,
        action: { label: 'View Request →', view: 'inventory', sub: 'my-requests' },
      });
    }
    if (n.type === 'req_pending') {
      rejectRequisition(refId, MANAGER_NAME, rejectReason.trim());
      addNotification({ type: 'rejected', recipient: requestedBy, requestedBy, itemName,
        title: 'Requisition Rejected',
        body:  `Your purchase requisition was not approved. Reason: "${rejectReason.trim()}"`,
      });
    }
    markActioned(n.id);
    dismiss(n.id);
    setRejectingId(null);
    setRejectReason('');
  }

  // Needs Action: only visible to managers+ (they have approve/reject capability)
  const actionable = can('manager') ? notifications.filter(n =>
    (n.type === 'inv_request' || n.type === 'req_pending') && !n.recipient
  ) : [];

  // Updates: no recipient (global) OR addressed to my email or my display name
  const updates = notifications.filter(n =>
    n.type !== 'inv_request' && n.type !== 'req_pending' &&
    (!n.recipient || n.recipient === myEmail || n.recipient === myName)
  );

  // Unread count scoped to what I can see
  const myUnread = [...actionable, ...updates].filter(n => !n.read).length;
  const isEmpty  = actionable.length === 0 && updates.length === 0;

  return (
    <div style={{ position: 'relative' }} ref={panelRef}>
      {/* Bell button */}
      <button
        onClick={handleOpen}
        style={{
          position: 'relative', width: 34, height: 34,
          border: 'none', background: open ? 'var(--mist)' : 'rgba(0,0,0,0.04)',
          borderRadius: 9, color: 'var(--ink)', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          transition: 'background var(--transition-fast)',
        }}
        aria-label="Notifications"
      >
        <Bell style={{ width: 16, height: 16 }} />
        {myUnread > 0 && (
          <span style={{
            position: 'absolute', top: 4, right: 4,
            width: myUnread > 9 ? 16 : 14, height: 14,
            background: 'hsl(var(--color-red))', color: '#fff',
            borderRadius: 999, fontSize: 9, fontWeight: 700,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            lineHeight: 1, fontFamily: 'Inter, sans-serif',
          }}>
            {myUnread > 9 ? '9+' : myUnread}
          </span>
        )}
      </button>

      {/* Panel */}
      {open && (
        <div style={{
          position: 'fixed', top: 64, right: 16,
          width: 360, maxHeight: 'calc(100vh - 80px)',
          background: 'var(--card)', border: '1px solid var(--line)',
          borderRadius: 14, boxShadow: 'var(--shadow-lg)',
          display: 'flex', flexDirection: 'column',
          zIndex: 300, overflow: 'hidden',
          animation: 'fadeInUp 0.18s cubic-bezier(.16,1,.3,1) both',
        }}>

          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px 10px', borderBottom: '1px solid var(--line)', flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--ink)' }}>Notifications</span>
              {unreadCount > 0 && (
                <span style={{ background: 'hsl(var(--color-red))', color: '#fff', borderRadius: 999, fontSize: 10, fontWeight: 700, padding: '1px 6px' }}>
                  {unreadCount}
                </span>
              )}
            </div>
            <div style={{ display: 'flex', gap: 4 }}>
              {unreadCount > 0 && (
                <button onClick={markAllRead} style={{ fontSize: 11, color: 'var(--muted)', background: 'none', border: 'none', cursor: 'pointer', padding: '3px 7px', borderRadius: 6, fontFamily: 'Inter, sans-serif' }}
                  onMouseEnter={e => e.target.style.background='var(--mist)'}
                  onMouseLeave={e => e.target.style.background='none'}>
                  Mark all read
                </button>
              )}
              {notifications.some(n => n.read) && (
                <button onClick={clearRead} style={{ fontSize: 11, color: 'var(--muted)', background: 'none', border: 'none', cursor: 'pointer', padding: '3px 5px', borderRadius: 6, display: 'flex', alignItems: 'center' }}
                  title="Clear read notifications"
                  onMouseEnter={e => e.currentTarget.style.background='var(--mist)'}
                  onMouseLeave={e => e.currentTarget.style.background='none'}>
                  <Trash2 size={13} />
                </button>
              )}
            </div>
          </div>

          {/* Body */}
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {isEmpty && (
              <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
                <Bell size={28} style={{ opacity: 0.25, marginBottom: 10, display: 'block', margin: '0 auto 10px' }} />
                No notifications yet
              </div>
            )}

            {/* Needs Action section */}
            {actionable.length > 0 && (
              <>
                <div style={{ padding: '8px 16px 4px', fontSize: 10, fontWeight: 700, letterSpacing: '.07em', color: 'var(--muted)', textTransform: 'uppercase' }}>
                  Needs Action — {actionable.length}
                </div>
                {actionable.map(n => {
                  const meta = TYPE_META[n.type];
                  const isRejecting = rejectingId === n.id;
                  return (
                    <div key={n.id}
                      style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)', background: n.read ? 'transparent' : 'hsla(var(--color-blue),0.04)' }}
                      onClick={() => markRead(n.id)}>
                      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                        <div style={{ width: 30, height: 30, borderRadius: 8, background: `hsla(${meta.color},0.12)`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                          <meta.icon size={15} color={`hsl(${meta.color})`} />
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 6 }}>
                            <span style={{ fontWeight: 600, fontSize: 12.5, color: 'var(--ink)' }}>{n.title}</span>
                            <span style={{ fontSize: 10.5, color: 'var(--muted)', flexShrink: 0 }}>{timeAgo(n.timestamp)}</span>
                          </div>
                          <p style={{ fontSize: 12, color: 'var(--muted)', margin: '2px 0 8px', lineHeight: 1.4 }}>{n.body}</p>

                          {!isRejecting ? (
                            <div style={{ display: 'flex', gap: 6 }}>
                              <button onClick={e => { e.stopPropagation(); handleAction(n, 'approve'); }}
                                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 12px', borderRadius: 7, border: 'none', background: 'hsla(var(--color-green),0.12)', color: 'hsl(var(--color-green))', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'Inter, sans-serif' }}>
                                <Check size={12} /> Approve
                              </button>
                              <button onClick={e => { e.stopPropagation(); setRejectingId(n.id); setRejectReason(''); }}
                                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 12px', borderRadius: 7, border: 'none', background: 'hsla(var(--color-red),0.10)', color: 'hsl(var(--color-red))', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'Inter, sans-serif' }}>
                                <X size={12} /> Reject
                              </button>
                            </div>
                          ) : (
                            <div onClick={e => e.stopPropagation()}>
                              <input
                                autoFocus
                                className="form-input"
                                style={{ width: '100%', fontSize: 12, marginBottom: 6, padding: '5px 9px' }}
                                placeholder="Reason for rejection…"
                                value={rejectReason}
                                onChange={e => setRejectReason(e.target.value)}
                                onKeyDown={e => { if (e.key === 'Enter') submitReject(n); if (e.key === 'Escape') { setRejectingId(null); setRejectReason(''); } }}
                              />
                              <div style={{ display: 'flex', gap: 5 }}>
                                <button onClick={() => submitReject(n)} disabled={!rejectReason.trim()}
                                  style={{ flex: 1, padding: '4px 0', borderRadius: 6, border: 'none', background: 'hsl(var(--color-red))', color: '#fff', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'Inter, sans-serif', opacity: rejectReason.trim() ? 1 : 0.4 }}>
                                  Confirm Reject
                                </button>
                                <button onClick={() => { setRejectingId(null); setRejectReason(''); }}
                                  style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid var(--line)', background: 'none', color: 'var(--muted)', fontSize: 11.5, cursor: 'pointer', fontFamily: 'Inter, sans-serif' }}>
                                  Cancel
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                        {!n.read && <div style={{ width: 7, height: 7, borderRadius: '50%', background: 'hsl(var(--color-blue))', flexShrink: 0, marginTop: 4 }} />}
                      </div>
                    </div>
                  );
                })}
              </>
            )}

            {/* Updates section */}
            {updates.length > 0 && (
              <>
                <div style={{ padding: '8px 16px 4px', fontSize: 10, fontWeight: 700, letterSpacing: '.07em', color: 'var(--muted)', textTransform: 'uppercase' }}>
                  Updates — {updates.length}
                </div>
                {updates.map(n => {
                  const meta = TYPE_META[n.type] ?? TYPE_META['approved'];
                  return (
                    <div key={n.id}
                      style={{ padding: '10px 16px', borderBottom: '1px solid var(--line)', display: 'flex', gap: 10, alignItems: 'flex-start', background: n.read ? 'transparent' : 'hsla(var(--color-blue),0.04)', cursor: 'pointer', opacity: n.read ? 0.65 : 1 }}
                      onClick={() => { markRead(n.id); }}>
                      <div style={{ width: 28, height: 28, borderRadius: 7, background: `hsla(${meta.color},0.12)`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <meta.icon size={13} color={`hsl(${meta.color})`} />
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
                          <span style={{ fontWeight: 600, fontSize: 12.5, color: 'var(--ink)' }}>{n.title}</span>
                          <span style={{ fontSize: 10.5, color: 'var(--muted)', flexShrink: 0 }}>{timeAgo(n.timestamp)}</span>
                        </div>
                        <p style={{ fontSize: 12, color: 'var(--muted)', margin: '2px 0 0', lineHeight: 1.4 }}>{n.body}</p>
                        {n.action && onNavigate && (
                          <button
                            onClick={e => { e.stopPropagation(); markRead(n.id); setOpen(false); onNavigate(n.action.view, n.action.sub); }}
                            style={{ marginTop: 6, background: 'none', border: 'none', padding: 0, fontSize: 11.5, fontWeight: 600, color: 'hsl(var(--color-blue))', cursor: 'pointer', fontFamily: 'Inter, sans-serif', letterSpacing: '.01em' }}>
                            {n.action.label}
                          </button>
                        )}
                      </div>
                      <button onClick={e => { e.stopPropagation(); dismiss(n.id); }}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', padding: 2, borderRadius: 4, flexShrink: 0 }}>
                        <X size={12} />
                      </button>
                    </div>
                  );
                })}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

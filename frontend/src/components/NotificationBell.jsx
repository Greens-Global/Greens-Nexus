import { useState, useRef, useEffect } from 'react';
import { Bell, CheckCircle, XCircle, Package, ShoppingCart, RotateCcw, Check, X, Trash2, Loader2 } from 'lucide-react';
import { useNotifications } from '../contexts/NotificationContext';
import { useInventory }      from '../contexts/InventoryContext';
import { useRequisitions }   from '../contexts/RequisitionContext';
import { useMsal }           from '@azure/msal-react';
import { useRole }           from '../contexts/RoleContext';
import { api }               from '../api';

// Read "Updates" auto-clear after this long so the panel doesn't pile up with
// things you've already seen and acted on — "Needs Action" items are exempt
// since they still require a decision.
const AUTO_DISMISS_MS = 6000;

// Resolved dynamically from MSAL account — see myName below

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
  inv_request:     { icon: Package,      label: 'Inventory Request',    color: 'var(--color-blue)'   },
  req_pending:     { icon: ShoppingCart, label: 'Purchase Requisition', color: 'var(--color-orange)' },
  item_returned:   { icon: RotateCcw,    label: 'Item Returned',        color: 'var(--color-green)'  },
  allocate_request:{ icon: Package,      label: 'Allocation Needed',    color: 'var(--color-orange)' },
  allocated:       { icon: CheckCircle,  label: 'Item Allocated',       color: 'var(--color-green)'  },
  approved:        { icon: CheckCircle,  label: 'Request Approved',     color: 'var(--color-green)'  },
  rejected:        { icon: XCircle,      label: 'Request Rejected',     color: 'var(--color-red)'    },
};

export default function NotificationBell({ onNavigate }) {
  const { notifications, unreadCount, markRead, markAllRead, dismiss, clearRead, addNotification, markActioned, pendingApprovalId, clearPendingApproval } = useNotifications();
  const { approveRequest, rejectRequest, allocateItem, requests: invRequests } = useInventory();
  const { approveRequisition, rejectRequisition }   = useRequisitions();
  const { accounts } = useMsal();
  const { can }      = useRole();
  const myName  = accounts[0]?.name     ?? '';
  const myEmail = (accounts[0]?.username ?? '').toLowerCase();

  const [open,           setOpen]           = useState(false);
  const [rejectingId,    setRejectingId]    = useState(null);
  const [rejectReason,   setRejectReason]   = useState('');
  const [allocatingId,   setAllocatingId]   = useState(null);
  const [approvingId,    setApprovingId]    = useState(null);
  const [pickedAllocator,setPickedAllocator]= useState('');
  const [approvingBusy,  setApprovingBusy]  = useState(false);
  const [allocators,     setAllocators]     = useState([]);
  // Tracks "Needs Action" cards that just got approved/rejected — they show a
  // brief confirmation (checkmark + message) then collapse out of the list,
  // instead of vanishing instantly. { [notifId]: { kind, collapsing } }
  const [resolvedIds,    setResolvedIds]    = useState({});
  const panelRef = useRef(null);
  const dismissTimers = useRef({});
  const resolveTimers = useRef({});

  useEffect(() => {
    function onClickOut(e) {
      if (panelRef.current && !panelRef.current.contains(e.target)) setOpen(false);
    }
    if (open) document.addEventListener('mousedown', onClickOut);
    return () => document.removeEventListener('mousedown', onClickOut);
  }, [open]);

  // Who an approval can be handed off to — needed here too since approving an
  // inventory request now requires picking an allocator up front (the backend
  // rejects approvals with no assigned_allocator_email).
  useEffect(() => {
    if (!can('manager')) return;
    api.getInventoryAllocators().then(setAllocators).catch(() => {});
  }, [can]);

  // Clean up any pending auto-dismiss timers on unmount
  useEffect(() => () => {
    Object.values(dismissTimers.current).forEach(clearTimeout);
    Object.values(resolveTimers.current).forEach(clearTimeout);
  }, []);

  function handleOpen() {
    setOpen(o => !o);
  }

  // Replaces an instant markActioned+dismiss with a brief "Approved ✓ /
  // Rejected" confirmation on the card, then a smooth collapse-and-slide-out —
  // gives the manager visual confirmation their action landed before it clears.
  function resolveAndDismiss(n, kind) {
    setResolvedIds(prev => ({ ...prev, [n.id]: { kind, collapsing: false } }));
    resolveTimers.current[`${n.id}-collapse`] = setTimeout(() => {
      setResolvedIds(prev => prev[n.id] ? { ...prev, [n.id]: { ...prev[n.id], collapsing: true } } : prev);
    }, 550);
    resolveTimers.current[n.id] = setTimeout(() => {
      dismiss(n.id);
      setResolvedIds(prev => {
        const next = { ...prev };
        delete next[n.id];
        return next;
      });
      delete resolveTimers.current[n.id];
      delete resolveTimers.current[`${n.id}-collapse`];
    }, 950);
  }

  function handleAction(n, action) {
    const refId       = n.refId       ?? '';
    const itemName    = n.itemName    ?? 'the item';
    const requestedBy = n.requestedBy ?? '';

    if (n.type === 'inv_request') {
      if (action === 'approve') {
        // Approving now requires picking who'll physically hand the item over —
        // open the inline allocator picker instead of approving outright.
        setApprovingId(n.id);
        setPickedAllocator('');
        setRejectingId(null);
      } else { setRejectingId(n.id); setApprovingId(null); }
    } else if (n.type === 'req_pending') {
      if (action === 'approve') {
        approveRequisition(refId, myName);
        markActioned(n.id);
        resolveAndDismiss(n, 'approved');
        addNotification({ type: 'approved', recipient: requestedBy, requestedBy, itemName,
          title: 'Requisition Approved ✓',
          body:  `Your purchase requisition has been approved by ${myName}. Your supervisor will allocate the asset to you.`,
        });
      } else { setRejectingId(n.id); }
    }
  }

  // Confirms an inventory approval once a name has been picked from the
  // allocator dropdown — assigns the request to them and notifies both sides.
  function submitApprove(n) {
    const chosen = allocators.find(a => a.email === pickedAllocator);
    if (!chosen) return;
    const refId       = n.refId       ?? '';
    const itemName    = n.itemName    ?? 'the item';
    const requestedBy = n.requestedBy ?? '';
    const invReq      = invRequests.find(r => r.id === refId);
    const recipientEmail = n.action?.requestedByEmail ?? invReq?.requestedByEmail ?? '';

    setApprovingBusy(true);
    approveRequest(refId, myName, chosen.email, chosen.name)
      .then(() => {
        markActioned(n.id);
        resolveAndDismiss(n, 'approved');
        addNotification({
          type:        'approved',
          recipient:   recipientEmail || requestedBy,
          requestedBy, itemName,
          title: 'Request Approved ✓',
          body:  `Your request for ${itemName} has been approved by ${myName}. It will be assigned to you by your supervisor shortly.`,
          action: { label: 'Track Request →', view: 'inventory', sub: 'my-requests' },
        });
        addNotification({
          type:        'allocate_request',
          recipient:   chosen.email,
          refId,
          itemName,
          requestedBy,
          title:       'Allocate an Item',
          body:        `${myName} approved ${requestedBy}'s request for ${itemName} and assigned it to you to hand over.`,
          action:      { label: 'Allocate Now →', kind: 'allocate' },
        });
        setApprovingId(null);
        setPickedAllocator('');
      })
      .catch(() => {})
      .finally(() => setApprovingBusy(false));
  }

  function submitReject(n) {
    if (!rejectReason.trim()) return;
    const refId       = n.refId       ?? '';
    const itemName    = n.itemName    ?? 'the item';
    const requestedBy = n.requestedBy ?? '';

    if (n.type === 'inv_request') {
      rejectRequest(refId, myName, rejectReason.trim());
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
      rejectRequisition(refId, myName, rejectReason.trim());
      addNotification({ type: 'rejected', recipient: requestedBy, requestedBy, itemName,
        title: 'Requisition Rejected',
        body:  `Your purchase requisition was not approved. Reason: "${rejectReason.trim()}"`,
      });
    }
    markActioned(n.id);
    resolveAndDismiss(n, 'rejected');
    setRejectingId(null);
    setRejectReason('');
  }

  // Lets the assigned allocator hand the item over directly from the bell —
  // no need to navigate to Inventory Management first.
  function handleInlineAllocate(n) {
    const refId = n.refId ?? '';
    if (!refId || allocatingId) return;
    setAllocatingId(n.id);
    allocateItem(refId, myName).then(() => {
      markActioned(n.id);
      dismiss(n.id);
      const invReq = invRequests.find(r => r.id === refId);
      addNotification({
        type:        'allocated',
        recipient:   invReq?.requestedByEmail || invReq?.requestedBy || n.requestedBy || '',
        refId,
        itemName:    n.itemName ?? invReq?.itemName ?? 'the item',
        title:       'Item Allocated ✓',
        body:        `Your ${n.itemName ?? invReq?.itemName ?? 'item'} has been allocated and is ready for collection. Please pick it up from your supervisor.`,
        action:      { label: 'Track Request →', view: 'inventory', sub: 'my-requests' },
      });
    }).catch(() => {}).finally(() => setAllocatingId(null));
  }

  // Marks an "Updates" notification as read and schedules it to quietly drop
  // out of the list shortly after — informational items shouldn't linger once
  // you've seen them (unlike "Needs Action", which stays until resolved).
  function handleUpdateClick(n) {
    markRead(n.id);
    if (n.read || dismissTimers.current[n.id]) return;
    dismissTimers.current[n.id] = setTimeout(() => {
      dismiss(n.id);
      delete dismissTimers.current[n.id];
    }, AUTO_DISMISS_MS);
  }

  // Needs Action: only visible to managers+ (they have approve/reject capability)
  const actionable = can('manager') ? notifications.filter(n =>
    (n.type === 'inv_request' || n.type === 'req_pending') && !n.recipient && !n.actioned
  ) : [];

  // A toast click set this to a notification id — open the panel straight into
  // its approval workflow (allocator picker for inv_request, reject reason for
  // requisitions) instead of just opening the list and making the user hunt.
  useEffect(() => {
    if (!pendingApprovalId) return;
    const n = actionable.find(x => x.id === pendingApprovalId);
    if (!n) { clearPendingApproval(); return; }
    setOpen(true);
    handleAction(n, 'approve');
    markRead(n.id);
    clearPendingApproval();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingApprovalId]);

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
                <button onClick={() => { markAllRead(); updates.filter(n => !n.read).forEach(handleUpdateClick); }} style={{ fontSize: 11, color: 'var(--muted)', background: 'none', border: 'none', cursor: 'pointer', padding: '3px 7px', borderRadius: 6, fontFamily: 'Inter, sans-serif' }}
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
                  const isApproving = approvingId === n.id;
                  const resolution  = resolvedIds[n.id];
                  const resolvedColor = resolution?.kind === 'approved' ? 'var(--color-green)' : 'var(--color-red)';
                  return (
                    <div key={n.id} style={{
                      overflow: 'hidden',
                      transition: 'max-height 0.4s cubic-bezier(.16,1,.3,1), opacity 0.32s ease, transform 0.36s cubic-bezier(.16,1,.3,1)',
                      maxHeight: resolution?.collapsing ? 0 : 220,
                      opacity: resolution?.collapsing ? 0 : 1,
                      transform: resolution?.collapsing ? 'translateX(28px) scale(0.97)' : 'translateX(0) scale(1)',
                    }}>
                    <div
                      style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)', background: resolution ? `hsla(${resolvedColor},0.07)` : (n.read ? 'transparent' : 'hsla(var(--color-blue),0.04)'), transition: 'background 0.3s ease' }}
                      onClick={() => !resolution && markRead(n.id)}>
                      {resolution ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '3px 0' }}>
                          <div style={{ width: 30, height: 30, borderRadius: 8, background: `hsla(${resolvedColor},0.15)`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, animation: 'fadeInUp 0.22s cubic-bezier(.16,1,.3,1) both' }}>
                            {resolution.kind === 'approved'
                              ? <CheckCircle size={16} color={`hsl(${resolvedColor})`} />
                              : <XCircle size={16} color={`hsl(${resolvedColor})`} />}
                          </div>
                          <span style={{ fontSize: 12.5, fontWeight: 600, color: `hsl(${resolvedColor})`, animation: 'fadeInUp 0.22s cubic-bezier(.16,1,.3,1) both' }}>
                            {resolution.kind === 'approved' ? 'Approved — clearing…' : 'Rejected — clearing…'}
                          </span>
                        </div>
                      ) : (
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

                          {!isRejecting && !isApproving ? (
                            <div style={{ display: 'flex', gap: 6 }}>
                              <button onClick={e => { e.stopPropagation(); handleAction(n, 'approve'); }}
                                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 12px', borderRadius: 7, border: 'none', background: 'hsla(var(--color-green),0.12)', color: 'hsl(var(--color-green))', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'Inter, sans-serif' }}>
                                <Check size={12} /> Approve
                              </button>
                              <button onClick={e => { e.stopPropagation(); setRejectingId(n.id); setRejectReason(''); setApprovingId(null); }}
                                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 12px', borderRadius: 7, border: 'none', background: 'hsla(var(--color-red),0.10)', color: 'hsl(var(--color-red))', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'Inter, sans-serif' }}>
                                <X size={12} /> Reject
                              </button>
                            </div>
                          ) : isApproving ? (
                            <div onClick={e => e.stopPropagation()}>
                              {n.type === 'inv_request' ? (
                                <>
                                  <p style={{ fontSize: 11.5, color: 'hsl(var(--color-green))', fontWeight: 600, margin: '0 0 6px' }}>Who should hand this item over to {n.requestedBy}?</p>
                                  <select
                                    autoFocus
                                    className="form-input"
                                    style={{ width: '100%', fontSize: 12, marginBottom: 6, padding: '5px 9px' }}
                                    value={pickedAllocator}
                                    onChange={e => setPickedAllocator(e.target.value)}>
                                    <option value="">Select a person…</option>
                                    {allocators.map(a => (
                                      <option key={a.email} value={a.email}>{a.name}</option>
                                    ))}
                                  </select>
                                  <div style={{ display: 'flex', gap: 5 }}>
                                    <button onClick={() => submitApprove(n)} disabled={!pickedAllocator || approvingBusy}
                                      style={{ flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5, padding: '4px 0', borderRadius: 6, border: 'none', background: 'hsl(var(--color-green))', color: '#fff', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'Inter, sans-serif', opacity: pickedAllocator && !approvingBusy ? 1 : 0.4 }}>
                                      {approvingBusy ? <><Loader2 size={12} style={{ animation: 'spin 0.7s linear infinite' }} /> Approving…</> : 'Confirm Approval'}
                                    </button>
                                    <button onClick={() => { setApprovingId(null); setPickedAllocator(''); }} disabled={approvingBusy}
                                      style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid var(--line)', background: 'none', color: 'var(--muted)', fontSize: 11.5, cursor: 'pointer', fontFamily: 'Inter, sans-serif' }}>
                                      Cancel
                                    </button>
                                  </div>
                                </>
                              ) : null}
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
                      )}
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
                      onClick={() => handleUpdateClick(n)}>
                      <div style={{ width: 28, height: 28, borderRadius: 7, background: `hsla(${meta.color},0.12)`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <meta.icon size={13} color={`hsl(${meta.color})`} />
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
                          <span style={{ fontWeight: 600, fontSize: 12.5, color: 'var(--ink)' }}>{n.title}</span>
                          <span style={{ fontSize: 10.5, color: 'var(--muted)', flexShrink: 0 }}>{timeAgo(n.timestamp)}</span>
                        </div>
                        <p style={{ fontSize: 12, color: 'var(--muted)', margin: '2px 0 0', lineHeight: 1.4 }}>{n.body}</p>
                        {n.action && n.action.kind === 'allocate' && (
                          <button
                            onClick={e => { e.stopPropagation(); handleInlineAllocate(n); }}
                            disabled={allocatingId === n.id}
                            style={{ marginTop: 6, background: 'none', border: 'none', padding: 0, fontSize: 11.5, fontWeight: 600, color: 'hsl(var(--color-orange))', cursor: allocatingId === n.id ? 'default' : 'pointer', opacity: allocatingId === n.id ? 0.6 : 1, fontFamily: 'Inter, sans-serif', letterSpacing: '.01em' }}>
                            {allocatingId === n.id ? 'Allocating…' : n.action.label}
                          </button>
                        )}
                        {n.action && n.action.kind !== 'allocate' && onNavigate && (
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

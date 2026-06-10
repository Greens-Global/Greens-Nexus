import { useState, useRef, useEffect } from 'react';
import { Bell, CheckCircle, XCircle, Package, ShoppingCart, RotateCcw, Check, X, Trash2, Loader2, AlertCircle, User, Clock } from 'lucide-react';
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
  inv_request:      { icon: Package,      label: 'Inventory Request',    color: 'var(--color-blue)'   },
  req_pending:      { icon: ShoppingCart, label: 'Purchase Requisition', color: 'var(--color-orange)' },
  checkout_pending: { icon: ShoppingCart, label: 'Checkout Request',     color: 'var(--color-orange)' },
  item_returned:    { icon: RotateCcw,    label: 'Item Returned',        color: 'var(--color-green)'  },
  allocate_request: { icon: Package,      label: 'Allocation Needed',    color: 'var(--color-orange)' },
  allocated:        { icon: CheckCircle,  label: 'Item Allocated',       color: 'var(--color-green)'  },
  approved:         { icon: CheckCircle,  label: 'Request Approved',     color: 'var(--color-green)'  },
  rejected:         { icon: XCircle,      label: 'Request Rejected',     color: 'var(--color-red)'    },
  custom_alert:     { icon: AlertCircle,  label: 'Alert',                color: 'var(--color-orange)' },
  extension_pending:  { icon: Clock,       label: 'Extension Request',    color: 'var(--color-blue)'   },
  extension_resolved: { icon: CheckCircle, label: 'Extension Update',     color: 'var(--color-green)'  },
};

// Short stage labels/colors for chips on cards and the lifecycle "trail" strip
// that collapses Approved → Allocated → Returned into one evolving card.
const STAGE_META = {
  inv_request:      { label: 'Requested',  color: 'var(--color-blue)'   },
  req_pending:      { label: 'Requested',  color: 'var(--color-orange)' },
  checkout_pending: { label: 'Pending',    color: 'var(--color-orange)' },
  approved:         { label: 'Approved',   color: 'var(--color-green)'  },
  allocate_request: { label: 'Allocating', color: 'var(--color-orange)' },
  allocated:        { label: 'In Use',     color: 'var(--color-green)'  },
  item_returned:    { label: 'Returned',   color: 'var(--color-blue)'   },
  rejected:         { label: 'Rejected',   color: 'var(--color-red)'    },
};

// Collapses notifications that share a refId (the same request moving through
// Approved → Allocated → Returned) into one card: the latest stage is shown in
// full, earlier stages become a compact progression strip above it.
function groupByRequest(list) {
  const groups = new Map();
  const order  = [];
  for (const n of list) {
    const key = n.refId || n.id;
    if (!groups.has(key)) { groups.set(key, []); order.push(key); }
    groups.get(key).push(n);
  }
  return order.map(key => {
    const items = groups.get(key).slice().sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    return { key, primary: items[items.length - 1], trail: items.slice(0, -1) };
  });
}

export default function NotificationBell({ onNavigate }) {
  const { notifications, unreadCount, markRead, markAllRead, dismiss, addNotification, markActioned, pendingApprovalId, clearPendingApproval } = useNotifications();
  const { approveRequest, rejectRequest, allocateItem, requests: invRequests, requestsLoading: invRequestsLoading, refreshRequests: refreshInvRequests } = useInventory();
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
  // Per-notification approve/reject failure messages — surfaced inline so a
  // failed action doesn't just silently snap back to the idle form with no
  // explanation (e.g. someone else already resolved the request first).
  const [actionError,    setActionError]    = useState({});
  const dismissTimers = useRef({});
  const resolveTimers = useRef({});

  // Slide-over drawer (matches Access Manager / My Requests): close on ESC,
  // lock page scroll while open — backdrop click closes it too.
  useEffect(() => {
    if (!open) return;
    const handler = e => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open]);

  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
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

  // Auto-action checkout_pending notifications that are no longer relevant —
  // i.e. the checkout was handled directly in the Checkouts tab (not via the bell),
  // so there are no more pending checkouts for that order/id.
  useEffect(() => {
    if (!can('manager')) return;
    // Never judge from an empty/loading checkout list — on first load invRequests
    // is [] and every pending notification would be wrongly cleared for good.
    if (invRequestsLoading || !invRequests.length) return;
    notifications.forEach(n => {
      if (n.type !== 'checkout_pending' || (n.recipient && n.recipient !== myEmail) || n.actioned) return;
      const refId = n.refId ?? '';
      if (!refId) return;
      // Grace period: a fresh notification can arrive (realtime) before the
      // checkout poll knows about the new order — judging against that stale
      // list wrongly cleared brand-new requests. Give the data 90s to catch up.
      const ageMs = Date.now() - new Date(n.timestamp).getTime();
      if (!Number.isFinite(ageMs) || ageMs < 90_000) return;
      const stillPending = invRequests.some(c =>
        c.status === 'pending' && (c.orderId === refId || c.id === refId)
      );
      if (!stillPending) markActioned(n.id);
    });
  }, [notifications, invRequests, invRequestsLoading]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleOpen() {
    setOpen(o => !o);
  }

  // Translates a thrown API error into something a manager can act on —
  // e.g. "already resolved" beats a bare "API error 409" or a silent failure.
  function friendlyActionError(err) {
    if (err?.status === 409) return 'This request was already resolved (likely by someone else) — refresh to see its current status.';
    if (err?.status === 403) return "You don't have permission to do that.";
    if (err?.status === 400 && err?.detail) return err.detail;
    return "Couldn't go through — please try again.";
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

  function clearActionError(id) {
    setActionError(prev => {
      if (!(id in prev)) return prev;
      const next = { ...prev }; delete next[id]; return next;
    });
  }

  function handleAction(n, action) {
    const refId       = n.refId       ?? '';
    const itemName    = n.itemName    ?? 'the item';
    const requestedBy = n.requestedBy ?? '';

    // New Items checkout pending — needs allocator picker before approving
    if (n.type === 'checkout_pending' || n.type === 'inv_request') {
      if (action === 'approve') {
        setApprovingId(n.id);
        setPickedAllocator('');
        setRejectingId(null);
        clearActionError(n.id);
      } else {
        setRejectingId(n.id);
        setApprovingId(null);
        clearActionError(n.id);
      }
    } else if (n.type === 'req_pending') {
      // Purchase requisition
      if (action === 'approve') {
        approveRequisition(refId, myName);
        markActioned(n.id);
        resolveAndDismiss(n, 'approved');
        addNotification({ type: 'approved', recipient: requestedBy, requestedBy, itemName,
          title: 'Requisition Approved ✓',
          body:  `Your purchase requisition has been approved by ${myName}. Your supervisor will allocate the asset to you.`,
        });
      } else { setRejectingId(n.id); }
    } else if (n.type === 'extension_pending') {
      // Item extension request — no allocator needed; resolve straight away.
      // Backend adds the days, notifies the employee and actions this notification.
      if (action === 'approve') {
        clearActionError(n.id);
        api.resolveItemExtension(refId, { action: 'approve' })
          .then(() => {
            markActioned(n.id);
            resolveAndDismiss(n, 'approved');
            refreshInvRequests && refreshInvRequests();
          })
          .catch(err => setActionError(prev => ({ ...prev, [n.id]: friendlyActionError(err) })));
      } else {
        setRejectingId(n.id);
        setApprovingId(null);
        clearActionError(n.id);
      }
    }
  }

  // Confirms approval once an allocator has been picked.
  // checkout_pending: backend fires approved + allocate_request notifications automatically.
  // inv_request (old system): we fire them manually via addNotification.
  function submitApprove(n) {
    const chosen = allocators.find(a => a.email === pickedAllocator);
    if (!chosen) return;
    const refId       = n.refId       ?? '';
    const itemName    = n.itemName    ?? 'the item';
    const requestedBy = n.requestedBy ?? '';

    // For checkout_pending: ref_id may be an order_id (cart) or single checkout_id.
    // Find all pending checkouts that share this ref so cart orders all get approved.
    const targets = (n.type === 'checkout_pending')
      ? invRequests.filter(c => c.status === 'pending' && (c.orderId === refId || c.id === refId))
      : null;

    if (n.type === 'checkout_pending' && (!targets || !targets.length)) {
      setActionError(prev => ({ ...prev, [n.id]: 'Request not found — it may have already been processed. Refresh to see the latest state.' }));
      return;
    }

    setApprovingBusy(true);
    clearActionError(n.id);

    // Sequential (not Promise.all) so the backend batches the order's
    // notifications into one instead of racing into per-item duplicates.
    const approveAll = targets
      ? (async () => {
          const results = [];
          for (const c of targets) {
            try { results.push({ status: 'fulfilled', value: await approveRequest(c.id, myName, chosen.email, chosen.name) }); }
            catch (e) { results.push({ status: 'rejected', reason: e }); }
          }
          return results;
        })()
      : approveRequest(refId, myName, chosen.email, chosen.name).then(r => [{ status: 'fulfilled', value: r }]).catch(e => [{ status: 'rejected', reason: e }]);

    approveAll
      .then(results => {
        const anySucceeded = results.some(r => r.status === 'fulfilled');
        const firstFailure = results.find(r => r.status === 'rejected');

        if (anySucceeded) {
          markActioned(n.id);
          resolveAndDismiss(n, 'approved');
          // Old inventory system: manually push notifications (backend doesn't do it)
          if (n.type === 'inv_request') {
            const invReq = invRequests.find(r => r.id === refId);
            const recipientEmail = n.action?.requestedByEmail ?? invReq?.requestedByEmail ?? '';
            addNotification({
              type: 'approved', recipient: recipientEmail || requestedBy,
              requestedBy, itemName,
              title: 'Request Approved ✓',
              body:  `Your request for ${itemName} has been approved by ${myName}. It will be assigned to you by your supervisor shortly.`,
              action: { label: 'Track Request →', view: 'inventory', sub: 'my-requests' },
            });
            addNotification({
              type: 'allocate_request', recipient: chosen.email, refId, itemName, requestedBy,
              title: 'Allocate an Item',
              body:  `${myName} approved ${requestedBy}'s request for ${itemName} and assigned it to you to hand over.`,
              action: { label: 'Allocate Now →', kind: 'allocate' },
            });
          }
          setApprovingId(null);
          setPickedAllocator('');
        }
        if (!anySucceeded && firstFailure) {
          setActionError(prev => ({ ...prev, [n.id]: friendlyActionError(firstFailure.reason) }));
        }
      })
      .finally(() => setApprovingBusy(false));
  }

  function submitReject(n) {
    if (!rejectReason.trim()) return;
    const refId       = n.refId       ?? '';
    const itemName    = n.itemName    ?? 'the item';
    const requestedBy = n.requestedBy ?? '';

    if (n.type === 'extension_pending') {
      api.resolveItemExtension(refId, { action: 'reject', note: rejectReason.trim() })
        .then(() => refreshInvRequests && refreshInvRequests())
        .catch(() => {});
    } else if (n.type === 'checkout_pending') {
      // For cart orders, ref_id = order_id; find all pending checkouts under it.
      // Sequential so the backend batches the order's rejection notifications into one.
      const targets = invRequests.filter(c =>
        c.status === 'pending' && (c.orderId === refId || c.id === refId)
      );
      (async () => {
        for (const c of (targets.length ? targets : [{ id: refId }])) {
          try { await api.updateItemCheckout(c.id, { status: 'rejected', resolved_by: myName, reject_reason: rejectReason.trim() }); }
          catch { /* keep going */ }
        }
        refreshInvRequests && refreshInvRequests();
      })();
    } else if (n.type === 'inv_request') {
      rejectRequest(refId, myName, rejectReason.trim());
      const invReq = invRequests.find(r => r.id === refId);
      const recipientEmail = n.action?.requestedByEmail ?? invReq?.requestedByEmail ?? '';
      addNotification({
        type: 'rejected', recipient: recipientEmail || requestedBy,
        requestedBy, itemName,
        title: 'Request Rejected',
        body:  `Your request for ${itemName} was not approved. Reason: "${rejectReason.trim()}"`,
        action: { label: 'View Request →', view: 'inventory', sub: 'my-requests' },
      });
    } else if (n.type === 'req_pending') {
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

  // Where each notification type lives in the app — clicking a card marks it
  // read and takes you there. Cards are never auto-dismissed on click; the
  // header's "Clear all" (or the per-card ×) is the only way to remove them.
  function destinationFor(n) {
    switch (n.type) {
      case 'checkout_pending':
      case 'extension_pending':
      case 'allocate_request':
      case 'item_returned':
        return ['inventory', 'checkouts'];   // manager / allocator work queue
      case 'approved':
      case 'rejected':
      case 'allocated':
      case 'extension_resolved':
        return ['inventory', 'myitems'];     // the requester's own items
      case 'req_pending':
        return ['purchase', null];
      default:
        return n.action?.view ? [n.action.view, n.action.sub] : null;
    }
  }

  function handleUpdateClick(n) {
    markRead(n.id);
    const dest = destinationFor(n);
    if (dest) {
      setOpen(false);
      // Window event instead of onNavigate: App navigates on it AND the target
      // view's own listener switches its internal tab even when the app-level
      // view/sub didn't change (repeat clicks on the same destination).
      window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: dest[0], sub: dest[1] } }));
    }
  }

  // Needs Action: only visible to managers+
  // checkout_pending = new Items module; inv_request/req_pending = older systems
  const ACTIONABLE_TYPES = new Set(['inv_request', 'req_pending', 'checkout_pending', 'extension_pending']);
  // Broadcast (no recipient) or addressed to me — checkout requests are now
  // targeted at the manager the employee picked at checkout.
  const actionableRaw = can('manager') ? notifications.filter(n =>
    ACTIONABLE_TYPES.has(n.type) && (!n.recipient || n.recipient === myEmail) && !n.actioned
  ) : [];
  // Deduplicate by refId — parallel cart submissions can create N notifications for one order
  const seenRefs = new Set();
  const actionable = actionableRaw.filter(n => {
    const key = n.refId || n.id;
    if (seenRefs.has(key)) return false;
    seenRefs.add(key);
    return true;
  });

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

  // Updates: everything that isn't an actionable type, scoped to me or broadcast.
  // item_returned with no recipient is manager-only — skip for employees to avoid
  // broadcasting someone else's return into every user's bell.
  const updates = notifications.filter(n =>
    !ACTIONABLE_TYPES.has(n.type) &&
    (!n.recipient || n.recipient === myEmail || n.recipient === myName) &&
    !(n.type === 'item_returned' && !n.recipient && !can('manager'))
  );

  // Unread count scoped to what I can see
  const myUnread = [...actionable, ...updates].filter(n => !n.read).length;
  const isEmpty  = actionable.length === 0 && updates.length === 0;

  return (
    <>
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

      {/* Backdrop */}
      <div onClick={() => setOpen(false)} style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
        zIndex: 1200, opacity: open ? 1 : 0, pointerEvents: open ? 'auto' : 'none',
        transition: 'opacity 0.25s ease',
      }} />

      {/* Drawer — mirrors My Requests / Access Manager so the panel slides in from the side */}
      <div style={{
        position: 'fixed', top: 0, right: 0, height: '100vh',
        width: 'min(560px, 94vw)',
        background: 'var(--card)',
        boxShadow: '-12px 0 48px rgba(0,0,0,0.22)',
        zIndex: 1201,
        display: 'flex', flexDirection: 'column',
        transform: open ? 'translateX(0)' : 'translateX(100%)',
        transition: 'transform 0.28s cubic-bezier(0.4, 0, 0.2, 1)',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', padding: '20px 24px', borderBottom: '1px solid var(--line)', gap: 14, flexShrink: 0 }}>
          <div style={{ width: 40, height: 40, borderRadius: 11, background: 'hsla(var(--color-blue),0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Bell size={19} style={{ color: 'hsl(var(--color-blue))' }} />
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--ink)' }}>Notifications</div>
            <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 1 }}>
              {isEmpty ? 'All caught up' : `${actionable.length ? `${actionable.length} need${actionable.length === 1 ? 's' : ''} action · ` : ''}${updates.length} update${updates.length !== 1 ? 's' : ''}`}
            </div>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            {myUnread > 0 && (
              <button onClick={markAllRead}
                style={{ fontSize: 12.5, color: 'hsl(var(--color-blue))', background: 'none', border: 'none', cursor: 'pointer', padding: '7px 12px', borderRadius: 8, fontFamily: 'Inter, sans-serif', fontWeight: 600 }}
                onMouseEnter={e => e.currentTarget.style.background='var(--mist)'}
                onMouseLeave={e => e.currentTarget.style.background='none'}>
                Mark all read
              </button>
            )}
            {updates.length > 0 && (
              <button onClick={() => { markAllRead(); updates.forEach(n => dismiss(n.id)); }}
                style={{ fontSize: 12.5, color: 'var(--muted)', background: 'none', border: 'none', cursor: 'pointer', padding: '7px 12px', borderRadius: 8, fontFamily: 'Inter, sans-serif', fontWeight: 600 }}
                onMouseEnter={e => e.currentTarget.style.background='var(--mist)'}
                onMouseLeave={e => e.currentTarget.style.background='none'}>
                Clear all
              </button>
            )}
            <button onClick={() => setOpen(false)} aria-label="Close" title="Close"
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', padding: 8, borderRadius: 8, display: 'flex', flexShrink: 0 }}>
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {isEmpty && (
            <div style={{ padding: '64px 24px', textAlign: 'center', color: 'var(--muted)', fontSize: 14 }}>
              <Bell size={36} style={{ opacity: 0.22, marginBottom: 14, display: 'block', margin: '0 auto 14px' }} />
              No notifications yet
            </div>
          )}

          {/* Needs Action */}
          {actionable.length > 0 && (
            <>
              <div style={{ padding: '16px 24px 8px', fontSize: 11.5, fontWeight: 700, letterSpacing: '.07em', color: 'var(--muted)', textTransform: 'uppercase' }}>
                Needs Action — {actionable.length}
              </div>
              {actionable.map(n => {
                const meta = TYPE_META[n.type];
                const isRejecting = rejectingId === n.id;
                const isApproving = approvingId === n.id;
                const resolution  = resolvedIds[n.id];
                const resolvedColor = resolution?.kind === 'approved' ? 'var(--color-green)' : 'var(--color-red)';
                const invReq = n.type === 'inv_request' ? invRequests.find(r => r.id === n.refId) : null;
                const days   = n.action?.days ?? invReq?.days;
                const stage  = STAGE_META[n.type];
                return (
                  <div key={n.id} style={{
                    overflow: 'hidden',
                    transition: 'max-height 0.4s cubic-bezier(.16,1,.3,1), opacity 0.32s ease, transform 0.36s cubic-bezier(.16,1,.3,1)',
                    maxHeight: resolution?.collapsing ? 0 : 380,
                    opacity: resolution?.collapsing ? 0 : 1,
                    transform: resolution?.collapsing ? 'translateX(28px) scale(0.97)' : 'translateX(0) scale(1)',
                  }}>
                  <div
                    style={{ padding: '18px 24px', borderBottom: '1px solid var(--line)', background: resolution ? `hsla(${resolvedColor},0.07)` : (n.read ? 'transparent' : 'hsla(var(--color-blue),0.04)'), transition: 'background 0.3s ease' }}
                    onClick={() => !resolution && markRead(n.id)}>
                    {resolution ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 0' }}>
                        <div style={{ width: 38, height: 38, borderRadius: 10, background: `hsla(${resolvedColor},0.15)`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, animation: 'fadeInUp 0.22s cubic-bezier(.16,1,.3,1) both' }}>
                          {resolution.kind === 'approved'
                            ? <CheckCircle size={19} color={`hsl(${resolvedColor})`} />
                            : <XCircle size={19} color={`hsl(${resolvedColor})`} />}
                        </div>
                        <span style={{ fontSize: 14.5, fontWeight: 700, color: `hsl(${resolvedColor})`, animation: 'fadeInUp 0.22s cubic-bezier(.16,1,.3,1) both' }}>
                          {resolution.kind === 'approved' ? 'Approved — clearing…' : 'Rejected — clearing…'}
                        </span>
                      </div>
                    ) : (
                    <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
                      <div style={{ width: 40, height: 40, borderRadius: 11, background: `hsla(${meta.color},0.12)`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <meta.icon size={19} color={`hsl(${meta.color})`} />
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                          <span style={{ fontWeight: 700, fontSize: 15.5, color: 'var(--ink)', lineHeight: 1.3 }}>{n.title}</span>
                          <span style={{ fontSize: 12, color: 'var(--muted)', flexShrink: 0, whiteSpace: 'nowrap' }}>{timeAgo(n.timestamp)}</span>
                        </div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, margin: '7px 0 4px' }}>
                          {n.requestedBy && (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 13, color: 'var(--muted)' }}>
                              <User size={13} /> Requested by <strong style={{ color: 'var(--ink)', fontWeight: 600 }}>{n.requestedBy}</strong>
                            </span>
                          )}
                          {days != null && (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12.5, fontWeight: 700, color: 'hsl(var(--color-blue))', background: 'hsla(var(--color-blue),0.10)', borderRadius: 999, padding: '3px 10px' }}>
                              <Clock size={12} /> {days} day{days !== 1 ? 's' : ''}
                            </span>
                          )}
                          {stage && (
                            <span style={{ fontSize: 12, fontWeight: 700, color: `hsl(${stage.color})`, background: `hsla(${stage.color},0.12)`, borderRadius: 999, padding: '3px 10px', letterSpacing: '.02em' }}>
                              {stage.label}
                            </span>
                          )}
                        </div>
                        <p style={{ fontSize: 13.5, color: 'var(--muted)', margin: '4px 0 14px', lineHeight: 1.45 }}>{n.body}</p>

                        {!isRejecting && !isApproving ? (
                          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            <button onClick={e => { e.stopPropagation(); markRead(n.id); setOpen(false); window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'inventory', sub: 'checkouts' } })); }}
                              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 16px', borderRadius: 9, border: '1px solid var(--line)', background: 'none', color: 'var(--ink)', fontSize: 13.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'Inter, sans-serif' }}>
                              Review
                            </button>
                            <button onClick={e => { e.stopPropagation(); handleAction(n, 'approve'); }}
                              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 16px', borderRadius: 9, border: 'none', background: 'hsla(var(--color-green),0.12)', color: 'hsl(var(--color-green))', fontSize: 13.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'Inter, sans-serif' }}>
                              <Check size={15} /> {n.type === 'extension_pending' ? 'Approve' : 'Approve All'}
                            </button>
                            <button onClick={e => { e.stopPropagation(); setRejectingId(n.id); setRejectReason(''); setApprovingId(null); }}
                              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 16px', borderRadius: 9, border: 'none', background: 'hsla(var(--color-red),0.10)', color: 'hsl(var(--color-red))', fontSize: 13.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'Inter, sans-serif' }}>
                              <X size={15} /> Reject
                            </button>
                          </div>
                        ) : isApproving ? (
                          <div onClick={e => e.stopPropagation()}>
                            {(n.type === 'inv_request' || n.type === 'checkout_pending') ? (
                              <>
                                <p style={{ fontSize: 13, color: 'hsl(var(--color-green))', fontWeight: 700, margin: '0 0 8px' }}>Who should hand this over to {n.requestedBy}?</p>
                                {actionError[n.id] && (
                                  <p style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'hsl(var(--color-red))', background: 'hsla(var(--color-red),0.08)', borderRadius: 8, padding: '8px 12px', margin: '0 0 8px', lineHeight: 1.4 }}>
                                    <AlertCircle size={14} style={{ flexShrink: 0 }} /> {actionError[n.id]}
                                  </p>
                                )}
                                <select
                                  autoFocus
                                  className="form-input"
                                  style={{ width: '100%', fontSize: 13.5, marginBottom: 8, padding: '9px 12px' }}
                                  value={pickedAllocator}
                                  onChange={e => setPickedAllocator(e.target.value)}>
                                  <option value="">Select a person…</option>
                                  {allocators.map(a => (
                                    <option key={a.email} value={a.email}>{a.name}</option>
                                  ))}
                                </select>
                                <div style={{ display: 'flex', gap: 8 }}>
                                  <button onClick={() => submitApprove(n)} disabled={!pickedAllocator || approvingBusy}
                                    style={{ flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7, padding: '9px 0', borderRadius: 8, border: 'none', background: 'hsl(var(--color-green))', color: '#fff', fontSize: 13.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'Inter, sans-serif', opacity: pickedAllocator && !approvingBusy ? 1 : 0.4 }}>
                                    {approvingBusy ? <><Loader2 size={14} style={{ animation: 'spin 0.7s linear infinite' }} /> Approving…</> : 'Confirm Approval'}
                                  </button>
                                  <button onClick={() => { setApprovingId(null); setPickedAllocator(''); }} disabled={approvingBusy}
                                    style={{ padding: '9px 16px', borderRadius: 8, border: '1px solid var(--line)', background: 'none', color: 'var(--muted)', fontSize: 13.5, cursor: 'pointer', fontFamily: 'Inter, sans-serif' }}>
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
                              style={{ width: '100%', fontSize: 13.5, marginBottom: 8, padding: '9px 12px' }}
                              placeholder="Reason for rejection…"
                              value={rejectReason}
                              onChange={e => setRejectReason(e.target.value)}
                              onKeyDown={e => { if (e.key === 'Enter') submitReject(n); if (e.key === 'Escape') { setRejectingId(null); setRejectReason(''); } }}
                            />
                            <div style={{ display: 'flex', gap: 8 }}>
                              <button onClick={() => submitReject(n)} disabled={!rejectReason.trim()}
                                style={{ flex: 1, padding: '9px 0', borderRadius: 8, border: 'none', background: 'hsl(var(--color-red))', color: '#fff', fontSize: 13.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'Inter, sans-serif', opacity: rejectReason.trim() ? 1 : 0.4 }}>
                                Confirm Reject
                              </button>
                              <button onClick={() => { setRejectingId(null); setRejectReason(''); }}
                                style={{ padding: '9px 16px', borderRadius: 8, border: '1px solid var(--line)', background: 'none', color: 'var(--muted)', fontSize: 13.5, cursor: 'pointer', fontFamily: 'Inter, sans-serif' }}>
                                Cancel
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                      {!n.read && <div style={{ width: 9, height: 9, borderRadius: '50%', background: 'hsl(var(--color-blue))', flexShrink: 0, marginTop: 6 }} />}
                    </div>
                    )}
                  </div>
                  </div>
                );
              })}
            </>
          )}

          {/* Updates — lifecycle notifications for the same request are grouped into one evolving card */}
          {updates.length > 0 && (
            <>
              <div style={{ padding: '16px 24px 8px', fontSize: 11.5, fontWeight: 700, letterSpacing: '.07em', color: 'var(--muted)', textTransform: 'uppercase' }}>
                Updates — {updates.length}
              </div>
              {groupByRequest(updates).map(({ key, primary: n, trail }) => {
                const meta = TYPE_META[n.type] ?? TYPE_META['approved'];
                return (
                  <div key={key}
                    style={{ padding: '16px 24px', borderBottom: '1px solid var(--line)', display: 'flex', gap: 14, alignItems: 'flex-start', background: n.read ? 'transparent' : 'hsla(var(--color-blue),0.04)', cursor: 'pointer', opacity: n.read ? 0.7 : 1 }}
                    onClick={() => handleUpdateClick(n)}>
                    <div style={{ width: 38, height: 38, borderRadius: 10, background: `hsla(${meta.color},0.12)`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      <meta.icon size={17} color={`hsl(${meta.color})`} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                        <span style={{ fontWeight: 700, fontSize: 14.5, color: 'var(--ink)' }}>{n.title}</span>
                        <span style={{ fontSize: 12, color: 'var(--muted)', flexShrink: 0, whiteSpace: 'nowrap' }}>{timeAgo(n.timestamp)}</span>
                      </div>
                      {trail.length > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4, margin: '6px 0' }}>
                          {trail.map(t => {
                            const tMeta = STAGE_META[t.type];
                            if (!tMeta) return null;
                            return (
                              <span key={t.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5 }}>
                                <span style={{ fontWeight: 600, color: `hsl(${tMeta.color})`, background: `hsla(${tMeta.color},0.10)`, borderRadius: 999, padding: '2px 9px' }}>
                                  {tMeta.label}
                                </span>
                                <span style={{ color: 'var(--muted)' }}>→</span>
                              </span>
                            );
                          })}
                          {STAGE_META[n.type] && (
                            <span style={{ fontWeight: 700, fontSize: 11.5, color: `hsl(${STAGE_META[n.type].color})`, background: `hsla(${STAGE_META[n.type].color},0.14)`, borderRadius: 999, padding: '2px 9px' }}>
                              {STAGE_META[n.type].label}
                            </span>
                          )}
                        </div>
                      )}
                      <p style={{ fontSize: 13.5, color: 'var(--muted)', margin: '4px 0 0', lineHeight: 1.45 }}>{n.body}</p>
                      {n.action && n.action.kind === 'allocate' && (
                        <button
                          onClick={e => { e.stopPropagation(); handleInlineAllocate(n); }}
                          disabled={allocatingId === n.id}
                          style={{ marginTop: 8, background: 'none', border: 'none', padding: 0, fontSize: 13, fontWeight: 700, color: 'hsl(var(--color-orange))', cursor: allocatingId === n.id ? 'default' : 'pointer', opacity: allocatingId === n.id ? 0.6 : 1, fontFamily: 'Inter, sans-serif', letterSpacing: '.01em' }}>
                          {allocatingId === n.id ? 'Allocating…' : n.action.label}
                        </button>
                      )}
                      {n.action && n.action.kind !== 'allocate' && onNavigate && (
                        <button
                          onClick={e => { e.stopPropagation(); markRead(n.id); setOpen(false); onNavigate(n.action.view, n.action.sub); }}
                          style={{ marginTop: 8, background: 'none', border: 'none', padding: 0, fontSize: 13, fontWeight: 700, color: 'hsl(var(--color-blue))', cursor: 'pointer', fontFamily: 'Inter, sans-serif', letterSpacing: '.01em' }}>
                          {n.action.label}
                        </button>
                      )}
                    </div>
                    <button onClick={e => { e.stopPropagation(); dismiss(n.id); }} title="Dismiss"
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ink)', opacity: 0.35, padding: 6, borderRadius: 6, flexShrink: 0, transition: 'opacity 0.15s' }}
                      onMouseEnter={e => e.currentTarget.style.opacity='0.8'}
                      onMouseLeave={e => e.currentTarget.style.opacity='0.35'}>
                      <X size={15} />
                    </button>
                  </div>
                );
              })}
            </>
          )}
        </div>
      </div>
    </>
  );
}

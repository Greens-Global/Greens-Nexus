// Item Management - Manage > Checkouts: approvals, handovers, returns and assignments.
// Moved out of views/InventoryManagement.jsx unchanged (items split, Nov 2 2026).
import { useState, useEffect, useMemo, memo } from 'react';
import { Package, CheckCircle, Clock, XCircle, RotateCcw, Camera, AlertCircle, X, ChevronDown, ShoppingCart, ZoomIn, Megaphone, Users } from 'lucide-react';
import { Spinner } from '../../components/AsyncState';
import { useRole } from '../../contexts/RoleContext';
import { api } from '../../api';
import { formatMonthDay } from '../../lib/datetime';
import { AssignmentsQueue } from '../../components/Assignments';
import { MANAGER_CHECKOUT_STATUS_META } from '../model/status';
import { checkoutDueInfo, fmtDueDate } from '../model/due';
import { requestNo } from '../model/format';
import { orderActivitySummary } from '../model/auditFeed';
import { useIsMobile } from '../ui/hooks';
import { ImageLightbox } from '../ui/ImageLightbox';
import { HighlightMatch } from '../ui/HighlightMatch';
import { AllocateModal } from './AllocateModal';
import { ApproveCheckoutModal } from './ApproveCheckoutModal';
import { RejectCheckoutModal } from './RejectCheckoutModal';
import { ForceReturnModal } from './ForceReturnModal';

// ── Manager Checkouts Tab ─────────────────────────────────────────────────────
export const ManagerCheckoutsTab = memo(function ManagerCheckoutsTab({ checkouts, items, userName, userEmail, approveRequest, rejectRequest, allocateItem, initiateHandover, refreshCheckouts, refreshItems, toast, onSendAlert, assignments = [], refreshAssignments, prefilter, activeSub }) {
  const [segment, setSegment] = useState('checkouts'); // 'checkouts' | 'assignments'
  // When a perm_return notification deep-links here, jump the Assignments queue
  // straight to its "Returns to Accept" filter. ts forces re-trigger on repeats.
  const [assignFocus, setAssignFocus] = useState(null);
  const { canAccessModule } = useRole();
  // Manager tier OR an Access-Group/job-role grant of Item Management at
  // editor+ - grants layer additively (Jul 24: Employee-tier people with
  // "Item Management: Full" were locked out despite the grant).
  const isManager = canAccessModule('inventory', 'manager', 'editor');
  const isMobile = useIsMobile(); // shorten the segment labels so they fit
  const [statusFilter,   setStatusFilter]   = useState('active');
  const [personQuery,    setPersonQuery]    = useState('');
  const [approvingCo,    setApprovingCo]    = useState(null);
  const [rejectingCo,    setRejectingCo]    = useState(null);
  const [approvingOrder, setApprovingOrder] = useState(null);
  const [rejectingOrder, setRejectingOrder] = useState(null);
  const [allocatingCo,   setAllocatingCo]   = useState(null);
  const [allocatingOrder, setAllocatingOrder] = useState(null);
  const [forceReturnCo,  setForceReturnCo]  = useState(null);
  const [forceReturnBatch, setForceReturnBatch] = useState(null); // array of checkouts (order or all)
  const [photoPreview,   setPhotoPreview]   = useState(null);
  // IDs of completed items dismissed from the active-order view via X button
  const [dismissedIds,   setDismissedIds]   = useState(new Set());
  const [extBusyId,      setExtBusyId]      = useState(null);
  // Order cards collapsed via the header chevron - big orders eat the screen
  const [collapsedKeys,  setCollapsedKeys]  = useState(new Set());
  const toggleCollapsed = key => setCollapsedKeys(prev => {
    const next = new Set(prev);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  });

  // Deep-link from Who Has What: land already scoped to the clicked person/item
  // with the right segment selected, so the actions are one glance away.
  useEffect(() => {
    if (!prefilter) return;
    setSegment(prefilter.segment || 'checkouts');
    if ((prefilter.segment || 'checkouts') === 'checkouts') {
      setStatusFilter('active');
      setPersonQuery(prefilter.q || '');
    }
  }, [prefilter]);

  // Bell/banner clicks land on the TEMPORARY segment - `segment` persists, so
  // after a visit to Assignments every later notification click looked like it
  // "opened Permanent by default" (handover notifications especially).
  // 'checkouts-completed' additionally lands on the Completed filter
  // (returned-order notifications). 'assignment-returns' (dead/lost/reassign
  // return notifications) lands on the Permanent segment, Returns-to-Accept.
  useEffect(() => {
    const h = e => {
      const { view, sub } = e.detail || {};
      if (view !== 'inventory') return;
      if (sub === 'checkouts') setSegment('checkouts');
      if (sub === 'checkouts-completed') { setSegment('checkouts'); setStatusFilter('completed'); }
      if (sub === 'assignment-returns') { setSegment('assignments'); setAssignFocus({ chip: 'returns', ts: Date.now() }); }
    };
    window.addEventListener('nexus:navigate', h);
    return () => window.removeEventListener('nexus:navigate', h);
  }, []);

  // Fresh mount / tab-switch: the window event above fires before this tab is
  // mounted when the click comes from another screen, so also react to the
  // activeSub prop the parent set from the URL.
  useEffect(() => {
    if (activeSub === 'assignment-returns') {
      setSegment('assignments');
      setAssignFocus({ chip: 'returns', ts: Date.now() });
    }
  }, [activeSub]);

  function handleResolveExtension(co, action) {
    setExtBusyId(co.id);
    api.resolveItemExtension(co.id, { action })
      .then(() => {
        toast(action === 'approve'
          ? `Extension approved - ${co.requestedBy} has ${co.extensionDays} more day${co.extensionDays !== 1 ? 's' : ''} with ${co.itemName}.`
          : `Extension declined for ${co.itemName}.`);
        refreshCheckouts();
      })
      .catch(err => toast(err?.message || 'Could not resolve extension.', 'error'))
      .finally(() => setExtBusyId(null));
  }

  // Items flagged picture_required=false - every photo step for them is optional
  const photoOptionalIds = useMemo(() => new Set(items.filter(i => i.pictureRequired === false).map(i => i.id)), [items]);

  // Group ALL checkouts by orderId first, then filter groups
  const allGrouped = (() => {
    const map = new Map();
    for (const co of [...checkouts].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))) {
      const key = co.orderId || co.id;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(co);
    }
    return Array.from(map.values());
  })();

  const groupedOrders = allGrouped.filter(groupItems => {
    const first = groupItems[0];
    // Person search - matches requester name or any item name in the order,
    // across every status (chips only covered people with ACTIVE checkouts)
    if (personQuery.trim()) {
      const q = personQuery.trim().toLowerCase().replace(/^#/, '');
      const matches = (first.requestedBy || '').toLowerCase().includes(q) ||
        groupItems.some(c => (c.itemName || '').toLowerCase().includes(q)) ||
        requestNo(first.orderId || first.id).toLowerCase().includes(q);
      if (!matches) return false;
    }
    if (statusFilter === 'active')    return groupItems.some(c => ['pending','approved','pending_receipt','allocated'].includes(c.status));
    if (statusFilter === 'completed') return groupItems.every(c => ['returned','rejected','cancelled'].includes(c.status));
    return groupItems.some(c => c.status === statusFilter);
  });

  const pending  = checkouts.filter(c => c.status === 'pending').length;
  const approved = checkouts.filter(c => c.status === 'approved').length;

  function handleApprove(co, allocEmail, allocName) {
    return approveRequest(co.id, userName, allocEmail, allocName)
      .then(() => { toast(`Approved ${co.itemName} - assigned to ${allocName}.`); refreshCheckouts(); });
  }

  // Order-level actions run sequentially (not Promise.all) so the backend's
  // per-order notification batching sees each update committed in turn.
  async function handleApproveOrder(orderItems, allocEmail, allocName) {
    // P1-5: count real successes/failures - the loop used to swallow per-item
    // errors then always claim "N approved".
    let ok = 0, failed = 0;
    for (const co of orderItems) {
      try { await approveRequest(co.id, userName, allocEmail, allocName); ok++; } catch { failed++; }
    }
    refreshCheckouts();
    if (failed === 0) toast(`Approved ${ok} item${ok !== 1 ? 's' : ''} - assigned to ${allocName}.`);
    else toast(`Approved ${ok} · ${failed} failed.`, 'error');
  }

  // P0-3: await the (now-rejecting) context call; only toast success after it
  // resolves, error-toast + rethrow on failure so the modal stays open.
  async function handleReject(co, reason) {
    try {
      await rejectRequest(co.id, userName, reason);
      toast('Checkout rejected.');
    } catch (err) {
      toast(err?.message || 'Could not reject the checkout.', 'error');
      throw err;
    } finally {
      refreshCheckouts();
    }
  }

  async function handleRejectOrder(orderItems, reason) {
    // P1-5: count real successes/failures.
    let ok = 0, failed = 0;
    for (const co of orderItems) {
      try { await api.updateItemCheckout(co.id, { status: 'rejected', resolved_by: userName, reject_reason: reason }); ok++; } catch { failed++; }
    }
    refreshCheckouts();
    if (failed === 0) toast(`Rejected ${ok} item${ok !== 1 ? 's' : ''}.`);
    else toast(`Rejected ${ok} · ${failed} failed.`, 'error');
  }

  // Neil's "one big bug": the manager must be able to check an item back in
  // even if the holder never opens the app - with a mandatory reason that
  // lands in condition_note (visible on the past checkout + audit log).
  function handleForceReturn(co, reason) {
    return api.updateItemCheckout(co.id, {
      status: 'returned',
      condition_note: `Force-returned by ${userName} - ${reason}`,
    }).then(() => {
      toast(`${co.itemName} checked back in.`);
      refreshCheckouts(); refreshItems();
    }).catch(err => { toast(err?.message || 'Could not check the item back in.', 'error'); throw err; });
  }

  // Sequential like handleAllocateOrder - the backend's row-locked notification
  // dedupe keeps it one notification per order, never per item
  async function handleForceReturnBatch(cos, reason) {
    let failed = 0;
    for (const co of cos) {
      try {
        await api.updateItemCheckout(co.id, {
          status: 'returned',
          condition_note: `Force-returned by ${userName} - ${reason}`,
        });
      } catch { failed++; }
    }
    refreshCheckouts(); refreshItems();
    if (failed === 0) toast(`${cos.length} item${cos.length !== 1 ? 's' : ''} checked back in.`);
    else toast(`${cos.length - failed} checked back in · ${failed} failed.`, 'error');
  }

  function handleAllocate(co, { photoBy, batch, photoMap }) {
    const p = photoBy === 'employee'
      ? initiateHandover(co.id, userName)
      : allocateItem(co.id, userName, photoMap[co.id]?.url || '', photoMap[co.id]?.name || '', { handoverPhotoBy: 'allocator', handoverBatch: batch });
    return p.then(() => {
      if (photoBy === 'employee') {
        toast(`${co.requestedBy} has been notified to confirm receipt.`);
      } else {
        toast(`Item handed over to ${co.requestedBy} - checkout confirmed.`);
        refreshItems();
      }
      refreshCheckouts();
    });
  }

  async function handleAllocateOrder(orderItems, { photoBy, batch, photoMap }) {
    // P1-5: count real successes/failures in both handover paths.
    let ok = 0, failed = 0;
    if (photoBy === 'employee') {
      for (const co of orderItems) {
        try { await initiateHandover(co.id, userName); ok++; } catch { failed++; }
      }
      if (failed === 0) toast(`${orderItems[0]?.requestedBy} has been notified to confirm receipt of ${ok} item${ok !== 1 ? 's' : ''}.`);
      else toast(`Notified for ${ok} · ${failed} failed.`, 'error');
    } else {
      for (const co of orderItems) {
        try { await allocateItem(co.id, userName, photoMap[co.id]?.url || '', photoMap[co.id]?.name || '', { handoverPhotoBy: 'allocator', handoverBatch: batch }); ok++; } catch { failed++; }
      }
      if (failed === 0) toast(`${ok} item${ok !== 1 ? 's' : ''} handed over to ${orderItems[0]?.requestedBy}.`);
      else toast(`Handed over ${ok} · ${failed} failed.`, 'error');
      refreshItems();
    }
    refreshCheckouts();
  }

  const fmtDate = iso => formatMonthDay(iso);

  const liveAssignments = assignments.filter(a => ['pending_acceptance','active','return_initiated'].includes(a.status)).length;
  return (
    <div>
      {/* Transient vs Permanent - Neil's separation. Phones get the short forms
          ("Temporary" / "Permanent · N") so the two chips fit one row. */}
      <div className="chip-row" style={{ display:'flex', gap:8, marginBottom:14, flexWrap:'wrap' }}>
        {[
          ['checkouts',   isMobile ? 'Temporary' : 'Checkouts (Temporary)'],
          ['assignments', `${isMobile ? 'Permanent' : 'Assignments (Permanent)'}${liveAssignments ? ` · ${liveAssignments}` : ''}`],
        ].map(([k, l]) => (
          <button key={k} onClick={() => setSegment(k)}
            style={{ padding:'7px 16px', borderRadius:10, border:`1px solid ${segment === k ? 'var(--pine)' : 'var(--line)'}`, background: segment === k ? 'hsla(var(--color-green),0.08)' : 'var(--card)', color: segment === k ? 'hsl(var(--color-green))' : 'var(--muted)', fontWeight:700, fontSize:13, cursor:'pointer', fontFamily:'Inter,sans-serif', whiteSpace:'nowrap' }}>
            {l}
          </button>
        ))}
      </div>
      {segment === 'assignments' && (
        <AssignmentsQueue assignments={assignments} userEmail={userEmail} refresh={refreshAssignments || (() => {})} toast={toast} focus={assignFocus} />
      )}
      {segment === 'checkouts' && (<>
      {/* Toolbar - search on the LEFT, status filters + Send Alert on the RIGHT, one
          row directly below the segment toggle. Same shape as Manage/Catalog/My Items
          so the search/filters sit in the same spot (Neil). */}
      <div style={{ display:'flex', alignItems:'center', marginBottom:14, flexWrap:'wrap', gap:10 }}>
        <div className="search-bar" style={{ flex:1, minWidth:220, marginBottom:0 }}>
          <Users size={13} style={{ flexShrink:0 }} />
          <input placeholder="Search by person or item…" value={personQuery} onChange={e => setPersonQuery(e.target.value)} />
          {personQuery && (
            <button onClick={() => setPersonQuery('')} style={{ background:'none', border:'none', cursor:'pointer', color:'var(--muted)', display:'flex', padding:2 }}>
              <X size={13} />
            </button>
          )}
        </div>
        <div className="chip-row" style={{ display:'flex', gap:8, flexWrap:'wrap', alignItems:'center', marginLeft:'auto' }}>
        {[
          { key:'active',    label:'Active',            count: pending + approved + checkouts.filter(c => c.status === 'allocated').length },
          { key:'pending',   label:'Pending approval',  count: pending },
          { key:'approved',  label:'Awaiting handover', count: approved },
          { key:'completed', label:'Completed',         count: checkouts.filter(c => ['returned','rejected','cancelled'].includes(c.status)).length },
        ].map(f => (
          <button key={f.key} onClick={() => setStatusFilter(f.key)}
            style={{ display:'inline-flex', alignItems:'center', gap:6, padding:'6px 14px', borderRadius:20, border:`1px solid ${statusFilter === f.key ? 'var(--pine)' : 'var(--line)'}`, background: statusFilter === f.key ? 'hsla(var(--color-green),0.1)' : 'transparent', color: statusFilter === f.key ? 'hsl(var(--color-green))' : 'var(--muted)', fontWeight: statusFilter === f.key ? 700 : 500, fontSize:12.5, cursor:'pointer', fontFamily:'Inter,sans-serif' }}>
            {f.label}
            {f.count > 0 && <span style={{ background: statusFilter === f.key ? 'hsl(var(--color-green))' : 'var(--muted)', color:'#fff', borderRadius:20, fontSize:10, fontWeight:800, padding:'1px 6px', minWidth:18, textAlign:'center' }}>{f.count}</span>}
          </button>
        ))}
        </div>
        {/* Company-wide "Force Return All" removed (Neil, Jun 16): too dangerous -
            force return now lives only at the individual order/item level below. */}
        {onSendAlert && (
          <button className="secondary-btn" style={{ display:'inline-flex', alignItems:'center', gap:7, color:'hsl(var(--color-orange))', flexShrink:0 }} onClick={onSendAlert}>
            <Megaphone size={14} /> Send Alert
          </button>
        )}
      </div>

      {groupedOrders.length === 0 ? (
        <div style={{ textAlign:'center', padding:'56px 0', color:'var(--muted)' }}>
          <ShoppingCart size={32} style={{ opacity:.25, display:'block', margin:'0 auto 10px' }} />
          No checkouts in this filter.
        </div>
      ) : (
        <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
          {groupedOrders.map(orderItems => {
            const first         = orderItems[0];
            const isMulti       = orderItems.length > 1;
            const pendingItems   = orderItems.filter(c => c.status === 'pending');
            const approvedItems  = orderItems.filter(c => c.status === 'approved');
            const allocatedItems = orderItems.filter(c => c.status === 'allocated');
            const visibleItems  = statusFilter === 'active'
              ? orderItems.filter(c => !(['returned','rejected','cancelled'].includes(c.status) && dismissedIds.has(c.id)))
              : orderItems;
            const groupKey    = first.orderId || first.id;
            const isCollapsed = collapsedKeys.has(groupKey);

            return (
              <div key={groupKey} style={{ border:'1px solid var(--line)', borderRadius:12, overflow:'hidden', background:'var(--card)', boxShadow:'var(--shadow-sm)' }}>
                {/* Order header - click the chevron (or the name area) to collapse */}
                <div className="co-order-head" style={{ padding:'14px 18px', display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:12, flexWrap:'wrap', background: isMulti ? 'var(--mist)' : 'transparent', borderBottom: isCollapsed ? 'none' : '1px solid var(--line)' }}>
                  <div onClick={() => toggleCollapsed(groupKey)} style={{ cursor:'pointer', flex:1, minWidth:0 }}>
                    <div style={{ display:'flex', alignItems:'center', gap:7 }}>
                      <ChevronDown size={15} style={{ color:'var(--muted)', flexShrink:0, transform: isCollapsed ? 'rotate(-90deg)' : 'none', transition:'transform 0.18s' }} />
                      <span style={{ fontWeight:700, fontSize:14 }}><HighlightMatch text={first.requestedBy} query={personQuery} /></span>
                    </div>
                    <div style={{ fontSize:12, color:'var(--muted)', marginTop:2, paddingLeft:22 }}>
                      {fmtDate(first.createdAt)}{isMulti && ` · ${orderItems.length} Items`} · Req #{requestNo(groupKey)}
                      {isCollapsed && ` · ${visibleItems.map(c => c.itemName).slice(0, 3).join(', ')}${visibleItems.length > 3 ? '…' : ''}`}
                    </div>
                    {first.reason && (
                      <div style={{ display:'inline-flex', alignItems:'baseline', gap:6, marginTop:6, background:'var(--mist)', borderRadius:7, padding:'4px 10px' }}>
                        <span style={{ fontSize:10, fontWeight:800, letterSpacing:'.06em', color:'var(--muted)' }}>REASON</span>
                        <span style={{ fontSize:12.5, color:'var(--ink)' }}>{first.reason}</span>
                      </div>
                    )}
                    {statusFilter === 'completed' && (() => {
                      const summary = orderActivitySummary(orderItems);
                      return summary ? (
                        <div style={{ marginTop:8, fontSize:12.5, color:'var(--ink)', background:'hsla(var(--color-green),0.07)', border:'1px solid hsla(var(--color-green),0.18)', borderRadius:7, padding:'7px 11px', lineHeight:1.55, maxWidth:540 }}>
                          {summary}
                        </div>
                      ) : null;
                    })()}
                  </div>
                  <div className="co-order-actions" style={{ display:'flex', gap:6, flexShrink:0, alignItems:'center', flexWrap:'wrap' }}>
                    {pendingItems.length > 1 && (
                      <>
                        <button className="secondary-btn" onClick={() => setRejectingOrder(pendingItems)}
                          style={{ fontSize:12, color:'hsl(var(--color-red))', display:'inline-flex', alignItems:'center', gap:5 }}>
                          <XCircle size={12} /> Reject All
                        </button>
                        <button className="primary-btn" style={{ fontSize:12, display:'inline-flex', alignItems:'center', gap:5, padding:'6px 14px' }}
                          onClick={() => setApprovingOrder(pendingItems)}>
                          <CheckCircle size={12} /> Approve all ({pendingItems.length})
                        </button>
                      </>
                    )}
                    {approvedItems.length > 1 && (
                      <>
                        <button className="secondary-btn" onClick={() => setRejectingOrder(approvedItems)}
                          style={{ fontSize:12, color:'hsl(var(--color-red))', display:'inline-flex', alignItems:'center', gap:5 }}>
                          <XCircle size={12} /> Reject all ({approvedItems.length})
                        </button>
                        <button className="primary-btn" style={{ fontSize:12, display:'inline-flex', alignItems:'center', gap:5, padding:'6px 14px', background:'hsl(var(--color-orange))' }}
                          onClick={() => setAllocatingOrder(approvedItems)}>
                          <Camera size={12} /> Hand Over all ({approvedItems.length})
                        </button>
                      </>
                    )}
                    {allocatedItems.length > 1 && isManager && (
                      <button className="secondary-btn" onClick={() => setForceReturnBatch(allocatedItems)}
                        title="Check every in-use item on this order back in yourself"
                        style={{ fontSize:12, color:'hsl(var(--color-orange))', display:'inline-flex', alignItems:'center', gap:5 }}>
                        <RotateCcw size={12} /> Force return all ({allocatedItems.length})
                      </button>
                    )}
                  </div>
                </div>

                {/* Item rows */}
                {!isCollapsed && <div>
                  {visibleItems.map((co, idx) => {
                    const sm = MANAGER_CHECKOUT_STATUS_META[co.status] || { label: co.status, bg:'var(--mist)', fg:'var(--muted)', Icon: Package };
                    const item = items.find(i => i.id === co.itemId);
                    const isMyAlloc = co.assignedAllocatorEmail && co.assignedAllocatorEmail.toLowerCase() === userEmail;
                    const isOverdue = co.status === 'allocated' && checkoutDueInfo(co).due < new Date();
                    const isCompleted = ['returned','rejected','cancelled'].includes(co.status);

                    return (
                      <div key={co.id} className="co-row" style={{ padding:'12px 18px', borderTop: idx > 0 ? '1px solid var(--line)' : 'none', display:'flex', alignItems:'center', gap:12, flexWrap:'wrap', opacity: isCompleted ? 0.7 : 1 }}>
                        {item?.photoUrl
                          ? <img src={item.photoUrl} alt={co.itemName} loading="lazy" decoding="async" style={{ width:44, height:44, borderRadius:10, objectFit:'cover', border:'1px solid var(--line)', flexShrink:0 }} />
                          : <div style={{ width:44, height:44, borderRadius:10, background:'var(--mist)', flexShrink:0, display:'flex', alignItems:'center', justifyContent:'center' }}><Package size={18} style={{ opacity:.4 }} /></div>}

                        <div style={{ flex:1, minWidth:0 }}>
                          <div style={{ fontWeight:600, fontSize:13 }}><HighlightMatch text={co.itemName} query={personQuery} /></div>
                          <div style={{ fontSize:11.5, color:'var(--muted)', marginTop:1 }}>
                            {co.itemType} · {co.days} day{co.days !== 1 ? 's' : ''}
                            {co.status === 'allocated' && ` · until ${fmtDueDate(co)}`}
                            {co.assignedAllocatorName && co.status === 'approved' && <span style={{ color:'hsl(var(--color-blue))' }}> · {co.assignedAllocatorName}</span>}
                          </div>
                          {co.rejectReason && <div style={{ fontSize:11, color:'hsl(var(--color-red))', marginTop:2 }}>Reason: {co.rejectReason}</div>}
                          {co.status === 'allocated' && co.extensionStatus === 'pending' && (
                            <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap', marginTop:6, background:'hsla(var(--color-blue),0.06)', border:'1px solid hsla(var(--color-blue),0.25)', borderRadius:8, padding:'6px 10px' }}>
                              <Clock size={12} color="hsl(var(--color-blue))" style={{ flexShrink:0 }} />
                              <span style={{ fontSize:12, fontWeight:600, color:'hsl(var(--color-blue))' }}>
                                Extension requested: +{co.extensionDays} day{co.extensionDays !== 1 ? 's' : ''}
                              </span>
                              {isManager && (
                                <div style={{ display:'flex', gap:6, marginLeft:'auto' }}>
                                  <button className="secondary-btn" disabled={extBusyId === co.id} onClick={() => handleResolveExtension(co, 'reject')}
                                    style={{ fontSize:11.5, color:'hsl(var(--color-red))', display:'inline-flex', alignItems:'center', gap:4 }}>
                                    <XCircle size={11} /> Reject
                                  </button>
                                  <button disabled={extBusyId === co.id} onClick={() => handleResolveExtension(co, 'approve')}
                                    className="primary-btn" style={{ fontSize:11.5, padding:'3px 12px', display:'inline-flex', alignItems:'center', gap:4 }}>
                                    {extBusyId === co.id ? <Spinner size={11} /> : <CheckCircle size={11} />} Approve
                                  </button>
                                </div>
                              )}
                              {/* Reason on its own line under the request (Neil) */}
                              {co.extensionReason && <div style={{ flexBasis:'100%', fontSize:11.5, color:'var(--muted)' }}>Reason: <em>"{co.extensionReason}"</em></div>}
                            </div>
                          )}
                        </div>

                        <div style={{ display:'flex', alignItems:'center', gap:6, flexShrink:0, flexWrap:'wrap', justifyContent:'flex-end' }}>
                          {isOverdue && (
                            <span style={{ display:'inline-flex', alignItems:'center', gap:3, padding:'2px 7px', borderRadius:20, fontSize:10.5, fontWeight:800, background:'hsla(var(--color-orange),0.15)', color:'hsl(var(--color-orange))' }}>
                              <AlertCircle size={10} /> Overdue
                            </span>
                          )}
                          <span style={{ display:'inline-flex', alignItems:'center', gap:4, padding:'3px 10px', borderRadius:20, fontSize:11, fontWeight:700, background:sm.bg, color:sm.fg, whiteSpace:'nowrap' }}>
                            <sm.Icon size={11} /> {sm.label}
                          </span>
                          {(co.checkoutPhotoUrl || co.returnPhotoUrl) && (
                            <button onClick={() => setPhotoPreview(co.returnPhotoUrl || co.checkoutPhotoUrl)}
                              style={{ background:'none', border:'1px solid var(--line)', borderRadius:7, padding:'4px 8px', cursor:'pointer', color:'var(--muted)', display:'flex', alignItems:'center' }}>
                              <ZoomIn size={12} />
                            </button>
                          )}
                          {co.status === 'pending' && (
                            <>
                              <button className="secondary-btn" onClick={() => setRejectingCo(co)}
                                style={{ fontSize:12, color:'hsl(var(--color-red))', display:'inline-flex', alignItems:'center', gap:4 }}>
                                <XCircle size={12} /> Reject
                              </button>
                              <button className="primary-btn" style={{ fontSize:12, display:'inline-flex', alignItems:'center', gap:4, padding:'6px 12px' }}
                                onClick={() => setApprovingCo(co)}>
                                <CheckCircle size={12} /> Approve
                              </button>
                            </>
                          )}
                          {co.status === 'approved' && isManager && (
                            <button className="secondary-btn" onClick={() => setRejectingCo(co)}
                              style={{ fontSize:12, color:'hsl(var(--color-red))', display:'inline-flex', alignItems:'center', gap:4 }}>
                              <XCircle size={12} /> Reject
                            </button>
                          )}
                          {co.status === 'allocated' && isManager && (
                            <button className="secondary-btn" onClick={() => setForceReturnCo(co)}
                              title="Check the item back in yourself - for when the holder can't or won't return it in the app"
                              style={{ fontSize:12, color:'hsl(var(--color-orange))', display:'inline-flex', alignItems:'center', gap:4 }}>
                              <RotateCcw size={12} /> Force Return
                            </button>
                          )}
                          {co.status === 'approved' && (isMyAlloc || isManager) && (
                            <button className="primary-btn" style={{ fontSize:12, display:'inline-flex', alignItems:'center', gap:4, background:'hsl(var(--color-orange))', padding:'6px 12px' }}
                              onClick={() => setAllocatingCo(co)}>
                              <Camera size={12} /> Hand Over
                            </button>
                          )}
                          {isCompleted && statusFilter === 'active' && (
                            <button onClick={() => setDismissedIds(prev => new Set([...prev, co.id]))} title="Dismiss"
                              style={{ background:'none', border:'none', cursor:'pointer', color:'var(--muted)', padding:4, display:'flex', alignItems:'center', borderRadius:6 }}>
                              <X size={14} />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>}
              </div>
            );
          })}
        </div>
      )}

      {approvingCo && (
        <ApproveCheckoutModal checkout={approvingCo} onClose={() => setApprovingCo(null)}
          onConfirm={(email, name) => handleApprove(approvingCo, email, name)}
          currentUserEmail={userEmail} currentUserName={userName} />
      )}
      {rejectingCo && (
        <RejectCheckoutModal checkout={rejectingCo} onClose={() => setRejectingCo(null)}
          onConfirm={reason => handleReject(rejectingCo, reason)} />
      )}
      {approvingOrder && (
        <ApproveCheckoutModal checkouts={approvingOrder} onClose={() => setApprovingOrder(null)}
          onConfirm={(email, name) => handleApproveOrder(approvingOrder, email, name)}
          currentUserEmail={userEmail} currentUserName={userName} />
      )}
      {rejectingOrder && (
        <RejectCheckoutModal checkouts={rejectingOrder} onClose={() => setRejectingOrder(null)}
          onConfirm={reason => handleRejectOrder(rejectingOrder, reason)} />
      )}
      {allocatingCo && (
        <AllocateModal checkout={allocatingCo} onClose={() => setAllocatingCo(null)}
          photoOptional={photoOptionalIds.has(allocatingCo.itemId)}
          onConfirm={payload => handleAllocate(allocatingCo, payload)} />
      )}
      {allocatingOrder && (
        <AllocateModal checkouts={allocatingOrder} onClose={() => setAllocatingOrder(null)}
          photoOptional={allocatingOrder.every(co => photoOptionalIds.has(co.itemId))}
          onConfirm={payload => handleAllocateOrder(allocatingOrder, payload)} />
      )}
      {forceReturnCo && (
        <ForceReturnModal checkout={forceReturnCo} onClose={() => setForceReturnCo(null)}
          onConfirm={reason => handleForceReturn(forceReturnCo, reason)} />
      )}
      {forceReturnBatch && (
        <ForceReturnModal checkouts={forceReturnBatch} onClose={() => setForceReturnBatch(null)}
          onConfirm={reason => handleForceReturnBatch(forceReturnBatch, reason)} />
      )}
      {photoPreview && <ImageLightbox src={photoPreview} onClose={() => setPhotoPreview(null)} />}
      </>)}
    </div>
  );
});

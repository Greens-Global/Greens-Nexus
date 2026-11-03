// Item Management - My Items: active and past checkouts, and the Permanent tab.
// Moved out of views/InventoryManagement.jsx unchanged (items split, Nov 2 2026).
import { useState, useEffect, memo } from 'react';
import { Package, Search, Clock, XCircle, RotateCcw, Camera, X, History, ShoppingCart, ZoomIn, ArrowUpDown, User } from 'lucide-react';
import { Spinner } from '../../components/AsyncState';
import { formatDateLong, formatMonthDay } from '../../lib/datetime';
import { MyPermanentPanel } from '../../components/Assignments';
import { CHECKOUT_STATUS_META } from '../model/status';
import { requestNo } from '../model/format';
import { ImageLightbox } from '../ui/ImageLightbox';
import { StageTracker } from '../ui/StageTracker';
import { InUseSummary } from './InUseSummary';
import { ReturnModal } from './ReturnModal';
import { ExtendRequestModal } from './ExtendRequestModal';
import { BatchReRequestModal } from './BatchReRequestModal';
import { EmployeeAcceptModal } from './EmployeeAcceptModal';
import { ReceiptConfirmModal } from './ReceiptConfirmModal';

// ── My Checkouts Panel ────────────────────────────────────────────────────────
export const MyCheckoutsPanel = memo(function MyCheckoutsPanel({ checkouts, userEmail, userName, onReturn, onCancel, onSelfAllocate, onEmployeeAccept, onConfirmReceipt, onReRequest, onBatchReRequest, onReturnAll, onRequestExtension, assignments = [], refreshAssignments, toast, activeSub, photoOptionalIds = new Set() }) {
  const mine = checkouts.filter(c =>
    (c.requestedByEmail && c.requestedByEmail.toLowerCase() === userEmail) ||
    c.requestedBy === userName
  );
  const [dismissedIds,    setDismissedIds]    = useState(new Set());
  const [reRequestId,     setReRequestId]     = useState(null);
  const [reRequestReason, setReRequestReason] = useState('');
  const [reRequestBusy,   setReRequestBusy]   = useState(false);
  const [confirmingCo,    setConfirmingCo]    = useState(null);
  const [returnAllGroup,  setReturnAllGroup]  = useState(null);
  const [extendingCo,     setExtendingCo]     = useState(null);
  // Past Checkouts batch re-request (Neil): row checkboxes → one new order
  const [selectedPastIds,    setSelectedPastIds]    = useState(new Set());
  const [batchReRequestOpen, setBatchReRequestOpen] = useState(false);
  const [panelTab,        setPanelTab]        = useState('active');
  // Deep-link: permanent-assignment notifications must land on the Permanent
  // tab, not Active Checkouts (Neil bug). Covers fresh mounts (activeSub prop)
  // and repeat clicks while already mounted (window event).
  useEffect(() => {
    if (activeSub === 'permanent') setPanelTab('permanent');
    if (activeSub === 'active-checkouts') setPanelTab('active');
  }, [activeSub]);
  useEffect(() => {
    const h = e => {
      const { view, sub } = e.detail || {};
      if (view !== 'inventory') return;
      if (sub === 'permanent') setPanelTab('permanent');
      if (sub === 'active-checkouts') setPanelTab('active');
    };
    window.addEventListener('nexus:navigate', h);
    return () => window.removeEventListener('nexus:navigate', h);
  }, []);
  // Filters - type/dept apply to both tabs, status + sort to Past
  const [fStatus,         setFStatus]         = useState('All');
  const [fType,           setFType]           = useState('All');
  const [fDept,           setFDept]           = useState('All');
  const [mySearch,        setMySearch]        = useState('');
  const [sortOldest,      setSortOldest]      = useState(false);
  // Date-range filter on submission date - both tabs (Pranshu, Jun 16)
  const [fFrom,           setFFrom]           = useState('');
  const [fTo,             setFTo]             = useState('');

  // Find order groups where ALL items are rejected → auto-move to past, no manual discard needed
  const _orderMap = (() => {
    const m = new Map();
    for (const c of mine) {
      const key = c.orderId || `solo-${c.id}`;
      if (!m.has(key)) m.set(key, []);
      m.get(key).push(c);
    }
    return m;
  })();
  const allRejectedKeys = new Set(
    [..._orderMap.entries()]
      .filter(([, items]) => items.every(c => c.status === 'rejected'))
      .map(([key]) => key)
  );

  const active    = mine.filter(c => {
    if (['pending','approved','pending_receipt','allocated'].includes(c.status)) return true;
    if (c.status === 'rejected') {
      const key = c.orderId || `solo-${c.id}`;
      if (allRejectedKeys.has(key)) return false;
      return !dismissedIds.has(c.id);
    }
    return false;
  });
  const completed = mine.filter(c => {
    if (['returned','cancelled'].includes(c.status)) return true;
    if (c.status === 'rejected') {
      const key = c.orderId || `solo-${c.id}`;
      if (allRejectedKeys.has(key)) return true;
      return dismissedIds.has(c.id);
    }
    return false;
  });
  const [cancelId, setCancelId] = useState(null);
  const [cancelBusy, setCancelBusy] = useState(null);
  const [cancelAllKey, setCancelAllKey] = useState(null);
  const [cancelAllBusy, setCancelAllBusy] = useState(false);
  const [photoPreview, setPhotoPreview] = useState(null);
  const [acceptingCo, setAcceptingCo] = useState(null);
  const fmtDate = iso => formatDateLong(iso);

  // Type/dept/date-range filters apply per item; status + date sort only matter for Past
  const inDateRange = c => {
    if (!fFrom && !fTo) return true;
    const t = new Date(c.createdAt);
    if (fFrom && t < new Date(`${fFrom}T00:00:00`)) return false;
    if (fTo   && t > new Date(`${fTo}T23:59:59`))   return false;
    return true;
  };
  const matchesFilters = c =>
    (fType === 'All' || c.itemType === fType) &&
    (fDept === 'All' || c.department === fDept) &&
    (!mySearch.trim() || (c.itemName || '').toLowerCase().includes(mySearch.trim().toLowerCase())) &&
    inDateRange(c);
  const activeFiltered = active.filter(matchesFilters);
  const completedView  = completed
    .filter(c => matchesFilters(c) && (fStatus === 'All' || c.status === fStatus))
    .sort((a, b) => sortOldest
      ? new Date(a.createdAt) - new Date(b.createdAt)
      : new Date(b.createdAt) - new Date(a.createdAt));
  const myDepts = ['All', ...Array.from(new Set(mine.map(c => c.department).filter(Boolean))).sort()];
  const myTypes = ['All', ...Array.from(new Set(mine.map(c => c.itemType).filter(Boolean))).sort()];

  // Batch re-request: dedupe ticked rows by item - the same item often appears
  // many times in history, but only one fresh request per item makes sense.
  // Most recent row wins (its days carry over to the new request).
  const batchItems = (() => {
    const seen = new Set(); const out = [];
    const newestFirst = [...completed].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    for (const c of newestFirst) {
      if (!selectedPastIds.has(c.id) || seen.has(c.itemId)) continue;
      seen.add(c.itemId); out.push(c);
    }
    return out;
  })();

  // Group active checkouts by orderId so cart submissions appear as one block
  const activeGroups = (() => {
    const map = new Map();
    for (const c of activeFiltered) {
      const key = c.orderId || c.id;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(c);
    }
    return Array.from(map.values());
  })();

  const fmtDateShort = iso => formatMonthDay(iso);

  const myAssignments = assignments.filter(a => a.assigneeEmail === userEmail);
  const liveAssignCount = myAssignments.filter(a => ['pending_acceptance','active','return_initiated'].includes(a.status)).length;
  if (!mine.length && !myAssignments.length) return null;

  // The Active / Past / Permanent sub-tabs - rendered BELOW the search/filter bar
  // so the toolbar stays at the same height as every other tab (Neil: fixed spot).
  const segmentTabs = (
    <div className="chip-row" style={{ display:'flex', gap:8, marginBottom:16 }}>
      {[
        { key:'active', label:'Active Checkouts', Icon: Clock,   count: active.length    },
        { key:'past',   label:'Past Checkouts',   Icon: History, count: completed.length },
        { key:'permanent', label:'Permanent', Icon: User, count: liveAssignCount },
      ].map(({ key, label, Icon, count }) => {
        const sel = panelTab === key;
        return (
          <button key={key} onClick={() => setPanelTab(key)}
            style={{ display:'inline-flex', alignItems:'center', gap:7, padding:'8px 18px', borderRadius:10,
              border:`1px solid ${sel ? 'var(--pine)' : 'var(--line)'}`,
              background: sel ? 'hsla(var(--color-green),0.08)' : 'var(--card)',
              color: sel ? 'hsl(var(--color-green))' : 'var(--muted)',
              fontWeight: sel ? 700 : 600, fontSize:13, cursor:'pointer', fontFamily:'Inter,sans-serif', transition:'all 0.15s' }}>
            <Icon size={14} /> {label}
            <span style={{ padding:'1px 8px', borderRadius:20, fontSize:11, fontWeight:700,
              background: sel ? 'hsl(var(--color-green))' : 'var(--mist)',
              color: sel ? '#fff' : 'var(--muted)' }}>{count}</span>
          </button>
        );
      })}
    </div>
  );

  return (
    <div>
      {/* Filters - type/dept on both tabs; status chips + date sort on Past */}
      {(mine.length > 3) && (
        <div style={{ display:'flex', gap:10, flexWrap:'wrap', alignItems:'center', marginBottom:14 }}>
          {/* Consistent toolbar - search left, filters right - same shape as Manage. */}
          <div className="search-bar" style={{ flex:1, minWidth:200, marginBottom:0 }}>
            <Search size={14} style={{ flexShrink:0 }} />
            <input placeholder="Search my items…" value={mySearch} onChange={e => setMySearch(e.target.value)} />
            {mySearch && <button className="search-clear" onClick={() => setMySearch('')} title="Clear search" aria-label="Clear search"><X size={13} /></button>}
          </div>
          <div style={{ display:'flex', gap:8, flexWrap:'wrap', alignItems:'center', marginLeft:'auto' }}>
          {panelTab === 'past' && [
            { v:'All', label:'All' }, { v:'returned', label:'Returned' },
            { v:'rejected', label:'Rejected' }, { v:'cancelled', label:'Cancelled' },
          ].map(({ v, label }) => (
            <button key={v} onClick={() => setFStatus(v)}
              style={{ padding:'4px 12px', borderRadius:20, border:`1px solid ${fStatus === v ? 'var(--pine)' : 'var(--line)'}`, background: fStatus === v ? 'hsla(var(--color-green),0.1)' : 'transparent', color: fStatus === v ? 'hsl(var(--color-green))' : 'var(--muted)', fontSize:12, fontWeight:600, cursor:'pointer', fontFamily:'Inter,sans-serif' }}>
              {label}
            </button>
          ))}
          {myTypes.length > 2 && (
            <select className="form-input" value={fType} onChange={e => setFType(e.target.value)} style={{ padding:'4px 10px', fontSize:12, height:30, width:'auto' }}>
              {myTypes.map(t => <option key={t} value={t}>{t === 'All' ? 'All types' : t}</option>)}
            </select>
          )}
          {myDepts.length > 2 && (
            <select className="form-input" value={fDept} onChange={e => setFDept(e.target.value)} style={{ padding:'4px 10px', fontSize:12, height:30, width:'auto' }}>
              {myDepts.map(d => <option key={d} value={d}>{d === 'All' ? 'All departments' : d}</option>)}
            </select>
          )}
          {/* Submission date range - jump straight to a period instead of scrolling */}
          <div style={{ display:'inline-flex', alignItems:'center', gap:5 }}>
            <span style={{ fontSize:11.5, color:'var(--muted)', fontWeight:600 }}>From</span>
            <input type="date" className="form-input" value={fFrom} max={fTo || undefined}
              onChange={e => setFFrom(e.target.value)} style={{ padding:'4px 8px', fontSize:12, height:30 }} />
            <span style={{ fontSize:11.5, color:'var(--muted)', fontWeight:600 }}>To</span>
            <input type="date" className="form-input" value={fTo} min={fFrom || undefined}
              onChange={e => setFTo(e.target.value)} style={{ padding:'4px 8px', fontSize:12, height:30 }} />
            {(fFrom || fTo) && (
              <button onClick={() => { setFFrom(''); setFTo(''); }} title="Clear dates"
                style={{ background:'none', border:'none', cursor:'pointer', color:'var(--muted)', display:'inline-flex', padding:2 }}>
                <X size={13} />
              </button>
            )}
          </div>
          {panelTab === 'past' && (
            <button onClick={() => setSortOldest(o => !o)}
              style={{ display:'inline-flex', alignItems:'center', gap:5, padding:'4px 12px', borderRadius:20, border:'1px solid var(--line)', background:'transparent', color:'var(--muted)', fontSize:12, fontWeight:600, cursor:'pointer', fontFamily:'Inter,sans-serif' }}>
              <ArrowUpDown size={11} /> {sortOldest ? 'Oldest first' : 'Newest first'}
            </button>
          )}
          </div>
        </div>
      )}

      {segmentTabs}

      {panelTab === 'permanent' && (
        <MyPermanentPanel assignments={assignments} userEmail={userEmail} refresh={refreshAssignments || (() => {})} toast={toast || (() => {})} />
      )}

      {panelTab === 'active' && active.length === 0 && (
        <div style={{ textAlign:'center', padding:'40px 20px', color:'var(--muted)', border:'1px dashed var(--line)', borderRadius:12 }}>
          <Package size={30} style={{ opacity:.2, display:'block', margin:'0 auto 10px' }} />
          <div style={{ fontSize:13.5 }}>No active checkouts right now.</div>
        </div>
      )}

      {panelTab === 'active' && activeGroups.map(groupItems => {
        const firstItem = groupItems[0];
        const groupKey = firstItem.orderId || firstItem.id;
        // Count siblings across ALL of the user's checkouts (incl. returned) -
        // the Order header must survive partial returns, not vanish when only
        // one active item remains in a multi-item order.
        const orderSiblings = firstItem.orderId ? mine.filter(c => c.orderId === firstItem.orderId) : groupItems;
        const isMulti = firstItem.orderId ? orderSiblings.length > 1 : groupItems.length > 1;
        const cancellableItems = groupItems.filter(c => ['pending','approved'].includes(c.status));
        // Batch buttons key off the RELEVANT items, not the whole order - a
        // rejected/cancelled sibling must not hide "Confirm Receipt for All".
        const pendingReceiptItems = groupItems.filter(c => c.status === 'pending_receipt');
        const showBatchReceipt    = pendingReceiptItems.length > 1;
        const allocatedItems      = groupItems.filter(c => c.status === 'allocated');
        const showBatchReturn     = allocatedItems.length > 1;
        return (
          <div key={groupKey} style={{ border:'1px solid var(--line)', borderRadius:12, overflow:'hidden', marginBottom:12, background:'var(--card)', boxShadow:'var(--shadow-sm)' }}>
            {isMulti && (
              <div style={{ padding:'10px 16px', background:'var(--mist)', borderBottom:'1px solid var(--line)', display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
                <ShoppingCart size={13} color="hsl(var(--color-blue))" />
                <span style={{ fontSize:12.5, fontWeight:700, color:'hsl(var(--color-blue))' }}>
                  Order · {groupItems.length === orderSiblings.length
                    ? `${groupItems.length} Items`
                    : `${groupItems.length} of ${orderSiblings.length} Items active`}
                </span>
                <span style={{ fontSize:12, color:'var(--muted)', marginLeft:4 }}>· {fmtDateShort(firstItem.createdAt)} · Req #{requestNo(groupKey)}</span>
                {firstItem.reason && (
                  <span style={{ display:'inline-flex', alignItems:'baseline', gap:5, marginLeft:4, background:'var(--card)', border:'1px solid var(--line)', borderRadius:6, padding:'2px 8px' }}>
                    <span style={{ fontSize:9.5, fontWeight:800, letterSpacing:'.06em', color:'var(--muted)' }}>REASON</span>
                    <span style={{ fontSize:12, color:'var(--ink)' }}>{firstItem.reason}</span>
                  </span>
                )}
                {/* Group-level confirm receipt - covers every item awaiting receipt */}
                {showBatchReceipt && onConfirmReceipt && (
                  <button className="primary-btn"
                    style={{ marginLeft:'auto', fontSize:11.5, padding:'4px 12px', display:'inline-flex', alignItems:'center', gap:4 }}
                    onClick={() => setConfirmingCo(pendingReceiptItems)}>
                    <Camera size={12} /> Confirm receipt for all ({pendingReceiptItems.length})
                  </button>
                )}
                {showBatchReturn && onReturnAll && (
                  <button className="secondary-btn" onClick={() => setReturnAllGroup(allocatedItems)}
                    style={{ marginLeft: showBatchReceipt ? 0 : 'auto', fontSize:11.5, padding:'4px 12px', display:'inline-flex', alignItems:'center', gap:4 }}>
                    <RotateCcw size={11} /> Return all ({allocatedItems.length})
                  </button>
                )}
                {cancellableItems.length > 1 && !showBatchReceipt && !showBatchReturn && cancelAllKey !== groupKey && (
                  <button className="secondary-btn" onClick={() => setCancelAllKey(groupKey)}
                    style={{ marginLeft:'auto', fontSize:11.5, padding:'4px 12px', color:'hsl(var(--color-red))', display:'inline-flex', alignItems:'center', gap:4 }}>
                    <XCircle size={11} /> Cancel All
                  </button>
                )}
                {cancelAllKey === groupKey && (
                  <div style={{ marginLeft:'auto', display:'flex', alignItems:'center', gap:6, background:'hsla(var(--color-red),0.05)', border:'1px solid hsla(var(--color-red),0.2)', borderRadius:8, padding:'5px 10px' }}>
                    <span style={{ fontSize:12, color:'var(--ink)' }}>Cancel all {cancellableItems.length} items?</span>
                    <button onClick={() => setCancelAllKey(null)} className="secondary-btn" style={{ fontSize:11.5, padding:'3px 8px' }}>Keep</button>
                    <button disabled={cancelAllBusy}
                      style={{ background:'hsl(var(--color-red))', color:'#fff', border:'none', borderRadius:6, padding:'3px 10px', fontSize:11.5, cursor:'pointer', display:'inline-flex', alignItems:'center', gap:4, fontWeight:700, fontFamily:'Inter,sans-serif' }}
                      onClick={() => {
                        setCancelAllBusy(true);
                        Promise.allSettled(cancellableItems.map(c => onCancel(c)))
                          .finally(() => { setCancelAllBusy(false); setCancelAllKey(null); });
                      }}>
                      {cancelAllBusy ? <Spinner size={11} /> : null} Yes, cancel all
                    </button>
                  </div>
                )}
              </div>
            )}
            {groupItems.map((c, idx) => {
              const sm = CHECKOUT_STATUS_META[c.status];
              return (
                <div key={c.id} style={{ padding:'16px 18px', borderTop: idx > 0 ? '1px solid var(--line)' : 'none' }}>
                  <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:10, flexWrap:'wrap', marginBottom:8 }}>
                    <div>
                      <div style={{ fontWeight:700, fontSize:14 }}>{c.itemName}</div>
                      <div style={{ fontSize:12, color:'var(--muted)', marginTop:2 }}>
                        {c.itemType} · {c.department} · {c.days} day{c.days !== 1 ? 's' : ''}
                        {c.raisedBy && c.raisedBy !== c.requestedBy && <span style={{ color:'hsl(var(--color-blue))', marginLeft:6 }}>via {c.raisedBy}</span>}
                      </div>
                    </div>
                    <span style={{ display:'inline-flex', alignItems:'center', gap:4, padding:'3px 10px', borderRadius:20, fontSize:11, fontWeight:700, background:sm.bg, color:sm.fg }}>
                      <sm.Icon size={11} /> {sm.label}
                    </span>
                  </div>
                  {!isMulti && c.reason && (
                    <div style={{ display:'inline-flex', alignItems:'baseline', gap:6, background:'var(--mist)', borderRadius:7, padding:'5px 10px', marginBottom:4 }}>
                      <span style={{ fontSize:9.5, fontWeight:800, letterSpacing:'.06em', color:'var(--muted)' }}>REASON</span>
                      <span style={{ fontSize:12.5, color:'var(--ink)' }}>{c.reason}</span>
                    </div>
                  )}
                  {c.status === 'allocated'
                    ? <InUseSummary checkout={c} />
                    : <StageTracker checkout={c} onViewPhoto={url => setPhotoPreview(url)} />}
                  {c.status === 'rejected' ? (
                    reRequestId === c.id ? (
                      <div style={{ marginTop:10, display:'flex', flexDirection:'column', gap:8, background:'hsla(var(--color-blue),0.05)', border:'1px solid hsla(var(--color-blue),0.2)', borderRadius:9, padding:'10px 12px' }}>
                        <label style={{ fontSize:12, fontWeight:600, color:'var(--muted)' }}>NEW COMMENT (required)</label>
                        <textarea rows={2} className="form-input" style={{ width:'100%', resize:'vertical', fontSize:13 }}
                          placeholder="Add context for your re-request…"
                          value={reRequestReason} onChange={e => setReRequestReason(e.target.value)} />
                        <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
                          <button className="secondary-btn" style={{ fontSize:12 }} onClick={() => { setReRequestId(null); setReRequestReason(''); }}>Cancel</button>
                          <button className="primary-btn" style={{ fontSize:12, display:'inline-flex', alignItems:'center', gap:5 }}
                            disabled={!reRequestReason.trim() || reRequestBusy}
                            onClick={() => {
                              setReRequestBusy(true);
                              onReRequest(c, reRequestReason.trim())
                                .then(() => {
                                  setReRequestId(null); setReRequestReason('');
                                  // Fresh request created - just hide the rejected card
                                  // locally. Do NOT cancel the rejected row (P1-11): it must
                                  // stay 'rejected' so history keeps the manager's decision.
                                  setDismissedIds(prev => new Set([...prev, c.id]));
                                })
                                // onReRequest already toasts + rethrows on failure; keep the
                                // rejected card in place (don't dismiss) if the create failed.
                                .catch(() => {})
                                .finally(() => setReRequestBusy(false));
                            }}>
                            {reRequestBusy ? <Spinner size={12} /> : <RotateCcw size={12} />}
                            Submit again
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div style={{ display:'flex', gap:8, justifyContent:'flex-end', flexWrap:'wrap', marginTop:10 }}>
                        <button className="secondary-btn" onClick={() => {
                            // Just dismiss the card from this view - the rejected row stays
                            // 'rejected' (P1-11: never rewrite it to cancelled).
                            setDismissedIds(prev => new Set([...prev, c.id]));
                          }}
                          style={{ fontSize:12, display:'inline-flex', alignItems:'center', gap:5, color:'var(--muted)' }}>
                          <X size={12} /> Discard
                        </button>
                        {onReRequest && (
                          <button className="primary-btn" style={{ fontSize:12, display:'inline-flex', alignItems:'center', gap:5 }}
                            onClick={() => { setReRequestId(c.id); setReRequestReason(''); }}>
                            <RotateCcw size={12} /> Request Again
                          </button>
                        )}
                      </div>
                    )
                  ) : (
                  <div style={{ display:'flex', gap:8, justifyContent:'flex-end', flexWrap:'wrap', marginTop:8 }}>
                    {c.status === 'allocated' && onRequestExtension && c.extensionStatus !== 'pending' && (
                      <button className="secondary-btn" style={{ fontSize:12.5, display:'inline-flex', alignItems:'center', gap:5, color:'hsl(var(--color-blue))' }}
                        onClick={() => setExtendingCo(c)}>
                        <Clock size={13} /> Extend Item
                      </button>
                    )}
                    {c.status === 'allocated' && (
                      <button className="primary-btn" style={{ fontSize:12.5, display:'inline-flex', alignItems:'center', gap:5 }}
                        onClick={() => onReturn(c)}>
                        <RotateCcw size={13} /> Return Item
                      </button>
                    )}
                    {c.status === 'pending_receipt' && onConfirmReceipt && (
                      <button className="primary-btn" style={{ fontSize:12.5, display:'inline-flex', alignItems:'center', gap:5 }}
                        onClick={() => setConfirmingCo(c)}>
                        <Camera size={13} /> Confirm receipt &amp; upload photo
                      </button>
                    )}
                    {c.status === 'approved' && (onEmployeeAccept || onSelfAllocate) && (
                      <button className="primary-btn" style={{ fontSize:12.5, display:'inline-flex', alignItems:'center', gap:5, background:'hsl(var(--color-green))' }}
                        onClick={() => onEmployeeAccept ? setAcceptingCo(c) : onSelfAllocate(c)}>
                        <Camera size={13} /> Accept &amp; upload photo
                      </button>
                    )}
                    {['pending','approved'].includes(c.status) && cancelId !== c.id && (
                      <button className="secondary-btn" onClick={() => setCancelId(c.id)}
                        style={{ fontSize:12, display:'inline-flex', alignItems:'center', gap:5, color:'hsl(var(--color-red))' }}>
                        <XCircle size={13} /> Cancel
                      </button>
                    )}
                    {cancelId === c.id && (
                      <div style={{ display:'flex', alignItems:'center', gap:8, background:'hsla(var(--color-red),0.05)', border:'1px solid hsla(var(--color-red),0.2)', borderRadius:8, padding:'8px 12px', flex:1 }}>
                        <span style={{ fontSize:12.5, flex:1 }}>Cancel this checkout?</span>
                        <button onClick={() => setCancelId(null)} className="secondary-btn" style={{ fontSize:12, padding:'4px 10px' }}>Keep</button>
                        <button disabled={cancelBusy === c.id}
                          style={{ background:'hsl(var(--color-red))', color:'#fff', border:'none', borderRadius:7, padding:'4px 12px', fontSize:12, cursor:'pointer', display:'inline-flex', alignItems:'center', gap:5, fontWeight:700 }}
                          onClick={() => {
                            setCancelBusy(c.id);
                            onCancel(c).finally(() => { setCancelBusy(null); setCancelId(null); });
                          }}>
                          {cancelBusy === c.id ? <Spinner size={12} /> : null} Yes, cancel
                        </button>
                      </div>
                    )}
                  </div>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}

      {panelTab === 'past' && completed.length === 0 && (
        <div style={{ textAlign:'center', padding:'40px 20px', color:'var(--muted)', border:'1px dashed var(--line)', borderRadius:12 }}>
          <History size={30} style={{ opacity:.2, display:'block', margin:'0 auto 10px' }} />
          <div style={{ fontSize:13.5 }}>No past checkouts yet.</div>
        </div>
      )}
      {panelTab === 'past' && completed.length > 0 && completedView.length === 0 && (
        <div style={{ textAlign:'center', padding:'32px 20px', color:'var(--muted)', border:'1px dashed var(--line)', borderRadius:12, fontSize:13 }}>
          No past checkouts match these filters.
        </div>
      )}
      {panelTab === 'past' && onBatchReRequest && selectedPastIds.size > 0 && (
        <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap', marginBottom:12, padding:'10px 14px', borderRadius:10, border:'1px solid hsla(var(--color-green),0.35)', background:'hsla(var(--color-green),0.06)' }}>
          <span style={{ fontSize:13, fontWeight:600 }}>
            {batchItems.length} item{batchItems.length !== 1 ? 's' : ''} selected
            {selectedPastIds.size > batchItems.length && <span style={{ color:'var(--muted)', fontWeight:500 }}> (repeats counted once)</span>}
          </span>
          <button onClick={() => setSelectedPastIds(new Set())}
            style={{ background:'none', border:'none', cursor:'pointer', color:'var(--muted)', fontSize:12.5, fontFamily:'Inter,sans-serif', fontWeight:600, padding:'2px 4px' }}>
            Clear
          </button>
          <button className="primary-btn" onClick={() => setBatchReRequestOpen(true)}
            style={{ marginLeft:'auto', fontSize:12.5, display:'inline-flex', alignItems:'center', gap:5, padding:'6px 14px' }}>
            <RotateCcw size={13} /> Request again ({batchItems.length})
          </button>
        </div>
      )}
      {panelTab === 'past' && completedView.length > 0 && (() => {
        // Group by order like Active Checkouts - Req # makes "what was taken
        // with what" traceable; checkboxes work per order and per item
        const visible = completedView.slice(0, 60);
        const groups = [];
        const gmap = new Map();
        for (const c of visible) {
          const key = c.orderId || c.id;
          if (!gmap.has(key)) { const arr = []; gmap.set(key, arr); groups.push([key, arr]); }
          gmap.get(key).push(c);
        }
        const togglePastIds = ids => setSelectedPastIds(prev => {
          const next = new Set(prev);
          const allIn = ids.every(id => next.has(id));
          ids.forEach(id => allIn ? next.delete(id) : next.add(id));
          return next;
        });
        const allIds = visible.map(c => c.id);
        const allSel = allIds.length > 0 && allIds.every(id => selectedPastIds.has(id));
        const someSel = allIds.some(id => selectedPastIds.has(id));
        const renderRow = (c, idx, isMulti, groupKey) => {
          const sm = CHECKOUT_STATUS_META[c.status];
          return (
            <div key={c.id} style={{ borderTop: idx > 0 ? '1px solid var(--line)' : 'none', padding:'10px 16px', display:'flex', alignItems:'flex-start', gap:10, flexWrap:'wrap' }}>
              {onBatchReRequest && (
                <input type="checkbox" checked={selectedPastIds.has(c.id)}
                  onChange={() => togglePastIds([c.id])}
                  title="Select to request again"
                  style={{ cursor:'pointer', accentColor:'var(--pine)', marginTop:3, flexShrink:0 }} />
              )}
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontWeight:600, fontSize:13, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{c.itemName}</div>
                <div style={{ fontSize:11.5, color:'var(--muted)' }}>
                  {fmtDate(c.createdAt)}{!isMulti && <> · Req #{requestNo(groupKey)}</>}
                </div>
                {c.status === 'rejected' && c.rejectReason && (
                  <div style={{ fontSize:11.5, color:'hsl(var(--color-red))', marginTop:3 }}>Reason of rejection: "{c.rejectReason}"</div>
                )}
              </div>
              <span style={{ display:'inline-flex', alignItems:'center', gap:4, padding:'2px 8px', borderRadius:20, fontSize:11, fontWeight:700, background:sm.bg, color:sm.fg, flexShrink:0 }}>
                <sm.Icon size={10} /> {sm.label}
              </span>
              {c.returnPhotoUrl && (
                <button onClick={() => setPhotoPreview(c.returnPhotoUrl)} style={{ background:'none', border:'none', cursor:'pointer', color:'var(--muted)', display:'flex', padding:4 }} title="View return photo">
                  <ZoomIn size={14} />
                </button>
              )}
            </div>
          );
        };
        return (
          <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
            {onBatchReRequest && (
              <label style={{ display:'flex', alignItems:'center', gap:10, padding:'2px 16px', cursor:'pointer', userSelect:'none' }}>
                <input type="checkbox" checked={allSel}
                  ref={el => { if (el) el.indeterminate = someSel && !allSel; }}
                  onChange={() => setSelectedPastIds(allSel ? new Set() : new Set(allIds))}
                  style={{ cursor:'pointer', accentColor:'var(--pine)', flexShrink:0 }} />
                <span style={{ fontSize:12, fontWeight:600, color:'var(--muted)' }}>
                  {someSel ? `${allIds.filter(id => selectedPastIds.has(id)).length} of ${allIds.length} selected` : `Select all (${allIds.length})`}
                </span>
              </label>
            )}
            {groups.map(([key, items]) => {
              const isMulti = items.length > 1;
              const gIds = items.map(c => c.id);
              const gAll = gIds.every(id => selectedPastIds.has(id));
              const gSome = gIds.some(id => selectedPastIds.has(id));
              return (
                <div key={key} style={{ border:'1px solid var(--line)', borderRadius:12, overflow:'hidden', background:'var(--card)', boxShadow:'var(--shadow-sm)' }}>
                  {isMulti && (
                    <label style={{ padding:'9px 16px', background:'var(--mist)', borderBottom:'1px solid var(--line)', display:'flex', alignItems:'center', gap:9, flexWrap:'wrap', cursor: onBatchReRequest ? 'pointer' : 'default', userSelect:'none' }}>
                      {onBatchReRequest && (
                        <input type="checkbox" checked={gAll}
                          ref={el => { if (el) el.indeterminate = gSome && !gAll; }}
                          onChange={() => togglePastIds(gIds)}
                          title="Select the whole order"
                          style={{ cursor:'pointer', accentColor:'var(--pine)', flexShrink:0 }} />
                      )}
                      <ShoppingCart size={12} color="hsl(var(--color-blue))" />
                      <span style={{ fontSize:12, fontWeight:700, color:'hsl(var(--color-blue))' }}>Order · {items.length} Items</span>
                      <span style={{ fontSize:11.5, color:'var(--muted)' }}>· {fmtDate(items[0].createdAt)} · Req #{requestNo(key)}</span>
                    </label>
                  )}
                  {items.map((c, idx) => renderRow(c, idx, isMulti, key))}
                </div>
              );
            })}
          </div>
        );
      })()}

      {photoPreview && <ImageLightbox src={photoPreview} onClose={() => setPhotoPreview(null)} />}
      {acceptingCo && onEmployeeAccept && (
        <EmployeeAcceptModal
          checkout={acceptingCo}
          photoOptional={photoOptionalIds.has(acceptingCo.itemId)}
          onClose={() => setAcceptingCo(null)}
          onConfirm={(url, name) => onEmployeeAccept(acceptingCo, url, name).then(() => setAcceptingCo(null))}
        />
      )}
      {confirmingCo && onConfirmReceipt && (() => {
        const isArr = Array.isArray(confirmingCo);
        const coList = isArr ? confirmingCo : [confirmingCo];
        return (
          <ReceiptConfirmModal
            checkouts={coList}
            photoOptional={coList.every(co => photoOptionalIds.has(co.itemId))}
            onClose={() => setConfirmingCo(null)}
            onConfirm={async ({ batch, photoMap }) => {
              // Sequential so the backend's per-order notification batching
              // sees each receipt committed in turn (one final notification)
              for (const co of coList) {
                await onConfirmReceipt(co, batch, photoMap);
              }
              setConfirmingCo(null);
            }}
          />
        );
      })()}
      {returnAllGroup && onReturnAll && (
        <ReturnModal
          checkout={{ itemName: `${returnAllGroup.length} items from your order` }}
          photoOptional={returnAllGroup.every(co => photoOptionalIds.has(co.itemId))}
          onClose={() => setReturnAllGroup(null)}
          onSubmit={data =>
            onReturnAll(returnAllGroup, data).then(() => setReturnAllGroup(null))
          }
        />
      )}
      {extendingCo && onRequestExtension && (
        <ExtendRequestModal
          checkout={extendingCo}
          onClose={() => setExtendingCo(null)}
          onSubmit={({ days, reason }) => onRequestExtension(extendingCo, days, reason)}
        />
      )}
      {batchReRequestOpen && onBatchReRequest && (
        <BatchReRequestModal
          checkouts={batchItems}
          onClose={() => setBatchReRequestOpen(false)}
          onSubmit={vals => onBatchReRequest(batchItems, vals).then(() => {
            setBatchReRequestOpen(false);
            setSelectedPastIds(new Set());
          })}
        />
      )}
    </div>
  );
});

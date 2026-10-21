// Workday > Purchase Requests (Neil, Oct 22 2026: "move Purchase Requisition
// out of Item Management and into Workday ... that is the place where we have
// all HR and expense reimbursement"). One screen for everyone:
//   - New Purchase Request opens the request form in a popup.
//   - My Requests: what I asked for (or someone asked for on my behalf).
//   - Approvals (Item Management managers - the same `isManager` rule the old
//     Item Management tab used, and the backend's require_manager /
//     _require_fulfiller checks are unchanged): approve with who purchases &
//     fulfills it, reject with a reason, mark ordered, fulfill without adding,
//     or Received - Add to Items (the inventory Add Item form, prefilled).
// The assigned fulfiller gets the procurement actions on their rows too.
import { useState, useEffect, lazy, Suspense } from 'react';
import { ClipboardList, CheckCircle, XCircle, Send, Package, Plus, FileText, Link2, X, ShoppingCart, ArrowRight, ChevronDown } from 'lucide-react';
import { useMsal } from '@azure/msal-react';
import { useRequisitions } from '../contexts/RequisitionContext';
import { useInventory } from '../contexts/InventoryContext';
import { useRole } from '../contexts/RoleContext';
import { api } from '../api';
import { cleanName } from '../lib/utils';
import { formatDateLong, formatDateTime } from '../lib/datetime';
import { useIsMobile } from '../lib/useIsMobile';
import { Spinner } from './AsyncState';
import PurchaseRequestForm from './PurchaseRequestForm';

// The inventory Add Item form and the assign flow load only when someone
// actually receives an item - they live in Item Management's own chunk.
const AddItemModal = lazy(() => import('../views/InventoryManagement').then(m => ({ default: m.AddItemModal })));
const AssignItemModal = lazy(() => import('./Assignments').then(m => ({ default: m.AssignItemModal })));

// manager_approved displays as plain "Approved" in green - the raw status
// string leaking into the UI was Neil/Visesh feedback.
const PR_STATUS_META = {
  pending_manager:  { label:'Pending Approval', bg:'hsla(var(--color-orange),0.12)', fg:'hsl(var(--color-orange))' },
  manager_approved: { label:'Approved',         bg:'hsla(var(--color-green),0.12)',  fg:'hsl(var(--color-green))'  },
  ordered:          { label:'Ordered',          bg:'hsla(var(--color-blue),0.12)',   fg:'hsl(var(--color-blue))'   },
  fulfilled:        { label:'Fulfilled',        bg:'hsla(var(--color-green),0.12)',  fg:'hsl(var(--color-green))'  },
  rejected:         { label:'Rejected',         bg:'hsla(var(--color-red),0.12)',    fg:'hsl(var(--color-red))'    },
  asset_allocated:  { label:'Allocated',        bg:'hsla(var(--color-blue),0.12)',   fg:'hsl(var(--color-blue))'   },
  return_initiated: { label:'Return Initiated', bg:'hsla(var(--color-orange),0.12)', fg:'hsl(var(--color-orange))' },
  returned:         { label:'Returned',         bg:'hsla(var(--color-blue),0.12)',   fg:'hsl(var(--color-blue))'   },
  asset_lost:       { label:'Asset Lost',       bg:'hsla(var(--color-red),0.12)',    fg:'hsl(var(--color-red))'    },
};
const OPEN = ['pending_manager', 'manager_approved', 'ordered'];

/** Approver rule - identical to the old Item Management tab (manager tier OR an Item Management editor+ grant). */
function useIsPurchaseApprover() {
  const role = useRole() || {};
  return typeof role.canAccessModule === 'function' ? !!role.canAccessModule('inventory', 'manager', 'editor') : false;
}

function useMe() {
  const { accounts = [] } = useMsal() || {};
  return {
    userName: cleanName(accounts[0]?.name ?? 'Employee'),
    userEmail: (accounts[0]?.username ?? '').toLowerCase(),
  };
}

// Mine = I am the beneficiary, or I raised it on someone's behalf.
const isMineFor = (userEmail, userName) => (r) =>
  (!!userEmail && ((r.employeeEmail || '').toLowerCase() === userEmail || (r.submittedByEmail || '').toLowerCase() === userEmail))
  || (!!userName && r.employeeName === userName);

// Renders text with URLs as clickable links (truncated for readability).
function Linkify({ text }) {
  if (!text) return null;
  const parts = String(text).split(/(https?:\/\/[^\s"']+)/g);
  return parts.map((part, i) =>
    /^https?:\/\//.test(part) ? (
      <a key={i} href={part} target="_blank" rel="noopener noreferrer"
        onClick={e => e.stopPropagation()}
        style={{ color:'hsl(var(--color-blue))', fontWeight:600, wordBreak:'break-all' }}
        title={part}>
        {part.length > 64 ? `${part.slice(0, 60)}…` : part}
      </a>
    ) : part
  );
}

// The purchase form appends "Reference: <url>" to the reason - split it out
// so the link renders as its own clean action instead of a wall of URL text.
function splitReason(reason) {
  const m = (reason || '').match(/\s*Reference:\s*(https?:\/\/\S+)\s*$/i);
  if (!m) return { text: reason || '', link: null };
  return { text: (reason || '').replace(m[0], '').trim(), link: m[1] };
}

const SECTION = { fontSize:11.5, fontWeight:700, letterSpacing:'.07em', color:'var(--muted)', textTransform:'uppercase', margin:'20px 0 10px' };

function ModalShell({ title, sub, onClose, children }) {
  const phone = useIsMobile('(max-width: 640px)');
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.4)', zIndex:2000, display:'flex', alignItems:'center', justifyContent:'center', padding: phone ? 0 : 16 }}
      onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}
        style={phone
          ? { background:'var(--card)', width:'100%', height:'100%', display:'flex', flexDirection:'column' }
          : { background:'var(--card)', borderRadius:14, width:'60vw', minWidth:'min(420px, 100%)', maxWidth:'100%', minHeight:'60vh', maxHeight:'85vh', display:'flex', flexDirection:'column', boxShadow:'0 20px 60px rgba(0,0,0,0.3)' }}>
        <div style={{ padding:'16px 18px 12px', display:'flex', alignItems:'center', gap:10, borderBottom:'1px solid var(--line)' }}>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ fontWeight:700, fontSize:15, color:'var(--ink)' }}>{title}</div>
            {sub && <div style={{ fontSize:12, color:'var(--muted)' }}>{sub}</div>}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background:'none', border:'none', cursor:'pointer', color:'var(--muted)', padding:4 }}><X size={18} /></button>
        </div>
        <div style={{ flex:1, minHeight:0, overflowY:'auto', padding:'18px 20px', display:'flex', flexDirection:'column' }}>{children}</div>
      </div>
    </div>
  );
}

const LazyFallback = () => (
  <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.25)', zIndex:2000, display:'flex', alignItems:'center', justifyContent:'center' }}>
    <Spinner size={22} />
  </div>
);

/** Workday > Purchase Requests. `toast(message, kind)`; a changing `openNewKey` opens the form (deep link `purchase:new`). */
export default function PurchaseRequests({ toast, openNewKey = 0 }) {
  const ctx = useRequisitions() || {};
  const { requisitions = [], approveRequisition, rejectRequisition, markRequisitionOrdered, fulfillRequisition, exportToCsv } = ctx;
  const inventory = useInventory() || {};
  const { userName, userEmail } = useMe();
  const isManager = useIsPurchaseApprover();

  // 'mine' | 'queue'; until someone picks, an approver lands on Approvals
  // (role answers can arrive after the first render).
  const [pickedView,    setView]          = useState(null);
  const view = pickedView || (isManager ? 'queue' : 'mine');
  const [newOpen,       setNewOpen]       = useState(!!openNewKey);
  // A new openNewKey (the "purchase:new" deep link) opens the form again.
  const [seenNewKey,    setSeenNewKey]    = useState(openNewKey);
  if (openNewKey !== seenNewKey) {
    setSeenNewKey(openNewKey);
    if (openNewKey) setNewOpen(true);
  }
  const [rejectingId,   setRejectingId]   = useState(null);
  const [rejectReason,  setRejectReason]  = useState('');
  const [approvingId,   setApprovingId]   = useState(null);
  const [pickedFulfiller, setPickedFulfiller] = useState('');
  const [allocators,    setAllocators]    = useState([]);
  const [orderingId,    setOrderingId]    = useState(null);
  const [orderNote,     setOrderNote]     = useState('');
  const [noInvId,       setNoInvId]       = useState(null);
  const [noInvNote,     setNoInvNote]     = useState('');
  const [addingForReq,  setAddingForReq]  = useState(null); // requisition → prefilled AddItemModal
  const [assigning,     setAssigning]     = useState(null); // item just created with "assign right away"
  const [busyId,        setBusyId]        = useState(null);
  const [historyOpen,   setHistoryOpen]   = useState(() => new Set());

  useEffect(() => {
    if (isManager) api.getItemAllocators().then(setAllocators).catch(() => {});
  }, [isManager]);

  const fmtDate = iso => formatDateLong(iso);
  const isMine = isMineFor(userEmail, userName);
  const mine = requisitions.filter(isMine);

  // The assigned fulfiller (or any manager) gets the procurement actions
  const canFulfill = r => ['manager_approved', 'ordered'].includes(r.status) &&
    (isManager || (!!userEmail && (r.allocatorEmail || '').toLowerCase() === userEmail));
  // Someone who is not an approver but was picked to purchase something.
  const toFulfillForMe = isManager ? [] : requisitions.filter(r => canFulfill(r) && !isMine(r));
  const pendingCount = isManager ? requisitions.filter(r => r.status === 'pending_manager').length : 0;

  function submitApprove(r) {
    const chosen = allocators.find(a => a.email === pickedFulfiller);
    if (!chosen) return;
    setBusyId(r.id);
    Promise.resolve(approveRequisition(r.id, userName, { email: chosen.email, name: chosen.name }))
      .then(() => { toast?.(`Approved - ${chosen.name} will purchase ${r.item}.`); setApprovingId(null); setPickedFulfiller(''); })
      .catch(err => toast?.(err?.message || 'Could not approve.', 'error'))
      .finally(() => setBusyId(null));
  }

  function submitReject(r) {
    const reason = rejectReason.trim();
    if (!reason) return;
    setBusyId(r.id);
    Promise.resolve(rejectRequisition(r.id, userName, reason))
      .then(() => { setRejectingId(null); setRejectReason(''); })
      .catch(err => toast?.(err?.message || 'Could not reject.', 'error'))
      .finally(() => setBusyId(null));
  }

  function submitOrdered(r) {
    setBusyId(r.id);
    Promise.resolve(markRequisitionOrdered(r.id, userName, orderNote.trim()))
      .then(() => { toast?.(`${r.item} marked as ordered.`); setOrderingId(null); setOrderNote(''); })
      .catch(err => toast?.(err?.message || 'Could not mark as ordered.', 'error'))
      .finally(() => setBusyId(null));
  }

  function submitNoInventory(r) {
    if (!noInvNote.trim()) return;
    setBusyId(r.id);
    Promise.resolve(fulfillRequisition(r.id, userName, { note: noInvNote.trim() }))
      .then(() => { toast?.(`${r.item} fulfilled.`); setNoInvId(null); setNoInvNote(''); })
      .catch(err => toast?.(err?.message || 'Could not fulfill.', 'error'))
      .finally(() => setBusyId(null));
  }

  const toggleHistory = (id) => setHistoryOpen(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  function renderCard(r) {
    const sm = PR_STATUS_META[r.status] || { label: r.status, bg:'var(--mist)', fg:'var(--muted)' };
    const isRej = rejectingId === r.id;
    const { text: reasonText, link: refLink } = splitReason(r.reason);
    let refHost = '';
    if (refLink) { try { refHost = new URL(refLink).hostname.replace(/^www\./, ''); } catch { refHost = 'link'; } }
    const history = Array.isArray(r.history) ? r.history : [];
    const showHistory = historyOpen.has(r.id);
    return (
      <div key={r.id} data-req-id={r.id} style={{ border:'1px solid var(--line)', borderRadius:12, padding:'16px 20px', background:'var(--card)', boxShadow:'var(--shadow-sm)', marginBottom:10 }}>
        <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:12, flexWrap:'wrap' }}>
          <div style={{ display:'flex', gap:12, alignItems:'flex-start', flex:1, minWidth:0 }}>
            <div style={{ width:38, height:38, borderRadius:10, background:'hsla(var(--color-orange),0.12)', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
              <ClipboardList size={17} color="hsl(var(--color-orange))" />
            </div>
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
                <span style={{ fontWeight:700, fontSize:14 }}>{r.item}</span>
                <span style={{ fontSize:11, fontWeight:800, color:'hsl(var(--color-blue))', background:'hsla(var(--color-blue),0.10)', borderRadius:20, padding:'2px 9px' }}>×{r.quantity}</span>
              </div>
              <div style={{ fontSize:12, color:'var(--muted)', marginTop:3 }}>
                <strong style={{ color:'var(--ink)', fontWeight:600 }}>{r.employeeName}</strong> · {r.employeeDept}
                {r.createdAt && <> · {fmtDate(r.createdAt)}</>}
              </div>
              {r.allocatorName && ['manager_approved','ordered','fulfilled'].includes(r.status) && (
                <div style={{ fontSize:12, color:'var(--muted)', marginTop:2 }}>
                  Fulfillment: <strong style={{ color:'hsl(var(--color-purple))', fontWeight:600 }}>{r.allocatorName}</strong>
                  {r.status === 'ordered' && r.orderedAt && <> · ordered {fmtDate(r.orderedAt)}</>}
                  {r.status === 'fulfilled' && r.fulfilledAt && <> · fulfilled {fmtDate(r.fulfilledAt)}</>}
                </div>
              )}
              {r.fulfillmentNote && r.status === 'fulfilled' && (
                <div style={{ fontSize:12, color:'var(--muted)', marginTop:2, fontStyle:'italic' }}>{r.fulfillmentNote}</div>
              )}
            </div>
          </div>
          <span style={{ display:'inline-flex', alignItems:'center', padding:'3px 10px', borderRadius:20, fontSize:11, fontWeight:700, background:sm.bg, color:sm.fg, flexShrink:0 }}>
            {sm.label}
          </span>
        </div>
        {reasonText && (
          <div style={{ fontSize:12.5, color:'var(--ink)', marginTop:12, background:'var(--mist)', borderLeft:'3px solid var(--line)', borderRadius:'0 8px 8px 0', padding:'8px 12px', lineHeight:1.5, whiteSpace:'pre-line' }}>
            <Linkify text={reasonText} />
          </div>
        )}
        {refLink && (
          <a href={refLink} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}
            style={{ display:'inline-flex', alignItems:'center', gap:6, marginTop:10, padding:'6px 12px', borderRadius:8, border:'1px solid hsla(var(--color-blue),0.3)', background:'hsla(var(--color-blue),0.06)', color:'hsl(var(--color-blue))', fontSize:12, fontWeight:700, textDecoration:'none' }}
            title={refLink}>
            <Link2 size={13} /> View Reference - {refHost}
          </a>
        )}
        {r.rejectionReason && <div style={{ fontSize:12, color:'hsl(var(--color-red))', marginTop:10 }}>Reason for rejection: "{r.rejectionReason}"</div>}
        {history.length > 0 && (
          <div style={{ marginTop:10 }}>
            <button type="button" onClick={() => toggleHistory(r.id)} aria-expanded={showHistory}
              style={{ display:'inline-flex', alignItems:'center', gap:4, background:'none', border:'none', padding:0, cursor:'pointer', fontSize:12, fontWeight:600, color:'var(--muted)', fontFamily:'Inter,sans-serif' }}>
              <ChevronDown size={13} style={{ transform: showHistory ? 'rotate(180deg)' : 'none', transition:'transform .15s ease' }} />
              History ({history.length})
            </button>
            {showHistory && (
              <ol style={{ listStyle:'none', margin:'8px 0 0', padding:'0 0 0 12px', borderLeft:'2px solid var(--line)', display:'flex', flexDirection:'column', gap:6 }}>
                {history.map((h, i) => (
                  <li key={i} style={{ fontSize:12, color:'var(--ink)' }}>
                    <strong style={{ fontWeight:600 }}>{h.action}</strong>{h.by ? ` by ${h.by}` : ''}
                    {h.date && <span style={{ color:'var(--muted)' }}> · {formatDateTime(h.date)}</span>}
                    {h.comment && <div style={{ color:'var(--muted)' }}>{h.comment}</div>}
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
        {isManager && r.status === 'pending_manager' && (
          isRej ? (
            <div style={{ marginTop:12, display:'flex', flexDirection:'column', gap:8 }}>
              <input className="form-input" autoFocus placeholder="Reason for rejection…" value={rejectReason}
                onChange={e => setRejectReason(e.target.value)}
                style={{ fontSize:13, padding:'8px 12px' }} />
              <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
                <button className="secondary-btn" style={{ fontSize:12 }} onClick={() => { setRejectingId(null); setRejectReason(''); }} disabled={busyId === r.id}>Cancel</button>
                <button className="primary-btn" style={{ fontSize:12, background:'hsl(var(--color-red))', display:'inline-flex', alignItems:'center', gap:5 }}
                  disabled={!rejectReason.trim() || busyId === r.id} onClick={() => submitReject(r)}>
                  {busyId === r.id ? <Spinner size={13} /> : <XCircle size={13} />} Confirm Reject
                </button>
              </div>
            </div>
          ) : approvingId === r.id ? (
            /* Approval = pick who purchases & fulfills (mirrors checkout allocators) */
            <div style={{ marginTop:12, display:'flex', flexDirection:'column', gap:8 }}>
              <label htmlFor={`pr-fulfiller-${r.id}`} style={{ fontSize:12.5, fontWeight:700, color:'hsl(var(--color-green))' }}>Who should purchase & fulfill this?</label>
              <select id={`pr-fulfiller-${r.id}`} className="form-input" autoFocus value={pickedFulfiller} onChange={e => setPickedFulfiller(e.target.value)} style={{ fontSize:13, padding:'8px 12px' }}>
                <option value="">Select a person…</option>
                {allocators.map(a => <option key={a.email} value={a.email}>{a.name}</option>)}
              </select>
              <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
                <button className="secondary-btn" style={{ fontSize:12 }} onClick={() => { setApprovingId(null); setPickedFulfiller(''); }} disabled={busyId === r.id}>Cancel</button>
                <button className="primary-btn" style={{ fontSize:12, display:'inline-flex', alignItems:'center', gap:5 }}
                  disabled={!pickedFulfiller || busyId === r.id} onClick={() => submitApprove(r)}>
                  {busyId === r.id ? <Spinner size={13} /> : <CheckCircle size={13} />} Confirm Approval
                </button>
              </div>
            </div>
          ) : (
            <div style={{ display:'flex', gap:8, justifyContent:'flex-end', marginTop:12 }}>
              <button onClick={() => { setRejectingId(r.id); setRejectReason(''); setApprovingId(null); }}
                style={{ background:'none', border:'1px solid hsla(var(--color-red),0.4)', borderRadius:8, padding:'5px 12px', fontSize:12, cursor:'pointer', color:'hsl(var(--color-red))', fontWeight:600, display:'inline-flex', alignItems:'center', gap:5, fontFamily:'Inter,sans-serif' }}>
                <XCircle size={12} /> Reject
              </button>
              <button className="primary-btn" style={{ fontSize:12, display:'inline-flex', alignItems:'center', gap:5, padding:'6px 14px' }}
                onClick={() => { setApprovingId(r.id); setPickedFulfiller(''); setRejectingId(null); }}>
                <CheckCircle size={12} /> Approve
              </button>
            </div>
          )
        )}
        {/* Fulfillment actions - assigned fulfiller or any manager */}
        {canFulfill(r) && (
          orderingId === r.id ? (
            <div style={{ marginTop:12, display:'flex', flexDirection:'column', gap:8 }}>
              <input className="form-input" autoFocus placeholder="Optional note - vendor, expected arrival…" value={orderNote}
                onChange={e => setOrderNote(e.target.value)} style={{ fontSize:13, padding:'8px 12px' }} />
              <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
                <button className="secondary-btn" style={{ fontSize:12 }} onClick={() => { setOrderingId(null); setOrderNote(''); }} disabled={busyId === r.id}>Cancel</button>
                <button className="primary-btn" style={{ fontSize:12, display:'inline-flex', alignItems:'center', gap:5 }}
                  disabled={busyId === r.id} onClick={() => submitOrdered(r)}>
                  {busyId === r.id ? <Spinner size={13} /> : <Send size={13} />} Confirm Ordered
                </button>
              </div>
            </div>
          ) : noInvId === r.id ? (
            <div style={{ marginTop:12, display:'flex', flexDirection:'column', gap:8 }}>
              <input className="form-input" autoFocus placeholder="Required - where did it go? e.g. consumables handed to requester" value={noInvNote}
                onChange={e => setNoInvNote(e.target.value)} style={{ fontSize:13, padding:'8px 12px' }} />
              <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
                <button className="secondary-btn" style={{ fontSize:12 }} onClick={() => { setNoInvId(null); setNoInvNote(''); }} disabled={busyId === r.id}>Cancel</button>
                <button className="primary-btn" style={{ fontSize:12, display:'inline-flex', alignItems:'center', gap:5 }}
                  disabled={!noInvNote.trim() || busyId === r.id} onClick={() => submitNoInventory(r)}>
                  {busyId === r.id ? <Spinner size={13} /> : <CheckCircle size={13} />} Mark Fulfilled
                </button>
              </div>
            </div>
          ) : (
            <div style={{ display:'flex', gap:8, justifyContent:'flex-end', marginTop:12, flexWrap:'wrap' }}>
              {r.status === 'manager_approved' && (
                <button className="secondary-btn" style={{ fontSize:12, display:'inline-flex', alignItems:'center', gap:5 }}
                  onClick={() => { setOrderingId(r.id); setOrderNote(''); }}>
                  <Send size={12} /> Mark Ordered
                </button>
              )}
              <button className="secondary-btn" style={{ fontSize:12, display:'inline-flex', alignItems:'center', gap:5, color:'var(--muted)' }}
                title="For consumables that don't belong in the items list - a note is required"
                onClick={() => { setNoInvId(r.id); setNoInvNote(''); }}>
                <CheckCircle size={12} /> Fulfill Without Adding
              </button>
              <button className="primary-btn" style={{ fontSize:12, display:'inline-flex', alignItems:'center', gap:5 }}
                title="Item received - add it to the items catalog (and optionally assign it to the requester)"
                onClick={() => setAddingForReq(r)}>
                <Package size={12} /> Received - Add to Items
              </button>
            </div>
          )
        )}
      </div>
    );
  }

  // pending / in progress / past, the order the old tab used.
  function renderSections(list, { emptyTitle, emptyText }) {
    const pending  = list.filter(r => r.status === 'pending_manager');
    const active   = list.filter(r => ['manager_approved', 'ordered'].includes(r.status));
    const resolved = list.filter(r => !OPEN.includes(r.status));
    if (list.length === 0) {
      return (
        <div style={{ padding:'56px 0', textAlign:'center', color:'var(--muted)' }}>
          <FileText size={36} style={{ opacity:.15, display:'block', margin:'0 auto 14px' }} />
          <div style={{ fontWeight:700, fontSize:15, marginBottom:6 }}>{emptyTitle}</div>
          <div style={{ fontSize:13 }}>{emptyText}</div>
        </div>
      );
    }
    return (
      <>
        {pending.length > 0 && (<>
          <div style={{ ...SECTION, marginTop:4 }}>Pending Approval - {pending.length}</div>
          {pending.map(renderCard)}
        </>)}
        {active.length > 0 && (<>
          <div style={SECTION}>{active.some(canFulfill) ? 'To Fulfill' : 'In Progress'} - {active.length}</div>
          {active.map(renderCard)}
        </>)}
        {resolved.length > 0 && (<>
          <div style={SECTION}>Past Requests - {resolved.length}</div>
          {resolved.map(renderCard)}
        </>)}
      </>
    );
  }

  return (
    <div>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:12, flexWrap:'wrap', marginBottom:14 }}>
        {isManager ? (
          <div className="wd-seg" role="tablist" aria-label="Purchase Requests">
            <button type="button" role="tab" aria-selected={view === 'queue'} className={view === 'queue' ? 'on' : ''} onClick={() => setView('queue')}>
              Approvals{pendingCount > 0 ? ` (${pendingCount})` : ''}
            </button>
            <button type="button" role="tab" aria-selected={view === 'mine'} className={view === 'mine' ? 'on' : ''} onClick={() => setView('mine')}>
              My Requests
            </button>
          </div>
        ) : (
          <div style={{ fontSize:13.5, fontWeight:600, color:'var(--ink)' }}>My Requests</div>
        )}
        <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
          {requisitions.length > 0 && exportToCsv && (
            <button type="button" className="secondary-btn" onClick={exportToCsv} style={{ fontSize:12.5, display:'inline-flex', alignItems:'center', gap:6, padding:'7px 14px' }}>
              <FileText size={13} /> Export to CSV
            </button>
          )}
          <button type="button" className="primary-btn" style={{ fontSize:12.5, display:'inline-flex', alignItems:'center', gap:6, padding:'7px 16px' }}
            onClick={() => setNewOpen(true)}>
            <Plus size={13} /> New Purchase Request
          </button>
        </div>
      </div>

      {view === 'queue' && isManager
        ? renderSections(requisitions, { emptyTitle: 'No purchase requests yet', emptyText: 'Requests people submit will appear here for approval.' })
        : (<>
          {toFulfillForMe.length > 0 && (<>
            <div style={{ ...SECTION, marginTop:4 }}>Assigned to You to Purchase - {toFulfillForMe.length}</div>
            {toFulfillForMe.map(renderCard)}
          </>)}
          {renderSections(mine, { emptyTitle: 'No purchase requests yet', emptyText: 'Need something the company does not have? Click New Purchase Request.' })}
        </>)}

      {newOpen && (
        <ModalShell title="New Purchase Request" sub="It goes to the manager you pick for approval." onClose={() => setNewOpen(false)}>
          <PurchaseRequestForm onCancel={() => setNewOpen(false)}
            onSubmitted={() => { setNewOpen(false); setView('mine'); toast?.('Request submitted - it is now pending manager approval.'); }} />
        </ModalShell>
      )}

      {/* "Received - Add to Items": prefilled from the requisition; saving
          creates the real item, fulfills the requisition, and (via the
          assign-right-away checkbox) can flow straight into assignment. */}
      {addingForReq && (
        <Suspense fallback={<LazyFallback />}>
          <AddItemModal
            initial={{ name: addingForReq.item, department: addingForReq.employeeDept, ownershipType: 'permanent' }}
            onClose={() => setAddingForReq(null)}
            onSave={async (data, opts = {}) => {
              const created = await api.createItem(data);
              if (created?.id) inventory.addItemLocal?.(created);
              await fulfillRequisition(addingForReq.id, userName, { note: `Added to Items: ${data.name}`, itemId: created?.id || '' });
              toast?.(`${data.name} added to Items - requisition fulfilled.`);
              if (opts.assignNow && created?.id) setAssigning(created);
            }}
          />
        </Suspense>
      )}
      {assigning && (
        <Suspense fallback={<LazyFallback />}>
          <AssignItemModal item={assigning} mode="assign" userEmail={userEmail}
            locations={[...new Set((inventory.items || []).map(i => i.location).filter(Boolean))].sort()} toast={toast}
            onClose={() => setAssigning(null)}
            onDone={() => { inventory.refreshItems?.(); }} />
        </Suspense>
      )}
    </div>
  );
}

/** The Workday Overview shortcut beside Ask HR and Reimbursements. */
export function PurchaseRequestTile({ onOpen }) {
  const { requisitions = [] } = useRequisitions() || {};
  const { userName, userEmail } = useMe();
  const isManager = useIsPurchaseApprover();
  const isMine = isMineFor(userEmail, userName);
  const toApprove = isManager ? requisitions.filter(r => r.status === 'pending_manager').length : 0;
  const toFulfill = requisitions.filter(r => ['manager_approved', 'ordered'].includes(r.status)
    && !!userEmail && (r.allocatorEmail || '').toLowerCase() === userEmail).length;
  const myOpen = requisitions.filter(r => OPEN.includes(r.status) && isMine(r)).length;
  const waiting = toApprove + toFulfill;
  const sub = toApprove ? `${toApprove} to approve` : toFulfill ? `${toFulfill} to purchase`
    : myOpen ? `${myOpen} in progress` : 'Things the company should buy';
  return (
    <button type="button" className="dk-stat wd-stat wd-askhr wd-purchase" onClick={onOpen}
      aria-label={waiting || myOpen ? `Purchase Request, ${sub}` : 'Purchase Request'}>
      <span className="wd-askhr-badge" aria-hidden="true">
        <ShoppingCart size={18} />
        {waiting > 0 && <span className="wd-askhr-dot" />}
      </span>
      <span className="wd-stat-text">
        <span className="wd-askhr-title">Purchase Request</span>
        <span className={`wd-askhr-sub${waiting ? ' wd-askhr-sub--new' : ''}`}>{sub}</span>
      </span>
      <span className="wd-askhr-cta" aria-hidden="true">{waiting ? 'Review' : 'Open'} <ArrowRight size={13} /></span>
      <ArrowRight className="wd-askhr-go" size={15} aria-hidden="true" />
    </button>
  );
}

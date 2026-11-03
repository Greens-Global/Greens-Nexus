// Item Management - the item record (Items redesign, Neil 11/02/2026).
//
// A sheet from the right (the 60% rule): the photo, where the item is right
// now ("With Amy Lee since 10/29/2026"), the In Use track from the handover to
// the due date (orange while it runs, red once overdue, green once back), what
// this person may do with it, and ONE timeline of its checkouts, assignments
// and edits with the handover and return photos side by side.
import { useEffect, useMemo, useState } from 'react';
import { Pencil, ShoppingCart, RotateCcw, Clock, Wrench, User, Camera, CheckCircle, XCircle, Unlock, X as XIcon, MapPin, QrCode } from 'lucide-react';
import { SkeletonBlocks } from '../../components/AsyncState';
import { StatusLabel } from '../../components/StatusLabel';
import ProgressTrack from '../../ui/ProgressTrack';
import HoldButton, { HOLD_RECORD_MS } from '../../ui/HoldButton';
import { api } from '../../api';
import { useInventory } from '../../contexts/InventoryContext';
import { useRole } from '../../contexts/RoleContext';
import { formatDate } from '../../lib/datetime';
import { useAssignments, AssignItemModal, AcceptAssignmentModal, DeclineAssignmentModal, AssignmentReturnModal } from '../../components/Assignments';
import { checkoutWord, itemWord, assignmentWord } from '../model/words';
import { checkoutDueInfo, dueWords, fmtDueDate, loanProgress } from '../model/due';
import { itemTimeline } from '../model/timeline';
import { useItemsIdentity } from '../model/identity';
import { cleanField } from '../model/fields';
import { fmtMoney } from '../model/format';
import { useCheckoutActions } from '../checkout/useCheckoutActions';
import { AllocateModal } from '../checkout/AllocateModal';
import { ReturnModal } from '../checkout/ReturnModal';
import { ExtendRequestModal } from '../checkout/ExtendRequestModal';
import { ReceiptConfirmModal } from '../checkout/ReceiptConfirmModal';
import { EmployeeAcceptModal } from '../checkout/EmployeeAcceptModal';
import { ForceReturnModal } from '../checkout/ForceReturnModal';
import { PickAllocatorSheet } from '../checkout/PickAllocatorSheet';
import { addToCart, removeFromCart, useItemCart } from '../cart/useItemCart';
import { ImageLightbox } from '../ui/ImageLightbox';
import { NoPhoto } from '../ui/photos';
import { itemsToast } from '../ui/Toast';
import { ItemSheet, Z_RECORD } from '../ui/Sheet';
import { printItemTags } from '../scan/events';

const LIVE_CO = ['pending', 'approved', 'pending_receipt', 'allocated'];
const LIVE_ASG = ['pending_acceptance', 'active', 'return_initiated'];
const lc = (s) => String(s || '').toLowerCase();

function Fact({ label, children }) {
  if (children == null || children === '' || children === false) return null;
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--ink)', overflowWrap: 'anywhere' }}>{children}</div>
    </div>
  );
}

/** Where the item is right now, in one line. */
export function stateLine(item, co, asg) {
  if (co?.status === 'allocated') return `With ${co.requestedBy} since ${formatDate(co.handedOverAt || co.allocatedAt)}`;
  if (co?.status === 'pending_receipt') return `Handed to ${co.requestedBy} on ${formatDate(co.handedOverAt)} - waiting for them to confirm receipt`;
  if (co?.status === 'approved') return `Approved for ${co.requestedBy} - ${co.assignedAllocatorName ? `${co.assignedAllocatorName} hands it over` : 'waiting for the handover'}`;
  if (co?.status === 'pending') return `Requested by ${co.requestedBy} on ${formatDate(co.createdAt)}`;
  if (asg?.status === 'active') return `Assigned to ${asg.assigneeName || asg.assigneeEmail}${asg.acceptedAt ? ` since ${formatDate(asg.acceptedAt)}` : ''}`;
  if (asg?.status === 'pending_acceptance') return `Assigned to ${asg.assigneeName || asg.assigneeEmail} - waiting for them to accept`;
  if (asg?.status === 'return_initiated') return `${asg.assigneeName || asg.assigneeEmail} started a return on ${formatDate(asg.returnInitiatedAt)}`;
  if (item.opStatus === 'lost') return `Marked lost${item.opStatusPersonName ? ` (with ${item.opStatusPersonName})` : ''}`;
  if (item.opStatus === 'in_repair') return 'In repair';
  if (item.status === 'retired') return 'Retired';
  if (item.ownershipType === 'permanent') return item.location ? `At ${item.location}, not assigned to anyone` : 'Not assigned to anyone';
  return item.location ? `Available at ${item.location}` : 'Available';
}

// `fallbackItem`: the item as the server sent it for an item link or a scan
// (GET /items/by-code) when the screen's own list does not hold it.
export function ItemRecord({ itemId, onClose, onEdit, onOpenDetails, borrowable = true, fallbackItem = null }) {
  const { items = [], checkouts = [], itemsLoading, checkoutsLoading, refreshItems, patchItemLocal } = useInventory() || {};
  const { assignments, refreshAssignments } = useAssignments();
  const { canAccessModule } = useRole();
  const isManager = canAccessModule('inventory', 'manager', 'editor');
  const { myEmail } = useItemsIdentity();
  const actions = useCheckoutActions();
  const { inCart } = useItemCart();
  const [sheet, setSheet] = useState(null);    // { kind, co?, a?, reason? }
  const [audit, setAudit] = useState([]);
  const [lightbox, setLightbox] = useState(null);

  const item = items.find(i => i.id === itemId) || (fallbackItem?.id === itemId ? fallbackItem : null);
  const itemCos = useMemo(() => checkouts.filter(c => c.itemId === itemId), [checkouts, itemId]);
  const itemAsgs = useMemo(() => assignments.filter(a => a.itemId === itemId), [assignments, itemId]);
  const liveCo = itemCos.find(c => LIVE_CO.includes(c.status)) || null;
  const liveAsg = itemAsgs.find(a => LIVE_ASG.includes(a.status)) || null;

  useEffect(() => {
    if (!isManager || !itemId) return undefined;
    let alive = true;
    api.getItemsAuditLog({ q: itemId, limit: 60 })
      .then(res => { if (alive) setAudit((res?.rows || []).filter(r => r.resource_id === itemId)); })
      .catch(() => {});
    return () => { alive = false; };
  }, [isManager, itemId]);

  const timeline = useMemo(() => itemTimeline({ item, checkouts: itemCos, assignments: itemAsgs, audit }), [item, itemCos, itemAsgs, audit]);

  if (!item) {
    return (
      <ItemSheet title="Item" onClose={onClose} zIndex={Z_RECORD}>
        {(itemsLoading || checkoutsLoading) ? <SkeletonBlocks count={4} height={56} borderRadius={10} />
          : <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--muted)' }}>
              <div style={{ fontWeight: 600, color: 'var(--ink)', marginBottom: 4 }}>This item is not in your list</div>
              <div style={{ fontSize: 13 }}>It may have been deleted, or it belongs to another company.</div>
            </div>}
      </ItemSheet>
    );
  }

  const now = new Date();
  const due = liveCo ? checkoutDueInfo(liveCo, now) : null;
  const word = liveCo ? checkoutWord(liveCo, now) : liveAsg ? assignmentWord(liveAsg) : itemWord(item);
  const mineCo = liveCo && lc(liveCo.requestedByEmail) === lc(myEmail) ? liveCo : null;
  const mineAsg = liveAsg && lc(liveAsg.assigneeEmail) === lc(myEmail) ? liveAsg : null;
  const isMyAlloc = liveCo && lc(liveCo.assignedAllocatorEmail) === lc(myEmail);
  const photoOptional = item.pictureRequired === false;
  const canBorrow = !liveCo && !liveAsg && item.ownershipType === 'transient' && item.status === 'available'
    && !item.hasActiveRequest && item.opStatus !== 'lost' && borrowable;

  // ── The actions this person may take, most likely first ───────────────────
  const btns = [];
  const primary = (key, label, Icon, onClick) => btns.push(<button key={key} className="primary-btn" onClick={onClick} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon size={14} /> {label}</button>);
  const secondary = (key, label, Icon, onClick) => btns.push(<button key={key} className="secondary-btn" onClick={onClick} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon size={14} /> {label}</button>);
  if (mineCo?.status === 'allocated') {
    primary('ret', 'Start Return', RotateCcw, () => setSheet({ kind: 'return', co: mineCo }));
    if (mineCo.extensionStatus !== 'pending') secondary('ext', 'Extend', Clock, () => setSheet({ kind: 'extend', co: mineCo }));
  }
  if (mineCo?.status === 'pending_receipt') primary('rcpt', 'Confirm Receipt', Camera, () => setSheet({ kind: 'receipt', co: mineCo }));
  if (mineCo?.status === 'approved' && (isManager || isMyAlloc)) primary('take', 'Take It Now', Camera, () => setSheet({ kind: 'selftake', co: mineCo }));
  else if (liveCo?.status === 'approved' && (isManager || isMyAlloc)) primary('hand', 'Hand Over', Camera, () => setSheet({ kind: 'handover', co: liveCo }));
  if (liveCo?.status === 'approved' && isManager) secondary('alloc', liveCo.assignedAllocatorEmail ? 'Change Allocator' : 'Pick a New Allocator', User, () => setSheet({ kind: 'allocator', co: liveCo }));
  if (mineAsg?.status === 'pending_acceptance') {
    primary('acc', 'Accept', CheckCircle, () => setSheet({ kind: 'asg-accept', a: mineAsg }));
    secondary('dec', 'Decline', XCircle, () => setSheet({ kind: 'asg-decline', a: mineAsg }));
  }
  if (mineAsg?.status === 'active') {
    primary('asg-ret', 'Start Return', RotateCcw, () => setSheet({ kind: 'asg-return', a: mineAsg, reason: 'normal' }));
    secondary('asg-dead', 'Report Dead', XCircle, () => setSheet({ kind: 'asg-return', a: mineAsg, reason: 'dead' }));
    secondary('asg-lost', 'Report Lost', XCircle, () => setSheet({ kind: 'asg-return', a: mineAsg, reason: 'lost' }));
  }
  if (mineAsg?.status === 'return_initiated' && mineAsg.returnReason === 'reassign' && !mineAsg.returnPhotoUrl) {
    primary('asg-reret', 'Return With Photo', Camera, () => setSheet({ kind: 'asg-return', a: mineAsg, reason: 'reassign' }));
  }
  if (canBorrow) {
    if (inCart.has(item.id)) secondary('cart-x', 'Remove From Cart', XIcon, () => removeFromCart(item.id, { onError: m => itemsToast(m, 'error') }));
    else primary('cart', 'Add to Cart', ShoppingCart, () => addToCart(item, { onError: m => itemsToast(m, 'error'), onAdded: () => itemsToast(`${item.name} added to your cart.`) }));
  }
  if (isManager) {
    if (liveCo?.status === 'allocated' && !mineCo) secondary('force', 'Force Return', RotateCcw, () => setSheet({ kind: 'force', co: liveCo }));
    if (item.ownershipType === 'permanent' && !liveAsg) secondary('assign', 'Assign', User, () => setSheet({ kind: 'assign' }));
    if (item.ownershipType === 'permanent' && liveAsg?.status === 'active') secondary('reassign', 'Reassign', User, () => setSheet({ kind: 'assign' }));
    if (item.ownershipType === 'transient' && !liveCo) secondary('loc', 'Set Location', MapPin, () => setSheet({ kind: 'assign' }));
    if (item.opStatus !== 'in_repair' && !liveCo && !liveAsg) {
      secondary('repair', 'Mark In Repair', Wrench, () => api.updateItem(item.id, { op_status: 'in_repair' })
        .then(u => { patchItemLocal?.(u); itemsToast(`${item.name} marked in repair.`); })
        .catch(e => itemsToast(e?.message || 'Could not mark it in repair.', 'error')));
    }
    if (item.opStatus === 'in_repair') {
      secondary('fixed', 'Back in Service', CheckCircle, () => api.updateItem(item.id, { op_status: 'in_storage' })
        .then(u => { patchItemLocal?.(u); itemsToast(`${item.name} is back in service.`); })
        .catch(e => itemsToast(e?.message || 'Could not update it.', 'error')));
    }
    // Its QR tag (Items phase 4): the print-ready tag sheet for this one.
    secondary('tag', 'Print Tag', QrCode, () => printItemTags([item]));
    if (onEdit) secondary('edit', 'Edit Item', Pencil, () => onEdit(item));
  }

  const track = liveCo && (liveCo.status === 'allocated' || liveCo.status === 'pending_receipt') ? (
    <ProgressTrack
      value={loanProgress(liveCo, now) ?? 0}
      state={due?.overdue ? 'overdue' : 'live'}
      marker
      start={`Handed over ${formatDate(liveCo.handedOverAt || liveCo.allocatedAt)}`}
      end={due?.dueDay ? `Due ${formatDate(due.dueDay)}` : ''}
      label="Loan"
      note={<><b>{dueWords(liveCo, now)}</b>{due?.dueDay ? ` - due ${formatDate(due.dueDay)}` : ''}</>} />
  ) : null;
  const lastReturn = !liveCo && itemCos.find(c => c.status === 'returned');
  const doneTrack = !track && lastReturn && lastReturn.returnedAt && (Date.now() - new Date(lastReturn.returnedAt).getTime() < 7 * 86400000) ? (
    <ProgressTrack value={1} state="done" size="sm" label="Last loan"
      note={<><b>Returned</b> by {lastReturn.requestedBy} on {formatDate(lastReturn.returnedAt)}</>} />
  ) : null;

  const stuckReceipt = isManager && liveCo?.status === 'pending_receipt';
  const custom = Object.entries(item.customFields || {}).filter(([, v]) => v !== '' && v != null);
  const meta = [item.serialNumber, item.itemType, cleanField(item.department), cleanField(item.location)].filter(Boolean).join(' · ');

  return (
    <>
      <ItemSheet title={item.name} onClose={onClose} zIndex={Z_RECORD}>
        <div className="it-record">
          <div className="it-record-hero">
            {item.photoUrl
              ? <button type="button" className="it-record-photo" onClick={() => setLightbox(item.photoUrl)} aria-label="View photo">
                  <img src={item.photoUrl} alt={item.name} />
                </button>
              : <NoPhoto size={180} radius={12} style={{ width: '100%', maxWidth: 220, height: 165 }} />}
            <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <StatusLabel label={word.label} color={word.color} />
                {item.opStatus === 'lost' && liveCo == null && <StatusLabel label="Lost" color="#64748b" />}
                {meta && <span style={{ fontSize: 13, color: 'var(--muted)' }}>{meta}</span>}
              </div>
              <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--ink)' }}>{stateLine(item, liveCo, liveAsg)}</div>
              {liveCo && !track && fmtDueDate(liveCo) && <div style={{ fontSize: 13, color: 'var(--muted)' }}>Return by {fmtDueDate(liveCo)}</div>}
              {track}
              {doneTrack}
              {liveCo?.extensionStatus === 'pending' && (
                <div style={{ fontSize: 13, color: 'var(--muted)' }}>Asked for {liveCo.extensionDays} more day{liveCo.extensionDays === 1 ? '' : 's'} - waiting for a manager.</div>
              )}
              {btns.length > 0 && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>{btns}</div>}
              {stuckReceipt && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 4, padding: '10px 12px', border: '1px solid var(--wk-line2, var(--line))', borderRadius: 10 }}>
                  <span style={{ fontSize: 13, color: 'var(--muted)', flex: 1, minWidth: 200 }}>
                    Stuck waiting for {liveCo.requestedBy} to confirm receipt? Reconcile cancels this handover and frees the item.
                  </span>
                  <HoldButton size="sm" label="Reconcile" doneLabel="Reconciled" icon={Unlock} holdMs={HOLD_RECORD_MS}
                    fallbackMessage={`Cancel the unconfirmed handover of ${item.name} to ${liveCo.requestedBy}?`}
                    onConfirm={() => actions.reconcile(item, liveCo).then(() => undefined)} />
                </div>
              )}
            </div>
          </div>

          <section aria-label="Details" className="it-record-facts">
            <Fact label="Serial">{item.serialNumber}</Fact>
            <Fact label="Make and Model">{[cleanField(item.make), cleanField(item.model)].filter(Boolean).join(' ')}</Fact>
            <Fact label="Year">{cleanField(item.year)}</Fact>
            <Fact label="Ownership">{item.ownershipType === 'permanent' ? 'Permanent' : 'Temporary'}</Fact>
            <Fact label="Department">{cleanField(item.department)}</Fact>
            <Fact label="Location">{cleanField(item.location)}</Fact>
            {isManager && <Fact label="Value">{Number(item.assetValue) > 0 ? fmtMoney(item.assetValue) : ''}</Fact>}
            <Fact label="Photos">{item.pictureRequired === false ? 'Optional at handover and return' : ''}</Fact>
            {custom.map(([k, v]) => <Fact key={k} label={k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}>{typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v)}</Fact>)}
            {isManager && onOpenDetails && (
              <button type="button" className="secondary-btn" style={{ alignSelf: 'end', justifySelf: 'start', fontSize: 12.5 }} onClick={() => onOpenDetails(item)}>Custom Fields</button>
            )}
          </section>

          <section aria-label="Timeline">
            <h3 style={{ fontSize: 14, fontWeight: 700, margin: '0 0 10px' }}>Timeline</h3>
            {timeline.length === 0 ? (
              <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>Nothing has happened to this item yet.</p>
            ) : (
              <ol className="it-timeline">
                {timeline.slice(0, 80).map(e => (
                  <li key={e.id}>
                    <span className="it-tl-when">{formatDate(e.at)}</span>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13.5, color: 'var(--ink)' }}>{e.text}</div>
                      {e.detail && <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2 }}>{e.detail}</div>}
                      {e.photos.length > 0 && (
                        <div style={{ display: 'flex', gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
                          {e.photos.map(p => (
                            <button key={p.label} type="button" className="it-tl-photo" onClick={() => setLightbox(p.url)} aria-label={`View ${p.label} photo`}>
                              <img src={p.url} alt={p.label} loading="lazy" decoding="async" />
                              <span>{p.label}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      </ItemSheet>

      {sheet?.kind === 'return' && (
        <ReturnModal checkout={sheet.co} photoOptional={photoOptional} onClose={() => setSheet(null)}
          onSubmit={data => actions.returnOne(sheet.co, data)} />
      )}
      {sheet?.kind === 'extend' && (
        <ExtendRequestModal checkout={sheet.co} onClose={() => setSheet(null)} onSubmit={v => actions.requestExtension(sheet.co, v)} />
      )}
      {sheet?.kind === 'receipt' && (
        <ReceiptConfirmModal checkout={sheet.co} photoOptional={photoOptional} onClose={() => setSheet(null)}
          onConfirm={p => actions.confirmReceipt([sheet.co], p)} />
      )}
      {sheet?.kind === 'selftake' && (
        <EmployeeAcceptModal checkout={sheet.co} photoOptional={photoOptional} onClose={() => setSheet(null)}
          onConfirm={(url, name) => actions.selfTake(sheet.co, url, name)} />
      )}
      {sheet?.kind === 'handover' && (
        <AllocateModal checkout={sheet.co} photoOptional={photoOptional} onClose={() => setSheet(null)}
          onConfirm={p => actions.handOver([sheet.co], p)} />
      )}
      {sheet?.kind === 'allocator' && <PickAllocatorSheet checkout={sheet.co} onClose={() => setSheet(null)} />}
      {sheet?.kind === 'force' && (
        <ForceReturnModal checkout={sheet.co} onClose={() => setSheet(null)}
          onConfirm={(reason, condition) => actions.forceReturn([sheet.co], reason, condition)} />
      )}
      {sheet?.kind === 'assign' && (
        <AssignItemModal item={item} userEmail={myEmail} toast={itemsToast}
          locations={[...new Set(items.map(i => i.location).filter(Boolean))].sort()}
          onClose={() => setSheet(null)} onDone={() => { refreshAssignments(); refreshItems?.(); }} />
      )}
      {sheet?.kind === 'asg-accept' && <AcceptAssignmentModal a={sheet.a} toast={itemsToast} onClose={() => setSheet(null)} onDone={() => { refreshAssignments(); refreshItems?.(); setSheet(null); }} />}
      {sheet?.kind === 'asg-decline' && <DeclineAssignmentModal a={sheet.a} toast={itemsToast} onClose={() => setSheet(null)} onDone={() => { refreshAssignments(); setSheet(null); }} />}
      {sheet?.kind === 'asg-return' && <AssignmentReturnModal a={sheet.a} reason={sheet.reason} toast={itemsToast} onClose={() => setSheet(null)} onDone={() => { refreshAssignments(); setSheet(null); }} />}
      {lightbox && <ImageLightbox src={lightbox} alt={item.name} onClose={() => setLightbox(null)} />}
    </>
  );
}

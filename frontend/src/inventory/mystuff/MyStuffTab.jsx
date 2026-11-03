// Item Management - My Stuff (Items redesign, Neil 11/02/2026).
//
// Everything a person holds or waits on - checkouts and permanent
// assignments in ONE list, most urgent first (model/urgency.js): Overdue,
// Due Today, Your Action Needed, Waiting on Others, In Use. Each row says
// what it is, where it stands and the one next step, right on the row; a
// click opens the item record. Finished ones sit under History.
import { memo, useMemo, useState } from 'react';
import { Package, ChevronRight, RotateCcw, Camera, CheckCircle, Clock, ShoppingCart } from 'lucide-react';
import { ErrorBanner, SkeletonBlocks } from '../../components/AsyncState';
import { StatusLabel } from '../../components/StatusLabel';
import ProgressTrack from '../../ui/ProgressTrack';
import { formatDate } from '../../lib/datetime';
import { useAssignments, AcceptAssignmentModal, DeclineAssignmentModal, AssignmentReturnModal } from '../../components/Assignments';
import { GROUPS, myStuffRows, myHistory, groupCounts } from '../model/urgency';
import { checkoutWord, assignmentWord } from '../model/words';
import { checkoutDueInfo, dueWords, fmtDueDate, loanProgress } from '../model/due';
import { useCheckoutActions } from '../checkout/useCheckoutActions';
import { ReturnModal } from '../checkout/ReturnModal';
import { ExtendRequestModal } from '../checkout/ExtendRequestModal';
import { ReceiptConfirmModal } from '../checkout/ReceiptConfirmModal';
import { EmployeeAcceptModal } from '../checkout/EmployeeAcceptModal';
import { addToCart } from '../cart/useItemCart';
import { PhotoThumb } from '../ui/photos';
import { itemsToast } from '../ui/Toast';

const PAGE = 30;   // phones and long histories page instead of drawing everything

function subLine(r, now) {
  const co = r.kind === 'checkout' ? r.row : null;
  const a = r.kind === 'assignment' ? r.row : null;
  if (co) {
    if (co.status === 'pending') return `Waiting for approval${co.approverName ? ` from ${co.approverName}` : ''}${fmtDueDate(co) ? ` · Return by ${fmtDueDate(co)}` : ''}`;
    if (co.status === 'approved' && r.group === 'action') return `Approved - take it with a handover photo${fmtDueDate(co) ? ` · Return by ${fmtDueDate(co)}` : ''}`;
    if (co.status === 'approved') return `Approved - ${co.assignedAllocatorName ? `${co.assignedAllocatorName} hands it over` : 'waiting for the handover'}${fmtDueDate(co) ? ` · Return by ${fmtDueDate(co)}` : ''}`;
    if (co.status === 'pending_receipt') return `${co.allocatedBy || co.assignedAllocatorName || 'Your allocator'} handed it over - confirm you have it`;
    if (co.status === 'allocated') {
      const { dueDay } = checkoutDueInfo(co, now);
      return `${dueWords(co, now)}${dueDay ? ` · due ${formatDate(dueDay)}` : ''}${co.extensionStatus === 'pending' ? ' · more time asked for' : ''}`;
    }
  }
  if (a) {
    if (a.status === 'pending_acceptance') return `Assigned to you by ${a.assignedBy || 'a manager'} - accept it to confirm you have it`;
    if (a.status === 'active') return `Yours${a.acceptedAt ? ` since ${formatDate(a.acceptedAt)}` : ''}`;
    if (a.status === 'return_initiated') return a.returnReason === 'reassign' && !a.returnPhotoUrl
      ? `Being reassigned to ${a.nextAssigneeName || 'someone else'} - return it with a photo`
      : 'Return sent - waiting for a supervisor to accept it';
  }
  return '';
}

const Row = memo(function Row({ r, item, now, onOpen, onAct, isManager }) {
  const co = r.kind === 'checkout' ? r.row : null;
  const a = r.kind === 'assignment' ? r.row : null;
  const w = co ? checkoutWord(co, now) : assignmentWord(a);
  const name = co ? co.itemName : a.itemName;
  const itemId = co ? co.itemId : a.itemId;
  const inUse = co?.status === 'allocated';
  const action = co ? (
    co.status === 'allocated' ? { label: 'Start Return', Icon: RotateCcw, kind: 'return' }
    : co.status === 'pending_receipt' ? { label: 'Confirm Receipt', Icon: Camera, kind: 'receipt' }
    : co.status === 'approved' && r.group === 'action' ? { label: isManager ? 'Take It Now' : 'Take It', Icon: Camera, kind: 'selftake' }
    : null
  ) : (
    a.status === 'pending_acceptance' ? { label: 'Accept', Icon: CheckCircle, kind: 'asg-accept' }
    : a.status === 'return_initiated' && r.group === 'action' ? { label: 'Return With Photo', Icon: Camera, kind: 'asg-reassign' }
    : null
  );
  // A request not yet handed over can be canceled by its requester; once it
  // is handed over (Handed Over) only an items manager's Reconcile undoes it.
  const secondary = co?.status === 'allocated' && co.extensionStatus !== 'pending' ? { label: 'Extend', Icon: Clock, kind: 'extend' }
    : co && (co.status === 'pending' || co.status === 'approved') ? { label: 'Cancel', kind: 'cancel' }
    : a?.status === 'pending_acceptance' ? { label: 'Decline', kind: 'asg-decline' }
    : a?.status === 'active' ? { label: 'Start Return', Icon: RotateCcw, kind: 'asg-return' }
    : null;
  return (
    <div className="it-row" data-group={r.group}>
      <button type="button" className="it-row-main" onClick={() => onOpen(itemId)} aria-label={`Open ${name}`}>
        <PhotoThumb url={item?.photoUrl} name={name} size={44} />
        <span className="it-row-text">
          <span className="it-row-title">{name}</span>
          <span className="it-row-sub">{subLine(r, now)}</span>
          {inUse && (
            <ProgressTrack size="sm" value={loanProgress(co, now) ?? 0} state={checkoutDueInfo(co, now).overdue ? 'overdue' : 'live'}
              label={`${name} loan`} valueText={dueWords(co, now)} style={{ marginTop: 6, maxWidth: 320 }} />
          )}
        </span>
      </button>
      <StatusLabel label={w.label} color={w.color} size="sm" className="it-row-status" />
      <span className="it-row-acts">
        {secondary && (
          <button type="button" className="secondary-btn it-btn-sm" onClick={() => onAct(secondary.kind, r)}>{secondary.label}</button>
        )}
        {action && (
          <button type="button" className="primary-btn it-btn-sm" onClick={() => onAct(action.kind, r)}>
            <action.Icon size={13} /> {action.label}
          </button>
        )}
        <ChevronRight size={16} className="it-row-chev" aria-hidden="true" />
      </span>
    </div>
  );
});

export function MyStuffTab({ items = [], checkouts = [], me, isManager, itemsLoading, checkoutsLoading, checkoutsError, refreshCheckouts, onOpenItem, onBrowse }) {
  const { assignments, refreshAssignments } = useAssignments();
  const actions = useCheckoutActions();
  const [sheet, setSheet] = useState(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyShown, setHistoryShown] = useState(PAGE);
  const now = new Date();
  const itemById = useMemo(() => new Map(items.map(i => [i.id, i])), [items]);
  const rows = useMemo(() => myStuffRows(checkouts, assignments, me, { isManager }), [checkouts, assignments, me, isManager]);
  const counts = useMemo(() => groupCounts(rows), [rows]);
  const history = useMemo(() => myHistory(checkouts, assignments, me), [checkouts, assignments, me]);
  const photoOptional = (id) => itemById.get(id)?.pictureRequired === false;

  function act(kind, r) {
    if (kind === 'cancel') {
      actions.cancel(r.row).catch(e => itemsToast(e?.message || 'Could not cancel the request.', 'error'));
      return;
    }
    setSheet({ kind, row: r.row });
  }

  if (checkoutsError && !checkouts.length) return <ErrorBanner message="Could not load your items." onRetry={refreshCheckouts} />;
  if ((checkoutsLoading || itemsLoading) && !rows.length && !checkouts.length) return <SkeletonBlocks count={4} height={64} borderRadius={12} />;

  return (
    <div className="it-mystuff">
      {rows.length === 0 ? (
        <div className="it-empty">
          <span className="it-empty-ico"><Package size={20} /></span>
          <div className="it-empty-title">Nothing checked out right now</div>
          <div className="it-empty-sub">Items you borrow or are assigned show up here, most urgent first.</div>
          <button className="primary-btn" onClick={onBrowse} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 14 }}>
            <ShoppingCart size={14} /> Borrow Something
          </button>
        </div>
      ) : GROUPS.filter(g => counts[g.key]).map(g => (
        <section key={g.key} className="it-group" aria-label={g.label}>
          <h3 className="it-group-h">
            <span>{g.label}</span>
            <span className="it-count">{counts[g.key]}</span>
          </h3>
          <div className="it-list">
            {rows.filter(r => r.group === g.key).map(r => (
              <Row key={`${r.kind}:${r.row.id}`} r={r} item={itemById.get(r.row.itemId)} now={now}
                onOpen={onOpenItem} onAct={act} isManager={isManager} />
            ))}
          </div>
        </section>
      ))}

      {history.length > 0 && (
        <section className="it-group" aria-label="History">
          <button type="button" className="it-group-h it-group-toggle" aria-expanded={historyOpen} onClick={() => setHistoryOpen(o => !o)}>
            <span>History</span><span className="it-count">{history.length}</span>
            <ChevronRight size={15} style={{ transform: historyOpen ? 'rotate(90deg)' : 'none', transition: 'transform .15s', color: 'var(--muted)' }} />
          </button>
          {historyOpen && (
            <div className="it-list">
              {history.slice(0, historyShown).map(h => {
                const isCo = h.kind === 'checkout';
                const w = isCo ? checkoutWord(h.row, now) : assignmentWord(h.row);
                const item = itemById.get(h.row.itemId);
                const canAgain = isCo && item && item.ownershipType === 'transient';
                return (
                  <div key={`${h.kind}:${h.row.id}`} className="it-row is-quiet">
                    <button type="button" className="it-row-main" onClick={() => onOpenItem(h.row.itemId)}>
                      <PhotoThumb url={item?.photoUrl} name={h.row.itemName} size={36} />
                      <span className="it-row-text">
                        <span className="it-row-title">{h.row.itemName}</span>
                        <span className="it-row-sub">{h.at ? formatDate(h.at) : ''}{h.row.rejectReason ? ` · ${h.row.rejectReason}` : ''}</span>
                      </span>
                    </button>
                    <StatusLabel label={w.label} color={w.color} size="sm" className="it-row-status" />
                    <span className="it-row-acts">
                      {canAgain && (
                        <button type="button" className="secondary-btn it-btn-sm" onClick={() => { addToCart(item, { onError: m => itemsToast(m, 'error') }); itemsToast(`${item.name} added to your cart.`); }}>
                          Borrow Again
                        </button>
                      )}
                    </span>
                  </div>
                );
              })}
              {history.length > historyShown && (
                <button type="button" className="it-more" onClick={() => setHistoryShown(n => n + PAGE)}>Show {Math.min(PAGE, history.length - historyShown)} More</button>
              )}
            </div>
          )}
        </section>
      )}

      {sheet?.kind === 'return' && (
        <ReturnModal checkout={sheet.row} photoOptional={photoOptional(sheet.row.itemId)} onClose={() => setSheet(null)}
          onSubmit={data => actions.returnOne(sheet.row, data)} />
      )}
      {sheet?.kind === 'extend' && (
        <ExtendRequestModal checkout={sheet.row} onClose={() => setSheet(null)} onSubmit={v => actions.requestExtension(sheet.row, v)} />
      )}
      {sheet?.kind === 'receipt' && (
        <ReceiptConfirmModal checkout={sheet.row} photoOptional={photoOptional(sheet.row.itemId)} onClose={() => setSheet(null)}
          onConfirm={p => actions.confirmReceipt([sheet.row], p)} />
      )}
      {sheet?.kind === 'selftake' && (
        <EmployeeAcceptModal checkout={sheet.row} photoOptional={photoOptional(sheet.row.itemId)} onClose={() => setSheet(null)}
          onConfirm={(url, name) => actions.selfTake(sheet.row, url, name)} />
      )}
      {sheet?.kind === 'asg-accept' && <AcceptAssignmentModal a={sheet.row} toast={itemsToast} onClose={() => setSheet(null)} onDone={() => { refreshAssignments(); setSheet(null); }} />}
      {sheet?.kind === 'asg-decline' && <DeclineAssignmentModal a={sheet.row} toast={itemsToast} onClose={() => setSheet(null)} onDone={() => { refreshAssignments(); setSheet(null); }} />}
      {sheet?.kind === 'asg-return' && <AssignmentReturnModal a={sheet.row} reason="normal" toast={itemsToast} onClose={() => setSheet(null)} onDone={() => { refreshAssignments(); setSheet(null); }} />}
      {sheet?.kind === 'asg-reassign' && <AssignmentReturnModal a={sheet.row} reason="reassign" toast={itemsToast} onClose={() => setSheet(null)} onDone={() => { refreshAssignments(); setSheet(null); }} />}
    </div>
  );
}

// Item Management - Requests (Items redesign, Neil 11/02/2026).
//
// The work queue for items managers and allocators: approve, hand over,
// accept returns. Queues (in the address: requests:<queue>) - To Approve,
// To Hand Over, Returns, Overdue, In Use, Assignments, Done. Rows are compact
// and grouped by request (one cart = one request): Approve All / Hand Over
// All act on the request, never on the whole list. Nobody approves their own
// request - it shows as "Your request" with no Approve. An allocator who is
// not an items manager sees only what they hand over.
import { memo, useMemo, useState } from 'react';
import { Search, X, CheckCircle, Camera, RotateCcw, Megaphone, Unlock, ChevronRight } from 'lucide-react';
import { ErrorBanner, SkeletonBlocks } from '../../components/AsyncState';
import { StatusLabel } from '../../components/StatusLabel';
import HoldButton, { HOLD_RECORD_MS } from '../../ui/HoldButton';
import { formatDate } from '../../lib/datetime';
import { useAssignments, AssignmentsQueue, AcceptReturnModal } from '../../components/Assignments';
import { checkoutWord, assignmentWord } from '../model/words';
import { checkoutDueInfo, dueWords, fmtDueDate } from '../model/due';
import { requestNo } from '../model/format';
import { useItemsIdentity } from '../model/identity';
import { useCheckoutActions } from '../checkout/useCheckoutActions';
import { ApproveCheckoutModal } from '../checkout/ApproveCheckoutModal';
import { RejectCheckoutModal } from '../checkout/RejectCheckoutModal';
import { AllocateModal } from '../checkout/AllocateModal';
import { ForceReturnModal } from '../checkout/ForceReturnModal';
import { OverdueAlertModal } from '../admin/OverdueAlertModal';
import { PhotoThumb } from '../ui/photos';
import { itemsToast } from '../ui/Toast';

const lc = (s) => String(s || '').toLowerCase();
const DONE = new Set(['returned', 'rejected', 'cancelled']);
const DONE_PAGE = 60;

const QUEUE_LABEL = {
  approve: 'To Approve', handover: 'To Hand Over', returns: 'Returns', overdue: 'Overdue',
  inuse: 'In Use', assignments: 'Assignments', done: 'Done',
};

/** Which queue a checkout sits in (null = none of them). */
export function checkoutQueue(co, now = new Date()) {
  if (co.status === 'pending') return 'approve';
  if (co.status === 'approved') return 'handover';
  if (co.status === 'allocated') {
    if (co.extensionStatus === 'pending') return 'approve';
    return checkoutDueInfo(co, now).overdue ? 'overdue' : 'inuse';
  }
  if (co.status === 'pending_receipt') return 'inuse';
  if (DONE.has(co.status)) return 'done';
  return null;
}

/** Every queue's rows for this person. Allocators (not items managers) get
 *  only the approved items assigned to them to hand over. */
export function buildQueues(checkouts = [], assignments = [], { me = '', isManager = false, now = new Date() } = {}) {
  const q = { approve: [], handover: [], returns: [], overdue: [], inuse: [], assignments: [], done: [] };
  for (const co of checkouts) {
    if (!isManager && !(co.status === 'approved' && lc(co.assignedAllocatorEmail) === lc(me))) continue;
    const k = checkoutQueue(co, now);
    if (k) q[k].push(co);
    // An overdue item asked to be extended is in both: approve it, or chase it.
    if (co.status === 'allocated' && co.extensionStatus === 'pending' && checkoutDueInfo(co, now).overdue) q.overdue.push(co);
  }
  if (isManager) {
    q.returns = assignments.filter(a => a.status === 'return_initiated');
    q.assignments = assignments.filter(a => ['pending_acceptance', 'active', 'return_initiated'].includes(a.status));
  }
  q.done.sort((a, b) => String(b.returnedAt || b.resolvedAt || b.createdAt).localeCompare(String(a.returnedAt || a.resolvedAt || a.createdAt)));
  return q;
}

/** Group checkouts by request (orderId, else the checkout alone), newest first. */
export function groupByRequest(list) {
  const map = new Map();
  for (const co of list) {
    const key = co.orderId || co.id;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(co);
  }
  return [...map.entries()].map(([key, cos]) => ({ key, cos }))
    .sort((a, b) => String(b.cos[0].createdAt).localeCompare(String(a.cos[0].createdAt)));
}

const ReqRow = memo(function ReqRow({ co, item, queue, now, me, isManager, onOpen, onAct }) {
  const w = checkoutWord(co, now);
  const mine = lc(co.requestedByEmail) === lc(me);
  const due = fmtDueDate(co);
  const sub = co.status === 'allocated' || co.status === 'pending_receipt'
    ? [co.status === 'pending_receipt' ? 'Waiting for receipt' : dueWords(co, now), due ? `due ${due}` : ''].filter(Boolean).join(' · ')
    : [due ? `Return by ${due}` : `${co.days} day${co.days === 1 ? '' : 's'}`, co.status === 'approved' && co.assignedAllocatorName ? `${co.assignedAllocatorName} hands it over` : ''].filter(Boolean).join(' · ');
  const ext = co.status === 'allocated' && co.extensionStatus === 'pending';
  return (
    <div className="it-row is-compact">
      <button type="button" className="it-row-main" onClick={() => onOpen(co.itemId)} aria-label={`Open ${co.itemName}`}>
        <PhotoThumb url={item?.photoUrl} name={co.itemName} size={36} />
        <span className="it-row-text">
          <span className="it-row-title">{co.itemName}</span>
          <span className="it-row-sub">{sub}{co.rejectReason ? ` · ${co.rejectReason}` : ''}</span>
          {ext && <span className="it-row-sub" style={{ color: 'var(--ink)' }}>Asks for {co.extensionDays} more day{co.extensionDays === 1 ? '' : 's'}{co.extensionReason ? ` - "${co.extensionReason}"` : ''}</span>}
        </span>
      </button>
      <StatusLabel label={w.label} color={w.color} size="sm" className="it-row-status" />
      <span className="it-row-acts">
        {queue === 'approve' && co.status === 'pending' && (mine
          ? <span className="it-row-note">Your request</span>
          : <>
              <button type="button" className="secondary-btn it-btn-sm" onClick={() => onAct('reject', [co])}>Reject</button>
              <button type="button" className="primary-btn it-btn-sm" onClick={() => onAct('approve', [co])}><CheckCircle size={13} /> Approve</button>
            </>)}
        {ext && isManager && !mine && (
          <>
            <button type="button" className="secondary-btn it-btn-sm" onClick={() => onAct('ext-reject', [co])}>Decline</button>
            <button type="button" className="primary-btn it-btn-sm" onClick={() => onAct('ext-approve', [co])}><CheckCircle size={13} /> Approve Extension</button>
          </>
        )}
        {queue === 'handover' && (
          <button type="button" className="primary-btn it-btn-sm" onClick={() => onAct('handover', [co])}><Camera size={13} /> Hand Over</button>
        )}
        {(queue === 'overdue' || queue === 'inuse') && co.status === 'allocated' && isManager && !ext && (
          <button type="button" className="secondary-btn it-btn-sm" onClick={() => onAct('force', [co])}><RotateCcw size={13} /> Force Return</button>
        )}
        {co.status === 'pending_receipt' && isManager && (
          <HoldButton size="sm" label="Reconcile" doneLabel="Reconciled" icon={Unlock} holdMs={HOLD_RECORD_MS}
            ariaLabel={`Cancel the unconfirmed handover of ${co.itemName}`}
            fallbackMessage={`Cancel the unconfirmed handover of ${co.itemName} to ${co.requestedBy}?`}
            onConfirm={() => onAct('reconcile', [co])} />
        )}
        <ChevronRight size={16} className="it-row-chev" aria-hidden="true" />
      </span>
    </div>
  );
});

export function RequestsTab({ items = [], checkouts = [], isManager, view, onViewChange, onOpenItem, checkoutsLoading, checkoutsError, refreshCheckouts }) {
  const { assignments, refreshAssignments } = useAssignments();
  const { myEmail, myName } = useItemsIdentity();
  const actions = useCheckoutActions();
  const [search, setSearch] = useState('');
  const [sheet, setSheet] = useState(null);
  const [doneShown, setDoneShown] = useState(DONE_PAGE);
  const now = new Date();
  const itemById = useMemo(() => new Map(items.map(i => [i.id, i])), [items]);
  const queues = useMemo(() => buildQueues(checkouts, assignments, { me: myEmail, isManager }), [checkouts, assignments, myEmail, isManager]); // eslint-disable-line react-hooks/exhaustive-deps
  const visibleQueues = isManager ? ['approve', 'handover', 'returns', 'overdue', 'inuse', 'assignments', 'done'] : ['handover'];
  const queue = visibleQueues.includes(view) ? view
    : isManager ? (queues.approve.length ? 'approve' : queues.handover.length ? 'handover' : queues.overdue.length ? 'overdue' : 'approve')
    : 'handover';

  const needle = search.trim().toLowerCase().replace(/^#/, '');
  const matches = (co) => !needle || [co.requestedBy, co.itemName, co.requestedByEmail].some(v => lc(v).includes(needle))
    || requestNo(co.orderId || co.id).toLowerCase().includes(needle);
  const list = ['returns', 'assignments'].includes(queue) ? [] : queues[queue].filter(matches);
  const groups = groupByRequest(queue === 'done' ? list.slice(0, doneShown) : list);
  const photoOptional = (cos) => cos.every(co => itemById.get(co.itemId)?.pictureRequired === false);

  async function act(kind, cos) {
    if (kind === 'approve') return setSheet({ kind: 'approve', cos });
    if (kind === 'reject') return setSheet({ kind: 'reject', cos });
    if (kind === 'handover') return setSheet({ kind: 'handover', cos });
    if (kind === 'force') return setSheet({ kind: 'force', cos });
    try {
      if (kind === 'ext-approve') await actions.resolveExtension(cos[0], 'approve');
      if (kind === 'ext-reject') await actions.resolveExtension(cos[0], 'reject');
      if (kind === 'reconcile') { const item = itemById.get(cos[0].itemId) || { id: cos[0].itemId, name: cos[0].itemName }; await actions.reconcile(item, cos[0]); }
    } catch (e) {
      if (kind === 'reconcile') throw e;   // the hold shows the refusal under the button
      itemsToast(e?.message || 'That did not go through.', 'error');
    }
    return undefined;
  }

  const count = (k) => (k === 'done' ? 0 : queues[k].length);
  return (
    <div className="it-requests">
      <div className="it-toolbar">
        <div className="it-chips scroll-tabs" role="tablist" aria-label="Queues">
          {visibleQueues.map(k => (
            <button key={k} role="tab" aria-selected={queue === k} className={`it-chip${queue === k ? ' is-on' : ''}${k === 'overdue' && count(k) ? ' is-overdue' : ''}`}
              onClick={() => onViewChange(k)}>
              {QUEUE_LABEL[k]}{count(k) > 0 && <span className="it-chip-n">{count(k)}</span>}
            </button>
          ))}
        </div>
        {!['assignments'].includes(queue) && (
          <div className="search-bar it-search">
            <Search size={14} style={{ flexShrink: 0 }} />
            <input placeholder="Search by person, item or request number…" value={search} onChange={e => setSearch(e.target.value)} aria-label="Search requests" />
            {search && <button className="search-clear" onClick={() => setSearch('')} aria-label="Clear search"><X size={13} /></button>}
          </div>
        )}
        {isManager && queue === 'overdue' && queues.overdue.length > 0 && (
          <button className="secondary-btn" onClick={() => setSheet({ kind: 'alert' })} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Megaphone size={14} /> Send Reminders
          </button>
        )}
      </div>

      {checkoutsError && !checkouts.length ? <ErrorBanner message="Could not load the requests." onRetry={refreshCheckouts} />
        : checkoutsLoading && !checkouts.length ? <SkeletonBlocks count={4} height={56} borderRadius={12} />
        : queue === 'assignments' ? (
          <AssignmentsQueue assignments={assignments} userEmail={myEmail} refresh={refreshAssignments} toast={itemsToast} />
        ) : queue === 'returns' ? (
          queues.returns.length === 0 ? <Empty queue={queue} /> : (
            <div className="it-list">
              {queues.returns.filter(a => !needle || [a.itemName, a.assigneeName, a.assigneeEmail].some(v => lc(v).includes(needle))).map(a => {
                const w = assignmentWord(a);
                const ready = a.returnPhotoUrl || a.returnReason === 'lost';
                return (
                  <div key={a.id} className="it-row is-compact">
                    <button type="button" className="it-row-main" onClick={() => onOpenItem(a.itemId)}>
                      <PhotoThumb url={a.returnPhotoUrl || itemById.get(a.itemId)?.photoUrl} name={a.itemName} size={36} />
                      <span className="it-row-text">
                        <span className="it-row-title">{a.itemName}</span>
                        <span className="it-row-sub">From {a.assigneeName || a.assigneeEmail}{a.returnInitiatedAt ? ` · ${formatDate(a.returnInitiatedAt)}` : ''}{a.returnReason === 'dead' ? ' · reported dead' : a.returnReason === 'lost' ? ' · reported lost' : ''}</span>
                      </span>
                    </button>
                    <StatusLabel label={w.label} color={w.color} size="sm" className="it-row-status" />
                    <span className="it-row-acts">
                      {ready ? <button type="button" className="primary-btn it-btn-sm" onClick={() => setSheet({ kind: 'accept-return', a })}><CheckCircle size={13} /> Accept Return</button>
                        : <span className="it-row-note">Waiting for their photo</span>}
                    </span>
                  </div>
                );
              })}
            </div>
          )
        ) : groups.length === 0 ? <Empty queue={queue} searching={!!needle} /> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {groups.map(g => {
              const first = g.cos[0];
              const mine = lc(first.requestedByEmail) === lc(myEmail);
              const pending = g.cos.filter(c => c.status === 'pending');
              const approved = g.cos.filter(c => c.status === 'approved');
              const out = g.cos.filter(c => c.status === 'allocated');
              return (
                <div key={g.key} className="it-list">
                  <div className="it-order-head">
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontWeight: 700, fontSize: 14 }}>{first.requestedBy}{mine && <span className="it-row-note" style={{ marginLeft: 8 }}>You</span>}</div>
                      <div className="it-row-sub">
                        Request #{requestNo(g.key)} · {formatDate(first.createdAt)}{g.cos.length > 1 ? ` · ${g.cos.length} items` : ''}
                        {first.reason ? ` · "${first.reason}"` : ''}
                      </div>
                    </div>
                    <div className="it-row-acts">
                      {queue === 'approve' && pending.length > 1 && !mine && (
                        <>
                          <button className="secondary-btn it-btn-sm" onClick={() => act('reject', pending)}>Reject All</button>
                          <button className="primary-btn it-btn-sm" onClick={() => act('approve', pending)}><CheckCircle size={13} /> Approve All ({pending.length})</button>
                        </>
                      )}
                      {queue === 'handover' && approved.length > 1 && (
                        <button className="primary-btn it-btn-sm" onClick={() => act('handover', approved)}><Camera size={13} /> Hand Over All ({approved.length})</button>
                      )}
                      {(queue === 'overdue' || queue === 'inuse') && out.length > 1 && isManager && (
                        <button className="secondary-btn it-btn-sm" onClick={() => act('force', out)}><RotateCcw size={13} /> Force Return All ({out.length})</button>
                      )}
                    </div>
                  </div>
                  {g.cos.map(co => (
                    <ReqRow key={co.id} co={co} item={itemById.get(co.itemId)} queue={queue} now={now} me={myEmail}
                      isManager={isManager} onOpen={onOpenItem} onAct={act} />
                  ))}
                </div>
              );
            })}
            {queue === 'done' && list.length > doneShown && (
              <button type="button" className="it-more" onClick={() => setDoneShown(n => n + DONE_PAGE)}>Show {Math.min(DONE_PAGE, list.length - doneShown)} More</button>
            )}
          </div>
        )}

      {sheet?.kind === 'approve' && (
        <ApproveCheckoutModal checkouts={sheet.cos} currentUserEmail={myEmail} currentUserName={myName}
          onClose={() => setSheet(null)} onConfirm={(email, name) => actions.approve(sheet.cos, email, name)} />
      )}
      {sheet?.kind === 'reject' && (
        <RejectCheckoutModal checkouts={sheet.cos} onClose={() => setSheet(null)} onConfirm={reason => actions.reject(sheet.cos, reason)} />
      )}
      {sheet?.kind === 'handover' && (
        <AllocateModal checkouts={sheet.cos} photoOptional={photoOptional(sheet.cos)} onClose={() => setSheet(null)}
          onConfirm={p => actions.handOver(sheet.cos, p)} />
      )}
      {sheet?.kind === 'force' && (
        <ForceReturnModal checkouts={sheet.cos} onClose={() => setSheet(null)}
          onConfirm={(reason, condition) => actions.forceReturn(sheet.cos, reason, condition)} />
      )}
      {sheet?.kind === 'accept-return' && (
        <AcceptReturnModal a={sheet.a} toast={itemsToast} onClose={() => setSheet(null)} onDone={() => { refreshAssignments(); setSheet(null); }} />
      )}
      {sheet?.kind === 'alert' && <OverdueAlertModal checkouts={checkouts} toast={itemsToast} onClose={() => setSheet(null)} />}
    </div>
  );
}

function Empty({ queue, searching = false }) {
  const copy = {
    approve: ['Nothing to approve', 'New requests show here.'],
    handover: ['Nothing to hand over', 'Approved items waiting for you show here.'],
    returns: ['No returns waiting', 'Permanent items people send back show here.'],
    overdue: ['Nothing overdue', 'Everything out on loan is on time.'],
    inuse: ['Nothing in use', 'Items people have borrowed show here.'],
    done: ['Nothing finished yet', 'Returned, rejected and canceled requests show here.'],
  }[queue] || ['Nothing here', ''];
  return (
    <div className="it-empty">
      <div className="it-empty-title">{searching ? 'Nothing matches' : copy[0]}</div>
      <div className="it-empty-sub">{searching ? 'Try another name or request number.' : copy[1]}</div>
    </div>
  );
}

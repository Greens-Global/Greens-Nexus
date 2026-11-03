// Item Management - the item record's ONE timeline (Items redesign, Neil 11/02/2026).
//
// Every checkout, every permanent assignment and the item's own edits, newest
// first, each step on its own line. A return carries the handover photo and
// the return photo side by side, so whoever receives it judges the
// condition on evidence.
import { auditEventMeta, auditName } from './auditFeed';
import { formatDate } from '../../lib/datetime';


/** [{ id, at, text, detail, photos: [{ url, label }] }] newest first. */
export function itemTimeline({ item, checkouts = [], assignments = [], audit = [] }) {
  if (!item) return [];
  const out = [];
  const push = (id, at, text, detail = '', photos = []) => { if (at) out.push({ id, at, text, detail, photos: photos.filter(p => p.url) }); };

  for (const co of checkouts) {
    if (co.itemId !== item.id) continue;
    const who = co.requestedBy || 'Someone';
    const due = co.requestedDueDate || '';
    push(`${co.id}:req`, co.createdAt, `Requested by ${who}`,
      [co.reason ? `"${co.reason}"` : '', due ? `Return by ${formatDate(due)}` : ''].filter(Boolean).join(' · '));
    if (co.status === 'rejected') push(`${co.id}:rej`, co.resolvedAt, `Rejected${co.resolvedBy ? ` by ${co.resolvedBy}` : ''}`, co.rejectReason || '');
    else if (co.status === 'cancelled') push(`${co.id}:can`, co.resolvedAt, `Canceled${co.resolvedBy ? ` by ${co.resolvedBy}` : ''}`);
    else if (co.resolvedAt && co.resolvedBy) push(`${co.id}:ok`, co.resolvedAt, `Approved by ${co.resolvedBy}`,
      co.assignedAllocatorName ? `${co.assignedAllocatorName} hands it over` : '');
    const handoverPhoto = co.checkoutPhotoUrl || '';
    if (co.handedOverAt) push(`${co.id}:hand`, co.handedOverAt, `Handed over to ${who}${co.allocatedBy ? ` by ${co.allocatedBy}` : ''}`,
      '', [{ url: handoverPhoto, label: 'Handover' }]);
    if (co.receiptPhotoUrl && co.allocatedAt) push(`${co.id}:rcpt`, co.allocatedAt, `${who} confirmed receipt`, '', [{ url: co.receiptPhotoUrl, label: 'Receipt' }]);
    if (co.returnedAt) {
      push(`${co.id}:ret`, co.returnedAt, `Returned by ${who}`, co.conditionNote || '',
        [{ url: co.receiptPhotoUrl || handoverPhoto, label: 'At Handover' }, { url: co.returnPhotoUrl || '', label: 'At Return' }]);
    }
  }

  for (const a of assignments) {
    if (a.itemId !== item.id) continue;
    const who = a.assigneeName || a.assigneeEmail || 'Someone';
    push(`${a.id}:asg`, a.createdAt, `Assigned to ${who}${a.assignedBy ? ` by ${a.assignedBy}` : ''}`);
    if (a.acceptedAt) push(`${a.id}:acc`, a.acceptedAt, `Accepted by ${who}`, a.acceptNote || '', [{ url: a.acceptPhotoUrl, label: 'At Acceptance' }]);
    if (a.status === 'declined') push(`${a.id}:dec`, a.returnInitiatedAt || a.createdAt, `Declined by ${who}`, a.returnNote || '');
    if (a.returnInitiatedAt && a.status !== 'declined') {
      const why = a.returnReason === 'dead' ? ' - reported dead' : a.returnReason === 'lost' ? ' - reported lost' : a.returnReason === 'reassign' ? ' - for reassignment' : '';
      push(`${a.id}:rs`, a.returnInitiatedAt, `Return started by ${who}${why}`, a.returnNote || '', [{ url: a.returnPhotoUrl, label: 'At Return' }]);
    }
    if (a.returnAcceptedAt) {
      push(`${a.id}:ra`, a.returnAcceptedAt, `Return accepted${a.returnAcceptedBy ? ` by ${a.returnAcceptedBy}` : ''}${a.disposition === 'retired' ? ' - retired' : a.disposition === 'stock' ? ' - back in stock' : ''}`, '',
        [{ url: a.acceptPhotoUrl, label: 'At Acceptance' }, { url: a.returnPhotoUrl, label: 'At Return' }]);
    }
  }

  for (const row of audit) {
    if (row.resource_id !== item.id) continue;
    const verb = auditEventMeta(row.action).verb;
    // Checkout steps are told above, from the checkout itself.
    if (/check|return|hand|approv|reject|assign/i.test(verb)) continue;
    const ts = /[zZ]$|[+-]\d{2}:\d{2}$/.test(row.timestamp || '') ? row.timestamp : `${row.timestamp}Z`;
    push(`log:${row.id}`, ts, `${verb === 'Updated' ? 'Edited' : verb} by ${auditName(row.user_email)}`);
  }

  return out.sort((x, y) => String(y.at).localeCompare(String(x.at)));
}

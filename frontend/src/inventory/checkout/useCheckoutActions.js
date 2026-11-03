// Item Management - the checkout steps, once (Items redesign, Neil 11/02/2026).
//
// My Stuff, Requests, the item record, the bell's handover sheet and the
// dashboard all run the same steps through here, so a step behaves (and
// reports a failure) the same wherever it is taken. One item: a failure is
// thrown, and the sheet that asked shows it. Several: they run one after the
// other (the server batches one bell per order) and the toast says how many
// went through; it throws only when none did.
import { useMemo } from 'react';
import { api } from '../../api';
import { useInventory } from '../../contexts/InventoryContext';
import { useItemsIdentity } from '../model/identity';
import { itemsToast } from '../ui/Toast';

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

async function each(list, fn) {
  let ok = 0; let firstError = null;
  for (const x of list) {
    try { await fn(x); ok += 1; } catch (e) { firstError = firstError || e; }
  }
  return { ok, failed: list.length - ok, firstError };
}

export function useCheckoutActions() {
  const inv = useInventory() || {};
  const { myName } = useItemsIdentity();
  return useMemo(() => {
    const refresh = () => { inv.refreshCheckouts?.(); inv.refreshItems?.(); };
    const report = ({ ok, failed, firstError }, doneWord) => {
      if (failed === 0) return;
      if (ok === 0) throw firstError || new Error('That did not go through.');
      itemsToast(`${doneWord} ${ok} · ${failed} did not go through.`, 'error');
    };

    return {
      /** Hand one or several approved items over. payload from AllocateModal. */
      async handOver(cos, { photoBy, batch, photoMap = {} }) {
        const list = Array.isArray(cos) ? cos : [cos];
        const res = await each(list, (co) => (photoBy === 'employee'
          ? inv.initiateHandover(co.id, myName)
          : inv.allocateItem(co.id, myName, photoMap[co.id]?.url || '', photoMap[co.id]?.name || '', { handoverPhotoBy: 'allocator', handoverBatch: !!batch })));
        refresh();
        report(res, 'Handed over');
        const who = list[0]?.requestedBy || 'the requester';
        if (res.ok) itemsToast(photoBy === 'employee'
          ? `${who} has been asked to confirm receipt.`
          : `${list.length === 1 ? list[0].itemName : plural(res.ok, 'item')} handed over to ${who}.`);
      },

      async approve(cos, allocEmail, allocName) {
        const list = Array.isArray(cos) ? cos : [cos];
        const res = await each(list, (co) => inv.approveRequest(co.id, myName, allocEmail, allocName));
        refresh();
        report(res, 'Approved');
        if (res.ok) itemsToast(`Approved ${list.length === 1 ? list[0].itemName : plural(res.ok, 'item')} - ${allocName} hands it over.`);
      },

      async reject(cos, reason) {
        const list = Array.isArray(cos) ? cos : [cos];
        const res = await each(list, (co) => inv.rejectRequest(co.id, myName, reason));
        refresh();
        report(res, 'Rejected');
        if (res.ok) itemsToast(`Rejected ${list.length === 1 ? list[0].itemName : plural(res.ok, 'item')}.`);
      },

      async cancel(co) {
        await inv.cancelRequest(co.id, myName);
        itemsToast(`Request for ${co.itemName} canceled.`);
      },

      async cancelMany(cos) {
        const res = await each(cos, (co) => inv.cancelRequest(co.id, myName));
        refresh();
        report(res, 'Canceled');
        if (res.ok) itemsToast(`Canceled ${plural(res.ok, 'request')}.`);
      },

      /** The requester confirms receipt (one or several) - ReceiptConfirmModal. */
      async confirmReceipt(cos, { photoMap = {} }) {
        const list = Array.isArray(cos) ? cos : [cos];
        const res = await each(list, (co) => inv.confirmReceipt(co.id, myName, photoMap[co.id]?.url || '', photoMap[co.id]?.name || ''));
        refresh();
        report(res, 'Confirmed');
        if (res.ok) itemsToast(`${list.length === 1 ? list[0].itemName : plural(res.ok, 'item')} with you now.`);
      },

      /** An approved item of my own that I may take myself (EmployeeAcceptModal). */
      async selfTake(co, url, name) {
        await inv.allocateItem(co.id, myName, url, name);
        itemsToast(`${co.itemName} is with you.`);
      },

      async returnOne(co, data) {
        await inv.returnItem(co.id, data);
        itemsToast(data?.condition === 'lost' ? `${co.itemName} reported lost.` : `${co.itemName} returned.`);
      },

      /** An items manager checks items back in for their holders. */
      async forceReturn(cos, reason, condition = 'ok') {
        const list = Array.isArray(cos) ? cos : [cos];
        const res = await each(list, (co) => api.updateItemCheckout(co.id, {
          status: 'returned', condition, condition_note: `Force-returned by ${myName} - ${reason}`,
        }));
        refresh();
        report(res, 'Checked in');
        if (res.ok) itemsToast(`${list.length === 1 ? list[0].itemName : plural(res.ok, 'item')} checked back in.`);
      },

      async requestExtension(co, { newDueDate, days, reason }) {
        await api.requestItemExtension(co.id, { new_due_date: newDueDate, days, reason });
        inv.refreshCheckouts?.();
        itemsToast(`Asked for more time with ${co.itemName}.`);
      },

      async resolveExtension(co, action) {
        await api.resolveItemExtension(co.id, { action });
        inv.refreshCheckouts?.();
        itemsToast(action === 'approve' ? `More time approved for ${co.itemName}.` : `Extension declined for ${co.itemName}.`);
      },

      /** A manager frees an item stuck waiting on a receipt (reconcile-state). */
      async reconcile(item, co) {
        const out = await api.reconcileItemState(item.id, co ? { cancel_checkout_id: co.id } : {});
        refresh();
        itemsToast(co ? `Handover of ${item.name} canceled - it is ${out?.status === 'available' ? 'available' : 'set'} again.` : `${item.name} is set to match its checkouts.`);
        return out;
      },
    };
  }, [inv, myName]); // eslint-disable-line react-hooks/exhaustive-deps
}

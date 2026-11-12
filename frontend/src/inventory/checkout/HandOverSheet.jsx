// Item Management - hand an item over from outside the module (the bell, the
// dashboard's Who Has What) - Items redesign, Neil 11/02/2026.
// Those used to call allocateItem straight away, with no handover photo (the
// server refuses that for every photo-required item) and swallowed the
// refusal. Now they open the same handover sheet Requests uses, so the photo
// is taken and any refusal is shown on the sheet. Loaded lazily by its
// callers, so the Items code stays in its own chunk.
import { useEffect, useState } from 'react';
import { useInventory } from '../../contexts/InventoryContext';
import { useRole } from '../../contexts/RoleContext';
import { useItemsIdentity } from '../model/identity';
import { AllocateModal } from './AllocateModal';
import { useCheckoutActions } from './useCheckoutActions';
import { ItemSheet } from '../ui/Sheet';
import { ItemsToasts } from '../ui/Toast';

// `checkoutId` is a hand-over bell's ref: a checkout id, or - for a cart of
// several items - the ORDER id; the sheet then hands the whole order over
// (the approved items in it this person may hand over).
export function handOverBatch(checkouts, ref, me = '', isManager = false) {
  const lc = (s) => String(s || '').toLowerCase();
  return checkouts.filter(c => (c.id === ref || (c.orderId && c.orderId === ref)) && c.status === 'approved'
    && (isManager || lc(c.assignedAllocatorEmail) === lc(me)));
}

export default function HandOverSheet({ checkoutId, onClose, onDone }) {
  const { checkouts = [], items = [], refreshCheckouts, checkoutsLoading } = useInventory() || {};
  const { canAccessModule } = useRole();
  const { myEmail } = useItemsIdentity();
  const actions = useCheckoutActions();
  const batch = handOverBatch(checkouts, checkoutId, myEmail, canAccessModule('inventory', 'manager', 'editor'));
  const co = batch[0];
  const known = checkouts.some(c => c.id === checkoutId || c.orderId === checkoutId);
  useEffect(() => { if (!known) refreshCheckouts?.(); }, [known]); // eslint-disable-line react-hooks/exhaustive-deps
  // One toast stack: the Items page draws its own; elsewhere this sheet does.
  // (Read after mount - the page may commit in the same pass.)
  const [pageToasts, setPageToasts] = useState(false);
  useEffect(() => { setPageToasts(!!document.querySelector('.it-page')); }, []); // eslint-disable-line react-hooks/set-state-in-effect

  if (!co) {
    return (
      <>
        <ItemSheet title="Hand Over" onClose={onClose}
          footer={<button className="secondary-btn" onClick={onClose}>Close</button>}>
          <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>
            {!known && checkoutsLoading ? 'Loading the request…'
              : !known ? 'This request is not in your list any more.'
              : 'This has already moved on - there is nothing to hand over.'}
          </p>
        </ItemSheet>
        {!pageToasts && <ItemsToasts />}
      </>
    );
  }
  const photoOptional = batch.every(c => items.find(i => i.id === c.itemId)?.pictureRequired === false);
  return (
    <>
      <AllocateModal checkouts={batch} photoOptional={photoOptional} onClose={onClose}
        onConfirm={async (p) => { await actions.handOver(batch, p); onDone?.(); }} />
      {!pageToasts && <ItemsToasts />}
    </>
  );
}

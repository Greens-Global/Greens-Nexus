// Item Management - hand an item over from outside the module (the bell, the
// dashboard's Who Has What) - Items redesign, Neil 11/02/2026.
// Those used to call allocateItem straight away, with no handover photo (the
// server refuses that for every photo-required item) and swallowed the
// refusal. Now they open the same handover sheet Requests uses, so the photo
// is taken and any refusal is shown on the sheet. Loaded lazily by its
// callers, so the Items code stays in its own chunk.
import { useEffect } from 'react';
import { useInventory } from '../../contexts/InventoryContext';
import { AllocateModal } from './AllocateModal';
import { useCheckoutActions } from './useCheckoutActions';
import { ItemSheet } from '../ui/Sheet';
import { ItemsToasts } from '../ui/Toast';

export default function HandOverSheet({ checkoutId, onClose, onDone }) {
  const { checkouts = [], items = [], refreshCheckouts, checkoutsLoading } = useInventory() || {};
  const actions = useCheckoutActions();
  const co = checkouts.find(c => c.id === checkoutId);
  useEffect(() => { if (!co) refreshCheckouts?.(); }, [co]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!co || co.status !== 'approved') {
    return (
      <>
        <ItemSheet title="Hand Over" onClose={onClose}
          footer={<button className="secondary-btn" onClick={onClose}>Close</button>}>
          <p style={{ fontSize: 13.5, color: 'var(--muted)', margin: 0 }}>
            {!co && checkoutsLoading ? 'Loading the request…'
              : !co ? 'This request is not in your list any more.'
              : 'This item has already moved on - there is nothing to hand over.'}
          </p>
        </ItemSheet>
        <ItemsToasts />
      </>
    );
  }
  const photoOptional = items.find(i => i.id === co.itemId)?.pictureRequired === false;
  return (
    <>
      <AllocateModal checkout={co} photoOptional={photoOptional} onClose={onClose}
        onConfirm={async (p) => { await actions.handOver([co], p); onDone?.(); }} />
      <ItemsToasts />
    </>
  );
}

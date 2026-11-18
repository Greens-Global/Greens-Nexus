// Item Management - Pick a New Allocator (Items redesign review, 11/02/2026).
// Offboarding leaves an approved checkout with nobody to hand it over (the
// "Pick a New Allocator" bell). An items manager names who hands it over now;
// the server bells them with Hand Over. The list is the people who can reach
// the item's company.
import { useEffect, useState } from 'react';
import { User } from 'lucide-react';
import { Spinner } from '../../components/AsyncState';
import { api } from '../../api';
import { useInventory } from '../../contexts/InventoryContext';
import { ItemSheet, LABEL, HINT, ERROR } from '../ui/Sheet';
import { itemsToast } from '../ui/Toast';

export function PickAllocatorSheet({ checkout, onClose }) {
  const { refreshCheckouts } = useInventory() || {};
  const [people, setPeople] = useState(null);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    api.getItemAllocatorsFor(checkout.itemId)
      .then(rows => { if (alive) setPeople(rows || []); })
      .catch(() => { if (alive) { setPeople([]); setError('Could not load the people who hand items over.'); } });
    return () => { alive = false; };
  }, [checkout.itemId]);

  function save() {
    const who = (people || []).find(p => p.email === pick);
    if (!who || busy) return;
    setBusy(true); setError('');
    api.setCheckoutAllocator(checkout.id, { allocator_email: who.email, allocator_name: who.name })
      .then(() => { refreshCheckouts?.(); itemsToast(`${who.name} hands ${checkout.itemName} over now.`); onClose(); })
      .catch(e => { setError(e?.message || 'Could not set who hands it over.'); setBusy(false); });
  }

  return (
    <ItemSheet title={`Who Hands Over ${checkout.itemName}?`} onClose={onClose} isDirty={!!pick}
      footer={<>
        <button className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="primary-btn" disabled={!pick || busy} onClick={save} style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
          {busy ? <Spinner size={14} /> : <User size={14} />} Save
        </button>
      </>}>
      <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 16px', lineHeight: 1.5 }}>
        Approved for <strong style={{ color: 'var(--ink)' }}>{checkout.requestedBy}</strong>.
        {checkout.assignedAllocatorName ? ` ${checkout.assignedAllocatorName} was to hand it over.` : ' Nobody is set to hand it over.'}
      </p>
      <label style={LABEL} htmlFor="pick-allocator">Hands It Over</label>
      {people == null ? <Spinner size={16} /> : (
        <select id="pick-allocator" className="form-input" style={{ width: '100%', maxWidth: 420 }} value={pick} onChange={e => setPick(e.target.value)}>
          <option value="">Choose a person</option>
          {people.map(p => <option key={p.email} value={p.email}>{p.name}</option>)}
        </select>
      )}
      <p style={HINT}>They get a bell with Hand Over.</p>
      {error && <p style={ERROR}>{error}</p>}
    </ItemSheet>
  );
}

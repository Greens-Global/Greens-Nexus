// Item Management - An items manager checks an item back in for its holder.
// A question (the centered card) confirmed by holding (Items redesign, Neil
// 11/02/2026): it cannot be taken back. HOLD_RECORD_MS for one item,
// HOLD_MAJOR_MS for several. It asks Good / Damaged / Lost - a Lost item is
// marked lost (the server rule) and never goes back to Available. The reason
// is stored on the checkout and in the activity log.
import { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import HoldButton, { HOLD_MAJOR_MS, HOLD_RECORD_MS } from '../../ui/HoldButton';
import { ItemQuestion, LABEL, HINT } from '../ui/Sheet';
import { ConditionPicker } from './ReturnModal';

export function ForceReturnModal({ checkout, checkouts, onClose, onConfirm }) {
  const list = checkouts || [checkout];
  const multi = list.length > 1;
  const holders = [...new Set(list.map(c => c.requestedBy))];
  const [reason,    setReason]    = useState('');
  const [condition, setCondition] = useState('ok');

  const ready = !!reason.trim();
  return (
    <ItemQuestion title={multi ? `Force Return ${list.length} Items?` : `Force Return ${list[0].itemName}?`} onClose={onClose}
      isDirty={ready}
      footer={<>
        <button className="secondary-btn" onClick={onClose}>Keep Checked Out</button>
        <HoldButton label="Hold to Check In" doneLabel="Checked In" icon={RotateCcw}
          holdMs={multi ? HOLD_MAJOR_MS : HOLD_RECORD_MS} disabled={!ready}
          fallbackMessage={`Check ${multi ? `${list.length} items` : list[0].itemName} back in for ${holders.length === 1 ? holders[0] : `${holders.length} people`}?`}
          onConfirm={() => Promise.resolve(onConfirm(reason.trim(), condition)).then(() => undefined)}
          onDone={onClose} />
      </>}>
      <p style={{ fontSize: 13.5, color: 'var(--muted)', margin: '0 0 14px', lineHeight: 1.5 }}>
        For <strong style={{ color: 'var(--ink)' }}>{holders.length === 1 ? holders[0] : `${holders.length} people`}</strong>, when they cannot return it in the app themselves.
      </p>
      {multi && (
        <ul style={{ margin: '0 0 14px', padding: '8px 12px', listStyle: 'none', background: 'var(--mist)', borderRadius: 10, maxHeight: 140, overflowY: 'auto', display: 'grid', gap: 2 }}>
          {list.map(c => <li key={c.id} style={{ fontSize: 12.5, color: 'var(--muted)' }}>{c.itemName}{holders.length > 1 ? ` - ${c.requestedBy}` : ''}</li>)}
        </ul>
      )}
      <span style={LABEL}>Condition</span>
      <ConditionPicker value={condition} onChange={setCondition} />
      {condition === 'lost' && <p style={HINT}>It is marked Lost and cannot be borrowed until someone marks it found.</p>}
      <label style={{ ...LABEL, marginTop: 14 }} htmlFor="force-reason">Reason</label>
      <textarea id="force-reason" rows={3} autoFocus className="form-input" style={{ width: '100%', resize: 'vertical', fontSize: 13.5 }}
        placeholder="e.g. Collected from the site office - the holder is on leave"
        value={reason} onChange={e => setReason(e.target.value)} />
    </ItemQuestion>
  );
}

// Bonus section at the bottom of a Time Sheet (Neil, Oct 22 2026 -
// backend timeclock.add_timecard_bonus). A manager or HR adds a bonus for
// the period with what it is for; each one is a line in the pay summary,
// adds to the total, prints on the Time Sheet the employee signs and on a
// contractor's invoice. Locked like the hours: nothing changes on a
// finalized period or on your own card.
import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { api } from '../api';
import { formatDate } from '../lib/datetime';
import { dialog } from '../ui/dialog';

export default function TimecardBonuses({ card, periodStart, self, locked, fmtM, showPay, onChanged, toastOk, toastErr }) {
  const list = card?.bonuses || [];
  const [desc, setDesc] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  if (self || (!list.length && locked)) return null;
  const amt = Number(amount);
  const ready = desc.trim() && amt > 0;

  async function add() {
    if (!ready) return;
    setBusy(true);
    try {
      await api.timecardBonusAdd({ email: card.email, date: periodStart, description: desc.trim(), amount: amt });
      toastOk?.('Bonus added.');
      setDesc(''); setAmount('');
      onChanged?.();
    } catch (e) { toastErr?.(e?.message || 'Could not add the bonus.'); }
    setBusy(false);
  }
  async function remove(b) {
    if (!await dialog.confirm(`Remove the bonus "${b.description}"?`, { title: 'Remove Bonus', confirmText: 'Remove', danger: true })) return;
    setBusy(true);
    try {
      await api.timecardBonusRemove(b.id);
      toastOk?.('Bonus removed.');
      onChanged?.();
    } catch (e) { toastErr?.(e?.message || 'Could not remove the bonus.'); }
    setBusy(false);
  }

  return (
    <section data-testid="timecard-bonuses" style={{ marginTop: 14, border: '1px solid var(--wk-line2)', borderRadius: 14, background: 'var(--card)', boxShadow: 'var(--wk-shadow)', overflow: 'hidden' }}>
      <div style={{ padding: '8px 12px', background: 'var(--wk-hover)', fontSize: 12, fontWeight: 600, color: 'var(--wk-dim)' }}>Bonus</div>
      {!list.length && (
        <div style={{ padding: '8px 12px', fontSize: 12.5, color: 'var(--muted)' }}>No bonus on this pay period.</div>
      )}
      {list.map(b => (
        <div key={b.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px', borderTop: '1px solid var(--line)', fontSize: 12.5 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, color: 'var(--ink)' }}>{b.description}</div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>Added by {b.by}{b.at ? ` on ${formatDate(b.at)}` : ''}</div>
          </div>
          {showPay && <span style={{ fontWeight: 700 }}>+{fmtM(b.amount)}</span>}
          {!locked && (
            <button type="button" className="secondary-btn" disabled={busy} onClick={() => remove(b)} aria-label={`Remove bonus ${b.description}`}
              style={{ padding: '2px 8px', fontSize: 11.5, display: 'inline-flex', alignItems: 'center', gap: 4 }}><X size={12} /> Remove</button>
          )}
        </div>
      ))}
      {!locked && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', padding: '8px 12px', borderTop: '1px solid var(--line)' }}>
          <input className="form-input" aria-label="Bonus description" placeholder="What is the bonus for?" value={desc} maxLength={500}
            onChange={e => setDesc(e.target.value)} style={{ fontSize: 12.5, flex: 1, minWidth: 180 }} />
          <input className="form-input" aria-label="Bonus amount" placeholder="Amount" type="number" min="0" step="0.01" value={amount}
            onChange={e => setAmount(e.target.value)} style={{ fontSize: 12.5, width: 120 }} />
          <button type="button" className="secondary-btn" disabled={busy || !ready} onClick={add}
            style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}><Plus size={12} /> Add Bonus</button>
        </div>
      )}
    </section>
  );
}

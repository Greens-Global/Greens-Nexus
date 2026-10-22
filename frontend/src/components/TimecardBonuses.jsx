// Bonus section at the bottom of a Time Sheet (Neil, Oct 22 2026 -
// backend timeclock.add_timecard_bonus). A manager or HR adds a bonus for
// the period with what it is for; each one is a line in the pay summary,
// adds to the total, prints on the Time Sheet the employee signs and on a
// contractor's invoice. Locked like the hours: nothing changes on a
// finalized period or on your own card. The employee sees their bonuses
// here too, read only - who added each one, when and why (Oct 22: nothing
// about their pay is hidden from them).

// What happens next, from the server's answer (timeclock._bonus_told).
const nextStep = (out, did) => out?.reopened
  ? `Bonus ${did}. The time sheet was already approved, so it goes back to the manager to approve again, then to the employee to sign.`
  : out?.signAgain
    ? `Bonus ${did}. The employee is asked to sign the updated time sheet.`
    : `Bonus ${did}. The employee is notified and sees it on the time sheet they sign.`;
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
  const readOnly = self || locked;
  if (readOnly && !list.length) return null;
  const amt = Number(amount);
  const ready = desc.trim() && amt > 0;

  async function add() {
    if (!ready) return;
    setBusy(true);
    try {
      const out = await api.timecardBonusAdd({ email: card.email, date: periodStart, description: desc.trim(), amount: amt });
      toastOk?.(nextStep(out, 'added'));
      window.dispatchEvent(new CustomEvent('nexus:timesheet-review-changed'));
      setDesc(''); setAmount('');
      onChanged?.();
    } catch (e) { toastErr?.(e?.message || 'Could not add the bonus.'); }
    setBusy(false);
  }
  async function remove(b) {
    if (!await dialog.confirm(`Remove the bonus "${b.description}"?`, { title: 'Remove Bonus', confirmText: 'Remove', danger: true })) return;
    setBusy(true);
    try {
      const out = await api.timecardBonusRemove(b.id);
      toastOk?.(nextStep(out, 'removed'));
      window.dispatchEvent(new CustomEvent('nexus:timesheet-review-changed'));
      onChanged?.();
    } catch (e) { toastErr?.(e?.message || 'Could not remove the bonus.'); }
    setBusy(false);
  }

  return (
    <section data-testid="timecard-bonuses" style={{ marginTop: 14, border: '1px solid var(--wk-line2)', borderRadius: 14, background: 'var(--card)', boxShadow: 'var(--wk-shadow)', overflow: 'hidden' }}>
      <div style={{ padding: '8px 12px', background: 'var(--wk-hover)', fontSize: 12, fontWeight: 600, color: 'var(--wk-dim)' }}>
        {self ? 'Bonus Added for You' : 'Bonus'}
        {self && <span style={{ fontWeight: 400, marginLeft: 6 }}>- part of your pay for this period, and on the time sheet you sign</span>}
      </div>
      {!list.length && (
        <div style={{ padding: '8px 12px', fontSize: 12.5, color: 'var(--muted)' }}>No bonus on this pay period.</div>
      )}
      {list.map(b => (
        <div key={b.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px', borderTop: '1px solid var(--line)', fontSize: 12.5 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, color: 'var(--ink)' }}>{b.description}</div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>Added by {b.byName || b.by}{b.at ? ` on ${formatDate(b.at)}` : ''}</div>
          </div>
          {showPay && <span style={{ fontWeight: 700 }}>+{fmtM(b.amount)}</span>}
          {!readOnly && (
            <button type="button" className="secondary-btn" disabled={busy} onClick={() => remove(b)} aria-label={`Remove bonus ${b.description}`}
              style={{ padding: '2px 8px', fontSize: 11.5, display: 'inline-flex', alignItems: 'center', gap: 4 }}><X size={12} /> Remove</button>
          )}
        </div>
      ))}
      {!readOnly && (
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

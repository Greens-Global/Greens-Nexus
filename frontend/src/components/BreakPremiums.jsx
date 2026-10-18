// Meal / Rest Premium lines on a CA-rule employee's time sheet (Neil, Oct 17
// 2026 - backend/ca_breaks.py). One hour of pay at the day's regular rate,
// at most one meal and one rest premium per day; not hours worked, not in the
// overtime split. The employee's "No" at signing creates the lines from their
// claim; the manager side adds more or removes one with a reason (kept as a
// record). Renders nothing for anyone not on the California overtime rule.
import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { api } from '../api';
import { formatDate, formatDateTime } from '../lib/datetime';
import { dialog } from '../ui/dialog';
import { StatusLabel } from './StatusLabel';

const KIND = { meal: 'Meal Premium', rest: 'Rest Premium' };

export default function BreakPremiums({ card, self, locked, onChanged, toastOk, toastErr }) {
  const list = card?.breakPremiums || [];
  // caBreaks: the server's non-pay "CA meal / rest rules apply" marker
  // (ca_breaks.in_scope) - never inferred from pay fields the manager tier
  // does not receive.
  const isCa = !!card?.caBreaks && !card?.fixedDays;
  const workDays = (card?.days || []).filter(d => (d.workedMin || 0) > 0).map(d => d.date);
  const [day, setDay] = useState('');
  const [kind, setKind] = useState('meal');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  if (self || !isCa || (!list.length && locked)) return null;

  async function add() {
    if (!day) return;
    setBusy(true);
    try {
      await api.breakPremiumAdd({ email: card.email, date: day, kind, note: note.trim() });
      toastOk?.(`${KIND[kind]} added for ${formatDate(day)}.`);
      setNote(''); setDay('');
      onChanged?.();
    } catch (e) { toastErr?.(e?.message || 'Could not add the premium.'); }
    setBusy(false);
  }
  async function remove(p) {
    const reason = await dialog.prompt(`Why is the ${p.label} for ${formatDate(p.date)} removed?`,
      { title: 'Remove Premium', confirmText: 'Remove', required: true, multiline: true, danger: true });
    if (!reason) return;
    setBusy(true);
    try {
      await api.breakPremiumRemove(p.id, reason);
      toastOk?.('Premium removed.');
      onChanged?.();
    } catch (e) { toastErr?.(e?.message || 'Could not remove the premium.'); }
    setBusy(false);
  }

  return (
    <section data-testid="break-premiums" style={{ minWidth: 280, flex: 1, border: '1px solid var(--wk-line2)', borderRadius: 14, background: 'var(--card)', boxShadow: 'var(--wk-shadow)', overflow: 'hidden' }}>
      <div style={{ padding: '8px 12px', background: 'var(--wk-hover)', fontSize: 12, fontWeight: 600, color: 'var(--wk-dim)' }}>
        Meal and Rest Premiums
      </div>
      {!list.length && (
        <div style={{ padding: '8px 12px', fontSize: 12.5, color: 'var(--muted)' }}>No premiums on this time sheet.</div>
      )}
      {list.map(p => (
        <div key={p.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '7px 12px', borderTop: '1px solid var(--line)', fontSize: 12.5 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, color: p.status === 'removed' ? 'var(--muted)' : 'var(--ink)', textDecoration: p.status === 'removed' ? 'line-through' : 'none' }}>
              {formatDate(p.date)} · {p.label}
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
              {p.source === 'claim' ? 'From the employee at signing' : 'Added by the manager'}{p.note ? ` - "${p.note}"` : ''}
            </div>
            {p.status === 'removed' && (
              <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>Removed {formatDateTime(p.removedAt)}: {p.removedReason}</div>
            )}
          </div>
          {p.status === 'removed'
            ? <StatusLabel size="sm" label="Removed" color="#64748b" />
            : !locked && (
              <button type="button" className="secondary-btn" disabled={busy} onClick={() => remove(p)} aria-label={`Remove ${p.label} ${formatDate(p.date)}`}
                style={{ padding: '2px 8px', fontSize: 11.5, display: 'inline-flex', alignItems: 'center', gap: 4 }}><X size={12} /> Remove</button>
            )}
        </div>
      ))}
      {!locked && workDays.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', padding: '8px 12px', borderTop: '1px solid var(--line)' }}>
          <select className="form-input" aria-label="Day" value={day} onChange={e => setDay(e.target.value)} style={{ fontSize: 12.5, minWidth: 120 }}>
            <option value="">Pick a Day</option>
            {workDays.map(d => <option key={d} value={d}>{formatDate(d)}</option>)}
          </select>
          <select className="form-input" aria-label="Premium" value={kind} onChange={e => setKind(e.target.value)} style={{ fontSize: 12.5 }}>
            <option value="meal">Meal Premium</option>
            <option value="rest">Rest Premium</option>
          </select>
          <input className="form-input" aria-label="Note" placeholder="Note (optional)" value={note} maxLength={500}
            onChange={e => setNote(e.target.value)} style={{ fontSize: 12.5, flex: 1, minWidth: 120 }} />
          <button type="button" className="secondary-btn" disabled={busy || !day} onClick={add}
            style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}><Plus size={12} /> Add Premium</button>
        </div>
      )}
    </section>
  );
}

// California meal period waiver on a person's profile (Neil, Oct 17 2026 -
// backend/ca_breaks.py). Only for hourly staff on the California overtime
// rule: renders nothing for anyone else. HR sends the one-time waiver in Nexus
// Sign and may revoke it (the employee's written request); the meal check
// reads it - a first meal is not needed on a day of 6 hours or less, a
// second on a day of 12 hours or less when the first was taken.
import { useEffect, useState, useCallback } from 'react';
import { api } from '../api';
import { formatDate } from '../lib/datetime';
import { dialog } from '../ui/dialog';
import { StatusLabel } from './StatusLabel';

const STATUS = {
  signed: ['Signed', '#16a34a'], sent: ['Out for Signature', '#b45309'],
  revoked: ['Revoked', '#64748b'], none: ['Not Signed', '#64748b'],
};

export default function MealWaiverCard({ email }) {
  const [w, setW] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const load = useCallback(() => {
    if (!email) return;
    api.mealWaiver(email).then(setW).catch(() => setW(null));
  }, [email]);
  useEffect(() => { load(); }, [load]);
  if (!w?.ca) return null;

  async function send() {
    setBusy(true); setErr('');
    try { setW(await api.mealWaiverSend(email)); }
    catch (e) { setErr(e?.message || 'Could not send the waiver.'); }
    setBusy(false);
  }
  async function revoke() {
    const note = await dialog.prompt('Why is the waiver revoked? (for example, the employee asked in writing)',
      { title: 'Revoke Meal Waiver', confirmText: 'Revoke', required: true, multiline: true, danger: true });
    if (!note) return;
    setBusy(true); setErr('');
    try { setW(await api.mealWaiverRevoke(email, note)); }
    catch (e) { setErr(e?.message || 'Could not revoke the waiver.'); }
    setBusy(false);
  }

  const [label, color] = STATUS[w.status] || STATUS.none;
  const when = w.status === 'signed' ? `Signed ${formatDate(w.signedAt)}`
    : w.status === 'sent' ? `Sent ${formatDate(w.sentAt)}`
      : w.status === 'revoked' ? `Revoked ${formatDate(w.revokedAt)}${w.revokeNote ? ` - ${w.revokeNote}` : ''}` : '';
  return (
    <div data-testid="meal-waiver" style={{ display: 'flex', gap: 10, padding: '7px 0', borderBottom: '1px solid var(--line)', alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.06em', color: 'var(--muted)', textTransform: 'uppercase', width: 150, flexShrink: 0 }}>Meal Waiver</span>
      <div style={{ flex: 1, minWidth: 220, display: 'grid', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <StatusLabel size="sm" label={label} color={color} />
          {when && <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>{when}</span>}
          {w.canManage && (w.status === 'none' || w.status === 'revoked') && (
            <button type="button" className="secondary-btn" disabled={busy} onClick={send} style={{ fontSize: 12 }}>Send Waiver to Sign</button>
          )}
          {w.canManage && (w.status === 'signed' || w.status === 'sent') && (
            <button type="button" className="secondary-btn" disabled={busy} onClick={revoke} style={{ fontSize: 12 }}>
              {w.status === 'sent' ? 'Cancel Waiver' : 'Revoke Waiver'}
            </button>
          )}
        </div>
        {err && <span role="alert" style={{ fontSize: 12, color: '#b91c1c' }}>{err}</span>}
        <details style={{ fontSize: 12, color: 'var(--muted)' }}>
          <summary style={{ cursor: 'pointer' }}>Waiver Wording</summary>
          <p style={{ margin: '6px 0' }}><b>First meal period.</b> {w.firstMeal}</p>
          <p style={{ margin: '6px 0' }}><b>Second meal period.</b> {w.secondMeal}</p>
        </details>
      </div>
    </div>
  );
}

import { useState } from 'react';
import { api } from '../api';
import { Modal } from '../tasks/components';
import { StatusLabel } from './StatusLabel';
import { formatDate } from '../lib/datetime';
import { hm, EXTRA_TIME_STATUS, CREDIT_LABEL, creditText, reconRows } from '../lib/extraTime';

// India Contractor Work Hours and Extra Time Policy (Neil, Oct 27 2026,
// docs/India-Contractor-Pay.md). The server prices everything
// (india_contractor_pay.py); these pieces only show it and file / decide the
// Extra Time claims. Never recompute pay here.

export function ExtraTimeStatus({ claim }) {
  const s = EXTRA_TIME_STATUS[claim?.status] || EXTRA_TIME_STATUS.pending;
  return <StatusLabel label={s.label} color={s.color} size="sm" />;
}

export function CreditCell({ fd }) {
  const text = creditText(fd);
  if (!text) return <span style={{ color: 'var(--muted)' }}>-</span>;
  const c = fd.dayKind === 'holiday' ? CREDIT_LABEL.holiday : (CREDIT_LABEL[fd.credit] || CREDIT_LABEL.pending);
  const rec = fd.recoveredHalves ? (fd.recoveredHalves === fd.missingHalves ? 'Recovered from the pool' : 'Half recovered from the pool') : '';
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
      <StatusLabel label={text} color={c.color} size="sm" />
      {rec && <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>{rec}</span>}
    </span>
  );
}

// The Extra Time column: the claim and its status, or Claim Extra Time on a
// day with hours to claim (the contractor), or Approve / Decline (HR).
export function ExtraTimeCell({ fd, self, filingOpen, canDecide, onClaim, onDecide }) {
  const c = fd.claim;
  const btn = { border: '1px solid var(--line-strong,var(--line))', borderRadius: 3, padding: '0 6px', background: 'var(--wk-hover)', color: 'var(--ink)', font: 'inherit', fontSize: 11, fontWeight: 700, cursor: 'pointer', lineHeight: 1.6 };
  if (c) {
    const hours = c.status === 'approved' ? hm(c.approvedMin) : hm(c.claimedMin);
    return (
      <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <ExtraTimeStatus claim={c} />
          <span style={{ fontWeight: 700 }}>{hours}</span>
        </span>
        {c.status === 'approved' && fd.extraMin != null && fd.extraMin < c.approvedMin && (
          <span style={{ fontSize: 10.5, color: 'var(--muted)' }} title="The hours on the day are now fewer than were approved - only the hours worked are paid">{hm(fd.extraMin)} paid</span>
        )}
        {self && c.status === 'pending' && filingOpen && <button type="button" style={btn} onClick={() => onClaim(fd)}>Edit</button>}
        {!self && canDecide && <button type="button" style={btn} onClick={() => onDecide(fd)}>{c.status === 'pending' ? 'Decide' : 'Change'}</button>}
      </span>
    );
  }
  if (self && filingOpen && !fd.future && fd.claimableMin > 0) {
    return <button type="button" style={btn} onClick={() => onClaim(fd)} title={`Up to ${hm(fd.claimableMin)} can be claimed for this day`}>Claim Extra Time</button>;
  }
  return <span style={{ color: 'var(--muted)' }}>-</span>;
}

const field = { display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12.5, fontWeight: 600, color: 'var(--ink)' };
const hint = { fontSize: 12, color: 'var(--muted)', fontWeight: 400, lineHeight: 1.45 };

function HoursBox({ minutes, onChange, max, idPrefix }) {
  const h = Math.floor((minutes || 0) / 60);
  const m = (minutes || 0) % 60;
  const set = (hh, mm) => onChange(Math.max(0, Math.min(max ?? 24 * 60, (Number(hh) || 0) * 60 + (Number(mm) || 0))));
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <input id={`${idPrefix}-h`} aria-label="Hours" className="form-input" type="number" min={0} max={24} value={h} onChange={e => set(e.target.value, m)} style={{ width: 72 }} />
      <span style={hint}>h</span>
      <input id={`${idPrefix}-m`} aria-label="Minutes" className="form-input" type="number" min={0} max={59} value={m} onChange={e => set(h, e.target.value)} style={{ width: 72 }} />
      <span style={hint}>m</span>
    </span>
  );
}

// The contractor's claim: hours prefilled (every hour on a weekend or holiday,
// only the hours past 9 on a workday), a note describing the work, required.
export function ExtraTimeClaimModal({ fd, onClose, onDone, toastOk, toastErr }) {
  const existing = fd.claim && fd.claim.status === 'pending' ? fd.claim : null;
  const [minutes, setMinutes] = useState(existing ? existing.claimedMin : fd.claimableMin);
  const [note, setNote] = useState(existing?.note || '');
  const [busy, setBusy] = useState(false);
  const weekday = fd.dayKind === 'scheduled' || fd.dayKind === 'half_holiday';
  const dirty = existing ? (minutes !== existing.claimedMin || note !== existing.note) : (!!note.trim());
  const valid = minutes > 0 && minutes <= fd.claimableMin && note.trim().length > 0;
  const save = async () => {
    setBusy(true);
    try {
      if (existing) await api.extraTimeEdit(existing.id, { minutes, note });
      else await api.extraTimeFile({ date: fd.date, minutes, note });
      toastOk?.(existing ? 'Extra Time claim updated.' : 'Extra Time claimed - it goes to your approver.');
      onDone?.();
    } catch (e) { toastErr?.(e?.message || 'Could not save the claim.'); }
    setBusy(false);
  };
  const withdraw = async () => {
    setBusy(true);
    try {
      await api.extraTimeWithdraw(existing.id);
      toastOk?.('Claim withdrawn - the hours count toward the month-end reconciliation.');
      onDone?.();
    } catch (e) { toastErr?.(e?.message || 'Could not withdraw the claim.'); }
    setBusy(false);
  };
  return (
    <Modal title={`Claim Extra Time - ${formatDate(fd.date)}`} onClose={onClose} isDirty={dirty && !busy}
      footer={(
        <>
          {existing && <button className="secondary-btn" disabled={busy} onClick={withdraw}>Withdraw Claim</button>}
          <button className="secondary-btn" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="primary-btn" disabled={busy || !valid} onClick={save}>{existing ? 'Save Claim' : 'Submit Claim'}</button>
        </>
      )}>
      <div data-testid="extra-time-claim" style={{ display: 'flex', flexDirection: 'column', gap: 16, flex: 1, minHeight: 0 }}>
        <p style={{ ...hint, margin: 0 }}>
          {weekday
            ? `On a scheduled workday only the hours past ${fd.dayKind === 'half_holiday' ? '4.5' : '9'} can be paid as Extra Time - up to ${hm(fd.claimableMin)} on this day.`
            : `Every hour worked on a weekend or a holiday can be claimed - ${hm(fd.claimableMin)} on this day.`}
          {' '}Approved Extra Time is paid at 1.35x the hourly equivalent of your daily rate. Hours you do not claim, or that are declined, count toward the month-end reconciliation instead.
        </p>
        <label style={field} htmlFor="xt-claim-h">
          Hours
          <HoursBox minutes={minutes} onChange={setMinutes} max={fd.claimableMin} idPrefix="xt-claim" />
        </label>
        <div className="nx-fill" style={field}>
          <label htmlFor="xt-claim-note">What Was the Work</label>
          <textarea id="xt-claim-note" className="form-input" value={note} onChange={e => setNote(e.target.value)} maxLength={1000}
            placeholder="Describe the work you did in these hours - required" />
        </div>
      </div>
    </Modal>
  );
}

// HR / the HR contact / a Global Admin: approve all or fewer of the hours, or
// decline with a reason the contractor sees.
export function ExtraTimeDecideModal({ fd, name, onClose, onDone, toastOk, toastErr }) {
  const c = fd.claim;
  const [minutes, setMinutes] = useState(c.status === 'approved' ? c.approvedMin : c.claimedMin);
  const [reason, setReason] = useState(c.status === 'declined' ? c.decisionNote : '');
  const [busy, setBusy] = useState(false);
  const most = Math.min(c.claimedMin, fd.claimableMin ?? c.claimedMin);
  const decide = async (decision) => {
    setBusy(true);
    try {
      await api.extraTimeDecide(c.id, decision === 'approve' ? { decision, minutes } : { decision, reason });
      toastOk?.(decision === 'approve' ? `Approved ${hm(minutes)} of Extra Time.` : 'Extra Time declined.');
      onDone?.();
    } catch (e) { toastErr?.(e?.message || 'Could not save the decision.'); }
    setBusy(false);
  };
  return (
    <Modal title={`Extra Time - ${name ? `${name}, ` : ''}${formatDate(fd.date)}`} onClose={onClose}
      footer={(
        <>
          <button className="secondary-btn" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="secondary-btn" disabled={busy || !reason.trim()} onClick={() => decide('decline')}>Decline</button>
          <button className="primary-btn" disabled={busy || minutes <= 0 || minutes > most} onClick={() => decide('approve')}>Approve {hm(minutes)}</button>
        </>
      )}>
      <div data-testid="extra-time-decide" style={{ display: 'flex', flexDirection: 'column', gap: 16, flex: 1, minHeight: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 13 }}>
          <ExtraTimeStatus claim={c} />
          <span><strong>{hm(c.claimedMin)}</strong> claimed</span>
          {fd.workedMin != null && <span style={hint}>{hm(Math.max(0, fd.workedMin - (fd.leaveMin || 0)))} worked that day</span>}
        </div>
        <div style={{ ...field, fontWeight: 400 }}>
          <span style={{ fontWeight: 600 }}>The Work</span>
          <span style={{ whiteSpace: 'pre-wrap', fontSize: 13, color: 'var(--ink)' }}>{c.note}</span>
        </div>
        <label style={field} htmlFor="xt-decide-h">
          Hours to Approve
          <HoursBox minutes={minutes} onChange={setMinutes} max={most} idPrefix="xt-decide" />
          <span style={hint}>You may approve fewer hours than claimed. Hours not approved count toward the month-end reconciliation.</span>
        </label>
        <div className="nx-fill" style={field}>
          <label htmlFor="xt-decide-reason">Reason to Decline</label>
          <textarea id="xt-decide-reason" className="form-input" value={reason} onChange={e => setReason(e.target.value)} maxLength={1000}
            placeholder="Required to decline - the contractor sees it" />
        </div>
      </div>
    </Modal>
  );
}

export function ReconciliationPanel({ data, fmtM, showPay }) {
  const ip = data.indiaPolicy || {};
  const recon = ip.reconciliation || {};
  const rows = reconRows(recon, ip.extraTime || {}, data.totals || {}, fmtM)
    .filter(([label]) => showPay || (label !== 'Total' && label !== 'Extra Time'));
  const last = rows.length - 1;
  return (
    <div data-testid="month-end-reconciliation" style={{ flex: '0 1 520px', minWidth: 280, border: '1px solid var(--wk-line2)', borderRadius: 14, overflow: 'hidden', background: 'var(--card)', boxShadow: 'var(--wk-shadow)' }}>
      <div style={{ padding: '10px 14px', fontWeight: 800, fontSize: 13, borderBottom: '1px solid var(--line)' }}>
        Month-End Reconciliation{ip.frozen ? ' (Finalized)' : ''}
        <div style={{ fontWeight: 400, fontSize: 11.5, color: 'var(--muted)', marginTop: 3, lineHeight: 1.45 }}>
          Full day at 8 hours, half day at 4. Hours past 9, hours of short days and weekend or holiday hours not paid as Extra Time make the pool; every 4.5 pool hours buy back a missing half day, and a last 1.5 hours or more rounds up.
        </div>
      </div>
      {rows.map(([label, value], i) => (
        <div key={label} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, padding: '8px 14px', borderTop: i ? '1px solid var(--line)' : 'none', fontSize: 12.5, fontWeight: showPay && i === last ? 800 : 500, background: showPay && i === last ? 'var(--wk-hover)' : 'transparent' }}>
          <span style={{ color: 'var(--muted)' }}>{label}</span>
          <span style={{ textAlign: 'right', color: 'var(--ink)', fontVariantNumeric: 'tabular-nums' }}>{value}</span>
        </div>
      ))}
    </div>
  );
}

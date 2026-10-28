// India Contractor Work Hours and Extra Time Policy (Neil, Oct 27 2026,
// docs/India-Contractor-Pay.md): words and labels for the numbers the server
// computes (india_contractor_pay.py). Never recompute pay here.

export const hm = (min) => {
  const m = Math.max(0, Math.round(min || 0));
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
};

export const daysWords = (halves) => {
  const d = (halves || 0) / 2;
  return `${d} day${d === 1 ? '' : 's'}`;
};

// Soft labels (components/StatusLabel.jsx) - Title Case words.
export const EXTRA_TIME_STATUS = {
  pending: { label: 'Pending', color: '#b45309' },
  approved: { label: 'Approved', color: '#15803d' },
  declined: { label: 'Declined', color: '#b91c1c' },
  withdrawn: { label: 'Withdrawn', color: '#64748b' },
};

export const CREDIT_LABEL = {
  full: { label: 'Full', color: '#15803d' },
  half: { label: 'Half', color: '#b45309' },
  none: { label: 'None', color: '#b91c1c' },
  pending: { label: 'Not Over', color: '#64748b' },
  holiday: { label: 'Holiday', color: '#2563eb' },
};

// One day's credit on the card: Full / Half / None, and "Paid Leave" when the
// balance covered it. Weekends carry no credit.
export function creditText(fd) {
  if (!fd || !fd.dayKind || fd.dayKind === 'weekend') return '';
  if (fd.dayKind === 'holiday') return 'Holiday';
  const c = CREDIT_LABEL[fd.credit];
  if (!c) return '';
  return fd.leaveHalves ? `${c.label} (Paid Leave)` : c.label;
}

// The Month-End Reconciliation panel's lines, from the server's numbers.
export function reconRows(recon = {}, extraTime = {}, totals = {}, fmtM = (n) => String(n)) {
  const rows = [
    ['Scheduled workdays', String(recon.scheduledDays ?? 0)],
    ['Credits earned (hours worked and paid leave)', daysWords(recon.earnedHalves)],
  ];
  if (recon.upcomingDays) rows.push(['Days not over yet (never deducted)', String(recon.upcomingDays)]);
  rows.push(
    ['Missing', daysWords(recon.missingHalves)],
    ['Pool hours (excess and incomplete-day hours)', hm(recon.poolMin)],
    ['Half days recovered', `${recon.recoveredHalves ?? 0}${recon.roundedUp ? ` (the ${hm(recon.remainderMin)} remainder rounded up)` : ''}`],
    ['Unpaid days', daysWords(recon.unpaidHalves)],
    ['Extra Time', `${hm(recon.extraTimeMin)} x ${fmtM(extraTime.rate)} = ${fmtM(recon.extraTimePay)}`],
    ['Total', fmtM(totals.totalPay)],
  );
  return rows;
}

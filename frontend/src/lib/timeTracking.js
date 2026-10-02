// The time-tracking exemption (no time clock, no timesheet) is set on the
// person's role in Settings > Access, beside the screen-share exemption
// (Visesh, 10/02). Pay & Benefits only shows it, read-only, with the role
// that sets it (`payroll.timeTrackingExemptVia` from the HR profile payload).
export function timeTrackingText(payroll) {
  if (!payroll?.timeTrackingExempt) return 'Tracked';
  return payroll.timeTrackingExemptVia ? `Exempt (set by role: ${payroll.timeTrackingExemptVia})` : 'Exempt';
}

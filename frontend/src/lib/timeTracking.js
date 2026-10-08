// The time-tracking exemption (no time clock, no timesheet) is set on the
// person's role in Settings > Access, beside the screen-share exemption
// (Visesh, 10/02). Pay & Benefits only shows it, read-only, with the role
// that sets it (`payroll.timeTrackingExemptVia` from the HR profile payload).
export function timeTrackingText(payroll) {
  if (!payroll?.timeTrackingExempt) return 'Tracked';
  return payroll.timeTrackingExemptVia ? `Exempt (set by role: ${payroll.timeTrackingExemptVia})` : 'Exempt';
}

// Whether this person is time-tracking exempt, remembered per person across
// visits, so a screen can decide BEFORE `/time/status` answers (Neil, 10/06
// and 10/08: for a salaried person the Time Sheet tab, the clock card's
// skeleton and the Hours tile each showed for a moment on every visit, then
// vanished - a time-tracking surface loading for someone who has none). Every
// place that receives the flag writes it; the Workday page reads it while it
// waits. null = never answered for this person on this browser.
const exemptKey = (email) => `nexus.timeExempt.${(email || '').toLowerCase()}`;

export function recallTimeExempt(email) {
  try {
    const v = localStorage.getItem(exemptKey(email));
    return v === null ? null : v === '1';
  } catch { return null; }   // private window
}

export function rememberTimeExempt(email, exempt) {
  try { localStorage.setItem(exemptKey(email), exempt ? '1' : '0'); } catch { /* private window */ }
}

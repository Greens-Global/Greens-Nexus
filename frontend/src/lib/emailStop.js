// One-click stop for digest emails (11/02/2026, the legal compliance pass;
// backend/email_optout.py). Every digest carries "Stop These Emails", a link
// to /?stopEmail=<kind>. The link changes nothing by itself (a mail scanner
// that opens it cannot unsubscribe anyone): TopHeader reads it at module load
// - before the app's boot rewrites the address - and opens Profile on its
// email section, where DigestEmailPrefs takes it and turns that digest off
// for the signed-in person, with Start It Again beside it.
export const EMAIL_KINDS = ['daily_briefing', 'weekly_digest', 'whats_new_digest', 'ticket_weekly_report'];

let pending = '';

export function readStopEmail(search) {
  const kind = new URLSearchParams(search || '').get('stopEmail') || '';
  return EMAIL_KINDS.includes(kind) ? kind : '';
}

export function setPendingEmailStop(kind) { pending = EMAIL_KINDS.includes(kind) ? kind : ''; }

export function takePendingEmailStop() {
  const k = pending;
  pending = '';
  return k;
}

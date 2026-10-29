// "Expect a reply by 10/29/2026 2:00 PM" (Help Center, Oct 2026) - on a
// requester's ticket nobody has answered yet. The time is the ticket's own
// first-response deadline, set by the server from business hours and paused
// while the ticket waits on the requester (ticket_sla.py, Honest SLA) - this
// only reads it (firstResponseState), never works out a second one. Nothing
// shows once someone replied, while it is paused, after the deadline passed,
// or on a ticket with no first-response clock.
import { Clock } from 'lucide-react';
import { firstResponseState, fmtMoment } from '../tickets/ticketMeta';

export default function ExpectReply({ t, style }) {
  if (!t || firstResponseState(t) !== 'due') return null;
  return (
    <div data-testid="expect-reply" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, fontWeight: 600,
      color: 'var(--muted)', marginTop: 2, ...style }}>
      <Clock size={11} aria-hidden="true" /> Expect a reply by {fmtMoment(t.firstResponseDueAt)}
    </div>
  );
}

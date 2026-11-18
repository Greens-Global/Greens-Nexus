// Kudos for whoever closed your ticket (Neil, 11/12/2026: "give an option -
// shouldn't be too obvious or people will always do it - to give kudos to
// the assignee"). A quiet line under the satisfaction stars, never a button
// or a prompt: it shows only to the person the ticket was for, only once the
// ticket is resolved or closed, only after they rated it 4 or 5 stars, and
// only when someone else - a Nexus person, not an outside guest - worked it.
// It opens the ordinary Give Kudos form (performance/Kudos.jsx) with the
// assignee picked; nothing about the ticket is sent or stored with it. An Ask
// HR ticket never offers it: a kudos is seen by the whole company.
import { useState } from 'react';
import { Award } from 'lucide-react';
import { NX } from '../tasks/theme';
import { GiveKudosModal } from '../performance/Kudos';
import { dialog as appDialog } from '../ui/dialog';
import { ticketNo } from './ticketMeta';

const CLOSED = ['resolved', 'closed'];
const sentKey = (id) => `nx-ticket-kudos:${id}`;
const wasSent = (id) => { try { return localStorage.getItem(sentKey(id)) === '1'; } catch { return false; } };
const markSent = (id) => { try { localStorage.setItem(sentKey(id), '1'); } catch { /* storage blocked: the line just offers again */ } };

/** Whether the line is offered at all - the one rule, exported for the tests. */
export function kudosOffered({ ticket, rating, myEmail, assigneeExternal = false }) {
  if (!ticket || !CLOSED.includes(ticket.status) || ticket.confidentialDesk) return false;
  const me = (myEmail || '').toLowerCase();
  const assignee = (ticket.assigneeId || '').toLowerCase();
  const requester = (ticket.requesterId || '').toLowerCase();
  return !!me && !!assignee && requester === me && assignee !== me && !assigneeExternal && (rating || 0) >= 4;
}

export default function TicketKudos({ ticket, rating, myEmail, nameOf, assigneeExternal = false }) {
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState(() => wasSent(ticket?.id));
  if (!kudosOffered({ ticket, rating, myEmail, assigneeExternal })) return null;
  const full = nameOf?.(ticket.assigneeId) || ticket.assigneeId;
  const first = String(full).split(/[\s@]/)[0];
  const line = { display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, fontSize: 12, color: NX.dim };
  if (sent) {
    return <div style={line} data-testid="ticket-kudos-sent"><Award size={13} aria-hidden="true" /> Kudos sent to {first}.</div>;
  }
  return (
    <>
      <div style={line} data-testid="ticket-kudos">
        <Award size={13} aria-hidden="true" />
        <span>{first} took care of this.</span>
        <button type="button" onClick={() => setOpen(true)}
          style={{ border: 0, background: 'none', padding: 0, font: 'inherit', color: NX.dim, textDecoration: 'underline', textUnderlineOffset: 2, cursor: 'pointer' }}>
          Give Kudos
        </button>
      </div>
      {open && (
        <GiveKudosModal me={myEmail} to={ticket.assigneeId} onClose={() => setOpen(false)}
          placeholder={`Sorted out ${ticketNo(ticket.code) || 'my ticket'} - ${ticket.subject || ''}`.slice(0, 120)}
          onGiven={() => { markSent(ticket.id); setSent(true); setOpen(false); }}
          toastErr={(m) => appDialog.alert(m, { title: 'Not Sent' })} />
      )}
    </>
  );
}

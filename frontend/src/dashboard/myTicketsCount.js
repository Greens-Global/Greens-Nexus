// My Open Tickets (Neil, Oct 26 2026) - the ticket twin of My Open Tasks
// (myTasksCount.js). The number is the open tickets assigned to you
// (backend my_work.ticket_focus_counts); the line under it names what needs
// you on top of that: "2 past SLA, +5 to assign" - the second part only for
// the service desk, from the same rule as their Tickets to Assign priority
// notice. Null when there is nothing to name, so the tile keeps its hint.
// `short` is the narrow-tile wording.
export function myTicketsFootnote(kpis, short = false) {
  const parts = [];
  const breached = Number(kpis?.my_open_tickets_breached) || 0;
  const unassigned = Number(kpis?.my_open_tickets_unassigned) || 0;
  if (breached > 0) parts.push(short ? `${breached} late` : `${breached} past SLA`);
  if (unassigned > 0) parts.push(short ? `+${unassigned} to assign` : `+${unassigned} waiting to be assigned`);
  return parts.length ? parts.join(', ') : null;
}
export const MY_TICKETS_RULE = 'Open tickets assigned to you';

// Where the tile lands: your own queue, or - with nothing assigned to you
// and tickets waiting on the desk - the Unassigned list.
export function myTicketsFilter(kpis) {
  const mine = Number(kpis?.my_open_tickets) || 0;
  const unassigned = Number(kpis?.my_open_tickets_unassigned) || 0;
  return !mine && unassigned > 0 ? 'unassigned' : 'assigned';
}

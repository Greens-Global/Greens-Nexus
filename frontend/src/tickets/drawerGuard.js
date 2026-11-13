// Ticket Module - asked before a bell click (nexus:open-ticket) swaps the open
// ticket drawer for another ticket while the open one still holds edits that
// were never saved (Oct 2026 review: the swap remounted the drawer and threw
// them away without a word). Shared by the Tickets module and Support, the
// two screens that host the drawer.
//
// The reply being written is a kept draft since 11/13/2026 (ticketDrafts.js):
// leaving the ticket no longer loses it, so the question says what really
// happens - the open drawer notes what it holds there (noteHeld).
import { dialog } from '../ui/dialog';
import { heldNow, leaveQuestion } from './ticketDrafts';

export function confirmSwitchTicket() {
  const held = heldNow();
  // Only a reply is held: nothing is discarded, the draft stays with its ticket.
  if (held && held.reply && !held.edits) {
    const q = leaveQuestion(held);
    return dialog.confirm(q.message, q.opts);
  }
  return dialog.confirm(
    `The ticket you have open has unsaved changes. Open the other ticket and discard them?${held?.reply ? ' Your reply is kept as a draft.' : ''}`,
    { title: 'Discard Changes?', confirmText: 'Discard and Open', cancelText: 'Keep Editing', danger: true },
  );
}

// Ticket Module - asked before a bell click (nexus:open-ticket) swaps the open
// ticket drawer for another ticket while the open one still holds edits that
// were never saved (Oct 2026 review: the swap remounted the drawer and threw
// them away without a word). Shared by the Tickets module and Support, the
// two screens that host the drawer.
import { dialog } from '../ui/dialog';

export function confirmSwitchTicket() {
  return dialog.confirm(
    'The ticket you have open has unsaved changes. Open the other ticket and discard them?',
    { title: 'Discard Changes?', confirmText: 'Discard and Open', cancelText: 'Keep Editing', danger: true },
  );
}

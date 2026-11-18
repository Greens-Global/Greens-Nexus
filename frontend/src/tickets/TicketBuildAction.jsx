// Send To Claude Code on a ticket (Neil, 11/12/2026: everyone outside the IT
// development team comes in through a TICKET, never straight to Claude Code).
// One button in the ticket's footer, drawn only for someone with the Build
// Mode grant (the store's `enabled` - the server's answer, asked once by the
// Build Mode shell). The server makes ONE pin from the ticket - its words,
// the place Point At It recorded, copies of its pictures - in that person's
// Build Session; the ticket gets an activity line, never a comment, and its
// status is the desk's to change. Never on an Ask HR ticket - the caller
// does not render this for one, and the server answers "not found".
import { useState } from 'react';
import { Hammer, ExternalLink, Loader2 } from 'lucide-react';
import { api } from '../api';
import { btn } from '../tasks/theme';
import { dialog as appDialog } from '../ui/dialog';
import { useBuildStore, requestOpenPin } from '../devnotes/store';
import { CLAUDE_SEND_ON } from '../devnotes/meta';

export default function TicketBuildAction({ ticketId, style = null, iconSize = 14, onOpen }) {
  const enabled = useBuildStore((s) => s.enabled);
  const [busy, setBusy] = useState(false);
  const [pin, setPin] = useState(null);       // the pin this click made
  if (!enabled || !CLAUDE_SEND_ON || !ticketId) return null;
  if (pin) {
    return (
      <button type="button" style={style || btn('outline')} data-testid="ticket-build-open"
        title={pin.status === 'dispatched' ? 'Sent to Claude Code - open the pin' : 'It is in your Build Session - open the pin, then send it from the Queue'}
        onClick={() => { onOpen?.(); requestOpenPin(pin.id); }}>
        <ExternalLink size={iconSize} /> Open Pin #{pin.number}
      </button>
    );
  }
  const send = async () => {
    setBusy(true);
    try { setPin(await api.devNotesFromTicket(ticketId)); }
    catch (e) { appDialog.alert(e?.message || 'The ticket was not sent to Claude Code.', { title: 'Not Sent' }); }
    finally { setBusy(false); }
  };
  return (
    <button type="button" style={style || btn('outline')} disabled={busy} onClick={send} data-testid="ticket-build-send"
      title="Make a Build Mode pin from this ticket - its words, where it points and its pictures - for Claude Code to fix">
      {busy ? <Loader2 size={iconSize} className="bm-spin" /> : <Hammer size={iconSize} />} Send To Claude Code
    </button>
  );
}

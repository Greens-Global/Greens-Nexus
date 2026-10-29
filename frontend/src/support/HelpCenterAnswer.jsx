// Ask Nexus under the Help Center search bar (Oct 2026) - AskNexus with this
// person's guide access, loaded only once someone asks.
import AskNexus from './AskNexus';
import { useDocAccess } from './docsAccess';
import { ticketSeedFor } from './ticketSeed';

export default function HelpCenterAnswer({ question, onFileTicket }) {
  const { allow } = useDocAccess();
  return <AskNexus question={question} allow={allow} onFileTicket={(q) => onFileTicket?.(ticketSeedFor(q))} />;
}

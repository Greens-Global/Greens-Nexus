// Ticket Module - Manage: admin surface for the ticket workspace. Split out of
// the task module's ManageView (Jul 2026) so ticket admin lives with the
// module it configures instead of inside Tasks' Manage screen.
import TicketNotifySettings from './TicketNotifySettings';
import { NX, FONT } from '../tasks/theme';

export default function TicketManageView() {
  return (
    <div className="nx-scroll" style={{ fontFamily: FONT, color: NX.ink, flex: 1, minHeight: 0, overflow: 'auto', background: NX.surface2, padding: 20 }}>
      <div style={{ maxWidth: 940, margin: '0 auto' }}>
        <TicketNotifySettings />
      </div>
    </div>
  );
}

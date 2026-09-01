// Tickets - the support/IT/request ticketing module. Split out of the Task
// module (Jul 2026) into its own top-level Nexus module: it used to live
// behind a Task | Ticket toggle inside Tasks, now it's a sidebar entry of its
// own. Ticket state still lives in TasksContext (the shared data engine) -
// see tickets/TicketsView.jsx for why. The TasksProvider itself is mounted by
// App.jsx (shared with the Tasks view at that call site) so switching between
// Tasks and Tickets in the sidebar doesn't refetch everything each time -
// see App.jsx's ProtectedView.
import { useState } from 'react';
import { Settings } from 'lucide-react';
import TicketsView from '../tickets/TicketsView';
import TicketManageView from '../tickets/TicketManageView';
import ReportBugButton from '../tasks/ReportBug';
import { useIsMobile } from '../tasks/components';
import { useRole } from '../contexts/RoleContext';
import { NX, FONT, btn } from '../tasks/theme';

export default function Tickets() {
  const { can } = useRole();
  const canManage = !!can?.('manager');
  const [manage, setManage] = useState(false);
  const isMobile = useIsMobile();

  // Manage is an admin surface (ticket notifications today) - hidden from
  // anyone below Manager, same gate as the Task module's Manage tab. It rides
  // in the Tickets header next to New Ticket instead of in a bar of its own,
  // and Exit rides on the Manage screen's tab strip.
  // Sized off the same btn() scale as New Ticket so the pair reads as one
  // control group rather than two buttons from different screens.
  const manageBtn = canManage ? (
    <button className="nx-iconbtn" onClick={() => setManage(true)} title="Manage" style={btn('outline')}>
      <Settings size={15} /> <span className="nx-btn-label">Manage</span>
    </button>
  ) : null;

  return (
    <div className="nx-tasks" style={{ fontFamily: FONT, display: 'flex', flexDirection: 'column', height: '100%', background: NX.canvas }}>
      <div style={{ flex: 1, minHeight: 0 }}>
        {manage ? <TicketManageView onExit={() => setManage(false)} /> : <TicketsView manageAction={manageBtn} />}
      </div>
      {/* TicketsView renders its own floating MobileTaskBar (view switcher +
          create +) on phones - offset above it, same as Tasks does for its
          own mobile bar. */}
      {!manage && <ReportBugButton bottom={isMobile ? 84 : undefined} />}
    </div>
  );
}

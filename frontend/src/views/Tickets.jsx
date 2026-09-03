// Tickets - the support/IT/request ticketing module. Split out of the Task
// module (Jul 2026) into its own top-level Nexus module: it used to live
// behind a Task | Ticket toggle inside Tasks, now it's a sidebar entry of its
// own. Ticket state still lives in TasksContext (the shared data engine) -
// see tickets/TicketsView.jsx for why. The TasksProvider itself is mounted by
// App.jsx (shared with the Tasks view at that call site) so switching between
// Tasks and Tickets in the sidebar doesn't refetch everything each time -
// see App.jsx's ProtectedView.
import { useState } from 'react';
import { Settings, X } from 'lucide-react';
import TicketsView from '../tickets/TicketsView';
import TicketManageView from '../tickets/TicketManageView';
import { useRole } from '../contexts/RoleContext';
import { NX, FONT } from '../tasks/theme';

export default function Tickets() {
  const { can } = useRole();
  const canManage = !!can?.('manager');
  const [manage, setManage] = useState(false);

  return (
    <div className="nx-tasks" style={{ fontFamily: FONT, display: 'flex', flexDirection: 'column', height: '100%', background: NX.canvas }}>
      {/* Manage is an admin surface (ticket notifications today) - hidden from
          anyone below Manager, same gate as the Task module's Manage tab. */}
      {canManage && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', padding: '9px 16px', borderBottom: '1px solid var(--border-color)', background: 'var(--bg-card)', flexShrink: 0 }}>
          {manage ? (
            <button className="primary-btn nx-iconbtn" onClick={() => setManage(false)} title="Exit" style={{ fontFamily: FONT }}>
              <X size={14} /> <span className="nx-btn-label">Exit</span>
            </button>
          ) : (
            <button className="secondary-btn nx-iconbtn" onClick={() => setManage(true)} title="Manage" style={{ fontFamily: FONT }}>
              <Settings size={14} /> <span className="nx-btn-label">Manage</span>
            </button>
          )}
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0 }}>
        {manage ? <TicketManageView /> : <TicketsView />}
      </div>
    </div>
  );
}

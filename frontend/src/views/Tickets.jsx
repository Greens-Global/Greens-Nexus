// Tickets - the support/IT/request ticketing module. Split out of the Task
// module (Jul 2026) into its own top-level Nexus module: it used to live
// behind a Task | Ticket toggle inside Tasks, now it's a sidebar entry of its
// own. Ticket state still lives in TasksContext (the shared data engine) -
// see tickets/TicketsView.jsx for why. The TasksProvider itself is mounted by
// App.jsx (shared with the Tasks view at that call site) so switching between
// Tasks and Tickets in the sidebar doesn't refetch everything each time -
// see App.jsx's ProtectedView.
//
// The "Manage" admin surface (Service Desk + Email Notifications) moved to
// the Admin module in full (Pranshu, Sep 9) - it was the only thing this
// screen's Manage button led to, so the button and TicketManageView.jsx are
// both gone rather than left pointing at an empty screen.
//
// Scan to Request (11/03/2026): the sub "place/<property>[/<asset>]" - a
// scanned site or equipment tag - opens the place's sheet over the desk
// (maintenance/PlaceSheet.jsx, its own lazy chunk). Closing it clears the sub.
import { Suspense, lazy } from 'react';
import TicketsView from '../tickets/TicketsView';
import { NX, FONT } from '../tasks/theme';
import { parsePlaceSub } from '../maintenance/placeLink';
import SheetGuard from '../maintenance/SheetGuard';

const PlaceSheet = lazy(() => import('../maintenance/PlaceSheet'));

export default function Tickets({ activeSub = null, onSubChange }) {
  const place = parsePlaceSub(activeSub);
  const close = () => onSubChange?.(null);
  return (
    <div className="nx-tasks" style={{ fontFamily: FONT, display: 'flex', flexDirection: 'column', height: '100%', background: NX.canvas }}>
      <div style={{ flex: 1, minHeight: 0 }}>
        <TicketsView />
      </div>
      {place && (
        <SheetGuard onClose={close}>
          <Suspense fallback={null}>
            <PlaceSheet propertyId={place.propertyId} assetId={place.assetId} onClose={close} />
          </Suspense>
        </SheetGuard>
      )}
    </div>
  );
}

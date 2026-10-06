// The ticket screens Asset Management opens (Property Tickets, Neil 10/05),
// mounted lazily (only loaded on click) and each under its own error boundary
// + loader, so a failure inside one can never white-screen the property.
// TicketDrawer and CreateTicketModal read the Tasks store, so TasksProvider
// comes along just for them - the same trick Support.jsx uses.
import { lazy, Suspense } from 'react';
import ViewErrorBoundary from '../../../components/ViewErrorBoundary';
import { ModalLoading } from '../../../components/AsyncState';

const Composer = lazy(async () => {
  const [{ TasksProvider }, { CreateTicketModal }] = await Promise.all([
    import('../../../tasks/TasksContext'), import('../../../tickets/TicketsView')]);
  return { default: ({ property, onClose }) => (
    <TasksProvider><CreateTicketModal forProperty={property} onClose={onClose} /></TasksProvider>) };
});
const Drawer = lazy(async () => {
  const [{ TasksProvider }, { TicketDrawer }] = await Promise.all([
    import('../../../tasks/TasksContext'), import('../../../tickets/TicketsView')]);
  return { default: ({ ticketId, onClose }) => (
    <TasksProvider><TicketDrawer ticketId={ticketId} onClose={onClose} /></TasksProvider>) };
});
const Walkthrough = lazy(() => import('../../../tickets/PropertyWalkthrough'));

const guard = (node) => (
  <ViewErrorBoundary><Suspense fallback={<ModalLoading />}>{node}</Suspense></ViewErrorBoundary>
);
// The property is fixed in both: raised from GST, it is GST's ticket.
export const PropertyTicketComposer = (props) => guard(<Composer {...props} />);
export const PropertyTicketDrawer = (props) => guard(<Drawer {...props} />);
export const PropertyWalkthroughMount = (props) => guard(<Walkthrough {...props} />);

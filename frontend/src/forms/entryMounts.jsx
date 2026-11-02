// Make a Ticket / Make a Task from a form entry (Neil, 11/02/2026): the
// EXISTING create modals, prefilled - never a second composer. Both read the
// Tasks store, so TasksProvider comes along just for them, loaded on click,
// each under its own boundary - the same trick Asset Management's
// ticketMounts.jsx and the dashboard's Quick Actions use.
import { lazy, Suspense } from 'react';
import ViewErrorBoundary from '../components/ViewErrorBoundary';
import { ModalLoading } from '../components/AsyncState';
import { seedHtml } from '../support/ticketSeed';

const Ticket = lazy(async () => {
  const [{ TasksProvider }, { CreateTicketModal }] = await Promise.all([
    import('../tasks/TasksContext'), import('../tickets/TicketsView')]);
  // `initial`: { subject, description (plain text, one paragraph per line) }.
  return { default: ({ initial, onClose, onCreated }) => (
    <TasksProvider><CreateTicketModal initial={initial} onClose={onClose} onCreated={onCreated} /></TasksProvider>) };
});
const Task = lazy(async () => {
  const [{ TasksProvider }, { default: CreateTaskModal }] = await Promise.all([
    import('../tasks/TasksContext'), import('../tasks/CreateTaskModal')]);
  // `defaults`: { title, description (plain text), files } - the description
  // becomes the editor's HTML here, one paragraph per line.
  return { default: ({ defaults, onClose, onCreated }) => (
    <TasksProvider><CreateTaskModal defaults={{ ...defaults, description: seedHtml(defaults?.description) }} onClose={onClose} onCreated={onCreated} /></TasksProvider>) };
});

const guard = (node) => (
  <ViewErrorBoundary><Suspense fallback={<ModalLoading />}>{node}</Suspense></ViewErrorBoundary>
);
export const TicketComposer = (props) => guard(<Ticket {...props} />);
export const TaskComposer = (props) => guard(<Task {...props} />);

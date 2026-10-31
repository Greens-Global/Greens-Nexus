// What the header's Create menu offers (Neil, Oct 29 2026) - the list and the
// one visibility rule; components/QuickCreate.jsx draws it.
//
// Nothing here is a form of its own. Each row opens the create flow the
// module already has:
//   compose - the Dashboard's Quick Action composers (dashboard/
//             QuickActionModals.jsx: the Tasks module's CreateTaskModal, the
//             Ticket module's CreateTicketModal, the Outlook mail and event
//             composers), opened in place over the current screen.
//   go      - a { view, sub } the module answers by opening its own create
//             dialog - "<thing>:new" style subs, the convention "purchase:new"
//             started (Workday > Purchase Requests):
//               documents / documents-new         My Documents > New Document
//               inventory / catalog               the item catalog's Request
//
// Who sees a row is the left menu's own rule (Sidebar's isNavItemVisible)
// for the module it lands in, plus the grant level that module's own New
// button asks for when a row sets `level` (canAccessModule).
//
// New Note sits under New Task on every screen (Neil, Oct 29 2026 for the
// phone, Oct 30 for the web too): it opens the Quick Note panel through the
// `nexus:quick-note` event. It is the way in (with Ctrl+Alt+N) - the top bar
// has no scratchpad button (Neil, Oct 30 2026).
//
// Kept off the menu on purpose (Neil, Oct 29 2026): 1:1s, Ask HR,
// Reimbursements, Credentials, Purchase Requests, Send for Signature,
// Workflows and Time Off - those start from their own modules.
import { CheckSquare, NotebookPen, FilePlus2, Package, Mail, CalendarPlus } from 'lucide-react';
import TicketToken from '../components/icons/TicketToken';
import { NAV, isNavItemVisible } from '../components/Sidebar';

export const goTo = (view, sub) => window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view, sub } }));

// Display order. `module` = the left-menu item the flow lives in; `level` =
// the grant level that module's own New button needs.
export const CREATE_ITEMS = [
  { key: 'task', group: 'Work', label: 'New Task', Icon: CheckSquare, module: 'tasks', compose: 'task' },
  { key: 'note', group: 'Work', label: 'New Note', Icon: NotebookPen, module: 'dashboard',
    run: () => window.dispatchEvent(new CustomEvent('nexus:quick-note')) },
  { key: 'ticket', group: 'Work', label: 'New Ticket', Icon: TicketToken, module: 'support', compose: 'ticket' },
  { key: 'document', group: 'Work', label: 'New Document', Icon: FilePlus2, module: 'documents', go: ['documents', 'documents-new'] },
  { key: 'item', group: 'Requests', label: 'Request an Item', Icon: Package, module: 'inventory', go: ['inventory', 'catalog'] },
  // The Dashboard's Quick Actions offer these to everyone who has a Dashboard.
  { key: 'email', group: 'Outlook', label: 'New Email', Icon: Mail, module: 'dashboard', compose: 'email' },
  { key: 'event', group: 'Outlook', label: 'New Event', Icon: CalendarPlus, module: 'dashboard', compose: 'event' },
];

/** The rows this person may use. `role` is useRole(). */
export function visibleCreates(role) {
  return CREATE_ITEMS.filter((it) => {
    const nav = NAV.find((n) => n.view === it.module);
    if (!nav || !isNavItemVisible(nav, role || {})) return false;
    if (it.level && !role?.canAccessModule?.(it.module, 'administrator', it.level)) return false;
    return true;
  });
}

/** Rows in display order, gathered under their section labels. */
export function groupCreates(items) {
  const out = [];
  items.forEach((it) => {
    const g = out.find((x) => x.label === it.group);
    if (g) g.items.push(it); else out.push({ label: it.group, items: [it] });
  });
  return out;
}

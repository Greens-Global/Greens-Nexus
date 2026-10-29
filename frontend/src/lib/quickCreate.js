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
//               documents / documents-esign-send  Nexus Sign > Send for Signature
//               credvault / new                   New Credential
//               myhr / timeoff                    the Request Time Off form
//               myhr / reimbursements:new         Reimbursements > New
//               myhr / purchase:new               New Purchase Request
//               myhr / ask-hr:new                 Ask HR > New Request
//               myhr / performance:1on1:new       Set Up a 1:1
//               inventory / catalog               the item catalog's Request
//   run     - New Workflow, which (like the module's own button) makes a
//             blank workflow on the server and opens it in the builder.
//
// Who sees a row is the left menu's own rule (Sidebar's isNavItemVisible)
// for the module it lands in, plus the grant level that module's own New
// button asks for (canAccessModule, as Credentials and Workflows do), and
// New 1:1 only for someone with people reporting to them (Performance's own
// hasTeam).
import {
  CheckSquare, FilePlus2, FileSignature, KeyRound, Workflow, CalendarClock, Receipt,
  ShoppingCart, Package, Contact, Mail, CalendarPlus, Users,
} from 'lucide-react';
import TicketToken from '../components/icons/TicketToken';
import { NAV, isNavItemVisible } from '../components/Sidebar';
import { api } from '../api';

export const goTo = (view, sub) => window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view, sub } }));

// Workflows' own New Workflow (workflows/Overview.jsx, WorkflowList.jsx): a
// blank workflow in the owner's own scope, opened in the builder. If the
// server says no, the Workflows list is where the person can see why.
export async function newWorkflow() {
  try {
    const wf = await api.wfCreate({ name: 'Untitled Workflow', companyId: '' });
    goTo('workflows', wf?.id ? `wf:${wf.id}` : 'list');
  } catch {
    goTo('workflows', 'list');
  }
}

// Display order. `module` = the left-menu item the flow lives in; `level` =
// the grant level that module's own New button needs; `team` = managers only.
export const CREATE_ITEMS = [
  { key: 'task', group: 'Work', label: 'New Task', Icon: CheckSquare, module: 'tasks', compose: 'task' },
  { key: 'ticket', group: 'Work', label: 'New Ticket', Icon: TicketToken, module: 'support', compose: 'ticket' },
  { key: 'document', group: 'Work', label: 'New Document', Icon: FilePlus2, module: 'documents', go: ['documents', 'documents-new'] },
  { key: 'sign', group: 'Work', label: 'Send for Signature', Icon: FileSignature, module: 'documents', go: ['documents', 'documents-esign-send'] },
  { key: 'credential', group: 'Work', label: 'New Credential', Icon: KeyRound, module: 'credvault', level: 'editor', go: ['credvault', 'new'] },
  { key: 'workflow', group: 'Work', label: 'New Workflow', Icon: Workflow, module: 'workflows', level: 'editor', run: newWorkflow },
  { key: 'time-off', group: 'Requests', label: 'Request Time Off', Icon: CalendarClock, module: 'myhr', go: ['myhr', 'timeoff'] },
  { key: 'reimbursement', group: 'Requests', label: 'New Reimbursement', Icon: Receipt, module: 'myhr', go: ['myhr', 'reimbursements:new'] },
  { key: 'purchase', group: 'Requests', label: 'New Purchase Request', Icon: ShoppingCart, module: 'myhr', go: ['myhr', 'purchase:new'] },
  { key: 'item', group: 'Requests', label: 'Request an Item', Icon: Package, module: 'inventory', go: ['inventory', 'catalog'] },
  { key: 'ask-hr', group: 'Requests', label: 'Ask HR', Icon: Contact, module: 'myhr', go: ['myhr', 'ask-hr:new'] },
  // The Dashboard's Quick Actions offer these to everyone who has a Dashboard.
  { key: 'email', group: 'Outlook', label: 'New Email', Icon: Mail, module: 'dashboard', compose: 'email' },
  { key: 'event', group: 'Outlook', label: 'New Event', Icon: CalendarPlus, module: 'dashboard', compose: 'event' },
  { key: 'one-on-one', group: 'My Team', label: 'New 1:1', Icon: Users, module: 'myhr', team: true, go: ['myhr', 'performance:1on1:new'] },
];

/** The rows this person may use. `role` is useRole(); `hasTeam` = Performance's own flag. */
export function visibleCreates(role, { hasTeam = false } = {}) {
  return CREATE_ITEMS.filter((it) => {
    const nav = NAV.find((n) => n.view === it.module);
    if (!nav || !isNavItemVisible(nav, role || {})) return false;
    if (it.level && !role?.canAccessModule?.(it.module, 'administrator', it.level)) return false;
    if (it.team && !hasTeam) return false;
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

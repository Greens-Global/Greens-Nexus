import { useState, useEffect } from 'react';
import {
  Package, User, ClipboardList, ShoppingCart, Users, FileText,
  Building2, Plug, ListChecks, FileCheck, Shield, ClipboardCheck, Folder,
  MessageSquare, PackageSearch, Calendar, Circle,
  Home, CheckCircle2, FolderKanban, Briefcase,
  LayoutTemplate, FileSignature,
} from 'lucide-react';
import { TASKS_PERSON_PAGE } from '../lib/personTasksNav';

// Icons for broadcast (dynamic) actions, keyed by action id - keeps the bar
// visually identical whether actions are static or registered by a view.
const DYN_ICONS = {
  overview: Building2, utilities: Plug, timeline: ListChecks, permit: FileCheck,
  documents: FileText, warranties: Shield, inspections: ClipboardCheck,
  workload: Users, projects: Folder, actions: MessageSquare,
  'who-has-what': PackageSearch, calendar: Calendar,
  // Item Management's tabs (views/InventoryManagement.jsx broadcasts the ones
  // this person has - Items redesign, 11/02/2026).
  'items-mystuff': User, 'items-borrow': ShoppingCart, 'items-requests': ClipboardList, 'items-inventory': Package,
};

// Phone bottom bar (Visesh's design): ONLY the current screen's actions.
// Menu lives top-left in the header; screens without registered actions
// show no bar at all. Item Management broadcasts its own tabs (the ones the
// person has), so the bar always matches the screen.
// Task module's own module-tab strip (Home/Tasks/Projects/Portfolios/Teams,
// views/Tasks.jsx MODULE_TABS) - Asana app style: icon-over-label, fixed to
// the bottom instead of the swipeable top strip desktop uses.
const TASK_ACTIONS = [
  { sub: 'home',       label: 'Home',       Icon: Home },
  { sub: 'mine',       label: 'Tasks',      Icon: CheckCircle2 },
  { sub: 'projects',   label: 'Projects',   Icon: FolderKanban },
  { sub: 'portfolios', label: 'Portfolios', Icon: Briefcase },
  { sub: 'teams',      label: 'Teams',      Icon: Users },
];
// Documents module tab strip (views/Documents.jsx TABS), same treatment as the
// Task module's: the swipeable top strip is for desktop, phones get it here as
// icon-over-label. Same order and icons as the desktop strip; labels are
// shortened only where the full one would ellipsize in a fifth of a phone.
const DOCUMENT_ACTIONS = [
  { sub: 'documents-browse',    label: 'Documents',  Icon: Folder },
  { sub: 'documents-templates', label: 'Templates',  Icon: LayoutTemplate },
  { sub: 'documents-forms',     label: 'Forms',      Icon: ClipboardList },
  { sub: 'documents-esign',     label: 'Sign',       Icon: FileSignature },
  { sub: 'documents-pdf',       label: 'PDF Tools',  Icon: FileText },
];

export default function MobileNav({ activeView, activeSub }) {

  // Views can broadcast their own action set (label + id + active) via
  // 'nexus:mobile-actions'; taps come back as 'nexus:mobile-action'. This is
  // how screens with internal tabs (PropertyAsset sections) populate the bar
  // without MobileNav knowing their internals.
  // The last broadcast is kept on window too, so a screen that announced its
  // actions before this bar mounted (Item Management on a fresh load) still
  // shows them.
  const [dynActions, setDynActions] = useState(() => (typeof window !== 'undefined' && window.__nexusMobileActions) || null);
  useEffect(() => {
    const h = e => setDynActions(e.detail?.actions || null);
    window.addEventListener('nexus:mobile-actions', h);
    return () => window.removeEventListener('nexus:mobile-actions', h);
  }, []);

  // A person opened in Tasks from search elsewhere is a page of its own -
  // no module tabs, here as on the desktop strip (Sagar, Oct 27).
  const [personOutside, setPersonOutside] = useState(false);
  useEffect(() => {
    const h = (e) => setPersonOutside(!!e.detail?.outside);
    window.addEventListener(TASKS_PERSON_PAGE, h);
    return () => window.removeEventListener(TASKS_PERSON_PAGE, h);
  }, []);

  let actions = null;
  let effSub = activeSub;
  if (activeView === 'tasks') {
    // Manage has its own internal tab strip (ManageView.jsx) - no bar there,
    // same as the desktop module-tab strip hiding on it (views/Tasks.jsx
    // `!onManage`). A drilled-into-project task list ('tasks') highlights
    // Projects, matching the desktop strip.
    if (effSub === 'manage' || personOutside) {
      actions = null;
    } else {
      actions = TASK_ACTIONS;
      if (!effSub) effSub = 'home';
      else if (effSub === 'tasks') effSub = 'projects';
    }
  } else if (activeView === 'documents') {
    actions = DOCUMENT_ACTIONS;
    // The module opens on its Dashboard before any navigation sets a sub, and
    // the e-sign deep links ('documents-esign-requests') all live on the Nexus
    // Sign tab - same mapping Documents.jsx makes for its own strip.
    if (!effSub || effSub === 'documents-dashboard' || effSub === 'documents-hr-records') effSub = 'documents-browse';
    else if (String(effSub).startsWith('documents-esign')) effSub = 'documents-esign';
  }

  if (!dynActions && !actions) return null;

  return (
    <nav className="mobile-nav">
      <div className="mobile-nav-actions">
        {dynActions ? dynActions.map(a => {
          const Icon = DYN_ICONS[a.id] || Circle;
          return (
            <button key={a.id} className={`mobile-nav-item${a.active ? ' active' : ''}`}
              onClick={() => window.dispatchEvent(new CustomEvent('nexus:mobile-action', { detail: { id: a.id } }))}>
              <Icon size={20} />
              <span>{a.label}</span>
            </button>
          );
        }) : actions && actions.map(a => (
          <button key={a.sub} className={`mobile-nav-item${effSub === a.sub ? ' active' : ''}`}
            onClick={() => window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: activeView, sub: a.sub } }))}>
            <a.Icon size={20} />
            <span>{a.label}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}

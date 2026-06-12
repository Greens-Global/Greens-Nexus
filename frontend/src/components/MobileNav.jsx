import { useState, useEffect } from 'react';
import {
  Menu, Package, User, ClipboardList, ShoppingCart, Users, FileText, History,
  Building2, Plug, ListChecks, FileCheck, Shield, ClipboardCheck, Folder,
  MessageSquare, PackageSearch, Calendar, Circle,
} from 'lucide-react';
import { useRole } from '../contexts/RoleContext';

// Icons for broadcast (dynamic) actions, keyed by action id — keeps the bar
// visually identical whether actions are static or registered by a view.
const DYN_ICONS = {
  overview: Building2, utilities: Plug, timeline: ListChecks, permit: FileCheck,
  documents: FileText, warranties: Shield, inspections: ClipboardCheck,
  workload: Users, projects: Folder, actions: MessageSquare,
  'who-has-what': PackageSearch, calendar: Calendar,
};

// Phone bottom bar (Visesh's design): ONLY the current screen's actions on
// the left + Menu pinned right. No global shortcuts — all navigation between
// modules goes through Menu (full-screen nav). Screens without registered
// actions show just the Menu button.
const INVENTORY_MANAGER_ACTIONS = [
  { sub: 'myitems',      label: 'My Items',  Icon: User },
  { sub: 'catalog',      label: 'Catalog',   Icon: Package },
  { sub: 'manage',       label: 'Manage',    Icon: ClipboardList },
  { sub: 'checkouts',    label: 'Checkouts', Icon: ShoppingCart },
  { sub: 'whohasit',     label: 'Who Has',   Icon: Users },
  { sub: 'purchasereqs', label: 'Purchases', Icon: FileText },
  { sub: 'audit',        label: 'Audit',     Icon: History },
];
const INVENTORY_EMPLOYEE_ACTIONS = [
  { sub: 'catalog', label: 'Catalog',  Icon: Package },
  { sub: 'myitems', label: 'My Items', Icon: User },
];

export default function MobileNav({ activeView, activeSub, onMenu }) {
  const { can } = useRole();
  const isManager = can?.('manager');

  // Views can broadcast their own action set (label + id + active) via
  // 'nexus:mobile-actions'; taps come back as 'nexus:mobile-action'. This is
  // how screens with internal tabs (PropertyAsset sections) populate the bar
  // without MobileNav knowing their internals.
  const [dynActions, setDynActions] = useState(null);
  useEffect(() => {
    const h = e => setDynActions(e.detail?.actions || null);
    window.addEventListener('nexus:mobile-actions', h);
    return () => window.removeEventListener('nexus:mobile-actions', h);
  }, []);

  let actions = null;
  let effSub = activeSub;
  if (activeView === 'inventory') {
    actions = isManager ? INVENTORY_MANAGER_ACTIONS : INVENTORY_EMPLOYEE_ACTIONS;
    // The view opens on Catalog before any navigation sets a sub; deep-link
    // subs (permanent / active-checkouts) land on the Checkouts screen.
    if (!effSub) effSub = 'catalog';
    else if (['permanent', 'active-checkouts', 'checkouts-completed'].includes(effSub)) effSub = 'checkouts';
  }

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
      <button className="mobile-nav-item mobile-nav-menu" onClick={onMenu}>
        <Menu size={20} />
        <span>Menu</span>
      </button>
    </nav>
  );
}

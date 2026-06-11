import { Menu, Package, User, ClipboardList, ShoppingCart, Users, FileText, History } from 'lucide-react';
import { useRole } from '../contexts/RoleContext';

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

  let actions = null;
  if (activeView === 'inventory') {
    actions = isManager ? INVENTORY_MANAGER_ACTIONS : INVENTORY_EMPLOYEE_ACTIONS;
  }

  return (
    <nav className="mobile-nav">
      <div className="mobile-nav-actions">
        {actions && actions.map(a => (
          <button key={a.sub} className={`mobile-nav-item${activeSub === a.sub ? ' active' : ''}`}
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

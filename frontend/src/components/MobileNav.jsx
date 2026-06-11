import { LayoutDashboard, Package, CheckSquare, ShoppingBag, Menu, User, ClipboardList, ShoppingCart, Users, FileText, History } from 'lucide-react';
import { useRole } from '../contexts/RoleContext';

// Phone bottom bar v2 (Visesh's design): LEFT side = the current module's
// ACTIONS (its tabs — Catalog, Manage, Checkouts…), RIGHT side = Menu, which
// opens the full-screen nav. Global destinations live in the Menu; the bar
// stays contextual so the on-page tab strip can disappear on phones.
// Views without registered actions fall back to the global shortcuts.
export default function MobileNav({ activeView, activeSub, onNavigate, onMenu }) {
  const { can } = useRole();
  const isManager = can?.('manager');

  let actions = null;
  if (activeView === 'inventory') {
    actions = isManager ? [
      { sub: 'myitems',      label: 'My Items',  Icon: User },
      { sub: 'catalog',      label: 'Catalog',   Icon: Package },
      { sub: 'manage',       label: 'Manage',    Icon: ClipboardList },
      { sub: 'checkouts',    label: 'Checkouts', Icon: ShoppingCart },
      { sub: 'whohasit',     label: 'Who Has',   Icon: Users },
      { sub: 'purchasereqs', label: 'Purchases', Icon: FileText },
      { sub: 'audit',        label: 'Audit',     Icon: History },
    ] : [
      { sub: 'catalog', label: 'Catalog',  Icon: Package },
      { sub: 'myitems', label: 'My Items', Icon: User },
    ];
  }

  const globals = [
    { id: 'dashboard', label: 'Home',  Icon: LayoutDashboard },
    { id: 'inventory', label: 'Items', Icon: Package },
    { id: 'tasks',     label: 'Tasks', Icon: CheckSquare },
    { id: 'purchase',  label: 'Buy',   Icon: ShoppingBag },
  ];

  return (
    <nav className="mobile-nav">
      <div className="mobile-nav-actions">
        {actions
          ? actions.map(a => (
              <button key={a.sub} className={`mobile-nav-item${activeSub === a.sub ? ' active' : ''}`}
                onClick={() => window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: activeView, sub: a.sub } }))}>
                <a.Icon size={20} />
                <span>{a.label}</span>
              </button>
            ))
          : globals.map(({ id, label, Icon }) => (
              <button key={id} className={`mobile-nav-item${activeView === id ? ' active' : ''}`} onClick={() => onNavigate(id)}>
                <Icon size={20} />
                <span>{label}</span>
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

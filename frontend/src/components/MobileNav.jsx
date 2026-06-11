import { LayoutDashboard, Package, CheckSquare, ShoppingBag, Menu } from 'lucide-react';

// App-style bottom navigation for phones (shown ≤900px via CSS). The four
// most-used destinations get one-tap access; Menu opens the full sidebar
// drawer for everything else. This is the mobile shell — on phones the app
// navigates like a native app, not a shrunken desktop site.
export default function MobileNav({ activeView, onNavigate, onMenu }) {
  const items = [
    { id: 'dashboard', label: 'Home',  Icon: LayoutDashboard },
    { id: 'inventory', label: 'Items', Icon: Package },
    { id: 'tasks',     label: 'Tasks', Icon: CheckSquare },
    { id: 'purchase',  label: 'Buy',   Icon: ShoppingBag },
  ];
  return (
    <nav className="mobile-nav">
      {items.map(({ id, label, Icon }) => (
        <button key={id} className={`mobile-nav-item${activeView === id ? ' active' : ''}`} onClick={() => onNavigate(id)}>
          <Icon size={20} />
          <span>{label}</span>
        </button>
      ))}
      <button className="mobile-nav-item" onClick={onMenu}>
        <Menu size={20} />
        <span>Menu</span>
      </button>
    </nav>
  );
}

import { X, ChevronRight, LogOut, Moon, Sun } from 'lucide-react';
import { useMsal } from '@azure/msal-react';
import { useRole, MODULES, ROLES } from '../contexts/RoleContext';

// Full-screen phone menu (adidas-style): centered brand + close, big tappable
// rows for every module this user can access, then utility rows. Replaces the
// desktop sidebar on phones — same destinations, app-like presentation.
// Access gating mirrors TopHeader's search (admin + supervisor-restricted).
const MIN_SUPERVISOR = new Set([
  'manager-dashboard', 'tasks', 'sop', 'it', 'ops', 'operations', 'development',
  'property-asset', 'accounting', 'investor-relations', 'hr', 'marketing', 'external-links',
]);

export default function MobileMenu({ open, onClose, onNavigate, activeView, theme, onThemeToggle }) {
  const { instance, accounts } = useMsal();
  const { myRole, can, myGrantedModules } = useRole();
  const account  = accounts[0];
  const name     = account?.name ?? 'User';
  const initials = name.split(' ').map(n => n[0]).slice(0, 2).join('').toUpperCase();
  const roleMeta = ROLES[myRole] ?? ROLES.employee;

  if (!open) return null;

  const visible = MODULES.filter(m => {
    if (m.id === 'admin' && !can?.('administrator')) return false;
    if (MIN_SUPERVISOR.has(m.id) && !can?.('supervisor') && !myGrantedModules?.has(m.id)) return false;
    return true;
  });
  const go = id => { onNavigate(id); onClose(); };

  return (
    <div className="mobile-menu" role="dialog" aria-modal="true" aria-label="Menu">
      <div className="mobile-menu-head">
        <div className="mobile-menu-brand">NEXUS</div>
        <button className="mobile-menu-close" onClick={onClose} aria-label="Close menu"><X size={22} /></button>
      </div>
      <div className="mobile-menu-user">
        <div className="mobile-menu-avatar">{initials}</div>
        <div style={{ minWidth: 0 }}>
          <div className="mobile-menu-name">{name}</div>
          <div className="mobile-menu-role">{roleMeta.label} · Greens Global</div>
        </div>
      </div>
      <div className="mobile-menu-rows">
        {visible.map(m => (
          <button key={m.id} className={`mobile-menu-row${activeView === m.id ? ' active' : ''}`} onClick={() => go(m.id)}>
            <span>{m.label}</span>
            <ChevronRight size={17} />
          </button>
        ))}
      </div>
      <div className="mobile-menu-divider" />
      <div className="mobile-menu-rows secondary">
        <button className="mobile-menu-row" onClick={onThemeToggle}>
          <span>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
          {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
        </button>
        <button className="mobile-menu-row signout"
          onClick={() => instance.logoutRedirect({ account, postLogoutRedirectUri: window.location.origin + window.location.pathname })}>
          <span>Sign out</span>
          <LogOut size={16} />
        </button>
      </div>
    </div>
  );
}

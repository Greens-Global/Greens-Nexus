import { X, ChevronRight, LogOut, Moon, Sun } from 'lucide-react';
import { useMsal } from '@azure/msal-react';
import { useRole, ROLES } from '../contexts/RoleContext';
import { NAV } from './Sidebar';

// Full-screen phone menu. Mirrors the desktop sidebar EXACTLY — same NAV
// definition, same order, same dividers, same minRole/group gating — so the
// app never presents two different navigation structures (Visesh).
export default function MobileMenu({ open, onClose, onNavigate, activeView, theme, onThemeToggle }) {
  const { instance, accounts } = useMsal();
  const { myRole, can, myGrantedModules } = useRole();
  const account  = accounts[0];
  const name     = account?.name ?? 'User';
  const initials = name.split(' ').map(n => n[0]).slice(0, 2).join('').toUpperCase();
  const roleMeta = ROLES[myRole] ?? ROLES.employee;

  if (!open) return null;

  const visible = NAV.filter(item => item.divider || !item.minRole || can?.(item.minRole) || myGrantedModules?.has(item.view));
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
        {visible.map((item, i) => {
          if (item.divider) return <div key={`d${i}`} className="mobile-menu-divider" />;
          return (
            <button key={item.view} className={`mobile-menu-row${activeView === item.view ? ' active' : ''}`} onClick={() => go(item.view)}>
              <span>{item.label}</span>
              <ChevronRight size={17} />
            </button>
          );
        })}
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

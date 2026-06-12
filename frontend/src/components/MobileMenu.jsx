import { useState, useEffect } from 'react';
import { X, ChevronRight, ChevronLeft, LogOut, Moon, Sun } from 'lucide-react';
import { useMsal } from '@azure/msal-react';
import { useRole, ROLES } from '../contexts/RoleContext';
import { NAV } from './Sidebar';

// Sub-screens per module — the same sub ids the views' tab strips use, so a
// tap deep-links exactly where the in-page tab would. Modules absent here
// (Dashboard, Tasks, Asset Management, Investor Relations…) navigate directly.
const SUBMENUS = {
  inventory: {
    manager: [
      { sub: 'myitems',      label: 'My Items' },
      { sub: 'catalog',      label: 'Catalog' },
      { sub: 'manage',       label: 'Manage' },
      { sub: 'checkouts',    label: 'Checkouts' },
      { sub: 'whohasit',     label: 'Who Has What' },
      { sub: 'purchasereqs', label: 'Purchase Requests' },
      { sub: 'audit',        label: 'Audit Log' },
    ],
    employee: [
      { sub: 'catalog', label: 'Catalog' },
      { sub: 'myitems', label: 'My Items' },
    ],
  },
  it: [
    { sub: 'network',     label: 'Network Dashboard' },
    { sub: 'it-assets',   label: 'Asset Management' },
    { sub: 'it-websites', label: 'Website Management' },
  ],
  ops: [
    { sub: 'ops-dashboard', label: 'Project Dashboard' },
    { sub: 'ops-cubby',     label: 'Cubby Integration' },
  ],
  operations: [
    { sub: 'fms',        label: 'FMS Integration' },
    { sub: 'reputation', label: 'Reputation Management' },
    { sub: 'site-staff', label: 'Site Staff & Scheduling' },
  ],
  development: [
    { sub: 'dev-permits', label: 'Permit Status' },
    { sub: 'dev-plans',   label: 'Project Plans' },
    { sub: 'dev-details', label: 'Property Details' },
  ],
  accounting: [
    { sub: 'transactions',   label: 'Transactions' },
    { sub: 'invoices',       label: 'Invoices' },
    { sub: 'budgets',        label: 'Budgets' },
    { sub: 'imports',        label: 'Import Hub' },
    { sub: 'ramp',           label: 'Ramp Cards' },
    { sub: 'vendors',        label: 'Vendors' },
    { sub: 'ask-accountant', label: 'Ask My Accountant' },
    { sub: 'ama',            label: 'AMA Entities' },
    { sub: 'mre',            label: 'MRE' },
    { sub: 'mri',            label: 'MRI' },
    { sub: 'reports',        label: 'Reports' },
  ],
  hr: [
    { sub: 'hr-ms',          label: 'Onboarding — MS' },
    { sub: 'hr-asana',       label: 'Onboarding — Asana' },
    { sub: 'hr-disclosures', label: 'Disclosures' },
    { sub: 'hr-documents',   label: 'Documents' },
  ],
  marketing: [
    { sub: 'marketing-ads',        label: 'Google Ads Performance' },
    { sub: 'marketing-reputation', label: 'Reputation Management' },
  ],
  sop: [
    { sub: 'index',  label: 'SOP Index' },
    { sub: 'review', label: 'Review Queue' },
    { sub: 'lms',    label: 'LMS Courses' },
  ],
};

// Full-screen phone menu. Mirrors the desktop sidebar EXACTLY — same NAV
// definition, same order, same dividers, same minRole/group gating — so the
// app never presents two different navigation structures (Visesh).
// Modules with sub-screens open a second panel that slides in from the RIGHT
// over the left-slid menu (adidas criss-cross); back slides it out again.
export default function MobileMenu({ open, onClose, onNavigate, activeView, theme, onThemeToggle }) {
  const { instance, accounts } = useMsal();
  const { myRole, can, myGrantedModules } = useRole();
  const account  = accounts[0];
  const name     = account?.name ?? 'User';
  const initials = name.split(' ').map(n => n[0]).slice(0, 2).join('').toUpperCase();
  const roleMeta = ROLES[myRole] ?? ROLES.employee;

  const [subPanel,   setSubPanel]   = useState(null); // { view, label }
  const [subClosing, setSubClosing] = useState(false);
  const [closing,    setClosing]    = useState(false);
  useEffect(() => { if (!open) { setSubPanel(null); setSubClosing(false); setClosing(false); } }, [open]);

  if (!open) return null;

  // X slides the whole menu back out to the left before unmounting
  // (a transformed ancestor carries the fixed submenu along with it)
  const requestClose = () => {
    setClosing(true);
    setTimeout(onClose, 340);
  };

  const subsFor = view => {
    const entry = SUBMENUS[view];
    if (!entry) return null;
    if (Array.isArray(entry)) return entry;
    return can?.('manager') ? entry.manager : entry.employee; // inventory
  };

  const visible = NAV.filter(item => item.divider || !item.minRole || can?.(item.minRole) || myGrantedModules?.has(item.view));
  const go = (id, sub = null) => { onNavigate(id, sub); onClose(); };
  const openRow = item => {
    const subs = subsFor(item.view);
    if (subs) setSubPanel({ view: item.view, label: item.label, subs });
    else go(item.view);
  };
  const closeSub = () => {
    setSubClosing(true);
    setTimeout(() => { setSubPanel(null); setSubClosing(false); }, 260);
  };

  return (
    <div className={`mobile-menu${closing ? ' closing' : ''}`} role="dialog" aria-modal="true" aria-label="Menu">
      <div className="mobile-menu-head">
        <div className="mobile-menu-brand">NEXUS</div>
        <button className="mobile-menu-close" onClick={requestClose} aria-label="Close menu"><X size={22} /></button>
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
            <button key={item.view} className={`mobile-menu-row${activeView === item.view ? ' active' : ''}`} onClick={() => openRow(item)}>
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

      {/* Right-slide submenu (criss-cross over the left-slid menu) */}
      {subPanel && (
        <div className={`mobile-submenu${subClosing ? ' closing' : ''}`} role="dialog" aria-modal="true" aria-label={subPanel.label}>
          <div className="mobile-submenu-head">
            <button className="mobile-submenu-back" onClick={closeSub} aria-label="Back"><ChevronLeft size={22} /></button>
            <div className="mobile-submenu-title">{subPanel.label}</div>
            <button className="mobile-menu-close" onClick={requestClose} aria-label="Close menu"><X size={22} /></button>
          </div>
          <div className="mobile-menu-rows">
            {subPanel.subs.map(s => (
              <button key={s.sub} className="mobile-menu-row" onClick={() => go(subPanel.view, s.sub)}>
                <span>{s.label}</span>
                <ChevronRight size={17} />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

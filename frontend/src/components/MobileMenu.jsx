import { useState, useEffect, useRef } from 'react';
import { X, ChevronRight, ChevronLeft, LogOut, Moon, Sun, CircleHelp, Scale } from 'lucide-react';
import { useMsal } from '@azure/msal-react';
import { BFF_MODE, bffLogout } from '../bffAuth';
import { useRole, ROLES, EXTERNAL_ROLE_META } from '../contexts/RoleContext';
import { usePersonPhoto } from '../lib/peoplePhotos';
import { NAV } from './Sidebar';
import { orderNav } from './navOrder';
import { useActionCounts, moduleCount, countText, countDetail } from '../lib/useActionCounts';
import NavCount from './NavCount';
import NavMore from './NavMore';
import { useOffscreenCounts } from '../lib/useOffscreenCounts';
import { WORKFORCE_GRANTS } from '../lib/workforceAccess';

// Sub-screens per module - the same sub ids the views' tab strips use, so a
// tap deep-links exactly where the in-page tab would. Modules absent here
// (Dashboard, Tasks, Asset Management, Investor Relations…) navigate directly.
// Accounting left this list on Oct 1 (Neil): its one-row folder made every
// visit two taps and only ever reached Reports; a tap now lands on the first
// tab the person may see (Overview, or Reports for entity-limited readers),
// exactly like the desktop sidebar, with the tab strip pinned under the header.
/**
 * The sub-screens of `view` this person may open - the phone menu and the
 * header search both read this, so a gated tab (one with `grants`) is never
 * listed for someone without one of them. `role` is useRole().
 */
export function visibleSubs(view, role) {
  const entry = SUBMENUS[view];
  if (!entry) return null;
  const list = Array.isArray(entry) ? entry : (role?.can?.('manager') ? entry.manager : entry.employee);
  const mayOpen = (s) => !!s.grants && s.grants.some((g) => !!role?.canAccessModule?.(g, 'administrator', 'viewer'));
  // An external (B2B guest) gets only the granted tabs - in Team, Workforce
  // Analytics alone (views/Shifts.jsx draws the same).
  return list.filter((s) => (role?.isExternal ? mayOpen(s) : !s.grants || mayOpen(s)));
}

export const SUBMENUS = {
  // Team (Neil, Oct 13 2026): Contact and the group's Shifts for everyone;
  // managers add the Schedule and the Requests inbox (Charmi, 09/30). Your
  // own week is Workday > My Shifts.
  // Workforce Analytics (Oct 29 2026) carries `grants`: shown only to the
  // people lib/workforceAccess.js names, whichever list it is in.
  shifts: {
    manager: [
      { sub: 'shifts', label: 'Shifts' },
      { sub: 'schedule', label: 'Schedule' },
      { sub: 'requests', label: 'Requests' },
      { sub: 'analytics', label: 'Workforce Analytics', grants: WORKFORCE_GRANTS },
      { sub: 'contact', label: 'Company Directory' },
    ],
    employee: [
      { sub: 'shifts', label: 'Shifts' },
      { sub: 'analytics', label: 'Workforce Analytics', grants: WORKFORCE_GRANTS },
      { sub: 'contact', label: 'Company Directory' },
    ],
  },
  inventory: {
    manager: [
      { sub: 'myitems',      label: 'My Items' },
      { sub: 'catalog',      label: 'Catalog' },
      { sub: 'manage',       label: 'Manage' },
      { sub: 'checkouts',    label: 'Checkouts' },
      { sub: 'whohasit',     label: 'Who Has What' },
      { sub: 'audit',        label: 'Audit Log' },
    ],
    employee: [
      { sub: 'catalog', label: 'Catalog' },
      { sub: 'myitems', label: 'My Items' },
    ],
  },
  it: [
    { sub: 'network',     label: 'Network Dashboard' },
    { sub: 'it-websites', label: 'Website Management' },
  ],
  ops: [
    { sub: 'construction-dashboard', label: 'Project Dashboard' },
    { sub: 'construction-activity',  label: 'Site Activity' },
  ],
  operations: [
    { sub: 'overview',    label: 'Overview' },
    { sub: 'collections', label: 'Collections' },
    { sub: 'units',       label: 'Units & Pricing' },
    { sub: 'worklist',    label: 'Facility Tasks' },
    { sub: 'market',      label: 'Market Rates' },
    { sub: 'reports',     label: 'Reports' },
    { sub: 'revenue',     label: 'ECRI Management' },
    { sub: 'portfolio',   label: 'Portfolio' },
    { sub: 'site-map',    label: 'Site Map' },
    { sub: 'pricing',     label: 'Pricing Insights' },
  ],
  hr: [
    { sub: 'hr-people', label: 'People' },
    { sub: 'hr-hiring', label: 'Hiring' },
    { sub: 'hr-org',    label: 'Org Chart' },
    // People > Leave became Time > Time Off (leave depth, Oct 27 2026).
    { sub: 'hr-time-off', label: 'Time Off' },
    { sub: 'hr-checklists', label: 'Checklists' },
    { sub: 'hr-analytics', label: 'Analytics' },
    { sub: 'hr-exits', label: 'Exits' },
    { sub: 'hr-performance', label: 'Performance' },
  ],
  marketing: [
    { sub: 'marketing-ads',        label: 'Google Ads Performance' },
    { sub: 'marketing-reputation', label: 'Reputation Management' },
  ],
  sop: [
    { sub: 'index',    label: 'Library' },
    { sub: 'training', label: 'Training' },
    { sub: 'health',   label: 'Manage' },
  ],
  // Workflows (Oct 28 2026): the module's six tabs.
  workflows: [
    { sub: 'overview',    label: 'Overview' },
    { sub: 'list',        label: 'Workflows' },
    { sub: 'automations', label: 'Automations' },
    { sub: 'runs',        label: 'Runs' },
    { sub: 'templates',   label: 'Templates' },
    { sub: 'catalog',     label: 'Catalog' },
  ],
};

// Full-screen phone menu. Mirrors the desktop sidebar EXACTLY - same NAV
// definition, same order, same dividers, same minRole/group gating - so the
// app never presents two different navigation structures (Visesh).
// Modules with sub-screens open a second panel that slides in from the RIGHT
// over the left-slid menu (adidas criss-cross); back slides it out again.
export default function MobileMenu({ open, onClose, onNavigate, activeView, theme, onThemeToggle }) {
  const { instance, accounts } = useMsal();
  const role = useRole();
  const { myRole, can, myGrantedModules, isExternal } = role;
  const counts = useActionCounts();
  const account  = accounts[0];
  const name     = account?.name ?? 'User';
  const initials = name.split(' ').map(n => n[0]).slice(0, 2).join('').toUpperCase();
  // The person's own photo from the Nexus People directory (Sep 22) - the
  // same picture the header pill shows, so the menu's card matches it. ''
  // while it loads and for anyone HR hasn't given a photo; initials remain
  // the fallback.
  const photo    = usePersonPhoto(account?.username ?? '');
  // External guests read "External", never a tier name (Visesh, Aug 18).
  const roleMeta = isExternal ? EXTERNAL_ROLE_META : (ROLES[myRole] ?? ROLES.employee);

  const [subPanel,   setSubPanel]   = useState(null); // { view, label }
  const [subClosing, setSubClosing] = useState(false);
  const [closing,    setClosing]    = useState(false);
  useEffect(() => { if (!open) { setSubPanel(null); setSubClosing(false); setClosing(false); } }, [open]);

  // A busy module below the fold gets a "3 waiting below" pill (NavMore).
  // Above the early return: hooks run on every render.
  const menuRef = useRef(null);
  const [offscreen, reveal] = useOffscreenCounts(menuRef, [counts, open]);
  if (!open) return null;

  // X slides the whole menu back out to the left before unmounting
  // (a transformed ancestor carries the fixed submenu along with it)
  const requestClose = () => {
    setClosing(true);
    setTimeout(onClose, 340);
  };

  const subsFor = view => visibleSubs(view, role);

  // Mirror the sidebar's icon rendering (lucide component or custom SVG path)
  // so menu rows carry the SAME left icon - Neil: icons on the left help people
  // who fat-finger, and give the eye an anchor per row.
  const renderIcon = (item, size = 19) => item.icon
    ? <item.icon style={{ width: size, height: size, flexShrink: 0 }} />
    : item.svgPath
      ? <svg className="material-symbol-svg" viewBox="0 -960 960 960" style={{ width: size, height: size, flexShrink: 0 }}><path d={item.svgPath} /></svg>
      : null;

  // Mirror the sidebar: grant-driven visibility below admin (Jun 17);
  // external (B2B guest) accounts see ONLY their granted modules (Aug 17);
  // an item's `grants` list means any one of them opens it (Oct 10).
  const granted = item => (item.grants || [item.grant || item.view]).some(g => myGrantedModules?.has(g));
  const visible = orderNav(NAV).filter(item => !item.menuOnly).filter(item => isExternal
    ? (!item.divider && granted(item))
    : (item.divider || !item.minRole || can?.('administrator') || granted(item)));
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
    <div ref={menuRef} className={`mobile-menu${closing ? ' closing' : ''}`} role="dialog" aria-modal="true" aria-label="Menu">
      <div className="mobile-menu-head">
        <div className="mobile-menu-brand">NEXUS</div>
        <button className="mobile-menu-close" onClick={requestClose} aria-label="Close menu"><X size={22} /></button>
      </div>
      <div className="mobile-menu-user">
        <div className="mobile-menu-avatar">
          {photo
            ? <img src={photo} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
            : initials}
        </div>
        <div style={{ minWidth: 0 }}>
          <div className="mobile-menu-name">{name}</div>
          <div className="mobile-menu-role">{roleMeta.label}</div>
        </div>
      </div>
      <div className="mobile-menu-rows">
        {visible.map((item, i) => {
          if (item.divider) return <div key={`d${i}`} className="mobile-menu-divider" />;
          return (
            <button key={item.view} className={`mobile-menu-row${activeView === item.view ? ' active' : ''}${moduleCount(counts, item.view) ? ' has-count' : ''}`} onClick={() => openRow(item)}
              data-count={moduleCount(counts, item.view) || undefined}
              aria-label={moduleCount(counts, item.view) ? `${item.label}, ${countText(moduleCount(counts, item.view))} waiting on you${countDetail(counts, item.view) ? `: ${countDetail(counts, item.view)}` : ''}` : undefined}>
              <span className="mobile-menu-row-label">
                <span className="nav-ico">{renderIcon(item)}</span>
                <span>{item.label}</span>
              </span>
              <NavCount n={moduleCount(counts, item.view)} />
              <ChevronRight size={17} />
            </button>
          );
        })}
      </div>
      <div className="mobile-menu-divider" />
      <div className="mobile-menu-rows secondary">
        {/* Dark mode moved to the profile dropdown (avatar, top-right) - Neil */}
        {/* Help: the header's "?" button has no room on a phone, so the same
            Help menu (support/HelpMenu.jsx) opens from here. */}
        <button className="mobile-menu-row"
          onClick={() => { onClose(); setTimeout(() => window.dispatchEvent(new CustomEvent('nexus:help-open')), 0); }}>
          <span className="mobile-menu-row-label"><CircleHelp style={{ width: 19, height: 19, flexShrink: 0 }} /><span>Help</span></span>
          <ChevronRight size={17} />
        </button>
        <button className="mobile-menu-row" onClick={() => go('legal', 'privacy')}>
          <span className="mobile-menu-row-label"><Scale style={{ width: 19, height: 19, flexShrink: 0 }} /><span>Legal</span></span>
          <ChevronRight size={17} />
        </button>
        <button className="mobile-menu-row signout"
          onClick={() => BFF_MODE ? bffLogout() : instance.logoutRedirect({ account, postLogoutRedirectUri: window.location.origin + window.location.pathname })}>
          <span>Sign Out</span>
          <LogOut size={16} />
        </button>
      </div>
      <NavMore dir="below" n={offscreen.below} onReveal={reveal} />

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

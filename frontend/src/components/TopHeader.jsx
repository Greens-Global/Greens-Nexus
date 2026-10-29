import { useState, useRef, useEffect, useCallback } from "react";
import { Menu, Search, LogOut, User, ArrowLeft, Shield, ChevronDown, Sparkles, X, UserCog, Scale } from "lucide-react";
import NotificationBell from "./NotificationBell";
import HelpMenu from "../support/HelpMenu";
import QuickNoteButton from "../notes/QuickNoteButton";
import { HeaderOverflowTabs, TabGroupButton, useHeaderTabs } from "./ModuleTabs";
import TabInk from "./TabInk";
import MyProfileModal from "./MyProfileModal";

// ?emailSettings=1 - the "Email Settings" link in task emails; it opens
// Profile on its Email Settings section (Neil, Oct 13 2026). Read when this
// module LOADS, not when the header mounts: the app's boot (auth, then routing
// "/dashboard" to its canonical URL) rewrites the address before the header
// ever renders, and the query went with it - the link opened nothing. Taken
// once and dropped from the URL so a refresh doesn't reopen Email Settings.
let EMAIL_SETTINGS_LINK = typeof window !== 'undefined'
  && new URLSearchParams(window.location.search).get('emailSettings') === '1';
function takeEmailSettingsLink() {
  if (!EMAIL_SETTINGS_LINK) return false;
  EMAIL_SETTINGS_LINK = false;
  const q = new URLSearchParams(window.location.search);
  if (q.has('emailSettings')) {
    q.delete('emailSettings');
    const rest = q.toString();
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${rest ? `?${rest}` : ''}${window.location.hash}`);
  }
  return true;
}
import { useMsal }        from "@azure/msal-react";
import { BFF_MODE, bffLogout } from "../bffAuth";
import { useRole, ROLES, EXTERNAL_ROLE_META } from "../contexts/RoleContext";
import { usePersonPhoto } from "../lib/peoplePhotos";
import { api } from "../api";
import { useNexusSearch, SEARCH_PLACEHOLDER, SEARCH_HINT, SEARCH_LABEL } from './search/useNexusSearch';
import SearchResults from './search/SearchResults';

import { isSearchShortcut, isPhone } from '../lib/keys';
import { useBuildModeMenu, BuildModeChip } from '../devnotes/BuildModeChip';   // Build Mode (Oct 24 2026)
import { ToolsSection, ActAsFinder } from './ToolsMenu';   // profile menu Tools (Oct 25 2026)
import { useActionCounts } from '../lib/useActionCounts';

const MOD_KEY = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘' : 'Ctrl';

export default function TopHeader({ title, activeView, theme, onThemeToggle, sidebarPinned, onSidebarPinnedChange, onMobileToggle, canGoBack, onBack, onNavigate, prevLabel }) {
  const { instance, accounts } = useMsal();
  const { myRole, actingAs, stopActAs, isExternal } = useRole();
  // Module tab strip published by the active module (<ModuleTabs>). When
  // present it takes the header center (Work OS shell). The search bar is
  // NOT part of that bargain any more: it sits in the right cluster on
  // every module, the same size in the same place (Neil, Oct 14 2026).
  const headerTabs = useHeaderTabs();
  const actionCounts = useActionCounts();
  const waiting = Object.values(actionCounts || {}).some((tabs) => Object.values(tabs || {}).some((n) => n > 0));
  // Modules that opt into syncTitle (<ModuleTabs syncTitle>) get the active
  // tab's own name in the breadcrumb instead of the module's fixed name - so
  // switching tabs (e.g. Time Clock's Clock/Time Sheet/Time Off) actually
  // renames the page instead of every tab reading as the landing tab.
  const activeTabMeta = headerTabs?.tabs?.find(t => t.key === headerTabs.active);
  const displayTitle = (headerTabs?.syncTitle && activeTabMeta)
    ? (activeTabMeta.title || activeTabMeta.label)
    : title;
  // Profile (Neil, Oct 13 2026; was My Profile): everything that relates only
  // to you - photo, signature, appearance, world clock and Email Settings,
  // which used to be a menu item of its own. 'email' opens it on that section:
  // the "Email Settings" link in every task email lands on ?emailSettings=1 -
  // see EMAIL_SETTINGS_LINK above for why that is read at module load.
  const [myProfileOpen, setMyProfileOpen] = useState(() => (takeEmailSettingsLink() ? 'email' : false));
  // Asana severed (Aug 27). This used to catch the OAuth callback's
  // ?asana=connected|denied|error and reopen Account Settings on it. Nobody can
  // start that flow any more, but a stale bookmark or an in-flight redirect
  // still can - so the params are stripped silently rather than reopening a
  // modal about an integration that is gone.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (!p.get("asana")) return;
    p.delete("asana"); p.delete("reason");
    const qs = p.toString();
    window.history.replaceState({}, "", window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash);
  }, []);
  const [actAsStopping,  setActAsStopping]  = useState(false);
  async function handleExitActAs() {
    setActAsStopping(true);
    try { await stopActAs(); } finally { setActAsStopping(false); }
  }
  const account  = accounts[0];
  const name     = account?.name ?? "User";
  const email    = account?.username ?? "";
  const initials = name.split(" ").map(n => n[0]).slice(0, 2).join("").toUpperCase();
  // The person's own photo from the Nexus People directory - the same picture
  // their avatar shows everywhere else in the app. '' while it loads, and for
  // anyone HR hasn't given a photo, so the initials stay the fallback.
  const photo    = usePersonPhoto(email);
  // External guests read "External", never a tier name (Visesh, Aug 18).
  const roleMeta = isExternal ? EXTERNAL_ROLE_META : (ROLES[myRole] ?? ROLES.employee);
  // What Teams shows under your name is your job title, not an access level -
  // "Global Admin" there is meaningless to a colleague who just wants to know
  // what you do. Nexus's own permission tier stays visible as the badge in the
  // dropdown card below; this only replaces the compact pill's subtitle, and
  // falls back to the access-level label for anyone with no HR record yet
  // (e.g. local dev's NEXUS_DEV_EMAIL) rather than showing blank.
  const [myTitle, setMyTitle] = useState('');
  useEffect(() => {
    api.myHrProfile().then(p => setMyTitle(p.jobTitle || '')).catch(() => {});
  }, []);

  const [open,         setOpen]         = useState(false);
  // '' = the menu, 'actas' = the Act As finder in its place (Oct 25 2026).
  const [menuView,     setMenuView]     = useState('');
  const openActAs = useCallback(() => setMenuView('actas'), []);
  const pillRef = useRef(null);
  // Back from the finder: focus lands on the Act As row it came from.
  const backToMenu = useCallback(() => {
    setMenuView('');
    requestAnimationFrame(() => dropRef.current?.querySelector('[data-tools-actas]')?.focus());
  }, []);
  // Build Mode (Oct 24 2026): the menu row shows only when the server says the
  // person has it; the chip beside the profile pill shows while it is on.
  const buildMode = useBuildModeMenu();
  // What's New is a page in the app now (Neil, Oct 12 2026), not an overlay:
  // every way in navigates to it, and every signed-in user may read it.
  function openChangelog() {
    onNavigate?.('whats-new');
  }
  // Landing on What's New by any route (menu, Help panel, the announcement
  // bar, a link, the URL) records the visit. The weekly New in Nexus bar goes
  // by it ("already seen") and it marks the bell's copy of the news read. The
  // header's red-dot eye icon that used to sit beside the profile pill is gone
  // (Neil, Oct 14 2026) - the bar and the bell already say it.
  useEffect(() => {
    if (activeView === 'whats-new') api.markTaskChangelogSeen().catch(() => {});
  }, [activeView]);
  const [searchQuery,  setSearchQuery]  = useState('');
  const [searchOpen,   setSearchOpen]   = useState(false);
  const [searchIdx,    setSearchIdx]    = useState(0);
  const dropRef   = useRef(null);
  const searchRef = useRef(null);
  const searchInputRef = useRef(null);
  const searchListRef  = useRef(null);

  // Visual theme for the Work OS surfaces (profile menu → Theme): 'cobalt'
  // (default Stella blue) or 'warm' (Lisso sand). Applied as a data attribute
  // on <html> that remaps the --wk-* tokens; persisted like zoom below.
  // Orthogonal to the light/dark toggle.
  const [wkTheme, setWkTheme] = useState(() => localStorage.getItem('wk-theme') || 'cobalt');
  useEffect(() => {
    if (wkTheme === 'warm') document.documentElement.dataset.wktheme = 'warm';
    else delete document.documentElement.dataset.wktheme;
    localStorage.setItem('wk-theme', wkTheme);
  }, [wkTheme]);

  // Page zoom and fullscreen controls were REMOVED from the header (Visesh,
  // Jul 30). The zoom applied a CSS `zoom` to <html>, and its default was 110%
  // (a ZOOM_BASE of 1.1 baked into what the control called "100%"), which cost
  // two real things:
  //   - every window laid out ~10% narrower than its pixel size, so a 1366px
  //     laptop behaved like ~1242px and every breakpoint fired early.
  //   - it leaked into the PDF Editor's iframe, where WebKit disagrees with
  //     itself: window.innerWidth reported the zoomed layout viewport (1140)
  //     while `margin: auto` resolved against the unzoomed box (1254), putting
  //     the landing grid 57px right of centre in Safari and dead-centre in
  //     Chromium.
  // Browser-native zoom (cmd/ctrl +/-) covers the readability need without
  // either problem, and does not distort layout measurements.
  // Any `zoom` left on <html> by the old control is cleared once on mount so a
  // persisted 120% does not survive this change.
  //
  // (This session had independently patched ZOOM_BASE/DEFAULT_ZOOM to fix the
  // same 110%-isn't-really-100% problem, plus a matching set of popover-
  // positioning fixes elsewhere that account for a non-1 <html> zoom - see
  // rootZoom() in lib/utils.js. Superseded by this outright removal: since
  // <html> zoom is now always 1, rootZoom() always returns 1 and those fixes
  // reduce to their original behavior - inert, not wrong, left in place rather
  // than ripped out mid-merge.)
  useEffect(() => {
    document.documentElement.style.removeProperty('zoom');
    try { localStorage.removeItem('gg-zoom'); } catch { /* private mode */ }
  }, []);

  // ONE search engine for the app - the phone sheet (GlobalSearch) uses the
  // same hook, so a search finds the same things wherever it is typed.
  const search = useNexusSearch(searchQuery, { enabled: searchOpen });
  useEffect(() => {
    searchListRef.current?.querySelector('[data-active="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [searchIdx]);
  function closeSearch(blur = false) {
    setSearchQuery(''); setSearchOpen(false);
    if (blur) searchInputRef.current?.blur();
  }
  function pickSearch(row) {
    closeSearch(true);
    row.run?.();
  }

  // Keyboard, desktop only: Ctrl/Cmd+K lands in this bar. "/" lands in the
  // page's own search box when the page tags one (data-slash-search:
  // Contact Directory, Knowledge Base), else here. Listens on document so it
  // runs before the sheet's window listener, which then sees defaultPrevented
  // and stands down; on a phone this does nothing and the sheet (GlobalSearch)
  // answers the same keys.
  useEffect(() => {
    const onKey = (e) => {
      if (!isSearchShortcut(e) || isPhone()) return;
      e.preventDefault();
      const own = e.key === '/' ? document.querySelector('input[data-slash-search]') : null;
      if (own) { own.focus(); return; }
      searchInputRef.current?.focus();
      setSearchOpen(true);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    function handleClick(e) {
      if (dropRef.current && !dropRef.current.contains(e.target)) setOpen(false);
      if (searchRef.current && !searchRef.current.contains(e.target)) setSearchOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  // Esc: the Act As finder goes back to the menu, the menu closes.
  useEffect(() => {
    if (!open) return undefined;
    function onKey(e) {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      if (menuView) backToMenu();
      else { setOpen(false); pillRef.current?.focus(); }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, menuView, backToMenu]);

  // The highlighted row, clamped: a shrinking result set never strands it.
  const activeIdx = search.rows.length ? Math.min(searchIdx, search.rows.length - 1) : 0;
  function handleSearchKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); closeSearch(true); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setSearchIdx(Math.min(Math.max(0, search.rows.length - 1), activeIdx + 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSearchIdx(Math.max(0, activeIdx - 1)); return; }
    if (e.key === 'Enter' && search.rows[activeIdx]) { e.preventDefault(); pickSearch(search.rows[activeIdx]); }
  }

  function handleSignOut() {
    // BFF mode: there is no MSAL session to end - kill the server session and
    // clear the cookie via /api/auth/logout instead.
    if (BFF_MODE) { bffLogout(); return; }
    instance.logoutRedirect({
      account,
      postLogoutRedirectUri: window.location.origin + window.location.pathname,
    });
  }

  // The search bar: one element, one size, one place - the right cluster,
  // before Help - on every module. Hidden on phones, where the icon on the
  // left opens the same search as a sheet.
  const searchBar = (
    <div className="hdr-search" ref={searchRef}>
      <div className="search-bar" role="search">
        <Search style={{ width: 14, height: 14, flexShrink: 0 }} />
        <input
          ref={searchInputRef}
          placeholder={SEARCH_PLACEHOLDER}
          aria-label={SEARCH_LABEL}
          title={`${SEARCH_LABEL} (${MOD_KEY} K)`}
          aria-keyshortcuts="Control+K Meta+K /"
          value={searchQuery}
          onChange={e => { setSearchQuery(e.target.value); setSearchIdx(0); setSearchOpen(true); }}
          onFocus={() => setSearchOpen(true)}
          onKeyDown={handleSearchKey}
        />
        {searchQuery
          ? <button className="search-clear" onClick={() => closeSearch(true)} title="Clear" aria-label="Clear search"><X size={13} /></button>
          : <kbd className="hdr-search-kbd" aria-hidden="true">{MOD_KEY} K</kbd>}
      </div>
      {searchOpen && (
        <div className="hdr-search-panel">
          {searchQuery.trim()
            ? <SearchResults query={searchQuery} groups={search.groups} rows={search.rows} searching={search.searching}
                activeIdx={activeIdx} onActive={setSearchIdx} onPick={pickSearch} listRef={searchListRef} />
            : <div className="gs-hint">{SEARCH_HINT}</div>}
        </div>
      )}
    </div>
  );

  return (
    <>
    <header className="top-header">
      <div className="header-left">
        {/* The phone has no rail: the menu button carries a dot when a module
            has something waiting on me (Oct 25 2026), so it is worth opening.
            A dot, not a number - some items count in two modules. */}
        <button className="mobile-toggle" onClick={onMobileToggle} aria-label={waiting ? 'Menu, items waiting on you' : 'Menu'} title="Menu">
          <Menu style={{ width: 18, height: 18 }} />
          {waiting && <span className="mobile-toggle-dot" aria-hidden="true" />}
        </button>
        {/* Phone-only back button - the breadcrumb (with its back arrow) is
            hidden on mobile, leaving no way to step back to the parent screen
            (Jun 16). Mirrors the desktop breadcrumb-back: same onBack/canGoBack. */}
        {canGoBack && (
          <button className="icon-btn header-back-mobile" onClick={onBack}
            aria-label={prevLabel ? `Back to ${prevLabel}` : 'Back'} title={prevLabel ? `Back to ${prevLabel}` : 'Back'}>
            <ArrowLeft style={{ width: 18, height: 18 }} />
          </button>
        )}
        {/* Phone search lives LEFT of the centered wordmark - a 4th icon on
            the right collided with NEXUS (Visesh screenshot, Jun 12) */}
        <button className="icon-btn header-search-left" aria-label={SEARCH_LABEL} title={SEARCH_LABEL}
          onClick={() => window.dispatchEvent(new CustomEvent('nexus:search-open'))}>
          <Search style={{ width: 16, height: 16 }} />
        </button>
        {/* Phone-only centered wordmark (desktop hides it) - tap = home */}
        <button className="header-brand" onClick={() => onNavigate('dashboard')} aria-label="Go to Dashboard">NEXUS</button>
        <div className="breadcrumb">
          {canGoBack && (
            <button className="breadcrumb-back" onClick={onBack} title={`Back to ${prevLabel}`}>
              <ArrowLeft style={{ width: 15, height: 15 }} />
            </button>
          )}
          {/* Back within one module (Settings > another subject) named the
              same page twice - "Settings / Settings" (Oct 25); the arrow stays. */}
          {canGoBack && prevLabel && prevLabel !== displayTitle && (
            <>
              <button className="breadcrumb-prev" onClick={onBack} title={`Back to ${prevLabel}`}>{prevLabel}</button>
              <span style={{ color: "var(--muted)", opacity: 0.4, fontSize: 11, userSelect: "none" }}>/</span>
            </>
          )}
          <span className="breadcrumb-current">{displayTitle}</span>
        </div>
      </div>

      <div className={`header-center${headerTabs ? ' has-tabs' : ''}`}>
        {/* A module that opts into overflow (People, Oct 27 2026) folds the
            tabs that do not fit into More instead of scrolling them away. */}
        {headerTabs?.overflow && (
          <HeaderOverflowTabs entry={headerTabs}
            ink={<TabInk key={headerTabs.tabs.map((t) => t.key).join('|')} active={headerTabs.active} />}
            onPick={(k) => { setSearchQuery(''); setSearchOpen(false); headerTabs.onChange(k); }}
            renderTab={({ key, label, Icon, badge }, probe) => (
              <button key={key} type="button" tabIndex={probe ? -1 : undefined}
                className={`hdr-tab${!probe && headerTabs.active === key ? ' active' : ''}`}
                aria-current={!probe && headerTabs.active === key ? 'page' : undefined}
                onClick={probe ? undefined : () => { setSearchQuery(''); setSearchOpen(false); headerTabs.onChange(key); }}>
                {Icon && <Icon size={16} strokeWidth={2} />}
                <span>{label}</span>
                {badge > 0 && <span className="hdr-tab-badge">{badge}</span>}
              </button>
            )} />
        )}
        {headerTabs && !headerTabs.overflow && (
          <nav className={`hdr-tabs${headerTabs.compactGroups ? ' hdr-tabs--compact' : ''}`} aria-label="Module sections" data-tour="module-tabs">
            <TabInk key={headerTabs.tabs.map((t) => t.key).join('|')} active={headerTabs.active} />
            {headerTabs.tabs.map(({ key, label, Icon, badge, items, landing }) => (items ? (
              <TabGroupButton key={key} tab={{ key, label, Icon, items, landing }} active={headerTabs.active} className="hdr-tab" compact={!!headerTabs.compactGroups}
                onSelect={(k) => { setSearchQuery(''); setSearchOpen(false); headerTabs.onChange(k); }} />
            ) : (
              <button key={key}
                className={`hdr-tab${headerTabs.active === key ? ' active' : ''}`}
                aria-current={headerTabs.active === key ? 'page' : undefined}
                onClick={() => { setSearchQuery(''); setSearchOpen(false); headerTabs.onChange(key); }}>
                {Icon && <Icon size={16} strokeWidth={2} />}
                <span>{label}</span>
                {badge > 0 && <span className="hdr-tab-badge">{badge}</span>}
              </button>
            )))}
          </nav>
        )}
      </div>

      <div className="header-right">
        {searchBar}
        {/* "?" Help menu: search the guide, help with this page, then Contact
            Support - self-service first (Neil, Sep 26). support/HelpMenu.jsx. */}
        <HelpMenu activeView={activeView} onWhatsNew={openChangelog} />
        <QuickNoteButton />{/* Quick Note: today's scratchpad from any screen, Ctrl+Alt+N (notes/, Oct 29 2026) */}
        {buildMode.enabled && buildMode.on && <BuildModeChip onClick={buildMode.toggle} />}
        <NotificationBell onNavigate={onNavigate} />

        {/* User profile pill */}
        <div className="header-user-wrap" ref={dropRef}>
          <button ref={pillRef} className="header-user-pill" onClick={() => { setMenuView(''); setOpen(o => !o); }} title="Account" aria-label="Account menu" aria-haspopup="menu" aria-expanded={open}>
            <div className="header-avatar">
              {photo
                ? <img src={photo} alt="" style={{ width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover', display: 'block' }} />
                : initials}
            </div>
            <div className="header-user-info">
              <span className="header-user-name">{name.split(" ")[0]}</span>
              <span className="header-user-role">{myTitle || roleMeta.label}</span>
            </div>
            <ChevronDown size={13} style={{ color: 'var(--muted)', flexShrink: 0, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .2s' }} />
          </button>

          {open && menuView === 'actas' && (
            <div className="header-user-dropdown">
              <ActAsFinder onBack={backToMenu} />
            </div>
          )}
          {open && menuView !== 'actas' && (
            <div className="header-user-dropdown">

              {/* ── Profile card ─────────────────────────────────── */}
              <div style={{ padding: '14px 14px 10px', display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{
                  width: 42, height: 42, borderRadius: '50%', flexShrink: 0, overflow: 'hidden',
                  background: `hsl(${roleMeta.color})`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 15, fontWeight: 700, color: '#fff', letterSpacing: '.02em',
                }}>
                  {photo
                    ? <img src={photo} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                    : initials}
                </div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: 13.5, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {name}
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 1 }}>
                    {email}
                  </div>
                  {myTitle && (
                    <div style={{ fontSize: 11.5, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 1 }}>
                      {myTitle}
                    </div>
                  )}
                  <div style={{ marginTop: 5, display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 10, background: roleMeta.bg }}>
                    <Shield size={10} style={{ color: `hsl(${roleMeta.color})`, flexShrink: 0 }} />
                    <span style={{ fontSize: 10.5, fontWeight: 700, color: `hsl(${roleMeta.color})`, letterSpacing: '.03em' }}>
                      {roleMeta.label}
                    </span>
                  </div>
                </div>
              </div>

              <div className="hud-divider" />

              <button className="hud-item" onClick={() => { setOpen(false); setMyProfileOpen(true); }}>
                <User size={14} /> Profile
              </button>
              <button className="hud-item" onClick={() => { setOpen(false); openChangelog(); }}>
                <Sparkles size={14} /> What's New
              </button>
              {/* Dark Mode + Theme moved into My Profile (Neil: group appearance
                  settings with the rest of "your" settings instead of loose in
                  the top-level menu). Page help and the guided Tour are the
                  header's Help panel ("Help with This Page" / "Take the Tour",
                  support/HelpWidget.jsx) - the rows that were here went Oct 12
                  and Oct 13 (Neil: the Tour was buried under the user's name). */}

              {/* Legal (Neil, 10/06): the Privacy Policy and Terms & Conditions,
                  one page with a tab each - "nothing to do with Support". The
                  Implementation Guide left this menu (Neil, Oct 13 2026) - it is
                  a section of Help Center > Documentation. */}
              <button className="hud-item" onClick={() => { setOpen(false); window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'legal', sub: 'privacy' } })); }}>
                <Scale size={14} /> Legal
              </button>

              {/* Tools (Neil, Oct 25 2026): Act As, Build Mode and Testing
                  under one label, each row only for the
                  people who can use it - components/ToolsMenu.jsx. The sticky
                  orange banner below still offers Exit Act As everywhere. */}
              <ToolsSection onClose={() => setOpen(false)} onOpenActAs={openActAs} />

              <div className="hud-divider" />
              <button className="hud-item hud-signout" onClick={handleSignOut}>
                <LogOut size={14} /> Sign Out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>

    {/* Persistent, hard-to-miss reminder that this is impersonation, not the
        real signed-in identity - sits under the header on every screen for
        the whole session, not just the profile menu (Jul 2026). */}
    {actingAs && (
      <div style={{
        position: 'sticky', top: 56, zIndex: 105, display: 'flex', alignItems: 'center',
        justifyContent: 'center', gap: 10, padding: '7px 16px',
        background: 'hsla(var(--color-orange), 0.16)', borderBottom: '1px solid hsla(var(--color-orange), 0.4)',
        fontFamily: 'Inter, sans-serif', fontSize: 12.5, color: 'var(--ink)', flexWrap: 'wrap', textAlign: 'center',
      }}>
        <UserCog size={13} style={{ color: 'hsl(var(--color-orange))', flexShrink: 0 }} />
        <span>You're acting as <strong>{actingAs.targetName}</strong> ({actingAs.targetEmail}) - actions you take are attributed to them.</span>
        <button onClick={handleExitActAs} disabled={actAsStopping}
          style={{
            background: 'hsl(var(--color-orange))', color: '#fff', border: 'none', borderRadius: 6,
            padding: '3px 10px', fontSize: 11.5, fontWeight: 700, cursor: actAsStopping ? 'default' : 'pointer',
            fontFamily: 'inherit', flexShrink: 0,
          }}>
          {actAsStopping ? 'Exiting…' : 'Exit Act As'}
        </button>
      </div>
    )}

    {myProfileOpen && (
      <MyProfileModal onClose={() => setMyProfileOpen(false)} focusEmail={myProfileOpen === 'email'}
        theme={theme} onThemeToggle={onThemeToggle}
        wkTheme={wkTheme} setWkTheme={setWkTheme}
        sidebarPinned={sidebarPinned} onSidebarPinnedChange={onSidebarPinnedChange} />
    )}

    </>
  );
}

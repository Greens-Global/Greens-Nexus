import { useState, useRef, useEffect, useCallback } from "react";
import { Menu, Search, LogOut, User, ArrowLeft, ChevronDown, Sparkles, X, UserCog, Scale } from "lucide-react";
import NotificationBell from "./NotificationBell";
import HelpMenu from "../support/HelpMenu";
import QuickNoteButton from "../notes/QuickNoteButton";
import { useHeaderTabs, ModuleBar } from "./ModuleTabs";
import MyProfileModal from "./MyProfileModal";
import QuickCreate from "./QuickCreate";   // the "+" Create menu (Oct 29 2026)
import { readStopEmail, setPendingEmailStop } from "../lib/emailStop";

// ?emailSettings=1 - the "Email Settings" link in task emails; it opens
// Profile on its Email Settings section (Neil, Oct 13 2026). Read when this
// module LOADS, not when the header mounts: the app's boot (auth, then routing
// "/dashboard" to its canonical URL) rewrites the address before the header
// ever renders, and the query went with it - the link opened nothing. Taken
// once and dropped from the URL so a refresh doesn't reopen Email Settings.
// ?profile=<section> (Neil, 11/02/2026) is the general form: the new sign-in
// bell's push and its email land on ?profile=security.
function _profileLinkFromUrl() {
  if (typeof window === 'undefined') return '';
  const q = new URLSearchParams(window.location.search);
  if (q.get('emailSettings') === '1') return 'email';
  // ?stopEmail=<kind>: a digest's "Stop These Emails" link (11/02/2026,
  // lib/emailStop.js) - Profile opens on the email section and turns it off.
  const stop = readStopEmail(window.location.search);
  if (stop) { setPendingEmailStop(stop); return 'email'; }
  const section = q.get('profile') || '';
  return /^[a-z]+$/.test(section) ? section : '';
}
let PROFILE_LINK = _profileLinkFromUrl();
function takeProfileLink() {
  if (!PROFILE_LINK) return '';
  const section = PROFILE_LINK;
  PROFILE_LINK = '';
  const q = new URLSearchParams(window.location.search);
  if (q.has('emailSettings') || q.has('profile') || q.has('stopEmail')) {
    q.delete('emailSettings'); q.delete('profile'); q.delete('stopEmail');
    const rest = q.toString();
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${rest ? `?${rest}` : ''}${window.location.hash}`);
  }
  return section;
}
import { useMsal }        from "@azure/msal-react";
import { BFF_MODE, bffLogout } from "../bffAuth";
import { useRole, EXTERNAL_ROLE_META } from "../contexts/RoleContext";
import TierMark from "./TierMark";
import { usePersonPhoto } from "../lib/peoplePhotos";
import { api } from "../api";
import { useNexusSearch, SEARCH_PLACEHOLDER, SEARCH_HINT, SEARCH_LABEL } from './search/useNexusSearch';
import SearchResults from './search/SearchResults';

import { isSearchShortcut, isFindShortcut, isPhone } from '../lib/keys';
import { useBuildModeMenu, BuildModeChip } from '../devnotes/BuildModeChip';   // Build Mode (Oct 24 2026)
import { ToolsSection, ActAsFinder } from './ToolsMenu';   // profile menu Tools (Oct 25 2026)
import { useActionCounts } from '../lib/useActionCounts';
import { clearOfflineReadCache } from '../lib/offline/read';


export default function TopHeader({ title, activeView, theme, onThemeToggle, sidebarPinned, onSidebarPinnedChange, onMobileToggle, canGoBack, onBack, onNavigate, prevLabel }) {
  const { instance, accounts } = useMsal();
  const { actingAs, stopActAs, isExternal, myTier, myTitle } = useRole();
  // Module tab strip published by the active module (<ModuleTabs>) - drawn
  // in the module bar under this header (11/05/2026); read here only for the
  // screen-reader page name. The search bar sits in the right cluster on
  // every module, the same size in the same place (Neil, Oct 14 2026).
  const headerTabs = useHeaderTabs();
  const actionCounts = useActionCounts();
  const waiting = Object.values(actionCounts || {}).some((tabs) => Object.values(tabs || {}).some((n) => n > 0));
  // Modules that opt into syncTitle (<ModuleTabs syncTitle>) get the active
  // tab's own name in the breadcrumb instead of the module's fixed name - so
  // switching tabs (e.g. Time Clock's Clock/Time Sheet/Time Off) actually
  // renames the page instead of every tab reading as the landing tab.
  // A dropdown tab's item counts too (People > Organizational Chart, 11/03/2026).
  const activeTabMeta = headerTabs?.tabs?.flatMap(t => [t, ...(t.items || [])]).find(t => t.key === headerTabs.active);
  const displayTitle = (headerTabs?.syncTitle && activeTabMeta)
    ? (activeTabMeta.title || activeTabMeta.label)
    : title;
  // Profile (Neil, Oct 13 2026; was My Profile): everything that relates only
  // to you - photo, signature, appearance, world clock and Email Settings,
  // which used to be a menu item of its own. 'email' opens it on that section:
  // the "Email Settings" link in every task email lands on ?emailSettings=1,
  // the new sign-in notice on ?profile=security - see PROFILE_LINK above for
  // why those are read at module load. A string here is the section to open.
  const [myProfileOpen, setMyProfileOpen] = useState(() => takeProfileLink() || false);
  // A bell whose action is { view: 'profile', sub } (the new sign-in notice,
  // 11/02/2026) is not a screen: App ignores the view and the header opens
  // Profile on that section.
  useEffect(() => {
    const onNav = (e) => { if (e.detail?.view === 'profile') setMyProfileOpen(e.detail.sub || 'appearance'); };
    window.addEventListener('nexus:navigate', onNav);
    return () => window.removeEventListener('nexus:navigate', onNav);
  }, []);
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
  // Under the name: the JOB TITLE (from /roles/me, via useRole), never the
  // Nexus tier (Neil, 11/02/2026: "it should not say global admin here under
  // my name ... pull my title"). No title = blank, never "Employee". External
  // guests with no title still read "External" (Visesh, Aug 18). The tier is
  // the small TierMark after the name on the card; the old Shield badge row
  // that spelled it out is gone.
  const subtitle = myTitle || (isExternal ? EXTERNAL_ROLE_META.label : '');

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
  //
  // Ctrl/Cmd+F lands here too (Neil, 11/04/2026), on a phone in the sheet, but
  // only once every other keydown listener has had the key: a screen's own find
  // (Accounting's ledger search, Vendors & Customers, the Report Library, the
  // Audit Log) and a popup keep it. Pressed again inside a search it stays the
  // browser's find, so the page text can still be searched.
  useEffect(() => {
    const onKey = (e) => {
      if (isFindShortcut(e)) {
        if (e.defaultPrevented) return;
        // Added during the document's turn, so it runs after every window listener - Accounting's late one included.
        const late = (ev) => {
          if (ev !== e || e.defaultPrevented) return;
          // Any open popup keeps the browser's find, marked modal or not (review, 11/04/2026).
          if (document.querySelector('[aria-modal="true"], [role="dialog"], .modal-overlay, .cv-modal-overlay') || document.activeElement?.closest?.('[role="search"]')) return;
          e.preventDefault();
          if (isPhone()) { window.dispatchEvent(new Event('nexus:search-open')); return; }
          searchInputRef.current?.focus();
          setSearchOpen(true);
        };
        window.addEventListener('keydown', late, { once: true });
        setTimeout(() => window.removeEventListener('keydown', late), 0);   // a key stopped on the way up never reaches it
        return;
      }
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

  async function handleSignOut() {
    // BFF mode: there is no MSAL session to end - kill the server session and
    // clear the cookie via /api/auth/logout instead.
    if (BFF_MODE) { bffLogout(); return; }
    // The phone's offline copy goes before the redirect can cut it off (field offline, 11/03/2026).
    await clearOfflineReadCache();
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
          title={`${SEARCH_LABEL} (Ctrl+F)`}
          aria-keyshortcuts="Control+K Meta+K Control+F Meta+F /"
          value={searchQuery}
          onChange={e => { setSearchQuery(e.target.value); setSearchIdx(0); setSearchOpen(true); }}
          onFocus={() => setSearchOpen(true)}
          onKeyDown={handleSearchKey}
        />
        {searchQuery
          ? <button className="search-clear" onClick={() => closeSearch(true)} title="Clear" aria-label="Clear search"><X size={13} /></button>
          // One hint on every computer (Neil, 11/05/2026): Ctrl+F works on a Mac too.
          : <kbd className="hdr-search-kbd" aria-hidden="true">Ctrl+F</kbd>}
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
          {/* The page trail (Neil, 11/04/2026) names the module and the pages
              above a record, in the page above its title (PageTrail.jsx), so
              the bar keeps only Back - the trail goes UP, this goes BACK. The
              name stays for screen readers and Build Mode's capture. */}
          <span className="breadcrumb-current sr-only">{displayTitle}</span>
        </div>
      </div>

      {/* The module bar - the module's name (or a record's trail), its tabs,
          its actions - rides here, right after Back, on a computer (Neil,
          11/06/2026: one row, more of the page to work with). Phones draw
          it under the header instead (ModuleBar in ModuleTabs.jsx). */}
      <div className="header-center"><ModuleBar where="header" /></div>

      <div className="header-right">
        {searchBar}
        {/* Create (Neil, Oct 29 2026): the "+" beside the search bar starts a
            task, a ticket, a request... from any screen - components/QuickCreate.jsx. */}
        <QuickCreate />
        <QuickNoteButton />{/* Quick Note: today's scratchpad, opened by the + menu's New Note or Ctrl+Alt+N - no button of its own (notes/, Oct 30 2026) */}
        {buildMode.enabled && buildMode.on && <BuildModeChip onClick={buildMode.toggle} />}
        <NotificationBell onNavigate={onNavigate} />
        {/* "?" Help menu: search the guide, help with this page, then Contact
            Support - self-service first (Neil, Sep 26). support/HelpMenu.jsx.
            Right beside the profile (Neil, Oct 30 2026). */}
        <HelpMenu activeView={activeView} onWhatsNew={openChangelog} />

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
              <span className="header-user-role">{subtitle}</span>
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
                  background: 'var(--mist)',   // a neutral tint, not the tier's color (Neil, 11/02/2026)
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 15, fontWeight: 700, color: 'var(--muted)', letterSpacing: '.02em',
                }}>
                  {photo
                    ? <img src={photo} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                    : initials}
                </div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: 13.5, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {name}<TierMark tier={myTier} />
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 1 }}>
                    {email}
                  </div>
                  {subtitle && (
                    <div style={{ fontSize: 11.5, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 1 }}>
                      {subtitle}
                    </div>
                  )}
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
        background: 'linear-gradient(var(--wk-live-tint), var(--wk-live-tint)) var(--wk-card)', borderBottom: '1px solid var(--wk-live-line)',
        fontFamily: 'Inter, sans-serif', fontSize: 12.5, color: 'var(--ink)', flexWrap: 'wrap', textAlign: 'center',
      }}>
        <UserCog size={13} style={{ color: 'var(--wk-live)', flexShrink: 0 }} />
        <span>You're acting as <strong>{actingAs.targetName}</strong> ({actingAs.targetEmail}) - actions you take are attributed to them.</span>
        <button onClick={handleExitActAs} disabled={actAsStopping}
          style={{
            background: 'var(--wk-live-ink)', color: 'var(--wk-live-on)', border: 'none', borderRadius: 6,
            padding: '3px 10px', fontSize: 11.5, fontWeight: 700, cursor: actAsStopping ? 'default' : 'pointer',
            fontFamily: 'inherit', flexShrink: 0,
          }}>
          {actAsStopping ? 'Exiting…' : 'Exit Act As'}
        </button>
      </div>
    )}

    {myProfileOpen && (
      <MyProfileModal key={String(myProfileOpen)} onClose={() => setMyProfileOpen(false)} focusEmail={myProfileOpen === 'email'}
        initialSection={typeof myProfileOpen === 'string' ? myProfileOpen : undefined}
        theme={theme} onThemeToggle={onThemeToggle}
        wkTheme={wkTheme} setWkTheme={setWkTheme}
        sidebarPinned={sidebarPinned} onSidebarPinnedChange={onSidebarPinnedChange} />
    )}

    </>
  );
}

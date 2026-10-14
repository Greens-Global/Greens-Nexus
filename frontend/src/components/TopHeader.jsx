import { useState, useRef, useEffect } from "react";
import { Menu, Search, LogOut, User, ArrowLeft, Shield, ChevronDown, Sparkles, X, UserCog, Eye, Mail, Scale, Rocket } from "lucide-react";
import NotificationBell from "./NotificationBell";
import HelpMenu from "../support/HelpMenu";
import { TabGroupButton, useHeaderTabs } from "./ModuleTabs";
import TabInk from "./TabInk";
import MyProfileModal from "./MyProfileModal";
import EmailSettingsModal from "./EmailSettingsModal";

// ?emailSettings=1 - the "Email Settings" link in task emails. Read when this
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

// Is the keyboard focus somewhere that types? Then "/" is a character, not
// our shortcut.
const isTypingTarget = (el) => !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
const PHONE = '(max-width: 900px)';
const MOD_KEY = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘' : 'Ctrl';

export default function TopHeader({ title, activeView, theme, onThemeToggle, sidebarPinned, onSidebarPinnedChange, onMobileToggle, canGoBack, onBack, onNavigate, prevLabel }) {
  const { instance, accounts } = useMsal();
  const { myRole, can, actingAs, stopActAs, isExternal } = useRole();
  // Module tab strip published by the active module (<ModuleTabs>). When
  // present it takes the header center (Work OS shell). The search bar is
  // NOT part of that bargain any more: it sits in the right cluster on
  // every module, the same size in the same place (Neil, Oct 14 2026).
  const headerTabs = useHeaderTabs();
  // Modules that opt into syncTitle (<ModuleTabs syncTitle>) get the active
  // tab's own name in the breadcrumb instead of the module's fixed name - so
  // switching tabs (e.g. Time Clock's Clock/Time Sheet/Time Off) actually
  // renames the page instead of every tab reading as the landing tab.
  const activeTabMeta = headerTabs?.tabs?.find(t => t.key === headerTabs.active);
  const displayTitle = (headerTabs?.syncTitle && activeTabMeta)
    ? (activeTabMeta.title || activeTabMeta.label)
    : title;
  const [myProfileOpen, setMyProfileOpen] = useState(false);
  // Email Settings (menu item below My Profile). The "Email Settings" link in
  // every task email lands on ?emailSettings=1 and opens it straight away -
  // see EMAIL_SETTINGS_LINK above for why that is read at module load.
  const [emailSettingsOpen, setEmailSettingsOpen] = useState(() => takeEmailSettingsLink());
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
  // Red-dot eye icon next to the profile pill: lit while a published changelog
  // update is newer than this user's last visit to What's New (cleared on open).
  const [changelogUnseen, setChangelogUnseen] = useState(false);
  useEffect(() => {
    let alive = true;
    api.getTaskChangelogUnseen().then(r => { if (alive) setChangelogUnseen(!!r?.unseen); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  // What's New is a page in the app now (Neil, Oct 12 2026), not an overlay:
  // every way in navigates to it, and every signed-in user may read it.
  function openChangelog() {
    onNavigate?.('whats-new');
  }
  // Landing on What's New by any route (menu, Help panel, a link, the URL)
  // records the visit. The dot is hidden at once while the page is open
  // (below) and the flag clears once the visit is saved, so it stays gone.
  useEffect(() => {
    if (activeView !== 'whats-new' || !changelogUnseen) return;
    api.markTaskChangelogSeen().catch(() => {}).finally(() => setChangelogUnseen(false));
  }, [activeView, changelogUnseen]);
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
    searchListRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [searchIdx]);
  function closeSearch(blur = false) {
    setSearchQuery(''); setSearchOpen(false);
    if (blur) searchInputRef.current?.blur();
  }
  function pickSearch(row) {
    closeSearch(true);
    row.run?.();
  }

  // Keyboard: Ctrl/Cmd+K and "/" (outside a text field) land in this bar on
  // a desktop; on a phone, where the bar is hidden, they open the sheet.
  useEffect(() => {
    const onKey = (e) => {
      const isK = (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k';
      const isSlash = e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !isTypingTarget(e.target) && !isTypingTarget(document.activeElement);
      if (!isK && !isSlash) return;
      e.preventDefault();
      if (window.matchMedia?.(PHONE).matches) { window.dispatchEvent(new CustomEvent('nexus:search-open')); return; }
      searchInputRef.current?.focus();
      setSearchOpen(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    function handleClick(e) {
      if (dropRef.current && !dropRef.current.contains(e.target)) setOpen(false);
      if (searchRef.current && !searchRef.current.contains(e.target)) setSearchOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  function handleSearchKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); closeSearch(true); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setSearchIdx(i => Math.min(search.rows.length - 1, i + 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSearchIdx(i => Math.max(0, i - 1)); return; }
    if (e.key === 'Enter' && search.rows[searchIdx]) { e.preventDefault(); pickSearch(search.rows[searchIdx]); }
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
                activeIdx={searchIdx} onActive={setSearchIdx} onPick={pickSearch} listRef={searchListRef} />
            : <div className="gs-hint">{SEARCH_HINT}</div>}
        </div>
      )}
    </div>
  );

  return (
    <>
    <header className="top-header">
      <div className="header-left">
        <button className="mobile-toggle" onClick={onMobileToggle} aria-label="Menu" title="Menu">
          <Menu style={{ width: 18, height: 18 }} />
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
          {canGoBack && prevLabel && (
            <>
              <button className="breadcrumb-prev" onClick={onBack} title={`Back to ${prevLabel}`}>{prevLabel}</button>
              <span style={{ color: "var(--muted)", opacity: 0.4, fontSize: 11, userSelect: "none" }}>/</span>
            </>
          )}
          <span className="breadcrumb-current">{displayTitle}</span>
        </div>
      </div>

      <div className={`header-center${headerTabs ? ' has-tabs' : ''}`}>
        {headerTabs && (
          <nav className="hdr-tabs" aria-label="Module sections" data-tour="module-tabs">
            <TabInk key={headerTabs.tabs.map((t) => t.key).join('|')} active={headerTabs.active} />
            {headerTabs.tabs.map(({ key, label, Icon, badge, items }) => (items ? (
              <TabGroupButton key={key} tab={{ key, label, Icon, items }} active={headerTabs.active} className="hdr-tab"
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
        <NotificationBell onNavigate={onNavigate} />

        {/* Unseen-changelog eye icon: only rendered while there's a published
            update this user hasn't opened What's New for yet. */}
        {changelogUnseen && activeView !== 'whats-new' && (
          <button onClick={openChangelog} title="What's New: a new update is available" aria-label="New update published"
            style={{
              position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 32, height: 32, borderRadius: 8, border: 'none', background: 'transparent',
              color: 'var(--muted)', cursor: 'pointer', flexShrink: 0,
            }}>
            <Eye size={16} />
            <span style={{
              position: 'absolute', top: 4, right: 4, width: 8, height: 8, borderRadius: 999,
              background: 'hsl(var(--color-red))', border: '1.5px dashed #fff',
            }} />
          </button>
        )}

        {/* User profile pill */}
        <div className="header-user-wrap" ref={dropRef}>
          <button className="header-user-pill" onClick={() => setOpen(o => !o)} title="Account" aria-label="Account menu" aria-haspopup="menu" aria-expanded={open}>
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

          {open && (
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
                <User size={14} /> My Profile
              </button>
              <button className="hud-item" onClick={() => { setOpen(false); setEmailSettingsOpen(true); }}>
                <Mail size={14} /> Email Settings
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
                  Implementation Guide sits here too for administrators: how to
                  set Nexus up for an organization (Support > Implementation Guide). */}
              <button className="hud-item" onClick={() => { setOpen(false); window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'legal', sub: 'privacy' } })); }}>
                <Scale size={14} /> Legal
              </button>
              {!isExternal && can('administrator') && (
                <button className="hud-item" onClick={() => { setOpen(false); window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'support', sub: 'implementation' } })); }}>
                  <Rocket size={14} /> Implementation Guide
                </button>
              )}

              {/* Act As and Audit Logs live in Settings (the Tools and Audit
                  Logs tabs) - neither belongs in this personal menu.
                  The "Exit Act As" affordance stays available at all times via
                  the sticky orange banner below, independent of this menu. */}

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
      <MyProfileModal onClose={() => setMyProfileOpen(false)}
        theme={theme} onThemeToggle={onThemeToggle}
        wkTheme={wkTheme} setWkTheme={setWkTheme}
        sidebarPinned={sidebarPinned} onSidebarPinnedChange={onSidebarPinnedChange} />
    )}

    {emailSettingsOpen && <EmailSettingsModal onClose={() => setEmailSettingsOpen(false)} />}
    </>
  );
}

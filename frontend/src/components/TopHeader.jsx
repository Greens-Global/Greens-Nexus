import { useState, useRef, useEffect, useMemo, lazy, Suspense } from "react";
import { Menu, Search, LogOut, Settings, User, ArrowLeft, Shield, Activity, Check, ChevronDown, LayoutDashboard, Camera, Clock, Sparkles, X, UserCog, DoorOpen, Archive, PlayCircle, Eye } from "lucide-react";
const Changelog = lazy(() => import("../tasks/ChangelogView"));
import NotificationBell from "./NotificationBell";
import PageHelp from "./PageHelp";
import { useHeaderTabs } from "./ModuleTabs";
import ActAsModal from "./ActAsModal";
import AccountSettingsModal from "./AccountSettingsModal";
import MyProfileModal from "./MyProfileModal";
import { useMsal }        from "@azure/msal-react";
import { BFF_MODE, bffLogout } from "../bffAuth";
import { useRole, ROLES, MODULES, EXTERNAL_ROLE_META } from "../contexts/RoleContext";
import { usePersonPhoto } from "../lib/peoplePhotos";
import { api } from "../api";

// Header search reaches into the Task module's content, not just the module
// list, so typing a task's title finds the task. Grouped by kind the way Asana's
// own search is - a flat list of mixed things forces the reader to work out what
// each row IS before deciding whether it is the one they want.
const SEARCH_GROUPS = [
  { key: 'tasks',      label: 'Tasks' },
  { key: 'projects',   label: 'Projects' },
  { key: 'people',     label: 'People' },
  { key: 'portfolios', label: 'Portfolios' },
  { key: 'teams',      label: 'Teams' },
];
const EMPTY_HITS = { tasks: [], projects: [], people: [], portfolios: [], teams: [] };

export default function TopHeader({ title, activeView, theme, onThemeToggle, sidebarPinned, onSidebarPinnedChange, onMobileToggle, canGoBack, onBack, onNavigate, prevLabel, onOpenAdmin, helpKey, helpLabel }) {
  const { instance, accounts } = useMsal();
  const { myRole, can, myGrantedModules, actingAs, startActAs, stopActAs, isExternal } = useRole();
  // Module tab strip published by the active module (<ModuleTabs>). When
  // present it takes the header center (Work OS shell) and the global search
  // collapses to a magnifier icon on the right.
  const headerTabs = useHeaderTabs();
  // Modules that opt into syncTitle (<ModuleTabs syncTitle>) get the active
  // tab's own name in the breadcrumb instead of the module's fixed name - so
  // switching tabs (e.g. Time Clock's Clock/Time Sheet/Time Off) actually
  // renames the page instead of every tab reading as the landing tab.
  const activeTabMeta = headerTabs?.tabs?.find(t => t.key === headerTabs.active);
  const displayTitle = (headerTabs?.syncTitle && activeTabMeta)
    ? (activeTabMeta.title || activeTabMeta.label)
    : title;
  // Manager/IT Admin/Global Admin get Act As by role today; an 'act-as' Access
  // Group grant (added to MODULES later) will let a Global Admin extend it to
  // specific other employees without a backend change.
  const canActAs = (can?.('manager') ?? false) || !!myGrantedModules?.has?.('act-as');
  const [actAsModalOpen, setActAsModalOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [myProfileOpen, setMyProfileOpen] = useState(false);
  // Asana severed (Aug 27). This used to catch the OAuth callback's
  // ?asana=connected|denied|error and reopen Account Settings on it. Nobody can
  // start that flow any more, but a stale bookmark or an in-flight redirect
  // still can - so the params are stripped silently rather than reopening a
  // modal about an integration that is gone.
  const [asanaResult, setAsanaResult] = useState({ result: "", reason: "" });
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
  const isAdmin  = can?.('administrator') ?? false;
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
  const [changelogOpen, setChangelogOpen] = useState(false); // Profile → What's new
  // Red-dot eye icon next to the profile pill: lit while a published changelog
  // update is newer than this user's last visit to What's New (cleared on open).
  const [changelogUnseen, setChangelogUnseen] = useState(false);
  useEffect(() => {
    let alive = true;
    api.getTaskChangelogUnseen().then(r => { if (alive) setChangelogUnseen(!!r?.unseen); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  function openChangelog() {
    setChangelogOpen(true);
    if (changelogUnseen) {
      setChangelogUnseen(false);
      api.markTaskChangelogSeen().catch(() => {});
    }
  }
  const [searchQuery,  setSearchQuery]  = useState('');
  const [searchOpen,   setSearchOpen]   = useState(false);
  const dropRef   = useRef(null);
  const searchRef = useRef(null);

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

  // Restricted view IDs that need at minimum supervisor role
  const RESTRICTED_MIN_SUPERVISOR = new Set([
    'manager-dashboard','tasks','tickets','sop','it','ops','operations','development',
    'property-asset','accounting','investor-relations','hr','marketing','external-links',
  ]);

  const searchResults = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    return MODULES.filter(m => {
      if (m.id === 'admin' && !can?.('administrator')) return false;
      // Grant-driven below admin: a restricted screen only appears in search if
      // the user is admin+ or an Access Group grants it (Jun 17).
      if (RESTRICTED_MIN_SUPERVISOR.has(m.id) && !can?.('administrator') && !myGrantedModules?.has(m.id)) return false;
      return m.label.toLowerCase().includes(q) || m.id.toLowerCase().includes(q);
    }).slice(0, 6);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, myRole, myGrantedModules]);

  // Content search, debounced so a fast typist makes one call rather than one
  // per keystroke. Failures fall back to an empty result set: the module
  // matches above are computed locally and must keep working if the API is down.
  const [hits, setHits] = useState(EMPTY_HITS);
  // True from the first keystroke until the answer for the CURRENT text lands
  // (debounce included). The popover used to sit empty for that beat and read
  // as "no results" until the rows popped in.
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    const term = searchQuery.trim();
    if (term.length < 2) { setHits(EMPTY_HITS); setSearching(false); return undefined; }
    let live = true;
    setSearching(true);
    const id = setTimeout(() => {
      api.searchTaskModule(term)
        .then((r) => { if (live) setHits({ ...EMPTY_HITS, ...r }); })
        .catch(() => { if (live) setHits(EMPTY_HITS); })
        .finally(() => { if (live) setSearching(false); });
    }, 180);
    return () => { live = false; clearTimeout(id); };
  }, [searchQuery]);

  const hitCount = SEARCH_GROUPS.reduce((n, g) => n + (hits[g.key]?.length || 0), 0);

  // Every result closes the popover, then routes by what it is. Tasks and
  // people go through window events (nexus:open-task / nexus:tasks-person)
  // because the Task module owns the drawer and the workspace - the header
  // only says WHAT was picked, never how to render it.
  function openAllTasks(q) {
    setSearchQuery(''); setSearchOpen(false);
    window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'tasks', sub: 'mine' } }));
    setTimeout(() => window.dispatchEvent(new CustomEvent('nexus:tasks-search', { detail: { q } })), 0);
  }

  function openHit(kind, item) {
    setSearchQuery(''); setSearchOpen(false);
    const toTasks = (sub) => window.dispatchEvent(
      new CustomEvent('nexus:navigate', { detail: { view: 'tasks', sub } }));
    if (kind === 'tasks') {
      toTasks('mine');
      setTimeout(() => window.dispatchEvent(
        new CustomEvent('nexus:open-task', { detail: { taskId: item.id } })), 0);
    } else if (kind === 'people') {
      toTasks('home');
      setTimeout(() => window.dispatchEvent(
        new CustomEvent('nexus:tasks-person', { detail: { email: item.email, name: item.name } })), 0);
    } else if (kind === 'projects') {
      toTasks('projects');
    } else if (kind === 'portfolios') {
      toTasks('portfolios');
    } else if (kind === 'teams') {
      toTasks('teams');
    }
  }

  useEffect(() => {
    function handleClick(e) {
      if (dropRef.current && !dropRef.current.contains(e.target)) setOpen(false);
      if (searchRef.current && !searchRef.current.contains(e.target)) setSearchOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  function handleSearchKey(e) {
    if (e.key === 'Escape') { setSearchQuery(''); setSearchOpen(false); }
    if (e.key !== 'Enter') return;
    // Content beats a page: someone typing a task's title wants the task, and
    // the module list is the fallback it always was.
    const group = SEARCH_GROUPS.find((g) => hits[g.key]?.length);
    if (group) { openHit(group.key, hits[group.key][0]); return; }
    if (searchResults.length > 0) {
      onNavigate(searchResults[0].id);
      setSearchQuery(''); setSearchOpen(false);
    }
  }
  function goTo(id) {
    onNavigate(id);
    setSearchQuery(''); setSearchOpen(false);
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

  // One search implementation, two placements: the full centered bar when no
  // module tabs are published, or inside a right-side popover when they are.
  const searchInput = (
    <div className="search-bar">
      <Search style={{ width: 14, height: 14, flexShrink: 0 }} />
      <input
        placeholder="Search tasks, projects, people…"
        value={searchQuery}
        onChange={e => { setSearchQuery(e.target.value); setSearchOpen(true); }}
        onFocus={() => setSearchOpen(true)}
        onKeyDown={handleSearchKey}
        autoFocus={!!headerTabs}
      />
      {searchQuery && <button className="search-clear" onClick={() => { setSearchQuery(''); setSearchOpen(false); }} title="Clear search" aria-label="Clear search"><X size={13} /></button>}
    </div>
  );

  const panelStyle = {
    position: 'absolute', top: 'calc(100% + 6px)', left: 0, right: 0,
    background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10,
    boxShadow: '0 8px 28px rgba(0,0,0,0.15)', zIndex: 500, overflow: 'hidden',
  };
  const rowStyle = {
    width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px',
    background: 'transparent', border: 'none', cursor: 'pointer',
    fontFamily: 'Inter,sans-serif', fontSize: 13, color: 'var(--ink)', textAlign: 'left',
  };
  const headingStyle = {
    padding: '7px 14px 4px', fontSize: 10.5, fontWeight: 700, letterSpacing: '.07em',
    textTransform: 'uppercase', color: 'var(--muted)', background: 'var(--mist)',
  };
  const subStyle = { fontSize: 11.5, color: 'var(--muted)' };
  const hover = (on) => (e) => (e.currentTarget.style.background = on ? 'var(--mist)' : 'transparent');

  const searchResultsDropdown = (
    <>
      {searchOpen && (searchResults.length > 0 || hitCount > 0 || searching) && (
        <div style={{ ...panelStyle, maxHeight: '70vh', overflowY: 'auto' }}>
          {searching && hitCount === 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', fontSize: 12.5, color: 'var(--muted)' }}>
              <span aria-hidden style={{ width: 13, height: 13, borderRadius: '50%', border: '2px solid var(--line)', borderTopColor: 'var(--muted)', animation: 'spin 0.8s linear infinite', flexShrink: 0 }} />
              Searching tasks, projects and people…
            </div>
          )}
          {SEARCH_GROUPS.map((g) => (hits[g.key]?.length ? (
            <div key={g.key}>
              <div style={headingStyle}>{g.label}</div>
              {hits[g.key].map((item) => (
                <button key={item.id || item.email} onClick={() => openHit(g.key, item)}
                  style={rowStyle} onMouseEnter={hover(true)} onMouseLeave={hover(false)}>
                  {g.key === 'tasks' ? (
                    <>
                      <Check size={13} style={{ color: item.completed ? 'var(--ok, #16a34a)' : 'var(--muted)', flexShrink: 0 }} />
                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        textDecoration: item.completed ? 'line-through' : 'none' }}>
                        {item.title}
                        {/* A subtask says whose it is - same-titled subtasks
                            across many parents are otherwise identical lines. */}
                        {item.parentTitle && <span style={{ ...subStyle, marginLeft: 6 }}>‹ {item.parentTitle}</span>}
                      </span>
                      {item.projectName && <span style={{ ...subStyle, flexShrink: 0 }}>{item.projectName}</span>}
                    </>
                  ) : g.key === 'people' ? (
                    <>
                      <User size={13} style={{ color: 'var(--muted)', flexShrink: 0 }} />
                      <span style={{ fontWeight: 500 }}>{item.name}</span>
                      <span style={{ ...subStyle, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.email}</span>
                    </>
                  ) : (
                    <>
                      {/* An archived project is still findable here - archiving
                          hides it from the active list and from task pickers, not
                          from history. It is dimmed and labelled so nobody opens
                          one thinking it is live work. */}
                      {item.archived
                        ? <Archive size={13} style={{ color: 'var(--muted)', flexShrink: 0, opacity: 0.75 }} />
                        : <LayoutDashboard size={13} style={{ color: 'var(--muted)', flexShrink: 0 }} />}
                      <span style={{ fontWeight: 500, color: item.archived ? 'var(--muted)' : undefined }}>{item.name}</span>
                      {item.archived && (
                        <span style={{
                          flexShrink: 0, fontSize: 10.5, fontWeight: 700, letterSpacing: '.04em',
                          textTransform: 'uppercase', padding: '1px 7px', borderRadius: 999,
                          color: 'var(--muted)', border: '1px solid var(--border, #d4d4d8)',
                        }}>Archived</span>
                      )}
                    </>
                  )}
                </button>
              ))}
              {(hits.totals?.[g.key] || 0) > hits[g.key].length && (
                g.key === 'tasks' ? (
                  <button onClick={() => openAllTasks(searchQuery)} style={{ ...rowStyle, ...subStyle }} onMouseEnter={hover(true)} onMouseLeave={hover(false)}>
                    See all {hits.totals[g.key]} tasks matching "{searchQuery.trim()}"
                  </button>
                ) : (
                  <div style={{ ...subStyle, padding: '6px 12px 8px' }}>
                    and {hits.totals[g.key] - hits[g.key].length} more {g.label.toLowerCase()}
                  </div>
                )
              )}
            </div>
          ) : null))}
          {searchResults.length > 0 && (
            <div>
              <div style={headingStyle}>Pages</div>
              {searchResults.map((m) => (
                <button key={m.id} onClick={() => goTo(m.id)} style={rowStyle}
                  onMouseEnter={hover(true)} onMouseLeave={hover(false)}>
                  <LayoutDashboard size={13} style={{ color: 'var(--muted)', flexShrink: 0 }} />
                  <span style={{ fontWeight: 500 }}>{m.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {/* "No results" only once the answer for THIS text is back - while the
          request is in flight the panel above shows the searching line instead.
          Saying "no results" during the debounce made every search flash a
          denial before the rows arrived. */}
      {searchOpen && !searching && searchQuery.trim().length >= 2 && searchResults.length === 0 && hitCount === 0 && (
        <div style={{ ...panelStyle, padding: '12px 14px', fontSize: 13, color: 'var(--muted)', textAlign: 'center' }}>
          No results for "{searchQuery}"
        </div>
      )}
    </>
  );

  return (
    <>
    <header className="top-header">
      <div className="header-left">
        <button className="mobile-toggle" onClick={onMobileToggle} aria-label="Toggle Sidebar">
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
        <button className="icon-btn header-search-left" aria-label="Search"
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
        {headerTabs ? (
          <nav className="hdr-tabs" aria-label="Module sections">
            {headerTabs.tabs.map(({ key, label, Icon, badge }) => (
              <button key={key}
                className={`hdr-tab${headerTabs.active === key ? ' active' : ''}`}
                aria-current={headerTabs.active === key ? 'page' : undefined}
                onClick={() => { setSearchQuery(''); setSearchOpen(false); headerTabs.onChange(key); }}>
                {Icon && <Icon size={16} strokeWidth={2} />}
                <span>{label}</span>
                {badge > 0 && <span className="hdr-tab-badge">{badge}</span>}
              </button>
            ))}
          </nav>
        ) : (
          <div style={{ position: 'relative' }} ref={searchRef}>
            {searchInput}
            {searchResultsDropdown}
          </div>
        )}
      </div>

      <div className="header-right">
        {/* Module tabs occupy the center → search moves here. Tasks gets its
            own always-visible compact bar rather than an icon someone has to
            already know to click - task/people search was going unnoticed
            entirely because nothing on screen showed it existed (Aug 2026).
            Every other module keeps the plain icon-triggered popover it
            always had; the content search this bar reaches into (tasks,
            projects, portfolios, teams, people) is Task-module content, so
            widening it everywhere just added a search box other modules
            don't have anything of their own to search. */}
        {headerTabs && activeView === 'tasks' && (
          <div className="hdr-search-wrap hdr-search-inline" ref={searchRef}>
            {searchInput}
            {searchResultsDropdown}
          </div>
        )}
        {headerTabs && activeView !== 'tasks' && (
          <div className="hdr-search-wrap" ref={searchRef}>
            <button className="icon-btn" aria-label="Search Nexus" title="Search"
              onClick={() => setSearchOpen(o => !o)}>
              <Search style={{ width: 16, height: 16 }} />
            </button>
            {searchOpen && (
              <div className="hdr-search-pop">
                <div style={{ position: 'relative' }}>
                  {searchInput}
                  {searchResultsDropdown}
                </div>
              </div>
            )}
          </div>
        )}
        <NotificationBell onNavigate={onNavigate} />

        {/* Unseen-changelog eye icon: only rendered while there's a published
            update this user hasn't opened What's New for yet. */}
        {changelogUnseen && (
          <button onClick={openChangelog} title="New update published - view What's New" aria-label="New update published"
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
          <button className="header-user-pill" onClick={() => setOpen(o => !o)}>
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
{/* Account Settings held ONE thing - the personal Asana connection -
    so with Asana severed (Aug 27) it would open an empty modal. Hidden
    rather than deleted; restore this entry alongside the Manage tab.
              <button className="hud-item" onClick={() => { setOpen(false); setSettingsOpen(true); }}>
                <Settings size={14} /> Account Settings
              </button> */}
              <button className="hud-item" onClick={() => { setOpen(false); openChangelog(); }}>
                <Sparkles size={14} /> What's New
              </button>
              {/* Dark Mode + Theme moved into My Profile (Neil: group appearance
                  settings with the rest of "your" settings instead of loose in
                  the top-level menu). Help stays here. */}
              {helpKey && <PageHelp pageKey={helpKey} label={helpLabel} variant="row" onActivate={() => setOpen(false)} />}
              {/* Task module's guided walkthrough. Moved out of the module's own
                  header (was cluttering the primary bar next to Manage) into
                  here, right under page help - only meaningful while the Task
                  module is the active view, so it's gated on activeView rather
                  than shown everywhere. Tasks.jsx owns the tour state; this just
                  asks it to open via the same nexus:tasks-* event pattern the
                  module already uses for header search. */}
              {activeView === 'tasks' && (
                <button className="hud-item" onClick={() => { setOpen(false); window.dispatchEvent(new CustomEvent('nexus:tasks-tour')); }}>
                  <PlayCircle size={14} /> Tour
                </button>
              )}

              {/* Act As (Jul 2026): visible to Manager/IT Admin/Global Admin (or an
                  'act-as' Access Group grant). Exit is always shown while a session
                  is active - myRole may have dropped below manager because it's
                  now reporting the impersonated employee's own role. */}
              {(canActAs || actingAs) && (
                <>
                  <div className="hud-divider" />
                  {actingAs ? (
                    <button className="hud-item" onClick={() => { setOpen(false); handleExitActAs(); }} disabled={actAsStopping}
                      style={{ color: 'hsl(var(--color-red))' }}>
                      <DoorOpen size={14} /> {actAsStopping ? 'Exiting…' : `Exit Act As (${actingAs.targetName})`}
                    </button>
                  ) : (
                    <button className="hud-item" onClick={() => { setOpen(false); setActAsModalOpen(true); }}>
                      <UserCog size={14} /> Act As
                    </button>
                  )}
                </>
              )}

              {isAdmin && (
                <>
                  <div className="hud-divider" />
                  <div style={{ padding: '4px 12px 2px', fontSize: 10, fontWeight: 700, letterSpacing: '.06em', color: 'var(--muted)', textTransform: 'uppercase' }}>
                    Admin
                  </div>
                  <button className="hud-item" onClick={() => { setOpen(false); window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'hr', sub: 'hr-access' } })); }}
                    style={{ color: 'hsl(var(--color-purple))' }}>
                    <Shield size={14} /> Roles &amp; Access
                  </button>
                  <button className="hud-item" onClick={() => { setOpen(false); onOpenAdmin?.('audit'); }}
                    style={{ color: 'hsl(var(--color-purple))' }}>
                    <Activity size={14} /> Audit Logs
                  </button>
                  {/* Screenshots + Employee Tracking moved to the Employee Tracking
                      sidebar module (IT Admin / Global Admin only). */}
                </>
              )}

              <div className="hud-divider" />
              <button className="hud-item hud-signout" onClick={handleSignOut}>
                <LogOut size={14} /> Sign Out
              </button>
            </div>
          )}
        </div>
      </div>
      {changelogOpen && (
        <Suspense fallback={null}>
          <Changelog onClose={() => setChangelogOpen(false)} />
        </Suspense>
      )}
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

    {actAsModalOpen && (
      <ActAsModal
        onClose={() => setActAsModalOpen(false)}
        onStart={startActAs}
      />
    )}

    {settingsOpen && (
      <AccountSettingsModal
        onClose={() => { setSettingsOpen(false); setAsanaResult({ result: "", reason: "" }); }}
        initialResult={asanaResult.result}
        initialReason={asanaResult.reason}
      />
    )}

    {myProfileOpen && (
      <MyProfileModal onClose={() => setMyProfileOpen(false)}
        theme={theme} onThemeToggle={onThemeToggle}
        wkTheme={wkTheme} setWkTheme={setWkTheme}
        sidebarPinned={sidebarPinned} onSidebarPinnedChange={onSidebarPinnedChange} />
    )}
    </>
  );
}

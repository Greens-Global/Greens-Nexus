import { useState, useRef, useEffect, useMemo, lazy, Suspense } from "react";
import { Menu, Moon, Sun, Search, LogOut, Settings, User, ArrowLeft, Shield, Activity, Check, ChevronDown, LayoutDashboard, Palette, Camera, Clock, Sparkles, X, UserCog, DoorOpen } from "lucide-react";
import ScreenshotsAdmin from "./ScreenshotsAdmin";
const Changelog = lazy(() => import("../tasks/ChangelogView"));
import NotificationBell from "./NotificationBell";
import PageHelp from "./PageHelp";
import { useHeaderTabs } from "./ModuleTabs";
import ActAsModal from "./ActAsModal";
import AccountSettingsModal from "./AccountSettingsModal";
import { useMsal }        from "@azure/msal-react";
import { BFF_MODE, bffLogout } from "../bffAuth";
import { useRole, ROLES, MODULES } from "../contexts/RoleContext";
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

export default function TopHeader({ title, theme, onThemeToggle, onMobileToggle, canGoBack, onBack, onNavigate, prevLabel, onOpenAdmin, helpKey, helpLabel }) {
  const { instance, accounts } = useMsal();
  const { myRole, can, myGrantedModules, actingAs, startActAs, stopActAs } = useRole();
  // Module tab strip published by the active module (<ModuleTabs>). When
  // present it takes the header center (Work OS shell) and the global search
  // collapses to a magnifier icon on the right.
  const headerTabs = useHeaderTabs();
  // Manager/IT Admin/Global Admin get Act As by role today; an 'act-as' Access
  // Group grant (added to MODULES later) will let a Global Admin extend it to
  // specific other employees without a backend change.
  const canActAs = (can?.('manager') ?? false) || !!myGrantedModules?.has?.('act-as');
  const [actAsModalOpen, setActAsModalOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Coming back from Asana's consent screen: the OAuth callback redirects here
  // with ?asana=connected|denied|error so the outcome isn't lost across the
  // full page navigation. Reopen Account Settings on it, then strip the params
  // so a refresh doesn't replay the message.
  const [asanaResult, setAsanaResult] = useState({ result: "", reason: "" });
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const result = p.get("asana");
    if (!result) return;
    setAsanaResult({ result, reason: p.get("reason") || "" });
    setSettingsOpen(true);
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
  const roleMeta = ROLES[myRole] ?? ROLES.employee;
  const isAdmin  = can?.('administrator') ?? false;

  const [open,         setOpen]         = useState(false);
  const [shotsOpen,    setShotsOpen]    = useState(false);   // Admin → Screenshots gallery
  const [changelogOpen, setChangelogOpen] = useState(false); // Profile → What's new
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
  useEffect(() => {
    const term = searchQuery.trim();
    if (term.length < 2) { setHits(EMPTY_HITS); return undefined; }
    let live = true;
    const id = setTimeout(() => {
      api.searchTaskModule(term)
        .then((r) => { if (live) setHits({ ...EMPTY_HITS, ...r }); })
        .catch(() => { if (live) setHits(EMPTY_HITS); });
    }, 180);
    return () => { live = false; clearTimeout(id); };
  }, [searchQuery]);

  const hitCount = SEARCH_GROUPS.reduce((n, g) => n + (hits[g.key]?.length || 0), 0);

  // Every result closes the popover, then routes by what it is. Tasks and
  // people go through window events (nexus:open-task / nexus:tasks-person)
  // because the Task module owns the drawer and the workspace - the header
  // only says WHAT was picked, never how to render it.
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
      {searchOpen && (searchResults.length > 0 || hitCount > 0) && (
        <div style={{ ...panelStyle, maxHeight: '70vh', overflowY: 'auto' }}>
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
                        textDecoration: item.completed ? 'line-through' : 'none' }}>{item.title}</span>
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
                      <LayoutDashboard size={13} style={{ color: 'var(--muted)', flexShrink: 0 }} />
                      <span style={{ fontWeight: 500 }}>{item.name}</span>
                    </>
                  )}
                </button>
              ))}
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
      {searchOpen && searchQuery.trim().length >= 2 && searchResults.length === 0 && hitCount === 0 && (
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
          <span className="breadcrumb-current">{title}</span>
        </div>
      </div>

      <div className={`header-center${headerTabs ? ' has-tabs' : ''}`}>
        {headerTabs ? (
          <nav className="hdr-tabs" aria-label="Module sections">
            {headerTabs.tabs.map(({ key, label, Icon, badge }) => (
              <button key={key}
                className={`hdr-tab${headerTabs.active === key ? ' active' : ''}`}
                aria-current={headerTabs.active === key ? 'page' : undefined}
                onClick={() => headerTabs.onChange(key)}>
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
        {/* Module tabs occupy the center → search lives here as an icon */}
        {headerTabs && (
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

        {/* User profile pill */}
        <div className="header-user-wrap" ref={dropRef}>
          <button className="header-user-pill" onClick={() => setOpen(o => !o)}>
            <div className="header-avatar">{initials}</div>
            <div className="header-user-info">
              <span className="header-user-name">{name.split(" ")[0]}</span>
              <span className="header-user-role">{roleMeta.label}</span>
            </div>
            <ChevronDown size={13} style={{ color: 'var(--muted)', flexShrink: 0, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .2s' }} />
          </button>

          {open && (
            <div className="header-user-dropdown">

              {/* ── Profile card ─────────────────────────────────── */}
              <div style={{ padding: '14px 14px 10px', display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{
                  width: 42, height: 42, borderRadius: '50%', flexShrink: 0,
                  background: `hsl(${roleMeta.color})`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 15, fontWeight: 700, color: '#fff', letterSpacing: '.02em',
                }}>
                  {initials}
                </div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: 13.5, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {name}
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 1 }}>
                    {email}
                  </div>
                  <div style={{ marginTop: 5, display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 10, background: roleMeta.bg }}>
                    <Shield size={10} style={{ color: `hsl(${roleMeta.color})`, flexShrink: 0 }} />
                    <span style={{ fontSize: 10.5, fontWeight: 700, color: `hsl(${roleMeta.color})`, letterSpacing: '.03em' }}>
                      {roleMeta.label}
                    </span>
                  </div>
                </div>
              </div>

              <div className="hud-divider" />

              <button className="hud-item">
                <User size={14} /> My Profile
              </button>
              <button className="hud-item" onClick={() => { setOpen(false); setSettingsOpen(true); }}>
                <Settings size={14} /> Account Settings
              </button>
              <button className="hud-item" onClick={() => { setOpen(false); setChangelogOpen(true); }}>
                <Sparkles size={14} /> What's new
              </button>
              {/* Dark mode + Help live here now (Neil: clear the top bar, esp. mobile) */}
              <button className="hud-item" onClick={onThemeToggle}>
                {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />} {theme === "dark" ? "Light mode" : "Dark mode"}
              </button>
              {/* Work OS visual theme - cobalt (default) or warm sand */}
              <div style={{ padding: '6px 12px 2px', fontSize: 10, fontWeight: 700, letterSpacing: '.06em', color: 'var(--muted)', textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 5 }}>
                <Palette size={11} /> Theme
              </div>
              {[['cobalt', 'Cobalt'], ['warm', 'Warm sand']].map(([key, label]) => (
                <button key={key} className="hud-item" onClick={() => setWkTheme(key)}>
                  <span aria-hidden="true" style={{
                    width: 13, height: 13, borderRadius: 4, flexShrink: 0,
                    background: key === 'cobalt' ? '#2b45e1' : '#f5ead0',
                    border: key === 'warm' ? '1px solid #ddd5c2' : '1px solid transparent',
                  }} />
                  {label}
                  {wkTheme === key && <Check size={13} style={{ marginLeft: 'auto', color: 'var(--ink)' }} />}
                </button>
              ))}
              {helpKey && <PageHelp pageKey={helpKey} label={helpLabel} variant="row" onActivate={() => setOpen(false)} />}

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
                  <button className="hud-item" onClick={() => { setOpen(false); setShotsOpen(true); }}
                    style={{ color: 'hsl(var(--color-purple))' }}>
                    <Camera size={14} /> Screenshots
                  </button>
                  <button className="hud-item" onClick={() => { setOpen(false); onOpenAdmin?.('timetracking'); }}
                    style={{ color: 'hsl(var(--color-purple))' }}>
                    <Clock size={14} /> Time Tracking
                  </button>
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
      {shotsOpen && <ScreenshotsAdmin onClose={() => setShotsOpen(false)} />}
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
    </>
  );
}

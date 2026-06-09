import { useState, useRef, useEffect, useMemo } from "react";
import { Menu, Moon, Sun, Search, LogOut, Settings, User, ArrowLeft, Shield, Activity, ChevronDown, LayoutDashboard } from "lucide-react";
import NotificationBell from "./NotificationBell";
import { useMsal }        from "@azure/msal-react";
import { useRole, ROLES, MODULES } from "../contexts/RoleContext";

export default function TopHeader({ title, theme, onThemeToggle, onMobileToggle, canGoBack, onBack, onNavigate, prevLabel, onOpenAdmin }) {
  const { instance, accounts } = useMsal();
  const { myRole, can, myGrantedModules } = useRole();
  const account  = accounts[0];
  const name     = account?.name ?? "User";
  const email    = account?.username ?? "";
  const initials = name.split(" ").map(n => n[0]).slice(0, 2).join("").toUpperCase();
  const roleMeta = ROLES[myRole] ?? ROLES.employee;
  const isAdmin  = can?.('administrator') ?? false;

  const [open,         setOpen]         = useState(false);
  const [searchQuery,  setSearchQuery]  = useState('');
  const [searchOpen,   setSearchOpen]   = useState(false);
  const dropRef   = useRef(null);
  const searchRef = useRef(null);

  // Restricted view IDs that need at minimum supervisor role
  const RESTRICTED_MIN_SUPERVISOR = new Set([
    'manager-dashboard','tasks','sop','it','ops','operations','development',
    'property-asset','accounting','investor-relations','hr','marketing','external-links',
  ]);

  const searchResults = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    return MODULES.filter(m => {
      if (m.id === 'admin' && !can?.('administrator')) return false;
      if (RESTRICTED_MIN_SUPERVISOR.has(m.id) && !can?.('supervisor') && !myGrantedModules?.has(m.id)) return false;
      return m.label.toLowerCase().includes(q) || m.id.toLowerCase().includes(q);
    }).slice(0, 6);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, myRole, myGrantedModules]);

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
    if (e.key === 'Enter' && searchResults.length > 0) {
      onNavigate(searchResults[0].id);
      setSearchQuery(''); setSearchOpen(false);
    }
  }
  function goTo(id) {
    onNavigate(id);
    setSearchQuery(''); setSearchOpen(false);
  }

  function handleSignOut() {
    instance.logoutRedirect({
      account,
      postLogoutRedirectUri: window.location.origin + window.location.pathname,
    });
  }

  return (
    <header className="top-header">
      <div className="header-left">
        <button className="mobile-toggle" onClick={onMobileToggle} aria-label="Toggle Sidebar">
          <Menu style={{ width: 18, height: 18 }} />
        </button>
        <div className="breadcrumb">
          {canGoBack && (
            <button className="breadcrumb-back" onClick={onBack} title={`Back to ${prevLabel}`}>
              <ArrowLeft style={{ width: 15, height: 15 }} />
            </button>
          )}
          {canGoBack && prevLabel && (
            <>
              <span className="breadcrumb-prev">{prevLabel}</span>
              <span style={{ color: "var(--muted)", opacity: 0.4, fontSize: 11, userSelect: "none" }}>/</span>
            </>
          )}
          <span className="breadcrumb-current">{title}</span>
        </div>
      </div>

      <div className="header-center">
        <div style={{ position: 'relative' }} ref={searchRef}>
          <div className="search-bar">
            <Search style={{ width: 14, height: 14, flexShrink: 0 }} />
            <input
              placeholder="Search Nexus…"
              value={searchQuery}
              onChange={e => { setSearchQuery(e.target.value); setSearchOpen(true); }}
              onFocus={() => setSearchOpen(true)}
              onKeyDown={handleSearchKey}
            />
          </div>
          {searchOpen && searchResults.length > 0 && (
            <div style={{
              position: 'absolute', top: 'calc(100% + 6px)', left: 0, right: 0,
              background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10,
              boxShadow: '0 8px 28px rgba(0,0,0,0.15)', zIndex: 500, overflow: 'hidden',
            }}>
              {searchResults.map((m, i) => (
                <button key={m.id} onClick={() => goTo(m.id)}
                  style={{
                    width: '100%', display: 'flex', alignItems: 'center', gap: 10,
                    padding: '9px 14px', background: i === 0 ? 'var(--mist)' : 'transparent',
                    border: 'none', cursor: 'pointer', fontFamily: 'Inter,sans-serif',
                    fontSize: 13, color: 'var(--ink)', textAlign: 'left',
                    borderTop: i > 0 ? '1px solid var(--line)' : 'none',
                  }}>
                  <LayoutDashboard size={13} style={{ color: 'var(--muted)', flexShrink: 0 }} />
                  <span style={{ fontWeight: 500 }}>{m.label}</span>
                </button>
              ))}
            </div>
          )}
          {searchOpen && searchQuery.trim() && searchResults.length === 0 && (
            <div style={{
              position: 'absolute', top: 'calc(100% + 6px)', left: 0, right: 0,
              background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10,
              boxShadow: '0 8px 28px rgba(0,0,0,0.15)', zIndex: 500, padding: '12px 14px',
              fontSize: 13, color: 'var(--muted)', textAlign: 'center',
            }}>
              No results for "{searchQuery}"
            </div>
          )}
        </div>
      </div>

      <div className="header-right">
        <button className="icon-btn" onClick={onThemeToggle} aria-label="Toggle Theme">
          {theme === "dark"
            ? <Sun style={{ width: 16, height: 16 }} />
            : <Moon style={{ width: 16, height: 16 }} />
          }
        </button>
        <NotificationBell onNavigate={onNavigate} />

        {/* User profile pill */}
        <div className="header-user-wrap" ref={dropRef}>
          <button className="header-user-pill" onClick={() => setOpen(o => !o)}>
            <div className="header-avatar">{initials}</div>
            <div className="header-user-info">
              <span className="header-user-name">{name.split(" ")[0]}</span>
              <span className="header-user-role">Greens Global</span>
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
              <button className="hud-item">
                <Settings size={14} /> Account Settings
              </button>

              {isAdmin && (
                <>
                  <div className="hud-divider" />
                  <div style={{ padding: '4px 12px 2px', fontSize: 10, fontWeight: 700, letterSpacing: '.06em', color: 'var(--muted)', textTransform: 'uppercase' }}>
                    Admin
                  </div>
                  <button className="hud-item" onClick={() => { setOpen(false); onOpenAdmin?.('access'); }}
                    style={{ color: 'hsl(var(--color-purple))' }}>
                    <Shield size={14} /> Access Manager
                  </button>
                  <button className="hud-item" onClick={() => { setOpen(false); onOpenAdmin?.('audit'); }}
                    style={{ color: 'hsl(var(--color-purple))' }}>
                    <Activity size={14} /> Audit Logs
                  </button>
                </>
              )}

              <div className="hud-divider" />
              <button className="hud-item hud-signout" onClick={handleSignOut}>
                <LogOut size={14} /> Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

import { useState, useRef, useEffect } from "react";
import { Menu, Moon, Sun, Search, LogOut, Settings, User, Bell } from "lucide-react";
import { useMsal } from "@azure/msal-react";

export default function TopHeader({ title, theme, onThemeToggle, onMobileToggle }) {
  const { instance, accounts } = useMsal();
  const account = accounts[0];
  const name = account?.name ?? "User";
  const email = account?.username ?? "";
  const initials = name.split(" ").map(n => n[0]).slice(0, 2).join("").toUpperCase();

  const [open, setOpen] = useState(false);
  const dropRef = useRef(null);

  useEffect(() => {
    function handleClick(e) {
      if (dropRef.current && !dropRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

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
          <span className="breadcrumb-current">{title}</span>
        </div>
      </div>

      <div className="header-center">
        <div className="search-bar">
          <Search style={{ width: 14, height: 14, flexShrink: 0 }} />
          <input placeholder="Search Nexus…" />
        </div>
      </div>

      <div className="header-right">
        <button className="icon-btn" onClick={onThemeToggle} aria-label="Toggle Theme">
          {theme === "dark"
            ? <Sun style={{ width: 16, height: 16 }} />
            : <Moon style={{ width: 16, height: 16 }} />
          }
        </button>

        {/* User profile pill */}
        <div className="header-user-wrap" ref={dropRef}>
          <button className="header-user-pill" onClick={() => setOpen(o => !o)}>
            <div className="header-avatar">{initials}</div>
            <div className="header-user-info">
              <span className="header-user-name">{name.split(" ")[0]}</span>
              <span className="header-user-role">Greens Global</span>
            </div>
          </button>

          {open && (
            <div className="header-user-dropdown">
              <div className="hud-profile">
                <div className="hud-avatar">{initials}</div>
                <div>
                  <div className="hud-name">{name}</div>
                  <div className="hud-email">{email}</div>
                </div>
              </div>
              <div className="hud-divider" />
              <button className="hud-item">
                <User size={14} /> My Profile
              </button>
              <button className="hud-item">
                <Settings size={14} /> Account Settings
              </button>
              <button className="hud-item">
                <Bell size={14} /> Notifications
              </button>
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

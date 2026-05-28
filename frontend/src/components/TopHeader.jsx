import { Menu, Sidebar as SidebarIcon, Moon, Sun, LogOut } from "lucide-react";
import { useMsal } from "@azure/msal-react";

export default function TopHeader({ title, theme, onThemeToggle, onMobileToggle }) {
  const { instance, accounts } = useMsal();
  const account = accounts[0];
  const displayName = account?.name ?? account?.username ?? "User";
  const initials = displayName
    .split(" ")
    .map(p => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

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
          <Menu style={{ width: 20, height: 20 }} />
        </button>
        <div className="breadcrumb">
          <SidebarIcon className="breadcrumb-icon" style={{ width: 20, height: 20 }} />
          <span className="breadcrumb-current">{title}</span>
        </div>
      </div>
      <div className="header-right">
        <button className="theme-toggle-btn" onClick={onThemeToggle} aria-label="Toggle Theme">
          {theme === "dark"
            ? <Sun style={{ width: 18, height: 18 }} />
            : <Moon style={{ width: 18, height: 18 }} />
          }
        </button>
        <div className="user-profile">
          <div className="user-avatar">{initials}</div>
          <span className="user-name-header">{displayName.split(" ")[0]}</span>
        </div>
        <button className="theme-toggle-btn" onClick={handleSignOut} aria-label="Sign Out" title="Sign out">
          <LogOut style={{ width: 18, height: 18 }} />
        </button>
      </div>
    </header>
  );
}

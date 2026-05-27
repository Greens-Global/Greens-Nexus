import { Menu, Sidebar as SidebarIcon, Moon, Sun } from "lucide-react";

export default function TopHeader({ title, theme, onThemeToggle, onMobileToggle }) {
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
          <div className="user-avatar">P</div>
          <span className="user-name-header">Pranshu</span>
        </div>
      </div>
    </header>
  );
}

import { useState, useEffect } from "react";
import { AuthenticatedTemplate, UnauthenticatedTemplate } from "@azure/msal-react";
import { RequisitionProvider } from "./contexts/RequisitionContext";
import { InventoryProvider } from "./contexts/InventoryContext";
import InventoryManagement from "./views/InventoryManagement";
import LoginPage from "./views/LoginPage";
import Sidebar from "./components/Sidebar";
import TopHeader from "./components/TopHeader";
import Dashboard from "./views/Dashboard";
import Tasks from "./views/Tasks";
import Purchase from "./views/Purchase";
import SOP from "./views/SOP";
import IT from "./views/IT";
import Accounting from "./views/Accounting";
import Operations from "./views/Operations";
import FacilityOperations from "./views/FacilityOperations";
import Development from "./views/Development";
import PropertyAsset from "./views/PropertyAsset";
import HR from "./views/HR";
import InvestorRelations from "./views/InvestorRelations";
import Marketing from "./views/Marketing";
import Admin from "./views/Admin";
import ExternalLinks from "./views/ExternalLinks";
import ManagerDashboard from "./views/ManagerDashboard";
import Support from "./views/Support";
import Placeholder from "./views/Placeholder";

const VIEW_LABELS = {
  "dashboard":          "Dashboard",
  "manager-dashboard":  "Manager Dashboard",
  "purchase":           "Purchase Requisition",
  "tasks":              "Tasks",
  "sop":                "Knowledge Base",
  "it":                 "IT",
  "ops":                "Construction",
  "operations":         "Operations",
  "development":        "Development",
  "property-asset":     "Asset Management",
  "accounting":         "Accounting",
  "investor-relations": "Investor Relations",
  "hr":                 "HR",
  "marketing":          "Marketing",
  "external-links":     "External Links",
  "inventory":          "Inventory Management",
  "admin":              "Administration",
  "support":            "Support",
};

export default function App() {
  const [activeView,       setActiveView]       = useState("dashboard");
  const [activeSub,        setActiveSub]        = useState(null);
  const [theme,            setTheme]            = useState(() => localStorage.getItem("gg-theme") || "light");
  const [sidebarOpen,      setSidebarOpen]      = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem("gg-sidebar-collapsed") === "true");
  const [navHistory,       setNavHistory]       = useState([]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("gg-theme", theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem("gg-sidebar-collapsed", sidebarCollapsed);
  }, [sidebarCollapsed]);

  function navigate(view, sub = null) {
    setNavHistory(prev => [...prev.slice(-19), { view: activeView, sub: activeSub }]);
    setActiveView(view);
    setActiveSub(sub ?? getDefaultSub(view));
    setSidebarOpen(false);
  }

  function goBack() {
    if (!navHistory.length) return;
    const prev = navHistory[navHistory.length - 1];
    setNavHistory(h => h.slice(0, -1));
    setActiveView(prev.view);
    setActiveSub(prev.sub);
  }

  function getDefaultSub(view) {
    const defaults = {
      sop:               "index",
      it:                "network",
      ops:               "ops-dashboard",
      operations:        "fms",
      development:       "dev-permits",
      "property-asset":  "asset-portfolio",
      hr:                "hr-ms",
      "investor-relations": "investor-dashboard",
      marketing:         "marketing-ads",
      accounting:        "transactions",
    };
    return defaults[view] ?? null;
  }

  function renderView() {
    switch (activeView) {
      case "dashboard":          return <Dashboard onNavigate={navigate} />;
      case "manager-dashboard":  return <ManagerDashboard />;
      case "tasks":              return <Tasks />;
      case "purchase":           return <Purchase />;
      case "sop":                return <SOP activeSub={activeSub} onSubChange={s => setActiveSub(s)} />;
      case "it":                 return <IT activeSub={activeSub} onSubChange={s => setActiveSub(s)} />;
      case "ops":                return <Operations activeSub={activeSub} onSubChange={s => setActiveSub(s)} />;
      case "operations":         return <FacilityOperations activeSub={activeSub} onSubChange={s => setActiveSub(s)} />;
      case "development":        return <Development activeSub={activeSub} onSubChange={s => setActiveSub(s)} />;
      case "property-asset":     return <PropertyAsset activeSub={activeSub} onSubChange={s => setActiveSub(s)} />;
      case "accounting":         return <Accounting activeSub={activeSub} onSubChange={s => setActiveSub(s)} />;
      case "investor-relations": return <InvestorRelations activeSub={activeSub} onSubChange={s => setActiveSub(s)} />;
      case "hr":                 return <HR activeSub={activeSub} onSubChange={s => setActiveSub(s)} />;
      case "marketing":          return <Marketing activeSub={activeSub} onSubChange={s => setActiveSub(s)} />;
      case "inventory":          return <InventoryManagement />;
      case "admin":              return <Admin />;
      case "external-links":     return <ExternalLinks />;
      case "support":            return <Support />;
      default:                   return <Placeholder viewName={activeView} onBack={() => navigate("dashboard")} />;
    }
  }

  return (
    <>
      <AuthenticatedTemplate>
        <RequisitionProvider>
        <InventoryProvider>
        <div className="app-container">
          <Sidebar
            activeView={activeView}
            activeSub={activeSub}
            onNavigate={navigate}
            isOpen={sidebarOpen}
            onClose={() => setSidebarOpen(false)}
            collapsed={sidebarCollapsed}
            onToggleCollapse={() => setSidebarCollapsed(c => !c)}
          />
          {!sidebarCollapsed && (
            <div className="sidebar-dismiss-overlay" onClick={() => setSidebarCollapsed(true)} />
          )}
          <main className={`main-content${sidebarCollapsed ? " main-collapsed" : ""}`}>
            <TopHeader
              title={VIEW_LABELS[activeView] || activeView}
              theme={theme}
              onThemeToggle={() => setTheme(t => t === "dark" ? "light" : "dark")}
              onMobileToggle={() => setSidebarOpen(o => !o)}
              canGoBack={navHistory.length > 0}
              onBack={goBack}
              prevLabel={navHistory.length > 0 ? (VIEW_LABELS[navHistory[navHistory.length - 1].view] || navHistory[navHistory.length - 1].view) : null}
            />
            <div className="viewport">
              {renderView()}
            </div>
          </main>
        </div>
        </InventoryProvider>
        </RequisitionProvider>
      </AuthenticatedTemplate>
      <UnauthenticatedTemplate>
        <LoginPage />
      </UnauthenticatedTemplate>
    </>
  );
}

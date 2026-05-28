import { useState, useEffect } from "react";
import { AuthenticatedTemplate, UnauthenticatedTemplate } from "@azure/msal-react";
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
  "admin":              "Administration",
  "support":            "Support",
};

export default function App() {
  const [activeView, setActiveView] = useState("dashboard");
  const [activeSub,  setActiveSub]  = useState(null);
  const [theme,      setTheme]      = useState(() => localStorage.getItem("gg-theme") || "light");
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("gg-theme", theme);
  }, [theme]);

  function navigate(view, sub = null) {
    setActiveView(view);
    setActiveSub(sub ?? getDefaultSub(view));
    setSidebarOpen(false);
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
      case "admin":              return <Admin />;
      case "external-links":     return <ExternalLinks />;
      case "support":            return <Support />;
      default:                   return <Placeholder viewName={activeView} onBack={() => navigate("dashboard")} />;
    }
  }

  return (
    <>
      <AuthenticatedTemplate>
        <div className="app-container">
          <Sidebar
            activeView={activeView}
            activeSub={activeSub}
            onNavigate={navigate}
            isOpen={sidebarOpen}
            onClose={() => setSidebarOpen(false)}
          />
          <main className="main-content">
            <TopHeader
              title={VIEW_LABELS[activeView] || activeView}
              theme={theme}
              onThemeToggle={() => setTheme(t => t === "dark" ? "light" : "dark")}
              onMobileToggle={() => setSidebarOpen(o => !o)}
            />
            <div className="viewport">
              {renderView()}
            </div>
          </main>
        </div>
      </AuthenticatedTemplate>
      <UnauthenticatedTemplate>
        <LoginPage />
      </UnauthenticatedTemplate>
    </>
  );
}

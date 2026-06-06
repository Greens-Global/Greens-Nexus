import { useState, useEffect, useRef, lazy, Suspense } from "react";
import { AuthenticatedTemplate, UnauthenticatedTemplate } from "@azure/msal-react";
import { NotificationProvider } from "./contexts/NotificationContext";
import { RoleProvider, useRole } from "./contexts/RoleContext";
import { RequisitionProvider } from "./contexts/RequisitionContext";
import { InventoryProvider } from "./contexts/InventoryContext";
import Sidebar from "./components/Sidebar";
import TopHeader from "./components/TopHeader";
import AdminPanel from "./components/AdminPanel";

// Always loaded — critical path
import LoginPage from "./views/LoginPage";
import Dashboard from "./views/Dashboard";

// Lazy-loaded — only fetched when the user navigates there
const InventoryManagement = lazy(() => import("./views/InventoryManagement"));
const Tasks               = lazy(() => import("./views/Tasks"));
const Purchase            = lazy(() => import("./views/Purchase"));
const SOP                 = lazy(() => import("./views/SOP"));
const IT                  = lazy(() => import("./views/IT"));
const Accounting          = lazy(() => import("./views/Accounting"));
const Operations          = lazy(() => import("./views/Operations"));
const FacilityOperations  = lazy(() => import("./views/FacilityOperations"));
const Development         = lazy(() => import("./views/Development"));
const PropertyAsset       = lazy(() => import("./views/PropertyAsset"));
const HR                  = lazy(() => import("./views/HR"));
const InvestorRelations   = lazy(() => import("./views/InvestorRelations"));
const Marketing           = lazy(() => import("./views/Marketing"));
const Admin               = lazy(() => import("./views/Admin"));
const ExternalLinks       = lazy(() => import("./views/ExternalLinks"));
const ManagerDashboard    = lazy(() => import("./views/ManagerDashboard"));
const Support             = lazy(() => import("./views/Support"));
const Placeholder         = lazy(() => import("./views/Placeholder"));

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
  "admin":              "Nexus Access Manager",
  "support":            "Support",
};

// Waits for role to load so the UI never flashes with wrong access level
function RoleGate({ children }) {
  const { loading } = useRole();
  if (loading) return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--paper)' }}>
      <div style={{ width: 32, height: 32, borderRadius: '50%', border: '3px solid var(--line)', borderTopColor: 'var(--ink)', animation: 'spin 0.7s linear infinite' }} />
    </div>
  );
  return children;
}

export default function App() {
  const [activeView,       setActiveView]       = useState("dashboard");
  const [activeSub,        setActiveSub]        = useState(null);
  const [theme,            setTheme]            = useState(() => localStorage.getItem("gg-theme") || "light");
  const [sidebarOpen,      setSidebarOpen]      = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem("gg-sidebar-collapsed") === "true");
  const [navHistory,       setNavHistory]       = useState([]);
  const [adminPanelOpen,   setAdminPanelOpen]   = useState(false);
  const [adminPanelTab,    setAdminPanelTab]    = useState('access');
  const sidebarRef = useRef(null);

  // Collapse sidebar when clicking outside it — lets clicks pass through to content
  useEffect(() => {
    if (sidebarCollapsed) return;
    const handleClickOutside = (e) => {
      if (sidebarRef.current && !sidebarRef.current.contains(e.target)) {
        setSidebarCollapsed(true);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [sidebarCollapsed]);

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
      case "it":
        if (activeSub === "nexus-access-manager") return <Admin />;
        return <IT activeSub={activeSub} onSubChange={s => setActiveSub(s)} />;
      case "ops":                return <Operations activeSub={activeSub} onSubChange={s => setActiveSub(s)} />;
      case "operations":         return <FacilityOperations activeSub={activeSub} onSubChange={s => setActiveSub(s)} />;
      case "development":        return <Development activeSub={activeSub} onSubChange={s => setActiveSub(s)} />;
      case "property-asset":     return <PropertyAsset activeSub={activeSub} onSubChange={s => setActiveSub(s)} />;
      case "accounting":         return <Accounting activeSub={activeSub} onSubChange={s => setActiveSub(s)} />;
      case "investor-relations": return <InvestorRelations activeSub={activeSub} onSubChange={s => setActiveSub(s)} />;
      case "hr":                 return <HR activeSub={activeSub} onSubChange={s => setActiveSub(s)} />;
      case "marketing":          return <Marketing activeSub={activeSub} onSubChange={s => setActiveSub(s)} />;
      case "inventory":          return <InventoryManagement activeSub={activeSub} onSubChange={s => setActiveSub(s)} />;
      case "admin":              return <Admin />;
      case "external-links":     return <ExternalLinks />;
      case "support":            return <Support />;
      default:                   return <Placeholder viewName={activeView} onBack={() => navigate("dashboard")} />;
    }
  }

  return (
    <>
      <AuthenticatedTemplate>
        <NotificationProvider>
        <RoleProvider>
        <RoleGate>
        <RequisitionProvider>
        <InventoryProvider>
        <div className="app-container">
          <Sidebar
            ref={sidebarRef}
            activeView={activeView}
            activeSub={activeSub}
            onNavigate={navigate}
            isOpen={sidebarOpen}
            onClose={() => setSidebarOpen(false)}
            collapsed={sidebarCollapsed}
            onToggleCollapse={() => setSidebarCollapsed(c => !c)}
          />
          <main className={`main-content${sidebarCollapsed ? " main-collapsed" : ""}`}>
            <TopHeader
              title={VIEW_LABELS[activeView] || activeView}
              theme={theme}
              onThemeToggle={() => setTheme(t => t === "dark" ? "light" : "dark")}
              onMobileToggle={() => setSidebarOpen(o => !o)}
              canGoBack={navHistory.length > 0}
              onBack={goBack}
              onNavigate={navigate}
              prevLabel={navHistory.length > 0 ? (VIEW_LABELS[navHistory[navHistory.length - 1].view] || navHistory[navHistory.length - 1].view) : null}
              onOpenAdmin={tab => { setAdminPanelTab(tab); setAdminPanelOpen(true); }}
            />
            <div className="viewport">
              <Suspense fallback={
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh' }}>
                  <div style={{ width: 28, height: 28, borderRadius: '50%', border: '3px solid var(--border-color)', borderTopColor: 'var(--text-primary)', animation: 'spin 0.7s linear infinite' }} />
                </div>
              }>
                {renderView()}
              </Suspense>
            </div>
          </main>
        </div>
        <AdminPanel
          open={adminPanelOpen}
          initialTab={adminPanelTab}
          onClose={() => setAdminPanelOpen(false)}
        />
        </InventoryProvider>
        </RequisitionProvider>
        </RoleGate>
        </RoleProvider>
        </NotificationProvider>
      </AuthenticatedTemplate>
      <UnauthenticatedTemplate>
        <LoginPage />
      </UnauthenticatedTemplate>
    </>
  );
}

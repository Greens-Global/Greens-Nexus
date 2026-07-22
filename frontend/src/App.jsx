import { useState, useEffect, useRef, lazy, Suspense } from "react";
import { AuthenticatedTemplate, UnauthenticatedTemplate } from "@azure/msal-react";
import { NotificationProvider } from "./contexts/NotificationContext";
import { RoleProvider, useRole, MODULES } from "./contexts/RoleContext";
import { RequisitionProvider } from "./contexts/RequisitionContext";
import { InventoryProvider } from "./contexts/InventoryContext";
import Sidebar from "./components/Sidebar";
import MobileNav from "./components/MobileNav";
import MobileMenu from "./components/MobileMenu";
import TopHeader from "./components/TopHeader";
import AdminPanel from "./components/AdminPanel";
import NotificationToasts from "./components/NotificationToasts";
import TimeclockWidget from "./components/TimeclockWidget";
import GlobalSearch from "./components/GlobalSearch";
import PullToRefresh from "./components/PullToRefresh";
import ViewErrorBoundary from "./components/ViewErrorBoundary";
import { onBackendHealth, startKeepWarm } from "./api";

// Always loaded — critical path
import LoginPage from "./views/LoginPage";
import PolicyGate from "./components/PolicyGate";
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
const Documents           = lazy(() => import("./views/Documents"));
const InvestorRelations   = lazy(() => import("./views/InvestorRelations"));
const Marketing           = lazy(() => import("./views/Marketing"));
const Admin               = lazy(() => import("./views/Admin"));
const ExternalLinks       = lazy(() => import("./views/ExternalLinks"));
const ManagerDashboard    = lazy(() => import("./views/ManagerDashboard"));
const Support             = lazy(() => import("./views/Support"));
const Placeholder         = lazy(() => import("./views/Placeholder"));
const PublicSign          = lazy(() => import("./views/PublicSign"));
const PublicVerify        = lazy(() => import("./views/PublicVerify"));
const TimeClock           = lazy(() => import("./views/TimeClock"));
const MyHR                = lazy(() => import("./views/MyHR"));
const Testing             = lazy(() => import("./views/Testing"));
const CredentialVault     = lazy(() => import("./views/CredentialVault"));

const VIEW_LABELS = Object.fromEntries(MODULES.map(m => [m.id, m.label]));
// Views that aren't registered MODULES (e.g. "purchase") fall back to a
// title-cased version of their id so breadcrumbs never show raw lowercase ids.
const viewLabel = (view) => VIEW_LABELS[view]
  || (view || '').split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

// Minimum role required to access each restricted view — mirrors the minRole
// values in Sidebar's NAV array. Keep both in sync when adding new views.
// Views absent from this map are accessible to everyone (dashboard, inventory, support).
const VIEW_MIN_ROLES = {
  'manager-dashboard':  'supervisor',
  // tasks / sop / external-links are baseline (all employees): own tasks, the
  // KB/LMS with assigned courses, and plain links. Admin actions inside each
  // stay role-gated server-side.
  'it':                 'supervisor',
  'ops':                'supervisor',
  'operations':         'supervisor',
  'development':        'supervisor',
  'property-asset':     'supervisor',
  'accounting':         'supervisor',
  'investor-relations': 'supervisor',
  'hr':                 'supervisor',
  'documents':          'supervisor',
  'marketing':          'supervisor',
  'admin':              'administrator',
  'testing':            'supervisor',   // dev-only module; grant-driven for testers below supervisor
  'credvault':          'supervisor',
};

// E2E mode (Playwright CI only — VITE_E2E is never set on real builds): skip the
// MSAL login gates entirely so headless tests can drive the app against a local
// NEXUS_SKIP_AUTH backend. Everything else behaves normally.
const _E2E = import.meta.env.VITE_E2E === 'true';
const AuthedGate  = _E2E ? ({ children }) => children : AuthenticatedTemplate;
const UnauthedGate = _E2E ? () => null : UnauthenticatedTemplate;

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

// Enforces access at render time — sits inside RoleProvider so it can call
// useRole(). Even if navigate() is called externally (nexus:navigate event,
// notification links, dev tools), the actual view content is never shown
// without the correct role or a group grant.
function ProtectedView({ activeView, activeSub, onSubChange, onNavigate }) {
  const { can, myGrantedModules } = useRole();
  const minRole = VIEW_MIN_ROLES[activeView];

  // Access granted if: no restriction, OR user's role meets minRole,
  // OR a Group has explicitly granted this module to the user.
  // Visibility below admin is grant-driven, not role-level (Jun 17): managers
  // reach a restricted screen only if an Access Group grants it. IT Admin /
  // Global Admin (administrator+) still reach everything to manage access.
  // Groups can never grant admin/owner screens (minRole === 'administrator').
  const hasAccess = !minRole || can('administrator') || (minRole !== 'administrator' && myGrantedModules.has(activeView));

  if (!hasAccess) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '60vh', gap: 16, textAlign: 'center', padding: '0 24px' }}>
        <div style={{ width: 52, height: 52, borderRadius: 14, background: 'hsla(var(--color-red),0.10)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="hsl(var(--color-red))" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        </div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 17, color: 'var(--ink)', marginBottom: 6 }}>Access Restricted</div>
          <div style={{ fontSize: 14, color: 'var(--muted)', maxWidth: 320, lineHeight: 1.5 }}>You don't have permission to view this page. Contact your administrator if you need access.</div>
        </div>
        <button onClick={() => onNavigate('dashboard')} style={{ marginTop: 4, padding: '9px 24px', borderRadius: 9, border: 'none', background: 'var(--ink)', color: 'var(--paper)', fontSize: 13.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'Inter, sans-serif' }}>
          Go to Dashboard
        </button>
      </div>
    );
  }

  switch (activeView) {
    case "dashboard":          return <Dashboard onNavigate={onNavigate} />;
    case "manager-dashboard":  return <ManagerDashboard />;
    case "tasks":              return <Tasks activeSub={activeSub} onSubChange={onSubChange} onNavigate={onNavigate} />;
    case "purchase":           return <Purchase activeSub={activeSub} />;
    case "sop":                return <SOP activeSub={activeSub} onSubChange={onSubChange} />;
    case "it":                 return <IT activeSub={activeSub} onSubChange={onSubChange} />;
    case "ops":                return <Operations activeSub={activeSub} onSubChange={onSubChange} />;
    case "operations":         return <FacilityOperations activeSub={activeSub} onSubChange={onSubChange} />;
    case "development":        return <Development activeSub={activeSub} onSubChange={onSubChange} />;
    case "property-asset":     return <PropertyAsset activeSub={activeSub} onSubChange={onSubChange} />;
    case "accounting":         return <Accounting activeSub={activeSub} onSubChange={onSubChange} />;
    case "investor-relations": return <InvestorRelations activeSub={activeSub} onSubChange={onSubChange} />;
    case "hr":                 return <HR activeSub={activeSub} onSubChange={onSubChange} />;
    case "documents":          return <Documents activeSub={activeSub} onSubChange={onSubChange} />;
    case "marketing":          return <Marketing activeSub={activeSub} onSubChange={onSubChange} />;
    case "inventory":          return <InventoryManagement activeSub={activeSub} onSubChange={onSubChange} onNavigate={onNavigate} />;
    case "admin":              return <Admin />;
    case "external-links":     return <ExternalLinks />;
    case "support":            return <Support />;
    case "timeclock":          return <TimeClock />;
    case "myhr":               return <MyHR />;
    case "testing":            return <Testing />;
    case "credvault":          return <CredentialVault />;
    default:                   return <Placeholder viewName={activeView} onBack={() => onNavigate("dashboard")} />;
  }
}

// URL ↔ screen sync: the address bar mirrors navigation state
// (dev.nexus…/inventory/checkouts) so links are shareable and back/forward
// work. State stays the source of truth; these just translate.
// The Item Management view keeps its internal id 'inventory' everywhere, but the
// address bar reads /itemmanagement (Neil, Jun 16). Old /inventory links still
// resolve to the same view so nothing breaks.
const PATH_TO_VIEW = { itemmanagement: 'inventory', inventory: 'inventory' };
const VIEW_TO_PATH = { inventory: 'itemmanagement' };

function parsePath() {
  const segs = window.location.pathname.split('/').filter(Boolean);
  const raw = segs[0] || 'dashboard';
  return { view: PATH_TO_VIEW[raw] || raw, sub: segs[1] || null };
}

const DEFAULT_SUBS = {
  sop:               "index",
  it:                "network",
  ops:               "ops-dashboard",
  operations:        "fms",
  development:       "dev-permits",
  "property-asset":  "asset-portfolio",
  hr:                "hr-ms",
  documents:         "documents-esign",
  "investor-relations": "investor-dashboard",
  marketing:         "marketing-ads",
  accounting:        "transactions",
};
const getDefaultSub = view => DEFAULT_SUBS[view] ?? null;

export default function App() {
  // Public e-sign page (/sign/{token}) renders OUTSIDE the MSAL gate — external
  // signers have no login; the URL token is the credential. The pathname never
  // changes within a page load, so this early return keeps hook order stable.
  if (parsePath().view === 'sign') {
    const token = window.location.pathname.split('/').filter(Boolean)[1] || '';
    return (
      <Suspense fallback={<div style={{ minHeight: '100dvh' }} />}>
        <PublicSign token={token} />
      </Suspense>
    );
  }
  // Public certificate verification (/verify/{token}) — same reasoning as
  // /sign/{token} above: outside the MSAL gate, since anyone scanning a QR
  // code off a printed/emailed document has no Nexus login.
  if (parsePath().view === 'verify') {
    const token = window.location.pathname.split('/').filter(Boolean)[1] || '';
    return (
      <Suspense fallback={<div style={{ minHeight: '100dvh' }} />}>
        <PublicVerify token={token} />
      </Suspense>
    );
  }
  const [activeView,       setActiveView]       = useState(() => parsePath().view);
  const [activeSub,        setActiveSub]        = useState(() => { const p = parsePath(); return p.sub ?? getDefaultSub(p.view); });
  const [theme,            setTheme]            = useState(() => localStorage.getItem("gg-theme") || "light");
  const [sidebarOpen,      setSidebarOpen]      = useState(false);
  const [mobileMenuOpen,   setMobileMenuOpen]   = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem("gg-sidebar-collapsed") === "true");
  const [navHistory,       setNavHistory]       = useState([]);
  // Refs mirror the live view/sub so navigate() records the REAL current screen
  // in history even when called from the once-registered nexus:navigate listener
  // (whose closure would otherwise be stale, sending every back to Dashboard).
  const activeViewRef = useRef(activeView);
  const activeSubRef  = useRef(activeSub);
  useEffect(() => { activeViewRef.current = activeView; activeSubRef.current = activeSub; }, [activeView, activeSub]);
  const [adminPanelOpen,   setAdminPanelOpen]   = useState(false);
  const [adminPanelTab,    setAdminPanelTab]    = useState('audit');
  const [backendDown,      setBackendDown]      = useState(false);
  const sidebarRef = useRef(null);

  useEffect(() => onBackendHealth(setBackendDown), []);
  // Keep the Azure backend warm through a working session so screens don't eat a
  // cold start on every open.
  useEffect(() => { startKeepWarm(); }, []);

  // Collapse sidebar when clicking outside it — lets clicks pass through to content.
  // Must listen on 'click', NOT 'mousedown': collapsing on mousedown reflows the
  // page mid-press, the target moves before mouseup, and the browser never fires
  // the click on it — users had to click everything twice while the nav was open.
  // With 'click' the target's own handler runs first (bubbles to document last),
  // then the sidebar collapses: one click does both.
  useEffect(() => {
    if (sidebarCollapsed) return;
    const handleClickOutside = (e) => {
      // Expanding re-renders the sidebar and can replace the clicked node
      // (chevron icon swap) before this handler runs — a detached target fails
      // contains() and instantly re-collapsed the nav. Ignore detached nodes.
      if (!document.documentElement.contains(e.target)) return;
      if (sidebarRef.current && !sidebarRef.current.contains(e.target)) {
        setSidebarCollapsed(true);
      }
    };
    // Defer attaching by a tick: React 18 flushes this effect synchronously on
    // discrete events, so the very click that EXPANDED the sidebar would still
    // bubble to document and immediately collapse it again.
    const arm = setTimeout(() => document.addEventListener('click', handleClickOutside), 0);
    return () => { clearTimeout(arm); document.removeEventListener('click', handleClickOutside); };
  }, [sidebarCollapsed]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("gg-theme", theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem("gg-sidebar-collapsed", sidebarCollapsed);
  }, [sidebarCollapsed]);

  function navigate(view, sub = null) {
    const nextSub = sub ?? getDefaultSub(view);
    const curView = activeViewRef.current, curSub = activeSubRef.current;
    // Don't record a history step for a no-op navigation to the same screen.
    if (view !== curView || nextSub !== curSub) {
      setNavHistory(prev => [...prev.slice(-19), { view: curView, sub: curSub }]);
    }
    setActiveView(view);
    setActiveSub(nextSub);
    setSidebarOpen(false);
  }

  useEffect(() => {
    const handler = e => navigate(e.detail.view, e.detail.sub ?? null);
    window.addEventListener('nexus:navigate', handler);
    return () => window.removeEventListener('nexus:navigate', handler);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function goBack() {
    if (!navHistory.length) return;
    const prev = navHistory[navHistory.length - 1];
    setNavHistory(h => h.slice(0, -1));
    setActiveView(prev.view);
    setActiveSub(prev.sub);
  }

  // Browser back/forward → state (flag stops the mirror-effect below from
  // pushing a duplicate history entry for the same move)
  const fromPopstate = useRef(false);
  useEffect(() => {
    const onPop = () => {
      const { view, sub } = parsePath();
      fromPopstate.current = true;
      setActiveView(view);
      setActiveSub(sub ?? getDefaultSub(view));
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // State → address bar
  useEffect(() => {
    if (fromPopstate.current) { fromPopstate.current = false; return; }
    const seg = VIEW_TO_PATH[activeView] || activeView;
    const path = activeView === 'dashboard' && !activeSub
      ? '/'
      : `/${seg}${activeSub ? `/${activeSub}` : ''}`;
    if (window.location.pathname !== path) window.history.pushState(null, '', path);
  }, [activeView, activeSub]);

  return (
    <>
      <AuthedGate>
        <PolicyGate>
        <NotificationProvider>
        <RoleProvider>
        <RoleGate>
        <RequisitionProvider>
        <InventoryProvider>
        <NotificationToasts onNavigate={navigate} />
        <TimeclockWidget />
        <GlobalSearch onNavigate={navigate} />
        <PullToRefresh />
        {backendDown && (
          <div style={{
            position: 'fixed', top: 0, left: 0, right: 0, zIndex: 9999,
            background: '#b91c1c', color: '#fff',
            padding: '7px 16px', fontSize: '13px', fontWeight: 500,
            display: 'flex', alignItems: 'center', gap: 8,
            boxShadow: '0 2px 8px rgba(0,0,0,.25)',
          }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#fca5a5', display: 'inline-block', animation: 'pulse 1.4s ease-in-out infinite' }} />
            Service is reconnecting — data may be delayed. Retrying automatically…
          </div>
        )}
        <div className="app-container" style={backendDown ? { paddingTop: 34 } : undefined}>
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
          {/* App-style mobile chrome — phones only (CSS-gated ≤900px):
              bottom tab bar + adidas-style full-screen menu */}
          <MobileNav activeView={activeView} activeSub={activeSub} onNavigate={navigate} />
          <MobileMenu open={mobileMenuOpen} onClose={() => setMobileMenuOpen(false)}
            onNavigate={navigate} activeView={activeView}
            theme={theme} onThemeToggle={() => setTheme(t => t === "dark" ? "light" : "dark")} />
          <main className={`main-content${sidebarCollapsed ? " main-collapsed" : ""}`}>
            <TopHeader
              title={viewLabel(activeView)}
              helpKey={activeSub ? `${activeView}:${activeSub}` : activeView}
              helpLabel={viewLabel(activeView)}
              theme={theme}
              onThemeToggle={() => setTheme(t => t === "dark" ? "light" : "dark")}
              onMobileToggle={() => setMobileMenuOpen(true)}
              canGoBack={navHistory.length > 0}
              onBack={goBack}
              onNavigate={navigate}
              prevLabel={navHistory.length > 0 ? viewLabel(navHistory[navHistory.length - 1].view) : null}
              onOpenAdmin={tab => { setAdminPanelTab(tab); setAdminPanelOpen(true); }}
            />
            <div className={activeView === 'tasks' ? 'viewport viewport-flush' : 'viewport'}>
              <ViewErrorBoundary resetKey={`${activeView}/${activeSub}`}>
              <Suspense fallback={
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh' }}>
                  <div style={{ width: 28, height: 28, borderRadius: '50%', border: '3px solid var(--border-color)', borderTopColor: 'var(--text-primary)', animation: 'spin 0.7s linear infinite' }} />
                </div>
              }>
                <ProtectedView
                  activeView={activeView}
                  activeSub={activeSub}
                  onSubChange={s => setActiveSub(s)}
                  onNavigate={navigate}
                />
              </Suspense>
              </ViewErrorBoundary>
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
        </PolicyGate>
      </AuthedGate>
      <UnauthedGate>
        <LoginPage />
      </UnauthedGate>
    </>
  );
}

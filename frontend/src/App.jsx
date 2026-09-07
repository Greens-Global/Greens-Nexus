import { useState, useEffect, useRef, lazy, Suspense } from "react";
import { AuthenticatedTemplate, UnauthenticatedTemplate, useMsal } from "@azure/msal-react";
import { InteractionStatus } from "@azure/msal-browser";
import { loginRequest } from "./authConfig";
import { NotificationProvider } from "./contexts/NotificationContext";
import { RoleProvider, useRole, MODULES } from "./contexts/RoleContext";
import { RequisitionProvider } from "./contexts/RequisitionContext";
import { InventoryProvider } from "./contexts/InventoryContext";
import Sidebar from "./components/Sidebar";
import MobileNav from "./components/MobileNav";
import MobileMenu from "./components/MobileMenu";
import TopHeader from "./components/TopHeader";
import { HeaderTabsProvider } from "./components/ModuleTabs";
import AdminPanel from "./components/AdminPanel";
import NotificationToasts from "./components/NotificationToasts";
import TimeclockWidget from "./components/TimeclockWidget";
import { StepUpOverlay } from "./stepup/StepUp";
import GlobalSearch from "./components/GlobalSearch";
import PullToRefresh from "./components/PullToRefresh";
import UpdateBanner from "./components/UpdateBanner";
import ViewErrorBoundary from "./components/ViewErrorBoundary";
import { onBackendHealth, isBackendDown } from "./api";
import { applyBrandAccent } from "./lib/brandAccent";
import { BFF_MODE } from "./bffAuth";

// Always loaded - critical path
import LoginPage from "./views/LoginPage";
import PolicyGate from "./components/PolicyGate";
import Dashboard from "./views/Dashboard";

// Lazy-loaded - only fetched when the user navigates there
const InventoryManagement = lazy(() => import("./views/InventoryManagement"));
const Tasks               = lazy(() => import("./views/Tasks"));
const Tickets             = lazy(() => import("./views/Tickets"));
// Tasks and Tickets share one data engine (tickets are still fetched/held in
// TasksContext - see tickets/TicketsView.jsx). Mounting the provider here,
// one call site shared by both cases below, means switching between the two
// in the sidebar swaps children under the SAME provider instance instead of
// unmounting/remounting it - no refetch of everything on every switch.
const TasksProvider = lazy(() => import("./tasks/TasksContext").then(m => ({ default: m.TasksProvider })));
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
// External Links folded into Dashboard as a tab (Sep 3) - Dashboard.jsx lazy-
// imports views/ExternalLinks itself now; no separate top-level route.
const Support             = lazy(() => import("./views/Support"));
const Placeholder         = lazy(() => import("./views/Placeholder"));
const PublicSign          = lazy(() => import("./views/PublicSign"));
const PublicVerify        = lazy(() => import("./views/PublicVerify"));
const ExternalActivate    = lazy(() => import("./views/ExternalActivate"));
const PrivacyPolicy       = lazy(() => import("./views/PrivacyPolicy"));
const TermsConditions     = lazy(() => import("./views/TermsConditions"));
// My HR and Time Clock merged into one module (Visesh, Sep 3) - TimeClock.jsx
// now owns both, as Overview/Clock/Time Sheet/Time Off tabs. Both view ids
// still resolve so old links/nav events keep working (same pattern as
// manager-dashboard/locations folding into tabs, Aug 31).
const TimeClock           = lazy(() => import("./views/TimeClock"));
const Testing             = lazy(() => import("./views/Testing"));
const CredentialVault     = lazy(() => import("./views/CredentialVault"));
const Egnyte              = lazy(() => import("./views/Egnyte"));
const EmployeeTracking    = lazy(() => import("./components/TimeTrackingAdmin"));

const VIEW_LABELS = Object.fromEntries(MODULES.map(m => [m.id, m.label]));
// Views that aren't registered MODULES (e.g. "purchase") fall back to a
// title-cased version of their id so breadcrumbs never show raw lowercase ids.
// Acronyms the title-caser would mangle ("pdf-editor" -> "Pdf Editor"). These
// views live in Sidebar's NAV but not in MODULES, so they hit the fallback.
const LABEL_OVERRIDES = { 'pdf-editor': 'PDF Tools', 'terms-conditions': 'Terms & Conditions' };
const viewLabel = (view) => VIEW_LABELS[view] || LABEL_OVERRIDES[view]
  || (view || '').split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

// Minimum role required to access each restricted view - mirrors the minRole
// values in Sidebar's NAV array. Keep both in sync when adding new views.
// Views absent from this map are accessible to everyone (dashboard, inventory, support).
const VIEW_MIN_ROLES = {
  // 'manager-dashboard' no longer has its own view id or tab at all (Sep 3,
  // Neil: a second board defeats "Dashboard is based on role" - see the
  // dashboard/CustomDashboard.jsx and widgets.jsx comments). Old links
  // redirect straight to plain Dashboard (see parsePath/navigate); the grant
  // itself lives on - it now decides which minRole-gated widgets someone can
  // add to their ONE board (CustomDashboard's canSeeWidget()).
  // 'locations' folded into Employee Tracking as a tab (Aug 31) to shrink the
  // left nav - it no longer has its own view id or gate; old links redirect
  // (see parsePath) into 'employee-tracking', so the Locations map now shares
  // that module's grant-driven access instead of being open to all supervisors.
  // sop is baseline (all employees): the KB/LMS with assigned courses. Admin
  // actions inside stay role-gated server-side.
  // 'external-links' folded into Dashboard as a tab (Sep 3) - it no longer has
  // its own view id or gate here; it was baseline (all employees) before the
  // fold and stays that way as a Dashboard tab everyone can reach.
  // tasks / tickets are grant-driven (Aug 10): visible + usable only via an
  // Access Group / job role grant, mirrored server-side by
  // require_any_module_grant("tasks", "tickets") on the task-family routers.
  'tasks':              'supervisor',
  'tickets':            'supervisor',
  'it':                 'supervisor',
  // 'ops' (Construction) is deliberately absent - see the note on its NAV entry
  // in Sidebar.jsx. Leaving it here would show workers the nav item and then an
  // "Access Restricted" panel, which is worse than hiding it outright.
  'operations':         'supervisor',
  'development':        'supervisor',
  'property-asset':     'supervisor',
  'accounting':         'supervisor',
  'investor-relations': 'supervisor',
  'hr':                 'supervisor',
  'documents':          'supervisor',
  'marketing':          'supervisor',
  'admin':              'administrator',
  // Employee Tracking (monitoring) module - IT Admin + Global Admin ONLY. The
  // Grant-driven (Aug 13): IT Admin / Global Admin always reach it; below that it
  // opens ONLY via an explicit Access-Group/job-role grant on 'employee-tracking'
  // (not a plain supervisor/manager role). Backend endpoints gate on the same
  // grant (require_tracking / require_tracking_full in timeclock.py). Keep the
  // module in RoleContext MODULES and this value non-'administrator' so grants work.
  'employee-tracking':  'supervisor',
  'testing':            'supervisor',   // dev-only module; grant-driven for testers below supervisor
  'credvault':          'supervisor',
  // Egnyte reads are open to any signed-in user server-side, but the backend
  // browses with ONE service token, so Nexus would show every folder that token
  // can see regardless of the viewer's own Egnyte permissions. Gated at
  // supervisor for that reason - see the note in src/egnyte/EgnyteApp.jsx.
  'egnyte':             'supervisor',
};

// E2E mode (Playwright CI only - VITE_E2E is never set on real builds) and the
// local dev-login bypass (VITE_DEV_SKIP_AUTH, see msalInstance.js) both skip the
// MSAL login gates entirely: AuthenticatedTemplate/UnauthenticatedTemplate gate
// on MSAL's own `inProgress` interaction state from handleRedirectPromise(),
// which the dev bypass never drives to resolved (no real redirect ever happens),
// so both templates would render nothing forever instead of picking up the
// synthetic dev account. Everything else behaves normally.
const _SKIP_MSAL_GATE = import.meta.env.VITE_E2E === 'true'
  || (import.meta.env.DEV && import.meta.env.VITE_DEV_SKIP_AUTH === 'true')
  || BFF_MODE;   // BFF: boot already gated on the session cookie
const AuthedGate  = _SKIP_MSAL_GATE ? ({ children }) => children : AuthenticatedTemplate;
const UnauthedGate = _SKIP_MSAL_GATE ? () => null : UnauthenticatedTemplate;

// The blank-screen killer for auth. AuthenticatedTemplate AND
// UnauthenticatedTemplate both render nothing while MSAL is mid-interaction
// (inProgress !== None) - startup handleRedirectPromise, a login redirect, or the
// silent-renewal-failed -> acquireTokenRedirect recovery. That window is exactly
// when a user hits a white screen. This sibling fills it with a branded loader,
// and after a few seconds surfaces plain-language recovery buttons so a
// non-technical user is never stranded and never needs to know Ctrl+Shift+R.
function AuthLoader({ stuck }) {
  const { instance } = useMsal();
  const retry = () => {
    try { sessionStorage.removeItem('nexus:reauth-at'); } catch { /* ignore */ }
    instance.loginRedirect(loginRequest).catch(() => {});
  };
  return (
    <div style={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 18, background: 'var(--paper, #f6f7f9)', fontFamily: 'Inter, sans-serif', padding: '0 24px', textAlign: 'center' }}>
      <div style={{ width: 34, height: 34, borderRadius: '50%', border: '3px solid var(--line, #e6e8eb)', borderTopColor: 'var(--ink, #111827)', animation: 'spin 0.7s linear infinite' }} />
      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--ink, #111827)' }}>Signing you in…</div>
      {stuck && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 13, marginTop: 2 }}>
          <div style={{ fontSize: 13.5, color: 'var(--muted, #6b7280)', maxWidth: 330, lineHeight: 1.5 }}>
            This is taking longer than usual. You can retry the sign-in or reload the page.
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={retry} style={{ padding: '9px 20px', borderRadius: 9, border: 'none', background: 'var(--ink, #111827)', color: 'var(--paper, #fff)', fontSize: 13.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'Inter, sans-serif' }}>
              Sign in again
            </button>
            <button onClick={() => window.location.reload()} style={{ padding: '9px 20px', borderRadius: 9, border: '1px solid var(--line, #e6e8eb)', background: 'transparent', color: 'var(--ink, #111827)', fontSize: 13.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'Inter, sans-serif' }}>
              Reload
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function AuthBusyFallback() {
  const { inProgress } = useMsal();
  const busy = inProgress !== InteractionStatus.None;
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    if (!busy) { setStuck(false); return; }
    const t = setTimeout(() => setStuck(true), 8000);
    return () => clearTimeout(t);
  }, [busy]);
  return busy ? <AuthLoader stuck={stuck} /> : null;
}

// The escape hatch for a DEAD session while the app is already rendered: api.js
// fires `nexus:auth-stuck` when even a forced token refresh + one interactive
// re-login couldn't fix persistent 401s (a browser hard-blocking Microsoft's
// background cookies). Instead of an endless spinner, show a full-screen prompt so
// the user can re-sign-in with a real click (which succeeds where the auto-redirect
// loop didn't).
function AuthStuckOverlay() {
  const { instance } = useMsal();
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const on = () => setStuck(true);
    window.addEventListener('nexus:auth-stuck', on);
    return () => window.removeEventListener('nexus:auth-stuck', on);
  }, []);
  if (!stuck) return null;
  const signIn = () => {
    try { sessionStorage.removeItem('nexus:reauth-at'); sessionStorage.removeItem('nexus:reauth-win'); } catch { /* ignore */ }
    instance.loginRedirect(loginRequest).catch(() => {});
  };
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 100000, background: 'var(--paper, #f6f7f9)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 15, fontFamily: 'Inter, sans-serif', padding: '0 24px', textAlign: 'center' }}>
      <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--ink, #111827)' }}>Your session has expired</div>
      <div style={{ fontSize: 13.5, color: 'var(--muted, #6b7280)', maxWidth: 360, lineHeight: 1.55 }}>
        We couldn't refresh your sign-in automatically - your browser may be blocking Microsoft's background cookies. Sign in again to continue.
      </div>
      <button onClick={signIn} style={{ padding: '10px 22px', borderRadius: 10, border: 'none', background: 'var(--ink, #111827)', color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'Inter, sans-serif' }}>
        Sign in again
      </button>
    </div>
  );
}

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

// Warms the Task module once the app is idle after boot: its code chunk AND its
// data (see tasks/taskStore). Tasks is the heaviest module here and the one
// people open most, and it used to open on a cold fifteen-request wait EVERY
// time - including every hop between Tasks and Tickets. Idle so it never
// competes with the screen the user actually landed on, and only for people who
// can open it at all: the module is grant-driven, so warming it for anyone else
// would just be a handful of 403s.
function TaskPrefetch() {
  const { can, myGrantedModules } = useRole();
  const mayOpenTasks = can('administrator')
    || myGrantedModules.has('tasks') || myGrantedModules.has('tickets');
  useEffect(() => {
    if (!mayOpenTasks) return undefined;
    let cancelled = false;
    const warm = () => {
      if (cancelled) return;
      import('./views/Tasks').catch(() => {});
      import('./tasks/taskStore').then(m => m.prefetchTaskData()).catch(() => {});
    };
    const idle = typeof window.requestIdleCallback === 'function';
    const id = idle ? window.requestIdleCallback(warm, { timeout: 4000 }) : setTimeout(warm, 2500);
    return () => {
      cancelled = true;
      if (idle) window.cancelIdleCallback?.(id); else clearTimeout(id);
    };
  }, [mayOpenTasks]);
  return null;
}

// Enforces access at render time - sits inside RoleProvider so it can call
// useRole(). Even if navigate() is called externally (nexus:navigate event,
// notification links, dev tools), the actual view content is never shown
// without the correct role or a group grant.
function ProtectedView({ activeView, activeSub, onSubChange, onNavigate }) {
  const { can, myGrantedModules, isExternal } = useRole();
  const minRole = VIEW_MIN_ROLES[activeView];

  // Access granted if: no restriction, OR user's role meets minRole,
  // OR a Group has explicitly granted this module to the user.
  // Visibility below admin is grant-driven, not role-level (Jun 17): managers
  // reach a restricted screen only if an Access Group grants it. IT Admin /
  // Global Admin (administrator+) still reach everything to manage access.
  // Groups can never grant admin/owner screens (minRole === 'administrator').
  // External (B2B guest) accounts: ONLY explicitly granted modules - the
  // baseline employee screens are internal-only. The backend enforces the
  // same boundary per request (auth.apply_external_policy).
  const hasAccess = isExternal
    ? myGrantedModules.has(activeView)
    : (!minRole || can('administrator') || (minRole !== 'administrator' && myGrantedModules.has(activeView)));

  // An external landing on a non-granted view (e.g. the default 'dashboard'
  // after login) is bounced to their first granted module instead of being
  // parked on the Access Restricted panel.
  const firstGranted = isExternal ? (myGrantedModules.keys().next().value ?? null) : null;
  useEffect(() => {
    if (isExternal && !hasAccess && firstGranted) onNavigate(firstGranted);
  }, [isExternal, hasAccess, firstGranted, onNavigate]);

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
    case "dashboard":          return <Dashboard onNavigate={onNavigate} activeSub={activeSub} onSubChange={onSubChange} />;
    case "tasks":              return <TasksProvider><Tasks activeSub={activeSub} onSubChange={onSubChange} onNavigate={onNavigate} /></TasksProvider>;
    case "tickets":            return <TasksProvider><Tickets /></TasksProvider>;
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
    // PDF Editor moved into Documents as a tab (Jul 2026). Keep the old
    // top-level route working: land on Documents' PDF Editor tab.
    case "pdf-editor":         return <Documents activeSub="documents-pdf" onSubChange={onSubChange} />;
    case "inventory":          return <InventoryManagement activeSub={activeSub} onSubChange={onSubChange} onNavigate={onNavigate} />;
    case "admin":              return <Admin />;
    case "support":            return <Support />;
    case "timeclock":          return <TimeClock initialTab="clock" activeSub={activeSub} onSubChange={onSubChange} />;
    case "myhr":               return <TimeClock initialTab="overview" activeSub={activeSub} onSubChange={onSubChange} />;
    case "testing":            return <Testing />;
    case "credvault":          return <CredentialVault />;
    case "egnyte":             return <Egnyte activeSub={activeSub} onSubChange={onSubChange} />;
    case "employee-tracking":  return <EmployeeTracking initialSub={activeSub} module />;
    case "privacy-policy":     return <PrivacyPolicy embedded />;
    case "terms-conditions":   return <TermsConditions embedded />;
    default:                   return <Placeholder viewName={activeView} onBack={() => onNavigate("dashboard")} />;
  }
}

// URL ↔ screen sync: the address bar mirrors navigation state
// (dev.nexus…/inventory/checkouts) so links are shareable and back/forward
// work. State stays the source of truth; these just translate.
// The Item Management view keeps its internal id 'inventory' everywhere, but the
// address bar reads /itemmanagement (Neil, Jun 16). Old /inventory links still
// resolve to the same view so nothing breaks.
// Same idea for 'ops': the module is labelled "Construction" everywhere in the
// UI (Sidebar, MODULES) but the internal view id stayed 'ops' from before the
// rename, so the address bar read /ops instead of /construction. Old /ops
// links still resolve to the same view so nothing breaks.
const PATH_TO_VIEW = { itemmanagement: 'inventory', inventory: 'inventory', construction: 'ops', ops: 'ops' };
const VIEW_TO_PATH = { inventory: 'itemmanagement', ops: 'construction' };

function parsePath() {
  const segs = window.location.pathname.split('/').filter(Boolean);
  const raw = segs[0] || 'dashboard';
  // Tickets used to be a Tasks sub-view (/tasks/tickets); it's now its own
  // top-level module. Old email links and bookmarks still resolve - the
  // ?ticket= query param that TicketsView reads on mount survives untouched
  // since only the path is remapped here.
  if (raw === 'tasks' && segs[1] === 'tickets') return { view: 'tickets', sub: null };
  // Locations folded into Employee Tracking as a tab (Aug 31) - old
  // bookmarks/links to the standalone /locations page land on that tab.
  if (raw === 'locations') return { view: 'employee-tracking', sub: 'locations' };
  // Manager Dashboard no longer has its own tab (Sep 3, see the note above on
  // VIEW_MIN_ROLES) - old bookmarks/links to the standalone /manager-dashboard
  // page just land on plain Dashboard, where any manager-tier widgets they had
  // now live alongside everything else.
  if (raw === 'manager-dashboard') return { view: 'dashboard', sub: null };
  // External Links folded into Dashboard as a tab (Sep 3) - old
  // bookmarks/links to the standalone /external-links page land on that tab.
  if (raw === 'external-links') return { view: 'dashboard', sub: 'external-links' };
  return { view: PATH_TO_VIEW[raw] || raw, sub: segs[1] || null };
}

const DEFAULT_SUBS = {
  sop:               "index",
  it:                "network",
  ops:               "construction-dashboard",
  operations:        "fms",
  development:       "dev-permits",
  "property-asset":  "asset-portfolio",
  hr:                "hr-ms",
  documents:         "documents-dashboard",
  "investor-relations": "investor-dashboard",
  marketing:         "marketing-ads",
  accounting:        "transactions",
  egnyte:            "browse",
  "employee-tracking": "coverage",
  // My Workday (TimeClock.jsx, merged My HR + Time Clock, Sep 3) - each view
  // id lands on its own natural tab so the URL is meaningful from the first
  // click, not just after switching tabs once (see TimeClock.jsx's own
  // activeSub sync for that half).
  myhr:              "overview",
  timeclock:         "clock",
};
const getDefaultSub = view => DEFAULT_SUBS[view] ?? null;

export default function App() {
  // Public e-sign page (/sign/{token}) renders OUTSIDE the MSAL gate - external
  // signers have no login; the URL token is the credential. Routing lives in this
  // thin shell so the hook-bearing app body (MainApp) always calls its hooks
  // unconditionally - the sign page mounts a different tree entirely.
  if (parsePath().view === 'sign') {
    const token = window.location.pathname.split('/').filter(Boolean)[1] || '';
    return (
      <Suspense fallback={<div style={{ minHeight: '100dvh' }} />}>
        <PublicSign token={token} />
      </Suspense>
    );
  }
  // External-user activation (/activate/{token}) - same reasoning as
  // /sign/{token}: the invited partner has no login yet; the emailed
  // single-use token is the credential (Aug 18 passwordless flow).
  if (parsePath().view === 'activate') {
    const token = window.location.pathname.split('/').filter(Boolean)[1] || '';
    return (
      <Suspense fallback={<div style={{ minHeight: '100dvh' }} />}>
        <ExternalActivate token={token} />
      </Suspense>
    );
  }
  // Public certificate verification (/verify/{token}) - same reasoning as
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
  // Dev-only login preview (/__login) - with VITE_DEV_SKIP_AUTH the MSAL gates
  // never show LoginPage, so this is the only way to see it locally. Stripped
  // from production builds by the DEV guard.
  if (import.meta.env.DEV && window.location.pathname === '/__login') {
    return <LoginPage />;
  }
  // Privacy Policy / Terms & Conditions (/privacy, /terms) - same reasoning as
  // /sign and /verify above: linked from the pre-login screen, so they must
  // render for someone who has no Nexus login yet.
  if (parsePath().view === 'privacy') {
    return (
      <Suspense fallback={<div style={{ minHeight: '100dvh' }} />}>
        <PrivacyPolicy />
      </Suspense>
    );
  }
  if (parsePath().view === 'terms') {
    return (
      <Suspense fallback={<div style={{ minHeight: '100dvh' }} />}>
        <TermsConditions />
      </Suspense>
    );
  }
  return <MainApp />;
}

function MainApp() {
  const [activeView,       setActiveView]       = useState(() => parsePath().view);
  const [activeSub,        setActiveSub]        = useState(() => { const p = parsePath(); return p.sub ?? getDefaultSub(p.view); });
  const [theme,            setTheme]            = useState(() => localStorage.getItem("gg-theme") || "light");
  const [sidebarOpen,      setSidebarOpen]      = useState(false);
  const [mobileMenuOpen,   setMobileMenuOpen]   = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem("gg-sidebar-collapsed") === "true");
  // "Keep sidebar open" preference (My Profile -> Appearance): when pinned, the
  // click-outside auto-collapse below is skipped entirely, so the sidebar stays
  // exactly as the user left it instead of snapping shut the moment they click
  // into the page content.
  const [sidebarPinned,   setSidebarPinned]   = useState(() => localStorage.getItem("gg-sidebar-pinned") === "true");
  // "Back" used to keep its own in-memory stack, separate from the real
  // browser history that the address-bar effect below already maintains via
  // pushState/popstate. The two diverged the moment anything touched real
  // browser history in between (the browser's own Back/Forward, a swipe-back
  // gesture, alt+Left) - the in-app arrow would then jump to a stale entry
  // from its own stack instead of wherever the user actually just came from.
  // Now there is exactly one source of truth: browser history itself. Each
  // pushState call stamps its entry with { depth, fromLabel } (see below), so
  // canGoBack/prevLabel always reflect the CURRENT history entry, kept in
  // sync identically whether the move came from this app's arrow or the
  // browser's own back/forward.
  const [canGoBack, setCanGoBack] = useState(false);
  const [prevLabel, setPrevLabel] = useState(null);
  const prevLocRef = useRef({ view: activeView, sub: activeSub });
  const [adminPanelOpen,   setAdminPanelOpen]   = useState(false);
  const [adminPanelTab,    setAdminPanelTab]    = useState('audit');
  const [backendDown,      setBackendDown]      = useState(false);
  // PDF Editor tells us (via PdfEditorModule → window event) whether a document
  // is open. We hide the top header only while editing a doc; the landing screen
  // keeps the bar.
  const [pdfHasDoc,        setPdfHasDoc]        = useState(false);
  useEffect(() => {
    const onDocState = (e) => setPdfHasDoc(!!(e.detail && e.detail.hasDoc));
    window.addEventListener('nexus:pdf-doc-state', onDocState);
    return () => window.removeEventListener('nexus:pdf-doc-state', onDocState);
  }, []);
  const sidebarRef = useRef(null);
  // Remount ticket for the active view. A module opened while the backend was
  // down/restarting fetches nothing and settles into a false "no data yet - add
  // one" empty state, and nothing ever refetches. Track whether the CURRENT
  // screen was mounted during an outage; when the backend recovers, bump this
  // key to remount it so it loads for real - no user troubleshooting.
  const [viewEpoch,        setViewEpoch]        = useState(0);
  const viewMountedDuringOutage = useRef(false);
  useEffect(() => { viewMountedDuringOutage.current = isBackendDown(); }, [activeView, activeSub]);

  useEffect(() => onBackendHealth((down) => {
    setBackendDown(down);
    // Only remount screens that were OPENED during the outage (they loaded
    // nothing and show a false-empty state). A screen that was healthy when the
    // outage began keeps its loaded data and any in-progress user input -
    // remounting it would throw that work away.
    if (!down && viewMountedDuringOutage.current) {
      viewMountedDuringOutage.current = false;
      setViewEpoch(e => e + 1);
    }
  }), []);
  // Collapse sidebar when clicking outside it - lets clicks pass through to content.
  // Must listen on 'click', NOT 'mousedown': collapsing on mousedown reflows the
  // page mid-press, the target moves before mouseup, and the browser never fires
  // the click on it - users had to click everything twice while the nav was open.
  // With 'click' the target's own handler runs first (bubbles to document last),
  // then the sidebar collapses: one click does both.
  useEffect(() => {
    if (sidebarCollapsed || sidebarPinned) return;
    const handleClickOutside = (e) => {
      // Expanding re-renders the sidebar and can replace the clicked node
      // (chevron icon swap) before this handler runs - a detached target fails
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
  }, [sidebarCollapsed, sidebarPinned]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("gg-theme", theme);
  }, [theme]);

  // Global Admin-configurable accent (AdminPanel -> Branding). Applied once on
  // load; LoginPage applies it independently for the pre-login screen.
  useEffect(() => { applyBrandAccent(); }, []);

  useEffect(() => {
    localStorage.setItem("gg-sidebar-collapsed", sidebarCollapsed);
  }, [sidebarCollapsed]);

  useEffect(() => {
    localStorage.setItem("gg-sidebar-pinned", sidebarPinned);
    // Pinning is "keep it open every time" - turning it on should actually
    // open the sidebar, not just stop it from auto-closing later.
    if (sidebarPinned) setSidebarCollapsed(false);
  }, [sidebarPinned]);

  function navigate(view, sub = null) {
    // Old view ids that no longer route on their own (folded into a tab of
    // another view) - remapped here, not just in parsePath, so EVERY caller
    // (nexus:navigate events, widget/notification click-throughs, header
    // search results, the Sidebar) lands correctly without each one having
    // to know the view was merged elsewhere.
    if (view === 'manager-dashboard') { view = 'dashboard'; sub = sub ?? null; }
    // 'external-links' folded into Dashboard as a tab (Sep 3) - same reasoning.
    if (view === 'external-links') { view = 'dashboard'; sub = sub ?? 'external-links'; }
    setActiveView(view);
    setActiveSub(sub ?? getDefaultSub(view));
    setSidebarOpen(false);
  }

  useEffect(() => {
    const handler = e => navigate(e.detail.view, e.detail.sub ?? null);
    window.addEventListener('nexus:navigate', handler);
    return () => window.removeEventListener('nexus:navigate', handler);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // "Back" now means literally one step back in real browser history - the
  // same single mechanism the browser's own Back button and popstate use, so
  // the two can never disagree about where "back" actually goes.
  function goBack() {
    window.history.back();
  }

  // Browser back/forward → state (flag stops the mirror-effect below from
  // pushing a duplicate history entry for the same move). Each entry's state
  // carries what a NEXT "back" from here should show ({ depth, fromLabel }),
  // stamped when the entry was created (see the push effect) - so canGoBack/
  // prevLabel read straight off the CURRENT entry and are correct however the
  // user got here (this app's arrow, the browser's own back/forward, a swipe
  // gesture, alt+Left).
  const fromPopstate = useRef(false);
  useEffect(() => {
    const onPop = (e) => {
      const { view, sub } = parsePath();
      fromPopstate.current = true;
      setActiveView(view);
      setActiveSub(sub ?? getDefaultSub(view));
      setCanGoBack((e.state?.depth || 0) > 0);
      setPrevLabel(e.state?.fromLabel || null);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // State → address bar
  useEffect(() => {
    if (fromPopstate.current) { fromPopstate.current = false; prevLocRef.current = { view: activeView, sub: activeSub }; return; }
    const seg = VIEW_TO_PATH[activeView] || activeView;
    const path = activeView === 'dashboard' && !activeSub
      ? '/'
      : `/${seg}${activeSub ? `/${activeSub}` : ''}`;
    if (window.location.pathname !== path) {
      const depth = (window.history.state?.depth || 0) + 1;
      const fromLabel = viewLabel(prevLocRef.current.view);
      window.history.pushState({ depth, fromLabel }, '', path);
      setCanGoBack(true);
      setPrevLabel(fromLabel);
    }
    prevLocRef.current = { view: activeView, sub: activeSub };
  }, [activeView, activeSub]);


  return (
    <>
      <AuthStuckOverlay />
      <AuthedGate>
        <PolicyGate>
        <NotificationProvider>
        <RoleProvider>
        <RoleGate>
        <RequisitionProvider>
        <InventoryProvider>
        <NotificationToasts onNavigate={navigate} />
        <StepUpOverlay />
        <TimeclockWidget />
        <GlobalSearch onNavigate={navigate} />
        <PullToRefresh />
        <TaskPrefetch />
        {backendDown && (
          <div style={{
            position: 'fixed', top: 0, left: 0, right: 0, zIndex: 9999,
            background: '#b91c1c', color: '#fff',
            padding: '7px 16px', fontSize: '13px', fontWeight: 500,
            display: 'flex', alignItems: 'center', gap: 8,
            boxShadow: '0 2px 8px rgba(0,0,0,.25)',
          }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#fca5a5', display: 'inline-block', animation: 'pulse 1.4s ease-in-out infinite' }} />
            Service is reconnecting - data may be delayed. Retrying automatically…
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
          {/* App-style mobile chrome - phones only (CSS-gated ≤900px):
              bottom tab bar + adidas-style full-screen menu */}
          <MobileNav activeView={activeView} activeSub={activeSub} onNavigate={navigate} />
          <MobileMenu open={mobileMenuOpen} onClose={() => setMobileMenuOpen(false)}
            onNavigate={navigate} activeView={activeView}
            theme={theme} onThemeToggle={() => setTheme(t => t === "dark" ? "light" : "dark")} />
          {/* HeaderTabsProvider: modules publish their tab strip into the header
              center via <ModuleTabs> (Work OS shell - Stella-style layout) */}
          <HeaderTabsProvider>
          <main className={`main-content${sidebarCollapsed ? " main-collapsed" : ""}`}>
            {/* PDF Editor is a full-bleed workspace with its own toolbar — hide
                the Nexus top header so it gets the whole viewport height. */}
            {!pdfHasDoc && (
            <TopHeader
              title={viewLabel(activeView)}
              activeView={activeView}
              helpKey={activeSub ? `${activeView}:${activeSub}` : activeView}
              helpLabel={viewLabel(activeView)}
              theme={theme}
              onThemeToggle={() => setTheme(t => t === "dark" ? "light" : "dark")}
              sidebarPinned={sidebarPinned}
              onSidebarPinnedChange={setSidebarPinned}
              onMobileToggle={() => setMobileMenuOpen(true)}
              canGoBack={canGoBack}
              onBack={goBack}
              onNavigate={navigate}
              prevLabel={prevLabel}
              onOpenAdmin={tab => { setAdminPanelTab(tab); setAdminPanelOpen(true); }}
            />
            )}
            {/* viewport-desk: the Work OS canvas (soft gray --wk-bg) for the
                dashboard surfaces - see the Work OS section in style.css */}
            {/* pdf-editor is flush for the same reason tasks is: it owns its
                whole canvas. It used to cancel .viewport's padding with negative
                margins, which only matched ONE of the five breakpoint paddings
                and so sat off-center at most widths. */}
            <div className={(activeView === 'tasks' || activeView === 'tickets' || activeView === 'pdf-editor' || pdfHasDoc) ? 'viewport viewport-flush'
              : activeView === 'dashboard' ? 'viewport viewport-desk'
              : 'viewport'}>
              <ViewErrorBoundary resetKey={`${activeView}/${activeSub}/${viewEpoch}`}>
              <Suspense fallback={
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh' }}>
                  <div style={{ width: 28, height: 28, borderRadius: '50%', border: '3px solid var(--border-color)', borderTopColor: 'var(--text-primary)', animation: 'spin 0.7s linear infinite' }} />
                </div>
              }>
                <ProtectedView
                  key={viewEpoch}
                  activeView={activeView}
                  activeSub={activeSub}
                  onSubChange={s => setActiveSub(s)}
                  onNavigate={navigate}
                />
              </Suspense>
              </ViewErrorBoundary>
            </div>
          </main>
          </HeaderTabsProvider>
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
      {/* Fills the gap both MSAL templates leave blank while an interaction is in
          progress - the exact window a user would otherwise see a white screen.
          Skipped under the dev/E2E bypass, which has no real MSAL interaction. */}
      {!_SKIP_MSAL_GATE && <AuthBusyFallback />}
      {/* Outside both gates on purpose: a tab running superseded code should be
          told so whether or not it is signed in. */}
      <UpdateBanner />
    </>
  );
}

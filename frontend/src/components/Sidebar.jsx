import { forwardRef, useState, useEffect } from "react";
import { useMsal } from "@azure/msal-react";
import { useRole, ROLES } from "../contexts/RoleContext";
import { api } from "../api";
import {
  LayoutDashboard, UserCheck, ShoppingCart, CheckSquare, BookOpen,
  Monitor, Wifi, Home, LayoutGrid, Shield, FileText,
  ClipboardCheck, Calculator, ArrowRightLeft, PieChart, Download,
  CreditCard, Building, Server, FileSpreadsheet, Landmark, BarChart3,
  Users, LogIn, PenTool, Files, Megaphone, Star, ExternalLink,
  Settings, ChevronLeft, ChevronRight,
  HelpCircle, Store, Calendar, MessageSquare, Package, Clock, Contact,
  FlaskConical,
  KeyRound,
  Briefcase, FileSignature, ArrowDownToLine, ArrowUpFromLine,
  HardDrive, FolderOpen, MapPin, ClipboardList,
} from "lucide-react";
import TicketToken from "./icons/TicketToken";

// Exported: MobileMenu mirrors this exact order/grouping on phones
export const NAV = [
  { view: "dashboard", code: "HOME",         label: "Dashboard",          icon: LayoutDashboard },
  { view: "timeclock", code: "CLK",         label: "Time Clock",         icon: Clock },
  { view: "myhr", code: "MHR",              label: "My HR",              icon: Contact },
  { view: "manager-dashboard", code: "MGR", label: "Manager Dashboard",  icon: UserCheck,    minRole: 'supervisor' },
  { view: "locations", code: "LOC",         label: "Locations",          icon: MapPin,       minRole: 'supervisor' },
  { divider: true },
  // Tasks + Knowledge Base are baseline: employees work their own tasks and the
  // KB is the LMS - assigned courses/SOPs must be reachable by everyone.
  // Manage/author actions inside stay role-gated (KB admin ops are level 3+).
  { view: "tasks", code: "TSK",             label: "Tasks",               icon: CheckSquare },
  { view: "tickets", code: "TKT",           label: "Tickets",             icon: TicketToken },
  { view: "sop", code: "KB", label: "Knowledge Base", icon: BookOpen },
  { divider: true },
  {
    view: "it", code: "IT", label: "IT", icon: Monitor, minRole: 'supervisor',
    sub: [
      { subview: "network",               label: "Network Dashboard",    icon: Wifi },
      { subview: "it-websites",           label: "Website Management",   icon: ExternalLink },
    ],
  },
  {
    // No minRole: the people this module exists for are construction workers,
    // the lowest-privileged users in Nexus. The filter below only ever admits
    // `administrator` or an explicit `ops` group grant, so ANY minRole here hid
    // the module from the entire field crew. Access is enforced per jobsite
    // instead - the API's _may_read/_may_log gate on the project's
    // worker_emails, so a worker who is on no project sees an empty list rather
    // than a wall. VIEW_MIN_ROLES in App.jsx must stay in step with this.
    view: "ops", code: "CON", label: "Construction", icon: null,
    svgPath: "M756-120 537-339l84-84 219 219-84 84Zm-552 0-84-84 276-276-68-68-28 28-51-51v82l-28 28-121-121 28-28h82l-50-50 142-142q20-20 43-29t47-9q24 0 47 9t43 29l-92 92 50 50-28 28 68 68 90-90q-4-11-6.5-23t-2.5-24q0-59 40.5-99.5T701-841q15 0 28.5 3t27.5 9l-99 99 72 72 99-99q7 14 9.5 27.5T841-701q0 59-40.5 99.5T701-561q-12 0-24-2t-23-7L204-120Z",
    sub: [
      { subview: "ops-dashboard", label: "Project Dashboard", icon: LayoutDashboard },
      { subview: "ops-activity",  label: "Site Activity",     icon: ClipboardList },
      { subview: "ops-cubby",     label: "Cubby Integration", icon: FileText },
    ],
  },
  {
    view: "operations", code: "OPS", label: "Operations", icon: Store, minRole: 'supervisor',
    sub: [
      { subview: "fms",        label: "FMS Integration",        icon: Server },
      { subview: "reputation", label: "Reputation Management",  icon: Star },
      { subview: "site-staff", label: "Site Staff & Scheduling",icon: Calendar },
    ],
  },
  {
    view: "development", code: "DEV", label: "Development", icon: null, minRole: 'supervisor',
    svgPath: "M42-120v-112q0-33 17-62t47-44q51-26 115-44t141-18q77 0 141 18t115 44q30 15 47 44t17 62v112H42Zm80-80h480v-32q0-11-5.5-20T582-266q-36-18-92.5-36T362-320q-71 0-127.5 18T142-266q-9 5-14.5 14t-5.5 20v32Zm240-240q-66 0-113-47t-47-113h-10q-9 0-14.5-5.5T172-620q0-9 5.5-14.5T192-640h10q0-45 22-81t58-57v38q0 9 5.5 14.5T302-720q9 0 14.5-5.5T322-740v-54q9-3 19-4.5t21-1.5q11 0 21 1.5t19 4.5v54q0 9 5.5 14.5T422-720q9 0 14.5-5.5T442-740v-38q36 21 58 57t22 81h10q9 0 14.5-5.5T552-620q0 9-5.5 14.5T532-600h-10q0 66-47 113t-113 47Zm0-80q33 0 56.5-23.5T442-600H282q0 33 23.5 56.5T362-520Zm300 160-6-30q-6-2-11.5-4.5T634-402l-28 10-20-36 22-20v-24l-22-20 20-36 28 10q4-4 10-7t12-5l6-30h40l6 30q6 2 12 5t10 7l28-10 20 36-22 20v24l22 20-20 36-28-10q-5 5-10.5 7.5T708-390l-6 30h-40Zm20-70q12 0 21-9t9-21q0-12-9-21t-21-9q-12 0-21 9t-9 21q0 12 9 21t21 9Zm72-130-8-42q-9-3-16.5-7.5T716-620l-42 14-28-48 34-30q-2-5-2-8v-16q0-3 2-8l-34-30 28-48 42 14q6-6 13.5-10.5T746-798l8-42h56l8 42q9 3 16.5 7.5T848-780l42-14 28 48-34 30q2 5 2 8v16q0 3-2 8l34 30-28 48-42-14q-6 6-13.5 10.5T818-602l-8 42h-56Zm28-90q21 0 35.5-14.5T832-700q0-21-14.5-35.5T782-750q-21 0-35.5 14.5T732-700q0 21 14.5 35.5T782-650ZM362-200Z",
    sub: [
      { subview: "dev-permits", label: "Permit Status",    icon: FileText },
      { subview: "dev-plans",   label: "Project Plans",    icon: FileText },
      { subview: "dev-details", label: "Property Details", icon: FileText },
    ],
  },
  { view: "inventory", code: "ITM", label: "Item Management", icon: Package },
  {
    view: "property-asset", code: "AST", label: "Asset Management", icon: Home, minRole: 'supervisor',
    sub: [
      { subview: "asset-portfolio",   label: "Property Portfolio",    icon: LayoutGrid },
    ],
  },
  {
    view: "accounting", code: "ACC", label: "Accounting", icon: Calculator, minRole: 'supervisor',
    sub: [
      { subview: "transactions",    label: "Transactions",       icon: ArrowRightLeft },
      { subview: "invoices",        label: "Invoices",           icon: FileText },
      { subview: "budgets",         label: "Budgets",            icon: PieChart },
      { subview: "imports",         label: "Import Hub",         icon: Download },
      { subview: "ramp",            label: "Ramp Cards",         icon: CreditCard },
      { subview: "vendors",         label: "Vendors",            icon: Store },
      { subview: "ask-accountant",  label: "Ask My Accountant",  icon: MessageSquare },
      { subview: "ama",             label: "AMA Entities",       icon: FileText },
      { subview: "mre",             label: "MRE",                icon: Building },
      { subview: "mri",             label: "MRI",                icon: Server },
      { subview: "reports",         label: "Reports",            icon: FileSpreadsheet },
    ],
  },
  {
    view: "investor-relations", code: "IR", label: "Investor Relations", icon: Landmark, minRole: 'supervisor',
    sub: [
      { subview: "investor-dashboard",     label: "Dashboard",        icon: BarChart3 },
      { subview: "investor-funds",         label: "Deals",            icon: Briefcase },
      { subview: "investor-investors",     label: "Investors",        icon: Users },
      { subview: "investor-commitments",   label: "Commitments",      icon: FileSignature },
      { subview: "investor-capital-calls", label: "Capital Calls",    icon: ArrowDownToLine },
      { subview: "investor-distributions", label: "Distributions",    icon: ArrowUpFromLine },
      { subview: "investor-reports",       label: "Capital Accounts", icon: FileSpreadsheet },
      { subview: "investor-documents",     label: "Documents",        icon: Files },
      { subview: "investor-updates",       label: "Updates",          icon: Megaphone },
    ],
  },
  {
    view: "hr", code: "PPL", label: "People", icon: Users, minRole: 'supervisor',
    sub: [
      { subview: "hr-people", label: "People",    icon: Users },
      { subview: "hr-hiring", label: "Hiring",    icon: CheckSquare },
      { subview: "hr-org",    label: "Org Chart", icon: Files },
      { subview: "hr-leave",  label: "Leave",     icon: PenTool },
    ],
  },
  {
    view: "documents", code: "DOC", label: "Documents", icon: FileText, minRole: 'supervisor',
    sub: [
      { subview: "documents-esign", label: "E-Sign", icon: PenTool },
    ],
  },
  {
    // Marketing is a self-contained module with its own in-page tab bar
    // (Ad Performance / Reputation / Insights / SEO / Business Profile / Leads).
    view: "marketing", code: "MKT", label: "Marketing", icon: Megaphone, minRole: 'supervisor',
  },
  { view: "credvault", code: "VLT", label: "Credential Vault", icon: KeyRound, minRole: 'supervisor' },
  // Egnyte stays the source of truth for files; this module browses, uploads and
  // searches it in place. Sub list is for the mobile menu - the desktop rail is
  // flat and the module renders its own tab strip.
  {
    view: "egnyte", code: "EGN", label: "Egnyte", icon: HardDrive, minRole: 'supervisor',
    sub: [
      { subview: "browse",   label: "Browse Files",       icon: FolderOpen },
      { subview: "property", label: "Property Documents", icon: Home },
    ],
  },
  { divider: true },
  { view: "support", code: "SUP",        label: "Support",        icon: HelpCircle },
  { view: "external-links", code: "EXT", label: "External Links", icon: ExternalLink },
  { view: "privacy-policy", code: "PRV", label: "Privacy Policy", icon: Shield },
  { view: "terms-conditions", code: "TRM", label: "Terms & Conditions", icon: FileSignature },
  // Dev-only: the item renders only when the backend says the QA module is
  // enabled (NEXUS_QA_MODULE env on dev; absent on prod).
  { view: "testing", code: "QA",        label: "Testing",        icon: FlaskConical, minRole: 'supervisor', qaGated: true },
];

const Sidebar = forwardRef(function Sidebar({ activeView, activeSub, onNavigate, isOpen, onClose, collapsed, onToggleCollapse }, ref) {
  const { accounts } = useMsal();
  const { myRole, can, myGrantedModules } = useRole();
  // Dev-only Testing module: ask the backend once whether it's enabled here.
  const [qaEnabled, setQaEnabled] = useState(false);
  useEffect(() => { api.qaEnabled().then(r => setQaEnabled(!!r?.enabled)).catch(() => {}); }, []);
  const account     = accounts[0];
  const displayName = account?.name ?? account?.username ?? "User";
  const initials    = displayName.split(" ").map(p => p[0]).slice(0, 2).join("").toUpperCase();
  const firstName   = displayName.split(" ")[0];
  const roleLabel   = ROLES[myRole]?.label ?? 'Employee';

  function renderIcon(item, size = 17) {
    return item.icon
      ? <item.icon style={{ width: size, height: size, flexShrink: 0 }} />
      : <svg className="material-symbol-svg" viewBox="0 -960 960 960" style={{ width: size, height: size, flexShrink: 0 }}><path d={item.svgPath} /></svg>;
  }

  function renderItem(item, i) {
    // ── Collapsed: icon-only rail ──
    if (collapsed) {
      return (
        <li
          key={item.view || i}
          className={`nav-item nav-item--icon${activeView === item.view ? " active" : ""}`}
          onClick={() => item.view && onNavigate(item.view)}
          title={item.label}
        >
          {renderIcon(item)}
        </li>
      );
    }

    // ── Expanded: one flat entry per module ──
    // No parent/child submenus (Neil): the left nav only moves you from
    // module to module. Once inside, the module renders its own horizontal
    // tab strip for sub-navigation. Clicking lands on the module's default
    // sub (App.jsx getDefaultSub). Items with a `.sub` array fall through
    // here too - the data is still used by the mobile menu.
    return (
      <li
        key={item.view}
        className={`nav-item${activeView === item.view ? " active" : ""}`}
        onClick={() => onNavigate(item.view)}
      >
        {renderIcon(item)}
        <span>{item.label}</span>
        {item.badge && <em className="nav-badge">{item.badge}</em>}
        {item.code && <span className="nav-code">{item.code}</span>}
      </li>
    );
  }

  return (
    <>
      <aside ref={ref} className={`sidebar${isOpen ? " open" : ""}${collapsed ? " collapsed" : ""}`}>

        {/* ── Collapse toggle ── */}
        <button
          className="sidebar-collapse-btn"
          onClick={onToggleCollapse}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed
            ? <ChevronRight style={{ width: 13, height: 13 }} />
            : <ChevronLeft  style={{ width: 13, height: 13 }} />
          }
        </button>

        {/* ── Header - desk mark + wordmark ── */}
        <div className="sidebar-header">
          <div className="dk-mark" aria-hidden="true">N</div>
          {!collapsed && (
            <div className="company-info">
              <span className="company-name">Nexus</span>
              <span className="brand-sub">Master portal</span>
            </div>
          )}
        </div>

        {/* ── Nav ── */}
        <nav className="sidebar-nav">
          <ul className="nav-list">
            {/* Visibility below admin is grant-driven, NOT role-level: a manager
                only sees baseline screens (no minRole) plus modules an Access
                Group grants them. IT Admin / Global Admin (administrator+) still
                see everything so they can manage access. (Jun 17) */}
            {(() => {
              // Desk rail group labels - purely presentational; one per divider
              // slot, mirroring the NAV grouping (my desk / work / modules / system).
              const KICKERS = ['My desk', 'Work', 'Modules', 'System'];
              let group = 0;
              const visible = NAV.filter(item => (!item.qaGated || qaEnabled) && (!item.minRole || can('administrator') || myGrantedModules.has(item.view)));
              const out = [];
              if (!collapsed && visible.length && !visible[0].divider) {
                out.push(<li key="k0" className="nav-kicker">{KICKERS[0]}</li>);
              }
              visible.forEach((item, i) => {
                if (item.divider) {
                  group += 1;
                  out.push(<li key={`d${i}`} className="nav-divider" />);
                  if (!collapsed && KICKERS[group]) out.push(<li key={`k${group}`} className="nav-kicker">{KICKERS[group]}</li>);
                  return;
                }
                out.push(renderItem(item, i));
              });
              return out;
            })()}
          </ul>
        </nav>

        {/* ── User footer ── */}
        <div className="sidebar-user">
          <div className="user-avatar">{initials}</div>
          {!collapsed && (
            <div className="sidebar-user-info">
              <div className="sidebar-user-name">{firstName}</div>
              <div className="sidebar-user-role">{roleLabel}</div>
            </div>
          )}
        </div>
      </aside>
      {isOpen && <div className="sidebar-overlay active" onClick={onClose} />}
    </>
  );
});

export default Sidebar;

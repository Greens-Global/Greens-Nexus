import { useState } from "react";
import { useMsal } from "@azure/msal-react";
import {
  LayoutDashboard, UserCheck, ShoppingCart, CheckSquare, BookOpen,
  GraduationCap, Monitor, Wifi, Home, LayoutGrid, Shield, FileText,
  ClipboardCheck, Calculator, ArrowRightLeft, PieChart, Download,
  CreditCard, Building, Server, FileSpreadsheet, Landmark, BarChart3,
  Users, LogIn, PenTool, Files, Megaphone, Star, ExternalLink,
  Settings, ChevronDown, ChevronUp, HelpCircle, Store, Calendar,
  MessageSquare,
} from "lucide-react";

const NAV = [
  { view: "dashboard",        label: "Dashboard",          icon: LayoutDashboard },
  { view: "manager-dashboard",label: "Manager Dashboard",  icon: UserCheck },
  { view: "purchase",         label: "Purchase Requisition",icon: ShoppingCart },
  { divider: true },
  { view: "tasks",            label: "Tasks",              icon: CheckSquare },
  {
    view: "sop", label: "Knowledge Base", icon: BookOpen,
    sub: [
      { subview: "index",  label: "SOP Index",  icon: BookOpen },
      { subview: "review", label: "Review SOP", icon: CheckSquare },
      { subview: "lms",    label: "LMS",        icon: GraduationCap },
    ],
  },
  { divider: true },
  {
    view: "it", label: "IT", icon: Monitor,
    sub: [
      { subview: "network",     label: "Network Dashboard",  icon: Wifi },
      { subview: "it-assets",   label: "Asset Management",   icon: Monitor },
      { subview: "it-websites", label: "Website Management", icon: ExternalLink },
    ],
  },
  {
    view: "ops", label: "Construction", icon: null,
    svgPath: "M756-120 537-339l84-84 219 219-84 84Zm-552 0-84-84 276-276-68-68-28 28-51-51v82l-28 28-121-121 28-28h82l-50-50 142-142q20-20 43-29t47-9q24 0 47 9t43 29l-92 92 50 50-28 28 68 68 90-90q-4-11-6.5-23t-2.5-24q0-59 40.5-99.5T701-841q15 0 28.5 3t27.5 9l-99 99 72 72 99-99q7 14 9.5 27.5T841-701q0 59-40.5 99.5T701-561q-12 0-24-2t-23-7L204-120Z",
    sub: [
      { subview: "ops-dashboard", label: "Project Dashboard", icon: LayoutDashboard },
      { subview: "ops-cubby",     label: "Cubby Integration", icon: FileText },
    ],
  },
  {
    view: "operations", label: "Operations", icon: Store, badge: "NEW",
    sub: [
      { subview: "fms",        label: "FMS Integration",        icon: Server },
      { subview: "reputation", label: "Reputation Management",  icon: Star },
      { subview: "site-staff", label: "Site Staff & Scheduling",icon: Calendar },
    ],
  },
  {
    view: "development", label: "Development", icon: null,
    svgPath: "M42-120v-112q0-33 17-62t47-44q51-26 115-44t141-18q77 0 141 18t115 44q30 15 47 44t17 62v112H42Zm80-80h480v-32q0-11-5.5-20T582-266q-36-18-92.5-36T362-320q-71 0-127.5 18T142-266q-9 5-14.5 14t-5.5 20v32Zm240-240q-66 0-113-47t-47-113h-10q-9 0-14.5-5.5T172-620q0-9 5.5-14.5T192-640h10q0-45 22-81t58-57v38q0 9 5.5 14.5T302-720q9 0 14.5-5.5T322-740v-54q9-3 19-4.5t21-1.5q11 0 21 1.5t19 4.5v54q0 9 5.5 14.5T422-720q9 0 14.5-5.5T442-740v-38q36 21 58 57t22 81h10q9 0 14.5-5.5T552-620q0 9-5.5 14.5T532-600h-10q0 66-47 113t-113 47Zm0-80q33 0 56.5-23.5T442-600H282q0 33 23.5 56.5T362-520Zm300 160-6-30q-6-2-11.5-4.5T634-402l-28 10-20-36 22-20v-24l-22-20 20-36 28 10q4-4 10-7t12-5l6-30h40l6 30q6 2 12 5t10 7l28-10 20 36-22 20v24l22 20-20 36-28-10q-5 5-10.5 7.5T708-390l-6 30h-40Zm20-70q12 0 21-9t9-21q0-12-9-21t-21-9q-12 0-21 9t-9 21q0 12 9 21t21 9Zm72-130-8-42q-9-3-16.5-7.5T716-620l-42 14-28-48 34-30q-2-5-2-8v-16q0-3 2-8l-34-30 28-48 42 14q6-6 13.5-10.5T746-798l8-42h56l8 42q9 3 16.5 7.5T848-780l42-14 28 48-34 30q2 5 2 8v16q0 3-2 8l34 30-28 48-42-14q-6 6-13.5 10.5T818-602l-8 42h-56Zm28-90q21 0 35.5-14.5T832-700q0-21-14.5-35.5T782-750q-21 0-35.5 14.5T732-700q0 21 14.5 35.5T782-650ZM362-200Z",
    sub: [
      { subview: "dev-permits", label: "Permit Status",    icon: FileText },
      { subview: "dev-plans",   label: "Project Plans",    icon: FileText },
      { subview: "dev-details", label: "Property Details", icon: FileText },
    ],
  },
  {
    view: "property-asset", label: "Asset Management", icon: Home,
    sub: [
      { subview: "asset-portfolio",   label: "Property Portfolio",    icon: LayoutGrid },
      { subview: "asset-warranties",  label: "Equipment Warranties",  icon: Shield },
      { subview: "asset-plans",       label: "As-Built Plans",        icon: FileText },
      { subview: "asset-inspections", label: "Annual Inspections",    icon: ClipboardCheck },
      { subview: "compliance",        label: "Compliance",            icon: Shield },
    ],
  },
  { divider: true },
  {
    view: "accounting", label: "Accounting", icon: Calculator,
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
    view: "investor-relations", label: "Investor Relations", icon: Landmark,
    sub: [
      { subview: "investor-dashboard", label: "Investor Dashboard", icon: BarChart3 },
      { subview: "investor-reports",   label: "Reports",            icon: FileSpreadsheet },
    ],
  },
  { divider: true },
  {
    view: "hr", label: "HR", icon: Users,
    sub: [
      { subview: "hr-ms",          label: "IT Provisioning",   icon: LogIn },
      { subview: "hr-asana",       label: "Onboarding Tasks",  icon: CheckSquare },
      { subview: "hr-disclosures", label: "Disclosures",       icon: PenTool },
      { subview: "hr-documents",   label: "Documents",         icon: Files },
    ],
  },
  { divider: true },
  {
    view: "marketing", label: "Marketing", icon: Megaphone,
    sub: [
      { subview: "marketing-ads",        label: "Google",          icon: Megaphone },
      { subview: "marketing-reputation", label: "Meta",            icon: Star },
    ],
  },
  { divider: true },
  { view: "support",        label: "Support",        icon: HelpCircle, badge: "NEW" },
  { view: "external-links", label: "External Links", icon: ExternalLink },
  { view: "admin",          label: "Administration", icon: Settings },
];

export default function Sidebar({ activeView, activeSub, onNavigate, isOpen, onClose }) {
  const [expanded, setExpanded] = useState({});
  const { accounts } = useMsal();
  const account = accounts[0];
  const displayName = account?.name ?? account?.username ?? "User";
  const initials = displayName.split(" ").map(p => p[0]).slice(0, 2).join("").toUpperCase();
  const firstName = displayName.split(" ")[0];

  function toggle(view) {
    setExpanded(prev => ({ ...prev, [view]: !prev[view] }));
  }

  function isExpanded(view) {
    return expanded[view] ?? (activeView === view);
  }

  return (
    <>
      <aside className={`sidebar${isOpen ? " open" : ""}`}>
        <div className="sidebar-header">
          <div className="logo-box">GN</div>
          <div className="company-info">
            <span className="company-name">Nexus</span>
            <span className="brand-sub">Greens Global</span>
          </div>
        </div>

        <nav className="sidebar-nav">
          <ul className="nav-list">
            {NAV.map((item, i) => {
              if (item.divider) return <li key={i} className="nav-divider" />;

              if (item.sub) {
                const open = isExpanded(item.view);
                return (
                  <li key={item.view} className={`nav-item has-submenu${activeView === item.view ? " active" : ""}`}>
                    <div
                      className="nav-item-main"
                      onClick={() => { onNavigate(item.view); if (!open) setExpanded(p => ({ ...p, [item.view]: true })); }}
                    >
                      {item.icon
                        ? <item.icon style={{ width: 17, height: 17 }} />
                        : <svg className="material-symbol-svg" viewBox="0 -960 960 960" style={{ width: 17, height: 17 }}><path d={item.svgPath} /></svg>
                      }
                      <span>{item.label}</span>
                      {item.badge && <em className="nav-badge">{item.badge}</em>}
                      <button
                        className="submenu-toggle-btn"
                        onClick={e => { e.stopPropagation(); toggle(item.view); }}
                        aria-label="Toggle Submenu"
                      >
                        {open ? <ChevronUp style={{ width: 13, height: 13 }} /> : <ChevronDown style={{ width: 13, height: 13 }} />}
                      </button>
                    </div>
                    {open && (
                      <ul className="sidebar-submenu">
                        {item.sub.map(s => (
                          <li
                            key={s.subview}
                            className={`submenu-item${activeSub === s.subview && activeView === item.view ? " active" : ""}`}
                            onClick={e => { e.stopPropagation(); onNavigate(item.view, s.subview); }}
                          >
                            <s.icon style={{ width: 13, height: 13 }} />
                            <span>{s.label}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              }

              return (
                <li
                  key={item.view}
                  className={`nav-item${activeView === item.view ? " active" : ""}`}
                  onClick={() => onNavigate(item.view)}
                >
                  <item.icon style={{ width: 17, height: 17 }} />
                  <span>{item.label}</span>
                  {item.badge && <em className="nav-badge">{item.badge}</em>}
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="sidebar-user">
          <div className="user-avatar">{initials}</div>
          <div className="sidebar-user-info">
            <div className="sidebar-user-name">{firstName}</div>
            <div className="sidebar-user-role">Administrator</div>
          </div>
        </div>
      </aside>
      {isOpen && <div className="sidebar-overlay active" onClick={onClose} />}
    </>
  );
}

import { ArrowDownToLine, ArrowUpFromLine, Briefcase, FileSignature, FileSpreadsheet, Files, LayoutDashboard, Megaphone, Users } from 'lucide-react';
import { useRole } from '../contexts/RoleContext';
import InvestorPortal from '../investor/InvestorPortal';
import ModuleTabs from '../components/ModuleTabs';
import DashboardTab from '../investor/DashboardTab';
import FundsTab from '../investor/FundsTab';
import InvestorsTab from '../investor/InvestorsTab';
import CommitmentsTab from '../investor/CommitmentsTab';
import CapitalCallsTab from '../investor/CapitalCallsTab';
import DistributionsTab from '../investor/DistributionsTab';
import CapitalAccountsTab from '../investor/CapitalAccountsTab';
import DocumentsTab from '../investor/DocumentsTab';
import UpdatesTab from '../investor/UpdatesTab';

// GP-side capital management: funds, LPs, commitments, capital calls,
// distributions, capital-account statements, documents, and updates.
// Tab keys are wired into App.jsx routing / the sidebar - do not rename.
const TABS = [
  { key: 'investor-dashboard',     label: 'Dashboard',        Icon: LayoutDashboard },
  { key: 'investor-funds',         label: 'Deals',            Icon: Briefcase },
  { key: 'investor-investors',     label: 'Investors',        Icon: Users },
  { key: 'investor-commitments',   label: 'Commitments',      Icon: FileSignature },
  { key: 'investor-capital-calls', label: 'Capital Calls',    Icon: ArrowDownToLine },
  { key: 'investor-distributions', label: 'Distributions',    Icon: ArrowUpFromLine },
  { key: 'investor-reports',       label: 'Capital Accounts', Icon: FileSpreadsheet },
  { key: 'investor-documents',     label: 'Documents',        Icon: Files },
  { key: 'investor-updates',       label: 'Updates',          Icon: Megaphone },
];

export default function InvestorRelations({ activeSub, onSubChange }) {
  // supervisor+ = GP staff → the full 9-tab admin platform. Anyone else only
  // reached this view via the "Investor" group's viewer grant (external portal
  // accounts) → the read-only, deal-scoped portal instead. The backend applies
  // the same line (see _my_visible_fund_ids in routers/investor_relations.py),
  // so this branch is presentation only - never the security boundary.
  const { can } = useRole();
  const isStaff = can('supervisor');
  const sub = activeSub || 'investor-dashboard';

  return (
    <div style={{ animation: 'fadeIn var(--transition-normal) ease-in-out' }}>
      <div className="view-header">
        <div className="view-title-group">
          <h2>Investor Relations</h2>
          <p>{isStaff
            ? 'Raise, call, distribute, and report - the GP-side capital platform'
            : 'Your investments with Greens Global - statements, documents, and updates'}</p>
        </div>
      </div>

      {!isStaff ? <InvestorPortal /> : (
        <>
          {/* Tabs - desktop renders them centered in the top header; phones
              keep the in-page strip (ModuleTabs handles both) */}
          <ModuleTabs tabs={TABS} active={sub} onChange={onSubChange} />

          {sub === 'investor-dashboard'     && <DashboardTab onOpenTab={onSubChange} />}
          {sub === 'investor-funds'         && <FundsTab />}
          {sub === 'investor-investors'     && <InvestorsTab />}
          {sub === 'investor-commitments'   && <CommitmentsTab />}
          {sub === 'investor-capital-calls' && <CapitalCallsTab />}
          {sub === 'investor-distributions' && <DistributionsTab />}
          {sub === 'investor-reports'       && <CapitalAccountsTab />}
          {sub === 'investor-documents'     && <DocumentsTab />}
          {sub === 'investor-updates'       && <UpdatesTab />}
        </>
      )}
    </div>
  );
}

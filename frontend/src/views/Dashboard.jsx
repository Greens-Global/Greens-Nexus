import { lazy, Suspense } from 'react';
import { useMsal } from '@azure/msal-react';
import { AlertTriangle, X } from 'lucide-react';
import { useNotifications } from '../contexts/NotificationContext';
import CustomDashboard from '../dashboard/CustomDashboard';
import { ViewLoading } from '../components/AsyncState';
import ModuleTabs from '../components/ModuleTabs';
import { useRole } from '../contexts/RoleContext';
import { useActionCounts, tabCount } from '../lib/useActionCounts';

// External Links is a large, fully self-contained view (its own header,
// filters, Manage modal, etc.) - lazy so its chunk only loads when that tab
// is actually opened, same as every other top-level view used to load.
const ExternalLinks = lazy(() => import('./ExternalLinks'));
// Notes (Neil, Oct 29 2026) - the scratchpad page, after Links. Its sub is
// `notes`, or `notes:<id>` for one open note (a share bell, a copied link).
const NotesPage = lazy(() => import('../notes/NotesPage'));
// Approvals (Pranshu, Oct 30 2026) - the Approvals screen moved in here as a
// tab between Links and Notes. Its sub is `approvals`, `approvals:<kind>` or
// `approvals:history`. The tab shows for Managers++ (manager tier, HR scope)
// and for anyone with something waiting - an employee with a document to
// sign still finds it; one with nothing to do is not shown an empty tab.
const ApprovalsCenter = lazy(() => import('../approvals/ApprovalsCenter'));

// The dashboard IS the customizable widget grid now. The old "Portfolio at a
// glance" overview (Occupancy trend, Facilities, Tasks overview) ran on sample
// data and was removed from the gallery on Oct 7 - the real panels live in
// dashboard/panels.jsx, the Essentials tiles in dashboard/essentials/.
//
// Manager Dashboard USED to be a second tab here, backed by a second, fully
// separate <CustomDashboard target="manager-dashboard"> board (Aug 31). Neil,
// Sep 3: that's not what "role-based" should mean - a second board just to
// hold manager widgets is the wrong shape; the dashboard should be ONE board
// where manager-tier widgets become available (not force-added) based on who
// you are. So there is no more manager tab: Team-category widgets
// (dashboard/widgets.jsx) carry `minRole` and CustomDashboard's own
// canSeeWidget() (role OR the 'manager-dashboard' Access Group grant) decides
// who can add/see each one on their own single board.
//
// External Links folded in as a second tab the same way tabs are used
// elsewhere (Pranshu, Sep 3) - baseline (all employees), no access check
// needed like manager-tier widgets.
export default function Dashboard({ activeSub, onSubChange }) {
  const { accounts } = useMsal();
  const { activeOverdueAlerts, dismissOverdueAlert } = useNotifications();
  const { can, hrScope } = useRole();
  const counts = useActionCounts();
  const fullName = accounts[0]?.name ?? 'there';
  const approvalsWaiting = tabCount(counts, 'dashboard', 'approvals');
  const approvalsSub = String(activeSub || '');
  const showApprovals = approvalsSub === 'approvals' || approvalsSub.startsWith('approvals:') || approvalsWaiting > 0 || can?.('manager') || !!hrScope;

  const tab = activeSub === 'links' ? 'links'
    : (approvalsSub === 'approvals' || approvalsSub.startsWith('approvals:')) ? 'approvals'
      : (activeSub === 'notes' || String(activeSub || '').startsWith('notes:')) ? 'notes' : 'dashboard';

  // Overdue alerts relevant to this user
  const myOverdueAlerts = activeOverdueAlerts.filter(a =>
    a.employeeName?.toLowerCase() === fullName.toLowerCase()
  );

  const tabs = [
    { key: 'dashboard', label: 'Dashboard' },
    { key: 'links', label: 'Links' },
    ...(showApprovals ? [{ key: 'approvals', label: 'Approvals', badge: approvalsWaiting }] : []),
    { key: 'notes', label: 'Notes' },
  ];

  return (
    <div className="dashboard-view">
      <ModuleTabs
        tabs={tabs}
        active={tab}
        // 'dashboard' clears activeSub (not a literal 'dashboard' string) so
        // the address bar returns to the clean "/" home path instead of
        // picking up a redundant "/dashboard/dashboard".
        onChange={key => onSubChange?.(key === 'dashboard' ? null : key)}
      />

      {/* ── Persistent overdue alerts (personal tab only) ── */}
      {tab === 'dashboard' && myOverdueAlerts.map(alert => (
        <div key={alert.id} style={{
          display: 'flex', alignItems: 'center', gap: 12,
          background: 'hsla(var(--color-red),0.1)', border: '1px solid hsla(var(--color-red),0.3)',
          borderRadius: 10, padding: '11px 16px', marginBottom: 14,
          animation: 'fadeIn 0.2s ease',
        }}>
          <AlertTriangle size={16} style={{ color: 'hsl(var(--color-red))', flexShrink: 0 }} />
          <div style={{ flex: 1, fontSize: 13, color: 'hsl(var(--color-red))' }}>
            <strong>Overdue item:</strong> <strong>{alert.itemName}</strong> was due for return and has not been returned yet. Please return it as soon as possible.
          </div>
          <button onClick={() => dismissOverdueAlert(alert.id)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'hsl(var(--color-red))', padding: 4, borderRadius: 5, display: 'flex', alignItems: 'center' }}
            title="Dismiss (acknowledge)">
            <X size={14} />
          </button>
        </div>
      ))}

      {tab === 'links' ? (
        <Suspense fallback={<ViewLoading minHeight="40vh" />}>
          <ExternalLinks />
        </Suspense>
      ) : tab === 'approvals' ? (
        <Suspense fallback={<ViewLoading minHeight="40vh" />}>
          <ApprovalsCenter activeSub={approvalsSub.startsWith('approvals:') ? approvalsSub.slice('approvals:'.length) : ''}
            onSubChange={(s) => onSubChange?.(s ? `approvals:${s}` : 'approvals')} />
        </Suspense>
      ) : tab === 'notes' ? (
        <Suspense fallback={<ViewLoading minHeight="40vh" />}>
          <NotesPage activeSub={activeSub} onSubChange={onSubChange} />
        </Suspense>
      ) : (
        <CustomDashboard />
      )}
    </div>
  );
}

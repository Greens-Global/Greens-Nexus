import { lazy, Suspense } from 'react';
import { useMsal } from '@azure/msal-react';
import { AlertTriangle, X } from 'lucide-react';
import { useNotifications } from '../contexts/NotificationContext';
import CustomDashboard from '../dashboard/CustomDashboard';
import ModuleTabs from '../components/ModuleTabs';

// External Links is a large, fully self-contained view (its own header,
// filters, Manage modal, etc.) - lazy so its chunk only loads when that tab
// is actually opened, same as every other top-level view used to load.
const ExternalLinks = lazy(() => import('./ExternalLinks'));

// The dashboard IS the customizable widget grid now. The old "Portfolio at a
// glance" overview lives on as widgets: Occupancy trend, Facilities and Tasks
// overview are in the Add-widget gallery (Portfolio section) - see
// dashboard/panels.jsx.
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
  const fullName = accounts[0]?.name ?? 'there';

  const tab = activeSub === 'external-links' ? 'external-links' : 'dashboard';

  // Overdue alerts relevant to this user
  const myOverdueAlerts = activeOverdueAlerts.filter(a =>
    a.employeeName?.toLowerCase() === fullName.toLowerCase()
  );

  const tabs = [
    { key: 'dashboard', label: 'Dashboard' },
    { key: 'external-links', label: 'External Links' },
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

      {tab === 'external-links' ? (
        <Suspense fallback={null}>
          <ExternalLinks />
        </Suspense>
      ) : (
        <CustomDashboard />
      )}
    </div>
  );
}

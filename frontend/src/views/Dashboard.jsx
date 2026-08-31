import { useMsal } from '@azure/msal-react';
import { AlertTriangle, X } from 'lucide-react';
import { useNotifications } from '../contexts/NotificationContext';
import { useRole } from '../contexts/RoleContext';
import CustomDashboard from '../dashboard/CustomDashboard';
import ModuleTabs from '../components/ModuleTabs';

// The dashboard IS the customizable widget grid now. The old "Portfolio at a
// glance" overview lives on as widgets: Occupancy trend, Facilities and Tasks
// overview are in the Add-widget gallery (Portfolio section) - see
// dashboard/panels.jsx.
//
// Manager Dashboard folded in as a second tab (Aug 31, per Pranshu) - it used
// to be its own top-level nav item; now it's `<CustomDashboard target=
// "manager-dashboard">` rendered here instead of by the old views/
// ManagerDashboard.jsx (deleted). Same access rule as before, just enforced
// here instead of by a Sidebar minRole: supervisor+ by role, OR an Access
// Group/job role grant on the 'manager-dashboard' module - see the "Manager
// Dashboard" scope dropdown on the Dashboard row in Roles & Access.
export default function Dashboard({ activeSub, onSubChange }) {
  const { accounts } = useMsal();
  const { can, myGrantedModules } = useRole();
  const { activeOverdueAlerts, dismissOverdueAlert } = useNotifications();
  const fullName = accounts[0]?.name ?? 'there';

  const canManager = can('supervisor') || myGrantedModules.has('manager-dashboard');
  // Falls back to the personal tab for anyone who lands on ?sub=manager
  // without access (a stale link, or a grant that was since revoked).
  const tab = (activeSub === 'manager' && canManager) ? 'manager' : 'dashboard';

  // Overdue alerts relevant to this user
  const myOverdueAlerts = activeOverdueAlerts.filter(a =>
    a.employeeName?.toLowerCase() === fullName.toLowerCase()
  );

  return (
    <div className="dashboard-view">
      {canManager && (
        <ModuleTabs
          tabs={[{ key: 'dashboard', label: 'Dashboard' }, { key: 'manager', label: 'Manager Dashboard' }]}
          active={tab}
          // 'dashboard' clears activeSub (not a literal 'dashboard' string) so
          // the address bar returns to the clean "/" home path instead of
          // picking up a redundant "/dashboard/dashboard".
          onChange={key => onSubChange?.(key === 'dashboard' ? null : key)}
        />
      )}

      {/* ── Persistent overdue alerts (personal tab only - these never showed
          on the old standalone Manager Dashboard either) ── */}
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

      <CustomDashboard target={tab === 'manager' ? 'manager-dashboard' : 'dashboard'} />
    </div>
  );
}

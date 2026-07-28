import { useMsal } from '@azure/msal-react';
import { AlertTriangle, X } from 'lucide-react';
import { useNotifications } from '../contexts/NotificationContext';
import CustomDashboard from '../dashboard/CustomDashboard';

// The dashboard IS the customizable widget grid now. The old "Portfolio at a
// glance" overview lives on as widgets: Occupancy trend, Facilities and Tasks
// overview are in the Add-widget gallery (Portfolio section) - see
// dashboard/panels.jsx.
export default function Dashboard() {
  const { accounts } = useMsal();
  const { activeOverdueAlerts, dismissOverdueAlert } = useNotifications();
  const fullName = accounts[0]?.name ?? 'there';

  // Overdue alerts relevant to this user
  const myOverdueAlerts = activeOverdueAlerts.filter(a =>
    a.employeeName?.toLowerCase() === fullName.toLowerCase()
  );

  return (
    <div className="dashboard-view">
      {/* ── Persistent overdue alerts ── */}
      {myOverdueAlerts.map(alert => (
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

      <CustomDashboard target="dashboard" />
    </div>
  );
}

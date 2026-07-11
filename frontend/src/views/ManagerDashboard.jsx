import { useRole } from '../contexts/RoleContext';
import CustomDashboard from '../dashboard/CustomDashboard';

// The manager dashboard IS the customizable widget grid now. Everything the old
// "Team Analytics" tabs did lives on as widgets (dashboard/panels.jsx):
//   Pending Actions  → "Pending approvals" panel (real requisitions + inventory)
//   Who Has What     → "Who has what" panel (real, incl. pending allocation)
//   Team Time        → "Team time" panel (TimeAdmin, scoped server-side)
//   Workload / Projects / Team Calendar → gallery widgets (sample data)
export default function ManagerDashboard() {
  const { can } = useRole();

  if (!can('supervisor')) {
    return (
      <div className="view-header">
        <div className="view-title-group">
          <h2>Manager Dashboard</h2>
          <p>You need Supervisor access or above to view this section.</p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ animation: 'fadeIn var(--transition-normal) ease-in-out' }}>
      <CustomDashboard target="manager-dashboard" />
    </div>
  );
}
